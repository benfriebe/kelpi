import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readForwardingRecord, writeForwardingRecord } from './tailnet-forwarding.js';

import {
    defaultTailscaleRunner,
    describeTailscaleSearch,
    explainTailscaleProbe,
    firstLink,
    parseServeProxyPorts,
    parseTailscaleStatus,
    resolveTailnetURL,
    tailnetClientURL,
    tailscaleBinaryCandidates,
    tailscaleProbeDiagnostics,
    type TailscaleRunner
} from './tailnet.js';

const STATUS_RUNNING = JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'werk.taila5f942.ts.net.' },
    CurrentTailnet: { MagicDNSEnabled: true }
});

/** A real-shaped ServeConfig: one https:443 handler proxying to a local port. */
function serveConfig(port: number): string {
    return JSON.stringify({
        TCP: { '443': { HTTPS: true } },
        Web: {
            'werk.taila5f942.ts.net:443': {
                Handlers: { '/': { Proxy: `http://127.0.0.1:${String(port)}` } }
            }
        }
    });
}

/** Scripted runner: answers by subcommand, records every invocation. */
function scripted(answers: {
    status?: { code: number; stdout: string; stderr?: string };
    serveStatus?: { code: number; stdout: string; stderr?: string };
    serveBg?: { code: number; stdout?: string; stderr?: string };
}): { run: TailscaleRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: TailscaleRunner = (args) => {
        calls.push([...args]);
        const key = args.join(' ');
        if (key === 'status --json') {
            const a = answers.status ?? { code: 0, stdout: STATUS_RUNNING };
            return Promise.resolve({ code: a.code, stdout: a.stdout, stderr: a.stderr ?? '' });
        }
        if (key === 'serve status --json') {
            const a = answers.serveStatus ?? { code: 0, stdout: '{}' };
            return Promise.resolve({ code: a.code, stdout: a.stdout, stderr: a.stderr ?? '' });
        }
        if (args[0] === 'serve' && args[1] === '--bg') {
            const a = answers.serveBg ?? { code: 0 };
            return Promise.resolve({ code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' });
        }
        return Promise.resolve({ code: 1, stdout: '', stderr: `unexpected: ${key}` });
    };
    return { run, calls };
}

describe('parseTailscaleStatus', () => {
    it('reads the backend state and strips the DNS name’s trailing dot', () => {
        expect(parseTailscaleStatus(STATUS_RUNNING)).toEqual({
            backend: 'Running',
            dnsName: 'werk.taila5f942.ts.net'
        });
    });

    it('reads a machine with no MagicDNS name as undefined', () => {
        expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: {} }))).toEqual({
            backend: 'Running',
            dnsName: undefined
        });
        expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: '.' } })).dnsName).toBe(
            undefined
        );
    });

    it('reads garbage as unknown rather than throwing', () => {
        expect(parseTailscaleStatus('not json')).toEqual({ backend: undefined, dnsName: undefined });
        expect(parseTailscaleStatus('42')).toEqual({ backend: undefined, dnsName: undefined });
    });
});

describe('parseServeProxyPorts', () => {
    it('finds the proxied local port wherever it sits in the config', () => {
        expect(parseServeProxyPorts(serveConfig(61154))).toEqual([61154]);
    });

    it('accepts localhost and bracketed v6 loopback spellings', () => {
        const config = JSON.stringify({
            Web: {
                'a:443': { Handlers: { '/': { Proxy: 'http://localhost:8080' } } },
                'b:8443': { Handlers: { '/': { Proxy: 'http://[::1]:9090' } } }
            }
        });
        expect(parseServeProxyPorts(config)).toEqual([8080, 9090]);
    });

    it('reads an empty or unparseable config as no ports', () => {
        expect(parseServeProxyPorts('{}')).toEqual([]);
        expect(parseServeProxyPorts('No serve config')).toEqual([]);
    });

    it('ignores proxy targets that are not loopback', () => {
        const config = JSON.stringify({
            Web: { 'a:443': { Handlers: { '/': { Proxy: 'http://192.168.1.10:8080' } } } }
        });
        expect(parseServeProxyPorts(config)).toEqual([]);
    });

    it('finds loopback targets with paths and default ports for read-only diagnostics', () => {
        const config = JSON.stringify({ targets: [
            'http://127.0.0.1:3000/app?view=1', 'https+insecure://[::1]:8443/',
            'http://localhost/', 'https://127.0.0.1/'
        ] });
        expect(parseServeProxyPorts(config)).toEqual([80, 443, 3000, 8443]);
    });
});

describe('stale forwarding diagnosis', () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
    function historyFile(): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-tailnet-history-'));
        roots.push(root);
        return path.join(root, 'tailscale-serve.json');
    }

    it.each([
        ['listening', 'accepts TCP connections'],
        ['refused', 'possibly stale forwarding'],
        ['unknown', 'liveness unknown']
    ] as const)('reports %s without replacing a target of unknown ownership', async (state, message) => {
        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: serveConfig(3000) } });
        const probeTarget = vi.fn(async () => state);
        const result = await resolveTailnetURL({ port: 61154, token: 'secret', run, probeTarget });
        expect(probeTarget).toHaveBeenCalledWith('127.0.0.1', 3000);
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining(message) });
        expect(result.kind === 'error' && result.message).toContain("Kelpi's current 127.0.0.1:61154");
        expect(result.kind === 'error' && result.message).not.toContain('another service');
        expect(result.kind === 'error' && result.repair).toContain('tailscale serve --bg 61154');
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(calls).toEqual([['status', '--json'], ['serve', 'status', '--json']]);
    });

    it('preserves address families and deduplicates identical probe targets', async () => {
        const config = JSON.stringify({ Web: { 'host:443': { Handlers: {
            '/': { Proxy: 'http://[::1]:3000' }, '/one': { Proxy: 'http://localhost:3000' },
            '/two': { Proxy: 'http://[::1]:3000' }
        } } } });
        const { run } = scripted({ serveStatus: { code: 0, stdout: config } });
        const probeTarget = vi.fn(async () => 'refused' as const);
        const result = await resolveTailnetURL({ port: 61154, token: 't', run, probeTarget });
        expect(probeTarget.mock.calls).toEqual([['::1', 3000], ['localhost', 3000]]);
        expect(result.kind === 'error' && result.message).toContain('[::1]:3000');
    });

    it('a probe exception remains an inconclusive refusal, not an uncaught pairing failure', async () => {
        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: serveConfig(3000) } });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run, probeTarget: async () => { throw new Error('sandbox'); } });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('liveness unknown') });
        expect(calls).toHaveLength(2);
    });

    it('limits probing unusually large configurations and still refuses them', async () => {
        const config = JSON.stringify({ targets: Array.from({ length: 30 }, (_, i) => `127.0.0.1:${3000 + i}`) });
        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: config } });
        const probeTarget = vi.fn(async () => 'refused' as const);
        const result = await resolveTailnetURL({ port: 61154, token: 't', run, probeTarget });
        expect(probeTarget).toHaveBeenCalledTimes(16);
        expect(result.kind === 'error' && result.message).toContain('14 additional targets were not probed');
        expect(calls).toHaveLength(2);
    });

    it('records a successful configure and uses it after the current daemon port changes', async () => {
        const forwardingFile = historyFile();
        const first = scripted({});
        expect((await resolveTailnetURL({ port: 61154, token: 't', run: first.run, forwardingFile })).kind).toBe('ok');
        const history = readForwardingRecord(forwardingFile);
        expect(history).toMatchObject({ version: 1, port: 61154, dnsName: 'werk.taila5f942.ts.net' });
        const second = scripted({ serveStatus: { code: 0, stdout: serveConfig(61154) } });
        const result = await resolveTailnetURL({ port: 61200, token: 't', run: second.run, forwardingFile, probeTarget: async () => 'refused' });
        expect(result.kind === 'error' && result.message).toContain('possibly stale forwarding');
        expect(result.kind === 'error' && result.message).toContain('Kelpi last configured tailscale serve for werk.taila5f942.ts.net at 127.0.0.1:61154');
        expect(result.kind === 'error' && result.message).toContain('does not establish current ownership');
        expect(readForwardingRecord(forwardingFile)).toEqual(history);
        expect(second.calls).toHaveLength(2);
    });

    it('does not rewrite history on observed forwarding or failed configure', async () => {
        const forwardingFile = historyFile();
        const history = { version: 1 as const, dnsName: 'old.tail.ts.net', port: 50000, configuredAt: '2026-09-19T12:00:00.000Z' };
        writeForwardingRecord(forwardingFile, history);
        const observed = scripted({ serveStatus: { code: 0, stdout: serveConfig(61154) } });
        await resolveTailnetURL({ port: 61154, token: 't', run: observed.run, forwardingFile });
        expect(readForwardingRecord(forwardingFile)).toEqual(history);
        const failed = scripted({ serveBg: { code: 1, stderr: 'denied' } });
        await resolveTailnetURL({ port: 61154, token: 't', run: failed.run, forwardingFile });
        expect(readForwardingRecord(forwardingFile)).toEqual(history);
    });

    it('keeps a successfully configured pairing usable if the diagnostic history cannot be saved', async () => {
        const forwardingFile = historyFile();
        fs.mkdirSync(forwardingFile);
        const { run } = scripted({});
        const result = await resolveTailnetURL({ port: 61154, token: 't', run, forwardingFile });
        expect(result.kind).toBe('ok');
        expect(result.kind === 'ok' && result.notes.join(' ')).toContain('Could not record');
        expect(fs.readdirSync(path.dirname(forwardingFile))).toEqual(['tailscale-serve.json']);
    });
});

describe('tailnetClientURL', () => {
    it('is https on the bare MagicDNS host with the token encoded', () => {
        expect(tailnetClientURL('werk.taila5f942.ts.net', 'a+b/c')).toBe(
            'https://werk.taila5f942.ts.net/?token=a%2Bb%2Fc'
        );
    });
});

describe('resolveTailnetURL', () => {
    const rootConfig = (handler: unknown) => JSON.stringify({
        TCP: { '443': { HTTPS: true } },
        Web: { 'werk.taila5f942.ts.net:443': { Handlers: { '/': handler } } }
    });

    it.each([
        ['trailing-slash proxy', rootConfig({ Proxy: 'http://127.0.0.1:3000/' })],
        ['proxy with an upstream path', rootConfig({ Proxy: 'http://127.0.0.1:3000/app' })],
        ['static file', rootConfig({ Path: '/tmp/foreign-site' })],
        ['text handler', rootConfig({ Text: 'another service' })],
        ['redirect', rootConfig({ Redirect: 'https://example.com' })],
        ['non-loopback proxy', rootConfig({ Proxy: 'http://192.168.1.10:3000' })],
        ['malformed JSON', '{"Web":'],
        ['array', '[]'],
        ['primitive', '42'],
        ['empty output', ''],
        ['unknown shape', '{"FutureConfig":{}}']
    ])('leaves an occupied or unrecognized %s untouched', async (_name, config) => {
        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: config } });
        const result = await resolveTailnetURL({ port: 61154, token: 'secret', run, probeTarget: async () => 'refused' });
        expect(result.kind).toBe('error');
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(calls).toEqual([['status', '--json'], ['serve', 'status', '--json']]);
    });

    it.each([
        ['IPv6', rootConfig({ Proxy: 'http://[::1]:61154' })],
        ['ambiguous localhost', rootConfig({ Proxy: 'http://localhost:61154' })],
        ['TLS backend', rootConfig({ Proxy: 'https://127.0.0.1:61154' })],
        ['upstream subpath', rootConfig({ Proxy: 'http://127.0.0.1:61154/app' })],
        ['normalized dot path', rootConfig({ Proxy: 'http://127.0.0.1:61154/app/..' })],
        ['foreign root and Kelpi subpath', JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: {
            'werk.taila5f942.ts.net:443': { Handlers: {
                '/': { Proxy: 'http://127.0.0.1:3000' }, '/kelpi/': { Proxy: 'http://127.0.0.1:61154' }
            } }
        } })],
        ['Kelpi root and foreign websocket path', JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: {
            'werk.taila5f942.ts.net:443': { Handlers: {
                '/': { Proxy: 'http://127.0.0.1:61154' }, '/ws': { Proxy: 'http://127.0.0.1:3000' }
            } }
        } })],
        ['wrong DNS host', rootConfig({ Proxy: 'http://127.0.0.1:61154' }).replace('werk.taila5f942.ts.net', 'other.tail.ts.net')],
        ['HTTP listener', rootConfig({ Proxy: 'http://127.0.0.1:61154' }).replace('"HTTPS":true', '"HTTP":true')],
        ['missing TCP listener', JSON.stringify({ Web: {
            'werk.taila5f942.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:61154' } } }
        } })],
        ['raw TCP forward', JSON.stringify({ TCP: { '443': { TCPForward: '127.0.0.1:61154' } } })],
        ['unplaced target', JSON.stringify({ target: 'http://127.0.0.1:61154' })],
        ['invalid listener port', rootConfig({ Proxy: 'http://127.0.0.1:61154' }).replaceAll('443', '0')],
        ['oversized listener port', rootConfig({ Proxy: 'http://127.0.0.1:61154' }).replaceAll('443', '65536')],
        ['public Funnel route', JSON.stringify({ ...JSON.parse(serveConfig(61154)), AllowFunnel: { 'werk.taila5f942.ts.net:443': true } })],
        ['foreground indirection', JSON.stringify({ Foreground: { session: JSON.parse(serveConfig(61154)) } })],
        ['ambiguous foreground override', JSON.stringify({ ...JSON.parse(serveConfig(61154)), Foreground: { session: JSON.parse(serveConfig(3000)) } })],
        ['unknown config extension', JSON.stringify({ ...JSON.parse(serveConfig(61154)), FutureConfig: {} })],
        ['ambiguous handler', rootConfig({ Proxy: 'http://127.0.0.1:61154', Text: 'foreign' })]
    ])('does not emit a token URL for a matching port on %s', async (_name, config) => {
        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: config } });
        const result = await resolveTailnetURL({ port: 61154, token: 'secret', run, probeTarget: async () => 'listening' });
        expect(result.kind).toBe('error');
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(calls).toEqual([['status', '--json'], ['serve', 'status', '--json']]);
    });

    it.each(['{}', 'null', '{"TCP":{},"Web":{},"AllowFunnel":{},"Foreground":{},"Services":null}'])(
        'configures a positively empty configuration: %s', async (config) => {
            const { run, calls } = scripted({ serveStatus: { code: 0, stdout: config } });
            expect((await resolveTailnetURL({ port: 61154, token: 't', run })).kind).toBe('ok');
            expect(calls).toContainEqual(['serve', '--bg', '61154']);
        }
    );

    it('accepts the verified IPv4 HTTP root with a trailing slash', async () => {
        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: rootConfig({ Proxy: 'http://127.0.0.1:61154/' }) } });
        expect(await resolveTailnetURL({ port: 61154, token: 't', run })).toMatchObject({
            kind: 'ok', url: 'https://werk.taila5f942.ts.net/?token=t'
        });
        expect(calls).toHaveLength(2);
    });

    it('reuses a verified alternate listener without replacing a foreign :443 handler', async () => {
        const config = JSON.stringify({ TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } }, Web: {
            'werk.taila5f942.ts.net:443': { Handlers: { '/': { Path: '/tmp/foreign-site' } } },
            'werk.taila5f942.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:61154' } } }
        } });
        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: config } });
        expect(await resolveTailnetURL({ port: 61154, token: 't', run })).toMatchObject({
            kind: 'ok', url: 'https://werk.taila5f942.ts.net:8443/?token=t'
        });
        expect(calls).toHaveLength(2);
    });

    it('says tailscale is not installed when the binary is missing', async () => {
        const run: TailscaleRunner = () => Promise.resolve({ code: -1, stdout: '', stderr: 'ENOENT' });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('not installed') });
    });

    it('sends a logged-out machine to `tailscale up`', async () => {
        const { run } = scripted({
            status: { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }) }
        });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('NeedsLogin') });
        expect(result.kind === 'error' && result.repair).toContain('tailscale up');
        // Every refusal hands back the SAME repair as ordered steps, for a surface with room.
        expect(result).toMatchObject({ steps: [expect.stringContaining('tailscale up')] });
    });

    it('explains a missing MagicDNS name instead of printing an unusable URL', async () => {
        const { run } = scripted({
            status: { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: {} }) }
        });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('MagicDNS') });
    });

    it('prints the URL without touching serve when the port is already fronted', async () => {
        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: serveConfig(61154) } });
        const result = await resolveTailnetURL({ port: 61154, token: 's3cret', run });
        expect(result).toMatchObject({
            kind: 'ok',
            url: 'https://werk.taila5f942.ts.net/?token=s3cret',
            notes: [expect.stringContaining('already fronting 127.0.0.1:61154')]
        });
        expect(calls.some((args) => args[0] === 'serve' && args[1] === '--bg')).toBe(false);
    });

    it('configures serve when nothing is being served, and says so', async () => {
        const { run, calls } = scripted({});
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        expect(result).toMatchObject({ kind: 'ok', notes: [expect.stringContaining('configured')] });
        expect(calls).toContainEqual(['serve', '--bg', '61154']);
    });

    it('REFUSES port 0 before asking tailscale anything: `serve --bg 0` fronts nothing (#130)', async () => {
        const { run, calls } = scripted({});
        const result = await resolveTailnetURL({ port: 0, token: 't', run });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('no bound HTTP port') });
        expect(calls).toEqual([]);
    });

    it('REFUSES when the serve config cannot be inspected — unreadable is not absent', async () => {
        const { run, calls } = scripted({ serveStatus: { code: 1, stdout: '', stderr: 'unknown flag' } });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('cannot be inspected') });
        expect(calls.some((args) => args[0] === 'serve' && args[1] === '--bg')).toBe(false);
    });

    it('honours a non-443 listener instead of printing a URL nothing serves', async () => {
        const config = JSON.stringify({
            TCP: { '8443': { HTTPS: true } },
            Web: {
                'werk.taila5f942.ts.net:8443': {
                    Handlers: { '/': { Proxy: 'http://127.0.0.1:61154' } }
                }
            }
        });
        const { run } = scripted({ serveStatus: { code: 0, stdout: config } });
        const result = await resolveTailnetURL({ port: 61154, token: 's', run });
        expect(result).toMatchObject({ kind: 'ok', url: 'https://werk.taila5f942.ts.net:8443/?token=s' });
    });

    it('treats an https+insecure proxy and a bare TCP forward as occupied, not absent', async () => {
        const insecure = JSON.stringify({
            Web: { 'a:443': { Handlers: { '/': { Proxy: 'https+insecure://127.0.0.1:3000' } } } }
        });
        expect(parseServeProxyPorts(insecure)).toEqual([3000]);
        const forward = JSON.stringify({ TCP: { '443': { TCPForward: '127.0.0.1:9443' } } });
        expect(parseServeProxyPorts(forward)).toEqual([9443]);

        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: insecure } });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('127.0.0.1:3000') });
        expect(calls.some((args) => args[0] === 'serve' && args[1] === '--bg')).toBe(false);
    });

    it('REFUSES to replace a serve config that fronts a different service', async () => {
        const { run, calls } = scripted({ serveStatus: { code: 0, stdout: serveConfig(3000) } });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('127.0.0.1:3000') });
        expect(result.kind === 'error' && result.repair).toContain('tailscale serve --bg 61154');
        expect(calls.some((args) => args[0] === 'serve' && args[1] === '--bg')).toBe(false);
    });

    it('surfaces a serve failure with tailscale’s own words and the HTTPS-certs hint', async () => {
        const { run } = scripted({ serveBg: { code: 1, stderr: 'error: HTTPS is not enabled' } });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('HTTPS is not enabled') });
        expect(result.kind === 'error' && result.repair).toContain('HTTPS certificates');
    });

    it('calls a tailnet without serve enabled a SETUP step, and carries tailscale’s own enable link', async () => {
        const { run } = scripted({
            serveBg: {
                code: 1,
                stderr: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=x'
            }
        });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        // Plain words, not `tailscale serve --bg 61154` failed: nothing is broken, the tailnet
        // has simply never had serve switched on.
        expect(result).toMatchObject({
            kind: 'error',
            message: expect.stringContaining('serve is not enabled for this tailnet yet'),
            steps: [
                expect.stringContaining('https://login.tailscale.com/f/serve?node=x'),
                expect.stringContaining('https://login.tailscale.com/admin/dns')
            ]
        });
        // The link is NAMED, never "the link above" - a UI shows no "above" to follow.
        const repair = result.kind === 'error' ? (result.repair ?? '') : '';
        expect(repair).toContain('https://login.tailscale.com/f/serve?node=x');
        expect(repair).not.toContain('link above');
    });

    it('keeps tailscale’s own words for any OTHER serve failure, with the link it named', async () => {
        const { run } = scripted({
            serveBg: { code: 1, stderr: 'foo: see https://login.tailscale.com/admin/machines for details' }
        });
        const result = await resolveTailnetURL({ port: 61154, token: 't', run });
        expect(result).toMatchObject({
            kind: 'error',
            message: expect.stringContaining('foo: see'),
            steps: [expect.stringContaining('https://login.tailscale.com/admin/machines'), expect.any(String)]
        });
        expect(result.kind === 'error' && result.repair).not.toContain('link above');
    });
});

describe('firstLink', () => {
    it('lifts the page tailscale names out of its own sentence, punctuation left behind', () => {
        expect(firstLink('To enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=x')).toBe(
            'https://login.tailscale.com/f/serve?node=x'
        );
        expect(firstLink('go to https://example.com/a.')).toBe('https://example.com/a');
        expect(firstLink('exit 1')).toBeUndefined();
    });
});

describe('tailscaleBinaryCandidates', () => {
    it('an explicit KELPID_TAILSCALE wins alone — a wrong config fails loudly, never falls back', () => {
        expect(tailscaleBinaryCandidates({ KELPID_TAILSCALE: '/opt/ts/tailscale' }, 'darwin')).toEqual([
            '/opt/ts/tailscale'
        ]);
        expect(tailscaleBinaryCandidates({ KELPID_TAILSCALE: '  ' }, 'linux')).toEqual(['tailscale']);
    });

    it('macOS probes PATH, then the standard install dirs, then the App Store bundle CLI', () => {
        // A Finder-launched app has neither /usr/local/bin nor /opt/homebrew/bin on PATH, so
        // without those two the search fell through to the sandboxed bundle CLI (#169).
        expect(tailscaleBinaryCandidates({}, 'darwin')).toEqual([
            'tailscale',
            '/usr/local/bin/tailscale',
            '/opt/homebrew/bin/tailscale',
            '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
        ]);
    });

    it('everywhere else PATH is the only candidate', () => {
        expect(tailscaleBinaryCandidates({}, 'linux')).toEqual(['tailscale']);
        expect(tailscaleBinaryCandidates({}, 'win32')).toEqual(['tailscale']);
    });
});

/**
 * Real executables on disk: the runner shells out, so nothing less exercises the search.
 *
 * Two environmental requirements, neither worth a runtime probe. A `/bin/sh` at that path, and a
 * TMPDIR that is not mounted `noexec` (on macOS `os.tmpdir()` is `/var/folders/...`, which is
 * exec-mountable; under a noexec mount `execFile` returns EACCES and these read as "ran and
 * failed"). Windows has neither, and the shebang and the `0o755` mode are both meaningless
 * there, so the whole block is skipped rather than left to fail obscurely.
 */
describe.skipIf(process.platform === 'win32')('defaultTailscaleRunner', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    function scratch(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-tailscale-'));
        dirs.push(dir);
        return dir;
    }

    function fakeCLI(dir: string, name: string, body: string): string {
        const file = path.join(dir, name);
        fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        return file;
    }

    /** A path in a directory that exists, with nothing at it: ENOENT, not a permissions error. */
    function absentCLI(dir: string, name = 'tailscale'): string {
        return path.join(dir, name);
    }

    /**
     * A candidate that answers with a real status document, optionally recording its argv.
     *
     * The JSON is embedded in SINGLE quotes inside the script, so it must never contain an
     * apostrophe. `STATUS_RUNNING` is the only thing that could put one there.
     */
    function answeringCLI(dir: string, name: string, log?: string): string {
        const record = log === undefined ? '' : `echo "${name} $*" >> '${log}'\n`;
        return fakeCLI(dir, name, `${record}printf '%s' '${STATUS_RUNNING}'`);
    }

    function refusingCLI(dir: string, name: string, said: string, log?: string): string {
        const record = log === undefined ? '' : `echo "${name} $*" >> '${log}'\n`;
        return fakeCLI(dir, name, `${record}echo "${said}" >&2\nexit 1`);
    }

    it('honours an overall deadline across status and the pinned serve invocation', async () => {
        const dir = scratch();
        const file = fakeCLI(dir, 'slow', `if [ "$1" = status ]; then sleep 0.2; printf '%s' '${STATUS_RUNNING}'; else exec sleep 30; fi`);
        const run = defaultTailscaleRunner([file], 5000);
        const started = Date.now();
        const deadline = started + 1000;
        expect((await run(['status', '--json'], { deadline })).code).toBe(0);
        const serve = await run(['serve', 'status', '--json'], { deadline });
        expect(serve).toMatchObject({ code: -1, binary: file, stderr: expect.stringContaining('timed out') });
        expect(Date.now() - started).toBeLessThan(2500);
        const expired = await run(['status', '--json'], { deadline: Date.now() - 1 });
        expect(expired).toMatchObject({ code: -1, stderr: 'Tailscale probe deadline exceeded', attempts: [] });
    }, 10_000);

    it('walks past a candidate that RAN and failed, keeping what it said (#169)', async () => {
        const dir = scratch();
        const absent = absentCLI(dir);
        const sandboxed = refusingCLI(dir, 'sandboxed', 'failed to connect to local tailscaled');
        const working = answeringCLI(dir, 'working');

        const result = await defaultTailscaleRunner([absent, sandboxed, working])(['status', '--json']);

        // The old rule advanced only on ENOENT, so `sandboxed` ended the search and a healthy
        // tailnet read as "state: unknown".
        expect(result.code).toBe(0);
        expect(result.binary).toBe(working);
        expect(parseTailscaleStatus(result.stdout)).toEqual({
            backend: 'Running',
            dnsName: 'werk.taila5f942.ts.net'
        });
        const search = tailscaleProbeDiagnostics(result);
        expect(search).toEqual({
            tried: [absent, sandboxed, working],
            used: working,
            failure: `${sandboxed} exited 1: failed to connect to local tailscaled`
        });
        // One fact, not two: the binary that answered and the one that complained can be
        // talking to different backends, and "after" is what says so.
        expect(describeTailscaleSearch(search)).toBe(
            `answered by ${working}, after ${sandboxed} exited 1: failed to connect to local tailscaled`
        );
    });

    it('pins the binary that answered, so a MUTATION never re-runs on another candidate', async () => {
        const dir = scratch();
        const log = path.join(dir, 'ran.log');
        const sandboxed = refusingCLI(dir, 'sandboxed', 'failed to connect to local tailscaled', log);
        const working = answeringCLI(dir, 'working', log);
        const run = defaultTailscaleRunner([sandboxed, working]);

        const status = await run(['status', '--json']);
        expect(status.binary).toBe(working);

        // `serve --bg` writes the tailnet's :443 handler. Re-searching would re-issue it against
        // every other candidate on a refusal, and could configure an install whose backend is
        // not the one `status` was read from.
        const serve = await run(['serve', '--bg', '61154']);
        expect(serve.binary).toBe(working);
        expect(serve.code).toBe(0);

        expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
            'sandboxed status --json',
            'working status --json',
            'working serve --bg 61154'
        ]);
    });

    it('reports what the PINNED binary just did, not what it did when it was pinned (#169)', async () => {
        const dir = scratch();
        const log = path.join(dir, 'ran.log');
        const once = path.join(dir, 'answered.once');
        // Answers the first time, refuses every time after: the daemon boots while tailscale is
        // healthy and tailscale stops later, which is the ordinary way this fails.
        const flaky = fakeCLI(
            dir,
            'flaky',
            [
                `echo "flaky $*" >> '${log}'`,
                `if [ -f '${once}' ]; then`,
                '    echo "failed to connect to local tailscaled" >&2',
                '    exit 1',
                'fi',
                `: > '${once}'`,
                `printf '%s' '${STATUS_RUNNING}'`
            ].join('\n')
        );
        const spare = answeringCLI(dir, 'spare', log);
        const run = defaultTailscaleRunner([flaky, spare]);

        expect((await run(['status', '--json'])).binary).toBe(flaky);
        const second = await run(['status', '--json']);

        expect(second.code).toBe(1);
        // The pinning search records `flaky` at code 0. Handing that back unedited dropped the
        // one line that names the cause, and the card fell back to a bare "state: unknown".
        expect(tailscaleProbeDiagnostics(second)).toEqual({
            tried: [flaky],
            used: undefined,
            failure: `${flaky} exited 1: failed to connect to local tailscaled`
        });
        // A refusal is an ANSWER, so the pin holds and `spare` is never consulted.
        expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
            'flaky status --json',
            'flaky status --json'
        ]);
    });

    it('drops the pin when the pinned binary wedges, so the next invocation searches again', async () => {
        const dir = scratch();
        const log = path.join(dir, 'ran.log');
        const runs = path.join(dir, 'runs');
        const refusing = refusingCLI(dir, 'refusing', 'failed to connect to local tailscaled', log);
        // Answers, then wedges on its SECOND call only: one timeout is the point being made, and
        // the third call answers again so the re-search can be seen reaching a candidate; in
        // production the re-search reaches a later candidate only if the wedged binary recovers,
        // because the shared budget is spent on it first. Deliberately slow: it burns one full
        // 2 s budget, hence the explicit per-test timeout below.
        const wedging = fakeCLI(
            dir,
            'wedging',
            [
                `echo "wedging $*" >> '${log}'`,
                `echo x >> '${runs}'`,
                `if [ "$(wc -l < '${runs}')" -eq 2 ]; then exec sleep 30; fi`,
                `printf '%s' '${STATUS_RUNNING}'`
            ].join('\n')
        );
        const run = defaultTailscaleRunner([refusing, wedging], 2_000);

        expect((await run(['status', '--json'])).binary).toBe(wedging);

        // One budget, and the hang is named rather than blamed on the candidate that refused
        // during the search that pinned it.
        const wedged = await run(['status', '--json']);
        expect(wedged).toMatchObject({ code: -1, binary: wedging });
        expect(tailscaleProbeDiagnostics(wedged).failure).toBe(`${wedging} could not be run: timed out after 2s`);

        // The pin is gone - a binary that could not be RUN has stopped being an answer - so this
        // one searches from the top, and `refusing` runs a second time, which it never would
        // while the pin held.
        expect((await run(['status', '--json'])).binary).toBe(wedging);
        expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
            'refusing status --json',
            'wedging status --json',
            'wedging status --json',
            'refusing status --json',
            'wedging status --json'
        ]);
    }, 15_000);

    it('drops the pin when the pinned binary goes away, and searches again', async () => {
        const dir = scratch();
        const first = answeringCLI(dir, 'first');
        const second = answeringCLI(dir, 'second');
        const run = defaultTailscaleRunner([first, second]);

        expect((await run(['status', '--json'])).binary).toBe(first);
        fs.rmSync(first);
        expect((await run(['status', '--json'])).binary).toBe(second);
    });

    it('spends ONE budget across the whole search, not one per candidate', async () => {
        const dir = scratch();
        const log = path.join(dir, 'ran.log');
        // `exec` so the sleeping process IS the one execFile spawned and the timeout kills it.
        const hung = fakeCLI(dir, 'hung', 'exec sleep 30');
        const working = answeringCLI(dir, 'working', log);

        const started = Date.now();
        const result = await defaultTailscaleRunner([hung, working], 400)(['status', '--json']);

        // Four candidates must not cost four timeouts: the client gives remote-status 15s total.
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(result).toMatchObject({ code: -1, stderr: 'timed out after 400ms' });
        // The budget was spent, so `working` was never reached and is not claimed as tried.
        expect(tailscaleProbeDiagnostics(result).tried).toEqual([hung]);
        expect(fs.existsSync(log)).toBe(false);
    });

    it('reports the candidate that ran over the one that was never there when none answer', async () => {
        const dir = scratch();
        const absent = absentCLI(dir);
        const sandboxed = fakeCLI(dir, 'sandboxed', 'echo "Tailscale is sandboxed\nsecond line" >&2\nexit 1');

        const result = await defaultTailscaleRunner([absent, sandboxed])(['status', '--json']);

        expect(result.code).toBe(1);
        expect(result.binary).toBe(sandboxed);
        // One line, because the status card is one line.
        expect(explainTailscaleProbe('tailscaled is not running (state: unknown)', result)).toBe(
            `tailscaled is not running (state: unknown) - tried ${absent}, ${sandboxed}; ` +
                `${sandboxed} exited 1: Tailscale is sandboxed`
        );
    });

    it('every candidate missing is still the not-installed sentinel, with the search attached', async () => {
        const dir = scratch();
        const first = absentCLI(dir, 'first');
        const second = absentCLI(dir, 'second');

        const result = await defaultTailscaleRunner([first, second])(['status', '--json']);

        expect(result).toMatchObject({ code: -1, stderr: 'ENOENT' });
        expect(tailscaleProbeDiagnostics(result)).toEqual({
            tried: [first, second],
            used: undefined,
            failure: undefined
        });
        expect(explainTailscaleProbe('tailscale is not installed', result)).toBe(
            `tailscale is not installed - tried ${first}, ${second}`
        );
    });
});

import { describe, expect, it } from 'vitest';

import {
    firstLink,
    parseServeProxyPorts,
    parseTailscaleStatus,
    resolveTailnetURL,
    tailnetClientURL,
    tailscaleBinaryCandidates,
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
});

describe('tailnetClientURL', () => {
    it('is https on the bare MagicDNS host with the token encoded', () => {
        expect(tailnetClientURL('werk.taila5f942.ts.net', 'a+b/c')).toBe(
            'https://werk.taila5f942.ts.net/?token=a%2Bb%2Fc'
        );
    });
});

describe('resolveTailnetURL', () => {
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

    it('macOS probes PATH first, then the App Store bundle CLI (which symlinks nothing)', () => {
        expect(tailscaleBinaryCandidates({}, 'darwin')).toEqual([
            'tailscale',
            '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
        ]);
    });

    it('everywhere else PATH is the only candidate', () => {
        expect(tailscaleBinaryCandidates({}, 'linux')).toEqual(['tailscale']);
        expect(tailscaleBinaryCandidates({}, 'win32')).toEqual(['tailscale']);
    });
});

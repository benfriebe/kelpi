/**
 * Doctor's seven checks (cli.md §16), including the two the daemon architecture changes.
 *
 * `process` and `version` are the interesting ones: the Swift CLI FAILed `process` whenever
 * `Nex.app` was not in `ps`, which in the daemon world is the *normal* case, and it WARNed on
 * any version-string difference between a CLI and an app that used to ship as one bundle.
 * Both are re-pointed here, and the hook checks are unchanged local filesystem reads.
 */

import { describe, expect, it } from 'vitest';

import type { ProcessResult } from './proc.js';
import {
    pingCheck,
    processCheck,
    reachabilityCheck,
    readDaemonRecord,
    resolveRunDir,
    transportCheck,
    versionCheck,
    type PingFacts,
    type ProcessDeps
} from './doctor/checks.js';
import { claudeHooksCheck, codexHooksCheck, matcherCovers, type HookFilesystem } from './doctor/hooks.js';
import { exitCodeFor, printHumanReport, reportJSON } from './doctor/types.js';
import { setLastTransportFailure } from './transport.js';
import { resetIO, setIO } from './io.js';
import { PROTOCOL_VERSION } from '@nex/protocol';

const CLI = { version: '0.1.0', build: 'dev', protocol: PROTOCOL_VERSION };

function ok(stdout: string): ProcessResult {
    return { stdout, stderr: '', exitCode: 0 };
}

function processDeps(overrides: Partial<ProcessDeps> = {}): ProcessDeps {
    return {
        env: {},
        platform: 'darwin',
        home: '/Users/tester',
        run: async () => ok(''),
        readFile: () => null,
        isAlive: () => false,
        ...overrides
    };
}

describe('transport / reachability', () => {
    it('always passes and names the endpoint', () => {
        expect(transportCheck({ kind: 'unix', path: '/tmp/nex.sock' })).toMatchObject({
            status: 'PASS',
            detail: 'Unix socket at /tmp/nex.sock'
        });
        expect(transportCheck({ kind: 'tcp', host: '127.0.0.1', port: 19400 }).detail).toBe(
            'TCP 127.0.0.1:19400 (from NEX_SOCKET)'
        );
    });

    it('fails when the socket file is missing and passes when it is there', async () => {
        const missing = await reachabilityCheck(
            { kind: 'unix', path: '/tmp/nex.sock' },
            { socketExists: () => false, resolveHost: async () => true }
        );
        expect(missing).toMatchObject({ name: 'socket', status: 'FAIL' });
        const present = await reachabilityCheck(
            { kind: 'unix', path: '/tmp/nex.sock' },
            { socketExists: () => true, resolveHost: async () => true }
        );
        expect(present).toMatchObject({ name: 'socket', status: 'PASS', detail: 'socket file exists' });
    });

    it('resolves the host on TCP', async () => {
        const failed = await reachabilityCheck(
            { kind: 'tcp', host: 'nope.invalid', port: 1 },
            { socketExists: () => true, resolveHost: async () => false }
        );
        expect(failed).toMatchObject({ name: 'resolve', status: 'FAIL' });
        expect(failed.detail).toContain('nope.invalid');
    });
});

describe('ping', () => {
    it('carries the categorized transport failure through', () => {
        setLastTransportFailure({ kind: 'unixSocketMissing', path: '/tmp/nex.sock' });
        const check = pingCheck(null, {});
        expect(check).toMatchObject({ name: 'ping', status: 'FAIL' });
        expect(check.detail).toContain('nex doctor: cannot reach Nex');
        setLastTransportFailure(null);
    });

    it('distinguishes an empty reply from a malformed one', () => {
        expect(pingCheck('', {}).detail).toContain('closed the connection before replying');
        expect(pingCheck('not json', {}).detail).toBe('received malformed reply (8 bytes).');
        expect(pingCheck('{"ok":false}', {}).status).toBe('FAIL');
    });

    it('passes and stashes pid / version / build / protocol for the later checks', () => {
        const facts: PingFacts = {};
        const check = pingCheck(JSON.stringify({ ok: true, pid: 4242, version: '0.1.0', build: '1', protocol: 1 }), facts);
        expect(check).toMatchObject({ status: 'PASS', detail: 'round-trip ok (app pid 4242)' });
        expect(facts).toEqual({ pid: 4242, version: '0.1.0', build: '1', protocol: 1 });
    });
});

describe('process (daemon-aware)', () => {
    it('skips on TCP — the daemon is on another host', async () => {
        const check = await processCheck({ kind: 'tcp', host: 'h', port: 1 }, processDeps(), {});
        expect(check).toMatchObject({ name: 'process', status: 'SKIP' });
        expect(check.detail).toContain('TCP transport');
    });

    it('passes on a live pid record in the run dir, with no ps hit at all', async () => {
        const record = JSON.stringify({ pid: 777, protocol: PROTOCOL_VERSION, started_at: '', version: '0.1.0' });
        const check = await processCheck(
            { kind: 'unix', path: '/tmp/nex.sock' },
            processDeps({ readFile: () => record, isAlive: (pid) => pid === 777 }),
            { pid: 777 }
        );
        expect(check.status).toBe('PASS');
        expect(check.detail).toContain('nexd running (pid 777');
    });

    it('ignores a STALE pid record (the process is gone)', async () => {
        const record = JSON.stringify({ pid: 777, protocol: PROTOCOL_VERSION, started_at: '' });
        const check = await processCheck(
            { kind: 'unix', path: '/tmp/nex.sock' },
            processDeps({ readFile: () => record, isAlive: () => false }),
            {}
        );
        expect(check.status).toBe('FAIL');
        expect(check.detail).toBe('no running nexd or Nex.app process found');
    });

    it('accepts a bundled `nexd.js` under node from the process table', async () => {
        const check = await processCheck(
            { kind: 'unix', path: '/tmp/nex.sock' },
            processDeps({
                run: async (_path, args) =>
                    args.includes('pid=,command=')
                        ? ok('  901 /usr/local/bin/node /opt/nex/packages/daemon/dist/nexd.js start --foreground\n')
                        : ok('')
            }),
            {}
        );
        expect(check).toMatchObject({ status: 'PASS' });
        expect(check.detail).toBe('nexd running (pids: 901)');
    });

    it('still accepts the Swift app', async () => {
        const check = await processCheck(
            { kind: 'unix', path: '/tmp/nex.sock' },
            processDeps({
                run: async (_path, args) =>
                    args.includes('pid=,comm=') ? ok(' 1234 /Applications/Nex.app/Contents/MacOS/Nex\n') : ok('')
            }),
            {}
        );
        expect(check).toMatchObject({ status: 'PASS', detail: 'Nex.app running (pids: 1234)' });
    });

    it('warns when ping answered from a pid nothing else knows about', async () => {
        const check = await processCheck(
            { kind: 'unix', path: '/tmp/nex.sock' },
            processDeps({
                run: async (_path, args) =>
                    args.includes('pid=,comm=') ? ok(' 1234 /Applications/Nex.app/Contents/MacOS/Nex\n') : ok('')
            }),
            { pid: 999 }
        );
        expect(check.status).toBe('WARN');
        expect(check.detail).toContain('ping replied from pid 999');
    });

    it('resolves the run dir per platform, with NEXD_RUN_DIR winning', () => {
        expect(resolveRunDir({}, 'darwin', '/Users/t')).toBe('/Users/t/Library/Application Support/nexd/run');
        expect(resolveRunDir({}, 'linux', '/home/t')).toBe('/home/t/.local/state/nexd/run');
        expect(resolveRunDir({ XDG_RUNTIME_DIR: '/run/user/1' }, 'linux', '/home/t')).toBe('/run/user/1/nexd');
        expect(resolveRunDir({ NEXD_RUN_DIR: '/custom/run' }, 'darwin', '/Users/t')).toBe('/custom/run');
    });

    it('reads only a well-formed pid record', () => {
        expect(readDaemonRecord('/run', () => null)).toBeNull();
        expect(readDaemonRecord('/run', () => 'nope')).toBeNull();
        expect(readDaemonRecord('/run', () => '{"pid":0}')).toBeNull();
        expect(readDaemonRecord('/run', () => '{"pid":5,"protocol":9}')).toEqual({
            pid: 5,
            protocol: 9,
            version: undefined
        });
    });
});

describe('version (daemon-aware)', () => {
    it('skips when ping brought nothing back', () => {
        expect(versionCheck(CLI, {})).toMatchObject({ name: 'version', status: 'SKIP' });
    });

    it('passes on an identical version and build', () => {
        const check = versionCheck(CLI, { version: '0.1.0', build: 'dev', protocol: PROTOCOL_VERSION });
        expect(check).toMatchObject({ status: 'PASS', detail: 'CLI 0.1.0 matches nexd 0.1.0' });
    });

    it('warns — but only advisorily — when the two artifacts differ', () => {
        const check = versionCheck(CLI, { version: '0.1.0', build: '1', protocol: PROTOCOL_VERSION });
        expect(check.status).toBe('WARN');
        expect(check.detail).toBe('CLI is 0.1.0 (build dev); nexd is 0.1.0 (build 1).');
        expect(check.repair).toContain('Advisory only');
        // A WARN never fails doctor.
        expect(exitCodeFor([check])).toBe(0);
    });

    it('escalates the wording when the PROTOCOL differs — that one actually breaks the wire', () => {
        const check = versionCheck(CLI, { version: '9.9.9', build: '1', protocol: PROTOCOL_VERSION + 1 });
        expect(check.status).toBe('WARN');
        expect(check.detail).toContain(`CLI speaks protocol ${String(PROTOCOL_VERSION)}`);
        expect(check.repair).toContain('Protocol drift');
    });

    it('still compares against a Swift app, which sends no protocol', () => {
        expect(versionCheck(CLI, { version: '0.32.0', build: '32' }).status).toBe('WARN');
        expect(versionCheck({ ...CLI, version: '0.32.0' }, { version: '0.32.0' }).status).toBe('PASS');
    });
});

describe('hooks', () => {
    function fsWith(entries: Record<string, string>, dirs: string[] = []): HookFilesystem {
        return {
            readFile: (path) => entries[path] ?? null,
            isDirectory: (path) => dirs.includes(path)
        };
    }

    const wired = JSON.stringify({
        hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'nex event stop' }] }],
            Notification: [{ hooks: [{ type: 'command', command: 'nex event notification' }] }],
            SessionStart: [{ hooks: [{ type: 'command', command: 'nex event session-start' }] }],
            SessionEnd: [{ hooks: [{ type: 'command', command: 'nex event session-end' }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'nex event start' }] }]
        }
    });

    it('skips when Claude Code is not on the machine', () => {
        expect(claudeHooksCheck(fsWith({}), '/Users/t')).toMatchObject({ status: 'SKIP' });
    });

    it('warns when the directory exists but carries no settings', () => {
        const check = claudeHooksCheck(fsWith({}, ['/Users/t/.claude']), '/Users/t');
        expect(check.status).toBe('WARN');
        expect(check.detail).toContain('no Claude Code settings');
    });

    it('passes a fully wired matcher-less config', () => {
        const check = claudeHooksCheck(fsWith({ '/Users/t/.claude/settings.json': wired }), '/Users/t');
        expect(check).toMatchObject({ status: 'PASS' });
        expect(check.detail).toContain('checked settings.json');
    });

    it('accepts absolute paths and extra flags (substring match)', () => {
        const absolute = wired.replace(/nex event/g, '/Applications/Nex.app/Contents/Helpers/nex event');
        expect(claudeHooksCheck(fsWith({ '/Users/t/.claude/settings.json': absolute }), '/Users/t').status).toBe('PASS');
    });

    it('reports missing hooks and a stale SessionStart matcher', () => {
        const stale = JSON.stringify({
            hooks: {
                Stop: [{ hooks: [{ type: 'command', command: 'nex event stop' }] }],
                SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'nex event session-start' }] }]
            }
        });
        const check = claudeHooksCheck(fsWith({ '/Users/t/.claude/settings.json': stale }), '/Users/t');
        expect(check.status).toBe('WARN');
        expect(check.detail).toContain('missing hook(s): Notification → `nex event notification`');
        expect(check.detail).toContain('SessionStart matcher "startup" misses source(s): resume, clear, compact');
        expect(check.detail).toContain('issue #181');
    });

    it('flags disableAllHooks, taking the LAST file that defines it', () => {
        const check = claudeHooksCheck(
            fsWith({
                '/Users/t/.claude/settings.json': JSON.stringify({ disableAllHooks: false, ...JSON.parse(wired) }),
                '/Users/t/.claude/settings.local.json': JSON.stringify({ disableAllHooks: true })
            }),
            '/Users/t'
        );
        expect(check.status).toBe('WARN');
        expect(check.detail).toContain('"disableAllHooks": true is set');
    });

    it('notes an unparseable settings file', () => {
        const check = claudeHooksCheck(fsWith({ '/Users/t/.claude/settings.json': '{oops' }), '/Users/t');
        expect(check.detail).toContain('not valid JSON: settings.json');
    });

    it('checks the four codex hooks in ~/.codex/hooks.json', () => {
        expect(codexHooksCheck(fsWith({}), '/Users/t')).toMatchObject({ status: 'SKIP' });
        expect(codexHooksCheck(fsWith({}, ['/Users/t/.codex']), '/Users/t').detail).toContain('no hooks.json');

        const codex = JSON.stringify({
            hooks: {
                Stop: [{ hooks: [{ type: 'command', command: 'nex event stop --agent codex' }] }],
                PermissionRequest: [{ hooks: [{ type: 'command', command: 'nex event notification --agent codex' }] }],
                SessionStart: [{ hooks: [{ type: 'command', command: 'nex event session-start --agent codex' }] }],
                UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'nex event start --agent codex' }] }]
            }
        });
        const check = codexHooksCheck(
            fsWith({ '/Users/t/.codex/hooks.json': codex }, ['/Users/t/.codex']),
            '/Users/t'
        );
        expect(check.status).toBe('PASS');
        expect(check.detail).toContain('trust state not verifiable');

        const partial = codexHooksCheck(
            fsWith({ '/Users/t/.codex/hooks.json': '{"hooks":{}}' }, ['/Users/t/.codex']),
            '/Users/t'
        );
        expect(partial.status).toBe('WARN');
        expect(partial.detail).toContain('missing hook(s)');
        expect(partial.repair).toContain('/hooks inside codex');
    });
});

describe('matcherCovers', () => {
    it.each([
        ['', 'resume', true],
        ['*', 'resume', true],
        ['startup', 'startup', true],
        ['startup', 'resume', false],
        ['startup|resume', 'resume', true],
        ['startup, resume', 'resume', true],
        ['^(startup|resume)$', 'resume', true],
        ['^(startup|resume)$', 'clear', false],
        // A bare word is an EXACT list entry, not a substring — `re` does not cover `resume`.
        ['re', 'resume', false],
        // Anything outside the list alphabet is an unanchored regex instead.
        ['re.*', 'resume', true],
        ['[', 'resume', false]
    ])('matcherCovers(%j, %j)', (matcher, source, expected) => {
        expect(matcherCovers(matcher, source)).toBe(expected);
    });
});

describe('report rendering', () => {
    it('prints repairs only for non-PASS checks and summarises at the end', () => {
        const lines: string[] = [];
        setIO({ out: (text) => lines.push(text), err: () => undefined });
        printHumanReport([
            { name: 'transport', status: 'PASS', detail: 'Unix socket at /tmp/nex.sock', repair: 'ignored' },
            { name: 'ping', status: 'FAIL', detail: 'boom', repair: 'restart' }
        ]);
        resetIO();
        const text = lines.join('');
        expect(text).toContain('[PASS] transport: Unix socket at /tmp/nex.sock\n');
        expect(text).not.toContain('→ ignored');
        expect(text).toContain('[FAIL] ping: boom\n        → restart\n');
        expect(text.trimEnd().endsWith('Summary: 1 fail(s), 0 warn(s).')).toBe(true);
    });

    it('lowercases the status in JSON and gates `ok` on FAIL only', () => {
        const report = reportJSON([
            { name: 'version', status: 'WARN', detail: 'drift', repair: 'rebuild' },
            { name: 'hooks', status: 'SKIP', detail: 'skipped' }
        ]);
        expect(report).toEqual({
            ok: true,
            checks: [
                { name: 'version', status: 'warn', detail: 'drift', repair: 'rebuild' },
                { name: 'hooks', status: 'skip', detail: 'skipped' }
            ]
        });
    });
});

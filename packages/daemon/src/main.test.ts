/**
 * The `nexd` CLI surface: argument parsing, and the three verbs against a run directory that
 * really does (or does not) have a daemon in it.
 *
 * `nexd stop` is deliberately NOT exercised against the in-process daemon: the daemon's pid
 * IS the test runner's pid, so the SIGTERM would kill vitest. Its parsing and its
 * "not running" branch are covered instead.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDaemon } from './boot/index.js';
import { helpText, parseNexdArgs, resolveEntry, runNexd, type CliIO } from './main.js';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

function scratch(): { root: string; runDir: string; socketPath: string; dbPath: string; home: string; configPath: string } {
    const root = fs.mkdtempSync(path.join('/tmp', 'nexd-cli-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    return {
        root,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'nex.sock'),
        dbPath: path.join(root, 'nex.db'),
        home,
        configPath: path.join(root, 'config')
    };
}

interface Captured extends CliIO {
    readonly stdout: string[];
    readonly stderr: string[];
    text(): string;
}

function io(env: NodeJS.ProcessEnv = {}): Captured {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        stdout,
        stderr,
        env,
        out: (line) => stdout.push(line),
        err: (line) => stderr.push(line),
        text: () => [...stdout, ...stderr].join('\n')
    };
}

describe('parseNexdArgs', () => {
    it('defaults to help and recognises the verbs', () => {
        expect(parseNexdArgs([]).command).toBe('help');
        expect(parseNexdArgs(['start']).command).toBe('start');
        expect(parseNexdArgs(['stop']).command).toBe('stop');
        expect(parseNexdArgs(['status']).command).toBe('status');
        expect(parseNexdArgs(['--help']).command).toBe('help');
        expect(parseNexdArgs(['--version']).command).toBe('version');
    });

    it('parses the flags each verb takes', () => {
        expect(parseNexdArgs(['start', '--foreground']).foreground).toBe(true);
        expect(parseNexdArgs(['start', '-f']).foreground).toBe(true);
        expect(parseNexdArgs(['start', '--no-detach']).foreground).toBe(true);
        expect(parseNexdArgs(['status', '--json']).json).toBe(true);
        expect(parseNexdArgs(['stop', '--timeout', '250']).timeoutMs).toBe(250);
    });

    it('rejects an unknown argument and a malformed timeout', () => {
        expect(parseNexdArgs(['restart']).error).toBe('unknown argument: restart');
        expect(parseNexdArgs(['stop', '--timeout', 'soon']).error).toBe('--timeout needs a millisecond value');
    });

    it('documents every env override in --help', async () => {
        const captured = io();
        expect(await runNexd(['--help'], captured)).toBe(0);
        for (const key of [
            'NEXD_RUN_DIR',
            'NEXD_SOCKET_PATH',
            'NEXD_TCP_PORT',
            'NEXD_HTTP_PORT',
            'NEXD_HTTP_HOST',
            'NEXD_DB_PATH',
            'NEXD_CONFIG_PATH',
            'NEXD_CLIENT_DIR',
            'NEXD_LOG_FILE',
            'NEXD_ENTRY',
            'NEX_SOCKET'
        ]) {
            expect(helpText()).toContain(key);
        }
        expect(captured.stdout.join('\n')).toContain('nexd start');
    });

    it('exits 2 on a usage error, printing the reason and the usage', async () => {
        const captured = io();
        expect(await runNexd(['nope'], captured)).toBe(2);
        expect(captured.stderr[0]).toBe('unknown argument: nope');
    });

    it('prints the daemon version', async () => {
        const captured = io({ NEXD_VERSION: '9.9.9' });
        expect(await runNexd(['--version'], captured)).toBe(0);
        expect(captured.stdout).toEqual(['9.9.9']);
    });
});

describe('resolveEntry', () => {
    it('prefers NEXD_ENTRY, else this module', () => {
        expect(resolveEntry({ NEXD_ENTRY: '/opt/nex/nexd.js' })).toBe('/opt/nex/nexd.js');
        expect(resolveEntry({})).toMatch(/main\.(ts|js)$/);
    });
});

describe('with no daemon running', () => {
    it('reports status as not running (exit 1) and stop as a no-op (exit 0)', async () => {
        const paths = scratch();
        const env = { NEXD_RUN_DIR: paths.runDir, NEXD_SOCKET_PATH: paths.socketPath };

        const status = io(env);
        expect(await runNexd(['status'], status)).toBe(1);
        expect(status.text()).toContain('nexd is not running');

        const json = io(env);
        expect(await runNexd(['status', '--json'], json)).toBe(1);
        expect(JSON.parse(json.stdout[0] as string)).toMatchObject({ running: false, pid: null });

        const stop = io(env);
        expect(await runNexd(['stop'], stop)).toBe(0);
        expect(stop.stdout).toEqual(['nexd is not running']);
    });
});

describe('with a daemon running', () => {
    it('reports status and refuses to start a second one', async () => {
        const paths = scratch();
        const daemon = createDaemon({
            env: {},
            home: paths.home,
            runDir: paths.runDir,
            controlSocketPath: paths.socketPath,
            dbPath: paths.dbPath,
            configPath: paths.configPath,
            httpPort: 0,
            settleMs: 0
        });
        cleanups.push(() => daemon.stop());
        const info = await daemon.start();
        const env = { NEXD_RUN_DIR: paths.runDir, NEXD_SOCKET_PATH: paths.socketPath };

        const status = io(env);
        expect(await runNexd(['status'], status)).toBe(0);
        expect(status.text()).toContain(`nexd is running (pid ${String(process.pid)})`);
        expect(status.text()).toContain(paths.socketPath);
        expect(status.text()).toContain(`http://127.0.0.1:${String(info.httpPort)}`);

        const json = io(env);
        expect(await runNexd(['status', '--json'], json)).toBe(0);
        expect(JSON.parse(json.stdout[0] as string)).toMatchObject({
            running: true,
            pid: process.pid,
            version: info.version.version,
            protocol: info.version.protocol,
            http_port: info.httpPort,
            control_socket: paths.socketPath
        });

        // `start` must never spawn a second daemon over a live one.
        const start = io(env);
        expect(await runNexd(['start'], start)).toBe(0);
        expect(start.stdout[0]).toContain('already running');
    }, 30_000);
});

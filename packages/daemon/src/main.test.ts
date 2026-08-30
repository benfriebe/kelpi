/**
 * The `kelpid` CLI surface: argument parsing, and the three verbs against a run directory that
 * really does (or does not) have a daemon in it.
 *
 * `kelpid stop` is deliberately NOT exercised against the in-process daemon: the daemon's pid
 * IS the test runner's pid, so the SIGTERM would kill vitest. Its parsing and its
 * "not running" branch are covered instead.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDaemon } from './boot/index.js';
import { openSqliteDatabase } from './db/index.js';
import { helpText, parseKelpidArgs, resolveEntry, runKelpid, type CliIO } from './main.js';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

function scratch(): { root: string; runDir: string; socketPath: string; dbPath: string; home: string; configPath: string } {
    const root = fs.mkdtempSync(path.join('/tmp', 'kelpid-cli-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    return {
        root,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'kelpi.sock'),
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

describe('parseKelpidArgs', () => {
    it('defaults to help and recognises the verbs', () => {
        expect(parseKelpidArgs([]).command).toBe('help');
        expect(parseKelpidArgs(['start']).command).toBe('start');
        expect(parseKelpidArgs(['stop']).command).toBe('stop');
        expect(parseKelpidArgs(['status']).command).toBe('status');
        expect(parseKelpidArgs(['url']).command).toBe('url');
        expect(parseKelpidArgs(['--help']).command).toBe('help');
        expect(parseKelpidArgs(['--version']).command).toBe('version');
    });

    it('parses the flags each verb takes', () => {
        expect(parseKelpidArgs(['start', '--foreground']).foreground).toBe(true);
        expect(parseKelpidArgs(['start', '-f']).foreground).toBe(true);
        expect(parseKelpidArgs(['start', '--no-detach']).foreground).toBe(true);
        expect(parseKelpidArgs(['status', '--json']).json).toBe(true);
        expect(parseKelpidArgs(['stop', '--timeout', '250']).timeoutMs).toBe(250);
    });

    it('rejects an unknown argument and a malformed timeout', () => {
        expect(parseKelpidArgs(['restart']).error).toBe('unknown argument: restart');
        expect(parseKelpidArgs(['stop', '--timeout', 'soon']).error).toBe('--timeout needs a millisecond value');
    });

    it('documents every env override in --help', async () => {
        const captured = io();
        expect(await runKelpid(['--help'], captured)).toBe(0);
        for (const key of [
            'KELPID_RUN_DIR',
            'KELPID_SOCKET_PATH',
            'KELPID_TCP_PORT',
            'KELPID_HTTP_PORT',
            'KELPID_HTTP_HOST',
            'KELPID_DB_PATH',
            'KELPID_CONFIG_PATH',
            'KELPID_CLIENT_DIR',
            'KELPID_LOG_FILE',
            'KELPID_ENTRY',
            'KELPI_SOCKET'
        ]) {
            expect(helpText()).toContain(key);
        }
        expect(captured.stdout.join('\n')).toContain('kelpid start');
        // The URL verb is only useful if it is discoverable from --help.
        expect(helpText()).toContain('kelpid url');
        expect(helpText()).toContain('open "$(kelpid url)"');
    });

    it('exits 2 on a usage error, printing the reason and the usage', async () => {
        const captured = io();
        expect(await runKelpid(['nope'], captured)).toBe(2);
        expect(captured.stderr[0]).toBe('unknown argument: nope');
    });

    it('prints the daemon version', async () => {
        const captured = io({ KELPID_VERSION: '9.9.9' });
        expect(await runKelpid(['--version'], captured)).toBe(0);
        expect(captured.stdout).toEqual(['9.9.9']);
    });
});

describe('resolveEntry', () => {
    it('prefers KELPID_ENTRY, else this module', () => {
        expect(resolveEntry({ KELPID_ENTRY: '/opt/kelpi/kelpid.js' })).toBe('/opt/kelpi/kelpid.js');
        expect(resolveEntry({})).toMatch(/main\.(ts|js)$/);
    });
});

describe('with no daemon running', () => {
    it('reports status as not running (exit 1) and stop as a no-op (exit 0)', async () => {
        const paths = scratch();
        const env = { KELPID_RUN_DIR: paths.runDir, KELPID_SOCKET_PATH: paths.socketPath };

        const status = io(env);
        expect(await runKelpid(['status'], status)).toBe(1);
        expect(status.text()).toContain('kelpid is not running');

        const json = io(env);
        expect(await runKelpid(['status', '--json'], json)).toBe(1);
        expect(JSON.parse(json.stdout[0] as string)).toMatchObject({ running: false, pid: null });

        const stop = io(env);
        expect(await runKelpid(['stop'], stop)).toBe(0);
        expect(stop.stdout).toEqual(['kelpid is not running']);
    });

    it('fails `url` with a hint on stderr and nothing on stdout', async () => {
        const paths = scratch();
        const url = io({ KELPID_RUN_DIR: paths.runDir, KELPID_SOCKET_PATH: paths.socketPath });
        expect(await runKelpid(['url'], url)).toBe(1);
        // `open "$(kelpid url)"` must never be handed a diagnostic string.
        expect(url.stdout).toEqual([]);
        expect(url.stderr.join('\n')).toContain('kelpid is not running');
        expect(url.stderr.join('\n')).toContain('kelpid start');
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
        const env = { KELPID_RUN_DIR: paths.runDir, KELPID_SOCKET_PATH: paths.socketPath };

        const status = io(env);
        expect(await runKelpid(['status'], status)).toBe(0);
        expect(status.text()).toContain(`kelpid is running (pid ${String(process.pid)})`);
        expect(status.text()).toContain(paths.socketPath);
        expect(status.text()).toContain(`http://127.0.0.1:${String(info.httpPort)}`);

        const json = io(env);
        expect(await runKelpid(['status', '--json'], json)).toBe(0);
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
        expect(await runKelpid(['start'], start)).toBe(0);
        expect(start.stdout[0]).toContain('already running');

        // The whole point of the fix: every path that mentions a port also hands over a URL
        // that can actually connect. A bare origin loads the client and then fails the
        // handshake, which is the loop the user hit.
        const expected = `http://127.0.0.1:${String(info.httpPort)}/?token=${info.token}`;
        expect(status.stdout).toContain(`  url: ${expected}`);
        expect(start.stdout).toContain(`  url: ${expected}`);

        const url = io(env);
        expect(await runKelpid(['url'], url)).toBe(0);
        expect(url.stdout).toEqual([expected]);
        expect(url.stderr).toEqual([]);

        // The health line every verb now carries (P0): "running" alone was never enough.
        expect(status.stdout.join('\n')).toContain(`  persistence: ok (${paths.dbPath})`);
    }, 30_000);

    /**
     * The P0's CLI half. A daemon that could not save answered `kelpid status` with a clean bill
     * of health and `kelpid stop` with "stopped", over a database of zero bytes. Both must fail.
     */
    it('reports a degraded daemon as unhealthy rather than pretending', async () => {
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
        await daemon.start();
        await daemon.restored;
        const env = { KELPID_RUN_DIR: paths.runDir, KELPID_SOCKET_PATH: paths.socketPath };

        // Break the file under the running daemon (a second connection drops a table the save
        // writes into — a chmod cannot do it, SQLite holds the descriptor), then run the real
        // save path.
        const handle = openSqliteDatabase(paths.dbPath);
        handle.exec('DROP TABLE "pane"');
        handle.close();
        daemon.store.dispatch({
            type: 'create-workspace',
            id: 'AAAAAAAA-0000-4000-8000-0000000000AA',
            paneID: 'BBBBBBBB-0000-4000-8000-0000000000BB',
            name: 'unsaveable',
            now: Date.now()
        });
        daemon.persistence.flush();
        expect(daemon.persistenceHealth().degraded).toBe(true);

        const status = io(env);
        expect(await runKelpid(['status'], status)).toBe(1);
        expect(status.stdout.join('\n')).toContain('kelpid is running');
        expect(status.stdout.join('\n')).toContain('persistence: DEGRADED');
        expect(status.stderr.join('\n')).toContain('state is NOT being saved');
        expect(status.stderr.join('\n')).toContain(paths.dbPath);

        const json = io(env);
        expect(await runKelpid(['status', '--json'], json)).toBe(1);
        expect(JSON.parse(json.stdout[0] as string)).toMatchObject({
            // Snake_case, like every other key in this object.
            running: true,
            persistence: { ok: false, degraded: true, path: paths.dbPath, failed_saves: 1 }
        });

        // Adopting a broken daemon is not a successful `start` either.
        const start = io(env);
        expect(await runKelpid(['start'], start)).toBe(1);
        expect(start.stderr.join('\n')).toContain('state is NOT being saved');
    }, 30_000);
});

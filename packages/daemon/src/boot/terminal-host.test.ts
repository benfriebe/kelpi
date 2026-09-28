/**
 * The daemon running its PTYs in a real terminal host process (`docs/terminal-host.md`).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readHostPidRecord, resolveHostPaths } from '../host/launch.js';
import { buildHostBundle } from '../host/testing.js';
import { isProcessAlive } from '../lifecycle/index.js';
import { createDaemon, type Daemon } from './compose.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Scratch {
    readonly root: string;
    readonly runDir: string;
}

function scratch(): Scratch {
    const root = fs.mkdtempSync(path.join('/tmp', 'kelpid-th-'));
    cleanups.push(() => {
        // Never leave a host (and its shells) behind a failed test.
        const pid = readHostPidRecord(resolveHostPaths(path.join(root, 'run')))?.pid;
        if (pid !== undefined && isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
        fs.rmSync(root, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    return { root, runDir: path.join(root, 'run') };
}

function daemonFor(paths: Scratch, overrides: Parameters<typeof createDaemon>[0] = {}): Daemon {
    const daemon = createDaemon({
        env: {},
        home: path.join(paths.root, 'home'),
        runDir: paths.runDir,
        controlSocketPath: path.join(paths.root, 'kelpi.sock'),
        dbPath: path.join(paths.root, 'nex.db'),
        configPath: path.join(paths.root, 'config'),
        httpPort: 0,
        settleMs: 0,
        spawn: { cols: 80, rows: 24, shell: '/bin/sh' },
        bootDeferWindowMs: 0,
        ...overrides
    });
    cleanups.push(() => daemon.stop());
    return daemon;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined && value !== false) return value;
        if (Date.now() > deadline) throw new Error('timed out');
        await sleep(25);
    }
}

function parentOf(pid: number): number {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

function firstShellPane(daemon: Daemon): string {
    const pane = daemon.store.getState().workspaces[0]?.panes.find((candidate) => candidate.type === 'shell');
    if (pane === undefined) throw new Error('no shell pane');
    return pane.id;
}

describe('a daemon with a terminal host', () => {
    it('runs every shell in the host, and a full stop ends both', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths, { terminalHost: { daemonDir: await buildHostBundle() } });
        await daemon.start();
        await daemon.restored;
        const paneID = firstShellPane(daemon);
        const shellPid = await until(() => daemon.pty.pid(paneID));
        const hostPid = readHostPidRecord(resolveHostPaths(paths.runDir))!.pid;
        expect(hostPid).not.toBe(process.pid);
        expect(parentOf(shellPid)).toBe(hostPid);

        daemon.pty.write(paneID, 'echo hosted-$((40+2))\n');
        await until(async () => (await daemon.term.captureAsync(paneID, { scrollback: true })).includes('hosted-42') || undefined);

        await daemon.stop();
        await until(() => (!isProcessAlive(shellPid) && !isProcessAlive(hostPid)) || undefined, 3000);
    }, 20_000);

    it('falls back to in-process terminals when no host can start', async () => {
        const paths = scratch();
        const empty = path.join(paths.root, 'no-host-here');
        fs.mkdirSync(empty);
        const logs: string[] = [];
        const daemon = daemonFor(paths, {
            terminalHost: { daemonDir: empty },
            onLog: (message) => logs.push(message),
            onError: () => undefined
        });
        await daemon.start();
        await daemon.restored;
        const paneID = firstShellPane(daemon);
        const shellPid = await until(() => daemon.pty.pid(paneID));
        expect(parentOf(shellPid)).toBe(process.pid);
        expect(logs.some((line) => line.includes('no terminal host'))).toBe(true);
    }, 20_000);

    it('respawns panes instead of closing them when the host dies', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths, { terminalHost: { daemonDir: await buildHostBundle() }, onLog: () => undefined });
        await daemon.start();
        await daemon.restored;
        const paneID = firstShellPane(daemon);
        const firstShell = await until(() => daemon.pty.pid(paneID));
        const firstHost = readHostPidRecord(resolveHostPaths(paths.runDir))!.pid;

        process.kill(firstHost, 'SIGKILL');
        const secondShell = await until(() => {
            const pid = daemon.pty.pid(paneID);
            return pid !== undefined && pid !== firstShell ? pid : undefined;
        }, 8000);
        // Same pane, still in the layout, now on a fresh host.
        expect(daemon.store.getState().workspaces[0]?.panes.some((pane) => pane.id === paneID)).toBe(true);
        const secondHost = readHostPidRecord(resolveHostPaths(paths.runDir))!.pid;
        expect(secondHost).not.toBe(firstHost);
        expect(parentOf(secondShell)).toBe(secondHost);
    }, 20_000);

    it('keeps the host running while the daemon keeps it attached, and adopts nothing yet on restart', async () => {
        const paths = scratch();
        const hostDir = await buildHostBundle();
        const first = daemonFor(paths, { terminalHost: { daemonDir: hostDir } });
        await first.start();
        await first.restored;
        const paneID = firstShellPane(first);
        const oldShell = await until(() => first.pty.pid(paneID));
        await first.stop();
        await until(() => !isProcessAlive(oldShell) || undefined, 3000);

        const second = daemonFor(paths, { terminalHost: { daemonDir: hostDir } });
        await second.start();
        await second.restored;
        const newShell = await until(() => second.pty.pid(paneID));
        expect(newShell).not.toBe(oldShell);
    }, 20_000);
});

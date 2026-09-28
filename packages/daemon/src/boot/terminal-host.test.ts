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

    it('hands a live shell to the next daemon: same process, same screen, the gap once, no resume typed', async () => {
        const paths = scratch();
        const hostDir = await buildHostBundle();
        const first = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await first.start();
        await first.restored;
        const paneID = firstShellPane(first);
        const shellPid = await until(() => first.pty.pid(paneID));
        // An agent session in the pane, as its hooks would report it.
        first.store.dispatch({
            type: 'pane-agent-event',
            paneID,
            event: { type: 'sessionStarted', sessionID: 'b3c1a2d4-0000-4000-8000-000000000001', agent: 'claude' },
            now: Date.now()
        });
        first.store.dispatch({ type: 'pane-agent-event', paneID, event: { type: 'agentStarted', agent: 'claude' }, now: Date.now() });
        first.pty.write(paneID, 'echo before-$((1+1)); (sleep 0.6; echo gap-$((2+3))) &\n');
        await until(async () => (await first.term.captureAsync(paneID, { scrollback: true })).includes('before-2') || undefined);

        expect(await first.handoff()).toBe('handed-off');
        expect(isProcessAlive(shellPid)).toBe(true);
        await sleep(900); // "gap-5" is printed while no daemon is attached

        const second = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await second.start();
        await second.restored;
        expect(second.pty.pid(paneID)).toBe(shellPid);
        const screen = await until(async () => {
            const text = await second.term.captureAsync(paneID, { scrollback: true });
            return text.includes('gap-5') ? text : undefined;
        });
        expect(screen).toContain('before-2');
        expect(screen.split('gap-5').length - 1).toBe(1);
        expect(screen).not.toContain('--resume');
        // The live agent's state came back with the shell instead of resetting to idle.
        const pane = second.store.getState().workspaces[0]?.panes.find((candidate) => candidate.id === paneID);
        expect(pane?.agentSessionID).toBe('b3c1a2d4-0000-4000-8000-000000000001');
        expect(pane?.status).not.toBe('idle');

        // And it still works: input reaches the same shell.
        second.pty.write(paneID, 'echo after-$((3+4))\n');
        await until(async () => (await second.term.captureAsync(paneID, { scrollback: true })).includes('after-7') || undefined);
    }, 30_000);

    it('carries a full-screen program across: alternate screen and keyboard modes', async () => {
        const paths = scratch();
        const hostDir = await buildHostBundle();
        const first = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await first.start();
        await first.restored;
        const paneID = firstShellPane(first);
        await until(() => first.pty.pid(paneID));
        first.pty.write(paneID, "printf '\\033[?1049h\\033[?1h\\033[?2004h\\033[>1u\\033[HFULLSCREEN'; sleep 30\n");
        await until(async () => (await first.term.captureAsync(paneID, { scrollback: false })).includes('FULLSCREEN') || undefined);
        const modesBefore = await first.term.modesAsync(paneID);
        expect(modesBefore.kittyKeyboardFlags).toBe(1);

        await first.handoff();
        const second = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await second.start();
        await second.restored;
        await until(async () => (await second.term.captureAsync(paneID, { scrollback: false })).includes('FULLSCREEN') || undefined);
        expect(await second.term.modesAsync(paneID)).toEqual(modesBefore);
    }, 30_000);

    it('is a full stop without a terminal host', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths);
        await daemon.start();
        await daemon.restored;
        const paneID = firstShellPane(daemon);
        const shellPid = await until(() => daemon.pty.pid(paneID));
        expect(await daemon.handoff()).toBe('stopped');
        await until(() => !isProcessAlive(shellPid) || undefined, 3000);
    }, 20_000);

    it('ends a shell whose pane was closed while no daemon ran, and respawns panes it has no terminal for', async () => {
        const paths = scratch();
        const hostDir = await buildHostBundle();
        const first = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await first.start();
        await first.restored;
        const paneID = firstShellPane(first);
        const shellPid = await until(() => first.pty.pid(paneID));
        await first.handoff();
        // What the next daemon finds: its terminal still on the host, but no pane for it.
        const db = path.join(paths.root, 'nex.db');
        fs.rmSync(db, { force: true });
        const second = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await second.start();
        await second.restored;
        await until(() => !isProcessAlive(shellPid) || undefined, 3000);
        const freshPane = firstShellPane(second);
        expect(await until(() => second.pty.pid(freshPane))).not.toBe(shellPid);
    }, 30_000);

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

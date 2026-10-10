/**
 * The daemon running its PTYs in a real terminal host process (`docs/terminal-host.md`).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectTerminalHost, type TerminalHostClient } from '../host/client.js';
import { minimalHostEnv, readHostPidRecord, recordedHostProtocols, resolveHostPaths } from '../host/launch.js';
import { HOST_PROTOCOL_VERSION } from '../host/protocol.js';
import { HOST_BUNDLE_NAME } from '../host/runtime.js';
import { buildHostBundle } from '../host/testing.js';
import { requestControl } from '../control/probe.js';
import { ensureToken, isProcessAlive, spawnDetached } from '../lifecycle/index.js';
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
        // Never leave a host (and its shells) behind a failed test, whatever its generation.
        const runDir = path.join(root, 'run');
        for (const protocol of recordedHostProtocols(runDir)) {
            const pid = readHostPidRecord(resolveHostPaths(runDir, protocol))?.pid;
            if (pid !== undefined && isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
        }
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

    it('closes a pane whose shell exited while no daemon ran, instead of resurrecting it', async () => {
        const paths = scratch();
        const hostDir = await buildHostBundle();
        const first = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await first.start();
        await first.restored;
        const doomed = firstShellPane(first);
        const doomedPid = await until(() => first.pty.pid(doomed));
        await first.handoff();
        process.kill(doomedPid, 'SIGKILL'); // exits in the gap, with no daemon to see it
        await sleep(300);

        const second = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await second.start();
        await second.restored;
        const panes = second.store.getState().workspaces.flatMap((workspace) => workspace.panes.map((pane) => pane.id));
        expect(panes).not.toContain(doomed);
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

/**
 * A host of an older generation, as a machine has one after an update (§11): launched from a
 * bundle built as `protocol`, holding one shell per key, with no daemon attached. What it was
 * started by does not matter to the daemon that finds it; this stands in for the last one.
 */
async function olderHost(paths: Scratch, keys: readonly string[], protocol = 1): Promise<{ pid: number; shells: Map<string, number> }> {
    const bundle = await buildHostBundle({ protocol });
    const hostPaths = resolveHostPaths(paths.runDir, protocol);
    fs.mkdirSync(paths.runDir, { recursive: true });
    const token = ensureToken(hostPaths);
    spawnDetached(path.join(bundle, HOST_BUNDLE_NAME), ['--run-dir', paths.runDir], { env: minimalHostEnv(process.env), cwd: '/' });
    const client = await until(async (): Promise<TerminalHostClient | undefined> => {
        try {
            return await connectTerminalHost({ socketPath: hostPaths.socket, token, protocol, timeoutMs: 300 });
        } catch {
            return undefined;
        }
    });
    const shells = new Map<string, number>();
    for (const key of keys) {
        const handle = client.spawn(
            {
                file: '/bin/sh',
                args: [],
                cwd: path.join(paths.root, 'home'),
                env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', PS1: '$ ' },
                cols: 80,
                rows: 24,
                name: 'xterm-256color'
            },
            key
        );
        shells.set(key, await until(() => handle.pid || undefined));
    }
    await client.hold();
    await client.detach();
    return { pid: readHostPidRecord(hostPaths)!.pid, shells };
}

/** The panes a first boot made, saved by a full stop: the state an older host's shells belong to. */
async function savedPanes(paths: Scratch, setup: (daemon: Daemon, paneID: string) => void = () => undefined): Promise<string> {
    const first = daemonFor(paths, { terminalHost: { daemonDir: await buildHostBundle() }, onLog: () => undefined });
    await first.start();
    await first.restored;
    const paneID = firstShellPane(first);
    await until(() => first.pty.pid(paneID));
    setup(first, paneID);
    await first.stop();
    return paneID;
}

const currentHostPid = (paths: Scratch): number | undefined => readHostPidRecord(resolveHostPaths(paths.runDir))?.pid;

/**
 * A daemon whose panes resolve `claude` to a stub that says how it was started and where, so a
 * typed resume can be counted and never starts the real one.
 */
function resumingDaemon(paths: Scratch, hostDir: string): Daemon {
    const helpers = path.join(paths.root, 'helpers');
    fs.mkdirSync(helpers, { recursive: true });
    fs.writeFileSync(path.join(helpers, 'claude'), '#!/bin/sh\necho "STUB-CLAUDE $* in $(pwd)"\n', { mode: 0o755 });
    return daemonFor(paths, {
        env: { KELPID_LOGIN_SHELL: '0' },
        terminalHost: { daemonDir: hostDir },
        spawn: { cols: 80, rows: 24, shell: '/bin/sh', helpersDir: helpers, inheritedPath: '/usr/bin:/bin' },
        onLog: () => undefined
    });
}

const SESSION = 'b3c1a2d4-0000-4000-8000-000000000002';

describe('a daemon with an older terminal host (#372)', () => {
    it('drains it: keeps its shells across handoffs, starts new ones on the current host, and retires it when they end', async () => {
        const paths = scratch();
        const hostDir = await buildHostBundle();
        const paneID = await savedPanes(paths);
        const old = await olderHost(paths, [paneID]);
        const oldShell = old.shells.get(paneID)!;

        const second = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await second.start();
        await second.restored;
        expect(second.pty.pid(paneID)).toBe(oldShell);
        expect(parentOf(oldShell)).toBe(old.pid);
        expect(second.oldTerminalHosts()).toMatchObject([{ pid: old.pid, protocol: 1, paneIDs: [paneID] }]);

        // A new pane starts on the current host, never on the old one.
        const split = await requestControl({ socketPath: second.info!.runSocketPath }, { command: 'pane-split', target: paneID });
        const newPane = split?.['pane_id'] as string;
        const newShell = await until(() => second.pty.pid(newPane));
        expect(parentOf(newShell)).toBe(currentHostPid(paths));
        expect(second.oldTerminalHosts()[0]?.paneIDs).toEqual([paneID]);

        // `ping` says so, for `kelpid status`.
        const ping = await requestControl({ socketPath: second.info!.runSocketPath }, { command: 'ping' });
        expect(ping?.['terminal_hosts']).toMatchObject({
            current: { protocol: HOST_PROTOCOL_VERSION },
            old: [{ pid: old.pid, protocol: 1, pane_ids: [paneID] }]
        });

        // The next daemon drains it too, with the same shells.
        expect(await second.handoff()).toBe('handed-off');
        const third = daemonFor(paths, { terminalHost: { daemonDir: hostDir }, onLog: () => undefined });
        await third.start();
        await third.restored;
        expect(third.pty.pid(paneID)).toBe(oldShell);
        expect(third.pty.pid(newPane)).toBe(newShell);
        expect(third.oldTerminalHosts().map((host) => host.pid)).toEqual([old.pid]);

        // Its last terminal ends: the old host goes, and nothing is left draining.
        third.pty.write(paneID, 'exit\n');
        await until(() => !isProcessAlive(old.pid) || undefined, 8000);
        expect(third.oldTerminalHosts()).toEqual([]);
        expect(third.pty.pid(newPane)).toBe(newShell);
    }, 45_000);

    it('restarts its terminals on the current host: same pane, its live directory, its agent resumed', async () => {
        const paths = scratch();
        const hostDir = await buildHostBundle();
        const paneID = await savedPanes(paths, (daemon, pane) => {
            daemon.store.dispatch({
                type: 'pane-agent-event',
                paneID: pane,
                event: { type: 'sessionStarted', sessionID: SESSION, agent: 'claude' },
                now: Date.now()
            });
            daemon.store.dispatch({ type: 'pane-agent-event', paneID: pane, event: { type: 'agentStarted', agent: 'claude' }, now: Date.now() });
        });
        const old = await olderHost(paths, [paneID]);
        const elsewhere = fs.mkdtempSync(path.join(paths.root, 'moved-'));

        const second = resumingDaemon(paths, hostDir);
        await second.start();
        await second.restored;
        expect(second.pty.pid(paneID)).toBe(old.shells.get(paneID));
        expect(second.oldTerminalHosts()).toMatchObject([{ agents: 1, busyAgents: 1 }]);
        // The shell moved since its pane last reported a directory: the restart follows it.
        second.pty.write(paneID, `cd ${elsewhere}\n`);
        await sleep(300);

        expect(await second.restartOldTerminals()).toEqual({ panes: 1, resumed: 1 });
        expect(isProcessAlive(old.pid)).toBe(false);
        expect(second.oldTerminalHosts()).toEqual([]);
        const newShell = await until(() => second.pty.pid(paneID));
        expect(newShell).not.toBe(old.shells.get(paneID));
        expect(parentOf(newShell)).toBe(currentHostPid(paths));
        const pane = second.store.getState().workspaces[0]?.panes.find((candidate) => candidate.id === paneID);
        expect(pane?.agentSessionID).toBe(SESSION);
        expect(pane?.status).toBe('idle');
        // The resume ran, once, in the directory the old shell had moved to.
        const ran = await until(async () => {
            const text = await second.term.captureAsync(paneID, { scrollback: true });
            return /STUB-CLAUDE --resume \S+ in \S+/.exec(text)?.[0];
        });
        expect(ran).toContain(`--resume ${SESSION} in`);
        expect(ran).toContain(path.basename(elsewhere));
        // Nothing left to restart.
        expect(await second.restartOldTerminals()).toEqual({ panes: 0, resumed: 0 });
    }, 45_000);

    it('lets a handoff that arrives mid-restart wait for it: the successor gets the fresh shell, its resume typed once', async () => {
        const paths = scratch();
        const hostDir = await buildHostBundle();
        const paneID = await savedPanes(paths, (daemon, pane) => {
            daemon.store.dispatch({
                type: 'pane-agent-event',
                paneID: pane,
                event: { type: 'sessionStarted', sessionID: SESSION, agent: 'claude' },
                now: Date.now()
            });
        });
        const old = await olderHost(paths, [paneID]);
        const second = resumingDaemon(paths, hostDir);
        await second.start();
        await second.restored;

        // Two requests are one restart, and the update's SIGUSR2 lands while it runs.
        const restarts = [second.restartOldTerminals(), second.restartOldTerminals()];
        const handedOff = second.handoff();
        expect(await Promise.all(restarts)).toEqual([{ panes: 1, resumed: 1 }, { panes: 1, resumed: 1 }]);
        expect(await handedOff).toBe('handed-off');
        expect(isProcessAlive(old.pid)).toBe(false);

        const third = resumingDaemon(paths, hostDir);
        await third.start();
        await third.restored;
        const shell = await until(() => third.pty.pid(paneID));
        expect(parentOf(shell)).toBe(currentHostPid(paths));
        expect(third.oldTerminalHosts()).toEqual([]);
        await until(async () => (await third.term.captureAsync(paneID, { scrollback: true })).includes('STUB-CLAUDE --resume') || undefined);
        // Adopted with its resume already run: the successor does not type it again.
        await sleep(500);
        const screen = await third.term.captureAsync(paneID, { scrollback: true });
        expect(screen.split(`STUB-CLAUDE --resume ${SESSION}`).length - 1).toBe(1);
    }, 45_000);

    it('will not restart old terminals into in-process PTYs: with no current host they stay on the old one', async () => {
        const paths = scratch();
        const paneID = await savedPanes(paths);
        const old = await olderHost(paths, [paneID]);
        const empty = path.join(paths.root, 'no-host-here');
        fs.mkdirSync(empty);
        const daemon = daemonFor(paths, { terminalHost: { daemonDir: empty }, onLog: () => undefined, onError: () => undefined });
        await daemon.start();
        await daemon.restored;
        expect(daemon.pty.pid(paneID)).toBe(old.shells.get(paneID));
        await expect(daemon.restartOldTerminals()).rejects.toThrow(/no current terminal host/);
        expect(isProcessAlive(old.pid)).toBe(true);
        expect(daemon.pty.pid(paneID)).toBe(old.shells.get(paneID));
        expect(daemon.oldTerminalHosts().map((host) => host.pid)).toEqual([old.pid]);
    }, 30_000);

    it('retires an older host with nothing of this daemon\'s on it at once', async () => {
        const paths = scratch();
        await savedPanes(paths);
        const old = await olderHost(paths, ['NO-SUCH-PANE']);
        const daemon = daemonFor(paths, { terminalHost: { daemonDir: await buildHostBundle() }, onLog: () => undefined });
        await daemon.start();
        await daemon.restored;
        await until(() => !isProcessAlive(old.pid) || undefined, 5000);
        expect(daemon.oldTerminalHosts()).toEqual([]);
    }, 30_000);

    it('respawns and resumes the panes of an older host that dies', async () => {
        const paths = scratch();
        const paneID = await savedPanes(paths);
        const old = await olderHost(paths, [paneID]);
        const daemon = daemonFor(paths, { terminalHost: { daemonDir: await buildHostBundle() }, onLog: () => undefined });
        await daemon.start();
        await daemon.restored;
        expect(daemon.pty.pid(paneID)).toBe(old.shells.get(paneID));

        process.kill(old.pid, 'SIGKILL');
        const respawned = await until(() => {
            const pid = daemon.pty.pid(paneID);
            return pid !== undefined && pid !== old.shells.get(paneID) ? pid : undefined;
        }, 8000);
        expect(parentOf(respawned)).toBe(currentHostPid(paths));
        expect(daemon.oldTerminalHosts()).toEqual([]);
    }, 30_000);

    it('ends a host of a generation it cannot drain, as before', async () => {
        const paths = scratch();
        const paneID = await savedPanes(paths);
        const newer = await olderHost(paths, [paneID], HOST_PROTOCOL_VERSION + 1);
        const daemon = daemonFor(paths, { terminalHost: { daemonDir: await buildHostBundle() }, onLog: () => undefined });
        await daemon.start();
        await daemon.restored;
        await until(() => !isProcessAlive(newer.pid) || undefined, 5000);
        expect(daemon.oldTerminalHosts()).toEqual([]);
        const shell = await until(() => daemon.pty.pid(paneID));
        expect(parentOf(shell)).toBe(currentHostPid(paths));
    }, 30_000);
});


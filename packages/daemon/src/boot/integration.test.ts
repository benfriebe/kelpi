/**
 * The daemon as a whole: a real control socket, real PTYs, a real SQLite file.
 *
 * This is the WP2.8 acceptance run — every layer composed by `boot/compose.ts` exercised the
 * way the `nex` CLI exercises it (one JSON line in, one JSON line + EOF out), including the
 * bits only composition can get wrong: `pty.onData → term.feed` (without it `pane capture`
 * returns an empty screen), the merged handler tables, the agent-event → status path, the
 * workspace-delete running-agent guard, and the shutdown flush that makes the next boot see
 * the same state.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createLineBuffer } from '@nex/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createPersistence } from '../db/index.js';
import { readPidRecord } from '../lifecycle/index.js';
import { createDaemon, type Daemon, type DaemonInfo } from './compose.js';
import { readPortFile } from './port.js';

type Reply = Record<string, unknown>;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

/** Short paths: a unix socket path is capped near 104 bytes on macOS. */
function scratch(): { root: string; runDir: string; socketPath: string; dbPath: string; home: string; configPath: string } {
    const root = fs.mkdtempSync(path.join('/tmp', 'nexd-it-'));
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

/** One request, one reply line, then EOF — exactly what the CLI does. */
function request(socketPath: string, message: Reply, timeoutMs = 10_000): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
        const socket = net.connect({ path: socketPath });
        const buffer = createLineBuffer();
        let settled = false;
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error(`timeout: ${String(message['command'])}`))), timeoutMs);
        socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
        socket.on('data', (chunk: Buffer) => {
            for (const line of buffer.push(chunk)) {
                finish(() => resolve(JSON.parse(line) as Reply));
                return;
            }
        });
        socket.on('error', (error) => finish(() => reject(error)));
        socket.on('close', () => finish(() => reject(new Error('closed without a reply'))));
    });
}

/** Fire-and-forget: write the line, let the server read it, hang up. */
function notify(socketPath: string, message: Reply): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const socket = net.connect({ path: socketPath });
        socket.on('connect', () => {
            socket.write(`${JSON.stringify(message)}\n`, () => {
                setTimeout(() => {
                    socket.end();
                    resolve();
                }, 50);
            });
        });
        socket.on('error', reject);
    });
}

async function eventually<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T = await fn();
    while (!predicate(last)) {
        if (Date.now() > deadline) return last;
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await fn();
    }
    return last;
}

async function boot(paths: ReturnType<typeof scratch>): Promise<{ daemon: Daemon; info: DaemonInfo }> {
    const daemon = createDaemon({
        env: {},
        home: paths.home,
        runDir: paths.runDir,
        controlSocketPath: paths.socketPath,
        dbPath: paths.dbPath,
        configPath: paths.configPath,
        httpPort: 0,
        settleMs: 0,
        spawn: { cols: 80, rows: 24, shell: '/bin/sh' }
    });
    cleanups.push(() => daemon.stop());
    const info = await daemon.start();
    return { daemon, info };
}

describe('nexd end to end', () => {
    it('answers the control protocol, drives real PTYs, and persists across a restart', async () => {
        const paths = scratch();
        const { daemon, info } = await boot(paths);

        // ── boot shape ──────────────────────────────────────────────────────
        expect(info.loadStatus).toBe('empty');
        expect(info.workspaces).toBe(1); // §12.2 fresh install → one "Default" workspace
        expect(info.socketPath).toBe(paths.socketPath);
        expect(fs.existsSync(paths.socketPath)).toBe(true);
        expect(readPortFile(daemon.paths)).toBe(info.httpPort);
        expect(readPidRecord(daemon.paths)?.pid).toBe(process.pid);
        expect(fs.statSync(daemon.paths.token).mode & 0o777).toBe(0o600);

        const health = (await (await fetch(`${info.url}/healthz`)).json()) as Reply;
        expect(health['ok']).toBe(true);
        expect(health['pid']).toBe(process.pid);

        // ── ping ────────────────────────────────────────────────────────────
        const ping = await request(paths.socketPath, { command: 'ping' });
        expect(ping).toMatchObject({
            ok: true,
            version: info.version.version,
            build: info.version.build,
            pid: process.pid,
            protocol: info.version.protocol
        });

        // ── workspace-create ────────────────────────────────────────────────
        const created = await request(paths.socketPath, { command: 'workspace-create', name: 'agents' });
        expect(created['ok']).toBe(true);
        const workspaceID = created['workspace_id'] as string;
        expect(workspaceID).toMatch(/^[0-9A-F-]{36}$/);

        // ── pane-create: a real shell comes up ──────────────────────────────
        const paneReply = await request(paths.socketPath, {
            command: 'pane-create',
            workspace: 'agents',
            name: 'worker-1'
        });
        expect(paneReply).toMatchObject({ ok: true, workspace_name: 'agents', label: 'worker-1' });
        const paneID = paneReply['pane_id'] as string;
        expect(daemon.pty.has(paneID)).toBe(true);

        // ── pane-send → pane-capture round trip ─────────────────────────────
        const sent = await request(paths.socketPath, {
            command: 'pane-send',
            target: paneID,
            text: 'echo hello-from-nexd'
        });
        expect(sent).toMatchObject({ ok: true, pane_id: paneID });

        const captured = await eventually(
            () => request(paths.socketPath, { command: 'pane-capture', target: paneID, scrollback: true }),
            (reply) => typeof reply['text'] === 'string' && reply['text'].includes('hello-from-nexd\n')
        );
        expect(captured['ok']).toBe(true);
        // The echoed command AND its output: proof that pty.onData reaches the VT.
        expect(captured['text']).toContain('echo hello-from-nexd');
        expect(String(captured['text'])).toMatch(/^hello-from-nexd$/m);

        // ── pane-list schema ────────────────────────────────────────────────
        const listed = await request(paths.socketPath, { command: 'pane-list', workspace: 'agents' });
        expect(listed['ok']).toBe(true);
        const panes = listed['panes'] as Reply[];
        expect(panes).toHaveLength(2); // the workspace's first pane + the one we created
        const worker = panes.find((entry) => entry['id'] === paneID);
        expect(worker).toMatchObject({
            id: paneID,
            type: 'shell',
            workspace_id: workspaceID,
            workspace_name: 'agents',
            label: 'worker-1',
            status: 'idle',
            is_active_workspace: true
        });
        expect(typeof worker?.['created_at']).toBe('string');
        expect(worker?.['created_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(worker?.['working_directory']).toBe(paths.home);

        // ── agent lifecycle: start → running, stop → waiting ────────────────
        const statusOf = async (): Promise<string> => {
            const reply = await request(paths.socketPath, { command: 'pane-list', workspace: 'agents' });
            const entry = (reply['panes'] as Reply[]).find((row) => row['id'] === paneID);
            return String(entry?.['status']);
        };

        await notify(paths.socketPath, { command: 'start', pane_id: paneID });
        expect(await statusOf()).toBe('running');

        // A session id binds through the dual-fire and shows up in the listing.
        await notify(paths.socketPath, { command: 'stop', pane_id: paneID, session_id: 'sess-abc123' });
        expect(await statusOf()).toBe('waitingForInput');
        const afterStop = await request(paths.socketPath, { command: 'pane-list', workspace: 'agents' });
        expect(
            (afterStop['panes'] as Reply[]).find((row) => row['id'] === paneID)?.['agent_session_id']
        ).toBe('sess-abc123');

        // ── workspace-delete guard, then --force ────────────────────────────
        const refused = await request(paths.socketPath, { command: 'workspace-delete', name: 'agents' });
        expect(refused['ok']).toBe(false);
        expect(String(refused['error'])).toContain('running agent');
        expect(refused['active_agents']).toBe(1);
        expect(daemon.store.getState().workspaces).toHaveLength(2);

        // Something to find again after the restart.
        expect(
            (await request(paths.socketPath, { command: 'workspace-create', name: 'keeper' }))['ok']
        ).toBe(true);
        expect(
            (
                await request(paths.socketPath, {
                    command: 'workspace-label',
                    name: 'keeper',
                    label_op: 'add',
                    label_values: ['ship-it']
                })
            )['ok']
        ).toBe(true);

        const forced = await request(paths.socketPath, {
            command: 'workspace-delete',
            name: 'agents',
            force: true
        });
        expect(forced).toMatchObject({ ok: true, workspace_id: workspaceID, workspace_name: 'agents' });
        expect(forced['path']).toBe(paths.home);
        expect(daemon.pty.has(paneID)).toBe(false);

        // ── clean shutdown flushes, and the next boot sees the same state ────
        await daemon.restored;
        await daemon.stop();
        expect(fs.existsSync(paths.socketPath)).toBe(false);
        expect(fs.existsSync(daemon.paths.pid)).toBe(false);

        const reopened = createPersistence({ path: paths.dbPath });
        const snapshot = reopened.load();
        reopened.close();
        expect(snapshot?.workspaces.map((workspace) => workspace.name)).toEqual(['Default', 'keeper']);
        expect(snapshot?.workspaces.find((workspace) => workspace.name === 'keeper')?.labels).toEqual(['ship-it']);

        // A second daemon on the same DB restores it rather than starting fresh.
        const second = await boot(paths);
        expect(second.info.loadStatus).toBe('ok');
        expect(second.info.workspaces).toBe(2);
        expect(
            (await request(paths.socketPath, { command: 'workspace-list' }))['workspaces']
        ).toHaveLength(2);
        await second.daemon.stop();
    }, 60_000);

    it('rejects an unknown allowlisted command instead of hanging the caller', async () => {
        const paths = scratch();
        await boot(paths);
        // `graft-status` is allowlisted and stubbed: an honest failure, never a read timeout.
        const reply = await request(paths.socketPath, { command: 'graft-status' });
        expect(reply).toEqual({ ok: false, error: 'not supported yet' });
    }, 30_000);
});

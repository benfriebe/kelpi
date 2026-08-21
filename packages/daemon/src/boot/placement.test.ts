/**
 * §WS-104 — `newWorkspacePlacement` end to end, through the composition that carries it.
 *
 * Both branches of the placement rule were written and unit-tested at the reducer
 * (`store/workspaces.test.ts`), and that is exactly the state the capability sweep called
 * partial: "both branches are implemented and tested … nothing sets it". The value travels
 * config file → settings service → `compose.ts`'s `placement: () => settings.snapshot.general
 * .newWorkspacePlacement` → `deps.placement` → `create-workspace`, and no test crossed that
 * whole distance. This one does, with a real daemon, a real config file and a real socket.
 *
 * The discriminator has to be built rather than assumed: creating workspaces back to back puts
 * each one after the previously-active one, which is *also* the end of the list. So the run
 * moves a workspace to the head first — now "after the active workspace's slot" and "the end
 * of the list" are different places, and the two settings disagree visibly.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { createLineBuffer } from '@nex/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { harness, id, NOW } from '../handlers/app/testing.js';
import { createDaemon, type Daemon } from './compose.js';

type Reply = Record<string, unknown>;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

function scratch(config: string | null): {
    runDir: string;
    socketPath: string;
    dbPath: string;
    home: string;
    configPath: string;
} {
    const root = fs.mkdtempSync(path.join('/tmp', 'nexd-place-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const configPath = path.join(root, 'config');
    if (config !== null) fs.writeFileSync(configPath, config);
    return {
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'nex.sock'),
        dbPath: path.join(root, 'nex.db'),
        home,
        configPath
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
        const timer = setTimeout(
            () => finish(() => reject(new Error(`timeout: ${String(message['command'])}`))),
            timeoutMs
        );
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

/** Fire-and-forget (`workspace-move` is one): write the line, let the server read it, hang up. */
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

async function boot(config: string | null): Promise<{ socketPath: string }> {
    const paths = scratch(config);
    const daemon: Daemon = createDaemon({
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
    await daemon.start();
    return { socketPath: paths.socketPath };
}

/** Sidebar order, by name — what `nex workspace list` prints. */
async function order(socketPath: string): Promise<string[]> {
    const reply = await request(socketPath, { command: 'workspace-list' });
    const workspaces = reply['workspaces'] as { name: string }[];
    return workspaces.map((workspace) => workspace.name);
}

/**
 * Default · alpha · beta, then beta dragged to the head. The next create is the test: it lands
 * after beta under `near-selection` (beta is the active workspace) and at the tail under
 * `end-of-list`.
 */
async function seed(socketPath: string): Promise<void> {
    await request(socketPath, { command: 'workspace-create', name: 'alpha' });
    await request(socketPath, { command: 'workspace-create', name: 'beta' });
    await notify(socketPath, { command: 'workspace-move', name: 'beta', index: 0 });
}

describe('§WS-104 new-workspace placement, config to sidebar', () => {
    it('inserts after the active workspace’s slot with `new-workspace-placement = near-selection`', async () => {
        const { socketPath } = await boot('new-workspace-placement = near-selection\n');
        await seed(socketPath);
        expect(await order(socketPath)).toEqual(['beta', 'Default', 'alpha']);

        await request(socketPath, { command: 'workspace-create', name: 'gamma' });
        expect(await order(socketPath)).toEqual(['beta', 'gamma', 'Default', 'alpha']);
    }, 30_000);

    it('appends with the shipped default (no key in the config at all)', async () => {
        const { socketPath } = await boot(null);
        await seed(socketPath);
        expect(await order(socketPath)).toEqual(['beta', 'Default', 'alpha']);

        await request(socketPath, { command: 'workspace-create', name: 'gamma' });
        expect(await order(socketPath)).toEqual(['beta', 'Default', 'alpha', 'gamma']);
    }, 30_000);

    it('appends with an explicit `end-of-list` in the config', async () => {
        const { socketPath } = await boot('new-workspace-placement = end-of-list\n');
        await seed(socketPath);
        await request(socketPath, { command: 'workspace-create', name: 'gamma' });
        expect(await order(socketPath)).toEqual(['beta', 'Default', 'alpha', 'gamma']);
    }, 30_000);

    /**
     * The last link, isolated: `compose.ts` passes placement as a FUNCTION, and
     * `resolveAppDeps` turns it into a getter, so a change made in Settings takes effect on the
     * very next `workspace create` without rebuilding the handler table or restarting anything.
     * The daemon boots its settings service off a file, so the flip is modelled here at the
     * seam the file feeds.
     */
    it('re-reads the setting on every create, so a Settings change needs no restart', () => {
        let placement: 'end-of-list' | 'near-selection' = 'end-of-list';
        const h = harness({ placement: () => placement });
        h.dispatch({ type: 'create-workspace', id: id('aaaaaaaa', 1), paneID: id('dddddddd', 1), name: 'alpha', now: NOW });
        h.dispatch({ type: 'create-workspace', id: id('aaaaaaaa', 2), paneID: id('dddddddd', 2), name: 'beta', now: NOW });
        h.dispatch({ type: 'set-active-workspace', id: id('aaaaaaaa', 1), now: NOW });

        h.reply({ command: 'workspace-create', name: 'end' });
        expect(h.state().topLevelOrder.map((entry) => entry.id).slice(-1)[0]).toBe(
            h.state().workspaces.find((workspace) => workspace.name === 'end')?.id
        );

        // A create makes ITSELF active, so the anchor is re-selected before the next one —
        // otherwise "after the active workspace" and "the tail" are the same slot again.
        placement = 'near-selection';
        h.dispatch({ type: 'set-active-workspace', id: id('aaaaaaaa', 1), now: NOW });
        h.reply({ command: 'workspace-create', name: 'near' });
        const near = h.state().workspaces.find((workspace) => workspace.name === 'near')?.id;
        const order = h.state().topLevelOrder.map((entry) => entry.id);
        // Straight after alpha — the workspace that was active when the create landed.
        expect(order.indexOf(near ?? '')).toBe(order.indexOf(id('aaaaaaaa', 1)) + 1);
    });
});

/**
 * M5 end to end: a real daemon (private paths — never `/tmp/nex.sock`), the real `open` / `diff`
 * wire commands, a real WebSocket client speaking the `content-*` verbs, the real HTTP asset
 * route, and the shutdown flush landing an unsaved scratchpad in SQLite.
 *
 * What only this level can catch: `boot/compose.ts` forgetting to hand the content service to
 * the WS server (subscribe would answer "not available"), the asset route not being registered
 * before the static catch-all (an image would 200 with index.html), and the editor flush
 * running AFTER the persist gate closes (a scratchpad's last keystrokes would vanish).
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { WS_PROTOCOL_VERSION } from '@nex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createDaemon, type Daemon, type DaemonInfo } from '../boot/compose.js';
import { createPersistence } from '../db/index.js';
import type { ContentPaneState } from './service.js';

type Json = Record<string, unknown>;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

interface Scratch {
    readonly root: string;
    readonly runDir: string;
    readonly socketPath: string;
    readonly dbPath: string;
    readonly home: string;
    readonly configPath: string;
    readonly notes: string;
}

/** Short paths: a unix socket path is capped near 104 bytes on macOS. */
function scratch(): Scratch {
    const root = fs.mkdtempSync(path.join('/tmp', 'nexd-m5-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const notes = path.join(root, 'notes');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(notes, { recursive: true });
    return {
        root,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'nex.sock'),
        dbPath: path.join(root, 'nex.db'),
        home,
        configPath: path.join(root, 'config'),
        notes
    };
}

async function boot(paths: Scratch): Promise<{ daemon: Daemon; info: DaemonInfo }> {
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
    await daemon.restored;
    return { daemon, info };
}

/** Fire-and-forget control line (what `nex open` / `nex diff` send). */
function notify(socketPath: string, message: Json): Promise<void> {
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

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T, ok: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = read();
    while (!ok(last)) {
        if (Date.now() > deadline) return last;
        await tick(25);
        last = read();
    }
    return last;
}

interface Client {
    readonly messages: Json[];
    command(id: string, payload: Json): void;
    ofType(type: string): Json[];
    reply(id: string): Json | undefined;
    close(): void;
}

async function connect(info: DaemonInfo): Promise<Client> {
    const socket = new WebSocket(`${info.url}/ws?token=${encodeURIComponent(info.token)}`);
    const messages: Json[] = [];
    socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        messages.push(JSON.parse(data.toString('utf8')) as Json);
    });
    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });
    cleanups.push(() => socket.close());
    socket.send(
        JSON.stringify({
            type: 'hello',
            protocolVersion: WS_PROTOCOL_VERSION,
            token: info.token,
            client: { kind: 'browser', name: 'm5-test' }
        })
    );
    await waitFor(
        () => messages.some((message) => message['type'] === 'snapshot'),
        (found) => found
    );
    return {
        messages,
        command(id, payload) {
            socket.send(JSON.stringify({ type: 'command', id, payload }));
        },
        ofType(type) {
            return messages.filter((message) => message['type'] === type);
        },
        reply(id) {
            const message = messages.find(
                (entry) => entry['type'] === 'command-reply' && entry['id'] === id
            );
            return message?.['reply'] as Json | undefined;
        },
        close() {
            socket.close();
        }
    };
}

function paneOfType(daemon: Daemon, type: string): string | undefined {
    for (const workspace of daemon.store.getState().workspaces) {
        for (const pane of workspace.panes) {
            if (pane.type === type) return pane.id;
        }
    }
    return undefined;
}

describe('content panes end to end', () => {
    it('serves rendered markdown over WS and its sibling assets over HTTP', async () => {
        const paths = scratch();
        const file = path.join(paths.notes, 'note.md');
        fs.writeFileSync(file, '# Hello\n\n![pic](pic.png)\n');
        fs.writeFileSync(path.join(paths.notes, 'pic.png'), 'PNGDATA');
        fs.writeFileSync(path.join(paths.root, 'outside.txt'), 'SECRET');

        const { daemon, info } = await boot(paths);

        // The real `nex md note.md` wire command.
        await notify(paths.socketPath, { command: 'open', path: file });
        const paneID = (await waitFor(
            () => paneOfType(daemon, 'markdown'),
            (found) => found !== undefined
        )) as string;
        expect(paneID).toBeDefined();

        const client = await connect(info);
        client.command('s1', { command: 'content-subscribe', pane_id: paneID });
        const reply = (await waitFor(
            () => client.reply('s1'),
            (value) => value !== undefined
        )) as Json;
        expect(reply['ok']).toBe(true);
        const state = reply['state'] as ContentPaneState;
        expect(state.type).toBe('markdown');
        expect(state.html).toContain('<h1>Hello</h1>');
        expect(state.html).toContain(`<base href="/pane-assets/${paneID}/">`);

        // The asset route the <base href> points at.
        const asset = await fetch(`${info.url}/pane-assets/${paneID}/pic.png`);
        expect(asset.status).toBe(200);
        expect(await asset.text()).toBe('PNGDATA');

        // …and it refuses to leave the file's directory.
        const escape = await fetch(`${info.url}/pane-assets/${paneID}/%2e%2e%2foutside.txt`);
        expect(escape.status).toBe(404);
        const unknown = await fetch(`${info.url}/pane-assets/${paneID}/nope.png`);
        expect(unknown.status).toBe(404);

        // A write on disk reaches the subscribed client as content-updated.
        await tick(80);
        fs.writeFileSync(file, '# Changed\n');
        const updates = await waitFor(
            () => client.ofType('content-updated'),
            (found) => found.length > 0
        );
        expect(updates.length).toBeGreaterThan(0);
        expect((updates.at(-1)?.['state'] as ContentPaneState).html).toContain('<h1>Changed</h1>');
        client.close();
    }, 30_000);

    it('renders a diff pane opened by the `diff` wire command', async () => {
        const paths = scratch();
        const { daemon, info } = await boot(paths);

        await notify(paths.socketPath, { command: 'diff', repo_path: paths.notes });
        const paneID = (await waitFor(
            () => paneOfType(daemon, 'diff'),
            (found) => found !== undefined
        )) as string;

        const client = await connect(info);
        client.command('d1', { command: 'content-subscribe', pane_id: paneID });
        const reply = (await waitFor(
            () => client.reply('d1'),
            (value) => value !== undefined
        )) as Json;
        expect(reply['ok']).toBe(true);
        const state = reply['state'] as ContentPaneState;
        expect(state.type).toBe('diff');
        // Not a git repo → the failure renders through the diff renderer, not as an error page.
        expect(state.html).toContain('class="diff"');
        expect(state.html?.includes('Failed to run git diff') || state.html?.includes('No changes')).toBe(
            true
        );

        client.command('d2', { command: 'diff-refresh', pane_id: paneID });
        const refreshed = (await waitFor(
            () => client.reply('d2'),
            (value) => value !== undefined
        )) as Json;
        expect(refreshed['ok']).toBe(true);
        client.close();
    }, 30_000);

    it('flushes an unsaved markdown buffer and an unsaved scratchpad at shutdown', async () => {
        const paths = scratch();
        const file = path.join(paths.notes, 'note.md');
        fs.writeFileSync(file, 'original\n');
        const { daemon, info } = await boot(paths);

        await notify(paths.socketPath, { command: 'open', path: file });
        const markdownID = (await waitFor(
            () => paneOfType(daemon, 'markdown'),
            (found) => found !== undefined
        )) as string;

        // Scratchpads have no wire command (⌘⇧N only), so the client action is the store action.
        const workspaceID = daemon.store.getState().workspaces[0]?.id as string;
        const scratchpadID = '9E1C2C2E-0000-4000-8000-00000000AAAA';
        daemon.store.dispatch({
            type: 'create-scratchpad',
            workspaceID,
            paneID: scratchpadID,
            now: Date.now()
        });

        const client = await connect(info);
        client.command('e1', { command: 'markdown-set-mode', pane_id: markdownID, mode: 'edit' });
        await waitFor(
            () => client.reply('e1'),
            (value) => value !== undefined
        );
        client.command('e2', {
            command: 'content-set-text',
            pane_id: markdownID,
            text: 'typed but not saved\n'
        });
        client.command('e3', {
            command: 'content-set-text',
            pane_id: scratchpadID,
            text: 'scratch text'
        });
        await waitFor(
            () => client.reply('e3'),
            (value) => value !== undefined
        );
        client.close();

        // Kill the daemon well inside the 500 ms autosave debounce.
        await daemon.stop();

        expect(fs.readFileSync(file, 'utf8')).toBe('typed but not saved\n');

        // …and the scratchpad's text made it into SQLite, not just into memory.
        const persistence = createPersistence({ path: paths.dbPath });
        const snapshot = persistence.load();
        persistence.close();
        const panes = snapshot?.workspaces.flatMap((workspace) => workspace.panes) ?? [];
        const scratchpad = panes.find((pane) => pane.id === scratchpadID);
        expect(scratchpad?.scratchpadContent).toBe('scratch text');
    }, 30_000);
});

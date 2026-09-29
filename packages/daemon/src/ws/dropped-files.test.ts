/**
 * #288: the dropped-file path round trip through the real `SyncHub`.
 *
 * The same relay as #283's folder panel (`choose-folder.test.ts` covers the shared rules in
 * depth): the client's `shell-action` `resolve-dropped-files` is broadcast to the shells, and the
 * shell's `dropped-files-answer` goes back to the ONE session that asked, only while it waits,
 * only from the named window's own shell, and only when that shell declared the drop capability.
 * What this file adds is what differs: the answer's shape and its normalisation, the per-action
 * capability, the short timeout, and that the two kinds of answer can never settle each other.
 */

import {
    CHOOSE_FOLDER_CAPABILITY,
    DROPPED_FILES_TIMEOUT_MS,
    MAX_DROPPED_FILES,
    RESOLVE_DROPPED_FILES_CAPABILITY,
    WS_CHOOSE_FOLDER_ANSWER_MESSAGE,
    WS_CHOOSE_FOLDER_RESULT_MESSAGE,
    WS_DROPPED_FILES_ANSWER_MESSAGE,
    WS_DROPPED_FILES_RESULT_MESSAGE,
    WS_PROTOCOL_VERSION
} from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import { harness, type Harness } from '../handlers/pane/testing.js';
import { DEVICE_TOKEN_PREFIX } from '../lifecycle/devices.js';
import type { ControlDispatcher } from '../seams.js';
import { createDesktopChannel, SHELL_ACTION_EVENT } from './desktop.js';
import { createSyncHub, type SyncSession } from './sync.js';
import { recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };
const DEVICE_TOKEN = `${DEVICE_TOKEN_PREFIX}paired-phone`;
const BOTH = [CHOOSE_FOLDER_CAPABILITY, RESOLVE_DROPPED_FILES_CAPABILITY];

interface Peer {
    readonly session: SyncSession;
    readonly transport: RecordedTransport;
}

interface ClientOptions {
    readonly kind?: 'browser' | 'electron';
    readonly token?: string;
    readonly windowID?: string;
    readonly capabilities?: readonly string[];
}

interface Fixture {
    readonly h: Harness;
    advance(ms: number): void;
    connect(options?: ClientOptions): Peer;
    /** A current shell's status connection: it declares both answered capabilities. */
    shell(windowID?: string, capabilities?: readonly string[]): Peer;
}

function fixture(): Fixture {
    const h = harness();
    let clock = 1_000_000;
    const dispatcher: ControlDispatcher = (_message, reply) => {
        reply?.send({ ok: true });
        reply?.close();
    };
    const hub = createSyncHub({
        store: h.store,
        dispatcher,
        daemon: DAEMON,
        now: () => clock,
        validateToken: () => true,
        desktop: createDesktopChannel({ ctx: h.ctx })
    });
    const connect = (client: ClientOptions = {}): Peer => {
        const kind = client.kind ?? 'browser';
        const transport = recordingTransport();
        const session = hub.createSession(transport);
        session.handleMessage(
            JSON.stringify({
                type: 'hello',
                protocolVersion: WS_PROTOCOL_VERSION,
                token: client.token ?? 'owner-token',
                client: {
                    kind,
                    name: kind === 'electron' ? 'kelpi-shell' : 'kelpi-web',
                    ...(client.windowID === undefined ? {} : { windowID: client.windowID }),
                    ...(client.capabilities === undefined ? {} : { capabilities: [...client.capabilities] })
                }
            })
        );
        return { session, transport };
    };
    return {
        h,
        advance(ms) {
            clock += ms;
        },
        connect,
        shell: (windowID = 'WIN-1', capabilities = BOTH) => connect({ kind: 'electron', windowID, capabilities })
    };
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

let commandCounter = 0;

async function ask(
    peer: Peer,
    action: 'resolve-dropped-files' | 'choose-folder-dialog',
    fields: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
    commandCounter += 1;
    const id = `c${String(commandCounter)}`;
    peer.session.handleMessage(JSON.stringify({ type: 'command', id, payload: { command: 'shell-action', action, ...fields } }));
    await settle();
    const reply = peer.transport.ofType('command-reply').find((message) => message['id'] === id);
    return reply?.['reply'] as Record<string, unknown> | undefined;
}

const askDrop = (peer: Peer, fields: Record<string, unknown>) => ask(peer, 'resolve-dropped-files', fields);

function answer(peer: Peer, fields: Record<string, unknown>): void {
    peer.session.handleMessage(JSON.stringify({ type: WS_DROPPED_FILES_ANSWER_MESSAGE, ...fields }));
}

const results = (peer: Peer): Record<string, unknown>[] => peer.transport.ofType(WS_DROPPED_FILES_RESULT_MESSAGE);

describe('dropped-files round trip (#288)', () => {
    it('broadcasts the request and routes the paths to the asker alone', async () => {
        const f = fixture();
        const shell = f.shell();
        const asker = f.connect();
        const bystander = f.connect();

        expect(await askDrop(asker, { request_id: 'D1', window_id: 'WIN-1' })).toMatchObject({ ok: true, request_id: 'D1' });
        expect(f.h.broadcasts).toContainEqual({
            type: SHELL_ACTION_EVENT,
            action: 'resolve-dropped-files',
            windowID: 'WIN-1',
            requestID: 'D1'
        });

        answer(shell, { requestID: 'D1', windowID: 'WIN-1', paths: ['/Users/me/a b.png', '/tmp/c'], unresolved: 1 });
        expect(results(asker)).toEqual([
            {
                type: WS_DROPPED_FILES_RESULT_MESSAGE,
                requestID: 'D1',
                paths: ['/Users/me/a b.png', '/tmp/c'],
                unresolved: 1,
                windowID: 'WIN-1'
            }
        ]);
        expect(results(bystander)).toEqual([]);
        expect(results(shell)).toEqual([]);
    });

    it('relays only absolute paths, at most MAX_DROPPED_FILES, counting what it drops, and a malformed answer as an empty one', async () => {
        const f = fixture();
        const shell = f.shell();
        const asker = f.connect();
        await askDrop(asker, { request_id: 'D1', window_id: 'WIN-1' });
        await askDrop(asker, { request_id: 'D2', window_id: 'WIN-1' });
        await askDrop(asker, { request_id: 'D3', window_id: 'WIN-1' });

        // The page types whatever arrives, so a relative path, an empty one or a non-string never
        // reaches it, and a nonsense count reads as none.
        answer(shell, { requestID: 'D1', windowID: 'WIN-1', paths: ['/ok', 'relative', '', 7, null, '/x'.repeat(3000)], unresolved: -3 });
        answer(shell, { requestID: 'D2', windowID: 'WIN-1', paths: 'not-a-list', unresolved: 'two' });
        const many = Array.from({ length: MAX_DROPPED_FILES + 5 }, (_value, index) => `/f${String(index)}`);
        answer(shell, { requestID: 'D3', windowID: 'WIN-1', paths: many, unresolved: 0 });

        const byID = new Map(results(asker).map((message) => [message['requestID'], message]));
        // Five entries dropped, and a nonsense count of its own: the page hears "5 left out".
        expect(byID.get('D1')).toMatchObject({ paths: ['/ok'], unresolved: 5 });
        expect(byID.get('D2')).toMatchObject({ paths: [], unresolved: 0 });
        expect(byID.get('D3')?.['paths']).toEqual(many.slice(0, MAX_DROPPED_FILES));
        // Cut by the cap is left out too, and counted as such rather than vanishing.
        expect(byID.get('D3')?.['unresolved']).toBe(5);
    });

    it('carries the shell’s reason when it could read nothing', async () => {
        const f = fixture();
        const shell = f.shell();
        const asker = f.connect();
        await askDrop(asker, { request_id: 'D1', window_id: 'WIN-1' });
        answer(shell, { requestID: 'D1', windowID: 'WIN-1', paths: [], unresolved: 0, error: 'the debugger would not attach' });
        expect(results(asker)).toEqual([
            {
                type: WS_DROPPED_FILES_RESULT_MESSAGE,
                requestID: 'D1',
                paths: [],
                unresolved: 0,
                error: 'the debugger would not attach',
                windowID: 'WIN-1'
            }
        ]);
    });

    it('never lets a folder answer settle a drop, or a drop answer settle a folder panel', async () => {
        const f = fixture();
        const shell = f.shell();
        const asker = f.connect();
        await askDrop(asker, { request_id: 'D1', window_id: 'WIN-1' });
        await ask(asker, 'choose-folder-dialog', { request_id: 'F1', window_id: 'WIN-1' });

        shell.session.handleMessage(JSON.stringify({ type: WS_CHOOSE_FOLDER_ANSWER_MESSAGE, requestID: 'D1', windowID: 'WIN-1', path: '/x' }));
        answer(shell, { requestID: 'F1', windowID: 'WIN-1', paths: ['/y'], unresolved: 0 });
        expect(results(asker)).toEqual([]);
        expect(asker.transport.ofType(WS_CHOOSE_FOLDER_RESULT_MESSAGE)).toEqual([]);

        // Both are still pending, and each takes its own kind of answer.
        answer(shell, { requestID: 'D1', windowID: 'WIN-1', paths: ['/z'], unresolved: 0 });
        expect(results(asker).map((message) => message['paths'])).toEqual([['/z']]);
    });
});

describe('who may ask and who may answer a drop (#288)', () => {
    it('refuses at once when the window’s shell predates #288 (folder capability only)', async () => {
        const f = fixture();
        f.shell('WIN-1', [CHOOSE_FOLDER_CAPABILITY]);
        const asker = f.connect();
        const reply = await askDrop(asker, { request_id: 'D1', window_id: 'WIN-1' });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply?.['error'])).toContain("dropped file's path");
        expect(f.h.broadcasts).toEqual([]);
        // The same shell still answers the folder panel it does know.
        expect(await ask(asker, 'choose-folder-dialog', { request_id: 'F1', window_id: 'WIN-1' })).toMatchObject({ ok: true });
    });

    it('refuses a browser with no desktop window, and a paired device', async () => {
        const f = fixture();
        const browser = f.connect();
        expect(await askDrop(browser, { request_id: 'D1', window_id: 'WIN-1' })).toMatchObject({ ok: false });
        f.shell();
        const phone = f.connect({ token: DEVICE_TOKEN });
        const reply = await askDrop(phone, { request_id: 'D2', window_id: 'WIN-1' });
        expect(String(reply?.['error'])).toContain('owner-only');
        expect(f.h.broadcasts).toEqual([]);
    });

    it('drops an answer from anything but the named window’s drop-capable shell', async () => {
        const f = fixture();
        const shell = f.shell('WIN-1');
        const asker = f.connect();
        const forgers = [
            f.connect(),
            f.connect({ kind: 'electron', token: DEVICE_TOKEN, windowID: 'WIN-1', capabilities: BOTH }),
            // A shell connection for the right window that did not declare the drop capability.
            f.connect({ kind: 'electron', windowID: 'WIN-1', capabilities: [CHOOSE_FOLDER_CAPABILITY] }),
            f.shell('WIN-2')
        ];
        await askDrop(asker, { request_id: 'D1', window_id: 'WIN-1' });
        for (const forger of forgers) answer(forger, { requestID: 'D1', windowID: 'WIN-1', paths: ['/forged'], unresolved: 0 });
        answer(shell, { requestID: 'D1', windowID: 'WIN-2', paths: ['/wrong-window'], unresolved: 0 });
        expect(results(asker)).toEqual([]);
        answer(shell, { requestID: 'D1', windowID: 'WIN-1', paths: ['/real'], unresolved: 0 });
        expect(results(asker).map((message) => message['paths'])).toEqual([['/real']]);
    });
});

describe('every pending drop ends (#288)', () => {
    it('answers empty, with a reason, when the shell disconnects', async () => {
        const f = fixture();
        const shell = f.shell('WIN-1');
        const asker = f.connect();
        await askDrop(asker, { request_id: 'D1', window_id: 'WIN-1' });
        shell.session.close();
        expect(results(asker)).toEqual([
            {
                type: WS_DROPPED_FILES_RESULT_MESSAGE,
                requestID: 'D1',
                paths: [],
                unresolved: 0,
                error: 'the desktop window disconnected before answering',
                windowID: 'WIN-1'
            }
        ]);
    });

    it('keeps a drop pending while another drop-capable connection of the window remains', async () => {
        const f = fixture();
        const leaving = f.shell('WIN-1');
        // A connection that can answer folders only does not keep a drop alive.
        f.shell('WIN-1', [CHOOSE_FOLDER_CAPABILITY]);
        const staying = f.shell('WIN-1');
        const asker = f.connect();
        await askDrop(asker, { request_id: 'D1', window_id: 'WIN-1' });
        leaving.session.close();
        expect(results(asker)).toEqual([]);
        answer(staying, { requestID: 'D1', windowID: 'WIN-1', paths: ['/a'], unresolved: 0 });
        expect(results(asker).map((message) => message['paths'])).toEqual([['/a']]);
    });

    it('times a drop out after seconds while a folder panel asked at the same moment stays open', async () => {
        const f = fixture();
        const shell = f.shell();
        const asker = f.connect();
        await askDrop(asker, { request_id: 'D1', window_id: 'WIN-1' });
        await ask(asker, 'choose-folder-dialog', { request_id: 'F1', window_id: 'WIN-1' });
        f.advance(DROPPED_FILES_TIMEOUT_MS + 1);
        answer(shell, { requestID: 'D1', windowID: 'WIN-1', paths: ['/late'], unresolved: 0 });
        expect(results(asker)).toEqual([
            {
                type: WS_DROPPED_FILES_RESULT_MESSAGE,
                requestID: 'D1',
                paths: [],
                unresolved: 0,
                error: 'the desktop window did not answer in time',
                windowID: 'WIN-1'
            }
        ]);
        shell.session.handleMessage(JSON.stringify({ type: WS_CHOOSE_FOLDER_ANSWER_MESSAGE, requestID: 'F1', windowID: 'WIN-1', path: '/chosen' }));
        expect(asker.transport.ofType(WS_CHOOSE_FOLDER_RESULT_MESSAGE).map((message) => message['path'])).toEqual(['/chosen']);
    });
});

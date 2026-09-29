/**
 * #283: the "choose a folder" round trip through the real `SyncHub`.
 *
 * The one desktop relay that is not a fan-out: the client's `shell-action` `choose-folder-dialog`
 * is broadcast to the shells like any other action, but the shell's `choose-folder-answer` goes
 * back to the ONE session that asked, and only while that session is still waiting for it. Driven
 * through the real hub and the real desktop channel with recording transports, so the frames
 * asserted here are the ones the page and the shell see.
 */

import {
    CHOOSE_FOLDER_TIMEOUT_MS,
    WS_CHOOSE_FOLDER_ANSWER_MESSAGE,
    WS_CHOOSE_FOLDER_RESULT_MESSAGE,
    WS_PROTOCOL_VERSION
} from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import { harness, type Harness } from '../handlers/pane/testing.js';
import type { ControlDispatcher } from '../seams.js';
import { createDesktopChannel, SHELL_ACTION_EVENT } from './desktop.js';
import { createSyncHub, MAX_PENDING_FOLDER_CHOICES, type SyncSession } from './sync.js';
import { recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };

interface Peer {
    readonly session: SyncSession;
    readonly transport: RecordedTransport;
}

interface Fixture {
    readonly h: Harness;
    /** Move the hub's clock forward. */
    advance(ms: number): void;
    connect(kind?: 'browser' | 'electron'): Peer;
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
        desktop: createDesktopChannel({ ctx: h.ctx })
    });
    return {
        h,
        advance(ms) {
            clock += ms;
        },
        connect(kind = 'browser') {
            const transport = recordingTransport();
            const session = hub.createSession(transport);
            session.handleMessage(
                JSON.stringify({
                    type: 'hello',
                    protocolVersion: WS_PROTOCOL_VERSION,
                    token: 'tok',
                    client: { kind, name: kind === 'electron' ? 'kelpi-shell' : 'kelpi-web' }
                })
            );
            return { session, transport };
        }
    };
}

/** The desktop verbs settle asynchronously; let the reply land. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

let commandCounter = 0;

async function ask(peer: Peer, fields: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    commandCounter += 1;
    const id = `c${String(commandCounter)}`;
    peer.session.handleMessage(
        JSON.stringify({ type: 'command', id, payload: { command: 'shell-action', action: 'choose-folder-dialog', ...fields } })
    );
    await settle();
    const reply = peer.transport.ofType('command-reply').find((message) => message['id'] === id);
    return reply?.['reply'] as Record<string, unknown> | undefined;
}

function answer(peer: Peer, fields: Record<string, unknown>): void {
    peer.session.handleMessage(JSON.stringify({ type: WS_CHOOSE_FOLDER_ANSWER_MESSAGE, ...fields }));
}

const results = (peer: Peer): Record<string, unknown>[] => peer.transport.ofType(WS_CHOOSE_FOLDER_RESULT_MESSAGE);

describe('choose-folder round trip (#283)', () => {
    it('broadcasts the request to the shells and routes the answer to the asker alone', async () => {
        const f = fixture();
        const shell = f.connect('electron');
        const asker = f.connect();
        const bystander = f.connect();

        const reply = await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        expect(reply).toMatchObject({ ok: true, request_id: 'R1' });
        expect(f.h.broadcasts).toContainEqual({
            type: SHELL_ACTION_EVENT,
            action: 'choose-folder-dialog',
            windowID: 'WIN-1',
            requestID: 'R1'
        });

        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/src/app' });
        expect(results(asker)).toEqual([
            { type: WS_CHOOSE_FOLDER_RESULT_MESSAGE, requestID: 'R1', path: '/src/app', windowID: 'WIN-1' }
        ]);
        // A path on this machine is nobody else's business.
        expect(results(bystander)).toEqual([]);
        expect(results(shell)).toEqual([]);
    });

    it('relays a cancel as null, and a malformed path as a cancel rather than silence', async () => {
        const f = fixture();
        const shell = f.connect('electron');
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        await ask(asker, { request_id: 'R2', window_id: 'WIN-1' });

        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: null });
        answer(shell, { requestID: 'R2', windowID: 'WIN-1', path: 42 });
        expect(results(asker).map((message) => [message['requestID'], message['path']])).toEqual([
            ['R1', null],
            ['R2', null]
        ]);
    });

    it('answers a request once: a second answer for the same id goes nowhere', async () => {
        const f = fixture();
        const shell = f.connect('electron');
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/a' });
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/b' });
        expect(results(asker).map((message) => message['path'])).toEqual(['/a']);
    });

    it('ignores an answer nobody asked for, and one with no id', () => {
        const f = fixture();
        const shell = f.connect('electron');
        const client = f.connect();
        answer(shell, { requestID: 'never-asked', windowID: 'WIN-1', path: '/a' });
        answer(shell, { windowID: 'WIN-1', path: '/a' });
        expect(results(client)).toEqual([]);
    });

    it('drops an answer from a window other than the one asked, and still takes the right one', async () => {
        const f = fixture();
        const shell = f.connect('electron');
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        answer(shell, { requestID: 'R1', windowID: 'WIN-2', path: '/wrong' });
        answer(shell, { requestID: 'R1', path: '/unaddressed' });
        expect(results(asker)).toEqual([]);
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/right' });
        expect(results(asker).map((message) => message['path'])).toEqual(['/right']);
    });

    it('forgets a request whose session closed', async () => {
        const f = fixture();
        const shell = f.connect('electron');
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        asker.session.close();
        const sentBefore = asker.transport.json.length;
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/a' });
        expect(asker.transport.json.length).toBe(sentBefore);
        // …and the id is free again: a reconnected page may mint anything, but nothing is stuck.
        const again = f.connect();
        expect(await ask(again, { request_id: 'R1', window_id: 'WIN-1' })).toMatchObject({ ok: true });
    });

    it('forgets a request after the timeout, so a lost answer cannot hold an entry forever', async () => {
        const f = fixture();
        const shell = f.connect('electron');
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        f.advance(CHOOSE_FOLDER_TIMEOUT_MS + 1);
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/late' });
        expect(results(asker)).toEqual([]);
    });

    it('keeps no entry for a request the channel refused', async () => {
        const f = fixture();
        const shell = f.connect('electron');
        const asker = f.connect();
        // No window: refused by the channel, so nothing is pending and nothing was broadcast.
        expect(await ask(asker, { request_id: 'R1' })).toMatchObject({ ok: false });
        // An oversized id: refused AFTER the hub noted it, and forgotten again.
        const long = 'x'.repeat(200);
        expect(await ask(asker, { request_id: long, window_id: 'WIN-1' })).toMatchObject({ ok: false });
        expect(f.h.broadcasts).toEqual([]);
        answer(shell, { requestID: 'R1', path: '/a' });
        answer(shell, { requestID: long, windowID: 'WIN-1', path: '/a' });
        expect(results(asker)).toEqual([]);
    });

    it('refuses to re-point an id that is already pending', async () => {
        const f = fixture();
        const shell = f.connect('electron');
        const first = f.connect();
        const second = f.connect();
        await ask(first, { request_id: 'R1', window_id: 'WIN-1' });
        expect(await ask(second, { request_id: 'R1', window_id: 'WIN-1' })).toMatchObject({ ok: false });
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/a' });
        expect(results(first).map((message) => message['path'])).toEqual(['/a']);
        expect(results(second)).toEqual([]);
    });

    it('caps the pending set, dropping the stalest request first', async () => {
        const f = fixture();
        const shell = f.connect('electron');
        const asker = f.connect();
        for (let index = 0; index <= MAX_PENDING_FOLDER_CHOICES; index++) {
            await ask(asker, { request_id: `R${String(index)}`, window_id: 'WIN-1' });
        }
        answer(shell, { requestID: 'R0', windowID: 'WIN-1', path: '/oldest' });
        answer(shell, { requestID: `R${String(MAX_PENDING_FOLDER_CHOICES)}`, windowID: 'WIN-1', path: '/newest' });
        expect(results(asker).map((message) => message['path'])).toEqual(['/newest']);
    });
});

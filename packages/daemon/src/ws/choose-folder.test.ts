/**
 * #283: the "choose a folder" round trip through the real `SyncHub`.
 *
 * The one desktop relay that is not a fan-out: the client's `shell-action` `choose-folder-dialog`
 * is broadcast to the shells like any other action, but the answer goes back to the ONE session
 * that asked, only while it is still waiting, and only when it came from the named window's own
 * shell connection. Driven through the real hub and the real desktop channel with recording
 * transports, so the frames asserted here are the ones the page and the shell see.
 */

import {
    CHOOSE_FOLDER_CAPABILITY,
    CHOOSE_FOLDER_TIMEOUT_MS,
    WS_CHOOSE_FOLDER_ANSWER_MESSAGE,
    WS_CHOOSE_FOLDER_RESULT_MESSAGE,
    WS_PROTOCOL_VERSION
} from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import { harness, type Harness } from '../handlers/pane/testing.js';
import { DEVICE_TOKEN_PREFIX } from '../lifecycle/devices.js';
import type { ControlDispatcher } from '../seams.js';
import { createDesktopChannel, SHELL_ACTION_EVENT, type DesktopChannel } from './desktop.js';
import { createSyncHub, MAX_PENDING_SHELL_ANSWERS, type SyncSession } from './sync.js';
import { recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };
const OWNER_TOKEN = 'owner-token';
const DEVICE_TOKEN = `${DEVICE_TOKEN_PREFIX}paired-phone`;

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
    /** Move the hub's clock forward. */
    advance(ms: number): void;
    connect(options?: ClientOptions): Peer;
    /** A current shell's status connection for `windowID`: the only party that may answer. */
    shell(windowID?: string): Peer;
}

function fixture(options: { wrap?: (channel: DesktopChannel) => DesktopChannel } = {}): Fixture {
    const h = harness();
    let clock = 1_000_000;
    const dispatcher: ControlDispatcher = (_message, reply) => {
        reply?.send({ ok: true });
        reply?.close();
    };
    const channel = createDesktopChannel({ ctx: h.ctx });
    const hub = createSyncHub({
        store: h.store,
        dispatcher,
        daemon: DAEMON,
        now: () => clock,
        // Every token authenticates; what matters here is which KIND of token it was.
        validateToken: () => true,
        desktop: options.wrap === undefined ? channel : options.wrap(channel)
    });
    const connect = (client: ClientOptions = {}): Peer => {
        const kind = client.kind ?? 'browser';
        const transport = recordingTransport();
        const session = hub.createSession(transport);
        session.handleMessage(
            JSON.stringify({
                type: 'hello',
                protocolVersion: WS_PROTOCOL_VERSION,
                token: client.token ?? OWNER_TOKEN,
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
        shell: (windowID = 'WIN-1') => connect({ kind: 'electron', windowID, capabilities: [CHOOSE_FOLDER_CAPABILITY] })
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
const paths = (peer: Peer): unknown[] => results(peer).map((message) => message['path']);

describe('choose-folder round trip (#283)', () => {
    it('broadcasts the request to the shells and routes the answer to the asker alone', async () => {
        const f = fixture();
        const shell = f.shell();
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
        const shell = f.shell();
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
        const shell = f.shell();
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/a' });
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/b' });
        expect(paths(asker)).toEqual(['/a']);
    });

    it('ignores an answer nobody asked for, and one with no id', () => {
        const f = fixture();
        const shell = f.shell();
        const client = f.connect();
        answer(shell, { requestID: 'never-asked', windowID: 'WIN-1', path: '/a' });
        answer(shell, { windowID: 'WIN-1', path: '/a' });
        expect(results(client)).toEqual([]);
    });

    it('drops an answer naming a window other than the one asked, and still takes the right one', async () => {
        const f = fixture();
        const shell = f.shell();
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        answer(shell, { requestID: 'R1', windowID: 'WIN-2', path: '/wrong' });
        answer(shell, { requestID: 'R1', path: '/unaddressed' });
        expect(results(asker)).toEqual([]);
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/right' });
        expect(paths(asker)).toEqual(['/right']);
    });
});

describe('who may ask and who may answer (#283)', () => {
    it('drops a forged answer from any session that is not the named window’s shell', async () => {
        const f = fixture();
        const shell = f.shell('WIN-1');
        const asker = f.connect();
        // Every one of these heard the broadcast and copied its ids exactly.
        const forgers = [
            f.connect(),
            f.connect({ token: DEVICE_TOKEN }),
            // A paired device claiming to be the shell is still a paired device.
            f.connect({ kind: 'electron', token: DEVICE_TOKEN, windowID: 'WIN-1', capabilities: [CHOOSE_FOLDER_CAPABILITY] }),
            // The shell's web-host socket names the window but cannot answer.
            f.connect({ kind: 'electron', windowID: 'WIN-1', capabilities: ['web-pane-host'] }),
            // Another window's shell.
            f.shell('WIN-2'),
            // A browser that dressed its hello up as the shell's, but is not Electron.
            f.connect({ kind: 'browser', windowID: 'WIN-1', capabilities: [CHOOSE_FOLDER_CAPABILITY] })
        ];
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        for (const forger of forgers) answer(forger, { requestID: 'R1', windowID: 'WIN-1', path: '/forged' });
        expect(results(asker)).toEqual([]);

        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/real' });
        expect(paths(asker)).toEqual(['/real']);
    });

    it('refuses a request from a paired device, and broadcasts nothing', async () => {
        const f = fixture();
        f.shell();
        const phone = f.connect({ token: DEVICE_TOKEN });
        const reply = await ask(phone, { request_id: 'R1', window_id: 'WIN-1' });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply?.['error'])).toContain('owner-only');
        expect(f.h.broadcasts).toEqual([]);
    });

    it('refuses at once when no shell for the window can answer, so the page is told rather than left waiting', async () => {
        const f = fixture();
        const asker = f.connect();
        // Nobody at all.
        expect(await ask(asker, { request_id: 'R1', window_id: 'WIN-1' })).toMatchObject({ ok: false });
        // An older shell: its status connection names the window but not the capability.
        f.connect({ kind: 'electron', windowID: 'WIN-1' });
        // A current shell, but for another window.
        f.shell('WIN-2');
        const reply = await ask(asker, { request_id: 'R2', window_id: 'WIN-1' });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply?.['error'])).toContain('WIN-1');
        expect(f.h.broadcasts).toEqual([]);
        // Nothing was recorded for either: once the shell is there, the same ids are fine.
        f.shell('WIN-1');
        expect(await ask(asker, { request_id: 'R1', window_id: 'WIN-1' })).toMatchObject({ ok: true });
        expect(await ask(asker, { request_id: 'R2', window_id: 'WIN-1' })).toMatchObject({ ok: true });
    });
});

describe('every pending request ends (#283)', () => {
    it('forgets a request whose asker closed, before any answer arrives', async () => {
        const f = fixture();
        f.shell();
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        asker.session.close();
        // Were the entry still held, the same id would be refused as already pending.
        const again = f.connect();
        expect(await ask(again, { request_id: 'R1', window_id: 'WIN-1' })).toMatchObject({ ok: true });
    });

    it('answers null to every asker waiting on a shell that disconnects', async () => {
        const f = fixture();
        const shell = f.shell('WIN-1');
        const other = f.shell('WIN-2');
        const first = f.connect();
        const second = f.connect();
        const elsewhere = f.connect();
        await ask(first, { request_id: 'R1', window_id: 'WIN-1' });
        await ask(second, { request_id: 'R2', window_id: 'WIN-1' });
        await ask(elsewhere, { request_id: 'R3', window_id: 'WIN-2' });

        shell.session.close();
        expect(results(first)).toEqual([{ type: WS_CHOOSE_FOLDER_RESULT_MESSAGE, requestID: 'R1', path: null, windowID: 'WIN-1' }]);
        expect(paths(second)).toEqual([null]);
        // Another window's panel is untouched, and still answerable.
        expect(results(elsewhere)).toEqual([]);
        answer(other, { requestID: 'R3', windowID: 'WIN-2', path: '/b' });
        expect(paths(elsewhere)).toEqual(['/b']);
    });

    it('keeps the request while another connection of the same shell window can still answer', async () => {
        const f = fixture();
        const dropping = f.shell('WIN-1');
        const reconnected = f.shell('WIN-1');
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        dropping.session.close();
        expect(results(asker)).toEqual([]);
        answer(reconnected, { requestID: 'R1', windowID: 'WIN-1', path: '/a' });
        expect(paths(asker)).toEqual(['/a']);
    });

    it('answers null after the timeout, and drops the late answer', async () => {
        const f = fixture();
        const shell = f.shell();
        const asker = f.connect();
        await ask(asker, { request_id: 'R1', window_id: 'WIN-1' });
        f.advance(CHOOSE_FOLDER_TIMEOUT_MS + 1);
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/late' });
        expect(paths(asker)).toEqual([null]);
    });

    it('caps the pending set, telling the stalest asker its request is over', async () => {
        const f = fixture();
        const shell = f.shell();
        const oldest = f.connect();
        const asker = f.connect();
        await ask(oldest, { request_id: 'R0', window_id: 'WIN-1' });
        for (let index = 1; index <= MAX_PENDING_SHELL_ANSWERS; index++) {
            await ask(asker, { request_id: `R${String(index)}`, window_id: 'WIN-1' });
        }
        expect(results(oldest)).toEqual([{ type: WS_CHOOSE_FOLDER_RESULT_MESSAGE, requestID: 'R0', path: null, windowID: 'WIN-1' }]);
        answer(shell, { requestID: 'R0', windowID: 'WIN-1', path: '/oldest' });
        answer(shell, { requestID: `R${String(MAX_PENDING_SHELL_ANSWERS)}`, windowID: 'WIN-1', path: '/newest' });
        expect(paths(oldest)).toEqual([null]);
        expect(paths(asker)).toEqual(['/newest']);
    });

    it('never lets an invalid request evict a valid one from the full set', async () => {
        const f = fixture();
        const shell = f.shell();
        const asker = f.connect();
        for (let index = 0; index < MAX_PENDING_SHELL_ANSWERS; index++) {
            await ask(asker, { request_id: `R${String(index)}`, window_id: 'WIN-1' });
        }
        // Refused by the channel for its length; it must not have been counted first.
        expect(await ask(asker, { request_id: 'x'.repeat(200), window_id: 'WIN-1' })).toMatchObject({ ok: false });
        expect(results(asker)).toEqual([]);
        answer(shell, { requestID: 'R0', windowID: 'WIN-1', path: '/still-here' });
        expect(paths(asker)).toEqual(['/still-here']);
    });

    it('keeps no entry for a request the channel refused', async () => {
        const f = fixture();
        const shell = f.shell();
        const asker = f.connect();
        expect(await ask(asker, { request_id: 'R1' })).toMatchObject({ ok: false });
        const long = 'x'.repeat(200);
        expect(await ask(asker, { request_id: long, window_id: 'WIN-1' })).toMatchObject({ ok: false });
        expect(f.h.broadcasts).toEqual([]);
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/a' });
        answer(shell, { requestID: long, windowID: 'WIN-1', path: '/a' });
        expect(results(asker)).toEqual([]);
    });

    it('forgets the request when the channel throws, so the id is not stuck as pending', async () => {
        let throwOnce = true;
        const f = fixture({
            wrap: (channel) => ({
                run: async (command, payload) => {
                    if (throwOnce) {
                        throwOnce = false;
                        throw new Error('channel exploded');
                    }
                    return channel.run(command, payload);
                }
            })
        });
        f.shell();
        const asker = f.connect();
        expect(await ask(asker, { request_id: 'R1', window_id: 'WIN-1' })).toMatchObject({ ok: false });
        expect(await ask(asker, { request_id: 'R1', window_id: 'WIN-1' })).toMatchObject({ ok: true });
    });

    it('refuses to re-point an id that is already pending', async () => {
        const f = fixture();
        const shell = f.shell();
        const first = f.connect();
        const second = f.connect();
        await ask(first, { request_id: 'R1', window_id: 'WIN-1' });
        expect(await ask(second, { request_id: 'R1', window_id: 'WIN-1' })).toMatchObject({ ok: false });
        answer(shell, { requestID: 'R1', windowID: 'WIN-1', path: '/a' });
        expect(paths(first)).toEqual(['/a']);
        expect(results(second)).toEqual([]);
    });
});

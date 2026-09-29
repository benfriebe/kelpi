/**
 * #286: the update surface's two relays through the real `SyncHub` and desktop channel.
 *
 *   - `update-state`, shell → daemon → the page: accepted ONLY from the named window's own owner
 *     Electron session that declared `update-surface`, re-validated, its release notes rendered
 *     here (escaped), and never sent to a paired device;
 *   - `shell-action` `update-action`, page → daemon → shell: owner only, refused at once without
 *     an update-capable shell for the window, and only with a verb the flow knows.
 */

import {
    CHOOSE_FOLDER_CAPABILITY,
    UPDATE_SURFACE_CAPABILITY,
    WS_PROTOCOL_VERSION,
    WS_UPDATE_STATE_MESSAGE
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
    connect(options?: ClientOptions): Peer;
    /** A current shell's status connection for `windowID`, declaring the update surface. */
    shell(windowID?: string): Peer;
}

function fixture(): Fixture {
    const h = harness();
    const dispatcher: ControlDispatcher = (_message, reply) => {
        reply?.send({ ok: true });
        reply?.close();
    };
    const hub = createSyncHub({
        store: h.store,
        dispatcher,
        daemon: DAEMON,
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
        connect,
        shell: (windowID = 'WIN-1') =>
            connect({ kind: 'electron', windowID, capabilities: [CHOOSE_FOLDER_CAPABILITY, UPDATE_SURFACE_CAPABILITY] })
    };
}

const VIEW = {
    phase: 'available',
    currentVersion: '0.2.2',
    version: '0.2.3',
    notes: '## Fixes\n\n- Restarts only when you say so.\n\n<script>alert(1)</script> <img src=x onerror=alert(2)>\n\n![tracker](https://example.com/p.gif) [site](https://kelpi.dev) [chat](slack://channel/x) [local](file:///etc/passwd)'
};

function push(peer: Peer, fields: Record<string, unknown>): void {
    peer.session.handleMessage(JSON.stringify({ type: WS_UPDATE_STATE_MESSAGE, windowID: 'WIN-1', seq: 1, reveal: true, view: VIEW, ...fields }));
}

const states = (peer: Peer): Record<string, unknown>[] => peer.transport.ofType(WS_UPDATE_STATE_MESSAGE);

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

let counter = 0;
async function press(peer: Peer, fields: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    counter += 1;
    const id = `u${String(counter)}`;
    peer.session.handleMessage(JSON.stringify({ type: 'command', id, payload: { command: 'shell-action', action: 'update-action', ...fields } }));
    await settle();
    const reply = peer.transport.ofType('command-reply').find((message) => message['id'] === id);
    return reply?.['reply'] as Record<string, unknown> | undefined;
}

describe('update-state: shell to page (#286)', () => {
    it('relays the window\'s own shell\'s view to owner sessions, with the notes rendered and escaped', () => {
        const f = fixture();
        const shell = f.shell();
        const page = f.connect();
        push(shell, {});
        const [state] = states(page);
        expect(state).toMatchObject({ type: 'update-state', windowID: 'WIN-1', seq: 1, reveal: true, view: VIEW });
        const html = String(state?.['notesHTML']);
        expect(html).toContain('<h2>Fixes</h2>');
        expect(html).toContain('<li><p>Restarts only when you say so.</p>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        expect(html).toContain('tracker');
        expect(html).toContain('<a href="https://kelpi.dev">site</a>');
        // A custom-scheme link keeps its text and loses its anchor; a file: link is not a link.
        expect(html).toContain(' chat ');
        expect(html).not.toContain('slack:');
        expect(html).not.toContain('href="file:');
        // Never echoed to the shell that sent it.
        expect(states(shell)).toEqual([]);
    });

    it('drops a view from anyone but that window\'s own capable owner shell', () => {
        const f = fixture();
        f.shell();
        const page = f.connect();
        // A browser page that copied the window id.
        push(f.connect({ windowID: 'WIN-1' }), {});
        // A shell of ANOTHER window.
        push(f.shell('WIN-2'), {});
        // An older shell of this window that never declared the update surface.
        push(f.connect({ kind: 'electron', windowID: 'WIN-1', capabilities: [CHOOSE_FOLDER_CAPABILITY] }), {});
        // A paired device claiming to be this window's shell.
        push(
            f.connect({ kind: 'electron', token: DEVICE_TOKEN, windowID: 'WIN-1', capabilities: [UPDATE_SURFACE_CAPABILITY] }),
            {}
        );
        expect(states(page)).toEqual([]);
    });

    it('drops a malformed frame instead of relaying something else', () => {
        const f = fixture();
        const shell = f.shell();
        const page = f.connect();
        push(shell, { windowID: undefined });
        push(shell, { seq: -1 });
        push(shell, { reveal: 'yes' });
        push(shell, { view: { ...VIEW, phase: 'installing-anything' } });
        push(shell, { view: { ...VIEW, version: '"><script>' } });
        push(shell, { view: { phase: 'ready', currentVersion: '0.2.2' } });
        expect(states(page)).toEqual([]);
    });

    it('never relays to a paired device, and replaces any notesHTML the shell sent', () => {
        const f = fixture();
        const shell = f.shell();
        const phone = f.connect({ token: DEVICE_TOKEN });
        const page = f.connect();
        push(shell, { notesHTML: '<script>alert(3)</script>', view: { phase: 'ready', currentVersion: '0.2.2', version: '0.2.3' } });
        expect(states(phone)).toEqual([]);
        const [state] = states(page);
        expect(state?.['notesHTML']).toBeUndefined();
        expect(state?.['view']).toEqual({ phase: 'ready', currentVersion: '0.2.2', version: '0.2.3' });
    });

    it('relays a hide (the shell moved the state to a native dialog) only as a literal true', () => {
        const f = fixture();
        const shell = f.shell();
        const page = f.connect();
        push(shell, { seq: 2, reveal: false, hide: true });
        push(shell, { seq: 3, reveal: false, hide: 'yes' });
        expect(states(page).map((state) => state['hide'])).toEqual([true, undefined]);
    });

    it('drops unknown view fields rather than passing them through', () => {
        const f = fixture();
        const shell = f.shell();
        const page = f.connect();
        push(shell, { view: { ...VIEW, notes: undefined, install: '/bin/sh' } });
        expect(states(page)[0]?.['view']).toEqual({ phase: 'available', currentVersion: '0.2.2', version: '0.2.3' });
    });
});

describe('update-action: page to shell (#286)', () => {
    it('broadcasts a known verb with its window and sequence to the shells', async () => {
        const f = fixture();
        f.shell();
        const page = f.connect();
        expect(await press(page, { window_id: 'WIN-1', update_action: 'quit', seq: 3 })).toMatchObject({ ok: true });
        const reply = await press(page, { window_id: 'WIN-1', update_action: 'shown', seq: 4 });
        expect(reply).toMatchObject({ ok: true, action: 'update-action' });
        expect(f.h.broadcasts).toContainEqual({
            type: SHELL_ACTION_EVENT,
            action: 'update-action',
            windowID: 'WIN-1',
            updateAction: 'shown',
            seq: 4
        });
    });

    it('refuses a paired device, whatever it presses', async () => {
        const f = fixture();
        f.shell();
        const phone = f.connect({ token: DEVICE_TOKEN });
        const reply = await press(phone, { window_id: 'WIN-1', update_action: 'restart' });
        expect(reply).toMatchObject({ ok: false, error: 'update-action is owner-only' });
        expect(f.h.broadcasts.some((message) => message['action'] === 'update-action')).toBe(false);
    });

    it('refuses at once when no update-capable shell is attached for the window', async () => {
        const f = fixture();
        f.connect({ kind: 'electron', windowID: 'WIN-1', capabilities: [CHOOSE_FOLDER_CAPABILITY] });
        f.shell('WIN-2');
        const page = f.connect();
        const reply = await press(page, { window_id: 'WIN-1', update_action: 'update-now' });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply?.['error'])).toContain('no desktop window WIN-1');
        expect(f.h.broadcasts.some((message) => message['action'] === 'update-action')).toBe(false);
    });

    it('refuses an unknown verb, a missing window and a bad sequence', async () => {
        const f = fixture();
        f.shell();
        const page = f.connect();
        expect(await press(page, { window_id: 'WIN-1', update_action: 'rm -rf' })).toMatchObject({ ok: false });
        expect(await press(page, { update_action: 'restart' })).toMatchObject({ ok: false, error: 'shell-action update-action requires window_id' });
        expect(await press(page, { window_id: 'WIN-1', update_action: 'shown', seq: 1.5 })).toMatchObject({ ok: false });
        expect(f.h.broadcasts.some((message) => message['action'] === 'update-action')).toBe(false);
    });
});

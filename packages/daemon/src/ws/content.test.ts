/**
 * The WS + HTTP surface of M5: the `content-*` verbs on the sync channel and the
 * `/pane-assets/<paneID>/<relpath>` route. The renderers and the service have their own specs
 * (`src/content/*.test.ts`); this file is about routing, subscription bookkeeping and the
 * traversal gate.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WS_PROTOCOL_VERSION } from '@nex/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { ContentPaneState, ContentSubscription } from '../content/index.js';
import type { ControlDispatcher } from '../seams.js';
import { harness as storeHarness, seededState, W1 } from '../store/testing.js';
import { createHttpApp, createPaneAssetsRoute, parsePaneAssetPath } from './http.js';
import {
    CONTENT_COMMANDS,
    CONTENT_UPDATED_MESSAGE,
    createSyncHub,
    isContentCommand,
    type ContentChannel
} from './sync.js';
import { PANE_A, PANE_B, recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };
const VERSION = { version: '0.1.0', build: '42', protocol: 1 };

function stateFor(paneID: string, overrides: Partial<ContentPaneState> = {}): ContentPaneState {
    return {
        paneID,
        workspaceID: W1,
        type: 'markdown',
        mode: 'view',
        filePath: '/notes/a.md',
        html: '<!DOCTYPE html>',
        text: '# a',
        loaded: true,
        error: null,
        dirty: false,
        fontSize: 14,
        isDark: true,
        revision: 1,
        updatedAt: 0,
        assetBase: `/pane-assets/${paneID}/`,
        ...overrides
    };
}

interface StubContent extends ContentChannel {
    readonly calls: string[];
    readonly listeners: Map<string, (state: ContentPaneState) => void>;
    readonly unsubscribes: string[];
    /** Push an update as the service would. */
    push(paneID: string, state?: ContentPaneState): void;
    fail: Error | null;
}

function stubContent(): StubContent {
    const calls: string[] = [];
    const listeners = new Map<string, (state: ContentPaneState) => void>();
    const unsubscribes: string[] = [];
    const stub: StubContent = {
        calls,
        listeners,
        unsubscribes,
        fail: null,
        push(paneID, state) {
            listeners.get(paneID)?.(state ?? stateFor(paneID, { revision: 2 }));
        },
        async subscribe(paneID, listener): Promise<ContentSubscription> {
            calls.push(`subscribe:${paneID}`);
            if (stub.fail !== null) throw stub.fail;
            listeners.set(paneID, listener);
            return {
                state: stateFor(paneID),
                unsubscribe: () => {
                    unsubscribes.push(paneID);
                    listeners.delete(paneID);
                }
            };
        },
        async setMode(paneID, mode) {
            calls.push(`setMode:${paneID}:${mode}`);
            if (stub.fail !== null) throw stub.fail;
            return stateFor(paneID, { mode });
        },
        async setText(paneID, text) {
            calls.push(`setText:${paneID}:${text}`);
            if (stub.fail !== null) throw stub.fail;
            return stateFor(paneID, { text, dirty: true });
        },
        async save(paneID) {
            calls.push(`save:${paneID}`);
            if (stub.fail !== null) throw stub.fail;
            return stateFor(paneID);
        },
        async refresh(paneID) {
            calls.push(`refresh:${paneID}`);
            if (stub.fail !== null) throw stub.fail;
            return stateFor(paneID, { type: 'diff', text: null });
        }
    };
    return stub;
}

function hello(): string {
    return JSON.stringify({
        type: 'hello',
        protocolVersion: WS_PROTOCOL_VERSION,
        token: 'tok',
        client: { kind: 'browser' }
    });
}

/** `null` = a daemon with no content service (the honest-refusal path). */
function fixture(input: ContentChannel | null = stubContent()): {
    readonly hub: ReturnType<typeof createSyncHub>;
    connect(): { session: ReturnType<ReturnType<typeof createSyncHub>['createSession']>; transport: RecordedTransport };
} {
    const store = storeHarness(seededState(W1, PANE_A));
    const dispatcher: ControlDispatcher = (_message, reply) => {
        reply?.send({ ok: true });
        reply?.close();
    };
    const hub = createSyncHub({
        store: store.store,
        dispatcher,
        daemon: DAEMON,
        ...(input !== null ? { content: input } : {})
    });
    return {
        hub,
        connect() {
            const transport = recordingTransport();
            const session = hub.createSession(transport);
            session.handleMessage(hello());
            return { session, transport };
        }
    };
}

function send(
    session: { handleMessage(raw: string): void },
    id: string,
    payload: Record<string, unknown>
): void {
    session.handleMessage(JSON.stringify({ type: 'command', id, payload }));
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function replies(transport: RecordedTransport): Record<string, unknown>[] {
    return transport.ofType('command-reply');
}

function replyBody(transport: RecordedTransport, id: string): Record<string, unknown> {
    const message = replies(transport).find((entry) => entry['id'] === id);
    return (message?.['reply'] ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Verb routing
// ---------------------------------------------------------------------------

describe('content commands', () => {
    it('lists exactly the M5 verbs and matches them before the wire decode', () => {
        expect([...CONTENT_COMMANDS]).toEqual([
            'content-subscribe',
            'content-unsubscribe',
            'markdown-set-mode',
            'content-set-text',
            'diff-refresh',
            'markdown-save'
        ]);
        for (const command of CONTENT_COMMANDS) expect(isContentCommand(command)).toBe(true);
        expect(isContentCommand('pane-list')).toBe(false);
    });

    it('answers content-subscribe with the full state', async () => {
        const content = stubContent();
        const f = fixture(content);
        const { session, transport } = f.connect();

        send(session, 'r1', { command: 'content-subscribe', pane_id: PANE_A });
        await settle();

        const reply = replyBody(transport, 'r1');
        expect(reply['ok']).toBe(true);
        expect(reply['pane_id']).toBe(PANE_A);
        expect((reply['state'] as ContentPaneState).html).toBe('<!DOCTYPE html>');
        expect(content.calls).toEqual([`subscribe:${PANE_A}`]);
    });

    it('sends content-updated ONLY to subscribed sessions', async () => {
        const content = stubContent();
        const f = fixture(content);
        const a = f.connect();
        const b = f.connect();

        send(a.session, 'r1', { command: 'content-subscribe', pane_id: PANE_A });
        await settle();
        content.push(PANE_A);

        const updates = a.transport.ofType(CONTENT_UPDATED_MESSAGE);
        expect(updates).toHaveLength(1);
        expect(updates[0]?.['paneID']).toBe(PANE_A);
        expect((updates[0]?.['state'] as ContentPaneState).revision).toBe(2);
        expect(b.transport.ofType(CONTENT_UPDATED_MESSAGE)).toHaveLength(0);
    });

    it('content-unsubscribe releases the subscription and stops events', async () => {
        const content = stubContent();
        const f = fixture(content);
        const { session, transport } = f.connect();

        send(session, 'r1', { command: 'content-subscribe', pane_id: PANE_A });
        await settle();
        send(session, 'r2', { command: 'content-unsubscribe', pane_id: PANE_A });
        await settle();

        expect(replyBody(transport, 'r2')).toEqual({ ok: true, pane_id: PANE_A });
        expect(content.unsubscribes).toEqual([PANE_A]);
        content.push(PANE_A);
        expect(transport.ofType(CONTENT_UPDATED_MESSAGE)).toHaveLength(0);
    });

    it('re-subscribing replaces the previous handle rather than doubling the stream', async () => {
        const content = stubContent();
        const f = fixture(content);
        const { session, transport } = f.connect();

        send(session, 'r1', { command: 'content-subscribe', pane_id: PANE_A });
        await settle();
        send(session, 'r2', { command: 'content-subscribe', pane_id: PANE_A });
        await settle();

        expect(content.unsubscribes).toEqual([PANE_A]);
        content.push(PANE_A);
        expect(transport.ofType(CONTENT_UPDATED_MESSAGE)).toHaveLength(1);
    });

    it('drops every subscription when the connection closes', async () => {
        const content = stubContent();
        const f = fixture(content);
        const { session } = f.connect();

        send(session, 'r1', { command: 'content-subscribe', pane_id: PANE_A });
        send(session, 'r2', { command: 'content-subscribe', pane_id: PANE_B });
        await settle();
        session.close();

        expect(content.unsubscribes.sort()).toEqual([PANE_A, PANE_B].sort());
    });

    it('voids an in-flight subscribe that is unsubscribed before it resolves', async () => {
        let release: (() => void) | undefined;
        let unsubscribed = 0;
        const slow: ContentChannel = {
            async subscribe(paneID) {
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                return {
                    state: stateFor(paneID),
                    unsubscribe: () => {
                        unsubscribed += 1;
                    }
                };
            },
            setMode: async (paneID) => stateFor(paneID),
            setText: async (paneID) => stateFor(paneID),
            save: async (paneID) => stateFor(paneID),
            refresh: async (paneID) => stateFor(paneID)
        };
        const f = fixture(slow);
        const { session, transport } = f.connect();

        send(session, 'r1', { command: 'content-subscribe', pane_id: PANE_A });
        await settle();
        send(session, 'r2', { command: 'content-unsubscribe', pane_id: PANE_A });
        release?.();
        await settle();
        await settle();

        // The late subscription is released rather than left streaming into a client that asked
        // to stop, and the caller's RPC still settles.
        expect(unsubscribed).toBe(1);
        expect(replyBody(transport, 'r1')['ok']).toBe(false);
        expect(replyBody(transport, 'r2')['ok']).toBe(true);
    });

    it('routes markdown-set-mode, content-set-text, diff-refresh and markdown-save', async () => {
        const content = stubContent();
        const f = fixture(content);
        const { session, transport } = f.connect();

        send(session, 'm1', { command: 'markdown-set-mode', pane_id: PANE_A, mode: 'edit' });
        send(session, 't1', { command: 'content-set-text', pane_id: PANE_A, text: 'hello' });
        send(session, 'd1', { command: 'diff-refresh', pane_id: PANE_B });
        send(session, 's1', { command: 'markdown-save', pane_id: PANE_A });
        await settle();

        expect(content.calls).toEqual([
            `setMode:${PANE_A}:edit`,
            `setText:${PANE_A}:hello`,
            `refresh:${PANE_B}`,
            `save:${PANE_A}`
        ]);
        expect((replyBody(transport, 'm1')['state'] as ContentPaneState).mode).toBe('edit');
        expect((replyBody(transport, 't1')['state'] as ContentPaneState).text).toBe('hello');
        expect(replyBody(transport, 'd1')['ok']).toBe(true);
        expect(replyBody(transport, 's1')['ok']).toBe(true);
    });

    it('accepts an empty string as content-set-text', async () => {
        const content = stubContent();
        const f = fixture(content);
        const { session, transport } = f.connect();
        send(session, 't1', { command: 'content-set-text', pane_id: PANE_A, text: '' });
        await settle();
        expect(replyBody(transport, 't1')['ok']).toBe(true);
        expect(content.calls).toEqual([`setText:${PANE_A}:`]);
    });

    it('rejects a missing pane_id, a bad mode and a missing text', async () => {
        const f = fixture();
        const { session, transport } = f.connect();

        send(session, 'e1', { command: 'content-subscribe' });
        send(session, 'e2', { command: 'markdown-set-mode', pane_id: PANE_A, mode: 'sideways' });
        send(session, 'e3', { command: 'content-set-text', pane_id: PANE_A });
        await settle();

        expect(replyBody(transport, 'e1')).toEqual({
            ok: false,
            error: 'content-subscribe requires pane_id'
        });
        expect(replyBody(transport, 'e2')['ok']).toBe(false);
        expect(replyBody(transport, 'e3')['error']).toBe('content-set-text requires text');
    });

    it('turns a service rejection into {ok:false,error}', async () => {
        const content = stubContent();
        content.fail = new Error("no pane matches 'x'");
        const f = fixture(content);
        const { session, transport } = f.connect();

        send(session, 'e1', { command: 'content-subscribe', pane_id: PANE_A });
        send(session, 'e2', { command: 'markdown-save', pane_id: PANE_A });
        await settle();

        expect(replyBody(transport, 'e1')).toEqual({ ok: false, error: "no pane matches 'x'" });
        expect(replyBody(transport, 'e2')).toEqual({ ok: false, error: "no pane matches 'x'" });
    });

    it('answers honestly when the daemon has no content service', async () => {
        const f = fixture(null);
        const { session, transport } = f.connect();
        send(session, 'e1', { command: 'content-subscribe', pane_id: PANE_A });
        await settle();
        expect(replyBody(transport, 'e1')).toEqual({
            ok: false,
            error: 'content panes are not available'
        });
    });
});

// ---------------------------------------------------------------------------
// Asset route
// ---------------------------------------------------------------------------

describe('parsePaneAssetPath', () => {
    it('splits the pane id from the relative path and percent-decodes both', () => {
        expect(parsePaneAssetPath('/pane-assets/ID/img/a%20b.png')).toEqual({
            paneID: 'ID',
            relativePath: 'img/a b.png'
        });
    });

    it('refuses malformed shapes', () => {
        expect(parsePaneAssetPath('/other/ID/a.png')).toBeNull();
        expect(parsePaneAssetPath('/pane-assets/ID')).toBeNull();
        expect(parsePaneAssetPath('/pane-assets/ID/')).toBeNull();
        expect(parsePaneAssetPath('/pane-assets//a.png')).toBeNull();
        expect(parsePaneAssetPath('/pane-assets/ID/%ZZ')).toBeNull();
        // An encoded separator must not smuggle a path segment into the pane id.
        expect(parsePaneAssetPath('/pane-assets/a%2Fb/x.png')).toBeNull();
        expect(parsePaneAssetPath('/pane-assets/ID/a%00b')).toBeNull();
    });
});

describe('GET /pane-assets/:paneID/*', () => {
    const temporaries: string[] = [];

    afterEach(() => {
        for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    function assetApp(resolve: (paneID: string, relativePath: string) => string | null) {
        return createHttpApp({ version: VERSION, routes: createPaneAssetsRoute(resolve) });
    }

    it('serves a file the service resolved', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexd-assets-'));
        temporaries.push(dir);
        const file = path.join(dir, 'a.png');
        fs.writeFileSync(file, 'PNGDATA');

        const app = assetApp((paneID, relative) =>
            paneID === 'ID' && relative === 'a.png' ? file : null
        );
        const response = await app.request('/pane-assets/ID/a.png');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(await response.text()).toBe('PNGDATA');
    });

    it('404s when the service refuses the path (traversal, unknown pane, missing file)', async () => {
        const seen: string[] = [];
        const app = assetApp((paneID, relative) => {
            seen.push(`${paneID}:${relative}`);
            return null;
        });
        for (const url of [
            '/pane-assets/ID/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
            '/pane-assets/ID/img%2f..%2f..%2fsecret.txt',
            '/pane-assets/UNKNOWN/a.png',
            '/pane-assets/ID/gone.png'
        ]) {
            const response = await app.request(url);
            expect(response.status).toBe(404);
        }
        // Traversal arrives at the resolver decoded — it is the service that refuses it, and it
        // must never be handed a still-encoded string it would fail to recognise as an escape.
        expect(seen).toContain('ID:../../etc/passwd');
        expect(seen).toContain('ID:img/../../secret.txt');
    });

    it('404s a malformed asset URL without consulting the service', async () => {
        let calls = 0;
        const app = assetApp(() => {
            calls += 1;
            return null;
        });
        expect((await app.request('/pane-assets/ID/')).status).toBe(404);
        expect(calls).toBe(0);
    });

    it('never shadows /healthz or the client build', async () => {
        const app = assetApp(() => null);
        expect((await app.request('/healthz')).status).toBe(200);
    });
});

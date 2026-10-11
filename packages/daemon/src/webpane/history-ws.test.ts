/**
 * #375's WS surface: the URL bar's history verbs, the prefill broadcast, and the two refusals
 * that keep plugins (an agent's reach into the daemon) out of the user's browsing.
 */

import { WS_PROTOCOL_VERSION, type JsonObject, type WireMessage } from '@kelpi/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ControlDispatcher } from '../seams.js';
import { createStore, emptyDaemonState } from '../store/index.js';
import { createSyncHub, type SyncHub } from '../ws/sync.js';
import { recordingTransport, type RecordedTransport } from '../ws/testing.js';
import { createWebPaneService, type WebPaneService } from './service.js';
import { HOME, NOW, SHELL_PANE, WEB_PANE, WEB_TAB, WORKSPACE } from './testing.js';

interface Fixture {
    readonly hub: SyncHub;
    readonly service: WebPaneService;
    readonly dispatched: WireMessage[];
    readonly broadcasts: JsonObject[];
    client(): RecordedTransport & { command(payload: JsonObject): JsonObject | undefined };
}

function fixture(): Fixture {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: WORKSPACE, paneID: SHELL_PANE, name: 'w1', color: 'blue', now: NOW });
    store.dispatch({ type: 'open-web-pane', workspaceID: WORKSPACE, paneID: WEB_PANE, tabID: WEB_TAB, url: 'https://example.com', now: NOW });
    const broadcasts: JsonObject[] = [];
    const service = createWebPaneService({
        store,
        now: () => NOW,
        onHistoryPrefillChanged: (entries) => broadcasts.push({ entries: entries.map((entry) => ({ ...entry })) })
    });
    const dispatched: WireMessage[] = [];
    const dispatcher: ControlDispatcher = (message, reply) => {
        dispatched.push(message);
        reply?.send({ ok: true });
        reply?.close();
    };
    const hub = createSyncHub({ store, dispatcher, daemon: { version: '0.1.0', build: '42', pid: 1 }, webPanes: service });
    return {
        hub,
        service,
        dispatched,
        broadcasts,
        client() {
            const transport = recordingTransport();
            const session = hub.createSession(transport);
            session.handleMessage(
                JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token: 'tok', client: { kind: 'browser' } })
            );
            let next = 0;
            return Object.assign(transport, {
                command(payload: JsonObject): JsonObject | undefined {
                    const id = `c${String((next += 1))}`;
                    session.handleMessage(JSON.stringify({ type: 'command', id, payload }));
                    const reply = transport.ofType('command-reply').find((message) => message['id'] === id);
                    return reply?.['reply'] as JsonObject | undefined;
                }
            });
        }
    };
}

describe('the URL bar history verbs', () => {
    it('answers a query with the text it was asked for, and the matches', () => {
        const f = fixture();
        f.service.history.recordVisit({ url: 'https://github.com/anthropics', title: 'Anthropic', source: 'typed' });
        const client = f.client();
        expect(client.command({ command: 'web-history-query', text: 'git', limit: 5 })).toEqual({
            ok: true,
            text: 'git',
            entries: [{ url: 'https://github.com/anthropics', title: 'Anthropic' }]
        });
        expect(client.command({ command: 'web-history-typed-list' })).toEqual({
            ok: true,
            entries: [{ url: 'https://github.com/', title: '', kind: 'origin' }]
        });
    });

    it('removes one URL and clears everything, telling every client the prefill set changed', () => {
        const f = fixture();
        f.service.history.recordVisit({ url: 'https://github.com/', source: 'typed' });
        f.service.history.recordVisit({ url: 'https://example.com/', source: 'typed' });
        const client = f.client();
        expect(client.command({ command: 'web-history-remove', url: 'https://github.com/' })).toEqual({ ok: true, removed: true });
        expect(f.broadcasts.at(-1)).toEqual({ entries: [{ url: 'https://example.com/', title: '', kind: 'origin' }] });
        expect(client.command({ command: 'web-history-remove' })).toMatchObject({ ok: false });
        f.service.history.recordVisit({ url: 'https://gogle.com/x', source: 'typed' });
        expect(client.command({ command: 'web-history-remove', url: 'https://gogle.com/', site: true })).toEqual({ ok: true, removed: true });
        expect(client.command({ command: 'web-history-query', text: 'gogle' })).toMatchObject({ entries: [] });
        expect(client.command({ command: 'web-history-clear' })).toEqual({ ok: true });
        expect(f.broadcasts.at(-1)).toEqual({ entries: [] });
        expect(client.command({ command: 'web-history-query', text: 'example' })).toMatchObject({ entries: [] });
    });

    it('never acknowledges a removal or a clear the database did not make', () => {
        const f = fixture();
        const client = f.client();
        vi.spyOn(f.service.history, 'remove').mockImplementation(() => {
            throw new Error('disk full');
        });
        vi.spyOn(f.service.history, 'clear').mockImplementation(() => {
            throw new Error('disk full');
        });
        expect(client.command({ command: 'web-history-remove', url: 'https://github.com/' })).toMatchObject({ ok: false });
        expect(client.command({ command: 'web-history-clear' })).toMatchObject({ ok: false });
    });
});

describe('plugins never touch the user\'s browsing', () => {
    it('refuses every history verb to a plugin', async () => {
        const f = fixture();
        f.service.history.recordVisit({ url: 'https://github.com/', source: 'typed' });
        try {
            for (const command of ['web-history-query', 'web-history-typed-list', 'web-history-remove', 'web-history-clear']) {
                const reply = await f.hub.executeCommand({ command, text: 'git', url: 'https://github.com/' }, { daemonID: 'D' }, new AbortController().signal);
                expect(reply).toMatchObject({ ok: false, error: 'browsing history is not available to plugins' });
            }
            expect(f.service.history.query('github')).toHaveLength(1);
        } finally {
            f.hub.close();
        }
    });

    it('drops the gesture and typed marks from a plugin\'s navigation, which still runs', async () => {
        const f = fixture();
        try {
            await f.hub.executeCommand(
                { command: 'web-navigate', pane_id: WEB_PANE, url: 'https://plugin.test/', gesture: true, typed: true },
                { daemonID: 'D' },
                new AbortController().signal
            );
            expect(f.dispatched).toHaveLength(1);
            expect(f.dispatched[0]).toMatchObject({ command: 'web-navigate', url: 'https://plugin.test/' });
            expect(f.dispatched[0]).not.toHaveProperty('gesture');
            expect(f.dispatched[0]).not.toHaveProperty('typed');
        } finally {
            f.hub.close();
        }
    });

    it('keeps the marks on a window\'s own navigation', () => {
        const f = fixture();
        f.client().command({ command: 'web-navigate', pane_id: WEB_PANE, url: 'https://gui.test/', gesture: true, typed: true });
        expect(f.dispatched[0]).toMatchObject({ gesture: true, typed: true });
    });
});

/**
 * Debug ▸ Seed Test Group, end to end inside the client (§APP-028 / §SET-194).
 *
 * `seed-test-group.test.ts` asserts the fixture over an injected seam; this one asserts the part
 * that seam cannot see — that the shell's relay actually reaches it, and that what leaves the
 * socket is three ordinary verbs in order. Same shape as `App.openflow.test.tsx`: the whole
 * client against a scripted daemon socket, so the assertion is wire traffic rather than a spy on
 * a handler.
 *
 * The gesture's other half — the menu row existing only in a dev build — is `shell/menu.test.ts`
 * and `scripts/packaged-smoke.mjs`; the two halves meet at the command string, pinned in both.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { SEED_TEST_GROUP_COMMAND } from './app/seed-test-group';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    /** Answer the newest in-flight command with `{ok:true, ...extra}`. */
    reply(extra: Record<string, unknown>): void;
}

function setup(): Harness {
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store: createKelpiStore(),
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });

    const frames = (): Record<string, unknown>[] =>
        sockets
            .last()
            .messages()
            .filter((message) => message['type'] === 'command');
    return {
        socket: () => sockets.last(),
        commands: () => frames().map((message) => message['payload'] as Record<string, unknown>),
        reply(extra) {
            const frame = [...frames()].reverse()[0];
            if (frame === undefined) throw new Error('no command in flight');
            act(() => {
                sockets.last().emit({ type: 'command-reply', id: frame['id'], reply: { ok: true, ...extra } });
            });
        }
    };
}

afterEach(cleanup);

describe('Debug ▸ Seed Test Group (§APP-028 / §SET-194)', () => {
    it('builds the group and its two monitors out of ordinary create verbs, in order', async () => {
        const h = setup();
        const before = h.commands().length;

        act(() => {
            h.socket().emit({ type: 'menu-command', command: SEED_TEST_GROUP_COMMAND });
        });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'group-create',
                name: 'Test Group',
                color: 'gray'
            });
        });
        // Nothing else went out first: the group has to exist before a workspace can join it.
        expect(h.commands().length).toBe(before + 1);
        // The REAL ack, deliberately: `group-create` is fire-and-forget on the wire, so
        // `ws/sync.ts` settles it with a bare `{ok:true}` and no id. The seed therefore reads
        // the group back — a test that answered with a `group_id` here would be testing a
        // daemon this client never talks to.
        h.reply({});

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'group-list' });
        });
        h.reply({ groups: [{ id: 'GROUP-1', name: 'Test Group' }] });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'workspace-create',
                name: 'Test Monitor 1',
                color: 'gray',
                group: 'GROUP-1'
            });
        });
        h.reply({ workspace_id: 'WS-1' });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'workspace-create',
                name: 'Test Monitor 2',
                color: 'gray',
                group: 'GROUP-1'
            });
        });
        h.reply({ workspace_id: 'WS-2' });

        // Exactly these verbs — and no activate/reveal among them, which is the Swift's own
        // behaviour: the seed appends, it does not move the user.
        const seeded = h.commands().slice(before);
        expect(seeded.map((command) => command['command'])).toEqual([
            'group-create',
            'group-list',
            'workspace-create',
            'workspace-create'
        ]);
    });

    it('ignores a seed addressed to a DIFFERENT shell window', () => {
        const h = setup();
        const before = h.commands().length;
        act(() => {
            h.socket().emit({
                type: 'menu-command',
                command: SEED_TEST_GROUP_COMMAND,
                windowID: 'someone-elses-window'
            });
        });
        expect(h.commands().length).toBe(before);
    });

    it('does not fall through to the chord replay — the seed consumes the command', async () => {
        const h = setup();
        act(() => {
            h.socket().emit({ type: 'menu-command', command: SEED_TEST_GROUP_COMMAND });
        });
        await waitFor(() => {
            expect(h.commands().at(-1)?.['command']).toBe('group-create');
        });
        // A `menu-command` the client does not recognise is replayed as a keydown; if this one
        // were, the seed would race a chord nobody pressed.
        expect(h.commands().filter((command) => command['command'] === 'group-create')).toHaveLength(1);
    });
});

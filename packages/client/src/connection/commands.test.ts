import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CommandClient,
    CommandDisconnectedError,
    CommandTimeoutError,
    isOkReply,
    replyText,
    unwrapReply
} from './commands';
import { NexConnection } from './socket';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './testing';

const PANE = '11111111-2222-4333-8444-555555555555';

interface Harness {
    readonly connection: NexConnection;
    readonly client: CommandClient;
    socket(): FakeWebSocket;
    /** The last `command` frame's payload. */
    lastCommand(): Record<string, unknown>;
    /** Answer the newest in-flight command. */
    answer(reply: Record<string, unknown>): void;
    redial(): void;
}

function harness(): Harness {
    const sockets = createFakeSocketFactory();
    const connection = new NexConnection({
        url: 'ws://daemon.test/ws',
        token: 't',
        socketFactory: sockets.factory,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 },
        heartbeatIntervalMs: 0
    });
    let counter = 0;
    const client = new CommandClient(connection, { newID: () => `id-${++counter}`, timeoutMs: 1000 });
    connection.connect();
    completeHandshake(sockets.last());

    const commandFrames = (): Record<string, unknown>[] =>
        sockets.last().messages().filter((message) => message['type'] === 'command');

    return {
        connection,
        client,
        socket: () => sockets.last(),
        lastCommand(): Record<string, unknown> {
            const frames = commandFrames();
            const last = frames[frames.length - 1];
            if (last === undefined) throw new Error('no command was sent');
            return last['payload'] as Record<string, unknown>;
        },
        answer(reply): void {
            const frames = commandFrames();
            const last = frames[frames.length - 1];
            if (last === undefined) throw new Error('no command was sent');
            sockets.last().emit({ type: 'command-reply', id: last['id'] as string, reply });
        },
        redial(): void {
            sockets.last().serverClose();
            vi.advanceTimersByTime(10);
            completeHandshake(sockets.last());
        }
    };
}

describe('CommandClient RPC', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends a wire payload and resolves on the matching reply', async () => {
        const h = harness();
        const pending = h.client.splitPane({ paneID: PANE, direction: 'vertical', name: 'worker' });

        expect(h.lastCommand()).toEqual({
            command: 'pane-split',
            pane_id: PANE,
            direction: 'vertical',
            name: 'worker'
        });

        h.answer({ ok: true, pane_id: 'NEW', workspace_id: 'W', workspace_name: 'dev' });
        const reply = await pending;
        expect(isOkReply(reply)).toBe(true);
        expect(replyText(reply, 'pane_id')).toBe('NEW');
    });

    it('routes replies by id, not arrival order', async () => {
        const h = harness();
        const first = h.client.listPanes();
        const second = h.client.listGroups();

        h.socket().emit({ type: 'command-reply', id: 'id-2', reply: { ok: true, groups: [] } });
        expect(await second).toEqual({ ok: true, groups: [] });
        expect(h.client.inFlight).toBe(1);

        h.socket().emit({ type: 'command-reply', id: 'id-1', reply: { ok: true, panes: [] } });
        expect(await first).toEqual({ ok: true, panes: [] });
        expect(h.client.inFlight).toBe(0);
    });

    it('resolves failures as data, and `expect` throws them', async () => {
        const h = harness();
        const pending = h.client.closePane({ target: 'nope' });
        h.answer({ ok: false, error: "no pane matches 'nope'" });
        const reply = await pending;

        expect(isOkReply(reply)).toBe(false);
        expect(() => unwrapReply(reply)).toThrow("no pane matches 'nope'");
    });

    it('times out a command the daemon never answers', async () => {
        const h = harness();
        const pending = h.client.ping();
        const assertion = expect(pending).rejects.toBeInstanceOf(CommandTimeoutError);
        vi.advanceTimersByTime(1000);
        await assertion;
        expect(h.client.inFlight).toBe(0);
    });

    it('rejects everything in flight when the connection drops', async () => {
        const h = harness();
        const pending = h.client.ping();
        const assertion = expect(pending).rejects.toBeInstanceOf(CommandDisconnectedError);
        h.socket().serverClose();
        await assertion;
        expect(h.client.inFlight).toBe(0);
    });

    it('encodes the wire quirks the CLI relies on', async () => {
        const h = harness();

        void h.client.movePaneToWorkspace({ paneID: PANE, workspace: 'beta', create: true });
        expect(h.lastCommand()).toEqual({ command: 'pane-move-to-workspace', pane_id: PANE, name: 'beta', text: 'true' });

        void h.client.labelWorkspace({ workspace: 'dev', op: 'add', values: ['a', 'b'] });
        expect(h.lastCommand()).toEqual({
            command: 'workspace-label',
            name: 'dev',
            label_op: 'add',
            label_values: ['a', 'b']
        });

        void h.client.setSplitRatio(PANE, 0.66);
        expect(h.lastCommand()).toEqual({ command: 'pane-resize', target: PANE, ratio: 0.66 });

        void h.client.moveWorkspace({ workspace: 'dev' });
        // `group` omitted entirely = "move to top level"; never sent as null.
        expect(h.lastCommand()).toEqual({ command: 'workspace-move', name: 'dev' });
    });

    it('refuses a resize with both or neither directive', async () => {
        const h = harness();
        await expect(h.client.resizePane({ target: PANE })).rejects.toThrow(/exactly one/);
        await expect(h.client.resizePane({ target: PANE, ratio: 0.5, delta: 0.1 })).rejects.toThrow(/exactly one/);
    });
});

describe('CommandClient reports', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function reports(socket: FakeWebSocket, type: string): Record<string, unknown>[] {
        return socket.messages().filter((message) => message['type'] === type);
    }

    it('sends focus reports and suppresses duplicates', () => {
        const h = harness();
        h.client.reportFocus('W1', PANE);
        h.client.reportFocus('W1', PANE);
        h.client.reportFocus('W1', null);

        expect(reports(h.socket(), 'focus-report')).toEqual([
            { type: 'focus-report', workspaceID: 'W1', paneID: PANE },
            { type: 'focus-report', workspaceID: 'W1', paneID: null }
        ]);
    });

    it('reports visibility and treats the active workspace as a visibility report', () => {
        const h = harness();
        h.client.reportVisibility('W1', [PANE], true);
        h.client.setActiveWorkspaceReport('W2');

        expect(reports(h.socket(), 'visibility-report')).toEqual([
            { type: 'visibility-report', workspaceID: 'W1', visiblePaneIDs: [PANE], documentVisible: true },
            { type: 'visibility-report', workspaceID: 'W2', visiblePaneIDs: [PANE], documentVisible: true }
        ]);
    });

    it('re-asserts focus and visibility after a reconnect', () => {
        const h = harness();
        h.client.reportVisibility('W1', [PANE], true);
        h.client.reportFocus('W1', PANE);

        h.redial();

        const socket = h.socket();
        expect(reports(socket, 'visibility-report')).toHaveLength(1);
        expect(reports(socket, 'focus-report')).toHaveLength(1);
        expect(reports(socket, 'focus-report')[0]).toEqual({ type: 'focus-report', workspaceID: 'W1', paneID: PANE });
    });
});

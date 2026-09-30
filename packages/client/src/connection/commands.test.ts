import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CommandClient,
    CommandDisconnectedError,
    CommandTimeoutError,
    isOkReply,
    replyText,
    unwrapReply
} from './commands';
import { KelpiConnection } from './socket';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './testing';

const PANE = '11111111-2222-4333-8444-555555555555';

interface Harness {
    readonly connection: KelpiConnection;
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
    const connection = new KelpiConnection({
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

        // #295: the client's builders are the window's gestures, so they ask for focus.
        expect(h.lastCommand()).toEqual({
            command: 'pane-split',
            pane_id: PANE,
            direction: 'vertical',
            name: 'worker',
            focus: true
        });

        h.answer({ ok: true, pane_id: 'NEW', workspace_id: 'W', workspace_name: 'dev' });
        const reply = await pending;
        expect(isOkReply(reply)).toBe(true);
        expect(replyText(reply, 'pane_id')).toBe('NEW');
    });

    /**
     * #295: on the wire an absent `focus` opens the pane in the background (the CLI default).
     * Every caller of these builders is one of the window's own gestures (New Pane, ⌘D, the
     * inspector, ⌘O), so they ask for focus unless told otherwise.
     */
    it('asks for focus on every pane-creating builder, unless told otherwise', () => {
        const h = harness();
        void h.client.createPane({ workspace: 'dev' }).catch(() => undefined);
        expect(h.lastCommand()).toEqual({ command: 'pane-create', workspace: 'dev', focus: true });
        void h.client.openFile({ path: '/notes.md', paneID: PANE }).catch(() => undefined);
        expect(h.lastCommand()).toEqual({ command: 'open', path: '/notes.md', pane_id: PANE, reuse: false, focus: true });
        void h.client.splitPane({ paneID: PANE, focus: false }).catch(() => undefined);
        expect(h.lastCommand()).toEqual({ command: 'pane-split', pane_id: PANE, focus: false });
        void h.client.createPane({ workspace: 'dev', focus: false }).catch(() => undefined);
        expect(h.lastCommand()).toEqual({ command: 'pane-create', workspace: 'dev', focus: false });
        // The move builders are gestures too: the keyboard move chords and drag-to-dock.
        void h.client.movePane({ paneID: PANE, direction: 'left' }).catch(() => undefined);
        expect(h.lastCommand()).toEqual({ command: 'pane-move', pane_id: PANE, direction: 'left', focus: true });
        void h.client.movePaneAdjacent({ target: PANE, anchor: 'main', zone: 'below' }).catch(() => undefined);
        expect(h.lastCommand()).toEqual({ command: 'pane-move-adjacent', target: PANE, anchor: 'main', zone: 'below', focus: true });
        void h.client.movePaneAdjacent({ target: PANE, anchor: 'main', zone: 'below', focus: false }).catch(() => undefined);
        expect(h.lastCommand()).toEqual({ command: 'pane-move-adjacent', target: PANE, anchor: 'main', zone: 'below', focus: false });
    });

    it('sends the WS-only verbs with snake_case fields', async () => {
        const h = harness();

        const zoom = h.client.toggleZoom({ paneID: PANE });
        expect(h.lastCommand()).toEqual({ command: 'toggle-zoom', pane_id: PANE });
        h.answer({ ok: true, pane_id: PANE, zoomed_pane_id: PANE });
        expect(isOkReply(await zoom)).toBe(true);

        const collapse = h.client.setGroupCollapsed({ groupID: 'G', collapsed: true });
        expect(h.lastCommand()).toEqual({ command: 'set-group-collapsed', group_id: 'G', collapsed: true });
        h.answer({ ok: true, group_id: 'G', collapsed: true });
        expect(isOkReply(await collapse)).toBe(true);

        const rename = h.client.renameWorkspace({ workspaceID: 'W', name: 'dev' });
        expect(h.lastCommand()).toEqual({ command: 'rename-workspace', workspace_id: 'W', name: 'dev' });
        h.answer({ ok: true, workspace_id: 'W', name: 'dev' });
        expect(isOkReply(await rename)).toBe(true);
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

        // §LAY-061: the split-path spelling, for a divider no pane can name.
        void h.client.setSplitRatioAtPath({ workspaceID: 'W1', splitPath: 'd', ratio: 0.42 });
        expect(h.lastCommand()).toEqual({
            command: 'set-split-ratio',
            workspace_id: 'W1',
            split_path: 'd',
            ratio: 0.42
        });

        void h.client.moveWorkspace({ workspace: 'dev' });
        // `group` omitted entirely = "move to top level"; never sent as null.
        expect(h.lastCommand()).toEqual({ command: 'workspace-move', name: 'dev' });

        // The group-header drag (#159): the group's own slot, not its member order.
        void h.client.moveGroup({ group: 'squad', index: 0 });
        expect(h.lastCommand()).toEqual({ command: 'group-move', name: 'squad', index: 0 });
    });

    it('speaks `group-set-repo` and carries a group’s repo on create (app-state-core §5.5)', () => {
        const h = harness();

        void h.client.setGroupRepo({ group: 'G1', repo: '/src/app', createWorktree: true });
        expect(h.lastCommand()).toEqual({ command: 'group-set-repo', name: 'G1', repo: '/src/app', create_worktree: true });
        // `repo: null` is the menu's None: the verb's `clear`, never a null field.
        void h.client.setGroupRepo({ group: 'G1', repo: null });
        expect(h.lastCommand()).toEqual({ command: 'group-set-repo', name: 'G1', clear: true });
        // A registry row by id: the daemon takes it as is.
        void h.client.setGroupRepo({ group: 'G1', repoID: 'r1' });
        expect(h.lastCommand()).toEqual({ command: 'group-set-repo', name: 'G1', repo_id: 'r1' });
        void h.client.setGroupRepo({ group: 'G1', createWorktree: false });
        expect(h.lastCommand()).toEqual({ command: 'group-set-repo', name: 'G1', create_worktree: false });

        void h.client.createGroupForWorkspaces({ name: 'app', workspaceIDs: [], repoID: 'r1', createWorktree: true });
        expect(h.lastCommand()).toEqual({
            command: 'create-group-for-workspaces',
            name: 'app',
            workspace_ids: [],
            repo_id: 'r1',
            create_worktree: true
        });
        void h.client.createGroupForWorkspaces({ name: 'plain', workspaceIDs: [] });
        expect(h.lastCommand()).toEqual({ command: 'create-group-for-workspaces', name: 'plain', workspace_ids: [] });

        void h.client.createWorkspace({ name: 'dev', group: 'G1', groupDefaults: false });
        expect(h.lastCommand()).toEqual({ command: 'workspace-create', name: 'dev', group: 'G1', group_defaults: false });
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

describe('CommandClient close preparation', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function deferred() {
        let resolve!: () => void;
        const promise = new Promise<void>(accept => { resolve = accept; });
        return { promise, resolve };
    }

    it('waits for every guard before sending a command or starting its reply timeout', async () => {
        const h = harness();
        const first = deferred(), second = deferred();
        h.client.registerCloseGuard(payload => payload['command'] === 'pane-close' ? first.promise : undefined);
        h.client.registerCloseGuard(payload => payload['command'] === 'pane-close' ? second.promise : undefined);
        const closing = h.client.closePane({ target: PANE });
        expect(h.client.inFlight).toBe(0);
        expect(() => h.lastCommand()).toThrow('no command was sent');
        await vi.advanceTimersByTimeAsync(2000);
        first.resolve(); await Promise.resolve();
        expect(() => h.lastCommand()).toThrow('no command was sent');
        second.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.lastCommand()).toEqual({ command: 'pane-close', target: PANE });
        expect(h.client.inFlight).toBe(1);
        h.answer({ ok: true }); await closing;
        h.client.dispose(); h.connection.close();
    });

    it('never sends after a rejected guard and resumes ordinary sending after unregistering it', async () => {
        const h = harness();
        const guard = vi.fn(() => Promise.reject(new Error('document is unsaved')));
        const remove = h.client.registerCloseGuard(guard);
        await expect(h.client.closePane({ target: PANE })).rejects.toThrow('document is unsaved');
        expect(() => h.lastCommand()).toThrow('no command was sent');
        expect(h.client.inFlight).toBe(0);
        remove();
        const closing = h.client.closePane({ target: PANE });
        expect(h.lastCommand()).toEqual({ command: 'pane-close', target: PANE });
        expect(guard).toHaveBeenCalledOnce();
        h.answer({ ok: true }); await closing;
        h.client.dispose(); h.connection.close();
    });

    it('rejects a prepared command if its client is disposed while the guard is pending', async () => {
        const h = harness();
        const preparing = deferred();
        const guard = vi.fn(() => preparing.promise);
        h.client.registerCloseGuard(guard);
        const closing = h.client.closePane({ target: PANE });
        const rejection = expect(closing).rejects.toBeInstanceOf(CommandDisconnectedError);
        h.client.dispose();
        preparing.resolve(); await rejection;
        expect(() => h.lastCommand()).toThrow('no command was sent');
        await expect(h.client.closePane({ target: PANE })).rejects.toBeInstanceOf(CommandDisconnectedError);
        expect(guard).toHaveBeenCalledOnce();
        h.connection.close();
    });
});

it('preserves explicit remote navigation trust grants and clears on the settings command wire', async () => {
    const h = harness();
    try {
        for (const trustedForNavigation of [true, false]) {
            const daemon = { name: 'werk', url: 'https://werk/', trustedForNavigation };
            const pending = h.client.setRemoteDaemons({ daemons: [daemon] });
            expect(h.lastCommand()).toEqual({ command: 'set-remote-daemons', daemons: [daemon] });
            h.answer({ ok: true });
            expect(await pending).toEqual({ ok: true });
        }
    } finally { h.client.dispose(); h.connection.close(); }
});

describe('worktree create progress and cancel (#294)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const commandFrames = (h: Harness): Record<string, unknown>[] => h.socket().messages().filter((message) => message['type'] === 'command');

    it('names the create, routes its command-progress frames to onProgress, and only its own', async () => {
        const h = harness();
        const seen: unknown[] = [];
        const pending = h.client.createWorkspace(
            { name: 'x', worktree: 'x', repo: '/code/app', updateMain: true, requestID: 'req-1' },
            { onProgress: (progress) => seen.push(progress) }
        );
        expect(h.lastCommand()).toMatchObject({ command: 'workspace-create', request_id: 'req-1', worktree: 'x', update_main: true });
        const id = commandFrames(h).at(-1)?.['id'] as string;
        h.socket().emit({ type: 'command-progress', id, progress: { kind: 'worktree-create', steps: [] } });
        h.socket().emit({ type: 'command-progress', id: 'someone-else', progress: { kind: 'worktree-create', steps: [{ id: 'fetch' }] } });
        expect(seen).toEqual([{ kind: 'worktree-create', steps: [] }]);
        h.answer({ ok: true, workspace_id: 'W' });
        expect(await pending).toEqual({ ok: true, workspace_id: 'W' });
        // After the reply the id is settled: a late frame goes nowhere.
        h.socket().emit({ type: 'command-progress', id, progress: { kind: 'worktree-create', steps: [] } });
        expect(seen).toHaveLength(1);
    });

    it('re-arms the deadline on every progress frame, so a long create that keeps reporting never times out', async () => {
        const h = harness();
        let settled: unknown = null;
        const pending = h.client
            .createWorkspace({ worktree: 'x', repo: '/code/app' }, { onProgress: () => {} })
            .then((reply) => { settled = reply; }, (error: unknown) => { settled = error; });
        const id = commandFrames(h).at(-1)?.['id'] as string;
        // Five minutes of steady progress, far past the 120 s worktree deadline.
        for (let second = 0; second < 300; second += 10) {
            vi.advanceTimersByTime(10_000);
            h.socket().emit({ type: 'command-progress', id, progress: { kind: 'worktree-create', steps: [] } });
        }
        await Promise.resolve();
        expect(settled).toBeNull();
        // …and silence still times out.
        vi.advanceTimersByTime(120_000);
        await pending;
        expect(settled).toBeInstanceOf(CommandTimeoutError);
    });

    it('omits request_id when there is none, and sends the cancel and prefetch verbs', () => {
        const h = harness();
        void h.client.createWorkspace({ worktree: 'x', repo: '/code/app' });
        expect(h.lastCommand()).not.toHaveProperty('request_id');
        void h.client.cancelWorkspaceCreate('req-1');
        expect(h.lastCommand()).toEqual({ command: 'workspace-create-cancel', request_id: 'req-1' });
        void h.client.prefetchRepo('R1');
        expect(h.lastCommand()).toEqual({ command: 'repo-prefetch', repo_id: 'R1' });
    });
});

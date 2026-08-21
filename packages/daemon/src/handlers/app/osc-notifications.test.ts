/**
 * §TERM-050 — the OSC desktop-notification sink.
 *
 * The parse is covered in `term/osc-notify.test.ts`; this is the half that decides whether a
 * parsed notification becomes a broadcast, and what that broadcast says. The clause the
 * checklist item leans on hardest is the cross-workspace one, so it is asserted twice: a pane
 * in a workspace that is NOT active notifies, and it notifies even while the app is frontmost
 * and that pane is "focused" inside its own (background) workspace — because a background pane
 * cannot be attended, exactly as the Swift reducer's `activeWorkspaceID` guard requires.
 */

import { describe, expect, it } from 'vitest';

import { createStore } from '../../store/index.js';
import { NOW, W1, W2, id, seededState } from '../../store/testing.js';
import { createOscNotificationSink } from './osc-notifications.js';

const PANE_A = id('dddddddd', 100);
const PANE_B = id('dddddddd', 200);

/** Two workspaces, `W1` active. `PANE_B` lives in the background one. */
function twoWorkspaces(): ReturnType<typeof createStore> {
    const store = createStore(seededState(W1, PANE_A));
    store.dispatch({
        type: 'create-workspace',
        id: W2,
        paneID: PANE_B,
        name: 'background',
        color: 'green',
        now: NOW
    });
    // `create-workspace` activates the new one; hand the active flag back to W1 so the second
    // workspace really is in the background for the assertions below.
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store;
}

interface Captured {
    readonly messages: Record<string, unknown>[];
}

function sinkFor(
    store: ReturnType<typeof createStore>,
    options: {
        readonly attended?: ReadonlySet<string>;
        readonly appActive?: boolean;
    } = {}
): { sink: ReturnType<typeof createOscNotificationSink>; captured: Captured } {
    const messages: Record<string, unknown>[] = [];
    const attended = options.attended ?? new Set<string>();
    const sink = createOscNotificationSink({
        getState: () => store.getState(),
        // "Attended" is the daemon's real predicate: a VISIBLE client with that pane focused in
        // the ACTIVE workspace. A background workspace's pane is never in the set.
        isPaneFocused: (paneID) => attended.has(paneID),
        isAppActive: () => options.appActive ?? true,
        broadcast: (message) => messages.push(message)
    });
    return { sink, captured: { messages } };
}

describe('the OSC notification sink', () => {
    it('posts a notification attributed to the pane, with the agent path’s dedup identity', () => {
        const store = twoWorkspaces();
        const { sink, captured } = sinkFor(store);
        sink(PANE_A, { title: 'Agent', body: 'needs your approval' });
        expect(captured.messages).toEqual([
            {
                type: 'notification',
                kind: 'osc',
                paneID: PANE_A,
                workspaceID: W1,
                title: 'Agent',
                body: 'needs your approval',
                dedupeKey: `nex-${PANE_A}`
            }
        ]);
    });

    it('falls back to the pane title, then the workspace name, when OSC 9 carried none', () => {
        const store = twoWorkspaces();
        const { sink, captured } = sinkFor(store);
        sink(PANE_A, { title: null, body: 'build finished' });
        expect(captured.messages[0]?.title).toBe('dev');

        store.dispatch({ type: 'pane-title-changed', paneID: PANE_A, title: 'npm run build', now: NOW });
        sink(PANE_A, { title: null, body: 'build finished' });
        expect(captured.messages[1]?.title).toBe('npm run build');
    });

    it('suppresses only when the pane is attended AND the app is active (the Swift guard)', () => {
        const store = twoWorkspaces();
        const attended = new Set([PANE_A]);
        const { sink, captured } = sinkFor(store, { attended, appActive: true });
        sink(PANE_A, { title: null, body: 'quiet' });
        expect(captured.messages).toEqual([]);

        const backgrounded = sinkFor(store, { attended, appActive: false });
        backgrounded.sink(PANE_A, { title: null, body: 'loud' });
        expect(backgrounded.captured.messages).toHaveLength(1);
    });

    it('notifies for a pane in a NON-active workspace, and names that workspace', () => {
        const store = twoWorkspaces();
        expect(store.getState().lastActiveWorkspaceID).toBe(W1);
        const { sink, captured } = sinkFor(store, { appActive: true });
        sink(PANE_B, { title: null, body: 'the background pane spoke' });
        expect(captured.messages).toHaveLength(1);
        expect(captured.messages[0]).toMatchObject({
            paneID: PANE_B,
            workspaceID: W2,
            title: 'background',
            body: 'the background pane spoke'
        });
    });

    /**
     * The one that would break if routing ever went through the active workspace: a client can
     * report a focused pane per workspace, and the background workspace's own focused pane is
     * still not being LOOKED at. `isPaneAttended` is what encodes that, and the sink must ask it
     * with the pane's OWN workspace id rather than with the active one.
     */
    it('asks about the pane’s own workspace, not the active one', () => {
        const store = twoWorkspaces();
        const asked: { paneID: string; workspaceID: string }[] = [];
        const messages: Record<string, unknown>[] = [];
        const sink = createOscNotificationSink({
            getState: () => store.getState(),
            isPaneFocused: (paneID, workspaceID) => {
                asked.push({ paneID, workspaceID });
                return false;
            },
            isAppActive: () => true,
            broadcast: (message) => messages.push(message)
        });
        sink(PANE_B, { title: null, body: 'x' });
        expect(asked).toEqual([{ paneID: PANE_B, workspaceID: W2 }]);
        expect(messages).toHaveLength(1);
    });

    it('is a total no-op for a pane no workspace owns', () => {
        const store = twoWorkspaces();
        const { sink, captured } = sinkFor(store);
        sink(id('dddddddd', 999), { title: null, body: 'nowhere' });
        expect(captured.messages).toEqual([]);
    });

    it('does not touch the store — a notification is not activity in the pane', () => {
        const store = twoWorkspaces();
        const before = store.getState();
        const { sink } = sinkFor(store);
        sink(PANE_A, { title: 'x', body: 'y' });
        expect(store.getState()).toBe(before);
    });
});

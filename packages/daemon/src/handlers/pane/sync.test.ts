import { describe, expect, it } from 'vitest';

import { W1, W2, harness, seedSplit, seedWorkspace, testID } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const P3 = testID('3', 3);
const MD = testID('D', 4);

/** dev: three shell panes, the second labelled "worker-1". */
function trio() {
    const h = harness();
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'worker-1' });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P2, paneID: P3 });
    return h;
}

describe('pane-sync', () => {
    it('status is read-only and reports the empty group while sync is off', () => {
        const h = trio();
        const reply = h.run({ command: 'pane-sync', pane_id: P1, action: 'status' });

        expect(reply.only()).toEqual({
            ok: true,
            workspace_id: W1,
            workspace_name: 'dev',
            active: false,
            synced_pane_ids: [],
            excluded: []
        });
        expect(h.workspace(W1).isSyncInputActive).toBe(false);
        expect(h.pty.syncGroupCalls).toEqual([]);
    });

    it('on activates the workspace and pushes the sorted broadcast group', () => {
        const h = trio();
        const reply = h.run({ command: 'pane-sync', pane_id: P1, action: 'on' });

        expect(reply.only()).toEqual({
            ok: true,
            workspace_id: W1,
            workspace_name: 'dev',
            active: true,
            synced_pane_ids: [P1, P2, P3].sort(),
            excluded: []
        });
        expect(h.workspace(W1).isSyncInputActive).toBe(true);
        expect(h.pty.syncGroups.get(W1)).toEqual([P1, P2, P3]);
    });

    it('never syncs a lone terminal to itself, and filters non-shell panes', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        h.store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: MD,
            filePath: '/notes.md',
            now: Date.now()
        });

        expect(h.run({ command: 'pane-sync', workspace: 'dev', action: 'on' }).only()).toMatchObject({
            active: true,
            synced_pane_ids: []
        });
        expect(h.pty.syncGroups.has(W1)).toBe(false);
    });

    it('toggle flips the current value', () => {
        const h = trio();
        expect(h.run({ command: 'pane-sync', pane_id: P1, action: 'toggle' }).only()).toMatchObject({
            active: true
        });
        expect(h.run({ command: 'pane-sync', pane_id: P1, action: 'TOGGLE' }).only()).toMatchObject({
            active: false,
            synced_pane_ids: []
        });
    });

    it('off deactivates and empties the group', () => {
        const h = trio();
        h.run({ command: 'pane-sync', pane_id: P1, action: 'on' });
        const reply = h.run({ command: 'pane-sync', pane_id: P1, action: 'off' });

        expect(reply.only()).toMatchObject({ active: false, synced_pane_ids: [], excluded: [] });
        expect(h.pty.syncGroups.has(W1)).toBe(false);
    });

    it('resolves the scope through the PARKED-inclusive lookup', () => {
        const h = trio();
        h.store.dispatch({ type: 'park-pane', workspaceID: W1, paneID: P3 });

        expect(h.run({ command: 'pane-sync', pane_id: P3, action: 'status' }).only()).toMatchObject({
            workspace_id: W1
        });
    });

    it('prefers an explicit --workspace over the caller pane', () => {
        const h = trio();
        seedWorkspace(h, { id: W2, name: 'beta', paneID: testID('B', 8) });

        expect(
            h.run({ command: 'pane-sync', pane_id: P1, workspace: 'beta', action: 'status' }).only()
        ).toMatchObject({ workspace_id: W2, workspace_name: 'beta' });
    });

    it('reports scope and action errors verbatim', () => {
        const h = trio();

        expect(h.run({ command: 'pane-sync', workspace: 'nope', action: 'on' }).only()).toEqual({
            ok: false,
            error: 'workspace not found: nope'
        });
        expect(h.run({ command: 'pane-sync', action: 'on' }).only()).toEqual({
            ok: false,
            error: 'pane sync requires --workspace or NEX_PANE_ID'
        });
        expect(h.run({ command: 'pane-sync', pane_id: testID('F', 9), action: 'on' }).only()).toEqual({
            ok: false,
            error: 'pane sync requires --workspace or NEX_PANE_ID'
        });
        expect(h.run({ command: 'pane-sync', pane_id: P1, action: 'ON!' }).only()).toEqual({
            ok: false,
            error: "unknown sync action 'on!' (valid: on, off, toggle, status)"
        });
        expect(h.workspace(W1).isSyncInputActive).toBe(false);
    });

    it('replies from POST-mutation state, so a staged-while-off exclusion is not reported', () => {
        const h = trio();
        // Stage an exclusion while sync is off, then turn sync on: the reducer clears the set
        // on every activation transition, and the reply must say so (PLAN.md deliberate fix).
        h.run({ command: 'pane-sync-exclude', pane_id: P1, target: 'worker-1', excluded: true });
        expect(h.workspace(W1).syncInputExcluded).toEqual([P2]);

        const reply = h.run({ command: 'pane-sync', pane_id: P1, action: 'on' });

        expect(reply.only()).toMatchObject({
            active: true,
            excluded: [],
            synced_pane_ids: [P1, P2, P3].sort()
        });
        expect(h.workspace(W1).syncInputExcluded).toEqual([]);
    });
});

describe('pane-sync-exclude', () => {
    it('excludes a pane, drops it from the group and reports its label', () => {
        const h = trio();
        h.run({ command: 'pane-sync', pane_id: P1, action: 'on' });

        const reply = h.run({ command: 'pane-sync-exclude', pane_id: P1, target: 'worker-1', excluded: true });

        expect(reply.only()).toEqual({
            ok: true,
            workspace_id: W1,
            workspace_name: 'dev',
            active: true,
            synced_pane_ids: [P1, P3].sort(),
            excluded: [{ id: P2, label: 'worker-1' }]
        });
        expect(h.pty.syncGroups.get(W1)).toEqual([P1, P3]);
    });

    it('collapses the group to empty when fewer than two panes remain', () => {
        const h = trio();
        h.run({ command: 'pane-sync', pane_id: P1, action: 'on' });
        h.run({ command: 'pane-sync-exclude', target: P2, excluded: true });

        const reply = h.run({ command: 'pane-sync-exclude', target: P3, excluded: true });

        expect(reply.only()).toMatchObject({
            active: true,
            synced_pane_ids: [],
            excluded: [{ id: P2, label: 'worker-1' }, { id: P3 }].sort((a, b) =>
                a.id < b.id ? -1 : 1
            )
        });
        expect(h.pty.syncGroups.has(W1)).toBe(false);
    });

    it('includes a pane back into the group', () => {
        const h = trio();
        h.run({ command: 'pane-sync', pane_id: P1, action: 'on' });
        h.run({ command: 'pane-sync-exclude', target: P2, excluded: true });

        const reply = h.run({ command: 'pane-sync-exclude', target: P2, excluded: false });

        expect(reply.only()).toMatchObject({
            excluded: [],
            synced_pane_ids: [P1, P2, P3].sort()
        });
    });

    it('skips excluded ids whose pane has gone away', () => {
        const h = trio();
        h.run({ command: 'pane-sync', pane_id: P1, action: 'on' });
        h.run({ command: 'pane-sync-exclude', target: P2, excluded: true });
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P2 });

        expect(h.run({ command: 'pane-sync', pane_id: P1, action: 'status' }).only()).toMatchObject({
            // The dead id stays in the stored set but is skipped in the reply.
            excluded: [],
            synced_pane_ids: [P1, P3].sort()
        });
        expect(h.workspace(W1).syncInputExcluded).toEqual([P2]);
    });

    it('passes resolution failures through and mutates nothing', () => {
        const h = trio();
        expect(h.run({ command: 'pane-sync-exclude', target: 'ghost', excluded: true }).only()).toEqual({
            ok: false,
            error: "label 'ghost' requires --workspace <name-or-id> when called from outside a Nex pane"
        });
        expect(h.workspace(W1).syncInputExcluded).toEqual([]);
    });
});

import { describe, expect, it } from 'vitest';

import { allPaneIDs } from '@nex/core/layout';

import { W1, W2, harness, seedSplit, seedWorkspace, testID } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const P3 = testID('3', 3);
const NEWWS = testID('7', 7);

/** dev: P1 | P2 (P1 first, ratio 0.5), P2 labelled "worker-1". */
function pair() {
    const h = harness({ minted: [NEWWS] });
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'worker-1' });
    return h;
}

describe('pane-resize', () => {
    it('sets a first-child share directly', () => {
        const h = pair();
        const reply = h.run({ command: 'pane-resize', target: P1, ratio: 0.7 });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P1,
            workspace_id: W1,
            workspace_name: 'dev',
            split_path: 'd',
            ratio: 0.7,
            target_share: 0.7
        });
        expect(h.workspace(W1).layout).toMatchObject({ kind: 'split', ratio: 0.7 });
        expect(h.workspace(W1).currentLayoutIndex).toBeNull();
    });

    it("translates a second child's share into 1 - ratio and keeps its label", () => {
        const h = pair();
        const reply = h.run({ command: 'pane-resize', target: 'worker-1', workspace: 'dev', ratio: 0.7 });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev',
            split_path: 'd',
            ratio: 0.30000000000000004,
            target_share: 0.7,
            label: 'worker-1'
        });
        expect(h.workspace(W1).layout).toMatchObject({ ratio: 0.30000000000000004 });
    });

    it('nudges the current share by --grow / --shrink deltas', () => {
        const h = pair();
        const grown = h.run({ command: 'pane-resize', target: P1, delta: 0.05 }).only();
        expect(grown['target_share']).toBeCloseTo(0.55, 10);

        const shrunk = h.run({ command: 'pane-resize', target: P1, delta: -0.15 }).only();
        expect(shrunk['target_share']).toBeCloseTo(0.4, 10);
        expect(h.workspace(W1).layout).toMatchObject({ kind: 'split' });
    });

    it('clamps the effective share to [0.1, 0.9] and reports the STORED ratio', () => {
        const h = pair();
        expect(h.run({ command: 'pane-resize', target: P1, ratio: 0.99 }).only()).toMatchObject({
            ratio: 0.9,
            target_share: 0.9
        });
        // 1 - 0.9 lands a hair under the clamp floor, so the model nudges it back to 0.1.
        expect(h.run({ command: 'pane-resize', target: P2, ratio: 0.99 }).only()).toMatchObject({
            ratio: 0.1,
            target_share: 0.9
        });
    });

    it('refuses a sole leaf', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });

        expect(h.run({ command: 'pane-resize', target: P1, ratio: 0.7 }).only()).toEqual({
            ok: false,
            error: `pane ${P1} has no sibling to resize against (it is the only pane in its workspace)`
        });
    });

    it('refuses while a pane is zoomed', () => {
        const h = pair();
        h.store.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
        expect(h.workspace(W1).zoomedPaneID).not.toBeNull();

        expect(h.run({ command: 'pane-resize', target: P1, ratio: 0.7 }).only()).toEqual({
            ok: false,
            error: 'cannot resize while a pane is zoomed — un-zoom first'
        });
    });

    it('requires a directive', () => {
        const h = pair();
        expect(h.run({ command: 'pane-resize', target: P1 }).only()).toEqual({
            ok: false,
            error: 'pane resize requires --ratio or --grow/--shrink'
        });
    });
});

describe('pane-move (directional)', () => {
    it('focuses the caller pane and swaps it with its neighbour', () => {
        const h = pair();
        expect(h.workspace(W1).focusedPaneID).toBe(P2);

        h.runSilent({ command: 'pane-move', pane_id: P1, direction: 'right' });

        expect(h.workspace(W1).focusedPaneID).toBe(P1);
        expect(allPaneIDs(h.workspace(W1).layout)).toEqual([P2, P1]);
    });

    it('drops silently when the pane belongs to no workspace', () => {
        const h = pair();
        h.runSilent({ command: 'pane-move', pane_id: P3, direction: 'left' });
        expect(allPaneIDs(h.workspace(W1).layout)).toEqual([P1, P2]);
    });
});

describe('pane-move-adjacent', () => {
    /** dev: P1 | (P2 / P3) */
    function trio() {
        const h = pair();
        seedSplit(h, { workspaceID: W1, sourcePaneID: P2, paneID: P3 });
        return h;
    }

    it('re-parents the moved pane onto the anchor edge and echoes the wire zone', () => {
        const h = trio();
        const reply = h.run({
            command: 'pane-move-adjacent',
            target: P3,
            anchor: P1,
            zone: 'above'
        });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P3,
            anchor_id: P1,
            zone: 'above',
            workspace_id: W1,
            workspace_name: 'dev'
        });
        expect(h.workspace(W1).layout).toMatchObject({
            kind: 'split',
            direction: 'horizontal',
            first: {
                kind: 'split',
                direction: 'vertical',
                first: { kind: 'leaf', paneID: P3 },
                second: { kind: 'leaf', paneID: P1 }
            },
            second: { kind: 'leaf', paneID: P2 }
        });
        expect(h.workspace(W1).focusedPaneID).toBe(P3);
    });

    it('resolves a label anchor within the moved pane\'s workspace', () => {
        const h = trio();
        const reply = h.run({
            command: 'pane-move-adjacent',
            target: P3,
            anchor: 'worker-1',
            zone: 'right-of'
        });
        expect(reply.only()).toMatchObject({ anchor_id: P2, zone: 'right-of' });
    });

    it('reports a missing anchor with the workspace-scoped message', () => {
        const h = trio();
        expect(
            h.run({ command: 'pane-move-adjacent', target: P3, anchor: 'nope', zone: 'below' }).only()
        ).toEqual({ ok: false, error: "no pane matching 'nope' in workspace 'dev'" });
    });

    it('refuses an anchor that lives in another workspace', () => {
        const h = trio();
        seedWorkspace(h, { id: W2, name: 'beta', paneID: testID('B', 8) });

        expect(
            h.run({
                command: 'pane-move-adjacent',
                target: P3,
                anchor: testID('B', 8),
                zone: 'below'
            }).only()
        ).toEqual({
            ok: false,
            error: `no pane matching '${testID('B', 8)}' in workspace 'dev'`
        });
    });

    it('refuses moving a pane adjacent to itself', () => {
        const h = trio();
        expect(
            h.run({ command: 'pane-move-adjacent', target: P3, anchor: P3, zone: 'below' }).only()
        ).toEqual({ ok: false, error: 'cannot move a pane adjacent to itself' });
        expect(allPaneIDs(h.workspace(W1).layout)).toEqual([P1, P2, P3]);
    });
});

describe('pane-move-to-workspace', () => {
    it('moves the pane with the LENIENT (case-insensitive) resolver and switches the active workspace', () => {
        const h = pair();
        seedWorkspace(h, { id: W2, name: 'Beta', paneID: P3 });

        h.runSilent({
            command: 'pane-move-to-workspace',
            pane_id: P2,
            name: 'beta',
            create: false
        });

        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1]);
        expect(h.workspace(W2).panes.map((pane) => pane.id)).toEqual([P3, P2]);
        expect(h.state().lastActiveWorkspaceID).toBe(W2);
        // Both broadcast groups are refreshed: the move bypasses per-workspace bookkeeping.
        expect(h.pty.syncGroupCalls.map((call) => call.workspaceID)).toEqual([W1, W2]);
    });

    it('creates an EMPTY destination workspace when create is set', () => {
        const h = pair();

        h.runSilent({
            command: 'pane-move-to-workspace',
            pane_id: P2,
            name: 'gamma',
            text: 'true',
            create: true
        });

        const created = h.workspace(NEWWS);
        expect(created.name).toBe('gamma');
        expect(created.panes.map((pane) => pane.id)).toEqual([P2]);
        expect(created.layout).toEqual({ kind: 'leaf', paneID: P2 });
        expect(created.focusedPaneID).toBe(P2);
        expect(h.state().topLevelOrder.at(-1)).toEqual({ kind: 'workspace', id: NEWWS });
        // No placeholder pane, and therefore no stray PTY.
        expect(h.pty.spawns).toEqual([]);
    });

    it('drops when the destination is unknown and create is not set', () => {
        const h = pair();
        h.runSilent({
            command: 'pane-move-to-workspace',
            pane_id: P2,
            name: 'gamma',
            create: false
        });

        expect(h.state().workspaces).toHaveLength(1);
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1, P2]);
    });

    it('drops a move onto the pane\'s own workspace and an unknown pane', () => {
        const h = pair();
        h.runSilent({ command: 'pane-move-to-workspace', pane_id: P2, name: 'dev', create: false });
        h.runSilent({ command: 'pane-move-to-workspace', pane_id: P3, name: 'dev', create: true });

        expect(h.state().workspaces).toHaveLength(1);
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1, P2]);
    });
});

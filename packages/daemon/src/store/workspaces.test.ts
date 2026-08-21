import { groupSidebarID } from '@nex/core/codec';
import { describe, expect, it } from 'vitest';
import {
    groupByID,
    groupIDForWorkspace,
    sidebarWorkspaceOrder,
    visibleWorkspaceOrder,
    workspaceByID
} from './derived.js';
import { harness, id, NOW, topLevelWorkspaceIDs, W1, W2 } from './testing.js';
import type { DaemonState, DomainAction } from './types.js';

const W3 = id('bbbbbbbb', 3);
const G1 = id('cccccccc', 1);
const G2 = id('cccccccc', 2);

function create(workspaceID: string, name: string, extra: Partial<DomainAction> = {}): DomainAction {
    return {
        type: 'create-workspace',
        id: workspaceID,
        paneID: `${workspaceID}-pane`,
        name,
        color: 'blue',
        now: NOW,
        ...extra
    } as DomainAction;
}

function seeded(): DaemonState {
    const h = harness();
    h.dispatch(create(W1, 'alpha'), create(W2, 'beta'), create(W3, 'gamma'));
    return h.state();
}

describe('workspace creation', () => {
    it('creates one shell pane, focuses it and appends to the sidebar', () => {
        const h = harness();
        h.dispatch(create(W1, 'My App!'));
        const workspace = workspaceByID(h.state(), W1);
        expect(workspace).toMatchObject({ name: 'My App!', slug: `my-app-${W1.slice(0, 8)}` });
        expect(workspace?.panes).toHaveLength(1);
        expect(workspace?.focusedPaneID).toBe(`${W1}-pane`);
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1]);
        expect(h.state().lastActiveWorkspaceID).toBe(W1);
    });

    it('normalizes the profile assignment ("default" and blanks mean null)', () => {
        const h = harness();
        h.dispatch(create(W1, 'alpha', { profileName: ' default ' }));
        expect(workspaceByID(h.state(), W1)?.profileName).toBeNull();
        h.dispatch({ type: 'set-workspace-profile', id: W1, profileName: '  work  ' });
        expect(workspaceByID(h.state(), W1)?.profileName).toBe('work');
    });

    it('places near the previously active workspace when asked', () => {
        const h = harness(seeded());
        h.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
        h.dispatch(create(id('bbbbbbbb', 4), 'delta', { placement: 'near-selection' }));
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1, id('bbbbbbbb', 4), W2, W3]);
    });

    it('creates into a group and expands it', () => {
        const h = harness(seeded());
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            { type: 'move-workspace-to-group', id: W2, groupID: G1, index: null },
            { type: 'toggle-group-collapse', id: G1 }
        );
        expect(groupByID(h.state(), G1)?.isCollapsed).toBe(true);
        h.dispatch(create(id('bbbbbbbb', 5), 'inside', { groupID: G1 }));
        const group = groupByID(h.state(), G1);
        expect(group?.childOrder).toEqual([W2, id('bbbbbbbb', 5)]);
        expect(group?.isCollapsed).toBe(false);
    });
});

describe('workspace deletion', () => {
    it('scrubs the sidebar order and re-points the active workspace by lastAccessedAt', () => {
        const h = harness(seeded());
        h.dispatch(
            { type: 'set-active-workspace', id: W2, now: NOW + 5_000 },
            { type: 'set-active-workspace', id: W1, now: NOW + 10_000 },
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            { type: 'move-workspace-to-group', id: W3, groupID: G1, index: null },
            { type: 'delete-workspace', id: W1 }
        );
        expect(workspaceByID(h.state(), W1)).toBeNull();
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W2]);
        expect(h.state().lastActiveWorkspaceID).toBe(W2);

        h.dispatch({ type: 'delete-workspaces', ids: [W3] });
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([]);
    });
});

describe('labels and presets', () => {
    it('adds, dedupes and back-fills a gray preset per introduced label', () => {
        const h = harness(seeded());
        h.dispatch({ type: 'workspace-labels', id: W1, op: 'add', values: ['wip', ' wip ', 'client-x'] });
        expect(workspaceByID(h.state(), W1)?.labels).toEqual(['wip', 'client-x']);
        expect(h.state().labelPresets.map((preset) => preset.name)).toEqual(['wip', 'client-x']);
        expect(h.state().labelPresets[0]?.color).toEqual({ kind: 'named', color: 'gray' });
    });

    it('never wipes labels via an all-empty `set`', () => {
        const h = harness(seeded());
        h.dispatch({ type: 'workspace-labels', id: W1, op: 'add', values: ['keep'] });
        const before = h.state();
        h.dispatch({ type: 'workspace-labels', id: W1, op: 'set', values: ['  ', ''] });
        expect(h.state()).toBe(before);
    });

    it('clears labels but leaves presets intact', () => {
        const h = harness(seeded());
        h.dispatch(
            { type: 'workspace-labels', id: W1, op: 'add', values: ['wip'] },
            { type: 'workspace-labels', id: W1, op: 'clear', values: [] }
        );
        expect(workspaceByID(h.state(), W1)?.labels).toEqual([]);
        expect(h.state().labelPresets).toHaveLength(1);
    });

    it('truncates labels to 64 characters', () => {
        const h = harness(seeded());
        h.dispatch({ type: 'workspace-labels', id: W1, op: 'add', values: ['x'.repeat(80)] });
        expect(workspaceByID(h.state(), W1)?.labels[0]).toHaveLength(64);
    });

    it('bulk-applies a label without back-filling a preset', () => {
        const h = harness(seeded());
        h.dispatch({ type: 'set-bulk-label', ids: [W1, W2], label: 'batch', apply: true });
        expect(workspaceByID(h.state(), W1)?.labels).toEqual(['batch']);
        expect(workspaceByID(h.state(), W2)?.labels).toEqual(['batch']);
        expect(h.state().labelPresets).toHaveLength(0);
        h.dispatch({ type: 'set-bulk-label', ids: [W1], label: 'batch', apply: false });
        expect(workspaceByID(h.state(), W1)?.labels).toEqual([]);
    });

    it('refuses a preset rename that collides with another preset', () => {
        const h = harness(seeded());
        h.dispatch(
            { type: 'add-label-preset', name: 'one', color: { kind: 'named', color: 'blue' } },
            { type: 'add-label-preset', name: 'two', color: { kind: 'named', color: 'red' } }
        );
        const before = h.state();
        h.dispatch({
            type: 'update-label-preset',
            id: 'two',
            name: 'one',
            color: { kind: 'named', color: 'red' }
        });
        expect(h.state()).toBe(before);
        h.dispatch({
            type: 'update-label-preset',
            id: 'two',
            name: 'two',
            color: { kind: 'custom', hex: '#ff8800' }
        });
        expect(h.state().labelPresets[1]?.color).toEqual({ kind: 'custom', hex: '#ff8800' });
    });
});

describe('sidebar ordering', () => {
    it('moves a top-level workspace with pre-removal bounds and mirrors the flat array', () => {
        const h = harness(seeded());
        h.dispatch({ type: 'move-workspace', id: W3, toIndex: 0 });
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W3, W1, W2]);
        expect(h.state().workspaces.map((workspace) => workspace.id)).toEqual([W3, W1, W2]);

        const before = h.state();
        h.dispatch({ type: 'move-workspace', id: W3, toIndex: 99 });
        expect(h.state()).toBe(before);
    });

    it('moves a block of workspaces into a group in one pass', () => {
        const h = harness(seeded());
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            { type: 'toggle-group-collapse', id: G1 },
            { type: 'move-workspaces-to-group', ids: [W3, W1], groupID: G1, index: null }
        );
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W3, W1]);
        expect(groupByID(h.state(), G1)?.isCollapsed).toBe(false); // bulk always expands
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W2]);
        expect(groupIDForWorkspace(h.state(), W1)).toBe(G1);
    });

    it('hides collapsed members from visibleWorkspaceOrder but not from the CLI order', () => {
        const h = harness(seeded());
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            { type: 'move-workspaces-to-group', ids: [W2], groupID: G1, index: null },
            { type: 'set-group-collapsed', id: G1, collapsed: true }
        );
        expect(visibleWorkspaceOrder(h.state())).toEqual([W1, W3]);
        expect(sidebarWorkspaceOrder(h.state())).toEqual([W1, W3, W2]);
    });
});

/**
 * §WS-120 — `move-workspace-to-group`'s four rules, each on its own.
 *
 * The one that matters and cannot be seen from the outside is the ORDER: the destination is
 * validated before anything is detached. Detach-then-validate loses the row entirely — it is
 * gone from the top-level order and from every group's `childOrder`, which is a workspace that
 * exists in `state.workspaces` and is reachable from no sidebar entry at all.
 */
describe('moving one workspace into a group (WS-120)', () => {
    function grouped(): ReturnType<typeof harness> {
        const h = harness(seeded());
        h.dispatch({ type: 'create-group', id: G1, name: 'Client', now: NOW });
        return h;
    }

    it('validates the destination BEFORE detaching, so a stale group id cannot orphan the row', () => {
        const h = grouped();
        const before = h.state();
        h.dispatch({ type: 'move-workspace-to-group', id: W2, groupID: id('cccccccc', 9), index: null });
        // Untouched, not merely "not in the missing group": same object, same sidebar slot.
        expect(h.state()).toBe(before);
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1, W2, W3]);
        expect(groupIDForWorkspace(h.state(), W2)).toBeNull();
    });

    it('is inert for a workspace that does not exist', () => {
        const h = grouped();
        const before = h.state();
        h.dispatch({ type: 'move-workspace-to-group', id: id('bbbbbbbb', 9), groupID: G1, index: null });
        expect(h.state()).toBe(before);
    });

    it('clamps an out-of-range index and appends when it is null', () => {
        const h = grouped();
        h.dispatch(
            { type: 'move-workspace-to-group', id: W1, groupID: G1, index: null },
            // Way past the end: clamped to the tail rather than dropped (the Swift clamps too).
            { type: 'move-workspace-to-group', id: W2, groupID: G1, index: 99 },
            // Negative: clamped to the head.
            { type: 'move-workspace-to-group', id: W3, groupID: G1, index: -5 }
        );
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W3, W1, W2]);
        expect(topLevelWorkspaceIDs(h.state())).toEqual([]);
    });

    it('moves back out to the top level at the index it was given', () => {
        const h = grouped();
        h.dispatch(
            { type: 'move-workspace-to-group', id: W1, groupID: G1, index: null },
            { type: 'move-workspace-to-group', id: W1, groupID: null, index: 0 }
        );
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([]);
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1, W2, W3]);
    });

    it('expands a collapsed destination only while `expand-group-on-workspace-drop` is on', () => {
        const off = grouped();
        off.dispatch(
            { type: 'set-group-collapsed', id: G1, collapsed: true },
            { type: 'move-workspace-to-group', id: W2, groupID: G1, index: null, expandOnDrop: false }
        );
        expect(groupByID(off.state(), G1)?.childOrder).toEqual([W2]);
        expect(groupByID(off.state(), G1)?.isCollapsed).toBe(true);

        const on = grouped();
        on.dispatch(
            { type: 'set-group-collapsed', id: G1, collapsed: true },
            { type: 'move-workspace-to-group', id: W2, groupID: G1, index: null, expandOnDrop: true }
        );
        expect(groupByID(on.state(), G1)?.isCollapsed).toBe(false);

        // Absent = the Swift default and the behaviour the verb had before the setting existed.
        const fallback = grouped();
        fallback.dispatch(
            { type: 'set-group-collapsed', id: G1, collapsed: true },
            { type: 'move-workspace-to-group', id: W2, groupID: G1, index: null }
        );
        expect(groupByID(fallback.state(), G1)?.isCollapsed).toBe(false);
    });
});

describe('groups', () => {
    it('inserts a new group into the slot vacated by its first member', () => {
        const h = harness(seeded());
        // [W1, W2, W3] -> grouping W2 puts the header where W2 was.
        h.dispatch({
            type: 'create-group',
            id: G1,
            name: 'Client',
            now: NOW,
            initialWorkspaceIDs: [W2],
            placement: 'near-selection'
        });
        expect(h.state().topLevelOrder).toEqual([
            { kind: 'workspace', id: W1 },
            groupSidebarID(G1),
            { kind: 'workspace', id: W3 }
        ]);
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W2]);
    });

    it('appends when no anchor resolves and ignores a blank name', () => {
        const h = harness(seeded());
        h.dispatch({ type: 'create-group', id: G1, name: '  Ops  ', now: NOW });
        expect(h.state().topLevelOrder.at(-1)).toEqual(groupSidebarID(G1));
        expect(groupByID(h.state(), G1)?.name).toBe('Ops');

        const before = h.state();
        h.dispatch({ type: 'create-group', id: G2, name: '   ', now: NOW });
        expect(h.state()).toBe(before);
    });

    it('promotes children into the group slot on a non-cascading delete', () => {
        const h = harness(seeded());
        h.dispatch(
            {
                type: 'create-group',
                id: G1,
                name: 'Client',
                now: NOW,
                initialWorkspaceIDs: [W2, W3],
                placement: 'near-selection'
            },
            { type: 'delete-group', id: G1, cascade: false }
        );
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1, W2, W3]);
        expect(h.state().groups).toHaveLength(0);
    });

    it('deletes member workspaces on a cascading delete', () => {
        const h = harness(seeded());
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W2, W3] },
            { type: 'set-active-workspace', id: W2, now: NOW + 1000 },
            { type: 'delete-group', id: G1, cascade: true }
        );
        expect(h.state().workspaces.map((workspace) => workspace.id)).toEqual([W1]);
        expect(h.state().lastActiveWorkspaceID).toBe(W1);
    });

    it('reorders members explicitly, keeping omitted ones at the tail', () => {
        const h = harness(seeded());
        h.dispatch({
            type: 'create-group',
            id: G1,
            name: 'Client',
            now: NOW,
            initialWorkspaceIDs: [W1, W2, W3]
        });
        h.dispatch({ type: 'reorder-group', id: G1, order: [W3] });
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W3, W1, W2]);

        const before = h.state();
        h.dispatch({ type: 'reorder-group', id: G1, order: [W3, W3] });
        expect(h.state()).toBe(before);
        h.dispatch({ type: 'reorder-group', id: G1, order: ['not-a-member'] });
        expect(h.state()).toBe(before);
    });

    it('sorts members by name and by last activity, stably', () => {
        const h = harness(seeded());
        h.dispatch({
            type: 'create-group',
            id: G1,
            name: 'Client',
            now: NOW,
            initialWorkspaceIDs: [W2, W1, W3]
        });
        h.dispatch({ type: 'sort-group', id: G1, by: 'name' });
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W1, W2, W3]); // alpha, beta, gamma

        h.dispatch({
            type: 'pane-title-changed',
            paneID: `${W3}-pane`,
            title: 'busy',
            now: NOW + 120_000
        });
        h.dispatch({ type: 'sort-group', id: G1, by: 'last-activity', descending: true });
        expect(groupByID(h.state(), G1)?.childOrder[0]).toBe(W3);
        // Ties (W1/W2 share a timestamp) keep their prior relative order.
        expect(groupByID(h.state(), G1)?.childOrder.slice(1)).toEqual([W1, W2]);
    });
});

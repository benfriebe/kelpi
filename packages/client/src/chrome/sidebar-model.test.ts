import {
    createStore as createDaemonStore,
    emptyDaemonState,
    visibleWorkspaceOrder,
    type DaemonState
} from '@nex/daemon/store';
import { describe, expect, it } from 'vitest';

import { createNexStore } from '../state/store';
import { selectSidebarEntries } from '../state/selectors';
import {
    applyGroupDrop,
    applyWorkspaceDrop,
    buildDropZones,
    buildGroupSpans,
    filteredRows,
    groupCommit,
    locateWorkspace,
    orderModelFromEntries,
    projectEntries,
    renderedRows,
    resolveDropTarget,
    resolveGroupDropIndex,
    visibleOrderFromEntries,
    workspaceCommit
} from './sidebar-model';
import type { ChromeSidebarEntry } from './types';

const HOME = '/Users/test';
const W = (n: number): string => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const P = (n: number): string => `dddddddd-0000-4000-8000-00000000000${n}`;
const G1 = 'cccccccc-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

/**
 * Sidebar order after these dispatches: `alpha`, `delta`, then the group `squad [beta, gamma]`
 * — `create-group` appends its header at the end of `topLevelOrder`, and the two moved
 * workspaces leave their top-level slots. Asserting the daemon's real placement (rather than
 * the one that reads nicest) is the point: the model must render what the daemon says.
 */
function daemonState(collapsed = false): DaemonState {
    const store = createDaemonStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W(1), paneID: P(1), name: 'alpha', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W(2), paneID: P(2), name: 'beta', now: NOW + 1 });
    store.dispatch({ type: 'create-workspace', id: W(3), paneID: P(3), name: 'gamma', now: NOW + 2 });
    store.dispatch({ type: 'create-workspace', id: W(4), paneID: P(4), name: 'delta', now: NOW + 3 });
    store.dispatch({ type: 'create-group', id: G1, name: 'squad', now: NOW + 4 });
    store.dispatch({ type: 'move-workspace-to-group', id: W(2), groupID: G1 });
    store.dispatch({ type: 'move-workspace-to-group', id: W(3), groupID: G1 });
    if (collapsed) store.dispatch({ type: 'set-group-collapsed', id: G1, collapsed: true });
    return store.getState();
}

function entriesFor(state: DaemonState): readonly ChromeSidebarEntry[] {
    const client = createNexStore();
    client.getState().applySnapshot(1, state);
    return selectSidebarEntries(client.getState());
}

describe('visibleOrderFromEntries', () => {
    it('matches the daemon derived helper, expanded and collapsed', () => {
        for (const collapsed of [false, true]) {
            const state = daemonState(collapsed);
            expect(visibleOrderFromEntries(entriesFor(state))).toEqual(visibleWorkspaceOrder(state));
        }
    });

    it('skips a collapsed group members (⌘1..9 never addresses a hidden row)', () => {
        expect(visibleOrderFromEntries(entriesFor(daemonState(false)))).toEqual([W(1), W(4), W(2), W(3)]);
        expect(visibleOrderFromEntries(entriesFor(daemonState(true)))).toEqual([W(1), W(4)]);
    });

    it('honours a client-local collapse override (no wire verb yet)', () => {
        const entries = entriesFor(daemonState(false));
        const overrides = new Map([[G1, true]]);
        expect(visibleOrderFromEntries(entries, { overrides })).toEqual([W(1), W(4)]);
    });

    it('spring-loading a collapsed group reveals it without touching collapse', () => {
        const entries = entriesFor(daemonState(true));
        expect(visibleOrderFromEntries(entries, { springLoadedGroupID: G1 })).toEqual([
            W(1),
            W(4),
            W(2),
            W(3)
        ]);
    });
});

describe('renderedRows', () => {
    it('emits header + indented children, with the spec row keys', () => {
        const rows = renderedRows(entriesFor(daemonState(false)));
        expect(rows.map((row) => row.key)).toEqual([
            `ws:${W(1)}`,
            `ws:${W(4)}`,
            `header:${G1}`,
            `ws:${W(2)}`,
            `ws:${W(3)}`
        ]);
        expect(rows.filter((row) => row.kind === 'workspace').map((row) => row.depth)).toEqual([0, 0, 1, 1]);
    });

    it('a collapsed group emits only its header', () => {
        const rows = renderedRows(entriesFor(daemonState(true)));
        expect(rows.map((row) => row.key)).toEqual([`ws:${W(1)}`, `ws:${W(4)}`, `header:${G1}`]);
    });

    it('an expanded empty group emits the placeholder row', () => {
        const entries: ChromeSidebarEntry[] = [
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: null, icon: null, isCollapsed: false },
                workspaces: []
            }
        ];
        expect(renderedRows(entries).map((row) => row.kind)).toEqual(['group-header', 'group-empty']);
    });
});

describe('drop resolution', () => {
    const rowHeight = 20;

    it('resolves the half-height rules over top-level rows, children and headers', () => {
        const entries = entriesFor(daemonState(false));
        const model = orderModelFromEntries(entries);
        const rows = renderedRows(entries);
        const layout = buildDropZones(model, rows, {
            rowHeight,
            contentTop: 0,
            dragging: new Set([W(4)])
        });

        // rows: [alpha 0-20][delta 20-40, dragged][header 40-60][beta 60-80][gamma 80-100]
        expect(resolveDropTarget(layout, 5)).toEqual({ kind: 'topLevel', index: 0 });
        expect(resolveDropTarget(layout, 15)).toEqual({ kind: 'topLevel', index: 1 });
        expect(resolveDropTarget(layout, 45)).toEqual({ kind: 'topLevel', index: 1 });
        expect(resolveDropTarget(layout, 55)).toEqual({ kind: 'ontoGroupHeader', groupID: G1 });
        expect(resolveDropTarget(layout, 65)).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });
        expect(resolveDropTarget(layout, 95)).toEqual({ kind: 'intoGroup', groupID: G1, index: 2 });
        // The dragged row advances the cursor but is not a target; below everything appends.
        expect(resolveDropTarget(layout, 30)).toBeNull();
        expect(resolveDropTarget(layout, 120)).toEqual({ kind: 'topLevel', index: layout.tailIndex });
    });

    it('indices are post-remove: the dragged row is detached first', () => {
        const entries = entriesFor(daemonState(false));
        const model = orderModelFromEntries(entries);
        const rows = renderedRows(entries);
        // Dragging alpha (top-level index 0) shifts every later top-level index down by one:
        // delta's zone reports 0, not 1, so the index feeds `workspace-move` directly.
        const layout = buildDropZones(model, rows, {
            rowHeight,
            contentTop: 0,
            dragging: new Set([W(1)])
        });
        expect(resolveDropTarget(layout, 25)).toEqual({ kind: 'topLevel', index: 0 });
        expect(resolveDropTarget(layout, 35)).toEqual({ kind: 'topLevel', index: 1 });
        expect(layout.tailIndex).toBe(2);
    });

    it('the empty-group placeholder drops at index 0', () => {
        const entries: ChromeSidebarEntry[] = [
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: null, icon: null, isCollapsed: false },
                workspaces: []
            }
        ];
        const layout = buildDropZones(orderModelFromEntries(entries), renderedRows(entries), {
            rowHeight,
            contentTop: 0
        });
        expect(resolveDropTarget(layout, 25)).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });
    });
});

describe('shadow moves and the single commit', () => {
    it('remove-then-insert into a group, committing the post-remove index', () => {
        const entries = entriesFor(daemonState(false));
        const before = orderModelFromEntries(entries);
        const after = applyWorkspaceDrop(before, W(4), { kind: 'intoGroup', groupID: G1, index: 1 });

        expect(after.children.get(G1)).toEqual([W(2), W(4), W(3)]);
        expect(after.topLevel.map((slot) => slot.id)).toEqual([W(1), G1]);
        expect(workspaceCommit(before, after, W(4))).toEqual({ groupID: G1, index: 1 });
    });

    it('ontoGroupHeader appends', () => {
        const before = orderModelFromEntries(entriesFor(daemonState(false)));
        const after = applyWorkspaceDrop(before, W(1), { kind: 'ontoGroupHeader', groupID: G1 });
        expect(after.children.get(G1)).toEqual([W(2), W(3), W(1)]);
        expect(workspaceCommit(before, after, W(1))).toEqual({ groupID: G1, index: 2 });
    });

    it('a drag that lands where it started commits nothing', () => {
        const before = orderModelFromEntries(entriesFor(daemonState(false)));
        const after = applyWorkspaceDrop(before, W(1), { kind: 'topLevel', index: 0 });
        expect(workspaceCommit(before, after, W(1))).toBeNull();
    });

    it('a member leaving a group lands at top level', () => {
        const before = orderModelFromEntries(entriesFor(daemonState(false)));
        const after = applyWorkspaceDrop(before, W(2), { kind: 'topLevel', index: 0 });
        expect(after.children.get(G1)).toEqual([W(3)]);
        expect(workspaceCommit(before, after, W(2))).toEqual({ groupID: null, index: 0 });
    });

    it('projects the shadow back into entries for rendering', () => {
        const entries = entriesFor(daemonState(false));
        const shadow = applyWorkspaceDrop(orderModelFromEntries(entries), W(4), {
            kind: 'intoGroup',
            groupID: G1,
            index: 0
        });
        const projected = projectEntries(entries, shadow);
        const group = projected.find((entry) => entry.kind === 'group');
        expect(group?.kind === 'group' ? group.workspaces.map((w) => w.id) : []).toEqual([
            W(4),
            W(2),
            W(3)
        ]);
    });
});

describe('group drags', () => {
    it('moves the whole block and commits one top-level index', () => {
        const entries = entriesFor(daemonState(false));
        const before = orderModelFromEntries(entries);
        const after = applyGroupDrop(before, G1, 0);
        expect(after.topLevel.map((slot) => slot.id)).toEqual([G1, W(1), W(4)]);
        expect(groupCommit(before, after, G1)).toBe(0);
        expect(groupCommit(before, before, G1)).toBeNull();
    });

    it('spans cover the whole block, and the dragged block itself is not a target', () => {
        const entries = entriesFor(daemonState(false));
        const model = orderModelFromEntries(entries);
        const layout = buildGroupSpans(model, renderedRows(entries), { rowHeight: 20, contentTop: 0 });
        expect(layout.spans.map((span) => [span.yTop, span.yBottom])).toEqual([
            [0, 20],
            [20, 40],
            [40, 100]
        ]);
        expect(resolveGroupDropIndex(layout, 5, G1)).toBe(0);
        expect(resolveGroupDropIndex(layout, 50, G1)).toBeNull();
    });
});

describe('filteredRows', () => {
    it('descends into collapsed groups and reports the group caption', () => {
        const rows = filteredRows(entriesFor(daemonState(true)), 'ta');
        expect(rows.map((row) => [row.workspace.name, row.groupName])).toEqual([
            ['delta', null],
            ['beta', 'squad']
        ]);
    });

    it('matches labels case-insensitively', () => {
        const entries: ChromeSidebarEntry[] = [
            {
                kind: 'workspace',
                workspace: {
                    id: W(1),
                    name: 'alpha',
                    color: 'blue',
                    icon: null,
                    labels: ['Backend'],
                    panes: []
                }
            }
        ];
        expect(filteredRows(entries, 'backend')).toHaveLength(1);
        expect(filteredRows(entries, 'nope')).toHaveLength(0);
    });
});

describe('locateWorkspace', () => {
    it('reports the container and index', () => {
        const model = orderModelFromEntries(entriesFor(daemonState(false)));
        expect(locateWorkspace(model, W(3))).toEqual({ groupID: G1, index: 1 });
        expect(locateWorkspace(model, W(4))).toEqual({ groupID: null, index: 1 });
        expect(locateWorkspace(model, 'missing')).toBeNull();
    });
});

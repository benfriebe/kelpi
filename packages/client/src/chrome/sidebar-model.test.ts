import {
    createStore as createDaemonStore,
    emptyDaemonState,
    visibleWorkspaceOrder,
    type DaemonState
} from '@kelpi/daemon/store';
import { describe, expect, it } from 'vitest';

import { createKelpiStore } from '../state/store';
import { selectSidebarEntries } from '../state/selectors';
import {
    applyGroupDrop,
    applyWorkspaceDrop,
    buildDropZones,
    buildGroupSpans,
    defaultGroupName,
    filteredRows,
    nextCreateColor,
    groupCommit,
    locateWorkspace,
    nestedFollowers,
    orderModelFromEntries,
    projectEntries,
    renderedRows,
    resolveDropTarget,
    resolveGroupDropIndex,
    visibleOrderFromEntries,
    withoutNestedFollowers,
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
    const client = createKelpiStore();
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

    describe('a group header while the list auto-scrolls (#416, §5.5)', () => {
        const scrolling = { autoScrolling: true };

        it('an expanded header: the bottom half is the slot under the header, not an append', () => {
            const entries = entriesFor(daemonState(false));
            const layout = buildDropZones(orderModelFromEntries(entries), renderedRows(entries), {
                rowHeight,
                contentTop: 0,
                dragging: new Set([W(4)])
            });
            // rows: [alpha 0-20][delta 20-40, dragged][header 40-60][beta 60-80][gamma 80-100]
            expect(resolveDropTarget(layout, 45, scrolling)).toEqual({ kind: 'topLevel', index: 1 });
            expect(resolveDropTarget(layout, 55, scrolling)).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });
            // A still list keeps §5.5's append.
            expect(resolveDropTarget(layout, 55)).toEqual({ kind: 'ontoGroupHeader', groupID: G1 });
        });

        it('a collapsed header: the bottom half is the top-level slot after the group', () => {
            const entries = entriesFor(daemonState(true));
            const layout = buildDropZones(orderModelFromEntries(entries), renderedRows(entries), {
                rowHeight,
                contentTop: 0,
                dragging: new Set([W(4)])
            });
            // rows: [alpha 0-20][delta 20-40, dragged][header 40-60]; top level after removal is
            // [alpha, squad], so the slot after the group is index 2.
            expect(resolveDropTarget(layout, 45, scrolling)).toEqual({ kind: 'topLevel', index: 1 });
            expect(resolveDropTarget(layout, 55, scrolling)).toEqual({ kind: 'topLevel', index: 2 });
            expect(resolveDropTarget(layout, 55)).toEqual({ kind: 'ontoGroupHeader', groupID: G1 });
        });

        it('a spring-loaded group counts as expanded, and so does one whose only member is dragged', () => {
            const springEntries = entriesFor(daemonState(true));
            const springRows = renderedRows(springEntries, { springLoadedGroupID: G1 });
            const spring = buildDropZones(orderModelFromEntries(springEntries), springRows, {
                rowHeight,
                contentTop: 0,
                dragging: new Set([W(4)])
            });
            expect(resolveDropTarget(spring, 55, scrolling)).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });

            // alpha, then squad holding only beta, which is the row being dragged.
            const full = entriesFor(daemonState(false));
            const group = full.find((entry) => entry.kind === 'group');
            if (group?.kind !== 'group') throw new Error('no group');
            const lone: ChromeSidebarEntry[] = [full[0] as ChromeSidebarEntry, { ...group, workspaces: group.workspaces.slice(0, 1) }];
            const loneLayout = buildDropZones(orderModelFromEntries(lone), renderedRows(lone), {
                rowHeight,
                contentTop: 0,
                dragging: new Set([W(2)])
            });
            // rows: [alpha 0-20][header 20-40][beta 40-60, dragged]
            expect(resolveDropTarget(loneLayout, 35, scrolling)).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });
        });

        it('an empty expanded group: the bottom half is its index 0, as its placeholder is', () => {
            const entries: ChromeSidebarEntry[] = [
                {
                    kind: 'group',
                    group: { id: G1, name: 'squad', color: null, icon: null, isCollapsed: false },
                    workspaces: []
                }
            ];
            const layout = buildDropZones(orderModelFromEntries(entries), renderedRows(entries), { rowHeight, contentTop: 0 });
            expect(resolveDropTarget(layout, 15, scrolling)).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });
            expect(resolveDropTarget(layout, 25, scrolling)).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });
        });

        it('the slot under the header, for the group\'s own first member, moves nothing', () => {
            const entries = entriesFor(daemonState(false));
            const model = orderModelFromEntries(entries);
            const layout = buildDropZones(model, renderedRows(entries), {
                rowHeight,
                contentTop: 0,
                dragging: new Set([W(2)])
            });
            // rows: [alpha 0-20][delta 20-40][header 40-60][beta 60-80, dragged][gamma 80-100]
            const target = resolveDropTarget(layout, 55, scrolling);
            expect(target).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });
            if (target === null) throw new Error('no target');
            const shadow = applyWorkspaceDrop(model, W(2), target);
            expect(workspaceCommit(model, shadow, W(2))).toBeNull();
        });
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

    /**
     * Defect N4b, as arithmetic.
     *
     * Every sidebar row carries an outer margin that `getBoundingClientRect().height` does not
     * report, so the accumulate-heights walk drifts a whole gap further off with every row. The
     * fixture keeps the 2px gap the failing run had — the arithmetic is what is under test, not
     * the constant, and §WS-027's clearance fix has since uncollapsed those margins to 4px,
     * which only makes the drift this describes worse.
     * The fixture below is the one the failing full run produced: a 7-row sidebar with the
     * drop target sixth. The cursor sits three quarters of the way down the group header —
     * the point that selects `ontoGroupHeader` — and the old model answers `null`, which the
     * drag loop treats as "no target", which the user sees as a drag that does nothing.
     */
    describe('measured offsets (N4b)', () => {
        const keys = ['a', 'b', 'c', 'header', 'child', 'target', 'dragged'];
        const rowHeights = [69, 53, 37, 33, 35, 32, 38];
        const heights = new Map(keys.map((key, index) => [key, rowHeights[index] as number]));
        const offsets = new Map<string, number>();
        {
            let top = 4;
            for (const [index, key] of keys.entries()) {
                offsets.set(key, top);
                top += (rowHeights[index] as number) + 2;
            }
        }
        const targetTop = offsets.get('target') as number;
        const cursor = targetTop + 32 * 0.75;
        // The list run-I actually had: five rows, the collapsed target header, and the dragged
        // row last — the dragged one is excluded as a target but still occupies its space.
        const model = { topLevel: [{ kind: 'group' as const, id: 'target' }], children: new Map<string, readonly string[]>() };
        const asRows = [
            ...keys.slice(0, 6).map((key) => ({ kind: 'group-header' as const, key, groupID: key, collapsed: false })),
            { kind: 'workspace' as const, key: 'dragged', workspaceID: 'dragged', groupID: null, depth: 0 as const }
        ];
        const dragging = new Set(['dragged']);

        it('accumulating border-box heights drifts a row-count of margins off the truth', () => {
            let accumulated = 4;
            for (const key of keys) {
                if (key === 'target') break;
                accumulated += heights.get(key) as number;
            }
            // Five preceding rows plus the padding: the model puts the header 10px too high…
            expect(targetTop - accumulated).toBe(10);
            // …which is enough to put the cursor past the band entirely.
            expect(cursor).toBeGreaterThan(accumulated + 32);

            // …and past it into the hole the dragged row leaves, which resolves to nothing.
            // This IS the failure: `resolve()` returns early on null, so the header never
            // tints, the row never takes the nested indent and the drop never commits.
            const drifted = buildDropZones(model, asRows, { heights, contentTop: 4, dragging });
            expect(resolveDropTarget(drifted, cursor)).toBeNull();
        });

        it('offsets put every band on the pixels the row occupies, and tile the gaps', () => {
            const layout = buildDropZones(model, asRows, { heights, offsets, contentTop: 4, dragging });
            const targets = keys.slice(0, 6);
            expect(layout.zones.map((zone) => zone.yTop)).toEqual(targets.map((key) => offsets.get(key)));
            for (let index = 0; index + 1 < layout.zones.length; index++) {
                expect(layout.zones[index]?.yBottom).toBe(layout.zones[index + 1]?.yTop);
            }
            expect(layout.contentBottom).toBe((offsets.get('dragged') as number) + 38);
            expect(resolveDropTarget(layout, cursor)).toEqual({ kind: 'ontoGroupHeader', groupID: 'target' });
        });

        it('the drift is invisible at the top of the list and decisive at the bottom', () => {
            const exact = buildDropZones(model, asRows, { heights, offsets, contentTop: 4, dragging });
            const drifted = buildDropZones(model, asRows, { heights, contentTop: 4, dragging });
            // The gesture the audit drives: press 75% of the way down a row, which is the
            // point that means "append into this one" rather than "insert above it".
            const wrong: string[] = [];
            for (const [index, key] of keys.slice(0, 6).entries()) {
                const point = (offsets.get(key) as number) + (rowHeights[index] as number) * 0.75;
                const right = resolveDropTarget(exact, point);
                expect(right).toEqual({ kind: 'ontoGroupHeader', groupID: key });
                if (JSON.stringify(resolveDropTarget(drifted, point)) !== JSON.stringify(right)) wrong.push(key);
            }
            // The first row has no drift above it, so it reads correctly either way — which is
            // exactly why a three-row scoped run passed this flow and a seven-row full one
            // did not. The sixth row is the one the audit drops on.
            expect(wrong).not.toContain('a');
            expect(wrong).toContain('target');
        });

        it('group spans start where their header actually is', () => {
            const entries = entriesFor(daemonState(false));
            const model = orderModelFromEntries(entries);
            const rows = renderedRows(entries, {});
            const measured = new Map<string, number>();
            const tall = new Map<string, number>();
            let y = 4;
            for (const row of rows) {
                measured.set(row.key, y);
                tall.set(row.key, 40);
                y += 42;
            }
            const spans = buildGroupSpans(model, rows, { heights: tall, offsets: measured, contentTop: 4 });
            const header = spans.spans.find((span) => span.groupID === G1);
            expect(header?.yTop).toBe(measured.get(`header:${G1}`));
            expect(spans.contentBottom).toBe(y - 2);
        });
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

// ── create-form defaults (§WS-075, §WS-083) ─────────────────────────────────────────

describe('nextCreateColor', () => {
    /** The trailing workspace here is `blue`, whatever the group nesting. */
    const entries = entriesFor(daemonState(false));

    it('never returns the trailing workspace’s colour, whatever the roll', () => {
        const trailing = [...entries]
            .flatMap((entry) => (entry.kind === 'workspace' ? [entry.workspace] : entry.workspaces))
            .at(-1)?.color;
        expect(trailing).toBeDefined();
        for (let roll = 0; roll < 20; roll += 1) {
            expect(nextCreateColor(entries, () => roll / 20)).not.toBe(trailing);
        }
    });

    it('spreads across the pool rather than always answering the same colour', () => {
        const seen = new Set([nextCreateColor(entries, () => 0), nextCreateColor(entries, () => 0.99)]);
        expect(seen.size).toBe(2);
    });

    it('falls back to blue for an empty sidebar', () => {
        expect(nextCreateColor([], () => 0)).toBe('red');
    });
});

describe('defaultGroupName', () => {
    it('uniquifies against the names already taken', () => {
        expect(defaultGroupName([])).toBe('New Group');
        expect(defaultGroupName(['squad'])).toBe('New Group');
        expect(defaultGroupName(['New Group'])).toBe('New Group 2');
        expect(defaultGroupName(['New Group', 'New Group 2'])).toBe('New Group 3');
        // A gap is filled rather than skipped past.
        expect(defaultGroupName(['New Group', 'New Group 3'])).toBe('New Group 2');
    });
});

// ── nested workspaces (app-state-core.md §2.9) ─────────────────────────────────────

/**
 * `alpha` with `w5`, `w6` nested under it; `delta`; then `squad [beta]` with `w7` nested under
 * `beta`. Built through the real daemon store, so the rows are what the daemon would send.
 */
function nestedState(options: { alphaCollapsed?: boolean; betaCollapsed?: boolean } = {}): DaemonState {
    const store = createDaemonStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W(1), paneID: P(1), name: 'alpha', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W(2), paneID: P(2), name: 'beta', now: NOW + 1 });
    store.dispatch({ type: 'create-workspace', id: W(4), paneID: P(4), name: 'delta', now: NOW + 3 });
    store.dispatch({ type: 'create-group', id: G1, name: 'squad', now: NOW + 4 });
    store.dispatch({ type: 'move-workspace-to-group', id: W(2), groupID: G1 });
    store.dispatch({ type: 'create-workspace', id: W(5), paneID: P(5), name: 'w5', now: NOW + 5, parentID: W(1) });
    store.dispatch({ type: 'create-workspace', id: W(6), paneID: P(6), name: 'w6', now: NOW + 6, parentID: W(1) });
    store.dispatch({ type: 'create-workspace', id: W(7), paneID: P(7), name: 'w7', now: NOW + 7, parentID: W(2) });
    if (options.alphaCollapsed === true) {
        store.dispatch({ type: 'set-workspace-children-collapsed', id: W(1), collapsed: true });
    }
    if (options.betaCollapsed === true) {
        store.dispatch({ type: 'set-workspace-children-collapsed', id: W(2), collapsed: true });
    }
    return store.getState();
}

describe('nested workspaces: rows and order', () => {
    it('renders children under their parent, one indent deeper, carrying the parent group', () => {
        const rows = renderedRows(entriesFor(nestedState()));
        expect(
            rows.map((row) =>
                row.kind === 'workspace'
                    ? [row.workspaceID, row.depth, row.groupID, row.parentID ?? null, row.childCount ?? 0]
                    : [row.key]
            )
        ).toEqual([
            [W(1), 0, null, null, 2],
            [W(5), 1, null, W(1), 0],
            [W(6), 1, null, W(1), 0],
            [W(4), 0, null, null, 0],
            [`header:${G1}`],
            [W(2), 1, G1, null, 1],
            [W(7), 2, G1, W(2), 0]
        ]);
    });

    it('matches the daemon visible order, with parents expanded and collapsed', () => {
        for (const alphaCollapsed of [false, true]) {
            for (const betaCollapsed of [false, true]) {
                const state = nestedState({ alphaCollapsed, betaCollapsed });
                expect(visibleOrderFromEntries(entriesFor(state))).toEqual(visibleWorkspaceOrder(state));
            }
        }
        expect(visibleOrderFromEntries(entriesFor(nestedState({ alphaCollapsed: true })))).toEqual([
            W(1),
            W(4),
            W(2),
            W(7)
        ]);
    });

    it('a collapsed parent reports its count and hides its rows; an override and a spring-load win', () => {
        const entries = entriesFor(nestedState({ alphaCollapsed: true }));
        const parent = renderedRows(entries).find((row) => row.key === `ws:${W(1)}`);
        expect(parent).toMatchObject({ childCount: 2, childrenCollapsed: true });
        expect(visibleOrderFromEntries(entries, { overrides: new Map([[W(1), false]]) })).toContain(W(5));
        expect(visibleOrderFromEntries(entries, { springLoadedGroupID: W(1) })).toContain(W(6));
    });

    it('locates a nested workspace by its parent, and round-trips through the projection', () => {
        const entries = entriesFor(nestedState());
        const model = orderModelFromEntries(entries);
        expect(locateWorkspace(model, W(6))).toEqual({ groupID: null, index: 1, parentID: W(1) });
        expect(locateWorkspace(model, W(7))).toEqual({ groupID: null, index: 0, parentID: W(2) });
        expect(renderedRows(projectEntries(entries, model)).map((row) => row.key)).toEqual(
            renderedRows(entries).map((row) => row.key)
        );
    });

    it('filters nested rows flat, captioned with their parent', () => {
        expect(filteredRows(entriesFor(nestedState({ alphaCollapsed: true })), 'w').map((row) => [row.workspace.id, row.groupName])).toEqual([
            [W(5), 'alpha'],
            [W(6), 'alpha'],
            [W(7), 'beta']
        ]);
    });
});

describe('nested workspaces: drag and drop', () => {
    const entries = (): readonly ChromeSidebarEntry[] => entriesFor(nestedState());

    it('nests onto a row and reorders within a parent, committing the parent location', () => {
        const before = orderModelFromEntries(entries());
        const onto = applyWorkspaceDrop(before, W(4), { kind: 'ontoWorkspace', parentID: W(1) });
        expect(workspaceCommit(before, onto, W(4))).toEqual({ groupID: null, index: 2, parentID: W(1) });
        const within = applyWorkspaceDrop(before, W(6), { kind: 'intoParent', parentID: W(1), index: 0 });
        expect(workspaceCommit(before, within, W(6))).toEqual({ groupID: null, index: 0, parentID: W(1) });
        // Dropped back where it was: nothing to commit.
        const same = applyWorkspaceDrop(before, W(6), { kind: 'intoParent', parentID: W(1), index: 1 });
        expect(workspaceCommit(before, same, W(6))).toBeNull();
    });

    it('un-nests to the top level as an ordinary move', () => {
        const before = orderModelFromEntries(entries());
        const after = applyWorkspaceDrop(before, W(5), { kind: 'topLevel', index: 0 });
        expect(workspaceCommit(before, after, W(5))).toEqual({ groupID: null, index: 0 });
    });

    it('keeps every other parent\'s children in the drag shadow, whatever the target', () => {
        const before = orderModelFromEntries(entries());
        for (const target of [
            { kind: 'topLevel', index: 0 },
            { kind: 'intoGroup', groupID: G1, index: 0 },
            { kind: 'ontoGroupHeader', groupID: G1 }
        ] as const) {
            const shadow = applyWorkspaceDrop(before, W(4), target);
            const keys = renderedRows(projectEntries(entries(), shadow)).map((row) => row.key);
            expect(keys).toEqual(expect.arrayContaining([`ws:${W(5)}`, `ws:${W(6)}`, `ws:${W(7)}`]));
        }
    });

    it('splits a nestable row into thirds: before, onto, after (or first child when expanded)', () => {
        const rows = renderedRows(entries());
        const model = orderModelFromEntries(entries());
        const layout = buildDropZones(model, rows, { rowHeight: 30, contentTop: 0, dragging: new Set([W(4)]), nestable: true });
        // Row 0 is alpha (expanded parent) at y 0..30.
        expect(resolveDropTarget(layout, 5)).toEqual({ kind: 'topLevel', index: 0 });
        expect(resolveDropTarget(layout, 15)).toEqual({ kind: 'ontoWorkspace', parentID: W(1) });
        expect(resolveDropTarget(layout, 25)).toEqual({ kind: 'intoParent', parentID: W(1), index: 0 });
        // Row 1 is w5, alpha's first child, at y 30..60.
        expect(resolveDropTarget(layout, 35)).toEqual({ kind: 'intoParent', parentID: W(1), index: 0 });
        expect(resolveDropTarget(layout, 55)).toEqual({ kind: 'intoParent', parentID: W(1), index: 1 });
        // Row 5 is beta, a group member, at y 150..180: nests too.
        expect(resolveDropTarget(layout, 165)).toEqual({ kind: 'ontoWorkspace', parentID: W(2) });
    });

    it('while auto-scrolling (§5.5), a middle third resolves to the nearer slot', () => {
        const suspended = { autoScrolling: true };
        // Expanded parents: alpha (top level) at y 0..30, beta (a group member) at y 150..180.
        const expanded = buildDropZones(orderModelFromEntries(entries()), renderedRows(entries()), {
            rowHeight: 30,
            contentTop: 0,
            dragging: new Set([W(4)]),
            nestable: true
        });
        expect(resolveDropTarget(expanded, 12)).toEqual({ kind: 'ontoWorkspace', parentID: W(1) });
        expect(resolveDropTarget(expanded, 12, suspended)).toEqual({ kind: 'topLevel', index: 0 });
        expect(resolveDropTarget(expanded, 18, suspended)).toEqual({ kind: 'intoParent', parentID: W(1), index: 0 });
        expect(resolveDropTarget(expanded, 162)).toEqual({ kind: 'ontoWorkspace', parentID: W(2) });
        expect(resolveDropTarget(expanded, 162, suspended)).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });
        expect(resolveDropTarget(expanded, 168, suspended)).toEqual({ kind: 'intoParent', parentID: W(2), index: 0 });

        // Collapsed parents: alpha at y 0..30, then delta (dragged), the header, beta at 90..120.
        const state = nestedState({ alphaCollapsed: true, betaCollapsed: true });
        const collapsed = buildDropZones(orderModelFromEntries(entriesFor(state)), renderedRows(entriesFor(state)), {
            rowHeight: 30,
            contentTop: 0,
            dragging: new Set([W(4)]),
            nestable: true
        });
        expect(resolveDropTarget(collapsed, 18)).toEqual({ kind: 'ontoWorkspace', parentID: W(1) });
        expect(resolveDropTarget(collapsed, 12, suspended)).toEqual({ kind: 'topLevel', index: 0 });
        expect(resolveDropTarget(collapsed, 18, suspended)).toEqual({ kind: 'topLevel', index: 1 });
        expect(resolveDropTarget(collapsed, 108)).toEqual({ kind: 'ontoWorkspace', parentID: W(2) });
        expect(resolveDropTarget(collapsed, 102, suspended)).toEqual({ kind: 'intoGroup', groupID: G1, index: 0 });
        expect(resolveDropTarget(collapsed, 108, suspended)).toEqual({ kind: 'intoGroup', groupID: G1, index: 1 });
    });

    it('auto-scrolling changes only the ontoWorkspace and ontoGroupHeader bands: every other zone resolves the same', () => {
        const expandedEntries = entries();
        const collapsedEntries = entriesFor(nestedState({ alphaCollapsed: true, betaCollapsed: true }));
        const layouts = [
            ...[expandedEntries, collapsedEntries].map((list) =>
                buildDropZones(orderModelFromEntries(list), renderedRows(list), {
                    rowHeight: 30,
                    contentTop: 0,
                    dragging: new Set([W(4)]),
                    nestable: true
                })
            ),
            // A non-nestable drag (no nest bands at all) and a nested row's own drag.
            buildDropZones(orderModelFromEntries(expandedEntries), renderedRows(expandedEntries), {
                rowHeight: 30,
                contentTop: 0,
                dragging: new Set([W(4)])
            }),
            buildDropZones(orderModelFromEntries(expandedEntries), renderedRows(expandedEntries), {
                rowHeight: 30,
                contentTop: 0,
                dragging: new Set([W(6)]),
                nestable: true
            })
        ];
        let nestBands = 0;
        for (const layout of layouts) {
            for (let y = -10; y <= 240; y += 0.5) {
                const plain = resolveDropTarget(layout, y);
                const suspended = resolveDropTarget(layout, y, { autoScrolling: true });
                expect(suspended?.kind).not.toBe('ontoWorkspace');
                expect(suspended?.kind).not.toBe('ontoGroupHeader');
                if (plain?.kind === 'ontoWorkspace' || plain?.kind === 'ontoGroupHeader') {
                    nestBands += 1;
                    continue;
                }
                expect(suspended).toEqual(plain);
            }
        }
        // The sweep really crossed middle thirds (and so the slot, header and nested zones too).
        expect(nestBands).toBeGreaterThan(0);
    });

    it('a non-nestable drag keeps two halves and treats nested rows as after the parent block', () => {
        const rows = renderedRows(entries());
        const model = orderModelFromEntries(entries());
        const layout = buildDropZones(model, rows, { rowHeight: 30, contentTop: 0, dragging: new Set([W(4)]) });
        expect(resolveDropTarget(layout, 10)).toEqual({ kind: 'topLevel', index: 0 });
        expect(resolveDropTarget(layout, 45)).toEqual({ kind: 'topLevel', index: 1 });
        // w7 under beta (in the group) at y 180..210 lands after beta in the group.
        expect(resolveDropTarget(layout, 185)).toEqual({ kind: 'intoGroup', groupID: G1, index: 1 });
    });

    it('reaches the end of a group whose last member is an expanded parent: the last nested row’s bottom third', () => {
        const rows = renderedRows(entries());
        const model = orderModelFromEntries(entries());
        const layout = buildDropZones(model, rows, { rowHeight: 30, contentTop: 0, dragging: new Set([W(4)]), nestable: true });
        // w7, beta's only child and the group's last row, at y 180..210.
        expect(resolveDropTarget(layout, 185)).toEqual({ kind: 'intoParent', parentID: W(2), index: 0 });
        expect(resolveDropTarget(layout, 195)).toEqual({ kind: 'intoParent', parentID: W(2), index: 1 });
        expect(resolveDropTarget(layout, 205)).toEqual({ kind: 'intoGroup', groupID: G1, index: 1 });
        // Alpha's last child (w6, y 60..90) does the same at the top level: after alpha's block.
        expect(resolveDropTarget(layout, 85)).toEqual({ kind: 'topLevel', index: 1 });
    });

    it('a dragged parent’s nested rows land where its slot closes up, not at a guessed index', () => {
        // Alpha and delta move together and alpha's rows were not folded: they mean "after
        // alpha", which, with alpha itself leaving, is the slot alpha leaves behind (index 0).
        const rows = renderedRows(entries());
        const model = orderModelFromEntries(entries());
        const layout = buildDropZones(model, rows, { rowHeight: 30, contentTop: 0, dragging: new Set([W(1), W(4)]) });
        expect(resolveDropTarget(layout, 45)).toEqual({ kind: 'topLevel', index: 0 });
    });

    it('names a parent’s children that move with it as followers, so bulk commands leave them out', () => {
        const model = orderModelFromEntries(entries());
        // w5 is alpha's and alpha moves; w7's parent (beta) stays, so w7 moves in its own right.
        expect([...nestedFollowers(model, [W(1), W(5), W(4), W(7)])]).toEqual([W(5)]);
        expect(withoutNestedFollowers(model, [W(1), W(5), W(4), W(7)])).toEqual([W(1), W(4), W(7)]);
        expect(withoutNestedFollowers(model, [W(5), W(6)])).toEqual([W(5), W(6)]);
    });

    it('a group drag counts a nested row as part of its parent span', () => {
        const rows = renderedRows(entries());
        const model = orderModelFromEntries(entries());
        const spans = buildGroupSpans(model, rows, { rowHeight: 30, contentTop: 0 });
        expect(spans.spans.map((span) => [span.slotID, span.yTop, span.yBottom])).toEqual([
            [`workspace:${W(1)}`, 0, 90],
            [`workspace:${W(4)}`, 90, 120],
            [`group:${G1}`, 120, 210]
        ]);
    });
});

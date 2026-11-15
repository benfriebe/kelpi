import { describe, expect, it } from 'vitest';

import { createStore, emptyDaemonState, type DaemonState, type DomainAction, type WorkspaceState } from '../store/index.js';
import { estimateBackgroundGrid } from './background-size.js';
import type { GridSize } from './geometry.js';

const W = 'AAAAAAAA-0000-4000-8000-000000000001';
const P0 = 'DDDDDDDD-0000-4000-8000-000000000100';
const P1 = 'EEEEEEEE-0000-4000-8000-000000000001';
const P2 = 'EEEEEEEE-0000-4000-8000-000000000002';
const P3 = 'EEEEEEEE-0000-4000-8000-000000000003';
const T1 = 'FFFFFFFF-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function build(...actions: DomainAction[]): WorkspaceState {
    const store = createStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W, paneID: P0, name: 'dev', color: 'blue', now: NOW, workingDirectory: '/Users/test' });
    for (const action of actions) store.dispatch(action);
    return (store.getState() as DaemonState).workspaces[0] as WorkspaceState;
}

const backgroundTab: DomainAction = {
    type: 'create-tab',
    workspaceID: W,
    tabID: T1,
    focus: false,
    create: { type: 'create-pane', workspaceID: W, paneID: P1, now: NOW, workingDirectory: '/Users/test' }
};

const only = (paneID: string, size: GridSize) => (id: string): GridSize | null => (id === paneID ? size : null);

describe('estimateBackgroundGrid', () => {
    it("gives a background tab's only pane the whole pane area the tab on screen measures", () => {
        const workspace = build(backgroundTab);
        expect(estimateBackgroundGrid(workspace, P1, only(P0, { cols: 200, rows: 50 }))).toEqual({ cols: 200, rows: 50 });
    });

    it('splits the area by the background tab\'s own ratios', () => {
        const workspace = build(backgroundTab, {
            type: 'split-pane',
            workspaceID: W,
            paneID: P2,
            sourcePaneID: P1,
            direction: 'horizontal',
            now: NOW,
            focus: false
        });
        const size = estimateBackgroundGrid(workspace, P2, only(P0, { cols: 200, rows: 50 }));
        // Half the width (less the divider's sliver), the full height.
        expect(size?.cols).toBeGreaterThanOrEqual(99);
        expect(size?.cols).toBeLessThanOrEqual(100);
        expect(size?.rows).toBe(50);
    });

    it('reads the area off any measured pane on screen, through its share of the tree', () => {
        // On screen: P0 | P3, with only P3 measured at half the area.
        const workspace = build(
            { type: 'split-pane', workspaceID: W, paneID: P3, sourcePaneID: P0, direction: 'horizontal', now: NOW, focus: false },
            backgroundTab
        );
        const size = estimateBackgroundGrid(workspace, P1, only(P3, { cols: 100, rows: 50 }));
        expect(size?.cols).toBeGreaterThanOrEqual(199);
        expect(size?.cols).toBeLessThanOrEqual(201);
        expect(size?.rows).toBe(50);
    });

    it('knows nothing when nothing on screen has been measured, so the caller keeps its fallback', () => {
        expect(estimateBackgroundGrid(build(backgroundTab), P1, () => null)).toBeNull();
    });

    it('never goes below a grid a shell can print a prompt in', () => {
        const workspace = build(backgroundTab);
        expect(estimateBackgroundGrid(workspace, P1, only(P0, { cols: 4, rows: 2 }))).toEqual({ cols: 20, rows: 5 });
    });
});

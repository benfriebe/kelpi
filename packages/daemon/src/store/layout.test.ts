import { allPaneIDs, PREDEFINED_LAYOUT_ORDER } from '@nex/core/layout';
import { describe, expect, it } from 'vitest';
import { workspaceByID } from './derived.js';
import { harness, id, NOW, seededState, W1 } from './testing.js';
import type { DaemonState, DomainAction, WorkspaceState } from './types.js';

const P0 = id('dddddddd', 100);

function ws(state: DaemonState): WorkspaceState {
    return workspaceByID(state, W1) as WorkspaceState;
}

function split(paneID: string): DomainAction {
    return { type: 'split-pane', workspaceID: W1, paneID, direction: 'horizontal', now: NOW };
}

describe('predefined layouts', () => {
    it('needs at least two panes to cycle', () => {
        const h = harness(seededState());
        const before = h.state();
        h.dispatch({ type: 'cycle-layout', workspaceID: W1 });
        expect(h.state()).toBe(before);
    });

    it('starts at even-horizontal, advances, and wraps', () => {
        const h = harness(seededState());
        h.dispatch(split(id('eeeeeeee', 1)));
        for (let step = 0; step < PREDEFINED_LAYOUT_ORDER.length; step += 1) {
            h.dispatch({ type: 'cycle-layout', workspaceID: W1 });
            expect(ws(h.state()).currentLayoutIndex).toBe(step);
        }
        h.dispatch({ type: 'cycle-layout', workspaceID: W1 });
        expect(ws(h.state()).currentLayoutIndex).toBe(0);
    });

    it('restarts the cycle at 0 after a hand modification', () => {
        const h = harness(seededState());
        h.dispatch(
            split(id('eeeeeeee', 1)),
            { type: 'cycle-layout', workspaceID: W1 },
            { type: 'cycle-layout', workspaceID: W1 }
        );
        expect(ws(h.state()).currentLayoutIndex).toBe(1);
        h.dispatch({ type: 'update-split-ratio', workspaceID: W1, splitPath: 'd', ratio: 0.3 });
        expect(ws(h.state()).currentLayoutIndex).toBeNull();
        h.dispatch({ type: 'cycle-layout', workspaceID: W1 });
        expect(ws(h.state()).currentLayoutIndex).toBe(0);
    });

    it('hoists the focused pane to the front so it becomes "main"', () => {
        const h = harness(seededState());
        const PA = id('eeeeeeee', 1);
        const PB = id('eeeeeeee', 2);
        h.dispatch(split(PA), split(PB), { type: 'focus-pane', workspaceID: W1, paneID: PB });
        h.dispatch({ type: 'select-layout', workspaceID: W1, kind: 'main-vertical' });
        const workspace = ws(h.state());
        expect(workspace.currentLayoutIndex).toBe(3);
        expect(workspace.layout).toMatchObject({
            kind: 'split',
            direction: 'horizontal',
            ratio: 0.6,
            first: { kind: 'leaf', paneID: PB }
        });
        expect(allPaneIDs(workspace.layout)[0]).toBe(PB);
    });

    it('un-zooms before rebuilding', () => {
        const h = harness(seededState());
        h.dispatch(split(id('eeeeeeee', 1)), { type: 'toggle-zoom', workspaceID: W1 });
        h.dispatch({ type: 'select-layout', workspaceID: W1, kind: 'tiled' });
        const workspace = ws(h.state());
        expect(workspace.zoomedPaneID).toBeNull();
        expect(workspace.savedLayout).toBeNull();
        expect(allPaneIDs(workspace.layout)).toHaveLength(2);
    });
});

describe('zoom', () => {
    it('cannot zoom a single-pane workspace', () => {
        const h = harness(seededState());
        const before = h.state();
        h.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
        expect(h.state()).toBe(before);
    });

    it('round-trips the layout and leaves the layout index alone', () => {
        const h = harness(seededState());
        const PA = id('eeeeeeee', 1);
        h.dispatch(split(PA), { type: 'cycle-layout', workspaceID: W1 });
        const layout = ws(h.state()).layout;
        h.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
        expect(ws(h.state()).layout).toEqual({ kind: 'leaf', paneID: PA });
        expect(ws(h.state()).currentLayoutIndex).toBe(0);
        h.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
        expect(ws(h.state()).layout).toEqual(layout);
        expect(ws(h.state()).currentLayoutIndex).toBe(0);
    });
});

describe('focus', () => {
    it('keeps at most 8 deduped history entries, most recent last', () => {
        const h = harness(seededState());
        const ids = [P0];
        for (let index = 1; index <= 10; index += 1) {
            const paneID = id('eeeeeeee', index);
            ids.push(paneID);
            h.dispatch(split(paneID));
        }
        // Re-focus an old pane: it must not appear twice.
        h.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: P0 });
        h.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: ids[5] as string });
        const history = ws(h.state()).focusHistory;
        expect(history).toHaveLength(8);
        expect(new Set(history).size).toBe(8);
        expect(history.at(-1)).toBe(P0);
    });

    it('re-focusing the current pane changes nothing', () => {
        const h = harness(seededState());
        const before = h.state();
        h.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: P0 });
        expect(h.state()).toBe(before);
    });

    it('cycles next/previous in layout order with wraparound', () => {
        const h = harness(seededState());
        const PA = id('eeeeeeee', 1);
        const PB = id('eeeeeeee', 2);
        h.dispatch(split(PA), split(PB));
        expect(allPaneIDs(ws(h.state()).layout)).toEqual([P0, PA, PB]);
        h.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: PB });
        h.dispatch({ type: 'focus-next-pane', workspaceID: W1 });
        expect(ws(h.state()).focusedPaneID).toBe(P0);
        h.dispatch({ type: 'focus-previous-pane', workspaceID: W1 });
        expect(ws(h.state()).focusedPaneID).toBe(PB);
    });
});

describe('search', () => {
    it('opens on a shell pane and closes wherever it is open', () => {
        const h = harness(seededState());
        const PA = id('eeeeeeee', 1);
        h.dispatch(split(PA), { type: 'toggle-search', workspaceID: W1 });
        expect(ws(h.state()).searchingPaneID).toBe(PA);
        h.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: P0 });
        h.dispatch({ type: 'toggle-search', workspaceID: W1 });
        expect(ws(h.state()).searchingPaneID).toBeNull();
    });

    it('refuses to host find on a scratchpad', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: id('eeeeeeee', 9), now: NOW });
        const before = h.state();
        h.dispatch({ type: 'toggle-search', workspaceID: W1 });
        expect(h.state()).toBe(before);
    });

    it('drops count reports from panes that do not host the bar, and nulls selection at zero', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'toggle-search', workspaceID: W1 });
        h.dispatch({ type: 'set-search-counts', workspaceID: W1, paneID: 'other', total: 5 });
        expect(ws(h.state()).searchTotal).toBeNull();
        h.dispatch({ type: 'set-search-counts', workspaceID: W1, paneID: P0, total: 3, selected: 2 });
        expect(ws(h.state())).toMatchObject({ searchTotal: 3, searchSelected: 2 });
        h.dispatch({ type: 'set-search-counts', workspaceID: W1, paneID: P0, total: 0 });
        expect(ws(h.state())).toMatchObject({ searchTotal: 0, searchSelected: null });
    });
});

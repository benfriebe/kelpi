/**
 * The move/restore bookkeeping: which view is in the window, and when it goes back.
 *
 * Driven with fake views and recorded hooks, because everything interesting here is *when* the
 * hooks fire — a tab switch that forgets to detach the old view leaves a dead page painting
 * over the live one, and a release that fires twice would `removeChildView` a view that is
 * already gone.
 */

import { describe, expect, it } from 'vitest';

import { createEmbedController, type EmbedEvent } from './embed.js';
import type { PaneGeometry, ViewBounds, WindowMetrics } from './geometry.js';

const PANE = 'AAAAAAAA-0000-4000-8000-00000000000A';
const OTHER = 'BBBBBBBB-0000-4000-8000-00000000000B';

interface FakeView {
    readonly id: string;
}

const METRICS: WindowMetrics = { contentWidth: 1200, contentHeight: 800, scaleFactor: 1 };

function geometry(overrides: Partial<PaneGeometry> = {}): PaneGeometry {
    return {
        paneID: PANE,
        tabID: 'T1',
        rect: { x: 10, y: 20, w: 400, h: 300 },
        visible: true,
        devicePixelRatio: 1,
        ownWindow: true,
        shellWindowID: 'WIN',
        ...overrides
    };
}

function harness(
    options: {
        views?: Record<string, FakeView | null>;
        metrics?: () => WindowMetrics | null;
        windowID?: string;
    } = {}
) {
    const attaches: { view: FakeView; bounds: ViewBounds }[] = [];
    const detaches: FakeView[] = [];
    const moves: { view: FakeView; bounds: ViewBounds }[] = [];
    const events: EmbedEvent[] = [];
    const views = options.views ?? { T1: { id: 'T1' } };

    const controller = createEmbedController<FakeView>({
        resolveView: (_paneID, tabID) => views[tabID ?? 'T1'] ?? null,
        metrics: options.metrics ?? (() => METRICS),
        hooks: {
            attach: (view, bounds) => attaches.push({ view, bounds }),
            detach: (view) => detaches.push(view),
            setBounds: (view, bounds) => moves.push({ view, bounds })
        },
        ...(options.windowID === undefined ? {} : { windowID: options.windowID }),
        onChange: (event) => events.push(event)
    });

    return { controller, attaches, detaches, moves, events, views };
}

describe('placing a view', () => {
    it('attaches the active view at the reported bounds', () => {
        const h = harness();
        expect(h.controller.apply(geometry())).toBe('placed');
        expect(h.attaches).toEqual([{ view: { id: 'T1' }, bounds: { x: 10, y: 20, width: 400, height: 300 } }]);
        expect(h.controller.embeddedPaneIDs).toEqual([PANE]);
    });

    it('moves rather than re-attaches when the rect changes', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.apply(geometry({ rect: { x: 10, y: 20, w: 400, h: 500 } }));
        expect(h.attaches).toHaveLength(1);
        expect(h.moves).toEqual([{ view: { id: 'T1' }, bounds: { x: 10, y: 20, width: 400, height: 500 } }]);
    });

    it('does nothing at all for an unchanged report (the throttle tail)', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.apply(geometry());
        h.controller.apply(geometry());
        expect(h.attaches).toHaveLength(1);
        expect(h.moves).toEqual([]);
        expect(h.events.filter((event) => event.outcome === 'placed')).toHaveLength(1);
    });

    it('swaps views on a tab switch, detaching the outgoing one first', () => {
        const h = harness({ views: { T1: { id: 'T1' }, T2: { id: 'T2' } } });
        h.controller.apply(geometry());
        h.controller.apply(geometry({ tabID: 'T2' }));
        expect(h.detaches).toEqual([{ id: 'T1' }]);
        expect(h.attaches.map((entry) => entry.view.id)).toEqual(['T1', 'T2']);
        expect(h.controller.placementOf(PANE)?.view).toEqual({ id: 'T2' });
    });

    it('keeps the current view when the new tab has no view yet', () => {
        const h = harness({ views: { T1: { id: 'T1' } } });
        h.controller.apply(geometry());
        expect(h.controller.apply(geometry({ tabID: 'T-not-built' }))).toBe('ignored');
        expect(h.detaches).toEqual([]);
        expect(h.controller.placementOf(PANE)?.view).toEqual({ id: 'T1' });
    });

    it('tracks panes independently', () => {
        const h = harness({ views: { T1: { id: 'T1' }, T9: { id: 'T9' } } });
        h.controller.apply(geometry());
        h.controller.apply(geometry({ paneID: OTHER, tabID: 'T9' }));
        expect(h.controller.embeddedPaneIDs).toEqual([PANE, OTHER]);
        h.controller.release(PANE);
        expect(h.controller.embeddedPaneIDs).toEqual([OTHER]);
    });
});

describe('returning a view to the holder', () => {
    it('detaches on a hide report', () => {
        const h = harness();
        h.controller.apply(geometry());
        expect(h.controller.apply(geometry({ visible: false }))).toBe('released');
        expect(h.detaches).toEqual([{ id: 'T1' }]);
        expect(h.controller.embeddedPaneIDs).toEqual([]);
    });

    it('detaches when the pane scrolls entirely out of the window', () => {
        const h = harness();
        h.controller.apply(geometry());
        expect(h.controller.apply(geometry({ rect: { x: 5000, y: 0, w: 400, h: 300 } }))).toBe('released');
        expect(h.detaches).toEqual([{ id: 'T1' }]);
    });

    it('detaches when the window goes away, and refuses to place while it is gone', () => {
        let window: WindowMetrics | null = METRICS;
        const h = harness({ metrics: () => window });
        h.controller.apply(geometry());
        window = null;
        expect(h.controller.apply(geometry())).toBe('released');
        expect(h.detaches).toEqual([{ id: 'T1' }]);
        expect(h.controller.apply(geometry())).toBe('released');
        // Still one detach: releasing an already-released pane must not touch the view again.
        expect(h.detaches).toHaveLength(1);
    });

    it('releaseAll empties the window (window closed, app quitting)', () => {
        const h = harness({ views: { T1: { id: 'T1' }, T9: { id: 'T9' } } });
        h.controller.apply(geometry());
        h.controller.apply(geometry({ paneID: OTHER, tabID: 'T9' }));
        h.controller.releaseAll('window-closed');
        expect(h.detaches.map((view) => view.id).sort()).toEqual(['T1', 'T9']);
        expect(h.controller.embeddedPaneIDs).toEqual([]);
        expect(h.events.at(-1)).toMatchObject({ outcome: 'released', reason: 'window-closed' });
    });

    it('forgets a destroyed view WITHOUT touching it', () => {
        const h = harness();
        h.controller.apply(geometry());
        expect(h.controller.forget(h.views['T1'] as FakeView)).toBe(true);
        // No detach hook: the view is being destroyed, and removeChildView would throw.
        expect(h.detaches).toEqual([]);
        expect(h.controller.embeddedPaneIDs).toEqual([]);
        expect(h.controller.forget({ id: 'stranger' })).toBe(false);
    });
});

describe('whose geometry it is', () => {
    it('ignores geometry the daemon did not tag as this host’s window', () => {
        const h = harness({ windowID: 'WIN' });
        expect(h.controller.apply(geometry({ ownWindow: false }))).toBe('ignored');
        expect(h.attaches).toEqual([]);
    });

    it('ignores a tagged report that names another window (defence in depth)', () => {
        const h = harness({ windowID: 'WIN' });
        expect(h.controller.apply(geometry({ shellWindowID: 'OTHER-WINDOW' }))).toBe('ignored');
        expect(h.attaches).toEqual([]);
    });

    it('accepts the host’s own window', () => {
        const h = harness({ windowID: 'WIN' });
        expect(h.controller.apply(geometry({ shellWindowID: 'WIN' }))).toBe('placed');
    });
});

describe('a park this shell performs, and undoes (issue #75)', () => {
    it('parkAll takes every view back to the holder but keeps the placement', () => {
        const h = harness({ views: { T1: { id: 'T1' }, T9: { id: 'T9' } } });
        h.controller.apply(geometry());
        h.controller.apply(geometry({ paneID: OTHER, tabID: 'T9' }));
        h.controller.parkAll('window-hidden');
        expect(h.detaches.map((view) => view.id).sort()).toEqual(['T1', 'T9']);
        // Not in the window any more...
        expect(h.controller.embeddedPaneIDs).toEqual([]);
        // ...but still owed a placement, which is the whole difference from releaseAll.
        expect([...h.controller.parkedPaneIDs].sort()).toEqual([PANE, OTHER].sort());
        expect(h.events.at(-1)).toMatchObject({ outcome: 'released', reason: 'window-hidden' });
    });

    it('refresh puts a parked view back, attaching it rather than moving it', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.parkAll('window-hidden');
        h.controller.refresh();
        // Two attaches, no setBounds: a parked view is a child of the HOLDER, so positioning it
        // would leave the page off screen at the right coordinates.
        expect(h.attaches.map((entry) => entry.view.id)).toEqual(['T1', 'T1']);
        expect(h.moves).toEqual([]);
        expect(h.controller.embeddedPaneIDs).toEqual([PANE]);
        expect(h.controller.parkedPaneIDs).toEqual([]);
        expect(h.events.at(-1)).toMatchObject({ outcome: 'placed', reason: 'attached' });
    });

    it('re-clamps against the window the view comes back to, not the one it left', () => {
        let metrics: WindowMetrics = METRICS;
        const h = harness({ metrics: () => metrics });
        h.controller.apply(geometry({ rect: { x: 10, y: 20, w: 400, h: 300 } }));
        h.controller.parkAll('window-minimized');
        // The user resized the window while it was minimised.
        metrics = { contentWidth: 300, contentHeight: 200, scaleFactor: 1 };
        h.controller.refresh();
        expect(h.attaches.at(-1)?.bounds).toEqual({ x: 10, y: 20, width: 290, height: 180 });
    });

    it('a pane the CLIENT hid while the window was away is NOT brought back', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.parkAll('window-hidden');
        // The workspace switched (or the pane was closed) while the window was hidden.
        expect(h.controller.apply(geometry({ visible: false }))).toBe('released');
        expect(h.controller.parkedPaneIDs).toEqual([]);
        h.controller.refresh();
        expect(h.attaches).toHaveLength(1);
        expect(h.controller.embeddedPaneIDs).toEqual([]);
    });

    it('the view is detached exactly once however many parks arrive', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.parkAll('window-hidden');
        h.controller.parkAll('window-minimized');
        expect(h.controller.park(PANE, 'again')).toBe(false);
        expect(h.detaches).toEqual([{ id: 'T1' }]);
    });

    it('releaseAll drops a parked placement without touching the view again', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.parkAll('window-hidden');
        h.controller.releaseAll('window-closed');
        expect(h.detaches).toEqual([{ id: 'T1' }]);
        expect(h.controller.parkedPaneIDs).toEqual([]);
        h.controller.refresh();
        expect(h.attaches).toHaveLength(1);
    });

    it('forgets a parked placement when its view is destroyed', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.parkAll('window-hidden');
        expect(h.controller.forget(h.views['T1'] as FakeView)).toBe(true);
        expect(h.controller.parkedPaneIDs).toEqual([]);
    });

    it('does not offer a parked placement as where the view IS (the poster’s box, issue #12)', () => {
        const h = harness();
        h.controller.apply(geometry());
        expect(h.controller.placementOf(PANE)).not.toBeNull();
        h.controller.parkAll('window-hidden');
        expect(h.controller.placementOf(PANE)).toBeNull();
    });

    it('a report arriving while the window has no metrics parks rather than forgets', () => {
        let window: WindowMetrics | null = METRICS;
        const h = harness({ metrics: () => window });
        h.controller.apply(geometry());
        window = null;
        expect(h.controller.apply(geometry())).toBe('released');
        expect(h.controller.parkedPaneIDs).toEqual([PANE]);
        expect(h.events.at(-1)).toMatchObject({ reason: 'no-window' });
        window = METRICS;
        h.controller.refresh();
        expect(h.controller.embeddedPaneIDs).toEqual([PANE]);
    });

    it('a hide report with no window still forgets, so a deliberate park survives the restore', () => {
        let window: WindowMetrics | null = METRICS;
        const h = harness({ metrics: () => window });
        h.controller.apply(geometry());
        window = null;
        expect(h.controller.apply(geometry({ visible: false }))).toBe('released');
        expect(h.controller.parkedPaneIDs).toEqual([]);
        window = METRICS;
        h.controller.refresh();
        expect(h.controller.embeddedPaneIDs).toEqual([]);
    });

    it('a window with no content area parks; a pane scrolled out of one still forgets', () => {
        let metrics: WindowMetrics = METRICS;
        const h = harness({ metrics: () => metrics });
        h.controller.apply(geometry());
        // A display reconfiguration: the window is there and has no box at all.
        metrics = { contentWidth: 0, contentHeight: 0, scaleFactor: 1 };
        h.controller.apply(geometry());
        expect(h.controller.parkedPaneIDs).toEqual([PANE]);
        expect(h.events.at(-1)).toMatchObject({ reason: 'no-content-area' });

        metrics = METRICS;
        h.controller.refresh();
        expect(h.controller.embeddedPaneIDs).toEqual([PANE]);
        // …whereas a pane dragged out of a perfectly good window is the client's business.
        h.controller.apply(geometry({ rect: { x: 5000, y: 0, w: 400, h: 300 } }));
        expect(h.controller.parkedPaneIDs).toEqual([]);
        expect(h.events.at(-1)).toMatchObject({ reason: 'off-screen' });
    });

    it('a tab switch onto a parked pane attaches the new view and leaves no second entry', () => {
        const h = harness({ views: { T1: { id: 'T1' }, T2: { id: 'T2' } } });
        h.controller.apply(geometry());
        h.controller.parkAll('window-hidden');
        h.controller.apply(geometry({ tabID: 'T2' }));
        // The outgoing view is already in the holder: detaching it again would remove a child
        // of a window it is not in.
        expect(h.detaches).toEqual([{ id: 'T1' }]);
        expect(h.attaches.map((entry) => entry.view.id)).toEqual(['T1', 'T2']);
        expect(h.controller.embeddedPaneIDs).toEqual([PANE]);
        expect(h.controller.parkedPaneIDs).toEqual([]);
    });
});

describe('refresh', () => {
    it('re-applies the last geometry once the view finally exists', () => {
        const views: Record<string, FakeView | null> = {};
        const h = harness({ views });
        // The report arrives before the daemon's `tab-open` reaches the host.
        expect(h.controller.apply(geometry())).toBe('ignored');
        h.controller.apply(geometry({ tabID: 'T0' }));
        expect(h.attaches).toEqual([]);

        // Once a view exists, a refresh needs a placed pane to re-apply — so place it first.
        views['T1'] = { id: 'T1' };
        h.controller.apply(geometry());
        views['T1'] = { id: 'T1-reloaded' };
        h.controller.refresh();
        expect(h.attaches.map((entry) => entry.view.id)).toEqual(['T1', 'T1-reloaded']);
        expect(h.detaches.map((view) => view.id)).toEqual(['T1']);
    });

    it('releases everything when the window disappeared between reports', () => {
        let window: WindowMetrics | null = METRICS;
        const h = harness({ metrics: () => window });
        h.controller.apply(geometry());
        window = null;
        h.controller.refresh();
        expect(h.detaches).toEqual([{ id: 'T1' }]);
    });
});

/**
 * Issue #76's shell-side half: a view destroyed under a placement leaves the pane out of the
 * books entirely, so `refresh()` cannot see it. The rebuilt view has to be placed from the rect
 * the client last reported, because the client has no reason to report it again - the page hole
 * never moved, and identical reports are dropped before they leave the renderer.
 */
describe('reapply after a view was destroyed', () => {
    it('places the rebuilt view at the rect the crashed one occupied', () => {
        const views: Record<string, FakeView | null> = { T1: { id: 'T1' } };
        const h = harness({ views });
        h.controller.apply(geometry());
        expect(h.controller.embeddedPaneIDs).toEqual([PANE]);

        // The renderer died: the registry destroys the view, which unhooks it here.
        expect(h.controller.forget(views['T1'] as FakeView)).toBe(true);
        expect(h.controller.embeddedPaneIDs).toEqual([]);
        // `refresh` walks the PLACED panes, and this one is no longer among them.
        h.controller.refresh();
        expect(h.attaches).toHaveLength(1);

        views['T1'] = { id: 'T1-rebuilt' };
        expect(h.controller.reapply(PANE)).toBe(true);
        expect(h.attaches.map((entry) => entry.view.id)).toEqual(['T1', 'T1-rebuilt']);
        expect(h.attaches[1]?.bounds).toEqual({ x: 10, y: 20, width: 400, height: 300 });
    });

    it('is a no-op for a pane that is already placed, and for one never reported', () => {
        const h = harness();
        h.controller.apply(geometry());
        expect(h.controller.reapply(PANE)).toBe(true);
        expect(h.attaches).toHaveLength(1);
        expect(h.controller.reapply(OTHER)).toBe(false);
    });

    /**
     * The one way this could become a worse bug than the one it fixes: a pane the user parked on
     * purpose must not be put back on screen by a rebuild. It cannot be, because the remembered
     * report is the LAST one and parking a pane is itself a report.
     */
    it('replays a hidden report as a release, not a placement', () => {
        const views: Record<string, FakeView | null> = { T1: { id: 'T1' } };
        const h = harness({ views });
        h.controller.apply(geometry());
        h.controller.apply(geometry({ visible: false }));
        expect(h.controller.embeddedPaneIDs).toEqual([]);

        views['T1'] = { id: 'T1-rebuilt' };
        expect(h.controller.reapply(PANE)).toBe(false);
        expect(h.attaches.map((entry) => entry.view.id)).toEqual(['T1']);
    });

    it('forgets the remembered rect when the pane itself closes', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.forgetPane(PANE);
        expect(h.detaches).toEqual([{ id: 'T1' }]);
        expect(h.controller.reapply(PANE)).toBe(false);
    });
});

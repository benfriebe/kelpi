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
        transient: false,
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
    /** Issue #12: stop drawing a view without moving it. */
    const visibilities: { view: FakeView; visible: boolean }[] = [];
    const events: EmbedEvent[] = [];
    const views = options.views ?? { T1: { id: 'T1' } };

    const controller = createEmbedController<FakeView>({
        resolveView: (_paneID, tabID) => views[tabID ?? 'T1'] ?? null,
        metrics: options.metrics ?? (() => METRICS),
        hooks: {
            attach: (view, bounds) => attaches.push({ view, bounds }),
            detach: (view) => detaches.push(view),
            setBounds: (view, bounds) => moves.push({ view, bounds }),
            setVisible: (view, visible) => visibilities.push({ view, visible })
        },
        ...(options.windowID === undefined ? {} : { windowID: options.windowID }),
        onChange: (event) => events.push(event)
    });

    return { controller, attaches, detaches, moves, visibilities, events, views };
}

/**
 * Issue #12, round 3 — a pane that is merely COVERED keeps its view, and its layout.
 *
 * `visible:false` used to mean one thing. It means two, and only one of them wants the holder:
 * taking a view back re-pins the page's viewport to the automation default, so the page reflows
 * on the way out and again on the way back, and the frames between the view returning and the
 * page repainting show the 1280×800 layout clipped into the pane. Photographed at 259 ms after a
 * menu closed, on a fixture whose relayout costs what a real page's costs.
 */
describe('a transient park (issue #12)', () => {
    it('hides the view where it stands rather than taking it back', () => {
        const h = harness();
        h.controller.apply(geometry());
        expect(h.attaches).toHaveLength(1);

        h.controller.apply(geometry({ visible: false, transient: true }));
        // Not moved, not re-pinned, not re-parented: just not drawn.
        expect(h.detaches).toEqual([]);
        expect(h.visibilities).toEqual([{ view: { id: 'T1' }, visible: false }]);
        expect(h.controller.embeddedPaneIDs).toEqual([PANE]);
        expect(h.events.at(-1)).toMatchObject({ outcome: 'hidden', reason: 'covered' });
    });

    it('shows it again on the next visible report, with no bounds change', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.apply(geometry({ visible: false, transient: true }));
        h.controller.apply(geometry());

        expect(h.visibilities).toEqual([
            { view: { id: 'T1' }, visible: false },
            { view: { id: 'T1' }, visible: true }
        ]);
        // One attach for the life of the pane, and no move: the restore is the visibility flip
        // and nothing else, which is what leaves the page's layout untouched.
        expect(h.attaches).toHaveLength(1);
        expect(h.moves).toEqual([]);
        expect(h.events.at(-1)).toMatchObject({ outcome: 'placed', reason: 'uncovered' });
    });

    it('still takes the view back when the pane really leaves the screen', () => {
        const h = harness();
        h.controller.apply(geometry());
        // No `transient`: a workspace switch, a zoom, an unmount. The automation viewport is
        // specified against the holder, so this path must not change.
        h.controller.apply(geometry({ visible: false }));
        expect(h.detaches).toEqual([{ id: 'T1' }]);
        expect(h.visibilities).toEqual([]);
        expect(h.controller.embeddedPaneIDs).toEqual([]);
    });

    /**
     * The regression this pins is worse than the defect it came from.
     *
     * `refresh()` re-applies each placement's own geometry and runs on every tab-open /
     * tab-select / tab-close / pane-open for ANY pane. While the park stored no geometry, that
     * replayed the last VISIBLE one and put the view back on screen with the menu still up —
     * composited OVER it, so the menu was invisible but still held the keyboard and the pointer
     * reached the page underneath. A `kelpi web open` in another terminal was enough to trigger
     * it, and so was the covered page calling `window.open`.
     */
    it('stays hidden through a refresh (another pane opening a tab must not un-hide it)', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.apply(geometry({ visible: false, transient: true }));
        h.visibilities.length = 0;

        h.controller.refresh();
        h.controller.refresh();

        expect(h.visibilities).toEqual([]);
        expect(h.attaches).toHaveLength(1);
        expect(h.events.at(-1)).toMatchObject({ outcome: 'hidden' });
    });

    it('un-hides on the way out, so a view never reaches the holder invisible', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.apply(geometry({ visible: false, transient: true }));
        h.visibilities.length = 0;

        // The pane really goes now (closed, workspace switched, window gone).
        h.controller.release(PANE);
        expect(h.visibilities).toEqual([{ view: { id: 'T1' }, visible: true }]);
        expect(h.detaches).toEqual([{ id: 'T1' }]);
    });

    it('ignores a transient park for a pane it never placed', () => {
        const h = harness();
        expect(h.controller.apply(geometry({ visible: false, transient: true }))).toBe('released');
        expect(h.visibilities).toEqual([]);
    });

    it('is idempotent while the surface stays up', () => {
        const h = harness();
        h.controller.apply(geometry());
        h.controller.apply(geometry({ visible: false, transient: true }));
        h.controller.apply(geometry({ visible: false, transient: true }));
        expect(h.visibilities).toHaveLength(1);
    });
});

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

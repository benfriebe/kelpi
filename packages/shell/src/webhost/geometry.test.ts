/**
 * The CSS-px → DIP conversion and the content-area clamp.
 *
 * Both are invisible when they are right and produce a view in the wrong place (or a view the
 * size of a postage stamp on a retina display) when they are wrong, which is exactly the kind
 * of arithmetic that deserves a table of cases rather than a live test.
 */

import { describe, expect, it } from 'vitest';

import {
    cssToDipScale,
    parsePaneGeometry,
    sameBounds,
    viewBounds,
    type PaneGeometry,
    type WindowMetrics
} from './geometry.js';

const PANE = 'AAAAAAAA-0000-4000-8000-00000000000A';

function geometry(overrides: Partial<PaneGeometry> = {}): PaneGeometry {
    return {
        paneID: PANE,
        tabID: 'T1',
        rect: { x: 100, y: 50, w: 800, h: 600 },
        visible: true,
        transient: false,
        devicePixelRatio: 2,
        ownWindow: true,
        shellWindowID: 'WIN',
        ...overrides
    };
}

const RETINA: WindowMetrics = { contentWidth: 1440, contentHeight: 900, scaleFactor: 2 };
const PLAIN: WindowMetrics = { contentWidth: 1440, contentHeight: 900, scaleFactor: 1 };

describe('cssToDipScale', () => {
    it('is 1 whenever the page is unzoomed, whatever the display', () => {
        expect(cssToDipScale(2, 2)).toBe(1);
        expect(cssToDipScale(1, 1)).toBe(1);
        expect(cssToDipScale(3, 3)).toBe(1);
    });

    it('is the page zoom: dpr is display scale × zoom', () => {
        expect(cssToDipScale(3, 2)).toBe(1.5); // ⌘+ on a retina panel
        expect(cssToDipScale(0.8, 1)).toBeCloseTo(0.8); // ⌘- on a 1× panel
    });

    it('falls back to 1 rather than producing a zero or NaN view', () => {
        expect(cssToDipScale(0, 2)).toBe(1);
        expect(cssToDipScale(2, 0)).toBe(1);
        expect(cssToDipScale(Number.NaN, 2)).toBe(1);
        expect(cssToDipScale(2, Number.POSITIVE_INFINITY)).toBe(1);
    });
});

describe('viewBounds', () => {
    it('passes an unzoomed rect straight through on a retina window', () => {
        expect(viewBounds(geometry(), RETINA)).toEqual({ x: 100, y: 50, width: 800, height: 600 });
    });

    it('scales a zoomed page into DIP', () => {
        // dpr 3 on a 2× display = 1.5× page zoom: the chrome the client drew is 1.5× bigger in
        // DIP too, so the view has to grow with it.
        const bounds = viewBounds(geometry({ devicePixelRatio: 3 }), RETINA);
        expect(bounds).toEqual({ x: 150, y: 75, width: 1200, height: 825 });
    });

    it('clamps to the window content area, keeping a partly-visible pane visible', () => {
        // A pane hanging off the right edge keeps its left part rather than sliding inward.
        const bounds = viewBounds(geometry({ rect: { x: 1200, y: 50, w: 800, h: 600 } }), RETINA);
        expect(bounds).toEqual({ x: 1200, y: 50, width: 240, height: 600 });
    });

    it('clamps the top edge instead of sliding the rect down', () => {
        const bounds = viewBounds(geometry({ rect: { x: 10, y: -100, w: 400, h: 300 } }), RETINA);
        expect(bounds).toEqual({ x: 10, y: 0, width: 400, height: 200 });
    });

    it('is null for a rect entirely outside the window', () => {
        expect(viewBounds(geometry({ rect: { x: 2000, y: 0, w: 400, h: 300 } }), RETINA)).toBeNull();
        expect(viewBounds(geometry({ rect: { x: 0, y: -400, w: 400, h: 300 } }), RETINA)).toBeNull();
    });

    it('is null when the pane is not visible or has no area', () => {
        expect(viewBounds(geometry({ visible: false }), RETINA)).toBeNull();
        expect(viewBounds(geometry({ rect: { x: 0, y: 0, w: 0, h: 600 } }), RETINA)).toBeNull();
    });

    it('is null for a window with no content area yet', () => {
        expect(viewBounds(geometry(), { contentWidth: 0, contentHeight: 0, scaleFactor: 2 })).toBeNull();
    });

    it('treats a 1× window the same way (dpr 1)', () => {
        expect(viewBounds(geometry({ devicePixelRatio: 1 }), PLAIN)).toEqual({
            x: 100,
            y: 50,
            width: 800,
            height: 600
        });
    });
});

describe('parsePaneGeometry', () => {
    it('reads the notify args the daemon sends', () => {
        const parsed = parsePaneGeometry({
            paneID: PANE,
            tabID: 'T1',
            rect: { x: 1, y: 2, w: 3, h: 4 },
            visible: true,
            devicePixelRatio: 2,
            ownWindow: true,
            shellWindowID: 'WIN'
        });
        expect(parsed).toEqual({
            paneID: PANE,
            tabID: 'T1',
            rect: { x: 1, y: 2, w: 3, h: 4 },
            visible: true,
            // Issue #12: absent means "not a transient park", which is every report a client
            // sent before the flag existed and every report about a pane that really went away.
            transient: false,
            devicePixelRatio: 2,
            ownWindow: true,
            shellWindowID: 'WIN'
        });
    });

    it('reads the transient flag a covered pane sends (issue #12)', () => {
        const parsed = parsePaneGeometry({
            paneID: PANE,
            rect: { x: 1, y: 2, w: 3, h: 4 },
            visible: false,
            transient: true,
            ownWindow: true
        });
        expect(parsed?.transient).toBe(true);
        // Anything but `true` is the safe reading: take the view back, as every host did before.
        expect(parsePaneGeometry({ paneID: PANE, rect: { x: 1, y: 2, w: 3, h: 4 }, transient: 'yes' })?.transient).toBe(
            false
        );
    });

    it('refuses args with no pane, and never trusts a missing ownWindow', () => {
        expect(parsePaneGeometry({ rect: { x: 0, y: 0, w: 1, h: 1 } })).toBeNull();
        expect(parsePaneGeometry({ paneID: PANE })?.ownWindow).toBe(false);
    });

    it('degrades a malformed rect into "not visible"', () => {
        const parsed = parsePaneGeometry({ paneID: PANE, rect: 'nope', visible: true, ownWindow: true });
        expect(parsed?.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
        expect(parsed?.visible).toBe(false);
        expect(parsed?.devicePixelRatio).toBe(1);
    });
});

describe('sameBounds', () => {
    it('compares by value, with null meaning "nowhere"', () => {
        expect(sameBounds({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
        expect(sameBounds({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 })).toBe(false);
        expect(sameBounds(null, null)).toBe(true);
        expect(sameBounds(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false);
    });
});

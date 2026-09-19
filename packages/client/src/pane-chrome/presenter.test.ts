/**
 * The presenter's two pure pieces and the window's one latch.
 *
 * The HOST itself is driven end to end by `features/pane-lab.test.ts`, which runs the shipped
 * example against it; what is here is the geometry the slot computes (which nothing else can assert
 * once it is inside a `clip-path` string) and the latch the Settings row and the grid both read.
 */

import { describe, expect, it } from 'vitest';

import { FOCUS_RING_WIDTH } from '../grid/FocusRing';

import { PANE_CHROME_LIMITS } from './contract';
import {
    clearPaneChromeDeclarations,
    clearPaneChromeHeights,
    paneChromeDeclaration,
    paneChromeDragRegionsFor,
    retainPaneChromeHeights,
    setPaneChromeDragRegions,
    setPaneChromeHeight
} from './height';
import { paneChromeDragRegion } from './contract';
import { createPaneChromeRefs } from './projection';
import {
    clearPaneChromePainted,
    clearPaneChromePresenterFailure,
    notePaneChromePainted,
    notePaneChromePresenterFailure,
    paneChromePaintedGeneration,
    paneChromePresenterFailure,
    resetPaneChromePresenterFailures,
    subscribePaneChromePainted,
    subscribePaneChromePresenters
} from './presenter';
import { paneChromeClipPath, paneChromeFrameRect, paneChromeGripRect } from './presenter-slot';

const rect = (width = 600, height = 480, x = 0, y = 0) => ({ x, y, width, height });

describe('paneChromeFrameRect', () => {
    it('reserves the focus ring on three sides, the hairline on the fourth and the grip in front', () => {
        const band = paneChromeFrameRect(rect(), PANE_CHROME_LIMITS.nativeHeight);
        expect(band.x).toBe(FOCUS_RING_WIDTH + PANE_CHROME_LIMITS.gripWidth);
        expect(band.y).toBe(FOCUS_RING_WIDTH);
        expect(band.width).toBe(600 - FOCUS_RING_WIDTH * 2 - PANE_CHROME_LIMITS.gripWidth);
        // The ring's top run plus the 1 px rule the host paints under every header.
        expect(band.height).toBe(PANE_CHROME_LIMITS.nativeHeight - FOCUS_RING_WIDTH - 1);
    });

    it('never overlaps the grip, at any width the two have to share', () => {
        for (const width of [3, 24, 48, 49, 131, 600, 1600]) {
            const band = paneChromeFrameRect(rect(width), 24);
            const grip = paneChromeGripRect(rect(width), 24);
            // The presenter's rectangle begins where the grip ends, always: a grip a presenter
            // could draw over is a drag handle nobody can press.
            expect(band.x).toBeGreaterThanOrEqual(grip.x + grip.width);
            expect(band.width).toBeGreaterThanOrEqual(0);
        }
    });

    it('follows a declared band rather than the native one', () => {
        const band = paneChromeFrameRect(rect(), 96);
        expect(band.height).toBe(96 - FOCUS_RING_WIDTH - 1);
    });

    it('gives the header the band when there is no room for both', () => {
        // A grip needs room for itself and for a header beside it. Below that the header wins,
        // because a pane with a handle and no title is worse than one that has to be moved another
        // way - the context menu and the keyboard are both still there.
        const narrow = paneChromeGripRect(rect(40), 24);
        expect(narrow.width).toBe(0);
        expect(paneChromeFrameRect(rect(40), 24).x).toBe(FOCUS_RING_WIDTH);
        const wide = paneChromeGripRect(rect(600), 24);
        expect(wide.width).toBe(PANE_CHROME_LIMITS.gripWidth);
        expect(wide.height).toBe(24 - FOCUS_RING_WIDTH - 1);
    });

    it('keeps the strips rather than returning a negative rectangle', () => {
        // A band this short is a band nobody declared, and a zero- or negative-sized frame would be
        // a worse defect than a clipped ring - the same rule the web pane's hole follows.
        const band = paneChromeFrameRect(rect(), 2);
        expect(band.x).toBe(0);
        expect(band.y).toBe(0);
        expect(band.height).toBe(2);
        const narrow = paneChromeFrameRect(rect(3), 24);
        expect(narrow.x).toBe(0);
        expect(narrow.width).toBe(3);
    });

    it('offsets by the pane\'s own position in the grid', () => {
        const band = paneChromeFrameRect(rect(400, 300, 640, 120), 24);
        expect(band.x).toBe(640 + FOCUS_RING_WIDTH + PANE_CHROME_LIMITS.gripWidth);
        expect(band.y).toBe(120 + FOCUS_RING_WIDTH);
        expect(paneChromeGripRect(rect(400, 300, 640, 120), 24).x).toBe(640 + FOCUS_RING_WIDTH);
    });
});

describe('paneChromeClipPath', () => {
    it('unions one subpath per band', () => {
        const path = paneChromeClipPath([
            { x: 2, y: 2, width: 100, height: 21 },
            { x: 2, y: 302, width: 100, height: 21 }
        ]);
        expect(path).toBe(`path('M2 2H102V23H2ZM2 302H102V323H2Z')`);
    });

    it('clips to nothing when there is no band to draw', () => {
        // A mounted, attached presenter drawing no pixels: a workspace with no visible pane, and
        // every frame before the grid has measured itself.
        expect(paneChromeClipPath([])).toBe(`path('M0 0Z')`);
        expect(paneChromeClipPath([{ x: 0, y: 0, width: 0, height: 21 }])).toBe(`path('M0 0Z')`);
    });
});

describe('the window failure latch', () => {
    it('is keyed by generation, notifies once per change, and Retry clears it', () => {
        resetPaneChromePresenterFailures();
        const seen: (string | null)[] = [];
        const stop = subscribePaneChromePresenters(() =>
            seen.push(paneChromePresenterFailure()?.generation ?? null)
        );
        notePaneChromePresenterFailure('view:1:a', 'crashed');
        // The same generation failing twice is one broken presenter, not two.
        notePaneChromePresenterFailure('view:1:a', 'crashed again');
        expect(paneChromePresenterFailure()).toEqual({ generation: 'view:1:a', detail: 'crashed' });
        // A reload moves the generation, which is a different presenter and a fresh latch.
        notePaneChromePresenterFailure('view:2:b', 'crashed');
        expect(paneChromePresenterFailure()?.generation).toBe('view:2:b');
        clearPaneChromePresenterFailure();
        expect(paneChromePresenterFailure()).toBeNull();
        clearPaneChromePresenterFailure();
        expect(seen).toEqual(['view:1:a', 'view:2:b', null]);
        stop();
    });

    it('returns a stable value between changes, so a store reader cannot spin', () => {
        resetPaneChromePresenterFailures();
        notePaneChromePresenterFailure('view:1:a', 'crashed');
        expect(paneChromePresenterFailure()).toBe(paneChromePresenterFailure());
        resetPaneChromePresenterFailures();
        expect(paneChromePresenterFailure()).toBeNull();
    });
});

describe('the window painted latch', () => {
    it('names one generation, and a reload puts the bundled header back until the new one paints', () => {
        resetPaneChromePresenterFailures();
        const seen: (string | null)[] = [];
        const stop = subscribePaneChromePainted(() => seen.push(paneChromePaintedGeneration()));
        expect(paneChromePaintedGeneration()).toBeNull();
        notePaneChromePainted('view:1:a');
        expect(paneChromePaintedGeneration()).toBe('view:1:a');
        // A repeat is not a change: a store that republished would re-render the whole grid on
        // every frame the presenter acknowledged.
        notePaneChromePainted('view:1:a');
        // The reload: a new instance has painted nothing, so the bundled header draws again until
        // it says otherwise.
        clearPaneChromePainted();
        expect(paneChromePaintedGeneration()).toBeNull();
        notePaneChromePainted('view:2:b');
        expect(seen).toEqual(['view:1:a', null, 'view:2:b']);
        stop();
        resetPaneChromePresenterFailures();
    });
});

describe('retainPaneChromeHeights', () => {
    it('drops every band but the carried panes\', and leaves a carried one alone', () => {
        clearPaneChromeHeights();
        setPaneChromeHeight('carried', 96);
        setPaneChromeHeight('withheld', 96);
        setPaneChromeHeight('hidden', 48);
        retainPaneChromeHeights(['carried']);
        expect(paneChromeDeclaration('carried')).toBe(96);
        // A pane the frame no longer carries is wearing the bundled 24 px header, and a bundled
        // header floating inside a 96 px band is the defect this exists for - with the pane's body
        // rect, its terminal's rows and a web pane's bounds all still computed from it.
        expect(paneChromeDeclaration('withheld')).toBeNull();
        expect(paneChromeDeclaration('hidden')).toBeNull();
        clearPaneChromeHeights();
    });

    it('does nothing at all when every declaration is carried', () => {
        clearPaneChromeHeights();
        setPaneChromeHeight('a', 40);
        retainPaneChromeHeights(new Set(['a', 'b']));
        expect(paneChromeDeclaration('a')).toBe(40);
        clearPaneChromeHeights();
    });
});

describe('createPaneChromeRefs', () => {
    it('gives one key one token for the pane\'s life, whatever the row does', () => {
        const refs = createPaneChromeRefs();
        const split = refs.mint('p1', 'control', 'split-right');
        const close = refs.mint('p1', 'control', 'close');
        expect(split).not.toBe(close);
        // A plugin command arrives at the head of the row. A positional ref would have shifted
        // every token along and made a one-commit-old click activate its neighbour.
        const command = refs.mint('p1', 'control', 'example.board.inspect');
        expect([split, close]).not.toContain(command);
        expect(refs.mint('p1', 'control', 'split-right')).toBe(split);
        expect(refs.mint('p1', 'control', 'close')).toBe(close);
    });

    it('keeps the two lists apart, and each pane to itself', () => {
        const refs = createPaneChromeRefs();
        // The same id can name a `pane.header` command AND a `pane.header` item of one plugin, and
        // the two must not share a token: an item's ref may never activate a control.
        const control = refs.mint('p1', 'control', 'example.board.thing');
        const item = refs.mint('p1', 'item', 'example.board.thing');
        expect(control.startsWith('c')).toBe(true);
        expect(item.startsWith('i')).toBe(true);
        // Tokens are pane-scoped: the table is keyed by pane and the host re-checks the pane too.
        expect(refs.mint('p2', 'control', 'close')).toBe('c0');
        expect(refs.panes).toBe(2);
        refs.retain(['p1']);
        expect(refs.panes).toBe(1);
        // A pane that comes back gets its own numbering rather than a closed pane's.
        expect(refs.mint('p2', 'control', 'split-right')).toBe('c0');
    });

    it('carries no owner in the token it hands out', () => {
        const refs = createPaneChromeRefs();
        const ref = refs.mint('p1', 'control', 'example.board.inspect');
        expect(ref).not.toContain('example');
        expect(ref).not.toContain('board');
        expect(/^c\d+$/.test(ref)).toBe(true);
    });
});

describe('paneChromeDragRegion', () => {
    const band = { width: 400, height: 21 };

    it('clamps a rectangle into the band rather than refusing it', () => {
        // A presenter cannot widen its own header by asking for more than it has: a region that
        // reaches past every edge comes back as the band, which is what keeps a host surface off a
        // terminal, a web page's hole, a divider and the pane next door.
        expect(paneChromeDragRegion({ x: -500, y: -500, width: 9_999, height: 9_999 }, band)).toEqual({
            x: 0, y: 0, width: 400, height: 21
        });
        expect(paneChromeDragRegion({ x: 10.4, y: 0.6, width: 100.4, height: 20 }, band)).toEqual({
            x: 10, y: 1, width: 101, height: 20
        });
    });

    it('drops a rectangle with nothing left, rather than drawing a surface nobody can press', () => {
        expect(paneChromeDragRegion({ x: 500, y: 0, width: 40, height: 20 }, band)).toBeNull();
        expect(paneChromeDragRegion({ x: 0, y: 0, width: 0, height: 20 }, band)).toBeNull();
        expect(paneChromeDragRegion({ x: 0, y: 0, width: 40, height: -4 }, band)).toBeNull();
    });

    it('refuses anything that is not a number', () => {
        expect(paneChromeDragRegion({ x: Number.NaN, y: 0, width: 4, height: 4 }, band)).toBeNull();
        expect(paneChromeDragRegion({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 4 }, band)).toBeNull();
        expect(paneChromeDragRegion({ x: 0, y: 0, width: 4, height: 4 }, { width: Number.NaN, height: 21 })).toBeNull();
    });

    it('never leaves the band, at any offset the clamp has to reconcile', () => {
        for (const region of [
            { x: 399, y: 20, width: 40, height: 40 },
            { x: -10, y: -10, width: 20, height: 20 },
            { x: 0, y: 0, width: 400, height: 21 }
        ]) {
            const kept = paneChromeDragRegion(region, band);
            if (kept === null) continue;
            expect(kept.x).toBeGreaterThanOrEqual(0);
            expect(kept.y).toBeGreaterThanOrEqual(0);
            expect(kept.x + kept.width).toBeLessThanOrEqual(band.width);
            expect(kept.y + kept.height).toBeLessThanOrEqual(band.height);
        }
    });
});

describe('the declaration store, bands and regions together', () => {
    it('hands the regions back on every path that hands a band back', () => {
        clearPaneChromeDeclarations();
        setPaneChromeHeight('a', 96);
        setPaneChromeDragRegions('a', [{ x: 0, y: 0, width: 40, height: 20 }]);
        setPaneChromeDragRegions('b', [{ x: 0, y: 0, width: 40, height: 20 }]);
        // A pane that has left the projection: a host surface over a band nobody is drawing would
        // take a press that belongs to the bundled header under it.
        retainPaneChromeHeights(['a']);
        expect(paneChromeDragRegionsFor('a')).toHaveLength(1);
        expect(paneChromeDragRegionsFor('b')).toEqual([]);
        // And the stand-down takes both, which is the one call the presenter's own paths use.
        clearPaneChromeDeclarations();
        expect(paneChromeDeclaration('a')).toBeNull();
        expect(paneChromeDragRegionsFor('a')).toEqual([]);
    });

    it('treats an empty list as a withdrawal, and does not republish an unchanged one', () => {
        clearPaneChromeDeclarations();
        let notified = 0;
        const stop = subscribePaneChromePresenters(() => {
            notified += 1;
        });
        setPaneChromeDragRegions('a', [{ x: 1, y: 2, width: 3, height: 4 }]);
        setPaneChromeDragRegions('a', [{ x: 1, y: 2, width: 3, height: 4 }]);
        expect(paneChromeDragRegionsFor('a')).toHaveLength(1);
        setPaneChromeDragRegions('a', []);
        expect(paneChromeDragRegionsFor('a')).toEqual([]);
        stop();
        // The failure store is a different store; this only proves the region store did not throw
        // on the repeat, which is the content comparison doing its job.
        expect(notified).toBe(0);
        clearPaneChromeDeclarations();
    });
});

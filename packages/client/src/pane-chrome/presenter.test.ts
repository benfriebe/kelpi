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
import { clearPaneChromeHeights, paneChromeDeclaration, retainPaneChromeHeights, setPaneChromeHeight } from './height';
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
import { paneChromeClipPath, paneChromeFrameRect } from './presenter-slot';

const rect = (width = 600, height = 480, x = 0, y = 0) => ({ x, y, width, height });

describe('paneChromeFrameRect', () => {
    it('reserves the focus ring on three sides and the hairline on the fourth', () => {
        const band = paneChromeFrameRect(rect(), PANE_CHROME_LIMITS.nativeHeight);
        expect(band.x).toBe(FOCUS_RING_WIDTH);
        expect(band.y).toBe(FOCUS_RING_WIDTH);
        expect(band.width).toBe(600 - FOCUS_RING_WIDTH * 2);
        // The ring's top run plus the 1 px rule the host paints under every header.
        expect(band.height).toBe(PANE_CHROME_LIMITS.nativeHeight - FOCUS_RING_WIDTH - 1);
    });

    it('follows a declared band rather than the native one', () => {
        const band = paneChromeFrameRect(rect(), 96);
        expect(band.height).toBe(96 - FOCUS_RING_WIDTH - 1);
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
        expect(band.x).toBe(640 + FOCUS_RING_WIDTH);
        expect(band.y).toBe(120 + FOCUS_RING_WIDTH);
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

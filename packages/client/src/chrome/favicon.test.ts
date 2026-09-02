import { kelpieArt } from '@kelpi/core/icon';
import { describe, expect, it } from 'vitest';

import indexHtml from '../../index.html?raw';
import {
    DEFAULT_FAVICON_COLORS,
    FAVICON_SIZE,
    createFaviconController,
    drawFavicon,
    faviconBadgeColor,
    titleWithBadge,
    type FaviconCanvas,
    type FaviconContext
} from './index';

interface StrokedPoint {
    readonly x: number;
    readonly y: number;
}

interface FakeCanvas extends FaviconCanvas {
    readonly fills: string[];
    readonly arcs: number;
    readonly moves: StrokedPoint[];
    readonly lines: StrokedPoint[];
    readonly strokeWidths: number[];
    readonly caps: string[];
    readonly joins: string[];
    readonly contextAvailable: boolean;
}

function fakeCanvas(contextAvailable = true): FakeCanvas {
    const fills: string[] = [];
    const moves: StrokedPoint[] = [];
    const lines: StrokedPoint[] = [];
    const strokeWidths: number[] = [];
    const caps: string[] = [];
    const joins: string[] = [];
    let arcs = 0;
    const ctx: FaviconContext = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        lineCap: '',
        lineJoin: '',
        clearRect: () => undefined,
        fillRect: () => {
            fills.push(ctx.fillStyle);
        },
        beginPath: () => undefined,
        moveTo: (x, y) => {
            moves.push({ x, y });
        },
        lineTo: (x, y) => {
            lines.push({ x, y });
        },
        arc: () => {
            arcs += 1;
        },
        fill: () => {
            fills.push(ctx.fillStyle);
        },
        stroke: () => {
            strokeWidths.push(ctx.lineWidth);
            caps.push(ctx.lineCap);
            joins.push(ctx.lineJoin);
        }
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => (contextAvailable ? ctx : null),
        toDataURL: () => 'data:image/png;base64,FAKE',
        get fills() {
            return fills;
        },
        get arcs() {
            return arcs;
        },
        get moves() {
            return moves;
        },
        get lines() {
            return lines;
        },
        get strokeWidths() {
            return strokeWidths;
        },
        get caps() {
            return caps;
        },
        get joins() {
            return joins;
        },
        contextAvailable
    };
    return canvas as unknown as FakeCanvas;
}

describe('badge priority', () => {
    it('waiting beats running, and neither means no dot (§8.2)', () => {
        expect(faviconBadgeColor({ running: 2, waiting: 1 })).toBe(DEFAULT_FAVICON_COLORS.waiting);
        expect(faviconBadgeColor({ running: 2, waiting: 0 })).toBe(DEFAULT_FAVICON_COLORS.running);
        expect(faviconBadgeColor({ running: 0, waiting: 0 })).toBeNull();
    });

    it('folds the waiting count into the title, the dock-badge equivalent (§8.4)', () => {
        expect(titleWithBadge('Kelpi', 0)).toBe('Kelpi');
        expect(titleWithBadge('Kelpi', 3)).toBe('(3) Kelpi');
    });
});

describe('drawFavicon', () => {
    it('sizes the canvas, draws the badge dot and returns a data URL', () => {
        const canvas = fakeCanvas();
        const url = drawFavicon(canvas, { running: 1, waiting: 0 }, { size: 32 });
        expect(url).toBe('data:image/png;base64,FAKE');
        expect(canvas.width).toBe(32);
        expect(canvas.arcs).toBe(1);
        expect(canvas.fills).toContain(DEFAULT_FAVICON_COLORS.running);
    });

    it('draws no dot when nothing is running or waiting', () => {
        const canvas = fakeCanvas();
        drawFavicon(canvas, { running: 0, waiting: 0 });
        expect(canvas.arcs).toBe(0);
    });

    /**
     * Issue #13: the tab icon has to be the Kelpi mark, not the placeholder terminal glyph the
     * client shipped with. The proof is that what gets stroked is the SAME art the Dock tile
     * and the tray glyph render: every polyline of it, on the canvas the browser is handed.
     */
    it('strokes the Kelpi mark itself, in full', () => {
        const canvas = fakeCanvas();
        drawFavicon(canvas, { running: 0, waiting: 0 }, { size: 64 });
        const art = kelpieArt();
        expect(canvas.moves).toHaveLength(art.polylines.length);
        expect(canvas.lines).toHaveLength(art.polylines.reduce((total, line) => total + line.length - 1, 0));

        const first = art.polylines[0]?.[0];
        expect(first).toBeDefined();
        expect(canvas.moves[0]).toEqual({ x: (first?.x ?? 0) * 64, y: (first?.y ?? 0) * 64 });
        // Full bleed, like the tray glyph: the drawing frames itself inside its own square.
        const xs = canvas.lines.map((point) => point.x);
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...xs)).toBeLessThanOrEqual(64);
    });

    /** Round caps and joins are what make a chain of segments the stroke the SVG describes. */
    it('keeps the drawing\'s stroke contract, with a floor that survives a 16px tab', () => {
        const canvas = fakeCanvas();
        drawFavicon(canvas, { running: 0, waiting: 0 }, { size: 64 });
        expect(canvas.caps).toEqual(['round']);
        expect(canvas.joins).toEqual(['round']);
        expect(canvas.strokeWidths).toEqual([4]); // 1/16 of the canvas, the tray's own floor
    });

    it('defaults to a canvas the browser can downsample without losing the mane', () => {
        const canvas = fakeCanvas();
        drawFavicon(canvas, { running: 0, waiting: 0 });
        expect(canvas.width).toBe(FAVICON_SIZE);
        expect(FAVICON_SIZE).toBeGreaterThanOrEqual(64);
    });

    it('returns null when the canvas has no 2D context', () => {
        expect(drawFavicon(fakeCanvas(false), { running: 1, waiting: 0 })).toBeNull();
    });
});

describe('createFaviconController', () => {
    it('creates the link, updates href + title, and redraws only on change', () => {
        document.head.innerHTML = '';
        document.title = 'Kelpi';
        let draws = 0;
        const controller = createFaviconController({
            createCanvas: () => {
                draws += 1;
                return fakeCanvas();
            }
        });

        controller.update({ running: 0, waiting: 0 });
        const link = document.querySelector('link[rel~="icon"]');
        expect(link).not.toBeNull();
        expect(draws).toBe(1);

        controller.update({ running: 0, waiting: 0 });
        expect(draws).toBe(1); // unchanged state: no redraw

        controller.update({ running: 0, waiting: 2 });
        expect(draws).toBe(2);
        expect(document.title).toBe('(2) Kelpi');
        expect(link?.getAttribute('href')).toBe('data:image/png;base64,FAKE');

        controller.dispose();
        expect(document.title).toBe('Kelpi');
    });

    /**
     * The document ships the mark as `/favicon.svg` (see `index.html`); the badge replaces it
     * with a PNG of the same mark and must say so, then hand the link back untouched.
     */
    it('takes over the document\'s own icon link and restores it on dispose', () => {
        document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />';
        document.title = 'Kelpi';
        const controller = createFaviconController({ createCanvas: () => fakeCanvas() });

        controller.update({ running: 1, waiting: 0 });
        const link = document.querySelector('link[rel~="icon"]');
        expect(link?.getAttribute('href')).toBe('data:image/png;base64,FAKE');
        expect(link?.getAttribute('type')).toBe('image/png');

        controller.dispose();
        // Restored through the link's own `href` property, so it comes back absolutized.
        expect(link?.getAttribute('href')).toMatch(/\/favicon\.svg$/);
        expect(link?.getAttribute('type')).toBe('image/svg+xml');
    });

    it('is inert without a canvas (jsdom, blocked embedders) instead of throwing', () => {
        document.head.innerHTML = '';
        document.title = 'Kelpi';
        const controller = createFaviconController({ createCanvas: () => null });
        expect(() => {
            controller.update({ running: 1, waiting: 1 });
        }).not.toThrow();
        expect(document.title).toBe('(1) Kelpi'); // the title badge still works
        controller.dispose();
    });

    it('leaves the title alone when the host owns the dock badge', () => {
        document.head.innerHTML = '';
        document.title = 'Kelpi';
        const controller = createFaviconController({
            createCanvas: () => fakeCanvas(),
            updateTitle: false
        });
        controller.update({ running: 0, waiting: 4 });
        expect(document.title).toBe('Kelpi');
    });
});

/**
 * The served document's static icon.
 *
 * Nothing in the app reads `index.html`, so nothing else would notice it drifting back to a
 * placeholder or losing the link the badge controller needs to find. `vite.config.ts` emits
 * `/favicon.svg` from `@kelpi/core/icon` at build time; this pins the other half of that
 * contract, the href that asks for it.
 */
describe('the document the daemon serves', () => {
    const html = indexHtml;

    it('links the generated Kelpi mark as its icon', () => {
        expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    });

    it('carries no second icon link for the badge controller to pick the wrong one of', () => {
        expect([...html.matchAll(/<link[^>]*rel="icon"/g)]).toHaveLength(1);
    });
});

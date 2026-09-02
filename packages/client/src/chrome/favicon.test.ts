import {
    ART_VIEWBOX,
    KELPIE_MARK_BACKGROUND,
    KELPIE_MARK_FOREGROUND,
    KELPIE_MIN_STROKE_FRACTION,
    KELPIE_TAB_STROKE,
    kelpieArt
} from '@kelpi/core/icon';
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
        // The floor core states, which is also the stroke the emitted `/favicon.svg` carries.
        expect(canvas.strokeWidths).toEqual([64 * KELPIE_MIN_STROKE_FRACTION]);
        expect(KELPIE_TAB_STROKE / ART_VIEWBOX).toBe(KELPIE_MIN_STROKE_FRACTION);
    });

    /**
     * One palette, so the mark cannot change tone between the icon the document ships and the
     * one this module paints over it.
     */
    it('draws in the mark\'s own colours', () => {
        expect(DEFAULT_FAVICON_COLORS.foreground).toBe(KELPIE_MARK_FOREGROUND);
        expect(DEFAULT_FAVICON_COLORS.background).toBe(KELPIE_MARK_BACKGROUND);
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
     * The document ships the mark twice (see `index.html`), and which declaration a browser
     * prefers is its own business. Badging one and leaving the other would show the dot in
     * some browsers and not others, so the controller owns both, and hands both back.
     */
    it('takes over every icon link the document declares, and restores them on dispose', () => {
        document.head.innerHTML =
            '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />' +
            '<link rel="icon" type="image/png" sizes="64x64" href="/favicon.png" />' +
            '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />';
        document.title = 'Kelpi';
        const controller = createFaviconController({ createCanvas: () => fakeCanvas() });

        controller.update({ running: 1, waiting: 0 });
        const links = [...document.querySelectorAll('link[rel~="icon"]')];
        expect(links).toHaveLength(2);
        for (const link of links) {
            expect(link.getAttribute('href')).toBe('data:image/png;base64,FAKE');
            expect(link.getAttribute('type')).toBe('image/png');
        }
        // Not the home-screen tile: iOS reads that one at install time, and it is never badged.
        const touch = document.querySelector('link[rel="apple-touch-icon"]');
        expect(touch?.getAttribute('href')).toBe('/apple-touch-icon.png');

        controller.dispose();
        // Restored through each link's own `href` property, so they come back absolutized.
        expect(links[0]?.getAttribute('href')).toMatch(/\/favicon\.svg$/);
        expect(links[0]?.getAttribute('type')).toBe('image/svg+xml');
        expect(links[1]?.getAttribute('href')).toMatch(/\/favicon\.png$/);
        expect(links[1]?.getAttribute('type')).toBe('image/png');
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

    /**
     * The headline case in issue #13 is a phone over the tailnet, which means Safari: no SVG
     * favicon support, and no re-read of an icon script swapped in. Drop the raster links and
     * that browser is back to no kelpie at all, silently, with every test still green.
     */
    it('declares the raster forms Safari and iOS need', () => {
        expect(html).toContain('<link rel="icon" type="image/png" sizes="64x64" href="/favicon.png" />');
        expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    });
});

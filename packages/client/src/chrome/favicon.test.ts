import { describe, expect, it } from 'vitest';

import {
    DEFAULT_FAVICON_COLORS,
    createFaviconController,
    drawFavicon,
    faviconBadgeColor,
    titleWithBadge,
    type FaviconCanvas,
    type FaviconContext
} from './index';

interface FakeCanvas extends FaviconCanvas {
    readonly fills: string[];
    readonly arcs: number;
    readonly contextAvailable: boolean;
}

function fakeCanvas(contextAvailable = true): FakeCanvas {
    const fills: string[] = [];
    let arcs = 0;
    const ctx: FaviconContext = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        lineCap: '',
        clearRect: () => undefined,
        fillRect: () => {
            fills.push(ctx.fillStyle);
        },
        beginPath: () => undefined,
        moveTo: () => undefined,
        lineTo: () => undefined,
        arc: () => {
            arcs += 1;
        },
        fill: () => {
            fills.push(ctx.fillStyle);
        },
        stroke: () => undefined
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

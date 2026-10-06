import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    captureTerminalPoster,
    forgetTerminalPosters,
    hasTerminalPoster,
    resetTerminalPostersForTests,
    returnTerminalPoster,
    takeTerminalPoster,
    terminalPosterBytes
} from './poster';

/** A host holding an engine-shaped canvas: device size twice the CSS size, stated inline. */
function engineHost(cssWidth: number, cssHeight: number): HTMLElement {
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = cssWidth * 2;
    canvas.height = cssHeight * 2;
    canvas.style.width = `${String(cssWidth)}px`;
    canvas.style.height = `${String(cssHeight)}px`;
    host.appendChild(canvas);
    return host;
}

const drawImage = vi.fn();

beforeEach(() => {
    // jsdom has no 2D context; the copy only needs one to draw into.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => ({ drawImage }) as unknown as CanvasRenderingContext2D
    );
});

afterEach(() => {
    resetTerminalPostersForTests();
    drawImage.mockClear();
    vi.restoreAllMocks();
});

describe('terminal posters', () => {
    it('copies the engine canvas at its device size and keeps the CSS size it was laid out at', () => {
        const host = engineHost(400, 300);
        expect(captureTerminalPoster('pane-1', host)).toBe(true);
        const source = host.querySelector('canvas');
        expect(drawImage).toHaveBeenCalledWith(source, 0, 0);

        const poster = takeTerminalPoster('pane-1');
        expect(poster).not.toBeNull();
        // A COPY: the engine's own canvas carries the engine's listeners (see the module header).
        expect(poster?.canvas).not.toBe(source);
        expect([poster?.canvas.width, poster?.canvas.height]).toEqual([800, 600]);
        expect([poster?.cssWidth, poster?.cssHeight]).toEqual([400, 300]);
        expect(poster?.bytes).toBe(800 * 600 * 4);
    });

    it('declines a host with no canvas, a canvas with no size, or one the engine never laid out', () => {
        expect(captureTerminalPoster('pane-1', document.createElement('div'))).toBe(false);
        const empty = engineHost(400, 300);
        const canvas = empty.querySelector('canvas')!;
        canvas.width = 0;
        expect(captureTerminalPoster('pane-1', empty)).toBe(false);
        const unstyled = engineHost(400, 300);
        unstyled.querySelector('canvas')!.style.width = '';
        expect(captureTerminalPoster('pane-1', unstyled)).toBe(false);
        expect(hasTerminalPoster('pane-1')).toBe(false);
    });

    it('takes a poster out of the cache, and a return puts it back unless a newer one arrived', () => {
        captureTerminalPoster('pane-1', engineHost(10, 10));
        const first = takeTerminalPoster('pane-1');
        expect(first).not.toBeNull();
        expect(hasTerminalPoster('pane-1')).toBe(false);
        expect(takeTerminalPoster('pane-1')).toBeNull();

        returnTerminalPoster('pane-1', first!);
        expect(takeTerminalPoster('pane-1')).toBe(first);

        captureTerminalPoster('pane-1', engineHost(20, 20));
        returnTerminalPoster('pane-1', first!);
        expect(takeTerminalPoster('pane-1')?.cssWidth).toBe(20);
    });

    it('evicts the least recently stored posters to stay inside its byte budget', () => {
        const each = 20 * 20 * 4; // a 10x10 CSS canvas at 2x
        const budget = each * 2;
        captureTerminalPoster('a', engineHost(10, 10), budget);
        captureTerminalPoster('b', engineHost(10, 10), budget);
        expect(terminalPosterBytes()).toBe(budget);
        captureTerminalPoster('c', engineHost(10, 10), budget);
        expect(hasTerminalPoster('a')).toBe(false);
        expect(hasTerminalPoster('b')).toBe(true);
        expect(hasTerminalPoster('c')).toBe(true);
        expect(terminalPosterBytes()).toBe(budget);

        // Re-storing refreshes recency: `b` is now newer than `c`.
        captureTerminalPoster('b', engineHost(10, 10), budget);
        captureTerminalPoster('d', engineHost(10, 10), budget);
        expect(hasTerminalPoster('c')).toBe(false);
        expect(hasTerminalPoster('b')).toBe(true);

        // A poster bigger than the whole budget is not kept at all, and evicts nothing.
        captureTerminalPoster('huge', engineHost(100, 100), budget);
        expect(hasTerminalPoster('huge')).toBe(false);
        expect(terminalPosterBytes()).toBe(budget);
    });

    it('forgets the posters of closed panes', () => {
        captureTerminalPoster('a', engineHost(10, 10));
        captureTerminalPoster('b', engineHost(10, 10));
        forgetTerminalPosters(['a', 'never-seen']);
        expect(hasTerminalPoster('a')).toBe(false);
        expect(hasTerminalPoster('b')).toBe(true);
        expect(terminalPosterBytes()).toBe(20 * 20 * 4);
    });
});

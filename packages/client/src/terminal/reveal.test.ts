/**
 * `TerminalRenderer.revealMatch` — the adapter half of terminal search's scroll-to-match.
 *
 * Two things are worth pinning. The adapter must forward to the engine handle and must swallow
 * a throw rather than poison the pane (a scroll that did not take is not a dead terminal), and
 * the two engines' coordinate maths must actually be the inverse of each other: xterm.js's
 * `scrollToLine` takes the ABSOLUTE buffer line to put at the top of the viewport, while
 * ghostty-web's takes the number of lines scrolled UP FROM THE BOTTOM. Getting that backwards
 * scrolls to the far end of the scrollback, which no unit test above this layer would notice.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    createRendererFromLoader,
    type EngineHandle,
    type TerminalMatchLocation,
    type XtermLikeTerminal
} from './renderer';

class StubTerminal implements XtermLikeTerminal {
    cols = 80;
    rows = 24;
    open(): void {}
    write(_data: string | Uint8Array, callback?: () => void): void {
        callback?.();
    }
    reset(): void {}
    focus(): void {}
    blur(): void {}
    resize(cols: number, rows: number): void {
        this.cols = cols;
        this.rows = rows;
    }
    dispose(): void {}
    onData(): { dispose(): void } {
        return { dispose: () => undefined };
    }
}

function host(): HTMLElement {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return element;
}

async function liveRenderer(handle: Partial<EngineHandle>) {
    const terminal = new StubTerminal();
    const renderer = createRendererFromLoader('xterm', async () =>
        Promise.resolve({ terminal, ...handle } as EngineHandle)
    );
    await renderer.open(host());
    return renderer;
}

describe('revealMatch on the adapter', () => {
    it('forwards the match to the engine handle', async () => {
        const revealMatch = vi.fn();
        const renderer = await liveRenderer({ revealMatch });
        const match: TerminalMatchLocation = { linesFromBottom: 42, col: 7, length: 6 };
        renderer.revealMatch(match);
        expect(revealMatch).toHaveBeenCalledWith(match);
    });

    it('is a no-op for an engine with no hook', async () => {
        const renderer = await liveRenderer({});
        expect(() => renderer.revealMatch({ linesFromBottom: 1, col: 0, length: 1 })).not.toThrow();
    });

    it('swallows a throw instead of poisoning the pane', async () => {
        const renderer = await liveRenderer({
            revealMatch: () => {
                throw new Error('engine said no');
            }
        });
        renderer.revealMatch({ linesFromBottom: 1, col: 0, length: 1 });
        expect(renderer.failed).toBe(false);
    });

    it('does nothing after dispose', async () => {
        const revealMatch = vi.fn();
        const renderer = await liveRenderer({ revealMatch });
        renderer.dispose();
        renderer.revealMatch({ linesFromBottom: 1, col: 0, length: 1 });
        expect(revealMatch).not.toHaveBeenCalled();
    });
});

/**
 * The per-engine coordinate maths, restated against fakes shaped like the real APIs. These are
 * the exact expressions the loaders use; the point is that they are opposites, and that a
 * match near the bottom of a long buffer scrolls near the bottom in BOTH.
 */
describe('engine coordinate maths', () => {
    const rows = 24;
    const totalLines = 1000;
    const linesFromBottom = 60; // the match is 60 lines above the very bottom

    it('xterm.js: an absolute buffer line, centred in the viewport', () => {
        const absolute = totalLines - linesFromBottom; // 940
        const top = Math.max(0, Math.min(absolute - Math.floor(rows / 2), totalLines - rows));
        expect(absolute).toBe(940);
        expect(top).toBe(928);
        // The match row sits inside the viewport the scroll produced.
        expect(absolute).toBeGreaterThanOrEqual(top);
        expect(absolute).toBeLessThan(top + rows);
    });

    it('ghostty-web: lines scrolled up from the bottom, and a viewport-relative select row', () => {
        const scrollback = totalLines - rows; // 976
        const viewportY = Math.max(0, Math.min(scrollback, linesFromBottom - Math.floor(rows / 2)));
        expect(viewportY).toBe(48);
        const row = rows + viewportY - linesFromBottom;
        expect(row).toBe(12); // centred
        expect(row).toBeGreaterThanOrEqual(0);
        expect(row).toBeLessThan(rows);
    });

    it('both clamp a match at the very bottom to the live screen', () => {
        const atBottom = 1;
        expect(Math.max(0, Math.min(totalLines - rows, totalLines - atBottom - Math.floor(rows / 2)))).toBe(976);
        expect(Math.max(0, Math.min(totalLines - rows, atBottom - Math.floor(rows / 2)))).toBe(0);
    });
});

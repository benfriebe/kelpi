/**
 * `TerminalRenderer.revealMatch` — the adapter half of terminal search's scroll-to-match.
 *
 * Two things are worth pinning. The adapter must forward to the engine handle and must swallow
 * a throw rather than poison the pane (a scroll that did not take is not a dead terminal), and
 * the two engines' coordinate maths must actually be the inverse of each other: xterm.js's
 * `scrollToLine` takes the ABSOLUTE buffer line to put at the top of the viewport, while
 * ghostty-web's takes the number of lines scrolled UP FROM THE BOTTOM. Getting that backwards
 * scrolls to the far end of the scrollback, which no unit test above this layer would notice.
 *
 * Arithmetic against fakes is all this file can do, and #306 is what that costs: the engine's
 * own `select()` put the "revealed" match on the wrong row whenever there was history, and no
 * fake could see it. The real engine is measured in `search-highlight.wasm.test.ts`; this file
 * keeps the adapter's half, including the search highlight's hand-off to the engine.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    createRendererFromLoader,
    type EngineHandle,
    type TerminalMatchLocation,
    type TerminalSearchHighlight,
    type TerminalSearchSpan,
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

describe('setSearchHighlight on the adapter (#306)', () => {
    const NEEDLE = { needle: 'MARKER', caseSensitive: false };
    const match = { linesFromBottom: 42, col: 7, length: 6 };
    const highlight = (seq: number | null): TerminalSearchHighlight => ({
        ...NEEDLE,
        current: seq === null ? null : { ...match, seq }
    });

    it('hands the engine the needle and pins the current match; null clears both', async () => {
        const setSearchHighlight = vi.fn();
        const setSearchCurrent = vi.fn(() => true);
        const renderer = await liveRenderer({ setSearchHighlight, setSearchCurrent });
        renderer.setSearchHighlight(highlight(1));
        expect(setSearchHighlight).toHaveBeenLastCalledWith(NEEDLE);
        expect(setSearchCurrent).toHaveBeenLastCalledWith(match);
        renderer.setSearchHighlight(null);
        expect(setSearchHighlight).toHaveBeenLastCalledWith(null);
        expect(setSearchCurrent).toHaveBeenLastCalledWith(null);
    });

    it('pins a reply once, and never an older one handed back', async () => {
        const setSearchCurrent = vi.fn(() => true);
        const renderer = await liveRenderer({ setSearchHighlight: vi.fn(), setSearchCurrent });
        renderer.setSearchHighlight(highlight(3));
        // The same reply again (any re-render): its bottom-relative row has moved since.
        renderer.setSearchHighlight(highlight(3));
        // Another window stepped away (no current here) and back to the reply this one had.
        renderer.setSearchHighlight(highlight(null));
        renderer.setSearchHighlight(highlight(3));
        renderer.setSearchHighlight(highlight(2));
        expect(setSearchCurrent.mock.calls).toEqual([[match], [null]]);
        renderer.setSearchHighlight(highlight(4));
        expect(setSearchCurrent).toHaveBeenLastCalledWith(match);
    });

    it('holds the pin while a replay is parsed, and retries one the engine refused once it is', async () => {
        // The engine refuses the first pin: the needle is not there yet (half a screen).
        const setSearchCurrent = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
        const renderer = await liveRenderer({ setSearchHighlight: vi.fn(), setSearchCurrent });
        renderer.reset(10);
        renderer.setSearchHighlight(highlight(1));
        renderer.write('12345');
        expect(setSearchCurrent).not.toHaveBeenCalled();
        renderer.write('67890');
        expect(setSearchCurrent).toHaveBeenCalledTimes(1);
        // The next replay brings the rest of the buffer; the refused reply is tried again.
        renderer.reset(3);
        renderer.write('abc');
        expect(setSearchCurrent).toHaveBeenCalledTimes(2);
        // Pinned now: later replays leave it to the engine, which follows its row.
        renderer.reset(3);
        renderer.write('def');
        expect(setSearchCurrent).toHaveBeenCalledTimes(2);
    });

    it('holds a highlight set before the engine is up and hands it over at open', async () => {
        const setSearchHighlight = vi.fn();
        const setSearchCurrent = vi.fn(() => true);
        const terminal = new StubTerminal();
        const renderer = createRendererFromLoader('xterm', async () =>
            Promise.resolve({ terminal, setSearchHighlight, setSearchCurrent } as EngineHandle)
        );
        renderer.setSearchHighlight(highlight(1));
        expect(setSearchHighlight).not.toHaveBeenCalled();
        await renderer.open(host());
        // A pane that mounts (or is rebuilt) mid-search comes up highlighted.
        expect(setSearchHighlight).toHaveBeenCalledWith(NEEDLE);
        expect(setSearchCurrent).toHaveBeenCalledWith(match);
    });

    it('relays what the engine painted, and stops when unsubscribed', async () => {
        let emit: ((spans: readonly TerminalSearchSpan[]) => void) | null = null;
        const renderer = await liveRenderer({
            onSearchHighlightChange: (listener) => {
                emit = listener;
                return { dispose: () => { emit = null; } };
            }
        });
        const seen: (readonly TerminalSearchSpan[])[] = [];
        const off = renderer.onSearchHighlightChange((spans) => seen.push(spans));
        const spans = [{ row: 2, startCol: 4, endCol: 9, current: true }];
        emit!(spans);
        off();
        emit!([]);
        expect(seen).toEqual([spans]);
        // Disposing the renderer unhooks the engine.
        renderer.dispose();
        expect(emit).toBeNull();
    });

    it('is a no-op for an engine with no highlight layer, and swallows a throw', async () => {
        const bare = await liveRenderer({});
        expect(() => bare.setSearchHighlight(highlight(1))).not.toThrow();
        const throwing = await liveRenderer({
            setSearchHighlight: () => {
                throw new Error('engine said no');
            },
            setSearchCurrent: () => {
                throw new Error('engine said no');
            }
        });
        throwing.setSearchHighlight(highlight(1));
        expect(throwing.failed).toBe(false);
    });

    it('does nothing after dispose, and never troubles an engine that had no search', async () => {
        const setSearchHighlight = vi.fn();
        const renderer = await liveRenderer({ setSearchHighlight });
        expect(setSearchHighlight).not.toHaveBeenCalled();
        renderer.dispose();
        renderer.setSearchHighlight(highlight(1));
        expect(setSearchHighlight).not.toHaveBeenCalled();
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

    it('ghostty-web: lines scrolled up from the bottom, which centres the match row', () => {
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

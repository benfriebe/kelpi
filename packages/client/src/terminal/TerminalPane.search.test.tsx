/**
 * #306: the pane's half of the terminal search highlight.
 *
 * The engine's half (finding and painting the matches) is measured against the real engine in
 * `search-highlight.wasm.test.ts`. What is asserted here is the hand-off between them: the pane
 * passes the engine the needle, the case flag and the current match, and only when one of those
 * actually changes; it clears everything when the search goes away; and it publishes what the
 * engine painted on its root, where the audit can read it.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalPane } from './TerminalPane';
import type { TerminalSearchHighlight } from './renderer';
import { createFakePtyApi, createFakeRendererFactory, installFakeResizeObserver } from './testing';

function box(width: number, height: number): (element: HTMLElement) => { width: number; height: number } {
    return () => ({ width, height });
}

let observers: ReturnType<typeof installFakeResizeObserver>;

beforeEach(() => {
    observers = installFakeResizeObserver();
});

afterEach(() => {
    cleanup();
    observers.restore();
    vi.restoreAllMocks();
});

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

function harness(search: TerminalSearchHighlight | null) {
    const renderers = createFakeRendererFactory();
    const pty = createFakePtyApi();
    const pane = (value: TerminalSearchHighlight | null) => (
        <TerminalPane
            paneID="pane-306"
            ptyApi={pty}
            focused
            visible
            createRenderer={renderers.factory}
            measure={box(800, 480)}
            search={value}
        />
    );
    const view = render(pane(search));
    const root = (): HTMLElement => view.container.querySelector<HTMLElement>('[data-pane-id="pane-306"]')!;
    return { renderers, root, rerender: (value: TerminalSearchHighlight | null) => view.rerender(pane(value)) };
}

const NEEDLE: TerminalSearchHighlight = { needle: 'MARKER', caseSensitive: false, current: null };

describe('TerminalPane search highlight (#306)', () => {
    it('hands the engine the needle, then the current match, and clears when the search goes', async () => {
        const h = harness(NEEDLE);
        await settle();
        const engine = h.renderers.last();
        expect(engine.searchHighlights.at(-1)).toEqual(NEEDLE);

        const current = { linesFromBottom: 60, col: 6, length: 6, seq: 1 };
        h.rerender({ ...NEEDLE, current });
        await settle();
        expect(engine.searchHighlights.at(-1)).toEqual({ ...NEEDLE, current });

        // The same search in a NEW object (every App render builds one) hands over nothing: a
        // repeat would ask the engine to re-pin a match against a buffer output has grown since.
        const calls = engine.searchHighlights.length;
        h.rerender({ ...NEEDLE, current: { ...current } });
        await settle();
        expect(engine.searchHighlights).toHaveLength(calls);

        // Case sensitivity is part of the search, so it is handed over too.
        h.rerender({ ...NEEDLE, caseSensitive: true, current: null });
        await settle();
        expect(engine.searchHighlights.at(-1)).toEqual({ ...NEEDLE, caseSensitive: true, current: null });

        h.rerender(null);
        await settle();
        expect(engine.searchHighlights.at(-1)).toBeNull();
    });

    it('treats an empty needle as no search', async () => {
        const h = harness({ ...NEEDLE, needle: '' });
        await settle();
        expect(h.renderers.last().searchHighlights.at(-1)).toBeNull();
    });

    it('publishes what the engine painted on the pane root', async () => {
        const h = harness(NEEDLE);
        await settle();
        expect(h.root().getAttribute('data-terminal-search-matches')).toBe('0');
        expect(h.root().getAttribute('data-terminal-search-current')).toBe('');

        act(() => {
            h.renderers.last().emitSearchHighlights([
                { row: 1, startCol: 3, endCol: 8, current: false },
                { row: 5, startCol: 19, endCol: 19, current: true },
                { row: 6, startCol: 0, endCol: 4, current: true }
            ]);
        });
        expect(h.root().getAttribute('data-terminal-search-matches')).toBe('3');
        // The current match's FIRST span: it starts at the end of row 5 and wraps onto row 6.
        expect(h.root().getAttribute('data-terminal-search-current')).toBe('5:19-19');

        act(() => {
            h.renderers.last().emitSearchHighlights([]);
        });
        expect(h.root().getAttribute('data-terminal-search-matches')).toBe('0');
        expect(h.root().getAttribute('data-terminal-search-current')).toBe('');
    });
});

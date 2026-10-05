/**
 * The poster across a remount (`terminal/poster.ts`): a pane that comes back shows the frame it
 * left with until its new engine has the whole screen, instead of its bare fill.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TERMINAL_POSTER_MAX_MS, TERMINAL_START_ATTEMPTS, TERMINAL_START_RETRY_MS, TerminalPane } from './TerminalPane';
import { hasTerminalPoster, resetTerminalPostersForTests } from './poster';
import { createFakePtyApi, createFakeRendererFactory, installFakeResizeObserver, type FakeRendererOptions } from './testing';

let observers: ReturnType<typeof installFakeResizeObserver>;

beforeEach(() => {
    vi.useFakeTimers();
    observers = installFakeResizeObserver();
    // jsdom has no 2D context; the poster's copy only needs one to draw into.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => ({ drawImage: () => undefined }) as unknown as CanvasRenderingContext2D
    );
});

afterEach(() => {
    cleanup();
    observers.restore();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetTerminalPostersForTests();
});

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

/** Long enough for the poster's two-frame wait, short of every other timer in the pane. */
async function frames(): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
    });
}

const CANVAS = { width: 400, height: 300 };

function mount(fake: FakeRendererOptions = {}) {
    const renderers = createFakeRendererFactory({ canvas: CANVAS, replayApplied: true, ...fake });
    const pty = createFakePtyApi();
    const view = render(
        <TerminalPane
            paneID="pane-1"
            ptyApi={pty}
            focused={false}
            visible
            createRenderer={renderers.factory}
            measure={() => ({ width: 800, height: 480 })}
        />
    );
    const root = (): HTMLElement => view.container.querySelector<HTMLElement>('[data-pane-id="pane-1"]')!;
    const host = (): HTMLElement => root().querySelector<HTMLElement>('[data-terminal-host]')!;
    /** The poster's canvas: any canvas in the root that is not inside the engine's host. */
    const poster = (): HTMLCanvasElement | null =>
        [...root().querySelectorAll('canvas')].find((canvas) => !host().contains(canvas)) ?? null;
    return { renderers, pty, view, root, host, poster };
}

/** Mount, let the engine come up with a whole screen, and unmount: the poster it leaves. */
async function leaveAPoster(): Promise<void> {
    const first = mount();
    await settle();
    first.pty.last().replay('$ ls\r\n');
    first.view.unmount();
    expect(hasTerminalPoster('pane-1')).toBe(true);
}

describe('TerminalPane poster', () => {
    it('shows the frame a remounted pane left with until its new engine has drawn the replay', async () => {
        await leaveAPoster();

        const pane = mount();
        // In the mounting commit itself, before any engine exists: that is the frame that was blank.
        expect(pane.root().getAttribute('data-terminal-poster')).toBe('shown');
        expect(pane.poster()?.style.width).toBe(`${String(CANVAS.width)}px`);
        expect(pane.host().style.opacity).toBe('0');
        expect(hasTerminalPoster('pane-1')).toBe(false);

        // The engine opening is not enough: its replay is a round trip behind it.
        await settle();
        expect(pane.root().getAttribute('data-terminal-status')).toBe('live');
        await frames();
        expect(pane.poster()).not.toBeNull();

        pane.pty.last().replay('$ ls\r\n');
        // Parsed but not yet drawn: the engine paints on its next frame.
        expect(pane.poster()).not.toBeNull();
        await frames();
        expect(pane.poster()).toBeNull();
        expect(pane.root().hasAttribute('data-terminal-poster')).toBe(false);
        expect(pane.host().style.opacity).toBe('');
    });

    it('keeps the poster it had when it is switched away from before its replay landed', async () => {
        await leaveAPoster();
        const pane = mount();
        await settle();
        const shown = pane.poster();
        pane.view.unmount();

        expect(hasTerminalPoster('pane-1')).toBe(true);
        const again = mount();
        expect(again.poster()).toBe(shown);
    });

    it('takes no poster from an engine that never had a whole screen', async () => {
        const pane = mount();
        await settle();
        pane.view.unmount();
        expect(hasTerminalPoster('pane-1')).toBe(false);
    });

    it('gives up on the poster when no replay comes', async () => {
        await leaveAPoster();
        const pane = mount();
        await settle();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(TERMINAL_POSTER_MAX_MS);
        });
        expect(pane.poster()).toBeNull();
        expect(pane.host().style.opacity).toBe('');
    });

    it('takes the poster down once the engine opens when the renderer cannot say when its replay landed', async () => {
        // Left by a renderer that has the signal; the pane comes back on one without it.
        await leaveAPoster();
        const pane = mount({ replayApplied: false });
        expect(pane.poster()).not.toBeNull();
        await settle();
        await frames();
        expect(pane.poster()).toBeNull();
    });

    it('steps aside for the placeholder when the engine cannot start, and keeps the poster for next time', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await leaveAPoster();
        const pane = mount({ failOpen: true });
        expect(pane.poster()).not.toBeNull();
        await settle();
        for (let index = 1; index < TERMINAL_START_ATTEMPTS; index += 1) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(TERMINAL_START_RETRY_MS * 2 ** TERMINAL_START_ATTEMPTS);
            });
        }
        expect(pane.root().getAttribute('data-terminal-status')).toBe('error');
        expect(pane.poster()).toBeNull();
        expect(hasTerminalPoster('pane-1')).toBe(true);
    });
});

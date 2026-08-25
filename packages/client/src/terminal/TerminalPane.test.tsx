import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_RESIZE_DEBOUNCE_MS,
    RESIZE_MAX_WAIT_MS,
    TERMINAL_EDGE_PADDING,
    TERMINAL_START_ATTEMPTS,
    TERMINAL_START_RETRY_MS,
    TerminalPane,
    measureGeometry,
    shouldGrabFocus
} from './TerminalPane';
import {
    createFakePtyApi,
    createFakeRendererFactory,
    installFakeResizeObserver,
    type FakePaneStream
} from './testing';

/**
 * jsdom has no canvas, so no engine can `open()` here (verified: ghostty-web throws
 * "Failed to get 2D rendering context"; docs/research/ghostty-web-spike.md). Every component
 * test therefore injects the fake renderer behind the adapter interface — the seam exists for
 * exactly this reason.
 */

/** jsdom reports 0×0 for everything; the pane takes its box through this seam. */
function box(width: number, height: number): (element: HTMLElement) => { width: number; height: number } {
    return () => ({ width, height });
}

let observers: ReturnType<typeof installFakeResizeObserver>;

beforeEach(() => {
    vi.useFakeTimers();
    observers = installFakeResizeObserver();
});

afterEach(() => {
    cleanup();
    observers.restore();
    vi.useRealTimers();
    // Console spies are per-test: several of the retry cases assert exact call counts, and a
    // spy left installed by an earlier test would carry its calls into the next one.
    vi.restoreAllMocks();
});

/** Flush the renderer's `open()` promise continuation (a real microtask, not a timer). */
async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

/** Run one retry backoff to completion, then let the new engine's `open()` settle (run-F N1). */
async function runBackoff(): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(TERMINAL_START_RETRY_MS * 2 ** TERMINAL_START_ATTEMPTS);
        await Promise.resolve();
        await Promise.resolve();
    });
}

/** Burn the whole start budget: every attempt fails and the pane lands on the placeholder. */
async function exhaustStartAttempts(): Promise<void> {
    await settle();
    for (let index = 1; index < TERMINAL_START_ATTEMPTS; index += 1) await runBackoff();
}

describe('TerminalPane — replay before live', () => {
    it('paints the daemon replay snapshot first, then live bytes', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();

        const stream = pty.last();
        stream.replay('SNAPSHOT');
        stream.output('live-1');
        stream.output('live-2');

        expect(renderers.last().writes).toEqual(['SNAPSHOT', 'live-1', 'live-2']);
    });

    it('holds output that races ahead of the replay', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();

        const stream = pty.last();
        stream.output('early');
        expect(renderers.last().writes).toEqual([]);

        stream.replay('SNAPSHOT');
        expect(renderers.last().writes).toEqual(['SNAPSHOT', 'early']);
    });

    it('resets before the re-seeded replay a resync announces', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();

        const stream = pty.last();
        stream.replay('FIRST');
        stream.output('output');
        stream.resync('flow-control');
        stream.replay('SECOND');

        const renderer = renderers.last();
        // One per replay: the re-seed supersedes a live screen, and the first one cannot
        // assume the engine it was handed is blank (see `ingest.ts`).
        expect(renderer.resets).toBe(2);
        expect(renderer.writes).toEqual(['FIRST', 'output', 'SECOND']);
    });

    it('queues replay bytes written before the engine finished loading', async () => {
        const renderers = createFakeRendererFactory({ deferOpen: true });
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );

        // The adapter owns the queue; the pane must not gate the stream on `open()`.
        const stream = pty.last();
        stream.replay('SNAPSHOT');
        stream.output('live');
        renderers.last().settleOpen();
        await settle();

        expect(renderers.last().writes).toEqual(['SNAPSHOT', 'live']);
    });
});

describe('TerminalPane — mount ordering', () => {
    /**
     * The reattach-duplication bug in one assertion.
     *
     * The engines take their grid at construction and default to 80×24. If the pane attaches
     * at its measured 120 columns but leaves the engine at 80, the daemon's replay —
     * serialized for 120 columns — is PARSED at 80, wraps, and is then reflowed by the first
     * resize: the stacked half-width prompt copies a re-attach used to paint. The engine must
     * therefore hold the measured grid before a single replay byte reaches it.
     */
    it('sizes the engine to the measured grid before the stream can replay', async () => {
        const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(1200, 480)}
            />
        );

        const renderer = renderers.last();
        // Sized at mount, synchronously — before `subscribe`, therefore before any replay.
        expect(renderer.cols).toBe(120);
        expect(renderer.rows).toBe(24);
        expect(pty.streams.length).toBe(1);
        expect(pty.last().subscription.cols).toBe(120);

        await settle();
        pty.last().replay('SNAPSHOT');
        expect(renderer.writes).toEqual(['SNAPSHOT']);
        // Nothing re-wrapped the replay afterwards.
        expect(renderer.resizes.filter((size) => size.cols !== 120)).toEqual([]);
    });

    it('attaches at the same grid it hands the engine', async () => {
        const renderers = createFakeRendererFactory({ cell: { width: 8, height: 17 } });
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(1354, 810)}
            />
        );
        await settle();

        const renderer = renderers.last();
        const subscription = pty.last().subscription;
        // One grid, three places: the engine, the attach, and therefore the daemon's snapshot.
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({
            cols: subscription.cols,
            rows: subscription.rows
        });
        expect(subscription.cols).toBe(169);
        expect(subscription.rows).toBe(47);
    });
});

describe('TerminalPane — resize', () => {
    it('attaches with the measured geometry', async () => {
        const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();

        expect(pty.last().subscription.cols).toBe(80);
        expect(pty.last().subscription.rows).toBe(24);
    });

    it('publishes live geometry while a resize gesture keeps going', async () => {
        // run-B L5: a divider drag fires a ResizeObserver callback per frame, and a pure
        // trailing debounce pushed its timer out on every one — so the engine, the PTY and the
        // grid's `cols × rows` overlay all kept the PRE-DRAG numbers until the mouse stopped.
        // The debounce now has a ceiling, so a gesture longer than it republishes as it runs.
        const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
        const pty = createFakePtyApi();
        const dimensions: { cols: number; rows: number }[] = [];
        let width = 800;

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={() => ({ width, height: 480 })}
                onDimensionsChange={(_, geometry) => dimensions.push(geometry)}
            />
        );
        await settle();
        act(() => vi.advanceTimersByTime(RESIZE_MAX_WAIT_MS)); // mount-time size sync
        const stream = pty.last();
        const before = stream.resizes.length;
        dimensions.length = 0;

        // 20 frames, 25 ms apart: a 500 ms drag that never pauses long enough to settle.
        for (let frame = 1; frame <= 20; frame++) {
            width = 800 - frame * 10;
            act(() => observers.trigger());
            act(() => vi.advanceTimersByTime(25));
        }

        expect(dimensions.length).toBeGreaterThan(1);
        expect(stream.resizes.length).toBeGreaterThan(before);
        // …and what it publishes is the CURRENT size, not the one the gesture started from.
        expect(dimensions.at(-1)).toEqual({ cols: 60, rows: 24 });
    });

    it('debounces a resize storm into one cols/rows update', async () => {
        const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
        const pty = createFakePtyApi();
        const dimensions: { cols: number; rows: number }[] = [];
        let width = 800;

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={() => ({ width, height: 480 })}
                onDimensionsChange={(_, geometry) => dimensions.push(geometry)}
            />
        );
        await settle();
        act(() => vi.advanceTimersByTime(DEFAULT_RESIZE_DEBOUNCE_MS)); // mount-time size sync

        const stream = pty.last();
        const before = stream.resizes.length;

        // Four frames inside one ceiling window (4 × 20 ms < RESIZE_MAX_WAIT_MS): a burst,
        // not a gesture, so nothing is published until it settles.
        for (const next of [790, 700, 640, 600]) {
            width = next;
            act(() => observers.trigger());
            act(() => vi.advanceTimersByTime(20));
        }
        expect(stream.resizes.length).toBe(before); // still coalescing

        act(() => vi.advanceTimersByTime(DEFAULT_RESIZE_DEBOUNCE_MS));

        expect(stream.resizes.slice(before)).toEqual([{ cols: 60, rows: 24 }]);
        expect(renderers.last().resizes.at(-1)).toEqual({ cols: 60, rows: 24 });
        expect(dimensions.at(-1)).toEqual({ cols: 60, rows: 24 });
    });

    it('never sends a zero-size measurement to the daemon', async () => {
        const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
        const pty = createFakePtyApi();
        let width = 800;

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={() => ({ width, height: 480 })}
            />
        );
        await settle();

        const stream = pty.last();
        const before = stream.resizes.length;
        width = 0; // transient re-parenting pass
        act(() => observers.trigger());
        act(() => vi.advanceTimersByTime(DEFAULT_RESIZE_DEBOUNCE_MS * 2));

        expect(stream.resizes.length).toBe(before);
    });

    it('stays idle while hidden and re-measures when it becomes visible again', async () => {
        const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
        const pty = createFakePtyApi();
        let width = 800;

        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={() => ({ width, height: 480 })}
            />
        );
        await settle();

        const stream = pty.last();
        const renderer = renderers.last();
        const before = stream.resizes.length;
        const repaintsBefore = renderer.repaints;

        view.rerender(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible={false}
                createRenderer={renderers.factory}
                measure={() => ({ width, height: 480 })}
            />
        );
        width = 400; // the grid re-laid out while this pane was off screen
        act(() => observers.trigger());
        act(() => vi.advanceTimersByTime(DEFAULT_RESIZE_DEBOUNCE_MS * 2));

        // Hidden: no measuring, no resize traffic — and the renderer is still alive.
        expect(stream.resizes.length).toBe(before);
        expect(renderer.disposed).toBe(false);
        expect(stream.unsubscribed).toBe(false);

        view.rerender(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={() => ({ width, height: 480 })}
            />
        );
        act(() => vi.advanceTimersByTime(1));

        expect(stream.resizes.at(-1)).toEqual({ cols: 40, rows: 24 });
        expect(renderer.repaints).toBeGreaterThan(repaintsBefore);
    });
});

describe('TerminalPane — input and focus', () => {
    it('forwards engine output upstream as pane input', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();

        renderers.last().emitData('ls -la\r');
        renderers.last().emitData('');

        expect(pty.last().input).toEqual(['ls -la\r', '']);
    });

    it('focuses the engine when focused, blurs it when not, and asks for focus on click', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();
        const requested: string[] = [];

        const props = {
            paneID: 'pane-1',
            ptyApi: pty,
            visible: true,
            createRenderer: renderers.factory,
            measure: box(800, 480),
            onFocusRequest: (id: string) => requested.push(id)
        };

        const view = render(<TerminalPane {...props} focused={false} />);
        await settle();
        const renderer = renderers.last();
        expect(renderer.focusCount).toBe(0);

        view.rerender(<TerminalPane {...props} focused />);
        expect(renderer.focusCount).toBe(1);

        view.rerender(<TerminalPane {...props} focused={false} />);
        expect(renderer.blurCount).toBeGreaterThan(0);

        fireEvent.mouseDown(view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement);
        expect(requested).toEqual(['pane-1']);
    });

    /**
     * N15 — the caret comes back when the WINDOW does.
     *
     * A window rebuilt after a close (the Dock reopen) renders a live grid with nothing holding
     * the caret, and the focus effect cannot help: none of `focused`, `visible` or the engine's
     * status changes when the OS hands the window back, so the pane stays keyboard-dead — and
     * clicking it does not help either, because it is already the focused pane and nothing
     * re-renders. The window's own `focus` event is the signal that does arrive.
     */
    it('re-grabs the caret when the window takes focus (N15)', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();
        const renderer = renderers.last();
        const before = renderer.focusCount;

        fireEvent.focus(window);

        expect(renderer.focusCount).toBe(before + 1);
    });

    it('leaves the caret alone on window focus when a chrome field holds it', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();
        const renderer = renderers.last();
        const before = renderer.focusCount;

        // A sidebar rename or the palette field, mid-type when the window came back.
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        fireEvent.focus(window);
        expect(renderer.focusCount).toBe(before);

        input.remove();
    });

    it('does not re-grab the caret for a pane that is not the focused one', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();

        fireEvent.focus(window);

        expect(renderers.last().focusCount).toBe(0);
    });

    /**
     * §N20 — the CURSOR's focus, which is a different question from the caret's.
     *
     * libghostty draws a focused surface's cursor as the terminal asked for it (blinking, if it
     * asked) and every other surface's as a steady hollow block, and `ghostty_surface_set_focus`
     * is the only input to that decision. The port had no equivalent call at all, so every pane
     * on screen blinked a filled block — the owner's report.
     */
    it('tells the engine which surface is focused, and follows the pane (§N20)', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();
        const props = {
            paneID: 'pane-1',
            ptyApi: pty,
            visible: true,
            createRenderer: renderers.factory,
            measure: box(800, 480)
        };

        const view = render(<TerminalPane {...props} focused={false} />);
        await settle();
        const renderer = renderers.last();
        expect(renderer.surfaceFocuses.at(-1)).toBe(false);
        expect(view.container.querySelector('[data-pane-id="pane-1"]')?.getAttribute('data-terminal-cursor-focus')).toBe('false');

        view.rerender(<TerminalPane {...props} focused />);
        expect(renderer.surfaceFocuses.at(-1)).toBe(true);
        expect(view.container.querySelector('[data-pane-id="pane-1"]')?.getAttribute('data-terminal-cursor-focus')).toBe('true');

        // A pane parked off-screen (another workspace) is nobody's focused surface.
        view.rerender(<TerminalPane {...props} focused visible={false} />);
        expect(renderer.surfaceFocuses.at(-1)).toBe(false);
    });

    /**
     * §N20 — and the WINDOW is half the answer.
     *
     * AppKit does not resign a view's first-responder status when its window stops being key,
     * so ghostty computes surface focus as `window.isKeyWindow && … && isFirstResponder`
     * (`BaseTerminalController.syncFocusToSurfaceTree`): a Nex window in the background has no
     * blinking cursor anywhere in it. Nothing about `focused`, `visible` or the engine's status
     * changes when the OS takes the window away, so the window's own event is the only signal.
     */
    it('unfocuses the cursor when the WINDOW loses focus, and restores it (§N20)', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();
        const renderer = renderers.last();
        expect(renderer.surfaceFocuses.at(-1)).toBe(true);

        fireEvent.blur(window);
        expect(renderer.surfaceFocuses.at(-1)).toBe(false);

        fireEvent.focus(window);
        expect(renderer.surfaceFocuses.at(-1)).toBe(true);
    });

    it('reports process exit, bell and title to the host', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();
        const exits: (number | null)[] = [];
        const bells: string[] = [];
        const titles: string[] = [];

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
                onExit={(_, code) => exits.push(code)}
                onBell={(id) => bells.push(id)}
                onTitleChange={(_, title) => titles.push(title)}
            />
        );
        await settle();

        pty.last().exit(0, undefined);
        renderers.last().emitBell();
        renderers.last().emitTitle('~/src — zsh');

        expect(exits).toEqual([0]);
        expect(bells).toEqual(['pane-1']);
        expect(titles).toEqual(['~/src — zsh']);
    });

    it('surfaces an engine that cannot start, and detaches rather than feeding a dead pane', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const renderers = createFakeRendererFactory({ failOpen: true });
        const pty = createFakePtyApi();

        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await exhaustStartAttempts();

        const host = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
        expect(host.dataset['terminalStatus']).toBe('error');
        // Detach, not kill: `unsubscribe` sends `detach-pane`, exactly as a mount-policy
        // eviction does, so the PTY and its scrollback stay alive daemon-side and Retry
        // re-attaches to the same session. Before the retry work this pane stayed attached
        // forever with nothing to paint into.
        expect(pty.last().unsubscribed).toBe(true);
        expect(pty.streams).toHaveLength(TERMINAL_START_ATTEMPTS);
    });
});

/**
 * run-F N1 — "terminal renderer failed to start", and the pane never recovering.
 *
 * ghostty-web 0.4 shares one WASM instance across every terminal in the tab, so a pane that
 * starts while another engine is still instantiating can have its first write land outside the
 * heap it was measured against (`RangeError: offset is out of bounds`, thrown from inside
 * `Uint8Array.set`). Two occurrences in four full audit runs — and one rejected `open()` was
 * terminal: the placeholder stayed until the pane was closed.
 *
 * The failure is a race, so the same pane on a FRESH engine comes straight up. These tests are
 * that claim, with the failure injected instead of waited for.
 */
describe('TerminalPane — renderer start retry (run-F N1)', () => {
    it('rebuilds on a fresh engine when the first start fails, and never shows the placeholder', async () => {
        const renderers = createFakeRendererFactory({ failOpensBefore: 1 });
        const pty = createFakePtyApi();

        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();

        const host = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
        // Not 'error': the pane is between engines, which is a hiccup, not a dead pane.
        expect(host.dataset['terminalStatus']).toBe('loading');

        await runBackoff();

        expect(renderers.instances).toHaveLength(2);
        expect(renderers.instances[0]?.disposed).toBe(true);
        expect(host.dataset['terminalStatus']).toBe('live');
        expect(host.dataset['terminalAttempts']).toBe('2');
        // A fresh engine means a fresh attach: the daemon replays the screen onto it.
        expect(pty.streams).toHaveLength(2);
        expect(pty.streams[0]?.unsubscribed).toBe(true);
        expect(pty.last().unsubscribed).toBe(false);
    });

    it('keeps the console clean when it recovers — a retried start is not a renderer error', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const renderers = createFakeRendererFactory({ failOpensBefore: 1 });
        const pty = createFakePtyApi();

        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();
        await runBackoff();

        // The audit's closing step counts every renderer console error AND warning; a pane that
        // healed itself must not read as a defect there.
        expect(error).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledTimes(1);
        error.mockRestore();
        info.mockRestore();
    });

    it('gives up after the attempt budget and says why, once', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const renderers = createFakeRendererFactory({ failOpensBefore: 99 });
        const pty = createFakePtyApi();

        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await exhaustStartAttempts();

        const host = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
        expect(renderers.instances).toHaveLength(TERMINAL_START_ATTEMPTS);
        expect(host.dataset['terminalStatus']).toBe('error');
        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0]?.[0])).toContain('pane-1');
        error.mockRestore();
    });

    it('offers a Retry button on the placeholder that starts over on a fresh engine', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        // Mutable on purpose: the injected fault is cleared before the human retries, which is
        // what a real transient race looks like.
        const fake: { failOpensBefore: number } = { failOpensBefore: 99 };
        const renderers = createFakeRendererFactory(fake);
        const pty = createFakePtyApi();

        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await exhaustStartAttempts();

        const host = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
        expect(host.dataset['terminalStatus']).toBe('error');

        const retry = view.container.querySelector('[data-testid="terminal-retry-pane-1"]');
        expect(retry).not.toBeNull();

        fake.failOpensBefore = 0;
        await act(async () => {
            fireEvent.click(retry as HTMLElement);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(renderers.instances).toHaveLength(TERMINAL_START_ATTEMPTS + 1);
        expect(host.dataset['terminalStatus']).toBe('live');
        // The budget starts over, so a person can keep asking.
        expect(host.dataset['terminalAttempts']).toBe('1');
    });

    it('rebuilds when a LIVE engine dies, and seals the stream off the dead one', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();

        const first = renderers.last();
        pty.last().replay('SNAPSHOT');
        expect(first.writes).toEqual(['SNAPSHOT']);

        // ghostty-web threw `RangeError: offset is out of bounds` from inside `write()`.
        await act(async () => {
            first.poison();
            await Promise.resolve();
        });

        // Bytes that arrive between the throw and the teardown must not reach the dead engine.
        pty.streams[0]?.output('after-the-throw');
        expect(first.writes).toEqual(['SNAPSHOT']);

        await runBackoff();

        expect(renderers.instances).toHaveLength(2);
        expect(first.disposed).toBe(true);
        const host = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
        expect(host.dataset['terminalStatus']).toBe('live');
        info.mockRestore();
    });

    it('does not restart a pane that is being unmounted', async () => {
        const renderers = createFakeRendererFactory({ failOpensBefore: 99 });
        const pty = createFakePtyApi();

        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();
        view.unmount();
        await runBackoff();

        expect(renderers.instances).toHaveLength(1);
        expect(renderers.instances[0]?.disposed).toBe(true);
        expect(pty.last().unsubscribed).toBe(true);
    });
});

describe('TerminalPane — eviction and re-attach', () => {
    it('disposes the engine and detaches on unmount, and re-subscribes on re-mount', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();

        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();
        pty.last().replay('SNAPSHOT');

        // Mount-policy eviction: the pane leaves the tree entirely.
        view.unmount();

        expect(renderers.last().disposed).toBe(true);
        expect(pty.last().unsubscribed).toBe(true);
        expect(pty.streams).toHaveLength(1);

        // Re-mounting re-attaches; the daemon replays the server-side snapshot into the new
        // engine, which is what makes eviction cheap.
        render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
            />
        );
        await settle();

        expect(pty.streams).toHaveLength(2);
        expect(renderers.instances).toHaveLength(2);

        pty.last().replay('SNAPSHOT AGAIN');
        expect(renderers.last().writes).toEqual(['SNAPSHOT AGAIN']);
        // The re-mounted engine is reset before the snapshot lands on it: "fresh" is not
        // something a client can verify (ghostty-web shares one WASM instance across panes,
        // and a pane mounted where another was just torn down came up wearing its screen).
        expect(renderers.last().resets).toBe(1);
    });

    it('re-subscribes when the pane id changes', async () => {
        const renderers = createFakeRendererFactory();
        const pty = createFakePtyApi();
        const props = {
            ptyApi: pty,
            focused: false,
            visible: true,
            createRenderer: renderers.factory,
            measure: box(800, 480)
        };

        const view = render(<TerminalPane {...props} paneID="pane-1" />);
        await settle();
        view.rerender(<TerminalPane {...props} paneID="pane-2" />);
        await settle();

        expect(pty.streams.map((stream) => stream.paneID)).toEqual(['pane-1', 'pane-2']);
        expect(pty.streams[0]?.unsubscribed).toBe(true);
    });
});

describe('TerminalPane — helpers', () => {
    it('derives cols/rows from the body box and the engine cell metrics', () => {
        const renderer = createFakeRendererFactory({ cell: { width: 8, height: 17 } }).factory();
        const element = document.createElement('div');

        expect(measureGeometry(element, renderer, box(801, 340))).toEqual({ cols: 100, rows: 20 });
        expect(measureGeometry(element, renderer, box(0, 340))).toBeNull();
        expect(measureGeometry(element, renderer, box(4, 4))).toEqual({ cols: 1, rows: 1 });
    });

    /**
     * The audit's residual "column 1 is clipped": the focused pane's 2px ring is an `inset-0`
     * overlay painted over this element, so the pane root has to inset the grid by the same
     * amount — and it has to be the ROOT, because the host's `clientWidth` IS the column
     * arithmetic and padding there would inflate the cols the PTY is told about.
     */
    it('insets the grid from the pane edge so the focus ring cannot clip column 1', async () => {
        const pty = createFakePtyApi();
        const { factory } = createFakeRendererFactory();
        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused
                visible
                createRenderer={factory}
                measure={box(800, 340)}
            />
        );
        await settle();

        const root = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
        const host = root.querySelector('[data-terminal-host]') as HTMLElement;
        expect(root.style.paddingLeft).toBe(`${String(TERMINAL_EDGE_PADDING)}px`);
        expect(root.style.paddingRight).toBe(`${String(TERMINAL_EDGE_PADDING)}px`);
        // The inset belongs to the root, never to the element the geometry is measured from.
        expect(host.style.paddingLeft).toBe('');
    });

    it('never steals the caret from a text field outside the pane', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();

        expect(shouldGrabFocus(document.createElement('div'))).toBe(false);

        input.blur();
        expect(shouldGrabFocus(document.createElement('div'))).toBe(true);
        input.remove();
    });

    /**
     * N19 — losing pane focus has to RELEASE the caret, not just tell the engine.
     *
     * `Terminal.blur()` blurs the container (`vendor/…/terminal.ts:808-812`) while `focus()`
     * focuses the hidden `<textarea>` inside it, so the DOM caret survived `renderer.blur()`
     * and the whole window went on reading as "a text field is focused". The next surface's
     * claim — a scratchpad born from ⇧⌘N — was declined on those grounds. This is the port of
     * the editors' `releaseFirstResponderIfHeld` (`ScratchpadEditorView.swift:113-115`).
     */
    it('releases the DOM caret when the pane loses focus, so the next surface can claim it', async () => {
        const pty = createFakePtyApi();
        const { factory } = createFakeRendererFactory();
        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused
                visible
                createRenderer={factory}
                measure={box(800, 340)}
            />
        );
        await settle();

        // Stand in for the engine's hidden input: the fake renderer has no DOM of its own.
        const host = view.container.querySelector('[data-terminal-host]') as HTMLElement;
        expect(host.hasAttribute('data-pane-surface')).toBe(true);
        const engineInput = document.createElement('textarea');
        host.appendChild(engineInput);
        engineInput.focus();
        expect(document.activeElement).toBe(engineInput);

        view.rerender(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused={false}
                visible
                createRenderer={factory}
                measure={box(800, 340)}
            />
        );
        await settle();

        expect(document.activeElement).not.toBe(engineInput);
        expect(shouldGrabFocus(document.createElement('div'))).toBe(true);
    });
});

// ── mouse reporting (§TERM-037…§TERM-039) ───────────────────────────────────────────
//
// The pane, not the engine, turns pointer events into DEC mouse reports. What is asserted here
// is the wiring the encoder's own unit tests cannot see: that the daemon's `pane-modes` reaches
// the reporter, that the bytes go up the pane's PTY stream, and — the half that mattered most —
// that the ENGINE never sees an event that was reported, so its selection cannot fight the
// application for the same drag.

/** `\e` written out, so the expectations below read like the wire. */
const esc = (rest: string): string => `\u001B${rest}`;

/** Mount a pane with 10×20 cells, plus a stand-in for the engine's own canvas listener. */
async function mouseHarness(
    modes: { mouseTracking?: string; mouseFormat?: string } = {}
): Promise<{
    pty: ReturnType<typeof createFakePtyApi>;
    renderers: ReturnType<typeof createFakeRendererFactory>;
    root: HTMLElement;
    host: HTMLElement;
    engine: HTMLElement;
    engineEvents: string[];
}> {
    const pty = createFakePtyApi();
    const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
    const view = render(
        <TerminalPane
            paneID="pane-1"
            ptyApi={pty}
            focused
            visible
            createRenderer={renderers.factory}
            measure={box(800, 480)}
        />
    );
    await settle();
    const root = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
    const host = root.querySelector('[data-terminal-host]') as HTMLElement;
    // Below the host in the tree, exactly where both engines put their canvas — so an event
    // that reaches it is an event the engine would have acted on.
    const engine = document.createElement('div');
    const engineEvents: string[] = [];
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'wheel']) {
        engine.addEventListener(type, () => engineEvents.push(type));
    }
    host.appendChild(engine);
    if (Object.keys(modes).length > 0) {
        act(() => {
            pty.last().modes(modes as Parameters<FakePaneStream['modes']>[0]);
        });
    }
    return { pty, renderers, root, host, engine, engineEvents };
}

describe('TerminalPane — mouse reporting', () => {
    it('reports a press → drag → release as SGR bytes on the pane stream', async () => {
        const h = await mouseHarness({ mouseTracking: 'drag', mouseFormat: 'sgr' });

        fireEvent.mouseDown(h.engine, { clientX: 45, clientY: 61, button: 0 });
        fireEvent.mouseMove(h.engine, { clientX: 85, clientY: 81, button: 0 });
        fireEvent.mouseUp(h.engine, { clientX: 85, clientY: 81, button: 0 });

        expect(h.pty.last().input).toEqual([esc('[<0;5;4M'), esc('[<32;9;5M'), esc('[<0;9;5m')]);
    });

    it('the engine never sees an event that was reported', async () => {
        const h = await mouseHarness({ mouseTracking: 'drag', mouseFormat: 'sgr' });

        fireEvent.mouseDown(h.engine, { clientX: 45, clientY: 61, button: 0 });
        fireEvent.mouseMove(h.engine, { clientX: 85, clientY: 81, button: 0 });
        fireEvent.mouseUp(h.engine, { clientX: 85, clientY: 81, button: 0 });

        expect(h.engineEvents).toEqual([]);
    });

    it('leaves every event alone while no application asked for the mouse', async () => {
        // The default: a pane with no mouse mode selects text exactly as it always did.
        const h = await mouseHarness();

        fireEvent.mouseDown(h.engine, { clientX: 45, clientY: 61, button: 0 });
        fireEvent.mouseMove(h.engine, { clientX: 85, clientY: 81, button: 0 });
        fireEvent.mouseUp(h.engine, { clientX: 85, clientY: 81, button: 0 });
        fireEvent.wheel(h.engine, { clientX: 45, clientY: 61, deltaX: 0, deltaY: -60 });

        expect(h.pty.last().input).toEqual([]);
        expect(h.engineEvents).toEqual(['mousedown', 'mousemove', 'mouseup', 'wheel']);
        expect(h.root.dataset['terminalMouse']).toBe('none');
    });

    it('shift-click bypasses reporting and reaches the engine for selection', async () => {
        const h = await mouseHarness({ mouseTracking: 'drag', mouseFormat: 'sgr' });

        fireEvent.mouseDown(h.engine, { clientX: 45, clientY: 61, button: 0, shiftKey: true });
        fireEvent.mouseMove(h.engine, { clientX: 85, clientY: 81, button: 0, shiftKey: true });
        fireEvent.mouseUp(h.engine, { clientX: 85, clientY: 81, button: 0, shiftKey: true });

        expect(h.pty.last().input).toEqual([]);
        expect(h.engineEvents).toEqual(['mousedown', 'mousemove', 'mouseup']);
    });

    it('reports the wheel as buttons 64/65 and keeps it off the engine', async () => {
        const h = await mouseHarness({ mouseTracking: 'drag', mouseFormat: 'sgr' });

        fireEvent.wheel(h.engine, { clientX: 45, clientY: 61, deltaX: 0, deltaY: -40 });

        expect(h.pty.last().input).toEqual([esc('[<64;5;4M'), esc('[<64;5;4M')]);
        expect(h.engineEvents).toEqual([]);
    });

    it('publishes the live tracking mode on the pane root', async () => {
        const h = await mouseHarness({ mouseTracking: 'any', mouseFormat: 'sgr' });
        expect(h.root.dataset['terminalMouse']).toBe('any');

        act(() => {
            h.pty.last().modes({ mouseTracking: 'none' });
        });
        expect(h.root.dataset['terminalMouse']).toBe('none');
    });

    it('follows a drag that leaves the pane, and the release outside it', async () => {
        const h = await mouseHarness({ mouseTracking: 'drag', mouseFormat: 'sgr' });
        const outside = document.createElement('div');
        document.body.appendChild(outside);

        fireEvent.mouseDown(h.engine, { clientX: 45, clientY: 61, button: 0 });
        fireEvent.mouseMove(outside, { clientX: 2000, clientY: 61, button: 0 });
        fireEvent.mouseUp(outside, { clientX: 2000, clientY: 61, button: 0 });

        expect(h.pty.last().input).toEqual([esc('[<0;5;4M'), esc('[<32;80;4M'), esc('[<0;80;4m')]);
        outside.remove();
    });

    it('stops reporting when the application turns tracking back off mid-drag', async () => {
        const h = await mouseHarness({ mouseTracking: 'drag', mouseFormat: 'sgr' });

        fireEvent.mouseDown(h.engine, { clientX: 45, clientY: 61, button: 0 });
        act(() => {
            h.pty.last().modes({ mouseTracking: 'none' });
        });
        fireEvent.mouseMove(h.engine, { clientX: 85, clientY: 81, button: 0 });

        expect(h.pty.last().input).toEqual([esc('[<0;5;4M')]);
        expect(h.engineEvents).toEqual(['mousemove']);
    });
});

describe('TerminalPane — selection read (§TERM-034)', () => {
    it('publishes the engine selection length, and hands the text to the host', async () => {
        const pty = createFakePtyApi();
        const renderers = createFakeRendererFactory();
        const seen: string[] = [];
        const view = render(
            <TerminalPane
                paneID="pane-1"
                ptyApi={pty}
                focused
                visible
                createRenderer={renderers.factory}
                measure={box(800, 480)}
                onSelectionChange={(_, selection) => seen.push(selection)}
            />
        );
        await settle();
        const root = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
        expect(root.dataset['terminalSelection']).toBe('0');

        act(() => {
            renderers.last().emitSelection('total 48');
        });

        expect(root.dataset['terminalSelection']).toBe('8');
        expect(seen).toEqual(['total 48']);

        act(() => {
            renderers.last().emitSelection('');
        });
        expect(root.dataset['terminalSelection']).toBe('0');
    });

    it('publishes the cell metrics the audit computes expected report cells with', async () => {
        const h = await mouseHarness({ mouseTracking: 'drag', mouseFormat: 'sgr' });
        expect(h.root.dataset['terminalCell']).toBe('10.00x20.00');
    });

    it('clears a stale selection the moment reporting takes a gesture', async () => {
        // Ghostty clears it too (`Surface.zig:3850-3852`): the highlight would otherwise sit
        // over a TUI that is now handling the same drag itself.
        const h = await mouseHarness({ mouseTracking: 'drag', mouseFormat: 'sgr' });
        act(() => {
            h.renderers.last().emitSelection('left over from before');
        });
        expect(h.root.dataset['terminalSelection']).toBe('21');

        fireEvent.mouseDown(h.engine, { clientX: 45, clientY: 61, button: 0 });
        expect(h.root.dataset['terminalSelection']).toBe('0');
    });

    it('a reported drag leaves the engine with no selection at all', async () => {
        // The §TERM-037 invariant, stated as a pane-level fact rather than as bytes: while an
        // application is being sent mouse reports the engine sees nothing, so it can make no
        // selection — which is exactly what a real terminal does and what the audit asserts on
        // the real engine.
        const h = await mouseHarness({ mouseTracking: 'drag', mouseFormat: 'sgr' });

        fireEvent.mouseDown(h.engine, { clientX: 45, clientY: 61, button: 0 });
        fireEvent.mouseMove(h.engine, { clientX: 85, clientY: 81, button: 0 });
        fireEvent.mouseUp(h.engine, { clientX: 85, clientY: 81, button: 0 });

        expect(h.pty.last().input.length).toBeGreaterThan(0);
        expect(h.root.dataset['terminalSelection']).toBe('0');
    });
});

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_RESIZE_DEBOUNCE_MS,
    TERMINAL_EDGE_PADDING,
    TerminalPane,
    measureGeometry,
    shouldGrabFocus
} from './TerminalPane';
import { createFakePtyApi, createFakeRendererFactory, installFakeResizeObserver } from './testing';

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
});

/** Flush the renderer's `open()` promise continuation (a real microtask, not a timer). */
async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
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
        expect(renderer.resets).toBe(1);
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

        for (const next of [790, 700, 640, 600]) {
            width = next;
            act(() => observers.trigger());
            act(() => vi.advanceTimersByTime(DEFAULT_RESIZE_DEBOUNCE_MS - 10));
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

    it('surfaces an engine that cannot start without tearing the stream down', async () => {
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
        await settle();

        const host = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
        expect(host.dataset['terminalStatus']).toBe('error');
        expect(pty.last().unsubscribed).toBe(false);
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
        expect(renderers.last().resets).toBe(0); // fresh engine: nothing to supersede
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
});

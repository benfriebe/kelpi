import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    dropZoneOverlayRect,
    empty,
    leaf,
    paneFrames,
    split,
    splitDividers,
    updatingSplitRatio,
    type PaneLayout,
    type Rect
} from '@nex/core/layout';

import { PaneGrid, type PaneGridProps } from './PaneGrid';
import { expectedBox, firePointer, stubBoundingRect, styleBox, testPane } from './testing';
import type { DividerRatioCommit } from './divider';
import type { PaneRenderState } from './types';

const SIZE = { width: 800, height: 600 };
const BOUNDS: Rect = { x: 0, y: 0, width: 800, height: 600 };
const HEADER = 24;

/** `a | b` — two panes side by side, divider "d" at x = 399. */
const SIDE_BY_SIDE = split('horizontal', 0.5, leaf('a'), leaf('b'));
/** `a | (b / c)` — the nested fixture the frame test walks. */
const NESTED = split('horizontal', 0.5, leaf('a'), split('vertical', 0.5, leaf('b'), leaf('c')));
/** `(a / b) | (c / d)` — the `tiled` shape whose ROOT divider has no pane to name it. */
const TILED_2X2 = split(
    'horizontal',
    0.5,
    split('vertical', 0.5, leaf('a'), leaf('b')),
    split('vertical', 0.5, leaf('c'), leaf('d'))
);

function renderGrid(overrides: Partial<PaneGridProps> = {}) {
    const props: PaneGridProps = {
        layout: SIDE_BY_SIDE,
        panes: [testPane('a'), testPane('b')],
        size: SIZE,
        headerHeight: HEADER,
        renderPane: (paneID) => <div data-testid={`body-${paneID}`} />,
        ...overrides
    };
    const view = render(<PaneGrid {...props} />);
    const container = screen.getByTestId('pane-grid');
    stubBoundingRect(container, { left: 0, top: 0, ...SIZE });
    return {
        ...view,
        container,
        update: (next: Partial<PaneGridProps>) => view.rerender(<PaneGrid {...props} {...next} />)
    };
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('PaneGrid frames', () => {
    it('positions every pane exactly where paneFrames says', () => {
        renderGrid({ layout: NESTED, panes: [testPane('a'), testPane('b'), testPane('c')] });
        const expectedFrames = paneFrames(NESTED, BOUNDS);
        expect(expectedFrames.size).toBe(3);
        for (const [paneID, rect] of expectedFrames) {
            expect(styleBox(screen.getByTestId(`pane-${paneID}`))).toEqual(expectedBox(rect));
        }
    });

    it('places divider grab strips on the core hit rects', () => {
        renderGrid({ layout: NESTED, panes: [testPane('a'), testPane('b'), testPane('c')] });
        const infos = splitDividers(NESTED, BOUNDS);
        expect(infos.map((info) => info.id)).toEqual(['d', 'dR']);
        for (const info of infos) {
            const element = screen.getByTestId(`divider-${info.id}`);
            expect(styleBox(element)).toEqual(
                expectedBox({
                    x: info.rect.x - 4,
                    y: info.rect.y - 4,
                    width: info.rect.width + 8,
                    height: info.rect.height + 8
                })
            );
            expect(element.getAttribute('data-direction')).toBe(info.direction);
        }
    });

    it('hands renderPane the body rect (frame minus the header)', () => {
        const seen: { paneID: string; frame: Rect; focused: boolean }[] = [];
        renderGrid({
            focusedPaneID: 'b',
            renderPane: (paneID, frame, focused) => {
                seen.push({ paneID, frame, focused });
                return null;
            }
        });
        const frames = paneFrames(SIDE_BY_SIDE, BOUNDS);
        const b = seen.find((entry) => entry.paneID === 'b');
        const rect = frames.get('b');
        expect(rect).toBeDefined();
        expect(b?.frame).toEqual({
            x: rect?.x,
            y: (rect?.y ?? 0) + HEADER,
            width: rect?.width,
            height: (rect?.height ?? 0) - HEADER
        });
        expect(b?.focused).toBe(true);
        expect(seen.find((entry) => entry.paneID === 'a')?.focused).toBe(false);
    });

    it('renders the empty state and raises onCreatePane', () => {
        const onCreatePane = vi.fn();
        renderGrid({ layout: empty(), panes: [], onCreatePane });
        expect(screen.getByTestId('pane-grid-empty')).toBeTruthy();
        act(() => {
            screen.getByTestId('pane-grid-new-pane').click();
        });
        expect(onCreatePane).toHaveBeenCalledTimes(1);
    });
});

describe('PaneGrid identity stability', () => {
    it('keeps the same DOM node for a pane across a split', () => {
        const view = renderGrid({ layout: leaf('a'), panes: [testPane('a')] });
        const node = screen.getByTestId('pane-a');
        const body = screen.getByTestId('body-a');

        view.update({ layout: SIDE_BY_SIDE, panes: [testPane('a'), testPane('b')] });
        expect(screen.getByTestId('pane-a')).toBe(node);
        expect(screen.getByTestId('body-a')).toBe(body);

        // …and across a move that flips the pane to the other side of the split.
        view.update({
            layout: split('vertical', 0.3, leaf('b'), leaf('a')),
            panes: [testPane('a'), testPane('b')]
        });
        expect(screen.getByTestId('pane-a')).toBe(node);
        expect(screen.getByTestId('body-a')).toBe(body);
        expect(styleBox(node)).toEqual(
            expectedBox(paneFrames(split('vertical', 0.3, leaf('b'), leaf('a')), BOUNDS).get('a') as Rect)
        );
    });

    it('renders panes in id order, not layout order, so nodes never reshuffle', () => {
        const view = renderGrid({
            layout: split('horizontal', 0.5, leaf('b'), leaf('a')),
            panes: [testPane('b'), testPane('a')]
        });
        const order = () =>
            [...view.container.querySelectorAll('[data-pane-id]')].map((node) =>
                node.getAttribute('data-pane-id')
            );
        expect(order()).toEqual(['a', 'b']);
        view.update({ layout: SIDE_BY_SIDE, panes: [testPane('a'), testPane('b')] });
        expect(order()).toEqual(['a', 'b']);
    });
});

describe('PaneGrid zoom', () => {
    it('fills the grid with the zoomed pane and hides — never unmounts — the others', () => {
        const view = renderGrid({ zoomedPaneID: 'a' });
        const hiddenBody = screen.getByTestId('body-b');
        const zoomed = screen.getByTestId('pane-a');
        const hidden = screen.getByTestId('pane-b');

        expect(styleBox(zoomed)).toEqual(expectedBox(BOUNDS));
        expect(zoomed.getAttribute('data-zoomed')).toBe('true');
        expect(hidden.getAttribute('data-hidden')).toBe('true');
        expect(hidden.style.visibility).toBe('hidden');
        expect(hidden.style.pointerEvents).toBe('none');
        // Still in the tree: the terminal inside keeps its scrollback and its PTY.
        expect(hiddenBody.isConnected).toBe(true);
        // No dividers while zoomed.
        expect(screen.queryByTestId('divider-d')).toBeNull();

        view.update({ zoomedPaneID: null });
        expect(screen.getByTestId('body-b')).toBe(hiddenBody);
        expect(screen.getByTestId('pane-b').getAttribute('data-hidden')).toBe('false');
        expect(styleBox(screen.getByTestId('pane-b'))).toEqual(
            expectedBox(paneFrames(SIDE_BY_SIDE, BOUNDS).get('b') as Rect)
        );
    });

    it('hides panes the daemon dropped from the layout, keeping their last frame', () => {
        const view = renderGrid();
        const before = styleBox(screen.getByTestId('pane-b'));
        // The daemon collapses the tree to a single leaf while zoomed.
        view.update({ layout: leaf('a'), zoomedPaneID: 'a' });
        const hidden = screen.getByTestId('pane-b');
        expect(hidden.getAttribute('data-hidden')).toBe('true');
        expect(styleBox(hidden)).toEqual(before);
    });

    it('tells renderPane which panes are on screen, so the terminal can idle', () => {
        const states = new Map<string, PaneRenderState>();
        renderGrid({
            zoomedPaneID: 'a',
            renderPane: (paneID, _frame, _focused, state) => {
                states.set(paneID, state);
                return null;
            }
        });
        expect(states.get('a')).toEqual({ visible: true, zoomed: true, dragging: false });
        expect(states.get('b')).toEqual({ visible: false, zoomed: false, dragging: false });
    });

    it('ignores a zoomedPaneID that is not one of this workspace’s panes', () => {
        renderGrid({ zoomedPaneID: 'ghost' });
        expect(styleBox(screen.getByTestId('pane-a'))).toEqual(
            expectedBox(paneFrames(SIDE_BY_SIDE, BOUNDS).get('a') as Rect)
        );
    });
});

describe('PaneGrid divider drag', () => {
    function drag(
        onSetRatio: (path: string, ratio: number, commit: DividerRatioCommit) => void,
        deltas: number[],
        options: Partial<PaneGridProps> = {}
    ) {
        const view = renderGrid({ onSetRatio, ratioCommitIntervalMs: 0, ...options });
        const divider = screen.getByTestId('divider-d');
        act(() => firePointer(divider, 'pointerdown', { clientX: 500, clientY: 300 }));
        for (const delta of deltas) {
            act(() => firePointer(window, 'pointermove', { clientX: 500 + delta, clientY: 300 }));
        }
        return view;
    }

    it('emits ratios from the gesture-start snapshot, linear in the cumulative delta', () => {
        const onSetRatio = vi.fn();
        drag(onSetRatio, [60, 120, 180]);
        const ratios = onSetRatio.mock.calls.map((call) => call[1] as number);
        expect(ratios).toHaveLength(3);
        // available = 798, firstSize = 399 at drag start.
        expect(ratios[0]).toBeCloseTo((399 + 60) / 798, 12);
        expect(ratios[1]).toBeCloseTo((399 + 120) / 798, 12);
        expect((ratios[1] as number) - (ratios[0] as number)).toBeCloseTo(
            (ratios[2] as number) - (ratios[1] as number),
            12
        );
        expect(onSetRatio.mock.calls.every((call) => call[0] === 'd')).toBe(true);
    });

    it('carries the pane + share that commands.setSplitRatio needs', () => {
        const onSetRatio = vi.fn();
        drag(onSetRatio, [60]);
        const commit = onSetRatio.mock.calls[0]?.[2] as DividerRatioCommit;
        expect(commit.splitPath).toBe('d');
        expect(commit.direction).toBe('horizontal');
        expect(commit.paneID).toBe('a');
        expect(commit.share).toBeCloseTo((399 + 60) / 798, 12);
    });

    /**
     * §LAY-061 — the 2×2 `tiled` root divider: BOTH children are splits, so no pane's
     * enclosing split is `"d"` and the commit carries no pane at all. The split path is the
     * only spelling that can move it, and it is the one the daemon's `set-split-ratio` takes.
     */
    it('hands a both-children-are-splits divider a split path and no pane', () => {
        const onSetRatio = vi.fn();
        renderGrid({
            onSetRatio,
            ratioCommitIntervalMs: 0,
            layout: TILED_2X2,
            panes: [testPane('a'), testPane('b'), testPane('c'), testPane('d')]
        });
        const divider = screen.getByTestId('divider-d');
        // Pressed ON the root bar and clear of the two column dividers' bands, so the
        // T-junction re-resolution cannot hand the gesture to one of them.
        act(() => firePointer(divider, 'pointerdown', { clientX: 399, clientY: 100 }));
        act(() => firePointer(window, 'pointermove', { clientX: 459, clientY: 100 }));
        const commit = onSetRatio.mock.calls[0]?.[2] as DividerRatioCommit;
        expect(commit.splitPath).toBe('d');
        expect(commit.paneID).toBeNull();
        // The path-addressed ratio is still the drag's own arithmetic, and `share` degrades to
        // it so a caller that only knows the pane spelling cannot send a nonsense number.
        expect(onSetRatio.mock.calls[0]?.[1]).toBeCloseTo((399 + 60) / 798, 12);
        expect(commit.share).toBeCloseTo(commit.ratio, 12);
    });

    it('previews the new frames locally, matching updatingSplitRatio', () => {
        const onSetRatio = vi.fn();
        drag(onSetRatio, [60]);
        const ratio = onSetRatio.mock.calls[0]?.[1] as number;
        const expectedFrames = paneFrames(updatingSplitRatio(SIDE_BY_SIDE, 'd', ratio), BOUNDS);
        expect(styleBox(screen.getByTestId('pane-a'))).toEqual(expectedBox(expectedFrames.get('a') as Rect));
        expect(styleBox(screen.getByTestId('pane-b'))).toEqual(expectedBox(expectedFrames.get('b') as Rect));
    });

    it('ignores a press that never moves and drops the preview once the daemon answers', () => {
        const onSetRatio = vi.fn();
        const view = renderGrid({ onSetRatio, ratioCommitIntervalMs: 0 });
        const divider = screen.getByTestId('divider-d');
        act(() => firePointer(divider, 'pointerdown', { clientX: 500, clientY: 300 }));
        act(() => firePointer(window, 'pointerup', { clientX: 500, clientY: 300 }));
        expect(onSetRatio).not.toHaveBeenCalled();

        act(() => firePointer(divider, 'pointerdown', { clientX: 500, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 560, clientY: 300 }));
        act(() => firePointer(window, 'pointerup', { clientX: 560, clientY: 300 }));
        const previewed = styleBox(screen.getByTestId('pane-a'));

        // A fresh layout object from the daemon supersedes the local preview.
        const echoed: PaneLayout = split('horizontal', 0.7, leaf('a'), leaf('b'));
        view.update({ layout: echoed });
        expect(styleBox(screen.getByTestId('pane-a'))).not.toEqual(previewed);
        expect(styleBox(screen.getByTestId('pane-a'))).toEqual(
            expectedBox(paneFrames(echoed, BOUNDS).get('a') as Rect)
        );
    });

    it('coalesces commits while the preview keeps up per frame', () => {
        vi.useFakeTimers();
        const onSetRatio = vi.fn();
        renderGrid({ onSetRatio, ratioCommitIntervalMs: 50 });
        const divider = screen.getByTestId('divider-d');
        act(() => firePointer(divider, 'pointerdown', { clientX: 500, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 520, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 540, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 560, clientY: 300 }));
        expect(onSetRatio).toHaveBeenCalledTimes(1);
        // Release flushes the newest position so the daemon never lags the cursor.
        act(() => firePointer(window, 'pointerup', { clientX: 560, clientY: 300 }));
        expect(onSetRatio).toHaveBeenCalledTimes(2);
        expect(onSetRatio.mock.calls[1]?.[1]).toBeCloseTo((399 + 60) / 798, 12);
    });
});

describe('PaneGrid pane-move drag', () => {
    it('overlays the drop zone and moves the pane on release', () => {
        const onMovePane = vi.fn();
        renderGrid({ onMovePane });
        const header = screen.getByTestId('pane-header-a');

        act(() => firePointer(header, 'pointerdown', { clientX: 40, clientY: 10 }));
        expect(screen.queryByTestId('drop-zone-overlay')).toBeNull(); // below the 8px threshold

        act(() => firePointer(window, 'pointermove', { clientX: 750, clientY: 300 }));
        const overlay = screen.getByTestId('drop-zone-overlay');
        expect(overlay.getAttribute('data-target')).toBe('b');
        expect(overlay.getAttribute('data-zone')).toBe('right');
        const targetRect = paneFrames(SIDE_BY_SIDE, BOUNDS).get('b') as Rect;
        expect(styleBox(overlay)).toEqual(expectedBox(dropZoneOverlayRect('right', targetRect)));
        expect(screen.getByTestId('pane-a').style.opacity).toBe('0.5');

        act(() => firePointer(window, 'pointerup', { clientX: 750, clientY: 300 }));
        expect(onMovePane).toHaveBeenCalledWith('a', 'b', 'right');
        expect(screen.queryByTestId('drop-zone-overlay')).toBeNull();
        expect(screen.getByTestId('pane-a').style.opacity).toBe('1');
    });

    it('drops nothing when released over no other pane', () => {
        const onMovePane = vi.fn();
        renderGrid({ onMovePane });
        act(() => firePointer(screen.getByTestId('pane-header-a'), 'pointerdown', { clientX: 40, clientY: 10 }));
        act(() => firePointer(window, 'pointermove', { clientX: 40, clientY: 900 }));
        expect(screen.queryByTestId('drop-zone-overlay')).toBeNull();
        act(() => firePointer(window, 'pointerup', { clientX: 40, clientY: 900 }));
        expect(onMovePane).not.toHaveBeenCalled();
    });
});

describe('PaneGrid resize badge', () => {
    it('shows cols x rows while a divider drags and lingers 750ms', () => {
        vi.useFakeTimers();
        renderGrid({
            ratioCommitIntervalMs: 0,
            getPaneDimensions: (paneID) => (paneID === 'a' ? { cols: 80, rows: 24 } : { cols: 40, rows: 24 })
        });
        expect(screen.queryByTestId('pane-size-a')).toBeNull();

        const divider = screen.getByTestId('divider-d');
        act(() => firePointer(divider, 'pointerdown', { clientX: 500, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 560, clientY: 300 }));
        expect(screen.getByTestId('pane-size-a').textContent).toBe('80 x 24');
        expect(screen.getByTestId('pane-size-b').textContent).toBe('40 x 24');

        act(() => firePointer(window, 'pointerup', { clientX: 560, clientY: 300 }));
        act(() => vi.advanceTimersByTime(749));
        expect(screen.queryByTestId('pane-size-a')).not.toBeNull();
        act(() => vi.advanceTimersByTime(1));
        expect(screen.queryByTestId('pane-size-a')).toBeNull();
    });

    it('falls back to pixels for a pane with no cell size', () => {
        vi.useFakeTimers();
        renderGrid({ ratioCommitIntervalMs: 0 });
        act(() => firePointer(screen.getByTestId('divider-d'), 'pointerdown', { clientX: 500, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 500, clientY: 300, button: 0 }));
        act(() => firePointer(window, 'pointermove', { clientX: 502, clientY: 300 }));
        expect(screen.getByTestId('pane-size-a').textContent).toBe('401 x 600');
    });

    it('raises the badge when the container itself resizes', () => {
        vi.useFakeTimers();
        const view = renderGrid();
        expect(screen.queryByTestId('pane-size-a')).toBeNull();
        view.update({ size: { width: 900, height: 600 } });
        expect(screen.queryByTestId('pane-size-a')).not.toBeNull();
        act(() => vi.advanceTimersByTime(750));
        expect(screen.queryByTestId('pane-size-a')).toBeNull();
    });
});

describe('PaneGrid focus', () => {
    /**
     * L36's sibling — L33. Focus used to be claimed by the WRAPPER in the capture phase, so a
     * press anywhere inside a pane focused it, header buttons included. The Swift raises focus
     * from the header's own `.onTapGesture` (`PaneHeaderView.swift:279`) and from each body view
     * as it takes first responder; a SwiftUI `Button` swallows its tap before either sees it.
     * The body half of that lives in `TerminalPane` / `ContentFrame` / `WebPane`'s
     * `onFocusRequest` (the stub body this suite renders has none, deliberately).
     */
    it('focuses a pane from a press on its header', () => {
        const onFocusPane = vi.fn();
        renderGrid({ onFocusPane });
        act(() => firePointer(screen.getByTestId('pane-header-b'), 'pointerdown', { clientX: 600, clientY: 10 }));
        expect(onFocusPane).toHaveBeenCalledWith('b');
    });

    it('leaves focus alone when the press lands on a header BUTTON', () => {
        const onFocusPane = vi.fn();
        const onClosePane = vi.fn();
        renderGrid({ onFocusPane, onClosePane, focusedPaneID: 'a' });
        const close = screen.getByTestId('pane-close-b');
        act(() => firePointer(close, 'pointerdown', { clientX: 780, clientY: 10 }));
        act(() => close.click());
        expect(onClosePane).toHaveBeenCalledWith('b');
        expect(onFocusPane).not.toHaveBeenCalled();
    });

    it('does not raise the focused pane above its siblings', () => {
        renderGrid({ focusedPaneID: 'b' });
        // `PaneGridView.swift:104-111` — a plain `ForEach` in a `ZStack`, no focus reordering.
        expect(screen.getByTestId('pane-a').style.zIndex).toBe('1');
        expect(screen.getByTestId('pane-b').style.zIndex).toBe('1');
    });

    it('fires the dwell clear once for a non-idle focused pane', () => {
        vi.useFakeTimers();
        const onDwellClear = vi.fn();
        renderGrid({
            panes: [testPane('a', { status: 'waitingForInput' }), testPane('b')],
            focusedPaneID: 'a',
            onDwellClear
        });
        act(() => vi.advanceTimersByTime(599));
        expect(onDwellClear).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(1));
        expect(onDwellClear).toHaveBeenCalledExactlyOnceWith('a');
        act(() => vi.advanceTimersByTime(5000));
        expect(onDwellClear).toHaveBeenCalledTimes(1);
    });

    /** §AGNT-056: the grid's own wiring of the activation gate, not just the hook's. */
    it('holds the dwell clear while the app is inactive, and re-schedules it on activation', () => {
        vi.useFakeTimers();
        const onDwellClear = vi.fn();
        const grid = renderGrid({
            panes: [testPane('a', { status: 'waitingForInput' }), testPane('b')],
            focusedPaneID: 'a',
            onDwellClear,
            dwellEnabled: false
        });
        act(() => vi.advanceTimersByTime(5000));
        expect(onDwellClear).not.toHaveBeenCalled();

        grid.update({ dwellEnabled: true });
        act(() => vi.advanceTimersByTime(599));
        expect(onDwellClear).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(1));
        expect(onDwellClear).toHaveBeenCalledExactlyOnceWith('a');
    });

    it('focus-follows-mouse honours its delay', () => {
        vi.useFakeTimers();
        const onFocusPane = vi.fn();
        renderGrid({ onFocusPane, focusedPaneID: 'a', focusFollowsMouse: true, focusFollowsMouseDelayMs: 200 });
        // React synthesises enter/leave from pointerover/pointerout at the root container.
        const paneB = screen.getByTestId('pane-b');
        act(() =>
            paneB.dispatchEvent(
                new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body })
            )
        );
        expect(onFocusPane).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(200));
        expect(onFocusPane).toHaveBeenCalledExactlyOnceWith('b');

        // Leaving before the delay elapses cancels the pending focus.
        act(() =>
            screen
                .getByTestId('pane-a')
                .dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: paneB }))
        );
        act(() =>
            paneB.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
        );
        act(() =>
            paneB.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
        );
        act(() => vi.advanceTimersByTime(200));
        expect(onFocusPane).toHaveBeenCalledTimes(1);
    });
});

/**
 * §M12 — the pane overlay (the terminal find bar) hangs off the PANE, not the pane body.
 *
 * `PaneGridView.swift:356-370` attaches it with `.overlay(alignment: .topTrailing)` on the whole
 * pane view, so it floats over the 24 pt header and covers its trailing buttons. Mounted inside
 * `pane-body` it was anchored below the header instead — a header's height too low, over the
 * terminal rather than the chrome (`run-N/70-terminal-search-counted.png`). jsdom has no layout,
 * so the assertable contract is the parentage and the paint order.
 */
describe('PaneGrid pane overlay placement (M12)', () => {
    function renderWithOverlay() {
        return renderGrid({
            renderPaneOverlay: (paneID) =>
                paneID === 'a' ? <div data-testid={`overlay-${paneID}`} /> : null
        });
    }

    it('mounts the overlay on the pane wrapper, not inside the pane body', () => {
        renderWithOverlay();
        const overlay = screen.getByTestId('overlay-a');
        expect(overlay.parentElement).toBe(screen.getByTestId('pane-a'));
        expect(screen.getByTestId('pane-body-a').contains(overlay)).toBe(false);
    });

    it('paints after the header and the body, and before the focus ring', () => {
        renderWithOverlay();
        const ids = [...screen.getByTestId('pane-a').children].map((node) =>
            node.getAttribute('data-testid')
        );
        expect(ids.indexOf('overlay-a')).toBeGreaterThan(ids.indexOf('pane-header-a'));
        expect(ids.indexOf('overlay-a')).toBeGreaterThan(ids.indexOf('pane-body-a'));
        // The wrapper is the containing block the bar's `absolute top-2 right-2` resolves against.
        expect(screen.getByTestId('pane-a').style.position).toBe('absolute');
    });

    it('renders nothing extra for a pane the overlay declines', () => {
        renderWithOverlay();
        expect(screen.queryByTestId('overlay-b')).toBeNull();
    });
});

/**
 * §M13 — the drop-zone overlay and the divider's drag tint are `Color.accentColor`
 * (`PaneGridView.swift:451-452`, `SplitDividerView.swift:20`), the macOS SYSTEM accent, and the
 * shipped app ships no `AccentColor.colorset`. They read `--nex-system-accent` so a Settings ▸
 * Appearance ▸ "Sidebar highlight" override cannot recolour the pane grid the way it recolours
 * the sidebar. The token's value still falls back to `--nex-accent`; the standing divergence (no
 * OS accent in a renderer) is recorded in `tokens.ts`.
 */
describe('PaneGrid system-accent surfaces (M13)', () => {
    it('paints the drop-zone overlay from the system-accent token', () => {
        renderGrid({ onMovePane: vi.fn() });
        act(() => firePointer(screen.getByTestId('pane-header-a'), 'pointerdown', { clientX: 40, clientY: 10 }));
        act(() => firePointer(window, 'pointermove', { clientX: 750, clientY: 300 }));
        const overlay = screen.getByTestId('drop-zone-overlay');
        // The OUTER name is the system accent; `--nex-accent` appears only as its fallback, which
        // is the ledgered divergence — a renderer cannot read the OS accent, so today the two
        // resolve to the same colour and the SEAM is the thing that exists.
        expect(overlay.style.background).toMatch(/var\(--nex-system-accent,/);
        // L36 split the fill from the outline (see below); both still read the one token.
        const outline = screen.getByTestId('drop-zone-outline');
        expect(outline.style.border).toMatch(/var\(--nex-system-accent,/);
    });

    /**
     * L36 — `RoundedRectangle(cornerRadius: 4).fill(…).border(…, width: 2)`
     * (`PaneGridView.swift:450-453`). SwiftUI's `.border` strokes the view's rectangular FRAME
     * regardless of the shape under it, so the shipped drop zone is a hard-cornered 2 px outline
     * over a 4 pt-rounded fill. A border that followed the radius was the port's own tidying-up.
     */
    it('draws a square outline over the rounded drop-zone fill', () => {
        renderGrid({ onMovePane: vi.fn() });
        act(() => firePointer(screen.getByTestId('pane-header-a'), 'pointerdown', { clientX: 40, clientY: 10 }));
        act(() => firePointer(window, 'pointermove', { clientX: 750, clientY: 300 }));
        expect(screen.getByTestId('drop-zone-overlay').style.borderRadius).toBe('4px');
        const outline = screen.getByTestId('drop-zone-outline');
        expect(outline.style.borderRadius).toBe('');
        expect(outline.style.border).toMatch(/^2px solid /);
    });

    it('tints only the DRAGGED divider, and from the same token', () => {
        renderGrid({ ratioCommitIntervalMs: 0 });
        const bar = screen.getByTestId('divider-d').firstElementChild as HTMLElement;
        expect(bar.style.background).not.toContain('--nex-system-accent');

        act(() => firePointer(screen.getByTestId('divider-d'), 'pointerdown', { clientX: 500, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 560, clientY: 300 }));
        const dragged = screen.getByTestId('divider-d').firstElementChild as HTMLElement;
        expect(dragged.style.background).toContain('--nex-system-accent');
    });

    /**
     * L35 — the resting divider is TWO layers. `SplitDividerView.swift:18-20` fills with
     * `chromeTheme.divider` and then overlays `Color.secondary.opacity(0.2)` unconditionally
     * (the accent tint only REPLACES that overlay while dragging). The port had dropped the
     * resting overlay, so every divider in the window sat a step darker and flatter than the
     * shipped app's.
     */
    it('lifts the resting divider with the secondary overlay the Swift paints over it', () => {
        renderGrid();
        const bar = screen.getByTestId('divider-d').firstElementChild as HTMLElement;
        expect(bar.style.background).toBe(
            'color-mix(in srgb, var(--nex-fg-secondary, #9A9AA0) 20%, var(--nex-border, #24242B))'
        );
    });
});

/**
 * §M16 — the "No panes" placeholder is two tones, not one. `PaneGridView.swift:492-500` paints
 * the 36 pt terminal `.quaternary` (the label colour at 10%) and the label `.secondary` at
 * `.title3`; the port had both at `textTertiary`/`text-sm`, so the ghost glyph read as a solid
 * icon. macOS `.title3` is 15 pt — the macOS type ramp, not iOS's 20.
 */
describe('PaneGrid empty state tones (M16)', () => {
    it('splits the glyph and the label into two tones and raises the label', () => {
        renderGrid({ layout: empty(), panes: [], onCreatePane: vi.fn() });
        const root = screen.getByTestId('pane-grid-empty');
        expect(root.style.color).toContain('--nex-fg-secondary');

        const glyph = screen.getByTestId('pane-grid-empty-glyph');
        expect(glyph.style.color).toContain('--nex-fg,');
        expect(glyph.style.color).toContain(' 10%');
        expect(glyph.querySelector('svg')?.getAttribute('width')).toBe('36');

        const label = screen.getByTestId('pane-grid-empty-label');
        expect(label.textContent).toBe('No panes');
        expect(label.className).toContain('text-[15px]');
        expect(label.className).not.toContain('text-sm');
    });
});

/**
 * §M18 — `ResizeDimensionsOverlay.swift:11-20`: 12/6 pt padding, `cornerRadius: 6`, and
 * `.shadow(color: .black.opacity(0.25), radius: 4, y: 2)`. The port drew the chip a third smaller
 * with a heavier drop.
 */
describe('PaneGrid resize badge metrics (M18)', () => {
    it('pads 12/6 and softens the shadow to the Swift’s 25%', () => {
        vi.useFakeTimers();
        const view = renderGrid();
        view.update({ size: { width: 900, height: 600 } });
        const badge = screen.getByTestId('pane-size-a');
        expect(badge.className).toContain('px-3');
        expect(badge.className).toContain('py-1.5');
        expect(badge.className).toContain('rounded-md');
        expect(badge.style.boxShadow).toBe('0 2px 8px rgba(0,0,0,0.25)');
    });
});

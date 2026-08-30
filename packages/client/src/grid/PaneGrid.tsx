/**
 * The pane grid (shell-ui.md §4, pane-layout.md §7).
 *
 * A measured container that paints the active workspace's `PaneLayout` as absolutely
 * positioned pane wrappers, divider grab strips, and the transient overlays that direct
 * manipulation needs (drop zones, resize badges).
 *
 * Three invariants shape the whole component:
 *
 * 1. **No layout maths here.** Every rect comes from `@kelpi/core/layout` — `paneFrames`,
 *    `splitDividers`, `dividerHitRect`, `dividerDragSnapshot`/`ratioFromDividerDrag`,
 *    `calculateDropZone`, `dropZoneOverlayRect`. The daemon runs the same functions, so a
 *    divider cannot drift between what the client draws and what the daemon stores.
 * 2. **Pane identity is sacred** (shell-ui.md §4, "Pane view identity is stable"). Wrappers
 *    are keyed by pane id and rendered in a layout-independent order (sorted by id), so a
 *    split, a move, a zoom or a workspace-wide relayout only ever changes a wrapper's
 *    `style` — React never unmounts, remounts, or even reorders the node, and the terminal
 *    canvas inside it keeps its scrollback and its PTY.
 * 3. **Panes are never unmounted to hide them.** A pane missing from the current layout
 *    (the zoom case: the daemon collapses the tree to `leaf(zoomedPaneID)`) renders at its
 *    last known frame with `visibility: hidden`, so zooming out is instant and the hidden
 *    terminal keeps draining.
 *
 * The component is props-driven end to end: it never reads the store or sends a command.
 */

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
    type ReactElement,
    type ReactNode
} from 'react';
import { flushSync } from 'react-dom';

import {
    DIVIDER_HIT_INSET,
    calculateDropZone,
    dividerDragSnapshot,
    dividerHitRect,
    dropZoneOverlayRect,
    isEmptyLayout,
    paneAtPoint,
    paneFrames,
    splitDividers,
    updatingSplitRatio,
    type DropZone,
    type PaneLayout,
    type Point,
    type Rect,
    type SplitDividerInfo
} from '@kelpi/core/layout';

import {
    dividerAtPoint,
    dividerCommit,
    dividerDragActivated,
    ratioForDividerDrag,
    throttleTrailing,
    type Throttled
} from './divider';
import { useOverlayPresence } from '../chrome/modal-presence';
import { FocusRing, useFocusDwell } from './FocusRing';
import { Icon } from './icons';
import { PANE_HEADER_HEIGHT, PaneHeader } from './PaneHeader';
import { tokens } from './tokens';
import type {
    GridLayoutCallbacks,
    PaneActions,
    PaneDimensions,
    PaneGridSize,
    PaneModel,
    RenderPane
} from './types';

/** Header drag distance before a pane-move gesture starts (shell-ui.md §4.3). */
export const PANE_MOVE_DRAG_THRESHOLD = 8;
/** The resize badge lingers this long after the last resize event (shell-ui.md §4.4). */
export const RESIZE_BADGE_LINGER_MS = 750;
/** Ratio commits are coalesced to one per interval; the drag preview stays per-frame. */
export const RATIO_COMMIT_INTERVAL_MS = 50;

const EMPTY_SIZE: PaneGridSize = { width: 0, height: 0 };

export interface DropTarget {
    readonly paneID: string;
    readonly zone: DropZone;
}

export interface PaneGridProps extends PaneActions, GridLayoutCallbacks {
    /** The workspace's live layout tree (already `leaf(zoomed)` when the daemon zoomed it). */
    readonly layout: PaneLayout;
    /** Every pane in the workspace — including ones the layout currently hides. */
    readonly panes: readonly PaneModel[];
    readonly focusedPaneID?: string | null | undefined;
    /** Zoomed pane: fills the grid, everything else hides (shell-ui.md §4.2 item 4). */
    readonly zoomedPaneID?: string | null | undefined;
    readonly syncActive?: boolean | undefined;
    readonly syncExcludedPaneIDs?: readonly string[] | undefined;
    readonly homeDirectory?: string | undefined;
    /** Renders a pane's body; the header is the grid's. */
    readonly renderPane: RenderPane;
    /**
     * Renders a floating layer OVER a pane's body — the search overlay, and anything else that
     * must sit above the terminal canvas without being part of it (`PaneSearchOverlay.tsx`).
     *
     * A separate slot rather than something `renderPane` returns, because a pane's body belongs
     * to whatever engine owns it (the terminal canvas, a sandboxed content frame, the measured
     * hole a web pane's native view is placed into) and none of those can host a sibling.
     * Return `null` for every pane without an overlay, which is the normal case.
     */
    readonly renderPaneOverlay?: ((paneID: string) => ReactNode) | undefined;
    /**
     * "Open the inline rename field on this pane" — the context menu's Rename… (TERM-106).
     * `seq` is bumped on each request so asking twice re-opens the field.
     */
    readonly renameRequest?: { readonly paneID: string; readonly seq: number } | null | undefined;
    readonly headerHeight?: number | undefined;
    /** Fixed size instead of measuring — tests and any non-DOM host. */
    readonly size?: PaneGridSize | undefined;
    /** Terminal cols/rows for the resize badge; falls back to pixels when absent. */
    readonly getPaneDimensions?: ((paneID: string) => PaneDimensions | null | undefined) | undefined;
    readonly ratioCommitIntervalMs?: number | undefined;
    readonly resizeBadgeLingerMs?: number | undefined;
    /** Overrides the 600 ms focus-dwell delay (shell-ui.md §4.6). */
    readonly dwellMs?: number | undefined;
    /**
     * §AGNT-056: is this the app the user is actually looking at? The dwell clear is an
     * ACKNOWLEDGMENT, so false suspends it — a badge raised while the window is in the
     * background has to survive until someone comes back — and the flip back to true
     * re-schedules it, which is precisely what the Swift's `didBecomeActive` handler does.
     * Defaults to true: a host that reports no activation behaves exactly as before.
     */
    readonly dwellEnabled?: boolean | undefined;
    readonly focusFollowsMouse?: boolean | undefined;
    readonly focusFollowsMouseDelayMs?: number | undefined;
    readonly className?: string | undefined;
}

interface DividerGesture {
    readonly snapshot: ReturnType<typeof dividerDragSnapshot>;
    readonly origin: Point;
    readonly commit: Throttled<[number]>;
    active: boolean;
}

interface MoveGesture {
    readonly paneID: string;
    readonly origin: Point;
    active: boolean;
}

interface RatioPreview {
    readonly splitPath: string;
    readonly ratio: number;
    /** The layout the preview was computed against; a newer one supersedes it. */
    readonly base: PaneLayout;
}

function absolute(rect: Rect): CSSProperties {
    return { position: 'absolute', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` };
}

function bodyFrame(frame: Rect, headerHeight: number): Rect {
    return {
        x: frame.x,
        y: frame.y + headerHeight,
        width: frame.width,
        height: Math.max(0, frame.height - headerHeight)
    };
}

/** `<cols> x <rows>`, or pixels for a pane with no cell size (shell-ui.md §4.4). */
export function resizeBadgeText(frame: Rect, dimensions: PaneDimensions | null | undefined): string {
    if (dimensions === null || dimensions === undefined) {
        return `${Math.round(frame.width)} x ${Math.round(frame.height)}`;
    }
    return `${dimensions.cols} x ${dimensions.rows}`;
}

export function PaneGrid(props: PaneGridProps): ReactElement {
    const {
        layout,
        panes,
        focusedPaneID = null,
        zoomedPaneID = null,
        syncActive = false,
        syncExcludedPaneIDs,
        homeDirectory = '',
        renderPane,
        headerHeight = PANE_HEADER_HEIGHT,
        size: fixedSize,
        getPaneDimensions,
        ratioCommitIntervalMs = RATIO_COMMIT_INTERVAL_MS,
        resizeBadgeLingerMs = RESIZE_BADGE_LINGER_MS,
        dwellMs,
        dwellEnabled = true,
        focusFollowsMouse = false,
        focusFollowsMouseDelayMs = 0,
        className,
        onFocusPane,
        onDwellClear,
        onSetRatio,
        onMovePane,
        onCreatePane
    } = props;

    // Handlers live on `window` for the duration of a gesture (jsdom and Safari both make
    // pointer capture unreliable), so they read props through a ref instead of closing over
    // them — otherwise every prop change would have to tear down and re-install listeners.
    const latest = useRef(props);
    useEffect(() => {
        latest.current = props;
    });

    const containerRef = useRef<HTMLDivElement | null>(null);
    const [measured, setMeasured] = useState<PaneGridSize>(EMPTY_SIZE);
    const size = fixedSize ?? measured;

    const [preview, setPreview] = useState<RatioPreview | null>(null);
    const [activeDividerPath, setActiveDividerPath] = useState<string | null>(null);
    const [draggingPaneID, setDraggingPaneID] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
    const [resizing, setResizing] = useState(false);

    const dividerRef = useRef<DividerGesture | null>(null);
    const moveRef = useRef<MoveGesture | null>(null);
    const dropTargetRef = useRef<DropTarget | null>(null);
    const detachRef = useRef<(() => void) | null>(null);
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const framesRef = useRef<ReadonlyMap<string, Rect>>(new Map());
    const dividersRef = useRef<readonly SplitDividerInfo[]>([]);
    const lastFramesRef = useRef<Map<string, Rect>>(new Map());

    // ── measurement ─────────────────────────────────────────────────────────────────

    const measuring = fixedSize === undefined;
    useEffect(() => {
        if (!measuring) return;
        const element = containerRef.current;
        if (element === null) return;
        const read = (): void => {
            /*
             * §N31 — FRACTIONAL. `clientWidth` is rounded to an integer, and the container is
             * fractional for every frame of a slide (its width is an eased 280 px). Laying the
             * panes out at the rounded-down width leaves the remainder — up to a pixel at the
             * trailing edge — painted by nothing, which is the same transparent hairline as the
             * lag below, just one pixel wide. The border box minus the border/scrollbar frame is
             * `clientWidth`'s own definition, in the precision the layout actually has.
             */
            const rect = element.getBoundingClientRect();
            /*
             * The border/scrollbar frame, clamped at zero. In a browser `offsetWidth` is never
             * below `clientWidth`, so the difference is exactly what the border box holds beyond
             * the content box; in jsdom `offsetWidth` is always 0 while a test may pin
             * `clientWidth`, and an unclamped subtraction would then ADD the content width back
             * (`App.layout-divider`'s 800 px grid measured 1600).
             */
            const frameX = Math.max(0, element.offsetWidth - element.clientWidth);
            const frameY = Math.max(0, element.offsetHeight - element.clientHeight);
            const width = Math.max(0, rect.width - frameX);
            const height = Math.max(0, rect.height - frameY);
            setMeasured((current) =>
                current.width === width && current.height === height ? current : { width, height }
            );
        };
        /*
         * §N31 — the measurement has to land in the SAME frame the container resized in.
         *
         * Every pane is `position: absolute` at a pixel rect derived from `measured`, and the
         * grid itself paints nothing (`--kelpi-window-fill` is `transparent` below
         * `background-opacity` 1, §N17). So for as long as `measured` disagrees with the
         * container, the difference is not "slightly stale panes" — it is a strip of window
         * that NOTHING has painted, i.e. the desktop.
         *
         * A `ResizeObserver` notification is delivered after layout and before paint, but a
         * plain `setState` there is scheduled: React re-renders in a later task and the browser
         * paints the frame in between with the panes still at their old rects. During a 250 ms
         * side-panel slide the container moves ~18 px per frame, so that one-frame debt is a
         * transparent band travelling with the panel — measured at 21.2 px on the inspector's
         * close, 16.7 px on the sidebar's and 38.2 px on a slide reversed mid-flight, and
         * photographed at alpha 0 (§N31's reopened half: the owner's light wallpaper showing
         * through as "white", which is exactly what he reported after the clip fill closed the
         * reveal itself — see `docs/audit/n31-grid-lag/`).
         *
         * `flushSync` inside the callback re-renders and re-writes the pane rects while the
         * browser is still in its rendering steps, so the observation loop re-runs layout and
         * paints the corrected geometry in that same frame. It is deliberately NOT used for the
         * first read below: that one runs inside an effect, where React is already rendering.
         */
        read();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', read);
            return () => window.removeEventListener('resize', read);
        }
        const observer = new ResizeObserver(() => {
            flushSync(read);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [measuring]);

    const markResizing = useCallback((): void => {
        setResizing(true);
        if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
            resizeTimerRef.current = null;
            setResizing(false);
        }, resizeBadgeLingerMs);
    }, [resizeBadgeLingerMs]);

    // A container resize (window / sidebar / inspector) raises the badge too (§4.4). The
    // first measurement — 0×0 to real — is not a resize, it's the grid appearing.
    const previousSize = useRef<PaneGridSize | null>(null);
    useEffect(() => {
        const previous = previousSize.current;
        previousSize.current = size;
        if (previous === null) return;
        if (previous.width === size.width && previous.height === size.height) return;
        if (previous.width === 0 || previous.height === 0) return;
        markResizing();
    }, [size, markResizing]);

    // ── geometry ────────────────────────────────────────────────────────────────────

    const bounds = useMemo<Rect>(
        () => ({ x: 0, y: 0, width: size.width, height: size.height }),
        [size.width, size.height]
    );

    const zoomed = useMemo(() => {
        if (zoomedPaneID === null || zoomedPaneID === undefined) return null;
        return panes.some((pane) => pane.id === zoomedPaneID) ? zoomedPaneID : null;
    }, [zoomedPaneID, panes]);

    // The live ratio during a divider drag: applied on top of the daemon's tree so the
    // divider tracks the cursor at frame rate while commits go out throttled. A preview
    // computed against an older tree is dropped the moment a fresh one arrives, unless the
    // gesture is still running (in which case it re-applies to the newer tree).
    const previewLayout = useMemo(() => {
        if (preview === null) return layout;
        if (activeDividerPath === null && preview.base !== layout) return layout;
        return updatingSplitRatio(layout, preview.splitPath, preview.ratio);
    }, [layout, preview, activeDividerPath]);

    // …and once it is neither in use nor in flight, drop it so it can't resurface.
    useEffect(() => {
        if (preview === null || activeDividerPath !== null || preview.base === layout) return;
        setPreview(null);
    }, [preview, activeDividerPath, layout]);

    const frames = useMemo<ReadonlyMap<string, Rect>>(() => {
        if (zoomed !== null) return new Map([[zoomed, bounds]]);
        return paneFrames(previewLayout, bounds);
    }, [zoomed, previewLayout, bounds]);

    const dividers = useMemo<readonly SplitDividerInfo[]>(
        () => (zoomed !== null ? [] : splitDividers(previewLayout, bounds)),
        [zoomed, previewLayout, bounds]
    );

    // The drag hit-test reads frames from a ref (the pointer handlers live on `window` and
    // must not be re-installed per render), and hidden panes keep their last real frame so a
    // zoom-out doesn't hand the terminal a bogus size. Both caches are written after commit,
    // never during render.
    useEffect(() => {
        framesRef.current = frames;
        for (const [paneID, rect] of frames) lastFramesRef.current.set(paneID, rect);
    }, [frames]);

    // Same reason: the press handler re-resolves which divider a grab means (see
    // `startDividerDrag`) and must not be rebuilt every time the layout moves.
    useEffect(() => {
        dividersRef.current = dividers;
    }, [dividers]);

    // Layout-independent DOM order: the wrapper for a given pane keeps its position in the
    // child list no matter how the tree is rearranged, so React never even moves the node.
    const orderedPanes = useMemo(
        () => [...panes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        [panes]
    );

    // ── gesture plumbing ────────────────────────────────────────────────────────────

    const detachListeners = useCallback((): void => {
        detachRef.current?.();
        detachRef.current = null;
    }, []);

    const attachListeners = useCallback(
        (onMove: (event: PointerEvent) => void, onUp: (event: PointerEvent) => void): void => {
            detachRef.current?.();
            const move = onMove as EventListener;
            const up = onUp as EventListener;
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
            window.addEventListener('pointercancel', up);
            detachRef.current = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                window.removeEventListener('pointercancel', up);
            };
        },
        []
    );

    const toLocal = useCallback((clientX: number, clientY: number): Point => {
        const element = containerRef.current;
        if (element === null) return { x: clientX, y: clientY };
        const rect = element.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }, []);

    // ── divider drag (shell-ui.md §4.4, pane-layout.md §7.4) ────────────────────────

    const endDividerDrag = useCallback((): void => {
        const gesture = dividerRef.current;
        dividerRef.current = null;
        detachListeners();
        setActiveDividerPath(null);
        if (gesture === null) return;
        if (gesture.active) {
            gesture.commit.flush();
            markResizing();
        } else {
            gesture.commit.cancel();
        }
    }, [detachListeners, markResizing]);

    const onDividerPointerMove = useCallback(
        (event: PointerEvent): void => {
            const gesture = dividerRef.current;
            if (gesture === null) return;
            const point: Point = { x: event.clientX, y: event.clientY };
            if (!gesture.active) {
                if (!dividerDragActivated(gesture.snapshot.direction, gesture.origin, point)) return;
                gesture.active = true;
            }
            markResizing();
            const ratio = ratioForDividerDrag(gesture.snapshot, gesture.origin, point);
            setPreview({ splitPath: gesture.snapshot.splitPath, ratio, base: latest.current.layout });
            gesture.commit(ratio);
        },
        [markResizing]
    );

    const startDividerDrag = useCallback(
        (pressed: SplitDividerInfo, event: ReactPointerEvent<HTMLDivElement>): void => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            /**
             * The DOM says which divider ELEMENT was pressed; geometry says which divider was
             * MEANT. At a T-junction the two 10px grab strips overlap and the element that wins
             * is arbitrary, so the press is re-resolved against every divider's bar (run-B m8).
             */
            const info = dividerAtPoint(
                dividersRef.current,
                toLocal(event.clientX, event.clientY),
                pressed,
                DIVIDER_HIT_INSET + 1
            );
            const snapshot = dividerDragSnapshot(info);
            const commit = throttleTrailing((ratio: number) => {
                const current = latest.current;
                current.onSetRatio?.(
                    snapshot.splitPath,
                    ratio,
                    dividerCommit(current.layout, snapshot, ratio)
                );
            }, ratioCommitIntervalMs);
            dividerRef.current = { snapshot, origin: { x: event.clientX, y: event.clientY }, commit, active: false };
            setActiveDividerPath(info.id);
            const target = event.currentTarget;
            if (typeof target.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
                try {
                    target.setPointerCapture(event.pointerId);
                } catch {
                    // Capture is a nicety; the window listeners are the real mechanism.
                }
            }
            attachListeners(onDividerPointerMove, endDividerDrag);
        },
        [attachListeners, onDividerPointerMove, endDividerDrag, ratioCommitIntervalMs, toLocal]
    );

    // ── pane move drag (shell-ui.md §4.3, pane-layout.md §7.5) ──────────────────────

    const endPaneDrag = useCallback((): void => {
        const gesture = moveRef.current;
        const target = dropTargetRef.current;
        moveRef.current = null;
        dropTargetRef.current = null;
        detachListeners();
        setDraggingPaneID(null);
        setDropTarget(null);
        if (gesture === null || !gesture.active || target === null) return;
        if (target.paneID === gesture.paneID) return;
        latest.current.onMovePane?.(gesture.paneID, target.paneID, target.zone);
    }, [detachListeners]);

    const onPanePointerMove = useCallback(
        (event: PointerEvent): void => {
            const gesture = moveRef.current;
            if (gesture === null) return;
            if (!gesture.active) {
                const dx = event.clientX - gesture.origin.x;
                const dy = event.clientY - gesture.origin.y;
                if (Math.hypot(dx, dy) < PANE_MOVE_DRAG_THRESHOLD) return;
                gesture.active = true;
                setDraggingPaneID(gesture.paneID);
            }
            const point = toLocal(event.clientX, event.clientY);
            const targetID = paneAtPoint(framesRef.current, point, gesture.paneID);
            const rect = targetID === null ? undefined : framesRef.current.get(targetID);
            if (targetID === null || rect === undefined) {
                dropTargetRef.current = null;
                setDropTarget(null);
                return;
            }
            const next: DropTarget = { paneID: targetID, zone: calculateDropZone(point, rect) };
            const current = dropTargetRef.current;
            if (current !== null && current.paneID === next.paneID && current.zone === next.zone) return;
            dropTargetRef.current = next;
            setDropTarget(next);
        },
        [toLocal]
    );

    const startPaneDrag = useCallback(
        (paneID: string, event: ReactPointerEvent<HTMLElement>): void => {
            if (event.button !== 0) return;
            moveRef.current = { paneID, origin: { x: event.clientX, y: event.clientY }, active: false };
            dropTargetRef.current = null;
            attachListeners(onPanePointerMove, endPaneDrag);
        },
        [attachListeners, onPanePointerMove, endPaneDrag]
    );

    // ── focus ───────────────────────────────────────────────────────────────────────

    const focusedStatus = useMemo(
        () => panes.find((pane) => pane.id === focusedPaneID)?.status ?? null,
        [panes, focusedPaneID]
    );

    useFocusDwell({
        paneID: focusedPaneID,
        status: focusedStatus,
        onDwellClear,
        // §AGNT-056: the gate. `enabled` is a dependency of the timer's effect, so a
        // deactivate tears the pending clear down and the next activate schedules a fresh
        // 600 ms — the Swift's "same clear, scheduled again on didBecomeActive".
        enabled: dwellEnabled,
        ...(dwellMs === undefined ? {} : { delayMs: dwellMs })
    });

    const cancelHover = useCallback((): void => {
        if (hoverTimerRef.current === null) return;
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
    }, []);

    const onPaneEnter = useCallback(
        (paneID: string): void => {
            const current = latest.current;
            if (current.focusFollowsMouse !== true) return;
            if (current.focusedPaneID === paneID) return;
            cancelHover();
            const delay = current.focusFollowsMouseDelayMs ?? 0;
            if (delay <= 0) {
                current.onFocusPane?.(paneID);
                return;
            }
            hoverTimerRef.current = setTimeout(() => {
                hoverTimerRef.current = null;
                latest.current.onFocusPane?.(paneID);
            }, delay);
        },
        [cancelHover]
    );

    useEffect(
        () => () => {
            detachRef.current?.();
            detachRef.current = null;
            dividerRef.current?.commit.cancel();
            if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
            if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
        },
        []
    );

    // ── render ──────────────────────────────────────────────────────────────────────

    const excluded = useMemo(() => new Set(syncExcludedPaneIDs ?? []), [syncExcludedPaneIDs]);
    const zoomAvailable = panes.length > 1;
    const dropRect =
        dropTarget === null
            ? null
            : (() => {
                  const rect = frames.get(dropTarget.paneID);
                  return rect === undefined ? null : dropZoneOverlayRect(dropTarget.zone, rect);
              })();
    /*
     * §N26 — the drop highlight is drawn INSIDE the target pane, so when the target is a web
     * pane it was painted under the live page and the gesture had no visible answer at all
     * (`docs/audit/n26-popup-layering`, step `08-pane-drop-zone`). It registers its box with
     * `chrome/modal-presence` for the length of the drag, which parks the pane being dropped on
     * — and only that pane — so the accent fill and its outline are actually on screen.
     */
    const dropZoneRef = useRef<HTMLDivElement | null>(null);
    useOverlayPresence(dropZoneRef, dropRect !== null && dropTarget !== null);

    return (
        <div
            ref={containerRef}
            data-testid="pane-grid"
            data-resizing={resizing ? 'true' : 'false'}
            className={`relative h-full w-full overflow-hidden${className === undefined ? '' : ` ${className}`}`}
            /*
             * §N17 — NO fill here. `PaneGridView.swift:104-118` is a bare `ZStack` over a
             * `GeometryReader`: the grid paints nothing, the app's ground shows through the
             * gutters, and the only fill in the tree is each pane's own. This container used to
             * repaint `--kelpi-bg`, which is invisible at opacity 1 (same colour as the ground
             * behind it) and lethal below it — a second 0.85 layer, and alpha multiplies. The
             * one place the Swift DOES paint `windowBackground` is the empty placeholder
             * (`:509-510`), which `EmptyGrid` now carries itself.
             */
        >
            {isEmptyLayout(layout) && panes.length === 0 ? (
                <EmptyGrid {...(onCreatePane === undefined ? {} : { onCreatePane })} />
            ) : null}

            {orderedPanes.map((pane) => {
                const frame = frames.get(pane.id);
                const visible = frame !== undefined;
                const rect = frame ?? lastFramesRef.current.get(pane.id) ?? bounds;
                const focused = pane.id === focusedPaneID;
                return (
                    <div
                        key={pane.id}
                        data-testid={`pane-${pane.id}`}
                        data-pane-id={pane.id}
                        data-hidden={visible ? 'false' : 'true'}
                        data-focused={focused ? 'true' : 'false'}
                        data-zoomed={zoomed === pane.id ? 'true' : 'false'}
                        className="flex flex-col overflow-hidden"
                        style={{
                            ...absolute(rect),
                            visibility: visible ? 'visible' : 'hidden',
                            pointerEvents: visible ? 'auto' : 'none',
                            opacity: draggingPaneID === pane.id ? 0.5 : 1,
                            // L31: one plane for every visible pane. `PaneGridView.swift:104-111`
                            // paints the panes with a plain `ForEach` inside a `ZStack` and never
                            // reorders on focus, so where a 2 px focus ring meets a neighbour's
                            // edge the shipped app lets paint order decide — it does not lift the
                            // focused pane above its siblings. (The port's DOM order is by pane
                            // id rather than the `panes` array, which is a deliberate, separate
                            // choice: it keeps React from moving a terminal's node when the tree
                            // is rearranged.)
                            zIndex: visible ? 1 : 0
                            /*
                             * §N17 — and NO fill on the wrapper either.
                             *
                             * `PaneGridView.swift:370-378` is explicit about this: the pane's
                             * `.background` is painted for markdown / scratchpad / diff / web
                             * bodies ONLY, at the ghostty colour and the ghostty opacity. A
                             * `.shell` pane's wrapper paints nothing at all, because the
                             * libghostty surface inside it already carries the opacity and any
                             * fill behind it would be a second layer to composite through.
                             *
                             * The port's equivalent of that surface fill is the `background`
                             * each pane body paints (`App.tsx`'s `paneFill`, an
                             * `rgba(ghostty-bg, opacity)`), so this wrapper's job is layout,
                             * not paint. The header and the `flex-1` body cover it edge to
                             * edge, which is why removing it is invisible at opacity 1.
                             */
                        }}
                        // L33: no focus-on-press here. The wrapper used to claim the press in the
                        // CAPTURE phase, so clicking Split Down or ✕ on a background pane focused
                        // it on the way to the button; in the Swift a SwiftUI `Button` consumes
                        // its own tap and the header's `.onTapGesture` never fires, so focus does
                        // not move (`PaneHeaderView.swift:263-272,279`). Focus is now raised where
                        // the Swift raises it: the header's own tap handler (below), and each pane
                        // body's `onFocusRequest` (`TerminalPane`, the content frames, `WebPane`).
                        onPointerEnter={() => onPaneEnter(pane.id)}
                        onPointerLeave={cancelHover}
                    >
                        <PaneHeader
                            pane={pane}
                            focused={focused}
                            // `PaneHeaderView.swift:279` — `.onTapGesture { onFocus() }` on the
                            // header itself, which every control inside it shadows.
                            {...(onFocusPane === undefined ? {} : { onFocusPane })}
                            zoomed={zoomed === pane.id}
                            zoomAvailable={zoomAvailable}
                            syncActive={syncActive}
                            syncExcluded={excluded.has(pane.id)}
                            homeDirectory={homeDirectory}
                            height={headerHeight}
                            // §S8: the header's own width, which the grid already holds as the
                            // pane's frame. `badgeFit` reads it to decide whether a user-data
                            // badge has room to be drawn at all, rather than letting the flex
                            // squeeze collapse one to a colour stub.
                            paneWidth={rect.width}
                            renameToken={props.renameRequest?.paneID === pane.id ? props.renameRequest.seq : 0}
                            onHeaderPointerDown={startPaneDrag}
                            onClosePane={props.onClosePane}
                            onRenamePane={props.onRenamePane}
                            onSplitPane={props.onSplitPane}
                            onToggleZoom={props.onToggleZoom}
                            onToggleMarkdownEdit={props.onToggleMarkdownEdit}
                            onRefreshDiff={props.onRefreshDiff}
                            onCopyDocument={props.onCopyDocument}
                            onSetFontSize={props.onSetFontSize}
                            onRestartAgent={props.onRestartAgent}
                            onNewWebPane={props.onNewWebPane}
                            onPaneContextMenu={props.onPaneContextMenu}
                        />
                        <div
                            data-testid={`pane-body-${pane.id}`}
                            className="relative min-h-0 flex-1"
                        >
                            {renderPane(pane.id, bodyFrame(rect, headerHeight), focused, {
                                visible,
                                zoomed: zoomed === pane.id,
                                dragging: draggingPaneID === pane.id
                            })}
                        </div>
                        {/* M12 — the pane overlay hangs off the PANE, not the pane body.
                            `PaneGridView.swift:356-370` attaches the search bar with
                            `.overlay(alignment: .topTrailing)` on the whole pane view, after
                            `.frame(width:height:)`, so it floats over the 24 pt header and covers
                            its trailing buttons. Mounted inside `pane-body` it was anchored below
                            the header instead — the bar sat a header's height too low, over the
                            terminal rather than the chrome (`run-N/70-terminal-search-counted.png`).
                            The wrapper is `position: absolute`, so it is already the containing
                            block the bar's `absolute right-2 top-2` needs; the ordering keeps the
                            focus ring and the resize badge painting above it, as the Swift's later
                            `.overlay` modifiers do (`:379`, `:387`). */}
                        {props.renderPaneOverlay?.(pane.id) ?? null}
                        <FocusRing focused={focused} />
                        {/*
                          * §N26's matrix, for the record: this badge is over the page area of a
                          * WEB pane too, and there it is invisible — a native `WebContentsView`
                          * is composited above this document. It is deliberately not enrolled in
                          * `chrome/modal-presence`: it is painted only while a divider is being
                          * dragged, its box moves with every frame of that drag, and enrolling it
                          * would park (and un-park) a real OS-level view continuously to show a
                          * `W x H` readout — while the page resizing under the drag IS the
                          * feedback. The surfaces enrolled are the ones a user reads and clicks.
                          */}
                        {resizing && visible ? (
                            <ResizeBadge
                                paneID={pane.id}
                                text={resizeBadgeText(rect, getPaneDimensions?.(pane.id))}
                            />
                        ) : null}
                    </div>
                );
            })}

            {dividers.map((info) => (
                <Divider
                    key={info.id}
                    info={info}
                    dragging={activeDividerPath === info.id}
                    onPointerDown={startDividerDrag}
                />
            ))}

            {dropRect === null || dropTarget === null ? null : (
                <div
                    ref={dropZoneRef}
                    data-testid="drop-zone-overlay"
                    data-zone={dropTarget.zone}
                    data-target={dropTarget.paneID}
                    aria-hidden="true"
                    className="pointer-events-none"
                    style={{
                        ...absolute(dropRect),
                        zIndex: 20,
                        borderRadius: 4,
                        // M13: `PaneGridView.swift:451-452` fills and borders with
                        // `Color.accentColor` — the macOS system accent, not the chrome theme's
                        // `accent`. See `tokens.ts` for the seam and the standing divergence.
                        background: `color-mix(in srgb, ${tokens.systemAccent} 20%, transparent)`
                    }}
                >
                    {/*
                      * L36 — the outline is SQUARE over a rounded fill.
                      *
                      * `PaneGridView.swift:450-453` is `RoundedRectangle(cornerRadius: 4)
                      * .fill(…).border(…, width: 2)`, and SwiftUI's `.border` always strokes the
                      * view's rectangular frame — it knows nothing about the shape it was applied
                      * to. So the shipped drop zone really does draw a hard-cornered 2 px frame
                      * over a 4 pt-rounded fill, with the fill's corners peeking inside the
                      * outline's. It reads as a quirk because it IS one, and it is what the app
                      * on disk looks like; a border that followed the radius was the port's
                      * tidier invention.
                      *
                      * A second element because one box cannot have a rounded background and a
                      * square border — and it is a CHILD so the outline paints above the fill,
                      * the order `.border`-after-`.fill` gives.
                      */}
                    <div
                        data-testid="drop-zone-outline"
                        aria-hidden="true"
                        style={{
                            position: 'absolute',
                            inset: 0,
                            boxSizing: 'border-box',
                            border: `2px solid color-mix(in srgb, ${tokens.systemAccent} 50%, transparent)`
                        }}
                    />
                </div>
            )}
        </div>
    );
}

// ── pieces ──────────────────────────────────────────────────────────────────────────

interface DividerProps {
    readonly info: SplitDividerInfo;
    readonly dragging: boolean;
    readonly onPointerDown: (info: SplitDividerInfo, event: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * The grab strip is `dividerHitRect` (a 14 px band: the 2 px bar plus `DIVIDER_HIT_INSET` = 6 px
 * into each neighbour); the visible bar is drawn inside it at the exact `info.rect` offset, so
 * the bar's absolute position does not depend on the inset at all.
 *
 * SPACING-REVIEW S48 (owner-directed): the band was 10 px, `SplitDividerView.swift:21-25`'s own
 * `inset(by: -4)`. `@kelpi/core`'s `DIVIDER_HIT_INSET` carries the reasoning and the parity value.
 */
function Divider({ info, dragging, onPointerDown }: DividerProps): ReactElement {
    const hit = dividerHitRect(info.rect);
    const horizontal = info.direction === 'horizontal';
    return (
        <div
            data-testid={`divider-${info.id}`}
            data-split-path={info.id}
            data-direction={info.direction}
            data-dragging={dragging ? 'true' : 'false'}
            role="separator"
            aria-orientation={horizontal ? 'vertical' : 'horizontal'}
            className="touch-none"
            style={{ ...absolute(hit), zIndex: 10, cursor: horizontal ? 'col-resize' : 'row-resize' }}
            onPointerDown={(event) => onPointerDown(info, event)}
        >
            <div
                aria-hidden="true"
                style={{
                    position: 'absolute',
                    left: `${DIVIDER_HIT_INSET}px`,
                    top: `${DIVIDER_HIT_INSET}px`,
                    width: `${info.rect.width}px`,
                    height: `${info.rect.height}px`,
                    // `SplitDividerView.swift:18-20` is TWO layers, not one: `Rectangle()`
                    // filled with `chromeTheme.divider`, and then an unconditional `.overlay(…)`
                    // — `Color.accentColor.opacity(0.5)` while dragging, `Color.secondary
                    // .opacity(0.2)` at rest. Both are alpha-composited over the divider fill,
                    // which is exactly `color-mix(… over divider)`.
                    //
                    // M13: the dragged tint is the macOS system accent, not the chrome theme's
                    // `accent`. See `tokens.ts` for the seam and the standing divergence.
                    //
                    // L35: the RESTING layer had been dropped, so every divider in the port sat a
                    // step darker and flatter than the shipped app's. `.secondary` transcribes as
                    // the secondary text token, the same way the empty grid transcribes
                    // `.quaternary` as a percentage of the primary one.
                    background: dragging
                        ? `color-mix(in srgb, ${tokens.systemAccent} 50%, ${tokens.divider})`
                        : `color-mix(in srgb, ${tokens.textSecondary} 20%, ${tokens.divider})`
                }}
            />
        </div>
    );
}

interface ResizeBadgeProps {
    readonly paneID: string;
    readonly text: string;
}

/** Centered, non-interactive `<cols> x <rows>` chip shown while anything is resizing. */
function ResizeBadge({ paneID, text }: ResizeBadgeProps): ReactElement {
    return (
        <div
            data-testid={`pane-size-${paneID}`}
            aria-hidden="true"
            // M18: `ResizeDimensionsOverlay.swift:15-16` is `.padding(.horizontal, 12)` /
            // `.padding(.vertical, 6)`; the port's `px-2 py-1` drew the chip a third smaller than
            // the shipped one. `rounded-md` is already the Swift's `cornerRadius: 6`.
            //
            // §S19: `whitespace-nowrap`. `PaneGridView.swift:387-391` mounts this in an
            // `.overlay { }` over the whole pane rect, so SwiftUI proposes the pane's FULL width
            // and the chip stays one line however narrow the pane is. A shrink-to-fit absolute
            // box with only `left: 50%` gets (containing block − left) as its available width —
            // half the pane — so `16 x 49` wrapped to two lines at a 132.25 px pane (66.13 ×
            // 48.39 measured) and three below ~84. The chip now keeps its natural one-line box
            // and overhangs a very narrow pane exactly as the SwiftUI overlay does.
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md px-3 py-1.5 font-mono text-[13px] font-medium"
            style={{
                background: tokens.headerBackground,
                color: tokens.textPrimary,
                // M18: `.shadow(color: .black.opacity(0.25), radius: 4, y: 2)` (`:19`). The blur
                // was already the right conversion (a SwiftUI shadow radius is ~half a CSS blur
                // radius); the alpha was 0.35, which drew a heavier drop than the original.
                boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                zIndex: 15
            }}
        >
            {text}
        </div>
    );
}

interface EmptyGridProps {
    readonly onCreatePane?: (() => void) | undefined;
}

/**
 * shell-ui.md §4: faint terminal glyph, "No panes", and a Return-activated New Pane button.
 *
 * M16 — the glyph and the label are **two tones**, not one. `PaneGridView.swift:492-500` paints
 * the 36 pt terminal `.quaternary` (AppKit's quaternaryLabelColor: the label colour at 10%) and
 * the "No panes" text `.secondary` at `.title3`. The port had both at `textTertiary`/`text-sm`,
 * which made the ghost glyph read as a solid icon and left the label no more weight than a hint.
 */
function EmptyGrid({ onCreatePane }: EmptyGridProps): ReactElement {
    return (
        <div
            data-testid="pane-grid-empty"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3"
            /* §N17: the placeholder carries its own fill, because the Swift's does —
               `PaneGridView.swift:508-510`: "the 'No panes' placeholder fills an empty grid (no
               pane bodies), so it reads as a window gap → chrome windowBackground". It used to
               borrow the grid container's, which no longer paints one. */
            style={{ background: tokens.windowBackground, color: tokens.textSecondary }}
        >
            {/* `.quaternary` transcribed literally: the primary label colour at 10%. */}
            <span
                data-testid="pane-grid-empty-glyph"
                style={{ color: `color-mix(in srgb, ${tokens.textPrimary} 10%, transparent)` }}
            >
                <Icon name="terminal" size={36} />
            </span>
            {/* macOS `.title3` is **15 pt** (the macOS type ramp, not iOS's 20). */}
            <span data-testid="pane-grid-empty-label" className="text-[15px]">
                No panes
            </span>
            <button
                type="button"
                data-testid="pane-grid-new-pane"
                autoFocus
                className="rounded px-3 py-1 text-sm"
                style={{ background: tokens.surfaceBackground, color: tokens.textPrimary, border: `1px solid ${tokens.divider}` }}
                onClick={() => onCreatePane?.()}
            >
                New Pane
            </button>
        </div>
    );
}

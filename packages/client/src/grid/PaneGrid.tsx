/**
 * The pane grid (shell-ui.md §4, pane-layout.md §7).
 *
 * A measured container that paints the active workspace's `PaneLayout` as absolutely
 * positioned pane wrappers, divider grab strips, and the transient overlays that direct
 * manipulation needs (drop zones, resize badges).
 *
 * Three invariants shape the whole component:
 *
 * 1. **No layout maths here.** Every rect comes from `@nex/core/layout` — `paneFrames`,
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
    type ReactElement
} from 'react';

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
} from '@nex/core/layout';

import {
    dividerAtPoint,
    dividerCommit,
    dividerDragActivated,
    ratioForDividerDrag,
    throttleTrailing,
    type Throttled
} from './divider';
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
    readonly headerHeight?: number | undefined;
    /** Fixed size instead of measuring — tests and any non-DOM host. */
    readonly size?: PaneGridSize | undefined;
    /** Terminal cols/rows for the resize badge; falls back to pixels when absent. */
    readonly getPaneDimensions?: ((paneID: string) => PaneDimensions | null | undefined) | undefined;
    readonly ratioCommitIntervalMs?: number | undefined;
    readonly resizeBadgeLingerMs?: number | undefined;
    /** Overrides the 600 ms focus-dwell delay (shell-ui.md §4.6). */
    readonly dwellMs?: number | undefined;
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
            const width = element.clientWidth;
            const height = element.clientHeight;
            setMeasured((current) =>
                current.width === width && current.height === height ? current : { width, height }
            );
        };
        read();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', read);
            return () => window.removeEventListener('resize', read);
        }
        const observer = new ResizeObserver(read);
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

    return (
        <div
            ref={containerRef}
            data-testid="pane-grid"
            data-resizing={resizing ? 'true' : 'false'}
            className={`relative h-full w-full overflow-hidden${className === undefined ? '' : ` ${className}`}`}
            style={{ background: tokens.windowBackground }}
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
                            zIndex: visible ? (focused ? 2 : 1) : 0,
                            background: tokens.windowBackground
                        }}
                        // Capture phase, on the WRAPPER: a press anywhere in the pane — header,
                        // body, a header button — focuses it (shell-ui.md §4.1). The header is
                        // deliberately not given `onFocusPane` as well, or every click would
                        // report focus twice.
                        onPointerDownCapture={() => onFocusPane?.(pane.id)}
                        onPointerEnter={() => onPaneEnter(pane.id)}
                        onPointerLeave={cancelHover}
                    >
                        <PaneHeader
                            pane={pane}
                            focused={focused}
                            zoomed={zoomed === pane.id}
                            zoomAvailable={zoomAvailable}
                            syncActive={syncActive}
                            syncExcluded={excluded.has(pane.id)}
                            homeDirectory={homeDirectory}
                            height={headerHeight}
                            onHeaderPointerDown={startPaneDrag}
                            onClosePane={props.onClosePane}
                            onRenamePane={props.onRenamePane}
                            onSplitPane={props.onSplitPane}
                            onToggleZoom={props.onToggleZoom}
                            onToggleMarkdownEdit={props.onToggleMarkdownEdit}
                            onRefreshDiff={props.onRefreshDiff}
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
                        <FocusRing focused={focused} />
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
                    data-testid="drop-zone-overlay"
                    data-zone={dropTarget.zone}
                    data-target={dropTarget.paneID}
                    aria-hidden="true"
                    className="pointer-events-none"
                    style={{
                        ...absolute(dropRect),
                        zIndex: 20,
                        borderRadius: 4,
                        background: `color-mix(in srgb, ${tokens.accent} 20%, transparent)`,
                        border: `2px solid color-mix(in srgb, ${tokens.accent} 50%, transparent)`
                    }}
                />
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
 * The grab strip is `dividerHitRect` (a 10 px band: the 2 px bar plus 4 px into each
 * neighbour); the visible bar is drawn inside it at the exact `info.rect` offset.
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
                    background: dragging
                        ? `color-mix(in srgb, ${tokens.accent} 50%, ${tokens.divider})`
                        : tokens.divider
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
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md px-2 py-1 font-mono text-[13px] font-medium"
            style={{
                background: tokens.headerBackground,
                color: tokens.textPrimary,
                boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
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

/** shell-ui.md §4: faint terminal glyph, "No panes", and a Return-activated New Pane button. */
function EmptyGrid({ onCreatePane }: EmptyGridProps): ReactElement {
    return (
        <div
            data-testid="pane-grid-empty"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3"
            style={{ color: tokens.textTertiary }}
        >
            <Icon name="terminal" size={36} />
            <span className="text-sm">No panes</span>
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

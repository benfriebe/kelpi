/**
 * The sidebar's drag handle (§WS-002 / §APP-065).
 *
 * The shipped app puts a zero-width `Color.clear` on the sidebar's trailing edge with a −3 pt
 * content-shape inset, giving a 6 pt hit strip that shows the left-right resize cursor and
 * drags the width between 180 and 300 pt, starting at 220. Same numbers here, with the same
 * invisible strip straddling the edge.
 *
 * One deliberate fix, the same one the pane dividers got (PLAN.md "deliberate fixes"): the
 * shipped gesture adds `translation.width` to the CURRENT width on every change event, so the
 * delta compounds across the drag and the sidebar runs away from the pointer. This computes
 * from the width captured when the gesture started, so the edge tracks the cursor exactly.
 *
 * The width is client-local UI state — the Swift app keeps it in a view-local `@State` that
 * does not survive a relaunch. This one persists it in `localStorage`, which is strictly
 * better and still per-client: it is not daemon state, so a second window is free to differ.
 */

import { useRef, type ReactElement } from 'react';

import { tokens } from './tokens';

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 300;
export const SIDEBAR_DEFAULT_WIDTH = 220;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'kelpi.sidebar.width';

/** Anything outside 180–300 (or not a number at all) lands on the nearest legal width. */
export function clampSidebarWidth(value: number): number {
    if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

/** Reads the persisted width; a missing or corrupt value is the 220 default, never a throw. */
export function readStoredSidebarWidth(storage?: Storage | null | undefined): number {
    const store = storage === undefined ? globalThis.localStorage : storage;
    if (store === null || store === undefined) return SIDEBAR_DEFAULT_WIDTH;
    try {
        const raw = store.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
        if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
        return clampSidebarWidth(Number.parseFloat(raw));
    } catch {
        return SIDEBAR_DEFAULT_WIDTH;
    }
}

export function storeSidebarWidth(width: number, storage?: Storage | null | undefined): void {
    const store = storage === undefined ? globalThis.localStorage : storage;
    if (store === null || store === undefined) return;
    try {
        store.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)));
    } catch {
        // A private-mode / quota failure must never break a drag.
    }
}

export interface SidebarResizerProps {
    /** The width at the moment a drag starts; every move is measured against this snapshot. */
    readonly width: number;
    readonly onResize: (width: number) => void;
    /** Fired once when the pointer is released, so assembly can persist the final width. */
    readonly onCommit?: ((width: number) => void) | undefined;
    /**
     * Fired once when the pointer goes DOWN, before the first move.
     *
     * Assembly uses it to take §WS-001's slide transition off the slot for the length of the
     * gesture: the slide animates the same `width` this handle writes, so an always-on
     * transition turns a drag into a 250 ms chase (`chrome/sidebar-reveal.ts` ▸
     * `sidebarSlideStyle`'s `animate`). The first move must already be un-animated, which is
     * why this is its own callback rather than "the first `onResize`".
     */
    readonly onResizeStart?: (() => void) | undefined;
}

export function SidebarResizer(props: SidebarResizerProps): ReactElement {
    const drag = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);

    const move = (event: PointerEvent): void => {
        const state = drag.current;
        if (state === null) return;
        const next = clampSidebarWidth(state.startWidth + (event.clientX - state.startX));
        state.latest = next;
        props.onResize(next);
    };

    const end = (): void => {
        const state = drag.current;
        drag.current = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        document.body.style.removeProperty('cursor');
        if (state !== null) props.onCommit?.(state.latest);
    };

    return (
        <div
            data-testid="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={props.width}
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            /* Zero-width in layout, 6 px of hit area straddling the edge — the shipped app's
               `contentShape(Rectangle().inset(by: -3))`, which is why the negative margin. */
            className="relative z-10 w-0 shrink-0 cursor-col-resize"
            style={{ marginLeft: -3, marginRight: -3, width: 6, background: 'transparent' }}
            onPointerDown={(event) => {
                // Secondary buttons only: `> 0` rather than `!== 0` so a synthesized event
                // without a `button` field (jsdom, some remote-input paths) still drags.
                if (event.button > 0) return;
                event.preventDefault();
                drag.current = { startX: event.clientX, startWidth: props.width, latest: props.width };
                // Before any move: tell assembly a gesture owns the width now, so §WS-001's
                // slide transition comes off the slot for the length of it.
                props.onResizeStart?.();
                // The pointer leaves the 6 px strip immediately; the listeners are on the window
                // so the drag keeps tracking, and the cursor stays a resize cursor throughout.
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', end);
                document.body.style.setProperty('cursor', 'col-resize');
            }}
            /*
             * UI-FIDELITY L105 — there is no double-click reset.
             *
             * `ContentView.swift:630-646` hangs exactly two things off this handle: `.onHover`
             * (the cursor) and a `DragGesture`. The port added a double-click that snapped the
             * sidebar back to 220, an affordance the shipped app never advertises and never
             * performs — and one a user can trigger by accident mid-drag. Removed rather than
             * kept: everything else about the handle already matched.
             */
        >
            <div className="pointer-events-none h-full w-px" style={{ background: tokens.divider, marginLeft: 3 }} />
        </div>
    );
}

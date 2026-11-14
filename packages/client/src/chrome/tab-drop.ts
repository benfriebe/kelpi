/**
 * A pane dragged onto the title bar's tabs (workspace-feature.md §12, shell-ui.md §3.3).
 *
 * The pane grid owns the gesture: it holds the pointer capture from the pane header and decides
 * what a release does. The tab bar owns the drawing: which tab is the target, where a new tab
 * would go, and the "Drop here for a new tab" slot that appears in the bar's empty space. This
 * module is the one fact they share, plus the hit test the grid asks while the pointer moves.
 * The title bar also reads `dragging`, because the window's drag handle has to be off for as
 * long as a pane is in flight (the release would otherwise land on the OS's title bar).
 */

import type { DropZone } from '@kelpi/core/layout';
import { useSyncExternalStore } from 'react';

/**
 * What a release does: into an existing tab, or a new tab at a bar position. `beside` is a
 * release over the grid of a tab the drag opened on its way (spring-loading, below): the pane
 * goes in at that zone of that pane.
 */
export type TabDropTarget =
    | { readonly kind: 'tab'; readonly tabID: string; readonly beside?: { readonly paneID: string; readonly zone: DropZone } | undefined }
    | { readonly kind: 'slot'; readonly index: number };

export interface TabDropState {
    /** A pane is being dragged (past the grid's threshold). */
    readonly dragging: boolean;
    readonly target: TabDropTarget | null;
}

const IDLE: TabDropState = { dragging: false, target: null };

let current: TabDropState = IDLE;
const listeners = new Set<() => void>();

function sameTarget(a: TabDropTarget | null, b: TabDropTarget | null): boolean {
    if (a === null || b === null) return a === b;
    if (a.kind === 'tab' && b.kind === 'tab') return a.tabID === b.tabID;
    if (a.kind === 'slot' && b.kind === 'slot') return a.index === b.index;
    return false;
}

export function setTabDropState(next: TabDropState): void {
    if (next.dragging === current.dragging && sameTarget(next.target, current.target)) return;
    current = next.dragging ? next : IDLE;
    // A spring belongs to the drag that opened it, so it ends with that drag whatever ends it:
    // a later, unrelated gesture can never land in (or go back from) a tab this one opened.
    if (!current.dragging) spring = null;
    for (const listener of [...listeners]) listener();
}

export function tabDropState(): TabDropState {
    return current;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useTabDrop(): TabDropState {
    return useSyncExternalStore(subscribe, tabDropState, tabDropState);
}

function paneInFlight(): boolean {
    return current.dragging;
}

/**
 * True while a pane is being dragged. A view that would take the window's keyboard (a web page,
 * a plugin frame) waits for the drop instead, so Escape still reaches the drag. A boolean, so a
 * subscriber re-renders when a drag starts or ends, not at every target it passes.
 */
export function usePaneInFlight(): boolean {
    return useSyncExternalStore(subscribe, paneInFlight, paneInFlight);
}

/**
 * How close to a tab's side edge counts as "between tabs": a new tab there, rather than this
 * tab. Small, because the tab itself is the bigger and likelier target.
 */
export const TAB_EDGE_SLOT_PX = 8;

/**
 * What is under `(x, y)` in the tab bar, read off the DOM: a tab (`data-workspace-tab-id`, its
 * edges are slots either side of it), or a marked slot (`data-tab-drop-slot`, the new-tab slot
 * the bar draws during a drag). Null anywhere else, which leaves the drop to the grid.
 */
export function tabDropTargetAt(x: number, y: number): TabDropTarget | null {
    if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') return null;
    for (const element of document.elementsFromPoint(x, y)) {
        const slot = element.closest('[data-tab-drop-slot]');
        if (slot !== null) {
            const index = Number(slot.getAttribute('data-tab-drop-slot'));
            return Number.isInteger(index) ? { kind: 'slot', index } : null;
        }
        const tab = element.closest('[data-workspace-tab-id]');
        if (tab !== null) {
            const tabID = tab.getAttribute('data-workspace-tab-id') ?? '';
            const index = Number(tab.getAttribute('data-tab-index'));
            const box = tab.getBoundingClientRect();
            if (Number.isInteger(index) && box.width > TAB_EDGE_SLOT_PX * 3) {
                if (x - box.left < TAB_EDGE_SLOT_PX) return { kind: 'slot', index };
                if (box.right - x < TAB_EDGE_SLOT_PX) return { kind: 'slot', index: index + 1 };
            }
            return tabID === '' ? null : { kind: 'tab', tabID };
        }
    }
    return null;
}

/*
 * The other direction: a TAB dragged out of the bar onto a workspace row in the sidebar. The bar
 * owns that gesture; the row only draws itself as the target, so the one fact shared is which
 * workspace the pointer is over (null while it is over none, or no tab is in flight).
 */
let tabDragWorkspace: string | null = null;
const workspaceListeners = new Set<() => void>();

export function setTabDragWorkspace(workspaceID: string | null): void {
    if (workspaceID === tabDragWorkspace) return;
    tabDragWorkspace = workspaceID;
    for (const listener of [...workspaceListeners]) listener();
}

function subscribeWorkspace(listener: () => void): () => void {
    workspaceListeners.add(listener);
    return () => {
        workspaceListeners.delete(listener);
    };
}

function currentTabDragWorkspace(): string | null {
    return tabDragWorkspace;
}

/** The workspace a dragged tab would move to if released now, or null. */
export function useTabDragWorkspace(): string | null {
    return useSyncExternalStore(subscribeWorkspace, currentTabDragWorkspace, currentTabDragWorkspace);
}

/*
 * Spring-loading (workspace-feature.md §12, shell-ui.md §3.3): a pane held over a tab that is
 * not on screen for `TAB_SPRING_MS` opens that tab, and the drag goes on in its grid. The bar
 * times the hold, draws it and shows the tab; the grid reads this at the end of the drag, so a
 * release over the grid lands in the tab now on screen and a cancel shows the tab the drag
 * started in again.
 */
export const TAB_SPRING_MS = 600;

export interface TabSpring {
    /** The tab the drag started in. */
    readonly originTabID: string;
    /** The tab the drag opened. */
    readonly tabID: string;
    /**
     * False from the moment the bar asks for the tab until the window actually shows it (a
     * round trip to the daemon). Until then the grid still draws the tab the drag started in,
     * so it offers no drop beside any of those panes. Absent counts as shown.
     */
    readonly shown?: boolean | undefined;
    /** Show the tab the drag started in again. */
    readonly returnHome: () => void;
}

let spring: TabSpring | null = null;

/** Only while a pane is in flight: a spring with no drag running is dropped on the spot. */
export function setTabSpring(next: TabSpring | null): void {
    spring = next !== null && !current.dragging ? null : next;
}

export function tabSpring(): TabSpring | null {
    return spring;
}

/** The pane drag is over: a cancelled one goes back to the tab it started in. */
export function endTabSpring(cancelled: boolean): void {
    const ended = spring;
    spring = null;
    if (cancelled && ended !== null) ended.returnHome();
}

/** The spring's tab is on screen now, so the grid's drop zones are that tab's panes. */
export function markTabSpringShown(tabID: string): void {
    if (spring !== null && spring.tabID === tabID && spring.shown === false) spring = { ...spring, shown: true };
}

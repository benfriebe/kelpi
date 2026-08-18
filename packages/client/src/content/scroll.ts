/**
 * The shared scroll-position store (content-panes.md §9, port note 11).
 *
 * Client-side, in-memory, keyed by pane id and deliberately NOT persisted. Because it outlives
 * the views, a pane keeps its place across a ⌘E view↔edit toggle (two different components), a
 * workspace switch (the grid unmounts the pane's body) and a content reload.
 *
 * Two numbers per pane, matching the doc's precedence rule (§3.11): `top` is the absolute
 * scroll offset, restored after a *same-mount reload* (a file change, a font change, a theme
 * swap — the document is replaced but the view is not), and `fraction` is the 0..1 position,
 * restored on a *fresh build* where the new document's height is not the old one's.
 */

export interface ScrollPosition {
    /** Absolute offset in CSS pixels. */
    readonly top: number;
    /** 0..1 of max scroll. */
    readonly fraction: number;
}

export interface ScrollStore {
    get(paneID: string): ScrollPosition | null;
    set(paneID: string, position: ScrollPosition): void;
    clear(paneID: string): void;
    readonly size: number;
}

export function createScrollStore(): ScrollStore {
    const positions = new Map<string, ScrollPosition>();
    return {
        get(paneID) {
            return positions.get(paneID) ?? null;
        },
        set(paneID, position) {
            const top = Number.isFinite(position.top) ? Math.max(0, position.top) : 0;
            const raw = Number.isFinite(position.fraction) ? position.fraction : 0;
            positions.set(paneID, { top, fraction: Math.min(1, Math.max(0, raw)) });
        },
        clear(paneID) {
            positions.delete(paneID);
        },
        get size() {
            return positions.size;
        }
    };
}

/**
 * The process-wide store every content view uses by default. Components take a `scrollStore`
 * prop so a test can hand them an isolated one.
 */
export const contentScrollStore: ScrollStore = createScrollStore();

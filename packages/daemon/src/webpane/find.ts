/**
 * Find-in-page, daemon half (web-pane.md §10; WEB-059…WEB-065).
 *
 * The *marking* is entirely page-side — `webhost/scripts.ts`'s `__nexWebFind` wraps matches in
 * `<mark class="nex-webfind-match">` and answers `{total, current}` — and the host already
 * exposes it as the `find` RPC. What was missing is everything between a person pressing ⌘F and
 * that RPC, which is what this module is:
 *
 *   - **which needle a pane is currently marked for** (`remember` / `forget`). A web pane's find
 *     bar is not per-client chrome the way a markdown pane's is: the marks live in a page the
 *     *host* owns, so two windows looking at the same pane are looking at the same marks. The
 *     needle is therefore daemon state, and every client reads the same counter.
 *   - **WEB-065**: a completed navigation rebuilds the DOM *and* `window.__nexWebFind`, so the
 *     remembered needle has to be re-applied once the new document reports itself. Closing the
 *     find (`clear`) forgets it, which is what stops later navigations from re-marking.
 *   - **WEB-064**: switching or closing a tab while the bar is open clears the outgoing tab and
 *     re-runs the needle on the incoming one.
 *   - **WEB-063**: a result that comes back for a tab that is no longer active is *stale*. The
 *     reply carries the tab it was measured on so the consumer can drop it, which is what stops
 *     the outgoing tab's `clear()` (total 0) from clobbering the incoming tab's real count.
 *
 * Transient by construction: a needle is a live UI position, never persisted (§15.1).
 */

/** What one pane is currently marked for. */
export interface WebFindSession {
    readonly tabID: string;
    readonly needle: string;
}

export const FIND_ACTIONS = ['search', 'next', 'prev', 'clear'] as const;
export type WebFindAction = (typeof FIND_ACTIONS)[number];

export function isFindAction(value: string): value is WebFindAction {
    return (FIND_ACTIONS as readonly string[]).includes(value);
}

export interface WebFindState {
    /** A search/next/prev landed: this pane's page is marked for `needle` on `tabID`. */
    remember(paneID: string, tabID: string, needle: string): void;
    /** The bar closed (or the needle emptied): later navigations must stop re-marking. */
    forget(paneID: string): void;
    sessionOf(paneID: string): WebFindSession | null;
    /** The pane went away. */
    disposePane(paneID: string): void;
}

export function createWebFindState(): WebFindState {
    const sessions = new Map<string, WebFindSession>();
    return {
        remember(paneID, tabID, needle) {
            if (needle === '') {
                sessions.delete(paneID);
                return;
            }
            sessions.set(paneID, { tabID, needle });
        },
        forget(paneID) {
            sessions.delete(paneID);
        },
        sessionOf(paneID) {
            return sessions.get(paneID) ?? null;
        },
        disposePane(paneID) {
            sessions.delete(paneID);
        }
    };
}

/** The `{total, current}` an envelope carries, defaulted the way the page defaults them. */
export function findCountsOf(envelope: Record<string, unknown>): { total: number; current: number } {
    const total = typeof envelope['total'] === 'number' ? envelope['total'] : 0;
    const current = typeof envelope['current'] === 'number' ? envelope['current'] : -1;
    return { total, current };
}

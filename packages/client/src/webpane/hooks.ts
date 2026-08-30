/**
 * The two subscriptions the web-pane chrome needs, as one hook.
 *
 * Favourites and batch sessions are daemon state that the delta stream does not carry, so each
 * one is a **broadcast plus a read**: the read seeds this client (a window that opened after the
 * fact still sees the list), and the broadcast keeps every window in step from then on. A
 * reconnect re-reads, because a daemon restart can have a different list.
 */

import { useEffect, useRef, useState } from 'react';

import type { WebPaneCommands } from './commands';
import {
    parseBatchMessage,
    parseBatchSession,
    parseFavourites,
    parseFavouritesMessage,
    parseNavStateMessage,
    type WebBatchSession,
    type WebFavourite,
    type WebNavState
} from './state';

/** The slice of `KelpiConnection` this hook uses — a fixture satisfies it in tests. */
export interface WebUIConnection {
    on(event: 'message', listener: (message: Record<string, unknown>) => void): () => void;
    on(event: 'status', listener: (status: string) => void): () => void;
}

export interface WebPaneUIState {
    readonly favourites: readonly WebFavourite[];
    /** Per pane; a pane with no live batch is absent (not `null`), so the panel is not drawn. */
    readonly batches: Readonly<Record<string, WebBatchSession>>;
    /**
     * WEB-032/WEB-033/WEB-034: the last loading + history report per **tab**, keyed
     * `<paneID>:<tabID>`. Absent means "never heard from", which the chrome draws as idle.
     */
    readonly navStates: Readonly<Record<string, WebNavState>>;
}

/** The `navStates` key: pane and tab together, because WEB-034 is a per-tab rule. */
export function navStateKey(paneID: string, tabID: string | null): string {
    return `${paneID}:${tabID ?? ''}`;
}

function replyFavourites(reply: unknown): readonly WebFavourite[] | null {
    if (typeof reply !== 'object' || reply === null) return null;
    const record = reply as Record<string, unknown>;
    if (record['ok'] !== true) return null;
    return parseFavourites(record['favourites']);
}

/** The `batch` field of any `web-batch-*` reply (they all carry the post-mutation session). */
export function replyBatch(reply: unknown): WebBatchSession | null {
    if (typeof reply !== 'object' || reply === null) return null;
    const record = reply as Record<string, unknown>;
    if (record['ok'] !== true) return null;
    return parseBatchSession(record['batch']);
}

export function useWebPaneUI(options: {
    readonly connection: WebUIConnection;
    readonly commands: WebPaneCommands;
    /** Panes whose batch state should be read on mount / reconnect (the visible web panes). */
    readonly webPaneIDs: readonly string[];
}): WebPaneUIState {
    const { connection, commands } = options;
    const [favourites, setFavourites] = useState<readonly WebFavourite[]>([]);
    const [batches, setBatches] = useState<Readonly<Record<string, WebBatchSession>>>({});
    const [navStates, setNavStates] = useState<Readonly<Record<string, WebNavState>>>({});

    // Broadcasts. One listener for both, because they arrive on the same channel and the
    // parsers are the discriminator.
    useEffect(() => {
        const off = connection.on('message', (message) => {
            const list = parseFavouritesMessage(message);
            if (list !== null) {
                setFavourites(list);
                return;
            }
            const nav = parseNavStateMessage(message);
            if (nav !== null) {
                setNavStates((current) => ({ ...current, [navStateKey(nav.paneID, nav.tabID)]: nav }));
                return;
            }
            const batch = parseBatchMessage(message);
            if (batch === null) return;
            setBatches((current) => {
                const next = { ...current };
                if (batch.batch === null) delete next[batch.paneID];
                else next[batch.paneID] = batch.batch;
                return next;
            });
        });
        return off;
    }, [connection]);

    // The seed read, re-run on every (re)connect.
    useEffect(() => {
        let cancelled = false;
        const load = (): void => {
            void commands
                .favouritesList()
                .then((reply) => {
                    const list = replyFavourites(reply);
                    if (!cancelled && list !== null) setFavourites(list);
                })
                // A seed read that never lands is not an error worth surfacing — the most
                // common cause IS the disconnect this effect re-runs on. Without the catch it
                // is an UNHANDLED rejection: `void` discards the value, not the rejection, so
                // every teardown mid-flight logged one (191 of them across the client suite,
                // enough to fail the run on unhandled errors alone).
                .catch(() => undefined);
        };
        load();
        const off = connection.on('status', (status) => {
            if (status === 'connected') load();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [connection, commands]);

    // A batch survives a client reload (it is daemon state), so an attaching window has to ask.
    const paneKey = options.webPaneIDs.join(',');
    useEffect(() => {
        let cancelled = false;
        for (const paneID of paneKey === '' ? [] : paneKey.split(',')) {
            void commands
                .batchState(paneID)
                .then((reply) => {
                    const batch = replyBatch(reply);
                    if (cancelled || batch === null) return;
                    setBatches((current) => ({ ...current, [paneID]: batch }));
                })
                // Same rule as the seed read above: a disconnect mid-flight is the ordinary
                // case, and an uncaught rejection here fails the whole test run.
                .catch(() => undefined);
        }
        return () => {
            cancelled = true;
        };
    }, [paneKey, commands]);

    return { favourites, batches, navStates };
}

// ── WEB-002: a blank pane / blank tab claims the URL bar ─────────────────────────────

/** What the rule needs to know about one web pane, as the grid already knows it. */
export interface BlankURLTarget {
    readonly paneID: string;
    /** The active tab's id, or null for a pane with no tab at all. */
    readonly activeTabID: string | null;
    readonly activeURL: string;
}

/**
 * The signature that decides whether a target is NEW: pane + which tab is active.
 *
 * A tab's URL filling in (the load landing) must not re-bump — only the arrival of a pane, or
 * of a tab, can. That is exactly the Swift split: `openWebPanePath` and `webPaneOpenNewTab`
 * bump `webPaneURLFocusTokens` at creation time and nothing else ever does.
 */
function blankTargetKey(target: BlankURLTarget): string {
    return `${target.paneID}:${target.activeTabID ?? ''}`;
}

/**
 * WEB-002: a web pane (or new tab) that arrives with a **blank** URL hands the caret to the URL
 * bar so the user can type immediately; one that arrives with a URL is loading a page, so focus
 * belongs to the page instead.
 *
 * Written as a pure "which targets are new" diff so the rule is testable without a socket, and
 * so a re-render caused by anything else (a title arriving, a batch broadcast, the seconds
 * ticker) cannot move the user's caret.
 */
export function useBlankWebPaneURLFocus(
    targets: readonly BlankURLTarget[],
    focusURLBar: (paneID: string) => void,
    attached = true
): void {
    const seen = useRef<Set<string> | null>(null);
    useEffect(() => {
        /**
         * §N35: the adoption pass is the client's FIRST SNAPSHOT, not its first render.
         *
         * The paragraph below has been the intent since WEB-002 was written, and until this row
         * it was not what the code did. The first effect run happens before any state has
         * arrived, so `previous` was recorded as an EMPTY set — and every pane the snapshot then
         * delivered looked like one that had just been opened. Measured on a client reload
         * (`docs/audit/n33-j-n30-mount-claim/reload-focus-trace.mjs`): the URL bar of a RESTORED
         * blank tab took the caret at +35 ms, in a window where nobody had opened anything.
         *
         * `attached` is the daemon's `hasSnapshot`. Until it is true this hook records nothing,
         * so what the first snapshot brings is what gets adopted, and only what arrives after
         * that is an opening — the event the Swift's `webPaneURLFocusTokens` bumps on.
         */
        if (!attached) {
            seen.current = null;
            return;
        }
        const previous = seen.current;
        const next = new Set(targets.map(blankTargetKey));
        seen.current = next;
        // First pass: adopt whatever is on screen without stealing focus. A client that
        // reloaded (or attached to a running daemon) is not "opening" these panes, and the
        // Swift app only ever bumped on the action that created one.
        if (previous === null) return;
        for (const target of targets) {
            if (previous.has(blankTargetKey(target))) continue;
            if (target.activeURL.trim() !== '') continue;
            focusURLBar(target.paneID);
        }
    }, [attached, targets, focusURLBar]);
}

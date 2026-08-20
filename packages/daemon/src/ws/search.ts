/**
 * `terminal-search` — the WS verb behind ⌘F over a terminal pane.
 *
 * WS-only for the usual reason (`WS_ONLY_COMMANDS`): a find bar is a direct-manipulation
 * gesture the `nex` CLI has no vocabulary for, and giving it a wire verb would be a
 * compatibility surface owed to the Swift CLI forever. It lives on its own channel rather than
 * inside `handleWsOnlyCommand` because, like the content verbs, it is **asynchronous** — the
 * buffer read has to flush `@xterm/headless`'s write queue first, or a needle typed a
 * heartbeat after the output it is looking for finds nothing.
 *
 * One verb, an `action` field (the shape the content find bar uses):
 *
 *   toggle  `workspace_id`                      → open/close the bar (the reducer's own rule)
 *   set     `pane_id`/`workspace_id`, `needle`  → new needle; counts recomputed
 *   next    …                                   → advance the selection (wraps)
 *   prev    …                                   → step back (wraps)
 *   close   `workspace_id`                      → clear the bar and every count
 *   status  `workspace_id`                      → read-only snapshot (no mutation)
 *
 * **The daemon owns the coordinates.** `searchingPaneID` / `searchNeedle` / `searchTotal` /
 * `searchSelected` are workspace state (`store/reducers/layout.ts`) and ride the delta stream
 * as part of `workspace-upserted`, so every attached window shows the same "3/17" without
 * asking. The reply carries the one thing that is NOT state — where the selected match sits —
 * because a match position is a fact about right now, and a stale one would scroll a client to
 * the wrong row.
 *
 * **Which pane is searched** is the reducer's decision, never this file's: `canHostSearch`
 * admits shell, web, and non-editing markdown panes (workspace-feature.md §7.14). This channel
 * only computes counts for a **shell** pane — a markdown/diff pane's find runs inside its own
 * sandboxed frame (`client/src/content/bridge.ts`) and a web pane's runs in the host's
 * `webContents`, so for those the reply reports `total: null` and the client's own backend
 * counts. That split is exactly the Swift one (`WorkspaceFeature.swift:1742-1835` routes by
 * pane type before it ever reaches the surface).
 *
 * Selection semantics, chosen and stated rather than inherited: matches are ordered top → bottom
 * and both directions wrap. With nothing selected yet, `next` lands on the FIRST match and
 * `prev` on the LAST — browser find-bar behaviour, and the reason the counter reads `-/N` until
 * you navigate (TERM-118).
 */

import type { JsonObject } from '@nex/protocol';

import type { TerminalMatch } from '../term/search.js';
import { visiblePane, workspaceByID, workspaceContainingVisiblePane } from '../store/derived.js';
import type { DaemonState, WorkspaceState } from '../store/types.js';
import type { NexDomainStore } from './sync.js';

export const TERMINAL_SEARCH_COMMANDS = ['terminal-search'] as const;
export type TerminalSearchCommand = (typeof TERMINAL_SEARCH_COMMANDS)[number];

export function isTerminalSearchCommand(command: string): command is TerminalSearchCommand {
    return (TERMINAL_SEARCH_COMMANDS as readonly string[]).includes(command);
}

export const TERMINAL_SEARCH_ACTIONS = ['toggle', 'set', 'next', 'prev', 'close', 'status'] as const;
export type TerminalSearchAction = (typeof TERMINAL_SEARCH_ACTIONS)[number];

/** The slice of the terminal state service this channel needs (so tests can stub it). */
export interface TerminalSearchBackend {
    searchAsync(
        paneID: string,
        needle: string,
        options: { caseSensitive?: boolean | undefined }
    ): Promise<readonly TerminalMatch[]>;
}

export interface TerminalSearchChannel {
    run(payload: Record<string, unknown>): Promise<JsonObject>;
}

export interface TerminalSearchChannelOptions {
    readonly store: NexDomainStore;
    /**
     * `Partial` on purpose: `searchAsync` is a widening `TerminalStateServiceImpl` adds on top
     * of the `TerminalStateService` seam, and a daemon composed with a hand-rolled stub (tests,
     * a future WASM VT) may not have it. Without it every search reports zero matches rather
     * than throwing inside a reply.
     */
    readonly term: Partial<TerminalSearchBackend>;
}

function failure(error: string): JsonObject {
    return { ok: false, error };
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Which workspace the request is about: explicit id first, then the pane it names. */
function resolveWorkspace(
    state: DaemonState,
    payload: Record<string, unknown>
): WorkspaceState | null {
    const workspaceID = text(payload['workspace_id']);
    if (workspaceID !== undefined) return workspaceByID(state, workspaceID);
    const paneID = text(payload['pane_id']);
    if (paneID !== undefined) return workspaceContainingVisiblePane(state, paneID);
    return null;
}

/** `selected` → the match it names, if the list still reaches that far. */
function matchField(matches: readonly TerminalMatch[], selected: number | null): JsonObject | null {
    if (selected === null) return null;
    const match = matches[selected];
    if (match === undefined) return null;
    return {
        line: match.line,
        col: match.col,
        length: match.length,
        lines_from_bottom: match.linesFromBottom
    };
}

function snapshot(
    workspace: WorkspaceState,
    matches: readonly TerminalMatch[],
    caseSensitive: boolean
): JsonObject {
    return {
        ok: true,
        workspace_id: workspace.id,
        pane_id: workspace.searchingPaneID,
        needle: workspace.searchNeedle,
        total: workspace.searchTotal,
        selected: workspace.searchSelected,
        case_sensitive: caseSensitive,
        match: matchField(matches, workspace.searchSelected)
    };
}

export function createTerminalSearchChannel(
    options: TerminalSearchChannelOptions
): TerminalSearchChannel {
    const { store, term } = options;

    /**
     * Re-read the workspace after every dispatch. The store is synchronous, but the buffer read
     * in between is not, so nothing may be carried across an `await` — a pane could have closed
     * (which clears the search, `reducers/helpers.ts` `clearSearchIfTargets`).
     */
    const current = (id: string): WorkspaceState | null => workspaceByID(store.getState(), id);

    /**
     * Recount from scratch on every action rather than caching a match list.
     *
     * A terminal is a moving target: the buffer grows while the bar is open, so a cached list
     * goes stale in the time it takes to press Return. Rescanning keeps `total` honest for the
     * cost of one `indexOf` sweep, and match ORDER (top → bottom) is stable under appends, so a
     * selection index keeps naming the same occurrence.
     */
    const recount = async (
        workspace: WorkspaceState,
        caseSensitive: boolean
    ): Promise<readonly TerminalMatch[]> => {
        const paneID = workspace.searchingPaneID;
        if (paneID === null || workspace.searchNeedle === '') return [];
        const pane = visiblePane(workspace, paneID);
        // Only a terminal has a server-side buffer to search; see the header.
        if (pane === null || pane.type !== 'shell') return [];
        if (term.searchAsync === undefined) return [];
        return term.searchAsync(paneID, workspace.searchNeedle, { caseSensitive });
    };

    const publishCounts = (
        workspaceID: string,
        paneID: string,
        total: number | null,
        selected: number | null
    ): void => {
        store.dispatch({
            type: 'set-search-counts',
            workspaceID,
            paneID,
            total,
            selected
        });
    };

    return {
        async run(payload: Record<string, unknown>): Promise<JsonObject> {
            const rawAction = text(payload['action']) ?? 'status';
            if (!(TERMINAL_SEARCH_ACTIONS as readonly string[]).includes(rawAction)) {
                return failure(
                    `terminal-search action must be one of ${TERMINAL_SEARCH_ACTIONS.join(', ')}`
                );
            }
            const action = rawAction as TerminalSearchAction;
            const caseSensitive = payload['case_sensitive'] === true;

            const found = resolveWorkspace(store.getState(), payload);
            if (found === null) return failure('terminal-search requires a known workspace_id or pane_id');
            const workspaceID = found.id;

            if (action === 'toggle') {
                store.dispatch({ type: 'toggle-search', workspaceID });
                const after = current(workspaceID);
                if (after === null) return failure(`no workspace matches '${workspaceID}'`);
                return snapshot(after, [], caseSensitive);
            }

            if (action === 'close') {
                store.dispatch({ type: 'close-search', workspaceID });
                const after = current(workspaceID);
                if (after === null) return failure(`no workspace matches '${workspaceID}'`);
                return snapshot(after, [], caseSensitive);
            }

            if (action === 'status') {
                const matches = await recount(found, caseSensitive);
                const after = current(workspaceID);
                if (after === null) return failure(`no workspace matches '${workspaceID}'`);
                return snapshot(after, matches, caseSensitive);
            }

            if (found.searchingPaneID === null) {
                return failure('no search is open in that workspace');
            }

            if (action === 'set') {
                const needle = typeof payload['needle'] === 'string' ? payload['needle'] : undefined;
                if (needle === undefined) return failure('terminal-search set requires needle');
                // §7.14: a new needle drops any selection; the counter falls back to `-/N`.
                store.dispatch({ type: 'set-search-needle', workspaceID, needle });
                const staged = current(workspaceID);
                if (staged === null) return failure(`no workspace matches '${workspaceID}'`);
                const paneID = staged.searchingPaneID;
                if (paneID === null) return snapshot(staged, [], caseSensitive);
                const matches = await recount(staged, caseSensitive);
                const pane = visiblePane(staged, paneID);
                // A non-terminal pane counts in the client (its find runs in its own frame), so
                // the daemon publishes no total for it rather than a confident zero.
                const total = pane?.type === 'shell' ? matches.length : null;
                publishCounts(workspaceID, paneID, total, null);
                const after = current(workspaceID);
                if (after === null) return failure(`no workspace matches '${workspaceID}'`);
                return snapshot(after, matches, caseSensitive);
            }

            // next / prev
            const matches = await recount(found, caseSensitive);
            const live = current(workspaceID);
            if (live === null) return failure(`no workspace matches '${workspaceID}'`);
            const paneID = live.searchingPaneID;
            if (paneID === null) return snapshot(live, [], caseSensitive);
            const pane = visiblePane(live, paneID);
            if (pane === null || pane.type !== 'shell') {
                // The client drives its own backend for these; nothing to advance here.
                return snapshot(live, [], caseSensitive);
            }
            const total = matches.length;
            if (total === 0) {
                publishCounts(workspaceID, paneID, 0, null);
                const empty = current(workspaceID);
                return empty === null ? failure('workspace vanished') : snapshot(empty, matches, caseSensitive);
            }
            const previous = live.searchSelected;
            const selected =
                action === 'next'
                    ? previous === null
                        ? 0
                        : (previous + 1) % total
                    : previous === null
                      ? total - 1
                      : (previous - 1 + total) % total;
            publishCounts(workspaceID, paneID, total, selected);
            const after = current(workspaceID);
            if (after === null) return failure('workspace vanished');
            return snapshot(after, matches, caseSensitive);
        }
    };
}

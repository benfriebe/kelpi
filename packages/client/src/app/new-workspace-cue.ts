/**
 * #307: where a workspace created in the BACKGROUND went.
 *
 * An agent's `kelpi workspace create` no longer switches any window to the new workspace: the
 * daemon reveals only a focusing create (`--focus`, or a gesture). So the window says where it
 * went instead of going there. When a workspace arrives in the mirror, the sidebar scrolls its
 * row into view (the same one-shot `scrollToWorkspaceID` an activation queues, §WS-100, which
 * resolves a row hidden in a collapsed group to the group's header, §WS-101) and the row wears a
 * short highlight. Nothing is activated and nothing takes the focus.
 *
 * Who created the workspace is deliberately NOT the question. The worktree and repository paths
 * dispatch before they reply, so the window that asked can see the id before it activates it;
 * every arrival is pointed at, and the highlight is skipped for the workspace this window is
 * already on (its own gesture, or a reveal). A restore, or `pane move-to-workspace --create`,
 * puts a new row in the sidebar too, and pointing at it is right for the same reason.
 *
 * Arrivals are told apart from what the window ATTACHED to the same way WEB-002 does it
 * (`webpane/hooks.ts` ▸ `useBlankWebPaneURLFocus`): the first snapshot after an attach is
 * adopted silently, so a reload or a reconnect does not light up every workspace it finds.
 */

import { useEffect, useRef } from 'react';

/** How long the row wears the highlight. Long enough to catch the eye, short enough to forget. */
export const NEW_WORKSPACE_CUE_MS = 1600;

/**
 * The ids in `current` that `previous` did not have, in `current`'s order. `previous === null`
 * is the adoption pass: nothing has arrived yet.
 */
export function arrivedWorkspaceIDs(previous: ReadonlySet<string> | null, current: readonly string[]): string[] {
    if (previous === null) return [];
    return current.filter((id) => !previous.has(id));
}

/**
 * Calls `onArrive` with the newest workspace id each time one or more arrive after the first
 * snapshot. A burst (a coordinator fanning out five workers) is coalesced to its LAST id, so the
 * sidebar settles on one row rather than scrolling five times in one commit.
 *
 * `attached` is the daemon's `hasSnapshot`; while it is false nothing is recorded, so the next
 * snapshot is adopted rather than read as a wave of arrivals.
 */
export function useNewWorkspaceArrivals(
    workspaceIDs: readonly string[],
    attached: boolean,
    onArrive: (workspaceID: string) => void
): void {
    const seen = useRef<ReadonlySet<string> | null>(null);
    const latest = useRef(onArrive);
    latest.current = onArrive;
    useEffect(() => {
        if (!attached) {
            seen.current = null;
            return;
        }
        const arrived = arrivedWorkspaceIDs(seen.current, workspaceIDs);
        seen.current = new Set(workspaceIDs);
        const newest = arrived.at(-1);
        if (newest !== undefined) latest.current(newest);
    }, [attached, workspaceIDs]);
}

/**
 * The one-shot highlight's clock: `show(id)` marks the row, and it clears itself after
 * `NEW_WORKSPACE_CUE_MS`. A second arrival replaces the first; `dispose` clears the timer on
 * unmount.
 */
export function createNewWorkspaceCue(
    setHighlighted: (workspaceID: string | null) => void,
    durationMs = NEW_WORKSPACE_CUE_MS
): { show(workspaceID: string): void; dispose(): void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    return {
        show(workspaceID) {
            clear();
            setHighlighted(workspaceID);
            timer = setTimeout(() => {
                timer = null;
                setHighlighted(null);
            }, durationMs);
        },
        dispose: clear
    };
}

/**
 * The order ⌃Tab walks: the active workspace, then every other local workspace by the daemon's
 * `lastAccessedAt`, newest first (docs/config-keybindings.md §7.8).
 */

export interface RecentCandidate {
    readonly id: string;
    /** Epoch SECONDS, as the daemon stores it. Anything that is not a finite number sorts as 0. */
    readonly lastAccessedAt: unknown;
}

export interface ActivationSequence {
    note(id: string | null): void;
    readonly seq: ReadonlyMap<string, number>;
}

function stamp(candidate: RecentCandidate): number {
    const value = candidate.lastAccessedAt;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `candidates` in sidebar order, which is the last tie-break. */
export function recentWorkspaceOrder(
    candidates: readonly RecentCandidate[],
    activeID: string | null,
    localSeq: ReadonlyMap<string, number>
): string[] {
    const rest = candidates
        .map((candidate, sidebarIndex) => ({ candidate, sidebarIndex }))
        .filter(({ candidate }) => candidate.id !== activeID)
        .sort(
            (a, b) =>
                stamp(b.candidate) - stamp(a.candidate) ||
                (localSeq.get(b.candidate.id) ?? 0) - (localSeq.get(a.candidate.id) ?? 0) ||
                a.sidebarIndex - b.sidebarIndex
        )
        .map(({ candidate }) => candidate.id);
    const activeIsLocal = activeID !== null && candidates.some((candidate) => candidate.id === activeID);
    return activeIsLocal ? [activeID, ...rest] : rest;
}

/**
 * What a committed gesture should activate, or null for nothing. The active workspace is the
 * "never mind" landing (the caller hands the caret back instead), and a workspace closed
 * mid-gesture must not be activated: the client sets its own active workspace before the
 * daemon sees the request, so an unknown ID would leave the window showing none.
 */
export function commitTarget(id: string, activeID: string | null, exists: (id: string) => boolean): string | null {
    return id === activeID || !exists(id) ? null : id;
}

/**
 * This window's own activation order. `lastAccessedAt` is whole seconds, so two switches inside
 * one second tie; the later one this window saw wins.
 */
export function createActivationSequence(): ActivationSequence {
    const seq = new Map<string, number>();
    let last: string | null = null;
    let counter = 0;
    return {
        note(id) {
            if (id === null || id === last) return;
            last = id;
            counter += 1;
            seq.set(id, counter);
        },
        seq
    };
}

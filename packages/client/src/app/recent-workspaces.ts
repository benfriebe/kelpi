/**
 * The order ⌃Tab walks: the active workspace, then every other local workspace by the daemon's
 * `lastAccessedAt`, newest first (docs/superpowers/specs/2026-10-05-recent-workspace-switcher-design.md).
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

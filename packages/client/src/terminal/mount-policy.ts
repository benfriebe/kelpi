/**
 * Which panes get a live renderer (WP3.2, terminal-surface.md §4).
 *
 * A renderer is expensive in a way pane state is not: ghostty-web's canvas render loop is an
 * unconditional `requestAnimationFrame` chain per open terminal (it can be stopped only by
 * `dispose()`), each engine holds a canvas + a WASM terminal, and browsers cap live GPU-backed
 * canvases per page (the WebGL context limit that shaped this decision in the stack research —
 * ~16 in Chrome, oldest context gets killed silently past it). A workspace with 20 panes must
 * therefore NOT open 20 engines.
 *
 * The rules, in order:
 *
 *   1. Only the **active workspace's visible panes** are candidates. A background workspace
 *      renders nothing — the daemon keeps consuming its PTY output regardless, so nothing is
 *      lost by not watching (`daemon/src/ws/streams.ts`: never pause a PTY for a client).
 *   2. A **cap** applies. Past it, least-recently-used panes lose their renderer.
 *   3. "Used" means *focused* (or newly appeared) — not merely on screen. A pane that has sat
 *      visible and untouched is the right thing to evict when a 21st pane shows up.
 *   4. Eviction is cheap and reversible: unmounting disposes the engine and detaches the PTY
 *      stream; re-mounting re-attaches, and the daemon **replays** the server-side VT snapshot,
 *      so the pane comes back with its screen intact (`ingest.ts`).
 *
 * Pure and state-in/state-out: the caller keeps `MountPolicyState` (a ref, or the store) and
 * feeds it back. `createMountPolicy()` wraps that for callers who just want an object.
 */

export const DEFAULT_MOUNT_LIMIT = 12;

/** How much LRU history is retained beyond the cap, as a multiple of it. */
const HISTORY_FACTOR = 4;

export interface MountPolicyState {
    /** Monotonic use counter; higher is more recent. */
    readonly seq: number;
    /** paneID → last-use tick. */
    readonly used: ReadonlyMap<string, number>;
    /** What the last decision mounted, in render order. */
    readonly mounted: readonly string[];
}

export const EMPTY_MOUNT_STATE: MountPolicyState = { seq: 0, used: new Map(), mounted: [] };

export interface MountRequest {
    /** The active workspace's visible panes, in layout order. */
    readonly desired: readonly string[];
    /** The focused pane — the strongest "recently used" signal. */
    readonly focusedPaneID?: string | null | undefined;
    readonly limit?: number | undefined;
}

export interface MountDecision {
    /** Panes that should have a live renderer now, in layout order. */
    readonly mounted: readonly string[];
    /** Newly mounted since the previous decision. */
    readonly mount: readonly string[];
    /** Mounted before, not now: dispose the renderer and detach the stream. */
    readonly evict: readonly string[];
    /** Feed this back into the next `planMounts` call. */
    readonly state: MountPolicyState;
}

function dedupe(ids: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
        if (id === '' || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export function planMounts(state: MountPolicyState, request: MountRequest): MountDecision {
    const limit = Math.max(1, Math.trunc(request.limit ?? DEFAULT_MOUNT_LIMIT));
    const desired = dedupe(request.desired);
    const used = new Map(state.used);
    let seq = state.seq;

    // First sighting counts as a use. Assign in reverse so that when a workspace opens with
    // more panes than the cap, layout order decides which ones win.
    for (let index = desired.length - 1; index >= 0; index -= 1) {
        const id = desired[index];
        if (id === undefined || used.has(id)) continue;
        seq += 1;
        used.set(id, seq);
    }

    const focused = request.focusedPaneID ?? null;
    if (focused !== null && desired.includes(focused)) {
        seq += 1;
        used.set(focused, seq);
    }

    const ranked = [...desired].sort((a, b) => (used.get(b) ?? 0) - (used.get(a) ?? 0));
    const keep = new Set(ranked.slice(0, limit));
    const mounted = desired.filter((id) => keep.has(id));
    const previous = new Set(state.mounted);
    const mount = mounted.filter((id) => !previous.has(id));
    const evict = state.mounted.filter((id) => !keep.has(id));

    // Bound the history: keep everything on screen plus the most recent few generations, so a
    // workspace switch and back does not forget which panes were being used.
    const historyLimit = limit * HISTORY_FACTOR;
    if (used.size > historyLimit) {
        const survivors = [...used.entries()]
            .sort((a, b) => b[1] - a[1])
            .filter(([id], index) => index < historyLimit || keep.has(id));
        used.clear();
        for (const [id, tick] of survivors) used.set(id, tick);
    }

    return { mounted, mount, evict, state: { seq, used, mounted } };
}

export interface MountPolicy {
    plan(request: MountRequest): MountDecision;
    readonly mounted: readonly string[];
    readonly state: MountPolicyState;
    reset(): void;
}

export function createMountPolicy(defaults: { limit?: number } = {}): MountPolicy {
    let state = EMPTY_MOUNT_STATE;
    return {
        plan(request: MountRequest): MountDecision {
            const limit = request.limit ?? defaults.limit;
            const decision = planMounts(state, limit === undefined ? request : { ...request, limit });
            state = decision.state;
            return decision;
        },
        get mounted(): readonly string[] {
            return state.mounted;
        },
        get state(): MountPolicyState {
            return state;
        },
        reset(): void {
            state = EMPTY_MOUNT_STATE;
        }
    };
}

export interface VisiblePanesInput {
    /** The workspace's panes in layout order (`layoutPaneOrder` from the daemon store). */
    readonly paneOrder: readonly string[];
    /** When a pane is zoomed it is the only thing on screen (workspace-feature.md zoom). */
    readonly zoomedPaneID?: string | null | undefined;
    /** False for a background workspace: nothing of it is visible. */
    readonly workspaceActive?: boolean | undefined;
}

/** The candidate set rule (1) above, as a function of what the store already exposes. */
export function visiblePaneIDs(input: VisiblePanesInput): readonly string[] {
    if (input.workspaceActive === false) return [];
    const zoomed = input.zoomedPaneID ?? null;
    if (zoomed !== null && input.paneOrder.includes(zoomed)) return [zoomed];
    return input.paneOrder;
}

/**
 * The step list a worktree create reports while it runs (issue #294, graft-git.md §8.5.1).
 *
 * `workspace-create --worktree` used to answer once, after every git step had finished, so the
 * New Workspace sheet showed "Creating…" and nothing else for as long as the network took. The
 * steps are reported instead, as a whole SNAPSHOT each time (four rows, a few dozen bytes), so a
 * dropped or coalesced frame can never leave the client with a wrong picture: the latest frame
 * is the truth.
 *
 * Updates are THROTTLED per request: git rewrites its meter many times a second, and a status
 * change is only worth a frame once the previous frame is `intervalMs` old. Nothing is lost:
 * an update inside the window schedules one trailing frame carrying the latest state, and
 * `flush()` (called just before the final reply) sends anything still pending, so the last
 * frame a client sees always agrees with the reply that follows it.
 */

import type { GitProgress } from './progress.js';

export const WORKTREE_STEP_IDS = ['resolve-default-branch', 'fetch', 'worktree-add', 'create-workspace'] as const;
export type WorktreeStepID = (typeof WORKTREE_STEP_IDS)[number];

export type WorktreeStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface WorktreeStepState {
    readonly id: WorktreeStepID;
    readonly status: WorktreeStepStatus;
    /** A short, human line: `main (from origin/HEAD)`, `prefetched 5 s ago`, … */
    readonly detail?: string | undefined;
    /** Git's current meter phase while running, when it printed one. */
    readonly phase?: string | undefined;
    /** 0–100 while running with a meter; absent = indeterminate. */
    readonly percent?: number | undefined;
    /** Git's message (or `cancelled`) for a failed step. */
    readonly error?: string | undefined;
}

export interface WorktreeProgressSnapshot {
    readonly steps: readonly WorktreeStepState[];
    /** Set once the create was cancelled; the step that was running is `failed`. */
    readonly cancelled?: true | undefined;
    /**
     * `false` when this create cannot report steps at all (a plugin provider owns `kelpi.git`):
     * the one frame such a create sends, with no steps. Absent means detailed.
     */
    readonly detailed?: false | undefined;
}

/** What the create flow reports into. Every method is safe to call in any order. */
export interface WorktreeStepSink {
    running(step: WorktreeStepID, detail?: string): void;
    progress(step: WorktreeStepID, progress: GitProgress): void;
    done(step: WorktreeStepID, detail?: string): void;
    skipped(step: WorktreeStepID, detail: string): void;
    failed(step: WorktreeStepID, error: string): void;
    cancelled(step: WorktreeStepID): void;
}

export interface WorktreeStepTracker extends WorktreeStepSink {
    /** The current state, unthrottled. */
    snapshot(): WorktreeProgressSnapshot;
    /** Send any pending state now and stop the trailing timer. */
    flush(): void;
    /**
     * Mark the running step failed, or the first pending one when none runs, unless a step has
     * already failed: a create that failed outside the flow still names a step.
     */
    failUnfinished(error: string): void;
}

/** The steps a create runs: without update main there is nothing to resolve or fetch. */
export function worktreeStepsFor(updateMain: boolean): readonly WorktreeStepID[] {
    return updateMain ? WORKTREE_STEP_IDS : ['worktree-add', 'create-workspace'];
}

/** 150 ms: inside the 100–200 ms band, and still several frames a second for a moving bar. */
export const WORKTREE_PROGRESS_INTERVAL_MS = 150;

export interface CreateStepTrackerOptions {
    readonly steps: readonly WorktreeStepID[];
    readonly emit: (snapshot: WorktreeProgressSnapshot) => void;
    readonly intervalMs?: number | undefined;
    readonly now?: (() => number) | undefined;
    readonly setTimer?: ((callback: () => void, ms: number) => unknown) | undefined;
    readonly clearTimer?: ((handle: unknown) => void) | undefined;
}

export function createStepTracker(options: CreateStepTrackerOptions): WorktreeStepTracker {
    const intervalMs = options.intervalMs ?? WORKTREE_PROGRESS_INTERVAL_MS;
    const now = options.now ?? (() => Date.now());
    const setTimer =
        options.setTimer ??
        ((callback: () => void, ms: number): unknown => {
            const handle = setTimeout(callback, ms);
            handle.unref?.();
            return handle;
        });
    const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

    const states = new Map<WorktreeStepID, WorktreeStepState>(options.steps.map((id) => [id, { id, status: 'pending' }]));
    let cancelled = false;
    let dirty = false;
    let lastSentAt: number | null = null;
    let timer: unknown = null;

    const snapshot = (): WorktreeProgressSnapshot => ({
        steps: options.steps.map((id) => states.get(id) ?? { id, status: 'pending' }),
        ...(cancelled ? { cancelled: true as const } : {})
    });

    const send = (): void => {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
        dirty = false;
        lastSentAt = now();
        options.emit(snapshot());
    };

    const changed = (): void => {
        dirty = true;
        const since = lastSentAt === null ? Infinity : now() - lastSentAt;
        if (since >= intervalMs) {
            send();
            return;
        }
        // Inside the window: one trailing frame, carrying whatever the state is by then.
        if (timer === null) timer = setTimer(() => {
            timer = null;
            if (dirty) send();
        }, intervalMs - since);
    };

    /** Unknown steps (a flow reporting one this create does not list) are ignored. */
    const set = (id: WorktreeStepID, next: WorktreeStepState): void => {
        if (!states.has(id)) return;
        states.set(id, next);
        changed();
    };

    return {
        running(step, detail) {
            set(step, { id: step, status: 'running', ...(detail !== undefined ? { detail } : {}) });
        },
        progress(step, progress) {
            const current = states.get(step);
            if (current === undefined || current.status !== 'running') return;
            if (current.phase === progress.phase && current.percent === progress.percent) return;
            set(step, { ...current, phase: progress.phase, percent: progress.percent });
        },
        done(step, detail) {
            const current = states.get(step);
            set(step, { id: step, status: 'done', ...(detail !== undefined ? { detail } : current?.detail !== undefined ? { detail: current.detail } : {}) });
        },
        skipped(step, detail) {
            set(step, { id: step, status: 'skipped', detail });
        },
        failed(step, error) {
            const current = states.get(step);
            set(step, { id: step, status: 'failed', error, ...(current?.detail !== undefined ? { detail: current.detail } : {}) });
        },
        cancelled(step) {
            cancelled = true;
            const current = states.get(step);
            set(step, { id: step, status: 'failed', error: 'cancelled', ...(current?.detail !== undefined ? { detail: current.detail } : {}) });
        },
        snapshot,
        failUnfinished(error) {
            const all = options.steps.map((id) => states.get(id)).filter((state): state is WorktreeStepState => state !== undefined);
            if (all.some((state) => state.status === 'failed')) return;
            const target = all.find((state) => state.status === 'running') ?? all.find((state) => state.status === 'pending');
            if (target === undefined) return;
            set(target.id, { id: target.id, status: 'failed', error, ...(target.detail !== undefined ? { detail: target.detail } : {}) });
        },
        flush() {
            if (dirty) send();
            else if (timer !== null) {
                clearTimer(timer);
                timer = null;
            }
        }
    };
}

/** The wire form of a snapshot: snake_case, absent fields omitted (wire-protocol.md §5.9). */
export function serializeWorktreeProgress(snapshot: WorktreeProgressSnapshot): Record<string, unknown> {
    return {
        kind: 'worktree-create',
        steps: snapshot.steps.map((step) => ({
            id: step.id,
            status: step.status,
            ...(step.detail !== undefined ? { detail: step.detail } : {}),
            ...(step.phase !== undefined ? { phase: step.phase } : {}),
            ...(step.percent !== undefined ? { percent: step.percent } : {}),
            ...(step.error !== undefined ? { error: step.error } : {})
        })),
        ...(snapshot.cancelled === true ? { cancelled: true } : {}),
        ...(snapshot.detailed === false ? { detailed: false } : {})
    };
}

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
 *
 * A create from a ticket (docs/integrations.md) runs a `ticket` step first, the lookup that can
 * take seconds over the network, and only then knows how it checks out (`WorkspaceCheckoutMode`):
 * a pull request fetches its head rather than the default branch, an existing branch is attached
 * with nothing fetched, and a checkout that already exists needs no git step at all. So the step
 * list depends on that mode (`worktreeStepsFor`), the snapshot names it (`checkout`) so a client
 * can label each step for what it does ("Fetch the pull request", not "Fetch the latest main"),
 * and the tracker can be re-planned once the ticket has answered (`replan`).
 */

import type { WorkspaceCheckoutMode } from '@kelpi/protocol';

import type { GitProgress } from './progress.js';

/** Every step a create can run, in the order it runs them. */
export const WORKTREE_STEP_IDS = ['ticket', 'resolve-default-branch', 'fetch', 'worktree-add', 'create-workspace'] as const;
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
    /**
     * How the create checks out, which is what its steps do: set by a create from a ticket (once
     * the ticket has answered, `replan`). Absent = a plain create, whose steps mean what they
     * always have (`new-branch`).
     */
    readonly checkout?: WorkspaceCheckoutMode | undefined;
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
    /**
     * Replace the step list (and name the checkout mode) once a create knows them: a step in both
     * lists keeps its state, a new one starts pending, one no longer listed is dropped. Reported
     * like any other change.
     */
    replan(steps: readonly WorktreeStepID[], checkout?: WorkspaceCheckoutMode): void;
    /** Send any pending state now and stop the trailing timer. */
    flush(): void;
    /**
     * Mark the running step failed, or the first pending one when none runs, unless a step has
     * already failed: a create that failed outside the flow still names a step.
     */
    failUnfinished(error: string): void;
}

/** What decides a create's steps (`worktreeStepsFor`). */
export interface WorktreeStepPlan {
    /** How it checks out; absent = `new-branch`, a plain create. */
    readonly checkout?: WorkspaceCheckoutMode | undefined;
    /** `new-branch` only: fetch the default branch and branch off it. */
    readonly updateMain?: boolean | undefined;
    /** The create names a ticket: `ticket` runs first. */
    readonly ticket?: boolean | undefined;
}

/**
 * The steps a create runs, in order:
 *
 *   new-branch, update main     resolve-default-branch, fetch, worktree-add, create-workspace
 *   new-branch                  worktree-add, create-workspace (nothing to resolve or fetch)
 *   attach-branch               worktree-add, create-workspace (the branch is already there)
 *   pr-head                     fetch (the head), worktree-add, create-workspace
 *   existing-checkout           create-workspace (no worktree is made)
 *
 * …each preceded by `ticket` for a create from a ticket. The boolean form is the plain create's,
 * as every caller before tickets wrote it.
 */
export function worktreeStepsFor(updateMain: boolean): readonly WorktreeStepID[];
export function worktreeStepsFor(plan: WorktreeStepPlan): readonly WorktreeStepID[];
export function worktreeStepsFor(input: boolean | WorktreeStepPlan): readonly WorktreeStepID[] {
    const plan: WorktreeStepPlan = typeof input === 'boolean' ? { updateMain: input } : input;
    let steps: readonly WorktreeStepID[];
    switch (plan.checkout ?? 'new-branch') {
        case 'new-branch':
            steps =
                plan.updateMain === true
                    ? ['resolve-default-branch', 'fetch', 'worktree-add', 'create-workspace']
                    : ['worktree-add', 'create-workspace'];
            break;
        case 'attach-branch':
            steps = ['worktree-add', 'create-workspace'];
            break;
        case 'pr-head':
            steps = ['fetch', 'worktree-add', 'create-workspace'];
            break;
        case 'existing-checkout':
            steps = ['create-workspace'];
            break;
    }
    return plan.ticket === true ? ['ticket', ...steps] : steps;
}

/** 150 ms: inside the 100–200 ms band, and still several frames a second for a moving bar. */
export const WORKTREE_PROGRESS_INTERVAL_MS = 150;

export interface CreateStepTrackerOptions {
    readonly steps: readonly WorktreeStepID[];
    /** Named in every snapshot when set (`WorktreeProgressSnapshot.checkout`). */
    readonly checkout?: WorkspaceCheckoutMode | undefined;
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

    let stepIDs: readonly WorktreeStepID[] = options.steps;
    let checkout: WorkspaceCheckoutMode | undefined = options.checkout;
    let states = new Map<WorktreeStepID, WorktreeStepState>(stepIDs.map((id) => [id, { id, status: 'pending' }]));
    let cancelled = false;
    let dirty = false;
    let lastSentAt: number | null = null;
    let timer: unknown = null;

    const snapshot = (): WorktreeProgressSnapshot => ({
        steps: stepIDs.map((id) => states.get(id) ?? { id, status: 'pending' }),
        ...(cancelled ? { cancelled: true as const } : {}),
        ...(checkout !== undefined ? { checkout } : {})
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
        replan(steps, nextCheckout) {
            const previous = states;
            stepIDs = steps;
            states = new Map(steps.map((id) => [id, previous.get(id) ?? { id, status: 'pending' }]));
            if (nextCheckout !== undefined) checkout = nextCheckout;
            changed();
        },
        failUnfinished(error) {
            const all = stepIDs.map((id) => states.get(id)).filter((state): state is WorktreeStepState => state !== undefined);
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
        ...(snapshot.detailed === false ? { detailed: false } : {}),
        ...(snapshot.checkout !== undefined ? { checkout: snapshot.checkout } : {})
    };
}

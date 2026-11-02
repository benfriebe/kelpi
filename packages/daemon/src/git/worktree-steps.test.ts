/**
 * The worktree create's step reports (issue #294): what a snapshot says, and the throttle that
 * keeps git's meter from turning into a frame per update.
 */

import { describe, expect, it } from 'vitest';

import {
    createStepTracker,
    serializeWorktreeProgress,
    worktreeStepsFor,
    type WorktreeProgressSnapshot
} from './worktree-steps.js';

/** A manual clock and timer queue, so the throttle is tested without real time. */
function clock() {
    let now = 0;
    const timers: { at: number; run: () => void; handle: number }[] = [];
    let next = 1;
    return {
        now: () => now,
        setTimer: (run: () => void, ms: number): unknown => {
            const handle = next++;
            timers.push({ at: now + ms, run, handle });
            return handle;
        },
        clearTimer: (handle: unknown) => {
            const index = timers.findIndex((timer) => timer.handle === handle);
            if (index >= 0) timers.splice(index, 1);
        },
        advance(ms: number) {
            now += ms;
            for (;;) {
                const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0];
                if (due === undefined) return;
                timers.splice(timers.indexOf(due), 1);
                due.run();
            }
        },
        pending: () => timers.length
    };
}

function tracker(updateMain = true) {
    const time = clock();
    const frames: WorktreeProgressSnapshot[] = [];
    const sentAt: number[] = [];
    const steps = createStepTracker({
        steps: worktreeStepsFor(updateMain),
        emit: (snapshot) => {
            frames.push(snapshot);
            sentAt.push(time.now());
        },
        intervalMs: 150,
        now: time.now,
        setTimer: time.setTimer,
        clearTimer: time.clearTimer
    });
    return { time, frames, sentAt, steps };
}

const meter = (percent: number) => ({ phase: 'Receiving objects', percent, current: percent, total: 100, remote: false });

describe('worktree step snapshots', () => {
    it('lists the four update-main steps, or only two without update main', () => {
        expect(worktreeStepsFor(true)).toEqual(['resolve-default-branch', 'fetch', 'worktree-add', 'create-workspace']);
        expect(worktreeStepsFor(false)).toEqual(['worktree-add', 'create-workspace']);
        const { steps } = tracker(false);
        steps.running('fetch', 'ignored: not a step of this create');
        expect(steps.snapshot().steps.map((step) => step.id)).toEqual(['worktree-add', 'create-workspace']);
    });

    it('carries each status, the detail, the meter while running, the error, and cancelled', () => {
        const { steps } = tracker();
        steps.running('resolve-default-branch');
        steps.done('resolve-default-branch', 'main (from origin/HEAD)');
        steps.running('fetch', 'origin/main');
        steps.progress('fetch', meter(45));
        expect(steps.snapshot().steps.slice(0, 2)).toEqual([
            { id: 'resolve-default-branch', status: 'done', detail: 'main (from origin/HEAD)' },
            { id: 'fetch', status: 'running', detail: 'origin/main', phase: 'Receiving objects', percent: 45 }
        ]);
        steps.skipped('fetch', 'prefetched 5.0 s ago');
        steps.progress('fetch', meter(90)); // not running any more: ignored
        expect(steps.snapshot().steps[1]).toEqual({ id: 'fetch', status: 'skipped', detail: 'prefetched 5.0 s ago' });
        steps.running('worktree-add', 'x off origin/main');
        steps.failed('worktree-add', "fatal: '/wt/x' already exists");
        expect(steps.snapshot().steps[2]).toEqual({ id: 'worktree-add', status: 'failed', detail: 'x off origin/main', error: "fatal: '/wt/x' already exists" });
        expect(steps.snapshot().cancelled).toBeUndefined();
        steps.cancelled('worktree-add');
        expect(steps.snapshot()).toMatchObject({ cancelled: true, steps: [{}, {}, { status: 'failed', error: 'cancelled' }, { status: 'pending' }] });
    });

    it('serializes to the wire shape, omitting what is absent', () => {
        const { steps } = tracker(false);
        steps.running('worktree-add', 'x');
        steps.progress('worktree-add', { phase: 'Updating files', percent: 60, current: 6, total: 10, remote: false });
        expect(serializeWorktreeProgress(steps.snapshot())).toEqual({
            kind: 'worktree-create',
            steps: [
                { id: 'worktree-add', status: 'running', detail: 'x', phase: 'Updating files', percent: 60 },
                { id: 'create-workspace', status: 'pending' }
            ]
        });
        steps.cancelled('worktree-add');
        expect(serializeWorktreeProgress(steps.snapshot())).toMatchObject({ cancelled: true });
    });
});

describe('worktree step throttling', () => {
    it('sends the first change at once, then at most one frame per interval, carrying the latest state', () => {
        const { time, frames, sentAt, steps } = tracker();
        steps.running('resolve-default-branch');
        expect(frames).toHaveLength(1);
        expect(sentAt).toEqual([0]);
        // A burst inside the window: nothing yet, one trailing frame scheduled.
        steps.done('resolve-default-branch', 'main');
        steps.running('fetch');
        for (let percent = 1; percent <= 40; percent += 1) steps.progress('fetch', meter(percent));
        expect(frames).toHaveLength(1);
        expect(time.pending()).toBe(1);
        time.advance(149);
        expect(frames).toHaveLength(1);
        time.advance(1);
        expect(frames).toHaveLength(2);
        expect(frames[1]?.steps[1]).toMatchObject({ status: 'running', percent: 40 });
        // A long quiet gap: the next change goes out immediately again.
        time.advance(1_000);
        steps.progress('fetch', meter(80));
        expect(frames).toHaveLength(3);
        // Never more than one frame per 150 ms, however fast the meter moves.
        for (let tick = 0; tick < 100; tick += 1) {
            steps.progress('fetch', meter(81 + (tick % 19)));
            time.advance(10);
        }
        time.advance(1_000);
        const gaps = sentAt.slice(1).map((at, index) => at - (sentAt[index] ?? 0));
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(150);
        expect(frames.length).toBeGreaterThan(5);
        // …and the trailing frame carried the very last reading.
        expect(frames.at(-1)?.steps[1]?.percent).toBe(81 + (99 % 19));
    });

    it('does not send a frame for a meter reading that changed nothing', () => {
        const { time, frames, steps } = tracker();
        steps.running('fetch');
        time.advance(500);
        steps.progress('fetch', meter(10));
        steps.progress('fetch', meter(10));
        time.advance(500);
        expect(frames).toHaveLength(2);
    });

    it('flush() sends what is pending now, so the last frame agrees with the reply after it', () => {
        const { time, frames, steps } = tracker();
        steps.running('resolve-default-branch');
        steps.done('resolve-default-branch');
        steps.running('fetch');
        steps.failed('fetch', 'fatal: no network');
        expect(frames).toHaveLength(1);
        steps.flush();
        expect(frames).toHaveLength(2);
        expect(frames[1]?.steps[1]).toMatchObject({ status: 'failed', error: 'fatal: no network' });
        expect(time.pending()).toBe(0);
        // Nothing pending: flush sends nothing.
        steps.flush();
        expect(frames).toHaveLength(2);
    });
});

describe('worktree steps by checkout mode (a create from a ticket)', () => {
    it('keeps the plain create exactly as it was', () => {
        expect(worktreeStepsFor(true)).toEqual(worktreeStepsFor({ updateMain: true }));
        expect(worktreeStepsFor(false)).toEqual(worktreeStepsFor({}));
        expect(worktreeStepsFor({ checkout: 'new-branch', updateMain: true })).toEqual([
            'resolve-default-branch',
            'fetch',
            'worktree-add',
            'create-workspace'
        ]);
    });

    it('lists each mode with the ticket lookup first', () => {
        expect(worktreeStepsFor({ ticket: true, checkout: 'new-branch', updateMain: true })).toEqual([
            'ticket',
            'resolve-default-branch',
            'fetch',
            'worktree-add',
            'create-workspace'
        ]);
        expect(worktreeStepsFor({ ticket: true, checkout: 'pr-head' })).toEqual(['ticket', 'fetch', 'worktree-add', 'create-workspace']);
        // An attach never fetches: update main does not apply to a branch that already exists.
        expect(worktreeStepsFor({ ticket: true, checkout: 'attach-branch', updateMain: true })).toEqual([
            'ticket',
            'worktree-add',
            'create-workspace'
        ]);
        expect(worktreeStepsFor({ ticket: true, checkout: 'existing-checkout' })).toEqual(['ticket', 'create-workspace']);
        expect(worktreeStepsFor({ checkout: 'pr-head' })).toEqual(['fetch', 'worktree-add', 'create-workspace']);
    });

    it('re-plans once the ticket has answered, keeping what already ran and naming the mode', () => {
        const frames: WorktreeProgressSnapshot[] = [];
        const steps = createStepTracker({
            steps: worktreeStepsFor({ ticket: true, checkout: 'new-branch', updateMain: true }),
            emit: (snapshot) => frames.push(snapshot),
            intervalMs: 0
        });
        steps.running('ticket', 'acme/api#418');
        steps.done('ticket', 'pull request #418');
        steps.replan(worktreeStepsFor({ ticket: true, checkout: 'pr-head' }), 'pr-head');
        expect(steps.snapshot()).toEqual({
            steps: [
                { id: 'ticket', status: 'done', detail: 'pull request #418' },
                { id: 'fetch', status: 'pending' },
                { id: 'worktree-add', status: 'pending' },
                { id: 'create-workspace', status: 'pending' }
            ],
            checkout: 'pr-head'
        });
        expect(frames.at(-1)).toEqual(steps.snapshot());
        // A step the new plan drops is gone; one it does not list is ignored, as before.
        steps.running('resolve-default-branch');
        expect(steps.snapshot().steps.map((step) => step.id)).toEqual(['ticket', 'fetch', 'worktree-add', 'create-workspace']);
        expect(serializeWorktreeProgress(steps.snapshot())).toMatchObject({ kind: 'worktree-create', checkout: 'pr-head' });
    });

    it('names the mode from the start when the create knows it, and fails the right step after a re-plan', () => {
        const steps = createStepTracker({ steps: worktreeStepsFor({ ticket: true, checkout: 'existing-checkout' }), checkout: 'existing-checkout', emit: () => {}, intervalMs: 0 });
        expect(steps.snapshot().checkout).toBe('existing-checkout');
        steps.running('ticket');
        steps.failUnfinished('GitHub is not connected');
        expect(steps.snapshot().steps[0]).toEqual({ id: 'ticket', status: 'failed', error: 'GitHub is not connected' });
        // A plain create's snapshot carries no mode at all.
        expect(serializeWorktreeProgress(tracker(true).steps.snapshot())).not.toHaveProperty('checkout');
    });
});

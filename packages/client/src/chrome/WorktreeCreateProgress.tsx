/**
 * The New Workspace sheet's step list while a worktree create runs (issue #294, shell-ui.md
 * §10.1, graft-git.md §8.5.1).
 *
 * The daemon streams a whole-list snapshot per change (`command-progress`); this draws the
 * latest one. It is compact on purpose, the sheet is 360 px wide: one row per step, an icon for
 * its state (a spinner while running, a tick, a dash for skipped, a cross for failed, a hollow
 * dot while pending), the step's name, and the daemon's short detail on the right. A running step
 * with git's meter gets a determinate bar and the phase ("Receiving objects 45%"); a running
 * git step without one gets the update sheet's indeterminate sweep, so the row still moves. The
 * header says what is happening and how long it has taken.
 *
 * The error MESSAGE is not repeated here: the sheet's own error line carries it (the same line a
 * failed create has always used), and the failed row is marked so the user sees WHICH step it was.
 */

import type { ReactElement } from 'react';

import { withAlpha } from './theme';
import { tokens } from './tokens';
import type { WorktreeCreateProgress, WorktreeCreateStep } from './types';
import { formatElapsed, WORKTREE_STEP_LABELS } from './worktree';

export type WorktreeCreatePhase = 'running' | 'cancelling' | 'failed' | 'cancelled' | 'done';

export interface WorktreeCreateProgressProps {
    readonly progress: WorktreeCreateProgress;
    readonly phase: WorktreeCreatePhase;
    readonly elapsedMs: number;
    /** Escape or the backdrop was pressed while the create ran: say how to stop it. */
    readonly closeHint: boolean;
}

const HEADLINES: Readonly<Record<WorktreeCreatePhase, string>> = {
    running: 'Creating the workspace…',
    cancelling: 'Cancelling…',
    failed: 'The workspace was not created',
    cancelled: 'Cancelled',
    done: 'Created'
};

/** The failure red the sheet's error line already uses. */
const FAILURE = '#E0655C';

function StepIcon({ step }: { readonly step: WorktreeCreateStep }): ReactElement {
    const box = 'flex h-3 w-3 shrink-0 items-center justify-center text-[10px] leading-none';
    switch (step.status) {
        case 'running':
            return (
                <span className={box} aria-hidden="true">
                    <span className="kelpi-storage-spinner" style={{ borderColor: tokens.divider, borderTopColor: tokens.accent }} />
                </span>
            );
        case 'done':
            return (
                <span className={box} aria-hidden="true" style={{ color: tokens.statusRunning }}>
                    ✓
                </span>
            );
        case 'skipped':
            return (
                <span className={box} aria-hidden="true" style={{ color: tokens.textTertiary }}>
                    –
                </span>
            );
        case 'failed':
            return (
                <span className={box} aria-hidden="true" style={{ color: FAILURE }}>
                    ✕
                </span>
            );
        case 'pending':
            return (
                <span className={box} aria-hidden="true">
                    <span className="h-[7px] w-[7px] rounded-full border" style={{ borderColor: tokens.textTertiary }} />
                </span>
            );
    }
}

/** Only the two git steps can take long enough to deserve a moving bar without a meter. */
function hasBar(step: WorktreeCreateStep): boolean {
    return step.status === 'running' && (step.percent !== undefined || step.id === 'fetch' || step.id === 'worktree-add');
}

function StepRow({ step }: { readonly step: WorktreeCreateStep }): ReactElement {
    const label = WORKTREE_STEP_LABELS[step.id];
    const tone =
        step.status === 'pending' || step.status === 'skipped'
            ? tokens.textTertiary
            : step.status === 'failed'
              ? FAILURE
              : tokens.textPrimary;
    return (
        <li
            data-testid={`new-workspace-step-${step.id}`}
            data-status={step.status}
            {...(step.percent !== undefined ? { 'data-percent': String(step.percent) } : {})}
            className="flex flex-col gap-1"
        >
            <div className="flex items-center gap-1.5">
                <StepIcon step={step} />
                <span className="shrink-0" style={{ color: tone }}>
                    {label}
                </span>
                {step.detail === undefined ? null : (
                    <span
                        data-testid={`new-workspace-step-${step.id}-detail`}
                        className="ml-auto min-w-0 truncate pl-2 text-right text-[10px]"
                        style={{ color: tokens.textTertiary }}
                        title={step.detail}
                    >
                        {step.detail}
                    </span>
                )}
            </div>
            {hasBar(step) ? (
                <div className="flex items-center gap-2 pl-[18px]">
                    <div
                        role="progressbar"
                        aria-label={label}
                        {...(step.percent !== undefined
                            ? { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': step.percent }
                            : { 'aria-busy': true })}
                        className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full"
                        style={{ background: withAlpha(tokens.textPrimary, 0.1) }}
                    >
                        {step.percent !== undefined ? (
                            <div
                                className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-150"
                                style={{ width: `${String(step.percent)}%`, background: tokens.accent }}
                            />
                        ) : (
                            <div className="kelpi-update-progress absolute inset-y-0 left-0 w-2/5 rounded-full" style={{ background: tokens.accent }} />
                        )}
                    </div>
                    {step.phase === undefined || step.percent === undefined ? null : (
                        <span
                            data-testid={`new-workspace-step-${step.id}-phase`}
                            className="shrink-0 text-[10px] tabular-nums"
                            style={{ color: tokens.textTertiary }}
                        >
                            {step.phase} {String(step.percent)}%
                        </span>
                    )}
                </div>
            ) : null}
        </li>
    );
}

export function WorktreeCreateProgressPanel(props: WorktreeCreateProgressProps): ReactElement {
    const { progress, phase } = props;
    return (
        <div
            data-testid="new-workspace-progress"
            data-phase={phase}
            role="status"
            aria-live="polite"
            className="flex flex-col gap-2 rounded-md border px-3 py-2.5 text-[11px]"
            style={{ borderColor: tokens.divider, background: withAlpha(tokens.textPrimary, 0.03) }}
        >
            <div className="flex items-center">
                <span
                    data-testid="new-workspace-progress-headline"
                    className="font-medium"
                    style={{ color: phase === 'failed' ? FAILURE : tokens.textPrimary }}
                >
                    {HEADLINES[phase]}
                </span>
                <span
                    data-testid="new-workspace-progress-elapsed"
                    className="ml-auto text-[10px] tabular-nums"
                    style={{ color: tokens.textTertiary }}
                >
                    {formatElapsed(props.elapsedMs)}
                </span>
            </div>
            <ol className="flex flex-col gap-1.5">
                {progress.steps.map((step) => (
                    <StepRow key={step.id} step={step} />
                ))}
            </ol>
            {props.closeHint && (phase === 'running' || phase === 'cancelling') ? (
                <div data-testid="new-workspace-progress-hint" className="text-[10px]" style={{ color: tokens.textSecondary }}>
                    Still creating. Press Cancel to stop it; the sheet closes by itself when it is done.
                </div>
            ) : null}
        </div>
    );
}

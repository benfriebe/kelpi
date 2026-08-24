/**
 * Graft's three pieces of chrome, all of them living in the workspace inspector
 * (graft-git.md §GIT-046…§GIT-051, workspaces-sidebar.md §WS-143…§WS-145):
 *
 *   1. **`GraftToggleButton`** — the per-worktree toggle. The icon swaps between the open
 *      circular-arrows glyph (no session) and its filled variant (a session exists), with a
 *      5 px status dot pinned to the top-trailing corner: solid yellow starting, PULSING yellow
 *      syncing, green watching, red error. The pulse is the whole point of having two yellows —
 *      it is how a stuck start is told apart from a session that is busy mirroring.
 *   2. **`GraftOrphanBanner`** — the yellow "Graft was interrupted" banner with Restore and
 *      Dismiss, shown above the repo list when a crash left a breadcrumb behind.
 *   3. **`GraftSwapDialog`** — "Already grafting into <repo>", with the destructive "Stop
 *      existing & swap" and the cancelling "Keep existing".
 *
 * Nothing here talks to a socket or a store: state arrives as props, intent leaves as callbacks
 * (the `Inspector`'s own contract), so all three render from a fixture in a test.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { useModalPresence } from './modal-presence';
import { tokens } from './tokens';
import type { GraftOrphanView, GraftSessionView, GraftSwapPrompt } from '../state/graft';

/**
 * §GIT-047's four dot colors. Yellow is the chrome's own amber (the same one an active agent
 * uses), green and red match the inspector's git-status dots so one row never shows two
 * different greens.
 */
export const GRAFT_DOT_COLORS: Readonly<Record<GraftSessionView['status'], string>> = {
    starting: '#D3A329',
    syncing: '#D3A329',
    watching: '#5FBE89',
    error: '#E0655C'
};

const PULSE_KEYFRAMES = `@keyframes nex-graft-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.82); }
}`;

/** One `<style>` for the pulse, mounted once however many rows are on screen. */
function usePulseKeyframes(): void {
    useEffect(() => {
        const id = 'nex-graft-pulse-style';
        if (document.getElementById(id) !== null) return;
        const element = document.createElement('style');
        element.id = id;
        element.textContent = PULSE_KEYFRAMES;
        document.head.append(element);
    }, []);
}

/**
 * `arrow.triangle.2.circlepath` and its `.circle.fill` sibling, redrawn on the chrome's 12×12
 * grid: two arcs chasing each other, each ending in an arrowhead. The "session present" variant
 * fills the disc behind them, which is what makes an active row readable at a glance even
 * before the eye reaches the dot.
 */
function GraftGlyph({ filled }: { readonly filled: boolean }): ReactElement {
    return (
        <svg
            viewBox="0 0 12 12"
            width={12}
            height={12}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            data-icon={filled ? 'graft-active' : 'graft'}
        >
            {filled ? <circle cx="6" cy="6" r="5.2" fill="currentColor" opacity="0.22" stroke="none" /> : null}
            <path d="M2.2 6a3.8 3.8 0 0 1 6.3-2.8" />
            <path d="M9.8 6a3.8 3.8 0 0 1-6.3 2.8" />
            <path d="M8.9 1.6v1.9H7" />
            <path d="M3.1 10.4V8.5H5" />
        </svg>
    );
}

export interface GraftToggleButtonProps {
    /** The row's association id, used for the test id so a step can find one row's button. */
    readonly associationID: string;
    readonly session: GraftSessionView | undefined;
    readonly tooltip: string;
    readonly onToggle: () => void;
}

export function GraftToggleButton(props: GraftToggleButtonProps): ReactElement {
    usePulseKeyframes();
    const [hover, setHover] = useState(false);
    const session = props.session;
    return (
        <span className="relative inline-flex h-5 w-5 shrink-0">
            <button
                type="button"
                aria-label={props.tooltip}
                title={props.tooltip}
                data-testid={`graft-toggle-${props.associationID}`}
                data-graft-status={session?.status ?? 'none'}
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px]"
                style={{
                    color: hover || session !== undefined ? tokens.textPrimary : tokens.textSecondary,
                    background: hover ? tokens.selectionFill : 'transparent'
                }}
                onMouseEnter={() => {
                    setHover(true);
                }}
                onMouseLeave={() => {
                    setHover(false);
                }}
                onClick={(event) => {
                    event.stopPropagation();
                    props.onToggle();
                }}
            >
                <GraftGlyph filled={session !== undefined} />
            </button>
            {session === undefined ? null : (
                <span
                    data-testid={`graft-dot-${props.associationID}`}
                    data-status={session.status}
                    role="img"
                    aria-label={props.tooltip}
                    // §GIT-047: 5 pt, offset into the top-trailing corner of the button.
                    className="pointer-events-none absolute h-[5px] w-[5px] rounded-full"
                    style={{
                        top: -2,
                        right: -2,
                        background: GRAFT_DOT_COLORS[session.status],
                        animation: session.status === 'syncing' ? 'nex-graft-pulse 1.1s ease-in-out infinite' : 'none'
                    }}
                />
            )}
        </span>
    );
}

// ── the orphan banner (§GIT-051 / §WS-145) ──────────────────────────────────────────

function lastPathComponent(value: string): string {
    const trimmed = value.replace(/\/+$/, '');
    const index = trimmed.lastIndexOf('/');
    return index < 0 ? trimmed : trimmed.slice(index + 1);
}

export interface GraftOrphanBannerProps {
    readonly orphan: GraftOrphanView;
    readonly onRestore: () => void;
    readonly onDismiss: () => void;
}

/**
 * The banner the user sees after a crash: an unclean shutdown left the parent checkout holding
 * the worktree's content, with the pre-graft branch, SHA and stash recorded in a breadcrumb.
 * "Restore" replays the stop sequence from it; "Dismiss" deletes the breadcrumb only.
 */
export function GraftOrphanBanner(props: GraftOrphanBannerProps): ReactElement {
    return (
        <div
            data-testid={`graft-orphan-${props.orphan.associationID}`}
            role="status"
            className="flex items-start gap-2 rounded-md p-2"
            style={{
                background: 'rgba(211, 163, 41, 0.12)',
                border: '1px solid rgba(211, 163, 41, 0.35)'
            }}
        >
            <svg viewBox="0 0 12 12" width={11} height={11} className="mt-[2px] shrink-0" aria-hidden>
                <path d="M6 1.4 11.2 10.6H0.8Z" fill="#D3A329" />
                <path d="M6 4.6v2.6" stroke="#1A1A1E" strokeWidth={1.1} strokeLinecap="round" />
                <circle cx="6" cy="8.9" r="0.6" fill="#1A1A1E" />
            </svg>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[12px] font-semibold" style={{ color: tokens.textPrimary }}>
                    Graft was interrupted
                </span>
                <span className="truncate text-[10px]" style={{ color: tokens.textSecondary }}>
                    {lastPathComponent(props.orphan.parentRepoRoot)}
                </span>
                <div className="flex gap-2 pt-0.5">
                    {/* Restore is the recommended answer, so it is the one that reads as a
                        button rather than a link. */}
                    <button
                        type="button"
                        data-testid={`graft-orphan-restore-${props.orphan.associationID}`}
                        className="cursor-pointer rounded border px-1.5 py-[1px] text-[11px] font-medium"
                        style={{
                            borderColor: 'rgba(211, 163, 41, 0.55)',
                            background: 'rgba(211, 163, 41, 0.18)',
                            color: tokens.textPrimary
                        }}
                        onClick={props.onRestore}
                    >
                        Restore
                    </button>
                    <button
                        type="button"
                        data-testid={`graft-orphan-dismiss-${props.orphan.associationID}`}
                        className="cursor-pointer rounded border px-1.5 py-[1px] text-[11px]"
                        style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                        onClick={props.onDismiss}
                    >
                        Dismiss
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── the swap dialog (§GIT-050 / §WS-144) ────────────────────────────────────────────

export interface GraftSwapDialogProps {
    readonly prompt: GraftSwapPrompt;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
    /** Test seam: where the portal mounts. Defaults to `document.body`. */
    readonly container?: HTMLElement | null | undefined;
}

/**
 * §GIT-050's confirmation. Escape and the backdrop both CANCEL, which is what the shipped
 * `confirmationDialog`'s dismiss binding does — dismissing must never silently swap.
 */
export function GraftSwapDialog(props: GraftSwapDialogProps): ReactElement | null {
    const container = props.container ?? (typeof document === 'undefined' ? null : document.body);
    const onCancel = props.onCancel;
    /*
     * H1: park a live web pane while the prompt is up. `docs/audit/run-O/83-graft-swap-prompt-
     * prompt.png` is this dialog cut to "Kee" with the swap button gone — it renders inside the
     * inspector, which is why the assembly cannot see it from a prompt-shaped predicate.
     */
    useModalPresence();
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            onCancel();
        };
        window.addEventListener('keydown', onKey, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
        };
    }, [onCancel]);
    if (container === null) return null;

    const prompt = props.prompt;
    const repoName = lastPathComponent(prompt.parentRepoRoot);
    const existingWorktree = lastPathComponent(prompt.existingWorktreePath);
    const newWorktree = lastPathComponent(prompt.newWorktreePath);
    return createPortal(
        <>
            <div
                data-testid="graft-swap-backdrop"
                className="fixed inset-0 z-40"
                style={{ background: 'rgba(0,0,0,0.35)' }}
                onClick={props.onCancel}
            />
            <div
                data-testid="graft-swap-dialog"
                role="dialog"
                aria-label={`Already grafting into ${repoName}`}
                className="fixed left-1/2 top-1/3 z-50 w-[340px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary,
                    boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
                }}
            >
                <div className="mb-2 text-[13px] font-semibold">{`Already grafting into ${repoName}`}</div>
                <div className="mb-3 text-[11px]" style={{ color: tokens.textSecondary }}>
                    {`${prompt.existingBranch} (${existingWorktree}) is already grafting into this repository. ` +
                        `Only one graft per parent repo is allowed. Swap to mirror ${prompt.newBranch} ` +
                        `(${newWorktree}) instead, or keep the existing graft and resolve manually.`}
                </div>
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        data-testid="graft-swap-keep"
                        className="cursor-pointer"
                        style={{ color: tokens.textSecondary }}
                        onClick={props.onCancel}
                    >
                        Keep existing
                    </button>
                    <button
                        type="button"
                        data-testid="graft-swap-confirm"
                        className="cursor-pointer"
                        style={{ color: '#E0655C' }}
                        onClick={props.onConfirm}
                    >
                        Stop existing &amp; swap
                    </button>
                </div>
            </div>
        </>,
        container
    );
}

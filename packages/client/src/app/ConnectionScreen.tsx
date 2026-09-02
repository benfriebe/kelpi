/**
 * The two surfaces that speak for the socket rather than for the daemon's state.
 *
 * `ConnectionSplash` is the full cover for a client that has never had a snapshot: there is
 * literally nothing else to draw, so it owns the window. `ConnectionBanner` is the opposite
 * case - the mirror IS on screen and was true as of the drop, so the banner says only that it
 * may now be stale and leaves the view alone.
 *
 * They live here, and not at the bottom of `App.tsx` where they were written, because App.tsx
 * is a 5,000-line shared surface: the phone work has one lane rewriting App's root render and
 * another rewriting this copy for a small screen, and two lanes editing one file is a merge
 * conflict scheduled in advance. Nothing about the behaviour changed in the move - same test
 * ids, same copy, same props.
 */

import type { ReactElement } from 'react';

import { tokens as chromeTokens } from '../chrome/tokens';
import type { KelpiRuntime } from '../state';
import { describeTarget, type DaemonTarget } from './config';

const SPLASH_TITLE: Readonly<Record<string, string>> = {
    idle: 'Connecting to kelpid…',
    connecting: 'Connecting to kelpid…',
    connected: 'Loading workspaces…',
    reconnecting: 'Reconnecting to kelpid…',
    closed: 'Disconnected from kelpid',
    rejected: 'The daemon refused this connection'
};

const SPLASH_HINT: Readonly<Record<string, string>> = {
    idle: '',
    connecting: '',
    connected: 'the daemon accepted the handshake; waiting for the first state snapshot',
    reconnecting: 'the socket dropped - retrying with backoff',
    closed: 'nothing is listening; start it with `kelpid start`',
    // A rejection is almost always a missing/stale token, and there is exactly one command that
    // produces a working link — so name it rather than describing the problem in the abstract.
    rejected: 'open this page from `kelpid url`, which includes the daemon token'
};

export interface ConnectionSplashProps {
    readonly runtime: KelpiRuntime;
    readonly state: { readonly ui: { readonly connection: string; readonly connectionError: string | null } };
    readonly target: DaemonTarget;
}

/** Full-cover state for a client that has never had a snapshot: there is nothing to show yet. */
export function ConnectionSplash({ runtime, state, target }: ConnectionSplashProps): ReactElement {
    const status = state.ui.connection;
    const rejected = status === 'rejected';
    const retryable = status === 'closed' || rejected;
    return (
        <div
            data-testid="connection-splash"
            data-status={status}
            className="absolute inset-0 z-30 flex items-center justify-center p-6"
            style={{ background: chromeTokens.windowBackground }}
        >
            <div
                className="flex w-full max-w-sm flex-col items-center gap-2 rounded-lg px-6 py-5 text-center"
                style={{ background: chromeTokens.surfaceBackground, border: `1px solid ${chromeTokens.divider}` }}
            >
                <span className="text-[13px] font-semibold" style={{ color: chromeTokens.textPrimary }}>
                    {SPLASH_TITLE[status] ?? 'Connecting…'}
                </span>
                <span className="font-mono text-[11px]" style={{ color: chromeTokens.textTertiary }}>
                    {describeTarget(target)}
                </span>
                {state.ui.connectionError === null ? null : (
                    <span
                        data-testid="connection-error"
                        /* A refusal is the whole message when the daemon has said why: it gets
                           the body text, not a footnote's size, so "invalid or missing daemon
                           token" is the first thing read rather than something to squint at. */
                        className={rejected ? 'text-[13px] font-medium' : 'text-[11px]'}
                        style={{ color: '#E0655C' }}
                    >
                        {state.ui.connectionError}
                    </span>
                )}
                <span className="text-[11px]" style={{ color: chromeTokens.textSecondary }}>
                    {SPLASH_HINT[status] ?? ''}
                </span>
                {retryable ? (
                    <button
                        type="button"
                        data-testid="connection-retry"
                        className="mt-1 rounded px-3 py-1 text-[12px]"
                        style={{
                            background: chromeTokens.headerBackground,
                            color: chromeTokens.textPrimary,
                            border: `1px solid ${chromeTokens.divider}`
                        }}
                        onClick={() => runtime.connect()}
                    >
                        Try again
                    </button>
                ) : null}
            </div>
        </div>
    );
}

export interface ConnectionBannerProps {
    readonly status: string;
    readonly error: string | null;
    readonly runtime: KelpiRuntime;
}

/** The mirror is still on screen (and still true as of the drop); this says it may be stale. */
export function ConnectionBanner({ status, error, runtime }: ConnectionBannerProps): ReactElement {
    const rejected = status === 'rejected';
    const dead = status === 'closed' || rejected;
    return (
        <div
            data-testid="connection-banner"
            data-status={status}
            role="status"
            className="pointer-events-auto absolute left-1/2 top-2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1 text-[11px]"
            style={{
                background: chromeTokens.surfaceBackground,
                border: `1px solid ${chromeTokens.divider}`,
                color: chromeTokens.textSecondary,
                boxShadow: '0 6px 20px rgba(0,0,0,0.3)'
            }}
        >
            <span
                aria-hidden
                className="h-[7px] w-[7px] rounded-full"
                style={{ background: dead ? '#E0655C' : chromeTokens.activeAgent }}
            />
            <span>
                {rejected
                    ? 'The daemon refused this connection'
                    : dead
                      ? 'Disconnected - the view may be stale'
                      : 'Reconnecting…'}
            </span>
            {error === null ? null : (
                // A refusal's text is the actionable part ("open the client via `kelpid url`"),
                // so it is not dimmed into a footnote the way a transient socket error is.
                <span data-testid="connection-banner-error" style={{ color: rejected ? '#E0655C' : chromeTokens.textTertiary }}>
                    {error}
                </span>
            )}
            {dead ? (
                <button
                    type="button"
                    className="underline"
                    style={{ color: chromeTokens.textPrimary }}
                    onClick={() => runtime.connect()}
                >
                    retry
                </button>
            ) : null}
        </div>
    );
}

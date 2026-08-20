/**
 * Graft's client-side state machine — the port of `Nex/Features/Graft/GraftFeature.swift`.
 *
 * The daemon owns the engine (sessions, sync passes, breadcrumbs, the one-graft-per-parent
 * claim). What lives here is everything the Swift reducer owned and the engine deliberately
 * does not:
 *
 *   - the **optimistic `.starting` placeholder** so the inspector's icon flips the instant the
 *     user clicks, before any git has run (§GIT-035);
 *   - the **`.error` placeholder** a failed start or a failed stop leaves behind, which is what
 *     keeps the red dot and its tooltip on screen until the user retries (§GIT-036);
 *   - the **swap prompt** raised when a start is refused because another worktree already
 *     claims the same parent repo (§GIT-038…§GIT-042);
 *   - the **orphan list** behind the "Graft was interrupted" banner, including re-inserting an
 *     orphan whose recovery failed — the breadcrumb and the stash are still on disk and the
 *     banner is the only affordance to try again (§GIT-045).
 *
 * Pure: a reducer plus parsers. The command traffic that drives it is `app/graft.ts`, which is
 * the effect half of the same feature and is where the Swift `.run { … }` bodies went.
 */

import type { CommandReply } from '../connection';

export type GraftStatusKind = 'starting' | 'syncing' | 'watching' | 'error';

export interface GraftSessionView {
    readonly associationID: string;
    readonly worktreePath: string;
    /** Empty for a client-minted placeholder — the daemon has not resolved it yet. */
    readonly parentRepoRoot: string;
    readonly branch: string;
    readonly status: GraftStatusKind;
    /** Only ever set for `status === 'error'`. */
    readonly error: string | null;
    /** Epoch ms of the last successful sync, or null. */
    readonly lastSyncAt: number | null;
}

export interface GraftOrphanView {
    readonly associationID: string;
    readonly parentRepoRoot: string;
    readonly worktreePath: string;
    readonly branch: string;
}

/** "You are already grafting <other worktree> into this repo — what now?" (§GIT-038). */
export interface GraftSwapPrompt {
    /** The association the user just toggled; identity, so a second toggle cannot queue two. */
    readonly associationID: string;
    readonly newBranch: string;
    readonly newWorktreePath: string;
    readonly existingSessionID: string;
    readonly existingBranch: string;
    readonly existingWorktreePath: string;
    readonly parentRepoRoot: string;
}

export interface GraftState {
    readonly sessions: Readonly<Record<string, GraftSessionView>>;
    readonly orphans: readonly GraftOrphanView[];
    readonly swapPrompt: GraftSwapPrompt | null;
}

export const EMPTY_GRAFT_STATE: GraftState = { sessions: {}, orphans: [], swapPrompt: null };

export type GraftAction =
    /** The `graft-changed` broadcast (or a `graft-session-list` reply): the engine's whole set. */
    | { readonly kind: 'sessions'; readonly sessions: readonly GraftSessionView[] }
    /** The `graft-orphans` broadcast. */
    | { readonly kind: 'orphans'; readonly orphans: readonly GraftOrphanView[] }
    | { readonly kind: 'start-requested'; readonly session: GraftSessionView }
    | { readonly kind: 'start-succeeded'; readonly session: GraftSessionView }
    | { readonly kind: 'start-failed'; readonly session: GraftSessionView }
    /** Drop the placeholder without leaving an error behind (the swap paths). */
    | { readonly kind: 'session-dropped'; readonly associationID: string }
    | { readonly kind: 'adopt-session'; readonly session: GraftSessionView }
    | { readonly kind: 'stop-succeeded'; readonly associationID: string }
    | { readonly kind: 'stop-failed'; readonly associationID: string; readonly error: string }
    | { readonly kind: 'swap-prompt'; readonly prompt: GraftSwapPrompt }
    | { readonly kind: 'swap-cancelled' }
    | { readonly kind: 'orphan-removed'; readonly associationID: string }
    | { readonly kind: 'orphan-restored'; readonly orphan: GraftOrphanView };

function withSession(state: GraftState, session: GraftSessionView): GraftState {
    return { ...state, sessions: { ...state.sessions, [session.associationID]: session } };
}

function withoutSession(state: GraftState, associationID: string): GraftState {
    if (state.sessions[associationID] === undefined) return state;
    const sessions = { ...state.sessions };
    delete sessions[associationID];
    return { ...state, sessions };
}

/**
 * The engine's list is authoritative for everything the engine knows about. The two states it
 * cannot know about survive it:
 *
 *   - `starting` — the placeholder for a start still in flight. The engine publishes nothing
 *     until the session exists, so dropping it here would make the icon flicker back.
 *   - `error` — a failure the engine reported to THIS client and then forgot (a start that
 *     never produced a session, or a stop that threw). It is the user's only record of it.
 *
 * Anything else the engine no longer lists has genuinely stopped — including a stop another
 * window performed, which is exactly how a second client's toggle reaches this one.
 */
export function mergeSessions(
    state: GraftState,
    incoming: readonly GraftSessionView[]
): GraftState {
    const sessions: Record<string, GraftSessionView> = {};
    for (const session of incoming) sessions[session.associationID] = session;
    for (const [id, session] of Object.entries(state.sessions)) {
        if (sessions[id] !== undefined) continue;
        if (session.status === 'starting' || session.status === 'error') sessions[id] = session;
    }
    return { ...state, sessions };
}

export function graftReducer(state: GraftState, action: GraftAction): GraftState {
    switch (action.kind) {
        case 'sessions':
            return mergeSessions(state, action.sessions);
        case 'orphans':
            return { ...state, orphans: [...action.orphans] };
        case 'start-requested':
        case 'start-succeeded':
        case 'start-failed':
        case 'adopt-session':
            return withSession(state, action.session);
        case 'session-dropped':
        case 'stop-succeeded':
            return withoutSession(state, action.associationID);
        case 'stop-failed': {
            // §GIT-036: a stop that fails leaves the session in place, marked `.error` — it may
            // well still be running, and removing the row would strand it.
            const existing = state.sessions[action.associationID];
            if (existing === undefined) return state;
            return withSession(state, { ...existing, status: 'error', error: action.error });
        }
        case 'swap-prompt':
            return { ...state, swapPrompt: action.prompt };
        case 'swap-cancelled':
            return { ...state, swapPrompt: null };
        case 'orphan-removed':
            return {
                ...state,
                orphans: state.orphans.filter((orphan) => orphan.associationID !== action.associationID)
            };
        case 'orphan-restored':
            return state.orphans.some((orphan) => orphan.associationID === action.orphan.associationID)
                ? state
                : { ...state, orphans: [...state.orphans, action.orphan] };
    }
}

// ── wire parsing ────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function statusOf(value: unknown): GraftStatusKind {
    return value === 'starting' || value === 'syncing' || value === 'error' ? value : 'watching';
}

/** `last_sync` is second-precision ISO 8601; anything unparseable is "no sync yet". */
function timestampOf(value: unknown): number | null {
    if (typeof value !== 'string' || value === '') return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function parseGraftSession(raw: unknown): GraftSessionView | null {
    if (!isRecord(raw)) return null;
    const associationID = text(raw['association_id']);
    if (associationID === '') return null;
    const status = statusOf(raw['status']);
    return {
        associationID,
        worktreePath: text(raw['worktree_path']),
        parentRepoRoot: text(raw['parent_repo_root']),
        branch: text(raw['branch']),
        status,
        error: status === 'error' ? text(raw['error']) : null,
        lastSyncAt: timestampOf(raw['last_sync'])
    };
}

export function parseGraftSessions(value: unknown): readonly GraftSessionView[] {
    if (!Array.isArray(value)) return [];
    const parsed: GraftSessionView[] = [];
    for (const row of value) {
        const session = parseGraftSession(row);
        if (session !== null) parsed.push(session);
    }
    return parsed;
}

export function parseGraftOrphans(value: unknown): readonly GraftOrphanView[] {
    if (!Array.isArray(value)) return [];
    const parsed: GraftOrphanView[] = [];
    for (const row of value) {
        if (!isRecord(row)) continue;
        const associationID = text(row['association_id']);
        if (associationID === '') continue;
        parsed.push({
            associationID,
            parentRepoRoot: text(row['parent_repo_root']),
            worktreePath: text(row['worktree_path']),
            branch: text(row['branch'])
        });
    }
    return parsed;
}

/** `graft-session-list`'s reply carries both halves. */
export function parseGraftSnapshot(reply: CommandReply): {
    sessions: readonly GraftSessionView[];
    orphans: readonly GraftOrphanView[];
} {
    return {
        sessions: parseGraftSessions(reply['sessions']),
        orphans: parseGraftOrphans(reply['orphans'])
    };
}

// ── the placeholders the reducer mints ──────────────────────────────────────────────

/**
 * §GIT-035's optimistic row: the association's own branch and path, no parent root yet (the
 * daemon resolves that), so the icon flips and the dot goes solid yellow immediately.
 */
export function startingPlaceholder(input: {
    associationID: string;
    worktreePath: string;
    branch: string | null;
}): GraftSessionView {
    return {
        associationID: input.associationID,
        worktreePath: input.worktreePath,
        parentRepoRoot: '',
        branch: input.branch ?? '',
        status: 'starting',
        error: null,
        lastSyncAt: null
    };
}

export function errorPlaceholder(input: {
    associationID: string;
    worktreePath: string;
    branch: string | null;
    message: string;
}): GraftSessionView {
    return {
        associationID: input.associationID,
        worktreePath: input.worktreePath,
        parentRepoRoot: '',
        branch: input.branch ?? '',
        status: 'error',
        error: input.message,
        lastSyncAt: null
    };
}

// ── the tooltip copy (§GIT-048) ─────────────────────────────────────────────────────

const RELATIVE_UNITS: readonly { readonly limitMs: number; readonly divisor: number; readonly unit: Intl.RelativeTimeFormatUnit }[] = [
    { limitMs: 60_000, divisor: 1_000, unit: 'second' },
    { limitMs: 3_600_000, divisor: 60_000, unit: 'minute' },
    { limitMs: 86_400_000, divisor: 3_600_000, unit: 'hour' },
    { limitMs: Number.POSITIVE_INFINITY, divisor: 86_400_000, unit: 'day' }
];

/**
 * `RelativeDateTimeFormatter` with `.short` — "2 min. ago", "1 hr. ago". `Intl` is the same
 * data source, so "narrow" is closest to what the shipped tooltip reads like.
 */
export function relativeTime(from: number, now: number): string {
    const deltaMs = from - now;
    const magnitude = Math.abs(deltaMs);
    const scale = RELATIVE_UNITS.find((entry) => magnitude < entry.limitMs) ?? RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
    if (scale === undefined) return 'just now';
    const value = Math.round(deltaMs / scale.divisor);
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' }).format(value, scale.unit);
}

/**
 * §GIT-048's five strings, verbatim from `GraftInspectorButton.tooltipText`. They are the only
 * explanation of what graft DOES that the user ever sees, so they are ported word for word.
 */
export function graftTooltip(input: {
    session: GraftSessionView | undefined;
    branch: string | null;
    now?: number;
}): string {
    const session = input.session;
    if (session === undefined) {
        const branch = input.branch ?? 'this worktree';
        return (
            `Mirror ${branch}'s tracked files into the parent repo's working tree. ` +
            "Parent's branch stays put; untracked files (node_modules, build output) are untouched."
        );
    }
    switch (session.status) {
        case 'starting':
            return 'Starting graft...';
        case 'syncing':
            return `Syncing ${session.branch}...`;
        case 'watching': {
            const lastSync =
                session.lastSyncAt === null
                    ? 'Watching'
                    : `Last sync ${relativeTime(session.lastSyncAt, input.now ?? Date.now())}`;
            return (
                `Mirroring ${session.branch} into the parent. ${lastSync}. ` +
                "Stop to restore the parent's working tree."
            );
        }
        case 'error':
            return `Graft error: ${session.error ?? ''}`;
    }
}

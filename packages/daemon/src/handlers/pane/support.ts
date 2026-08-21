/**
 * Shared plumbing for the `pane-*` handlers.
 *
 * Spec: docs/current/socket-handlers.md §1 (reply contract), §2 (resolution), §4, §5
 * (refreshSyncGroup); docs/current/wire-protocol.md §6 (reply framing + key names).
 *
 * Two rules drive the shapes here:
 *  - a reply is ONE JSON line then EOF, and every failure is exactly
 *    `{"ok":false,"error":"<message>"}` with the error strings copied byte-for-byte;
 *  - `reply == null` (legacy fire-and-forget CLIs) must still run every guard and perform
 *    the side effect on success; the reply handle is never load-bearing for a mutation.
 */

import { type EpochSeconds, formatWireTimestamp, newUUID } from '@nex/core/codec';
import {
    buildPanePath,
    DEFAULT_PROFILE_NAME,
    effectiveProfileName,
    type EnvVar,
    FALLBACK_PATH,
    isDefinedProfile,
    mergedEnvVars,
    normalizedAssignment,
    resolveProfileEnv
} from '@nex/core/env';
import type { Pane } from '@nex/core/layout';
import { resolvePaneTarget } from '@nex/core/resolve';

import { DEFAULT_COLS, DEFAULT_ROWS } from '../../pty/index.js';
import type { ReplyHandle } from '../../seams.js';
import {
    resolveStateOf,
    syncedPaneIDs,
    visiblePane,
    workspaceByID,
    type DaemonState,
    type WorkspaceState
} from '../../store/index.js';
import type { PaneHandlerContext } from './context.js';

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** Send one success line (`ok:true` first) and close. No-op without a handle. */
export function sendOK(reply: ReplyHandle | null, payload: Record<string, unknown>): void {
    if (reply === null) return;
    reply.send({ ok: true, ...payload });
    reply.close();
}

/** Send `{"ok":false,"error":…}` (+ typed extras) and close. No-op without a handle. */
export function sendError(
    reply: ReplyHandle | null,
    error: string,
    extras: Record<string, unknown> = {}
): void {
    if (reply === null) return;
    reply.send({ ok: false, error, ...extras });
    reply.close();
}

/** `label` rides along only when the pane has (or was given) a non-empty one. */
export function labelField(label: string | null | undefined): Record<string, string> {
    return label === null || label === undefined || label === '' ? {} : { label };
}

// ---------------------------------------------------------------------------
// Injected bits (production leaves them unset)
// ---------------------------------------------------------------------------

/** Epoch MILLISECONDS; every action that timestamps carries this. */
export function nowMillis(ctx: PaneHandlerContext): number {
    return (ctx.clock ?? Date.now)();
}

/**
 * A fresh pane id. Minted at the top of a handler and threaded into both the reply and the
 * dispatch, with no await in between (wire-protocol.md port note 3).
 */
export function mintPaneID(ctx: PaneHandlerContext): string {
    return (ctx.mintPaneID ?? newUUID)();
}

export function mintWorkspaceID(ctx: PaneHandlerContext): string {
    return (ctx.mintWorkspaceID ?? ctx.mintPaneID ?? newUUID)();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface PaneTargetRequestFields {
    readonly pane_id?: string | undefined;
    readonly target?: string | undefined;
    readonly workspace?: string | undefined;
}

export type ResolvedPaneTarget =
    | {
          readonly ok: true;
          readonly paneID: string;
          readonly pane: Pane;
          readonly workspace: WorkspaceState;
      }
    | { readonly ok: false; readonly error: string };

/**
 * `resolvePaneTarget` (§2.4) against live daemon state, then the defensive pane/workspace
 * re-lookup every handler does before touching anything. The resolver's error strings pass
 * through verbatim: they are wire contract.
 */
export function resolveTarget(
    ctx: PaneHandlerContext,
    fields: PaneTargetRequestFields
): ResolvedPaneTarget {
    const state = ctx.store.getState();
    const resolution = resolvePaneTarget(resolveStateOf(state), {
        paneID: fields.pane_id,
        target: fields.target,
        workspaceFilter: fields.workspace
    });
    if (!resolution.ok) return { ok: false, error: resolution.error };
    const workspace = workspaceByID(state, resolution.workspace.id);
    if (workspace === null) return { ok: false, error: 'workspace not found' };
    const pane = visiblePane(workspace, resolution.paneID);
    if (pane === null) return { ok: false, error: `pane not found: ${resolution.paneID}` };
    return { ok: true, paneID: resolution.paneID, pane, workspace };
}

// ---------------------------------------------------------------------------
// Side effects the handlers own
// ---------------------------------------------------------------------------

/**
 * §5 `refreshSyncGroup`: any change to a workspace's pane set, sync flag or exclusion set
 * pushes the freshly computed broadcast group into the keystroke-mirroring layer. Wholesale
 * replace; an empty set deletes the group.
 */
export function refreshSyncGroup(ctx: PaneHandlerContext, workspaceID: string): void {
    const workspace = workspaceByID(ctx.store.getState(), workspaceID);
    ctx.pty.setSyncGroup(
        workspaceID,
        new Set(workspace === null ? [] : syncedPaneIDs(workspace))
    );
}

/** The spawn env of a pane in this workspace (config-keybindings.md §9.1–9.3). */
export function spawnEnvVars(
    ctx: PaneHandlerContext,
    paneID: string,
    workspace: WorkspaceState
): EnvVar[] {
    const profiles = ctx.profiles?.() ?? [];
    const helpersDir = ctx.spawn?.helpersDir;
    const inherited = ctx.spawn?.inheritedPath ?? process.env['PATH'] ?? null;
    // No helpers dir (headless/dev boot) must NOT yield a leading ":" in PATH, because an empty
    // PATH element means "the current directory" to every shell.
    const path =
        helpersDir === undefined || helpersDir === ''
            ? (inherited === null || inherited === '' ? FALLBACK_PATH : inherited)
            : buildPanePath(helpersDir, inherited);
    const profileName = effectiveProfileName(normalizedAssignment(workspace.profileName));
    /*
     * §SET-209. The marker is injected either way (that is the load-bearing half, and
     * `resolveProfileEnv` does it unconditionally), but a NON-`default` name with no `profile`
     * lines behind it is almost always a typo in `nex workspace profile` or a profile the user
     * deleted from the config — and without a word it is indistinguishable from a working
     * assignment. An empty `default` is expected and is never warned about.
     */
    if (profileName !== DEFAULT_PROFILE_NAME && !isDefinedProfile(profiles, profileName)) {
        ctx.onLog?.(
            `workspace "${workspace.name}" uses profile "${profileName}", which has no ` +
                'profile = lines in ~/.config/nex/config; only NEX_PROFILE will be set'
        );
    }
    const profileEnv = resolveProfileEnv(profiles, profileName);
    return mergedEnvVars({ paneID, path, profileEnv });
}

/**
 * Give a freshly created SHELL pane its PTY and server-side terminal state. Idempotent per
 * pane id (the manager's `spawn` is too); non-shell panes have no surface at all.
 */
export function spawnPaneIfShell(
    ctx: PaneHandlerContext,
    workspaceID: string,
    paneID: string
): void {
    const workspace = workspaceByID(ctx.store.getState(), workspaceID);
    if (workspace === null) return;
    const pane = visiblePane(workspace, paneID);
    if (pane === null || pane.type !== 'shell') return;
    if (ctx.pty.has(paneID)) return;
    // Last-known geometry first: a split's child that starts at 80×24 prints its first prompt
    // at a width nothing will ever render it at, and that line never reflows (`pty/geometry.ts`).
    const remembered = ctx.spawn?.sizeFor?.(paneID) ?? null;
    const cols = remembered?.cols ?? ctx.spawn?.cols ?? DEFAULT_COLS;
    const rows = remembered?.rows ?? ctx.spawn?.rows ?? DEFAULT_ROWS;
    ctx.pty.spawn({
        paneID,
        cwd: pane.workingDirectory,
        env: spawnEnvVars(ctx, paneID, workspace).map(
            (entry) => [entry.key, entry.value] as const
        ),
        cols,
        rows,
        shell: ctx.spawn?.shell
    });
    ctx.term.attach(paneID, cols, rows);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * ISO 8601 UTC at SECONDS precision. Pane timestamps are epoch seconds (the Swift/GRDB
 * encoding); the branded `EpochSeconds` cast is safe because every writer goes through
 * `epochSecondsFrom*`, and a corrupt DB degrades to a wrong-but-formatted timestamp rather
 * than throwing inside a reply.
 */
export function wireTimestamp(seconds: number): string {
    if (!Number.isFinite(seconds)) return formatWireTimestamp(0 as EpochSeconds);
    return formatWireTimestamp(seconds as EpochSeconds);
}

/**
 * `tailLines(text, n)` (§4.7): last `n` newline-separated segments, EMPTY SEGMENTS KEPT, with
 * the trailing newline preserved when the input had one.
 */
export function tailLines(text: string, count: number): string {
    if (count <= 0 || text === '') return '';
    const hadTrailingNewline = text.endsWith('\n');
    const body = hadTrailingNewline ? text.slice(0, -1) : text;
    const parts = body.split('\n');
    const out = parts.slice(Math.max(0, parts.length - count)).join('\n');
    return hadTrailingNewline ? `${out}\n` : out;
}

/** The workspace holding a VISIBLE pane; user commands never address parked panes. */
export function workspaceOfVisiblePane(
    state: DaemonState,
    paneID: string
): WorkspaceState | null {
    return state.workspaces.find((workspace) => workspace.panes.some((p) => p.id === paneID)) ?? null;
}

/**
 * `reopen-closed-pane`, `create-scratchpad` and `reveal-path` — three GUI gestures the CLI has
 * no verb for.
 *
 * WS-only for the usual reason (see `WS_ONLY_COMMANDS`), but on their own channel rather than
 * inside `handleWsOnlyCommand` because none of them is *only* a store dispatch:
 *
 *  - **reopen** has to give the restored pane a PTY, and then — 2 seconds later — type the
 *    agent's resume command into it (workspace-feature.md §7.9 / `WorkspaceFeature.swift:1906-1969`).
 *  - **scratchpad** mints a pane id the reply has to carry back, the same pre-minted-id
 *    contract `pane-split` honours (wire-protocol.md port note 3).
 *  - **reveal-path** is not state at all: it asks whichever Electron shell is attached to run
 *    `shell.showItemInFolder`. The daemon has no Finder, so it broadcasts and the shell acts —
 *    the same shape `reveal-pane` already uses for "take the user to this pane".
 *
 * The reopen resume replay deserves its own note, because it is the half of the Swift rule the
 * reducer deliberately does not do. `store/reducers/panes.ts` restores label / cwd / type /
 * file path / scratchpad text / font size / web tabs but **not** `agentSessionID` — the Swift
 * app does the same, because a reopened pane has no live agent, it has a *command to type*. So
 * this channel reads the snapshot's session id and kind BEFORE dispatching (the reducer pops
 * the snapshot off the undo stack), then replays the boot-time pipeline: settle, then
 * `resumeCommand`, which applies `isSafeSessionID` — an id that fails the allowlist is skipped
 * silently rather than interpolated into a shell (persisted command injection).
 */

import { newUUID } from '@nex/core/codec';
import { displayAgentKind, resumeCommand } from '@nex/core/agent';
import type { JsonObject } from '@nex/protocol';

import { refreshSyncGroup, spawnPaneIfShell, type PaneHandlerContext } from '../handlers/pane/index.js';
import { visiblePane, workspaceByID } from '../store/derived.js';
import type { WorkspaceState } from '../store/types.js';

export const PANE_LIFECYCLE_COMMANDS = [
    'reopen-closed-pane',
    'create-scratchpad',
    'reveal-path'
] as const;
export type PaneLifecycleCommand = (typeof PANE_LIFECYCLE_COMMANDS)[number];

export function isPaneLifecycleCommand(command: string): command is PaneLifecycleCommand {
    return (PANE_LIFECYCLE_COMMANDS as readonly string[]).includes(command);
}

/** How long a reopened shell settles before its resume command is typed (§7.9: 2 s). */
export const REOPEN_RESUME_SETTLE_MS = 2000;

export interface PaneLifecycleChannel {
    run(command: PaneLifecycleCommand, payload: Record<string, unknown>): JsonObject;
}

export interface PaneLifecycleChannelOptions {
    readonly ctx: PaneHandlerContext;
    /** Test seam for the 2 s settle before the resume command is typed. */
    readonly sleep?: ((ms: number) => Promise<void>) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

function failure(error: string): JsonObject {
    return { ok: false, error };
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function realSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

export function createPaneLifecycleChannel(
    options: PaneLifecycleChannelOptions
): PaneLifecycleChannel {
    const { ctx } = options;
    const sleep = options.sleep ?? realSleep;
    const now = (): number => (ctx.clock ?? Date.now)();
    const mint = (): string => (ctx.mintPaneID ?? newUUID)();

    const workspaceFor = (payload: Record<string, unknown>): WorkspaceState | null => {
        const workspaceID = text(payload['workspace_id']);
        if (workspaceID === undefined) return null;
        return workspaceByID(ctx.store.getState(), workspaceID);
    };

    const reopen = (payload: Record<string, unknown>): JsonObject => {
        const workspace = workspaceFor(payload);
        if (workspace === null) return failure('reopen-closed-pane requires a known workspace_id');
        // Read the snapshot BEFORE dispatching: the reducer pops it, and the resume command is
        // built from fields (`agentSessionID`) the restored pane deliberately does not carry.
        const snapshot = workspace.recentlyClosedPanes[workspace.recentlyClosedPanes.length - 1];
        if (snapshot === undefined) return failure('no recently closed pane to reopen');

        const paneID = mint();
        ctx.store.dispatch({
            type: 'reopen-closed-pane',
            workspaceID: workspace.id,
            paneID,
            now: now()
        });

        // QUIRK (§7.9), preserved: with no focused pane the reducer consumes the snapshot and
        // creates nothing. Saying so beats reporting a pane id that does not exist.
        const after = workspaceByID(ctx.store.getState(), workspace.id);
        const pane = after === null ? null : visiblePane(after, paneID);
        if (pane === null) {
            return failure('nothing is focused in that workspace, so there is no split to reopen into');
        }

        spawnPaneIfShell(ctx, workspace.id, paneID);
        refreshSyncGroup(ctx, workspace.id);

        let resume: string | null = null;
        if (snapshot.type === 'shell' && snapshot.agentSessionID !== null) {
            const kind = displayAgentKind(snapshot.agentKind);
            resume = resumeCommand(kind, snapshot.agentSessionID);
            if (resume !== null) {
                const command = resume;
                void sleep(REOPEN_RESUME_SETTLE_MS).then(
                    () => {
                        // The pane may have been closed again while the shell settled.
                        if (!ctx.pty.has(paneID)) return;
                        try {
                            ctx.input.sendText(paneID, command, { bare: false });
                        } catch (error) {
                            options.onError?.(
                                error instanceof Error ? error : new Error(String(error)),
                                `reopen resume ${paneID}`
                            );
                        }
                    },
                    () => undefined
                );
            }
        }

        return {
            ok: true,
            pane_id: paneID,
            workspace_id: workspace.id,
            type: pane.type,
            ...(pane.label === null ? {} : { label: pane.label }),
            ...(resume === null ? {} : { resume_command: resume })
        };
    };

    const scratchpad = (payload: Record<string, unknown>): JsonObject => {
        const workspace = workspaceFor(payload);
        if (workspace === null) return failure('create-scratchpad requires a known workspace_id');
        const paneID = mint();
        ctx.store.dispatch({
            type: 'create-scratchpad',
            workspaceID: workspace.id,
            paneID,
            now: now()
        });
        // A scratchpad has no PTY (content-panes.md §6) — only the sync group can change.
        refreshSyncGroup(ctx, workspace.id);
        return { ok: true, pane_id: paneID, workspace_id: workspace.id };
    };

    const reveal = (payload: Record<string, unknown>): JsonObject => {
        const path = text(payload['path']);
        if (path === undefined) return failure('reveal-path requires path');
        // `select` distinguishes "reveal this file in its folder" from "open this folder"
        // (`PaneHeaderView.swift:408-416`): a markdown/diff pane names a FILE, everything else
        // names its working directory.
        const select = payload['select'] === true;
        ctx.broadcast({ type: 'reveal-path', path, select });
        return { ok: true, path, select };
    };

    return {
        run(command, payload) {
            if (command === 'reopen-closed-pane') return reopen(payload);
            if (command === 'create-scratchpad') return scratchpad(payload);
            return reveal(payload);
        }
    };
}

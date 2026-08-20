/**
 * Graft's effect half — the port of `GraftFeature`'s `.run { … }` bodies (§GIT-035…§GIT-045).
 *
 * `state/graft.ts` is the reducer; this is what talks to the daemon and decides which action to
 * dispatch next. It is deliberately framework-free (`createGraftController`), with a thin React
 * wrapper (`useGraft`) on top, so every branch below — including the two the user can only reach
 * by losing a race with another window — is unit-testable without rendering anything.
 *
 * The flows, each one the Swift reducer's:
 *
 *   **toggle** — no session: place the optimistic `.starting` row, then start. Live session:
 *   stop it. `.error` session: this is a RETRY (§GIT-037) — unwind through the service first,
 *   and only re-run start if the unwind succeeded, because a fresh start would overwrite the
 *   recovery breadcrumb and orphan the user's stash.
 *
 *   **alreadyActive** — the contested parent root comes back typed. If this client can see the
 *   owning session, prompt straight away; if it cannot (the owner's workspace was deleted, or
 *   another window started it), ask the SERVICE who owns the root (§GIT-039) and either re-adopt
 *   it silently when the owner IS this association (§GIT-040) or prompt against it. Only when
 *   nobody owns it does the user get an error.
 *
 *   **swap** — stop the existing session, then start the new one, sequentially (the claim has to
 *   be released before the start can succeed), with the two distinct failure messages §GIT-041
 *   specifies so the user knows which side survived.
 *
 *   **orphans** — recover optimistically and put the row back if recovery failed (§GIT-045).
 */

import { useCallback, useEffect, useMemo, useReducer } from 'react';

import type { CommandReply } from '../connection';
import {
    EMPTY_GRAFT_STATE,
    errorPlaceholder,
    graftReducer,
    parseGraftOrphans,
    parseGraftSession,
    parseGraftSessions,
    parseGraftSnapshot,
    startingPlaceholder,
    type GraftAction,
    type GraftOrphanView,
    type GraftSessionView,
    type GraftState,
    type GraftSwapPrompt
} from '../state/graft';

/** The association fields the controller needs; the inspector row has all of them. */
export interface GraftTarget {
    readonly id: string;
    readonly worktreePath: string;
    readonly branch: string | null;
}

export interface GraftCommands {
    graftList(input?: { refresh?: boolean | undefined }): Promise<CommandReply>;
    graftStart(input: { associationID: string }): Promise<CommandReply>;
    graftStop(input: { associationID: string }): Promise<CommandReply>;
    graftRecoverOrphan(input: { associationID: string }): Promise<CommandReply>;
    graftDismissOrphan(input: { associationID: string }): Promise<CommandReply>;
}

export interface GraftController {
    /** The button. One gesture, three meanings, exactly as §GIT-035…§GIT-037 describe. */
    toggle(target: GraftTarget): Promise<void>;
    confirmSwap(prompt: GraftSwapPrompt): Promise<void>;
    cancelSwap(): void;
    recoverOrphan(orphan: GraftOrphanView): Promise<void>;
    dismissOrphan(orphan: GraftOrphanView): Promise<void>;
    /** Initial sync — the sessions and orphans that predate this client's connection. */
    sync(): Promise<void>;
}

function errorTextOf(reply: CommandReply, fallback: string): string {
    const error = reply['error'];
    return typeof error === 'string' && error !== '' ? error : fallback;
}

function lastPathComponent(value: string): string {
    const trimmed = value.replace(/\/+$/, '');
    const index = trimmed.lastIndexOf('/');
    return index < 0 ? trimmed : trimmed.slice(index + 1);
}

export interface CreateGraftControllerOptions {
    readonly commands: GraftCommands;
    readonly dispatch: (action: GraftAction) => void;
    /** The CURRENT reducer state; the swap paths read the session mirror out of it. */
    readonly getState: () => GraftState;
}

export function createGraftController(options: CreateGraftControllerOptions): GraftController {
    const { commands, dispatch, getState } = options;

    const promptFor = (target: GraftTarget, owner: GraftSessionView): GraftSwapPrompt => ({
        associationID: target.id,
        newBranch: target.branch ?? lastPathComponent(target.worktreePath),
        newWorktreePath: target.worktreePath,
        existingSessionID: owner.associationID,
        existingBranch: owner.branch,
        existingWorktreePath: owner.worktreePath,
        parentRepoRoot: owner.parentRepoRoot
    });

    const failStart = (target: GraftTarget, message: string): void => {
        dispatch({
            kind: 'start-failed',
            session: errorPlaceholder({
                associationID: target.id,
                worktreePath: target.worktreePath,
                branch: target.branch,
                message
            })
        });
    };

    /** §GIT-038/§GIT-039/§GIT-040: who owns the contested root, and what can the user do? */
    const handleAlreadyActive = async (target: GraftTarget, parentRepoRoot: string): Promise<void> => {
        // The placeholder goes regardless of which branch we take below.
        dispatch({ kind: 'session-dropped', associationID: target.id });

        const mirrored = Object.values(getState().sessions).find(
            (session) => session.parentRepoRoot !== '' && session.parentRepoRoot === parentRepoRoot
        );
        if (mirrored !== undefined) {
            dispatch({ kind: 'swap-prompt', prompt: promptFor(target, mirrored) });
            return;
        }

        // Nothing visible owns it — the SERVICE is the source of truth (issue #231).
        let reply: CommandReply;
        try {
            reply = await commands.graftList();
        } catch (error) {
            failStart(target, error instanceof Error ? error.message : String(error));
            return;
        }
        const owner = parseGraftSessions(reply['sessions']).find(
            (session) => session.parentRepoRoot === parentRepoRoot
        );
        if (owner === undefined) {
            failStart(
                target,
                `Another graft is already active for ${parentRepoRoot}. Stop it first, then retry.`
            );
            return;
        }
        // §GIT-040: the owner IS this association — reducer state simply lost track of it.
        // Re-adopt it; swapping a worktree with itself is not a question worth asking.
        dispatch({ kind: 'adopt-session', session: owner });
        if (owner.associationID === target.id) return;
        dispatch({ kind: 'swap-prompt', prompt: promptFor(target, owner) });
    };

    const start = async (target: GraftTarget): Promise<void> => {
        dispatch({
            kind: 'start-requested',
            session: startingPlaceholder({
                associationID: target.id,
                worktreePath: target.worktreePath,
                branch: target.branch
            })
        });
        let reply: CommandReply;
        try {
            reply = await commands.graftStart({ associationID: target.id });
        } catch (error) {
            failStart(target, error instanceof Error ? error.message : String(error));
            return;
        }
        if (reply['ok'] === true) {
            const session = parseGraftSession(reply['session']);
            if (session !== null) dispatch({ kind: 'start-succeeded', session });
            else dispatch({ kind: 'session-dropped', associationID: target.id });
            return;
        }
        if (reply['error_kind'] === 'alreadyActive') {
            const root = reply['parent_repo_root'];
            await handleAlreadyActive(target, typeof root === 'string' ? root : '');
            return;
        }
        failStart(target, errorTextOf(reply, 'graft start failed'));
    };

    const stop = async (target: GraftTarget): Promise<void> => {
        let reply: CommandReply;
        try {
            reply = await commands.graftStop({ associationID: target.id });
        } catch (error) {
            dispatch({
                kind: 'stop-failed',
                associationID: target.id,
                error: error instanceof Error ? error.message : String(error)
            });
            return;
        }
        if (reply['ok'] === true) {
            dispatch({ kind: 'stop-succeeded', associationID: target.id });
            return;
        }
        dispatch({ kind: 'stop-failed', associationID: target.id, error: errorTextOf(reply, 'graft stop failed') });
    };

    return {
        async toggle(target) {
            const existing = getState().sessions[target.id];
            if (existing === undefined) {
                await start(target);
                return;
            }
            if (existing.status !== 'error') {
                await stop(target);
                return;
            }
            // §GIT-037's retry. The `.error` row may be a start-failure placeholder (which owns
            // nothing) or a LIVE session that failed a sync (which owns the watcher, the claim
            // and the breadcrumb), so the unwind runs either way — and a failed unwind must NOT
            // be followed by a start.
            dispatch({ kind: 'session-dropped', associationID: target.id });
            let reply: CommandReply;
            try {
                reply = await commands.graftStop({ associationID: target.id });
            } catch (error) {
                failStart(
                    target,
                    `Couldn't unwind the previous graft: ${error instanceof Error ? error.message : String(error)}. ` +
                        'Resolve the repo state, then toggle to retry.'
                );
                return;
            }
            if (reply['ok'] !== true) {
                failStart(
                    target,
                    `Couldn't unwind the previous graft: ${errorTextOf(reply, 'graft stop failed')}. ` +
                        'Resolve the repo state, then toggle to retry.'
                );
                return;
            }
            await start(target);
        },

        async confirmSwap(prompt) {
            dispatch({ kind: 'swap-cancelled' });
            const target: GraftTarget = {
                id: prompt.associationID,
                worktreePath: prompt.newWorktreePath,
                branch: prompt.newBranch
            };
            // Optimistic `.starting` for the incoming side while stop+start run.
            dispatch({
                kind: 'start-requested',
                session: startingPlaceholder({
                    associationID: target.id,
                    worktreePath: target.worktreePath,
                    branch: target.branch
                })
            });

            let stopReply: CommandReply;
            try {
                stopReply = await commands.graftStop({ associationID: prompt.existingSessionID });
            } catch (error) {
                failStart(
                    target,
                    `Couldn't stop the existing graft: ${error instanceof Error ? error.message : String(error)}. ` +
                        'The existing graft is still active; the new one was not started.'
                );
                return;
            }
            if (stopReply['ok'] !== true) {
                // The existing graft SURVIVED — say so, so the user does not think both are gone.
                failStart(
                    target,
                    `Couldn't stop the existing graft: ${errorTextOf(stopReply, 'graft stop failed')}. ` +
                        'The existing graft is still active; the new one was not started.'
                );
                return;
            }
            dispatch({ kind: 'stop-succeeded', associationID: prompt.existingSessionID });

            let startReply: CommandReply;
            try {
                startReply = await commands.graftStart({ associationID: target.id });
            } catch (error) {
                failStart(
                    target,
                    'Existing graft was stopped, but the new graft failed to start: ' +
                        `${error instanceof Error ? error.message : String(error)}. Toggle the icon again to retry.`
                );
                return;
            }
            if (startReply['ok'] === true) {
                const session = parseGraftSession(startReply['session']);
                if (session !== null) dispatch({ kind: 'start-succeeded', session });
                return;
            }
            // Stop succeeded, start failed: BOTH sides are gone and the user has no graft at
            // all. §GIT-041 makes that its own sentence.
            failStart(
                target,
                'Existing graft was stopped, but the new graft failed to start: ' +
                    `${errorTextOf(startReply, 'graft start failed')}. Toggle the icon again to retry.`
            );
        },

        cancelSwap() {
            dispatch({ kind: 'swap-cancelled' });
        },

        async recoverOrphan(orphan) {
            dispatch({ kind: 'orphan-removed', associationID: orphan.associationID });
            let reply: CommandReply;
            try {
                reply = await commands.graftRecoverOrphan({ associationID: orphan.associationID });
            } catch {
                dispatch({ kind: 'orphan-restored', orphan });
                return;
            }
            // §GIT-045: the breadcrumb and the stash are still on disk, so the banner must come
            // back — it is the only path to a retry.
            if (reply['ok'] !== true) dispatch({ kind: 'orphan-restored', orphan });
        },

        async dismissOrphan(orphan) {
            dispatch({ kind: 'orphan-removed', associationID: orphan.associationID });
            try {
                await commands.graftDismissOrphan({ associationID: orphan.associationID });
            } catch {
                // Dismiss only deletes a breadcrumb; a failure is not worth re-showing a banner
                // the user has explicitly waved away.
            }
        },

        async sync() {
            let reply: CommandReply;
            try {
                // `refresh`: re-scan the registry for breadcrumbs. This runs on connect and
                // whenever the inspector opens — the two moments an interrupted graft the
                // daemon has not looked for since boot has to be able to surface.
                reply = await commands.graftList({ refresh: true });
            } catch {
                return; // the connection banner already says what happened
            }
            if (reply['ok'] !== true) return;
            const snapshot = parseGraftSnapshot(reply);
            dispatch({ kind: 'sessions', sessions: snapshot.sessions });
            dispatch({ kind: 'orphans', orphans: snapshot.orphans });
        }
    };
}

// ── the React seam ──────────────────────────────────────────────────────────────────

/** The connection events graft listens to; `App` passes the socket's generic `message` feed. */
export interface GraftEventSource {
    on(event: 'message', listener: (payload: Record<string, unknown>) => void): () => void;
}

export interface UseGraftInput {
    readonly commands: GraftCommands;
    readonly events?: GraftEventSource | undefined;
    /**
     * Bumped when the client (re)connects. The daemon's `graft-changed` broadcast only fires on
     * a CHANGE, so a client that attaches to a daemon with a session already running has to ask
     * once — and again after every reconnect, since it may have missed changes while away.
     */
    readonly syncKey?: string | number | undefined;
}

export interface UseGraftResult {
    readonly state: GraftState;
    readonly controller: GraftController;
}

export function useGraft(input: UseGraftInput): UseGraftResult {
    const [state, dispatch] = useReducer(graftReducer, EMPTY_GRAFT_STATE);
    // `getState` must see the LATEST state inside async controller flows; a ref-free way to do
    // that is to keep the reducer's output in a mutable box the controller closes over.
    const box = useMemo(() => ({ current: EMPTY_GRAFT_STATE }), []);
    box.current = state;

    const commands = input.commands;
    const controller = useMemo(
        () =>
            createGraftController({
                commands,
                dispatch,
                getState: () => box.current
            }),
        [commands, box]
    );

    const events = input.events;
    useEffect(() => {
        if (events === undefined) return;
        return events.on('message', (payload) => {
            const type = payload['type'];
            if (type === 'graft-changed') {
                dispatch({ kind: 'sessions', sessions: parseGraftSessions(payload['sessions']) });
            } else if (type === 'graft-orphans') {
                dispatch({ kind: 'orphans', orphans: parseGraftOrphans(payload['orphans']) });
            }
        });
    }, [events]);

    const sync = useCallback(() => {
        void controller.sync();
    }, [controller]);
    useEffect(sync, [sync, input.syncKey]);

    return { state, controller };
}

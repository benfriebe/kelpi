/**
 * #283: the page's half of the "choose a folder" round trip.
 *
 * Settings ▸ Repositories and the inspector's Add Repository sheet take an `onBrowse` hook that
 * resolves with a directory, and in the desktop app that directory comes from a NATIVE panel. The
 * shell has no preload, so the page cannot raise one: it sends `shell-action`
 * `choose-folder-dialog` with a fresh id, the shell in its window shows the panel, and the daemon
 * hands the answer back to this connection as `choose-folder-result` (`daemon/src/ws/desktop.ts`
 * documents the whole loop). This module is the bookkeeping in between: one promise per request,
 * settled by the result carrying its id.
 *
 * Every request settles, and a cancel and a failure look the same to the caller (null), because
 * what the caller does with either is nothing:
 *
 *   - the result arrives: the path, or null when the user cancelled. The daemon also sends a
 *     null result itself when the window's shell disconnects or its pending set overflows;
 *   - the daemon refuses the request (no shell able to answer is attached for this window, an
 *     old daemon, a malformed ask): null at once, and the refusal is reported through
 *     `onRefused` so the user is told why the click did nothing;
 *   - nothing arrives within `timeoutMs`, the last resort (a daemon that restarted): null;
 *   - the connection drops (`cancelAll`): null, since the daemon routes the answer to the
 *     connection that asked, and that connection is gone.
 *
 * A result whose id is not pending (already settled, timed out, another page's) is ignored.
 *
 * Pure apart from the timer, so the rules are testable without a window or a socket; `App.tsx`
 * supplies the command client and feeds it the connection's messages.
 */

import { CHOOSE_FOLDER_TIMEOUT_MS, WS_CHOOSE_FOLDER_RESULT_MESSAGE } from '@kelpi/protocol';

import { isOkReply, replyError, type CommandReply } from '../connection/commands';

export interface FolderChooserRequest {
    readonly requestID: string;
    readonly windowID: string;
}

export interface FolderChooserOptions {
    /** The shell window this page runs in; the request names it so only its shell answers. */
    readonly windowID: string;
    /** Send the `shell-action`; resolves with the daemon's reply to the command itself. */
    readonly send: (request: FolderChooserRequest) => Promise<CommandReply>;
    /** The daemon refused the request, or it could not be sent. */
    readonly onRefused?: ((detail: string) => void) | undefined;
    readonly timeoutMs?: number | undefined;
    readonly newID?: (() => string) | undefined;
}

export interface FolderChooser {
    /** Ask for a folder. Resolves with the chosen absolute path, or null for anything else. */
    choose(): Promise<string | null>;
    /** Offer every message the connection receives; true when it settled a pending request. */
    handleMessage(message: unknown): boolean;
    /** Settle every pending request as a cancel (the connection dropped, the page is going). */
    cancelAll(): void;
    /** How many requests are waiting; for tests and diagnostics. */
    readonly pending: number;
}

let fallbackCounter = 0;

function defaultNewID(): string {
    const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    fallbackCounter += 1;
    return `folder-${Date.now().toString(36)}-${String(fallbackCounter)}`;
}

export function createFolderChooser(options: FolderChooserOptions): FolderChooser {
    const timeoutMs = options.timeoutMs ?? CHOOSE_FOLDER_TIMEOUT_MS;
    const newID = options.newID ?? defaultNewID;
    const waiting = new Map<string, { resolve: (path: string | null) => void; timer: ReturnType<typeof setTimeout> }>();

    const settle = (requestID: string, path: string | null): boolean => {
        const entry = waiting.get(requestID);
        if (entry === undefined) return false;
        waiting.delete(requestID);
        clearTimeout(entry.timer);
        entry.resolve(path);
        return true;
    };

    return {
        choose(): Promise<string | null> {
            const requestID = newID();
            const answer = new Promise<string | null>((resolve) => {
                const timer = setTimeout(() => {
                    settle(requestID, null);
                }, timeoutMs);
                waiting.set(requestID, { resolve, timer });
            });
            // Registered BEFORE the send, so a result can never arrive for an id not yet known.
            void options.send({ requestID, windowID: options.windowID }).then(
                (reply) => {
                    if (isOkReply(reply)) return;
                    if (settle(requestID, null)) options.onRefused?.(replyError(reply));
                },
                (error: unknown) => {
                    if (settle(requestID, null)) {
                        options.onRefused?.(error instanceof Error ? error.message : String(error));
                    }
                }
            );
            return answer;
        },
        handleMessage(message: unknown): boolean {
            if (typeof message !== 'object' || message === null) return false;
            const record = message as Record<string, unknown>;
            if (record['type'] !== WS_CHOOSE_FOLDER_RESULT_MESSAGE) return false;
            const requestID = record['requestID'];
            if (typeof requestID !== 'string') return false;
            // The daemon sends this to the asking connection only, but a page in another window
            // sharing a connection must still not take an answer meant for a different window.
            const windowID = record['windowID'];
            if (typeof windowID === 'string' && windowID !== options.windowID) return false;
            const path = record['path'];
            return settle(requestID, typeof path === 'string' && path !== '' ? path : null);
        },
        cancelAll(): void {
            for (const requestID of [...waiting.keys()]) settle(requestID, null);
        },
        get pending(): number {
            return waiting.size;
        }
    };
}

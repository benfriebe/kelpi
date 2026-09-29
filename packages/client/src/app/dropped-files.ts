/**
 * #288: the page's half of reading a dropped file's path.
 *
 * A file dragged from Finder onto a terminal pane should type its path (TERM-040), and this page
 * cannot read that path. Chromium keeps file paths out of a drag's `text/uri-list` and
 * `text/plain` (`web_drag_dest_mac.mm`: "To avoid exposing file system paths to web content"), so
 * the drop carries `types: ["Files"]` and `File` objects with a name and bytes. Electron removed
 * `File.path`, and `webUtils.getPathForFile` needs the preload this shell does not have.
 *
 * The main process can read it (`shell/src/dropped-files.ts`: `DOM.getFileInfo` over its own
 * window's debugger), so this module parks the dropped `File`s where it will look, on
 * `globalThis[DROPPED_FILES_STASH]` under a fresh request id, and asks through the daemon with
 * `shell-action` `resolve-dropped-files` (`daemon/src/ws/desktop.ts` has the loop). The answer
 * comes back to this connection as `dropped-files-result`.
 *
 * The same bookkeeping as `folder-chooser.ts`, and every request settles the same way, with a
 * resolution the caller can act on or explain:
 *
 *   - the result arrives: the paths, a count of items with no path on disk, and the shell's
 *     reason when it could read nothing. The daemon also answers empty itself (with a reason) when
 *     the window's shell disconnects, the pending set overflows, or its own timeout passes;
 *   - the daemon refuses the request (a browser, a shell from before #288, a paired device):
 *     empty at once, with the refusal reworded for a person (`droppedFilesRefusal`);
 *   - nothing arrives within `timeoutMs`, or the connection drops (`cancelAll`): empty, with a
 *     reason.
 *
 * The stash entry is removed whenever the request settles, whoever settled it, so a `File` never
 * outlives the drop that produced it; the shell also deletes the entry as it reads it.
 */

import { DROPPED_FILES_STASH, DROPPED_FILES_TIMEOUT_MS, WS_DROPPED_FILES_RESULT_MESSAGE } from '@kelpi/protocol';

import { isOkReply, replyError, type CommandReply } from '../connection/commands';

export interface DroppedFilesRequest {
    readonly requestID: string;
    readonly windowID: string;
}

/** What a request came to. `error` is set exactly when nothing could be read at all. */
export interface DroppedFilesResolution {
    readonly paths: readonly string[];
    readonly unresolved: number;
    readonly error: string | null;
}

/** Where the `File`s wait for the shell: a `Map` keyed by request id (injectable for tests). */
export type DroppedFilesStash = Map<string, readonly unknown[]>;

export interface DroppedFilesResolverOptions {
    /** The shell window this page runs in; the request names it so only its shell answers. */
    readonly windowID: string;
    /** Send the `shell-action`; resolves with the daemon's reply to the command itself. */
    readonly send: (request: DroppedFilesRequest) => Promise<CommandReply>;
    readonly stash?: DroppedFilesStash | undefined;
    readonly timeoutMs?: number | undefined;
    readonly newID?: (() => string) | undefined;
}

export interface DroppedFilesResolver {
    /** Ask for the paths of `files`, in order. Never rejects. */
    resolve(files: readonly unknown[]): Promise<DroppedFilesResolution>;
    /** Offer every message the connection receives; true when it settled a pending request. */
    handleMessage(message: unknown): boolean;
    /** Settle every pending request as empty (the connection dropped, the page is going). */
    cancelAll(): void;
    readonly pending: number;
}

/**
 * The page's stash, created on first use. On `globalThis` because that is the one place the main
 * process can find it by name with a single `Runtime.evaluate`, and a `Map` so an entry is
 * removed without leaving a key behind.
 */
export function pageDroppedFilesStash(): DroppedFilesStash {
    const scope = globalThis as unknown as Record<string, unknown>;
    const existing = scope[DROPPED_FILES_STASH];
    if (existing instanceof Map) return existing as DroppedFilesStash;
    const created: DroppedFilesStash = new Map();
    scope[DROPPED_FILES_STASH] = created;
    return created;
}

let fallbackCounter = 0;

function defaultNewID(): string {
    const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    fallbackCounter += 1;
    return `drop-${Date.now().toString(36)}-${String(fallbackCounter)}`;
}

const EMPTY = (error: string): DroppedFilesResolution => ({ paths: [], unresolved: 0, error });

/**
 * The daemon's refusal of a lookup, as a sentence for the user.
 *
 * The daemon's own wording names the window by its UUID, which means nothing to anyone. The
 * refusals come in two kinds a person can act on: a paired device (a phone, a remote browser) may
 * not ask at all, and everything else (the desktop window's shell is reconnecting, or predates
 * #288) is a "not right now".
 */
export function droppedFilesRefusal(detail: string): string {
    if (detail.includes('owner-only')) return 'dropping files onto a terminal works in the Kelpi desktop app';
    return "this window can't read dropped file paths right now; try again";
}

export function createDroppedFilesResolver(options: DroppedFilesResolverOptions): DroppedFilesResolver {
    const timeoutMs = options.timeoutMs ?? DROPPED_FILES_TIMEOUT_MS;
    const newID = options.newID ?? defaultNewID;
    const stash = (): DroppedFilesStash => options.stash ?? pageDroppedFilesStash();
    const waiting = new Map<
        string,
        { resolve: (resolution: DroppedFilesResolution) => void; timer: ReturnType<typeof setTimeout> }
    >();

    const settle = (requestID: string, resolution: DroppedFilesResolution): boolean => {
        const entry = waiting.get(requestID);
        if (entry === undefined) return false;
        waiting.delete(requestID);
        clearTimeout(entry.timer);
        stash().delete(requestID);
        entry.resolve(resolution);
        return true;
    };

    return {
        resolve(files: readonly unknown[]): Promise<DroppedFilesResolution> {
            const requestID = newID();
            const answer = new Promise<DroppedFilesResolution>((resolve) => {
                const timer = setTimeout(() => {
                    settle(requestID, EMPTY('the desktop window did not answer in time'));
                }, timeoutMs);
                waiting.set(requestID, { resolve, timer });
            });
            // Parked and registered BEFORE the send, so the shell can never look for an entry
            // that is not there yet, and a result can never arrive for an id not yet known.
            stash().set(requestID, [...files]);
            void options.send({ requestID, windowID: options.windowID }).then(
                (reply) => {
                    if (isOkReply(reply)) return;
                    settle(requestID, EMPTY(droppedFilesRefusal(replyError(reply))));
                },
                (error: unknown) => {
                    settle(
                        requestID,
                        EMPTY(`could not ask the desktop window: ${error instanceof Error ? error.message : String(error)}`)
                    );
                }
            );
            return answer;
        },
        handleMessage(message: unknown): boolean {
            if (typeof message !== 'object' || message === null) return false;
            const record = message as Record<string, unknown>;
            if (record['type'] !== WS_DROPPED_FILES_RESULT_MESSAGE) return false;
            const requestID = record['requestID'];
            if (typeof requestID !== 'string') return false;
            const windowID = record['windowID'];
            if (typeof windowID === 'string' && windowID !== options.windowID) return false;
            const raw = Array.isArray(record['paths']) ? (record['paths'] as unknown[]) : [];
            // The daemon has already kept only absolute paths; this page types what it keeps, so
            // it applies the same rule rather than trusting the wire, and counts what it drops.
            const paths = raw.filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('/'));
            const reported = record['unresolved'];
            const unresolved =
                (typeof reported === 'number' && Number.isInteger(reported) && reported > 0 ? reported : 0) +
                (raw.length - paths.length);
            const error = record['error'];
            return settle(requestID, {
                paths,
                unresolved,
                error: typeof error === 'string' && error !== '' && paths.length === 0 ? error : null
            });
        },
        cancelAll(): void {
            for (const requestID of [...waiting.keys()]) settle(requestID, EMPTY('the connection to the daemon dropped'));
        },
        get pending(): number {
            return waiting.size;
        }
    };
}

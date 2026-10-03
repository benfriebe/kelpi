/**
 * The daemon's `shell-action` broadcast, decoded (`daemon/src/ws/desktop.ts`).
 *
 * Pure on purpose: `status.ts` imports `electron` and therefore cannot be unit-tested under
 * plain Node (see `vitest.config.mts`), but the *routing decision* — which actions are ours,
 * and whether a broadcast is addressed to THIS window — is the part with rules in it. It lives
 * here so those rules have tests, and `status.ts` is left with the side effects.
 */

import {
    CHOOSE_FOLDER_DIALOG_ACTION,
    MAX_DROPPED_FILES,
    RESOLVE_DROPPED_FILES_ACTION,
    UPDATE_ACTION_SHELL_ACTION,
    isUpdateUserAction,
    updateSeq,
    type UpdateUserAction,
    WS_CHOOSE_FOLDER_ANSWER_MESSAGE,
    WS_DROPPED_FILES_ANSWER_MESSAGE,
    type WsChooseFolderAnswerMessage,
    type WsDroppedFilesAnswerMessage
} from '@kelpi/protocol';

/** The six things a client can ask the shell to do. Anything else is ignored. */
export const SHELL_ACTIONS = [
    'open-file-dialog',
    'install-cli',
    'check-for-updates',
    CHOOSE_FOLDER_DIALOG_ACTION,
    RESOLVE_DROPPED_FILES_ACTION,
    UPDATE_ACTION_SHELL_ACTION
] as const;
export type ShellActionName = (typeof SHELL_ACTIONS)[number];

/** The actions whose answer goes back to the page that asked, by the request's id. */
const ANSWERED_ACTIONS: readonly string[] = [CHOOSE_FOLDER_DIALOG_ACTION, RESOLVE_DROPPED_FILES_ACTION];

export interface ShellActionRequest {
    readonly action: ShellActionName;
    /** Which shell window the requester meant; absent = whichever shell hears it. */
    readonly windowID: string | null;
    /** The pane that asked (the ⌘O route), so the opened file lands in its workspace. */
    readonly paneID: string | null;
    /**
     * #283 / #288: the id a `choose-folder-dialog` or `resolve-dropped-files` answer must carry
     * back so the daemon can route it to the page that asked. Always present on those actions (a
     * request without one is refused, since its answer could reach nobody) and null on every
     * other. For a drop it is also the key of the page's stash entry.
     */
    readonly requestID: string | null;
    /**
     * #286: the update sheet's button (`update-action`), always present on that action (a frame
     * without a known verb is refused) and null on every other.
     */
    readonly updateAction: UpdateUserAction | null;
    /** #286: which revealed view a `shown` acknowledges; null when absent. */
    readonly seq: number | null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseShellAction(message: Record<string, unknown>): ShellActionRequest | null {
    const action = readString(message, 'action');
    if (action === null || !(SHELL_ACTIONS as readonly string[]).includes(action)) return null;
    const answered = ANSWERED_ACTIONS.includes(action);
    const requestID = answered ? readString(message, 'requestID') : null;
    // A panel whose answer has nowhere to go is a panel the user fills in for nothing (and a drop
    // lookup with no id has no stash entry to read): the daemon routes the answer by the id and
    // accepts it only for the window the request named.
    if (answered && (requestID === null || readString(message, 'windowID') === null)) {
        return null;
    }
    // #286: an update-sheet button must name a verb the flow knows and the window it was pressed
    // in; the flow runs only in that window's shell, so an unaddressed press is nobody's.
    let updateAction: UpdateUserAction | null = null;
    if (action === UPDATE_ACTION_SHELL_ACTION) {
        const verb = message['updateAction'];
        if (!isUpdateUserAction(verb) || readString(message, 'windowID') === null) return null;
        updateAction = verb;
    }
    return {
        action: action as ShellActionName,
        windowID: readString(message, 'windowID'),
        paneID: readString(message, 'paneID'),
        requestID,
        updateAction,
        seq: updateSeq(message['seq']) ?? null
    };
}

/**
 * #283: the frame that closes a `choose-folder-dialog`, sent back over the status connection.
 *
 * `windowID` is the window the REQUEST named, echoed rather than this shell's own id: the daemon
 * matches it against the request, and the request's is the one it holds. An empty path is a
 * cancel, as is null, so a panel that returned nothing usable still settles the page's promise
 * now rather than at its timeout.
 */
export function chooseFolderAnswer(
    requestID: string,
    windowID: string,
    chosen: string | null | undefined
): WsChooseFolderAnswerMessage {
    return {
        type: WS_CHOOSE_FOLDER_ANSWER_MESSAGE,
        requestID,
        path: typeof chosen === 'string' && chosen !== '' ? chosen : null,
        windowID
    };
}

/**
 * #288: the frame that closes a `resolve-dropped-files`, sent back over the status connection.
 *
 * `windowID` is the request's, echoed, for the reason `chooseFolderAnswer` gives. The paths are
 * filtered to absolute ones and capped here as well as in the daemon, because this is where they
 * come out of a page and the daemon's copy of the rule is its own defence, not this module's.
 * An `error` is sent only when there is something to say.
 */
export function droppedFilesAnswer(
    requestID: string,
    windowID: string,
    result: { readonly paths: readonly string[]; readonly unresolved: number; readonly error?: string | undefined }
): WsDroppedFilesAnswerMessage {
    const absolute = result.paths.filter((entry) => entry.startsWith('/'));
    const paths = absolute.slice(0, MAX_DROPPED_FILES);
    // Everything left out is counted, so the page can say how many: a path that was not absolute
    // (it cannot be typed as a location) and one past the cap alike.
    const unresolved = Math.max(0, result.unresolved) + (result.paths.length - paths.length);
    return {
        type: WS_DROPPED_FILES_ANSWER_MESSAGE,
        requestID,
        paths,
        unresolved,
        ...(result.error === undefined || result.error === '' ? {} : { error: result.error }),
        windowID
    };
}

/**
 * The audit seam's answer file, read (`KELPI_AUDIT_CHOOSE_FOLDER`, `main.ts` ▸
 * `promptChooseFolder`). The file holds one path; whitespace around it is the harness's newline,
 * and an empty file (or none at all) is a cancel.
 */
export function scriptedFolderAnswer(contents: string | null): string | null {
    const trimmed = contents?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
}

/**
 * Whether a broadcast addressed to `target` is this shell's to act on.
 *
 * The daemon fans out to every attached shell, so the filter is here — the same
 * fan-out-and-let-the-receiver-decide rule `reveal-pane` uses. An UNADDRESSED request is
 * everyone's (a browser-only user with one desktop attached still gets a dialog); an addressed
 * one is only the named window's, so two open desktops never both pop a panel for one click.
 */
export function shellActionAppliesHere(target: string | null, ourWindowID: string | undefined): boolean {
    if (target === null) return true;
    if (ourWindowID === undefined) return true;
    return target === ourWindowID;
}

// ---------------------------------------------------------------------------
// The sidebar's workspace multi-selection (WS-151)
// ---------------------------------------------------------------------------

/** §WS-151: `workspace-selection`, decoded (protocol `WS_WORKSPACE_SELECTION_MESSAGE`). */
export interface WorkspaceSelectionReport {
    /** How many workspaces the reporting window's sidebar has selected; never negative. */
    readonly selected: number;
    /** Which shell window it is about; null = whichever shell hears it. */
    readonly windowID: string | null;
}

/**
 * Read a `workspace-selection` frame, or null when it is not one (or says nothing usable).
 *
 * Pure and here rather than in `status.ts` for the reason the whole module is: `status.ts`
 * imports Electron and cannot be unit-tested, and "is this frame usable?" is the part with a
 * rule in it. A non-integer, negative or missing count is REFUSED rather than defaulted —
 * defaulting to 0 would grey the Deselect All row over a frame nobody understood, and
 * defaulting to 1 would un-grey it.
 */
export function parseWorkspaceSelection(
    message: Record<string, unknown>
): WorkspaceSelectionReport | null {
    if (message['type'] !== 'workspace-selection') return null;
    const selected = message['selected'];
    if (typeof selected !== 'number' || !Number.isInteger(selected) || selected < 0) return null;
    return { selected, windowID: readString(message, 'windowID') };
}

// ---------------------------------------------------------------------------
// The root arrangement's title bar report
// ---------------------------------------------------------------------------

/** `window-chrome`, decoded (protocol `WS_WINDOW_CHROME_MESSAGE`). */
export interface WindowChromeReport {
    /** True while the reporting page's toolbar band is hidden. */
    readonly titleBarHidden: boolean;
    /** Which shell window it is about; null = whichever shell hears it. */
    readonly windowID: string | null;
}

/**
 * Read a `window-chrome` frame, or null when it is not one.
 *
 * A missing or non-boolean flag is refused rather than defaulted, as `workspace-selection`'s count
 * is: guessing "hidden" would take the window's buttons away over a frame nobody understood.
 */
export function parseWindowChrome(message: Record<string, unknown>): WindowChromeReport | null {
    if (message['type'] !== 'window-chrome') return null;
    const hidden = message['titleBarHidden'];
    if (typeof hidden !== 'boolean') return null;
    return { titleBarHidden: hidden, windowID: readString(message, 'windowID') };
}

// ---------------------------------------------------------------------------
// Finder "Open With" (CONT-123 / CONT-124)
// ---------------------------------------------------------------------------

/**
 * The extensions `AppDelegate.swift:45-51` forwarded (`md`, `markdown`), plus the csv table's
 * (#324, docs/csv-pane.md §2); anything else is ignored outright.
 */
export const OPEN_FILE_EXTENSIONS = ['md', 'markdown', 'csv', 'tsv'] as const;

/**
 * Whether a file handed to us by Finder (or on argv) should become a document pane.
 *
 * The Swift delegate filtered before forwarding, and the filter matters: `open` opens whatever
 * path it is given AS MARKDOWN (a `.csv`/`.tsv` as a table), so an unfiltered forward turns
 * `open -a Kelpi.app photo.png` into a pane rendering PNG bytes as markdown source.
 */
export function isForwardableOpenPath(filePath: string): boolean {
    const name = filePath.split('/').pop() ?? filePath;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return false;
    const extension = name.slice(dot + 1).toLowerCase();
    return (OPEN_FILE_EXTENSIONS as readonly string[]).includes(extension);
}

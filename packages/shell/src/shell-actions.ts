/**
 * The daemon's `shell-action` broadcast, decoded (`daemon/src/ws/desktop.ts`).
 *
 * Pure on purpose: `status.ts` imports `electron` and therefore cannot be unit-tested under
 * plain Node (see `vitest.config.mts`), but the *routing decision* — which actions are ours,
 * and whether a broadcast is addressed to THIS window — is the part with rules in it. It lives
 * here so those rules have tests, and `status.ts` is left with the side effects.
 */

/** The three things a client can ask the shell to do. Anything else is ignored. */
export const SHELL_ACTIONS = ['open-file-dialog', 'install-cli', 'check-for-updates'] as const;
export type ShellActionName = (typeof SHELL_ACTIONS)[number];

export interface ShellActionRequest {
    readonly action: ShellActionName;
    /** Which shell window the requester meant; absent = whichever shell hears it. */
    readonly windowID: string | null;
    /** The pane that asked (the ⌘O route), so the opened file lands in its workspace. */
    readonly paneID: string | null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseShellAction(message: Record<string, unknown>): ShellActionRequest | null {
    const action = readString(message, 'action');
    if (action === null || !(SHELL_ACTIONS as readonly string[]).includes(action)) return null;
    return {
        action: action as ShellActionName,
        windowID: readString(message, 'windowID'),
        paneID: readString(message, 'paneID')
    };
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
// The window's own buttons (APP-046b)
// ---------------------------------------------------------------------------

/**
 * The three verbs a page-drawn window-control cluster can send. Anything else is ignored.
 *
 * Mirrors the protocol's `WS_WINDOW_CONTROL_ACTIONS` and is spelled out again here for the
 * reason every other decoder in this file is: `status.ts` cannot be unit-tested, so the rule
 * about what counts as a usable frame lives where it can be.
 */
export const WINDOW_CONTROL_ACTIONS = ['minimize', 'maximize', 'close'] as const;
export type WindowControlAction = (typeof WINDOW_CONTROL_ACTIONS)[number];

export interface WindowControlRequest {
    readonly action: WindowControlAction;
    /** Which shell window the page meant; null = whichever shell hears it. */
    readonly windowID: string | null;
}

/**
 * Read a `window-control` frame, or null when it is not one (or names no verb we implement).
 *
 * An unknown action is REFUSED rather than defaulted, and the default that is tempting is the
 * dangerous one: a frame nobody understood must never fall through to `close`.
 */
export function parseWindowControl(message: Record<string, unknown>): WindowControlRequest | null {
    if (message['type'] !== 'window-control') return null;
    const action = readString(message, 'action');
    if (action === null || !(WINDOW_CONTROL_ACTIONS as readonly string[]).includes(action)) return null;
    return { action: action as WindowControlAction, windowID: readString(message, 'windowID') };
}

// ---------------------------------------------------------------------------
// Finder "Open With" (CONT-123 / CONT-124)
// ---------------------------------------------------------------------------

/** The extensions `AppDelegate.swift:45-51` forwards; anything else is ignored outright. */
export const OPEN_FILE_EXTENSIONS = ['md', 'markdown'] as const;

/**
 * Whether a file handed to us by Finder (or on argv) should become a markdown pane.
 *
 * The Swift delegate filtered before forwarding, and the filter matters: `open` opens whatever
 * path it is given AS MARKDOWN, so an unfiltered forward turns `open -a Kelpi.app photo.png` into
 * a pane rendering PNG bytes as markdown source.
 */
export function isForwardableOpenPath(filePath: string): boolean {
    const name = filePath.split('/').pop() ?? filePath;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return false;
    const extension = name.slice(dot + 1).toLowerCase();
    return (OPEN_FILE_EXTENSIONS as readonly string[]).includes(extension);
}

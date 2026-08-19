/**
 * "Go to this pane" — the client end of a clicked desktop notification.
 *
 * The chain (agent-lifecycle.md §8.5): the shell shows a native notification, the user clicks
 * it, the shell raises its window and asks the daemon (`reveal-request`), the daemon fans out
 * `reveal-pane`, and the client — the only party that can — switches workspace and then focuses
 * the pane. The ORDER is the whole point: the window restoring its previous first responder
 * re-emits focus for the OLD pane, so focusing first and activating second silently reverts the
 * selection. Assembly performs the two steps; this module decides whether the message is ours.
 *
 * `windowID` scoping matters as soon as a second client exists: with a phone or a browser
 * attached to the same daemon, an untargeted reveal would yank every screen to the same pane.
 * A targeted message is for exactly one shell window; an untargeted one (an automation client,
 * a future CLI verb) is for everyone.
 */

export interface RevealTarget {
    readonly workspaceID: string;
    readonly paneID: string;
    readonly windowID: string | null;
}

/** The daemon's fan-out message type. */
export const REVEAL_PANE_MESSAGE = 'reveal-pane';

function text(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Read a `reveal-pane` frame, or null when it is not one (or names nothing). */
export function parseRevealMessage(message: Record<string, unknown>): RevealTarget | null {
    if (message['type'] !== REVEAL_PANE_MESSAGE) return null;
    const workspaceID = text(message['workspaceID']);
    const paneID = text(message['paneID']);
    if (workspaceID === null || paneID === null) return null;
    return { workspaceID, paneID, windowID: text(message['windowID']) };
}

/**
 * Whether THIS client should act on it: an untargeted reveal is for everyone, a targeted one
 * only for the client running in that shell window.
 */
export function revealAppliesHere(target: RevealTarget, shellWindowID: string | null): boolean {
    if (target.windowID === null) return true;
    return shellWindowID !== null && shellWindowID === target.windowID;
}

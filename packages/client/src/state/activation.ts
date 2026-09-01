/**
 * "Is the app the user is looking at?" — the client end of §AGNT-056.
 *
 * The Swift schedules its 600 ms focus-dwell clear from two places: focusing a pane, and
 * `NSApplication.didBecomeActiveNotification`. The second one is the acknowledgment half — a
 * pane that started waiting while you were in another app clears its badge shortly after you
 * come BACK to look at it, not 600 ms after the event you never saw.
 *
 * In this architecture the pane grid is in the renderer and activation is known only to the
 * Electron shell, so the fact arrives as a relayed `shell-activation` message (shell → daemon →
 * this client). Two rules, both here so they can be tested without a socket:
 *
 *   - a report naming a `windowID` is for the client running in THAT shell window only — two
 *     windows on one daemon are independently active, and a browser attached from a phone is
 *     not "inactive" because a desktop window lost focus;
 *   - a report with no `windowID` is for everyone (a single-window dev run, an automation
 *     client, the audit harness standing in for a shell).
 *
 * The browser has no shell to report for it. There, the equivalent signal is the one the client
 * already listens to — `document.visibilitychange` — and the two are combined by
 * `isAppActive`: hidden document OR deactivated window means "nobody is looking".
 */

/** The daemon's relayed message type (protocol `WS_SHELL_ACTIVATION_MESSAGE`). */
export const SHELL_ACTIVATION_MESSAGE = 'shell-activation';

export interface ShellActivationReport {
    readonly active: boolean;
    /** The shell window it is about; null = every client. */
    readonly windowID: string | null;
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Read a `shell-activation` frame, or null when it is not one (or says nothing usable). */
export function parseShellActivation(message: Record<string, unknown>): ShellActivationReport | null {
    if (message['type'] !== SHELL_ACTIVATION_MESSAGE) return null;
    const active = message['active'];
    if (typeof active !== 'boolean') return null;
    return { active, windowID: text(message['windowID']) };
}

/**
 * Whether THIS client should act on it — the same rule `revealAppliesHere` applies to a reveal,
 * and deliberately the same shape so the two cannot drift.
 */
export function activationAppliesHere(report: ShellActivationReport, shellWindowID: string | null): boolean {
    if (report.windowID === null) return true;
    return shellWindowID !== null && shellWindowID === report.windowID;
}

/**
 * The gate the dwell timer runs behind: the window is active AND the document is visible.
 *
 * Both default to true, which is what an unattached browser tab and a client that has never
 * heard from a shell should assume — the port's pre-existing behaviour, unchanged until
 * something says otherwise.
 */
export function isAppActive(state: { readonly appActive: boolean; readonly documentVisible: boolean }): boolean {
    return state.appActive && state.documentVisible;
}

// ---------------------------------------------------------------------------
// The window's maximised state (APP-046b)
// ---------------------------------------------------------------------------

/** The daemon's relayed message type (protocol `WS_WINDOW_FRAME_STATE_MESSAGE`). */
export const WINDOW_FRAME_STATE_MESSAGE = 'window-frame-state';

export interface WindowFrameStateReport {
    readonly maximized: boolean;
    /** The shell window it is about; null = every client. */
    readonly windowID: string | null;
}

/**
 * Read a `window-frame-state` frame, or null when it is not one (or says nothing usable).
 *
 * `parseShellActivation` with a different fact in it, deliberately down to the shape: both are
 * transient window facts the page cannot observe, both are scoped by window id, and both refuse a
 * non-boolean rather than defaulting one — a guess here draws the wrong glyph on a real button.
 */
export function parseWindowFrameState(message: Record<string, unknown>): WindowFrameStateReport | null {
    if (message['type'] !== WINDOW_FRAME_STATE_MESSAGE) return null;
    const maximized = message['maximized'];
    if (typeof maximized !== 'boolean') return null;
    return { maximized, windowID: text(message['windowID']) };
}

/** Whether THIS client should act on it — `activationAppliesHere`'s rule, and the same one. */
export function frameStateAppliesHere(
    report: WindowFrameStateReport,
    shellWindowID: string | null
): boolean {
    if (report.windowID === null) return true;
    return report.windowID === shellWindowID;
}

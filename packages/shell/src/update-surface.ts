/**
 * #286: how the update flow's states reach the user, with no Electron in it.
 *
 * The flow (`./update-flow.ts`) says WHAT to show; this module decides WHERE:
 *
 *   1. **The in-app sheet** (the default). The view goes to the daemon as `update-state`
 *      (`protocol/src/ws/update.ts`), which hands it to the page running in this window, and the
 *      page draws it as a sheet centred in the Kelpi window with the release notes rendered as
 *      markdown. When the view is one to REVEAL, the page answers `shown`.
 *   2. **A native dialog, parented to the window**, when the page cannot show it: no status
 *      connection, no window id, a window still loading or crashed, or no `shown` within
 *      `UPDATE_SHEET_ACK_MS` (an older page, a wedged renderer). Parented, because the old
 *      parentless `dialog.showMessageBox` was placed by macOS itself, off to the right of the
 *      Kelpi window; a parented box is a sheet on the window, centred on it.
 *
 * Also here, for the same reason (rules with no side effects, so they have tests): the native
 * dialogs' wording and the button each one maps to, and the application menu's row, which names
 * the state ("Downloading Kelpi X…", "Restart to Update to Kelpi X…").
 */

import {
    UPDATE_DOWNLOADING_EXPLAINED,
    UPDATE_INSTALL_FAILED_EXPLAINED,
    UPDATE_LATER_EXPLAINED,
    UPDATE_RESTART_EXPLAINED,
    UPDATE_SLOW_EXPLAINED,
    UPDATE_SURFACE_CAPABILITY,
    WS_UPDATE_STATE_MESSAGE,
    normalizeUpdateView,
    updateFailureTitle,
    type UpdateUserAction,
    type UpdateView,
    type WsUpdateStateMessage
} from '@kelpi/protocol';

import { UPDATE_LATER, UPDATE_NOW, updatePrompt } from './updater.js';

export { UPDATE_SURFACE_CAPABILITY };

/**
 * How long the shell waits for the page to say it drew a revealed view before it shows the native
 * dialog instead. A page that is up answers within a frame or two; this only has to outlast a busy
 * renderer, and a user who asked for something should not wait much longer than this for it.
 */
export const UPDATE_SHEET_ACK_MS = 2500;

// ── the frame ───────────────────────────────────────────────────────────────────────

/**
 * The `update-state` frame for `view`, or null when the view does not validate. `hide` tells the
 * page to close its sheet because the same state has gone to a native dialog.
 */
export function updateStateFrame(
    windowID: string,
    seq: number,
    reveal: boolean,
    view: UpdateView,
    hide = false
): WsUpdateStateMessage | null {
    const normalized = normalizeUpdateView(view);
    if (normalized === null) return null;
    return { type: WS_UPDATE_STATE_MESSAGE, windowID, seq, reveal, ...(hide ? { hide: true } : {}), view: normalized };
}

// ── the native fallback ─────────────────────────────────────────────────────────────

export interface NativeUpdateDialog {
    readonly options: {
        readonly type: 'info' | 'warning';
        readonly message: string;
        readonly detail: string;
        readonly buttons: string[];
        readonly defaultId: number;
        readonly cancelId: number;
    };
    /** The flow action each button means, by index; the cancel button is a `later` or `dismiss`. */
    readonly actions: readonly UpdateUserAction[];
}

/**
 * The native dialog for a view, or null when the state has nothing to ask (idle, a check in
 * progress, a restart under way). Same states and buttons as the in-app sheet.
 */
export function nativeUpdateDialog(view: UpdateView): NativeUpdateDialog | null {
    const version = view.version ?? '';
    const single = (type: 'info' | 'warning', message: string, detail: string, button: string, action: UpdateUserAction): NativeUpdateDialog => ({
        options: { type, message, detail, buttons: [button], defaultId: 0, cancelId: 0 },
        actions: [action]
    });
    switch (view.phase) {
        case 'up-to-date':
            return single('info', 'Kelpi is up to date', `${view.currentVersion} is the latest version.`, 'OK', 'dismiss');
        case 'unsupported':
            return single('info', 'Updates are unavailable in this build', view.message ?? '', 'OK', 'dismiss');
        case 'available': {
            if (view.location?.blocked === true) {
                return single('warning', `Kelpi ${version} is available, but cannot be installed here`, view.location.message, 'OK', 'later');
            }
            const prompt = updatePrompt({ version, notes: view.notes ?? '', feed: '' }, view.currentVersion);
            const detail = view.location === undefined ? prompt.detail : `${prompt.detail}\n\n${view.location.message}`;
            const actions: UpdateUserAction[] = [];
            actions[UPDATE_NOW] = 'update-now';
            actions[UPDATE_LATER] = 'later';
            return { options: { ...prompt, type: 'info', detail }, actions };
        }
        case 'downloading':
            return single(
                'info',
                `Downloading Kelpi ${version}…`,
                view.slow === true ? UPDATE_SLOW_EXPLAINED : UPDATE_DOWNLOADING_EXPLAINED,
                'Hide',
                'dismiss'
            );
        case 'ready':
            return {
                options: {
                    type: 'info',
                    message: `Kelpi ${version} is ready`,
                    detail: `Restart Kelpi to finish updating. ${UPDATE_RESTART_EXPLAINED}\n\n${UPDATE_LATER_EXPLAINED}`,
                    buttons: ['Restart Now', 'Later'],
                    defaultId: 0,
                    cancelId: 1
                },
                actions: ['restart', 'later']
            };
        case 'failed':
            if (view.retry === 'install') {
                // Not retried in place: Squirrel may have closed every window already.
                return {
                    options: {
                        type: 'warning',
                        message: updateFailureTitle(view),
                        detail: `${UPDATE_INSTALL_FAILED_EXPLAINED}${view.message === undefined ? '' : `\n\n${view.message}`}`,
                        buttons: ['Quit Kelpi', 'Close'],
                        defaultId: 0,
                        cancelId: 1
                    },
                    actions: ['quit', 'dismiss']
                };
            }
            return {
                options: {
                    type: 'warning',
                    message: updateFailureTitle(view),
                    detail: view.message ?? '',
                    buttons: ['Retry', 'Close'],
                    defaultId: 0,
                    cancelId: 1
                },
                actions: ['retry', 'dismiss']
            };
        case 'idle':
        case 'checking':
        case 'restarting':
            return null;
    }
}

/** A failure's headline (`@kelpi/protocol`, so the sheet says the same). */
export { updateFailureTitle as failureTitle };

/** What `showMessageBox` should be parented to. */
export type DialogParent = 'window' | 'show-window-first' | 'none';

/**
 * The native fallback's parent: the Kelpi window whenever there is one, so the box is a sheet
 * centred on it. A hidden or minimised window is brought back first, since a sheet on a window
 * nobody can see is a question nobody can answer. Only with no window at all is the box
 * parentless (and then macOS places it).
 */
export function dialogParent(window: { readonly destroyed: boolean; readonly visible: boolean; readonly minimized: boolean } | null): DialogParent {
    if (window === null || window.destroyed) return 'none';
    return window.visible && !window.minimized ? 'window' : 'show-window-first';
}

// ── the application menu's row ──────────────────────────────────────────────────────

export interface UpdateMenuRow {
    readonly label: string;
    readonly enabled: boolean;
}

/**
 * Kelpi ▸ "Check for Updates…" names the state while there is one worth knowing about, and a
 * click on it shows that state (`update-flow.ts` ▸ `check` reveals rather than re-checks). The
 * ready row is the "restart to update" affordance a Later leaves behind.
 */
export function updateMenuRow(view: UpdateView, canCheckForUpdates: boolean, checkLabel: string): UpdateMenuRow {
    const version = view.version ?? '';
    switch (view.phase) {
        case 'checking':
            return { label: 'Checking for Updates…', enabled: true };
        case 'downloading':
            return { label: `Downloading Kelpi ${version}…`, enabled: true };
        case 'ready':
            return { label: `Restart to Update to Kelpi ${version}…`, enabled: true };
        case 'restarting':
            return { label: `Restarting into Kelpi ${version}…`, enabled: false };
        default:
            return { label: checkLabel, enabled: canCheckForUpdates };
    }
}

// ── where a view goes ───────────────────────────────────────────────────────────────

export interface UpdateSurfaceDeps {
    /** This shell window's id; without one no page can be addressed. */
    readonly windowID: string | undefined;
    /** Send a frame over the status connection; false when it is not up. */
    readonly send: (frame: WsUpdateStateMessage) => boolean;
    /** The window exists and its page is loaded (not loading, not crashed). */
    readonly pageReady: () => boolean;
    /** Show the native dialog for a view (parented: `dialogParent`). */
    readonly showNative: (view: UpdateView) => void;
    /** Close a native dialog still on screen (a newer view replaces it). */
    readonly closeNative: () => void;
    /**
     * Bring a revealed view to the user's attention. `prompted` is the flow's: the user is waiting
     * on it. Returns whether the user can see a surface NOW (the window is on screen, or was just
     * brought forward); false means they were notified instead, so the sheet waits in the page
     * and no native dialog is forced on a window nobody is looking at.
     */
    readonly raise: (view: UpdateView, prompted: boolean) => boolean;
    readonly log: (line: string) => void;
    readonly ackTimeoutMs?: number | undefined;
    readonly setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
    readonly clearTimer?: ((timer: unknown) => void) | undefined;
}

export interface UpdateSurface {
    present(view: UpdateView, reveal: boolean, prompted?: boolean): void;
    /** The page drew the revealed view `seq` (`update-action` `shown`). */
    acknowledge(seq: number | undefined): void;
    /**
     * Whether a button pressed on the page's view `seq` still answers the current state. A press
     * on a view the state has since moved on from (Close on a stale failure, arriving after a
     * fresh offer) is stale and must be ignored. A press without a `seq` (an older page) counts.
     */
    isCurrent(seq: number | undefined): boolean;
}

/** Two views are the same question when their phase, version and failure kind agree. */
function sameQuestion(a: UpdateView, b: UpdateView): boolean {
    return a.phase === b.phase && a.version === b.version && a.retry === b.retry;
}

export function createUpdateSurface(deps: UpdateSurfaceDeps): UpdateSurface {
    const ackMs = deps.ackTimeoutMs ?? UPDATE_SHEET_ACK_MS;
    const setTimer = deps.setTimer ?? ((run: () => void, ms: number): unknown => {
        const timer = setTimeout(run, ms);
        timer.unref?.();
        return timer;
    });
    const clearTimer = deps.clearTimer ?? ((timer: unknown): void => clearTimeout(timer as ReturnType<typeof setTimeout>));
    let seq = 0;
    let awaiting: { seq: number; timer: unknown } | null = null;
    /** The first `seq` of the question on screen now; a press on an earlier one is stale. */
    let questionSeq = 0;
    let lastView: UpdateView | null = null;

    const stopWaiting = (): void => {
        if (awaiting !== null) clearTimer(awaiting.timer);
        awaiting = null;
    };

    return {
        present(view: UpdateView, reveal: boolean, prompted = true): void {
            seq += 1;
            const current = seq;
            if (lastView === null || !sameQuestion(lastView, view)) questionSeq = current;
            lastView = view;
            // A native box from an earlier state is out of date the moment the state moves.
            deps.closeNative();
            stopWaiting();
            const visible = reveal ? deps.raise(view, prompted) : true;
            const frame = deps.windowID === undefined ? null : updateStateFrame(deps.windowID, current, reveal, view);
            const delivered = frame !== null && deps.pageReady() && deps.send(frame);
            if (!reveal) return;
            if (!visible) {
                // Notified instead; the sheet (if delivered) waits in the page for the window.
                deps.log(`auto-update: "${view.phase}" waits for the window (the user was notified)`);
                return;
            }
            if (!delivered) {
                deps.log(`auto-update: no page can show "${view.phase}"; using a native dialog on the window`);
                deps.showNative(view);
                return;
            }
            awaiting = {
                seq: current,
                timer: setTimer(() => {
                    if (awaiting?.seq !== current) return;
                    awaiting = null;
                    deps.log(
                        `auto-update: the page did not show "${view.phase}" within ${String(ackMs)} ms; using a native dialog on the window`
                    );
                    // One surface at a time: the page closes its sheet (it may still draw it late)
                    // before the native dialog asks the same question.
                    seq += 1;
                    const hide = deps.windowID === undefined ? null : updateStateFrame(deps.windowID, seq, false, view, true);
                    if (hide !== null) deps.send(hide);
                    deps.showNative(view);
                }, ackMs)
            };
        },
        acknowledge(shown: number | undefined): void {
            if (awaiting === null) return;
            if (shown !== undefined && shown < awaiting.seq) return; // an earlier view; still waiting
            deps.log(`auto-update: the page shows the update sheet (#${String(awaiting.seq)})`);
            stopWaiting();
        },
        isCurrent(pressed: number | undefined): boolean {
            return pressed === undefined || pressed >= questionSeq;
        }
    };
}

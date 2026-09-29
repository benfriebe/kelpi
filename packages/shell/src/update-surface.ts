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
    UPDATE_SURFACE_CAPABILITY,
    WS_UPDATE_STATE_MESSAGE,
    normalizeUpdateView,
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

/** The `update-state` frame for `view`, or null when the view does not validate. */
export function updateStateFrame(windowID: string, seq: number, reveal: boolean, view: UpdateView): WsUpdateStateMessage | null {
    const normalized = normalizeUpdateView(view);
    if (normalized === null) return null;
    return { type: WS_UPDATE_STATE_MESSAGE, windowID, seq, reveal, view: normalized };
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

/** What restarting does, said the same way in the sheet and the native dialog. */
export const RESTART_EXPLAINED =
    'Kelpi closes and reopens by itself in about ten seconds, so there is no need to open it again yourself. Your terminals and agents keep running.';

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
                'This can take a minute or two, and there is no progress to show. Kelpi asks before it restarts; until then you can keep working.',
                'Hide',
                'dismiss'
            );
        case 'ready':
            return {
                options: {
                    type: 'info',
                    message: `Kelpi ${version} is ready`,
                    detail: `Restart Kelpi to finish updating. ${RESTART_EXPLAINED}\n\nChoose Later to install it the next time you quit Kelpi.`,
                    buttons: ['Restart Now', 'Later'],
                    defaultId: 0,
                    cancelId: 1
                },
                actions: ['restart', 'later']
            };
        case 'failed':
            return {
                options: {
                    type: 'warning',
                    message: failureTitle(view),
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

/** A failure's headline, by what failed. The same words head the sheet's failure state. */
export function failureTitle(view: UpdateView): string {
    const version = view.version === undefined ? 'The update' : `Kelpi ${view.version}`;
    if (view.retry === 'download') return `${version} could not be downloaded`;
    if (view.retry === 'install') return `${version} could not be installed`;
    return 'Kelpi could not check for updates';
}

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
    /** Bring the view to the user's attention (a revealed view is something they must see). */
    readonly raise: (view: UpdateView) => void;
    readonly log: (line: string) => void;
    readonly ackTimeoutMs?: number | undefined;
    readonly setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
    readonly clearTimer?: ((timer: unknown) => void) | undefined;
}

export interface UpdateSurface {
    present(view: UpdateView, reveal: boolean): void;
    /** The page drew the revealed view `seq` (`update-action` `shown`). */
    acknowledge(seq: number | undefined): void;
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

    const stopWaiting = (): void => {
        if (awaiting !== null) clearTimer(awaiting.timer);
        awaiting = null;
    };

    return {
        present(view: UpdateView, reveal: boolean): void {
            seq += 1;
            const current = seq;
            // A native box from an earlier state is out of date the moment the state moves.
            deps.closeNative();
            stopWaiting();
            if (reveal) deps.raise(view);
            const frame = deps.windowID === undefined ? null : updateStateFrame(deps.windowID, current, reveal, view);
            const delivered = frame !== null && deps.pageReady() && deps.send(frame);
            if (!reveal) return;
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
                    deps.showNative(view);
                }, ackMs)
            };
        },
        acknowledge(shown: number | undefined): void {
            if (awaiting === null) return;
            if (shown !== undefined && shown < awaiting.seq) return; // an earlier view; still waiting
            deps.log(`auto-update: the page shows the update sheet (#${String(awaiting.seq)})`);
            stopWaiting();
        }
    };
}

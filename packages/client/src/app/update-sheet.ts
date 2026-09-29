/**
 * #286: the page's half of the update surface.
 *
 * The update flow runs in this window's shell (`shell/src/update-flow.ts`); the page only draws
 * it. The shell pushes its current view as `update-state` through the daemon, which accepts it
 * only from this window's own shell and renders the release notes (`protocol/src/ws/update.ts`
 * has the contract), and the page sends its buttons back as `shell-action` `update-action`. This
 * module is the bookkeeping: read a frame for THIS window, keep the latest view, open the sheet
 * when the shell asks to reveal one (and say `shown`, so the shell does not fall back to a native
 * dialog), and close it for Later / dismiss or when the flow goes idle.
 *
 * Desktop app only: a browser has no shell window, so `App.tsx` never creates the controller
 * there, and the daemon would not send it the frames anyway (they name a shell window).
 */

import {
    MAX_UPDATE_NOTES_LENGTH,
    WS_UPDATE_STATE_MESSAGE,
    normalizeUpdateView,
    updateSeq,
    type UpdateUserAction,
    type UpdateView
} from '@kelpi/protocol';

/** What the sheet draws. */
export interface UpdateSheetState {
    readonly view: UpdateView;
    /** The daemon's rendering of `view.notes`; absent when it sent none. */
    readonly notesHTML?: string;
    readonly seq: number;
}

/** An `update-state` frame, decoded. */
export interface UpdateStateFrame extends UpdateSheetState {
    readonly reveal: boolean;
}

/**
 * Read an `update-state` frame meant for this window, or null for anything else. The view is
 * validated again here (`normalizeUpdateView`), a frame for another window is not ours, and HTML
 * notes far longer than any rendering of the capped markdown are dropped (the plain text is
 * shown instead).
 */
export function parseUpdateState(message: unknown, windowID: string): UpdateStateFrame | null {
    if (typeof message !== 'object' || message === null) return null;
    const record = message as Record<string, unknown>;
    if (record['type'] !== WS_UPDATE_STATE_MESSAGE || record['windowID'] !== windowID) return null;
    const seq = updateSeq(record['seq']);
    const view = normalizeUpdateView(record['view']);
    if (seq === undefined || view === null || typeof record['reveal'] !== 'boolean') return null;
    const html = record['notesHTML'];
    const notesHTML = typeof html === 'string' && html.length <= MAX_UPDATE_NOTES_LENGTH * 8 && view.notes !== undefined ? html : undefined;
    return { view, seq, reveal: record['reveal'], ...(notesHTML === undefined ? {} : { notesHTML }) };
}

/** The buttons that close the sheet on the page's side; the rest wait for the next state. */
export function closesSheet(action: UpdateUserAction): boolean {
    return action === 'later' || action === 'dismiss';
}

export interface UpdateSheetController {
    /** Offer every message the connection receives. */
    handleMessage(message: unknown): void;
    /** A button: sends it to the shell, and closes the sheet for Later / dismiss. */
    act(action: UpdateUserAction): void;
    /** What the sheet should draw, or null when it is closed. */
    readonly current: UpdateSheetState | null;
}

export interface UpdateSheetOptions {
    readonly windowID: string;
    /** Send `update-action` (with the `seq` a `shown` acknowledges). */
    readonly send: (action: UpdateUserAction, seq: number | undefined) => void;
    /** The sheet opened, closed or changed; `App.tsx` re-renders. */
    readonly onChange: (state: UpdateSheetState | null) => void;
}

export function createUpdateSheetController(options: UpdateSheetOptions): UpdateSheetController {
    let latest: UpdateSheetState | null = null;
    let open = false;
    const publish = (): void => options.onChange(open ? latest : null);
    return {
        handleMessage(message: unknown): void {
            const frame = parseUpdateState(message, options.windowID);
            if (frame === null) return;
            // Frames arrive in order on one connection, so the latest is the flow's state.
            const { reveal, ...state } = frame;
            latest = state;
            if (state.view.phase === 'idle') open = false;
            else if (reveal) open = true;
            publish();
            if (reveal && open) options.send('shown', state.seq);
        },
        act(action: UpdateUserAction): void {
            options.send(action, undefined);
            if (closesSheet(action)) {
                open = false;
                publish();
            }
        },
        get current(): UpdateSheetState | null {
            return open ? latest : null;
        }
    };
}

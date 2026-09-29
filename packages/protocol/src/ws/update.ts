/**
 * #286: the in-app update surface, the shell's update flow drawn as a sheet in its own window.
 *
 * The update flow lives in the Electron main process (`shell/src/update-flow.ts`): only it can
 * read the feed, drive Squirrel and quit into the new version. Until #286 it spoke to the user in
 * native alerts with no parent window, so macOS placed them where it liked (off to the right of
 * the Kelpi window), the release notes were plain text cut at 1200 characters, and the only sign
 * of a download in progress was a notification that could be denied or missed. So the flow now
 * describes itself as a small VIEW, and the page in the same window draws it.
 *
 * The shell has no preload, so the two halves meet through the daemon, in the two directions the
 * desktop channel already has (`daemon/src/ws/desktop.ts`):
 *
 *   shell → daemon → page   `update-state` (this module's message). The shell's STATUS connection
 *                           sends it; the daemon accepts it only from the named window's own
 *                           owner Electron session that declared `UPDATE_SURFACE_CAPABILITY` in
 *                           its hello (exactly as a folder answer is accepted, `ws/sync.ts`),
 *                           re-validates the view, renders the release notes to escaped HTML with
 *                           the markdown panes' renderer, and fans it out to owner sessions. The
 *                           page running in that window is the one that acts on it.
 *   page → daemon → shell   `shell-action` `update-action` with an `update_action` from
 *                           `UPDATE_USER_ACTIONS` and the page's `window_id`. Owner only, and
 *                           refused at once when no update-capable shell is attached for the
 *                           window, so a button never silently does nothing.
 *
 * `shown` is the page's acknowledgement that it drew a view the shell asked it to REVEAL. The shell
 * waits a moment for it and falls back to a native dialog, parented to its window, when none comes
 * (no page, an old page, a wedged renderer), so the flow always has a surface.
 *
 * Nothing here is remembered by the daemon: the flow's state belongs to the shell, and a page that
 * reloads mid-download is shown the current state again the next time the user asks (the menu's
 * row names the state, and Check for Updates… reveals it rather than checking again).
 */

/** The `shell-action` a page sends for a button in the update sheet. */
export const UPDATE_ACTION_SHELL_ACTION = 'update-action';
/** The `hello` capability a shell's status connection declares when it runs the update surface. */
export const UPDATE_SURFACE_CAPABILITY = 'update-surface';
/** Shell → daemon → page: the update flow's current view. */
export const WS_UPDATE_STATE_MESSAGE = 'update-state';

/**
 * Every state the flow can be in (`shell/src/update-flow.ts` has the transitions).
 *
 *   idle         nothing to show (the page closes its sheet)
 *   checking     a MANUAL check is reading the feed (a launch check stays silent)
 *   up-to-date   the feed has nothing newer than `currentVersion`
 *   available    `version` can be installed; `notes` are its release notes; `location` says
 *                when this copy of Kelpi cannot be replaced where it is running from
 *   downloading  Squirrel is fetching `version` (no progress events exist, so no percentage)
 *   ready        `version` is downloaded and waits for Restart Now (or the next quit)
 *   restarting   the user chose Restart Now; Kelpi is quitting into the new version
 *   failed       `message` says what went wrong; `retry` says what Retry does again
 *   unsupported  this build cannot update at all (`message` says why)
 */
export const UPDATE_PHASES = [
    'idle',
    'checking',
    'up-to-date',
    'available',
    'downloading',
    'ready',
    'restarting',
    'failed',
    'unsupported'
] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

/** The phases that are about one offered version, and so must name it. */
export const UPDATE_PHASES_WITH_VERSION: readonly UpdatePhase[] = ['available', 'downloading', 'ready', 'restarting'];

/**
 * What the page may send back. `update-now` and `later` answer `available`; `restart` and `later`
 * answer `ready`; `retry` answers `failed`; `dismiss` closes whatever else is showing (a download
 * keeps going); `shown` acknowledges a revealed view.
 */
export const UPDATE_USER_ACTIONS = ['update-now', 'later', 'restart', 'retry', 'dismiss', 'shown'] as const;
export type UpdateUserAction = (typeof UPDATE_USER_ACTIONS)[number];

export function isUpdateUserAction(value: unknown): value is UpdateUserAction {
    return (UPDATE_USER_ACTIONS as readonly unknown[]).includes(value);
}

/** Release notes longer than this are cut (with a note that the rest is on the release page). */
export const MAX_UPDATE_NOTES_LENGTH = 20_000;
/** A failure or location message longer than this is cut. */
export const MAX_UPDATE_MESSAGE_LENGTH = 600;
/** A version string longer than this is not one. */
export const MAX_UPDATE_VERSION_LENGTH = 64;

/** Where Kelpi is running from, when that matters to an install (`shell/src/updater.ts`). */
export interface UpdateLocationNote {
    /** True when an install cannot work from here, so the sheet offers no Update Now. */
    readonly blocked: boolean;
    readonly message: string;
}

export interface UpdateView {
    readonly phase: UpdatePhase;
    /** The version running now (`app.getVersion()`). */
    readonly currentVersion: string;
    /** The version offered, downloading or downloaded. */
    readonly version?: string;
    /** The release notes, as the release's markdown. */
    readonly notes?: string;
    /** `failed` / `unsupported`: what to tell the user, in a sentence. */
    readonly message?: string;
    /** `failed`: what Retry repeats. */
    readonly retry?: 'check' | 'download' | 'install';
    readonly location?: UpdateLocationNote;
}

export interface WsUpdateStateMessage {
    readonly type: typeof WS_UPDATE_STATE_MESSAGE;
    /** The shell window whose page should draw this. Required: the daemon drops a message without it. */
    readonly windowID: string;
    /** Increases with every push from one shell, so a `shown` can say which view it drew. */
    readonly seq: number;
    /** Open the sheet if it is closed (a manual check, a new offer, a finished download, a failure). */
    readonly reveal: boolean;
    readonly view: UpdateView;
    /**
     * Daemon → page only: `view.notes` rendered by the markdown panes' renderer with raw HTML
     * escaped, images reduced to their alt text and only http(s)/mailto links kept
     * (`daemon/src/content/markdown.ts` ▸ `renderReleaseNotes`). A shell cannot supply it; the
     * daemon overwrites it.
     */
    readonly notesHTML?: string;
}

const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version string as the flow uses them (`0.2.3`, `0.3.0-dev`, `v1.2.3-rc.1`), or undefined. */
export function updateVersion(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_UPDATE_VERSION_LENGTH) return undefined;
    return VERSION_PATTERN.test(value) ? value : undefined;
}

/**
 * Text fit to show: control characters (other than a newline and a tab) removed, trimmed, cut to
 * `limit`. Undefined when nothing is left.
 */
function cleanText(value: unknown, limit: number, keepNewlines: boolean): string | undefined {
    if (typeof value !== 'string') return undefined;
    // A multi-line field (the notes) keeps its newlines and tabs; a one-line field (a message)
    // turns every control character into a space and collapses the runs.
    const stripped = keepNewlines
        ? value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
        : value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ');
    const trimmed = stripped.trim();
    if (trimmed === '') return undefined;
    return trimmed.length > limit ? `${trimmed.slice(0, limit).trimEnd()}…` : trimmed;
}

/**
 * The view a message carries, validated, or null when it is not one.
 *
 * Every party runs this: the shell before it sends (its own defence against a feed that says
 * something odd), the daemon before it relays (a view from anywhere else is never trusted), and
 * the page before it draws. Unknown fields are dropped rather than passed through, so nothing a
 * later version adds can ride through an older relay unvalidated. A phase about a version with no
 * valid version, or a `currentVersion` that is not one, refuses the whole view.
 */
export function normalizeUpdateView(raw: unknown): UpdateView | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const phase = record['phase'];
    if (!(UPDATE_PHASES as readonly unknown[]).includes(phase)) return null;
    const currentVersion = updateVersion(record['currentVersion']);
    if (currentVersion === undefined) return null;
    const version = updateVersion(record['version']);
    if (UPDATE_PHASES_WITH_VERSION.includes(phase as UpdatePhase) && version === undefined) return null;
    const notes = cleanText(record['notes'], MAX_UPDATE_NOTES_LENGTH, true);
    const message = cleanText(record['message'], MAX_UPDATE_MESSAGE_LENGTH, false);
    const retry = record['retry'];
    const rawLocation = record['location'];
    let location: UpdateLocationNote | undefined;
    if (typeof rawLocation === 'object' && rawLocation !== null && !Array.isArray(rawLocation)) {
        const where = rawLocation as Record<string, unknown>;
        const text = cleanText(where['message'], MAX_UPDATE_MESSAGE_LENGTH, false);
        if (typeof where['blocked'] === 'boolean' && text !== undefined) location = { blocked: where['blocked'], message: text };
    }
    return {
        phase: phase as UpdatePhase,
        currentVersion,
        ...(version === undefined ? {} : { version }),
        ...(notes === undefined ? {} : { notes }),
        ...(message === undefined ? {} : { message }),
        ...(phase === 'failed' && (retry === 'check' || retry === 'download' || retry === 'install') ? { retry } : {}),
        ...(location === undefined ? {} : { location })
    };
}

/** A `seq` as the wire carries it: a non-negative safe integer, or undefined. */
export function updateSeq(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

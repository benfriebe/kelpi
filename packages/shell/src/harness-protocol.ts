/**
 * The rules of the KELPI_HARNESS_SOCKET control channel, with no Electron in them.
 *
 * `./harness.ts` owns the socket, the wrappers and the real `Menu`/`BrowserWindow`/`dialog`
 * objects; everything that DECIDES something lives here so it can be unit-tested under plain
 * Node (an `electron` import cannot resolve there, see `vitest.config.mts`). The split is the
 * one `shell-actions.ts` uses for the daemon's broadcast: the thin module has the side effects,
 * this one has the tests.
 *
 * Wire shape, as the driver on the other side was written against it:
 *
 *   - newline-delimited JSON, one request per line: `{"id":<number|string>,"op":"<op>",...}`;
 *   - one response line per request: `{"id":..,"ok":true,"result":..}` or
 *     `{"id":..,"ok":false,"error":"<message>"}`;
 *   - an unknown op answers `ok:false`; a line that is not a request at all answers with
 *     `id:null` and `ok:false`, so a driver with a broken encoder still hears something back.
 *
 * The menu rules follow how Electron itself dispatches a menu row (shell-ui.md §13 describes
 * the menu the rules run over): a label path is compared the way a user reads it (mnemonic
 * ampersands and the trailing ellipsis are not part of the name), an accelerator is compared
 * after both sides are normalised to one spelling (Electron accepts `CommandOrControl`,
 * `CmdOrCtrl`, `Command`, `Cmd` and `Super` for the same key on macOS), and a `press` lands on
 * the FIRST enabled, visible row whose accelerator matches, which is exactly the row a native
 * keystroke would reach.
 */

// §7.5's shapes, from the module that owns them; both are pure, so this file stays testable.
import type {
    KelpiNotificationHandle,
    KelpiNotificationHandlers,
    KelpiNotificationRequest
} from './notify.js';

// ── the gate ────────────────────────────────────────────────────────────────────────

/**
 * The socket path the channel should listen on, or null when there must be no channel.
 *
 * The gate is `KELPI_HARNESS_SOCKET` being a non-empty path and only that. `KELPI_HARNESS=1`
 * (the stdout watchdog marker) and `KELPI_AUDIT=1` (the window policy) are deliberately not
 * enough: the smoke and packaging probes set those and assert on a shell a user would get, and
 * a channel that appears under a marker set for another reason is a channel a user could end
 * up with. With this returning null, `./harness.ts` installs nothing, listens on nothing and
 * wraps nothing; `harness-protocol.test.ts` pins that the way `audit-window.test.ts` pins the
 * window policy.
 */
export function harnessSocketPath(env: Readonly<Record<string, string | undefined>>): string | null {
    const value = env['KELPI_HARNESS_SOCKET'];
    if (typeof value !== 'string' || value.trim() === '') return null;
    return value;
}

/**
 * Whether a recorded notification should also be SHOWN (#67).
 *
 * Under the channel the shell keeps posting for real, because a real banner is harmless to a
 * scenario and a recorder that suppresses the thing under test is the mistake `audit-window.ts`
 * refuses `hide()` for. `KELPI_HARNESS_QUIET_NOTIFICATIONS=1` is for the runs where it is not
 * harmless, a machine running several sandboxes at once, or one whose Notification Centre a
 * human is also reading, and it only ever removes the OS call: the record, the handlers and
 * `notification-click` / `notification-close` behave identically either way.
 *
 * A second gate rather than a value on the first, and read only inside `startHarness`, so it is
 * inert without `KELPI_HARNESS_SOCKET`: on its own it must never change a user's shell.
 */
export function harnessQuietNotifications(env: Readonly<Record<string, string | undefined>>): boolean {
    return env['KELPI_HARNESS_QUIET_NOTIFICATIONS'] === '1';
}

// ── requests and responses ──────────────────────────────────────────────────────────

export type RequestId = number | string;

export interface HarnessRequest {
    readonly id: RequestId;
    readonly op: string;
    /** Every field of the request line other than `id` and `op`. */
    readonly params: Readonly<Record<string, unknown>>;
}

export type HarnessResponse =
    | { readonly id: RequestId | null; readonly ok: true; readonly result: unknown }
    | { readonly id: RequestId | null; readonly ok: false; readonly error: string };

export type ParsedRequest =
    | { readonly ok: true; readonly request: HarnessRequest }
    | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One line off the socket, checked to the shape above.
 *
 * A malformed line is reported rather than dropped: a driver that sent it is waiting on the
 * response and would otherwise hang to its own timeout with nothing to read.
 */
export function parseRequest(line: string): ParsedRequest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch (error) {
        return { ok: false, error: `malformed JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!isRecord(parsed)) return { ok: false, error: 'request must be a JSON object' };
    const { id, op, ...params } = parsed;
    if (typeof id !== 'number' && typeof id !== 'string') {
        return { ok: false, error: 'request.id must be a number or a string' };
    }
    if (typeof op !== 'string' || op === '') return { ok: false, error: 'request.op must be a non-empty string' };
    return { ok: true, request: { id, op, params } };
}

/** One response line, newline included, so the writer never has to remember the framing. */
export function encodeResponse(response: HarnessResponse): string {
    return `${JSON.stringify(response)}\n`;
}

export function okResponse(id: RequestId | null, result: unknown): HarnessResponse {
    return { id, ok: true, result };
}

export function errorResponse(id: RequestId | null, error: string): HarnessResponse {
    return { id, ok: false, error };
}

/**
 * Splits a byte stream back into request lines. A TCP-ish socket hands over whatever arrived,
 * which is as likely to be half a line as three; the remainder is kept until its newline
 * shows up. Blank lines are ignored rather than answered so a driver can send one as a probe.
 */
export class LineBuffer {
    #pending = '';

    push(chunk: string): string[] {
        const lines: string[] = [];
        this.#pending += chunk;
        let newline = this.#pending.indexOf('\n');
        while (newline !== -1) {
            const line = this.#pending.slice(0, newline).replace(/\r$/, '');
            this.#pending = this.#pending.slice(newline + 1);
            if (line.trim() !== '') lines.push(line);
            newline = this.#pending.indexOf('\n');
        }
        return lines;
    }
}

// ── the menu, structurally ──────────────────────────────────────────────────────────

/**
 * The slice of an Electron `MenuItem` the rules read. Structural and self-recursive so a real
 * `MenuItem` (whose `submenu` is a `Menu` with `items: MenuItem[]`) and a test's plain object
 * both satisfy it, and the lookups hand back the caller's own type.
 */
export interface MenuEntryLike<T> {
    readonly id?: string | undefined;
    readonly label?: string | undefined;
    readonly accelerator?: string | null | undefined;
    readonly enabled?: boolean | undefined;
    readonly visible?: boolean | undefined;
    readonly type?: string | undefined;
    readonly role?: string | undefined;
    readonly checked?: boolean | undefined;
    readonly submenu?: { readonly items: readonly T[] } | null | undefined;
}

/** What the `menu` op returns, one node per row. */
export interface MenuNode {
    readonly id: string | null;
    readonly label: string;
    readonly accelerator: string | null;
    readonly enabled: boolean;
    readonly visible: boolean;
    readonly type: string;
    readonly role: string | null;
    readonly checked: boolean | null;
    readonly submenu: MenuNode[] | null;
}

function entryId<T>(item: MenuEntryLike<T>): string | null {
    return typeof item.id === 'string' && item.id !== '' ? item.id : null;
}

function entryType<T>(item: MenuEntryLike<T>): string {
    if (typeof item.type === 'string' && item.type !== '') return item.type;
    return item.submenu ? 'submenu' : 'normal';
}

/**
 * Electron's defaults, restated: a row is enabled and visible unless it says otherwise, and
 * `checked` only means something on a checkbox or radio row.
 */
export function serialiseMenu<T extends MenuEntryLike<T>>(items: readonly T[]): MenuNode[] {
    return items.map((item) => {
        const type = entryType(item);
        return {
            id: entryId(item),
            label: item.label ?? '',
            accelerator: typeof item.accelerator === 'string' && item.accelerator !== '' ? item.accelerator : null,
            enabled: item.enabled !== false,
            visible: item.visible !== false,
            type,
            role: typeof item.role === 'string' && item.role !== '' ? item.role : null,
            checked: type === 'checkbox' || type === 'radio' ? item.checked === true : null,
            submenu: item.submenu ? serialiseMenu(item.submenu.items) : null
        };
    });
}

// ── label lookup ────────────────────────────────────────────────────────────────────

/**
 * A label as a user reads it: no ampersands at all (`&File` is "File", and a literal `&&` goes
 * too, so a driver need not know which kind a label carries), no trailing ellipsis in either
 * spelling (`Preview Markdown…` is "Preview Markdown"), whitespace collapsed, and case-folded.
 */
export function normaliseLabel(label: string): string {
    // Every ampersand goes, the mnemonic `&File` and a literal `&&` alike, so the compare is the
    // same whichever spelling the driver typed; whitespace is then collapsed to single spaces.
    let text = label.replace(/&/g, '').replace(/\s+/g, ' ').trim();
    for (;;) {
        const stripped = text.replace(/(?:…|\.\.\.)$/, '').trimEnd();
        if (stripped === text) break;
        text = stripped;
    }
    return text.toLowerCase();
}

/** Plain Levenshtein, small enough to inline; it ranks the "did you mean" list in an error. */
function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current: number[] = [i];
        for (let j = 1; j <= b.length; j += 1) {
            const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
            current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
        }
        previous = current;
    }
    return previous[b.length] ?? 0;
}

/** The labels nearest to `query`, nearest first, for an error a human can act on. */
export function closestLabels(query: string, labels: readonly string[], limit = 5): string[] {
    const wanted = normaliseLabel(query);
    const scored = labels
        .filter((label) => label !== '')
        .map((label) => {
            const candidate = normaliseLabel(label);
            const bonus = candidate.includes(wanted) || wanted.includes(candidate) ? -100 : 0;
            return { label, score: editDistance(wanted, candidate) + bonus };
        })
        .sort((left, right) => left.score - right.score || left.label.localeCompare(right.label));
    return scored.slice(0, limit).map((entry) => entry.label);
}

export type MenuLookup<T> = { readonly ok: true; readonly item: T } | { readonly ok: false; readonly error: string };

export interface MenuTarget {
    readonly id?: string | undefined;
    readonly path?: readonly string[] | undefined;
}

function walk<T extends MenuEntryLike<T>>(items: readonly T[], visit: (item: T) => boolean): T | null {
    for (const item of items) {
        if (visit(item)) return item;
        if (item.submenu) {
            const found = walk(item.submenu.items, visit);
            if (found !== null) return found;
        }
    }
    return null;
}

/** A label for an error message: the mnemonic ampersand dropped, case and ellipsis kept. */
function displayLabel(label: string): string {
    return label.replace(/&/g, '').replace(/\s+/g, ' ').trim();
}

function labelsOf<T extends MenuEntryLike<T>>(items: readonly T[]): string[] {
    return items.filter((item) => entryType(item) !== 'separator').map((item) => displayLabel(item.label ?? ''));
}

/**
 * Find a row by `id`, else by its label path from the menu bar down (`["File", "Close"]`).
 *
 * Both may be given; the id is the stronger claim so it is tried first, and a miss on it falls
 * through to the path rather than failing, because a driver that knows an id usually knows the
 * path too and wants the row, not a debate. A miss names the closest labels at the level that
 * failed, so a typo in a step file is a one-line fix rather than a `menu` dump.
 */
export function findMenuItem<T extends MenuEntryLike<T>>(items: readonly T[], target: MenuTarget): MenuLookup<T> {
    const id = typeof target.id === 'string' && target.id !== '' ? target.id : null;
    const path = Array.isArray(target.path) ? target.path.filter((segment) => typeof segment === 'string') : null;
    if (id === null && (path === null || path.length === 0)) {
        return { ok: false, error: 'menu-click needs an "id" or a non-empty "path"' };
    }
    if (id !== null) {
        const byId = walk(items, (item) => entryId(item) === id);
        if (byId !== null) return { ok: true, item: byId };
        if (path === null || path.length === 0) {
            const ids: string[] = [];
            walk(items, (item) => {
                const candidate = entryId(item);
                if (candidate !== null) ids.push(candidate);
                return false;
            });
            const known = ids.length === 0 ? 'no menu item carries an id' : `ids: ${ids.join(', ')}`;
            return { ok: false, error: `no menu item with id "${id}" (${known})` };
        }
    }
    let level: readonly T[] = items;
    const trail: string[] = [];
    let current: T | null = null;
    for (const segment of path ?? []) {
        const wanted = normaliseLabel(segment);
        const match = level.find(
            (item) => entryType(item) !== 'separator' && normaliseLabel(item.label ?? '') === wanted
        );
        if (match === undefined) {
            const where = trail.length === 0 ? 'the menu bar' : trail.join(' > ');
            const closest = closestLabels(segment, labelsOf(level));
            const hint = closest.length === 0 ? 'nothing there' : `closest: ${closest.join(', ')}`;
            return { ok: false, error: `no menu item "${segment}" under ${where} (${hint})` };
        }
        trail.push(displayLabel(match.label ?? segment));
        current = match;
        level = match.submenu ? match.submenu.items : [];
    }
    return current === null ? { ok: false, error: 'empty path' } : { ok: true, item: current };
}

/**
 * Whether `menu-click` may call the row's handler.
 *
 * A role row (`{ role: 'quit' }`, the whole Edit and Window menus) has no handler of ours: its
 * work happens in Electron's role table and, for the macOS-native roles, in Cocoa selectors the
 * JavaScript side never sees. Emulating that would be a second, slightly different
 * implementation of the menu; a `press` reaches the same row through its accelerator and a CDP
 * key event reaches the native path, so the answer is to refuse and say so. Disabled and
 * hidden rows are refused for the plainer reason that a native menu would not fire them
 * either, and a click that "worked" on a greyed row would be a false positive in a run.
 */
export function menuClickVerdict<T extends MenuEntryLike<T>>(item: T): string | null {
    const type = entryType(item);
    const name = item.label ?? entryId(item) ?? '(unlabelled)';
    if (type === 'separator') return `"${name}" is a separator`;
    if (item.submenu) return `"${name}" is a submenu, not a row`;
    if (typeof item.role === 'string' && item.role !== '') return 'role item; use press or a CDP key';
    if (item.enabled === false) return `menu item "${name}" is disabled`;
    if (item.visible === false) return `menu item "${name}" is hidden`;
    return null;
}

// ── accelerators ────────────────────────────────────────────────────────────────────

/** The canonical modifier names, in the order the canonical string lists them. */
const MODIFIER_ORDER = ['Cmd', 'Ctrl', 'Alt', 'Shift', 'Super'] as const;

function canonicalModifier(token: string, platform: string): string {
    const lower = token.toLowerCase();
    switch (lower) {
        case 'commandorcontrol':
        case 'cmdorctrl':
            return platform === 'darwin' ? 'Cmd' : 'Ctrl';
        case 'command':
        case 'cmd':
            return 'Cmd';
        case 'super':
        case 'meta':
            // Super is the Command key on macOS and the Windows/Linux key elsewhere.
            return platform === 'darwin' ? 'Cmd' : 'Super';
        case 'control':
        case 'ctrl':
            return 'Ctrl';
        case 'option':
        case 'alt':
            return 'Alt';
        case 'shift':
            return 'Shift';
        default:
            return token.toUpperCase();
    }
}

function canonicalKey(token: string): string {
    const upper = token.toUpperCase();
    // Electron treats the two spellings of each as the same key.
    if (upper === 'ENTER') return 'RETURN';
    if (upper === 'ESC') return 'ESCAPE';
    return upper;
}

/**
 * One spelling for an Electron accelerator, so two strings can be compared as chords.
 *
 * `CommandOrControl+Shift+n`, `Shift+Cmd+N` and `Super+shift+N` are the same key on macOS and
 * all come out as `Cmd+Shift+N`: modifiers are folded to one name each, listed in a fixed
 * order, and the key is uppercased. Returns null for an empty or modifier-only string.
 */
export function normaliseAccelerator(accelerator: string | null | undefined, platform: string = process.platform): string | null {
    if (typeof accelerator !== 'string') return null;
    const tokens = accelerator
        .split('+')
        .map((token) => token.trim())
        .filter((token) => token !== '');
    if (tokens.length === 0) return null;
    const key = canonicalKey(tokens[tokens.length - 1] ?? '');
    const modifiers = new Set(tokens.slice(0, -1).map((token) => canonicalModifier(token, platform)));
    const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
    // A modifier Electron does not know is kept as typed (uppercased) so it only matches itself.
    const unknown = [...modifiers].filter((modifier) => !(MODIFIER_ORDER as readonly string[]).includes(modifier)).sort();
    return [...ordered, ...unknown, key].join('+');
}

export function acceleratorMatches(
    left: string | null | undefined,
    right: string | null | undefined,
    platform: string = process.platform
): boolean {
    const a = normaliseAccelerator(left, platform);
    const b = normaliseAccelerator(right, platform);
    return a !== null && b !== null && a === b;
}

function isLive<T extends MenuEntryLike<T>>(item: T): boolean {
    return item.enabled !== false && item.visible !== false;
}

function collectAccelerators<T extends MenuEntryLike<T>>(items: readonly T[], into: Set<string>): void {
    for (const item of items) {
        if (typeof item.accelerator === 'string' && item.accelerator !== '') into.add(item.accelerator);
        if (item.submenu) collectAccelerators(item.submenu.items, into);
    }
}

function firstByAccelerator<T extends MenuEntryLike<T>>(
    items: readonly T[],
    wanted: string,
    platform: string
): T | null {
    for (const item of items) {
        // A greyed or hidden submenu greys everything under it; a native keystroke stops there.
        if (!isLive(item)) continue;
        const type = entryType(item);
        if (item.submenu) {
            const found = firstByAccelerator(item.submenu.items, wanted, platform);
            if (found !== null) return found;
            continue;
        }
        if (type === 'separator') continue;
        if (acceleratorMatches(item.accelerator, wanted, platform)) return item;
    }
    return null;
}

/**
 * The row a native press of `accelerator` would fire: the first enabled, visible one whose
 * chord matches, in menu order. Role rows are included, because the OS routes the chord to
 * them too and `press` exists to be the keystroke. A miss lists every chord the menu has, so a
 * driver written against a rebound menu (#47) can see which spelling the menu carries now.
 */
export function findByAccelerator<T extends MenuEntryLike<T>>(
    items: readonly T[],
    accelerator: string,
    platform: string = process.platform
): MenuLookup<T> {
    if (normaliseAccelerator(accelerator, platform) === null) {
        return { ok: false, error: `"${accelerator}" is not an accelerator` };
    }
    const found = firstByAccelerator(items, accelerator, platform);
    if (found !== null) return { ok: true, item: found };
    const known = new Set<string>();
    collectAccelerators(items, known);
    const list = known.size === 0 ? 'the menu has no accelerators' : `accelerators: ${[...known].join(', ')}`;
    return { ok: false, error: `no enabled, visible menu item on "${accelerator}" (${list})` };
}

// ── counters and the dialog arm ─────────────────────────────────────────────────────

export interface DialogSpec {
    readonly title: string;
    readonly message: string;
    readonly detail: string;
    readonly buttons: readonly string[];
    readonly defaultId: number;
}

export interface DialogRecord extends DialogSpec {
    /** The button index the box resolved with; null while it is still open. */
    readonly response: number | null;
}

export interface DialogArm {
    readonly response: number;
    readonly checkboxChecked: boolean;
}

// ── notifications (#67) ─────────────────────────────────────────────────────────────

/**
 * How many shown notifications the channel keeps. Twenty because a scenario asserts ORDER and
 * §7.5's replace-on-repost over a handful of events, not over a session; the count and the last
 * one are exact for the whole run either way, and only the window drops.
 */
export const NOTIFICATION_HISTORY = 20;

/** One notification the shell actually showed, as a scenario reads it. */
export interface NotificationRecord {
    /** Its ordinal in the run, counting from 0 and never reused; `notifications - 1` is the last. */
    readonly seq: number;
    readonly title: string;
    readonly body: string;
    /** The action buttons' text, in the order macOS would show them (§AGNT-073: Open, Dismiss). */
    readonly actions: readonly string[];
    /** The pane it belongs to, or null for the shell's own notices. */
    readonly paneID: string | null;
    readonly silent: boolean;
    /** §7.5's identifier, `kelpi-<paneID>`, which is what makes replace-on-repost assertable. */
    readonly key: string | null;
    /** False when `KELPI_HARNESS_QUIET_NOTIFICATIONS=1` recorded it without posting it. */
    readonly displayed: boolean;
    /** True once it has been withdrawn: by the OS, by a replacement, or by `notification-close`. */
    readonly closed: boolean;
}

/** What `notification-click` answers with. */
export interface NotificationFired {
    readonly seq: number;
    readonly title: string;
    /** The action button's text, or null when it was the body tap. */
    readonly action: string | null;
    /** The index macOS would have reported for that button, or null for the body tap. */
    readonly actionIndex: number | null;
}

/**
 * A notification the channel is standing in front of.
 *
 * It IS the `KelpiNotificationHandle` the call site gets back from `presentNotification`, so
 * `status.ts`'s replace-on-repost `close()` and its "Dismiss" branch run through here as well;
 * and it holds the site's own handlers, so `notification-click` calls the exact function macOS
 * would have called rather than a re-implementation of what clicking means. `#delegate` is the
 * real Electron notification underneath, or null under the quiet gate, which is the ONLY
 * difference the gate makes.
 *
 * Pure of Electron on purpose: the delegate is structural, so `harness-protocol.test.ts` drives
 * every path with a recording double.
 */
export class RecordedNotification implements KelpiNotificationHandle {
    readonly #handlers: KelpiNotificationHandlers;
    readonly #onShow: (entry: RecordedNotification) => number;
    #delegate: KelpiNotificationHandle | null = null;
    #record: NotificationRecord;
    #shown = false;
    #closeDispatched = false;

    constructor(
        request: KelpiNotificationRequest,
        handlers: KelpiNotificationHandlers,
        onShow: (entry: RecordedNotification) => number
    ) {
        this.#handlers = handlers;
        this.#onShow = onShow;
        this.#record = {
            seq: -1,
            title: request.title,
            body: request.body,
            actions: (request.actions ?? []).map((action) => action.text),
            paneID: request.paneID ?? null,
            // Electron's default is an audible notification, so an unset `silent` is false.
            silent: request.silent === true,
            key: request.key ?? null,
            displayed: false,
            closed: false
        };
    }

    get record(): NotificationRecord {
        return this.#record;
    }

    /** The real notification, or null when the quiet gate said to record and not post. */
    attach(delegate: KelpiNotificationHandle | null): void {
        this.#delegate = delegate;
    }

    /**
     * Recorded HERE, not at construction: a notification that is built and never shown was
     * never shown, and `status.ts` builds one before it decides anything. A second `show()` on
     * the same object re-posts it rather than adding a record; no site does that today, and
     * this comment is where that decision lives if one starts.
     */
    show(): void {
        if (!this.#shown) {
            this.#shown = true;
            this.#record = { ...this.#record, seq: this.#onShow(this), displayed: this.#delegate !== null };
        }
        this.#delegate?.show();
    }

    /** Withdraw it. The site's `onClose` fires exactly once however the close arrived. */
    close(): void {
        this.#delegate?.close();
        this.dispatchClose();
    }

    /** The OS's `click` event, or `notification-click` with no action. */
    dispatchClick(): void {
        this.#handlers.onClick?.();
    }

    /** The OS's `action` event, by the index macOS reports. */
    dispatchAction(index: number): void {
        this.#handlers.onAction?.(index);
    }

    /**
     * The OS's `close` event, or our own `close()`. Guarded because both can happen for one
     * withdrawal: `close()` calls the real notification, whose own `close` event comes straight
     * back through here, and `status.ts`'s handler would otherwise run twice.
     */
    dispatchClose(): void {
        if (this.#closeDispatched) return;
        this.#closeDispatched = true;
        this.#record = { ...this.#record, closed: true };
        this.#handlers.onClose?.();
    }

    /**
     * `notification-click`: the body tap, or the named action button, as the OS would deliver
     * it. A missing handler is an error rather than a silent success, a scenario asserting
     * that clicking Open focuses the pane must not pass against a notification nobody wired.
     */
    fire(action: string | undefined): NotificationFired | string {
        const name = this.#record.title === '' ? '(untitled)' : this.#record.title;
        const where = `notification ${String(this.#record.seq)} ("${name}")`;
        if (action === undefined) {
            if (this.#handlers.onClick === undefined) return `${where} has no click handler`;
            this.dispatchClick();
            return { seq: this.#record.seq, title: this.#record.title, action: null, actionIndex: null };
        }
        // Compared the way a user reads a button, for the same reason a menu path is.
        const wanted = normaliseLabel(action);
        const actionIndex = this.#record.actions.findIndex((text) => normaliseLabel(text) === wanted);
        if (actionIndex === -1) {
            const known =
                this.#record.actions.length === 0 ? 'it has no actions' : `actions: ${this.#record.actions.join(', ')}`;
            return `${where} has no action "${action}" (${known})`;
        }
        if (this.#handlers.onAction === undefined) return `${where} has no action handler`;
        this.dispatchAction(actionIndex);
        return {
            seq: this.#record.seq,
            title: this.#record.title,
            action: this.#record.actions[actionIndex] ?? action,
            actionIndex
        };
    }
}

export interface CountersSnapshot {
    readonly dockBounces: number;
    readonly lastBounce: string | null;
    readonly dialogs: number;
    readonly lastDialog: DialogRecord | null;
    /** Every notification SHOWN this run, not every one built. */
    readonly notifications: number;
    readonly lastNotification: NotificationRecord | null;
    /** The last `NOTIFICATION_HISTORY` of them, oldest first: ordering and §7.5's dedupe. */
    readonly recentNotifications: readonly NotificationRecord[];
    /**
     * Every `shell.openExternal` the shell asked for this run, and the last URL it named (#83).
     *
     * "The browser opened" is otherwise unobservable from a driver: the OS takes the URL and
     * nothing about it comes back through CDP, the DOM or the CLI. Under the harness the real
     * open is SWALLOWED as well as counted; see `harness.ts` ▸ `wrapExternalOpen`.
     */
    readonly externalOpens: number;
    readonly lastExternalUrl: string | null;
}

/**
 * What `app.dock.bounce` and `dialog.showMessageBox` were asked to do, and the one-shot answer
 * a driver can pre-load for the next dialog.
 *
 * The bounce exists so a driver can see the thing agent-lifecycle.md §7.1 and §14 invariant 6
 * make deliberately rare: the dock bounces on a stop and only while the app is inactive (#55),
 * which no CDP session can observe. The dialog arm exists because a native message box takes
 * the whole run hostage until a human clicks it; armed, the wrapper answers it without showing
 * it, and the record still says what the box would have asked. The arm is one-shot so a stale
 * answer from an earlier step can never swallow a later dialog silently.
 *
 * `externalOpens` / `lastExternalUrl` are the same idea for `shell.openExternal` (#83): a URL
 * the shell hands the OS leaves no trace a driver can read, and the ⌘-click path's whole point
 * is which URL arrives there.
 */
export class HarnessCounters {
    #dockBounces = 0;
    #lastBounce: string | null = null;
    #dialogs = 0;
    #lastDialog: { record: DialogRecord } | null = null;
    #arm: DialogArm | null = null;
    #notifications = 0;
    #shownNotifications: RecordedNotification[] = [];
    #externalOpens = 0;
    #lastExternalUrl: string | null = null;

    recordBounce(type: string | undefined): void {
        this.#dockBounces += 1;
        this.#lastBounce = type ?? 'informational';
    }

    /** A URL the shell handed to the OS opener (#83). Recorded whole, never trimmed. */
    recordExternalOpen(url: string): void {
        this.#externalOpens += 1;
        this.#lastExternalUrl = url;
    }

    arm(arm: DialogArm): { armed: true } {
        this.#arm = arm;
        return { armed: true };
    }

    /** The pending arm, if any, and it is gone once taken. */
    takeArm(): DialogArm | null {
        const arm = this.#arm;
        this.#arm = null;
        return arm;
    }

    get armed(): boolean {
        return this.#arm !== null;
    }

    /** A dialog was asked for. Returns a handle for `settleDialog` once it has an answer. */
    openDialog(spec: DialogSpec): { record: DialogRecord } {
        this.#dialogs += 1;
        const handle = { record: { ...spec, buttons: [...spec.buttons], response: null } };
        this.#lastDialog = handle;
        return handle;
    }

    settleDialog(handle: { record: DialogRecord }, response: number): void {
        handle.record = { ...handle.record, response };
    }

    /**
     * Stand in front of one notification (#67). The caller wires the real one underneath with
     * `attach`; the record only enters the history when the returned handle is shown.
     */
    openNotification(request: KelpiNotificationRequest, handlers: KelpiNotificationHandlers): RecordedNotification {
        return new RecordedNotification(request, handlers, (entry) => this.#recordShown(entry));
    }

    #recordShown(entry: RecordedNotification): number {
        const seq = this.#notifications;
        this.#notifications += 1;
        this.#shownNotifications.push(entry);
        if (this.#shownNotifications.length > NOTIFICATION_HISTORY) this.#shownNotifications.shift();
        return seq;
    }

    /**
     * The notification `notification-click` / `notification-close` mean, by its position in the
     * HISTORY (which is what `counters()` hands back), newest last. Omitted is the most recent,
     * which is what a scenario wants nine times in ten; negative counts from the end. Not the
     * run-wide `seq`, because the history drops its oldest and an absolute ordinal would start
     * failing at the twenty-first notification of a run.
     */
    notificationAt(index: unknown): RecordedNotification | string {
        const list = this.#shownNotifications;
        const last = list[list.length - 1];
        if (last === undefined) return 'no notification has been shown yet';
        if (index === undefined) return last;
        if (typeof index !== 'number' || !Number.isInteger(index)) return '"index" must be an integer';
        const at = index < 0 ? list.length + index : index;
        const found = list[at];
        if (found === undefined) {
            return `index ${String(index)} is outside the ${String(list.length)} notification(s) the channel is holding (0..${String(list.length - 1)}, or -1 for the most recent)`;
        }
        return found;
    }

    snapshot(): CountersSnapshot {
        return {
            dockBounces: this.#dockBounces,
            lastBounce: this.#lastBounce,
            dialogs: this.#dialogs,
            lastDialog: this.#lastDialog === null ? null : { ...this.#lastDialog.record },
            notifications: this.#notifications,
            lastNotification: this.#shownNotifications[this.#shownNotifications.length - 1]?.record ?? null,
            recentNotifications: this.#shownNotifications.map((entry) => entry.record),
            externalOpens: this.#externalOpens,
            lastExternalUrl: this.#lastExternalUrl
        };
    }
}

/**
 * The options out of a `showMessageBox` call, whichever overload it used: `(options)` or
 * `(window, options)`. Defaults are Electron's own, so the record says what the user would have
 * seen (one `OK` button, the first button as the default).
 */
export function messageBoxSpecFrom(args: readonly unknown[]): DialogSpec {
    const candidate = args.length >= 2 ? args[1] : args[0];
    const options: Record<string, unknown> = isRecord(candidate) ? candidate : {};
    const buttons = Array.isArray(options['buttons']) ? options['buttons'].map(String) : [];
    return {
        title: typeof options['title'] === 'string' ? options['title'] : '',
        message: typeof options['message'] === 'string' ? options['message'] : '',
        detail: typeof options['detail'] === 'string' ? options['detail'] : '',
        buttons: buttons.length === 0 ? ['OK'] : buttons,
        defaultId: typeof options['defaultId'] === 'number' ? options['defaultId'] : 0
    };
}

/** Parse the `dialog-arm` params. `checkboxChecked` defaults to false, as an unticked box does. */
export function parseDialogArm(params: Readonly<Record<string, unknown>>): DialogArm | string {
    const response = params['response'];
    if (typeof response !== 'number' || !Number.isInteger(response) || response < 0) {
        return 'dialog-arm needs a non-negative integer "response"';
    }
    const checkbox = params['checkboxChecked'];
    if (checkbox !== undefined && typeof checkbox !== 'boolean') {
        return 'dialog-arm "checkboxChecked" must be a boolean';
    }
    return { response, checkboxChecked: checkbox === true };
}

// ── the ops ─────────────────────────────────────────────────────────────────────────

export const HARNESS_OPS = [
    'ping',
    'menu',
    'menu-click',
    'press',
    'counters',
    'dialog-arm',
    'notification-click',
    'notification-close',
    'window',
    'focus',
    'blur',
    // Issue #75's three. `menu-click` refuses role rows and `press` finds no handler on one, so
    // ⌘H, ⌥⌘H and ⌘M could not be driven at all: the one bug class that needs them (the shell
    // parks its own views on `hide`/`minimize`) had no way to be reproduced from a script.
    'hide',
    'minimize',
    'restore',
    // Issue #76's one, for the same reason: nothing a scenario can reach kills a renderer.
    'crash'
] as const;
export type HarnessOp = (typeof HARNESS_OPS)[number];

export interface WindowSnapshot {
    readonly focused: boolean;
    readonly visible: boolean;
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/**
 * What `hide` / `minimize` / `restore` answer with: the two flags the caller is about to assert
 * on, read back AFTER the call so the reply is an observation rather than an intention.
 */
export interface WindowVisibility {
    readonly visible: boolean;
    readonly minimized: boolean;
}

/**
 * Everything an op needs from the Electron side, as functions, so the dispatch below can be
 * driven by a fake in tests and by the real `Menu`/`BrowserWindow`/`app` in `./harness.ts`.
 */
export interface HarnessSurface<T extends MenuEntryLike<T>> {
    readonly platform: string;
    readonly pid: number;
    readonly version: () => string;
    /** The application menu's top-level rows; empty when there is no menu. */
    readonly menuItems: () => readonly T[];
    /** Call the row's click handler exactly as Electron would for a menu selection. */
    readonly clickItem: (item: T) => void;
    /** The main window, or null when there is none (or it is destroyed). */
    readonly window: () => WindowSnapshot | null;
    /** `show()` + `focus()`; returns `isFocused()` afterwards, or null without a window. */
    readonly focus: () => boolean | null;
    /** `blur()`; returns `isFocused()` afterwards, or null without a window. */
    readonly blur: () => boolean | null;
    /** `hide()`: what ⌘H does to the window. Null without a window. */
    readonly hide: () => WindowVisibility | null;
    /** `minimize()`: what ⌘M does. Null without a window. */
    readonly minimize: () => WindowVisibility | null;
    /** Undo either of the two above, whichever the window is in. Null without a window. */
    readonly restore: () => WindowVisibility | null;
    /**
     * Issue #76: kill the renderer behind a web pane's active tab, as macOS does under memory
     * pressure. Returns the tab it killed, or null when that pane has no live view. Absent when
     * the shell has no web-pane host (a window-only harness), which the op reports as a refusal.
     */
    readonly crashWebPane?: ((paneID: string) => { readonly paneID: string; readonly tabID: string } | null) | undefined;
    readonly counters: HarnessCounters;
}

function clicked<T extends MenuEntryLike<T>>(item: T): { id: string | null; label: string; accelerator: string | null } {
    return {
        id: entryId(item),
        label: item.label ?? '',
        accelerator: typeof item.accelerator === 'string' && item.accelerator !== '' ? item.accelerator : null
    };
}

/**
 * Answer one request. Never throws: a handler that blows up (a click whose relay is down, a
 * window destroyed between two lines) becomes an `ok:false` line, so the socket stays usable
 * and the driver sees the message rather than a closed connection.
 */
export function respond<T extends MenuEntryLike<T>>(request: HarnessRequest, surface: HarnessSurface<T>): HarnessResponse {
    const { id, op, params } = request;
    try {
        switch (op as HarnessOp) {
            case 'ping':
                return okResponse(id, { pid: surface.pid, version: surface.version() });
            case 'menu':
                return okResponse(id, { items: serialiseMenu(surface.menuItems()) });
            case 'menu-click': {
                const target: MenuTarget = {
                    id: typeof params['id'] === 'string' ? params['id'] : undefined,
                    path: Array.isArray(params['path']) ? (params['path'] as readonly string[]) : undefined
                };
                const found = findMenuItem(surface.menuItems(), target);
                if (!found.ok) return errorResponse(id, found.error);
                const refusal = menuClickVerdict(found.item);
                if (refusal !== null) return errorResponse(id, refusal);
                surface.clickItem(found.item);
                return okResponse(id, clicked(found.item));
            }
            case 'press': {
                const accelerator = params['accelerator'];
                if (typeof accelerator !== 'string' || accelerator.trim() === '') {
                    return errorResponse(id, 'press needs a non-empty "accelerator"');
                }
                const found = findByAccelerator(surface.menuItems(), accelerator, surface.platform);
                if (!found.ok) return errorResponse(id, found.error);
                surface.clickItem(found.item);
                return okResponse(id, clicked(found.item));
            }
            case 'counters':
                return okResponse(id, surface.counters.snapshot());
            case 'dialog-arm': {
                const arm = parseDialogArm(params);
                if (typeof arm === 'string') return errorResponse(id, arm);
                return okResponse(id, surface.counters.arm(arm));
            }
            case 'notification-click': {
                // §7.5's two clickable things: the body tap ("Open / default click": activates
                // the app, switches workspace, focuses the pane) and an action button by name.
                // Both run the site's own handler, so what a scenario exercises is the shipped
                // path and not a second implementation of it.
                const found = surface.counters.notificationAt(params['index']);
                if (typeof found === 'string') return errorResponse(id, found);
                const action = params['action'];
                if (action !== undefined && typeof action !== 'string') {
                    return errorResponse(id, 'notification-click "action" must be a string');
                }
                const fired = found.fire(action);
                if (typeof fired === 'string') return errorResponse(id, fired);
                return okResponse(id, fired);
            }
            case 'notification-close': {
                // What the OS does when the user swipes a banner away, and what §7.5's
                // replace-on-repost does to the pane's previous toast.
                const found = surface.counters.notificationAt(params['index']);
                if (typeof found === 'string') return errorResponse(id, found);
                found.close();
                return okResponse(id, { seq: found.record.seq, title: found.record.title, closed: true });
            }
            case 'window': {
                const snapshot = surface.window();
                return okResponse(id, snapshot ?? { focused: null, visible: null, bounds: null });
            }
            case 'focus':
                return okResponse(id, { focused: surface.focus() });
            case 'blur':
                return okResponse(id, { focused: surface.blur() });
            // #75. Nulls rather than an error with no window, exactly as `window` answers, so a
            // scenario reads one shape whether or not there is a window to act on.
            case 'hide':
                return okResponse(id, surface.hide() ?? { visible: null, minimized: null });
            case 'minimize':
                return okResponse(id, surface.minimize() ?? { visible: null, minimized: null });
            case 'restore':
                return okResponse(id, surface.restore() ?? { visible: null, minimized: null });
            case 'crash': {
                // Issue #76's trigger. The recovery it tests (dispose, rebuild, re-place) is
                // three processes wide and none of it is reachable from a renderer, so the only
                // honest test is to kill a real renderer and watch what the shell does next.
                const paneID = params['paneID'];
                if (typeof paneID !== 'string' || paneID.trim() === '') {
                    return errorResponse(id, 'crash needs a non-empty "paneID"');
                }
                if (surface.crashWebPane === undefined) {
                    return errorResponse(id, 'crash: this shell has no web pane host');
                }
                const killed = surface.crashWebPane(paneID);
                if (killed === null) return errorResponse(id, `crash: no live view for pane ${paneID}`);
                return okResponse(id, { paneID: killed.paneID, tabID: killed.tabID, crashed: true });
            }
            default:
                return errorResponse(id, `unknown op "${op}" (ops: ${HARNESS_OPS.join(', ')})`);
        }
    } catch (error) {
        return errorResponse(id, `${op} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** A raw line to a response line: parse, dispatch, encode. The one function the socket calls. */
export function respondToLine<T extends MenuEntryLike<T>>(line: string, surface: HarnessSurface<T>): HarnessResponse {
    const parsed = parseRequest(line);
    if (!parsed.ok) return errorResponse(null, parsed.error);
    return respond(parsed.request, surface);
}

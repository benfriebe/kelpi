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

export interface CountersSnapshot {
    readonly dockBounces: number;
    readonly lastBounce: string | null;
    readonly dialogs: number;
    readonly lastDialog: DialogRecord | null;
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
 */
export class HarnessCounters {
    #dockBounces = 0;
    #lastBounce: string | null = null;
    #dialogs = 0;
    #lastDialog: { record: DialogRecord } | null = null;
    #arm: DialogArm | null = null;

    recordBounce(type: string | undefined): void {
        this.#dockBounces += 1;
        this.#lastBounce = type ?? 'informational';
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

    snapshot(): CountersSnapshot {
        return {
            dockBounces: this.#dockBounces,
            lastBounce: this.#lastBounce,
            dialogs: this.#dialogs,
            lastDialog: this.#lastDialog === null ? null : { ...this.#lastDialog.record }
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
    'window',
    'focus',
    'blur'
] as const;
export type HarnessOp = (typeof HARNESS_OPS)[number];

export interface WindowSnapshot {
    readonly focused: boolean;
    readonly visible: boolean;
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
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
            case 'window': {
                const snapshot = surface.window();
                return okResponse(id, snapshot ?? { focused: null, visible: null, bounds: null });
            }
            case 'focus':
                return okResponse(id, { focused: surface.focus() });
            case 'blur':
                return okResponse(id, { focused: surface.blur() });
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

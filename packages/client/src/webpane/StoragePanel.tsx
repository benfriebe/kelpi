/**
 * The cookie / site-data panel (web-pane.md §13; WEB-049…WEB-054).
 *
 * A web pane's storage is the one part of its state the daemon does *not* own: cookies live in
 * the Electron session the host built for the pane's partition. So everything here is a verb —
 * `web-cookies-list` to read, `web-cookie-set` to write, `web-cookies-delete` / `-clear` to
 * remove.
 *
 * **M39 — there is no localStorage read-out**, and there was never meant to be one:
 * `StoragePanel.swift` is cookies, the private toggle and clear-all, full stop. The port had
 * grown a "Local storage" button that ran a `web-exec` and dumped the page's keys into a mono
 * block under the panel — an affordance the shipped app never shows, in the same class as the
 * invented full-window drop overlay (§H20). `kelpi web exec` is still the way to read a page's
 * storage; it is simply not a control in this panel.
 *
 * Faithful details worth naming, because each one is a rule rather than a look:
 *
 *   - cookies are grouped by **canonical domain** (one leading `.` stripped, the same rule the
 *     host matches on), groups sorted by domain and cookies by name, each group a
 *     **collapsed-by-default** accordion carrying its count (WEB-050);
 *   - a row expands into an inline form whose **domain is locked** unless you are adding at top
 *     level, whose expiry is prefilled to **+30 days**, and whose Save is disabled until name and
 *     domain are both non-empty (WEB-051);
 *   - saving **deletes the original first**, so a renamed cookie does not leave a stale twin —
 *     the host does that half (WEB-052), driven by the `original` field this form sends;
 *   - the add form and the edit form are **mutually exclusive** (WEB-053);
 *   - **"Clear all site data" is confirmation-gated** (WEB-054), as is the **private-mode
 *     toggle**, whose warning differs per direction (WEB-049).
 *
 * Like the pickup panel, this is a **row above the page**, not a floating popover: the page is a
 * native view composited over this document, so nothing in the DOM can be drawn on top of it.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { tokens } from '../grid/tokens';
// H14's switch primitive, reused rather than re-drawn: `StoragePanel.swift:117-123` is the same
// `.toggleStyle(.switch)` control as every Settings row's, so it should be the same object here.
import { SettingsToggle } from '../settings/ui';
import type { WebCookieWrite, WebPaneCommands } from './commands';
import { WEB_CHROME_TEXT_ATTRIBUTE } from './priority';

export interface WebCookie {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly is_secure: boolean;
    readonly is_http_only: boolean;
    readonly expires?: number | undefined;
    readonly session_only?: boolean | undefined;
}

/** §13.2: matching everywhere strips exactly one leading dot. */
export function canonicalDomain(domain: string): string {
    return domain.startsWith('.') ? domain.slice(1) : domain;
}

export interface CookieGroup {
    readonly domain: string;
    readonly cookies: readonly WebCookie[];
}

/** WEB-050's grouping: by canonical domain, groups by domain and cookies by name. */
export function groupCookies(cookies: readonly WebCookie[]): readonly CookieGroup[] {
    const byDomain = new Map<string, WebCookie[]>();
    for (const cookie of cookies) {
        const domain = canonicalDomain(cookie.domain);
        const bucket = byDomain.get(domain);
        if (bucket === undefined) byDomain.set(domain, [cookie]);
        else bucket.push(cookie);
    }
    return [...byDomain.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([domain, list]) => ({
            domain,
            cookies: [...list].sort((a, b) => a.name.localeCompare(b.name))
        }));
}

/*
 * L74 — a confirmation is a QUESTION, a consequence and a NAMED action.
 *
 * `StoragePanel.swift:57-82` puts both of these through `.confirmationDialog(title,
 * titleVisibility: .visible)` with a `role: .destructive` button that says what it is about to
 * do — "Clear all site data", "Enable private mode" — under a title that asks. The port had one
 * untitled card whose only button read "Continue", so the two very different confirmations were
 * distinguishable by their body text alone and neither button named its own consequence. The
 * card stays (a web pane cannot open a sheet over a native page view — the same constraint that
 * makes this panel a row), but the title, the wording and the button labels are the Swift's.
 */

/** The question in the title position, per direction (WEB-049). */
export function privateModeQuestion(enabling: boolean): string {
    return enabling ? 'Enable private mode for this pane?' : 'Disable private mode for this pane?';
}

/** WEB-049's two messages — the direction is the whole point of the confirmation. */
export function privateModeWarning(enabling: boolean): string {
    return enabling
        ? 'Tabs will reload in a non-persistent session. Live JS state will be lost; cookies created in private mode are discarded on quit.'
        : 'Tabs will reload against the persistent store. Live JS state will be lost; previously-saved cookies become visible again.';
}

/** The destructive button's label — it names the action, never "Continue". */
export function privateModeAction(enabling: boolean): string {
    return enabling ? 'Enable private mode' : 'Disable private mode';
}

export const CLEAR_ALL_QUESTION = 'Clear all site data for this pane?';
export const CLEAR_ALL_WARNING =
    'Removes cookies, local storage, IndexedDB, and caches. Logged-in sessions on this data store will be signed out.';
export const CLEAR_ALL_ACTION = 'Clear all site data';

/**
 * L60 — `StoragePanel.truncatedValue` (`StoragePanel.swift:458-461`): a cookie's value is
 * clamped to 60 characters in the collapsed row, so one fat session token cannot push the
 * whole list into a scroll. The port printed the value whole, inside a `name=value` link.
 */
export function truncateCookieValue(value: string, max = 60): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max - 1)}…`;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** WEB-051: the expiry picker is prefilled to +30 days. `datetime-local` wants no zone. */
export function defaultExpiryInput(now: number): string {
    return new Date(now + THIRTY_DAYS_MS).toISOString().slice(0, 16);
}

interface CookieForm {
    /** The cookie being edited, or null when this is the add form. */
    readonly original: WebCookie | null;
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    /** Locked (read-only) unless we are creating at top level (WEB-051). */
    readonly domainLocked: boolean;
    readonly path: string;
    readonly secure: boolean;
    readonly sessionOnly: boolean;
    readonly expires: string;
}

function formFor(cookie: WebCookie, now: number): CookieForm {
    return {
        original: cookie,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        domainLocked: true,
        path: cookie.path === '' ? '/' : cookie.path,
        secure: cookie.is_secure,
        sessionOnly: cookie.session_only === true || cookie.expires === undefined,
        expires:
            cookie.expires === undefined
                ? defaultExpiryInput(now)
                : new Date(cookie.expires * 1000).toISOString().slice(0, 16)
    };
}

function blankForm(domain: string, now: number): CookieForm {
    return {
        original: null,
        name: '',
        value: '',
        domain,
        // Adding at top level lets you type a domain; adding inside a group does not.
        domainLocked: domain !== '',
        path: '/',
        secure: false,
        sessionOnly: false,
        expires: defaultExpiryInput(now)
    };
}

export interface StoragePanelProps {
    readonly paneID: string;
    readonly isPrivate: boolean;
    readonly commands: WebPaneCommands;
    readonly onClose: () => void;
    /** Test seam so the +30-day prefill is assertable. */
    readonly now?: (() => number) | undefined;
}

export function StoragePanel(props: StoragePanelProps): ReactElement {
    const { paneID, commands } = props;
    const now = props.now ?? ((): number => Date.now());
    const [cookies, setCookies] = useState<readonly WebCookie[]>([]);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [form, setForm] = useState<CookieForm | null>(null);
    const [confirm, setConfirm] = useState<{
        readonly kind: 'clear-all' | 'private';
        readonly question: string;
        readonly message: string;
        readonly action: string;
    } | null>(null);
    /**
     * L59 — the read is not instant, and the panel has to say so.
     *
     * `StoragePanel.swift:135-140` puts a small `ProgressView` beside the "Cookies" heading for
     * exactly as long as `getAllCookies` is in flight. The port's `refresh()` set no pending
     * state at all, so a slow list (or one the host never answers) was indistinguishable from a
     * store with no cookies in it — including on the very first open, where the empty-state line
     * is what you see while the answer is still coming.
     */
    const [loading, setLoading] = useState(false);

    const refresh = useCallback((): void => {
        setLoading(true);
        void commands
            .cookiesList(paneID)
            .then((reply) => {
                if (typeof reply !== 'object' || reply === null) return;
                const record = reply as Record<string, unknown>;
                if (record['ok'] !== true || !Array.isArray(record['cookies'])) return;
                setCookies(record['cookies'] as readonly WebCookie[]);
            })
            .finally(() => setLoading(false));
    }, [commands, paneID]);

    useEffect(refresh, [refresh]);

    const groups = useMemo(() => groupCookies(cookies), [cookies]);

    const save = useCallback((): void => {
        if (form === null) return;
        const trimmedName = form.name.trim();
        const trimmedDomain = form.domain.trim();
        if (trimmedName === '' || trimmedDomain === '') return;
        const parsed = Date.parse(form.expires);
        const cookie: WebCookieWrite = {
            name: trimmedName,
            value: form.value,
            domain: trimmedDomain,
            path: form.path === '' ? '/' : form.path,
            is_secure: form.secure,
            // WEB-052: HttpOnly rides through an edit but is never user-editable.
            is_http_only: form.original?.is_http_only === true,
            ...(form.sessionOnly || Number.isNaN(parsed) ? {} : { expires: Math.floor(parsed / 1000) })
        };
        const original = form.original;
        void commands
            .cookieSet(
                paneID,
                cookie,
                original === null
                    ? undefined
                    : { name: original.name, domain: original.domain, path: original.path }
            )
            .then(() => {
                setForm(null);
                refresh();
            });
    }, [commands, form, paneID, refresh]);

    const saveDisabled = form === null || form.name.trim() === '' || form.domain.trim() === '';

    return (
        <div
            data-testid={`web-storage-${paneID}`}
            /*
             * S34: `StoragePanel.swift:52-53` is `.padding(.horizontal, 10).padding(.vertical,
             * 8)`. `p-2` started every row 8 px from the pane's edge where the shipped panel
             * starts at 10 (and ended the trailing ✕ 8 px from it). The vertical 8 and the
             * `gap-2` band spacing already matched; only the horizontal was short.
             */
            className="flex max-h-[70%] shrink-0 flex-col gap-2 overflow-y-auto px-2.5 py-2 text-[11px]"
            style={{
                background: tokens.surfaceBackground,
                borderBottom: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary
            }}
        >
            <div className="flex items-center gap-2">
                <span className="font-medium">Cookies &amp; site data</span>
                <span style={{ color: tokens.textTertiary }}>
                    {cookies.length === 1 ? '1 cookie' : `${String(cookies.length)} cookies`}
                </span>
                {/* L59: the Swift's `ProgressView().controlSize(.small)` in its 12×12 frame. */}
                {loading ? (
                    <span
                        data-testid={`web-storage-loading-${paneID}`}
                        role="progressbar"
                        aria-label="Reading cookies"
                        className="kelpi-storage-spinner"
                        style={{ borderColor: tokens.divider, borderTopColor: tokens.textSecondary }}
                    />
                ) : null}
                <button
                    type="button"
                    data-testid={`web-storage-refresh-${paneID}`}
                    // L73: `.help("Refresh cookie list")` (`StoragePanel.swift:158`).
                    aria-label="Refresh cookie list"
                    title="Refresh cookie list"
                    /*
                     * S12: the eighth chip. The other seven in this panel carry `px-2 py-[3px]`
                     * and land at 23.4 px now that S1 layered the reset; Refresh kept
                     * `py-[1px]`/`px-1.5` and stayed at 18.0 px — still under the 20 px pointer
                     * line and the only chip in the panel with a 6 px side inset. Same 3/8 box
                     * as its siblings; the declared 10 px type stays (22.0 px tall).
                     */
                    className="ml-auto rounded border px-2 py-[3px] text-[10px]"
                    style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                    onClick={refresh}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    data-testid={`web-storage-close-${paneID}`}
                    // L73: `.help("Close storage panel")` (`StoragePanel.swift:101`).
                    aria-label="Close storage panel"
                    title="Close storage panel"
                    /*
                     * S28: `StoragePanel.swift:96-99` frames this glyph at 16 × 16 with a
                     * `.contentShape(Rectangle())` — an explicit box, not the ✕'s own ink. The
                     * port drew the character alone (8.39 × 15.4), half the shipped footprint
                     * and under the 20 px line. Width/height utilities are safe here: S1's
                     * reset only ever killed padding, border and font.
                     */
                    className="flex h-4 w-4 shrink-0 items-center justify-center"
                    style={{ color: tokens.textTertiary }}
                    onClick={props.onClose}
                >
                    ✕
                </button>
            </div>

            {/*
             * WEB-049: the private toggle, and the confirmation that guards both directions.
             *
             * M36 — the row is `StoragePanel.swift:105-125` verbatim in shape: a two-line
             * label (name over an explanatory caption that changes with the state) with the
             * control pushed to the trailing edge by a `Spacer()`. The caption is the point of
             * the row: "in-memory store" / "shared persistent store" named the MECHANISM, where
             * the Swift names the CONSEQUENCE — which is what the user is deciding about.
             * And the control is a real macOS switch (`.toggleStyle(.switch)`), not the square
             * user-agent tick box the port drew — the same H14 primitive every Settings row now
             * uses, so a toggle means the same thing on both surfaces.
             */}
            <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className="font-medium">Private mode</span>
                    <span className="text-[10px]" style={{ color: tokens.textSecondary }}>
                        {props.isPrivate
                            ? 'Cookies + caches discarded on quit; tabs blank on restart.'
                            : 'Cookies + caches persist across restarts.'}
                    </span>
                </div>
                <SettingsToggle
                    label="Private session"
                    testID={`web-private-toggle-${paneID}`}
                    checked={props.isPrivate}
                    onChange={() => {
                        const enabling = !props.isPrivate;
                        setConfirm({
                            kind: 'private',
                            question: privateModeQuestion(enabling),
                            message: privateModeWarning(enabling),
                            action: privateModeAction(enabling)
                        });
                    }}
                />
            </div>

            <div
                data-testid={`web-cookie-groups-${paneID}`}
                className="flex flex-col gap-1 overflow-y-auto"
                style={{ maxHeight: 220 }}
            >
                {groups.length === 0 ? (
                    /*
                     * L61 — the empty line has TWO forms (`StoragePanel.swift:186-192`), and the
                     * private one is the useful one: an empty list in a private pane is not a
                     * store you have not visited yet, it is a store that is emptied every launch.
                     * The port said "No cookies for this pane." in both, which reads as a fault
                     * in exactly the mode where it is the design.
                     */
                    <p data-testid={`web-cookie-empty-${paneID}`} style={{ color: tokens.textTertiary }}>
                        {props.isPrivate
                            ? 'No cookies (private mode - fresh on every launch).'
                            : 'No cookies for this data store yet.'}
                    </p>
                ) : (
                    groups.map((group) => {
                        const open = expanded.has(group.domain);
                        return (
                            <div key={group.domain} className="rounded" style={{ border: `1px solid ${tokens.divider}` }}>
                                <div className="flex items-center gap-1 px-1.5 py-1">
                                    <button
                                        type="button"
                                        data-testid={`web-cookie-group-${group.domain}`}
                                        data-open={open ? 'true' : 'false'}
                                        className="min-w-0 flex-1 truncate text-left font-mono text-[10px]"
                                        style={{ color: tokens.textPrimary }}
                                        onClick={() => {
                                            setExpanded((current) => {
                                                const next = new Set(current);
                                                if (next.has(group.domain)) next.delete(group.domain);
                                                else next.add(group.domain);
                                                return next;
                                            });
                                        }}
                                    >
                                        {open ? '▾' : '▸'} {group.domain} ({group.cookies.length})
                                    </button>
                                    <button
                                        type="button"
                                        // L73: `.help("Add cookie for \(domain)")` (`:237`).
                                        aria-label={`Add cookie for ${group.domain}`}
                                        title={`Add cookie for ${group.domain}`}
                                        data-testid={`web-cookie-add-${group.domain}`}
                                        // S28: `StoragePanel.swift:232-236`'s `.frame(width: 16,
                                        // height: 16)` + `.contentShape(Rectangle())`.
                                        className="flex h-4 w-4 shrink-0 items-center justify-center"
                                        style={{ color: tokens.textSecondary }}
                                        onClick={() => setForm(blankForm(group.domain, now()))}
                                    >
                                        ＋
                                    </button>
                                    <button
                                        type="button"
                                        // L73: `.help("Delete all cookies for \(domain)")` (`:247`).
                                        aria-label={`Delete all cookies for ${group.domain}`}
                                        title={`Delete all cookies for ${group.domain}`}
                                        data-testid={`web-cookie-clear-${group.domain}`}
                                        // S28: `StoragePanel.swift:242-246`'s 16 × 16 trash.
                                        className="flex h-4 w-4 shrink-0 items-center justify-center"
                                        style={{ color: '#E0685F' }}
                                        onClick={() => {
                                            void commands
                                                .cookiesClear(paneID, { domain: group.domain })
                                                .then(refresh);
                                        }}
                                    >
                                        ✕
                                    </button>
                                </div>
                                {!open
                                    ? null
                                    : group.cookies.map((cookie) => {
                                          /*
                                           * L60 — a cookie row is a two-line DISCLOSURE
                                           * (`StoragePanel.swift:270-321`): a `chevron.right` /
                                           * `chevron.down` expander, the name in 10 pt medium
                                           * monospace over its 60-char-clamped value in
                                           * secondary, and an `xmark.circle` delete on the
                                           * trailing edge. The port had flattened all of that
                                           * into one `name=value` link — no expander, so nothing
                                           * said the row opens; no split, so the name a person is
                                           * scanning for had no more weight than the blob beside
                                           * it; and no clamp, so a session token ran the row's
                                           * whole width and truncated the name out of sight.
                                           *
                                           * The expander's state is "is THIS cookie's edit form
                                           * open", which is the same state the Swift chevron
                                           * tracks (`editingKey == key`).
                                           */
                                          const editing =
                                              form?.original?.name === cookie.name &&
                                              form.original.domain === cookie.domain &&
                                              form.original.path === cookie.path;
                                          return (
                                              <div
                                                  key={`${cookie.name}:${cookie.path}`}
                                                  data-testid={`web-cookie-${group.domain}-${cookie.name}`}
                                                  data-open={editing ? 'true' : 'false'}
                                                  className="flex items-center gap-1.5 px-1.5 py-[3px]"
                                                  style={{ borderTop: `1px solid ${tokens.divider}` }}
                                              >
                                                  <button
                                                      type="button"
                                                      data-testid={`web-cookie-toggle-${cookie.name}`}
                                                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                                      onClick={() =>
                                                          setForm(editing ? null : formFor(cookie, now()))
                                                      }
                                                  >
                                                      <span
                                                          aria-hidden="true"
                                                          className="w-[10px] shrink-0 text-[8px] font-semibold"
                                                          style={{ color: tokens.textTertiary }}
                                                      >
                                                          {editing ? '▾' : '▸'}
                                                      </span>
                                                      <span className="flex min-w-0 flex-1 flex-col">
                                                          <span
                                                              className="truncate font-mono text-[10px] font-medium"
                                                              style={{ color: tokens.textPrimary }}
                                                          >
                                                              {cookie.name}
                                                          </span>
                                                          <span
                                                              data-testid={`web-cookie-value-${cookie.name}`}
                                                              className="truncate font-mono text-[10px]"
                                                              style={{ color: tokens.textSecondary }}
                                                          >
                                                              {truncateCookieValue(cookie.value)}
                                                          </span>
                                                      </span>
                                                  </button>
                                                  <button
                                                      type="button"
                                                      // L73: `.help("Delete cookie \(name)")` (`:303`).
                                                      aria-label={`Delete cookie ${cookie.name}`}
                                                      title={`Delete cookie ${cookie.name}`}
                                                      data-testid={`web-cookie-delete-${cookie.name}`}
                                                      // S28: the ROW delete is the smaller of
                                                      // the two sizes the Swift uses —
                                                      // `StoragePanel.swift:298-301` frames it
                                                      // at 14 × 14, against 16 for the three
                                                      // panel-level glyphs.
                                                      className="flex h-[14px] w-[14px] shrink-0 items-center justify-center self-start"
                                                      style={{ color: tokens.textSecondary }}
                                                      onClick={() => {
                                                          void commands
                                                              .cookieDelete(paneID, cookie.name, cookie.domain)
                                                              .then(refresh);
                                                      }}
                                                  >
                                                      ⊗
                                                  </button>
                                              </div>
                                          );
                                      })}
                            </div>
                        );
                    })
                )}
            </div>

            {form === null ? (
                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        data-testid={`web-cookie-add-${paneID}`}
                        // L73: `.help("Add a cookie")` (`StoragePanel.swift:149`).
                        title="Add a cookie"
                        className="rounded border px-2 py-[3px]"
                        style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                        onClick={() => setForm(blankForm('', now()))}
                    >
                        Add cookie
                    </button>
                    <button
                        type="button"
                        data-testid={`web-clear-site-data-${paneID}`}
                        // L73: `.help("Clear all site data (cookies, caches, local storage)")` (`:168`).
                        title="Clear all site data (cookies, caches, local storage)"
                        className="ml-auto rounded border px-2 py-[3px]"
                        style={{ borderColor: '#E0685F', color: '#E0685F' }}
                        onClick={() =>
                            setConfirm({
                                kind: 'clear-all',
                                question: CLEAR_ALL_QUESTION,
                                message: CLEAR_ALL_WARNING,
                                action: CLEAR_ALL_ACTION
                            })
                        }
                    >
                        Clear all site data
                    </button>
                </div>
            ) : (
                <div
                    data-testid={`web-cookie-form-${paneID}`}
                    /*
                     * S37: `StoragePanel.swift:610-611` insets the form 8 horizontal / 6
                     * vertical, and its `strokeBorder` draws INSIDE its bounds. At `p-1.5` the
                     * form's own 1 px border sat 6 px from each field's 1 px border — two
                     * nested rules with almost nothing between them.
                     */
                    className="flex flex-col gap-1 rounded p-2"
                    style={{ border: `1px solid ${tokens.divider}` }}
                >
                    <div className="flex gap-1">
                        <input
                            aria-label="Cookie name"
                            data-testid={`web-cookie-form-name-${paneID}`}
                            placeholder="name"
                            {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                            className="min-w-0 flex-1 rounded px-1.5 py-[3px] font-mono outline-none"
                            style={{ background: tokens.windowBackground, border: `1px solid ${tokens.divider}`, color: tokens.textPrimary }}
                            value={form.name}
                            onChange={(event) => setForm({ ...form, name: event.target.value })}
                        />
                        <input
                            aria-label="Cookie value"
                            data-testid={`web-cookie-form-value-${paneID}`}
                            placeholder="value"
                            {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                            className="min-w-0 flex-1 rounded px-1.5 py-[3px] font-mono outline-none"
                            style={{ background: tokens.windowBackground, border: `1px solid ${tokens.divider}`, color: tokens.textPrimary }}
                            value={form.value}
                            onChange={(event) => setForm({ ...form, value: event.target.value })}
                        />
                    </div>
                    <div className="flex gap-1">
                        <input
                            aria-label="Cookie domain"
                            data-testid={`web-cookie-form-domain-${paneID}`}
                            placeholder="domain"
                            readOnly={form.domainLocked}
                            {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                            className="min-w-0 flex-1 rounded px-1.5 py-[3px] font-mono outline-none"
                            style={{
                                background: tokens.windowBackground,
                                border: `1px solid ${tokens.divider}`,
                                color: form.domainLocked ? tokens.textTertiary : tokens.textPrimary
                            }}
                            value={form.domain}
                            onChange={(event) => setForm({ ...form, domain: event.target.value })}
                        />
                        <input
                            aria-label="Cookie path"
                            data-testid={`web-cookie-form-path-${paneID}`}
                            {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                            className="w-20 rounded px-1.5 py-[3px] font-mono outline-none"
                            style={{ background: tokens.windowBackground, border: `1px solid ${tokens.divider}`, color: tokens.textPrimary }}
                            value={form.path}
                            onChange={(event) => setForm({ ...form, path: event.target.value })}
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1">
                            <input
                                type="checkbox"
                                aria-label="Secure"
                                data-testid={`web-cookie-form-secure-${paneID}`}
                                checked={form.secure}
                                onChange={(event) => setForm({ ...form, secure: event.target.checked })}
                            />
                            Secure
                        </label>
                        <label className="flex items-center gap-1">
                            <input
                                type="checkbox"
                                aria-label="Session only"
                                data-testid={`web-cookie-form-session-${paneID}`}
                                checked={form.sessionOnly}
                                onChange={(event) => setForm({ ...form, sessionOnly: event.target.checked })}
                            />
                            Session only
                        </label>
                        <input
                            type="datetime-local"
                            aria-label="Expires"
                            data-testid={`web-cookie-form-expires-${paneID}`}
                            disabled={form.sessionOnly}
                            className="ml-auto rounded px-1 py-[2px] outline-none disabled:opacity-40"
                            style={{ background: tokens.windowBackground, border: `1px solid ${tokens.divider}`, color: tokens.textPrimary }}
                            value={form.expires}
                            onChange={(event) => setForm({ ...form, expires: event.target.value })}
                        />
                    </div>
                    {/*
                     * L58 — the edit form's footer is `Delete … Cancel Save`
                     * (`StoragePanel.swift:592-599`): a `role: .destructive` Delete pinned to the
                     * leading edge by a `Spacer()`, then Cancel and the default-action Save. The
                     * port shipped Save and Cancel only, so a cookie you had opened to inspect
                     * could not be removed from the form you were looking at — you had to close
                     * it and find the row's own ✕ again. Delete is present only when there IS an
                     * original to delete: `onDelete` is nil on the add form, exactly as here.
                     */}
                    <div className="flex gap-1.5">
                        {form.original === null ? null : (
                            <button
                                type="button"
                                data-testid={`web-cookie-form-delete-${paneID}`}
                                className="rounded border px-2 py-[3px]"
                                style={{ borderColor: '#E0685F', color: '#E0685F' }}
                                onClick={() => {
                                    const original = form.original;
                                    if (original === null) return;
                                    setForm(null);
                                    void commands
                                        .cookieDelete(paneID, original.name, original.domain)
                                        .then(refresh);
                                }}
                            >
                                Delete
                            </button>
                        )}
                        <button
                            type="button"
                            data-testid={`web-cookie-form-cancel-${paneID}`}
                            className="ml-auto rounded border px-2 py-[3px]"
                            style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                            onClick={() => setForm(null)}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            data-testid={`web-cookie-form-save-${paneID}`}
                            disabled={saveDisabled}
                            className="rounded border px-2 py-[3px] disabled:opacity-40"
                            style={{ borderColor: tokens.accent, color: tokens.accent }}
                            onClick={save}
                        >
                            Save
                        </button>
                    </div>
                </div>
            )}

            {confirm === null ? null : (
                <div
                    data-testid={`web-storage-confirm-${paneID}`}
                    className="flex flex-col gap-1.5 rounded p-2"
                    style={{ border: `1px solid ${tokens.divider}`, background: tokens.windowBackground }}
                >
                    {/* L74: the question a `confirmationDialog` puts in its visible title. */}
                    <p
                        data-testid={`web-storage-confirm-title-${paneID}`}
                        className="font-medium"
                        style={{ color: tokens.textPrimary }}
                    >
                        {confirm.question}
                    </p>
                    <p style={{ color: tokens.textSecondary }}>{confirm.message}</p>
                    <div className="flex gap-1.5">
                        <button
                            type="button"
                            data-testid={`web-storage-confirm-ok-${paneID}`}
                            className="rounded border px-2 py-[3px]"
                            style={{ borderColor: '#E0685F', color: '#E0685F' }}
                            onClick={() => {
                                const kind = confirm.kind;
                                setConfirm(null);
                                if (kind === 'clear-all') {
                                    void commands.cookiesClear(paneID, { all: true }).then(refresh);
                                    return;
                                }
                                void commands.setPrivate(paneID, !props.isPrivate);
                            }}
                        >
                            {/* L74: the destructive button NAMES the action, never "Continue". */}
                            {confirm.action}
                        </button>
                        <button
                            type="button"
                            data-testid={`web-storage-confirm-cancel-${paneID}`}
                            className="rounded border px-2 py-[3px]"
                            style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                            onClick={() => setConfirm(null)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

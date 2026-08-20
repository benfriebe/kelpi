/**
 * The cookie / site-data panel (web-pane.md §13; WEB-049…WEB-054).
 *
 * A web pane's storage is the one part of its state the daemon does *not* own: cookies live in
 * the Electron session the host built for the pane's partition. So everything here is a verb —
 * `web-cookies-list` to read, `web-cookie-set` to write, `web-cookies-delete` / `-clear` to
 * remove, and a `web-exec` for the localStorage read-out (no host verb needed, the page can read
 * its own storage).
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

/** WEB-049's two messages — the direction is the whole point of the confirmation. */
export function privateModeWarning(enabling: boolean): string {
    return enabling
        ? 'Switching to a private session discards this pane’s cookies when Nex quits, and reloads its tabs against an empty store.'
        : 'Switching back to the persistent session reloads this pane’s tabs, and any cookies saved before it went private will reappear.';
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
    const [localStorageRows, setLocalStorageRows] = useState<readonly (readonly [string, string])[] | null>(null);
    const [confirm, setConfirm] = useState<{ kind: 'clear-all' | 'private'; message: string } | null>(null);

    const refresh = useCallback((): void => {
        void commands.cookiesList(paneID).then((reply) => {
            if (typeof reply !== 'object' || reply === null) return;
            const record = reply as Record<string, unknown>;
            if (record['ok'] !== true || !Array.isArray(record['cookies'])) return;
            setCookies(record['cookies'] as readonly WebCookie[]);
        });
    }, [commands, paneID]);

    useEffect(refresh, [refresh]);

    const groups = useMemo(() => groupCookies(cookies), [cookies]);

    const readLocalStorage = useCallback((): void => {
        void commands
            .exec(
                paneID,
                'Object.keys(localStorage).sort().slice(0, 200).map(function (k) { return [k, String(localStorage.getItem(k)).slice(0, 400)]; })'
            )
            .then((reply) => {
                if (typeof reply !== 'object' || reply === null) return;
                const record = reply as Record<string, unknown>;
                const rows = record['result'];
                setLocalStorageRows(Array.isArray(rows) ? (rows as readonly (readonly [string, string])[]) : []);
            });
    }, [commands, paneID]);

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
            className="flex max-h-[70%] shrink-0 flex-col gap-2 overflow-y-auto p-2 text-[11px]"
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
                <button
                    type="button"
                    data-testid={`web-storage-refresh-${paneID}`}
                    aria-label="Refresh cookies"
                    className="ml-auto rounded border px-1.5 py-[1px] text-[10px]"
                    style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                    onClick={refresh}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    data-testid={`web-storage-close-${paneID}`}
                    aria-label="Close storage panel"
                    style={{ color: tokens.textTertiary }}
                    onClick={props.onClose}
                >
                    ✕
                </button>
            </div>

            {/* WEB-049: the private toggle, and the confirmation that guards both directions. */}
            <label className="flex items-center gap-2">
                <input
                    type="checkbox"
                    role="switch"
                    aria-label="Private session"
                    data-testid={`web-private-toggle-${paneID}`}
                    checked={props.isPrivate}
                    onChange={() => {
                        setConfirm({ kind: 'private', message: privateModeWarning(!props.isPrivate) });
                    }}
                />
                <span>Private session</span>
                <span style={{ color: tokens.textTertiary }}>
                    {props.isPrivate ? 'in-memory store' : 'shared persistent store'}
                </span>
            </label>

            <div
                data-testid={`web-cookie-groups-${paneID}`}
                className="flex flex-col gap-1 overflow-y-auto"
                style={{ maxHeight: 220 }}
            >
                {groups.length === 0 ? (
                    <p style={{ color: tokens.textTertiary }}>No cookies for this pane.</p>
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
                                        aria-label={`Add cookie for ${group.domain}`}
                                        data-testid={`web-cookie-add-${group.domain}`}
                                        style={{ color: tokens.textSecondary }}
                                        onClick={() => setForm(blankForm(group.domain, now()))}
                                    >
                                        ＋
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={`Delete all cookies for ${group.domain}`}
                                        data-testid={`web-cookie-clear-${group.domain}`}
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
                                    : group.cookies.map((cookie) => (
                                          <div
                                              key={`${cookie.name}:${cookie.path}`}
                                              data-testid={`web-cookie-${group.domain}-${cookie.name}`}
                                              className="flex items-center gap-1 px-1.5 py-[3px]"
                                              style={{ borderTop: `1px solid ${tokens.divider}` }}
                                          >
                                              <button
                                                  type="button"
                                                  className="min-w-0 flex-1 truncate text-left font-mono text-[10px]"
                                                  style={{ color: tokens.textSecondary }}
                                                  onClick={() => setForm(formFor(cookie, now()))}
                                              >
                                                  {cookie.name}={cookie.value}
                                              </button>
                                              <button
                                                  type="button"
                                                  aria-label={`Delete cookie ${cookie.name}`}
                                                  data-testid={`web-cookie-delete-${cookie.name}`}
                                                  style={{ color: tokens.textTertiary }}
                                                  onClick={() => {
                                                      void commands
                                                          .cookieDelete(paneID, cookie.name, cookie.domain)
                                                          .then(refresh);
                                                  }}
                                              >
                                                  ✕
                                              </button>
                                          </div>
                                      ))}
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
                        className="rounded border px-2 py-[3px]"
                        style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                        onClick={() => setForm(blankForm('', now()))}
                    >
                        Add cookie
                    </button>
                    <button
                        type="button"
                        data-testid={`web-localstorage-${paneID}`}
                        className="rounded border px-2 py-[3px]"
                        style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                        onClick={readLocalStorage}
                    >
                        Local storage
                    </button>
                    <button
                        type="button"
                        data-testid={`web-clear-site-data-${paneID}`}
                        className="ml-auto rounded border px-2 py-[3px]"
                        style={{ borderColor: '#E0685F', color: '#E0685F' }}
                        onClick={() =>
                            setConfirm({
                                kind: 'clear-all',
                                message:
                                    'Remove every cookie, local storage entry, IndexedDB database and cache for this pane’s store? This cannot be undone.'
                            })
                        }
                    >
                        Clear all site data
                    </button>
                </div>
            ) : (
                <div
                    data-testid={`web-cookie-form-${paneID}`}
                    className="flex flex-col gap-1 rounded p-1.5"
                    style={{ border: `1px solid ${tokens.divider}` }}
                >
                    <div className="flex gap-1">
                        <input
                            aria-label="Cookie name"
                            data-testid={`web-cookie-form-name-${paneID}`}
                            placeholder="name"
                            {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                            className="min-w-0 flex-1 rounded px-1.5 py-[2px] font-mono outline-none"
                            style={{ background: tokens.windowBackground, border: `1px solid ${tokens.divider}`, color: tokens.textPrimary }}
                            value={form.name}
                            onChange={(event) => setForm({ ...form, name: event.target.value })}
                        />
                        <input
                            aria-label="Cookie value"
                            data-testid={`web-cookie-form-value-${paneID}`}
                            placeholder="value"
                            {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                            className="min-w-0 flex-1 rounded px-1.5 py-[2px] font-mono outline-none"
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
                            className="min-w-0 flex-1 rounded px-1.5 py-[2px] font-mono outline-none"
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
                            className="w-20 rounded px-1.5 py-[2px] font-mono outline-none"
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
                    <div className="flex gap-1.5">
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
                        <button
                            type="button"
                            data-testid={`web-cookie-form-cancel-${paneID}`}
                            className="rounded border px-2 py-[3px]"
                            style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                            onClick={() => setForm(null)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {localStorageRows === null ? null : (
                <div
                    data-testid={`web-localstorage-rows-${paneID}`}
                    className="max-h-24 overflow-y-auto rounded p-1.5 font-mono text-[10px]"
                    style={{ border: `1px solid ${tokens.divider}`, color: tokens.textSecondary }}
                >
                    {localStorageRows.length === 0
                        ? 'localStorage is empty'
                        : localStorageRows.map(([key, value]) => (
                              <div key={key} className="truncate">
                                  {key} = {value}
                              </div>
                          ))}
                </div>
            )}

            {confirm === null ? null : (
                <div
                    data-testid={`web-storage-confirm-${paneID}`}
                    className="flex flex-col gap-1.5 rounded p-2"
                    style={{ border: `1px solid ${tokens.divider}`, background: tokens.windowBackground }}
                >
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
                            Continue
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

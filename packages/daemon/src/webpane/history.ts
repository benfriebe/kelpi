/**
 * Web-pane browsing history (issue #375): the pages the USER navigated to, kept so the URL bar
 * can prefill an address and suggest pages while it is typed into.
 *
 * **Only the user's own navigations ever reach this store.** Which navigations those are is the
 * service's call (`./service.ts`, the per-tab driver): a page loaded by `kelpi web …`, a plugin,
 * or anything that followed from one is never recorded. This module stores and ranks; it does not
 * decide who drove a tab.
 *
 * **Why SQLite, in its own file.** History is written on every navigation and grows, so the
 * favourites approach (rewrite one JSON file per change) does not fit. It is not a table in the
 * main database either: that file is cleared and reinserted on every save and shares a migration
 * ledger with the legacy Swift import, and a separate file makes "clear history" a non-event for
 * the workspace state. `node:sqlite` is already the daemon's database engine.
 *
 * **Shape, and where it comes from.** One row per URL plus one row per visit, the way Chrome and
 * Firefox both store it. Keeping visits (not just counters) means a score can be recomputed when
 * the weights change and visits can expire, so the counts describe recent use:
 *
 *   - ranking is Firefox's current frecency: the last 10 visits, each weighted by source (typed
 *     100, link 50) and decayed with a 30-day half-life, averaged and multiplied by the visit
 *     count. It is stored as the day the score will have decayed to 1, so one sortable column
 *     orders every row without a daily recompute;
 *   - visits expire after 90 days (Chrome), and a row cap backs that up;
 *   - 4xx/5xx pages are stored but never suggested (Chrome's `hidden`), and a later successful
 *     load unhides the URL;
 *   - the prefill set is Chrome's and Firefox's typed-only rule: an origin typed at least once,
 *     or a full URL typed at least twice.
 */

import { MEMORY_DATABASE, openSqliteDatabase, type SqlDatabase, type SqlRow } from '../db/adapter.js';

export type HistorySource = 'typed' | 'link';

/** One dropdown suggestion. */
export interface HistoryEntry {
    readonly url: string;
    readonly title: string;
}

/** One address the URL bar may prefill: a whole origin, or a full URL typed more than once. */
export interface PrefillEntry {
    readonly url: string;
    readonly title: string;
    readonly kind: 'origin' | 'url';
}

export interface HistoryVisit {
    readonly url: string;
    readonly title?: string | undefined;
    readonly source: HistorySource;
    /** The HTTP status of the load, when the host knows it (`did-navigate`). */
    readonly status?: number | undefined;
}

export interface WebHistoryStore {
    /** Record one visit. False when the URL is not one history keeps (scheme, length). */
    recordVisit(visit: HistoryVisit): boolean;
    /** A page's title arrived after its visit. No-op for a URL with no row. */
    updateTitle(url: string, title: string): void;
    /** Dropdown suggestions for what is typed in the URL bar, best first. */
    query(text: string, limit?: number): readonly HistoryEntry[];
    /** The addresses the URL bar may prefill, best first. */
    prefill(): readonly PrefillEntry[];
    /**
     * Forget a URL and every visit to it (Shift+Delete). True when something was removed. Throws
     * when the database fails: a deletion the user asked for must never be acknowledged unmade.
     */
    remove(url: string): boolean;
    /**
     * Forget a whole site: every page on the URL's host, every scheme and `www.` variant. What
     * Shift+Delete on a prefilled site does, since one typed page is enough to prefill it.
     */
    removeSite(url: string): boolean;
    /** Forget everything. Throws, like `remove`, when the database fails. */
    clear(): void;
    /**
     * The address the URL bar's text means, using the scheme (and `www.`) history remembers for its
     * host: `wiki.corp.example/x` typed into a bar that has seen `http://wiki.corp.example/` means
     * `http://…`, not the `https://` the bare text would be given. The text unchanged otherwise.
     */
    rememberedAddress(text: string): string;
    /** Drop visits past the retention window and rows past the cap. */
    expire(): void;
    close(): void;
}

export interface WebHistoryStoreOptions {
    /** `web-history.db`'s path. Absent = in memory (unit tests, a `:memory:` daemon). */
    readonly path?: string | undefined;
    readonly now?: (() => number) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** The prefill set changed: the sync hub broadcasts it to every client. */
    readonly onPrefillChanged?: ((entries: readonly PrefillEntry[]) => void) | undefined;
    /** Test seam: open the database (default `openSqliteDatabase`). */
    readonly openDatabase?: ((location: string) => SqlDatabase) | undefined;
}

const DAY_MS = 86_400_000;
export const HISTORY_RETENTION_MS = 90 * DAY_MS;
export const HISTORY_MAX_URLS = 10_000;
/** Firefox's `browser.history.maxUrlLength`. */
export const HISTORY_MAX_URL_LENGTH = 2000;
export const HISTORY_QUERY_DEFAULT_LIMIT = 8;
export const HISTORY_QUERY_MAX_LIMIT = 20;
export const HISTORY_PREFILL_MAX = 500;
/** The daemon is long-lived, so expiry also runs lazily, at most this often. */
const EXPIRE_INTERVAL_MS = DAY_MS;
const FRECENCY_SAMPLE = 10;
const FRECENCY_HALF_LIFE_DAYS = 30;
const FRECENCY_LAMBDA = Math.LN2 / FRECENCY_HALF_LIFE_DAYS;
const SOURCE_WEIGHT: Record<HistorySource, number> = { typed: 100, link: 50 };
/** Candidates fetched by frecency before the boundary-first sort picks the best few. */
const QUERY_CANDIDATES = 100;
const QUERY_MAX_TOKENS = 8;
const KEPT_SCHEMES = new Set(['http:', 'https:', 'file:']);

/**
 * Query or fragment parameters that carry a credential: an OAuth callback's `code`, an implicit
 * flow's `#access_token=`, a magic link's token, a presigned URL's signature. A URL carrying one
 * is not kept at all, because history is persisted for 90 days and every paired device reads it.
 */
const SECRET_PARAMS = new Set([
    'access_token',
    'id_token',
    'refresh_token',
    'token',
    'code',
    'password',
    'passwd',
    'pwd',
    'secret',
    'client_secret',
    'otp',
    'apikey',
    'api_key',
    'signature',
    'sig',
    'x-amz-signature',
    'x-amz-security-token',
    'x-amz-credential',
    'x-goog-signature',
    'x-goog-credential'
]);

function carriesSecret(params: URLSearchParams): boolean {
    for (const name of params.keys()) if (SECRET_PARAMS.has(name.toLowerCase())) return true;
    return false;
}

/**
 * The URL as history keeps it, or null when history does not keep it at all: only `http`,
 * `https` and `file`, at most 2,000 characters, with any `user:pass@` stripped, and never one
 * that carries a credential in its query or its fragment (`SECRET_PARAMS`).
 */
export function sanitizeHistoryURL(raw: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return null;
    }
    if (!KEPT_SCHEMES.has(parsed.protocol)) return null;
    if (carriesSecret(parsed.searchParams)) return null;
    // A fragment shaped like a query (`#access_token=…&state=…`) is read as one.
    const fragment = parsed.hash.slice(1);
    if (fragment.includes('=') && carriesSecret(new URLSearchParams(fragment.replace(/^[/!?]+/, '')))) return null;
    parsed.username = '';
    parsed.password = '';
    const url = parsed.toString();
    return url.length > HISTORY_MAX_URL_LENGTH ? null : url;
}

/** Lowercased, with the scheme, a leading `www.` and trailing slashes dropped. */
export function historyMatchForm(url: string): string {
    let form = url.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    if (form.startsWith('www.')) form = form.slice(4);
    while (form.endsWith('/')) form = form.slice(0, -1);
    return form;
}

/** `https://github.com/` for any page on it; '' for a URL with no host (`file:`). */
export function originOf(url: string): { origin: string; host: string } {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { origin: '', host: '' };
        const host = parsed.host.toLowerCase();
        return { origin: `${parsed.protocol}//${host}/`, host: host.startsWith('www.') ? host.slice(4) : host };
    } catch {
        return { origin: '', host: '' };
    }
}

/** A title is only worth keeping when it says more than the address does. */
function usefulTitle(title: string | undefined, url: string): string {
    const trimmed = (title ?? '').trim();
    if (trimmed === '' || trimmed === url) return '';
    return trimmed;
}

/** A query token, read the way the stored match form is written. */
function queryToken(token: string): string {
    let form = token.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    if (form.startsWith('www.')) form = form.slice(4);
    return form;
}

function startsAtBoundary(haystack: string, needle: string): boolean {
    let at = haystack.indexOf(needle);
    while (at >= 0) {
        if (at === 0 || !/[\p{L}\p{N}]/u.test(haystack.charAt(at - 1))) return true;
        at = haystack.indexOf(needle, at + 1);
    }
    return false;
}

function num(row: SqlRow | undefined, key: string): number {
    const value = row?.[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    return 0;
}

function str(row: SqlRow | undefined, key: string): string {
    const value = row?.[key];
    return typeof value === 'string' ? value : '';
}

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS urls (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        match_url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        title_match TEXT NOT NULL DEFAULT '',
        host TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT '',
        visit_count INTEGER NOT NULL DEFAULT 0,
        typed_count INTEGER NOT NULL DEFAULT 0,
        last_visit INTEGER NOT NULL DEFAULT 0,
        frecency REAL NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS urls_match ON urls(match_url);
    CREATE INDEX IF NOT EXISTS urls_frecency ON urls(frecency);
    CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY,
        url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
        time INTEGER NOT NULL,
        source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS visits_url ON visits(url_id, time);
    CREATE INDEX IF NOT EXISTS visits_time ON visits(time);
    PRAGMA user_version = 1;
    PRAGMA secure_delete = ON;
`;

export function createWebHistoryStore(options: WebHistoryStoreOptions = {}): WebHistoryStore {
    const now = options.now ?? ((): number => Date.now());
    const openDatabase = options.openDatabase ?? ((location: string): SqlDatabase => openSqliteDatabase(location));
    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    const open = (location: string): SqlDatabase => {
        const db = openDatabase(location);
        try {
            db.exec(SCHEMA);
        } catch (error) {
            db.close();
            throw error;
        }
        return db;
    };

    /*
     * A history file that will not open (corrupt, unwritable) must never stop the daemon: the
     * cost is a session without remembered history, reported, and an in-memory store in its place.
     */
    let db: SqlDatabase;
    const location = options.path ?? MEMORY_DATABASE;
    try {
        db = open(location);
    } catch (error) {
        report(error, 'history-open');
        db = open(MEMORY_DATABASE);
    }

    let lastExpiry = Number.NEGATIVE_INFINITY;
    let lastPrefill: string | null = null;

    /** Firefox's frecency, as the day its score decays to 1 (so rows sort by one column). */
    const recomputeFrecency = (urlID: number, visitCount: number): void => {
        const at = now();
        const samples = db.all(
            'SELECT time, source FROM visits WHERE url_id = ? ORDER BY time DESC LIMIT ?',
            urlID,
            FRECENCY_SAMPLE
        );
        if (samples.length === 0 || visitCount <= 0) {
            db.run('DELETE FROM urls WHERE id = ?', urlID);
            return;
        }
        let total = 0;
        for (const sample of samples) {
            const weight = SOURCE_WEIGHT[str(sample, 'source') === 'typed' ? 'typed' : 'link'];
            const ageDays = Math.max(0, at - num(sample, 'time')) / DAY_MS;
            total += weight * Math.exp(-FRECENCY_LAMBDA * ageDays);
        }
        const score = (total / samples.length) * visitCount;
        const frecency = at / DAY_MS + Math.log(score) / FRECENCY_LAMBDA;
        db.run('UPDATE urls SET frecency = ? WHERE id = ?', frecency, urlID);
    };

    const computePrefill = (): PrefillEntry[] => {
        // Origins first: one per host, folding http/https and `www.` (Firefox's origin autofill),
        // eligible once any page on it was typed.
        const byHost = new Map<string, { origin: string; frecency: number; typed: number }>();
        for (const row of db.all(
            `SELECT origin, host, SUM(typed_count) AS typed, MAX(frecency) AS frecency
             FROM urls WHERE hidden = 0 AND origin <> '' GROUP BY origin`
        )) {
            const host = str(row, 'host');
            const variant = { origin: str(row, 'origin'), frecency: num(row, 'frecency'), typed: num(row, 'typed') };
            const current = byHost.get(host);
            if (current === undefined) {
                byHost.set(host, variant);
                continue;
            }
            // The host's typing is the sum over its variants; the address offered is the variant
            // used most.
            const best = variant.frecency > current.frecency ? variant : current;
            byHost.set(host, { ...best, typed: current.typed + variant.typed });
        }
        const ranked: { entry: PrefillEntry; frecency: number }[] = [];
        for (const { origin, frecency, typed } of byHost.values()) {
            if (typed > 0) ranked.push({ entry: { url: origin, title: '', kind: 'origin' }, frecency });
        }
        for (const row of db.all(
            'SELECT url, title, frecency FROM urls WHERE hidden = 0 AND typed_count >= 2 ORDER BY frecency DESC LIMIT ?',
            HISTORY_PREFILL_MAX
        )) {
            ranked.push({ entry: { url: str(row, 'url'), title: str(row, 'title'), kind: 'url' }, frecency: num(row, 'frecency') });
        }
        ranked.sort((a, b) => b.frecency - a.frecency);
        return ranked.slice(0, HISTORY_PREFILL_MAX).map((item) => item.entry);
    };

    /** Tell clients about the prefill set, only when it actually changed. */
    const publishPrefill = (): void => {
        if (options.onPrefillChanged === undefined) return;
        const entries = computePrefill();
        const serialized = JSON.stringify(entries);
        if (serialized === lastPrefill) return;
        lastPrefill = serialized;
        options.onPrefillChanged(entries);
    };

    const expireNow = (): void => {
        const at = now();
        const cutoff = at - HISTORY_RETENTION_MS;
        db.transaction(() => {
            const affected = db.all('SELECT DISTINCT url_id FROM visits WHERE time < ?', cutoff).map((row) => num(row, 'url_id'));
            db.run('DELETE FROM visits WHERE time < ?', cutoff);
            for (const urlID of affected) {
                const counts = db.get(
                    `SELECT COUNT(*) AS visits, SUM(CASE WHEN source = 'typed' THEN 1 ELSE 0 END) AS typed
                     FROM visits WHERE url_id = ?`,
                    urlID
                );
                const visits = num(counts, 'visits');
                db.run('UPDATE urls SET visit_count = ?, typed_count = ? WHERE id = ?', visits, num(counts, 'typed'), urlID);
                recomputeFrecency(urlID, visits);
            }
            // Rows whose every visit is gone (a crash between the two deletes cannot leave any,
            // but a row inserted without a visit would otherwise live for ever).
            db.run('DELETE FROM urls WHERE id NOT IN (SELECT DISTINCT url_id FROM visits)');
            const excess = num(db.get('SELECT COUNT(*) AS n FROM urls'), 'n') - HISTORY_MAX_URLS;
            if (excess > 0) {
                db.run('DELETE FROM urls WHERE id IN (SELECT id FROM urls ORDER BY frecency ASC LIMIT ?)', excess);
            }
        });
        lastExpiry = at;
    };

    const expireIfDue = (): void => {
        if (now() - lastExpiry < EXPIRE_INTERVAL_MS) return;
        expireNow();
    };

    try {
        expireNow();
    } catch (error) {
        report(error, 'history-expire');
    }

    return {
        recordVisit(visit) {
            const url = sanitizeHistoryURL(visit.url);
            if (url === null) return false;
            try {
                expireIfDue();
                const at = now();
                const title = usefulTitle(visit.title, url);
                const failed = visit.status !== undefined && visit.status >= 400;
                db.transaction(() => {
                    let row = db.get('SELECT id, visit_count, typed_count, hidden FROM urls WHERE url = ?', url);
                    if (row === undefined) {
                        const { origin, host } = originOf(url);
                        db.run(
                            `INSERT INTO urls (url, match_url, title, title_match, host, origin, last_visit, hidden)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            url,
                            historyMatchForm(url),
                            title,
                            title.toLowerCase(),
                            host,
                            origin,
                            at,
                            failed ? 1 : 0
                        );
                        row = db.get('SELECT id, visit_count, typed_count, hidden FROM urls WHERE url = ?', url);
                    }
                    const urlID = num(row, 'id');
                    // No status (a same-document navigation) keeps whatever the document was.
                    const hidden = visit.status === undefined ? num(row, 'hidden') : failed ? 1 : 0;
                    const visits = num(row, 'visit_count') + 1;
                    db.run('INSERT INTO visits (url_id, time, source) VALUES (?, ?, ?)', urlID, at, visit.source);
                    db.run(
                        `UPDATE urls SET visit_count = ?, typed_count = typed_count + ?, last_visit = ?, hidden = ?,
                         title = CASE WHEN ? <> '' THEN ? ELSE title END,
                         title_match = CASE WHEN ? <> '' THEN ? ELSE title_match END
                         WHERE id = ?`,
                        visits,
                        visit.source === 'typed' ? 1 : 0,
                        at,
                        hidden,
                        title,
                        title,
                        title,
                        title.toLowerCase(),
                        urlID
                    );
                    recomputeFrecency(urlID, visits);
                });
                publishPrefill();
                return true;
            } catch (error) {
                report(error, 'history-record');
                return false;
            }
        },

        updateTitle(rawURL, rawTitle) {
            const url = sanitizeHistoryURL(rawURL);
            if (url === null) return;
            const title = usefulTitle(rawTitle, url);
            if (title === '') return;
            try {
                db.run('UPDATE urls SET title = ?, title_match = ? WHERE url = ?', title, title.toLowerCase(), url);
            } catch (error) {
                report(error, 'history-title');
            }
        },

        query(text, limit = HISTORY_QUERY_DEFAULT_LIMIT) {
            const tokens = text
                .toLowerCase()
                .split(/\s+/)
                .map(queryToken)
                .filter((token) => token !== '')
                .slice(0, QUERY_MAX_TOKENS);
            if (tokens.length === 0) return [];
            const cap = Math.max(1, Math.min(HISTORY_QUERY_MAX_LIMIT, Math.floor(limit)));
            try {
                // Every token must appear in the address or the title (Firefox's urlbar rule).
                const where = tokens.map(() => '(instr(match_url, ?) > 0 OR instr(title_match, ?) > 0)').join(' AND ');
                const rows = db.all(
                    `SELECT url, title, match_url, title_match FROM urls WHERE hidden = 0 AND ${where}
                     ORDER BY frecency DESC LIMIT ?`,
                    ...tokens.flatMap((token) => [token, token]),
                    QUERY_CANDIDATES
                );
                // Word-boundary matches before matches anywhere; frecency order within each.
                const boundary = (row: SqlRow): boolean =>
                    tokens.every(
                        (token) => startsAtBoundary(str(row, 'match_url'), token) || startsAtBoundary(str(row, 'title_match'), token)
                    );
                const ordered = [...rows.filter(boundary), ...rows.filter((row) => !boundary(row))];
                const seen = new Set<string>();
                const out: HistoryEntry[] = [];
                for (const row of ordered) {
                    // http/https, `www.` and trailing-slash variants are one suggestion.
                    const key = str(row, 'match_url');
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({ url: str(row, 'url'), title: str(row, 'title') });
                    if (out.length >= cap) break;
                }
                return out;
            } catch (error) {
                report(error, 'history-query');
                return [];
            }
        },

        prefill() {
            try {
                return computePrefill();
            } catch (error) {
                report(error, 'history-prefill');
                return [];
            }
        },

        remove(rawURL) {
            const key = historyMatchForm(rawURL);
            if (key === '') return false;
            let changes: number;
            try {
                // Every variant the dropdown folded into the row the user removed.
                changes = Number(db.run('DELETE FROM urls WHERE match_url = ?', key).changes);
            } catch (error) {
                report(error, 'history-remove');
                throw error;
            }
            if (changes > 0) publishPrefill();
            return changes > 0;
        },

        removeSite(rawURL) {
            const { host } = originOf(sanitizeHistoryURL(rawURL) ?? rawURL);
            if (host === '') return false;
            let changes: number;
            try {
                changes = Number(db.run('DELETE FROM urls WHERE host = ?', host).changes);
            } catch (error) {
                report(error, 'history-remove');
                throw error;
            }
            if (changes > 0) publishPrefill();
            return changes > 0;
        },

        rememberedAddress(text) {
            const trimmed = text.trim();
            // Only bare `host[:port][/path]`: anything with a scheme already says what it means.
            if (trimmed === '' || /\s/.test(trimmed) || trimmed.includes('://')) return text;
            const slash = trimmed.indexOf('/');
            const typedHost = (slash < 0 ? trimmed : trimmed.slice(0, slash)).toLowerCase();
            if (!/^[a-z0-9.-]+(:\d+)?$/.test(typedHost)) return text;
            const host = typedHost.startsWith('www.') ? typedHost.slice(4) : typedHost;
            try {
                const row = db.get(
                    `SELECT origin FROM urls WHERE host = ? AND origin <> '' AND hidden = 0
                     ORDER BY frecency DESC LIMIT 1`,
                    host
                );
                const origin = str(row, 'origin');
                if (origin === '') return text;
                // A `www.` the user typed stands; otherwise the remembered origin, `www.` and all.
                if (typedHost.startsWith('www.')) return `${origin.slice(0, origin.indexOf('//') + 2)}${trimmed}`;
                return `${origin}${slash < 0 ? '' : trimmed.slice(slash + 1)}`;
            } catch (error) {
                report(error, 'history-address');
                return text;
            }
        },

        clear() {
            try {
                db.transaction(() => {
                    db.run('DELETE FROM visits');
                    db.run('DELETE FROM urls');
                });
            } catch (error) {
                report(error, 'history-clear');
                throw error;
            }
            // "This cannot be undone": with `secure_delete` the pages are zeroed, and these take
            // what is left out of the write-ahead log and the free list. Best effort (memory has
            // neither).
            try {
                db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
                db.exec('VACUUM');
            } catch (error) {
                report(error, 'history-vacuum');
            }
            publishPrefill();
        },

        expire() {
            try {
                expireNow();
                publishPrefill();
            } catch (error) {
                report(error, 'history-expire');
            }
        },

        close() {
            if (db.isOpen) db.close();
        }
    };
}

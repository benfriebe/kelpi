/**
 * The URL bar's history rules (#375): what it prefills, and which suggestions it lists.
 *
 * The daemon keeps the history and decides what is eligible to prefill at all (origins the user
 * has typed, and full URLs typed at least twice), and sends that list to every window as
 * `web-history-typed`. Everything here runs on that list in the client, synchronously, so the
 * prefill never waits on a round trip: a reply arriving after the next keystroke is the race
 * this design exists to avoid, and over a remote connection it is the common case.
 *
 * The rules are the conservative ones Chrome and Firefox converged on:
 *   - complete to the SITE first (`gi` → `github.com/`), and only reach into a path once the
 *     typed text has (`github.com/an` → `github.com/anthropics/`), stopping at the next `/`;
 *   - a plain prefix match on the address without its scheme or `www.`, ignoring case;
 *   - the typed text is never rewritten, so the user's own capitalisation stands;
 *   - an address the user typed exactly needs no completion.
 *
 * When NOT to complete (delete, paste, IME composition, caret not at the end) is the input
 * handler's decision in `./WebPane.tsx`, because only it can see the event.
 */

/** One prefill candidate, as the daemon lists it: best first. */
export interface WebHistoryEntry {
    readonly url: string;
    readonly title: string;
    /** `origin` entries are a site (`https://github.com/`); `url` entries are a full address. */
    readonly kind: 'origin' | 'url';
    /** A favourite's site, added in the client (`prefillCandidates`): not history to remove. */
    readonly favourite?: true | undefined;
}

/** One row of the suggestion list. */
export interface WebHistorySuggestion {
    readonly url: string;
    readonly title: string;
    /** Favourites are listed with history but are not history: Shift+Delete leaves them alone. */
    readonly favourite: boolean;
}

/** How many favourites lead the list, so history always has room under them. */
export const MAX_FAVOURITE_SUGGESTIONS = 3;

/** How many rows the list shows (Chrome shows 8, Firefox 10). */
export const MAX_SUGGESTIONS = 8;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The address without its `scheme://`. */
function withoutScheme(url: string): string {
    return url.replace(SCHEME, '');
}

/** The address without its scheme and a leading `www.`: what typed text is matched against. */
export function stripForMatch(url: string): string {
    return withoutScheme(url.trim()).replace(/^www\./i, '');
}

/**
 * The key two addresses share when they are the same page for the list's purposes: scheme,
 * `www.` and trailing slashes dropped, case folded. `http://www.example.com/` and
 * `https://example.com` collapse to one row.
 */
export function suggestionKey(url: string): string {
    return stripForMatch(url).replace(/\/+$/, '').toLowerCase();
}

/** The forms of a candidate's address that typed text is compared with (lowercased). */
function candidateForms(candidate: WebHistoryEntry, typedScheme: boolean): readonly string[] {
    const bare = withoutScheme(candidate.url);
    const scheme = candidate.url.slice(0, candidate.url.length - bare.length);
    // A typed scheme has to be the candidate's own (Firefox's prefix rule): `http://gi` is not a
    // request for `https://github.com/`.
    return typedScheme
        ? [candidate.url, `${scheme}${bare.replace(/^www\./i, '')}`]
        : [bare.replace(/^www\./i, ''), bare];
}

/**
 * What to show selected after `input`, and the candidate it came from; null for nothing.
 *
 * `candidates` is the daemon's prefill list, best first, with any extra candidates (favourite
 * sites) appended. An address the user has typed EXACTLY (or the site they have typed to its
 * last character) needs no completion, even when a longer address ranks higher: typing all of
 * `amazon.com` must not open `amazon.com.au`. Otherwise the first candidate whose address starts
 * with the input wins.
 */
export function inlineCompletionMatch(
    input: string,
    candidates: readonly WebHistoryEntry[]
): { readonly text: string; readonly entry: WebHistoryEntry } | null {
    if (input === '' || /\s/.test(input)) return null;
    const lower = input.toLowerCase();
    const typedScheme = SCHEME.exec(input);
    const host = typedScheme === null ? input : input.slice(typedScheme[0].length);
    // A `/` after the host means the user is into the path: only full addresses can complete
    // that, and a site cannot. Before it, only sites complete, so a long address typed twice
    // never jumps ahead of the site it is on.
    const reachedPath = host.includes('/');
    const eligible = candidates.filter((candidate) => (candidate.kind === 'url') === reachedPath);

    for (const candidate of eligible) {
        for (const form of candidateForms(candidate, typedScheme !== null)) {
            const folded = form.toLowerCase();
            if (folded === lower || folded === `${lower}/`) return null;
        }
    }
    for (const candidate of eligible) {
        for (const form of candidateForms(candidate, typedScheme !== null)) {
            if (!form.toLowerCase().startsWith(lower)) continue;
            let rest = form.slice(input.length);
            if (candidate.kind === 'url') {
                // Firefox's rule: fill one path segment at a time, so the next `/` is a stop.
                const slash = rest.indexOf('/');
                if (slash >= 0) rest = rest.slice(0, slash + 1);
            }
            return { text: rest, entry: candidate };
        }
    }
    return null;
}

/** The text to show selected after `input`, or `''` for none (`inlineCompletionMatch`). */
export function inlineCompletion(input: string, candidates: readonly WebHistoryEntry[]): string {
    return inlineCompletionMatch(input, candidates)?.text ?? '';
}

/**
 * The prefill candidates: the daemon's list, then the site of every favourite it does not
 * already name. A favourite is a page the user chose to keep, which is as clear a signal as
 * having typed it (Firefox autofills bookmarked sites for the same reason).
 */
export function prefillCandidates(
    typed: readonly WebHistoryEntry[],
    favourites: readonly { readonly url: string; readonly title: string }[]
): readonly WebHistoryEntry[] {
    if (favourites.length === 0) return typed;
    const seen = new Set(typed.filter((entry) => entry.kind === 'origin').map((entry) => suggestionKey(entry.url)));
    const extra: WebHistoryEntry[] = [];
    for (const favourite of favourites) {
        let origin: string;
        try {
            const parsed = new URL(favourite.url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
            origin = `${parsed.origin}/`;
        } catch {
            continue;
        }
        const key = suggestionKey(origin);
        if (seen.has(key)) continue;
        seen.add(key);
        extra.push({ url: origin, title: '', kind: 'origin', favourite: true });
    }
    return extra.length === 0 ? typed : [...typed, ...extra];
}

/**
 * Does a page match what is typed? Every whitespace-separated word has to appear in the address
 * (scheme and `www.` stripped) or the title, ignoring case: the daemon's own query rule, so a
 * favourite and a history row are judged the same way.
 */
export function matchesQuery(text: string, url: string, title: string): boolean {
    // A typed scheme or `www.` is read the way the address is (the daemon does the same), so a
    // bare `https://` is no word at all rather than one that matches nothing.
    const words = text
        .toLowerCase()
        .split(/\s+/)
        .map((word) => stripForMatch(word))
        .filter((word) => word !== '');
    if (words.length === 0) return false;
    const address = stripForMatch(url).toLowerCase();
    const label = title.toLowerCase();
    return words.every((word) => address.includes(word) || label.includes(word));
}

/**
 * The rows under the bar: favourites that match first (at most three), then history, one row per
 * page, and never the row the bar is already prefilling (Enter opens that one anyway).
 */
export function mergeSuggestions(options: {
    readonly text: string;
    readonly history: readonly { readonly url: string; readonly title: string }[];
    readonly favourites: readonly { readonly url: string; readonly title: string }[];
    /** The address in the bar, completion included. */
    readonly prefilled: string;
}): readonly WebHistorySuggestion[] {
    const rows: WebHistorySuggestion[] = [];
    const seen = new Set<string>();
    if (options.prefilled.trim() !== '') seen.add(suggestionKey(options.prefilled));
    const take = (url: string, title: string, favourite: boolean): void => {
        const key = suggestionKey(url);
        if (key === '' || seen.has(key)) return;
        seen.add(key);
        rows.push({ url, title, favourite });
    };
    for (const favourite of options.favourites) {
        if (rows.length >= MAX_FAVOURITE_SUGGESTIONS) break;
        if (matchesQuery(options.text, favourite.url, favourite.title)) take(favourite.url, favourite.title, true);
    }
    for (const entry of options.history) {
        if (rows.length >= MAX_SUGGESTIONS) break;
        // The rows may answer an earlier draft while this one's query is in flight. Only those
        // that still match what is typed stay (typing on only narrows), so a page that no longer
        // matches can never be what Return opens.
        if (matchesQuery(options.text, entry.url, entry.title)) take(entry.url, entry.title, false);
    }
    return rows;
}

// ── wire shapes ─────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{url, title}` rows, as `web-history-query` answers them. Rows without a URL are dropped. */
export function parseHistoryRows(raw: unknown): readonly { readonly url: string; readonly title: string }[] {
    if (!Array.isArray(raw)) return [];
    const out: { url: string; title: string }[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const url = typeof entry['url'] === 'string' ? entry['url'] : '';
        if (url === '') continue;
        out.push({ url, title: typeof entry['title'] === 'string' ? entry['title'] : '' });
    }
    return out;
}

/** The prefill list, from a `web-history-typed-list` reply or a `web-history-typed` broadcast. */
export function parseHistoryEntries(raw: unknown): readonly WebHistoryEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: WebHistoryEntry[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const url = typeof entry['url'] === 'string' ? entry['url'] : '';
        const kind = entry['kind'];
        if (url === '' || (kind !== 'origin' && kind !== 'url')) continue;
        out.push({ url, title: typeof entry['title'] === 'string' ? entry['title'] : '', kind });
    }
    return out;
}

/** A `web-history-typed` broadcast, or null when the message is something else. */
export function parseHistoryTypedMessage(message: unknown): readonly WebHistoryEntry[] | null {
    if (!isRecord(message) || message['type'] !== 'web-history-typed') return null;
    return parseHistoryEntries(message['entries']);
}

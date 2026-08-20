/**
 * The client's read models for the two web-pane surfaces the daemon owns but no `DomainEvent`
 * describes: **favourites** (§14) and a pane's **batch pickup session** (§12).
 *
 * Neither rides the delta stream — a favourite is not a workspace and a batch is not a pane — so
 * both arrive as their own broadcasts (`web-favourites`, `web-batch`) and as the reply to their
 * own verbs. This module is the parsing and the matching, kept pure so both paths agree and so
 * the rules that matter (WEB-044's URL match, WEB-132's destination validity) are testable
 * without a socket.
 */

export interface WebFavourite {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly created_at: string;
    /** Title → host → raw URL, computed daemon-side so every client shows the same label. */
    readonly label: string;
}

export interface WebBatchItem {
    readonly id: string;
    readonly selector: string;
    readonly tag: string;
    readonly text: string;
    readonly url: string;
    readonly comment: string;
}

export interface WebBatchSession {
    readonly visible: boolean;
    readonly focused_id: string | null;
    readonly last_target: string | null;
    readonly submit: boolean;
    readonly items: readonly WebBatchItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}

export function parseFavourite(raw: unknown): WebFavourite | null {
    if (!isRecord(raw)) return null;
    const id = str(raw, 'id');
    const url = str(raw, 'url');
    if (id === '' || url === '') return null;
    return {
        id,
        url,
        title: str(raw, 'title'),
        created_at: str(raw, 'created_at'),
        label: str(raw, 'label') === '' ? url : str(raw, 'label')
    };
}

export function parseFavourites(raw: unknown): readonly WebFavourite[] {
    if (!Array.isArray(raw)) return [];
    const out: WebFavourite[] = [];
    for (const entry of raw) {
        const favourite = parseFavourite(entry);
        if (favourite !== null) out.push(favourite);
    }
    return out;
}

/** A `web-favourites` broadcast, or null when the message is something else. */
export function parseFavouritesMessage(message: unknown): readonly WebFavourite[] | null {
    if (!isRecord(message) || message['type'] !== 'web-favourites') return null;
    return parseFavourites(message['favourites']);
}

export function parseBatchSession(raw: unknown): WebBatchSession | null {
    if (!isRecord(raw)) return null;
    const items: WebBatchItem[] = [];
    if (Array.isArray(raw['items'])) {
        for (const entry of raw['items']) {
            if (!isRecord(entry)) continue;
            const id = str(entry, 'id');
            if (id === '') continue;
            items.push({
                id,
                selector: str(entry, 'selector'),
                tag: str(entry, 'tag'),
                text: str(entry, 'text'),
                url: str(entry, 'url'),
                comment: str(entry, 'comment')
            });
        }
    }
    const focused = raw['focused_id'];
    const target = raw['last_target'];
    return {
        visible: raw['visible'] !== false,
        focused_id: typeof focused === 'string' && focused !== '' ? focused : null,
        last_target: typeof target === 'string' && target !== '' ? target : null,
        submit: raw['submit'] === true,
        items
    };
}

/** A `web-batch` broadcast: `{paneID, batch}` where a null batch means "the session ended". */
export function parseBatchMessage(
    message: unknown
): { readonly paneID: string; readonly batch: WebBatchSession | null } | null {
    if (!isRecord(message) || message['type'] !== 'web-batch') return null;
    const paneID = str(message, 'paneID');
    if (paneID === '') return null;
    return { paneID, batch: parseBatchSession(message['batch']) };
}

// ── WEB-032/WEB-033/WEB-034: the loading + history report ───────────────────────────

/** One tab's live browser state, as the host reports it through the daemon. */
export interface WebNavState {
    readonly paneID: string;
    readonly tabID: string;
    readonly loading: boolean;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
}

/**
 * A `web-nav-state` broadcast, or null when the message is something else.
 *
 * Keyed by TAB, which is what makes WEB-034 possible: the chrome keeps the last report for every
 * tab it has heard about and reads the ACTIVE one, so switching INTO a tab that is still loading
 * shows its strip, and switching away from one cannot strand a frozen bar.
 */
export function parseNavStateMessage(message: unknown): WebNavState | null {
    if (!isRecord(message) || message['type'] !== 'web-nav-state') return null;
    const paneID = str(message, 'paneID');
    const tabID = str(message, 'tabID');
    if (paneID === '' || tabID === '') return null;
    return {
        paneID,
        tabID,
        loading: message['loading'] === true,
        canGoBack: message['can_go_back'] === true,
        canGoForward: message['can_go_forward'] === true
    };
}

// ── WEB-044: the favourite match ────────────────────────────────────────────────────

/**
 * The same rule the daemon applies (`webpane/favourites.ts`): scheme and host are lowercased
 * (they are case-insensitive by spec), trailing slashes are stripped, and path/query keep their
 * case. Duplicated deliberately — the star has to light up the instant a page's URL changes,
 * without a round trip to ask.
 */
export function normalizeFavouriteURL(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    let normalized = trimmed;
    try {
        normalized = new URL(trimmed).toString();
    } catch {
        normalized = trimmed;
    }
    while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    return normalized;
}

export function favouriteMatching(
    favourites: readonly WebFavourite[],
    url: string
): WebFavourite | null {
    const needle = normalizeFavouriteURL(url);
    if (needle === '') return null;
    return favourites.find((favourite) => normalizeFavouriteURL(favourite.url) === needle) ?? null;
}

/** §16.1: a favourite's menu label is middle-truncated at 50 characters (WEB-038). */
export function truncateMiddle(value: string, limit = 50): string {
    if (value.length <= limit) return value;
    const head = Math.ceil((limit - 1) / 2);
    const tail = limit - 1 - head;
    return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

// ── WEB-132/WEB-133: the batch destination picker ───────────────────────────────────

export interface BatchDestination {
    readonly paneID: string;
    readonly label: string;
}

/** One candidate pane, as the grid knows it. */
export interface DestinationCandidate {
    readonly id: string;
    readonly type: string;
    readonly tag?: string | null | undefined;
    readonly workingDirectory?: string | null | undefined;
}

/**
 * WEB-133: only other **shell** panes in the same workspace can receive a batch — a shell is the
 * only pane type with a PTY to paste into. Labelled by tag when it has one, else
 * `shell: <cwd tail>`, so two untitled shells are still tellable apart.
 */
export function batchDestinations(
    panes: readonly DestinationCandidate[],
    sourcePaneID: string
): readonly BatchDestination[] {
    const out: BatchDestination[] = [];
    for (const pane of panes) {
        if (pane.id === sourcePaneID || pane.type !== 'shell') continue;
        const tag = (pane.tag ?? '').trim();
        if (tag !== '') {
            out.push({ paneID: pane.id, label: tag });
            continue;
        }
        const cwd = (pane.workingDirectory ?? '').trim();
        const tail = cwd === '' ? '' : (cwd.split('/').filter((part) => part !== '').pop() ?? '');
        out.push({ paneID: pane.id, label: tail === '' ? 'shell' : `shell: ${tail}` });
    }
    return out;
}

/**
 * WEB-132: the picker is seeded from the session's `last_target`, but only when that pane still
 * exists — a destination that disappeared mid-batch resets the picker to unselected rather than
 * leaving Send pointed at nothing.
 */
export function seededDestination(
    session: WebBatchSession | null,
    destinations: readonly BatchDestination[]
): string | null {
    const remembered = session?.last_target ?? null;
    if (remembered === null) return null;
    return destinations.some((entry) => entry.paneID === remembered) ? remembered : null;
}

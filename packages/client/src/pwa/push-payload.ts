/**
 * What a push carries and where a tap on it goes: the service worker's half of phone push, kept
 * pure so vitest can run it (`sw.ts` itself runs in a global vitest cannot mount). The daemon's end
 * is `daemon/src/push/service.ts` `PushPayload`.
 *
 * **The app must not import this file.** `vite.config.ts` builds the worker as a second entry and
 * fails the build if `sw.js` comes out importing a chunk it shares with the app, so the page's
 * readers of what this writes (the open fragment, the posted message) live in `push.ts`, and
 * `push.test.ts` holds the two ends to each other.
 *
 * Nothing here trusts the payload: it was sealed by a host this phone registered with, but a
 * service worker that throws on a malformed push shows nothing at all, and iOS takes the
 * subscription away from a web app that receives pushes without showing a notification. So every
 * field is optional on the way in and a push always becomes a notification.
 */

/** The page-side message a tap posts to an open window (`sw.ts` → `PhoneShell`). */
export const PUSH_OPEN_MESSAGE = 'kelpi-push-open';

/** The fragment a tap opens a fresh window on, when no window is open to post to. */
export const PUSH_OPEN_HASH_KEY = 'kelpi-open';

/**
 * Where a tap is also written down, for the page to take on load and on coming back on screen.
 * The message alone is not enough on iOS: a Home Screen app launched by the tap is already in
 * `clients.matchAll` before it has loaded, so the worker posts to a page with nobody listening yet
 * and never opens the fragment. Cache storage because the page can read it too, and it outlives
 * the worker, which iOS stops soon after the click. Not under the shell cache's prefix, which
 * `activate` clears.
 */
export const PUSH_OPEN_CACHE = 'kelpi-push-open';
export const PUSH_OPEN_RECORD_PATH = '/__kelpi/push-open';

/** The icon the manifest already ships (`manifest.ts` `MANIFEST_ICONS`). */
const NOTIFICATION_ICON = '/icon-192.png';

/** Which host, workspace and pane a notification is about. */
export interface PushOpenTarget {
    readonly host: string;
    readonly workspaceID: string;
    readonly paneID: string;
}

/** `Notification.data` on every notification the worker shows. */
export interface PushNotificationData {
    readonly kind: string;
    readonly host: string | null;
    readonly workspaceID: string | null;
    readonly paneID: string | null;
}

export interface PushDisplay {
    readonly title: string;
    readonly options: {
        readonly body: string;
        readonly tag: string;
        /** A newer notification replacing one still shown alerts again; without it Chrome swaps the text silently. */
        readonly renotify: true;
        readonly icon: string;
        readonly data: PushNotificationData;
    };
}

function field(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A push's text (or null for an empty push) as the notification to show. Never throws. */
export function parsePushPayload(text: string | null): PushDisplay {
    let record: Record<string, unknown> = {};
    try {
        const parsed: unknown = text === null ? null : JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) record = parsed as Record<string, unknown>;
    } catch {
        // Shown as the generic notification below.
    }
    const paneID = field(record, 'paneID');
    return {
        title: field(record, 'title') ?? 'Kelpi',
        options: {
            body: field(record, 'body') ?? 'Something in Kelpi needs you.',
            // `kelpi-<paneID>`: a newer notification for a pane replaces the older one (§7.5).
            // Never empty: `renotify` with no tag is a TypeError, and a push that shows nothing costs the subscription.
            tag: field(record, 'tag') ?? (paneID !== null ? `kelpi-${paneID}` : 'kelpi'),
            renotify: true,
            icon: NOTIFICATION_ICON,
            data: {
                kind: field(record, 'kind') ?? 'unknown',
                host: field(record, 'host'),
                workspaceID: field(record, 'workspaceID'),
                paneID
            }
        }
    };
}

/** Where a shown notification's tap goes, or null when it names no pane (a test, a malformed push). */
export function openTargetOf(data: unknown): PushOpenTarget | null {
    if (typeof data !== 'object' || data === null) return null;
    const record = data as Record<string, unknown>;
    const host = field(record, 'host');
    const workspaceID = field(record, 'workspaceID');
    const paneID = field(record, 'paneID');
    return host !== null && workspaceID !== null && paneID !== null ? { host, workspaceID, paneID } : null;
}

/** The body of the `PUSH_OPEN_RECORD_PATH` entry: the target, and when it was tapped. */
export function pushOpenRecord(target: PushOpenTarget, at: number): string {
    return JSON.stringify({ host: target.host, workspaceID: target.workspaceID, paneID: target.paneID, at });
}

/** `#kelpi-open=<host>/<workspace>/<pane>`: a fragment, so it never reaches a server or a cache. */
export function pushOpenHash(target: PushOpenTarget): string {
    return `#${PUSH_OPEN_HASH_KEY}=${[target.host, target.workspaceID, target.paneID].map(encodeURIComponent).join('/')}`;
}

/**
 * The client half of desktop notifications (agent-lifecycle.md §7, port notes 2–3).
 *
 * **Suppression is the daemon's decision, not ours.** The daemon runs the whole matrix
 * (focused? app active? background work?) using this client's focus/visibility reports and
 * simply does not broadcast a notification we should not show (`ws/sync.ts` `broadcast` +
 * `handlers/app/events.ts`). So everything that arrives here gets rendered — the only local
 * gate is the browser's permission state.
 *
 * What the port MUST preserve:
 *   - **`kelpi-<paneID>` identity**: a newer notification for a pane REPLACES the older one.
 *     The Web Notifications API does that natively through `tag`; the in-app toast fallback
 *     re-implements it by keying on the same string.
 *   - **Open → navigate**: clicking activates the client, switches to the notification's
 *     workspace and focuses its pane (ordering matters — workspace first, pane last, §8.5).
 *   - **Removal on acknowledgment**: when the user visits a pane, its notification and toast
 *     go away (`clear(paneID)`), so no stale "waiting" banner survives.
 *
 * Permission is never requested on import: browsers only grant it from a user gesture, so the
 * host calls `requestNotificationPermission()` from a click and we post nothing until then.
 */

import type { WsNotificationMessage } from '@kelpi/protocol';

import type { Toast } from './store';

// ── the slice of the Web Notifications API we use ───────────────────────────────────

export type NotificationPermissionState = 'default' | 'granted' | 'denied';

export interface NotificationLike {
    onclick: ((event: unknown) => void) | null;
    onclose?: ((event: unknown) => void) | null;
    close(): void;
}

export interface NotificationInit {
    readonly body?: string;
    readonly tag?: string;
    readonly data?: unknown;
    readonly silent?: boolean;
}

export interface NotificationApi {
    readonly permission: NotificationPermissionState;
    requestPermission(): Promise<NotificationPermissionState>;
    create(title: string, init: NotificationInit): NotificationLike;
}

/** The real browser API, or undefined where there is none (jsdom, iOS Safari in a tab). */
export function browserNotificationApi(): NotificationApi | undefined {
    const ctor = (
        globalThis as {
            Notification?: {
                new (title: string, options?: NotificationInit): NotificationLike;
                permission: NotificationPermissionState;
                requestPermission(): Promise<NotificationPermissionState>;
            };
        }
    ).Notification;
    if (ctor === undefined) return undefined;
    return {
        get permission(): NotificationPermissionState {
            return ctor.permission;
        },
        requestPermission: () => ctor.requestPermission(),
        create: (title, init) => new ctor(title, init)
    };
}

export interface NotificationTarget {
    readonly paneID: string;
    readonly workspaceID: string;
}

export interface NotificationManagerOptions {
    /** Defaults to the browser API when present; inject a fake in tests. */
    readonly api?: NotificationApi | undefined;
    /** In-app fallback sink (the store's `pushToast`). */
    readonly onToast?: ((toast: Toast) => void) | undefined;
    readonly onDismissToast?: ((id: string) => void) | undefined;
    /** Clicking a notification: activate workspace, then focus the pane (§8.5 ordering). */
    readonly onOpen?: ((target: NotificationTarget) => void) | undefined;
    /** Post a toast even when a system notification was shown (default false). */
    readonly alwaysToast?: boolean | undefined;
    readonly now?: (() => number) | undefined;
}

export interface NotificationManager {
    /** One `notification` message from the daemon. Returns how it was rendered. */
    handle(message: WsNotificationMessage): 'system' | 'toast' | 'dropped';
    /** Focus acknowledgment: drop the pane's delivered notification and its toast. */
    clear(paneID: string): void;
    clearAll(): void;
    /** Permission prompt — call from a user gesture. */
    request(): Promise<NotificationPermissionState>;
    readonly permission: NotificationPermissionState;
    /** Live tags (one per pane); the replace semantics are observable through this. */
    readonly activeTags: readonly string[];
}

/** The dedupe identity the daemon sends; recomputed here for OSC/synthetic paths. */
export function dedupeKeyForPane(paneID: string): string {
    return `kelpi-${paneID}`;
}

export function createNotificationManager(options: NotificationManagerOptions = {}): NotificationManager {
    const api = options.api ?? browserNotificationApi();
    const now = options.now ?? Date.now;
    const live = new Map<string, NotificationLike>();

    const permission = (): NotificationPermissionState => api?.permission ?? 'denied';

    const toast = (message: WsNotificationMessage, key: string): void => {
        options.onToast?.({
            id: key,
            kind: message.kind,
            title: message.title,
            body: message.body,
            paneID: message.paneID,
            workspaceID: message.workspaceID,
            createdAt: now()
        });
    };

    return {
        get permission(): NotificationPermissionState {
            return permission();
        },

        get activeTags(): readonly string[] {
            return [...live.keys()];
        },

        async request(): Promise<NotificationPermissionState> {
            if (api === undefined) return 'denied';
            if (api.permission !== 'default') return api.permission;
            try {
                return await api.requestPermission();
            } catch {
                return 'denied';
            }
        },

        handle(message) {
            const key = message.dedupeKey.length > 0 ? message.dedupeKey : dedupeKeyForPane(message.paneID);

            if (api === undefined || permission() !== 'granted') {
                toast(message, key);
                return 'toast';
            }

            let notification: NotificationLike;
            try {
                notification = api.create(message.title, {
                    body: message.body,
                    tag: key,
                    data: { paneID: message.paneID, workspaceID: message.workspaceID }
                });
            } catch {
                toast(message, key);
                return 'toast';
            }

            // `tag` makes the browser replace the previous banner; we mirror that in our own
            // bookkeeping so `clear(paneID)` only ever holds the newest one.
            live.set(key, notification);
            notification.onclick = () => {
                options.onOpen?.({ paneID: message.paneID, workspaceID: message.workspaceID });
                live.delete(key);
                try {
                    notification.close();
                } catch {
                    // Already gone.
                }
            };

            if (options.alwaysToast === true) toast(message, key);
            return 'system';
        },

        clear(paneID) {
            const key = dedupeKeyForPane(paneID);
            const notification = live.get(key);
            if (notification !== undefined) {
                live.delete(key);
                try {
                    notification.close();
                } catch {
                    // Already gone.
                }
            }
            options.onDismissToast?.(key);
        },

        clearAll() {
            for (const [key, notification] of [...live.entries()]) {
                live.delete(key);
                try {
                    notification.close();
                } catch {
                    // Already gone.
                }
                options.onDismissToast?.(key);
            }
        }
    };
}

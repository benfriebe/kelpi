import type { WsNotificationMessage } from '@kelpi/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    createNotificationManager,
    dedupeKeyForPane,
    type NotificationApi,
    type NotificationInit,
    type NotificationLike,
    type NotificationPermissionState
} from './notifications';
import type { Toast } from './store';

const PANE = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const WORKSPACE = 'aaaaaaaa-0000-4000-8000-000000000001';

interface Posted {
    readonly title: string;
    readonly init: NotificationInit;
    readonly notification: NotificationLike & { closed: boolean };
}

function fakeApi(permission: NotificationPermissionState = 'granted'): NotificationApi & { posted: Posted[] } {
    const posted: Posted[] = [];
    let current = permission;
    return {
        posted,
        get permission(): NotificationPermissionState {
            return current;
        },
        async requestPermission(): Promise<NotificationPermissionState> {
            current = 'granted';
            return current;
        },
        create(title, init): NotificationLike {
            const notification = {
                onclick: null as ((event: unknown) => void) | null,
                closed: false,
                close(): void {
                    this.closed = true;
                }
            };
            posted.push({ title, init, notification });
            return notification;
        }
    };
}

function message(overrides: Partial<WsNotificationMessage> = {}): WsNotificationMessage {
    return {
        type: 'notification',
        kind: 'agent-waiting',
        paneID: PANE,
        workspaceID: WORKSPACE,
        title: 'alpha',
        body: 'Agent is waiting for input',
        dedupeKey: dedupeKeyForPane(PANE),
        ...overrides
    };
}

describe('notification manager', () => {
    it('posts a system notification tagged kelpi-<paneID>', () => {
        const api = fakeApi();
        const manager = createNotificationManager({ api });

        expect(manager.handle(message())).toBe('system');
        expect(api.posted[0]?.title).toBe('alpha');
        expect(api.posted[0]?.init.tag).toBe(`kelpi-${PANE}`);
        expect(api.posted[0]?.init.body).toBe('Agent is waiting for input');
    });

    it('replaces rather than stacks a repeat notification for the same pane', () => {
        const api = fakeApi();
        const toasts: Toast[] = [];
        const manager = createNotificationManager({ api, onToast: (toast) => toasts.push(toast) });

        manager.handle(message({ title: 'first' }));
        manager.handle(message({ title: 'second' }));
        manager.handle(message({ paneID: OTHER, dedupeKey: dedupeKeyForPane(OTHER) }));

        // Two posts share the tag (the browser replaces the banner); our bookkeeping keeps one
        // live entry per pane, so `clear` can only ever close the newest.
        expect(api.posted.map((entry) => entry.init.tag)).toEqual([
            `kelpi-${PANE}`,
            `kelpi-${PANE}`,
            `kelpi-${OTHER}`
        ]);
        expect(manager.activeTags).toEqual([`kelpi-${PANE}`, `kelpi-${OTHER}`]);
        expect(toasts).toEqual([]);
    });

    it('falls back to an in-app toast when permission is not granted', () => {
        const toasts: Toast[] = [];
        const manager = createNotificationManager({
            api: fakeApi('denied'),
            onToast: (toast) => toasts.push(toast),
            now: () => 1234
        });

        expect(manager.handle(message())).toBe('toast');
        expect(toasts).toEqual([
            {
                id: `kelpi-${PANE}`,
                kind: 'agent-waiting',
                title: 'alpha',
                body: 'Agent is waiting for input',
                paneID: PANE,
                workspaceID: WORKSPACE,
                createdAt: 1234
            }
        ]);
    });

    it('falls back to a toast where the API does not exist at all', () => {
        const toasts: Toast[] = [];
        const manager = createNotificationManager({ api: undefined, onToast: (toast) => toasts.push(toast) });
        expect(manager.handle(message())).toBe('toast');
        expect(toasts).toHaveLength(1);
    });

    it('clicking opens the pane and drops the notification', () => {
        const api = fakeApi();
        const opened: { paneID: string; workspaceID: string }[] = [];
        const manager = createNotificationManager({ api, onOpen: (target) => opened.push(target) });

        manager.handle(message());
        api.posted[0]?.notification.onclick?.({});

        expect(opened).toEqual([{ paneID: PANE, workspaceID: WORKSPACE }]);
        expect(manager.activeTags).toEqual([]);
    });

    it('clear(paneID) removes the delivered notification and its toast (focus acknowledgment)', () => {
        const api = fakeApi();
        const dismissed: string[] = [];
        const manager = createNotificationManager({ api, onDismissToast: (id) => dismissed.push(id) });

        manager.handle(message());
        manager.clear(PANE);

        expect(api.posted[0]?.notification.closed).toBe(true);
        expect(manager.activeTags).toEqual([]);
        expect(dismissed).toEqual([`kelpi-${PANE}`]);
    });

    it('requests permission only when asked, and only while it is still default', async () => {
        const api = fakeApi('default');
        const spy = vi.spyOn(api, 'requestPermission');
        const manager = createNotificationManager({ api });

        // Nothing was requested just by handling a message.
        expect(manager.handle(message())).toBe('toast');
        expect(spy).not.toHaveBeenCalled();

        expect(await manager.request()).toBe('granted');
        expect(manager.handle(message())).toBe('system');
    });
});

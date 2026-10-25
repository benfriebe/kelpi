/**
 * agent-lifecycle.md §7.5 permission: browsers grant notification permission only from a user
 * gesture, so the assembly asks on the FIRST `pointerdown` in the window and never again; until
 * the grant, everything renders as an in-app toast. The module headers of `state/notifications.ts`
 * and the shell's `notify.ts` point at this listener, so it is pinned here (issue #58).
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import type { FormFactorWindow } from './chrome/form-factor';
import { createFakeSocketFactory } from './connection';
import { createFakePhoneWindow } from './phone/testing';
import { createKelpiRuntime, createKelpiStore, createNotificationManager, type NotificationApi } from './state';
import { createFakeRendererFactory } from './terminal/testing';

function countingRuntime(): { runtime: ReturnType<typeof createKelpiRuntime>; requests: () => number } {
    let requests = 0;
    const api: NotificationApi = {
        permission: 'default',
        requestPermission: () => {
            requests += 1;
            return Promise.resolve('granted');
        },
        create: () => ({ onclick: null, close: () => undefined })
    };
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: createFakeSocketFactory().factory,
        store: createKelpiStore(),
        notifications: createNotificationManager({ api }),
        tokenStorage: null,
        heartbeatIntervalMs: 0
    });
    return { runtime, requests: () => requests };
}

describe('notification permission (agent-lifecycle.md §7.5)', () => {
    afterEach(cleanup);

    it('never asks on a phone: the Notifications sheet does (§7.8)', async () => {
        const { runtime, requests } = countingRuntime();
        render(<App runtime={runtime} autoConnect={false} createRenderer={createFakeRendererFactory().factory} formFactorWindow={createFakePhoneWindow()} />);
        await act(async () => {
            window.dispatchEvent(new Event('pointerdown'));
        });
        expect(requests()).toBe(0);
    });

    it('keeps listening on a phone, so a window that stops being phone-shaped is still asked once', async () => {
        const { runtime, requests } = countingRuntime();
        const shape = { width: 390, coarse: true };
        const win: FormFactorWindow = {
            get innerWidth() {
                return shape.width;
            },
            innerHeight: 844,
            matchMedia: () => ({
                get matches() {
                    return shape.coarse;
                },
                addEventListener: () => undefined,
                removeEventListener: () => undefined
            })
        };
        render(<App runtime={runtime} autoConnect={false} createRenderer={createFakeRendererFactory().factory} formFactorWindow={win} />);
        await act(async () => {
            window.dispatchEvent(new Event('pointerdown'));
        });
        expect(requests()).toBe(0);
        // A tablet window un-snapped, a keyboard and trackpad attached.
        shape.width = 1400;
        shape.coarse = false;
        await act(async () => {
            window.dispatchEvent(new Event('pointerdown'));
            window.dispatchEvent(new Event('pointerdown'));
        });
        expect(requests()).toBe(1);
    });

    it('asks on the first pointerdown in the window, and only once', async () => {
        let requests = 0;
        const api: NotificationApi = {
            permission: 'default',
            requestPermission: () => {
                requests += 1;
                return Promise.resolve('granted');
            },
            create: () => ({ onclick: null, close: () => undefined })
        };
        const runtime = createKelpiRuntime({
            url: 'ws://daemon.test/ws',
            token: 'tok',
            socketFactory: createFakeSocketFactory().factory,
            store: createKelpiStore(),
            notifications: createNotificationManager({ api }),
            tokenStorage: null,
            heartbeatIntervalMs: 0
        });
        render(<App runtime={runtime} autoConnect={false} createRenderer={createFakeRendererFactory().factory} />);

        // Mounting is not a gesture: nothing is requested on import or render.
        expect(requests).toBe(0);

        await act(async () => {
            window.dispatchEvent(new Event('pointerdown'));
        });
        expect(requests).toBe(1);

        // One-shot: the listener removes itself before asking, so a second gesture is silent.
        await act(async () => {
            window.dispatchEvent(new Event('pointerdown'));
        });
        expect(requests).toBe(1);
    });
});

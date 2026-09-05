/**
 * agent-lifecycle.md §7.5 permission: browsers grant notification permission only from a user
 * gesture, so the assembly asks on the FIRST `pointerdown` in the window and never again; until
 * the grant, everything renders as an in-app toast. The module headers of `state/notifications.ts`
 * and the shell's `notify.ts` point at this listener, so it is pinned here (issue #58).
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { createFakeSocketFactory } from './connection';
import { createKelpiRuntime, createKelpiStore, createNotificationManager, type NotificationApi } from './state';
import { createFakeRendererFactory } from './terminal/testing';

describe('notification permission (agent-lifecycle.md §7.5)', () => {
    afterEach(cleanup);

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

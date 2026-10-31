import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandReply, ConnectionStatus } from '../connection';
import type { PushDevice, PushDeviceState, PushRegistrationInfo } from '../pwa/push';
import type { KelpiRuntime } from '../state';
import type { PhoneHostKind, PhoneHostModel } from './model';
import { PUSH_PRESENCE_REPEAT_MS, pushRefusal, sendPushTests, turnPushOff, unregisterPushHost, useHostsDocumentVisibility, usePushHosts, type DocumentLike } from './push-hosts';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const REGISTRATION: PushRegistrationInfo = { endpoint: 'https://push.example/1', p256dh: 'BKey', auth: 'secret', vapidPublicKey: 'BVapid', vapidPrivateKey: 'dVapid' };

interface FakeHost extends PhoneHostModel {
    readonly calls: string[];
    setStatus(status: ConnectionStatus): void;
    reply: CommandReply | Error;
    /** What `push-unsubscribe` answers; null never answers. */
    unsubscribeReply: CommandReply | null;
}

function fakeHost(key: string, kind: PhoneHostKind = 'phone', status: ConnectionStatus = 'connected'): FakeHost {
    const calls: string[] = [];
    const listeners = new Set<(status: ConnectionStatus) => void>();
    let current = status;
    const host = {
        key,
        name: key,
        kind,
        removable: kind === 'phone',
        calls,
        reply: { ok: true } as CommandReply | Error,
        unsubscribeReply: { ok: true } as CommandReply | null,
        setStatus(next: ConnectionStatus) {
            current = next;
            for (const listener of [...listeners]) listener(next);
        },
        runtime: {
            connection: {
                get status() {
                    return current;
                },
                on: (_event: 'status', listener: (status: ConnectionStatus) => void) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                }
            },
            commands: {
                pushSubscribe: (registration: PushRegistrationInfo, hostKey: string, visible: boolean) => {
                    calls.push(`subscribe ${registration.endpoint} ${hostKey} ${String(visible)}`);
                    return host.reply instanceof Error ? Promise.reject(host.reply) : Promise.resolve(host.reply);
                },
                pushUnsubscribe: (endpoint: string) => {
                    calls.push(`unsubscribe ${endpoint}`);
                    return host.unsubscribeReply === null ? new Promise<CommandReply>(() => undefined) : Promise.resolve(host.unsubscribeReply);
                },
                reportPushPresence: (visible: boolean) => calls.push(`presence ${String(visible)}`),
                pushTest: () => {
                    calls.push('test');
                    return Promise.resolve(host.reply instanceof Error ? { ok: false } : host.reply);
                }
            },
            setDocumentVisible: (visible: boolean) => calls.push(`document ${String(visible)}`)
        } as unknown as KelpiRuntime
    };
    return host;
}

function fakeDevice(registration: PushRegistrationInfo | null, wanted = registration !== null): PushDevice & { set(next: PushRegistrationInfo | null): void; disabled: number; renewed: number } {
    const listeners = new Set<() => void>();
    let state: PushDeviceState = { availability: 'available', permission: 'granted', wanted, registration, busy: false, error: null };
    const device = {
        disabled: 0,
        renewed: 0,
        getState: () => state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set(next: PushRegistrationInfo | null) {
            state = { ...state, registration: next, wanted: next !== null };
            for (const listener of [...listeners]) listener();
        },
        refresh: () => Promise.resolve(),
        enable: () => Promise.resolve(),
        disable: () => {
            device.disabled += 1;
            return Promise.resolve();
        },
        renew: () => {
            device.renewed += 1;
            return Promise.resolve();
        },
        closeNotifications: () => Promise.resolve()
    };
    return device;
}

function fakeDocument(): DocumentLike & { visibilityState: string; flip(state: 'visible' | 'hidden'): void } {
    const listeners = new Set<() => void>();
    const doc = {
        visibilityState: 'visible',
        addEventListener: (_type: 'visibilitychange', listener: () => void) => void listeners.add(listener),
        removeEventListener: (_type: 'visibilitychange', listener: () => void) => void listeners.delete(listener),
        flip(next: 'visible' | 'hidden') {
            doc.visibilityState = next;
            for (const listener of [...listeners]) listener();
        }
    };
    return doc;
}

const flush = (): Promise<void> => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('usePushHosts', () => {
    it('registers with every connected host under its own key, and waits for the rest', async () => {
        const origin = fakeHost('origin', 'origin');
        const away = fakeHost('phone:2', 'phone', 'reconnecting');
        const hosts = [origin, away];
        const device = fakeDevice(REGISTRATION);
        const doc = fakeDocument();
        const { result } = renderHook(() => usePushHosts(hosts, device, doc));
        await flush();
        expect(origin.calls).toEqual(['subscribe https://push.example/1 origin true']);
        expect(result.current.get('origin')).toEqual({ state: 'on' });
        expect(result.current.get('phone:2')).toEqual({ state: 'waiting' });

        await act(async () => {
            away.setStatus('connected');
        });
        await flush();
        expect(away.calls).toEqual(['subscribe https://push.example/1 phone:2 true']);
        expect(result.current.get('phone:2')).toEqual({ state: 'on' });
    });

    it('registers again on every reconnect, with the page’s visibility', async () => {
        const hosts = [fakeHost('origin', 'origin')];
        const host = hosts[0] as FakeHost;
        const device = fakeDevice(REGISTRATION);
        const doc = fakeDocument();
        renderHook(() => usePushHosts(hosts, device, doc));
        await flush();
        act(() => doc.flip('hidden'));
        await act(async () => {
            host.setStatus('reconnecting');
            host.setStatus('connected');
        });
        await flush();
        expect(host.calls).toEqual(['subscribe https://push.example/1 origin true', 'presence false', 'subscribe https://push.example/1 origin false']);
    });

    it('reports presence to every host as the page comes and goes', async () => {
        const one = fakeHost('origin', 'origin');
        const two = fakeHost('phone:2');
        const hosts = [one, two];
        const device = fakeDevice(REGISTRATION);
        const doc = fakeDocument();
        renderHook(() => usePushHosts(hosts, device, doc));
        await flush();
        act(() => doc.flip('hidden'));
        act(() => doc.flip('visible'));
        expect(one.calls.filter((call) => call.startsWith('presence'))).toEqual(['presence false', 'presence true']);
        expect(two.calls.filter((call) => call.startsWith('presence'))).toEqual(['presence false', 'presence true']);
    });

    it('says when a host is too old, and when push is off', async () => {
        const host = fakeHost('origin', 'origin');
        host.reply = { ok: false, error: "unknown command 'push-subscribe'" };
        const hosts = [host];
        const device = fakeDevice(REGISTRATION);
        const doc = fakeDocument();
        const { result } = renderHook(() => usePushHosts(hosts, device, doc));
        await flush();
        expect(result.current.get('origin')).toEqual({ state: 'error', message: "This host's Kelpi is too old for phone notifications. Update it to get them." });

        act(() => device.set(null));
        expect(result.current.get('origin')).toEqual({ state: 'off' });
    });

    it('repeats presence while the page is visible, so a busy phone is never taken for gone', async () => {
        vi.useFakeTimers();
        const host = fakeHost('origin', 'origin');
        const hosts = [host];
        const device = fakeDevice(REGISTRATION);
        const doc = fakeDocument();
        renderHook(() => usePushHosts(hosts, device, doc));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(PUSH_PRESENCE_REPEAT_MS * 2);
        });
        expect(host.calls.filter((call) => call === 'presence true')).toHaveLength(2);
        act(() => doc.flip('hidden'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(PUSH_PRESENCE_REPEAT_MS * 3);
        });
        // Hidden: one report as it goes, then quiet.
        expect(host.calls.filter((call) => call.startsWith('presence'))).toEqual(['presence true', 'presence true', 'presence false']);
    });

    it('registers nothing the person did not ask for (a refresh that lost a race with Turn off)', async () => {
        const host = fakeHost('origin', 'origin');
        const hosts = [host];
        const device = fakeDevice(REGISTRATION, false);
        const doc = fakeDocument();
        const { result } = renderHook(() => usePushHosts(hosts, device, doc));
        await flush();
        expect(host.calls).toEqual([]);
        expect(result.current.get('origin')).toEqual({ state: 'off' });
    });

    it('does not re-register for an equal registration handed back by a refresh', async () => {
        const host = fakeHost('origin', 'origin');
        const hosts = [host];
        const device = fakeDevice(REGISTRATION);
        const doc = fakeDocument();
        renderHook(() => usePushHosts(hosts, device, doc));
        await flush();
        act(() => device.set({ ...REGISTRATION }));
        await flush();
        expect(host.calls).toEqual(['subscribe https://push.example/1 origin true']);
    });
});

describe('useHostsDocumentVisibility', () => {
    it('tells the remote runtimes when the page is hidden, and leaves the origin to assembly', () => {
        const origin = fakeHost('origin', 'origin');
        const remote = fakeHost('phone:2');
        const hosts = [origin, remote];
        const doc = fakeDocument();
        renderHook(() => useHostsDocumentVisibility(hosts, doc));
        act(() => doc.flip('hidden'));
        expect(origin.calls).toEqual([]);
        expect(remote.calls).toEqual(['document true', 'document false']);
    });
});

describe('turnPushOff and sendPushTests', () => {
    it('turns off here at once, then takes the phone off every connected host', async () => {
        const one = fakeHost('origin', 'origin');
        const slow = fakeHost('phone:3');
        slow.unsubscribeReply = null;
        const gone = fakeHost('phone:2', 'phone', 'reconnecting');
        const device = fakeDevice(REGISTRATION);
        void turnPushOff([one, slow, gone], device);
        // Off before any host has answered (one never will): a phone put away now stays off.
        expect(device.disabled).toBe(1);
        await flush();
        expect(one.calls).toEqual(['unsubscribe https://push.example/1']);
        expect(slow.calls).toEqual(['unsubscribe https://push.example/1']);
        expect(gone.calls).toEqual([]);
    });

    it('a host the phone forgets is taken off; one that cannot be leaves the phone on a fresh endpoint', async () => {
        const live = fakeHost('phone:2');
        const device = fakeDevice(REGISTRATION);
        await unregisterPushHost(live, device);
        expect(live.calls).toEqual(['unsubscribe https://push.example/1']);
        expect(device.renewed).toBe(0);

        const away = fakeHost('phone:3', 'phone', 'reconnecting');
        await unregisterPushHost(away, device);
        expect(away.calls).toEqual([]);
        expect(device.renewed).toBe(1);

        const old = fakeHost('phone:4');
        old.unsubscribeReply = { ok: false, error: 'unknown command push-unsubscribe' };
        await unregisterPushHost(old, device);
        expect(device.renewed).toBe(2);

        const off = fakeDevice(null);
        await unregisterPushHost(fakeHost('phone:5'), off);
        expect(off.renewed).toBe(0);
    });

    it('tests only the hosts push is on for, and words a refusal', async () => {
        const on = fakeHost('origin', 'origin');
        const refused = fakeHost('phone:2');
        refused.reply = { ok: false, error: 'the push service refused it (HTTP 403)' };
        const off = fakeHost('phone:3');
        const outcomes = await sendPushTests(
            [on, refused, off],
            new Map([
                ['origin', { state: 'on' }],
                ['phone:2', { state: 'on' }],
                ['phone:3', { state: 'waiting' }]
            ])
        );
        expect(outcomes).toEqual([
            { hostKey: 'origin', ok: true, message: 'Sent' },
            { hostKey: 'phone:2', ok: false, message: 'the push service refused it (HTTP 403)' }
        ]);
        expect(off.calls).toEqual([]);
    });

    it('pushRefusal keeps the daemon’s own words otherwise', () => {
        expect(pushRefusal({ ok: false, error: 'push endpoint must be https' })).toBe('push endpoint must be https');
        expect(pushRefusal({ ok: false })).toBe('the host refused');
    });
});

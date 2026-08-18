import { describe, expect, it, vi } from 'vitest';

import {
    createHostRegistry,
    HOST_GONE_ERROR,
    NO_HOST_ERROR,
    timeoutError,
    type HostTransport
} from './host.js';

interface Recorder extends HostTransport {
    readonly sent: Record<string, unknown>[];
    ofType(type: string): Record<string, unknown>[];
}

function recorder(): Recorder {
    const sent: Record<string, unknown>[] = [];
    return {
        sent,
        sendJson(message) {
            sent.push(message as Record<string, unknown>);
        },
        ofType(type) {
            return sent.filter((message) => message['type'] === type);
        }
    };
}

function ids(): () => string {
    let counter = 0;
    return () => {
        counter += 1;
        return `id-${String(counter)}`;
    };
}

describe('host registry', () => {
    it('answers every call with the no-host failure until a host registers', async () => {
        const registry = createHostRegistry({ newID: ids() });
        expect(registry.hasHost).toBe(false);
        await expect(registry.call('navigate', {})).resolves.toEqual({
            ok: false,
            error: NO_HOST_ERROR
        });
        // A notify with no host is a silent no-op, not an error.
        expect(() => registry.notify('tab-open', {})).not.toThrow();
    });

    it('forwards a call and settles it with the host reply', async () => {
        const registry = createHostRegistry({ newID: ids() });
        const host = recorder();
        const registration = registry.register(host, { name: 'shell' });

        expect(registration.superseded).toBe(false);
        expect(host.ofType('host-registered')[0]).toEqual({
            type: 'host-registered',
            role: 'web-pane',
            hostID: 'id-1',
            superseded: false
        });

        const pending = registry.call('actuate', { paneID: 'P', method: 'click' });
        const rpc = host.ofType('host-rpc')[0] as Record<string, unknown>;
        expect(rpc['verb']).toBe('actuate');
        expect(rpc['args']).toEqual({ paneID: 'P', method: 'click' });
        expect(registry.pending).toBe(1);

        registry.settle(String(rpc['id']), { ok: true, matched: true });
        await expect(pending).resolves.toEqual({ ok: true, matched: true });
        expect(registry.pending).toBe(0);
    });

    it('times a wedged host out and discards its late reply', async () => {
        vi.useFakeTimers();
        try {
            const registry = createHostRegistry({ newID: ids() });
            const host = recorder();
            registry.register(host);
            const pending = registry.call('capture', {}, { timeoutMs: 50 });
            vi.advanceTimersByTime(51);
            await expect(pending).resolves.toEqual({
                ok: false,
                error: timeoutError('capture', 50)
            });
            // The host eventually answers; nobody is listening and nothing throws.
            const rpc = host.ofType('host-rpc')[0] as Record<string, unknown>;
            expect(() => registry.settle(String(rpc['id']), { ok: true })).not.toThrow();
        } finally {
            vi.useRealTimers();
        }
    });

    it('hands the role to the newest registration and tells the old host', async () => {
        const registry = createHostRegistry({ newID: ids() });
        const first = recorder();
        const second = recorder();
        registry.register(first);
        const stranded = registry.call('exec', {});

        const takeover = registry.register(second, { name: 'newer' });
        expect(takeover.superseded).toBe(true);
        expect(registry.hostID).toBe(takeover.hostID);
        expect(first.ofType('host-revoked')[0]).toMatchObject({
            reason: 'superseded',
            role: 'web-pane'
        });
        // In-flight work fails immediately instead of hanging until its timeout.
        await expect(stranded).resolves.toEqual({ ok: false, error: HOST_GONE_ERROR });

        // New traffic goes to the new host only.
        void registry.call('url', {});
        expect(second.ofType('host-rpc')).toHaveLength(1);
        expect(first.ofType('host-rpc')).toHaveLength(1);
    });

    it('a superseded registration cannot release its successor', () => {
        const registry = createHostRegistry({ newID: ids() });
        const first = recorder();
        const second = recorder();
        const stale = registry.register(first);
        const live = registry.register(second);
        stale.release();
        expect(registry.hasHost).toBe(true);
        expect(registry.hostID).toBe(live.hostID);
        void registry.call('url', {});
        expect(second.ofType('host-rpc')).toHaveLength(1);
    });

    it('releasing the live host strands nothing and restores the no-host answer', async () => {
        const registry = createHostRegistry({ newID: ids() });
        const host = recorder();
        const registration = registry.register(host);
        const pending = registry.call('navigate', {});
        registration.release();
        await expect(pending).resolves.toEqual({ ok: false, error: HOST_GONE_ERROR });
        expect(registry.hasHost).toBe(false);
        // `unregistered` is the host's own choice, so it is not told about it.
        expect(host.ofType('host-revoked')).toHaveLength(0);
        await expect(registry.call('navigate', {})).resolves.toEqual({
            ok: false,
            error: NO_HOST_ERROR
        });
    });

    it('close() revokes with the shutdown reason', () => {
        const registry = createHostRegistry({ newID: ids() });
        const host = recorder();
        registry.register(host);
        registry.close();
        expect(host.ofType('host-revoked')[0]).toMatchObject({ reason: 'shutdown' });
        expect(registry.hasHost).toBe(false);
    });

    it('survives a transport that throws on write', async () => {
        const errors: string[] = [];
        const registry = createHostRegistry({
            newID: ids(),
            onError: (_error, context) => errors.push(context)
        });
        registry.register({
            sendJson() {
                throw new Error('socket closed');
            }
        });
        await expect(registry.call('url', {})).resolves.toEqual({
            ok: false,
            error: HOST_GONE_ERROR
        });
        expect(errors).toContain('host-send');
    });
});

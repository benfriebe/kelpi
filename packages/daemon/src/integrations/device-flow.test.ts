/**
 * The device flow (docs/integrations.md §9.3) under fake timers: polling while pending, slowing
 * down to the interval GitHub returns, success, expiry (answered and by deadline), denial, a
 * disabled flow, transient retries, cancel by flow id, a replacing start, and dispose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TicketServiceError } from '../handlers/app/context.js';
import { createDeviceFlow, type DeviceFlowToken } from './device-flow.js';
import { createGitHubHttp } from './http.js';
import { fakeGitHub, json } from './testing.js';

const CODE = {
    device_code: 'DEVICE-CODE-SENTINEL',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5
};

interface Harness {
    readonly gh: ReturnType<typeof fakeGitHub>;
    readonly flow: ReturnType<typeof createDeviceFlow>;
    readonly tokens: DeviceFlowToken[];
    readonly changes: number[];
    readonly lines: string[];
    /** Queue the answers `/login/oauth/access_token` gives, in order. */
    answers: (Response | (() => Response | Promise<Response>))[];
    polls(): number;
}

function harness(options: { clientID?: string; code?: Record<string, unknown>; onToken?: (token: DeviceFlowToken) => Promise<void> } = {}): Harness {
    const gh = fakeGitHub();
    const tokens: DeviceFlowToken[] = [];
    const changes: number[] = [];
    const lines: string[] = [];
    let ids = 0;
    const h: Harness = {
        gh,
        tokens,
        changes,
        lines,
        answers: [],
        polls: () => gh.requests.filter((request) => request.path === '/login/oauth/access_token').length,
        flow: undefined as unknown as ReturnType<typeof createDeviceFlow>
    };
    gh.on('POST', '/login/device/code', () => json(options.code ?? CODE));
    gh.on('POST', '/login/oauth/access_token', () => {
        const next = h.answers.shift();
        if (next === undefined) return json({ error: 'authorization_pending' });
        return typeof next === 'function' ? next() : next;
    });
    const http = createGitHubHttp({
        endpoints: { api: 'https://api.github.com', web: 'https://github.com' },
        userAgent: 'Kelpi/test',
        fetch: gh.fetch,
        // Never fires: fake timers drive the flow, and `AbortSignal.timeout` would not follow them.
        timeoutSignal: () => new AbortController().signal
    });
    (h as { flow: ReturnType<typeof createDeviceFlow> }).flow = createDeviceFlow({
        http,
        clientID: options.clientID ?? 'Ov23abc',
        now: () => Date.now(),
        newFlowID: () => `flow-${++ids}`,
        log: (line) => lines.push(line),
        onChange: () => changes.push(Date.now()),
        onToken: async (token) => {
            tokens.push(token);
            await options.onToken?.(token);
        }
    });
    return h;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('device flow', () => {
    it('starts with the client id and the repo scope, and answers the code once', async () => {
        const h = harness();
        const started = await h.flow.start();
        expect(started).toEqual({ flowID: 'flow-1', userCode: 'ABCD-1234', verificationURI: 'https://github.com/login/device', expiresIn: 900, interval: 5 });
        expect(h.gh.requests[0]!.body).toBe('client_id=Ov23abc&scope=repo');
        expect(h.flow.linking()).toEqual({ state: 'pending', flowID: 'flow-1', expiresAt: 1_800_000_000_000 + 900_000 });
        expect(h.changes).toHaveLength(1);
    });

    it('polls every interval while authorization is pending, then hands over the token', async () => {
        const h = harness();
        await h.flow.start();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(h.polls()).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.polls()).toBe(1);
        const poll = h.gh.requests.find((request) => request.path === '/login/oauth/access_token')!;
        expect(poll.body).toBe('client_id=Ov23abc&device_code=DEVICE-CODE-SENTINEL&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
        h.answers.push(json({ access_token: 'gho_TOKEN', token_type: 'bearer', scope: 'repo' }));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.polls()).toBe(2);
        expect(h.tokens).toEqual([{ accessToken: 'gho_TOKEN', tokenType: 'bearer' }]);
        expect(h.flow.linking()).toBeUndefined();
        // No more polling after success.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.polls()).toBe(2);
        expect(h.lines.join('\n')).not.toMatch(/DEVICE-CODE|gho_|ABCD-1234/);
    });

    it('slows down to the interval GitHub returns with slow_down', async () => {
        const h = harness();
        await h.flow.start();
        h.answers.push(json({ error: 'slow_down', interval: 12 }));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.polls()).toBe(1);
        await vi.advanceTimersByTimeAsync(11_999);
        expect(h.polls()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.polls()).toBe(2);
    });

    it('adds five seconds for a slow_down without an interval', async () => {
        const h = harness();
        await h.flow.start();
        h.answers.push(json({ error: 'slow_down' }));
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(h.polls()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.polls()).toBe(2);
    });

    it.each([
        ['expired_token', 'expired'],
        ['access_denied', 'denied'],
        ['device_flow_disabled', 'disabled'],
        ['incorrect_client_credentials', 'error'],
        ['incorrect_device_code', 'error'],
        ['unsupported_grant_type', 'error'],
        ['something_new', 'error']
    ])('ends on %s as %s', async (code, reason) => {
        const h = harness();
        await h.flow.start();
        h.answers.push(json({ error: code }));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.flow.linking()).toMatchObject({ state: 'failed', flowID: 'flow-1', reason });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.polls()).toBe(1);
    });

    it("expires at the code's deadline without asking again", async () => {
        const h = harness({ code: { ...CODE, expires_in: 12 } });
        await h.flow.start();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.polls()).toBe(2);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(h.flow.linking()).toMatchObject({ state: 'failed', reason: 'expired' });
        expect(h.polls()).toBe(2);
    });

    it('retries a transport failure three times, backing off, then fails', async () => {
        const h = harness();
        await h.flow.start();
        for (let attempt = 0; attempt < 4; attempt += 1) h.answers.push(() => Promise.reject(new TypeError('fetch failed')));
        await vi.advanceTimersByTimeAsync(5_000); // first failure
        expect(h.polls()).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000); // 5 * 2
        expect(h.polls()).toBe(2);
        await vi.advanceTimersByTimeAsync(20_000); // 5 * 4
        expect(h.polls()).toBe(3);
        expect(h.flow.linking()).toMatchObject({ state: 'pending' });
        await vi.advanceTimersByTimeAsync(40_000); // 5 * 8, the fourth failure ends it
        expect(h.polls()).toBe(4);
        expect(h.flow.linking()).toMatchObject({ state: 'failed', reason: 'error' });
    });

    it('a failed save of the token fails the flow with its message', async () => {
        const h = harness({ onToken: () => Promise.reject(new TicketServiceError('missing-scope', 'GitHub did not grant the "repo" scope')) });
        await h.flow.start();
        h.answers.push(json({ access_token: 'gho_X' }));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.flow.linking()).toEqual({ state: 'failed', flowID: 'flow-1', reason: 'error', message: 'GitHub did not grant the "repo" scope' });
    });

    it('cancels only the flow it names, and stops polling', async () => {
        const h = harness();
        await h.flow.start();
        expect(h.flow.cancel('flow-other')).toBe(false);
        expect(h.flow.linking()).toMatchObject({ state: 'pending', flowID: 'flow-1' });
        expect(h.flow.cancel('flow-1')).toBe(true);
        expect(h.flow.linking()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.polls()).toBe(0);
    });

    it('a second start replaces the first: the old id no longer cancels anything', async () => {
        const h = harness();
        await h.flow.start();
        const second = await h.flow.start();
        expect(second.flowID).toBe('flow-2');
        expect(h.flow.linking()).toMatchObject({ state: 'pending', flowID: 'flow-2' });
        expect(h.flow.cancel('flow-1')).toBe(false);
        await vi.advanceTimersByTimeAsync(5_000);
        // One poll, for the second flow only.
        expect(h.polls()).toBe(1);
    });

    it('refuses to start without a client id, and when GitHub has the device flow disabled', async () => {
        await expect(harness({ clientID: '' }).flow.start()).rejects.toMatchObject({ code: 'unavailable' });
        await expect(harness({ code: { error: 'device_flow_disabled' } }).flow.start()).rejects.toMatchObject({ code: 'unavailable' });
        await expect(harness({ code: { ...CODE, verification_uri: 'https://evil.example/device' } }).flow.start()).rejects.toMatchObject({ code: 'github-error' });
    });

    it('dispose aborts the request in flight, drops the flow and refuses a new start', async () => {
        const h = harness();
        await h.flow.start();
        let seen: AbortSignal | null = null;
        h.answers.push(() => new Promise<Response>(() => {}));
        await vi.advanceTimersByTimeAsync(5_000);
        seen = h.gh.requests.at(-1)!.signal;
        expect(seen?.aborted).toBe(false);
        h.flow.dispose();
        expect(seen?.aborted).toBe(true);
        expect(h.flow.linking()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.polls()).toBe(1);
        await expect(h.flow.start()).rejects.toMatchObject({ code: 'unavailable' });
    });
});

/**
 * The integrations family over the sync hub (docs/integrations.md §1, §2.1, §9.7): `welcome`
 * carries the status and whether the session may manage it, changes arrive as
 * `integrations-changed`, the management verbs refuse paired devices AND plugin-originated
 * commands with `forbidden` while search and resolve stay open, the family never reaches a plugin
 * operation hook (not even a `'*'` one), a dropped session aborts its requests, and, driven
 * through the REAL service against a fake GitHub, neither a token nor a device code ever appears
 * in a reply, a frame, a welcome or a log line.
 */

import { WS_PROTOCOL_VERSION, type JsonObject, type WsIntegrationStatus } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRepoFacts } from '../git/repo-facts.js';
import { createIntegrationsService } from '../integrations/service.js';
import { createCredentialStore } from '../integrations/store.js';
import { fakeGitHub, json, userResponse } from '../integrations/testing.js';
import type { PluginChannel } from '../plugins/service.js';
import { harness as storeHarness, seededState } from '../store/testing.js';
import type { IntegrationsChannel } from './integrations.js';
import { createSyncHub, type SyncHub } from './sync.js';
import { recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };
const STATUS: WsIntegrationStatus[] = [{ provider: 'github', available: true, connected: true, login: 'me', how: 'oauth', scopes: ['repo'] }];

function hello(token: string): string {
    return JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token, client: { kind: 'browser', name: 'kelpi-web' } });
}

function command(id: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type: 'command', id, payload });
}

const replyFor = (transport: RecordedTransport, id: string): Record<string, unknown> | undefined =>
    (transport.json.find((message) => message['type'] === 'command-reply' && message['id'] === id)?.['reply'] as Record<string, unknown> | undefined) ?? undefined;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface StubChannel extends IntegrationsChannel {
    readonly calls: string[];
    readonly signals: AbortSignal[];
    change(statuses: readonly WsIntegrationStatus[]): void;
}

function stubChannel(options: { hang?: boolean } = {}): StubChannel {
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const listeners = new Set<(statuses: readonly WsIntegrationStatus[]) => void>();
    const answer = <T>(value: T, signal: AbortSignal): Promise<T> => {
        signals.push(signal);
        return options.hang === true ? new Promise<T>(() => {}) : Promise.resolve(value);
    };
    return {
        calls,
        signals,
        change: (statuses) => listeners.forEach((listener) => listener(statuses)),
        statuses: () => STATUS,
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        linkStart(provider, signal) {
            calls.push(`link-start:${provider}`);
            return answer({ ok: true, flow_id: 'f', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }, signal);
        },
        linkCancel(provider, flowID) {
            calls.push(`link-cancel:${provider}:${flowID ?? '-'}`);
            return { ok: true, cancelled: true };
        },
        linkToken(provider, token, signal) {
            calls.push(`link-token:${provider}:${token}`);
            return answer({ ok: true, integrations: STATUS }, signal);
        },
        unlink(provider) {
            calls.push(`unlink:${provider}`);
            return { ok: true, integrations: STATUS };
        },
        ticketSearch(provider, query, signal) {
            calls.push(`search:${provider}:${query}`);
            return answer({ ok: true, sections: [] }, signal);
        },
        ticketResolve(ref, signal) {
            calls.push(`resolve:${ref}`);
            return answer({ ok: false, error: 'nope', code: 'not-found' }, signal);
        }
    };
}

function hub(channel: IntegrationsChannel | undefined, plugins?: PluginChannel): SyncHub {
    return createSyncHub({
        store: storeHarness(seededState()).store,
        dispatcher: () => {},
        daemon: DAEMON,
        helloTimeoutMs: 0,
        // Owner token 'tok'; any `kd_…` is a paired device.
        validateToken: (token) => token === 'tok' || token.startsWith('kd_'),
        ...(channel === undefined ? {} : { integrations: channel }),
        ...(plugins === undefined ? {} : { plugins })
    });
}

function connect(target: SyncHub, token: string): RecordedTransport {
    const transport = recordingTransport();
    const session = target.createSession(transport);
    session.handleMessage(hello(token));
    (transport as RecordedTransport & { session: typeof session }).session = session;
    return transport;
}

function send(transport: RecordedTransport, id: string, payload: Record<string, unknown>): void {
    (transport as RecordedTransport & { session: { handleMessage(raw: string): void } }).session.handleMessage(command(id, payload));
}

const MANAGEMENT = [
    { command: 'integration-link-start', provider: 'github' },
    { command: 'integration-link-cancel', provider: 'github', flow_id: 'f' },
    { command: 'integration-link-token', provider: 'github', token: 'ghp_PASTED' },
    { command: 'integration-unlink', provider: 'github' }
];

describe('welcome and the change feed', () => {
    it('carries the status, and whether this session may manage it', () => {
        const target = hub(stubChannel());
        const owner = connect(target, 'tok');
        const device = connect(target, 'kd_phone');
        expect(owner.ofType('welcome')[0]).toMatchObject({ integrations: STATUS, integrationsManageable: true });
        expect(device.ofType('welcome')[0]).toMatchObject({ integrations: STATUS, integrationsManageable: false });
        target.close();
    });

    it('omits both without a channel, and answers the verbs `unavailable`', async () => {
        const target = hub(undefined);
        const owner = connect(target, 'tok');
        expect(owner.ofType('welcome')[0]).not.toHaveProperty('integrations');
        expect(owner.ofType('welcome')[0]).not.toHaveProperty('integrationsManageable');
        send(owner, 'u1', { command: 'integrations-status' });
        await settle();
        expect(replyFor(owner, 'u1')).toEqual({ ok: false, error: 'integrations are not available', code: 'unavailable' });
        target.close();
    });

    it('sends integrations-changed to every ready session, and stops after close', () => {
        const channel = stubChannel();
        const target = hub(channel);
        const owner = connect(target, 'tok');
        const device = connect(target, 'kd_phone');
        const next: WsIntegrationStatus[] = [{ provider: 'github', available: true, connected: false }];
        channel.change(next);
        expect(owner.ofType('integrations-changed')).toEqual([{ type: 'integrations-changed', integrations: next }]);
        expect(device.ofType('integrations-changed')).toHaveLength(1);
        target.close();
        channel.change(next);
        expect(owner.ofType('integrations-changed')).toHaveLength(1);
    });
});

describe('who may call what', () => {
    it('routes every verb for the owner session', async () => {
        const channel = stubChannel();
        const target = hub(channel);
        const owner = connect(target, 'tok');
        MANAGEMENT.forEach((payload, index) => send(owner, `m${index}`, payload));
        send(owner, 's', { command: 'ticket-search', provider: 'github', query: ' retry ' });
        send(owner, 'r', { command: 'ticket-resolve', ref: 'acme/api#1' });
        send(owner, 'st', { command: 'integrations-status' });
        await settle();
        expect(channel.calls).toEqual(['link-start:github', 'link-cancel:github:f', 'link-token:github:ghp_PASTED', 'unlink:github', 'search:github:retry', 'resolve:acme/api#1']);
        expect(replyFor(owner, 'm0')).toMatchObject({ ok: true, user_code: 'ABCD-1234' });
        expect(replyFor(owner, 'st')).toEqual({ ok: true, integrations: STATUS, manageable: true });
        expect(replyFor(owner, 'r')).toEqual({ ok: false, error: 'nope', code: 'not-found' });
        target.close();
    });

    it('refuses the management verbs to a paired device, and lets it search, resolve and read the status', async () => {
        const channel = stubChannel();
        const target = hub(channel);
        const device = connect(target, 'kd_phone');
        MANAGEMENT.forEach((payload, index) => send(device, `m${index}`, payload));
        send(device, 's', { command: 'ticket-search', provider: 'github', query: '' });
        send(device, 'r', { command: 'ticket-resolve', ref: 'acme/api#1' });
        send(device, 'st', { command: 'integrations-status' });
        await settle();
        expect(channel.calls).toEqual(['search:github:', 'resolve:acme/api#1']);
        MANAGEMENT.forEach((payload, index) => {
            expect(replyFor(device, `m${index}`)).toMatchObject({ ok: false, code: 'forbidden', error: expect.stringContaining(`${payload.command} is owner-only`) });
        });
        expect(replyFor(device, 'st')).toEqual({ ok: true, integrations: STATUS, manageable: false });
        target.close();
    });

    it('refuses the management verbs to a plugin view (executeCommand), and lets it search and resolve', async () => {
        const channel = stubChannel();
        const target = hub(channel);
        const context = { daemonID: 'D' };
        for (const payload of MANAGEMENT) {
            expect(await target.executeCommand(payload as JsonObject, context, new AbortController().signal)).toMatchObject({ ok: false, code: 'forbidden' });
        }
        expect(await target.executeCommand({ command: 'ticket-search', provider: 'github', query: 'x' }, context, new AbortController().signal)).toEqual({ ok: true, sections: [] });
        expect(await target.executeCommand({ command: 'ticket-resolve', ref: 'acme/api#2' }, context, new AbortController().signal)).toMatchObject({ code: 'not-found' });
        expect(await target.executeCommand({ command: 'integrations-status' }, context, new AbortController().signal)).toMatchObject({ manageable: false });
        expect(channel.calls).toEqual(['search:github:x', 'resolve:acme/api#2']);
        target.close();
    });

    it('answers a malformed request bad-request after the authorization check', async () => {
        const target = hub(stubChannel());
        const owner = connect(target, 'tok');
        const device = connect(target, 'kd_phone');
        send(owner, 'a', { command: 'integration-link-token', provider: 'gitlab', token: 'x' });
        send(device, 'b', { command: 'integration-link-token', provider: 'gitlab', token: 'x' });
        await settle();
        expect(replyFor(owner, 'a')).toMatchObject({ ok: false, code: 'bad-request' });
        expect(replyFor(device, 'b')).toMatchObject({ ok: false, code: 'forbidden' });
        target.close();
    });

    it("never lets a '*' operation hook see the family, from a window or from a plugin view", async () => {
        const intercepted: JsonObject[] = [];
        const plugins: PluginChannel = {
            run: () => {},
            hasOperationHooks: () => true,
            interceptOperation: async (payload, _context, _source, run) => {
                intercepted.push(payload);
                return run();
            }
        };
        const channel = stubChannel();
        const target = hub(channel, plugins);
        const owner = connect(target, 'tok');
        MANAGEMENT.forEach((payload, index) => send(owner, `m${index}`, payload));
        send(owner, 's', { command: 'ticket-search', provider: 'github', query: '' });
        await settle();
        await target.executeCommand({ command: 'integration-link-token', provider: 'github', token: 'ghp_FROM_VIEW' }, { daemonID: 'D' }, new AbortController().signal);
        expect(channel.calls).toContain('link-token:github:ghp_PASTED');
        expect(intercepted).toEqual([]);
        // The hook still sees an ordinary command, so the stub is wired.
        send(owner, 'w', { command: 'workspace-list' });
        await settle();
        expect(intercepted.map((payload) => payload['command'])).toEqual(['workspace-list']);
        target.close();
    });

    it('aborts what a session was waiting for when it goes away', async () => {
        const channel = stubChannel({ hang: true });
        const target = hub(channel);
        const owner = connect(target, 'tok');
        send(owner, 's', { command: 'ticket-search', provider: 'github', query: '' });
        send(owner, 'r', { command: 'ticket-resolve', ref: 'acme/api#1' });
        await settle();
        expect(channel.signals.map((signal) => signal.aborted)).toEqual([false, false]);
        (owner as RecordedTransport & { session: { close(): void } }).session.close();
        expect(channel.signals.map((signal) => signal.aborted)).toEqual([true, true]);
        target.close();
    });
});

describe('the token never travels', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps the access tokens and the device code out of every reply, frame, welcome and log line', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const SENTINELS = ['ghp_PAT_SENTINEL_1234', 'gho_OAUTH_SENTINEL_5678', 'DEVICE_CODE_SENTINEL_9'];
        const gh = fakeGitHub();
        gh.on('GET', '/user', () => userResponse('octocat', 'repo'));
        gh.on('POST', '/login/device/code', () =>
            json({ device_code: 'DEVICE_CODE_SENTINEL_9', user_code: 'WXYZ-9876', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
        );
        let polls = 0;
        gh.on('POST', '/login/oauth/access_token', () => {
            polls += 1;
            return polls === 1 ? json({ error: 'authorization_pending' }) : json({ access_token: 'gho_OAUTH_SENTINEL_5678', token_type: 'bearer', scope: 'repo' });
        });
        let searches = 0;
        gh.graphql((call) => {
            if (call.query.includes('KelpiTicketResolve')) {
                return json({ message: 'Bad credentials' }, { status: 401, headers: { 'x-github-request-id': 'R1' } });
            }
            searches += 1;
            return json({ data: { s0: { nodes: [] }, s1: { nodes: [] }, s2: { nodes: [] } } });
        });
        const lines: string[] = [];
        const errors: string[] = [];
        const store = storeHarness(seededState());
        const service = createIntegrationsService({
            store: store.store,
            version: '1',
            config: { path: null, clientID: 'Ov23abc', endpoints: { api: 'https://api.github.com', web: 'https://github.com' }, notes: [] },
            credentials: createCredentialStore({ path: null }),
            repoFacts: createRepoFacts(),
            fetch: gh.fetch,
            timeoutSignal: () => new AbortController().signal,
            log: (line) => lines.push(line),
            onError: (error, context) => errors.push(`${context}: ${error.message}`)
        });
        const target = createSyncHub({
            store: store.store,
            dispatcher: () => {},
            daemon: DAEMON,
            helloTimeoutMs: 0,
            validateToken: (token) => token === 'tok' || token.startsWith('kd_'),
            integrations: service
        });
        const owner = connect(target, 'tok');
        const other = connect(target, 'tok');
        const device = connect(target, 'kd_phone');
        const flush = async (): Promise<void> => {
            for (let index = 0; index < 5; index += 1) await vi.advanceTimersByTimeAsync(0);
        };

        send(owner, 'pat', { command: 'integration-link-token', provider: 'github', token: '  ghp_PAT_SENTINEL_1234\n' });
        await flush();
        expect(replyFor(owner, 'pat')).toMatchObject({ ok: true, integrations: [{ connected: true, how: 'token' }] });
        send(owner, 's1', { command: 'ticket-search', provider: 'github', query: '' });
        await flush();
        expect(replyFor(owner, 's1')).toMatchObject({ ok: true });

        send(owner, 'start', { command: 'integration-link-start', provider: 'github' });
        await flush();
        expect(replyFor(owner, 'start')).toMatchObject({ ok: true, user_code: 'WXYZ-9876' });
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();
        expect(service.statuses()[0]).toMatchObject({ connected: true, how: 'oauth' });

        // A 401 for the stored credential: revoked, broadcast, and an `unauthorized` reply.
        send(device, 'r', { command: 'ticket-resolve', ref: 'acme/api#1' });
        await flush();
        expect(replyFor(device, 'r')).toMatchObject({ ok: false, code: 'unauthorized' });
        send(owner, 'bye', { command: 'integration-unlink', provider: 'github' });
        await flush();
        expect(searches).toBe(1);

        // The sentinels really were in play: GitHub saw each of them.
        const sent = JSON.stringify(gh.requests.map((request) => [request.headers, request.body]));
        for (const sentinel of SENTINELS) expect(sent).toContain(sentinel);
        // The user code went to the session that asked, and nowhere else.
        expect(JSON.stringify(other.json)).not.toContain('WXYZ-9876');
        expect(JSON.stringify(device.json)).not.toContain('WXYZ-9876');
        const everything = JSON.stringify([owner.json, other.json, device.json, lines, errors, service.statuses()]);
        for (const sentinel of SENTINELS) expect(everything).not.toContain(sentinel);
        // …and the frames did carry the story.
        expect(owner.ofType('integrations-changed').length).toBeGreaterThanOrEqual(4);
        service.dispose();
        target.close();
    });
});

/**
 * The sync hub's half of phone push (agent-lifecycle.md §7.8): the `push-*` verbs, and which
 * phones a `notification` broadcast is pushed to.
 */

import { WS_PROTOCOL_VERSION } from '@kelpi/protocol';
import { describe, expect, it, vi } from 'vitest';

import { credentialFingerprint } from '../lifecycle/devices.js';
import type { PushNotice, PushSubscribeInput } from '../push/service.js';
import { harness as storeHarness, seededState, W1 } from '../store/testing.js';
import { createSyncHub, type SyncHubOptions } from './sync.js';
import { PANE_A, recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };
const ENDPOINT = 'https://web.push.apple.com/phone-1';

interface FakePush {
    readonly channel: NonNullable<SyncHubOptions['push']>;
    readonly subscribed: { input: PushSubscribeInput; credentialHash: string | null }[];
    readonly delivered: { notice: PushNotice; skip: string[]; only?: string[] }[];
    readonly unsubscribed: string[];
    readonly tested: string[];
}

function fakePush(): FakePush {
    const subscribed: FakePush['subscribed'] = [];
    const delivered: FakePush['delivered'] = [];
    const unsubscribed: string[] = [];
    const tested: string[] = [];
    return {
        subscribed,
        delivered,
        unsubscribed,
        tested,
        channel: {
            subscribe(input, credentialHash) {
                if (input.endpoint.startsWith('http:')) throw new Error('push endpoint must be https');
                subscribed.push({ input, credentialHash });
            },
            unsubscribe(endpoint) {
                unsubscribed.push(endpoint);
                return true;
            },
            deliver(notice, skip, only) {
                delivered.push({ notice, skip: [...skip], ...(only !== undefined ? { only: [...only] } : {}) });
                return Promise.resolve();
            },
            test(endpoint) {
                tested.push(endpoint);
                return Promise.resolve({ ok: true, status: 201 });
            }
        }
    };
}

function setup(clock = { now: 1_700_000_000_000 }) {
    const push = fakePush();
    const hub = createSyncHub({
        store: storeHarness(seededState(W1, PANE_A)).store,
        dispatcher: () => {},
        daemon: DAEMON,
        validateToken: (token) => token === 'tok' || token.startsWith('kd_'),
        push: push.channel,
        now: () => clock.now
    });
    const connect = (token: string) => {
        const transport = recordingTransport();
        const session = hub.createSession(transport);
        session.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token, client: { kind: 'browser', name: 'kelpi-web' } }));
        return { session, transport };
    };
    return { hub, push, connect, clock };
}

const SUBSCRIBE = {
    command: 'push-subscribe',
    endpoint: ENDPOINT,
    p256dh: 'BKey',
    auth: 'secret',
    vapid_public_key: 'BVapid',
    vapid_private_key: 'dVapid',
    host: 'phone:7'
};

const NOTIFICATION = { type: 'notification', kind: 'agent-waiting', paneID: PANE_A, workspaceID: W1, title: 'dev', body: 'Agent is waiting for input', dedupeKey: `kelpi-${PANE_A}` };

const replyFor = (transport: RecordedTransport, id: string): unknown =>
    (transport.json.find((m) => m['type'] === 'command-reply' && m['id'] === id) as Record<string, unknown> | undefined)?.['reply'];

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function presence(visible: boolean): string {
    return JSON.stringify({ type: 'push-presence', visible });
}

describe('push-subscribe / push-unsubscribe / push-test', () => {
    it('registers a paired phone, remembering its credential’s fingerprint', () => {
        const { push, connect } = setup();
        const { session, transport } = connect('kd_phone');
        session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: SUBSCRIBE }));
        expect(replyFor(transport, 's1')).toEqual({ ok: true });
        expect(push.subscribed).toEqual([
            {
                input: { endpoint: ENDPOINT, p256dh: 'BKey', auth: 'secret', vapidPublicKey: 'BVapid', vapidPrivateKey: 'dVapid', host: 'phone:7' },
                credentialHash: credentialFingerprint('kd_phone')
            }
        ]);
    });

    it('names a missing field and passes the service’s refusal through', () => {
        const { push, connect } = setup();
        const { session, transport } = connect('kd_phone');
        session.handleMessage(JSON.stringify({ type: 'command', id: 'm1', payload: { ...SUBSCRIBE, auth: undefined } }));
        session.handleMessage(JSON.stringify({ type: 'command', id: 'm2', payload: { ...SUBSCRIBE, endpoint: 'http://x/y' } }));
        expect(replyFor(transport, 'm1')).toEqual({ ok: false, error: 'push-subscribe requires auth' });
        expect(replyFor(transport, 'm2')).toEqual({ ok: false, error: 'push endpoint must be https' });
        expect(push.subscribed).toEqual([]);
    });

    it('tests and unsubscribes this connection’s own subscription', async () => {
        const { push, connect } = setup();
        const { session, transport } = connect('kd_phone');
        session.handleMessage(JSON.stringify({ type: 'command', id: 't0', payload: { command: 'push-test' } }));
        session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: SUBSCRIBE }));
        session.handleMessage(JSON.stringify({ type: 'command', id: 't1', payload: { command: 'push-test' } }));
        session.handleMessage(JSON.stringify({ type: 'command', id: 'u1', payload: { command: 'push-unsubscribe', endpoint: ENDPOINT } }));
        await settle();
        expect(replyFor(transport, 't0')).toEqual({ ok: false, error: 'this connection has not registered for push' });
        expect(replyFor(transport, 't1')).toEqual({ ok: true, status: 201 });
        expect(replyFor(transport, 'u1')).toEqual({ ok: true });
        expect(push.tested).toEqual([ENDPOINT]);
        expect(push.unsubscribed).toEqual([ENDPOINT]);
    });

    it('answers "not available" when no push service is composed', () => {
        const hub = createSyncHub({ store: storeHarness(seededState()).store, dispatcher: () => {}, daemon: DAEMON });
        const transport = recordingTransport();
        const session = hub.createSession(transport);
        session.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token: 'tok' }));
        session.handleMessage(JSON.stringify({ type: 'command', id: 'n1', payload: SUBSCRIBE }));
        expect(replyFor(transport, 'n1')).toEqual({ ok: false, error: 'push notifications are not available' });
    });
});

describe('the push fan-out of a notification broadcast', () => {
    it('pushes the notification, skipping a phone that is looking at Kelpi', () => {
        const { hub, push, connect } = setup();
        const { session } = connect('kd_phone');
        session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: SUBSCRIBE }));

        session.handleMessage(presence(true));
        hub.broadcast(NOTIFICATION);
        session.handleMessage(presence(false));
        hub.broadcast(NOTIFICATION);

        expect(push.delivered).toEqual([
            { notice: { kind: 'agent-waiting', title: 'dev', body: 'Agent is waiting for input', dedupeKey: `kelpi-${PANE_A}`, paneID: PANE_A, workspaceID: W1 }, skip: [ENDPOINT] },
            { notice: { kind: 'agent-waiting', title: 'dev', body: 'Agent is waiting for input', dedupeKey: `kelpi-${PANE_A}`, paneID: PANE_A, workspaceID: W1 }, skip: [] }
        ]);
    });

    it('takes the phone’s word from push-subscribe, and not from a workspace visibility report', () => {
        const { hub, push, connect } = setup();
        const { session } = connect('kd_phone');
        session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: { ...SUBSCRIBE, visible: false } }));
        session.handleMessage(JSON.stringify({ type: 'visibility-report', workspaceID: W1, visiblePaneIDs: [], documentVisible: true }));
        hub.broadcast(NOTIFICATION);
        session.handleMessage(JSON.stringify({ type: 'command', id: 's2', payload: SUBSCRIBE }));
        hub.broadcast(NOTIFICATION);
        expect(push.delivered.map((entry) => entry.skip)).toEqual([[], [ENDPOINT]]);
    });

    it('stops counting a visible phone that has gone silent (a suspended page)', () => {
        const { hub, push, connect, clock } = setup();
        const { session } = connect('kd_phone');
        session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: SUBSCRIBE }));
        session.handleMessage(presence(true));

        clock.now += 30_000;
        hub.broadcast(NOTIFICATION);
        clock.now += 30_000;
        hub.broadcast(NOTIFICATION);
        // A ping is enough to say it is alive again.
        session.handleMessage(JSON.stringify({ type: 'ping', id: 'p' }));
        hub.broadcast(NOTIFICATION);

        expect(push.delivered.map((entry) => entry.skip)).toEqual([[ENDPOINT], [], [ENDPOINT]]);
    });

    it('a wall clock stepped back does not keep a silent phone counted as looking', () => {
        const { hub, push, connect, clock } = setup();
        const { session } = connect('kd_phone');
        session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: SUBSCRIBE }));
        session.handleMessage(presence(true));
        clock.now -= 60 * 60_000;
        hub.broadcast(NOTIFICATION);
        expect(push.delivered.map((entry) => entry.skip)).toEqual([[]]);
    });

    it('pushes a phone after all when it counted as looking but never spoke again (frozen before "hidden" got out)', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const OTHER = 'https://fcm.googleapis.com/fcm/send/phone-2';
            const { hub, push, connect, clock } = setup();
            const frozen = connect('kd_phone');
            frozen.session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: SUBSCRIBE }));
            frozen.session.handleMessage(presence(true));
            const looking = connect('kd_other');
            looking.session.handleMessage(JSON.stringify({ type: 'command', id: 's2', payload: { ...SUBSCRIBE, endpoint: OTHER } }));
            looking.session.handleMessage(presence(true));

            clock.now += 1_000;
            hub.broadcast(NOTIFICATION);
            // The phone that is really on screen repeats its presence; the frozen one says nothing.
            clock.now += 20_000;
            looking.session.handleMessage(presence(true));
            vi.advanceTimersByTime(30_000);

            expect(push.delivered.map(({ skip, only }) => ({ skip, only }))).toEqual([
                { skip: [ENDPOINT, OTHER], only: undefined },
                { skip: [], only: [ENDPOINT] }
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a late push never lands after a newer one for the same pane', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const { hub, push, connect, clock } = setup();
            const { session } = connect('kd_phone');
            session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: SUBSCRIBE }));
            session.handleMessage(presence(true));
            hub.broadcast({ ...NOTIFICATION, body: 'stopped' });
            // Silent past the 45 s rule: the next one is pushed at once, and the first one's late look stands down.
            clock.now += 46_000;
            hub.broadcast({ ...NOTIFICATION, body: 'needs permission' });
            vi.advanceTimersByTime(30_000);
            expect(push.delivered.map(({ notice, skip, only }) => ({ body: notice.body, skip, only }))).toEqual([
                { body: 'stopped', skip: [ENDPOINT], only: undefined },
                { body: 'needs permission', skip: [], only: undefined }
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a phone that reloads inside the window spoke; a closed hub looks at nothing later', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const { hub, push, connect, clock } = setup();
            const before = connect('kd_phone');
            before.session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: SUBSCRIBE }));
            before.session.handleMessage(presence(true));
            hub.broadcast(NOTIFICATION);
            before.session.close();
            clock.now += 2_000;
            const after = connect('kd_phone');
            after.session.handleMessage(JSON.stringify({ type: 'command', id: 's2', payload: SUBSCRIBE }));
            vi.advanceTimersByTime(30_000);
            expect(push.delivered).toHaveLength(1);

            hub.broadcast(NOTIFICATION);
            hub.close();
            vi.advanceTimersByTime(30_000);
            expect(push.delivered).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a closed connection no longer shields its phone', () => {
        const { hub, push, connect } = setup();
        const { session } = connect('kd_phone');
        session.handleMessage(JSON.stringify({ type: 'command', id: 's1', payload: SUBSCRIBE }));
        session.handleMessage(presence(true));
        session.close();
        hub.broadcast(NOTIFICATION);
        expect(push.delivered.map((entry) => entry.skip)).toEqual([[]]);
    });

    it('pushes nothing for a muted workspace, an attention request, or a notification with no pane', () => {
        const { hub, push } = setup();
        hub.broadcast({ ...NOTIFICATION, muted: true });
        hub.broadcast({ type: 'attention-request', paneID: PANE_A, workspaceID: W1 });
        hub.broadcast({ type: 'notification', kind: 'info', title: 't', body: 'b' });
        expect(push.delivered).toEqual([]);
    });
});

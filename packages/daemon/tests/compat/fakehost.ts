/**
 * A fake **web-pane host** for the compat suite.
 *
 * `packages/daemon/src/webpane/HOST_PROTOCOL.md` is the daemon↔shell contract: the host is an
 * ordinary WS client that claims the `web-pane` role, answers `host-rpc` frames with the exact
 * envelope the CLI will see, receives fire-and-forget `host-notify` mirrors of daemon-owned
 * state, and pushes `host-event` frames upward (console lines, page state, picked elements).
 *
 * This module implements that client side in ~150 lines so the compat tests can drive the
 * **real Swift CLI** through the daemon and observe both ends of every web verb: what the CLI
 * printed and exited with, and what the host was asked to do. The real Electron host is
 * exercised separately by `packages/shell/scripts/web-smoke.mjs` (real Chromium, real CDP,
 * same CLI) — see `../kelpi-docs/compat-status.md` for why the split exists.
 *
 * Nothing here touches the production daemon: the socket comes from a `startCompatDaemon()`
 * instance with its own tmp everything.
 */

import { WS_PROTOCOL_VERSION } from '@kelpi/protocol';
import WebSocket from 'ws';

import type { DaemonInfo } from '../../src/boot/index.js';

export type JsonRecord = Record<string, unknown>;

/** One `host-rpc` the daemon sent. */
export interface HostCall {
    readonly id: string;
    readonly verb: string;
    readonly args: JsonRecord;
    readonly timeoutMs: number;
}

/** One fire-and-forget `host-notify`. */
export interface HostNotify {
    readonly verb: string;
    readonly args: JsonRecord;
}

export interface FakeWebHost {
    /** Every `host-rpc`, in arrival order (answered or not). */
    readonly calls: readonly HostCall[];
    /** Every `host-notify`, in arrival order. */
    readonly notifies: readonly HostNotify[];
    /**
     * Standing auto-responder for a verb: the reply is computed from the call, so a test can
     * `await kelpi.run([...])` directly instead of racing the CLI with a manual `answer`.
     * Registering a verb twice replaces the responder.
     */
    on(verb: string, handler: (call: HostCall) => JsonRecord): void;
    /** Wait for the next unanswered call (optionally of one verb) and answer it. */
    answer(reply: JsonRecord, verb?: string, timeoutMs?: number): Promise<HostCall>;
    /** Every recorded call of one verb. */
    callsOf(verb: string): readonly HostCall[];
    /** Every recorded notify of one verb. */
    notifiesOf(verb: string): readonly HostNotify[];
    /** Wait for a `host-notify` matching `verb` (and an optional predicate on its args). */
    waitForNotify(
        verb: string,
        predicate?: (args: JsonRecord) => boolean,
        timeoutMs?: number
    ): Promise<HostNotify>;
    /** Push a `host-event` upward (console line, page-state, inspect payload, tab-closed). */
    emit(event: string, paneID: string, payload: JsonRecord, tabID?: string): void;
    close(): void;
}

/** Poll `read` until it yields a value, then return it. Rejects (never hangs) on timeout. */
async function until<T>(read: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`no ${what} within ${String(timeoutMs)}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
}

/**
 * Connect to `info.url`, claim the `web-pane` role through the `hello` capability list (the
 * form the real shell uses), and resolve once the daemon has confirmed with `host-registered`.
 */
export async function connectFakeHost(
    info: DaemonInfo,
    name = 'compat-shell'
): Promise<FakeWebHost> {
    const endpoint = `${info.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(info.token)}`;
    const socket = new WebSocket(endpoint);
    const calls: HostCall[] = [];
    const notifies: HostNotify[] = [];
    const answered = new Set<string>();
    const responders = new Map<string, (call: HostCall) => JsonRecord>();
    let registered = false;

    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });

    const send = (message: JsonRecord): void => {
        socket.send(JSON.stringify(message));
    };

    const reply = (callID: string, envelope: JsonRecord): void => {
        answered.add(callID);
        send({ type: 'host-rpc-reply', id: callID, reply: envelope });
    };

    socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString('utf8')) as JsonRecord;
        switch (message['type']) {
            case 'host-registered':
                registered = true;
                return;
            case 'host-rpc': {
                const call: HostCall = {
                    id: String(message['id']),
                    verb: String(message['verb']),
                    args: (message['args'] ?? {}) as JsonRecord,
                    timeoutMs: Number(message['timeoutMs'] ?? 0)
                };
                calls.push(call);
                const responder = responders.get(call.verb);
                if (responder !== undefined) reply(call.id, responder(call));
                return;
            }
            case 'host-notify':
                notifies.push({
                    verb: String(message['verb']),
                    args: (message['args'] ?? {}) as JsonRecord
                });
                return;
            default:
                return;
        }
    });

    send({
        type: 'hello',
        protocolVersion: WS_PROTOCOL_VERSION,
        token: info.token,
        client: { kind: 'electron', name, capabilities: ['web-pane-host'] }
    });
    await until(() => (registered ? true : undefined), 'host-registered', 5_000);

    return {
        calls,
        notifies,
        on(verb, handler) {
            responders.set(verb, handler);
        },
        async answer(envelope, verb, timeoutMs = 10_000) {
            const call = await until(
                () =>
                    calls.find(
                        (candidate) =>
                            !answered.has(candidate.id) &&
                            (verb === undefined || candidate.verb === verb)
                    ),
                `host-rpc${verb === undefined ? '' : ` ${verb}`}`,
                timeoutMs
            );
            reply(call.id, envelope);
            return call;
        },
        callsOf(verb) {
            return calls.filter((call) => call.verb === verb);
        },
        notifiesOf(verb) {
            return notifies.filter((notify) => notify.verb === verb);
        },
        waitForNotify(verb, predicate, timeoutMs = 10_000) {
            return until(
                () =>
                    notifies.find(
                        (notify) =>
                            notify.verb === verb &&
                            (predicate === undefined || predicate(notify.args))
                    ),
                `host-notify ${verb}`,
                timeoutMs
            );
        },
        emit(event, paneID, payload, tabID) {
            send({
                type: 'host-event',
                event,
                paneID,
                ...(tabID === undefined ? {} : { tabID }),
                payload
            });
        },
        close() {
            socket.close();
        }
    };
}

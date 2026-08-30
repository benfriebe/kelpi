/**
 * Test-only fixtures for the web-pane subsystem: an in-process **fake host** implementing the
 * daemon side of `./HOST_PROTOCOL.md`, and a harness that seeds a workspace with a real web
 * pane and runs the `web-*` handlers through the real wire decoder.
 *
 * A real module (not inlined in the specs) so every colocated test drives the same fake, and
 * so the fake stays honest when the protocol changes.
 */

import { decodeWireObject, dispatchSequence, type WireMessage } from '@kelpi/protocol';

import { createAppHandlers, type AppContext, type AppHandlerTable } from '../handlers/app/index.js';
import type {
    PtyManager,
    PtySpawnOptions,
    ReplyHandle,
    TerminalInput,
    TerminalStateService,
    VtModes
} from '../seams.js';
import { createStore, emptyDaemonState, type DaemonState, type KelpiStore } from '../store/index.js';
import type { HostRegistration } from './host.js';
import { createWebPaneService, type WebPaneService } from './service.js';

export const HOME = '/Users/test';
export const NOW = 1_755_500_000_000;

/** Deterministic canonical UUIDs, matching `handlers/app/testing.ts`'s scheme. */
export function id(prefix: string, n: number): string {
    const head = prefix.padEnd(8, '0').slice(0, 8);
    return `${head}-0000-4000-8000-${String(n).padStart(12, '0')}`.toUpperCase();
}

export const WORKSPACE = id('aaaaaaaa', 1);
export const SHELL_PANE = id('dddddddd', 1);
export const WEB_PANE = id('eeeeeeee', 1);
export const WEB_TAB = id('cccccccc', 1);

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

export interface RecordedHostCall {
    readonly id: string;
    readonly verb: string;
    readonly args: Record<string, unknown>;
    readonly timeoutMs: number;
}

export interface RecordedNotify {
    readonly verb: string;
    readonly args: Record<string, unknown>;
}

export interface FakeHost {
    readonly registration: HostRegistration;
    /** Every `host-rpc` the daemon sent, in order. */
    readonly calls: RecordedHostCall[];
    /** Every fire-and-forget `host-notify`. */
    readonly notifies: RecordedNotify[];
    /** `host-registered` / `host-revoked` frames this host received. */
    readonly frames: Record<string, unknown>[];
    /** Answer the oldest unanswered call (optionally of a specific verb). */
    answer(reply: Record<string, unknown>, verb?: string): RecordedHostCall;
    /** Answer with an id nobody asked about — must be ignored. */
    answerRaw(callID: string, reply: Record<string, unknown>): void;
    /** Push a host event (console line, page state, picked element). */
    emit(event: string, paneID: string, payload: Record<string, unknown>, tabID?: string): void;
    release(): void;
    readonly revoked: boolean;
}

export function attachFakeHost(service: WebPaneService, name = 'fake-shell'): FakeHost {
    const calls: RecordedHostCall[] = [];
    const notifies: RecordedNotify[] = [];
    const frames: Record<string, unknown>[] = [];
    const answered = new Set<string>();
    let revoked = false;

    const registration = service.registerHost(
        {
            sendJson(message) {
                const type = message['type'];
                if (type === 'host-rpc') {
                    calls.push({
                        id: String(message['id']),
                        verb: String(message['verb']),
                        args: (message['args'] ?? {}) as Record<string, unknown>,
                        timeoutMs: Number(message['timeoutMs'])
                    });
                    return;
                }
                if (type === 'host-notify') {
                    notifies.push({
                        verb: String(message['verb']),
                        args: (message['args'] ?? {}) as Record<string, unknown>
                    });
                    return;
                }
                if (type === 'host-revoked') revoked = true;
                frames.push(message as Record<string, unknown>);
            }
        },
        { name }
    );

    return {
        registration,
        calls,
        notifies,
        frames,
        answer(reply, verb) {
            const call = calls.find(
                (candidate) => !answered.has(candidate.id) && (verb === undefined || candidate.verb === verb)
            );
            if (call === undefined) {
                throw new Error(`no pending host call${verb === undefined ? '' : ` for '${verb}'`}`);
            }
            answered.add(call.id);
            service.settleHostReply(call.id, reply as never);
            return call;
        },
        answerRaw(callID, reply) {
            service.settleHostReply(callID, reply as never);
        },
        emit(event, paneID, payload, tabID) {
            service.handleHostEvent({
                event,
                paneID,
                ...(tabID === undefined ? {} : { tabID }),
                payload
            });
        },
        release() {
            registration.release();
        },
        get revoked() {
            return revoked;
        }
    };
}

// ---------------------------------------------------------------------------
// Handler harness
// ---------------------------------------------------------------------------

function fakePty(spawns: PtySpawnOptions[]): PtyManager {
    const live = new Set<string>();
    return {
        spawn(options) {
            spawns.push(options);
            live.add(options.paneID);
        },
        has: (paneID) => live.has(paneID),
        write: () => {},
        writeDirect: () => {},
        resize: () => {},
        kill: (paneID) => {
            live.delete(paneID);
        },
        killAll: async () => {
            live.clear();
        },
        setSyncGroup: () => {},
        onData: () => () => {},
        onExit: () => () => {}
    };
}

function fakeTerm(): TerminalStateService {
    const modes: VtModes = { applicationCursorKeys: false, bracketedPaste: false };
    return {
        attach: () => {},
        feed: () => {},
        resize: () => {},
        capture: () => '',
        snapshot: () => ({ data: new Uint8Array(), cols: 80, rows: 24 }),
        modes: () => modes,
        dispose: () => {}
    };
}

export interface PastedText {
    readonly paneID: string;
    readonly text: string;
    readonly bare: boolean;
}

export interface CapturedLine {
    readonly payload: Record<string, unknown>;
    /** Store state when the line was written — proves reply-before-effect. */
    readonly state: DaemonState;
}

export interface OpenReply {
    readonly lines: CapturedLine[];
    readonly closed: boolean;
    /** Simulate the CLI hanging up (the control server fires disconnect callbacks). */
    disconnect(): void;
    readonly handle: ReplyHandle;
}

export interface WebHarness {
    readonly store: KelpiStore;
    readonly ctx: AppContext;
    readonly table: AppHandlerTable;
    readonly service: WebPaneService;
    readonly pasted: PastedText[];
    readonly minted: string[];
    state(): DaemonState;
    /** Decode + dispatch one wire object; returns the reply lines (empty for fire-and-forget). */
    send(object: Record<string, unknown>): Record<string, unknown>[];
    /** Like `send`, asserting exactly one line. */
    reply(object: Record<string, unknown>): Record<string, unknown>;
    /** `send` for a streaming command: the handle stays open and records every line. */
    open(object: Record<string, unknown>): OpenReply;
    /** Every reply the harness has seen, in order. */
    readonly replies: CapturedLine[][];
}

export interface WebHarnessOptions {
    /** Extra ids handed out by the minter, before the counted fallback. */
    readonly ids?: readonly string[] | undefined;
    /** Seed the workspace with a web pane (default true). */
    readonly withWebPane?: boolean | undefined;
    readonly nonce?: (() => string) | undefined;
}

/** A workspace with one shell pane, plus (by default) a web pane holding one tab. */
export function webHarness(options: WebHarnessOptions = {}): WebHarness {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({
        type: 'create-workspace',
        id: WORKSPACE,
        paneID: SHELL_PANE,
        name: 'w1',
        color: 'blue',
        now: NOW
    });
    if (options.withWebPane !== false) {
        store.dispatch({
            type: 'open-web-pane',
            workspaceID: WORKSPACE,
            paneID: WEB_PANE,
            tabID: WEB_TAB,
            url: 'https://example.com',
            now: NOW
        });
    }

    const pasted: PastedText[] = [];
    const input: TerminalInput = {
        sendText: (paneID, text, opts) => {
            pasted.push({ paneID, text, bare: opts.bare });
        },
        sendNamedKey: () => {}
    };

    const service = createWebPaneService({
        store,
        now: () => NOW,
        paste: (paneID, text, pasteOptions) => {
            input.sendText(paneID, text, { bare: !pasteOptions.submit });
        },
        ...(options.nonce !== undefined ? { nonce: options.nonce } : {})
    });

    const minted: string[] = [];
    const pool = [...(options.ids ?? [])];
    let counter = 0;
    const mint = (): string => {
        counter += 1;
        const value = pool.shift() ?? id('ffffffff', counter);
        minted.push(value);
        return value;
    };

    const ctx: AppContext = {
        store,
        pty: fakePty([]),
        term: fakeTerm(),
        input,
        version: { version: '9.9.9', build: '4242', protocol: 1 },
        broadcast: () => {}
    };

    const table = createAppHandlers({
        webPanes: service,
        uuid: mint,
        now: () => NOW,
        random: () => 0
    });

    const replies: CapturedLine[][] = [];

    const makeHandle = (): { handle: ReplyHandle; lines: CapturedLine[]; disconnect: () => void; closed: () => boolean } => {
        const lines: CapturedLine[] = [];
        const callbacks: (() => void)[] = [];
        let closed = false;
        const handle: ReplyHandle = {
            send(payload) {
                if (closed) return;
                lines.push({ payload, state: store.getState() });
            },
            close() {
                closed = true;
            },
            get closed() {
                return closed;
            },
            onDisconnect(callback) {
                if (closed) {
                    callback();
                    return;
                }
                callbacks.push(callback);
            }
        };
        return {
            handle,
            lines,
            closed: () => closed,
            disconnect: () => {
                closed = true;
                for (const callback of callbacks.splice(0)) callback();
            }
        };
    };

    const run = (object: Record<string, unknown>): { lines: CapturedLine[]; handle: ReplyHandle; disconnect: () => void; closed: () => boolean } => {
        const decoded = decodeWireObject(object);
        if (!decoded.ok) throw new Error(`wire decode rejected: ${decoded.detail}`);
        const slot = makeHandle();
        for (const item of dispatchSequence(decoded)) {
            const message: WireMessage =
                item.kind === 'message'
                    ? item.message
                    : {
                          command: 'session-start',
                          pane_id: item.event.pane_id,
                          session_id: item.event.session_id,
                          agent: item.event.agent
                      };
            table.get(message.command)?.(message, ctx, item.reply ? slot.handle : null);
        }
        replies.push(slot.lines);
        return slot;
    };

    return {
        store,
        ctx,
        table,
        service,
        pasted,
        minted,
        replies,
        state: () => store.getState(),
        send: (object) => run(object).lines.map((line) => line.payload),
        reply(object) {
            const lines = run(object).lines;
            if (lines.length !== 1) {
                throw new Error(
                    `expected exactly one reply line, got ${String(lines.length)} for ${String(object['command'])}`
                );
            }
            return (lines[0] as CapturedLine).payload;
        },
        open(object) {
            const slot = run(object);
            return {
                lines: slot.lines,
                get closed() {
                    return slot.closed();
                },
                disconnect: slot.disconnect,
                handle: slot.handle
            };
        }
    };
}

/** Let the promise chain behind a host RPC settle. */
export async function flush(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

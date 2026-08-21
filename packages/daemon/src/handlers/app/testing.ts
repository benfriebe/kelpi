/**
 * Test harness for the app handler family: a real store, recording fakes for the PTY /
 * terminal seams, and a wire path that goes through the REAL decoder + dual-fire sequencer,
 * so the tests assert against the same message shapes production sees.
 *
 * Not part of the runtime path (nothing outside `*.test.ts` imports it), but kept as a real
 * module so every colocated spec builds the same fixtures.
 */

import { decodeWireObject, dispatchSequence, type WireMessage } from '@nex/protocol';

import type {
    PtyManager,
    PtySpawnOptions,
    ReplyHandle,
    TerminalInput,
    TerminalStateService,
    VtModes
} from '../../seams.js';
import {
    createStore,
    emptyDaemonState,
    type DaemonState,
    type DomainAction,
    type DomainEvent,
    type NexStore
} from '../../store/index.js';
import { createAppHandlers } from './index.js';
import type { AppContext, AppHandlerOptions, AppHandlerTable, SpawnPaneRequest } from './context.js';

export const HOME = '/Users/test';
export const NOW = 1_755_500_000_000;

/** Deterministic canonical UUIDs: `id('w', 1)` → `0000000W-0000-4000-8000-000000000001`. */
export function id(prefix: string, n: number): string {
    const head = prefix.padEnd(8, '0').slice(0, 8);
    return `${head}-0000-4000-8000-${String(n).padStart(12, '0')}`.toUpperCase();
}

export interface CapturedReply {
    readonly command: string;
    readonly payloads: Record<string, unknown>[];
    /** Store state at the moment each payload was written — proves reply-before-effect. */
    readonly states: DaemonState[];
    readonly closed: boolean;
}

export interface RecordedSpawn extends SpawnPaneRequest {}

export interface Harness {
    readonly store: NexStore;
    readonly ctx: AppContext;
    readonly table: AppHandlerTable;
    readonly broadcasts: Record<string, unknown>[];
    readonly spawned: RecordedSpawn[];
    readonly killed: string[];
    readonly ptySpawns: PtySpawnOptions[];
    readonly persists: number[];
    readonly persistsNow: number[];
    readonly scrolled: { kind: string; id: string }[];
    readonly syncGroups: RecordedSyncGroup[];
    /** Every id `deps.uuid()` handed out, in order. */
    readonly minted: string[];
    state(): DaemonState;
    dispatch(...actions: readonly DomainAction[]): void;
    /** Decode + dispatch one wire object; returns the reply payloads (empty for F&F). */
    send(object: Record<string, unknown>): Record<string, unknown>[];
    /** Like `send` but asserts exactly one reply line and returns it. */
    reply(object: Record<string, unknown>): Record<string, unknown>;
    /**
     * Dispatch a message the daemon CONSTRUCTED rather than decoded, and assert one reply.
     *
     * `send`/`reply` go through `decodeWireObject`, which is exactly right for anything that
     * arrives over the control socket — and exactly wrong for the handful of GUI-only messages
     * the WS layer builds itself (§WS-156's `delete-workspace` → `workspace-delete` with
     * `allow_last`, `ws/sync.ts` ▸ `guiDeleteWorkspace`). Those carry fields that are deliberately
     * NOT in wire-protocol.md §7's dictionary, so a decode would silently drop them and the test
     * would pass for the wrong reason.
     */
    replyMessage(message: WireMessage): Record<string, unknown>;
    readonly replies: CapturedReply[];
}

export interface RecordedSyncGroup {
    readonly workspaceID: string;
    readonly paneIDs: string[];
}

function fakePty(
    record: PtySpawnOptions[],
    killed: string[],
    syncGroups: RecordedSyncGroup[]
): PtyManager {
    const live = new Set<string>();
    return {
        spawn(options) {
            record.push(options);
            live.add(options.paneID);
        },
        has: (paneID) => live.has(paneID),
        write: () => {},
        writeDirect: () => {},
        resize: () => {},
        kill(paneID) {
            killed.push(paneID);
            live.delete(paneID);
        },
        killAll: async () => {
            live.clear();
        },
        setSyncGroup(workspaceID, paneIDs) {
            syncGroups.push({ workspaceID, paneIDs: [...paneIDs] });
        },
        onData: () => () => {},
        onExit: () => () => {}
    };
}

function fakeTerm(disposed: string[]): TerminalStateService {
    const modes: VtModes = { applicationCursorKeys: false, bracketedPaste: false };
    return {
        attach: () => {},
        feed: () => {},
        resize: () => {},
        capture: () => '',
        snapshot: () => ({ data: new Uint8Array(), cols: 80, rows: 24 }),
        modes: () => modes,
        dispose(paneID) {
            disposed.push(paneID);
        }
    };
}

const fakeInput: TerminalInput = {
    sendText: () => {},
    sendNamedKey: () => {}
};

export interface HarnessOptions extends AppHandlerOptions {
    readonly initial?: DaemonState | undefined;
    /** UUIDs handed out in order; exhausted → a counted fallback. */
    readonly ids?: readonly string[] | undefined;
}

export function harness(options: HarnessOptions = {}): Harness {
    const store = createStore(options.initial ?? emptyDaemonState(HOME));
    const broadcasts: Record<string, unknown>[] = [];
    const spawned: RecordedSpawn[] = [];
    const killed: string[] = [];
    const disposed: string[] = [];
    const ptySpawns: PtySpawnOptions[] = [];
    const persists: number[] = [];
    const persistsNow: number[] = [];
    const scrolled: { kind: string; id: string }[] = [];
    const syncGroups: RecordedSyncGroup[] = [];
    const minted: string[] = [];

    const pool = [...(options.ids ?? [])];
    let counter = 0;
    const mint = (): string => {
        const next = pool.shift();
        counter += 1;
        const value = next ?? id('ffffffff', counter);
        minted.push(value);
        return value;
    };

    const ctx: AppContext = {
        store,
        pty: fakePty(ptySpawns, killed, syncGroups),
        term: fakeTerm(disposed),
        input: fakeInput,
        version: { version: '9.9.9', build: '4242', protocol: 1 },
        broadcast: (event) => {
            broadcasts.push(event);
        }
    };

    const table = createAppHandlers({
        ...options,
        uuid: options.uuid ?? mint,
        now: options.now ?? (() => NOW),
        random: options.random ?? (() => 0),
        persist:
            options.persist ??
            (() => {
                persists.push(persists.length);
            }),
        persistNow:
            options.persistNow ??
            (() => {
                persistsNow.push(persistsNow.length);
            }),
        spawnPane:
            options.spawnPane ??
            ((request) => {
                spawned.push(request);
            }),
        killPane:
            options.killPane ??
            ((paneID) => {
                killed.push(paneID);
                disposed.push(paneID);
            }),
        scrollTarget:
            options.scrollTarget ??
            ((target) => {
                scrolled.push({ kind: target.kind, id: target.id });
            })
    });

    const replies: CapturedReply[] = [];

    const run = (message: WireMessage, wantsReply: boolean): Record<string, unknown>[] => {
        const payloads: Record<string, unknown>[] = [];
        const states: DaemonState[] = [];
        let closed = false;
        const handle: ReplyHandle = {
            send(payload) {
                payloads.push(payload);
                states.push(store.getState());
            },
            close() {
                closed = true;
            },
            get closed() {
                return closed;
            },
            onDisconnect: () => {}
        };
        table.get(message.command)?.(message, ctx, wantsReply ? handle : null);
        if (wantsReply) {
            replies.push({
                command: message.command,
                payloads,
                states,
                get closed() {
                    return closed;
                }
            });
        }
        return payloads;
    };

    const send = (object: Record<string, unknown>): Record<string, unknown>[] => {
        const decoded = decodeWireObject(object);
        if (!decoded.ok) throw new Error(`wire decode rejected: ${decoded.detail}`);
        let last: Record<string, unknown>[] = [];
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
            const payloads = run(message, item.reply);
            if (item.kind === 'message') last = payloads;
        }
        return last;
    };

    return {
        store,
        ctx,
        table,
        broadcasts,
        spawned,
        killed,
        ptySpawns,
        persists,
        persistsNow,
        scrolled,
        syncGroups,
        minted,
        replies,
        state: () => store.getState(),
        dispatch: (...actions) => {
            for (const action of actions) store.dispatch(action);
        },
        send,
        reply(object) {
            const payloads = send(object);
            if (payloads.length !== 1) {
                throw new Error(
                    `expected exactly one reply line, got ${String(payloads.length)} for ${String(object['command'])}`
                );
            }
            return payloads[0] as Record<string, unknown>;
        },
        replyMessage(message) {
            const payloads = run(message, true);
            if (payloads.length !== 1) {
                throw new Error(
                    `expected exactly one reply line, got ${String(payloads.length)} for ${message.command}`
                );
            }
            return payloads[0] as Record<string, unknown>;
        }
    };
}

/** Let the async worktree chain (promise callbacks) settle. */
export async function flush(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

/** A state with `count` workspaces named `w1..wN`, each with one shell pane. */
export function seeded(count: number, options: { readonly home?: string } = {}): DaemonState {
    const store = createStore(emptyDaemonState(options.home ?? HOME));
    for (let index = 1; index <= count; index += 1) {
        store.dispatch({
            type: 'create-workspace',
            id: id('aaaaaaaa', index),
            paneID: id('dddddddd', index),
            name: `w${String(index)}`,
            color: 'blue',
            now: NOW
        });
    }
    return store.getState();
}

export type { DomainEvent };

/**
 * `CsvClient` - the csv panes' one multiplexer over the daemon's csv verbs (#324,
 * docs/csv-pane.md, `@kelpi/protocol` `csv.ts`).
 *
 * The same shape as `content/client.ts`, for the same three reasons:
 *
 *   - **Refcounting.** The daemon's subscription is per CONNECTION, the UI's per component: two
 *     views of one pane share one wire subscription, and `csv-unsubscribe` goes out only when the
 *     last local listener leaves.
 *   - **Reconnect.** A dropped socket takes every subscription with it, so the panes still
 *     mounted re-subscribe on the next `connected`.
 *   - **Ordering.** A state older than the one held is dropped (`revision` within one
 *     `incarnation`; a new incarnation is a reload or a restarted daemon and always wins).
 *
 * Unlike the content client, the verbs here REJECT on `{ok:false}` with the daemon's message,
 * because the caller (`csv-model.ts`) has to read the `CSV_STALE:` / `CSV_GONE:` code off it to
 * decide what an edit failure means. Every state-returning verb also delivers its state to the
 * pane's listeners, so a reply and a push cannot disagree.
 *
 * The per-pane row cache, edit queue and optimistic cells live one layer up, in
 * `csv-model.ts` (`createCsvPaneModel`), which is re-exported from here.
 */

import type { CommandClient, CommandReply, KelpiConnection } from '../../connection';
import { isOkReply, replyError } from '../../connection';
import type { JsonObject } from '@kelpi/protocol';
import { CSV_UPDATED_MESSAGE } from '@kelpi/protocol';

import {
    parseCsvFindReply,
    parseCsvFindStepReply,
    parseCsvRowsReply,
    parseCsvState,
    type CsvEditOp,
    type CsvFindDirection,
    type CsvFindReply,
    type CsvFindStepReply,
    type CsvPaneState,
    type CsvRowsReply,
    type CsvRowsRequest,
    type CsvSortDirection
} from './types';

export { createCsvPaneModel, csvPaneHasModel, flushCsvPane, type CsvPaneModel, type CsvPaneModelOptions } from './csv-model';

/**
 * Sorting, counting matches and re-indexing a large file can run for minutes, and the daemon
 * answers those verbs only when the work is done. The default 15 s deadline would fail a sort of
 * a 1 GB file that is still making progress.
 */
export const CSV_SLOW_COMMAND_TIMEOUT_MS = 10 * 60_000;
/** An edit batch is bounded (`CSV_LIMITS`), but a structural one rewrites indices: give it room. */
export const CSV_EDIT_TIMEOUT_MS = 60_000;

export interface CsvListener {
    readonly onState: (state: CsvPaneState) => void;
    readonly onError?: ((message: string) => void) | undefined;
    /** A local, one-off sentence for the pane's status line (e.g. "⌘E needs a smaller file"). */
    readonly onNotice?: ((message: string) => void) | undefined;
}

export interface CsvSubscription {
    unsubscribe(): void;
}

/** What a csv pane needs. Structural, so a test hands the grid an in-memory fake. */
export interface CsvApi {
    subscribe(paneID: string, listener: CsvListener): CsvSubscription;
    /** The last state seen for a pane, or null. */
    peek(paneID: string): CsvPaneState | null;
    rows(paneID: string, request: CsvRowsRequest): Promise<CsvRowsReply>;
    edit(paneID: string, generation: string, ops: readonly CsvEditOp[]): Promise<CsvPaneState>;
    sort(paneID: string, column: number | null, direction: CsvSortDirection): Promise<CsvPaneState>;
    find(paneID: string, query: string): Promise<CsvFindReply>;
    findStep(
        paneID: string,
        query: string,
        direction: CsvFindDirection,
        from: { view: number; column: number } | null
    ): Promise<CsvFindStepReply>;
    setHeaderRow(paneID: string, on: boolean): Promise<CsvPaneState>;
    discard(paneID: string): Promise<CsvPaneState>;
    /** Hand the pane's listeners a local notice (nothing goes to the daemon). */
    notify(paneID: string, message: string): void;
    /**
     * A failure with no grid left to show it (an edit batch that failed after its pane went to
     * raw text or closed): the window's error toast.
     */
    reportFailure(paneID: string, message: string): void;
    /** Resolves once the connection is up (at once when it is): when a lost edit can go again. */
    connected(): Promise<void>;
}

export interface CsvClientOptions {
    readonly connection: KelpiConnection;
    readonly commands: CommandClient;
    readonly onError?: ((message: string, context: string) => void) | undefined;
}

export interface CsvClient extends CsvApi {
    listenerCount(paneID: string): number;
    dispose(): void;
}

interface PaneEntry {
    readonly listeners: Set<CsvListener>;
    last: CsvPaneState | null;
    subscribed: boolean;
    /** Bumped per `csv-subscribe`, so the answer to a superseded one is not news. */
    subscribeSeq: number;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** True when `next` should replace `held`: a newer revision, or another incarnation entirely. */
export function isNewerCsvState(held: CsvPaneState | null, next: CsvPaneState): boolean {
    if (held === null) return true;
    if (held.incarnation !== next.incarnation) return true;
    return next.revision >= held.revision;
}

export function createCsvClient(options: CsvClientOptions): CsvClient {
    const { connection, commands } = options;
    const entries = new Map<string, PaneEntry>();
    let staleSubscriptions = false;
    let disposed = false;

    const entryFor = (paneID: string): PaneEntry => {
        const existing = entries.get(paneID);
        if (existing !== undefined) return existing;
        const created: PaneEntry = { listeners: new Set(), last: null, subscribed: false, subscribeSeq: 0 };
        entries.set(paneID, created);
        return created;
    };

    const deliver = (paneID: string, state: CsvPaneState): void => {
        const entry = entries.get(paneID);
        if (entry === undefined) return;
        if (!isNewerCsvState(entry.last, state)) return;
        entry.last = state;
        for (const listener of [...entry.listeners]) listener.onState(state);
    };

    const fail = (paneID: string, message: string, context: string): void => {
        options.onError?.(message, context);
        const entry = entries.get(paneID);
        if (entry === undefined) return;
        for (const listener of [...entry.listeners]) listener.onError?.(message);
    };

    /** `{ok:false}` becomes a rejection carrying the daemon's message (and so its error code). */
    const unwrap = (promise: Promise<CommandReply>): Promise<CommandReply> =>
        promise.then((reply) => {
            if (!isOkReply(reply)) throw new Error(replyError(reply));
            return reply;
        });

    const withState = (paneID: string, promise: Promise<CommandReply>): Promise<CsvPaneState> =>
        unwrap(promise).then((reply) => {
            const state = parseCsvState(reply['state']);
            if (state === null) throw new Error('CSV_INVALID: the daemon sent no csv state');
            deliver(paneID, state);
            return state;
        });

    const sendSubscribe = (paneID: string): void => {
        const entry = entries.get(paneID);
        if (entry === undefined || entry.listeners.size === 0) return;
        entry.subscribed = true;
        const seq = ++entry.subscribeSeq;
        withState(paneID, commands.csvSubscribe({ paneID })).catch((error: unknown) => {
            // A view that left and came back (a remount, a reconnect) re-subscribes, and the
            // daemon answers the older request "cancelled": that is not a failure of the pane.
            if (entries.get(paneID) !== entry || entry.subscribeSeq !== seq) return;
            fail(paneID, messageOf(error), 'csv-subscribe');
        });
    };

    const offMessage = connection.on('message', (message) => {
        if (message['type'] !== CSV_UPDATED_MESSAGE) return;
        const paneID = message['paneID'];
        if (typeof paneID !== 'string') return;
        const state = parseCsvState(message['state']);
        if (state === null) return;
        deliver(paneID, state);
    });

    const offStatus = connection.on('status', (status) => {
        if (status === 'connected') {
            if (!staleSubscriptions) return;
            staleSubscriptions = false;
            for (const [paneID, entry] of entries) {
                if (entry.listeners.size === 0) continue;
                entry.subscribed = false;
                sendSubscribe(paneID);
            }
            return;
        }
        if (status === 'connecting') return;
        staleSubscriptions = true;
        for (const entry of entries.values()) entry.subscribed = false;
    });

    const client: CsvClient = {
        subscribe(paneID, listener) {
            const entry = entryFor(paneID);
            entry.listeners.add(listener);
            if (entry.last !== null) listener.onState(entry.last);
            if (!entry.subscribed && !disposed) sendSubscribe(paneID);
            let released = false;
            return {
                unsubscribe(): void {
                    if (released) return;
                    released = true;
                    const current = entries.get(paneID);
                    if (current === undefined) return;
                    current.listeners.delete(listener);
                    if (current.listeners.size > 0) return;
                    const wasSubscribed = current.subscribed;
                    entries.delete(paneID);
                    if (wasSubscribed && !disposed) {
                        void commands
                            .csvUnsubscribe({ paneID })
                            .catch((error: unknown) => options.onError?.(messageOf(error), 'csv-unsubscribe'));
                    }
                }
            };
        },

        peek(paneID) {
            return entries.get(paneID)?.last ?? null;
        },

        rows(paneID, request) {
            return unwrap(
                commands.csvRows({
                    paneID,
                    start: request.start,
                    count: request.count,
                    ...(request.columnStart === undefined ? {} : { columnStart: request.columnStart }),
                    ...(request.columnCount === undefined ? {} : { columnCount: request.columnCount })
                })
            ).then((reply) => {
                const rows = parseCsvRowsReply(reply['rows']);
                if (rows === null) throw new Error('CSV_INVALID: the daemon sent no rows');
                return rows;
            });
        },

        edit(paneID, generation, ops) {
            return withState(
                paneID,
                commands.csvEdit(
                    { paneID, generation, ops: ops as unknown as readonly JsonObject[] },
                    { timeoutMs: CSV_EDIT_TIMEOUT_MS }
                )
            );
        },

        sort(paneID, column, direction) {
            return withState(paneID, commands.csvSort({ paneID, column, direction }, { timeoutMs: CSV_SLOW_COMMAND_TIMEOUT_MS }));
        },

        find(paneID, query) {
            return unwrap(commands.csvFind({ paneID, query }, { timeoutMs: CSV_SLOW_COMMAND_TIMEOUT_MS })).then((reply) => {
                const find = parseCsvFindReply(reply['find']);
                if (find === null) throw new Error('CSV_INVALID: the daemon sent no find result');
                return find;
            });
        },

        findStep(paneID, query, direction, from) {
            return unwrap(
                commands.csvFindStep({ paneID, query, direction, from }, { timeoutMs: CSV_SLOW_COMMAND_TIMEOUT_MS })
            ).then((reply) => {
                const step = parseCsvFindStepReply(reply['step']);
                if (step === null) throw new Error('CSV_INVALID: the daemon sent no find step');
                return step;
            });
        },

        setHeaderRow(paneID, on) {
            return withState(paneID, commands.csvSetHeaderRow({ paneID, on }, { timeoutMs: CSV_SLOW_COMMAND_TIMEOUT_MS }));
        },

        discard(paneID) {
            return withState(paneID, commands.csvDiscard({ paneID }, { timeoutMs: CSV_SLOW_COMMAND_TIMEOUT_MS }));
        },

        notify(paneID, message) {
            const entry = entries.get(paneID);
            if (entry === undefined) return;
            for (const listener of [...entry.listeners]) listener.onNotice?.(message);
        },

        reportFailure(_paneID, message) {
            options.onError?.(message, 'edit');
        },

        connected() {
            if (connection.status === 'connected') return Promise.resolve();
            // Its own listener rather than the client's: a requeued edit owes the daemon even
            // after the pane (and a pane-owned client) has gone.
            return new Promise<void>((resolve) => {
                const off = connection.on('status', (status) => {
                    if (status !== 'connected') return;
                    off();
                    resolve();
                });
            });
        },

        listenerCount(paneID) {
            return entries.get(paneID)?.listeners.size ?? 0;
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            offMessage();
            offStatus();
            for (const entry of entries.values()) entry.listeners.clear();
            entries.clear();
        }
    };
    return client;
}

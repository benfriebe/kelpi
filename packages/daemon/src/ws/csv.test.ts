/**
 * The `csv-*` verbs on the sync channel (#324, docs/csv-pane.md): routing, payload validation
 * through the shared `@kelpi/protocol` validators, subscription bookkeeping and the quit flush.
 * The engine and the service have their own specs (`src/content/csv/*.test.ts`); this file
 * talks to a stub `CsvChannel`.
 */

import {
    CSV_COMMANDS,
    CSV_LIMITS,
    CSV_UPDATED_MESSAGE,
    WS_PROTOCOL_VERSION,
    isCsvCommand,
    type CsvEditOp,
    type CsvPaneState,
    type CsvRowsReply,
    type CsvRowsRequest
} from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import type { CsvChannel, CsvSubscription } from '../content/csv/channel.js';
import type { ControlDispatcher } from '../seams.js';
import { harness as storeHarness, seededState, W1 } from '../store/testing.js';
import { FLUSH_SAVES_REQUEST_MESSAGE, FLUSH_SAVES_RESULT_MESSAGE, createSyncHub, type ContentChannel } from './sync.js';
import { PANE_A, PANE_B, recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };

function stateFor(paneID: string, overrides: Partial<CsvPaneState> = {}): CsvPaneState {
    return {
        paneID,
        incarnation: 'inc',
        revision: 1,
        generation: 'inc:0',
        filePath: '/data/a.csv',
        loaded: true,
        scanning: null,
        rowCount: 3,
        columns: [0, 1],
        bytes: 12,
        dialect: { delimiter: ',', lineEnding: '\n', bom: false, quoteAll: false },
        headerRow: true,
        sort: null,
        dirty: false,
        saving: false,
        canUndo: false,
        canRedo: false,
        rawEditable: true,
        readOnly: null,
        error: null,
        notice: null,
        ...overrides
    };
}

interface StubCsv extends CsvChannel {
    readonly calls: unknown[][];
    readonly listeners: Map<string, (state: CsvPaneState) => void>;
    readonly unsubscribes: string[];
    push(paneID: string, state?: CsvPaneState): void;
    fail: Error | null;
    flushFail: Error | null;
}

function stubCsv(): StubCsv {
    const calls: unknown[][] = [];
    const listeners = new Map<string, (state: CsvPaneState) => void>();
    const unsubscribes: string[] = [];
    const guard = (): void => {
        if (stub.fail !== null) throw stub.fail;
    };
    const stub: StubCsv = {
        calls,
        listeners,
        unsubscribes,
        fail: null,
        flushFail: null,
        push(paneID, state) {
            listeners.get(paneID)?.(state ?? stateFor(paneID, { revision: 2 }));
        },
        async subscribe(paneID, listener): Promise<CsvSubscription> {
            calls.push(['subscribe', paneID]);
            guard();
            listeners.set(paneID, listener);
            return {
                state: stateFor(paneID),
                unsubscribe: () => {
                    unsubscribes.push(paneID);
                    listeners.delete(paneID);
                }
            };
        },
        async state(paneID) {
            calls.push(['state', paneID]);
            guard();
            return stateFor(paneID);
        },
        async rows(paneID, request: CsvRowsRequest, budget?: number): Promise<CsvRowsReply> {
            calls.push(['rows', paneID, request, budget]);
            guard();
            return { generation: 'inc:0', revision: 1, start: request.start, columnStart: request.columnStart ?? 0, columnIDs: [0, 1], rows: [], nextStart: null };
        },
        async edit(paneID, generation, ops: readonly CsvEditOp[]) {
            calls.push(['edit', paneID, generation, ops]);
            guard();
            return stateFor(paneID, { dirty: true });
        },
        async sort(paneID, column, direction) {
            calls.push(['sort', paneID, column, direction]);
            guard();
            return stateFor(paneID, column === null ? {} : { sort: { column, direction, pending: false } });
        },
        async find(paneID, query) {
            calls.push(['find', paneID, query]);
            guard();
            return { query, total: 2, complete: true, truncated: false };
        },
        async findStep(paneID, query, direction, from) {
            calls.push(['findStep', paneID, query, direction, from]);
            guard();
            return { query, match: { view: 1, row: 1, column: 0 }, index: 1, total: 2, complete: true, truncated: false };
        },
        async setHeaderRow(paneID, on) {
            calls.push(['setHeaderRow', paneID, on]);
            guard();
            return stateFor(paneID, { headerRow: on });
        },
        async discard(paneID) {
            calls.push(['discard', paneID]);
            guard();
            return stateFor(paneID);
        },
        async prepareRaw() {
            return { realpath: '/dev/null', dev: 0, ino: 0 };
        },
        async afterRaw() {},
        flushSync() {},
        flushForQuit() {
            calls.push(['flushForQuit']);
            if (stub.flushFail !== null) throw stub.flushFail;
        },
        prepareClose() {},
        async dispose() {}
    };
    return stub;
}

function hello(): string {
    return JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token: 'tok', client: { kind: 'browser' } });
}

function fixture(input: CsvChannel | null = stubCsv(), content?: ContentChannel): {
    connect(): { session: ReturnType<ReturnType<typeof createSyncHub>['createSession']>; transport: RecordedTransport };
} {
    const store = storeHarness(seededState(W1, PANE_A));
    const dispatcher: ControlDispatcher = (_message, reply) => {
        reply?.send({ ok: true });
        reply?.close();
    };
    const hub = createSyncHub({
        store: store.store,
        dispatcher,
        daemon: DAEMON,
        ...(input !== null ? { csv: input } : {}),
        ...(content !== undefined ? { content } : {})
    });
    return {
        connect() {
            const transport = recordingTransport();
            const session = hub.createSession(transport);
            session.handleMessage(hello());
            return { session, transport };
        }
    };
}

function send(session: { handleMessage(raw: string): void }, id: string, payload: Record<string, unknown>): void {
    session.handleMessage(JSON.stringify({ type: 'command', id, payload }));
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function replyBody(transport: RecordedTransport, id: string): Record<string, unknown> {
    const message = transport.ofType('command-reply').find((entry) => entry['id'] === id);
    return (message?.['reply'] ?? {}) as Record<string, unknown>;
}

describe('csv commands', () => {
    it('are matched by the protocol list', () => {
        for (const command of CSV_COMMANDS) expect(isCsvCommand(command)).toBe(true);
        expect(isCsvCommand('content-subscribe')).toBe(false);
    });

    it('routes every verb with snake_case fields and documented reply keys', async () => {
        const csv = stubCsv();
        const { session, transport } = fixture(csv).connect();
        const ops = [{ op: 'set-cell', row: 1, column: 0, value: 'x' }];

        send(session, 'r1', { command: 'csv-rows', pane_id: PANE_A, start: 10, count: 50, column_start: 2, column_count: 4 });
        send(session, 'r2', { command: 'csv-edit', pane_id: PANE_A, generation: 'inc:0', ops });
        send(session, 'r3', { command: 'csv-sort', pane_id: PANE_A, column: 1, direction: 'desc' });
        send(session, 'r4', { command: 'csv-sort', pane_id: PANE_A, column: null });
        send(session, 'r5', { command: 'csv-find', pane_id: PANE_A, query: 'abc' });
        send(session, 'r6', { command: 'csv-find-step', pane_id: PANE_A, query: 'abc', direction: 'previous', from: { view: 3, column: 1 } });
        send(session, 'r7', { command: 'csv-set-header-row', pane_id: PANE_A, on: false });
        send(session, 'r8', { command: 'csv-discard', pane_id: PANE_A });
        await settle();

        expect(csv.calls).toEqual([
            ['rows', PANE_A, { start: 10, count: 50, columnStart: 2, columnCount: 4 }, undefined],
            ['edit', PANE_A, 'inc:0', ops],
            ['sort', PANE_A, 1, 'desc'],
            ['sort', PANE_A, null, 'asc'],
            ['find', PANE_A, 'abc'],
            ['findStep', PANE_A, 'abc', 'previous', { view: 3, column: 1 }],
            ['setHeaderRow', PANE_A, false],
            ['discard', PANE_A]
        ]);
        const rows = replyBody(transport, 'r1');
        expect(rows['ok']).toBe(true);
        expect(rows['pane_id']).toBe(PANE_A);
        expect((rows['rows'] as CsvRowsReply).start).toBe(10);
        expect((replyBody(transport, 'r2')['state'] as CsvPaneState).dirty).toBe(true);
        expect((replyBody(transport, 'r3')['state'] as CsvPaneState).sort).toEqual({ column: 1, direction: 'desc', pending: false });
        expect(replyBody(transport, 'r5')['find']).toEqual({ query: 'abc', total: 2, complete: true, truncated: false });
        expect((replyBody(transport, 'r6')['step'] as { index: number }).index).toBe(1);
        expect((replyBody(transport, 'r7')['state'] as CsvPaneState).headerRow).toBe(false);
        expect(replyBody(transport, 'r8')['ok']).toBe(true);
    });

    it('rejects malformed payloads with the shared validator errors before reaching the service', async () => {
        const csv = stubCsv();
        const { session, transport } = fixture(csv).connect();

        send(session, 'e1', { command: 'csv-subscribe' });
        send(session, 'e2', { command: 'csv-edit', pane_id: PANE_A, ops: [{ op: 'undo' }] });
        send(session, 'e3', { command: 'csv-edit', pane_id: PANE_A, generation: '', ops: [{ op: 'undo' }] });
        send(session, 'e4', { command: 'csv-edit', pane_id: PANE_A, generation: 'g', ops: [{ op: 'explode' }] });
        send(session, 'e5', { command: 'csv-edit', pane_id: PANE_A, generation: 'g', ops: [] });
        send(session, 'e6', { command: 'csv-rows', pane_id: PANE_A, start: 0, count: CSV_LIMITS.maxRowsPerRequest + 1 });
        send(session, 'e7', { command: 'csv-rows', pane_id: PANE_A, start: 0, count: 10, column_count: CSV_LIMITS.maxColumnsPerRequest + 1 });
        send(session, 'e8', { command: 'csv-sort', pane_id: PANE_A, column: 0, direction: 'sideways' });
        send(session, 'e9', { command: 'csv-sort', pane_id: PANE_A, column: -1 });
        send(session, 'e10', { command: 'csv-find', pane_id: PANE_A, query: 'x'.repeat(CSV_LIMITS.maxFindQueryBytes + 1) });
        send(session, 'e11', { command: 'csv-find', pane_id: PANE_A });
        send(session, 'e12', { command: 'csv-find-step', pane_id: PANE_A, query: 'a', direction: 'up' });
        send(session, 'e13', { command: 'csv-set-header-row', pane_id: PANE_A, on: 'yes' });
        send(session, 'e14', {
            command: 'csv-edit',
            pane_id: PANE_A,
            generation: 'g',
            ops: Array.from({ length: CSV_LIMITS.maxOpsPerBatch + 1 }, () => ({ op: 'undo' }))
        });
        await settle();

        expect(replyBody(transport, 'e1')).toEqual({ ok: false, error: 'csv-subscribe requires pane_id' });
        expect(replyBody(transport, 'e2')).toEqual({ ok: false, error: 'CSV_INVALID: csv-edit requires generation' });
        expect(replyBody(transport, 'e3')['error']).toBe('CSV_INVALID: csv-edit requires generation');
        expect(replyBody(transport, 'e13')).toEqual({ ok: false, error: 'CSV_INVALID: csv-set-header-row requires on' });
        for (const id of ['e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12', 'e14']) {
            const reply = replyBody(transport, id);
            expect(reply['ok'], id).toBe(false);
            expect(String(reply['error']), id).toMatch(/^CSV_INVALID: /);
        }
        expect(csv.calls).toEqual([]);
    });

    it('turns a service rejection into {ok:false,error} with the code intact', async () => {
        const csv = stubCsv();
        csv.fail = new Error('CSV_STALE: the edit is from an older generation');
        const { session, transport } = fixture(csv).connect();
        send(session, 'e1', { command: 'csv-edit', pane_id: PANE_A, generation: 'old:1', ops: [{ op: 'redo' }] });
        send(session, 'e2', { command: 'csv-subscribe', pane_id: PANE_A });
        await settle();
        expect(replyBody(transport, 'e1')).toEqual({ ok: false, error: 'CSV_STALE: the edit is from an older generation' });
        expect(replyBody(transport, 'e2')['ok']).toBe(false);
    });

    it('answers honestly when the daemon has no csv service', async () => {
        const { session, transport } = fixture(null).connect();
        send(session, 'e1', { command: 'csv-subscribe', pane_id: PANE_A });
        await settle();
        expect(replyBody(transport, 'e1')).toEqual({ ok: false, error: 'csv panes are not available' });
    });
});

describe('csv subscriptions', () => {
    it('answers csv-subscribe with the state and pushes csv-updated only to the subscriber', async () => {
        const csv = stubCsv();
        const f = fixture(csv);
        const a = f.connect();
        const b = f.connect();

        send(a.session, 'r1', { command: 'csv-subscribe', pane_id: PANE_A });
        await settle();
        const reply = replyBody(a.transport, 'r1');
        expect(reply['ok']).toBe(true);
        expect(reply['pane_id']).toBe(PANE_A);
        expect((reply['state'] as CsvPaneState).generation).toBe('inc:0');

        csv.push(PANE_A);
        const updates = a.transport.ofType(CSV_UPDATED_MESSAGE);
        expect(updates).toHaveLength(1);
        expect(updates[0]?.['paneID']).toBe(PANE_A);
        expect((updates[0]?.['state'] as CsvPaneState).revision).toBe(2);
        expect(b.transport.ofType(CSV_UPDATED_MESSAGE)).toHaveLength(0);
    });

    it('csv-unsubscribe releases the subscription and stops pushes', async () => {
        const csv = stubCsv();
        const { session, transport } = fixture(csv).connect();
        send(session, 'r1', { command: 'csv-subscribe', pane_id: PANE_A });
        await settle();
        send(session, 'r2', { command: 'csv-unsubscribe', pane_id: PANE_A });
        await settle();
        expect(replyBody(transport, 'r2')).toEqual({ ok: true, pane_id: PANE_A });
        expect(csv.unsubscribes).toEqual([PANE_A]);
        csv.push(PANE_A);
        expect(transport.ofType(CSV_UPDATED_MESSAGE)).toHaveLength(0);
    });

    it('re-subscribing replaces the previous handle', async () => {
        const csv = stubCsv();
        const { session, transport } = fixture(csv).connect();
        send(session, 'r1', { command: 'csv-subscribe', pane_id: PANE_A });
        await settle();
        send(session, 'r2', { command: 'csv-subscribe', pane_id: PANE_A });
        await settle();
        expect(csv.unsubscribes).toEqual([PANE_A]);
        csv.push(PANE_A);
        expect(transport.ofType(CSV_UPDATED_MESSAGE)).toHaveLength(1);
    });

    it('voids an in-flight subscribe that is unsubscribed before it resolves', async () => {
        const csv = stubCsv();
        let release: (() => void) | undefined;
        let unsubscribed = 0;
        const slow: CsvChannel = {
            ...csv,
            async subscribe(paneID) {
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                return { state: stateFor(paneID), unsubscribe: () => { unsubscribed += 1; } };
            }
        };
        const { session, transport } = fixture(slow).connect();
        send(session, 'r1', { command: 'csv-subscribe', pane_id: PANE_A });
        await settle();
        send(session, 'r2', { command: 'csv-unsubscribe', pane_id: PANE_A });
        release?.();
        await settle();
        await settle();
        expect(unsubscribed).toBe(1);
        expect(replyBody(transport, 'r1')).toEqual({ ok: false, error: 'subscription was cancelled' });
        expect(replyBody(transport, 'r2')['ok']).toBe(true);
    });

    it('drops every csv subscription when the connection closes', async () => {
        const csv = stubCsv();
        const { session } = fixture(csv).connect();
        send(session, 'r1', { command: 'csv-subscribe', pane_id: PANE_A });
        send(session, 'r2', { command: 'csv-subscribe', pane_id: PANE_B });
        await settle();
        session.close();
        expect([...csv.unsubscribes].sort()).toEqual([PANE_A, PANE_B].sort());
    });

    it('a subscribe that resolves after the socket closed is released', async () => {
        const csv = stubCsv();
        let release: (() => void) | undefined;
        let unsubscribed = 0;
        const slow: CsvChannel = {
            ...csv,
            async subscribe(paneID) {
                await new Promise<void>((resolve) => { release = resolve; });
                return { state: stateFor(paneID), unsubscribe: () => { unsubscribed += 1; } };
            }
        };
        const { session } = fixture(slow).connect();
        send(session, 'r1', { command: 'csv-subscribe', pane_id: PANE_A });
        await settle();
        session.close();
        release?.();
        await settle();
        await settle();
        expect(unsubscribed).toBe(1);
    });
});

describe('flush-saves-request', () => {
    it('also flushes csv documents for quit and still answers ok', async () => {
        const csv = stubCsv();
        const { session, transport } = fixture(csv).connect();
        session.handleMessage(JSON.stringify({ type: FLUSH_SAVES_REQUEST_MESSAGE, id: 'q1' }));
        await settle();
        expect(csv.calls).toEqual([['flushForQuit']]);
        expect(transport.ofType(FLUSH_SAVES_RESULT_MESSAGE)).toEqual([{ type: FLUSH_SAVES_RESULT_MESSAGE, ok: true, id: 'q1' }]);
    });

    it('a csv flush failure answers ok:false but still runs the content flush', async () => {
        const csv = stubCsv();
        csv.flushFail = new Error('disk full');
        let contentFlushed = 0;
        const content = { flushSync: () => { contentFlushed += 1; } } as unknown as ContentChannel;
        const { session, transport } = fixture(csv, content).connect();
        session.handleMessage(JSON.stringify({ type: FLUSH_SAVES_REQUEST_MESSAGE, id: 'q2' }));
        await settle();
        expect(contentFlushed).toBe(1);
        expect(transport.ofType(FLUSH_SAVES_RESULT_MESSAGE)).toEqual([{ type: FLUSH_SAVES_RESULT_MESSAGE, ok: false, id: 'q2' }]);
    });
});

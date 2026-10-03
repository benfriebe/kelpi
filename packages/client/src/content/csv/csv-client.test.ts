import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandClient, CommandDisconnectedError, CommandTimeoutError } from '../../connection/commands';
import { KelpiConnection } from '../../connection/socket';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from '../../connection/testing';
import { createCsvClient, type CsvClient } from './csv-client';
import { CSV_EDIT_MAX_ATTEMPTS, CSV_MAX_IN_FLIGHT, CSV_ROW_BLOCK, createCsvPaneModel, flushCsvPane, type CsvPaneModel } from './csv-model';
import { createFakeCsvApi, csvState, type FakeCsvApi } from './testing';
import type { CsvPaneState } from './types';

const PANE = 'DDDDDDDD-0000-4000-8000-0000000000C5';

// ── the transport ──────────────────────────────────────────────────────────────────────

interface Harness {
    readonly client: CsvClient;
    readonly connection: KelpiConnection;
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    frames(): Record<string, unknown>[];
    answer(command: string, reply: Record<string, unknown>): void;
    redial(): void;
}

function harness(): Harness {
    const sockets = createFakeSocketFactory();
    const connection = new KelpiConnection({
        url: 'ws://daemon.test/ws',
        token: 't',
        socketFactory: sockets.factory,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 },
        heartbeatIntervalMs: 0
    });
    let counter = 0;
    const commands = new CommandClient(connection, { newID: () => `id-${++counter}`, timeoutMs: 1000 });
    connection.connect();
    completeHandshake(sockets.last());
    const client = createCsvClient({ connection, commands });
    const frames = (): Record<string, unknown>[] => sockets.last().messages().filter((message) => message['type'] === 'command');
    return {
        client,
        connection,
        socket: () => sockets.last(),
        frames,
        commands: () => frames().map((frame) => frame['payload'] as Record<string, unknown>),
        answer(command, reply) {
            const frame = [...frames()].reverse().find((entry) => (entry['payload'] as Record<string, unknown>)['command'] === command);
            if (frame === undefined) throw new Error(`no ${command} was sent`);
            sockets.last().emit({ type: 'command-reply', id: frame['id'] as string, reply });
        },
        redial() {
            sockets.last().serverClose();
            vi.advanceTimersByTime(10);
            completeHandshake(sockets.last());
        }
    };
}

const flush = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) await Promise.resolve();
};

describe('CsvClient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('shares one wire subscription between two views, and releases it with the last', async () => {
        const h = harness();
        const states: CsvPaneState[] = [];
        const first = h.client.subscribe(PANE, { onState: (state) => states.push(state) });
        const second = h.client.subscribe(PANE, { onState: () => undefined });
        expect(h.commands().filter((payload) => payload['command'] === 'csv-subscribe')).toEqual([{ command: 'csv-subscribe', pane_id: PANE }]);
        h.answer('csv-subscribe', { ok: true, pane_id: PANE, state: csvState({ paneID: PANE, revision: 3 }) });
        await flush();
        expect(states.map((state) => state.revision)).toEqual([3]);
        expect(h.client.peek(PANE)?.revision).toBe(3);

        first.unsubscribe();
        expect(h.commands().some((payload) => payload['command'] === 'csv-unsubscribe')).toBe(false);
        second.unsubscribe();
        expect(h.commands().filter((payload) => payload['command'] === 'csv-unsubscribe')).toEqual([{ command: 'csv-unsubscribe', pane_id: PANE }]);
    });

    it('routes `csv-updated` to the pane’s listeners and drops an older revision of the same incarnation', async () => {
        const h = harness();
        const states: CsvPaneState[] = [];
        h.client.subscribe(PANE, { onState: (state) => states.push(state) });
        h.socket().emit({ type: 'csv-updated', paneID: PANE, state: csvState({ paneID: PANE, revision: 5 }) });
        h.socket().emit({ type: 'csv-updated', paneID: PANE, state: csvState({ paneID: PANE, revision: 4 }) });
        // A reload or a restarted daemon is a new incarnation and wins whatever its revision.
        h.socket().emit({ type: 'csv-updated', paneID: PANE, state: csvState({ paneID: PANE, incarnation: 'inc-2', revision: 1 }) });
        // Another pane's push, and a malformed one, reach nobody.
        h.socket().emit({ type: 'csv-updated', paneID: 'other', state: csvState({ paneID: 'other', revision: 9 }) });
        h.socket().emit({ type: 'csv-updated', paneID: PANE, state: { paneID: PANE } });
        await flush();
        expect(states.map((state) => `${state.incarnation}#${state.revision}`)).toEqual(['inc-1#5', 'inc-2#1']);
    });

    it('does not report the daemon cancelling a subscribe that a remount superseded', async () => {
        const errors: string[] = [];
        const h = harness();
        const client = createCsvClient({ connection: h.connection, commands: new CommandClient(h.connection, { timeoutMs: 1000 }), onError: (message) => errors.push(message) });
        const first = client.subscribe(PANE, { onState: () => undefined });
        first.unsubscribe();
        const listenerErrors: string[] = [];
        client.subscribe(PANE, { onState: () => undefined, onError: (message) => listenerErrors.push(message) });
        const subscribes = h.frames().filter((frame) => (frame['payload'] as Record<string, unknown>)['command'] === 'csv-subscribe');
        expect(subscribes).toHaveLength(2);
        h.socket().emit({ type: 'command-reply', id: subscribes[0]!['id'] as string, reply: { ok: false, error: 'subscription was cancelled' } });
        await flush();
        expect(errors).toEqual([]);
        expect(listenerErrors).toEqual([]);
    });

    it('re-subscribes the panes still on screen after a reconnect', async () => {
        const h = harness();
        h.client.subscribe(PANE, { onState: () => undefined });
        h.redial();
        await flush();
        const subscribes = h.socket().messages().filter((message) => message['type'] === 'command' && (message['payload'] as Record<string, unknown>)['command'] === 'csv-subscribe');
        expect(subscribes).toHaveLength(1);
    });

    it('speaks the wire’s snake_case for every verb', async () => {
        const h = harness();
        void h.client.rows(PANE, { start: 100, count: 50, columnStart: 64, columnCount: 32 }).catch(() => undefined);
        void h.client.edit(PANE, 'inc-1:2', [{ op: 'set-cell', row: 7, column: 3, value: 'x' }]).catch(() => undefined);
        void h.client.sort(PANE, null, 'asc').catch(() => undefined);
        void h.client.find(PANE, 'needle').catch(() => undefined);
        void h.client.findStep(PANE, 'needle', 'previous', { view: 4, column: 2 }).catch(() => undefined);
        void h.client.setHeaderRow(PANE, false).catch(() => undefined);
        void h.client.discard(PANE).catch(() => undefined);
        expect(h.commands()).toEqual([
            { command: 'csv-rows', pane_id: PANE, start: 100, count: 50, column_start: 64, column_count: 32 },
            { command: 'csv-edit', pane_id: PANE, generation: 'inc-1:2', ops: [{ op: 'set-cell', row: 7, column: 3, value: 'x' }] },
            // `column: null` clears the sort, so it is sent, not omitted.
            { command: 'csv-sort', pane_id: PANE, column: null, direction: 'asc' },
            { command: 'csv-find', pane_id: PANE, query: 'needle' },
            { command: 'csv-find-step', pane_id: PANE, query: 'needle', direction: 'previous', from: { view: 4, column: 2 } },
            { command: 'csv-set-header-row', pane_id: PANE, on: false },
            { command: 'csv-discard', pane_id: PANE }
        ]);
        await flush();
    });

    it('rejects with the daemon’s message, so the model can read its code', async () => {
        const h = harness();
        const edit = h.client.edit(PANE, 'inc-1:0', [{ op: 'undo' }]);
        h.answer('csv-edit', { ok: false, error: 'CSV_STALE: generation inc-0:4 is too old' });
        await expect(edit).rejects.toThrow('CSV_STALE: generation inc-0:4 is too old');
    });

    it('delivers a verb’s reply state to the pane’s listeners and decodes its rows', async () => {
        const h = harness();
        const states: CsvPaneState[] = [];
        h.client.subscribe(PANE, { onState: (state) => states.push(state) });
        const sorted = h.client.sort(PANE, 2, 'desc');
        h.answer('csv-sort', { ok: true, pane_id: PANE, state: csvState({ paneID: PANE, revision: 8, sort: { column: 2, direction: 'desc', pending: false } }) });
        await expect(sorted).resolves.toMatchObject({ revision: 8 });
        expect(states.at(-1)?.sort).toEqual({ column: 2, direction: 'desc', pending: false });

        const rows = h.client.rows(PANE, { start: 0, count: 1 });
        h.answer('csv-rows', {
            ok: true,
            pane_id: PANE,
            rows: { generation: 'inc-1:0', revision: 8, start: 0, columnStart: 0, columnIDs: [0, 1], rows: [{ view: 0, row: 3, cells: ['a', 'b'], fieldCount: 2 }], nextStart: null }
        });
        await expect(rows).resolves.toMatchObject({ rows: [{ view: 0, row: 3, cells: ['a', 'b'] }] });
    });

    it('says when the connection is up, at once or after a reconnect', async () => {
        const h = harness();
        await expect(h.client.connected()).resolves.toBeUndefined();
        h.socket().serverClose();
        let up = false;
        void h.client.connected().then(() => {
            up = true;
        });
        await flush();
        expect(up).toBe(false);
        vi.advanceTimersByTime(10);
        completeHandshake(h.socket());
        await flush();
        expect(up).toBe(true);
    });

    it('hands a failure with no grid left to show it to the window’s error report', () => {
        const errors: [string, string][] = [];
        const h = harness();
        const client = createCsvClient({ connection: h.connection, commands: new CommandClient(h.connection), onError: (message, context) => errors.push([message, context]) });
        client.reportFailure(PANE, 'An edit made in the table was not saved. This pane is showing raw text.');
        expect(errors).toEqual([['An edit made in the table was not saved. This pane is showing raw text.', 'edit']]);
    });

    it('sends a cell batch again on the new socket when the old one dropped before it was answered', async () => {
        const h = harness();
        const model = createCsvPaneModel(h.client, PANE);
        h.answer('csv-subscribe', { ok: true, pane_id: PANE, state: csvState({ paneID: PANE, rowCount: 3, columns: [0] }) });
        await flush();
        const ops = [{ op: 'set-cell', row: 1, column: 0, value: 'x' }];
        model.setCells([{ row: 1, column: 0, value: 'x' }], 'inc-1:0');
        expect(h.commands().filter((payload) => payload['command'] === 'csv-edit')).toHaveLength(1);
        // The frame died with the socket: no reply will ever come for it.
        h.socket().serverClose();
        await flush();
        expect(model.pendingEdits()).toBe(1);
        expect(model.notice()).toBeNull();
        vi.advanceTimersByTime(10);
        completeHandshake(h.socket());
        await flush();
        expect(h.commands().filter((payload) => payload['command'] === 'csv-edit')).toEqual([{ command: 'csv-edit', pane_id: PANE, generation: 'inc-1:0', ops }]);
        h.answer('csv-edit', { ok: true, pane_id: PANE, state: csvState({ paneID: PANE, revision: 2, rowCount: 3, columns: [0] }) });
        await flush();
        expect(model.pendingEdits()).toBe(0);
        model.dispose();
    });

    it('hands a local notice to the pane’s listeners without a command', () => {
        const h = harness();
        const notices: string[] = [];
        h.client.subscribe(PANE, { onState: () => undefined, onNotice: (message) => notices.push(message) });
        const before = h.commands().length;
        h.client.notify(PANE, 'Raw text (⌘E) is only available for files up to 2 MiB');
        expect(notices).toEqual(['Raw text (⌘E) is only available for files up to 2 MiB']);
        expect(h.commands()).toHaveLength(before);
    });
});

// ── the pane model ─────────────────────────────────────────────────────────────────────

function table(rows: number, columns = 3): string[][] {
    const out: string[][] = [Array.from({ length: columns }, (_unused, index) => `h${index}`)];
    for (let row = 1; row < rows; row++) out.push(Array.from({ length: columns }, (_unused, index) => `r${row}c${index}`));
    return out;
}

async function ready(api: FakeCsvApi): Promise<CsvPaneModel> {
    const model = createCsvPaneModel(api, PANE);
    await api.settle();
    return model;
}

describe('the csv pane model', () => {
    let model: CsvPaneModel | null = null;
    afterEach(() => {
        model?.dispose();
        model = null;
    });

    it('fetches the visible window once, and serves a scroll inside it from the cache', async () => {
        const api = createFakeCsvApi(table(1000));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 40, colStart: 0, colEnd: 3 });
        await api.settle();
        expect(api.rowRequests).toEqual([{ paneID: PANE, start: 0, count: CSV_ROW_BLOCK, columnStart: 0, columnCount: 3 }]);
        expect(model.cell(5, 1)).toMatchObject({ value: 'r5c1', row: 5, column: 1, loaded: true });
        model.setViewport({ rowStart: 20, rowEnd: 60, colStart: 0, colEnd: 3 });
        await api.settle();
        expect(api.rowRequests).toHaveLength(1);
    });

    it('keeps at most two fetches in flight, and drops blocks the viewport left before asking', async () => {
        const api = createFakeCsvApi(table(5000));
        model = await ready(api);
        api.holdRows = true;
        model.setViewport({ rowStart: 0, rowEnd: 500, colStart: 0, colEnd: 3 });
        expect(api.rowRequests).toHaveLength(CSV_MAX_IN_FLIGHT);
        // The person scrolled on: the blocks 200-499 are no longer wanted.
        model.setViewport({ rowStart: 4000, rowEnd: 4050, colStart: 0, colEnd: 3 });
        expect(api.rowRequests).toHaveLength(CSV_MAX_IN_FLIGHT);
        await api.releaseRows();
        await api.releaseRows();
        expect(api.rowRequests.map((request) => request.start)).toEqual([0, 100, 4000]);
    });

    it('honours `nextStart` when the daemon cuts a reply short', async () => {
        const api = createFakeCsvApi(table(300));
        api.maxRowsPerReply = 30;
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 3 });
        for (let index = 0; index < 6; index++) await api.settle();
        expect(api.rowRequests.map((request) => [request.start, request.count])).toEqual([
            [0, 100],
            [30, 70],
            [60, 40],
            [90, 10]
        ]);
        expect(model.cell(95, 0).value).toBe('r95c0');
    });

    it('refetches only the visible window when the revision moves', async () => {
        const api = createFakeCsvApi(table(5000));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 40, colStart: 0, colEnd: 3 });
        await api.settle();
        model.setViewport({ rowStart: 3000, rowEnd: 3040, colStart: 0, colEnd: 3 });
        await api.settle();
        expect(api.rowRequests.map((request) => request.start)).toEqual([0, 3000]);
        api.table[3001]![0] = 'changed elsewhere';
        api.touch();
        api.push(PANE);
        await api.settle();
        expect(api.rowRequests.map((request) => request.start)).toEqual([0, 3000, 3000]);
        expect(model.cell(3001, 0).value).toBe('changed elsewhere');
        // The block that was off screen was dropped, not refetched: going back asks again.
        model.setViewport({ rowStart: 0, rowEnd: 40, colStart: 0, colEnd: 3 });
        await api.settle();
        expect(api.rowRequests.map((request) => request.start)).toEqual([0, 3000, 3000, 0]);
    });

    it('does not refetch rows a scan has already served, only the short tail', async () => {
        const api = createFakeCsvApi(table(150));
        api.overrides = { scanning: { rows: 150, bytes: 10, totalBytes: 100 } };
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 300, colStart: 0, colEnd: 3 });
        await api.settle();
        await api.settle();
        expect(api.rowRequests.map((request) => [request.start, request.count])).toEqual([[0, 100], [100, 50]]);
        // The scan finds 100 more rows.
        for (let row = 150; row < 250; row++) api.table.push(['x', 'y', 'z']);
        api.touch();
        api.overrides = { scanning: { rows: 250, bytes: 20, totalBytes: 100 } };
        api.push(PANE);
        await api.settle();
        await api.settle();
        expect(api.rowRequests.map((request) => [request.start, request.count])).toEqual([[0, 100], [100, 50], [150, 50], [200, 50]]);
    });

    it('shows an edit at once and keeps showing it until a fetch at the acked revision lands', async () => {
        const api = createFakeCsvApi(table(50));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 40, colStart: 0, colEnd: 3 });
        await api.settle();
        api.holdEdits = true;
        model.setCells([{ row: 3, column: 1, value: 'typed' }], 'inc-1:0');
        expect(model.cell(3, 1)).toMatchObject({ value: 'typed', pending: true });
        expect(api.edits).toEqual([{ paneID: PANE, generation: 'inc-1:0', ops: [{ op: 'set-cell', row: 3, column: 1, value: 'typed' }] }]);
        api.held[0]!.resolve();
        await api.settle();
        await api.settle();
        expect(model.cell(3, 1)).toMatchObject({ value: 'typed', pending: false });
        expect(api.table[3]![1]).toBe('typed');
    });

    it('sends one batch at a time, in order, each with the generation it was made against', async () => {
        const api = createFakeCsvApi(table(50));
        model = await ready(api);
        api.holdEdits = true;
        model.setCells([{ row: 1, column: 0, value: 'a' }], 'inc-1:0');
        model.structural({ op: 'insert-rows', at: 2, count: 1 }, 'inc-1:0');
        model.setCells([{ row: 5, column: 0, value: 'b' }], 'inc-1:0');
        expect(api.edits).toHaveLength(1);
        expect(model.pendingEdits()).toBe(3);
        api.held[0]!.resolve();
        await api.settle();
        expect(api.edits).toHaveLength(2);
        expect(api.edits[1]).toMatchObject({ generation: 'inc-1:0', ops: [{ op: 'insert-rows', at: 2, count: 1 }] });
        api.held[1]!.resolve();
        await api.settle();
        expect(api.edits[2]).toMatchObject({ generation: 'inc-1:0', ops: [{ op: 'set-cell', row: 5, column: 0, value: 'b' }] });
    });

    it('splits a paste bigger than one batch, still one in flight', async () => {
        const api = createFakeCsvApi(table(2000));
        model = await ready(api);
        api.holdEdits = true;
        const edits = Array.from({ length: 1500 }, (_unused, index) => ({ row: index + 1, column: 0, value: `p${index}` }));
        model.setCells(edits, 'inc-1:0');
        expect(api.edits).toHaveLength(1);
        expect(api.edits[0]!.ops).toHaveLength(1000);
        api.held[0]!.resolve();
        await api.settle();
        expect(api.edits[1]!.ops).toHaveLength(500);
    });

    it('drops an edit whose row was deleted (CSV_GONE) and says so', async () => {
        const api = createFakeCsvApi(table(50));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 40, colStart: 0, colEnd: 3 });
        await api.settle();
        api.failNextEdit = 'CSV_GONE: The row or column this edit targets was deleted.';
        model.setCells([{ row: 3, column: 1, value: 'lost' }], 'inc-1:0');
        expect(model.cell(3, 1).value).toBe('lost');
        await api.settle();
        expect(model.cell(3, 1)).toMatchObject({ value: 'r3c1', pending: false });
        expect(model.notice()).toBe('The row or column this edit targets was deleted. The edit was dropped.');
    });

    it('drops a stale edit (CSV_STALE), says so and refetches the window', async () => {
        const api = createFakeCsvApi(table(50));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 40, colStart: 0, colEnd: 3 });
        await api.settle();
        const fetched = api.rowRequests.length;
        api.failNextEdit = 'CSV_STALE: The file was reloaded since these rows were read.';
        model.setCells([{ row: 3, column: 1, value: 'old' }], 'inc-0:1');
        await api.settle();
        await api.settle();
        expect(model.notice()).toBe('The file was reloaded since these rows were read. The edit was dropped.');
        expect(api.rowRequests.length).toBeGreaterThan(fetched);
        expect(model.cell(3, 1).pending).toBe(false);
    });

    it('refetches rows a scan already served when it finds a wider row (more columns)', async () => {
        const api = createFakeCsvApi(table(50, 2));
        api.overrides = { scanning: { rows: 50, bytes: 10, totalBytes: 100 } };
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 40, colStart: 0, colEnd: 3 });
        await api.settle();
        const fetched = api.rowRequests.length;
        api.columnIDs.push(2);
        for (const row of api.table) row.push('wide');
        api.touch();
        api.push(PANE);
        await api.settle();
        expect(api.rowRequests.length).toBeGreaterThan(fetched);
        expect(model.cell(3, 2).value).toBe('wide');
    });

    it('surfaces any other refusal in the daemon’s own words (CSV_BUSY, CSV_READ_ONLY)', async () => {
        const api = createFakeCsvApi(table(10));
        model = await ready(api);
        api.failNextEdit = 'CSV_READ_ONLY: This file is open as raw text in another pane.';
        model.setCells([{ row: 1, column: 0, value: 'x' }], 'inc-1:0');
        await api.settle();
        expect(model.notice()).toBe('This file is open as raw text in another pane.');
    });

    it('finds where a logical row went after the order changed', async () => {
        const api = createFakeCsvApi([['name'], ['c'], ['a'], ['b']]);
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 });
        await api.settle();
        expect(model.viewOfRow(2)).toBe(2);
        await model.sort(0, 'asc');
        await api.settle();
        await api.settle();
        // Row 2 ('a') is first under the pinned header now.
        expect(model.viewOfRow(2)).toBe(1);
        expect(model.rowAt(3)).toBe(1);
    });

    it('resolves logical rows for a paste beyond the cache', async () => {
        const api = createFakeCsvApi(table(3000));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 40, colStart: 0, colEnd: 3 });
        await api.settle();
        const { rows, generation } = await model.resolveRows(95, 700);
        expect(rows).toHaveLength(700);
        expect(rows[0]).toBe(95);
        expect(rows[699]).toBe(794);
        expect(generation).toBe('inc-1:0');
    });

    it('resolves a paste’s rows in ONE generation, re-reading the run when a structural edit lands between cache and daemon', async () => {
        const api = createFakeCsvApi(table(300));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 3 });
        await api.settle();
        // Another client deleted a row; its push has not arrived, so the cache is still inc-1:0.
        api.applySilently([{ op: 'delete-rows', start: 3, count: 1 }]);
        const before = api.rowRequests.length;
        const resolved = await model.resolveRows(10, 150);
        expect(resolved.generation).toBe('inc-1:1');
        expect(resolved.rows).toHaveLength(150);
        // Rows 10-99 were cached under inc-1:0 and 100+ came back under inc-1:1: the whole run
        // was read again from the daemon rather than sent half in each numbering.
        expect(api.rowRequests.slice(before).some((request) => request.start === 10)).toBe(true);

        api.holdEdits = true;
        await model.pasteRows(10, 150, (rows) => rows.map((row) => ({ row, column: 0, value: 'p' })));
        expect(api.edits[0]).toMatchObject({ generation: 'inc-1:1' });
        expect(api.edits[0]!.ops).toHaveLength(150);
    });

    it('never resolves a paste from rows of an older epoch still painted on screen', async () => {
        const api = createFakeCsvApi(table(50));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 40, colStart: 0, colEnd: 3 });
        await api.settle();
        api.holdRows = true;
        // A structural edit lands and is pushed: the visible block is refetched (held), and until
        // then it paints its old rows, which are numbered in the old generation.
        void api.edit(PANE, 'inc-1:0', [{ op: 'insert-rows', at: 1, count: 1 }]);
        await api.settle();
        const before = api.rowRequests.length;
        const pending = model.resolveRows(5, 2);
        await api.settle();
        expect(api.rowRequests.slice(before)).toContainEqual({ paneID: PANE, start: 5, count: 2, columnStart: 0, columnCount: 1 });
        await api.releaseRows();
        await expect(pending).resolves.toEqual({ rows: [5, 6], generation: 'inc-1:1' });
    });

    it('flushes: commits the cell being typed through the grid’s hook, then waits for every queued batch', async () => {
        // Its own pane: models other tests left draining under PANE would be waited for too.
        const pane = 'FLUSH-PANE';
        const api = createFakeCsvApi(table(50));
        const live = createCsvPaneModel(api, pane);
        model = live;
        await api.settle();
        api.holdEdits = true;
        live.setCells([{ row: 1, column: 0, value: 'a' }], 'inc-1:0');
        live.setCommitHook(() => live.setCells([{ row: 2, column: 0, value: 'typed' }], 'inc-1:0'));
        let done = false;
        void flushCsvPane(pane).then(() => {
            done = true;
        });
        expect(model.pendingEdits()).toBe(2);
        api.held[0]!.resolve();
        await api.settle();
        expect(api.edits.map((edit) => edit.ops)).toEqual([
            [{ op: 'set-cell', row: 1, column: 0, value: 'a' }],
            [{ op: 'set-cell', row: 2, column: 0, value: 'typed' }]
        ]);
        expect(done).toBe(false);
        api.held[1]!.resolve();
        await api.settle();
        expect(done).toBe(true);
    });

    it('flushes a paste that is still resolving its rows', async () => {
        const api = createFakeCsvApi(table(500));
        model = await ready(api);
        api.holdRows = true;
        void model.pasteRows(300, 2, (rows) => rows.map((row) => ({ row, column: 0, value: 'p' })));
        let done = false;
        void model.flush().then(() => {
            done = true;
        });
        await api.settle();
        expect(done).toBe(false);
        api.holdRows = false;
        await api.releaseRows();
        await api.settle();
        expect(api.table[300]![0]).toBe('p');
        expect(done).toBe(true);
    });

    it('reports a batch that fails after its grid has gone instead of dropping it', async () => {
        const api = createFakeCsvApi(table(10));
        model = await ready(api);
        api.holdEdits = true;
        model.setCells([{ row: 1, column: 0, value: 'late' }], 'inc-1:0');
        model.dispose();
        api.held[0]!.reject('CSV_READ_ONLY: This pane is showing raw text.');
        await api.settle();
        expect(api.failures).toEqual(['An edit made in the table was not saved. This pane is showing raw text.']);
    });

    it('sends a cell batch again once the connection is back when its answer was lost', async () => {
        const api = createFakeCsvApi(table(10));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 3 });
        await api.settle();
        api.online = false;
        api.failNextEdit = new CommandDisconnectedError('csv-edit');
        model.setCells([{ row: 1, column: 0, value: 'x' }], 'inc-1:0');
        await api.settle();
        // Not a refusal: still pending, still shown, and no notice.
        expect(api.edits).toHaveLength(1);
        expect(model.pendingEdits()).toBe(1);
        expect(model.cell(1, 0)).toMatchObject({ value: 'x', pending: true });
        expect(model.notice()).toBeNull();
        await api.goOnline();
        expect(api.edits).toHaveLength(2);
        expect(api.edits[1]).toEqual(api.edits[0]);
        expect(api.table[1]![0]).toBe('x');
        expect(model.pendingEdits()).toBe(0);
    });

    it('sends a timed-out cell batch again at once, and gives up after a few lost answers', async () => {
        const api = createFakeCsvApi(table(10));
        model = await ready(api);
        api.failNextEdit = new CommandTimeoutError('csv-edit', 60_000);
        model.setCells([{ row: 1, column: 0, value: 'x' }], 'inc-1:0');
        await api.settle();
        await api.settle();
        expect(api.edits).toHaveLength(2);
        expect(api.table[1]![0]).toBe('x');

        let sends = 0;
        api.edit = () => {
            sends++;
            return Promise.reject(new CommandTimeoutError('csv-edit', 60_000));
        };
        model.setCells([{ row: 2, column: 0, value: 'y' }], 'inc-1:1');
        for (let round = 0; round < 4; round++) await api.settle();
        expect(sends).toBe(CSV_EDIT_MAX_ATTEMPTS);
        expect(model.pendingEdits()).toBe(0);
        expect(model.notice()).toBe('The connection kept dropping before the table confirmed an edit, so it may not have been saved.');
    });

    it('does not resend a structural batch whose answer was lost: says so and refetches after reconnecting', async () => {
        const api = createFakeCsvApi(table(10));
        model = await ready(api);
        model.setViewport({ rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 3 });
        await api.settle();
        api.online = false;
        api.failNextEdit = new CommandDisconnectedError('csv-edit');
        model.structural({ op: 'insert-rows', at: 2, count: 1 }, 'inc-1:0');
        await api.settle();
        expect(model.notice()).toBe('The connection dropped before the table confirmed that change. Showing the table as it is now.');
        expect(model.pendingEdits()).toBe(0);
        const fetched = api.rowRequests.length;
        await api.goOnline();
        expect(api.edits).toHaveLength(1);
        expect(api.rowRequests.length).toBeGreaterThan(fetched);
    });

    it('keeps draining queued edits after the pane goes, without touching the UI', async () => {
        const api = createFakeCsvApi(table(50));
        model = await ready(api);
        api.holdEdits = true;
        model.setCells([{ row: 1, column: 0, value: 'a' }], 'inc-1:0');
        model.setCells([{ row: 2, column: 0, value: 'b' }], 'inc-1:0');
        model.dispose();
        api.held[0]!.resolve();
        await api.settle();
        expect(api.edits).toHaveLength(2);
        expect(api.listenerCount(PANE)).toBe(0);
    });
});

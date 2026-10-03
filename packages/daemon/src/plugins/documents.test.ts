/**
 * #324: the documents API's csv methods (`csv-state`, `csv-rows`, `csv-edit`, ...) through
 * `PluginDocuments` with a stub csv channel, and the CLI's `document` action reaching them
 * unchanged through `PluginService.request`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CSV_LIMITS, type CsvPaneState, type CsvRow, type CsvRowsReply, type CsvRowsRequest, type JsonObject } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CsvChannel } from '../content/csv/channel.js';
import type { ContentPaneState, ContentService } from '../content/service.js';
import { createStore } from '../store/store.js';
import { seededState } from '../store/testing.js';
import { PluginDocuments } from './documents.js';
import { PluginService } from './service.js';

const PANE = 'pane-1';

function csvState(overrides: Partial<CsvPaneState> = {}): CsvPaneState {
    return {
        paneID: PANE, incarnation: 'inc', revision: 1, generation: 'inc:0', filePath: '/a.csv', loaded: true, scanning: null,
        rowCount: 1000, columns: [0, 1], bytes: 10, dialect: { delimiter: ',', lineEnding: '\n', bom: false, quoteAll: false },
        headerRow: true, sort: null, dirty: false, saving: false, canUndo: false, canRedo: false, rawEditable: true,
        readOnly: null, error: null, notice: null, ...overrides
    };
}

interface Stub {
    csv: CsvChannel;
    readonly calls: unknown[][];
    listener: ((state: CsvPaneState) => void) | null;
    unsubscribed: number;
    /** Cells per row in `rows` replies. */
    cellsPerRow: number;
}

function stubCsv(): Stub {
    const stub: Stub = { csv: undefined as unknown as CsvChannel, calls: [], listener: null, unsubscribed: 0, cellsPerRow: 2 };
    const rows = (request: CsvRowsRequest): CsvRowsReply => {
        const out: CsvRow[] = [];
        for (let view = request.start; view < Math.min(request.start + request.count, 1000); view += 1) {
            out.push({ view, row: view, cells: Array.from({ length: stub.cellsPerRow }, () => ''), fieldCount: stub.cellsPerRow });
        }
        return { generation: 'inc:0', revision: 1, start: request.start, columnStart: 0, columnIDs: [0, 1], rows: out, nextStart: null };
    };
    stub.csv = {
        async subscribe(paneID, listener) {
            stub.calls.push(['subscribe', paneID]);
            stub.listener = listener;
            return { state: csvState(), unsubscribe: () => { stub.unsubscribed += 1; stub.listener = null; } };
        },
        async state(paneID) { stub.calls.push(['state', paneID]); return csvState(); },
        async rows(paneID, request, budget) { stub.calls.push(['rows', paneID, request, budget]); return rows(request); },
        async edit(paneID, generation, ops) { stub.calls.push(['edit', paneID, generation, ops]); return csvState({ dirty: true }); },
        async sort(paneID, column, direction) { stub.calls.push(['sort', paneID, column, direction]); return csvState(); },
        async find(paneID, query) { stub.calls.push(['find', paneID, query]); return { query, total: 1, complete: true, truncated: false }; },
        async findStep(paneID, query, direction, from) {
            stub.calls.push(['findStep', paneID, query, direction, from]);
            return { query, match: null, index: null, total: 0, complete: true, truncated: false };
        },
        async setHeaderRow(paneID, on) { stub.calls.push(['setHeaderRow', paneID, on]); return csvState({ headerRow: on }); },
        async discard(paneID) { stub.calls.push(['discard', paneID]); return csvState(); },
        async prepareRaw() {
            return { realpath: '/dev/null', dev: 0, ino: 0 };
        },
        async afterRaw() {},
        flushSync() {},
        flushForQuit() {},
        prepareClose() {},
        async dispose() {}
    };
    return stub;
}

function stubContent(type: ContentPaneState['type']): ContentService & { unsubscribed: number } {
    const content = {
        unsubscribed: 0,
        async subscribe(paneID: string) {
            return { state: { paneID, type } as ContentPaneState, unsubscribe: () => { content.unsubscribed += 1; } };
        },
        async document(paneID: string) {
            return { paneID, workspaceID: 'w', kind: type, mode: 'view', path: '/a', text: '', loaded: true, dirty: false, error: null, revision: 'r:1' };
        }
    };
    return content as unknown as ContentService & { unsubscribed: number };
}

describe('PluginDocuments csv methods', () => {
    it('routes every method with camelCase arguments', async () => {
        const stub = stubCsv();
        const documents = new PluginDocuments(undefined, () => {}, stub.csv);
        const ops = [{ op: 'set-cell', row: 2, column: 1, value: 'x' }];

        expect(await documents.call('csv-state', { paneID: PANE })).toMatchObject({ generation: 'inc:0' });
        expect(await documents.call('csv-edit', { paneID: PANE, generation: 'inc:0', ops })).toMatchObject({ dirty: true });
        await documents.call('csv-sort', { paneID: PANE, column: 1, direction: 'desc' });
        await documents.call('csv-sort', { paneID: PANE, column: null });
        expect(await documents.call('csv-find', { paneID: PANE, query: 'q' })).toEqual({ query: 'q', total: 1, complete: true, truncated: false });
        await documents.call('csv-find-step', { paneID: PANE, query: 'q', direction: 'next', from: { view: 4, column: 0 } });
        expect(await documents.call('csv-header-row', { paneID: PANE, on: false })).toMatchObject({ headerRow: false });
        await documents.call('csv-discard', { paneID: PANE });

        expect(stub.calls).toEqual([
            ['state', PANE],
            ['edit', PANE, 'inc:0', ops],
            ['sort', PANE, 1, 'desc'],
            ['sort', PANE, null, 'asc'],
            ['find', PANE, 'q'],
            ['findStep', PANE, 'q', 'next', { view: 4, column: 0 }],
            ['setHeaderRow', PANE, false],
            ['discard', PANE]
        ]);
    });

    it('passes the plugin rows budget and the column window', async () => {
        const stub = stubCsv();
        const documents = new PluginDocuments(undefined, () => {}, stub.csv);
        const reply = await documents.call('csv-rows', { paneID: PANE, start: 5, count: 3, columnStart: 1, columnCount: 2 }) as unknown as CsvRowsReply;
        expect(stub.calls).toEqual([['rows', PANE, { start: 5, count: 3, columnStart: 1, columnCount: 2 }, CSV_LIMITS.pluginRowsReplyBudgetBytes]]);
        expect(reply.rows.map(row => row.view)).toEqual([5, 6, 7]);
        expect(reply.nextStart).toBeNull();
    });

    it('shrinks a rows window whose JSON is over the cap and points nextStart past it', async () => {
        const stub = stubCsv();
        stub.cellsPerRow = 256;
        const documents = new PluginDocuments(undefined, () => {}, stub.csv);
        const reply = await documents.call('csv-rows', { paneID: PANE, start: 0, count: 500, columnCount: 256 }) as unknown as CsvRowsReply;
        expect(Buffer.byteLength(JSON.stringify(reply), 'utf8')).toBeLessThanOrEqual(256 * 1024);
        expect(reply.rows.length).toBeLessThan(500);
        expect(reply.nextStart).toBe(reply.rows.length);
    });

    it('rejects unknown and snake_case arguments', async () => {
        const stub = stubCsv();
        const documents = new PluginDocuments(undefined, () => {}, stub.csv);
        await expect(documents.call('csv-rows', { paneID: PANE, start: 0, count: 1, column_start: 1 })).rejects.toThrow('Unknown document argument.');
        await expect(documents.call('csv-state', { paneID: PANE, revision: 'x' })).rejects.toThrow('Unknown document argument.');
        await expect(documents.call('csv-discard', {})).rejects.toThrow('Invalid document paneID.');
        expect(stub.calls).toEqual([]);
    });

    it('validates payloads with the shared decoders', async () => {
        const stub = stubCsv();
        const documents = new PluginDocuments(undefined, () => {}, stub.csv);
        const cases: [string, JsonObject][] = [
            ['csv-rows', { paneID: PANE, start: 0, count: CSV_LIMITS.maxRowsPerRequest + 1 }],
            ['csv-rows', { paneID: PANE, start: -1, count: 1 }],
            ['csv-edit', { paneID: PANE, ops: [{ op: 'undo' }] }],
            ['csv-edit', { paneID: PANE, generation: 'g', ops: [{ op: 'set-cell', row: 0, column: 0 }] }],
            ['csv-edit', { paneID: PANE, generation: 'g', ops: [] }],
            ['csv-sort', { paneID: PANE }],
            ['csv-sort', { paneID: PANE, column: 0, direction: 'up' }],
            ['csv-find', { paneID: PANE, query: 'x'.repeat(CSV_LIMITS.maxFindQueryBytes + 1) }],
            ['csv-find-step', { paneID: PANE, query: 'q', from: { view: 1 } }],
            ['csv-header-row', { paneID: PANE, on: 1 }]
        ];
        for (const [method, args] of cases) {
            await expect(documents.call(method, args), `${method} ${JSON.stringify(args).slice(0, 80)}`).rejects.toThrow(/^CSV_INVALID: /);
        }
        expect(stub.calls).toEqual([]);
    });

    it('says so when the daemon has no csv service', async () => {
        const documents = new PluginDocuments(stubContent('markdown'), () => {});
        await expect(documents.call('csv-state', { paneID: PANE })).rejects.toThrow('CSV document services are unavailable.');
    });
});

describe('PluginDocuments watch on a csv pane', () => {
    it('emits documents.changed for a new csv revision and stops both subscriptions', async () => {
        const stub = stubCsv();
        const content = stubContent('csv');
        const emit = vi.fn();
        const documents = new PluginDocuments(content, emit, stub.csv);
        const owner = { pluginID: 'p' };
        const result = await documents.watch(owner, { paneID: PANE }) as { subscription: string };

        stub.listener?.(csvState({ revision: 1 }));
        expect(emit).not.toHaveBeenCalled();
        stub.listener?.(csvState({ revision: 2 }));
        stub.listener?.(csvState({ revision: 2 }));
        stub.listener?.(csvState({ incarnation: 'other', revision: 2 }));
        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenCalledWith('documents.changed', { subscription: result.subscription, paneID: PANE }, 'p');

        documents.unwatch(owner, result.subscription);
        expect(stub.unsubscribed).toBe(1);
        expect(content.unsubscribed).toBe(1);
    });

    it('does not follow the csv service for other document kinds', async () => {
        const stub = stubCsv();
        const documents = new PluginDocuments(stubContent('markdown'), () => {}, stub.csv);
        await documents.watch({ pluginID: 'p' }, { paneID: PANE });
        expect(stub.calls).toEqual([]);
    });

    it('streams a fresh snapshot when the csv state changes', async () => {
        const stub = stubCsv();
        const sent: unknown[] = [];
        let disconnect: (() => void) | undefined;
        const reply = {
            closed: false,
            send: (value: unknown) => { sent.push(value); },
            close: () => { reply.closed = true; },
            onDisconnect: (handler: () => void) => { disconnect = handler; }
        };
        const documents = new PluginDocuments(stubContent('csv'), () => {}, stub.csv);
        documents.stream(PANE, reply as never);
        await new Promise(resolve => setImmediate(resolve));
        const before = sent.length;
        expect(before).toBeGreaterThan(0);
        stub.listener?.(csvState({ revision: 9 }));
        await new Promise(resolve => setImmediate(resolve));
        expect(sent.length).toBe(before + 1);
        disconnect?.();
        expect(stub.unsubscribed).toBe(1);
    });
});

describe('PluginService document action', () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

    it('passes csv methods and their arguments through unchanged (kelpi document rows / csv-edit)', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-plugin-docs-'));
        roots.push(root);
        const stub = stubCsv();
        const service = new PluginService({
            directory: path.join(root, 'plugins'),
            store: createStore(seededState()),
            command: async () => ({ ok: true }),
            broadcast: () => {},
            csv: stub.csv
        });
        try {
            await service.request('document', { method: 'csv-rows', args: { paneID: PANE, start: 0, count: 2 } });
            const ops = [{ op: 'delete-rows', start: 1, count: 1 }];
            await service.request('document', { method: 'csv-edit', args: { paneID: PANE, generation: 'inc:0', ops } });
            expect(stub.calls).toEqual([
                ['rows', PANE, { start: 0, count: 2 }, CSV_LIMITS.pluginRowsReplyBudgetBytes],
                ['edit', PANE, 'inc:0', ops]
            ]);
        } finally {
            await service.dispose();
        }
    });
});

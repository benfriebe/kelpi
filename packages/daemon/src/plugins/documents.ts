import { randomUUID } from 'node:crypto';
import {
    CSV_LIMITS,
    decodeCsvEditOps,
    decodeCsvFindQuery,
    decodeCsvFindStep,
    decodeCsvRowsRequest,
    decodeCsvSort,
    pluginJSON,
    type CsvDecoded,
    type CsvRowsReply,
    type CsvRowsRequest,
    type JsonObject,
    type JsonValue
} from '@kelpi/protocol';
import type { CsvChannel } from '../content/csv/channel.js';
import type { ContentService } from '../content/service.js';
import type { ReplyHandle } from '../seams.js';

interface Owner { readonly pluginID?: string; readonly lease?: string; readonly stream?: ReplyHandle }
interface Watch { readonly owner: Owner; readonly paneID: string; stop(): void }
const string = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`Invalid document ${name}.`);
    return value;
};

/** #324: each csv method's argument whitelist (camelCase; the WS verbs use snake_case). */
const CSV_FIELDS: Readonly<Record<string, readonly string[]>> = {
    'csv-state': ['paneID'],
    'csv-rows': ['paneID', 'start', 'count', 'columnStart', 'columnCount'],
    'csv-edit': ['paneID', 'generation', 'ops'],
    'csv-sort': ['paneID', 'column', 'direction'],
    'csv-find': ['paneID', 'query'],
    'csv-find-step': ['paneID', 'query', 'direction', 'from'],
    'csv-header-row': ['paneID', 'on'],
    'csv-discard': ['paneID']
};
const decoded = <T>(result: CsvDecoded<T>): T => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
};
const tooLarge = (error: unknown): boolean => error instanceof Error && error.message === 'plugin JSON exceeds 256 KiB';

/** Durable buffers stay in ContentService. This adapter owns only bounded subscription leases. */
export class PluginDocuments {
    private readonly watches = new Map<string, Watch>();
    constructor(private readonly content: ContentService | undefined,
        private readonly emit: (name: string, data: JsonObject, pluginID: string) => void,
        /** #324: the csv document service behind the `csv-*` methods. */
        private readonly csv?: CsvChannel | undefined) {}

    async call(method: string, args: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
        if (method in CSV_FIELDS) return this.csvCall(method, args, signal);
        if (!this.content) throw new Error('Document services are unavailable.');
        if (signal?.aborted) throw new Error('Document operation cancelled.');
        const fields = method === 'edit' ? ['paneID', 'revision', 'text'] : method === 'mode' ? ['paneID', 'revision', 'mode']
            : method === 'get' ? ['paneID'] : ['paneID', 'revision'];
        if (Object.keys(args).some(key => !fields.includes(key))) throw new Error('Unknown document argument.');
        const paneID = string(args['paneID'], 'paneID');
        if (method === 'get') return pluginJSON(await this.content.document(paneID));
        const guard = { revision: string(args['revision'], 'revision'), signal };
        if (method === 'edit') {
            if (typeof args['text'] !== 'string') throw new Error('Document text must be a string.');
            if (Buffer.byteLength(JSON.stringify(args['text']), 'utf8') > 192 * 1024) throw new Error('Document edit exceeds 192 KiB after JSON encoding.');
            // Validate the request before applying a mutation, including JSON escaping overhead.
            pluginJSON({ method, args });
            await this.content.setText(paneID, args['text'], guard);
        } else if (method === 'mode') {
            if (args['mode'] !== 'edit' && args['mode'] !== 'view') throw new Error('Document mode must be edit or view.');
            await this.content.setMode(paneID, args['mode'], guard);
        } else if (method === 'save') await this.content.save(paneID, guard);
        else if (method === 'refresh') await this.content.refresh(paneID, guard);
        else throw new Error(`Unknown document method: ${method}`);
        return pluginJSON(await this.content.document(paneID));
    }

    /**
     * #324: the csv methods. Same rules as the text methods (strict argument whitelist, every
     * payload through the shared `@kelpi/protocol` validators, results through `pluginJSON`);
     * rows come back in the pane's view order under the plugin byte budget.
     */
    private async csvCall(method: string, args: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
        const csv = this.csv;
        if (!csv) throw new Error('CSV document services are unavailable.');
        if (signal?.aborted) throw new Error('Document operation cancelled.');
        const fields = CSV_FIELDS[method] ?? [];
        if (Object.keys(args).some(key => !fields.includes(key))) throw new Error('Unknown document argument.');
        const paneID = string(args['paneID'], 'paneID');
        switch (method) {
            case 'csv-state': return pluginJSON(await csv.state(paneID));
            case 'csv-rows': return this.csvRows(csv, paneID, decoded(decodeCsvRowsRequest(args)));
            case 'csv-edit': {
                const generation = args['generation'];
                if (typeof generation !== 'string' || !generation || generation.length > 200) throw new Error('CSV_INVALID: csv-edit requires generation');
                const ops = decoded(decodeCsvEditOps(args['ops']));
                return pluginJSON(await csv.edit(paneID, generation, ops));
            }
            case 'csv-sort': {
                const sort = decoded(decodeCsvSort(args));
                return pluginJSON(await csv.sort(paneID, sort.column, sort.direction));
            }
            case 'csv-find': return pluginJSON(await csv.find(paneID, decoded(decodeCsvFindQuery(args['query']))));
            case 'csv-find-step': {
                const step = decoded(decodeCsvFindStep(args));
                return pluginJSON(await csv.findStep(paneID, step.query, step.direction, step.from));
            }
            case 'csv-header-row':
                if (typeof args['on'] !== 'boolean') throw new Error('CSV_INVALID: csv-header-row requires on');
                return pluginJSON(await csv.setHeaderRow(paneID, args['on']));
            default: return pluginJSON(await csv.discard(paneID));
        }
    }

    /**
     * The engine's budget counts cell bytes; a reply of many tiny cells can still be over the
     * 256 KiB JSON cap after escaping and separators. Halve the window until it fits, and point
     * `nextStart` at the rows the smaller window left out so a reader keeps paging.
     */
    private async csvRows(csv: CsvChannel, paneID: string, request: CsvRowsRequest): Promise<JsonValue> {
        let window = request;
        for (;;) {
            const reply: CsvRowsReply = await csv.rows(paneID, window, CSV_LIMITS.pluginRowsReplyBudgetBytes);
            const shrunk = window.count < request.count && reply.nextStart === null && reply.rows.length === window.count;
            try {
                return pluginJSON(shrunk ? { ...reply, nextStart: window.start + window.count } : reply);
            } catch (error) {
                if (!tooLarge(error) || window.count <= 1) throw error;
                window = { ...window, count: Math.floor(window.count / 2) };
            }
        }
    }

    /**
     * Follow a document. A csv pane changes through the csv service as well (cells, saves,
     * reloads), so it is followed there too; only a new incarnation or revision counts.
     */
    private async attach(paneID: string, changed: () => void): Promise<() => void> {
        const content = await this.content!.subscribe(paneID, () => changed());
        if (content.state.type !== 'csv' || !this.csv) return () => content.unsubscribe();
        let last: string | null = null;
        try {
            const csv = await this.csv.subscribe(paneID, state => {
                const key = `${state.incarnation}:${String(state.revision)}`;
                if (key === last) return;
                last = key;
                changed();
            });
            last = `${csv.state.incarnation}:${String(csv.state.revision)}`;
            return () => { content.unsubscribe(); csv.unsubscribe(); };
        } catch (error) {
            content.unsubscribe();
            throw error;
        }
    }

    async watch(owner: Owner, args: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
        if (!this.content) throw new Error('Document services are unavailable.');
        if (this.watches.size >= 128) throw new Error('Too many document subscriptions.');
        if (Object.keys(args).some(key => key !== 'paneID')) throw new Error('Unknown document watch argument.');
        const paneID = string(args['paneID'], 'paneID'), subscription = randomUUID();
        let stop = (): void => {};
        const entry = { owner, paneID, stop: () => stop() };
        this.watches.set(subscription, entry);
        try {
            const detach = await this.attach(paneID, () => {
                if (this.watches.get(subscription) !== entry) return;
                if (owner.pluginID) this.emit('documents.changed', { subscription, paneID }, owner.pluginID);
            });
            stop = detach;
            if (signal?.aborted || this.watches.get(subscription) !== entry) throw new Error('Document subscription cancelled.');
            const result = pluginJSON({ subscription, state: await this.content.document(paneID) });
            if (signal?.aborted || this.watches.get(subscription) !== entry) throw new Error('Document subscription cancelled.');
            return result;
        } catch (error) { this.watches.delete(subscription); stop(); throw error; }
    }

    unwatch(owner: Owner, subscription: unknown): void {
        const id = string(subscription, 'subscription'), entry = this.watches.get(id);
        if (entry && entry.owner.pluginID === owner.pluginID && entry.owner.lease === owner.lease && entry.owner.stream === owner.stream) {
            this.watches.delete(id); entry.stop();
        }
    }
    release(predicate: (owner: Owner) => boolean): void {
        for (const [id, entry] of this.watches) if (predicate(entry.owner)) { this.watches.delete(id); entry.stop(); entry.owner.stream?.close(); }
    }
    prune(paneExists: (paneID: string) => boolean): void {
        for (const [id, entry] of this.watches) if (!paneExists(entry.paneID)) {
            this.watches.delete(id); entry.stop();
            if (entry.owner.pluginID) this.emit('documents.closed', { subscription: id, paneID: entry.paneID }, entry.owner.pluginID);
            if (entry.owner.stream) { entry.owner.stream.send({ ok: false, error: 'Document was closed.' }); entry.owner.stream.close(); }
        }
    }
    stream(paneID: string, reply: ReplyHandle): void {
        if (!this.content || this.watches.size >= 128) { reply.send({ ok: false, error: 'Document subscriptions unavailable.' }); reply.close(); return; }
        const id = randomUUID(); let stop = (): void => {}, reading = false, pending = false;
        const live = (): boolean => !reply.closed && this.watches.has(id);
        const cleanup = (): void => { this.watches.delete(id); stop(); };
        const drain = async (): Promise<void> => {
            if (reading || !live()) return;
            reading = true;
            try { do { pending = false; const state = await this.call('get', { paneID }); if (live()) reply.send({ ok: true, result: state }); } while (pending && live()); }
            catch (error) { if (live()) reply.send({ ok: false, error: String(error) }); cleanup(); reply.close(); }
            finally { reading = false; }
        };
        this.watches.set(id, { paneID, owner: { stream: reply }, stop: () => stop() });
        reply.onDisconnect(cleanup);
        void this.attach(paneID, () => { pending = true; void drain(); }).then(detach => {
            stop = detach; if (!live()) { cleanup(); return; } void drain();
        }, error => { if (live()) reply.send({ ok: false, error: String(error) }); cleanup(); reply.close(); });
    }
}

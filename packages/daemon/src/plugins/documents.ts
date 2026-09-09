import { randomUUID } from 'node:crypto';
import { pluginJSON, type JsonObject, type JsonValue } from '@kelpi/protocol';
import type { ContentService } from '../content/service.js';
import type { ReplyHandle } from '../seams.js';

interface Owner { readonly pluginID?: string; readonly lease?: string; readonly stream?: ReplyHandle }
interface Watch { readonly owner: Owner; readonly paneID: string; stop(): void }
const string = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`Invalid document ${name}.`);
    return value;
};

/** Durable buffers stay in ContentService. This adapter owns only bounded subscription leases. */
export class PluginDocuments {
    private readonly watches = new Map<string, Watch>();
    constructor(private readonly content: ContentService | undefined,
        private readonly emit: (name: string, data: JsonObject, pluginID: string) => void) {}

    async call(method: string, args: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
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

    async watch(owner: Owner, args: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
        if (!this.content) throw new Error('Document services are unavailable.');
        if (this.watches.size >= 128) throw new Error('Too many document subscriptions.');
        if (Object.keys(args).some(key => key !== 'paneID')) throw new Error('Unknown document watch argument.');
        const paneID = string(args['paneID'], 'paneID'), subscription = randomUUID();
        let stop = (): void => {};
        const entry = { owner, paneID, stop: () => stop() };
        this.watches.set(subscription, entry);
        try {
            const attached = await this.content.subscribe(paneID, () => {
                if (this.watches.get(subscription) !== entry) return;
                if (owner.pluginID) this.emit('documents.changed', { subscription, paneID }, owner.pluginID);
            });
            stop = () => attached.unsubscribe();
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
        void this.content.subscribe(paneID, () => { pending = true; void drain(); }).then(attached => {
            stop = () => attached.unsubscribe(); if (!live()) { cleanup(); return; } void drain();
        }, error => { if (live()) reply.send({ ok: false, error: String(error) }); cleanup(); reply.close(); });
    }
}

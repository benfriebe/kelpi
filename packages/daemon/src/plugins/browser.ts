import { randomUUID } from 'node:crypto';
import type { Pane } from '@kelpi/core/layout';
import { pluginJSON, pluginObject, WEB_CAPTURE_MODES, type BrowserSnapshot, type JsonObject, type JsonValue, type PluginContext } from '@kelpi/protocol';
import type { ReplyHandle } from '../seams.js';
import type { KelpiStore } from '../store/store.js';
import type { WebPaneState } from '../store/types.js';
import { resolvedActiveTab } from '../store/reducers/web.js';
import { normalizeURLInput } from '../store/reducers/url.js';
import { favouriteLabel, serializeFavourite } from '../webpane/favourites.js';
import { isFindAction } from '../webpane/find.js';
import { isConsoleLevel } from '../webpane/console.js';
import { serializeInspectResult } from '../webpane/inspect.js';
import { serializeBatchSession } from '../webpane/batch.js';
import { HOST_TIMEOUT_CAPTURE_MS, HOST_TIMEOUT_EXEC_MS } from '../webpane/verbs.js';
import type { WebPaneService } from '../webpane/service.js';

interface Owner { readonly pluginID?: string; readonly lease?: string; readonly stream?: ReplyHandle }
interface PaneTarget { readonly pane: Pane; readonly workspaceID: string; readonly web: WebPaneState }
interface Watch { readonly owner: Owner; readonly paneID: string; readonly createdAt: number; state: string; queued: boolean }
const MAX_WATCHES = 128;
const text = (value: unknown, name: string, maximum = 8192, empty = false): string => {
    if (typeof value !== 'string' || (!empty && !value) || value.length > maximum) throw new Error(`Invalid browser ${name}.`);
    return value;
};
const optionalText = (value: unknown, name: string, maximum = 8192): string | undefined => value === undefined ? undefined : text(value, name, maximum);
const bool = (value: unknown, name: string, fallback = false): boolean => {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`Invalid browser ${name}.`);
    return value;
};
const fields = (args: JsonObject, allowed: readonly string[]): void => {
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unknown browser argument.');
};
const nativeCommands: Readonly<Record<string, string>> = {
    navigate: 'web-navigate', back: 'web-back', forward: 'web-forward', reload: 'web-reload', stop: 'web-stop', focus: 'web-focus-view', blur: 'web-blur-view', devtools: 'web-devtools',
    url: 'web-url', capture: 'web-capture', exec: 'web-exec', find: 'web-find', zoom: 'web-zoom', inspect: 'web-inspect', inspectResult: 'web-inspect-result', console: 'web-console',
    'tabs.open': 'web-tab-new', 'tabs.select': 'web-tab-select', 'tabs.close': 'web-tab-close', 'tabs.reorder': 'web-tab-reorder', setPrivate: 'web-private',
    'favourites.list': 'web-favourites-list', 'favourites.toggle': 'web-favourite-toggle', 'favourites.remove': 'web-favourite-remove', 'favourites.rename': 'web-favourite-rename', 'favourites.move': 'web-favourite-move',
    'cookies.list': 'web-cookies-list', 'cookies.clear': 'web-cookies-clear', 'cookies.delete': 'web-cookies-delete', 'cookies.set': 'web-cookie-set',
    'batch.state': 'web-batch-state', 'batch.toggle': 'web-batch-toggle', 'batch.cancel': 'web-batch-cancel', 'batch.remove': 'web-batch-remove', 'batch.comment': 'web-batch-comment', 'batch.focus': 'web-batch-focus', 'batch.send': 'web-batch-send'
};
const nativeFields: Readonly<Record<string, string>> = { paneID: 'pane_id', tabID: 'tab_id', makeActive: 'make_active', isPrivate: 'private', sendTo: 'send_to', itemID: 'item_id' };
const tabOperations = new Set(['navigate', 'back', 'forward', 'reload', 'stop', 'focus', 'devtools', 'url', 'capture', 'exec', 'find', 'zoom', 'inspect', 'tabs.select', 'tabs.close', 'batch.toggle', 'batch.comment']);
export interface BrowserOperation {
    readonly payload: JsonObject;
    readonly args: JsonObject;
    readonly context: PluginContext;
    /** Called immediately before effects after asynchronous policy hooks finish. */
    validate(): void;
}

/** Public browser operations reuse native tabs, sessions, buffers and the one host registry. */
export class PluginBrowser {
    private readonly watches = new Map<string, Watch>();
    private readonly offState: (() => void) | undefined;
    private readonly inspectRequests = new Map<string, object>();
    private closed = false;
    constructor(private readonly store: KelpiStore, private readonly web: WebPaneService | undefined,
        private readonly emit: (name: string, data: JsonObject, pluginID: string) => void,
        stateChanged?: (paneID: string | null) => void) {
        this.offState = web?.subscribeState(paneID => { this.changed(paneID); stateChanged?.(paneID); });
    }

    private service(): WebPaneService {
        if (!this.web || this.closed) throw new Error('Browser services are unavailable.');
        return this.web;
    }
    private target(paneID: string): PaneTarget {
        for (const workspace of this.store.getState().workspaces) {
            const pane = workspace.panes.find(pane => pane.id === paneID);
            if (pane?.type === 'web' && workspace.webPanes[paneID]) return { pane, workspaceID: workspace.id, web: workspace.webPanes[paneID]! };
        }
        throw new Error('Browser pane is no longer available.');
    }
    private matches(entry: Pick<Watch, 'paneID' | 'createdAt'>): boolean {
        try { return this.target(entry.paneID).pane.createdAt === entry.createdAt; } catch { return false; }
    }
    private snapshot(paneID: string): BrowserSnapshot {
        const web = this.service(), target = this.target(paneID);
        return {
            paneID, workspaceID: target.workspaceID, isPrivate: target.web.isPrivate,
            activeTabID: resolvedActiveTab(target.web)?.id ?? null,
            tabs: target.web.tabs.map(tab => {
                const nav = web.navState(paneID, tab.id);
                return { id: tab.id, url: tab.url, title: tab.title, live: tab.live !== false,
                    loading: nav?.loading ?? false, canGoBack: nav?.canGoBack ?? false, canGoForward: nav?.canGoForward ?? false };
            }),
            host: { available: web.hasHost, id: web.host.hostID, name: web.host.hostName, windowID: web.host.hostWindowID },
            favourites: web.favourites.list().map(favourite => ({ ...favourite, createdAt: new Date(favourite.createdAt).toISOString(), label: favouriteLabel(favourite) })),
            inspection: web.inspectionState(paneID)
        };
    }
    /** Bundled/native UI transport already carries the daemon's full state, outside plugin RPC limits. */
    nativeSnapshot(args: JsonObject): BrowserSnapshot {
        fields(args, ['paneID']);
        return this.snapshot(text(args['paneID'], 'paneID', 200));
    }

    private changed(paneID: string | null): void {
        for (const [subscription, entry] of this.watches) {
            if (paneID !== null && entry.paneID !== paneID) continue;
            if (!this.matches(entry)) {
                this.watches.delete(subscription);
                if (entry.owner.pluginID) this.emit('browser.closed', { subscription, paneID: entry.paneID }, entry.owner.pluginID);
                if (entry.owner.stream) { entry.owner.stream.send({ ok: false, error: 'Browser pane was closed.' }); entry.owner.stream.close(); }
                continue;
            }
            if (entry.queued) continue;
            entry.queued = true;
            queueMicrotask(() => {
                entry.queued = false;
                if (this.closed || this.watches.get(subscription) !== entry) return;
                try {
                    const snapshot = pluginJSON(this.snapshot(entry.paneID)), next = JSON.stringify(snapshot);
                    if (next === entry.state) return;
                    entry.state = next;
                    if (entry.owner.pluginID) this.emit('browser.changed', { subscription, paneID: entry.paneID }, entry.owner.pluginID);
                    entry.owner.stream?.send({ ok: true, result: snapshot });
                } catch (error) {
                    this.watches.delete(subscription);
                    const message = error instanceof Error ? error.message : String(error);
                    if (entry.owner.pluginID) this.emit('browser.closed', { subscription, paneID: entry.paneID, error: message }, entry.owner.pluginID);
                    if (entry.owner.stream) { entry.owner.stream.send({ ok: false, error: message }); entry.owner.stream.close(); }
                }
            });
        }
    }

    watch(owner: Owner, args: JsonObject, signal?: AbortSignal): JsonValue {
        fields(args, ['paneID']);
        if (signal?.aborted) throw new Error('Browser subscription cancelled.');
        if (this.watches.size >= MAX_WATCHES) throw new Error('Too many browser subscriptions.');
        const paneID = text(args['paneID'], 'paneID', 200), state = pluginJSON(this.snapshot(paneID));
        const subscription = randomUUID();
        const result = pluginJSON({ subscription, state });
        this.watches.set(subscription, { owner, paneID, createdAt: this.target(paneID).pane.createdAt, state: JSON.stringify(state), queued: false });
        return result;
    }
    unwatch(owner: Owner, subscription: unknown): void {
        const id = text(subscription, 'subscription', 200), entry = this.watches.get(id);
        if (entry && entry.owner.pluginID === owner.pluginID && entry.owner.lease === owner.lease && entry.owner.stream === owner.stream) this.watches.delete(id);
    }
    release(predicate: (owner: Owner) => boolean): void {
        for (const [id, entry] of this.watches) if (predicate(entry.owner)) { this.watches.delete(id); entry.owner.stream?.close(); }
    }
    stream(paneID: string, reply: ReplyHandle): void {
        try {
            const result = pluginObject(this.watch({ stream: reply }, { paneID }));
            reply.onDisconnect(() => this.unwatch({ stream: reply }, result['subscription']));
            reply.send({ ok: true, result: result['state']! });
        } catch (error) { reply.send({ ok: false, error: error instanceof Error ? error.message : String(error) }); reply.close(); }
    }
    close(): void { this.closed = true; this.offState?.(); this.release(() => true); this.inspectRequests.clear(); }

    /** Capture identity before native command hooks may yield; they never retarget an intent. */
    operation(method: string, args: JsonObject, context: PluginContext, signal?: AbortSignal): BrowserOperation | null {
        const command = nativeCommands[method];
        if (!command) return null;
        const service = this.service();
        const available = (): void => { this.service(); if (signal?.aborted) throw new Error('Browser operation cancelled.'); };
        available();
        let captured: Record<string, JsonValue> = { ...args };
        let operationContext = context, validate = available;
        if (!method.startsWith('favourites.')) {
            const paneID = text(args['paneID'] ?? context.paneID, 'paneID', 200), target = this.target(paneID);
            const generation = service.pageGeneration(paneID), hostID = service.host.hostID;
            captured = { ...args, paneID };
            operationContext = { ...context, paneID, workspaceID: target.workspaceID };
            if (['tabs.select', 'tabs.close', 'find', 'zoom'].includes(method)) text(args['tabID'], 'tabID', 200);
            const needsTab = tabOperations.has(method) && !(method === 'inspect' && args['disarm'] === true);
            const tabID = needsTab ? optionalText(args['tabID'], 'tabID', 200) ?? resolvedActiveTab(target.web)?.id : undefined;
            if (needsTab && (!tabID || !target.web.tabs.some(tab => tab.id === tabID))) throw new Error('Browser tab is no longer available.');
            if (tabID) captured['tabID'] = tabID;
            const tabGeneration = tabID ? service.tabGeneration(paneID, tabID) : undefined;
            // Batch focus uses a native active-tab-only host verb, so it cannot be retargeted.
            const activeTab = method === 'batch.focus' ? resolvedActiveTab(target.web)?.id : undefined;
            const reordered = method === 'tabs.reorder' ? new Map(target.web.tabs.map(tab => [tab.id, service.tabGeneration(paneID, tab.id)])) : undefined;
            validate = () => {
                available();
                const current = this.target(paneID);
                if (current.pane.createdAt !== target.pane.createdAt || service.pageGeneration(paneID) !== generation || service.host.hostID !== hostID
                    || (tabID && service.tabGeneration(paneID, tabID) !== tabGeneration)
                    || (activeTab !== undefined && resolvedActiveTab(current.web)?.id !== activeTab)
                    || (reordered && (current.web.tabs.length !== reordered.size || current.web.tabs.some(tab => service.tabGeneration(paneID, tab.id) !== reordered.get(tab.id))))) throw new Error('Browser operation target changed.');
            };
        }
        const payload: Record<string, JsonValue> = { command };
        for (const [key, value] of Object.entries(captured)) payload[nativeFields[key] ?? key] = value;
        if (captured['paneID']) payload['target'] = captured['paneID'];
        if (method === 'tabs.select' || method === 'tabs.close') payload['tab'] = captured['tabID']!;
        if (method === 'tabs.open') { payload['url'] ??= ''; payload['make_active'] ??= true; }
        if (method === 'capture') payload['mode'] ??= 'text';
        if (method === 'console') payload['follow'] = false;
        return { payload: pluginObject(payload), args: captured, context: operationContext, validate };
    }

    async call(method: string, args: JsonObject, context: PluginContext, signal?: AbortSignal): Promise<JsonValue> {
        const service = this.service();
        if (signal?.aborted) throw new Error('Browser operation cancelled.');
        if (method.startsWith('favourites.')) return this.favourites(method.slice(11), args);
        const paneID = text(args['paneID'] ?? context.paneID, 'paneID', 200), target = this.target(paneID);
        const base = { pane_id: paneID, workspace_id: target.workspaceID };
        const paneFields = (extra: readonly string[] = []): void => fields(args, ['paneID', ...extra]);
        const tab = (): WebPaneState['tabs'][number] => {
            const tabID = optionalText(args['tabID'], 'tabID', 200) ?? resolvedActiveTab(target.web)?.id;
            const found = target.web.tabs.find(tab => tab.id === tabID);
            if (!found) throw new Error('Browser tab is no longer available.');
            return found;
        };
        const generation = service.pageGeneration(paneID), owner = service.host.hostID;
        const tabs = new Map(target.web.tabs.map(tab => [tab.id, service.tabGeneration(paneID, tab.id)]));
        const assertTarget = (tabID?: string): void => {
            if (signal?.aborted) throw new Error('Browser operation cancelled.');
            const current = this.target(paneID);
            if (current.pane.createdAt !== target.pane.createdAt || service.pageGeneration(paneID) !== generation || owner !== service.host.hostID
                || (tabID !== undefined && (!current.web.tabs.some(tab => tab.id === tabID) || service.tabGeneration(paneID, tabID) !== tabs.get(tabID)))) throw new Error('Browser operation target changed.');
        };
        const host = async (verb: string, input: JsonObject, tabID?: string, timeoutMs?: number): Promise<JsonObject> => {
            const result = await service.call(verb, input, { signal, timeoutMs });
            assertTarget(tabID);
            return pluginObject({ ...result, ...base, ...(tabID ? { tab_id: tabID } : {}) });
        };
        const ok = (result: JsonObject = {}): JsonValue => pluginJSON({ ok: true, ...base, ...result });

        if (method === 'get') { paneFields(); return pluginJSON(this.snapshot(paneID)); }
        if (method === 'tabs.open') {
            paneFields(['url', 'makeActive']);
            const url = normalizeURLInput(text(args['url'] ?? '', 'url', 8192, true)), makeActive = bool(args['makeActive'], 'makeActive', true), tabID = randomUUID().toUpperCase();
            this.store.dispatch({ type: 'web-tab-open', workspaceID: target.workspaceID, paneID, tabID, url, makeActive });
            service.notify('tab-open', { paneID, tabID, url, makeActive });
            return ok({ tab_id: tabID, url, active: makeActive });
        }
        if (method === 'tabs.select' || method === 'tabs.close') {
            paneFields(['tabID']);
            text(args['tabID'], 'tabID', 200);
            const selected = tab();
            if (method === 'tabs.close' && target.web.tabs.length <= 1) throw new Error('Cannot close the last browser tab; close the pane instead.');
            if (method === 'tabs.close') service.forgetTab(paneID, selected.id);
            this.store.dispatch({ type: method === 'tabs.close' ? 'web-tab-close' : 'web-tab-select', workspaceID: target.workspaceID, paneID, tabID: selected.id });
            service.notify(method === 'tabs.close' ? 'tab-close' : 'tab-select', { paneID, tabID: selected.id });
            service.retargetFind(paneID, resolvedActiveTab(this.target(paneID).web)?.id ?? null);
            return ok({ tab_id: selected.id });
        }
        if (method === 'tabs.reorder') {
            paneFields(['order']);
            const order = args['order'];
            if (!Array.isArray(order) || order.some(value => typeof value !== 'string') || order.length !== target.web.tabs.length
                || new Set(order).size !== order.length || target.web.tabs.some(tab => !order.includes(tab.id))) throw new Error('Browser tab order must be an exact permutation.');
            this.store.dispatch({ type: 'web-tab-reorder', workspaceID: target.workspaceID, paneID, order: order as string[] });
            return ok({ order, applied: true });
        }
        if (method === 'setPrivate') {
            paneFields(['isPrivate']);
            if (typeof args['isPrivate'] !== 'boolean') throw new Error('Invalid browser isPrivate.');
            const isPrivate = args['isPrivate'], changed = target.web.isPrivate !== isPrivate;
            if (changed) {
                this.store.dispatch({ type: 'web-set-private', workspaceID: target.workspaceID, paneID, isPrivate });
                service.notify('pane-set-private', { paneID, isPrivate, activeTabID: resolvedActiveTab(target.web)?.id ?? null,
                    tabs: target.web.tabs.map(tab => ({ id: tab.id, url: tab.url, title: tab.title })) });
            }
            return ok({ private: isPrivate, changed });
        }
        if (['navigate', 'back', 'forward', 'reload', 'stop', 'focus', 'devtools', 'url', 'capture', 'exec', 'find', 'zoom'].includes(method)) {
            paneFields(['tabID', ...(method === 'navigate' ? ['url'] : method === 'reload' ? ['hard'] : method === 'capture' ? ['mode']
                : method === 'exec' ? ['script'] : method === 'find' ? ['action', 'needle'] : method === 'zoom' ? ['direction'] : [])]);
            if (method === 'find' || method === 'zoom') text(args['tabID'], 'tabID', 200);
            const selected = tab(), tabID = selected.id;
            if (method === 'navigate') {
                const url = normalizeURLInput(text(args['url'], 'url', 8192, true));
                if (!service.hasHost) return host('navigate', { paneID, tabID, url }, tabID);
                this.store.dispatch({ type: 'web-navigate', workspaceID: target.workspaceID, paneID, tabID, url });
                return { ...await host('navigate', { paneID, tabID, url }, tabID), url };
            }
            if (method === 'reload') {
                const hard = bool(args['hard'], 'hard');
                if (selected.live === false && service.rebuildPane(paneID)) return ok({ tab_id: tabID, rebuilt: true });
                return host('reload', { paneID, tabID, hard }, tabID);
            }
            if (method === 'capture') {
                const mode = args['mode'] ?? 'text';
                if (!(WEB_CAPTURE_MODES as readonly unknown[]).includes(mode)) throw new Error('Invalid browser capture mode.');
                const result = await host('capture', { paneID, tabID, mode }, tabID, HOST_TIMEOUT_CAPTURE_MS);
                return pluginJSON({ ...result, mode, url: result['url'] ?? selected.url, title: result['title'] ?? selected.title });
            }
            if (method === 'exec') return host('exec', { paneID, tabID, script: text(args['script'], 'script', 192 * 1024) }, tabID, HOST_TIMEOUT_EXEC_MS);
            if (method === 'url') {
                if (!service.hasHost) return ok({ tab_id: tabID, url: selected.url, title: selected.title });
                const result = await host('url', { paneID, tabID }, tabID);
                return ok({ tab_id: tabID, url: result['ok'] === true && typeof result['url'] === 'string' ? result['url'] : selected.url,
                    title: result['ok'] === true && typeof result['title'] === 'string' ? result['title'] : selected.title });
            }
            if (method === 'find') {
                const action = text(args['action'], 'find action');
                if (!isFindAction(action)) throw new Error('Invalid browser find action.');
                const result = await service.runFind(paneID, tabID, action, text(args['needle'] ?? '', 'needle', 8192, true), signal);
                assertTarget(tabID); return pluginJSON({ ...result, ...base, tab_id: tabID });
            }
            if (method === 'zoom') {
                const direction = args['direction'];
                if (direction !== 'in' && direction !== 'out' && direction !== 'reset') throw new Error('Invalid browser zoom direction.');
                return host('zoom', { paneID, tabID, ...(direction === 'reset' ? { reset: true } : { delta: direction === 'in' ? 0.1 : -0.1 }) }, tabID);
            }
            return host(method === 'focus' ? 'focus-view' : method, { paneID, tabID }, tabID);
        }
        if (method === 'blur') { paneFields(); return host('blur-view', {}); }
        if (method === 'inspect') {
            paneFields(['tabID', 'disarm', 'sendTo', 'submit']);
            if (bool(args['disarm'], 'disarm')) {
                this.inspectRequests.delete(paneID); service.inspect.disarm(paneID); service.notify('inspect-disarm', { paneID });
                return ok({ armed: false });
            }
            const selected = tab(), sendTo = optionalText(args['sendTo'], 'sendTo', 200) ?? null, submit = bool(args['submit'], 'submit');
            const destination = sendTo ? this.shell(sendTo) : undefined;
            const request = {}, nonce = service.inspect.newNonce(), previous = service.inspect.armOf(paneID);
            this.inspectRequests.set(paneID, request);
            try {
                const result = await host('inspect-arm', { paneID, tabID: selected.id, nonce, sticky: false }, selected.id);
                if (this.inspectRequests.get(paneID) !== request || service.inspect.armOf(paneID) !== previous) throw new Error('Browser inspector target changed.');
                if (result['ok'] !== true) return result;
                if (sendTo && this.shell(sendTo).createdAt !== destination?.createdAt) throw new Error('Browser inspection destination changed.');
                service.inspect.arm({ paneID, tabID: selected.id, nonce, sendTo, submit });
                return ok({ tab_id: selected.id, armed: true, send_to: sendTo ?? '', submit });
            } finally { if (this.inspectRequests.get(paneID) === request) this.inspectRequests.delete(paneID); }
        }
        if (method === 'inspectResult') {
            paneFields(['clear']);
            const clear = bool(args['clear'], 'clear'), batch = service.batch.sessionOf(paneID);
            const results = [...service.inspect.queued(paneID).map(serializeInspectResult), ...(batch?.items ?? []).map(item => serializeInspectResult({ ...item.result, comment: item.comment }))];
            const result = ok({ results });
            if (clear) { service.inspect.clearQueue(paneID); if (batch) service.cancelBatch(paneID); }
            return result;
        }
        if (method === 'console') {
            paneFields(['since', 'level', 'clear']);
            const since = args['since'], level = args['level'];
            if (since !== undefined && (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0)) throw new Error('Invalid browser console since.');
            if (level !== undefined && (typeof level !== 'string' || !isConsoleLevel(level))) throw new Error('Invalid browser console level.');
            const clear = bool(args['clear'], 'clear');
            // Validate the bounded reply before clearing the native queue.
            const result = ok({ ...service.console.drain(paneID, { ...(since === undefined ? {} : { since: since as number }), ...(level === undefined ? {} : { level: level as string }) }), follow: false });
            if (clear) service.console.drain(paneID, { clear: true });
            return result;
        }
        if (method.startsWith('cookies.')) {
            const action = method.slice(8);
            paneFields(action === 'list' ? [] : action === 'clear' ? ['all', 'domain'] : action === 'delete' ? ['name', 'domain'] : action === 'set' ? ['cookie', 'original'] : []);
            if (!['list', 'clear', 'delete', 'set'].includes(action)) throw new Error(`Unknown browser method: ${method}`);
            const domain = optionalText(args['domain'], 'domain'), all = bool(args['all'], 'all');
            if (all && domain !== undefined) throw new Error('Browser cookie clear cannot combine all and domain.');
            const name = action === 'delete' ? text(args['name'], 'cookie name') : undefined;
            const cookie = action === 'set' ? pluginObject(args['cookie']) : undefined;
            const original = args['original'] === undefined ? undefined : pluginObject(args['original']);
            if (!service.hasHost && action !== 'set') return ok(action === 'list' ? { private: target.web.isPrivate, cookies: [] } : { deleted: 0, ...(domain ? { domain } : {}), ...(name ? { name } : {}) });
            return host(`cookies-${action}`, { paneID, ...(action === 'clear' ? { all } : {}), ...(domain ? { domain } : {}), ...(name ? { name } : {}), ...(cookie ? { cookie } : {}), ...(original ? { original } : {}) });
        }
        if (method.startsWith('batch.')) {
            const action = method.slice(6);
            paneFields(action === 'remove' ? ['itemID'] : action === 'comment' ? ['itemID', 'comment', 'tabID'] : action === 'focus' ? ['itemID', 'origin'] : action === 'send' ? ['sendTo'] : action === 'toggle' ? ['tabID'] : []);
            const reply = (extra: JsonObject = {}): JsonValue => ok({ batch: serializeBatchSession(service.batch.sessionOf(paneID)), ...extra });
            if (action === 'state') return reply();
            if (action === 'cancel') { this.inspectRequests.delete(paneID); service.cancelBatch(paneID); return reply({ cancelled: true }); }
            if (action === 'remove') { const itemID = text(args['itemID'], 'itemID', 200); service.batch.remove(paneID, itemID); service.publishBatch(paneID); return reply({ item_id: itemID }); }
            if (action === 'comment') {
                const itemID = text(args['itemID'], 'itemID', 200), comment = text(args['comment'], 'comment', 8192, true), tabID = tab().id;
                service.batch.setComment(paneID, itemID, comment); service.publishBatch(paneID);
                service.notify('batch-comment', { paneID, tabID, itemID, comment }); return reply({ item_id: itemID });
            }
            if (action === 'focus') {
                const itemID = args['itemID'] === null ? null : text(args['itemID'], 'itemID', 200), origin = args['origin'] ?? 'panel';
                if (origin !== 'panel' && origin !== 'page') throw new Error('Invalid browser batch origin.');
                service.focusBatchItem(paneID, itemID, origin); return reply({ item_id: itemID, origin });
            }
            if (action === 'send') {
                const sendTo = args['sendTo'] == null ? null : text(args['sendTo'], 'sendTo', 200);
                if (sendTo) this.shell(sendTo);
                const outcome = service.sendBatch(paneID, sendTo);
                if (!outcome.ok) throw new Error(outcome.error ?? 'Failed to send browser batch.');
                return reply({ sent: outcome.sent, send_to: outcome.sendTo ?? '' });
            }
            if (action === 'toggle') {
                const selected = tab(), outcome = service.batch.toggle(paneID);
                service.publishBatch(paneID);
                if (outcome === 'hidden') {
                    this.inspectRequests.delete(paneID); service.inspect.disarm(paneID); service.notify('inspect-disarm', { paneID });
                    return reply({ armed: false, toggled: outcome });
                }
                const request = {}, nonce = service.inspect.newNonce(), session = service.batch.sessionOf(paneID), previous = service.inspect.armOf(paneID);
                this.inspectRequests.set(paneID, request);
                try {
                    const result = await host('inspect-arm', { paneID, tabID: selected.id, nonce, sticky: true }, selected.id);
                    if (this.inspectRequests.get(paneID) !== request || service.inspect.armOf(paneID) !== previous || service.batch.sessionOf(paneID) !== session) throw new Error('Browser batch target changed.');
                    if (result['ok'] !== true) { service.cancelBatch(paneID); return pluginJSON({ ...result, batch: null }); }
                    service.inspect.arm({ paneID, tabID: selected.id, nonce, sendTo: null, submit: session?.submit ?? false });
                    return reply({ armed: true, toggled: outcome });
                } catch (error) {
                    if (this.inspectRequests.get(paneID) === request && service.batch.sessionOf(paneID) === session) service.cancelBatch(paneID);
                    throw error;
                } finally { if (this.inspectRequests.get(paneID) === request) this.inspectRequests.delete(paneID); }
            }
        }
        throw new Error(`Unknown browser method: ${method}`);
    }

    private shell(paneID: string): Pane {
        const pane = this.store.getState().workspaces.flatMap(workspace => workspace.panes).find(pane => pane.id === paneID);
        if (pane?.type !== 'shell') throw new Error('Browser inspection destination must be a shell pane.');
        return pane;
    }
    private favourites(method: string, args: JsonObject): JsonValue {
        const favourites = this.service().favourites;
        fields(args, method === 'list' ? [] : method === 'toggle' ? ['url', 'title'] : method === 'remove' ? ['id'] : method === 'rename' ? ['id', 'title'] : method === 'move' ? ['from', 'to'] : []);
        let extra: JsonObject = {};
        if (method === 'toggle') {
            const outcome = favourites.toggle(text(args['url'], 'favourite url'), text(args['title'] ?? '', 'favourite title', 8192, true));
            extra = { added: outcome.added, ...(outcome.id ? { favourite_id: outcome.id } : {}) };
        } else if (method === 'remove' || method === 'rename') {
            const id = text(args['id'], 'favourite id', 200);
            if (method === 'remove') favourites.remove(id); else favourites.rename(id, text(args['title'], 'favourite title', 8192, true));
            extra = { favourite_id: id };
        } else if (method === 'move') {
            const from = args['from'], to = args['to'];
            if (typeof from !== 'number' || !Number.isSafeInteger(from) || typeof to !== 'number' || !Number.isSafeInteger(to) || from < 0 || to < 0 || from >= favourites.list().length || to >= favourites.list().length) throw new Error('Invalid browser favourite move.');
            favourites.move(from, to);
        } else if (method !== 'list') throw new Error(`Unknown browser favourites method: ${method}`);
        return pluginJSON({ ok: true, ...extra, favourites: favourites.list().map(serializeFavourite) });
    }
}

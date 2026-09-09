import type { JsonValue } from '@kelpi/protocol';
import type { UIQuickPickItem, UIQuickPickOptions, UIInputOptions, UIDialogOptions, UINotificationOptions } from '../../../plugin-sdk/ui.js';

export const WINDOW_UI_METHODS = ['ui.showQuickPick', 'ui.showInput', 'ui.showDialog', 'ui.showNotification'] as const;
export const UI_SERVICE_LIMITS = Object.freeze({ scopes: 128, scopePending: 8, windowPending: 32, notifications: 4, notificationMs: 10_000, items: 200, actions: 8, input: 16_384, payloadBytes: 256 * 1024 });
export interface UIServiceOwner { readonly id: string; readonly pluginID: string; readonly pluginName: string }
interface RequestBase { readonly id: string; readonly owner: UIServiceOwner }
export type UIServiceModal = RequestBase & (
    | { readonly kind: 'quickPick'; readonly options: UIQuickPickOptions }
    | { readonly kind: 'input'; readonly options: UIInputOptions }
    | { readonly kind: 'dialog'; readonly options: UIDialogOptions }
);
export type UIServiceNotification = RequestBase & { readonly kind: 'notification'; readonly options: UINotificationOptions };
export interface UIServiceSnapshot {
    readonly active: UIServiceModal | null;
    /** Modal requests waiting behind the active prompt. Notifications have a separate queue. */
    readonly queued: number;
    readonly notifications: readonly UIServiceNotification[];
}
export interface UIServiceScope {
    readonly id: string;
    request(method: string, args: unknown): Promise<JsonValue>;
    dispose(): void;
}
export interface UIServiceModel {
    createScope(owner: UIServiceOwner): UIServiceScope;
    getSnapshot(): UIServiceSnapshot;
    subscribe(listener: () => void): () => void;
    answer(requestID: string, value: string | null): void;
    dispose(): void;
}

type Data = Record<string, unknown>;
function record(value: unknown, keys: readonly string[]): Data {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('UI options must be a plain object.');
    if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unknown UI option.');
    return value as Data;
}
function text(value: unknown, label: string, maximum: number, empty = false): string {
    if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim())) throw new Error(`${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${maximum} characters.`);
    return value;
}
function optionalText(data: Data, key: string, maximum: number): Record<string, string> {
    return data[key] === undefined ? {} : { [key]: text(data[key], key, maximum, true) };
}
function optionalBoolean(data: Data, key: string): Record<string, boolean> {
    if (data[key] === undefined) return {};
    if (typeof data[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
    return { [key]: data[key] };
}
function rows(value: unknown, maximum: number, minimum = 0): unknown[] {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`UI items must contain ${minimum}–${maximum} entries.`);
    return value;
}
function distinct<T extends { readonly id: string }>(items: T[]): readonly T[] {
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('UI item IDs must be unique.');
    return Object.freeze(items.map(item => Object.freeze(item)));
}
function options(method: string, raw: unknown): Pick<UIServiceModal | UIServiceNotification, 'kind' | 'options'> {
    if (method === 'ui.showQuickPick') {
        const data = record(raw, ['title', 'placeholder', 'items', 'selectedID']);
        const items = distinct(rows(data['items'], UI_SERVICE_LIMITS.items).map((value): UIQuickPickItem => {
            const row = record(value, ['id', 'label', 'description', 'disabled']);
            return { id: text(row['id'], 'Item ID', 128), label: text(row['label'], 'Item label', 200), ...optionalText(row, 'description', 1024), ...optionalBoolean(row, 'disabled') };
        }));
        const selectedID = data['selectedID'];
        if (selectedID !== undefined && !items.some(item => item.id === selectedID && !item.disabled)) throw new Error('selectedID must identify an enabled item.');
        return { kind: 'quickPick', options: Object.freeze({ title: text(data['title'], 'Title', 200), items, ...optionalText(data, 'placeholder', 200), ...optionalText(data, 'selectedID', 128) }) };
    }
    if (method === 'ui.showInput') {
        const data = record(raw, ['title', 'prompt', 'value', 'placeholder', 'password', 'maxLength']);
        const maxLength = data['maxLength'] ?? 4096;
        if (typeof maxLength !== 'number' || !Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > UI_SERVICE_LIMITS.input) throw new Error(`maxLength must be an integer from 1 to ${UI_SERVICE_LIMITS.input}.`);
        return { kind: 'input', options: Object.freeze({ title: text(data['title'], 'Title', 200), maxLength, ...optionalText(data, 'prompt', 2048), ...optionalText(data, 'value', maxLength), ...optionalText(data, 'placeholder', 200), ...optionalBoolean(data, 'password') }) };
    }
    if (method === 'ui.showDialog') {
        const data = record(raw, ['title', 'message', 'detail', 'actions', 'cancelID']);
        const actions = distinct(rows(data['actions'], UI_SERVICE_LIMITS.actions, 1).map(value => {
            const row = record(value, ['id', 'label', 'kind']);
            if (row['kind'] !== undefined && (typeof row['kind'] !== 'string' || !['default', 'primary', 'danger'].includes(row['kind']))) throw new Error('Unknown dialog action kind.');
            return { id: text(row['id'], 'Action ID', 128), label: text(row['label'], 'Action label', 200), ...(row['kind'] === undefined ? {} : { kind: row['kind'] as 'default' | 'primary' | 'danger' }) };
        }));
        if (data['cancelID'] !== undefined && !actions.some(item => item.id === data['cancelID'])) throw new Error('cancelID must identify a dialog action.');
        return { kind: 'dialog', options: Object.freeze({ title: text(data['title'], 'Title', 200), message: text(data['message'], 'Message', 2048), actions, ...optionalText(data, 'detail', 8192), ...optionalText(data, 'cancelID', 128) }) };
    }
    if (method === 'ui.showNotification') {
        const data = record(raw, ['message', 'detail', 'tone', 'actions']);
        const tone = data['tone'] ?? 'info';
        if (typeof tone !== 'string' || !['info', 'success', 'warning', 'error'].includes(tone)) throw new Error('Unknown notification tone.');
        const actions = distinct(rows(data['actions'] ?? [], UI_SERVICE_LIMITS.actions).map(value => {
            const row = record(value, ['id', 'label']);
            return { id: text(row['id'], 'Action ID', 128), label: text(row['label'], 'Action label', 200) };
        }));
        return { kind: 'notification', options: Object.freeze({ message: text(data['message'], 'Message', 2048), ...optionalText(data, 'detail', 8192), tone: tone as NonNullable<UINotificationOptions['tone']>, actions }) };
    }
    throw new Error('Unknown window UI method.');
}

/** A window owns one model; each attached view receives a separately disposable scope. */
export function createUIServices(): UIServiceModel {
    type Pending = { request: UIServiceModal | UIServiceNotification; resolve: (value: JsonValue) => void; timer?: ReturnType<typeof setTimeout> };
    const pending = new Map<string, Pending>();
    const scopes = new Map<string, UIServiceOwner>();
    const listeners = new Set<() => void>();
    let sequence = 0, disposed = false;
    let snapshot: UIServiceSnapshot = Object.freeze({ active: null, queued: 0, notifications: Object.freeze([]) });
    const publish = (): void => {
        const all = [...pending.values()].map(entry => entry.request);
        const modals = all.filter((request): request is UIServiceModal => request.kind !== 'notification');
        const notifications = all.filter((request): request is UIServiceNotification => request.kind === 'notification').slice(0, UI_SERVICE_LIMITS.notifications);
        snapshot = Object.freeze({ active: modals[0] ?? null, queued: Math.max(0, modals.length - 1), notifications: Object.freeze(notifications) });
        for (const notification of notifications) {
            const entry = pending.get(notification.id)!;
            entry.timer ??= setTimeout(() => { finish(notification.id, null); publish(); }, UI_SERVICE_LIMITS.notificationMs);
        }
        for (const listener of [...listeners]) { try { listener(); } catch { listeners.delete(listener); } }
    };
    const finish = (id: string, value: string | null): void => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id); clearTimeout(entry.timer); entry.resolve(value);
    };
    return {
        getSnapshot: () => snapshot,
        subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
        createScope(rawOwner) {
            if (disposed) throw new Error('Window UI has been disposed.');
            const owner = Object.freeze({ id: text(rawOwner.id, 'Scope ID', 200), pluginID: text(rawOwner.pluginID, 'Plugin ID', 160), pluginName: text(rawOwner.pluginName, 'Plugin name', 200) });
            if (scopes.has(owner.id)) throw new Error('UI scope already exists.');
            if (scopes.size >= UI_SERVICE_LIMITS.scopes) throw new Error('Too many UI scopes in this window.');
            scopes.set(owner.id, owner);
            let closed = false;
            return {
                id: owner.id,
                async request(method, args) {
                    if (closed || disposed) throw new Error('This view no longer owns window UI.');
                    if (pending.size >= UI_SERVICE_LIMITS.windowPending || [...pending.values()].filter(entry => entry.request.owner.id === owner.id).length >= UI_SERVICE_LIMITS.scopePending) throw new Error('Too many pending window UI requests.');
                    const parsed = options(method, args);
                    if (new TextEncoder().encode(JSON.stringify(parsed)).length > UI_SERVICE_LIMITS.payloadBytes) throw new Error('Window UI request exceeds 256 KiB.');
                    const id = `ui-${++sequence}`;
                    const request = Object.freeze({ ...parsed, id, owner }) as UIServiceModal | UIServiceNotification;
                    return new Promise<JsonValue>(resolve => { pending.set(id, { request, resolve }); publish(); });
                },
                dispose() {
                    if (closed) return;
                    closed = true; scopes.delete(owner.id);
                    for (const entry of pending.values()) if (entry.request.owner.id === owner.id) finish(entry.request.id, null);
                    publish();
                }
            };
        },
        answer(id, value) {
            const request = pending.get(id)?.request;
            if (!request) return;
            if (id !== snapshot.active?.id && !snapshot.notifications.some(entry => entry.id === id)) throw new Error('This UI request is not visible.');
            if (value !== null) {
                if (request.kind === 'input') text(value, 'Input', request.options.maxLength ?? 4096, true);
                else if (request.kind === 'quickPick') { if (!request.options.items.some(item => item.id === value && !item.disabled)) throw new Error('Choose an enabled item.'); }
                else if (!request.options.actions?.some(action => action.id === value)) throw new Error('Unknown UI action.');
            }
            finish(id, value); publish();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const id of pending.keys()) finish(id, null);
            scopes.clear(); publish(); listeners.clear();
        }
    };
}

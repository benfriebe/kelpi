import { PLUGIN_MAX_JSON_BYTES, pluginJSON, type JsonObject } from '@kelpi/protocol';
import type { ChromeKeymap, ChromeSnapshot } from '../../../plugin-sdk/chrome';
export type { ChromeSnapshot, ChromeCommand, ChromeItem, ChromeKeymap, ChromeKeymapCommand, ChromeKeymapPlugin, ChromeKeymapSection } from '../../../plugin-sdk/chrome';

export const CHROME_UI_METHODS = ['ui.getChrome', 'ui.executeChromeCommand'] as const;
export interface ChromeSource {
    snapshot(): ChromeSnapshot;
    execute(id: string, target: JsonObject): void | Promise<void>;
}
export interface PluginChrome {
    getChrome(): ChromeSnapshot;
    execute(id: unknown, target: JsonObject): void | Promise<void>;
    subscribe(listener: (value: ChromeSnapshot) => void, onError?: (error: Error) => void): () => void;
    update(source: ChromeSource): void;
    dispose(): void;
}
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
    return value;
}
const encoder = new TextEncoder();
/**
 * The keymap is up to 64 KiB and one value across many commits (the assembly memoizes it), so it
 * is validated, copied, frozen, serialized and measured once per identity, not on every publish.
 */
const keymaps = new WeakMap<ChromeKeymap, { value: ChromeKeymap; json: string; bytes: number }>();
function publishedKeymap(keymap: ChromeKeymap): { value: ChromeKeymap; json: string; bytes: number } {
    let entry = keymaps.get(keymap);
    if (entry === undefined) {
        const value = freeze(pluginJSON(keymap) as unknown as ChromeKeymap), json = JSON.stringify(value);
        entry = { value, json, bytes: encoder.encode(json).byteLength };
        keymaps.set(keymap, entry);
    }
    return entry;
}
/** The complete message around the other fields and the keymap: the envelope, `,"keymap":` and its closing brace. */
const MESSAGE_BYTES = encoder.encode(JSON.stringify({ type: 'chrome', sequence: Number.MAX_SAFE_INTEGER, value: null })).byteLength - 'null'.length + ',"keymap":'.length;
interface ChromeRead { readonly value: ChromeSnapshot; readonly rest: string; readonly keymap: string }
/** Models outlive replaced/hidden views; constructing one starts no timers or subscriptions. */
export function createPluginChrome(initial: ChromeSource): PluginChrome {
    let source = initial, disposed = false, queued = false, last: ReturnType<typeof read> | undefined;
    const listeners = new Set<{ listener: (value: ChromeSnapshot) => void; onError?: (error: Error) => void }>();
    const build = (): ChromeRead => {
        if (disposed) throw new Error('Window chrome is unavailable after disposal.');
        try {
            const { keymap, ...fields } = source.snapshot();
            const published = publishedKeymap(keymap);
            const copy = pluginJSON(fields) as unknown as Omit<ChromeSnapshot, 'keymap'>, rest = JSON.stringify(copy);
            // Measured as one message, keymap included, exactly as `pluginJSON` would measure it.
            if (MESSAGE_BYTES + encoder.encode(rest).byteLength + published.bytes > PLUGIN_MAX_JSON_BYTES) throw new Error('oversized');
            const value = Object.freeze({ ...freeze(copy), keymap: published.value });
            return { value, rest, keymap: published.json };
        } catch { throw new Error('Window chrome snapshot is invalid or exceeds 256 KiB.'); }
    };
    const getChrome = (): ChromeSnapshot => build().value;
    const read = (): ChromeRead | { error: Error } => {
        try { return build(); } catch (error) { return { error: error as Error }; }
    };
    const deliver = (entry: { listener: (value: ChromeSnapshot) => void; onError?: (error: Error) => void }, next: ReturnType<typeof read>): void => {
        try { if ('value' in next) entry.listener(next.value); else entry.onError?.(next.error); } catch { /* A failed consumer cannot prevent another view updating. */ }
    };
    // An unchanged keymap is the same cached string, so comparing it costs nothing.
    const same = (a: ReturnType<typeof read> | undefined, b: ReturnType<typeof read>): boolean => a !== undefined &&
        ('value' in a && 'value' in b ? a.rest === b.rest && a.keymap === b.keymap : 'error' in a && 'error' in b && a.error.message === b.error.message);
    return {
        getChrome,
        execute(id, target) {
            if (disposed) throw new Error('Window chrome is unavailable after disposal.');
            if (typeof id !== 'string' || !id || id.length > 320) throw new Error('Invalid chrome command ID.');
            for (const field of Object.keys(target)) {
                const value = target[field];
                if (!['workspaceID', 'paneID'].includes(field) || typeof value !== 'string' || !value || value.length > 160) throw new Error('Invalid chrome command target.');
            }
            return source.execute(id, target);
        },
        subscribe(listener, onError) {
            if (disposed) throw new Error('Window chrome is unavailable after disposal.');
            const entry = { listener, ...(onError ? { onError } : {}) }; listeners.add(entry);
            const next = read(); if (listeners.size === 1) last = next; deliver(entry, next);
            return () => { listeners.delete(entry); };
        },
        update(next) {
            if (disposed) return;
            source = next;
            if (!queued && listeners.size) {
                queued = true;
                queueMicrotask(() => {
                    queued = false; if (disposed || !listeners.size) return;
                    const next = read(); if (same(last, next)) return;
                    last = next; for (const entry of listeners) deliver(entry, next);
                });
            }
        },
        dispose() { disposed = true; listeners.clear(); },
    };
}

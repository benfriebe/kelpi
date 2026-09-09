import { pluginJSON, type JsonObject } from '@kelpi/protocol';
import type { ChromeSnapshot } from '../../../plugin-sdk/chrome';
export type { ChromeSnapshot, ChromeCommand, ChromeItem } from '../../../plugin-sdk/chrome';

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
/** Models outlive replaced/hidden views; constructing one starts no timers or subscriptions. */
export function createPluginChrome(initial: ChromeSource): PluginChrome {
    let source = initial, disposed = false, queued = false, lastKey: string | undefined;
    const listeners = new Set<{ listener: (value: ChromeSnapshot) => void; onError?: (error: Error) => void }>();
    const getChrome = (): ChromeSnapshot => {
        if (disposed) throw new Error('Window chrome is unavailable after disposal.');
        try {
            return freeze((pluginJSON({ type: 'chrome', sequence: Number.MAX_SAFE_INTEGER, value: source.snapshot() }) as unknown as { value: ChromeSnapshot }).value);
        } catch { throw new Error('Window chrome snapshot is invalid or exceeds 256 KiB.'); }
    };
    const read = (): { value: ChromeSnapshot } | { error: Error } => {
        try { return { value: getChrome() }; } catch (error) { return { error: error as Error }; }
    };
    const deliver = (entry: { listener: (value: ChromeSnapshot) => void; onError?: (error: Error) => void }, next: ReturnType<typeof read>): void => {
        try { if ('value' in next) entry.listener(next.value); else entry.onError?.(next.error); } catch { /* A failed consumer cannot prevent another view updating. */ }
    };
    const key = (next: ReturnType<typeof read>): string => 'value' in next ? JSON.stringify(next.value) : `error:${next.error.message}`;
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
            const next = read(); if (listeners.size === 1) lastKey = key(next); deliver(entry, next);
            return () => { listeners.delete(entry); };
        },
        update(next) {
            if (disposed) return;
            source = next;
            if (!queued && listeners.size) {
                queued = true;
                queueMicrotask(() => {
                    queued = false; if (disposed || !listeners.size) return;
                    const next = read(), nextKey = key(next); if (nextKey === lastKey) return;
                    lastKey = nextKey; for (const entry of listeners) deliver(entry, next);
                });
            }
        },
        dispose() { disposed = true; listeners.clear(); },
    };
}

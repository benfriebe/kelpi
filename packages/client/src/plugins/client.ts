import { useEffect, useState } from 'react';
import { pluginObject, pluginRecord, type JsonObject, type JsonValue, type PluginInfo } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';

export async function pluginRequest(runtime: KelpiRuntime, action: string, input: JsonObject = {}): Promise<JsonValue> {
    const reply = await runtime.commands.raw({ command: 'plugin', action, text: JSON.stringify(pluginObject(input)) }, { timeoutMs: 35_000 });
    if (reply['ok'] !== true) throw new Error(String(reply['error'] ?? 'plugin request failed'));
    return reply['result'] ?? null;
}

const EMPTY: readonly PluginInfo[] = [];
/** Per-runtime cache: remote daemons and independent windows never share installed plugins. */
const caches = new WeakMap<KelpiRuntime, { plugins: readonly PluginInfo[]; daemonID: string | null; error: string | null; listeners: Set<() => void>; stop: () => void }>();
/** Invocation-time read: plugin lifecycle broadcasts reach this cache before React commits. */
export function getCurrentPlugins(runtime: KelpiRuntime): readonly PluginInfo[] {
    return caches.get(runtime)?.plugins ?? EMPTY;
}
export function usePlugins(runtime: KelpiRuntime): { plugins: readonly PluginInfo[]; daemonID: string | null; error: string | null } {
    const [, update] = useState(0);
    useEffect(() => {
        let cache = caches.get(runtime);
        if (!cache) {
            const created = { plugins: EMPTY, daemonID: null as string | null, error: null as string | null, listeners: new Set<() => void>(), stop: () => {} };
            const notify = (): void => { for (const listener of created.listeners) listener(); };
            let active = true, generation = 0;
            const refresh = (): void => {
                if (!runtime.connection.isConnected) return;
                const requested = ++generation;
                void Promise.all([pluginRequest(runtime, 'list'), pluginRequest(runtime, 'identity')]).then(([result, identity]) => {
                    if (!active || requested !== generation) return;
                    created.plugins = result as unknown as PluginInfo[];
                    if (pluginRecord(identity) && typeof identity['daemonID'] === 'string') created.daemonID = identity['daemonID'];
                    created.error = null; notify();
                }, error => { if (active && requested === generation) { created.error = String(error.message); notify(); } });
            };
            const offStatus = runtime.connection.on('status', status => { if (status === 'connected') refresh(); });
            const offMessage = runtime.connection.on('message', message => {
                if (message['type'] === 'plugins-changed' && Array.isArray(message['plugins'])) {
                    generation += 1; created.plugins = message['plugins'] as unknown as PluginInfo[]; created.error = null;
                    if (typeof message['daemonID'] === 'string') created.daemonID = message['daemonID'];
                    notify();
                }
            });
            created.stop = () => { active = false; offStatus(); offMessage(); };
            caches.set(runtime, created); cache = created; refresh();
        }
        const listener = (): void => update(n => n + 1);
        cache.listeners.add(listener); listener();
        return () => { cache.listeners.delete(listener); if (cache.listeners.size === 0) { cache.stop(); caches.delete(runtime); } };
    }, [runtime]);
    return { plugins: caches.get(runtime)?.plugins ?? EMPTY, daemonID: caches.get(runtime)?.daemonID ?? null, error: caches.get(runtime)?.error ?? null };
}

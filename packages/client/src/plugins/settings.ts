import { pluginObject, pluginRecord, pluginSettingValue, type PluginContextValue, type PluginInfo, type PluginSettingDefinition } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { pluginRequest } from './client';

interface SettingWrite {
    inFlight: boolean;
    desired: { value: PluginContextValue; edit: number } | null;
}
interface SettingsListener { changed(): void; report(error: unknown): void }
const sameInstance = (first: PluginInfo, second: PluginInfo): boolean => first.manifest.id === second.manifest.id
    && first.revision === second.revision && first.instanceID === second.instanceID && first.enabled === second.enabled;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function createSettingsSession(runtime: KelpiRuntime, plugin: PluginInfo, activate: () => void, release: () => void) {
    const state = { active: false, retired: false, loaded: false, serial: 0, load: 0, values: {} as Record<string, PluginContextValue>,
        versions: new Map<string, number>(), edits: new Map<string, number>(), editing: new Set<string>(),
        drafts: new Map<string, string | boolean>(), errors: new Map<string, string>(), writes: new Map<string, SettingWrite>() };
    const definitions = plugin.manifest.contributes.settings, listeners = new Set<SettingsListener>();
    let stops: Array<() => void> = [], epoch: string | null = null, lastSequence: number | null = null;
    const changed = (): void => { for (const listener of listeners) listener.changed(); };
    const report = (error: unknown): void => { for (const listener of listeners) listener.report(error); };
    const stop = (): void => {
        state.active = false; state.loaded = false; state.load += 1;
        for (const off of stops) off();
        stops = []; release();
    };
    const releaseIfIdle = (): void => { if (!listeners.size && !state.writes.size) stop(); };
    const cancelWrites = (): void => {
        for (const key of state.writes.keys()) state.drafts.delete(key);
        state.writes.clear();
    };
    const retire = (): void => { state.retired = true; cancelWrites(); stop(); changed(); };
    const refresh = (): void => {
        if (!state.active || !plugin.enabled || !runtime.connection.isConnected) return;
        const request = ++state.load, before = new Map(state.versions);
        void pluginRequest(runtime, 'settings', { pluginID: plugin.manifest.id }).then(raw => {
            if (!state.active || request !== state.load) return;
            const values = pluginObject(raw);
            for (const [key, setting] of Object.entries(definitions)) {
                // A live setting event or completed write after this read began wins.
                if (state.versions.get(key) !== before.get(key)) continue;
                state.values[key] = pluginSettingValue(setting, values[key] ?? setting.default);
            }
            state.loaded = true; changed();
        }).catch(error => { if (state.active && request === state.load) { report(error); changed(); } });
    };
    const start = (): void => {
        activate(); state.active = true;
        stops = [runtime.connection.on('status', value => {
            if (value === 'connected') refresh();
            else if (value === 'closed' || value === 'rejected') retire();
            else {
                // A new connection may serve a different daemon or plugin instance.
                state.load += 1; state.loaded = false; epoch = null; lastSequence = null;
                cancelWrites(); changed(); releaseIfIdle();
            }
        }), runtime.connection.on('message', message => {
            if (message['type'] === 'plugins-changed' && Array.isArray(message['plugins'])) {
                const current = (message['plugins'] as unknown as PluginInfo[]).find(current => current.manifest.id === plugin.manifest.id);
                if (!current || !sameInstance(plugin, current)) { retire(); return; }
                if (typeof message['epoch'] === 'string') {
                    if (epoch !== null && epoch !== message['epoch']) { retire(); return; }
                    epoch = message['epoch'];
                }
                return;
            }
            if (message['type'] !== 'plugin-event' || !pluginRecord(message['event'])) return;
            const event = message['event'];
            if (typeof event['epoch'] === 'string' && Number.isSafeInteger(event['sequence'])) {
                const sequence = Number(event['sequence']);
                if (epoch !== null && epoch !== event['epoch']) { retire(); return; }
                if (lastSequence !== null && sequence <= lastSequence && event['name'] !== 'gap') return;
                if (event['name'] === 'gap' || lastSequence !== null && sequence > lastSequence + 1) refresh();
                lastSequence = Math.max(lastSequence ?? sequence, sequence); epoch = event['epoch'];
            }
            if (event['name'] !== 'settings.changed' || event['pluginID'] !== plugin.manifest.id || !pluginRecord(event['data'])) return;
            const data = event['data'], key = data['key'];
            if (typeof key !== 'string' || !Object.hasOwn(definitions, key)) return;
            try {
                state.values[key] = pluginSettingValue(definitions[key]!, data['value']);
                state.versions.set(key, ++state.serial);
                if (!state.writes.has(key) && !state.editing.has(key) && !state.errors.has(key)) state.drafts.delete(key);
                changed();
            } catch (error) { report(error); }
        })];
        refresh();
    };
    const save = (key: string): void => {
        const write = state.writes.get(key);
        if (!state.active || !runtime.connection.isConnected || !write || write.inFlight || !write.desired) return;
        const { value, edit } = write.desired, before = state.versions.get(key);
        const current = (): boolean => state.active && state.writes.get(key) === write;
        write.desired = null; write.inFlight = true;
        void pluginRequest(runtime, 'settings', { pluginID: plugin.manifest.id, key, value }).then(() => {
            if (!current()) return;
            // A newer daemon event is authoritative even if this older acknowledgement is late.
            if (state.versions.get(key) === before) { state.values[key] = value; state.versions.set(key, ++state.serial); }
            if (state.edits.get(key) === edit) {
                state.errors.delete(key);
                if (!state.editing.has(key)) state.drafts.delete(key);
            }
        }).catch(error => {
            if (!current()) return;
            if (state.edits.get(key) === edit) { state.drafts.delete(key); state.errors.set(key, errorMessage(error)); }
            report(error);
        }).finally(() => {
            if (!current()) return;
            write.inFlight = false;
            if (write.desired) save(key); else state.writes.delete(key);
            changed(); releaseIfIdle();
        });
    };
    const edit = (key: string, setting: PluginSettingDefinition, draft: string | boolean): void => {
        if (!state.active || !state.loaded || !plugin.enabled) return;
        state.drafts.set(key, draft); const version = ++state.serial; state.edits.set(key, version);
        try {
            let candidate: unknown = draft;
            if (setting.type === 'number') {
                const text = String(draft).trim();
                if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) throw new Error('Enter a valid number.');
                candidate = Number(text);
            }
            const value = pluginSettingValue(setting, candidate);
            state.errors.delete(key);
            const write = state.writes.get(key) ?? { inFlight: false, desired: null };
            write.desired = { value, edit: version }; state.writes.set(key, write); save(key);
        } catch (error) {
            // Keep intermediate strings such as "-" or "1e" editable; never send NaN/null.
            state.errors.set(key, errorMessage(error));
            const write = state.writes.get(key); if (write) write.desired = null;
        }
        changed();
    };
    return { plugin, state, changed, edit, retire,
        subscribe(listener: SettingsListener) {
            listeners.add(listener);
            if (!state.active && !state.retired) start();
            listener.changed();
            return () => {
                listeners.delete(listener);
                if (!listeners.size) {
                    state.editing.clear();
                    for (const key of state.drafts.keys()) if (!state.writes.has(key)) state.drafts.delete(key);
                }
                // Ordinary panel unmount leaves the queue and its lifecycle fences alive.
                releaseIfIdle();
            };
        }
    };
}

const sessions = new WeakMap<KelpiRuntime, Map<string, ReturnType<typeof createSettingsSession>>>();
/** Reopening Settings joins the same instance's pending writes instead of racing a new queue. */
export function pluginSettingsSession(runtime: KelpiRuntime, plugin: PluginInfo): ReturnType<typeof createSettingsSession> {
    let entries = sessions.get(runtime);
    if (!entries) { entries = new Map(); sessions.set(runtime, entries); }
    const owners = entries, key = JSON.stringify([plugin.manifest.id, plugin.revision, plugin.instanceID, plugin.enabled]);
    const existing = owners.get(key);
    if (existing) return existing;
    const session = createSettingsSession(runtime, plugin, () => {
        for (const other of owners.values()) if (other !== session && other.plugin.manifest.id === plugin.manifest.id) other.retire();
        owners.set(key, session);
    }, () => { if (owners.get(key) === session) owners.delete(key); });
    owners.set(key, session);
    return session;
}

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { pluginObject, pluginRecord, pluginSettingValue, type JsonObject, type PluginContextValue, type PluginInfo, type PluginSettingDefinition } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { pluginRequest, usePlugins } from './client';
import { PlacementSettings, WorkbenchSlot } from './Workbench';
import { PluginShortcuts } from './PluginShortcuts';
import { PluginProviders } from './PluginProviders';

interface SettingWrite {
    inFlight: boolean;
    desired: { value: PluginContextValue; edit: number } | null;
}
function settingSession() {
    return { active: false, loaded: false, serial: 0, load: 0, values: {} as Record<string, PluginContextValue>,
        versions: new Map<string, number>(), edits: new Map<string, number>(), editing: new Set<string>(),
        drafts: new Map<string, string | boolean>(), errors: new Map<string, string>(), writes: new Map<string, SettingWrite>() };
}
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Field drafts and writes belong to a particular installed instance, never a later reload. */
export function PluginSettings(props: { plugin: PluginInfo; runtime: KelpiRuntime; report(error: unknown): void }): ReactElement {
    const { runtime, plugin } = props;
    const [, update] = useState(0);
    const report = useRef(props.report); report.current = props.report;
    const session = useMemo(settingSession, [runtime, plugin.manifest.id, plugin.revision, plugin.instanceID, plugin.enabled]);
    const changed = (): void => { if (session.active) update(value => value + 1); };
    const definitions = plugin.manifest.contributes.settings;
    useEffect(() => {
        session.active = true;
        let epoch: string | null = null, lastSequence: number | null = null;
        const refresh = (): void => {
            if (!plugin.enabled || !runtime.connection.isConnected) return;
            const request = ++session.load, before = new Map(session.versions);
            void pluginRequest(runtime, 'settings', { pluginID: plugin.manifest.id }).then(raw => {
                if (!session.active || request !== session.load) return;
                const values = pluginObject(raw);
                for (const [key, setting] of Object.entries(definitions)) {
                    // A live setting event or completed write after this read began wins.
                    if (session.versions.get(key) !== before.get(key)) continue;
                    session.values[key] = pluginSettingValue(setting, values[key] ?? setting.default);
                }
                session.loaded = true; changed();
            }).catch(error => { if (session.active && request === session.load) { report.current(error); changed(); } });
        };
        const status = runtime.connection.on('status', value => {
            if (value === 'connected') refresh();
            else { session.load += 1; session.loaded = false; changed(); }
        });
        const messages = runtime.connection.on('message', message => {
            if (message['type'] !== 'plugin-event' || !pluginRecord(message['event'])) return;
            const event = message['event'];
            if (typeof event['epoch'] === 'string' && Number.isSafeInteger(event['sequence'])) {
                const sequence = Number(event['sequence']);
                if (epoch === event['epoch'] && lastSequence !== null && sequence <= lastSequence && event['name'] !== 'gap') return;
                if (event['name'] === 'gap' || epoch !== null && epoch !== event['epoch'] || lastSequence !== null && sequence > lastSequence + 1) refresh();
                lastSequence = epoch === event['epoch'] ? Math.max(lastSequence ?? sequence, sequence) : sequence;
                epoch = event['epoch'];
            }
            if (event['name'] !== 'settings.changed' || event['pluginID'] !== plugin.manifest.id || !pluginRecord(event['data'])) return;
            const data = event['data'], key = data['key'];
            if (typeof key !== 'string' || !Object.hasOwn(definitions, key)) return;
            try {
                session.values[key] = pluginSettingValue(definitions[key]!, data['value']);
                session.versions.set(key, ++session.serial);
                if (!session.writes.has(key) && !session.editing.has(key) && !session.errors.has(key)) session.drafts.delete(key);
                changed();
            } catch (error) { report.current(error); }
        });
        refresh();
        return () => { session.active = false; session.load += 1; status(); messages(); };
    }, [runtime, plugin.manifest.id, plugin.enabled, session]);

    const save = (key: string): void => {
        const write = session.writes.get(key);
        if (!session.active || !write || write.inFlight || !write.desired) return;
        const { value, edit } = write.desired, before = session.versions.get(key);
        write.desired = null; write.inFlight = true;
        void pluginRequest(runtime, 'settings', { pluginID: plugin.manifest.id, key, value }).then(() => {
            if (!session.active) return;
            // A newer daemon event is authoritative even if this older acknowledgement is late.
            if (session.versions.get(key) === before) { session.values[key] = value; session.versions.set(key, ++session.serial); }
            if (session.edits.get(key) === edit) {
                session.errors.delete(key);
                if (!session.editing.has(key)) session.drafts.delete(key);
            }
        }).catch(error => {
            if (!session.active) return;
            if (session.edits.get(key) === edit) {
                session.drafts.delete(key); session.errors.set(key, errorMessage(error));
            }
            report.current(error);
        }).finally(() => {
            if (!session.active) return;
            write.inFlight = false;
            if (write.desired) save(key); else session.writes.delete(key);
            changed();
        });
    };
    const edit = (key: string, setting: PluginSettingDefinition, draft: string | boolean): void => {
        session.drafts.set(key, draft); const version = ++session.serial; session.edits.set(key, version);
        try {
            let candidate: unknown = draft;
            if (setting.type === 'number') {
                const text = String(draft).trim();
                if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) throw new Error('Enter a valid number.');
                candidate = Number(text);
            }
            const value = pluginSettingValue(setting, candidate);
            session.errors.delete(key);
            const write = session.writes.get(key) ?? { inFlight: false, desired: null };
            write.desired = { value, edit: version }; session.writes.set(key, write); save(key);
        } catch (error) {
            // Keep intermediate strings such as "-" or "1e" editable; never send NaN/null.
            session.errors.set(key, errorMessage(error));
            const write = session.writes.get(key); if (write) write.desired = null;
        }
        changed();
    };
    const groups = [
        { id: '', title: 'General', description: undefined as string | undefined },
        ...[...plugin.manifest.contributes.settingGroups ?? []].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
    ];
    return <div data-testid={`plugin-settings-${plugin.manifest.id}`} className="flex flex-col gap-3">
        {groups.map(group => {
            const fields = Object.entries(definitions).filter(([, setting]) => (setting.group ?? '') === group.id)
                .sort(([a, first], [b, second]) => (first.order ?? 0) - (second.order ?? 0) || a.localeCompare(b));
            if (!fields.length) return null;
            return <fieldset key={group.id} className="flex min-w-0 flex-col gap-2" data-plugin-setting-group={group.id || 'general'}>
                <legend className="mb-1 font-medium">{group.title}</legend>
                {group.description ? <p className="opacity-70">{group.description}</p> : null}
                {fields.map(([key, setting]) => {
                    const id = `plugin-setting-${plugin.manifest.id}-${key}`, failure = session.errors.get(key);
                    const value = session.drafts.get(key) ?? session.values[key] ?? setting.default;
                    const disabled = !plugin.enabled || !session.loaded;
                    const common = { id, 'aria-label': setting.title, disabled,
                        'aria-invalid': failure ? true as const : undefined,
                        'aria-describedby': [setting.description ? `${id}-description` : '', failure ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined,
                        onFocus: () => { session.editing.add(key); },
                        onBlur: () => { session.editing.delete(key); if (!session.writes.has(key) && !session.errors.has(key)) { session.drafts.delete(key); changed(); } },
                        className: 'min-w-0 max-w-[60%] rounded border bg-transparent px-2 py-1' };
                    return <div key={key} className="flex flex-col gap-1">
                        <label htmlFor={id} className="flex items-center justify-between gap-2"><span>{setting.title}</span>
                            {setting.enum ? <select {...common} value={String(value)} onChange={event => {
                                const choice = setting.enum!.find(choice => String(choice) === event.target.value);
                                if (choice !== undefined) edit(key, setting, typeof choice === 'number' ? String(choice) : choice);
                            }}>{setting.enum.map(choice => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}</select>
                            : setting.type === 'boolean' ? <input {...common} type="checkbox" checked={Boolean(value)} onChange={event => edit(key, setting, event.target.checked)} />
                            : <input {...common} type="text" {...(setting.type === 'number' ? { inputMode: 'decimal' as const } : {})} value={String(value)} onChange={event => edit(key, setting, event.target.value)} />}
                        </label>
                        {setting.description ? <p id={`${id}-description`} className="opacity-70">{setting.description}</p> : null}
                        {failure ? <p id={`${id}-error`} role="alert">{failure}</p> : null}
                    </div>;
                })}
            </fieldset>;
        })}
    </div>;
}

export function PluginsTab(props: { runtime: KelpiRuntime }): ReactElement {
    const { plugins, error: loadError } = usePlugins(props.runtime);
    const [source, setSource] = useState('');
    const [trusted, setTrusted] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [logs, setLogs] = useState<string | null>(null);
    const report = (error: unknown): void => setError(error instanceof Error ? error.message : String(error));
    const run = async (action: string, args: JsonObject): Promise<void> => {
        setBusy(true); setError(null);
        try { const result = await pluginRequest(props.runtime, action, args); if (action === 'logs') setLogs((result as string[]).join('\n')); }
        catch (error) { report(error); } finally { setBusy(false); }
    };
    return <div data-testid="plugins-settings" className="flex flex-col gap-5 text-xs">
        <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void run('install', { path: source, trust: trusted }); }}>
            <strong>Install a plugin</strong>
            <label>Directory on this daemon<input className="mt-1 w-full rounded border p-2" placeholder="/path/to/my-plugin" aria-label="Plugin directory" value={source} onChange={event => setSource(event.target.value)} /></label>
            <label className="flex items-start gap-2"><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} />I trust this plugin to run code with my account’s access.</label>
            <button type="submit" className="self-start rounded border px-3 py-1" disabled={busy || !source.trim() || !trusted}>Install</button>
        </form>
        {error || loadError ? <p role="alert">{error ?? loadError}</p> : null}
        {plugins.length === 0 ? <p>No plugins installed.</p> : plugins.map(plugin => <section key={plugin.manifest.id} className="flex flex-col gap-2 rounded border p-3" data-testid={`plugin-card-${plugin.manifest.id}`}>
            <div className="flex justify-between gap-2"><strong>{plugin.manifest.name}</strong><span>{plugin.manifest.version} · {plugin.status}</span></div>
            <code>{plugin.manifest.id}</code>
            {plugin.error ? <p role="alert">{plugin.error}</p> : null}
            <div className="flex flex-wrap gap-3">{[plugin.enabled ? 'disable' : 'enable', 'reload', 'logs', 'remove'].map(action => <button key={action} disabled={busy} onClick={() => void run(action, { pluginID: plugin.manifest.id })}>{action[0]!.toUpperCase() + action.slice(1)}</button>)}</div>
            {plugin.manifest.contributes.views.filter(view => view.placements.includes('pane')).map(view => <button key={view.id} className="self-start" disabled={!plugin.enabled || busy} onClick={() => void run('open', { pluginID: plugin.manifest.id, viewID: view.id })}>Open {view.title}</button>)}
            <PluginSettings plugin={plugin} runtime={props.runtime} report={report} />
            <PluginShortcuts plugin={plugin} runtime={props.runtime} />
        </section>)}
        {logs !== null ? <div><button onClick={() => setLogs(null)}>Close logs</button><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{logs || 'No logs.'}</pre></div> : null}
        <PlacementSettings />
        <PluginProviders runtime={props.runtime} />
        <WorkbenchSlot placement="settings" className="h-96 w-full" />
    </div>;
}

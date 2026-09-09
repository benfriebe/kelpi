import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { JsonObject, PluginInfo } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { pluginRequest, usePlugins } from './client';
import { PlacementSettings, WorkbenchSlot } from './Workbench';
import { PluginShortcuts } from './PluginShortcuts';
import { PluginProviders } from './PluginProviders';
import { pluginSettingsSession } from './settings';

/** Field drafts and writes belong to a particular installed instance, never a later reload. */
export function PluginSettings(props: { plugin: PluginInfo; runtime: KelpiRuntime; report(error: unknown): void }): ReactElement {
    const { runtime, plugin } = props;
    const [, update] = useState(0);
    const report = useRef(props.report); report.current = props.report;
    const settings = useMemo(() => pluginSettingsSession(runtime, plugin), [runtime, plugin.manifest.id, plugin.revision, plugin.instanceID, plugin.enabled]);
    const previous = useRef(settings);
    const { state: session, changed, edit } = settings;
    const definitions = plugin.manifest.contributes.settings;
    useEffect(() => {
        // A mounted owner changing is distinct from closing or switching Settings tabs.
        if (previous.current !== settings) previous.current.retire();
        previous.current = settings;
        return settings.subscribe({ changed: () => update(value => value + 1), report: error => report.current(error) });
    }, [settings]);
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

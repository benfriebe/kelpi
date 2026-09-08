import { useEffect, useState, type ReactElement } from 'react';
import type { JsonObject, PluginInfo } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { pluginRequest, usePlugins } from './client';
import { PlacementSettings, WorkbenchSlot } from './Workbench';
import { PluginShortcuts } from './PluginShortcuts';
import { PluginProviders } from './PluginProviders';

function PluginSettings(props: { plugin: PluginInfo; runtime: KelpiRuntime; report(error: unknown): void }): ReactElement {
    const [values, setValues] = useState<JsonObject>({});
    useEffect(() => { if (props.plugin.enabled) void pluginRequest(props.runtime, 'settings', { pluginID: props.plugin.manifest.id }).then(value => setValues(value as JsonObject), props.report); }, [props.runtime, props.plugin.revision, props.plugin.enabled]);
    return <>{Object.entries(props.plugin.manifest.contributes.settings).map(([key, setting]) => <label key={key} className="flex items-center justify-between gap-2">{setting.title}<input aria-label={setting.title} disabled={!props.plugin.enabled} type={setting.type === 'boolean' ? 'checkbox' : setting.type === 'number' ? 'number' : 'text'}
        {...(setting.type === 'boolean' ? { checked: Boolean(values[key] ?? setting.default) } : { value: String(values[key] ?? setting.default) })}
        onChange={event => {
            const value = setting.type === 'boolean' ? event.target.checked : setting.type === 'number' ? Number(event.target.value) : event.target.value;
            setValues(current => ({ ...current, [key]: value }));
            void pluginRequest(props.runtime, 'settings', { pluginID: props.plugin.manifest.id, key, value }).catch(props.report);
        }} /></label>)}</>;
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

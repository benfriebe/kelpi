import { useEffect, useState, type ReactElement } from 'react';
import type { PluginCommandDefinition, PluginInfo } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { usePluginShortcuts } from './shortcuts';

function ShortcutField(props: { command: PluginCommandDefinition; value: string; overridden: boolean; save(value: string | undefined): void }): ReactElement {
    const [draft, setDraft] = useState(props.value);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { setDraft(props.value); setError(null); }, [props.value]);
    const save = (value: string | undefined): void => {
        try { props.save(value); setError(null); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    };
    return <form className="flex flex-col gap-1" onSubmit={event => { event.preventDefault(); save(draft); }}>
        <label className="flex items-center justify-between gap-2">{props.command.title}
            <input aria-label={`Shortcut for ${props.command.title}`} aria-invalid={error !== null} aria-describedby={error ? `shortcut-error-${props.command.id}` : undefined}
                className="min-w-0 rounded border px-2 py-1" placeholder="Unassigned" value={draft} onChange={event => setDraft(event.target.value)} />
        </label>
        <div className="flex gap-3"><button type="submit" disabled={draft === props.value}>Save shortcut</button>
            {props.overridden ? <button type="button" onClick={() => save(undefined)}>Restore default</button> : null}
        </div>
        {error ? <p id={`shortcut-error-${props.command.id}`} role="alert">{error}</p> : null}
    </form>;
}

export function PluginShortcuts(props: { runtime: KelpiRuntime; plugin: PluginInfo }): ReactElement | null {
    const { overrides, setShortcut } = usePluginShortcuts(props.runtime);
    if (!props.plugin.manifest.contributes.commands.length) return null;
    return <div className="mt-2 flex flex-col gap-3" data-testid={`plugin-shortcuts-${props.plugin.manifest.id}`}>
        <strong>Keyboard shortcuts</strong>
        <p>Use Cmd, Ctrl, or Alt, for example super+shift+b. Clear a shortcut to disable it. Bundled shortcuts take priority.</p>
        {props.plugin.manifest.contributes.commands.map(command => <ShortcutField key={command.id} command={command}
            overridden={Object.hasOwn(overrides, command.id)} value={Object.hasOwn(overrides, command.id) ? overrides[command.id] ?? '' : command.shortcut ?? ''}
            save={value => setShortcut(command.id, value)} />)}
    </div>;
}

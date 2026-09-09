import { useEffect, useMemo, useRef } from 'react';
import { parseKeyTrigger, canonicalTriggerForPlatform } from '@kelpi/core/config';
import { chordKey, chordKeysForTrigger } from '../content/bridge';
import type { KelpiRuntime } from '../state';
import { pluginRequest, usePlugins } from './client';
import { usePluginShortcuts } from './shortcuts';

export function usePluginCommands(runtime: KelpiRuntime, reservedChords: readonly string[], isBlocked?: () => boolean): {
    chords: readonly string[];
    commands: readonly { id: string; title: string; pluginName: string; shortcut?: string | undefined; menu?: 'pane' | 'workspace' | 'both' | 'pane.header'; run(paneID?: string): void }[];
} {
    const { plugins } = usePlugins(runtime);
    const { overrides } = usePluginShortcuts(runtime);
    const blocked = useRef(isBlocked);
    blocked.current = isBlocked;
    const commands = useMemo(() => plugins.filter(plugin => plugin.enabled && plugin.status !== 'failed').flatMap(plugin => plugin.manifest.contributes.commands.map(command => ({
        ...command, shortcut: Object.hasOwn(overrides, command.id) ? overrides[command.id] ?? undefined : command.shortcut, pluginName: plugin.manifest.name,
        run(paneID?: string): void {
            const state = runtime.store.getState();
            const workspaceID = state.ui.activeWorkspaceID ?? state.daemon.state.lastActiveWorkspaceID;
            const workspace = state.daemon.state.workspaces.find(workspace => workspace.id === workspaceID);
            const focused = paneID ?? (state.ui.focusEcho?.workspaceID === workspaceID ? state.ui.focusEcho.paneID : workspace?.focusedPaneID);
            void pluginRequest(runtime, 'run', { command: command.id, ...(workspaceID ? { workspaceID } : {}), ...(focused ? { paneID: focused } : {}) }).catch(error => runtime.store.getState().pushToast({ id: `plugin-command-${command.id}`, kind: 'info', title: command.title, body: error.message, paneID: null, workspaceID: null, createdAt: Date.now() }));
        }
    }))), [runtime, plugins, overrides]);
    const bindings = useMemo(() => {
        const claimed = new Set(reservedChords);
        return commands.flatMap(command => {
            const trigger = command.shortcut ? parseKeyTrigger(command.shortcut) : null;
            if (!trigger || !trigger.modifiers.some(modifier => modifier !== 'shift')) return [];
            const keys = chordKeysForTrigger(canonicalTriggerForPlatform(trigger, /Mac|iPhone|iPad/.test(navigator.platform))).filter(key => !claimed.has(key) && !key.startsWith('0/'));
            for (const key of keys) claimed.add(key);
            return keys.map(key => ({ key, run: command.run }));
        });
    }, [commands, reservedChords]);
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || blocked.current?.()) return;
            const binding = bindings.find(binding => binding.key === chordKey(event));
            if (!binding) return;
            event.preventDefault(); event.stopPropagation(); binding.run();
        };
        // Terminal engines consume keydown at their host; plugin commands share the app's
        // earlier capture boundary, after reserved native bindings and modal guards.
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [bindings]);
    return { commands, chords: bindings.map(binding => binding.key) };
}

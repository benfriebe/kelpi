import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { parseKeyTrigger, canonicalTriggerForPlatform } from '@kelpi/core/config';
import type { PluginContributionInfo, PluginInfo, PluginMenuDefinition } from '@kelpi/protocol';
import { chordKey, chordKeysForTrigger } from '../content/bridge';
import type { KelpiRuntime } from '../state';
import { getCurrentPlugins, pluginRequest, usePlugins } from './client';
import { usePluginShortcuts } from './shortcuts';
import { contributionContext, getPluginContributionState, matchesWhen, resolveContributionItems, resolveContributionMenus, usePluginContributions } from './contributions';

export function usePluginCommands(runtime: KelpiRuntime, reservedChords: readonly string[], isBlocked?: () => boolean) {
    const { plugins } = usePlugins(runtime);
    const { overrides } = usePluginShortcuts(runtime);
    const { states } = usePluginContributions(runtime);
    const mirror = useStore(runtime.store);
    const latest = useRef({ plugins, isBlocked });
    latest.current = { plugins, isBlocked };
    const available = (plugin: PluginInfo): boolean => plugin.enabled && plugin.status !== 'failed';
    const currentStates = (): ReadonlyMap<string, PluginContributionInfo> => new Map(getCurrentPlugins(runtime).map(plugin => [plugin.manifest.id, {
        pluginID: plugin.manifest.id, instanceID: plugin.instanceID, sequence: 0,
        state: getPluginContributionState(runtime, plugin.manifest.id, plugin.instanceID)
    }]));
    const run = (commandID: string, paneID?: string): boolean => {
        if (!runtime.connection.isConnected) return false;
        const plugin = getCurrentPlugins(runtime).find(plugin => available(plugin) && plugin.manifest.contributes.commands.some(command => command.id === commandID));
        const command = plugin?.manifest.contributes.commands.find(command => command.id === commandID);
        if (!plugin || !command) return false;
        const state = runtime.store.getState();
        const workspaceID = state.ui.activeWorkspaceID ?? state.daemon.state.lastActiveWorkspaceID;
        const workspace = paneID === undefined ? state.daemon.state.workspaces.find(workspace => workspace.id === workspaceID)
            : state.daemon.state.workspaces.find(workspace => workspace.panes.some(pane => pane.id === paneID));
        if (paneID !== undefined && !workspace) return false;
        const context = contributionContext(state, getPluginContributionState(runtime, plugin.manifest.id, plugin.instanceID).context, paneID);
        if (!matchesWhen(command.when, context) || !matchesWhen(command.enablement, context)) return false;
        const focused = paneID ?? (state.ui.focusEcho?.workspaceID === workspace?.id ? state.ui.focusEcho?.paneID : workspace?.focusedPaneID);
        void pluginRequest(runtime, 'run', { command: commandID, ...(workspace ? { workspaceID: workspace.id } : {}), ...(focused ? { paneID: focused } : {}) })
            .catch(error => runtime.store.getState().pushToast({ id: `plugin-command-${commandID}`, kind: 'info', title: command.title,
                body: error.message, paneID: null, workspaceID: null, createdAt: Date.now() }));
        return true;
    };
    const runMenu = (placement: PluginMenuDefinition['placement'], id: string, paneID?: string): boolean => {
        const item = resolveContributionMenus(getCurrentPlugins(runtime), currentStates(), runtime.store.getState(), placement, paneID).find(item => item.id === id);
        return item?.enabled ? run(item.command, paneID) : false;
    };
    const runItem = (placement: 'statusbar' | 'workspace.header' | 'pane.header', id: string, paneID?: string): boolean => {
        const item = resolveContributionItems(getCurrentPlugins(runtime), currentStates(), runtime.store.getState(), placement, paneID).find(item => item.id === id);
        return item?.enabled && item.command ? run(item.command, paneID) : false;
    };
    const commands = useMemo(() => plugins.filter(available).flatMap(plugin => plugin.manifest.contributes.commands.map(command => {
        const context = contributionContext(mirror, states.get(plugin.manifest.id)?.state.context);
        return { ...command, shortcut: Object.hasOwn(overrides, command.id) ? overrides[command.id] ?? undefined : command.shortcut,
            pluginName: plugin.manifest.name, visible: matchesWhen(command.when, context), enabled: matchesWhen(command.enablement, context),
            run: (paneID?: string) => run(command.id, paneID) };
    })), [runtime, plugins, overrides, states, mirror]);
    const bindings = useMemo(() => {
        const claimed = new Set(reservedChords);
        return commands.flatMap(command => {
            if (!command.visible || !command.enabled) return [];
            const trigger = command.shortcut ? parseKeyTrigger(command.shortcut) : null;
            if (!trigger || !trigger.modifiers.some(modifier => modifier !== 'shift')) return [];
            const keys = chordKeysForTrigger(canonicalTriggerForPlatform(trigger, /Mac|iPhone|iPad/.test(navigator.platform)))
                .filter(key => !claimed.has(key) && !key.startsWith('0/'));
            for (const key of keys) claimed.add(key);
            return keys.map(key => ({ key, run: command.run }));
        });
    }, [commands, reservedChords]);
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || latest.current.isBlocked?.()) return;
            const binding = bindings.find(binding => binding.key === chordKey(event));
            // A stale shortcut must recheck its conditions before claiming the key.
            if (!binding || !binding.run()) return;
            event.preventDefault(); event.stopPropagation();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [bindings]);
    return {
        commands, chords: bindings.map(binding => binding.key), states, plugins, run, runItem,
        menu: (placement: PluginMenuDefinition['placement'], paneID?: string) => resolveContributionMenus(plugins, states, mirror, placement, paneID).map(item => ({
            ...item, shortcut: commands.find(command => command.id === item.command)?.shortcut,
            pluginName: plugins.find(plugin => plugin.manifest.id === item.pluginID)?.manifest.name ?? item.pluginID,
            run: () => runMenu(placement, item.id, paneID)
        })),
        items: (placement: 'statusbar' | 'workspace.header' | 'pane.header', paneID?: string) => resolveContributionItems(plugins, states, mirror, placement, paneID)
    };
}

import { useSyncExternalStore } from 'react';
import {
    decodePluginItemPatch, isPluginContextKey, isPluginID, PLUGIN_MAX_CONTRIBUTION_BYTES, pluginObject, pluginRecord,
    type PluginContextValue, type PluginContributionInfo, type PluginContributionState, type PluginInfo,
    type PluginItemDefinition, type PluginItemTone, type PluginMenuDefinition, type PluginWhen
} from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import type { KelpiState } from '../state/store';
import { selectActiveWorkspaceID } from '../state/selectors';
import { pluginRequest } from './client';

const EMPTY_STATE: PluginContributionState = Object.freeze({ context: Object.freeze({}), items: Object.freeze({}) });
const EMPTY_STATES: ReadonlyMap<string, PluginContributionInfo> = new Map();
const MAX_PLUGIN_STATES = 1024;
export interface PluginContributionsSnapshot {
    readonly states: ReadonlyMap<string, PluginContributionInfo>;
    readonly error: string | null;
}
const EMPTY_SNAPSHOT: PluginContributionsSnapshot = { states: EMPTY_STATES, error: null };
const available = (plugin: PluginInfo) => plugin.enabled && plugin.status !== 'failed' && plugin.status !== 'disabled';

function contributionInfo(raw: unknown): PluginContributionInfo {
    const row = pluginObject(raw);
    if (typeof row['pluginID'] !== 'string' || !isPluginID(row['pluginID']) || typeof row['instanceID'] !== 'string' || !row['instanceID'] || row['instanceID'].length > 200 || !Number.isSafeInteger(row['sequence']) || Number(row['sequence']) < 0) throw new Error('Invalid plugin contribution identity.');
    const state = pluginObject(row['state']), context = pluginObject(state['context']), items = pluginObject(state['items']);
    if (Object.keys(context).length > 64 || Object.keys(items).length > 100 || new TextEncoder().encode(JSON.stringify(state)).byteLength > PLUGIN_MAX_CONTRIBUTION_BYTES) throw new Error('Plugin contribution state exceeds its limit.');
    for (const [key, value] of Object.entries(context)) {
        if (!isPluginContextKey(key) || !(typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 4096)) throw new Error('Invalid plugin contribution context.');
    }
    const patches = Object.fromEntries(Object.entries(items).map(([id, value]) => {
        if (!id.startsWith(`${row['pluginID']}.`) || !isPluginID(id)) throw new Error('Invalid plugin contribution item owner.');
        return [id, Object.freeze(decodePluginItemPatch(value))];
    }));
    return Object.freeze({ pluginID: row['pluginID'], instanceID: row['instanceID'], sequence: Number(row['sequence']),
        state: Object.freeze({ context: Object.freeze({ ...context }) as PluginContributionState['context'], items: Object.freeze(patches) }) });
}

/** One live value per plugin and one queued refresh per runtime, regardless of mounted hosts. */
function createContributionStore(runtime: KelpiRuntime) {
    let snapshot = EMPTY_SNAPSHOT, active = false, generation = 0, requestID = 0;
    let inFlight: number | null = null, refreshWanted = false, notificationQueued = false;
    let epoch: string | null = null, lastSequence: number | null = null;
    let instances: Map<string, string> | null = null;
    let stops: Array<() => void> = [];
    const listeners = new Set<() => void>();
    const publish = (states: ReadonlyMap<string, PluginContributionInfo>, error: string | null = null): void => {
        snapshot = { states, error };
        if (notificationQueued) return;
        notificationQueued = true;
        queueMicrotask(() => { notificationQueued = false; for (const listener of listeners) listener(); });
    };
    const allowed = (entry: PluginContributionInfo): boolean => instances === null || instances.get(entry.pluginID) === entry.instanceID;
    const refresh = (): void => {
        if (!active || !runtime.connection.isConnected) return;
        refreshWanted = true;
        if (inFlight !== null) return;
        refreshWanted = false;
        const token = ++requestID, requestedGeneration = generation, before = snapshot.states;
        inFlight = token;
        void pluginRequest(runtime, 'contributions').then(raw => {
            if (!active || inFlight !== token || generation !== requestedGeneration) return;
            if (!Array.isArray(raw) || raw.length > MAX_PLUGIN_STATES) throw new Error('Invalid plugin contribution snapshot.');
            const rows = raw.map(contributionInfo);
            if (new Set(rows.map(row => row.pluginID)).size !== rows.length) throw new Error('Duplicate plugin contribution owner.');
            const next = new Map<string, PluginContributionInfo>();
            for (const entry of rows) {
                if (!allowed(entry)) continue;
                const current = snapshot.states.get(entry.pluginID);
                next.set(entry.pluginID, current && current.sequence >= entry.sequence ? current : entry);
            }
            // A full update arriving during this request wins even when the older snapshot
            // did not contain its plugin yet. Removed/retired owners were filtered above.
            for (const [id, current] of snapshot.states) if (allowed(current) && current !== before.get(id) && !next.has(id)) next.set(id, current);
            publish(next);
        }).catch(error => {
            if (active && inFlight === token && generation === requestedGeneration) publish(snapshot.states, error instanceof Error ? error.message : String(error));
        }).finally(() => {
            if (inFlight !== token) return;
            inFlight = null;
            if (refreshWanted) refresh();
        });
    };
    const invalidate = (): void => { generation += 1; publish(EMPTY_STATES); refresh(); };
    const start = (): void => {
        active = true;
        stops = [runtime.connection.on('status', status => {
            if (status === 'connected') refresh();
            else {
                generation += 1; inFlight = null; refreshWanted = false; epoch = null; lastSequence = null; instances = null;
                publish(EMPTY_STATES);
            }
        }), runtime.connection.on('resync-required', invalidate), runtime.connection.on('message', message => {
            if (message['type'] === 'plugins-changed' && Array.isArray(message['plugins'])) {
                instances = new Map((message['plugins'] as unknown as PluginInfo[]).filter(available).map(plugin => [plugin.manifest.id, plugin.instanceID]));
                if (typeof message['epoch'] === 'string' && epoch !== null && epoch !== message['epoch']) { lastSequence = null; invalidate(); }
                if (typeof message['epoch'] === 'string') epoch = message['epoch'];
                publish(new Map([...snapshot.states].filter(([, entry]) => allowed(entry))));
                refresh();
                return;
            }
            if (message['type'] !== 'plugin-event' || !pluginRecord(message['event'])) return;
            const event = message['event'];
            if (typeof event['epoch'] !== 'string' || !Number.isSafeInteger(event['sequence']) || Number(event['sequence']) < 0) return;
            const sequence = Number(event['sequence']);
            const changedEpoch = epoch !== null && epoch !== event['epoch'];
            if (!changedEpoch && lastSequence !== null && sequence <= lastSequence && event['name'] !== 'gap') return;
            const gap = event['name'] === 'gap' || changedEpoch || lastSequence !== null && sequence > lastSequence + 1;
            if (changedEpoch) instances = null;
            epoch = event['epoch']; lastSequence = changedEpoch ? sequence : Math.max(lastSequence ?? sequence, sequence);
            if (gap) invalidate();
            if (event['name'] !== 'plugin.contributions.changed') return;
            try {
                const entry = contributionInfo(event['data']);
                if (entry.sequence !== sequence || !allowed(entry)) return;
                const current = snapshot.states.get(entry.pluginID);
                if (current && current.sequence >= entry.sequence) return;
                const next = new Map(snapshot.states); next.set(entry.pluginID, entry);
                if (next.size > MAX_PLUGIN_STATES) throw new Error('Too many plugin contribution owners.');
                publish(next);
            } catch (error) { invalidate(); publish(snapshot.states, error instanceof Error ? error.message : String(error)); }
        })];
        refresh();
    };
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
            listeners.add(listener);
            if (!active) start();
            return () => {
                listeners.delete(listener);
                if (listeners.size) return;
                active = false; generation += 1; inFlight = null; refreshWanted = false;
                for (const stop of stops) stop();
                stops = []; instances = null; epoch = null; lastSequence = null; snapshot = EMPTY_SNAPSHOT;
            };
        }
    };
}
const stores = new WeakMap<KelpiRuntime, ReturnType<typeof createContributionStore>>();
function contributionStore(runtime: KelpiRuntime) {
    let store = stores.get(runtime);
    if (!store) { store = createContributionStore(runtime); stores.set(runtime, store); }
    return store;
}
export function usePluginContributions(runtime: KelpiRuntime): PluginContributionsSnapshot {
    const store = contributionStore(runtime);
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
/** Synchronous current data for retained callbacks; never returns another plugin instance. */
export function getPluginContributionState(runtime: KelpiRuntime, pluginID: string, instanceID: string): PluginContributionState {
    if (!runtime.connection.isConnected) return EMPTY_STATE;
    const entry = stores.get(runtime)?.getSnapshot().states.get(pluginID);
    return entry?.instanceID === instanceID ? entry.state : EMPTY_STATE;
}

export type ContributionContext = Readonly<Record<string, PluginContextValue | null>>;
export function matchesWhen(condition: PluginWhen | undefined, context: ContributionContext): boolean {
    return condition === undefined || Object.entries(condition).every(([key, value]) => (Object.hasOwn(context, key) ? context[key] : null) === value);
}
/** Explicit panes resolve their real owner. Agent presence includes the last-known identity. */
export function contributionContext(state: KelpiState, pluginContext: PluginContributionState['context'] = {}, paneID?: string, workspaceID?: string): ContributionContext {
    const activeID = selectActiveWorkspaceID(state);
    const workspaces = state.daemon.state.workspaces;
    let workspace = paneID === undefined ? workspaces.find(workspace => workspace.id === (workspaceID ?? activeID))
        : workspaces.find(workspace => [...workspace.panes, ...workspace.parkedPanes].some(pane => pane.id === paneID));
    if (workspaceID !== undefined && workspace?.id !== workspaceID) workspace = undefined;
    const focused = workspace && (state.ui.focusEcho?.workspaceID === workspace.id ? state.ui.focusEcho.paneID : workspace.focusedPaneID);
    const pane = workspace && [...workspace.panes, ...workspace.parkedPanes].find(pane => pane.id === (paneID ?? focused));
    return { ...Object.fromEntries(Object.entries(pluginContext).map(([key, value]) => [`context.${key}`, value])),
        connection: state.ui.connection, 'workspace.exists': workspace !== undefined, 'workspace.hasRepos': (workspace?.repoAssociations.length ?? 0) > 0,
        'pane.exists': pane !== undefined, 'pane.type': pane?.type ?? null,
        'pane.hasAgent': pane !== undefined && (pane.agentKind !== null || pane.agentSessionID !== null),
        'pane.focused': pane !== undefined && workspace?.id === activeID && pane.id === focused };
}

function stateFor(plugin: PluginInfo, states: ReadonlyMap<string, PluginContributionInfo>): PluginContributionState {
    const state = states.get(plugin.manifest.id);
    return state?.instanceID === plugin.instanceID ? state.state : EMPTY_STATE;
}
export interface ResolvedContributionItem {
    readonly id: string;
    readonly pluginID: string;
    readonly command?: string;
    readonly text: string;
    readonly tooltip?: string;
    readonly badge?: string;
    readonly tone: PluginItemTone;
    readonly enabled: boolean;
    readonly order: number;
}
export function resolveContributionItems(plugins: readonly PluginInfo[], states: ReadonlyMap<string, PluginContributionInfo>, state: KelpiState, placement: PluginItemDefinition['placement'], paneID?: string, workspaceID?: string): readonly ResolvedContributionItem[] {
    return plugins.filter(available).flatMap(plugin => {
        const dynamic = stateFor(plugin, states), context = contributionContext(state, dynamic.context, paneID, workspaceID);
        return (plugin.manifest.contributes.items ?? []).flatMap(item => {
            if (item.placement !== placement) return [];
            const patch = dynamic.items[item.id] ?? {}, command = plugin.manifest.contributes.commands.find(command => command.id === item.command);
            if (patch.visible === false || !matchesWhen(item.when, context) || !matchesWhen(command?.when, context)) return [];
            return [{ id: item.id, pluginID: plugin.manifest.id, ...(item.command ? { command: item.command } : {}),
                text: patch.text ?? item.text, ...((patch.tooltip ?? item.tooltip) === undefined ? {} : { tooltip: patch.tooltip ?? item.tooltip }),
                ...((patch.badge ?? item.badge) === undefined ? {} : { badge: patch.badge ?? item.badge }), tone: patch.tone ?? item.tone ?? 'default',
                enabled: patch.enabled !== false && matchesWhen(item.enablement, context) && matchesWhen(command?.enablement, context) && (!item.command || command !== undefined), order: item.order ?? 0 }];
        });
    }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
export interface ResolvedContributionMenu {
    readonly id: string;
    readonly pluginID: string;
    readonly command: string;
    readonly title: string;
    readonly placement: PluginMenuDefinition['placement'];
    readonly group?: string;
    readonly order: number;
    readonly enabled: boolean;
}
export function resolveContributionMenus(plugins: readonly PluginInfo[], states: ReadonlyMap<string, PluginContributionInfo>, state: KelpiState, placement: PluginMenuDefinition['placement'], paneID?: string, workspaceID?: string): readonly ResolvedContributionMenu[] {
    const entries = plugins.filter(available).flatMap(plugin => {
        const context = contributionContext(state, stateFor(plugin, states).context, paneID, workspaceID);
        return plugin.manifest.contributes.commands.flatMap(command => {
            if (!matchesWhen(command.when, context)) return [];
            let rules = (plugin.manifest.contributes.menus ?? []).filter(menu => menu.command === command.id && menu.placement === placement);
            if (!rules.length && (placement === 'palette' || command.menu === placement || command.menu === 'both' && (placement === 'pane' || placement === 'workspace'))) rules = [{ id: `${command.id}:${placement}`, command: command.id, placement }];
            return rules.filter(rule => matchesWhen(rule.when, context)).map(rule => ({
                id: rule.id, pluginID: plugin.manifest.id, command: command.id, title: command.title, placement,
                ...(rule.group === undefined ? {} : { group: rule.group }), order: rule.order ?? 0,
                enabled: matchesWhen(command.enablement, context) && matchesWhen(rule.enablement, context)
            }));
        });
    }).sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.order - b.order || a.id.localeCompare(b.id));
    const seen = new Set<string>();
    return entries.filter(entry => { const key = `${entry.command}:${entry.placement}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

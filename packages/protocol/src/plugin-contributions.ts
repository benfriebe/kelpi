import { pluginJSON, pluginObject, type PluginManifest, type PluginSettingDefinition } from './plugins.js';

export type PluginContextValue = string | number | boolean;
/** Equality conjunction. Null matches an absent fact; there is no expression evaluator. */
export type PluginWhen = Readonly<Record<string, PluginContextValue | null>>;
export interface PluginMenuDefinition {
    readonly id: string;
    readonly command: string;
    readonly placement: 'pane' | 'workspace' | 'pane.header' | 'palette';
    readonly group?: string;
    readonly order?: number;
    readonly when?: PluginWhen;
    readonly enablement?: PluginWhen;
}
export type PluginItemTone = 'default' | 'info' | 'success' | 'warning' | 'error';
export interface PluginItemDefinition {
    readonly id: string;
    readonly placement: 'statusbar' | 'pane.header' | 'workspace.header';
    readonly text: string;
    readonly tooltip?: string;
    readonly badge?: string;
    readonly tone?: PluginItemTone;
    readonly command?: string;
    readonly order?: number;
    readonly when?: PluginWhen;
    readonly enablement?: PluginWhen;
}
export interface PluginItemPatch {
    readonly text?: string;
    readonly tooltip?: string;
    readonly badge?: string;
    readonly tone?: PluginItemTone;
    readonly visible?: boolean;
    readonly enabled?: boolean;
}
export interface PluginContributionState {
    readonly context: Readonly<Record<string, PluginContextValue>>;
    readonly items: Readonly<Record<string, PluginItemPatch>>;
}
export interface PluginContributionInfo {
    readonly pluginID: string;
    readonly instanceID: string;
    /** Last complete contribution update/reset, in the daemon's PluginEvent sequence. */
    readonly sequence: number;
    readonly state: PluginContributionState;
}
export interface PluginSettingGroupDefinition {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly order?: number;
}

export const PLUGIN_MAX_CONTRIBUTION_BYTES = 32 * 1024;
export function isPluginContextKey(value: string): boolean {
    return /^[a-z][a-zA-Z0-9.-]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
}
export function pluginContributionText(raw: unknown, field: string, max: number, allowEmpty = false): string {
    if (typeof raw !== 'string' || (!allowEmpty && !raw.trim()) || raw.length > max) throw new Error(`invalid plugin ${field}`);
    return raw;
}
export function pluginContributionOrder(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || Math.abs(raw) > 10_000) throw new Error('invalid plugin contribution order');
    return raw;
}
function contextValue(raw: unknown): PluginContextValue {
    if (typeof raw === 'boolean' || typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.length <= 4096) return raw;
    throw new Error('plugin context values must be finite scalars; strings are limited to 4096 characters');
}
export function decodePluginWhen(raw: unknown): PluginWhen {
    const values = pluginObject(raw);
    if (Object.keys(values).length > 32) throw new Error('plugin conditions allow at most 32 predicates');
    const result: Record<string, PluginContextValue | null> = {};
    for (const [key, value] of Object.entries(values)) {
        if (key.startsWith('context.') && isPluginContextKey(key.slice(8))) result[key] = value === null ? null : contextValue(value);
        else if (['workspace.exists', 'workspace.hasRepos', 'pane.exists', 'pane.hasAgent', 'pane.focused'].includes(key)) {
            if (typeof value !== 'boolean' && value !== null) throw new Error(`plugin condition ${key} requires boolean or null`);
            result[key] = value;
        } else if (key === 'connection') {
            if (value !== null && (typeof value !== 'string' || !['idle', 'connecting', 'connected', 'reconnecting', 'closed', 'rejected'].includes(value))) throw new Error('invalid plugin connection condition');
            result[key] = value as string | null;
        } else if (key === 'pane.type') {
            if (value !== null && (typeof value !== 'string' || !['shell', 'markdown', 'scratchpad', 'diff', 'web', 'plugin'].includes(value))) throw new Error('invalid plugin pane type condition');
            result[key] = value as string | null;
        } else throw new Error(`unknown plugin condition key: ${key}`);
    }
    return result;
}
export function decodePluginItemPatch(raw: unknown): PluginItemPatch {
    const value = pluginObject(raw);
    const result: { text?: string; tooltip?: string; badge?: string; tone?: PluginItemTone; visible?: boolean; enabled?: boolean } = {};
    for (const [key, field] of Object.entries(value)) {
        if (key === 'text') result.text = pluginContributionText(field, 'item text', 200, true);
        else if (key === 'tooltip') result.tooltip = pluginContributionText(field, 'item tooltip', 1000, true);
        else if (key === 'badge') result.badge = pluginContributionText(field, 'item badge', 32, true);
        else if (key === 'tone') {
            if (typeof field !== 'string' || !['default', 'info', 'success', 'warning', 'error'].includes(field)) throw new Error('invalid plugin item tone');
            result.tone = field as PluginItemTone;
        } else if (key === 'visible' || key === 'enabled') {
            if (typeof field !== 'boolean') throw new Error(`plugin item ${key} must be boolean`);
            result[key] = field;
        } else throw new Error(`unknown plugin item patch field: ${key}`);
    }
    return result;
}
/** Validate a full next value before the caller changes or publishes any state. */
export function patchPluginContributionState(manifest: PluginManifest, current: PluginContributionState, raw: unknown): PluginContributionState {
    const patch = pluginObject(raw);
    if (Object.keys(patch).some(key => key !== 'context' && key !== 'items')) throw new Error('unknown plugin contribution patch field');
    const context = { ...current.context }, items = { ...current.items };
    if (patch['context'] !== undefined) for (const [key, value] of Object.entries(pluginObject(patch['context']))) {
        if (!isPluginContextKey(key)) throw new Error('invalid plugin context key');
        if (value === null) delete context[key]; else context[key] = contextValue(value);
    }
    if (Object.keys(context).length > 64) throw new Error('plugin context allows at most 64 keys');
    if (patch['items'] !== undefined) for (const [id, value] of Object.entries(pluginObject(patch['items']))) {
        if (!manifest.contributes.items?.some(item => item.id === id)) throw new Error(`plugin item is not declared: ${id}`);
        if (value === null) delete items[id]; else items[id] = { ...items[id], ...decodePluginItemPatch(value) };
    }
    const state = { context, items };
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > PLUGIN_MAX_CONTRIBUTION_BYTES) throw new Error('plugin contribution state exceeds 32 KiB');
    return pluginJSON(state) as unknown as PluginContributionState;
}

/** Defaults, persisted values, and writes use the same declared setting contract. */
export function pluginSettingValue(setting: PluginSettingDefinition, raw: unknown): PluginContextValue {
    if (typeof raw !== setting.type || typeof raw === 'number' && !Number.isFinite(raw)) throw new Error('invalid plugin setting type');
    if (setting.enum && !setting.enum.includes(raw as PluginContextValue)) throw new Error('plugin setting must be one of its declared choices');
    if (typeof raw === 'number' && ((setting.min !== undefined && raw < setting.min) || (setting.max !== undefined && raw > setting.max))) throw new Error('plugin setting is outside its declared range');
    return raw as PluginContextValue;
}

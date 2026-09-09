/** Public plugin contracts. JSON only: no daemon, React, Electron or Node dependencies. */
import type { JsonObject, JsonValue } from './json.js';
import { isPluginVersion, isPluginVersionRange } from './plugin-dependencies.js';
import { decodePluginWhen, decodePluginItemPatch, pluginContributionOrder, pluginContributionText, pluginSettingValue, type PluginWhen, type PluginMenuDefinition, type PluginItemDefinition, type PluginSettingGroupDefinition, type PluginContextValue } from './plugin-contributions.js';

export const PLUGIN_API_VERSION = 1;
export const PLUGIN_MAX_JSON_BYTES = 256 * 1024;
export const PLUGIN_PLACEMENTS = ['pane', 'sidebar.primary', 'sidebar.secondary', 'panel.bottom', 'topbar', 'statusbar', 'workspace', 'settings', 'document.markdown', 'document.scratchpad', 'document.diff'] as const;
export type PluginBuiltinPlacement = (typeof PLUGIN_PLACEMENTS)[number];
export type PluginPlacement = PluginBuiltinPlacement | `${string}.${string}`;
export interface PluginContainerSlot {
    readonly id: `${string}.${string}`;
    readonly title: string;
    readonly defaultView?: string;
    readonly weight?: number;
}
export interface PluginContainerDefinition {
    readonly id: string;
    readonly title: string;
    readonly placements: readonly Exclude<PluginPlacement, 'pane'>[];
    readonly layout: 'row' | 'column' | 'tabs';
    readonly slots: readonly PluginContainerSlot[];
}
export interface PluginDependency {
    readonly pluginID: string;
    /** Exact semver, ^version, ~version, or *. */
    readonly version: string;
    readonly optional?: boolean;
}
export interface PluginHookDefinition {
    readonly id: string;
    readonly phase: 'before' | 'after';
    readonly commands: readonly string[];
    readonly priority?: number;
    readonly timeoutMs?: number;
}
export interface PluginServiceDefinition {
    readonly id: string;
    readonly title: string;
    readonly version: number;
    readonly methods: readonly string[];
}
export interface PluginProviderDefinition extends Omit<PluginServiceDefinition, 'id'> {
    readonly id: string;
    readonly service: string;
    readonly timeoutMs?: number;
}
export interface PluginPaneDescriptor {
    readonly pluginID: string;
    readonly viewID: string;
    readonly stateVersion: number;
    readonly state: JsonObject;
}
export interface PluginViewDefinition {
    readonly id: string;
    readonly title: string;
    readonly entry: string;
    readonly placements: readonly PluginPlacement[];
    readonly stateVersion: number;
}
export interface PluginCommandDefinition {
    readonly id: string;
    readonly title: string;
    readonly shortcut?: string;
    readonly menu?: 'pane' | 'workspace' | 'both' | 'pane.header';
    readonly when?: PluginWhen;
    readonly enablement?: PluginWhen;
}
export interface PluginSettingDefinition {
    readonly title: string;
    readonly type: 'string' | 'number' | 'boolean';
    readonly default: string | number | boolean;
    readonly group?: string;
    readonly description?: string;
    readonly order?: number;
    readonly enum?: readonly PluginContextValue[];
    readonly min?: number;
    readonly max?: number;
}
export interface PluginManifest {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly apiVersion: typeof PLUGIN_API_VERSION;
    readonly trust: 'full';
    readonly backend?: string;
    readonly activation: 'startup' | 'on-demand';
    readonly dependencies?: readonly PluginDependency[];
    readonly contributes: {
        readonly views: readonly PluginViewDefinition[];
        readonly commands: readonly PluginCommandDefinition[];
        readonly settings: Readonly<Record<string, PluginSettingDefinition>>;
        readonly containers?: readonly PluginContainerDefinition[];
        readonly hooks?: readonly PluginHookDefinition[];
        readonly services?: readonly PluginServiceDefinition[];
        readonly providers?: readonly PluginProviderDefinition[];
        readonly menus?: readonly PluginMenuDefinition[];
        readonly items?: readonly PluginItemDefinition[];
        readonly settingGroups?: readonly PluginSettingGroupDefinition[];
    };
}
export interface PluginInfo {
    readonly manifest: PluginManifest;
    readonly revision: string;
    /** Changes on reload/failure even when the installed package bytes are identical. */
    readonly instanceID: string;
    readonly enabled: boolean;
    readonly status: 'inactive' | 'starting' | 'running' | 'failed' | 'disabled';
    readonly error: string | null;
}
export interface PluginContext {
    readonly daemonID: string;
    readonly clientID?: string;
    readonly windowID?: string;
    readonly workspaceID?: string;
    readonly paneID?: string;
    readonly viewID?: string;
}
export interface PluginHookInvocation {
    readonly id: string;
    readonly command: string;
    readonly payload: JsonObject;
    readonly context: PluginContext;
    readonly source: 'cli' | 'ui' | 'plugin';
    readonly phase: 'before' | 'after';
    readonly result?: JsonValue;
}
export type PluginHookDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };
export interface PluginEvent {
    readonly epoch: string;
    readonly sequence: number;
    readonly pluginID?: string;
    readonly name: string;
    readonly data: JsonValue;
}
/** One bounded queue per subscriber. Slow readers get an explicit resnapshot marker. */
export class PluginEventBuffer {
    private entries: Array<{ event: PluginEvent; bytes: number }> = [];
    private bytes = 0;
    constructor(private readonly maxBytes = 512 * 1024, private readonly maxItems = 32) {}
    push(event: PluginEvent): void {
        const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
        if (bytes > this.maxBytes) { this.gap(event, event.sequence); return; }
        if (this.bytes + bytes > this.maxBytes || this.entries.length >= this.maxItems) {
            this.gap(event, event.sequence - 1);
            if (this.bytes + bytes > this.maxBytes) { this.gap(event, event.sequence); return; }
        }
        this.entries.push({ event, bytes }); this.bytes += bytes;
    }
    private gap(event: PluginEvent, sequence: number): void {
        const marker: PluginEvent = { epoch: event.epoch, sequence, name: 'gap', data: null };
        this.bytes = new TextEncoder().encode(JSON.stringify(marker)).byteLength;
        this.entries = [{ event: marker, bytes: this.bytes }];
    }
    shift(): PluginEvent | undefined {
        const next = this.entries.shift(); if (!next) return undefined;
        this.bytes -= next.bytes; return next.event;
    }
}
export interface PluginWireMessage {
    readonly command: 'plugin';
    readonly action: string;
    /** JSON string keeps the legacy flat wire field grammar unchanged. */
    readonly text: string;
}

export function pluginRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isPluginID(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value) && value.length <= 160;
}
export function isPluginPlacement(value: unknown): value is PluginPlacement {
    return (PLUGIN_PLACEMENTS as readonly unknown[]).includes(value) || (isPluginID(value) && !value.startsWith('kelpi.'));
}
export function pluginJSON(value: unknown): JsonValue {
    const seen = new Set<object>();
    const walk = (item: unknown, depth: number): void => {
        if (depth > 32) throw new Error('plugin JSON is too deeply nested');
        if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
        if (typeof item === 'number' && Number.isFinite(item)) return;
        if (typeof item !== 'object' || item === undefined) throw new Error('expected JSON data');
        if (seen.has(item)) throw new Error('cyclic plugin JSON');
        seen.add(item);
        if (Array.isArray(item)) for (const value of item) walk(value, depth + 1);
        else {
            if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('expected a plain JSON object');
            for (const [key, value] of Object.entries(item)) {
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('reserved JSON key');
                walk(value, depth + 1);
            }
        }
        seen.delete(item);
    };
    walk(value, 0);
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength > PLUGIN_MAX_JSON_BYTES) throw new Error('plugin JSON exceeds 256 KiB');
    return JSON.parse(encoded) as JsonValue;
}
export function pluginObject(value: unknown): JsonObject {
    if (!pluginRecord(value)) throw new Error('expected a plugin JSON object');
    return pluginJSON(value) as JsonObject;
}
export function pluginAssetPath(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..') || /[:?#%]/.test(value)) {
        throw new Error('plugin entry must be a relative path within its package');
    }
    return value;
}
export function decodePluginManifest(raw: unknown): PluginManifest {
    const value = pluginObject(raw);
    if (!isPluginID(value['id'])) throw new Error('plugin id must be namespaced, e.g. example.agent-board');
    const id = value['id'];
    if (id.startsWith('kelpi.')) throw new Error('kelpi.* is reserved for bundled features');
    if (value['apiVersion'] !== PLUGIN_API_VERSION) throw new Error(`unsupported plugin API version (expected ${PLUGIN_API_VERSION})`);
    if (value['trust'] !== 'full') throw new Error('this version supports explicitly trusted plugins only; set trust to full');
    const label = (item: unknown, field: string): string => {
        if (typeof item !== 'string' || !item.trim() || item.length > 200) throw new Error(`invalid plugin ${field}`);
        return item;
    };
    const version = label(value['version'], 'version');
    if (!isPluginVersion(version)) throw new Error('plugin version must be semver');
    const contributes = pluginObject(value['contributes'] ?? {});
    const ids = new Set<string>();
    const contributionID = (raw: unknown): string => {
        if (!isPluginID(raw) || !raw.startsWith(`${id}.`) || ids.has(raw)) throw new Error('contribution id must be unique and within the plugin namespace');
        ids.add(raw); return raw;
    };
    const array = (value: unknown): unknown[] => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > 100) throw new Error('expected at most 100 contributions');
        return value;
    };
    const dependencyIDs = new Set<string>();
    const dependencies = array(value['dependencies']).map((raw): PluginDependency => {
        const dependency = pluginObject(raw);
        const pluginID = dependency['pluginID'];
        if (!isPluginID(pluginID) || pluginID === id || pluginID.startsWith('kelpi.') || dependencyIDs.has(pluginID)) throw new Error('dependency must name another unique plugin');
        if (!isPluginVersionRange(dependency['version'])) throw new Error('dependency version must be exact semver, ^version, ~version, or *');
        if (dependency['optional'] !== undefined && typeof dependency['optional'] !== 'boolean') throw new Error('dependency optional must be boolean');
        dependencyIDs.add(pluginID);
        return { pluginID, version: dependency['version'], ...(dependency['optional'] === undefined ? {} : { optional: dependency['optional'] }) };
    });
    const foreignReference = (reference: string): boolean => reference.startsWith(`${id}.`) || dependencies.some(dependency => reference.startsWith(`${dependency.pluginID}.`));
    const placements = (raw: unknown): PluginPlacement[] => {
        const values = array(raw);
        if (!values.length || values.some(place => !isPluginPlacement(place) || (!(PLUGIN_PLACEMENTS as readonly unknown[]).includes(place) && !foreignReference(place)))) throw new Error('invalid plugin view placements; custom slots require an owning plugin or a declared dependency');
        return [...new Set(values)] as PluginPlacement[];
    };
    const boundedNumber = (raw: unknown, field: string, min: number, max: number, integer = true): number => {
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max || (integer && !Number.isSafeInteger(raw))) throw new Error(`invalid plugin ${field}`);
        return raw;
    };
    const methods = (raw: unknown): string[] => {
        const values = array(raw);
        if (!values.length || values.some(method => typeof method !== 'string' || !/^[a-z][a-zA-Z0-9.-]{0,99}$/.test(method))) throw new Error('service methods must be named explicitly');
        if (new Set(values).size !== values.length) throw new Error('duplicate service method');
        return values as string[];
    };
    const views = array(contributes['views']).map(raw => {
        const view = pluginObject(raw);
        const stateVersion = view['stateVersion'] ?? 1;
        if (typeof stateVersion !== 'number' || !Number.isSafeInteger(stateVersion) || stateVersion < 1) throw new Error('invalid view state version');
        const entry = pluginAssetPath(view['entry']);
        if (!entry.startsWith('ui/') || !entry.endsWith('.html')) throw new Error('view entry must be an HTML file under ui/');
        return { id: contributionID(view['id']), title: label(view['title'], 'view title'), entry, placements: placements(view['placements']), stateVersion };
    });
    const containers = array(contributes['containers']).map((raw): PluginContainerDefinition => {
        const container = pluginObject(raw);
        const places = placements(container['placements']);
        if (places.includes('pane') || places.some(place => place.startsWith('document.'))) throw new Error('containers require workbench placements; pane views own their individual saved state');
        const layout = container['layout'];
        if (layout !== 'row' && layout !== 'column' && layout !== 'tabs') throw new Error('container layout must be row, column, or tabs');
        const containerID = contributionID(container['id']);
        const slots = array(container['slots']).map((raw): PluginContainerSlot => {
            const slot = pluginObject(raw);
            const defaultView = slot['defaultView'];
            if (defaultView !== undefined && (!isPluginID(defaultView) || (!defaultView.startsWith('kelpi.') && !foreignReference(defaultView)) || ['kelpi.shell', 'kelpi.markdown', 'kelpi.scratchpad', 'kelpi.diff', 'kelpi.web'].includes(defaultView))) throw new Error('invalid container default view');
            return { id: contributionID(slot['id']) as `${string}.${string}`, title: label(slot['title'], 'slot title'),
                ...(defaultView === undefined ? {} : { defaultView }),
                ...(slot['weight'] === undefined ? {} : { weight: boundedNumber(slot['weight'], 'slot weight', 0.1, 100, false) }) };
        });
        if (!slots.length || slots.length > 32) throw new Error('containers require 1 to 32 slots');
        return { id: containerID, title: label(container['title'], 'container title'), placements: places as Exclude<PluginPlacement, 'pane'>[], layout, slots };
    });
    const ownedViews = new Map([...views, ...containers].map(view => [view.id, view]));
    for (const container of containers) for (const slot of container.slots) {
        if (!slot.defaultView || !slot.defaultView.startsWith(`${id}.`)) continue;
        const target = ownedViews.get(slot.defaultView);
        if (!target || !target.placements.includes(slot.id as Exclude<PluginPlacement, 'pane'>)) throw new Error(`container default ${slot.defaultView} must support slot ${slot.id}`);
    }
    const containerMap = new Map(containers.map(container => [container.id, container]));
    const containerDepths = new Map<string, number>();
    const checkContainer = (containerID: string, trail: readonly string[]): number => {
        if (trail.includes(containerID)) throw new Error(`container default cycle: ${[...trail, containerID].join(' → ')}`);
        const known = containerDepths.get(containerID);
        if (known !== undefined) return known;
        let depth = 1;
        for (const slot of containerMap.get(containerID)?.slots ?? []) if (slot.defaultView && containerMap.has(slot.defaultView)) depth = Math.max(depth, 1 + checkContainer(slot.defaultView, [...trail, containerID]));
        if (depth > 16) throw new Error('containers exceed 16 levels');
        containerDepths.set(containerID, depth);
        return depth;
    };
    for (const container of containers) checkContainer(container.id, []);
    const commands = array(contributes['commands']).map((raw): PluginCommandDefinition => {
        const cmd = pluginObject(raw);
        const menu = cmd['menu'];
        if (menu !== undefined && menu !== 'pane' && menu !== 'workspace' && menu !== 'both' && menu !== 'pane.header') throw new Error('invalid plugin menu');
        return { id: contributionID(cmd['id']), title: label(cmd['title'], 'command title'), ...(cmd['shortcut'] === undefined ? {} : { shortcut: label(cmd['shortcut'], 'shortcut') }), ...(menu === undefined ? {} : { menu }),
            ...(cmd['when'] === undefined ? {} : { when: decodePluginWhen(cmd['when']) }), ...(cmd['enablement'] === undefined ? {} : { enablement: decodePluginWhen(cmd['enablement']) }) };
    });
    const commandReference = (raw: unknown): string => {
        if (typeof raw !== 'string' || !commands.some(command => command.id === raw)) throw new Error('plugin UI command must be owned and declared');
        return raw;
    };
    const menus = array(contributes['menus']).map((raw): PluginMenuDefinition => {
        const menu = pluginObject(raw);
        const placement = menu['placement'];
        if (placement !== 'pane' && placement !== 'workspace' && placement !== 'pane.header' && placement !== 'palette') throw new Error('invalid plugin menu placement');
        return { id: contributionID(menu['id']), command: commandReference(menu['command']), placement,
            ...(menu['group'] === undefined ? {} : { group: pluginContributionText(menu['group'], 'menu group', 64) }),
            ...(menu['order'] === undefined ? {} : { order: pluginContributionOrder(menu['order']) }),
            ...(menu['when'] === undefined ? {} : { when: decodePluginWhen(menu['when']) }),
            ...(menu['enablement'] === undefined ? {} : { enablement: decodePluginWhen(menu['enablement']) }) };
    });
    const items = array(contributes['items']).map((raw): PluginItemDefinition => {
        const item = pluginObject(raw);
        const placement = item['placement'];
        if (placement !== 'statusbar' && placement !== 'pane.header' && placement !== 'workspace.header') throw new Error('invalid plugin item placement');
        const fields = decodePluginItemPatch(Object.fromEntries(['text', 'tooltip', 'badge', 'tone'].filter(key => item[key] !== undefined).map(key => [key, item[key]])));
        return { id: contributionID(item['id']), placement, ...fields, text: pluginContributionText(item['text'], 'item text', 200),
            ...(item['command'] === undefined ? {} : { command: commandReference(item['command']) }),
            ...(item['order'] === undefined ? {} : { order: pluginContributionOrder(item['order']) }),
            ...(item['when'] === undefined ? {} : { when: decodePluginWhen(item['when']) }),
            ...(item['enablement'] === undefined ? {} : { enablement: decodePluginWhen(item['enablement']) }) };
    });
    const hooks = array(contributes['hooks']).map((raw): PluginHookDefinition => {
        const hook = pluginObject(raw);
        const phase = hook['phase'];
        if (phase !== 'before' && phase !== 'after') throw new Error('hook phase must be before or after');
        const commands = array(hook['commands']);
        if (!commands.length || commands.some(command => typeof command !== 'string' || (command !== '*' && !/^[a-z][a-zA-Z0-9_.:-]{0,99}$/.test(command)))) throw new Error('hook commands must be exact command names or *');
        return { id: contributionID(hook['id']), phase, commands: [...new Set(commands)] as string[],
            ...(hook['priority'] === undefined ? {} : { priority: boundedNumber(hook['priority'], 'hook priority', -1000, 1000) }),
            ...(hook['timeoutMs'] === undefined ? {} : { timeoutMs: boundedNumber(hook['timeoutMs'], 'hook timeout', 25, 5000) }) };
    });
    const services = array(contributes['services']).map((raw): PluginServiceDefinition => {
        const service = pluginObject(raw);
        return { id: contributionID(service['id']), title: label(service['title'], 'service title'), version: boundedNumber(service['version'], 'service version', 1, Number.MAX_SAFE_INTEGER), methods: methods(service['methods']) };
    });
    const providers = array(contributes['providers']).map((raw): PluginProviderDefinition => {
        const provider = pluginObject(raw);
        if (!isPluginID(provider['service']) || (!provider['service'].startsWith('kelpi.') && !foreignReference(provider['service']))) throw new Error('provider service must be bundled, owned, or supplied by a declared dependency');
        return { id: contributionID(provider['id']), title: label(provider['title'], 'provider title'), service: provider['service'], version: boundedNumber(provider['version'], 'provider version', 1, Number.MAX_SAFE_INTEGER), methods: methods(provider['methods']),
            ...(provider['timeoutMs'] === undefined ? {} : { timeoutMs: boundedNumber(provider['timeoutMs'], 'provider timeout', 25, 30_000) }) };
    });
    if ((commands.length || hooks.length || providers.length) && value['backend'] === undefined) throw new Error('plugin commands, hooks, and providers require a backend');
    if (typeof value['backend'] === 'string' && value['backend'].startsWith('ui/')) throw new Error('backend entry must be outside ui/');
    const settingGroups = array(contributes['settingGroups']).map((raw): PluginSettingGroupDefinition => {
        const group = pluginObject(raw);
        return { id: contributionID(group['id']), title: label(group['title'], 'setting group title'),
            ...(group['description'] === undefined ? {} : { description: pluginContributionText(group['description'], 'setting group description', 2000, true) }),
            ...(group['order'] === undefined ? {} : { order: pluginContributionOrder(group['order']) }) };
    });
    const settings: Record<string, PluginSettingDefinition> = {};
    const settingsEntries = Object.entries(pluginObject(contributes['settings'] ?? {}));
    if (settingsEntries.length > 100) throw new Error('expected at most 100 plugin settings');
    for (const [key, raw] of settingsEntries) {
        if (!/^[a-z][a-zA-Z0-9.-]{0,63}$/.test(key)) throw new Error('invalid plugin setting key');
        const setting = pluginObject(raw);
        const type = setting['type'];
        const fallback = setting['default'];
        if ((type !== 'string' && type !== 'number' && type !== 'boolean') || typeof fallback !== type) throw new Error(`invalid default for setting ${key}`);
        const group = setting['group'];
        if (group !== undefined && !settingGroups.some(entry => entry.id === group)) throw new Error(`unknown setting group for ${key}`);
        const choices = setting['enum'] === undefined ? undefined : array(setting['enum']);
        if (choices && (!choices.length || choices.some(choice => typeof choice !== type) || new Set(choices).size !== choices.length)) throw new Error(`invalid choices for setting ${key}`);
        const range = (field: 'min' | 'max'): number | undefined => {
            const value = setting[field];
            if (value === undefined) return undefined;
            if (type !== 'number' || typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid ${field} for setting ${key}`);
            return value;
        };
        const min = range('min'), max = range('max');
        if (min !== undefined && max !== undefined && min > max) throw new Error(`invalid range for setting ${key}`);
        const definition: PluginSettingDefinition = { title: label(setting['title'], 'setting title'), type, default: fallback as PluginContextValue,
            ...(group === undefined ? {} : { group: group as string }),
            ...(setting['description'] === undefined ? {} : { description: pluginContributionText(setting['description'], 'setting description', 2000, true) }),
            ...(setting['order'] === undefined ? {} : { order: pluginContributionOrder(setting['order']) }),
            ...(choices === undefined ? {} : { enum: choices as PluginContextValue[] }),
            ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
        pluginSettingValue(definition, fallback);
        if (choices) for (const choice of choices) pluginSettingValue(definition, choice);
        settings[key] = definition;
    }
    const activation = value['activation'] ?? 'on-demand';
    if (activation !== 'startup' && activation !== 'on-demand') throw new Error('invalid activation policy');
    return { id, name: label(value['name'] ?? id, 'name'), version, apiVersion: PLUGIN_API_VERSION, trust: 'full', activation,
        ...(value['backend'] === undefined ? {} : { backend: pluginAssetPath(value['backend']) }),
        ...(dependencies.length ? { dependencies } : {}),
        contributes: { views, commands, settings,
            ...(containers.length ? { containers } : {}), ...(hooks.length ? { hooks } : {}),
            ...(services.length ? { services } : {}), ...(providers.length ? { providers } : {}),
            ...(menus.length ? { menus } : {}), ...(items.length ? { items } : {}), ...(settingGroups.length ? { settingGroups } : {}) } };
}

export function decodePluginPane(raw: unknown): PluginPaneDescriptor | null {
    try {
        const value = pluginObject(raw);
        if (!isPluginID(value['pluginID']) || !isPluginID(value['viewID']) || !value['viewID'].startsWith(`${value['pluginID']}.`)) return null;
        if (typeof value['stateVersion'] !== 'number' || !Number.isSafeInteger(value['stateVersion']) || value['stateVersion'] < 1) return null;
        return { pluginID: value['pluginID'], viewID: value['viewID'], stateVersion: value['stateVersion'], state: pluginObject(value['state']) };
    } catch { return null; }
}

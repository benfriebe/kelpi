import { CHROME_UI_METHODS, type PluginChrome } from './chrome';
import { createContext } from 'react';
import { pluginJSON, type JsonObject, type JsonValue } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { NAVIGATION_UI_METHODS, type PluginNavigation } from './navigation';
import type { UIServiceModel } from './ui-services';

export const WORKBENCH_UI_METHODS = ['ui.getWorkbench', 'ui.selectView', 'ui.activateTab'] as const;
export const HOST_UI_METHODS = [...WORKBENCH_UI_METHODS, ...NAVIGATION_UI_METHODS, ...CHROME_UI_METHODS] as const;
export interface PluginHostUI {
    readonly runtime: KelpiRuntime;
    readonly chrome?: PluginChrome | null | undefined;
    readonly navigation?: PluginNavigation | null | undefined;
    readonly services?: UIServiceModel | null | undefined;
    request(method: string, args: JsonObject): JsonValue;
}
export const PluginHostUIContext = createContext<PluginHostUI | null>(null);

export function requestHostUI(host: PluginHostUI | null, runtime: KelpiRuntime, method: string, args: JsonObject): JsonValue | Promise<JsonValue> {
    if (!host || host.runtime !== runtime) throw new Error('Workbench UI is unavailable for this daemon in this window.');
    if ((CHROME_UI_METHODS as readonly string[]).includes(method)) {
        if (!host.chrome) throw new Error('Window chrome is unavailable in this window.');
        if (method === 'ui.getChrome') return pluginJSON(host.chrome.getChrome());
        const target = args['target'] ?? {};
        if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('Invalid chrome command target.');
        return Promise.resolve(host.chrome.execute(args['id'], target as JsonObject)).then(() => null);
    }
    if ((NAVIGATION_UI_METHODS as readonly string[]).includes(method)) {
        if (!host.navigation) throw new Error('Navigation is unavailable in this window.');
        if (method === 'ui.getNavigation') return pluginJSON(host.navigation.getNavigation());
        host.navigation.selectWorkspace(args['hostID'], args['workspaceID']);
        return null;
    }
    return host.request(method, args);
}

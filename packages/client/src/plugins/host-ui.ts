import { createContext } from 'react';
import type { JsonObject, JsonValue } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';

export const WORKBENCH_UI_METHODS = ['ui.getWorkbench', 'ui.selectView', 'ui.activateTab'] as const;
export interface PluginHostUI {
    readonly runtime: KelpiRuntime;
    request(method: string, args: JsonObject): JsonValue;
}
export const PluginHostUIContext = createContext<PluginHostUI | null>(null);

export function requestHostUI(host: PluginHostUI | null, runtime: KelpiRuntime, method: string, args: JsonObject): JsonValue {
    if (!host || host.runtime !== runtime) throw new Error('Workbench UI is unavailable for this daemon in this window.');
    return host.request(method, args);
}

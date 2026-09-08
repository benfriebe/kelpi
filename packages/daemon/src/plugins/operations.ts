import { AsyncLocalStorage } from 'node:async_hooks';
import type { JsonObject, PluginContext } from '@kelpi/protocol';

export type PluginOperationSource = 'cli' | 'ui' | 'plugin';
export interface PluginOperationScope {
    readonly trace: readonly string[];
    readonly handled?: boolean;
    readonly source?: PluginOperationSource;
    readonly signal?: AbortSignal;
}
const scopes = new AsyncLocalStorage<PluginOperationScope>();
export const operationScope = (): PluginOperationScope => scopes.getStore() ?? { trace: [] };
export const inOperationScope = <T>(scope: PluginOperationScope, run: () => T): T => scopes.run(scope, run);

/** Both transports use this boundary. The existing command handler remains the authority. */
export interface PluginOperationChannel {
    hasOperationHooks(command: string): boolean;
    interceptOperation(payload: JsonObject, context: Partial<PluginContext>, source: PluginOperationSource, run: () => Promise<JsonObject>): Promise<JsonObject>;
}

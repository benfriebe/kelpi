import type { JsonObject, JsonValue, PluginContext } from '@kelpi/protocol';

/** Native adapters stay in the daemon; external implementations use the provider bridge. */
export interface BuiltinServiceMethod {
    validateArgs(args: JsonObject): void;
    validateResult(result: JsonValue): void;
    run(args: JsonObject, context: PluginContext, signal?: AbortSignal): JsonValue | Promise<JsonValue>;
}

export interface BuiltinPluginService {
    readonly id: string;
    readonly title: string;
    readonly version: number;
    readonly methods: Readonly<Record<string, BuiltinServiceMethod>>;
}

/** Lazy access lets native services be composed before the plugin supervisor starts. */
export interface BuiltinServiceHost {
    readonly daemonID: string;
    hasSelectedProvider(service: string, version: number): boolean;
    callService(input: JsonObject, context?: PluginContext, signal?: AbortSignal): Promise<JsonValue>;
}

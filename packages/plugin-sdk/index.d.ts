import type { AgentsAPI, ApplicationSettingsAPI, GitAPI, GroupsAPI, LayoutAPI, PanesAPI, Snapshot, TerminalAPI, WorkspacesAPI } from './domain.js';
import type { BuiltinProviderMethods, BuiltinServiceArgs, BuiltinServiceID, BuiltinServiceMethod, BuiltinServiceResult, ProcessExecResult } from './services.js';
import type { ContributionsAPI } from './contributions.js';
import type { WindowUIServices } from './ui.js';
import type { WindowChromeAPI } from './chrome.js';
import type { WindowInteractionAPI } from './interaction.js';
import type { DocumentsAPI, ViewDocumentsAPI } from './documents.js';
import type { ViewTerminalAPI } from './terminal.js';
import type { BrowserAPI, ViewBrowserAPI } from './browser-pane.js';
export * from './domain.js';
export * from './services.js';
export * from './contributions.js';
export * from './ui.js';
export * from './chrome.js';
export * from './interaction.js';
export * from './documents.js';
export * from './terminal.js';
export * from './browser-pane.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Data = { [key: string]: Json };
export interface Context { daemonID: string; clientID?: string; windowID?: string; workspaceID?: string; paneID?: string; viewID?: string }
export interface Event { epoch: string; sequence: number; name: string; data: Json; pluginID?: string }
export type Dispose = () => void;
export class KelpiError extends Error {
    readonly code: string;
    readonly method: string | undefined;
    readonly details: unknown;
    constructor(message: string, options?: { code?: string; method?: string; details?: unknown; cause?: unknown });
}
export type HostCall = (method: string, args: Data) => Promise<unknown>;
/** Adapter used by Kelpi's browser and backend transports. */
export function createKelpiAPI(transport: HostCall, getContext?: () => Partial<Context>): Omit<KelpiAPI, 'events'>;
export interface KelpiAPI {
    /** Method names and the raw command catalog are documented in docs/plugins.md. */
    call<T = Json>(method: string, args?: Data): Promise<T>;
    snapshot(): Promise<Snapshot>;
    /** Same payload and reply as Kelpi's CLI/UI command protocol. */
    command(payload: Data, context?: Partial<Context>): Promise<Data>;
    openView(viewID: string, options?: { workspaceID?: string; state?: Data }): Promise<{ paneID: string; workspaceID: string }>;
    emit(name: string, data?: Json): Promise<Event>;
    events: { on(name: string, listener: (event: Event) => void | Promise<void>): Dispose };
    commands: { execute<T = Json>(id: string, args?: Data): Promise<T> };
    storage: { get(key: string): Promise<Json>; set(key: string, value: Json): Promise<void> };
    settings: { get(): Promise<Data>; set(key: string, value: string | number | boolean): Promise<void> };
    contributions: ContributionsAPI;
    files: { read(path: string): Promise<string>; write(path: string, text: string): Promise<void>; open(path: string, options?: { paneID?: string; workspaceID?: string; reuse?: boolean }): Promise<void>; reveal(path: string, options?: { select?: boolean }): Promise<void> };
    process: { exec(file: string, args?: string[], options?: { cwd?: string }): Promise<ProcessExecResult> };
    terminal: TerminalAPI;
    browser: BrowserAPI;
    documents: DocumentsAPI;
    workspaces: WorkspacesAPI;
    groups: GroupsAPI;
    panes: PanesAPI;
    layout: LayoutAPI;
    agents: AgentsAPI;
    git: GitAPI;
    appSettings: ApplicationSettingsAPI;
    services: ServicesAPI;
    ui: { reveal(paneID: string): Promise<void> };
}
export interface ServiceDefinition { id: string; title: string; version: number; methods: string[] }
export interface ServiceProvider { id: string; title: string; pluginID?: string; status: 'available' | 'disabled' | 'failed'; error?: string }
export interface ServicesAPI {
    list(): Promise<ServiceInfo[]>;
    /** Built-in version-1 contracts infer arguments and results; custom services retain a JSON escape hatch. */
    call<S extends BuiltinServiceID, M extends BuiltinServiceMethod<S>>(service: S, version: 1, method: M, args: BuiltinServiceArgs<S, M>, options?: { provider?: string }): Promise<BuiltinServiceResult<S, M>>;
    call<T = Json, S extends string = string>(service: S extends BuiltinServiceID ? never : S, version: number, method: string, args?: Data, options?: { provider?: string }): Promise<T>;
    select(service: string, version: number, providerID: string | null): Promise<ServiceInfo[]>;
}
export interface ServiceInfo extends ServiceDefinition { providers: ServiceProvider[]; selectedProviderID: string | null; activeProviderID: string | null }
export interface HookInvocation {
    id: string; command: string; payload: Data; context: Context;
    source: 'cli' | 'ui' | 'plugin'; phase: 'before' | 'after'; result?: Json;
}
export type HookDecision = { allow: true } | { allow: false; reason: string };
export interface BackendAPI extends KelpiAPI {
    commands: KelpiAPI['commands'] & { register(id: string, handler: (args: Data, context: Context) => Json | void | Promise<Json | void>): Dispose };
    hooks: { register(id: string, handler: (invocation: HookInvocation) => HookDecision | void | Promise<HookDecision | void>): Dispose };
    providers: {
        /** Supply the service ID as a type argument to check a complete built-in implementation. */
        register<S extends BuiltinServiceID = never>(id: string, methods: [S] extends [never] ? never : BuiltinProviderMethods<S>): Dispose;
        register(id: string, methods: Record<string, (args: Data, context: Context) => Json | void | Promise<Json | void>>): Dispose;
    };
}
export interface ViewAPI extends KelpiAPI {
    documents: ViewDocumentsAPI;
    terminal: ViewTerminalAPI;
    browser: ViewBrowserAPI;
    readonly ready: Promise<void>;
    readonly context: Context;
    readonly state: Data;
    readonly stateVersion: number;
    readonly theme: Record<string, string>;
    readonly visible: boolean;
    /** Runs after ready, then on context/theme/visibility/state updates. Disposal also cancels queued deliveries. */
    onContext(listener: (value: ViewEnvironment) => void | Promise<void>): Dispose;
    setState(state: Data): Promise<void>;
    ui: KelpiAPI['ui'] & WindowUIServices & WindowChromeAPI & WindowInteractionAPI & {
        activateWorkspace(workspaceID: string): Promise<void>;
        focusPane(workspaceID: string, paneID: string): Promise<void>;
        notify(message: string): Promise<void>;
        /** These actions are local to the hosting workbench and are unavailable in a backend. */
        getWorkbench(): Promise<WorkbenchInfo>;
        selectView(slot: string, viewID: string): Promise<void>;
        activateTab(containerID: string, slotID: string): Promise<void>;
        /** Window navigation is available only to views owned by the hosting primary daemon. */
        getNavigation(): Promise<NavigationSnapshot>;
        /** Selects a currently connected host/workspace in this window; never forwards daemon APIs. */
        selectWorkspace(hostID: string, workspaceID: string): Promise<void>;
        /** Initial/latest snapshots with bounded delivery. Dispose cancels queued callbacks.
         * A snapshot exceeding 256 KiB calls onError, or reports a view error if omitted. */
        onNavigation(listener: (value: NavigationSnapshot) => void | Promise<void>, onError?: (error: Error) => void | Promise<void>): Dispose;
    };
}
export interface ViewEnvironment {
    readonly context: Readonly<Context>; readonly state: Readonly<Data>; readonly stateVersion: number;
    readonly theme: Readonly<Record<string, string>>; readonly visible: boolean;
}
export interface WorkbenchInfo {
    slots: { id: string; title: string; viewID: string | null }[];
    views: { id: string; title: string; placements: string[]; pluginID?: string }[];
    activeTabs: Record<string, string>;
}
export interface NavigationWorkspace {
    readonly id: string;
    readonly name: string;
    readonly color: string | null;
    /** Visible panes; excludes parked panes and closed-pane history. */
    readonly paneCount: number;
    readonly group: { readonly id: string; readonly name: string; readonly color: string | null } | null;
}
export interface NavigationHost {
    /** Opaque window-local ID; changes when a remote's configured name/URL is replaced. */
    readonly id: string;
    readonly name: string;
    /** The local host owns this view's daemon APIs. Remote rows support selection only. */
    readonly kind: 'local' | 'remote';
    readonly connection: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'rejected';
    readonly workspaces: readonly NavigationWorkspace[];
}
export interface NavigationSnapshot {
    readonly hosts: readonly NavigationHost[];
    readonly active: { readonly hostID: string; readonly workspaceID: string } | null;
}
export function getKelpi(): ViewAPI;
declare global { var kelpi: ViewAPI }

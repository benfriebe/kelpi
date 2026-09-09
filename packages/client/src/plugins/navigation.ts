import { pluginJSON } from '@kelpi/protocol';
import type { WorkspaceGroup, WorkspaceState } from '@kelpi/daemon/store';
import type { RemoteDaemonRuntime } from '../app/remote-daemons';
import type { RemoteSelection } from '../app/RemoteDaemonSections';
import type { ConnectionStatus } from '../connection';
import { selectActiveWorkspaceID, selectSidebarEntries, type KelpiRuntime, type KelpiState } from '../state';

export const NAVIGATION_UI_METHODS = ['ui.getNavigation', 'ui.selectWorkspace'] as const;

export interface NavigationWorkspace {
    readonly id: string;
    readonly name: string;
    readonly color: string | null;
    readonly paneCount: number;
    readonly group: { readonly id: string; readonly name: string; readonly color: string | null } | null;
}
export interface NavigationHost {
    /** Opaque and window-local. Replacing a configured name/URL invalidates this ID. */
    readonly id: string;
    readonly name: string;
    readonly kind: 'local' | 'remote';
    readonly connection: ConnectionStatus;
    readonly workspaces: readonly NavigationWorkspace[];
}
export interface NavigationSnapshot {
    readonly hosts: readonly NavigationHost[];
    readonly active: { readonly hostID: string; readonly workspaceID: string } | null;
}
export interface PluginNavigationState {
    readonly remotes: ReadonlyMap<string, RemoteDaemonRuntime>;
    readonly selection: RemoteSelection | null;
    readonly localName?: string;
}
export interface PluginNavigationOptions extends PluginNavigationState {
    readonly runtime: KelpiRuntime;
    readonly activateLocalWorkspace: (workspaceID: string) => void;
    readonly selectRemoteWorkspace: (selection: RemoteSelection) => void;
}
export interface PluginNavigation {
    getNavigation(): NavigationSnapshot;
    selectWorkspace(hostID: unknown, workspaceID: unknown): void;
    /** Immediately delivers the current snapshot, then coalesced changes. */
    subscribe(listener: (value: NavigationSnapshot) => void, onError?: (error: Error) => void): () => void;
    update(state: PluginNavigationState): void;
    dispose(): void;
}
export type PluginNavigationMessage =
    | { readonly type: 'navigation'; readonly sequence: number; readonly value: NavigationSnapshot }
    | { readonly type: 'navigation-error'; readonly sequence: number; readonly error: string };
export interface PluginNavigationFeed {
    ack(sequence: unknown): void;
    dispose(): void;
}

type Delivery = { readonly value: NavigationSnapshot } | { readonly error: Error };
interface Subscriber {
    readonly listener: (value: NavigationSnapshot) => void;
    readonly onError: ((error: Error) => void) | undefined;
}
interface RemoteHost { readonly id: string; readonly held: RemoteDaemonRuntime }

function freeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        for (const item of Object.values(value)) freeze(item);
        Object.freeze(value);
    }
    return value;
}

function workspaceSummary(workspace: WorkspaceState, group: WorkspaceGroup | null): NavigationWorkspace {
    return {
        id: workspace.id, name: workspace.name, color: workspace.color, paneCount: workspace.panes.length,
        group: group ? { id: group.id, name: group.name, color: group.color } : null,
    };
}

function hostSummary(id: string, name: string, kind: NavigationHost['kind'], runtime: KelpiRuntime): NavigationHost {
    const state = runtime.store.getState();
    const workspaces: NavigationWorkspace[] = [];
    const seen = new Set<string>();
    const add = (workspace: WorkspaceState, group: WorkspaceGroup | null): void => {
        if (seen.has(workspace.id)) return;
        seen.add(workspace.id);
        workspaces.push(workspaceSummary(workspace, group));
    };
    // Includes children of collapsed groups, in the same order as the native sidebar.
    for (const entry of selectSidebarEntries(state)) {
        if (entry.kind === 'workspace') add(entry.workspace, null);
        else for (const workspace of entry.workspaces) add(workspace, entry.group);
    }
    // Keep older/partially ordered daemon mirrors complete, without inventing missing rows.
    for (const workspace of state.daemon.state.workspaces) {
        if (!seen.has(workspace.id)) add(workspace, state.daemon.state.groups.find(group => group.childOrder.includes(workspace.id)) ?? null);
    }
    return { id, name, kind, connection: state.ui.connection, workspaces };
}

function navigationChanged(state: KelpiState, previous: KelpiState): boolean {
    return state.daemon.state !== previous.daemon.state || state.ui.connection !== previous.ui.connection ||
        state.ui.activeWorkspaceID !== previous.ui.activeWorkspaceID;
}

/**
 * A window's bounded navigation model. Construct once for its primary runtime; only
 * primary-owned views may access it (the host UI bridge enforces runtime identity).
 * This object never sends daemon commands or exposes connection URLs/credentials.
 * Store subscriptions are lazy, so construction during a React render has no effects.
 */
export function createPluginNavigation(options: PluginNavigationOptions): PluginNavigation {
    const localID = crypto.randomUUID();
    let disposed = false, queued = false, localName = options.localName ?? 'This daemon';
    let selection = options.selection;
    let remoteHosts = new Map<string, RemoteHost>();
    const subscribers = new Set<Subscriber>();
    const storeSubscriptions = new Map<KelpiRuntime, () => void>();
    let lastKey: string | undefined;

    const reconcile = (remotes: ReadonlyMap<string, RemoteDaemonRuntime>): void => {
        const next = new Map<string, RemoteHost>();
        for (const [name, held] of remotes) {
            const previous = remoteHosts.get(name);
            const id = previous?.held.name === held.name && previous.held.url === held.url ? previous.id : crypto.randomUUID();
            next.set(name, { id, held });
        }
        remoteHosts = next;
    };
    reconcile(options.remotes);
    let selectionHostID = selection ? remoteHosts.get(selection.daemon)?.id ?? null : null;

    const getNavigation = (): NavigationSnapshot => {
        if (disposed) throw new Error('Navigation is unavailable after window disposal.');
        const hosts = [hostSummary(localID, localName, 'local', options.runtime),
            ...[...remoteHosts.values()].map(({ id, held }) => hostSummary(id, held.name, 'remote', held.runtime))];
        const workspaceID = selection?.workspaceID ?? selectActiveWorkspaceID(options.runtime.store.getState());
        const hostID = selection ? selectionHostID : localID;
        const active = hostID && workspaceID && hosts.some(host => host.id === hostID && host.workspaces.some(workspace => workspace.id === workspaceID))
            ? { hostID, workspaceID } : null;
        // Reserve the full push envelope and largest sequence, not just its value. A huge
        // window fails explicitly instead of silently hiding some hosts or workspaces.
        try {
            const message = pluginJSON({ type: 'navigation', sequence: Number.MAX_SAFE_INTEGER, value: { hosts, active } }) as unknown as { value: NavigationSnapshot };
            return freeze(message.value);
        } catch {
            throw new Error('Navigation snapshot is invalid or exceeds 256 KiB.');
        }
    };
    const read = (): Delivery => {
        try { return { value: getNavigation() }; }
        catch (error) { return { error: error instanceof Error ? error : new Error('Navigation is unavailable.') }; }
    };
    const key = (delivery: Delivery): string => 'value' in delivery ? JSON.stringify(delivery.value) : `error:${delivery.error.message}`;
    const deliver = (subscriber: Subscriber, delivery: Delivery): void => {
        if (!subscribers.has(subscriber)) return;
        try {
            if ('value' in delivery) subscriber.listener(delivery.value);
            else if (subscriber.onError) subscriber.onError(delivery.error);
            else console.error('plugin navigation', delivery.error);
        } catch (error) { console.error('plugin navigation listener', error); }
    };
    const publish = (): void => {
        if (disposed || !subscribers.size || queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (disposed || !subscribers.size) return;
            const delivery = read();
            const nextKey = key(delivery);
            if (nextKey === lastKey) return;
            lastKey = nextKey;
            for (const subscriber of [...subscribers]) deliver(subscriber, delivery);
        });
    };
    const syncSubscriptions = (): void => {
        const wanted = subscribers.size && !disposed
            ? new Set([options.runtime, ...[...remoteHosts.values()].map(host => host.held.runtime)]) : new Set<KelpiRuntime>();
        for (const [runtime, stop] of storeSubscriptions) if (!wanted.has(runtime)) { stop(); storeSubscriptions.delete(runtime); }
        for (const runtime of wanted) if (!storeSubscriptions.has(runtime)) {
            storeSubscriptions.set(runtime, runtime.store.subscribe((state, previous) => { if (navigationChanged(state, previous)) publish(); }));
        }
    };

    return {
        getNavigation,
        selectWorkspace(hostID, workspaceID) {
            if (disposed) throw new Error('Navigation is unavailable after window disposal.');
            if (typeof hostID !== 'string' || !hostID || typeof workspaceID !== 'string' || !workspaceID) throw new Error('Navigation requires a host ID and workspace ID.');
            const remote = [...remoteHosts.values()].find(host => host.id === hostID);
            const runtime = hostID === localID ? options.runtime : remote?.held.runtime;
            if (!runtime) throw new Error('Navigation host is no longer available.');
            const state = runtime.store.getState();
            if (!state.daemon.state.workspaces.some(workspace => workspace.id === workspaceID)) throw new Error('Navigation workspace is no longer available on this host.');
            if (state.ui.connection !== 'connected' || !state.daemon.hasSnapshot || state.daemon.desynced) throw new Error('Navigation host is not connected and ready.');
            // Every validation precedes either callback, including local activation/reveal.
            if (remote) options.selectRemoteWorkspace({ daemon: remote.held.name, workspaceID });
            else options.activateLocalWorkspace(workspaceID);
        },
        subscribe(listener, onError) {
            if (disposed) throw new Error('Navigation is unavailable after window disposal.');
            const subscriber = { listener, onError };
            subscribers.add(subscriber);
            syncSubscriptions();
            const delivery = read();
            if (subscribers.size === 1) lastKey = key(delivery);
            deliver(subscriber, delivery);
            return () => { subscribers.delete(subscriber); syncSubscriptions(); };
        },
        update(state) {
            if (disposed) return;
            reconcile(state.remotes);
            // A RemoteSelection names a configured entry. Bind it to the identity it was
            // chosen against, so a URL replacement cannot inherit the old selection.
            if (selection !== state.selection) selectionHostID = state.selection ? remoteHosts.get(state.selection.daemon)?.id ?? null : null;
            selection = state.selection;
            localName = state.localName ?? 'This daemon';
            syncSubscriptions();
            publish();
        },
        dispose() { disposed = true; subscribers.clear(); syncSubscriptions(); remoteHosts.clear(); },
    };
}

/** One outstanding frame plus the latest replacement. A stalled iframe cannot build a queue. */
export function createPluginNavigationFeed(model: PluginNavigation, send: (message: PluginNavigationMessage) => void): PluginNavigationFeed {
    let disposed = false, sequence = 0, outstanding: number | null = null, latest: Delivery | null = null;
    let stop = (): void => {};
    const dispose = (): void => { disposed = true; latest = null; outstanding = null; stop(); };
    const flush = (): void => {
        if (disposed || outstanding !== null || latest === null) return;
        const delivery = latest;
        latest = null;
        if (sequence === Number.MAX_SAFE_INTEGER) { dispose(); return; }
        outstanding = ++sequence;
        try {
            send('value' in delivery ? { type: 'navigation', sequence, value: delivery.value }
                : { type: 'navigation-error', sequence, error: delivery.error.message.slice(0, 4096) });
        } catch { dispose(); }
    };
    const offer = (delivery: Delivery): void => { if (!disposed) { latest = delivery; flush(); } };
    stop = model.subscribe(value => offer({ value }), error => offer({ error }));
    if (disposed) stop();
    return { ack(value) { if (!disposed && outstanding !== null && value === outstanding) { outstanding = null; flush(); } }, dispose };
}

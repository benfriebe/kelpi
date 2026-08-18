/**
 * The client store (WP3.1): a mirror of `DaemonState` plus this client's own UI state.
 *
 * Two slices, and the split is load-bearing (ARCHITECTURE.md "Client", PLAN.md decisions):
 *
 *   `daemon` — a **replica**, never edited locally. A `snapshot` replaces it wholesale; every
 *              `delta` is replayed with the daemon's own `applyDomainEvents`, the exact same
 *              function the daemon's tests assert round-trips its mutations. No domain logic
 *              is re-implemented here, so the client cannot drift from the daemon by
 *              construction — the one thing this module must never do is hand-roll a reducer.
 *   `ui`     — per-client state the daemon does not own: which workspace THIS client is
 *              looking at (active workspace is per-client), the focus echo, connection status,
 *              command palette, sidebar filter, notification toasts.
 *
 * Wire-shape reconciliation happens here too. `ws/serialize.ts` strips two server-only things
 * before the state leaves the daemon — `homeDirectory` and each workspace's
 * `recentlyClosedPanes` (replaced by a `recentlyClosedCount`) — so the hydration below fills
 * those back in with inert values, keeping the mirror structurally a `DaemonState` and the
 * daemon's derived helpers usable verbatim.
 */

import { applyDomainEvents, type DaemonState, type DomainEvent } from '@nex/daemon/store';
import type { WsNotificationKind } from '@nex/protocol';
import { create } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { ConnectionStatus } from '../connection';

// ── wire → mirror hydration ─────────────────────────────────────────────────────────

/**
 * Delta kinds the daemon actually emits (`store/types.ts` `DomainEvent`). Deliberately NOT
 * `@nex/protocol`'s `WS_DELTA_KINDS`, which predates the store's event vocabulary and lists
 * shapes (`app-patch`, …) the daemon never sends; `ws/serialize.ts` is the ground truth.
 * Anything not in this set is dropped rather than replayed — `applyDomainEvent`'s switch is
 * exhaustive over the union, so an unknown kind would fall through and blank the mirror.
 */
export const DOMAIN_EVENT_KINDS: ReadonlySet<string> = new Set([
    'workspace-upserted',
    'workspace-removed',
    'pane-upserted',
    'pane-removed',
    'layout-changed',
    'focus-changed',
    'sync-changed',
    'agent-status-changed',
    'group-upserted',
    'group-removed',
    'order-changed',
    'active-workspace-changed',
    'label-presets-changed',
    'repos-changed'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/** The undo stack never crosses the wire; only its size does (`recentlyClosedCount`). */
function hydrateWorkspace(raw: unknown): unknown {
    if (!isRecord(raw)) return raw;
    return { ...raw, recentlyClosedPanes: [] };
}

export function emptyDaemonState(): DaemonState {
    return {
        workspaces: [],
        groups: [],
        topLevelOrder: [],
        lastActiveWorkspaceID: null,
        repos: [],
        labelPresets: [],
        homeDirectory: ''
    };
}

/** A `snapshot` payload → a structurally complete `DaemonState` mirror. */
export function hydrateSnapshotState(raw: unknown): DaemonState {
    if (!isRecord(raw)) return emptyDaemonState();
    const lastActive = raw['lastActiveWorkspaceID'];
    return {
        workspaces: array(raw['workspaces']).map(hydrateWorkspace),
        groups: array(raw['groups']),
        topLevelOrder: array(raw['topLevelOrder']),
        lastActiveWorkspaceID: typeof lastActive === 'string' ? lastActive : null,
        repos: array(raw['repos']),
        labelPresets: array(raw['labelPresets']),
        // Server-only: the daemon HOST's home directory would be a lie on a remote client.
        homeDirectory: ''
    } as unknown as DaemonState;
}

/** A `delta.events` array → replayable `DomainEvent`s, unknown kinds dropped. */
export function hydrateDomainEvents(raw: unknown): DomainEvent[] {
    const events: DomainEvent[] = [];
    for (const entry of array(raw)) {
        if (!isRecord(entry)) continue;
        const kind = entry['kind'];
        if (typeof kind !== 'string' || !DOMAIN_EVENT_KINDS.has(kind)) continue;
        if (kind === 'workspace-upserted') {
            events.push({ ...entry, workspace: hydrateWorkspace(entry['workspace']) } as unknown as DomainEvent);
            continue;
        }
        events.push(entry as unknown as DomainEvent);
    }
    return events;
}

/** The workspace field `serializeWorkspace` adds in place of the undo stack. */
export function recentlyClosedCount(workspace: unknown): number {
    if (!isRecord(workspace)) return 0;
    const value = workspace['recentlyClosedCount'];
    return typeof value === 'number' && value > 0 ? value : 0;
}

// ── slices ──────────────────────────────────────────────────────────────────────────

export interface DaemonInfo {
    readonly version: string;
    readonly build: string;
    readonly pid: number;
}

export interface DaemonSlice {
    /** The mirror. Replaced on snapshot, advanced by `applyDomainEvents` on deltas. */
    readonly state: DaemonState;
    /** Last applied delta seq (the snapshot's anchor before any delta arrives). */
    readonly seq: number;
    readonly hasSnapshot: boolean;
    /** A seq gap was seen: the mirror is stale until a fresh snapshot lands. */
    readonly desynced: boolean;
    readonly clientID: string | null;
    readonly info: DaemonInfo | null;
}

export interface Toast {
    /** `nex-<paneID>` for pane notifications: a re-post REPLACES rather than stacks. */
    readonly id: string;
    readonly kind: WsNotificationKind | 'info';
    readonly title: string;
    readonly body: string;
    readonly paneID: string | null;
    readonly workspaceID: string | null;
    readonly createdAt: number;
}

export interface FocusEcho {
    readonly workspaceID: string;
    readonly paneID: string | null;
}

export interface UiSlice {
    readonly connection: ConnectionStatus;
    readonly connectionError: string | null;
    /** Per-client (PLAN.md); seeded from the daemon's persisted `lastActiveWorkspaceID`. */
    readonly activeWorkspaceID: string | null;
    /**
     * Local echo of the focus we last reported. Focus is daemon-canonical, but the round trip
     * is a frame or two, and the focus ring must not lag the click.
     */
    readonly focusEcho: FocusEcho | null;
    readonly documentVisible: boolean;
    readonly palette: { readonly open: boolean; readonly query: string };
    readonly sidebarFilter: string;
    readonly toasts: readonly Toast[];
}

export interface NexActions {
    applySnapshot(seq: number, rawState: unknown): void;
    /** False when the batch was out of order (caller must resync the socket). */
    applyDelta(seq: number, rawEvents: unknown): boolean;
    markDesynced(): void;
    setDaemonIdentity(clientID: string | null, info: DaemonInfo | null): void;

    setConnectionStatus(status: ConnectionStatus, error?: string | null): void;
    setActiveWorkspace(workspaceID: string | null): void;
    setFocusEcho(workspaceID: string, paneID: string | null): void;
    clearFocusEcho(): void;
    setDocumentVisible(visible: boolean): void;

    setPaletteOpen(open: boolean): void;
    togglePalette(): void;
    setPaletteQuery(query: string): void;
    setSidebarFilter(filter: string): void;

    pushToast(toast: Toast): void;
    dismissToast(id: string): void;
    dismissPaneToasts(paneID: string): void;
    clearToasts(): void;
}

export interface NexState extends NexActions {
    readonly daemon: DaemonSlice;
    readonly ui: UiSlice;
}

export const MAX_TOASTS = 5;

function initialDaemonSlice(): DaemonSlice {
    return {
        state: emptyDaemonState(),
        seq: 0,
        hasSnapshot: false,
        desynced: false,
        clientID: null,
        info: null
    };
}

function initialUiSlice(): UiSlice {
    return {
        connection: 'idle',
        connectionError: null,
        activeWorkspaceID: null,
        focusEcho: null,
        documentVisible: true,
        palette: { open: false, query: '' },
        sidebarFilter: '',
        toasts: []
    };
}

/** First workspace in sidebar order — the fallback when the daemon has no last-active id. */
function firstWorkspaceID(state: DaemonState): string | null {
    return state.workspaces[0]?.id ?? null;
}

function reconcileActiveWorkspace(state: DaemonState, current: string | null): string | null {
    if (current !== null && state.workspaces.some((workspace) => workspace.id === current)) return current;
    const remembered = state.lastActiveWorkspaceID;
    if (remembered !== null && state.workspaces.some((workspace) => workspace.id === remembered)) return remembered;
    return firstWorkspaceID(state);
}

export type NexStoreApi = StoreApi<NexState>;

type SetState = NexStoreApi['setState'];
type GetState = NexStoreApi['getState'];

export function nexStateCreator(set: SetState, get: GetState): NexState {
    return {
        daemon: initialDaemonSlice(),
        ui: initialUiSlice(),

        applySnapshot(seq, rawState) {
            const state = hydrateSnapshotState(rawState);
            const ui = get().ui;
            set({
                daemon: { ...get().daemon, state, seq, hasSnapshot: true, desynced: false },
                ui: { ...ui, activeWorkspaceID: reconcileActiveWorkspace(state, ui.activeWorkspaceID) }
            });
        },

        applyDelta(seq, rawEvents) {
            const daemon = get().daemon;
            // Deltas before the snapshot they extend are meaningless; the daemon only starts
            // sending them after the snapshot is written, so this is belt-and-braces.
            if (!daemon.hasSnapshot) return false;
            if (seq !== daemon.seq + 1) {
                set({ daemon: { ...daemon, desynced: true } });
                return false;
            }
            const events = hydrateDomainEvents(rawEvents);
            const state = events.length === 0 ? daemon.state : applyDomainEvents(daemon.state, events);
            const ui = get().ui;
            const activeWorkspaceID = reconcileActiveWorkspace(state, ui.activeWorkspaceID);
            set({
                daemon: { ...daemon, state, seq },
                ...(activeWorkspaceID === ui.activeWorkspaceID ? {} : { ui: { ...ui, activeWorkspaceID } })
            });
            return true;
        },

        markDesynced() {
            set({ daemon: { ...get().daemon, desynced: true } });
        },

        setDaemonIdentity(clientID, info) {
            set({ daemon: { ...get().daemon, clientID, info } });
        },

        setConnectionStatus(status, error) {
            const ui = get().ui;
            const connectionError = error === undefined ? (status === 'connected' ? null : ui.connectionError) : error;
            if (ui.connection === status && ui.connectionError === connectionError) return;
            set({ ui: { ...ui, connection: status, connectionError } });
        },

        setActiveWorkspace(workspaceID) {
            const ui = get().ui;
            if (ui.activeWorkspaceID === workspaceID) return;
            set({ ui: { ...ui, activeWorkspaceID: workspaceID } });
        },

        setFocusEcho(workspaceID, paneID) {
            const ui = get().ui;
            if (ui.focusEcho?.workspaceID === workspaceID && ui.focusEcho.paneID === paneID) return;
            set({ ui: { ...ui, focusEcho: { workspaceID, paneID } } });
        },

        clearFocusEcho() {
            const ui = get().ui;
            if (ui.focusEcho === null) return;
            set({ ui: { ...ui, focusEcho: null } });
        },

        setDocumentVisible(visible) {
            const ui = get().ui;
            if (ui.documentVisible === visible) return;
            set({ ui: { ...ui, documentVisible: visible } });
        },

        setPaletteOpen(open) {
            const ui = get().ui;
            if (ui.palette.open === open) return;
            set({ ui: { ...ui, palette: { open, query: open ? ui.palette.query : '' } } });
        },

        togglePalette() {
            const ui = get().ui;
            const open = !ui.palette.open;
            set({ ui: { ...ui, palette: { open, query: open ? ui.palette.query : '' } } });
        },

        setPaletteQuery(query) {
            const ui = get().ui;
            if (ui.palette.query === query) return;
            set({ ui: { ...ui, palette: { ...ui.palette, query } } });
        },

        setSidebarFilter(filter) {
            const ui = get().ui;
            if (ui.sidebarFilter === filter) return;
            set({ ui: { ...ui, sidebarFilter: filter } });
        },

        pushToast(toast) {
            const ui = get().ui;
            // Replace-by-id: the daemon's `nex-<paneID>` dedupe identity applies to the in-app
            // fallback exactly as it does to a Web Notification's `tag`.
            const kept = ui.toasts.filter((existing) => existing.id !== toast.id);
            const toasts = [...kept, toast].slice(-MAX_TOASTS);
            set({ ui: { ...ui, toasts } });
        },

        dismissToast(id) {
            const ui = get().ui;
            const toasts = ui.toasts.filter((toast) => toast.id !== id);
            if (toasts.length === ui.toasts.length) return;
            set({ ui: { ...ui, toasts } });
        },

        dismissPaneToasts(paneID) {
            const ui = get().ui;
            const toasts = ui.toasts.filter((toast) => toast.paneID !== paneID);
            if (toasts.length === ui.toasts.length) return;
            set({ ui: { ...ui, toasts } });
        },

        clearToasts() {
            const ui = get().ui;
            if (ui.toasts.length === 0) return;
            set({ ui: { ...ui, toasts: [] } });
        }
    };
}

/** A fresh, isolated store — one per test, and the seam any host can reuse. */
export function createNexStore(): NexStoreApi {
    return createStore<NexState>(nexStateCreator);
}

/** The app-wide store hook (assembly wires it to a connection via `state/bridge.ts`). */
export const useNexStore = create<NexState>(nexStateCreator);

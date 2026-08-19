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
import {
    DEFAULT_WS_SETTINGS,
    WS_DELTA_KINDS,
    type WsNotificationKind,
    type WsSettingsSnapshot
} from '@nex/protocol';
import { create } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { ConnectionStatus } from '../connection';

// ── wire → mirror hydration ─────────────────────────────────────────────────────────

/**
 * Delta kinds the daemon actually emits. `@nex/protocol`'s `WS_DELTA_KINDS` is now a
 * transcription of the store's own `DomainEvent` union (reconciled in WP3.6 — it used to
 * predate the store and list shapes like `app-patch` that the daemon never sends), so the set
 * is imported rather than restated and the two cannot drift.
 *
 * Anything not in this set is dropped rather than replayed: `applyDomainEvent`'s switch is
 * exhaustive over the union, so an unknown kind would fall through and blank the mirror.
 */
export const DOMAIN_EVENT_KINDS: ReadonlySet<string> = new Set<string>(WS_DELTA_KINDS);

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

/**
 * The daemon's config-file settings (M8).
 *
 * A THIRD slice, deliberately not folded into `daemon`: settings are not domain state, they
 * arrive on `welcome` (and on `settings-changed`) rather than in the snapshot, and no
 * `DomainEvent` describes them — so replaying deltas must never touch them.
 *
 * `loaded` distinguishes "the daemon told us the user has no config" from "we have not heard
 * yet", which is what stops the chrome flashing the wrong light/dark bucket on connect.
 */
export interface SettingsSlice {
    readonly value: WsSettingsSnapshot;
    /** True once a `welcome` (or a `settings-changed`) delivered a payload. */
    readonly loaded: boolean;
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
    /**
     * A `welcome.settings` payload or a `settings-changed` broadcast. `undefined` (an older
     * daemon that sends no settings) leaves the defaults in place and stays unloaded.
     */
    applySettings(raw: unknown): void;
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
    readonly settings: SettingsSlice;
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

function initialSettingsSlice(): SettingsSlice {
    return { value: DEFAULT_WS_SETTINGS, loaded: false };
}

/**
 * Structural hydration for a settings payload: anything missing or of the wrong type falls
 * back to the default, so a daemon that grows a field (or loses one) cannot blank the client.
 */
export function hydrateSettings(raw: unknown): WsSettingsSnapshot | null {
    if (!isRecord(raw)) return null;
    const general = isRecord(raw['general']) ? raw['general'] : {};
    const appearance = isRecord(raw['appearance']) ? raw['appearance'] : {};
    const fallbackGeneral = DEFAULT_WS_SETTINGS.general;
    const fallbackAppearance = DEFAULT_WS_SETTINGS.appearance;

    const bool = (value: unknown, fallback: boolean): boolean =>
        typeof value === 'boolean' ? value : fallback;
    const num = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const nullableNum = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) ? value : null;

    return {
        keybindLines: array(raw['keybindLines']).filter((line): line is string => typeof line === 'string'),
        // M8 Settings ▸ Profiles: the config file's `profile` lines, already parsed daemon-side.
        // A malformed entry is dropped rather than guessed at — the editor writes the WHOLE set
        // back, so a half-understood profile would be a silent deletion of the user's vars.
        profiles: array(raw['profiles']).flatMap((entry) => {
            if (!isRecord(entry) || typeof entry['name'] !== 'string') return [];
            const rawEnv = entry['env'];
            const env: Record<string, string> = {};
            if (isRecord(rawEnv)) {
                for (const [key, value] of Object.entries(rawEnv)) {
                    if (typeof value === 'string') env[key] = value;
                }
            }
            return [{ name: entry['name'], env }];
        }),
        general: {
            focusFollowsMouse: bool(general['focusFollowsMouse'], fallbackGeneral.focusFollowsMouse),
            focusFollowsMouseDelay: Math.max(
                0,
                num(general['focusFollowsMouseDelay'], fallbackGeneral.focusFollowsMouseDelay)
            ),
            theme: nullableText(general['theme']),
            confirmWorkspaceDeleteWhenActive: bool(
                general['confirmWorkspaceDeleteWhenActive'],
                fallbackGeneral.confirmWorkspaceDeleteWhenActive
            )
        },
        appearance: {
            backgroundColor:
                typeof appearance['backgroundColor'] === 'string' && appearance['backgroundColor'] !== ''
                    ? appearance['backgroundColor']
                    : fallbackAppearance.backgroundColor,
            backgroundOpacity: Math.min(
                1,
                Math.max(0, num(appearance['backgroundOpacity'], fallbackAppearance.backgroundOpacity))
            ),
            fontFamily: nullableText(appearance['fontFamily']),
            fontSize: nullableNum(appearance['fontSize']),
            isDark: bool(appearance['isDark'], fallbackAppearance.isDark),
            theme: nullableText(appearance['theme'])
        }
    };
}

function sameSettings(a: WsSettingsSnapshot, b: WsSettingsSnapshot): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
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

function focusedPaneOf(state: DaemonState, workspaceID: string): string | null | undefined {
    return state.workspaces.find((workspace) => workspace.id === workspaceID)?.focusedPaneID;
}

/**
 * Is the local focus echo still the newest thing said about that workspace?
 *
 * The echo exists to cover the round trip of a click (`selectFocusedPaneID` prefers it), and
 * it used to survive forever — so when the DAEMON moved focus on its own the client kept
 * drawing the ring on the pane the user last touched. ⌘D was the visible case: the daemon
 * focuses the pane the split created (`store/reducers/panes.ts` ends in `setFocus`), the
 * client stayed on the original, and "split, then type" typed into the wrong pane (run-B L7).
 *
 * The rule: a delta that CHANGES the echoed workspace's focus supersedes the echo. A delta
 * that merely confirms it (the round trip landing) changes nothing, so the echo is left alone
 * and no render is wasted.
 */
function echoSurvives(echo: FocusEcho, previous: DaemonState, next: DaemonState): boolean {
    const before = focusedPaneOf(previous, echo.workspaceID);
    const after = focusedPaneOf(next, echo.workspaceID);
    if (after === undefined) return true; // the workspace is gone; nothing to defer to
    return before === after;
}

export type NexStoreApi = StoreApi<NexState>;

type SetState = NexStoreApi['setState'];
type GetState = NexStoreApi['getState'];

export function nexStateCreator(set: SetState, get: GetState): NexState {
    return {
        daemon: initialDaemonSlice(),
        ui: initialUiSlice(),
        settings: initialSettingsSlice(),

        applySettings(raw) {
            const value = hydrateSettings(raw);
            if (value === null) return;
            const settings = get().settings;
            // Identity stability matters: every consumer of this slice is a memo dependency,
            // and a fresh object per broadcast would rebuild the key dispatcher for nothing.
            if (settings.loaded && sameSettings(settings.value, value)) return;
            set({ settings: { value, loaded: true } });
        },

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
            const focusEcho =
                ui.focusEcho !== null && !echoSurvives(ui.focusEcho, daemon.state, state) ? null : ui.focusEcho;
            const uiChanged = activeWorkspaceID !== ui.activeWorkspaceID || focusEcho !== ui.focusEcho;
            set({
                daemon: { ...daemon, state, seq },
                ...(uiChanged ? { ui: { ...ui, activeWorkspaceID, focusEcho } } : {})
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

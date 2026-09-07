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

import { applyDomainEvents, type DaemonState, type DomainEvent } from '@kelpi/daemon/store';
import {
    DEFAULT_WS_CHROME_SETTINGS,
    DEFAULT_WS_SETTINGS,
    DEFAULT_WS_TERMINAL_THEME,
    SYSTEM_STATS_INTERVAL_MS,
    WS_DELTA_KINDS,
    ZERO_SYSTEM_STATS,
    type WsChromeSettings,
    type WsNotificationKind,
    type WsSettingsSnapshot,
    type WsSystemStats,
    type WsTerminalThemeResolution,
    type WsTransportStatus
} from '@kelpi/protocol';
import { create } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { ConnectionStatus } from '../connection';

// ── wire → mirror hydration ─────────────────────────────────────────────────────────

/**
 * Delta kinds the daemon actually emits. `@kelpi/protocol`'s `WS_DELTA_KINDS` is now a
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
        // Server-only, like `homeDirectory` below: §APP-116's one-shot label→preset marker is a
        // daemon boot concern, never crosses the wire, and nothing on this side reads it.
        labelPresetsMigrated: false,
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
    /**
     * §APP-069: the daemon HOST's home, for display only — `homeDirectory` is stripped from the
     * mirror, and every path this client renders is the daemon's, so `~` abbreviation needs the
     * daemon's home rather than the viewer's. Absent on a daemon that predates it.
     */
    readonly home?: string;
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
    /**
     * Who owns pane sizing (`size-control` broadcasts; terminal-surface.md §5.1). PTY
     * geometry follows exactly one client's window; when this names a DIFFERENT client than
     * `clientID`, the top bar offers "take size control". Null = unknown or nobody.
     */
    readonly sizeControlOwnerID: string | null;
    /**
     * §SET-021: what the daemon's control listeners actually did (`welcome.transport`).
     *
     * `null` = the daemon did not say (an older one, or we have not connected yet), which
     * Settings ▸ Network renders as "as of daemon start" rather than claiming anything. A
     * daemon that DID say but configured no TCP listener sends `{tcp: null}` — a different,
     * knowable fact.
     */
    readonly transport: WsTransportStatus | null;
}

export interface Toast {
    /** `kelpi-<paneID>` for pane notifications: a re-post REPLACES rather than stacks. */
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
 * §SET-200/§SET-201: what the Electron shell's registrar said about the global hotkey.
 *
 * `null` means nobody has reported — a browser client with no desktop shell attached, or a
 * daemon that has not been told yet — and Settings shows no warning, which is correct: nothing
 * tried to register anything. A report with `ok: true` is kept rather than collapsed to null so
 * a stale failure is positively cleared instead of merely forgotten.
 */
export interface HotkeyStatus {
    readonly accelerator: string | null;
    readonly configString: string | null;
    readonly ok: boolean;
    readonly error: string | null;
    readonly source: 'launch' | 'settings';
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
    /** The last `hotkey-status` the daemon relayed from a shell (§SET-200/§SET-201). */
    readonly hotkeyStatus: HotkeyStatus | null;
}

/**
 * The daemon's latest `system-stats` broadcast (APP-078…085).
 *
 * A FOURTH slice for the same reason settings are a third: no `DomainEvent` describes system
 * stats, nothing persists them, and a delta replay must never touch them. `loaded` is what
 * separates "the sampler has not spoken" from "the machine reads 0 %" — the footer renders
 * nothing in the first case, which is the honest thing to draw when you have not been told.
 */
export interface SystemStatsSlice {
    readonly stats: WsSystemStats;
    readonly history: Readonly<Record<string, readonly number[]>>;
    readonly intervalMs: number;
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
    /**
     * §AGNT-056: is the window this client runs in the ACTIVE one? Reported by the Electron
     * shell (`shell-activation`, scoped to its window id), true until something says otherwise
     * — the right assumption for a browser tab, which has no shell to report for it. Distinct
     * from `documentVisible`: a window can be perfectly visible and still not be the app the
     * user is looking at, and the 600 ms status-clear cares about the latter.
     */
    readonly appActive: boolean;
    /**
     * §APP-046b: whether the shell window around this page is maximised.
     *
     * Only the maximise button the client draws on Windows and Linux reads it, and only to pick
     * its glyph. It is store state rather than component state because the fact arrives on the
     * socket (`window-frame-state`, shell → daemon → here) like every other relayed shell fact,
     * and because the state changes from OUTSIDE the app — a WM shortcut, a tiling rule, a
     * double-click on the strip — as often as from the button itself.
     *
     * Defaults to false — a window that has said nothing is not maximised, which is what a
     * freshly created one is. A RELOADED page does not have to rely on that default: the daemon
     * remembers the last report per window and replays it on `hello`.
     */
    readonly windowMaximized: boolean;
    readonly palette: { readonly open: boolean; readonly query: string };
    readonly sidebarFilter: string;
    readonly toasts: readonly Toast[];
}

export interface KelpiActions {
    /**
     * A `welcome.settings` payload or a `settings-changed` broadcast. `undefined` (an older
     * daemon that sends no settings) leaves the defaults in place and stays unloaded.
     */
    applySettings(raw: unknown): void;
    /**
     * A `hotkey-status` relay (§SET-200/§SET-201). A malformed payload is ignored rather than
     * partially applied — a half-read report would either invent a warning or erase a real one.
     */
    applyHotkeyStatus(raw: unknown): void;
    /** A `system-stats` broadcast. A malformed payload is ignored, never partially applied. */
    applySystemStats(raw: unknown): void;
    applySnapshot(seq: number, rawState: unknown): void;
    /** False when the batch was out of order (caller must resync the socket). */
    applyDelta(seq: number, rawEvents: unknown): boolean;
    markDesynced(): void;
    /**
     * `transport` is §SET-021's `welcome.transport`; omitting it (an older daemon, or a caller
     * that has nothing to say) clears it back to "unknown" rather than keeping a stale claim
     * from the previous connection.
     */
    setDaemonIdentity(
        clientID: string | null,
        info: DaemonInfo | null,
        transport?: WsTransportStatus | null
    ): void;
    /** `size-control` broadcast (terminal-surface.md §5.1): who owns pane sizing now. */
    setSizeControlOwner(ownerClientID: string | null): void;

    setConnectionStatus(status: ConnectionStatus, error?: string | null): void;
    setActiveWorkspace(workspaceID: string | null): void;
    setFocusEcho(workspaceID: string, paneID: string | null): void;
    clearFocusEcho(): void;
    setDocumentVisible(visible: boolean): void;
    /** §AGNT-056: a relayed `shell-activation` for this window. */
    setAppActive(active: boolean): void;
    setWindowMaximized(maximized: boolean): void;

    setPaletteOpen(open: boolean): void;
    togglePalette(): void;
    setPaletteQuery(query: string): void;
    setSidebarFilter(filter: string): void;

    pushToast(toast: Toast): void;
    dismissToast(id: string): void;
    dismissPaneToasts(paneID: string): void;
    clearToasts(): void;
}

export interface KelpiState extends KelpiActions {
    readonly daemon: DaemonSlice;
    readonly ui: UiSlice;
    readonly settings: SettingsSlice;
    readonly systemStats: SystemStatsSlice;
}

export const MAX_TOASTS = 5;

function initialDaemonSlice(): DaemonSlice {
    return {
        state: emptyDaemonState(),
        seq: 0,
        hasSnapshot: false,
        desynced: false,
        clientID: null,
        info: null,
        sizeControlOwnerID: null,
        transport: null
    };
}

function initialSettingsSlice(): SettingsSlice {
    return { value: DEFAULT_WS_SETTINGS, loaded: false, hotkeyStatus: null };
}

function textOrNull(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/** §SET-200: the relay's payload, or null when it is not a report this client can trust. */
export function hydrateHotkeyStatus(raw: unknown): HotkeyStatus | null {
    if (!isRecord(raw)) return null;
    if (typeof raw['ok'] !== 'boolean') return null;
    const source = raw['source'];
    return {
        accelerator: textOrNull(raw['accelerator']),
        configString: textOrNull(raw['configString']),
        ok: raw['ok'],
        error: textOrNull(raw['error']),
        source: source === 'launch' ? 'launch' : 'settings'
    };
}

function initialSystemStatsSlice(): SystemStatsSlice {
    return {
        stats: ZERO_SYSTEM_STATS,
        history: {},
        intervalMs: SYSTEM_STATS_INTERVAL_MS,
        loaded: false
    };
}

/** A `system-stats` payload → the slice, or null when the shape is not one. */
export function hydrateSystemStats(raw: unknown): Omit<SystemStatsSlice, 'loaded'> | null {
    if (!isRecord(raw)) return null;
    const rawStats = raw['stats'];
    if (!isRecord(rawStats)) return null;
    const number = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const history: Record<string, readonly number[]> = {};
    const rawHistory = raw['history'];
    if (isRecord(rawHistory)) {
        for (const [key, value] of Object.entries(rawHistory)) {
            if (!Array.isArray(value)) continue;
            history[key] = (value as unknown[]).filter(
                (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry)
            );
        }
    }
    const interval = raw['intervalMs'];
    return {
        stats: {
            cpuPercent: number(rawStats['cpuPercent']),
            memUsedBytes: number(rawStats['memUsedBytes']),
            memTotalBytes: number(rawStats['memTotalBytes']),
            loadAverage1m: number(rawStats['loadAverage1m']),
            netDownBytesPerSec: number(rawStats['netDownBytesPerSec']),
            netUpBytesPerSec: number(rawStats['netUpBytesPerSec']),
            diskReadBytesPerSec: number(rawStats['diskReadBytesPerSec']),
            diskWriteBytesPerSec: number(rawStats['diskWriteBytesPerSec']),
            diskUsedBytes: number(rawStats['diskUsedBytes']),
            diskTotalBytes: number(rawStats['diskTotalBytes'])
        },
        history,
        intervalMs:
            typeof interval === 'number' && Number.isFinite(interval) && interval > 0
                ? interval
                : SYSTEM_STATS_INTERVAL_MS
    };
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
    const placement = (
        value: unknown,
        fallback: 'end-of-list' | 'near-selection'
    ): 'end-of-list' | 'near-selection' =>
        value === 'end-of-list' || value === 'near-selection' ? value : fallback;
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
        // §1.7 multi-daemon groups: the `remote-daemon` registry. Same drop-don't-guess rule.
        remoteDaemons: array(raw['remoteDaemons']).flatMap((entry) => {
            if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['url'] !== 'string') return [];
            if (entry['name'] === '' || entry['url'] === '') return [];
            return [{ name: entry['name'], url: entry['url'] }];
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
            ),
            // §AGNT-117: the quit suppression's twin, daemon-owned since the quit gate moved.
            confirmQuitWhenActive: bool(
                general['confirmQuitWhenActive'],
                fallbackGeneral.confirmQuitWhenActive
            ),
            tcpPort: Math.max(0, num(general['tcpPort'], fallbackGeneral.tcpPort)),
            globalHotkey: nullableText(general['globalHotkey']),
            globalHotkeyHideOnRepress: bool(
                general['globalHotkeyHideOnRepress'],
                fallbackGeneral.globalHotkeyHideOnRepress
            ),
            // §GIT-074's gate. A daemon that predates the field sends nothing and the shipped
            // default (on) stands — the same additive rule every field above follows.
            autoDetectRepos: bool(general['autoDetectRepos'], fallbackGeneral.autoDetectRepos),
            // SET-008/013/014. A blank template falls back to the default rather than pointing
            // worktree creation at the filesystem root.
            worktreeBasePath:
                typeof general['worktreeBasePath'] === 'string' && general['worktreeBasePath'] !== ''
                    ? general['worktreeBasePath']
                    : fallbackGeneral.worktreeBasePath,
            newWorkspacePlacement: placement(
                general['newWorkspacePlacement'],
                fallbackGeneral.newWorkspacePlacement
            ),
            newGroupPlacement: placement(general['newGroupPlacement'], fallbackGeneral.newGroupPlacement),
            // SET-011, additive in the same way: an older daemon omits the field and the
            // shipped default (on) stands.
            inheritGroupOnNewWorkspace: bool(
                general['inheritGroupOnNewWorkspace'],
                fallbackGeneral.inheritGroupOnNewWorkspace
            ),
            // SET-012, the sibling gesture rule: an older daemon omits it and the drop keeps
            // expanding, which is what it did before the setting existed.
            expandGroupOnWorkspaceDrop: bool(
                general['expandGroupOnWorkspaceDrop'],
                fallbackGeneral.expandGroupOnWorkspaceDrop
            ),
            // §TERM-046's OSC 52 gate. Additive like the rest, and here the additive default is
            // the point: a daemon that predates the field sends nothing, the shipped default
            // (OFF) stands, and the toggle renders unchecked rather than claiming an openness
            // that daemon does not have.
            clipboardWrite: bool(general['clipboardWrite'], fallbackGeneral.clipboardWrite)
        },
        // Chrome styling + status-bar settings. A daemon that predates the field sends nothing
        // and the shipped palette / gauge set stands — the same additive rule the rest of this
        // hydrator follows.
        chrome: hydrateChromeSettings(raw['chrome']),
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
            windowPaddingX: nullableNum(appearance['windowPaddingX']),
            windowPaddingY: nullableNum(appearance['windowPaddingY']),
            isDark: bool(appearance['isDark'], fallbackAppearance.isDark),
            theme: nullableText(appearance['theme']),
            // §APP-014: what that theme name RESOLVED to. Additive in the same way as every
            // field above — a daemon that predates it sends nothing, the neutral resolution
            // stands, and the client keeps its light/dark preset with no note.
            terminalTheme: hydrateTerminalTheme(appearance['terminalTheme'])
        }
    };
}

/**
 * §APP-014's `appearance.terminalTheme` — the resolved theme file, structurally.
 *
 * The palette is filtered to STRINGS keyed by name; the merge that applies it
 * (`terminal/palette.ts`) checks each value is a colour an engine can parse, so a hostile or
 * simply old daemon cannot put `rgba(…)` — which ghostty-web renders as black — into a pane.
 */
function hydrateTerminalTheme(raw: unknown): WsTerminalThemeResolution {
    if (!isRecord(raw)) return DEFAULT_WS_TERMINAL_THEME;
    const palette: Record<string, string> = {};
    const rawPalette = raw['palette'];
    if (isRecord(rawPalette)) {
        for (const [key, value] of Object.entries(rawPalette)) {
            if (typeof value === 'string') palette[key] = value;
        }
    }
    return {
        name: typeof raw['name'] === 'string' ? raw['name'] : null,
        path: typeof raw['path'] === 'string' ? raw['path'] : null,
        palette,
        error: typeof raw['error'] === 'string' && raw['error'] !== '' ? raw['error'] : null
    };
}

/**
 * The `chrome` slice of a settings payload, field by field against the shipped defaults.
 *
 * Same discipline as the rest of `hydrateSettings`: a missing or wrong-typed field falls back
 * rather than propagating, because these values are read straight into a stylesheet — an
 * `undefined` opacity is a blank sidebar, and a `null` colour map throws inside `resolve`.
 */
function hydrateChromeSettings(raw: unknown): WsChromeSettings {
    const fallback = DEFAULT_WS_CHROME_SETTINGS;
    if (!isRecord(raw)) return fallback;
    const number = (value: unknown, min: number, max: number, defaultValue: number): number => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue;
        return Math.min(max, Math.max(min, value));
    };
    const colors: Record<string, string> = {};
    const rawColors = raw['colors'];
    if (isRecord(rawColors)) {
        for (const [key, value] of Object.entries(rawColors)) {
            if (typeof value === 'string') colors[key] = value;
        }
    }
    const appearance = raw['appearance'];
    const style = raw['sparklineStyle'];
    return {
        appearance:
            appearance === 'light' || appearance === 'dark' || appearance === 'system'
                ? appearance
                : fallback.appearance,
        colors,
        sidebarColorIntensity: number(raw['sidebarColorIntensity'], 0, 2, fallback.sidebarColorIntensity),
        sidebarAvatarFill: number(raw['sidebarAvatarFill'], 0, 1, fallback.sidebarAvatarFill),
        sidebarAvatarStroke: number(raw['sidebarAvatarStroke'], 0, 1, fallback.sidebarAvatarStroke),
        // -1 is the "use the preset" sentinel, so the floor is -1 rather than 0.
        sidebarGroupFill: number(raw['sidebarGroupFill'], -1, 1, fallback.sidebarGroupFill),
        sidebarGroupStroke: number(raw['sidebarGroupStroke'], 0, 1, fallback.sidebarGroupStroke),
        showSystemStats:
            typeof raw['showSystemStats'] === 'boolean' ? raw['showSystemStats'] : fallback.showSystemStats,
        // An EMPTY array is meaningful ("show no gauges") and must survive; only a non-array
        // falls back to the shipped cpu/memory/load set.
        enabledSystemStats: Array.isArray(raw['enabledSystemStats'])
            ? (raw['enabledSystemStats'] as unknown[]).filter(
                  (value): value is string => typeof value === 'string'
              )
            : fallback.enabledSystemStats,
        showSystemStatGraphs:
            typeof raw['showSystemStatGraphs'] === 'boolean'
                ? raw['showSystemStatGraphs']
                : fallback.showSystemStatGraphs,
        sparklineStyle: style === 'dots' || style === 'line' ? style : fallback.sparklineStyle,
        sparklineColor: typeof raw['sparklineColor'] === 'string' ? raw['sparklineColor'] : fallback.sparklineColor,
        sparklineWidth: Math.round(number(raw['sparklineWidth'], 16, 80, fallback.sparklineWidth)),
        // SET-219's four search-highlight colours. They are read straight into a stylesheet and
        // into the terminal palette, so a non-hex value falls back to the Kelpi default rather
        // than reaching a CSS parser as `undefined`.
        searchMatchColor: hexOr(raw['searchMatchColor'], fallback.searchMatchColor),
        searchMatchTextColor: hexOr(raw['searchMatchTextColor'], fallback.searchMatchTextColor),
        searchMatchCurrentColor: hexOr(raw['searchMatchCurrentColor'], fallback.searchMatchCurrentColor),
        searchMatchCurrentTextColor: hexOr(
            raw['searchMatchCurrentTextColor'],
            fallback.searchMatchCurrentTextColor
        )
    };
}

/** `#rrggbb` (any case, `#` optional) → lowercase `#rrggbb`; anything else → the fallback. */
function hexOr(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim().replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(trimmed) ? `#${trimmed.toLowerCase()}` : fallback;
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
        appActive: true,
        windowMaximized: false,
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

export type KelpiStoreApi = StoreApi<KelpiState>;

type SetState = KelpiStoreApi['setState'];
type GetState = KelpiStoreApi['getState'];

export function kelpiStateCreator(set: SetState, get: GetState): KelpiState {
    return {
        daemon: initialDaemonSlice(),
        ui: initialUiSlice(),
        settings: initialSettingsSlice(),
        systemStats: initialSystemStatsSlice(),

        applySystemStats(raw) {
            const next = hydrateSystemStats(raw);
            if (next === null) return;
            set({ systemStats: { ...next, loaded: true } });
        },

        applySettings(raw) {
            const value = hydrateSettings(raw);
            if (value === null) return;
            const settings = get().settings;
            // Identity stability matters: every consumer of this slice is a memo dependency,
            // and a fresh object per broadcast would rebuild the key dispatcher for nothing.
            if (settings.loaded && sameSettings(settings.value, value)) return;
            // The hotkey report is carried over: it comes from the shell on its own schedule
            // and has nothing to do with a config-file change (§SET-200).
            set({ settings: { value, loaded: true, hotkeyStatus: settings.hotkeyStatus } });
        },

        applyHotkeyStatus(raw) {
            const status = hydrateHotkeyStatus(raw);
            if (status === null) return;
            const settings = get().settings;
            const current = settings.hotkeyStatus;
            // Identity stability, same rule as `applySettings`: the shell re-reports on every
            // reconnect and on every settings write, and an unchanged report must not re-render
            // Settings or invalidate a memo that depends on this slice.
            if (
                current !== null &&
                current.ok === status.ok &&
                current.error === status.error &&
                current.accelerator === status.accelerator &&
                current.configString === status.configString &&
                current.source === status.source
            ) {
                return;
            }
            set({ settings: { ...settings, hotkeyStatus: status } });
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

        setDaemonIdentity(clientID, info, transport) {
            set({ daemon: { ...get().daemon, clientID, info, transport: transport ?? null } });
        },

        setSizeControlOwner(ownerClientID) {
            const daemon = get().daemon;
            if (daemon.sizeControlOwnerID === ownerClientID) return;
            set({ daemon: { ...daemon, sizeControlOwnerID: ownerClientID } });
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

        setAppActive(active) {
            const ui = get().ui;
            if (ui.appActive === active) return;
            set({ ui: { ...ui, appActive: active } });
        },

        setWindowMaximized(maximized) {
            const ui = get().ui;
            if (ui.windowMaximized === maximized) return;
            set({ ui: { ...ui, windowMaximized: maximized } });
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
            // Replace-by-id: the daemon's `kelpi-<paneID>` dedupe identity applies to the in-app
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
export function createKelpiStore(): KelpiStoreApi {
    return createStore<KelpiState>(kelpiStateCreator);
}

/** The app-wide store hook (assembly wires it to a connection via `state/bridge.ts`). */
export const useKelpiStore = create<KelpiState>(kelpiStateCreator);

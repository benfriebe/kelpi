/**
 * Settings sync over the client socket (M8).
 *
 * The daemon is the settings authority: it reads `~/.config/nex/config` (keybinds + general
 * settings) and `~/.config/ghostty/config` (appearance), watches both, and pushes a
 * `SettingsSnapshot` to every attached client. Clients render from that snapshot and mutate
 * through three WS-only verbs that write THROUGH the config file — the file stays the source
 * of truth and the watcher broadcasts the result back.
 *
 * **Where the snapshot rides**: in `welcome`, not in `snapshot`. The `snapshot` payload is a
 * serialized `DaemonState` mirror the client replays deltas onto; settings are not domain
 * state (no `DomainEvent` describes them, and persistence never sees them), so folding them in
 * would make the mirror a lie. `welcome` is re-sent on every reconnect, so a client always has
 * settings before the first frame it renders — and `settings-changed` carries the same shape
 * afterwards, so a client has exactly one code path.
 *
 * Additive by design: a daemon that predates this omits `welcome.settings`, and a client that
 * predates it ignores the field and the broadcast.
 */

/** `~/.config/nex/config` general settings a client can act on (config-keybindings.md §10, §11). */
export interface WsGeneralSettings {
    /** §10. */
    readonly focusFollowsMouse: boolean;
    /** §10, milliseconds, ≥ 0. */
    readonly focusFollowsMouseDelay: number;
    /** §11 `theme = <id>`: a built-in TERMINAL theme id. Case-sensitive; null when unset. */
    readonly theme: string | null;
    /**
     * §13 "Confirm before deleting a workspace with active agents" (default true).
     *
     * The Swift app keeps this in UserDefaults; shell-ui.md's port note says to move the two
     * suppression settings into the DAEMON settings store "so Settings UI and dialogs stay in
     * sync across clients", and the daemon's settings store is the config file — hence the
     * `confirm-workspace-delete` key. The CLI's `--force` bypasses it regardless (the guard in
     * `workspace-delete` is independent of this flag, exactly as in the Swift app).
     */
    readonly confirmWorkspaceDeleteWhenActive: boolean;
}

/**
 * One `profile = <name>:<KEY>=<value>` group, already parsed (config-keybindings.md §1.5).
 *
 * Values are UNEXPANDED (`~` kept verbatim) because the Settings editor round-trips them back
 * into the file — §9.5's `parseProfiles(expandTilde: false)`. Spawn-time resolution re-reads
 * the file with expansion on, so nothing downstream sees these strings.
 */
export interface WsProfile {
    readonly name: string;
    readonly env: Readonly<Record<string, string>>;
}

/**
 * `~/.config/ghostty/config` appearance (content-panes.md §3.1, §3.8).
 *
 * `backgroundColor` and `backgroundOpacity` are what the pane container paints as
 * `rgba(background, opacity)` behind transparent content; `isDark` is the daemon's own
 * luminance verdict (`0.299r + 0.587g + 0.114b < 0.5`), so client chrome, the daemon's
 * markdown/diff HTML and the terminal palette all agree on light-vs-dark by construction.
 *
 * `fontFamily` / `fontSize` are `null` when the ghostty config does not set them, which means
 * "use the host's own default" rather than a value this package would have to keep in sync.
 */
export interface WsAppearanceSettings {
    /** `#rrggbb` (lowercase). Always concrete — `isDark` is derived from it. */
    readonly backgroundColor: string;
    /** 0..1. */
    readonly backgroundOpacity: number;
    /** A CSS font stack built from the ghostty `font-family` lines; null = host default. */
    readonly fontFamily: string | null;
    /** Points/pixels; null = host default. */
    readonly fontSize: number | null;
    /** The luminance rule against `backgroundColor`. */
    readonly isDark: boolean;
    /** ghostty's own `theme = <name>` value, passed through opaquely. Null when unset. */
    readonly theme: string | null;
}

export interface WsSettingsSnapshot {
    /**
     * The `keybind` line VALUES in file order (`"super+d=split_right"`, `"super+e=unbind"`) —
     * not the whole `keybind = …` line. That is exactly what a client's binding-map builder
     * takes, so the daemon never has to serialize a resolved map.
     */
    readonly keybindLines: readonly string[];
    readonly general: WsGeneralSettings;
    readonly appearance: WsAppearanceSettings;
    /**
     * The config file's `profile` lines, parsed, in first-appearance order (§9.5's editor input).
     * They ride the settings snapshot rather than a read verb because the daemon already parses
     * them on every settings read — a separate verb would be a second source of truth.
     */
    readonly profiles: readonly WsProfile[];
}

/** Matches the web client's `--nex-term-bg` fallback and the daemon's content-render default. */
export const DEFAULT_SETTINGS_BACKGROUND = '#0a0a0c';

/** What "neither config file exists" produces. */
export const DEFAULT_WS_SETTINGS: WsSettingsSnapshot = {
    keybindLines: [],
    profiles: [],
    general: {
        focusFollowsMouse: false,
        focusFollowsMouseDelay: 100,
        theme: null,
        confirmWorkspaceDeleteWhenActive: true
    },
    appearance: {
        backgroundColor: DEFAULT_SETTINGS_BACKGROUND,
        backgroundOpacity: 1,
        fontFamily: null,
        fontSize: null,
        isDark: true,
        theme: null
    }
};

/** Broadcast to every attached client whenever either config file changes on disk. */
export interface WsSettingsChangedMessage {
    readonly type: 'settings-changed';
    readonly settings: WsSettingsSnapshot;
}

export const WS_SETTINGS_CHANGED_MESSAGE = 'settings-changed';

/**
 * The three WS-only mutation verbs. Like `toggle-zoom` and friends they are deliberately NOT
 * `WIRE_COMMANDS`: the Swift CLI has no way to send them and a new CLI verb is a compatibility
 * surface we would owe it forever.
 *
 *   set-keybinding      `action`, `trigger` (config string, or null to unbind the action)
 *   reset-keybindings   `action` (or null for the whole map)
 *   set-general-setting `key`, `value`
 *   set-profiles        `profiles` (the WHOLE set; §1.6's full-replacement write)
 */
export const WS_SETTINGS_COMMANDS = [
    'set-keybinding',
    'reset-keybindings',
    'set-general-setting',
    'set-profiles'
] as const;
export type WsSettingsCommand = (typeof WS_SETTINGS_COMMANDS)[number];

export function isWsSettingsCommand(command: string): command is WsSettingsCommand {
    return (WS_SETTINGS_COMMANDS as readonly string[]).includes(command);
}

/**
 * General keys `set-general-setting` may write (config-keybindings.md §1.3's list).
 *
 * `theme` is absent on purpose: §1.3 — "`theme` is NEVER written back to this file by the
 * app… a read-at-launch input only".
 */
export const WS_WRITABLE_GENERAL_KEYS = [
    'focus-follows-mouse',
    'focus-follows-mouse-delay',
    'tcp-port',
    'global-hotkey',
    'global-hotkey-hide-on-repress',
    // Additive to §1.3's list: the Swift app keeps this suppression flag in UserDefaults, which
    // a multi-client daemon has no equivalent of (shell-ui.md port note "Suppression settings").
    'confirm-workspace-delete'
] as const;
export type WsWritableGeneralKey = (typeof WS_WRITABLE_GENERAL_KEYS)[number];

export function isWsWritableGeneralKey(key: string): key is WsWritableGeneralKey {
    return (WS_WRITABLE_GENERAL_KEYS as readonly string[]).includes(key);
}

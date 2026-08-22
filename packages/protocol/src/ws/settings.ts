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
    /**
     * §10 step 2 "Confirm before quitting while agents are active" (default true), config key
     * `confirm-quit-when-active`.
     *
     * The OTHER of the two suppression settings the port note names. It used to live in the
     * Electron shell's own `shell-settings.json`, so the ⌘Q dialog's "Don't ask again" and the
     * Settings window could not agree — Settings could not even show it. It is here now for the
     * same multi-client reason as its twin, and the shell reads it off this snapshot (it holds
     * a status WS of its own) instead of a local file.
     */
    readonly confirmQuitWhenActive: boolean;
    /**
     * §1.3 `tcp-port` — the control socket's optional `127.0.0.1` listener. 0 = disabled.
     *
     * Read-only in practice for a RUNNING daemon (the listener binds at boot), which is why
     * the General tab shows it with a "takes effect on restart" note rather than pretending a
     * live rebind happened. Surfaced here because §13's General ▸ Network row displays it.
     */
    readonly tcpPort: number;
    /**
     * §8.1 `global-hotkey`, as the CONFIG STRING (`"ctrl+alt+space"`), or null when unset.
     *
     * A string rather than a parsed `KeyTrigger` because the wire is JSON and the client's
     * recorder already speaks config strings both ways (`keyTriggerConfigString` /
     * `parseKeyTrigger`). Round-tripping the parsed form would add a second encoding for a
     * value the file stores as text.
     */
    readonly globalHotkey: string | null;
    /** §8.2 `global-hotkey-hide-on-repress` (default true; only a literal `false` disables). */
    readonly globalHotkeyHideOnRepress: boolean;
    /**
     * §13 Settings ▸ General ▸ Repositories, "Auto-detect from pane directories" (default
     * true; only a literal `false` disables). Gates BOTH halves of the daemon's auto-detect
     * subsystem — the 500 ms auto-link after a pane reports a new pwd and the 5 s auto-unlink
     * sweep (graft-git.md §GIT-074…§GIT-081).
     *
     * UserDefaults in the Swift app, so `auto-detect-repos` in the config file here for the
     * same multi-client reason as the two flags above.
     */
    readonly autoDetectRepos: boolean;
    /**
     * §13 Settings ▸ General ▸ Worktrees "Base path" (SET-008), default
     * `~/nex/worktrees/<repo>`. `<repo>` and `~` expand daemon-side at create time (SET-009),
     * so this is the raw TEMPLATE — what the text field edits and the file stores.
     */
    readonly worktreeBasePath: string;
    /** §13's two "…placement" pickers (SET-013 / SET-014); `end-of-list` is the default. */
    readonly newWorkspacePlacement: 'end-of-list' | 'near-selection';
    readonly newGroupPlacement: 'end-of-list' | 'near-selection';
    /**
     * §13's Workspaces ▸ "Inherit group when creating a new workspace" (SET-011), default true.
     * A CLIENT-side rule (⌘N and the New Workspace form preselect the active workspace's
     * group); the wire verb is unchanged, so the CLI keeps its top-level default.
     */
    readonly inheritGroupOnNewWorkspace: boolean;
    /**
     * §13's Workspaces ▸ "Expand group when a workspace is dropped into it" (SET-012), default
     * true. A CLIENT-side rule like its neighbour above: the sidebar's drop carries the value on
     * `workspace-move` as `expand_on_drop`, so a CLI move (which never sets the field) keeps the
     * always-expand behaviour and only the window's gesture is governed by the toggle.
     */
    readonly expandGroupOnWorkspaceDrop: boolean;
    /**
     * §TERM-046 `clipboard-write`, default **false**: may a program running in a pane put text
     * on the clipboard with OSC 52?
     *
     * A DAEMON-side gate — with it off the sequence never reaches a client at all — but it rides
     * the snapshot for the two reasons every other daemon-enforced flag does: Settings ▸
     * Workspaces renders it, and two attached windows must not disagree about whether it is on.
     * There is no `clipboardRead` twin: OSC 52 reads are refused outright, with no key.
     */
    readonly clipboardWrite: boolean;
}

/**
 * Chrome styling + status-bar settings (shell-ui.md §2, §8.1).
 *
 * **Additive to config-keybindings.md §1.3's key list, and deliberately so.** The Swift app
 * keeps every one of these in `UserDefaults`, which a multi-client daemon has no equivalent of
 * — the same reasoning shell-ui.md's port note already applied to the two suppression flags.
 * The daemon's settings store is `~/.config/nex/config`, so each one becomes a documented
 * `key = value` line there; a hand-edit and a Settings click land in the same place, and two
 * attached windows cannot disagree about the palette.
 *
 * The `chrome-*` / `sidebar-*` keys are NEX-owned. Nothing here reaches the ghostty file: the
 * chrome palette is independent of the terminal theme by construction (SET-031).
 */
export interface WsChromeSettings {
    /** `chrome-appearance`: the window chrome's light/dark preference (SET-031). */
    readonly appearance: 'system' | 'light' | 'dark';
    /**
     * `chrome-colors`: `"<light|dark>:<ChromeColorKey>" → "RRGGBB"`, stored as compact JSON on
     * one line — the same map shape the Swift app persists in `settings.chromeColors`
     * (SET-033). An unparseable value yields `{}` rather than an error.
     */
    readonly colors: Readonly<Record<string, string>>;
    /** `sidebar-color-intensity`, 0…2, default 1 (SET-037). */
    readonly sidebarColorIntensity: number;
    /** `sidebar-avatar-fill`, 0…1, default 0.20 (SET-038). */
    readonly sidebarAvatarFill: number;
    /** `sidebar-avatar-stroke`, 0…1, default 0.45. */
    readonly sidebarAvatarStroke: number;
    /** `sidebar-group-fill`; **-1 is the sentinel** for "use the appearance preset". */
    readonly sidebarGroupFill: number;
    /** `sidebar-group-stroke`, 0…1, default 0. */
    readonly sidebarGroupStroke: number;
    /** `show-system-stats` master toggle, default true (SET-042). */
    readonly showSystemStats: boolean;
    /**
     * `system-stats`: the enabled metric ids, comma-joined and SORTED in the file, delivered
     * here in the canonical render order. Default `cpu,memory,load` (SET-043).
     */
    readonly enabledSystemStats: readonly string[];
    /** `show-system-stat-graphs`, default false (SET-044). */
    readonly showSystemStatGraphs: boolean;
    /** `sparkline-style`: `line` | `dots`. */
    readonly sparklineStyle: 'line' | 'dots';
    /** `sparkline-color`: `#rrggbb`, or `''` meaning "the adaptive chrome tone". */
    readonly sparklineColor: string;
    /** `sparkline-width`: 16…80, default 28. */
    readonly sparklineWidth: number;
    /**
     * The four search-highlight colours (SET-219 / TERM-021), each `#rrggbb`.
     *
     * The Swift app wrote these as a Nex-managed ghostty defaults FILE loaded before the
     * user's own config, so libghostty resolved them with the user's value winning. Nothing in
     * this architecture draws a search highlight inside an engine — the markdown/diff find
     * script, the web pane's find script and the terminal search reveal are all ours — so the
     * overridable-default idea becomes four nex-config keys carrying the Swift hexes as their
     * defaults (`search-match-color` #f2d027, `search-match-text-color` #000000,
     * `search-match-current-color` #ff7a00, `search-match-current-text-color` #000000).
     */
    readonly searchMatchColor: string;
    readonly searchMatchTextColor: string;
    readonly searchMatchCurrentColor: string;
    readonly searchMatchCurrentTextColor: string;
}

/** The six metrics, in the canonical footer order (`SystemStatKind.allCases`). */
export const SYSTEM_STAT_KINDS = ['cpu', 'memory', 'load', 'network', 'diskIO', 'diskSpace'] as const;
export type SystemStatKind = (typeof SYSTEM_STAT_KINDS)[number];

export function isSystemStatKind(value: string): value is SystemStatKind {
    return (SYSTEM_STAT_KINDS as readonly string[]).includes(value);
}

/** `SettingsFeature.swift:54`'s shipped default enabled set. */
export const DEFAULT_ENABLED_SYSTEM_STATS: readonly SystemStatKind[] = ['cpu', 'memory', 'load'];

export const DEFAULT_WS_CHROME_SETTINGS: WsChromeSettings = {
    appearance: 'system',
    colors: {},
    sidebarColorIntensity: 1,
    sidebarAvatarFill: 0.2,
    sidebarAvatarStroke: 0.45,
    // -1 = "use `chromeTheme.groupBandOpacity`" (SettingsFeature.swift:76's sentinel).
    sidebarGroupFill: -1,
    sidebarGroupStroke: 0,
    showSystemStats: true,
    enabledSystemStats: DEFAULT_ENABLED_SYSTEM_STATS,
    showSystemStatGraphs: false,
    sparklineStyle: 'line',
    sparklineColor: '',
    sparklineWidth: 28,
    // `NexGhosttyDefaults.swift:12-15`, verbatim.
    searchMatchColor: '#f2d027',
    searchMatchTextColor: '#000000',
    searchMatchCurrentColor: '#ff7a00',
    searchMatchCurrentTextColor: '#000000'
};

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
 * The keys of one resolved terminal palette — the client's `TerminalTheme` field names, as
 * data, so the daemon can name a colour without importing the client.
 *
 * Sixteen ANSI slots plus the six document colours ghostty theme files carry
 * (`background`, `foreground`, `cursor-color`, `cursor-text`, `selection-background`,
 * `selection-foreground`). The order is `palette = 0..15` order, which is what makes
 * `TERMINAL_PALETTE_ANSI_KEYS[n]` the key a `palette = n=#hex` line writes.
 */
export const TERMINAL_PALETTE_ANSI_KEYS = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite'
] as const;

export const TERMINAL_PALETTE_KEYS = [
    'background',
    'foreground',
    'cursor',
    'cursorAccent',
    'selectionBackground',
    'selectionForeground',
    ...TERMINAL_PALETTE_ANSI_KEYS
] as const;

export type TerminalPaletteKey = (typeof TERMINAL_PALETTE_KEYS)[number];

/**
 * §APP-014 — what `theme = <name>` actually resolved to.
 *
 * The Swift app handed the name to libghostty, which found the theme FILE and gave the
 * resolved palette back through the config it hands every surface. There is no libghostty
 * here, so the daemon does the same lookup itself: it finds the file, parses its palette keys
 * with the same reader it uses for the ghostty config, and puts the answer on the snapshot —
 * where it reaches every attached client through the ordinary `settings-changed` broadcast,
 * i.e. LIVE, without a relaunch.
 *
 * `palette` carries only the keys the theme file actually defined (a theme is allowed to set
 * six colours and no more), so a client merges it OVER its own light/dark preset rather than
 * treating it as a whole palette.
 *
 * `error` is the half that keeps an unresolvable name from being silent: the name stays
 * exactly where the user typed it, the terminal keeps the palette it already had, and the
 * reason ("no theme file named X in …") is a string a client can render.
 */
export interface WsTerminalThemeResolution {
    /** The theme name the lookup was performed for (after any `dark:`/`light:` split). */
    readonly name: string | null;
    /** Absolute path of the theme file the palette came from; null when nothing resolved. */
    readonly path: string | null;
    /** Only the keys the theme file defined, `#rrggbb` lowercase. Empty when unresolved. */
    readonly palette: Readonly<Partial<Record<TerminalPaletteKey, string>>>;
    /** Why the name did not resolve. Null when it did, and when no theme is configured. */
    readonly error: string | null;
}

/** "No theme configured, nothing resolved, nothing wrong." */
export const DEFAULT_WS_TERMINAL_THEME: WsTerminalThemeResolution = {
    name: null,
    path: null,
    palette: {},
    error: null
};

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
    /**
     * §APP-014: `theme` RESOLVED — the palette read out of the theme file, or the reason it
     * could not be. Additive: a daemon that predates it omits the field and a client's
     * hydrator fills `DEFAULT_WS_TERMINAL_THEME`, which is exactly the pre-§APP-014 behaviour
     * (preset palette, no note).
     */
    readonly terminalTheme: WsTerminalThemeResolution;
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
     * Chrome styling + status-bar settings, parsed from the same nex config file. Additive:
     * a daemon that predates it omits the field and `hydrateSettings` fills the defaults.
     */
    readonly chrome: WsChromeSettings;
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
    chrome: DEFAULT_WS_CHROME_SETTINGS,
    general: {
        focusFollowsMouse: false,
        focusFollowsMouseDelay: 100,
        theme: null,
        confirmWorkspaceDeleteWhenActive: true,
        confirmQuitWhenActive: true,
        tcpPort: 0,
        globalHotkey: null,
        globalHotkeyHideOnRepress: true,
        autoDetectRepos: true,
        worktreeBasePath: '~/nex/worktrees/<repo>',
        newWorkspacePlacement: 'end-of-list',
        newGroupPlacement: 'end-of-list',
        inheritGroupOnNewWorkspace: true,
        expandGroupOnWorkspaceDrop: true,
        clipboardWrite: false
    },
    appearance: {
        backgroundColor: DEFAULT_SETTINGS_BACKGROUND,
        backgroundOpacity: 1,
        fontFamily: null,
        fontSize: null,
        isDark: true,
        theme: null,
        terminalTheme: DEFAULT_WS_TERMINAL_THEME
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
 *   set-ghostty-setting `key`, `value` (or null to REMOVE the key)
 *
 * `set-ghostty-setting` is the odd one out and the boundary is deliberate: `background`,
 * `background-opacity`, `font-family`, `font-size` and `theme` are **ghostty's** keys, so they
 * are written to `~/.config/ghostty/config`, not to the nex config. Same preservation
 * guarantee as every other writer (every unrelated line survives byte-for-byte), same
 * write-through-then-re-read discipline, and the same watcher fans the result back out.
 */
export const WS_SETTINGS_COMMANDS = [
    'set-keybinding',
    'reset-keybindings',
    'set-general-setting',
    'set-profiles',
    'set-ghostty-setting'
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
    'confirm-workspace-delete',
    // The quit dialog's twin (§AGNT-117). Writable because BOTH sides now write it: the ⌘Q
    // dialog's "Don't ask again" checkbox and Settings ▸ Workspaces' toggle.
    'confirm-quit-when-active',
    // Additive, same reasoning, for the chrome styling + status-bar settings the Swift app also
    // keeps in UserDefaults (`WsChromeSettings` above documents each one).
    'chrome-appearance',
    'chrome-colors',
    'sidebar-color-intensity',
    'sidebar-avatar-fill',
    'sidebar-avatar-stroke',
    'sidebar-group-fill',
    'sidebar-group-stroke',
    'show-system-stats',
    'system-stats',
    'show-system-stat-graphs',
    'sparkline-style',
    'sparkline-color',
    'sparkline-width',
    // SET-219 / TERM-021: the Swift app's Nex-managed ghostty search-highlight defaults, as
    // four overridable nex keys (the Settings ▸ Appearance ▸ Search highlight rows write them).
    'search-match-color',
    'search-match-text-color',
    'search-match-current-color',
    'search-match-current-text-color',
    // Additive, same reasoning again: §13's Repositories auto-detect toggle is UserDefaults in
    // the Swift app and daemon behaviour here, so the daemon has to be able to read it back.
    'auto-detect-repos',
    // §13's General tab, same UserDefaults→config-key move: the worktree base-path template
    // and the two sidebar placement pickers (SET-008 / SET-013 / SET-014).
    'worktree-base-path',
    'new-workspace-placement',
    'new-group-placement',
    // …and the third Workspaces control beside them: SET-011's group inheritance.
    'inherit-group-on-new-workspace',
    // SET-012, the last of §13's six behaviour keys: the drop-into-a-collapsed-group rule.
    'expand-group-on-workspace-drop',
    // §TERM-046's OSC 52 gate. Not a Swift key either — ghostty owns `clipboard-write` there and
    // the app ships it wide open; here it is a nex key that ships OFF, and the Settings ▸
    // Workspaces toggle is what turns it on.
    'clipboard-write'
] as const;
export type WsWritableGeneralKey = (typeof WS_WRITABLE_GENERAL_KEYS)[number];

export function isWsWritableGeneralKey(key: string): key is WsWritableGeneralKey {
    return (WS_WRITABLE_GENERAL_KEYS as readonly string[]).includes(key);
}

/**
 * The ghostty keys `set-ghostty-setting` may write — exactly the five `settings/ghostty.ts`
 * READS, and not one more.
 *
 * The daemon is not a ghostty config implementation (that file's header says so): writing a
 * key it cannot parse back would let the UI claim a change it can neither show nor undo. A
 * value of `null` removes every line for the key, which is how "no explicit background, fall
 * back to the theme" is expressed.
 */
export const WS_WRITABLE_GHOSTTY_KEYS = [
    'background',
    'background-opacity',
    'font-family',
    'font-size',
    'theme'
] as const;
export type WsWritableGhosttyKey = (typeof WS_WRITABLE_GHOSTTY_KEYS)[number];

export function isWsWritableGhosttyKey(key: string): key is WsWritableGhosttyKey {
    return (WS_WRITABLE_GHOSTTY_KEYS as readonly string[]).includes(key);
}

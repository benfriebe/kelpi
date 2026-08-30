/**
 * M8 — settings sync: the daemon as the authority over `~/.config/nex/config` and
 * `~/.config/ghostty/config`.
 *
 *   `ghostty.ts` — the minimal ghostty appearance parser (5 keys, nothing else)
 *   `theme.ts`   — §APP-014's `theme = <name>` → theme FILE → palette resolution
 *   `watch.ts`   — fs.watch with debounce, rename re-attach and directory fallback
 *   `service.ts` — the snapshot, the watchers, and the three write-through mutations
 *
 * Wiring: `boot/compose.ts` creates the service, pushes its appearance into the content
 * service (so markdown/diff re-render on a ghostty theme change) and broadcasts
 * `settings-changed`; `ws/sync.ts` puts the snapshot in `welcome` and exposes the mutation
 * verbs. Shape and reasoning: `@kelpi/protocol` `ws/settings.ts`.
 */

export {
    DEFAULT_GHOSTTY_APPEARANCE,
    parseGhosttyAppearance,
    parseGhosttyColor,
    type GhosttyAppearance
} from './ghostty.js';

export {
    GHOSTTY_THEME_DIRS_ENV,
    parseGhosttyThemePalette,
    parsePaletteEntry,
    resolveGhosttyTheme,
    selectThemeName,
    themeSearchDirs,
    type ResolveThemeOptions,
    type TerminalPalette,
    type ThemeSearchOptions
} from './theme.js';

export {
    CONFIG_DEBOUNCE_MS,
    CONFIG_REATTACH_DELAY_MS,
    watchConfigFile,
    type ConfigWatchFn,
    type ConfigWatchHandle,
    type ConfigWatcher,
    type WatchConfigOptions
} from './watch.js';

export {
    GHOSTTY_CONFIG_PATH_ENV,
    SettingsError,
    buildSettingsSnapshot,
    contentAppearanceOf,
    createSettingsService,
    keybindLinesFrom,
    resolveGhosttyConfigPath,
    resolveTerminalTheme,
    type BuildSnapshotOptions,
    type SettingsPathLookup,
    type ThemeFileResolver,
    type SettingsService,
    type SettingsServiceOptions,
    type SettingsSnapshot
} from './service.js';

/**
 * `SettingsService` — the daemon as the settings authority (M8).
 *
 * Two files, one snapshot:
 *
 *   `~/.config/nex/config`      keybind lines + general settings   (config-keybindings.md §1)
 *   `~/.config/ghostty/config`  appearance                          (content-panes.md §3.1/§3.8)
 *
 * Both are watched; any change re-reads BOTH (they are cheap, and a single code path cannot
 * drift) and notifies subscribers — but only when the resulting snapshot actually differs, so
 * an editor's save burst, a `touch`, or the daemon's own write does not fan a no-op out to
 * every attached client.
 *
 * Mutations write THROUGH the file. Every setter resolves the current state *from disk*,
 * applies the change with a `@kelpi/core/config` writer (which preserves every unrelated line
 * byte-for-byte), writes atomically, then re-reads and notifies. The file is the source of
 * truth in both directions: there is no in-memory map that a hand-edit could contradict.
 *
 * Deliberate divergence from the Swift app, noted because it is user-visible: the Swift app
 * has **no watcher** on `~/.config/nex/config` ("hand-edits to `keybind` lines require an app
 * restart", §1.4). A daemon whose clients are long-lived browser tabs cannot ask for a
 * restart, so it watches. Everything the watcher produces is otherwise identical to what a
 * relaunch would have produced.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
    DEFAULT_GENERAL_SETTINGS,
    DEFAULT_KEYBINDINGS,
    isKelpiAction,
    keyTriggerConfigString,
    namedTerminalTheme,
    parseChromeSettings,
    parseGeneralSettings,
    parseKeyTrigger,
    parseKeybindOverrides,
    parseProfiles,
    parseRemoteDaemons,
    removeAllBindings,
    resolveKeyBindings,
    setBinding,
    setGeneralSetting,
    setGhosttySetting,
    triggersForAction,
    writeKeybindings,
    writeProfiles,
    writeRemoteDaemons,
    type KeyBindingMap,
    type KelpiAction,
    type Profile,
    type RemoteDaemon
} from '@kelpi/core/config';
import {
    DEFAULT_WS_SETTINGS,
    DEFAULT_WS_TERMINAL_THEME,
    isWsWritableGeneralKey,
    isWsWritableGhosttyKey,
    type WsProfile,
    type WsRemoteDaemon,
    type WsSettingsSnapshot,
    type WsTerminalThemeResolution
} from '@kelpi/protocol';

import { writeFileAtomic } from '../content/editor.js';
import { isDarkBackground } from '../content/html.js';
import { expandTilde } from '../lifecycle/rundir.js';
import { readConfigContents, resolveConfigPath } from '../boot/config.js';
import { DEFAULT_GHOSTTY_APPEARANCE, parseGhosttyAppearance } from './ghostty.js';
import { resolveGhosttyTheme } from './theme.js';
import { watchConfigFile, type ConfigWatchFn, type ConfigWatcher } from './watch.js';

/** Override for the ghostty config location. Additive; exists so tests never read the user's. */
export const GHOSTTY_CONFIG_PATH_ENV = 'KELPID_GHOSTTY_CONFIG';

export type SettingsSnapshot = WsSettingsSnapshot;

export interface SettingsPathLookup {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly home?: string | undefined;
}

/** `~/.config/ghostty/config`, or whatever `KELPID_GHOSTTY_CONFIG` names. */
export function resolveGhosttyConfigPath(lookup: SettingsPathLookup = {}): string {
    const env = lookup.env ?? process.env;
    const home = lookup.home ?? homedir();
    const override = env[GHOSTTY_CONFIG_PATH_ENV]?.trim();
    if (override !== undefined && override.length > 0) {
        return path.resolve(expandTilde(override, home));
    }
    return path.join(home, '.config', 'ghostty', 'config');
}

export interface SettingsServiceOptions extends SettingsPathLookup {
    /** Use this `~/.config/nex/config` path verbatim (otherwise resolved from env/home). */
    readonly configPath?: string | undefined;
    /** Use this ghostty config path verbatim. */
    readonly ghosttyPath?: string | undefined;
    /** `false` disables file watching entirely (tests, one-shot reads). */
    readonly watch?: boolean | undefined;
    readonly debounceMs?: number | undefined;
    readonly reattachDelayMs?: number | undefined;
    /** Injection point for tests; defaults to `fs.watch`. */
    readonly watchFn?: ConfigWatchFn | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface SettingsService {
    /** The current snapshot. Stable identity until something actually changes. */
    readonly snapshot: SettingsSnapshot;
    readonly configPath: string;
    readonly ghosttyPath: string;
    /** Re-read both files. Notifies subscribers only if the snapshot changed. */
    reload(): SettingsSnapshot;
    /** Fires on every real change (file edit or write-through). Returns the unsubscribe. */
    subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void;
    /**
     * Bind `action` to `trigger` (a config string like `super+d`), stealing it from whatever
     * held it; `trigger === null` removes every trigger the action currently has.
     */
    setKeybinding(action: string, trigger: string | null): SettingsSnapshot;
    /**
     * `action === null` → the whole map back to defaults (§5.4 `resetKeybindings`).
     * Otherwise → drop the action's triggers and re-add its default ones
     * (§5.4 `resetBindingsForAction`, which CAN steal a default trigger back).
     */
    resetKeybindings(action: string | null): SettingsSnapshot;
    /** One `key = value` general setting (§1.3's writable list). */
    setGeneralSetting(key: string, value: string): SettingsSnapshot;
    /**
     * One `key = value` in the **ghostty** config (`WS_WRITABLE_GHOSTTY_KEYS`), or `null` to
     * remove the key entirely. Same write-through discipline as every other setter: apply the
     * surgical `@kelpi/core/config` writer to the file's current contents, write atomically,
     * re-read, notify. The five writable keys are exactly the five `./ghostty.ts` parses back.
     */
    setGhosttySetting(key: string, value: string | null): SettingsSnapshot;
    /**
     * Replace the file's WHOLE profile section (§1.6/§9.5's write-through). Every non-`profile`
     * line survives byte-for-byte; profiles with a blank name, and vars with a blank key, are
     * dropped by the writer, so a name-only profile needs its `NEX_PROFILE` marker var to
     * survive a round-trip (the editor adds it).
     */
    setProfiles(profiles: readonly WsProfile[]): SettingsSnapshot;
    /**
     * Replace the file's WHOLE `remote-daemon` registry (§1.7) — `setProfiles`'s twin: full
     * replacement, every unrelated line preserved. Names must be non-blank and colon-free
     * (the name is the line's `<name>:` prefix); URLs non-blank.
     */
    setRemoteDaemons(daemons: readonly WsRemoteDaemon[]): SettingsSnapshot;
    dispose(): void;
}

/** A caller error worth reporting to the client verbatim (bad action name, bad trigger, …). */
export class SettingsError extends Error {}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

/** Structural equality over the snapshot; JSON is exact enough for a flat, ordered shape. */
function sameSnapshot(a: SettingsSnapshot, b: SettingsSnapshot): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** The `keybind` line VALUES in file order — what a client's binding builder consumes. */
export function keybindLinesFrom(contents: string): string[] {
    return parseKeybindOverrides(contents).map(
        (override) => `${keyTriggerConfigString(override.trigger)}=${override.action}`
    );
}

/**
 * §SET-105 / §SET-216: which terminal theme is actually selected.
 *
 * The Swift app read `theme = <name>` out of ITS config at launch and resolved it through
 * `KelpiTheme.named(id)` — a built-in or nothing — and the resolved theme is what the terminal
 * ended up using. Two rules follow, and both are here:
 *
 *   1. **ghostty's own file wins.** A `theme` line the user put in `~/.config/ghostty/config` is
 *      the theme ghostty resolves, and Kelpi never overrode it (§SET-217/§SET-218: the user's file
 *      beats our defaults). So the kelpi key is a FALLBACK, consulted only when ghostty says
 *      nothing.
 *   2. **A non-built-in selects nothing** (§SET-216). `namedTerminalTheme` matches exactly,
 *      case included, so `theme = dracula` or a typo leaves the answer null and the terminal
 *      keeps whatever ghostty already resolved — rather than the port guessing at a filename.
 */
export function resolveTerminalTheme(
    ghosttyTheme: string | null,
    kelpiTheme: string | null
): string | null {
    if (ghosttyTheme !== null && ghosttyTheme !== '') return ghosttyTheme;
    return namedTerminalTheme(kelpiTheme)?.id ?? null;
}

/**
 * §APP-014: the theme-file lookup, injected.
 *
 * `buildSettingsSnapshot` is a pure function of two file contents and stays that way — the
 * lookup reads OTHER files (the theme itself, on a search path), so it arrives as a callback
 * whose default resolves nothing. A caller that passes none gets the pre-§APP-014 snapshot,
 * which is what keeps every existing test of this function a test of parsing.
 */
export type ThemeFileResolver = (name: string | null, isDark: boolean) => WsTerminalThemeResolution;

const NO_THEME_RESOLUTION: ThemeFileResolver = () => DEFAULT_WS_TERMINAL_THEME;

export interface BuildSnapshotOptions {
    readonly resolveTheme?: ThemeFileResolver | undefined;
}

export function buildSettingsSnapshot(
    kelpiConfig: string,
    ghosttyConfig: string,
    options: BuildSnapshotOptions = {}
): SettingsSnapshot {
    const general = kelpiConfig === '' ? DEFAULT_GENERAL_SETTINGS : parseGeneralSettings(kelpiConfig);
    const appearance =
        ghosttyConfig === '' ? DEFAULT_GHOSTTY_APPEARANCE : parseGhosttyAppearance(ghosttyConfig);
    const chrome = parseChromeSettings(kelpiConfig);
    /**
     * §APP-014, in three steps that have to happen in this order:
     *
     *   1. **which name** — §SET-105's existing rule (ghostty's own `theme` line wins; the kelpi
     *      config's key is the fallback and only when it names one of the ten built-ins).
     *   2. **which file** — the injected resolver. The light/dark verdict it is given is the
     *      one the CONFIG produces, before any theme background: a `theme = dark:X,light:Y`
     *      cannot depend on the background the theme it selects is about to supply.
     *   3. **which background** — a theme's `background` is the resolved background
     *      (terminal-surface.md §3.2), but only when the user's own config names none. An
     *      explicit `background = …` line always wins, which is the same precedence
     *      §SET-217/§SET-218 give the user's file over ours.
     */
    const themeName = resolveTerminalTheme(appearance.theme, general.theme);
    const configuredIsDark = isDarkBackground(appearance.backgroundColor);
    const terminalTheme = (options.resolveTheme ?? NO_THEME_RESOLUTION)(themeName, configuredIsDark);
    const themeBackground = terminalTheme.palette.background;
    const backgroundColor =
        appearance.hasExplicitBackground || themeBackground === undefined
            ? appearance.backgroundColor
            : themeBackground;
    return {
        keybindLines: keybindLinesFrom(kelpiConfig),
        // §9.5: the Settings editor is the only consumer, and it must round-trip `~` values
        // unmodified — so the snapshot carries the UNEXPANDED parse. Spawn-time resolution
        // re-reads the file with expansion on and never looks at this list.
        profiles: parseProfiles(kelpiConfig, { expandTilde: false }).map((profile) => ({
            name: profile.name,
            env: { ...profile.env }
        })),
        // §1.7: the client's registry of other daemons (multi-daemon groups). Same
        // parse-on-every-read arrangement as profiles.
        remoteDaemons: parseRemoteDaemons(kelpiConfig).map((daemon) => ({ ...daemon })),
        // The chrome/status-bar half of the same file (`@kelpi/core/config`'s `chrome.ts`).
        // Additive: every field has a default, so a config that names none of these keys
        // produces exactly the shipped palette and the shipped gauge set.
        chrome: {
            appearance: chrome.appearance,
            colors: { ...chrome.colors },
            sidebarColorIntensity: chrome.sidebarColorIntensity,
            sidebarAvatarFill: chrome.sidebarAvatarFill,
            sidebarAvatarStroke: chrome.sidebarAvatarStroke,
            sidebarGroupFill: chrome.sidebarGroupFill,
            sidebarGroupStroke: chrome.sidebarGroupStroke,
            showSystemStats: chrome.showSystemStats,
            enabledSystemStats: [...chrome.enabledSystemStats],
            showSystemStatGraphs: chrome.showSystemStatGraphs,
            sparklineStyle: chrome.sparklineStyle,
            sparklineColor: chrome.sparklineColor,
            sparklineWidth: chrome.sparklineWidth,
            searchMatchColor: chrome.searchMatchColor,
            searchMatchTextColor: chrome.searchMatchTextColor,
            searchMatchCurrentColor: chrome.searchMatchCurrentColor,
            searchMatchCurrentTextColor: chrome.searchMatchCurrentTextColor
        },
        general: {
            focusFollowsMouse: general.focusFollowsMouse,
            focusFollowsMouseDelay: general.focusFollowsMouseDelay,
            theme: general.theme,
            confirmWorkspaceDeleteWhenActive: general.confirmWorkspaceDeleteWhenActive,
            // §AGNT-117: the quit dialog's suppression, now daemon-owned like its twin. The
            // Electron shell reads it off its own status WS's `welcome.settings`, so the ⌘Q
            // checkbox and Settings ▸ Workspaces can no longer disagree.
            confirmQuitWhenActive: general.confirmQuitWhenActive,
            tcpPort: general.tcpPort,
            // The CONFIG STRING, not the parsed trigger — the wire is JSON and the client's
            // recorder speaks this spelling in both directions.
            globalHotkey:
                general.globalHotkey === null ? null : keyTriggerConfigString(general.globalHotkey),
            globalHotkeyHideOnRepress: general.globalHotkeyHideOnRepress,
            // graft-git.md §GIT-074: the auto-link / auto-unlink gate. It rides the snapshot
            // rather than only being read where it is enforced, because Settings ▸ Repositories
            // renders it and every attached window must agree on its value.
            autoDetectRepos: general.autoDetectRepos,
            worktreeBasePath: general.worktreeBasePath,
            newWorkspacePlacement: general.newWorkspacePlacement,
            newGroupPlacement: general.newGroupPlacement,
            // SET-011: read by the CLIENT's create gestures (⌘N, the New Workspace form), so
            // it has to ride the snapshot rather than only being consulted daemon-side.
            inheritGroupOnNewWorkspace: general.inheritGroupOnNewWorkspace,
            // SET-012: the same shape for the sidebar's drop gesture — the client reads it and
            // puts the answer on `workspace-move` (`expand_on_drop`).
            expandGroupOnWorkspaceDrop: general.expandGroupOnWorkspaceDrop,
            // §TERM-046: the OSC 52 write gate. Enforced DAEMON-side — `handlers/app/clipboard.ts`
            // reads it through this snapshot at event time, so a Settings toggle governs the very
            // next sequence — and carried here because Settings ▸ Workspaces renders it.
            clipboardWrite: general.clipboardWrite
        },
        appearance: {
            // §APP-014: the theme's own background when the config names none — the "resolved
            // value, i.e. after any `theme` is applied" terminal-surface.md §3.2 specifies.
            // Everything downstream (pane fill, window compositing, the daemon's markdown /
            // diff HTML) reads this one field, so the theme reaches all of them at once.
            backgroundColor,
            backgroundOpacity: appearance.backgroundOpacity,
            fontFamily: appearance.fontFamily,
            fontSize: appearance.fontSize,
            windowPaddingX: appearance.windowPaddingX,
            windowPaddingY: appearance.windowPaddingY,
            // The luminance rule, computed once by the authority so the daemon's rendered
            // HTML and the client's chrome cannot disagree (content-panes.md port note 9).
            isDark: isDarkBackground(backgroundColor),
            // §SET-105: ghostty's own `theme` line, or — when it has none — the kelpi config's
            // `theme` key, but only when it names one of the ten built-ins (§SET-216).
            theme: themeName,
            // §APP-014: and what that name actually resolved to — the palette read out of the
            // theme file, or the reason it could not be read. Never silent either way.
            terminalTheme
        }
    };
}

/** `ContentService.setAppearance`'s input, derived from a snapshot. */
export function contentAppearanceOf(snapshot: SettingsSnapshot): {
    backgroundColor: string;
    backgroundOpacity: number;
} {
    return {
        backgroundColor: snapshot.appearance.backgroundColor,
        backgroundOpacity: snapshot.appearance.backgroundOpacity
    };
}

function requireAction(raw: string): KelpiAction {
    const action = raw.trim();
    if (!isKelpiAction(action)) throw new SettingsError(`unknown action '${raw}'`);
    return action;
}

export function createSettingsService(options: SettingsServiceOptions = {}): SettingsService {
    const home = options.home ?? homedir();
    const env = options.env ?? process.env;
    const configPath =
        options.configPath ?? resolveConfigPath({ env, home });
    const ghosttyPath = options.ghosttyPath ?? resolveGhosttyConfigPath({ env, home });
    const listeners = new Set<(snapshot: SettingsSnapshot) => void>();
    const watchers: ConfigWatcher[] = [];
    let current: SettingsSnapshot = DEFAULT_WS_SETTINGS;
    let disposed = false;

    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    /**
     * §APP-014: the real theme-file lookup, bound to THIS service's paths.
     *
     * `ghosttyPath` comes first in the search order, so a daemon pointed at a sandbox config
     * (`KELPID_GHOSTTY_CONFIG`) resolves themes from that sandbox's own `themes/` directory and
     * never from the developer's home — the same containment `resolveGhosttyConfigPath` gives
     * the config file itself.
     */
    const resolveTheme = (name: string | null, isDark: boolean): WsTerminalThemeResolution =>
        resolveGhosttyTheme(name, { env, home, ghosttyPath, isDark });

    const read = (): SettingsSnapshot =>
        buildSettingsSnapshot(readConfigContents(configPath), readConfigContents(ghosttyPath), {
            resolveTheme
        });

    const emit = (next: SettingsSnapshot): SettingsSnapshot => {
        if (sameSnapshot(next, current)) return current;
        current = next;
        for (const listener of [...listeners]) {
            try {
                listener(current);
            } catch (error) {
                report(error, 'settings listener');
            }
        }
        return current;
    };

    current = read();

    if (options.watch !== false) {
        for (const [target, label] of [
            [configPath, 'kelpi config'],
            [ghosttyPath, 'ghostty config']
        ] as const) {
            watchers.push(
                watchConfigFile({
                    path: target,
                    onChange: () => {
                        if (disposed) return;
                        try {
                            emit(read());
                        } catch (error) {
                            report(error, `${label} reload`);
                        }
                    },
                    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
                    ...(options.reattachDelayMs !== undefined
                        ? { reattachDelayMs: options.reattachDelayMs }
                        : {}),
                    ...(options.watchFn !== undefined ? { watch: options.watchFn } : {}),
                    onError: (error) => report(error, `watch ${label}`)
                })
            );
        }
    }

    /** Current file contents, or null when there is no file (the writers' input shape). */
    const contentsOrNull = (target: string): string | null => {
        try {
            return fs.readFileSync(target, 'utf8');
        } catch {
            return null;
        }
    };

    const currentBindings = (): KeyBindingMap =>
        resolveKeyBindings(parseKeybindOverrides(readConfigContents(configPath)));

    /** Write (or delete) the kelpi config, then re-read and notify. Throws on IO failure. */
    const commit = (next: string | null): SettingsSnapshot => {
        if (next === null) {
            // §5.3: an all-defaults map with nothing else in the file deletes it.
            try {
                fs.rmSync(configPath, { force: true });
            } catch (error) {
                throw new SettingsError(`could not remove ${configPath}: ${toError(error).message}`);
            }
        } else {
            try {
                fs.mkdirSync(path.dirname(configPath), { recursive: true });
                writeFileAtomic(configPath, next);
            } catch (error) {
                throw new SettingsError(`could not write ${configPath}: ${toError(error).message}`);
            }
        }
        // Re-read rather than trusting what we just wrote: the file is the authority, and this
        // makes the reply deterministic instead of racing the watcher's debounce (whose later
        // event then finds nothing changed and stays silent).
        return emit(read());
    };

    /**
     * The ghostty file's equivalent of `commit`. Separate because the two files have different
     * lifecycles: the kelpi config is ours to delete when it holds nothing (§5.3), the ghostty
     * config is the user's and is only ever rewritten in place — never removed, and created
     * only when a write needs somewhere to land.
     */
    const commitGhostty = (next: string): SettingsSnapshot => {
        try {
            fs.mkdirSync(path.dirname(ghosttyPath), { recursive: true });
            writeFileAtomic(ghosttyPath, next);
        } catch (error) {
            throw new SettingsError(`could not write ${ghosttyPath}: ${toError(error).message}`);
        }
        return emit(read());
    };

    return {
        get snapshot() {
            return current;
        },
        configPath,
        ghosttyPath,

        reload() {
            return emit(read());
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        setKeybinding(rawAction, rawTrigger) {
            const action = requireAction(rawAction);
            const bindings = currentBindings();
            if (rawTrigger === null) {
                return commit(
                    writeKeybindings(contentsOrNull(configPath), removeAllBindings(bindings, action))
                );
            }
            const trigger = parseKeyTrigger(rawTrigger);
            if (trigger === null) throw new SettingsError(`unparseable trigger '${rawTrigger}'`);
            return commit(
                writeKeybindings(contentsOrNull(configPath), setBinding(bindings, trigger, action))
            );
        },

        resetKeybindings(rawAction) {
            if (rawAction === null) {
                return commit(writeKeybindings(contentsOrNull(configPath), DEFAULT_KEYBINDINGS));
            }
            const action = requireAction(rawAction);
            // §5.4: drop the action's current triggers, then re-add its DEFAULT triggers —
            // which can steal one back from an action the user had rebound it to.
            let next = removeAllBindings(currentBindings(), action);
            for (const trigger of triggersForAction(DEFAULT_KEYBINDINGS, action)) {
                next = setBinding(next, trigger, action);
            }
            return commit(writeKeybindings(contentsOrNull(configPath), next));
        },

        setGeneralSetting(key, value) {
            const name = key.trim();
            if (!isWsWritableGeneralKey(name)) {
                // `theme` lands here on purpose: §1.3 — the app never writes it back.
                throw new SettingsError(`'${key}' is not a writable general setting`);
            }
            return commit(setGeneralSetting(contentsOrNull(configPath), name, value.trim()));
        },

        setGhosttySetting(key, value) {
            const name = key.trim();
            if (!isWsWritableGhosttyKey(name)) {
                // The five keys `./ghostty.ts` parses, and no others: writing a key this
                // daemon cannot read back would let the UI claim a change it cannot show.
                throw new SettingsError(`'${key}' is not a writable ghostty setting`);
            }
            return commitGhostty(
                setGhosttySetting(contentsOrNull(ghosttyPath), name, value === null ? null : value.trim())
            );
        },

        setProfiles(profiles) {
            const normalized: Profile[] = [];
            for (const profile of profiles) {
                if (typeof profile?.name !== 'string') {
                    throw new SettingsError('set-profiles requires a name on every profile');
                }
                const env: Record<string, string> = {};
                for (const [key, value] of Object.entries(profile.env ?? {})) {
                    if (typeof value !== 'string') {
                        throw new SettingsError(`profile '${profile.name}' has a non-string value for '${key}'`);
                    }
                    env[key] = value;
                }
                normalized.push({ name: profile.name, env });
            }
            // `writeProfiles` returns '' (an EMPTY file) rather than null when nothing is left —
            // the two writers genuinely differ, and §14 spells out that only the keybinding
            // writer deletes. Passing '' through `commit` keeps that behaviour.
            return commit(writeProfiles(contentsOrNull(configPath), normalized));
        },

        setRemoteDaemons(daemons) {
            const normalized: RemoteDaemon[] = [];
            for (const daemon of daemons) {
                if (typeof daemon?.name !== 'string' || daemon.name.trim() === '') {
                    throw new SettingsError('set-remote-daemons requires a name on every daemon');
                }
                if (typeof daemon.url !== 'string' || daemon.url.trim() === '') {
                    throw new SettingsError(`remote daemon '${daemon.name}' needs a URL`);
                }
                // The name is the config line's `<name>:` prefix; a colon inside it would
                // split as a shorter name with the rest leaking into the URL on re-read.
                if (daemon.name.includes(':')) {
                    throw new SettingsError(`remote daemon names may not contain ':' ('${daemon.name}')`);
                }
                normalized.push({ name: daemon.name.trim(), url: daemon.url.trim() });
            }
            return commit(writeRemoteDaemons(contentsOrNull(configPath), normalized));
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            for (const watcher of watchers) watcher.close();
            watchers.length = 0;
            listeners.clear();
        }
    };
}

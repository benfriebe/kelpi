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
 * applies the change with a `@nex/core/config` writer (which preserves every unrelated line
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
    isNexAction,
    keyTriggerConfigString,
    parseGeneralSettings,
    parseKeyTrigger,
    parseKeybindOverrides,
    parseProfiles,
    removeAllBindings,
    resolveKeyBindings,
    setBinding,
    setGeneralSetting,
    triggersForAction,
    writeKeybindings,
    writeProfiles,
    type KeyBindingMap,
    type NexAction,
    type Profile
} from '@nex/core/config';
import {
    DEFAULT_WS_SETTINGS,
    isWsWritableGeneralKey,
    type WsProfile,
    type WsSettingsSnapshot
} from '@nex/protocol';

import { writeFileAtomic } from '../content/editor.js';
import { isDarkBackground } from '../content/html.js';
import { expandTilde } from '../lifecycle/rundir.js';
import { readConfigContents, resolveConfigPath } from '../boot/config.js';
import { DEFAULT_GHOSTTY_APPEARANCE, parseGhosttyAppearance } from './ghostty.js';
import { watchConfigFile, type ConfigWatchFn, type ConfigWatcher } from './watch.js';

/** Override for the ghostty config location. Additive; exists so tests never read the user's. */
export const GHOSTTY_CONFIG_PATH_ENV = 'NEXD_GHOSTTY_CONFIG';

export type SettingsSnapshot = WsSettingsSnapshot;

export interface SettingsPathLookup {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly home?: string | undefined;
}

/** `~/.config/ghostty/config`, or whatever `NEXD_GHOSTTY_CONFIG` names. */
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
     * Replace the file's WHOLE profile section (§1.6/§9.5's write-through). Every non-`profile`
     * line survives byte-for-byte; profiles with a blank name, and vars with a blank key, are
     * dropped by the writer, so a name-only profile needs its `NEX_PROFILE` marker var to
     * survive a round-trip (the editor adds it).
     */
    setProfiles(profiles: readonly WsProfile[]): SettingsSnapshot;
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

export function buildSettingsSnapshot(
    nexConfig: string,
    ghosttyConfig: string
): SettingsSnapshot {
    const general = nexConfig === '' ? DEFAULT_GENERAL_SETTINGS : parseGeneralSettings(nexConfig);
    const appearance =
        ghosttyConfig === '' ? DEFAULT_GHOSTTY_APPEARANCE : parseGhosttyAppearance(ghosttyConfig);
    return {
        keybindLines: keybindLinesFrom(nexConfig),
        // §9.5: the Settings editor is the only consumer, and it must round-trip `~` values
        // unmodified — so the snapshot carries the UNEXPANDED parse. Spawn-time resolution
        // re-reads the file with expansion on and never looks at this list.
        profiles: parseProfiles(nexConfig, { expandTilde: false }).map((profile) => ({
            name: profile.name,
            env: { ...profile.env }
        })),
        general: {
            focusFollowsMouse: general.focusFollowsMouse,
            focusFollowsMouseDelay: general.focusFollowsMouseDelay,
            theme: general.theme,
            confirmWorkspaceDeleteWhenActive: general.confirmWorkspaceDeleteWhenActive
        },
        appearance: {
            backgroundColor: appearance.backgroundColor,
            backgroundOpacity: appearance.backgroundOpacity,
            fontFamily: appearance.fontFamily,
            fontSize: appearance.fontSize,
            // The luminance rule, computed once by the authority so the daemon's rendered
            // HTML and the client's chrome cannot disagree (content-panes.md port note 9).
            isDark: isDarkBackground(appearance.backgroundColor),
            theme: appearance.theme
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

function requireAction(raw: string): NexAction {
    const action = raw.trim();
    if (!isNexAction(action)) throw new SettingsError(`unknown action '${raw}'`);
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

    const read = (): SettingsSnapshot =>
        buildSettingsSnapshot(readConfigContents(configPath), readConfigContents(ghosttyPath));

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
            [configPath, 'nex config'],
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

    /** Write (or delete) the nex config, then re-read and notify. Throws on IO failure. */
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

        dispose() {
            if (disposed) return;
            disposed = true;
            for (const watcher of watchers) watcher.close();
            watchers.length = 0;
            listeners.clear();
        }
    };
}

/**
 * The system-wide global hotkey (docs/current/config-keybindings.md §8).
 *
 * Port note 8 of that doc puts this squarely in the Electron shell: the daemon has no OS
 * focus to steal and a browser tab cannot register a system hotkey. What has to survive the
 * port is the *contract*, not the Carbon call:
 *
 *   - the trigger is read from the shared config file (`global-hotkey = ctrl+alt+space`),
 *     parsed by the same `@kelpi/core/config` parser the daemon and the old Swift app use, so
 *     the file stays hand-editable and compatible;
 *   - `global-hotkey-hide-on-repress` (default true) makes a second press HIDE the app when
 *     it is already frontmost, instead of re-raising it (§8.2);
 *   - registration is a **staged swap** (§8.3): the new accelerator is registered first and
 *     the previous one is only dropped once the OS accepted it, so a rejected hotkey never
 *     costs the user their working one.
 *
 * `KELPID_CONFIG_PATH` is honoured exactly as the daemon honours it (`daemon/src/boot/config.ts`)
 * so a test/dev shell never reads the developer's real config.
 *
 * This module is pure (fs + string translation only); `./main.ts` owns `globalShortcut`.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
    DEFAULT_GENERAL_SETTINGS,
    KEY_CODE_TO_CONFIG_NAME,
    keyTriggerConfigString,
    parseGeneralSettings,
    type KeyTrigger
} from '@kelpi/core/config';
import { expandTilde } from '@kelpi/daemon/lifecycle';

export const CONFIG_PATH_ENV = 'KELPID_CONFIG_PATH';

/** `~/.config/nex/config`, or `KELPID_CONFIG_PATH`. Never creates anything. */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    const override = env[CONFIG_PATH_ENV]?.trim();
    if (override !== undefined && override.length > 0) return path.resolve(expandTilde(override, home));
    const preferred = path.join(home, '.config', 'kelpi', 'config');
    // Pre-cutover fallback: the daemon migrates the file on ITS first boot, and the shell can
    // read the hotkey before that has happened.
    if (!fs.existsSync(preferred)) {
        const legacy = path.join(home, '.config', 'nex', 'config');
        if (fs.existsSync(legacy)) return legacy;
    }
    return preferred;
}

/**
 * config key name → Electron accelerator token.
 *
 * Only the spellings that differ from the config name are listed; letters, digits and the
 * punctuation keys pass through (uppercased for letters, which is what Electron expects).
 * `delete` is keyCode 51 — the Mac "Delete" key, which every other platform calls Backspace,
 * and which Electron spells `Backspace`.
 */
const ACCELERATOR_KEYS: ReadonlyMap<string, string> = new Map([
    ['return', 'Return'],
    ['tab', 'Tab'],
    ['escape', 'Escape'],
    ['space', 'Space'],
    ['delete', 'Backspace'],
    ['forward_delete', 'Delete'],
    ['left', 'Left'],
    ['right', 'Right'],
    ['up', 'Up'],
    ['down', 'Down']
]);

/** Punctuation Electron accepts verbatim as an accelerator key. */
const PASSTHROUGH_KEYS = new Set(['[', ']', ';', "'", '`', ',', '.', '/', '\\', '-', '=']);

/**
 * A `KeyTrigger` as an Electron accelerator, or null when the key has no accelerator
 * spelling (an unmapped keyCode). `super` becomes `CommandOrControl` so a Linux build of the
 * shell keeps the same config file working.
 */
export function acceleratorForTrigger(trigger: KeyTrigger): string | null {
    const name = KEY_CODE_TO_CONFIG_NAME.get(trigger.keyCode);
    if (name === undefined) return null;

    let key: string | undefined;
    if (ACCELERATOR_KEYS.has(name)) key = ACCELERATOR_KEYS.get(name);
    else if (/^[a-z]$/.test(name)) key = name.toUpperCase();
    else if (/^\d$/.test(name)) key = name;
    else if (/^f\d{1,2}$/.test(name)) key = name.toUpperCase();
    else if (PASSTHROUGH_KEYS.has(name)) key = name;
    if (key === undefined) return null;

    const parts: string[] = [];
    // Electron's canonical order; `MODIFIER_ORDER` in the config file is ctrl, alt, shift,
    // super, which is the same relative order with Command last.
    if (trigger.modifiers.includes('ctrl')) parts.push('Control');
    if (trigger.modifiers.includes('alt')) parts.push('Alt');
    if (trigger.modifiers.includes('shift')) parts.push('Shift');
    if (trigger.modifiers.includes('super')) parts.push('CommandOrControl');
    parts.push(key);
    return parts.join('+');
}

export interface GlobalHotkeySettings {
    readonly configPath: string;
    readonly configExists: boolean;
    readonly trigger: KeyTrigger | null;
    /** The trigger as it is spelled in the config file, for logs/diagnostics. */
    readonly configString: string | null;
    readonly accelerator: string | null;
    readonly hideOnRepress: boolean;
}

/** Read + parse the hotkey half of the config file. A missing file yields the defaults. */
export function readGlobalHotkeySettings(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): GlobalHotkeySettings {
    const configPath = resolveConfigPath(env, home);
    let contents = '';
    let configExists = true;
    try {
        contents = fs.readFileSync(configPath, 'utf8');
    } catch {
        configExists = false;
    }
    const general = contents === '' ? DEFAULT_GENERAL_SETTINGS : parseGeneralSettings(contents);
    const trigger = general.globalHotkey;
    return {
        configPath,
        configExists,
        trigger,
        configString: trigger === null ? null : keyTriggerConfigString(trigger),
        accelerator: trigger === null ? null : acceleratorForTrigger(trigger),
        hideOnRepress: general.globalHotkeyHideOnRepress
    };
}

export interface HotkeyRegistrar {
    register(accelerator: string, handler: () => void): boolean;
    unregister(accelerator: string): void;
    isRegistered(accelerator: string): boolean;
}

export interface HotkeySwapResult {
    readonly accelerator: string | null;
    readonly ok: boolean;
    readonly error?: string;
}

/**
 * §SET-200/§SET-201: one registration outcome, in the shape the daemon relays to every client.
 *
 * Declared here rather than in `./status.ts` because THIS module owns the facts: it read the
 * config line, it knows whether the trigger has an accelerator spelling, and it performed the
 * swap. `./status.ts` only puts the record on a socket.
 */
export interface HotkeyStatusReport {
    /** The accelerator that is live NOW — after a rejected swap that is the previous one. */
    readonly accelerator: string | null;
    /** The config-file spelling that was asked for; null when the hotkey is unset. */
    readonly configString: string | null;
    readonly ok: boolean;
    readonly error: string | null;
    /** `launch` is §8.4's config-load path; `settings` is a re-register after a config write. */
    readonly source: 'launch' | 'settings';
}

/**
 * The report for one registration attempt (§SET-200/§SET-201).
 *
 * `result === null` means the attempt never happened because the trigger has no Electron
 * accelerator spelling — a case Carbon cannot produce, so the wording is the port's own. It is
 * still a FAILURE report: the config file names a hotkey, and without one Settings would show a
 * chord that nothing ever tried to register.
 *
 * Everything else follows the Swift reducer: a rejection keeps the reason string (and the
 * configured value, which is never written back), and success — including "no hotkey
 * configured" — reports `ok`, which is what clears a standing warning.
 */
export function hotkeyStatusReport(
    settings: GlobalHotkeySettings,
    result: HotkeySwapResult | null,
    source: 'launch' | 'settings'
): HotkeyStatusReport {
    if (result === null) {
        return {
            accelerator: null,
            configString: settings.configString,
            ok: false,
            error: `“${settings.configString ?? '?'}” cannot be registered as a system shortcut on this platform.`,
            source
        };
    }
    if (settings.accelerator === null || result.ok) {
        return {
            accelerator: result.accelerator,
            configString: settings.configString,
            ok: true,
            error: null,
            source
        };
    }
    return {
        accelerator: result.accelerator,
        configString: settings.configString,
        ok: false,
        error: result.error ?? 'This shortcut could not be registered.',
        source
    };
}

/**
 * §8.3 staged swap: register the new accelerator BEFORE dropping the old one, so a rejection
 * (another app already owns the combo) leaves the previous registration live. Registering the
 * identical accelerator is a no-op, and `null` just unregisters.
 */
export function swapGlobalHotkey(
    registrar: HotkeyRegistrar,
    previous: string | null,
    next: string | null,
    handler: () => void
): HotkeySwapResult {
    if (next === previous) return { accelerator: previous, ok: true };
    if (next === null) {
        if (previous !== null) registrar.unregister(previous);
        return { accelerator: null, ok: true };
    }
    let accepted = false;
    try {
        accepted = registrar.register(next, handler);
    } catch (error) {
        return {
            accelerator: previous,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
    if (!accepted) {
        return { accelerator: previous, ok: false, error: 'This shortcut is already claimed by another app.' };
    }
    if (previous !== null) registrar.unregister(previous);
    return { accelerator: next, ok: true };
}

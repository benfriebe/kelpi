import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeKeyTrigger, parseKeyTrigger } from '@kelpi/core/config';

import {
    acceleratorForTrigger,
    hotkeyStatusReport,
    readGlobalHotkeySettings,
    resolveConfigPath,
    swapGlobalHotkey,
    type HotkeyRegistrar
} from './hotkey.js';

/** A registrar that accepts (or refuses) every registration, for the report branches below. */
function registrarFor(accept: boolean): HotkeyRegistrar {
    const registered: string[] = [];
    return {
        register(accelerator) {
            if (accept) registered.push(accelerator);
            return accept;
        },
        unregister: () => undefined,
        isRegistered: (accelerator) => registered.includes(accelerator)
    };
}

const dirs: string[] = [];

function configFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-shell-config-'));
    dirs.push(dir);
    const file = path.join(dir, 'config');
    fs.writeFileSync(file, contents);
    return file;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('resolveConfigPath', () => {
    it('defaults to ~/.config/kelpi/config', () => {
        expect(resolveConfigPath({}, '/Users/test')).toBe('/Users/test/.config/kelpi/config');
    });

    it('honours KELPID_CONFIG_PATH, tilde included', () => {
        expect(resolveConfigPath({ KELPID_CONFIG_PATH: '~/alt/config' }, '/Users/test')).toBe('/Users/test/alt/config');
        expect(resolveConfigPath({ KELPID_CONFIG_PATH: '  ' }, '/Users/test')).toBe('/Users/test/.config/kelpi/config');
    });
});

describe('acceleratorForTrigger', () => {
    const accel = (spec: string): string | null => {
        const trigger = parseKeyTrigger(spec);
        expect(trigger).not.toBeNull();
        return acceleratorForTrigger(trigger as NonNullable<typeof trigger>);
    };

    it('translates the documented example', () => {
        expect(accel('ctrl+alt+space')).toBe('Control+Alt+Space');
    });

    it('maps super to CommandOrControl and uppercases letters', () => {
        expect(accel('super+shift+k')).toBe('Shift+CommandOrControl+K');
        expect(accel('cmd+1')).toBe('CommandOrControl+1');
    });

    it('spells the named keys the way Electron does', () => {
        expect(accel('ctrl+return')).toBe('Control+Return');
        expect(accel('ctrl+escape')).toBe('Control+Escape');
        expect(accel('ctrl+tab')).toBe('Control+Tab');
        // keyCode 51 is the Mac Delete key, which Electron calls Backspace.
        expect(accel('ctrl+backspace')).toBe('Control+Backspace');
        expect(accel('ctrl+forward_delete')).toBe('Control+Delete');
        expect(accel('ctrl+up')).toBe('Control+Up');
        expect(accel('alt+f12')).toBe('Alt+F12');
    });

    it('passes punctuation through', () => {
        expect(accel('super+open_bracket')).toBe('CommandOrControl+[');
        expect(accel('super+minus')).toBe('CommandOrControl+-');
    });

    it('returns null for a keyCode with no accelerator spelling', () => {
        expect(acceleratorForTrigger(makeKeyTrigger(9999, ['ctrl']))).toBeNull();
    });
});

describe('readGlobalHotkeySettings', () => {
    it('reads the trigger and the hide-on-repress default', () => {
        const file = configFile('global-hotkey = ctrl+alt+space\n');
        const settings = readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file });
        expect(settings.configExists).toBe(true);
        expect(settings.accelerator).toBe('Control+Alt+Space');
        expect(settings.configString).toBe('ctrl+alt+space');
        expect(settings.hideOnRepress).toBe(true);
    });

    it('honours global-hotkey-hide-on-repress = false', () => {
        const file = configFile('global-hotkey = super+shift+n\nglobal-hotkey-hide-on-repress = false\n');
        expect(readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file }).hideOnRepress).toBe(false);
    });

    it('clears on none/unbind and ignores garbage', () => {
        expect(readGlobalHotkeySettings({ KELPID_CONFIG_PATH: configFile('global-hotkey = none\n') }).trigger).toBeNull();
        expect(readGlobalHotkeySettings({ KELPID_CONFIG_PATH: configFile('global-hotkey = wat+zzz\n') }).trigger).toBeNull();
    });

    it('treats a missing file as no hotkey', () => {
        const settings = readGlobalHotkeySettings({ KELPID_CONFIG_PATH: '/nonexistent/kelpi/config' });
        expect(settings.configExists).toBe(false);
        expect(settings.accelerator).toBeNull();
        expect(settings.hideOnRepress).toBe(true);
    });
});

describe('swapGlobalHotkey', () => {
    function registrar(accept: boolean): HotkeyRegistrar & { registered: string[]; unregistered: string[] } {
        const registered: string[] = [];
        const unregistered: string[] = [];
        return {
            registered,
            unregistered,
            register(accelerator) {
                registered.push(accelerator);
                return accept;
            },
            unregister(accelerator) {
                unregistered.push(accelerator);
            },
            isRegistered: (accelerator) => registered.includes(accelerator) && !unregistered.includes(accelerator)
        };
    }

    it('registers the new accelerator before dropping the old one', () => {
        const registry = registrar(true);
        const result = swapGlobalHotkey(registry, 'Control+Alt+Space', 'Control+Alt+N', () => undefined);
        expect(result).toEqual({ accelerator: 'Control+Alt+N', ok: true });
        expect(registry.registered).toEqual(['Control+Alt+N']);
        expect(registry.unregistered).toEqual(['Control+Alt+Space']);
    });

    it('keeps the previous registration when the OS rejects the new one', () => {
        const registry = registrar(false);
        const result = swapGlobalHotkey(registry, 'Control+Alt+Space', 'Control+Alt+N', () => undefined);
        expect(result.ok).toBe(false);
        expect(result.accelerator).toBe('Control+Alt+Space');
        expect(registry.unregistered).toEqual([]);
    });

    it('is a no-op for the identical accelerator', () => {
        const registry = registrar(true);
        expect(swapGlobalHotkey(registry, 'Control+Alt+N', 'Control+Alt+N', () => undefined).ok).toBe(true);
        expect(registry.registered).toEqual([]);
    });

    it('unregisters when the config clears the hotkey', () => {
        const registry = registrar(true);
        const result = swapGlobalHotkey(registry, 'Control+Alt+N', null, () => undefined);
        expect(result).toEqual({ accelerator: null, ok: true });
        expect(registry.unregistered).toEqual(['Control+Alt+N']);
    });

    it('survives a registrar that throws', () => {
        const registry: HotkeyRegistrar = {
            register() {
                throw new Error('boom');
            },
            unregister: () => undefined,
            isRegistered: () => false
        };
        const result = swapGlobalHotkey(registry, 'Control+Alt+Space', 'Control+Alt+N', () => undefined);
        expect(result).toMatchObject({ ok: false, accelerator: 'Control+Alt+Space', error: 'boom' });
    });
});

/**
 * SET-081's shell half: re-registering when the daemon says the config changed.
 *
 * `main.ts` wires `StatusHost.settingsChanged` to `registerGlobalHotkey()`, which is a re-READ
 * followed by a staged swap. That function itself needs Electron, so what is asserted here is
 * the two properties that make wiring it to a broadcast correct:
 *
 *   1. a re-read after the file changes yields the NEW accelerator (the shell is not caching
 *      the launch-time value anywhere);
 *   2. re-registering the same accelerator touches nothing — so firing on every settings write,
 *      including the many that have nothing to do with hotkeys, costs one file read.
 */
describe('re-reading after a settings write', () => {
    function registrar(): HotkeyRegistrar & { registered: string[]; unregistered: string[] } {
        const registered: string[] = [];
        const unregistered: string[] = [];
        return {
            registered,
            unregistered,
            register: (accelerator) => (registered.push(accelerator), true),
            unregister: (accelerator) => void unregistered.push(accelerator),
            isRegistered: () => false
        };
    }

    it('picks up a hotkey the Settings recorder just wrote', () => {
        const file = configFile('focus-follows-mouse = true\n');
        expect(readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file }).accelerator).toBeNull();

        // What `set-general-setting global-hotkey = …` leaves on disk.
        fs.writeFileSync(file, 'focus-follows-mouse = true\nglobal-hotkey = ctrl+alt+shift+k\n');
        const after = readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file });
        expect(after.configString).toBe('ctrl+alt+shift+k');
        expect(after.accelerator).toBe('Control+Alt+Shift+K');
    });

    it('picks up the ✕ clearing it', () => {
        const file = configFile('global-hotkey = ctrl+alt+space\n');
        expect(readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file }).accelerator).toBe('Control+Alt+Space');
        fs.writeFileSync(file, 'global-hotkey = none\n');
        expect(readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file }).accelerator).toBeNull();
    });

    it('is free to fire on a settings write that changed something else', () => {
        const file = configFile('global-hotkey = ctrl+alt+space\n');
        const registry = registrar();
        const first = readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file });
        let current = swapGlobalHotkey(registry, null, first.accelerator, () => undefined).accelerator;
        expect(registry.registered).toEqual(['Control+Alt+Space']);

        // An unrelated key changes; the broadcast fires; the shell re-reads and re-swaps.
        fs.writeFileSync(file, 'global-hotkey = ctrl+alt+space\nshow-system-stats = false\n');
        const second = readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file });
        current = swapGlobalHotkey(registry, current, second.accelerator, () => undefined).accelerator;
        expect(current).toBe('Control+Alt+Space');
        // Nothing was registered or unregistered a second time.
        expect(registry.registered).toEqual(['Control+Alt+Space']);
        expect(registry.unregistered).toEqual([]);
    });

    it('honours the repress flag changing under it', () => {
        const file = configFile('global-hotkey = ctrl+alt+space\n');
        expect(readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file }).hideOnRepress).toBe(true);
        fs.writeFileSync(file, 'global-hotkey = ctrl+alt+space\nglobal-hotkey-hide-on-repress = false\n');
        expect(readGlobalHotkeySettings({ KELPID_CONFIG_PATH: file }).hideOnRepress).toBe(false);
    });
});

/**
 * §SET-200 / §SET-201: the registration OUTCOME, in the shape the daemon relays to Settings.
 *
 * The Swift reducer keeps the reason string in state and Settings ▸ Keybindings renders it; the
 * port's registrar lives in another process, so the report has to be a value first. These are
 * the branches that value has to get right — including the two the Swift app cannot produce
 * (an unspellable trigger) and the one nobody sees unless it works (success clearing a standing
 * warning).
 */
describe('hotkeyStatusReport', () => {
    const configured = (contents: string) =>
        readGlobalHotkeySettings({ KELPID_CONFIG_PATH: configFile(contents) });

    it('reports a rejected registration with the reason and the STILL-LIVE accelerator', () => {
        const settings = configured('global-hotkey = ctrl+alt+n\n');
        const registry = registrarFor(false);
        const result = swapGlobalHotkey(registry, 'Control+Alt+Space', settings.accelerator, () => undefined);
        const report = hotkeyStatusReport(settings, result, 'settings');
        expect(report).toEqual({
            // §8.3's staged swap: the previous hotkey is what is registered right now.
            accelerator: 'Control+Alt+Space',
            configString: 'ctrl+alt+n',
            ok: false,
            error: 'This shortcut is already claimed by another app.',
            source: 'settings'
        });
    });

    it('keeps the CONFIGURED value in the report on a launch-path failure (§SET-201)', () => {
        const settings = configured('global-hotkey = ctrl+alt+n\n');
        const result = swapGlobalHotkey(registrarFor(false), null, settings.accelerator, () => undefined);
        const report = hotkeyStatusReport(settings, result, 'launch');
        // The file is never rewritten, and the report still names what the user asked for — so
        // Settings shows the failing chord for them to see and edit.
        expect(report.configString).toBe('ctrl+alt+n');
        expect(report.accelerator).toBeNull();
        expect(report.ok).toBe(false);
        expect(report.source).toBe('launch');
    });

    it('reports success, which is what CLEARS a standing warning', () => {
        const settings = configured('global-hotkey = ctrl+alt+n\n');
        const result = swapGlobalHotkey(registrarFor(true), null, settings.accelerator, () => undefined);
        expect(hotkeyStatusReport(settings, result, 'settings')).toEqual({
            accelerator: 'Control+Alt+N',
            configString: 'ctrl+alt+n',
            ok: true,
            error: null,
            source: 'settings'
        });
    });

    it('reports "no hotkey configured" as a success, not a failure', () => {
        const settings = configured('global-hotkey = none\n');
        const result = swapGlobalHotkey(registrarFor(true), 'Control+Alt+N', null, () => undefined);
        expect(hotkeyStatusReport(settings, result, 'settings')).toEqual({
            accelerator: null,
            configString: null,
            ok: true,
            error: null,
            source: 'settings'
        });
    });

    it('reports a trigger with no Electron accelerator spelling as a failure', () => {
        // `f20` parses as a trigger but has no accelerator name, so nothing is ever attempted —
        // and without a report the row would show a chord that was never registered.
        const settings = { ...configured('global-hotkey = none\n'), configString: 'f20', accelerator: null };
        const report = hotkeyStatusReport(settings, null, 'launch');
        expect(report.ok).toBe(false);
        expect(report.error).toContain('f20');
        expect(report.accelerator).toBeNull();
    });
});

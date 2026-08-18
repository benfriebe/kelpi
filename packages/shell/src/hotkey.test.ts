import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeKeyTrigger, parseKeyTrigger } from '@nex/core/config';

import {
    acceleratorForTrigger,
    readGlobalHotkeySettings,
    resolveConfigPath,
    swapGlobalHotkey,
    type HotkeyRegistrar
} from './hotkey.js';

const dirs: string[] = [];

function configFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-shell-config-'));
    dirs.push(dir);
    const file = path.join(dir, 'config');
    fs.writeFileSync(file, contents);
    return file;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('resolveConfigPath', () => {
    it('defaults to ~/.config/nex/config', () => {
        expect(resolveConfigPath({}, '/Users/test')).toBe('/Users/test/.config/nex/config');
    });

    it('honours NEXD_CONFIG_PATH, tilde included', () => {
        expect(resolveConfigPath({ NEXD_CONFIG_PATH: '~/alt/config' }, '/Users/test')).toBe('/Users/test/alt/config');
        expect(resolveConfigPath({ NEXD_CONFIG_PATH: '  ' }, '/Users/test')).toBe('/Users/test/.config/nex/config');
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
        const settings = readGlobalHotkeySettings({ NEXD_CONFIG_PATH: file });
        expect(settings.configExists).toBe(true);
        expect(settings.accelerator).toBe('Control+Alt+Space');
        expect(settings.configString).toBe('ctrl+alt+space');
        expect(settings.hideOnRepress).toBe(true);
    });

    it('honours global-hotkey-hide-on-repress = false', () => {
        const file = configFile('global-hotkey = super+shift+n\nglobal-hotkey-hide-on-repress = false\n');
        expect(readGlobalHotkeySettings({ NEXD_CONFIG_PATH: file }).hideOnRepress).toBe(false);
    });

    it('clears on none/unbind and ignores garbage', () => {
        expect(readGlobalHotkeySettings({ NEXD_CONFIG_PATH: configFile('global-hotkey = none\n') }).trigger).toBeNull();
        expect(readGlobalHotkeySettings({ NEXD_CONFIG_PATH: configFile('global-hotkey = wat+zzz\n') }).trigger).toBeNull();
    });

    it('treats a missing file as no hotkey', () => {
        const settings = readGlobalHotkeySettings({ NEXD_CONFIG_PATH: '/nonexistent/nex/config' });
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

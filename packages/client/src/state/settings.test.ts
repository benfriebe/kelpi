/**
 * The client half of settings sync (M8): the store slice and the bridge subscription.
 *
 * What matters here is that the slice is a THIRD slice — never touched by snapshot/delta
 * replay — and that its identity is stable, because everything downstream (the key
 * dispatcher, the theme provider, the terminal font) is memoized on it.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import { CommandClient, KelpiConnection } from '../connection';
import { createFakeSocketFactory } from '../connection/testing';
import { connectStore } from './bridge';
import { createKelpiStore, hydrateSettings } from './store';

const SETTINGS: WsSettingsSnapshot = {
    remoteDaemons: [{ name: 'werk', url: 'https://werk.taila.ts.net/?token=kd_x' }],
    keybindLines: ['ctrl+alt+t=split_right'],
    // M8 Settings ▸ Profiles: the config file's `profile` lines ride the same snapshot.
    profiles: [{ name: 'work', env: { CLAUDE_CONFIG_DIR: '~/.claude-accounts/work' } }],
    // The chrome/status-bar half of the same file. Spread from the defaults rather than
    // restated: this fixture exists to prove the hydrator is field-for-field faithful, and a
    // literal here would have to be retyped every time a styling key is added.
    chrome: DEFAULT_WS_SETTINGS.chrome,
    general: {
        ...DEFAULT_WS_SETTINGS.general,
        focusFollowsMouse: true,
        focusFollowsMouseDelay: 250,
        theme: 'Nord',
        confirmWorkspaceDeleteWhenActive: true
    },
    appearance: {
        backgroundColor: '#ffffff',
        backgroundOpacity: 0.8,
        fontFamily: 'Menlo',
        fontSize: 15,
        windowPaddingX: 4,
        windowPaddingY: 3,
        isDark: false,
        theme: 'Catppuccin Latte',
        // §APP-014: and what that name RESOLVED to — the palette the daemon read out of the
        // theme FILE. Partial on purpose: a theme sets the keys it sets, and the client merges
        // them over its own light/dark preset.
        terminalTheme: {
            name: 'Catppuccin Latte',
            path: '/themes/Catppuccin Latte',
            palette: { background: '#eff1f5', foreground: '#4c4f69' },
            error: null
        }
    }
};

describe('hydrateSettings', () => {
    it('accepts a well-formed payload verbatim', () => {
        expect(hydrateSettings(SETTINGS)).toEqual(SETTINGS);
    });

    it('falls back per field rather than blanking the whole snapshot', () => {
        const hydrated = hydrateSettings({
            keybindLines: ['a=b', 7, null],
            general: { focusFollowsMouse: 'yes', focusFollowsMouseDelay: -5 },
            appearance: { backgroundColor: '', backgroundOpacity: 4, fontSize: 'big' }
        });
        expect(hydrated).not.toBeNull();
        expect(hydrated?.keybindLines).toEqual(['a=b']);
        expect(hydrated?.general.focusFollowsMouse).toBe(DEFAULT_WS_SETTINGS.general.focusFollowsMouse);
        expect(hydrated?.general.focusFollowsMouseDelay).toBe(0);
        expect(hydrated?.general.theme).toBeNull();
        expect(hydrated?.appearance.backgroundColor).toBe(DEFAULT_WS_SETTINGS.appearance.backgroundColor);
        expect(hydrated?.appearance.backgroundOpacity).toBe(1);
        expect(hydrated?.appearance.fontSize).toBeNull();
    });

    it('rejects a non-object payload', () => {
        expect(hydrateSettings(undefined)).toBeNull();
        expect(hydrateSettings('nope')).toBeNull();
        expect(hydrateSettings([])).toBeNull();
    });
});

describe('the settings slice', () => {
    it('starts on the defaults, unloaded', () => {
        const store = createKelpiStore();
        expect(store.getState().settings).toEqual({
            value: DEFAULT_WS_SETTINGS,
            loaded: false,
            // §SET-200: nobody has registered a hotkey, so there is nothing to warn about.
            hotkeyStatus: null
        });
    });

    it('applySettings marks it loaded', () => {
        const store = createKelpiStore();
        store.getState().applySettings(SETTINGS);
        expect(store.getState().settings.loaded).toBe(true);
        expect(store.getState().settings.value).toEqual(SETTINGS);
    });

    it('stays unloaded (and on the defaults) for a daemon that sends nothing', () => {
        const store = createKelpiStore();
        store.getState().applySettings(undefined);
        expect(store.getState().settings).toEqual({
            value: DEFAULT_WS_SETTINGS,
            loaded: false,
            hotkeyStatus: null
        });
    });

    it('keeps object identity when an identical payload arrives again', () => {
        const store = createKelpiStore();
        store.getState().applySettings(SETTINGS);
        const first = store.getState().settings;
        store.getState().applySettings({ ...SETTINGS, general: { ...SETTINGS.general } });
        expect(store.getState().settings).toBe(first);
    });

    it('replaces the value when something actually changed', () => {
        const store = createKelpiStore();
        store.getState().applySettings(SETTINGS);
        store.getState().applySettings({ ...SETTINGS, keybindLines: [] });
        expect(store.getState().settings.value.keybindLines).toEqual([]);
        expect(store.getState().settings.value.appearance).toEqual(SETTINGS.appearance);
    });

    it('is untouched by snapshot and delta replay', () => {
        const store = createKelpiStore();
        store.getState().applySettings(SETTINGS);
        store.getState().applySnapshot(0, {
            workspaces: [],
            groups: [],
            topLevelOrder: [],
            lastActiveWorkspaceID: null,
            repos: [],
            labelPresets: []
        });
        store.getState().applyDelta(1, [{ kind: 'label-presets-changed', presets: [] }]);
        expect(store.getState().settings.value).toEqual(SETTINGS);
    });
});

describe('the bridge', () => {
    const setup = (): {
        store: ReturnType<typeof createKelpiStore>;
        sockets: ReturnType<typeof createFakeSocketFactory>;
        dispose(): void;
    } => {
        const sockets = createFakeSocketFactory();
        const store = createKelpiStore();
        const connection = new KelpiConnection({
            url: 'ws://daemon.test/ws',
            token: 'tok',
            socketFactory: sockets.factory,
            heartbeatIntervalMs: 0
        });
        const off = connectStore({ store, connection, tokenStorage: null });
        connection.connect();
        return {
            store,
            sockets,
            dispose() {
                off();
                connection.close();
            }
        };
    };

    const welcome = (settings?: unknown): Record<string, unknown> => ({
        type: 'welcome',
        protocolVersion: 1,
        clientID: 'client-1',
        daemon: { version: '0.1.0', build: 'test', pid: 4242 },
        ...(settings === undefined ? {} : { settings })
    });

    it('takes the settings off the welcome frame', () => {
        const h = setup();
        h.sockets.last().open();
        h.sockets.last().emit(welcome(SETTINGS));
        expect(h.store.getState().settings).toEqual({
            value: SETTINGS,
            loaded: true,
            hotkeyStatus: null
        });
        h.dispose();
    });

    it('leaves the defaults alone for a welcome without settings', () => {
        const h = setup();
        h.sockets.last().open();
        h.sockets.last().emit(welcome());
        expect(h.store.getState().settings.loaded).toBe(false);
        h.dispose();
    });

    /*
     * §SET-200 / §SET-201: the shell's registration outcome, arriving on its own message.
     *
     * It rides beside the settings rather than inside them because the two say different
     * things: the config file records which chord was ASKED for, this records what the OS did
     * with it. So a config write must not erase it, and a later success must clear it.
     */
    it('applies a hotkey-status relay and keeps it across a settings change', () => {
        const h = setup();
        h.sockets.last().open();
        h.sockets.last().emit(welcome(SETTINGS));
        h.sockets.last().emit({
            type: 'hotkey-status',
            accelerator: null,
            configString: 'ctrl+alt+n',
            ok: false,
            error: 'This shortcut is already claimed by another app.',
            source: 'launch'
        });
        expect(h.store.getState().settings.hotkeyStatus).toEqual({
            accelerator: null,
            configString: 'ctrl+alt+n',
            ok: false,
            error: 'This shortcut is already claimed by another app.',
            source: 'launch'
        });

        // An unrelated settings write must not drop the warning.
        h.sockets.last().emit({
            type: 'settings-changed',
            settings: { ...SETTINGS, keybindLines: ['ctrl+alt+y=split_down'] }
        });
        expect(h.store.getState().settings.hotkeyStatus?.ok).toBe(false);

        // …and a later success clears it.
        h.sockets.last().emit({
            type: 'hotkey-status',
            accelerator: 'Control+Alt+N',
            configString: 'ctrl+alt+n',
            ok: true,
            error: null,
            source: 'settings'
        });
        expect(h.store.getState().settings.hotkeyStatus?.ok).toBe(true);
        expect(h.store.getState().settings.hotkeyStatus?.error).toBeNull();
        h.dispose();
    });

    it('ignores a malformed hotkey-status rather than inventing a warning', () => {
        const h = setup();
        h.sockets.last().open();
        h.sockets.last().emit(welcome(SETTINGS));
        h.sockets.last().emit({ type: 'hotkey-status', error: 'nope' });
        expect(h.store.getState().settings.hotkeyStatus).toBeNull();
        h.dispose();
    });

    it('applies a settings-changed broadcast', () => {
        const h = setup();
        h.sockets.last().open();
        h.sockets.last().emit(welcome(SETTINGS));
        h.sockets.last().emit({
            type: 'settings-changed',
            settings: { ...SETTINGS, general: { ...SETTINGS.general, focusFollowsMouse: false } }
        });
        expect(h.store.getState().settings.value.general.focusFollowsMouse).toBe(false);
        expect(h.store.getState().settings.value.keybindLines).toEqual(['ctrl+alt+t=split_right']);
        h.dispose();
    });

    it('ignores a settings-changed with a junk payload', () => {
        const h = setup();
        h.sockets.last().open();
        h.sockets.last().emit(welcome(SETTINGS));
        h.sockets.last().emit({ type: 'settings-changed', settings: 'nope' });
        expect(h.store.getState().settings.value).toEqual(SETTINGS);
        h.dispose();
    });
});

// ── the CommandClient helpers ───────────────────────────────────────────────────────

describe('the settings verbs', () => {
    const harness = (): {
        client: CommandClient;
        fire(promise: Promise<unknown>): void;
        lastPayload(): Record<string, unknown>;
        dispose(): void;
    } => {
        const sockets = createFakeSocketFactory();
        const connection = new KelpiConnection({
            url: 'ws://daemon.test/ws',
            token: 'tok',
            socketFactory: sockets.factory,
            heartbeatIntervalMs: 0
        });
        const client = new CommandClient(connection, { timeoutMs: 1000 });
        connection.connect();
        const socket = sockets.last();
        socket.open();
        socket.emit({
            type: 'welcome',
            protocolVersion: 1,
            clientID: 'client-1',
            daemon: { version: '0.1.0', build: 'test', pid: 4242 }
        });
        // Every helper returns a promise that only settles on a reply; nothing here waits for
        // one, and `dispose()` rejects the in-flight ones — so they are swallowed at the call
        // site rather than surfacing as unhandled rejections.
        const fire = (promise: Promise<unknown>): void => {
            promise.catch(() => undefined);
        };
        return {
            client,
            fire,
            lastPayload() {
                const frames = socket.messages().filter((message) => message['type'] === 'command');
                const last = frames.at(-1);
                if (last === undefined) throw new Error('no command was sent');
                return last['payload'] as Record<string, unknown>;
            },
            dispose() {
                client.dispose();
                connection.close();
            }
        };
    };

    it('sends set-keybinding with the trigger, and with an explicit null to unbind', () => {
        const h = harness();
        h.fire(h.client.setKeybinding({ action: 'split_right', trigger: 'ctrl+alt+t' }));
        expect(h.lastPayload()).toEqual({
            command: 'set-keybinding',
            action: 'split_right',
            trigger: 'ctrl+alt+t'
        });
        // `null` must survive: it is the "unbind this action" signal, not an absent field.
        h.fire(h.client.setKeybinding({ action: 'split_right', trigger: null }));
        expect(h.lastPayload()).toEqual({ command: 'set-keybinding', action: 'split_right', trigger: null });
        h.dispose();
    });

    it('sends reset-keybindings for one action and for the whole map', () => {
        const h = harness();
        h.fire(h.client.resetKeybindings({ action: 'split_right' }));
        expect(h.lastPayload()).toEqual({ command: 'reset-keybindings', action: 'split_right' });
        h.fire(h.client.resetKeybindings());
        expect(h.lastPayload()).toEqual({ command: 'reset-keybindings', action: null });
        h.dispose();
    });

    it('stringifies a set-general-setting value, whatever the control sent', () => {
        const h = harness();
        h.fire(h.client.setGeneralSetting({ key: 'focus-follows-mouse', value: true }));
        expect(h.lastPayload()).toEqual({
            command: 'set-general-setting',
            key: 'focus-follows-mouse',
            value: 'true'
        });
        h.fire(h.client.setGeneralSetting({ key: 'focus-follows-mouse-delay', value: 250 }));
        expect(h.lastPayload()['value']).toBe('250');
        h.dispose();
    });
});

/**
 * The WS surface of settings sync: the `welcome.settings` payload and the three mutation
 * verbs, driven through a real `SyncHub` against a real `SettingsService` on tmp files.
 *
 * Lives here rather than in `ws/sync.test.ts` because everything it exercises is this
 * module's contract — including the one thing a stub could never prove: that a verb's write
 * lands in the file with every comment and unrelated line intact.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_WS_SETTINGS, WS_PROTOCOL_VERSION, type WsSettingsSnapshot } from '@nex/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { ControlDispatcher } from '../seams.js';
import { harness as storeHarness, seededState, W1 } from '../store/testing.js';
import { createSyncHub, type SyncHub } from '../ws/sync.js';
import { PANE_A, recordingTransport, type RecordedTransport } from '../ws/testing.js';
import { createSettingsService, type SettingsService } from './service.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };

const PRESERVED = `# my nex config
focus-follows-mouse = true

# terminal
theme = Nord

keybind = super+d=split_down

profile = work:CLAUDE_CONFIG_DIR=/tmp/work
`;

const roots: string[] = [];
const services: SettingsService[] = [];
const hubs: SyncHub[] = [];

afterEach(() => {
    for (const hub of hubs.splice(0)) hub.close();
    for (const service of services.splice(0)) service.dispose();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Fixture {
    readonly hub: SyncHub;
    readonly settings: SettingsService | undefined;
    readonly configPath: string;
    readonly ghosttyPath: string;
    read(): string | null;
    readGhostty(): string | null;
    connect(): {
        transport: RecordedTransport;
        send(payload: Record<string, unknown>): Record<string, unknown>;
    };
}

function fixture(options: { config?: string; ghostty?: string; withSettings?: boolean } = {}): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-settings-ws-'));
    roots.push(root);
    const configPath = path.join(root, 'nex-config');
    const ghosttyPath = path.join(root, 'ghostty-config');
    if (options.config !== undefined) fs.writeFileSync(configPath, options.config, 'utf8');
    if (options.ghostty !== undefined) fs.writeFileSync(ghosttyPath, options.ghostty, 'utf8');

    let settings: SettingsService | undefined;
    if (options.withSettings !== false) {
        settings = createSettingsService({ configPath, ghosttyPath, watch: false });
        services.push(settings);
    }

    const store = storeHarness(seededState(W1, PANE_A));
    const dispatcher: ControlDispatcher = (_message, reply) => {
        reply?.send({ ok: true });
        reply?.close();
    };
    const hub = createSyncHub({
        store: store.store,
        dispatcher,
        daemon: DAEMON,
        ...(settings !== undefined ? { settings } : {})
    });
    hubs.push(hub);

    let counter = 0;
    return {
        hub,
        settings,
        configPath,
        ghosttyPath,
        read: () => (fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null),
        readGhostty: () => (fs.existsSync(ghosttyPath) ? fs.readFileSync(ghosttyPath, 'utf8') : null),
        connect() {
            const transport = recordingTransport();
            const session = hub.createSession(transport);
            session.handleMessage(
                JSON.stringify({
                    type: 'hello',
                    protocolVersion: WS_PROTOCOL_VERSION,
                    token: 'tok',
                    client: { kind: 'browser', name: 'nex-web' }
                })
            );
            return {
                transport,
                send(payload) {
                    counter += 1;
                    const id = `cmd-${String(counter)}`;
                    session.handleMessage(JSON.stringify({ type: 'command', id, payload }));
                    const reply = transport
                        .ofType('command-reply')
                        .find((message) => message['id'] === id);
                    if (reply === undefined) throw new Error(`no reply for ${JSON.stringify(payload)}`);
                    return reply['reply'] as Record<string, unknown>;
                }
            };
        }
    };
}

const settingsOf = (reply: Record<string, unknown>): WsSettingsSnapshot =>
    reply['settings'] as unknown as WsSettingsSnapshot;

describe('welcome carries the settings snapshot', () => {
    it('puts settings in welcome, not in the state snapshot', () => {
        const f = fixture({
            config: 'focus-follows-mouse = true\nkeybind = ctrl+alt+t=split_right\n',
            ghostty: 'background = #ffffff\nbackground-opacity = 0.8\nfont-size = 15\n'
        });
        const { transport } = f.connect();
        const welcome = transport.ofType('welcome')[0] as Record<string, unknown>;
        const snapshot = settingsOf(welcome);
        expect(snapshot.general.focusFollowsMouse).toBe(true);
        expect(snapshot.keybindLines).toEqual(['ctrl+alt+t=split_right']);
        expect(snapshot.appearance).toMatchObject({
            backgroundColor: '#ffffff',
            backgroundOpacity: 0.8,
            fontSize: 15,
            isDark: false
        });
        // The state snapshot stays a pure DaemonState mirror.
        const state = (transport.ofType('snapshot')[0] as Record<string, unknown>)['state'] as Record<
            string,
            unknown
        >;
        expect(state['settings']).toBeUndefined();
    });

    it('omits the field entirely when the daemon has no settings service', () => {
        const f = fixture({ withSettings: false });
        const { transport } = f.connect();
        expect((transport.ofType('welcome')[0] as Record<string, unknown>)['settings']).toBeUndefined();
    });

    it('sends every reconnecting client the CURRENT settings', () => {
        const f = fixture({ config: 'theme = Nord\n' });
        f.connect();
        f.settings?.setGeneralSetting('focus-follows-mouse', 'true');
        const second = f.connect();
        expect(settingsOf(second.transport.ofType('welcome')[0] as Record<string, unknown>).general).toEqual({
            // Spread: this asserts the two keys the fixture set, not the whole shape.
            ...DEFAULT_WS_SETTINGS.general,
            focusFollowsMouse: true,
            focusFollowsMouseDelay: 100,
            theme: 'Nord',
            confirmWorkspaceDeleteWhenActive: true
        });
    });
});

describe('set-keybinding', () => {
    it('round-trips into the file and answers with the re-read snapshot', () => {
        const f = fixture({ config: PRESERVED });
        const client = f.connect();
        const reply = client.send({
            command: 'set-keybinding',
            action: 'split_right',
            trigger: 'ctrl+alt+t'
        });
        expect(reply['ok']).toBe(true);
        expect(settingsOf(reply).keybindLines).toContain('ctrl+alt+t=split_right');
        expect(f.read()).toContain('keybind = ctrl+alt+t=split_right');
    });

    it('leaves comments, general settings and profile lines untouched', () => {
        const f = fixture({ config: PRESERVED });
        const client = f.connect();
        client.send({ command: 'set-keybinding', action: 'split_right', trigger: 'ctrl+alt+t' });
        const after = f.read() ?? '';
        for (const line of [
            '# my nex config',
            'focus-follows-mouse = true',
            '# terminal',
            'theme = Nord',
            'profile = work:CLAUDE_CONFIG_DIR=/tmp/work'
        ]) {
            expect(after).toContain(line);
        }
    });

    it('unbinds an action when trigger is null', () => {
        const f = fixture({ config: 'keybind = ctrl+alt+t=split_right\n' });
        const client = f.connect();
        const reply = client.send({ command: 'set-keybinding', action: 'split_right', trigger: null });
        expect(reply['ok']).toBe(true);
        expect(settingsOf(reply).keybindLines).not.toContain('ctrl+alt+t=split_right');
        expect(f.read()).toContain('keybind = super+d=unbind');
    });

    it('refuses an unknown action, an unparseable trigger and a missing action', () => {
        const f = fixture({ config: PRESERVED });
        const client = f.connect();
        expect(client.send({ command: 'set-keybinding', action: 'nope', trigger: 'ctrl+alt+t' })).toEqual({
            ok: false,
            error: "unknown action 'nope'"
        });
        expect(
            client.send({ command: 'set-keybinding', action: 'split_right', trigger: 'ctrl+alt+nope' })
        ).toEqual({ ok: false, error: "unparseable trigger 'ctrl+alt+nope'" });
        expect(client.send({ command: 'set-keybinding', trigger: 'ctrl+alt+t' })).toEqual({
            ok: false,
            error: 'set-keybinding requires action'
        });
        expect(f.read()).toBe(PRESERVED);
    });
});

describe('reset-keybindings', () => {
    it('clears every override when no action is named', () => {
        const f = fixture({ config: PRESERVED });
        const client = f.connect();
        const reply = client.send({ command: 'reset-keybindings' });
        expect(reply['ok']).toBe(true);
        expect(settingsOf(reply).keybindLines).toEqual([]);
        const after = f.read() ?? '';
        expect(after).not.toContain('keybind');
        expect(after).toContain('theme = Nord');
    });

    it('resets a single action', () => {
        const f = fixture({ config: 'keybind = ctrl+alt+t=split_right\nkeybind = ctrl+alt+y=close_pane\n' });
        const client = f.connect();
        const reply = client.send({ command: 'reset-keybindings', action: 'split_right' });
        expect(settingsOf(reply).keybindLines).toEqual(['ctrl+alt+y=close_pane']);
    });

    it('refuses an unknown action', () => {
        const f = fixture({ config: PRESERVED });
        expect(f.connect().send({ command: 'reset-keybindings', action: 'nope' })).toEqual({
            ok: false,
            error: "unknown action 'nope'"
        });
    });
});

describe('set-general-setting', () => {
    it('writes one key and answers with the re-read snapshot', () => {
        const f = fixture({ config: PRESERVED });
        const client = f.connect();
        const reply = client.send({
            command: 'set-general-setting',
            key: 'focus-follows-mouse-delay',
            value: '250'
        });
        expect(settingsOf(reply).general.focusFollowsMouseDelay).toBe(250);
        expect(f.read()).toContain('focus-follows-mouse-delay = 250');
        expect(f.read()).toContain('keybind = super+d=split_down');
    });

    it('accepts a boolean or number value (a checkbox / slider sends its own type)', () => {
        const f = fixture({ config: PRESERVED });
        const client = f.connect();
        expect(
            settingsOf(client.send({ command: 'set-general-setting', key: 'focus-follows-mouse', value: false }))
                .general.focusFollowsMouse
        ).toBe(false);
        expect(
            settingsOf(
                client.send({ command: 'set-general-setting', key: 'focus-follows-mouse-delay', value: 400 })
            ).general.focusFollowsMouseDelay
        ).toBe(400);
    });

    it('refuses a key outside §1.3’s writable list (theme is never written back)', () => {
        const f = fixture({ config: PRESERVED });
        const client = f.connect();
        expect(client.send({ command: 'set-general-setting', key: 'theme', value: 'Dracula' })).toEqual({
            ok: false,
            error: "'theme' is not a writable general setting"
        });
        expect(client.send({ command: 'set-general-setting', key: 'made-up', value: '1' })['ok']).toBe(false);
        expect(client.send({ command: 'set-general-setting', key: 'tcp-port' })).toEqual({
            ok: false,
            error: 'set-general-setting requires value'
        });
        expect(f.read()).toBe(PRESERVED);
    });
});

describe('the confirm-workspace-delete flag', () => {
    // The Swift app keeps this in UserDefaults; shell-ui.md's port note moves the suppression
    // settings into the daemon's settings store, which here is the config file.
    it('defaults to true and writes through like any other general setting', () => {
        const f = fixture({ config: PRESERVED });
        const client = f.connect();
        expect(f.settings?.snapshot.general.confirmWorkspaceDeleteWhenActive).toBe(true);
        const reply = client.send({
            command: 'set-general-setting',
            key: 'confirm-workspace-delete',
            value: 'false'
        });
        expect(settingsOf(reply).general.confirmWorkspaceDeleteWhenActive).toBe(false);
        expect(f.read()).toContain('confirm-workspace-delete = false');
        // Every unrelated line survives (§1.3).
        expect(f.read()).toContain('# my nex config');
        expect(f.read()).toContain('profile = work:CLAUDE_CONFIG_DIR=/tmp/work');
    });

    it('is only turned off by the literal `false`', () => {
        const f = fixture({ config: 'confirm-workspace-delete = nonsense\n' });
        expect(f.settings?.snapshot.general.confirmWorkspaceDeleteWhenActive).toBe(true);
    });
});

describe('profiles in the snapshot', () => {
    it('parses the file’s profile lines, keeping `~` unexpanded for the editor', () => {
        const f = fixture({ config: 'profile = work:CLAUDE_CONFIG_DIR=~/.claude-accounts/work\nprofile = work:A=1\n' });
        expect(f.settings?.snapshot.profiles).toEqual([
            { name: 'work', env: { CLAUDE_CONFIG_DIR: '~/.claude-accounts/work', A: '1' } }
        ]);
    });

    it('is empty when the file has none', () => {
        expect(fixture({ config: 'theme = Nord\n' }).settings?.snapshot.profiles).toEqual([]);
    });
});

describe('set-profiles', () => {
    it('replaces the whole profile section and preserves every other line (§1.6)', () => {
        const f = fixture({ config: PRESERVED });
        const reply = f.connect().send({
            command: 'set-profiles',
            profiles: [{ name: 'personal', env: { NEX_PROFILE: 'personal', CLAUDE_CONFIG_DIR: '~/p' } }]
        });
        expect(settingsOf(reply).profiles).toEqual([
            { name: 'personal', env: { CLAUDE_CONFIG_DIR: '~/p', NEX_PROFILE: 'personal' } }
        ]);
        const contents = f.read() ?? '';
        expect(contents).not.toContain('profile = work:');
        expect(contents).toContain('profile = personal:CLAUDE_CONFIG_DIR=~/p');
        expect(contents).toContain('# my nex config');
        expect(contents).toContain('keybind = super+d=split_down');
        expect(contents).toContain('theme = Nord');
    });

    it('an empty set drops every profile line, leaving the rest of the file', () => {
        const f = fixture({ config: PRESERVED });
        expect(settingsOf(f.connect().send({ command: 'set-profiles', profiles: [] })).profiles).toEqual([]);
        expect(f.read()).toContain('focus-follows-mouse = true');
        expect(f.read()).not.toContain('profile = ');
    });

    it('rejects a malformed payload rather than deleting the section on a guess', () => {
        const f = fixture({ config: PRESERVED });
        const client = f.connect();
        for (const profiles of [undefined, 'nope', [{ env: { A: '1' } }], [{ name: 'x', env: { A: 7 } }]]) {
            expect(client.send({ command: 'set-profiles', profiles })).toEqual({
                ok: false,
                error: 'set-profiles requires profiles: [{name, env}]'
            });
        }
        expect(f.read()).toBe(PRESERVED);
    });
});

describe('without a settings service', () => {
    it('answers every verb honestly instead of pretending', () => {
        const client = fixture({ withSettings: false }).connect();
        for (const payload of [
            { command: 'set-keybinding', action: 'split_right', trigger: 'ctrl+alt+t' },
            { command: 'reset-keybindings' },
            { command: 'set-general-setting', key: 'focus-follows-mouse', value: 'true' }
        ]) {
            expect(client.send(payload)).toEqual({ ok: false, error: 'settings are not available' });
        }
    });
});

describe('settings-changed broadcast', () => {
    it('reaches every ready session through the hub broadcast seam', () => {
        const f = fixture({ config: PRESERVED });
        const a = f.connect();
        const b = f.connect();
        // `boot/compose.ts` wires exactly this: service change → hub broadcast.
        const off = f.settings?.subscribe((snapshot) => {
            f.hub.broadcast({ type: 'settings-changed', settings: snapshot as unknown as Record<string, unknown> });
        });
        f.settings?.setGeneralSetting('focus-follows-mouse', 'false');
        off?.();

        for (const client of [a, b]) {
            const changed = client.transport.ofType('settings-changed');
            expect(changed).toHaveLength(1);
            expect(settingsOf(changed[0] as Record<string, unknown>).general.focusFollowsMouse).toBe(false);
        }
    });
});

// ── set-ghostty-setting (SET-039…SET-041) ───────────────────────────────────────────

/**
 * The one settings verb that writes a file Nex does not own. Everything below is about that
 * boundary: only the five keys the daemon can read back are writable, `null` means REMOVE, and
 * a user's own ghostty lines survive untouched.
 */
describe('set-ghostty-setting', () => {
    const GHOSTTY = 'theme = Nord\nfont-size = 13\nwindow-padding-x = 8\n';

    it('writes a key and answers with the re-read snapshot', () => {
        const f = fixture({ ghostty: GHOSTTY });
        const client = f.connect();
        const reply = client.send({ command: 'set-ghostty-setting', key: 'background', value: '#1a1b26' });
        expect(settingsOf(reply).appearance.backgroundColor).toBe('#1a1b26');
        expect(f.readGhostty()).toContain('background = #1a1b26');
        // The user's own keys are still there.
        expect(f.readGhostty()).toContain('window-padding-x = 8');
    });

    it('removes the key when the value is null', () => {
        const f = fixture({ ghostty: GHOSTTY });
        const client = f.connect();
        const reply = client.send({ command: 'set-ghostty-setting', key: 'theme', value: null });
        expect(settingsOf(reply).appearance.theme).toBeNull();
        expect(f.readGhostty()).not.toContain('theme =');
    });

    it('refuses a key the daemon cannot read back', () => {
        const f = fixture({ ghostty: GHOSTTY });
        const client = f.connect();
        expect(client.send({ command: 'set-ghostty-setting', key: 'window-padding-x', value: '16' })).toEqual({
            ok: false,
            error: "'window-padding-x' is not a writable ghostty setting"
        });
        expect(f.readGhostty()).toBe(GHOSTTY);
    });

    it('requires a key and a value field', () => {
        const f = fixture({ ghostty: GHOSTTY });
        const client = f.connect();
        expect(client.send({ command: 'set-ghostty-setting', value: '1' })).toEqual({
            ok: false,
            error: 'set-ghostty-setting requires key'
        });
        expect(client.send({ command: 'set-ghostty-setting', key: 'background' })).toEqual({
            ok: false,
            error: 'set-ghostty-setting requires value'
        });
    });

    it('broadcasts nothing when settings are not wired', () => {
        const f = fixture({ withSettings: false });
        const client = f.connect();
        expect(client.send({ command: 'set-ghostty-setting', key: 'background', value: '#000000' })).toEqual({
            ok: false,
            error: 'settings are not available'
        });
    });
});

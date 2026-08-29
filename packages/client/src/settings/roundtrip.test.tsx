/**
 * The Settings window inside the assembled client: what a click actually puts on the wire, and
 * what the broadcast coming back actually changes.
 *
 * The tabs' own tests drive them from fixtures; this one exists for the three things only
 * assembly can prove — the window opens from all three affordances, a recorded key travels
 * verb → daemon → `settings-changed` → table, and while the window is up the app's key
 * dispatcher is silent (a ⌘D behind the sheet must not split a pane).
 */

import type { JsonObject } from '@nex/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import { createFakeSocketFactory, type FakeWebSocket } from '../connection';
import { createNexRuntime, createNexStore } from '../state';
import { createFakeRendererFactory } from '../terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({ type: 'workspace-labels', id: W1, op: 'set', values: ['ship'] });
    store.dispatch({ type: 'add-label-preset', name: 'ship', color: { kind: 'named', color: 'gray' } });
    return store.getState() as unknown as JsonObject;
}

interface SettingsInput {
    readonly keybindLines?: readonly string[];
    readonly profiles?: readonly { name: string; env: Record<string, string> }[];
}

function settingsPayload(input: SettingsInput = {}): Record<string, unknown> {
    return {
        keybindLines: input.keybindLines ?? [],
        profiles: input.profiles ?? [{ name: 'work', env: { NEX_PROFILE: 'work', A: '1' } }],
        general: {
            focusFollowsMouse: false,
            focusFollowsMouseDelay: 100,
            theme: 'Nord',
            confirmWorkspaceDeleteWhenActive: true
        },
        appearance: {
            backgroundColor: '#0a0a0c',
            backgroundOpacity: 1,
            fontFamily: null,
            fontSize: null,
            isDark: true,
            theme: null
        }
    };
}

interface Harness {
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    push(input: SettingsInput): void;
}

function setup(input: SettingsInput = {}): Harness {
    const sockets = createFakeSocketFactory();
    const runtime = createNexRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store: createNexStore(),
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);

    act(() => {
        const socket = sockets.last();
        socket.open();
        socket.emit({
            type: 'welcome',
            protocolVersion: 1,
            clientID: 'client-1',
            daemon: { version: '0.1.0', build: 'test', pid: 4242 },
            settings: settingsPayload(input)
        });
        socket.emit({ type: 'snapshot', seq: 0, state: snapshotState() });
    });

    return {
        socket: () => sockets.last(),
        commands: () =>
            sockets
                .last()
                .messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        push(next) {
            act(() => {
                sockets.last().emit({ type: 'settings-changed', settings: settingsPayload(next) });
            });
        }
    };
}

const sent = (h: Harness, command: string): Record<string, unknown>[] =>
    h.commands().filter((payload) => payload['command'] === command);

afterEach(cleanup);

describe('opening the Settings window', () => {
    it('opens on ⌘,', () => {
        setup();
        expect(screen.queryByTestId('settings-window')).toBeNull();
        act(() => {
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        });
        expect(screen.getByTestId('settings-window')).toBeDefined();
    });

    /*
     * This used to press the sidebar footer's gear. The Swift footer has no gear (§WS-004:
     * "+ New Workspace", a chevron menu, a ⌘N hint), so the port's was removed and the POINTER
     * route to Settings is the ••• menu's "Settings…" row — the shipped app's own gesture
     * (§APP-053, `WindowTitleBar.swift:243-251`). Same claim, stricter evidence: it opens a
     * menu, finds the row by its label, and clicks it.
     */
    it('opens from the ••• menu’s Settings… row', () => {
        setup();
        act(() => {
            fireEvent.click(screen.getByTestId('titlebar-menu-toggle'));
        });
        const row = [...screen.getByTestId('context-menu').querySelectorAll('[data-menu-item]')].find(
            (node) => (node.querySelector('span.flex-1')?.textContent ?? '').trim() === 'Settings…'
        );
        expect(row).toBeDefined();
        act(() => {
            fireEvent.click(row as HTMLElement);
        });
        expect(screen.getByTestId('settings-window')).toBeDefined();
    });

    /* The footer carries no Settings control at all any more — the parity claim, asserted. */
    it('has no gear in the sidebar footer', () => {
        setup();
        expect(screen.queryByTestId('sidebar-settings')).toBeNull();
    });

    it('opens from the command palette', () => {
        setup();
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyP', metaKey: true });
        });
        const row = document.querySelector('[data-item-id="cmd:settings"]');
        act(() => {
            fireEvent.click(row as HTMLElement);
        });
        expect(screen.getByTestId('settings-window')).toBeDefined();
    });

    // §3.4 spells the key `comma`; `super+,` is not parseable, which is exactly the kind of
    // detail that makes "the client and the daemon resolve the same file" worth testing.
    // shell-ui.md §5.7: the workspace menu's Labels submenu offers existing presets only, so it
    // deep-links to the tab where they are created and recolored.
    it('opens straight to Labels from the sidebar’s “Manage Labels…”', () => {
        setup();
        act(() => {
            fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        });
        act(() => {
            fireEvent.mouseEnter(screen.getByText('Labels'));
        });
        act(() => {
            fireEvent.click(screen.getByText('Manage Labels…'));
        });
        expect(screen.getByTestId('settings-tab-labels')).toBeDefined();
    });

    it('yields ⌘, to the user’s own map when they have bound it', () => {
        setup({ keybindLines: ['super+comma=split_right'] });
        act(() => {
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        });
        expect(screen.queryByTestId('settings-window')).toBeNull();
    });

    it('closes on Escape', () => {
        setup();
        act(() => {
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        });
        act(() => {
            fireEvent.keyDown(screen.getByTestId('settings-window'), { key: 'Escape' });
        });
        expect(screen.queryByTestId('settings-window')).toBeNull();
    });
});

describe('the window owns the keyboard while it is open', () => {
    it('does not let a pane shortcut fire behind the sheet', () => {
        const h = setup();
        act(() => {
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        });
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyD', metaKey: true });
        });
        expect(sent(h, 'pane-split')).toHaveLength(0);

        // …and the shortcut works again once the window is gone.
        act(() => {
            fireEvent.keyDown(screen.getByTestId('settings-window'), { key: 'Escape' });
        });
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyD', metaKey: true });
        });
        expect(sent(h, 'pane-split')).toHaveLength(1);
    });
});

describe('a recorded keybinding, end to end', () => {
    it('records → set-keybinding → settings-changed → the table shows the new chip', () => {
        const h = setup();
        act(() => {
            // ⌘, — the footer gear these three used to press is gone (§WS-004).
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        });
        // H13: ⌘, lands on General (`SettingsView.swift:13`), so reaching the table is now a
        // deliberate click rather than where the window happens to open.
        act(() => {
            fireEvent.click(screen.getByTestId('settings-tab-button-keybindings'));
        });

        // Before: `open_diff` ships unbound.
        expect(screen.getByTestId('keybinding-empty-open_diff').textContent).toBe('—');

        act(() => {
            fireEvent.click(screen.getByTestId('keybinding-record-open_diff'));
        });
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyJ', ctrlKey: true, altKey: true });
        });

        expect(sent(h, 'set-keybinding')).toEqual([
            { command: 'set-keybinding', action: 'open_diff', trigger: 'ctrl+alt+j' }
        ]);
        // Nothing has changed locally — the file is the truth, so the row is still empty.
        expect(screen.getByTestId('keybinding-empty-open_diff').textContent).toBe('—');

        h.push({ keybindLines: ['ctrl+alt+j=open_diff'] });

        expect(screen.queryByTestId('keybinding-empty-open_diff')).toBeNull();
        expect(screen.getByTestId('keybinding-row-open_diff').textContent).toContain('⌃⌥J');
        // The reset button woke up with it: the row now differs from its shipped default.
        expect((screen.getByTestId('keybinding-reset-open_diff') as HTMLButtonElement).disabled).toBe(false);
    });

    /*
     * §SET-200 / §SET-201: a rejected registration is a WARNING IN SETTINGS, not a log line.
     *
     * Assembly is the only place this can be proven. The reason string is produced in the
     * Electron shell, relayed by the daemon, parked in a store slice and rendered by a section
     * four components down — every half of that existed already and the chain still did
     * nothing, because `App` never passed the prop to the overlay.
     */
    it('shows the shell’s registration failure on Keybindings, and clears it on success', () => {
        const h = setup();
        act(() => {
            // ⌘, — the footer gear these three used to press is gone (§WS-004).
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        });
        act(() => {
            fireEvent.click(screen.getByTestId('settings-tab-button-keybindings'));
        });
        expect(screen.queryByTestId('global-hotkey-failure')).toBeNull();

        act(() => {
            h.socket().emit({
                type: 'hotkey-status',
                accelerator: null,
                configString: 'ctrl+alt+n',
                ok: false,
                error: 'This shortcut is already claimed by another app.',
                source: 'launch'
            });
        });
        // `toContain`, not equality: §APP-014 gave the row the Swift view's warning glyph, so
        // the node carries `⚠ ` ahead of the OS's own sentence.
        const failure = screen.getByTestId('global-hotkey-failure');
        expect(failure.textContent).toContain('This shortcut is already claimed by another app.');
        // …and it renders as the destructive state a user cannot mistake for the shadow
        // advisory beneath it (§APP-014's client-visible error).
        expect(failure.getAttribute('role')).toBe('alert');
        expect(failure.dataset['tone']).toBe('destructive');

        // …and re-recording something that works takes it away again.
        act(() => {
            h.socket().emit({
                type: 'hotkey-status',
                accelerator: 'Control+Alt+N',
                configString: 'ctrl+alt+n',
                ok: true,
                error: null,
                source: 'settings'
            });
        });
        expect(screen.queryByTestId('global-hotkey-failure')).toBeNull();
    });

    it('rebinding also rebuilds the live dispatcher, not just the table', () => {
        const h = setup();
        h.push({ keybindLines: ['ctrl+alt+t=split_right'] });
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyT', ctrlKey: true, altKey: true });
        });
        expect(sent(h, 'pane-split')).toHaveLength(1);
    });
});

describe('the other tabs on the wire', () => {
    const openTab = (tab: string): void => {
        act(() => {
            // ⌘, — the footer gear these three used to press is gone (§WS-004).
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        });
        act(() => {
            fireEvent.click(screen.getByTestId(`settings-tab-button-${tab}`));
        });
    };

    /*
     * §N38 SWAP — the gesture is two clicks (open the flyover, pick a swatch) where it was one,
     * because the row's palette moved into the popover. The CLAIM is unchanged, and is the only
     * reason this test lives in the round-trip file: a colour picked on the Labels tab reaches
     * the daemon as ONE `update-label-preset` carrying §6.2's one-string token, naming a preset
     * that came out of the state snapshot rather than out of local state.
     */
    it('recolors a label preset from the daemon’s own list, through the flyover', () => {
        const h = setup();
        openTab('labels');
        // The preset came from the state snapshot, and the workspace wearing it is counted.
        expect(screen.getByTestId('label-preset-ship').textContent).toContain('1 workspace');
        act(() => {
            fireEvent.click(screen.getByTestId('label-color-ship-trigger'));
        });
        act(() => {
            fireEvent.click(screen.getByTestId('label-flyover-bg-purple'));
        });
        expect(sent(h, 'update-label-preset')).toEqual([
            { command: 'update-label-preset', id: 'ship', color: 'purple' }
        ]);
    });

    it('writes the whole profile set from the snapshot’s parsed profiles', () => {
        const h = setup();
        openTab('profiles');
        expect(screen.getByTestId('profile-row-work')).toBeDefined();
        act(() => {
            fireEvent.click(screen.getByTestId('profile-row-work'));
        });
        act(() => {
            fireEvent.click(screen.getByTestId('profile-var-remove-0'));
        });
        expect(sent(h, 'set-profiles')).toEqual([
            { command: 'set-profiles', profiles: [{ name: 'work', env: { NEX_PROFILE: 'work' } }] }
        ]);
    });

    it('writes the delete-confirmation flag through set-general-setting', () => {
        const h = setup();
        openTab('workspaces');
        act(() => {
            fireEvent.click(screen.getByTestId('confirm-delete-toggle'));
        });
        expect(sent(h, 'set-general-setting')).toEqual([
            { command: 'set-general-setting', key: 'confirm-workspace-delete', value: 'false' }
        ]);
    });

    it('shows the resolved appearance the daemon sent', () => {
        setup();
        openTab('appearance');
        // The daemon's own luminance verdict on the background it parsed — the one value that
        // makes chrome, content panes and terminals agree about light vs dark.
        expect(screen.getByTestId('appearance-bucket').textContent).toContain('dark');
    });

    /**
     * SET-039/040 on the wire. The terminal theme is a GHOSTTY key, so it must leave as
     * `set-ghostty-setting` — and choosing one must also drop any explicit `background`, which
     * would otherwise silently outrank the theme the user just picked.
     */
    it('writes the terminal theme through set-ghostty-setting, clearing the background', () => {
        const h = setup();
        openTab('appearance');
        act(() => {
            fireEvent.change(screen.getByTestId('terminal-theme-select'), { target: { value: 'Nord' } });
        });
        expect(sent(h, 'set-ghostty-setting')).toEqual([
            { command: 'set-ghostty-setting', key: 'theme', value: 'Nord' },
            { command: 'set-ghostty-setting', key: 'background', value: null }
        ]);
    });

    /** SET-024: a preset is a nex-config write and must not touch the ghostty file at all. */
    it('applies a chrome preset through set-general-setting only', () => {
        const h = setup();
        openTab('appearance');
        act(() => {
            fireEvent.click(screen.getByTestId('theme-preset-nord'));
        });
        const keys = sent(h, 'set-general-setting').map((payload) => payload['key']);
        expect(keys[0]).toBe('chrome-appearance');
        expect(keys).toContain('chrome-colors');
        expect(sent(h, 'set-ghostty-setting')).toEqual([]);
    });

    /** SET-081: the recorder writes `global-hotkey` into the nex config like any other key. */
    it('records a global hotkey from the Keybindings tab', () => {
        const h = setup();
        openTab('keybindings');
        act(() => {
            fireEvent.click(screen.getByTestId('global-hotkey-record'));
        });
        act(() => {
            fireEvent.keyDown(window, { code: 'Space', ctrlKey: true, altKey: true });
        });
        expect(sent(h, 'set-general-setting')).toEqual([
            { command: 'set-general-setting', key: 'global-hotkey', value: 'ctrl+alt+space' }
        ]);
    });

    /** SET-008: the General tab's worktree base path is a real key the daemon reads back. */
    it('writes the worktree base path from the General tab', () => {
        const h = setup();
        openTab('general');
        const field = screen.getByTestId('worktree-base-path-input');
        act(() => {
            fireEvent.change(field, { target: { value: '<repo>/.worktrees' } });
        });
        act(() => {
            fireEvent.blur(field);
        });
        expect(sent(h, 'set-general-setting')).toEqual([
            { command: 'set-general-setting', key: 'worktree-base-path', value: '<repo>/.worktrees' }
        ]);
    });
});

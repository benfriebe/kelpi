/**
 * Shortcut hints (config-keybindings.md §3.3) where the UI shows them.
 *
 * `shortcutForAction` is the seam: it reads the SAME `KeyBindingMap` the interceptor dispatches
 * from, so a rebound action's hint moves with it instead of advertising a key that no longer
 * fires. The palette and the context menu only render what it returns.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_KEYBINDINGS,
    applyKeybindOverrides,
    shortcutForAction
} from './keys';
import { CommandPalette } from './CommandPalette';
import { ContextMenu } from './ContextMenu';
import type { PaletteItem } from './palette';
import { makeKeyTrigger } from '@kelpi/core/config';

afterEach(cleanup);

function command(id: string, title: string, shortcut?: string): PaletteItem {
    return {
        id,
        kind: 'command',
        icon: 'terminal',
        title,
        subtitle: '',
        workspaceID: null,
        workspaceName: '',
        paneID: null,
        workspaceColor: null,
        run: () => {},
        ...(shortcut === undefined ? {} : { shortcut })
    };
}

describe('shortcutForAction', () => {
    it('renders the default bindings as display strings', () => {
        expect(shortcutForAction(DEFAULT_KEYBINDINGS, 'command_palette')).toBe('⌘P');
        expect(shortcutForAction(DEFAULT_KEYBINDINGS, 'split_down')).toBe('⇧⌘D');
        expect(shortcutForAction(DEFAULT_KEYBINDINGS, 'toggle_zoom')).toBe('⇧⌘Return');
    });

    it('is undefined for an action nothing is bound to', () => {
        expect(shortcutForAction(DEFAULT_KEYBINDINGS, 'toggle_sync_input')).toBeUndefined();
    });

    it('follows a rebind rather than advertising the old key', () => {
        const rebound = applyKeybindOverrides(DEFAULT_KEYBINDINGS, [
            { trigger: makeKeyTrigger(40, ['ctrl']), action: 'command_palette' }
        ]);
        // The default ⌘P is still bound (an override adds a trigger, it does not steal one),
        // and `triggersForAction` sorts by config string so the hint is stable across launches.
        expect(shortcutForAction(rebound, 'command_palette')).toBe('⌃K');
    });
});

describe('palette rows', () => {
    it('shows a hint for a command that carries one, and nothing for a workspace row', () => {
        render(
            <CommandPalette
                open
                query=""
                onQueryChange={vi.fn()}
                items={[command('cmd:palette', 'Command Palette', '⌘P'), command('cmd:plain', 'No Binding')]}
                onConfirm={vi.fn()}
                onDismiss={vi.fn()}
            />
        );

        const hints = screen.getAllByTestId('palette-shortcut');
        expect(hints).toHaveLength(1);
        expect(hints[0]?.textContent).toBe('⌘P');
    });
});

describe('context-menu rows', () => {
    /*
     * UI-FIDELITY L12 inverted this assertion, and the inversion is the point: a context menu
     * shows NO key equivalents, because none of the shipped app's `.contextMenu` buttons carry
     * `.keyboardShortcut` (`WorkspaceListView.swift:897`, `:1183`, `:344-350`,
     * `PaneHeaderView.swift:360-361`, `WindowTitleBar.swift:243-251`). The palette above still
     * shows its hints — `CommandPalette.swift` does too — so `shortcutForAction` keeps its one
     * remaining consumer.
     */
    it('shows no key-equivalent column, whatever the row says', () => {
        render(
            <ContextMenu
                x={0}
                y={0}
                onClose={vi.fn()}
                items={[
                    { id: 'a', label: 'New Workspace' },
                    { id: 'b', label: 'Delete' }
                ]}
            />
        );

        expect(screen.queryByTestId('menu-shortcut')).toBeNull();
        expect(screen.getByTestId('context-menu').textContent).toBe('New WorkspaceDelete');
    });
});

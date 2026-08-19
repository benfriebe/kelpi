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
import { makeKeyTrigger } from '@nex/core/config';

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
    it('right-aligns a shortcut on the items that have one', () => {
        render(
            <ContextMenu
                x={0}
                y={0}
                onClose={vi.fn()}
                items={[
                    { id: 'a', label: 'New Workspace', shortcut: '⌘N' },
                    { id: 'b', label: 'Delete' }
                ]}
            />
        );

        const hints = screen.getAllByTestId('menu-shortcut');
        expect(hints).toHaveLength(1);
        expect(hints[0]?.textContent).toBe('⌘N');
    });
});

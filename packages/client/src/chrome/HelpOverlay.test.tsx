import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolvePluginChords } from '../plugins/shortcuts';
import { HELP_CLI_ENTRIES, HELP_GITHUB_URL, HELP_MOUSE_ENTRIES, HelpOverlay } from './HelpOverlay';
import { buildKeymap, nativeChordOwners, type KeymapPluginCommand } from './keymap';
import { clientKeyBindings } from './keys';

afterEach(cleanup);

type PluginCommand = KeymapPluginCommand & { readonly shortcut?: string; readonly visible: boolean; readonly enabled: boolean };

/** The same build `App.tsx` hands Help: the live map, and the dispatcher's plugin resolution. */
function keymapFor(overrides: readonly string[] = [], commands: readonly PluginCommand[] = []) {
    const bindings = clientKeyBindings(overrides, true);
    const native = nativeChordOwners(bindings, null, true);
    return buildKeymap({ bindings, native, plugins: resolvePluginChords(commands, native.keys(), true), macLike: true });
}

function renderHelp(overrides: readonly string[] = [], commands: readonly PluginCommand[] = []): { onClose: () => void } {
    const onClose = vi.fn();
    render(<HelpOverlay keymap={keymapFor(overrides, commands)} version="9.9.9" onClose={onClose} />);
    return { onClose };
}

const labCommand = (name: string, shortcut: string | undefined, extra: Partial<PluginCommand> = {}): PluginCommand => ({
    id: `example.lab.${name}`,
    title: `Lab: ${name}`,
    pluginID: 'example.lab',
    pluginName: 'Example Lab',
    ...(shortcut === undefined ? {} : { shortcut }),
    visible: true,
    enabled: true,
    ...extra
});

describe('HelpOverlay (APP-027 / APP-063)', () => {
    it('shows the version, the repository link and the CLI pointers', () => {
        renderHelp();
        expect(screen.getByTestId('help-version').textContent).toBe('Version 9.9.9');
        expect(screen.getByTestId('help-github').getAttribute('href')).toBe(HELP_GITHUB_URL);
        const cli = screen.getByTestId('help-cli').textContent ?? '';
        for (const entry of HELP_CLI_ENTRIES) expect(cli).toContain(entry.command);
    });

    it('lists shortcuts from the LIVE map, not a hard-coded table', () => {
        // The default binding first…
        renderHelp();
        const defaultRow = document.querySelector('[data-help-action="split_right"]');
        expect(defaultRow?.querySelector('[data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe('⌘D');
        cleanup();

        // …then the same action rebound in the daemon's config lines.
        renderHelp(['super+shift+k=split_right']);
        const reboundRow = document.querySelector('[data-help-action="split_right"]');
        expect(reboundRow?.querySelector('[data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe(
            '⇧⌘K'
        );
    });

    /**
     * #175. The Help overlay is where the three terminal text-size chords are SHOWN, because
     * their View menu rows deliberately carry no accelerator (`shell/src/menu.ts` says why). So
     * this is not a formality: it is the surface the decision leans on.
     *
     * ⌘= rather than ⇧⌘= for Increase is `displayTriggerForAction`'s one display-only preference:
     * `shift+super+=` sorts first by config string, but the unshifted half of a two-spelling chord
     * is the one on the keycap. The preference is scoped to that same-key ±shift relation, so an
     * action with two genuinely different shortcuts is untouched, which the Focus Next Pane case
     * below is here to prove.
     */
    it('lists the three terminal text-size actions with their live chords', () => {
        renderHelp();
        const shortcut = (action: string): string | null | undefined =>
            document
                .querySelector(`[data-help-action="${action}"]`)
                ?.querySelector('[data-help-shortcut]')
                ?.getAttribute('data-help-shortcut');
        expect(shortcut('increase_terminal_font_size')).toBe('⌘=');
        // The rule moved nothing else: ⌥⌘→ still wins over ⌘] for Focus Next Pane, because those
        // are two shortcuts rather than two spellings of one.
        expect(shortcut('focus_next_pane')).toBe('⌥⌘→');
        expect(shortcut('decrease_terminal_font_size')).toBe('⌘-');
        expect(shortcut('reset_terminal_font_size')).toBe('⌘0');
        const terminal = document.querySelector('[data-help-category="Terminal"]')?.textContent ?? '';
        expect(terminal).toContain('Increase Terminal Text Size');
        expect(terminal).toContain('Decrease Terminal Text Size');
        expect(terminal).toContain('Reset Terminal Text Size');

        // …and they move with a rebind like every other row, because the rows read the map.
        cleanup();
        renderHelp(['super+0=unbind', 'ctrl+alt+0=reset_terminal_font_size']);
        expect(shortcut('reset_terminal_font_size')).toBe('⌃⌥0');
    });

    it('draws a dash for an action nothing is bound to', () => {
        renderHelp(['super+d=unbind']);
        const row = document.querySelector('[data-help-action="split_right"]');
        expect(row?.textContent).toContain('-');
    });

    it('groups rows under the eight visible categories', () => {
        renderHelp();
        const groups = [...document.querySelectorAll('[data-help-category]')].map((node) =>
            node.getAttribute('data-help-category')
        );
        expect(groups).toEqual([
            'Pane Management',
            'Navigation',
            'Workspaces',
            'View',
            'Files',
            'Search',
            'Clipboard',
            'Terminal'
        ]);
    });

    /**
     * #81: the app's only written answer to "why does dragging in my agent pane select nothing".
     * Shift+drag is ghostty's `mouse-shift-capture = false` bypass and had no affordance anywhere.
     */
    it('names the mouse gestures, Shift+drag included', () => {
        renderHelp();
        const mouse = screen.getByTestId('help-mouse').textContent ?? '';
        for (const entry of HELP_MOUSE_ENTRIES) expect(mouse).toContain(entry.gesture);
        expect(document.querySelector('[data-help-gesture="Shift+drag"]')?.textContent).toContain(
            'while an app owns the mouse'
        );
    });

    it('shows the Clipboard chords in the live map', () => {
        renderHelp();
        const copy = document.querySelector('[data-help-action="copy"]');
        expect(copy?.querySelector('[data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe('⌘C');
        const paste = document.querySelector('[data-help-action="paste"]');
        expect(paste?.querySelector('[data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe('⌘V');
    });

    // #82: the three chords a user has to be able to find in order to unbind them.
    it('shows the Terminal line-editing chords in the live map', () => {
        renderHelp();
        const shortcut = (action: string): string | null | undefined =>
            document
                .querySelector(`[data-help-action="${action}"]`)
                ?.querySelector('[data-help-shortcut]')
                ?.getAttribute('data-help-shortcut');
        // `⌘Delete` is the display spelling `keyTriggerDisplayStringForPlatform` gives the
        // backspace key today; the chord is ⌘Backspace either way.
        expect(shortcut('kill_line_backward')).toBe('⌘Delete');
        expect(shortcut('move_to_line_start')).toBe('⌘←');
        expect(shortcut('move_to_line_end')).toBe('⌘→');
    });

    it('closes on the button, on the backdrop and on Escape', () => {
        const { onClose } = renderHelp();
        fireEvent.click(screen.getByTestId('help-close'));
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByTestId('help-overlay'));
        expect(onClose).toHaveBeenCalledTimes(2);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(3);
    });

    it('hands the repository link to the shell when one is attached', () => {
        const onOpenLink = vi.fn();
        render(
            <HelpOverlay
                keymap={keymapFor()}
                version="1.0.0"
                onClose={() => undefined}
                onOpenLink={onOpenLink}
            />
        );
        fireEvent.click(screen.getByTestId('help-github'));
        expect(onOpenLink).toHaveBeenCalledWith(HELP_GITHUB_URL);
    });

    it('offers the Settings ▸ Keybindings deep link only when the app supplies one', () => {
        renderHelp();
        expect(screen.queryByTestId('help-open-keybindings')).toBeNull();
        cleanup();

        const onOpenKeybindings = vi.fn();
        render(
            <HelpOverlay
                keymap={keymapFor()}
                version="1.0.0"
                onClose={() => undefined}
                onOpenKeybindings={onOpenKeybindings}
            />
        );
        fireEvent.click(screen.getByTestId('help-open-keybindings'));
        expect(onOpenKeybindings).toHaveBeenCalledTimes(1);
    });
    it('lists plugin commands under their plugin with the live shortcut, and no section without plugins', () => {
        renderHelp();
        expect(screen.queryByTestId('help-plugins')).toBeNull();
        cleanup();

        renderHelp([], [labCommand('increment', 'ctrl+alt+u', { visible: false }), labCommand('toggle', undefined)]);
        const group = document.querySelector('[data-help-plugin="Example Lab"]');
        expect(group?.textContent).toContain('Example Lab');
        const shortcut = (id: string) =>
            group?.querySelector(`[data-help-command="${id}"] [data-help-shortcut]`);
        // Reference, not a menu: listed and bound even while its `when` is false.
        expect(shortcut('example.lab.increment')?.getAttribute('data-help-shortcut')).toBe('⌃⌥U');
        expect(shortcut('example.lab.toggle')?.getAttribute('data-help-shortcut')).toBe('');
        expect(shortcut('example.lab.toggle')?.textContent).toBe('-');
        // Plugin groups are not native categories.
        expect(document.querySelectorAll('[data-help-category]')).toHaveLength(8);
    });

    it('follows a rebound or cleared plugin shortcut', () => {
        renderHelp([], [labCommand('increment', 'ctrl+alt+j')]);
        expect(document.querySelector('[data-help-command="example.lab.increment"] [data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe('⌃⌥J');
        cleanup();
        renderHelp([], [labCommand('increment', undefined)]);
        expect(document.querySelector('[data-help-command="example.lab.increment"] [data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe('');
    });

    it('says what runs on a plugin shortcut a native binding or an earlier plugin takes', () => {
        const other = { id: 'example.other.run', pluginID: 'example.other', pluginName: 'Other Lab', title: 'Other: run' };
        renderHelp([], [labCommand('split', 'super+d'), labCommand('run', 'ctrl+alt+r'), labCommand('run', 'ctrl+alt+r', other)]);
        const row = (id: string) => document.querySelector(`[data-help-command="${id}"]`);
        expect(row('example.lab.split')?.querySelector('[data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe('');
        expect(row('example.lab.split')?.querySelector('[data-help-shadowed-by]')?.textContent).toBe('⌘D runs Split Right');
        expect(row('example.other.run')?.querySelector('[data-help-shadowed-by]')?.textContent).toBe('⌃⌥R runs Lab: run (Example Lab)');
        expect(row('example.lab.run')?.querySelector('[data-help-shadowed-by]')).toBeNull();
        cleanup();

        // Unbinding the native chord hands it to the plugin.
        renderHelp(['super+d=unbind'], [labCommand('split', 'super+d')]);
        expect(row('example.lab.split')?.querySelector('[data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe('⌘D');
        expect(document.querySelector('[data-help-action="split_right"] [data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe('');
    });

    it('says what a command\'s shortcut runs right now while the command does not apply', () => {
        const other = { id: 'example.other.run', pluginID: 'example.other', pluginName: 'Other Lab', title: 'Other: run' };
        renderHelp([], [labCommand('run', 'ctrl+alt+r', { visible: false }), labCommand('run', 'ctrl+alt+r', other)]);
        const row = (id: string) => document.querySelector(`[data-help-command="${id}"]`);
        // Still its chord, not struck through: it takes the chord back the moment it applies.
        expect(row('example.lab.run')?.querySelector('[data-help-shortcut]')?.getAttribute('data-help-shortcut')).toBe('⌃⌥R');
        expect(row('example.lab.run')?.querySelector('[data-help-currently-by]')?.textContent).toBe('⌃⌥R currently runs Other: run (Other Lab)');
        expect(row('example.other.run')?.querySelector('[data-help-currently-by]')).toBeNull();
        expect(row('example.other.run')?.querySelector('[data-help-shadowed-by]')).toBeNull();
    });

    it('keeps long plugin names and titles inside the dialog and scrolls many plugins', () => {
        const commands = Array.from({ length: 40 }, (_, plugin) =>
            Array.from({ length: 5 }, (_, index) =>
                labCommand(`c${index}`, undefined, {
                    id: `example.p${plugin}.c${index}`,
                    pluginID: `example.p${plugin}`,
                    pluginName: `Plugin ${plugin} ${'N'.repeat(180)}`,
                    title: `${'T'.repeat(200)}`
                })
            )
        ).flat();
        renderHelp([], commands);
        expect(document.querySelectorAll('[data-help-plugin]')).toHaveLength(40);
        expect(document.querySelectorAll('[data-help-command]')).toHaveLength(200);
        // The label column may shrink and wrap, the chord column may not, and the body scrolls.
        const label = document.querySelector('[data-help-command="example.p0.c0"] > span:first-child');
        expect(label?.className).toContain('min-w-0');
        expect(label?.firstElementChild?.className).toContain('break-words');
        expect(screen.getByTestId('help-plugins').parentElement?.className).toContain('overflow-y-auto');
    });

    it('offers the Settings ▸ Plugins deep link only when the app supplies one', () => {
        const onOpenPlugins = vi.fn();
        render(<HelpOverlay keymap={keymapFor([], [labCommand('run', 'ctrl+alt+r')])} version="1.0.0" onClose={() => undefined} onOpenPlugins={onOpenPlugins} />);
        fireEvent.click(screen.getByTestId('help-open-plugins'));
        expect(onOpenPlugins).toHaveBeenCalledTimes(1);
        cleanup();
        renderHelp([], [labCommand('run', 'ctrl+alt+r')]);
        expect(screen.queryByTestId('help-open-plugins')).toBeNull();
    });
});

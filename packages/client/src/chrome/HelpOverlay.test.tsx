import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HELP_CLI_ENTRIES, HELP_GITHUB_URL, HelpOverlay } from './HelpOverlay';
import { clientKeyBindings } from './keys';

afterEach(cleanup);

function renderHelp(overrides: readonly string[] = []): { onClose: () => void } {
    const onClose = vi.fn();
    render(
        <HelpOverlay bindings={clientKeyBindings(overrides)} version="9.9.9" onClose={onClose} />
    );
    return { onClose };
}

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

    it('draws an em dash for an action nothing is bound to', () => {
        renderHelp(['super+d=unbind']);
        const row = document.querySelector('[data-help-action="split_right"]');
        expect(row?.textContent).toContain('—');
    });

    it('groups rows under the six visible categories', () => {
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
            'Search'
        ]);
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
                bindings={clientKeyBindings([])}
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
                bindings={clientKeyBindings([])}
                version="1.0.0"
                onClose={() => undefined}
                onOpenKeybindings={onOpenKeybindings}
            />
        );
        fireEvent.click(screen.getByTestId('help-open-keybindings'));
        expect(onOpenKeybindings).toHaveBeenCalledTimes(1);
    });
});

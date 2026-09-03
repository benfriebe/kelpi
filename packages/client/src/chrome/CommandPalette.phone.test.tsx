/**
 * The command palette on a phone (MOBILE-PLAN.md §4 B5), and the pin that says a desktop did not
 * move.
 *
 * **Every phone rule in this program is an owner-directed divergence from the shipped Swift app**;
 * `chrome/form-factor.ts` carries the standing note and `CommandPalette.tsx` states this one.
 *
 * The software keyboard is faked at the only place the client reads one - a `visualViewport` whose
 * `height` shrinks - through the component's injectable `formFactorWindow`. jsdom has no visual
 * viewport and no `matchMedia`, so without the seam the palette here is a desktop palette with a
 * zero inset, which is what the last `describe` block relies on and pins.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from './CommandPalette';
import { modalPresenceCount, overlayPresenceCount } from './modal-presence';
import type { PaletteItem } from './palette';
import { createFakePhoneWindow, type FakePhoneWindow } from '../phone/testing';

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const P2 = 'dddddddd-0000-4000-8000-000000000002';

const ITEMS: readonly PaletteItem[] = [
    {
        id: `ws:${W1}`,
        kind: 'workspace',
        icon: 'rectangle.stack',
        title: 'kelpi-client',
        subtitle: '2 panes',
        workspaceID: W1,
        workspaceName: 'kelpi-client',
        paneID: null,
        workspaceColor: 'blue'
    },
    {
        id: `pane:${P1}`,
        kind: 'pane',
        icon: 'terminal',
        title: '~/code/kelpi',
        subtitle: '',
        workspaceID: W1,
        workspaceName: 'kelpi-client',
        paneID: P1,
        workspaceColor: 'blue'
    },
    {
        id: `pane:${P2}`,
        kind: 'pane',
        icon: 'doc.text',
        title: 'notes',
        subtitle: 'README.md',
        workspaceID: W1,
        workspaceName: 'kelpi-client',
        paneID: P2,
        workspaceColor: 'blue'
    }
];

/** iOS's software keyboard on an iPhone is about this tall in CSS px. */
const KEYBOARD_PX = 300;

interface PhoneSetup {
    readonly win: FakePhoneWindow;
    readonly onConfirm: ReturnType<typeof vi.fn>;
    readonly onDismiss: ReturnType<typeof vi.fn>;
    readonly onQueryChange: ReturnType<typeof vi.fn>;
    readonly panel: () => HTMLElement;
    readonly rows: () => HTMLElement[];
}

function renderPhone(query = ''): PhoneSetup {
    const win = createFakePhoneWindow();
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    const onQueryChange = vi.fn();
    render(
        <CommandPalette
            open
            query={query}
            onQueryChange={onQueryChange}
            items={ITEMS}
            onConfirm={onConfirm}
            onDismiss={onDismiss}
            formFactorWindow={win}
        />
    );
    return {
        win,
        onConfirm,
        onDismiss,
        onQueryChange,
        panel: () => screen.getByTestId('command-palette'),
        rows: () => screen.queryAllByTestId('palette-row')
    };
}

afterEach(cleanup);

describe('the command palette on a phone', () => {
    it('fills the screen as a sheet, with no card geometry left on it', () => {
        const view = renderPhone();
        const panel = view.panel();
        expect(panel.dataset['phoneSheet']).toBe('true');
        // Positioned against the VIEWPORT: §M53 mounts this overlay on the CONTENT ROW, which on
        // a phone is the window minus the top bar, the footer and the sidebar.
        expect(screen.getByTestId('palette-backdrop').className).toContain('fixed inset-0');
        expect(panel.className).toContain('h-full');
        expect(panel.className).toContain('w-full');
        // The shipped card's 440 px, its 40 px top offset, its radius and its lift are all a
        // CARD's, and a sheet that covers the window is not one.
        expect(panel.className).not.toContain('w-[440px]');
        expect(panel.className).not.toContain('mt-10');
        expect(panel.className).not.toContain('rounded-[10px]');
        expect(panel.style.boxShadow).toBe('');
        // A full-screen overlay covers the phone chrome A3 paints the safe areas on.
        expect(panel.style.paddingTop).toBe('calc(env(safe-area-inset-top))');
        expect(panel.style.paddingLeft).toBe('calc(env(safe-area-inset-left))');
        expect(panel.style.paddingRight).toBe('calc(env(safe-area-inset-right))');
        // …and it is still the same dialog.
        expect(panel.getAttribute('role')).toBe('dialog');
        expect(panel.getAttribute('aria-label')).toBe('Command palette');
    });

    /*
     * §7's "Keyboard inset ownership": an overlay that owns its layout applies the inset to
     * ITSELF. The field is the last item on the reversed main axis, so the sheet's bottom padding
     * IS the field's distance from the window's bottom edge.
     */
    it('pins its box above a 300 px software keyboard, and gives the space back', () => {
        const view = renderPhone();
        expect(view.panel().style.paddingBottom).toBe('calc(0px + env(safe-area-inset-bottom))');

        act(() => {
            view.win.raiseKeyboard(KEYBOARD_PX);
        });
        expect(view.panel().style.paddingBottom).toBe('calc(300px + env(safe-area-inset-bottom))');

        act(() => {
            view.win.lowerKeyboard();
        });
        expect(view.panel().style.paddingBottom).toBe('calc(0px + env(safe-area-inset-bottom))');
    });

    it('puts the field at the bottom and the results above it, best match nearest the field', () => {
        const view = renderPhone('kelpi');
        const panel = view.panel();
        // The DOM order is untouched - field, then list - and the main axis is reversed, so the
        // field paints at the bottom. That is what keeps the reading order and the tab order the
        // ones every other rule in this component was written against.
        expect(panel.className).toContain('flex-col-reverse');
        const children = Array.from(panel.children);
        const field = screen.getByLabelText('Jump to workspace or pane');
        const list = screen.getAllByTestId('palette-row')[0]?.parentElement;
        expect(list).not.toBeNull();
        expect(children.indexOf(field.parentElement as Element)).toBeLessThan(children.indexOf(list as Element));

        // The list's own axis is reversed too, so row 0 - the selected best match - is the row
        // nearest the field.
        expect(list?.className).toContain('flex-col-reverse');
        const rows = view.rows();
        expect(rows[0]?.dataset['selected']).toBe('true');

        // …and the divider between them moves to the edge the gap is actually on.
        expect(field.parentElement?.className).toContain('border-t');
        expect(field.parentElement?.className).not.toContain('border-b');
    });

    it('carries the phone text-input attributes on the field, and only on a phone', () => {
        renderPhone();
        const field = screen.getByLabelText('Jump to workspace or pane');
        expect(field.getAttribute('autocapitalize')).toBe('off');
        expect(field.getAttribute('autocorrect')).toBe('off');
        expect(field.getAttribute('spellcheck')).toBe('false');
        expect(field.getAttribute('enterkeyhint')).toBe('go');
    });

    it('gives every row, and the search row itself, a 44 px touch target', () => {
        const view = renderPhone('kelpi');
        const rows = view.rows();
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.style.minHeight).toBe('44px');
        expect(screen.getByTestId('palette-search-row').style.minHeight).toBe('44px');
    });

    // Filtering and selection are the reducer's, unchanged: the phone branch is layout only.
    it('filters on the same rule and selects on the same keys', () => {
        const view = renderPhone('notes');
        expect(view.rows().map((row) => row.dataset['itemId'])).toEqual([`pane:${P2}`]);
        cleanup();

        const all = renderPhone('');
        expect(all.rows()).toHaveLength(ITEMS.length);
        expect(all.rows()[0]?.dataset['selected']).toBe('true');

        const panel = all.panel();
        fireEvent.keyDown(panel, { key: 'ArrowDown' });
        expect(all.rows()[1]?.dataset['selected']).toBe('true');
        fireEvent.keyDown(panel, { key: 'Enter' });
        expect(all.onConfirm).toHaveBeenCalledTimes(1);
        expect(all.onConfirm.mock.calls[0]?.[0]).toMatchObject({ id: `pane:${P1}` });

        cleanup();
        const escaped = renderPhone('');
        fireEvent.keyDown(escaped.panel(), { key: 'Escape' });
        expect(escaped.onDismiss).toHaveBeenCalledTimes(1);
    });

    it('confirms the row a tap lands on', () => {
        const view = renderPhone('notes');
        const row = view.rows()[0];
        expect(row).toBeDefined();
        fireEvent.click(row as HTMLElement);
        expect(view.onConfirm).toHaveBeenCalledTimes(1);
        expect(view.onConfirm.mock.calls[0]?.[0]).toMatchObject({ id: `pane:${P2}` });
    });

    /*
     * Measured rather than assumed: `CommandPalette` does not call `useModalPresence` on EITHER
     * form factor. `App.tsx:3576-3577` names `ui.palette.open` in `modalOpen` directly (the
     * registry is for surfaces the assembly cannot see), so what this file has to keep is that the
     * phone branch registers exactly what the desktop branch does - nothing.
     */
    it('registers modal presence exactly as the desktop branch does', () => {
        const modalsBefore = modalPresenceCount();
        const overlaysBefore = overlayPresenceCount();

        renderPhone('kelpi');
        const phoneModals = modalPresenceCount() - modalsBefore;
        const phoneOverlays = overlayPresenceCount() - overlaysBefore;
        cleanup();

        render(
            <CommandPalette
                open
                query="kelpi"
                onQueryChange={vi.fn()}
                items={ITEMS}
                onConfirm={vi.fn()}
                onDismiss={vi.fn()}
            />
        );
        expect(modalPresenceCount() - modalsBefore).toBe(phoneModals);
        expect(overlayPresenceCount() - overlaysBefore).toBe(phoneOverlays);
        cleanup();

        expect(modalPresenceCount()).toBe(modalsBefore);
        expect(overlayPresenceCount()).toBe(overlaysBefore);
    });

    // A phone-sized viewport with a FINE pointer is a person dragging a Mac window's edge.
    it('is the desktop card at a phone size with a fine pointer', () => {
        render(
            <CommandPalette
                open
                query=""
                onQueryChange={vi.fn()}
                items={ITEMS}
                onConfirm={vi.fn()}
                onDismiss={vi.fn()}
                formFactorWindow={createFakePhoneWindow({ coarse: false })}
            />
        );
        expect(screen.getByTestId('command-palette').className).toContain('w-[440px]');
        expect(screen.queryByTestId('palette-search-row')).toBeNull();
    });
});

/*
 * ── and NOT on desktop ──────────────────────────────────────────────────────────────
 *
 * MOBILE-PLAN.md §3.1: "a desktop window, an Electron shell and a tablet in landscape must render
 * byte-identical DOM to today". Pinned as the rendered markup rather than as a list of properties,
 * because a property list only catches the properties somebody thought to list. The snapshots were
 * generated from the component as it stood BEFORE B5 (the branch point,
 * `origin/feat/phone-e1-e2-form-factor-harness`) and committed; them passing after the change is
 * the measurement.
 */
describe('the command palette on a desktop', () => {
    function renderDesktop(query: string) {
        render(
            <CommandPalette
                open
                query={query}
                onQueryChange={vi.fn()}
                items={ITEMS}
                onConfirm={vi.fn()}
                onDismiss={vi.fn()}
            />
        );
        return screen.getByTestId('palette-backdrop').outerHTML;
    }

    it('renders byte-identical markup with results', () => {
        expect(renderDesktop('kelpi')).toMatchSnapshot();
    });

    it('renders byte-identical markup with no results', () => {
        expect(renderDesktop('zzzz')).toMatchSnapshot();
    });

    it('renders byte-identical markup with an empty query and an empty universe', () => {
        render(
            <CommandPalette
                open
                query=""
                onQueryChange={vi.fn()}
                items={[]}
                onConfirm={vi.fn()}
                onDismiss={vi.fn()}
            />
        );
        expect(screen.getByTestId('palette-backdrop').outerHTML).toMatchSnapshot();
    });

    it('puts no phone text-input attributes on the field, and no inset on its box', () => {
        renderDesktop('');
        const field = screen.getByLabelText('Jump to workspace or pane');
        expect(field.getAttribute('autocapitalize')).toBeNull();
        expect(field.getAttribute('autocorrect')).toBeNull();
        expect(field.getAttribute('spellcheck')).toBeNull();
        expect(field.getAttribute('enterkeyhint')).toBeNull();
        expect(screen.getByTestId('command-palette').style.paddingBottom).toBe('');
    });
});

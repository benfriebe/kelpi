/**
 * Placement, which is the part of a context menu a user notices only when it is wrong.
 *
 * The menu itself (portal lifetime, submenus, dismissal) is covered by `Sidebar.test.tsx`;
 * what lives here is `menuAnchorFromEvent`, whose whole job is deciding where the panel lands.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextMenu, menuAnchorFromEvent } from './ContextMenu';

afterEach(() => {
    cleanup();
});

const ROW = { top: 120, bottom: 164 };

describe('menuAnchorFromEvent', () => {
    it('opens at the pointer when nothing has to be avoided', () => {
        expect(menuAnchorFromEvent({ clientX: 40, clientY: 200 })).toEqual({ x: 40, y: 200 });
    });

    it('drops below the row it acts on, so you can still see which one it is', () => {
        // run-B m7: opening at the pointer put the panel over the workspace being renamed or
        // deleted — the one thing a destructive menu must keep visible.
        expect(menuAnchorFromEvent({ clientX: 40, clientY: 140 }, ROW)).toEqual({ x: 40, y: 168 });
    });

    it('rises above the row when there is no room below it', () => {
        const low = { top: 700, bottom: 744 };
        const anchor = menuAnchorFromEvent({ clientX: 40, clientY: 720 }, low);
        expect(anchor.y).toBeLessThan(low.top);
    });

    it('still clamps into the viewport', () => {
        const anchor = menuAnchorFromEvent({ clientX: 5000, clientY: 5000 });
        expect(anchor.x).toBeLessThan(5000);
        expect(anchor.y).toBeLessThan(5000);
    });

    it('ignores a null rect (a host with no layout)', () => {
        expect(menuAnchorFromEvent({ clientX: 12, clientY: 34 }, null)).toEqual({ x: 12, y: 34 });
    });
});

describe('ContextMenu', () => {
    it('renders where it was told to', () => {
        render(
            <ContextMenu
                x={40}
                y={168}
                items={[{ id: 'rename', label: 'Rename…' }]}
                onClose={() => undefined}
            />
        );
        const menu = screen.getByTestId('context-menu');
        expect(menu.style.left).toBe('40px');
        expect(menu.style.top).toBe('168px');
    });

    /**
     * The submenu side, which is the other half of "placement you notice only when it is wrong".
     *
     * `left-full` was unconditional, so a menu opened near the window's right edge put its
     * submenu past the edge: it rendered, it reported a box, and every click on it landed
     * outside the window. docs/audit/run-H caught it as an intermittent — the pane-header
     * Status ▸ submenu only failed in the runs whose target pane sat on the right.
     *
     * jsdom gives every element a zero-size rect, so the measurement is stubbed rather than
     * laid out: what is under test is the DECISION, and `data-submenu-side` is how it is read.
     */
    function renderWithSubmenu(right: number): HTMLElement {
        const original = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function stub(this: Element): DOMRect {
            if (this.getAttribute('data-testid') !== 'context-submenu') return original.call(this);
            return { ...new DOMRect(right - 180, 0, 180, 100), right, left: right - 180 } as DOMRect;
        };
        try {
            render(
                <ContextMenu
                    x={0}
                    y={0}
                    items={[
                        {
                            id: 'status',
                            label: 'Status',
                            submenu: [{ id: 'idle', label: 'Idle' }]
                        }
                    ]}
                    onClose={() => undefined}
                />
            );
            fireEvent.mouseEnter(screen.getByText('Status'));
            return screen.getByTestId('context-submenu');
        } finally {
            Element.prototype.getBoundingClientRect = original;
        }
    }

    it('opens a submenu to the right when there is room', () => {
        const submenu = renderWithSubmenu(400);
        expect(submenu.getAttribute('data-submenu-side')).toBe('right');
        expect(submenu.className).toContain('left-full');
    });

    it('flips a submenu to the left rather than off the window edge', () => {
        // `innerWidth` is jsdom's default 1024; a right edge past it must flip.
        const submenu = renderWithSubmenu(1200);
        expect(submenu.getAttribute('data-submenu-side')).toBe('left');
        expect(submenu.className).toContain('right-full');
        expect(submenu.className).not.toContain('left-full');
    });

    it('closes on Escape', () => {
        let closed = false;
        render(
            <ContextMenu
                x={0}
                y={0}
                items={[{ id: 'rename', label: 'Rename…' }]}
                onClose={() => {
                    closed = true;
                }}
            />
        );
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(closed).toBe(true);
    });

    /**
     * `autoFocus` — §WS-004's footer chevron opens this panel by CLICKING a toggle, which makes
     * it a dropdown, and a dropdown takes the keyboard. A right-click context menu must not: it
     * would pull focus out of a rename field or the terminal for a menu the user may dismiss
     * with the next click. Both halves are asserted, because the default is the load-bearing one.
     */
    const items = [
        { id: 'disabled', label: 'Unavailable', disabled: true },
        { id: 'first', label: 'New Workspace' },
        { id: 'second', label: 'New Group' }
    ];

    it('leaves focus alone by default', () => {
        render(<ContextMenu x={0} y={0} items={items} onClose={() => undefined} />);
        expect(document.activeElement).toBe(document.body);
    });

    it('lands on the first ENABLED row when asked to take the keyboard', () => {
        render(<ContextMenu x={0} y={0} items={items} autoFocus onClose={() => undefined} />);
        expect((document.activeElement as HTMLElement).getAttribute('data-menu-item')).toBe('first');
    });
});

/**
 * UI-FIDELITY M58 — the keyboard walk an `NSMenu` has and this menu did not.
 *
 * Every `.contextMenu` in the shipped app is a real `NSMenu` (`PaneHeaderView.swift:277`,
 * `WorkspaceListView.swift:513,562,610,824,1590`, `RepoRegistryView.swift:96`,
 * `WorkspaceInspectorView.swift:388`): ↑/↓ move the highlight, → opens a submenu, ← closes it,
 * Return activates. The port answered Escape and nothing else — after `autoFocus` only Tab moved.
 *
 * The focused row IS the highlighted row (`rowHighlight` unions focus with hover), so these
 * assertions read `document.activeElement` and `data-highlighted` together: one appearance, one
 * source of truth, no second selection model to drift.
 */
describe('keyboard navigation — an NSMenu walk (M58)', () => {
    const rows = [
        { id: 'rename', label: 'Rename…' },
        { id: 'unavailable', label: 'Unavailable', disabled: true },
        { id: 'status', label: 'Status', submenu: [{ id: 'idle', label: 'Idle' }, { id: 'busy', label: 'Busy' }] },
        { id: 'delete', label: 'Delete', danger: true }
    ];
    const focusedID = (): string | null =>
        (document.activeElement as HTMLElement | null)?.getAttribute('data-menu-item') ?? null;
    const open = (onClose = () => undefined, autoFocus = false): void => {
        render(<ContextMenu x={0} y={0} items={rows} autoFocus={autoFocus} onClose={onClose} />);
    };

    it('↓ takes the keyboard from wherever it was and lands on the first enabled row', () => {
        open();
        expect(document.activeElement).toBe(document.body);
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        expect(focusedID()).toBe('rename');
        // …and the landing row is HIGHLIGHTED, not merely focused.
        expect((document.activeElement as HTMLElement).getAttribute('data-highlighted')).toBe('true');
    });

    it('↑/↓ skip a disabled row and wrap at both ends, the way a native menu does', () => {
        open();
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        // 'unavailable' is not a stop.
        expect(focusedID()).toBe('status');
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        expect(focusedID()).toBe('delete');
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        expect(focusedID()).toBe('rename');
        fireEvent.keyDown(document, { key: 'ArrowUp' });
        expect(focusedID()).toBe('delete');
    });

    it('→ opens a submenu and hands it the keyboard; ← closes it and hands the parent back', () => {
        open();
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        expect(focusedID()).toBe('status');

        fireEvent.keyDown(document, { key: 'ArrowRight' });
        expect(screen.getByTestId('context-submenu')).toBeTruthy();
        expect(focusedID()).toBe('idle');

        fireEvent.keyDown(document, { key: 'ArrowDown' });
        expect(focusedID()).toBe('busy');

        fireEvent.keyDown(document, { key: 'ArrowLeft' });
        expect(screen.queryByTestId('context-submenu')).toBeNull();
        expect(focusedID()).toBe('status');
    });

    it('walking the parent panel closes an open submenu rather than orphaning it', () => {
        open();
        fireEvent.mouseEnter(screen.getByText('Status'));
        expect(screen.queryByTestId('context-submenu')).toBeTruthy();
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        expect(screen.queryByTestId('context-submenu')).toBeNull();
    });

    it('Return activates the focused row and closes the menu', () => {
        let closed = false;
        const selected: string[] = [];
        render(
            <ContextMenu
                x={0}
                y={0}
                items={[
                    { id: 'rename', label: 'Rename…', onSelect: () => selected.push('rename') },
                    { id: 'delete', label: 'Delete', onSelect: () => selected.push('delete') }
                ]}
                onClose={() => {
                    closed = true;
                }}
            />
        );
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        expect(focusedID()).toBe('delete');
        fireEvent.keyDown(document, { key: 'Enter' });
        expect(selected).toEqual(['delete']);
        expect(closed).toBe(true);
    });

    it('Return on a submenu PARENT opens it — it does not fire the parent as a command', () => {
        open();
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        fireEvent.keyDown(document, { key: 'Enter' });
        expect(screen.getByTestId('context-submenu')).toBeTruthy();
        expect(focusedID()).toBe('idle');
    });

    it('Return does NOT act while no row holds focus — the key belongs to whatever the user was in', () => {
        let closed = false;
        const selected: string[] = [];
        render(
            <ContextMenu
                x={0}
                y={0}
                items={[{ id: 'rename', label: 'Rename…', onSelect: () => selected.push('rename') }]}
                onClose={() => {
                    closed = true;
                }}
            />
        );
        expect(document.activeElement).toBe(document.body);
        fireEvent.keyDown(document, { key: 'Enter' });
        expect(selected).toEqual([]);
        expect(closed).toBe(false);
    });

    it('the walk consumes its keys, so nothing behind the menu also acts on them', () => {
        open();
        const event = fireEvent.keyDown(document, { key: 'ArrowDown' });
        expect(event).toBe(false); // preventDefault was called
    });

    it('a menu with no enabled rows at all is left alone rather than eating the arrows', () => {
        render(
            <ContextMenu
                x={0}
                y={0}
                items={[{ id: 'caption', label: '2 workspaces selected', kind: 'caption' }]}
                onClose={() => undefined}
            />
        );
        expect(fireEvent.keyDown(document, { key: 'ArrowDown' })).toBe(true);
        expect(document.activeElement).toBe(document.body);
    });
});

/**
 * The highlight — the user's second report, and the only feedback a menu gives about which row
 * a click is about to hit.
 *
 * The rule this replaces lit up exactly one kind of row: a submenu parent, and only because its
 * submenu had opened under the pointer. "Rename…", "Duplicate", "Close Pane", every row in the
 * footer chevron and the titlebar ••• stayed transparent under the cursor. Because every menu
 * in the client renders through this component's `MenuRow`, the fix is asserted here once
 * rather than per call site.
 *
 * The background is read off `style` rather than `getComputedStyle`: the token is
 * `var(--nex-selection-fill, …)`, and jsdom resolves an unset custom property to the empty
 * string, which would make every row's *computed* background identical and the assertion
 * vacuous. The real computed-colour read is the audit's, in a browser with the theme mounted.
 */
describe('every enabled row highlights — hover, focus, or an open submenu', () => {
    const HIGHLIGHT = 'var(--nex-selection-fill, rgba(82, 118, 184, 0.24))';
    const rows = [
        { id: 'rename', label: 'Rename…' },
        { id: 'status', label: 'Status', submenu: [{ id: 'idle', label: 'Idle' }] },
        { id: 'delete', label: 'Delete', danger: true },
        { id: 'unavailable', label: 'Unavailable', disabled: true }
    ];
    const row = (id: string): HTMLElement => {
        const found = screen.getByTestId('context-menu').querySelector<HTMLElement>(`[data-menu-item="${id}"]`);
        if (found === null) throw new Error(`no menu row ${id}`);
        return found;
    };
    const fill = (id: string): string => row(id).style.background;

    const open = (): void => {
        render(<ContextMenu x={0} y={0} items={rows} onClose={() => undefined} />);
    };

    it('a PLAIN row highlights under the pointer, and gives it back on the way out', () => {
        open();
        expect(fill('rename')).toBe('transparent');
        expect(row('rename').getAttribute('data-highlighted')).toBe('false');

        fireEvent.mouseEnter(row('rename'));
        expect(fill('rename')).toBe(HIGHLIGHT);
        expect(row('rename').getAttribute('data-highlighted')).toBe('true');

        fireEvent.mouseLeave(row('rename'));
        expect(fill('rename')).toBe('transparent');
    });

    it('a DISABLED row does not — it reads as unavailable and must not offer itself', () => {
        open();
        fireEvent.mouseEnter(row('unavailable'));
        expect(fill('unavailable')).toBe('transparent');
        expect(row('unavailable').getAttribute('data-highlighted')).toBe('false');
        // The dimming that says so is still the only thing marking it.
        expect(row('unavailable').className).toContain('disabled:opacity-40');
    });

    it('keyboard focus renders the SAME highlight as hover — one appearance, two ways in', () => {
        open();
        fireEvent.focus(row('rename'));
        const focused = fill('rename');
        fireEvent.blur(row('rename'));
        expect(fill('rename')).toBe('transparent');

        fireEvent.mouseEnter(row('rename'));
        expect(focused).toBe(fill('rename'));
        expect(focused).toBe(HIGHLIGHT);
    });

    it('the autoFocus landing row is highlighted on arrival, not just focused', () => {
        render(<ContextMenu x={0} y={0} items={rows} autoFocus onClose={() => undefined} />);
        expect(document.activeElement).toBe(row('rename'));
        expect(row('rename').getAttribute('data-highlighted')).toBe('true');
    });

    it('a DANGER row highlights too, and keeps the red that is the only thing marking it', () => {
        open();
        fireEvent.mouseEnter(row('delete'));
        expect(fill('delete')).toBe(HIGHLIGHT);
        // rgb, because jsdom normalises the hex.
        expect(row('delete').style.color).toBe('rgb(224, 101, 92)');
    });

    it('a submenu parent keeps its existing behaviour: lit while its child panel is open', () => {
        open();
        fireEvent.mouseEnter(row('status'));
        expect(screen.getByTestId('context-submenu')).toBeTruthy();
        expect(fill('status')).toBe(HIGHLIGHT);

        // The pointer moves off the parent and INTO the submenu: hover is gone, the submenu is
        // not, and the parent must stay lit or the trail back is invisible.
        fireEvent.mouseLeave(row('status'));
        expect(fill('status')).toBe(HIGHLIGHT);
        expect(row('status').getAttribute('data-highlighted')).toBe('true');
    });

    it('and a submenu’s OWN rows highlight by the same rule', () => {
        open();
        fireEvent.mouseEnter(row('status'));
        const child = within(screen.getByTestId('context-submenu')).getByText('Idle').closest('button');
        if (child === null) throw new Error('no submenu row');
        expect(child.style.background).toBe('transparent');
        fireEvent.mouseEnter(child);
        expect(child.style.background).toBe(HIGHLIGHT);
    });

    it('hovering a plain row closes an open submenu AND highlights itself', () => {
        open();
        fireEvent.mouseEnter(row('status'));
        expect(screen.queryByTestId('context-submenu')).toBeTruthy();

        // The pointer's real journey: out of one row, into the next. (jsdom fires only what it
        // is asked to; a browser pairs them, which is what the audit's `mouseMoved` exercises.)
        fireEvent.mouseLeave(row('status'));
        fireEvent.mouseEnter(row('rename'));
        expect(screen.queryByTestId('context-submenu')).toBeNull();
        expect(fill('rename')).toBe(HIGHLIGHT);
        expect(fill('status')).toBe('transparent');
    });
});

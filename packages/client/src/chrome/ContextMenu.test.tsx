/**
 * Placement, which is the part of a context menu a user notices only when it is wrong.
 *
 * The menu itself (portal lifetime, submenus, dismissal) is covered by `Sidebar.test.tsx`;
 * what lives here is `menuAnchorFromEvent`, whose whole job is deciding where the panel lands.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});

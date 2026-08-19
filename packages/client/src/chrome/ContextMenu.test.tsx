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

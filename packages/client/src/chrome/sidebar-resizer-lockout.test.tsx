/**
 * Issue #79 — the sidebar drag that never ends.
 *
 * `Sidebar.bulk.test.tsx` already pins the happy path (§WS-002: snapshot tracking, the clamp,
 * the release). This file pins the three ways the release never arrives, each of which left
 * `drag.current` live, the window listeners installed and `document.body`'s `col-resize` cursor
 * over the whole app: the sidebar then tracked the bare cursor for the rest of the session and
 * re-entered a full grid resize on every mouse move.
 *
 * jsdom has no `PointerEvent`, so every event here is a real bubbling `MouseEvent` with the
 * pointer type name — the same shape `Sidebar.bulk.test.tsx` uses, and for the same reason:
 * Testing Library's synthesized events arrive without `clientX`.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SidebarResizer } from './SidebarResizer';

afterEach(() => {
    cleanup();
    document.body.style.removeProperty('cursor');
});

function press(handle: HTMLElement, clientX: number): void {
    handle.dispatchEvent(new MouseEvent('pointerdown', { clientX, button: 0, bubbles: true }));
}

function moveTo(clientX: number): void {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX }));
}

describe('sidebar resizer: a gesture always ends (issue #79)', () => {
    it('sets the body cursor for the length of the drag and clears it on release', () => {
        const onResize = vi.fn();
        render(<SidebarResizer width={220} onResize={onResize} />);
        const handle = screen.getByTestId('sidebar-resizer');

        expect(document.body.style.cursor).toBe('');
        press(handle, 220);
        expect(document.body.style.cursor).toBe('col-resize');
        window.dispatchEvent(new MouseEvent('pointerup', { clientX: 260 }));
        expect(document.body.style.cursor).toBe('');
    });

    it('ends the drag on pointercancel, cursor and listeners with it', () => {
        const onResize = vi.fn();
        const onCommit = vi.fn();
        const onResizeEnd = vi.fn();
        render(
            <SidebarResizer width={220} onResize={onResize} onCommit={onCommit} onResizeEnd={onResizeEnd} />
        );
        const handle = screen.getByTestId('sidebar-resizer');

        press(handle, 220);
        moveTo(260);
        expect(onResize).toHaveBeenLastCalledWith(260);

        // The browser took the pointer away instead of releasing it.
        window.dispatchEvent(new MouseEvent('pointercancel', { clientX: 260 }));
        expect(onResizeEnd).toHaveBeenCalledTimes(1);
        // What the user had already dragged to is kept, not snapped back.
        expect(onCommit).toHaveBeenCalledWith(260);
        expect(document.body.style.cursor).toBe('');

        // The lockout itself: a bare move afterwards must resize nothing.
        onResize.mockClear();
        moveTo(120);
        expect(onResize).not.toHaveBeenCalled();
    });

    it('unmounting mid-drag removes the listeners and clears the cursor (⇧⌘S while dragging)', () => {
        const onResize = vi.fn();
        const onCommit = vi.fn();
        const onResizeEnd = vi.fn();
        const view = render(
            <SidebarResizer width={220} onResize={onResize} onCommit={onCommit} onResizeEnd={onResizeEnd} />
        );
        press(screen.getByTestId('sidebar-resizer'), 220);
        moveTo(280);
        expect(onResize).toHaveBeenLastCalledWith(280);

        // `App.tsx` stops rendering the handle the moment the sidebar starts closing.
        view.unmount();

        expect(onResizeEnd).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith(280);
        expect(document.body.style.cursor).toBe('');

        onResize.mockClear();
        moveTo(190);
        expect(onResize).not.toHaveBeenCalled();
    });

    it('signals the end of a press that never moved, so the resizing flag always clears', () => {
        const onCommit = vi.fn();
        const onResizeEnd = vi.fn();
        const onResizeStart = vi.fn();
        render(
            <SidebarResizer
                width={220}
                onResize={vi.fn()}
                onCommit={onCommit}
                onResizeEnd={onResizeEnd}
                onResizeStart={onResizeStart}
            />
        );
        press(screen.getByTestId('sidebar-resizer'), 220);
        expect(onResizeStart).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new MouseEvent('pointerup', { clientX: 220 }));
        // `onCommit` fires with the unchanged width; `onResizeEnd` is the unconditional one
        // App.tsx clears `sidebarResizing` from.
        expect(onResizeEnd).toHaveBeenCalledTimes(1);
    });

    it('a second drag after an unmount-interrupted one still tracks (the teardown is not sticky)', () => {
        const first = render(<SidebarResizer width={220} onResize={vi.fn()} />);
        press(screen.getByTestId('sidebar-resizer'), 220);
        first.unmount();

        const onResize = vi.fn();
        render(<SidebarResizer width={220} onResize={onResize} />);
        press(screen.getByTestId('sidebar-resizer'), 200);
        moveTo(250);
        expect(onResize).toHaveBeenLastCalledWith(270);
    });
});

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { overlayPresenceCount } from './modal-presence';
import { RESTORE_STRIP_HEIGHT_PX, RestoreStrip } from './RestoreStrip';

afterEach(cleanup);

/**
 * The root arrangement's route back: the strip the host draws where a hidden toolbar was. It has
 * to be the window's drag region inside a shell, a handle that restores, and a surface that parks
 * a web page only while its label actually hangs over one.
 */
describe('the restore strip', () => {
    it('is 8 px, the drag region inside a shell window, and nothing of the sort in a browser tab', () => {
        const view = render(<RestoreStrip zen chord="⌃⌘↩" dragRegion onRestore={() => {}} />);
        const strip = screen.getByTestId('restore-strip');
        expect(RESTORE_STRIP_HEIGHT_PX).toBe(8);
        expect(strip.style.height).toBe('8px');
        expect(strip.getAttribute('data-titlebar-drag')).toBe('true');
        // The handle is a button, which `styles.css` opts back out of the drag region.
        expect(screen.getByTestId('restore-strip-handle').tagName).toBe('BUTTON');
        view.rerender(<RestoreStrip zen chord="⌃⌘↩" dragRegion={false} onRestore={() => {}} />);
        expect(screen.getByTestId('restore-strip').hasAttribute('data-titlebar-drag')).toBe(false);
    });

    it('names the way out, chord included, and grows into a label only while hovered or focused', () => {
        render(<RestoreStrip zen chord="⌃⌘↩" dragRegion onRestore={() => {}} />);
        const handle = screen.getByTestId('restore-strip-handle');
        expect(handle.getAttribute('aria-label')).toBe('Exit Zen Mode (⌃⌘↩)');
        expect(handle.textContent).toBe('');
        expect(overlayPresenceCount()).toBe(0);
        fireEvent.pointerEnter(handle);
        expect(handle.getAttribute('data-expanded')).toBe('true');
        expect(handle.textContent).toBe('Exit Zen Mode⌃⌘↩');
        // Only now does it hang over the grid, so only now can it park a page.
        expect(overlayPresenceCount()).toBe(1);
        fireEvent.pointerLeave(handle);
        expect(overlayPresenceCount()).toBe(0);
        fireEvent.focus(handle);
        expect(handle.getAttribute('data-expanded')).toBe('true');
        fireEvent.blur(handle);
        expect(handle.getAttribute('data-expanded')).toBe('false');
    });

    it('offers the toolbar back outside Zen Mode, and says nothing of a chord the user unbound', () => {
        const view = render(<RestoreStrip zen={false} chord="⌃⌘↩" dragRegion onRestore={() => {}} />);
        expect(screen.getByTestId('restore-strip-handle').getAttribute('aria-label')).toBe('Show Toolbar');
        view.rerender(<RestoreStrip zen chord={undefined} dragRegion onRestore={() => {}} />);
        expect(screen.getByTestId('restore-strip-handle').getAttribute('aria-label')).toBe('Exit Zen Mode');
    });

    it('restores on a click and folds the label away', () => {
        const onRestore = vi.fn();
        render(<RestoreStrip zen chord="⌃⌘↩" dragRegion onRestore={onRestore} />);
        const handle = screen.getByTestId('restore-strip-handle');
        fireEvent.pointerEnter(handle);
        fireEvent.click(handle);
        expect(onRestore).toHaveBeenCalledOnce();
        expect(handle.getAttribute('data-expanded')).toBe('false');
    });
});

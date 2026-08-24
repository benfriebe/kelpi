/**
 * The shared outside-click / Escape contract (UI-FIDELITY H15).
 *
 * The hook is `ContextMenu`'s own effect, lifted so the footer's bucket popover and the title
 * bar's layout dropdown can have it. What has to hold, and what the two panels were missing:
 * a click anywhere else closes, a click INSIDE does not, a click on the control that opened it
 * does not (or the panel could never be closed by its own toggle), Escape closes and is consumed,
 * and nothing is listening while the panel is shut.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, type ReactElement } from 'react';

import { useDismissable } from './index';

afterEach(cleanup);

function Panel(props: { readonly open: boolean; readonly onDismiss: () => void }): ReactElement {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    useDismissable(props.open, props.onDismiss, [panelRef, anchorRef]);
    return (
        <div>
            <button ref={anchorRef} type="button" data-testid="anchor">
                open
            </button>
            <div data-testid="outside">elsewhere</div>
            {props.open ? (
                <div ref={panelRef} data-testid="panel">
                    <button type="button" data-testid="row">
                        row
                    </button>
                </div>
            ) : null}
        </div>
    );
}

describe('useDismissable', () => {
    it('a mousedown outside the panel dismisses it', () => {
        const onDismiss = vi.fn();
        render(<Panel open onDismiss={onDismiss} />);
        fireEvent.mouseDown(screen.getByTestId('outside'));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('a mousedown inside the panel — including on a row — does not', () => {
        const onDismiss = vi.fn();
        render(<Panel open onDismiss={onDismiss} />);
        fireEvent.mouseDown(screen.getByTestId('panel'));
        fireEvent.mouseDown(screen.getByTestId('row'));
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('a mousedown on the ANCHOR does not, so the control that opened it can also close it', () => {
        const onDismiss = vi.fn();
        render(<Panel open onDismiss={onDismiss} />);
        fireEvent.mouseDown(screen.getByTestId('anchor'));
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('Escape dismisses, and is consumed so it does not also reach the window behind', () => {
        const onDismiss = vi.fn();
        const behind = vi.fn();
        window.addEventListener('keydown', behind);
        render(<Panel open onDismiss={onDismiss} />);
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(behind).not.toHaveBeenCalled();
        window.removeEventListener('keydown', behind);
    });

    it('another key is left alone', () => {
        const onDismiss = vi.fn();
        render(<Panel open onDismiss={onDismiss} />);
        fireEvent.keyDown(document.body, { key: 'a' });
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('nothing is listening while the panel is closed', () => {
        const onDismiss = vi.fn();
        render(<Panel open={false} onDismiss={onDismiss} />);
        fireEvent.mouseDown(screen.getByTestId('outside'));
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('unmounting takes both listeners with it', () => {
        const onDismiss = vi.fn();
        const view = render(<Panel open onDismiss={onDismiss} />);
        view.unmount();
        fireEvent.mouseDown(document.body);
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onDismiss).not.toHaveBeenCalled();
    });
});

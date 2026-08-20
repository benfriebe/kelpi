/**
 * The pane search overlay (TERM-114 / TERM-115 / TERM-118).
 *
 * What is worth protecting here is the counter's rule and the keyboard contract, because both
 * are copied from the Swift overlay rather than invented: `selected+1/total`, `-/total` before
 * a selection exists, nothing while the field is empty; Return next, ⇧Return previous, Escape
 * close; and the chevrons inert while there is nothing to step through.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaneSearchOverlay, matchCountLabel } from './PaneSearchOverlay';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

afterEach(cleanup);

function setup(overrides: Partial<Parameters<typeof PaneSearchOverlay>[0]> = {}) {
    const handlers = {
        onNeedleChange: vi.fn(),
        onNext: vi.fn(),
        onPrevious: vi.fn(),
        onClose: vi.fn()
    };
    render(
        <PaneSearchOverlay
            paneID={PANE}
            needle=""
            total={null}
            selected={null}
            {...handlers}
            {...overrides}
        />
    );
    return handlers;
}

describe('matchCountLabel', () => {
    it('is empty while the needle is', () => {
        expect(matchCountLabel('', 5, 1)).toBeNull();
    });

    it('is empty before the daemon has reported a total', () => {
        expect(matchCountLabel('x', null, null)).toBeNull();
    });

    it('reads "-/N" before anything is selected', () => {
        expect(matchCountLabel('x', 17, null)).toBe('-/17');
    });

    it('is 1-based once a match is selected', () => {
        expect(matchCountLabel('x', 17, 0)).toBe('1/17');
        expect(matchCountLabel('x', 17, 16)).toBe('17/17');
    });

    it('cannot read "3/0": a zero total has no selection to show', () => {
        // The daemon drops the selection when the total goes to zero, so the pair that would
        // produce "3/0" never reaches this function — and if it did, it would say so honestly.
        expect(matchCountLabel('x', 0, null)).toBe('-/0');
    });
});

describe('PaneSearchOverlay', () => {
    it('autofocuses the field on mount', () => {
        setup();
        expect(document.activeElement).toBe(screen.getByTestId(`pane-search-input-${PANE}`));
    });

    it('reports every keystroke as a needle change', () => {
        const handlers = setup();
        fireEvent.change(screen.getByTestId(`pane-search-input-${PANE}`), { target: { value: 'mark' } });
        expect(handlers.onNeedleChange).toHaveBeenCalledWith('mark');
    });

    it('renders the live counter over the field', () => {
        setup({ needle: 'mark', total: 4, selected: 2 });
        fireEvent.change(screen.getByTestId(`pane-search-input-${PANE}`), { target: { value: 'mark' } });
        expect(screen.getByTestId(`pane-search-count-${PANE}`).textContent).toBe('3/4');
    });

    it('steps forward on Return and backward on ⇧Return', () => {
        const handlers = setup();
        const input = screen.getByTestId(`pane-search-input-${PANE}`);
        fireEvent.change(input, { target: { value: 'mark' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(handlers.onNext).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
        expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape', () => {
        const handlers = setup();
        fireEvent.keyDown(screen.getByTestId(`pane-search-input-${PANE}`), { key: 'Escape' });
        expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on a second ⌘F, which the binding map cannot see from inside a text field', () => {
        const handlers = setup();
        fireEvent.keyDown(screen.getByTestId(`pane-search-input-${PANE}`), {
            key: 'f',
            code: 'KeyF',
            metaKey: true
        });
        expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });

    it('closes from the ✕', () => {
        const handlers = setup();
        fireEvent.click(screen.getByTestId(`pane-search-close-${PANE}`));
        expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });

    it('leaves the chevrons in the row but inert while the needle is empty', () => {
        setup();
        const next = screen.getByTestId(`pane-search-next-${PANE}`) as HTMLButtonElement;
        const prev = screen.getByTestId(`pane-search-prev-${PANE}`) as HTMLButtonElement;
        expect(next.disabled).toBe(true);
        expect(prev.disabled).toBe(true);
        fireEvent.change(screen.getByTestId(`pane-search-input-${PANE}`), { target: { value: 'x' } });
        expect((screen.getByTestId(`pane-search-next-${PANE}`) as HTMLButtonElement).disabled).toBe(false);
    });

    it('steps from the chevrons', () => {
        const handlers = setup();
        fireEvent.change(screen.getByTestId(`pane-search-input-${PANE}`), { target: { value: 'x' } });
        fireEvent.click(screen.getByTestId(`pane-search-next-${PANE}`));
        fireEvent.click(screen.getByTestId(`pane-search-prev-${PANE}`));
        expect(handlers.onNext).toHaveBeenCalledTimes(1);
        expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
    });

    it('names every control, so the bar is readable without eyes', () => {
        setup();
        expect(screen.getByLabelText('Search')).toBeTruthy();
        expect(screen.getByLabelText('Next match (Return)')).toBeTruthy();
        expect(screen.getByLabelText('Previous match (⇧Return)')).toBeTruthy();
        expect(screen.getByLabelText('Close search (Escape)')).toBeTruthy();
    });
});

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

    /**
     * §H7 — `PaneSearchOverlay.swift:48-66` wires `chevron.up` to `onNavigateNext` and
     * `chevron.down` to `onNavigatePrevious`, in that DOM order. It reads backwards, and it is
     * exactly what a user of the shipped app has in their fingers, so the glyph is asserted
     * against the action rather than against the intuition.
     */
    it('puts NEXT under the up chevron and PREVIOUS under the down one, in that order', () => {
        const handlers = setup();
        fireEvent.change(screen.getByTestId(`pane-search-input-${PANE}`), { target: { value: 'x' } });

        const buttons = [...screen.getByTestId(`pane-search-${PANE}`).querySelectorAll('button')];
        const icons = buttons.map((button) => button.querySelector('svg')?.getAttribute('data-icon'));
        expect(icons).toEqual(['chevron-up', 'chevron-down', 'close']);

        fireEvent.click(buttons[0] as HTMLButtonElement);
        expect(handlers.onNext).toHaveBeenCalledTimes(1);
        expect(handlers.onPrevious).not.toHaveBeenCalled();

        fireEvent.click(buttons[1] as HTMLButtonElement);
        expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
        expect(handlers.onNext).toHaveBeenCalledTimes(1);

        expect((buttons[0] as HTMLButtonElement).getAttribute('aria-label')).toBe('Next match (Return)');
        expect((buttons[1] as HTMLButtonElement).getAttribute('aria-label')).toBe('Previous match (⇧Return)');
    });

    /**
     * `PaneSearchOverlay.swift:22` is `.font(.system(size: 12, design: .monospaced))`.
     *
     * The face was inline because it HAD to be: `styles.css`'s `input { font: inherit }` was
     * unlayered, and unlayered CSS outranks every Tailwind utility no matter its specificity,
     * which is why the built app measured this field at 13 px UI sans with `font-mono
     * text-[12px]` sitting right there on it. S1/S17 moved that reset into `@layer base`, so
     * the classes land too now — the assertion is unchanged, only its reason is: inline is
     * where this field's stated value lives, and it stays there.
     *
     * The second half is the fallout guard. `leading-none` rode along on the same class list
     * and was inert for exactly the same reason; once the reset was layered it would have
     * collapsed the line box from the body's 1.4 (16.8 px) to 12 and taken the bar off the
     * 26.8 px L22/TERM-114 measured. The class is gone, and must stay gone.
     */
    it('draws the field in 12 px monospace, with the body’s leading, past the global input reset', () => {
        setup();
        const input = screen.getByTestId(`pane-search-input-${PANE}`) as HTMLInputElement;
        expect(input.style.fontFamily).toContain('--nex-font-mono');
        expect(input.style.fontSize).toBe('12px');
        expect(input.className).not.toContain('leading-none');
    });

    it('renders the terminal bar’s own chrome — radius 8, header fill, drop shadow', () => {
        setup();
        const bar = screen.getByTestId(`pane-search-${PANE}`);
        expect(bar.className).toContain('rounded-lg');
        // L23: `.shadow(color: .black.opacity(0.2), radius: 4, y: 2)` (`PaneSearchOverlay.swift:81`),
        // on the same SwiftUI→CSS conversion `ResizeBadge` uses; and NO border — `:79-81` is
        // background → clip → shadow, nothing strokes the edge.
        expect(bar.style.boxShadow).toBe('0 2px 8px rgba(0,0,0,0.2)');
        expect(bar.style.border).toBe('');
        expect(bar.getAttribute('role')).toBe('search');
    });

    /** The prefix is how the content panes mount this same bar without colliding (§H29). */
    it('re-stems every test id and relabels the landmark for another surface', () => {
        setup({ testIDPrefix: 'content-find', label: 'Find in markdown preview' });
        expect(screen.queryByTestId(`pane-search-${PANE}`)).toBeNull();
        expect(screen.getByTestId(`content-find-${PANE}`).getAttribute('aria-label')).toBe(
            'Find in markdown preview'
        );
        for (const part of ['input', 'next', 'prev', 'close']) {
            expect(screen.getByTestId(`content-find-${part}-${PANE}`)).toBeTruthy();
        }
    });

    it('names every control, so the bar is readable without eyes', () => {
        setup();
        expect(screen.getByLabelText('Search')).toBeTruthy();
        expect(screen.getByLabelText('Next match (Return)')).toBeTruthy();
        expect(screen.getByLabelText('Previous match (⇧Return)')).toBeTruthy();
        expect(screen.getByLabelText('Close search (Escape)')).toBeTruthy();
    });
});

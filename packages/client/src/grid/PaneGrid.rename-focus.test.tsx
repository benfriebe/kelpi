import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { leaf, split } from '@kelpi/core/layout';

import { focusPaneSurface, mayClaimPaneCaret } from '../app/pane-focus';
import { PaneGrid, type PaneGridProps } from './PaneGrid';
import { testPane } from './testing';

afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
});

function renameFixture() {
    const onRenamePane = vi.fn();
    // App's existing DOM handback policy, with real surfaces rather than a focus-call spy.
    // Native web focus lives in the shell and is outside this jsdom assembly.
    const onReleaseChromeCaret = vi.fn((paneID: string | null) => {
        if (paneID !== null && mayClaimPaneCaret()) focusPaneSurface(paneID);
    });
    const props: PaneGridProps = {
        layout: split('horizontal', 0.5, leaf('a'), leaf('b')),
        panes: [testPane('a', { label: 'old' }), testPane('b')],
        focusedPaneID: 'a',
        size: { width: 800, height: 600 },
        onRenamePane,
        onReleaseChromeCaret,
        renderPane: (paneID) => (
            <div data-pane-surface data-terminal-host>
                <textarea aria-label={`Terminal ${paneID}`} />
            </div>
        )
    };
    const draw = (overrides: Partial<PaneGridProps>) => (
        <>
            <input aria-label="Other chrome editor" />
            <PaneGrid {...props} {...overrides} />
        </>
    );
    const view = render(draw({}));
    const terminal = screen.getByRole('textbox', { name: 'Terminal a' });
    act(() => terminal.focus());
    const open = (seq: number) => {
        view.rerender(draw({ renameRequest: { paneID: 'a', seq } }));
        const input = screen.getByRole('textbox', { name: 'Pane name' });
        expect(document.activeElement).toBe(input);
        fireEvent.change(input, { target: { value: '  renamed  ' } });
        return input;
    };
    return { ...view, terminal, open, draw, onRenamePane, onReleaseChromeCaret };
}

describe('inline pane rename caret ownership', () => {
    it.each(['Enter', 'Escape'])('returns the caret after %s removes the active input', (key) => {
        const fixture = renameFixture();
        const input = fixture.open(1);
        fireEvent.keyDown(input, { key });

        expect(input.isConnected).toBe(false);
        expect(document.activeElement).toBe(fixture.terminal);
        expect(screen.getByTestId('pane-a').getAttribute('data-focused')).toBe('true');
        expect(fixture.onReleaseChromeCaret).toHaveBeenCalledExactlyOnceWith('a');
        if (key === 'Enter') expect(fixture.onRenamePane).toHaveBeenCalledExactlyOnceWith('a', 'renamed');
        else expect(fixture.onRenamePane).not.toHaveBeenCalled();

        // Reopening proves the handback is per edit, not a one-time focus effect.
        fireEvent.keyDown(fixture.open(2), { key });
        expect(document.activeElement).toBe(fixture.terminal);
        expect(fixture.onReleaseChromeCaret).toHaveBeenCalledTimes(2);
    });

    it.each(['Other chrome editor', 'Terminal b'])('commits on blur without taking the caret from %s', (label) => {
        const fixture = renameFixture();
        const input = fixture.open(1);
        const destination = screen.getByRole('textbox', { name: label });
        act(() => destination.focus());

        expect(input.isConnected).toBe(false);
        expect(document.activeElement).toBe(destination);
        expect(fixture.onRenamePane).toHaveBeenCalledExactlyOnceWith('a', 'renamed');
        expect(fixture.onReleaseChromeCaret).not.toHaveBeenCalled();
    });

    it.each(['Enter', 'Escape'])('keeps the phone keyboard policy after %s', (key) => {
        window.history.replaceState(null, '', '/?form=phone');
        const fixture = renameFixture();
        const input = fixture.open(1);
        fireEvent.keyDown(input, { key });

        expect(input.isConnected).toBe(false);
        expect(document.activeElement).toBe(document.body);
        // The host decides phone/native policy; the header must not focus a surface itself.
        expect(fixture.onReleaseChromeCaret).toHaveBeenCalledExactlyOnceWith('a');
    });

    it('does not take focus back if another editor claims it during keyboard completion', () => {
        const fixture = renameFixture();
        const input = fixture.open(1);
        const destination = screen.getByRole('textbox', { name: 'Other chrome editor' });
        // A parent key handler can open/focus chrome before React commits removal.
        const takeCaret = () => destination.focus();
        document.addEventListener('keydown', takeCaret);
        try {
            fireEvent.keyDown(input, { key: 'Enter' });
        } finally {
            document.removeEventListener('keydown', takeCaret);
        }
        expect(input.isConnected).toBe(false);
        expect(document.activeElement).toBe(destination);
        expect(fixture.onReleaseChromeCaret).not.toHaveBeenCalled();
    });

    it('does not return the caret to a pane that lost logical focus during rename', () => {
        const fixture = renameFixture();
        const input = fixture.open(1);
        fixture.rerender(fixture.draw({ focusedPaneID: 'b', renameRequest: { paneID: 'a', seq: 1 } }));
        expect(document.activeElement).toBe(input);
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(fixture.onReleaseChromeCaret).not.toHaveBeenCalled();
        expect(document.activeElement).not.toBe(fixture.terminal);
    });
});

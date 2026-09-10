import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyBar } from './KeyBar';

afterEach(cleanup);

const released = { ctrl: false, alt: false };
const props = () => ({
    paneID: 'pane', captureRoot: { current: document.createElement('iframe') },
    setInputModifiers: vi.fn(), sendKey: vi.fn(() => true), pasteText: vi.fn(() => true),
    showKeyboard: vi.fn(), hideKeyboard: vi.fn()
});

describe('phone modifiers in isolated terminal renderers', () => {
    it('mirrors an armed modifier and clears it when accepted frame input consumes it', () => {
        const target = props();
        const view = render(<KeyBar {...target} />);
        const ctrl = view.getByTestId('terminal-key-ctrl-pane');
        fireEvent.click(ctrl);
        expect(target.setInputModifiers).toHaveBeenLastCalledWith({ ctrl: true, alt: false });
        expect(ctrl.getAttribute('aria-pressed')).toBe('true');

        fireEvent(target.captureRoot.current, new Event('kelpi-terminal-input'));
        expect(target.setInputModifiers).toHaveBeenLastCalledWith(released);
        expect(ctrl.getAttribute('aria-pressed')).toBe('false');
        expect(target.sendKey).not.toHaveBeenCalled();
        expect(target.showKeyboard).not.toHaveBeenCalled();
    });

    it('disarms the old renderer and ignores its input after moving to another target', () => {
        const oldTarget = props(), nextTarget = props();
        const view = render(<KeyBar {...oldTarget} />);
        fireEvent.click(view.getByTestId('terminal-key-alt-pane'));
        expect(oldTarget.setInputModifiers).toHaveBeenLastCalledWith({ ctrl: false, alt: true });

        view.rerender(<KeyBar {...nextTarget} />);
        expect(oldTarget.setInputModifiers).toHaveBeenLastCalledWith(released);
        expect(nextTarget.setInputModifiers).toHaveBeenLastCalledWith(released);
        const ctrl = view.getByTestId('terminal-key-ctrl-pane');
        fireEvent.click(ctrl);
        fireEvent(oldTarget.captureRoot.current, new Event('kelpi-terminal-input'));
        expect(ctrl.getAttribute('aria-pressed')).toBe('true');
        fireEvent(nextTarget.captureRoot.current, new Event('kelpi-terminal-input'));
        expect(ctrl.getAttribute('aria-pressed')).toBe('false');
    });

    it('clears the renderer when the phone bar unmounts', () => {
        const target = props();
        const view = render(<KeyBar {...target} />);
        fireEvent.click(view.getByTestId('terminal-key-ctrl-pane'));
        view.unmount();
        expect(target.setInputModifiers).toHaveBeenLastCalledWith(released);
    });
});

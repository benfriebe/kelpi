import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DESTRUCTIVE_COLOR,
    QUIT_GATE_GLOBAL,
    QUIT_GATE_VERSION,
    QuitConfirmDialog,
    QuitGate,
    installQuitGate,
    normalizeQuitGateSpec,
    type QuitGateHost,
    type QuitGateSpec,
    type QuitGateVerdict
} from './QuitConfirmDialog';

/** Exactly what `shell/src/settings.ts` `quitDialogSpec` produces. */
const SPEC: QuitGateSpec = {
    message: 'Quit Kelpi?',
    detail: '1 agent across 1 workspace is still active. They keep running in the background.',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: "Don't ask again",
    checkboxChecked: false
};

function hexToRgb(hex: string): string {
    const value = Number.parseInt(hex.replace('#', ''), 16);
    return `rgb(${String((value >> 16) & 0xff)}, ${String((value >> 8) & 0xff)}, ${String(value & 0xff)})`;
}

afterEach(cleanup);

describe('QuitConfirmDialog (§AGNT-116)', () => {
    it('paints Quit destructive and makes Cancel the default, focused button', () => {
        render(<QuitConfirmDialog spec={SPEC} onAnswer={vi.fn()} />);
        const quit = screen.getByTestId('quit-confirm');
        const cancel = screen.getByTestId('quit-cancel');

        // The half `dialog.showMessageBox` cannot do at all.
        expect(quit.textContent).toBe('Quit');
        // jsdom normalises a hex colour to rgb(); compare on the same footing.
        expect(quit.style.color).toBe(hexToRgb(DESTRUCTIVE_COLOR));
        expect(quit.getAttribute('data-destructive')).toBe('true');

        // …and the half it can: Cancel is the default, so Return is the safe answer.
        expect(cancel.textContent).toBe('Cancel');
        expect(cancel.getAttribute('data-default')).toBe('true');
        expect(cancel.getAttribute('data-destructive')).toBe('false');
        expect(document.activeElement).toBe(cancel);
    });

    it('reports the index of the button that was clicked', () => {
        const onAnswer = vi.fn();
        render(<QuitConfirmDialog spec={SPEC} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByTestId('quit-confirm'));
        expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ response: 0, checkboxChecked: false });
    });

    it('answers Cancel on Escape, and the default on Return', () => {
        const escape = vi.fn();
        const view = render(<QuitConfirmDialog spec={SPEC} onAnswer={escape} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(escape).toHaveBeenCalledExactlyOnceWith({ response: 1, checkboxChecked: false });
        view.unmount();

        const enter = vi.fn();
        render(<QuitConfirmDialog spec={SPEC} onAnswer={enter} />);
        fireEvent.keyDown(window, { key: 'Enter' });
        expect(enter).toHaveBeenCalledExactlyOnceWith({ response: 1, checkboxChecked: false });
    });

    it('carries the suppression checkbox out on either button (§10 step 4)', () => {
        const onAnswer = vi.fn();
        render(<QuitConfirmDialog spec={SPEC} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByTestId('quit-suppress'));
        fireEvent.click(screen.getByTestId('quit-cancel'));
        expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ response: 1, checkboxChecked: true });
    });

    it('answers once, however many times it is clicked', () => {
        const onAnswer = vi.fn();
        render(<QuitConfirmDialog spec={SPEC} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByTestId('quit-confirm'));
        fireEvent.click(screen.getByTestId('quit-cancel'));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onAnswer).toHaveBeenCalledTimes(1);
    });
});

describe('normalizeQuitGateSpec', () => {
    it('reads the shell’s spec', () => {
        expect(normalizeQuitGateSpec(JSON.parse(JSON.stringify(SPEC)))).toEqual(SPEC);
    });

    it('falls back to the SAFE button whenever an index is missing or out of range', () => {
        const spec = normalizeQuitGateSpec({ buttons: ['Quit', 'Cancel'], defaultId: 9, cancelId: -2 });
        // Both default to the last button, which is Cancel — a dialog whose Return quits is
        // exactly the accident this gate exists to prevent.
        expect(spec).toMatchObject({ defaultId: 1, cancelId: 1 });
    });

    it('refuses a request it cannot render (no buttons, not an object)', () => {
        expect(normalizeQuitGateSpec({ buttons: [] })).toBeNull();
        expect(normalizeQuitGateSpec(null)).toBeNull();
        expect(normalizeQuitGateSpec('quit')).toBeNull();
    });
});

describe('the page-side gate the shell drives', () => {
    it('installs a versioned global and restores the scope on uninstall', () => {
        const scope: QuitGateHost = {};
        const uninstall = installQuitGate({
            scope,
            onOpen: async () => ({ response: 1, checkboxChecked: false }),
            onDismiss: () => undefined
        });
        const gate = scope[QUIT_GATE_GLOBAL] as { version: number; open: unknown; dismiss: unknown };
        expect(gate.version).toBe(QUIT_GATE_VERSION);
        expect(typeof gate.open).toBe('function');
        expect(typeof gate.dismiss).toBe('function');
        uninstall();
        expect(scope[QUIT_GATE_GLOBAL]).toBeUndefined();
    });

    it('returns null for a request it cannot read, so the shell falls back to its own dialog', async () => {
        const scope: QuitGateHost = {};
        const onOpen = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
        installQuitGate({ scope, onOpen, onDismiss: () => undefined });
        const gate = scope[QUIT_GATE_GLOBAL] as { open: (raw: unknown) => Promise<unknown> };
        await expect(gate.open({ buttons: [] })).resolves.toBeNull();
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('opens the dialog on request and resolves the shell’s promise with the answer', async () => {
        const scope: QuitGateHost = {};
        render(<QuitGate scope={scope} />);
        expect(screen.queryByTestId('quit-dialog')).toBeNull();

        const gate = scope[QUIT_GATE_GLOBAL] as { open: (raw: unknown) => Promise<QuitGateVerdict | null> };
        let verdict: QuitGateVerdict | null = null;
        await act(async () => {
            void gate.open(SPEC).then((value) => {
                verdict = value;
            });
        });
        expect(screen.getByTestId('quit-dialog')).toBeTruthy();

        await act(async () => {
            fireEvent.click(screen.getByTestId('quit-confirm'));
        });
        expect(verdict).toEqual({ response: 0, checkboxChecked: false });
        expect(screen.queryByTestId('quit-dialog')).toBeNull();
    });

    it('dismiss closes the dialog and answers Cancel, so a timed-out shell is not left waiting', async () => {
        const scope: QuitGateHost = {};
        render(<QuitGate scope={scope} />);
        const gate = scope[QUIT_GATE_GLOBAL] as {
            open: (raw: unknown) => Promise<QuitGateVerdict | null>;
            dismiss: () => void;
        };
        let verdict: QuitGateVerdict | null = null;
        await act(async () => {
            void gate.open(SPEC).then((value) => {
                verdict = value;
            });
        });
        expect(screen.getByTestId('quit-dialog')).toBeTruthy();

        await act(async () => {
            gate.dismiss();
        });
        expect(screen.queryByTestId('quit-dialog')).toBeNull();
        expect(verdict).toEqual({ response: SPEC.cancelId, checkboxChecked: false });
    });
});

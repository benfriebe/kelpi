/**
 * The alert dialogs' density pack — `docs/SPACING-REVIEW.md` S53.
 *
 * `QuitGate.swift:81-105` is an `NSAlert`, and the macOS push button it stands in for is ≥20 pt
 * tall with ~10 pt of side padding and a ~68 pt minimum width. The port wrote `rounded px-2 py-1`
 * on a `<button>` and supplied only the border inline, so before S1 landed the ring survived and
 * the padding did not: `Quit` measured 25.59 × 18.8 and `Cancel` 40.82 × 18.8, the default's
 * accent ring drawn hard against the "C" and the "l" — two sub-20 px hit targets in the most
 * consequential dialog in the app. S1 restored the class padding (→ 41.59 / 56.82 × 26.8); this
 * pack pins the two halves it did not deliver: the 12 px gutter and the 68 px floor.
 *
 * The graft swap prompt reuses the recipe byte-for-byte (`GraftControls.tsx:341,356`), which is
 * why it is asserted here beside it rather than left to drift on its own.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraftOrphanBanner } from './GraftControls';
import { QuitConfirmDialog, type QuitGateSpec } from './QuitConfirmDialog';

afterEach(cleanup);

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

describe('S53 — the quit dialog’s push buttons', () => {
    it('takes AppKit’s ~10 pt side gutter, not 8', () => {
        render(<QuitConfirmDialog spec={SPEC} onAnswer={vi.fn()} />);
        for (const id of ['quit-confirm', 'quit-cancel']) {
            const button = screen.getByTestId(id);
            expect(button.className).toContain('px-3');
            expect(button.className).toContain('py-1');
            // The ring is inline (it always survived); the box is a class (it did not).
            expect(button.style.border).not.toBe('');
        }
    });

    it('holds AppKit’s ~68 pt minimum width, which 41.59 / 56.82 px did not', () => {
        render(<QuitConfirmDialog spec={SPEC} onAnswer={vi.fn()} />);
        for (const id of ['quit-confirm', 'quit-cancel']) {
            expect(screen.getByTestId(id).className).toContain('min-w-[68px]');
        }
    });

    it('leaves the answer wiring alone — this row is a box, not a behaviour', () => {
        const onAnswer = vi.fn();
        render(<QuitConfirmDialog spec={SPEC} onAnswer={onAnswer} />);
        // The default is still Cancel, still focused, still the safe answer for Return.
        expect(screen.getByTestId('quit-cancel').dataset['default']).toBe('true');
        expect(document.activeElement).toBe(screen.getByTestId('quit-cancel'));
        expect(screen.getByTestId('quit-confirm').dataset['destructive']).toBe('true');
    });
});

/**
 * S5 — the interrupted-graft banner's answers, closed to the row's own number.
 *
 * S1's keystone gave this pair back the border and the 11 px type their class list had always
 * declared (live, before: 46.44 × 18.2 with `padding: 0px` and `border-top-width: 0px` — §L102's
 * "the two answers are the SAME outline button" shipping as two bare words 6 px apart). It left
 * the box at `px-1.5 py-[1px]`, i.e. 1 px of vertical inset on a control the Swift draws as a
 * `.controlSize(.small)` bordered `Button` (`GraftInspectorButton.swift:105-114`), ~20 pt tall.
 * The row asks for `padding: '2px 8px'`; this pins it, and pins that the pair stays identical.
 */
describe('S5 — the graft orphan banner’s Restore / Dismiss pair', () => {
    const orphan = {
        associationID: '11111111-1111-4111-8111-111111111111',
        parentRepoRoot: '/work/repo',
        worktreePath: '/work/wt',
        branch: 'feature'
    };

    it('takes the row’s 2 px / 8 px box, not the class list’s 1 px / 6 px', () => {
        render(<GraftOrphanBanner orphan={orphan} onRestore={vi.fn()} onDismiss={vi.fn()} />);
        for (const id of [`graft-orphan-restore-${orphan.associationID}`, `graft-orphan-dismiss-${orphan.associationID}`]) {
            const button = screen.getByTestId(id);
            expect(button.className).toContain('px-2 ');
            expect(button.className).toContain('py-0.5');
            expect(button.className).not.toContain('px-1.5');
            expect(button.className).not.toContain('py-[1px]');
            // The border is a CLASS here (`border`), and only paints because S1 is layered.
            expect(button.className).toContain('border');
            expect(button.style.borderColor).not.toBe('');
        }
    });

    it('keeps L102’s equality — one recipe drawn twice', () => {
        render(<GraftOrphanBanner orphan={orphan} onRestore={vi.fn()} onDismiss={vi.fn()} />);
        const restore = screen.getByTestId(`graft-orphan-restore-${orphan.associationID}`);
        const dismiss = screen.getByTestId(`graft-orphan-dismiss-${orphan.associationID}`);
        expect(restore.className).toBe(dismiss.className);
    });
});

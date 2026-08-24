/**
 * Graft's chrome, rendered: the toggle's icon swap and status dot, where the toggle is allowed
 * to appear at all, the interrupted-graft banner's scoping, and the swap dialog's copy.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Inspector, type InspectorAssociation } from './Inspector';
import { GRAFT_DOT_COLORS } from './GraftControls';
import type { ChromeWorkspace } from './types';
import type { GraftOrphanView, GraftSessionView, GraftSwapPrompt } from '../state/graft';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const MAIN = 'CCCCCCCC-0000-4000-8000-00000000main'.slice(0, 36);
const WT = 'CCCCCCCC-0000-4000-8000-000000000002';

const workspace: ChromeWorkspace = {
    id: W1,
    name: 'alpha',
    slug: 'alpha',
    color: 'blue',
    icon: null,
    labels: [],
    panes: [],
    focusedPaneID: null
} as unknown as ChromeWorkspace;

function association(overrides: Partial<InspectorAssociation> = {}): InspectorAssociation {
    return {
        id: WT,
        repoID: 'BBBBBBBB-0000-4000-8000-000000000001',
        repoName: 'repo',
        repoPath: '/work/repo',
        worktreePath: '/work/wt',
        branch: 'feature',
        isWorktree: true,
        status: { kind: 'clean', changedFiles: 0, additions: 0, deletions: 0 },
        ...overrides
    };
}

function session(overrides: Partial<GraftSessionView> = {}): GraftSessionView {
    return {
        associationID: WT,
        worktreePath: '/work/wt',
        parentRepoRoot: '/work/repo',
        branch: 'feature',
        status: 'watching',
        error: null,
        lastSyncAt: null,
        ...overrides
    };
}

const MAIN_ROW = association({ id: MAIN, worktreePath: '/work/repo', branch: 'main', isWorktree: false });

/** jsdom normalizes an inline hex to `rgb(r, g, b)`; compare in the same currency. */
function rgbOf(hex: string): string {
    const value = Number.parseInt(hex.slice(1), 16);
    return `rgb(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)})`;
}

afterEach(cleanup);

describe('the toggle (§GIT-046, §GIT-047, §GIT-049)', () => {
    it('renders on a worktree row and NOT on the main-checkout row (§GIT-049)', () => {
        render(
            <Inspector
                workspace={workspace}
                associations={[MAIN_ROW, association()]}
                onToggleGraft={vi.fn()}
            />
        );
        expect(screen.getByTestId(`graft-toggle-${WT}`)).toBeTruthy();
        expect(screen.queryByTestId(`graft-toggle-${MAIN}`)).toBeNull();
    });

    it('swaps the glyph once a session exists (§GIT-046)', () => {
        const { rerender } = render(
            <Inspector workspace={workspace} associations={[association()]} onToggleGraft={vi.fn()} />
        );
        expect(screen.getByTestId(`graft-toggle-${WT}`).querySelector('[data-icon]')?.getAttribute('data-icon')).toBe(
            'graft'
        );
        rerender(
            <Inspector
                workspace={workspace}
                associations={[association()]}
                graftSessions={{ [WT]: session() }}
                onToggleGraft={vi.fn()}
            />
        );
        expect(screen.getByTestId(`graft-toggle-${WT}`).querySelector('[data-icon]')?.getAttribute('data-icon')).toBe(
            'graft-active'
        );
    });

    it('paints the dot per status, and pulses ONLY while syncing (§GIT-047)', () => {
        for (const status of ['starting', 'syncing', 'watching', 'error'] as const) {
            cleanup();
            render(
                <Inspector
                    workspace={workspace}
                    associations={[association()]}
                    graftSessions={{ [WT]: session({ status, error: status === 'error' ? 'boom' : null }) }}
                    onToggleGraft={vi.fn()}
                />
            );
            const dot = screen.getByTestId(`graft-dot-${WT}`);
            expect(dot.getAttribute('data-status')).toBe(status);
            expect(dot.style.background).toBe(rgbOf(GRAFT_DOT_COLORS[status]));
            const animated = dot.style.animation.includes('nex-graft-pulse');
            expect(animated).toBe(status === 'syncing');
        }
        // The two yellows are the same colour — the pulse is what distinguishes them.
        expect(GRAFT_DOT_COLORS.starting).toBe(GRAFT_DOT_COLORS.syncing);
    });

    it('has no dot at all with no session, and carries the explainer tooltip (§GIT-048)', () => {
        render(<Inspector workspace={workspace} associations={[association()]} onToggleGraft={vi.fn()} />);
        expect(screen.queryByTestId(`graft-dot-${WT}`)).toBeNull();
        expect(screen.getByTestId(`graft-toggle-${WT}`).getAttribute('title')).toContain(
            "Mirror feature's tracked files into the parent repo's working tree"
        );
    });

    it('reports the toggled association back to the host', () => {
        const onToggle = vi.fn();
        render(<Inspector workspace={workspace} associations={[association()]} onToggleGraft={onToggle} />);
        fireEvent.click(screen.getByTestId(`graft-toggle-${WT}`));
        expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: WT, worktreePath: '/work/wt' }));
    });
});

describe('the orphan banner (§GIT-051 / §WS-145)', () => {
    const orphan: GraftOrphanView = {
        associationID: WT,
        parentRepoRoot: '/work/repo',
        worktreePath: '/work/wt',
        branch: 'feature'
    };

    it('shows above the repo list, naming the parent repo’s folder, with Restore and Dismiss', () => {
        const onRestore = vi.fn();
        const onDismiss = vi.fn();
        render(
            <Inspector
                workspace={workspace}
                associations={[association()]}
                graftOrphans={[orphan]}
                onRestoreGraftOrphan={onRestore}
                onDismissGraftOrphan={onDismiss}
            />
        );
        const banner = screen.getByTestId(`graft-orphan-${WT}`);
        expect(banner.textContent).toContain('Graft was interrupted');
        expect(banner.textContent).toContain('repo');
        fireEvent.click(screen.getByTestId(`graft-orphan-restore-${WT}`));
        fireEvent.click(screen.getByTestId(`graft-orphan-dismiss-${WT}`));
        expect(onRestore).toHaveBeenCalledWith(orphan);
        expect(onDismiss).toHaveBeenCalledWith(orphan);
    });

    it('stays hidden for an orphan whose worktree this workspace does not associate', () => {
        render(
            <Inspector
                workspace={workspace}
                associations={[association()]}
                graftOrphans={[{ ...orphan, worktreePath: '/elsewhere/wt' }]}
            />
        );
        expect(screen.queryByTestId(`graft-orphan-${WT}`)).toBeNull();
    });
});

describe('the swap dialog (§GIT-050 / §WS-144)', () => {
    const prompt: GraftSwapPrompt = {
        associationID: WT,
        newBranch: 'feature',
        newWorktreePath: '/work/wt',
        existingSessionID: 'CCCCCCCC-0000-4000-8000-000000000003',
        existingBranch: 'other',
        existingWorktreePath: '/work/other',
        parentRepoRoot: '/work/repo'
    };

    it('is titled after the contested repo and names both sides', () => {
        render(
            <Inspector workspace={workspace} associations={[association()]} graftSwapPrompt={prompt} />
        );
        const dialog = screen.getByTestId('graft-swap-dialog');
        expect(dialog.getAttribute('aria-label')).toBe('Already grafting into repo');
        expect(dialog.textContent).toContain('other (other) is already grafting into this repository');
        expect(dialog.textContent).toContain('Swap to mirror feature (wt) instead');
    });

    it('confirms with the prompt, and cancels from the button, the backdrop and Escape', () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        render(
            <Inspector
                workspace={workspace}
                associations={[association()]}
                graftSwapPrompt={prompt}
                onConfirmGraftSwap={onConfirm}
                onCancelGraftSwap={onCancel}
            />
        );
        fireEvent.click(screen.getByTestId('graft-swap-confirm'));
        expect(onConfirm).toHaveBeenCalledWith(prompt);

        fireEvent.click(screen.getByTestId('graft-swap-keep'));
        fireEvent.click(screen.getByTestId('graft-swap-backdrop'));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(3);
    });

    it('is absent while nothing is contested', () => {
        render(<Inspector workspace={workspace} associations={[association()]} />);
        expect(screen.queryByTestId('graft-swap-dialog')).toBeNull();
    });

    /**
     * UI-FIDELITY M57 — `WorkspaceListView.swift:246-262` is a `.confirmationDialog` with two
     * real `Button`s (`role: .destructive` / `role: .cancel`), which AppKit draws with padding, a
     * border, a radius, a focused default and a Return binding. The port's were bare coloured
     * text with nothing focused, while `QuitConfirmDialog.tsx:299-330` — the app's own other
     * dialog — already did it properly; this is that pattern, including its rule about which
     * button is the default (the SAFE one, so a stray Return cannot stop a running graft).
     */
    describe('its answers are buttons, and Return takes the safe one (M57)', () => {
        function open(onConfirm = vi.fn(), onCancel = vi.fn()) {
            render(
                <Inspector
                    workspace={workspace}
                    associations={[association()]}
                    graftSwapPrompt={prompt}
                    onConfirmGraftSwap={onConfirm}
                    onCancelGraftSwap={onCancel}
                />
            );
            return { onConfirm, onCancel };
        }

        it('both answers are boxed controls, and only the swap is destructive', () => {
            open();
            const keep = screen.getByTestId('graft-swap-keep');
            const swap = screen.getByTestId('graft-swap-confirm');
            for (const button of [keep, swap]) {
                expect(button.className).toContain('rounded');
                expect(button.className).toContain('px-2');
                expect(button.className).toContain('py-1');
                expect(button.style.border).not.toBe('');
            }
            expect(keep.dataset['destructive']).toBe('false');
            expect(swap.dataset['destructive']).toBe('true');
            // rgb, because jsdom normalises the hex. The shared DESTRUCTIVE_COLOR.
            expect(swap.style.color).toBe('rgb(224, 101, 92)');
        });

        it('the default is "Keep existing": it holds focus and it is the one ringed', () => {
            open();
            const keep = screen.getByTestId('graft-swap-keep');
            expect(keep.dataset['default']).toBe('true');
            expect(screen.getByTestId('graft-swap-confirm').dataset['default']).toBe('false');
            expect(document.activeElement).toBe(keep);
            expect(keep.style.border).toContain('var(--nex-accent');
            expect(keep.style.background).not.toBe('');
        });

        it('Return answers it, and answers it SAFELY — a stray keystroke never swaps', () => {
            const { onConfirm, onCancel } = open();
            fireEvent.keyDown(window, { key: 'Enter' });
            expect(onCancel).toHaveBeenCalledTimes(1);
            expect(onConfirm).not.toHaveBeenCalled();
        });
    });
});

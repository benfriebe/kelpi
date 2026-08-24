/**
 * §H12 — the inspector's three sheets are modal, like the `.sheet()` they port.
 *
 * `RepoPickerView.swift:100-102` presents them through SwiftUI's `.sheet()`: system-dimmed,
 * app-modal, click-through blocked. The port drew the panel alone — `createPortal(<div className=
 * "fixed left-1/2 top-1/4 z-50 …">)` with no `inset-0` wrapper and no `onMouseDown` cancel — so
 * the window behind stayed fully lit and fully interactive, while the two sheets that DO get it
 * right (`SettingsOverlay`'s 0.62 scrim, `NewWorkspaceSheet`'s 0.45) sat two files away.
 *
 * All three sheets share one `Sheet` shell, so the contract is asserted once per sheet on the
 * things that differ (which callback the backdrop runs) and once on the shell itself.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Inspector, modalPresenceCount } from './index';
import type { InspectorAssociation, InspectorProps, InspectorRepo } from './index';
import type { ChromePane, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';

function pane(id: string): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: 'zsh',
        workingDirectory: '/src/app',
        gitBranch: 'main',
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function workspace(): ChromeWorkspace {
    return { id: W1, name: 'alpha', color: 'blue', icon: null, labels: [], panes: [pane('p1')] };
}

const REPOS: InspectorRepo[] = [
    { id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/Users/t/nex/worktrees/app' },
    { id: 'r2', name: 'infra', path: '/src/infra', worktreeBase: '/Users/t/nex/worktrees/infra' }
];

const ASSOCIATION: InspectorAssociation = {
    id: 'a-main',
    repoID: 'r1',
    repoName: 'app',
    repoPath: '/src/app',
    worktreePath: '/src/app',
    branch: 'main',
    isWorktree: false,
    status: { kind: 'clean', changedFiles: 0, additions: 0, deletions: 0 }
};

function view(props: Partial<InspectorProps> = {}): void {
    render(
        <Inspector
            workspace={workspace()}
            focusedPaneID="p1"
            associations={[ASSOCIATION]}
            repos={REPOS}
            {...props}
        />
    );
}

function openAddRepo(): void {
    fireEvent.click(screen.getByTestId('inspector-add-repo'));
    fireEvent.click(screen.getByText('Add Repository…'));
}

function openRepoPicker(): void {
    render(
        <Inspector
            workspace={workspace()}
            focusedPaneID="p1"
            associations={[]}
            repos={REPOS}
            onCreateWorktree={vi.fn()}
        />
    );
    fireEvent.click(screen.getByTestId('inspector-add-repo'));
    fireEvent.click(screen.getByText('New Worktree…'));
}

describe('the sheet shell (§H12)', () => {
    it('draws a scrim over the whole window, and claims to be modal', () => {
        view({ onAddAssociation: vi.fn() });
        openAddRepo();

        const backdrop = screen.getByTestId('add-repo-sheet-backdrop');
        const sheet = screen.getByTestId('add-repo-sheet');
        expect(backdrop.contains(sheet)).toBe(true);
        expect(backdrop.className).toContain('inset-0');
        // `NewWorkspaceSheet`'s dimming, deliberately the same value.
        expect(backdrop.style.background).toBe('rgba(0, 0, 0, 0.45)');
        expect(sheet.getAttribute('aria-modal')).toBe('true');
        expect(sheet.getAttribute('role')).toBe('dialog');
    });

    it('a mousedown on the scrim cancels', () => {
        view({ onAddAssociation: vi.fn() });
        openAddRepo();
        fireEvent.mouseDown(screen.getByTestId('add-repo-sheet-backdrop'));
        expect(screen.queryByTestId('add-repo-sheet')).toBeNull();
    });

    it('a mousedown INSIDE the panel does not — including a drag that ends on the scrim', () => {
        view({ onAddAssociation: vi.fn() });
        openAddRepo();
        const sheet = screen.getByTestId('add-repo-sheet');
        fireEvent.mouseDown(sheet);
        expect(screen.getByTestId('add-repo-sheet')).toBeTruthy();

        /*
         * The rule is `target === currentTarget`, not "the backdrop was in the path": a press on
         * a control INSIDE the panel bubbles up to the backdrop too, and dismissing on that
         * would make the sheet close as soon as anybody clicked its own text field.
         */
        fireEvent.mouseDown(within(sheet).getByTestId('add-repo-path'));
        expect(screen.getByTestId('add-repo-sheet')).toBeTruthy();
    });

    it('parks a live web pane while it is up (§H1)', () => {
        expect(modalPresenceCount()).toBe(0);
        view({ onAddAssociation: vi.fn() });
        openAddRepo();
        expect(modalPresenceCount()).toBe(1);
        fireEvent.mouseDown(screen.getByTestId('add-repo-sheet-backdrop'));
        expect(modalPresenceCount()).toBe(0);
    });
});

describe('each sheet cancels through its own path', () => {
    it('the repo picker', () => {
        openRepoPicker();
        expect(screen.getByTestId('repo-picker-sheet')).toBeTruthy();
        fireEvent.mouseDown(screen.getByTestId('repo-picker-sheet-backdrop'));
        expect(screen.queryByTestId('repo-picker-sheet')).toBeNull();
    });

    it('the create-worktree sheet', () => {
        view({ onCreateWorktree: vi.fn() });
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('New Worktree…'));
        expect(screen.getByTestId('worktree-sheet')).toBeTruthy();
        fireEvent.mouseDown(screen.getByTestId('worktree-sheet-backdrop'));
        expect(screen.queryByTestId('worktree-sheet')).toBeNull();
    });
});

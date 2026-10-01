/**
 * The sidebar delete dialog's "Also remove worktrees" list (graft-git.md §8.7).
 *
 * The daemon's plan decides what is offered; the dialog renders it, starts with the clean
 * worktrees Kelpi made ticked, never lets a blocked one be ticked, and hands the choice to the
 * delete. A dialog with no list passes nothing, so a callback written before the list existed
 * sees the arguments it always did.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromeSidebarEntry, ChromeWorkspace } from './types';
import type { WorktreeCleanupCandidate, WorktreeCleanupSource } from './WorktreeCleanupList';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';

function workspace(id: string, name: string): ChromeWorkspace {
    return {
        id,
        name,
        color: 'blue',
        icon: null,
        labels: [],
        panes: [
            {
                id: `${id}-p1`,
                type: 'shell',
                label: null,
                title: null,
                workingDirectory: '/Users/test/code',
                gitBranch: null,
                status: 'idle',
                agentSessionID: null,
                agentKind: null,
                agentStartedAt: null,
                backgroundTaskCount: 0
            }
        ]
    };
}

const entries: ChromeSidebarEntry[] = [
    { kind: 'workspace', workspace: workspace(W1, 'alpha') },
    { kind: 'workspace', workspace: workspace(W2, 'beta') }
];

const FEATURE: WorktreeCleanupCandidate = {
    worktreePath: '/Users/test/kelpi/worktrees/app/feature',
    repoPath: '/Users/test/code/app',
    branch: 'feature',
    managed: true,
    changedFiles: 0,
    commitsOnlyHere: 0,
    blocked: null,
    forceable: false,
    recommended: true,
    branchDeletable: true
};
const AGENT: WorktreeCleanupCandidate = {
    ...FEATURE,
    worktreePath: '/Users/test/code/app/.claude/worktrees/agent',
    branch: 'agent/x',
    managed: false,
    commitsOnlyHere: 3,
    recommended: false,
    branchDeletable: false
};
const BUSY: WorktreeCleanupCandidate = {
    ...FEATURE,
    worktreePath: '/Users/test/kelpi/worktrees/app/busy',
    branch: 'busy',
    changedFiles: 2,
    blocked: { kind: 'dirty', reason: 'has 2 uncommitted changes' },
    forceable: true,
    recommended: false,
    branchDeletable: true
};
const SHARED: WorktreeCleanupCandidate = {
    ...FEATURE,
    worktreePath: '/Users/test/kelpi/worktrees/app/shared',
    branch: 'shared',
    blocked: { kind: 'shared', reason: 'also used by workspace "beta"' },
    recommended: false,
    branchDeletable: false
};

function source(candidates: readonly WorktreeCleanupCandidate[] | null, overrides: Partial<WorktreeCleanupSource> = {}) {
    const remember = vi.fn();
    const preview = vi.fn(() => (candidates === null ? null : Promise.resolve(candidates)));
    return { preview, remember, home: '/Users/test', deleteBranchesDefault: true, ...overrides } satisfies WorktreeCleanupSource;
}

function openDelete(): void {
    fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
    fireEvent.click(screen.getByText('Delete'));
}

describe('delete dialog worktree list', () => {
    it("lists the plan, ticks the clean Kelpi ones, and hands the choice to the delete", async () => {
        const onDelete = vi.fn();
        const worktrees = source([FEATURE, AGENT, BUSY, SHARED]);
        render(<Sidebar entries={entries} activeWorkspaceID={W1} filter="" onFilterChange={() => undefined} onDeleteWorkspace={onDelete} worktreeCleanup={worktrees} />);
        openDelete();

        await waitFor(() => expect(screen.getByTestId('worktree-cleanup')).toBeTruthy());
        expect(worktrees.preview).toHaveBeenCalledWith({ workspaceIDs: [W1] });
        const rows = screen.getAllByTestId('worktree-cleanup-row');
        // Name first, the branch only when it differs, then where it lives, then what to weigh.
        const text = (testID: string) => rows.map((row) => row.querySelector(`[data-testid="${testID}"]`)?.textContent ?? null);
        expect(text('worktree-cleanup-name')).toEqual(['feature', 'agent', 'busy', 'shared']);
        expect(text('worktree-cleanup-branch')).toEqual([null, 'agent/x', null, null]);
        expect(text('worktree-cleanup-where')).toEqual(['~/kelpi/worktrees/app', '~/code/app/.claude/worktrees', '~/kelpi/worktrees/app', '~/kelpi/worktrees/app']);
        expect(text('worktree-cleanup-status')).toEqual([
            null,
            'Not created by Kelpi · 3 unpushed commits',
            '2 uncommitted changes',
            'Also used by workspace "beta"'
        ]);
        expect(rows[0]?.getAttribute('title')).toBe('~/kelpi/worktrees/app/feature');
        const checks = screen.getAllByTestId('worktree-cleanup-check') as HTMLInputElement[];
        expect(checks.map((check) => [check.checked, check.disabled])).toEqual([
            [true, false],
            [false, false],
            // Dirty only: may be ticked, never by default.
            [false, false],
            [false, true]
        ]);

        // Opting in to the dirty one says plainly what it costs.
        fireEvent.click(checks[2] as HTMLInputElement);
        expect(text('worktree-cleanup-status')[2]).toBe('2 uncommitted changes will be lost');
        fireEvent.click(screen.getByTestId('worktree-cleanup-branches'));
        fireEvent.click(screen.getByTestId('confirm-delete'));

        expect(onDelete).toHaveBeenCalledWith(W1, { candidates: [FEATURE, BUSY], deleteBranches: false });
        expect(worktrees.remember).not.toHaveBeenCalled();
    });

    it('"Remember my choice" writes the choice on Delete: remove when anything was ticked', async () => {
        const worktrees = source([FEATURE]);
        render(<Sidebar entries={entries} activeWorkspaceID={W1} filter="" onFilterChange={() => undefined} onDeleteWorkspace={vi.fn()} worktreeCleanup={worktrees} />);
        openDelete();
        await waitFor(() => expect(screen.getByTestId('worktree-cleanup')).toBeTruthy());
        fireEvent.click(screen.getByTestId('worktree-cleanup-remember'));
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(worktrees.remember).toHaveBeenCalledWith({ removeWorktrees: true, deleteBranches: true });
    });

    it('with nothing to ask, the delete gets no cleanup argument at all', () => {
        const onDelete = vi.fn();
        const worktrees = source(null, { automaticNote: () => 'Clean worktrees Kelpi created are removed too (Settings ▸ Workspaces).' });
        render(<Sidebar entries={entries} activeWorkspaceID={W1} filter="" onFilterChange={() => undefined} onDeleteWorkspace={onDelete} worktreeCleanup={worktrees} />);
        openDelete();
        expect(screen.queryByTestId('worktree-cleanup')).toBeNull();
        expect(screen.getByTestId('worktree-cleanup-note').textContent).toContain('removed too');
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(onDelete).toHaveBeenCalledWith(W1);
    });

    it('a delete confirmed before the plan arrives keeps every worktree', () => {
        const onDelete = vi.fn();
        const worktrees = source(null, { preview: () => new Promise(() => undefined) });
        render(<Sidebar entries={entries} activeWorkspaceID={W1} filter="" onFilterChange={() => undefined} onDeleteWorkspace={onDelete} worktreeCleanup={worktrees} />);
        openDelete();
        expect(screen.getByTestId('worktree-cleanup-loading')).toBeTruthy();
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(onDelete).toHaveBeenCalledWith(W1, null);
    });

    it('says so when the plan cannot be read', async () => {
        const worktrees = source(null, { preview: () => Promise.reject(new Error('daemon too old')) });
        render(<Sidebar entries={entries} activeWorkspaceID={W1} filter="" onFilterChange={() => undefined} onDeleteWorkspace={vi.fn()} worktreeCleanup={worktrees} />);
        openDelete();
        await waitFor(() => expect(screen.getByTestId('worktree-cleanup-error').textContent).toContain('daemon too old'));
    });

    it("a group's list applies to the cascade only; moving the workspaces out takes none", async () => {
        const G1 = 'bbbbbbbb-0000-4000-8000-000000000001';
        const grouped: ChromeSidebarEntry[] = [
            { kind: 'workspace', workspace: workspace(W2, 'beta') },
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: null, icon: null, isCollapsed: false, childOrder: [W1] },
                workspaces: [workspace(W1, 'alpha')]
            } as unknown as ChromeSidebarEntry
        ];
        const onDeleteGroup = vi.fn();
        const worktrees = source([FEATURE]);
        const view = render(<Sidebar entries={grouped} activeWorkspaceID={W2} filter="" onFilterChange={() => undefined} onDeleteGroup={onDeleteGroup} worktreeCleanup={worktrees} />);
        const openGroupDelete = async (): Promise<void> => {
            fireEvent.contextMenu(screen.getByTestId('group-header'));
            fireEvent.click(screen.getByText('Delete Group…'));
            await waitFor(() => expect(screen.getByTestId('worktree-cleanup')).toBeTruthy());
        };
        await openGroupDelete();
        expect(worktrees.preview).toHaveBeenCalledWith({ groupID: G1 });
        expect(within(screen.getByTestId('worktree-cleanup')).getByText('Only when the workspace is deleted too.')).toBeTruthy();
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(onDeleteGroup).toHaveBeenLastCalledWith(G1, false);

        await openGroupDelete();
        act(() => {
            fireEvent.click(screen.getByTestId('confirm-delete-cascade'));
        });
        expect(onDeleteGroup).toHaveBeenLastCalledWith(G1, true, { candidates: [FEATURE], deleteBranches: true });
        view.unmount();
    });
});

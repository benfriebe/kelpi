/**
 * #294: the New Workspace sheet while a worktree create runs (shell-ui.md §10.1).
 *
 * The daemon streams a whole step list per change; the sheet draws it as a checklist with a bar
 * where git printed a percentage, disables every field, turns Cancel into a real cancel of that
 * request, refuses a stray Escape or backdrop click with a hint instead of closing over a running
 * create, and on a failure or a cancel says which step it was and re-enables the form. It also
 * starts a background fetch of the repo the moment a worktree off latest main is on screen.
 *
 * Driven through `Sidebar`, which hosts the sheet on every route, so the host's plumbing of the
 * two new callbacks is part of what is tested.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewEntrySheet } from './NewWorkspaceSheet';
import { Sidebar } from './index';
import type { ChromeGroup, ChromeRepo, ChromeSidebarEntry, WorkspaceWorktreeRequest, WorktreeCreateProgress } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const REPOS: ChromeRepo[] = [
    { id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/wt/app' },
    { id: 'r2', name: 'infra', path: '/src/infra', worktreeBase: '/wt/infra' }
];

function entries(): ChromeSidebarEntry[] {
    return [
        {
            kind: 'workspace',
            workspace: {
                id: W1,
                name: 'alpha',
                color: 'blue',
                icon: null,
                labels: [],
                panes: [
                    {
                        id: `${W1}-p1`,
                        type: 'shell',
                        label: null,
                        title: null,
                        workingDirectory: '/src/app',
                        gitBranch: null,
                        status: 'idle',
                        agentSessionID: null,
                        agentKind: null,
                        agentStartedAt: null,
                        backgroundTaskCount: 0
                    }
                ]
            }
        }
    ];
}

interface Deferred {
    resolve(value: string | null): void;
    worktree: WorkspaceWorktreeRequest | undefined;
}

function open() {
    const pending: Deferred = { resolve: () => {}, worktree: undefined };
    const onCreateWorkspace = vi.fn().mockImplementation(
        (_name: string, _groupID: string | null, worktree: WorkspaceWorktreeRequest | undefined) =>
            new Promise<string | null>((resolve) => {
                pending.resolve = resolve;
                pending.worktree = worktree;
            })
    );
    const onPrefetchWorktreeRepo = vi.fn();
    const onCancelWorkspaceCreate = vi.fn();
    render(
        <Sidebar
            activeWorkspaceID={W1}
            filter=""
            onFilterChange={vi.fn()}
            rowHeight={20}
            entries={entries()}
            repos={REPOS}
            onCreateWorkspace={onCreateWorkspace as never}
            onPrefetchWorktreeRepo={onPrefetchWorktreeRepo}
            onCancelWorkspaceCreate={onCancelWorkspaceCreate}
        />
    );
    fireEvent.click(screen.getByTestId('sidebar-new-workspace'));
    return { pending, onCreateWorkspace, onPrefetchWorktreeRepo, onCancelWorkspaceCreate };
}

function chooseRepo(id: string): void {
    fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
    const picker = screen.getByTestId('new-workspace-repo-picker');
    fireEvent.click(within(picker).getByTestId(`repo-choice-${id}`));
    fireEvent.click(within(picker).getByTestId('repo-picker-choose'));
}

/** Name, repo, worktree on, update main ticked: ready to Create. */
function fillWorktree(): void {
    fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'Fix Login' } });
    chooseRepo('r1');
    fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
    fireEvent.click(screen.getByTestId('new-workspace-worktree-update-main'));
}

const steps = (): Record<string, string | null> =>
    Object.fromEntries(
        Array.from(document.querySelectorAll('[data-testid^="new-workspace-step-"][data-status]')).map((row) => [
            (row.getAttribute('data-testid') ?? '').slice('new-workspace-step-'.length),
            row.getAttribute('data-status')
        ])
    );

const fieldsDisabled = (): boolean => (screen.getByTestId('new-workspace-fields') as HTMLFieldSetElement).disabled;

function report(pending: Deferred, progress: WorktreeCreateProgress): void {
    act(() => {
        pending.worktree?.onProgress?.(progress);
    });
}

describe('prefetch while the sheet is open', () => {
    it('asks once for the repo when a worktree off latest main appears, and not without update main', () => {
        const h = open();
        chooseRepo('r1');
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        expect(h.onPrefetchWorktreeRepo).not.toHaveBeenCalled(); // update main is still off
        fireEvent.click(screen.getByTestId('new-workspace-worktree-update-main'));
        expect(h.onPrefetchWorktreeRepo).toHaveBeenCalledExactlyOnceWith('r1');
        // Toggling off and on again does not ask again in this opening.
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        expect(h.onPrefetchWorktreeRepo).toHaveBeenCalledTimes(1);
    });

    it('asks as soon as it opens when a group’s switch pre-ticks the worktree and update main', () => {
        const onPrefetchRepo = vi.fn();
        const group: ChromeGroup = { id: 'G1', name: 'team', color: null, icon: null, isCollapsed: false, repoID: 'r2', createWorktree: true };
        render(
            <NewEntrySheet
                kind="workspace"
                repos={REPOS}
                groups={[group]}
                defaultGroupID="G1"
                onPrefetchRepo={onPrefetchRepo}
                onSubmit={async () => null}
                onCancel={vi.fn()}
            />
        );
        expect(onPrefetchRepo).toHaveBeenCalledExactlyOnceWith('r2');
    });
});

describe('while a worktree create runs', () => {
    it('shows the checklist at once, disables the fields, and draws the daemon’s steps as they come', () => {
        const h = open();
        fillWorktree();
        fireEvent.click(screen.getByTestId('new-workspace-submit'));

        expect(h.pending.worktree?.requestID).toMatch(/.+/);
        expect(screen.getByTestId('new-workspace-progress').getAttribute('data-phase')).toBe('running');
        expect(steps()).toEqual({ 'resolve-default-branch': 'running', fetch: 'pending', 'worktree-add': 'pending', 'create-workspace': 'pending' });
        expect(fieldsDisabled()).toBe(true);
        expect(screen.getByTestId('new-workspace-submit').textContent).toBe('Creating…');
        expect(screen.getByTestId('new-workspace-cancel').textContent).toBe('Cancel');
        expect(screen.getByTestId('new-workspace-progress-elapsed').textContent).toMatch(/^\d+\.\d s$/);

        report(h.pending, {
            cancelled: false,
            steps: [
                { id: 'resolve-default-branch', status: 'done', detail: 'main (from origin/HEAD)' },
                { id: 'fetch', status: 'running', detail: 'origin/main', phase: 'Receiving objects', percent: 45 },
                { id: 'worktree-add', status: 'pending' },
                { id: 'create-workspace', status: 'pending' }
            ]
        });
        expect(steps()).toMatchObject({ 'resolve-default-branch': 'done', fetch: 'running' });
        const fetch = screen.getByTestId('new-workspace-step-fetch');
        expect(fetch.getAttribute('data-percent')).toBe('45');
        expect(within(fetch).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('45');
        expect(screen.getByTestId('new-workspace-step-fetch-phase').textContent).toBe('Receiving objects 45%');
        expect(screen.getByTestId('new-workspace-step-resolve-default-branch-detail').textContent).toBe('main (from origin/HEAD)');

        // A git step without a meter still moves: the indeterminate sweep.
        report(h.pending, {
            cancelled: false,
            steps: [
                { id: 'resolve-default-branch', status: 'done' },
                { id: 'fetch', status: 'skipped', detail: 'prefetched 5.0 s ago' },
                { id: 'worktree-add', status: 'running' },
                { id: 'create-workspace', status: 'pending' }
            ]
        });
        const add = screen.getByTestId('new-workspace-step-worktree-add');
        expect(within(add).getByRole('progressbar').getAttribute('aria-busy')).toBe('true');
        expect(screen.getByTestId('new-workspace-step-fetch-detail').textContent).toBe('prefetched 5.0 s ago');
    });

    it('closes on success, as it always did', async () => {
        const h = open();
        fillWorktree();
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await act(async () => {
            h.pending.resolve(null);
        });
        await waitFor(() => {
            expect(screen.queryByTestId('new-workspace-sheet')).toBeNull();
        });
    });

    it('Escape and the backdrop do not close it; they say how to stop it instead', () => {
        open();
        fillWorktree();
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
        expect(screen.getByTestId('new-workspace-progress-hint').textContent).toContain('Press Cancel');
        const backdrop = screen.getByTestId('new-workspace-sheet').parentElement as HTMLElement;
        fireEvent.mouseDown(backdrop);
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
    });

    it('Cancel cancels THAT request, then the form comes back with the cancel said plainly', async () => {
        const h = open();
        fillWorktree();
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        const requestID = h.pending.worktree?.requestID;
        fireEvent.click(screen.getByTestId('new-workspace-cancel'));
        expect(h.onCancelWorkspaceCreate).toHaveBeenCalledExactlyOnceWith(requestID);
        expect(screen.getByTestId('new-workspace-cancel').textContent).toBe('Cancelling…');
        expect((screen.getByTestId('new-workspace-cancel') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();

        report(h.pending, {
            cancelled: true,
            steps: [
                { id: 'resolve-default-branch', status: 'done' },
                { id: 'fetch', status: 'failed', error: 'cancelled' },
                { id: 'worktree-add', status: 'pending' },
                { id: 'create-workspace', status: 'pending' }
            ]
        });
        await act(async () => {
            h.pending.resolve('worktree create cancelled');
        });
        expect(screen.getByTestId('new-workspace-progress').getAttribute('data-phase')).toBe('cancelled');
        expect(screen.getByTestId('new-workspace-progress-headline').textContent).toBe('Cancelled');
        expect(screen.getByTestId('new-workspace-error').textContent).toBe('Create cancelled: nothing it made was kept.');
        expect(steps().fetch).toBe('failed');
        expect(fieldsDisabled()).toBe(false);
        expect(screen.getByTestId('new-workspace-cancel').textContent).toBe('Cancel');
        // Cancel is a plain close again now that nothing runs.
        fireEvent.click(screen.getByTestId('new-workspace-cancel'));
        expect(screen.queryByTestId('new-workspace-sheet')).toBeNull();
        expect(h.onCancelWorkspaceCreate).toHaveBeenCalledTimes(1);
    });

    it('a failure names the failed step, shows git’s message, and re-enables the form for a retry', async () => {
        const h = open();
        fillWorktree();
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        report(h.pending, {
            cancelled: false,
            steps: [
                { id: 'resolve-default-branch', status: 'done' },
                { id: 'fetch', status: 'pending' },
                { id: 'worktree-add', status: 'failed', error: "branch 'fix-login' already exists" },
                { id: 'create-workspace', status: 'pending' }
            ]
        });
        await act(async () => {
            h.pending.resolve("branch 'fix-login' already exists, and update main always creates a new branch off origin/main");
        });
        expect(screen.getByTestId('new-workspace-progress').getAttribute('data-phase')).toBe('failed');
        expect(steps()['worktree-add']).toBe('failed');
        expect(screen.getByTestId('new-workspace-error').textContent).toContain("branch 'fix-login' already exists");
        expect(fieldsDisabled()).toBe(false);
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
        // Retry with another branch name: a fresh request id and a fresh checklist.
        const first = h.pending.worktree?.requestID;
        fireEvent.change(screen.getByTestId('new-workspace-worktree-branch'), { target: { value: 'fix-login-2' } });
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        expect(h.pending.worktree?.requestID).not.toBe(first);
        expect(screen.getByTestId('new-workspace-progress').getAttribute('data-phase')).toBe('running');
        expect(screen.queryByTestId('new-workspace-error')).toBeNull();
    });

    it('a create without a worktree shows no checklist at all', () => {
        const h = open();
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'plain' } });
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        expect(h.onCreateWorkspace).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('new-workspace-progress')).toBeNull();
        expect(fieldsDisabled()).toBe(false);
    });

    it('without update main the checklist is just the worktree and the workspace', () => {
        open();
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'Fix Login' } });
        chooseRepo('r1');
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        expect(steps()).toEqual({ 'worktree-add': 'running', 'create-workspace': 'pending' });
    });
});

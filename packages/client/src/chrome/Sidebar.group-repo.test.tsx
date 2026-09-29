/**
 * A group's default repository (app-state-core.md §5.5), everywhere the sidebar shows it:
 *
 *   - the group menu's Repository ▸ (registered repos, Choose Folder… in the desktop app, None,
 *     and the "create a worktree from latest main" switch while a repo is set);
 *   - the New Workspace sheet's prefill (the repo, and the worktree toggle with update main
 *     ticked when the switch is on), which a Group change swaps until the user edits the repos;
 *   - the New Group sheet's optional repository and switch.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromeGroup, ChromePane, ChromeRepo, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const W3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const G_WORKTREE = 'cccccccc-0000-4000-8000-000000000001';
const G_ASSOCIATE = 'cccccccc-0000-4000-8000-000000000002';
const G_PLAIN = 'cccccccc-0000-4000-8000-000000000003';

const REPOS: ChromeRepo[] = [
    { id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/wt/app' },
    { id: 'r2', name: 'infra', path: '/src/infra', worktreeBase: '/wt/infra' }
];

function pane(id: string): ChromePane {
    return {
        id,
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
    };
}

function workspace(id: string, name: string): ChromeWorkspace {
    return { id, name, color: 'blue', icon: null, labels: [], panes: [pane(`${id}-p1`)] };
}

function group(id: string, name: string, extra: Partial<ChromeGroup> = {}): ChromeGroup {
    return { id, name, color: null, icon: null, isCollapsed: false, ...extra };
}

/** app[w1] with its switch on · infra[w2] associate-only · plain[w3] with no repo. */
function entries(overrides: { worktree?: Partial<ChromeGroup> } = {}): ChromeSidebarEntry[] {
    return [
        {
            kind: 'group',
            group: group(G_WORKTREE, 'app-team', { repoID: 'r1', createWorktree: true, ...overrides.worktree }),
            workspaces: [workspace(W1, 'alpha')]
        },
        {
            kind: 'group',
            group: group(G_ASSOCIATE, 'infra-team', { repoID: 'r2', createWorktree: false }),
            workspaces: [workspace(W2, 'beta')]
        },
        { kind: 'group', group: group(G_PLAIN, 'plain'), workspaces: [workspace(W3, 'gamma')] }
    ];
}

function base() {
    return { activeWorkspaceID: W1, filter: '', onFilterChange: vi.fn(), rowHeight: 20 };
}

function header(name: string): HTMLElement {
    const found = screen.getAllByTestId('group-header').find((candidate) => (candidate.textContent ?? '').includes(name));
    if (found === undefined) throw new Error(`no group header for ${name}`);
    return found;
}

function openRepositoryMenu(groupName: string): HTMLElement {
    fireEvent.contextMenu(header(groupName));
    fireEvent.mouseEnter(within(screen.getByTestId('context-menu')).getByText('Repository'));
    return screen.getByTestId('context-submenu');
}

function newWorkspaceFrom(groupName: string): void {
    fireEvent.contextMenu(header(groupName));
    fireEvent.click(within(screen.getByTestId('context-menu')).getByText('New Workspace'));
}

const toggle = (): HTMLInputElement | null =>
    screen.queryByTestId('new-workspace-worktree-toggle') as HTMLInputElement | null;
const updateMain = (): HTMLInputElement | null =>
    screen.queryByTestId('new-workspace-worktree-update-main') as HTMLInputElement | null;
const chosenRepos = (): string[] =>
    [...screen.getByTestId('new-workspace-repos').querySelectorAll('[data-testid^="new-workspace-repo-remove-"]')].map(
        (element) => (element.getAttribute('data-testid') ?? '').slice('new-workspace-repo-remove-'.length)
    );

describe('the group menu’s Repository ▸ (§5.5)', () => {
    it('lists the registry with the current repo ticked, then Choose Folder…, None and the switch', () => {
        const onSetGroupRepo = vi.fn();
        render(
            <Sidebar
                {...base()}
                entries={entries()}
                repos={REPOS}
                onSetGroupRepo={onSetGroupRepo}
                onBrowseForFolder={vi.fn()}
            />
        );
        const submenu = openRepositoryMenu('app-team');
        const ids = [...submenu.querySelectorAll('[data-menu-item]')].map((row) => row.getAttribute('data-menu-item'));
        expect(ids).toEqual(['repo:r1', 'repo:r2', 'repo:choose', 'repo:none', 'repo:worktree']);
        expect(submenu.querySelector('[data-menu-item="repo:r1"]')?.getAttribute('data-checked')).toBe('true');
        expect(submenu.querySelector('[data-menu-item="repo:none"]')?.getAttribute('data-checked')).not.toBe('true');

        const worktree = submenu.querySelector('[data-menu-item="repo:worktree"]') as HTMLElement;
        expect(worktree.getAttribute('role')).toBe('menuitemcheckbox');
        expect(worktree.getAttribute('aria-checked')).toBe('true');
        expect((worktree.textContent ?? '').trim()).toBe('New workspaces create a worktree from latest main');

        fireEvent.click(within(submenu).getByText('infra'));
        expect(onSetGroupRepo).toHaveBeenLastCalledWith(G_WORKTREE, { repoPath: '/src/infra' });
    });

    it('flips the switch in place, sending the opposite state', () => {
        const onSetGroupRepo = vi.fn();
        render(<Sidebar {...base()} entries={entries()} repos={REPOS} onSetGroupRepo={onSetGroupRepo} />);
        const submenu = openRepositoryMenu('infra-team');
        const worktree = submenu.querySelector('[data-menu-item="repo:worktree"]') as HTMLElement;
        expect(worktree.getAttribute('aria-checked')).toBe('false');
        fireEvent.click(worktree);
        expect(onSetGroupRepo).toHaveBeenLastCalledWith(G_ASSOCIATE, { createWorktree: true });
    });

    it('offers no switch on a group without a repo, and None clears one', () => {
        const onSetGroupRepo = vi.fn();
        render(<Sidebar {...base()} entries={entries()} repos={REPOS} onSetGroupRepo={onSetGroupRepo} />);
        const plain = openRepositoryMenu('plain');
        expect(plain.querySelector('[data-menu-item="repo:worktree"]')).toBeNull();
        expect(plain.querySelector('[data-menu-item="repo:none"]')?.getAttribute('data-checked')).toBe('true');
        fireEvent.keyDown(document, { key: 'Escape' });
        cleanup();

        render(<Sidebar {...base()} entries={entries()} repos={REPOS} onSetGroupRepo={onSetGroupRepo} />);
        fireEvent.click(within(openRepositoryMenu('app-team')).getByText('None'));
        expect(onSetGroupRepo).toHaveBeenLastCalledWith(G_WORKTREE, { repoPath: null });
    });

    it('Choose Folder… sets the folder the native panel returned, and a cancel sets nothing', async () => {
        const onSetGroupRepo = vi.fn();
        const onBrowseForFolder = vi.fn().mockResolvedValueOnce('/src/new-repo').mockResolvedValueOnce(null);
        render(
            <Sidebar
                {...base()}
                entries={entries()}
                repos={REPOS}
                onSetGroupRepo={onSetGroupRepo}
                onBrowseForFolder={onBrowseForFolder}
            />
        );
        fireEvent.click(within(openRepositoryMenu('plain')).getByText('Choose Folder…'));
        await waitFor(() => {
            expect(onSetGroupRepo).toHaveBeenCalledWith(G_PLAIN, { repoPath: '/src/new-repo' });
        });

        fireEvent.click(within(openRepositoryMenu('plain')).getByText('Choose Folder…'));
        await waitFor(() => {
            expect(onBrowseForFolder).toHaveBeenCalledTimes(2);
        });
        expect(onSetGroupRepo).toHaveBeenCalledTimes(1);
    });

    it('has no Choose Folder… outside the desktop app, and no Repository ▸ without a handler', () => {
        render(<Sidebar {...base()} entries={entries()} repos={REPOS} onSetGroupRepo={vi.fn()} />);
        expect(openRepositoryMenu('plain').querySelector('[data-menu-item="repo:choose"]')).toBeNull();
        fireEvent.keyDown(document, { key: 'Escape' });
        cleanup();

        render(<Sidebar {...base()} entries={entries()} repos={REPOS} />);
        fireEvent.contextMenu(header('plain'));
        expect(within(screen.getByTestId('context-menu')).queryByText('Repository')).toBeNull();
    });
});

describe('the New Workspace sheet’s prefill from the group (§5.5)', () => {
    function renderSheetHost(props: Record<string, unknown> = {}) {
        const onCreateWorkspace = vi.fn().mockResolvedValue(null);
        render(
            <Sidebar
                {...base()}
                entries={entries()}
                repos={REPOS}
                onCreateWorkspace={onCreateWorkspace as never}
                {...props}
            />
        );
        return onCreateWorkspace;
    }

    it('opens with the repo, the worktree toggle on and update main ticked when the switch is on', async () => {
        const onCreateWorkspace = renderSheetHost();
        newWorkspaceFrom('app-team');
        expect((screen.getByTestId('new-workspace-group') as HTMLSelectElement).value).toBe(G_WORKTREE);
        expect(chosenRepos()).toEqual(['r1']);
        expect(toggle()?.checked).toBe(true);
        expect(updateMain()?.checked).toBe(true);

        // The user types the worktree name; the branch follows it, and Create sends it all.
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'fix-login' } });
        fireEvent.change(screen.getByTestId('new-workspace-worktree-name'), { target: { value: 'fix-login' } });
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledTimes(1);
        });
        const [name, groupID, worktree, extras] = onCreateWorkspace.mock.calls[0] as unknown[];
        expect(name).toBe('fix-login');
        expect(groupID).toBe(G_WORKTREE);
        expect(worktree).toEqual({ repoID: 'r1', name: 'fix-login', branch: 'fix-login', updateMain: true });
        expect(extras).toMatchObject({ repoPaths: ['/src/app'] });
    });

    it('prefills only the repo when the switch is off, and nothing for a repo-less group', () => {
        renderSheetHost();
        newWorkspaceFrom('infra-team');
        expect(chosenRepos()).toEqual(['r2']);
        expect(toggle()?.checked).toBe(false);
        fireEvent.keyDown(window, { key: 'Escape' });

        newWorkspaceFrom('plain');
        expect(chosenRepos()).toEqual([]);
        expect(toggle()).toBeNull();
    });

    it('stays overridable for a one-off: untick the worktree, and it is a plain association', async () => {
        const onCreateWorkspace = renderSheetHost();
        newWorkspaceFrom('app-team');
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'one-off' } });
        fireEvent.click(toggle() as HTMLInputElement);
        expect(screen.queryByTestId('new-workspace-worktree')).toBeNull();
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledTimes(1);
        });
        const [, , worktree, extras] = onCreateWorkspace.mock.calls[0] as unknown[];
        expect(worktree).toBeUndefined();
        expect(extras).toMatchObject({ repoPaths: ['/src/app'] });
    });

    it('swaps the prefill when the Group dropdown changes, while the repos are untouched', () => {
        renderSheetHost();
        newWorkspaceFrom('plain');
        const picker = screen.getByTestId('new-workspace-group');
        fireEvent.change(picker, { target: { value: G_WORKTREE } });
        expect(chosenRepos()).toEqual(['r1']);
        expect(toggle()?.checked).toBe(true);
        expect(updateMain()?.checked).toBe(true);

        fireEvent.change(picker, { target: { value: G_ASSOCIATE } });
        expect(chosenRepos()).toEqual(['r2']);
        expect(toggle()?.checked).toBe(false);

        fireEvent.change(picker, { target: { value: '' } });
        expect(chosenRepos()).toEqual([]);
    });

    it('no longer swaps once the user has edited the repo selection', () => {
        renderSheetHost();
        newWorkspaceFrom('app-team');
        // The user takes the prefilled repo off: that is a choice, and a Group change keeps it.
        fireEvent.click(screen.getByTestId('new-workspace-repo-remove-r1'));
        expect(chosenRepos()).toEqual([]);
        fireEvent.change(screen.getByTestId('new-workspace-group'), { target: { value: G_ASSOCIATE } });
        expect(chosenRepos()).toEqual([]);
        fireEvent.change(screen.getByTestId('new-workspace-group'), { target: { value: G_WORKTREE } });
        expect(chosenRepos()).toEqual([]);
    });

    it('applies the prefill when the registry arrives after the sheet opened', () => {
        function Late(): ReactElement {
            const [repos, setRepos] = useState<readonly ChromeRepo[]>([]);
            return (
                <>
                    <button type="button" data-testid="load-registry" onClick={() => setRepos(REPOS)} />
                    <Sidebar {...base()} entries={entries()} repos={repos} onCreateWorkspace={vi.fn() as never} />
                </>
            );
        }
        render(<Late />);
        newWorkspaceFrom('app-team');
        expect(screen.queryByTestId('new-workspace-repos')).toBeNull();
        fireEvent.click(screen.getByTestId('load-registry'));
        expect(chosenRepos()).toEqual(['r1']);
        expect(toggle()?.checked).toBe(true);
    });
});

describe('the New Group sheet’s repository (§5.5)', () => {
    function openGroupSheet(props: Record<string, unknown> = {}): void {
        render(<Sidebar {...base()} entries={entries()} {...props} />);
        fireEvent.click(screen.getByTestId('sidebar-new-menu-toggle'));
        fireEvent.click(screen.getByRole('menuitem', { name: /^New Group/ }));
    }

    it('offers None plus the registry, and the switch only once a repo is chosen', () => {
        const onCreateGroup = vi.fn();
        openGroupSheet({ repos: REPOS, onCreateGroup });
        const select = screen.getByTestId('new-group-repo') as HTMLSelectElement;
        expect(select.value).toBe('');
        expect([...select.options].map((option) => option.textContent)).toEqual(['None', 'app', 'infra']);
        expect(screen.queryByTestId('new-group-create-worktree')).toBeNull();

        fireEvent.change(select, { target: { value: 'r2' } });
        fireEvent.click(screen.getByTestId('new-group-create-worktree'));
        fireEvent.click(screen.getByTestId('new-group-submit'));
        expect(onCreateGroup).toHaveBeenCalledWith(expect.any(String), null, { repoID: 'r2', createWorktree: true });
    });

    it('creates exactly as before with no repository chosen', () => {
        const onCreateGroup = vi.fn();
        openGroupSheet({ repos: REPOS, onCreateGroup });
        fireEvent.click(screen.getByTestId('new-group-submit'));
        expect(onCreateGroup.mock.calls[0]).toHaveLength(2);
    });

    it('has no repository row without a registry, or for a group bound for a remote daemon', () => {
        openGroupSheet({ onCreateGroup: vi.fn() });
        expect(screen.queryByTestId('new-group-repo')).toBeNull();
        cleanup();

        openGroupSheet({ repos: REPOS, onCreateGroup: vi.fn(), remoteDaemons: ['werk'] });
        expect(screen.getByTestId('new-group-repo')).toBeTruthy();
        fireEvent.change(screen.getByTestId('new-group-runs-on'), { target: { value: 'werk' } });
        expect(screen.queryByTestId('new-group-repo')).toBeNull();
    });
});

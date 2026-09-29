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

import { sanitizedGitName } from '@kelpi/core/git';

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

        // By id: a registered row is taken as is, never re-resolved from its path.
        fireEvent.click(within(submenu).getByText('infra'));
        expect(onSetGroupRepo).toHaveBeenLastCalledWith(G_WORKTREE, { repoID: 'r2' });
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

    it('no longer swaps once the user has ADDED a repo through the picker', () => {
        renderSheetHost();
        newWorkspaceFrom('plain');
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        const picker = screen.getByTestId('new-workspace-repo-picker');
        fireEvent.click(within(picker).getByTestId('repo-choice-r2'));
        fireEvent.click(within(picker).getByTestId('repo-picker-choose'));
        expect(chosenRepos()).toEqual(['r2']);
        fireEvent.change(screen.getByTestId('new-workspace-group'), { target: { value: G_WORKTREE } });
        expect(chosenRepos()).toEqual(['r2']);
        expect(toggle()?.checked).toBe(false);
    });

    it('never overwrites the user’s own worktree or update-main choice, while still swapping the repo', () => {
        renderSheetHost();
        newWorkspaceFrom('app-team');
        // Keep the worktree, but turn update main off for this one.
        fireEvent.click(updateMain() as HTMLInputElement);
        expect(updateMain()?.checked).toBe(false);
        fireEvent.change(screen.getByTestId('new-workspace-group'), { target: { value: G_ASSOCIATE } });
        expect(chosenRepos()).toEqual(['r2']);
        // The associate-only group would untick both; the user's choice stands.
        expect(toggle()?.checked).toBe(true);
        expect(updateMain()?.checked).toBe(false);
        fireEvent.change(screen.getByTestId('new-workspace-group'), { target: { value: G_WORKTREE } });
        expect(chosenRepos()).toEqual(['r1']);
        expect(updateMain()?.checked).toBe(false);
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

describe('the group header’s repo indicator (§5.5)', () => {
    const indicator = (name: string): HTMLElement | null =>
        header(name).querySelector('[data-testid="group-repo"]') as HTMLElement | null;

    it('names the repo, with its path in the tooltip, and marks the worktree switch', () => {
        render(<Sidebar {...base()} entries={entries()} repos={REPOS} />);
        const app = indicator('app-team');
        expect(app?.querySelector('[data-testid="group-repo-name"]')?.textContent).toBe('app');
        expect(app?.getAttribute('title')).toBe('/src/app\nNew workspaces create a worktree from latest main');
        expect(app?.getAttribute('data-create-worktree')).toBe('true');
        expect(app?.querySelector('[data-testid="group-repo-worktree"]')?.getAttribute('aria-label')).toBe(
            'New workspaces create a worktree from latest main'
        );

        const infra = indicator('infra-team');
        expect(infra?.querySelector('[data-testid="group-repo-name"]')?.textContent).toBe('infra');
        expect(infra?.getAttribute('title')).toBe('/src/infra');
        expect(infra?.querySelector('[data-testid="group-repo-worktree"]')).toBeNull();

        // No repo: no indicator, and the name is the header's original single span.
        expect(indicator('plain')).toBeNull();
        expect(header('plain').querySelector('[data-testid="group-name"]')?.parentElement?.className).toContain('flex-col');
    });

    it('shows on a collapsed group too, and not for a repo the registry does not list', () => {
        const collapsed = entries({ worktree: { isCollapsed: true } });
        render(<Sidebar {...base()} entries={collapsed} repos={REPOS.slice(1)} />);
        expect(header('app-team').getAttribute('data-collapsed')).toBe('true');
        // r1 is not in this registry, so there is nothing to name: no indicator rather than an id.
        expect(indicator('app-team')).toBeNull();
        expect(indicator('infra-team')).not.toBeNull();
    });

    it('updates when the repo is set, switched or cleared', () => {
        const view = render(<Sidebar {...base()} entries={entries({ worktree: { repoID: null, createWorktree: false } })} repos={REPOS} />);
        expect(indicator('app-team')).toBeNull();
        view.rerender(<Sidebar {...base()} entries={entries({ worktree: { repoID: 'r2', createWorktree: false } })} repos={REPOS} />);
        expect(indicator('app-team')?.textContent).toContain('infra');
        expect(indicator('app-team')?.getAttribute('data-create-worktree')).toBe('false');
        view.rerender(<Sidebar {...base()} entries={entries({ worktree: { repoID: 'r2', createWorktree: true } })} repos={REPOS} />);
        expect(indicator('app-team')?.querySelector('[data-testid="group-repo-worktree"]')).not.toBeNull();
        view.rerender(<Sidebar {...base()} entries={entries({ worktree: { repoID: null, createWorktree: false } })} repos={REPOS} />);
        expect(indicator('app-team')).toBeNull();
    });
});

describe('the worktree and branch names follow the workspace name (§5.5)', () => {
    function openFrom(groupName: string): void {
        render(<Sidebar {...base()} entries={entries()} repos={REPOS} onCreateWorkspace={vi.fn() as never} />);
        newWorkspaceFrom(groupName);
    }
    const nameField = (): HTMLElement => screen.getByLabelText('New workspace name');
    const worktreeField = (): HTMLInputElement => screen.getByTestId('new-workspace-worktree-name') as HTMLInputElement;
    const branchField = (): HTMLInputElement => screen.getByTestId('new-workspace-worktree-branch') as HTMLInputElement;

    it('fills a git-safe worktree name and branch as the workspace name is typed', () => {
        openFrom('app-team');
        fireEvent.change(nameField(), { target: { value: 'Fix Login Bug' } });
        expect(worktreeField().value).toBe('fix-login-bug');
        expect(branchField().value).toBe('fix-login-bug');
        // Exactly what the daemon's own sanitizer makes of it, so the preview is what git gets.
        expect(worktreeField().value).toBe(sanitizedGitName('Fix Login Bug'.toLowerCase()));
        expect(screen.getByTestId('new-workspace-worktree-preview').textContent).toContain('/wt/app/fix-login-bug');
    });

    it('stops following once the worktree name is typed, and resumes when it is cleared', () => {
        openFrom('app-team');
        fireEvent.change(nameField(), { target: { value: 'Fix Login' } });
        fireEvent.change(worktreeField(), { target: { value: 'my-tree' } });
        expect(branchField().value).toBe('my-tree');
        fireEvent.change(nameField(), { target: { value: 'Something Else' } });
        expect(worktreeField().value).toBe('my-tree');
        expect(branchField().value).toBe('my-tree');
        fireEvent.change(worktreeField(), { target: { value: '' } });
        fireEvent.change(nameField(), { target: { value: 'Back Again' } });
        expect(worktreeField().value).toBe('back-again');
    });

    it('keeps a hand-edited branch while the worktree name keeps following', () => {
        openFrom('app-team');
        fireEvent.change(nameField(), { target: { value: 'Fix' } });
        fireEvent.change(branchField(), { target: { value: 'feature/fix' } });
        fireEvent.change(nameField(), { target: { value: 'Fix More' } });
        expect(worktreeField().value).toBe('fix-more');
        expect(branchField().value).toBe('feature/fix');
    });

    it('fills from the current name the moment the worktree toggle is ticked', () => {
        openFrom('infra-team');
        fireEvent.change(nameField(), { target: { value: 'Infra Tweak' } });
        expect(screen.queryByTestId('new-workspace-worktree-name')).toBeNull();
        fireEvent.click(toggle() as HTMLInputElement);
        expect(worktreeField().value).toBe('infra-tweak');
        expect(branchField().value).toBe('infra-tweak');
    });

    it('leaves the fields empty for a name that sanitizes to nothing', () => {
        openFrom('app-team');
        fireEvent.change(nameField(), { target: { value: '!!! 🚀' } });
        expect(worktreeField().value).toBe('');
        expect(branchField().value).toBe('');
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

    it('Choose Folder… (desktop app) offers the folder the panel returned, even over an empty registry', async () => {
        const onCreateGroup = vi.fn();
        const onBrowseForFolder = vi.fn().mockResolvedValue('/src/fresh-repo/');
        openGroupSheet({ onCreateGroup, onBrowseForFolder });
        const select = screen.getByTestId('new-group-repo') as HTMLSelectElement;
        expect([...select.options].map((option) => option.textContent)).toEqual(['None']);
        fireEvent.click(screen.getByTestId('new-group-repo-browse'));
        await waitFor(() => {
            expect([...select.options].map((option) => option.textContent)).toEqual(['None', 'fresh-repo']);
        });
        expect(select.value).not.toBe('');
        fireEvent.click(screen.getByTestId('new-group-create-worktree'));
        fireEvent.click(screen.getByTestId('new-group-submit'));
        expect(onCreateGroup).toHaveBeenCalledWith(expect.any(String), null, {
            repoPath: '/src/fresh-repo/',
            createWorktree: true
        });
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

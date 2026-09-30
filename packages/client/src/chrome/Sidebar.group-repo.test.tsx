/**
 * A group's default repository (app-state-core.md §5.5), everywhere the sidebar shows it:
 *
 *   - the group repository sheet, raised by Add Repository… / Edit Repository… (a filterable
 *     registry list, Choose Folder… in the desktop app, Remove Repository,
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

function menuRow(groupName: string, label: RegExp): HTMLElement | null {
    fireEvent.contextMenu(header(groupName));
    return within(screen.getByTestId('context-menu')).queryByText(label);
}

/** The group's repository sheet, opened the way a user opens it: its context menu row. */
function openRepoSheet(groupName: string): HTMLElement {
    const row = menuRow(groupName, /^(Add|Edit) Repository…$/);
    if (row === null) throw new Error(`no repository row for ${groupName}`);
    fireEvent.click(row);
    return screen.getByTestId('group-repo-sheet');
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

describe('the group’s repository sheet (§5.5)', () => {
    const AUTO: ChromeRepo = { id: 'r3', name: 'auto-found', path: '/src/auto-found', worktreeBase: '/wt/auto', isAutoDiscovered: true };
    function renderWith(props: Record<string, unknown> = {}) {
        const onSetGroupRepo = vi.fn();
        render(<Sidebar {...base()} entries={entries()} repos={REPOS} onSetGroupRepo={onSetGroupRepo} {...props} />);
        return onSetGroupRepo;
    }
    const rowIDs = (): string[] =>
        [...screen.getByTestId('group-repo-sheet').querySelectorAll('[data-testid^="repo-choice-"]')].map((element) =>
            (element.getAttribute('data-testid') ?? '').slice('repo-choice-'.length)
        );
    const worktreeBox = (): HTMLInputElement => screen.getByTestId('group-repo-create-worktree') as HTMLInputElement;

    it('says Add Repository… for a group without a repo and Edit Repository… for one with a repo, and titles the sheet to match', () => {
        renderWith();
        expect(menuRow('plain', /^Add Repository…$/)).not.toBeNull();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(menuRow('app-team', /^Edit Repository…$/)).not.toBeNull();
        // No submenu any more: the row is a plain item.
        expect(screen.queryByTestId('context-submenu')).toBeNull();
        fireEvent.keyDown(document, { key: 'Escape' });
        openRepoSheet('app-team');
        expect(screen.getByTestId('group-repo-title').textContent).toBe('Edit Repository for app-team');
        fireEvent.click(screen.getByTestId('group-repo-cancel'));
        openRepoSheet('plain');
        expect(screen.getByTestId('group-repo-title').textContent).toBe('Add Repository to plain');
    });

    it('opens on the current repo with the switch as set, focus in the filter', () => {
        renderWith();
        openRepoSheet('app-team');
        expect(screen.getByTestId('repo-choice-r1').getAttribute('data-selected')).toBe('true');
        expect(screen.getByTestId('repo-choice-r2').getAttribute('data-selected')).toBe('false');
        expect(worktreeBox().checked).toBe(true);
        expect(document.activeElement).toBe(screen.getByTestId('repo-picker-search'));
    });

    it('filters by name or path, and Save sends the picked row by id with the switch', () => {
        const onSetGroupRepo = renderWith();
        openRepoSheet('plain');
        expect(worktreeBox().disabled).toBe(true);
        fireEvent.change(screen.getByTestId('repo-picker-search'), { target: { value: 'INFRA' } });
        expect(rowIDs()).toEqual(['r2']);
        fireEvent.change(screen.getByTestId('repo-picker-search'), { target: { value: '/src/ap' } });
        expect(rowIDs()).toEqual(['r1']);
        fireEvent.click(screen.getByTestId('repo-choice-r1'));
        expect(worktreeBox().disabled).toBe(false);
        fireEvent.click(worktreeBox());
        // Nothing is sent until Save.
        expect(onSetGroupRepo).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('group-repo-save'));
        expect(onSetGroupRepo).toHaveBeenCalledExactlyOnceWith(G_PLAIN, { repoID: 'r1', createWorktree: true });
        expect(screen.queryByTestId('group-repo-sheet')).toBeNull();
    });

    it('Cancel, Escape and the backdrop send nothing', () => {
        const onSetGroupRepo = renderWith();
        openRepoSheet('app-team');
        fireEvent.click(screen.getByTestId('repo-choice-r2'));
        fireEvent.click(screen.getByTestId('group-repo-cancel'));
        openRepoSheet('app-team');
        fireEvent.click(screen.getByTestId('repo-choice-r2'));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('group-repo-sheet')).toBeNull();
        openRepoSheet('app-team');
        fireEvent.mouseDown(screen.getByTestId('group-repo-backdrop'));
        expect(screen.queryByTestId('group-repo-sheet')).toBeNull();
        expect(onSetGroupRepo).not.toHaveBeenCalled();
    });

    it('Return saves, from the list as from anywhere else in the sheet', () => {
        const onSetGroupRepo = renderWith();
        openRepoSheet('infra-team');
        fireEvent.click(worktreeBox());
        fireEvent.keyDown(worktreeBox(), { key: 'Enter' });
        expect(onSetGroupRepo).toHaveBeenCalledExactlyOnceWith(G_ASSOCIATE, { repoID: 'r2', createWorktree: true });
    });

    it('Remove Repository is offered only for a group with one, clears it, and turns the switch off', () => {
        const onSetGroupRepo = renderWith();
        openRepoSheet('plain');
        expect(screen.queryByTestId('group-repo-remove')).toBeNull();
        // Nothing chosen for a group with nothing: there is nothing to save.
        expect((screen.getByTestId('group-repo-save') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByTestId('group-repo-cancel'));

        openRepoSheet('app-team');
        fireEvent.click(screen.getByTestId('group-repo-remove'));
        expect(screen.getByTestId('repo-choice-r1').getAttribute('data-selected')).toBe('false');
        expect(worktreeBox().disabled).toBe(true);
        expect(worktreeBox().checked).toBe(false);
        fireEvent.click(screen.getByTestId('group-repo-save'));
        expect(onSetGroupRepo).toHaveBeenCalledExactlyOnceWith(G_WORKTREE, { repoPath: null });
    });

    it('Choose Folder… (desktop app) selects the folder the panel returned; a cancel changes nothing', async () => {
        const onBrowseForFolder = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('/src/new-repo');
        const onSetGroupRepo = renderWith({ onBrowseForFolder });
        openRepoSheet('plain');
        fireEvent.click(screen.getByTestId('group-repo-browse'));
        await waitFor(() => {
            expect(onBrowseForFolder).toHaveBeenCalledTimes(1);
        });
        expect(screen.queryByTestId('group-repo-folder')).toBeNull();
        fireEvent.click(screen.getByTestId('group-repo-browse'));
        await waitFor(() => {
            expect(screen.getByTestId('group-repo-folder').getAttribute('title')).toBe('/src/new-repo');
        });
        fireEvent.click(worktreeBox());
        fireEvent.click(screen.getByTestId('group-repo-save'));
        expect(onSetGroupRepo).toHaveBeenCalledExactlyOnceWith(G_PLAIN, { repoPath: '/src/new-repo', createWorktree: true });
    });

    it('has no Choose Folder… outside the desktop app, and no row without a handler', () => {
        renderWith();
        openRepoSheet('plain');
        expect(screen.queryByTestId('group-repo-browse')).toBeNull();
        fireEvent.click(screen.getByTestId('group-repo-cancel'));
        cleanup();

        render(<Sidebar {...base()} entries={entries()} repos={REPOS} />);
        expect(menuRow('plain', /Repository…$/)).toBeNull();
    });

    it('hides auto-discovered repos unless one is the current repo, or they are asked for', () => {
        renderWith({ repos: [...REPOS, AUTO] });
        openRepoSheet('plain');
        expect(rowIDs()).toEqual(['r1', 'r2']);
        fireEvent.click(screen.getByTestId('group-repo-show-auto'));
        expect(rowIDs()).toEqual(['r1', 'r2', 'r3']);
        fireEvent.click(screen.getByTestId('group-repo-cancel'));
        cleanup();

        const current = entries({ worktree: { repoID: 'r3', createWorktree: false } });
        render(<Sidebar {...base()} entries={current} repos={[...REPOS, AUTO]} onSetGroupRepo={vi.fn()} />);
        openRepoSheet('app-team');
        expect(rowIDs()).toEqual(['r1', 'r2', 'r3']);
        expect(screen.getByTestId('repo-choice-r3').getAttribute('data-selected')).toBe('true');
    });

    it('points an empty registry at Choose Folder… in the desktop app and at Settings in a browser', () => {
        render(<Sidebar {...base()} entries={entries()} repos={[]} onSetGroupRepo={vi.fn()} onBrowseForFolder={vi.fn()} />);
        openRepoSheet('plain');
        expect(screen.getByTestId('repo-picker-empty').textContent).toContain('No repositories registered');
        expect(screen.getByTestId('repo-picker-empty').textContent).toContain('Choose Folder…');
        fireEvent.click(screen.getByTestId('group-repo-cancel'));
        cleanup();

        render(<Sidebar {...base()} entries={entries()} repos={[]} onSetGroupRepo={vi.fn()} />);
        openRepoSheet('plain');
        expect(screen.getByTestId('repo-picker-empty').textContent).toContain('Settings ▸ Repositories');
        expect(screen.getByTestId('repo-picker-empty').textContent).not.toContain('Choose Folder');
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
        expect(worktree).toEqual({
            repoID: 'r1',
            name: 'fix-login',
            branch: 'fix-login',
            updateMain: true,
            requestID: expect.any(String),
            onProgress: expect.any(Function)
        });
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

    it('names the repo, with its path in the tooltip, and says the worktree switch in the tooltip only', () => {
        render(<Sidebar {...base()} entries={entries()} repos={REPOS} />);
        const app = indicator('app-team');
        expect(app?.querySelector('[data-testid="group-repo-name"]')?.textContent).toBe('app');
        expect(app?.getAttribute('title')).toBe('/src/app\nNew workspaces create a worktree from latest main');
        expect(app?.getAttribute('data-create-worktree')).toBe('true');
        // The switch draws no mark: the header reads the same with it on or off.
        expect(app?.querySelectorAll('svg')).toHaveLength(1);
        expect(app?.textContent).toBe('app');

        const infra = indicator('infra-team');
        expect(infra?.querySelector('[data-testid="group-repo-name"]')?.textContent).toBe('infra');
        expect(infra?.getAttribute('title')).toBe('/src/infra');
        expect(infra?.querySelectorAll('svg')).toHaveLength(1);

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
        expect(indicator('app-team')?.getAttribute('data-create-worktree')).toBe('true');
        expect(indicator('app-team')?.getAttribute('title')).toBe('/src/infra\nNew workspaces create a worktree from latest main');
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

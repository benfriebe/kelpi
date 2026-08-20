/**
 * The workspace inspector (§WS-137…§WS-150) and its two sheets.
 *
 * Everything the shipped panel promises, asserted from a fixture: the sections and their order,
 * the per-repo grouping with the main checkout first and worktrees indented, the three-state
 * status dot, the dirty diff stats, the two per-association actions (diff / terminal, Shift =
 * vertical), the removal menu with its worktree-only second item, the profile picker's `default`
 * baseline and missing-profile tolerance, the pane list with its focus marker and conditional
 * close button, and the Create Worktree sheet's mirroring / preview / in-flight guard / inline
 * failure.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Inspector, groupAssociations } from './index';
import type { InspectorAssociation, InspectorProps, InspectorRepo } from './index';
import type { ChromePane, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';

function pane(id: string, overrides: Partial<ChromePane> = {}): ChromePane {
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
        backgroundTaskCount: 0,
        ...overrides
    };
}

function workspace(overrides: Partial<ChromeWorkspace> = {}): ChromeWorkspace & { profileName?: string | null } {
    return {
        id: W1,
        name: 'alpha',
        color: 'blue',
        icon: null,
        labels: ['infra'],
        panes: [pane('p1', { label: 'coordinator' }), pane('p2')],
        ...overrides
    };
}

const REPOS: InspectorRepo[] = [
    { id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/Users/t/nex/worktrees/app' },
    { id: 'r2', name: 'infra', path: '/src/infra', worktreeBase: '/Users/t/nex/worktrees/infra' }
];

function association(overrides: Partial<InspectorAssociation> = {}): InspectorAssociation {
    return {
        id: 'a-main',
        repoID: 'r1',
        repoName: 'app',
        repoPath: '/src/app',
        worktreePath: '/src/app',
        branch: 'main',
        isWorktree: false,
        status: { kind: 'clean', changedFiles: 0, additions: 0, deletions: 0 },
        ...overrides
    };
}

const WORKTREE = association({
    id: 'a-wt',
    worktreePath: '/Users/t/nex/worktrees/app/login',
    branch: 'login',
    isWorktree: true,
    status: { kind: 'dirty', changedFiles: 3, additions: 27, deletions: 12 }
});

function view(props: Partial<InspectorProps> = {}) {
    return render(
        <Inspector
            workspace={workspace()}
            focusedPaneID="p1"
            associations={[association(), WORKTREE]}
            repos={REPOS}
            {...props}
        />
    );
}

describe('layout and identity (§WS-137/§WS-138)', () => {
    it('renders a fixed-width panel with the three sections and a close button', () => {
        const onClose = vi.fn();
        view({ onClose });
        const panel = screen.getByTestId('inspector');
        expect(panel.style.width).toBe('280px');
        expect(screen.getByTestId('inspector-workspace')).toBeTruthy();
        expect(screen.getByTestId('inspector-repos')).toBeTruthy();
        expect(screen.getByTestId('inspector-panes')).toBeTruthy();
        fireEvent.click(screen.getByTestId('inspector-close'));
        expect(onClose).toHaveBeenCalled();
    });

    it('shows the colour bar, the name, the pane count and the labels', () => {
        view();
        expect(screen.getByTestId('inspector-workspace-name').textContent).toBe('alpha');
        expect(screen.getByTestId('inspector-workspace').textContent).toContain('2 panes');
        expect(within(screen.getByTestId('inspector-labels')).getByText('infra')).toBeTruthy();
    });

    it('renames in place and recolours through the swatch row', () => {
        const onRenameWorkspace = vi.fn();
        const onSetWorkspaceColor = vi.fn();
        view({ onRenameWorkspace, onSetWorkspaceColor });
        fireEvent.click(screen.getByTestId('inspector-workspace-name'));
        const input = screen.getByTestId('inspector-rename-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'renamed' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onRenameWorkspace).toHaveBeenCalledWith('renamed');

        fireEvent.click(screen.getByTestId('inspector-color-purple'));
        expect(onSetWorkspaceColor).toHaveBeenCalledWith('purple');
    });

    it('leads the profile picker with `default` and keeps an assigned-but-missing one selectable', () => {
        const onSetProfile = vi.fn();
        view({
            workspace: workspace({ profileName: 'ghost' } as Partial<ChromeWorkspace>),
            profiles: ['work', 'personal'],
            onSetProfile
        });
        const picker = screen.getByTestId('inspector-profile') as HTMLSelectElement;
        expect([...picker.options].map((option) => option.value)).toEqual([
            'default',
            'work',
            'personal',
            'ghost'
        ]);
        // A profile that vanished from the config still shows as the selection, never blank.
        expect(picker.value).toBe('ghost');
        fireEvent.change(picker, { target: { value: 'work' } });
        expect(onSetProfile).toHaveBeenCalledWith('work');
        fireEvent.change(picker, { target: { value: 'default' } });
        // The built-in baseline is stored as "no assignment".
        expect(onSetProfile).toHaveBeenLastCalledWith(null);
    });
});

describe('repository associations (§WS-139…§WS-142)', () => {
    it('groups by repo in registration order, main checkout first', () => {
        const groups = groupAssociations([WORKTREE, association()]);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.main?.id).toBe('a-main');
        expect(groups[0]?.worktrees.map((entry) => entry.id)).toEqual(['a-wt']);
    });

    it('falls back to a non-interactive repo header when only worktrees are referenced', () => {
        view({ associations: [WORKTREE] });
        expect(screen.getByTestId('inspector-repos').textContent).toContain('app');
        expect(screen.queryByTestId('inspector-assoc-a-main')).toBeNull();
        expect(screen.getByTestId('inspector-assoc-a-wt')).toBeTruthy();
    });

    it('paints the status dot by state and prints dirty diff stats', () => {
        view();
        const dots = screen.getAllByTestId('inspector-status-dot');
        expect(dots.map((dot) => dot.getAttribute('data-status'))).toEqual(['clean', 'dirty']);
        const stats = screen.getByTestId('inspector-stats');
        expect(stats.textContent).toContain('3 files');
        expect(stats.textContent).toContain('+27');
        expect(stats.textContent).toContain('-12');
    });

    it('shows the unknown state as a gray dot with no stats', () => {
        view({
            associations: [
                association({ status: { kind: 'unknown', changedFiles: 0, additions: 0, deletions: 0 } })
            ]
        });
        expect(screen.getByTestId('inspector-status-dot').getAttribute('data-status')).toBe('unknown');
        expect(screen.queryByTestId('inspector-stats')).toBeNull();
    });

    it('opens a diff and a terminal for the association’s own path, Shift splitting vertically', () => {
        const onOpenDiff = vi.fn();
        const onOpenTerminal = vi.fn();
        view({ onOpenDiff, onOpenTerminal });
        fireEvent.click(screen.getByTestId('inspector-diff-a-wt'));
        expect(onOpenDiff).toHaveBeenCalledWith('/Users/t/nex/worktrees/app/login');
        fireEvent.click(screen.getByTestId('inspector-terminal-a-main'));
        expect(onOpenTerminal).toHaveBeenCalledWith('/src/app', { vertical: false });
        fireEvent.click(screen.getByTestId('inspector-terminal-a-main'), { shiftKey: true });
        expect(onOpenTerminal).toHaveBeenLastCalledWith('/src/app', { vertical: true });
    });

    it('offers Remove, and Remove & Delete Worktree only for a worktree', () => {
        const onRemoveAssociation = vi.fn();
        view({ onRemoveAssociation });
        fireEvent.contextMenu(screen.getByTestId('inspector-assoc-a-main'));
        expect(screen.queryByText('Remove & Delete Worktree')).toBeNull();
        fireEvent.click(screen.getByText('Remove'));
        expect(onRemoveAssociation).toHaveBeenCalledWith('a-main', false);

        fireEvent.click(screen.getByTestId('inspector-assoc-menu-a-wt'));
        fireEvent.click(screen.getByText('Remove & Delete Worktree'));
        expect(onRemoveAssociation).toHaveBeenLastCalledWith('a-wt', true);
    });

    it('says so plainly when the workspace has no repositories', () => {
        view({ associations: [] });
        expect(screen.getByTestId('inspector-repos').textContent).toContain('No repositories associated');
    });

    it('adds a repository by path, keeping the sheet open on the daemon’s refusal', async () => {
        const onAddAssociation = vi
            .fn()
            .mockResolvedValueOnce('/tmp/x is not inside a git repository')
            .mockResolvedValueOnce(null);
        view({ onAddAssociation });
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('Add Repository…'));
        fireEvent.change(screen.getByTestId('add-repo-path'), { target: { value: '/tmp/x' } });
        fireEvent.click(screen.getByTestId('add-repo-submit'));
        await waitFor(() => {
            expect(screen.getByTestId('sheet-error').textContent).toContain('not inside a git repository');
        });
        expect(screen.getByTestId('add-repo-sheet')).toBeTruthy();

        fireEvent.change(screen.getByTestId('add-repo-path'), { target: { value: '/src/app' } });
        fireEvent.click(screen.getByTestId('add-repo-submit'));
        await waitFor(() => {
            expect(screen.queryByTestId('add-repo-sheet')).toBeNull();
        });
        expect(onAddAssociation).toHaveBeenLastCalledWith('/src/app');
    });

    /**
     * §GIT-082 + §GIT-073: the sheet now carries the multi-select picker beside the typed path,
     * and Add makes ONE association per chosen repo, at the repo's own path. Repos the
     * workspace already points at are listed dimmed and cannot be chosen twice.
     */
    it('associates several registry repos in one Add, skipping the ones already added', async () => {
        const onAddAssociation = vi.fn().mockResolvedValue(null);
        view({ onAddAssociation, associations: [association()] });
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('Add Repository…'));

        const sheet = screen.getByTestId('add-repo-sheet');
        // r1 IS the workspace's existing association, so it is dimmed and inert.
        const added = within(sheet).getByTestId('repo-choice-r1');
        expect(added.dataset['added']).toBe('true');
        fireEvent.click(added);
        expect(added.dataset['selected']).toBe('false');

        fireEvent.click(within(sheet).getByTestId('repo-choice-r2'));
        // …plus a path the registry has never seen, in the same submit.
        fireEvent.change(within(sheet).getByTestId('add-repo-path'), { target: { value: '/elsewhere/api' } });
        expect(within(sheet).getByTestId('add-repo-submit').textContent).toBe('Add 2');
        fireEvent.click(within(sheet).getByTestId('add-repo-submit'));

        await waitFor(() => {
            expect(screen.queryByTestId('add-repo-sheet')).toBeNull();
        });
        expect(onAddAssociation.mock.calls.map((call) => call[0])).toEqual(['/src/infra', '/elsewhere/api']);
    });

    it('stops the batch at the daemon’s first refusal and keeps the sheet open', async () => {
        const onAddAssociation = vi.fn().mockResolvedValue('/src/infra is not inside a git repository');
        view({ onAddAssociation, associations: [] });
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('Add Repository…'));

        const sheet = screen.getByTestId('add-repo-sheet');
        fireEvent.click(within(sheet).getByTestId('repo-choice-r2'));
        fireEvent.click(within(sheet).getByTestId('repo-choice-r1'));
        fireEvent.click(within(sheet).getByTestId('add-repo-submit'));

        await waitFor(() => {
            expect(screen.getByTestId('sheet-error').textContent).toContain('not inside a git repository');
        });
        expect(onAddAssociation).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('add-repo-sheet')).toBeTruthy();
    });
});

describe('the Create Worktree sheet (§WS-147/§WS-148, §GIT-098/§GIT-099)', () => {
    it('picks the repo automatically when the workspace references exactly one', () => {
        view({ onCreateWorktree: vi.fn() });
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('New Worktree…'));
        // Straight to the sheet: no picker step, and a "Change" link because the registry has 2.
        expect(screen.getByTestId('worktree-sheet').textContent).toContain('app');
        expect(screen.getByTestId('worktree-change-repo')).toBeTruthy();
    });

    it('asks which repo when the choice is ambiguous', () => {
        view({ associations: [], onCreateWorktree: vi.fn() });
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('New Worktree…'));
        expect(screen.getByTestId('repo-picker-sheet')).toBeTruthy();
        fireEvent.click(screen.getByTestId('repo-choice-r2'));
        fireEvent.click(screen.getByTestId('repo-picker-choose'));
        expect(screen.getByTestId('worktree-sheet').textContent).toContain('infra');
    });

    it('mirrors the name into the branch, previews the sanitized result and gates Create', async () => {
        const onCreateWorktree = vi.fn().mockResolvedValue(null);
        view({ onCreateWorktree });
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('New Worktree…'));
        const create = screen.getByTestId('worktree-create') as HTMLButtonElement;
        expect(create.disabled).toBe(true);

        fireEvent.change(screen.getByTestId('worktree-name'), { target: { value: 'Fix Login' } });
        expect(screen.getByTestId('worktree-preview').textContent).toContain(
            '/Users/t/nex/worktrees/app/Fix-Login'
        );
        expect(screen.getByTestId('worktree-preview').textContent).toContain('branch: Fix-Login');
        expect(create.disabled).toBe(false);

        fireEvent.change(screen.getByTestId('worktree-branch'), { target: { value: 'feature/login' } });
        fireEvent.change(screen.getByTestId('worktree-name'), { target: { value: 'login' } });
        expect((screen.getByTestId('worktree-branch') as HTMLInputElement).value).toBe('feature/login');

        fireEvent.click(screen.getByTestId('worktree-update-main'));
        fireEvent.click(create);
        await waitFor(() => {
            expect(onCreateWorktree).toHaveBeenCalledWith({
                repoID: 'r1',
                name: 'login',
                branch: 'feature/login',
                updateMain: true
            });
        });
        await waitFor(() => {
            expect(screen.queryByTestId('worktree-sheet')).toBeNull();
        });
    });

    it('refuses a second Create while one is running and shows git’s message on failure', async () => {
        let settle: ((value: string | null) => void) | null = null;
        const onCreateWorktree = vi.fn().mockImplementation(
            () =>
                new Promise<string | null>((resolve) => {
                    settle = resolve;
                })
        );
        view({ onCreateWorktree });
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('New Worktree…'));
        fireEvent.change(screen.getByTestId('worktree-name'), { target: { value: 'login' } });
        fireEvent.click(screen.getByTestId('worktree-create'));
        await waitFor(() => {
            expect((screen.getByTestId('worktree-create') as HTMLButtonElement).disabled).toBe(true);
        });
        fireEvent.click(screen.getByTestId('worktree-create'));
        expect(onCreateWorktree).toHaveBeenCalledTimes(1);

        await waitFor(() => {
            expect(settle).not.toBeNull();
        });
        (settle as unknown as (value: string | null) => void)("fatal: 'login' already exists");
        await waitFor(() => {
            expect(screen.getByTestId('sheet-error').textContent).toContain('already exists');
        });
        expect(screen.getByTestId('worktree-sheet')).toBeTruthy();
        expect((screen.getByTestId('worktree-create') as HTMLButtonElement).disabled).toBe(false);
    });

    it('dims New Worktree when nothing is registered but still offers Add Repository', () => {
        view({ repos: [], associations: [] });
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        const items = screen.getAllByRole('menuitem');
        const worktree = items.find((item) => (item.textContent ?? '').startsWith('New Worktree'));
        const add = items.find((item) => (item.textContent ?? '').startsWith('Add Repository'));
        expect(worktree?.getAttribute('aria-disabled')).toBe('true');
        expect(add?.getAttribute('aria-disabled')).toBeNull();
    });
});

describe('the pane list (§WS-149)', () => {
    it('lists panes by label/title, marks the focused one and focuses on click', () => {
        const onFocusPane = vi.fn();
        view({ onFocusPane });
        expect(screen.getByTestId('inspector-pane-p1').textContent).toContain('coordinator');
        expect(screen.getByTestId('inspector-pane-p2').textContent).toContain('zsh');
        expect(screen.getByTestId('inspector-pane-focused-p1')).toBeTruthy();
        expect(screen.queryByTestId('inspector-pane-focused-p2')).toBeNull();
        fireEvent.click(screen.getByTitle('Focus zsh'));
        expect(onFocusPane).toHaveBeenCalledWith('p2');
    });

    it('offers a close button only while more than one pane exists', () => {
        const onClosePane = vi.fn();
        view({ onClosePane });
        fireEvent.click(screen.getByTestId('inspector-close-pane-p2'));
        expect(onClosePane).toHaveBeenCalledWith('p2');

        cleanup();
        render(
            <Inspector workspace={workspace({ panes: [pane('only')] })} associations={[]} repos={[]} />
        );
        expect(screen.queryByTestId('inspector-close-pane-only')).toBeNull();
    });
});

describe('icon buttons (§WS-150)', () => {
    it('carry a tooltip, a label and the pointer cursor, and brighten on hover', () => {
        view();
        const button = screen.getByTestId('inspector-diff-a-main');
        expect(button.getAttribute('title')).toBe('Show diff for this repo');
        expect(button.getAttribute('aria-label')).toBe('Show diff for this repo');
        expect(button.className).toContain('cursor-pointer');
        const before = button.style.background;
        fireEvent.mouseEnter(button);
        expect(button.style.background).not.toBe(before);
        fireEvent.mouseLeave(button);
        expect(button.style.background).toBe(before);
    });
});

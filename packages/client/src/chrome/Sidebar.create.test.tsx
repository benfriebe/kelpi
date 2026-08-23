/**
 * The New Workspace / New Group sheet's FIELDS — `NewWorkspaceSheet.swift` + `NewGroupSheet.swift`
 * (§WS-075…§WS-083, §SET-214).
 *
 * Everything asserted here is a field the shipped sheet collects: the colour swatch row and its
 * avoid-the-neighbour default, the group picker and its preselection, the profile picker, the
 * Repositories section that associates at create, the bulk flow's count line, the uniquified
 * default group name, and the sheet's own Tab loop.
 *
 * Its PRESENTATION — a modal centred over the window rather than a form the footer expands into —
 * is `NewWorkspaceSheet.test.tsx`. Both drive it through `Sidebar`, because the sidebar is what
 * every route to the sheet goes through.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromePane, ChromeRepo, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const G1 = 'cccccccc-0000-4000-8000-000000000001';

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

/** alpha (top level) · squad[beta] — every workspace is blue, so the default must not be. */
function entries(groupName = 'squad'): ChromeSidebarEntry[] {
    return [
        { kind: 'workspace', workspace: workspace(W1, 'alpha') },
        {
            kind: 'group',
            group: { id: G1, name: groupName, color: 'green', icon: null, isCollapsed: false },
            workspaces: [workspace(W2, 'beta')]
        }
    ];
}

const REPOS: ChromeRepo[] = [
    { id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/wt/app' },
    { id: 'r2', name: 'infra', path: '/src/infra', worktreeBase: '/wt/infra' },
    { id: 'r3', name: 'docs', path: '/src/docs', worktreeBase: '/wt/docs' }
];

function base() {
    return { activeWorkspaceID: W1, filter: '', onFilterChange: vi.fn(), rowHeight: 20 };
}

/** Raises the New Workspace sheet from the footer's + button and returns the create spy. */
function openWorkspaceForm(props: Record<string, unknown> = {}) {
    const onCreateWorkspace = vi.fn().mockResolvedValue(null);
    render(
        <Sidebar
            {...base()}
            entries={entries()}
            profiles={['work', 'personal']}
            onCreateWorkspace={onCreateWorkspace as never}
            {...props}
        />
    );
    fireEvent.click(screen.getByTestId('sidebar-new-workspace'));
    return onCreateWorkspace;
}

/**
 * Raises the New Group sheet.
 *
 * It used to be a sibling text button in the footer; §WS-004 put it back where the Swift keeps
 * it — behind the chevron menu (`WorkspaceListView.swift:412-422`). With no
 * `onNewGroupWithRename` wired (assembly's ⌘⇧G one-shot) the row falls back to this sheet,
 * which is what these two cases are about.
 */
function openGroupForm(): void {
    fireEvent.click(screen.getByTestId('sidebar-new-menu-toggle'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^New Group/ }));
}

function selectedSwatch(kind: 'workspace' | 'group'): string | null {
    const row = screen.getByTestId(`new-${kind}-colors`);
    const chosen = within(row)
        .getAllByRole('radio')
        .find((button) => button.getAttribute('aria-checked') === 'true');
    return chosen?.getAttribute('aria-label') ?? null;
}

describe('the colour swatch row (§WS-075)', () => {
    it('opens on a colour that is NOT the trailing workspace’s', () => {
        openWorkspaceForm();
        const opened = selectedSwatch('workspace');
        expect(opened).not.toBeNull();
        // Every fixture workspace is blue, and the rule is "avoid the neighbour's colour".
        expect(opened).not.toBe('blue');
    });

    it('sends the swatch the user picks', async () => {
        const onCreateWorkspace = openWorkspaceForm();
        fireEvent.click(screen.getByTestId('new-workspace-color-purple'));
        expect(selectedSwatch('workspace')).toBe('purple');
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledWith(
                'ws',
                null,
                undefined,
                expect.objectContaining({ color: 'purple' })
            );
        });
    });

    it('is ONE tab stop, with the arrows cycling inside it (§WS-077)', () => {
        openWorkspaceForm();
        const row = screen.getByTestId('new-workspace-colors');
        row.focus();
        const start = selectedSwatch('workspace');
        fireEvent.keyDown(row, { key: 'ArrowRight' });
        const next = selectedSwatch('workspace');
        expect(next).not.toBe(start);
        fireEvent.keyDown(row, { key: 'ArrowLeft' });
        expect(selectedSwatch('workspace')).toBe(start);
    });
});

describe('the group picker (§WS-076)', () => {
    it('preselects the inherited group and can be flipped back to No group', async () => {
        const onCreateWorkspace = openWorkspaceForm({ inheritGroupID: G1 });
        const picker = screen.getByTestId('new-workspace-group') as HTMLSelectElement;
        expect(picker.value).toBe(G1);

        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.change(picker, { target: { value: '' } });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledWith('ws', null, undefined, expect.anything());
        });
    });

    it('sends the group the user chooses', async () => {
        const onCreateWorkspace = openWorkspaceForm();
        expect((screen.getByTestId('new-workspace-group') as HTMLSelectElement).value).toBe('');
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.change(screen.getByTestId('new-workspace-group'), { target: { value: G1 } });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledWith('ws', G1, undefined, expect.anything());
        });
    });

    it('is hidden when there are no groups to pick from', () => {
        render(
            <Sidebar
                {...base()}
                entries={[{ kind: 'workspace', workspace: workspace(W1, 'alpha') }]}
                onCreateWorkspace={vi.fn() as never}
            />
        );
        fireEvent.click(screen.getByTestId('sidebar-new-workspace'));
        expect(screen.queryByTestId('new-workspace-group')).toBeNull();
    });
});

describe('the profile picker (§SET-214)', () => {
    it('leads with the built-in default and sends anything else verbatim', async () => {
        const onCreateWorkspace = openWorkspaceForm();
        const picker = screen.getByTestId('new-workspace-profile') as HTMLSelectElement;
        expect([...picker.options].map((option) => option.value)).toEqual(['default', 'work', 'personal']);
        expect(picker.value).toBe('default');

        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.change(picker, { target: { value: 'work' } });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledWith(
                'ws',
                null,
                undefined,
                expect.objectContaining({ profile: 'work' })
            );
        });
        // `default` is "no assignment", so it rides as null rather than as a profile name.
        cleanup();
        const second = openWorkspaceForm();
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws2' } });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await waitFor(() => {
            expect(second).toHaveBeenCalledWith('ws2', null, undefined, expect.objectContaining({ profile: null }));
        });
    });
});

describe('the Repositories section (§WS-075/§WS-080)', () => {
    it('associates the repos chosen through the multi-select picker', async () => {
        const onCreateWorkspace = openWorkspaceForm({ repos: REPOS });
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));

        const picker = screen.getByTestId('new-workspace-repo-picker');
        fireEvent.click(within(picker).getByTestId('repo-choice-r1'));
        fireEvent.click(within(picker).getByTestId('repo-choice-r3'));
        fireEvent.click(within(picker).getByTestId('repo-picker-choose'));

        // Both rows land in the section, and the picker closes.
        expect(screen.queryByTestId('new-workspace-repo-picker')).toBeNull();
        expect(screen.getByTestId('new-workspace-repo-remove-r1')).toBeTruthy();
        expect(screen.getByTestId('new-workspace-repo-remove-r3')).toBeTruthy();

        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledWith(
                'ws',
                null,
                undefined,
                expect.objectContaining({ repoPaths: ['/src/app', '/src/docs'] })
            );
        });
    });

    it('offers only the repos that are not already chosen', () => {
        openWorkspaceForm({ repos: REPOS });
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        fireEvent.click(within(screen.getByTestId('new-workspace-repo-picker')).getByTestId('repo-choice-r2'));
        fireEvent.click(
            within(screen.getByTestId('new-workspace-repo-picker')).getByTestId('repo-picker-choose')
        );

        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        const reopened = screen.getByTestId('new-workspace-repo-picker');
        expect(within(reopened).getByTestId('repo-choice-r2').dataset['added']).toBe('true');
    });

    it('moves focus off a removed row before the array shrinks (§WS-080)', () => {
        openWorkspaceForm({ repos: REPOS });
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        const picker = screen.getByTestId('new-workspace-repo-picker');
        fireEvent.click(within(picker).getByTestId('repo-choice-r1'));
        fireEvent.click(within(picker).getByTestId('repo-choice-r2'));
        fireEvent.click(within(picker).getByTestId('repo-picker-choose'));

        const first = screen.getByTestId('new-workspace-repo-remove-r1');
        first.focus();
        fireEvent.click(first);
        // The successor row takes the focus, so the Tab loop is never stranded.
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-repo-remove-r2'));

        const last = screen.getByTestId('new-workspace-repo-remove-r2');
        last.focus();
        fireEvent.click(last);
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-add-repo'));
    });

    it('is hidden when the registry is empty', () => {
        openWorkspaceForm();
        expect(screen.queryByTestId('new-workspace-repos')).toBeNull();
    });
});

describe('the Tab loop (§WS-077)', () => {
    it('walks the Swift’s Field order — name → colours → group → profile → repos → Cancel → Create — and wraps', () => {
        openWorkspaceForm({ repos: REPOS });
        const name = screen.getByLabelText('New workspace name');
        fireEvent.change(name, { target: { value: 'ws' } }); // enables Create, so it joins
        name.focus();

        const step = (): Element | null => {
            fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });
            return document.activeElement;
        };
        expect(step()).toBe(screen.getByTestId('new-workspace-colors'));
        expect(step()).toBe(screen.getByTestId('new-workspace-group'));
        expect(step()).toBe(screen.getByTestId('new-workspace-profile'));
        expect(step()).toBe(screen.getByTestId('new-workspace-add-repo'));
        expect(step()).toBe(screen.getByTestId('new-workspace-worktree-toggle'));
        // `NewWorkspaceSheet.swift:394-397`: Cancel, then Create.
        expect(step()).toBe(screen.getByTestId('new-workspace-cancel'));
        expect(step()).toBe(screen.getByTestId('new-workspace-submit'));
        // …and round again.
        expect(step()).toBe(name);
        // Shift+Tab walks it backwards.
        fireEvent.keyDown(document.activeElement as Element, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-submit'));
    });

    it('omits a disabled Create from the loop, but never Cancel', () => {
        openWorkspaceForm();
        const name = screen.getByLabelText('New workspace name');
        name.focus();
        for (let i = 0; i < 3; i += 1) {
            fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });
        }
        // name → colours → group → profile…
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-profile'));
        // …then Cancel, which is always reachable — a sheet whose only way out is the mouse is
        // the defect the Swift's own `.cancel` stop exists to prevent…
        fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-cancel'));
        // …and the next stop wraps past the disabled Create.
        fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });
        expect(document.activeElement).toBe(name);
    });
});

describe('the New Group sheet (§WS-082/§WS-083)', () => {
    it('pre-fills a unique default name', () => {
        render(<Sidebar {...base()} entries={entries('New Group')} onCreateGroup={vi.fn()} />);
        openGroupForm();
        expect((screen.getByLabelText('New group name') as HTMLInputElement).value).toBe('New Group 2');
    });

    it('offers a colour row including "None", and sends what is picked', () => {
        const onCreateGroup = vi.fn();
        render(<Sidebar {...base()} entries={entries()} onCreateGroup={onCreateGroup} />);
        openGroupForm();
        // The group sheet opens on "None" (unlike the workspace sheet's random colour).
        expect(selectedSwatch('group')).toBe('No color');
        fireEvent.click(screen.getByTestId('new-group-color-orange'));
        fireEvent.submit(screen.getByTestId('new-group-form'));
        expect(onCreateGroup).toHaveBeenCalledWith('New Group', 'orange');
    });
});

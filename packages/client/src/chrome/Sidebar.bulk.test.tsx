/**
 * The multi-select bulk menu (§WS-053…§WS-060), the New Workspace form's worktree section
 * (§WS-078/§WS-079), and the sidebar's resize handle (§WS-002).
 *
 * The bulk menu is the half of §5.6 the port never had: right-clicking a row that belongs to a
 * ≥2 selection has to swap the WHOLE menu, and every action has to leave as one command for the
 * whole selection — which is what these assert, callback by callback.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar, SidebarResizer, clampSidebarWidth, readStoredSidebarWidth, storeSidebarWidth } from './index';
import type { ChromePane, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const W3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const G1 = 'cccccccc-0000-4000-8000-000000000001';

function pane(id: string): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/w',
        gitBranch: null,
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function workspace(id: string, name: string, labels: string[] = []): ChromeWorkspace {
    return { id, name, color: 'blue', icon: null, labels, panes: [pane(`${id}-p`)] };
}

/** alpha (labels: infra) · beta (labels: infra, ops) top level; gamma inside a group. */
function entries(): ChromeSidebarEntry[] {
    return [
        { kind: 'workspace', workspace: workspace(W1, 'alpha', ['infra']) },
        { kind: 'workspace', workspace: workspace(W2, 'beta', ['infra', 'ops']) },
        {
            kind: 'group',
            group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
            workspaces: [workspace(W3, 'gamma')]
        }
    ];
}

const PRESETS = [
    { name: 'infra', color: { kind: 'named', color: 'blue' } as const },
    { name: 'release', color: { kind: 'named', color: 'red' } as const }
];

function base() {
    return { activeWorkspaceID: W1, filter: '', onFilterChange: vi.fn(), rowHeight: 20 };
}

/** Right-click the first row with `[W1, W2]` selected — the bulk gesture. */
function openBulkMenu(props: Record<string, unknown> = {}): void {
    render(
        <Sidebar
            {...base()}
            entries={entries()}
            labelPresets={PRESETS}
            selectedWorkspaceIDs={new Set([W1, W2])}
            {...props}
        />
    );
    fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
}

describe('bulk context menu', () => {
    it('swaps the whole menu and heads it with the selection count', () => {
        openBulkMenu();
        const menu = screen.getByTestId('context-menu');
        expect(within(menu).getByText('2 workspaces selected')).toBeTruthy();
        expect(within(menu).getByText('Color 2 Workspaces')).toBeTruthy();
        expect(within(menu).getByText('Delete 2 Workspaces…')).toBeTruthy();
        // The single-row items are gone: this is a different menu, not an augmented one.
        expect(within(menu).queryByText('Rename…')).toBeNull();
        expect(within(menu).queryByText('Change Icon')).toBeNull();
    });

    it('keeps the single-row menu for a row OUTSIDE the selection', () => {
        render(
            <Sidebar
                {...base()}
                entries={entries()}
                selectedWorkspaceIDs={new Set([W2, W3])}
                labelPresets={PRESETS}
            />
        );
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        expect(screen.getByText('Rename…')).toBeTruthy();
        expect(screen.queryByText('2 workspaces selected')).toBeNull();
    });

    it('applies one colour to the whole selection in a single call', () => {
        const onSetBulkColor = vi.fn();
        openBulkMenu({ onSetBulkColor });
        fireEvent.mouseEnter(screen.getByText('Color 2 Workspaces'));
        fireEvent.click(within(screen.getByTestId('context-submenu')).getByText('purple'));
        expect(onSetBulkColor).toHaveBeenCalledTimes(1);
        expect(onSetBulkColor).toHaveBeenCalledWith([W1, W2], 'purple');
    });

    it('renders the label tri-state and toggles the whole selection to one state', () => {
        const onSetBulkLabel = vi.fn();
        openBulkMenu({ onSetBulkLabel });
        fireEvent.mouseEnter(screen.getByText('Label 2 Workspaces'));
        const submenu = screen.getByTestId('context-submenu');
        const rows = within(submenu)
            .getAllByRole('menuitem')
            .map((row) => (row.textContent ?? '').trim());
        // infra: on both → checkmark. release: on neither → plain. ops: on beta only → dash.
        expect(rows).toEqual(['✓infra', 'release', '–ops']);

        // Applied to ALL → clicking removes it from all.
        fireEvent.click(within(submenu).getByText('infra'));
        expect(onSetBulkLabel).toHaveBeenCalledWith([W1, W2], 'infra', false);

        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Label 2 Workspaces'));
        // Applied to SOME → clicking applies it to all.
        fireEvent.click(within(screen.getByTestId('context-submenu')).getByText('ops'));
        expect(onSetBulkLabel).toHaveBeenLastCalledWith([W1, W2], 'ops', true);
    });

    it('moves the selection into a group atomically, dimming a group they all already share', () => {
        const onMoveWorkspaces = vi.fn();
        openBulkMenu({ onMoveWorkspaces });
        fireEvent.mouseEnter(screen.getByText('Move 2 Workspaces to Group'));
        fireEvent.click(within(screen.getByTestId('context-submenu')).getByText('squad'));
        expect(onMoveWorkspaces).toHaveBeenCalledTimes(1);
        expect(onMoveWorkspaces).toHaveBeenCalledWith({ workspaceIDs: [W1, W2], groupID: G1, index: 1 });
    });

    it('creates a group around the selection through the footer form', async () => {
        const onCreateGroupForWorkspaces = vi.fn();
        const onSelectionChange = vi.fn();
        openBulkMenu({ onCreateGroupForWorkspaces, onSelectionChange });
        fireEvent.click(screen.getByText('Group 2 Workspaces…'));
        const input = screen.getByLabelText('New group name') as HTMLInputElement;
        // §WS-082's line, and §WS-083's pre-filled unique default name.
        expect(screen.getByTestId('new-group-count').textContent).toBe('Group 2 selected workspaces.');
        expect(input.value).toBe('New Group');
        fireEvent.change(input, { target: { value: 'Review' } });
        fireEvent.submit(screen.getByTestId('new-group-form'));
        await waitFor(() => {
            // The third argument is the colour row's choice — "None" unless one is picked.
            expect(onCreateGroupForWorkspaces).toHaveBeenCalledWith('Review', [W1, W2], null);
        });
        // The new header becomes the anchor, so the selection is released (§5.6).
        expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
    });

    it('deletes the selection after ONE confirmation naming the count', () => {
        const onDeleteWorkspaces = vi.fn();
        openBulkMenu({ onDeleteWorkspaces });
        fireEvent.click(screen.getByText('Delete 2 Workspaces…'));
        expect(onDeleteWorkspaces).not.toHaveBeenCalled();
        const dialog = screen.getByTestId('confirm-dialog');
        expect(within(dialog).getByText('Delete 2 workspaces?')).toBeTruthy();
        expect(dialog.textContent).toContain('This cannot be undone.');
        fireEvent.click(within(dialog).getByText('Delete'));
        expect(onDeleteWorkspaces).toHaveBeenCalledWith([W1, W2]);
    });

    it('refuses to delete the entire list', () => {
        render(
            <Sidebar
                {...base()}
                entries={entries()}
                selectedWorkspaceIDs={new Set([W1, W2, W3])}
                onDeleteWorkspaces={vi.fn()}
            />
        );
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        const item = screen
            .getAllByRole('menuitem')
            .find((row) => (row.textContent ?? '').startsWith('Delete 3 Workspaces'));
        expect(item?.getAttribute('aria-disabled')).toBe('true');
        // …and so is "Select All", since everything already is.
        const selectAll = screen
            .getAllByRole('menuitem')
            .find((row) => (row.textContent ?? '').startsWith('Select All'));
        expect(selectAll?.getAttribute('aria-disabled')).toBe('true');
    });

    it('offers Select All / Deselect All on the single-row menu too (§WS-053)', () => {
        const onSelectionChange = vi.fn();
        render(<Sidebar {...base()} entries={entries()} onSelectionChange={onSelectionChange} />);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        // Nothing is selected yet, so "Deselect All" is not offered.
        expect(screen.queryByText('Deselect All')).toBeNull();
        fireEvent.click(screen.getByText('Select All Workspaces'));
        // Every workspace, INCLUDING the one inside the group (§WS-045).
        expect(onSelectionChange).toHaveBeenCalledWith(new Set([W1, W2, W3]));
    });
});

describe('New Workspace form — create git worktree (§WS-078/§WS-079)', () => {
    const repos = [
        { id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/Users/t/nex/worktrees/app' },
        { id: 'r2', name: 'infra', path: '/src/infra', worktreeBase: '/Users/t/nex/worktrees/infra' }
    ];

    function openForm(onCreateWorkspace: (...args: never[]) => unknown): void {
        render(
            <Sidebar
                {...base()}
                entries={entries()}
                repos={repos}
                onCreateWorkspace={onCreateWorkspace as never}
            />
        );
        fireEvent.click(screen.getByTestId('sidebar-new-workspace'));
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
    }

    it('mirrors the name into the branch and previews the sanitized path', () => {
        openForm(vi.fn());
        fireEvent.change(screen.getByTestId('new-workspace-worktree-name'), {
            target: { value: 'Fix Login Bug' }
        });
        const preview = screen.getByTestId('new-workspace-worktree-preview');
        expect(preview.textContent).toContain('/Users/t/nex/worktrees/app/Fix-Login-Bug');
        expect(preview.textContent).toContain('branch: Fix-Login-Bug');

        // Hand-editing the branch stops the mirroring for good.
        fireEvent.change(screen.getByTestId('new-workspace-worktree-branch'), {
            target: { value: 'feature/login' }
        });
        fireEvent.change(screen.getByTestId('new-workspace-worktree-name'), { target: { value: 'other' } });
        expect((screen.getByTestId('new-workspace-worktree-branch') as HTMLInputElement).value).toBe(
            'feature/login'
        );
    });

    it('keeps Create disabled until both names sanitize, then sends the whole request', async () => {
        const onCreateWorkspace = vi.fn().mockResolvedValue(null);
        openForm(onCreateWorkspace);
        const submit = screen.getByTestId('new-workspace-submit') as HTMLButtonElement;
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'Login fix' } });
        // A worktree name that sanitizes to nothing keeps Create out of reach.
        fireEvent.change(screen.getByTestId('new-workspace-worktree-name'), { target: { value: '///' } });
        expect(submit.disabled).toBe(true);

        fireEvent.change(screen.getByTestId('new-workspace-worktree-name'), { target: { value: 'login' } });
        fireEvent.click(screen.getByTestId('new-workspace-worktree-update-main'));
        expect(submit.disabled).toBe(false);
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledWith(
                'Login fix',
                null,
                {
                    repoID: 'r1',
                    name: 'login',
                    branch: 'login',
                    updateMain: true
                },
                // §WS-075's extras ride along: the swatch (a random colour that avoids the
                // neighbour's), the profile, and the repos chosen for association.
                { color: expect.any(String) as unknown as string, profile: null, repoPaths: [] }
            );
        });
    });

    it('keeps the form open with the daemon’s message when the worktree add fails', async () => {
        let settle: ((value: string | null) => void) | null = null;
        const onCreateWorkspace = vi.fn().mockImplementation(
            () =>
                new Promise<string | null>((resolve) => {
                    settle = resolve;
                })
        );
        openForm(onCreateWorkspace);
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.change(screen.getByTestId('new-workspace-worktree-name'), { target: { value: 'login' } });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));

        // §WS-079: a second Create is refused while `git worktree add` is still running.
        await waitFor(() => {
            expect((screen.getByTestId('new-workspace-submit') as HTMLButtonElement).disabled).toBe(true);
        });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        expect(onCreateWorkspace).toHaveBeenCalledTimes(1);

        await waitFor(() => {
            expect(settle).not.toBeNull();
        });
        (settle as unknown as (value: string | null) => void)("fatal: 'login' already exists");
        await waitFor(() => {
            expect(screen.getByTestId('new-workspace-error').textContent).toContain('already exists');
        });
        // Still open, and Create is live again for the retry.
        expect(screen.getByTestId('new-workspace-form')).toBeTruthy();
        expect((screen.getByTestId('new-workspace-submit') as HTMLButtonElement).disabled).toBe(false);
    });

    it('hides the section entirely when no repo is registered', () => {
        render(<Sidebar {...base()} entries={entries()} onCreateWorkspace={vi.fn()} />);
        fireEvent.click(screen.getByTestId('sidebar-new-workspace'));
        expect(screen.queryByTestId('new-workspace-worktree-toggle')).toBeNull();
    });
});

describe('sidebar resize (§WS-002 / §APP-065)', () => {
    it('clamps to 180–300 and defaults to 220', () => {
        expect(clampSidebarWidth(220)).toBe(220);
        expect(clampSidebarWidth(10)).toBe(180);
        expect(clampSidebarWidth(9999)).toBe(300);
        expect(clampSidebarWidth(Number.NaN)).toBe(220);
    });

    it('round-trips through storage and survives a corrupt value', () => {
        const store = new Map<string, string>();
        const storage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => {
                store.set(key, value);
            }
        } as unknown as Storage;
        expect(readStoredSidebarWidth(storage)).toBe(220);
        storeSidebarWidth(999, storage);
        expect(readStoredSidebarWidth(storage)).toBe(300);
        store.set('nex.sidebar.width', 'not-a-number');
        expect(readStoredSidebarWidth(storage)).toBe(220);
    });

    it('drags from the gesture-start snapshot, not compounding, and clamps live', () => {
        const onResize = vi.fn();
        const onCommit = vi.fn();
        render(<SidebarResizer width={220} onResize={onResize} onCommit={onCommit} />);
        const handle = screen.getByTestId('sidebar-resizer');
        expect(handle.getAttribute('aria-valuenow')).toBe('220');

        // A REAL bubbling mouse-shaped event: jsdom has no `PointerEvent`, and Testing
        // Library's synthesized one arrives without `clientX`, which would make the drag
        // measure from NaN and hide the very thing this asserts.
        handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 220, button: 0, bubbles: true }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 260 }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 280 }));
        // Second move is measured from the START (220 + 60), not from the first result.
        expect(onResize.mock.calls.map((call) => call[0])).toEqual([260, 280]);

        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 700 }));
        expect(onResize).toHaveBeenLastCalledWith(300);
        window.dispatchEvent(new MouseEvent('pointerup', { clientX: 700 }));
        expect(onCommit).toHaveBeenCalledWith(300);

        // The listeners are gone: a stray move after the release must not resize anything.
        onResize.mockClear();
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100 }));
        expect(onResize).not.toHaveBeenCalled();
    });
});

// ── Escape clears the multi-selection (§SET-186 / §APP-109) ─────────────────────────

describe('escape handle', () => {
    /**
     * The predicate assembly's key dispatcher calls at §7.2 step 2 — before any binding
     * lookup, so it beats the default `escape=close_search`. The sidebar answers rather than
     * assembly deciding, because only the sidebar knows whether one of its own overlays is up
     * and should eat the key itself.
     */
    function mount(props: Record<string, unknown> = {}): { current: (() => boolean) | null } {
        const ref: { current: (() => boolean) | null } = { current: null };
        render(<Sidebar {...base()} entries={entries()} labelPresets={PRESETS} escapeRef={ref} {...props} />);
        return ref;
    }

    /** The real call site is a window keydown handler, so the state flush has to be acted. */
    function pressEscape(ref: { current: (() => boolean) | null }): boolean {
        let consumed = false;
        act(() => {
            consumed = ref.current?.() ?? false;
        });
        return consumed;
    }

    function selectedIDs(): string[] {
        return screen
            .getAllByTestId('workspace-row')
            .filter((row) => row.dataset['selected'] === 'true')
            .map((row) => row.dataset['workspaceId'] ?? '');
    }

    it('declines when nothing is selected, so Escape reaches close_search', () => {
        const ref = mount();
        expect(ref.current).toBeTypeOf('function');
        expect(pressEscape(ref)).toBe(false);
    });

    it('clears a multi-selection and reports the key consumed', () => {
        const onSelectionChange = vi.fn();
        const ref = mount({ onSelectionChange });

        // Build the selection the way a user does: ⌘-click two rows.
        fireEvent.click(screen.getAllByTestId('workspace-row')[0] as HTMLElement, { metaKey: true });
        fireEvent.click(screen.getAllByTestId('workspace-row')[1] as HTMLElement, { metaKey: true });
        expect(selectedIDs()).toEqual([W1, W2]);

        expect(pressEscape(ref)).toBe(true);
        expect(selectedIDs()).toEqual([]);
        expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());

        // …and a second Escape declines, so the key falls through again.
        expect(pressEscape(ref)).toBe(false);
    });

    it('yields to an open context menu, which owns Escape itself', () => {
        const ref = mount();
        fireEvent.click(screen.getAllByTestId('workspace-row')[0] as HTMLElement, { metaKey: true });
        fireEvent.click(screen.getAllByTestId('workspace-row')[1] as HTMLElement, { metaKey: true });
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        expect(screen.getByTestId('context-menu')).toBeTruthy();

        // The menu is up: the selection survives and the sidebar does not consume the key.
        expect(pressEscape(ref)).toBe(false);
        expect(selectedIDs()).toEqual([W1, W2]);

        // The menu's own Escape closes it; the next Escape then clears the selection.
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('context-menu')).toBeNull();
        expect(pressEscape(ref)).toBe(true);
        expect(selectedIDs()).toEqual([]);
    });

    it('is nulled on unmount, so a torn-down sidebar cannot consume a key', () => {
        const ref = mount();
        cleanup();
        expect(ref.current).toBeNull();
    });
});

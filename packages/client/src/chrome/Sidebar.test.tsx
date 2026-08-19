import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromePane, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001'; // alpha  (top level)
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002'; // beta   (in squad)
const W3 = 'aaaaaaaa-0000-4000-8000-000000000003'; // gamma  (in squad)
const W4 = 'aaaaaaaa-0000-4000-8000-000000000004'; // delta  (top level)
const G1 = 'cccccccc-0000-4000-8000-000000000001';

function pane(id: string, overrides: Partial<ChromePane> = {}): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test/code',
        gitBranch: 'main',
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0,
        ...overrides
    };
}

function workspace(id: string, name: string, overrides: Partial<ChromeWorkspace> = {}): ChromeWorkspace {
    return {
        id,
        name,
        color: 'blue',
        icon: null,
        labels: [],
        panes: [pane(`${id}-p1`)],
        ...overrides
    };
}

/** alpha · delta · squad[beta, gamma] — the order a daemon snapshot actually produces. */
function entries(overrides: { collapsed?: boolean; alphaPanes?: readonly ChromePane[] } = {}): ChromeSidebarEntry[] {
    return [
        {
            kind: 'workspace',
            workspace: workspace(W1, 'alpha', {
                labels: ['infra', 'api', 'web', 'extra'],
                ...(overrides.alphaPanes === undefined ? {} : { panes: overrides.alphaPanes })
            })
        },
        { kind: 'workspace', workspace: workspace(W4, 'delta') },
        {
            kind: 'group',
            group: {
                id: G1,
                name: 'squad',
                color: 'green',
                icon: null,
                isCollapsed: overrides.collapsed ?? false
            },
            workspaces: [workspace(W2, 'beta'), workspace(W3, 'gamma')]
        }
    ];
}

function noopProps() {
    return { activeWorkspaceID: W1, filter: '', onFilterChange: vi.fn(), rowHeight: 20 };
}

function rowIDs(): string[] {
    return screen
        .getAllByTestId('workspace-row')
        .map((row) => row.getAttribute('data-workspace-id') ?? '');
}

describe('rendering', () => {
    it('renders workspaces and groups in daemon order, with ⌘N badges from visibleWorkspaceOrder', () => {
        render(<Sidebar {...noopProps()} entries={entries()} />);
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);
        expect(screen.getAllByTestId('cmd-badge').map((el) => el.textContent)).toEqual([
            '⌘1',
            '⌘2',
            '⌘3',
            '⌘4'
        ]);
        expect(screen.getByTestId('group-header')).toHaveProperty('dataset.collapsed', 'false');
    });

    it('marks the active row and indents group members', () => {
        render(<Sidebar {...noopProps()} entries={entries()} />);
        const rows = screen.getAllByTestId('workspace-row');
        expect(rows.map((row) => row.dataset['active'])).toEqual(['true', 'false', 'false', 'false']);
        expect(rows.map((row) => row.dataset['depth'])).toEqual(['0', '0', '1', '1']);
    });

    it('shows at most three label chips plus an overflow count, branch and pane count', () => {
        render(<Sidebar {...noopProps()} entries={entries()} />);
        const alpha = screen.getAllByTestId('workspace-row')[0] as HTMLElement;
        expect(within(alpha).getAllByTestId('label-chip').map((chip) => chip.textContent)).toEqual([
            'infra',
            'api',
            'web'
        ]);
        expect(within(alpha).getByText('+1')).toBeDefined();
        expect(within(alpha).getByTestId('row-branch').textContent).toContain('main');
        expect(within(alpha).getByTestId('row-pane-count').textContent).toBe('1 pane');
    });

    it('shows the agent dot with waiting beating running', () => {
        render(
            <Sidebar
                {...noopProps()}
                entries={entries({
                    alphaPanes: [
                        pane('p-run', { status: 'running' }),
                        pane('p-wait', { status: 'waitingForInput' })
                    ]
                })}
            />
        );
        const alpha = screen.getAllByTestId('workspace-row')[0] as HTMLElement;
        expect(within(alpha).getByTestId('status-dot').dataset['status']).toBe('waiting');
        expect(within(alpha).getByTestId('row-running').textContent).toContain('1');
        expect(within(alpha).getByTestId('row-waiting').textContent).toContain('1');
    });

    it('activates a workspace on click', () => {
        const onActivateWorkspace = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onActivateWorkspace={onActivateWorkspace} />);
        fireEvent.click(screen.getAllByTestId('workspace-row')[1] as HTMLElement);
        expect(onActivateWorkspace).toHaveBeenCalledWith(W4);
    });
});

describe('group collapse', () => {
    it('hides members, re-indexes ⌘N badges and reports the toggle', () => {
        const onToggleGroupCollapse = vi.fn();
        render(
            <Sidebar {...noopProps()} entries={entries()} onToggleGroupCollapse={onToggleGroupCollapse} />
        );
        fireEvent.click(screen.getByTestId('group-chevron'));

        expect(rowIDs()).toEqual([W1, W4]);
        expect(screen.getAllByTestId('cmd-badge').map((el) => el.textContent)).toEqual(['⌘1', '⌘2']);
        // No wire verb yet: the sidebar collapses locally AND raises the callback.
        expect(onToggleGroupCollapse).toHaveBeenCalledWith(G1, true);
    });

    it('starts collapsed when the daemon says so, and expands on click', () => {
        render(<Sidebar {...noopProps()} entries={entries({ collapsed: true })} />);
        expect(rowIDs()).toEqual([W1, W4]);
        fireEvent.click(screen.getByTestId('group-chevron'));
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);
    });
});

describe('context menus (portal-based)', () => {
    it('opens on right-click and survives a 1s agent-status re-render (§15)', () => {
        const view = render(<Sidebar {...noopProps()} entries={entries()} />);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        expect(screen.getByTestId('context-menu')).toBeDefined();

        // Open a submenu too — the bug this guards against destroyed those as well.
        fireEvent.mouseEnter(screen.getByText('Color'));
        expect(screen.getByTestId('context-submenu')).toBeDefined();

        // The status tick: a new entries array with a changed pane status, exactly what a
        // delta produces every second while an agent runs.
        view.rerender(
            <Sidebar
                {...noopProps()}
                entries={entries({ alphaPanes: [pane('p-run', { status: 'running' })] })}
            />
        );

        expect(screen.getByTestId('context-menu')).toBeDefined();
        expect(screen.getByTestId('context-submenu')).toBeDefined();
    });

    it('opens clear of the row it acts on (run-B m7)', () => {
        render(<Sidebar {...noopProps()} entries={entries()} />);
        const row = screen.getAllByTestId('workspace-row')[0] as HTMLElement;
        // jsdom has no box model, so the row is given one: 44px tall, 120px down the sidebar.
        row.getBoundingClientRect = () =>
            ({ top: 120, bottom: 164, left: 0, right: 240, width: 240, height: 44, x: 0, y: 120 }) as DOMRect;

        fireEvent.contextMenu(row, { clientX: 40, clientY: 140 });

        const menu = screen.getByTestId('context-menu');
        expect(Number.parseInt(menu.style.top, 10)).toBeGreaterThanOrEqual(164);
    });

    it('closes on an outside mousedown', () => {
        render(<Sidebar {...noopProps()} entries={entries()} />);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseDown(document.body);
        expect(screen.queryByTestId('context-menu')).toBeNull();
    });

    it('sets a color through the submenu', () => {
        const onSetWorkspaceColor = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onSetWorkspaceColor={onSetWorkspaceColor} />);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Color'));
        fireEvent.click(within(screen.getByTestId('context-submenu')).getByText('purple'));
        expect(onSetWorkspaceColor).toHaveBeenCalledWith(W1, 'purple');
        expect(screen.queryByTestId('context-menu')).toBeNull();
    });

    it('toggles a label preset from the Labels submenu', () => {
        const onToggleWorkspaceLabel = vi.fn();
        render(
            <Sidebar
                {...noopProps()}
                entries={entries()}
                labelPresets={[
                    { name: 'infra', color: { kind: 'named', color: 'blue' } },
                    { name: 'ops', color: { kind: 'named', color: 'red' } }
                ]}
                onToggleWorkspaceLabel={onToggleWorkspaceLabel}
            />
        );
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Labels'));
        const submenu = screen.getByTestId('context-submenu');
        fireEvent.click(within(submenu).getByText('ops'));
        expect(onToggleWorkspaceLabel).toHaveBeenCalledWith(W1, 'ops', true);
    });

    it('deletes only after the confirmation', () => {
        const onDeleteWorkspace = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onDeleteWorkspace={onDeleteWorkspace} />);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.click(screen.getByText('Delete'));
        expect(onDeleteWorkspace).not.toHaveBeenCalled();

        const dialog = screen.getByTestId('confirm-dialog');
        fireEvent.click(within(dialog).getByText('Delete'));
        expect(onDeleteWorkspace).toHaveBeenCalledWith(W1);
        expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });

    it('renames a group inline through the menu', () => {
        const onRenameGroup = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onRenameGroup={onRenameGroup} />);
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.click(screen.getByText('Rename…'));

        const input = screen.getByLabelText('Rename squad') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'platform' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onRenameGroup).toHaveBeenCalledWith(G1, 'platform');
    });

    it('offers New Workspace / New Group on the background', () => {
        const onCreateGroup = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onCreateGroup={onCreateGroup} />);
        fireEvent.contextMenu(screen.getByTestId('sidebar-spacer'));
        // Scoped: the footer carries a "New Group" button of its own.
        fireEvent.click(within(screen.getByTestId('context-menu')).getByText('New Group'));

        const input = screen.getByLabelText('New group name') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'platform' } });
        fireEvent.submit(screen.getByTestId('new-group-form'));
        expect(onCreateGroup).toHaveBeenCalledWith('platform');
    });
});

describe('drag & drop', () => {
    /**
     * Rows are 20px with the 4px content padding, so:
     *   alpha 4–24 · delta 24–44 · header 44–64 · beta 64–84 · gamma 84–104.
     * Dragging alpha to y=95 is gamma's bottom half → into `squad` at post-remove index 2.
     */
    it('live-applies a shadow order and commits exactly ONE move on release', () => {
        const onMoveWorkspace = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onMoveWorkspace={onMoveWorkspace} />);

        fireEvent.mouseDown(screen.getAllByTestId('workspace-row')[0] as HTMLElement, { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 95 });

        // Live-applied locally: alpha now renders as the group's last child…
        expect(rowIDs()).toEqual([W4, W2, W3, W1]);
        expect((screen.getAllByTestId('workspace-row')[3] as HTMLElement).dataset['depth']).toBe('1');
        // …and NOTHING has been sent to the daemon yet.
        expect(onMoveWorkspace).not.toHaveBeenCalled();

        fireEvent.mouseUp(window);
        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
        expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: W1, groupID: G1, index: 2 });
    });

    it('collapses a whole drag gesture into one commit, however many moves it took', () => {
        const onMoveWorkspace = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onMoveWorkspace={onMoveWorkspace} />);

        fireEvent.mouseDown(screen.getAllByTestId('workspace-row')[0] as HTMLElement, { clientY: 10 });
        for (const clientY of [30, 50, 70, 95, 70, 30]) fireEvent.mouseMove(window, { clientY });
        fireEvent.mouseUp(window);

        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
    });

    it('does not move below the 5px threshold, and commits nothing when the row lands home', () => {
        const onMoveWorkspace = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onMoveWorkspace={onMoveWorkspace} />);

        fireEvent.mouseDown(screen.getAllByTestId('workspace-row')[0] as HTMLElement, { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 13 });
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);
        fireEvent.mouseUp(window);
        expect(onMoveWorkspace).not.toHaveBeenCalled();

        fireEvent.mouseDown(screen.getAllByTestId('workspace-row')[0] as HTMLElement, { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 8 }); // back over alpha's own top half
        fireEvent.mouseUp(window);
        expect(onMoveWorkspace).not.toHaveBeenCalled();
    });

    it('the click that follows a drag does not activate the dragged row', () => {
        const onActivateWorkspace = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onActivateWorkspace={onActivateWorkspace} />);

        const row = screen.getAllByTestId('workspace-row')[0] as HTMLElement;
        fireEvent.mouseDown(row, { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 95 });
        fireEvent.mouseUp(window);
        fireEvent.click(row); // the browser's synthetic click after the gesture
        expect(onActivateWorkspace).not.toHaveBeenCalled();

        // …and the NEXT click is a normal activation again.
        fireEvent.click(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        expect(onActivateWorkspace).toHaveBeenCalledTimes(1);
    });

    it('a group header target is preview-only during the drag, applied on release', () => {
        const onMoveWorkspace = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onMoveWorkspace={onMoveWorkspace} />);

        fireEvent.mouseDown(screen.getAllByTestId('workspace-row')[0] as HTMLElement, { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 58 }); // the header's bottom half

        // The order is NOT live-applied (the cursor transits headers constantly, §5.5) —
        // the header tints instead.
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);
        expect(screen.getByTestId('group-header').dataset['dropPreview']).toBe('true');

        fireEvent.mouseUp(window);
        expect(screen.getByTestId('group-header').dataset['dropPreview']).toBe('false');
        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
        expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: W1, groupID: G1, index: 2 });
    });

    it('a group header drag moves the whole block once', () => {
        const onMoveGroup = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onMoveGroup={onMoveGroup} />);

        fireEvent.mouseDown(screen.getByTestId('group-header'), { clientY: 50 });
        fireEvent.mouseMove(window, { clientY: 6 }); // alpha's span, top half → index 0
        fireEvent.mouseUp(window);

        expect(onMoveGroup).toHaveBeenCalledTimes(1);
        expect(onMoveGroup).toHaveBeenCalledWith({ groupID: G1, index: 0 });
    });
});

describe('filter field', () => {
    it('renders a flat list with the group caption and no ⌘N badges', () => {
        render(<Sidebar {...noopProps()} entries={entries()} filter="ta" />);
        expect(screen.getByTestId('sidebar-filtered')).toBeDefined();
        expect(rowIDs()).toEqual([W4, W2]);
        expect(screen.queryAllByTestId('cmd-badge')).toHaveLength(0);
        expect(screen.getByText('in squad')).toBeDefined();
    });

    it('descends into a collapsed group (find-anything)', () => {
        render(<Sidebar {...noopProps()} entries={entries({ collapsed: true })} filter="beta" />);
        expect(rowIDs()).toEqual([W2]);
    });

    it('Enter activates the first match and clears the filter', () => {
        const onActivateWorkspace = vi.fn();
        const onFilterChange = vi.fn();
        render(
            <Sidebar
                {...noopProps()}
                entries={entries()}
                filter="ta"
                onFilterChange={onFilterChange}
                onActivateWorkspace={onActivateWorkspace}
            />
        );
        fireEvent.keyDown(screen.getByLabelText('Filter workspaces or labels'), { key: 'Enter' });
        expect(onActivateWorkspace).toHaveBeenCalledWith(W4);
        expect(onFilterChange).toHaveBeenCalledWith('');
    });

    it('shows the empty state', () => {
        render(<Sidebar {...noopProps()} entries={entries()} filter="zzz" />);
        expect(screen.getByText('No matches')).toBeDefined();
        expect(screen.queryAllByTestId('workspace-row')).toHaveLength(0);
    });
});

describe('selection', () => {
    it('cmd-click multi-selects and shows the selection header', () => {
        const onActivateWorkspace = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onActivateWorkspace={onActivateWorkspace} />);
        fireEvent.click(screen.getAllByTestId('workspace-row')[1] as HTMLElement, { metaKey: true });
        expect(onActivateWorkspace).not.toHaveBeenCalled();
        expect(screen.getByTestId('selection-header').textContent).toContain('1 selected');

        fireEvent.click(screen.getByText('Clear'));
        expect(screen.queryByTestId('selection-header')).toBeNull();
    });
});

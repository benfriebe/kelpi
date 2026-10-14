/**
 * Nested workspaces in the sidebar (app-state-core.md §2.9): a parent row's chevron and its
 * rollup while collapsed, the row menu's nesting verbs, and the delete dialog's "also delete
 * nested workspaces" choice.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromePane, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const PARENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const CHILD_A = 'aaaaaaaa-0000-4000-8000-000000000002';
const CHILD_B = 'aaaaaaaa-0000-4000-8000-000000000003';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000004';

function pane(id: string, status: ChromePane['status'] = 'idle'): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test/code',
        gitBranch: null,
        status,
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function workspace(id: string, name: string, extra: Partial<ChromeWorkspace> = {}): ChromeWorkspace {
    return { id, name, color: 'blue', icon: null, labels: [], panes: [pane(`${id}-p1`)], ...extra };
}

function entries(options: { collapsed?: boolean; waitingChild?: boolean } = {}): ChromeSidebarEntry[] {
    const parent = workspace(PARENT, 'orchestrator', {
        childOrder: [CHILD_A, CHILD_B],
        childrenCollapsed: options.collapsed === true
    });
    const childA = workspace(CHILD_A, 'worker-a', {
        panes: [pane(`${CHILD_A}-p1`, options.waitingChild === true ? 'waitingForInput' : 'idle')]
    });
    const childB = workspace(CHILD_B, 'worker-b');
    return [
        { kind: 'workspace', workspace: parent, nested: new Map([[PARENT, [childA, childB]]]) },
        { kind: 'workspace', workspace: workspace(OTHER, 'other') }
    ];
}

function baseProps() {
    return { activeWorkspaceID: OTHER, filter: '', onFilterChange: () => undefined };
}

function row(id: string): HTMLElement {
    const found = screen
        .getAllByTestId('workspace-row')
        .find((element) => element.dataset['workspaceId'] === id);
    if (found === undefined) throw new Error(`no row for ${id}`);
    return found;
}

function menuLabels(menu: HTMLElement): string[] {
    return within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent ?? '');
}

describe('a parent row', () => {
    it('renders its children one indent in, under a parent-coloured rule', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        expect(screen.getAllByTestId('workspace-row').map((element) => element.dataset['depth'])).toEqual([
            '0',
            '1',
            '1',
            '0'
        ]);
        expect(within(row(CHILD_A)).getByTestId('nest-guide')).toBeTruthy();
        expect(within(row(PARENT)).queryByTestId('nest-guide')).toBeNull();
    });

    it('toggles its children through the chevron, optimistically', () => {
        const onSetWorkspaceChildrenCollapsed = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                onSetWorkspaceChildrenCollapsed={onSetWorkspaceChildrenCollapsed}
            />
        );
        fireEvent.click(within(row(PARENT)).getByTestId('workspace-children-chevron'));
        expect(onSetWorkspaceChildrenCollapsed).toHaveBeenCalledWith(PARENT, true);
        // The rows fold away before the daemon answers.
        expect(screen.getAllByTestId('workspace-row')).toHaveLength(2);
        expect(row(PARENT).dataset['childrenCollapsed']).toBe('true');
    });

    it('rolls its children’s agent state and count into the row while collapsed', () => {
        render(<Sidebar {...baseProps()} entries={entries({ collapsed: true, waitingChild: true })} />);
        const parent = row(PARENT);
        expect(within(parent).getByTestId('workspace-children-count').textContent).toBe('2');
        expect(within(parent).getByTestId('status-dot').dataset['status']).toBe('waiting');
    });

    it('does not roll up while expanded: each child reports for itself', () => {
        render(<Sidebar {...baseProps()} entries={entries({ waitingChild: true })} />);
        expect(within(row(PARENT)).queryByTestId('status-dot')).toBeNull();
        expect(within(row(PARENT)).queryByTestId('workspace-children-count')).toBeNull();
        expect(within(row(CHILD_A)).getByTestId('status-dot').dataset['status']).toBe('waiting');
    });
});

describe('the row menu', () => {
    function open(id: string, extra: Record<string, unknown> = {}): void {
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                onCreateWorkspace={vi.fn()}
                onNestWorkspaces={vi.fn()}
                onMoveWorkspace={vi.fn()}
                {...extra}
            />
        );
        fireEvent.contextMenu(row(id));
    }

    it('a parent offers New Nested Workspace…, and no Nest Under (it has children)', () => {
        open(PARENT);
        expect(screen.getByText('New Nested Workspace…')).toBeTruthy();
        expect(screen.queryByText('Nest Under')).toBeNull();
        expect(screen.queryByText('Un-nest')).toBeNull();
    });

    it('New Nested Workspace… opens the sheet scoped to the parent and creates under it', () => {
        const onCreateWorkspace = vi.fn(() => null);
        open(PARENT, { onCreateWorkspace });
        fireEvent.click(screen.getByText('New Nested Workspace…'));
        expect(screen.getByTestId('new-workspace-parent').textContent).toBe('Nested under orchestrator');
        expect(screen.queryByTestId('new-workspace-group')).toBeNull();
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'worker-c' } });
        fireEvent.submit(screen.getByLabelText('New workspace name').closest('form') as HTMLFormElement);
        expect(onCreateWorkspace).toHaveBeenCalledWith(
            'worker-c',
            null,
            undefined,
            expect.objectContaining({ parentID: PARENT })
        );
    });

    it('a top-level workspace can nest under any non-nested workspace', () => {
        const onNestWorkspaces = vi.fn();
        open(OTHER, { onNestWorkspaces });
        fireEvent.mouseEnter(screen.getByText('Nest Under'));
        const submenu = screen.getByTestId('context-submenu');
        expect(menuLabels(submenu)).toEqual(['orchestrator']);
        fireEvent.click(within(submenu).getByText('orchestrator'));
        expect(onNestWorkspaces).toHaveBeenCalledWith({ workspaceIDs: [OTHER], parentID: PARENT, index: 2 });
    });

    it('a nested workspace offers Un-nest, landing right after its parent, and no New Nested', () => {
        const onMoveWorkspace = vi.fn();
        open(CHILD_B, { onMoveWorkspace });
        expect(screen.queryByText('New Nested Workspace…')).toBeNull();
        fireEvent.click(screen.getByText('Un-nest'));
        expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: CHILD_B, groupID: null, index: 1 });
    });
});

describe('a nested workspace inside a grouped parent', () => {
    it('counts as a member of the parent\'s group in Move to Group, as the daemon does', () => {
        const GROUP = 'cccccccc-0000-4000-8000-000000000001';
        const parent = workspace(PARENT, 'orchestrator', { childOrder: [CHILD_A] });
        const grouped: ChromeSidebarEntry[] = [
            {
                kind: 'group',
                group: { id: GROUP, name: 'squad', color: null, icon: null, isCollapsed: false },
                workspaces: [parent],
                nested: new Map([[PARENT, [workspace(CHILD_A, 'worker-a')]]])
            },
            { kind: 'workspace', workspace: workspace(OTHER, 'other') }
        ];
        render(<Sidebar {...baseProps()} entries={grouped} onMoveWorkspace={vi.fn()} />);
        fireEvent.contextMenu(row(CHILD_A));
        fireEvent.mouseEnter(screen.getByText('Move to Group'));
        const submenu = screen.getByTestId('context-submenu');
        expect(menuLabels(submenu)[0]).toBe('Remove from Group');
        expect(
            (within(submenu).getByText('squad').closest('[data-menu-item]') as HTMLElement).getAttribute(
                'aria-disabled'
            )
        ).toBe('true');
    });
});

describe('deleting a parent', () => {
    function openDelete(props: Record<string, unknown> = {}): void {
        render(<Sidebar {...baseProps()} entries={entries()} {...props} />);
        fireEvent.contextMenu(row(PARENT));
        fireEvent.click(screen.getByText('Delete'));
    }

    it('promotes the children by default', () => {
        const onDeleteWorkspace = vi.fn();
        openDelete({ onDeleteWorkspace });
        const box = screen.getByTestId('confirm-cascade-children') as HTMLInputElement;
        expect(box.checked).toBe(false);
        expect(screen.getByText('Also delete 2 nested workspaces')).toBeTruthy();
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(onDeleteWorkspace).toHaveBeenCalledWith(PARENT);
    });

    it('cascades when the box is ticked, counting the children’s agents', () => {
        const onDeleteWorkspace = vi.fn();
        openDelete({
            onDeleteWorkspace,
            workspaceAgentSummary: (id: string) =>
                id === CHILD_A
                    ? { running: 1, waiting: 0, inactive: 0, total: 1 }
                    : { running: 0, waiting: 0, inactive: 0, total: 0 }
        });
        const dialog = screen.getByTestId('confirm-dialog');
        expect(dialog.dataset['activeAgents']).toBe('0');
        fireEvent.click(screen.getByTestId('confirm-cascade-children'));
        expect(dialog.dataset['activeAgents']).toBe('1');
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(onDeleteWorkspace).toHaveBeenCalledWith(PARENT, undefined, { cascadeChildren: true });
    });

    it('does not offer the cascade when it would delete every workspace', () => {
        const only = entries().slice(0, 1);
        render(<Sidebar {...baseProps()} entries={only} onDeleteWorkspace={vi.fn()} />);
        fireEvent.contextMenu(row(PARENT));
        fireEvent.click(screen.getByText('Delete'));
        expect((screen.getByTestId('confirm-cascade-children') as HTMLInputElement).disabled).toBe(true);
    });
});

describe('drag and drop', () => {
    /**
     * Rows are 20px under the 4px content padding: orchestrator 4–24 · worker-a 24–44 ·
     * worker-b 44–64 · other 64–84. A nestable row splits into thirds.
     */
    function mount(props: Record<string, unknown> = {}): void {
        render(<Sidebar {...baseProps()} entries={entries()} rowHeight={20} {...props} />);
    }

    it('nests a workspace dropped on a row’s middle, previewing without moving the rows', () => {
        const onNestWorkspaces = vi.fn();
        mount({ onNestWorkspaces, onMoveWorkspace: vi.fn() });
        fireEvent.mouseDown(row(OTHER), { clientY: 74 });
        fireEvent.mouseMove(window, { clientY: 14 });
        expect(row(PARENT).dataset['dropPreview']).toBe('true');
        fireEvent.mouseUp(window);
        expect(onNestWorkspaces).toHaveBeenCalledWith({ workspaceIDs: [OTHER], parentID: PARENT, index: 2 });
    });

    it('drags a nested workspace out to the top level as an ordinary move', () => {
        const onMoveWorkspace = vi.fn();
        const onNestWorkspaces = vi.fn();
        mount({ onNestWorkspaces, onMoveWorkspace });
        fireEvent.mouseDown(row(CHILD_B), { clientY: 54 });
        fireEvent.mouseMove(window, { clientY: 82 });
        fireEvent.mouseUp(window);
        expect(onNestWorkspaces).not.toHaveBeenCalled();
        expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: CHILD_B, groupID: null, index: 2 });
    });

    it('a dragged parent folds its children away and can never nest', () => {
        const onMoveWorkspace = vi.fn();
        const onNestWorkspaces = vi.fn();
        mount({ onNestWorkspaces, onMoveWorkspace });
        fireEvent.mouseDown(row(PARENT), { clientY: 14 });
        fireEvent.mouseMove(window, { clientY: 30 });
        expect(screen.getAllByTestId('workspace-row')).toHaveLength(2);
        fireEvent.mouseMove(window, { clientY: 40 });
        fireEvent.mouseUp(window);
        expect(onNestWorkspaces).not.toHaveBeenCalled();
        expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: PARENT, groupID: null, index: 1 });
    });
});

describe('with the sidebar filter on', () => {
    /*
     * The bundled feature hands the sidebar `entries` already narrowed by the filter and
     * `allEntries` whole. Top level: alpha · orchard · orchestrator [orch-worker, worker-2,
     * worker-3] · orchid [x-1] · delta. Filtering for "orch" leaves orchard, orchestrator with
     * only orch-worker, and orchid with none of its children.
     */
    const ALPHA = 'aaaaaaaa-0000-4000-8000-000000000011';
    const ORCHARD = 'aaaaaaaa-0000-4000-8000-000000000012';
    const CHILD_C = 'aaaaaaaa-0000-4000-8000-000000000013';
    const ORCHID = 'aaaaaaaa-0000-4000-8000-000000000014';
    const X1 = 'aaaaaaaa-0000-4000-8000-000000000015';
    const DELTA = 'aaaaaaaa-0000-4000-8000-000000000016';

    function trees(): { full: ChromeSidebarEntry[]; narrowed: ChromeSidebarEntry[] } {
        const orchestrator = workspace(PARENT, 'orchestrator', { childOrder: [CHILD_A, CHILD_B, CHILD_C] });
        const kids = [
            workspace(CHILD_A, 'orch-worker'),
            workspace(CHILD_B, 'worker-2'),
            workspace(CHILD_C, 'worker-3')
        ];
        const orchid = workspace(ORCHID, 'orchid', { childOrder: [X1] });
        const orchard = workspace(ORCHARD, 'orchard');
        return {
            full: [
                { kind: 'workspace', workspace: workspace(ALPHA, 'alpha') },
                { kind: 'workspace', workspace: orchard },
                { kind: 'workspace', workspace: orchestrator, nested: new Map([[PARENT, kids]]) },
                { kind: 'workspace', workspace: orchid, nested: new Map([[ORCHID, [workspace(X1, 'x-1')]]]) },
                { kind: 'workspace', workspace: workspace(DELTA, 'delta') }
            ],
            narrowed: [
                { kind: 'workspace', workspace: orchard },
                { kind: 'workspace', workspace: orchestrator, nested: new Map([[PARENT, kids.slice(0, 1)]]) },
                { kind: 'workspace', workspace: orchid }
            ]
        };
    }

    function mount(props: Record<string, unknown> = {}): void {
        const { full, narrowed } = trees();
        render(
            <Sidebar
                {...baseProps()}
                filter="orch"
                entries={narrowed}
                allEntries={full}
                onCreateWorkspace={vi.fn()}
                onNestWorkspaces={vi.fn()}
                onMoveWorkspace={vi.fn()}
                {...props}
            />
        );
    }

    it('counts every nested workspace the cascade deletes, and their agents, not just the matching ones', () => {
        const onDeleteWorkspace = vi.fn();
        mount({
            onDeleteWorkspace,
            workspaceAgentSummary: (id: string) =>
                id === CHILD_C
                    ? { running: 1, waiting: 0, inactive: 0, total: 1 }
                    : { running: 0, waiting: 0, inactive: 0, total: 0 }
        });
        fireEvent.contextMenu(row(PARENT));
        fireEvent.click(screen.getByText('Delete'));
        expect(screen.getByText('Also delete 3 nested workspaces')).toBeTruthy();
        const box = screen.getByTestId('confirm-cascade-children') as HTMLInputElement;
        expect(box.disabled).toBe(false);
        fireEvent.click(box);
        expect(screen.getByTestId('confirm-dialog').dataset['activeAgents']).toBe('1');
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(onDeleteWorkspace).toHaveBeenCalledWith(PARENT, undefined, { cascadeChildren: true });
    });

    it('un-nests right after the parent in the real order, not the filtered one', () => {
        const onMoveWorkspace = vi.fn();
        mount({ onMoveWorkspace });
        fireEvent.contextMenu(row(CHILD_A));
        fireEvent.click(screen.getByText('Un-nest'));
        expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: CHILD_A, groupID: null, index: 3 });
    });

    it('never offers Nest Under on a parent whose children the filter hid, and lists every possible parent', () => {
        mount();
        fireEvent.contextMenu(row(ORCHID));
        expect(screen.queryByText('Nest Under')).toBeNull();
        fireEvent.keyDown(window, { key: 'Escape' });
        cleanup();
        mount();
        fireEvent.contextMenu(row(ORCHARD));
        fireEvent.mouseEnter(screen.getByText('Nest Under'));
        expect(menuLabels(screen.getByTestId('context-submenu'))).toEqual(['alpha', 'orchestrator', 'orchid', 'delta']);
    });
});

describe('a collapsed group', () => {
    it('shows its members’ nested workspaces’ agent state on the header', () => {
        const GROUP = 'cccccccc-0000-4000-8000-000000000002';
        const parent = workspace(PARENT, 'orchestrator', { childOrder: [CHILD_A] });
        const waiting = workspace(CHILD_A, 'worker-a', { panes: [pane(`${CHILD_A}-p1`, 'waitingForInput')] });
        render(
            <Sidebar
                {...baseProps()}
                entries={[
                    {
                        kind: 'group',
                        group: { id: GROUP, name: 'squad', color: null, icon: null, isCollapsed: true },
                        workspaces: [parent],
                        nested: new Map([[PARENT, [waiting]]])
                    },
                    { kind: 'workspace', workspace: workspace(OTHER, 'other') }
                ]}
            />
        );
        const header = screen.getAllByTestId('group-header')[0] as HTMLElement;
        expect(within(header).queryByTestId('status-dot')).not.toBeNull();
    });
});

describe('a selection holding a parent', () => {
    function mount(selected: readonly string[], props: Record<string, unknown> = {}): void {
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                rowHeight={20}
                selectedWorkspaceIDs={new Set(selected)}
                onNestWorkspaces={vi.fn()}
                {...props}
            />
        );
    }

    it.each([
        ['the parent', PARENT, 14],
        ['one of its selected children', CHILD_A, 34]
    ])('drags the family when %s is grabbed, moving only the parent', (_label, grabbed, y) => {
        const onMoveWorkspace = vi.fn();
        const onMoveWorkspaces = vi.fn();
        mount([PARENT, CHILD_A], { onMoveWorkspace, onMoveWorkspaces });
        fireEvent.mouseDown(row(grabbed), { clientY: y });
        fireEvent.mouseMove(window, { clientY: y + 16 });
        fireEvent.mouseMove(window, { clientY: 40 });
        fireEvent.mouseUp(window);
        expect(onMoveWorkspaces).not.toHaveBeenCalled();
        expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: PARENT, groupID: null, index: 1 });
    });

    it('folds a companion parent’s children too, not only the grabbed row’s', () => {
        mount([PARENT, OTHER], { onMoveWorkspaces: vi.fn() });
        fireEvent.mouseDown(row(OTHER), { clientY: 74 });
        fireEvent.mouseMove(window, { clientY: 60 });
        const ids = screen.getAllByTestId('workspace-row').map((element) => element.dataset['workspaceId']);
        expect(ids).not.toContain(CHILD_A);
        expect(ids).not.toContain(CHILD_B);
        fireEvent.mouseUp(window);
    });

    it('moves only the parent into a group from the bulk menu', () => {
        const GROUP = 'cccccccc-0000-4000-8000-000000000003';
        const onMoveWorkspaces = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={[
                    ...entries(),
                    {
                        kind: 'group',
                        group: { id: GROUP, name: 'squad', color: null, icon: null, isCollapsed: false },
                        workspaces: []
                    }
                ]}
                selectedWorkspaceIDs={new Set([PARENT, CHILD_A])}
                onMoveWorkspaces={onMoveWorkspaces}
            />
        );
        fireEvent.contextMenu(row(PARENT));
        fireEvent.mouseEnter(screen.getByText('Move 2 Workspaces to Group'));
        fireEvent.click(within(screen.getByTestId('context-submenu')).getByText('squad'));
        expect(onMoveWorkspaces).toHaveBeenCalledWith({ workspaceIDs: [PARENT], groupID: GROUP, index: 0 });
    });

    it('moves and groups only the parent from the bulk menu: its children follow it', async () => {
        const onCreateGroupForWorkspaces = vi.fn();
        mount([PARENT, CHILD_A], { onCreateGroupForWorkspaces });
        fireEvent.contextMenu(row(PARENT));
        fireEvent.click(screen.getByText('Group 2 Workspaces…'));
        fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'Review' } });
        fireEvent.submit(screen.getByTestId('new-group-form'));
        await waitFor(() => {
            expect(onCreateGroupForWorkspaces).toHaveBeenCalledWith('Review', [PARENT], null);
        });
    });
});

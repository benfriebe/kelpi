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

/** Menu row labels with the `✓` tick stripped — the tick is read off `data-checked`. */
function menuLabels(scope: HTMLElement): string[] {
    return [...scope.querySelectorAll('[data-menu-item]')].map((el) =>
        (el.textContent ?? '').trim().replace(/^[✓✔–]\s*/, '')
    );
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

    /**
     * §WS-112 — the daemon can expand a group by itself, and the sidebar has to show it.
     *
     * `set-active-workspace` opens a collapsed parent on the way in, so activating a workspace
     * hidden inside one (⌘1–9, the palette, a status-popover row) arrives with the group already
     * open. That broadcast reaches this component as a changed `isCollapsed` — and it used to be
     * ignored, because the local override the header click wrote won over the mirror forever.
     * The group stayed shut around the workspace the user had just jumped to.
     */
    it('follows the daemon back OPEN once its own optimistic collapse is confirmed', () => {
        const view = render(<Sidebar {...noopProps()} entries={entries()} />);
        fireEvent.click(screen.getByTestId('group-chevron'));
        expect(rowIDs()).toEqual([W1, W4]);

        // The daemon confirms the collapse this client asked for: the override has nothing left
        // to hide, so it retires.
        view.rerender(<Sidebar {...noopProps()} entries={entries({ collapsed: true })} />);
        expect(rowIDs()).toEqual([W1, W4]);

        // …and now the daemon expands on its own — an activation into a hidden member.
        view.rerender(<Sidebar {...noopProps()} entries={entries({ collapsed: false })} />);
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);
        expect(screen.getByTestId('group-header')).toHaveProperty('dataset.collapsed', 'false');
    });

    it('still holds the optimistic answer while the round trip is in flight', () => {
        // The override's whole reason for existing: a re-render that arrives BEFORE the daemon
        // has answered (an agent tick, a title change) must not undo the click.
        const view = render(<Sidebar {...noopProps()} entries={entries()} />);
        fireEvent.click(screen.getByTestId('group-chevron'));
        view.rerender(<Sidebar {...noopProps()} entries={entries({ collapsed: false })} />);
        expect(rowIDs()).toEqual([W1, W4]);
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

    // ── §WS-049: the row menu's "Profile ▸" ─────────────────────────────────────────

    it('builds the Profile submenu at right-click time, `default` first (§WS-049)', () => {
        const onSetWorkspaceProfile = vi.fn();
        render(
            <Sidebar
                {...noopProps()}
                entries={entries()}
                profiles={['work', 'personal']}
                onSetWorkspaceProfile={onSetWorkspaceProfile}
            />
        );
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Profile'));
        const submenu = screen.getByTestId('context-submenu');
        expect(menuLabels(submenu)).toEqual(['default', 'work', 'personal']);
        // Unassigned = the built-in baseline, so `default` carries the tick.
        expect(submenu.querySelector('[data-menu-item="profile:default"]')?.getAttribute('data-checked')).toBe(
            'true'
        );

        fireEvent.click(within(submenu).getByText('work'));
        expect(onSetWorkspaceProfile).toHaveBeenCalledWith(W1, 'work');
    });

    it('keeps an assigned-but-missing profile in the list so the tick never vanishes (§WS-049)', () => {
        const onSetWorkspaceProfile = vi.fn();
        const withGhost = entries();
        withGhost[0] = {
            kind: 'workspace',
            workspace: workspace(W1, 'alpha', { profileName: 'ghost' })
        };
        render(
            <Sidebar
                {...noopProps()}
                entries={withGhost}
                profiles={['work']}
                onSetWorkspaceProfile={onSetWorkspaceProfile}
            />
        );
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Profile'));
        const submenu = screen.getByTestId('context-submenu');
        expect(menuLabels(submenu)).toEqual(['default', 'work', 'ghost']);
        expect(submenu.querySelector('[data-menu-item="profile:ghost"]')?.getAttribute('data-checked')).toBe('true');

        // Choosing `default` CLEARS the assignment rather than storing the word.
        fireEvent.click(within(submenu).getByText('default'));
        expect(onSetWorkspaceProfile).toHaveBeenCalledWith(W1, null);
    });

    it('hides Profile entirely when assembly wired no handler', () => {
        render(<Sidebar {...noopProps()} entries={entries()} profiles={['work']} />);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        expect(screen.queryByText('Profile')).toBeNull();
    });

    // ── §WS-065: the group menu's "Color ▸" ─────────────────────────────────────────

    it('offers None plus the ten colours on a group, unlike a workspace (§WS-065)', () => {
        const onSetGroupColor = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onSetGroupColor={onSetGroupColor} />);
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.mouseEnter(screen.getByText('Color'));
        const submenu = screen.getByTestId('context-submenu');
        const labels = menuLabels(submenu);
        expect(labels[0]).toBe('None');
        expect(labels).toHaveLength(11);
        // squad is green in the fixture, so that is the row that ticks.
        expect(submenu.querySelector('[data-menu-item="color:green"]')?.getAttribute('data-checked')).toBe('true');

        fireEvent.click(within(submenu).getByText('purple'));
        expect(onSetGroupColor).toHaveBeenCalledWith(G1, 'purple');
    });

    it('clears a group colour through None (§WS-065)', () => {
        const onSetGroupColor = vi.fn();
        render(<Sidebar {...noopProps()} entries={entries()} onSetGroupColor={onSetGroupColor} />);
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.mouseEnter(screen.getByText('Color'));
        fireEvent.click(within(screen.getByTestId('context-submenu')).getByText('None'));
        expect(onSetGroupColor).toHaveBeenCalledWith(G1, null);
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
        // The second argument is the colour row's choice — `null` is its "None" option.
        expect(onCreateGroup).toHaveBeenCalledWith('platform', null);
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

// ── the sidebar sweep: selection edges and the group glyph ───────────────────────────

describe('selection edges', () => {
    function selectedIDs(): string[] {
        return screen
            .getAllByTestId('workspace-row')
            .filter((row) => row.dataset['selected'] === 'true')
            .map((row) => row.dataset['workspaceId'] ?? '');
    }

    it('ranges from an explicit anchor that a toggle-OFF moves too (§WS-044/§WS-046)', () => {
        render(<Sidebar {...noopProps()} entries={entries()} />);
        const rows = (): HTMLElement[] => screen.getAllByTestId('workspace-row');

        // Anchor at alpha, then range to gamma: the whole visible run.
        fireEvent.click(rows()[0] as HTMLElement, { metaKey: true });
        fireEvent.click(rows()[3] as HTMLElement, { shiftKey: true });
        expect(selectedIDs()).toEqual([W1, W4, W2, W3]);

        // A range extension does NOT move the anchor, so shrinking the range re-ranges from
        // alpha rather than walking away from it.
        fireEvent.click(rows()[1] as HTMLElement, { shiftKey: true });
        expect(selectedIDs()).toEqual([W1, W4]);

        // Toggling delta OFF moves the anchor onto delta — the rule the insertion-order
        // inference got wrong, because it left the anchor on whatever remained last.
        fireEvent.click(rows()[1] as HTMLElement, { metaKey: true });
        expect(selectedIDs()).toEqual([W1]);
        fireEvent.click(rows()[3] as HTMLElement, { shiftKey: true });
        expect(selectedIDs()).toEqual([W4, W2, W3]);
    });

    it('shift-clicking with nothing selected falls back to the active workspace (§WS-044)', () => {
        render(<Sidebar {...noopProps()} entries={entries()} />);
        // `activeWorkspaceID` is alpha, so the range runs alpha → beta.
        fireEvent.click(screen.getAllByTestId('workspace-row')[2] as HTMLElement, { shiftKey: true });
        expect(selectedIDs()).toEqual([W1, W4, W2]);
    });

    it('clears the selection when the filter field is submitted (§WS-011)', () => {
        const onActivateWorkspace = vi.fn();
        const onFilterChange = vi.fn();
        const view = render(
            <Sidebar
                {...noopProps()}
                onFilterChange={onFilterChange}
                entries={entries()}
                onActivateWorkspace={onActivateWorkspace}
            />
        );
        fireEvent.click(screen.getAllByTestId('workspace-row')[0] as HTMLElement, { metaKey: true });
        fireEvent.click(screen.getAllByTestId('workspace-row')[1] as HTMLElement, { metaKey: true });
        expect(selectedIDs()).toEqual([W1, W4]);

        view.rerender(
            <Sidebar
                {...noopProps()}
                filter="gam"
                onFilterChange={onFilterChange}
                entries={entries()}
                onActivateWorkspace={onActivateWorkspace}
            />
        );
        fireEvent.keyDown(screen.getByLabelText('Filter workspaces or labels'), { key: 'Enter' });
        expect(onActivateWorkspace).toHaveBeenCalledWith(W3);
        expect(onFilterChange).toHaveBeenLastCalledWith('');

        view.rerender(<Sidebar {...noopProps()} onFilterChange={onFilterChange} entries={entries()} />);
        expect(selectedIDs()).toEqual([]);
    });

    it('clears the selection when a filtered row is plain-clicked (§WS-018)', () => {
        const onFilterChange = vi.fn();
        const onActivateWorkspace = vi.fn();
        const view = render(
            <Sidebar
                {...noopProps()}
                onFilterChange={onFilterChange}
                entries={entries()}
                onActivateWorkspace={onActivateWorkspace}
            />
        );
        fireEvent.click(screen.getAllByTestId('workspace-row')[0] as HTMLElement, { metaKey: true });
        fireEvent.click(screen.getAllByTestId('workspace-row')[1] as HTMLElement, { metaKey: true });

        view.rerender(
            <Sidebar
                {...noopProps()}
                filter="gam"
                onFilterChange={onFilterChange}
                entries={entries()}
                onActivateWorkspace={onActivateWorkspace}
            />
        );
        fireEvent.click(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        expect(onActivateWorkspace).toHaveBeenCalledWith(W3);
        expect(onFilterChange).toHaveBeenLastCalledWith('');

        view.rerender(<Sidebar {...noopProps()} onFilterChange={onFilterChange} entries={entries()} />);
        expect(selectedIDs()).toEqual([]);
    });
});

describe('group glyph and menus', () => {
    it('fills the folder once a group has a colour, and outlines it when it has none (§WS-036)', () => {
        const view = render(<Sidebar {...noopProps()} entries={entries()} />);
        const folder = (): HTMLElement | null =>
            screen.getByTestId('group-header').querySelector('[data-icon="folder"]');
        expect(folder()?.getAttribute('data-filled')).toBe('true');

        const colourless = entries();
        colourless[2] = {
            kind: 'group',
            group: { id: G1, name: 'squad', color: null, icon: null, isCollapsed: false },
            workspaces: [workspace(W2, 'beta'), workspace(W3, 'gamma')]
        };
        view.rerender(<Sidebar {...noopProps()} entries={colourless} />);
        expect(folder()?.getAttribute('data-filled')).toBeNull();
    });

    it('says "Reset to Folder" on a group and "Reset to Letter" on a workspace (§WS-066)', () => {
        render(<Sidebar {...noopProps()} entries={entries()} onSetGroupIcon={vi.fn()} />);
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.mouseEnter(screen.getByText('Change Icon'));
        expect(within(screen.getByTestId('context-submenu')).getByText('Reset to Folder')).toBeTruthy();

        fireEvent.mouseDown(document.body);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Change Icon'));
        expect(within(screen.getByTestId('context-submenu')).getByText('Reset to Letter')).toBeTruthy();
    });
});

// ── §WS-052: "Move to Group ▸ New Group…" ───────────────────────────────────────────

describe('move to group', () => {
    /** Open the Move to Group submenu on a row and hand back its scope. */
    function openMoveSubmenu(rowIndex: number, extra: Record<string, unknown> = {}): HTMLElement {
        render(<Sidebar {...noopProps()} entries={entries()} {...extra} />);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[rowIndex] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Move to Group'));
        return screen.getByTestId('context-submenu');
    }

    it('offers "New Group…" after the existing destinations', () => {
        const onCreateGroupWithWorkspace = vi.fn();
        // Row 0 is `alpha`, a top-level workspace: no "Remove from Group", one group to move to.
        const submenu = openMoveSubmenu(0, { onCreateGroupWithWorkspace });
        expect(menuLabels(submenu)).toEqual(['squad', 'New Group…']);

        fireEvent.click(within(submenu).getByText('New Group…'));
        expect(onCreateGroupWithWorkspace).toHaveBeenCalledWith(W1);
        // It is a real menu activation: the whole menu closes behind it, like every other row.
        expect(screen.queryByTestId('context-menu')).toBeNull();
    });

    it('keeps "Remove from Group" first for a grouped row, with New Group… still last', () => {
        // Row 2 is `beta`, inside `squad` — so the un-group verb leads and `squad` is dimmed.
        const submenu = openMoveSubmenu(2, { onCreateGroupWithWorkspace: vi.fn() });
        expect(menuLabels(submenu)).toEqual(['Remove from Group', 'squad', 'New Group…']);
        expect(
            (within(submenu).getByText('squad').closest('[data-menu-item]') as HTMLElement).getAttribute(
                'aria-disabled'
            )
        ).toBe('true');
    });

    it('separates the destinations from the two verbs either side of them', () => {
        const submenu = openMoveSubmenu(2, { onCreateGroupWithWorkspace: vi.fn() });
        // One rule under "Remove from Group", one over "New Group…" — the Swift's own dividers.
        expect(submenu.querySelectorAll('[role="separator"]').length).toBe(2);
    });

    it('drops the entry entirely when assembly has not wired it', () => {
        // The submenu is then exactly what it was before §WS-052, rather than an inert row.
        expect(menuLabels(openMoveSubmenu(0))).toEqual(['squad']);
    });
});

/**
 * The sidebar's active-agents delete gate (WS-108).
 *
 * `WorkspaceDeleteGate` puts a warning in front of a delete that would terminate running
 * agents: the count in the message, a destructive Delete, and a "Don't ask again" honoured
 * whichever button ends the dialog. The daemon's `confirm-workspace-delete` setting turns the
 * whole warning off — and with no active agents there is nothing to warn about, so the dialog
 * stays the plain confirmation it has always been.
 *
 * Deliberate divergence from the Swift app, stated here because it is visible: Swift shows NO
 * alert at all for an idle workspace, and the port keeps its plain confirmation. Deleting a
 * workspace from a browser has no undo, so the port confirms more, never less.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';

function workspace(id: string, name: string): ChromeWorkspace {
    return {
        id,
        name,
        color: 'blue',
        icon: null,
        labels: [],
        panes: [
            {
                id: `${id}-p1`,
                type: 'shell',
                label: null,
                title: null,
                workingDirectory: '/Users/test/code',
                gitBranch: null,
                status: 'idle',
                agentSessionID: null,
                agentKind: null,
                agentStartedAt: null,
                backgroundTaskCount: 0
            }
        ]
    };
}

const entries: ChromeSidebarEntry[] = [
    { kind: 'workspace', workspace: workspace(W1, 'alpha') },
    { kind: 'workspace', workspace: workspace(W2, 'beta') }
];

function baseProps() {
    return {
        entries,
        activeWorkspaceID: W1,
        filter: '',
        onFilterChange: () => undefined
    };
}

function openDelete(): void {
    fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
    fireEvent.click(screen.getByText('Delete'));
}

describe('workspace delete gate', () => {
    it('names the running agents and offers the suppression box', () => {
        render(<Sidebar {...baseProps()} onDeleteWorkspace={vi.fn()} activeAgentCount={() => 2} />);
        openDelete();
        const dialog = screen.getByTestId('confirm-dialog');
        expect(dialog.dataset['activeAgents']).toBe('2');
        expect(within(dialog).getByTestId('confirm-active-agents').textContent).toBe(
            'This workspace has 2 active agents. Deleting it will terminate them.'
        );
        expect(within(dialog).getByTestId('confirm-suppress')).toBeTruthy();
    });

    it('singularises the message for one agent', () => {
        render(<Sidebar {...baseProps()} onDeleteWorkspace={vi.fn()} activeAgentCount={() => 1} />);
        openDelete();
        expect(screen.getByTestId('confirm-active-agents').textContent).toBe(
            'This workspace has 1 active agent. Deleting it will terminate it.'
        );
    });

    it('shows the plain confirmation when nothing is running', () => {
        render(<Sidebar {...baseProps()} onDeleteWorkspace={vi.fn()} activeAgentCount={() => 0} />);
        openDelete();
        expect(screen.getByTestId('confirm-dialog').dataset['activeAgents']).toBe('0');
        expect(screen.queryByTestId('confirm-active-agents')).toBeNull();
        expect(screen.queryByTestId('confirm-suppress')).toBeNull();
    });

    it('drops the warning when the daemon setting is off', () => {
        render(
            <Sidebar
                {...baseProps()}
                onDeleteWorkspace={vi.fn()}
                activeAgentCount={() => 3}
                confirmDeleteWhenActive={false}
            />
        );
        openDelete();
        expect(screen.queryByTestId('confirm-active-agents')).toBeNull();
    });

    it('honours "Don’t ask again" on the Delete button', () => {
        const onDeleteWorkspace = vi.fn();
        const onSuppressDeleteConfirm = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                onDeleteWorkspace={onDeleteWorkspace}
                activeAgentCount={() => 1}
                onSuppressDeleteConfirm={onSuppressDeleteConfirm}
            />
        );
        openDelete();
        fireEvent.click(screen.getByTestId('confirm-suppress'));
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(onSuppressDeleteConfirm).toHaveBeenCalledTimes(1);
        expect(onDeleteWorkspace).toHaveBeenCalledWith(W1);
    });

    it('every answer takes the hover fill under the pointer, and drops it on leave (H11)', () => {
        render(<Sidebar {...baseProps()} onDeleteWorkspace={vi.fn()} activeAgentCount={() => 0} />);
        openDelete();
        const dialog = screen.getByTestId('confirm-dialog');
        for (const id of ['confirm-cancel', 'confirm-delete']) {
            const button = within(dialog).getByTestId(id);
            const before = { background: button.style.background, border: button.style.border };
            fireEvent.mouseEnter(button);
            expect(button.style.background).not.toBe(before.background);
            expect(button.style.border).not.toBe(before.border);
            // The label colour is untouched — the red is what marks Delete destructive.
            fireEvent.mouseLeave(button);
            expect(button.style.background).toBe(before.background);
            expect(button.style.border).toBe(before.border);
        }
    });

    it('honours "Don’t ask again" on Cancel too, and deletes nothing', () => {
        const onDeleteWorkspace = vi.fn();
        const onSuppressDeleteConfirm = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                onDeleteWorkspace={onDeleteWorkspace}
                activeAgentCount={() => 1}
                onSuppressDeleteConfirm={onSuppressDeleteConfirm}
            />
        );
        openDelete();
        fireEvent.click(screen.getByTestId('confirm-suppress'));
        fireEvent.click(screen.getByTestId('confirm-cancel'));
        expect(onSuppressDeleteConfirm).toHaveBeenCalledTimes(1);
        expect(onDeleteWorkspace).not.toHaveBeenCalled();
        expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });
});

/**
 * kelpi#53 (shell-ui.md §12): Cancel is the default/Return button of every confirmation, so
 * the sidebar's dialog answers Escape and Return the way `AgentDeleteGate` and
 * `QuitConfirmDialog` do. The keys are dispatched on `window` because the real listener is
 * capture-phase there, ahead of any pane's own key handling.
 */
describe('workspace delete gate keys', () => {
    it('Escape cancels and deletes nothing', () => {
        const onDeleteWorkspace = vi.fn();
        render(<Sidebar {...baseProps()} onDeleteWorkspace={onDeleteWorkspace} activeAgentCount={() => 0} />);
        openDelete();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onDeleteWorkspace).not.toHaveBeenCalled();
        expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });

    it('Return takes the default answer, Cancel, even with an active-agent warning up', () => {
        const onDeleteWorkspace = vi.fn();
        render(<Sidebar {...baseProps()} onDeleteWorkspace={onDeleteWorkspace} activeAgentCount={() => 2} />);
        openDelete();
        fireEvent.keyDown(window, { key: 'Enter' });
        expect(onDeleteWorkspace).not.toHaveBeenCalled();
        expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });

    it('honours "Don’t ask again" when Escape ends the dialog', () => {
        const onDeleteWorkspace = vi.fn();
        const onSuppressDeleteConfirm = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                onDeleteWorkspace={onDeleteWorkspace}
                activeAgentCount={() => 1}
                onSuppressDeleteConfirm={onSuppressDeleteConfirm}
            />
        );
        openDelete();
        fireEvent.click(screen.getByTestId('confirm-suppress'));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onSuppressDeleteConfirm).toHaveBeenCalledTimes(1);
        expect(onDeleteWorkspace).not.toHaveBeenCalled();
        expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });

    it('stops listening once the dialog is closed', () => {
        const onDeleteWorkspace = vi.fn();
        render(<Sidebar {...baseProps()} onDeleteWorkspace={onDeleteWorkspace} activeAgentCount={() => 0} />);
        openDelete();
        fireEvent.click(screen.getByTestId('confirm-cancel'));
        expect(screen.queryByTestId('confirm-dialog')).toBeNull();
        // A second Escape with no dialog up must not be swallowed by a stale listener.
        const seen = vi.fn();
        window.addEventListener('keydown', seen);
        fireEvent.keyDown(window, { key: 'Escape' });
        window.removeEventListener('keydown', seen);
        expect(seen).toHaveBeenCalledTimes(1);
    });
});

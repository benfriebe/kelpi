import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopBar, identityDotColor, workspaceColorHex, type ChromePane } from './index';

afterEach(cleanup);

function pane(status: ChromePane['status']): ChromePane {
    return {
        id: `p-${status}`,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test',
        gitBranch: null,
        status,
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

describe('identity cluster (§3)', () => {
    it('waiting beats running beats the workspace color', () => {
        expect(identityDotColor([pane('running'), pane('waitingForInput')], 'blue', 'dark')).toContain(
            '--nex-status-waiting'
        );
        expect(identityDotColor([pane('running')], 'blue', 'dark')).toContain('--nex-status-running');
        expect(identityDotColor([pane('idle')], 'blue', 'dark')).toBe(workspaceColorHex('blue', 'dark'));
        // No active workspace at all → tertiary text color.
        expect(identityDotColor([], undefined, 'dark')).toContain('--nex-fg-tertiary');
    });

    it('shows the name and pane count, pluralized', () => {
        const view = render(
            <TopBar workspaceName="alpha" workspaceColor="blue" panes={[pane('idle')]} connection="connected" />
        );
        expect(screen.getByTestId('top-bar-identity').textContent).toContain('alpha');
        expect(screen.getByTestId('top-bar-identity').textContent).toContain('1 pane');

        view.rerender(
            <TopBar
                workspaceName="alpha"
                workspaceColor="blue"
                panes={[pane('idle'), pane('running')]}
                connection="connected"
            />
        );
        expect(screen.getByTestId('top-bar-identity').textContent).toContain('2 panes');
    });

    it('falls back to "Nex" with no pane count when nothing is active', () => {
        render(<TopBar workspaceName={null} panes={[]} connection="connected" />);
        const identity = screen.getByTestId('top-bar-identity').textContent ?? '';
        expect(identity).toContain('Nex');
        expect(identity).not.toContain('pane');
    });
});

describe('controls', () => {
    it('cycles and selects layouts', () => {
        const onCycleLayout = vi.fn();
        const onSelectLayout = vi.fn();
        render(
            <TopBar
                workspaceName="alpha"
                panes={[]}
                connection="connected"
                currentLayout="main-vertical"
                onCycleLayout={onCycleLayout}
                onSelectLayout={onSelectLayout}
            />
        );
        expect(screen.getByTestId('layout-cycle').textContent).toContain('Main Vertical');

        fireEvent.click(screen.getByTestId('layout-cycle'));
        expect(onCycleLayout).toHaveBeenCalledOnce();

        fireEvent.click(screen.getByTestId('layout-menu-toggle'));
        fireEvent.click(screen.getByText('Tiled'));
        expect(onSelectLayout).toHaveBeenCalledWith('tiled');
        expect(screen.queryByTestId('layout-menu')).toBeNull();
    });

    it('reads "custom" for a hand-modified layout', () => {
        render(<TopBar workspaceName="alpha" panes={[]} connection="connected" currentLayout={null} />);
        expect(screen.getByTestId('layout-cycle').textContent).toContain('custom');
    });

    it('reflects the sync-input state and its broadcast group size', () => {
        const onToggleSyncInput = vi.fn();
        render(
            <TopBar
                workspaceName="alpha"
                panes={[]}
                connection="connected"
                syncInputActive
                syncedPaneCount={3}
                onToggleSyncInput={onToggleSyncInput}
            />
        );
        const toggle = screen.getByTestId('sync-toggle');
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(toggle.textContent).toContain('sync 3');
        fireEvent.click(toggle);
        expect(onToggleSyncInput).toHaveBeenCalledOnce();
    });

    it('shows the connection status', () => {
        const view = render(<TopBar workspaceName="alpha" panes={[]} connection="connected" />);
        expect(screen.getByTestId('connection-pill').textContent).toBe('connected');

        view.rerender(<TopBar workspaceName="alpha" panes={[]} connection="reconnecting" />);
        expect(screen.getByTestId('connection-pill').textContent).toBe('reconnecting');
        expect(screen.getByTestId('connection-pill').dataset['status']).toBe('reconnecting');

        view.rerender(<TopBar workspaceName="alpha" panes={[]} connection="rejected" />);
        expect(screen.getByTestId('connection-pill').textContent).toBe('refused');
    });

    it('toggles the sidebar when the host wires it', () => {
        const onToggleSidebar = vi.fn();
        render(
            <TopBar
                workspaceName="alpha"
                panes={[]}
                connection="connected"
                sidebarVisible={false}
                onToggleSidebar={onToggleSidebar}
            />
        );
        const button = screen.getByLabelText('Toggle sidebar');
        expect(button.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(button);
        expect(onToggleSidebar).toHaveBeenCalledOnce();
    });
});

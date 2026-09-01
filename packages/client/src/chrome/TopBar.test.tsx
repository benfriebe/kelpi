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
            '--kelpi-status-waiting'
        );
        expect(identityDotColor([pane('running')], 'blue', 'dark')).toContain('--kelpi-status-running');
        expect(identityDotColor([pane('idle')], 'blue', 'dark')).toBe(workspaceColorHex('blue', 'dark'));
        // No active workspace at all → tertiary text color.
        expect(identityDotColor([], undefined, 'dark')).toContain('--kelpi-fg-tertiary');
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

    it('falls back to "Kelpi" with no pane count when nothing is active', () => {
        render(<TopBar workspaceName={null} panes={[]} connection="connected" />);
        const identity = screen.getByTestId('top-bar-identity').textContent ?? '';
        expect(identity).toContain('Kelpi');
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

    /**
     * §APP-052, and PARITY divergence 35. The Swift hosts the ••• menu and the sidebar toggle in
     * ONE trailing titlebar accessory; the port keeps them together too — same cluster, adjacent,
     * in DOM order — at the leading edge, where a sidebar toggle belongs (the sidebar is directly
     * below it). What this pins is the PAIRING, which is the part of the item that is capability
     * rather than coordinate: the two must not drift to opposite ends of the row.
     */
    it('keeps the sidebar toggle and the ••• menu in one adjacent cluster', () => {
        render(
            <TopBar
                workspaceName="alpha"
                panes={[]}
                connection="connected"
                onToggleSidebar={vi.fn()}
                onToggleInspector={vi.fn()}
                overflowItems={[{ id: 'settings', label: 'Settings…', onSelect: vi.fn() }]}
            />
        );
        const sidebar = screen.getByLabelText('Toggle sidebar');
        const overflow = screen.getByTestId('titlebar-menu-toggle');
        expect(sidebar.parentElement).toBe(overflow.parentElement);
        const cluster = [...(sidebar.parentElement?.children ?? [])];
        // Adjacent but for the inspector toggle, which the Swift accessory had no counterpart for.
        expect(cluster.indexOf(overflow) - cluster.indexOf(sidebar)).toBeLessThanOrEqual(2);
        expect(cluster.indexOf(sidebar)).toBe(0);
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

/**
 * §APP-046 — the strip is drawn UNDER the window's traffic lights.
 *
 * The shell now creates its window with `titleBarStyle: 'hiddenInset'`, which removes the native
 * title bar entirely: this bar IS the title bar. Two things follow, and both are asserted here
 * because the defect they replace was invisible from the page — a native strip stacked above the
 * client's own, and a leading gutter that did not exist so the buttons landed on the controls.
 */
describe('the hidden title bar (§APP-046)', () => {
    it('keeps the shell’s leading gutter clear, without growing the strip', () => {
        render(
            <TopBar
                workspaceName="alpha"
                panes={[]}
                connection="connected"
                trafficLightInset={80}
                dragRegion
                onToggleSidebar={() => undefined}
            />
        );
        const bar = screen.getByTestId('top-bar');
        expect(bar.style.paddingLeft).toBe('80px');
        expect(bar.getAttribute('data-traffic-light-inset')).toBe('80');
        // The HEIGHT is untouched — `h-8`, the shipped app's 32pt. A taller bar would be the
        // "two stacked strips" defect wearing a different hat.
        expect(bar.className).toContain('h-8');
        // …and the first control really is beyond the gutter, which is the clause that matters:
        // the buttons must not sit on top of it.
        expect(bar.style.paddingLeft).not.toBe('12px');
    });

    it('takes the drag region, and hands it back to every control inside it', () => {
        render(
            <TopBar
                workspaceName="alpha"
                panes={[]}
                connection="connected"
                trafficLightInset={80}
                dragRegion
                onToggleSidebar={() => undefined}
                onToggleInspector={() => undefined}
            />
        );
        const bar = screen.getByTestId('top-bar');
        // The attribute is the hook; `styles.css` carries the `-webkit-app-region` pair, because
        // a descendant rule cannot be forgotten by a control added to the bar later.
        expect(bar.getAttribute('data-titlebar-drag')).toBe('true');
        // The controls are still real buttons inside it (the `no-drag` half of that rule).
        expect(bar.querySelectorAll('button').length).toBeGreaterThanOrEqual(2);
        fireEvent.click(screen.getByLabelText('Toggle sidebar'));
    });

    it('reserves NOTHING and claims no drag region in a browser tab', () => {
        render(<TopBar workspaceName="alpha" panes={[]} connection="connected" />);
        const bar = screen.getByTestId('top-bar');
        expect(bar.style.paddingLeft).toBe('12px');
        expect(bar.getAttribute('data-traffic-light-inset')).toBe('0');
        expect(bar.getAttribute('data-titlebar-drag')).toBeNull();
    });

    it('never lets a negative inset eat the bar’s own padding', () => {
        render(<TopBar workspaceName="alpha" panes={[]} connection="connected" trafficLightInset={-40} />);
        expect(screen.getByTestId('top-bar').style.paddingLeft).toBe('12px');
    });
});

describe('size control (terminal-surface.md §5.1)', () => {
    it('offers the take-back chip ONLY when another client owns sizing', () => {
        const onTakeSizeControl = vi.fn();
        render(
            <TopBar
                workspaceName="alpha"
                panes={[]}
                connection="connected"
                sizeControlledElsewhere
                onTakeSizeControl={onTakeSizeControl}
            />
        );
        const chip = screen.getByTestId('take-size-control');
        expect(chip.textContent).toContain('take size control');
        fireEvent.click(chip);
        expect(onTakeSizeControl).toHaveBeenCalledOnce();
    });

    it('renders nothing for the owner (and when no owner is known)', () => {
        render(<TopBar workspaceName="alpha" panes={[]} connection="connected" />);
        expect(screen.queryByTestId('take-size-control')).toBeNull();
    });
});

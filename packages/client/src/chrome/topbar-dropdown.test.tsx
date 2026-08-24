/**
 * The title bar's layout dropdown (H15) and the bar's hover feedback (H11).
 *
 * The dropdown is the sibling gap to the footer popover's: `TopBar.tsx:106, 254-286` opened a
 * `role="menu"` panel that could be closed ONLY by its own chevron — no outside click, no
 * Escape — while `chrome/ContextMenu.tsx` two files away had both. And nothing in this bar
 * answered a pointer at all: `grep -c hover TopBar.tsx` → 0, against a shipped bar whose
 * controls are AppKit buttons (`WindowTitleBar.swift:243-268`).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopBar, type ChromePane } from './index';

afterEach(cleanup);

function pane(): ChromePane {
    return {
        id: 'p-1',
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test',
        gitBranch: null,
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function renderBar(onSelectLayout = vi.fn()): void {
    render(
        <TopBar
            workspaceName="alpha"
            workspaceColor="blue"
            panes={[pane()]}
            connection="connected"
            currentLayout="even-horizontal"
            onCycleLayout={vi.fn()}
            onSelectLayout={onSelectLayout}
            onToggleSidebar={vi.fn()}
            onToggleInspector={vi.fn()}
            onToggleSyncInput={vi.fn()}
            overflowItems={[{ id: 'settings', label: 'Settings…' }]}
        />
    );
}

describe('layout dropdown dismissal (§H15)', () => {
    it('closes on a mousedown outside it', () => {
        renderBar();
        fireEvent.click(screen.getByTestId('layout-menu-toggle'));
        expect(screen.getByTestId('layout-menu')).toBeTruthy();

        fireEvent.mouseDown(screen.getByTestId('top-bar-identity'));
        expect(screen.queryByTestId('layout-menu')).toBeNull();
    });

    it('closes on Escape', () => {
        renderBar();
        fireEvent.click(screen.getByTestId('layout-menu-toggle'));
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(screen.queryByTestId('layout-menu')).toBeNull();
    });

    it('stays open for a mousedown inside it, so a row can be picked', () => {
        const onSelectLayout = vi.fn();
        renderBar(onSelectLayout);
        fireEvent.click(screen.getByTestId('layout-menu-toggle'));
        const rows = screen.getAllByRole('menuitem');
        fireEvent.mouseDown(rows[0] as HTMLElement);
        expect(screen.getByTestId('layout-menu')).toBeTruthy();
        fireEvent.click(rows[0] as HTMLElement);
        expect(onSelectLayout).toHaveBeenCalled();
        expect(screen.queryByTestId('layout-menu')).toBeNull();
    });

    it('the chevron that opened it still closes it', () => {
        renderBar();
        const toggle = screen.getByTestId('layout-menu-toggle');
        fireEvent.click(toggle);
        expect(screen.getByTestId('layout-menu')).toBeTruthy();
        // mousedown lands on the anchor, which the keep-list excludes; only the toggle acts.
        fireEvent.mouseDown(toggle);
        fireEvent.click(toggle);
        expect(screen.queryByTestId('layout-menu')).toBeNull();
    });

    it('does not eat an Escape while it is closed', () => {
        const behind = vi.fn();
        renderBar();
        window.addEventListener('keydown', behind);
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(behind).toHaveBeenCalledTimes(1);
        window.removeEventListener('keydown', behind);
    });
});

describe('hover feedback (§H11)', () => {
    it('every control in the bar answers the pointer', () => {
        renderBar();
        const controls = [
            screen.getByLabelText('Toggle sidebar'),
            screen.getByTestId('toggle-inspector'),
            screen.getByTestId('titlebar-menu-toggle'),
            screen.getByTestId('layout-cycle'),
            screen.getByTestId('layout-menu-toggle'),
            screen.getByTestId('sync-toggle')
        ];
        for (const control of controls) {
            expect(control.dataset['hovered']).toBe('false');
            fireEvent.mouseEnter(control);
            expect(control.dataset['hovered']).toBe('true');
            fireEvent.mouseLeave(control);
            expect(control.dataset['hovered']).toBe('false');
        }
    });

    it('only ONE control is lit at a time — the slot belongs to the bar, not the button', () => {
        renderBar();
        const sidebar = screen.getByLabelText('Toggle sidebar');
        const inspector = screen.getByTestId('toggle-inspector');
        fireEvent.mouseEnter(sidebar);
        fireEvent.mouseEnter(inspector);
        // The leave for the first arrives AFTER the enter for the second, as it does in a real
        // pointer move; it must not blank the new highlight.
        fireEvent.mouseLeave(sidebar);
        expect(inspector.dataset['hovered']).toBe('true');
        expect(sidebar.dataset['hovered']).toBe('false');
    });

    it('a hovered control takes a colour it does not have at rest', () => {
        renderBar();
        const cycle = screen.getByTestId('layout-cycle');
        const resting = cycle.style.color;
        fireEvent.mouseEnter(cycle);
        expect(cycle.style.color).not.toBe(resting);
    });

    it('a dropdown row lights up under the pointer', () => {
        renderBar();
        fireEvent.click(screen.getByTestId('layout-menu-toggle'));
        const row = screen.getAllByRole('menuitem')[0] as HTMLElement;
        expect(row.dataset['hovered']).toBe('false');
        fireEvent.mouseEnter(row);
        expect(row.dataset['hovered']).toBe('true');
        expect(row.style.background).not.toBe('');
    });
});

/**
 * §AGNT-103 / §AGNT-104 — the sidebar's agent dot, and the pulse it was missing.
 *
 * The colour rule (waiting wins over running, nothing when neither) is asserted in
 * `Sidebar.test.tsx`. What is new here is the ANIMATION: the Swift pulses a halo behind the dot
 * forever, and the port had no animations at all, so a waiting workspace read as a static dot.
 * A CSS animation is not something a screenshot can hold, but its residue is: the class that
 * carries it and the two custom properties `@keyframes nex-agent-dot-pulse` interpolates.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromePane, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const G1 = 'cccccccc-0000-4000-8000-000000000001';

function pane(id: string, status: ChromePane['status']): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test/code',
        gitBranch: null,
        status,
        agentSessionID: status === 'idle' ? null : 'session',
        agentKind: 'claude',
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function workspace(id: string, name: string, status: ChromePane['status']): ChromeWorkspace {
    return { id, name, color: 'blue', icon: null, labels: [], panes: [pane(`${id}-p1`, status)] };
}

function entries(status: ChromePane['status']): ChromeSidebarEntry[] {
    return [
        { kind: 'workspace', workspace: workspace(W1, 'alpha', status) },
        {
            kind: 'group',
            group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
            // The group header aggregates its members, so one member is enough to light it.
            workspaces: [workspace(W2, 'beta', status)]
        }
    ];
}

function renderSidebar(status: ChromePane['status']): void {
    render(
        <Sidebar
            entries={entries(status)}
            activeWorkspaceID={W1}
            filter=""
            onFilterChange={vi.fn()}
            rowHeight={20}
        />
    );
}

describe('the sidebar agent dot pulses', () => {
    it('carries the pulse class and its halo/ring properties on a workspace row', () => {
        renderSidebar('waitingForInput');
        const dots = screen.getAllByTestId('status-dot');
        expect(dots.length).toBeGreaterThan(0);
        const dot = dots[0] as HTMLElement;
        expect(dot.className).toContain('nex-agent-dot-pulse');
        // The halo the keyframes grow is the STATUS colour, not the row's own tint…
        expect(dot.style.getPropertyValue('--nex-dot-halo')).not.toBe('');
        // …and the 1.5 px ring that separates the dot from the sidebar is preserved through it.
        expect(dot.style.getPropertyValue('--nex-dot-ring')).not.toBe('');
        expect(dot.style.boxShadow).toContain('1.5px');
    });

    it('pulses the group header’s aggregated dot too (AGNT-104)', () => {
        renderSidebar('running');
        // Two dots: the workspace row's and the group header's aggregate.
        const dots = screen.getAllByTestId('status-dot');
        expect(dots.length).toBeGreaterThanOrEqual(2);
        for (const dot of dots) expect((dot as HTMLElement).className).toContain('nex-agent-dot-pulse');
        expect((dots[0] as HTMLElement).dataset['status']).toBe('running');
    });

    it('draws no dot at all when nothing is running or waiting', () => {
        renderSidebar('idle');
        expect(screen.queryByTestId('status-dot')).toBeNull();
    });
});

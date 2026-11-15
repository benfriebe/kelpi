/**
 * Running services, phase 4 (docs/running-services.md §4, §7, D7): live memory and CPU, services
 * idle for days, and the corner card for stacks left by deleted worktrees.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { RunningServiceEntry } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseCornerAction } from './corner-layer';
import { InspectorServices } from './InspectorServices';
import { LEFTOVER_GRACE_MS, leftoverCardGroups, leftoverCopy, LeftoverServicesNotice, nextLeftoverGraceAt } from './LeftoverServicesNotice';
import { RunningServicesChip } from './RunningServicesChip';
import { RunningServicesGlyph } from './RunningServicesGlyph';
import { cpuText, idleByWorkspace, idleDays, liveNumbers, runningByWorkspace, runningFor, type IdlePane, type IdleWorkspace } from './running';
import { ToastCards } from './ToastStack';

afterEach(cleanup);

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const MIB = 1_048_576;

function service(overrides: Partial<RunningServiceEntry> = {}): RunningServiceEntry {
    return {
        id: 'process:100:1',
        kind: 'process',
        name: 'web',
        command: 'pnpm dev',
        category: 'workspace',
        workspace_id: W1,
        workspace_name: 'alpha',
        pane_id: P1,
        attribution: 'process-tree',
        started_by: 'agent',
        agent: 'claude',
        foreground: false,
        directory: '/w/alpha',
        directory_workspace_id: W1,
        directory_workspace_name: 'alpha',
        directory_missing: false,
        worktree: null,
        started_at: new Date(NOW - 5 * DAY).toISOString(),
        pid: 100,
        process_count: 2,
        rss_bytes: 100 * MIB,
        cpu_percent: null,
        ports: [{ port: 3000, address: '127.0.0.1', exposed: false, pid: 101, container_port: null }],
        members: [],
        ...overrides
    };
}

function pane(overrides: Partial<IdlePane> = {}): IdlePane {
    return { id: P1, status: 'idle', lastActivityAt: (NOW - 4 * DAY) / 1000, agentStartedAt: null, backgroundTaskCount: 0, ...overrides };
}

function workspace(panes: readonly IdlePane[]): IdleWorkspace {
    return { id: W1, panes, parkedPanes: [] };
}

describe('live numbers', () => {
    it('takes running-stats when it is the newer, else the list, and no CPU from an older daemon', () => {
        const stats = { scannedAt: '2026-11-15T12:00:10Z', byID: new Map([['process:100:1', { rss: 120 * MIB, cpu: 7 }]]) };
        expect(liveNumbers(service(), stats, '2026-11-15T12:00:00Z')).toEqual({ rss: 120 * MIB, cpu: 7 });
        expect(liveNumbers(service(), stats, '2026-11-15T12:00:20Z')).toEqual({ rss: 100 * MIB, cpu: null });
        const older = { ...service(), cpu_percent: undefined } as unknown as RunningServiceEntry;
        expect(liveNumbers(older, null, null)).toEqual({ rss: 100 * MIB, cpu: null });
    });

    it('writes CPU as a whole percent, a tenth under one', () => {
        expect(cpuText(null)).toBeNull();
        expect(cpuText(0)).toBe('0%');
        expect(cpuText(0.34)).toBe('0.3%');
        expect(cpuText(87.6)).toBe('88%');
    });
});

describe('idle for days (D7)', () => {
    it('is idle when up three days and its pane has been quiet that long', () => {
        expect(idleDays(service(), [workspace([pane()])], NOW)).toBe(4);
        // Up only two days: not yet.
        expect(idleDays(service({ started_at: new Date(NOW - 2 * DAY).toISOString() }), [workspace([pane()])], NOW)).toBeNull();
        // The pane was busy yesterday.
        expect(idleDays(service(), [workspace([pane({ lastActivityAt: (NOW - DAY) / 1000 })])], NOW)).toBeNull();
        expect(idleDays(service(), [workspace([pane({ agentStartedAt: NOW - DAY })])], NOW)).toBeNull();
    });

    it("counts a pane kept 'running' by the server itself as quiet, and a live turn as busy", () => {
        // Claude's background task is the dev server: the pane says running for as long as it runs.
        expect(idleDays(service(), [workspace([pane({ status: 'running', backgroundTaskCount: 1 })])], NOW)).toBe(4);
        expect(idleDays(service(), [workspace([pane({ status: 'running', backgroundTaskCount: 0 })])], NOW)).toBeNull();
        // A turn that ended and nobody looked at is the forgotten case.
        expect(idleDays(service(), [workspace([pane({ status: 'waitingForInput' })])], NOW)).toBe(4);
    });

    it('goes by the workspace when the service has no pane, and is idle once its folder is gone', () => {
        const compose = service({ id: 'compose:shop', kind: 'compose', pane_id: null, agent: null, started_by: 'compose' });
        expect(idleDays(compose, [workspace([pane({ id: 'other' })])], NOW)).toBe(4);
        expect(idleDays(compose, [workspace([pane({ id: 'other', lastActivityAt: NOW / 1000 })])], NOW)).toBeNull();
        expect(idleDays(service({ directory_missing: true }), [workspace([pane({ lastActivityAt: NOW / 1000 })])], NOW)).toBe(5);
        // Leftovers are the card's, not the sidebar's.
        expect(idleDays(service({ category: 'unattached', workspace_id: null }), [workspace([pane()])], NOW)).toBeNull();
    });

    it("gives each workspace its idlest service's days, and the glyph turns amber with them", () => {
        const idle = idleByWorkspace([service(), service({ id: 'process:200:1', started_at: new Date(NOW - 9 * DAY).toISOString() })], [workspace([pane({ lastActivityAt: (NOW - 8 * DAY) / 1000 })])], NOW);
        expect(idle.get(W1)).toBe(8);
        render(<RunningServicesGlyph workspaceID={W1} running={runningFor(runningByWorkspace([service()]), W1)} idleDays={8} bucket="dark" />);
        const glyph = screen.getByTestId(`workspace-running-${W1}`);
        expect(glyph.getAttribute('data-idle')).toBe('true');
        expect(glyph.getAttribute('title')).toBe('1 running · 100.0M · port 3000 · idle for 8 days');
    });
});

describe('the Inspector row', () => {
    it('shows CPU and the live memory, and how long it has sat idle', () => {
        render(
            <InspectorServices
                running={runningFor(runningByWorkspace([service()]), W1)}
                scannedAt={null}
                homeDirectory="/Users/x"
                bucket="dark"
                numbers={() => ({ rss: 300 * MIB, cpu: 12.4 })}
                idle={() => 4}
            />
        );
        const row = screen.getByTestId('inspector-service-process:100:1');
        expect(row.textContent).toContain('12%');
        expect(row.textContent).toContain('300.0M');
        expect(row.textContent).toContain('idle for 4 days');
    });
});

describe('the status bar popover', () => {
    it("shows a leftover worktree's memory once Docker's stats have it, and opens on request", () => {
        const left = service({ id: 'compose:old', kind: 'compose', name: 'old', category: 'unattached', workspace_id: null, pane_id: null, rss_bytes: null, directory_missing: true, worktree: '/w/trees/gone' });
        const view = render(<RunningServicesChip services={[left]} scannedAt={null} homeDirectory="/Users/x" bucket="dark" numbers={() => ({ rss: 512 * MIB, cpu: 1 })} openRequest={0} />);
        expect(screen.queryByTestId('running-popover')).toBeNull();
        view.rerender(<RunningServicesChip services={[left]} scannedAt={null} homeDirectory="/Users/x" bucket="dark" numbers={() => ({ rss: 512 * MIB, cpu: 1 })} openRequest={1} />);
        expect(within(screen.getByTestId('running-popover-worktree')).getByText(/512\.0M/)).toBeDefined();
        cleanup();
        // A chip mounted after that request (the status bar shown again) does not replay it.
        render(<RunningServicesChip services={[left]} scannedAt={null} homeDirectory="/Users/x" bucket="dark" openRequest={1} />);
        expect(screen.queryByTestId('running-popover')).toBeNull();
    });
});

describe('the leftovers card', () => {
    const gone = (id: string, worktree: string): RunningServiceEntry =>
        service({ id, kind: 'compose', name: id, category: 'unattached', workspace_id: null, pane_id: null, directory_missing: true, worktree });

    it('counts only deleted worktrees, after the grace, and not once Later covers them all', () => {
        const seen = new Map<string, number>();
        const services = [gone('compose:a', '/t/one'), gone('compose:b', '/t/one'), gone('compose:c', '/t/two'), service({ id: 'process:9:1', category: 'unattached', workspace_id: null, worktree: '/repo' })];
        const memory = () => 100 * MIB;
        // Just listed: perhaps a delete is still stopping them.
        expect(leftoverCardGroups(services, seen, [], NOW, memory)).toBeNull();
        const card = leftoverCardGroups(services, seen, [], NOW + LEFTOVER_GRACE_MS, memory);
        expect(card?.groups).toEqual([
            { key: '/t/one', name: 'one', stacks: 2, memory: 100 * MIB },
            { key: '/t/two', name: 'two', stacks: 1, memory: 100 * MIB }
        ]);
        // A server in a repo's main checkout that no workspace owns is not a deleted worktree's.
        expect(card?.services.map((entry) => entry.id)).toEqual(['compose:a', 'compose:b', 'compose:c']);
        expect(leftoverCardGroups(services, seen, ['/t/one', '/t/two'], NOW + LEFTOVER_GRACE_MS, memory)).toBeNull();
        // A worktree not yet said Later to brings it back, for that worktree alone: Stop all never
        // reaches the stacks the user chose to keep.
        const back = leftoverCardGroups(services, seen, ['/t/one'], NOW + LEFTOVER_GRACE_MS, memory);
        expect(back?.groups.map((group) => group.key)).toEqual(['/t/two']);
        expect(back?.services.map((entry) => entry.id)).toEqual(['compose:c']);
    });

    it('says when the next stack comes out of its grace, so the card is looked at again then', () => {
        const seen = new Map([['a', NOW], ['b', NOW - 50_000]]);
        expect(nextLeftoverGraceAt(seen, NOW)).toBe(NOW - 50_000 + LEFTOVER_GRACE_MS);
        expect(nextLeftoverGraceAt(seen, NOW + LEFTOVER_GRACE_MS)).toBeNull();
    });

    it('says how many stacks and how much memory, from one worktree or several', () => {
        expect(leftoverCopy([{ key: 'k', name: 'old-checkout', stacks: 2, memory: 893 * MIB }]).body).toBe('2 stacks from old-checkout are still running (893.0M).');
        expect(
            leftoverCopy([
                { key: 'a', name: 'a', stacks: 1, memory: null },
                { key: 'b', name: 'b', stacks: 2, memory: null }
            ]).body
        ).toBe('3 stacks from 2 deleted worktrees are still running.');
    });

    it('offers Later, Review and Stop all, and draws in the toast stack with the clicks relayed', () => {
        const onLater = vi.fn();
        const onReview = vi.fn();
        const onStop = vi.fn();
        render(
            <ToastCards
                toasts={[]}
                oldHosts={null}
                onDismiss={vi.fn()}
                onRestartOldHosts={vi.fn()}
                onLaterOldHosts={vi.fn()}
                leftovers={{ groups: [{ key: 'k', name: 'old', stacks: 1, memory: null }], canReview: true }}
                onLaterLeftovers={onLater}
                onReviewLeftovers={onReview}
                onStopLeftovers={onStop}
            />
        );
        fireEvent.click(screen.getByTestId('leftover-services-later'));
        fireEvent.click(screen.getByTestId('leftover-services-review'));
        fireEvent.click(screen.getByTestId('leftover-services-stop'));
        expect([onLater, onReview, onStop].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1]);
        // The shell's layer sends the same clicks back.
        expect(parseCornerAction({ kind: 'stop-leftovers' })).toEqual({ kind: 'stop-leftovers' });
        expect(parseCornerAction({ kind: 'review-leftovers' })).toEqual({ kind: 'review-leftovers' });
        expect(parseCornerAction({ kind: 'later-leftovers' })).toEqual({ kind: 'later-leftovers' });
    });

    it('has no Review where nothing could open the popover', () => {
        render(<LeftoverServicesNotice groups={[{ key: 'k', name: 'old', stacks: 1, memory: null }]} canReview={false} onLater={vi.fn()} onReview={vi.fn()} onStop={vi.fn()} />);
        expect(screen.queryByTestId('leftover-services-review')).toBeNull();
    });
});

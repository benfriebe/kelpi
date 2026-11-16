import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { RunningServiceEntry, RunningStopResult } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PhoneServicesSheet } from './PhoneServicesSheet';

afterEach(cleanup);

const MIB = 1_048_576;

function service(overrides: Partial<RunningServiceEntry> = {}): RunningServiceEntry {
    return {
        id: 'process:100:1',
        kind: 'process',
        name: 'apps/web',
        command: 'pnpm dev',
        category: 'workspace',
        workspace_id: 'W1',
        workspace_name: 'alpha',
        pane_id: 'P1',
        attribution: 'process-tree',
        started_by: 'agent',
        agent: 'claude',
        foreground: false,
        directory: '/w',
        directory_workspace_id: 'W1',
        directory_workspace_name: 'alpha',
        directory_missing: false,
        worktree: null,
        started_at: '2026-11-15T10:00:00Z',
        pid: 100,
        process_count: 2,
        rss_bytes: 200 * MIB,
        cpu_percent: null,
        ports: [3000, 3001, 3002, 3003].map((port) => ({ port, address: '127.0.0.1', exposed: false, pid: 101, container_port: null })),
        members: [],
        ...overrides
    };
}

function result(overrides: Partial<RunningStopResult> = {}): RunningStopResult {
    return {
        id: 'process:100:1',
        name: 'apps/web',
        ports: [3000],
        action: 'signal',
        signal: 'SIGTERM',
        signalled: 2,
        skipped: [],
        failed: [],
        remaining: [],
        stopped: true,
        restarted_by: null,
        ...overrides
    };
}

function renderSheet(services: readonly RunningServiceEntry[], onStop: (service: RunningServiceEntry, force: boolean) => Promise<readonly RunningStopResult[] | null>, idle: number | null = null) {
    render(
        <PhoneServicesSheet
            open
            workspaceName="alpha"
            services={services}
            scannedAt="2026-11-15T12:00:00Z"
            numbers={() => ({ rss: 300 * MIB, cpu: 12 })}
            idle={() => idle}
            onStop={onStop}
            onClose={vi.fn()}
        />
    );
}

describe('PhoneServicesSheet', () => {
    it("lists the workspace's services with who started them, uptime, ports as text and the live numbers", () => {
        renderSheet([service()], vi.fn(), 4);
        const row = screen.getByTestId('phone-service');
        expect(row.textContent).toContain('apps/web');
        expect(row.textContent).toContain('Claude · up 2h · :3000 :3001 :3002 +1');
        expect(row.textContent).toContain('300.0M');
        expect(row.textContent).toContain('12%');
        expect(row.textContent).toContain('Idle for 4 days');
        // Open is the desktop's (D5): no port is a link here.
        expect(within(row).queryAllByRole('link')).toEqual([]);
    });

    it('says so when nothing runs', () => {
        renderSheet([], vi.fn());
        expect(screen.getByTestId('phone-services-empty').textContent).toBe('Nothing running from this workspace.');
    });

    it('asks in the row before stopping, then says it stopped', async () => {
        const onStop = vi.fn(() => Promise.resolve([result()]));
        renderSheet([service()], onStop);
        fireEvent.click(screen.getByTestId('phone-service-stop'));
        expect(onStop).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('phone-service-cancel'));
        expect(screen.getByTestId('phone-service').getAttribute('data-stop')).toBe('idle');
        fireEvent.click(screen.getByTestId('phone-service-stop'));
        await act(async () => {
            fireEvent.click(screen.getByTestId('phone-service-confirm'));
            await Promise.resolve();
        });
        expect(onStop).toHaveBeenCalledWith(service(), false);
        expect(screen.getByTestId('phone-service').getAttribute('data-stop')).toBe('stopped');
    });

    it('offers Force stop when something is still running, and shows a refusal in place', async () => {
        const onStop = vi
            .fn<(service: RunningServiceEntry, force: boolean) => Promise<readonly RunningStopResult[] | null>>()
            .mockResolvedValueOnce([result({ remaining: [101], stopped: false })])
            .mockResolvedValueOnce([result({ action: null, error: 'apps/web belongs to another user', code: 'NOT_YOURS' })]);
        renderSheet([service()], onStop);
        fireEvent.click(screen.getByTestId('phone-service-stop'));
        await act(async () => {
            fireEvent.click(screen.getByTestId('phone-service-confirm'));
            await Promise.resolve();
        });
        expect(screen.getByTestId('phone-service').textContent).toContain('1 still running');
        await act(async () => {
            fireEvent.click(screen.getByTestId('phone-service-force'));
            await Promise.resolve();
        });
        expect(onStop).toHaveBeenLastCalledWith(service(), true);
        expect(screen.getByTestId('phone-service').textContent).toContain('apps/web belongs to another user');
    });

    it("says a foreground job's pane gets Ctrl-C", () => {
        renderSheet([service({ foreground: true, started_by: 'pane', agent: null })], vi.fn());
        fireEvent.click(screen.getByTestId('phone-service-stop'));
        expect(screen.getByTestId('phone-service').textContent).toContain('Stop it? Its pane gets Ctrl-C.');
    });
});

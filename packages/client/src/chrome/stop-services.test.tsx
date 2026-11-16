/**
 * Stopping running services in the chrome (docs/running-services.md §6): the Inspector row's
 * inline Stop, the row menu's Stop All, the status bar popover's Stop, the dialog that asks, and
 * the delete dialog's "Also stop N services".
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { RunningServiceEntry, RunningStopResult } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InspectorServices } from './InspectorServices';
import { RunningServicesChip } from './RunningServicesChip';
import { Sidebar } from './index';
import { runningByWorkspace, runningFor, stopLabel, stopsWithCtrlC, summarizeStop } from './running';
import { stopServicesByDefault } from './Sidebar';
import { StopServicesDialog, stopPromptFor } from './StopServicesDialog';
import type { ChromePane, ChromeSidebarEntry } from './types';

afterEach(cleanup);

const HOME = '/Users/test';
const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const MIB = 1_048_576;
const SCANNED = '2026-11-15T03:00:00.000Z';

function service(overrides: Partial<RunningServiceEntry> = {}): RunningServiceEntry {
    return {
        id: 'process:100:1',
        kind: 'process',
        name: 'web',
        command: 'node vite',
        category: 'workspace',
        workspace_id: W1.toUpperCase(),
        workspace_name: 'alpha',
        pane_id: P1.toUpperCase(),
        attribution: 'process-tree',
        started_by: 'agent',
        agent: 'claude',
        foreground: false,
        directory: `${HOME}/code/alpha`,
        directory_workspace_id: W1.toUpperCase(),
        directory_workspace_name: 'alpha',
        directory_missing: false,
        started_at: '2026-11-15T02:48:00.000Z',
        pid: 100,
        process_count: 3,
        rss_bytes: 200 * MIB,
        ports: [{ port: 3000, address: '127.0.0.1', exposed: false, pid: 101, container_port: null }],
        members: [
            { name: 'web', pid: 101, container_id: null, image: null, ports: [], rss_bytes: 100 * MIB },
            { name: 'api', pid: 102, container_id: null, image: null, ports: [], rss_bytes: 100 * MIB }
        ],
        worktree: null,
        ...overrides
    };
}

const DETACHED = service();
const FOREGROUND = service({ id: 'process:200:1', name: 'pnpm start', started_by: 'pane', agent: null, foreground: true });
const BY_FOLDER = service({ id: 'process:300:1', name: 'docs', attribution: 'directory', pane_id: null });
const LEFTOVER_A = service({ id: 'compose:shop-1', kind: 'compose', name: 'shop-1', category: 'unattached', workspace_id: null, workspace_name: null, pane_id: null, worktree: `${HOME}/trees/gone`, directory_missing: true });
const LEFTOVER_B = service({ id: 'compose:auth-1', kind: 'compose', name: 'auth-1', category: 'unattached', workspace_id: null, workspace_name: null, pane_id: null, worktree: `${HOME}/trees/gone`, directory_missing: true });
const OUTSIDE = service({ id: 'process:500:1', name: 'postgres', command: 'postgres -D /var/db', category: 'outside', workspace_id: null, workspace_name: null, pane_id: null });

function result(overrides: Partial<RunningStopResult> = {}): RunningStopResult {
    return {
        id: DETACHED.id,
        name: DETACHED.name,
        ports: [3000],
        action: 'signal',
        signal: 'SIGTERM',
        signalled: 3,
        skipped: [],
        failed: [],
        remaining: [],
        stopped: true,
        restarted_by: null,
        ...overrides
    };
}

describe('running.ts stop helpers', () => {
    it('stops only a pane foreground job with Ctrl-C, without asking', () => {
        expect(stopsWithCtrlC(FOREGROUND)).toBe(true);
        expect(stopLabel(FOREGROUND)).toBe('Stop (Ctrl-C)');
        expect(stopsWithCtrlC(DETACHED)).toBe(false);
        expect(stopLabel(DETACHED)).toBe('Stop');
    });

    it('folds results into what a row or dialog says', () => {
        expect(summarizeStop([result()])).toEqual({ done: true, remaining: 0, errors: [], restartedBy: null });
        expect(summarizeStop([result({ remaining: [102], stopped: false }), result({ restarted_by: 'web again' })])).toMatchObject({
            done: false,
            remaining: 1,
            restartedBy: 'web again'
        });
        expect(summarizeStop([result({ action: null, error: 'web has already stopped', code: 'NOT_FOUND' })]).errors).toEqual(['web has already stopped']);
    });

    it('ticks "Also stop" only when every service was started from the workspace panes (D3)', () => {
        const ours = runningFor(runningByWorkspace([DETACHED, FOREGROUND]), W1);
        const mixed = runningFor(runningByWorkspace([DETACHED, BY_FOLDER]), W1);
        expect(ours === undefined ? null : stopServicesByDefault(ours)).toBe(true);
        expect(mixed === undefined ? null : stopServicesByDefault(mixed)).toBe(false);
    });
});

describe('the Inspector row', () => {
    function renderRow(services: readonly RunningServiceEntry[], onStop: (service: RunningServiceEntry, member?: { id: string; name: string }) => void) {
        render(
            <InspectorServices
                running={runningFor(runningByWorkspace(services), W1)}
                scannedAt={SCANNED}
                homeDirectory={HOME}
                bucket="dark"
                onStop={onStop}
            />
        );
    }

    it('asks to stop a service, a foreground job included, through the stop dialog', () => {
        const onStop = vi.fn();
        renderRow([DETACHED, FOREGROUND], onStop);
        const detached = screen.getByTestId(`inspector-service-${DETACHED.id}`);
        expect(within(detached).getByTestId('inspector-service-stop').getAttribute('aria-label')).toBe('Stop web');
        fireEvent.click(within(detached).getByTestId('inspector-service-stop'));
        expect(onStop).toHaveBeenLastCalledWith(DETACHED);
        const foreground = screen.getByTestId(`inspector-service-${FOREGROUND.id}`);
        expect(within(foreground).getByTestId('inspector-service-stop').getAttribute('aria-label')).toBe('Stop (Ctrl-C) pnpm start');
        fireEvent.click(within(foreground).getByTestId('inspector-service-stop'));
        expect(onStop).toHaveBeenLastCalledWith(FOREGROUND);
    });

    it('asks to stop one member of an expanded stack', () => {
        const onStop = vi.fn();
        renderRow([DETACHED], onStop);
        fireEvent.click(screen.getByText('web', { selector: 'span' }));
        const members = screen.getByTestId('inspector-service-members');
        fireEvent.click(within(members).getAllByTestId('inspector-member-stop')[1] as HTMLElement);
        expect(onStop).toHaveBeenCalledWith(DETACHED, { id: '102', name: 'api' });
    });

    it('draws no Stop without a handler', () => {
        render(<InspectorServices running={runningFor(runningByWorkspace([DETACHED]), W1)} scannedAt={SCANNED} homeDirectory={HOME} bucket="dark" />);
        expect(screen.queryByTestId('inspector-service-stop')).toBeNull();
    });
});

describe('the dialog that asks', () => {
    it('names what it stops, and what was started outside Kelpi by its command (D2)', () => {
        expect(stopPromptFor([DETACHED, FOREGROUND], 'in alpha')).toEqual({
            services: [DETACHED, FOREGROUND],
            title: 'Stop 2 services in alpha?',
            detail: 'They use 400.0M.'
        });
        expect(stopPromptFor([OUTSIDE])).toMatchObject({ title: 'Stop postgres?', detail: 'Started outside Kelpi: postgres -D /var/db' });
        // A foreground job asks too, and says how it will be stopped.
        expect(stopPromptFor([FOREGROUND])).toMatchObject({ title: 'Stop pnpm start?', detail: 'Stop sends Ctrl\u2011C to its pane, where it runs in the foreground.' });
        expect(stopPromptFor([DETACHED], undefined, { id: '102', name: 'api' })).toEqual({
            services: [DETACHED],
            member: { id: '102', name: 'api' },
            title: 'Stop api?',
            detail: 'One part of web. A supervisor such as turbo may start it again.'
        });
    });

    it('takes Cancel for Escape, and closes once everything has stopped', async () => {
        const onClose = vi.fn();
        const onStop = vi.fn(() => Promise.resolve([result()]));
        const view = render(<StopServicesDialog prompt={stopPromptFor([DETACHED])} bucket="dark" onStop={onStop} onClose={onClose} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onStop).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.click(screen.getByTestId('stop-services-confirm'));
            await Promise.resolve();
        });
        expect(onStop).toHaveBeenCalledWith([DETACHED], false);
        expect(onClose).toHaveBeenCalledTimes(2);
        view.unmount();
    });

    it('offers Force Stop when something is still running', async () => {
        const onStop = vi
            .fn<(services: readonly RunningServiceEntry[], force: boolean) => Promise<readonly RunningStopResult[] | null>>()
            .mockResolvedValueOnce([result({ remaining: [101, 102], stopped: false })]);
        render(<StopServicesDialog prompt={stopPromptFor([DETACHED])} bucket="dark" onStop={onStop} onClose={vi.fn()} />);
        await act(async () => {
            fireEvent.click(screen.getByTestId('stop-services-confirm'));
            await Promise.resolve();
        });
        expect(screen.getByTestId('stop-services-detail').textContent).toBe('2 still running after the wait.');
        onStop.mockResolvedValueOnce([result({ signal: 'SIGKILL' })]);
        await act(async () => {
            fireEvent.click(screen.getByTestId('stop-services-force'));
            await Promise.resolve();
        });
        expect(onStop).toHaveBeenLastCalledWith([DETACHED], true);
    });

    it('sends Force Stop only to what is still running, never to what already exited', async () => {
        const onStop = vi
            .fn<(services: readonly RunningServiceEntry[], force: boolean) => Promise<readonly RunningStopResult[] | null>>()
            .mockResolvedValueOnce([result(), result({ id: FOREGROUND.id, name: FOREGROUND.name, remaining: [201], stopped: false })])
            .mockResolvedValueOnce([result({ id: FOREGROUND.id, signal: 'SIGKILL' })]);
        const onClose = vi.fn();
        render(<StopServicesDialog prompt={stopPromptFor([DETACHED, FOREGROUND], 'in alpha')} bucket="dark" onStop={onStop} onClose={onClose} />);
        await act(async () => {
            fireEvent.click(screen.getByTestId('stop-services-confirm'));
            await Promise.resolve();
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('stop-services-force'));
            await Promise.resolve();
        });
        expect(onStop).toHaveBeenLastCalledWith([FOREGROUND], true);
        expect(onClose).toHaveBeenCalled();
    });
});

describe('the status bar popover', () => {
    it("stops a leftover worktree's stacks together, and one started outside Kelpi from its row", () => {
        const onStop = vi.fn();
        render(
            <RunningServicesChip services={[LEFTOVER_A, LEFTOVER_B, OUTSIDE]} scannedAt={SCANNED} homeDirectory={HOME} bucket="dark" onStop={onStop} />
        );
        fireEvent.click(screen.getByTestId('footer-running'));
        const group = screen.getByTestId('running-popover-worktree');
        fireEvent.click(within(group).getByTestId('running-popover-stop-group'));
        expect(onStop).toHaveBeenCalledWith([LEFTOVER_A, LEFTOVER_B], 'left in gone');
        // Asking closes the popover; the dialog takes over.
        expect(screen.queryByTestId('running-popover')).toBeNull();

        fireEvent.click(screen.getByTestId('footer-running'));
        fireEvent.click(screen.getByText('Started outside Kelpi'));
        fireEvent.click(screen.getByLabelText('Stop postgres'));
        expect(onStop).toHaveBeenLastCalledWith([OUTSIDE]);
    });
});

describe('the sidebar', () => {
    function shellPane(id: string): ChromePane {
        return { id, title: 'zsh', type: 'shell', status: 'idle', directory: HOME } as unknown as ChromePane;
    }
    const ENTRIES: readonly ChromeSidebarEntry[] = [
        { kind: 'workspace', workspace: { id: W1, name: 'alpha', color: 'blue', icon: null, labels: [], panes: [shellPane(P1)] } },
        { kind: 'workspace', workspace: { id: W2, name: 'beta', color: 'green', icon: null, labels: [], panes: [shellPane(`${W2}-p`)] } }
    ];

    it('offers Stop All under Services ▸, which asks first', () => {
        const onStopServices = vi.fn();
        render(
            <Sidebar
                entries={ENTRIES}
                activeWorkspaceID={W1}
                filter=""
                onFilterChange={vi.fn()}
                rowHeight={20}
                runningServices={runningByWorkspace([DETACHED, FOREGROUND])}
                onShowServices={vi.fn()}
                onStopServices={onStopServices}
            />
        );
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Services'));
        fireEvent.click(within(screen.getByTestId('context-submenu')).getByText('Stop All (2)…'));
        expect(onStopServices).toHaveBeenCalledWith(W1);
    });

    it('asks to stop the services with the delete, ticked per D3, and passes the answer on', () => {
        const onDeleteWorkspace = vi.fn();
        const props = {
            entries: ENTRIES,
            activeWorkspaceID: W1,
            filter: '',
            onFilterChange: vi.fn(),
            rowHeight: 20,
            onDeleteWorkspace
        };
        const view = render(<Sidebar {...props} runningServices={runningByWorkspace([DETACHED, FOREGROUND])} />);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.click(screen.getByText('Delete'));
        const box = screen.getByTestId('confirm-stop-services') as HTMLInputElement;
        expect(box.checked).toBe(true);
        expect(box.parentElement?.textContent).toBe('Also stop 2 services (400.0M)');
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(onDeleteWorkspace).toHaveBeenCalledWith(W1, undefined, { stopServices: true });
        view.unmount();

        // One placed only by its folder may be someone else's: unticked, and the delete stops nothing.
        render(<Sidebar {...props} runningServices={runningByWorkspace([DETACHED, BY_FOLDER])} />);
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.click(screen.getByText('Delete'));
        expect((screen.getByTestId('confirm-stop-services') as HTMLInputElement).checked).toBe(false);
        fireEvent.click(screen.getByTestId('confirm-delete'));
        expect(onDeleteWorkspace).toHaveBeenLastCalledWith(W1);
    });
});

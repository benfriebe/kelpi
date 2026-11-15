/**
 * Running services in the chrome (docs/running-services.md §7): the grouping every surface shares,
 * the sidebar glyph and row menu, the Inspector section and the status bar chip.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { RunningServiceEntry, RunningServicePort } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InspectorServices } from './InspectorServices';
import { leftoverGroups, RunningServicesChip } from './RunningServicesChip';
import { Sidebar } from './index';
import {
    memoryText,
    pathTail,
    portURL,
    runningByWorkspace,
    runningFor,
    runningSummary,
    runsElsewhere,
    servicesOfPane,
    shortServiceName,
    starterText,
    uptimeText,
    workspaceLooks
} from './running';
import type { ChromePane, ChromeSidebarEntry } from './types';

afterEach(cleanup);

const HOME = '/Users/test';
const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const MIB = 1_048_576;
const SCANNED = '2026-11-15T03:00:00.000Z';

function port(value: number, overrides: Partial<RunningServicePort> = {}): RunningServicePort {
    return { port: value, address: '127.0.0.1', exposed: false, pid: 100, container_port: null, ...overrides };
}

/** A process stack a pane in W1 started; the wire sends workspace and pane ids uppercase. */
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
        started_by: 'pane',
        agent: null,
        foreground: true,
        directory: `${HOME}/code/alpha`,
        directory_workspace_id: W1.toUpperCase(),
        directory_workspace_name: 'alpha',
        directory_missing: false,
        started_at: '2026-11-15T02:48:00.000Z',
        pid: 100,
        process_count: 2,
        rss_bytes: 200 * MIB,
        ports: [port(3000)],
        members: [{ name: 'node', pid: 100, container_id: null, image: null, ports: [port(3000)], rss_bytes: 200 * MIB }],
        worktree: null,
        ...overrides
    };
}

const ALPHA_WEB = service();
const ALPHA_API = service({ id: 'process:200:1', name: 'api', pid: 200, rss_bytes: 100 * MIB, ports: [port(4000), port(4001)] });
const BETA_DB = service({
    id: 'compose:beta',
    kind: 'compose',
    name: 'beta',
    command: 'docker compose -p beta',
    workspace_id: W2.toUpperCase(),
    workspace_name: 'beta',
    pane_id: null,
    attribution: 'compose-label',
    started_by: 'compose',
    foreground: false,
    pid: null,
    rss_bytes: null,
    ports: [port(5432, { pid: null, container_port: 5432 })],
    members: []
});
const AGENT = service({ id: 'process:300:1', name: 'claude', category: 'agent', ports: [port(54_000)] });
const LEFTOVER = service({
    id: 'process:400:1',
    name: 'old-web',
    category: 'unattached',
    workspace_id: null,
    workspace_name: null,
    pane_id: null,
    directory: `${HOME}/worktrees/gone`,
    directory_missing: true,
    ports: [port(3100)]
});
const OUTSIDE = service({ id: 'process:500:1', name: 'postgres', category: 'outside', workspace_id: null, workspace_name: null, pane_id: null });

const ALL = [ALPHA_WEB, ALPHA_API, BETA_DB, AGENT, LEFTOVER, OUTSIDE];

describe('running.ts', () => {
    it('groups only workspace services, by uppercase workspace id', () => {
        const grouped = runningByWorkspace(ALL);
        expect([...grouped.keys()]).toEqual([W1.toUpperCase(), W2.toUpperCase()]);
        const alpha = runningFor(grouped, W1);
        expect(alpha?.services.map((s) => s.name)).toEqual(['web', 'api']);
        expect(alpha?.portCount).toBe(3);
        expect(alpha?.rssBytes).toBe(300 * MIB);
        // A compose project has no resident memory of its own yet.
        expect(runningFor(grouped, W2)?.rssBytes).toBe(0);
        expect(runningFor(grouped, 'nope')).toBeUndefined();
        expect(runningFor(undefined, W1)).toBeUndefined();
    });

    it("lists a pane's services without the agent's own port", () => {
        // The agent (`claude`) shares the pane's process tree but is not something it started.
        expect(servicesOfPane(ALL, P1).map((s) => s.name)).toEqual(['web', 'api']);
        expect(servicesOfPane(ALL, P1.toLowerCase())).toHaveLength(2);
    });

    it('formats memory, uptime and the starter', () => {
        expect(memoryText(null)).toBe('-');
        expect(memoryText(0)).toBe('-');
        expect(memoryText(512 * MIB)).toBe('512.0M');
        expect(uptimeText('2026-11-15T02:59:20.000Z', SCANNED)).toBe('40s');
        expect(uptimeText('2026-11-15T02:48:00.000Z', SCANNED)).toBe('12m');
        expect(uptimeText('2026-11-14T22:00:00.000Z', SCANNED)).toBe('5h');
        expect(uptimeText('2026-11-12T03:00:00.000Z', SCANNED)).toBe('3d');
        expect(uptimeText(null, SCANNED)).toBe('-');
        // A clock skewed ahead of the scan never shows a negative age.
        expect(uptimeText('2026-11-15T03:00:05.000Z', SCANNED)).toBe('0s');
        expect(starterText(service({ agent: 'claude', started_by: 'agent' }))).toBe('Claude');
        expect(starterText(service({ agent: 'codex', started_by: 'agent' }))).toBe('Codex');
        expect(starterText(service({ foreground: true }))).toBe('pane, foreground');
        expect(starterText(service({ foreground: false }))).toBe('pane');
        expect(starterText(BETA_DB)).toBe('compose');
        expect(starterText(service({ started_by: 'unknown' }))).toBe('detached');
    });

    it('keeps a long folder to its last segments', () => {
        expect(pathTail(`${HOME}/code/alpha`, HOME)).toBe('~/code/alpha');
        expect(pathTail(`${HOME}/kelpi/worktrees/shop/old-checkout/apps/orders-api`, HOME)).toBe('…/shop/old-checkout/apps/orders-api');
        expect(pathTail('/a/very-long-single-segment-name-that-will-not-fit-anywhere', HOME, 20)).toBe('…/very-long-single-segment-name-that-will-not-fit-anywhere');
    });

    it('cuts a long name for the row menu', () => {
        expect(shortServiceName(ALPHA_WEB)).toBe('web');
        const long = service({ name: "node -e for (const p of [4400, 4401]) require('http')" });
        expect(shortServiceName(long)).toBe('node -e for (const p of [44…');
        expect(shortServiceName(long)).toHaveLength(28);
    });

    it('opens a port on the loopback address it answers on', () => {
        expect(portURL(port(3000))).toBe('http://localhost:3000/');
        expect(portURL(port(3000, { address: '*' }))).toBe('http://localhost:3000/');
        expect(portURL(port(8765, { address: '::1' }))).toBe('http://[::1]:8765/');
    });

    it('notices a service running in another workspace’s folder', () => {
        expect(runsElsewhere(ALPHA_WEB)).toBe(false);
        expect(runsElsewhere(service({ directory_workspace_id: W2.toUpperCase() }))).toBe(true);
        expect(runsElsewhere(service({ directory_workspace_id: null }))).toBe(true);
        expect(runsElsewhere(service({ directory: null }))).toBe(false);
    });

    it('summarises a workspace for the glyph tooltip', () => {
        const many = service({ ports: [3000, 3001, 3002, 3003, 3004, 3005].map((value) => port(value)) });
        const grouped = runningByWorkspace([many]);
        expect(runningSummary(runningFor(grouped, W1)!)).toBe('1 running · 200.0M · ports 3000 3001 3002 3003 +2');
        expect(runningSummary(runningFor(runningByWorkspace([BETA_DB]), W2)!)).toBe('1 running · port 5432');
    });
});

function shellPane(id: string): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: `${HOME}/code`,
        gitBranch: null,
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

const ENTRIES: ChromeSidebarEntry[] = [
    { kind: 'workspace', workspace: { id: W1, name: 'alpha', color: 'blue', icon: null, labels: [], panes: [shellPane(P1)] } },
    { kind: 'workspace', workspace: { id: W2, name: 'beta', color: 'green', icon: null, labels: [], panes: [shellPane(`${W2}-p`)] } }
];

function renderSidebar(
    handlers: {
        onOpenServicePort?: (service: RunningServiceEntry, port: RunningServicePort) => void;
        onShowServices?: (workspaceID: string) => void;
    } = {}
) {
    render(
        <Sidebar
            entries={ENTRIES}
            activeWorkspaceID={W1}
            filter=""
            onFilterChange={vi.fn()}
            rowHeight={20}
            runningServices={runningByWorkspace(ALL)}
            onOpenServicePort={handlers.onOpenServicePort}
            onShowServices={handlers.onShowServices}
        />
    );
}

describe('the sidebar', () => {
    it('marks a workspace that runs something, with the count past one', () => {
        renderSidebar();
        const alpha = screen.getByTestId(`workspace-running-${W1}`);
        expect(alpha.getAttribute('data-running-count')).toBe('2');
        expect(alpha.textContent).toBe('2');
        expect(alpha.getAttribute('title')).toBe('2 running · 300.0M · ports 3000 4000 4001');
        // One service draws the plug alone.
        expect(screen.getByTestId(`workspace-running-${W2}`).textContent).toBe('');
    });

    it("shows a collapsed group's total, and nothing once it is open", () => {
        const G1 = 'cccccccc-0000-4000-8000-000000000001';
        const grouped = (isCollapsed: boolean): ChromeSidebarEntry[] => [
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed },
                workspaces: ENTRIES.map((entry) => (entry.kind === 'workspace' ? entry.workspace : null)).filter((w) => w !== null)
            }
        ];
        const view = render(
            <Sidebar
                entries={grouped(true)}
                activeWorkspaceID={W1}
                filter=""
                onFilterChange={vi.fn()}
                rowHeight={20}
                runningServices={runningByWorkspace(ALL)}
            />
        );
        const total = screen.getByTestId(`group-running-${G1}`);
        expect(total.getAttribute('data-running-count')).toBe('3');
        expect(total.getAttribute('title')).toBe('3 running · 300.0M · ports 3000 4000 4001 5432');
        view.rerender(
            <Sidebar
                entries={grouped(false)}
                activeWorkspaceID={W1}
                filter=""
                onFilterChange={vi.fn()}
                rowHeight={20}
                runningServices={runningByWorkspace(ALL)}
            />
        );
        expect(screen.queryByTestId(`group-running-${G1}`)).toBeNull();
        expect(screen.getByTestId(`workspace-running-${W1}`)).toBeDefined();
    });

    it('offers each port and the Inspector under Services ▸', () => {
        const onOpenServicePort = vi.fn();
        const onShowServices = vi.fn();
        renderSidebar({ onOpenServicePort, onShowServices });
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Services'));
        const submenu = screen.getByTestId('context-submenu');
        const labels = within(submenu)
            .getAllByRole('menuitem')
            .map((item) => item.textContent?.trim());
        expect(labels).toEqual([
            'Open localhost:3000 · web',
            'Open localhost:4000 · api',
            'Open localhost:4001 · api',
            'Show in Inspector'
        ]);

        fireEvent.click(within(submenu).getByText('Open localhost:4001 · api'));
        expect(onOpenServicePort).toHaveBeenCalledWith(ALPHA_API, ALPHA_API.ports[1]);

        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        fireEvent.mouseEnter(screen.getByText('Services'));
        fireEvent.click(within(screen.getByTestId('context-submenu')).getByText('Show in Inspector'));
        expect(onShowServices).toHaveBeenCalledWith(W1);
    });

    it('has no Services ▸ for a workspace running nothing, or with no handlers', () => {
        render(
            <Sidebar
                entries={ENTRIES}
                activeWorkspaceID={W1}
                filter=""
                onFilterChange={vi.fn()}
                rowHeight={20}
                runningServices={runningByWorkspace([BETA_DB])}
                onOpenServicePort={vi.fn()}
                onShowServices={vi.fn()}
            />
        );
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        expect(screen.queryByText('Services')).toBeNull();
        cleanup();

        renderSidebar();
        fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as HTMLElement);
        expect(screen.queryByText('Services')).toBeNull();
    });
});

describe('the Inspector section', () => {
    it('says so when the workspace runs nothing', () => {
        render(<InspectorServices running={undefined} scannedAt={SCANNED} homeDirectory={HOME} bucket="dark" />);
        expect(screen.getByTestId('inspector-services-empty').textContent).toBe('Nothing running from this workspace.');
    });

    it('lists each service with its starter, uptime and ports, and opens a port', () => {
        const onOpenPort = vi.fn();
        render(
            <InspectorServices
                running={runningFor(runningByWorkspace(ALL), W1)}
                scannedAt={SCANNED}
                homeDirectory={HOME}
                bucket="dark"
                onOpenPort={onOpenPort}
            />
        );
        expect(screen.getByTestId('inspector-services-summary').textContent).toBe('2 running · 3 ports · 300.0M');
        const web = screen.getByTestId(`inspector-service-${ALPHA_WEB.id}`);
        expect(web.textContent).toBe('web200.0Mpane, foreground · up 12m:3000');
        fireEvent.click(within(web).getByText(':3000'));
        expect(onOpenPort).toHaveBeenCalledWith(ALPHA_WEB, ALPHA_WEB.ports[0]);
        // A port click does not also expand the row.
        expect(web.getAttribute('data-open')).toBe('false');
    });

    it('expands to members, the folder and the starting pane', () => {
        const onShowPane = vi.fn();
        const exposed = service({
            members: [{ name: 'node', pid: 100, container_id: null, image: null, ports: [port(3000, { address: '*', exposed: true })], rss_bytes: 200 * MIB }]
        });
        render(
            <InspectorServices
                running={runningFor(runningByWorkspace([exposed]), W1)}
                scannedAt={SCANNED}
                homeDirectory={HOME}
                bucket="dark"
                onShowPane={onShowPane}
            />
        );
        // One service says it all on its row: no summary line above it.
        expect(screen.queryByTestId('inspector-services-summary')).toBeNull();
        const row = screen.getByTestId(`inspector-service-${exposed.id}`);
        fireEvent.click(within(row).getByText('web'));
        expect(row.getAttribute('data-open')).toBe('true');
        const members = screen.getByTestId('inspector-service-members');
        expect(members.textContent).toContain('network');
        expect(members.textContent).toContain('2 processes · ~/code/alpha');
        fireEvent.click(within(members).getByText('Show the pane that started it'));
        expect(onShowPane).toHaveBeenCalledWith(P1.toUpperCase());
    });

    it('warns when the folder is gone or belongs to another workspace', () => {
        const gone = service({ id: 'process:1:1', directory: `${HOME}/worktrees/old`, directory_missing: true, directory_workspace_id: null });
        const elsewhere = service({ id: 'process:2:1', name: 'api', directory: `${HOME}/code/beta`, directory_workspace_id: W2.toUpperCase() });
        render(
            <InspectorServices running={runningFor(runningByWorkspace([gone, elsewhere]), W1)} scannedAt={SCANNED} homeDirectory={HOME} bucket="dark" />
        );
        expect(screen.getByTestId('inspector-service-process:1:1').textContent).toContain('folder deleted: ~/worktrees/old');
        expect(screen.getByTestId('inspector-service-process:2:1').textContent).toContain('runs in ~/code/beta');
    });
});

describe('the status bar chip', () => {
    it('draws nothing until a workspace or a leftover runs something', () => {
        const { container } = render(
            <RunningServicesChip services={[AGENT, OUTSIDE]} scannedAt={SCANNED} homeDirectory={HOME} bucket="dark" />
        );
        expect(container.innerHTML).toBe('');
    });

    it("counts the workspaces' services, then leftovers, never the agent or what runs outside Kelpi", () => {
        render(<RunningServicesChip services={ALL} scannedAt={SCANNED} homeDirectory={HOME} bucket="dark" />);
        const chip = screen.getByTestId('footer-running');
        expect(chip.getAttribute('data-count')).toBe('3');
        expect(chip.textContent).toBe('3services· 1 leftover');
    });

    it('lists one line per service with its workspace once, then leftovers, then what runs outside Kelpi, collapsed', () => {
        const onOpenPort = vi.fn();
        const onSelectWorkspace = vi.fn();
        render(
            <RunningServicesChip
                services={ALL}
                scannedAt={SCANNED}
                homeDirectory={HOME}
                bucket="dark"
                looks={workspaceLooks([
                    { id: W1, color: 'blue', icon: null },
                    { id: W2, color: 'green', icon: null }
                ])}
                onOpenPort={onOpenPort}
                onSelectWorkspace={onSelectWorkspace}
            />
        );
        fireEvent.click(screen.getByTestId('footer-running'));
        const popover = screen.getByTestId('running-popover');
        const rows = within(within(popover).getByTestId('running-popover-workspaces')).getAllByTestId('running-popover-service');
        // alpha's two services, then beta's; the workspace is named on its first row only.
        expect(rows.map((row) => row.textContent)).toEqual([
            'Aalphaweb:3000200.0M',
            'api:4000:4001100.0M',
            'Bbetabeta:5432'
        ]);
        expect(popover.textContent).toContain('300.0M');

        const leftovers = within(popover).getByTestId('running-popover-unattached');
        expect(leftovers.textContent).toContain('Left running after their worktree was deleted');
        expect(within(leftovers).getByTestId('running-popover-worktree').textContent).toBe('gone1 stack · 12 minutesold-web:3100');

        const outside = within(popover).getByTestId('running-popover-outside');
        expect(within(outside).queryByText('postgres')).toBeNull();
        fireEvent.click(within(outside).getByText('Started outside Kelpi'));
        expect(within(outside).getByText('postgres')).toBeDefined();

        fireEvent.click(within(popover).getByText(':4000'));
        expect(onOpenPort).toHaveBeenCalledWith(ALPHA_API, ALPHA_API.ports[0]);

        fireEvent.click(within(popover).getByTitle('Go to beta'));
        expect(onSelectWorkspace).toHaveBeenCalledWith(W2.toUpperCase());
        expect(screen.queryByTestId('running-popover')).toBeNull();
    });

    it('groups leftovers by the worktree they ran in, oldest first for its age', () => {
        const tree = `${HOME}/trees/shop/old-checkout`;
        const stacks = [
            service({ id: 'compose:a', name: 'shop-3100', category: 'unattached', workspace_id: null, pane_id: null, worktree: tree, directory: `${tree}/apps/api`, directory_missing: true, started_at: '2026-10-18T03:00:00.000Z' }),
            service({ id: 'compose:b', name: 'auth-3100', category: 'unattached', workspace_id: null, pane_id: null, worktree: tree, directory: `${tree}/packages/auth`, directory_missing: true, started_at: '2026-10-20T03:00:00.000Z' }),
            service({ id: 'process:9:1', name: 'stray', category: 'unattached', workspace_id: null, pane_id: null, worktree: `${HOME}/code/shop`, directory: `${HOME}/code/shop`, started_at: '2026-11-15T01:00:00.000Z' })
        ];
        const groups = leftoverGroups(stacks);
        expect(groups.map((group) => [group.folder, group.services.length, group.deleted, group.startedAt])).toEqual([
            [tree, 2, true, '2026-10-18T03:00:00.000Z'],
            [`${HOME}/code/shop`, 1, false, '2026-11-15T01:00:00.000Z']
        ]);

        render(<RunningServicesChip services={stacks} scannedAt={SCANNED} homeDirectory={HOME} bucket="dark" />);
        fireEvent.click(screen.getByTestId('footer-running'));
        const leftovers = screen.getByTestId('running-popover-unattached');
        // Not every one is deleted, so the heading is the general one and the deleted group says so.
        expect(leftovers.textContent).toContain('Not in a workspace');
        expect(within(leftovers).getAllByTestId('running-popover-worktree').map((group) => group.querySelector('div')?.textContent)).toEqual([
            'old-checkoutdeleted · 2 stacks · 28 days',
            'shop1 stack · 2 hours'
        ]);
    });
});

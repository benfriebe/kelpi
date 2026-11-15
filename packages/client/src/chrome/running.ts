/**
 * Running services in the chrome (docs/running-services.md §7): the daemon's last scan, grouped
 * the way the sidebar, Inspector, pane headers and status bar read it. Pure, so every surface
 * agrees on what "a workspace's services" means.
 *
 * A workspace's services are the scan's `workspace` category with that owner. An agent's own
 * local port (`agent` category) is never counted: it is the agent, not something it started.
 */

import type { IconRef, WorkspaceColor } from '@kelpi/daemon/store';
import type { RunningServiceEntry, RunningServicePort } from '@kelpi/protocol';

import { formatBytes } from './stats';
import { homeAbbreviated } from './theme';

export interface WorkspaceRunning {
    readonly services: readonly RunningServiceEntry[];
    readonly portCount: number;
    /** Resident memory of the process stacks; containers have none yet. */
    readonly rssBytes: number;
}

/** A workspace's services, keyed by workspace id (uppercase, as the wire sends it). */
export function runningByWorkspace(services: readonly RunningServiceEntry[]): ReadonlyMap<string, WorkspaceRunning> {
    const grouped = new Map<string, RunningServiceEntry[]>();
    for (const service of services) {
        if (service.category !== 'workspace' || service.workspace_id === null) continue;
        const key = service.workspace_id.toUpperCase();
        const list = grouped.get(key) ?? [];
        list.push(service);
        grouped.set(key, list);
    }
    const out = new Map<string, WorkspaceRunning>();
    for (const [id, list] of grouped) {
        out.set(id, {
            services: list,
            portCount: list.reduce((sum, service) => sum + service.ports.length, 0),
            rssBytes: list.reduce((sum, service) => sum + (service.rss_bytes ?? 0), 0)
        });
    }
    return out;
}

/** What a workspace's avatar is drawn from, outside the sidebar. */
export interface WorkspaceLook {
    readonly color: WorkspaceColor | null;
    readonly icon: IconRef | null;
}

/** Each workspace's look, keyed by uppercase id (the wire's spelling). */
export function workspaceLooks(
    workspaces: readonly { readonly id: string; readonly color: WorkspaceColor | null; readonly icon: IconRef | null }[]
): ReadonlyMap<string, WorkspaceLook> {
    return new Map(workspaces.map((workspace) => [workspace.id.toUpperCase(), { color: workspace.color, icon: workspace.icon }]));
}

export function runningFor(map: ReadonlyMap<string, WorkspaceRunning> | undefined, workspaceID: string): WorkspaceRunning | undefined {
    return map?.get(workspaceID.toUpperCase());
}

/** Several workspaces' services together: a collapsed group header's total. */
export function runningOfWorkspaces(
    map: ReadonlyMap<string, WorkspaceRunning> | undefined,
    workspaceIDs: readonly string[]
): WorkspaceRunning | undefined {
    const parts = workspaceIDs.map((id) => runningFor(map, id)).filter((part): part is WorkspaceRunning => part !== undefined);
    if (parts.length === 0) return undefined;
    return {
        services: parts.flatMap((part) => part.services),
        portCount: parts.reduce((sum, part) => sum + part.portCount, 0),
        rssBytes: parts.reduce((sum, part) => sum + part.rssBytes, 0)
    };
}

/** The services a pane started (its process tree reaches the pane's shell). */
export function servicesOfPane(services: readonly RunningServiceEntry[], paneID: string): readonly RunningServiceEntry[] {
    const wanted = paneID.toUpperCase();
    return services.filter((service) => service.category !== 'agent' && service.pane_id?.toUpperCase() === wanted);
}

/** `1.4G`, `512M`; `-` for none (containers). */
export function memoryText(bytes: number | null | undefined): string {
    return bytes === null || bytes === undefined || bytes <= 0 ? '-' : formatBytes(bytes);
}

/** `40s`, `12m`, `5h`, `3d`: the time since `startedAt`, against the scan's own clock. */
export function uptimeText(startedAt: string | null, scannedAt: string | null): string {
    const start = startedAt === null ? Number.NaN : Date.parse(startedAt);
    const end = scannedAt === null ? Date.now() : Date.parse(scannedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '-';
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    if (seconds < 60) return `${String(seconds)}s`;
    if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
    if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h`;
    return `${String(Math.floor(seconds / 86_400))}d`;
}

/** Who started it, for a sub-line: `Claude`, `Codex`, `pane`, `compose`. */
export function starterText(service: RunningServiceEntry): string {
    if (service.agent === 'claude') return 'Claude';
    if (service.agent === 'codex') return 'Codex';
    if (service.started_by === 'pane') return service.foreground ? 'pane, foreground' : 'pane';
    if (service.started_by === 'compose') return 'compose';
    // Its pane is gone, or it never had one: it runs on with no terminal.
    return 'detached';
}

/** A service's name cut to `max` characters, for a menu that sizes itself to its longest row. */
export function shortServiceName(service: RunningServiceEntry, max = 28): string {
    return service.name.length <= max ? service.name : `${service.name.slice(0, max - 1)}…`;
}

/**
 * A folder short enough for one line: home as `~`, and past `max` characters only its last
 * segments (`…/old-checkout/apps/orders-api`), which are what tell two worktrees apart. The
 * caller puts the full path in a tooltip.
 */
export function pathTail(path: string, homeDirectory: string, max = 44): string {
    const short = homeAbbreviated(path, homeDirectory);
    if (short.length <= max) return short;
    const parts = short.split('/');
    let tail = parts[parts.length - 1] ?? short;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
        const next = `${parts[index] ?? ''}/${tail}`;
        if (next.length + 2 > max) break;
        tail = next;
    }
    return `…/${tail}`;
}

/** The URL a port chip opens: the loopback address it answers on. */
export function portURL(port: RunningServicePort): string {
    const host = port.address === '::1' ? '[::1]' : 'localhost';
    return `http://${host}:${String(port.port)}/`;
}

/** The folder a service runs in, when it is not its own workspace's (an agent ran it elsewhere). */
export function runsElsewhere(service: RunningServiceEntry): boolean {
    return service.directory !== null && service.directory_workspace_id?.toUpperCase() !== service.workspace_id?.toUpperCase();
}

/** The sidebar glyph's tooltip: `3 running · 1.4G · ports 3200 3201 +4`. */
export function runningSummary(running: WorkspaceRunning): string {
    const ports = running.services.flatMap((service) => service.ports.map((port) => port.port));
    const shown = ports.slice(0, 4).join(' ');
    const more = ports.length > 4 ? ` +${String(ports.length - 4)}` : '';
    const parts = [`${String(running.services.length)} running`];
    if (running.rssBytes > 0) parts.push(memoryText(running.rssBytes));
    if (ports.length > 0) parts.push(`port${ports.length === 1 ? '' : 's'} ${shown}${more}`);
    return parts.join(' · ');
}

/**
 * Running services in the chrome (docs/running-services.md §7): the daemon's last scan, grouped
 * the way the sidebar, Inspector, pane headers and status bar read it. Pure, so every surface
 * agrees on what "a workspace's services" means.
 *
 * A workspace's services are the scan's `workspace` category with that owner. An agent's own
 * local port (`agent` category) is never counted: it is the agent, not something it started.
 */

import type { IconRef, WorkspaceColor } from '@kelpi/daemon/store';
import type { RunningServiceEntry, RunningServicePort, RunningStopResult } from '@kelpi/protocol';

import { formatBytes } from './stats';
import { homeAbbreviated } from './theme';

export interface WorkspaceRunning {
    readonly services: readonly RunningServiceEntry[];
    readonly portCount: number;
    /** Resident memory of the process stacks; containers have none yet. */
    readonly rssBytes: number;
}

/**
 * One grouping per scan: the callers rebuild their models on every store change, and a new
 * `WorkspaceRunning` each time would re-render every memoized sidebar row that runs something.
 */
const groupedByScan = new WeakMap<readonly RunningServiceEntry[], ReadonlyMap<string, WorkspaceRunning>>();
const totalsByGrouping = new WeakMap<ReadonlyMap<string, WorkspaceRunning>, Map<string, WorkspaceRunning | undefined>>();
const NO_RUNNING: ReadonlyMap<string, WorkspaceRunning> = new Map();

/** A workspace's services, keyed by workspace id (uppercase, as the wire sends it). */
export function runningByWorkspace(services: readonly RunningServiceEntry[]): ReadonlyMap<string, WorkspaceRunning> {
    if (services.length === 0) return NO_RUNNING;
    const known = groupedByScan.get(services);
    if (known !== undefined) return known;
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
    groupedByScan.set(services, out);
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
    if (map === undefined) return undefined;
    const key = workspaceIDs.map((id) => id.toUpperCase()).join(' ');
    const totals = totalsByGrouping.get(map) ?? new Map<string, WorkspaceRunning | undefined>();
    totalsByGrouping.set(map, totals);
    if (totals.has(key)) return totals.get(key);
    const parts = workspaceIDs.map((id) => runningFor(map, id)).filter((part): part is WorkspaceRunning => part !== undefined);
    const total = parts.length === 0
        ? undefined
        : {
              services: parts.flatMap((part) => part.services),
              portCount: parts.reduce((sum, part) => sum + part.portCount, 0),
              rssBytes: parts.reduce((sum, part) => sum + part.rssBytes, 0)
          };
    totals.set(key, total);
    return total;
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

/**
 * The daemon's clock now: its last scan's time plus what has passed here since the scan arrived.
 * The daemon broadcasts only when the list changes, so its `scannedAt` alone would hold every
 * uptime at what it was then; measuring from the daemon's clock keeps a remote client's skew out.
 */
export function scanClock(
    running: { readonly scannedAt: string | null; readonly receivedAt?: number | undefined } | null | undefined,
    now = Date.now()
): string | null {
    if (running === null || running === undefined || running.scannedAt === null) return null;
    const at = Date.parse(running.scannedAt);
    if (!Number.isFinite(at) || running.receivedAt === undefined) return running.scannedAt;
    return new Date(at + Math.max(0, now - running.receivedAt)).toISOString();
}

type Elapsed = { readonly count: number; readonly unit: 'second' | 'minute' | 'hour' | 'day' };

/** The time since `startedAt` in its largest whole unit, against the daemon's clock (`scanClock`). */
function elapsed(startedAt: string | null, scannedAt: string | null): Elapsed | null {
    const start = startedAt === null ? Number.NaN : Date.parse(startedAt);
    const end = scannedAt === null ? Date.now() : Date.parse(scannedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    if (seconds < 60) return { count: seconds, unit: 'second' };
    if (seconds < 3600) return { count: Math.floor(seconds / 60), unit: 'minute' };
    if (seconds < 86_400) return { count: Math.floor(seconds / 3600), unit: 'hour' };
    return { count: Math.floor(seconds / 86_400), unit: 'day' };
}

/** `40s`, `12m`, `5h`, `3d`. */
export function uptimeText(startedAt: string | null, scannedAt: string | null): string {
    const time = elapsed(startedAt, scannedAt);
    return time === null ? '-' : `${String(time.count)}${time.unit.charAt(0)}`;
}

/** `9 days`, `3 hours`: a leftover worktree's age, in words. */
export function ageText(startedAt: string | null, scannedAt: string | null): string | null {
    const time = elapsed(startedAt, scannedAt);
    return time === null ? null : `${String(time.count)} ${time.unit}${time.count === 1 ? '' : 's'}`;
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

/**
 * The folder a service runs in, when it is not its own workspace's (an agent ran it elsewhere).
 * A workspace with no repository owns no folders, so for it only another workspace's folder counts.
 */
export function runsElsewhere(service: RunningServiceEntry, ownsFolders = true): boolean {
    if (service.directory === null) return false;
    if (service.directory_workspace_id === null) return ownsFolders;
    return service.directory_workspace_id.toUpperCase() !== service.workspace_id?.toUpperCase();
}

// ── live numbers (phase 4) ──────────────────────────────────────────────────────────

/** A service's memory and CPU right now: `running-stats` when it is the newer, else the list's. */
export interface LiveNumbers {
    readonly rss: number | null;
    readonly cpu: number | null;
}

export function liveNumbers(
    service: RunningServiceEntry,
    stats: { readonly scannedAt: string | null; readonly byID: ReadonlyMap<string, LiveNumbers> } | null | undefined,
    listScannedAt: string | null
): LiveNumbers {
    const fresh = stats !== null && stats !== undefined && (listScannedAt === null || (stats.scannedAt ?? '') >= listScannedAt);
    const live = fresh ? stats.byID.get(service.id) : undefined;
    // An older daemon sends no `cpu_percent`: no figure, not 0.
    return live ?? { rss: service.rss_bytes, cpu: service.cpu_percent ?? null };
}

/** `12%`, `0.3%` under one percent, null when there is no figure. */
export function cpuText(percent: number | null): string | null {
    if (percent === null) return null;
    return percent > 0 && percent < 1 ? `${percent.toFixed(1)}%` : `${String(Math.round(percent))}%`;
}

// ── idle for days (D7, phase 4) ─────────────────────────────────────────────────────

export const IDLE_DAYS = 3;
const DAY_MS = 86_400_000;

/** The pane fields the idle rule reads, as the mirror holds them. */
export interface IdlePane {
    readonly id: string;
    readonly status: string;
    /** Epoch seconds: bumped when the pane's title or folder changes (Claude retitles as it works). */
    readonly lastActivityAt: number;
    /** Epoch ms of the agent's latest turn; transient, so null after a daemon restart. */
    readonly agentStartedAt: number | null;
    readonly backgroundTaskCount: number;
}

export interface IdleWorkspace {
    readonly id: string;
    readonly panes: readonly IdlePane[];
    readonly parkedPanes: readonly IdlePane[];
}

/**
 * When a pane last did anything, or null while it is busy. Busy is a live turn only: an agent
 * whose background task is the dev server keeps its pane `running` for as long as the server
 * runs, and `waitingForInput` is a turn that ended and nobody looked at, which is the point.
 */
function quietSince(pane: IdlePane): number | null {
    if (pane.status === 'running' && pane.backgroundTaskCount === 0) return null;
    return Math.max(pane.lastActivityAt * 1000, pane.agentStartedAt ?? 0);
}

/**
 * D7: how many whole days a workspace's service has sat idle, or null when it is not idle. It is
 * when it has been up `IDLE_DAYS` and either its folder is gone, or the pane that started it has
 * been quiet that long; a service with no pane (a compose project, a server whose pane closed)
 * goes by its workspace's most recent pane activity. Leftovers have their own card.
 */
export function idleDays(service: RunningServiceEntry, workspaces: readonly IdleWorkspace[], now: number): number | null {
    if (service.category !== 'workspace' || service.started_at === null) return null;
    const up = now - Date.parse(service.started_at);
    if (!Number.isFinite(up) || up < IDLE_DAYS * DAY_MS) return null;
    if (service.directory_missing) return Math.floor(up / DAY_MS);
    const panesOf = (workspace: IdleWorkspace): readonly IdlePane[] => [...workspace.panes, ...workspace.parkedPanes];
    const wantedPane = service.pane_id?.toUpperCase();
    const pane = wantedPane === undefined ? undefined : workspaces.flatMap(panesOf).find((candidate) => candidate.id.toUpperCase() === wantedPane);
    const owner = workspaces.find((workspace) => workspace.id.toUpperCase() === service.workspace_id?.toUpperCase());
    const watched = pane !== undefined ? [pane] : owner === undefined ? [] : panesOf(owner);
    if (watched.length === 0) return null;
    const quiet = watched.map(quietSince);
    if (quiet.some((since) => since === null)) return null;
    const latest = Math.max(...(quiet as number[]));
    const idle = Math.min(up, now - latest);
    return idle < IDLE_DAYS * DAY_MS ? null : Math.floor(idle / DAY_MS);
}

/** Each workspace's longest idle service, in days, keyed by uppercase workspace id. */
export function idleByWorkspace(services: readonly RunningServiceEntry[], workspaces: readonly IdleWorkspace[], now: number): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const service of services) {
        const days = idleDays(service, workspaces, now);
        const key = service.workspace_id?.toUpperCase();
        if (days === null || key === undefined) continue;
        out.set(key, Math.max(days, out.get(key) ?? 0));
    }
    return out;
}

/** A pane's foreground job stops with Ctrl-C in that pane, which needs no confirmation (§6). */
export function stopsWithCtrlC(service: RunningServiceEntry): boolean {
    return service.foreground && service.pane_id !== null && service.started_by === 'pane';
}

/** What a Stop control says: `Stop (Ctrl-C)` for a foreground job. */
export function stopLabel(service: RunningServiceEntry): string {
    return stopsWithCtrlC(service) ? 'Stop (Ctrl-C)' : 'Stop';
}

/** One stop's outcome as the surfaces show it. */
export interface StopOutcomeSummary {
    /** Every service exited (or was never waited for). */
    readonly done: boolean;
    /** Processes or containers still running when the wait ended. */
    readonly remaining: number;
    /** Why one was refused, or what failed. */
    readonly errors: readonly string[];
    /** A supervisor started one again on its port. */
    readonly restartedBy: string | null;
}

/** The `running-stop` reply's results, folded for a row or a dialog. */
export function summarizeStop(results: readonly RunningStopResult[]): StopOutcomeSummary {
    const errors = results.flatMap((result) => [
        ...(result.error === undefined ? [] : [result.error]),
        ...result.failed
    ]);
    const remaining = results.reduce((sum, result) => sum + (result.remaining?.length ?? 0), 0);
    return {
        done: errors.length === 0 && remaining === 0,
        remaining,
        errors,
        restartedBy: results.find((result) => result.restarted_by !== null)?.restarted_by ?? null
    };
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

// ── leftovers (the popover and the corner card) ──────────────────────────────────────

export interface LeftoverGroup {
    readonly key: string;
    readonly folder: string | null;
    readonly deleted: boolean;
    readonly services: readonly RunningServiceEntry[];
    /** The oldest stack's start, for the group's age. */
    readonly startedAt: string | null;
}

/** Leftovers by the worktree they ran in, in the scan's order. */
export function leftoverGroups(services: readonly RunningServiceEntry[]): LeftoverGroup[] {
    const groups = new Map<string, RunningServiceEntry[]>();
    for (const service of services) {
        const key = service.worktree ?? service.directory ?? service.id;
        groups.set(key, [...(groups.get(key) ?? []), service]);
    }
    return [...groups.entries()].map(([key, members]) => {
        const starts = members
            .map((service) => service.started_at)
            .filter((at): at is string => at !== null)
            .sort();
        return {
            key,
            folder: members[0]?.worktree ?? members[0]?.directory ?? null,
            deleted: members.some((service) => service.directory_missing),
            services: members,
            startedAt: starts[0] ?? null
        };
    });
}

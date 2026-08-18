/**
 * The shell's agent-count model — pure, no Electron, no sockets (M4).
 *
 * The main process keeps its OWN mirror of the daemon's agent state (`./status.ts` feeds it
 * a `snapshot` and then `delta` events) because everything native the shell owns is derived
 * from two numbers: how many panes are running an agent and how many are waiting for input.
 * That drives the dock badge, the dock bounce, the tray icon + menu, and the quit dialog.
 *
 * Rules taken verbatim from docs/current/agent-lifecycle.md §8:
 *   - **§8.1 aggregation** walks all workspaces × VISIBLE panes. Parked panes are excluded
 *     here (they ARE counted by the quit/delete gates — a different rule, §10.3).
 *   - **§8.2 waiting-wins precedence**: the indicator shows waiting whenever waiting > 0,
 *     regardless of how many panes are running.
 *   - **§8.4 dock badge** is the WAITING count only; `running` never badges.
 *
 * The mirror is deliberately minimal: pane id → status per workspace, plus the workspace's
 * display name. It is rebuilt wholesale from each snapshot, so a reconnect can never leave a
 * stale count behind, and delta application is total (an unknown event kind is ignored, which
 * is what forward compatibility with an additive protocol means).
 */

import type { JsonObject, JsonValue, WsDeltaEvent } from '@nex/protocol';

/** The two non-idle pane statuses. `idle` panes are simply absent from the mirror. */
export type AgentPaneStatus = 'running' | 'waitingForInput';

export interface AgentPane {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly workspaceName: string;
    /** `pane.title ?? label ?? "Shell"` (§8.1). */
    readonly title: string;
    readonly status: AgentPaneStatus;
}

export interface WorkspaceAgents {
    readonly workspaceID: string;
    readonly name: string;
    readonly running: number;
    readonly waiting: number;
}

export interface AgentCounts {
    readonly running: number;
    readonly waiting: number;
    /** Only workspaces with at least one non-idle pane, sorted by name (§8.3). */
    readonly workspaces: readonly WorkspaceAgents[];
    /** Every non-idle pane, sorted by workspace name then title. */
    readonly panes: readonly AgentPane[];
    /** Pane ids currently waiting — the bounce edge is computed against this set. */
    readonly waitingPaneIDs: readonly string[];
}

export const EMPTY_COUNTS: AgentCounts = {
    running: 0,
    waiting: 0,
    workspaces: [],
    panes: [],
    waitingPaneIDs: []
};

// ── defensive JSON readers ──────────────────────────────────────────────────────────

function isRecord(value: JsonValue | undefined): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: JsonObject, key: string): string | undefined {
    const value = source[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readArray(source: JsonObject, key: string): readonly JsonValue[] {
    const value = source[key];
    return Array.isArray(value) ? value : [];
}

function readStatus(source: JsonObject): AgentPaneStatus | undefined {
    const value = source['status'];
    return value === 'running' || value === 'waitingForInput' ? value : undefined;
}

/** §8.1: `paneTitle: pane.title ?? "Shell"`; the label is a friendlier middle step. */
export function paneDisplayTitle(pane: JsonObject): string {
    return readString(pane, 'title') ?? readString(pane, 'label') ?? 'Shell';
}

// ── the mirror ──────────────────────────────────────────────────────────────────────

interface MirrorPane {
    title: string;
    status: AgentPaneStatus;
}

interface MirrorWorkspace {
    name: string;
    /** Visible, non-idle panes only. */
    readonly panes: Map<string, MirrorPane>;
}

/**
 * A tiny replica of the daemon's agent state.
 *
 * Not a general state mirror: it stores what the native chrome needs and nothing else, so a
 * pane going idle is a delete rather than a status write. `counts()` is the only reader.
 */
export class AgentModel {
    private readonly workspaces = new Map<string, MirrorWorkspace>();

    /** Drop everything (a disconnect must not leave a stale badge behind). */
    reset(): void {
        this.workspaces.clear();
    }

    /** Rebuild from a `snapshot` message's `state` object. */
    applySnapshot(state: JsonObject): void {
        this.workspaces.clear();
        for (const entry of readArray(state, 'workspaces')) {
            if (!isRecord(entry)) continue;
            const id = readString(entry, 'id');
            if (id === undefined) continue;
            const workspace: MirrorWorkspace = {
                name: readString(entry, 'name') ?? id,
                panes: new Map()
            };
            // Visible panes only — `parkedPanes` is deliberately not walked (§8.1).
            for (const paneValue of readArray(entry, 'panes')) {
                if (!isRecord(paneValue)) continue;
                const paneID = readString(paneValue, 'id');
                const status = readStatus(paneValue);
                if (paneID === undefined || status === undefined) continue;
                workspace.panes.set(paneID, { title: paneDisplayTitle(paneValue), status });
            }
            this.workspaces.set(id, workspace);
        }
    }

    applyDeltas(events: readonly WsDeltaEvent[]): void {
        for (const event of events) this.applyDelta(event);
    }

    applyDelta(event: WsDeltaEvent): void {
        switch (event.kind) {
            case 'workspace-upserted': {
                // The envelope carries no panes: keep whatever panes we already track and
                // only refresh the display name.
                const existing = this.workspaces.get(event.id);
                const name = readString(event.workspace, 'name') ?? event.id;
                if (existing === undefined) this.workspaces.set(event.id, { name, panes: new Map() });
                else existing.name = name;
                break;
            }
            case 'workspace-removed':
                this.workspaces.delete(event.id);
                break;
            case 'pane-upserted': {
                const workspace = this.ensureWorkspace(event.workspaceID);
                if (event.lane === 'parked') {
                    // Parking a pane takes it out of the §8.1 aggregation.
                    workspace.panes.delete(event.paneID);
                    break;
                }
                const status = readStatus(event.pane);
                if (status === undefined) workspace.panes.delete(event.paneID);
                else workspace.panes.set(event.paneID, { title: paneDisplayTitle(event.pane), status });
                break;
            }
            case 'pane-removed':
                this.workspaces.get(event.workspaceID)?.panes.delete(event.paneID);
                break;
            case 'agent-status-changed': {
                const workspace = this.ensureWorkspace(event.workspaceID);
                if (event.status === 'idle') {
                    workspace.panes.delete(event.paneID);
                    break;
                }
                const existing = workspace.panes.get(event.paneID);
                workspace.panes.set(event.paneID, {
                    title: existing?.title ?? 'Shell',
                    status: event.status
                });
                break;
            }
            default:
                // Layout, focus, sync, order, presets, repos: nothing the dock or tray shows.
                break;
        }
    }

    counts(): AgentCounts {
        const workspaces: WorkspaceAgents[] = [];
        const panes: AgentPane[] = [];
        let running = 0;
        let waiting = 0;

        for (const [workspaceID, workspace] of this.workspaces) {
            let workspaceRunning = 0;
            let workspaceWaiting = 0;
            for (const [paneID, pane] of workspace.panes) {
                if (pane.status === 'running') workspaceRunning += 1;
                else workspaceWaiting += 1;
                panes.push({
                    paneID,
                    workspaceID,
                    workspaceName: workspace.name,
                    title: pane.title,
                    status: pane.status
                });
            }
            running += workspaceRunning;
            waiting += workspaceWaiting;
            if (workspaceRunning + workspaceWaiting > 0) {
                workspaces.push({
                    workspaceID,
                    name: workspace.name,
                    running: workspaceRunning,
                    waiting: workspaceWaiting
                });
            }
        }

        const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
        workspaces.sort(byName);
        panes.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName) || a.title.localeCompare(b.title));

        return {
            running,
            waiting,
            workspaces,
            panes,
            waitingPaneIDs: panes.filter((pane) => pane.status === 'waitingForInput').map((pane) => pane.paneID)
        };
    }

    private ensureWorkspace(id: string): MirrorWorkspace {
        const existing = this.workspaces.get(id);
        if (existing !== undefined) return existing;
        const created: MirrorWorkspace = { name: id, panes: new Map() };
        this.workspaces.set(id, created);
        return created;
    }
}

// ── derivations the native chrome consumes ──────────────────────────────────────────

/** §8.4: the badge is the waiting count, or nothing. Electron clears on `''`. */
export function dockBadgeLabel(counts: AgentCounts): string {
    return counts.waiting > 0 ? String(counts.waiting) : '';
}

export type TrayIndicator = 'idle' | 'running' | 'waiting' | 'disconnected';

/** §8.2 waiting-wins precedence. A dead daemon outranks both (nothing is knowable). */
export function trayIndicator(counts: AgentCounts, connected: boolean): TrayIndicator {
    if (!connected) return 'disconnected';
    if (counts.waiting > 0) return 'waiting';
    if (counts.running > 0) return 'running';
    return 'idle';
}

function plural(count: number, noun: string): string {
    return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** One line per workspace with non-idle panes; the tray's §8.3 popover, flattened. */
export function traySummaryLines(counts: AgentCounts, connected = true): readonly string[] {
    if (!connected) return ['Daemon not reachable'];
    if (counts.workspaces.length === 0) return ['All clear'];
    return counts.workspaces.map((workspace) => {
        const parts: string[] = [];
        if (workspace.waiting > 0) parts.push(`${String(workspace.waiting)} waiting`);
        if (workspace.running > 0) parts.push(`${String(workspace.running)} running`);
        return `${workspace.name} — ${parts.join(', ')}`;
    });
}

export function trayTooltip(counts: AgentCounts, connected: boolean): string {
    if (!connected) return 'Nex — daemon not reachable';
    if (counts.waiting === 0 && counts.running === 0) return 'Nex — all clear';
    const parts: string[] = [];
    if (counts.waiting > 0) parts.push(`${String(counts.waiting)} waiting`);
    if (counts.running > 0) parts.push(`${String(counts.running)} running`);
    return `Nex — ${parts.join(', ')}`;
}

/**
 * The bounce edge (§7.1 `shouldBounce`): panes that are waiting NOW and were not waiting
 * before. The window-focus half of the rule lives in `./status.ts`; the daemon has already
 * applied the background-work suppression before it emits the status change.
 */
export function newlyWaitingPanes(
    previous: Iterable<string>,
    next: Iterable<string>
): readonly string[] {
    const before = new Set(previous);
    return [...next].filter((paneID) => !before.has(paneID));
}

export interface ActivitySummary {
    readonly agents: number;
    readonly workspaces: number;
}

export function activitySummary(counts: AgentCounts): ActivitySummary {
    return { agents: counts.running + counts.waiting, workspaces: counts.workspaces.length };
}

/**
 * The quit dialog's body.
 *
 * NOT the Swift text: in this architecture quitting the shell does not touch the daemon, so
 * the warning that "quitting will terminate all sessions" would be a lie (ARCHITECTURE.md —
 * the daemon owns the sessions and outlives every client). The dialog exists to say the
 * opposite, so a user who quits by reflex knows their agents survived.
 */
export function quitConfirmDetail(counts: AgentCounts): string {
    const summary = activitySummary(counts);
    if (summary.agents === 0) return 'Your sessions keep running in the background.';
    return (
        `${plural(summary.agents, 'agent')} across ${plural(summary.workspaces, 'workspace')} ` +
        'are still active. They keep running in the background — quitting only closes this ' +
        'window. Reopen Nex to attach again.'
    );
}

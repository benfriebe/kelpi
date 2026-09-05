/**
 * The shell's agent-count model — pure, no Electron, no sockets (M4).
 *
 * The main process keeps its OWN mirror of the daemon's agent state (`./status.ts` feeds it
 * a `snapshot` and then `delta` events) because everything native the shell owns is derived
 * from two numbers: how many panes are running an agent and how many are waiting for input.
 * That drives the dock badge, the dock bounce, the tray icon + menu, and the quit dialog.
 *
 * Rules taken verbatim from docs/agent-lifecycle.md §8:
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

import type { JsonObject, JsonValue, WsDeltaEvent } from '@kelpi/protocol';

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
    /**
     * §AGNT-113: non-idle **parked** panes, counted separately.
     *
     * §8.1's aggregation (badge, tray, icon) deliberately excludes parked panes — they have no
     * visible pane to jump to. §10.3's gates deliberately INCLUDE them, because their PTYs are
     * still alive and quitting is a decision about processes, not about what is on screen. Two
     * rules, so two numbers: `running`/`waiting` stay §8.1's, and the quit dialog adds this.
     */
    readonly parked: number;
    /** Workspaces whose ONLY non-idle panes are parked (they widen §10.3's workspace count). */
    readonly parkedOnlyWorkspaces: number;
}

export const EMPTY_COUNTS: AgentCounts = {
    running: 0,
    waiting: 0,
    workspaces: [],
    panes: [],
    waitingPaneIDs: [],
    parked: 0,
    parkedOnlyWorkspaces: 0
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
    /**
     * Non-idle PARKED panes (§AGNT-113). Kept apart from `panes` because the two feed different
     * rules: §8.1's badge/tray reads `panes`, §10.3's quit gate reads both.
     */
    readonly parked: Map<string, MirrorPane>;
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
                panes: new Map(),
                parked: new Map()
            };
            // §8.1's aggregation is VISIBLE panes; parked ones go in their own map so the
            // §10.3 quit gate can see them without the badge or the tray ever counting them.
            for (const paneValue of readArray(entry, 'panes')) {
                if (!isRecord(paneValue)) continue;
                const paneID = readString(paneValue, 'id');
                const status = readStatus(paneValue);
                if (paneID === undefined || status === undefined) continue;
                workspace.panes.set(paneID, { title: paneDisplayTitle(paneValue), status });
            }
            for (const paneValue of readArray(entry, 'parkedPanes')) {
                if (!isRecord(paneValue)) continue;
                const paneID = readString(paneValue, 'id');
                const status = readStatus(paneValue);
                if (paneID === undefined || status === undefined) continue;
                workspace.parked.set(paneID, { title: paneDisplayTitle(paneValue), status });
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
                if (existing === undefined)
                    this.workspaces.set(event.id, { name, panes: new Map(), parked: new Map() });
                else existing.name = name;
                break;
            }
            case 'workspace-removed':
                this.workspaces.delete(event.id);
                break;
            case 'pane-upserted': {
                const workspace = this.ensureWorkspace(event.workspaceID);
                const status = readStatus(event.pane);
                if (event.lane === 'parked') {
                    // Parking takes a pane out of the §8.1 aggregation and into §10.3's.
                    workspace.panes.delete(event.paneID);
                    if (status === undefined) workspace.parked.delete(event.paneID);
                    else
                        workspace.parked.set(event.paneID, {
                            title: paneDisplayTitle(event.pane),
                            status
                        });
                    break;
                }
                // Unparking is the same event on the other lane: drop the parked copy first, or
                // one restored pane would be counted twice by the quit gate.
                workspace.parked.delete(event.paneID);
                if (status === undefined) workspace.panes.delete(event.paneID);
                else workspace.panes.set(event.paneID, { title: paneDisplayTitle(event.pane), status });
                break;
            }
            case 'pane-removed': {
                const workspace = this.workspaces.get(event.workspaceID);
                workspace?.panes.delete(event.paneID);
                workspace?.parked.delete(event.paneID);
                break;
            }
            case 'agent-status-changed': {
                const workspace = this.ensureWorkspace(event.workspaceID);
                // A parked pane's agent can still change status (its PTY is alive), so the
                // event has to land on whichever lane already knows the pane.
                const lane = workspace.parked.has(event.paneID) ? workspace.parked : workspace.panes;
                if (event.status === 'idle') {
                    lane.delete(event.paneID);
                    break;
                }
                const existing = lane.get(event.paneID);
                lane.set(event.paneID, {
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
        let parked = 0;
        let parkedOnlyWorkspaces = 0;

        for (const [workspaceID, workspace] of this.workspaces) {
            parked += workspace.parked.size;
            // A workspace whose only live agents are parked is invisible to §8.1 but must still
            // count towards §10.3's "across M workspaces".
            if (workspace.parked.size > 0 && workspace.panes.size === 0) parkedOnlyWorkspaces += 1;
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
            waitingPaneIDs: panes.filter((pane) => pane.status === 'waitingForInput').map((pane) => pane.paneID),
            parked,
            parkedOnlyWorkspaces
        };
    }

    private ensureWorkspace(id: string): MirrorWorkspace {
        const existing = this.workspaces.get(id);
        if (existing !== undefined) return existing;
        const created: MirrorWorkspace = { name: id, panes: new Map(), parked: new Map() };
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
        return `${workspace.name} - ${parts.join(', ')}`;
    });
}

/**
 * §AGNT-090/091/092/093: the popover's rows, as a native-menu template.
 *
 * The Swift menu-bar extra opened a custom `NSPopover` listing every running/waiting pane,
 * grouped by workspace, each row clickable to jump straight to that pane. The port's tray is an
 * Electron `Tray` with a native menu (§AGNT-086's supersession), which changes the *drawing* but
 * not the information: one header row per workspace, one clickable row per non-idle pane, and a
 * status marker on each.
 *
 * Where the two genuinely differ, and why:
 *
 *   - **The dot is a glyph, not a circle.** A native menu item is text plus an optional image;
 *     there is no per-row swatch and no animation, so §AGNT-091's *pulsing* waiting halo becomes
 *     `◉` against running's `●`. The distinction survives; the animation cannot.
 *   - **The workspace colour dot is dropped** (§AGNT-090). The same constraint: a native menu
 *     cannot tint one glyph per row, and a coloured emoji circle would read as a status, which
 *     is exactly the thing the marker column already means.
 *   - **Counts move onto the workspace row.** The Swift header was name-only because the panes
 *     underneath were visibly countable at a glance in a 280 pt popover; a menu that a user
 *     opens deliberately is better off saying "2 waiting, 1 running" on the header itself, which
 *     is also what the port's flattened one-line-per-workspace summary already said.
 *
 * Pure and exported so the whole template is asserted in a test — a tray menu cannot be
 * screenshotted from outside the process, so this function IS the evidence (`agents.test.ts`),
 * with `status.ts` logging the row count it built as the runtime half.
 */
export type TrayMenuRow =
    /** A disabled placeholder: "All clear" / "Daemon not reachable". */
    | { readonly kind: 'message'; readonly label: string }
    /** A disabled workspace header: marker + name + counts. */
    | { readonly kind: 'workspace'; readonly label: string; readonly workspaceID: string }
    /** A clickable pane row: reveal this pane in this workspace. */
    | {
          readonly kind: 'pane';
          readonly label: string;
          readonly paneID: string;
          readonly workspaceID: string;
          readonly status: AgentPaneStatus;
      };

/** §AGNT-091's dot, in the only alphabet a native menu item has. */
export const WAITING_GLYPH = '◉';
export const RUNNING_GLYPH = '●';
/** §AGNT-092's checkmark, for the same reason: a native menu's own checkmark slot means "on". */
export const ALL_CLEAR_GLYPH = '✓';

/** Widest a pane row gets before its middle is elided (§AGNT-090's `.truncationMode(.middle)`). */
export const TRAY_PANE_TITLE_MAX = 40;

export function middleTruncate(value: string, max = TRAY_PANE_TITLE_MAX): string {
    if (max <= 1 || value.length <= max) return value;
    // The head keeps the command, the tail keeps the argument — the two halves a pane title is
    // usually made of, and the reason the Swift row truncates in the middle rather than the end.
    const head = Math.ceil((max - 1) / 2);
    const tail = max - 1 - head;
    return `${value.slice(0, head)}…${tail === 0 ? '' : value.slice(value.length - tail)}`;
}

export function trayMenuRows(counts: AgentCounts, connected = true): readonly TrayMenuRow[] {
    if (!connected) return [{ kind: 'message', label: 'Daemon not reachable' }];
    if (counts.workspaces.length === 0) {
        return [{ kind: 'message', label: `${ALL_CLEAR_GLYPH}  All clear` }];
    }

    const rows: TrayMenuRow[] = [];
    for (const workspace of counts.workspaces) {
        const parts: string[] = [];
        if (workspace.waiting > 0) parts.push(`${String(workspace.waiting)} waiting`);
        if (workspace.running > 0) parts.push(`${String(workspace.running)} running`);
        // §8.2 waiting-wins, applied per workspace so the header marker agrees with the icon.
        const marker = workspace.waiting > 0 ? WAITING_GLYPH : RUNNING_GLYPH;
        rows.push({
            kind: 'workspace',
            workspaceID: workspace.workspaceID,
            label: `${marker} ${workspace.name} - ${parts.join(', ')}`
        });
        for (const pane of counts.panes) {
            if (pane.workspaceID !== workspace.workspaceID) continue;
            const glyph = pane.status === 'waitingForInput' ? WAITING_GLYPH : RUNNING_GLYPH;
            rows.push({
                kind: 'pane',
                paneID: pane.paneID,
                workspaceID: pane.workspaceID,
                status: pane.status,
                // Two leading spaces are the indent a native menu gives us; `panes` is already
                // sorted by workspace name then title, so this walk preserves that order.
                label: `    ${glyph}  ${middleTruncate(pane.title)}`
            });
        }
    }
    return rows;
}

export function trayTooltip(counts: AgentCounts, connected: boolean): string {
    if (!connected) return 'Kelpi - daemon not reachable';
    if (counts.waiting === 0 && counts.running === 0) return 'Kelpi - all clear';
    const parts: string[] = [];
    if (counts.waiting > 0) parts.push(`${String(counts.waiting)} waiting`);
    if (counts.running > 0) parts.push(`${String(counts.running)} running`);
    return `Kelpi - ${parts.join(', ')}`;
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

/**
 * §AGNT-077's other direction: panes that STOPPED waiting.
 *
 * `NotificationService.removeNotification(for:)` withdraws a pane's delivered notification when
 * its waiting status is cleared — which is what visiting the pane does. The client half of that
 * already works (the in-app toast is dismissed on focus); the native toast had nothing to act
 * on, because the daemon publishes a notification but never a retraction. It does not need one:
 * a pane leaving the waiting set IS the retraction, and the shell already tracks that set for
 * the dock bounce.
 */
export function noLongerWaitingPanes(
    previous: Iterable<string>,
    next: Iterable<string>
): readonly string[] {
    const after = new Set(next);
    return [...previous].filter((paneID) => !after.has(paneID));
}

export interface ActivitySummary {
    readonly agents: number;
    readonly workspaces: number;
}

/**
 * §AGNT-113's `activeAgentSummary`: an "active agent" is any pane whose status is not idle,
 * **parked panes included** — their PTYs are alive, and quitting is a decision about processes.
 *
 * This is deliberately a different rule from `dockBadgeLabel` / `trayIndicator`, which follow
 * §8.1 and count visible panes only. The quit dialog is the one surface that must not
 * under-report: a number lower than the daemon's own `activeAgentCount` (which is what
 * `workspace-delete` refuses on) would tell the user there is less running than there is.
 */
export function activitySummary(counts: AgentCounts): ActivitySummary {
    return {
        agents: counts.running + counts.waiting + counts.parked,
        workspaces: counts.workspaces.length + counts.parkedOnlyWorkspaces
    };
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
        'are still active. They keep running in the background - quitting only closes this ' +
        'window. Reopen Kelpi to attach again.'
    );
}

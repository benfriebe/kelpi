/**
 * What needs the person, across every host (the handoff's attention model).
 *
 * The phone's Home leads with it, the Needs-you sheet lists it, and the pill above the location bar
 * counts it, so all three read this one derivation over `fleet.ts`'s reading of every host:
 *
 *   - a pane is WAITING when its status is `waitingForInput` and its workspace is not muted. A muted
 *     workspace raises no attention signal anywhere (agent-lifecycle §7.6), which is the rule the
 *     desktop's footer count already follows (`chromeStatusSummary`);
 *   - a pane is RUNNING when its status is `running`, muted or not, because Running is a list the
 *     person opens, not a signal that asks for them;
 *   - a host that is not connected counts nothing: its mirror is the last thing it said.
 *
 * There is no "unread": a waiting pane stops being listed when it stops waiting, which is the only
 * dismissal a daemon knows about.
 *
 * How long a pane has waited is not daemon state either. The phone notes the moment it first SAW a
 * pane waiting and keeps that for the page's life, so "4m" means "at least four minutes, by this
 * phone's clock". A pane that was already waiting when the page loaded counts from the load.
 */

import { useSyncExternalStore } from 'react';

import type { WorkspaceState } from '@kelpi/daemon/store';

import type { PaneModel } from '../grid';
import type { PhoneHostReading } from './fleet';
import { phonePaneTitle } from './parts';

export interface PhoneAttentionItem {
    readonly key: string;
    readonly hostKey: string;
    readonly hostName: string;
    readonly workspaceID: string;
    readonly workspaceName: string;
    readonly paneID: string;
    readonly paneTitle: string;
    /** `claude`, `codex`, or null for a pane that is not an agent. */
    readonly agentKind: string | null;
    readonly workingDirectory: string | null;
    readonly backgroundTaskCount: number;
}

export interface PhoneAttention {
    readonly waiting: readonly PhoneAttentionItem[];
    readonly running: readonly PhoneAttentionItem[];
    /** Waiting count per host key; a host with none is absent. */
    readonly waitingByHost: ReadonlyMap<string, number>;
    /** Waiting count per `hostKey/workspaceID`. */
    readonly waitingByWorkspace: ReadonlyMap<string, number>;
}

export function workspaceKey(hostKey: string, workspaceID: string): string {
    return `${hostKey}/${workspaceID}`;
}

function item(reading: PhoneHostReading, workspace: WorkspaceState, pane: PaneModel, homeDirectory: string): PhoneAttentionItem {
    return {
        key: `${reading.host.key}/${pane.id}`,
        hostKey: reading.host.key,
        hostName: reading.host.name,
        workspaceID: workspace.id,
        workspaceName: workspace.name,
        paneID: pane.id,
        paneTitle: phonePaneTitle(pane, homeDirectory),
        agentKind: pane.agentKind,
        workingDirectory: pane.workingDirectory,
        backgroundTaskCount: pane.backgroundTaskCount
    };
}

/** The attention model over every host, in host order then sidebar order. */
export function phoneAttention(fleet: readonly PhoneHostReading[]): PhoneAttention {
    const waiting: PhoneAttentionItem[] = [];
    const running: PhoneAttentionItem[] = [];
    const waitingByHost = new Map<string, number>();
    const waitingByWorkspace = new Map<string, number>();
    for (const reading of fleet) {
        // A host the phone cannot reach shows what its mirror held when the link dropped, which is
        // not what is waiting now: nothing there is counted until it answers again.
        if (reading.connection !== 'connected') continue;
        const homeDirectory = reading.host.runtime.store.getState().daemon.state.homeDirectory;
        for (const workspace of reading.workspaces) {
            for (const pane of workspace.panes) {
                if (pane.status === 'waitingForInput' && !workspace.muted) {
                    waiting.push(item(reading, workspace, pane, homeDirectory));
                    waitingByHost.set(reading.host.key, (waitingByHost.get(reading.host.key) ?? 0) + 1);
                    const key = workspaceKey(reading.host.key, workspace.id);
                    waitingByWorkspace.set(key, (waitingByWorkspace.get(key) ?? 0) + 1);
                } else if (pane.status === 'running') {
                    running.push(item(reading, workspace, pane, homeDirectory));
                }
            }
        }
    }
    return { waiting, running, waitingByHost, waitingByWorkspace };
}

/**
 * When this page first saw each waiting pane, by item key. Module state on purpose: it is a fact
 * about this page's life, shared by every surface that shows a wait, and it has no owner to live in.
 */
const firstSeenWaiting = new Map<string, number>();

/** Note the waiting set as it stands now, forgetting panes that stopped waiting. */
export function noteWaiting(items: readonly PhoneAttentionItem[], now: number): void {
    const live = new Set(items.map((entry) => entry.key));
    for (const key of firstSeenWaiting.keys()) if (!live.has(key)) firstSeenWaiting.delete(key);
    for (const key of live) if (!firstSeenWaiting.has(key)) firstSeenWaiting.set(key, now);
}

/** "now", "4m", "2h", "3d": how long this page has seen the item waiting. */
export function waitedFor(key: string, now: number): string {
    const since = firstSeenWaiting.get(key);
    if (since === undefined) return 'now';
    const minutes = Math.floor((now - since) / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${String(minutes)}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${String(hours)}h`;
    return `${String(Math.floor(hours / 24))}d`;
}

/*
 * ── the clock the waits are read against ────────────────────────────────────────────
 *
 * One ticker for every label that says how long something has waited, running only while one is
 * on screen and the page is visible. It lives down here rather than in the shell so that a minute
 * passing re-renders those labels and nothing else: the shell holds the pane on screen, and a
 * clock up there would redraw a terminal's tree twice a minute to change "4m" to "5m".
 */

const WAIT_CLOCK_MS = 30_000;
const clockListeners = new Set<() => void>();
let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function documentHidden(): boolean {
    const doc = (globalThis as { document?: { hidden?: boolean } }).document;
    return doc?.hidden === true;
}

function tick(): void {
    clockNow = Date.now();
    for (const listener of clockListeners) listener();
}

function syncClock(): void {
    const run = clockListeners.size > 0 && !documentHidden();
    if (run && clockTimer === null) {
        tick();
        clockTimer = setInterval(tick, WAIT_CLOCK_MS);
    } else if (!run && clockTimer !== null) {
        clearInterval(clockTimer);
        clockTimer = null;
    }
}

function onVisibility(): void {
    syncClock();
}

function subscribeClock(listener: () => void): () => void {
    clockListeners.add(listener);
    if (clockListeners.size === 1) (globalThis as { document?: Document }).document?.addEventListener('visibilitychange', onVisibility);
    syncClock();
    return () => {
        clockListeners.delete(listener);
        if (clockListeners.size === 0) (globalThis as { document?: Document }).document?.removeEventListener('visibilitychange', onVisibility);
        syncClock();
    };
}

/** Now, as of the last tick: moves every thirty seconds while anything is reading it. */
export function useWaitClock(): number {
    return useSyncExternalStore(subscribeClock, () => clockNow, () => clockNow);
}

/** Test seam: forget every wait. */
export function resetWaitingClock(): void {
    firstSeenWaiting.clear();
}

/**
 * Reporting where a web pane's page area is, without flooding the socket.
 *
 * A web pane's pixels come from a native browser view the Electron shell owns, and the client is
 * the only party that knows where that view has to go: it drew the chrome around the hole. So
 * every render measures the hole and reports it (`web-geometry-report` →
 * `daemon/src/webpane/HOST_PROTOCOL.md` §3.5).
 *
 * "Every render" is the problem this module solves. A divider drag produces a report per frame,
 * a window resize likewise, and each one crosses a socket and moves a real OS-level view. The
 * policy, in the order the rules apply:
 *
 *   1. **Identical reports are dropped.** The grid re-renders every pane on any layout change,
 *      so most measurements say exactly what the last one said.
 *   2. **Hiding is immediate.** A pane that went away must return its view to the holder *now*
 *      — a trailing-edge delay would leave a live page painted over the workspace the user just
 *      switched to. Same for the first report of a pane (leading edge): the view should appear
 *      as the pane does.
 *   3. **Movement is throttled with a trailing edge.** Intermediate frames of a drag are worth
 *      dropping; the final position never is, so the last value always gets sent.
 *
 * The scheduler is injectable so tests drive it without timers, and `dispose()` exists because a
 * client that navigates away must not leave a pending send holding a socket.
 */

/** What the client measured, in CSS pixels relative to the viewport. */
export interface GeometryRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/** One pane's geometry, as the report frame carries it. */
export interface GeometryReport {
    readonly paneID: string;
    /** The pane's active tab, so a tab switch re-targets the embedded view. */
    readonly tabID?: string | null | undefined;
    readonly rect: GeometryRect;
    readonly visible: boolean;
    readonly devicePixelRatio: number;
}

export interface GeometryReporterOptions {
    /** Put one report on the wire. */
    readonly send: (report: GeometryReport) => void;
    /** Minimum gap between two *movement* reports for one pane. */
    readonly throttleMs?: number | undefined;
    readonly now?: (() => number) | undefined;
    readonly schedule?: ((callback: () => void, ms: number) => unknown) | undefined;
    readonly cancel?: ((handle: unknown) => void) | undefined;
}

export interface GeometryReporter {
    /** Measure-and-report. Cheap to call on every render: identical reports do nothing. */
    report(report: GeometryReport): void;
    /**
     * The pane is gone (unmounted, workspace switched): report `visible:false` immediately and
     * forget it, so a later re-mount reports afresh rather than being deduped away.
     */
    hide(paneID: string): void;
    /** Drop everything without sending (the socket is going away). */
    dispose(): void;
    /** Panes with a pending trailing send (tests/diagnostics). */
    readonly pending: readonly string[];
}

/** Default gap: ~6 frames — smooth enough to track a drag, cheap enough to ignore. */
export const DEFAULT_GEOMETRY_THROTTLE_MS = 100;

function sameReport(a: GeometryReport, b: GeometryReport): boolean {
    return (
        a.paneID === b.paneID &&
        (a.tabID ?? null) === (b.tabID ?? null) &&
        a.visible === b.visible &&
        a.devicePixelRatio === b.devicePixelRatio &&
        a.rect.x === b.rect.x &&
        a.rect.y === b.rect.y &&
        a.rect.w === b.rect.w &&
        a.rect.h === b.rect.h
    );
}

interface PaneEntry {
    /** The last report actually sent for this pane. */
    sent: GeometryReport | null;
    sentAt: number;
    /** Newest measurement waiting for the throttle window to close. */
    queued: GeometryReport | null;
    timer: unknown;
}

export function createGeometryReporter(options: GeometryReporterOptions): GeometryReporter {
    const throttleMs = options.throttleMs ?? DEFAULT_GEOMETRY_THROTTLE_MS;
    const now = options.now ?? ((): number => Date.now());
    const schedule =
        options.schedule ?? ((callback: () => void, ms: number): unknown => setTimeout(callback, ms));
    const cancel = options.cancel ?? ((handle: unknown): void => clearTimeout(handle as never));
    const panes = new Map<string, PaneEntry>();
    let disposed = false;

    const entryFor = (paneID: string): PaneEntry => {
        const existing = panes.get(paneID);
        if (existing !== undefined) return existing;
        const created: PaneEntry = { sent: null, sentAt: Number.NEGATIVE_INFINITY, queued: null, timer: null };
        panes.set(paneID, created);
        return created;
    };

    const clearTimer = (entry: PaneEntry): void => {
        if (entry.timer === null) return;
        cancel(entry.timer);
        entry.timer = null;
    };

    const deliver = (entry: PaneEntry, report: GeometryReport): void => {
        entry.sent = report;
        entry.sentAt = now();
        entry.queued = null;
        clearTimer(entry);
        options.send(report);
    };

    return {
        report(report) {
            if (disposed) return;
            const entry = entryFor(report.paneID);
            // Rule 1: the grid re-renders every pane on any change; most reports are echoes.
            if (entry.sent !== null && sameReport(entry.sent, report)) {
                entry.queued = null;
                clearTimer(entry);
                return;
            }
            // Rule 2: appearing and disappearing are not "movement" — they are the events the
            // whole mechanism exists to deliver, and a delayed one is visible as a stale page.
            const immediate =
                entry.sent === null || !report.visible || !entry.sent.visible || now() - entry.sentAt >= throttleMs;
            if (immediate) {
                deliver(entry, report);
                return;
            }
            // Rule 3: keep only the newest position; the trailing send is what lands.
            entry.queued = report;
            if (entry.timer !== null) return;
            const wait = Math.max(0, throttleMs - (now() - entry.sentAt));
            entry.timer = schedule(() => {
                entry.timer = null;
                const queued = entry.queued;
                if (queued === null || disposed) return;
                deliver(entry, queued);
            }, wait);
        },

        hide(paneID) {
            if (disposed) return;
            const entry = panes.get(paneID);
            if (entry === undefined) return;
            clearTimer(entry);
            panes.delete(paneID);
            // Nothing was ever placed, so there is nothing to take back.
            if (entry.sent === null || !entry.sent.visible) return;
            options.send({ ...entry.sent, visible: false });
        },

        dispose() {
            disposed = true;
            for (const entry of panes.values()) clearTimer(entry);
            panes.clear();
        },

        get pending() {
            return [...panes.entries()].filter(([, entry]) => entry.queued !== null).map(([paneID]) => paneID);
        }
    };
}

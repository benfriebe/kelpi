/**
 * Web-pane **geometry reports**: where a client is drawing the hole a native browser view has
 * to fill.
 *
 * The daemon cannot render a page and the host cannot lay one out — only the client knows where
 * a web pane's page area sits, because it is the thing that drew the pane's chrome around it.
 * So the client reports a rect (CSS px, viewport-relative) and the daemon forwards it to the
 * host as a `pane-geometry` notification (`./HOST_PROTOCOL.md` §3.1).
 *
 * This module is the whole daemon half: normalise the report, tag it with the reporter's
 * identity, and decide whether it came from the host's OWN window. Everything else — CSS px to
 * DIP, clamping to the window, moving the view — is the host's, because it is the only party
 * that knows the window's scale factor and content size.
 *
 * The `ownWindow` tag is the security-shaped part. Any authenticated client can report a rect;
 * a browser on a phone reporting `{x:0,y:0,w:9999,h:9999}` must not shove a desktop user's
 * views around. Matching the reporter's `shellWindowID` against the id the host declared at
 * registration (`WsClientInfo.windowID`) is what makes a report actionable, and the host
 * re-checks it against its own window id anyway (belt and braces, per the port notes).
 */

import type { JsonObject } from '@kelpi/protocol';

/** The `pane-geometry` notify verb, so the daemon and its tests spell it once. */
export const GEOMETRY_NOTIFY_VERB = 'pane-geometry';

export interface GeometryRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/** One `web-geometry-report`, as the sync session received it. */
export interface GeometryReportInput {
    readonly paneID: string;
    readonly tabID?: string | undefined;
    readonly rect: GeometryRect;
    readonly visible: boolean;
    /**
     * Issue #12: `visible:false` because something is momentarily over this pane, not because the
     * pane has left the screen. The host keeps such a view where it is (and keeps its viewport),
     * because moving it re-pins the page's layout and the page then reflows out and back.
     */
    readonly transient?: boolean | undefined;
    readonly devicePixelRatio: number;
    /** The reporting client's claim to be the page inside a shell window. */
    readonly shellWindowID?: string | undefined;
    /** The reporting connection's id (diagnostics; the host never routes on it). */
    readonly clientID?: string | undefined;
}

function finite(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Read a rect off a wire object, defaulting every missing/NaN field to 0 — a malformed report
 * degrades into "nothing to show here" rather than into a view parked at NaN.
 */
export function parseGeometryRect(value: unknown): GeometryRect {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { x: 0, y: 0, w: 0, h: 0 };
    }
    const record = value as Record<string, unknown>;
    return {
        x: finite(record['x'], 0),
        y: finite(record['y'], 0),
        w: Math.max(0, finite(record['w'], 0)),
        h: Math.max(0, finite(record['h'], 0))
    };
}

/**
 * The `pane-geometry` args. `ownWindow` is the daemon's answer to "is this the host's window?";
 * a report with no `shellWindowID`, or a host that declared no window, can never be one.
 */
export function geometryNotifyArgs(
    report: GeometryReportInput,
    hostWindowID: string | null
): JsonObject {
    const shellWindowID = report.shellWindowID ?? null;
    const rect = report.rect;
    // A zero-sized or invisible rect carries no placement; normalising it here means the host
    // only has to implement one rule ("no usable rect → put the view back in the holder").
    const visible = report.visible && rect.w > 0 && rect.h > 0;
    return {
        paneID: report.paneID,
        ...(report.tabID !== undefined && report.tabID !== '' ? { tabID: report.tabID } : {}),
        rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
        visible,
        // Only ever sent with `visible:false`: a placed view is not hidden by anything.
        ...(!visible && report.transient === true ? { transient: true } : {}),
        devicePixelRatio: finite(report.devicePixelRatio, 1),
        ownWindow: shellWindowID !== null && hostWindowID !== null && shellWindowID === hostWindowID,
        ...(shellWindowID === null ? {} : { shellWindowID }),
        ...(report.clientID === undefined ? {} : { clientID: report.clientID })
    };
}

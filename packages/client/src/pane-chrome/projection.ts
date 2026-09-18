/**
 * The pane chrome model, projected into the one frame a presenter would receive.
 *
 * Pure, and published by nothing in phase A: no presenter is mounted, so this is built, bounded
 * and unit-tested against a workspace of maximal panes, and that is all it does. Phase B adds the
 * placement's host and the `browser.js` wiring; the shape it will publish is settled here, where
 * it can be argued about without a window.
 *
 * ── One frame for the whole workspace (ratified decision 3) ──────────────────────────
 *
 * A frame per pane would have been simpler to bound and wrong in the way that matters: the header
 * row is one row, and a presenter drawing four panes has to decide what a narrow pane gives up
 * relative to its neighbours. So the frame carries every VISIBLE pane of the displayed workspace -
 * the zoom case's hidden panes are not drawn and are not in it - with the focused and zoomed pane
 * named once at the top rather than restated per pane.
 *
 * ── Bounded, with the rest counted (ratified decision 3) ─────────────────────────────
 *
 * 256 KiB, the same budget every other frame carries, measured the way `pluginJSON` measures it.
 * A workspace can hold a great many panes and a pane's title is whatever the shell last wrote to
 * its terminal's OSC, so a frame CAN burst - and an oversized frame is undeliverable, which fails
 * the placement, which latches the user's chosen presenter out over somebody else's window title.
 * So the frame is bounded instead: it carries the panes that fit, in the workspace's own order,
 * and says how many it could not carry. A withheld pane keeps its native header, exactly as a
 * withheld notice keeps its expiry clock (`docs/plugin-ui.md`'s notification box), and the count
 * is what tells the presenter its row is incomplete rather than its workspace being small.
 *
 * ── What is withheld ────────────────────────────────────────────────────────────────
 *
 * Absolute paths beyond the home abbreviation, PTY handles and pids, agent session ids, owner
 * `pluginID`s, connection URLs and page URLs, every run closure, and the `data-testid` of every
 * control. The first six never reach the descriptor at all (`model.ts` builds it from a
 * `PaneModel` and never reads them); the last is dropped HERE, because the bundled header needs
 * its audit selectors and a projection must not carry them - the same split
 * `settings/contract.ts` makes, for the same reason.
 */

import type { IconName } from '../grid/icons';

import {
    PANE_CHROME_LIMITS,
    PANE_CHROME_PLACEMENT,
    type PaneChromeAgent,
    type PaneChromeChanges,
    type PaneChromeControlKind,
    type PaneChromeDescriptor,
    type PaneChromeItemDescriptor,
    type PaneChromeKind,
    type PaneChromePlacement,
    type PaneChromeSize,
    type PaneChromeStatus,
    type PaneChromeSync,
    type PaneChromeTitleParts,
    type PaneChromeZoom
} from './contract';

/** A trailing control, as a presenter sees it: no test id, no verb, no owner. */
export interface PaneChromeFrameControl {
    readonly key: string;
    readonly kind: PaneChromeControlKind;
    readonly label: string;
    readonly icon: IconName;
    readonly enabled: boolean;
    readonly pinned: boolean;
}

/** One pane's chrome, as a presenter sees it. */
export interface PaneChromeFramePane {
    readonly paneID: string;
    readonly kind: PaneChromeKind;
    readonly status: PaneChromeStatus;
    readonly focused: boolean;
    readonly title: string;
    readonly titleParts: PaneChromeTitleParts;
    readonly directory: string;
    readonly label: string | null;
    readonly branch: string | null;
    readonly changes: PaneChromeChanges | null;
    readonly agent: PaneChromeAgent | null;
    readonly zoom: PaneChromeZoom;
    readonly sync: PaneChromeSync;
    readonly height: number;
    readonly size: PaneChromeSize;
    readonly controls: readonly PaneChromeFrameControl[];
    readonly items: readonly PaneChromeItemDescriptor[];
    /**
     * How many of another plugin's items the HOST is drawing in its own box beside the controls.
     *
     * A number rather than the box: the chips are native chrome the host renders as text and never
     * as HTML, and a presenter that replaced them would delete another plugin's extension point
     * instead of inheriting it. The descriptors are in `items` and `runPaneHeaderItem` activates
     * them; this says how many the host has already put on screen.
     */
    readonly contributions: number;
    readonly renaming: boolean;
}

export interface PaneChromeFrame {
    readonly placement: PaneChromePlacement;
    /** Desktop only in this release; a phone window keeps its own header (decision 8). */
    readonly formFactor: 'desktop' | 'phone';
    readonly workspaceID: string;
    readonly focusedPaneID: string | null;
    readonly zoomedPaneID: string | null;
    readonly panes: readonly PaneChromeFramePane[];
    /** Visible panes the budget could not carry. They keep their native header. */
    readonly withheld: number;
}

export interface PaneChromeProjectionInput {
    readonly workspaceID: string;
    readonly formFactor: 'desktop' | 'phone';
    readonly focusedPaneID?: string | null | undefined;
    readonly zoomedPaneID?: string | null | undefined;
    /** The visible panes of the displayed workspace, in the workspace's own order. */
    readonly panes: readonly PaneChromeDescriptor[];
}

const encoder = new TextEncoder();

/** Bytes of JSON, measured as `pluginJSON` measures them. */
export function paneChromeBytes(value: unknown): number {
    return encoder.encode(JSON.stringify(value)).byteLength;
}

/** The budget the pane list is actually measured against, once the envelope is paid for. */
export const PANE_CHROME_FRAME_BUDGET =
    PANE_CHROME_LIMITS.payloadBytes - PANE_CHROME_LIMITS.frameMargin;

function framePane(descriptor: PaneChromeDescriptor): PaneChromeFramePane {
    return {
        paneID: descriptor.paneID,
        kind: descriptor.kind,
        status: descriptor.status,
        focused: descriptor.focused,
        title: descriptor.title,
        titleParts: descriptor.titleParts,
        directory: descriptor.directory,
        label: descriptor.label,
        branch: descriptor.branch,
        changes: descriptor.changes,
        agent: descriptor.agent,
        zoom: descriptor.zoom,
        sync: descriptor.sync,
        height: descriptor.height,
        size: descriptor.size,
        controls: descriptor.controls.map((control) => ({
            key: control.key,
            kind: control.kind,
            label: control.label,
            icon: control.icon,
            enabled: control.enabled,
            pinned: control.pinned
        })),
        items: descriptor.items,
        contributions: descriptor.contributions?.count ?? 0,
        renaming: descriptor.renaming
    };
}

/**
 * Project a workspace's visible panes into one bounded frame.
 *
 * The accounting is deliberately per pane and in order rather than "serialise it all and cut":
 * a presenter reads the row left to right, so the panes it loses should be the ones at the end of
 * a workspace nobody can see all of anyway, and the cut has to be reproducible from the input
 * rather than from wherever `JSON.stringify` happened to run out. The envelope is measured first,
 * with an empty pane list, so a frame with no room for even one pane still reports its workspace,
 * its focus and a withheld count rather than being undeliverable.
 */
export function projectPaneChrome(input: PaneChromeProjectionInput): PaneChromeFrame {
    const envelope: PaneChromeFrame = {
        placement: PANE_CHROME_PLACEMENT,
        formFactor: input.formFactor,
        workspaceID: input.workspaceID,
        focusedPaneID: input.focusedPaneID ?? null,
        zoomedPaneID: input.zoomedPaneID ?? null,
        panes: [],
        withheld: 0
    };
    let used = paneChromeBytes(envelope);
    const panes: PaneChromeFramePane[] = [];
    let withheld = 0;
    for (const descriptor of input.panes) {
        const pane = framePane(descriptor);
        // `+ 1` for the comma that joins it to the pane before it. Cheap, and it keeps the sum an
        // over-estimate rather than an under-estimate, which is the side to be wrong on.
        const cost = paneChromeBytes(pane) + 1;
        if (used + cost > PANE_CHROME_FRAME_BUDGET) {
            withheld += 1;
            continue;
        }
        used += cost;
        panes.push(pane);
    }
    return { ...envelope, panes, withheld };
}

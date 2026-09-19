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
 * `pluginID`s, the command name behind any control or item, connection URLs and page URLs, every
 * run closure, and the `data-testid` of every control. The paths, handles and sessions never reach
 * the descriptor at all (`model.ts` builds it from a `PaneModel` and never reads them); the test
 * ids and the contribution ids are dropped HERE.
 *
 * ── Opaque refs ─────────────────────────────────────────────────────────────────────
 *
 * The descriptor identifies a control by its `key` and an item by its contribution `id`, and for
 * another plugin's contribution BOTH of those are `<pluginID>.<something>` - the owner's namespace
 * and the command's name, spelled out. The host needs them, because they are what its own tables
 * are keyed by; a frame must not carry them, because "no `pluginID`, no verb name" is the rule
 * every other projection in this window keeps (`docs/plugin-ui.md`'s palette row and prompt owner).
 *
 * So the frame carries a `ref` instead, and the mapping back is a private table that leaves with
 * the frame and is never published: `settings/sections.ts` keeps a field's write target private in
 * exactly this shape, and takes an id back. A ref is scoped to its pane and to the ROW POSITION
 * inside it, so it carries nothing about the owner and it changes the moment the row does - which
 * is what makes a stale activation refuse rather than hit whatever moved into that slot, the same
 * guarantee `surface.ts` gets from re-resolving a key against a fresh model.
 */

import type { IconName } from '../grid/icons';

import {
    PANE_CHROME_LIMITS,
    PANE_CHROME_PLACEMENT,
    type PaneChromeAgent,
    type PaneChromeChanges,
    type PaneChromeControlKind,
    type PaneChromeDescriptor,
    type PaneChromeItemTone,
    type PaneChromeKind,
    type PaneChromePlacement,
    type PaneChromeSize,
    type PaneChromeStatus,
    type PaneChromeSync,
    type PaneChromeTitleParts,
    type PaneChromeZoom
} from './contract';

/**
 * Where a pane's band is, in the presenter frame's own coordinate space.
 *
 * Added in phase B, and it is what the chosen geometry rests on: ONE presenter view draws every
 * carried pane's header, so it has to be told where each one goes. The host positions a single
 * frame over the whole grid and clips it to the union of the carried bands (`presenter-slot.tsx`),
 * and the presenter absolutely positions a header at each of these rectangles inside it.
 *
 * It carries nothing the window is not already showing: the same rectangle the user is looking at,
 * in CSS px, with the origin at the grid's top-left rather than the screen's - so it says nothing
 * about where the window is, how big the display is, or what else is on it. `null` in a projection
 * built without a layout (every unit test, and the first render before the grid has measured).
 */
export interface PaneChromeFrameRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** A trailing control, as a presenter sees it: no test id, no verb, no owner. */
export interface PaneChromeFrameControl {
    /**
     * An opaque, pane-scoped handle. It is what `activatePaneControl` takes back, and it is
     * deliberately NOT the control's host-side key: for another plugin's command that key is its
     * contribution id, which names the owner.
     */
    readonly ref: string;
    readonly kind: PaneChromeControlKind;
    readonly label: string;
    readonly icon: IconName;
    readonly enabled: boolean;
    readonly pinned: boolean;
}

/**
 * One of another plugin's `pane.header` items, as a presenter sees it: the descriptor with its
 * contribution id replaced by an opaque ref, for the same reason a control's key is.
 */
export interface PaneChromeFrameItem {
    readonly ref: string;
    readonly text: string;
    readonly tooltip: string | null;
    readonly badge: string | null;
    readonly tone: PaneChromeItemTone;
    readonly enabled: boolean;
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
    /** The band's rectangle inside the presenter's frame, or null in a projection with no layout. */
    readonly rect: PaneChromeFrameRect | null;
    readonly size: PaneChromeSize;
    readonly controls: readonly PaneChromeFrameControl[];
    readonly items: readonly PaneChromeFrameItem[];
    /**
     * How many of another plugin's items the HOST is drawing in its own box beside the controls.
     *
     * A number rather than the box: the chips are native chrome the host renders as text and never
     * as HTML, and a presenter that replaced them would delete another plugin's extension point
     * instead of inheriting it. The descriptors are in `items` and `runPaneHeaderItem` activates
     * them by ref; this says how many the host has already put on screen.
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
    /**
     * Each pane's band rectangle in the presenter frame's coordinate space, by pane id.
     *
     * Optional, and absent everywhere there is no layout to state: `projectPaneChrome` is a pure
     * function over a model and the grid is the only thing that has measured a box. A pane with no
     * entry gets `rect: null` rather than a guess.
     */
    readonly rects?: Readonly<Record<string, PaneChromeFrameRect>> | undefined;
}

/**
 * What one ref names, on the host's side of the table.
 *
 * `id` is the host-side identity the surface already understands: a control's `key`
 * (`split-right`, or another plugin's contribution id) or an item's contribution id. It never
 * leaves the host.
 */
export interface PaneChromeRefTarget {
    readonly paneID: string;
    readonly what: 'control' | 'item';
    readonly id: string;
}

/**
 * The private half of the projection: ref back to what it names.
 *
 * It leaves with the frame and is never published. Phase B's host keeps the table beside the
 * frame it sent, resolves a presenter's `activatePaneControl` / `runPaneHeaderItem` through it,
 * and hands the resulting id to `surface.runControl` / `surface.runItem`, which re-resolve it
 * against a fresh model before anything runs. Two checks rather than one, and neither of them is
 * "trust the string the presenter sent".
 */
export interface PaneChromeRefTable {
    resolve(paneID: string, ref: string): PaneChromeRefTarget | undefined;
    /** How many refs this frame minted. Test seam. */
    readonly size: number;
}

/** A frame and the table that reads its refs. */
export interface PaneChromeProjection {
    readonly frame: PaneChromeFrame;
    readonly refs: PaneChromeRefTable;
}

/**
 * Mint a ref for a row position.
 *
 * Position-scoped rather than random: a random ref would be no more opaque (there is nothing to
 * guess - the presenter is holding the list) and would churn every frame, so a click landing one
 * frame late would always miss. This one is stable for exactly as long as the row is, and the
 * moment a control appears, disappears or moves, the refs after it shift and a stale activation
 * resolves to the wrong slot - which the surface's own re-resolve against a fresh model is what
 * finally refuses. `c` and `i` keep the two lists apart so an item's ref cannot activate a
 * control.
 */
function mintRef(what: 'control' | 'item', index: number): string {
    return `${what === 'control' ? 'c' : 'i'}${String(index)}`;
}

const encoder = new TextEncoder();

/** Bytes of JSON, measured as `pluginJSON` measures them. */
export function paneChromeBytes(value: unknown): number {
    return encoder.encode(JSON.stringify(value)).byteLength;
}

/** The budget the pane list is actually measured against, once the envelope is paid for. */
export const PANE_CHROME_FRAME_BUDGET =
    PANE_CHROME_LIMITS.payloadBytes - PANE_CHROME_LIMITS.frameMargin;

/** Whole CSS px, and nothing that is not a number. A rect that cannot be trusted is no rect. */
function frameRect(value: PaneChromeFrameRect | undefined): PaneChromeFrameRect | null {
    if (value === undefined) return null;
    const { x, y, width, height } = value;
    if (![x, y, width, height].every((part) => Number.isFinite(part))) return null;
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(0, Math.round(width)),
        height: Math.max(0, Math.round(height))
    };
}

function framePane(
    descriptor: PaneChromeDescriptor,
    mint: (target: PaneChromeRefTarget, ref: string) => void,
    rect: PaneChromeFrameRect | undefined
): PaneChromeFramePane {
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
        rect: frameRect(rect),
        size: descriptor.size,
        controls: descriptor.controls.map((control, index) => {
            const ref = mintRef('control', index);
            mint({ paneID: descriptor.paneID, what: 'control', id: control.key }, ref);
            return {
                ref,
                kind: control.kind,
                label: control.label,
                icon: control.icon,
                enabled: control.enabled,
                pinned: control.pinned
            };
        }),
        items: descriptor.items.map((item, index) => {
            const ref = mintRef('item', index);
            mint({ paneID: descriptor.paneID, what: 'item', id: item.id }, ref);
            return {
                ref,
                text: item.text,
                tooltip: item.tooltip,
                badge: item.badge,
                tone: item.tone,
                enabled: item.enabled
            };
        }),
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
export function projectPaneChrome(input: PaneChromeProjectionInput): PaneChromeProjection {
    const table = new Map<string, PaneChromeRefTarget>();
    const key = (paneID: string, ref: string): string => `${paneID}\u0000${ref}`;
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
    for (const [index, descriptor] of input.panes.entries()) {
        const staged = new Map<string, PaneChromeRefTarget>();
        const pane = framePane(
            descriptor,
            (target, ref) => staged.set(key(target.paneID, ref), target),
            input.rects?.[descriptor.paneID]
        );
        // `+ 1` for the comma that joins it to the pane before it. Cheap, and it keeps the sum an
        // over-estimate rather than an under-estimate, which is the side to be wrong on.
        const cost = paneChromeBytes(pane) + 1;
        if (used + cost > PANE_CHROME_FRAME_BUDGET) {
            /*
             * STOP, rather than skipping this one and trying the next.
             *
             * `continue` was cheaper by a pane or two and made the frame a lie: a presenter was
             * told "the panes that fit, in the workspace's own order, and a count of the rest",
             * and what it got was an arbitrary SUBSET - one wide pane dropped and a narrow one
             * three places later carried. There is no way to draw a header row from that. The
             * panes carried are now always a PREFIX of the workspace, so `withheld` means
             * "everything after these", which is a sentence a presenter can act on.
             */
            withheld = input.panes.length - index;
            break;
        }
        used += cost;
        panes.push(pane);
        for (const [entry, target] of staged) table.set(entry, target);
    }
    return {
        frame: { ...envelope, panes, withheld },
        refs: {
            resolve: (paneID, ref) => table.get(key(paneID, ref)),
            get size() {
                return table.size;
            }
        }
    };
}

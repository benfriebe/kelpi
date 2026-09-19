/**
 * What a SELECTED pane chrome presenter is told, and what it is allowed to do about it.
 *
 * The third sibling of `settings/presenter.ts` and `interaction/presenter.ts`, and written to the
 * same three rules: the frame is projected FIELD BY FIELD, every call is re-validated here before
 * the surface is touched, and the surface re-validates on its own account against a fresh model.
 * A bug in one layer is then not a hole.
 *
 * ── One placement, one frame, every pane ────────────────────────────────────────────
 *
 * A view selected for `pane.chrome` draws the header band of every visible pane of the displayed
 * workspace. The host keeps the band itself - its height, its fill, the focus ring around it, the
 * pane-move drag, the inline rename field and the pane context menu - and hands the presenter the
 * rectangle inside it. `projection.ts` bounds the frame at 256 KiB and counts what it could not
 * carry; a withheld pane keeps its native header, which is why the fallback below can be
 * all-or-nothing without leaving a gap on screen.
 *
 * ── What is withheld, and how ───────────────────────────────────────────────────────
 *
 *   - **Run targets.** A control is a display name and an opaque, pane-scoped `ref`; the host-side
 *     key (`split-right`, or another plugin's `<pluginID>.<command>`) stays in the ref table that
 *     left with the frame. A leaked key would name the owner and the verb in the same breath as
 *     saying they are withheld.
 *   - **Test ids, absolute paths, PTY handles, pids, agent session ids, page URLs.** Dropped by
 *     `model.ts` (which never reads them) and by `projection.ts` (which drops the rest).
 *   - **Everything else by construction.** The top level of every frame is copied field by field,
 *     never by spread, and `pluginJSON` round-trips the result, so a presenter never holds a host
 *     object at all.
 *
 * ── The pane-move drag is NOT a presenter call ──────────────────────────────────────
 *
 * It was, briefly: `beginPaneDrag(paneID)` let a presenter say that the press in its band had
 * started one. It cannot work, and the reason is not this contract's to fix. **Chromium settles
 * where a mouse gesture is routed when the button goes down**, so a press inside the presenter's
 * iframe keeps every later move and the release inside that iframe's document; a host that flips
 * the frame to `pointer-events: none` on hearing about the press is acting after the routing was
 * decided. Measured on a real pointer: the frame received every move and the window's gesture
 * received none.
 *
 * So the press has to happen in the HOST's document from the start, and the host reserves a strip
 * at the leading edge of every presented band for exactly that
 * (`PANE_CHROME_LIMITS.gripWidth`, `presenter-slot.tsx` ▸ `PaneChromeGrips`). Nothing a presenter
 * draws can cover it, because its own rectangle begins after it.
 *
 * ── One name that had to change ─────────────────────────────────────────────────────
 *
 * Phase A's `pane-chrome.d.ts` declared the focus call as `focusPane(paneID)`. `ViewAPI['ui']`
 * already has `focusPane(workspaceID, paneID)`, so the two would have intersected into one name
 * with two overloads, and `browser.js` would have had to dispatch on argument count - a plugin that
 * passed one argument by mistake would silently have called the other verb. The presenter's call is
 * `focusChromePane` for that reason, and only that one: nothing else in this contract collides.
 */

import { pluginJSON, type JsonObject } from '@kelpi/protocol';

import {
    PANE_CHROME_LIMITS,
    PANE_CHROME_PLACEMENT,
    paneChromeDragRegion,
    type PaneChromeDragRegion,
    type PaneChromePlacement
} from './contract';
import type { PaneChromeFramePane, PaneChromeProjection } from './projection';
import type { PaneChromeSurface } from './surface';

export const PANE_CHROME_PLACEMENTS: readonly PaneChromePlacement[] = Object.freeze([
    PANE_CHROME_PLACEMENT
]);

/**
 * The eleven `ui.*` methods a granted pane chrome presenter may send.
 *
 * `ui.getPaneChrome` is a READ, answered by `getPaneChrome()`; the other ten are calls, answered by
 * `call()`. `ui.reportPresenterReady` is shared with the interaction and Settings placements
 * verbatim - a presenter reports that it has painted in one vocabulary, whatever it presents.
 */
export const PANE_CHROME_UI_METHODS = [
    'ui.getPaneChrome',
    'ui.reportPresenterReady',
    'ui.focusChromePane',
    'ui.splitPane',
    'ui.toggleZoom',
    'ui.renamePane',
    'ui.closePane',
    'ui.activatePaneControl',
    'ui.runPaneHeaderItem',
    'ui.openPaneMenu',
    'ui.setPaneChromeHeight',
    'ui.setPaneDragRegions'
] as const;

// ── the DTO ─────────────────────────────────────────────────────────────────────────
//
// The host's own declaration of the presenter-facing frame. `packages/plugin-sdk/pane-chrome.d.ts`
// declares the same shape for plugin authors, and the two are kept in step by the SDK's typecheck
// file and its feed tests.

export interface PaneChromePresenterSnapshot {
    readonly placement: PaneChromePlacement;
    /** Desktop only in this release; a phone window keeps its own header (decision 8). */
    readonly formFactor: 'desktop' | 'phone';
    /**
     * This presenter is painting right now. False means present nothing: the window is showing
     * another workspace, the grid is gone, or the bundled header has the band back.
     */
    readonly visible: boolean;
    readonly workspaceID: string;
    readonly focusedPaneID: string | null;
    readonly zoomedPaneID: string | null;
    readonly panes: readonly PaneChromeFramePane[];
    /** Visible panes the budget could not carry. They keep their native header. */
    readonly withheld: number;
}

// ── the host model ──────────────────────────────────────────────────────────────────

export interface PaneChromePresenterHost {
    readonly placement: PaneChromePlacement;
    /** The current frame: frozen, `pluginJSON`-checked and bounded at 256 KiB. */
    getPaneChrome(): PaneChromePresenterSnapshot;
    subscribe(
        listener: (value: PaneChromePresenterSnapshot) => void,
        onError?: (error: Error) => void
    ): () => void;
    /** The ten mutating methods. `ui.getPaneChrome` is read through the getter above. */
    call(method: string, args: JsonObject): void | Promise<void>;
    /** The feed's ack, so the watchdog can tell a live presenter from a wedged one. */
    noteAcknowledged(): void;
    /** Re-read the host's own facts and republish if the frame moved. */
    refresh(): void;
    dispose(): void;
}

export interface PaneChromePresenterHostOptions {
    readonly placement: PaneChromePlacement;
    readonly formFactor: () => 'desktop' | 'phone';
    /** The host's paint decision, read afresh on every frame. */
    readonly visible: () => boolean;
    /** A fresh projection of the grid, refs and all. Never memoised: it is read per frame. */
    readonly projection: () => PaneChromeProjection;
    /** The write path for one pane, which re-resolves every call against a fresh model. */
    readonly surface: (paneID: string) => PaneChromeSurface | null;
    /** Open the HOST's inline rename field on that pane (ratified decision 6). */
    readonly openRename: (paneID: string) => void;
    /** Open the HOST's own pane context menu for that pane, anchored under its band. */
    readonly openMenu: (paneID: string) => void;
    /** Declare (or withdraw) a pane's band. The clamp is `height.ts`'s, not the presenter's. */
    readonly declareHeight: (paneID: string, pixels: number | null) => void;
    /** Declare (or withdraw) the parts of a pane's band that behave like a title bar. */
    readonly declareDragRegions: (paneID: string, regions: readonly PaneChromeDragRegion[] | null) => void;
    /** A presenter that cannot be trusted with every pane's header any more. */
    readonly fail: (detail: string) => void;
    /**
     * A frame left for the presenter. `awaitsAcknowledgement` marks a frame the user is waiting to
     * see redrawn - the first painted one, and any frame whose SHAPE moved (a pane opened or
     * closed, the workspace changed, a rename field opened, the withheld count moved).
     */
    readonly onFrame?: ((awaitsAcknowledgement: boolean) => void) | undefined;
    readonly onAcknowledged?: (() => void) | undefined;
    readonly onReady?: (() => void) | undefined;
}

/** Declared keys per call, so an unknown or missing argument is refused before anything runs. */
const CALL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'ui.reportPresenterReady': [],
    'ui.focusChromePane': ['paneID'],
    'ui.splitPane': ['paneID', 'direction'],
    'ui.toggleZoom': ['paneID'],
    'ui.renamePane': ['paneID'],
    'ui.closePane': ['paneID'],
    'ui.activatePaneControl': ['paneID', 'ref'],
    'ui.runPaneHeaderItem': ['paneID', 'ref'],
    'ui.openPaneMenu': ['paneID'],
    'ui.setPaneChromeHeight': ['paneID', 'pixels'],
    'ui.setPaneDragRegions': ['paneID', 'regions']
});

const PLACEMENT_METHODS: Readonly<Record<PaneChromePlacement, readonly string[]>> = Object.freeze({
    'pane.chrome': [...PANE_CHROME_UI_METHODS]
});

function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

// ── the window's failure latch ──────────────────────────────────────────────────────
//
// A module-level store for the reason the other two presenters give: the two readers are in
// different trees. The slot that mounts a presenter is inside the pane grid, and the row that
// reports the failure and offers Retry is inside Settings ▸ Plugins, which is a different subtree
// of a different overlay. One store per page is one store per window.

/** Which generation failed, and why. `generation` is `viewID:revision:instanceID`. */
export interface PaneChromePresenterFailure {
    readonly generation: string;
    readonly detail: string;
}

let failure: PaneChromePresenterFailure | null = null;
const failureListeners = new Set<() => void>();

function publishFailure(next: PaneChromePresenterFailure | null): void {
    failure = next === null ? null : Object.freeze(next);
    for (const listener of [...failureListeners]) listener();
}

/** Stable between changes, so a `useSyncExternalStore` reader cannot spin on it. */
export function paneChromePresenterFailure(): PaneChromePresenterFailure | null {
    return failure;
}

export function notePaneChromePresenterFailure(generation: string, detail: string): void {
    if (failure?.generation === generation) return;
    publishFailure({ generation, detail });
}

/** The explicit Retry, and the reload/rollback/selection paths that supersede a latch. */
export function clearPaneChromePresenterFailure(): void {
    if (failure === null) return;
    publishFailure(null);
}

export function subscribePaneChromePresenters(listener: () => void): () => void {
    failureListeners.add(listener);
    return () => {
        failureListeners.delete(listener);
    };
}

/** Test seam: one page is one window, so a suite has to be able to start from a clean one. */
export function resetPaneChromePresenterFailures(): void {
    publishFailure(null);
    publishPainted(null);
}

// ── the window's painted latch ──────────────────────────────────────────────────────
//
// The other fact the grid needs and cannot see: has the SELECTED presenter actually painted yet?
//
// Without it the header stands down the instant a plugin is selected, and the pane spends the boot,
// the attach and the first frame with no title, no close, no split and no zoom - and the full five
// seconds of the readiness watchdog if the view never paints at all. The same hole opens on every
// reload and rollback, which is exactly when a presenter is most likely not to come back.
//
// So the band swaps on the presenter's OWN readiness report rather than on the selection: the
// bundled header keeps drawing, the presenter's frame is mounted but clipped to nothing, and the
// two change places in one commit when it says it has painted. Keyed by generation, so a reload
// puts the bundled header back until the new instance has painted in its turn.

let paintedGeneration: string | null = null;
const paintedListeners = new Set<() => void>();

function publishPainted(next: string | null): void {
    if (paintedGeneration === next) return;
    paintedGeneration = next;
    for (const listener of [...paintedListeners]) listener();
}

/** The generation that has reported it has painted, or null while none has. */
export function paneChromePaintedGeneration(): string | null {
    return paintedGeneration;
}

export function notePaneChromePainted(generation: string): void {
    publishPainted(generation);
}

/** A reload, a different selection, a failure or the slot going away all end a painted generation. */
export function clearPaneChromePainted(): void {
    publishPainted(null);
}

export function subscribePaneChromePainted(listener: () => void): () => void {
    paintedListeners.add(listener);
    return () => {
        paintedListeners.delete(listener);
    };
}

// ── the host ────────────────────────────────────────────────────────────────────────

export function createPaneChromePresenterHost(
    options: PaneChromePresenterHostOptions
): PaneChromePresenterHost {
    const { placement } = options;
    type Delivery = { value: PaneChromePresenterSnapshot; refs: PaneChromeProjection['refs'] } | { error: Error };
    type Entry = {
        listener: (value: PaneChromePresenterSnapshot) => void;
        onError?: (error: Error) => void;
    };

    const listeners = new Set<Entry>();
    const calls: number[] = [];
    let disposed = false;
    let queued = false;
    let lastKey: string | undefined;
    let shape: string | null = null;
    /**
     * The inputs the last frame was built from, by identity.
     *
     * `refresh()` runs on every render of the grid, and most renders change nothing this frame is
     * made of - a hover, a focus ring dimming, a toast. Without this each of them cost a
     * projection, a `pluginJSON` round trip, a deep freeze and a `JSON.stringify` of the whole
     * frame, and during a divider drag that is once per pointer move. `PaneGrid` memoises the
     * projection on the facts it is built from, so identity here is exactly "nothing moved".
     */
    let lastInputs: { projection: PaneChromeProjection; formFactor: string; visible: boolean } | null = null;
    /**
     * The frame the presenter is actually HOLDING, and the table that reads its refs.
     *
     * Kept rather than re-projected per call, and the two halves of the guarantee are worth
     * separating. The TABLE is the delivered frame's, so a ref the current frame does not carry -
     * forged, from another pane, or naming a control that has since left the row - resolves to
     * nothing and is refused here. The KEY it resolves to is then re-resolved by
     * `surface.runControl` against a fresh model, so a control that has gone or gone disabled
     * since the frame went out refuses there. Neither check is trust, and neither is the one that
     * used to be claimed: refs are assigned per KEY rather than per row position
     * (`projection.ts` ▸ `createPaneChromeRefs`), which is what stops a one-commit-old click
     * resolving to whatever moved into that slot.
     */
    let delivered: { snapshot: PaneChromePresenterSnapshot; refs: PaneChromeProjection['refs'] } | null = null;

    /** Field by field, so nothing new can ride along unnoticed. */
    const project = (): { value: PaneChromePresenterSnapshot; refs: PaneChromeProjection['refs'] } => {
        const projection = options.projection();
        return {
            value: {
                placement,
                formFactor: options.formFactor(),
                visible: options.visible(),
                workspaceID: projection.frame.workspaceID,
                focusedPaneID: projection.frame.focusedPaneID,
                zoomedPaneID: projection.frame.zoomedPaneID,
                panes: projection.frame.panes,
                withheld: projection.frame.withheld
            },
            refs: projection.refs
        };
    };

    const read = (): Delivery => {
        try {
            const next = project();
            const value = (
                pluginJSON({
                    type: 'pane-chrome',
                    sequence: Number.MAX_SAFE_INTEGER,
                    value: next.value
                }) as unknown as { value: PaneChromePresenterSnapshot }
            ).value;
            return { value: freeze(value), refs: next.refs };
        } catch {
            return { error: new Error('Pane chrome frame is invalid or exceeds 256 KiB.') };
        }
    };

    const key = (next: Delivery): string =>
        'value' in next ? JSON.stringify(next.value) : `error:${next.error.message}`;

    const deliver = (entry: Entry, next: Delivery): void => {
        try {
            if ('value' in next) entry.listener(next.value);
            else entry.onError?.(next.error);
        } catch {
            /* A failed consumer cannot stop another listener, or the watchdog, seeing this frame. */
        }
    };

    /**
     * What the user is WAITING to see redrawn, as one identity.
     *
     * The SHAPE of the row: the workspace, the panes in order, whether each is showing the host's
     * rename field, and how many were withheld. A pane opening or closing, a workspace switch and
     * a rename field going up are all frames a presenter has to repaint or the header row is wrong.
     *
     * Deliberately NOT the geometry or the titles. A divider drag moves every rect at pointer rate
     * and a shell writes its title whenever it likes; holding a presenter to a 5 s deadline for one
     * of those would fail a working presenter for being busy, exactly as the Settings watchdog
     * refuses to wait on a value change inside an unchanged field set.
     */
    const shapeOf = (value: PaneChromePresenterSnapshot): string | null =>
        value.visible
            ? `${value.workspaceID}|${String(value.withheld)}|${value.panes
                  .map((pane) => `${pane.paneID}${pane.renaming ? '*' : ''}`)
                  .join(',')}`
            : null;

    const note = (next: Delivery): void => {
        if (!('value' in next)) {
            /*
             * An undeliverable frame is not something a watchdog can save: the SDK acknowledges an
             * error exactly as it acknowledges a frame, so arming the acknowledgement timer here
             * would be cleared by the presenter's own ack while every pane sat headerless. So the
             * placement fails NOW, which is what puts the native header back on every pane.
             */
            delivered = null;
            if (options.visible()) options.fail(next.error.message);
            else options.onFrame?.(false);
            return;
        }
        delivered = { snapshot: next.value, refs: next.refs };
        const nextShape = shapeOf(next.value);
        const awaits = nextShape !== null && nextShape !== shape;
        shape = nextShape;
        options.onFrame?.(awaits);
    };

    const update = (): void => {
        if (disposed || queued || listeners.size === 0) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (disposed || listeners.size === 0) return;
            const projection = options.projection();
            const formFactor = options.formFactor();
            const visible = options.visible();
            if (
                lastInputs !== null &&
                lastInputs.projection === projection &&
                lastInputs.formFactor === formFactor &&
                lastInputs.visible === visible
            )
                return;
            lastInputs = { projection, formFactor, visible };
            const next = read();
            const nextKey = key(next);
            if (nextKey === lastKey) return;
            lastKey = nextKey;
            for (const entry of [...listeners]) deliver(entry, next);
            note(next);
        });
    };

    /**
     * 240 calls per rolling second, the interaction budget verbatim. A breach FAILS the presenter as
     * well as rejecting the call: a call loop is not a recoverable error, and the bundled header has
     * to be able to take every band back from it.
     */
    const charge = (): void => {
        const now = Date.now();
        while (calls.length > 0 && now - calls[0]! >= PANE_CHROME_LIMITS.presenterCallWindowMs) calls.shift();
        calls.push(now);
        if (calls.length <= PANE_CHROME_LIMITS.presenterCalls) return;
        const message = 'This presenter exceeded its pane chrome call budget.';
        options.fail(message);
        throw new Error(message);
    };

    /**
     * A mutating call is only meaningful while this presenter is actually drawing the bands.
     *
     * A frame that says `visible: false` is "present nothing": the window is showing another
     * workspace, or the bundled header has the band back. A write arriving then is a presenter
     * acting on a grid the user is not looking at, so it is refused here rather than further down.
     */
    const painted = (): PaneChromePresenterSnapshot => {
        if (delivered === null || !delivered.snapshot.visible)
            throw new Error('Pane chrome is not presented right now.');
        return delivered.snapshot;
    };

    /** A pane the CURRENT published frame carries. A withheld pane is not one, and neither is a guess. */
    const pane = (value: unknown): PaneChromeFramePane => {
        const current = painted();
        if (typeof value !== 'string' || value.length > 160)
            throw new Error('That pane is not in the current pane chrome frame.');
        const found = current.panes.find((entry) => entry.paneID === value);
        // Unknown, hidden, withheld and another workspace's all land here: the frame only ever
        // carries the visible panes of the displayed workspace that fit the budget.
        if (found === undefined) throw new Error('That pane is not in the current pane chrome frame.');
        return found;
    };

    const write = (paneID: string): PaneChromeSurface => {
        const surface = options.surface(paneID);
        // The pane was in the frame a moment ago and its header has unmounted since: nothing to
        // re-resolve against, so nothing runs.
        if (surface === null) throw new Error('That pane is not in the current pane chrome frame.');
        return surface;
    };

    /** One of the frame's refs, of the expected kind. Forged, stale and cross-pane refs all miss. */
    const target = (paneID: string, value: unknown, what: 'control' | 'item'): string => {
        if (typeof value !== 'string' || value.length > 64)
            throw new Error('That control is not in the current pane chrome frame.');
        const resolved = delivered?.refs.resolve(paneID, value);
        // A control ref used by `runPaneHeaderItem` (or the other way round) lands here: the two
        // lists are not the same kind of thing and neither may be used to reach into the other.
        if (resolved === undefined || resolved.what !== what || resolved.paneID !== paneID)
            throw new Error('That control is not in the current pane chrome frame.');
        return resolved.id;
    };

    return {
        placement,
        getPaneChrome() {
            if (disposed) throw new Error('Pane chrome is unavailable after disposal.');
            charge();
            const next = read();
            if ('error' in next) throw next.error;
            // A pull is a delivery: the refs in the frame the presenter now holds are the ones its
            // next activation has to be resolved through.
            delivered = { snapshot: next.value, refs: next.refs };
            return next.value;
        },
        subscribe(listener, onError) {
            if (disposed) throw new Error('Pane chrome is unavailable after disposal.');
            const entry: Entry = { listener, ...(onError ? { onError } : {}) };
            listeners.add(entry);
            const next = read();
            if (listeners.size === 1) lastKey = key(next);
            deliver(entry, next);
            note(next);
            return () => {
                listeners.delete(entry);
            };
        },
        call(method, args) {
            const keys = CALL_ARGUMENTS[method];
            if (keys === undefined) throw new Error('Unknown pane chrome method.');
            if (
                args === null ||
                typeof args !== 'object' ||
                Array.isArray(args) ||
                Object.keys(args).length !== keys.length ||
                keys.some((name) => !(name in args))
            )
                throw new Error('Invalid pane chrome arguments.');
            if (new TextEncoder().encode(JSON.stringify(args)).length > PANE_CHROME_LIMITS.payloadBytes)
                throw new Error('Pane chrome arguments exceed 256 KiB.');
            if (!PLACEMENT_METHODS[placement].includes(method))
                throw new Error('This method belongs to another placement.');
            if (disposed) throw new Error('Pane chrome is unavailable after disposal.');
            charge();

            if (method === 'ui.reportPresenterReady') {
                options.onReady?.();
                return;
            }
            if (method === 'ui.setPaneChromeHeight') {
                const pixels = args['pixels'];
                if (pixels !== null && (typeof pixels !== 'number' || !Number.isFinite(pixels)))
                    throw new Error('A pane chrome band is a finite number of pixels, or null to withdraw.');
                if (pixels === null) {
                    /*
                     * A WITHDRAWAL is not a write, and refusing it for a pane the frame no longer
                     * carries was a trap: a pane leaves the frame the moment it is withheld, zoomed
                     * out or hidden, and every call for it is refused from then on - including the
                     * one call that would have handed its band back. The presenter was left holding
                     * a declaration it could never undo.
                     *
                     * So a hand-back needs only a pane with a live header to hand it back to. The
                     * host withdraws on its own account too (`height.ts` ▸
                     * `retainPaneChromeHeights`), because a presenter may be gone by then.
                     */
                    const paneID = args['paneID'];
                    if (typeof paneID !== 'string' || paneID.length > 160 || options.surface(paneID) === null)
                        throw new Error('That pane is not in the current pane chrome frame.');
                    options.declareHeight(paneID, null);
                    return;
                }
                const found = pane(args['paneID']);
                // The clamp is the host's (`contract.ts` ▸ `paneChromeHeight`), applied at read
                // against that pane's own height. This only decides that the declaration is legal.
                options.declareHeight(found.paneID, pixels);
                return;
            }
            if (method === 'ui.setPaneDragRegions') {
                const raw = args['regions'];
                if (raw === null) {
                    // A withdrawal, on the same terms as a band's: it only ever removes a host
                    // surface, so it needs a pane with a live header rather than a carried one.
                    const paneID = args['paneID'];
                    if (typeof paneID !== 'string' || paneID.length > 160 || options.surface(paneID) === null)
                        throw new Error('That pane is not in the current pane chrome frame.');
                    options.declareDragRegions(paneID, null);
                    return;
                }
                if (!Array.isArray(raw)) throw new Error('Pane drag regions are a list of rectangles, or null.');
                if (raw.length > PANE_CHROME_LIMITS.maxDragRegions)
                    throw new Error(
                        `A pane may declare at most ${String(PANE_CHROME_LIMITS.maxDragRegions)} drag regions.`
                    );
                const found = pane(args['paneID']);
                /*
                 * The band the rectangles are measured against is the one the FRAME published, so a
                 * presenter cannot widen its own header by declaring a rectangle bigger than it: a
                 * region is clamped into the pane's own band and a region with nothing left is
                 * dropped. That is what keeps a host surface off a terminal, a page hole, a divider
                 * and the pane next door.
                 */
                if (found.rect === null) throw new Error('That pane has not been laid out yet.');
                const band = { width: found.rect.width, height: found.rect.height };
                const clamped: PaneChromeDragRegion[] = [];
                for (const entry of raw) {
                    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
                        throw new Error('Pane drag regions are a list of rectangles, or null.');
                    const region = entry as Record<string, unknown>;
                    /*
                     * FINITE numbers, refused rather than dropped. NaN and the infinities are not
                     * rectangles, and treating them as a rectangle with no area would make one
                     * arithmetic slip inside a presenter look exactly like a deliberate hand-back -
                     * which is the rule `setPaneChromeHeight` already follows for a band.
                     */
                    if (!['x', 'y', 'width', 'height'].every((key) => Number.isFinite(region[key])))
                        throw new Error('A pane drag region is four finite numbers: x, y, width and height.');
                    const kept = paneChromeDragRegion(
                        {
                            x: region['x'] as number,
                            y: region['y'] as number,
                            width: region['width'] as number,
                            height: region['height'] as number
                        },
                        band
                    );
                    if (kept !== null) clamped.push(kept);
                }
                options.declareDragRegions(found.paneID, clamped.length === 0 ? null : clamped);
                return;
            }
            const found = pane(args['paneID']);
            if (method === 'ui.focusChromePane') {
                write(found.paneID).focusPane(found.paneID);
                return;
            }
            if (method === 'ui.splitPane') {
                const direction = args['direction'];
                if (direction !== 'horizontal' && direction !== 'vertical')
                    throw new Error('A split is horizontal or vertical.');
                write(found.paneID).splitPane(found.paneID, direction);
                return;
            }
            if (method === 'ui.toggleZoom') {
                write(found.paneID).toggleZoom(found.paneID);
                return;
            }
            if (method === 'ui.renamePane') {
                // The FIELD is the host's, and so is the commit: this opens it and returns
                // (ratified decision 6). A presenter never draws a host-owned text input.
                options.openRename(found.paneID);
                return;
            }
            if (method === 'ui.closePane') {
                // Through the host's existing confirmation, like every other close.
                write(found.paneID).closePane(found.paneID);
                return;
            }
            if (method === 'ui.openPaneMenu') {
                options.openMenu(found.paneID);
                return;
            }
            if (method === 'ui.activatePaneControl') {
                write(found.paneID).runControl(found.paneID, target(found.paneID, args['ref'], 'control'));
                return;
            }
            write(found.paneID).runItem(found.paneID, target(found.paneID, args['ref'], 'item'));
            return;
        },
        noteAcknowledged() {
            if (disposed) return;
            options.onAcknowledged?.();
        },
        refresh: update,
        dispose() {
            if (disposed) return;
            disposed = true;
            delivered = null;
            listeners.clear();
        }
    };
}

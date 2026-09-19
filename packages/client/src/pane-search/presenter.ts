/**
 * What a SELECTED pane search presenter is told, and what it is allowed to do about it.
 *
 * The fourth sibling of `settings/presenter.ts`, `interaction/presenter.ts` and
 * `pane-chrome/presenter.ts`, written to the same three rules: the frame is projected FIELD BY
 * FIELD, every call is re-validated here before anything is sent, and the write path it reaches
 * re-validates on its own account against the daemon's current state. A bug in one layer is then
 * not a hole.
 *
 * ── One bar, one pane, one session ──────────────────────────────────────────────────
 *
 * `searchingPaneID` is a single field on the workspace, so there is exactly one search open at a
 * time and the frame is about that one. That is why there is no budget cut, no withheld count and
 * no ref table here: pane chrome needs all three because it carries N panes and their controls;
 * this carries a needle, three numbers and a rectangle.
 *
 * ── What the presenter may NOT do ───────────────────────────────────────────────────
 *
 * **Open a search.** Opening stays a host gesture - Cmd-F, the menu, the palette row, and the
 * existing `terminal.search(workspaceID, 'toggle')` domain call which is a named plugin acting
 * under its own identity. A presenter that could open the bar could put a text field over any pane
 * it liked, at any moment, in a window the user had not asked anything of.
 *
 * **Reach another pane.** Every call names a pane and every pane is checked against the one the
 * PUBLISHED frame names. A pane id that was correct one frame ago and is not now - the search moved,
 * or closed - is refused, which is the lesson #244 recorded as "refs or ids a presenter sends must
 * never resolve against a stale frame to a different target", said for the only id this contract
 * has.
 *
 * **Reveal or highlight.** Scrolling to a match and painting it belong to the terminal renderer,
 * including a plugin terminal renderer, which already receives search through its own contract
 * (`docs/plugin-terminals.md`). `searchNext` moves the daemon's selection and the renderer follows;
 * nothing here draws in the pane.
 *
 * ── Why a withdrawal is not a write ─────────────────────────────────────────────────
 *
 * `setSearchBoxSize(paneID, null)` needs only a pane, not the pane the frame names, for pane
 * chrome's reason one surface over: a pane leaves the frame the moment the search closes or moves,
 * and refusing every call for it from then on would leave the presenter holding a declaration it
 * could never undo. The host withdraws on its own account too (`box.ts` ▸ `retainPaneSearchBox`),
 * because a presenter may be gone by then.
 */

import { pluginJSON, type JsonObject } from '@kelpi/protocol';

import {
    PANE_SEARCH_LIMITS,
    PANE_SEARCH_PLACEMENT,
    paneSearchNeedle,
    type PaneSearchPlacement,
    type PaneSearchSize
} from './contract';
import type { PaneSearchFrame, PaneSearchProjection } from './projection';

export const PANE_SEARCH_PLACEMENTS: readonly PaneSearchPlacement[] = Object.freeze([
    PANE_SEARCH_PLACEMENT
]);

/**
 * The eight `ui.*` methods a granted pane search presenter may send.
 *
 * `ui.getPaneSearch` is a READ, answered by `getPaneSearch()`; six are calls, answered by `call()`.
 * `ui.reportPresenterReady` is shared with the interaction, Settings and pane chrome placements
 * verbatim - a presenter reports that it has painted in one vocabulary, whatever it presents.
 *
 * None of these names collides with anything already on `ViewAPI['ui']`: `closeSearch` is not
 * `closeSettings`, and the domain's own `terminal.search` is on a different object with a different
 * arity, so `browser.js` never has to dispatch on argument count (the trap `focusChromePane` was
 * renamed to avoid).
 */
export const PANE_SEARCH_UI_METHODS = [
    'ui.getPaneSearch',
    'ui.reportPresenterReady',
    'ui.setSearchNeedle',
    'ui.setSearchCaseSensitive',
    'ui.searchNext',
    'ui.searchPrevious',
    'ui.closeSearch',
    'ui.setSearchBoxSize'
] as const;

// ── the DTO ─────────────────────────────────────────────────────────────────────────
//
// The host's own declaration of the presenter-facing frame. `packages/plugin-sdk/pane-search.d.ts`
// declares the same shape for plugin authors, and the two are kept in step by the SDK's typecheck
// file and its feed tests.

export type PaneSearchPresenterSnapshot = PaneSearchFrame;

// ── the host model ──────────────────────────────────────────────────────────────────

/** The write path the presenter's calls reach. Every one of them is the host's own verb. */
export interface PaneSearchActions {
    /** Push a needle for the searched pane. The host debounces it exactly as the native field does. */
    readonly setNeedle: (paneID: string, needle: string) => void;
    /** Recount with a different case flag. The flag is the host's for the session (see `contract.ts`). */
    readonly setCaseSensitive: (paneID: string, on: boolean) => void;
    readonly step: (paneID: string, direction: 'next' | 'prev') => void;
    /** Close the search AND hand the caret back to the pane, which is one gesture, not two. */
    readonly close: (paneID: string) => void;
    /** Declare (or withdraw) the box. The clamp is `contract.ts`'s, applied at read. */
    readonly declareBox: (paneID: string, size: PaneSearchSize | null) => void;
    /**
     * Is this pane one the host still has a live search surface for?
     *
     * The withdrawal's only test, for the reason at the top of this file. True for the searched
     * pane and for a pane that was being searched a moment ago and still exists.
     */
    readonly knows: (paneID: string) => boolean;
}

export interface PaneSearchPresenterHost {
    readonly placement: PaneSearchPlacement;
    /** The current frame: frozen, `pluginJSON`-checked and bounded at 256 KiB. */
    getPaneSearch(): PaneSearchPresenterSnapshot;
    subscribe(
        listener: (value: PaneSearchPresenterSnapshot) => void,
        onError?: (error: Error) => void
    ): () => void;
    /** The six mutating methods. `ui.getPaneSearch` is read through the getter above. */
    call(method: string, args: JsonObject): void | Promise<void>;
    /** The feed's ack, so the watchdog can tell a live presenter from a wedged one. */
    noteAcknowledged(): void;
    /** Re-read the host's own facts and republish if the frame moved. */
    refresh(): void;
    dispose(): void;
}

export interface PaneSearchPresenterHostOptions {
    readonly placement: PaneSearchPlacement;
    readonly formFactor: () => 'desktop' | 'phone';
    /** The host's paint decision, read afresh on every frame. */
    readonly visible: () => boolean;
    /** A fresh projection of the open session. Never memoised: it is read per frame. */
    readonly projection: () => PaneSearchProjection;
    readonly actions: PaneSearchActions;
    /** A presenter that cannot be trusted with the window's find bar any more. */
    readonly fail: (detail: string) => void;
    /**
     * A frame left for the presenter. `awaitsAcknowledgement` marks a frame that OPENS a session -
     * the one thing the user is waiting to see drawn. A needle delta, a new total and a moved
     * selection arm nothing, because a shell rewrites its buffer whenever it likes and a working
     * presenter must not be failed for being busy.
     */
    readonly onFrame?: ((awaitsAcknowledgement: boolean) => void) | undefined;
    readonly onAcknowledged?: (() => void) | undefined;
    readonly onReady?: (() => void) | undefined;
}

/** Declared keys per call, so an unknown or missing argument is refused before anything runs. */
const CALL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'ui.reportPresenterReady': [],
    'ui.setSearchNeedle': ['paneID', 'text'],
    'ui.setSearchCaseSensitive': ['paneID', 'on'],
    'ui.searchNext': ['paneID'],
    'ui.searchPrevious': ['paneID'],
    'ui.closeSearch': ['paneID'],
    'ui.setSearchBoxSize': ['paneID', 'size']
});

const PLACEMENT_METHODS: Readonly<Record<PaneSearchPlacement, readonly string[]>> = Object.freeze({
    'pane.search': [...PANE_SEARCH_UI_METHODS]
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
// A module-level store for the reason the other three presenters give: the two readers are in
// different trees. The slot that mounts a presenter is inside the pane grid, and the row that
// reports the failure and offers Retry is inside Settings ▸ Plugins, which is a different subtree
// of a different overlay. One store per page is one store per window.

/** Which generation failed, and why. `generation` is `viewID:revision:instanceID`. */
export interface PaneSearchPresenterFailure {
    readonly generation: string;
    readonly detail: string;
}

let failure: PaneSearchPresenterFailure | null = null;
const failureListeners = new Set<() => void>();

function publishFailure(next: PaneSearchPresenterFailure | null): void {
    failure = next === null ? null : Object.freeze(next);
    for (const listener of [...failureListeners]) listener();
}

/** Stable between changes, so a `useSyncExternalStore` reader cannot spin on it. */
export function paneSearchPresenterFailure(): PaneSearchPresenterFailure | null {
    return failure;
}

export function notePaneSearchPresenterFailure(generation: string, detail: string): void {
    if (failure?.generation === generation) return;
    publishFailure({ generation, detail });
}

/** The explicit Retry, and the reload/rollback/selection paths that supersede a latch. */
export function clearPaneSearchPresenterFailure(): void {
    if (failure === null) return;
    publishFailure(null);
}

export function subscribePaneSearchPresenters(listener: () => void): () => void {
    failureListeners.add(listener);
    return () => {
        failureListeners.delete(listener);
    };
}

/** Test seam: one page is one window, so a suite has to be able to start from a clean one. */
export function resetPaneSearchPresenterFailures(): void {
    publishFailure(null);
    publishPainted(null);
}

// ── the window's painted latch ──────────────────────────────────────────────────────
//
// The other fact the grid needs and cannot see: has the SELECTED presenter actually painted yet?
//
// Without it the native bar stands down the instant a plugin is selected, and a Cmd-F during the
// plugin's boot, its attach and its first frame opens a search with NO BAR AT ALL - and for the
// full five seconds of the readiness watchdog if the view never paints. The same hole opens on
// every reload and rollback, which is exactly when a presenter is most likely not to come back.
// #244 recorded it as a requirement in as many words: the native surface stays until the presenter
// has painted; never a frame with no search bar while search is open.

let paintedGeneration: string | null = null;
const paintedListeners = new Set<() => void>();

function publishPainted(next: string | null): void {
    if (paintedGeneration === next) return;
    paintedGeneration = next;
    for (const listener of [...paintedListeners]) listener();
}

/** The generation that has reported it has painted, or null while none has. */
export function paneSearchPaintedGeneration(): string | null {
    return paintedGeneration;
}

export function notePaneSearchPainted(generation: string): void {
    publishPainted(generation);
}

/** A reload, a different selection, a failure or the slot going away all end a painted generation. */
export function clearPaneSearchPainted(): void {
    publishPainted(null);
}

export function subscribePaneSearchPainted(listener: () => void): () => void {
    paintedListeners.add(listener);
    return () => {
        paintedListeners.delete(listener);
    };
}

// ── the host ────────────────────────────────────────────────────────────────────────

export function createPaneSearchPresenterHost(
    options: PaneSearchPresenterHostOptions
): PaneSearchPresenterHost {
    const { placement, actions } = options;
    type Delivery = { value: PaneSearchPresenterSnapshot } | { error: Error };
    type Entry = {
        listener: (value: PaneSearchPresenterSnapshot) => void;
        onError?: (error: Error) => void;
    };

    const listeners = new Set<Entry>();
    const calls: number[] = [];
    let disposed = false;
    let queued = false;
    let lastKey: string | undefined;
    /** The session identity the acknowledgement watchdog waits on: which pane, open or not. */
    let session: string | null = null;
    /**
     * The inputs the last frame was built from, by identity.
     *
     * `refresh()` runs on every render of the grid, and most renders change nothing this frame is
     * made of - a hover, a focus ring dimming, a toast. `PaneGrid` memoises the projection on the
     * facts it is built from, so identity here is exactly "nothing moved".
     */
    let lastInputs: { projection: PaneSearchProjection; formFactor: string; visible: boolean } | null = null;
    /** The frame the presenter is actually HOLDING. Every call is checked against this one. */
    let delivered: PaneSearchPresenterSnapshot | null = null;

    /** Field by field, so nothing new can ride along unnoticed. */
    const project = (): PaneSearchPresenterSnapshot => {
        const projection = options.projection();
        const frame = projection.frame;
        return {
            placement,
            formFactor: options.formFactor(),
            // A frame the host is not painting is "present nothing", whatever the session says.
            visible: options.visible() && frame.visible,
            paneID: frame.paneID,
            kind: frame.kind,
            needle: frame.needle,
            needleTruncated: frame.needleTruncated,
            caseSensitive: frame.caseSensitive,
            total: frame.total,
            selected: frame.selected,
            match: frame.match,
            box: frame.box
        };
    };

    const read = (): Delivery => {
        try {
            const value = (
                pluginJSON({
                    type: 'pane-search',
                    sequence: Number.MAX_SAFE_INTEGER,
                    value: project()
                }) as unknown as { value: PaneSearchPresenterSnapshot }
            ).value;
            return { value: freeze(value) };
        } catch {
            return { error: new Error('Pane search frame is invalid or exceeds 256 KiB.') };
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
     * What the user is WAITING to see drawn, as one identity: which pane is being searched.
     *
     * Deliberately NOT the needle, the total or the selection. Typing moves the needle on every
     * keystroke and a shell moves the total whenever it writes a line; holding a presenter to a 5 s
     * deadline for one of those would fail a working presenter for being busy, exactly as the pane
     * chrome watchdog refuses to wait on a divider drag.
     */
    const sessionOf = (value: PaneSearchPresenterSnapshot): string | null =>
        value.visible && value.paneID !== null ? value.paneID : null;

    const note = (next: Delivery): void => {
        if (!('value' in next)) {
            /*
             * An undeliverable frame is not something a watchdog can save: the SDK acknowledges an
             * error exactly as it acknowledges a frame, so arming the acknowledgement timer here
             * would be cleared by the presenter's own ack while the search sat with no bar. So the
             * placement fails NOW, which is what puts the native bar back.
             */
            delivered = null;
            if (options.visible()) options.fail(next.error.message);
            else options.onFrame?.(false);
            return;
        }
        delivered = next.value;
        const nextSession = sessionOf(next.value);
        const awaits = nextSession !== null && nextSession !== session;
        session = nextSession;
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
     * well as rejecting the call: a call loop is not a recoverable error, and here it is a call loop
     * holding the window's find bar and the caret with it.
     */
    const charge = (): void => {
        const now = Date.now();
        while (calls.length > 0 && now - calls[0]! >= PANE_SEARCH_LIMITS.presenterCallWindowMs) calls.shift();
        calls.push(now);
        if (calls.length <= PANE_SEARCH_LIMITS.presenterCalls) return;
        const message = 'This presenter exceeded its pane search call budget.';
        options.fail(message);
        throw new Error(message);
    };

    /**
     * A mutating call is only meaningful while this presenter is actually drawing the bar.
     *
     * A frame that says `visible: false` is "present nothing": no search is open, the window is
     * showing another workspace, or the native bar has the box back. A write arriving then is a
     * presenter acting on a search the user is not looking at, so it is refused here rather than
     * further down - and refusing it here is also what stops a presenter OPENING a search by
     * setting a needle on a pane nobody asked to search.
     */
    const open = (): PaneSearchPresenterSnapshot => {
        if (delivered === null || !delivered.visible || delivered.paneID === null)
            throw new Error('No search is open for this presenter.');
        return delivered;
    };

    /** The pane the CURRENT published frame names. A guess, a stale id and another pane all miss. */
    const pane = (value: unknown): string => {
        const current = open();
        if (typeof value !== 'string' || value.length > 160 || value !== current.paneID)
            throw new Error('That pane is not the one being searched.');
        return current.paneID;
    };

    return {
        placement,
        getPaneSearch() {
            if (disposed) throw new Error('Pane search is unavailable after disposal.');
            charge();
            const next = read();
            if ('error' in next) throw next.error;
            // A pull is a delivery: the frame the presenter now holds is the one its next call has
            // to be checked against.
            delivered = next.value;
            return next.value;
        },
        subscribe(listener, onError) {
            if (disposed) throw new Error('Pane search is unavailable after disposal.');
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
            if (keys === undefined) throw new Error('Unknown pane search method.');
            if (
                args === null ||
                typeof args !== 'object' ||
                Array.isArray(args) ||
                Object.keys(args).length !== keys.length ||
                keys.some((name) => !(name in args))
            )
                throw new Error('Invalid pane search arguments.');
            if (new TextEncoder().encode(JSON.stringify(args)).length > PANE_SEARCH_LIMITS.payloadBytes)
                throw new Error('Pane search arguments exceed 256 KiB.');
            if (!PLACEMENT_METHODS[placement].includes(method))
                throw new Error('This method belongs to another placement.');
            if (disposed) throw new Error('Pane search is unavailable after disposal.');
            charge();

            if (method === 'ui.reportPresenterReady') {
                options.onReady?.();
                return;
            }
            if (method === 'ui.setSearchBoxSize') {
                const size = args['size'];
                if (size === null) {
                    /*
                     * A WITHDRAWAL is not a write. Refusing it for a pane the frame no longer names
                     * was the trap #244 recorded: the search closes, the pane leaves the frame, and
                     * the one call that would have handed the box back is refused from then on.
                     */
                    const paneID = args['paneID'];
                    if (typeof paneID !== 'string' || paneID.length > 160 || !actions.knows(paneID))
                        throw new Error('That pane is not the one being searched.');
                    actions.declareBox(paneID, null);
                    return;
                }
                if (size === undefined || typeof size !== 'object' || Array.isArray(size))
                    throw new Error('A pane search box is { width, height }, or null to withdraw.');
                const box = size as Record<string, unknown>;
                if (!['width', 'height'].every((name) => Number.isFinite(box[name])))
                    throw new Error('A pane search box is two finite numbers: width and height.');
                const paneID = pane(args['paneID']);
                // The clamp is the host's (`contract.ts` ▸ `paneSearchBox`), applied at read against
                // that pane's own rectangle. This only decides that the declaration is legal.
                actions.declareBox(paneID, { width: box['width'] as number, height: box['height'] as number });
                return;
            }
            if (method === 'ui.setSearchNeedle') {
                const paneID = pane(args['paneID']);
                const needle = paneSearchNeedle(args['text']);
                if (needle === null)
                    throw new Error(
                        `A needle is a single line of at most ${String(PANE_SEARCH_LIMITS.needleChars)} characters.`
                    );
                actions.setNeedle(paneID, needle);
                return;
            }
            if (method === 'ui.setSearchCaseSensitive') {
                const on = args['on'];
                if (typeof on !== 'boolean') throw new Error('Case sensitivity is true or false.');
                actions.setCaseSensitive(pane(args['paneID']), on);
                return;
            }
            if (method === 'ui.searchNext') {
                actions.step(pane(args['paneID']), 'next');
                return;
            }
            if (method === 'ui.searchPrevious') {
                actions.step(pane(args['paneID']), 'prev');
                return;
            }
            actions.close(pane(args['paneID']));
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

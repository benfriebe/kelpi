/**
 * What a SELECTED presenter is told, and what it is allowed to do about it.
 *
 * One of these models exists per presented placement (`interaction.palette`,
 * `interaction.prompts`, `interaction.notifications`) and is granted to exactly one mounted view by
 * its host (`interaction/presenter-slot.tsx`), the way `plugins/chrome.ts` is granted to the
 * window's chrome view and `plugins/terminal.ts` to a pane's renderer.
 *
 * ── Why the projection is per placement ─────────────────────────────────────────────
 *
 * The three placements share one feed topic and nothing else. A palette presenter must not receive
 * another plugin's prompt bodies, a prompts presenter must not receive the command universe, and
 * neither of them is told about a notification, so the projection is built per placement and the
 * other arms are nulled out. `paletteOpen` is the one fact they all get: the palette outranks a
 * queued prompt, so a prompts presenter has to know it is standing down.
 *
 * ── What is withheld, and how ───────────────────────────────────────────────────────
 *
 *   - **`run` closures.** They never leave `features/palette-source.ts`; the surface publishes
 *     descriptors and takes an id back.
 *   - **`pluginID` of any owner.** `InteractionOwner` keeps it on the internal record
 *     (`contract.ts`); a presenter gets `surface.ownerRef(id)` plus `displayName`, which is what
 *     the bundled presenter already renders.
 *   - **Password inputs.** `UIInputOptions.password` prompts are ALWAYS presented by the bundled
 *     presenter, whatever is selected: `prompt` is null for them while `queued` still counts them,
 *     and `respondInteraction` refuses an id the projection did not publish. A replaceable surface
 *     that could render (or answer) another plugin's credential prompt is a harvesting surface no
 *     other slot has. This is the sibling of the destructive-confirmation carve-out.
 *   - **Notifications, from the other two placements.** A prompts presenter presents the three
 *     MODAL kinds - quick pick, input, dialog - and nothing else, and a palette presenter presents
 *     a session, so `notifications` is empty in both of those projections and populated only on
 *     `interaction.notifications`. A toast is not modal: it is a corner box over a window that
 *     stays usable, which is a different frame with different geometry, so it is its own placement
 *     and its own selection rather than a field that quietly appears in somebody else's.
 *   - **Native toasts.** `ui.toasts` in the store - a daemon notification, a command failure, a
 *     presenter failure - is host chrome, drawn by `App`'s `ToastStack`, and is never projected.
 *     Only a plugin's own `ui.showNotification` request reaches a presenter.
 *   - **Everything else by construction.** The top level of every frame is copied FIELD BY FIELD,
 *     never by spread, so a field added to `InteractionSnapshot` later cannot leak by omission;
 *     and `pluginJSON` round-trips the result, so a presenter never holds a host object at all.
 *
 * ── Two layers, independently ───────────────────────────────────────────────────────
 *
 * Every rule below is enforced here BEFORE the surface is touched, and the surface re-validates
 * on its own account (`palette.activate` re-resolves against a fresh read; `answer` re-checks
 * visibility and runs `validateInteractionAnswer`). A bug in one layer is then not a hole.
 */

import { pluginJSON, type JsonObject } from '@kelpi/protocol';

import {
    INTERACTION_LIMITS,
    type InteractionPaletteItem,
    type InteractionPaletteScope,
    type InteractionPlacement
} from './contract';
import type { InteractionSurface } from './surface';
import type {
    UIDialogOptions,
    UIInputOptions,
    UINotificationOptions,
    UIQuickPickOptions
} from '../../../plugin-sdk/ui.js';

/**
 * The eight `ui.*` methods a granted presenter may send. `ui.getInteraction` is a READ, answered
 * by `getInteraction()`; the other seven are calls, answered by `call()`.
 */
export const INTERACTION_UI_METHODS = [
    'ui.getInteraction',
    'ui.reportPresenterReady',
    'ui.setPaletteQuery',
    'ui.setPaletteSelection',
    'ui.activatePaletteItem',
    'ui.dismissPalette',
    'ui.respondInteraction',
    'ui.setNotificationBoxHeight'
] as const;

// ── the DTOs ────────────────────────────────────────────────────────────────────────
//
// These are the host's own declaration of the presenter-facing shapes. `packages/plugin-sdk`
// declares the same shapes for plugin authors, exactly as `chrome.d.ts` does for `ChromeSnapshot`;
// the two are kept in step by `plugin-sdk/interaction.typecheck.ts` and the SDK feed tests.

/** Who asked. An opaque window-local ref plus a display name; never a plugin ID. */
export interface InteractionOwnerRef {
    readonly ref: string;
    readonly displayName: string;
}

export interface InteractionPresenterPaletteSession {
    /** Minted on open. Every session-scoped call is checked against it. */
    readonly sessionID: string;
    readonly query: string;
    readonly scope: InteractionPaletteScope;
    /** The whole universe; the presenter applies the matching rule itself. */
    readonly items: readonly InteractionPaletteItem[];
    readonly selectedID: string | null;
    /** The primary grid shows a secondary daemon; mirrors `ChromeSnapshot.remoteWorkspaceSelected`. */
    readonly remoteWorkspaceSelected: boolean;
}

export type InteractionPresenterPrompt = { readonly requestID: string; readonly owner: InteractionOwnerRef } & (
    | { readonly kind: 'quickPick'; readonly options: UIQuickPickOptions }
    | { readonly kind: 'input'; readonly options: UIInputOptions }
    | { readonly kind: 'dialog'; readonly options: UIDialogOptions }
);

/** One plugin notification, as the `interaction.notifications` presenter sees it. */
export interface InteractionPresenterNotice {
    readonly requestID: string;
    readonly owner: InteractionOwnerRef;
    readonly options: UINotificationOptions;
}

export interface InteractionPresenterSnapshot {
    readonly placement: InteractionPlacement;
    /** Plugin presenters are desktop-only in this release; a phone window never selects one. */
    readonly formFactor: 'desktop' | 'phone';
    /** Whether this placement is painted right now. False means present nothing. */
    readonly visible: boolean;
    /** The palette presenter only; null on `interaction.prompts`, and null while closed. */
    readonly palette: InteractionPresenterPaletteSession | null;
    /** Both placements: the palette outranks a queued prompt. */
    readonly paletteOpen: boolean;
    /** The prompts presenter only; null on `interaction.palette`, and null for a password input. */
    readonly prompt: InteractionPresenterPrompt | null;
    /**
     * `interaction.prompts`: modal requests waiting behind `prompt`, a withheld password input
     * included. `interaction.notifications`: visible notices this frame could not carry, because
     * four maximal ones do not fit in 256 KiB; they keep their ids and their clocks and arrive in a
     * later frame. Zero on `interaction.palette`.
     */
    readonly queued: number;
    /**
     * The `interaction.notifications` presenter only: the visible plugin notifications, oldest
     * first, at most `INTERACTION_LIMITS.notifications` of them. Empty on the other two placements,
     * where the field means "not my business" rather than "none right now".
     */
    readonly notifications: readonly InteractionPresenterNotice[];
}

// ── the host model ──────────────────────────────────────────────────────────────────

export interface InteractionPresenterHost {
    readonly placement: InteractionPlacement;
    /** The current frame: frozen, `pluginJSON`-checked and bounded at 256 KiB. */
    getInteraction(): InteractionPresenterSnapshot;
    subscribe(
        listener: (value: InteractionPresenterSnapshot) => void,
        onError?: (error: Error) => void
    ): () => void;
    /** The seven mutating methods. `ui.getInteraction` is read through `getInteraction()`. */
    call(method: string, args: JsonObject): void | Promise<void>;
    /** The feed's ack, so the watchdog can tell a live presenter from a wedged one. */
    noteAcknowledged(): void;
    /**
     * Re-read the host's own paint decision and republish if the frame moved. The surface's
     * subscription covers everything the surface owns; `visible` and `formFactor` are the host's,
     * and they move on a React render nothing in the surface hears about.
     */
    refresh(): void;
    dispose(): void;
}

export interface InteractionPresenterHostOptions {
    readonly surface: InteractionSurface;
    readonly placement: InteractionPlacement;
    readonly formFactor: () => 'desktop' | 'phone';
    /** The host's paint decision for this placement, read afresh on every frame. */
    readonly visible: () => boolean;
    /** A presenter that cannot be trusted with the surface any more (a runaway call loop). */
    readonly fail: (detail: string) => void;
    /**
     * A frame left for the presenter. `awaitsAcknowledgement` marks a frame carrying a new prompt,
     * a new palette session or a notification that was not in the previous frame - the frames whose
     * acknowledgement the watchdog waits for.
     */
    readonly onFrame?: ((awaitsAcknowledgement: boolean) => void) | undefined;
    readonly onAcknowledged?: (() => void) | undefined;
    readonly onReady?: (() => void) | undefined;
    /**
     * `interaction.notifications`: the height in CSS pixels the presenter says its stack needs,
     * unclamped. The mount applies `notificationBoxHeight` and paints the box; the model only
     * carries the declaration, because the ceiling is a fraction of a window the model cannot see.
     */
    readonly onBoxHeight?: ((pixels: number) => void) | undefined;
}

/**
 * How tall the notifications frame is actually painted.
 *
 * `declared` is the presenter's own `setNotificationBoxHeight`, or null before it has said
 * anything, in which case the host budgets `noticeBoxPx` per visible notice so the very first
 * frame is drawn into a box with room in it.
 *
 * The result is clamped to [0, min(`noticeBoxFraction` of the window, one `noticeBoxMaxPx` per
 * VISIBLE notice)]. Both ceilings matter and the second is the one that ties the box to content: a
 * presenter is a plugin like any other, so it can raise its own notification every ten seconds and
 * hold the box open indefinitely, and a box bigger than what it is drawing is a transparent rect
 * that swallows clicks and parks the panes under it - over the native toast stack included, which
 * shares `z-40` with this box and carries the failure toast for a broken presenter. An empty stack
 * gets zero, which is also when the host paints no frame at all.
 */
export function notificationBoxHeight(declared: number | null, notices: number, windowHeight: number): number {
    const visible = Math.max(0, notices);
    const ceiling = Math.min(
        Math.max(0, Math.floor(windowHeight * INTERACTION_LIMITS.noticeBoxFraction)),
        visible * INTERACTION_LIMITS.noticeBoxMaxPx
    );
    const wanted = declared ?? visible * INTERACTION_LIMITS.noticeBoxPx;
    return Math.min(Math.max(0, Math.round(wanted)), ceiling);
}

/**
 * The frame's own byte budget, measured the way `pluginJSON` measures it.
 *
 * The projection carries up to `INTERACTION_LIMITS.notifications` notices, and the request funnel
 * caps each REQUEST at 256 KiB rather than the frame that later carries four of them. The option
 * limits are CHARACTER limits (2,048 of message, 8,192 of detail, eight actions), and JSON expands
 * a control character or a lone surrogate to six bytes, so a maximal notice serializes to about
 * 77 KiB and four of them to about 303 KiB - past the cap. An oversized frame is undeliverable,
 * and an undeliverable frame with live work in it FAILS the placement, which would latch the
 * user's chosen presenter out and leave Retry re-failing until the notices expired. So the frame
 * is bounded instead: it carries the notices that fit, in visible order, and says how many it
 * could not carry.
 */
const NOTICE_FRAME_BUDGET = INTERACTION_LIMITS.payloadBytes - INTERACTION_LIMITS.noticeFrameMargin;
const frameEncoder = new TextEncoder();
const jsonBytes = (value: unknown): number => frameEncoder.encode(JSON.stringify(value)).byteLength;

/** Declared keys per call, so an unknown or missing argument is refused before anything runs. */
const CALL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'ui.reportPresenterReady': [],
    'ui.setPaletteQuery': ['sessionID', 'text'],
    'ui.setPaletteSelection': ['sessionID', 'itemID'],
    'ui.activatePaletteItem': ['sessionID', 'itemID'],
    'ui.dismissPalette': ['sessionID'],
    'ui.respondInteraction': ['requestID', 'value'],
    'ui.setNotificationBoxHeight': ['pixels']
});

const PLACEMENT_METHODS: Readonly<Record<InteractionPlacement, readonly string[]>> = Object.freeze({
    'interaction.palette': [
        'ui.getInteraction',
        'ui.reportPresenterReady',
        'ui.setPaletteQuery',
        'ui.setPaletteSelection',
        'ui.activatePaletteItem',
        'ui.dismissPalette'
    ],
    'interaction.prompts': ['ui.getInteraction', 'ui.reportPresenterReady', 'ui.respondInteraction'],
    // `respondInteraction` belongs to both request placements: a notification action is settled
    // exactly as a dialog action is, and the id check below is what keeps each to its own.
    'interaction.notifications': [
        'ui.getInteraction',
        'ui.reportPresenterReady',
        'ui.respondInteraction',
        'ui.setNotificationBoxHeight'
    ]
});

const EMPTY_NOTICES: readonly InteractionPresenterNotice[] = Object.freeze([]);

function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

/** A password input is the bundled presenter's, whatever is selected. */
function withheldFromPresenter(request: { readonly kind: string; readonly options: unknown }): boolean {
    return request.kind === 'input' && (request.options as UIInputOptions).password === true;
}

// ── the window's failure latch ──────────────────────────────────────────────────────
//
// A module-level store rather than a context or component state, for `chrome/modal-presence.ts`'s
// reason: the two readers are in different trees. The slot that mounts a presenter is inside the
// body portal (or the content row), and the Settings row that reports the failure and offers Retry
// is inside the Plugins tab; a provider above both would have to sit above every portal root.
// One store per page is one store per window, which is the scope the latch is defined at.

/** Which generation failed, and why. `generation` is `viewID:revision:instanceID`. */
export interface InteractionPresenterFailure {
    readonly generation: string;
    readonly detail: string;
}

type Failures = Readonly<Partial<Record<InteractionPlacement, InteractionPresenterFailure>>>;

let failures: Failures = Object.freeze({});
const failureListeners = new Set<() => void>();

function publishFailures(next: Failures): void {
    failures = Object.freeze(next);
    for (const listener of [...failureListeners]) listener();
}

/** Stable between changes, so a `useSyncExternalStore` reader cannot spin on it. */
export function interactionPresenterFailures(): Failures {
    return failures;
}

export function noteInteractionPresenterFailure(placement: InteractionPlacement, generation: string, detail: string): void {
    const current = failures[placement];
    if (current?.generation === generation) return;
    publishFailures({ ...failures, [placement]: Object.freeze({ generation, detail }) });
}

/** The explicit Retry, and the reload/rollback/selection paths that supersede a latch. */
export function clearInteractionPresenterFailure(placement: InteractionPlacement): void {
    if (failures[placement] === undefined) return;
    const next: Record<string, InteractionPresenterFailure> = { ...failures };
    delete next[placement];
    publishFailures(next);
}

export function subscribeInteractionPresenters(listener: () => void): () => void {
    failureListeners.add(listener);
    return () => {
        failureListeners.delete(listener);
    };
}

/** Test seam: one page is one window, so a suite has to be able to start from a clean one. */
export function resetInteractionPresenterFailures(): void {
    publishFailures({});
}

export function createInteractionPresenterHost(options: InteractionPresenterHostOptions): InteractionPresenterHost {
    const { surface, placement } = options;
    type Delivery = { value: InteractionPresenterSnapshot } | { error: Error };
    type Entry = { listener: (value: InteractionPresenterSnapshot) => void; onError?: (error: Error) => void };

    const listeners = new Set<Entry>();
    const calls: number[] = [];
    let disposed = false;
    let queued = false;
    let lastKey: string | undefined;
    let delivered: { requestID: string | null; sessionID: string | null; notices: readonly string[] } = {
        requestID: null,
        sessionID: null,
        notices: []
    };

    const ownerOf = (owner: { readonly id: string; readonly displayName: string }): InteractionOwnerRef => ({
        ref: surface.ownerRef(owner.id),
        displayName: owner.displayName
    });

    /** Field by field, every arm, so nothing new can ride along unnoticed. */
    const project = (): InteractionPresenterSnapshot => {
        const snapshot = surface.getSnapshot();
        const formFactor = options.formFactor();
        const visible = options.visible();
        const paletteOpen = snapshot.palette.open;
        if (placement === 'interaction.palette') {
            return {
                placement,
                formFactor,
                visible,
                palette:
                    paletteOpen && snapshot.palette.sessionID !== null
                        ? {
                              sessionID: snapshot.palette.sessionID,
                              query: snapshot.palette.query,
                              scope: snapshot.palette.scope,
                              items: snapshot.palette.items,
                              selectedID: snapshot.palette.selectedID,
                              remoteWorkspaceSelected: snapshot.palette.remoteWorkspaceSelected
                          }
                        : null,
                paletteOpen,
                prompt: null,
                queued: 0,
                notifications: EMPTY_NOTICES
            };
        }
        if (placement === 'interaction.notifications') {
            const frame = (
                notifications: readonly InteractionPresenterNotice[],
                queued: number
            ): InteractionPresenterSnapshot => ({
                placement,
                formFactor,
                visible,
                palette: null,
                paletteOpen,
                // A notification is not a modal request, so the visible prompt and the queue behind
                // it are not this presenter's business; `queued` counts what THIS placement is
                // holding back instead.
                prompt: null,
                queued,
                notifications
            });
            /*
             * Field by field, and then bounded by SIZE (see `NOTICE_FRAME_BUDGET`). Visible order is
             * kept and the first notice that does not fit stops the rest: a stack that reordered
             * itself around one big card would be a worse thing to look at than a short one, and a
             * withheld notice keeps its id, its clock and its place in the next frame.
             */
            const carried: InteractionPresenterNotice[] = [];
            let withheld = 0;
            let used = jsonBytes(frame(EMPTY_NOTICES, 0));
            for (const notice of snapshot.notifications) {
                const candidate = Object.freeze({
                    requestID: notice.id,
                    owner: ownerOf(notice.owner),
                    options: notice.options
                });
                // One comma per element beyond the first: the array's own separators.
                const size = jsonBytes(candidate) + 1;
                if (withheld > 0 || used + size > NOTICE_FRAME_BUDGET) {
                    withheld += 1;
                    continue;
                }
                used += size;
                carried.push(candidate);
            }
            return frame(Object.freeze(carried), withheld);
        }
        const active = snapshot.activeModal;
        const shown = active !== null && !withheldFromPresenter(active) ? active : null;
        return {
            placement,
            formFactor,
            visible,
            palette: null,
            paletteOpen,
            prompt:
                shown === null
                    ? null
                    : ({
                          requestID: shown.id,
                          owner: ownerOf(shown.owner),
                          kind: shown.kind,
                          options: shown.options
                      } as InteractionPresenterPrompt),
            // The withheld password input is still counted: a presenter that is told nothing at
            // all cannot explain to the user why it is standing down.
            queued: snapshot.queued + (active !== null && shown === null ? 1 : 0),
            notifications: EMPTY_NOTICES
        };
    };

    const read = (): Delivery => {
        try {
            const value = (
                pluginJSON({
                    type: 'interaction',
                    sequence: Number.MAX_SAFE_INTEGER,
                    value: project()
                }) as unknown as { value: InteractionPresenterSnapshot }
            ).value;
            return { value: freeze(value) };
        } catch {
            return { error: new Error('Window interaction snapshot is invalid or exceeds 256 KiB.') };
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
     * Live work is what an unacknowledged frame would strand: a visible prompt, an open palette,
     * or - on the notifications placement, which is told about none of those - a notice on screen
     * whose actions somebody is waiting on.
     */
    const hasLiveWork = (): boolean => {
        const snapshot = surface.getSnapshot();
        if (placement === 'interaction.notifications') return snapshot.notifications.length > 0;
        return snapshot.activeModal !== null || snapshot.palette.open;
    };

    const note = (next: Delivery): void => {
        if (!('value' in next)) {
            /*
             * An undeliverable frame is not something a watchdog can save. The SDK acknowledges an
             * `interaction-error` exactly as it acknowledges a frame, so arming the acknowledgement
             * timer here would be cleared by the presenter's own ack and the live request would be
             * stranded with nobody drawing it. So the placement fails NOW, which is what hands the
             * surface back to the bundled presenter with the request still pending under its id.
             */
            if (hasLiveWork()) options.fail(next.error.message);
            else options.onFrame?.(false);
            return;
        }
        const requestID = next.value.prompt?.requestID ?? null;
        const sessionID = next.value.palette?.sessionID ?? null;
        const notices = next.value.notifications.map((notice) => notice.requestID);
        const awaits =
            (requestID !== null && requestID !== delivered.requestID) ||
            (sessionID !== null && sessionID !== delivered.sessionID) ||
            // A frame that ADDS a notice is waited for; one that only drops an expired notice is
            // not, or a presenter would be failed for a clock the host runs on its own.
            notices.some((id) => !delivered.notices.includes(id));
        delivered = { requestID, sessionID, notices };
        options.onFrame?.(awaits);
    };

    const update = (): void => {
        if (disposed || queued || listeners.size === 0) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (disposed || listeners.size === 0) return;
            const next = read();
            const nextKey = key(next);
            if (nextKey === lastKey) return;
            lastKey = nextKey;
            for (const entry of [...listeners]) deliver(entry, next);
            note(next);
        });
    };

    const unsubscribeSurface = surface.subscribe(update);

    /**
     * 240 calls per rolling second. A breach FAILS the presenter as well as rejecting the call:
     * a call loop is not a recoverable error, and the bundled surface has to be able to take the
     * window back from it.
     */
    const charge = (): void => {
        const now = Date.now();
        while (calls.length > 0 && now - calls[0]! >= INTERACTION_LIMITS.presenterCallWindowMs) calls.shift();
        calls.push(now);
        if (calls.length <= INTERACTION_LIMITS.presenterCalls) return;
        const message = 'This presenter exceeded its window interaction call budget.';
        options.fail(message);
        throw new Error(message);
    };

    const text = (value: unknown, message: string, maximum: number, empty = false): string => {
        if (typeof value !== 'string' || value.length > maximum || (!empty && value.length === 0))
            throw new Error(message);
        return value;
    };

    const session = (value: unknown): string => {
        const current = project();
        if (typeof value !== 'string' || current.palette === null || current.palette.sessionID !== value)
            throw new Error('This palette session is no longer open.');
        return value;
    };

    return {
        placement,
        getInteraction() {
            if (disposed) throw new Error('Interaction presentation is unavailable after disposal.');
            charge();
            const next = read();
            if ('error' in next) throw next.error;
            return next.value;
        },
        subscribe(listener, onError) {
            if (disposed) throw new Error('Interaction presentation is unavailable after disposal.');
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
            if (keys === undefined) throw new Error('Unknown window interaction method.');
            if (
                args === null ||
                typeof args !== 'object' ||
                Array.isArray(args) ||
                Object.keys(args).length !== keys.length ||
                keys.some((name) => !(name in args))
            )
                throw new Error('Invalid interaction arguments.');
            if (new TextEncoder().encode(JSON.stringify(args)).length > INTERACTION_LIMITS.payloadBytes)
                throw new Error('Interaction arguments exceed 256 KiB.');
            if (!PLACEMENT_METHODS[placement].includes(method))
                throw new Error('This method belongs to another interaction placement.');
            if (disposed) throw new Error('Interaction presentation is unavailable after disposal.');
            charge();

            if (method === 'ui.reportPresenterReady') {
                surface.presenterReady(placement);
                options.onReady?.();
                return;
            }
            if (method === 'ui.setPaletteQuery') {
                const id = session(args['sessionID']);
                surface.palette.setQuery(
                    id,
                    text(
                        args['text'],
                        `A palette query must be a string of at most ${String(INTERACTION_LIMITS.presenterQueryChars)} characters.`,
                        INTERACTION_LIMITS.presenterQueryChars,
                        true
                    )
                );
                return;
            }
            if (method === 'ui.setPaletteSelection') {
                const id = session(args['sessionID']);
                const itemID = args['itemID'];
                // The surface ignores an unknown id in silence; the bridge refuses it, so a
                // presenter learns that the row it selected is not in the published list.
                if (
                    itemID !== null &&
                    (typeof itemID !== 'string' ||
                        !(project().palette?.items ?? []).some((item) => item.id === itemID))
                )
                    throw new Error('That palette item is not in the current list.');
                surface.palette.setSelection(id, itemID);
                return;
            }
            if (method === 'ui.activatePaletteItem') {
                const id = session(args['sessionID']);
                // `surface.palette.activate` is the authority: a FRESH source read, an unknown,
                // disabled or vanished row refused, and the session closed before dispatch so a
                // row runs at most once.
                return surface.palette.activate(id, text(args['itemID'], 'Invalid interaction arguments.', 320));
            }
            if (method === 'ui.dismissPalette') {
                surface.palette.dismiss(session(args['sessionID']), 'user');
                return;
            }
            if (method === 'ui.setNotificationBoxHeight') {
                const pixels = args['pixels'];
                // Negative, NaN and infinite are refused outright; anything else is a declaration
                // the mount clamps (`notificationBoxHeight`), because the ceiling is a fraction of
                // a window this model cannot measure.
                if (typeof pixels !== 'number' || !Number.isFinite(pixels) || pixels < 0)
                    throw new Error('A notification box height must be a number of pixels, zero or more.');
                options.onBoxHeight?.(pixels);
                return;
            }
            const requestID = text(args['requestID'], 'This UI request is not visible.', 128);
            const value = args['value'];
            if (value !== null && typeof value !== 'string') throw new Error('A UI answer must be a string or null.');
            /*
             * A request this presenter was never shown - a queued one, a withheld password input,
             * another placement's, another window's - cannot be answered by guessing its id. The
             * two request placements check their own half of the published frame: a prompts
             * presenter may settle the visible prompt, a notifications presenter any notice in the
             * stack it was given, and neither may settle the other's.
             */
            const published = project();
            const visible =
                placement === 'interaction.notifications'
                    ? published.notifications.some((notice) => notice.requestID === requestID)
                    : requestID === published.prompt?.requestID;
            if (!visible) throw new Error('This UI request is not visible.');
            // `surface.answer` re-checks visibility and runs `validateInteractionAnswer`.
            surface.answer(requestID, value);
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
            unsubscribeSurface();
            listeners.clear();
        }
    };
}

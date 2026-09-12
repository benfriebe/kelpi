/**
 * One window, one interaction surface.
 *
 * Every modal question this window asks - a plugin's quick pick, input, dialog or notification,
 * and the command palette session - is raised, queued, validated, cancelled and answered here.
 * Before this module those authorities were two: `plugins/ui-services.ts` owned the prompt queue
 * and `chrome/CommandPalette.tsx` owned the palette's selection, activation and focus handoff.
 * Two authorities meant two answers to the same question, and the seam between them was a real
 * defect: a prompt queued behind the palette became visible on the tick the palette closed, and
 * the palette's 200 ms focus handoff - which nothing cancelled - then moved the caret into a pane
 * BEHIND the open prompt.
 *
 * What lives here:
 *   - the prompt queue (moved from `createUIServices`, behaviour for behaviour);
 *   - the palette session: open/toggle/dismiss/query/selection/activation;
 *   - the one read of "is a surface painted", which drives the host's single modal registration;
 *   - the focus authority's DECISIONS (`App`'s `handBackPaneCaret` stays the executor);
 *   - the read models the window's keyboard gates collapse onto.
 *
 * What does NOT live here: any JSX, any DOM measurement, any `run` closure. `InteractionHost`
 * owns the first two; `features/palette-source.ts` owns the third.
 *
 * Two things a reader should not mistake for dead code:
 *
 *   1. The presenter reports - `presenterReady`, `presenterStoodDown`, `presenterFailed` - are PER
 *      PLACEMENT and are all driven by one caller, `interaction/presenter-slot.tsx`. The surface
 *      does not know what is selected and must not: what it knows is what the mount told it, which
 *      is why `usesBundledPresenter` and `presenterState` are read models over those reports rather
 *      than answers derived from the workbench. The palette arm of a failure additionally dismisses
 *      the session (§2.7); the prompts arm must NOT, or a prompts presenter failing would close a
 *      palette the user is still reading. `palette.setSelection` and the snapshot's `selectedID`
 *      stay host-held so a replaceable presenter never owns the selection, which is as true of the
 *      bundled path - it simply never fails.
 *   2. `palette.open` returning null is SILENT on purpose. A palette raised over a visible prompt
 *      is refused (the prompt owns the window), and the gesture that raised it - a chord the
 *      dispatcher was already standing down for, a menu row, a chrome command - is not a failure
 *      the user asked about. A toast there would fire on every stray key press behind a dialog.
 */

import { modalPresenceCount } from '../chrome/modal-presence';
import { parsePaletteQuery } from '../chrome/palette';
import {
    INTERACTION_HANDOFF_MS,
    INTERACTION_LIMITS,
    INTERACTION_PLACEMENTS,
    interactionPaletteItem,
    normalizeInteractionOwner,
    validateInteractionAnswer,
    validateInteractionOptions,
    type InteractionDismissReason,
    type InteractionModalRequest,
    type InteractionNotification,
    type InteractionOwner,
    type InteractionOwnerInput,
    type InteractionPaletteItem,
    type InteractionPlacement,
    type InteractionPaletteSnapshot,
    type InteractionPaletteSource,
    type InteractionRequest,
    type InteractionSnapshot,
    type JsonValue
} from './contract';

/** `features/palette-source.ts`'s shape, named the way that module names it. */
export type PaletteFeatureSource = InteractionPaletteSource;

/**
 * Where the palette's open/query bit is stored. `state/store.ts` keeps owning `ui.palette`; the
 * surface becomes its ONLY writer, through these four accessors, so nothing has to move and
 * nothing else can write it.
 */
export interface InteractionPaletteState {
    isOpen(): boolean;
    getQuery(): string;
    setOpen(open: boolean): void;
    setQuery(query: string): void;
}

/**
 * The focus authority's two executors. The surface decides WHEN; `App` still decides HOW, because
 * handing a caret back is a composition of pane focus, the phone's keyboard rule and a web pane's
 * native view (`App`'s `handBackPaneCaret`).
 */
export interface InteractionFocusHost {
    /** The active workspace's focused pane - the handoff target for every dismiss path. */
    fallbackPaneID(): string | null;
    /** Immediately: `handBackPaneCaret(paneID)`. */
    handBackCaret(paneID: string | null): void;
    /** After the delay: `App`'s `onFocusHandoff` resolution (focused pane wins over the capture). */
    paneHandoff(paneID: string | null): void;
    readonly handoffDelayMs?: number | undefined;
}

export interface InteractionSurfaceConfig {
    /** Must be identity-stable: a new object resubscribes and republishes. */
    readonly palette?: InteractionPaletteSource | null | undefined;
    readonly paletteState?: InteractionPaletteState | undefined;
    readonly focus?: InteractionFocusHost | undefined;
    readonly remoteWorkspaceSelected?: (() => boolean) | undefined;
    readonly reportFailure?: ((label: string, detail: string) => void) | undefined;
}

export interface InteractionScope {
    readonly id: string;
    request(method: string, args: unknown): Promise<JsonValue>;
    dispose(): void;
}

export interface InteractionPaletteSession {
    /** Returns the new session id, or null when a visible prompt owns the window. */
    open(owner: InteractionOwnerInput, options?: { readonly query?: string | undefined }): string | null;
    toggle(owner: InteractionOwnerInput): string | null;
    dismiss(sessionID: string, reason: InteractionDismissReason): void;
    setQuery(sessionID: string, text: string): void;
    setSelection(sessionID: string, itemID: string | null): void;
    /** Re-resolves the id against a fresh source read and runs it AT MOST once. */
    activate(sessionID: string, itemID: string): Promise<void>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): InteractionPaletteSnapshot;
    setSource(source: InteractionPaletteSource | null): void;
}

export interface InteractionPresenterStatus {
    readonly failed: boolean;
    readonly detail: string | null;
}

export interface InteractionSurface {
    createScope(owner: InteractionOwnerInput): InteractionScope;
    getSnapshot(): InteractionSnapshot;
    subscribe(listener: () => void): () => void;
    answer(requestID: string, value: string | null): void;
    readonly palette: InteractionPaletteSession;

    /** Which surface is painted right now - the host registers exactly one modal for either. */
    visibleSurface(): 'palette' | 'prompt' | null;
    /** The host reports its own `modal-presence` registration so the surface can discount it. */
    noteHostRegistration(held: boolean): void;

    /** Any window-owned gesture (shortcut, plugin chord, terminal chord, menu) stands down. */
    blocksWindowInput(): boolean;
    /** A prompt owns the window - visible, or queued behind a native modal. */
    hasActiveModal(): boolean;
    /** Close the palette; failing that, cancel the active prompt. */
    dismissTopmost(): boolean;

    /** The selected presenter for this placement has painted; it owns the surface from now on. */
    presenterReady(placement: InteractionPlacement): void;
    /**
     * This placement's presenter is broken. The live request is never settled and never gets a
     * non-null result: it keeps its id and the bundled presenter re-presents it.
     */
    presenterFailed(placement: InteractionPlacement, detail?: string): void;
    /**
     * This placement fell back to the bundled surface for a reason that is NOT a failure: the phone,
     * no selection, a missing/disabled/failed plugin, a dropped connection. Reported so the read
     * model below is honest about who is drawing even when nothing went wrong.
     */
    presenterStoodDown(placement: InteractionPlacement): void;
    /**
     * Is the bundled surface the one drawing this placement right now?
     *
     * A read model over what the mount REPORTED, not over the selection: the surface deliberately
     * knows nothing about the workbench, so `interaction/presenter-slot.tsx` is what tells it a
     * presenter has painted, stood down or failed.
     */
    usesBundledPresenter(placement: InteractionPlacement): boolean;
    /**
     * Does a modal peer (Settings, Help, the create sheet, a context menu) hold the window besides
     * this window's own interaction host? The palette arm needs it: a palette may be opened OVER a
     * peer - that is its recovery route - so a presenter drawing it must not then trap the caret
     * inside its own frame and away from the page that peer is showing.
     */
    hasModalPeer(): boolean;
    /** Test, Settings and diagnostics seam: which placement is failed, and why. */
    presenterState(): Readonly<Record<InteractionPlacement, InteractionPresenterStatus>>;
    /**
     * The opaque, window-local identity of one owner, minted lazily and stable for the window's
     * life. Never derived from a plugin id, a display name or the view nonce - that nonce is the
     * value in this view's `kelpi-plugin-connect` handshake, so a presenter holding it could
     * correlate a prompt's owner with a `postMessage` it observes.
     */
    ownerRef(ownerID: string): string;

    hasPendingPaneHandoff(): boolean;
    cancelPaneHandoff(): void;
    /** Release precedence (c): nothing to restore, so the focused pane takes the caret. */
    handBackFallbackCaret(): void;
    fallbackPaneID(): string | null;

    dispose(): void;
}

const EMPTY_ITEMS: readonly InteractionPaletteItem[] = Object.freeze([]);
const EMPTY_NOTIFICATIONS: readonly InteractionNotification[] = Object.freeze([]);

/** A window owns one surface; each attached view receives a separately disposable scope. */
export function createInteractionSurface(config: InteractionSurfaceConfig = {}): InteractionSurface {
    type Pending = {
        request: InteractionRequest;
        resolve: (value: JsonValue) => void;
        timer?: ReturnType<typeof setTimeout>;
    };
    const pending = new Map<string, Pending>();
    const scopes = new Map<string, InteractionOwner>();
    const listeners = new Set<() => void>();
    let sequence = 0;
    let sessionSequence = 0;
    let disposed = false;

    // Without an injected store the surface keeps its own cell, with the store's own semantics:
    // closing clears the query (`state/store.ts` ▸ `setPaletteOpen`).
    const cell = { open: false, query: '' };
    const paletteState: InteractionPaletteState = config.paletteState ?? {
        isOpen: () => cell.open,
        getQuery: () => cell.query,
        setOpen: (open: boolean) => {
            cell.open = open;
            if (!open) cell.query = '';
        },
        setQuery: (query: string) => {
            cell.query = query;
        }
    };

    // Set only through `palette.setSource` below, never assigned straight from the config: a source
    // that was stored without being SUBSCRIBED to is a palette that never hears about a plugin
    // enabling, a `when` flipping, or a workspace arriving while the list is on screen.
    let source: InteractionPaletteSource | null = null;
    let unsubscribeSource: (() => void) | null = null;
    let sourceItems: readonly InteractionPaletteItem[] = EMPTY_ITEMS;
    let sessionID: string | null = null;
    let selectedID: string | null = null;
    let hostHoldsModal = false;
    /**
     * Per placement, because the two are selected independently: a prompts presenter failing must
     * not dismiss a palette session the user is still reading.
     */
    const presenters = new Map<InteractionPlacement, { ready: boolean; failed: boolean; detail: string | null }>(
        INTERACTION_PLACEMENTS.map((placement) => [placement, { ready: false, failed: false, detail: null }])
    );
    let presenterStatus: Readonly<Record<InteractionPlacement, InteractionPresenterStatus>> | null = null;
    /**
     * Owner refs. Minted lazily and kept, so two prompts from one view can be badged together.
     * Pruned only when the map has grown past every plausible live owner (a view that is attached
     * and detached repeatedly mints a fresh scope id each time), and then only for owners that are
     * neither an attached scope nor holding a pending request.
     */
    const ownerRefs = new Map<string, string>();
    let ownerSequence = 0;
    let handoff: { timer: ReturnType<typeof setTimeout>; paneID: string | null } | null = null;
    /**
     * One-shot: the close chord released the caret itself, so the host's release precedence (c),
     * which runs a commit later on the same close, must not hand the same pane its caret twice.
     * Cleared whenever a surface is painted again, so it can never swallow a later release.
     */
    let caretReleased = false;

    let snapshot: InteractionSnapshot = Object.freeze({
        activeModal: null,
        queued: 0,
        notifications: EMPTY_NOTIFICATIONS,
        palette: Object.freeze({
            sessionID: null,
            open: false,
            query: '',
            scope: 'all' as const,
            items: EMPTY_ITEMS,
            selectedID: null,
            remoteWorkspaceSelected: false
        })
    });

    const remoteSelected = (): boolean => config.remoteWorkspaceSelected?.() ?? false;

    /**
     * Rebuilds the cached snapshot. Deliberately side-effect free apart from the session id it
     * tracks: `getSnapshot` calls it during render when the store's palette bit moved under us,
     * and a rebuild that allocated a new value every call would spin `useSyncExternalStore`.
     */
    const rebuild = (): void => {
        const all = [...pending.values()].map((entry) => entry.request);
        const modals = all.filter((request): request is InteractionModalRequest => request.kind !== 'notification');
        const notifications = all
            .filter((request): request is InteractionNotification => request.kind === 'notification')
            .slice(0, INTERACTION_LIMITS.notifications);
        const open = paletteState.isOpen();
        // The session id tracks `open` in both directions, so a window that opened the palette
        // through the store alone (the pre-wiring path) still describes a coherent session.
        if (open && sessionID === null) {
            sessionSequence += 1;
            sessionID = `palette-${sessionSequence}`;
        }
        if (!open && sessionID !== null) {
            sessionID = null;
            selectedID = null;
        }
        const query = paletteState.getQuery();
        snapshot = Object.freeze({
            activeModal: modals[0] ?? null,
            queued: Math.max(0, modals.length - 1),
            notifications: Object.freeze(notifications),
            palette: Object.freeze({
                sessionID,
                open,
                query,
                scope: parsePaletteQuery(query).scope,
                items: open ? sourceItems : EMPTY_ITEMS,
                selectedID,
                remoteWorkspaceSelected: remoteSelected()
            })
        });
    };

    const finish = (id: string, value: string | null): void => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(value);
    };

    /** A visible notification's 10 s timer starts when it ENTERS the visible stack, not before. */
    const armTimers = (): void => {
        for (const notification of snapshot.notifications) {
            const entry = pending.get(notification.id);
            if (entry === undefined) continue;
            entry.timer ??= setTimeout(() => {
                finish(notification.id, null);
                publish();
            }, INTERACTION_LIMITS.notificationMs);
        }
    };

    const publish = (): void => {
        rebuild();
        armTimers();
        for (const listener of [...listeners])
            try {
                listener();
            } catch {
                listeners.delete(listener);
            }
    };

    const getSnapshot = (): InteractionSnapshot => {
        if (
            snapshot.palette.open !== paletteState.isOpen() ||
            snapshot.palette.query !== paletteState.getQuery() ||
            snapshot.palette.remoteWorkspaceSelected !== remoteSelected()
        ) {
            /*
             * The drift branch: something wrote `ui.palette` without coming through the session.
             * Re-read the feed before rebuilding, or a palette opened that way paints an EMPTY
             * universe. Only ever reached when a value actually moved, so it cannot allocate a
             * fresh snapshot on every render and spin `useSyncExternalStore`.
             */
            readSource();
            rebuild();
        }
        return snapshot;
    };

    // ── focus authority ─────────────────────────────────────────────────────────────

    const fallbackPaneID = (): string | null => config.focus?.fallbackPaneID() ?? null;
    const cancelPaneHandoff = (): void => {
        if (handoff === null) return;
        clearTimeout(handoff.timer);
        handoff = null;
    };
    const schedulePaneHandoff = (paneID: string | null): void => {
        cancelPaneHandoff();
        const focus = config.focus;
        if (focus === undefined) return;
        const timer = setTimeout(() => {
            handoff = null;
            focus.paneHandoff(paneID);
        }, focus.handoffDelayMs ?? INTERACTION_HANDOFF_MS);
        handoff = { timer, paneID };
    };

    // ── modal coordination ──────────────────────────────────────────────────────────

    const externalModalCount = (): number => modalPresenceCount() - (hostHoldsModal ? 1 : 0);
    const visibleSurface = (): 'palette' | 'prompt' | null => {
        if (disposed) return null;
        if (paletteState.isOpen()) return 'palette';
        // §2.3: a prompt waits behind any native modal peer (Settings, Help, the create sheet).
        if (getSnapshot().activeModal !== null && externalModalCount() <= 0) return 'prompt';
        return null;
    };

    const report = (detail: string): void => config.reportFailure?.('Command palette', detail);
    // Explicitly annotated so a `refuse(...)` call narrows what follows it.
    const refuse: (message: string) => never = (message) => {
        report(message);
        throw new Error(message);
    };

    // ── the palette session ─────────────────────────────────────────────────────────

    const closeSession = (): void => {
        selectedID = null;
        sessionID = null;
        paletteState.setOpen(false);
    };
    const currentSessionID = (): string | null => getSnapshot().palette.sessionID;
    const isCurrent = (id: string): boolean => !disposed && paletteState.isOpen() && currentSessionID() === id;

    const readSource = (): void => {
        sourceItems =
            source !== null && paletteState.isOpen()
                ? Object.freeze(source.snapshot().items.map(interactionPaletteItem))
                : EMPTY_ITEMS;
    };

    const openPalette = (
        rawOwner: InteractionOwnerInput,
        options?: { readonly query?: string | undefined }
    ): string | null => {
        if (disposed) return null;
        // The owner is normalized for its validation side effect: a malformed native owner must
        // fail at the call site, not silently open an ownerless session.
        normalizeInteractionOwner(rawOwner);
        // §2.3: opening the palette over a VISIBLE prompt is refused centrally.
        if (visibleSurface() === 'prompt') return null;
        cancelPaneHandoff();
        paletteState.setOpen(true);
        if (options?.query !== undefined) paletteState.setQuery(options.query);
        readSource();
        publish();
        return currentSessionID();
    };

    const dismissPalette = (id: string, reason: InteractionDismissReason): void => {
        if (!isCurrent(id)) return;
        const pane = fallbackPaneID();
        closeSession();
        readSource();
        publish();
        // §10.4: every dismiss path hands the caret back, so the window is never left without it.
        if (reason !== 'window-disposed') schedulePaneHandoff(pane);
    };

    const palette: InteractionPaletteSession = {
        open: openPalette,
        toggle(rawOwner) {
            if (paletteState.isOpen()) {
                const id = currentSessionID();
                if (id !== null) dismissPalette(id, 'user');
                return null;
            }
            return openPalette(rawOwner);
        },
        dismiss: dismissPalette,
        setQuery(id, value) {
            if (!isCurrent(id)) return;
            if (typeof value !== 'string') throw new Error('A palette query must be a string.');
            paletteState.setQuery(value);
            // A new query means a new match list; the presenter re-derives the default row.
            selectedID = null;
            publish();
        },
        setSelection(id, itemID) {
            if (!isCurrent(id)) return;
            if (itemID !== null && !sourceItems.some((item) => item.id === itemID)) return;
            selectedID = itemID;
            publish();
        },
        async activate(id, itemID) {
            if (!isCurrent(id)) refuse('This palette session is no longer open.');
            const feed = source;
            if (feed === null) refuse('The command palette has no source in this window.');
            // A FRESH read, not the published descriptors: a workspace or pane that vanished
            // while the list was on screen must not be activatable from a stale mirror.
            const item = feed.snapshot().items.find((entry) => entry.id === itemID);
            if (item === undefined) refuse('That palette item is no longer available.');
            if (item.disabled === true) refuse('That palette item is disabled.');
            const target = { workspaceID: item.workspaceID, paneID: item.paneID };
            closeSession();
            readSource();
            publish();
            schedulePaneHandoff(item.paneID ?? fallbackPaneID());
            try {
                await feed.execute(itemID, target);
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                report(detail);
                throw error;
            }
        },
        subscribe(listener) {
            if (disposed) return () => {};
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => getSnapshot().palette,
        setSource(next) {
            unsubscribeSource?.();
            unsubscribeSource = null;
            source = next;
            if (next !== null) {
                unsubscribeSource = next.subscribe(() => {
                    // The source tracks the daemon mirror, which moves constantly; a closed
                    // palette has nothing to re-publish.
                    if (!paletteState.isOpen()) return;
                    readSource();
                    publish();
                });
            }
            readSource();
            publish();
        }
    };

    // A feed handed in at construction takes the same path as one arriving later, subscription
    // included. `useInteractionSurface` uses the setter instead, because `App` only has the feed a
    // render later than the surface.
    if (config.palette !== undefined && config.palette !== null) palette.setSource(config.palette);

    const answer = (id: string, value: string | null): void => {
        const request = pending.get(id)?.request;
        if (!request) return;
        const current = getSnapshot();
        if (id !== current.activeModal?.id && !current.notifications.some((entry) => entry.id === id))
            throw new Error('This UI request is not visible.');
        validateInteractionAnswer(request, value);
        finish(id, value);
        publish();
    };

    return {
        getSnapshot,
        subscribe(listener) {
            if (disposed) return () => {};
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        palette,
        answer,
        createScope(rawOwner) {
            if (disposed) throw new Error('Window UI has been disposed.');
            const owner = normalizeInteractionOwner(rawOwner);
            if (scopes.has(owner.id)) throw new Error('UI scope already exists.');
            if (scopes.size >= INTERACTION_LIMITS.scopes) throw new Error('Too many UI scopes in this window.');
            scopes.set(owner.id, owner);
            let closed = false;
            return {
                id: owner.id,
                async request(method, args) {
                    if (closed || disposed) throw new Error('This view no longer owns window UI.');
                    const mine = [...pending.values()].filter((entry) => entry.request.owner.id === owner.id).length;
                    // §2.1: a native owner is exempt from the per-scope limit - the window's own
                    // verbs are not a plugin competing for capacity - never from the window's.
                    if (
                        pending.size >= INTERACTION_LIMITS.windowPending ||
                        (owner.kind === 'plugin' && mine >= INTERACTION_LIMITS.scopePending)
                    )
                        throw new Error('Too many pending window UI requests.');
                    const parsed = validateInteractionOptions(method, args);
                    if (new TextEncoder().encode(JSON.stringify(parsed)).length > INTERACTION_LIMITS.payloadBytes)
                        throw new Error('Window UI request exceeds 256 KiB.');
                    const id = `ui-${++sequence}`;
                    const request = Object.freeze({ ...parsed, id, owner }) as InteractionRequest;
                    return new Promise<JsonValue>((resolve) => {
                        pending.set(id, { request, resolve });
                        publish();
                    });
                },
                dispose() {
                    if (closed) return;
                    closed = true;
                    scopes.delete(owner.id);
                    for (const entry of pending.values())
                        if (entry.request.owner.id === owner.id) finish(entry.request.id, null);
                    publish();
                }
            };
        },

        visibleSurface,
        noteHostRegistration(held) {
            hostHoldsModal = held;
            // Defect (2): a queued prompt becoming visible must kill the palette's pending pane
            // handoff, or the caret lands in a pane BEHIND the prompt 200 ms later.
            if (held) {
                cancelPaneHandoff();
                caretReleased = false;
            }
        },

        blocksWindowInput: () => paletteState.isOpen() || getSnapshot().activeModal !== null,
        hasActiveModal: () => getSnapshot().activeModal !== null,
        dismissTopmost() {
            const current = getSnapshot();
            if (current.palette.open) {
                // The close chord's hand-back is IMMEDIATE (it is a keyboard gesture answering
                // for the window), unlike the presenter's own 200 ms dismiss handoff.
                const pane = fallbackPaneID();
                cancelPaneHandoff();
                closeSession();
                readSource();
                publish();
                config.focus?.handBackCaret(pane);
                caretReleased = true;
                return true;
            }
            if (current.activeModal !== null) {
                answer(current.activeModal.id, null);
                return true;
            }
            return false;
        },

        presenterReady(placement) {
            const state = presenters.get(placement);
            if (state === undefined || (state.ready && !state.failed)) return;
            state.ready = true;
            state.failed = false;
            state.detail = null;
            presenterStatus = null;
            publish();
        },
        presenterFailed(placement, detail) {
            const state = presenters.get(placement);
            if (state !== undefined) {
                state.ready = false;
                state.failed = true;
                state.detail = detail ?? null;
                presenterStatus = null;
            }
            // A presenter failure never produces a non-null result and never settles a prompt:
            // the request keeps its id and is re-presented by the bundled presenter.
            //
            // §2.7: only the PALETTE arm dismisses the session. Activating nothing is the point -
            // a broken presenter must not be able to run a row on its way out - and the fallback
            // pane handoff still runs, so the window is never left without a caret.
            const id = placement === 'interaction.palette' ? currentSessionID() : null;
            if (id !== null) dismissPalette(id, 'presenter-failed');
            else publish();
            if (detail !== undefined) config.reportFailure?.('Interaction presenter', detail);
        },
        presenterStoodDown(placement) {
            const state = presenters.get(placement);
            if (state === undefined || !state.ready) return;
            state.ready = false;
            presenterStatus = null;
            publish();
        },
        // The bundled surface draws until a presenter says it has painted, and again from the
        // moment one fails or stands down.
        usesBundledPresenter: (placement) => !(presenters.get(placement)?.ready ?? false),
        hasModalPeer: () => externalModalCount() > 0,
        presenterState() {
            presenterStatus ??= Object.freeze(
                Object.fromEntries(
                    INTERACTION_PLACEMENTS.map((placement) => {
                        const state = presenters.get(placement);
                        return [placement, Object.freeze({ failed: state?.failed ?? false, detail: state?.detail ?? null })];
                    })
                )
            ) as Readonly<Record<InteractionPlacement, InteractionPresenterStatus>>;
            return presenterStatus;
        },
        ownerRef(ownerID) {
            const existing = ownerRefs.get(ownerID);
            if (existing !== undefined) return existing;
            if (ownerRefs.size >= INTERACTION_LIMITS.scopes * 8) {
                const live = new Set([...scopes.keys(), ...[...pending.values()].map((entry) => entry.request.owner.id)]);
                for (const id of [...ownerRefs.keys()]) if (!live.has(id)) ownerRefs.delete(id);
            }
            ownerSequence += 1;
            const ref = `owner-${String(ownerSequence)}`;
            ownerRefs.set(ownerID, ref);
            return ref;
        },

        hasPendingPaneHandoff: () => handoff !== null,
        cancelPaneHandoff,
        handBackFallbackCaret() {
            if (caretReleased) {
                caretReleased = false;
                return;
            }
            config.focus?.handBackCaret(fallbackPaneID());
        },
        fallbackPaneID,

        dispose() {
            if (disposed) return;
            disposed = true;
            cancelPaneHandoff();
            unsubscribeSource?.();
            unsubscribeSource = null;
            source = null;
            sourceItems = EMPTY_ITEMS;
            for (const id of [...pending.keys()]) finish(id, null);
            scopes.clear();
            ownerRefs.clear();
            if (paletteState.isOpen()) closeSession();
            sessionID = null;
            selectedID = null;
            publish();
            listeners.clear();
        }
    };
}

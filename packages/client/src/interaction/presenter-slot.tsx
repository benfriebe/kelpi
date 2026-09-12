/**
 * Where a selected presenter is actually mounted, and the four ways it stops being the one drawing.
 *
 * One component for both placements, because everything that keeps a window usable when a presenter
 * is NOT working is identical for the palette and the prompts: the same fallback conditions, the
 * same generation-keyed latch with an explicit Retry, the same two liveness watchdogs, the same
 * focus containment, and the same small chord grant. Only the geometry and the bundled child differ,
 * and both of those are the caller's (`InteractionHost`, `PaletteHost`).
 *
 * ── The recovery floor ──────────────────────────────────────────────────────────────
 *
 * The bundled presenter draws whenever ANY of these holds, checked in this order:
 *
 *   1. Presenters are disabled for this window (the phone, where the bundled palette owns the
 *      software-keyboard inset a presenter cannot read).
 *   2. There is no plugin selected for the placement - which also covers a plugin that is missing,
 *      disabled or `status === 'failed'`, because `viewRegistry` filters those out and
 *      `resolveSlot` then lands on the bundled default. The user's selection is RETAINED across
 *      all of it, exactly as `docs/plugins.md` promises for every other slot.
 *   3. The daemon connection is not up. A presenter behind PluginView's "Connecting to daemon…"
 *      placeholder would paint that inside the palette box.
 *   4. This generation has failed. `generation` is `viewID:revision:instanceID`, verbatim from
 *      `features/TerminalFeaturePane.tsx`, so a reload, a rollback or a different selection clears
 *      the latch by moving the generation; nothing else does except the explicit Retry in Settings.
 *
 * A failure never settles a request: the surface keeps it pending under the same id and the bundled
 * presenter re-presents it (`ModalRequest` is keyed on that id).
 *
 * ── Why two watchdogs ───────────────────────────────────────────────────────────────
 *
 * A prompt is a promise somebody is awaiting. A presenter that never paints, or that stops draining
 * its feed, leaves that promise unanswerable with no error anywhere - the failure mode the chrome
 * feed does not have, because a stale toolbar is merely stale. So: 5 s to report having painted
 * after its first frame, and 5 s to acknowledge a frame that carries a new prompt or a new palette
 * session. Either expiry fails the placement, which is to say it hands the surface back.
 *
 * ── Keys ────────────────────────────────────────────────────────────────────────────
 *
 * An Escape pressed inside an iframe never reaches the host document, so the relay is
 * `claimedChords`: the frame forwards exactly the chords it was granted and `PluginView`
 * re-dispatches them on the owner window, where `InteractionHost`'s capture-phase Escape listener
 * and the window's close-chord dispatcher see them. The grant is therefore a SMALL explicit list -
 * Escape, the rebindable `close_pane` chord, Recover Interface - and emphatically not
 * `allViewChords`: arrows, Enter, typing, filtering and the Tab trap are presenter-owned inside the
 * frame and need no relay at all.
 */

import { triggersForAction, type KeyBindingMap } from '@kelpi/core/config';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';

import { useModalPresenceCount } from '../chrome/modal-presence';
import { chordKeysForTrigger } from '../content/bridge';
import { getCurrentPlugins } from '../plugins/client';
import { PluginView } from '../plugins/PluginView';
import { resolveSlot } from '../plugins/registry';
import { useOptionalWorkbench } from '../plugins/Workbench';
import { INTERACTION_LIMITS, type InteractionPlacement } from './contract';
import {
    clearInteractionPresenterFailure,
    createInteractionPresenterHost,
    interactionPresenterFailures,
    noteInteractionPresenterFailure,
    subscribeInteractionPresenters,
    type InteractionPresenterHost
} from './presenter';
import type { InteractionSurface } from './surface';

/** No chords at all - what a slot with no grant passes, declared once for both mounts. */
export const NO_CHORDS: readonly string[] = [];

/**
 * Escape and the rebindable `close_pane` chord. Nothing else is relayed.
 *
 * Not View ▸ Recover Interface (⌃⌥⌘R), deliberately: it is a main-process accelerator the native
 * menu delivers whatever holds first responder, and its client half arrives as a `menu-command` over
 * the daemon connection, so there is no renderer listener a relayed key could reach. `App`'s own
 * content-frame grant omits it for the same reason.
 */
export function interactionPresenterChords(bindings: KeyBindingMap): readonly string[] {
    return [...new Set(['0/Escape', ...triggersForAction(bindings, 'close_pane').flatMap(chordKeysForTrigger)])].sort();
}

interface Watchdogs {
    ready: ReturnType<typeof setTimeout> | null;
    ack: ReturnType<typeof setTimeout> | null;
    /** Whether the readiness window has been opened for this generation yet. */
    armed: boolean;
    /** Whether this generation reported that it had painted. */
    painted: boolean;
    generation: string;
}

export interface InteractionPresenterSlotProps {
    readonly surface: InteractionSurface;
    readonly placement: InteractionPlacement;
    /** `App`: `!phoneActive`. False means the bundled presenter, always. */
    readonly enabled: boolean;
    /**
     * The host's paint decision for this placement. A painted presenter owns the caret too: both
     * surfaces are modal for as long as they are up, so there is no third state to express.
     */
    readonly visible: boolean;
    /**
     * This frame belongs to the bundled presenter even though one is selected - a password input.
     * The selected view stays MOUNTED and hidden, so the carve-out costs no reattachment.
     */
    readonly withheld?: boolean | undefined;
    readonly chords: readonly string[];
    readonly className?: string | undefined;
    /** Called immediately before the frame takes the caret, as `ModalRequest` does. */
    readonly captureFocus?: (() => void) | undefined;
    /**
     * Cancel this surface, for a placement whose bundled presenter answers Escape INSIDE itself
     * rather than through the host (the palette's card owns its own key handling, so
     * `InteractionHost`'s window listener only ever covers a prompt). Installed only while a
     * presenter is painted, so the bundled card is never double-handled.
     */
    readonly onEscape?: (() => void) | undefined;
    /** The bundled presenter. */
    readonly children: ReactNode;
}

export function InteractionPresenterSlot(props: InteractionPresenterSlotProps): ReactElement {
    const { surface, placement } = props;
    const workbench = useOptionalWorkbench();
    const runtime = workbench?.runtime ?? null;
    const wrapper = useRef<HTMLDivElement | null>(null);

    const selected = workbench ? resolveSlot(workbench.views, placement, workbench.selections[placement]) : undefined;
    const viewID = selected?.id ?? '';
    const plugin = runtime && selected?.pluginID ? getCurrentPlugins(runtime).find(item => item.manifest.id === selected.pluginID) : undefined;
    const generation = `${viewID}:${plugin?.revision ?? ''}:${plugin?.instanceID ?? ''}`;

    const [connection, setConnection] = useState(() => runtime?.connection.status ?? 'closed');
    useEffect(() => {
        if (!runtime) return;
        setConnection(runtime.connection.status);
        return runtime.connection.on('status', setConnection);
    }, [runtime]);

    const failures = useSyncExternalStore(subscribeInteractionPresenters, interactionPresenterFailures, interactionPresenterFailures);
    const latched = failures[placement]?.generation === generation;
    // Read so a peer arriving or leaving re-renders this slot; the surface subtracts the interaction
    // host's own registration from the same count.
    useModalPresenceCount();
    const peerModal = surface.hasModalPeer();

    const bundled = !props.enabled || !selected?.pluginID || !runtime || connection !== 'connected' || latched;
    const withheld = props.withheld === true;
    const painted = !bundled && !withheld && props.visible;

    /** Everything the model's stable callbacks need from the latest render. */
    const latest = useRef({ painted, generation, surface, placement, enabled: props.enabled });
    latest.current = { painted, generation, surface, placement, enabled: props.enabled };

    const fail = useCallback((detail: string): void => {
        const message = detail || 'The interaction presenter failed.';
        noteInteractionPresenterFailure(latest.current.placement, latest.current.generation, message);
        // The surface owns the consequences: the request stays pending under its id, the palette
        // arm dismisses its session with `presenter-failed`, and the toast is raised.
        latest.current.surface.presenterFailed(latest.current.placement, message);
    }, []);

    // ── the two watchdogs ───────────────────────────────────────────────────────────
    const watch = useRef<Watchdogs>({ ready: null, ack: null, armed: false, painted: false, generation });
    const clearWatchdogs = useCallback((): void => {
        if (watch.current.ready !== null) clearTimeout(watch.current.ready);
        if (watch.current.ack !== null) clearTimeout(watch.current.ack);
        watch.current = { ready: null, ack: null, armed: false, painted: false, generation: latest.current.generation };
    }, []);
    const onFrame = useCallback((awaitsAcknowledgement: boolean): void => {
        /*
         * The reset belongs HERE, not in an effect: a reload or a rollback re-creates the feed
         * inside `PluginView`, whose effect runs before this component's, so an effect that cleared
         * the timers on a generation change would wipe the window the new view had just been given.
         */
        if (watch.current.generation !== latest.current.generation) clearWatchdogs();
        const state = watch.current;
        if (!state.armed && !state.painted) {
            state.armed = true;
            state.ready = setTimeout(() => {
                watch.current.ready = null;
                fail('The interaction presenter did not report that it had painted.');
            }, INTERACTION_LIMITS.presenterReadyMs);
        }
        if (!awaitsAcknowledgement || state.ack !== null) return;
        state.ack = setTimeout(() => {
            watch.current.ack = null;
            fail('The interaction presenter stopped acknowledging window updates.');
        }, INTERACTION_LIMITS.presenterAckMs);
    }, [fail, clearWatchdogs]);
    const onAcknowledged = useCallback((): void => {
        if (watch.current.ack === null) return;
        clearTimeout(watch.current.ack);
        watch.current.ack = null;
    }, []);
    const onReady = useCallback((): void => {
        watch.current.painted = true;
        if (watch.current.ready === null) return;
        clearTimeout(watch.current.ready);
        watch.current.ready = null;
    }, []);

    /*
     * One model per mounted slot, not per generation: the feed inside `PluginView` subscribes to
     * whichever model it was granted, so replacing the object under a live view would leave that
     * feed talking to a disposed one. Held in a ref rather than `useMemo` so a StrictMode double
     * render cannot leave a second, subscribed model behind, and disposed a microtask after the
     * real unmount for the reason `use-interaction.ts` defers its own disposal.
     */
    const cell = useRef<{ surface: InteractionSurface; placement: InteractionPlacement; host: InteractionPresenterHost } | null>(null);
    // Only while a presenter is actually granted: a phone window, or one with no plugin selected,
    // has nothing to project to and should not hold a subscription on the surface to prove it.
    if (!bundled && (cell.current === null || cell.current.surface !== surface || cell.current.placement !== placement)) {
        cell.current?.host.dispose();
        cell.current = {
            surface, placement,
            host: createInteractionPresenterHost({
                surface, placement,
                formFactor: () => (latest.current.enabled ? 'desktop' : 'phone'),
                visible: () => latest.current.painted,
                fail, onFrame, onAcknowledged, onReady
            })
        };
    }
    const host = bundled ? null : cell.current!.host;
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            queueMicrotask(() => {
                if (mounted.current) return;
                cell.current?.host.dispose();
                cell.current = null;
            });
        };
    }, []);

    // The host's own paint decision is not the surface's, so the model has to be told when it moves.
    useEffect(() => { host?.refresh(); }, [host, painted]);

    // A latch belongs to one generation. A reload, a rollback or a different selection supersedes
    // it, so the Settings row must stop reporting a failure the window has already moved past.
    useEffect(() => {
        const failure = interactionPresenterFailures()[placement];
        if (failure !== undefined && failure.generation !== generation) clearInteractionPresenterFailure(placement);
    }, [placement, generation]);
    /*
     * Standing down. Nothing is watched while the bundled presenter draws - no frames leave the
     * window - and the surface is TOLD, so `usesBundledPresenter` is honest about a fallback that was
     * nobody's fault: a phone, an empty selection, a disabled plugin, a dropped connection. The model
     * is dropped in an effect rather than during the render that decided it, so a render React
     * discards cannot leave a committed view holding a disposed grant.
     */
    useEffect(() => {
        if (!bundled) return;
        clearWatchdogs();
        surface.presenterStoodDown(placement);
        cell.current?.host.dispose();
        cell.current = null;
    }, [bundled, surface, placement, clearWatchdogs]);
    useEffect(() => clearWatchdogs, [clearWatchdogs]);

    /*
     * Escape, for a surface whose bundled presenter answers it internally. The prompts arm is covered
     * by `InteractionHost`'s own window listener whoever draws; the palette's card handles its keys
     * inside itself, so a presenter drawing the palette would otherwise have no cancel at all.
     * Capture phase and `isComposing`-guarded, the same policy as the prompt's.
     */
    useLayoutEffect(() => {
        const escape = props.onEscape;
        if (!painted || escape === undefined) return;
        const onKey = (event: KeyboardEvent): void => {
            if (event.isComposing || event.key !== 'Escape') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            escape();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [painted, props.onEscape]);

    /*
     * Containment is the WRAPPER's job, not the presenter's: `ModalRequest` keeps focus by
     * refocusing its own panel, and a frame that has been given the window has to be held the same
     * way. `PluginView` makes the initial claim itself (`armCaretClaim`) once `focused` is true.
     *
     * It yields to a modal PEER, and it has to: a palette may be opened over Settings or Help - that
     * is the route those pages are recoverable by - so a presenter that kept pulling the caret back
     * into its own frame would make the page behind it untypable. The prompts arm never paints while
     * a peer holds the window, so the read costs it nothing.
     */
    useLayoutEffect(() => {
        if (!painted || peerModal) return;
        props.captureFocus?.();
        const onFocusIn = (event: FocusEvent): void => {
            const container = wrapper.current;
            if (container === null || !(event.target instanceof Node) || container.contains(event.target)) return;
            container.querySelector('iframe')?.focus();
        };
        window.addEventListener('focusin', onFocusIn, true);
        return () => window.removeEventListener('focusin', onFocusIn, true);
    }, [painted, peerModal, props.captureFocus]);

    const short = placement.slice('interaction.'.length);
    return <>
        {/*
          * `display: contents` so the wrapper has no box of its own: the bundled palette's backdrop
          * is `absolute inset-0` against the content row and the prompts are `fixed`, and a real
          * box here would either change their containing block or take a slot in the content row's
          * layout.
          */}
        {bundled || withheld ? <div data-testid={`interaction-presenter-${short}`}
            data-interaction-presenter="bundled" style={{ display: 'contents' }}>{props.children}</div> : null}
        {/* One selector answers "who is drawing this": the test id is on whichever wrapper draws. */}
        {bundled ? null : <div
            {...(withheld ? {} : { 'data-testid': `interaction-presenter-${short}` })}
            data-interaction-presenter={viewID} data-view-id={viewID} ref={wrapper} tabIndex={-1}
            hidden={!painted} className={props.className} style={{ display: painted ? undefined : 'none' }}>
            {/*
              * Mounted while hidden, exactly as a hidden container tab is: attaching the frame on
              * ⌘P would put a lease request and a 10 s readiness window in front of the window's
              * most-used gesture. Hidden is `hidden` + `display: none` + `visible={false}`, which
              * `PluginView` turns into a blur and an empty chord list.
              *
              * `presenter` is granted here and nowhere else, and `PluginView` re-checks that grant
              * against the plugin's manifest at attach, the same discipline the terminal and
              * browser grants follow.
              */}
            <PluginView runtime={runtime!} pluginID={selected.pluginID!} viewID={viewID}
                visible={painted} focused={painted} claimedChords={props.chords}
                presenter={host!} onError={message => fail(message)} />
        </div>}
    </>;
}

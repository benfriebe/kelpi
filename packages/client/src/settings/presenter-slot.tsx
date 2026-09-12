/**
 * Where the selected Settings presenter is mounted, and the four ways it stops being the one
 * drawing.
 *
 * `interaction/presenter-slot.tsx`'s shape, for the dialog rather than the overlay. It is a sibling
 * rather than a shared component because the two differ in every arm that touches a surface: the
 * interaction slot reports to `InteractionSurface` (`presenterFailed` re-presents a pending request
 * and dismisses a palette session; `presenterStoodDown` moves `usesBundledPresenter`), and a
 * settings failure has nothing to settle - the drafts are already in the settings surface, keyed to
 * the field, so a failure changes only who paints. What IS shared is the vocabulary and the
 * budgets: `SETTINGS_LIMITS` copies the interaction numbers verbatim so the two replaceable
 * surfaces cannot come to disagree about what a wedged presenter is.
 *
 * ── The recovery floor ──────────────────────────────────────────────────────────────
 *
 * The bundled panel draws whenever ANY of these holds, checked in this order:
 *
 *   1. Presenters are disabled for this window (the phone, where the sheet is a two-screen push
 *      navigation over a software keyboard a presenter cannot read).
 *   2. There is no plugin selected for the placement - which also covers a plugin that is missing,
 *      disabled or `status === 'failed'`, because `viewRegistry` filters those out and `resolveSlot`
 *      then lands on the bundled default. The user's selection is RETAINED across all of it.
 *   3. The daemon connection is not up. A presenter behind PluginView's "Connecting to daemon…"
 *      placeholder would paint that inside the dialog.
 *   4. This generation has failed. `generation` is `viewID:revision:instanceID`, so a reload, a
 *      rollback or a different selection clears the latch by moving the generation; nothing else
 *      does except the explicit Retry in Settings ▸ Plugins.
 *
 * A failure never writes and never loses an edit: every draft, error and in-flight write lives in
 * `settings/surface.ts`, and the bundled panel redraws the same routed section from the same
 * snapshot.
 *
 * ── Why two watchdogs ───────────────────────────────────────────────────────────────
 *
 * A dialog that paints nothing is a window the user cannot get out of by looking at it: Settings is
 * where a plugin is disabled, so a presenter that never paints, or that stops draining its feed,
 * would take the route to its own removal with it. So: 5 s to report having painted after its first
 * frame, and 5 s to acknowledge a frame that moves the user - a different section, or a section
 * whose set of fields has changed shape. Either expiry fails the placement, which is to say it
 * hands the dialog back. A frame that only carries a new VALUE is not waited for: a working
 * presenter would then be failed for being idle between broadcasts.
 *
 * ── Keys ────────────────────────────────────────────────────────────────────────────
 *
 * An Escape pressed inside an iframe never reaches the host document, and the dialog's own Escape
 * is a React `onKeyDown` on the dialog element, which only fires for a target inside it. So the
 * relay is `claimedChords`: the frame forwards exactly the chords it was granted, `PluginView`
 * re-dispatches them on the owner window, and the capture-phase listener below turns that into the
 * dialog's Close. The grant is a SMALL explicit list - Escape and the rebindable `close_pane` chord
 * - and emphatically not `allViewChords`: Tab, arrows, typing and the rail's own keys are the
 * presenter's business inside its own document.
 */

import { triggersForAction, type KeyBindingMap } from '@kelpi/core/config';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactElement,
    type ReactNode
} from 'react';

import { useModalPresenceCount } from '../chrome/modal-presence';
import { chordKeysForTrigger } from '../content/bridge';
import { getCurrentPlugins } from '../plugins/client';
import { PluginView } from '../plugins/PluginView';
import { resolveSlot } from '../plugins/registry';
import { useOptionalWorkbench } from '../plugins/Workbench';
import { SETTINGS_LIMITS } from './contract';
import {
    SETTINGS_PLACEMENT,
    clearSettingsPresenterFailure,
    createSettingsPresenterHost,
    noteSettingsPresenterFailure,
    settingsPresenterFailures,
    subscribeSettingsPresenters,
    type SettingsPresenterHost
} from './presenter';
import type { SettingsSurface } from './surface';
import { useSettingsSection } from './use-settings';

/** No chords at all - what a slot with no grant passes. */
export const NO_SETTINGS_CHORDS: readonly string[] = [];

/**
 * Escape and the rebindable `close_pane` chord. Nothing else is relayed.
 *
 * The same list `interactionPresenterChords` grants, and for the same reason: these are the two
 * gestures that mean "close the thing in front of me", and both are answered by the host.
 */
export function settingsPresenterChords(bindings: KeyBindingMap): readonly string[] {
    return [
        ...new Set(['0/Escape', ...triggersForAction(bindings, 'close_pane').flatMap(chordKeysForTrigger)])
    ].sort();
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

/** What the dialog needs to know about who is drawing, to draw the rest itself. */
export interface SettingsPresenterContext {
    /** True while a selected presenter is painting the rail and the panel. */
    readonly presented: boolean;
}

export interface SettingsPresenterSlotProps {
    readonly surface: SettingsSurface;
    /** `SettingsOverlay`: desktop and a real workbench. False means the bundled panel, always. */
    readonly enabled: boolean;
    /** The dialog is open and this presenter may paint. */
    readonly visible: boolean;
    readonly chords: readonly string[];
    readonly className?: string | undefined;
    /**
     * How many modal registrations the HOST holds while this dialog is open.
     *
     * Anything above it is a peer - a palette, a prompt, the quit dialog - and a peer owns the
     * caret and its own Escape. `App` registers one presence for Settings; a dialog rendered on its
     * own registers none, which is the default.
     */
    readonly ownModals: number;
    /**
     * The dialog's own Close: what `ui.closeSettings` calls, and what a relayed Escape means.
     *
     * The host's, not the presenter's. A presenter draws inside a modal it did not raise and cannot
     * dismiss by any other route.
     */
    readonly onClose: () => void;
    /** The native failure report (a toast), raised once per failing generation. */
    readonly onFailure?: ((detail: string) => void) | undefined;
    /**
     * The bundled half, as a function of who is drawing: the whole panel when the presenter is not
     * painting, and the native remainder of the routed section when it is.
     */
    readonly children: (context: SettingsPresenterContext) => ReactNode;
}

export function SettingsPresenterSlot(props: SettingsPresenterSlotProps): ReactElement {
    const { surface } = props;
    const placement = SETTINGS_PLACEMENT;
    const workbench = useOptionalWorkbench();
    const runtime = workbench?.runtime ?? null;
    const wrapper = useRef<HTMLDivElement | null>(null);

    const selected = workbench
        ? resolveSlot(workbench.views, placement, workbench.selections[placement])
        : undefined;
    const viewID = selected?.id ?? '';
    const plugin =
        runtime && selected?.pluginID
            ? getCurrentPlugins(runtime).find((item) => item.manifest.id === selected.pluginID)
            : undefined;
    const generation = `${viewID}:${plugin?.revision ?? ''}:${plugin?.instanceID ?? ''}`;

    const [connection, setConnection] = useState(() => runtime?.connection.status ?? 'closed');
    useEffect(() => {
        if (!runtime) return;
        setConnection(runtime.connection.status);
        return runtime.connection.on('status', setConnection);
    }, [runtime]);

    const failures = useSyncExternalStore(
        subscribeSettingsPresenters,
        settingsPresenterFailures,
        settingsPresenterFailures
    );
    const latched = failures[placement]?.generation === generation;

    const bundled =
        !props.enabled || !selected?.pluginID || !runtime || connection !== 'connected' || latched;
    const painted = !bundled && props.visible;

    /*
     * Containment yields to a modal PEER, and it has to: the palette, a prompt and the shell's quit
     * dialog can all be raised OVER Settings - that is the route this page is recoverable by - so a
     * presenter that kept pulling the caret back into its own frame would make the surface in front
     * of it untypable.
     *
     * The test is against the host's OWN registration, declared by whoever mounts this (`App`
     * registers one presence covering Settings, Help and the create sheet, and Settings is open
     * whenever a presenter paints, so it is exactly 1 there and 0 in a standalone dialog). Not a
     * baseline latched when painting began: a palette that was ALREADY open at that moment would
     * have been latched in as "just us", and the presenter would then have pulled the caret out of
     * the surface in front of it.
     */
    const modals = useModalPresenceCount();
    const peerModal = modals > props.ownModals;

    /** Everything the model's stable callbacks need from the latest render. */
    const latest = useRef({ painted, generation, surface, enabled: props.enabled, onClose: props.onClose, onFailure: props.onFailure });
    latest.current = { painted, generation, surface, enabled: props.enabled, onClose: props.onClose, onFailure: props.onFailure };

    const fail = useCallback((detail: string): void => {
        const message = detail || 'The settings presenter failed.';
        const already = settingsPresenterFailures()[placement]?.generation === latest.current.generation;
        noteSettingsPresenterFailure(placement, latest.current.generation, message);
        // Once per failing generation: the latch is what makes the report honest, and a watchdog
        // that fired twice must not raise two toasts for one broken presenter.
        if (!already) latest.current.onFailure?.(message);
    }, [placement]);

    // ── the two watchdogs ───────────────────────────────────────────────────────────
    const watch = useRef<Watchdogs>({ ready: null, ack: null, armed: false, painted: false, generation });
    const clearWatchdogs = useCallback((): void => {
        if (watch.current.ready !== null) clearTimeout(watch.current.ready);
        if (watch.current.ack !== null) clearTimeout(watch.current.ack);
        watch.current = { ready: null, ack: null, armed: false, painted: false, generation: latest.current.generation };
    }, []);
    const onFrame = useCallback(
        (awaitsAcknowledgement: boolean): void => {
            /*
             * The reset belongs HERE, not in an effect: a reload or a rollback re-creates the feed
             * inside `PluginView`, whose effect runs before this component's, so an effect that
             * cleared the timers on a generation change would wipe the window the new view had just
             * been given.
             */
            if (watch.current.generation !== latest.current.generation) clearWatchdogs();
            const state = watch.current;
            if (!state.armed && !state.painted) {
                state.armed = true;
                state.ready = setTimeout(() => {
                    watch.current.ready = null;
                    fail('The settings presenter did not report that it had painted.');
                }, SETTINGS_LIMITS.presenterReadyMs);
            }
            if (!awaitsAcknowledgement || state.ack !== null) return;
            state.ack = setTimeout(() => {
                watch.current.ack = null;
                fail('The settings presenter stopped acknowledging window updates.');
            }, SETTINGS_LIMITS.presenterAckMs);
        },
        [fail, clearWatchdogs]
    );
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
     * render cannot leave a second, subscribed model behind, and disposed a microtask after the real
     * unmount for the reason `use-settings.ts` defers its own disposal.
     */
    const cell = useRef<{ surface: SettingsSurface; host: SettingsPresenterHost } | null>(null);
    if (!bundled && (cell.current === null || cell.current.surface !== surface)) {
        cell.current?.host.dispose();
        cell.current = {
            surface,
            host: createSettingsPresenterHost({
                surface,
                placement,
                formFactor: () => (latest.current.enabled ? 'desktop' : 'phone'),
                visible: () => latest.current.painted,
                close: () => {
                    latest.current.onClose();
                },
                fail,
                onFrame,
                onAcknowledged,
                onReady
            })
        };
    }
    const host = bundled ? null : cell.current!.host;
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            /*
             * Nothing is painted once this is unmounted, and the model reads `painted` through this
             * ref. Disposal is a microtask away (StrictMode's rehearsal remounts), so without this
             * the frame published in between would claim the dialog was still being presented - and
             * `visible` is what every mutating call is checked against.
             */
            latest.current = { ...latest.current, painted: false };
            cell.current?.host.refresh();
            queueMicrotask(() => {
                if (mounted.current) return;
                cell.current?.host.dispose();
                cell.current = null;
            });
        };
    }, []);

    /*
     * The two facts the model reads that the SURFACE's own subscription does not cover, so the two
     * it has to be told about: whether this presenter is painting, and which section is routed.
     *
     * The section is the host's when a host arm is installed (`App` holds `settingsTab`), so a deep
     * link, the ••• menu, ⌘, or the palette moves it with no call into the surface at all and
     * therefore no notification. `useSettingsSection` re-reads on every render, which is exactly
     * when that state has landed, and this is what turns it into a frame. Without it a presenter
     * kept drawing the previous section until something unrelated changed.
     */
    const routedSection = useSettingsSection(surface);
    useEffect(() => {
        host?.refresh();
    }, [host, painted, routedSection]);

    // A latch belongs to one generation. A reload, a rollback or a different selection supersedes
    // it, so the Settings row must stop reporting a failure the window has already moved past.
    useEffect(() => {
        const failure = settingsPresenterFailures()[placement];
        if (failure !== undefined && failure.generation !== generation)
            clearSettingsPresenterFailure(placement);
    }, [placement, generation]);

    /*
     * Standing down. Nothing is watched while the bundled panel draws - no frames leave the window -
     * and the model is dropped in an effect rather than during the render that decided it, so a
     * render React discards cannot leave a committed view holding a disposed grant.
     */
    useEffect(() => {
        if (!bundled) return;
        clearWatchdogs();
        cell.current?.host.dispose();
        cell.current = null;
    }, [bundled, clearWatchdogs]);
    useEffect(() => clearWatchdogs, [clearWatchdogs]);

    /*
     * Escape, relayed out of the frame.
     *
     * The dialog's own handler is a React `onKeyDown` on the dialog element and never sees a key
     * pressed inside an iframe; `PluginView` re-dispatches a granted chord on the owner WINDOW, so
     * this is where that lands. Capture phase and `isComposing`-guarded, the same policy the dialog
     * and the prompt both use. Installed only while a presenter is painted, so the bundled panel's
     * Escape is never double-handled.
     */
    useLayoutEffect(() => {
        // Not while a peer is up: a palette or a prompt raised OVER the dialog answers Escape
        // itself, and two capture-phase listeners racing for it is how the wrong surface closes.
        if (!painted || peerModal) return;
        const onKey = (event: KeyboardEvent): void => {
            if (event.isComposing || event.key !== 'Escape') return;
            /*
             * Only a RELAYED key. `PluginView` re-dispatches a granted chord on the owner window
             * itself, so the target is the window rather than an element; an Escape pressed in the
             * host document targets a real node and is already the dialog's own `onKeyDown` to
             * answer. Without this the two would both fire and the dialog would close twice over.
             *
             * The test is "not a node" rather than "is this window": under jsdom the window the
             * event is dispatched on is not identical to the module's own `window` binding, and the
             * rule does not need it to be.
             */
            if (event.target instanceof Node) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            latest.current.onClose();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [painted, peerModal]);

    /*
     * Containment is the WRAPPER's job, not the presenter's: a dialog keeps focus inside itself, and
     * a frame that has been given the panel has to be held the same way. `PluginView` makes the
     * initial claim itself (`armCaretClaim`) once `focused` is true; this keeps it, and yields the
     * moment a modal peer is raised over the dialog.
     */
    useLayoutEffect(() => {
        if (!painted || peerModal) return;
        const onFocusIn = (event: FocusEvent): void => {
            const container = wrapper.current;
            if (container === null || !(event.target instanceof Node) || container.contains(event.target))
                return;
            container.querySelector('iframe')?.focus();
        };
        window.addEventListener('focusin', onFocusIn, true);
        return () => window.removeEventListener('focusin', onFocusIn, true);
    }, [painted, peerModal]);

    return (
        <>
            {/*
             * One selector answers "who is drawing this": the test id is on whichever wrapper draws.
             * `display: contents` for the bundled half so the panel keeps the box it always had.
             */}
            {bundled ? (
                <div
                    data-testid="settings-presenter"
                    data-settings-presenter="bundled"
                    style={{ display: 'contents' }}
                >
                    {props.children({ presented: false })}
                </div>
            ) : (
                <>
                    <div
                        data-testid="settings-presenter"
                        data-settings-presenter={viewID}
                        data-view-id={viewID}
                        ref={wrapper}
                        tabIndex={-1}
                        hidden={!painted}
                        className={props.className}
                        style={{ display: painted ? undefined : 'none' }}
                    >
                        {/*
                         * `settingsPresenter` is granted here and nowhere else, and `PluginView`
                         * re-checks that grant against the plugin's manifest at attach, the same
                         * discipline the terminal, browser and interaction grants follow.
                         */}
                        <PluginView
                            runtime={runtime!}
                            pluginID={selected.pluginID!}
                            viewID={viewID}
                            visible={painted}
                            focused={painted}
                            claimedChords={props.chords}
                            settingsPresenter={host!}
                            onError={(message) => {
                                fail(message);
                            }}
                        />
                    </div>
                    {/*
                     * The native remainder, BELOW the frame: the hand-built parts of a partly
                     * projected section, and the whole of a permanently native one. The presenter
                     * keeps drawing the rail beside it, which is what keeps the route to Plugins in
                     * the same place whoever is painting.
                     */}
                    {props.children({ presented: painted })}
                </>
            )}
        </>
    );
}

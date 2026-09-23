/**
 * Where the selected pane search presenter is mounted, who holds the caret while it draws, and the
 * four ways it stops being the one drawing.
 *
 * ── The geometry ────────────────────────────────────────────────────────────────────
 *
 * One frame over the grid, clipped by the host to the one box the search occupies - pane chrome's
 * shape with one rectangle instead of N, and reused rather than re-derived: the frame is absolutely
 * positioned over `PaneGrid`'s container, so its coordinate space IS the grid's and the rectangle
 * in the frame needs no translation. The `clip-path` removes the frame from paint AND from hit
 * testing everywhere else, so a click below the bar reaches the terminal under it and a press on a
 * divider reaches the divider.
 *
 * It sits at `zIndex: 4`: above every pane wrapper (1, or 3 while a pane is renaming or carrying a
 * host overlay) and above the pane chrome presenter's own frame (2). That order is the native bar's
 * order restated. `grid/PaneSearchOverlay.tsx` is `z-30` INSIDE its pane wrapper, so when the
 * wrapper is lifted to 3 the bar paints over everything the grid has below it, the pane chrome band
 * included - which is the defect #244 had to fix in the other direction. A search presenter's frame
 * is not inside a wrapper, so it says the same thing at grid level.
 *
 * ── The caret, which is this surface's whole hazard ─────────────────────────────────
 *
 * This is the palette's case, not pane chrome's. A pane chrome presenter draws buttons and must
 * never hold the caret, so its slot grants no chords and hands the caret straight back on blur. A
 * SEARCH presenter draws a text input and has to hold the caret for as long as the search is open,
 * exactly as the native bar's autofocus does - so `PluginView` is mounted `focused` while the bar is
 * painted and makes its own caret claim.
 *
 * What it does NOT do is contain focus. The interaction slot refocuses its iframe on any `focusin`
 * elsewhere, because a prompt is modal. A find bar is not: clicking the terminal underneath has to
 * move the caret to the terminal, which is what the native bar does and what a user expects of a
 * bar floating in the corner of a pane they are reading.
 *
 * **Chords.** An Escape or a Cmd-F pressed inside an iframe never reaches the host document, so the
 * relay is `claimedChords`: the frame forwards exactly the chords it was granted and `PluginView`
 * re-dispatches them on the owner window, where the window's own key dispatcher sees them with the
 * WINDOW as the target - which is why `chrome/keys.ts`'s refusal to act while a text field has focus
 * does not swallow them. `close_search` (Escape) and `toggle_search` (Cmd-F) are already bound
 * there, so the relay is the whole mechanism for those two.
 *
 * Cmd-G and Shift-Cmd-G have no bound action anywhere in the client, and this placement deliberately
 * does not add two: they are fixed chords of this surface, the way the native bar hard-codes its own
 * Cmd-F close, and the listener below is what answers them. It runs in the capture phase and stops
 * the event, so nothing downstream sees a chord this surface has consumed - and it answers only
 * while the search frame or the searched pane holds the caret, so a chord pressed anywhere else in
 * the window is somebody else's. On a Ctrl-primary platform they are Ctrl-G and Shift-Ctrl-G, the
 * rule the key map applies to every `super` binding there.
 *
 * Everything the host does not relay stays inside the frame and reaches nobody: typing, arrows, Tab,
 * the presenter's own shortcuts. That is the point of a small explicit grant rather than
 * `allViewChords`, and it is what keeps a keystroke meant for a search field out of somebody's
 * shell.
 *
 * **Handing it back.** The caret goes back to the searched pane the moment the session ends, however
 * it ended: Escape, Cmd-F, the presenter's own `closeSearch`, a failure, the placement standing
 * down, the pane closing. Without it the next keystroke after a close lands in a sandbox that
 * answers nothing, which is the same defect #244 found on pane chrome's buttons, with a sharper
 * edge: the user has just finished searching a shell and the next thing they type is a command.
 *
 * ── The recovery floor ──────────────────────────────────────────────────────────────
 *
 * The NATIVE bar draws whenever any of these holds, checked in this order:
 *
 *   1. presenters are disabled for this grid (the phone, which has its own shell and its own
 *      software-keyboard inset; and every standalone render);
 *   2. no plugin is selected for the placement - which also covers a plugin that is missing,
 *      disabled or failed, because `viewRegistry` filters those out and `resolveSlot` lands on the
 *      bundled default. The user's selection is RETAINED across all of it;
 *   3. the daemon connection is not up. A presenter behind PluginView's "Connecting to daemon…"
 *      placeholder would paint that where the find bar goes - and the daemon is where the counts
 *      come from, so there would be nothing true to draw anyway;
 *   4. this generation has failed. `generation` is `viewID:revision:instanceID`, so a reload, a
 *      rollback or a different selection clears the latch by moving the generation; nothing else
 *      does except the explicit Retry in Settings ▸ Plugins.
 *
 * And, whoever is selected, the native bar keeps drawing until the presenter has reported that it
 * has PAINTED for this generation. A bar that stood down on the selection alone would leave a Cmd-F
 * during a plugin's boot with no bar at all.
 *
 * **The fallback returns the NATIVE bar with the needle intact and its input focused**, and that
 * costs nothing to arrange because the state was never the presenter's: the needle, the total and
 * the selection are the daemon's, and `PaneSearchOverlay` seeds its draft from the daemon's needle
 * and focuses itself on mount. A failed presenter is therefore a bar that reappears exactly where
 * the user left it.
 */

import { triggersForAction, type KeyBindingMap } from '@kelpi/core/config';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactElement
} from 'react';

import { CLIENT_MAC_LIKE } from '../chrome/keys';
import { chordKeysForTrigger } from '../content/bridge';
import { getCurrentPlugins } from '../plugins/client';
import { PluginView } from '../plugins/PluginView';
import { resolveSlot } from '../plugins/registry';
import { useOptionalWorkbench } from '../plugins/Workbench';
import type { KelpiRuntime } from '../state';

import { PANE_SEARCH_LIMITS, PANE_SEARCH_PLACEMENT, paneSearchClipPath, type PaneSearchRect } from './contract';
import { clearPaneSearchBoxes } from './box';
import {
    clearPaneSearchPainted,
    clearPaneSearchPresenterFailure,
    createPaneSearchPresenterHost,
    notePaneSearchPainted,
    notePaneSearchPresenterFailure,
    paneSearchPaintedGeneration,
    paneSearchPresenterFailure,
    subscribePaneSearchPainted,
    subscribePaneSearchPresenters,
    type PaneSearchActions,
    type PaneSearchPresenterHost
} from './presenter';
import type { PaneSearchProjection } from './projection';

/** Cmd-G. `chordKeysForTrigger`'s mask is ctrl 1, alt 2, shift 4, super 8. */
export const PANE_SEARCH_NEXT_CHORD = '8/KeyG';
/** Shift-Cmd-G. */
export const PANE_SEARCH_PREVIOUS_CHORD = '12/KeyG';

/**
 * The two stepping chords for the platform: ⌘G and ⇧⌘G on a Mac, Ctrl-G and Shift-Ctrl-G where
 * Ctrl is the primary modifier - `canonicalTriggerForPlatform`'s rule, which re-keys every `super`
 * binding in the map the same way, so the find bar steps with the modifier its own ⌘F opened with.
 */
export function paneSearchSteppingChords(macLike: boolean = CLIENT_MAC_LIKE): readonly [string, string] {
    return macLike ? [PANE_SEARCH_NEXT_CHORD, PANE_SEARCH_PREVIOUS_CHORD] : ['1/KeyG', '5/KeyG'];
}

/**
 * Is `node` inside the wrapper of pane `paneID`?
 *
 * Compared as an attribute VALUE up the ancestor chain rather than spliced into a selector, so a
 * pane id is never parsed as CSS - which also keeps this off `CSS.escape`, which a test DOM lacks.
 */
function insidePane(node: Element, paneID: string): boolean {
    for (let at: Element | null = node; at !== null; at = at.parentElement) {
        if (at.getAttribute('data-pane-id') === paneID) return true;
    }
    return false;
}

/**
 * Which way a keydown steps an open, presented search, or null when it is not this surface's.
 *
 * The platform's stepping chord (`paneSearchSteppingChords`), not composing, and pressed while the
 * caret is the search's: `holder` (the document's active element) inside the presenter's `frame`,
 * where a relayed chord arrives, or inside the searched pane. Pure, so the scoping is testable
 * without a presenter attached; the slot's listener is the only caller.
 */
export function paneSearchStepFor(
    event: Pick<KeyboardEvent, 'code' | 'isComposing' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey'>,
    holder: Element | null,
    frame: Element | null,
    paneID: string,
    macLike: boolean = CLIENT_MAC_LIKE
): 'next' | 'prev' | null {
    if (event.isComposing || event.code !== 'KeyG' || event.altKey) return null;
    const primary = macLike ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!primary || holder === null) return null;
    if (frame?.contains(holder) !== true && !insidePane(holder, paneID)) return null;
    return event.shiftKey ? 'prev' : 'next';
}

/**
 * The chords the host relays into the window while a search presenter draws the bar.
 *
 * Escape and the rebindable `toggle_search` chord, because both are already bound in the window's
 * own dispatcher and a relayed one reaches it with the WINDOW as the target; plus the two fixed
 * stepping chords this surface answers itself.
 *
 * Deliberately not `close_pane`, `command_palette` or anything else the interaction presenters
 * relay: this bar is a control in the corner of one pane, not a modal that has taken the window, so
 * the only chords it may consume are the ones that belong to a find bar. Everything else the user
 * presses while the field has focus stays in the frame and reaches nobody, which is exactly what the
 * native bar does - `chrome/keys.ts` refuses every non-menu-bar action while a text field has the
 * caret.
 */
export function paneSearchPresenterChords(
    bindings: KeyBindingMap,
    macLike: boolean = CLIENT_MAC_LIKE
): readonly string[] {
    return [
        ...new Set([
            '0/Escape',
            ...paneSearchSteppingChords(macLike),
            ...triggersForAction(bindings, 'toggle_search').flatMap(chordKeysForTrigger)
        ])
    ].sort();
}

/** How many times, and how far apart, the fallback re-asserts the native bar's caret. */
export const NATIVE_CARET_RECLAIM = { attempts: 8, intervalMs: 50 } as const;

/**
 * The one re-assertion in progress, if any.
 *
 * Module scope rather than a ref, because it has to outlive the component that starts it: a failure
 * latches the placement, the grid renders no slot in the very next commit, and the re-assertion is
 * what runs AFTER that. Whoever still stands - the grid - stops it (`stopNativeCaretReclaim`).
 */
let reclaiming: (() => void) | null = null;

/** Stop a re-assertion in progress: the search closed or moved, or the grid is going away. */
export function stopNativeCaretReclaim(): void {
    const stop = reclaiming;
    reclaiming = null;
    stop?.();
}

/**
 * Put the caret back in the NATIVE bar's field after a fallback, and keep asking for a few frames.
 *
 * `grid/PaneSearchOverlay.tsx` focuses itself on mount, and on this path it loses: removing the
 * failed presenter's iframe moves focus to `<body>`, and the focused pane's own caret claim answers
 * that by taking it into the terminal's hidden textarea - measured, with `document.activeElement`
 * reading `TEXTAREA` on every fallback while the bar sat there holding the user's needle and no
 * caret. The bar's own mount effect has already run by then, so it has nothing left to do about it.
 *
 * So the host re-asserts, from the one place that knows a fallback just happened. Selected by ROLE
 * rather than by test id - the bar is a `role="search"` landmark inside the pane wrapper - so this
 * is the same element the accessibility tree names and not a handle on a test selector.
 *
 * Bounded at eight attempts over ~350 ms, and re-asserted each time rather than once: the pane's
 * caret claim does not run on a deadline this can be ahead of, and a single `focus()` that lands
 * first is taken straight back off - measured in the three-scenario chain, where the same fallback
 * that held the caret alone lost it under load.
 *
 * And it STOPS the moment the user says where they want the caret, because inside those 350 ms a
 * person can: a pointer press anywhere, a key pressed anywhere (⌘K, ⌘, and typing into the field
 * alike), or the caret arriving anywhere that is neither the field nor the searched pane's own
 * surface. That last exemption is the race this exists to win - the pane's claim IS a focus move
 * into the pane - and a user who moves the caret into that pane does it with a press, which the
 * first rule has already answered. It also stops when the search closes or moves and when the grid
 * unmounts (`stopNativeCaretReclaim`), and a second fallback replaces the first rather than joining
 * it. Exported for its tests.
 */
export function reclaimNativeCaret(document: Document | null, paneID: string | null): void {
    stopNativeCaretReclaim();
    if (document === null || paneID === null) return;
    const searched = paneID;
    const field = (): HTMLInputElement | null => {
        for (const wrapper of document.querySelectorAll('[data-pane-id]')) {
            if (wrapper.getAttribute('data-pane-id') !== searched) continue;
            const input = wrapper.querySelector<HTMLInputElement>('[role="search"] input');
            if (input !== null) return input;
        }
        return null;
    };
    let left = NATIVE_CARET_RECLAIM.attempts;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stop = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        document.removeEventListener('pointerdown', stop, true);
        document.removeEventListener('keydown', stop, true);
        document.removeEventListener('focusin', onFocusIn, true);
        if (reclaiming === stop) reclaiming = null;
    };
    function onFocusIn(event: FocusEvent): void {
        const target = event.target;
        if (!(target instanceof Element)) return stop();
        if (target === field() || insidePane(target, searched)) return;
        stop();
    }
    const attempt = (): void => {
        timer = null;
        left -= 1;
        const target = field();
        if (target !== null && document.activeElement !== target) {
            target.focus();
            const end = target.value.length;
            target.setSelectionRange(end, end);
        }
        if (left > 0 && reclaiming === stop) timer = setTimeout(attempt, NATIVE_CARET_RECLAIM.intervalMs);
        else stop();
    };

    reclaiming = stop;
    // Capture phase, so a surface that stops its own events cannot hide the user's answer.
    document.addEventListener('pointerdown', stop, true);
    document.addEventListener('keydown', stop, true);
    document.addEventListener('focusin', onFocusIn, true);
    attempt();
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

/** Who, if anyone, is selected to draw this window's find bar. */
export interface PaneSearchSelection {
    /** True => the native bar draws, and nothing is mounted. */
    readonly bundled: boolean;
    readonly viewID: string;
    readonly pluginID: string | null;
    readonly runtime: KelpiRuntime | null;
    /** `viewID:revision:instanceID` - what a failure latch is keyed by. */
    readonly generation: string;
    /**
     * The daemon connection is up. Read by the grid to tell a presenter that stood down because
     * the connection dropped - and will be back with it - from one that failed or was deselected.
     */
    readonly connected: boolean;
}

/**
 * Resolve the placement once, for the two readers that need the same answer in the same render.
 *
 * `PaneGrid` asks so it can decide whether to draw the native bar, and the slot asks so it knows
 * whether to mount. A hook rather than a prop drilled between them because the answer must not be
 * able to differ: a grid that stood the native bar down while the slot mounted nothing would be an
 * open search with no bar at all.
 */
export function usePaneSearchSelection(enabled: boolean): PaneSearchSelection {
    const workbench = useOptionalWorkbench();
    const runtime = workbench?.runtime ?? null;
    const selected = workbench
        ? resolveSlot(workbench.views, PANE_SEARCH_PLACEMENT, workbench.selections[PANE_SEARCH_PLACEMENT])
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

    const failure = useSyncExternalStore(
        subscribePaneSearchPresenters,
        paneSearchPresenterFailure,
        paneSearchPresenterFailure
    );
    const latched = failure?.generation === generation;
    const connected = connection === 'connected';
    const bundled = !enabled || !selected?.pluginID || !runtime || !connected || latched;
    /*
     * A latch belongs to ONE generation, and it is cleared here rather than in the slot.
     *
     * The slot is mounted only while a presenter is selected, so a latch cleared there would survive
     * the one move that most obviously supersedes it: choosing "Pane search (bundled)". This hook is
     * called by the grid on every render whatever is selected, which is where that answer belongs.
     */
    useEffect(() => {
        const current = paneSearchPresenterFailure();
        if (current !== null && current.generation !== generation) clearPaneSearchPresenterFailure();
    }, [generation]);
    return { bundled, viewID, pluginID: selected?.pluginID ?? null, runtime, generation, connected };
}

/**
 * Has the selected presenter painted yet, for THIS generation?
 *
 * The grid asks before it stands the native bar down. Nothing else may.
 */
export function usePaneSearchPainted(generation: string): boolean {
    const painted = useSyncExternalStore(
        subscribePaneSearchPainted,
        paneSearchPaintedGeneration,
        paneSearchPaintedGeneration
    );
    return painted !== null && painted === generation;
}

export interface PaneSearchPresenterSlotProps {
    readonly selection: PaneSearchSelection;
    /** The grid itself is on screen. False means present nothing. */
    readonly visible: boolean;
    /** `PaneGrid` is desktop-only chrome, so this is `desktop` wherever the slot is mounted. */
    readonly formFactor: 'desktop' | 'phone';
    /** This render's projection of the open session. Read afresh on every frame. */
    readonly projection: PaneSearchProjection;
    /** The box the presenter may draw in, in the grid's own coordinate space, already clamped. */
    readonly rect: PaneSearchRect | null;
    /** The searched pane, or null while nothing is being searched. */
    readonly paneID: string | null;
    /** The host's own write path for every call. */
    readonly actions: PaneSearchActions;
    /** The relayed chord set from `paneSearchPresenterChords`. */
    readonly chords: readonly string[];
    /**
     * Put the caret back on the pane, because a closed search is not a keyboard surface.
     *
     * `App`'s `handBackPaneCaret` is the one place that hand-back is written down, and the native
     * bar's own ✕ already calls it.
     */
    readonly onReleaseCaret: (paneID: string) => void;
    /** The native failure report (a toast), raised once per failing generation. */
    readonly onFailure?: ((detail: string) => void) | undefined;
}

export function PaneSearchPresenterSlot(props: PaneSearchPresenterSlotProps): ReactElement | null {
    const placement = PANE_SEARCH_PLACEMENT;
    const { selection } = props;
    const { bundled, generation, runtime, viewID } = selection;
    const wrapper = useRef<HTMLDivElement | null>(null);
    /*
     * Painting and BEING SEEN are two different things.
     *
     * `painted` is the host's own paint decision and is what the frame's `visible` reports: a
     * presenter is selected, the grid is showing and a search is open, so present something.
     * `shown` is whether the box is clipped IN, which waits for the presenter's own readiness
     * report - until then the native bar is still the one drawing and a second bar painted over it
     * would be two find bars on one pane. The frame is mounted and fed either way, which is what
     * lets it paint and report in the first place.
     */
    /*
     * The painted latch is read UNCONDITIONALLY and combined afterwards.
     *
     * `shown = painted && usePaneSearchPainted(generation)` reads better and is a hook behind a
     * short circuit: the call is skipped on every render where `painted` is false, so the first
     * render where it becomes true adds a hook to the list and React tears the tree down mid-commit
     * ("Cannot read properties of undefined (reading 'length')", and a blank window). `painted`
     * flips every time a search opens or closes on this surface, so it is not a latent hazard here,
     * it is the ordinary path.
     */
    const paintedGeneration = usePaneSearchPainted(generation);
    const painted = !bundled && props.visible && props.paneID !== null;
    const shown = painted && paintedGeneration;

    /** Everything the model's stable callbacks need from the latest render. */
    const latest = useRef(props);
    latest.current = props;
    const paintedRef = useRef(painted);
    paintedRef.current = painted;

    const fail = useCallback((detail: string): void => {
        const message = detail || 'The pane search presenter failed.';
        const already = paneSearchPresenterFailure()?.generation === latest.current.selection.generation;
        notePaneSearchPresenterFailure(latest.current.selection.generation, message);
        /*
         * The declaration goes back with the latch, in the same tick, and the caret with it.
         *
         * A declared box outliving the presenter that made it would size the NATIVE bar's clip to a
         * plugin's dimensions, and a caret left in a dead frame would swallow the next keystroke the
         * user typed into their shell. The native bar takes the box back in the same commit, seeded
         * from the daemon's needle and focused on mount, which is what makes a failure recoverable
         * without the user noticing more than a flicker.
         */
        clearPaneSearchBoxes();
        clearPaneSearchPainted();
        /*
         * The caret is NOT handed to the pane here, and that is the whole of the fallback rule.
         *
         * The search is still OPEN - the state was never the presenter's - so the native bar comes
         * straight back, seeds itself from the daemon's needle and focuses its own field on mount.
         * Handing the caret to the terminal in the same tick took it straight back off that field,
         * and the user was left looking at a find bar they had to click before they could keep
         * typing. Measured: `document.activeElement` was the pane surface rather than
         * `pane-search-input-<id>` on every fallback until this line went.
         */
        // The native bar takes the caret back, and it needs help to win that race
        // (`reclaimNativeCaret`, which the grid stops when the search closes or moves).
        reclaimNativeCaret(wrapper.current?.ownerDocument ?? null, latest.current.paneID);
        // Once per failing generation: a watchdog that fired twice must not raise two toasts for
        // one broken presenter.
        if (!already) latest.current.onFailure?.(message);
    }, []);

    // ── the two watchdogs ───────────────────────────────────────────────────────────
    const watch = useRef<Watchdogs>({ ready: null, ack: null, armed: false, painted: false, generation });
    const clearWatchdogs = useCallback((): void => {
        if (watch.current.ready !== null) clearTimeout(watch.current.ready);
        if (watch.current.ack !== null) clearTimeout(watch.current.ack);
        watch.current = {
            ready: null,
            ack: null,
            armed: false,
            painted: false,
            generation: latest.current.selection.generation
        };
    }, []);
    const onFrame = useCallback(
        (awaitsAcknowledgement: boolean): void => {
            /*
             * The reset belongs HERE, not in an effect: a reload or a rollback re-creates the feed
             * inside `PluginView`, whose effect runs before this component's, so an effect that
             * cleared the timers on a generation change would wipe the window the new view had just
             * been given.
             */
            if (watch.current.generation !== latest.current.selection.generation) clearWatchdogs();
            const state = watch.current;
            if (!state.armed && !state.painted) {
                state.armed = true;
                state.ready = setTimeout(() => {
                    watch.current.ready = null;
                    fail('The pane search presenter did not report that it had painted.');
                }, PANE_SEARCH_LIMITS.presenterReadyMs);
            }
            if (!awaitsAcknowledgement || state.ack !== null) return;
            state.ack = setTimeout(() => {
                watch.current.ack = null;
                fail('The pane search presenter stopped acknowledging the search.');
            }, PANE_SEARCH_LIMITS.presenterAckMs);
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
        // The swap: from here the presenter's box is clipped IN and the native bar stands down, in
        // one commit and not a moment before (`usePaneSearchPainted`).
        notePaneSearchPainted(latest.current.selection.generation);
        if (watch.current.ready === null) return;
        clearTimeout(watch.current.ready);
        watch.current.ready = null;
    }, []);

    /*
     * One host per mounted slot, not per generation: the feed inside `PluginView` subscribes to
     * whichever host it was granted, so replacing the object under a live view would leave that feed
     * talking to a disposed one. Held in a ref rather than `useMemo` so a StrictMode double render
     * cannot leave a second, subscribed host behind.
     */
    const cell = useRef<PaneSearchPresenterHost | null>(null);
    if (!bundled && cell.current === null) {
        cell.current = createPaneSearchPresenterHost({
            placement,
            formFactor: () => latest.current.formFactor,
            visible: () => paintedRef.current,
            projection: () => latest.current.projection,
            actions: {
                setNeedle: (paneID, needle) => latest.current.actions.setNeedle(paneID, needle),
                setCaseSensitive: (paneID, on) => latest.current.actions.setCaseSensitive(paneID, on),
                step: (paneID, direction) => latest.current.actions.step(paneID, direction),
                close: (paneID) => latest.current.actions.close(paneID),
                declareBox: (paneID, size) => latest.current.actions.declareBox(paneID, size),
                knows: (paneID) => latest.current.actions.knows(paneID)
            },
            fail,
            onFrame,
            onAcknowledged,
            onReady
        });
    }
    const host = bundled ? null : cell.current;

    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            /*
             * Nothing is painted once this is unmounted, and the host reads `painted` through this
             * ref. Disposal is a microtask away (StrictMode's rehearsal remounts), so without this
             * the frame published in between would claim the bar was still being presented - and
             * `visible` is what every mutating call is checked against.
             */
            paintedRef.current = false;
            cell.current?.refresh();
            queueMicrotask(() => {
                if (mounted.current) return;
                cell.current?.dispose();
                cell.current = null;
                /*
                 * THE declaration goes here, and this is the only place it can.
                 *
                 * `PaneGrid` renders this slot only while a presenter is selected, so the moment the
                 * user picks "Pane search (bundled)", disables the plugin or uninstalls it, this
                 * component unmounts - it never re-renders with a bundled selection to notice it in.
                 * A stand-down handled by a render branch would therefore never run, and the native
                 * bar would come back clipped to a departed presenter's box. #244's lesson, said for
                 * the one declaration this surface has.
                 *
                 * The microtask guard is StrictMode's: a rehearsal remount must not drop the box of
                 * the mount that replaced it.
                 */
                clearPaneSearchBoxes();
                clearPaneSearchPainted();
            });
        };
    }, []);

    /*
     * The grid is the only thing that knows the needle moved, the count changed or the box was
     * clamped differently, and none of it goes through a store the host subscribes to: the
     * projection is built fresh by `PaneGrid` on every render and handed here as a prop. So this
     * render IS the notification, and the host's own microtask de-duplication is what keeps an
     * unchanged frame from being sent.
     */
    useEffect(() => {
        host?.refresh();
    });

    /*
     * A generation change is a different presenter: the new one has not painted, so the native bar
     * takes the box back until it says it has. A reload and a rollback both land here. The failure
     * latch is cleared by `usePaneSearchSelection`, which the grid calls whatever is selected - this
     * component is not mounted for the case that matters most.
     */
    useEffect(() => {
        clearPaneSearchPainted();
        return () => {
            clearPaneSearchPainted();
        };
    }, [generation]);

    useEffect(() => clearWatchdogs, [clearWatchdogs]);

    /*
     * The caret goes back when the SESSION ENDS, and only then.
     *
     * A transition rather than a cleanup, because "this slot stopped drawing" and "the search
     * closed" are different events and only the second one is a hand-back. A cleanup keyed on
     * `shown` fires on both, so a FAILURE - where the native bar takes over with the search still
     * open and focuses its own field - pulled the caret straight back out of that field and into
     * the terminal. So the caret goes back exactly when the searched pane becomes null: Escape and
     * the toggle chord through the relay, the presenter's own `closeSearch`, the pane closing, the
     * workspace changing. Standing the placement down while a search is open is not one of them,
     * for the same reason a failure is not: the native bar is the one holding the caret then.
     */
    const session = useRef<string | null>(props.paneID);
    useEffect(() => {
        const previous = session.current;
        session.current = props.paneID;
        if (previous !== null && props.paneID === null) latest.current.onReleaseCaret(previous);
    }, [props.paneID]);

    /*
     * Cmd-G and Shift-Cmd-G, which no binding in the client answers.
     *
     * Capture phase and `stopImmediatePropagation`, so a chord this surface consumes reaches nothing
     * else - and `isComposing`-guarded, the same policy the palette presenter's Escape follows,
     * because a keystroke that is still assembling a character is not a chord.
     *
     * Installed only while the presenter is SHOWN. While the native bar draws, Return and
     * Shift-Return are its own stepping keys and there is nothing here to add.
     *
     * And answered only while the caret is the search's: in this frame (a relayed chord is
     * re-dispatched on the window while the frame's iframe holds focus) or in the searched pane.
     * Anywhere else - another pane, the sidebar, Settings, a web page - the chord was not pressed at
     * the find bar, and a rebound ⌘G there is that binding's. Only the platform's primary modifier
     * counts, so Ctrl-G on a Mac stays the terminal's BEL and ⌘G on a Ctrl-primary platform is not
     * a find chord.
     */
    useLayoutEffect(() => {
        if (!shown) return undefined;
        const onKey = (event: KeyboardEvent): void => {
            const paneID = latest.current.paneID;
            if (paneID === null) return;
            const holder = (wrapper.current?.ownerDocument ?? document).activeElement;
            const direction = paneSearchStepFor(event, holder, wrapper.current, paneID);
            if (direction === null) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            latest.current.actions.step(paneID, direction);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [shown]);

    if (bundled || host === null || runtime === null || selection.pluginID === null) return null;
    return (
        <div
            ref={wrapper}
            data-testid="pane-search-presenter"
            data-pane-search-presenter={viewID}
            data-view-id={viewID}
            data-pane-id={props.paneID ?? ''}
            data-shown={shown ? 'true' : 'false'}
            aria-hidden={!shown}
            style={{
                position: 'absolute',
                inset: 0,
                /*
                 * Above every pane wrapper (1, or 3 while renaming or carrying a host overlay) and
                 * above the pane chrome presenter's frame (2). The native bar says the same thing
                 * from inside its wrapper with `z-30`; this says it at grid level, because this
                 * frame is a sibling of the wrappers rather than a child of one.
                 */
                zIndex: 4,
                // The whole geometry, in one property: paint and hit testing are removed everywhere
                // but the box this presenter was given.
                clipPath: shown ? paneSearchClipPath(props.rect) : `path('M0 0Z')`,
                // A frame that is not painting is still ATTACHED: it keeps its lease, its feed and
                // its readiness, so the bar comes back without a re-attach on the next Cmd-F.
                visibility: painted ? 'visible' : 'hidden'
            }}
        >
            <PluginView
                runtime={runtime}
                pluginID={selection.pluginID}
                viewID={viewID}
                visible={painted}
                /*
                 * FOCUSED, unlike pane chrome and like the palette: this presenter owns a text input
                 * and the native bar it replaces autofocuses on mount. `PluginView`'s own caret claim
                 * is what puts the caret in the frame, and nothing here contains it afterwards - a
                 * find bar is not modal, and a click on the terminal underneath has to take the
                 * caret back.
                 */
                focused={shown}
                claimedChords={props.chords}
                paneSearchPresenter={host}
                onError={(message) => {
                    fail(message);
                }}
            />
        </div>
    );
}

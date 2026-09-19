/**
 * Where the selected pane chrome presenter is mounted, and the four ways it stops being the one
 * drawing.
 *
 * ── The geometry, and why it is this one ────────────────────────────────────────────
 *
 * A pane chrome presenter draws a header for every visible pane, and the panes are scattered across
 * a grid. Two shapes were possible and they are not equivalent:
 *
 *   1. **One frame over the grid, clipped by the host to the carried bands** (this one). One
 *      `PluginView`, one lease, one document, one feed and one acknowledgement stream for the whole
 *      window. The frame is absolutely positioned over `PaneGrid`'s container, so its own
 *      coordinate space IS the grid's, and each pane's band rectangle travels in the frame
 *      (`projection.ts` ▸ `rect`) for the presenter to position a header at. The host applies a
 *      `clip-path` built from those same rectangles, which removes the frame from paint AND from
 *      hit testing everywhere else - so a click below a band reaches the terminal under it, and a
 *      click on a divider reaches the divider.
 *   2. **One frame per pane.** An absolutely positioned iframe per pane cannot be drawn by one
 *      view, so this is N view INSTANCES: N attaches, N leases, N sandboxed documents, N feeds, N
 *      readiness watchdogs and N failure latches to keep in step for an all-or-nothing fallback -
 *      and a header row whose panes cannot see each other, which is the one thing decision 3's
 *      single frame exists to give (a presenter drawing four panes has to decide what a narrow pane
 *      gives up relative to its neighbours).
 *
 * Shape 1 is what the brief asked to be preferred and what the measurement in
 * `docs/plugin-validation.md` backs. Its cost, stated plainly: the presenter is handed each band's
 * rectangle, so the frame now carries the layout the user is already looking at; and the pane-move
 * DRAG is raised from the native header's `onPointerDown`, which a presenter's own pixels cannot
 * raise, so dragging a pane by its header is unavailable while a presenter draws it. Every other
 * route to moving a pane (the context menu, the palette, the keyboard) is untouched, and
 * `openPaneMenu` puts the host's own menu one call away.
 *
 * ── What the host keeps ─────────────────────────────────────────────────────────────
 *
 * The BAND itself, always. `PaneGrid` lays a pane's body out under a fixed-height row, so the row
 * has to exist whoever is painting in it; the host paints its fill and its hairline, registers it
 * with the overlay registry when it is a taller band over a web pane, and withdraws its declaration
 * when the pane goes. On top of that the focus ring (which is why the presenter's rectangle is
 * inset by `FOCUS_RING_WIDTH` on three sides, exactly as a web pane's page hole is), the dividers,
 * the resize badge, the pane context menu, the inline rename field, every destructive confirmation,
 * the terminal's mirror clip wash, and the find bar - which is now its own placement,
 * `pane-search/`, whose frame sits ABOVE this one at z 4 for the same reason the native bar sits
 * above a band inside its wrapper.
 *
 * ── The recovery floor ──────────────────────────────────────────────────────────────
 *
 * The bundled header draws on EVERY pane whenever any of these holds, checked in this order:
 *
 *   1. Presenters are disabled for this grid (the phone, which has its own header and owns a
 *      software-keyboard inset a presenter cannot read; and every standalone render).
 *   2. There is no plugin selected for the placement - which also covers a plugin that is missing,
 *      disabled or `status === 'failed'`, because `viewRegistry` filters those out and `resolveSlot`
 *      then lands on the bundled default. The user's selection is RETAINED across all of it.
 *   3. The daemon connection is not up. A presenter behind PluginView's "Connecting to daemon…"
 *      placeholder would paint that across every header in the window.
 *   4. This generation has failed. `generation` is `viewID:revision:instanceID`, so a reload, a
 *      rollback or a different selection clears the latch by moving the generation; nothing else
 *      does except the explicit Retry in Settings ▸ Plugins.
 *
 * All-or-nothing (ratified decision 8), and the reason is geometry rather than tidiness: a band
 * belongs to a pane's body rect, which is what a PTY's cols and rows and a web pane's native bounds
 * are computed from. Failing one pane back to 24 px while another kept a declared 96 would leave a
 * live shell sized against a header nobody is drawing. So a failure clears every declaration at
 * once (`height.ts` ▸ `clearPaneChromeHeights`) and every pane is back on the native band in the
 * same commit.
 *
 * ── Why two watchdogs ───────────────────────────────────────────────────────────────
 *
 * A pane with no header is a pane with no close button, no split, no title and no zoom badge, and
 * the route to switching a presenter off is in Settings, which a headerless grid does not stop you
 * reaching - but it is still the whole window's chrome. So: 5 s to report having painted after its
 * first frame, and 5 s to acknowledge a frame whose SHAPE moved (a pane opened or closed, the
 * workspace changed, the rename field went up, the withheld count moved). Either expiry fails the
 * placement, which is to say every pane gets its header back. A frame that only carries new
 * geometry or a new title is not waited for: a divider drag moves every rect at pointer rate and a
 * shell rewrites its title whenever it likes, and a working presenter must not be failed for being
 * busy.
 */

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactElement
} from 'react';

import { FOCUS_RING_WIDTH } from '../grid/FocusRing';
import { getCurrentPlugins } from '../plugins/client';
import { PluginView } from '../plugins/PluginView';
import { resolveSlot } from '../plugins/registry';
import { useOptionalWorkbench } from '../plugins/Workbench';
import type { KelpiRuntime } from '../state';

import { tokens } from '../grid/tokens';

import { PANE_CHROME_LIMITS, PANE_CHROME_PLACEMENT } from './contract';
import { clearPaneChromeDeclarations, setPaneChromeDragRegions, setPaneChromeHeight } from './height';
import {
    clearPaneChromePainted,
    clearPaneChromePresenterFailure,
    createPaneChromePresenterHost,
    notePaneChromePainted,
    notePaneChromePresenterFailure,
    paneChromePaintedGeneration,
    paneChromePresenterFailure,
    subscribePaneChromePainted,
    subscribePaneChromePresenters,
    type PaneChromePresenterHost
} from './presenter';
import type { PaneChromeFrameRect, PaneChromeProjection } from './projection';
import type { PaneChromeSurface } from './surface';

/** A pane chrome presenter claims no chords: nothing in a header band is a keyboard surface. */
export const NO_PANE_CHROME_CHORDS: readonly string[] = [];

/**
 * The rectangle a presenter is given inside one pane's band.
 *
 * Three sides give up `FOCUS_RING_WIDTH`, for `webpane/WebPageSurface.tsx` ▸
 * `insetHoleForFocusRing`'s reason one surface over: the ring is an `inset-0` border on the pane
 * WRAPPER, around the band and the body together, so its top, left and right runs are inside the
 * band. Nothing the presenter draws may paint over them. The bottom gives up the 1 px hairline the
 * host paints under every header, so the rule between chrome and body stays the host's whoever is
 * drawing above it.
 *
 * A band too short to give the strips up keeps them, exactly as the page hole does: a negative
 * rectangle is a worse defect than a clipped ring, and a band that small is a band nobody declared.
 */
export function paneChromeFrameRect(
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
    band: number,
    ring: number = FOCUS_RING_WIDTH
): PaneChromeFrameRect {
    const inset = rect.width > ring * 2 && band > ring + 1 ? ring : 0;
    const hairline = band > ring + 1 ? 1 : 0;
    const grip = paneChromeGripRect(rect, band, ring);
    return {
        x: rect.x + inset + grip.width,
        y: rect.y + inset,
        width: Math.max(0, rect.width - inset * 2 - grip.width),
        height: Math.max(0, band - inset - hairline)
    };
}

/**
 * The host's own drag grip, at the leading edge of one band.
 *
 * Inside the focus ring's gutter and above the presenter's frame, so a press on it happens in the
 * HOST's document - which is the whole point (`PANE_CHROME_LIMITS.gripWidth`). It takes its width
 * from the same band the presenter's rectangle is cut out of, so the two can never overlap, and a
 * band with no room for both keeps the presenter's header and gives up the grip rather than
 * shipping a strip nobody can see.
 */
export function paneChromeGripRect(
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
    band: number,
    ring: number = FOCUS_RING_WIDTH
): PaneChromeFrameRect {
    const inset = rect.width > ring * 2 && band > ring + 1 ? ring : 0;
    const hairline = band > ring + 1 ? 1 : 0;
    const height = Math.max(0, band - inset - hairline);
    /*
     * A grip needs room for itself AND for a header beside it; below that the header wins, because
     * a pane with a handle and no title is worse than one that has to be moved from the context
     * menu or the keyboard. `inset === 0` is the same floor one step down: a band too short to give
     * the focus ring its gutter is too short to give anything else one either.
     */
    const room = rect.width - inset * 2;
    const width =
        inset > 0 && height > 0 && room >= PANE_CHROME_LIMITS.gripWidth * 4
            ? PANE_CHROME_LIMITS.gripWidth
            : 0;
    return { x: rect.x + inset, y: rect.y + inset, width, height };
}

/**
 * The `clip-path` that lets one frame be several headers.
 *
 * One SVG path with one subpath per band, all wound the same way, so the fill rule unions them.
 * Everything outside is removed from paint and from hit testing, which is what keeps a click below
 * a band on its terminal and a press on a divider on the divider. An empty list clips to nothing,
 * which is a mounted, attached presenter drawing no pixels - the state a workspace with no visible
 * pane is in.
 */
export function paneChromeClipPath(rects: readonly PaneChromeFrameRect[]): string {
    const parts = rects
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map(
            (rect) =>
                `M${String(rect.x)} ${String(rect.y)}H${String(rect.x + rect.width)}V${String(
                    rect.y + rect.height
                )}H${String(rect.x)}Z`
        );
    return `path('${parts.length === 0 ? 'M0 0Z' : parts.join('')}')`;
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

/** Who, if anyone, is selected to draw this window's pane chrome. */
export interface PaneChromeSelection {
    /** True => every pane wears the bundled header, and nothing is mounted. */
    readonly bundled: boolean;
    readonly viewID: string;
    readonly pluginID: string | null;
    readonly runtime: KelpiRuntime | null;
    /** `viewID:revision:instanceID` - what a failure latch is keyed by. */
    readonly generation: string;
}

/**
 * Resolve the placement once, for the two readers that need the same answer in the same render.
 *
 * `PaneGrid` asks so it can decide which headers to stand down, and the slot asks so it knows
 * whether to mount. A hook rather than a prop drilled between them because the two are in the same
 * component tree and the answer must not be able to differ: a grid that stood a header down while
 * the slot mounted nothing would be a pane with no header at all.
 */
export function usePaneChromeSelection(enabled: boolean): PaneChromeSelection {
    const workbench = useOptionalWorkbench();
    const runtime = workbench?.runtime ?? null;
    const selected = workbench
        ? resolveSlot(workbench.views, PANE_CHROME_PLACEMENT, workbench.selections[PANE_CHROME_PLACEMENT])
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
        subscribePaneChromePresenters,
        paneChromePresenterFailure,
        paneChromePresenterFailure
    );
    const latched = failure?.generation === generation;
    const bundled =
        !enabled || !selected?.pluginID || !runtime || connection !== 'connected' || latched;
    /*
     * A latch belongs to ONE generation, and it is cleared here rather than in the slot.
     *
     * The slot is mounted only while a presenter is selected, so a latch cleared there survived the
     * one move that most obviously supersedes it: choosing "Pane header (bundled)". The slot
     * unmounted, the effect never ran again, and the Settings row went on reading `Failed: …` for a
     * placement nobody had selected. This hook is called by the grid on every render whatever is
     * selected, which is where that answer belongs.
     */
    useEffect(() => {
        const current = paneChromePresenterFailure();
        if (current !== null && current.generation !== generation) clearPaneChromePresenterFailure();
    }, [generation]);
    return { bundled, viewID, pluginID: selected?.pluginID ?? null, runtime, generation };
}

/**
 * Has the selected presenter painted yet, for THIS generation?
 *
 * The grid asks before it stands a bundled header down. Nothing else may: a header that stood down
 * on the selection alone leaves every pane with no title, no close and no split for the length of a
 * plugin boot, and for the whole five second readiness window if the view never paints.
 */
export function usePaneChromePainted(generation: string): boolean {
    const painted = useSyncExternalStore(
        subscribePaneChromePainted,
        paneChromePaintedGeneration,
        paneChromePaintedGeneration
    );
    return painted !== null && painted === generation;
}

export interface PaneChromePresenterSlotProps {
    readonly selection: PaneChromeSelection;
    /** The grid itself is on screen. False means present nothing. */
    readonly visible: boolean;
    /** `PaneGrid` is desktop-only chrome, so this is `desktop` wherever the slot is mounted. */
    readonly formFactor: 'desktop' | 'phone';
    /** This render's projection of the grid, refs and all. Read afresh on every frame. */
    readonly projection: PaneChromeProjection;
    /** The bands the presenter may draw in, in the grid's own coordinate space. */
    readonly rects: readonly PaneChromeFrameRect[];
    /** The header's own write path for one pane, or null for a pane with no mounted header. */
    readonly surface: (paneID: string) => PaneChromeSurface | null;
    /** Open the host's inline rename field (decision 6). */
    readonly onRename: (paneID: string) => void;
    /** Open the host's own pane context menu, anchored under that pane's band. */
    readonly onMenu: (paneID: string) => void;
    /**
     * The bands the host draws its own drag grip in, with the pane each one belongs to.
     *
     * Kept apart from `rects` because they are different halves of one band: `rects` is what the
     * presenter draws in, and this is the strip the host keeps for itself at the leading edge.
     */
    readonly grips: readonly { readonly paneID: string; readonly rect: PaneChromeFrameRect }[];
    /**
     * The regions a presenter declared as its own title bar, already clamped into its band and
     * translated into the grid's coordinates.
     *
     * A press here is a press in the HOST's document, which is the whole point: a band's own pixels
     * cannot start the window's gesture (see `PANE_CHROME_LIMITS.gripWidth`). Nothing is forwarded
     * into the frame, so a presenter that declares a region over one of its own buttons has hidden
     * that button - which is why the contract says so in as many words.
     */
    readonly regions: readonly { readonly paneID: string; readonly rect: PaneChromeFrameRect }[];
    /** The grid's own pane-move gesture, raised from a press on a grip or a declared region. */
    readonly onGripPointerDown: (paneID: string, event: ReactPointerEvent<HTMLElement>) => void;
    /** Double click on a drag surface, which is the bundled header's own zoom toggle. */
    readonly onGripDoubleClick: (paneID: string) => void;
    /** Right click on a drag surface, which opens the host's own pane menu. */
    readonly onGripContextMenu: (paneID: string, event: ReactMouseEvent<HTMLElement>) => void;
    /**
     * Put the caret back on a pane, because a header band is never a keyboard surface.
     *
     * A click on a control inside the frame focuses the iframe, and this slot grants no chords, so
     * every keystroke after it - typing, Escape, the palette, every window chord - was swallowed by
     * a sandbox that answers none of them until the user clicked the pane body again. `App`'s
     * `handBackPaneCaret` is the one place that hand-back is written down.
     */
    readonly onReleaseCaret: (paneID: string | null) => void;
    /** The native failure report (a toast), raised once per failing generation. */
    readonly onFailure?: ((detail: string) => void) | undefined;
}

export function PaneChromePresenterSlot(props: PaneChromePresenterSlotProps): ReactElement | null {
    const placement = PANE_CHROME_PLACEMENT;
    const { selection } = props;
    const { bundled, generation, runtime, viewID } = selection;
    const wrapper = useRef<HTMLDivElement | null>(null);
    const painted = !bundled && props.visible;
    /*
     * Painting and BEING SEEN are two different things here.
     *
     * `painted` is the host's own paint decision and is what the frame's `visible` reports: the
     * presenter is selected and the grid is showing, so present something. `shown` is whether the
     * bands are clipped IN, which waits for the presenter's own readiness report - until then the
     * bundled headers are still the ones drawing and a second header painted over them would be two
     * headers on one pane. The frame is mounted and fed either way, which is what lets it paint and
     * report in the first place.
     */
    /*
     * Read UNCONDITIONALLY, then combined. A hook behind a `&&` is skipped on every render where
     * the left side is false, so the first render that flips it adds a hook to the list and React
     * tears the tree down mid-commit. `painted` flips on a selection change, a dropped connection
     * and the grid being hidden, so the order was only ever stable by luck; `pane-search` hit it on
     * its first live run, because a search opening and closing flips the same kind of flag several
     * times a session.
     */
    const paintedGeneration = usePaneChromePainted(generation);
    const shown = painted && paintedGeneration;

    /** Everything the model's stable callbacks need from the latest render. */
    const latest = useRef(props);
    latest.current = props;
    const paintedRef = useRef(painted);
    paintedRef.current = painted;

    const fail = useCallback(
        (detail: string): void => {
            const message = detail || 'The pane chrome presenter failed.';
            const already = paneChromePresenterFailure()?.generation === latest.current.selection.generation;
            notePaneChromePresenterFailure(latest.current.selection.generation, message);
            /*
             * Every declaration goes back with the latch, in the same tick.
             *
             * Not a tidy-up: a declared band is what a pane's BODY rect is computed from, so a
             * declaration outliving the presenter that made it would leave a live PTY sized against
             * a header nobody is drawing. Ratified decision 8's all-or-nothing is exactly this line.
             */
            clearPaneChromeDeclarations();
            // And the band swaps back with them: a presenter that has failed is not painting, so
            // the bundled header has to be the one drawing in the same commit.
            clearPaneChromePainted();
            // Once per failing generation: the latch is what makes the report honest, and a
            // watchdog that fired twice must not raise two toasts for one broken presenter.
            if (!already) latest.current.onFailure?.(message);
        },
        []
    );

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
                    fail('The pane chrome presenter did not report that it had painted.');
                }, PANE_CHROME_LIMITS.presenterReadyMs);
            }
            if (!awaitsAcknowledgement || state.ack !== null) return;
            state.ack = setTimeout(() => {
                watch.current.ack = null;
                fail('The pane chrome presenter stopped acknowledging pane updates.');
            }, PANE_CHROME_LIMITS.presenterAckMs);
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
        // The swap: from here the presenter's bands are clipped IN and the bundled headers stand
        // down, in one commit and not a moment before (`usePaneChromePainted`).
        notePaneChromePainted(latest.current.selection.generation);
        if (watch.current.ready === null) return;
        clearTimeout(watch.current.ready);
        watch.current.ready = null;
    }, []);

    /*
     * One host per mounted slot, not per generation: the feed inside `PluginView` subscribes to
     * whichever host it was granted, so replacing the object under a live view would leave that
     * feed talking to a disposed one. Held in a ref rather than `useMemo` so a StrictMode double
     * render cannot leave a second, subscribed host behind.
     */
    const cell = useRef<PaneChromePresenterHost | null>(null);
    if (!bundled && cell.current === null) {
        cell.current = createPaneChromePresenterHost({
            placement,
            formFactor: () => latest.current.formFactor,
            visible: () => paintedRef.current,
            projection: () => latest.current.projection,
            surface: (paneID) => latest.current.surface(paneID),
            openRename: (paneID) => {
                latest.current.onRename(paneID);
            },
            openMenu: (paneID) => {
                latest.current.onMenu(paneID);
            },
            declareHeight: (paneID, pixels) => {
                // Straight to the store the grid reads. The clamp is applied at READ, against that
                // pane's own height, which is the only place both numbers are in hand.
                setPaneChromeHeight(paneID, pixels);
            },
            declareDragRegions: (paneID, regions) => {
                // Already clamped into the pane's own band by the host's own call validation.
                setPaneChromeDragRegions(paneID, regions);
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
             * the frame published in between would claim the bands were still being presented - and
             * `visible` is what every mutating call is checked against.
             */
            paintedRef.current = false;
            cell.current?.refresh();
            queueMicrotask(() => {
                if (mounted.current) return;
                cell.current?.dispose();
                cell.current = null;
                /*
                 * THE declarations go here, and this is the only place they can.
                 *
                 * `PaneGrid` renders this slot only while a presenter is selected, so the moment
                 * the user picks "Pane header (bundled)", disables the plugin or uninstalls it,
                 * this component unmounts - it never re-renders with a bundled selection to notice
                 * it in. A stand-down handled by a render would therefore never run, and every pane
                 * would keep the band its departed presenter declared: a bundled 24 px header
                 * floating inside 96 px of nothing, with every PTY still sized against it.
                 *
                 * The microtask guard is StrictMode's: a rehearsal remount must not drop the bands
                 * of the mount that replaced it.
                 */
                clearPaneChromeDeclarations();
                clearPaneChromePainted();
            });
        };
    }, []);

    /*
     * The grid is the only thing that knows a pane moved, a title changed or a band was clamped
     * differently, and none of it goes through a store the host subscribes to: the projection is
     * built fresh by `PaneGrid` on every render and handed here as a prop. So this render IS the
     * notification, and the host's own microtask de-duplication is what keeps an unchanged frame
     * from being sent.
     */
    useEffect(() => {
        host?.refresh();
    });

    /*
     * A generation change is a different presenter: the new one has not painted, so the bundled
     * header takes every band back until it says it has. A reload and a rollback both land here.
     * The failure latch is cleared by `usePaneChromeSelection`, which the grid calls whatever is
     * selected - this component is not mounted for the case that matters most.
     */
    useEffect(() => {
        clearPaneChromePainted();
        return () => {
            clearPaneChromePainted();
        };
    }, [generation]);

    useEffect(() => clearWatchdogs, [clearWatchdogs]);

    /*
     * The caret never stays in a header band.
     *
     * Clicking a control inside the frame moves focus into the iframe, which is when the host
     * window fires its own `blur`. This slot grants no chords and the presenter answers none, so
     * every keystroke from that moment - typing into the shell, Escape, the palette, every window
     * chord - went into a sandbox that dropped it, until the user clicked the pane body again. The
     * bundled header never had the problem, because a `<button>` press leaves the caret where it
     * was.
     *
     * So the caret goes straight back to the focused pane. Deferred by a microtask, because the
     * blur arrives mid-gesture and the click the user made has to finish landing inside the frame
     * first; guarded on the active element, so a blur that is the whole WINDOW going to the
     * background (where the active element is not this iframe) is left alone.
     */
    useEffect(() => {
        if (bundled) return;
        const view = wrapper.current?.ownerDocument.defaultView ?? window;
        const onBlur = (): void => {
            queueMicrotask(() => {
                const active = wrapper.current?.ownerDocument.activeElement ?? null;
                if (active === null || !(wrapper.current?.contains(active) ?? false)) return;
                latest.current.onReleaseCaret(latest.current.projection.frame.focusedPaneID);
            });
        };
        view.addEventListener('blur', onBlur);
        return () => view.removeEventListener('blur', onBlur);
    }, [bundled]);

    if (bundled || host === null || runtime === null || selection.pluginID === null) return null;
    return (
        <>
        <div
            ref={wrapper}
            data-testid="pane-chrome-presenter"
            data-pane-chrome-presenter={viewID}
            data-view-id={viewID}
            data-bands={String(props.rects.length)}
            data-shown={shown ? 'true' : 'false'}
            aria-hidden={!shown}
            style={{
                position: 'absolute',
                inset: 0,
                // Above every pane wrapper (1 when visible, 0 when hidden) and below the wrapper of
                // a pane whose rename field is up, which `PaneGrid` lifts to 3 for exactly that.
                zIndex: 2,
                // The whole geometry, in one property: paint and hit testing are removed everywhere
                // but the bands this presenter was given.
                clipPath: shown ? paneChromeClipPath(props.rects) : `path('M0 0Z')`,
                // A frame that is not painting is still ATTACHED: it keeps its lease, its feed and
                // its readiness, so the bands come back without a re-attach when the grid does.
                visibility: painted ? 'visible' : 'hidden'
            }}
        >
            <PluginView
                runtime={runtime}
                pluginID={selection.pluginID}
                viewID={viewID}
                visible={painted}
                /*
                 * Never focused. A header band is not a keyboard surface: `PluginView`'s caret
                 * claim would pull the caret out of the terminal under it on every frame, and the
                 * presenter's own route to focus is `focusChromePane`, which the host re-validates.
                 */
                focused={false}
                claimedChords={NO_PANE_CHROME_CHORDS}
                paneChromePresenter={host}
                onError={(message) => {
                    fail(message);
                }}
            />
        </div>
        {shown ? (
            <PaneChromeDragSurfaces
                grips={props.grips}
                regions={props.regions}
                onPointerDown={props.onGripPointerDown}
                onDoubleClick={props.onGripDoubleClick}
                onContextMenu={props.onGripContextMenu}
            />
        ) : null}
        </>
    );
}

/**
 * The host's drag surfaces: the reserved grip on every band, and whatever regions the presenter
 * declared as its own title bar.
 *
 * Siblings of the presenter's frame rather than children of it, and rendered after it so they paint
 * on top: the press that starts a pane move has to land in the HOST's document, because Chromium
 * settles where a mouse gesture is routed when the button goes down and a press inside an iframe
 * keeps every later move and the release inside that iframe. No call a presenter could make undoes
 * that, which is why `beginPaneDrag` was withdrawn and these took its place.
 *
 * They behave exactly as the bundled header's empty title area does, which is the point of the
 * exercise: a press focuses the pane and arms the move gesture on the same threshold, a double
 * click toggles zoom, a right click opens the host's pane menu, and the cursor says so.
 */
function PaneChromeDragSurfaces(props: {
    readonly grips: PaneChromePresenterSlotProps['grips'];
    readonly regions: PaneChromePresenterSlotProps['regions'];
    readonly onPointerDown: PaneChromePresenterSlotProps['onGripPointerDown'];
    readonly onDoubleClick: PaneChromePresenterSlotProps['onGripDoubleClick'];
    readonly onContextMenu: PaneChromePresenterSlotProps['onGripContextMenu'];
}): ReactElement | null {
    const drawn = (entries: PaneChromePresenterSlotProps['grips']): PaneChromePresenterSlotProps['grips'] =>
        entries.filter((entry) => entry.rect.width > 0 && entry.rect.height > 0);
    const grips = drawn(props.grips);
    const regions = drawn(props.regions);
    if (grips.length === 0 && regions.length === 0) return null;
    const surface = (
        key: string,
        paneID: string,
        rect: PaneChromeFrameRect,
        grip: boolean
    ): ReactElement => (
        <div
            key={key}
            data-testid={grip ? `pane-chrome-grip-${paneID}` : `pane-chrome-drag-${paneID}-${key}`}
            data-pane-id={paneID}
            aria-hidden="true"
            title="Drag to move this pane"
            style={{
                position: 'absolute',
                left: `${String(rect.x)}px`,
                top: `${String(rect.y)}px`,
                width: `${String(rect.width)}px`,
                height: `${String(rect.height)}px`,
                // Above the presenter's frame (2) and below a renaming pane's wrapper (3), which is
                // the order every other host surface over a band keeps.
                zIndex: 2,
                cursor: 'grab',
                ...(grip
                    ? {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          // The band's own fill, so the strip reads as part of the header rather
                          // than as a gap the presenter forgot to paint.
                          background: tokens.headerBackground,
                          // A grip, drawn rather than imported: two hairlines at the band's own
                          // divider colour, which is what a drag handle looks like everywhere else.
                          backgroundImage: `linear-gradient(to right, ${tokens.divider} 1px, transparent 1px, transparent 3px, ${tokens.divider} 4px, transparent 4px)`,
                          backgroundRepeat: 'no-repeat',
                          backgroundPosition: 'center',
                          backgroundSize: '5px 10px'
                      }
                    : {
                          /*
                           * A declared region paints NOTHING. The presenter is drawing its own
                           * header underneath and this is only here to take the press; a fill would
                           * be the host covering somebody's title with a blank rectangle.
                           */
                          background: 'transparent'
                      })
            }}
            onPointerDown={(event) => props.onPointerDown(paneID, event)}
            onDoubleClick={(event) => {
                event.preventDefault();
                props.onDoubleClick(paneID);
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(paneID, event);
            }}
        />
    );
    return (
        <>
            {grips.map((entry) => surface(entry.paneID, entry.paneID, entry.rect, true))}
            {regions.map((entry, index) =>
                surface(`${entry.paneID}-${String(index)}`, entry.paneID, entry.rect, false)
            )}
        </>
    );
}

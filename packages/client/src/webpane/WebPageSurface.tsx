/** Native browser page placement and recovery, shared by bundled and plugin chrome. */
import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactElement } from 'react';
import { overlayCovers, useOverlayRects } from '../chrome/modal-presence';
import { FOCUS_RING_WIDTH } from '../grid/FocusRing';
import { Icon } from '../grid/icons';
import { tokens } from '../grid/tokens';
import type { GeometryRect } from './geometry';
import type { WebPaneProps } from './WebPane';
import {
    createPosterController, posterAttempt, posterStyle, samePosterStyle, warmPosterImage,
    POSTER_IDLE, type PosterAnchor, type PosterController, type PosterStyle
} from './poster';

function measureElement(element: HTMLElement): GeometryRect {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

/**
 * §N27 — reserve the focus ring's gutter on the three edges the page hole shares with it.
 *
 * `FocusRing` is `absolute inset-0` on the pane WRAPPER: a 2 px inner border around the whole
 * pane, header included (shell-ui.md §4.1). A web pane's page hole reaches that wrapper's left,
 * right and bottom edges exactly — measured live at ring `220,32 529×764` against hole
 * `220,91 529×705` — so on a focused LIVE web pane the ring's left, right and bottom strips are
 * underneath the native `WebContentsView` and only the top edge (beside the pane header) shows.
 *
 * Nothing in the DOM can cover a native view, so the ring cannot simply be drawn over it: the
 * hole has to shrink. This is the `BatchPanel` shape one step smaller — that panel already
 * shrinks the hole by being a sibling row rather than an overlay, for exactly this reason.
 *
 * **The inset is UNCONDITIONAL — the same rect focused or not (§N27a).** The first cut insetted
 * only while focused, which made every focus change a 4×2 px RESIZE of a live native view: the
 * owner clicks a web pane's header and watches the page visibly shrink and reflow. A resize is a
 * far louder defect than a 2 px margin, so the gutter is now reserved permanently: the ring
 * paints into it when the pane is focused, and the page hole's own `windowBackground` — the very
 * fill the pane chrome above it wears — paints there when it is not, reading as an ordinary
 * margin. **Focus therefore changes only what is PAINTED in the gutter, never any geometry.**
 *
 * The top is left alone because the header already holds it clear; moving `y` down would open a
 * band of pane background between the chrome and the page.
 *
 * **Stated divergence from Swift.** `WebPaneView`'s WKWebView is an AppKit subview in the same
 * window, so SwiftUI's border composites *over* it and the shipped app reserves nothing. A
 * DOM-under-native port has no such move — this 2 px gutter is the price of the architecture,
 * and paying it constantly is strictly cheaper than paying it on every focus change.
 */
export function insetHoleForFocusRing(rect: GeometryRect, ring: number = FOCUS_RING_WIDTH): GeometryRect {
    if (ring <= 0) return rect;
    // A hole too small to give up the strips keeps them: a zero- or negative-sized view would
    // be a worse defect than a clipped ring, and panes this small do not exist in practice.
    const horizontal = rect.w > ring * 2 ? ring : 0;
    const vertical = rect.h > ring ? ring : 0;
    if (horizontal === 0 && vertical === 0) return rect;
    return { x: rect.x + horizontal, y: rect.y, w: rect.w - horizontal * 2, h: rect.h - vertical };
}

export type WebPageSurfaceProps = Pick<WebPaneProps,
    'paneID' | 'tabs' | 'activeTabID' | 'visible' | 'embedded' | 'commands' |
    'onGeometry' | 'onHidden' | 'measure' | 'devicePixelRatio'> & {
    readonly unavailableReason?: string | undefined;
};

export const WebPageSurface = memo(function WebPageSurface(props: WebPageSurfaceProps): ReactElement {
    const { paneID, tabs, commands } = props;
    const active = tabs.find(tab => tab.id === props.activeTabID) ?? tabs[0] ?? null;
    const liveURL = active?.url ?? '';
    const visible = props.visible !== false;
    const embedded = props.embedded === true;
    const measure = props.measure ?? measureElement;
    // ── geometry ────────────────────────────────────────────────────────────────────

    const pageRef = useRef<HTMLDivElement | null>(null);
    const onGeometry = props.onGeometry;
    const onHidden = props.onHidden;
    const dpr = props.devicePixelRatio;

    /**
     * §N26 — the floating surfaces that are over THIS pane's page area right now.
     *
     * `App.tsx`'s `modalOpen` is the whole-window half of the same rule (H1): a dialog owns the
     * window, so every page parks for it. A menu or a popover does not — it covers a box — so it
     * registers that box (`chrome/modal-presence.ts`) and only the panes it actually intersects
     * park. A rect that could not be measured covers everything, which is exactly H1's answer;
     * the precision can only remove a park it can prove is unnecessary.
     */
    const overlays = useOverlayRects();
    const [coveredByOverlay, setCoveredByOverlay] = useState(false);

    /**
     * Issue #12 — the still frame the hole wears while a floating surface is over it.
     *
     * §N26 above decides WHETHER the page parks; this decides what the pane looks like while it
     * is parked, which until now was "empty". The controller is a ref rather than state because
     * the publish below is a LAYOUT effect and has to take both decisions — park, and what to
     * paint — in the same pass the surface appears in; anything that waited for a passive effect
     * would be one paint late, and that paint is the black frame (`./poster.ts`).
     *
     * `capture` reads the pane's commands through a ref so the controller is created exactly
     * once: a fresh controller per render would lose the in-flight frame it is holding the view
     * for, on every render the grid does while a menu is open.
     */
    const posterDeps = useRef({ commands, paneID });
    posterDeps.current = { commands, paneID };
    /**
     * The frame AND the box to stand it in, together, because they are only correct together: the
     * box is the view's own placement (`PosterRect`, viewport CSS px) turned into offsets inside
     * this hole at the moment the frame landed.
     */
    const [posterFrame, setPosterFrame] = useState<{ src: string; style: PosterStyle } | null>(null);
    /** The placement a landed frame was taken against — see the publish below. */
    const posterAnchor = useRef<(PosterAnchor & { src: string }) | null>(null);
    /**
     * §N26's cover, MINUS issue #12's few-frame hold — i.e. "this pane's own view is off screen
     * because something is over it". Kept beside `coveredByOverlay` rather than folded into it
     * because the two answer different questions: that one is the geometry (is a surface over my
     * hole), this one is the placement (is my page therefore gone). They differ for exactly as
     * long as a frame is being taken, which is the window in which a covered pane is still live.
     *
     * `visible` stays a prop read at render rather than being folded in here: a pane the assembly
     * has hidden must not spend a render on a state flip to say so.
     */
    const [pageParked, setPageParked] = useState(false);
    const [, bumpPoster] = useReducer((tick: number) => tick + 1, 0);
    const posterRef = useRef<PosterController | null>(null);
    if (posterRef.current === null) {
        posterRef.current = createPosterController({
            capture: async (tabID) => {
                const { commands: live, paneID: pane } = posterDeps.current;
                const attempt = posterAttempt(await live.poster(pane, tabID));
                if (attempt.src === null) return attempt;
                // Warmed off-document so the element's own decode is a cache hit. It is NOT the
                // paint signal — an image that is ready is not an image that is on screen, and
                // the difference is the frame the owner saw blink (`confirmPosterPaint`).
                return { ...attempt, src: await warmPosterImage(attempt.src) };
            },
            // The publish re-runs on every render and is where `sync` is called, so a render is
            // all the controller ever has to ask for.
            onChange: () => bumpPoster()
        });
    }
    const poster = posterRef.current;
    useLayoutEffect(() => () => poster.dispose(), [poster]);

    /**
     * "The picture is on the screen" — the signal the park now waits for (issue #12).
     *
     * Three things have to be true and only the last one matters: the element exists, its bitmap
     * is decoded (`decode()`, a cache hit after `warmPosterImage`), and a composited frame
     * carrying it has been produced. The double `requestAnimationFrame` is what says the third:
     * the first callback runs before the paint of the frame the image was committed in, the
     * second after it. Then, and only then, the view may go back — otherwise the shell removes it
     * a frame or two before this element appears and the pane shows its own background in the
     * gap, which is exactly what "it flickers" was.
     */
    const posterImgRef = useRef<HTMLImageElement | null>(null);
    /** The session the frame on screen belongs to, so its confirmation cannot answer for another. */
    const posterToken = useRef(0);
    const confirmPosterPaint = useCallback((): void => {
        const image = posterImgRef.current;
        if (image === null) return;
        const src = image.src;
        const token = posterToken.current;
        const afterPaint = (): void => {
            const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown })
                .requestAnimationFrame;
            if (typeof raf !== 'function') {
                poster.painted(token, src);
                return;
            }
            raf(() => raf(() => poster.painted(token, src)));
        };
        const decoded = typeof image.decode === 'function' ? image.decode() : null;
        if (decoded === null) {
            afterPaint();
            return;
        }
        void decoded.then(afterPaint, afterPaint);
    }, [poster]);

    /*
     * `onLoad` alone is not enough and the reason is a classic: an image whose bytes are already
     * in hand can finish loading before React has attached the handler, and then the event never
     * comes and the pane holds its view until the paint deadline. A data URL that
     * `warmPosterImage` has already decoded is exactly that image. So the confirmation is also
     * driven from an effect on the frame itself — idempotent, since the controller ignores a
     * confirmation for anything but the frame it is currently waiting on.
     */
    useEffect(() => {
        if (posterFrame === null) return;
        confirmPosterPaint();
    }, [posterFrame, confirmPosterPaint]);

    const publish = useCallback(() => {
        const element = pageRef.current;
        // Measured (and answered) BEFORE the `embedded` gate: "is this page covered" is a fact
        // about this document, and `data-visible` — what the audit and the unit tests read —
        // must state it whether or not this particular client has a native view to place.
        const rect = element === null ? null : measure(element);
        const covered = overlayCovers(rect, overlays);
        setCoveredByOverlay(covered);
        /*
         * Issue #12 — the frame is taken while the view is still on screen.
         *
         * `hold` is the controller saying "a capture is in flight": for those few frames the
         * pane keeps its view placed, so the page stays live and the surface over it is simply
         * not visible yet. The park then happens WITH a poster to hand, which is what makes the
         * swap invisible. Everything that can go wrong (no host, no frame, a host that does not
         * answer inside its deadline) ends the hold and parks the pane exactly as it did before
         * this existed.
         *
         * Asked for BEFORE the `embedded` gate, like the measurement above, and answered
         * `POSTER_IDLE` for a browser client: there is no view to photograph there, and
         * `data-visible` still has to state the same truth about the document.
         *
         * A pane that is not `visible` is not covered by anything — it is off screen, in a hidden
         * workspace or under a whole-window modal — so it never asks for a frame.
         */
        const shot = embedded
            ? poster.sync({
                  // `rect === null` is a hole that has not been laid out: `overlayCovers` reads
                  // that as covered (fail open, so the pane still parks) but there is no box to
                  // photograph, so no frame is asked for either.
                  covered: covered && visible && rect !== null,
                  tabID: active?.id ?? null
              })
            : POSTER_IDLE;
        /*
         * The picture stands where the VIEW stood, not where this document would put an image:
         * the host's placement, pinned to explicit width and height so the browser cannot size
         * the `<img>` from its own aspect ratio.
         *
         * The ANCHOR is taken once, when the frame lands, and holds the hole it was measured
         * against — because a parked pane can still move. Nothing about an open menu stops a
         * sibling pane from exiting or a `kelpi pane close` in another terminal from reflowing
         * the grid, and a picture pinned to the viewport position it was taken at would slide out
         * from under its own `overflow-hidden` and leave blank strips. Re-applied as
         * `box − holeAtLand` against the live hole, it travels with the pane.
         */
        posterToken.current = shot.token;
        if (shot.src !== null && posterAnchor.current?.src !== shot.src) {
            posterAnchor.current =
                shot.box === null || rect === null ? null : { src: shot.src, box: shot.box, hole: rect };
        }
        setPosterFrame((current) => {
            if (shot.src === null) return current === null ? current : null;
            const anchor = posterAnchor.current;
            const style = posterStyle(
                anchor === null || anchor.src !== shot.src ? null : anchor,
                rect,
                FOCUS_RING_WIDTH
            );
            // Same frame in the same box: keep the object, or the publish (which runs on every
            // render) would hand React a new one every time and re-render itself for ever.
            if (current !== null && current.src === shot.src && samePosterStyle(current.style, style)) {
                return current;
            }
            return { src: shot.src, style };
        });
        // The covered half of `data-visible`: a covered pane is not parked while its frame is
        // being taken, and that few-frame difference is real — the view is still on screen, and
        // the shell's own `owner=main` line still says so.
        setPageParked(covered && !shot.hold);
        // A browser client has nothing to place: reporting from it would only be noise the
        // host has to reject (and it does, on `ownWindow`).
        if (!embedded) return;
        if (element === null || rect === null) return;
        if (!visible || (covered && !shot.hold)) {
            onHidden?.(paneID);
            return;
        }
        onGeometry?.({
            paneID,
            tabID: active?.id ?? null,
            // §N27: the REPORTED rect shrinks for the focus ring; the DOM box does not move.
            // The hole element still fills the pane, so nothing in this document reflows — only
            // the native view is placed 2 px inside on the three edges it shares with the ring.
            // The inset does NOT read `focused` (§N27a): the gutter is reserved permanently, so
            // a focus change re-publishes a BYTE-IDENTICAL rect and never resizes the view.
            rect: insetHoleForFocusRing(rect),
            visible: true,
            devicePixelRatio:
                dpr ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1
        });
        // `focused` is deliberately NOT a dependency (§N27a): nothing in the report depends on
        // it any more, so a focus change must not even re-identify this callback.
    }, [embedded, visible, paneID, active?.id, measure, onGeometry, onHidden, dpr, overlays, poster]);

    // Layout effect, and deliberately with no dependency list: the grid re-renders a pane
    // whenever anything about the layout moves, so "after every render" IS the change signal.
    // Re-measuring is cheap and identical reports are dropped upstream.
    useLayoutEffect(() => {
        publish();
    });

    useLayoutEffect(() => {
        if (!embedded) return;
        const element = pageRef.current;
        const view = globalThis as {
            ResizeObserver?: new (callback: () => void) => { observe(target: Element): void; disconnect(): void };
            addEventListener?: (type: string, listener: () => void, options?: unknown) => void;
            removeEventListener?: (type: string, listener: () => void, options?: unknown) => void;
        };
        const observer =
            element !== null && view.ResizeObserver !== undefined ? new view.ResizeObserver(() => publish()) : null;
        observer?.observe(element as Element);
        const onWindowChange = (): void => publish();
        // A window resize or a scroll moves the hole without re-rendering this component.
        view.addEventListener?.('resize', onWindowChange);
        view.addEventListener?.('scroll', onWindowChange, true);
        return () => {
            observer?.disconnect();
            view.removeEventListener?.('resize', onWindowChange);
            view.removeEventListener?.('scroll', onWindowChange, true);
        };
    }, [embedded, publish]);

    // Retire the outgoing placement before a replacement publishes in its layout effect.
    // Passive teardown runs too late and can park the newly mounted renderer's native page.
    // Losing local embedding must also release the previous placement.
    useLayoutEffect(
        () => () => {
            if (embedded) onHidden?.(paneID);
        },
        [embedded, onHidden, paneID]
    );

    return (
            <div
                ref={pageRef}
                data-testid={`web-page-${paneID}`}
                // The pane's EFFECTIVE placement, so one attribute answers "is the page on
                // screen": `visible` is the assembly's (a modal, a hidden workspace) and
                // `pageParked` is §N26's per-pane half — the cover, less issue #12's few-frame
                // hold, which is the one window in which a covered pane is still genuinely
                // placed. `data-overlay-covered` beside it is the raw geometry either way.
                data-visible={visible && !pageParked ? 'true' : 'false'}
                data-overlay-covered={coveredByOverlay ? 'true' : 'false'}
                className="relative min-h-0 flex-1 overflow-hidden"
                // Nothing is drawn here when embedded: the shell's native view covers this box
                // exactly, and anything underneath would only be visible while it catches up.
                style={{ background: tokens.windowBackground }}
            >
                {/*
                  * Issue #12 — the page's own last frame, painted in the hole the native view is
                  * about to leave (or has just left).
                  *
                  * Positioned on §N27a's gutter rather than on the hole's own box, because the
                  * gutter is where the VIEW is: `insetHoleForFocusRing` places it 2 px inside on
                  * the left, right and bottom, so a poster drawn to the full hole would be a
                  * couple of pixels wider than the page it is standing in for and the swap would
                  * shift by exactly that much. `fill`, not `cover`: the frame is of this box, so
                  * there is nothing to crop and a resize mid-menu should stretch rather than
                  * silently lose an edge.
                  *
                  * Inert by construction — `aria-hidden`, undraggable, no pointer events: it is a
                  * picture standing in for a page, and everything a person can do to it (click a
                  * link, select text) belongs to the live view that is coming back.
                  */}
                {posterFrame === null ? null : (
                    <img
                        ref={posterImgRef}
                        data-testid={`web-poster-${paneID}`}
                        src={posterFrame.src}
                        alt=""
                        aria-hidden
                        draggable={false}
                        className="pointer-events-none absolute select-none"
                        style={posterFrame.style}
                        onLoad={confirmPosterPaint}
                    />
                )}
                {tabs.length === 0 ? (
                    <EmptyPaneNote paneID={paneID} />
                ) : active?.live === false ? (
                    /*
                     * §16.7 / issue #76: the page's renderer died and there is no view behind
                     * this hole. The user's words for the state this replaces were "only show
                     * the browser chrome, but aren't rendering the body of the browser at all"
                     * and "no retry / reload option either".
                     *
                     * It renders in BOTH clients, embedded and browser: in the shell the native
                     * view that would cover this box no longer exists, which is the whole point,
                     * so nothing is drawn over the card.
                     */
                    <CrashedPageNote
                        paneID={paneID}
                        url={liveURL}
                        onReload={() => void commands.reload(paneID)}
                    />
                ) : embedded ? null : (
                    <PageNote
                        testID={`web-external-${paneID}`}
                        title="Open in the Kelpi app"
                        detail={props.unavailableReason ?? `${liveURL || 'This page'} renders in the desktop app; this browser shows its chrome only.`}
                    />
                )}

            </div>
    );
});

/**
 * A pane with no tabs (M33 / WEB-042).
 *
 * `WebPaneView.swift:226-239` is a **bare centred stack** filling the pane —
 * `VStack(spacing: 8) { Image("globe").font(.system(size: 32)).foregroundStyle(.tertiary);
 * Text("New web pane").font(.callout).foregroundStyle(.secondary); Text("Type a URL above and
 * press Return").font(.caption).foregroundStyle(.tertiary) }`. No card, no border, no fill: the
 * port had it wearing `PageNote`'s bordered surface and had dropped the 32 pt globe entirely,
 * which turned the quietest screen in the app into a floating panel.
 *
 * The two type sizes are macOS's: `.callout` = 12 pt, `.caption` = 10 pt.
 *
 * `PageNote` stays a card for the "open in the Kelpi app" note below, which has no Swift
 * counterpart at all — it exists because a plain browser cannot draw the page, and a card is
 * what says "this box is not the page".
 */
function EmptyPaneNote({ paneID }: { readonly paneID: string }): ReactElement {
    return (
        <div className="flex h-full w-full items-center justify-center p-4">
            <div
                data-testid={`web-empty-${paneID}`}
                className="flex flex-col items-center gap-2 text-center"
                // The glyph is `.tertiary` and inherits it; only the title steps up.
                style={{ color: tokens.textTertiary }}
            >
                <Icon name="globe" size={32} />
                <span className="text-[12px]" style={{ color: tokens.textSecondary }}>
                    New web pane
                </span>
                <span className="text-[10px]" style={{ color: tokens.textTertiary }}>
                    Type a URL above and press Return
                </span>
            </div>
        </div>
    );
}

/**
 * §16.7's second empty surface: the page stopped responding (issue #76).
 *
 * `PageNote` with a button, and it is a card for exactly the reason `PageNote` is one: the box
 * is NOT the page, and a bare centred stack in a pane that usually holds a website reads as a
 * website that has gone strange. `EmptyPaneNote` can be bare because a tab-less pane has never
 * had a page in it.
 *
 * Reload goes through `commands.reload`, the same `web-reload` the nav row's button sends and
 * the same one `kelpi web reload` sends. The daemon reads the not-live flag and turns that one
 * verb into a rebuild (`daemon/src/webpane/handlers.ts`), so there is one recovery path and
 * three doors into it rather than a button with its own private wire command.
 */
function CrashedPageNote(props: {
    readonly paneID: string;
    readonly url: string;
    readonly onReload: () => void;
}): ReactElement {
    return (
        <div className="flex h-full w-full items-center justify-center p-4">
            <div
                data-testid={`web-crashed-${props.paneID}`}
                className="flex max-w-full flex-col items-center gap-2 rounded-lg px-5 py-4 text-center"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textSecondary
                }}
            >
                <span className="text-[13px] font-medium" style={{ color: tokens.textPrimary }}>
                    This page stopped responding
                </span>
                <span className="max-w-[46ch] text-[11px]" style={{ color: tokens.textTertiary }}>
                    {props.url === ''
                        ? 'Its renderer was closed by the system. Reload to open it again.'
                        : `${props.url} was closed by the system. Reload to open it again.`}
                </span>
                <button
                    type="button"
                    data-testid={`web-crashed-reload-${props.paneID}`}
                    className="mt-1 cursor-pointer rounded px-3 py-1 text-[11px] font-medium"
                    style={{ background: tokens.accent, color: tokens.windowBackground }}
                    onClick={props.onReload}
                >
                    Reload
                </button>
            </div>
        </div>
    );
}

function PageNote(props: {
    readonly testID: string;
    readonly title: string;
    readonly detail: string;
}): ReactElement {
    return (
        <div className="flex h-full w-full items-center justify-center p-4">
            <div
                data-testid={props.testID}
                className="flex max-w-full flex-col items-center gap-1 rounded-lg px-5 py-4 text-center"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textSecondary
                }}
            >
                <span className="text-[13px] font-medium" style={{ color: tokens.textPrimary }}>
                    {props.title}
                </span>
                <span className="max-w-[46ch] text-[11px]" style={{ color: tokens.textTertiary }}>
                    {props.detail}
                </span>
            </div>
        </div>
    );
}

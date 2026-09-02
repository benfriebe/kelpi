/**
 * The page POSTER — why a web pane no longer goes blank under a menu (issue #12).
 *
 * A web pane's page is a native `WebContentsView` the Electron shell composites ABOVE this
 * document. Nothing drawn in here can get over it, so a floating surface — a context menu, a
 * dropdown, a popover — is only visible if the view goes back to the off-screen holder first;
 * that is `chrome/modal-presence.ts`'s whole mechanism and the reason it exists. The price was
 * stated when it was built and then reported as a bug by the person who uses it: right-click a
 * web pane's HEADER and the page **disappears** for as long as the menu is up, because the menu
 * lands over the page area and the pane parks itself to let it be seen.
 *
 * The two cures the codebase had already named for this class were both refused here, and
 * naming why is the design:
 *
 *   1. **Yield the strip** — shrink the hole to the part the surface does not cover, the shape
 *      `BatchPanel` already has. It answers a surface that spans a full edge and nothing else: a
 *      header menu is a ~190×340 box in the MIDDLE of the page area, so what it leaves uncovered
 *      is an L, and a native view is one rectangle. The largest rectangle inside that L is a
 *      column beside the menu — i.e. yielding would blank *more* of the page than parking does,
 *      and reflow the rest on the way.
 *   2. **Draw the surface natively** — pop an Electron `Menu` instead. It works, and it costs
 *      the app its own menus: `Close Pane` is red (`danger`), rows carry colour swatches and
 *      checkmarks, and an `NSMenu` built from `MenuItemConstructorOptions` has no destructive
 *      role at all. A fidelity regression to fix a fidelity regression.
 *
 * So the page is not made visible under the menu — it is **photographed**. While the view is
 * still on screen the client asks the host for one JPEG of it (`web-poster` → the host's
 * `poster` verb, `shell/src/webhost/caps.ts`), paints that frame in the hole, and only then
 * hands the view back. The menu draws over a picture of the page that is pixel-identical to what
 * was there a moment ago, and the live view comes back the instant the surface closes.
 *
 * **The frame is taken BEFORE the park, and that ordering is the whole no-flash argument.** Park
 * first and photograph after and the pane blinks black for a round trip on every menu open,
 * which is a flicker where there used to be a steady (if wrong) blank — N24's discipline says
 * the flash is the worse defect. So the controller HOLDS the view on screen while the capture is
 * in flight: for those few frames the menu is drawn under the page and therefore invisible, and
 * a menu that finishes appearing a frame late is a cost nobody can see.
 *
 * **Every failure degrades to the old behaviour rather than to a stall.** A host that answers no
 * (a browser client, a view that is not embedded, a frame too large to send), a host that does
 * not answer inside `POSTER_DEADLINE_MS`, a pane with no live tab: the hold ends, the pane parks
 * with no poster, and the menu is visible over an empty hole exactly as it was before this
 * module existed. A refusal also DEGRADES the pane — the next cover parks immediately instead of
 * paying the wait again — while a success clears that mark, so a transient no costs one frame of
 * patience and not the feature.
 *
 * The controller is deliberately not a hook: it is called from inside `WebPane`'s geometry
 * publish, which is a LAYOUT effect that must decide "park or not" in the same pass that
 * discovers the surface. A passive effect would always run one paint too late — which is the
 * black frame this exists to prevent — so `sync()` is synchronous, returns the hold decision,
 * and asks React for a render only when something it owns actually changed.
 */

import type { CommandReply } from '../connection';

/**
 * How long a pane will hold its view on screen waiting for a frame.
 *
 * Sized from what it is racing: a `Page.captureScreenshot` of an on-screen view is a few tens of
 * milliseconds, and the number that matters is the one a person notices. 250 ms is ~15 frames —
 * comfortably above a healthy capture, and below the ~400 ms where a menu that has not finished
 * appearing starts to read as a stall rather than as a fast one.
 */
export const POSTER_DEADLINE_MS = 250;

/** What a poster reply carries when it carries one. */
const DEFAULT_POSTER_MIME = 'image/jpeg';

/**
 * Read a `web-poster` reply into something an `<img>` can wear, or null for every kind of no.
 *
 * Pure, and the only place the wire shape is known: `{ok:true, image_base64, mime}`. A reply that
 * is not ok, carries no image, or names a mime that is not an image is a no — never a `src` that
 * would put the browser to work on a string that cannot be a picture.
 */
export function posterDataURL(reply: CommandReply | null | undefined): string | null {
    if (reply === null || reply === undefined) return null;
    if (reply['ok'] !== true) return null;
    const data = reply['image_base64'];
    if (typeof data !== 'string' || data.length === 0) return null;
    const mime = reply['mime'];
    const type = typeof mime === 'string' && mime.startsWith('image/') ? mime : DEFAULT_POSTER_MIME;
    return `data:${type};base64,${data}`;
}

/**
 * The box a frame is OF: the view's own placement, in the client's CSS pixels, viewport-relative.
 *
 * The client cannot compute this. `viewBounds` in the shell rounds and clamps every edge before
 * the view is placed, so the pane's measured CSS rect is a couple of tenths away from where the
 * pixels actually were — and an `<img>` left to size itself is further away still. Standing the
 * picture anywhere but here is the jump the owner reported.
 */
export interface PosterRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/** What one attempt at a frame came back with. */
export interface PosterAttempt {
    /** The frame, or null for every kind of no. */
    readonly src: string | null;
    /** Where the view was when the frame was taken; null when the host did not say. */
    readonly box?: PosterRect | null | undefined;
    /**
     * The host said the view was not on screen (`transient` on the reply, HOST_PROTOCOL §3.6).
     *
     * A fact about WHEN we asked rather than about what this host can do — almost always our own
     * park landing mid-capture — so it must NOT count against the host. Treating it as a verdict
     * is what made a pane that lost one race stop waiting for frames, which made every later
     * capture race a park it could not win: one slow moment and the pane never postered again.
     */
    readonly transient?: boolean | undefined;
}

/**
 * The placed box the reply describes, in CSS pixels — `{bounds, css_scale}` from HOST_PROTOCOL
 * §3.6 — or null when this host did not say where the view was.
 *
 * The DIP numbers are the shell's own placement (already rounded and clamped); `css_scale` is the
 * inverse of the page zoom, so the multiplication lands back in the units the client laid out in.
 */
export function posterViewRect(reply: CommandReply | null | undefined): PosterRect | null {
    if (reply === null || reply === undefined) return null;
    const bounds = reply['bounds'];
    if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) return null;
    const box = bounds as Record<string, unknown>;
    const scale = reply['css_scale'];
    const k = typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
    const read = (key: string): number | null => {
        const value = box[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    const x = read('x');
    const y = read('y');
    const w = read('width');
    const h = read('height');
    if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
    return { x: x * k, y: y * k, w: w * k, h: h * k };
}

/** Read a whole reply, keeping the one distinction the degrade rule turns on. */
export function posterAttempt(reply: CommandReply | null | undefined): PosterAttempt {
    const src = posterDataURL(reply);
    if (src !== null) return { src, box: posterViewRect(reply) };
    const transient = reply !== null && reply !== undefined && reply['transient'] === true;
    return { src: null, transient };
}

/**
 * What a frame has to be before it is worth parking behind: **decoded**.
 *
 * A `data:` URL handed to a fresh `<img>` is decoded ASYNCHRONOUSLY, so parking the moment the
 * bytes arrive would hand the view back a frame or two before the picture that replaces it can
 * paint — the same black frame, one step further along. `HTMLImageElement.decode()` is exactly
 * the "ready to paint" signal, so the frame is warmed in an off-document image first and only
 * then reported as landed; by the time the `<img>` mounts, the bitmap is in the memory cache.
 *
 * It never withholds a frame. A decode that fails or is not implemented (jsdom has no image
 * pipeline) still yields the src — the `<img>` will do its own decode, which is the behaviour
 * this was written to improve on, not a reason to show nothing.
 */
export interface WarmableImage {
    src: string;
    decode?: (() => Promise<unknown>) | undefined;
}

export async function warmPosterImage(
    src: string,
    createImage?: () => WarmableImage
): Promise<string> {
    const Ctor = (globalThis as { Image?: new () => HTMLImageElement }).Image;
    const make = createImage ?? (Ctor === undefined ? null : (): WarmableImage => new Ctor());
    if (make === null) return src;
    try {
        const image = make();
        image.src = src;
        if (typeof image.decode === 'function') await image.decode();
    } catch {
        // A frame the browser could not pre-decode is still a frame; the element retries.
    }
    return src;
}

/** The four numbers an `<img>` needs so a browser cannot have an opinion about its size. */
export interface PosterStyle {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    /** `fill`: the frame is OF this box, so there is nothing to crop and nothing to letterbox. */
    readonly objectFit: 'fill';
    /** Tailwind's preflight is `img{max-width:100%;height:auto}` — see `posterStyle`. */
    readonly maxWidth: 'none';
    readonly maxHeight: 'none';
}

/**
 * Where to stand the frame inside the hole, in the hole's own coordinates.
 *
 * **This is the fix for the jump, and the reason it needs the host's box.** A `<img>` given only
 * `left/right/top/bottom` is not stretched to those insets: it is a REPLACED element, so
 * `width:auto` resolves to its intrinsic size, Tailwind's preflight (`img{max-width:100%;
 * height:auto}`) then clamps the width to the container and scales the height by the aspect
 * ratio, and the over-constrained `right`/`bottom` are simply ignored. Measured on a 2× display:
 * a 1050×1412 capture landed as a 528.99×711.38 box where the view had been 525×706 — the page
 * appeared 0.76% larger and 5px taller the instant the menu opened, and snapped back when it
 * closed. At 1× the intrinsic size happened to equal the view's box, which is why every 1×
 * screenshot of this looked perfect.
 *
 * So the box is stated outright, from the placement the shell actually used, with `max-width`
 * and `max-height` defeated so nothing downstream can resize it again. Without a host box
 * (an older shell, a refusal to say) it falls back to §N27a's gutter, which is where the view is
 * to within the rounding — the pre-#12 behaviour, and better than nothing.
 */
export function posterStyle(box: PosterRect | null, hole: PosterRect | null, ring = 2): PosterStyle {
    const fixed = { objectFit: 'fill', maxWidth: 'none', maxHeight: 'none' } as const;
    if (box === null || hole === null || hole.w <= 0 || hole.h <= 0) {
        const horizontal = hole !== null && hole.w > ring * 2 ? ring : 0;
        const vertical = hole !== null && hole.h > ring ? ring : 0;
        return {
            left: horizontal,
            top: 0,
            width: Math.max(0, (hole?.w ?? 0) - horizontal * 2),
            height: Math.max(0, (hole?.h ?? 0) - vertical),
            ...fixed
        };
    }
    return { left: box.x - hole.x, top: box.y - hole.y, width: box.w, height: box.h, ...fixed };
}

/**
 * Are two placements the same box? The publish runs on every render and rebuilds this style from
 * live measurements, so without an equality the state would take a fresh object each time and the
 * component would re-render itself for ever.
 */
export function samePosterStyle(a: PosterStyle, b: PosterStyle): boolean {
    return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** What the pane needs back from `sync` — the facts the render and the report each read. */
export interface PosterView {
    /** The still frame to paint in the hole, or null when there is none to paint. */
    readonly src: string | null;
    /**
     * Keep the native view on screen for now.
     *
     * True while a frame is being TAKEN, and — the half the owner's flicker report bought — while
     * a frame that has landed has not yet been PAINTED. Handing the view back in the same tick
     * the `<img>` is committed loses a race the renderer cannot win: the park is a socket message
     * the shell acts on in about a millisecond, and the picture that replaces it cannot appear
     * before the next composited frame. Measured on the shipped build: the view left at t+0 and
     * the image first existed at t+12ms, i.e. one to two frames of empty pane.
     */
    readonly hold: boolean;
    /** Where to stand the frame, in CSS px, viewport-relative; null when the host did not say. */
    readonly box: PosterRect | null;
}

export interface PosterControllerOptions {
    /** Ask the host for a frame of `tabID`. Resolves to the frame, or to why there is none. */
    readonly capture: (tabID: string) => Promise<PosterAttempt>;
    /** Something the render reads has changed (the src landed, the hold ended). */
    readonly onChange: () => void;
    readonly deadlineMs?: number | undefined;
    /** How long a landed frame stays painted after the surface closes (`POSTER_LINGER_MS`). */
    readonly lingerMs?: number | undefined;
    /** How long a host that said a real no is left alone (`POSTER_COOLDOWN_MS`). */
    readonly cooldownMs?: number | undefined;
    /** How long a landed frame may take to reach the screen (`POSTER_PAINT_DEADLINE_MS`). */
    readonly paintDeadlineMs?: number | undefined;
    /** Test seam; `Date.now` by default. */
    readonly now?: (() => number) | undefined;
    /** Test seams; `setTimeout`/`clearTimeout` by default. */
    readonly schedule?: ((callback: () => void, ms: number) => unknown) | undefined;
    readonly cancel?: ((handle: unknown) => void) | undefined;
}

export interface PosterSyncInput {
    /** Is a floating surface over this pane's page area right now? */
    readonly covered: boolean;
    /** The pane's live tab, or null when it has none (a blank pane has nothing to photograph). */
    readonly tabID: string | null;
}

export interface PosterController {
    /**
     * Called from the geometry publish on every render. Returns what to paint and whether to
     * keep the view on screen a moment longer.
     */
    sync(input: PosterSyncInput): PosterView;
    /**
     * The frame is now ON SCREEN — the `<img>` decoded and a composited frame carrying it has
     * been produced. Only then may the view go back, which is what makes the swap seamless
     * rather than a blink. Idempotent, and ignored for a frame that is no longer the current one.
     */
    painted(src: string): void;
    /** The pane is going away: drop the frame and any pending timer. */
    dispose(): void;
    /** Diagnostics: how many captures this pane has asked for. */
    readonly captures: number;
    /** Diagnostics: is this pane parking without waiting, because the host keeps saying no? */
    readonly degraded: boolean;
}

/**
 * Nothing covered, nothing to paint — the answer for every pane, almost always, and the answer a
 * client with no native view to photograph takes without asking.
 */
export const POSTER_IDLE: PosterView = { src: null, hold: false, box: null };

/**
 * How long the frame stays painted after the surface closes.
 *
 * Handing the view back is a socket round trip and a native re-parent, so the pixels do not
 * return in the same frame the menu leaves in. Dropping the poster on the same tick would open a
 * blank exactly as wide as that gap — the flash this whole module exists to avoid, moved to the
 * other end of the gesture. The frame lingers instead: the live view lands on top of it, and the
 * linger expires under a page nobody can see behind.
 */
export const POSTER_LINGER_MS = 400;

/**
 * How many deadlines in a row a host may miss before this pane stops waiting for it.
 *
 * A missed deadline is not a refusal — the frame may still be coming, and a slow page is worth
 * one wait. But a host that is CONSISTENTLY slower than the deadline would otherwise cost the
 * user 250ms of invisible menu on every single right-click, for a frame that never arrives in
 * time to be worth it. Two in a row is the smallest number that can tell "this page was busy
 * once" from "this host cannot do this", and the mark is cleared by the first frame that lands,
 * so a page that recovers gets its poster back.
 */
export const POSTER_MISS_LIMIT = 2;

/**
 * How long a pane stops asking for frames after a host says a real no.
 *
 * Degrading has to be TIME-BOXED rather than sticky, and that is the correction the
 * `web-popup-layering` audit forced: a permanently degraded pane parks the instant it is
 * covered, so its capture always arrives after its own park and is always refused — the state
 * that stops it asking is the state that guarantees it can never succeed again. A cooldown
 * breaks the loop from both ends: while it is running the pane does not ask at all (nothing
 * races, nothing is wasted), and when it expires the pane HOLDS for the next frame, which is the
 * only condition under which one can come back. Five seconds is long enough that a host which
 * genuinely cannot poster is asked at most once a menu-burst, and short enough that a person who
 * fixed the cause does not have to wonder how long they must wait.
 */
export const POSTER_COOLDOWN_MS = 5_000;

/**
 * How long the view is held for a frame that has landed but not yet painted.
 *
 * The wait is normally two composited frames — the `<img>` is committed, decoded and rastered —
 * so this is the backstop for the cases where the confirmation never comes at all: a decode that
 * rejects, a renderer that stops producing frames because the window was hidden mid-menu, a
 * browser with no `decode()`. Past it the pane parks with the frame it has, which is the old
 * behaviour plus a picture that will paint a moment later.
 */
export const POSTER_PAINT_DEADLINE_MS = 150;

export function createPosterController(options: PosterControllerOptions): PosterController {
    const deadlineMs = options.deadlineMs ?? POSTER_DEADLINE_MS;
    const paintDeadlineMs = options.paintDeadlineMs ?? POSTER_PAINT_DEADLINE_MS;
    const lingerMs = options.lingerMs ?? POSTER_LINGER_MS;
    const cooldownMs = options.cooldownMs ?? POSTER_COOLDOWN_MS;
    const now = options.now ?? ((): number => Date.now());
    const schedule =
        options.schedule ?? ((callback: () => void, ms: number): unknown => setTimeout(callback, ms));
    const cancel = options.cancel ?? ((handle: unknown): void => clearTimeout(handle as never));

    /**
     * null = this pane is not covered; otherwise the cover session that is running.
     *
     * `waiting` is "keep the view on screen", and it now spans BOTH halves of the swap: while the
     * frame is being taken (`phase: 'capture'`) and while a frame that has landed waits to be
     * painted (`phase: 'paint'`). Only when a composited frame carrying the picture exists does
     * the view go back.
     */
    let session: { tabID: string; waiting: boolean; seq: number; phase: 'capture' | 'paint' | 'parked' } | null =
        null;
    /** What the hole should wear right now — a landed frame, or a lingering one. */
    let painted: string | null = null;
    /** Where to stand it: the view's own placement, as the host reported it. */
    let paintedBox: PosterRect | null = null;
    /**
     * Until when this pane asks for nothing at all — set by a real no, cleared by a frame.
     *
     * Not a boolean, and the difference is the whole of the audit's finding: a sticky flag makes
     * a pane park instantly, which makes its captures race their own park, which refuses them,
     * which keeps the flag set. A deadline in time cannot do that.
     */
    let coolingUntil = 0;
    /** Consecutive deadlines this host has missed; a landed frame resets it. */
    let misses = 0;
    /** At most one timer is ever live: a capture deadline, or a linger. */
    let timer: unknown = null;
    let captures = 0;
    let disposed = false;

    const clearTimer = (): void => {
        if (timer === null) return;
        cancel(timer);
        timer = null;
    };

    const view = (): PosterView => ({ src: painted, hold: session?.waiting === true, box: paintedBox });

    /** A real no: leave this host alone for a while (see `POSTER_COOLDOWN_MS`). */
    const cool = (): void => {
        coolingUntil = now() + cooldownMs;
        misses = 0;
    };

    const start = (tabID: string): void => {
        captures += 1;
        const seq = captures;
        session = { tabID, waiting: true, seq, phase: 'capture' };
        // A frame from the last cover is of a page that has since been live and interactive: it
        // goes now rather than being shown while its replacement is taken.
        painted = null;
        paintedBox = null;
        clearTimer();
        // The deadline is armed before the request, because a host that never answers at all is
        // not a rejected promise — it is silence, and the view has to come back either way.
        timer = schedule(() => {
            timer = null;
            if (disposed || session === null || session.seq !== seq || !session.waiting) return;
            // A single miss does NOT cool the host: a slow answer may still land and is still
            // worth painting. A run of them does — see `POSTER_MISS_LIMIT`.
            misses += 1;
            if (misses >= POSTER_MISS_LIMIT) cool();
            session.waiting = false;
            session.phase = 'parked';
            options.onChange();
        }, deadlineMs);
        void options.capture(tabID).then(
            (attempt) => {
                if (disposed) return;
                if (attempt.src !== null) {
                    // A frame that landed at all — even after its deadline — says the host works.
                    misses = 0;
                    coolingUntil = 0;
                } else if (attempt.transient !== true) {
                    // A real no. A TRANSIENT one is not: it means the view had gone off screen by
                    // the time the host looked, which is usually this pane's own park landing
                    // mid-capture and says nothing about whether a frame can be had next time.
                    cool();
                }
                // Uncovered while the frame was in flight, or the pane moved on to another tab:
                // the picture is of a moment nobody is looking at any more.
                if (session === null || session.seq !== seq) return;
                clearTimer();
                if (attempt.src === null) {
                    // A refusal that arrives after the deadline already released the view changes
                    // nothing anyone can see, so it does not ask for a render.
                    const wasWaiting = session.waiting;
                    session.waiting = false;
                    session.phase = 'parked';
                    if (wasWaiting) options.onChange();
                    return;
                }
                painted = attempt.src;
                paintedBox = attempt.box ?? null;
                if (session.phase === 'capture') {
                    /*
                     * The frame is HERE but not yet on screen. Keep holding: the park is a socket
                     * message the shell acts on within a millisecond, and the `<img>` that is
                     * supposed to replace the view cannot appear before the next composited
                     * frame. `painted()` — a decode plus a double rAF in the component — is what
                     * says the picture exists; this timer is the backstop for when it cannot.
                     */
                    session.phase = 'paint';
                    timer = schedule(() => {
                        timer = null;
                        if (disposed || session === null || session.seq !== seq || session.phase !== 'paint') return;
                        session.waiting = false;
                        session.phase = 'parked';
                        options.onChange();
                    }, paintDeadlineMs);
                } else {
                    // The deadline already handed the view back; the late frame simply appears.
                    session.waiting = false;
                    session.phase = 'parked';
                }
                options.onChange();
            },
            () => {
                if (disposed) return;
                cool();
                if (session === null || session.seq !== seq || !session.waiting) return;
                session.waiting = false;
                session.phase = 'parked';
                clearTimer();
                options.onChange();
            }
        );
    };

    /**
     * A cover that asks for nothing: the pane parks at once and the hole stays empty, which is
     * the pre-poster behaviour. Used only while a host is cooling off, and it asks for NOTHING
     * on purpose — a capture fired here would arrive after the park it just caused and be
     * refused, which is the loop the cooldown exists to break.
     */
    const parkWithoutAsking = (tabID: string): void => {
        session = { tabID, waiting: false, seq: captures, phase: 'parked' };
        painted = null;
        paintedBox = null;
        clearTimer();
    };

    const uncover = (): PosterView => {
        if (session === null) return view();
        session = null;
        clearTimer();
        if (painted === null) return POSTER_IDLE;
        timer = schedule(() => {
            timer = null;
            if (disposed || session !== null) return;
            painted = null;
            paintedBox = null;
            options.onChange();
        }, lingerMs);
        return view();
    };

    return {
        sync(input) {
            if (disposed) return POSTER_IDLE;
            // A pane with no live tab has nothing to photograph, and one nobody is covering wants
            // its own pixels back: both end the session, and the frame lingers over the swap.
            if (!input.covered || input.tabID === null) return uncover();
            if (session === null || session.tabID !== input.tabID) {
                if (coolingUntil > now()) parkWithoutAsking(input.tabID);
                else start(input.tabID);
                return view();
            }
            return view();
        },

        painted(src) {
            if (disposed || session === null) return;
            // Only the frame that is currently up counts: a confirmation for a picture the pane
            // has already replaced (a tab switch, a second cover) says nothing about this one.
            if (session.phase !== 'paint' || painted !== src) return;
            session.waiting = false;
            session.phase = 'parked';
            clearTimer();
            options.onChange();
        },

        dispose() {
            disposed = true;
            session = null;
            painted = null;
            paintedBox = null;
            clearTimer();
        },

        get captures() {
            return captures;
        },

        get degraded() {
            return coolingUntil > now();
        }
    };
}

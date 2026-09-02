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

/** What the pane needs back from `sync` — the two facts the render and the report each read. */
export interface PosterView {
    /** The still frame to paint in the hole, or null when there is none to paint. */
    readonly src: string | null;
    /** Keep the native view on screen for now: a frame is being taken. */
    readonly hold: boolean;
}

export interface PosterControllerOptions {
    /** Ask the host for a frame of `tabID`. Resolves to a data URL, or null for any refusal. */
    readonly capture: (tabID: string) => Promise<string | null>;
    /** Something the render reads has changed (the src landed, the hold ended). */
    readonly onChange: () => void;
    readonly deadlineMs?: number | undefined;
    /** How long a landed frame stays painted after the surface closes (`POSTER_LINGER_MS`). */
    readonly lingerMs?: number | undefined;
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
    /** The pane is going away: drop the frame and any pending timer. */
    dispose(): void;
    /** Diagnostics: how many captures this pane has asked for. */
    readonly captures: number;
}

/**
 * Nothing covered, nothing to paint — the answer for every pane, almost always, and the answer a
 * client with no native view to photograph takes without asking.
 */
export const POSTER_IDLE: PosterView = { src: null, hold: false };

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

export function createPosterController(options: PosterControllerOptions): PosterController {
    const deadlineMs = options.deadlineMs ?? POSTER_DEADLINE_MS;
    const lingerMs = options.lingerMs ?? POSTER_LINGER_MS;
    const schedule =
        options.schedule ?? ((callback: () => void, ms: number): unknown => setTimeout(callback, ms));
    const cancel = options.cancel ?? ((handle: unknown): void => clearTimeout(handle as never));

    /** null = this pane is not covered; otherwise the cover session that is running. */
    let session: { tabID: string; waiting: boolean; seq: number } | null = null;
    /** What the hole should wear right now — a landed frame, or a lingering one. */
    let painted: string | null = null;
    /**
     * The last capture said no, so the next cover does not make the user wait for another one.
     * A success clears it: the mark is about the host's current answer, not a life sentence.
     */
    let degraded = false;
    /** At most one timer is ever live: a capture deadline, or a linger. */
    let timer: unknown = null;
    let captures = 0;
    let disposed = false;

    const clearTimer = (): void => {
        if (timer === null) return;
        cancel(timer);
        timer = null;
    };

    const view = (): PosterView => ({ src: painted, hold: session?.waiting === true });

    const start = (tabID: string): void => {
        captures += 1;
        const seq = captures;
        session = { tabID, waiting: !degraded, seq };
        // A frame from the last cover is of a page that has since been live and interactive: it
        // goes now rather than being shown while its replacement is taken.
        painted = null;
        clearTimer();
        // The deadline is armed before the request, because a host that never answers at all is
        // not a rejected promise — it is silence, and the view has to come back either way.
        timer = schedule(() => {
            timer = null;
            if (disposed || session === null || session.seq !== seq || !session.waiting) return;
            // Deliberately not `degraded`: a slow answer may still land and is still worth
            // painting, so only an actual refusal marks the pane.
            session.waiting = false;
            options.onChange();
        }, deadlineMs);
        void options.capture(tabID).then(
            (src) => {
                if (disposed) return;
                degraded = src === null;
                // Uncovered while the frame was in flight, or the pane moved on to another tab:
                // the picture is of a moment nobody is looking at any more.
                if (session === null || session.seq !== seq) return;
                // A refusal that arrives after the deadline already released the view changes
                // nothing anyone can see, so it does not ask for a render.
                const changed = src !== null || session.waiting;
                if (src !== null) painted = src;
                session.waiting = false;
                clearTimer();
                if (changed) options.onChange();
            },
            () => {
                if (disposed) return;
                degraded = true;
                if (session === null || session.seq !== seq || !session.waiting) return;
                session.waiting = false;
                clearTimer();
                options.onChange();
            }
        );
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
                start(input.tabID);
                return view();
            }
            return view();
        },

        dispose() {
            disposed = true;
            session = null;
            painted = null;
            clearTimer();
        },

        get captures() {
            return captures;
        }
    };
}

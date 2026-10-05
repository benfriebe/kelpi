/**
 * The terminal POSTER: why a workspace switch no longer blanks every pane.
 *
 * A background workspace renders nothing (`mount-policy.ts` rule 1), so a switch disposes every
 * outgoing engine and builds every incoming one from scratch: a fresh WASM instance, an
 * `open()` behind the page-wide startup gate, a re-attach, and the daemon's replay parsed back
 * in. Until each of those lands the pane shows its bare fill, and they land one after another.
 * Measured on a four-pane workspace at 120 Hz: seven or eight frames with a blank pane on every
 * switch, two to five with all four blank, the last one painting ~70-120 ms after the click.
 * That is the flash, and it is longer for a pane with a big scrollback.
 *
 * Keeping the engines alive across workspaces would remove the work as well as the flash, and
 * it is refused here for the reasons the mount policy states: each engine is a render loop, a
 * WASM instance (V8 caps a renderer at roughly a hundred) and a stream the daemon fans bytes out
 * to. So the pane is not kept, it is **photographed**, the way a web pane under a menu is
 * (`webpane/poster.ts`):
 *
 *   - when a terminal pane unmounts with a complete screen on its canvas, the canvas is copied
 *     into a detached one, keyed by pane id;
 *   - when that pane mounts again, the copy is put over the host in the SAME commit, before the
 *     first paint, and it stays until the new engine has parsed its whole replay
 *     (`TerminalRenderer.onReplayApplied`) and drawn a frame of it.
 *
 * What the user sees is the pane as they left it, then the live pane in its place. When nothing
 * changed in between, the swap is invisible. When the shell printed while the workspace was in
 * the background, the new output appears at once rather than after a blank.
 *
 * **A copy, never the engine's own canvas.** Keeping the canvas element the engine drew into
 * would be zero-copy, and it would keep every listener the engine bound to it, and through
 * them the engine and its WASM memory: the exact retention that ran the renderer out of Wasm
 * address space on 2026-09-10 (`scripts/scenarios/terminal-engine-retention.mjs`).
 *
 * **Bounded.** A poster is a full-resolution bitmap (a quarter-window pane on a 2× display is
 * ~7 MB), so the cache is least-recently-used under a byte budget. A pane whose poster was
 * evicted comes back the way every pane used to: blank, then painted.
 */

/** Bytes of poster bitmaps kept at most, across every pane. */
export const TERMINAL_POSTER_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * The same, on a phone. iOS caps the canvas memory of a whole page and refuses a context past
 * it, and the engines' own canvases need that headroom far more than posters do: one 3x
 * full-screen phone pane is ~12 MB, so this keeps two or three.
 */
export const PHONE_TERMINAL_POSTER_BUDGET_BYTES = 32 * 1024 * 1024;

export interface TerminalPoster {
    /** A detached copy of the engine's canvas, at its device-pixel size. */
    readonly canvas: HTMLCanvasElement;
    /** The CSS size the engine laid its canvas out at, which the copy is shown at. */
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly bytes: number;
}

/** Insertion order is recency: a poster is re-inserted whenever it is stored or taken. */
const posters = new Map<string, TerminalPoster>();
let totalBytes = 0;

function remove(paneID: string): TerminalPoster | null {
    const poster = posters.get(paneID);
    if (poster === undefined) return null;
    posters.delete(paneID);
    totalBytes -= poster.bytes;
    return poster;
}

/**
 * Free a poster's bitmap now rather than whenever it is collected: a detached canvas keeps its
 * backing store until then, and Safari counts it against the page's canvas cap until it is
 * shrunk to nothing.
 */
export function discardTerminalPoster(poster: TerminalPoster): void {
    poster.canvas.width = 0;
    poster.canvas.height = 0;
}

function store(paneID: string, poster: TerminalPoster, budget: number): void {
    const previous = remove(paneID);
    if (previous !== null) discardTerminalPoster(previous);
    if (poster.bytes > budget) {
        discardTerminalPoster(poster);
        return;
    }
    posters.set(paneID, poster);
    totalBytes += poster.bytes;
    for (const [id, oldest] of posters) {
        if (totalBytes <= budget) break;
        posters.delete(id);
        totalBytes -= oldest.bytes;
        discardTerminalPoster(oldest);
    }
}

/**
 * Copy the engine canvas inside `host` and keep it as `paneID`'s poster.
 *
 * Synchronous on purpose: it runs in the pane's teardown, before `dispose()` takes the canvas
 * away. Returns false (keeping whatever poster the pane already had) when there is no canvas to
 * copy, it has no size, or the copy fails.
 */
export function captureTerminalPoster(
    paneID: string,
    host: HTMLElement,
    budget = TERMINAL_POSTER_BUDGET_BYTES
): boolean {
    const source = host.querySelector('canvas');
    if (source === null || source.width === 0 || source.height === 0) return false;
    // The engine states its canvas's CSS size inline (ghostty-web `renderer.ts` `resize`). Read
    // from there rather than measured, because an unmounting pane's teardown runs after React
    // has detached it, where every layout read answers zero.
    const cssWidth = Number.parseFloat(source.style.width);
    const cssHeight = Number.parseFloat(source.style.height);
    if (!(cssWidth > 0) || !(cssHeight > 0)) return false;
    try {
        const canvas = host.ownerDocument.createElement('canvas');
        canvas.width = source.width;
        canvas.height = source.height;
        const context = canvas.getContext('2d');
        if (context === null) return false;
        context.drawImage(source, 0, 0);
        store(paneID, { canvas, cssWidth, cssHeight, bytes: source.width * source.height * 4 }, budget);
        return true;
    } catch {
        return false;
    }
}

/**
 * Hand `paneID`'s poster to the pane that is about to show it, removing it from the cache.
 *
 * Taken rather than peeked so one canvas element is never in two places. A pane that unmounts
 * before its engine replaced the poster gives it back with {@link returnTerminalPoster}.
 */
export function takeTerminalPoster(paneID: string): TerminalPoster | null {
    return remove(paneID);
}

/** Put back a poster that was taken and never replaced by a live screen. */
export function returnTerminalPoster(
    paneID: string,
    poster: TerminalPoster,
    budget = TERMINAL_POSTER_BUDGET_BYTES
): void {
    // A capture made since (an engine that did finish) is newer than this one.
    if (posters.has(paneID)) {
        discardTerminalPoster(poster);
        return;
    }
    store(paneID, poster, budget);
}

/**
 * Forget these panes' posters (the panes were closed).
 *
 * A pane closed while it is on screen unmounts like any other, so its teardown takes a poster
 * nothing will ever show; left alone it would hold budget until it aged out.
 */
export function forgetTerminalPosters(paneIDs: Iterable<string>): void {
    for (const id of paneIDs) {
        const poster = remove(id);
        if (poster !== null) discardTerminalPoster(poster);
    }
}

/** Test seams. */
export function terminalPosterBytes(): number {
    return totalBytes;
}

export function hasTerminalPoster(paneID: string): boolean {
    return posters.has(paneID);
}

export function resetTerminalPostersForTests(): void {
    for (const poster of posters.values()) discardTerminalPoster(poster);
    posters.clear();
    totalBytes = 0;
}

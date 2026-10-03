/**
 * #326: a PLAIN click on a link in a terminal pane asks where to open it.
 *
 * ⌘-click opens a link straight away in the default browser (CONT-122 / TERM-052, unchanged). A
 * plain click used to do nothing in a shell and only reach the application in a TUI, so there
 * was no way to send a link to a Kelpi web pane at all. This module decides WHEN a plain click
 * is a click on a link; the app owns the menu it then opens.
 *
 * The rules, all of them about not getting in the way of the gestures a click already means:
 *
 *  - **only a single, unmodified left click that followed a recorded press.** A double- or
 *    triple-click selects a word or a line, so the menu waits out macOS's default double-click
 *    interval and any second press (of any button: a right-click raises its own menu) cancels
 *    it: a double-click on a URL never flashes a menu. Any modifier belongs to another gesture
 *    (⌘ is the direct open; ⇧, ⌥ and ⌃ are selection and the application's own).
 *  - **not the end of a drag.** A press that travelled more than a few pixels at ANY point
 *    before its release was a selection, even one that came back to where it started. (The
 *    pane's selection cannot answer this: the engine leaves a one-cell selection behind a plain
 *    click.)
 *  - **the daemon decides what is a link**, through `probe-terminal-target` (the side-effect-free
 *    half of `open-terminal-target`), so the menu offers exactly the links a ⌘-click would open
 *    and nothing it refuses (`link-not-http`, `link-clipped`). Only an `external` answer opens
 *    the menu. The probe is sent AT the click, so it reads the cell the user clicked even when a
 *    TUI redraws in answer to that click; only showing the menu waits.
 *  - **the click is observed, never consumed.** A TUI with mouse tracking on (Claude Code)
 *    still gets its press and release exactly as before.
 *  - **a stale answer is dropped.** Another press, a key, or a scroll between the click and the
 *    daemon's reply means the user has moved on.
 */

/** macOS's default double-click interval (`NSEvent.doubleClickInterval`, 0.5 s). */
export const LINK_MENU_DELAY_MS = 500;

/** How far a press may travel before its release is a drag, not a click. */
export const LINK_CLICK_SLOP_PX = 4;

export interface LinkMenuRequest {
    readonly paneID: string;
    readonly url: string;
    /** Where the menu opens: the pointer, in client coordinates. */
    readonly x: number;
    readonly y: number;
}

export interface LinkClickInput {
    readonly paneID: string;
    readonly cell: { readonly row: number; readonly col: number };
    readonly clientX: number;
    readonly clientY: number;
    readonly button: number;
    /** `MouseEvent.detail`: 1 for a single click, 2 for the second click of a double-click. */
    readonly detail: number;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
}

/** The daemon's `open-terminal-target` answer, reduced to the two fields this reads. */
export interface LinkProbeAnswer {
    readonly opened?: string | undefined;
    readonly url?: string | undefined;
}

export interface LinkClickDeps {
    readonly probe: (paneID: string, row: number, col: number) => Promise<LinkProbeAnswer | null>;
    readonly open: (request: LinkMenuRequest) => void;
    readonly delayMs?: number | undefined;
    readonly setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
    readonly clearTimer?: ((handle: unknown) => void) | undefined;
}

export interface LinkClickTracker {
    /** Every press over the window: cancels a pending menu; a primary one starts the drag measure. */
    pointerDown(clientX: number, clientY: number, button?: number): void;
    /** Pointer motion while a press is held: how far the press has travelled, at its furthest. */
    pointerMove(clientX: number, clientY: number): void;
    /** A click on a terminal cell. Returns true when it was taken as a possible link click. */
    click(input: LinkClickInput): boolean;
    /** A key, a scroll, a blur: whatever was pending is no longer what the user is doing. */
    cancel(): void;
}

export function createLinkClickTracker(deps: LinkClickDeps): LinkClickTracker {
    const delayMs = deps.delayMs ?? LINK_MENU_DELAY_MS;
    const setTimer = deps.setTimer ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms));
    const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let down: { x: number; y: number; travel: number } | null = null;
    let timer: unknown = null;
    // Bumped by anything that supersedes a pending click, so a late probe reply can tell.
    let generation = 0;

    const cancel = (): void => {
        generation += 1;
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
    };

    return {
        pointerDown(clientX, clientY, button = 0) {
            cancel();
            down = button === 0 ? { x: clientX, y: clientY, travel: 0 } : null;
        },
        pointerMove(clientX, clientY) {
            if (down === null) return;
            down.travel = Math.max(down.travel, Math.hypot(clientX - down.x, clientY - down.y));
        },
        click(input) {
            const from = down;
            down = null;
            if (input.button !== 0 || input.detail > 1) {
                cancel();
                return false;
            }
            // No recorded press: a synthesized click (a touch tap, a script), not a mouse click.
            if (from === null) return false;
            if (input.metaKey || input.ctrlKey || input.altKey || input.shiftKey) return false;
            const travel = Math.max(from.travel, Math.hypot(input.clientX - from.x, input.clientY - from.y));
            if (travel > LINK_CLICK_SLOP_PX) return false;
            cancel();
            const mine = generation;
            let waited = false;
            let answer: LinkProbeAnswer | null | undefined;
            const settle = (): void => {
                if (mine !== generation || !waited || answer === undefined) return;
                if (answer?.opened !== 'external' || answer.url === undefined) return;
                deps.open({ paneID: input.paneID, url: answer.url, x: input.clientX, y: input.clientY });
            };
            // Asked now, about the cell as it is now; shown once the double-click window is over.
            void deps.probe(input.paneID, input.cell.row, input.cell.col).then(
                (reply) => {
                    answer = reply;
                    settle();
                },
                // A failed probe is a plain click that found nothing; it is not worth a toast.
                () => {
                    answer = null;
                }
            );
            timer = setTimer(() => {
                timer = null;
                waited = true;
                settle();
            }, delayMs);
            return true;
        },
        cancel
    };
}

/** The URL as the menu's caption: scheme dropped, middle elided past `max` characters. */
export function linkCaption(url: string, max = 48): string {
    const bare = url.replace(/^https?:\/\//i, '');
    if (bare.length <= max) return bare;
    const head = Math.ceil((max - 1) * 0.6);
    const tail = max - 1 - head;
    return `${bare.slice(0, head)}…${bare.slice(bare.length - tail)}`;
}

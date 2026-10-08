/**
 * Middle-click paste's source: the text last selected in a terminal pane, in any Kelpi window
 * (terminal-surface.md section 12.2).
 *
 * X11 calls this PRIMARY and ghostty's macOS app keeps it in a private pasteboard. A browser has
 * neither, so it lives here: in memory, apart from the system clipboard, so that with
 * `copy-on-select` off a selection can still be middle-clicked somewhere without replacing what
 * ⌘C copied.
 *
 * **Across windows.** Every Kelpi window is a page on the same origin, so a `BroadcastChannel`
 * reaches all of them and nothing else: a web pane is its own origin, and a plugin view is a
 * `sandbox="allow-scripts"` iframe whose origin is opaque. A window only hears while it has a
 * terminal mounted (`attachSelectionBuffer`), which is also the only time it can be middle-clicked.
 * A window opened after a selection was made starts empty, and middle-click there falls back to
 * the clipboard until something is selected.
 *
 * Module-level for the reason `state/clipboard.ts`'s offer registry is: one per page, and the panes
 * that feed and read it are mounted far apart.
 */

const CHANNEL = 'kelpi-selection-buffer';

let last: string | null = null;
let channel: BroadcastChannel | null = null;
let attached = 0;

/** A pane made a new selection: it becomes what the next middle-click pastes, everywhere. */
export function recordSelection(text: string): void {
    if (text === '') return;
    last = text;
    channel?.postMessage(text);
}

/** What a middle-click pastes now, or null when nothing has been selected yet. */
export function lastSelection(): string | null {
    return last;
}

/**
 * Listen for other windows' selections while a terminal is mounted here. Reference-counted, so
 * every pane can call it; the channel closes with the last one. Returns the detach.
 */
export function attachSelectionBuffer(): () => void {
    attached += 1;
    if (channel === null && typeof BroadcastChannel === 'function') {
        channel = new BroadcastChannel(CHANNEL);
        channel.onmessage = (event: MessageEvent): void => {
            if (typeof event.data === 'string' && event.data !== '') last = event.data;
        };
    }
    let detached = false;
    return () => {
        if (detached) return;
        detached = true;
        attached -= 1;
        if (attached === 0) {
            channel?.close();
            channel = null;
        }
    };
}

/** Test seam: forget the buffer and close the channel. */
export function resetSelectionBufferForTests(): void {
    last = null;
    attached = 0;
    channel?.close();
    channel = null;
}

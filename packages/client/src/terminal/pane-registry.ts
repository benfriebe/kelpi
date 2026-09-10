/**
 * Live handles onto the mounted terminal panes, keyed by pane id (#81).
 *
 * ## Why a registry, and why a live READ
 *
 * `copy` has to answer one question at the instant the chord is pressed: **what is selected in
 * the focused pane right now?** `TerminalPane` owns the renderer that knows, the app owns the
 * dispatcher that asks, and nothing connected the two: the `onSelectionChange` prop existed and
 * was never passed at either render site (`App.tsx`), so the app kept only a selection *length*
 * for a `data-` attribute.
 *
 * The obvious repair, wiring that prop and caching the last selection in the app, is wrong here,
 * and the vendored engine says exactly why. `SelectionManager.clearSelection()` does **not** fire
 * the change emitter (`vendor/ghostty-web-patched/source/lib/selection-manager.ts:227`), and the
 * mousedown that starts a new selection calls it directly (`:439`). So clicking on blank space
 * after selecting something clears the highlight and tells nobody. A cached selection would still
 * hold the old text, and ⌘C would copy something the user can no longer see highlighted, which is
 * a worse bug than the one being fixed. `renderer.selection()` is already a live read
 * (`renderer.ts:170`, `§TERM-034`); this module is only the wire that lets the app reach it.
 *
 * ## Why module-level rather than a prop or a context
 *
 * The same reason `chrome/modal-presence.ts` is: the reader is the key dispatcher, which is built
 * once from refs and must not go stale, and the writers are pane components mounted anywhere in
 * the grid (including the markdown pane that becomes a terminal for an external `$EDITOR`
 * session). A prop would have to be threaded through the grid's render callbacks to two separate
 * `TerminalPane` sites; a context would have to sit above them and would still need a ref to be
 * readable from the dispatcher. A registry is one map and one lookup.
 *
 * **The registry is also the pane-type test.** `paneHandle(id)` is non-null exactly for panes
 * that have a live terminal renderer, so `copy` needs no knowledge of pane types to decline for a
 * markdown pane, a diff pane or a web pane, and it keeps declining for a terminal pane whose
 * engine has not finished opening. Declining is the dispatcher's fall-through (`chrome/keys.ts`
 * step 7), which is what leaves the Edit menu's own Copy in charge everywhere else.
 *
 * ## C9: it is also how the WINDOW's one key bar finds its terminal
 *
 * The phone key bar used to be a piece of one pane's box (C1 mounted it inside `TerminalPane`), so
 * with the panes split it was drawn inside the active pane instead of across the bottom of the
 * window - the owner's report of 2026-09-08. It is now mounted once, at the bottom of the content
 * area (`terminal/PhoneKeyBar.tsx`), and it has to reach the pane that holds the caret from there.
 *
 * That is the same question this module already answers - "the live terminal for pane X" - so it
 * is answered here rather than in a second registry: the handle grew the four things the bar does
 * to a terminal ({@link TerminalPaneHandle.dispatchKey}, {@link TerminalPaneHandle.pasteText},
 * {@link TerminalPaneHandle.showKeyboard}, {@link TerminalPaneHandle.hideKeyboard}), the node its
 * sticky-modifier interceptor binds to ({@link TerminalPaneHandle.root}), the cell height the
 * keyboard inset is floored at ({@link TerminalPaneHandle.cellHeight}), and the one predicate that
 * used to be the bar's mount condition ({@link TerminalPaneHandle.focusedOnScreen}).
 *
 * The bar also has to RE-READ, which a pull registry alone cannot make it do: a pane registers
 * inside its mount effect, i.e. after the commit that rendered the bar's host, so a host that only
 * pulled would render before the first handle existed and never look again. Hence
 * {@link subscribeTerminalPanes} and {@link terminalPanesVersion} - one counter, bumped on every
 * register, release and {@link notifyTerminalPanes}, which is a `useSyncExternalStore` away from a
 * component that re-reads. Nothing subscribes on a desktop (the host does not subscribe unless the
 * form factor is phone), so a desktop window pays for none of it.
 */

import type { TerminalKeyInit } from './renderer';

export interface TerminalPaneHandle {
    /**
     * The engine's live selection for this pane, `''` when there is none.
     *
     * Read at call time, never pushed: see the module header.
     */
    selection(): string;
    /** Opaque plugin renderers answer a live read over their port, never a cached selection. */
    readSelection?(): Promise<string>;
    /** An isolated renderer applies the phone bar's one-shot modifiers in its own input path. */
    setModifiers?(modifiers: { ctrl: boolean; alt: boolean }): void;
    /**
     * Bytes straight to this pane's PTY, as a KEYSTROKE (#82).
     *
     * The mirrored `input` frame, which is the same one the kitty encoder's presses take, so a
     * chord an action produced reaches a synchronise-input sibling exactly as the keystroke it
     * stands in for would (terminal-surface.md section 8.2). Deliberately not the daemon's
     * `pane send` path: that is programmatic, is never mirrored, and runs the paste filter,
     * which strips the C0 byte this exists to send.
     *
     * A pane whose stream is not up yet swallows the write rather than throwing: the action
     * has already consumed the chord and a rejected promise in a key handler helps nobody.
     */
    write(data: string): void;
    /**
     * C9 - the pane's ROOT node, which is where the key bar binds its sticky-modifier
     * interceptor (`KeyBar.tsx`'s header: above the host, so a capture listener there runs
     * before the kitty interceptor and the engine's own).
     *
     * A getter rather than the node itself, for the reason `selection` is one: the handle
     * outlives nothing, but it is created once per engine start and read whenever the bar
     * re-targets, and a getter cannot go stale.
     */
    root(): HTMLElement | null;
    /**
     * C9 - a key, raised at this pane's engine the way a physical one arrives (C1's routing
     * decision: a synthesized `keydown`, never bytes). False when there was nowhere to send it.
     */
    dispatchKey(init: TerminalKeyInit): boolean;
    /**
     * C9/C4 - text into this pane through the ENGINE's own paste listener, which is where the
     * bracketed-paste envelope is decided (`KeyBar.tsx` `dispatchPaste`).
     */
    pasteText(text: string): boolean;
    /**
     * C9 - put the caret on this pane's engine input, which is what RAISES a software keyboard.
     * The one focus the key bar is allowed, and only from the key that reads Show.
     */
    showKeyboard(): void;
    /** C9 - let the caret go, which is what dismisses a software keyboard. */
    hideKeyboard(): void;
    /** C9 - the engine's cell height in CSS px, the floor the keyboard inset is clamped at. */
    cellHeight(): number;
    /**
     * C9 - this pane is the focused one AND on screen: exactly the condition C1's bar mounted
     * itself under (`focused && visible`), now asked once for the window.
     *
     * Read at call time and announced by {@link notifyTerminalPanes} when the answer changes,
     * because it is the only thing on this handle that moves without the engine moving.
     */
    focusedOnScreen(): boolean;
}

const handles = new Map<string, TerminalPaneHandle>();
const listeners = new Set<() => void>();
/**
 * Bumped by every register, release and {@link notifyTerminalPanes}.
 *
 * A number rather than the map itself, because `useSyncExternalStore` requires a snapshot that
 * does not change identity between reads and a `Map` handed out directly would fail that on the
 * first `getSnapshot` after a render.
 */
let version = 0;

function announce(): void {
    version += 1;
    for (const listener of [...listeners]) listener();
}

/**
 * Publish a pane's handle for as long as its renderer is live. Returns the release.
 *
 * The release deletes only if this exact handle is still the registered one, so a remount that
 * registers before the old effect's cleanup runs (React 18 StrictMode, a pane id reused after a
 * fast close/reopen) cannot have its fresh handle removed by the stale cleanup.
 */
export function registerTerminalPane(paneID: string, handle: TerminalPaneHandle): () => void {
    handles.set(paneID, handle);
    announce();
    return () => {
        if (handles.get(paneID) !== handle) return;
        handles.delete(paneID);
        announce();
    };
}

/**
 * Say that something a handle ANSWERS has changed, without the handle itself changing (C9).
 *
 * The one such thing is {@link TerminalPaneHandle.focusedOnScreen}: a pane takes and loses the
 * ring, and is zoomed away, without its engine going anywhere, and the window's key bar has to
 * appear and disappear with that. Everything else on a handle is read at the instant it is used.
 */
export function notifyTerminalPanes(): void {
    announce();
}

/** Subscribe to registrations, releases and {@link notifyTerminalPanes}. Returns the release. */
export function subscribeTerminalPanes(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The counter a `useSyncExternalStore` snapshot is taken from. See the module header. */
export function terminalPanesVersion(): number {
    return version;
}

/** The live handle for a pane, or `null` when that pane has no mounted terminal renderer. */
export function paneHandle(paneID: string | null | undefined): TerminalPaneHandle | null {
    if (paneID === null || paneID === undefined) return null;
    return handles.get(paneID) ?? null;
}

/** How many panes are registered. Test seam only. */
export function registeredPaneCount(): number {
    return handles.size;
}

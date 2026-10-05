/**
 * What ⌘= / ⌘- / ⌘0 and the View menu's three text-size rows both do (#175).
 *
 * A module rather than three lines inside `App.tsx` for one reason: there are TWO routes to this
 * behaviour and they must be one gesture. The chord arrives through the window dispatcher, which
 * applies §7.2's gates on the way; the menu row arrives as a `menu-command` over the daemon
 * socket, which applies none of them. A guard written only into the dispatcher is therefore a
 * guard the menu row walks straight past, which is exactly the defect this file exists to hold
 * closed: with an embedded remote workspace filling the pane area, the row would have resized the
 * LOCAL daemon's terminals while the person was looking at a remote pane.
 *
 * Two rules, in order.
 *
 * 1. **Not while a remote workspace is selected.** §1.7: the window's local pane keymap stands
 *    down while `RemoteWorkspaceView` fills the pane area, and this window's settings surface
 *    holds the PRIMARY daemon's snapshot and its verbs - there is no per-remote settings surface
 *    and `KelpiRuntime` exposes no settings verb. Stepping here would write the wrong daemon's
 *    config, so both routes decline, which is what config-keybindings.md §7.6 promises.
 *
 * 2. **The more specific surface wins.** A focused markdown PREVIEW has had its own font size on
 *    these chords since §3.16. So the preview is offered the press first and the terminal size
 *    takes what it declines - the same shape `toggle_search` uses to route ⌘F between a content
 *    pane's find bar and the terminal's scrollback search. This is also what keeps a markdown
 *    pane's behaviour byte-identical through #175's move of the three chords from the
 *    `*_markdown_font_size` actions to these.
 *
 * 3. **`font-size-scope` picks which terminal size.** `pane` (the default) steps the focused
 *    terminal pane's OWN size and leaves every other pane alone, which is how the Swift app's
 *    libghostty surfaces behaved; `all` steps the daemon-wide ghostty `font-size`, #175's
 *    original shape. Under `pane`, a focused pane that is not a terminal declines, so the chord
 *    falls through rather than resizing everything behind the person's back.
 *
 * Returning false means "my condition did not hold": the chord falls through untouched (§7.2
 * step 7) and the menu row does nothing. Nothing here raises a toast, including at the slider's
 * own minimum and maximum, where the settings surface's unchanged-commit rule writes nothing.
 */

import { PANE_FONT_SIZE_MAX, PANE_FONT_SIZE_MIN } from '@kelpi/protocol';

import type { FontSizeStep } from '../content';

export interface TextSizeStepDeps {
    /** §1.7 - an embedded remote daemon's workspace is what fills the pane area right now. */
    readonly remoteWorkspaceSelected: () => boolean;
    /** The focused markdown preview's own font size; false when the focused pane is not one. */
    readonly previewStep: (step: FontSizeStep) => boolean;
    /** `font-size-scope`, read at press time. */
    readonly scope: () => 'pane' | 'all';
    /** The focused terminal pane's own size; false when the focused pane is not a terminal. */
    readonly paneStep: (step: FontSizeStep) => boolean;
    /** The daemon-wide terminal size, through the settings surface's one write path. */
    readonly daemonStep: (step: FontSizeStep) => boolean;
}

export function createTextSizeStep(deps: TextSizeStepDeps): (step: FontSizeStep) => boolean {
    return (step: FontSizeStep): boolean => {
        if (deps.remoteWorkspaceSelected()) return false;
        if (deps.previewStep(step)) return true;
        return deps.scope() === 'pane' ? deps.paneStep(step) : deps.daemonStep(step);
    };
}

export interface PaneTextSizeDeps {
    /**
     * The pane's own size (null = it follows the default), or undefined when the pane is gone or
     * does not render a terminal.
     */
    readonly ownSize: (paneID: string) => number | null | undefined;
    /** The size a pane with none of its own is drawn at: the ghostty `font-size`, or 13. */
    readonly defaultSize: () => number;
    /** `pane-font-size`; null drops the pane's own size. Settles when the daemon has answered. */
    readonly send: (paneID: string, size: number | null) => Promise<unknown>;
}

/**
 * ⌘= / ⌘- / ⌘0 on ONE terminal pane: the size it is drawn at, one point up or down, clamped to
 * the Font size row's 8-32; ⌘0 drops its own size.
 *
 * A step that lands back on the default stores null rather than the number, so a pane zoomed in
 * and back out follows the Font size row again instead of pinning today's value.
 *
 * A held-down chord repeats faster than the daemon answers, so each press starts from the size
 * this window last ASKED for while any earlier ask for that pane is still in flight, not from
 * the store's newest broadcast; otherwise the repeats would each re-send the first step (the
 * same reason the daemon-wide path goes through the settings surface's `pendingValue`). A step
 * that changes nothing (already at 32, already following the default) is consumed with nothing
 * sent, as the settings surface does at the slider's ends.
 */
export function createPaneTextSizeStep(deps: PaneTextSizeDeps): (paneID: string, step: FontSizeStep) => boolean {
    const pending = new Map<string, { size: number | null; inFlight: number }>();
    return (paneID: string, step: FontSizeStep): boolean => {
        const stored = deps.ownSize(paneID);
        if (stored === undefined) return false;
        const asked = pending.get(paneID);
        const current = asked === undefined ? stored : asked.size;
        const fallback = deps.defaultSize();
        let next: number | null = null;
        if (step !== 'reset') {
            const from = current ?? fallback;
            const stepped = Math.max(PANE_FONT_SIZE_MIN, Math.min(PANE_FONT_SIZE_MAX, from + (step === 'increase' ? 1 : -1)));
            next = stepped === fallback ? null : stepped;
        }
        if (next === current) return true;
        const entry = { size: next, inFlight: (asked?.inFlight ?? 0) + 1 };
        pending.set(paneID, entry);
        const settle = (): void => {
            const now = pending.get(paneID);
            if (now === undefined) return;
            if (now.inFlight <= 1) pending.delete(paneID);
            else pending.set(paneID, { size: now.size, inFlight: now.inFlight - 1 });
        };
        void deps.send(paneID, next).then(settle, settle);
        return true;
    };
}

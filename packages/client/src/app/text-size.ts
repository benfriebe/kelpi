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
 *    these chords since §3.16; the terminal size is the daemon's. So the preview is offered the
 *    press first and the daemon's setting takes what it declines - the same shape `toggle_search`
 *    uses to route ⌘F between a content pane's find bar and the terminal's scrollback search.
 *    This is also what keeps a markdown pane's behaviour byte-identical through #175's move of
 *    the three chords from the `*_markdown_font_size` actions to these.
 *
 * Returning false means "my condition did not hold": the chord falls through untouched (§7.2
 * step 7) and the menu row does nothing. Nothing here raises a toast, including at the slider's
 * own minimum and maximum, where the settings surface's unchanged-commit rule writes nothing.
 */

import type { FontSizeStep } from '../content';

export interface TextSizeStepDeps {
    /** §1.7 - an embedded remote daemon's workspace is what fills the pane area right now. */
    readonly remoteWorkspaceSelected: () => boolean;
    /** The focused markdown preview's own font size; false when the focused pane is not one. */
    readonly previewStep: (step: FontSizeStep) => boolean;
    /** The daemon-wide terminal size, through the settings surface's one write path. */
    readonly daemonStep: (step: FontSizeStep) => boolean;
}

export function createTextSizeStep(deps: TextSizeStepDeps): (step: FontSizeStep) => boolean {
    return (step: FontSizeStep): boolean => {
        if (deps.remoteWorkspaceSelected()) return false;
        return deps.previewStep(step) || deps.daemonStep(step);
    };
}

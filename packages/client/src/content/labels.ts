/**
 * §L46 — the accessible names for content-pane bodies.
 *
 * The Swift has no `accessibilityLabel` on any of these views (`MarkdownPaneView.swift:64-82`,
 * `MarkdownEditorView.swift:20-40`): AppKit names an `NSView` from its hierarchy, so there is no
 * string here to port and the port cannot simply drop the name either — an `<iframe>` with no
 * `title` and a bare `<textarea>` are worse than an imperfect one.
 *
 * So the rule is the register's: never speak a raw pane UUID. The names below are
 * "<what it is> <the document's own name> <four hex characters>" — the file name is what a
 * reader is actually looking at, and the short id is what keeps two panes on the same file
 * distinguishable when a screen reader lists the frames. A 36-character hex string read out in
 * full identified nothing.
 */

import { basename } from '../grid/PaneHeader';

/**
 * The last four hex characters of a pane id — one spoken token, and unique in practice for the
 * handful of panes a window holds (the same shortening the audit notes use for pane ids).
 */
export function paneShortID(paneID: string): string {
    const hex = paneID.replace(/-/g, '');
    return hex.length <= 4 ? hex : hex.slice(-4);
}

/**
 * `markdown preview NOTES.md 0002`, or `markdown preview 0002` when the pane has no file behind
 * it (a scratchpad, or a diff scoped to the whole repo).
 */
export function contentPaneLabel(kind: string, paneID: string, filePath?: string | null): string {
    const name = filePath === null || filePath === undefined ? '' : basename(filePath).trim();
    const short = paneShortID(paneID);
    return name === '' ? `${kind} ${short}` : `${kind} ${name} ${short}`;
}

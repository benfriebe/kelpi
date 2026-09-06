/**
 * The three macOS line-editing chords, as terminal bytes (#82).
 *
 * Spec: docs/config-keybindings.md section 4 (category "Terminal"), docs/terminal-surface.md
 * section 10.3.
 *
 * ## What the user reported
 *
 * "CMD+BACKSPACE doesn't clear the full line (sometimes?)". On macOS the convention, and
 * Ghostty's shipped default, is that ⌘Backspace kills the line back to the start. Kelpi sent one
 * DEL instead, and under the kitty keyboard protocol it sent `CSI 127;9u`, which a TUI ignores
 * entirely. That is the "sometimes": one character in a shell pane, nothing at all in an agent
 * pane.
 *
 * Verified against the vendored `ghostty-vt.wasm` key encoder, which is where the DEL comes
 * from: `super+Backspace` encodes to `0x7f`, byte-identical to a bare Backspace, because the
 * legacy encoding has no super. Nothing above it mapped the chord to anything else.
 *
 * ## Ghostty's set, matched exactly
 *
 * `ghostty-org/ghostty`, `src/config/Config.zig:7315-7334`, in the darwin branch of
 * `Keybinds.init`, under the comment "Natural text editing keybinds":
 *
 * ```zig
 * .{ .key = .{ .physical = .arrow_right }, .mods = .{ .super = true } },  .{ .text = "\x05" },
 * .{ .key = .{ .physical = .arrow_left  }, .mods = .{ .super = true } },  .{ .text = "\x01" },
 * .{ .key = .{ .physical = .backspace   }, .mods = .{ .super = true } },  .{ .text = "\x15" },
 * ```
 *
 * `0x15` is `ctrl+u`, readline's `unix-line-discard`; `0x01` and `0x05` are `ctrl+a` and
 * `ctrl+e`, beginning-of-line and end-of-line. The same block also carries `alt+arrow_left` ->
 * `esc b` and `alt+arrow_right` -> `esc f`; those are Option chords rather than ⌘ chords and are
 * deliberately left out of #82, which is about the ⌘ set.
 *
 * ## Why named actions rather than a `text:` binding
 *
 * Ghostty spells these as `text:` payloads. Kelpi's binding grammar cannot: a `keybind` value is
 * split at its last `=` and the right-hand side must be a known `KelpiAction`
 * (`packages/core/src/config/bindings.ts` `parseKeybindValue`, docs/config-keybindings.md
 * section 1.4). Giving actions a payload would change the parser, the config writer's diff
 * algorithm (section 5.3), the Settings recorder and the whole action vocabulary, for three
 * chords. Three named actions cost one line each and stay inside every existing mechanism:
 * rebindable, unbindable, listed in Settings, shown in the Help overlay.
 *
 * ## Why the binding layer rather than the kitty encoder
 *
 * The mapping has to sit ABOVE the kitty layer so an application that negotiated the protocol
 * still gets the byte the convention promises rather than a super chord it has no meaning for.
 * A bound chord is consumed by the app's window-level dispatcher before the pane's capture-phase
 * interceptor ever runs, so binding IS "above" it.
 *
 * And it has to be a binding rather than an encoder exemption (#80's shape) so that `unbind`
 * can reach it. Ghostty's own comment on this block says so: "This forces these keys to go back
 * to legacy encoding (not fixterms) [...] If people want to get back to the fixterm encoding
 * they can set the keybinds to `unbind`." With `keybind = super+backspace=unbind` in the config,
 * ⌘Backspace is unclaimed again and the kitty encoder produces `CSI 127;9u` exactly as before.
 */

import type { KelpiAction } from '@kelpi/core/config';

/** ctrl+u: kill the line back to the start (readline `unix-line-discard`). */
export const KILL_LINE_BACKWARD_BYTE = '\x15';
/** ctrl+a: beginning of line. */
export const MOVE_TO_LINE_START_BYTE = '\x01';
/** ctrl+e: end of line. */
export const MOVE_TO_LINE_END_BYTE = '\x05';

/** The action to the single byte it sends. Ghostty's darwin defaults, byte for byte. */
export const LINE_EDIT_BYTES: Readonly<Partial<Record<KelpiAction, string>>> = {
    kill_line_backward: KILL_LINE_BACKWARD_BYTE,
    move_to_line_start: MOVE_TO_LINE_START_BYTE,
    move_to_line_end: MOVE_TO_LINE_END_BYTE
};

export interface LineEditDeps {
    readonly focusedPaneID: () => string | null;
    /**
     * Write bytes to that pane's PTY, or `null` when it has no live terminal renderer.
     *
     * `null` is the pane-type test, exactly as it is for `copy`: a markdown pane, a diff pane
     * and a web pane all answer `null` and the chord falls through untouched.
     */
    readonly writerFor: (paneID: string) => ((data: string) => void) | null;
}

/**
 * Send one line-editing action's byte to the focused terminal pane.
 *
 * Returns true when the chord is consumed, false to fall through (docs/config-keybindings.md
 * section 7.2 step 7). An action outside `LINE_EDIT_BYTES` returns false rather than writing
 * nothing and claiming the key.
 */
export function sendLineEdit(action: KelpiAction, deps: LineEditDeps): boolean {
    const bytes = LINE_EDIT_BYTES[action];
    if (bytes === undefined) return false;
    const paneID = deps.focusedPaneID();
    if (paneID === null) return false;
    const write = deps.writerFor(paneID);
    if (write === null) return false;
    write(bytes);
    return true;
}

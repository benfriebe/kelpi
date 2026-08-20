/**
 * Browser-shortcut forwarding from an embedded page back to Nex's own window.
 *
 * The problem this solves is structural to the port, and it has no equivalent in the Swift app.
 * There, a web pane is a `WKWebView` *inside* the app's window, and `NexCommands`' NSEvent
 * monitor sees ⌘F / ⌘L / ⌘T before the web view ever does. Here the page lives in a
 * `WebContentsView` — a **separate renderer with its own keyboard focus** — so the moment a user
 * clicks the page, every chord goes to the page and Nex's renderer never sees a keystroke. The
 * whole priority key layer (WEB-152/TERM-156) would be dead the instant it was needed.
 *
 * So the host intercepts exactly the chords that layer claims, cancels them in the page, and
 * replays them into the shell window's own renderer — which is where the layer lives. Everything
 * else (⌘C, ⌘A, typing, the page's own shortcuts) is left completely alone: a page that binds
 * ⌘K for its command palette keeps it.
 *
 * The set is deliberately the priority table **plus ⌘F**, because ⌘F over a web pane means
 * Nex's find bar (web-pane.md §10), not Chromium's.
 */

/** The subset of Electron's `Input` shape this module reads. */
export interface ChordInput {
    readonly type: string;
    readonly key: string;
    readonly code: string;
    readonly meta: boolean;
    readonly shift: boolean;
    readonly control: boolean;
    readonly alt: boolean;
    readonly isAutoRepeat?: boolean | undefined;
}

/**
 * A chord to replay in Nex's own window.
 *
 * `code` is the physical key (`KeyboardEvent.code`), which is what the client's dispatcher
 * matches on; `shift` is the only modifier that varies, because ⌘ is required by construction
 * and ⌃/⌥ are refused.
 */
export interface ForwardedChord {
    readonly code: string;
    readonly shift: boolean;
}

/** The `menu-command` string the relay carries: `web-chord:<code>` or `web-chord:<code>:shift`. */
export const WEB_CHORD_COMMAND_PREFIX = 'web-chord:';

export function chordCommand(chord: ForwardedChord): string {
    return `${WEB_CHORD_COMMAND_PREFIX}${chord.code}${chord.shift ? ':shift' : ''}`;
}

/**
 * The physical keys the layer claims, by `KeyboardEvent.code`.
 *
 * `code` rather than `key`: it is layout-independent, and it is the same identity the client's
 * dispatcher matches on, so a non-US keyboard forwards exactly the chord it would have handled.
 */
const FORWARDED: ReadonlySet<string> = new Set([
    'KeyF',
    'KeyL',
    'KeyR',
    'KeyT',
    'KeyW',
    'ArrowLeft',
    'ArrowRight',
    'BracketLeft',
    'BracketRight',
    'Equal',
    'Minus',
    'Digit0'
]);

/** Chords that only belong to Nex WITH shift (tab cycling); bare ⌘[ / ⌘] stay with the page. */
const SHIFT_ONLY: ReadonlySet<string> = new Set(['BracketLeft', 'BracketRight']);

/**
 * Should this keystroke be taken from the page and given to Nex?
 *
 * Rules, in order:
 *   - key-downs only (a forwarded key-up would double-fire the binding);
 *   - ⌘ held, and neither ⌃ nor ⌥ (those are the page's, and Nex claims none of them);
 *   - the physical key is in the table above;
 *   - ⌘⇧[ / ⌘⇧] are ours, bare ⌘[ / ⌘] are not — the Swift app leaves those to focus prev/next,
 *     and inside a page they are back/forward, which the page may itself want (SET-189);
 *   - every other chord may carry shift freely (⌘⇧= is ⌘+, which zooms in).
 */
export function forwardedChord(input: ChordInput): ForwardedChord | null {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return null;
    if (!input.meta || input.control || input.alt) return null;
    if (!FORWARDED.has(input.code)) return null;
    if (SHIFT_ONLY.has(input.code) && !input.shift) return null;
    return { code: input.code, shift: input.shift };
}

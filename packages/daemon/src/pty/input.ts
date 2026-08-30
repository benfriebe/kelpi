/**
 * TerminalInput — programmatic input encoding for `pane send` / `pane send-key`.
 *
 * Spec: docs/current/terminal-surface.md §9.1 (paste framing + Enter-as-keystroke),
 * §9.2 (named-key table, DECCKM-aware arrows, raw-byte ctrl-c), §15.5–15.6;
 * docs/current/wire-protocol.md §5.6 (vocabulary + the exact unknown-key error string).
 *
 * Both paths must work with **zero clients attached**, so every byte is produced here, in
 * the daemon, from the pane's live VT modes. Neither path mirrors to sync siblings: §8.2
 * lists programmatic sends as explicitly not mirrored, hence `writeDirect`.
 */

import { parseNamedKey, unknownNamedKeyError } from '@kelpi/protocol';
import type { NamedKey } from '@kelpi/protocol';
import type { PtyManager, TerminalInput, VtModes } from '../seams.js';

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

/** The Enter that follows `pane send` text — a keystroke, deliberately outside the envelope. */
export const ENTER_BYTES = '\r';

/** VT state assumed for a pane whose terminal state is unknown (both modes off = defaults). */
export const DEFAULT_VT_MODES: VtModes = {
    applicationCursorKeys: false,
    bracketedPaste: false
};

/**
 * Thrown by `sendNamedKey` for a name outside the §5.6 vocabulary. The handler turns this
 * into `{"ok":false,"error":<message>}`; the message is byte-for-byte the Swift app's.
 */
export class UnknownNamedKeyError extends Error {
    readonly key: string;

    constructor(key: string) {
        super(unknownNamedKeyError(key));
        this.name = 'UnknownNamedKeyError';
        this.key = key;
    }
}

export function isUnknownNamedKeyError(error: unknown): error is UnknownNamedKeyError {
    return error instanceof UnknownNamedKeyError;
}

/** Byte-mapped keys (§9.2): the raw byte goes to the PTY so the line discipline sees it. */
const BYTE_KEYS: Partial<Record<NamedKey, string>> = {
    enter: '\r',
    return: '\r',
    tab: '\t',
    escape: '\x1b',
    esc: '\x1b',
    space: ' ',
    backspace: '\x7f',
    // mods=NONE + raw ETX, never mods=CTRL: a CSI-u encoding would never raise SIGINT.
    'ctrl-c': '\x03'
};

/** Final byte of the arrow sequence, shared by both cursor-key modes. */
const ARROW_FINALS: Partial<Record<NamedKey, string>> = {
    up: 'A',
    down: 'B',
    right: 'C',
    left: 'D'
};

/**
 * §9.2: arrows carry no text, so the encoding follows the pane's live DECCKM state —
 * application cursor keys → `ESC O <final>`, normal → `ESC [ <final>`. Hardcoding the CSI
 * form breaks every TUI that turns DECCKM on (vim, less, claude).
 */
export function encodeNamedKey(key: NamedKey, modes: VtModes): string {
    const byteKey = BYTE_KEYS[key];
    if (byteKey !== undefined) return byteKey;
    const final = ARROW_FINALS[key];
    /* c8 ignore next -- the vocabulary is exhaustively covered by the two tables above */
    if (final === undefined) return '';
    return modes.applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
}

const ENVELOPE_PATTERN = /\x1b\[20[01]~/g;
// C0 controls minus TAB and CR (LF is normalized to CR first), plus DEL.
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * The paste pipeline's filter half (§9.1, port note 2). Ghostty runs pasted text through
 * unsafe-paste protection before the envelope; Kelpi auto-confirms those prompts (§12.2), so
 * the daemon does the filtering itself:
 *
 * 1. embedded `ESC[200~` / `ESC[201~` are removed — pasted text can never close (or fake)
 *    its own bracketed-paste envelope;
 * 2. newlines normalize to CR, the byte a terminal actually receives for Enter;
 * 3. remaining C0 controls and DEL are dropped (TAB survives) so a payload cannot smuggle
 *    escape sequences into the pane.
 */
export function filterPasteText(text: string): string {
    return text
        .replace(ENVELOPE_PATTERN, '')
        .replace(/\r\n?|\n/g, '\r')
        .replace(CONTROL_PATTERN, '');
}

/** §9.1: envelope only when the foreground app asked for bracketed paste. */
export function encodePasteText(text: string, modes: VtModes): string {
    const filtered = filterPasteText(text);
    if (filtered === '') return '';
    return modes.bracketedPaste
        ? `${BRACKETED_PASTE_START}${filtered}${BRACKETED_PASTE_END}`
        : filtered;
}

export type VtModesLookup = (paneID: string) => VtModes;

export interface TerminalInputOptions {
    /** Only `writeDirect` is used: programmatic sends never mirror to sync siblings (§8.2). */
    readonly pty: Pick<PtyManager, 'writeDirect'>;
    /** Live VT modes for the pane (bracketed paste + DECCKM); missing pane → defaults. */
    readonly modes: VtModesLookup;
}

class TerminalInputImpl implements TerminalInput {
    private readonly pty: Pick<PtyManager, 'writeDirect'>;
    private readonly lookupModes: VtModesLookup;

    constructor(options: TerminalInputOptions) {
        this.pty = options.pty;
        this.lookupModes = options.modes;
    }

    /**
     * Text as a paste, then Enter as a separate keystroke — the load-bearing framing from
     * §9.1. Two writes, never one: with bracketed paste on, the Enter must land outside the
     * envelope so a TUI treats it as a real submit.
     */
    sendText(paneID: string, text: string, opts: { bare: boolean }): void {
        const payload = encodePasteText(text, this.modesFor(paneID));
        if (payload !== '') this.pty.writeDirect(paneID, payload);
        if (!opts.bare) this.pty.writeDirect(paneID, ENTER_BYTES);
    }

    /** Validation happens before any write; unknown names throw (§9.2, wire §5.6). */
    sendNamedKey(paneID: string, key: string): void {
        const named = parseNamedKey(key);
        if (named === undefined) throw new UnknownNamedKeyError(key);
        this.pty.writeDirect(paneID, encodeNamedKey(named, this.modesFor(paneID)));
    }

    /** A pane whose VT state is gone must still accept input; fall back to mode defaults. */
    private modesFor(paneID: string): VtModes {
        try {
            return this.lookupModes(paneID) ?? DEFAULT_VT_MODES;
        } catch {
            return DEFAULT_VT_MODES;
        }
    }
}

export function createTerminalInput(options: TerminalInputOptions): TerminalInput {
    return new TerminalInputImpl(options);
}

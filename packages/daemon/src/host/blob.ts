/**
 * The checkpoint blob a daemon leaves with the host at a handoff (`docs/terminal-host.md` §5).
 *
 * Opaque to the host, which only stores it. Layout: `u32 headerLength | header JSON | snapshot`,
 * so the VT stream (every ESC of it) travels as raw bytes rather than JSON-escaped. The header is
 * versioned; a daemon that cannot read a blob treats the terminal as if it had no checkpoint.
 */

import type { KittyState } from '../term/kitty-keyboard.js';
import { isMouseFormat, type MouseFormat } from '../term/mouse-modes.js';
import type { TerminalCheckpoint } from '../term/service.js';

export const HANDOFF_BLOB_VERSION = 1;

export interface HandoffState extends TerminalCheckpoint {
    /** The pane title (OSC 0/2), which the store does not persist. */
    readonly title: string | null;
}

interface Header {
    readonly v: number;
    readonly cols: number;
    readonly rows: number;
    readonly kitty: KittyState;
    readonly mouseFormat: MouseFormat;
    readonly title: string | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeHandoffBlob(state: HandoffState): Uint8Array {
    const header: Header = {
        v: HANDOFF_BLOB_VERSION,
        cols: state.cols,
        rows: state.rows,
        kitty: state.kitty,
        mouseFormat: state.mouseFormat,
        title: state.title
    };
    const json = encoder.encode(JSON.stringify(header));
    const out = new Uint8Array(4 + json.length + state.snapshot.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    out.set(state.snapshot, 4 + json.length);
    return out;
}

function isStack(value: unknown): value is { flags: number; stack: number[] } {
    if (typeof value !== 'object' || value === null) return false;
    const { flags, stack } = value as { flags?: unknown; stack?: unknown };
    return (
        typeof flags === 'number' &&
        Array.isArray(stack) &&
        stack.length <= 64 &&
        stack.every((entry) => typeof entry === 'number')
    );
}

const isSize = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000;

/** The state in a blob, or null for anything malformed or from an unknown version. */
export function decodeHandoffBlob(blob: Uint8Array): HandoffState | null {
    if (blob.length < 4) return null;
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const length = view.getUint32(0);
    if (blob.length < 4 + length) return null;
    let header: Partial<Header>;
    try {
        header = JSON.parse(decoder.decode(blob.subarray(4, 4 + length))) as Partial<Header>;
    } catch {
        return null;
    }
    if (header.v !== HANDOFF_BLOB_VERSION || !isSize(header.cols) || !isSize(header.rows)) return null;
    const kitty = header.kitty;
    if (kitty === undefined || !isStack(kitty.normal) || !isStack(kitty.alternate)) return null;
    if (!isMouseFormat(header.mouseFormat)) return null;
    const title = typeof header.title === 'string' ? header.title : null;
    return {
        cols: header.cols,
        rows: header.rows,
        kitty,
        mouseFormat: header.mouseFormat,
        title,
        snapshot: blob.slice(4 + length)
    };
}

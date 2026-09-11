/**
 * PTY stream frames — the binary half of the client-sync protocol.
 *
 * Frame layout: `[1-byte type][16-byte paneID][payload]`. The pane id rides as raw UUID
 * bytes (big-endian, RFC 4122 field order) so demultiplexing costs no JSON parse per chunk
 * and terminal bytes never enter the client store.
 *
 * Flow control is ack-based: the daemon streams `output` frames and tracks unacked bytes
 * per (client, pane); a client sends an `ack` frame after feeding bytes to its terminal.
 * Once unacked bytes exceed `PTY_FLOW_CONTROL_WINDOW_BYTES` the daemon stops draining that
 * pane's ring buffer for that client (the PTY itself keeps running — a slow client must not
 * stall the process or other viewers).
 *
 * One PAIR on this channel, and the only one: `replayGrid` immediately followed by `replay`
 * for the same pane (kelpi #166). A serialised screen only means what it says at the column
 * count it was taken at, and the client that rendered it is not always the client whose
 * measurement the PTY follows — so the snapshot states its own grid, in its own frame, ahead
 * of itself. See `replayGrid` below for why it is a separate frame rather than a header on the
 * replay payload (an old client writes a replay's payload straight into its engine, so a
 * prefix would paint four bytes of garbage) and for what each side does without the other's
 * half.
 */

export const PTY_FRAME_TYPES = {
    /** server → client: live PTY output. */
    output: 0x01,
    /** client → server: keyboard / paste bytes (mirrored to sync siblings, terminal-surface.md §8.2). */
    input: 0x02,
    /** client → server: bytes consumed since the last ack (uint32 BE). */
    ack: 0x03,
    /** client → server: cols/rows (two uint16 BE). */
    resize: 0x04,
    /** server → client: attach replay (snapshot bytes) sent before the first `output`. */
    replay: 0x05,
    /**
     * client → server: input bytes that belong to THIS pane only and are never mirrored into
     * a synchronise-input sibling: client-encoded mouse reports and kitty key releases
     * (terminal-surface.md §8.2, §10.2, §11; issue #51). A mouse report carries cell
     * coordinates measured against the source pane's grid, and a sibling in a different
     * mouse mode (or none) would receive them as typed garbage, so the split is made on the
     * wire rather than by inspecting bytes in the daemon. An older daemon ignores the type
     * (forward-compat rule in `decodePtyFrame`), which degrades to "no mouse reporting"
     * rather than to fan-out.
     */
    inputDirect: 0x06,
    /**
     * server → client: the grid the NEXT `replay` frame for this pane was serialised at
     * (cols/rows, the same two uint16 BE a `resize` carries — `decodeResizePayload` reads it).
     *
     * **Why the snapshot needs to say how wide it is (kelpi #166).** A serialised screen is
     * not width-independent. `@xterm/addon-serialize` emits a soft-wrapped row and its
     * continuation with NO newline between them, because the row's `isWrapped` says the
     * replaying terminal will wrap it again at the same column — true only if that terminal
     * has the same column count. PTY geometry follows exactly ONE client (`sizeOwnerID`,
     * `daemon/src/ws/sync.ts`), so every other attached client renders a snapshot taken at
     * somebody else's width, and each wrapped pair landed side by side on one row of a wider
     * engine: a fixed-stride garble at the owner's column count, steady by construction.
     * Nothing on the wire carried the number, so no client could even know.
     *
     * Sent immediately before EVERY `replay` (attach, settled-resize resync, flow-control
     * re-seed), in the same synchronous turn, so the pair cannot be separated. Its bytes are
     * NOT charged to the flow-control window: the client acks what it feeds its engine, and
     * this frame is never fed to anything (see `ws/streams.ts` `sendReplayWithGrid`).
     *
     * Backward compatible in both directions. An old client drops the frame as an unknown
     * type (`decodePtyFrame` below) and behaves exactly as it did. A new client on an old
     * daemon sees no grid and keeps its own measurement, which is also exactly as it was — so
     * the geometry is advisory on arrival and must never be applied on its own: a client holds
     * it until the replay it belongs to actually lands (`client/src/connection/pty.ts`).
     * Resizing an engine that is then not re-seeded would leave it holding a grid it has never
     * been told the contents of, which is the one state §N24's paint hold exists to hide.
     */
    replayGrid: 0x07
} as const;

export type PtyFrameTypeName = keyof typeof PTY_FRAME_TYPES;
export type PtyFrameType = (typeof PTY_FRAME_TYPES)[PtyFrameTypeName];

export const PTY_FRAME_HEADER_BYTES = 17;

/** Unacked bytes per (client, pane) before the daemon pauses that stream. */
export const PTY_FLOW_CONTROL_WINDOW_BYTES = 512 * 1024;

const HEX = '0123456789ABCDEF';

/** 16 raw bytes from a canonical UUID string, or undefined when it isn't one. */
export function uuidToBytes(uuid: string): Uint8Array | undefined {
    const hex = uuid.replace(/-/g, '');
    if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) return undefined;
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

/** Canonical uppercase UUID string from 16 bytes at `offset`. */
export function uuidFromBytes(bytes: Uint8Array, offset = 0): string | undefined {
    if (bytes.length - offset < 16) return undefined;
    let out = '';
    for (let index = 0; index < 16; index += 1) {
        const byte = bytes[offset + index] as number;
        out += HEX[(byte >> 4) & 0xf];
        out += HEX[byte & 0xf];
        if (index === 3 || index === 5 || index === 7 || index === 9) out += '-';
    }
    return out;
}

export interface PtyFrame {
    readonly type: PtyFrameType;
    readonly paneID: string;
    readonly payload: Uint8Array;
}

const EMPTY = new Uint8Array(0);

export function encodePtyFrame(type: PtyFrameType, paneID: string, payload: Uint8Array = EMPTY): Uint8Array | undefined {
    const idBytes = uuidToBytes(paneID);
    if (idBytes === undefined) return undefined;
    const frame = new Uint8Array(PTY_FRAME_HEADER_BYTES + payload.length);
    frame[0] = type;
    frame.set(idBytes, 1);
    frame.set(payload, PTY_FRAME_HEADER_BYTES);
    return frame;
}

const KNOWN_TYPES: ReadonlySet<number> = new Set(Object.values(PTY_FRAME_TYPES));

/** Undefined for a truncated frame or an unknown frame type (forward-compat: ignore it). */
export function decodePtyFrame(frame: Uint8Array): PtyFrame | undefined {
    if (frame.length < PTY_FRAME_HEADER_BYTES) return undefined;
    const type = frame[0] as number;
    if (!KNOWN_TYPES.has(type)) return undefined;
    const paneID = uuidFromBytes(frame, 1);
    if (paneID === undefined) return undefined;
    return {
        type: type as PtyFrameType,
        paneID,
        payload: frame.subarray(PTY_FRAME_HEADER_BYTES)
    };
}

/** `ack` payload: bytes consumed since the previous ack (uint32 BE, saturating). */
export function encodeAckPayload(bytes: number): Uint8Array {
    const clamped = Math.max(0, Math.min(0xffffffff, Math.trunc(bytes)));
    const payload = new Uint8Array(4);
    payload[0] = (clamped >>> 24) & 0xff;
    payload[1] = (clamped >>> 16) & 0xff;
    payload[2] = (clamped >>> 8) & 0xff;
    payload[3] = clamped & 0xff;
    return payload;
}

export function decodeAckPayload(payload: Uint8Array): number | undefined {
    if (payload.length < 4) return undefined;
    return (
        ((payload[0] as number) * 0x1000000 +
            ((payload[1] as number) << 16) +
            ((payload[2] as number) << 8) +
            (payload[3] as number)) >>>
        0
    );
}

/** `resize` payload: cols then rows, uint16 BE each. */
export function encodeResizePayload(cols: number, rows: number): Uint8Array {
    const payload = new Uint8Array(4);
    const safeCols = Math.max(0, Math.min(0xffff, Math.trunc(cols)));
    const safeRows = Math.max(0, Math.min(0xffff, Math.trunc(rows)));
    payload[0] = (safeCols >>> 8) & 0xff;
    payload[1] = safeCols & 0xff;
    payload[2] = (safeRows >>> 8) & 0xff;
    payload[3] = safeRows & 0xff;
    return payload;
}

export interface PtyResize {
    readonly cols: number;
    readonly rows: number;
}

export function decodeResizePayload(payload: Uint8Array): PtyResize | undefined {
    if (payload.length < 4) return undefined;
    return {
        cols: ((payload[0] as number) << 8) | (payload[1] as number),
        rows: ((payload[2] as number) << 8) | (payload[3] as number)
    };
}

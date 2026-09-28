/**
 * The terminal host's wire format (`docs/terminal-host.md` §3).
 *
 * A frame is `u32 length (big-endian) | u8 type | payload`, where `length` counts the payload
 * only. Control frames carry UTF-8 JSON. The three frames that carry bytes use a binary layout so
 * terminal output is never base64'd or JSON-escaped:
 *
 *   write       u8 tidLength | tid | bytes
 *   data        u8 tidLength | tid | f64 offset | bytes
 *   checkpoint  u32 jsonLength | json | blob       (and `attached`, the same shape)
 *
 * Kept deliberately small: the host is meant to outlive many daemon versions, so every message
 * here is one a future daemon must still be able to speak (§11).
 */

/** Names the run-dir socket (`terminal-host-v<N>.sock`); bump only with a migration (§11). */
export const HOST_PROTOCOL_VERSION = 1;

/** Largest payload either side accepts. Output is chunked far below this. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const FrameType = {
    hello: 1,
    welcome: 2,
    refused: 3,
    superseded: 4,
    spawn: 10,
    spawned: 11,
    spawnFailed: 12,
    write: 13,
    resize: 14,
    pause: 15,
    resume: 16,
    kill: 17,
    data: 18,
    exit: 19,
    attach: 20,
    attached: 21,
    hold: 22,
    held: 23,
    checkpoint: 24,
    detach: 25,
    shutdown: 26,
    forget: 27
} as const;

export type FrameTypeName = keyof typeof FrameType;
export type FrameTypeCode = (typeof FrameType)[FrameTypeName];

// ── messages ────────────────────────────────────────────────────────────────────────

/** `attach` takes over as the one streaming daemon; `probe` only asks who is there. */
export type HelloMode = 'attach' | 'probe';

export interface HelloMessage {
    readonly protocol: number;
    readonly token: string;
    readonly mode: HelloMode;
}

export interface TerminalInfo {
    readonly tid: string;
    /** The pane id the terminal was spawned for. */
    readonly key: string;
    /** 0 until the child is running. */
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    /** Bytes read from the PTY so far. */
    readonly produced: number;
    /** Offset of the latest checkpoint the host holds, if any. */
    readonly checkpointOffset: number | null;
    readonly exited: { readonly code: number; readonly signal: number | null } | null;
}

export interface WelcomeMessage {
    readonly protocol: number;
    readonly hostVersion: string;
    readonly pid: number;
    readonly terminals: readonly TerminalInfo[];
}

export interface SpawnMessage {
    readonly tid: string;
    readonly key: string;
    readonly file: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly cols: number;
    readonly rows: number;
    /** `$TERM`. */
    readonly name: string;
    /** Tried when `file` fails to spawn (the manager's `/bin/sh` retry). */
    readonly fallbackFile?: string;
}

export interface AttachedMessage {
    readonly tid: string;
    readonly checkpointOffset: number | null;
    /** Offset of the first `data` byte that follows. */
    readonly from: number;
    /** True when the host no longer holds every byte after the checkpoint (or there is none). */
    readonly gap: boolean;
    /** Offset just past the replayed bytes: `until - from` of the `data` that follows is replay. */
    readonly until: number;
    readonly cols: number;
    readonly rows: number;
}

export interface ExitMessage {
    readonly tid: string;
    readonly code: number;
    readonly signal: number | null;
}

/** A decoded frame. `json` frames parse lazily through `messageOf`. */
export type Frame =
    | { readonly type: FrameTypeCode; readonly kind: 'json'; readonly body: unknown }
    | { readonly type: typeof FrameType.write; readonly kind: 'write'; readonly tid: string; readonly bytes: Uint8Array }
    | {
          readonly type: typeof FrameType.data;
          readonly kind: 'data';
          readonly tid: string;
          readonly offset: number;
          readonly bytes: Uint8Array;
      }
    | {
          readonly type: typeof FrameType.checkpoint | typeof FrameType.attached;
          readonly kind: 'blob';
          readonly body: unknown;
          readonly blob: Uint8Array;
      };

// ── encoding ────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(type: FrameTypeCode, payload: Uint8Array): Uint8Array {
    if (payload.length > MAX_FRAME_BYTES) throw new Error(`frame of ${payload.length} bytes exceeds the limit`);
    const out = new Uint8Array(5 + payload.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, payload.length);
    out[4] = type;
    out.set(payload, 5);
    return out;
}

function tidBytes(tid: string): Uint8Array {
    const bytes = encoder.encode(tid);
    if (bytes.length === 0 || bytes.length > 255) throw new Error(`terminal id must be 1-255 bytes`);
    return bytes;
}

export function encodeJson(type: FrameTypeCode, body: unknown): Uint8Array {
    return frame(type, encoder.encode(JSON.stringify(body ?? {})));
}

export function encodeWrite(tid: string, bytes: Uint8Array): Uint8Array {
    const id = tidBytes(tid);
    const payload = new Uint8Array(1 + id.length + bytes.length);
    payload[0] = id.length;
    payload.set(id, 1);
    payload.set(bytes, 1 + id.length);
    return frame(FrameType.write, payload);
}

export function encodeData(tid: string, offset: number, bytes: Uint8Array): Uint8Array {
    const id = tidBytes(tid);
    const payload = new Uint8Array(1 + id.length + 8 + bytes.length);
    payload[0] = id.length;
    payload.set(id, 1);
    new DataView(payload.buffer).setFloat64(1 + id.length, offset);
    payload.set(bytes, 1 + id.length + 8);
    return frame(FrameType.data, payload);
}

export function encodeBlob(
    type: typeof FrameType.checkpoint | typeof FrameType.attached,
    body: unknown,
    blob: Uint8Array
): Uint8Array {
    const json = encoder.encode(JSON.stringify(body));
    const payload = new Uint8Array(4 + json.length + blob.length);
    new DataView(payload.buffer).setUint32(0, json.length);
    payload.set(json, 4);
    payload.set(blob, 4 + json.length);
    return frame(type, payload);
}

// ── decoding ────────────────────────────────────────────────────────────────────────

const KNOWN_TYPES: ReadonlySet<number> = new Set(Object.values(FrameType));

function decodePayload(type: number, payload: Uint8Array): Frame {
    if (!KNOWN_TYPES.has(type)) throw new Error(`unknown frame type ${type}`);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (type === FrameType.write || type === FrameType.data) {
        const idLength = payload[0] ?? 0;
        const headerEnd = 1 + idLength + (type === FrameType.data ? 8 : 0);
        if (idLength === 0 || payload.length < headerEnd) throw new Error('truncated terminal frame');
        const tid = decoder.decode(payload.subarray(1, 1 + idLength));
        const bytes = payload.subarray(headerEnd);
        return type === FrameType.data
            ? { type, kind: 'data', tid, offset: view.getFloat64(1 + idLength), bytes }
            : { type, kind: 'write', tid, bytes };
    }
    if (type === FrameType.checkpoint || type === FrameType.attached) {
        if (payload.length < 4) throw new Error('truncated blob frame');
        const jsonLength = view.getUint32(0);
        if (payload.length < 4 + jsonLength) throw new Error('truncated blob frame');
        const body: unknown = JSON.parse(decoder.decode(payload.subarray(4, 4 + jsonLength)));
        return { type, kind: 'blob', body, blob: payload.subarray(4 + jsonLength) };
    }
    const body: unknown = payload.length === 0 ? {} : JSON.parse(decoder.decode(payload));
    return { type: type as FrameTypeCode, kind: 'json', body };
}

/**
 * Reassembles frames from a byte stream: a socket delivers them split and coalesced at
 * arbitrary points. Throws on a malformed or oversized frame; the caller closes the connection.
 */
export class FrameDecoder {
    private pending: Uint8Array = new Uint8Array(0);

    push(chunk: Uint8Array): Frame[] {
        this.pending = this.pending.length === 0 ? chunk : concat(this.pending, chunk);
        const frames: Frame[] = [];
        let at = 0;
        while (this.pending.length - at >= 5) {
            const length = new DataView(this.pending.buffer, this.pending.byteOffset + at, 4).getUint32(0);
            if (length > MAX_FRAME_BYTES) throw new Error(`frame of ${length} bytes exceeds the limit`);
            if (this.pending.length - at < 5 + length) break;
            const type = this.pending[at + 4] ?? 0;
            // Copy the payload out: the pending buffer is reused and a consumer may keep bytes.
            frames.push(decodePayload(type, this.pending.slice(at + 5, at + 5 + length)));
            at += 5 + length;
        }
        this.pending = at === 0 ? this.pending : this.pending.slice(at);
        return frames;
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

// ── validation ──────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isSize = (value: unknown): value is number => isCount(value) && value > 0 && value <= 10_000;

/** A `spawn` body, or null when any field is missing or the wrong shape. */
export function parseSpawn(body: unknown): SpawnMessage | null {
    if (!isRecord(body)) return null;
    const { tid, key, file, args, cwd, env, cols, rows, name, fallbackFile } = body;
    if (!isText(tid) || tid.length === 0 || !isText(key) || !isText(file) || file.length === 0) return null;
    if (!Array.isArray(args) || !args.every(isText) || !isText(cwd) || !isText(name)) return null;
    if (!isRecord(env) || !Object.values(env).every(isText)) return null;
    if (!isSize(cols) || !isSize(rows)) return null;
    if (fallbackFile !== undefined && !isText(fallbackFile)) return null;
    return {
        tid,
        key,
        file,
        args,
        cwd,
        env: env as Record<string, string>,
        cols,
        rows,
        name,
        ...(fallbackFile !== undefined ? { fallbackFile } : {})
    };
}

export function parseHello(body: unknown): HelloMessage | null {
    if (!isRecord(body)) return null;
    const { protocol, token, mode } = body;
    if (!isCount(protocol) || !isText(token) || (mode !== 'attach' && mode !== 'probe')) return null;
    return { protocol, token, mode };
}

/** `{ tid }` plus the named numeric fields, or null. */
export function parseTidFields<K extends string>(
    body: unknown,
    fields: readonly K[]
): ({ readonly tid: string } & Record<K, number>) | null {
    if (!isRecord(body) || !isText(body['tid']) || body['tid'].length === 0) return null;
    for (const field of fields) if (!isCount(body[field])) return null;
    return body as { readonly tid: string } & Record<K, number>;
}

export function parseKill(body: unknown): { readonly tid: string; readonly signal: string | undefined } | null {
    if (!isRecord(body) || !isText(body['tid'])) return null;
    const signal = body['signal'];
    if (signal !== undefined && (!isText(signal) || !/^SIG[A-Z0-9]+$/.test(signal))) return null;
    return { tid: body['tid'], signal };
}

export function parseWelcome(body: unknown): WelcomeMessage | null {
    if (!isRecord(body) || !isCount(body['protocol']) || !isText(body['hostVersion']) || !isCount(body['pid'])) {
        return null;
    }
    const terminals = body['terminals'];
    if (!Array.isArray(terminals)) return null;
    return body as unknown as WelcomeMessage;
}

export function parseAttached(body: unknown): AttachedMessage | null {
    if (
        !isRecord(body) ||
        !isText(body['tid']) ||
        !isCount(body['from']) ||
        !isCount(body['until']) ||
        typeof body['gap'] !== 'boolean'
    ) {
        return null;
    }
    const offset = body['checkpointOffset'];
    if (offset !== null && !isCount(offset)) return null;
    return body as unknown as AttachedMessage;
}

export function parseExit(body: unknown): ExitMessage | null {
    if (!isRecord(body) || !isText(body['tid']) || typeof body['code'] !== 'number') return null;
    const signal = body['signal'];
    return { tid: body['tid'], code: body['code'], signal: typeof signal === 'number' ? signal : null };
}

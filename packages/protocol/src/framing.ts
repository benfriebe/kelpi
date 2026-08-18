/**
 * Incremental newline framing for the control protocol (wire-protocol.md §2.1, port note 2).
 *
 * The Swift server reads 4096-byte chunks and splits each chunk on `\n` without buffering
 * partial lines, so a request split across two reads is dropped. This buffer keeps the
 * pending tail across chunks — a strict superset of the current behavior — while preserving
 * the rest of the framing: multiple lines per chunk are emitted in order and blank segments
 * are skipped.
 *
 * Pure: no transport state, no Node APIs. Byte chunks are decoded with the platform's
 * `TextDecoder` when one exists, or with a caller-supplied decoder.
 */

export type Utf8ChunkDecoder = (bytes: Uint8Array) => string;

export interface LineBufferOptions {
    /**
     * Cap on a single pending line. Exceeding it discards the oversized line (up to and
     * including its terminator) and bumps `overflows`. Keep this well above `web-exec --file`
     * and large `pane-send` payloads — several MB minimum.
     */
    readonly maxLineLength?: number;
    /** Skip segments that are empty after trimming (the Swift server's behavior). */
    readonly skipBlank?: boolean;
    /** Streaming UTF-8 decoder for `Uint8Array` chunks; defaults to a global `TextDecoder`. */
    readonly decodeUtf8?: Utf8ChunkDecoder;
}

export interface LineBuffer {
    /** Feed one chunk; returns every line it completed, in order. */
    push(chunk: string | Uint8Array): string[];
    /** Length of the not-yet-terminated tail (UTF-16 code units). */
    readonly pending: number;
    /** How many lines were discarded for exceeding `maxLineLength`. */
    readonly overflows: number;
    /** Drop any buffered tail (connection reset). */
    reset(): void;
}

const DEFAULT_MAX_LINE_LENGTH = 64 * 1024 * 1024;

interface StreamingDecoder {
    decode(input: Uint8Array, options: { stream: boolean }): string;
}

type DecoderConstructor = new (label?: string) => StreamingDecoder;

function platformDecoder(): Utf8ChunkDecoder {
    const ctor = (globalThis as { TextDecoder?: DecoderConstructor }).TextDecoder;
    if (ctor === undefined) {
        throw new Error('no TextDecoder available: pass decodeUtf8 to createLineBuffer');
    }
    const decoder = new ctor('utf-8');
    return (bytes) => decoder.decode(bytes, { stream: true });
}

export function createLineBuffer(options: LineBufferOptions = {}): LineBuffer {
    const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    const skipBlank = options.skipBlank ?? true;

    let buffer = '';
    let overflows = 0;
    let discarding = false;
    let decodeUtf8 = options.decodeUtf8;

    const decode = (chunk: string | Uint8Array): string => {
        if (typeof chunk === 'string') return chunk;
        decodeUtf8 ??= platformDecoder();
        return decodeUtf8(chunk);
    };

    return {
        push(chunk) {
            buffer += decode(chunk);
            const lines: string[] = [];
            let start = 0;

            for (let index = buffer.indexOf('\n', start); index !== -1; index = buffer.indexOf('\n', start)) {
                const segment = buffer.slice(start, index);
                start = index + 1;
                if (discarding) {
                    discarding = false;
                    continue;
                }
                if (segment.length > maxLineLength) {
                    overflows += 1;
                    continue;
                }
                if (skipBlank && segment.trim().length === 0) continue;
                lines.push(segment);
            }

            if (start > 0) buffer = buffer.slice(start);

            if (buffer.length > maxLineLength) {
                overflows += 1;
                discarding = true;
                buffer = '';
            }
            return lines;
        },
        get pending() {
            return buffer.length;
        },
        get overflows() {
            return overflows;
        },
        reset() {
            buffer = '';
            discarding = false;
        }
    };
}

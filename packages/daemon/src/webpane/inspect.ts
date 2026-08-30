/**
 * The element-picker pipeline, daemon half (web-pane.md §11).
 *
 * `kelpi web inspect` arms a single-shot picker on the pane's active tab; the click happens in
 * the page, the host forwards the payload, and the daemon
 *
 *   1. validates it against the arm's **nonce** (§17.6 — page JS can call the host binding, so
 *      the nonce is what makes a picked element trustworthy),
 *   2. **sanitises** it (§11.6 — the payload can cross a PTY boundary, where an ANSI escape
 *      would reposition a cursor or fire an OSC 52 clipboard write),
 *   3. queues it for `kelpi web inspect-result` (cap 32, oldest dropped) and, when the arm
 *      carried `--send-to`, pastes the formatted block into that shell pane.
 *
 * The batch ("element pickup") session is a GUI surface: it lives in the client, and only its
 * wire-visible corner is here — `inspect-result --clear` empties the queue. Batch state is
 * therefore deliberately absent daemon-side (noted in ./HOST_PROTOCOL.md).
 */

import { randomBytes } from 'node:crypto';

import type { JsonObject } from '@kelpi/protocol';

/** §11.3 queue cap; the oldest result is dropped. */
export const INSPECT_QUEUE_CAP = 32;

/** §11.6 clamp budgets, in UTF-8 bytes. */
export const INSPECT_LIMITS = {
    selector: 1024,
    xpath: 1024,
    tag: 64,
    elementID: 256,
    outerHTML: 16384,
    contextHTML: 4096,
    text: 1024,
    url: 4096,
    attributeKey: 128,
    attributeValue: 1024,
    comment: 4096
} as const;

const TRUNCATION_MARKER = '... [truncated]';

export interface InspectRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export interface InspectResult {
    readonly tabID: string;
    readonly selector: string;
    readonly xpath: string;
    readonly tag: string;
    readonly elementID: string;
    readonly outerHTML: string;
    readonly attributes: Readonly<Record<string, string>>;
    readonly rect: InspectRect;
    readonly text: string;
    readonly contextHTML: string;
    readonly url: string;
    /** Epoch ms. */
    readonly capturedAt: number;
    readonly comment: string;
}

export interface InspectArm {
    readonly paneID: string;
    readonly tabID: string;
    readonly nonce: string;
    /** Resolved destination pane UUID, or null for "queue it locally". */
    readonly sendTo: string | null;
    /** `--submit`: paste + Enter instead of paste only. */
    readonly submit: boolean;
}

// ---------------------------------------------------------------------------
// Sanitisation (§11.6)
// ---------------------------------------------------------------------------

/**
 * Drop ESC-led ANSI sequences (CSI / OSC / two-char ESC x) plus every C0 control character
 * except `\n` and `\t`, plus DEL.
 */
export function stripUnsafeControlCharacters(raw: string): string {
    let out = '';
    for (let index = 0; index < raw.length; index += 1) {
        const code = raw.charCodeAt(index);
        if (code === 0x1b) {
            const next = raw[index + 1];
            if (next === '[') {
                // CSI: parameters/intermediates, then a final byte in 0x40–0x7E.
                let cursor = index + 2;
                while (cursor < raw.length) {
                    const byte = raw.charCodeAt(cursor);
                    cursor += 1;
                    if (byte >= 0x40 && byte <= 0x7e) break;
                }
                index = cursor - 1;
                continue;
            }
            if (next === ']') {
                // OSC: through BEL, or through ESC \ (ST).
                let cursor = index + 2;
                while (cursor < raw.length) {
                    const byte = raw.charCodeAt(cursor);
                    if (byte === 0x07) {
                        cursor += 1;
                        break;
                    }
                    if (byte === 0x1b && raw[cursor + 1] === '\\') {
                        cursor += 2;
                        break;
                    }
                    cursor += 1;
                }
                index = cursor - 1;
                continue;
            }
            // Any other two-character escape.
            index += 1;
            continue;
        }
        if (code === 0x7f) continue;
        if (code < 0x20 && code !== 0x0a && code !== 0x09) continue;
        out += raw[index];
    }
    return out;
}

const encoder = new TextEncoder();

function utf8Length(value: string): number {
    return encoder.encode(value).length;
}

/** Byte-clamp on a code-point boundary, leaving room for the truncation marker. */
export function clampField(raw: string, limit: number): string {
    const stripped = stripUnsafeControlCharacters(raw);
    if (utf8Length(stripped) <= limit) return stripped;
    const budget = Math.max(0, limit - utf8Length(TRUNCATION_MARKER));
    let out = '';
    let used = 0;
    for (const char of stripped) {
        const size = utf8Length(char);
        if (used + size > budget) break;
        out += char;
        used += size;
    }
    return `${out}${TRUNCATION_MARKER}`;
}

function stringOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

function numberOf(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rectOf(value: unknown): InspectRect {
    if (typeof value !== 'object' || value === null) return { x: 0, y: 0, w: 0, h: 0 };
    const raw = value as Record<string, unknown>;
    return {
        x: numberOf(raw['x']),
        y: numberOf(raw['y']),
        w: numberOf(raw['w']),
        h: numberOf(raw['h'])
    };
}

function attributesOf(value: unknown): Record<string, string> {
    if (typeof value !== 'object' || value === null) return {};
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const name = clampField(key, INSPECT_LIMITS.attributeKey);
        if (name === '') continue;
        out[name] = clampField(stringOf(raw), INSPECT_LIMITS.attributeValue);
    }
    return out;
}

/**
 * `InspectPayloadSanitiser.decode` (§11.6). Returns null — and the payload is silently
 * dropped — when selector, tag AND url are all empty after clamping (the spoof/garbage guard
 * beyond the nonce).
 */
export function sanitizeInspectPayload(
    tabID: string,
    payload: Record<string, unknown>,
    now: number
): InspectResult | null {
    const selector = clampField(stringOf(payload['selector']), INSPECT_LIMITS.selector);
    const tag = clampField(stringOf(payload['tag']), INSPECT_LIMITS.tag).toLowerCase();
    const url = clampField(stringOf(payload['url']), INSPECT_LIMITS.url);
    if (selector === '' && tag === '' && url === '') return null;

    const capturedAtRaw = payload['captured_at'];
    const capturedAt =
        typeof capturedAtRaw === 'string' && !Number.isNaN(Date.parse(capturedAtRaw))
            ? Date.parse(capturedAtRaw)
            : now;

    return {
        tabID,
        selector,
        xpath: clampField(stringOf(payload['xpath']), INSPECT_LIMITS.xpath),
        tag,
        elementID: clampField(stringOf(payload['element_id']), INSPECT_LIMITS.elementID),
        outerHTML: clampField(stringOf(payload['outer_html']), INSPECT_LIMITS.outerHTML),
        attributes: attributesOf(payload['attributes']),
        rect: rectOf(payload['rect']),
        text: clampField(stringOf(payload['text']), INSPECT_LIMITS.text),
        contextHTML: clampField(stringOf(payload['context_html']), INSPECT_LIMITS.contextHTML),
        url,
        capturedAt,
        comment: clampField(stringOf(payload['comment']), INSPECT_LIMITS.comment)
    };
}

// ---------------------------------------------------------------------------
// Wire + paste shapes (§11.4, §11.5)
// ---------------------------------------------------------------------------

/** One entry of the `web-inspect-result` reply. Empty optional fields are omitted (§11.5). */
export function serializeInspectResult(result: InspectResult): JsonObject {
    return {
        tab_id: result.tabID,
        selector: result.selector,
        xpath: result.xpath,
        tag: result.tag,
        id: result.elementID,
        url: result.url,
        text: result.text,
        attributes: result.attributes,
        rect: { x: result.rect.x, y: result.rect.y, w: result.rect.w, h: result.rect.h },
        captured_at: new Date(result.capturedAt).toISOString(),
        ...(result.outerHTML === '' ? {} : { outer_html: result.outerHTML }),
        ...(result.contextHTML === '' ? {} : { context_html: result.contextHTML }),
        ...(result.comment === '' ? {} : { comment: result.comment })
    };
}

/** The JSON body pasted into a shell pane: sorted keys, pretty-printed (§11.4). */
function pasteBody(result: InspectResult): Record<string, unknown> {
    return {
        attributes: result.attributes,
        captured_at: new Date(result.capturedAt).toISOString(),
        ...(result.contextHTML === '' ? {} : { context_html: result.contextHTML }),
        id: result.elementID,
        ...(result.outerHTML === '' ? {} : { outer_html: result.outerHTML }),
        rect: { h: result.rect.h, w: result.rect.w, x: result.rect.x, y: result.rect.y },
        selector: result.selector,
        tag: result.tag,
        text: result.text,
        url: result.url,
        xpath: result.xpath
    };
}

/**
 * `formatForPaste` (§11.4): a one-line directive followed by a literal ```json fence — easy
 * for an agent to detect in its scrollback, readable on a terminal.
 */
export function formatForPaste(result: InspectResult, now: number): string {
    const header = `# kelpi inspect ${new Date(now).toISOString()}`;
    const body = JSON.stringify(pasteBody(result), null, 2);
    return `${header}\n\`\`\`json\n${body}\n\`\`\`\n`;
}

// ---------------------------------------------------------------------------
// Arm + queue state (transient; never persisted, §15.1)
// ---------------------------------------------------------------------------

export interface InspectState {
    arm(arm: InspectArm): void;
    armOf(paneID: string): InspectArm | null;
    disarm(paneID: string): InspectArm | null;
    enqueue(paneID: string, result: InspectResult): void;
    queued(paneID: string): readonly InspectResult[];
    clearQueue(paneID: string): void;
    disposePane(paneID: string): void;
    newNonce(): string;
}

export function createInspectState(
    options: { readonly nonce?: (() => string) | undefined } = {}
): InspectState {
    const arms = new Map<string, InspectArm>();
    const queues = new Map<string, InspectResult[]>();
    // §11.1: a fresh 128-bit hex nonce per arm.
    const nonce = options.nonce ?? ((): string => randomBytes(16).toString('hex'));

    return {
        arm(next) {
            arms.set(next.paneID, next);
        },
        armOf(paneID) {
            return arms.get(paneID) ?? null;
        },
        disarm(paneID) {
            const current = arms.get(paneID) ?? null;
            arms.delete(paneID);
            return current;
        },
        enqueue(paneID, result) {
            const queue = queues.get(paneID) ?? [];
            queue.push(result);
            while (queue.length > INSPECT_QUEUE_CAP) queue.shift();
            queues.set(paneID, queue);
        },
        queued(paneID) {
            return queues.get(paneID) ?? [];
        },
        clearQueue(paneID) {
            queues.delete(paneID);
        },
        disposePane(paneID) {
            arms.delete(paneID);
            queues.delete(paneID);
        },
        newNonce: nonce
    };
}

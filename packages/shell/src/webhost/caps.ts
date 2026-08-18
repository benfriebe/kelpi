/**
 * Byte budgets and the clamping rules every web-pane read shares (web-pane.md §8.4, §11.6).
 *
 * Invariant 7 of the spec: "text/HTML/attribute reads are byte-clamped on UTF-8 boundaries with
 * explicit truncation markers so a consumer can always tell content was cut". A clamp that
 * splits a code point would also produce invalid UTF-8 on the wire, so every clamp here walks
 * code points and stops *before* the byte that would overflow.
 *
 * The inspect-payload half (`stripUnsafeControlCharacters` / `clampField` / `INSPECT_LIMITS`)
 * deliberately mirrors `packages/daemon/src/webpane/inspect.ts`, which is the source of truth:
 * the daemon re-sanitises everything a host sends before it can reach a PTY, so this copy is
 * defense in depth (and keeps the payload small on the wire). It is duplicated rather than
 * imported because `@nex/daemon` does not export the `webpane` subpath, and the shell must not
 * grow a dependency on the daemon's internal module layout.
 */

/** §8.4 `capture --mode text` clamp. */
export const TEXT_CAPTURE_LIMIT = 1_000_000;
export const TEXT_TRUNCATION_MARKER = '\n[truncated]';
/** §8.4 `capture --mode dom` clamp. */
export const DOM_CAPTURE_LIMIT = 5_000_000;
export const DOM_TRUNCATION_MARKER = '\n<!-- truncated -->';
/** §8.4 screenshots at or below this go inline as base64; larger ones go to a temp file. */
export const SCREENSHOT_INLINE_LIMIT = 1_000_000;

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

const INSPECT_TRUNCATION_MARKER = '... [truncated]';

const encoder = new TextEncoder();

export function utf8Length(value: string): number {
    return encoder.encode(value).length;
}

export interface ClampResult {
    readonly text: string;
    /** UTF-8 bytes of `text` — i.e. of what the reply actually carries. */
    readonly byteCount: number;
    readonly truncated: boolean;
}

/**
 * Clamp to `limit` bytes on a code-point boundary, appending `marker` when anything was cut.
 * The marker is *added* to the clamped body (the spec's markers are trailing notices, not part
 * of the budget), so a caller that must stay under a hard cap should pass a reduced limit.
 */
export function clampUtf8(raw: string, limit: number, marker: string): ClampResult {
    const total = utf8Length(raw);
    if (total <= limit) return { text: raw, byteCount: total, truncated: false };
    let out = '';
    let used = 0;
    for (const char of raw) {
        const size = utf8Length(char);
        if (used + size > limit) break;
        out += char;
        used += size;
    }
    const text = `${out}${marker}`;
    return { text, byteCount: utf8Length(text), truncated: true };
}

/**
 * Drop ESC-led ANSI sequences (CSI / OSC / two-char ESC x) plus every C0 control character
 * except `\n` and `\t`, plus DEL — the payload can cross a PTY boundary, where an escape would
 * reposition a cursor or fire an OSC 52 clipboard write.
 */
export function stripUnsafeControlCharacters(raw: string): string {
    let out = '';
    for (let index = 0; index < raw.length; index += 1) {
        const code = raw.charCodeAt(index);
        if (code === 0x1b) {
            const next = raw[index + 1];
            if (next === '[') {
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
            index += 1;
            continue;
        }
        if (code === 0x7f) continue;
        if (code < 0x20 && code !== 0x0a && code !== 0x09) continue;
        out += raw[index];
    }
    return out;
}

/** §11.6 `clampField`: strip, then byte-clamp leaving room for the truncation marker. */
export function clampField(raw: string, limit: number): string {
    const stripped = stripUnsafeControlCharacters(raw);
    if (utf8Length(stripped) <= limit) return stripped;
    const budget = Math.max(0, limit - utf8Length(INSPECT_TRUNCATION_MARKER));
    return clampUtf8(stripped, budget, INSPECT_TRUNCATION_MARKER).text;
}

/**
 * §11.6 applied to a whole picker payload, before it leaves the host.
 *
 * The daemon re-sanitises everything it receives (`daemon/src/webpane/inspect.ts` is the source
 * of truth — it is the last gate before a PTY), so this pass is not what makes the payload safe.
 * It is what keeps the *wire* honest: a page can hand the picker a multi-megabyte `outerHTML`,
 * and shipping that through the WS only to have the daemon clamp it to 16 KB is pure waste.
 * Clamping is idempotent, so the daemon's pass over an already-clamped field is a no-op.
 *
 * `nonce` and `cancelled` pass through untouched: the nonce is compared for equality against the
 * arm, so a "cleaned" one would silently stop matching, and the cancel flag is a boolean.
 */
export function clampInspectPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
    const attributes: Record<string, string> = {};
    const rawAttributes = payload['attributes'];
    if (typeof rawAttributes === 'object' && rawAttributes !== null && !Array.isArray(rawAttributes)) {
        for (const [key, value] of Object.entries(rawAttributes as Record<string, unknown>)) {
            attributes[clampField(key, INSPECT_LIMITS.attributeKey)] = clampField(
                str(value),
                INSPECT_LIMITS.attributeValue
            );
        }
    }
    const rawRect = payload['rect'];
    const rect = typeof rawRect === 'object' && rawRect !== null ? (rawRect as Record<string, unknown>) : {};
    const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

    return {
        ...(typeof payload['nonce'] === 'string' ? { nonce: payload['nonce'] } : {}),
        ...(payload['cancelled'] === true ? { cancelled: true } : {}),
        selector: clampField(str(payload['selector']), INSPECT_LIMITS.selector),
        xpath: clampField(str(payload['xpath']), INSPECT_LIMITS.xpath),
        tag: clampField(str(payload['tag']), INSPECT_LIMITS.tag),
        element_id: clampField(str(payload['element_id']), INSPECT_LIMITS.elementID),
        outer_html: clampField(str(payload['outer_html']), INSPECT_LIMITS.outerHTML),
        attributes,
        rect: { x: number(rect['x']), y: number(rect['y']), w: number(rect['w']), h: number(rect['h']) },
        text: clampField(str(payload['text']), INSPECT_LIMITS.text),
        context_html: clampField(str(payload['context_html']), INSPECT_LIMITS.contextHTML),
        url: clampField(str(payload['url']), INSPECT_LIMITS.url),
        captured_at: str(payload['captured_at'])
    };
}

/** §8.4 screenshot spill file: `nex-web-capture-<paneID>-<unixts>.png` in the OS temp dir. */
export function screenshotFileName(paneID: string, atEpochMs: number): string {
    return `nex-web-capture-${paneID}-${String(Math.floor(atEpochMs / 1000))}.png`;
}

/**
 * The byte budgets (web-pane.md invariant 7): a read is clamped on a UTF-8 *code-point* boundary
 * and says so. A clamp that split a code point would also put invalid UTF-8 on the wire, so the
 * boundary cases below are the point of the module.
 */

import { describe, expect, it } from 'vitest';

import {
    INSPECT_LIMITS,
    POSTER_INLINE_LIMIT,
    POSTER_JPEG_QUALITY,
    POSTER_MIME,
    clampField,
    clampInspectPayload,
    clampUtf8,
    posterWithinBudget,
    screenshotFileName,
    stripUnsafeControlCharacters,
    utf8Length
} from './caps.js';

describe('clampUtf8', () => {
    it('leaves content under the budget untouched and reports its byte count', () => {
        const result = clampUtf8('hello', 100, '…cut');
        expect(result).toEqual({ text: 'hello', byteCount: 5, truncated: false });
    });

    it('counts UTF-8 bytes, not JS characters', () => {
        // "é" is 2 bytes, "😀" is 4 (and 2 UTF-16 code units).
        expect(utf8Length('é')).toBe(2);
        expect(utf8Length('😀')).toBe(4);
        expect(clampUtf8('éé', 4, 'X').truncated).toBe(false);
        expect(clampUtf8('ééé', 4, 'X').truncated).toBe(true);
    });

    it('never splits a code point', () => {
        // Budget 5 with 4-byte emoji: one fits, the second cannot be half-written.
        const result = clampUtf8('😀😀', 5, '[cut]');
        expect(result.truncated).toBe(true);
        expect(result.text).toBe('😀[cut]');
        // The surviving body is decodable — a split would leave a lone surrogate.
        expect([...result.text][0]).toBe('😀');
    });

    it('reports the byte count of what the reply actually carries (marker included)', () => {
        const result = clampUtf8('abcdefgh', 4, '[cut]');
        expect(result.text).toBe('abcd[cut]');
        expect(result.byteCount).toBe(utf8Length('abcd[cut]'));
    });
});

describe('stripUnsafeControlCharacters', () => {
    it('drops CSI sequences whole', () => {
        expect(stripUnsafeControlCharacters('a\u001b[31mred\u001b[0m')).toBe('ared');
    });

    it('drops OSC sequences terminated by BEL or ST, including OSC 52 clipboard writes', () => {
        expect(stripUnsafeControlCharacters('x\u001b]52;c;aGk=\u0007y')).toBe('xy');
        expect(stripUnsafeControlCharacters('x\u001b]0;title\u001b\\y')).toBe('xy');
    });

    it('drops other two-character escapes and bare C0 controls but keeps \\n and \\t', () => {
        expect(stripUnsafeControlCharacters('a\u001bDb')).toBe('ab');
        expect(stripUnsafeControlCharacters('a\u0000\u0007b\u007f')).toBe('ab');
        expect(stripUnsafeControlCharacters('a\nb\tc')).toBe('a\nb\tc');
    });
});

describe('clampField', () => {
    it('strips first, then clamps to the budget including the marker', () => {
        const raw = `${'a'.repeat(2000)}\u001b[31m`;
        const clamped = clampField(raw, INSPECT_LIMITS.selector);
        expect(clamped.endsWith('... [truncated]')).toBe(true);
        expect(utf8Length(clamped)).toBeLessThanOrEqual(INSPECT_LIMITS.selector);
        expect(clamped).not.toContain('\u001b');
    });

    it('leaves a short field alone', () => {
        expect(clampField('#login', INSPECT_LIMITS.selector)).toBe('#login');
    });
});

describe('screenshotFileName', () => {
    it('uses the spec name shape with unix SECONDS', () => {
        expect(screenshotFileName('PANE-1', 1_766_000_000_123)).toBe('kelpi-web-capture-PANE-1-1766000000.png');
    });
});

describe('clampInspectPayload', () => {
    const payload = {
        nonce: 'a'.repeat(32),
        selector: '#login',
        xpath: '/html[1]/body[1]/button[1]',
        tag: 'button',
        element_id: 'login',
        outer_html: `<button>${'x'.repeat(40_000)}</button>`,
        attributes: { class: 'y'.repeat(4_000), ['data-\u001b[31mevil']: 'ok' },
        rect: { x: 1.5, y: 2, w: 3, h: 4 },
        text: 'Sign in',
        context_html: 'z'.repeat(9_000),
        url: 'https://example.com/login',
        captured_at: '2026-08-18T05:12:03.123Z'
    };

    it('clamps every budgeted field to §11.6, markers included', () => {
        const clamped = clampInspectPayload(payload);
        expect(utf8Length(clamped['outer_html'] as string)).toBeLessThanOrEqual(INSPECT_LIMITS.outerHTML);
        expect(clamped['outer_html'] as string).toContain('... [truncated]');
        expect(utf8Length(clamped['context_html'] as string)).toBeLessThanOrEqual(INSPECT_LIMITS.contextHTML);
        const attributes = clamped['attributes'] as Record<string, string>;
        expect(utf8Length(attributes['class'] ?? '')).toBeLessThanOrEqual(INSPECT_LIMITS.attributeValue);
        // The ANSI escape in the attribute NAME is stripped: the payload can end up in a PTY.
        expect(Object.keys(attributes)).toEqual(['class', 'data-evil']);
        expect(clamped['selector']).toBe('#login');
    });

    it('passes the nonce through byte-for-byte (it is compared for equality)', () => {
        expect(clampInspectPayload(payload)['nonce']).toBe(payload.nonce);
        expect(clampInspectPayload({ nonce: 'n1', cancelled: true })).toMatchObject({
            nonce: 'n1',
            cancelled: true
        });
    });

    it('keeps the shape the daemon decodes even from a hostile payload', () => {
        const clamped = clampInspectPayload({ selector: 42, rect: 'nope', attributes: ['x'] });
        expect(clamped['selector']).toBe('42');
        expect(clamped['rect']).toEqual({ x: 0, y: 0, w: 0, h: 0 });
        expect(clamped['attributes']).toEqual({});
        expect('nonce' in clamped).toBe(false);
        expect('cancelled' in clamped).toBe(false);
    });
});

/**
 * Issue #12's poster budget — the one read in this file with no temp-file escape hatch.
 *
 * §8.4's screenshot spills a frame it cannot inline to `/tmp` because a CLI reader can open one.
 * The poster's reader is an `<img>` in a renderer, so an oversized frame is not a bigger reply —
 * it is no reply at all, and the pane parks with an empty hole the way it always did.
 */
describe('the poster budget', () => {
    it('takes a frame at or under the inline limit and refuses one over it', () => {
        expect(posterWithinBudget(1)).toBe(true);
        expect(posterWithinBudget(POSTER_INLINE_LIMIT)).toBe(true);
        expect(posterWithinBudget(POSTER_INLINE_LIMIT + 1)).toBe(false);
    });

    it('refuses an empty frame, which is a failed capture rather than a small one', () => {
        expect(posterWithinBudget(0)).toBe(false);
    });

    it('is a JPEG, because base64 PNG of a retina pane is megabytes per menu', () => {
        expect(POSTER_MIME).toBe('image/jpeg');
        expect(POSTER_JPEG_QUALITY).toBeGreaterThan(0);
        expect(POSTER_JPEG_QUALITY).toBeLessThanOrEqual(100);
    });
});

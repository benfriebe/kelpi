/**
 * The byte budgets (web-pane.md invariant 7): a read is clamped on a UTF-8 *code-point* boundary
 * and says so. A clamp that split a code point would also put invalid UTF-8 on the wire, so the
 * boundary cases below are the point of the module.
 */

import { describe, expect, it } from 'vitest';

import {
    INSPECT_LIMITS,
    clampField,
    clampUtf8,
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
        expect(screenshotFileName('PANE-1', 1_766_000_000_123)).toBe('nex-web-capture-PANE-1-1766000000.png');
    });
});

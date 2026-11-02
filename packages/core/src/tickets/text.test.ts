import { describe, expect, it } from 'vitest';

import { capText, capUtf8, cleanUntrustedText, hasInvisibleCharacters, neutralizeMentions, untrustedLine, utf8ByteLength } from './text.js';

describe('cleanUntrustedText', () => {
    it('drops C0 (but TAB and LF), DEL and C1 controls, and makes every line break one LF', () => {
        expect(cleanUntrustedText('a\u0000b\u0007c\u001b[31md\u007fe\u0085f\u009bg')).toBe('abc[31mdefg');
        expect(cleanUntrustedText('one\r\ntwo\rthree\u2028four\u2029five\tsix')).toBe('one\ntwo\nthree\nfour\nfive\tsix');
    });

    it('drops bidi controls, zero-width characters, variation selectors and the tag block', () => {
        // `invoice` + RIGHT-TO-LEFT OVERRIDE + `gpj.exe` would display as `invoiceexe.jpg`.
        expect(cleanUntrustedText('invoice\u202egpj.exe')).toBe('invoicegpj.exe');
        for (const invisible of ['\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u2060', '\ufeff', '\u00ad', '\u061c', '\u2066', '\u2069', '\ufe0f']) {
            expect(cleanUntrustedText(`a${invisible}b`), invisible.codePointAt(0)?.toString(16)).toBe('ab');
        }
        // Tag characters spell ASCII a model can read and a person cannot see ("ignore").
        const smuggled = [...'ignore'].map((char) => String.fromCodePoint(0xe0000 + (char.codePointAt(0) ?? 0))).join('');
        expect(cleanUntrustedText(`Fix login${smuggled}`)).toBe('Fix login');
        expect(cleanUntrustedText(`x${String.fromCodePoint(0xe0100)}y`)).toBe('xy');
        expect(hasInvisibleCharacters('fix\u202elogin')).toBe(true);
        expect(hasInvisibleCharacters('fix-login')).toBe(false);
        // The lookup is stateless across calls (a global regex keeps a cursor otherwise).
        expect(hasInvisibleCharacters('a\u200bb')).toBe(true);
        expect(hasInvisibleCharacters('a\u200bb')).toBe(true);
    });

    it('keeps every visible character, emoji and other scripts included', () => {
        expect(cleanUntrustedText('Café 🚀 登录 · ok')).toBe('Café 🚀 登录 · ok');
    });
});

describe('untrustedLine and capText', () => {
    it('makes one line of collapsed whitespace, trimmed', () => {
        expect(untrustedLine('  Retry\tlogin\n\non 401  ', 100)).toBe('Retry login on 401');
    });

    it('caps with an ellipsis inside the limit, never splitting a surrogate pair', () => {
        expect(untrustedLine('abcdefghij', 5)).toBe('abcd…');
        expect(untrustedLine('abc', 3)).toBe('abc');
        const rockets = '🚀'.repeat(10);
        const capped = capText(rockets, 6);
        expect(capped.length).toBeLessThanOrEqual(6);
        expect(capped).toBe('🚀🚀…');
        expect(capText('abc', 0)).toBe('');
    });
});

describe('neutralizeMentions', () => {
    it('turns every @ into the fullwidth form, so no file mention survives', () => {
        expect(neutralizeMentions('Fix @~/.aws/credentials')).toBe('Fix ＠~/.aws/credentials');
        expect(neutralizeMentions('a@b @c')).not.toContain('@');
    });
});

describe('capUtf8', () => {
    it('cuts at a code point boundary and reports what was dropped', () => {
        expect(capUtf8('hello', 10)).toEqual({ text: 'hello', droppedBytes: 0 });
        expect(capUtf8('héllo', 2)).toEqual({ text: 'h', droppedBytes: 5 });
        expect(capUtf8('🚀🚀', 5)).toEqual({ text: '🚀', droppedBytes: 4 });
        expect(utf8ByteLength('aé€🚀')).toBe(1 + 2 + 3 + 4);
    });
});

import { describe, expect, it } from 'vitest';

import { detectBom, extensionOf, sniffDialect } from './dialect.js';

const sniff = (text: string, extension = 'csv', whole = true) =>
    sniffDialect(Buffer.from(text, 'utf8'), { extension, bom: false, whole });

describe('csv dialect', () => {
    it('detects UTF-8, UTF-16 and UTF-32 byte order marks', () => {
        expect(detectBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ kind: 'utf8', length: 3 });
        expect(detectBom(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toEqual({ kind: 'utf16le', length: 2 });
        expect(detectBom(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toEqual({ kind: 'utf16be', length: 2 });
        expect(detectBom(Buffer.from([0xff, 0xfe, 0x00, 0x00]))).toEqual({ kind: 'utf32le', length: 4 });
        expect(detectBom(Buffer.from('abc'))).toEqual({ kind: null, length: 0 });
    });

    it('sniffs comma, semicolon, tab and pipe by field-count consistency', () => {
        expect(sniff('a,b,c\n1,2,3\n4,5,6\n').delimiter).toBe(',');
        expect(sniff('a;b;c\n1;2,5;3\n4;5;6\n').delimiter).toBe(';');
        expect(sniff('a\tb\n1\t2\n').delimiter).toBe('\t');
        expect(sniff('a|b|c\n1|2|3\n').delimiter).toBe('|');
    });

    it('ignores delimiters inside quoted fields while sniffing', () => {
        expect(sniff('"a;x",b\n"c;y",d\n"e;z",f\n').delimiter).toBe(',');
    });

    it('defaults to comma when nothing is consistent, and .tsv is always tab', () => {
        expect(sniff('single\ncolumn\n').delimiter).toBe(',');
        expect(sniff('a,b\n1,2\n', 'tsv').delimiter).toBe('\t');
    });

    it('takes the line ending from the first record terminator', () => {
        expect(sniff('a,b\r\n1,2\r\n').lineEnding).toBe('\r\n');
        expect(sniff('a,b\n1,2\r\n').lineEnding).toBe('\n');
        expect(sniff('"multi\r\nline",b\n1,2\n').lineEnding).toBe('\n');
    });

    it('detects quote-all files', () => {
        expect(sniff('"a","b"\n"1","2"\n').quoteAll).toBe(true);
        expect(sniff('"a",b\n"1","2"\n').quoteAll).toBe(false);
        expect(sniff('').quoteAll).toBe(false);
    });

    it('lower-cases the extension', () => {
        expect(extensionOf('/x/Data.TSV')).toBe('tsv');
        expect(extensionOf('/x/.hidden')).toBe('');
    });
});

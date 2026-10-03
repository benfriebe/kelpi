import { describe, expect, it } from 'vitest';

import { extractField, needsQuote, parseRecord, serialiseRecord, stripTerminator } from './record.js';

const comma = { delimiter: ',', quoteAll: false } as const;

describe('csv record parse', () => {
    it('splits plain fields, keeping empties and a trailing empty field', () => {
        expect(parseRecord('a,b,,d', ',').fields).toEqual(['a', 'b', '', 'd']);
        expect(parseRecord('a,', ',').fields).toEqual(['a', '']);
        expect(parseRecord(',', ',').fields).toEqual(['', '']);
    });

    it('reads a blank line as a record with no fields', () => {
        expect(parseRecord('', ',')).toEqual({ fields: [], quoted: [] });
    });

    it('unquotes RFC 4180 fields with doubled quotes, delimiters and newlines inside', () => {
        const parsed = parseRecord('"a,b","say ""hi""","line\nbreak",plain', ',');
        expect(parsed.fields).toEqual(['a,b', 'say "hi"', 'line\nbreak', 'plain']);
        expect(parsed.quoted).toEqual([true, true, true, false]);
    });

    it('treats a quote only at field start as opening a quoted field', () => {
        expect(parseRecord('ab"c,d', ',').fields).toEqual(['ab"c', 'd']);
        expect(parseRecord('5" pipe,x', ',').fields).toEqual(['5" pipe', 'x']);
    });

    it('is lenient about text after a closing quote and about an unterminated quote', () => {
        expect(parseRecord('"abc"def,x', ',').fields).toEqual(['abcdef', 'x']);
        expect(parseRecord('"open,never closed', ',').fields).toEqual(['open,never closed']);
    });

    it('uses the dialect delimiter', () => {
        expect(parseRecord('a;"b;c";d', ';').fields).toEqual(['a', 'b;c', 'd']);
        expect(parseRecord('a\tb', '\t').fields).toEqual(['a', 'b']);
    });

    it('strips exactly one LF or CRLF terminator', () => {
        expect(stripTerminator('a,b\r\n')).toBe('a,b');
        expect(stripTerminator('a,b\n')).toBe('a,b');
        expect(stripTerminator('a,b')).toBe('a,b');
        expect(stripTerminator('a\r\r\n')).toBe('a\r');
    });

    it('extracts one field without parsing the rest', () => {
        expect(extractField('a,b,c', ',', 1)).toBe('b');
        expect(extractField('a,b,c', ',', 5)).toBe('');
        expect(extractField('"x,y",z', ',', 0)).toBe('x,y');
        expect(extractField('', ',', 0)).toBe('');
    });
});

describe('csv record serialise', () => {
    it('round-trips fields that need quoting', () => {
        const fields = ['plain', 'a,b', 'say "hi"', 'multi\nline', '', '"lead'];
        const text = serialiseRecord(fields, null, comma);
        expect(text).toBe('plain,"a,b","say ""hi""","multi\nline",,"""lead"');
        expect(parseRecord(text, ',').fields).toEqual(fields);
    });

    it('keeps original quoting and quotes everything in a quote-all file', () => {
        expect(serialiseRecord(['a', 'b'], [true, false], comma)).toBe('"a",b');
        expect(serialiseRecord(['a', 'b'], null, { delimiter: ',', quoteAll: true })).toBe('"a","b"');
    });

    it('needsQuote looks at the delimiter, quotes and line breaks', () => {
        expect(needsQuote('a;b', ';')).toBe(true);
        expect(needsQuote('a;b', ',')).toBe(false);
        expect(needsQuote('cr\r', ',')).toBe(true);
        expect(needsQuote('', ',')).toBe(false);
    });

    it('writes an empty record as a blank line, and a single empty field the same way', () => {
        expect(serialiseRecord([], null, comma)).toBe('');
        expect(serialiseRecord([''], null, comma)).toBe('');
    });
});

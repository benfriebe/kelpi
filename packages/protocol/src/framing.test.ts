/// <reference types="node" />
// Required because @types/node is not auto-included for this project (pnpm-symlinked
// typeRoots); this test file needs `TextEncoder` to build byte chunks.

import { describe, expect, it } from 'vitest';

import { createLineBuffer } from './framing.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('line buffer', () => {
    it('emits one line per terminator', () => {
        const buffer = createLineBuffer();
        expect(buffer.push('{"command":"ping"}\n')).toEqual(['{"command":"ping"}']);
        expect(buffer.pending).toBe(0);
    });

    it('emits every line of a multi-line chunk in order', () => {
        const buffer = createLineBuffer();
        expect(buffer.push('{"a":1}\n{"b":2}\n{"c":3}\n')).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });

    it('holds a trailing partial until its terminator arrives', () => {
        const buffer = createLineBuffer();
        expect(buffer.push('{"command":"pi')).toEqual([]);
        expect(buffer.pending).toBe(14);
        expect(buffer.push('ng"}\n')).toEqual(['{"command":"ping"}']);
        expect(buffer.pending).toBe(0);
    });

    it('reassembles a line split across many reads (the 4096-byte bug)', () => {
        const buffer = createLineBuffer();
        const line = `{"command":"web-exec","script":"${'x'.repeat(9000)}"}`;
        const chunkSize = 4096;
        const lines: string[] = [];
        for (let offset = 0; offset < line.length; offset += chunkSize) {
            lines.push(...buffer.push(line.slice(offset, offset + chunkSize)));
        }
        expect(lines).toEqual([]);
        expect(buffer.push('\n')).toEqual([line]);
    });

    it('keeps a partial line that ends mid-chunk while emitting the complete ones', () => {
        const buffer = createLineBuffer();
        expect(buffer.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
        expect(buffer.push(':2}\n{"c":3}')).toEqual(['{"b":2}']);
        expect(buffer.pending).toBe('{"c":3}'.length);
    });

    it('skips blank segments the way the Swift server does', () => {
        const buffer = createLineBuffer();
        expect(buffer.push('\n\n{"a":1}\n\n  \n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    });

    it('can keep blank segments when asked', () => {
        const buffer = createLineBuffer({ skipBlank: false });
        expect(buffer.push('\n{"a":1}\n')).toEqual(['', '{"a":1}']);
    });

    it('preserves CR bytes for the decoder to trim', () => {
        const buffer = createLineBuffer();
        expect(buffer.push('{"a":1}\r\n')).toEqual(['{"a":1}\r']);
    });

    it('decodes byte chunks, including multi-byte characters split across reads', () => {
        const buffer = createLineBuffer();
        const bytes = encode('{"text":"héllo → ✓"}\n');
        expect(buffer.push(bytes.subarray(0, 12))).toEqual([]);
        expect(buffer.push(bytes.subarray(12))).toEqual(['{"text":"héllo → ✓"}']);
    });

    it('accepts a caller-supplied decoder', () => {
        const buffer = createLineBuffer({ decodeUtf8: () => '{"a":1}\n' });
        expect(buffer.push(encode('ignored'))).toEqual(['{"a":1}']);
    });

    it('drops an oversized line and keeps framing afterwards', () => {
        const buffer = createLineBuffer({ maxLineLength: 8 });
        expect(buffer.push('123456789012')).toEqual([]);
        expect(buffer.overflows).toBe(1);
        expect(buffer.push('3456\n{"a":1}\n')).toEqual(['{"a":1}']);
        expect(buffer.overflows).toBe(1);
    });

    it('counts an oversized complete line as an overflow without emitting it', () => {
        const buffer = createLineBuffer({ maxLineLength: 4 });
        expect(buffer.push('123456789\nok\n')).toEqual(['ok']);
        expect(buffer.overflows).toBe(1);
    });

    it('drops the pending tail on reset', () => {
        const buffer = createLineBuffer();
        buffer.push('{"partial"');
        buffer.reset();
        expect(buffer.pending).toBe(0);
        expect(buffer.push(':1}\n')).toEqual([':1}']);
    });
});

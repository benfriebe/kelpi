import { describe, expect, it } from 'vitest';

import {
    FrameDecoder,
    FrameType,
    MAX_FRAME_BYTES,
    encodeBlob,
    encodeData,
    encodeJson,
    encodeWrite,
    parseHello,
    parseKill,
    parseSpawn
} from './protocol.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('host frames', () => {
    it('round-trips every frame shape', () => {
        const decoder = new FrameDecoder();
        const frames = decoder.push(
            Uint8Array.from([
                ...encodeJson(FrameType.hello, { protocol: 1, token: 't', mode: 'attach' }),
                ...encodeWrite('pane-1', text('ls\r')),
                ...encodeData('pane-1', 2 ** 40, text('out')),
                ...encodeBlob(FrameType.checkpoint, { tid: 'pane-1', offset: 7 }, text('blob'))
            ])
        );
        expect(frames.map((frame) => frame.kind)).toEqual(['json', 'write', 'data', 'blob']);
        expect(frames[0]).toMatchObject({ type: FrameType.hello, body: { protocol: 1, token: 't' } });
        expect(frames[1]).toMatchObject({ tid: 'pane-1', bytes: text('ls\r') });
        expect(frames[2]).toMatchObject({ tid: 'pane-1', offset: 2 ** 40, bytes: text('out') });
        expect(frames[3]).toMatchObject({ body: { tid: 'pane-1', offset: 7 }, blob: text('blob') });
    });

    it('reassembles frames split at every byte boundary', () => {
        const bytes = Uint8Array.from([
            ...encodeData('t', 0, text('hello')),
            ...encodeJson(FrameType.exit, { tid: 't', code: 0, signal: null })
        ]);
        const decoder = new FrameDecoder();
        const seen = [];
        for (const byte of bytes) seen.push(...decoder.push(Uint8Array.of(byte)));
        expect(seen.map((frame) => frame.type)).toEqual([FrameType.data, FrameType.exit]);
        expect(seen[0]).toMatchObject({ bytes: text('hello') });
    });

    it('keeps no reference to the shared buffer in decoded bytes', () => {
        const decoder = new FrameDecoder();
        const [first] = decoder.push(encodeData('t', 0, text('abc')));
        decoder.push(encodeData('t', 3, text('xyz')));
        expect(first).toMatchObject({ bytes: text('abc') });
    });

    it('rejects an oversized or unknown frame', () => {
        const huge = new Uint8Array(5);
        new DataView(huge.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
        expect(() => new FrameDecoder().push(huge)).toThrow(/exceeds/);
        expect(() => new FrameDecoder().push(Uint8Array.of(0, 0, 0, 0, 99))).toThrow(/unknown frame type/);
    });

    it('rejects a terminal id that is empty or too long', () => {
        expect(() => encodeWrite('', text('x'))).toThrow();
        expect(() => encodeData('x'.repeat(256), 0, text('x'))).toThrow();
    });
});

describe('message validation', () => {
    const spawn = {
        tid: 't1',
        key: 'PANE',
        file: '/bin/zsh',
        args: ['-l'],
        cwd: '/tmp',
        env: { TERM: 'xterm-256color' },
        cols: 80,
        rows: 24,
        name: 'xterm-256color'
    };

    it('accepts a well-formed spawn and keeps the fallback', () => {
        expect(parseSpawn(spawn)).toEqual(spawn);
        expect(parseSpawn({ ...spawn, fallbackFile: '/bin/sh' })?.fallbackFile).toBe('/bin/sh');
    });

    it('refuses a spawn with a bad field', () => {
        expect(parseSpawn({ ...spawn, cols: 0 })).toBeNull();
        expect(parseSpawn({ ...spawn, env: { A: 1 } })).toBeNull();
        expect(parseSpawn({ ...spawn, args: [1] })).toBeNull();
        expect(parseSpawn({ ...spawn, file: '' })).toBeNull();
        expect(parseSpawn('nope')).toBeNull();
    });

    it('accepts only the two hello modes', () => {
        expect(parseHello({ protocol: 1, token: 'x', mode: 'probe' })).not.toBeNull();
        expect(parseHello({ protocol: 1, token: 'x', mode: 'other' })).toBeNull();
    });

    it('accepts only named signals', () => {
        expect(parseKill({ tid: 't', signal: 'SIGHUP' })).toEqual({ tid: 't', signal: 'SIGHUP' });
        expect(parseKill({ tid: 't', signal: 'rm -rf' })).toBeNull();
        expect(parseKill({ tid: 't' })).toEqual({ tid: 't', signal: undefined });
    });
});

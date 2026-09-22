import { describe, expect, it, vi } from 'vitest';
import { harnessLoadGate } from './harness-protocol.js';

describe('initial harness navigation gate', () => {
    it.each([{}, { KELPI_HARNESS: '1' }, { KELPI_HARNESS_DEFER_LOAD: '1' },
        { KELPI_HARNESS_SOCKET: '/tmp/test.sock' },
        { KELPI_HARNESS_SOCKET: ' ', KELPI_HARNESS_DEFER_LOAD: '1' },
        { KELPI_HARNESS_SOCKET: '/tmp/test.sock', KELPI_HARNESS_DEFER_LOAD: '0' }
    ])('does not defer without both explicit gates: %j', (env) => {
        const gate = harnessLoadGate(env);
        const load = vi.fn();
        expect(gate.defer(load)).toBe(false);
        expect(gate.release()).toBe(false);
        expect(load).not.toHaveBeenCalled();
    });

    it('holds initial loads until release, then never holds reconnects or later windows', () => {
        const gate = harnessLoadGate({ KELPI_HARNESS_SOCKET: '/tmp/test.sock', KELPI_HARNESS_DEFER_LOAD: '1' });
        const load = vi.fn();
        expect(gate.defer(load)).toBe(true);
        expect(load).not.toHaveBeenCalled();
        expect(gate.release()).toBe(true);
        expect(load).toHaveBeenCalledTimes(1);
        expect(gate.release()).toBe(false);
        expect(gate.defer(load)).toBe(false);
        expect(load).toHaveBeenCalledTimes(1);
    });
});

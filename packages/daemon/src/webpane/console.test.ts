import { describe, expect, it } from 'vitest';

import {
    createConsoleStore,
    normalizeConsoleLevel,
    serializeConsoleLine,
    type ConsoleLine
} from './console.js';

const PANE = 'PANE-1';

function line(overrides: Partial<ConsoleLine> = {}): ConsoleLine {
    return {
        tabID: 'TAB-1',
        level: 'log',
        message: 'hello',
        url: 'https://example.com/',
        capturedAt: 1_755_500_000_123,
        ...overrides
    };
}

describe('console levels', () => {
    it('maps engine level names onto the five wire levels', () => {
        expect(normalizeConsoleLevel('warning')).toBe('warn');
        expect(normalizeConsoleLevel('ERROR')).toBe('error');
        expect(normalizeConsoleLevel('verbose')).toBe('debug');
        expect(normalizeConsoleLevel('assert')).toBe('error');
        expect(normalizeConsoleLevel('nonsense')).toBe('log');
    });
});

describe('line serialization (§9.2)', () => {
    it('uses ISO8601 with fractional seconds and omits absent line/column', () => {
        expect(serializeConsoleLine(7, line())).toEqual({
            seq: 7,
            tab_id: 'TAB-1',
            level: 'log',
            message: 'hello',
            url: 'https://example.com/',
            captured_at: '2025-08-18T06:53:20.123Z'
        });
    });

    it('carries line/column when the capture had them', () => {
        const payload = serializeConsoleLine(1, line({ lineNumber: 10, columnNumber: 5 }));
        expect(payload['line']).toBe(10);
        expect(payload['column']).toBe(5);
    });
});

describe('poll drain (§9.2)', () => {
    it('answers an unknown pane with an empty drain rather than an error', () => {
        const store = createConsoleStore();
        expect(store.drain('nobody')).toEqual({ lines: [], next_since: 0, dropped: 0 });
    });

    it('filters by since and level, and reports next_since', () => {
        const store = createConsoleStore();
        store.append(PANE, line({ message: 'one' }));
        store.append(PANE, line({ message: 'two', level: 'error' }));
        store.append(PANE, line({ message: 'three' }));

        const all = store.drain(PANE);
        expect(all.lines.map((entry) => entry['message'])).toEqual(['one', 'two', 'three']);
        expect(all.next_since).toBe(3);

        expect(store.drain(PANE, { since: 2 }).lines.map((entry) => entry['seq'])).toEqual([2]);
        expect(store.drain(PANE, { level: 'error' }).lines.map((entry) => entry['message'])).toEqual([
            'two'
        ]);
    });

    it('acknowledges drops so the next drain reports only new ones', () => {
        const store = createConsoleStore({ capacity: 2 });
        for (const message of ['a', 'b', 'c', 'd']) store.append(PANE, line({ message }));
        const first = store.drain(PANE);
        expect(first.dropped).toBe(2);
        expect(first.lines.map((entry) => entry['message'])).toEqual(['c', 'd']);
        expect(store.drain(PANE).dropped).toBe(0);
    });

    it('clear empties the buffer but keeps the seq namespace', () => {
        const store = createConsoleStore();
        store.append(PANE, line({ message: 'a' }));
        const drained = store.drain(PANE, { clear: true });
        expect(drained.next_since).toBe(1);
        store.append(PANE, line({ message: 'b' }));
        const after = store.drain(PANE);
        expect(after.lines).toHaveLength(1);
        expect(after.lines[0]?.['seq']).toBe(1);
    });
});

describe('follow fan-out (§9.3)', () => {
    it('pushes one object per appended line to every subscriber', () => {
        const store = createConsoleStore();
        const a: Record<string, unknown>[] = [];
        const b: Record<string, unknown>[] = [];
        store.subscribe(PANE, { push: (entry) => a.push(entry) });
        const off = store.subscribe(PANE, { push: (entry) => b.push(entry) });
        expect(store.subscribers(PANE)).toBe(2);

        store.append(PANE, line({ message: 'one' }));
        off();
        store.append(PANE, line({ message: 'two' }));

        expect(a.map((entry) => entry['message'])).toEqual(['one', 'two']);
        expect(b.map((entry) => entry['message'])).toEqual(['one']);
        expect(store.subscribers(PANE)).toBe(1);
    });

    it('rides the drop count on the next streamed line and acknowledges it', () => {
        const store = createConsoleStore({ capacity: 2 });
        // Fill + overflow BEFORE anyone subscribes: those drops are still owed to the stream.
        for (const message of ['a', 'b', 'c']) store.append(PANE, line({ message }));
        const seen: Record<string, unknown>[] = [];
        store.subscribe(PANE, { push: (entry) => seen.push(entry) });

        store.append(PANE, line({ message: 'd' }));
        store.append(PANE, line({ message: 'e' }));

        expect(seen).toHaveLength(2);
        // 'a' was evicted before the subscribe, 'b' by 'd' → 2 drops on the first pushed line.
        expect(seen[0]?.['dropped']).toBe(2);
        expect(seen[0]?.['message']).toBe('d');
        // Acknowledged: the next line carries a fresh count (only 'c' was evicted since).
        expect(seen[1]?.['dropped']).toBe(1);
    });

    it('streamed lines ignore any level filter — the documented §9.3 quirk', () => {
        const store = createConsoleStore();
        const seen: Record<string, unknown>[] = [];
        // The drain filters; the subscription does not (there is nowhere to put the filter).
        store.drain(PANE, { level: 'error' });
        store.subscribe(PANE, { push: (entry) => seen.push(entry) });
        store.append(PANE, line({ level: 'log', message: 'noisy' }));
        expect(seen.map((entry) => entry['message'])).toEqual(['noisy']);
    });

    it('ends every stream and forgets the buffer when the pane closes', () => {
        const store = createConsoleStore();
        let ended = 0;
        store.subscribe(PANE, { push: () => {}, end: () => (ended += 1) });
        store.append(PANE, line());
        store.disposePane(PANE);
        expect(ended).toBe(1);
        expect(store.subscribers(PANE)).toBe(0);
        // A pane id reused after a close starts from a clean seq namespace.
        expect(store.drain(PANE)).toEqual({ lines: [], next_since: 0, dropped: 0 });
    });
});

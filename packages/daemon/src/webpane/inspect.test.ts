import { describe, expect, it } from 'vitest';

import {
    clampField,
    createInspectState,
    formatForPaste,
    INSPECT_LIMITS,
    INSPECT_QUEUE_CAP,
    sanitizeInspectPayload,
    serializeInspectResult,
    stripUnsafeControlCharacters,
    type InspectResult
} from './inspect.js';

const NOW = 1_755_500_000_123;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        nonce: 'abc',
        selector: '#login',
        xpath: '//*[@id="login"]',
        tag: 'BUTTON',
        element_id: 'login',
        outer_html: '<button id="login">Sign in</button>',
        attributes: { class: 'btn', tabindex: 2 },
        rect: { x: 10, y: 20, w: 80, h: 30 },
        text: 'Sign in',
        context_html: '<div><button id="login">Sign in</button></div>',
        url: 'https://example.com/login',
        captured_at: '2025-08-18T06:53:20.123Z',
        ...overrides
    };
}

describe('control-character stripping (§11.6)', () => {
    it('drops CSI, OSC and lone escapes but keeps newlines and tabs', () => {
        expect(stripUnsafeControlCharacters('a\u001b[31mred\u001b[0mb')).toBe('aredb');
        expect(stripUnsafeControlCharacters('x\u001b]52;c;cGF5bG9hZA==\u0007y')).toBe('xy');
        expect(stripUnsafeControlCharacters('x\u001b]0;title\u001b\\y')).toBe('xy');
        expect(stripUnsafeControlCharacters('a\u001bNb')).toBe('ab');
        expect(stripUnsafeControlCharacters('keep\nthese\there')).toBe('keep\nthese\there');
        expect(stripUnsafeControlCharacters('bell\u0007del\u007f')).toBe('belldel');
    });
});

describe('field clamping', () => {
    it('leaves a short value alone', () => {
        expect(clampField('hello', 100)).toBe('hello');
    });

    it('clamps on a UTF-8 boundary and appends the marker', () => {
        const clamped = clampField('é'.repeat(100), 20);
        expect(clamped.endsWith('... [truncated]')).toBe(true);
        expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThanOrEqual(20);
        // Never a broken code point.
        expect(clamped.includes('�')).toBe(false);
    });
});

describe('payload sanitisation', () => {
    it('normalises the wire payload into a clamped result', () => {
        const result = sanitizeInspectPayload('TAB', payload(), NOW);
        expect(result).not.toBeNull();
        expect(result?.tag).toBe('button');
        expect(result?.elementID).toBe('login');
        expect(result?.attributes).toEqual({ class: 'btn', tabindex: '2' });
        expect(result?.rect).toEqual({ x: 10, y: 20, w: 80, h: 30 });
        expect(result?.capturedAt).toBe(Date.parse('2025-08-18T06:53:20.123Z'));
    });

    it('strips escapes that would otherwise reach a PTY', () => {
        const result = sanitizeInspectPayload(
            'TAB',
            payload({ text: 'safe\u001b]52;c;cGF5bG9hZA==\u0007', selector: '#a\u001b[2J' }),
            NOW
        );
        expect(result?.text).toBe('safe');
        expect(result?.selector).toBe('#a');
    });

    it('clamps oversized fields to their budget', () => {
        const result = sanitizeInspectPayload('TAB', payload({ outer_html: 'x'.repeat(40_000) }), NOW);
        expect(Buffer.byteLength(result?.outerHTML ?? '', 'utf8')).toBeLessThanOrEqual(
            INSPECT_LIMITS.outerHTML
        );
        expect(result?.outerHTML.endsWith('... [truncated]')).toBe(true);
    });

    it('rejects a payload with no selector, tag or url (spoof guard)', () => {
        expect(
            sanitizeInspectPayload('TAB', { selector: '', tag: '', url: '', text: 'x' }, NOW)
        ).toBeNull();
    });

    it('defaults a missing rect and timestamp', () => {
        const result = sanitizeInspectPayload('TAB', { selector: '#a' }, NOW);
        expect(result?.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
        expect(result?.capturedAt).toBe(NOW);
    });
});

describe('wire + paste shapes', () => {
    const result = sanitizeInspectPayload('TAB', payload(), NOW) as InspectResult;

    it('omits empty optional fields in the drain reply (§11.5)', () => {
        const bare = sanitizeInspectPayload(
            'TAB',
            payload({ outer_html: '', context_html: '', comment: '' }),
            NOW
        ) as InspectResult;
        const wire = serializeInspectResult(bare);
        expect(wire['outer_html']).toBeUndefined();
        expect(wire['context_html']).toBeUndefined();
        expect(wire['comment']).toBeUndefined();
        expect(wire['id']).toBe('login');
        expect(wire['tab_id']).toBe('TAB');
    });

    it('formats the paste block as a directive plus a json fence (§11.4)', () => {
        const text = formatForPaste(result, NOW);
        const lines = text.split('\n');
        expect(lines[0]).toBe('# kelpi inspect 2025-08-18T06:53:20.123Z');
        expect(lines[1]).toBe('```json');
        expect(text.trimEnd().endsWith('```')).toBe(true);
        const body = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<
            string,
            unknown
        >;
        expect(body['selector']).toBe('#login');
        expect(Object.keys(body)).toEqual([...Object.keys(body)].sort());
    });
});

describe('arm + queue state', () => {
    it('caps the queue at 32, dropping the oldest', () => {
        const state = createInspectState();
        for (let index = 0; index < INSPECT_QUEUE_CAP + 5; index += 1) {
            const result = sanitizeInspectPayload(
                'TAB',
                payload({ selector: `#item-${String(index)}` }),
                NOW
            ) as InspectResult;
            state.enqueue('PANE', result);
        }
        const queued = state.queued('PANE');
        expect(queued).toHaveLength(INSPECT_QUEUE_CAP);
        expect(queued[0]?.selector).toBe('#item-5');
    });

    it('mints a fresh 128-bit nonce per arm and disarms once', () => {
        const state = createInspectState();
        const first = state.newNonce();
        const second = state.newNonce();
        expect(first).toHaveLength(32);
        expect(first).not.toBe(second);

        state.arm({ paneID: 'PANE', tabID: 'TAB', nonce: first, sendTo: null, submit: false });
        expect(state.armOf('PANE')?.nonce).toBe(first);
        expect(state.disarm('PANE')?.nonce).toBe(first);
        expect(state.armOf('PANE')).toBeNull();
        expect(state.disarm('PANE')).toBeNull();
    });

    it('drops everything for a closed pane', () => {
        const state = createInspectState();
        state.arm({ paneID: 'PANE', tabID: 'TAB', nonce: 'n', sendTo: null, submit: false });
        state.enqueue('PANE', sanitizeInspectPayload('TAB', payload(), NOW) as InspectResult);
        state.disposePane('PANE');
        expect(state.armOf('PANE')).toBeNull();
        expect(state.queued('PANE')).toEqual([]);
    });
});

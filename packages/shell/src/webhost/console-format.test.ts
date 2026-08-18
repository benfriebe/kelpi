/**
 * The console pipeline's message strings (web-pane.md §7.1).
 *
 * The port drops the injected console wrapper for CDP events (the spec offers both branches),
 * so the thing that has to stay identical is the *rendered line*: arguments joined with a single
 * space, `[Circular]` on cycles, the `Assertion failed:` prefix, and the `fetch 404 Not Found —
 * <url>` / `XHR 404 — GET <url> — Not Found` network strings the Swift wrapper produced.
 */

import { describe, expect, it } from 'vitest';

import {
    formatConsoleApiCall,
    formatConsoleArgs,
    formatErrorResponse,
    formatExceptionThrown,
    formatLoadingFailed,
    formatLogEntry,
    normalizeConsoleLevel,
    safeStringify
} from './console-format.js';

describe('normalizeConsoleLevel', () => {
    it('maps CDP levels onto the daemon ring buffer levels', () => {
        expect(normalizeConsoleLevel('warning')).toBe('warn');
        expect(normalizeConsoleLevel('verbose')).toBe('debug');
        expect(normalizeConsoleLevel('trace')).toBe('debug');
        expect(normalizeConsoleLevel('assert')).toBe('error');
        expect(normalizeConsoleLevel('ERROR')).toBe('error');
        expect(normalizeConsoleLevel('table')).toBe('log');
    });
});

describe('safeStringify', () => {
    it('breaks cycles with [Circular] rather than throwing', () => {
        const node: Record<string, unknown> = { name: 'a' };
        node['self'] = node;
        expect(safeStringify(node)).toBe('{"name":"a","self":"[Circular]"}');
    });

    it('keeps strings verbatim and names the two empty values', () => {
        expect(safeStringify('hi')).toBe('hi');
        expect(safeStringify(undefined)).toBe('undefined');
        expect(safeStringify(null)).toBe('null');
    });
});

describe('formatConsoleArgs', () => {
    it('joins arguments with a single space', () => {
        const line = formatConsoleArgs([
            { type: 'string', value: 'count' },
            { type: 'number', value: 3 },
            { type: 'undefined' },
            { type: 'object', subtype: 'null' }
        ]);
        expect(line).toBe('count 3 undefined null');
    });

    it('renders a Chromium object preview instead of dropping the argument', () => {
        const line = formatConsoleArgs([
            {
                type: 'object',
                className: 'Object',
                preview: {
                    type: 'object',
                    properties: [
                        { name: 'id', type: 'number', value: '7' },
                        { name: 'label', type: 'string', value: 'ok' }
                    ],
                    overflow: true
                }
            }
        ]);
        expect(line).toBe('{"id":7,"label":"ok", …}');
    });

    it('renders errors and functions from their description', () => {
        expect(
            formatConsoleArgs([{ type: 'object', subtype: 'error', description: 'Error: boom\n    at x' }])
        ).toBe('Error: boom\n    at x');
        expect(formatConsoleArgs([{ type: 'function', description: 'function f() {}' }])).toBe('function f() {}');
    });
});

describe('formatConsoleApiCall', () => {
    it('prefixes console.assert with the spec string', () => {
        const line = formatConsoleApiCall(
            { type: 'assert', args: [{ type: 'string', value: 'nope' }] },
            'https://a/'
        );
        expect(line).toEqual({ level: 'error', message: 'Assertion failed: nope', url: 'https://a/' });
    });

    it('keeps a bare assert prefix when there are no extra arguments', () => {
        expect(formatConsoleApiCall({ type: 'assert', args: [] }, 'https://a/').message).toBe('Assertion failed:');
    });

    it('maps warning onto warn', () => {
        expect(formatConsoleApiCall({ type: 'warning', args: [] }, '').level).toBe('warn');
    });
});

describe('formatExceptionThrown', () => {
    it('turns CDP 0-based positions into the browser 1-based ones', () => {
        const line = formatExceptionThrown(
            {
                text: 'Uncaught',
                url: 'https://a/app.js',
                lineNumber: 9,
                columnNumber: 4,
                exception: { type: 'object', subtype: 'error', description: 'TypeError: x is not a function' }
            },
            'https://a/'
        );
        expect(line.level).toBe('error');
        expect(line.line).toBe(10);
        expect(line.column).toBe(5);
        expect(line.message).toBe('TypeError: x is not a function (https://a/app.js:10:5)');
    });

    it('uses the promise-rejection wording when CDP says the throw was in a promise', () => {
        const line = formatExceptionThrown(
            {
                text: 'Uncaught (in promise) Error: nope',
                exception: { type: 'object', subtype: 'error', description: 'Error: nope' }
            },
            'https://a/'
        );
        expect(line.message).toBe('Unhandled promise rejection: Error: nope');
    });
});

describe('formatLogEntry', () => {
    it('drops network-sourced entries so one failure is not reported twice', () => {
        expect(
            formatLogEntry({ source: 'network', level: 'error', text: 'Failed to load resource' }, 'https://a/')
        ).toBeNull();
    });

    it('keeps everything else, with the entry url winning over the page url', () => {
        expect(formatLogEntry({ source: 'security', level: 'warning', text: 'mixed content', url: 'https://b/' }, 'https://a/')).toEqual(
            { level: 'warn', message: 'mixed content', url: 'https://b/' }
        );
    });
});

describe('network failures', () => {
    it('renders a failed fetch with the spec wording', () => {
        expect(
            formatLoadingFailed({ method: 'GET', url: 'https://a/x', type: 'Fetch' }, { errorText: 'net::ERR_FAILED' })
        ).toEqual({
            level: 'error',
            message: 'fetch failed — net::ERR_FAILED — https://a/x',
            url: 'https://a/x'
        });
    });

    it('renders a failed XHR with method and url', () => {
        expect(formatLoadingFailed({ method: 'POST', url: 'https://a/y', type: 'XHR' }, {})).toEqual({
            level: 'error',
            message: 'XHR error — POST https://a/y',
            url: 'https://a/y'
        });
    });

    it('renders a subresource failure with the tag the in-page listener would have reported', () => {
        expect(formatLoadingFailed({ method: 'GET', url: 'https://a/i.png', type: 'Image' }, {})?.message).toBe(
            'resource load failed: img https://a/i.png'
        );
    });

    it('ignores cancelled requests (navigating away cancels in-flight loads)', () => {
        expect(formatLoadingFailed({ method: 'GET', url: 'https://a/x', type: 'Fetch' }, { canceled: true })).toBeNull();
    });

    it('renders an error STATUS only for fetch/XHR', () => {
        expect(
            formatErrorResponse({ method: 'GET', url: 'https://a/z' }, { status: 404, statusText: 'Not Found', type: 'Fetch' })
        ).toEqual({ level: 'error', message: 'fetch 404 Not Found — https://a/z', url: 'https://a/z' });

        expect(
            formatErrorResponse({ method: 'GET', url: 'https://a/z' }, { status: 404, statusText: 'Not Found', type: 'XHR' })
        ).toEqual({ level: 'error', message: 'XHR 404 — GET https://a/z — Not Found', url: 'https://a/z' });

        // A 404 on an <img> is already reported by the subresource path; do not double-report.
        expect(formatErrorResponse({ method: 'GET', url: 'https://a/i.png' }, { status: 404, type: 'Image' })).toBeNull();
        // And a good response is not a console line at all.
        expect(formatErrorResponse({ method: 'GET', url: 'https://a/z' }, { status: 200, type: 'Fetch' })).toBeNull();
    });
});

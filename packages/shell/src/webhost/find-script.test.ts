// @vitest-environment jsdom
/**
 * §WEB-062 (and the marking either side of it) — the injected find script, driven in a DOM.
 *
 * The audit drives the same script against a real Chromium, but its fixture has a single match,
 * so it proves the marking and the counter and NOT the cycle: wrapping past the last match back
 * to the first, wrapping backwards off the front, and scrolling the current match to the
 * vertical centre. Those are the parts of the item that were written and never exercised.
 *
 * Evaluating the source here is legitimate rather than a stand-in: `findScript()` is the exact
 * string CDP injects, `Function.prototype.toString()` of the real function.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findScript } from './scripts.js';

interface FindResult {
    readonly total: number;
    readonly current: number;
}

interface PageWindow {
    __kelpiPost?: (channel: string, body: unknown) => void;
    __kelpiWebFind?: {
        search(needle: string): FindResult;
        next(): FindResult;
        prev(): FindResult;
        clear(): FindResult;
    };
}

const page = (): PageWindow => window as unknown as PageWindow;

let posted: FindResult[] = [];
let scrolled: { element: Element; options: unknown }[] = [];

beforeEach(() => {
    posted = [];
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element, options?: unknown): void {
        scrolled.push({ element: this, options });
    };
    document.body.innerHTML =
        '<p>alpha needle one</p><p>beta NEEDLE two</p><p>gamma needle three</p><script>var needle = 1;</script>';
    page().__kelpiPost = (_channel, body) => {
        posted.push(body as FindResult);
    };
    // A fresh window is not available between tests, so re-evaluating is a no-op after the
    // first install (`__kelpiWebFind !== undefined` returns early) — which is itself the guard
    // CDP re-injection depends on. Delete it to install a clean one per test.
    delete page().__kelpiWebFind;
    (0, eval)(findScript());
});

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('find marking', () => {
    it('marks every case-insensitive match, skipping script/style text', () => {
        const result = page().__kelpiWebFind?.search('needle');
        // Three in the prose; the one inside <script> is rejected by the tree walker.
        expect(result).toEqual({ total: 3, current: 0 });
        expect(document.querySelectorAll('.kelpi-webfind-match')).toHaveLength(3);
        expect(document.querySelectorAll('.kelpi-webfind-current')).toHaveLength(1);
        // Every result is also posted on the find channel, for the chrome's counter.
        expect(posted.at(-1)).toEqual({ total: 3, current: 0 });
    });

    it('clear restores the original text nodes', () => {
        page().__kelpiWebFind?.search('needle');
        expect(page().__kelpiWebFind?.clear()).toEqual({ total: 0, current: -1 });
        expect(document.querySelectorAll('.kelpi-webfind-match')).toHaveLength(0);
        expect(document.body.textContent).toContain('alpha needle one');
    });
});

describe('WEB-062: next / previous wrap and centre', () => {
    it('wraps forward past the last match', () => {
        page().__kelpiWebFind?.search('needle');
        expect(page().__kelpiWebFind?.next()).toEqual({ total: 3, current: 1 });
        expect(page().__kelpiWebFind?.next()).toEqual({ total: 3, current: 2 });
        expect(page().__kelpiWebFind?.next()).toEqual({ total: 3, current: 0 });
    });

    it('wraps backward off the front', () => {
        page().__kelpiWebFind?.search('needle');
        expect(page().__kelpiWebFind?.prev()).toEqual({ total: 3, current: 2 });
        expect(page().__kelpiWebFind?.prev()).toEqual({ total: 3, current: 1 });
    });

    it('moves the `current` class with the cycle', () => {
        page().__kelpiWebFind?.search('needle');
        const marks = [...document.querySelectorAll('.kelpi-webfind-match')];
        expect(marks[0]?.classList.contains('kelpi-webfind-current')).toBe(true);
        page().__kelpiWebFind?.next();
        expect(marks[0]?.classList.contains('kelpi-webfind-current')).toBe(false);
        expect(marks[1]?.classList.contains('kelpi-webfind-current')).toBe(true);
    });

    it('scrolls each newly current match to the vertical centre', () => {
        page().__kelpiWebFind?.search('needle');
        expect(scrolled.at(-1)?.options).toEqual({ block: 'center' });
        const first = scrolled.at(-1)?.element;

        page().__kelpiWebFind?.next();
        expect(scrolled.at(-1)?.options).toEqual({ block: 'center' });
        expect(scrolled.at(-1)?.element).not.toBe(first);
        expect(scrolled).toHaveLength(2);
    });

    it('is a no-op with nothing marked, rather than a divide by zero', () => {
        expect(page().__kelpiWebFind?.next()).toEqual({ total: 0, current: -1 });
        expect(page().__kelpiWebFind?.search('absent')).toEqual({ total: 0, current: -1 });
        expect(page().__kelpiWebFind?.prev()).toEqual({ total: 0, current: -1 });
    });
});

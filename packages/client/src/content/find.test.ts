/**
 * The injected `__nexFind` namespace (content-panes.md §3.13), exercised by RUNNING the
 * bridge script against a real DOM.
 *
 * That is the point of this file: the find implementation lives in a string that only ever
 * executes inside a sandboxed iframe, where no test can reach it. Evaluating it here in jsdom
 * — where `parent` is the window itself, so its `postMessage`s come back as ordinary message
 * events — is the only way the §3.13 contract (mark elements, the two highlight colors, the
 * `{total, current}` result, wrap-around, unwrap-on-clear) gets asserted at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONTENT_BRIDGE_SOURCE, FIND_CURRENT_COLOR, FIND_MATCH_COLOR, contentBridgeScript } from './bridge';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

interface FindApi {
    search(needle: string): void;
    next(): void;
    prev(): void;
    clear(): void;
}

interface FindResult {
    readonly total: number;
    readonly current: number;
}

const results: FindResult[] = [];

function collect(event: MessageEvent): void {
    const data = event.data as Record<string, unknown> | null;
    if (data === null || data['source'] !== CONTENT_BRIDGE_SOURCE) return;
    if (data['kind'] !== 'find-result') return;
    results.push({ total: data['total'] as number, current: data['current'] as number });
}

function api(): FindApi {
    return (window as unknown as { __nexFind: FindApi }).__nexFind;
}

function marks(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('mark.nex-find-match')];
}

function currentIndex(): number {
    return marks().findIndex((mark) => mark.classList.contains('nex-find-current'));
}

/** The script posts through `parent`, which in jsdom is this window; delivery is async. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    results.length = 0;
    document.head.innerHTML = '';
    document.body.innerHTML =
        '<div id="content"><p>alpha beta Alpha</p><pre><code>alpha in code</code></pre>' +
        '<script>var alpha = 1;</script></div>';
    // The bridge guards against double injection; each test gets a fresh install.
    delete (window as unknown as Record<string, unknown>)['__nexContentBridge'];
    window.addEventListener('message', collect);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the injected script IS the test
    new Function(contentBridgeScript(PANE))();
});

afterEach(() => {
    window.removeEventListener('message', collect);
});

describe('__nexFind', () => {
    it('is installed by the bridge script', () => {
        expect(typeof api().search).toBe('function');
        expect(typeof api().next).toBe('function');
        expect(typeof api().prev).toBe('function');
        expect(typeof api().clear).toBe('function');
    });

    it('marks every case-insensitive match and reports the count', async () => {
        api().search('alpha');
        await settle();

        // Three in prose/code, and the one inside `<script>` deliberately skipped.
        expect(marks()).toHaveLength(3);
        expect(marks().map((mark) => mark.textContent)).toEqual(['alpha', 'Alpha', 'alpha']);
        expect(results.at(-1)).toEqual({ total: 3, current: 0 });
        expect(currentIndex()).toBe(0);
    });

    it('injects the spec’s highlight palette', () => {
        api().search('alpha');
        const style = document.getElementById('__nex-find-style');
        expect(style?.textContent).toContain(FIND_MATCH_COLOR);
        expect(style?.textContent).toContain(FIND_CURRENT_COLOR);
        expect(style?.textContent).toContain('mark.nex-find-match');
    });

    it('wraps around in both directions', async () => {
        api().search('alpha');
        api().next();
        expect(currentIndex()).toBe(1);
        api().next();
        expect(currentIndex()).toBe(2);
        api().next();
        expect(currentIndex()).toBe(0);
        api().prev();
        expect(currentIndex()).toBe(2);
        await settle();
        expect(results.at(-1)).toEqual({ total: 3, current: 2 });
    });

    it('treats the needle as a literal, not a regex', async () => {
        document.body.innerHTML = '<div id="content"><p>a.c and abc</p></div>';
        api().search('a.c');
        await settle();
        expect(marks().map((mark) => mark.textContent)).toEqual(['a.c']);
    });

    it('reports 0/-1 for an empty needle and for no matches', async () => {
        api().search('');
        await settle();
        expect(results.at(-1)).toEqual({ total: 0, current: -1 });
        expect(marks()).toHaveLength(0);

        api().search('nothing-here');
        await settle();
        expect(results.at(-1)).toEqual({ total: 0, current: -1 });
    });

    it('unwraps every mark on clear, restoring the original text', async () => {
        api().search('alpha');
        expect(marks()).toHaveLength(3);

        api().clear();
        await settle();
        expect(marks()).toHaveLength(0);
        expect(document.querySelector('#content p')?.textContent).toBe('alpha beta Alpha');
        expect(results.at(-1)).toEqual({ total: 0, current: -1 });
    });

    it('replaces the previous search’s marks rather than nesting them', () => {
        api().search('alpha');
        api().search('beta');
        expect(marks().map((mark) => mark.textContent)).toEqual(['beta']);
        expect(document.querySelector('#content p')?.textContent).toBe('alpha beta Alpha');
    });
});

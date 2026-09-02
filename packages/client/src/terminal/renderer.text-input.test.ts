/**
 * C2: `TerminalRenderer.setTextInputAttributes`, the one narrow way into the engine's textarea.
 *
 * Its own file rather than a block in `renderer.test.ts` for the same reason
 * `TerminalPane.keyboard.test.tsx` is its own file: C1 is adding a method to the same interface in
 * the same hours, and a 1,000-line shared test file is a merge conflict per assertion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    createRendererFromLoader,
    resetEngineStartupGateForTests,
    type EngineDisposable,
    type EngineHandle,
    type XtermLikeTerminal
} from './renderer';

beforeEach(() => {
    resetEngineStartupGateForTests();
});

afterEach(() => {
    resetEngineStartupGateForTests();
});

/**
 * An engine that builds a hidden textarea inside its host, the way both shipped ones do
 * (`vendor/ghostty-web-patched/source/lib/terminal.ts:408-415`), and optionally publishes it under
 * the `textarea` name the adapter prefers.
 */
class TextareaEngine implements XtermLikeTerminal {
    cols = 80;
    rows = 24;
    opened: HTMLElement | null = null;
    textarea: HTMLTextAreaElement | null = null;

    constructor(private readonly publish: boolean) {}

    open(parent: HTMLElement): void {
        this.opened = parent;
        const area = parent.ownerDocument.createElement('textarea');
        // The three the engine sets on every platform, so the "we did not remove these" assertion
        // is against the real starting point.
        area.setAttribute('autocorrect', 'off');
        area.setAttribute('autocapitalize', 'off');
        area.setAttribute('spellcheck', 'false');
        parent.appendChild(area);
        if (this.publish) this.textarea = area;
    }

    write(): void {
        /* not exercised here */
    }
    reset(): void {
        /* not exercised here */
    }
    focus(): void {
        /* not exercised here */
    }
    blur(): void {
        /* not exercised here */
    }
    resize(cols: number, rows: number): void {
        this.cols = cols;
        this.rows = rows;
    }
    dispose(): void {
        this.textarea = null;
    }
    onData(): EngineDisposable {
        return { dispose: () => undefined };
    }
}

function loaderFor(engine: TextareaEngine): () => Promise<EngineHandle> {
    return () => Promise.resolve({ terminal: engine });
}

function host(): HTMLElement {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return element;
}

describe('setTextInputAttributes', () => {
    it('sets them on the textarea the engine publishes', async () => {
        const engine = new TextareaEngine(true);
        const renderer = createRendererFromLoader('ghostty', loaderFor(engine));
        await renderer.open(host());

        renderer.setTextInputAttributes?.({ inputmode: 'text', enterkeyhint: 'send' });

        expect(engine.textarea?.getAttribute('inputmode')).toBe('text');
        expect(engine.textarea?.getAttribute('enterkeyhint')).toBe('send');
        renderer.dispose();
    });

    it('finds the textarea in the host when the engine does not publish one', async () => {
        const engine = new TextareaEngine(false);
        const renderer = createRendererFromLoader('xterm', loaderFor(engine));
        const element = host();
        await renderer.open(element);

        renderer.setTextInputAttributes?.({ enterkeyhint: 'send' });

        expect(element.querySelector('textarea')?.getAttribute('enterkeyhint')).toBe('send');
        renderer.dispose();
    });

    it('applies what was asked for BEFORE the engine opened, once it has a textarea', async () => {
        // The pane's ordering: a phone pane's effect can run while `open()` is still in flight,
        // and the textarea does not exist until it resolves.
        const engine = new TextareaEngine(true);
        const renderer = createRendererFromLoader('ghostty', loaderFor(engine));
        renderer.setTextInputAttributes?.({ inputmode: 'text' });

        await renderer.open(host());

        expect(engine.textarea?.getAttribute('inputmode')).toBe('text');
        renderer.dispose();
    });

    it('removes an attribute for a null value, and leaves the ones the engine set alone', async () => {
        const engine = new TextareaEngine(true);
        const renderer = createRendererFromLoader('ghostty', loaderFor(engine));
        await renderer.open(host());
        renderer.setTextInputAttributes?.({ inputmode: 'text', enterkeyhint: 'send' });

        renderer.setTextInputAttributes?.({ inputmode: null, enterkeyhint: null });

        expect(engine.textarea?.hasAttribute('inputmode')).toBe(false);
        expect(engine.textarea?.hasAttribute('enterkeyhint')).toBe(false);
        // The engine's three are the engine's.
        expect(engine.textarea?.getAttribute('autocorrect')).toBe('off');
        expect(engine.textarea?.getAttribute('autocapitalize')).toBe('off');
        expect(engine.textarea?.getAttribute('spellcheck')).toBe('false');
        renderer.dispose();
    });

    it('leaves the textarea exactly as the engine built it when nobody asks (every desktop pane)', async () => {
        const engine = new TextareaEngine(true);
        const renderer = createRendererFromLoader('ghostty', loaderFor(engine));
        await renderer.open(host());

        const area = engine.textarea;
        expect(area).not.toBeNull();
        expect(area?.getAttributeNames().sort()).toEqual(['autocapitalize', 'autocorrect', 'spellcheck']);
        renderer.dispose();
    });
});

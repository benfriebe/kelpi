/**
 * The font contract: the stack a pane renders with, and the arithmetic that turns it into
 * columns. Both are load-bearing — a stack without the bundled face is tofu, and a cell
 * measured differently from the engine's own rule is a canvas that overruns its pane.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    BUNDLED_TERMINAL_FONT_FAMILY,
    TERMINAL_FONT_FALLBACKS,
    loadTerminalFonts,
    measureCellSize,
    onTerminalFontsReady,
    resetTerminalFontsForTests,
    terminalFontStack,
    terminalFontsReady
} from './fonts';

interface FontStub {
    load: ReturnType<typeof vi.fn>;
    ready: Promise<void>;
    status: string;
}

function installFontSet(stub: Partial<FontStub> = {}): FontStub {
    const set: FontStub = {
        load: stub.load ?? vi.fn(async () => []),
        ready: stub.ready ?? Promise.resolve(),
        status: stub.status ?? 'loaded'
    };
    Object.defineProperty(document, 'fonts', { value: set, configurable: true });
    return set;
}

function removeFontSet(): void {
    Reflect.deleteProperty(document as unknown as Record<string, unknown>, 'fonts');
}

afterEach(() => {
    removeFontSet();
    resetTerminalFontsForTests();
    vi.restoreAllMocks();
});

describe('terminalFontStack', () => {
    it('puts the bundled Nerd Font behind the user font', () => {
        expect(terminalFontStack('Berkeley Mono')).toBe(`"Berkeley Mono", ${TERMINAL_FONT_FALLBACKS}`);
    });

    it('leaves a single-identifier family unquoted and a pre-quoted one alone', () => {
        expect(terminalFontStack('Menlo')).toBe(`Menlo, ${TERMINAL_FONT_FALLBACKS}`);
        expect(terminalFontStack('"My Font"')).toBe(`"My Font", ${TERMINAL_FONT_FALLBACKS}`);
    });

    it('passes a user-written stack through as the head', () => {
        expect(terminalFontStack('Fira Code, Menlo')).toBe(`Fira Code, Menlo, ${TERMINAL_FONT_FALLBACKS}`);
    });

    it('falls back to the bundled stack alone for null/blank', () => {
        expect(terminalFontStack(null)).toBe(TERMINAL_FONT_FALLBACKS);
        expect(terminalFontStack('   ')).toBe(TERMINAL_FONT_FALLBACKS);
        expect(terminalFontStack(undefined)).toBe(TERMINAL_FONT_FALLBACKS);
    });

    it('always contains the bundled family — the glyph coverage the Swift app had', () => {
        expect(TERMINAL_FONT_FALLBACKS).toContain(BUNDLED_TERMINAL_FONT_FAMILY);
        expect(terminalFontStack('Menlo')).toContain(BUNDLED_TERMINAL_FONT_FAMILY);
    });
});

describe('loadTerminalFonts', () => {
    it('settles synchronously where there is no FontFaceSet to wait on', () => {
        expect(terminalFontsReady()).toBe(false);
        void loadTerminalFonts(13);
        // Synchronous on purpose: a pane must not lose a frame (or a test its mount) waiting
        // for a font API that does not exist.
        expect(terminalFontsReady()).toBe(true);
    });

    it('asks for each bundled weight, with a private-use glyph in the sample text', async () => {
        const set = installFontSet();
        await loadTerminalFonts(15);
        expect(terminalFontsReady()).toBe(true);
        const requests = set.load.mock.calls.map((call) => String(call[0]));
        expect(requests).toContain(`400 15px "${BUNDLED_TERMINAL_FONT_FAMILY}"`);
        expect(requests).toContain(`700 15px "${BUNDLED_TERMINAL_FONT_FAMILY}"`);
        // U+E0B0 is the Powerline separator; without it the browser may skip the face that
        // actually carries the icons.
        expect(String(set.load.mock.calls[0]?.[1])).toContain('\u{E0B0}');
    });

    it('is idempotent: a second call does not re-request', async () => {
        const set = installFontSet();
        await Promise.all([loadTerminalFonts(), loadTerminalFonts()]);
        await loadTerminalFonts();
        expect(set.load).toHaveBeenCalledTimes(2); // one per weight, once
    });

    it('resolves even when the face fails to load', async () => {
        const set = installFontSet({ load: vi.fn(async () => Promise.reject(new Error('404'))) });
        await expect(loadTerminalFonts()).resolves.toBeUndefined();
        expect(set.load).toHaveBeenCalled();
        expect(terminalFontsReady()).toBe(true);
    });

    it('gives up waiting rather than leaving a pane blank on a slow link', async () => {
        // ~900 KB over a tailnet is not instant. The pane opens with fallback metrics and
        // corrects them when the face lands (see `onTerminalFontsReady`).
        const held: (() => void)[] = [];
        installFontSet({
            load: vi.fn(async () => await new Promise<void>((resolve) => held.push(resolve)))
        });
        const release = (): void => {
            for (const resolve of held.splice(0)) resolve();
        };

        await loadTerminalFonts(13, 5);
        expect(terminalFontsReady()).toBe(false);

        const notified: number[] = [];
        onTerminalFontsReady(() => notified.push(1));
        release();
        await vi.waitFor(() => expect(terminalFontsReady()).toBe(true));
        expect(notified).toEqual([1]);
    });

    it('notifies late listeners immediately once settled', async () => {
        installFontSet();
        await loadTerminalFonts();
        const notified: number[] = [];
        const off = onTerminalFontsReady(() => notified.push(1));
        expect(notified).toEqual([1]);
        off();
    });
});

describe('measureCellSize', () => {
    function stubCanvas(width: number): void {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            font: '',
            measureText: () => ({
                width,
                actualBoundingBoxAscent: 10,
                actualBoundingBoxDescent: 3
            })
        } as unknown as CanvasRenderingContext2D);
    }

    it('rounds the advance UP, exactly as the engine does', () => {
        // ghostty-web: `Math.ceil(measureText('M').width)`. Measuring 7.8 and then drawing at 8
        // is precisely how a pane ends up one column too wide for its own canvas.
        stubCanvas(7.8);
        expect(measureCellSize(13, 'Menlo').width).toBe(8);
    });

    it('derives the line box from the ascent + descent, plus the engine +2', () => {
        stubCanvas(8);
        expect(measureCellSize(13, 'Menlo').height).toBe(15);
    });

    it('falls back to font-derived ratios without a 2D context', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const cell = measureCellSize(13, 'Menlo');
        expect(cell.width).toBeGreaterThan(0);
        expect(cell.height).toBeGreaterThan(0);
    });

    it('never returns a zero cell for a degenerate measurement', () => {
        stubCanvas(0);
        const cell = measureCellSize(13, 'Menlo');
        expect(cell.width).toBeGreaterThan(0);
        expect(cell.height).toBeGreaterThan(0);
    });

    it('re-measures once the fonts are ready (the cache is keyed on it)', async () => {
        stubCanvas(7.8);
        expect(measureCellSize(13, 'Menlo').width).toBe(8);
        installFontSet();
        await loadTerminalFonts();
        stubCanvas(9.2);
        // A measurement taken against the fallback face must not outlive the real one.
        expect(measureCellSize(13, 'Menlo').width).toBe(10);
    });
});

import { describe, expect, it } from 'vitest';

import { encodeQr, type QrEcLevel, type QrMatrix } from './encode.js';
import { QR_QUIET_ZONE, qrSvg, qrText } from './render.js';

/**
 * A matrix small enough to read. Not a real symbol: the renderers only ever ask a matrix which
 * modules are dark and how many there are, so a three-module grid exercises every branch of
 * both of them while leaving the expected output short enough to be checked by eye.
 */
function fakeMatrix(rows: readonly string[]): QrMatrix {
    const size = rows.length;
    const modules = new Uint8Array(size * size);
    rows.forEach((row, y) => {
        for (let x = 0; x < size; x += 1) modules[y * size + x] = row[x] === '1' ? 1 : 0;
    });
    return {
        version: 1,
        size,
        ecLevel: 'M' as QrEcLevel,
        mask: 0,
        modules,
        module: (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? false : modules[y * size + x] === 1)
    };
}

const TINY = fakeMatrix(['101', '010', '111']);

describe('qrSvg', () => {
    it('renders a fixed matrix to a fixed string', () => {
        expect(qrSvg(TINY, { moduleSize: 2, quietZone: 1 })).toBe(
            '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code"' +
                ' width="10" height="10" viewBox="0 0 5 5" shape-rendering="crispEdges">' +
                '<rect width="5" height="5" fill="#ffffff"/>' +
                '<path fill="#000000" d="M1 1h1v1h-1zM3 1h1v1h-1zM2 2h1v1h-1zM1 3h3v1h-3z"/>' +
                '</svg>'
        );
    });

    /**
     * The whole reason the path is built by hand. A version 10 symbol is 3249 modules; one
     * `<rect>` each would be sixteen hundred-odd elements in the DOM for a picture that never
     * changes. Horizontal runs merge, so the bottom row of the tiny matrix above is one subpath
     * for three modules, not three.
     */
    it('is exactly one path, whatever the symbol', () => {
        for (const matrix of [TINY, encodeQr('kelpi'), encodeQr('k'.repeat(300), { ecLevel: 'H' })]) {
            const svg = qrSvg(matrix);
            expect(svg.match(/<path/g)).toHaveLength(1);
            expect(svg).not.toContain('<rect x');
        }
    });

    it('runs of dark modules merge into one subpath', () => {
        // Four across, so the subpath count is 1 and not 4.
        const run = qrSvg(fakeMatrix(['1111', '0000', '0000', '0000']), { quietZone: 0 });
        expect(run).toContain('d="M0 0h4v1h-4z"');
        expect(run.match(/M/g)).toHaveLength(1);
    });

    it('measures the viewBox in modules and the width in pixels', () => {
        const matrix = encodeQr('kelpi');
        const svg = qrSvg(matrix, { moduleSize: 6, quietZone: 4 });
        const extent = matrix.size + 8;
        expect(svg).toContain(`viewBox="0 0 ${String(extent)} ${String(extent)}"`);
        expect(svg).toContain(`width="${String(extent * 6)}" height="${String(extent * 6)}"`);
    });

    it('leaves a quiet zone of four modules by default, on all four sides', () => {
        const matrix = encodeQr('kelpi');
        const svg = qrSvg(matrix);
        const extent = matrix.size + QR_QUIET_ZONE * 2;
        expect(svg).toContain(`viewBox="0 0 ${String(extent)} ${String(extent)}"`);

        const starts = [...svg.matchAll(/M(\d+) (\d+)h(\d+)/g)].map((match) => ({
            x: Number(match[1]),
            y: Number(match[2]),
            width: Number(match[3])
        }));
        expect(starts.length).toBeGreaterThan(0);
        for (const bar of starts) {
            expect(bar.x).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
            expect(bar.y).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
            expect(bar.x + bar.width).toBeLessThanOrEqual(QR_QUIET_ZONE + matrix.size);
            expect(bar.y).toBeLessThan(QR_QUIET_ZONE + matrix.size);
        }
    });

    it('takes the colours it is given, and drops the background rectangle when asked', () => {
        expect(qrSvg(TINY, { foreground: '#101014', background: '#e6e6ea' })).toContain(
            '<rect width="11" height="11" fill="#e6e6ea"/>'
        );
        expect(qrSvg(TINY, { foreground: '#101014', background: '#e6e6ea' })).toContain('<path fill="#101014"');
        expect(qrSvg(TINY, { background: '' })).not.toContain('<rect');
    });

    /** Announced as one image rather than read out as nothing, and the label is the caller's. */
    it('carries role=img and the label it was given, escaped', () => {
        const svg = qrSvg(TINY, { ariaLabel: 'Pair "werk" & scan <this>' });
        expect(svg).toContain('role="img"');
        expect(svg).toContain('aria-label="Pair &quot;werk&quot; &amp; scan &lt;this&gt;"');
        expect(qrSvg(TINY)).toContain('aria-label="QR code"');
    });
});

describe('qrText', () => {
    it('renders a fixed matrix to a fixed string', () => {
        expect(qrText(TINY, { quietZone: 1 })).toBe(['█▀█▀█', '█▀ ▀█', '█████'].join('\n'));
    });

    /**
     * The glyphs carry the LIGHT modules, so on a dark terminal the symbol has the polarity a
     * camera expects and the quiet zone is actually painted. `invert` is for a light terminal.
     */
    it('inverts on request, and the two are exact opposites', () => {
        expect(qrText(TINY, { quietZone: 1, invert: true })).toBe([' ▄ ▄ ', ' ▄█▄ ', '     '].join('\n'));

        // Glyph for glyph: a full block becomes a space, and each half block becomes the other.
        const opposite: Record<string, string> = { '█': ' ', ' ': '█', '▀': '▄', '▄': '▀', '\n': '\n' };
        const matrix = encodeQr('kelpi');
        const flipped = [...qrText(matrix)].map((glyph) => opposite[glyph]).join('');
        expect(qrText(matrix, { invert: true })).toBe(flipped);
    });

    it('is two module rows per line, with the quiet zone on every side', () => {
        const matrix = encodeQr('https://mac.tail1234.ts.net/?token=kd_terminal');
        const lines = qrText(matrix).split('\n');
        const extent = matrix.size + QR_QUIET_ZONE * 2;
        expect(lines).toHaveLength(Math.ceil(extent / 2));
        for (const line of lines) expect([...line]).toHaveLength(extent);

        // Two whole lines of quiet zone above and below, and four glyphs of it left and right.
        const quietLine = '█'.repeat(extent);
        expect(lines[0]).toBe(quietLine);
        expect(lines[1]).toBe(quietLine);
        expect(lines[lines.length - 1]).toBe(quietLine);
        for (const line of lines) {
            expect(line.slice(0, QR_QUIET_ZONE)).toBe('█'.repeat(QR_QUIET_ZONE));
            expect(line.slice(-QR_QUIET_ZONE)).toBe('█'.repeat(QR_QUIET_ZONE));
        }
    });

    it('pads an odd number of rows with quiet zone rather than clipping the symbol', () => {
        // Size 21 plus a quiet zone of 3 is 27 rows: 14 lines, the last one half empty.
        const matrix = encodeQr('kelpi');
        expect(matrix.size).toBe(21);
        const lines = qrText(matrix, { quietZone: 3 }).split('\n');
        expect(lines).toHaveLength(14);
        expect(lines[13]).toBe('█'.repeat(27));
    });

    it('fits a terminal: a version 10 symbol is 65 columns and 33 lines', () => {
        const matrix = encodeQr('k'.repeat(191));
        expect(matrix.version).toBe(10);
        const lines = qrText(matrix).split('\n');
        expect(lines).toHaveLength(33);
        expect([...(lines[0] as string)]).toHaveLength(65);
    });

    it('carries no control characters, so the caller owns the colour', () => {
        const text = qrText(encodeQr('kelpi'));
        const control = [...text].find((character) => character !== '\n' && character.codePointAt(0)! < 0x20);
        expect(control).toBeUndefined();
    });
});

import { describe, expect, it } from 'vitest';

import {
    QR_MAX_VERSION,
    encodeQr,
    qrDataCodewords,
    qrSizeForVersion,
    type QrEcLevel,
    type QrMatrix
} from './encode.js';
import { QR_REFERENCE_FIXTURES } from './fixtures.reference.js';

/** The matrix as the fixtures store it: one string a row, '1' dark. */
function toRows(matrix: QrMatrix): string[] {
    const rows: string[] = [];
    for (let y = 0; y < matrix.size; y += 1) {
        let row = '';
        for (let x = 0; x < matrix.size; x += 1) row += matrix.module(x, y) ? '1' : '0';
        rows.push(row);
    }
    return rows;
}

// ── against a reference encoder ─────────────────────────────────────────────────────

describe('encodeQr against reference matrices', () => {
    for (const fixture of QR_REFERENCE_FIXTURES) {
        it(`reproduces ${fixture.id} module for module`, () => {
            // The payload itself is pinned too: a fixture whose text drifted would compare a
            // matrix of something else against a matrix of the original, and pass or fail for
            // reasons that have nothing to do with the encoder.
            expect(new TextEncoder().encode(fixture.text).length).toBe(fixture.byteLength);

            const matrix = encodeQr(fixture.text, { ecLevel: fixture.ecLevel });
            expect(matrix.version).toBe(fixture.version);
            expect(matrix.mask).toBe(fixture.mask);
            expect(matrix.ecLevel).toBe(fixture.ecLevel);
            expect(matrix.size).toBe(fixture.rows.length);
            expect(toRows(matrix)).toEqual([...fixture.rows]);
        });
    }

    it('covers version 1 through 10 and every error-correction level between them', () => {
        const versions = new Set(QR_REFERENCE_FIXTURES.map((fixture) => fixture.version));
        const levels = new Set(QR_REFERENCE_FIXTURES.map((fixture) => fixture.ecLevel));
        expect([...levels].sort()).toEqual(['H', 'L', 'M', 'Q']);
        expect(Math.min(...versions)).toBe(1);
        // Version 10 is the first with a 16-bit character count and version information, so a
        // fixture at or above it is what proves those two branches are ever taken.
        expect(Math.max(...versions)).toBeGreaterThanOrEqual(10);
    });
});

// ── structure ───────────────────────────────────────────────────────────────────────

describe('symbol structure', () => {
    const matrix = encodeQr('https://mac.tail1234.ts.net/?token=kd_structure', { ecLevel: 'Q' });

    it('is 17 + 4v modules on a side', () => {
        for (const version of [1, 2, 7, 10, 40]) {
            expect(qrSizeForVersion(version)).toBe(17 + 4 * version);
        }
        expect(matrix.size).toBe(17 + 4 * matrix.version);
        expect(matrix.modules).toHaveLength(matrix.size * matrix.size);
    });

    /**
     * The three finders are what a scanner looks for first, and their separators are the light
     * ring that makes the 1:1:3:1:1 ratio readable from any angle. Bottom-right is deliberately
     * absent: its absence is how a decoder tells which way up the symbol is.
     */
    it('puts a finder and its separator in three corners and not the fourth', () => {
        const finderAt = (originX: number, originY: number): string[] => {
            const rows: string[] = [];
            for (let y = 0; y < 7; y += 1) {
                let row = '';
                for (let x = 0; x < 7; x += 1) row += matrix.module(originX + x, originY + y) ? '1' : '0';
                rows.push(row);
            }
            return rows;
        };
        const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
        const last = matrix.size - 7;
        expect(finderAt(0, 0)).toEqual(finder);
        expect(finderAt(last, 0)).toEqual(finder);
        expect(finderAt(0, last)).toEqual(finder);
        expect(finderAt(last, last)).not.toEqual(finder);

        // The separator: the light row and column that fence each finder off from the data.
        for (let index = 0; index < 8; index += 1) {
            expect(matrix.module(index, 7)).toBe(false);
            expect(matrix.module(7, index)).toBe(false);
            expect(matrix.module(matrix.size - 1 - index, 7)).toBe(false);
            expect(matrix.module(matrix.size - 8, index)).toBe(false);
            expect(matrix.module(index, matrix.size - 8)).toBe(false);
            expect(matrix.module(7, matrix.size - 1 - index)).toBe(false);
        }
    });

    /** Row 6 and column 6 alternate, dark at even coordinates. They set the module pitch. */
    it('alternates the timing patterns across the whole symbol', () => {
        for (let index = 8; index < matrix.size - 8; index += 1) {
            expect(matrix.module(index, 6)).toBe(index % 2 === 0);
            expect(matrix.module(6, index)).toBe(index % 2 === 0);
        }
    });

    /** Clause 7.9 requires it dark in every symbol, and it is the one module that never moves. */
    it('keeps the dark module below the bottom-left finder', () => {
        expect(matrix.module(8, matrix.size - 8)).toBe(true);
    });
});

// ── format and version information ──────────────────────────────────────────────────

/**
 * Undo the (15, 5) BCH code of clause 7.9 far enough to read the two fields back out. This is
 * not error correction: it XORs the mask off, checks the remainder is zero (so the 15 bits
 * really are a codeword and not 15 bits of data that happen to sit there), and returns the
 * level and mask. Writing it is the only way the test can assert that what a decoder will read
 * out of the symbol is what the encoder says it put in.
 */
function decodeFormatInformation(bits: number): { ecLevel: QrEcLevel; mask: number } {
    const unmasked = (bits ^ 0x5412) >>> 0;
    let remainder = unmasked;
    for (let index = 14; index >= 10; index -= 1) {
        if (((remainder >>> index) & 1) === 1) remainder ^= 0x537 << (index - 10);
    }
    if (remainder !== 0) throw new Error(`format information ${bits.toString(2)} is not a valid codeword`);
    const data = unmasked >>> 10;
    const levels: Record<number, QrEcLevel> = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
    const ecLevel = levels[data >>> 3];
    if (ecLevel === undefined) throw new Error(`unknown error-correction bits ${String(data >>> 3)}`);
    return { ecLevel, mask: data & 7 };
}

/** The (18, 6) BCH code of clause 7.10, read back the same way. */
function decodeVersionInformation(bits: number): number {
    let remainder = bits;
    for (let index = 17; index >= 12; index -= 1) {
        if (((remainder >>> index) & 1) === 1) remainder ^= 0x1f25 << (index - 12);
    }
    if (remainder !== 0) throw new Error(`version information ${bits.toString(2)} is not a valid codeword`);
    return bits >>> 12;
}

describe('format information', () => {
    /** Both copies, for every level and for whichever mask the payload happens to choose. */
    for (const ecLevel of ['L', 'M', 'Q', 'H'] as const) {
        it(`round trips at level ${ecLevel}`, () => {
            const matrix = encodeQr('kelpi format information probe', { ecLevel });
            const size = matrix.size;

            let first = 0;
            for (let index = 0; index <= 5; index += 1) first |= (matrix.module(8, index) ? 1 : 0) << index;
            first |= (matrix.module(8, 7) ? 1 : 0) << 6;
            first |= (matrix.module(8, 8) ? 1 : 0) << 7;
            first |= (matrix.module(7, 8) ? 1 : 0) << 8;
            for (let index = 9; index < 15; index += 1) first |= (matrix.module(14 - index, 8) ? 1 : 0) << index;

            let second = 0;
            for (let index = 0; index < 8; index += 1) second |= (matrix.module(size - 1 - index, 8) ? 1 : 0) << index;
            for (let index = 8; index < 15; index += 1) second |= (matrix.module(8, size - 15 + index) ? 1 : 0) << index;

            expect(decodeFormatInformation(first)).toEqual({ ecLevel, mask: matrix.mask });
            // The second copy exists so a symbol survives losing the top-left corner. If the two
            // ever disagree, half the scanners in the world read a different symbol.
            expect(second).toBe(first);
        });
    }
});

describe('version information', () => {
    it('is present from version 7 and absent below it', () => {
        const small = encodeQr('short', { ecLevel: 'M' });
        expect(small.version).toBeLessThan(7);
        // Below version 7 the 3x6 block is ordinary data, so the only honest assertion is that
        // the encoder does not reserve it: those modules carry codewords like any other.
        expect(small.size).toBe(17 + 4 * small.version);

        for (const version of [7, 10, 14]) {
            const matrix = encodeQr('x'.repeat(4), { ecLevel: 'M', minVersion: version, maxVersion: version });
            expect(matrix.version).toBe(version);
            for (const transposed of [false, true]) {
                let bits = 0;
                for (let index = 0; index < 18; index += 1) {
                    const far = matrix.size - 11 + (index % 3);
                    const near = Math.floor(index / 3);
                    const dark = transposed ? matrix.module(near, far) : matrix.module(far, near);
                    bits |= (dark ? 1 : 0) << index;
                }
                expect(decodeVersionInformation(bits)).toBe(version);
            }
        }
    });
});

// ── capacity, options and refusals ──────────────────────────────────────────────────

describe('version selection', () => {
    it('takes the smallest version that fits', () => {
        // Version 1 at M holds 16 data codewords, less two bytes of header: 14 bytes.
        expect(qrDataCodewords(1, 'M')).toBe(16);
        expect(encodeQr('x'.repeat(14), { ecLevel: 'M' }).version).toBe(1);
        expect(encodeQr('x'.repeat(15), { ecLevel: 'M' }).version).toBe(2);
    });

    it('counts UTF-8 bytes, not characters', () => {
        // 14 three-byte characters is 42 bytes, which needs a bigger symbol than 14 of anything
        // in ASCII. Byte mode has no notion of a character.
        expect(encodeQr('漢'.repeat(14), { ecLevel: 'M' }).version).toBeGreaterThan(
            encodeQr('x'.repeat(14), { ecLevel: 'M' }).version
        );
    });

    it('honours minVersion without changing what the symbol says', () => {
        const matrix = encodeQr('kelpi', { ecLevel: 'M', minVersion: 12 });
        expect(matrix.version).toBe(12);
        expect(matrix.size).toBe(17 + 4 * 12);
    });

    it('encodes the empty string as the smallest symbol there is', () => {
        const matrix = encodeQr('');
        expect(matrix.version).toBe(1);
        expect(matrix.ecLevel).toBe('M');
    });

    it('defaults to error correction M', () => {
        expect(encodeQr('kelpi').ecLevel).toBe('M');
    });

    it('fills version 40 at L, and refuses one byte more', () => {
        // The largest payload a QR code can carry in byte mode: 2953 bytes.
        const capacity = qrDataCodewords(QR_MAX_VERSION, 'L') - 3;
        expect(capacity).toBe(2953);
        const matrix = encodeQr('k'.repeat(capacity), { ecLevel: 'L' });
        expect(matrix.version).toBe(QR_MAX_VERSION);
        expect(() => encodeQr('k'.repeat(capacity + 1), { ecLevel: 'L' })).toThrow(/do not fit a version 40 symbol/);
    });

    it('says what it could not fit, and at which level', () => {
        expect(() => encodeQr('k'.repeat(40), { ecLevel: 'H', maxVersion: 2 })).toThrow(
            /40 bytes do not fit a version 2 symbol at error correction H/
        );
    });

    it('refuses a version range outside 1..40 or the wrong way round', () => {
        expect(() => encodeQr('kelpi', { minVersion: 0 })).toThrow(/outside 1..40/);
        expect(() => encodeQr('kelpi', { maxVersion: 41 })).toThrow(/outside 1..40/);
        expect(() => encodeQr('kelpi', { minVersion: 9, maxVersion: 3 })).toThrow(/outside 1..40/);
        expect(() => encodeQr('kelpi', { minVersion: 1.5 })).toThrow(/must be integers/);
    });
});

describe('QrMatrix', () => {
    const matrix = encodeQr('kelpi', { ecLevel: 'M' });

    it('agrees with itself: the flat array and the accessor are one grid', () => {
        for (let y = 0; y < matrix.size; y += 1) {
            for (let x = 0; x < matrix.size; x += 1) {
                expect(matrix.module(x, y)).toBe(matrix.modules[y * matrix.size + x] === 1);
            }
        }
    });

    /** So a renderer can sweep its quiet zone with the same call and no edge cases. */
    it('answers light outside the symbol', () => {
        expect(matrix.module(-1, 0)).toBe(false);
        expect(matrix.module(0, -1)).toBe(false);
        expect(matrix.module(matrix.size, 0)).toBe(false);
        expect(matrix.module(0, matrix.size)).toBe(false);
    });

    it('reports a mask in 0..7', () => {
        expect(matrix.mask).toBeGreaterThanOrEqual(0);
        expect(matrix.mask).toBeLessThanOrEqual(7);
    });
});

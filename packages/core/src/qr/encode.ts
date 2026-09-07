/**
 * QR symbol encoding: a string in, a module matrix out.
 *
 * Byte mode only, over the UTF-8 bytes of the text. That is the mode a URL wants: alphanumeric
 * mode cannot carry a lowercase letter, and the payload this exists for is a tailnet URL with a
 * `kd_` token in its query string. Kanji and numeric modes, mixed-mode segmentation and
 * ECI headers are all deliberately absent; they would buy a few modules on payloads Kelpi never
 * produces, and every one of them is another branch nothing here exercises.
 *
 * The clause numbers below are ISO/IEC 18004 (the QR Code specification). The pieces, in the
 * order this file implements them:
 *
 *   1. GF(256) arithmetic and the Reed-Solomon remainder  (clause 7.5)
 *   2. the capacity tables and version selection           (clause 7.5.1, table 9)
 *   3. the bit stream: mode, count, data, terminator, pad  (clause 7.4)
 *   4. block splitting and interleaving                    (clause 7.6)
 *   5. function patterns, format and version information   (clauses 6.3.3 to 6.3.6, 7.9, 7.10)
 *   6. the symbol character placement zigzag               (clause 7.7.3)
 *   7. the eight data masks and the four penalty rules     (clause 7.8)
 *
 * Step 7 is why this is a real encoder rather than a sketch. The mask is not free choice: the
 * spec scores all eight and the lowest total wins, so an encoder that picks any other mask
 * still scans but does not agree, module for module, with a reference implementation. The
 * fixtures in `fixtures.reference.ts` pin exactly that agreement, mask included.
 */

// ── Galois field GF(256) ────────────────────────────────────────────────────────────
//
// The field of clause 7.5.2: byte values under the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
// (0x11d), with 2 as the generator. Log and antilog tables turn multiplication into an addition
// of exponents, which is the only field operation Reed-Solomon encoding needs.

const GF_EXP = new Uint8Array(256);
const GF_LOG = new Uint8Array(256);

{
    let value = 1;
    for (let power = 0; power < 255; power += 1) {
        GF_EXP[power] = value;
        GF_LOG[value] = power;
        value <<= 1;
        if ((value & 0x100) !== 0) value ^= 0x11d;
    }
}

/** Product of two field elements. Zero has no logarithm, so it is answered directly. */
function gfMultiply(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[((GF_LOG[a] as number) + (GF_LOG[b] as number)) % 255] as number;
}

/**
 * The generator polynomial for `degree` error-correction codewords: the product of
 * (x - 2^0)(x - 2^1)...(x - 2^(degree-1)), returned as coefficients from x^(degree-1) down to
 * x^0. The leading coefficient is always 1 and is left implicit.
 */
function reedSolomonDivisor(degree: number): Uint8Array {
    const divisor = new Uint8Array(degree);
    divisor[degree - 1] = 1;
    let root = 1;
    for (let step = 0; step < degree; step += 1) {
        for (let index = 0; index < degree; index += 1) {
            const scaled = gfMultiply(divisor[index] as number, root);
            divisor[index] = index + 1 < degree ? scaled ^ (divisor[index + 1] as number) : scaled;
        }
        root = gfMultiply(root, 2);
    }
    return divisor;
}

/** The Reed-Solomon remainder of `data` under `divisor`: the block's error-correction codewords. */
function reedSolomonRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
    const remainder = new Uint8Array(divisor.length);
    for (const byte of data) {
        const factor = byte ^ (remainder[0] as number);
        remainder.copyWithin(0, 1);
        remainder[remainder.length - 1] = 0;
        for (let index = 0; index < divisor.length; index += 1) {
            remainder[index] = (remainder[index] as number) ^ gfMultiply(divisor[index] as number, factor);
        }
    }
    return remainder;
}

// ── capacity ────────────────────────────────────────────────────────────────────────

/** Error-correction level, in the spec's own order of increasing redundancy. */
export type QrEcLevel = 'L' | 'M' | 'Q' | 'H';

/** The two bits each level is written as in the format information (clause 7.9, table 12). */
const EC_FORMAT_BITS: Readonly<Record<QrEcLevel, number>> = { L: 1, M: 0, Q: 3, H: 2 };

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

/**
 * Error-correction codewords per block, by level and version (clause 7.5.1, table 9).
 * Index 0 is a hole so the version indexes the row directly.
 */
const EC_CODEWORDS_PER_BLOCK: Readonly<Record<QrEcLevel, readonly number[]>> = {
    L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
};

/** Error-correction blocks, by level and version (clause 7.5.1, table 9). Index 0 is a hole. */
const EC_BLOCKS: Readonly<Record<QrEcLevel, readonly number[]>> = {
    L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
};

function tableValue(table: Readonly<Record<QrEcLevel, readonly number[]>>, ecLevel: QrEcLevel, version: number): number {
    const value = table[ecLevel][version];
    if (value === undefined) throw new Error(`qr: version ${String(version)} is outside 1..40`);
    return value;
}

/** The side of a symbol, in modules (clause 6.3): 21 at version 1, growing by 4 a version. */
export function qrSizeForVersion(version: number): number {
    return version * 4 + 17;
}

/**
 * Modules a version has left for data and error correction once the function patterns are
 * placed: the whole square, less the three finders with their separators and the format
 * information (191 modules, plus 2 for the two format copies' shared corners), less the timing
 * patterns, less the alignment patterns, less the version information at version 7 and above.
 *
 * Computing it beats another 40-row table: the alignment count is a closed form, and the
 * overlaps between alignment patterns and the timing rows are regular enough to subtract
 * arithmetically. `qr/encode.test.ts` pins the result against table 9's own codeword counts at
 * the versions the fixtures reach.
 */
function rawDataModules(version: number): number {
    let modules = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const alignmentCount = Math.floor(version / 7) + 2;
        modules -= (25 * alignmentCount - 10) * alignmentCount - 55;
        if (version >= 7) modules -= 36;
    }
    return modules;
}

/** Data codewords a version and level carry: every codeword that is not error correction. */
export function qrDataCodewords(version: number, ecLevel: QrEcLevel): number {
    return (
        Math.floor(rawDataModules(version) / 8) -
        tableValue(EC_CODEWORDS_PER_BLOCK, ecLevel, version) * tableValue(EC_BLOCKS, ecLevel, version)
    );
}

/**
 * Bits the byte-mode character count indicator takes (clause 7.4.1, table 3). Byte mode is 8
 * bits up to version 9 and 16 bits from version 10, which is why a payload can cross a version
 * boundary and gain a byte of overhead at the same time.
 */
function characterCountBits(version: number): number {
    return version <= 9 ? 8 : 16;
}

/** Whether `byteLength` bytes of byte-mode data fit a version at a level, header included. */
function fitsVersion(byteLength: number, version: number, ecLevel: QrEcLevel): boolean {
    const needed = 4 + characterCountBits(version) + byteLength * 8;
    return needed <= qrDataCodewords(version, ecLevel) * 8;
}

// ── the bit stream ──────────────────────────────────────────────────────────────────

/**
 * The data codewords for one symbol: mode indicator, character count, the bytes themselves,
 * the terminator, and the pad (clause 7.4.9). The pad is the alternating 0xec / 0x11 the spec
 * names, not zeros, so that an under-filled symbol still looks like data to the masking rules.
 */
function dataCodewords(bytes: Uint8Array, version: number, ecLevel: QrEcLevel): Uint8Array {
    const capacity = qrDataCodewords(version, ecLevel);
    const codewords = new Uint8Array(capacity);
    let bitPosition = 0;

    const appendBits = (value: number, width: number): void => {
        for (let index = width - 1; index >= 0; index -= 1) {
            if (((value >>> index) & 1) === 1) {
                const at = bitPosition >>> 3;
                codewords[at] = (codewords[at] as number) | (0x80 >>> (bitPosition & 7));
            }
            bitPosition += 1;
        }
    };

    appendBits(0b0100, 4); // byte mode
    appendBits(bytes.length, characterCountBits(version));
    for (const byte of bytes) appendBits(byte, 8);

    // Terminator: four zero bits, or fewer if the capacity runs out first.
    appendBits(0, Math.min(4, capacity * 8 - bitPosition));
    // Then zeros to the codeword boundary, then the pad codewords. The pad alternates from the
    // FIRST pad codeword, not from the parity of its index in the symbol: a payload that ends on
    // an odd codeword still gets 0xec first, and getting that backwards writes a symbol that
    // decodes correctly (the pad is past the data) but does not match any other encoder, and
    // masks differently because the pad modules are scored like any other.
    appendBits(0, (8 - (bitPosition % 8)) % 8);
    for (let index = bitPosition >>> 3, pad = 0; index < capacity; index += 1, pad += 1) {
        codewords[index] = pad % 2 === 0 ? 0xec : 0x11;
    }
    return codewords;
}

/**
 * Data plus error correction, split into blocks and interleaved (clause 7.6).
 *
 * The blocks are of two lengths, the longer ones last, and the interleave takes one codeword
 * from each block in turn. The short blocks run out one codeword early, so the loop skips them
 * on the final data pass; the error-correction blocks are all the same length and never skip.
 */
function interleave(data: Uint8Array, version: number, ecLevel: QrEcLevel): Uint8Array {
    const blockCount = tableValue(EC_BLOCKS, ecLevel, version);
    const ecPerBlock = tableValue(EC_CODEWORDS_PER_BLOCK, ecLevel, version);
    const totalCodewords = Math.floor(rawDataModules(version) / 8);
    const shortBlockLength = Math.floor(totalCodewords / blockCount) - ecPerBlock;
    const shortBlockCount = blockCount - (totalCodewords % blockCount);
    const divisor = reedSolomonDivisor(ecPerBlock);

    const dataBlocks: Uint8Array[] = [];
    const ecBlocks: Uint8Array[] = [];
    let offset = 0;
    for (let block = 0; block < blockCount; block += 1) {
        const length = shortBlockLength + (block < shortBlockCount ? 0 : 1);
        const chunk = data.subarray(offset, offset + length);
        offset += length;
        dataBlocks.push(chunk);
        ecBlocks.push(reedSolomonRemainder(chunk, divisor));
    }

    const result = new Uint8Array(totalCodewords);
    let written = 0;
    for (let index = 0; index < shortBlockLength + 1; index += 1) {
        for (const block of dataBlocks) {
            const codeword = block[index];
            if (codeword !== undefined) result[written++] = codeword;
        }
    }
    for (let index = 0; index < ecPerBlock; index += 1) {
        for (const block of ecBlocks) result[written++] = block[index] as number;
    }
    return result;
}

// ── the symbol ──────────────────────────────────────────────────────────────────────

/**
 * A finished QR symbol.
 *
 * `modules` is the canonical form and the cheap one: row-major, one byte per module, `1` dark
 * and `0` light, `size * size` long, with NO quiet zone (the renderers add it, because how much
 * margin a medium needs is the renderer's business). `module(x, y)` is the same data behind a
 * bounds check that answers `false` outside the symbol, so a caller sweeping a quiet zone does
 * not have to special-case its own edges.
 *
 * `x` is the column and `y` the row throughout, and the origin is the top-left module, which is
 * the corner the top-left finder pattern occupies.
 */
export interface QrMatrix {
    /** 1 to 40. The symbol's size follows from it: `size === version * 4 + 17`. */
    readonly version: number;
    /** The side of the symbol in modules, quiet zone excluded. */
    readonly size: number;
    /** The error-correction level the symbol was encoded at. */
    readonly ecLevel: QrEcLevel;
    /** The data mask pattern applied, 0 to 7, chosen by the spec's penalty score. */
    readonly mask: number;
    /** Row-major modules, `1` dark and `0` light. Length is `size * size`. */
    readonly modules: Uint8Array;
    /** Whether the module at (`x`, `y`) is dark. Outside the symbol, `false`. */
    module(x: number, y: number): boolean;
}

/** Options for {@link encodeQr}. */
export interface QrEncodeOptions {
    /**
     * Error correction, defaulting to `'M'`. `M` recovers about 15 % of a damaged symbol and is
     * the level a screen-to-camera scan wants: `L` is fragile against glare, and `Q` or `H` cost
     * versions (and so modules, and so scanning distance) for redundancy a lit screen does not
     * need.
     */
    readonly ecLevel?: QrEcLevel | undefined;
    /** Lowest version to consider, 1 by default. Useful only to force a larger, coarser symbol. */
    readonly minVersion?: number | undefined;
    /** Highest version to consider, 40 by default. Exceeding it throws rather than truncating. */
    readonly maxVersion?: number | undefined;
}

interface SymbolCanvas {
    readonly size: number;
    /** Row-major modules, 1 = dark. */
    readonly modules: Uint8Array;
    /** Row-major flags, 1 = function module: never carries data, never masked. */
    readonly reserved: Uint8Array;
}

function setModule(canvas: SymbolCanvas, x: number, y: number, dark: boolean): void {
    canvas.modules[y * canvas.size + x] = dark ? 1 : 0;
}

function setFunctionModule(canvas: SymbolCanvas, x: number, y: number, dark: boolean): void {
    setModule(canvas, x, y, dark);
    canvas.reserved[y * canvas.size + x] = 1;
}

function isDark(canvas: SymbolCanvas, x: number, y: number): boolean {
    return canvas.modules[y * canvas.size + x] === 1;
}

/** Bit `index` of `value`, counting from the least significant. */
function bitOf(value: number, index: number): boolean {
    return ((value >>> index) & 1) !== 0;
}

/**
 * Centres of the alignment patterns (clause 6.3.5, table E.1), as coordinates that apply to both
 * axes. Version 1 has none. Otherwise the first is always 6, the last always `size - 7`, and the
 * rest are evenly spaced at an even step working back from the last. Version 32 is the one case
 * the closed form gets wrong, and the spec's table simply says 26 there.
 */
function alignmentPositions(version: number): readonly number[] {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const positions: number[] = [6];
    for (let position = version * 4 + 10; positions.length < count; position -= step) {
        positions.splice(1, 0, position);
    }
    return positions;
}

/**
 * A finder pattern and its separator in one sweep (clauses 6.3.3 and 6.3.4). Taking the
 * Chebyshev distance from the centre gives the concentric rings directly: 0 and 1 dark, 2 light,
 * 3 dark, 4 light, and that last light ring is exactly the separator. The write is clipped, so
 * the parts of the separator that fall outside the symbol simply do not land, which is why a
 * finder in a corner needs no special case.
 */
function drawFinder(canvas: SymbolCanvas, centreX: number, centreY: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
            const x = centreX + dx;
            const y = centreY + dy;
            if (x < 0 || x >= canvas.size || y < 0 || y >= canvas.size) continue;
            const ring = Math.max(Math.abs(dx), Math.abs(dy));
            setFunctionModule(canvas, x, y, ring !== 2 && ring !== 4);
        }
    }
}

/** An alignment pattern: 5x5, dark but for the ring at distance 1 (clause 6.3.5). */
function drawAlignment(canvas: SymbolCanvas, centreX: number, centreY: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
            setFunctionModule(canvas, centreX + dx, centreY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }
}

/**
 * Format information: the level and mask under a (15, 5) BCH code, XORed with 0b101010000010010
 * so that an all-zero format never reads as valid (clause 7.9). It is written twice, once around
 * the top-left finder and once split between the other two, so a symbol survives losing a
 * corner. The dark module at (8, size - 8) is required by the same clause and never changes.
 */
function drawFormatInformation(canvas: SymbolCanvas, ecLevel: QrEcLevel, mask: number): void {
    const data = ((EC_FORMAT_BITS[ecLevel] << 3) | mask) >>> 0;
    let remainder = data;
    for (let step = 0; step < 10; step += 1) {
        remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    const bits = (((data << 10) | remainder) ^ 0x5412) >>> 0;
    const size = canvas.size;

    for (let index = 0; index <= 5; index += 1) setFunctionModule(canvas, 8, index, bitOf(bits, index));
    setFunctionModule(canvas, 8, 7, bitOf(bits, 6));
    setFunctionModule(canvas, 8, 8, bitOf(bits, 7));
    setFunctionModule(canvas, 7, 8, bitOf(bits, 8));
    for (let index = 9; index < 15; index += 1) setFunctionModule(canvas, 14 - index, 8, bitOf(bits, index));

    for (let index = 0; index < 8; index += 1) setFunctionModule(canvas, size - 1 - index, 8, bitOf(bits, index));
    for (let index = 8; index < 15; index += 1) setFunctionModule(canvas, 8, size - 15 + index, bitOf(bits, index));
    setFunctionModule(canvas, 8, size - 8, true);
}

/**
 * Version information, at version 7 and above only (clause 7.10): the version number under an
 * (18, 6) BCH code, written as a 3x6 block beside each of the two far finders. Below version 7
 * the size alone identifies the version, so the spec omits it.
 */
function drawVersionInformation(canvas: SymbolCanvas, version: number): void {
    if (version < 7) return;
    let remainder = version;
    for (let step = 0; step < 12; step += 1) {
        remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    const bits = ((version << 12) | remainder) >>> 0;
    for (let index = 0; index < 18; index += 1) {
        const bit = bitOf(bits, index);
        const far = canvas.size - 11 + (index % 3);
        const near = Math.floor(index / 3);
        setFunctionModule(canvas, far, near, bit);
        setFunctionModule(canvas, near, far, bit);
    }
}

/** Every function pattern, in the order the spec lays them out. */
function drawFunctionPatterns(canvas: SymbolCanvas, version: number, ecLevel: QrEcLevel): void {
    const size = canvas.size;

    // Timing patterns (clause 6.3.6): alternating modules along row 6 and column 6.
    for (let index = 0; index < size; index += 1) {
        setFunctionModule(canvas, 6, index, index % 2 === 0);
        setFunctionModule(canvas, index, 6, index % 2 === 0);
    }

    drawFinder(canvas, 3, 3);
    drawFinder(canvas, size - 4, 3);
    drawFinder(canvas, 3, size - 4);

    // Alignment patterns at every crossing of the position list, except the three that would
    // sit on a finder pattern (clause 6.3.5).
    const positions = alignmentPositions(version);
    const last = positions.length - 1;
    for (let row = 0; row <= last; row += 1) {
        for (let column = 0; column <= last; column += 1) {
            const onFinder =
                (row === 0 && column === 0) || (row === 0 && column === last) || (row === last && column === 0);
            if (onFinder) continue;
            drawAlignment(canvas, positions[column] as number, positions[row] as number);
        }
    }

    // A placeholder mask, so the format modules are reserved before data placement. The real
    // format information is written once the mask is chosen.
    drawFormatInformation(canvas, ecLevel, 0);
    drawVersionInformation(canvas, version);
}

/**
 * Place the codewords (clause 7.7.3): two-module-wide columns, right to left, the bits running
 * up one column pair and down the next, skipping function modules. Column 6 is the vertical
 * timing pattern and is stepped over entirely, which is why the pairing shifts left by one for
 * everything past it. Any modules left over at the end are the remainder bits, and stay light.
 */
function drawCodewords(canvas: SymbolCanvas, codewords: Uint8Array): void {
    const size = canvas.size;
    let bitPosition = 0;
    const totalBits = codewords.length * 8;

    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let step = 0; step < size; step += 1) {
            for (let column = 0; column < 2; column += 1) {
                const x = right - column;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - step : step;
                if (canvas.reserved[y * size + x] === 1 || bitPosition >= totalBits) continue;
                const byte = codewords[bitPosition >>> 3] as number;
                setModule(canvas, x, y, bitOf(byte, 7 - (bitPosition & 7)));
                bitPosition += 1;
            }
        }
    }
}

/**
 * The eight data masks of clause 7.8.2, as predicates over row `y` and column `x`. A module is
 * inverted where its mask answers true. They exist to break up runs and blocks that would
 * otherwise confuse a scanner, and the one that does that best is chosen by penalty score.
 */
const MASKS: readonly ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

/** XOR a mask over every non-function module. Applying it twice restores the symbol. */
function applyMask(canvas: SymbolCanvas, mask: number): void {
    const predicate = MASKS[mask] as (x: number, y: number) => boolean;
    for (let y = 0; y < canvas.size; y += 1) {
        for (let x = 0; x < canvas.size; x += 1) {
            const index = y * canvas.size + x;
            if (canvas.reserved[index] === 1) continue;
            if (predicate(x, y)) canvas.modules[index] = (canvas.modules[index] as number) ^ 1;
        }
    }
}

const PENALTY_RUN = 3; // N1: a run of five or more, plus one per module beyond five
const PENALTY_BLOCK = 3; // N2: a 2x2 block of one colour
const PENALTY_FINDER_LOOKALIKE = 40; // N3: the 1:1:3:1:1 finder ratio appearing in the data
const PENALTY_BALANCE = 10; // N4: per 5 % the dark proportion strays from half

/** The 11-module finder lookalikes of clause 7.8.3.1: dark 1:1:3:1:1 with four light beside it. */
const FINDER_LOOKALIKE_AFTER = 0b10111010000;
const FINDER_LOOKALIKE_BEFORE = 0b00001011101;

/**
 * The four penalty rules of clause 7.8.3.1, summed. Lower is better; the mask with the lowest
 * total is the one the symbol keeps. The weights (3, 3, 40, 10) are the spec's, not a tuning
 * choice: an encoder that changes them picks different masks and stops matching every other
 * encoder in the world, which is what the reference fixtures would catch.
 *
 * This is the corner of QR encoding where widely used libraries genuinely disagree, because
 * table 24 is prose and the readings differ at the edges. What is implemented here is ZXing's,
 * which is the decoder the whole scanning ecosystem is built on. `fixtures.reference.ts` records
 * the one measured disagreement with the library the fixtures came from, and why the reading
 * below is the one that follows the table.
 */
function penaltyScore(canvas: SymbolCanvas): number {
    const size = canvas.size;
    let score = 0;

    // N1 and N3, in one pass over the rows and then the columns.
    for (let axis = 0; axis < 2; axis += 1) {
        for (let line = 0; line < size; line += 1) {
            let runColour = false;
            let runLength = 0;
            let window = 0;
            for (let position = 0; position < size; position += 1) {
                const dark = axis === 0 ? isDark(canvas, position, line) : isDark(canvas, line, position);

                if (dark === runColour) {
                    runLength += 1;
                    if (runLength === 5) score += PENALTY_RUN;
                    else if (runLength > 5) score += 1;
                } else {
                    runColour = dark;
                    runLength = 1;
                }

                window = ((window << 1) & 0b11111111111) | (dark ? 1 : 0);
                if (position >= 10 && (window === FINDER_LOOKALIKE_AFTER || window === FINDER_LOOKALIKE_BEFORE)) {
                    score += PENALTY_FINDER_LOOKALIKE;
                }
            }
        }
    }

    // N2: every 2x2 block of a single colour, counted once per block, overlaps included.
    for (let y = 0; y < size - 1; y += 1) {
        for (let x = 0; x < size - 1; x += 1) {
            const corner = isDark(canvas, x, y);
            if (
                corner === isDark(canvas, x + 1, y) &&
                corner === isDark(canvas, x, y + 1) &&
                corner === isDark(canvas, x + 1, y + 1)
            ) {
                score += PENALTY_BLOCK;
            }
        }
    }

    // N4: how far the dark proportion strays from half, in 5 % steps (table 24's band
    // "50 +/- 5k % to 50 +/- 5(k+1) %"). Kept in integers, which is both exact and ZXing's own
    // form: at 52 % dark the deviation is 2 points of percentage, which is inside the k = 0
    // band, and so costs nothing.
    let dark = 0;
    for (const module of canvas.modules) dark += module;
    const total = size * size;
    score += Math.floor((Math.abs(dark * 2 - total) * 10) / total) * PENALTY_BALANCE;

    return score;
}

/**
 * Encode `text` as a QR symbol.
 *
 * The text is taken as its UTF-8 bytes and written in byte mode. Error correction defaults to
 * `'M'`. The version is the smallest in `minVersion..maxVersion` that fits; all eight data masks
 * are then scored with the four penalty rules of clause 7.8.3.1 and the lowest total wins. That
 * last step is what makes the output reproducible rather than merely valid, and
 * `fixtures.reference.ts` pins seven symbols against an independent encoder to prove it, module
 * for module and mask included.
 *
 * Throws when the text does not fit `maxVersion`, or when the options are out of range. It never
 * silently truncates: a half-written pairing URL that still scans is worse than no QR at all.
 */
export function encodeQr(text: string, options: QrEncodeOptions = {}): QrMatrix {
    const ecLevel = options.ecLevel ?? 'M';
    const minVersion = options.minVersion ?? QR_MIN_VERSION;
    const maxVersion = options.maxVersion ?? QR_MAX_VERSION;

    if (!Number.isInteger(minVersion) || !Number.isInteger(maxVersion)) {
        throw new Error('qr: minVersion and maxVersion must be integers');
    }
    if (minVersion < QR_MIN_VERSION || maxVersion > QR_MAX_VERSION || minVersion > maxVersion) {
        throw new Error(
            `qr: version range ${String(minVersion)}..${String(maxVersion)} is outside ${String(QR_MIN_VERSION)}..${String(QR_MAX_VERSION)}`
        );
    }

    const bytes = new TextEncoder().encode(text);

    let version = minVersion;
    while (version <= maxVersion && !fitsVersion(bytes.length, version, ecLevel)) version += 1;
    if (version > maxVersion) {
        const capacity = qrDataCodewords(maxVersion, ecLevel) - Math.ceil((4 + characterCountBits(maxVersion)) / 8);
        throw new Error(
            `qr: ${String(bytes.length)} bytes do not fit a version ${String(maxVersion)} symbol at error correction ${ecLevel} (about ${String(capacity)} bytes)`
        );
    }

    const size = qrSizeForVersion(version);
    const canvas: SymbolCanvas = {
        size,
        modules: new Uint8Array(size * size),
        reserved: new Uint8Array(size * size)
    };
    drawFunctionPatterns(canvas, version, ecLevel);
    drawCodewords(canvas, interleave(dataCodewords(bytes, version, ecLevel), version, ecLevel));

    // Score all eight and keep the best. The mask is applied, scored and unapplied in place,
    // which is cheaper than eight copies of the module array and, because the mask is its own
    // inverse over the non-function modules, exact.
    let bestMask = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask += 1) {
        applyMask(canvas, mask);
        drawFormatInformation(canvas, ecLevel, mask);
        const score = penaltyScore(canvas);
        if (score < bestScore) {
            bestScore = score;
            bestMask = mask;
        }
        applyMask(canvas, mask);
    }
    applyMask(canvas, bestMask);
    drawFormatInformation(canvas, ecLevel, bestMask);

    const modules = canvas.modules;
    return {
        version,
        size,
        ecLevel,
        mask: bestMask,
        modules,
        module(x: number, y: number): boolean {
            if (x < 0 || y < 0 || x >= size || y >= size) return false;
            return modules[y * size + x] === 1;
        }
    };
}

/**
 * QR codes, written here rather than installed.
 *
 * WHY THIS EXISTS AT ALL. Kelpi pairs a phone by handing it a tailnet URL with a one-time
 * device token in the query string. Typing that URL on a phone is not a thing anyone will do,
 * so it has to be scannable: the pair card in Settings > Remote draws it (D2) and
 * `kelpid pair --qr` prints it for a headless host (D3). The alternative was a runtime
 * dependency. The client carries six today, and this repo has consistently preferred writing
 * the small thing over adding the large one: the kelpie mark's SVG path flattener, its SDF
 * rasteriser and its PNG encoder in `../icon` are all the same call, made the same way. A QR
 * encoder is about six hundred lines of table and arithmetic that has not changed since 2006,
 * with no I/O, no platform surface and no supply chain. That is a better thing to own than to
 * track.
 *
 * It lives in `@kelpi/core` rather than beside the pair card because the CLI needs the same
 * matrix, and core is the package both the browser client and Node-side code already import.
 * Nothing here touches a Node builtin, so the whole module is safe in the web bundle.
 *
 *   `encode.ts`             -- text to a module matrix. Byte mode, ISO/IEC 18004.
 *   `render.ts`             -- the matrix as an inline SVG, or as terminal half-blocks.
 *   `fixtures.reference.ts` -- matrices from a reference encoder, for the tests to match.
 *
 * The whole surface:
 *
 *     const matrix = encodeQr('https://mac.tail1234.ts.net/?token=kd_...');
 *     element.innerHTML = qrSvg(matrix, { ariaLabel: 'Pairing code for this Mac' });
 *     process.stdout.write(`${qrText(matrix)}\n`);
 */

export {
    QR_MAX_VERSION,
    QR_MIN_VERSION,
    encodeQr,
    qrDataCodewords,
    qrSizeForVersion,
    type QrEcLevel,
    type QrEncodeOptions,
    type QrMatrix
} from './encode.js';

export {
    QR_QUIET_ZONE,
    qrSvg,
    qrText,
    type QrSvgOptions,
    type QrTextOptions
} from './render.js';

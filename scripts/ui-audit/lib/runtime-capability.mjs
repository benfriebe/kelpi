/** Reviewed shell contracts, selected from T before acquiring any runtime resource.
 * Exact whole-file triples deliberately refuse partial backports and unknown shells.
 * Review a changed contract before adding it; absence of a marker is not capability proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { executionRoots } from './execution-roots.mjs';

const files = ['main.ts', 'harness.ts', 'harness-protocol.ts'].map(name => `packages/shell/src/${name}`);
// Reviewed at 7ee1f09ace56bffba94ed32b43b431367b4aea24 (immediate load), and
// 3ef30317b2889712ed9529a9476f00707e5893e9 / H 3d7cad42e378abc87fcf5436a5bc50129ba3e002
// (blank document, two-gate deferral, one-shot load-client dispatch and callback wiring).
const contracts = [
    { mode: 'legacy-immediate', hashes: [
        '8e3e9f8eee00da502ac51bb93d4e435945fa5473cdfc795c604981878a51eed5',
        '3c52919f04fe3b18f64774b7a270c15a6abdac2ca3ba05fa859f2d7651e0a74a',
        'a3d97fdcbf052abb521183c9bccc0dbef35cb485ae1a8d2276b3ed26d7cc42be'
    ] },
    { mode: 'deferred', hashes: [
        '9317a74cf62277f6f2a0952df0220fe7d956ea79d31d7ec55f5a021cf7835ace',
        '7c326ab561fa685646b66de86759a51be0858c4baaf0faa6a19538e7b104b8b5',
        'cdfb85e60354d858b11ae99e00414ae21ee309b04bde33faa193757173b4d982'
    ] }
];

export function selectShellLoadCapability(inputs) {
    if (!Array.isArray(inputs) || inputs.length !== files.length ||
        inputs.some(input => !input || !files.includes(input.path) || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) ||
        new Set(inputs.map(input => input.path)).size !== files.length) {
        throw new Error('malformed shell load capability source identity');
    }
    const matches = contracts.filter(contract => files.every((file, index) =>
        inputs.find(input => input.path === file).sha256 === contract.hashes[index]));
    if (matches.length !== 1) throw new Error('unsupported or ambiguous shell load capability: review the exact target source contract');
    return matches[0].mode;
}

export function freezeShellLoadCapability(repoRoot) {
    const targetRoot = fs.realpathSync(repoRoot);
    const context = process.env.KELPI_ACCEPTANCE_CONTEXT ? executionRoots({ targetRoot }).context : null;
    const targetHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetRoot, encoding: 'utf8' }).trim();
    if (context && context.target.expectedHead !== targetHead) throw new Error('shell load capability target head differs from pinned context');
    const sources = files.map(file => {
        const absolute = path.join(targetRoot, file);
        if (fs.realpathSync(absolute) !== absolute || !fs.statSync(absolute).isFile()) throw new Error(`shell load capability source is linked: ${file}`);
        const sha256 = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        if (context) {
            const pinned = context.target.source?.inputs?.filter(input => input.path === file);
            if (pinned?.length !== 1 || pinned[0].sha256 !== sha256) throw new Error(`shell load capability source differs from pinned target: ${file}`);
        }
        return Object.freeze({ path: file, sha256 });
    });
    return Object.freeze({ schemaVersion: 1, mode: selectShellLoadCapability(sources), targetRoot, targetHead,
        contextSha256: context ? process.env.KELPI_ACCEPTANCE_CONTEXT_SHA256 : null, sources: Object.freeze(sources) });
}

/** Keep the selected contract fixed across asynchronous build/setup/acquisition boundaries. */
export function assertShellLoadCapability(capability) {
    if (JSON.stringify(freezeShellLoadCapability(capability.targetRoot)) !== JSON.stringify(capability)) {
        throw new Error('shell load capability changed after preflight');
    }
}

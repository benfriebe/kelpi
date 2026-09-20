import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { captureSource } from './acceptance-provenance.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Give a mocked scenario process an explicit build receipt for the mocked runtime.
 *
 * The real scenario runner still calls captureProvenance/bindCoreExecution. Its source/output
 * capture boundary is replaced only inside the child loader, just as the driver boundary is,
 * so these tests neither borrow a verifier receipt nor require a local full build.
 */
export function fixtureAcceptanceProvenance({ root, temp }) {
    const source = captureSource(root);
    const outputs = [
        ['packages/client/dist/index.html', 'fixture client'],
        ['packages/daemon/dist/kelpid.js', 'fixture daemon'],
        ['packages/daemon/dist/runner.mjs', 'fixture runner'],
        ['packages/cli/dist/kelpi.js', 'fixture cli'],
        ['packages/shell/dist/main.js', 'fixture shell']
    ].map(([file, bytes]) => ({ path: file, sha256: digest(bytes) }));
    const driftedOutputs = outputs.map((output, index) => index === 0
        ? { ...output, sha256: digest('fixture client drift') } : output);
    const module = path.join(temp, 'fixture-acceptance-provenance.mjs');
    fs.writeFileSync(module, `const outputs=${JSON.stringify(outputs)};
        const drifted=${JSON.stringify(driftedOutputs)};
        const source=${JSON.stringify(source)};
        export const captureSource=()=>source;
        export const captureOutputs=()=>process.env.KELPI_UNIT_FIXTURE_DRIFT==='1'?drifted:outputs;`);
    const runId = crypto.randomUUID();
    const build = { inputManifestSha256: source.inputManifestSha256, outputs, forced: true, receiptKind: 'unit-fixture' };
    const receipt = { runId, head: source.head, source, build, exitStatus: 0 };
    const receiptPath = path.join(temp, 'fixture-build-receipt.json');
    const bytes = JSON.stringify(receipt);
    fs.writeFileSync(receiptPath, bytes);
    return {
        module,
        env: {
            ...process.env,
            KELPI_ACCEPTANCE_HEAD: source.head,
            KELPI_ACCEPTANCE_RUN_ID: runId,
            KELPI_ACCEPTANCE_BUILD_RECEIPT: receiptPath,
            KELPI_ACCEPTANCE_BUILD_SHA256: digest(bytes),
            KELPI_UNIT_FIXTURE_DRIFT: ''
        }
    };
}

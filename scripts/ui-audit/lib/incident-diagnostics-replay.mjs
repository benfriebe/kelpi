import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { captureSource, captureOutputs } from './acceptance-provenance.mjs';
import { bindPackagedRuntime } from './incident-diagnostics-packaged.mjs';
import { BUNDLE_OUTPUTS, bundleHash, bundleOutputHashes, readBuildReceipt } from './build-cache.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const startedAt = new Date().toISOString();
const runId = process.env.KELPI_ACCEPTANCE_RUN_ID ?? randomUUID();

export function captureProvenance(repoRoot, files = [], runtime = {}) {
    const git = args => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
    const hashes = {};
    const visit = relative => {
        const absolute = path.join(repoRoot, relative);
        if (!fs.existsSync(absolute)) { hashes[relative] = null; return; }
        if (fs.statSync(absolute).isDirectory()) {
            for (const child of fs.readdirSync(absolute).sort()) visit(path.join(relative, child));
        } else hashes[relative] = hash(fs.readFileSync(absolute));
    };
    for (const directory of ['packages/client/dist', 'packages/daemon/dist', 'packages/cli/dist', 'packages/shell/dist']) visit(directory);
    for (const file of git(['ls-files', '--cached', '--others', '--exclude-standard', '--', 'scripts']).split('\n').filter(Boolean)) visit(file);
    for (const file of files) hashes[path.relative(repoRoot, file)] = hash(fs.readFileSync(file));
    for (const file of ['examples/plugins/terminal-lab/ui/bundle.js', 'examples/plugins/terminal-lab/ui/bundle.css']) {
        if (fs.existsSync(path.join(repoRoot,file)) || files.some(file => /plugin-terminal-(features|geometry)\.mjs$/.test(file))) visit(file);
    }
    const head = git(['rev-parse', 'HEAD']), requestedHead = process.env.KELPI_ACCEPTANCE_HEAD ?? null;
    if (requestedHead !== null && head !== requestedHead) throw new Error(`requested HEAD ${requestedHead} differs from actual ${head}`);
    const source = captureSource(repoRoot), errors = [];
    let executedOutputs = [], build = null;
    try { executedOutputs = captureOutputs(repoRoot); } catch (error) { errors.push(String(error.message)); }
    const receiptPath = process.env.KELPI_ACCEPTANCE_BUILD_RECEIPT;
    if (receiptPath) {
        const bytes = fs.readFileSync(receiptPath);
        if (hash(bytes) !== process.env.KELPI_ACCEPTANCE_BUILD_SHA256) throw new Error('build receipt digest differs');
        const receipt = JSON.parse(bytes);
        if (receipt.runId !== runId || receipt.head !== head || receipt.exitStatus !== 0 || JSON.stringify(receipt.source) !== JSON.stringify(source)) throw new Error('build receipt source/run differs');
        build = receipt.build;
        if (JSON.stringify(build?.outputs) !== JSON.stringify(executedOutputs)) throw new Error('executed outputs differ from build receipt');
    } else {
        // Local runs bind to receipts written by buildAll; absent receipts stay visibly incomplete.
        for (const name of Object.keys(BUNDLE_OUTPUTS)) {
            try {
                const receipt = readBuildReceipt(repoRoot,name);
                if (!receipt || receipt.hash !== bundleHash(repoRoot,name) || JSON.stringify(receipt.outputHashes) !== JSON.stringify(bundleOutputHashes(repoRoot,name))) errors.push(`${name}: missing or mismatched build receipt`);
            } catch (error) { errors.push(`${name}: ${error.message}`); }
        }
        if (errors.length === 0) build = {inputManifestSha256:source.inputManifestSha256,outputs:executedOutputs,forced:false,receiptKind:'validated-build-cache'};
    }
    const provenance = { schemaVersion:2, runId, head, requestedHead, startedAt, dirtyFiles:git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean),
        trackedDiffSha256:source.trackedDiffSha256, buildHashes:hashes, source, build, executedOutputs, complete:errors.length === 0, errors, runtimeBindings:[] };
    const binding=bindPackagedRuntime(repoRoot,provenance,runtime);
    if(binding) { provenance.runtimeBindings.push(binding); if(!binding.complete) {provenance.complete=false;provenance.errors.push(...binding.errors);} }
    return provenance;
}

/** Observe actual bytes without replacing the original receipt, even when capture fails. */
export function bindCoreExecution(repoRoot, provenance, {boundary, replaySource, runtime = {}} = {}) {
    const observation = {boundary, source:null, executedOutputs:[], errors:[]};
    try { observation.source = captureSource(repoRoot); }
    catch (error) { observation.errors.push(`source capture: ${error.message}`); }
    try { observation.executedOutputs = captureOutputs(repoRoot); }
    catch (error) { observation.errors.push(`output capture: ${error.message}`); }
    if (JSON.stringify(observation.source) !== JSON.stringify(provenance.source)) observation.errors.push('runtime source changed after binding');
    if (JSON.stringify(observation.executedOutputs) !== JSON.stringify(provenance.build?.outputs)) observation.errors.push('runtime outputs differ from original build receipt');
    // The latest observation and every earlier failure survive, including a later restoration
    // of the original bytes. build/buildHashes remain the original bound identity.
    provenance.executedOutputs = observation.executedOutputs;
    const packaged = bindPackagedRuntime(repoRoot, provenance, runtime);
    if (packaged) {
        observation.runtimeBinding = structuredClone(packaged);
        observation.errors.push(...packaged.errors);
        const prior = provenance.runtimeBindings.find(binding => binding.id === packaged.id);
        if (prior) {
            prior.executedOutputs = packaged.executedOutputs;
            prior.errors.push(...packaged.errors);
            prior.complete = prior.complete && packaged.complete;
        } else provenance.runtimeBindings.push(packaged);
    }
    if (replaySource) {
        try {
            validateReplayProvenance(replaySource.provenance, {...provenance, source:observation.source,
                buildHashes:{...provenance.buildHashes,...Object.fromEntries(observation.executedOutputs.map(output => [output.path,output.sha256]))}});
        } catch (error) { observation.errors.push(error.message); }
    }
    (provenance.executionBoundaries ??= []).push(observation);
    provenance.errors.push(...observation.errors.map(error => `${boundary}: ${error}`));
    if (observation.errors.length) provenance.complete = false;
    if (provenance.executionBoundaries.some(entry => entry.errors.length)) throw new Error(`runtime execution identity failed at ${boundary}: ${observation.errors.join('; ') || 'prior boundary mismatch retained'}`);
    return observation;
}

/** Both manifests must be full, non-null sets; an omitted key cannot become a replay exemption. */
export function validateReplayProvenance(original, current) {
    if (!original || original.head !== current.head || original.trackedDiffSha256 !== current.trackedDiffSha256) throw new Error('replay source revision differs; restore the recorded commit and source diff first');
    const compare = (left,right,label) => {
        if (!left || !right || !Object.keys(left).length || JSON.stringify(Object.keys(left).sort()) !== JSON.stringify(Object.keys(right).sort())) throw new Error(`replay ${label} manifest is incomplete`);
        for (const [file,value] of Object.entries(right)) if (!/^[a-f0-9]{64}$/.test(value) || !/^[a-f0-9]{64}$/.test(left[file]) || left[file] !== value) throw new Error(`replay ${label} differs or is missing: ${file}`);
    };
    compare(original.buildHashes,current.buildHashes,'build');
    for(const output of Object.values(BUNDLE_OUTPUTS)) for(const file of [output.artifact,...(output.additionalArtifacts ?? [])]) {
        if(!/^[a-f0-9]{64}$/.test(original.buildHashes[file]) || !/^[a-f0-9]{64}$/.test(current.buildHashes[file])) throw new Error(`replay required build artifact missing: ${file}`);
    }
    if (!original.source || original.source.inputManifestSha256 !== current.source?.inputManifestSha256 || JSON.stringify(original.source.inputs) !== JSON.stringify(current.source.inputs)) throw new Error('replay source manifest differs or is missing');
}

/** Retain each child verbatim; validation errors are evidence, never a parent identity substitution. */
export function shardProvenanceErrors(parent, child) {
    const errors = [];
    for (const field of ['runId','head','requestedHead','trackedDiffSha256']) if (child?.[field] !== parent?.[field]) errors.push(`shard ${field} differs`);
    for (const field of ['source','build','executedOutputs','buildHashes','dirtyFiles','runtimeBindings']) if (!child || JSON.stringify(child[field]) !== JSON.stringify(parent[field])) errors.push(`shard ${field} differs or is absent`);
    if (!Number.isFinite(Date.parse(child?.startedAt)) || typeof child?.runId !== 'string' || !child.runId) errors.push('shard run identity incomplete');
    if (!child || child.complete !== true || !Array.isArray(child.errors) || child.errors.length) errors.push('shard provenance incomplete');
    if (!Array.isArray(child?.dirtyFiles) || child.dirtyFiles.length) errors.push('shard source not clean');
    if (!child?.buildHashes || !Object.keys(child.buildHashes).length || Object.values(child.buildHashes).some(value => !/^[a-f0-9]{64}$/.test(value))) errors.push('shard build manifest incomplete');
    return errors;
}

export function replayFiles(source, through) {
    if (!Array.isArray(source.files) || source.files.length === 0) throw new Error('replay requires the original ordered files');
    const index = through === undefined ? source.sequence?.firstFailure?.index : Number(through);
    if (!Number.isInteger(index) || index < 0 || index >= source.files.length) throw new Error('--through must identify an original scenario index (zero based)');
    return source.files.slice(0, index + 1);
}

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function firstFailureSequence({ files, summaries, resultsPath, windowPlacement }) {
    const index = summaries.findIndex(summary => summary.failed > 0);
    return { orderedFiles: files, firstFailure: index < 0 ? null : {
        index, name: summaries[index].name, selectedFile: files[index], precedingFiles: files.slice(0, index),
        replayCommand: `node scripts/scenario.mjs --no-build --replay ${quote(resultsPath)} --through ${index}${windowPlacement && windowPlacement !== 'attached' ? ` --window ${quote(windowPlacement)}` : ''}`,
        freshSandbox: true, originalArtifactsPreserved: true
    } };
}

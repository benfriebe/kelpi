import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest } from './acceptance-io.mjs';
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const list = value => Array.isArray(value) ? value : [];
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const entries = values => Array.isArray(values) && values.length > 0 && values.every(v => typeof v?.path === 'string' && v.path.length > 0 && !path.isAbsolute(v.path) && !v.path.split(/[\\/]/).includes('..') && sha(v.sha256)) && new Set(values.map(v => v.path)).size === values.length;
export const outputDirectories = ['packages/client/dist', 'packages/daemon/dist', 'packages/cli/dist', 'packages/shell/dist'];
export function captureSource(root) {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    const inputs = git(['ls-files', '-z']).split('\0').filter(Boolean).sort().map(file => ({ path: file, sha256: digest(fs.readFileSync(path.join(root, file))) }));
    return { head: git(['rev-parse', 'HEAD']).trim(), tree: git(['rev-parse', 'HEAD^{tree}']).trim(), trackedDiffSha256: digest(git(['diff', 'HEAD', '--binary'])), inputs, inputManifestSha256: digest(JSON.stringify(inputs)) };
}
export function captureOutputs(root, directories = outputDirectories) {
    const outputs = [];
    const visit = relative => {
        const file = path.join(root, relative);
        if (fs.statSync(file).isDirectory()) for (const name of fs.readdirSync(file).sort()) { if (name !== '.build-hash.json') visit(path.posix.join(relative, name)); }
        else outputs.push({ path: relative, sha256: digest(fs.readFileSync(file)) });
    };
    for (const directory of directories) visit(directory);
    return outputs;
}
export function inspectSource(source, head) {
    const missing = [];
    if (!commit(source?.head) || source.head !== head || !commit(source?.tree) || source?.trackedDiffSha256 !== digest('') || !entries(source?.inputs) || !sha(source?.inputManifestSha256) || digest(JSON.stringify(source.inputs)) !== source.inputManifestSha256) missing.push('complete clean source input identity absent or inconsistent');
    return missing;
}
export function inspectBuild(source, build, executedOutputs, { requireCore = true } = {}) {
    const missing = [];
    if (build?.forced !== true || !sha(build?.inputManifestSha256) || build.inputManifestSha256 !== source?.inputManifestSha256 || !entries(build?.outputs)) missing.push('source-bound forced build output manifest absent');
    if (!entries(executedOutputs) || JSON.stringify(executedOutputs) !== JSON.stringify(build?.outputs)) missing.push('executed outputs differ from bound build outputs');
    if (requireCore && outputDirectories.some(dir => !list(build?.outputs).some(o => typeof o?.path === 'string' && o.path.startsWith(`${dir}/`)))) missing.push('required core build output identity absent');
    return missing;
}
export function inspectProvenance(p, { head, buildReceipt } = {}) {
    const missing = [...inspectSource(p?.source, head), ...inspectBuild(p?.source, p?.build, p?.executedOutputs)];
    if (p?.complete !== true || !Array.isArray(p?.errors) || p.errors.length || !Array.isArray(p?.runtimeBindings)) missing.push('runtime provenance capture incomplete');
    if (!sha(p?.trackedDiffSha256) || p.trackedDiffSha256 !== p?.source?.trackedDiffSha256 || !p?.buildHashes || Array.isArray(p.buildHashes) || !Object.keys(p.buildHashes).length || Object.values(p.buildHashes).some(h => !sha(h)) || !entries(p?.executedOutputs) || !list(p?.executedOutputs).every(o => p.buildHashes[o.path] === o.sha256)) missing.push('legacy source/build observations absent or contradictory');
    if (!buildReceipt || buildReceipt.exitStatus !== 0 || buildReceipt.head !== head || buildReceipt.runId !== p?.runId || JSON.stringify(buildReceipt.source) !== JSON.stringify(p?.source) || JSON.stringify(buildReceipt.build) !== JSON.stringify(p?.build)) missing.push('observed runtime is not bound to the retained build receipt');
    for (const binding of list(p?.runtimeBindings)) {
        if (!binding?.id || binding.complete !== true || !Array.isArray(binding.errors) || binding.errors.length) missing.push('runtime artifact binding incomplete');
        missing.push(...inspectSource(binding?.source, head), ...inspectBuild(binding?.source, binding?.build, binding?.executedOutputs, { requireCore: false }));
    }
    if (p?.shardProvenance !== undefined && !Array.isArray(p.shardProvenance)) missing.push('shard provenance malformed');
    for (const shard of list(p?.shardProvenance)) {
        if (!Number.isInteger(shard?.index) || !Array.isArray(shard.errors) || shard.errors.length || !shard.provenance) missing.push('shard provenance incomplete');
        else missing.push(...inspectProvenance(shard.provenance, { head, buildReceipt }));
    }
    return missing;
}

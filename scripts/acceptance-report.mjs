#!/usr/bin/env node
/** Re-evaluate an explicit retained run after adding incident receipts or visual signoffs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, startRun, readArtifact, writeAcceptance, digest, verifyArtifacts, verifyCompletion } from './ui-audit/lib/acceptance-io.mjs';
import { acceptanceVerdict } from './ui-audit/lib/acceptance-verdict.mjs';
import { exitCode } from './ui-audit/lib/acceptance-results.mjs';
// Completion is additive: absent old entries are retained, conflicting identity fields refuse.
const union = (a = [], b = []) => [...new Map([...a, ...b].map(v => [JSON.stringify(v), v])).values()];
export function completeManifest(original, addition, reference) {
    if (!original) return addition;
    if (addition?.schemaVersion !== 1 || !Array.isArray(addition.incidents)) throw new Error('invalid completion manifest');
    const incidents = [...(original.incidents ?? [])].map(old => {
        const next = addition.incidents.find(i => i.id === old.id);
        if (!next) return old;
        if ((next.reference ?? reference) !== (old.reference ?? reference)) throw new Error('completion cannot replace incident baseline');
        for (const key of ['behavior', 'scope']) if (next[key] !== old[key]) throw new Error('completion cannot replace incident identity');
        const receipts = i => i.regressions ?? (i.regression ? [i.regression] : []);
        const merged = { ...old, ...next, assertions: union(old.assertions, next.assertions), requiredEnvironments: union(old.requiredEnvironments, next.requiredEnvironments), requiredVisuals: union(old.requiredVisuals, next.requiredVisuals), visualSignoffs: union(old.visualSignoffs, next.visualSignoffs), regressions: union(receipts(old), receipts(next)) };
        delete merged.regression; return merged;
    });
    for (const next of addition.incidents) if (!incidents.some(i => i.id === next.id)) incidents.push(next);
    return { ...original, ...addition, incidents, auditVisualSignoffs: union(original.auditVisualSignoffs, addition.auditVisualSignoffs) };
}
export function finalizeAcceptance({ root, reportPath, manifestPath, outRoot }) {
    const originalBytes = fs.readFileSync(reportPath);
    const original = JSON.parse(originalBytes);
    if (original.schemaVersion !== 1 || original.scope !== 'commit') throw new Error('requires an explicit commit acceptance report');
    const review = startRun(root, { outRoot, args: ['--report', reportPath, '--manifest', manifestPath], reference: original.reference });
    const originalReceipt = readArtifact(reportPath, review, { startedAt: 0, kind: 'original-acceptance' });
    const receipt = readArtifact(manifestPath, review, { startedAt: 0, kind: 'incident-manifest' });
    if (originalReceipt.error || receipt.error) throw new Error(originalReceipt.error ?? receipt.error);
    if (digest(originalBytes) !== originalReceipt.artifact.sha256 || !verifyArtifacts(original.artifacts)) throw new Error('original report or evidence changed');
    if (original.completion) {
        if (!verifyCompletion(original)) throw new Error('original completion outputs changed');
        const completion = JSON.parse(fs.readFileSync(original.completion.path));
        review.artifacts.push(original.completion, completion.markdown);
    }
    if (original.manifest && (typeof original.manifestPath !== 'string' || !original.artifacts.some(a => a.path === original.manifestPath) || JSON.stringify(JSON.parse(fs.readFileSync(original.manifestPath))) !== JSON.stringify(original.manifest))) throw new Error('original requirements differ from retained manifest');
    const merged = completeManifest(original.manifest, receipt.data, original.reference);
    const mergedPath = path.join(review.outDir, 'completed-manifest.json');
    fs.writeFileSync(mergedPath, `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx' });
    readArtifact(mergedPath, review, { startedAt: 0, kind: 'completed-incident-manifest' });
    const current = snapshot(root), policyReasons = [...(original.policyReasons ?? [])];
    if (current.head !== original.start.head || current.dirty.length) policyReasons.push('review is not on the unchanged clean accepted commit');
    const run = { ...original, outDir: review.outDir, reviewedAt: review.startedAt, reviewRunId: review.runId, manifestPath: mergedPath, retainedFailures: [...(original.retainedFailures ?? []), ...(original.verdict === 'failed' ? [originalReceipt.artifact] : [])], artifacts: [...original.artifacts, ...review.artifacts] };
    const result = acceptanceVerdict(run, { components: original.components, end: original.end, manifest: merged, policyReasons });
    run.artifacts.push(...result.incidentArtifacts);
    return writeAcceptance(run, { ...result, manifest: merged, policyReasons });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    try {
        const argv = process.argv.slice(2), value = flag => argv[argv.indexOf(flag) + 1];
        for (const flag of ['--root', '--report', '--manifest', '--out']) if (!argv.includes(flag) || !value(flag) || value(flag).startsWith('--')) throw new Error(`required: ${flag}`);
        const result = finalizeAcceptance({ root: value('--root'), reportPath: value('--report'), manifestPath: value('--manifest'), outRoot: value('--out') });
        console.log(`${result.verdict}: ${result.outDir}/acceptance.json`); process.exitCode = exitCode(result.verdict);
    } catch (error) { console.error(error.message); process.exitCode = 2; }
}

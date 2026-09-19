#!/usr/bin/env node
/** Re-evaluate an explicit retained run after adding incident receipts or visual signoffs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, startRun, readArtifact, writeAcceptance } from './ui-audit/lib/acceptance-io.mjs';
import { acceptanceVerdict } from './ui-audit/lib/acceptance-verdict.mjs';
import { exitCode } from './ui-audit/lib/acceptance-results.mjs';
export function finalizeAcceptance({ root, reportPath, manifestPath, outRoot }) {
    const original = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (original.schemaVersion !== 1 || original.scope !== 'commit') throw new Error('requires an explicit commit acceptance report');
    const review = startRun(root, { outRoot, args: ['--report', reportPath, '--manifest', manifestPath], reference: original.reference });
    const originalReceipt = readArtifact(reportPath, review, { startedAt: 0, kind: 'original-acceptance' });
    const receipt = readArtifact(manifestPath, review, { startedAt: 0, kind: 'incident-manifest' });
    if (originalReceipt.error || receipt.error) throw new Error(originalReceipt.error ?? receipt.error);
    const current = snapshot(root), policyReasons = [...(original.policyReasons ?? [])];
    if (current.head !== original.start.head || current.dirty.length) policyReasons.push('review is not on the unchanged clean accepted commit');
    const run = { ...original, outDir: review.outDir, reviewedAt: review.startedAt, reviewRunId: review.runId, manifestPath, artifacts: [...original.artifacts, ...review.artifacts] };
    const result = acceptanceVerdict(run, { components: original.components, end: original.end, manifest: receipt.data, policyReasons });
    run.artifacts.push(...result.incidentArtifacts);
    return writeAcceptance(run, { ...result, manifest: receipt.data, policyReasons });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    try {
        const argv = process.argv.slice(2), value = flag => argv[argv.indexOf(flag) + 1];
        for (const flag of ['--root', '--report', '--manifest', '--out']) if (!argv.includes(flag) || !value(flag) || value(flag).startsWith('--')) throw new Error(`required: ${flag}`);
        const result = finalizeAcceptance({ root: value('--root'), reportPath: value('--report'), manifestPath: value('--manifest'), outRoot: value('--out') });
        console.log(`${result.verdict}: ${result.outDir}/acceptance.json`); process.exitCode = exitCode(result.verdict);
    } catch (error) { console.error(error.message); process.exitCode = 2; }
}

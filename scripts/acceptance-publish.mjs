#!/usr/bin/env node
/** Produce a sanitized publication preview; posting requires explicit --publish. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acceptanceVerdict } from './ui-audit/lib/acceptance-verdict.mjs';
import { digest } from './ui-audit/lib/acceptance-io.mjs';
import { exitCode } from './ui-audit/lib/acceptance-results.mjs';

export function publicationPayload(report, pr) {
    if (report?.schemaVersion !== 1 || report.scope !== 'commit' || !/^[a-f0-9]{40}$/.test(report.start?.head ?? '')) throw new Error('requires a retained exact-commit acceptance report');
    if (pr?.head?.sha !== report.start.head || pr.state !== 'open') throw new Error('target PR is not open at the exact report head');
    const result = acceptanceVerdict(report, { components: report.components, end: report.end, manifest: report.manifest, policyReasons: report.policyReasons });
    if (result.verdict !== report.verdict) throw new Error('report verdict no longer matches retained evidence');
    return { schemaVersion: 1, context: 'kelpi/acceptance', sha: report.start.head, reference: report.reference, runId: report.runId, verdict: result.verdict, state: result.verdict === 'verified' ? 'success' : result.verdict === 'failed' ? 'failure' : 'pending', description: `Strict acceptance: ${result.verdict}`,
        sourceClean: report.start.dirty.length === 0 && report.end.dirty.length === 0 && report.start.head === report.end.head,
        components: result.assessments.map(c => ({ ...c, retryCount: Math.max(0, c.attempts.length - 1), firstAttemptVerdict: c.attempts[0]?.verdict ?? 'unverified' })),
        incidents: result.incidentAssessments,
        outstandingAuditVisuals: result.assessments.flatMap(c => c.attempts.flatMap(a => a.outstandingVisuals)),
        manifestDigest: digest(JSON.stringify(report.manifest ?? null)),
        artifactManifestDigest: digest(JSON.stringify((report.artifacts ?? []).map(a => ({ kind: a.kind ?? 'evidence', sha256: a.sha256 })))),
        artifactCount: report.artifacts?.length ?? 0,
        evidenceNote: 'Private artifacts retained locally; this summary omits clipboard, environment identities, paths, and diagnostic text.' };
}
export function publishAcceptance({ reportPath, repo, pr, outDir, targetUrl, publish = false, gh = args => execFileSync('gh', args, { encoding: 'utf8' }) }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[1-9]\d*$/.test(String(pr))) throw new Error('explicit owner/repo and numeric PR required');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const getPR = () => JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}`]));
    const payload = { ...publicationPayload(report, getPR()), reportDigest: digest(fs.readFileSync(reportPath)) };
    fs.mkdirSync(outDir, { recursive: true });
    const stem = `acceptance-${payload.sha}-${report.runId}`;
    fs.writeFileSync(path.join(outDir, `${stem}.json`), `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    const markdown = [
        `# Strict acceptance: ${payload.verdict}`, '', `Commit: \`${payload.sha}\``, `Reference: \`${payload.reference ?? 'missing'}\``, `Run: \`${payload.runId}\``, `Clean source: ${payload.sourceClean}`, '',
        '| Component | Verdict | First attempt | Retries | Assertions / failed | Step / harness / cleanup errors |', '| --- | --- | --- | --- | --- | --- |',
        ...payload.components.map(c => { const counts = c.attempts[0]?.counts; return `| ${c.label} | ${c.verdict} | ${c.firstAttemptVerdict} | ${c.retryCount} | ${counts ? `${counts.total} / ${counts.failed}` : 'unavailable'} | ${counts ? `${counts.stepErrors} / ${counts.harnessErrors} / ${counts.cleanupErrors + counts.cleanupLeaks}` : 'unavailable'} |`; }), '',
        '| Incident | Verdict | Required environment kinds | Exercised kinds | Missing evidence |', '| --- | --- | --- | --- | --- |',
        ...payload.incidents.map(i => `| ${i.id} | ${i.verdict} | ${i.requiredEnvironments.join(', ')} | ${i.exercisedEnvironments.join(', ')} | ${i.missingEvidenceCount} |`), '',
        `Outstanding audit visual reviews: ${payload.outstandingAuditVisuals.join(', ') || 'none recorded'}`, '',
        ...payload.incidents.flatMap(i => i.regressions.map(r => `- ${i.id}: baseline \`${r.baseline}\`, candidate \`${r.candidate}\`, test SHA256 \`${r.testDigest}\`; baseline/candidate assertion failures ${r.baselineFailedAssertions}/${r.candidateFailedAssertions}.`)), '',
        `Report SHA256: \`${payload.reportDigest}\``, `Manifest SHA256: \`${payload.manifestDigest}\``, `Artifact manifest SHA256: \`${payload.artifactManifestDigest}\` (${payload.artifactCount} artifacts)`, '', payload.evidenceNote, ''
    ].join('\n');
    fs.writeFileSync(path.join(outDir, `${stem}.md`), markdown, { flag: 'wx' });
    if (publish) {
        const url = new URL(targetUrl);
        if (url.origin !== 'https://github.com' || url.pathname !== `/${repo}/pull/${pr}` || !/^#issuecomment-\d+$/.test(url.hash)) throw new Error('publication requires the sanitized retained report comment URL on this PR');
        // Check again after preview preparation, immediately before exact-SHA publication.
        publicationPayload(report, getPR());
        gh(['api', '--method', 'POST', `repos/${repo}/statuses/${payload.sha}`, '-f', `state=${payload.state}`, '-f', `context=${payload.context}`, '-f', `description=${payload.description}`, '-f', `target_url=${targetUrl}`]);
    }
    return payload;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const argv = process.argv.slice(2), value = key => argv[argv.indexOf(key) + 1];
        for (const key of ['--report', '--repo', '--pr', '--out']) if (!argv.includes(key) || !value(key) || value(key).startsWith('--')) throw new Error(`required: ${key}`);
        const result = publishAcceptance({ reportPath: value('--report'), repo: value('--repo'), pr: value('--pr'), outDir: value('--out'), targetUrl: argv.includes('--target-url') ? value('--target-url') : undefined, publish: argv.includes('--publish') });
        console.log(JSON.stringify(result, null, 2)); process.exitCode = exitCode(result.verdict);
    } catch (error) { console.error(error.message); process.exitCode = 2; }
}

#!/usr/bin/env node
/** Produce a canonical public preview; exact retained comment binding precedes posting. */
import fs from 'node:fs';
import { executionRoots, observeExecutionRoots, executionRootErrors } from './ui-audit/lib/execution-roots.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acceptanceVerdict } from './ui-audit/lib/acceptance-verdict.mjs';
import { digest, canonicalRunId, verifyCompletion } from './ui-audit/lib/acceptance-io.mjs';
import { ENVIRONMENTS } from './ui-audit/lib/acceptance-environment.mjs';
import { exitCode } from './ui-audit/lib/acceptance-results.mjs';
const commit = v => /^[a-f0-9]{40}$/.test(v ?? '') ? v : null;
const hash = v => /^[a-f0-9]{64}$/.test(v ?? '') ? v : null;
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : 0;
const verdict = v => ['verified', 'failed', 'unverified'].includes(v) ? v : 'unverified';
const environments = values => [...new Set((values ?? []).filter(v => ENVIRONMENTS.includes(v)))];
const publicId = (role, index) => `${role}-${String(index + 1).padStart(3, '0')}`;
const publicCounts = value => value ? Object.fromEntries(['total', 'failed', 'stepErrors', 'harnessErrors', 'cleanupErrors', 'cleanupLeaks'].map(k => [k, count(value[k])])) : null;
export function publicationPayload(report, pr) {
    if (![1,2].includes(report?.schemaVersion) || report.scope !== 'commit' || !commit(report.start?.head) || !canonicalRunId(report.runId)) throw new Error('requires a retained exact-commit acceptance report with canonical run identity');
    if (report.schemaVersion === 2 && !report.executionContext) throw new Error('external acceptance has no established harness/target identity');
    if (report.executionContext) {
        if (!path.isAbsolute(report.executionContextPath ?? '')) throw new Error('external acceptance context path is absent');
        executionRoots({ targetRoot: report.executionContext.target.root, contextPath: report.executionContextPath, contextSha256: report.artifacts?.find(a => a.path === report.executionContextPath)?.sha256 });
        const harnessErrors = executionRootErrors(report.executionContext, observeExecutionRoots(report.executionContext)).filter(message => message.startsWith('harness '));
        if (harnessErrors.length) throw new Error(harnessErrors.join('; '));
    }
    if (!verifyCompletion(report)) throw new Error('required report outputs are incomplete or changed');
    if (pr?.head?.sha !== report.start.head || pr.state !== 'open') throw new Error('target PR is not open at the exact report head');
    const result = acceptanceVerdict(report, { components: report.components, end: report.end, manifest: report.manifest, policyReasons: report.policyReasons });
    if (result.verdict !== report.verdict) throw new Error('report verdict no longer matches retained evidence');
    const components = result.assessments.map((c, i) => ({ label: publicId('component', i), kind: ['audit', 'scenario', 'vitest', 'command', 'build', 'smoke'].includes(c.kind) ? c.kind : 'unknown', verdict: verdict(c.verdict), attempts: c.attempts.map(a => ({ verdict: verdict(a.verdict), counts: publicCounts(a.counts), outstandingVisualCount: a.outstandingVisuals.length, visualRequirementCount: a.visualRequirements.length, visualEvidence: a.visualRequirements.map((v,j) => ({ id: publicId('visual',j), placement: ['default','onscreen','offscreen','hidden'].includes(v.placement) ? v.placement : 'unknown', screenshotCount: count(v.shots.length), screenshots: v.shots.map(s => ({ sha256: hash(s?.sha256), placement: ['default','onscreen','offscreen','hidden'].includes(s?.placement) ? s.placement : 'unknown', blank: s?.blank === true })) })), missingEvidenceCount: count(a.missingCategories) })), retryCount: Math.max(0, c.attempts.length - 1), firstAttemptVerdict: verdict(c.attempts[0]?.verdict) }));
    const categories = ['environment', 'visual-review', 'cleanup', 'original-reproduction', 'artifact-integrity', 'execution-provenance'];
    const incidents = result.incidentAssessments.map((i, n) => ({ id: publicId('incident', n), reference: commit(i.reference), verdict: verdict(i.verdict), missingEvidenceCount: count(i.missingEvidenceCount), failureCount: count(i.failureCount), missingEvidenceCategories: i.missingEvidenceCategories.filter(c => categories.includes(c)), requiredEnvironments: environments(i.requiredEnvironments), unsupportedEnvironmentCount: i.requiredEnvironments.filter(e => !ENVIRONMENTS.includes(e)).length, exercisedEnvironments: environments(i.exercisedEnvironments), outstandingVisuals: i.outstandingVisuals.map((_, j) => publicId(`incident-${n + 1}-visual`, j)), regressions: i.regressions.map(r => ({ baseline: commit(r.baseline), candidate: commit(r.candidate), testDigest: hash(r.testDigest), baselineFailedAssertions: count(r.baselineFailedAssertions), candidateFailedAssertions: count(r.candidateFailedAssertions) })) }));
    return { schemaVersion: 1, context: 'kelpi/acceptance', sha: report.start.head, reference: commit(report.reference), runId: `run-${digest(report.runId).slice(0, 24)}`, verdict: result.verdict, state: result.verdict === 'verified' ? 'success' : result.verdict === 'failed' ? 'failure' : 'pending', description: `Strict acceptance: ${result.verdict}`,
        harness: report.executionContext ? { sha: report.executionContext.harness.expectedHead, sourceManifestDigest: report.executionContext.harness.source.inputManifestSha256, sourceClean: report.executionEnd?.harness?.state?.dirty?.length === 0 && JSON.stringify(report.executionEnd?.harness?.source) === JSON.stringify(report.executionContext.harness.source) } : { sha: report.start.head, sourceClean: report.start.dirty.length === 0 && report.end.dirty.length === 0 },
        sourceClean: report.start.dirty.length === 0 && report.end.dirty.length === 0 && report.start.head === report.end.head && (!report.executionContext || report.executionEnd?.target?.state?.head === report.executionContext.target.expectedHead && report.executionEnd?.target?.state?.dirty?.length === 0 && JSON.stringify(report.executionEnd?.target?.source) === JSON.stringify(report.executionContext.target.source)), components, incidents,
        outstandingScenarioVisuals: result.assessments.filter(c => c.kind === 'scenario').flatMap(c => c.attempts.flatMap(a => a.outstandingVisuals)).map((_, i) => publicId('scenario-visual', i)),
        outstandingAuditVisuals: result.assessments.filter(c => c.kind === 'audit').flatMap(c => c.attempts.flatMap(a => a.outstandingVisuals)).map((_, i) => publicId('audit-visual', i)),
        outstandingSmokeVisuals: result.assessments.filter(c => c.kind === 'smoke').flatMap(c => c.attempts.flatMap(a => a.outstandingVisuals)).map((_, i) => publicId('smoke-visual', i)),
        manifestDigest: digest(JSON.stringify(report.manifest ?? null)), artifactManifestDigest: digest(JSON.stringify(report.artifacts.map(a => ({ sha256: a.sha256 })))), artifactCount: report.artifacts.length,
        evidenceNote: 'Private artifacts retained locally; public identifiers are canonical and omit private labels, paths, clipboard contents and environment identities.' };
}
export function publicationMarkdown(payload) {
    return [
        `# Strict acceptance: ${payload.verdict}`, '', `Target commit: \`${payload.sha}\``, `Reference: \`${payload.reference ?? 'missing'}\``, `Harness commit: \`${payload.harness?.sha ?? 'missing'}\``, `Harness source manifest: \`${payload.harness?.sourceManifestDigest ?? 'same-root legacy report'}\``, `Run: \`${payload.runId}\``, `Clean target source: ${payload.sourceClean}`, `Clean harness source: ${payload.harness?.sourceClean === true}`, '',
        '| Component | Kind | Verdict | First attempt | Retries | Assertions / failed |', '| --- | --- | --- | --- | --- | --- |',
        ...payload.components.map(c => { const counts = c.attempts[0]?.counts; return `| ${c.label} | ${c.kind} | ${c.verdict} | ${c.firstAttemptVerdict} | ${c.retryCount} | ${counts ? `${counts.total} / ${counts.failed}` : 'unavailable'} |`; }), '',
        '| Incident | Verdict | Required environment kinds | Exercised kinds | Missing evidence |', '| --- | --- | --- | --- | --- |',
        ...payload.incidents.map(i => `| ${i.id} | ${i.verdict} | ${i.requiredEnvironments.join(', ')} | ${i.exercisedEnvironments.join(', ')} | ${i.missingEvidenceCount} |`), '',
        `Outstanding scenario visual reviews: ${payload.outstandingScenarioVisuals.join(', ') || 'none recorded'}`, '',
        `Outstanding audit visual reviews: ${payload.outstandingAuditVisuals.join(', ') || 'none recorded'}`, '',
        `Outstanding smoke visual reviews: ${(payload.outstandingSmokeVisuals ?? []).join(', ') || 'none recorded'}`, '',
        ...payload.incidents.flatMap(i => i.regressions.map(r => `- ${i.id}: baseline \`${r.baseline ?? 'missing'}\`, candidate \`${r.candidate ?? 'missing'}\`, test SHA256 \`${r.testDigest ?? 'missing'}\`; baseline/candidate assertion failures ${r.baselineFailedAssertions}/${r.candidateFailedAssertions}.`)), '',
        `Report SHA256: \`${payload.reportDigest}\``, `Manifest SHA256: \`${payload.manifestDigest}\``, `Artifact manifest SHA256: \`${payload.artifactManifestDigest}\` (${payload.artifactCount} artifacts)`, '', payload.evidenceNote, ''
    ].join('\n');
}
export function publishAcceptance({ reportPath, repo, pr, outDir, targetUrl, publish = false, gh = args => execFileSync('gh', args, { encoding: 'utf8' }) }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[1-9]\d*$/.test(String(pr))) throw new Error('explicit owner/repo and numeric PR required');
    const snapshot = fs.readFileSync(reportPath), reportDigest = digest(snapshot), report = JSON.parse(snapshot);
    if (!canonicalRunId(report.runId)) throw new Error('noncanonical run identity');
    const unchanged = () => { if (digest(fs.readFileSync(reportPath)) !== reportDigest) throw new Error('report snapshot changed during publication'); };
    const getPR = () => JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}`]));
    const payload = { ...publicationPayload(report, getPR()), reportDigest };
    unchanged();
    fs.mkdirSync(outDir, { recursive: true });
    const directory = fs.realpathSync(outDir), stem = `acceptance-${payload.sha}-${payload.runId}`;
    const outputPath = suffix => { const file = path.resolve(directory, `${stem}.${suffix}`); if (path.dirname(file) !== directory) throw new Error('preview output escapes requested directory'); return file; };
    const markdown = publicationMarkdown(payload);
    fs.writeFileSync(outputPath('json'), `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    fs.writeFileSync(outputPath('md'), markdown, { flag: 'wx' });
    if (publish) {
        const url = new URL(targetUrl);
        if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.pathname !== `/${repo}/pull/${pr}` || !/^#issuecomment-[1-9]\d*$/.test(url.hash)) throw new Error('publication requires the sanitized retained report comment URL on this PR');
        publicationPayload(report, getPR());
        const id = url.hash.slice('#issuecomment-'.length), comment = JSON.parse(gh(['api', `repos/${repo}/issues/comments/${id}`]));
        if (String(comment.id) !== id || comment.issue_url !== `https://api.github.com/repos/${repo}/issues/${pr}` || comment.html_url !== targetUrl || comment.body !== markdown) throw new Error('retained PR comment does not match the exact sanitized preview and association');
        unchanged();
        publicationPayload(report, { state: 'open', head: { sha: payload.sha } });
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

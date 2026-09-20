import fs from 'node:fs';
import { digest, verifyArtifacts } from './acceptance-io.mjs';
import { ENVIRONMENTS, inspectEnvironment } from './acceptance-environment.mjs';
export { ENVIRONMENTS } from './acceptance-environment.mjs';
import { precedence } from './acceptance-results.mjs';
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const array = v => Array.isArray(v) ? v : [];
export const RUNNER_SOURCES = { runner: 'acceptance-regression.mjs', io: 'ui-audit/lib/acceptance-io.mjs', incidents: 'ui-audit/lib/acceptance-incidents.mjs', results: 'ui-audit/lib/acceptance-results.mjs', environment: 'ui-audit/lib/acceptance-environment.mjs', provenance: 'ui-audit/lib/acceptance-provenance.mjs', selection: 'ui-audit/lib/acceptance-selection.mjs' };

/** Recompute reproduction from named assertions; a crash is never a reproduced incident. */
export function inspectRegression(report, { head, reference, assertionNames = [] } = {}) {
    const failures = [], missing = [];
    if (!nonempty(report?.runId) || !Number.isFinite(Date.parse(report?.startedAt)) || !Number.isFinite(Date.parse(report?.finishedAt)) || Date.parse(report.finishedAt) < Date.parse(report.startedAt)) missing.push('regression run identity/time absent');
    if (report?.schemaVersion !== 1 || report?.kind !== 'incident-regression') missing.push('missing regression runner report');
    if (report?.candidate?.before?.head !== head || report?.baseline?.before?.head !== reference || head === reference) missing.push('baseline/candidate commit mismatch');
    if (!/^[a-f0-9]{64}$/.test(report?.test?.sha256 ?? '') || !Array.isArray(report?.test?.args)) missing.push('missing immutable test identity');
    if (!Array.isArray(report?.artifacts) || report.artifacts.length < 5 || !verifyArtifacts(report.artifacts)) missing.push('regression artifact digest mismatch');
    if (!array(report?.artifacts).some(a => a?.path === report?.test?.path && a.sha256 === report?.test?.sha256)) missing.push('immutable test artifact missing');
    const bound = (file) => nonempty(file) && array(report?.artifacts).some(a => a?.path === file);
    if (!bound(report?.test?.invocationPath)) missing.push('immutable invocation artifact missing');
    try {
        const invocation = JSON.parse(fs.readFileSync(report.test.invocationPath, 'utf8'));
        const { invocationPath, ...expected } = report.test;
        if (JSON.stringify(invocation) !== JSON.stringify(expected)) missing.push('immutable invocation args/source mismatch');
    } catch { missing.push('immutable invocation unavailable'); }
    const runner = array(report?.runner);
    if (runner.length !== Object.keys(RUNNER_SOURCES).length || new Set(runner.map(a => a?.path)).size !== runner.length || new Set(runner.map(a => a?.sha256)).size !== runner.length || Object.entries(RUNNER_SOURCES).some(([role, module]) => runner.filter(a => a?.role === role && a.module === module && a.kind === 'runner-source' && bound(a.path) && array(report.artifacts).some(b => b?.path === a.path && b.sha256 === a.sha256 && b.kind === 'runner-source')).length !== 1)) missing.push('distinct role-bound runner source identity not retained');
    for (const role of ['baseline', 'candidate']) {
        const attempt = report?.[role];
        if (!attempt || !Array.isArray(attempt.before?.dirty) || !Array.isArray(attempt.after?.dirty) || attempt.before.dirty.length || attempt.after.dirty.length || attempt.before.head !== attempt.after.head) missing.push(`${role} was not an unchanged clean commit`);
        if (attempt?.testDigestAfter !== report?.test?.sha256) missing.push(`${role} changed the immutable test`);
        if (!Number.isFinite(attempt?.startedAt) || !Number.isFinite(attempt?.finishedAt) || attempt.finishedAt < attempt.startedAt || attempt.startedAt < Date.parse(report?.startedAt) - 1000 || attempt.finishedAt > Date.parse(report?.finishedAt)) missing.push(`${role} execution timestamps invalid`);
        const raw = attempt?.result;
        for (const field of ['resultPath', 'stdoutPath', 'stderrPath']) if (!bound(attempt?.[field])) missing.push(`${role} ${field} artifact binding absent`);
        const rawArtifact = array(report?.artifacts).find(a => a?.path === attempt?.resultPath);
        if (!rawArtifact) missing.push(`${role} raw result digest absent`);
        if (!rawArtifact || digest(`${JSON.stringify(raw, null, 2)}\n`) !== rawArtifact.sha256) {
            // Reporter formatting is arbitrary: compare parsed bytes to the retained raw object.
            try { if (JSON.stringify(JSON.parse(fs.readFileSync(attempt.resultPath, 'utf8'))) !== JSON.stringify(raw)) missing.push(`${role} raw result differs from artifact`); }
            catch { missing.push(`${role} raw result missing`); }
        }
        if (raw?.schemaVersion !== 1 || !Array.isArray(raw.assertions) || raw.assertions.length === 0 || !Array.isArray(raw.errors)) missing.push(`${role} assertion report malformed`);
        if (array(raw?.errors).length || attempt?.signal || attempt?.error) missing.push(`${role} crash/config/import error is not reproduction`);
        const names = array(raw?.assertions).map(a => a?.name);
        if (names.some(n => !nonempty(n)) || new Set(names).size !== names.length || array(raw?.assertions).some(a => typeof a?.ok !== 'boolean')) missing.push(`${role} named assertion records malformed`);
        const cleanup = raw?.cleanup;
        if (cleanup?.attempted !== true || cleanup?.completed !== true || !Array.isArray(cleanup?.errors) || !Array.isArray(cleanup?.leaks)) missing.push(`${role} cleanup unverified`);
        if (array(cleanup?.errors).length || array(cleanup?.leaks).length) failures.push(`${role} unresolved cleanup leak/error`);
        missing.push(...inspectEnvironment(raw?.environment, { head: attempt?.before?.head, artifacts: array(report?.artifacts) }).missing.map(m => `${role} ${m}`));
    }
    const baseline = array(report?.baseline?.result?.assertions), candidate = array(report?.candidate?.result?.assertions);
    if (JSON.stringify(baseline.map(a => a?.name).sort()) !== JSON.stringify(candidate.map(a => a?.name).sort())) missing.push('baseline/candidate assertion sets differ');
    if (assertionNames.length === 0) missing.push('no incident assertion names selected');
    for (const name of assertionNames) {
        if (!baseline.some(a => a?.name === name && a.ok === false)) missing.push(`original did not reproduce named assertion: ${name}`);
        if (!candidate.some(a => a?.name === name && a.ok === true)) missing.push(`candidate did not pass named assertion: ${name}`);
    }
    if (report?.baseline?.exitStatus !== 1) missing.push('baseline must exit 1 for named assertion failure');
    if ((Number.isInteger(report?.candidate?.exitStatus) && report.candidate.exitStatus !== 0) || candidate.some(a => a?.ok === false)) failures.push('candidate regression attempt failed');
    else if (report?.candidate?.exitStatus !== 0) missing.push('candidate attempt did not complete');
    return { verdict: failures.length ? 'failed' : missing.length ? 'unverified' : 'verified', failures, missing };
}

export function inspectIncidents(manifest, { head, reference } = {}) {
    const reasons = [], verdicts = [], evidence = [], assessments = [];
    if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest?.incidents) || manifest.incidents.length === 0) return { verdict: 'unverified', reasons: ['incident manifest with concrete reproduction evidence is required'], evidence };
    const ids = new Set();
    for (const incident of manifest.incidents) {
        const missing = [], failed = [];
        if (!nonempty(incident?.id) || ids.has(incident.id) || !nonempty(incident?.behavior)) missing.push('concrete unique incident and behavior required');
        ids.add(incident?.id);
        if (incident?.scope !== 'incident') missing.push('synthetic probes prove only their stated scope, not original incident reproduction');
        if (!Array.isArray(incident?.assertions) || !incident.assertions.length || incident.assertions.some(n => !nonempty(n))) missing.push('named incident assertions required');
        const incidentReference = incident?.reference ?? reference;
        if (!/^[a-f0-9]{40}$/.test(incidentReference ?? '') || incidentReference === head) missing.push('explicit incident baseline must be a different exact commit');
        const regressions = [];
        const receipts = incident?.regressions ?? (incident?.regression ? [incident.regression] : []);
        if (!Array.isArray(receipts) || receipts.length === 0) missing.push('regression evidence required');
        for (const receipt of array(receipts)) {
            try {
                const bytes = fs.readFileSync(receipt.path);
                if (digest(bytes) !== receipt.sha256) throw new Error('regression report digest mismatch');
                const regression = JSON.parse(bytes);
                regressions.push(regression);
                evidence.push({ path: receipt.path, sha256: receipt.sha256 }, ...array(regression.artifacts));
                const checked = inspectRegression(regression, { head, reference: incidentReference, assertionNames: array(incident.assertions) });
                missing.push(...checked.missing); failed.push(...checked.failures);
            } catch (error) { missing.push(`regression evidence: ${error.message}`); }
        }
        if (!Array.isArray(incident?.requiredEnvironments) || incident.requiredEnvironments.length === 0) missing.push('explicit relevant environments required');
        for (const kind of array(incident?.requiredEnvironments)) {
            if (!ENVIRONMENTS.includes(kind)) missing.push(`unsupported environment requirement: ${kind}`);
            if (!regressions.some(r => ['baseline', 'candidate'].every(role => r[role]?.result?.environment?.kind === kind && inspectEnvironment(r[role].result.environment, { head: r[role].before?.head, artifacts: r.artifacts }).missing.length === 0))) missing.push(`required environment not exercised on both commits: ${kind}`);
        }
        if (!Array.isArray(incident?.requiredVisuals) || !Array.isArray(incident?.visualSignoffs)) missing.push('explicit visual review requirements/signoffs required');
        for (const id of array(incident?.requiredVisuals)) {
            const signoff = array(incident.visualSignoffs).find(s => s?.id === id && s.head === head && nonempty(s.reviewer) && Number.isFinite(Date.parse(s.at)) && s.verdict === 'passed');
            if (!signoff || !verifyArtifacts(array(signoff.artifacts)) || !array(signoff.artifacts).length) missing.push(`visual signoff outstanding: ${id}`);
            else evidence.push(...signoff.artifacts);
        }
        for (const signoff of array(incident?.visualSignoffs)) if (signoff?.verdict === 'failed') failed.push(`visual review failed: ${signoff.id}`);
        const verdict = failed.length ? 'failed' : missing.length ? 'unverified' : 'verified';
        verdicts.push(verdict);
        assessments.push({ id: incident?.id, verdict, reference: incidentReference, scope: incident?.scope, missingEvidenceCount: missing.length, missingEvidenceCategories: [...new Set(missing.map(message => /environment/.test(message) ? 'environment' : /visual/.test(message) ? 'visual-review' : /cleanup/.test(message) ? 'cleanup' : /original|assertion|reproduc|synthetic/.test(message) ? 'original-reproduction' : /artifact|digest|immutable|invocation|source/.test(message) ? 'artifact-integrity' : 'execution-provenance'))], failureCount: failed.length, requiredEnvironments: array(incident?.requiredEnvironments), exercisedEnvironments: [...new Set(regressions.map(r => r.candidate?.result?.environment?.kind).filter(Boolean))], outstandingVisuals: array(incident?.requiredVisuals).filter(id => missing.includes(`visual signoff outstanding: ${id}`)), regressions: regressions.map(r => ({ baseline: r.baseline?.before?.head, candidate: r.candidate?.before?.head, testDigest: r.test?.sha256, baselineFailedAssertions: array(r.baseline?.result?.assertions).filter(a => a?.ok === false).length, candidateFailedAssertions: array(r.candidate?.result?.assertions).filter(a => a?.ok === false).length })) });
        reasons.push(...[...failed, ...missing].map(r => `${incident?.id ?? 'incident'}: ${r}`));
    }
    return { verdict: precedence(verdicts), reasons, evidence, assessments };
}

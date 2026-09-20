import fs from 'node:fs';
import path from 'node:path';
import { inspectResults, precedence, collectVisualRequirements, reviewablePng, scenarioVisualPlacement } from './acceptance-results.mjs';
import { inspectIncidents } from './acceptance-incidents.mjs';
import { inspectSource, inspectBuild, inspectExecutionContext } from './acceptance-provenance.mjs';
import { canonicalRunId, verifyArtifacts, digest } from './acceptance-io.mjs';
const list = value => Array.isArray(value) ? value : [];
const parse = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Re-evaluate every planned component and attempt from bound artifacts, including on publication. */
export function acceptanceVerdict(run, { components = [], end, manifest, policyReasons = [] } = {}) {
    const reasons = [...policyReasons], verdicts = policyReasons.length ? ['unverified'] : [], assessments = [];
    const missing = message => { reasons.push(message); verdicts.push('unverified'); };
    if (!canonicalRunId(run.runId)) missing('noncanonical run identity');
    if (list(run.retainedFailures).length) { verdicts.push('failed'); reasons.push('retained original acceptance failure'); }
    const bound = file => typeof file === 'string' && list(run.artifacts).some(a => a?.path === file);
    if (run.schemaVersion === 2 || run.executionContext) {
        if (run.schemaVersion !== 2 || !bound(run.executionContextPath) || JSON.stringify(parse(run.executionContextPath)) !== JSON.stringify(run.executionContext)) missing('external execution context is not bound to this run');
        for (const message of inspectExecutionContext(run.executionContext, { head: run.start?.head, observation: run.executionEnd })) missing(message);
    }
    if (manifest && (!bound(run.manifestPath) || JSON.stringify(parse(run.manifestPath)) !== JSON.stringify(manifest))) missing('incident manifest is not bound to its retained artifact');
    if (!run.reference) missing('explicit baseline/reference commit is required');
    if (!Array.isArray(run.start?.dirty) || run.start.dirty.length || !Array.isArray(end?.dirty) || end.dirty.length || run.start?.head !== end?.head) missing('source is dirty, untracked, or changed during verification');
    const plan = parse(run.planPath);
    if (!bound(run.planPath) || ![1,2].includes(plan?.schemaVersion) || plan.schemaVersion !== run.schemaVersion || JSON.stringify(plan.executionContext) !== JSON.stringify(run.executionContext) || plan.runId !== run.runId || plan.head !== run.start?.head || plan.reference !== run.reference || !Array.isArray(plan?.components) || plan.components.length === 0) missing('bound execution plan is absent or does not match this run');
    const expected = list(plan?.components);
    const buildReceipt = bound(run.buildReceiptPath) ? parse(run.buildReceiptPath) : null;
    // A scoped test-only plan does not acquire a runtime or produce a build receipt.
    // Planned runtime work and any explicitly declared receipt still require bound identity.
    const requiresBuild = expected.some(component => ['build', 'audit', 'scenario', 'smoke'].includes(component?.kind));
    if (requiresBuild || run.buildReceiptPath != null) {
        if (!buildReceipt) missing('required or declared build receipt is absent or invalid');
        else if (JSON.stringify(buildReceipt.executionContext) !== JSON.stringify(run.executionContext)) missing('build receipt harness/target context differs from frozen run');
    }
    if (!list(components).length) missing('no checks executed');
    if (new Set(expected.map(c => c?.label)).size !== expected.length) missing('duplicate planned component identity');
    for (const component of expected) if (list(components).filter(c => c?.label === component?.label).length !== 1) missing(`planned component missing or duplicated: ${component?.label}`);
    for (const component of list(components)) {
        const spec = expected.find(c => c?.label === component?.label);
        if (!spec) missing(`unplanned component: ${component?.label}`);
        const assessment = { label: component?.label, kind: spec?.kind ?? 'unknown', attempts: [] };
        const attempts = [component?.firstAttempt, ...(component?.retryAttempt ? list(component.retryAttempt.attempts).length ? component.retryAttempt.attempts : [component.retryAttempt] : [])];
        for (const [index, attempt] of attempts.entries()) {
            const attemptVerdicts = [], note = message => { reasons.push(`${component?.label} attempt ${index + 1}: ${message}`); attemptVerdicts.push('unverified'); };
            let checked = null;
            if (!attempt) note('not executed');
            const execution = attempt?.execution, receipt = parse(execution?.path);
            if (!bound(execution?.path) || !receipt || receipt.exitStatus !== execution?.exitStatus || receipt.command !== execution?.command || (index === 0 && receipt.command !== spec?.command) || !Number.isFinite(receipt.startedAt) || receipt.startedAt < Date.parse(run.startedAt) - 1000 || !Number.isFinite(receipt.finishedAt) || receipt.finishedAt < receipt.startedAt) note('command/build execution receipt missing or inconsistent');
            if (Number.isInteger(receipt?.exitStatus) && receipt.exitStatus !== 0) attemptVerdicts.push('failed');
            const e = attempt?.evidence;
            if (e) {
                if (!bound(e.path)) note('raw report digest absent');
                if (spec?.kind !== e.kind || (index === 0 && (spec?.reportPath !== e.path || spec.command !== e.command))) note('structured report does not match planned role/path/command');
                if (!receipt || e.exitStatus !== receipt.exitStatus || e.command !== receipt.command || e.startedAt > receipt.startedAt || e.finishedAt < receipt.finishedAt) note('report attempt does not match process receipt');
                const raw = parse(e.path), approvedVisuals = [];
                const selection = index === 0 ? spec?.selection : e.selection;
                const requirements = collectVisualRequirements(e.kind, raw, selection, e.path);
                const signoffs = e.kind === 'scenario' ? list(manifest?.scenarioVisualSignoffs) : e.kind === 'smoke' ? list(manifest?.smokeVisualSignoffs) : list(manifest?.auditVisualSignoffs);
                for (const signoff of signoffs) {
                    const visual = requirements.find(v => v.id === signoff?.id);
                    if (!visual || signoff.runId !== run.runId || signoff.head !== run.start.head) continue;
                    // Scenario IDs can recur in retries; bind the exact raw attempt as well.
                    if (['scenario','smoke'].includes(e.kind) && (signoff.report?.path !== e.path || signoff.report?.sha256 !== digest(fs.readFileSync(e.path)))) continue;
                    if (signoff.verdict === 'failed') { attemptVerdicts.push('failed'); reasons.push(`visual review failed: ${visual.id}`); continue; }
                    const shots = visual.shots;
                    const visible = visual.placement !== 'hidden' && (e.kind !== 'scenario' || scenarioVisualPlacement(visual)) && shots.length > 0 && shots.every(shot =>
                        shot?.blank !== true && shot?.placement !== 'hidden' && typeof shot?.path === 'string' && reviewablePng(shot.path) &&
                        (e.kind !== 'scenario' || typeof shot.sha256 === 'string') &&
                        list(signoff.artifacts).some(a => a.path === shot.path && (!shot.sha256 || a.sha256 === shot.sha256)) &&
                        list(run.artifacts).some(a => a.path === shot.path && list(signoff.artifacts).some(s => s.path === a.path && s.sha256 === a.sha256)));
                    if (signoff.verdict === 'passed' && typeof signoff.reviewer === 'string' && signoff.reviewer.trim() && Date.parse(signoff.at) >= e.finishedAt && visible && verifyArtifacts(signoff.artifacts)) approvedVisuals.push(visual.id);
                }
                checked = inspectResults(e.kind, raw, { ...e, runId: run.runId, head: run.start.head, approvedVisuals, requireProvenance: true, expectedPlan: undefined, selection: index === 0 ? spec?.selection : e.selection, buildReceipt });
                attemptVerdicts.push(checked.verdict);
                reasons.push(...[...checked.failures, ...checked.missing].map(r => `${component.label} attempt ${index + 1}: ${r}`));
            } else if (['command', 'build'].includes(spec?.kind) && receipt?.exitStatus === 0) {
                if (spec.kind === 'build') { for (const message of [...inspectSource(receipt.source, run.start.head), ...inspectBuild(receipt.source, receipt.build, receipt.build?.outputs)]) note(message); if (execution.path !== run.buildReceiptPath) note('build receipt is not the retained runtime authority'); }
                attemptVerdicts.push('verified');
            }
            else note('required structured evidence missing or unsupported');
            // Raw later passes cannot erase the first attempt's original recorded failure.
            if (attempt?.verdict === 'failed' || (attempt?.ok === false && attempt.verdict !== 'unverified')) attemptVerdicts.push('failed');
            const verdict = precedence(attemptVerdicts);
            verdicts.push(verdict);
            assessment.attempts.push({ verdict, counts: checked?.counts ?? null, outstandingVisuals: checked?.visuals ?? [], visualRequirements: checked?.visualRequirements ?? [], missingCategories: checked?.missing.length ?? (verdict === 'unverified' ? 1 : 0) });
        }
        assessment.verdict = precedence(assessment.attempts.map(a => a.verdict));
        assessments.push(assessment);
    }
    if (!verifyArtifacts(run.artifacts)) missing('retained artifact digest mismatch or missing file');
    const incidents = inspectIncidents(manifest, { head: run.start?.head, reference: run.reference });
    verdicts.push(incidents.verdict); reasons.push(...incidents.reasons);
    return { verdict: precedence(verdicts), reasons, assessments, incidentAssessments: incidents.assessments ?? [], incidentArtifacts: incidents.evidence };
}

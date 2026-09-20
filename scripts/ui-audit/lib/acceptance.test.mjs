import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectResults as inspectRawResults, precedence, exitCode, scenarioVisualPlacement } from './acceptance-results.mjs';
import { digest, startRun, readArtifact, writeAcceptance, resolveRef } from './acceptance-io.mjs';
import { inspectIncidents, inspectRegression } from './acceptance-incidents.mjs';
import { acceptanceVerdict } from './acceptance-verdict.mjs';
import { runRegression } from '../../acceptance-regression.mjs';
import { finalizeAcceptance } from '../../acceptance-report.mjs';
import { publicationPayload, publishAcceptance } from '../../acceptance-publish.mjs';
import { recorder } from './driver.mjs';
import { assertionIdentities, inspectSelection } from './acceptance-selection.mjs';
const root = path.resolve(import.meta.dirname, '../../..');
const cleanup = () => ({ attempted: true, completed: true, errors: [], leaks: [] });
const context = { runId: 'run-1', head: 'a'.repeat(40), startedAt: Date.now() - 1000 };
const source = head => { const inputs = [{ path: 'fixture.mjs', sha256: digest('source fixture') }]; return { head, tree: 'c'.repeat(40), trackedDiffSha256: digest(''), inputs, inputManifestSha256: digest(JSON.stringify(inputs)) }; };
const provenance = () => {
    const identity = source(context.head), outputs = ['client', 'daemon', 'cli', 'shell'].map(p => ({ path: `packages/${p}/dist/fixture.js`, sha256: digest(p) }));
    return { complete: true, errors: [], runtimeBindings: [], runId: context.runId, head: context.head, requestedHead: context.head, dirtyFiles: [], startedAt: new Date().toISOString(), trackedDiffSha256: digest(''), source: identity, build: { inputManifestSha256: identity.inputManifestSha256, outputs, forced: true }, executedOutputs: outputs, buildHashes: Object.fromEntries(outputs.map(o => [o.path, o.sha256])) };
};
const selections = Object.fromEntries(['audit', 'scenario', 'vitest'].map(kind => [kind, { kind, ordered: kind !== 'vitest', complete: true, members: [{ id: kind === 'vitest' ? '/test.mjs' : 'copy', mode: 'assert', requiredAssertions: [kind === 'vitest' ? 'copy selected text' : 'clipboard equals selected text'], minAssertions: 1 }] }]));
const buildReceipt = p => ({ runId: p.runId, head: p.head, exitStatus: 0, source: p.source, build: p.build });
const inspectResults = (kind, raw, options) => inspectRawResults(kind, raw, { selection: selections[kind], buildReceipt: buildReceipt(provenance()), ...options });
const audit = () => ({ provenance: provenance(), cleanup: cleanup(), summary: { total: 1, assertions: 1, failedAssertions: 0, errored: 0, eyes: 0 }, steps: [{ id: 'copy', assertions: [{ name: 'clipboard equals selected text', ok: true }], error: null, needsEyes: false }] });
const scenario = () => ({ provenance: provenance(), cleanup: cleanup(), summaries: [{ name: 'copy', checks: 1, failed: 0, results: [{ label: 'clipboard equals selected text', ok: true }], leaked: [] }], leaks: [] });
const vitest = () => ({ startTime: Date.now(), success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [{ name: '/test.mjs', status: 'passed', assertionResults: [{ fullName: 'copy selected text', status: 'passed' }] }] });
const temporary = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-acceptance-unit-')); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('raw structured result boundaries', () => {
    it.each(['audit', 'scenario', 'vitest'])('accepts complete matching %s evidence', kind => {
        const raw = { audit, scenario, vitest }[kind]();
        expect(inspectResults(kind, raw, context).verdict).toBe('verified');
    });
    it('fails an exit-zero audit with failed assertions and step errors even if summary says green', () => {
        const raw = audit(); raw.steps[0].assertions[0].ok = false; raw.steps[0].error = 'clipboard unavailable';
        const result = inspectResults('audit', raw, context);
        expect(result.verdict).toBe('failed'); expect(result.counts.failed).toBe(1);
        expect(result.missing).toContain('audit failedAssertions counter mismatch');
    });
    it('fails raw scenario checks, harnessFailure and leaks despite zero summary and zero exit', () => {
        const raw = scenario(); raw.summaries[0].results[0].ok = false;
        expect(inspectResults('scenario', raw, context).verdict).toBe('failed');
        for (const raw of [{ ...scenario(), harnessFailure: 'startup failed' }, { ...scenario(), leaks: [{ name: 'copy', leaked: ['focus'] }] }]) expect(inspectResults('scenario', raw, context).verdict).toBe('failed');
    });
    it('does not accept summary-only scenarios or malformed/empty/missing reports', () => {
        const raw = scenario(); delete raw.summaries[0].results;
        for (const report of [raw, null, {}, { summaries: [] }]) expect(inspectResults('scenario', report, context).verdict).toBe('unverified');
    });
    it('checks timestamps, run identity, actual head, requested head and dirty source', () => {
        for (const patch of [{ runId: 'previous' }, { head: 'b'.repeat(40) }, { requestedHead: 'b'.repeat(40) }, { startedAt: '2000-01-01T00:00:00Z' }, { dirtyFiles: ['?? fresh-source.mjs'] }]) {
            const raw = audit(); Object.assign(raw.provenance, patch); expect(inspectResults('audit', raw, context).verdict).toBe('unverified');
        }
    });
    it('requires actual cleanup completion and fails unresolved leaks', () => {
        const raw = audit(); delete raw.cleanup;
        expect(inspectResults('audit', raw, context).verdict).toBe('unverified');
        raw.cleanup = { ...cleanup(), leaks: ['foreign workspace left behind'] };
        expect(inspectResults('audit', raw, context).verdict).toBe('failed');
    });
    it('requires outstanding visual reviews', () => {
        const raw = audit(); raw.steps[0].needsEyes = true; raw.summary.eyes = 1;
        expect(inspectResults('audit', raw, context).verdict).toBe('unverified');
    });
    it('rejects skipped vitest assertions and false-green summary counters', () => {
        const raw = vitest(); raw.testResults[0].assertionResults[0].status = 'pending';
        expect(inspectResults('vitest', raw, context).verdict).toBe('unverified');
        raw.testResults[0].assertionResults[0].status = 'failed';
        expect(inspectResults('vitest', raw, context).verdict).toBe('failed');
    });
    it('keeps repeated assertion prose as distinct frozen identities and rejects an exact-set drift', () => {
        const raw = audit(); raw.steps[0].assertions.push({ name: 'clipboard equals selected text', ok: true }); raw.summary.assertions = 2;
        const selection = { kind: 'audit', ordered: true, complete: true, members: [{ id: 'copy', mode: 'assert', requiredAssertions: ['clipboard equals selected text [1]', 'clipboard equals selected text [2]'], minAssertions: 2, expectedAssertionDigest: '0'.repeat(64) }] };
        const result = inspectRawResults('audit', raw, { selection, buildReceipt: buildReceipt(provenance()), ...context });
        expect(result.verdict).toBe('unverified');
        expect(result.missing).toContain('copy: exact selected assertion identity set differs from frozen contract');
    });
    it('accepts uniquely identified smoke checks but rejects duplicate smoke IDs and counter drift', () => {
        const selection = { kind: 'smoke', ordered: true, complete: true, members: [{id:'shell',mode:'assert',requiredAssertions:['daemon stays alive'],assertionPaths:[['daemon stays alive']],minAssertions:1}] };
        const raw = { name: 'shell', provenance: provenance(), cleanup: cleanup(), exitStatus: 0, selection, assertions: [{ id: 'shell:1', name: 'daemon stays alive', ok: true }], summary: { assertions: 1, passed: 1, failed: 0 } };
        const options = { selection, buildReceipt: buildReceipt(provenance()), ...context };
        expect(inspectRawResults('smoke', raw, options).verdict).toBe('verified');
        for (const omitted of ['cleanup', 'provenance']) {
            const broken = structuredClone(raw); delete broken[omitted];
            expect(inspectRawResults('smoke', broken, options).verdict).toBe('unverified');
        }
        expect(inspectRawResults('smoke', {...raw, cleanup:{...cleanup(),leaks:['owned child']}}, options).verdict).toBe('failed');
        const truncated = structuredClone(raw); truncated.assertions=[]; truncated.summary={assertions:0,passed:0,failed:0};
        expect(inspectRawResults('smoke', truncated, options).verdict).toBe('unverified');
        raw.assertions.push({ id: 'shell:1', name: 'second check', ok: true }); raw.summary = { assertions: 2, passed: 2, failed: 0 };
        expect(inspectRawResults('smoke', raw, options).missing).toContain('smoke assertion identities are absent or duplicated');
    });
    it('qualifies repeated prose without colliding with literal suffix or escape labels', () => {
        const names = ['x','x','x [1]','@assertion:["x",1]','@assertion:["x",1]','@@assertion:["x",1]'];
        const ids = assertionIdentities(names);
        expect(new Set(ids).size).toBe(names.length);
        expect(assertionIdentities(ids)).toEqual(ids);
        expect(ids[2]).toBe('x [1]');
    });
    it('requires the complete ordered assertion path, rejecting extra or reordered passes', () => {
        const selection = {kind:'smoke',ordered:true,complete:true,members:[{id:'shell',mode:'assert',requiredAssertions:['a'],assertionPaths:[['a','b']],minAssertions:2}]};
        const report = names => ({name:'shell', assertions:names.map(name=>({name,ok:true}))});
        expect(inspectSelection('smoke',report(['a','b']),selection)).toEqual([]);
        for (const names of [['b','a'],['a','b','c'],['a']]) expect(inspectSelection('smoke',report(names),selection).length).toBeGreaterThan(0);
    });
    it('requires every ordered segment without permitting extra or omitted dynamic checks', () => {
        const segments = [{reason:'fixed prefix',alternatives:[['begin']]},{reason:'explicit geometry alternatives',alternatives:[['left covered','right exposed'],['left exposed','right covered']]},{reason:'fixed teardown',alternatives:[['end']]}];
        const selection = {kind:'audit',ordered:true,complete:true,members:[{id:'popup',mode:'assert',requiredAssertions:['begin','end'],minAssertions:4,assertionPathSegments:segments}]};
        const raw = labels => ({steps:[{id:'popup',assertions:labels.map(name=>({name,ok:true}))}]});
        expect(inspectSelection('audit',raw(['begin','left covered','right exposed','end']),selection)).toEqual([]);
        expect(inspectSelection('audit',raw(['begin','left exposed','right covered','end']),selection)).toEqual([]);
        for (const labels of [['begin','end'],['begin','left covered','end'],['begin','right exposed','left covered','end'],['begin','left covered','right exposed','end','extra']]) expect(inspectSelection('audit',raw(labels),selection)).not.toEqual([]);
        selection.members[0].assertionPathSegments[1].alternatives.push([]);
        expect(inspectSelection('audit',raw(['begin','left covered','right exposed','end']),selection)).not.toEqual([]);
    });
    it('records actual owned default-window observations around capture and refuses unproved visual placement', async () => {
        const windowRuntime={private:true,sourceRoot:'/target',shellPid:123,sandboxRoot:'/tmp/private',harnessSocket:'/tmp/private/harness.sock',placement:'default',focusEmulated:false};
        const events=[], state={focused:true,visible:true,minimized:false,bounds:{x:0,y:0,width:800,height:600}};
        const rec=recorder({name:'copy',outDir:temp(),placement:'default',windowRuntime,observeWindow:async()=>{events.push('observe');return structuredClone(state);}});
        await rec.shot({screenshot:async file=>{events.push('capture');fs.writeFileSync(file,'fixture image bytes');}},'native');
        expect(events).toEqual(['observe','capture','observe']);
        const shot=rec.summary().screenshots[0], visual={placement:'default',requiresNativeFocus:true,windowRuntime,shots:[shot]};
        expect(scenarioVisualPlacement(visual)).toBe(true);
        for(const patch of [{placement:'hidden'},{placement:'offscreen'},{placement:'attached'},{placement:'unknown'},{requiresNativeFocus:false},{windowRuntime:undefined},{windowRuntime:{...windowRuntime,private:false}},{windowRuntime:{...windowRuntime,focusEmulated:true}}]) expect(scenarioVisualPlacement({...visual,...patch})).toBe(false);
        for(const patch of [{visible:false},{minimized:true},{focused:false},{bounds:{x:0,y:0,width:0,height:0}}]) {
            const broken=structuredClone(visual);Object.assign(broken.shots[0].windowProof.before.state,patch);expect(scenarioVisualPlacement(broken)).toBe(false);
        }
        const raw=scenario(), selection=structuredClone(selections.scenario);
        Object.assign(raw.summaries[0],{placement:'default',windowRuntime,screenshots:[shot]});
        Object.assign(selection.members[0],{requiredVisuals:['copy:shot:native'],requiresNativeFocus:true});
        const options={...context,selection,approvedVisuals:['copy:shot:native']};
        expect(inspectResults('scenario',raw,options).verdict).toBe('verified');
        delete raw.summaries[0].windowRuntime;
        expect(inspectResults('scenario',raw,options).verdict).toBe('unverified');
    });
    it('enforces failed > unverified > verified and only verified exits zero', () => {
        expect(precedence(['verified', 'unverified', 'failed'])).toBe('failed');
        expect(precedence(['verified', 'unverified'])).toBe('unverified');
        expect(precedence([])).toBe('unverified');
        expect(['verified', 'failed', 'unverified'].map(exitCode)).toEqual([0, 1, 2]);
    });
});

function cleanRepo(parent, name, state) {
    const dir = path.join(parent, name); fs.mkdirSync(dir);
    const git = args => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git(['init', '-q']); git(['config', 'user.name', 'acceptance fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    fs.writeFileSync(path.join(dir, 'behavior.txt'), state); git(['add', 'behavior.txt']); git(['commit', '-qm', state]);
    return dir;
}
function regressionFixture({ crash = false, synthetic = false, visual = null } = {}) {
    const dir = temp(), baseline = cleanRepo(dir, 'baseline', 'broken'), candidate = cleanRepo(dir, 'candidate', 'fixed'), test = path.join(dir, 'test.mjs');
    fs.writeFileSync(test, `import fs from 'node:fs'; import path from 'node:path';
const ok = fs.readFileSync(path.join(process.env.KELPI_REGRESSION_ROOT, 'behavior.txt'), 'utf8') === 'fixed';
${crash ? "if (!ok) throw new Error('cannot import fixture');" : ''}
const report = { schemaVersion:1, assertions:[{name:'copy exactly selected text',ok}], errors:[], environment:{id:'fixture-machine',kind:'local',details:'unit boundary fixture; not installed app evidence'}, cleanup:{attempted:true,completed:true,errors:[],leaks:[]} };
${visual ? `const visualFile = process.env.KELPI_REGRESSION_REPORT + '.png';
const pixels = ${visual === 'text' ? "Buffer.from('text cannot establish pixels')" : `Buffer.from('${visual === 'blank' ? 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGP4DwYAFPIF+6QNfF4AAAAASUVORK5CYII=' : 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4//8/AwMDAA74Av7Ji4P1AAAAAElFTkSuQmCC'}','base64')`};
fs.writeFileSync(visualFile,pixels); report.environment.evidence = {facts:[{role:'visual',path:visualFile,sha256:(await import('node:crypto')).createHash('sha256').update(pixels).digest('hex')}]};` : ''}
fs.writeFileSync(process.env.KELPI_REGRESSION_REPORT, JSON.stringify(report)); process.exitCode = ok ? 0 : 1;
`);
    const result = runRegression({ baseline, candidate, test, assertions: ['copy exactly selected text'], outRoot: path.join(dir, 'runs') });
    const report = JSON.parse(fs.readFileSync(result.path));
    const manifest = { schemaVersion: 1, incidents: [{ id: 'fixture', behavior: 'fixture behavior text changes', scope: synthetic ? 'synthetic-probe' : 'incident', assertions: ['copy exactly selected text'], regression: { path: result.path, sha256: result.sha256 }, requiredEnvironments: ['local'], requiredVisuals: [], visualSignoffs: [] }] };
    return { dir, baseline, candidate, result, report, manifest };
}
describe('incident screenshots bind candidate pixels to their exact reviewed regression', () => {
    // Synthetic two-pixel images exercise the validator, not a product visual claim.
    const prepare = visual => {
        const fixture = regressionFixture({ visual });
        const { report, result, manifest } = fixture;
        const incident = manifest.incidents[0], head = report.candidate.before.head;
        incident.requiredVisuals = ['incident-view'];
        incident.visualSignoffs = [{ id: 'incident-view', head, runId: report.runId,
            regression: { path: result.path, sha256: result.sha256 }, reviewer: 'fixture-reviewer',
            at: new Date().toISOString(), verdict: 'passed',
            artifacts: report.candidate.result.environment.evidence.facts.filter(f => f.role === 'visual').map(({ path, sha256 }) => ({ path, sha256 })) }];
        return { ...fixture, options: { head, reference: report.baseline.before.head } };
    };
    it('accepts a review of retained nonblank candidate pixels and rejects substituted identity or evidence', () => {
        const f = prepare('image');
        expect(inspectIncidents(f.manifest, f.options).verdict).toBe('verified');
        for (const mode of ['old-time','future-time','run','receipt','receipt-digest','baseline','unbound','reviewer','empty']) {
            const m = structuredClone(f.manifest), signoff = m.incidents[0].visualSignoffs[0];
            if (mode === 'old-time') signoff.at = '2000-01-01T00:00:00Z';
            if (mode === 'future-time') signoff.at = '2999-01-01T00:00:00Z';
            if (mode === 'run') signoff.runId += '-wrong';
            if (mode === 'receipt') signoff.regression.path += '-wrong';
            if (mode === 'receipt-digest') signoff.regression.sha256 = '0'.repeat(64);
            if (mode === 'baseline') signoff.artifacts = f.report.baseline.result.environment.evidence.facts;
            if (mode === 'unbound') {
                const file = path.join(temp(), 'unrelated.png'); fs.copyFileSync(signoff.artifacts[0].path, file);
                signoff.artifacts[0].path = file;
            }
            if (mode === 'reviewer') signoff.reviewer = '';
            if (mode === 'empty') signoff.artifacts = [];
            expect(inspectIncidents(m, f.options).verdict, mode).toBe('unverified');
        }
    });
    it.each(['text', 'blank'])('rejects %s even when retained as a candidate visual artifact', visual => {
        const f = prepare(visual);
        expect(inspectIncidents(f.manifest, f.options).verdict).toBe('unverified');
    });
});

describe('executable same-test regression evidence', () => {
    it('retains exact immutable source, arguments, raw named baseline failure and candidate pass', () => {
        const { result, report, manifest } = regressionFixture();
        expect(result.verdict).toBe('verified');
        expect(report.baseline.result.assertions[0].ok).toBe(false); expect(report.candidate.result.assertions[0].ok).toBe(true);
        expect(inspectIncidents(manifest, { head: report.candidate.before.head, reference: report.baseline.before.head }).verdict).toBe('verified');
    });
    it('does not call a baseline import crash a reproduced incident', () => {
        const { result } = regressionFixture({ crash: true });
        expect(result.verdict).toBe('unverified'); expect(result.missing.some(s => s.includes('crash/config/import'))).toBe(true);
    });
    it('refuses dirty worktrees before executing and retains every previous run', () => {
        const { candidate, baseline, report, dir } = regressionFixture();
        fs.writeFileSync(path.join(candidate, 'untracked.mjs'), 'source');
        expect(() => runRegression({ baseline, candidate, test: report.test.path, assertions: ['copy exactly selected text'], outRoot: path.join(dir, 'runs') })).toThrow(/clean/);
        expect(fs.existsSync(report.test.path)).toBe(true);
    });
    it('rejects missing original reproduction, changed source artifacts and summary-only evidence', () => {
        const { report } = regressionFixture();
        const context = { head: report.candidate.before.head, reference: report.baseline.before.head, assertionNames: ['an assertion never run'] };
        expect(inspectRegression(report, context).verdict).toBe('unverified');
        fs.chmodSync(report.test.path, 0o644); fs.appendFileSync(report.test.path, '\n// modified');
        expect(inspectRegression(report, { ...context, assertionNames: ['copy exactly selected text'] }).verdict).toBe('unverified');
    });
    it('cannot waive real environments, visual review or synthetic scope into verified', () => {
        const { report, manifest } = regressionFixture({ synthetic: true });
        const incident = manifest.incidents[0]; incident.requiredEnvironments = ['installed-tailscale', 'remote-codex', 'safari', 'physical-phone', 'native-ime']; incident.requiredVisuals = ['copy-first-failure'];
        const result = inspectIncidents(manifest, { head: report.candidate.before.head, reference: report.baseline.before.head });
        expect(result.verdict).toBe('unverified'); expect(result.reasons).toHaveLength(7);
    });
});

function attachPlan(run, components) {
    const dir = temp(), planPath = path.join(dir, 'plan.json');
    if (run.manifest) {
        run.manifestPath = path.join(dir, 'manifest.json'); fs.writeFileSync(run.manifestPath, JSON.stringify(run.manifest));
        run.artifacts.push({ path: run.manifestPath, sha256: digest(fs.readFileSync(run.manifestPath)) });
    }
    run.startedAt ??= new Date(Date.now() - 1000).toISOString();
    const plan = { schemaVersion: 1, runId: run.runId, head: run.start.head, reference: run.reference, components: components.map(c => ({ label: c.label, kind: c.kind ?? 'command', command: c.command ?? 'typecheck', ...(c.reportPath ? { reportPath: c.reportPath, selection: selections[c.kind] } : {}) })) };
    fs.writeFileSync(planPath, JSON.stringify(plan)); run.planPath = planPath;
    run.artifacts.push({ path: planPath, sha256: digest(fs.readFileSync(planPath)) });
    for (const component of components) {
        const file = path.join(dir, `execution-${run.artifacts.length}.json`);
        const receipt = { command: component.command ?? 'typecheck', exitStatus: 0, startedAt: Date.now(), finishedAt: Date.now() };
        fs.writeFileSync(file, JSON.stringify(receipt)); run.artifacts.push({ path: file, sha256: digest(fs.readFileSync(file)) });
        component.firstAttempt ??= { ok: true, verdict: 'verified' };
        component.firstAttempt.execution = { ...receipt, path: file };
    }
    for (const component of components.filter(c => ['audit', 'scenario'].includes(c.kind) && typeof c.reportPath === 'string' && fs.existsSync(c.reportPath))) {
        const raw = JSON.parse(fs.readFileSync(component.reportPath)), p = raw.provenance;
        const file = path.join(dir, 'build.json'); fs.writeFileSync(file, JSON.stringify(buildReceipt(p)));
        run.buildReceiptPath = file; run.artifacts.push({ path: file, sha256: digest(fs.readFileSync(file)) });
    }
    run.components = components;
}

describe('retained reports and exact-head publication', () => {
    it('keeps unique runs and fails report-writing instead of silently passing', () => {
        const dir = temp(), first = startRun(root, { outRoot: dir }), second = startRun(root, { outRoot: dir });
        expect(first.runId).not.toBe(second.runId);
        writeAcceptance(first, { verdict: 'unverified', reasons: ['no evidence'] });
        expect(() => writeAcceptance(first, { verdict: 'verified' })).toThrow();
        const artifact = path.join(dir, 'old.json'); fs.writeFileSync(artifact, '{}'); fs.utimesSync(artifact, new Date(0), new Date(0));
        expect(readArtifact(artifact, second).data).toBe(null);
    });
    it('does not interpolate refs into a shell and rejects option refs', () => {
        expect(() => resolveRef(root, '--help')).toThrow();
        const target = path.join(temp(), 'injected');
        expect(() => resolveRef(root, `HEAD; touch ${target}`)).toThrow(); expect(fs.existsSync(target)).toBe(false);
    });
    it('recomputes the exact head report, sanitizes private evidence and refuses moved PRs', () => {
        const { report: regression, manifest } = regressionFixture();
        const start = regression.candidate.before, reference = regression.baseline.before.head;
        const report = { schemaVersion: 1, scope: 'commit', runId: 'safe-run', start, end: start, reference, artifacts: [], manifest, components: [{ label: 'typecheck', firstAttempt: { ok: true, verdict: 'verified' } }], policyReasons: [] };
        attachPlan(report, report.components);
        report.verdict = acceptanceVerdict(report, report).verdict;
        expect(report.verdict).toBe('verified');
        report.outDir = temp(); Object.assign(report, writeAcceptance(report, { verdict: report.verdict }));
        const payload = publicationPayload(report, { state: 'open', head: { sha: start.head } });
        expect(payload.state).toBe('success'); expect(JSON.stringify(payload)).not.toContain('fixture-machine'); expect(JSON.stringify(payload)).not.toContain('KELPI_REGRESSION');
        expect(() => publicationPayload(report, { state: 'open', head: { sha: 'b'.repeat(40) } })).toThrow(/exact/);
        const file = path.join(temp(), 'report.json'); fs.writeFileSync(file, JSON.stringify(report)); const calls = [];
        publishAcceptance({ reportPath: file, repo: 'example/repo', pr: 1, outDir: temp(), gh: argv => { calls.push(argv); return JSON.stringify({ state: 'open', head: { sha: start.head } }); } });
        expect(calls).toHaveLength(1); expect(calls[0][1]).toBe('repos/example/repo/pulls/1');
    });
    it('a no-op, dirty source or missing incident stays unverified', () => {
        const run = { runId: 'empty', start: { head: context.head, dirty: [] }, reference: 'b'.repeat(40), artifacts: [] };
        expect(acceptanceVerdict(run, { components: [], end: run.start }).verdict).toBe('unverified');
    });
});

describe('planned evidence cannot be silently omitted', () => {
    it('rejects removal of a planned component and conversion of a structured check into a green boolean', () => {
        const run = { runId: 'run', start: { head: context.head, dirty: [] }, end: { head: context.head, dirty: [] }, reference: 'b'.repeat(40), artifacts: [] };
        const components = [{ label: 'audit', kind: 'audit', command: 'run audit', reportPath: '/not-present.json', firstAttempt: { ok: true, verdict: 'verified' } }];
        attachPlan(run, components);
        expect(acceptanceVerdict(run, { ...run, components: [] }).reasons).toContain('planned component missing or duplicated: audit');
        expect(acceptanceVerdict(run, run).reasons.some(r => r.includes('required structured evidence missing'))).toBe(true);
    });
    it('later diagnostic failure overrides an unverified first attempt', () => {
        const run = { runId: 'run', start: { head: context.head, dirty: [] }, end: { head: context.head, dirty: [] }, reference: 'b'.repeat(40), artifacts: [] };
        const components = [{ label: 'audit', kind: 'audit', command: 'audit', firstAttempt: { ok: false, verdict: 'unverified' }, retryAttempt: { ok: false, verdict: 'failed' } }];
        attachPlan(run, components);
        const result = acceptanceVerdict(run, run);
        expect(result.verdict).toBe('failed'); expect(result.assessments[0].attempts.map(a => a.verdict)).toEqual(['unverified', 'failed']);
    });
    it('requires raw-result, immutable-test and invocation artifact bindings', () => {
        const { report } = regressionFixture();
        const options = { head: report.candidate.before.head, reference: report.baseline.before.head, assertionNames: ['copy exactly selected text'] };
        for (const path of [report.baseline.resultPath, report.candidate.resultPath, report.test.path, report.test.invocationPath, report.baseline.stdoutPath, report.candidate.stderrPath]) {
            const clone = { ...report, artifacts: report.artifacts.filter(a => a.path !== path) };
            expect(inspectRegression(clone, options).verdict).toBe('unverified');
        }
    });
});

describe('visual review completion is exact-run evidence', () => {
    it('permits a retained review without erasing failed assertions and rejects another run signoff', () => {
        const { report: regression, manifest, candidate } = regressionFixture();
        const dir = temp(), rawPath = path.join(dir, 'audit.json'), shotPath = path.join(dir, 'copy.png');
        const start = regression.candidate.before;
        const run = { schemaVersion: 1, scope: 'commit', runId: context.runId, start, end: start, reference: regression.baseline.before.head, artifacts: [], manifest, policyReasons: [] };
        const raw = audit(); raw.provenance.head = start.head; raw.provenance.requestedHead = start.head; raw.provenance.source.head = start.head; raw.steps[0].needsEyes = true; raw.steps[0].shots = ['copy.png']; raw.summary.eyes = 1;
        fs.writeFileSync(rawPath, JSON.stringify(raw)); fs.writeFileSync(shotPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4//8/AwMDAA74Av7Ji4P1AAAAAElFTkSuQmCC','base64'));
        run.artifacts.push(...[rawPath, shotPath].map(file => ({ path: file, sha256: digest(fs.readFileSync(file)) })));
        const components = [{ label: 'audit', kind: 'audit', command: 'run audit', reportPath: rawPath, firstAttempt: { ok: false, verdict: 'unverified' } }];
        attachPlan(run, components);
        const receipt = components[0].firstAttempt.execution;
        components[0].firstAttempt.evidence = { kind: 'audit', path: rawPath, command: receipt.command, startedAt: receipt.startedAt - 1, finishedAt: receipt.finishedAt, exitStatus: 0 };
        const first = acceptanceVerdict(run, run); expect(first.verdict).toBe('unverified');
        const originalPath = path.join(dir, 'acceptance.json'); fs.writeFileSync(originalPath, JSON.stringify({ ...run, verdict: first.verdict }));
        manifest.auditVisualSignoffs = [{ id: 'copy', runId: run.runId, head: start.head, at: new Date(receipt.finishedAt + 1).toISOString(), reviewer: 'reviewer', verdict: 'passed', artifacts: [{ path: shotPath, sha256: digest(fs.readFileSync(shotPath)) }] }];
        const manifestPath = path.join(dir, 'review.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const final = finalizeAcceptance({ root: candidate, reportPath: originalPath, manifestPath, outRoot: path.join(dir, 'reviews') });
        expect(final.verdict).toBe('verified'); expect(fs.existsSync(originalPath)).toBe(true);
        manifest.auditVisualSignoffs[0].runId = 'different-run'; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        expect(finalizeAcceptance({ root: candidate, reportPath: originalPath, manifestPath, outRoot: path.join(dir, 'reviews') }).verdict).toBe('unverified');
        const failed = JSON.parse(fs.readFileSync(originalPath)); failed.components[0].firstAttempt.verdict = 'failed'; fs.writeFileSync(originalPath, JSON.stringify(failed));
        expect(finalizeAcceptance({ root: candidate, reportPath: originalPath, manifestPath, outRoot: path.join(dir, 'reviews') }).verdict).toBe('failed');
    });
});

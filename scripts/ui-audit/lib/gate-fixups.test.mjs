import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, writeAcceptance } from './acceptance-io.mjs';
import { inspectResults } from './acceptance-results.mjs';
import { inspectRegression, inspectIncidents } from './acceptance-incidents.mjs';
import { acceptanceVerdict } from './acceptance-verdict.mjs';
import { runRegression } from '../../acceptance-regression.mjs';
import { finalizeAcceptance, completeManifest } from '../../acceptance-report.mjs';
import { publishAcceptance, publicationPayload } from '../../acceptance-publish.mjs';
let base, candidate, proof, proofRef, root, serial = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const temp = () => { const dir = path.join(root, String(++serial)); fs.mkdirSync(dir); return dir; };
const put = (dir, name, value) => { const file = path.join(dir, name); const bytes = typeof value === 'string' ? value : JSON.stringify(value); fs.writeFileSync(file, bytes, { flag: 'wx' }); return { path: file, sha256: digest(bytes) }; };
const options = () => ({ head: proof.candidate.before.head, reference: proof.baseline.before.head, assertionNames: ['behavior'] });
const cleanup = () => ({ attempted: true, completed: true, errors: [], leaks: [] });
beforeAll(() => {
    root = fs.mkdtempSync(path.join(process.env.KELPI_GATE_FIXTURE_ROOT ?? os.tmpdir(), 'gate-fixups-'));
    const repo = state => { const dir = temp(); const git = args => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }); git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']); fs.writeFileSync(path.join(dir, 'behavior'), state); git(['add', 'behavior']); git(['commit', '-qm', state]); return dir; };
    base = repo('broken'); candidate = repo('fixed');
    const test = put(temp(), 'fixture.mjs', `import fs from 'node:fs'; const ok=fs.readFileSync(process.env.KELPI_REGRESSION_ROOT+'/behavior','utf8')==='fixed'; fs.writeFileSync(process.env.KELPI_REGRESSION_REPORT,JSON.stringify({schemaVersion:1,assertions:[{name:'behavior',ok}],errors:[],environment:{id:'private-node-fixture',kind:'local',details:'Node private fixture'},cleanup:{attempted:true,completed:true,errors:[],leaks:[]}}));process.exitCode=ok?0:1;`);
    proofRef = runRegression({ baseline: base, candidate, test: test.path, assertions: ['behavior'], outRoot: temp() }); proof = JSON.parse(fs.readFileSync(proofRef.path));
});
afterAll(() => { if (!process.env.KELPI_GATE_FIXTURE_ROOT) fs.rmSync(root, { recursive: true, force: true }); });
function manifest() { return { schemaVersion: 1, incidents: [{ id: 'fixture', behavior: 'private behavior fixture', scope: 'incident', assertions: ['behavior'], regressions: [{ path: proofRef.path, sha256: proofRef.sha256 }], requiredEnvironments: ['local'], requiredVisuals: [], visualSignoffs: [] }] }; }
function runFixture(man = manifest()) {
    const dir = temp(), at = Date.now(), run = { schemaVersion: 1, scope: 'commit', runId: `fixture-${serial}`, startedAt: new Date(at - 10).toISOString(), outDir: dir, start: proof.candidate.before, end: proof.candidate.after, reference: proof.baseline.before.head, manifest: man, artifacts: [], policyReasons: [] };
    const save = (name, value) => { const a = put(dir, name, value); run.artifacts.push(a); return a.path; };
    run.manifestPath = save('manifest.json', man);
    const receipt = { command: 'fixture check', startedAt: at, finishedAt: at, exitStatus: 0 };
    const execution = { ...receipt, path: save('execution.json', receipt) };
    run.components = [{ label: 'fixture check', firstAttempt: { ok: true, verdict: 'verified', execution } }];
    run.planPath = save('plan.json', { schemaVersion: 1, runId: run.runId, head: run.start.head, reference: run.reference, components: [{ label: 'fixture check', kind: 'command', command: receipt.command }] });
    const result = acceptanceVerdict(run, run); run.artifacts.push(...result.incidentArtifacts);
    return { run, result, save };
}
function complete(run) { const result = acceptanceVerdict(run, run); return writeAcceptance(run, result); }
function publish(report, { drift = false, comment = 'exact', runId } = {}) {
    const file = put(temp(), 'report.json', { ...report, ...(runId ? { runId } : {}) }).path, out = temp(), calls = [];
    const pr = { state: 'open', head: { sha: report.start.head } };
    let reads = 0;
    const gh = args => {
        calls.push(args);
        if (args[1] === 'repos/fixture/repo/pulls/42') { if (drift && ++reads === 1) fs.writeFileSync(file, JSON.stringify({ ...report, verdict: 'failed' })); return JSON.stringify(pr); }
        if (args[1] === 'repos/fixture/repo/issues/comments/55') {
            if (comment === 'missing') throw new Error('comment not found');
            const md = fs.readdirSync(out).find(p => p.endsWith('.md'));
            return JSON.stringify({ id: 55, html_url: 'https://github.com/fixture/repo/pull/42#issuecomment-55', issue_url: `https://api.github.com/repos/fixture/repo/issues/${comment === 'other-pr' ? 7 : 42}`, body: comment === 'stale' ? 'stale summary' : fs.readFileSync(path.join(out, md), 'utf8') });
        }
        return '{}';
    };
    const execute = () => publishAcceptance({ reportPath: file, repo: 'fixture/repo', pr: 42, outDir: out, publish: true, targetUrl: 'https://github.com/fixture/repo/pull/42#issuecomment-55', gh });
    return { execute, calls, file, out };
}
function structured(kind) {
    const now = Date.now(), selected = ['a', 'b'].map(id => ({ id: kind === 'vitest' ? `/${id}.test.mjs` : id, mode: 'assert', requiredAssertions: [`required ${id}`], minAssertions: 1 }));
    const expectedPlan = { kind, ordered: kind !== 'vitest', complete: true, members: selected };
    const p = { runId: 'fixture', head: 'a'.repeat(40), requestedHead: 'a'.repeat(40), dirtyFiles: [], startedAt: new Date(now).toISOString(), trackedDiffSha256: digest(''), sourceHashes: { 'source.mjs': digest('source') }, buildHashes: { 'packages/client/dist/index.html': digest('bundle') } };
    const raw = kind === 'scenario' ? { provenance: p, cleanup: cleanup(), files: ['a.mjs', 'b.mjs'], summaries: selected.map(s => ({ name: s.id, checks: 1, failed: 0, results: [{ label: s.requiredAssertions[0], ok: true }] })), leaks: [] } : kind === 'audit' ? { provenance: p, cleanup: cleanup(), steps: selected.map(s => ({ id: s.id, assertions: [{ name: s.requiredAssertions[0], ok: true }] })), summary: { total: 2, assertions: 2, failedAssertions: 0, errored: 0, eyes: 0 } } : { startTime: now, success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, testResults: selected.map(s => ({ name: s.id, status: 'passed', assertionResults: [{ fullName: s.requiredAssertions[0], status: 'passed' }] })) };
    return { raw, context: { runId: p.runId, head: p.head, startedAt: now, expectedPlan, requireProvenance: false } };
}
describe('independent selected-member boundaries (G1)', () => {
    it.each(['scenario', 'audit', 'vitest'])('%s preserves healthy selected identities and rejects omitted/empty/wrong assertions', kind => {
        const { raw, context } = structured(kind); expect(inspectResults(kind, raw, context).verdict).toBe('verified');
        for (const mode of ['omit', 'empty', 'renamed']) {
            const bad = clone(raw), members = bad.summaries ?? bad.steps ?? bad.testResults;
            if (mode === 'omit') members.pop(); else { const entries = members[1].results ?? members[1].assertions ?? members[1].assertionResults; if (mode === 'empty') entries.length = 0; else Object.assign(entries[0], { label: 'different', name: 'different', fullName: 'different' }); }
            if (kind === 'scenario' && mode === 'empty') members[1].checks = 0;
            if (kind === 'audit') { bad.summary.total = members.length; bad.summary.assertions = members.reduce((n,s) => n+s.assertions.length,0); }
            if (kind === 'vitest') bad.numTotalTests = bad.numPassedTests = members.reduce((n,s) => n+s.assertionResults.length,0);
            expect(inspectResults(kind, bad, context).verdict, mode).toBe('unverified');
        }
    });
});
describe('retained authority corrections', () => {
    it('keeps a genuine local regression and complete report publishable', () => { expect(proofRef.verdict).toBe('verified'); const { run, result } = runFixture(); expect(result.verdict).toBe('verified'); const p = publish(complete(run)); expect(p.execute().state).toBe('success'); expect(p.calls.filter(c => c.includes('POST'))).toHaveLength(1); });
    it('G2 rejects removal of required environments and failed incidents', () => {
        for (const failing of [false, true]) {
            const man = manifest();
            if (!failing) man.incidents[0].requiredEnvironments.push('physical-phone');
            else { const failed = clone(proof); failed.candidate.result.assertions[0].ok = false; failed.candidate.exitStatus = 1; const a = put(temp(),'failed-raw.json',failed.candidate.result); failed.candidate.resultPath = a.path; failed.artifacts.push(a); const ref = put(temp(),'failed.json',failed); man.incidents.push({ ...clone(man.incidents[0]), id:'failed-incident', regressions:[ref] }); }
            const { run } = runFixture(man), original = complete(run); expect(original.verdict).toBe(failing ? 'failed' : 'unverified');
            const m = put(temp(),'reduced.json',manifest());
            const result = finalizeAcceptance({ root:candidate,reportPath:path.join(run.outDir,'acceptance.json'),manifestPath:m.path,outRoot:temp() });
            expect(result.verdict).not.toBe('verified'); if (failing) expect(result.verdict).toBe('failed');
        }
    });
    it('G3 rejects an environment label with Node-only evidence', () => {
        const r = clone(proof); for (const role of ['baseline','candidate']) { r[role].result.environment.kind='physical-phone'; const a=put(temp(),`${role}.json`,r[role].result); r[role].resultPath=a.path; r.artifacts.push(a); }
        expect(inspectRegression(r,options()).verdict).toBe('unverified');
    });
    it('G4 cannot publish authority after the second output fails', () => {
        const { run, result }=runFixture();fs.mkdirSync(path.join(run.outDir,'acceptance.md'));expect(()=>writeAcceptance(run,result)).toThrow();
        const file=path.join(run.outDir,'acceptance.json'); if(fs.existsSync(file)) expect(()=>publicationPayload(JSON.parse(fs.readFileSync(file)),{state:'open',head:{sha:run.start.head}})).toThrow();
    });
    it('G5 rejects missing and contradictory source/build facts', () => { const {raw,context}=structured('scenario');context.requireProvenance=true; expect(inspectResults('scenario',raw,context).verdict).toBe('unverified'); });
    it('G6 refuses report drift across the GitHub boundary', () => { const {run}=runFixture();const p=publish(complete(run),{drift:true});expect(()=>p.execute()).toThrow(/changed|drift/);expect(p.calls.some(c=>c.includes('POST'))).toBe(false); });
    it.each(['missing','stale','other-pr'])('G7 refuses %s retained comments', comment => { const {run}=runFixture();const p=publish(complete(run),{comment});expect(()=>p.execute()).toThrow();expect(p.calls.some(c=>c.includes('POST'))).toBe(false); });
    it('G8 never exposes arbitrary identifiers in public JSON or Markdown', () => {
        const secret='PRIVATE_FIXTURE_CLIPBOARD_secret_marker',man=manifest();man.incidents[0].id=secret;man.incidents[0].requiredEnvironments.push(secret);man.incidents[0].requiredVisuals.push(secret);
        const {run}=runFixture(man);const report=complete(run),p=publish(report);p.execute();for(const name of fs.readdirSync(p.out))expect(fs.readFileSync(path.join(p.out,name),'utf8')).not.toContain(secret);
    });
    it('G9 refuses noncanonical run identifiers before any output', () => { const {run}=runFixture();const p=publish(complete(run),{runId:'fixture/../../escape'});expect(()=>p.execute()).toThrow();expect(fs.readdirSync(p.out)).toEqual([]); });
    it('G10 requires distinct role-bound runner sources', () => { const r=clone(proof),paths=r.runner.map(a=>a.path);r.artifacts=r.artifacts.filter(a=>!paths.includes(a.path));r.runner=Array(4).fill(r.artifacts.find(a=>a.path===r.test.path));expect(inspectRegression(r,options()).verdict).toBe('unverified'); });
});

function bindStructured(kind) {
    const { run, save } = runFixture(), { raw, context } = structured(kind);
    if (kind !== 'vitest') {
        const inputs = [{ path: 'fixture.mjs', sha256: digest('fixture source') }];
        const source = { head: run.start.head, tree: 'c'.repeat(40), trackedDiffSha256: digest(''), inputs, inputManifestSha256: digest(JSON.stringify(inputs)) };
        const outputs = ['client', 'daemon', 'cli', 'shell'].map(p => ({ path: `packages/${p}/dist/main.js`, sha256: digest(p) }));
        Object.assign(raw.provenance, { head: run.start.head, requestedHead: run.start.head, runId: run.runId, source, build: { inputManifestSha256: source.inputManifestSha256, outputs, forced: true }, executedOutputs: clone(outputs), buildHashes: Object.fromEntries(outputs.map(o => [o.path, o.sha256])), complete: true, errors: [], runtimeBindings: [] });
        run.buildReceiptPath = save('build.json', { head: run.start.head, runId: run.runId, source, build: raw.provenance.build, exitStatus: 0 });
    }
    const at = Date.now(), command = `fixture ${kind}`, receipt = { command, startedAt: at, finishedAt: at, exitStatus: 0 };
    const rawPath = save('raw.json', raw), execution = { ...receipt, path: save('structured-command.json', receipt) };
    run.components = [{ label: 'selected private component', firstAttempt: { ok: true, verdict: 'verified', execution, evidence: { kind, path: rawPath, command, startedAt: at - 100, finishedAt: at + 1, exitStatus: 0 } } }];
    const plan = { schemaVersion: 1, runId: run.runId, head: run.start.head, reference: run.reference, components: [{ label: run.components[0].label, kind, command, reportPath: rawPath, selection: context.expectedPlan }] };
    run.planPath = save('structured-plan.json', plan);
    const replaceRaw = value => { const old = run.artifacts.find(a => a.path === rawPath); fs.writeFileSync(rawPath, JSON.stringify(value)); old.sha256 = digest(fs.readFileSync(rawPath)); };
    return { run, raw, replaceRaw, plan };
}
describe('complete aggregate controls and adverse mutations', () => {
    it.each(['scenario', 'audit', 'vitest'])('a fully bound %s is healthy and cannot omit or empty the second selection', kind => {
        const {run, raw, replaceRaw} = bindStructured(kind); expect(acceptanceVerdict(run,run).verdict).toBe('verified');
        const bad=clone(raw), members=bad.summaries??bad.steps??bad.testResults; members.pop();
        if(kind==='audit') bad.summary.total=bad.summary.assertions=1;
        if(kind==='vitest') bad.numTotalTests=bad.numPassedTests=1;
        replaceRaw(bad); expect(acceptanceVerdict(run,run).verdict).toBe('unverified');
    });
    it('G1 accepts declared setup/visual-only audit steps and rejects asserting steps changed to empty', () => {
        const {raw,context}=structured('audit');raw.steps[1].assertions=[];raw.summary.assertions=1;
        context.expectedPlan.members[1]={id:'b',mode:'setup',requiredAssertions:[],minAssertions:0};expect(inspectResults('audit',raw,context).verdict).toBe('verified');
        raw.steps[1].shots=['reviewable-fixture.png'];context.expectedPlan.members[1].mode='visual';raw.steps[1].needsEyes=true;raw.summary.eyes=1;
        expect(inspectResults('audit',raw,context).verdict).toBe('unverified');
        expect(inspectResults('audit',raw,{...context,approvedVisuals:['b']}).verdict).toBe('verified');
    });
    it('G1 requires scenario order and known required names even when counts stay green', () => {
        const {raw,context}=structured('scenario');raw.summaries.reverse();expect(inspectResults('scenario',raw,context).verdict).toBe('unverified');
        raw.summaries.reverse();raw.summaries[1].results[0].label='replacement check';expect(inspectResults('scenario',raw,context).verdict).toBe('unverified');
    });
    it('G5 binds nonempty source, all bundles, and runtime outputs to the retained build receipt', () => {
        const {run,raw,replaceRaw}=bindStructured('scenario');expect(acceptanceVerdict(run,run).verdict).toBe('verified');
        for (const mutate of [p=>delete p.source,p=>p.source.inputs=[],p=>p.source.trackedDiffSha256='changed source',p=>p.build.outputs=[],p=>p.executedOutputs[0].sha256=digest('stale bundle'),p=>p.buildHashes[p.executedOutputs[0].path]=null,p=>p.build.forced=false]) { const bad=clone(raw);mutate(bad.provenance);replaceRaw(bad);expect(acceptanceVerdict(run,run).verdict).toBe('unverified'); }
        replaceRaw(raw);run.artifacts=run.artifacts.filter(a=>a.path!==run.buildReceiptPath);expect(acceptanceVerdict(run,run).verdict).toBe('unverified');
    });
    it('all retained attempts preserve failed > unverified > verified precedence', () => {
        for(const first of ['verified','unverified','failed'])for(const retry of ['verified','unverified','failed']){
            const {run}=runFixture();run.components[0].firstAttempt.verdict=first;run.components[0].firstAttempt.ok=first==='verified';
            run.components[0].retryAttempt={...clone(run.components[0].firstAttempt),verdict:retry,ok:retry==='verified'};
            // An unverified attempt lacks actual structured evidence; its recorded green command cannot waive it.
            if(first==='unverified')delete run.components[0].firstAttempt.execution;
            if(retry==='unverified')delete run.components[0].retryAttempt.execution;
            expect(acceptanceVerdict(run,run).verdict).toBe(first==='failed'||retry==='failed'?'failed':first==='unverified'||retry==='unverified'?'unverified':'verified');
        }
    });
    it('original unbound-artifact shape remains rejected', () => { const r=clone(proof);r.artifacts=[];expect(inspectRegression(r,options()).verdict).toBe('unverified');expect(inspectRegression(r,options()).missing.join(' ')).toMatch(/artifact|invocation|runner/); });
    it('G4 refuses changed Markdown and final artifact bytes after successful finalization', () => {
        for(const what of ['markdown','artifact']){const {run}=runFixture(),report=complete(run);const target=what==='markdown'?path.join(run.outDir,'acceptance.md'):run.components[0].firstAttempt.execution.path;fs.appendFileSync(target,'changed');expect(()=>publicationPayload(report,{state:'open',head:{sha:run.start.head}})).toThrow();}
    });
    it('G9 rejects internally consistent traversal, slash, dot and overlong IDs', () => {
        for(const id of ['fixture/../../escape','../escape','x\\y','.','x'.repeat(129)]){
            const {run}=runFixture();run.runId=id;const plan=JSON.parse(fs.readFileSync(run.planPath));plan.runId=id;fs.writeFileSync(run.planPath,JSON.stringify(plan));run.artifacts.find(a=>a.path===run.planPath).sha256=digest(fs.readFileSync(run.planPath));
            const p=publish(complete(run));expect(()=>p.execute()).toThrow(/run identity/);expect(fs.readdirSync(p.out)).toEqual([]);
        }
    });
});

// Corroboration fixtures exercise the schema only; these are not claims about real devices.
import { inspectEnvironment } from './acceptance-environment.mjs';
function corroborated(kind, head) {
    const dir=temp(),outputs=[{path:'fixture-app',sha256:digest('compiled fixture')}],buildDigest=digest(JSON.stringify(outputs)),sessionId='private-session';
    const common={head,sessionId,buildDigest};
    const values={build:{...common,role:'build',outputs,sourceHead:head},session:{...common,role:'session',startedAt:new Date(Date.now()-1000).toISOString(),driver:kind==='physical-phone'?'native-device':'native-harness',emulated:false},device:{...common,role:'device',os:'fixture-os',osVersion:'1',hardwareId:'fixture-device',virtual:false,formFactor:'phone',browser:'Safari',engine:'WebKit',browserVersion:'1'}};
    if(['installed-tailscale','remote-codex'].includes(kind))values.transport={...common,role:'transport',kind:kind==='installed-tailscale'?'tailscale':'remote-codex',connected:true,localPeer:'fixture-a',remotePeer:'fixture-b',connectionId:'fixture-connection'};
    if(['physical-phone','native-ime'].includes(kind))values['native-events']={...common,role:'native-events',platformAPI:'fixture-native-api',injected:false,trustedEventCount:1,inputMethod:'fixture-ime',compositionObserved:true};
    const facts=Object.entries(values).map(([role,value])=>({...put(dir,`${role}.json`,value),role}));
    const environment={id:'fixture-nonlocal',kind,details:'schema fixture only, not actual device evidence',evidence:{...common,operator:'fixture-operator',facts,review:{reviewer:'fixture-independent-reviewer',independent:true,verdict:'passed',...common,factsDigest:digest(JSON.stringify(facts)),at:new Date().toISOString()}}};
    return {environment,artifacts:facts};
}
describe('corroborated environment schema and limits',()=>{
    it.each(['installed-tailscale','remote-codex','safari','physical-phone','native-ime'])('%s needs bound session/build/device facts and independent attestation',kind=>{
        const head=options().head,{environment,artifacts}=corroborated(kind,head);
        expect(inspectEnvironment(environment,{head,artifacts}).missing).toEqual([]);
        for(const mutate of [e=>delete e.evidence,e=>e.evidence.head='b'.repeat(40),e=>delete e.evidence.review,e=>e.evidence.review.reviewer=e.evidence.operator,e=>e.evidence.facts.pop(),e=>e.evidence.buildDigest=digest('other build')]){const bad=clone(environment);mutate(bad);expect(inspectEnvironment(bad,{head,artifacts}).missing.length).toBeGreaterThan(0);}
        expect(inspectEnvironment(environment,{head,artifacts:[]}).missing.length).toBeGreaterThan(0);
        fs.appendFileSync(artifacts[0].path,'tampered');expect(inspectEnvironment(environment,{head,artifacts}).missing.length).toBeGreaterThan(0);
    });
    it('Node/CDP cannot become a physical phone even with hashed session metadata',()=>{
        const head=options().head,{environment,artifacts}=corroborated('physical-phone',head),fact=environment.evidence.facts.find(f=>f.role==='session');
        const data=JSON.parse(fs.readFileSync(fact.path));data.driver='cdp-emulation';data.emulated=true;fs.writeFileSync(fact.path,JSON.stringify(data));fact.sha256=digest(fs.readFileSync(fact.path));environment.evidence.review.factsDigest=digest(JSON.stringify(environment.evidence.facts));
        expect(inspectEnvironment(environment,{head,artifacts}).missing).toContain('physical phone not corroborated');
    });
});

it('required runtime binding cannot disappear while core provenance remains healthy', () => {
    const {run,raw,replaceRaw,plan}=bindStructured('scenario');
    plan.components[0].selection.runtimeRequirements=['terminal-lab:fixture'];
    fs.writeFileSync(run.planPath,JSON.stringify(plan));run.artifacts.find(a=>a.path===run.planPath).sha256=digest(fs.readFileSync(run.planPath));
    expect(acceptanceVerdict(run,run).verdict).toBe('unverified');
    raw.provenance.runtimeBindings=[{id:'terminal-lab:fixture',source:raw.provenance.source,build:raw.provenance.build,executedOutputs:raw.provenance.executedOutputs,complete:true,errors:[]}];replaceRaw(raw);
    expect(acceptanceVerdict(run,run).verdict).toBe('verified');
    raw.provenance.runtimeBindings[0].executedOutputs=[];replaceRaw(raw);expect(acceptanceVerdict(run,run).verdict).toBe('unverified');
});

it('an explicitly different incident baseline stays exact and cannot change at completion', () => {
    const man=manifest(),actual=options().reference,other='f'.repeat(40);man.incidents[0].reference=actual;
    expect(inspectIncidents(man,{head:options().head,reference:other}).verdict).toBe('verified');
    const changed=clone(man);changed.incidents[0].reference=other;
    expect(inspectIncidents(changed,{head:options().head,reference:other}).verdict).toBe('unverified');
    expect(()=>completeManifest(man,changed,other)).toThrow(/baseline/);
    expect(()=>completeManifest(man,manifest(),other)).toThrow(/baseline/);
});
it('Vitest collection suite names match structured ancestor/title identities', () => {
    const {raw,context}=structured('vitest');
    raw.testResults[0].assertionResults[0]={ancestorTitles:['suite'],title:'required a',fullName:'suite required a',status:'passed'};
    context.expectedPlan.members[0].requiredAssertions=['suite > required a'];
    expect(inspectResults('vitest',raw,context).verdict).toBe('verified');
    raw.testResults[0].assertionResults[0].title='different';expect(inspectResults('vitest',raw,context).verdict).toBe('unverified');
});

it('malformed provenance collections and selected members remain unverified', () => {
    const {run,raw,replaceRaw,plan}=bindStructured('scenario');
    for(const mutate of [p=>p.build.outputs={},p=>p.executedOutputs={},p=>p.runtimeBindings={},p=>p.runtimeBindings=[null],p=>p.shardProvenance={}]){const bad=clone(raw);mutate(bad.provenance);replaceRaw(bad);expect(acceptanceVerdict(run,run).verdict).toBe('unverified');}
    replaceRaw(raw);plan.components[0].selection.members=[null];fs.writeFileSync(run.planPath,JSON.stringify(plan));run.artifacts.find(a=>a.path===run.planPath).sha256=digest(fs.readFileSync(run.planPath));expect(acceptanceVerdict(run,run).verdict).toBe('unverified');
});

// Full aggregate and additive-finalization coverage for scenario visuals. These
// images are synthetic two-pixel PNGs; they are schema controls, never product evidence.
const visiblePNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4//8/AwMDAA74Av7Ji4P1AAAAAElFTkSuQmCC','base64');
const blankPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGP4DwYAFPIF+6QNfF4AAAAASUVORK5CYII=','base64');
function replaceBound(run,file,value) {
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    run.artifacts.find(a=>a.path===file).sha256=digest(fs.readFileSync(file));
}
function scenarioVisualFixture({placement='onscreen',blank=false}={}) {
    const f=bindStructured('scenario'),{run,raw,plan}=f;
    const id='a:shot:view',file=path.join(run.outDir,'view.png');fs.writeFileSync(file,blank?blankPNG:visiblePNG);
    const artifact={path:file,sha256:digest(fs.readFileSync(file)),kind:'screenshot'};run.artifacts.push(artifact);
    plan.components[0].selection.members[0].requiredVisuals=[id];replaceBound(run,run.planPath,plan);
    Object.assign(raw.summaries[0],{placement,screenshots:[{id,path:file,sha256:artifact.sha256,placement,blank}],visuals:[{id,screenshotId:id,reason:'EYES private visual requirement'}]});f.replaceRaw(raw);
    const e=run.components[0].firstAttempt.evidence;
    const signoff={id,runId:run.runId,head:run.start.head,report:{path:e.path,sha256:digest(fs.readFileSync(e.path))},at:new Date(e.finishedAt+1).toISOString(),reviewer:'independent fixture reviewer',verdict:'passed',artifacts:[artifact]};
    const apply=signoffs=>{run.manifest.scenarioVisualSignoffs=signoffs;replaceBound(run,run.manifestPath,run.manifest);};
    return {...f,signoff,apply,file};
}
describe('exact scenario image review and additive completion',()=>{
    it('verifies exact visible review while retaining raw attempts and prior outputs',()=>{
        const {run,signoff}=scenarioVisualFixture();const original=complete(run);expect(original.verdict).toBe('unverified');
        const before=run.artifacts.map(a=>[a.path,digest(fs.readFileSync(a.path))]);
        const addition={schemaVersion:1,incidents:[],scenarioVisualSignoffs:[signoff]},m=put(temp(),'review.json',addition);
        const final=finalizeAcceptance({root:candidate,reportPath:path.join(run.outDir,'acceptance.json'),manifestPath:m.path,outRoot:temp()});
        expect(final.verdict,JSON.stringify(final.reasons)).toBe('verified');expect(final.components).toEqual(run.components);
        for(const [file,hash] of before)expect(digest(fs.readFileSync(file))).toBe(hash);
        const reduced=put(temp(),'reduced-review.json',{schemaVersion:1,incidents:[]});
        const again=finalizeAcceptance({root:candidate,reportPath:path.join(final.outDir,'acceptance.json'),manifestPath:reduced.path,outRoot:temp()});expect(again.verdict).toBe('verified');expect(again.manifest.scenarioVisualSignoffs).toEqual([signoff]);
    });
    it.each(['run','head','report','report-hash','time','reviewer','artifacts','missing','changed','wrong-shot'])('rejects %s screenshot signoff evidence',mode=>{
        const {run,signoff,apply,file}=scenarioVisualFixture();
        if(mode==='run')signoff.runId='wrong-run';if(mode==='head')signoff.head='0'.repeat(40);if(mode==='report')signoff.report.path+='other';if(mode==='report-hash')signoff.report.sha256='0'.repeat(64);if(mode==='time')signoff.at='2000-01-01T00:00:00Z';if(mode==='reviewer')signoff.reviewer='';if(mode==='artifacts')signoff.artifacts=[];if(mode==='missing')fs.unlinkSync(file);if(mode==='changed')fs.writeFileSync(file,blankPNG);if(mode==='wrong-shot')signoff.artifacts=[put(temp(),'other.png',visiblePNG)];
        apply([signoff]);expect(acceptanceVerdict(run,run).verdict).toBe('unverified');
    });
    it.each([{placement:'hidden'},{placement:'offscreen'},{blank:true}])('refuses nonreviewable image %j',options=>{const {run,signoff,apply}=scenarioVisualFixture(options);apply([signoff]);expect(acceptanceVerdict(run,run).verdict).toBe('unverified');});
    it('retains failed visual reviews and functional attempts despite later passes',()=>{
        for(const mode of ['visual','functional']) {const {run,signoff,apply}=scenarioVisualFixture();apply(mode==='visual'?[{...signoff,verdict:'failed'},signoff]:[signoff]);if(mode==='functional')run.components[0].firstAttempt.verdict='failed';expect(acceptanceVerdict(run,run).verdict).toBe('failed');}
    });
    it('publishes sanitized scenario requirements, image identities and outstanding counts',()=>{
        const {run}=scenarioVisualFixture();const report=complete(run),payload=publicationPayload(report,{state:'open',head:{sha:run.start.head}});
        expect(payload.outstandingScenarioVisuals).toHaveLength(1);expect(payload.outstandingAuditVisuals).toEqual([]);expect(payload.components[0].attempts[0].visualEvidence[0]).toMatchObject({placement:'onscreen',screenshotCount:1});expect(JSON.stringify(payload)).not.toContain('EYES private');expect(JSON.stringify(payload)).not.toContain(run.outDir);
    });
});

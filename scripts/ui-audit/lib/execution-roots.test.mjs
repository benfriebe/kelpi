import { acceptanceVerdict } from './acceptance-verdict.mjs';
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { publicationPayload } from '../../acceptance-publish.mjs';
import { finalizeAcceptance } from '../../acceptance-report.mjs';
import { digest } from './acceptance-io.mjs';
import { inspectExecutionContext, inspectProvenance, captureOutputs } from './acceptance-provenance.mjs';
import { prepareTargetBuild, targetWorkspaceLinkErrors } from './execution-roots.mjs';
const temporary=[];
afterEach(()=>{for(const directory of temporary.splice(0))fs.rmSync(directory,{recursive:true,force:true});});
const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}}).trim();
async function fixture() {
    const base=fs.mkdtempSync(path.join(os.tmpdir(),'kelpi-two-roots-')); temporary.push(base);
    const harness=path.join(base,'harness'),target=path.join(base,'target');
    for(const root of [harness,target]) {
        fs.mkdirSync(path.join(root,'scripts/ui-audit/lib'),{recursive:true});
        fs.mkdirSync(path.join(root,'packages'),{recursive:true});
        fs.writeFileSync(path.join(root,'identity.txt'),root===harness?'HARNESS ONLY':'TARGET ONLY');
        fs.writeFileSync(path.join(root,'.gitignore'),'packages/*/dist/\nnode_modules/\npackages/*/node_modules/\n');
        git(root,['init','-q']);git(root,['config','user.name','fixture']);git(root,['config','user.email','fixture@example.invalid']);
    }
    for(const name of ['execution-roots.mjs','acceptance-provenance.mjs','acceptance-io.mjs'])fs.copyFileSync(new URL(name,import.meta.url),path.join(harness,'scripts/ui-audit/lib',name));
    for(const root of [harness,target]){git(root,['add','.']);git(root,['commit','-qm','isolated identity fixture']);}
    const api=await import(pathToFileURL(path.join(harness,'scripts/ui-audit/lib/execution-roots.mjs')));
    const context=api.captureExecutionRoots({harnessRoot:harness,targetRoot:target,harnessHead:git(harness,['rev-parse','HEAD']),targetHead:git(target,['rev-parse','HEAD'])});
    return {base,harness,target,api,context};
}
describe('separate pinned target and executing harness',()=>{
    it('binds different clean commits and detects edits to either side after selection',async()=>{
        const {harness,target,api,context}=await fixture();
        expect(context.harness.expectedHead).not.toBe(context.target.expectedHead);
        expect(inspectExecutionContext(context,{head:context.target.expectedHead,observation:api.observeExecutionRoots(context)})).toEqual([]);
        fs.writeFileSync(path.join(harness,'identity.txt'),'CHANGED HARNESS');
        expect(api.executionRootErrors(context,api.observeExecutionRoots(context))).toContain('harness execution source changed or is incomplete');
        fs.writeFileSync(path.join(target,'unexpected.mjs'),'untracked source');
        expect(api.executionRootErrors(context,api.observeExecutionRoots(context))).toContain('target execution source changed or is incomplete');
    });
    it('rejects wrong advertised heads, non-root directories, wrong harness and tampered context',async()=>{
        const {base,harness,target,api,context}=await fixture();
        const args={harnessRoot:harness,targetRoot:target,harnessHead:context.harness.expectedHead,targetHead:context.target.expectedHead};
        expect(()=>api.captureExecutionRoots({...args,targetHead:'0'.repeat(40)})).toThrow('target exact expected head');
        expect(()=>api.captureExecutionRoots({...args,targetRoot:path.join(target,'scripts')})).toThrow('checkout root');
        expect(()=>api.captureExecutionRoots({...args,harnessRoot:target})).toThrow('executing module');
        const file=path.join(base,'context.json');fs.writeFileSync(file,JSON.stringify(context));
        const config={contextPath:file,contextSha256:digest(fs.readFileSync(file))};
        expect(api.executionRoots(config).targetRoot).toBe(fs.realpathSync(target));
        expect(()=>api.executionRoots({...config,targetRoot:harness})).toThrow('target root differs');
        fs.appendFileSync(file,' ');expect(()=>api.executionRoots(config)).toThrow('digest differs');
    });
    it('detects a sibling workspace link and preserves prior outputs before a fresh build',async()=>{
        const {base,harness,target}=await fixture();
        for(const root of [harness,target])fs.mkdirSync(path.join(root,'packages/core'),{recursive:true});
        fs.mkdirSync(path.join(target,'node_modules/@kelpi'),{recursive:true});
        fs.symlinkSync(path.join(harness,'packages/core'),path.join(target,'node_modules/@kelpi/core'));
        expect(targetWorkspaceLinkErrors(target)).toHaveLength(1);
        fs.unlinkSync(path.join(target,'node_modules/@kelpi/core'));
        fs.symlinkSync(path.join(target,'packages/core'),path.join(target,'node_modules/@kelpi/core'));
        expect(targetWorkspaceLinkErrors(target)).toEqual([]);
        const dir=path.join(target,'packages/client/dist');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'poison.js'),'OLD OUTPUT');
        const kept=prepareTargetBuild(target,path.join(base,'evidence'));
        expect(fs.existsSync(dir)).toBe(false);expect(fs.readFileSync(path.join(kept[0].retained,'poison.js'),'utf8')).toBe('OLD OUTPUT');
    });
    it('rejects altered commit inputs even when Git assumes the file is unchanged',async()=>{
        const {harness,target,api,context}=await fixture();
        git(target,['update-index','--assume-unchanged','identity.txt']);
        fs.writeFileSync(path.join(target,'identity.txt'),'HIDDEN EDIT');
        expect(git(target,['status','--porcelain'])).toBe('');
        expect(()=>api.captureExecutionRoots({harnessRoot:harness,targetRoot:target,harnessHead:context.harness.expectedHead,targetHead:context.target.expectedHead})).toThrow('source bytes differ from exact commit');
    });
    it('refuses source substitution via symlinked runtime output',async()=>{
        const {base,target}=await fixture();
        fs.mkdirSync(path.join(target,'packages/client'),{recursive:true});
        const foreign=path.join(base,'foreign');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'index.html'),'foreign');
        fs.symlinkSync(foreign,path.join(target,'packages/client/dist'));
        expect(()=>captureOutputs(target,['packages/client/dist'])).toThrow('must not be a symlink');
        expect(()=>prepareTargetBuild(target,path.join(base,'evidence'))).toThrow('is a symlink');
    });
    it('cannot replace the executing harness while keeping a correct target build receipt',async()=>{
        const {api,context}=await fixture();
        const source=context.target.source,outputs=['client','daemon','cli','shell'].map(name=>({path:`packages/${name}/dist/main.js`,sha256:digest(name)}));
        const build={forced:true,inputManifestSha256:source.inputManifestSha256,outputs};
        const p={runId:'fixture',head:source.head,source,build,executedOutputs:outputs,complete:true,errors:[],runtimeBindings:[],trackedDiffSha256:source.trackedDiffSha256,buildHashes:Object.fromEntries(outputs.map(o=>[o.path,o.sha256])),executionContext:context,executionRoots:api.observeExecutionRoots(context)};
        const receipt={head:source.head,runId:'fixture',exitStatus:0,source,build,executionContext:context};
        expect(inspectProvenance(p,{head:source.head,buildReceipt:receipt})).toEqual([]);
        const changed=structuredClone(p);changed.executionContext.harness.expectedHead='0'.repeat(40);
        expect(inspectProvenance(changed,{head:source.head,buildReceipt:receipt})).toContain('runtime harness/target context differs from build receipt');
        const omitted=structuredClone(p);delete omitted.executionRoots;
        expect(inspectProvenance(omitted,{head:source.head,buildReceipt:receipt}).length).toBeGreaterThan(0);
    });
    it('refuses to finalize or publish another harness identity from this executing checkout',async()=>{
        const {base,target,context}=await fixture();
        const contextPath=path.join(base,'context.json');fs.writeFileSync(contextPath,JSON.stringify(context));
        const report={schemaVersion:2,scope:'commit',runId:'foreign-harness',start:context.target.state,executionContext:context,executionContextPath:contextPath,artifacts:[{path:contextPath,sha256:digest(fs.readFileSync(contextPath))}]};
        expect(()=>publicationPayload(report,{state:'open',head:{sha:context.target.expectedHead}})).toThrow('executing harness/target roots differ');
        const reportPath=path.join(base,'report.json');fs.writeFileSync(reportPath,JSON.stringify(report));
        expect(()=>finalizeAcceptance({root:target,reportPath,manifestPath:path.join(base,'unused.json'),outRoot:path.join(base,'unused-output')})).toThrow('executing harness/target roots differ');
        expect(fs.existsSync(path.join(base,'unused-output'))).toBe(false);
        const missing={...report};delete missing.executionContextPath;
        expect(()=>publicationPayload(missing,{state:'open',head:{sha:context.target.expectedHead}})).toThrow('context path is absent');
        fs.writeFileSync(reportPath,JSON.stringify(missing));
        expect(()=>finalizeAcceptance({root:target,reportPath,manifestPath:path.join(base,'unused.json'),outRoot:path.join(base,'unused-output')})).toThrow('context path is absent');
    });
    it('retains an unverified preflight report and launches no product when the requested head differs',async()=>{
        const {base,target}=await fixture();
        const out=path.join(base,'rejected-run');
        const command=[new URL('../../verify.mjs',import.meta.url).pathname,'--target-root',target,'--target-head','0'.repeat(40),'--harness-head','0'.repeat(40),'--since','HEAD','--out',out];
        const run=spawnSync(process.execPath,command,{encoding:'utf8',timeout:20_000});
        expect(run.status,run.stdout+run.stderr).toBe(2);
        const directory=path.join(out,fs.readdirSync(out)[0]);
        const report=JSON.parse(fs.readFileSync(path.join(directory,'acceptance.json')));
        expect(report.verdict).toBe('unverified');expect(report.schemaVersion).toBe(2);
        expect(report.reasons.join(' ')).toContain('target exact expected head differs');
        expect(report.components).toEqual([]);expect(report.buildReceiptPath).toBeUndefined();
        expect(fs.existsSync(path.join(target,'packages/client/dist'))).toBe(false);
    });
});

async function unitOnlyExternalRun() {
    const { base, api, context } = await fixture();
    const artifacts = [];
    const retain = (name, data) => {
        const file = path.join(base, name);
        fs.writeFileSync(file, JSON.stringify(data));
        artifacts.push({ path: file, sha256: digest(fs.readFileSync(file)) });
        return file;
    };
    const now = Date.now(), runId = 'unit-only-external';
    const selection = { kind: 'vitest', ordered: false, complete: true, members: [{ id: '/test.mjs', mode: 'assert', requiredAssertions: ['scoped assertion'], minAssertions: 1 }] };
    const raw = { startTime: now, success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [{ name: '/test.mjs', status: 'passed', assertionResults: [{ fullName: 'scoped assertion', status: 'passed' }] }] };
    const reportPath = retain('unit-results.json', raw);
    const execution = { command: 'vitest scoped', exitStatus: 0, startedAt: now, finishedAt: now };
    const executionPath = retain('execution.json', execution);
    const component = { label: 'scoped tests', kind: 'vitest', command: execution.command, reportPath,
        firstAttempt: { ok: true, verdict: 'verified', execution: { ...execution, path: executionPath }, evidence: { ...execution, kind: 'vitest', path: reportPath } } };
    const plan = { schemaVersion: 2, runId, head: context.target.expectedHead, reference: 'b'.repeat(40), executionContext: context, components: [{ label: component.label, kind: component.kind, command: component.command, reportPath, selection }] };
    const run = { schemaVersion: 2, scope: 'commit', runId, startedAt: new Date(now - 1000).toISOString(), start: context.target.state, end: context.target.state, reference: plan.reference,
        executionContext: context, executionContextPath: retain('context.json', context), executionEnd: api.observeExecutionRoots(context), planPath: retain('plan.json', plan), artifacts, components: [component] };
    return { run, plan, retain };
}

describe('external build receipts follow the frozen execution plan', () => {
    it('verifies a complete scoped test component without inventing a build requirement', async () => {
        const { run } = await unitOnlyExternalRun();
        const result = acceptanceVerdict(run, run);
        expect(result.assessments[0].verdict).toBe('verified');
        // The fixture supplies no incident reproduction. That separate requirement remains.
        expect(result.reasons).toEqual(['incident manifest with concrete reproduction evidence is required']);
    });
    it.each(['build', 'audit', 'scenario', 'smoke'])('still requires a retained build receipt for a planned %s component', async kind => {
        const { run, plan, retain } = await unitOnlyExternalRun();
        plan.components.push({ label: 'runtime', kind, command: 'run runtime' });
        run.planPath = retain('runtime-plan.json', plan);
        const result = acceptanceVerdict(run, run);
        expect(result.verdict).toBe('unverified');
        expect(result.reasons).toContain('required or declared build receipt is absent or invalid');
    });
    it('rejects a supplied build receipt from another context even for a unit-only plan', async () => {
        const { run, retain } = await unitOnlyExternalRun();
        const foreign = structuredClone(run.executionContext);
        foreign.harness.expectedHead = 'c'.repeat(40);
        run.buildReceiptPath = retain('foreign-build.json', { executionContext: foreign });
        const result = acceptanceVerdict(run, run);
        expect(result.verdict).toBe('unverified');
        expect(result.reasons).toContain('build receipt harness/target context differs from frozen run');
    });
    it('does not ignore an explicitly declared but unbound build receipt', async () => {
        const { run } = await unitOnlyExternalRun();
        run.buildReceiptPath = '/missing-build-receipt.json';
        const result = acceptanceVerdict(run, run);
        expect(result.verdict).toBe('unverified');
        expect(result.reasons).toContain('required or declared build receipt is absent or invalid');
    });
});

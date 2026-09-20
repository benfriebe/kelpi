#!/usr/bin/env node
/** Independent review-gap fixture. No desktop, builds, Git writes, or product behavior claims.
 * Run unchanged with KELPI_REGRESSION_ROOT and a fresh external KELPI_REGRESSION_REPORT.
 * Schema adapters and private I/O are documented at their boundaries below.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const hash = b => createHash('sha256').update(b).digest('hex');
const guard = (ok, message) => { if (!ok) throw new Error(message); };
const clone = structuredClone, assertions = [], errors = [], controls = [], observations = [], artifacts = [];
const cleanup = { attempted: false, completed: false, errors: [], leaks: [], privateRenderers: [] };
const contexts = [], sessions = [], pages = [], privateLinks = [];
const key = '__kelpiIncidentRecorder', allowed = ['SYNTHETIC_SELECTION'];
const startedAt = new Date().toISOString(), fixturePath = fileURLToPath(import.meta.url), fixtureHash = hash(fs.readFileSync(fixturePath));
let root, output, outputFD, artifactDir, before, after, source, sourceAfter, scenarioPlan, auditPlan, inspectResults, captureSource, captureOutputs, inspectProvenance, recorder, arm;
const names = ['scenario-plan-rejects-copy-paste-setup-only', 'scenario-plan-retains-checks-after-nested-callback-return', 'scenario-eyes-hidden-screenshots-require-visual-review', 'partial-recorder-acquisition-retains-failed-undo-ownership', 'scenario-runner-rejects-between-scenario-core-output-drift', 'audit-source-visual-requirement-survives-raw-marker-omission'];
function git(...args) { return execFileSync('git', ['--no-optional-locks', ...args], {cwd:root,encoding:'utf8'}); }
function identity() { return { head:git('rev-parse','HEAD').trim(), dirtyFiles:git('status','--porcelain=v1','--untracked-files=all').split('\n').filter(Boolean) }; }
function outside(parent, child) { const rel=path.relative(parent,child); return rel.startsWith('..'+path.sep)||path.isAbsolute(rel); }
function err(phase,e) { errors.push({kind:'infrastructure/import/control',phase,message:String(e.stack??e)}); }
function check(name,ok,detail) { assertions.push({name,ok:ok===true,detail}); }
function put(rel,data) { const file=path.join(artifactDir,rel); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data,null,2)+'\n',{flag:'wx'}); return file; }
async function test(name,fn) { try { await fn(); } catch(e) { err(name,e); } }
const clean = () => ({attempted:true,completed:true,errors:[],leaks:[]});
// Independent literal-label inventory, NOT the product planner. Includes conditional/error labels
// as synthetic passing observations; never claims those product paths really executed.
function literals(file,method) {
 const text=fs.readFileSync(file,'utf8');
 const re=new RegExp('rec\\.'+method+'\\(\\s*(\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*"|`(?:\\\\.|[^`\\\\])*`)','g');
 return [...new Set([...text.matchAll(re)].map(m=>m[1]).filter(s=>!s.startsWith('`')||!s.includes('${')).map(s=>vm.runInNewContext(s,Object.create(null),{timeout:1000})))];
}
function selected(id) { const file=path.join(root,'scripts/scenarios',id+'.mjs'); return {file,plan:scenarioPlan(root,[file]),labels:literals(file,'check')}; }
// Explicit acceptance schema adapter: real clean source, private synthetic output bytes and a
// synthetic forced-build receipt. This tests inspection, not a build or application execution.
function provenanceFixture(plan) {
 const runId=randomUUID(), now=Date.now();
 const outputs=['client','daemon','cli','shell'].map(pkg=>({path:`packages/${pkg}/dist/fixture.js`,sha256:hash('private output '+pkg)}));
 for(const o of outputs) { const p=path.join(artifactDir,'provenance-output',o.path); if(!fs.existsSync(p)) put(path.relative(artifactDir,p),'private output '+o.path.split('/')[1]); guard(hash(fs.readFileSync(p))===o.sha256,'private output hash mismatch'); }
 const build={inputManifestSha256:source.inputManifestSha256,outputs,forced:true};
 const receipt={runId,head:source.head,source:clone(source),exitStatus:0,build:clone(build),fixtureOnly:true};
 const p={runId,head:source.head,requestedHead:source.head,startedAt:new Date(now).toISOString(),dirtyFiles:[],source:clone(source),build:clone(build),executedOutputs:clone(outputs),trackedDiffSha256:source.trackedDiffSha256,buildHashes:Object.fromEntries(outputs.map(o=>[o.path,o.sha256])),complete:true,errors:[],runtimeBindings:[]};
 for(const id of plan.runtimeRequirements??[]) p.runtimeBindings.push({id,complete:true,errors:[],source:clone(source),build:clone(build),executedOutputs:clone(outputs),fixtureOnly:true});
 const opts={runId,head:source.head,startedAt:now,selection:plan,buildReceipt:receipt};
 guard(inspectProvenance(p,opts).length===0,'synthetic provenance rejected by real provenance validator');
 return {p,receipt,opts};
}
function reportFor(s, p, labels=s.labels) { return {files:[s.file],selection:clone(s.plan),provenance:clone(p),cleanup:clean(),leaks:[],summaries:[{name:s.plan.members[0].id,checks:labels.length,failed:0,results:labels.map(label=>({label,ok:true})),notes:[]}]}; }
function verifiedControl(name,raw,opts) { const result=inspectResults('scenario',raw,opts); guard(result.verdict==='verified',name+': '+JSON.stringify(result)); controls.push({name,ok:true,result}); return result; }
// VM owns every document, clipboard, terminal, listener and script below. Actual product
// installRendererRecorder source is evaluated by actual armIncidentDiagnostics via page.eval.
function renderer(label,{failAdd,failRemove}={}) {
 let ctx, selection='', faults=true;
 const listeners=new Map(),addAttempts=[],removeAttempts=[];
 const terminal={write(){},reset(){selection='';},clear(){selection='';},resize(){},select(){selection=allowed[0];},clearSelection(){selection='';},getSelection(){return selection;}};
 const clipboard={readText(){return Promise.resolve(allowed[0]);},writeText(){}};
 const originals={terminal:Object.getOwnPropertyDescriptors(terminal),clipboard:Object.getOwnPropertyDescriptors(clipboard)};
 const document={activeElement:{tagName:'TEXTAREA',getAttribute:()=>null},visibilityState:'visible',body:{dataset:{}},hasFocus:()=>true,querySelectorAll:()=>[],
  addEventListener(type,fn){addAttempts.push(type);if(faults&&type===failAdd)throw Error('SYNTHETIC_ADD_FAILURE');if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
  removeEventListener(type,fn){removeAttempts.push(type);if(faults&&type===failRemove)throw Error('SYNTHETIC_REMOVE_FAILURE');listeners.get(type)?.delete(fn);if(!listeners.get(type)?.size)listeners.delete(type);}};
 ctx=vm.createContext({document,navigator:{clipboard},terminalLab:{terminal},performance});vm.runInContext('globalThis.top=globalThis',ctx);
 const sameMethods=()=>['terminal','clipboard'].every(type=>Object.entries(originals[type]).every(([n,d])=>(type==='terminal'?terminal:clipboard)[n]===d.value));
 const h={label,listeners,addAttempts,removeAttempts,terminal,clipboard,sameMethods,
  eval:async code=>vm.runInContext(code,ctx,{timeout:3000}), count:()=>[...listeners.values()].reduce((n,s)=>n+s.size,0),
  emit(type){for(const fn of listeners.get(type)??[])fn({type,isTrusted:true,code:'KeyC'});},
  async release(){const residual=h.count();faults=false;
   // Do not rely on the product undo stack or handle: restore EACH private object independently.
   for(const [type,fns] of [...listeners])for(const fn of [...fns])document.removeEventListener(type,fn);
   Object.defineProperties(terminal,originals.terminal);Object.defineProperties(clipboard,originals.clipboard);
   vm.runInContext(`delete globalThis[${JSON.stringify(key)}]`,ctx);
   guard(h.count()===0&&sameMethods()&&!vm.runInContext(`Boolean(globalThis[${JSON.stringify(key)}])`,ctx),'private object restoration failed');
   ctx=null;cleanup.privateRenderers.push({label,residualListenersBeforeFixtureTeardown:residual,listenersAfter:0,originalMethodsRestored:true,handleDeleted:true,contextReleased:true});
  }};contexts.push(h);return h;
}
function pageFor(h) { const scripts=new Map();let next=0;
 const page={eval:h.eval,async send(method,args){if(method==='Page.enable')return {};if(method==='Page.addScriptToEvaluateOnNewDocument'){const identifier='private-'+(++next);scripts.set(identifier,args.source);return {identifier};}if(method==='Page.removeScriptToEvaluateOnNewDocument'){guard(scripts.delete(args.identifier),'unowned script deletion');return {};}throw Error('unsupported private CDP: '+method);}};
 const p={page,scripts};pages.push(p);return p;
}
async function recorderTests() {
 const h=renderer('healthy'),p=pageFor(h),rec=recorder({name:'healthy',outDir:path.join(artifactDir,'recorder/healthy')});
 const s=await arm({page:p.page,rec,allowed,capacity:128});sessions.push(s);
 guard(h.count()>0&&!h.sameMethods(),'healthy recorder did not acquire listeners/wrappers');h.terminal.select();h.emit('copy');
 await s.freeze('healthy-control');await s.close();
 const evidence=JSON.parse(fs.readFileSync(path.join(rec.outDir,'healthy-first-incident.json')));
 guard(evidence.complete&&evidence.renderers.some(r=>r.events.some(e=>e.kind==='copy'))&&h.count()===0&&h.sameMethods()&&p.scripts.size===0,'healthy recorder capture/cleanup failed');
 controls.push({name:'recorder-full-acquisition-capture-and-restore',ok:true,evidence});
 const bad=renderer('partial-undo',{failAdd:'copy',failRemove:'keydown'}),bp=pageFor(bad),br=recorder({name:'partial-undo',outDir:path.join(artifactDir,'recorder/partial-undo')});
 let rejected;try{const unexpected=await arm({page:bp.page,rec:br,allowed,capacity:128});sessions.push(unexpected);}catch(e){rejected=String(e);}
 guard(rejected?.includes('SYNTHETIC_ADD_FAILURE')&&bad.addAttempts.indexOf('copy')>0&&bad.removeAttempts.includes('keydown'),'combined acquisition/undo fault not reached');
 const retainedCleanup=JSON.parse(fs.readFileSync(path.join(br.outDir,'partial-undo-incident-cleanup.json')));
 const owner=await bad.eval(`globalThis[${JSON.stringify(key)}] ? {ownerId:globalThis[${JSON.stringify(key)}].ownerId,generation:globalThis[${JSON.stringify(key)}].generation} : null`);
 const failures=br.results.filter(r=>r.ok===false&&r.failureClass==='cleanup');
 const detail={rejected,residualListeners:bad.count(),remainingTypes:[...bad.listeners.keys()],owner,cleanupFailures:failures,retainedCleanup,addAttempts:bad.addAttempts,removeAttempts:bad.removeAttempts};
 const retainedFailure=failures.length>0&&JSON.stringify({failures,retainedCleanup}).includes('SYNTHETIC_REMOVE_FAILURE');
 check(names[3],retainedFailure&&(bad.count()===0||Boolean(owner?.ownerId))&&!(bad.count()>0&&retainedCleanup.some(c=>c.contextReplaced===true)),detail);
 put('recorder/partial-undo-observation.json',detail);
}
async function runtimeTests() {
 const mirror=path.join(artifactDir,'runtime/source');fs.mkdirSync(mirror,{recursive:true});
 // Read-only identity adapter: copy every tracked source byte; Git queries in the child
 // explicitly use the supplied root's Git directory/work tree. No init/add/commit occurs.
 // The product reads/hashes MIRROR bytes and private ignored outputs; source-copy integrity
 // is checked before and after. Generated seam scenarios are separately hashed evidence.
 for(const input of source.inputs){const target=path.join(mirror,input.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,input.path),target);guard(hash(fs.readFileSync(target))===input.sha256,'mirror copy hash mismatch');}
 const links=[];
 for(const rel of ['node_modules','packages/client/node_modules']) {const from=path.join(root,rel);guard(fs.existsSync(from),'locked dependency directory missing: '+rel);const to=path.join(mirror,rel);fs.symlinkSync(from,to,'dir');links.push(to);privateLinks.push(to);}
 const operations=put('runtime/operations.jsonl',''), original='export const value="original bytes";\n', changed='export const value="changed bytes";\n';
 const runtimeFile=path.join(mirror,'packages/daemon/dist/runner.mjs');
 for(const [pkg,name] of [['client','index.html'],['daemon','kelpid.js'],['cli','kelpi.js'],['shell','main.js']]) put('runtime/source/packages/'+pkg+'/dist/'+name,'private fixture '+pkg);
 put('runtime/source/packages/daemon/dist/runner.mjs',original);
 const first=put('runtime/first.mjs',`import fs from 'node:fs';import path from 'node:path';export default async({rec,repoRoot})=>{if(process.env.KELPI_PRIVATE_DRIFT==='true')fs.writeFileSync(path.join(repoRoot,'packages/daemon/dist/runner.mjs'),${JSON.stringify(changed)});fs.appendFileSync(${JSON.stringify(operations)},JSON.stringify({first:true,drift:process.env.KELPI_PRIVATE_DRIFT==='true'})+'\\n');rec.check('first scenario body',true);};\n`);
 const second=put('runtime/second.mjs',`import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';export default async({rec,repoRoot})=>{const actual=await import(pathToFileURL(path.join(repoRoot,'packages/daemon/dist/runner.mjs')));fs.appendFileSync(${JSON.stringify(operations)},JSON.stringify({second:true,value:actual.value})+'\\n');rec.note('Executed private runtime value: '+actual.value);rec.check('runtime module executed',actual.value===(process.env.KELPI_PRIVATE_DRIFT==='true'?'changed bytes':'original bytes'));};\n`);
 const outputs=captureOutputs(mirror),runId=randomUUID();
 const receipt={runId,head:source.head,source:clone(source),exitStatus:0,build:{inputManifestSha256:source.inputManifestSha256,outputs,forced:true},fixtureOnly:true};
 const receiptFile=put('runtime/synthetic-build-receipt.json',receipt);
 const realDriver=pathToFileURL(path.join(mirror,'scripts/ui-audit/lib/driver.mjs')).href;
 const driverFile=put('runtime/driver-adapter.mjs',`import fs from 'node:fs';export {recorder,WINDOW_PLACEMENTS} from ${JSON.stringify(realDriver+'?actual')};export async function boot({window,beforeStart}){await beforeStart?.();fs.appendFileSync(${JSON.stringify(operations)},JSON.stringify({boot:true})+'\\n');return {page:{eval:async()=>JSON.stringify({workbench:{},phonePlace:null,phoneLanding:null,overlays:[],viewport:'800x600',url:'private',hasFocus:true})},sandbox:{base:'private'},harness:{path:'private'},windowPlacement:window,rendererErrors:{finish(rec){rec.check('renderer clean',true);}},stop:async()=>{fs.appendFileSync(${JSON.stringify(operations)},JSON.stringify({stop:true})+'\\n');}};};\n`);
 const slotFile=put('runtime/slot-adapter.mjs',`import fs from 'node:fs';export const DESKTOP_TEST_PORT=19735;export async function holdDesktopTestSlot(){fs.appendFileSync(${JSON.stringify(operations)},JSON.stringify({slot:true})+'\\n');return {release:async()=>{fs.appendFileSync(${JSON.stringify(operations)},JSON.stringify({release:true})+'\\n');}};};\n`);
 const hook=put('runtime/hooks.mjs',`import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){if(s.endsWith('/desktop-slot.mjs'))return {url:${JSON.stringify(pathToFileURL(slotFile).href)},shortCircuit:true};if(s===${JSON.stringify(path.join(mirror,'scripts/ui-audit/lib/driver.mjs'))})return {url:${JSON.stringify(pathToFileURL(driverFile).href)},shortCircuit:true};return next(s,c);}});\n`);
 const selection=scenarioPlan(mirror,[first,second]);
 const gitDir=git('rev-parse','--absolute-git-dir').trim();
 const cases=[];
 try {
  for(const drift of [false,true]) {
   fs.writeFileSync(runtimeFile,original);
   const label=drift?'drift':'healthy',outDir=path.join(artifactDir,'runtime',label),start=Date.now(),offset=fs.statSync(operations).size;
   const args=['--import',hook,path.join(mirror,'scripts/scenario.mjs'),'--no-build','--window','hidden','--out',outDir,first,second];
   const child=spawnSync(process.execPath,args,{cwd:mirror,env:{...process.env,NODE_OPTIONS:'',GIT_DIR:gitDir,GIT_WORK_TREE:root,GIT_OPTIONAL_LOCKS:'0',KELPI_ACCEPTANCE_RUN_ID:runId,KELPI_ACCEPTANCE_HEAD:source.head,KELPI_ACCEPTANCE_BUILD_RECEIPT:receiptFile,KELPI_ACCEPTANCE_BUILD_SHA256:hash(fs.readFileSync(receiptFile)),KELPI_PRIVATE_DRIFT:String(drift)},encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
   put('runtime/'+label+'.stdout.log',child.stdout??'');put('runtime/'+label+'.stderr.log',child.stderr??'');
   guard(!child.error&&!child.signal,'runtime child failed/timed out: '+String(child.error??child.signal));
   const reportPath=path.join(outDir,'results.json');guard(fs.existsSync(reportPath),'runtime child did not retain a structured report');
   const raw=JSON.parse(fs.readFileSync(reportPath)),assessed=inspectResults('scenario',raw,{runId,head:source.head,startedAt:start,selection,buildReceipt:receipt,exitStatus:child.status});
   const ops=fs.readFileSync(operations,'utf8').slice(offset).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
   guard(ops.some(o=>o.boot)&&ops.some(o=>o.first)&&ops.filter(o=>o.slot).length===ops.filter(o=>o.release).length&&ops.filter(o=>o.boot).length===ops.filter(o=>o.stop).length,'private lifecycle not exercised/released');
   const actualHash=hash(fs.readFileSync(runtimeFile)),recordedHash=raw.provenance?.buildHashes?.['packages/daemon/dist/runner.mjs'];
   const detail={exitStatus:child.status,result:assessed,operations:ops,actualOutputSha256:actualHash,recordedOutputSha256:recordedHash,resultPath:reportPath};cases.push(detail);
   if(!drift){guard(child.status===0&&assessed.verdict==='verified'&&actualHash===recordedHash&&ops.some(o=>o.second&&o.value==='original bytes'),'healthy actual runner/inspector control failed: '+JSON.stringify(detail));controls.push({name:'runtime-original-output-bytes-execute-and-verify',ok:true,...detail});}
   else {
    guard(actualHash===hash(changed)&&ops.some(o=>o.first&&o.drift),'between-scenario mutation was not reached');
    const changedExecuted=ops.some(o=>o.second&&o.value==='changed bytes');
    if(!changedExecuted)guard(/(?:output|build|runtime|provenance).*(?:differ|chang|mismatch)|(?:differ|chang|mismatch).*(?:output|build|runtime|provenance)/is.test(JSON.stringify(raw)+(child.stderr??'')),'second scenario stopped for an unrelated reason');
    check(names[4],!(changedExecuted&&assessed.verdict==='verified'),{...detail,changedExecuted});
   }
  }
 } finally {
  fs.writeFileSync(runtimeFile,original);
  for(const link of links)fs.unlinkSync(link);
  for(const input of source.inputs)guard(hash(fs.readFileSync(path.join(mirror,input.path)))===input.sha256,'private source mirror mutated: '+input.path);
 }
 observations.push({name:'runtime-adapters',details:'Unchanged tracked source mirror; read-only Git identity queried against supplied root using GIT_DIR/GIT_WORK_TREE; actual provenance hashes mirror inputs and private outputs. Only desktop driver boot and desktop slot are replaced; real recorder, runner, planner, inspector and lifecycle execute. Fixture scenarios mutate/import private runner.mjs; no product Copy/paste scenario executes.',cases});
}
try {
 guard(process.argv.length===2,'fixture takes no CLI arguments');
 guard(typeof process.env.KELPI_REGRESSION_ROOT==='string'&&process.env.KELPI_REGRESSION_ROOT,'KELPI_REGRESSION_ROOT required');
 guard(typeof process.env.KELPI_REGRESSION_REPORT==='string'&&path.isAbsolute(process.env.KELPI_REGRESSION_REPORT),'fresh absolute KELPI_REGRESSION_REPORT required');
 root=fs.realpathSync(process.env.KELPI_REGRESSION_ROOT);
 guard(fs.realpathSync(git('rev-parse','--show-toplevel').trim())===root,'supply actual repository root');
 output=path.join(fs.realpathSync(path.dirname(process.env.KELPI_REGRESSION_REPORT)),path.basename(process.env.KELPI_REGRESSION_REPORT));
 guard(outside(root,output),'report must be external to source checkout');artifactDir=output+'.artifacts';
 guard(!fs.existsSync(output)&&!fs.existsSync(artifactDir),'refusing existing report/evidence');outputFD=fs.openSync(output,'wx');fs.mkdirSync(artifactDir);
 before=identity();guard(before.dirtyFiles.length===0,'requires clean supplied checkout');
 const mod=n=>import(pathToFileURL(path.join(root,'scripts/ui-audit/lib',n+'.mjs')).href);
 ({captureSource,captureOutputs,inspectProvenance}=await mod('acceptance-provenance'));source=captureSource(root);
 put('fixture.mjs',fs.readFileSync(fixturePath));put('source-before.json',{root,...before,source});
 ({scenarioPlan,auditPlan}=await mod('incident-diagnostics-plan'));({inspectResults}=await mod('acceptance-results'));({recorder}=await mod('driver'));({armIncidentDiagnostics:arm}=await mod('incident-diagnostics'));
 for(const [id,name,kept] of [
  ['terminal-copy-paste-chords',names[0],'a workspace of its own to copy in'],
  ['plugin-document-features',names[1],'native markdown attaches to a real isolated SDK-only renderer']
 ]) await test(name,async()=>{
  const s=selected(id);guard(s.labels.includes(kept)&&s.labels.length>5,'supplied scenario literal-label contract changed');
  const f=provenanceFixture(s.plan),full=reportFor(s,f.p);verifiedControl(id+'-full-selection',full,f.opts);
  const reduced=reportFor(s,f.p,[kept]),result=inspectResults('scenario',reduced,f.opts);
  check(name,result.verdict!=='verified',{selection:s.plan,kept,omitted:s.labels.filter(n=>n!==kept),result});
  put(id+'/full-report.json',full);put(id+'/reduced-report.json',reduced);put(id+'/receipt.json',f.receipt);
 });
 await test(names[2],async()=>{
  const noVisual=selected('terminal-copy-paste-chords'),nf=provenanceFixture(noVisual.plan);
  verifiedControl('scenario-no-visual-requirements',reportFor(noVisual,nf.p),nf.opts);
  const s=selected('plugin-terminal-geometry'),f=provenanceFixture(s.plan);
  const rec=recorder({name:'plugin-terminal-geometry',outDir:path.join(artifactDir,'visual'),placement:'hidden'});
  for(const label of s.labels)rec.check(label,true);
  // Retain the baseline EYES convention independently of any later explicit recorder API.
  const eyes=literals(s.file,'note').filter(n=>/^EYES\b/.test(n));guard(eyes.length>0,'supplied geometry source has no EYES obligations');
  for(let i=0;i<eyes.length;i++){
   await rec.shot({screenshot:async file=>fs.writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=','base64'),{flag:'wx'})},'private-blank-'+i);
   rec.note(eyes[i]);
  }
  const raw=reportFor(s,f.p);raw.windowPlacement='hidden';raw.summaries=[rec.summary()];
  // Mechanical schema adapter: if available, rec.eyes registers the SAME source requirements.
  // Raw EYES strings above always remain; absence of an API is never itself a failed assertion.
  if(typeof rec.eyes==='function'){for(const note of eyes)rec.eyes(note);raw.summaries=[rec.summary()];}
  guard(raw.summaries[0].notes.some(n=>n.includes('BLANK')&&n.includes('hidden')),'real recorder did not emit hidden screenshot observation');
  const result=inspectResults('scenario',raw,f.opts);
  guard(result.failures.length===0&&result.missing.every(reason=>/visual|eyes|screenshot|review/i.test(reason)),'visual case rejected for an unrelated control/schema reason: '+JSON.stringify(result));
  check(names[2],result.verdict!=='verified',{result,sourceVisualRequirements:eyes,notes:raw.summaries[0].notes,explicitEyesAdapter:typeof rec.eyes==='function'});
  put('visual/raw-report.json',raw);put('visual/receipt.json',f.receipt);
 });
 await test(names[5],async()=>{
  const plan=auditPlan(root,['workspace-switch','renderer-console']),f=provenanceFixture(plan);
  const auditSource=fs.readFileSync(path.join(root,'scripts/ui-audit/audit.mjs'),'utf8');
  guard(/id:\s*['"]workspace-switch['"][\s\S]{0,500}needsEyes:\s*true/.test(auditSource),'actual audit visual source declaration changed');
  const raw={provenance:f.p,cleanup:clean(),selection:clone(plan),steps:plan.members.map(m=>({id:m.id,assertions:m.requiredAssertions.map(name=>({name,ok:true}))})),summary:{total:2,assertions:plan.members.reduce((n,m)=>n+m.requiredAssertions.length,0),failedAssertions:0,errored:0,eyes:1}};
  raw.steps[0].needsEyes=true;raw.steps[0].shots=[put('audit-visual/private-shot.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=','base64'))];
  const pending=inspectResults('audit',raw,f.opts),reviewed=inspectResults('audit',raw,{...f.opts,approvedVisuals:['workspace-switch']});
  guard(pending.verdict==='unverified'&&pending.missing.every(reason=>/visual|eyes|review/i.test(reason))&&reviewed.verdict==='verified','audit pending/reviewed controls failed: '+JSON.stringify({pending,reviewed}));
  controls.push({name:'audit-declared-visual-pending-and-approved',ok:true,pending,reviewed});
  const omitted=clone(raw);delete omitted.steps[0].needsEyes;omitted.summary.eyes=0;
  const result=inspectResults('audit',omitted,f.opts);
  guard(result.failures.length===0&&result.missing.every(reason=>/visual|eyes|review/i.test(reason)),'audit visual omission rejected for an unrelated reason: '+JSON.stringify(result));
  check(names[5],result.verdict!=='verified',{selection:plan,result});
  put('audit-visual/raw-report.json',raw);put('audit-visual/omitted-report.json',omitted);put('audit-visual/receipt.json',f.receipt);
 });
 await test(names[3],recorderTests);
 await test(names[4],runtimeTests);
} catch(e) {err('setup',e);}
finally {
 cleanup.attempted=true;
 for(const link of privateLinks)try{if(fs.existsSync(link))fs.unlinkSync(link);}catch(e){cleanup.errors.push(String(e));cleanup.leaks.push('private dependency link '+link);}
 for(const s of sessions)try{await s.close();}catch(e){cleanup.errors.push(String(e.stack??e));}
 for(const h of contexts)try{await h.release();}catch(e){cleanup.errors.push(String(e.stack??e));cleanup.leaks.push('private renderer '+h.label);}
 for(const p of pages)for(const identifier of [...p.scripts.keys()])try{await p.page.send('Page.removeScriptToEvaluateOnNewDocument',{identifier});}catch(e){cleanup.errors.push(String(e));cleanup.leaks.push('private navigation script');}
 contexts.length=0;sessions.length=0;pages.length=0;
 cleanup.completed=cleanup.errors.length===0&&cleanup.leaks.length===0;
 if(!cleanup.completed)err('teardown',Error('fixture-owned resource cleanup failed'));
 if(root&&before&&source)try{after=identity();sourceAfter=captureSource(root);guard(JSON.stringify(before)===JSON.stringify(after)&&JSON.stringify(source)===JSON.stringify(sourceAfter),'source identity changed during run');guard(hash(fs.readFileSync(fixturePath))===fixtureHash,'fixture source changed during run');put('source-after.json',{root,...after,source:sourceAfter});}catch(e){err('source-immutability',e);}
}
if(!errors.length)for(const name of names)if(assertions.filter(a=>a.name===name).length!==1)err('coverage',Error('named assertion not evaluated exactly once: '+name));
function inventory(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())inventory(file);else if(entry.isSymbolicLink())throw Error('unreleased private symlink: '+file);else artifacts.push({path:file,bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))});}}
try{if(artifactDir&&fs.existsSync(artifactDir))inventory(artifactDir);}catch(e){err('artifact-inventory',e);}
const exitCode=errors.length?2:assertions.some(a=>!a.ok)?1:0;
const report={schemaVersion:1,startedAt,finishedAt:new Date().toISOString(),assertions,errors,controls,observations,cleanup,
 environment:{id:`${os.hostname()}:${process.platform}:${process.arch}:${process.version}`,kind:'local',details:'Private Node VM/CDP and runner fixtures importing/executing actual supplied code; explicit synthetic build receipts, screenshots and desktop I/O. No Electron, OS clipboard, daemon, builds, Git writes, installed app, networking or physical devices.'},
 fixture:{path:fixturePath,sha256:fixtureHash,args:[]},source:{root,before,after,inputManifestSha256:source?.inputManifestSha256},artifacts,
 limitations:['Inspector reports use explicit synthetic successful observations, not proof of actual product scenario behavior.','Private runtime seam uses an unchanged source mirror and read-only Git identity adapter; it proves byte binding in the real runner, not daemon behavior.','All adverse observations are recorded before independent private-object teardown.','Only the coordinator can establish final frozen baseline/candidate acceptance.']};
if(outputFD!==undefined){try{fs.writeFileSync(outputFD,JSON.stringify(report,null,2)+'\n');fs.closeSync(outputFD);}catch(e){console.error(e);process.exitCode=2;}}else console.error(JSON.stringify({errors,reportWritten:false}));
console.log(JSON.stringify({reportPath:outputFD===undefined?null:output,fixtureHash,assertions:assertions.map(({name,ok})=>({name,ok})),errors,exitCode}));process.exitCode??=exitCode;

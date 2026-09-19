#!/usr/bin/env node
/** Immutable, self-contained acceptance regression for verifier/battery defects only.
 * --repo ROOT --out REPORT or KELPI_REGRESSION_ROOT/KELPI_REGRESSION_REPORT.
 * Runs source bytes unchanged in a VM; only filesystem, git, process, and build I/O are substituted.
 * Never starts Electron, daemon, pnpm, or an audit. Never certifies pairing, Copy or paste incidents.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import {execFileSync,spawnSync} from 'node:child_process';
const args=process.argv.slice(2), value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
if(typeof vm.SourceTextModule!=='function'){
 const child=spawnSync(process.execPath,['--experimental-vm-modules',url.fileURLToPath(import.meta.url),...args],{env:process.env,stdio:'inherit'});
 process.exit(child.status??2);
}
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const assertions=[],errors=[],observations=[],sources={};let root,output,head,dirty;
const check=(name,ok,detail)=>assertions.push({name,ok:ok===true,detail});
const guard=(condition,message)=>{if(!condition)throw new Error(message);};
const fixture={
 scenario:{name:'plugin-terminal-features',checks:1,failed:0,results:[{label:'remote platform Copy resolves the remote renderer selection',ok:true}]},
 audit:{id:'phone-shell',assertions:[{name:'the new pane attaches at one grid and stays there: its rows never change across the switch, and no paint hold timed out',ok:true}]},
 cleanupLeak:{name:'plugin-terminal-features',leaked:['persisted plugin workbench slot remains after cleanup']}
};
const clone=v=>JSON.parse(JSON.stringify(v));
class Exit extends Error{constructor(code){super('exit '+code);this.code=code;}}
async function execute(spec){
 const virtual='/harness/repo',files=new Map(),dirs=new Set([virtual+'/docs',virtual+'/scripts']),reads=[],commands=[],logs=[],writeAttempts=[];let laneRuns=0;
 const protect=p=>{guard(String(p).startsWith(virtual+'/'),'unexpected VM path: '+p);return String(p);};
 const mkdir=p=>{protect(p);let x=p;while(x.startsWith(virtual+'/')){dirs.add(x);x=path.dirname(x);}};
 const memfs={
  existsSync:p=>{protect(p);return files.has(p)||dirs.has(p);},
  realpathSync:p=>{guard(p===virtual||String(p).startsWith(virtual+'/'),'unexpected VM realpath');return String(p);},
  readdirSync:(p,options)=>{protect(p);const names=[...new Set([...dirs,...files.keys()].filter(x=>path.dirname(x)===p).map(x=>path.basename(x)))].sort();return options?.withFileTypes?names.map(name=>({name,isDirectory:()=>dirs.has(p+'/'+name),isFile:()=>files.has(p+'/'+name),isSymbolicLink:()=>false})):names;},
  readFileSync:(p,encoding)=>{protect(p);reads.push(p);if(!files.has(p))throw Object.assign(new Error('ENOENT: '+p),{code:'ENOENT'});const b=Buffer.from(files.get(p));return encoding?b.toString():b;},
  mkdirSync:p=>mkdir(p),
  rmSync:p=>{protect(p);for(const k of [...files.keys(),...dirs])if(k===p||k.startsWith(p+'/')){files.delete(k);dirs.delete(k);}},
  writeFileSync:(p,v,options)=>{protect(p);writeAttempts.push(p);if(spec.writeFailure&&['acceptance.json','verify-report.json'].includes(path.basename(p)))throw Object.assign(new Error('AUDIT_FIXTURE_REPORT_WRITE_DENIED'),{code:'EACCES'});if(options?.flag==='wx'&&files.has(p))throw new Error('EEXIST');mkdir(path.dirname(p));files.set(p,Buffer.from(v));},
  statSync:p=>{protect(p);if(!files.has(p)&&!dirs.has(p))throw new Error('ENOENT');return {mtimeMs:Date.now(),size:files.has(p)?files.get(p).length:0,isFile:()=>files.has(p),isDirectory:()=>dirs.has(p)};},
  renameSync:(a,b)=>{protect(a);protect(b);files.set(b,files.get(a));files.delete(a);}
 };
 const put=(p,d)=>{mkdir(path.dirname(p));files.set(p,Buffer.from(JSON.stringify(d)));};
 function git(argv){
  if(argv[0]==='rev-parse')return head+'\n';
  if(argv[0]==='status')return dirty.join('\n');
  if(argv[0]==='ls-files'||argv[0]==='diff')return '';
  throw new Error('unexpected VM git command '+JSON.stringify(argv));
 }
 const cp={execSync:cmd=>{guard(cmd.startsWith('git '),'unexpected shell command');return git(cmd.slice(4).split(' '));},execFileSync:(exe,argv)=>{guard(exe==='git','unexpected execFileSync');return git(argv);},spawnSync:(exe,argv,options)=>{
  guard(exe==='sh'&&argv[0]==='-c','unexpected spawned command');const cmd=argv[1];commands.push(cmd);
  const provenance={runId:options.env.KELPI_ACCEPTANCE_RUN_ID??'legacy',head:options.env.KELPI_ACCEPTANCE_HEAD??head,requestedHead:head,dirtyFiles:[],startedAt:new Date().toISOString(),buildHashes:{fixture:digest(JSON.stringify(fixture))}};
  const cleanup={attempted:true,completed:true,errors:[],leaks:[]};
  if(cmd.includes('vitest run')||cmd.includes('@kelpi/shell test')){
   const m=cmd.match(/--outputFile.json='([^']+)'/);guard(!!m,'vitest report argument absent');
   if(!spec.missingReports)put(m[1],{startTime:Date.now(),success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numFailedTestSuites:0,numRuntimeErrorTestSuites:0,testResults:[{name:virtual+'/named.test.ts',status:'passed',assertionResults:[{fullName:'healthy control invariant',status:'passed'}]}]});
  }else if(cmd.includes('scripts/scenario.mjs')){
   laneRuns++;const m=cmd.match(/--out '([^']+)'/);guard(!!m,'scenario output argument absent');
   const summary=clone(fixture.scenario);let status=0;
   if((spec.retry&&laneRuns===1)||spec.forgedScenario){summary.results[0].ok=false;summary.failed=spec.forgedScenario?0:1;status=spec.forgedScenario?0:1;}
   const leaks=spec.leak?[clone(fixture.cleanupLeak)]:[];
   if(!spec.missingReports)put(m[1]+'/results.json',{stamp:new Date().toISOString(),windowPlacement:'hidden',files:[],provenance,cleanup,summaries:[summary],leaks});return {status};
  }else if(cmd.includes('scripts/ui-audit/audit.mjs')){
   const m=cmd.match(/--out (?:'([^']+)'|([^ ]+))/);guard(!!m,'audit output argument absent');const out=m[1]??m[2];const target=path.isAbsolute(out)?out:virtual+'/'+out;
   const step=clone(fixture.audit);if(spec.auditFailure)step.assertions[0].ok=false;
   if(!spec.missingReports)put(target+'/results.json',{meta:{provenance,cleanup},summary:{total:1,assertions:1,failedAssertions:spec.auditFailure&&!spec.forgedAudit?1:0,errored:0,eyes:0},steps:[step]});
  }else guard(cmd==='pnpm typecheck'||cmd==='pnpm run smoke:packaged','unexpected child '+cmd);
  return {status:0};
 }};
 const fakeProcess={argv:['node','scripts/verify.mjs','--full','--since',head],env:{},platform:process.platform,arch:process.arch,version:process.version,exitCode:0,exit:c=>{throw new Exit(c);}};
 const context=vm.createContext({console:{log:s=>logs.push(String(s)),error:s=>logs.push(String(s))},process:fakeProcess,Date,Set,Map,URL,Buffer});
 const synthetic=(name,values)=>new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context,identifier:name});
 const builtins={'node:fs':synthetic('node:fs',{default:memfs}),'node:path':synthetic('node:path',{default:path}),'node:url':synthetic('node:url',url),'node:crypto':synthetic('node:crypto',crypto),'node:os':synthetic('node:os',{default:os}),'node:child_process':synthetic('node:child_process',cp),stack:synthetic('stack',{buildAll:async()=>{}})};
 const modules=new Map();
 function getModule(rel){
  if(modules.has(rel))return modules.get(rel);guard(rel.startsWith('scripts/')&&!rel.includes('..'),'unexpected import outside scripts');
  const filename=path.join(root,rel);const bytes=fs.readFileSync(filename);sources[rel]={sha256:digest(bytes),bytes:bytes.length};
  const mod=new vm.SourceTextModule(bytes.toString(),{context,identifier:url.pathToFileURL(virtual+'/'+rel).href,initializeImportMeta:meta=>{meta.url=url.pathToFileURL(virtual+'/'+rel).href;}});modules.set(rel,mod);return mod;
 }
 const entry=getModule('scripts/verify.mjs');
 await entry.link((s,r)=>{if(s in builtins)return builtins[s];if(s.endsWith('/stack.mjs'))return builtins.stack;guard(s.startsWith('.'),'unsupported import '+s);return getModule(path.posix.normalize(path.posix.join(path.posix.dirname(url.fileURLToPath(r.identifier).slice(virtual.length+1)),s)));});
 let code=0,expectedWriteDenial=null;
 try{await entry.evaluate();code=fakeProcess.exitCode??0;}
 catch(e){if(e instanceof Exit)code=e.code;else if(e.code==='EACCES'&&e.message==='AUDIT_FIXTURE_REPORT_WRITE_DENIED'&&spec.writeFailure){expectedWriteDenial=e.message;code=1;}else throw e;}
 const reports=[...files].filter(([p])=>['acceptance.json','verify-report.json'].includes(path.basename(p))).map(([p,b])=>({path:p,report:JSON.parse(b)}));
 guard(reports.length<=1,'ambiguous VM verdict reports');const report=reports[0]?.report??null;
 const result={case:spec.name,exitStatus:code,report,commands,reads,writeAttempts,expectedWriteDenial,logs};observations.push(result);return result;
}
function component(result,kind){return result.report?.components?.find(c=>kind==='audit'?/audit/.test(c.label):/^scenarios/.test(c.label));}
try{
 const requestedRoot=value('--repo')??process.env.KELPI_REGRESSION_ROOT;
 const requestedOutput=value('--out')??process.env.KELPI_REGRESSION_REPORT;
 guard(typeof requestedRoot==='string'&&requestedRoot.length>0,'supply --repo or KELPI_REGRESSION_ROOT explicitly');
 guard(typeof requestedOutput==='string'&&path.isAbsolute(requestedOutput),'supply an absolute --out or KELPI_REGRESSION_REPORT explicitly');
 root=fs.realpathSync(requestedRoot);
 guard(fs.statSync(root).isDirectory(),'repository root is not a directory');
 guard(fs.realpathSync(execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8'}).trim())===root,'supply the exact repository root');
 output=path.resolve(requestedOutput);
 const relativeOutput=path.relative(root,output);
 guard(relativeOutput.startsWith('..'+path.sep)||path.isAbsolute(relativeOutput),'report output must be outside the source repository');
 guard(!fs.existsSync(output),'report output already exists; original evidence must remain unchanged');
 head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();dirty=execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
 // Pure battery API is stable across the two refs: an actual failed component and its successful retry.
 const batteryPath=path.join(root,'scripts/ui-audit/lib/battery.mjs');const batteryBytes=fs.readFileSync(batteryPath);sources['scripts/ui-audit/lib/battery.mjs']={sha256:digest(batteryBytes),bytes:batteryBytes.length};
 const {runBattery}=await import(url.pathToFileURL(batteryPath));
 let runs=0,retries=0;const decision=await runBattery({components:[{label:'named failure',run:()=>{runs++;return {ok:false,detail:'first named assertion failed',retryOf:['named failure'],retry:()=>{retries++;return {ok:true};}};}}]});
 guard(runs===1&&retries===1,'counterfactual did not execute first attempt and retry');
 check('first-failure-survives-passing-retry',decision.ok===false,{decision,runs,retries});
 const control=await execute({name:'healthy component controls'});
 guard(component(control,'audit')?.state==='passed'&&component(control,'scenario')?.state==='passed','healthy structured control failed: fixture/config problem, not regression');
 for(const spec of [
  {name:'failed-audit-assertion-blocks-success',auditFailure:true,kind:'audit'},
  {name:'forged-audit-summary-cannot-erase-failure',auditFailure:true,forgedAudit:true,kind:'audit'},
  {name:'forged-scenario-summary-cannot-erase-failure',forgedScenario:true,kind:'scenario'},
  {name:'cleanup-leak-blocks-success',leak:true,kind:'scenario'},
  {name:'missing-required-report-blocks-success',missingReports:true,kind:'audit'}
 ]){
  const result=await execute(spec);const c=component(result,spec.kind);guard(!!c,'selected component never executed');
  const expected=spec.missingReports?'unverified':'failed';
  check(spec.name,result.exitStatus!==0&&c.state!=='passed'&&c.firstAttempt?.verdict===expected,{exitStatus:result.exitStatus,component:c,expectedComponentVerdict:expected});
 }
 const denied=await execute({name:'final-report-write-failure-is-fatal',writeFailure:true});
 check('final-report-write-failure-is-fatal',denied.exitStatus!==0&&denied.report===null&&denied.expectedWriteDenial==='AUDIT_FIXTURE_REPORT_WRITE_DENIED',{exitStatus:denied.exitStatus,reportWritten:!!denied.report,writeAttempts:denied.writeAttempts,expectedWriteDenial:denied.expectedWriteDenial});
}catch(e){errors.push({kind:'infrastructure/config/import',message:String(e.stack??e)});}
const report={schemaVersion:1,assertions,errors,environment:{id:`${os.hostname()}:${process.platform}:${process.arch}:${process.version}`,kind:'local',details:'Node VM executes exact supplied repository verifier/battery source with in-memory filesystem, git snapshot and subprocess/build I/O substitutions; no desktop or installed environments.'},cleanup:{attempted:true,completed:true,errors:[],leaks:[]},fixture:{path:url.fileURLToPath(import.meta.url),sha256:digest(fs.readFileSync(url.fileURLToPath(import.meta.url))),dataSha256:digest(JSON.stringify(fixture))},source:{root,head,dirtyFiles:dirty,files:sources},observations,limitations:['Proves acceptance-harness regressions only; not original pairing/Copy/paste incident','Mutable candidate output is exploratory and cannot establish exact-commit acceptance','Overall candidate control may be unverified because there is no incident manifest; selected healthy component controls must pass to prevent vacuous success']};
if(output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({head,dirty,assertions:assertions.map(a=>({name:a.name,ok:a.ok})),errors,reportPath:output}));
process.exitCode=errors.length?2:assertions.some(a=>!a.ok)?1:0;

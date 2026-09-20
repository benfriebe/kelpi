import {expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {aggregateShards} from './shards.mjs';
import {shardProvenanceErrors} from './incident-diagnostics-replay.mjs';
import {inspectSelection} from './acceptance-selection.mjs';
import {cleanupSteps} from './incident-diagnostics.mjs';
import {createReport} from './report.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),audit=path.join(root,'scripts/ui-audit/audit.mjs'),source=fs.readFileSync(audit,'utf8');
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const selection={kind:'audit',ordered:true,complete:true,members:[{id:'fixture',mode:'assert',requiredAssertions:['body'],minAssertions:1},{id:'renderer-console',mode:'assert',requiredAssertions:['no renderer console errors/warnings'],minAssertions:1}]};
it.each(['healthy','dirty-child','missing-provenance','missing-assertions','malformed-child'])('actual parent retains and validates %s shard identity',async mode=>{
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-shard-'));
    try {
        const p={runId:'run',startedAt:new Date().toISOString(),head:'1'.repeat(40),requestedHead:null,trackedDiffSha256:'2'.repeat(64),dirtyFiles:[],source:{inputManifestSha256:'3'.repeat(64)},build:{outputs:[{path:'bundle',sha256:'4'.repeat(64)}]},executedOutputs:[{path:'bundle',sha256:'4'.repeat(64)}],buildHashes:{bundle:'4'.repeat(64)},complete:true,errors:[],runtimeBindings:[]};
        const processStub={execPath:process.execPath,env:{},stdout:{write(){}},exitCode:0};
        const vars={fs,path,repoRoot:root,outDir,options:{build:false,packaged:false,shards:1,window:'hidden'},fileURLToPath,
            captureProvenance:()=>structuredClone(p),aggregateShards,process:processStub,CANONICAL_ORDER:['fixture'],selection,
            planShards:()=>({groups:[['fixture']],supports:[[]]}),shardPlanOptions:()=>({}),describePartition:()=>'',shardArgs:()=>[],clearBackgroundTaskPolicy:()=>{},gitCommit:()=>p.head,
            shardProvenanceErrors,inspectSelection,auditPlan:()=>selection,
            spawnProcess(_exe,args,opts){
                expect(opts.env.KELPI_ACCEPTANCE_RUN_ID).toBe('run');
                const dir=args[args.indexOf('--out')+1];fs.mkdirSync(dir,{recursive:true});
                const step=(id,name)=>({id,index:'01',slug:id,expect:'fixture',notes:[],shots:[],blocks:[],error:null,needsEyes:false,assertions:[{name,ok:true,detail:''}]});
                const child={meta:{},selection,provenance:{...p,...(mode==='dirty-child'?{head:'0'.repeat(40),dirtyFiles:[' M fixture-source']}:{})},cleanup:{attempted:true,completed:true,errors:[],leaks:[]},steps:[step('fixture','body'),step('renderer-console','no renderer console errors/warnings')],summary:{total:2,assertions:2,failedAssertions:0,errored:0,eyes:0}};
                if(mode==='missing-provenance')delete child.provenance;if(mode==='missing-assertions')child.steps[0].assertions=[];
                fs.writeFileSync(path.join(dir,'results.json'),mode==='malformed-child'?'{':JSON.stringify(child));
                const emitter=new EventEmitter();emitter.stdout=new PassThrough();emitter.stderr=new PassThrough();
                setTimeout(()=>{emitter.stdout.end();emitter.stderr.end();emitter.emit('close',0);},0);return emitter;
            }};
        const parent=source.slice(source.indexOf('async function runShardedParent()'),source.indexOf('\nasync function main()')).replaceAll('import.meta.url',JSON.stringify(pathToFileURL(audit).href));
        const retain=source.slice(source.indexOf('function retainAcceptanceFields()'),source.indexOf('\n\n\nfunction gitCommit()'));
        const run=new AsyncFunction(...Object.keys(vars),`let auditProvenance;const auditCleanup={attempted:false,completed:false,errors:[],leaks:[]};${retain}\n${parent}\ntry {await runShardedParent();} catch(error) {process.exitCode=1;retainAcceptanceFields();}`);
        await run(...Object.values(vars));
        const output=JSON.parse(fs.readFileSync(path.join(outDir,'results.json')));
        expect(processStub.exitCode).toBe(mode==='healthy'?0:1);
        expect(output.provenance.shardProvenance).toHaveLength(1);
        if(mode==='healthy')expect(output.provenance.shardProvenance[0].errors).toEqual([]);
        else expect(output.provenance.shardProvenance[0].errors.length).toBeGreaterThan(0);
        if(mode==='dirty-child')expect(output.provenance.shardProvenance[0].provenance.dirtyFiles).toEqual([' M fixture-source']);
    }finally{fs.rmSync(outDir,{recursive:true,force:true});}
});
it('actual audit finally attempts all cleanup and retains success even when index report writing fails',async()=>{
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-audit-write-'));
    try {
        const start=source.indexOf('        auditCleanup.attempted = true;\n        // Each write'),end=source.indexOf('\n    }\n}\n\n// ── the flows',start);
        expect(start).toBeGreaterThan(0);
        const report=createReport({outDir,meta:{}});report.step('original').check('original first assertion',false);
        fs.mkdirSync(path.join(outDir,'index.md'));
        const calls=[],cleanup={attempted:false,completed:false,errors:[],leaks:[]},processStub={stdout:{write(){}},exitCode:0};
        const resource=(name,method)=>({[method]:()=>calls.push(name),text:()=>''});
        const vars={auditCleanup:cleanup,report,retainAcceptanceFields(){const file=path.join(outDir,'results.json'),output=JSON.parse(fs.readFileSync(file));output.cleanup=cleanup;fs.writeFileSync(file,JSON.stringify(output));},cleanupSteps,runtime:{page:resource('page','close'),shell:resource('shell','quit'),daemon:resource('daemon','stop')},site:resource('site','close'),fs,path,outDir,process:processStub,options:{keep:false},sandbox:resource('sandbox','cleanup')};
        await new AsyncFunction(...Object.keys(vars),source.slice(start,end))(...Object.values(vars));
        expect(calls).toEqual(['page','site','shell','daemon','sandbox']);
        expect(cleanup).toMatchObject({attempted:true,completed:true,errors:[]});expect(processStub.exitCode).toBe(1);
        const output=JSON.parse(fs.readFileSync(path.join(outDir,'results.json')));
        expect(output.steps[0].assertions[0].ok).toBe(false);expect(output.harnessFailure.detail).toContain('EISDIR');
        expect(JSON.parse(fs.readFileSync(path.join(outDir,'cleanup.json'))).completed).toBe(true);
    }finally{fs.rmSync(outDir,{recursive:true,force:true});}
});
it('phone setup failure closes only its explicit sibling and verifies original roster/focus/workspace after close',async()=>{
    const start=source.indexOf("id: 'phone-shell'"),end=source.indexOf('\n        },\n        /*',start),calls=[],checks=[];
    let sibling=false;
    const original={panes:['original-pane'],focused:'original-pane',workspace:'ws'};
    const view={eval:async()=>JSON.stringify(original),waitFor:async()=>{throw Error('fixture frame absent');},click:async()=>calls.push('workspace')};
    const ctx=vm.createContext({runtime:{page:view},page:view,paneIDsExpr:'[]',widestShellPane:async()=>({id:'original-pane'}),cli:{json:async args=>{
        if(args[1]==='split'){sibling=true;return {pane_id:'owned-sibling'};}
        return [{id:'original-pane',type:'shell',workspace_id:'ws'},...(sibling?[{id:'owned-sibling',type:'shell',workspace_id:'ws'}]:[])];
    },run:async args=>{expect(Array.from(args)).toEqual(['pane','close','--target','owned-sibling']);sibling=false;calls.push('close-owned');return {code:0};}},clearPhoneEmulation:async()=>calls.push('clear'),focusPaneBody:async(_view,id)=>{expect(id).toBe('original-pane');calls.push('focus');},cleanupSteps});
    const flow=vm.runInContext(`({${source.slice(start,end)}\n})`,ctx);
    await expect(flow.run({check:(label,ok)=>{checks.push({label,ok});return ok;}})).rejects.toThrow('fixture frame absent');
    expect(calls).toEqual(['clear','close-owned','workspace','focus']);
    expect(checks.at(-1)).toEqual({label:'fixture cleanup: original roster, workspace and focused pane restored',ok:true});
});

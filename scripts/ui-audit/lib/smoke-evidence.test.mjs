import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

it('freezes smoke plan before results and never overwrites an original cleanup failure',async()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kelpi-smoke-receipt-'));
    try {
        fs.copyFileSync(new URL('./smoke-evidence.mjs',import.meta.url),path.join(temp,'smoke-evidence.mjs'));
        fs.writeFileSync(path.join(temp,'execution-roots.mjs'),`export const executionRoots=()=>({harnessRoot:${JSON.stringify(temp)}});`);
        fs.writeFileSync(path.join(temp,'smoke-plan.mjs'),`export const smokePlan=()=>({kind:'smoke',ordered:true,complete:true,members:[{id:'shell',mode:'assert',requiredAssertions:['first','last'],minAssertions:2}]});`);
        fs.writeFileSync(path.join(temp,'incident-diagnostics-replay.mjs'),`export const captureProvenance=()=>({bound:'original'});export const bindCoreExecution=(_root,p)=>{p.observed=true;};`);
        const {installSmokeEvidence}=await import(pathToFileURL(path.join(temp,'smoke-evidence.mjs')));
        const file=path.join(temp,'report.json'),results=[];
        const finish=installSmokeEvidence({repoRoot:temp,name:'shell',results,source:path.join(temp,'shell.mjs'),argv:['--acceptance-report',file]});
        results.push({name:'first',ok:true});
        finish.recordCleanup({attempted:true,completed:false,errors:['original teardown failure'],leaks:['owned child']});
        const bytes=fs.readFileSync(file,'utf8'),report=JSON.parse(bytes);
        expect(report.selection.members[0].requiredAssertions).toEqual(['first','last']);
        expect(report.assertions.map(a=>a.name)).toEqual(['first']);
        expect(report.cleanup.completed).toBe(false);expect(report.exitStatus).toBe(1);
        results.push({name:'last',ok:true});finish.recordCleanup({attempted:true,completed:true,errors:[],leaks:[]});finish(0);
        expect(fs.readFileSync(file,'utf8')).toBe(bytes);
        expect(()=>installSmokeEvidence({repoRoot:temp,name:'shell',results,argv:['--acceptance-report',file]})).toThrow('new absolute path');
    }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

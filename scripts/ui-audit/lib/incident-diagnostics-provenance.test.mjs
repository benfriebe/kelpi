import {expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {captureProvenance,validateReplayProvenance,shardProvenanceErrors} from './incident-diagnostics-replay.mjs';
import {bundleHash,writeRecordedHash} from './build-cache.mjs';
import {bindPackagedRuntime,readAsarEntry} from './incident-diagnostics-packaged.mjs';
import {scenarioPlan,auditPlan} from './incident-diagnostics-plan.mjs';
import {CANONICAL_ORDER} from './shards.mjs';
vi.mock('../../build-terminal-lab.mjs',()=>({buildTerminalLab:vi.fn()}));
import {buildTerminalLab} from '../../build-terminal-lab.mjs';
import {buildBoundTerminalLab} from './incident-diagnostics-runtime.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const write=(base,file,text)=>{fs.mkdirSync(path.dirname(path.join(base,file)),{recursive:true});fs.writeFileSync(path.join(base,file),text);};
function fixture() {
    const base=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-provenance-'));
    const git=args=>execFileSync('git',['-C',base,...args],{stdio:'pipe'});
    git(['init','-q']);write(base,'.gitignore','packages/*/dist/\nexamples/plugins/terminal-lab/ui/bundle.*\n');
    write(base,'scripts/fixture.mjs','export default ({rec})=>rec.check("body",true);');
    write(base,'examples/plugins/terminal-lab/ui/terminal.js','source');
    git(['add','.']);git(['-c','user.name=Private Fixture','-c','user.email=fixture@example.invalid','commit','-qm','private fixture only']);
    for(const [name,file] of [['client','index.html'],['daemon','kelpid.js'],['cli','kelpi.js'],['shell','main.js']]) {
        write(base,`packages/${name}/dist/${file}`,name);
        if(name==='daemon')write(base,'packages/daemon/dist/runner.mjs','runner');
        writeRecordedHash(base,name,bundleHash(base,name));
    }
    write(base,'examples/plugins/terminal-lab/ui/bundle.js','initial');write(base,'examples/plugins/terminal-lab/ui/bundle.css','css');
    return base;
}
it('requires complete replay key sets and binds ignored plugin artifacts',()=>{
    const base=fixture();try {
        const before=captureProvenance(base), current=captureProvenance(base);
        expect(()=>validateReplayProvenance(before,current)).not.toThrow();
        for(const hashes of [{},Object.fromEntries(Object.entries(before.buildHashes).slice(1)),{...before.buildHashes,'extra': '1'.repeat(64)},{...before.buildHashes,[Object.keys(before.buildHashes)[0]]:null}]) {
            expect(()=>validateReplayProvenance({...before,buildHashes:hashes},current)).toThrow(/replay/);
        }
        write(base,'examples/plugins/terminal-lab/ui/bundle.js','changed ignored bytes');
        const changed=captureProvenance(base);expect(changed.dirtyFiles).toEqual([]);
        expect(()=>validateReplayProvenance(before,changed)).toThrow(/bundle.js/);
        expect(shardProvenanceErrors(before,current)).toEqual([]);
        const incomplete={...before,buildHashes:{...before.buildHashes}};delete incomplete.buildHashes['packages/daemon/dist/runner.mjs'];
        expect(()=>validateReplayProvenance(incomplete,incomplete)).toThrow('required build artifact missing');
        for(const difference of [{head:'0'.repeat(40)},{runId:'foreign'},{source:{}},{build:{}},{dirtyFiles:[' M source']},{buildHashes:{}},{complete:false}]) {
            expect(shardProvenanceErrors(before,{...current,...difference}).length).toBeGreaterThan(0);
        }
    } finally {fs.rmSync(base,{recursive:true,force:true});}
});
it('checks rebuild results before plugin input and every install boundary',async()=>{
    const base=fixture();try {
        const rec={name:'plugin-terminal-features',outDir:base};
        buildTerminalLab.mockImplementation(async()=>path.join(base,'examples/plugins/terminal-lab'));
        const provenance=captureProvenance(base),context={provenance};
        const healthy=await buildBoundTerminalLab(base,{rec,diagnosticsProvenance:context});
        healthy.bindExecution('local');
        const original=JSON.parse(JSON.stringify({provenance}));
        const replay=await buildBoundTerminalLab(base,{rec,diagnosticsProvenance:{provenance:captureProvenance(base),replaySource:original}});
        replay.bindExecution('local');
        buildTerminalLab.mockImplementation(async()=>{write(base,'examples/plugins/terminal-lab/ui/bundle.js','rebuilt changed');return path.join(base,'examples/plugins/terminal-lab');});
        await expect(buildBoundTerminalLab(base,{rec,diagnosticsProvenance:{provenance:captureProvenance(base),replaySource:original}})).rejects.toThrow('replay plugin build differs');
        expect(original.provenance.runtimeBindings[0].complete).toBe(true);
        write(base,'examples/plugins/terminal-lab/ui/bundle.js','changed after build');
        expect(()=>replay.bindExecution('remote')).toThrow('plugin outputs changed after build');
    } finally {fs.rmSync(base,{recursive:true,force:true});}
});
function asar(bytes) {
    const json=Buffer.from(JSON.stringify({files:{dist:{files:{'main.js':{size:bytes.length,offset:'0'}}}}}));
    const headerSize=8+Math.ceil(json.length/4)*4, header=Buffer.alloc(8+headerSize);
    header.writeUInt32LE(4,0);header.writeUInt32LE(headerSize,4);header.writeUInt32LE(headerSize-4,8);header.writeUInt32LE(json.length,12);json.copy(header,16);
    return Buffer.concat([header,bytes]);
}
it('compares packaged bytes and asar shell entry to bound core build outputs',()=>{
    const base=fixture();try {
        const p=captureProvenance(base);p.build.forced=true;
        const resource=`packages/shell/out/Kelpi-darwin-${process.arch}/Kelpi.app/Contents/Resources`;
        for(const output of p.build.outputs) {
            const match=/packages\/(client|daemon|cli)\/dist\/(.+)/.exec(output.path);
            if(match)write(base,`${resource}/${match[1]}/${match[2]}`,fs.readFileSync(path.join(base,output.path)));
        }
        const bytes=fs.readFileSync(path.join(base,'packages/shell/dist/main.js'));
        write(base,`${resource}/app.asar`,asar(bytes));
        expect(readAsarEntry(path.join(base,resource,'app.asar'),'dist/main.js')).toEqual(bytes);
        expect(bindPackagedRuntime(base,p,{packaged:true}).complete).toBe(true);
        write(base,`${resource}/client/index.html`,'different packaged build');
        expect(bindPackagedRuntime(base,p,{packaged:true})).toMatchObject({complete:false,errors:['runtime artifacts differ from recorded build outputs']});
    }finally{fs.rmSync(base,{recursive:true,force:true});}
});
it('collects all real selected identities, generated settings tabs, and mandatory assertion names without running inputs',()=>{
    const plan=auditPlan(root,[...CANONICAL_ORDER,'renderer-console']);
    expect(plan.members.map(member=>member.id)).toEqual([...CANONICAL_ORDER,'renderer-console']);
    expect(plan.members.find(member=>member.id==='phone-shell').requiredAssertions).toContain('fixture: terminal sibling was created');
    const base=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-plan-'));
    try {
        const file=path.join(base,'fixture.mjs');
        fs.writeFileSync(file,`throw Error('must never import');export default async({rec})=>{rec.check('mandatory',true);if(false)rec.check('optional',true);};`);
        const p=scenarioPlan(root,[file]);expect(p.members[0].requiredAssertions).toEqual(['mandatory']);expect(p.members[0].minAssertions).toBe(1);
    }finally{fs.rmSync(base,{recursive:true,force:true});}
});
it.each(['invalid JSON','unreadable'])('does not treat a %s workbench store as clean',mode=>{
    const source=fs.readFileSync(path.join(root,'scripts/scenario.mjs'),'utf8');
    const start=source.indexOf('const PAGE_STATE = `')+'const PAGE_STATE = '.length;
    const end=source.indexOf('})()`;',start)+5;
    const expression=vm.runInNewContext(source.slice(start,end).replace(/;\s*$/,''));
    const localStorage={'kelpi.workbench.v1:owned':'bad',getItem(){if(mode==='unreadable')throw Error('denied');return '{';}};
    expect(()=>vm.runInNewContext(expression,{localStorage})).toThrow('unreadable workbench store');
});

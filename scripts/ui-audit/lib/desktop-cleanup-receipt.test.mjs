import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

it.each([false,true])('records actual desktop teardown and retains failed teardown=%s before waiting', failed=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kelpi-cleanup-receipt-'));
    try {
        const file=path.join(temp,'receipts.jsonl'),released=path.join(temp,'released');
        const slot=path.join(temp,'slot.mjs'),hook=path.join(temp,'hook.mjs');
        fs.writeFileSync(slot,`import fs from 'node:fs'; export async function holdDesktopTestSlot(){return {release:async()=>fs.writeFileSync(${JSON.stringify(released)},'released')}}`);
        fs.writeFileSync(hook,`import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){return s==='./desktop-slot.mjs'&&c.parentURL?.endsWith('/desktop-lifecycle.mjs')?{url:${JSON.stringify(pathToFileURL(slot).href)},shortCircuit:true}:next(s,c);}})`);
        const script=`import fs from 'node:fs';import {runDesktopTest,ownDesktopResource} from ${JSON.stringify(new URL('./desktop-lifecycle.mjs',import.meta.url).href)};
            let calls=0; await runDesktopTest(async()=>{ownDesktopResource({stop:async()=>{calls++;${failed?"throw new Error('original teardown failure');":''}}});},
                {onCleanup:r=>fs.appendFileSync(${JSON.stringify(file)},JSON.stringify({...r,calls})+'\\n')});`;
        const run=spawnSync(process.execPath,['--import',hook,'--input-type=module','-e',script],{encoding:'utf8',timeout:1200,killSignal:'SIGKILL'});
        const receipts=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
        expect(receipts).toHaveLength(1);expect(receipts[0].attempted).toBe(true);expect(receipts[0].calls).toBe(1);
        expect(receipts[0].completed).toBe(!failed);expect(fs.existsSync(released)).toBe(!failed);
        if(failed){expect(receipts[0].errors.join(' ')).toContain('original teardown failure');expect(receipts[0].leaks).toHaveLength(1);expect(run.signal).toBe('SIGKILL');}
        else {expect(run.status,run.stderr).toBe(0);expect(receipts[0].errors).toEqual([]);}
    } finally {fs.rmSync(temp,{recursive:true,force:true});}
});

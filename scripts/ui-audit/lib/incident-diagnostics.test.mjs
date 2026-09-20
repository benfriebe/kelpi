import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { armIncidentDiagnostics, installRendererRecorder, redactFixtureText } from './incident-diagnostics.mjs';
import { recorder, clipboardCaret } from './driver.mjs';
import { replayFiles, firstFailureSequence } from './incident-diagnostics-replay.mjs';

function renderer() {
    const listeners = new Map();
    const document = {
        activeElement: { tagName: 'TEXTAREA', getAttribute: () => null }, visibilityState: 'visible', hasFocus: () => false,
        querySelectorAll: () => [], body: { dataset: {} },
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: type => listeners.delete(type)
    };
    const terminal = { getSelection: () => 'KELPI', write: vi.fn(), reset: vi.fn(), resize: vi.fn() };
    const clipboard = { readText: vi.fn(async () => 'private clipboard secret'), writeText: vi.fn(async () => {}) };
    const context = vm.createContext({ document, navigator: { clipboard }, terminalLab: { terminal, replayCount: 1 }, performance });
    return { eval: async expression => vm.runInContext(expression, context), context, terminal, clipboard, listeners };
}

describe('first incident evidence', () => {
    it('leaves frozen SDK sessions untouched while retaining the available renderer evidence', async () => {
        const host=renderer(), write=vi.fn(() => 7), session=Object.freeze({write,writeDirect:write,resize:write});
        host.context.terminalLab.session=session;
        await host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({key:'incident',allowed:['KELPI'],capacity:20})})`);
        expect(session.write('KELPI')).toBe(7);
        expect(write).toHaveBeenCalledExactlyOnceWith('KELPI');
        expect(session.write).toBe(write);
        expect((await host.eval('incident.snapshot()')).incomplete).toBe(false);
        await host.eval('incident.restore()');
    });

    it.each([false, true])('retains every journaled event and fails closed on journal write loss (%s)', async failWrite => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-journal-'));
        let spy;
        try {
            const host = renderer(), original = vi.fn(async () => ({text:'private clipboard secret'}));
            const rec = recorder({name:'journal',outDir}), harness = {clipboardRead:original};
            const incident = await armIncidentDiagnostics({page:{eval:host.eval},harness,rec,capacity:4,journal:true});
            if (failWrite) spy = vi.spyOn(fs,'writeSync').mockReturnValue(0);
            for (let i=0;i<6;i++) expect(await harness.clipboardRead()).toEqual({text:'private clipboard secret'});
            spy?.mockRestore(); spy=undefined;
            await incident.close();
            const saved=JSON.parse(fs.readFileSync(path.join(outDir,'journal-first-incident.json'),'utf8'));
            const log=fs.readFileSync(path.join(outDir,'journal-incident-events.jsonl'),'utf8');
            expect(original).toHaveBeenCalledTimes(6);
            expect(saved.complete).toBe(!failWrite);
            expect(saved.historyRetained).toBe(!failWrite);
            expect(saved.dropped).toBe(8);
            expect(saved.journal.records).toBe(failWrite ? 0 : 12);
            expect(log).not.toContain('private clipboard secret');
            if (!failWrite) expect(log.trim().split('\n').map(line=>JSON.parse(line).sequence)).toEqual(Array.from({length:12},(_,i)=>i+1));
            expect(harness.clipboardRead).toBe(original);
        } finally { spy?.mockRestore(); fs.rmSync(outDir,{recursive:true,force:true}); }
    });

    it('observes promised Clipboard.write without reading items or replacing its rejected promise', async () => {
        const host = renderer(), error = new Error('permission denied');
        error.name = 'NotAllowedError';
        const pending = Promise.reject(error), original = vi.fn(() => pending);
        host.clipboard.write = original;
        const item = { getType: vi.fn(() => { throw new Error('must not consume clipboard representation'); }) };
        await host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({key:'incident',allowed:['KELPI'],capacity:20})})`);
        const returned = host.clipboard.write([item]);
        expect(returned).toBe(pending);
        await expect(returned).rejects.toBe(error);
        const saved = await host.eval('incident.snapshot()');
        expect(saved.events.map(event => event.kind)).toEqual(['armed', 'clipboard.write:call', 'clipboard.write:rejected']);
        expect(original).toHaveBeenCalledExactlyOnceWith([item]);
        expect(item.getType).not.toHaveBeenCalled();
        await host.eval('incident.restore()');
        expect(host.clipboard.write).toBe(original);
    });

    it('observes bridge traffic without starting a port or changing arguments, return values or exceptions', async () => {
        const host = renderer(), returned = {}, failure = new Error('original send failed');
        const listeners = new Set(), start = vi.fn();
        class Port {
            addEventListener(_type, fn) { listeners.add(fn); }
            removeEventListener(_type, fn) { listeners.delete(fn); }
            start = start;
            postMessage = undefined;
        }
        delete Port.prototype.postMessage;
        const original = vi.fn(function (message, transfer) { if (message.fail) throw failure; return returned; });
        Port.prototype.postMessage = original;
        host.context.MessagePort = Port;
        const port = new Port(); delete port.postMessage;
        await host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({key:'incident',allowed:['KELPI'],capacity:20})})`);
        const message = {type:'terminal-action',action:{type:'getSelection'},private:'secret transcript'}, transfer = [];
        expect(port.postMessage(message, transfer)).toBe(returned);
        for (const fn of listeners) fn({data:{type:'terminal-action-reply',result:'private clipboard secret'}});
        expect(() => port.postMessage({type:'terminal-input',fail:true})).toThrow(failure);
        expect(original.mock.calls[0]).toEqual([message, transfer]);
        expect(original.mock.contexts[0]).toBe(port);
        expect(start).not.toHaveBeenCalled();
        const saved = await host.eval('incident.snapshot()');
        expect(saved.events.map(event => event.kind)).toContain('bridge:received');
        expect(JSON.stringify(saved)).not.toContain('secret');
        await host.eval('incident.restore()');
        expect(Port.prototype.postMessage).toBe(original);
        expect(listeners.size).toBe(0);
    });

    it('does not publish custom error names or changing bridge metadata getters, while preserving the original calls', async () => {
        const host=renderer(), secret='private clipboard secret', error=new Error(secret);
        error.name=secret;
        const write=vi.fn(() => {throw error;}); host.clipboard.write=write;
        const terminalWrite=vi.fn(() => 19); host.terminal.write=terminalWrite;
        const original=vi.fn(() => 17);
        class Port {addEventListener() {} removeEventListener() {} postMessage(...args) {return original(...args);}}
        host.context.MessagePort=Port;
        await host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({key:'incident',allowed:['KELPI'],capacity:20})})`);
        let caught;
        try {host.clipboard.write([]);} catch (value) {caught=value;}
        expect(caught).toBe(error);
        let reads=0;
        const message={get type() {return ++reads===1 ? 'terminal-action' : secret;},action:{type:'copy'},data:{byteLength:secret},generation:secret,sequence:secret};
        expect(new Port().postMessage(message)).toBe(17);
        const payload={byteLength:secret};
        expect(host.terminal.write(payload)).toBe(19);
        const saved=await host.eval('incident.snapshot()');
        expect(JSON.stringify(saved)).not.toContain(secret);
        expect(reads).toBe(0);
        expect(saved.diagnosticErrors).toContainEqual({phase:'bridge metadata accessor skipped',error:'Error'});
        expect(original).toHaveBeenCalledExactlyOnceWith(message);
        expect(write).toHaveBeenCalledTimes(1);
        expect(terminalWrite).toHaveBeenCalledExactlyOnceWith(payload);
        await host.eval('incident.restore()');
    });

    it.each(['type','action','generation','sequence','data','result','action.type','data.byteLength'])('never invokes the outgoing bridge %s accessor or changes original operation ordering', async field => {
        const host=renderer(), returned={}, failure=new Error('exact original send failure');
        const getter=vi.fn(() => {throw new Error('observer invoked user getter');});
        const original=vi.fn(() => returned);
        class Port {addEventListener() {} removeEventListener() {} postMessage(...args) {return original(...args);}}
        host.context.MessagePort=Port;
        const message={type:'terminal-action',action:{type:'copy'},data:{byteLength:5},generation:1,sequence:2,result:'KELPI'};
        const [outer,inner]=field.split('.');
        Object.defineProperty(inner ? message[outer] : message,inner ?? outer,{get:getter,configurable:true,enumerable:true});
        await host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({key:'incident',allowed:['KELPI'],capacity:30})})`);
        const port=new Port(), transfer=[];
        expect(port.postMessage(message,transfer)).toBe(returned);
        expect(original).toHaveBeenCalledTimes(1);
        expect(original.mock.calls[0][0]).toBe(message);
        expect(original.mock.calls[0][1]).toBe(transfer);
        expect(getter).not.toHaveBeenCalled();
        original.mockImplementationOnce(() => {throw failure;});
        let caught;try {port.postMessage(message,transfer);} catch(error) {caught=error;}
        expect(caught).toBe(failure);
        expect(original).toHaveBeenCalledTimes(2);
        expect(getter).not.toHaveBeenCalled();
        const saved=await host.eval('incident.snapshot()');
        expect(saved.incomplete).toBe(true);
        await host.eval('incident.restore()');
    });

    it('arms host and remote before input, freezes the first failure before cleanup, bounds and redacts events, and restores instrumentation', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-unit-'));
        try {
            const host = renderer(), remote = renderer();
            const page = { eval: host.eval, key: vi.fn(async () => { host.listeners.get('keydown')({ type: 'keydown', code: 'KeyC', isTrusted: true }); }) };
            const harness = { clipboardRead: vi.fn(async () => ({ text: 'private clipboard secret' })), clipboardWrite: vi.fn(async text => ({ text })) };
            const originalKey = page.key, originalRead = harness.clipboardRead, originalReset = remote.terminal.reset;
            const rec = recorder({ name: 'first', outDir });
            const incident = await armIncidentDiagnostics({ page, harness, rec, allowed: ['KELPI'], capacity: 4 });
            await incident.addRenderer('remote', remote.eval);
            await harness.clipboardWrite('KELPI');
            await harness.clipboardRead();
            await remote.eval('terminalLab.terminal.reset()');
            await page.key('KeyC');
            rec.check('original failed copy', false, 'sentinel survived');
            await rec.flushFirstFailure();
            const file = path.join(outDir, 'first-first-incident.json'), first = fs.readFileSync(file, 'utf8');
            remote.terminal.getSelection = () => 'after cleanup';
            rec.check('later successful copy', true);
            await incident.close();
            expect(fs.readFileSync(file, 'utf8')).toBe(first);
            const saved = JSON.parse(first);
            expect(saved.reason).toBe('original failed copy');
            expect(saved.events.length).toBe(4);
            expect(saved.dropped).toBeGreaterThan(0);
            expect(first).not.toContain('private clipboard secret');
            expect(first).not.toContain('after cleanup');
            expect(saved.renderers[1].state.selection.text).toBe('KELPI');
            expect(saved.renderers[1].events.map(event => event.kind)).toContain('reset:call');
            expect(saved.renderers[0].state.hasFocus).toBe(false);
            expect(rec.summary().failed).toBe(2);
            expect(saved.historyRetained).toBe(false);
            expect(saved.targetAvailable).toBe(true);
            expect(rec.summary().firstFailure.label).toBe('original failed copy');
            expect(page.key).toBe(originalKey);
            expect(harness.clipboardRead).toBe(originalRead);
            expect(originalKey).toHaveBeenCalledTimes(1);
            expect(originalRead).toHaveBeenCalledTimes(1);
            expect(remote.terminal.reset).toBe(originalReset);
            expect(host.listeners.size + remote.listeners.size).toBe(0);
        } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
    });

    it('records operation rejection without retrying it or swallowing it', async () => {
        const host = renderer();
        await host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({ key: 'incident', allowed: [], capacity: 10 })})`);
                const error = new Error('not focused'); error.name = 'NotAllowedError';
        // Exercise a new recorder with a rejecting original.
        await host.eval('incident.restore()');
        const original = vi.fn(() => Promise.reject(error)); host.clipboard.writeText = original;
        await host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({ key: 'incident', allowed: [], capacity: 10 })})`);
        await expect(host.clipboard.writeText('secret')).rejects.toBe(error);
        const snapshot = await host.eval('incident.snapshot()');
        expect(snapshot.events.map(event => event.kind)).toContain('writeText:rejected');
        expect(JSON.stringify(snapshot)).not.toContain('secret');
        expect(original).toHaveBeenCalledTimes(1);
        await host.eval('incident.restore()');
        expect(host.clipboard.writeText).toBe(original);
    });

    it('restores listeners and wrappers if installation fails midway', async () => {
        const host = renderer(), originalRead = host.clipboard.readText;
        Object.defineProperty(host.clipboard, 'writeText', { value: () => {}, writable: false });
        await expect(host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({ key: 'incident', allowed: [], capacity: 4 })})`)).rejects.toThrow();
        expect(host.listeners.size).toBe(0);
        expect(host.clipboard.readText).toBe(originalRead);
        expect(await host.eval('globalThis.incident')).toBeUndefined();
    });

    it('reports instrumentation startup failure and retains a snapshot even without relevant input', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-startup-'));
        try {
            let calls = 0;
            const page = { eval: vi.fn(async () => { if (++calls === 1) throw new Error('renderer unavailable'); return null; }) };
            const rec = recorder({ name: 'startup', outDir });
            await expect(armIncidentDiagnostics({ page, rec })).rejects.toThrow('renderer unavailable');
            expect(rec.summary().firstFailure.failureClass).toBe('harness');
            expect(fs.existsSync(path.join(outDir, 'startup-first-incident.json'))).toBe(true);
            expect(page.eval).toHaveBeenCalledTimes(3);
        } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
    });

    it('observes an unfocused caret without repairing focus or selection', async () => {
        const page = { eval: vi.fn(async () => JSON.stringify({ hasFocus: false, onTheRenderer: false })) };
        const harness = { focus: vi.fn() }, refocus = vi.fn();
        const state = await clipboardCaret(page, harness, 'fixture-pane', { refocus });
        expect(state.hasFocus).toBe(false);
        expect(harness.focus).not.toHaveBeenCalled();
        expect(refocus).not.toHaveBeenCalled();
    });

    it('retains only exact controlled fixture values, with a bounded text length', () => {
        expect(redactFixtureText('unknown password', ['KELPI'])).toEqual({ length: 16, redacted: true });
        expect(redactFixtureText('KELPI', ['KELPI'], 3)).toEqual({ length: 5, text: 'KEL', truncated: true });
    });
});

it('replays the exact original prefix including duplicates, never replacing original failure with a later pass', () => {
    const files = ['/repo/a.mjs', '/repo/b.mjs', '/repo/a.mjs'];
    const sequence = firstFailureSequence({ files, summaries: [{ name: 'a', failed: 0 }, { name: 'b', failed: 1 }, { name: 'a', failed: 0 }], resultsPath: '/original/results.json', windowPlacement: 'hidden' });
    expect(replayFiles({ files, sequence })).toEqual(files.slice(0, 2));
    expect(sequence.firstFailure.precedingFiles).toEqual(['/repo/a.mjs']);
    expect(sequence.firstFailure.replayCommand).toContain("--replay '/original/results.json' --through 1");
    expect(sequence.firstFailure.replayCommand).not.toContain('--out');
    expect(() => replayFiles({ files, sequence }, '-1')).toThrow();
});

it('rearms the host on navigation and restores remote instrumentation before unmount', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-navigation-'));
    try {
        let current = renderer(), script;
        const remote = renderer();
        const page = { eval: expression => current.eval(expression), send: vi.fn(async (method, params) => {
            if (method === 'Page.addScriptToEvaluateOnNewDocument') { script = params.source; return {identifier:'private-script'}; }
            return {};
        }) };
        const rec = recorder({name:'navigation',outDir});
        const incident = await armIncidentDiagnostics({page,rec,allowed:['KELPI']});
        await incident.addRenderer('remote',remote.eval);
        await remote.eval('terminalLab.terminal.reset()');
        await incident.retireRenderer('remote');
        expect(remote.listeners.size).toBe(0);
        current = renderer();
        await current.eval('globalThis.top = globalThis');
        await current.eval(script);
        current.listeners.get('copy')({type:'copy',isTrusted:true});
        rec.check('first failure after navigation',false);
        await rec.flushFirstFailure();
        await incident.close();
        const saved = JSON.parse(fs.readFileSync(path.join(outDir,'navigation-first-incident.json'),'utf8'));
        expect(saved.renderers[0].events.at(-1).kind).toBe('copy');
        expect(saved.renderers[1].retiredBeforeLaterOperations).toBe(true);
        expect(saved.renderers[1].events.map(event => event.kind)).toContain('reset:call');
        expect(page.send).toHaveBeenLastCalledWith('Page.removeScriptToEvaluateOnNewDocument',{identifier:'private-script'});
        expect(current.listeners.size).toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(outDir,'navigation-incident-cleanup.json'),'utf8'))).toContainEqual({name:'remote',restoredBeforeUnmount:true});
    } finally { fs.rmSync(outDir,{recursive:true,force:true}); }
});

it('observer failure never prevents the actual clipboard call and preserves its promise identity', async () => {
    const host = renderer();
    host.terminal.getSelection = () => { throw new Error('observer cannot read selection'); };
    const result = Promise.resolve('actual operation result');
    const original = vi.fn(() => result); host.clipboard.writeText = original;
    await host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({key:'incident',allowed:['KELPI'],capacity:10})})`);
    const returned = host.clipboard.writeText('KELPI');
    expect(returned).toBe(result);
    await expect(returned).resolves.toBe('actual operation result');
    expect(original).toHaveBeenCalledTimes(1);
    const snapshot = await host.eval('incident.snapshot()');
    expect(snapshot.incomplete).toBe(true);
    expect(snapshot.diagnosticErrors.length).toBeGreaterThan(0);
    expect(snapshot.events.map(event => event.kind)).toContain('writeText:resolved');
    await host.eval('incident.restore()');
    expect(host.clipboard.writeText).toBe(original);
});

it('distinguishes actual select/getSelection calls from diagnostic state reads', async () => {
    const host = renderer();
    let selection = '';
    host.terminal.select = () => { selection = 'KELPI'; };
    host.terminal.clearSelection = () => { selection = ''; };
    host.terminal.getSelection = () => selection;
    await host.eval(`(${installRendererRecorder.toString()})(${JSON.stringify({key:'incident',allowed:['KELPI'],capacity:20})})`);
    await host.eval('terminalLab.terminal.select(0,0,5); terminalLab.terminal.getSelection(); terminalLab.terminal.clearSelection();');
    const snapshot = await host.eval('incident.snapshot()');
    const actual = snapshot.events.filter(event => event.kind === 'getSelection:returned');
    expect(actual).toHaveLength(1);
    expect(actual[0].value.text).toBe('KELPI');
    expect(snapshot.events.find(event => event.kind === 'select:returned').state.selection.text).toBe('KELPI');
    expect(snapshot.events.find(event => event.kind === 'clearSelection:returned').state.selection.length).toBe(0);
    await host.eval('incident.restore()');
});

it('preserves Node operation promises and classifies observer errors as incomplete evidence', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(),'incident-node-promise-'));
    try {
        const host = renderer(), result = Promise.resolve(Object.defineProperty({},'text',{get() { throw new Error('observer result read failed'); }}));
        const original = vi.fn(() => result);
        const harness = {clipboardRead:original};
        const rec = recorder({name:'promise',outDir});
        const incident = await armIncidentDiagnostics({page:{eval:host.eval},harness,rec});
        expect(harness.clipboardRead()).toBe(result);
        await result;
        await incident.close();
        expect(original).toHaveBeenCalledTimes(1);
        expect(rec.summary().failed).toBe(1);
        expect(rec.summary().firstFailure.failureClass).toBe('harness');
        expect(harness.clipboardRead).toBe(original);
    } finally { fs.rmSync(outDir,{recursive:true,force:true}); }
});

it('explicitly verifies host arming before remote input and freezes it before later navigation', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(),'incident-host-rearm-'));
    try {
        let host = renderer();
        const rec = recorder({name:'host-rearm',outDir});
        const incident = await armIncidentDiagnostics({page:{eval:expression => host.eval(expression)},rec});
        await incident.retireRenderer('host');
        host = renderer(); // A replacement document for which automatic injection did not run.
        await incident.ensureHost();
        expect(host.listeners.has('keydown')).toBe(true);
        host.listeners.get('keydown')({type:'keydown',code:'KeyC',isTrusted:true});
        await incident.retireRenderer('host');
        expect(host.listeners.size).toBe(0);
        host = renderer();
        await incident.close();
        const saved = JSON.parse(fs.readFileSync(path.join(outDir,'host-rearm-first-incident.json'),'utf8'));
        expect(saved.renderers[0].retiredBeforeLaterOperations).toBe(true);
        expect(saved.renderers[1].events.at(-1).kind).toBe('keydown');
        expect(saved.renderers[0].name).toBe('host:document-1');
        expect(saved.renderers[0].state).toBeDefined();
        expect(saved.events.some(event => event.kind === 'host-rearmed-before-input')).toBe(true);
        expect(rec.summary().failed).toBe(0);
    } finally {fs.rmSync(outDir,{recursive:true,force:true});}
});

it('a missing required renderer snapshot is a harness failure even when product assertions passed', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(),'incident-missing-host-'));
    try {
        let host = renderer();
        const rec = recorder({name:'missing',outDir});
        const incident = await armIncidentDiagnostics({page:{eval:expression => host.eval(expression)},rec});
        rec.check('product happened to pass',true);
        host = renderer();
        await incident.close();
        expect(rec.summary().failed).toBe(1);
        expect(rec.summary().firstFailure.failureClass).toBe('harness');
    } finally {fs.rmSync(outDir,{recursive:true,force:true});}
});

it('a rejected duplicate arm leaves its existing owner live and unfrozen', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(),'incident-owner-'));
    try {
        const host=renderer(), page={eval:host.eval};
        const a=recorder({name:'a',outDir}), b=recorder({name:'b',outDir});
        const incident=await armIncidentDiagnostics({page,rec:a});
        await expect(armIncidentDiagnostics({page,rec:b})).rejects.toThrow('already armed');
        expect(host.listeners.size).toBe(11);
        host.listeners.get('copy')({type:'copy',isTrusted:true});
        a.check('actual first Copy failure',false);
        await a.flushFirstFailure(); await incident.close();
        const saved=JSON.parse(fs.readFileSync(path.join(outDir,'a-first-incident.json')));
        expect(saved.complete).toBe(true);
        expect(saved.renderers[0].events.map(event=>event.kind)).toContain('copy');
        expect(host.listeners.size).toBe(0);
    } finally {fs.rmSync(outDir,{recursive:true,force:true});}
});

it('rolls back a listener acquisition that throws after installing and attempts all undos after a restore fault', async () => {
    const host=renderer(), add=host.context.document.addEventListener;
    host.context.document.addEventListener=(type,fn)=>{add(type,fn);if(type==='copy')throw Error('listener failure');};
    const install=`(${installRendererRecorder.toString()})({key:'incident',ownerId:'test',allowed:[],capacity:30})`;
    await expect(host.eval(install)).rejects.toThrow('listener failure');
    expect(host.listeners.size).toBe(0);
    host.context.document.addEventListener=add;
    const read=host.clipboard.readText;
    await host.eval(install);
    Object.defineProperty(host.terminal,'getSelection',{writable:false,configurable:false});
    const cleanup=await host.eval('incident.restore()');
    expect(cleanup.restored).toBe(false);
    expect(cleanup.errors.length).toBe(1);
    expect(host.listeners.size).toBe(0);
    expect(host.clipboard.readText).toBe(read);
    expect(await host.eval('Boolean(globalThis.incident)')).toBe(true);
});

it.each([false,true])('retains partial arm cleanup errors and unresolved ownership (transient removal: %s)',async transient=>{
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'incident-partial-undo-'));
    try {
        const host=renderer(), document=host.context.document, add=document.addEventListener, remove=document.removeEventListener;
        const attempted=[];let failures=0;
        document.addEventListener=(type,fn)=>{add(type,fn);if(type==='copy')throw Error('ACQUISITION_FAILURE');};
        document.removeEventListener=(type,fn)=>{
            attempted.push(type);
            if(type==='keydown' && (!transient || failures++===0))throw Error('REMOVAL_FAILURE');
            remove(type,fn);
        };
        const rec=recorder({name:'partial',outDir});
        await expect(armIncidentDiagnostics({page:{eval:host.eval},rec})).rejects.toThrow('ACQUISITION_FAILURE');
        await rec.flushFirstFailure();
        const firstFile=path.join(outDir,'partial-first-incident.json'), first=fs.readFileSync(firstFile,'utf8'), saved=JSON.parse(first);
        expect(saved.complete).toBe(false);
        expect(saved.renderers[0]).toMatchObject({acquisitionFailed:true,cleanupErrors:['REMOVAL_FAILURE'],outstandingRestores:1});
        expect(saved.renderers[0].historyError).toBeUndefined();
        expect(attempted).toEqual(expect.arrayContaining(['copy','keyup','keydown']));
        const cleanup=JSON.parse(fs.readFileSync(path.join(outDir,'partial-incident-cleanup.json'))).find(item=>item.name==='host');
        expect(cleanup.contextReplaced).toBeUndefined();expect(cleanup.errors).toContain('REMOVAL_FAILURE');
        expect(cleanup.restored).toBe(transient);expect(cleanup.ownerRetained).toBe(!transient);
        expect(host.listeners.size).toBe(transient?0:1);
        expect(rec.results.some(item=>item.failureClass==='cleanup'&&!item.ok)).toBe(true);
        document.removeEventListener=remove;
        if(!transient) {
            const released=await host.eval('__kelpiIncidentRecorder.restore()');
            expect(released.restored).toBe(true);expect(released.errors).toContain('REMOVAL_FAILURE');
        }
        expect(fs.readFileSync(firstFile,'utf8')).toBe(first);
        expect(host.listeners.size).toBe(0);expect(await host.eval('Boolean(globalThis.__kelpiIncidentRecorder)')).toBe(false);
    }finally{fs.rmSync(outDir,{recursive:true,force:true});}
});

it('retains navigation loss and bounded history loss separately from current target availability', async () => {
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'incident-history-'));
    try {
        let host=renderer(), script;
        const page={eval:expression=>host.eval(expression),send:async(method,args)=>{if(method==='Page.addScriptToEvaluateOnNewDocument'){script=args.source;return {identifier:'owned'};}return {};}};
        const rec=recorder({name:'history',outDir});
        const incident=await armIncidentDiagnostics({page,rec,capacity:2});
        host.listeners.get('copy')({type:'copy'});
        host=renderer();await host.eval('globalThis.top=globalThis');await host.eval(script);
        await incident.ensureHost();
        for(const type of ['paste','focus','blur'])host.listeners.get(type)({type});
        await incident.close();
        const saved=JSON.parse(fs.readFileSync(path.join(outDir,'history-first-incident.json')));
        expect(saved.complete).toBe(false);expect(saved.historyRetained).toBe(false);
        expect(saved.renderers).toHaveLength(2);
        expect(saved.renderers[0].unavailable).toContain('history');
        expect(saved.renderers[1]).toMatchObject({targetAvailable:true,historyRetained:false});
        expect(saved.renderers[1].dropped).toBeGreaterThan(0);
        expect(rec.summary().failed).toBe(1);
    } finally {fs.rmSync(outDir,{recursive:true,force:true});}
});

it('cleans every acquired resource and retains the acquisition failure when reporting throws', async () => {
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'incident-reporting-acquire-'));
    try {
        const host=renderer(), document=host.context.document, add=document.addEventListener;
        document.addEventListener=(type,listener)=>{ add(type,listener); if(type==='copy') throw Error('ACQUISITION_FAILURE'); };
        const rec=recorder({name:'report-acquire',outDir}), check=rec.check, reporting=Error('REPORTING_FAILURE');
        rec.check=(...args)=>{ const result=check(...args); if(args[0]==='incident instrumentation armed before input') throw reporting; return result; };
        let failure;
        try { await armIncidentDiagnostics({page:{eval:host.eval},rec}); } catch(error) { failure=error; }
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toContain(reporting);
        expect(failure.errors.some(error=>String(error).includes('ACQUISITION_FAILURE'))).toBe(true);
        expect(host.listeners.size).toBe(0);
        expect(await host.eval('Boolean(globalThis.__kelpiIncidentRecorder)')).toBe(false);
        expect(fs.existsSync(path.join(outDir,'report-acquire-incident-cleanup.json'))).toBe(true);
    } finally { fs.rmSync(outDir,{recursive:true,force:true}); }
});

it('freezes immutable evidence and still releases renderers when evidence reporting throws', async () => {
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'incident-reporting-evidence-'));
    try {
        const host=renderer(), rec=recorder({name:'report-evidence',outDir}), check=rec.check, reporting=Error('REPORTING_FAILURE');
        const incident=await armIncidentDiagnostics({page:{eval:host.eval},rec});
        rec.check=(...args)=>{ const result=check(...args); if(args[0]==='incident diagnostics complete without observer errors') throw reporting; return result; };
        await expect(incident.close()).rejects.toBe(reporting);
        const first=path.join(outDir,'report-evidence-first-incident.json');
        expect(fs.existsSync(first)).toBe(true);
        expect(host.listeners.size).toBe(0);
        expect(await host.eval('Boolean(globalThis.__kelpiIncidentRecorder)')).toBe(false);
        expect(fs.existsSync(path.join(outDir,'report-evidence-incident-cleanup.json'))).toBe(true);
        const frozen=fs.readFileSync(first,'utf8'); await incident.close();
        expect(fs.readFileSync(first,'utf8')).toBe(frozen);
    } finally { fs.rmSync(outDir,{recursive:true,force:true}); }
});

it('attempts remaining cleanup again after cleanup reporting and navigation undo throw', async () => {
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'incident-reporting-cleanup-'));
    try {
        const host=renderer(), rec=recorder({name:'report-cleanup',outDir}), check=rec.check, reporting=Error('REPORTING_FAILURE');
        let removeAttempts=0, navigation='private-script';
        const page={eval:host.eval,send:async(method)=>{
            if(method==='Page.enable') return {};
            if(method==='Page.addScriptToEvaluateOnNewDocument') return {identifier:navigation};
            if(method==='Page.removeScriptToEvaluateOnNewDocument' && (++removeAttempts)===1) throw Error('NAVIGATION_UNDO_FAILURE');
            navigation=undefined; return {};
        }};
        const incident=await armIncidentDiagnostics({page,rec});
        rec.check=(...args)=>{ const result=check(...args); if(args[0]==='diagnostic cleanup: navigation script') throw reporting; return result; };
        let firstFailure;
        try { await incident.close(); } catch(error) { firstFailure=error; }
        expect(firstFailure).toBeInstanceOf(AggregateError);
        expect(firstFailure.errors).toContain(reporting);
        expect(firstFailure.errors.some(error=>String(error).includes('NAVIGATION_UNDO_FAILURE'))).toBe(true);
        expect(host.listeners.size).toBe(0);
        expect(navigation).toBe('private-script');
        await incident.close();
        expect(removeAttempts).toBe(2);
        expect(navigation).toBeUndefined();
        expect(fs.existsSync(path.join(outDir,'report-cleanup-incident-cleanup-attempt-2.json'))).toBe(true);
    } finally { fs.rmSync(outDir,{recursive:true,force:true}); }
});

it('keeps a successfully reported recovered renderer undo nonthrowing', async () => {
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'incident-close-compat-'));
    try {
        const host=renderer(), rec=recorder({name:'close-compat',outDir});
        await host.eval(`let undoFailures=0; terminalLab.terminal=new Proxy(terminalLab.terminal,{defineProperty(target,name,descriptor){
            if(globalThis.failRestore&&name==='getSelection'&&undoFailures++===0)throw Error('TRANSIENT_UNDO_FAILURE');
            return Reflect.defineProperty(target,name,descriptor);
        }});`);
        const incident=await armIncidentDiagnostics({page:{eval:host.eval},rec});
        await host.eval('globalThis.failRestore=true');
        await expect(incident.close()).resolves.toBeUndefined();
        const cleanup=JSON.parse(fs.readFileSync(path.join(outDir,'close-compat-incident-cleanup.json'),'utf8')).find(entry=>entry.name==='host');
        expect(cleanup).toMatchObject({restored:true, outstandingRestores:0, ownerRetained:false});
        expect(cleanup.errors).toContain('TRANSIENT_UNDO_FAILURE');
        expect(rec.results.some(entry=>entry.failureClass==='cleanup'&&!entry.ok&&entry.detail.includes('TRANSIENT_UNDO_FAILURE'))).toBe(true);
        expect(host.listeners.size).toBe(0);
        expect(await host.eval('Boolean(globalThis.__kelpiIncidentRecorder)')).toBe(false);
    } finally { fs.rmSync(outDir,{recursive:true,force:true}); }
});

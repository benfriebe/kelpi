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
            expect(rec.summary().failed).toBe(1);
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

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { watchRendererErrors } from './renderer-errors.mjs';
import {
    DEDICATED_SCENARIO,
    RENDERER_CHECK,
    SHARED_SCENARIO,
    STARTUP_CONSOLE,
    STARTUP_EXCEPTION,
    assessFaultRun,
    assessHealthyRun,
    injectStartupIncidentHtml,
    runningRuntimeProcesses
} from '../fixtures/renderer-startup-incident.mjs';

const recorder = () => ({ results: [], check(...args) { this.results.push(args); } });
const exception = (description) => ({ exceptionDetails: { exception: { description } } });

describe('renderer error ownership', () => {
    it('defaults attached sessions to post-attach coverage and retains it on every finish', async () => {
        const page = new EventEmitter(); page.send = async () => {};
        const watcher = await watchRendererErrors(page);
        const coverages = [];
        const rec = { ...recorder(), recordRendererCoverage: coverage => coverages.push(coverage) };
        watcher.finish(rec); watcher.finish(rec);
        expect(watcher.coverage).toMatchObject({ scope: 'post-attach', firstDocument: false });
        expect(coverages).toEqual([watcher.coverage, watcher.coverage]);
        expect(Object.isFrozen(watcher.coverage)).toBe(true);
    });

    it('records refused enable as uncovered even when setup requested pre-first-load', async () => {
        const page = new EventEmitter(); page.send = async () => { throw Error('enable denied'); };
        const watcher = await watchRendererErrors(page, { scope: 'pre-first-load' });
        expect(watcher.coverage).toMatchObject({ scope: 'pre-first-load', firstDocument: false, enabledAt: null });
        const rec = recorder(); watcher.finish(rec);
        expect(rec.results[0][1]).toBe(false);
    });

    it('rejects unknown watcher scope before subscribing', async () => {
        const page = new EventEmitter(); page.send = async () => {};
        await expect(watchRendererErrors(page, { scope: 'full native proof' })).rejects.toThrow('unknown renderer watcher scope');
        expect(page.eventNames()).toEqual([]);
    });

    it('subscribes before Runtime.enable acknowledges and drains each interval once', async () => {
        const page = new EventEmitter();
        page.send = async (method) => {
            expect(method).toBe('Runtime.enable');
            page.emit('Runtime.exceptionThrown', exception('first mount failed'));
            page.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'first console error' }] });
        };
        const watcher = await watchRendererErrors(page);
        expect(watcher.hasErrors).toBe(true);
        const first = recorder();
        watcher.finish(first);
        expect(first.results).toEqual([['the renderer threw nothing and logged no error', false,
            'uncaught: first mount failed | console.error: first console error']]);
        expect(watcher.hasErrors).toBe(false);
        const second = recorder();
        watcher.finish(second);
        expect(second.results[0][1]).toBe(true);
        page.emit('Runtime.exceptionThrown', exception('between scenarios'));
        const third = recorder();
        watcher.finish(third);
        expect(third.results[0][2]).toBe('uncaught: between scenarios');
    });

    it('keeps independent instances separate and ignores ordinary console output', async () => {
        const lane = new EventEmitter();
        const dedicated = new EventEmitter();
        lane.send = dedicated.send = async () => {};
        const laneWatch = await watchRendererErrors(lane);
        const dedicatedWatch = await watchRendererErrors(dedicated);
        lane.emit('Runtime.exceptionThrown', exception('idle lane'));
        dedicated.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'ordinary' }] });
        dedicated.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ description: 'dedicated failure' }] });
        const own = recorder();
        dedicatedWatch.finish(own);
        expect(own.results[0][2]).toBe('console.error: dedicated failure');
        const shared = recorder();
        laneWatch.finish(shared);
        expect(shared.results[0][2]).toBe('uncaught: idle lane');
    });

    it('reports a refused Runtime.enable on every interval, never a clean console', async () => {
        const page = new EventEmitter();
        page.send = async () => { throw new Error('session unavailable'); };
        const watcher = await watchRendererErrors(page);
        expect(watcher.hasErrors).toBe(false);
        expect(watcher.enableError).toBe('session unavailable');
        for (let i = 0; i < 2; i++) {
            const rec = recorder();
            watcher.finish(rec);
            expect(rec.results).toEqual([['the renderer was watched for errors', false, 'Runtime.enable: session unavailable']]);
        }
    });

    it('deduplicates and bounds reported errors', async () => {
        const page = new EventEmitter();
        page.send = async () => {};
        const watcher = await watchRendererErrors(page);
        for (let i = 0; i < 10; i++) page.emit('Runtime.exceptionThrown', exception('repeat'));
        for (let i = 0; i < 10; i++) page.emit('Runtime.exceptionThrown', exception(String(i).repeat(3000)));
        const rec = recorder();
        watcher.finish(rec);
        expect(rec.results[0][2].split(' | ')).toHaveLength(5);
        expect(rec.results[0][2].split(' | ')[1]).toHaveLength(2000);
    });
});

const rendererResult = (ok, detail) => ({ label: RENDERER_CHECK, ok, ...(detail === undefined ? {} : { detail }) });

describe('renderer startup incident regression fixture', () => {
    it('places one console error and one synchronous throw before the first module', () => {
        const html = '<html><head><script type="module" src="/app.js"></script></head><body><div id="root"></div></body></html>';
        const injected = injectStartupIncidentHtml(html);
        expect(injected.indexOf('data-kelpi-startup-incident')).toBeLessThan(injected.indexOf('type="module"'));
        expect(injected.split(STARTUP_CONSOLE)).toHaveLength(2);
        expect(injected.split(STARTUP_EXCEPTION)).toHaveLength(2);
        expect(injected).toContain('console.error');
        expect(injected).toContain('throw new Error');
    });

    it('accepts only one attributed renderer failure for both shared and dedicated paths', () => {
        const detail = `console.error: ${STARTUP_CONSOLE} | uncaught: Error: ${STARTUP_EXCEPTION}`;
        const report = { summaries: [
            { name: SHARED_SCENARIO, failed: 1, results: [{label: `${SHARED_SCENARIO} native shell identity is live`, ok:true}, {label: `${SHARED_SCENARIO} body ran`, ok:true}, rendererResult(false, detail)] },
            { name: DEDICATED_SCENARIO, ownInstance: true, failed: 1, results: [{label: `${DEDICATED_SCENARIO} native shell identity is live`, ok:true}, {label: `${DEDICATED_SCENARIO} body ran`, ok:true}, rendererResult(false, detail)] }
        ] };
        expect(assessFaultRun(report, 1).ok).toBe(true);
        expect(assessFaultRun(report, 0).ok).toBe(false);
        report.summaries[0].results[2].detail += ` | console.error: ${STARTUP_CONSOLE}`;
        expect(assessFaultRun(report, 1).shared.ok).toBe(false);
    });

    it('separates a missed incident from unrelated failures and runner exits', () => {
        const missed = {summaries:[SHARED_SCENARIO, DEDICATED_SCENARIO].map((name,index)=>({
            name,ownInstance:index===1,failed:0,results:[
                {label:`${name} native shell identity is live`,ok:true},
                {label:`${name} body ran`,ok:true},rendererResult(true,'')
            ]
        }))};
        expect(assessFaultRun(missed,0)).toMatchObject({ok:false,valid:true,errors:[]});
        expect(assessFaultRun(missed,2).valid).toBe(false);
        const unrelated = structuredClone(missed);
        unrelated.summaries[0].results[0].ok=false; unrelated.summaries[0].failed=1;
        expect(assessFaultRun(unrelated,1).valid).toBe(false);
        const noise = structuredClone(missed);
        noise.summaries[0].results[2]=rendererResult(false,'uncaught: unrelated setup failure'); noise.summaries[0].failed=1;
        expect(assessFaultRun(noise,1).valid).toBe(false);
        const missingControl = structuredClone(missed); missingControl.summaries[0].results.shift();
        expect(assessFaultRun(missingControl,0).valid).toBe(false);
        expect(assessFaultRun({...missed,leaks:['leftover process']},0).valid).toBe(false);
    });

    it('never interprets a failed process scan as successful cleanup', () => {
        expect(()=>runningRuntimeProcesses('/private/tmp/incident',()=>({status:1,stdout:'',stderr:'denied'}))).toThrow(/process scan failed/);
        expect(()=>runningRuntimeProcesses('/private/tmp/incident',()=>({status:null,stdout:'',signal:'SIGTERM'}))).toThrow(/process scan failed/);
        expect(runningRuntimeProcesses('/private/tmp/incident',()=>({status:0,stdout:'42 /private/tmp/incident/shell\n84 /somewhere/else\n'}))).toEqual([{pid:42,command:'/private/tmp/incident/shell'}]);
    });

    it('rejects setup failures, wrong attribution, and slow or dirty healthy controls', () => {
        expect(assessFaultRun({ summaries: [] }, 1).ok).toBe(false);
        const healthy = { summaries: [{ name: 'issue-239-healthy-boot', failed: 0, results: [
            rendererResult(true),
            {label:'issue-239-healthy-boot native shell identity is live',ok:true},
            {label:'issue-239-healthy-boot body ran',ok:true},
            {label:'healthy app root mounted',ok:true}
        ] }] };
        expect(assessHealthyRun(healthy, 0, 2_000).ok).toBe(true);
        expect(assessHealthyRun(healthy, 1, 2_000).ok).toBe(false);
        expect(assessHealthyRun(healthy, 0, 60_001).ok).toBe(false);
        healthy.summaries[0].results[1].ok = false;
        expect(assessHealthyRun(healthy, 0, 2_000).ok).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { watchRendererErrors } from './renderer-errors.mjs';

const recorder = () => ({ results: [], check(...args) { this.results.push(args); } });
const exception = (description) => ({ exceptionDetails: { exception: { description } } });

describe('renderer error ownership', () => {
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

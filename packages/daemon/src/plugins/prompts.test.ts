import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginObject, type JsonObject, type PluginContext } from '@kelpi/protocol';
import { createStore } from '../store/store.js';
import { seededState } from '../store/testing.js';
import { PluginService, type PluginServiceOptions } from './service.js';

const id = 'sample.board';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
// The SDK's KelpiError keeps the daemon's whole message, NO_WINDOW prefix included, so a test sees what the daemon refused with.
const backend = `export function activate(api) {
    const ask = args => api.ui[args.method ?? 'showDialog'](args.options ?? { title: 'Run it?', message: 'echo hi', actions: [{ id: 'run', label: 'Run' }] }, args.target);
    api.commands.register('${id}.run', ask);
    api.commands.register('${id}.hang', async args => { await new Promise(resolve => setTimeout(resolve, args.delay ?? 0)); await ask(args); return new Promise(() => {}); });
    api.commands.register('${id}.idle', () => new Promise(() => {}));
    api.commands.register('${id}.crash', () => process.exit(3));
}`;
async function harness(extra: Partial<PluginServiceOptions> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-prompts-test-'));
    const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
    const commands = ['run', 'hang', 'idle', 'crash'].map(name => ({ id: `${id}.${name}`, title: name }));
    const manifest = { id, name: 'Board', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'startup', backend: 'backend.mjs', contributes: { views: [{ id: `${id}.view`, title: 'Board', entry: 'ui/index.html', placements: ['pane'] }], commands } };
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(source, 'backend.mjs'), backend);
    fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<h1>Board</h1>');
    const command = vi.fn(async (): Promise<JsonObject> => ({ ok: true })); const broadcast = vi.fn();
    const service = new PluginService({ directory: path.join(root, 'plugins'), store: createStore(seededState()), command, broadcast, ...extra });
    cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    await service.install(source, true);
    const frames = (type: string): JsonObject[] => broadcast.mock.calls.map(call => call[0] as JsonObject).filter(frame => frame['type'] === type);
    /** The `n`th (0-based) prompt frame, once the backend's call reaches the daemon. */
    const prompt = async (n = 0): Promise<JsonObject> => { await vi.waitFor(() => expect(frames('plugin-prompt').length).toBeGreaterThan(n)); return frames('plugin-prompt')[n]!; };
    const window = (windowID = 'WIN', clientID = 'C'): PluginContext => ({ daemonID: service.daemonID, clientID, windowID });
    const run = (name: string, args: JsonObject = {}, context: PluginContext = window()) => service.request('run', { command: `${id}.${name}`, args }, context);
    const answer = async (frame: JsonObject, reply: JsonObject, context = window(String(frame['windowID']))) => {
        await service.request('prompt-ack', { requestID: frame['requestID']! }, context);
        await service.request('prompt-reply', { requestID: frame['requestID']!, ...reply }, context);
    };
    return { service, broadcast, frames, prompt, window, run, answer };
}

describe('backend prompts (#389)', () => {
    it('routes a dialog to the invoking window and settles the command with the answer', async () => {
        const h = await harness();
        const options = { title: 'Run it?', message: 'echo hi', actions: [{ id: 'run', label: 'Run' }, { id: 'cancel', label: 'Cancel' }] };
        const chosen = h.run('run', { options });
        const frame = await h.prompt();
        expect(frame).toEqual({ type: 'plugin-prompt', requestID: expect.any(String), windowID: 'WIN', pluginID: id, pluginName: 'Board', method: 'ui.showDialog', options });
        await h.answer(frame, { value: 'run' });
        expect(await chosen).toBe('run');
        await expect(h.service.request('prompt-reply', { requestID: frame['requestID']!, value: 'run' }, h.window())).rejects.toThrow('unknown prompt request');
        const dismissed = h.run('run');
        await h.answer(await h.prompt(1), { value: null });
        expect(await dismissed).toBeNull();
        const failed = h.run('run');
        await h.answer(await h.prompt(2), { error: 'too many window prompts' });
        await expect(failed).rejects.toThrow('too many window prompts');
    });
    it('routes all four methods with the same request shape', async () => {
        const h = await harness();
        const methods = ['showDialog', 'showQuickPick', 'showInput', 'showNotification'];
        for (const [index, method] of methods.entries()) {
            const result = h.run('run', { method, options: { title: method } });
            const frame = await h.prompt(index);
            expect(frame).toMatchObject({ windowID: 'WIN', method: `ui.${method}`, options: { title: method } });
            await h.answer(frame, { value: method });
            expect(await result).toBe(method);
        }
    });
    it('refuses a command with no window, before broadcasting anything', async () => {
        const h = await harness();
        await expect(h.service.request('run', { command: `${id}.run` }, { daemonID: h.service.daemonID })).rejects.toThrow(/^NO_WINDOW: the command has no window/);
        expect(h.frames('plugin-prompt')).toEqual([]);
        await expect(h.run('run', { target: { windowID: '' } }, { daemonID: h.service.daemonID })).rejects.toThrow(/^NO_WINDOW: /);
    });
    it('refuses an explicit windowID of 200 characters or more', async () => {
        const h = await harness();
        await expect(h.run('run', { target: { windowID: 'W'.repeat(200) } })).rejects.toThrow('invalid windowID');
        expect(h.frames('plugin-prompt')).toEqual([]);
    });
    it('refuses a reply with neither a text value nor an error and keeps the prompt open', async () => {
        const h = await harness();
        const result = h.run('run');
        const frame = await h.prompt();
        await h.service.request('prompt-ack', { requestID: frame['requestID']! }, h.window());
        await expect(h.service.request('prompt-reply', { requestID: frame['requestID']!, value: 42 }, h.window())).rejects.toThrow('prompt reply needs a value or an error');
        await h.service.request('prompt-reply', { requestID: frame['requestID']!, value: 'run' }, h.window());
        expect(await result).toBe('run');
    });
    it('lets an explicit window win and refuses acks and replies from any other window', async () => {
        const h = await harness();
        const result = h.run('run', { target: { windowID: 'OTHER' } });
        const frame = await h.prompt();
        expect(frame['windowID']).toBe('OTHER');
        await expect(h.service.request('prompt-ack', { requestID: frame['requestID']! }, h.window())).rejects.toThrow('prompt belongs to another window');
        await expect(h.service.request('prompt-reply', { requestID: frame['requestID']!, value: 'run' }, h.window())).rejects.toThrow('prompt belongs to another window');
        await expect(h.service.request('prompt-reply', { requestID: frame['requestID']!, value: 'run' }, { daemonID: h.service.daemonID })).rejects.toThrow('prompt belongs to another window');
        await h.answer(frame, { value: 'other' });
        expect(await result).toBe('other');
    });
    it('cancels a pending prompt when its backend is disabled, reloaded or crashes', async () => {
        const h = await harness();
        const cancelled = (frame: JsonObject) => expect(h.frames('plugin-prompt-cancel')).toContainEqual({ type: 'plugin-prompt-cancel', requestID: frame['requestID'], windowID: 'WIN' });
        const reloaded = expect(h.run('run')).rejects.toThrow('plugin stopped');
        const first = await h.prompt();
        await h.service.request('prompt-ack', { requestID: first['requestID']! }, h.window());
        await h.service.request('reload', { pluginID: id }); await reloaded;
        cancelled(first);
        await expect(h.service.request('prompt-reply', { requestID: first['requestID']!, value: 'run' }, h.window())).rejects.toThrow('unknown prompt request');
        const crashed = expect(h.run('run')).rejects.toThrow('plugin exited');
        const second = await h.prompt(1);
        await expect(h.run('crash')).rejects.toThrow('plugin exited'); await crashed;
        cancelled(second);
        await h.service.request('reload', { pluginID: id });
        const disabled = expect(h.run('run')).rejects.toThrow('plugin stopped');
        const third = await h.prompt(2);
        await h.service.request('disable', { pluginID: id }); await disabled;
        cancelled(third);
    });
    it('cancels pending prompts when the daemon disposes the service', async () => {
        const h = await harness();
        const result = expect(h.run('run')).rejects.toThrow('plugin stopped');
        const frame = await h.prompt();
        await h.service.dispose(); await result;
        expect(h.frames('plugin-prompt-cancel')).toEqual([{ type: 'plugin-prompt-cancel', requestID: frame['requestID'], windowID: 'WIN' }]);
    });
    it('dismisses a prompt whose acknowledging client disconnects, without a cancel frame', async () => {
        const h = await harness();
        const result = h.run('run');
        const frame = await h.prompt();
        await h.service.request('prompt-ack', { requestID: frame['requestID']! }, h.window('WIN', 'C'));
        h.service.releaseClient('other');
        h.service.releaseClient('C');
        expect(await result).toBeNull();
        expect(h.frames('plugin-prompt-cancel')).toEqual([]);
    });
    it('gives up on a prompt no window acknowledges, but not on one that was acknowledged', async () => {
        const h = await harness({ promptAckTimeoutMs: 1000 });
        const unseen = h.run('run');
        const frame = await h.prompt();
        await expect(unseen).rejects.toThrow('NO_WINDOW: no window presented the prompt');
        expect(h.frames('plugin-prompt-cancel')).toEqual([{ type: 'plugin-prompt-cancel', requestID: frame['requestID'], windowID: 'WIN' }]);
        const seen = h.run('run');
        const next = await h.prompt(1);
        await h.service.request('prompt-ack', { requestID: next['requestID']! }, h.window());
        await new Promise(resolve => setTimeout(resolve, 1500));
        await h.service.request('prompt-reply', { requestID: next['requestID']!, value: 'late' }, h.window());
        expect(await seen).toBe('late');
    }, 15_000);
    it('caps a backend at 8 pending prompts and accepts more once one settles', async () => {
        const h = await harness();
        const results = Array.from({ length: 8 }, () => h.run('run'));
        await h.prompt(7);
        await expect(h.run('run')).rejects.toThrow('too many pending prompts for this plugin');
        expect(h.frames('plugin-prompt')).toHaveLength(8);
        await h.answer(h.frames('plugin-prompt')[0]!, { value: 'first' });
        expect(await results[0]).toBe('first');
        const ninth = h.run('run');
        await h.answer(await h.prompt(8), { value: 'ninth' });
        expect(await ninth).toBe('ninth');
        for (const frame of h.frames('plugin-prompt').slice(1, 8)) await h.answer(frame, { value: null });
        expect(await Promise.all(results.slice(1))).toEqual(Array(7).fill(null));
    });
    it('holds the command timeout while its prompt is open and restores the rest afterwards', async () => {
        const h = await harness({ commandTimeoutMs: 1000 });
        await expect(h.run('idle')).rejects.toThrow(`plugin invocation timed out: command:${id}.idle`);
        const slow = h.run('run');
        const frame = await h.prompt();
        await new Promise(resolve => setTimeout(resolve, 1500));
        await h.answer(frame, { value: 'run' });
        expect(await slow).toBe('run');
        // Answered, the command's clock runs again with what it had left (at most 400 ms here), not a fresh budget.
        const hung = h.run('hang', { delay: 600 });
        const next = await h.prompt(1);
        await new Promise(resolve => setTimeout(resolve, 1500));
        const answered = Date.now();
        await h.answer(next, { value: 'run' });
        await expect(hung).rejects.toThrow('plugin invocation timed out');
        expect(Date.now() - answered).toBeLessThan(800);
    }, 15_000);
    it('settles the prompt of a cancelled parent without re-arming the parent\'s clock', async () => {
        const h = await harness();
        const sent: JsonObject[] = []; let disconnect: (() => void) | undefined;
        const reply = { closed: false, send: (value: JsonObject) => { sent.push(value); }, close: () => { reply.closed = true; }, onDisconnect: (handler: () => void) => { disconnect = handler; } };
        h.service.run('run', { command: `${id}.run` }, reply as never, h.window());
        const frame = await h.prompt();
        await h.service.request('prompt-ack', { requestID: frame['requestID']! }, h.window());
        disconnect?.();
        await vi.waitFor(() => expect(sent).toEqual([{ ok: false, error: 'plugin invocation cancelled' }]));
        // The parent is gone, so the answer resumes nothing: no timer is armed to fire later.
        const timers = vi.spyOn(globalThis, 'setTimeout');
        try {
            await h.service.request('prompt-reply', { requestID: frame['requestID']!, value: 'run' }, h.window());
            expect(timers).not.toHaveBeenCalled();
        } finally { timers.mockRestore(); }
        await expect(h.service.request('prompt-reply', { requestID: frame['requestID']!, value: 'run' }, h.window())).rejects.toThrow('unknown prompt request');
        expect(h.frames('plugin-prompt-cancel')).toEqual([]);
    });
    it('refuses the prompt methods for a view, whose host presents them itself', async () => {
        const h = await harness();
        const attached = pluginObject(await h.service.request('attach', { pluginID: id, viewID: `${id}.view` }, h.window()));
        await expect(h.service.request('api', { lease: attached['lease']!, method: 'ui.showDialog', args: { options: { title: 'x' } } }, h.window())).rejects.toThrow('window UI methods are presented by the view host');
        expect(h.frames('plugin-prompt')).toEqual([]);
    });
});

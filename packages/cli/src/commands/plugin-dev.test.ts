import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPluginPackage } from '@kelpi/core/plugin-package';
import { startPluginDev, type PluginDevController, type PluginDevEvent } from './plugin-dev.js';

const roots: string[] = [], controllers: PluginDevController[] = [];
afterEach(async () => {
    for (const controller of controllers.splice(0)) await controller.stop();
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const manifest = (id = 'example.dev') => ({ id, name: 'Dev', version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs', contributes: {} });
async function fixture() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kelpi-plugin-dev-test-')); roots.push(directory);
    const write = (name: string, content: string) => fs.writeFile(path.join(directory, name), content);
    await write('kelpi.plugin.json', JSON.stringify(manifest()));
    await write('backend.mjs', 'export function activate() {}');
    return { directory, write };
}
async function run(directory: string, apply: Parameters<typeof startPluginDev>[1]['apply']) {
    const events: PluginDevEvent[] = [];
    const controller = await startPluginDev(directory, { trust: true, apply, onEvent: event => events.push(event), pollIntervalMs: 20 });
    controllers.push(controller);
    return { controller, events };
}

describe('plugin dev', () => {
    it('requires opt-in trust and a directory before installing signal handlers or invoking code', async () => {
        const h = await fixture(), apply = vi.fn(), onEvent = vi.fn();
        const signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
        await expect(startPluginDev(h.directory, { trust: false, apply, onEvent })).rejects.toThrow('--trust');
        await expect(startPluginDev(path.join(h.directory, 'backend.mjs'), { trust: true, apply, onEvent })).rejects.toThrow('directory');
        expect(apply).not.toHaveBeenCalled(); expect(onEvent).not.toHaveBeenCalled();
        expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(signals);
    });

    it('installs exact captured bytes, serializes changes, and cleans snapshots without removing the installed revision', async () => {
        const h = await fixture();
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const snapshots: { path: string; revision: string }[] = [];
        const apply = vi.fn(async (snapshot: { path: string; revision: string }) => {
            snapshots.push(snapshot);
            if (snapshots.length === 1) await blocked;
            expect((await readPluginPackage(snapshot.path)).revision).toBe(snapshot.revision);
        });
        const { controller, events } = await run(h.directory, apply);
        try {
            await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
            await h.write('backend.mjs', 'export function activate() { return "edit one"; }');
            await pause(70);
            await h.write('backend.mjs', 'export function activate() { return "edit two"; }');
            expect(apply).toHaveBeenCalledTimes(1);
            expect(await fs.readFile(path.join(snapshots[0]!.path, 'backend.mjs'), 'utf8')).toBe('export function activate() {}');
            release();
            await vi.waitFor(() => expect(events.filter(event => event.type === 'applied')).toHaveLength(2));
            expect(snapshots[1]!.revision).toBe((await readPluginPackage(h.directory)).revision);
            await pause(80); expect(apply).toHaveBeenCalledTimes(2);
        } finally { release(); await controller.stop(); }
        for (const snapshot of snapshots) await expect(fs.stat(snapshot.path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(path.join(h.directory, 'backend.mjs'), 'utf8')).toContain('edit two');
        expect(await controller.done).toEqual({ signal: null });
    });

    it('keeps the last successful revision through invalid edits and failed installs, then applies a repaired edit', async () => {
        const h = await fixture();
        const apply = vi.fn<Parameters<typeof startPluginDev>[1]['apply']>().mockResolvedValue(undefined);
        const { events } = await run(h.directory, apply);
        await vi.waitFor(() => expect(events.some(event => event.type === 'applied')).toBe(true));
        await h.write('kelpi.plugin.json', '{');
        await vi.waitFor(() => expect(events.some(event => event.type === 'invalid')).toBe(true));
        await pause(70);
        expect(events.filter(event => event.type === 'invalid')).toHaveLength(1);
        expect(apply).toHaveBeenCalledTimes(1);
        await h.write('kelpi.plugin.json', JSON.stringify(manifest()));
        await h.write('backend.mjs', 'export function activate() { throw new Error("bad edit"); }');
        apply.mockRejectedValueOnce(new Error('activation refused; previous revision restored'));
        await vi.waitFor(() => expect(events.some(event => event.type === 'failed')).toBe(true));
        await pause(70);
        expect(apply).toHaveBeenCalledTimes(2);
        expect(events.filter(event => event.type === 'applied')).toHaveLength(1);
        await h.write('backend.mjs', 'export function activate() { return "fixed"; }');
        await vi.waitFor(() => expect(events.filter(event => event.type === 'applied')).toHaveLength(2));
        expect(apply).toHaveBeenCalledTimes(3);
    });

    it('recovers an initially invalid package but refuses a changed plugin identity', async () => {
        const h = await fixture(); await h.write('kelpi.plugin.json', '{');
        const apply = vi.fn().mockResolvedValue(undefined);
        const { events } = await run(h.directory, apply);
        await vi.waitFor(() => expect(events.some(event => event.type === 'invalid')).toBe(true));
        expect(apply).not.toHaveBeenCalled();
        await h.write('kelpi.plugin.json', JSON.stringify(manifest()));
        await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
        await h.write('kelpi.plugin.json', JSON.stringify(manifest('example.other')));
        await vi.waitFor(() => expect(events.some(event => event.type === 'invalid' && event.error.includes('plugin id changed'))).toBe(true));
        await pause(70); expect(apply).toHaveBeenCalledOnce();
        await h.write('kelpi.plugin.json', JSON.stringify(manifest()));
        await h.write('backend.mjs', 'export function activate() { return "same plugin"; }');
        await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    });

    it.each(['SIGINT', 'SIGTERM'] as const)('handles %s by awaiting an in-flight install, removing signal listeners and stopping subsequent edits', async signal => {
        const h = await fixture();
        const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const apply = vi.fn(() => blocked);
        const { controller, events } = await run(h.directory, apply);
        try {
            await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
            const closed = vi.fn(); void controller.done.then(closed);
            process.emit(signal);
            await pause(30); expect(closed).not.toHaveBeenCalled();
            expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
            await h.write('backend.mjs', 'changed while stopping');
            release();
            expect(await controller.done).toEqual({ signal });
            await controller.stop(); await controller.stop();
            await pause(70); expect(apply).toHaveBeenCalledOnce();
            expect(events.filter(event => event.type === 'stopped')).toEqual([{ type: 'stopped', signal }]);
        } finally { release(); }
    });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@kelpi/protocol';
import { decodePluginManifest } from '../../protocol/src/plugins.js';
import { createStore } from '../../daemon/src/store/store.js';
import { seededState } from '../../daemon/src/store/testing.js';
import { PluginService } from '../../daemon/src/plugins/service.js';
import type { BackendAPI, Data, UIDialogOptions } from '../index.js';

// #389: Interaction Lab's backend asks "Run it?" from a shortcut. The example is plain ESM.
const source = fileURLToPath(new URL('../../../examples/plugins/interaction-lab/', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function ask(answer: string | null) {
    const { activate } = await import(path.join(source, 'backend.mjs')) as { activate(api: BackendAPI): void };
    const handlers = new Map<string, (args: Data) => Promise<unknown>>();
    const showDialog = vi.fn(async (_options: UIDialogOptions) => answer);
    const showNotification = vi.fn(async () => null);
    activate({ commands: { register: (id: string, handler: (args: Data) => Promise<unknown>) => { handlers.set(id, handler); return () => {}; } }, ui: { showDialog, showNotification } } as unknown as BackendAPI);
    return { result: await handlers.get('example.interaction-lab.ask')?.({}), showDialog, showNotification };
}

describe('Interaction Lab backend prompt example', () => {
    it('declares the backend command with its shortcut in a valid manifest', () => {
        const manifest = decodePluginManifest(JSON.parse(fs.readFileSync(path.join(source, 'kelpi.plugin.json'), 'utf8')));
        expect(manifest).toMatchObject({ backend: 'backend.mjs', activation: 'on-demand' });
        expect(manifest.contributes.commands).toEqual([{ id: 'example.interaction-lab.ask', title: 'Interaction Lab: Ask before running', shortcut: 'ctrl+alt+i' }]);
        expect(manifest.contributes.views.map(view => view.placements)).toEqual([['interaction.palette'], ['interaction.prompts'], ['interaction.notifications']]);
    });

    it('asks with a dialog, reports the answer and returns the action id', async () => {
        const run = await ask('run');
        expect(run.showDialog).toHaveBeenCalledWith({ title: 'Run it?', message: expect.any(String), cancelID: 'cancel', actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'run', label: 'Run', kind: 'primary' }] });
        expect(run.showNotification).toHaveBeenCalledWith({ message: 'Interaction Lab: run', tone: 'success' });
        expect(run.result).toBe('run');
        const escaped = await ask(null);
        expect(escaped.showNotification).toHaveBeenCalledWith({ message: 'Interaction Lab: cancelled', tone: 'info' });
        expect(escaped.result).toBeNull();
    });

    it('rejects a CLI run, which has no window to ask in', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-interaction-lab-'));
        const broadcast = vi.fn<(event: JsonObject) => void>();
        const service = new PluginService({ directory: root, store: createStore(seededState()), command: async () => ({ ok: true }), broadcast });
        cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
        await service.install(source, true);
        await expect(service.request('run', { command: 'example.interaction-lab.ask', args: {} })).rejects.toThrow(/the command has no window/);
        expect(broadcast.mock.calls.some(([message]) => message['type'] === 'plugin-prompt')).toBe(false);
    });
});

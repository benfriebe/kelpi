import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_MAX_JSON_BYTES, type JsonObject, type JsonValue, type PluginContext } from '@kelpi/protocol';
import type { BuiltinServiceHost } from '../plugins/builtin-services.js';
import { PluginService } from '../plugins/service.js';
import { harness, id, NOW, seededState, W1 } from '../store/testing.js';
import { createContentService, type ContentGit, type ContentPaneState } from './service.js';
import { CONTENT_RENDER_SERVICE, createContentRenderService } from './render-service.js';

const MD = id('eeeeeeee', 21), DIFF = id('eeeeeeee', 22), SHELL = id('dddddddd', 100);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(source = '# Original\n') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-render-provider-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, source);
    const store = harness(seededState(W1, SHELL));
    store.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: MD, filePath: file, now: NOW });
    store.dispatch({ type: 'open-diff-pane', workspaceID: W1, paneID: DIFF, repoPath: dir, now: NOW });
    const provider = { selected: false };
    const call = vi.fn<BuiltinServiceHost['callService']>(async input => ({ html: `<h1>Custom ${String((input['args'] as JsonObject)['kind'])}</h1>` }));
    const host: BuiltinServiceHost = { daemonID: 'test-daemon', hasSelectedProvider: (service, version) => provider.selected && service === CONTENT_RENDER_SERVICE && version === 1, callService: call };
    const services = { current: host };
    const errors = vi.fn();
    const getDiff = vi.fn<ContentGit['getDiff']>(async () => 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n');
    const service = createContentService({ store: store.store, git: { getDiff }, services: () => services.current, watch: false, debounceMs: 10_000, onError: errors });
    cleanups.push(() => service.dispose());
    const seen: ContentPaneState[] = [];
    return { dir, file, store, provider, call, service, seen, errors, getDiff, services };
}

function defer(f: ReturnType<typeof fixture>) {
    const calls: Array<{ input: JsonObject; context: PluginContext | undefined; signal: AbortSignal | undefined; resolve(value: JsonValue): void; reject(error: Error): void }> = [];
    f.call.mockImplementation((input, context, signal) => new Promise((resolve, reject) => calls.push({ input, context, signal, resolve, reject })));
    return calls;
}

describe('native content renderer service contract', () => {
    it('exposes the existing bundled markdown and diff renderers with validated arguments', async () => {
        const service = createContentRenderService();
        expect(service).toMatchObject({ id: 'kelpi.content.render', version: 1 });
        const render = service.methods['render']!;
        const args = { kind: 'markdown', source: '# Heading', backgroundColor: '#FFFFFF', fontSize: 18, assetBase: '/pane-assets/example/' };
        render.validateArgs(args);
        const result = await render.run(args, { daemonID: 'D' });
        render.validateResult(result);
        expect(result).toMatchObject({ html: expect.stringContaining('<h1>Heading</h1>') });
        expect((result as JsonObject)['html']).toContain('<base href="/pane-assets/example/">');
        expect((result as JsonObject)['html']).toContain('<html class="light">');
        expect(await render.run({ ...args, kind: 'diff', source: '', assetBase: null }, { daemonID: 'D' })).toMatchObject({ html: expect.stringContaining('No changes') });
        for (const invalid of [{ ...args, kind: 'shell' }, { ...args, source: null }, { ...args, fontSize: 7 }, { ...args, fontSize: 33 }, { ...args, backgroundColor: null }, { ...args, assetBase: false }]) expect(() => render.validateArgs(invalid)).toThrow();
        expect(() => render.validateResult({ html: 42 })).toThrow('html');
        const controller = new AbortController(); controller.abort();
        expect(() => render.run(args, { daemonID: 'D' }, controller.signal)).toThrow('cancelled');
    });
});

describe('selected providers in native content panes', () => {
    it.each(['markdown', 'diff'] as const)('invalidates %s document revisions before refreshed source finishes rendering', async kind => {
        const f = fixture(); f.provider.selected = true;
        const paneID = kind === 'markdown' ? MD : DIFF;
        await f.service.subscribe(paneID, () => {});
        const initial = await f.service.document(paneID);
        const pending = defer(f);
        const source = kind === 'markdown' ? '# New source\n' : 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+latest\n';
        if (kind === 'markdown') fs.writeFileSync(f.file, source);
        else f.getDiff.mockResolvedValue(source);
        const refreshing = f.service.refresh(paneID);
        await vi.waitFor(() => expect(pending).toHaveLength(1));

        const loaded = await f.service.document(paneID);
        expect(loaded.text).toBe(source);
        expect(loaded.revision).not.toBe(initial.revision);
        await expect(f.service.save(paneID, { revision: initial.revision })).rejects.toThrow('DOCUMENT_CONFLICT');
        if (kind === 'markdown') {
            await expect(f.service.setMode(paneID, 'edit', { revision: initial.revision })).rejects.toThrow('DOCUMENT_CONFLICT');
        }
        pending[0]!.resolve({ html: '<p>New source</p>' });
        await refreshing;
        expect((await f.service.document(paneID)).text).toBe(source);
    });

    it('invalidates the previous mode revision while a selected renderer is pending', async () => {
        const f = fixture(); f.provider.selected = true;
        await f.service.subscribe(MD, () => {});
        const initial = await f.service.document(MD);
        const pending = defer(f);
        f.service.invalidateRenderer();
        await vi.waitFor(() => expect(pending).toHaveLength(1));

        const editing = f.service.setMode(MD, 'edit', { revision: initial.revision });
        await vi.waitFor(async () => expect((await f.service.document(MD)).mode).toBe('edit'));
        const changed = await f.service.document(MD);
        expect(changed.revision).not.toBe(initial.revision);
        await expect(f.service.setText(MD, 'stale edit', { revision: initial.revision })).rejects.toThrow('DOCUMENT_CONFLICT');
        pending[0]!.resolve({ html: '<p>Original</p>' });
        await editing;
        expect((await f.service.document(MD)).text).toBe(initial.text);
    });

    it('invalidates the dirty revision as soon as a save reaches disk, before rendering', async () => {
        const f = fixture(); f.provider.selected = true;
        await f.service.subscribe(MD, () => {});
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, '# Saved source\n');
        const dirty = await f.service.document(MD);
        const pending = defer(f);
        const saving = f.service.save(MD, { revision: dirty.revision });
        await vi.waitFor(() => expect(pending).toHaveLength(1));

        const saved = await f.service.document(MD);
        expect(saved).toMatchObject({ text: dirty.text, dirty: false });
        expect(saved.revision).not.toBe(dirty.revision);
        expect(fs.readFileSync(f.file, 'utf8')).toBe(dirty.text);
        await expect(f.service.setText(MD, 'stale edit', { revision: dirty.revision })).rejects.toThrow('DOCUMENT_CONFLICT');
        pending[0]!.resolve({ html: '<p>Saved source</p>' });
        await saving;
    });

    it('uses selected providers for native Markdown and Diff with authoritative pane context', async () => {
        const f = fixture(); f.provider.selected = true;
        const markdown = await f.service.subscribe(MD, state => f.seen.push(state));
        expect(markdown.state).toMatchObject({ paneID: MD, workspaceID: W1, type: 'markdown', text: '# Original\n', html: '<h1>Custom markdown</h1>' });
        expect(f.call.mock.calls[0]).toEqual([
            { service: CONTENT_RENDER_SERVICE, version: 1, method: 'render', args: { kind: 'markdown', source: '# Original\n', backgroundColor: '#0A0A0C', fontSize: 14, assetBase: `/pane-assets/${MD}/` } },
            { daemonID: 'test-daemon', workspaceID: W1, paneID: MD }, expect.any(AbortSignal)
        ]);
        expect(await f.service.state(DIFF)).toMatchObject({ type: 'diff', html: '<h1>Custom diff</h1>' });
        expect((f.call.mock.calls[1]![0]['args'] as JsonObject)['assetBase']).toBeNull();
        markdown.unsubscribe();
    });

    it('keeps native theme updates synchronous when no external provider is active', async () => {
        const f = fixture();
        await f.service.subscribe(MD, state => f.seen.push(state));
        f.service.setAppearance({ backgroundColor: '#FFFFFF' });
        expect(f.seen).toHaveLength(1);
        expect(f.seen[0]).toMatchObject({ isDark: false, html: expect.stringContaining('<html class="light">') });
        expect(f.call).not.toHaveBeenCalled();
    });

    it('cancels superseded source and theme renders, ignoring a provider that returns late', async () => {
        const f = fixture();
        await f.service.subscribe(MD, state => f.seen.push(state));
        const pending = defer(f); f.provider.selected = true;
        f.service.invalidateRenderer();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        f.service.setAppearance({ backgroundColor: '#FFFFFF' });
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        expect(pending[0]!.signal!.aborted).toBe(true);
        fs.writeFileSync(f.file, '# New source\n');
        const refreshed = f.service.refresh(MD);
        await vi.waitFor(() => expect(pending).toHaveLength(3));
        expect(pending[1]!.signal!.aborted).toBe(true);
        expect(pending[2]!.input['args']).toMatchObject({ source: '# New source\n', backgroundColor: '#FFFFFF' });
        pending[2]!.resolve({ html: '<h1>Latest source and theme</h1>' });
        await refreshed;
        pending[0]!.resolve({ html: 'obsolete provider' }); pending[1]!.resolve({ html: 'obsolete source' });
        await Promise.resolve(); await Promise.resolve();
        expect(await f.service.state(MD)).toMatchObject({ text: '# New source\n', html: '<h1>Latest source and theme</h1>', isDark: false });
        expect(f.seen).toHaveLength(1);
        expect(f.errors).not.toHaveBeenCalled();
    });

    it('invalidates renderer generations and restores native output without losing dirty edits', async () => {
        const f = fixture();
        await f.service.subscribe(MD, state => f.seen.push(state));
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, 'Unsaved text');
        const pending = defer(f); f.provider.selected = true;
        f.service.invalidateRenderer();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        f.service.invalidateRenderer();
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        expect(pending[0]!.signal!.aborted).toBe(true);
        f.provider.selected = false; f.service.invalidateRenderer();
        expect(pending[1]!.signal!.aborted).toBe(true);
        expect(await f.service.state(MD)).toMatchObject({ mode: 'edit', dirty: true, text: 'Unsaved text', html: expect.stringContaining('Unsaved text') });
        expect(fs.readFileSync(f.file, 'utf8')).toBe('# Original\n');
        pending[0]!.resolve({ html: 'old generation' }); pending[1]!.resolve({ html: 'disabled generation' });
        f.service.flushSync();
        expect(fs.readFileSync(f.file, 'utf8')).toBe('Unsaved text');
        expect(await f.service.state(MD)).toMatchObject({ dirty: false, text: 'Unsaved text', html: expect.stringContaining('Unsaved text') });
    });

    it.each(['failure', 'invalid', 'oversized'] as const)('recovers a %s provider result using the intact native document', async kind => {
        const f = fixture(); f.provider.selected = true;
        if (kind === 'failure') f.call.mockRejectedValue(new Error('renderer stopped'));
        else f.call.mockResolvedValue(kind === 'invalid' ? { html: 42 } : { html: 'x'.repeat(PLUGIN_MAX_JSON_BYTES) });
        expect(await f.service.state(MD)).toMatchObject({ loaded: true, error: null, text: '# Original\n', html: expect.stringContaining('<h1>Original</h1>') });
        expect(f.errors).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('using bundled renderer'));
    });

    it('does not send or truncate native source that exceeds the plugin transport envelope', async () => {
        const source = '# Large\n\n' + 'x'.repeat(PLUGIN_MAX_JSON_BYTES) + '\n\nEND OF DOCUMENT';
        const f = fixture(source); f.provider.selected = true;
        expect(await f.service.state(MD)).toMatchObject({ text: source, html: expect.stringContaining('END OF DOCUMENT') });
        expect(f.call).not.toHaveBeenCalled();
        expect(f.errors).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('using bundled renderer'));
    });

    it('cancels a pending first subscription when its pane closes and never mounts a late listener', async () => {
        const f = fixture(); f.provider.selected = true;
        const pending = defer(f);
        const subscribed = f.service.subscribe(MD, state => f.seen.push(state));
        const rejected = expect(subscribed).rejects.toThrow('closed while loading');
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        f.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: MD });
        expect(pending[0]!.signal!.aborted).toBe(true);
        await rejected;
        pending[0]!.resolve({ html: 'closed pane result' });
        await Promise.resolve();
        expect(f.seen).toEqual([]);
    });

    it('cancels pending rendering on service disposal without publishing or reporting a failure', async () => {
        const f = fixture();
        await f.service.subscribe(MD, state => f.seen.push(state));
        const pending = defer(f); f.provider.selected = true;
        f.service.invalidateRenderer();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        f.service.dispose();
        expect(pending[0]!.signal!.aborted).toBe(true);
        pending[0]!.reject(new Error('cancelled'));
        await Promise.resolve(); await Promise.resolve();
        expect(f.seen).toEqual([]); expect(f.errors).not.toHaveBeenCalled();
    });

    it('refreshes only existing native diff entries when Git providers change and drops stale source', async () => {
        const f = fixture();
        f.store.dispatch({ type: 'open-diff-pane', workspaceID: W1, paneID: id('eeeeeeee', 23), repoPath: f.dir, now: NOW });
        await f.service.subscribe(DIFF, state => f.seen.push(state));
        const pending: Array<{ signal?: AbortSignal | undefined; resolve(text: string): void }> = [];
        f.getDiff.mockImplementation((_repo, _path, options) => new Promise(resolve => pending.push({ signal: options?.signal, resolve })));
        f.service.invalidateGit();
        f.service.invalidateGit();
        expect(pending).toHaveLength(2);
        expect(pending[0]!.signal!.aborted).toBe(true);
        pending[1]!.resolve('diff --git a/new-source b/new-source\n@@ -1 +1 @@\n-old\n+current\n');
        await vi.waitFor(() => expect(f.seen).toHaveLength(1));
        pending[0]!.resolve('diff --git a/old-source b/old-source\n@@ -1 +1 @@\n-old\n+stale\n');
        expect((await f.service.state(DIFF)).html).toContain('new-source</span>');
        expect(f.getDiff).toHaveBeenCalledTimes(3);
        expect(f.seen).toHaveLength(1);
    });

    it('recovers initial loading when a malformed real provider result synchronously invalidates rendering', async () => {
        const f = fixture();
        const plugins = new PluginService({ directory: path.join(f.dir, 'installed'), store: f.store.store, command: async () => ({ ok: true }), broadcast: () => {} });
        cleanups.push(() => plugins.dispose());
        plugins.registerBuiltinService(createContentRenderService());
        f.services.current = plugins;
        const off = plugins.onServicesChanged(changed => { if (changed.includes('kelpi.content.render@1')) f.service.invalidateRenderer(); });
        cleanups.push(off);
        const source = path.join(f.dir, 'provider'); fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ id: 'sample.renderer', name: 'Invalid renderer', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'on-demand', backend: 'backend.mjs', contributes: {
            providers: [{ id: 'sample.renderer.custom', title: 'Invalid renderer', service: CONTENT_RENDER_SERVICE, version: 1, methods: ['render'] }]
        } }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), `export function activate(api) { api.providers.register('sample.renderer.custom', {render: () => ({html: 42})}); }`);
        await plugins.install(source, true);
        await plugins.request('service-select', { service: CONTENT_RENDER_SERVICE, version: 1, providerID: 'sample.renderer.custom' });
        expect((await f.service.subscribe(MD, state => f.seen.push(state))).state).toMatchObject({ html: expect.stringContaining('<h1>Original</h1>'), text: '# Original\n', loaded: true, dirty: false });
        expect(plugins.list()[0]?.status).toBe('failed');
        expect(plugins.services().find(service => service['id'] === CONTENT_RENDER_SERVICE)).toMatchObject({ selectedProviderID: 'sample.renderer.custom', activeProviderID: 'kelpi.content.render.bundled' });
    });
});

import { describe, expect, it } from 'vitest';
import { PluginEventBuffer, decodePluginManifest, decodePluginPane, pluginJSON } from './plugins.js';
import { decodeWireObject } from './wire/decode.js';

const manifest = { id: 'sample.board', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: { views: [{ id: 'sample.board.view', title: 'Board', entry: 'ui/index.html', placements: ['pane', 'sidebar.primary'] }] } };
describe('public plugin protocol', () => {
    it('makes slow-reader gaps explicit and retains subsequent event order', () => {
        const buffer = new PluginEventBuffer(1024, 3);
        for (let sequence = 1; sequence <= 5; sequence++) buffer.push({ epoch: 'E', sequence, name: 'update', data: null });
        expect(buffer.shift()).toMatchObject({ name: 'gap', sequence: 3 });
        expect(buffer.shift()).toMatchObject({ name: 'update', sequence: 4 });
        expect(buffer.shift()).toMatchObject({ name: 'update', sequence: 5 });
        expect(buffer.shift()).toBeUndefined();
        buffer.push({ epoch: 'E', sequence: 6, name: 'snapshot', data: 'x'.repeat(1024) });
        expect(buffer.shift()).toMatchObject({ name: 'gap', sequence: 6 });
        expect(buffer.shift()).toBeUndefined();
    });
    it('accepts a framework-independent view in several placements and supplies stable defaults', () => {
        expect(decodePluginManifest(manifest)).toMatchObject({ name: 'sample.board', activation: 'on-demand', contributes: { commands: [], settings: {}, views: [{ stateVersion: 1 }] } });
        expect(decodeWireObject({ command: 'plugin', action: 'open', text: '{"viewID":"sample.board.view"}' }).ok).toBe(true);
    });
    it('accepts terminal replacements alongside namespaced custom placements', () => {
        const placements = ['terminal', 'sample.board.terminal'];
        expect(decodePluginManifest({ ...manifest, contributes: { views: [{ ...manifest.contributes.views[0], placements }] } }).contributes.views[0]?.placements).toEqual(placements);
    });
    it('registers browser chrome as an isolated native renderer while retaining per-view state', () => {
        const views = [{ ...manifest.contributes.views[0], placements: ['browser'], stateVersion: 3 }];
        expect(decodePluginManifest({ ...manifest, contributes: { views } }).contributes.views).toMatchObject([{ placements: ['browser'], stateVersion: 3 }]);
    });
    it.each([
        { apiVersion: 9 }, { trust: 'sandbox' }, { id: 'kelpi.board' }, { id: '../escape' },
        { backend: '../code.js' }, { backend: 'ui/code.js' },
        { contributes: { views: [{ ...manifest.contributes.views[0], id: 'another.plugin.view' }] } },
        { contributes: { views: [{ ...manifest.contributes.views[0], entry: 'index.html' }] } },
        { contributes: { views: [{ ...manifest.contributes.views[0], entry: 'ui/%2e%2e/code.html' }] } },
        { contributes: { views: [{ ...manifest.contributes.views[0], placements: ['unknown'] }] } },
        { contributes: { commands: [{ id: 'sample.board.run', title: 'Run' }] } }
    ])('rejects incompatible or ambiguous manifests: %j', invalid => expect(() => decodePluginManifest({ ...manifest, ...invalid })).toThrow());
    it('bounds JSON, rejects non-JSON values, and does not hand mutable input to a receiver', () => {
        for (const value of [undefined, Infinity, { value: new Date() }, JSON.parse('{"__proto__":{}}'), 'x'.repeat(262145)]) expect(() => pluginJSON(value)).toThrow();
        const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
        expect(() => pluginJSON(cyclic)).toThrow();
        const input = { rows: ['a'] }; const copy = pluginJSON(input); input.rows.push('b'); expect(copy).toEqual({ rows: ['a'] });
    });
    it('retains versioned pane state independently of whether the plugin is installed', () => {
        const pane = { pluginID: 'sample.board', viewID: 'sample.board.view', stateVersion: 3, state: { query: 'running' } };
        expect(decodePluginPane(pane)).toEqual(pane);
        expect(decodePluginPane({ ...pane, viewID: 'other.board.view' })).toBeNull();
    });
});

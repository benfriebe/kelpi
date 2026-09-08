import { describe, expect, it } from 'vitest';
import { decodePluginManifest, type PluginManifest } from './plugins.js';
import { isPluginVersionRange, pluginDependencyOrder, pluginDependencyProblem, pluginVersionMatches } from './plugin-dependencies.js';

const manifest = (id: string, dependencies: unknown[] = [], version = '1.2.3'): PluginManifest => decodePluginManifest({ id, version, apiVersion: 1, trust: 'full', dependencies });

describe('plugin dependency resolution', () => {
    it.each([
        ['1.2.3', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['0.3.0', '^0.2.1', false],
        ['0.2.9', '^0.2.1', true], ['0.0.2', '^0.0.1', false], ['1.3.0', '~1.2.3', false],
        ['1.2.9', '~1.2.3', true], ['1.2.3+build', '1.2.3', true], ['1.2.2', '^1.2.3', false],
        ['1.2.4-beta', '^1.2.3', false], ['1.2.3-beta.2', '^1.2.3-beta.1', true],
        ['1.2.3-beta.10', '^1.2.3-beta.2', true], ['1.2.3-beta', '*', false], ['1.2.3', '*', true]
    ])('checks %s against %s', (version, range, expected) => expect(pluginVersionMatches(version, range)).toBe(expected));

    it('rejects unsupported or ambiguous ranges instead of silently accepting them', () => {
        for (const range of ['1', '>=1.0.0', '1.x', '1.0.0 || 2.0.0', '^01.0.0', '^1.0.0-beta.01', '^^1.0.0', '1.0.0-']) expect(isPluginVersionRange(range)).toBe(false);
    });

    it('activates each shared dependency once before its consumers', () => {
        const core = manifest('sample.core');
        const left = manifest('sample.left', [{ pluginID: core.id, version: '^1.0.0' }]);
        const right = manifest('sample.right', [{ pluginID: core.id, version: '~1.2.0' }]);
        const app = manifest('sample.app', [{ pluginID: left.id, version: '*' }, { pluginID: right.id, version: '*' }]);
        expect(pluginDependencyOrder([app, left, right, core], [app.id]).map(item => item.id)).toEqual([core.id, left.id, right.id, app.id]);
    });

    it('reports missing, disabled, failed, and incompatible required dependencies', () => {
        const app = manifest('sample.app', [{ pluginID: 'sample.core', version: '^1.0.0' }]);
        const root = { manifest: app, enabled: true };
        expect(pluginDependencyProblem(app.id, [root])).toContain('not installed');
        expect(pluginDependencyProblem(app.id, [root, { manifest: manifest('sample.core'), enabled: false }])).toContain('disabled');
        expect(pluginDependencyProblem(app.id, [root, { manifest: manifest('sample.core'), enabled: true, status: 'failed', error: 'activation timed out' }])).toContain('activation timed out');
        expect(pluginDependencyProblem(app.id, [root, { manifest: manifest('sample.core', [], '2.0.0'), enabled: true }])).toContain('incompatible');
    });

    it('skips unavailable optional dependencies, but rejects cycles among available dependencies', () => {
        const app = manifest('sample.app', [{ pluginID: 'sample.core', version: '^1.0.0', optional: true }]);
        expect(pluginDependencyOrder([app])).toEqual([app]);
        expect(pluginDependencyOrder([app, manifest('sample.core', [], '2.0.0')], [app.id])).toEqual([app]);
        const core = manifest('sample.core', [{ pluginID: app.id, version: '*' }]);
        expect(() => pluginDependencyOrder([app, core])).toThrow('sample.app → sample.core → sample.app');
    });

    it('reports a transitive dependency failure at its owner', () => {
        const app = manifest('sample.app', [{ pluginID: 'sample.core', version: '*' }]);
        const core = manifest('sample.core', [{ pluginID: 'sample.storage', version: '*' }]);
        expect(pluginDependencyProblem(app.id, [app, core].map(manifest => ({ manifest, enabled: true })))).toContain('sample.core requires sample.storage');
    });

    it('skips an optional dependency whose own required dependency is unavailable', () => {
        const app = manifest('sample.app', [{ pluginID: 'sample.core', version: '*', optional: true }]);
        const core = manifest('sample.core', [{ pluginID: 'sample.storage', version: '^1.0.0' }]);
        const installed = [app, core].map(manifest => ({ manifest, enabled: true }));
        expect(pluginDependencyProblem(app.id, installed)).toBeNull();
        expect(pluginDependencyOrder([app, core], [app.id])).toEqual([app]);
        const storage = manifest('sample.storage');
        expect(pluginDependencyOrder([app, core, storage], [app.id]).map(item => item.id)).toEqual([storage.id, core.id, app.id]);
    });
});

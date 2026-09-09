import { describe, expect, it } from 'vitest';
import { decodePluginManifest } from './plugins.js';

const base = { id: 'sample.board', version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs' };
const slot = 'sample.board.details';
const view = { id: 'sample.board.view', title: 'Details', entry: 'ui/index.html', placements: [slot] };
const container = { id: 'sample.board.container', title: 'Board', layout: 'tabs', placements: ['sidebar.primary'], slots: [{ id: slot, title: 'Details', defaultView: view.id }] };

describe('declarative plugin extension contracts', () => {
    it('accepts a custom container and compatible named view slot without daemon internals', () => {
        const decoded = decodePluginManifest({ ...base, contributes: { views: [view], containers: [container], commands: [{ id: 'sample.board.refresh', title: 'Refresh', menu: 'pane.header' }] } });
        expect(decoded.contributes.containers?.[0]).toEqual(container);
        expect(decoded.contributes.views[0]?.placements).toEqual([slot]);
        expect(decoded.contributes.commands[0]?.menu).toBe('pane.header');
    });

    it('permits scoped native workbench defaults and declared foreign contributions', () => {
        expect(decodePluginManifest({ ...base, dependencies: [{ pluginID: 'other.board', version: '^1.0.0' }], contributes: {
            views: [{ ...view, placements: ['other.board.slot'] }], containers: [{ ...container, slots: [{ id: slot, title: 'Native', defaultView: 'kelpi.workspaces' }] }]
        } }).contributes.containers?.[0]?.slots[0]?.defaultView).toBe('kelpi.workspaces');
        expect(() => decodePluginManifest({ ...base, contributes: { views: [{ ...view, placements: ['other.board.slot'] }] } })).toThrow('declared dependency');
    });

    it.each([
        { ...container, placements: ['pane'] },
        { ...container, slots: [] },
        { ...container, slots: [{ id: slot, title: 'Bad', weight: 0 }] },
        { ...container, slots: [{ id: slot, title: 'Bad', defaultView: 'kelpi.shell' }] },
        { ...container, slots: [{ id: slot, title: 'Bad', defaultView: 'sample.board.unknown' }] },
        { ...container, slots: [{ id: view.id, title: 'Duplicate' }] },
        { ...container, placements: [slot], slots: [{ id: slot, title: 'Cycle', defaultView: container.id }] }
    ])('rejects invalid container ownership, compatibility, and cycles', invalid => {
        expect(() => decodePluginManifest({ ...base, contributes: { views: [view], containers: [invalid] } })).toThrow();
    });

    it('validates hooks and providers before executing their backend', () => {
        const contributes = {
            hooks: [{ id: 'sample.board.guard', phase: 'before', commands: ['workspace-delete'], priority: 5, timeoutMs: 500 }],
            services: [{ id: 'sample.board.lookup', title: 'Lookup', version: 1, methods: ['find'] }],
            providers: [{ id: 'sample.board.local', title: 'Local', service: 'sample.board.lookup', version: 1, methods: ['find'], timeoutMs: 1000 }]
        };
        expect(decodePluginManifest({ ...base, contributes }).contributes).toMatchObject(contributes);
        expect(() => decodePluginManifest({ ...base, backend: undefined, contributes })).toThrow();
        expect(() => decodePluginManifest({ ...base, contributes: { hooks: [{ ...contributes.hooks[0], timeoutMs: 0 }] } })).toThrow('timeout');
        expect(() => decodePluginManifest({ ...base, contributes: { hooks: [{ ...contributes.hooks[0], commands: ['workspace-*'] }] } })).toThrow('exact command');
        expect(() => decodePluginManifest({ ...base, contributes: { providers: [{ ...contributes.providers[0], service: 'other.board.lookup' }] } })).toThrow('declared dependency');
    });

    it('rejects duplicate dependency IDs, self-dependency, and malformed version requirements', () => {
        for (const dependencies of [[{ pluginID: base.id, version: '*' }], [{ pluginID: 'other.board', version: 'latest' }], [{ pluginID: 'other.board', version: '*', optional: 'yes' }], [{ pluginID: 'other.board', version: '*' }, { pluginID: 'other.board', version: '*' }]]) {
            expect(() => decodePluginManifest({ ...base, dependencies })).toThrow();
        }
    });
});

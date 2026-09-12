import { describe, expect, it } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import { BUNDLED_VIEWS, DEFAULT_SLOTS, MAX_COMPOSED_VIEWS, containerLayoutValid, planComposedViews, readWorkbenchSelections, resolveSidebarViews, resolveSlot, selectWorkbenchView, viewRegistry, type ViewContribution } from './registry';
import { pluginDocument } from './document';

describe('extensible workbench', () => {
    const plugin: PluginInfo = { manifest: decodePluginManifest({ id: 'sample.board', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: { views: [{ id: 'sample.board.view', title: 'Board', entry: 'ui/index.html', placements: ['pane', 'sidebar.primary'] }] } }), enabled: true, revision: 'r1', instanceID: 'i1', status: 'inactive', error: null };
    it('uses one view identity in a pane and a sidebar, while keeping slot selection separate', () => {
        const views = viewRegistry([plugin]);
        expect(resolveSlot(views, 'sidebar.primary', 'sample.board.view')).toMatchObject({ pluginID: 'sample.board', placements: ['pane', 'sidebar.primary'] });
        expect(resolveSlot(views, 'sidebar.secondary', 'sample.board.view')?.id).toBe('kelpi.inspector');
        expect(new Set(BUNDLED_VIEWS.map(view => view.id)).size).toBe(BUNDLED_VIEWS.length);
    });
    it('falls back to bundled chrome if a selected plugin is removed, disabled or crashes', () => {
        for (const plugins of [[], [{ ...plugin, enabled: false }], [{ ...plugin, status: 'failed' as const }]]) {
            expect(resolveSlot(viewRegistry(plugins), 'sidebar.primary', 'sample.board.view')?.id).toBe(DEFAULT_SLOTS['sidebar.primary']);
        }
    });
    it('moves a native sidebar without creating a second owner of its command refs', () => {
        const views = viewRegistry([]);
        const swapped = selectWorkbenchView(views, {}, 'sidebar.primary', 'kelpi.inspector');
        expect(resolveSidebarViews(views, swapped)).toMatchObject({
            'sidebar.primary': { id: 'kelpi.inspector' },
            'sidebar.secondary': { id: 'kelpi.workspaces' }
        });
        const restored = selectWorkbenchView(views, swapped, 'sidebar.secondary', 'kelpi.inspector');
        expect(resolveSidebarViews(views, restored)).toMatchObject({
            'sidebar.primary': { id: 'kelpi.workspaces' },
            'sidebar.secondary': { id: 'kelpi.inspector' }
        });
    });
    it('keeps Workspaces on the right when a missing left plugin needs a native fallback', () => {
        const resolved = resolveSidebarViews(viewRegistry([]), { 'sidebar.primary': 'sample.board.view', 'sidebar.secondary': 'kelpi.workspaces' });
        expect(resolved['sidebar.primary'].id).toBe('kelpi.inspector');
        expect(resolved['sidebar.secondary'].id).toBe('kelpi.workspaces');
        const duplicated = resolveSidebarViews(viewRegistry([]), { 'sidebar.primary': 'kelpi.workspaces', 'sidebar.secondary': 'kelpi.workspaces' });
        expect(new Set(Object.values(duplicated).map(view => view.id)).size).toBe(2);
    });
    it('does not move a plugin into a sidebar it does not support', () => {
        const views = viewRegistry([plugin]);
        const swapped = selectWorkbenchView(views, { 'sidebar.primary': 'sample.board.view' }, 'sidebar.primary', 'kelpi.inspector');
        expect(resolveSidebarViews(views, swapped)['sidebar.secondary'].id).toBe('kelpi.workspaces');
    });
    it('resolves named slots, preserves explicit empty slots and recovers a missing selection', () => {
        const composed: PluginInfo = { ...plugin, manifest: decodePluginManifest({ id: 'sample.board', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
            containers: [{ id: 'sample.board.layout', title: 'Layout', placements: ['workspace'], layout: 'row', slots: [{ id: 'sample.board.metrics', title: 'Metrics', defaultView: 'sample.board.view' }] }],
            views: [{ id: 'sample.board.view', title: 'Board', entry: 'ui/index.html', placements: ['sample.board.metrics'] }]
        } }) };
        const views = viewRegistry([composed]);
        expect(resolveSlot(views, 'workspace', 'sample.board.layout')?.container?.layout).toBe('row');
        expect(resolveSlot(views, 'sample.board.metrics')?.id).toBe('sample.board.view');
        expect(resolveSlot(views, 'sample.board.metrics', 'missing.view')?.id).toBe('sample.board.view');
        expect(resolveSlot(views, 'sample.board.metrics', '')).toBeUndefined();
        expect(resolveSlot(viewRegistry([{ ...composed, enabled: false }]), 'workspace', 'sample.board.layout')?.id).toBe('kelpi.workspace');
    });
    it('rejects cycles introduced by selections and permits restoring an unrelated native host', () => {
        const a: ViewContribution = { id: 'sample.board.a', title: 'A', pluginID: 'sample.board', placements: ['workspace', 'sample.board.b-slot'], container: { id: 'sample.board.a', title: 'A', placements: ['workspace', 'sample.board.b-slot'], layout: 'row', slots: [{ id: 'sample.board.a-slot', title: 'A slot' }] } };
        const b: ViewContribution = { id: 'sample.board.b', title: 'B', pluginID: 'sample.board', placements: ['sample.board.a-slot'], container: { id: 'sample.board.b', title: 'B', placements: ['sample.board.a-slot'], layout: 'column', slots: [{ id: 'sample.board.b-slot', title: 'B slot' }] } };
        const views = [...BUNDLED_VIEWS, a, b];
        const first = selectWorkbenchView(views, {}, 'sample.board.a-slot', b.id);
        expect(first['sample.board.a-slot']).toBe(b.id);
        expect(selectWorkbenchView(views, first, 'sample.board.b-slot', a.id)).toBe(first);
        const corrupt = { ...first, 'sample.board.b-slot': a.id, workspace: a.id };
        expect(containerLayoutValid(views, corrupt)).toBe(false);
        expect(selectWorkbenchView(views, corrupt, 'workspace', 'kelpi.workspace').workspace).toBe('kelpi.workspace');
        expect(containerLayoutValid(views, selectWorkbenchView(views, corrupt, 'sample.board.b-slot', ''))).toBe(true);
    });
    it('bounds expanded container trees and gives each native adapter one owner', () => {
        const views: ViewContribution[] = [...BUNDLED_VIEWS];
        for (let level = 0; level < 10; level++) {
            const id = `sample.board.level-${level}`;
            const placements = level === 0 ? ['workspace' as const] : Array.from({ length: 4 }, (_, index) => `sample.board.slot-${level - 1}-${index}` as const);
            views.push({ id, title: id, pluginID: 'sample.board', placements, container: { id, title: id, placements, layout: 'column', slots: Array.from({ length: 4 }, (_, index) => ({ id: `sample.board.slot-${level}-${index}` as const, title: 'Slot', defaultView: level === 9 ? 'kelpi.workspace' : `sample.board.level-${level + 1}` })) } });
        }
        expect(containerLayoutValid(views, {})).toBe(true);
        const plan = planComposedViews(views, {}, views.find(view => view.id === 'sample.board.level-0')!, new Set(['kelpi.workspace']));
        expect(plan.paths.size).toBe(MAX_COMPOSED_VIEWS);
        expect(plan.nativePaths.size).toBe(1);
        expect(plan.nativePaths.get('kelpi.workspace')).toContain('sample.board.slot-9-0');
    });
    it('keeps the bundled presenter as a floor for both interaction placements', () => {
        const presenter: PluginInfo = { ...plugin, manifest: decodePluginManifest({ id: 'sample.present', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
            views: [{ id: 'sample.present.view', title: 'Presenter', entry: 'ui/index.html', placements: ['interaction.palette', 'interaction.prompts'] }]
        } }) };
        expect(DEFAULT_SLOTS['interaction.palette']).toBe('kelpi.palette');
        expect(DEFAULT_SLOTS['interaction.prompts']).toBe('kelpi.prompts');
        for (const placement of ['interaction.palette', 'interaction.prompts'] as const) {
            const views = viewRegistry([presenter]);
            expect(resolveSlot(views, placement, 'sample.present.view')?.pluginID).toBe('sample.present');
            // The recovery floor cannot be selected away, and an unknown selection lands on it.
            expect(resolveSlot(views, placement, '')?.id).toBe(DEFAULT_SLOTS[placement]);
            expect(resolveSlot(views, placement, 'missing.view')?.id).toBe(DEFAULT_SLOTS[placement]);
            expect(selectWorkbenchView(views, {}, placement, '')).toEqual({});
            // A missing, disabled or failed plugin falls back while the CHOICE is retained.
            for (const plugins of [[], [{ ...presenter, enabled: false }], [{ ...presenter, status: 'failed' as const }]]) {
                const selections = { [placement]: 'sample.present.view' };
                expect(resolveSlot(viewRegistry(plugins), placement, selections[placement])?.id).toBe(DEFAULT_SLOTS[placement]);
                expect(readWorkbenchSelections(selections)).toEqual(selections);
            }
        }
    });

    it('retains namespaced selections across plugin removal and rejects malformed persisted keys', () => {
        expect(readWorkbenchSelections({ 'sample.board.metrics': 'sample.board.view', 'sidebar.primary': 'kelpi.inspector', pane: 'kelpi.shell', 'not a slot': 'bad', 'kelpi.internal': 'bad', topbar: 17 })).toEqual({ 'sample.board.metrics': 'sample.board.view', 'sidebar.primary': 'kelpi.inspector' });
    });
    it('scopes document assets and network access without exposing the daemon credential', () => {
        const html = pluginDocument('<script type="module" src="app.js"></script>', 'http://localhost:123/plugin-assets/lease/', 'ui/index.html', { nonce: 'n', state: { malicious: '</script><script>bad()</script>' } });
        const document = new DOMParser().parseFromString(html, 'text/html');
        expect(document.querySelector('base')?.href).toBe('http://localhost:123/plugin-assets/lease/ui/');
        const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
        expect(csp).toContain("frame-src 'none'");
        expect(csp).toContain('connect-src http://localhost:123/plugin-assets/lease/');
        expect(document.querySelectorAll('script')).toHaveLength(2);
        expect(html).not.toContain('allow-same-origin');
    });
});

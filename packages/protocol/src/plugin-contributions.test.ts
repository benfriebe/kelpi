import { describe, expect, it } from 'vitest';
import { decodePluginManifest } from './plugins.js';
import { decodePluginWhen, patchPluginContributionState, pluginSettingValue } from './plugin-contributions.js';

const base = { id: 'sample.rich', version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs' };
const command = { id: 'sample.rich.run', title: 'Run', menu: 'both', shortcut: 'super+r' };
const item = { id: 'sample.rich.status', placement: 'statusbar', text: 'Ready', command: command.id };
const menu = { id: 'sample.rich.menu', placement: 'pane', command: command.id };
const group = { id: 'sample.rich.general', title: 'General', description: 'Common choices', order: 2 };
const setting = { title: 'Mode', type: 'string', default: 'compact', enum: ['compact', 'expanded'], group: group.id, description: 'Display density', order: 1 };
const manifest = (contributes: Record<string, unknown> = {}) => decodePluginManifest({ ...base, contributes: { commands: [command], items: [item], ...contributes } });

describe('rich plugin contribution declarations', () => {
    it('preserves legacy command and setting shapes without supplying new optional fields', () => {
        const result = decodePluginManifest({ ...base, contributes: { commands: [command], settings: { enabled: { title: 'Enabled', type: 'boolean', default: true } } } });
        expect(result.contributes).toEqual({ commands: [command], views: [], settings: { enabled: { title: 'Enabled', type: 'boolean', default: true } } });
    });
    it('decodes owned menus/items and typed conditions with rich grouped settings', () => {
        const when = { connection: 'connected', 'workspace.exists': true, 'workspace.hasRepos': false, 'pane.exists': true, 'pane.type': 'shell', 'pane.hasAgent': false, 'pane.focused': true, 'context.ready': true, 'context.phase': null };
        const result = manifest({ commands: [{ ...command, when, enablement: { 'context.count': 1 } }],
            menus: [{ ...menu, group: 'tools', order: -2, when, enablement: { 'context.ready': true } }],
            items: [{ ...item, tooltip: 'Open status', badge: '2', tone: 'info', order: 3, when }],
            settingGroups: [group], settings: { mode: setting, limit: { title: 'Limit', type: 'number', default: 5, min: 0, max: 10 } },
        });
        expect(result.contributes.commands[0]).toMatchObject({ when, enablement: { 'context.count': 1 } });
        expect(result.contributes.menus?.[0]).toMatchObject({ ...menu, group: 'tools', order: -2 });
        expect(result.contributes.items?.[0]).toMatchObject({ ...item, tone: 'info', badge: '2' });
        expect(result.contributes.settingGroups).toEqual([group]);
        expect(result.contributes.settings['mode']).toEqual(setting);
        expect(decodePluginWhen({ 'pane.type': null, 'context.missing': null })).toEqual({ 'pane.type': null, 'context.missing': null });
    });
    it.each([
        { menus: [{ ...menu, id: 'another.plugin.menu' }] },
        { menus: [{ ...menu, id: command.id }] },
        { menus: [{ ...menu, command: 'sample.rich.missing' }] },
        { menus: [{ ...menu, command: 'another.plugin.run' }] },
        { menus: [{ ...menu, placement: 'settings' }] },
        { menus: [{ ...menu, order: 0.5 }] },
        { menus: [{ ...menu, group: 'x'.repeat(65) }] },
        { items: [{ ...item, id: command.id }] },
        { items: [{ ...item, placement: 'pane' }] },
        { items: [{ ...item, text: '' }] },
        { items: [{ ...item, text: 'x'.repeat(201) }] },
        { items: [{ ...item, badge: 'x'.repeat(33) }] },
        { items: [{ ...item, tooltip: 'x'.repeat(1001) }] },
        { items: [{ ...item, tone: ['info'] }] },
        { items: [{ ...item, command: 'sample.rich.missing' }] },
        { items: [{ ...item, order: 10001 }] },
        { items: Array.from({ length: 101 }, (_, index) => ({ ...item, id: `sample.rich.status-${index}` })) },
        { settingGroups: [{ ...group, id: item.id }] },
        { settingGroups: [{ ...group, description: 'x'.repeat(2001) }] },
    ])('rejects invalid, ambiguous or unbounded UI declarations: %j', contributes => {
        expect(() => manifest(contributes)).toThrow();
    });
    it.each([
        { 'workspace.exists': 'true' }, { connection: ['connected'] }, { connection: 'ready' },
        { 'pane.type': ['shell'] }, { 'pane.type': 'terminal' }, { 'pane.focused': 1 },
        { 'context.nested': {} }, { 'context.list': [] }, { 'context.long': 'x'.repeat(4097) },
        { 'context.bad/key': true }, { 'context.constructor': true }, { 'context.': true },
        { 'daemon.token': true }, { 'pane.exists || true': true },
        Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`context.key${index}`, true])),
    ])('rejects unknown, executable, nested or incorrectly typed conditions: %j', when => {
        expect(() => decodePluginWhen(when)).toThrow();
        expect(() => manifest({ commands: [{ ...command, when }] })).toThrow();
    });
    it.each([
        { ...setting, group: 'sample.rich.missing' }, { ...setting, default: 'unknown' },
        { ...setting, enum: [] }, { ...setting, enum: ['compact', 'compact'] }, { ...setting, enum: ['compact', 1] },
        { ...setting, min: 0 }, { ...setting, max: 10 }, { ...setting, order: 0.1 },
        { title: 'Limit', type: 'number', default: 11, min: 0, max: 10 },
        { title: 'Limit', type: 'number', default: 0, min: 10, max: 0 },
        { title: 'Limit', type: 'number', default: 5, min: 0, max: 10, enum: [5, 20] },
    ])('rejects invalid setting schemas and defaults: %j', definition => {
        expect(() => manifest({ settingGroups: [group], settings: { mode: definition } })).toThrow();
    });
    it('validates writes against the same enum and range contracts as defaults', () => {
        const settings = manifest({ settingGroups: [group], settings: { mode: setting, limit: { title: 'Limit', type: 'number', default: 5, min: 0, max: 10 } } }).contributes.settings;
        expect(pluginSettingValue(settings['mode']!, 'expanded')).toBe('expanded');
        expect(pluginSettingValue(settings['limit']!, 0)).toBe(0);
        expect(pluginSettingValue(settings['limit']!, 10)).toBe(10);
        for (const value of ['other', false, 1, null]) expect(() => pluginSettingValue(settings['mode']!, value)).toThrow();
        for (const value of [-1, 11, Infinity, NaN, '5']) expect(() => pluginSettingValue(settings['limit']!, value)).toThrow();
    });
});

describe('ephemeral contribution patches', () => {
    it('merges patches atomically, deletes context keys and resets declared item overrides', () => {
        const schema = manifest();
        const first = patchPluginContributionState(schema, { context: {}, items: {} }, { context: { ready: true, count: 2, phase: 'first' }, items: { [item.id]: { text: 'Busy', badge: '2', visible: false } } });
        const patch = { context: { phase: null, count: 3 }, items: { [item.id]: { enabled: false, badge: '' } } };
        const next = patchPluginContributionState(schema, first, patch);
        expect(next).toEqual({ context: { ready: true, count: 3 }, items: { [item.id]: { text: 'Busy', badge: '', visible: false, enabled: false } } });
        patch.context.count = 9;
        expect(next.context['count']).toBe(3);
        expect(first.context['count']).toBe(2);
        expect(patchPluginContributionState(schema, next, { items: { [item.id]: null } }).items).toEqual({});
        expect(() => patchPluginContributionState(schema, next, { context: { count: 9 }, items: { 'other.plugin.item': {} } })).toThrow('not declared');
        expect(next.context['count']).toBe(3);
    });
    it.each([
        { context: { nested: {} } }, { context: { values: [] } }, { context: { 'bad/key': true } },
        { context: { long: 'x'.repeat(4097) } }, { context: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, true])) },
        { context: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key${index}`, '💠'.repeat(1024)])) },
        { items: { [item.id]: { command: command.id } } }, { items: { [item.id]: { text: null } } },
        { items: { [item.id]: { visible: 'false' } } }, { items: { [item.id]: { enabled: null } } },
        { items: { [item.id]: { tone: 'custom' } } }, { pluginID: 'other.plugin' },
    ])('rejects invalid or excessive updates without touching current state: %j', patch => {
        const current = { context: { existing: true }, items: {} };
        expect(() => patchPluginContributionState(manifest(), current, patch)).toThrow();
        expect(current).toEqual({ context: { existing: true }, items: {} });
    });
});

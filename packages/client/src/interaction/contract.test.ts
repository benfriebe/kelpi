import { describe, expect, it } from 'vitest';
import {
    INTERACTION_LIMITS,
    interactionPaletteItem,
    normalizeInteractionOwner,
    validateInteractionAnswer,
    validateInteractionOptions,
    type InteractionModalRequest,
    type InteractionPaletteItem
} from './contract';

describe('interaction option validation', () => {
    it.each([
        ['ui.showInput', { title: 'Input', password: 'yes' }],
        ['ui.showInput', { title: 'Input', maxLength: 0 }],
        ['ui.showInput', { title: 'Input', maxLength: 2, value: 'long' }],
        ['ui.showInput', { title: 'Input', script: 'alert(1)' }],
        ['ui.showInput', { title: 'x'.repeat(201) }],
        ['ui.showQuickPick', { title: 'Pick', items: [{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }] }],
        ['ui.showQuickPick', { title: 'Pick', items: [{ id: 'x', label: 'A', disabled: true }], selectedID: 'x' }],
        ['ui.showQuickPick', { title: 'Pick', items: Array.from({ length: 201 }, (_, i) => ({ id: String(i), label: 'A' })) }],
        ['ui.showDialog', { title: 'Dialog', message: 'Hi', actions: [] }],
        ['ui.showDialog', { title: 'Dialog', message: 'Hi', actions: [{ id: 'ok', label: 'OK', kind: { toString: () => 'primary' } }] }],
        ['ui.showDialog', { title: 'Dialog', message: 'Hi', actions: [{ id: 'ok', label: 'OK' }], cancelID: 'missing' }],
        ['ui.showNotification', { message: 'Hi', tone: 'critical' }],
        ['ui.notAService', {}]
    ])('rejects malformed %s', (method, args) => {
        expect(() => validateInteractionOptions(method as string, args)).toThrow();
    });

    it('copies and freezes author data so later mutation cannot change the presented choice', () => {
        const args = { title: 'Pick', items: [{ id: 'one', label: 'Original' }] };
        const parsed = validateInteractionOptions('ui.showQuickPick', args);
        args.items[0]!.label = 'Changed';
        args.items.push({ id: 'two', label: 'Added' });
        expect(parsed.kind).toBe('quickPick');
        if (parsed.kind !== 'quickPick') throw new Error('wrong request');
        expect(parsed.options.items).toEqual([{ id: 'one', label: 'Original' }]);
        expect(Object.isFrozen(parsed.options)).toBe(true);
        expect(Object.isFrozen(parsed.options.items[0])).toBe(true);
    });

    it('re-checks an answer against the request it claims to settle', () => {
        const owner = normalizeInteractionOwner({ id: 'view', pluginID: 'example.test', pluginName: 'Test Plugin' });
        const pick = { id: 'ui-1', owner, ...validateInteractionOptions('ui.showQuickPick', {
            title: 'Pick', items: [{ id: 'no', label: 'Disabled', disabled: true }, { id: 'yes', label: 'Enabled' }]
        }) } as InteractionModalRequest;
        expect(() => validateInteractionAnswer(pick, 'no')).toThrow('enabled item');
        expect(() => validateInteractionAnswer(pick, 'yes')).not.toThrow();
        // Null is always a legal answer: it is what every cancellation path resolves with.
        expect(() => validateInteractionAnswer(pick, null)).not.toThrow();

        const input = { id: 'ui-2', owner, ...validateInteractionOptions('ui.showInput', { title: 'Input', maxLength: 2 }) } as InteractionModalRequest;
        expect(() => validateInteractionAnswer(input, 'long')).toThrow('at most 2');
        expect(() => validateInteractionAnswer(input, '')).not.toThrow();

        const dialog = { id: 'ui-3', owner, ...validateInteractionOptions('ui.showDialog', {
            title: 'Dialog', message: 'Choose', actions: [{ id: 'ok', label: 'OK' }]
        }) } as InteractionModalRequest;
        expect(() => validateInteractionAnswer(dialog, 'missing')).toThrow('Unknown UI action');
    });
});

describe('interaction owners', () => {
    it('keeps a plugin owner’s ID internal and renders its name, and accepts a native owner', () => {
        const plugin = normalizeInteractionOwner({ id: 'view-nonce', pluginID: 'example.test', pluginName: 'Test Plugin' });
        expect(plugin).toEqual({ id: 'view-nonce', kind: 'plugin', pluginID: 'example.test', displayName: 'Test Plugin' });
        const verb = normalizeInteractionOwner({ id: 'native:shortcut', kind: 'native', displayName: 'Kelpi' });
        expect(verb).toEqual({ id: 'native:shortcut', kind: 'native', displayName: 'Kelpi' });
        expect(verb.pluginID).toBeUndefined();
        expect(Object.isFrozen(plugin)).toBe(true);
        expect(() => normalizeInteractionOwner({ id: '', pluginID: 'example.test', pluginName: 'Test Plugin' })).toThrow('Scope ID');
    });
});

describe('the palette DTO projection', () => {
    const row = {
        id: 'cmd:new-pane', kind: 'command', icon: 'terminal', title: 'New Pane', subtitle: 'split the focused pane right',
        workspaceID: null, workspaceName: '', paneID: null, workspaceColor: null, shortcut: '⌘D'
    } satisfies InteractionPaletteItem;

    it('carries no function-valued field, whatever the source hands it', () => {
        const projected = interactionPaletteItem({ ...row, run: () => { throw new Error('a presenter must never hold this'); } } as InteractionPaletteItem);
        expect(Object.keys(projected)).not.toContain('run');
        expect(Object.values(projected).every(value => typeof value !== 'function')).toBe(true);
        expect(JSON.parse(JSON.stringify(projected))).toEqual({ ...row });
        expect(Object.isFrozen(projected)).toBe(true);
    });

    it('drops absent optionals rather than publishing undefined', () => {
        const { shortcut: _shortcut, ...bare } = row;
        const projected = interactionPaletteItem(bare);
        expect(Object.keys(projected)).not.toContain('shortcut');
        expect(Object.keys(projected)).not.toContain('disabled');
        expect(interactionPaletteItem({ ...bare, disabled: true }).disabled).toBe(true);
    });
});

describe('the limits', () => {
    it('are frozen, because a request that could raise its own ceiling has no ceiling', () => {
        expect(Object.isFrozen(INTERACTION_LIMITS)).toBe(true);
        expect(INTERACTION_LIMITS).toMatchObject({ scopePending: 8, windowPending: 32, notifications: 4, notificationMs: 10_000 });
    });
});

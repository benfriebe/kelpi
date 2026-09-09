import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUIServices, UI_SERVICE_LIMITS, type UIServiceModel } from './ui-services';

const models: UIServiceModel[] = [];
const model = (): UIServiceModel => { const value = createUIServices(); models.push(value); return value; };
const owner = (id: string) => ({ id, pluginID: 'example.test', pluginName: 'Test Plugin' });
afterEach(() => { for (const value of models.splice(0)) value.dispose(); vi.useRealTimers(); });

describe('window UI scopes and queues', () => {
    it('queues modal requests in order and resolves a choice exactly once', async () => {
        const service = model(), first = service.createScope(owner('first')), second = service.createScope(owner('second'));
        const a = first.request('ui.showInput', { title: 'First' });
        const b = second.request('ui.showDialog', { title: 'Second', message: 'Choose', actions: [{ id: 'yes', label: 'Yes' }] });
        const initial = service.getSnapshot().active!.id;
        expect(service.getSnapshot().queued).toBe(1);
        expect(() => service.answer(initial, 'answer')).not.toThrow();
        service.answer(initial, 'late duplicate');
        await expect(a).resolves.toBe('answer');
        expect(service.getSnapshot().active?.owner.id).toBe('second');
        expect(() => service.answer(service.getSnapshot().active!.id, 'missing')).toThrow('Unknown UI action');
        service.answer(service.getSnapshot().active!.id, 'yes');
        await expect(b).resolves.toBe('yes');
        expect(service.getSnapshot().active).toBeNull();
    });

    it('cancels only the disposed view’s active, queued, and notification requests', async () => {
        const service = model(), first = service.createScope(owner('first')), second = service.createScope(owner('second'));
        const active = first.request('ui.showInput', { title: 'Active' });
        const other = second.request('ui.showInput', { title: 'Other' });
        const queued = first.request('ui.showInput', { title: 'Queued' });
        const notification = first.request('ui.showNotification', { message: 'Notice' });
        first.dispose(); first.dispose();
        await expect(Promise.all([active, queued, notification])).resolves.toEqual([null, null, null]);
        expect(service.getSnapshot().active?.owner.id).toBe('second');
        expect(service.getSnapshot().queued).toBe(0);
        expect(service.getSnapshot().notifications).toEqual([]);
        await expect(first.request('ui.showInput', { title: 'Stale' })).rejects.toThrow('no longer owns');
        service.dispose(); service.dispose();
        await expect(other).resolves.toBeNull();
        expect(() => service.createScope(owner('new'))).toThrow('disposed');
    });

    it('bounds each scope and the entire window, then releases capacity on disposal', async () => {
        const service = model();
        const scopes = Array.from({ length: 4 }, (_, i) => service.createScope(owner(String(i))));
        const requests = scopes.flatMap(scope => Array.from({ length: UI_SERVICE_LIMITS.scopePending }, () => scope.request('ui.showInput', { title: 'Queued' })));
        await expect(scopes[0]!.request('ui.showInput', { title: 'Excess' })).rejects.toThrow('Too many pending');
        const extra = service.createScope(owner('extra'));
        await expect(extra.request('ui.showInput', { title: 'Window excess' })).rejects.toThrow('Too many pending');
        scopes[0]!.dispose();
        const admitted = extra.request('ui.showInput', { title: 'Room now' });
        service.dispose();
        await expect(Promise.all([...requests, admitted])).resolves.toHaveLength(33);
    });

    it('copies and freezes author data so later mutation cannot change the presented choice', async () => {
        const service = model(), scope = service.createScope(owner('view'));
        const args = { title: 'Pick', items: [{ id: 'one', label: 'Original' }] };
        const result = scope.request('ui.showQuickPick', args);
        args.items[0]!.label = 'Changed'; args.items.push({ id: 'two', label: 'Added' });
        const request = service.getSnapshot().active;
        expect(request?.kind).toBe('quickPick');
        if (request?.kind !== 'quickPick') throw new Error('wrong request');
        expect(request.options.items).toEqual([{ id: 'one', label: 'Original' }]);
        expect(Object.isFrozen(request.options.items[0])).toBe(true);
        service.answer(request.id, 'one'); await expect(result).resolves.toBe('one');
    });
});

describe('window UI validation', () => {
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
        ['ui.notAService', {}],
    ])('rejects malformed %s without reserving queue capacity', async (method, args) => {
        const service = model(), scope = service.createScope(owner('view'));
        await expect(scope.request(method as string, args)).rejects.toThrow();
        expect(service.getSnapshot()).toEqual({ active: null, queued: 0, notifications: [] });
    });

    it('rejects a disabled choice and an input over its limit without settling', async () => {
        const service = model(), scope = service.createScope(owner('view'));
        const choice = scope.request('ui.showQuickPick', { title: 'Pick', items: [{ id: 'no', label: 'Disabled', disabled: true }] });
        expect(() => service.answer(service.getSnapshot().active!.id, 'no')).toThrow('enabled item');
        service.answer(service.getSnapshot().active!.id, null); await expect(choice).resolves.toBeNull();
        const input = scope.request('ui.showInput', { title: 'Input', maxLength: 2 });
        expect(() => service.answer(service.getSnapshot().active!.id, 'long')).toThrow('at most 2');
        service.answer(service.getSnapshot().active!.id, ''); await expect(input).resolves.toBe('');
    });
});

describe('notification timers', () => {
    it('shows four at once and starts a queued notification’s timeout only when it becomes visible', async () => {
        vi.useFakeTimers();
        const service = model(), scope = service.createScope(owner('view'));
        const results = Array.from({ length: 5 }, (_, i) => scope.request('ui.showNotification', { message: `Notice ${i}` }));
        expect(service.getSnapshot().notifications).toHaveLength(4);
        expect(vi.getTimerCount()).toBe(4);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(Promise.all(results.slice(0, 4))).resolves.toEqual([null, null, null, null]);
        expect(service.getSnapshot().notifications).toHaveLength(1);
        expect(service.getSnapshot().notifications[0]?.options.message).toBe('Notice 4');
        expect(vi.getTimerCount()).toBe(1);
        scope.dispose();
        await expect(results[4]).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
});

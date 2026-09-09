import { expect, it, vi } from 'vitest';
import { createKelpiAPI, type ContributionState } from '../index.js';

it('exposes the same contribution facade to backend and browser transports', async () => {
    const state: ContributionState = { context: { ready: true, count: 2 }, items: { 'sample.plugin.status': { badge: '2' } } };
    const call = vi.fn(async () => state);
    const api = createKelpiAPI(call);
    expect(await api.contributions.get()).toEqual(state);
    expect(call).toHaveBeenLastCalledWith('contributions.get', {});
    const update = { context: { count: 2, retired: null }, items: { 'sample.plugin.status': { badge: '2' }, 'sample.plugin.old': null } };
    expect(await api.contributions.update(update)).toEqual(state);
    expect(call).toHaveBeenLastCalledWith('contributions.update', update);
    expect(Object.isFrozen(api.contributions)).toBe(true);
});

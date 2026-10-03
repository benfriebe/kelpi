import { describe, expect, it } from 'vitest';

import { cellMatches, FindCache, MatchCollector, needleOf, stepIndex, toViewOrder, type FindIndex } from './find.js';

const index = (matches: readonly (readonly [number, number])[], revision = 1): FindIndex => {
    const collector = new MatchCollector();
    for (const [row, column] of matches) collector.add(row, column);
    return collector.finish('q', revision);
};

describe('csv find', () => {
    it('matches case-insensitively and never on an empty needle', () => {
        expect(cellMatches('Hello World', needleOf('WORLD'))).toBe(true);
        expect(cellMatches('abc', needleOf(''))).toBe(false);
    });

    it('caps the collector and grows its arrays', () => {
        const collector = new MatchCollector(3000);
        for (let i = 0; i < 5000; i += 1) collector.add(i, 0);
        const result = collector.finish('x', 1);
        expect(result.total).toBe(3000);
        expect(result.truncated).toBe(true);
        expect(result.rows[2999]).toBe(2999);
    });

    it('maps file order to a sorted view order (view, then display column)', () => {
        // logical rows 0..3; the view shows them as [3, 1, 0, 2] → inverse[logical] = view.
        const inverse = new Uint32Array([2, 1, 3, 0]);
        const positions = new Map([[5, 0], [9, 1]]);
        const order = toViewOrder(index([[0, 9], [1, 5], [3, 9], [3, 5], [2, 5]]), inverse, positions);
        expect([...order.views]).toEqual([0, 0, 1, 2, 3]);
        expect([...order.columns]).toEqual([5, 9, 5, 9, 5]);
        expect([...order.rows]).toEqual([3, 3, 1, 0, 2]);
    });

    it('steps next/previous with wrap-around and from nowhere', () => {
        const order = toViewOrder(index([[1, 0], [1, 2], [4, 1]]), null, new Map([[0, 0], [1, 1], [2, 2]]));
        expect(stepIndex(order, null, 'next')).toBe(0);
        expect(stepIndex(order, null, 'previous')).toBe(2);
        expect(stepIndex(order, { view: 1, position: 0 }, 'next')).toBe(1);
        expect(stepIndex(order, { view: 1, position: 2 }, 'next')).toBe(2);
        expect(stepIndex(order, { view: 4, position: 1 }, 'next')).toBe(0);
        expect(stepIndex(order, { view: 4, position: 1 }, 'previous')).toBe(1);
        expect(stepIndex(order, { view: 0, position: 0 }, 'previous')).toBe(2);
        expect(stepIndex(order, { view: 3, position: 0 }, 'next')).toBe(2);
        expect(stepIndex(toViewOrder(index([]), null, new Map()), null, 'next')).toBe(-1);
    });

    it('keeps the last four queries per revision', () => {
        const cache = new FindCache();
        for (const query of ['a', 'b', 'c', 'd', 'e']) cache.set({ ...index([]), query });
        expect(cache.queries).toEqual(['b', 'c', 'd', 'e']);
        expect(cache.get('b', 1)).not.toBeNull();
        expect(cache.queries).toEqual(['c', 'd', 'e', 'b']);
        expect(cache.get('c', 2)).toBeNull();
        expect(cache.queries).toEqual(['d', 'e', 'b']);
    });
});

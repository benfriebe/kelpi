import { describe, expect, it } from 'vitest';

import { createActivationSequence, recentWorkspaceOrder } from './recent-workspaces';

const none = new Map<string, number>();

describe('recentWorkspaceOrder', () => {
    it('puts the active workspace first, then newest-first', () => {
        const order = recentWorkspaceOrder(
            [
                { id: 'a', lastAccessedAt: 100 },
                { id: 'b', lastAccessedAt: 300 },
                { id: 'c', lastAccessedAt: 200 }
            ],
            'a',
            none
        );
        expect(order).toEqual(['a', 'b', 'c']);
    });

    it('breaks a same-second tie by this window’s activation sequence', () => {
        const seq = new Map([
            ['b', 1],
            ['c', 2]
        ]);
        expect(
            recentWorkspaceOrder(
                [
                    { id: 'a', lastAccessedAt: 500 },
                    { id: 'b', lastAccessedAt: 400 },
                    { id: 'c', lastAccessedAt: 400 }
                ],
                'a',
                seq
            )
        ).toEqual(['a', 'c', 'b']);
    });

    it('falls back to sidebar order on a full tie', () => {
        expect(
            recentWorkspaceOrder(
                [
                    { id: 'x', lastAccessedAt: 1 },
                    { id: 'y', lastAccessedAt: 1 },
                    { id: 'z', lastAccessedAt: 1 }
                ],
                null,
                none
            )
        ).toEqual(['x', 'y', 'z']);
    });

    it('sorts a missing or non-number timestamp as oldest', () => {
        expect(
            recentWorkspaceOrder(
                [
                    { id: 'old', lastAccessedAt: undefined },
                    { id: 'nan', lastAccessedAt: Number.NaN },
                    { id: 'new', lastAccessedAt: 10 }
                ],
                null,
                none
            )
        ).toEqual(['new', 'old', 'nan']);
    });

    it('omits an active ID that is not a candidate (a remote workspace, or one just deleted)', () => {
        expect(recentWorkspaceOrder([{ id: 'a', lastAccessedAt: 1 }], 'gone', none)).toEqual(['a']);
    });
});

describe('createActivationSequence', () => {
    it('numbers each change of active workspace, ignoring repeats and null', () => {
        const sequence = createActivationSequence();
        sequence.note('a');
        sequence.note('a');
        sequence.note(null);
        sequence.note('b');
        sequence.note('a');
        expect(sequence.seq.get('b')).toBe(2);
        expect(sequence.seq.get('a')).toBe(3);
    });
});

/**
 * #307: the sidebar cue for a workspace created in the background. See `new-workspace-cue.ts`.
 */

import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import {
    NEW_WORKSPACE_CUE_MS,
    arrivedWorkspaceIDs,
    createNewWorkspaceCue,
    useNewWorkspaceArrivals
} from './new-workspace-cue';

afterEach(() => {
    vi.useRealTimers();
});

function Arrivals(props: { ids: readonly string[]; attached: boolean; onArrive: (id: string) => void }): ReactElement | null {
    useNewWorkspaceArrivals(props.ids, props.attached, props.onArrive);
    return null;
}

describe('arrivedWorkspaceIDs', () => {
    it('adopts the first pass, then reports only ids it has not seen, in order', () => {
        expect(arrivedWorkspaceIDs(null, ['A', 'B'])).toEqual([]);
        expect(arrivedWorkspaceIDs(new Set(['A', 'B']), ['A', 'C', 'B', 'D'])).toEqual(['C', 'D']);
        expect(arrivedWorkspaceIDs(new Set(['A', 'B']), ['A'])).toEqual([]);
    });
});

describe('useNewWorkspaceArrivals', () => {
    it('adopts the first snapshot silently and reports a workspace that arrives after it', () => {
        const arrived: string[] = [];
        const onArrive = (id: string): void => {
            arrived.push(id);
        };
        const { rerender } = render(<Arrivals ids={['A']} attached onArrive={onArrive} />);
        expect(arrived).toEqual([]);
        rerender(<Arrivals ids={['A', 'B']} attached onArrive={onArrive} />);
        expect(arrived).toEqual(['B']);
        // A re-render with the same ids is not an arrival.
        rerender(<Arrivals ids={['A', 'B']} attached onArrive={onArrive} />);
        expect(arrived).toEqual(['B']);
    });

    it('coalesces a burst to its newest workspace', () => {
        const arrived: string[] = [];
        const { rerender } = render(<Arrivals ids={['A']} attached onArrive={(id) => arrived.push(id)} />);
        rerender(<Arrivals ids={['A', 'W1', 'W2', 'W3']} attached onArrive={(id) => arrived.push(id)} />);
        expect(arrived).toEqual(['W3']);
    });

    it('re-adopts after a detach, so a reconnect does not light up what it finds', () => {
        const arrived: string[] = [];
        const onArrive = (id: string): void => {
            arrived.push(id);
        };
        const { rerender } = render(<Arrivals ids={['A']} attached onArrive={onArrive} />);
        rerender(<Arrivals ids={['A']} attached={false} onArrive={onArrive} />);
        // Created while this window was away: adopted with the next snapshot, not announced.
        rerender(<Arrivals ids={['A', 'B']} attached={false} onArrive={onArrive} />);
        rerender(<Arrivals ids={['A', 'B']} attached onArrive={onArrive} />);
        expect(arrived).toEqual([]);
        rerender(<Arrivals ids={['A', 'B', 'C']} attached onArrive={onArrive} />);
        expect(arrived).toEqual(['C']);
    });
});

describe('createNewWorkspaceCue', () => {
    it('highlights the row, then clears itself; a second arrival replaces the first', () => {
        vi.useFakeTimers();
        const states: (string | null)[] = [];
        const cue = createNewWorkspaceCue((id) => states.push(id));
        cue.show('A');
        vi.advanceTimersByTime(NEW_WORKSPACE_CUE_MS - 1);
        cue.show('B');
        vi.advanceTimersByTime(NEW_WORKSPACE_CUE_MS - 1);
        expect(states).toEqual(['A', 'B']);
        vi.advanceTimersByTime(1);
        expect(states).toEqual(['A', 'B', null]);
    });

    it('dispose cancels a pending clear', () => {
        vi.useFakeTimers();
        const states: (string | null)[] = [];
        const cue = createNewWorkspaceCue((id) => states.push(id));
        cue.show('A');
        cue.dispose();
        vi.advanceTimersByTime(NEW_WORKSPACE_CUE_MS * 2);
        expect(states).toEqual(['A']);
    });
});

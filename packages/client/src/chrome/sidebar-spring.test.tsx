/**
 * §WS-008's reorder, wired to real physics — the sidebar half of `spring.test.ts`.
 *
 * `spring.test.ts` proves the integrator. This proves the *wiring*: that a row which changed
 * place is displaced on the `translate` channel, that the displacement is driven frame by frame
 * rather than declared, that it overshoots and comes back, and — the discriminator — that a
 * second reorder landing mid-flight RETARGETS the same motion instead of restarting it.
 *
 * jsdom has no box model, so the FLIP measures nothing by default and every test here would be
 * vacuous. `installFakeLayout` supplies the one thing that is missing: `offsetTop` derived from a
 * row's index among its siblings and `offsetLeft` from its own indent. That is deliberately the
 * *transform-free* pair the component measures — patching `getBoundingClientRect` instead would
 * have let the animation's own output back into the measurement, which is the bug the choice of
 * `offsetTop` exists to prevent.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromePane, ChromeSidebarEntry, ChromeWorkspace } from './types';

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const W3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const G1 = 'cccccccc-0000-4000-8000-000000000001';

const ROW_PX = 34;

function pane(id: string): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test/code',
        gitBranch: null,
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function workspace(id: string, name: string): ChromeWorkspace {
    return { id, name, color: 'blue', icon: null, labels: [], panes: [pane(`${id}-p1`)] };
}

function flat(...ids: readonly string[]): ChromeSidebarEntry[] {
    return ids.map((id) => ({ kind: 'workspace', workspace: workspace(id, id.slice(-1)) }));
}

function baseProps() {
    return { activeWorkspaceID: W1, filter: '', onFilterChange: vi.fn(), rowHeight: ROW_PX };
}

/** A minimal, transform-free box model: `offsetTop` by sibling index, `offsetLeft` by indent. */
function installFakeLayout(): () => void {
    const proto = HTMLElement.prototype;
    const top = Object.getOwnPropertyDescriptor(proto, 'offsetTop');
    const left = Object.getOwnPropertyDescriptor(proto, 'offsetLeft');
    Object.defineProperty(proto, 'offsetTop', {
        configurable: true,
        get(this: HTMLElement): number {
            const parent = this.parentElement;
            if (parent === null) return 0;
            return Array.prototype.indexOf.call(parent.children, this) * ROW_PX;
        }
    });
    Object.defineProperty(proto, 'offsetLeft', {
        configurable: true,
        get(this: HTMLElement): number {
            return Number.parseFloat(this.style.marginLeft) || 0;
        }
    });
    return () => {
        if (top === undefined) delete (proto as unknown as Record<string, unknown>)['offsetTop'];
        else Object.defineProperty(proto, 'offsetTop', top);
        if (left === undefined) delete (proto as unknown as Record<string, unknown>)['offsetLeft'];
        else Object.defineProperty(proto, 'offsetLeft', left);
    };
}

function rowFor(id: string): HTMLElement {
    const row = screen.getAllByTestId('workspace-row').find((el) => el.dataset['workspaceId'] === id);
    if (row === undefined) throw new Error(`no row for ${id}`);
    return row;
}

/** One axis of a row's `translate`, in px. `''` (settled) reads as 0 on both. */
function translateAxis(element: HTMLElement, axis: 0 | 1): number {
    const value = element.style.translate;
    if (value === '') return 0;
    return Number.parseFloat(value.split(/\s+/)[axis] ?? '0') || 0;
}

const translateX = (element: HTMLElement): number => translateAxis(element, 0);
const translateY = (element: HTMLElement): number => translateAxis(element, 1);

/** Advance one 60 Hz frame and hand back what the row is drawn at. */
function frame(element: HTMLElement): number {
    act(() => {
        vi.advanceTimersByTime(1000 / 60);
    });
    return translateY(element);
}

let restoreLayout: (() => void) | null = null;

afterEach(() => {
    cleanup();
    restoreLayout?.();
    restoreLayout = null;
    vi.useRealTimers();
});

describe('the sidebar’s reorder is driven by the spring (§WS-008)', () => {
    it('displaces a row that changed place, then runs it home frame by frame', () => {
        vi.useFakeTimers();
        restoreLayout = installFakeLayout();
        const { rerender } = render(<Sidebar {...baseProps()} entries={flat(W1, W2, W3)} />);
        // Mount is the baseline: nothing animates a sidebar into existence.
        expect(rowFor(W1).style.translate).toBe('');

        act(() => {
            rerender(<Sidebar {...baseProps()} entries={flat(W2, W1, W3)} />);
        });

        // The FLIP's first frame: each swapped row is pushed back to where it WAS.
        expect(translateY(rowFor(W1))).toBeCloseTo(-ROW_PX, 1);
        expect(translateY(rowFor(W2))).toBeCloseTo(ROW_PX, 1);
        // The row that did not move is not animating at all.
        expect(rowFor(W3).style.translate).toBe('');

        const samples: number[] = [];
        for (let index = 0; index < 40; index++) samples.push(frame(rowFor(W2)));

        // Dense, not two keyframes: every frame moved it.
        const distinct = new Set(samples.map((value) => value.toFixed(3)));
        expect(distinct.size).toBeGreaterThan(15);
        // Monotonic down to the target …
        expect(samples[0]).toBeLessThan(ROW_PX);
        expect(samples[3] ?? 0).toBeLessThan(samples[0] ?? 0);
        // … then OVERSHOOTS through it and comes back — ζ = 0.8 is underdamped.
        expect(Math.min(...samples)).toBeLessThan(-0.2);
        // … and settles exactly, with the channel cleared off the node.
        expect(samples.at(-1)).toBe(0);
        expect(rowFor(W2).style.translate).toBe('');
    });

    /**
     * THE DISCRIMINATOR, at the component level.
     *
     * Reorder again before the first displacement has settled — what a drag does every time the
     * cursor crosses a row. A CSS transition restarted here begins from the current position with
     * ZERO velocity: the very next frame reverses. A spring carries its velocity, so the row
     * keeps going the way it was for at least a frame, and no frame jumps.
     */
    it('RETARGETS a displacement that is still in flight instead of restarting it', () => {
        vi.useFakeTimers();
        restoreLayout = installFakeLayout();
        const { rerender } = render(<Sidebar {...baseProps()} entries={flat(W1, W2, W3)} />);
        act(() => {
            rerender(<Sidebar {...baseProps()} entries={flat(W2, W1, W3)} />);
        });

        const before: number[] = [];
        for (let index = 0; index < 5; index++) before.push(frame(rowFor(W2)));
        const travelling = (before.at(-1) ?? 0) - (before.at(-2) ?? 0);
        // Mid-flight and moving downward (toward 0 from +34).
        expect(travelling).toBeLessThan(-0.5);
        const atRetarget = before.at(-1) ?? 0;
        expect(atRetarget).toBeGreaterThan(1);

        // The row is crossed again, the other way.
        act(() => {
            rerender(<Sidebar {...baseProps()} entries={flat(W1, W2, W3)} />);
        });
        const seeded = translateY(rowFor(W2));
        // Position is continuous: the new layout delta is ADDED to where the row already was.
        expect(seeded).toBeCloseTo(atRetarget - ROW_PX, 1);

        // Velocity is continuous: one more frame still travels in the old direction.
        const next = frame(rowFor(W2));
        expect(next).toBeLessThan(seeded);

        const after: number[] = [next];
        for (let index = 0; index < 40; index++) after.push(frame(rowFor(W2)));
        // No frame jumps: the reversal is smooth, not a cut.
        const jumps = after.slice(1).map((value, index) => Math.abs(value - (after[index] ?? 0)));
        expect(Math.max(...jumps)).toBeLessThan(6);
        expect(after.at(-1)).toBe(0);
    });

    /**
     * §WS-089's indent, on the horizontal half of the same FLIP.
     *
     * `margin-left` itself stays DISCRETE — it is 24px the instant the nesting is decided, which
     * is what keeps `getComputedStyle(row).marginLeft` an exact answer — and what slides is the
     * `x` channel of the spring.
     */
    it('springs the indent when a row changes depth, without animating margin-left', () => {
        vi.useFakeTimers();
        restoreLayout = installFakeLayout();
        const top: ChromeSidebarEntry[] = [
            { kind: 'workspace', workspace: workspace(W1, 'alpha') },
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
                workspaces: [workspace(W2, 'beta')]
            }
        ];
        const nested: ChromeSidebarEntry[] = [
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
                workspaces: [workspace(W1, 'alpha'), workspace(W2, 'beta')]
            }
        ];
        const { rerender } = render(<Sidebar {...baseProps()} entries={top} />);
        expect(rowFor(W1).style.marginLeft).toBe('0px');

        act(() => {
            rerender(<Sidebar {...baseProps()} entries={nested} />);
        });

        // The property landed exactly, in one commit — no transition on it at all.
        expect(rowFor(W1).style.marginLeft).toBe('24px');
        expect(rowFor(W1).style.transition).not.toContain('margin-left');
        // …and the movement the eye sees is the spring, starting 24px to the left.
        expect(translateX(rowFor(W1))).toBeCloseTo(-24, 1);

        for (let index = 0; index < 60; index++) frame(rowFor(W1));
        expect(rowFor(W1).style.translate).toBe('');
        expect(rowFor(W1).style.marginLeft).toBe('24px');
    });

    it('declares the spring channel on every row kind, so an audit can see it', () => {
        restoreLayout = installFakeLayout();
        render(
            <Sidebar
                {...baseProps()}
                entries={[
                    { kind: 'workspace', workspace: workspace(W1, 'alpha') },
                    {
                        kind: 'group',
                        group: { id: G1, name: 'squad', color: null, icon: null, isCollapsed: false },
                        workspaces: []
                    }
                ]}
            />
        );
        expect(rowFor(W1).dataset['reorder']).toBe('spring');
        expect(screen.getByTestId('group-header').dataset['reorder']).toBe('spring');
        expect(screen.getByTestId('group-empty').dataset['reorder']).toBe('spring');
        // The reorder no longer rides on the transition; what is left on `transform` is the lift.
        expect(rowFor(W1).style.transition).toContain('transform');
    });

    /**
     * Found by the `sidebar-spring` audit step and fixed here: the drag effect lists `props` in
     * its dependencies, so every parent render — the 1-second agent-status tick included — re-ran
     * it, and its cleanup used to destroy §WS-084's ghost and cancel §5.5's 650 ms dwell as if
     * the gesture had ended. A drag that outlived one tick lost the row following the cursor,
     * and the drop settle (which is measured from where the ghost died) had nothing to measure.
     */
    it('keeps the drag ghost and the spring-load dwell across a re-render mid-drag (§WS-084/§5.5)', () => {
        vi.useFakeTimers();
        // No fake layout here on purpose: jsdom's all-zero rects put the drag on the uniform
        // `rowHeight` fallback, which is the geometry `sidebar-polish.test.tsx` reads its band
        // arithmetic from — alpha 4–24 · delta 24–44 · the group header 44–64.
        const collapsed: ChromeSidebarEntry[] = [
            { kind: 'workspace', workspace: workspace(W1, 'alpha') },
            { kind: 'workspace', workspace: workspace(W3, 'delta') },
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: true },
                workspaces: [workspace(W2, 'beta')]
            }
        ];
        const listProps = { ...baseProps(), rowHeight: 20 };
        const { rerender } = render(<Sidebar {...listProps} entries={collapsed} springLoadMs={650} />);

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        // y=58 is the collapsed group header's lower half → the dwell starts.
        fireEvent.mouseMove(window, { clientY: 58 });
        expect(document.querySelectorAll('[data-testid="sidebar-drag-ghost"]')).toHaveLength(1);

        // The tick: same entries, a brand-new props object, exactly as the parent hands down.
        act(() => {
            vi.advanceTimersByTime(300);
            rerender(<Sidebar {...baseProps()} rowHeight={20} entries={collapsed} springLoadMs={650} />);
        });
        expect(document.querySelectorAll('[data-testid="sidebar-drag-ghost"]')).toHaveLength(1);

        // …and the dwell that started before it still fires at 650 ms, not 650 ms after the tick.
        act(() => {
            vi.advanceTimersByTime(400);
        });
        expect(screen.getByTestId('group-header').dataset['collapsed']).toBe('false');

        // The gesture ending is still what takes the ghost away.
        act(() => {
            fireEvent.mouseUp(window);
        });
        expect(document.querySelectorAll('[data-testid="sidebar-drag-ghost"]')).toHaveLength(0);
    });

    it('leaves nothing behind when a springing row is removed', () => {
        vi.useFakeTimers();
        restoreLayout = installFakeLayout();
        const { rerender } = render(<Sidebar {...baseProps()} entries={flat(W1, W2, W3)} />);
        act(() => {
            rerender(<Sidebar {...baseProps()} entries={flat(W2, W1, W3)} />);
        });
        expect(rowFor(W2).style.translate).not.toBe('');

        act(() => {
            rerender(<Sidebar {...baseProps()} entries={flat(W1, W3)} />);
        });
        // The row is gone from the list; its ghost is a clone in the out-of-flow layer, and it
        // must not carry the dead row's live spring offset onto the box it was pinned to.
        const ghosts = screen.queryAllByTestId('sidebar-row-ghost');
        expect(ghosts.length).toBeGreaterThan(0);
        for (const ghost of ghosts) expect(ghost.style.translate).toBe('none');

        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(screen.queryAllByTestId('sidebar-row-ghost')).toHaveLength(0);
    });
});

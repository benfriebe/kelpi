/**
 * agent-lifecycle.md §7.1's web-client attention signal (issue #57 agl-m2): the title flash
 * the browser client runs where the macOS shell bounces the dock.
 */

import { describe, expect, it } from 'vitest';

import { createAttentionSignal, type AttentionSignal } from './attention';

interface Harness {
    readonly signal: AttentionSignal;
    readonly doc: { title: string; hidden: boolean; focused: boolean };
    /** Every title write, in order. */
    readonly titles: string[];
    /** Runs the next scheduled tick; false when nothing is pending. */
    step(): boolean;
    pending(): number;
    fire(type: 'visibilitychange' | 'focus'): void;
}

function harness(initial: { hidden?: boolean; focused?: boolean; flashes?: number } = {}): Harness {
    const timers = new Map<number, () => void>();
    let nextHandle = 1;
    const listeners = new Map<string, Set<() => void>>();
    const titles: string[] = [];
    let title = 'Kelpi';
    const doc = {
        hidden: initial.hidden ?? true,
        focused: initial.focused ?? false,
        get title(): string {
            return title;
        },
        set title(next: string) {
            title = next;
            titles.push(next);
        },
        hasFocus(): boolean {
            return this.focused;
        },
        addEventListener(type: string, listener: () => void): void {
            listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
        },
        removeEventListener(type: string, listener: () => void): void {
            listeners.get(type)?.delete(listener);
        }
    };
    const signal = createAttentionSignal({
        document: doc,
        view: doc,
        label: 'Agent is waiting for input',
        flashes: initial.flashes ?? 2,
        intervalMs: 700,
        setTimeout: (callback) => {
            const handle = nextHandle;
            nextHandle += 1;
            timers.set(handle, callback);
            return handle;
        },
        clearTimeout: (handle) => {
            timers.delete(handle as number);
        }
    });
    return {
        signal,
        doc,
        titles,
        step(): boolean {
            const first = timers.entries().next();
            if (first.done) return false;
            timers.delete(first.value[0]);
            first.value[1]();
            return true;
        },
        pending: () => timers.size,
        fire(type): void {
            for (const listener of listeners.get(type) ?? []) listener();
        }
    };
}

function drain(h: Harness): void {
    while (h.step()) {
        /* run every scheduled tick */
    }
}

describe('createAttentionSignal (§7.1 web client equivalent of the dock bounce)', () => {
    it('flashes the label N times and ends on the resting title while the tab is hidden', () => {
        const h = harness({ hidden: true, flashes: 2 });
        h.signal.request();
        drain(h);
        expect(h.titles).toEqual([
            'Agent is waiting for input',
            'Kelpi',
            'Agent is waiting for input',
            'Kelpi',
            // The closing restore, the same write `dispose` makes.
            'Kelpi'
        ]);
        expect(h.doc.title).toBe('Kelpi');
        expect(h.pending()).toBe(0);
    });

    it('is a no-op while the tab is visible and focused: the user is already looking', () => {
        const h = harness({ hidden: false, focused: true });
        h.signal.request();
        expect(h.titles).toEqual([]);
        expect(h.pending()).toBe(0);
    });

    it('still flashes a visible but unfocused tab (another window is in front)', () => {
        const h = harness({ hidden: false, focused: false, flashes: 1 });
        h.signal.request();
        expect(h.doc.title).toBe('Agent is waiting for input');
        drain(h);
        expect(h.doc.title).toBe('Kelpi');
    });

    it('coalesces requests that arrive mid-flash into the one running signal', () => {
        const h = harness({ hidden: true, flashes: 1 });
        h.signal.request();
        h.signal.request();
        h.signal.request();
        drain(h);
        expect(h.titles).toEqual(['Agent is waiting for input', 'Kelpi', 'Kelpi']);
    });

    it('ends early and restores the title as soon as focus comes back', () => {
        const h = harness({ hidden: true, flashes: 3 });
        h.signal.request();
        expect(h.doc.title).toBe('Agent is waiting for input');
        h.doc.hidden = false;
        h.doc.focused = true;
        h.fire('focus');
        expect(h.doc.title).toBe('Kelpi');
        expect(h.pending()).toBe(0);
    });

    /**
     * favicon.ts writes `(N) Kelpi` on every summary change (§8.4). A badge that lands while
     * the label is up must be what the flash comes back to, never the stale pre-flash title.
     */
    it('adopts a title the badge wrote mid-flash instead of clobbering it', () => {
        const h = harness({ hidden: true, flashes: 2 });
        h.signal.request();
        expect(h.doc.title).toBe('Agent is waiting for input');
        h.doc.title = '(1) Kelpi';
        drain(h);
        expect(h.doc.title).toBe('(1) Kelpi');
        expect(h.titles).not.toContain('Kelpi');
    });

    it('dispose cancels the flash and puts the resting title back', () => {
        const h = harness({ hidden: true, flashes: 3 });
        h.signal.request();
        h.signal.dispose();
        expect(h.doc.title).toBe('Kelpi');
        expect(h.pending()).toBe(0);
    });

    it('degrades to a no-op without a document', () => {
        const signal = createAttentionSignal({ document: null, view: null });
        expect(() => {
            signal.request();
            signal.dispose();
        }).not.toThrow();
    });
});

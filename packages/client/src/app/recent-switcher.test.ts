import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    RELAYED_RELEASE_GRACE_MS,
    SWITCHER_SHOW_DELAY_MS,
    actionsDuringGesture,
    createRecentSwitcher,
    heldModifiersFromEvent,
    type SwitcherState
} from './recent-switcher';

const up = { ctrlKey: false, altKey: false, metaKey: false };
const ctrlDown = { ctrlKey: true, altKey: false, metaKey: false };

function harness(order: readonly string[] = ['a', 'b', 'c', 'd']) {
    const commits: string[] = [];
    const states: (SwitcherState | null)[] = [];
    const switcher = createRecentSwitcher({
        order: () => order,
        commit: (id) => commits.push(id),
        onChange: (state) => states.push(state),
        now: () => Date.now()
    });
    return { switcher, commits, states, last: () => states.at(-1) ?? null };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('recent switcher', () => {
    it('quick tap: commits the previous workspace and never shows', () => {
        const h = harness();
        expect(h.switcher.step(1, ['ctrl'])).toBe(true);
        h.switcher.keyUp(up);
        vi.advanceTimersByTime(SWITCHER_SHOW_DELAY_MS * 2);
        expect(h.commits).toEqual(['b']);
        expect(h.states.some((state) => state?.shown === true)).toBe(false);
        expect(h.switcher.state()).toBeNull();
    });

    it('hold: shows after the delay, steps, and commits on release', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl']);
        vi.advanceTimersByTime(SWITCHER_SHOW_DELAY_MS);
        expect(h.last()).toEqual({ order: ['a', 'b', 'c', 'd'], index: 1, shown: true });
        h.switcher.step(1, ['ctrl']);
        h.switcher.keyUp(ctrlDown); // the Tab keyup: ⌃ still down
        expect(h.commits).toEqual([]);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual(['c']);
        expect(h.last()).toBeNull();
    });

    it('repeat steps wrap in both directions', () => {
        const h = harness(['a', 'b', 'c']);
        h.switcher.step(1, ['ctrl']); // b
        h.switcher.step(1, ['ctrl']); // c
        h.switcher.step(1, ['ctrl']); // a (wrapped)
        expect(h.switcher.state()?.index).toBe(0);
        h.switcher.step(-1, ['ctrl']); // c (wrapped back)
        expect(h.switcher.state()?.index).toBe(2);
    });

    it('starting with ⌃⇧Tab starts on the least recent', () => {
        const h = harness();
        h.switcher.step(-1, ['ctrl']);
        expect(h.switcher.state()?.index).toBe(3);
    });

    it('Escape cancels without switching', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl']);
        expect(h.switcher.cancel()).toBe(true);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual([]);
        expect(h.switcher.cancel()).toBe(false);
    });

    it('window blur commits the highlighted row', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl']);
        h.switcher.step(1, ['ctrl']);
        h.switcher.blur();
        expect(h.commits).toEqual(['c']);
    });

    it('a picked row commits that row', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl']);
        h.switcher.pick('d');
        expect(h.commits).toEqual(['d']);
    });

    it('fewer than two workspaces: not consumed, nothing happens', () => {
        const h = harness(['only']);
        expect(h.switcher.step(1, ['ctrl'])).toBe(false);
        expect(h.commits).toEqual([]);
        expect(h.switcher.state()).toBeNull();
    });

    it('a bare-key trigger has nothing to hold, so it commits at once', () => {
        const h = harness();
        h.switcher.step(1, []);
        expect(h.commits).toEqual(['b']);
        expect(h.switcher.state()).toBeNull();
    });

    it('rebound to ⌥Tab, releasing ⌃ does nothing and releasing ⌥ commits', () => {
        const h = harness();
        h.switcher.step(1, ['alt']);
        h.switcher.keyUp({ ctrlKey: false, altKey: true, metaKey: false });
        expect(h.commits).toEqual([]);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual(['b']);
    });

    it('a commit passes a vanished workspace ID through for the reducer to ignore', () => {
        const h = harness(['a', 'gone']);
        h.switcher.step(1, ['ctrl']);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual(['gone']);
    });
});

// A chord pressed in a web page or a frame is passed on to the window, and the release follows it
// there: the shell hands the window the keyboard, and a frame passes its keyups on. Nothing about
// such a gesture is timed, so holding ⌃ to look at the list never switches by itself.
describe('a relayed gesture', () => {
    it('stays open while ⌃ is held, however long, and commits on the release', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl'], { relayed: true });
        vi.advanceTimersByTime(10_000);
        expect(h.commits).toEqual([]);
        expect(h.last()?.shown).toBe(true);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual(['b']);
    });

    // The page's chord goes the long way (shell, daemon, window), so a quick tap's release can
    // reach the window first.
    it('commits at once when the window already saw the release', () => {
        const h = harness();
        h.switcher.keyUp(ctrlDown); // Tab's keyup, ⌃ still down
        h.switcher.keyUp(up); // the ⌃ release
        vi.advanceTimersByTime(RELAYED_RELEASE_GRACE_MS);
        expect(h.switcher.step(1, ['ctrl'], { relayed: true })).toBe(true);
        expect(h.commits).toEqual(['b']);
        expect(h.switcher.state()).toBeNull();
    });

    it('opens normally when the last keyup the window saw still had ⌃ down', () => {
        const h = harness();
        h.switcher.keyUp(ctrlDown);
        h.switcher.step(1, ['ctrl'], { relayed: true });
        expect(h.commits).toEqual([]);
        expect(h.switcher.state()?.index).toBe(1);
    });

    it('ignores a release older than the grace window', () => {
        const h = harness();
        h.switcher.keyUp(up);
        vi.advanceTimersByTime(RELAYED_RELEASE_GRACE_MS + 1);
        h.switcher.step(1, ['ctrl'], { relayed: true });
        expect(h.commits).toEqual([]);
    });

    it('applies only to a relayed chord: one pressed in the window has its release still to come', () => {
        const h = harness();
        h.switcher.keyUp(up);
        h.switcher.step(1, ['ctrl']);
        expect(h.commits).toEqual([]);
    });

    it('uses a release once: the next gesture waits for its own', () => {
        const h = harness();
        h.switcher.keyUp(up);
        h.switcher.step(1, ['ctrl'], { relayed: true });
        expect(h.commits).toEqual(['b']);
        h.switcher.step(1, ['ctrl'], { relayed: true });
        expect(h.commits).toEqual(['b']);
        expect(h.switcher.state()).not.toBeNull();
    });
});

describe('heldModifiersFromEvent', () => {
    it('reads ⌃ ⌥ ⌘ and ignores Shift', () => {
        expect(heldModifiersFromEvent({ ctrlKey: true, altKey: false, metaKey: true })).toEqual(['ctrl', 'meta']);
        expect(heldModifiersFromEvent(up)).toEqual([]);
    });
});


describe('the switcher as an external store', () => {
    it('notifies subscribers on every change and keeps one snapshot between changes', () => {
        const h = harness();
        let calls = 0;
        const off = h.switcher.subscribe(() => {
            calls += 1;
        });
        expect(h.switcher.state()).toBeNull();
        h.switcher.step(1, ['ctrl']);
        const first = h.switcher.state();
        expect(h.switcher.state()).toBe(first);
        expect(calls).toBe(1);
        h.switcher.step(1, ['ctrl']);
        expect(calls).toBe(2);
        off();
        h.switcher.cancel();
        expect(calls).toBe(2);
    });
});

describe('actionsDuringGesture', () => {
    // While a gesture is open the window behaves as if a modal were up: every other bound chord
    // is swallowed rather than acted on, and not passed through either (a ⌃D would reach the
    // terminal as an EOF).
    it('keeps the two recent actions and swallows every other one', () => {
        const step = (): boolean => true;
        const split = (): boolean => true;
        const swallow = (): boolean => true;
        const gated = actionsDuringGesture({ next_recent_workspace: step, split_right: split }, swallow);
        expect(gated.next_recent_workspace).toBe(step);
        expect(gated.split_right).toBe(swallow);
        expect(gated.close_pane).toBe(swallow);
        expect(gated.previous_recent_workspace).toBeUndefined();
    });
});

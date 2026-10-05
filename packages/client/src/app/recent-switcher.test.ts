import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    SWITCHER_SHOW_DELAY_MS,
    WEB_IDLE_COMMIT_MS,
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
        onChange: (state) => states.push(state)
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

    it('showNow paints at once (a gesture started from a web page)', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl'], { showNow: true });
        expect(h.last()?.shown).toBe(true);
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

// A page that holds the keyboard swallows every key event after the chord it gave up, the ⌃
// release included (Chromium suppresses a view's keyups after a consumed keydown). Until the window
// sees a key event of its own, a gesture started there can only end on a timeout.
describe('a gesture started from a web page', () => {
    it('commits after the idle window when the release never reaches the window', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl'], { showNow: true });
        vi.advanceTimersByTime(WEB_IDLE_COMMIT_MS - 1);
        expect(h.commits).toEqual([]);
        h.switcher.step(1, ['ctrl'], { showNow: true });
        vi.advanceTimersByTime(WEB_IDLE_COMMIT_MS - 1);
        expect(h.commits).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(h.commits).toEqual(['c']);
    });

    it('waits for the real release once the window has seen a keyup with ⌃ still down', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl'], { showNow: true });
        h.switcher.keyUp(ctrlDown); // Tab's keyup, delivered to the window: it has the keyboard
        vi.advanceTimersByTime(WEB_IDLE_COMMIT_MS * 5);
        expect(h.commits).toEqual([]);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual(['b']);
    });

    it('does not apply to a gesture the window started itself', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl']);
        vi.advanceTimersByTime(WEB_IDLE_COMMIT_MS * 5);
        expect(h.commits).toEqual([]);
    });
});

describe('heldModifiersFromEvent', () => {
    it('reads ⌃ ⌥ ⌘ and ignores Shift', () => {
        expect(heldModifiersFromEvent({ ctrlKey: true, altKey: false, metaKey: true })).toEqual(['ctrl', 'meta']);
        expect(heldModifiersFromEvent(up)).toEqual([]);
    });
});


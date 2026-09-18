import { afterEach, describe, expect, it, vi } from 'vitest';

import { phoneToLanding } from './workbench.mjs';

/**
 * `phoneToLanding`'s arithmetic, without a window (#205, #235 follow-up).
 *
 * Two things here can only be wrong quietly, which is why they are pinned rather than watched.
 *
 * The COUNT in the note is a count of taps, not of rounds. A round can end without tapping at all,
 * because the button had not painted inside that round's ceiling, and a count that included those
 * would report a phone that was merely slow as a phone whose taps were being swallowed. Those are
 * different faults and one of them is not a fault, so "the button painted at 6 s and the first tap
 * worked" has to write nothing.
 *
 * And the BUDGET is what keeps a cleanup honest. This runs in a `finally` that still has a config
 * to restore, a window to navigate and a daemon to stop after it, so the whole call is capped: the
 * worst case a scenario can pay is the cap, whatever the phone does.
 *
 * The clock is fake and so is the phone. `settleDom` is the only thing in the helper that takes
 * time, so the double below jumps the clock by exactly what the real one would have spent polling:
 * nothing when the predicate is already true, the wait when it can become true inside the ceiling,
 * and the whole ceiling when it cannot. That makes every assertion below about the helper's own
 * arithmetic rather than about a sleep.
 */

/**
 * A phone that paints its Hosts button at `buttonAtMs` and reaches its landing page on tap number
 * `tapThatLands`; `Infinity` for either is "never".
 */
function fakePhone({ shell = true, landing = false, buttonAtMs = 0, tapThatLands = 1 } = {}) {
    const started = Date.now();
    const since = () => Date.now() - started;
    const settles = [];
    let taps = 0;
    let arrived = landing;
    const has = (expression) => {
        if (expression.includes('phone-shell')) return shell;
        if (expression.includes('phone-open-landing')) return !arrived && since() >= buttonAtMs;
        if (expression.includes('phone-landing')) return arrived;
        throw new Error(`the helper looked at something this double does not model: ${expression}`);
    };
    const page = {
        eval: async (expression) => has(expression),
        click: async () => {
            taps += 1;
            if (taps >= tapThatLands) arrived = true;
        }
    };
    const d = {
        settleDom: async (_page, expression, { ceilingMs } = {}) => {
            settles.push({ expression, ceilingMs, at: since() });
            if (has(expression)) return true;
            // The only thing that becomes true on its own is the button; the landing page arrives
            // when a tap lands, so inside one round it either is there or it never will be.
            const wait = expression.includes('phone-open-landing') ? buttonAtMs - since() : Infinity;
            vi.advanceTimersByTime(Math.min(wait, ceilingMs));
            return has(expression);
        }
    };
    return { page, d, settles, elapsed: since, get taps() { return taps; } };
}

const buttonSettles = (phone) => phone.settles.filter((settle) => settle.expression.includes('phone-open-landing'));

describe('phoneToLanding', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('does nothing at all when there is no phone shell, or it is already home', async () => {
        vi.useFakeTimers();
        const note = vi.fn();
        const desktop = fakePhone({ shell: false });
        expect(await phoneToLanding(desktop.page, desktop.d, { note })).toBe(true);
        const home = fakePhone({ landing: true });
        expect(await phoneToLanding(home.page, home.d, { note })).toBe(true);
        expect(desktop.taps + home.taps).toBe(0);
        expect(note).not.toHaveBeenCalled();
    });

    it('waits out a button that paints late and says nothing about the one tap it took', async () => {
        vi.useFakeTimers();
        const note = vi.fn();
        // Past the first round's 5 s ceiling, so the first round ends without tapping at all.
        const phone = fakePhone({ buttonAtMs: 6_000 });
        expect(await phoneToLanding(phone.page, phone.d, { note })).toBe(true);
        expect(phone.taps).toBe(1);
        // The round it lost is not a tap, and a slow phone is not a swallowed tap.
        expect(note).not.toHaveBeenCalled();
        expect(phone.elapsed()).toBe(6_000);
    });

    it('taps again when the first tap is eaten, and reports the count and the cause', async () => {
        vi.useFakeTimers();
        const note = vi.fn();
        const phone = fakePhone({ tapThatLands: 2 });
        expect(await phoneToLanding(phone.page, phone.d, { note })).toBe(true);
        expect(phone.taps).toBe(2);
        expect(note).toHaveBeenCalledOnce();
        const message = String(note.mock.calls[0][0]);
        expect(message).toContain('2 taps');
        expect(message).toContain('scrim');
        // The eaten tap cost one full first round and nothing more.
        expect(phone.elapsed()).toBe(5_000);
    });

    it('gives up on a button that never paints, inside the budget and without tapping', async () => {
        vi.useFakeTimers();
        const note = vi.fn();
        const phone = fakePhone({ buttonAtMs: Infinity });
        expect(await phoneToLanding(phone.page, phone.d, { note })).toBe(false);
        expect(phone.taps).toBe(0);
        expect(note).not.toHaveBeenCalled();
        // Three rounds, shortening, and the whole thing inside the cap rather than three times the
        // first round's ceiling: 9 s is what a cleanup pays for a phone that never offers the way
        // home, against the 15 s three full rounds would have cost.
        expect(buttonSettles(phone).map((settle) => settle.ceilingMs)).toEqual([5_000, 2_000, 2_000]);
        expect(phone.elapsed()).toBe(9_000);
        expect(phone.elapsed()).toBeLessThanOrEqual(12_000);
    });

    it('clamps the last round against the cap rather than overrunning it', async () => {
        vi.useFakeTimers();
        const note = vi.fn();
        // The worst case there is: a button slow enough to eat most of the first round AND a
        // landing page that never arrives, so every round spends both of its waits.
        const phone = fakePhone({ buttonAtMs: 4_000, tapThatLands: Infinity });
        expect(await phoneToLanding(phone.page, phone.d, { note })).toBe(false);
        expect(phone.taps).toBe(3);
        // Nothing is written for a call that never got home: the caller says that itself, and a
        // count of taps that achieved nothing would read as the retry having worked.
        expect(note).not.toHaveBeenCalled();
        // 4 s waiting for the button and 5 s for a landing page that never comes, then 2 + 2, and
        // the last round's wait cut to the 1 s left rather than its own 2 s ceiling.
        expect(phone.elapsed()).toBe(12_000);
    });
});

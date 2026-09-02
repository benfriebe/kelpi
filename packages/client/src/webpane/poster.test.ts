/**
 * The page poster's policy (issue #12): when a pane holds its view back, what it paints, and
 * every way the mechanism is allowed to fail.
 *
 * The controller is exercised on its own — no React, no timers of its own — because everything
 * interesting about it is *ordering*: the frame is taken while the view is still on screen, the
 * hold ends exactly once, and a frame that arrives for a moment nobody is looking at any more is
 * dropped rather than painted. `WebPane.test.tsx` covers the same rules through the component
 * (the report it produces and the `<img>` it renders); this file covers them where they are
 * decided.
 */

import { describe, expect, it } from 'vitest';

import { SILENT_WEB_COMMANDS, webCommandIsSilent } from './commands';
import {
    createPosterController,
    posterAttempt,
    posterDataURL,
    warmPosterImage,
    POSTER_COOLDOWN_MS,
    POSTER_DEADLINE_MS,
    POSTER_LINGER_MS,
    POSTER_MISS_LIMIT,
    type PosterAttempt,
    type WarmableImage
} from './poster';

const TAB = 'EEEEEEEE-0000-4000-8000-000000000001';
const OTHER_TAB = 'EEEEEEEE-0000-4000-8000-000000000002';
const FRAME = 'data:image/jpeg;base64,AAAA';

/** A schedule/cancel pair the test drives by hand, so no test waits for a real millisecond. */
function timers(): {
    schedule: (callback: () => void, ms: number) => unknown;
    cancel: (handle: unknown) => void;
    run: (ms: number) => void;
    readonly pending: number;
} {
    let seq = 0;
    const armed = new Map<number, { callback: () => void; at: number }>();
    return {
        schedule(callback, ms) {
            seq += 1;
            armed.set(seq, { callback, at: ms });
            return seq;
        },
        cancel(handle) {
            armed.delete(handle as number);
        },
        run(ms) {
            for (const [id, entry] of [...armed]) {
                if (entry.at > ms) continue;
                armed.delete(id);
                entry.callback();
            }
        },
        get pending() {
            return armed.size;
        }
    };
}

/** A capture the test settles when it chooses, so "while it is in flight" is a real state. */
function deferredCapture(): {
    capture: (tabID: string) => Promise<PosterAttempt>;
    settle: (src: string | null, transient?: boolean) => void;
    reject: () => void;
    readonly asked: readonly string[];
} {
    const asked: string[] = [];
    let settleOne: ((attempt: PosterAttempt) => void) | null = null;
    let rejectOne: (() => void) | null = null;
    return {
        asked,
        capture(tabID) {
            asked.push(tabID);
            return new Promise<PosterAttempt>((resolve, rejectPromise) => {
                settleOne = resolve;
                rejectOne = () => rejectPromise(new Error('socket closed'));
            });
        },
        settle(src, transient = false) {
            settleOne?.(src === null ? { src: null, transient } : { src });
        },
        reject() {
            rejectOne?.();
        }
    };
}

/** A clock the test moves by hand, so the cooldown is exercised without waiting for one. */
function clockAt(start = 1_000): { now: () => number; advance: (ms: number) => void } {
    let value = start;
    return {
        now: () => value,
        advance(ms) {
            value += ms;
        }
    };
}

const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

describe('posterDataURL', () => {
    it('builds a data URL from the reply the host sends', () => {
        expect(posterDataURL({ ok: true, image_base64: 'AAAA', mime: 'image/jpeg' })).toBe(FRAME);
    });

    it('defaults the mime rather than trusting one that is not an image', () => {
        expect(posterDataURL({ ok: true, image_base64: 'AAAA' })).toBe(FRAME);
        // A reply naming `text/html` would otherwise become an `<img src="data:text/html…">`.
        expect(posterDataURL({ ok: true, image_base64: 'AAAA', mime: 'text/html' })).toBe(FRAME);
    });

    it('is null for every kind of no', () => {
        expect(posterDataURL(null)).toBeNull();
        expect(posterDataURL(undefined)).toBeNull();
        expect(posterDataURL({ ok: false, error: 'no on-screen view to poster' })).toBeNull();
        expect(posterDataURL({ ok: true })).toBeNull();
        expect(posterDataURL({ ok: true, image_base64: '' })).toBeNull();
        expect(posterDataURL({ ok: true, image_base64: 42 })).toBeNull();
    });
});

describe('posterAttempt', () => {
    it('reads a frame, and every no with the one distinction the degrade rule turns on', () => {
        expect(posterAttempt({ ok: true, image_base64: 'AAAA', mime: 'image/jpeg' })).toEqual({ src: FRAME });
        // `transient` = "the view was not on screen when I looked", which is usually the client's
        // own park landing mid-capture: a fact about the moment, not about the host.
        expect(posterAttempt({ ok: false, error: 'no on-screen view to poster', transient: true })).toEqual({
            src: null,
            transient: true
        });
        expect(posterAttempt({ ok: false, error: 'poster too large to send inline' })).toEqual({
            src: null,
            transient: false
        });
        expect(posterAttempt(null)).toEqual({ src: null, transient: false });
    });
});

describe('the poster controller', () => {
    it('holds the view on screen while the frame is taken, then paints it', async () => {
        const clock = timers();
        const shot = deferredCapture();
        let renders = 0;
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => {
                renders += 1;
            },
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        // The frame is asked for in the same call that discovers the cover — the whole point is
        // that it is taken while the view is still on screen.
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: true });
        expect(shot.asked).toEqual([TAB]);
        // Every later render of the same cover rides the same capture.
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: true });
        expect(shot.asked).toEqual([TAB]);
        expect(poster.captures).toBe(1);

        shot.settle(FRAME);
        await flush();

        expect(renders).toBe(1);
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: FRAME, hold: false });
        // The deadline was disarmed by the answer, not left to fire into a settled session.
        expect(clock.pending).toBe(0);
    });

    it('gives up on the deadline so a silent host cannot hide a menu', async () => {
        const clock = timers();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        clock.run(POSTER_DEADLINE_MS);
        // The view goes back with nothing to paint: exactly the behaviour that shipped before
        // the poster existed, which is what makes this a safe addition rather than a new risk.
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: false });

        // A late frame is still worth painting — the menu is very likely still open.
        shot.settle(FRAME);
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: FRAME, hold: false });
    });

    it('stops asking for a cooldown after a real no, then holds again and recovers', async () => {
        const clock = timers();
        const wall = clockAt();
        let answer: PosterAttempt = { src: null };
        let asks = 0;
        const poster = createPosterController({
            capture: () => {
                asks += 1;
                return Promise.resolve(answer);
            },
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel,
            now: wall.now
        });

        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        await flush();
        expect(poster.degraded).toBe(true);
        poster.sync({ covered: false, tabID: TAB });

        /*
         * Inside the cooldown the pane parks at once AND ASKS NOTHING — the second half is the
         * one the audit forced. A capture fired here would arrive after the park it just caused,
         * be refused for exactly that reason, and re-arm the cooldown: the state that stops the
         * pane waiting would be the state that guarantees it can never stop.
         */
        answer = { src: FRAME };
        const asksBefore = asks;
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(false);
        await flush();
        expect(asks).toBe(asksBefore);
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBeNull();
        poster.sync({ covered: false, tabID: TAB });

        // Once it expires the pane HOLDS again, which is the only condition under which a frame
        // can come back at all — and the frame that lands clears the mark.
        wall.advance(POSTER_COOLDOWN_MS + 1);
        expect(poster.degraded).toBe(false);
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBe(FRAME);
        expect(poster.degraded).toBe(false);
    });

    /**
     * The failure the `web-popup-layering` audit caught, as a unit: the client's own park lands
     * while the capture is in flight (a menu that raises a dialog, a workspace switch), the host
     * answers "the view is not on screen", and the pane must NOT read that as a verdict on the
     * host. It did once — and because a marked pane parks instantly, every later capture raced a
     * park it could not win, so the pane never postered again.
     */
    it('does not hold a TRANSIENT no against the host — it is about the moment, not the host', async () => {
        const clock = timers();
        const wall = clockAt();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel,
            now: wall.now
        });

        poster.sync({ covered: true, tabID: TAB });
        // "no on-screen view to poster": our own park got there first.
        shot.settle(null, true);
        await flush();
        expect(poster.degraded).toBe(false);

        poster.sync({ covered: false, tabID: TAB });
        // …so the very next cover still waits for a frame, and gets one.
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        shot.settle(FRAME);
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBe(FRAME);
    });

    it('treats a rejected call as a refusal, not as a reason to hold forever', async () => {
        const clock = timers();
        const shot = deferredCapture();
        let renders = 0;
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => {
                renders += 1;
            },
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        shot.reject();
        await flush();
        expect(renders).toBe(1);
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: false });
        expect(clock.pending).toBe(0);
    });

    it('keeps the frame painted across the swap back, then lets it go', async () => {
        const clock = timers();
        const poster = createPosterController({
            capture: () => Promise.resolve({ src: FRAME }),
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        poster.sync({ covered: true, tabID: TAB });
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBe(FRAME);

        // Uncovered: the view is on its way back, and the frame stays under it so the handover
        // has no blank in it. This is the same no-flash rule as the hold, at the other end.
        expect(poster.sync({ covered: false, tabID: TAB })).toEqual({ src: FRAME, hold: false });
        clock.run(POSTER_LINGER_MS);
        expect(poster.sync({ covered: false, tabID: TAB })).toEqual({ src: null, hold: false });
    });

    it('drops a frame that was taken for a cover the pane has already left', async () => {
        const clock = timers();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        poster.sync({ covered: true, tabID: TAB });
        // The pointer swept off the surface before the frame came back.
        poster.sync({ covered: false, tabID: TAB });
        shot.settle(FRAME);
        await flush();

        // Nothing lingers, because nothing was ever painted: a frame that lands after the view
        // is back would be a picture of the page appearing OVER the live page.
        expect(poster.sync({ covered: false, tabID: TAB })).toEqual({ src: null, hold: false });
        expect(clock.pending).toBe(0);
    });

    it('re-photographs when the pane switches tab under the surface', async () => {
        const clock = timers();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        poster.sync({ covered: true, tabID: TAB });
        shot.settle(FRAME);
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBe(FRAME);

        // A tab switch while the menu is up: the old frame is of a page that is no longer in the
        // pane, so it goes immediately rather than lingering over the new one.
        expect(poster.sync({ covered: true, tabID: OTHER_TAB })).toEqual({ src: null, hold: true });
        expect(shot.asked).toEqual([TAB, OTHER_TAB]);
    });

    it('never photographs a pane with no live tab', () => {
        const clock = timers();
        let asked = 0;
        const poster = createPosterController({
            capture: () => {
                asked += 1;
                return Promise.resolve({ src: FRAME });
            },
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        expect(poster.sync({ covered: true, tabID: null })).toEqual({ src: null, hold: false });
        expect(asked).toBe(0);
    });

    it('answers nothing once disposed, and leaves no timer behind', async () => {
        const clock = timers();
        const shot = deferredCapture();
        let renders = 0;
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => {
                renders += 1;
            },
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        poster.sync({ covered: true, tabID: TAB });
        poster.dispose();
        expect(clock.pending).toBe(0);
        shot.settle(FRAME);
        await flush();
        // A pane that has unmounted must not ask React for a render, and has nothing to paint.
        expect(renders).toBe(0);
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: false });
    });
});

/**
 * A run of missed deadlines is the one failure the deadline alone does not answer: each miss is
 * forgiven on its own (the frame may still be coming), so a host that is consistently slower than
 * the deadline would cost 250ms of invisible menu on every right-click, for ever.
 */
describe('a host that keeps missing the deadline', () => {
    it('cools off after a run of misses, and is forgiven by one landed frame', async () => {
        const clock = timers();
        const wall = clockAt();
        let hang = true;
        const poster = createPosterController({
            capture: (): Promise<PosterAttempt> =>
                hang ? new Promise<PosterAttempt>(() => undefined) : Promise.resolve({ src: FRAME }),
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel,
            now: wall.now
        });

        for (let miss = 1; miss <= POSTER_MISS_LIMIT; miss++) {
            expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
            clock.run(POSTER_DEADLINE_MS);
            // Every miss releases the view; the run is what changes what happens NEXT time.
            expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(false);
            expect(poster.degraded).toBe(miss >= POSTER_MISS_LIMIT);
            poster.sync({ covered: false, tabID: TAB });
        }

        // Cooling: the menu is instant, and nothing is asked for at all.
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(false);
        poster.sync({ covered: false, tabID: TAB });

        hang = false;
        wall.advance(POSTER_COOLDOWN_MS + 1);
        poster.sync({ covered: true, tabID: TAB });
        await flush();
        expect(poster.degraded).toBe(false);
        poster.sync({ covered: false, tabID: TAB });
        clock.run(POSTER_LINGER_MS);
        // One frame that landed is enough to say the host works; the pane waits again.
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
    });

    it('does not cool off on a single miss — a page can be busy once', () => {
        const clock = timers();
        const poster = createPosterController({
            capture: (): Promise<PosterAttempt> => new Promise<PosterAttempt>(() => undefined),
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        poster.sync({ covered: true, tabID: TAB });
        clock.run(POSTER_DEADLINE_MS);
        expect(poster.degraded).toBe(false);
    });
});

/**
 * The contract the module header promises the user — "every failure degrades to the behaviour
 * that shipped before" — is worth nothing unless the assembly agrees to it, because `App.tsx`
 * wraps every web verb in a toast on `ok:false`. The verb is on the silent list for that reason;
 * `App.window-chrome.test.tsx` pins the assembly end of the same rule.
 */
describe('the verb is exempt from the assembly’s error toasts', () => {
    it('names `web-poster` and nothing else', () => {
        expect([...SILENT_WEB_COMMANDS]).toEqual(['web-poster']);
        expect(webCommandIsSilent({ command: 'web-poster', pane_id: 'p', tab_id: 't' })).toBe(true);
    });

    it('leaves every gesture verb loud — a refused gesture is news', () => {
        expect(webCommandIsSilent({ command: 'web-navigate', pane_id: 'p', url: 'u' })).toBe(false);
        expect(webCommandIsSilent({ command: 'web-capture', pane_id: 'p', mode: 'screenshot' })).toBe(false);
        expect(webCommandIsSilent({})).toBe(false);
    });
});

/**
 * The decode step, which is the difference between "the bytes arrived" and "the picture can be
 * painted". Parking on the former hands the view back before its replacement is ready, which is
 * the black frame the whole mechanism exists to avoid.
 */
describe('warmPosterImage', () => {
    it('waits for the frame to decode before calling it landed', async () => {
        const order: string[] = [];
        let release: (() => void) | null = null;
        const image: WarmableImage = {
            src: '',
            decode: () =>
                new Promise<void>((resolve) => {
                    release = () => {
                        order.push('decoded');
                        resolve();
                    };
                })
        };
        const warmed = warmPosterImage(FRAME, () => image).then(() => order.push('landed'));
        await Promise.resolve();
        expect(order).toEqual([]);
        expect(image.src).toBe(FRAME);
        (release as unknown as () => void)();
        await warmed;
        expect(order).toEqual(['decoded', 'landed']);
    });

    it('yields the frame anyway when the decode fails or does not exist', async () => {
        await expect(
            warmPosterImage(FRAME, () => ({ src: '', decode: () => Promise.reject(new Error('no codec')) }))
        ).resolves.toBe(FRAME);
        // jsdom has no image pipeline at all; a frame is still a frame.
        await expect(warmPosterImage(FRAME, () => ({ src: '' }))).resolves.toBe(FRAME);
        await expect(
            warmPosterImage(FRAME, () => {
                throw new Error('no Image in this realm');
            })
        ).resolves.toBe(FRAME);
    });
});

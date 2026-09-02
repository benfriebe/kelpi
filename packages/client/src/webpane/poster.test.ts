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

import {
    createPosterController,
    posterDataURL,
    warmPosterImage,
    POSTER_DEADLINE_MS,
    POSTER_LINGER_MS,
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
    capture: (tabID: string) => Promise<string | null>;
    settle: (src: string | null) => void;
    reject: () => void;
    readonly asked: readonly string[];
} {
    const asked: string[] = [];
    let settleOne: ((src: string | null) => void) | null = null;
    let rejectOne: (() => void) | null = null;
    return {
        asked,
        capture(tabID) {
            asked.push(tabID);
            return new Promise<string | null>((resolve, rejectPromise) => {
                settleOne = resolve;
                rejectOne = () => rejectPromise(new Error('socket closed'));
            });
        },
        settle(src) {
            settleOne?.(src);
        },
        reject() {
            rejectOne?.();
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

    it('stops making the user wait after a refusal, and starts again after a success', async () => {
        const clock = timers();
        let answer: string | null = null;
        const poster = createPosterController({
            capture: () => Promise.resolve(answer),
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        await flush();
        poster.sync({ covered: false, tabID: TAB });

        // A host that said no once is not asked to be waited for again: the pane parks at once
        // and only *tries* for a frame, so a browser client (or a view in the holder) pays one
        // deferred park in its life rather than one per menu.
        answer = FRAME;
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(false);
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBe(FRAME);

        // …and the yes clears the mark, so the next cover is held again.
        poster.sync({ covered: false, tabID: TAB });
        clock.run(POSTER_LINGER_MS);
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
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
            capture: () => Promise.resolve(FRAME),
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
                return Promise.resolve(FRAME);
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

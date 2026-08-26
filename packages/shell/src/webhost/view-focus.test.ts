/**
 * §N29's gesture signal: which inputs on a web pane's page mean "the user took this pane"?
 *
 * The suite this replaces pinned a DISCRIMINATOR over `webContents`'s `focus` event — a claim
 * window, a navigation hold-and-cancel, two timers. Every one of those tests passed against a
 * fix that moved nothing under the owner's finger, because they asserted that the right events
 * were *filtered out* while the event that mattered never arrived at all
 * (`docs/audit/n29-input-gesture/n29-confirm-hypothesis.mjs`: a click on the pane's own CDP
 * target fires **0** focus events whether or not the view already holds focus). Tests cannot
 * catch a missing signal by checking a filter, so the filter is gone and so are its tests.
 *
 * What is pinned now is the gesture itself, and the two properties that keep it honest: only a
 * press counts (matching `NSClickGestureRecognizer`, which is click-only — typing moves no ring
 * in the shipped app), and a parked view cannot be clicked.
 */

import { describe, expect, it } from 'vitest';

import { createViewFocusGate, isGestureInput, type ViewFocusGate } from './view-focus.js';

function harness(): { readonly gate: ViewFocusGate; readonly reports: number[] } {
    const reports: number[] = [];
    const gate = createViewFocusGate({ report: () => reports.push(reports.length) });
    return { gate, reports };
}

/** Every `InputEvent.type` Electron 43 documents, so a widened set has to be deliberate. */
const ALL_INPUT_TYPES = [
    'mouseDown',
    'mouseUp',
    'mouseMove',
    'mouseEnter',
    'mouseLeave',
    'contextMenu',
    'mouseWheel',
    'rawKeyDown',
    'keyDown',
    'keyUp',
    'char',
    'gestureScrollBegin',
    'gestureScrollEnd',
    'gestureScrollUpdate',
    'gestureTap',
    'gestureTapDown',
    'gestureLongPress',
    'touchStart',
    'touchMove',
    'touchEnd',
    'touchCancel',
    'pointerDown',
    'pointerUp',
    'pointerMove'
] as const;

describe('the page-click gesture', () => {
    it('reports a mouseDown on an embedded view — this is the whole signal', () => {
        const h = harness();
        h.gate.inputEvent({ type: 'mouseDown', embedded: true });
        expect(h.reports).toHaveLength(1);
    });

    it('reports on the PRESS, not the release, so the ring moves under the finger', () => {
        const h = harness();
        h.gate.inputEvent({ type: 'mouseDown', embedded: true });
        h.gate.inputEvent({ type: 'mouseUp', embedded: true });
        // Swift says the same thing with `delaysPrimaryMouseButtonEvents = false`.
        expect(h.reports).toHaveLength(1);
    });

    it('matches Swift exactly: mouseDown is the ONLY input that counts', () => {
        const accepted = ALL_INPUT_TYPES.filter((type) => isGestureInput(type));
        // `NSClickGestureRecognizer` recognises a primary-button click and nothing else. If this
        // set ever grows, it is a port-only behaviour and needs its own parity argument.
        expect(accepted).toEqual(['mouseDown']);
    });

    it('does NOT treat typing as presence (the deliberate Swift-parity choice)', () => {
        const h = harness();
        for (const type of ['rawKeyDown', 'keyDown', 'keyUp', 'char']) {
            h.gate.inputEvent({ type, embedded: true });
        }
        // A keystroke moving the ring would also fire on an agent's `nex web` typing.
        expect(h.reports).toEqual([]);
    });

    it('ignores hover, scroll and wheel — a pointer crossing a page is not a claim on it', () => {
        const h = harness();
        for (const type of ['mouseMove', 'mouseEnter', 'mouseLeave', 'mouseWheel', 'gestureScrollUpdate']) {
            h.gate.inputEvent({ type, embedded: true });
        }
        expect(h.reports).toEqual([]);
    });

    it('ignores an input on a PARKED view: nothing on screen could have been pressed', () => {
        const h = harness();
        // N26 parks a view into the off-screen holder for any floating surface. It stays alive
        // there, so it can still receive input — but not from a user, who cannot see it.
        h.gate.inputEvent({ type: 'mouseDown', embedded: false });
        expect(h.reports).toEqual([]);
    });

    it('reports again once the view is placed back, so parking latches nothing', () => {
        const h = harness();
        h.gate.inputEvent({ type: 'mouseDown', embedded: false });
        h.gate.inputEvent({ type: 'mouseDown', embedded: true });
        expect(h.reports).toHaveLength(1);
    });

    it('reports EVERY press: no coalescing window can swallow a real gesture', () => {
        const h = harness();
        for (let index = 0; index < 5; index += 1) {
            h.gate.inputEvent({ type: 'mouseDown', embedded: true });
        }
        // The previous design's one measured residual was a time window that swallowed real
        // clicks. Repeat reports are idempotent at the client; a swallowed one is not.
        expect(h.reports).toHaveLength(5);
    });

    it('tolerates an input event with no type at all', () => {
        const h = harness();
        expect(() => h.gate.inputEvent({ type: undefined, embedded: true })).not.toThrow();
        expect(h.reports).toEqual([]);
        expect(isGestureInput(undefined)).toBe(false);
        expect(isGestureInput(null)).toBe(false);
    });

    it('reports nothing once disposed — a dead tab must not move the ring', () => {
        const h = harness();
        h.gate.dispose();
        h.gate.inputEvent({ type: 'mouseDown', embedded: true });
        expect(h.reports).toEqual([]);
    });

    it('is idempotent on dispose', () => {
        const h = harness();
        h.gate.dispose();
        expect(() => h.gate.dispose()).not.toThrow();
        expect(h.reports).toEqual([]);
    });

    describe('the machinery the old design needed, and why none of it survives', () => {
        it('exposes no claim window and no navigation hold — both are deleted, not disabled', () => {
            const h = harness();
            const gate = h.gate as unknown as Record<string, unknown>;
            // Pinned as an API fact so the filters cannot creep back in behind the gesture. A
            // programmatic `focus()` presses no button and a committing navigation presses no
            // button, so neither can raise a `mouseDown` — there is nothing left to subtract.
            expect(gate['claim']).toBeUndefined();
            expect(gate['navigationCommitted']).toBeUndefined();
            expect(gate['focusEvent']).toBeUndefined();
            expect(Object.keys(gate).sort()).toEqual(['dispose', 'inputEvent']);
        });

        it('needs no clock, so no window exists that could swallow a click by timing out', () => {
            // The old gate took `now`/`schedule`/`windowMs`/`graceMs`. Its one measured residual
            // was a real click landing inside the 250 ms claim window and being dropped. A gate
            // with no timer cannot have that class of defect at all.
            const gate = createViewFocusGate({ report: () => undefined });
            gate.inputEvent({ type: 'mouseDown', embedded: true });
            expect(createViewFocusGate.length).toBe(1);
            expect(gate).toBeDefined();
        });
    });
});

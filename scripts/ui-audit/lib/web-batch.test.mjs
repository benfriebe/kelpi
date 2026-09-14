import { describe, expect, it } from 'vitest';

import {
    NO_COMMENT_TEXTAREA,
    describePickGuards,
    focusPageCommentSource,
    installPickWitnessSource,
    pickProbeSource
} from './web-batch.mjs';

/**
 * The two halves of #206, both of which are only ever exercised on a day the audit is already
 * going wrong: a click that made no pick, and the step that then has no popover to read.
 *
 * That is exactly why they are tested here rather than trusted to the next full run. A diagnostic
 * is dead code until the one run that needs it, and a null guard that has never been executed is
 * not a guard, it is a claim. Both are pure text or pure source, so both can be run for real: the
 * page sources are evaluated with `new Function`, which shadows `window` and `document` with stubs,
 * so the tests drive the same strings the audit pastes into `Runtime.evaluate`.
 */

/** Evaluate a page source the way the harness does, with stubbed page globals. */
const run = (source, { window: win = {}, document: doc = {} } = {}) =>
    new Function('window', 'document', `return ${source}`)(win, doc);

const element = (tag, { id = '', attributes = [], parent = null } = {}) => ({
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    parentElement: parent,
    hasAttribute: (name) => attributes.includes(name)
});

describe('focusPageCommentSource', () => {
    it('reports the missing textarea instead of throwing on null (#206)', () => {
        // The unguarded form of this expression is what ended the step with
        // "TypeError: Cannot read properties of null (reading 'focus')" and cost it 13 assertions.
        const doc = { querySelector: () => null, activeElement: null };
        expect(() => run(focusPageCommentSource('typed in the page'), { document: doc })).not.toThrow();
        expect(run(focusPageCommentSource('typed in the page'), { document: doc })).toBe(NO_COMMENT_TEXTAREA);
    });

    it('still focuses the textarea and types into it when it is there', () => {
        const textarea = { value: '', focus: () => { doc.activeElement = textarea; } };
        const doc = { querySelector: () => textarea, activeElement: null };
        expect(run(focusPageCommentSource('typed in the page'), { document: doc })).toBe(true);
        expect(textarea.value).toBe('typed in the page');
        expect(doc.activeElement).toBe(textarea);
    });
});

describe('installPickWitnessSource', () => {
    /** A page with a capture-phase click listener the test can fire by hand. */
    const pageWithWitness = (win) => {
        const listeners = [];
        const window_ = { ...win, addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture }) };
        const doc = { hasFocus: () => true, visibilityState: 'visible' };
        run(installPickWitnessSource(), { window: window_, document: doc });
        return { window: window_, listeners, click: (event) => listeners[0].handler(event) };
    };

    it('listens at capture phase, which is what lets it see clicks the picker declines', () => {
        const { listeners } = pageWithWitness({});
        expect(listeners).toHaveLength(1);
        expect(listeners[0].type).toBe('click');
        expect(listeners[0].capture).toBe(true);
    });

    it('records the guard state as the click arrives, not afterwards', () => {
        const page = pageWithWitness({ __kelpiInspectorArmed: () => true, __kelpiBatchHasOpenPopover: true });
        page.click({ target: element('div', { id: 'hello' }), isTrusted: true, clientX: 12.4, clientY: 30.6 });
        // The flag flips back after the click; the witness must still hold what was true at it.
        page.window.__kelpiBatchHasOpenPopover = false;
        expect(page.window.__kelpiAuditPickWitness.clicks).toBe(1);
        expect(page.window.__kelpiAuditPickWitness.last).toMatchObject({
            target: 'div#hello',
            overlay: false,
            armed: true,
            popoverOpen: true,
            x: 12,
            y: 31
        });
    });

    it('sees a click on one of the picker own overlays as an overlay, through its ancestors', () => {
        const page = pageWithWitness({ __kelpiInspectorArmed: () => true });
        const badge = element('span', { parent: element('div', { attributes: ['data-kelpi-batch-marker'] }) });
        page.click({ target: badge, isTrusted: true, clientX: 1, clientY: 1 });
        expect(page.window.__kelpiAuditPickWitness.last.overlay).toBe(true);
    });

    it('re-arming resets the count without stacking a second listener', () => {
        const page = pageWithWitness({});
        page.click({ target: element('div'), isTrusted: true, clientX: 0, clientY: 0 });
        run(installPickWitnessSource(), { window: page.window, document: { hasFocus: () => true, visibilityState: 'visible' } });
        expect(page.listeners).toHaveLength(1);
        expect(page.window.__kelpiAuditPickWitness.clicks).toBe(0);
        page.click({ target: element('div'), isTrusted: true, clientX: 0, clientY: 0 });
        expect(page.window.__kelpiAuditPickWitness.clicks).toBe(1);
    });
});

describe('pickProbeSource', () => {
    const probeDocument = (under) => ({
        elementFromPoint: () => under,
        querySelector: () => null,
        querySelectorAll: () => [],
        hasFocus: () => false,
        visibilityState: 'hidden'
    });

    it('names what is under the click point, and whether that is an overlay', () => {
        const popover = element('div', { attributes: ['data-kelpi-batch-popover'] });
        const probe = run(pickProbeSource(40, 50), {
            window: { __kelpiAuditPickWitness: { clicks: 0, first: null, last: null } },
            document: probeDocument(popover)
        });
        expect(probe.underPointer).toEqual({ node: 'div [data-kelpi-batch-popover]', overlay: true });
        expect(probe.point).toEqual({ x: 40, y: 50 });
        expect(probe.visibility).toBe('hidden');
        expect(probe.focus).toBe(false);
    });

    it('takes no reading at all rather than a made-up one when there is no click point', () => {
        const probe = run(pickProbeSource(undefined, undefined), {
            window: {},
            document: probeDocument(element('div'))
        });
        expect(probe.underPointer).toBe(null);
        expect(probe.witness).toBe(null);
    });
});

describe('describePickGuards', () => {
    const probe = (over) => ({
        witness: { clicks: 1, first: null, last: { target: 'div#hello', overlay: false, armed: true, popoverOpen: false } },
        armed: true,
        popoverOpen: false,
        popover: false,
        markers: 0,
        underPointer: { node: 'div#hello', overlay: false },
        focus: true,
        visibility: 'visible',
        ...over
    });

    it('blames occlusion when no click reached the page at all', () => {
        const line = describePickGuards(
            probe({ witness: { clicks: 0, first: null, last: null }, focus: false, visibility: 'hidden' })
        );
        expect(line).toContain('no click reached the page at all');
        expect(line).toContain('placement.mjs');
        expect(line).toContain('visibility hidden');
    });

    it('blames the armed guard when the picker was not armed at the click', () => {
        const line = describePickGuards(probe({ witness: { clicks: 1, first: null, last: { target: 'div#hello', overlay: false, armed: false, popoverOpen: false } } }));
        expect(line).toContain('not armed');
    });

    it('blames the open popover, which suspends the picker', () => {
        const line = describePickGuards(probe({ witness: { clicks: 1, first: null, last: { target: 'div#hello', overlay: false, armed: true, popoverOpen: true } } }));
        expect(line).toContain('popover was already open');
    });

    it('blames the overlay test, and names the surface that swallowed the click', () => {
        const line = describePickGuards(
            probe({ witness: { clicks: 1, first: null, last: { target: 'span [data-kelpi-batch-marker]', overlay: true, armed: true, popoverOpen: false } } })
        );
        expect(line).toContain('overlay surfaces');
        expect(line).toContain('data-kelpi-batch-marker');
    });

    it('points at the host when every guard passed, which is the only verdict that is a product bug', () => {
        expect(describePickGuards(probe())).toContain('the payload was posted and the host dropped it');
    });

    it('carries all four readings whichever guard declined', () => {
        const line = describePickGuards(probe());
        for (const facet of ['clicks seen', 'page focus', 'visibility', 'under the pointer']) {
            expect(line).toContain(facet);
        }
    });

    it('says so plainly when there is no probe, or the probe itself failed', () => {
        expect(describePickGuards(null)).toContain('could not be probed');
        expect(describePickGuards({ probeError: 'page eval failed: detached' })).toContain('detached');
    });

    it('says the witness was missing rather than guessing', () => {
        expect(describePickGuards(probe({ witness: null }))).toContain('no click witness was installed');
    });
});

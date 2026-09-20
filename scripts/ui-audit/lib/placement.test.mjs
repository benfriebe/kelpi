import { describe, expect, it } from 'vitest';

import { PLACEMENT_ORDER, resolveAuditPlacement, resolveScenarioPlacement } from './placement.mjs';

/**
 * The placement floor a scenario may declare, decided without a window (#206).
 *
 * The rule this pins down is the one that is easy to get backwards: a declaration is a FLOOR. It
 * raises a lane that is too weak for the scenario and it never lowers one that is stronger, and it
 * does nothing at all to a run that opened no lane, because "no `--window`" has to keep meaning
 * "this run is exactly what it was before the lane existed".
 */
describe('resolveScenarioPlacement', () => {
    it.each(PLACEMENT_ORDER)('gives native-focus input its own focusable window from %s', placement => {
        expect(resolveScenarioPlacement(placement, undefined, { requiresNativeFocus: true }))
            .toEqual({ placement: undefined, raised: true, warning: null });
    });

    it('leaves an existing default window alone and prioritizes focus over a visibility floor', () => {
        expect(resolveScenarioPlacement('default', undefined, { requiresNativeFocus: true }))
            .toEqual({ placement: 'default', raised: false, warning: null });
        expect(resolveScenarioPlacement('onscreen', 'offscreen', { requiresNativeFocus: true }))
            .toEqual({ placement: undefined, raised: true, warning: null });
    });

    it('leaves a scenario that declares nothing on the run\'s own placement', () => {
        expect(resolveScenarioPlacement('hidden', undefined)).toEqual({ placement: 'hidden', raised: false, warning: null });
        expect(resolveScenarioPlacement(undefined, undefined)).toEqual({ placement: undefined, raised: false, warning: null });
    });

    it('raises a lane that is weaker than the declared floor, and says it needs its own instance', () => {
        expect(resolveScenarioPlacement('hidden', 'offscreen')).toEqual({ placement: 'offscreen', raised: true, warning: null });
        expect(resolveScenarioPlacement('hidden', 'onscreen')).toEqual({ placement: 'onscreen', raised: true, warning: null });
        expect(resolveScenarioPlacement('offscreen', 'onscreen')).toEqual({ placement: 'onscreen', raised: true, warning: null });
    });

    it('never lowers a run that is already stronger', () => {
        expect(resolveScenarioPlacement('onscreen', 'offscreen')).toEqual({ placement: 'onscreen', raised: false, warning: null });
        expect(resolveScenarioPlacement('offscreen', 'offscreen')).toEqual({ placement: 'offscreen', raised: false, warning: null });
    });

    it('leaves the shipped window alone and says why', () => {
        const resolved = resolveScenarioPlacement(undefined, 'offscreen');
        expect(resolved.placement).toBe(undefined);
        expect(resolved.raised).toBe(false);
        expect(resolved.warning).toContain('no lane');
    });

    it('ignores a declaration that is not a placement, with a sentence rather than a throw', () => {
        const resolved = resolveScenarioPlacement('hidden', 'visible');
        expect(resolved.placement).toBe('hidden');
        expect(resolved.raised).toBe(false);
        expect(resolved.warning).toContain(PLACEMENT_ORDER.join(' | '));
    });
});

describe('resolveAuditPlacement', () => {
    it('moves a native-page flow out of both coverable audit placements', () => {
        expect(resolveAuditPlacement('default', 'offscreen')).toEqual({ placement: 'offscreen', raised: true, warning: null });
        expect(resolveAuditPlacement('hidden', 'offscreen')).toEqual({ placement: 'offscreen', raised: true, warning: null });
    });

    it('keeps an already non-occludable audit placement', () => {
        expect(resolveAuditPlacement('offscreen', 'offscreen')).toEqual({ placement: 'offscreen', raised: false, warning: null });
        expect(resolveAuditPlacement('onscreen', 'offscreen')).toEqual({ placement: 'onscreen', raised: false, warning: null });
    });
});

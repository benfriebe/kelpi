import { describe, expect, it } from 'vitest';

import { PANE_HEADER_HEIGHT } from '../grid/PaneHeader';

import {
    PANE_CHROME_ACTION_IDS,
    PANE_CHROME_LIMITS,
    PANE_CHROME_PLACEMENT,
    isPaneChromeActionID,
    paneChromeHeight,
    paneChromeParks,
    paneChromeRow,
    type PaneChromeControlDescriptor,
    type PaneChromeDescriptor
} from './contract';

function descriptor(
    controls: readonly PaneChromeControlDescriptor[],
    folded: number
): PaneChromeDescriptor {
    return {
        paneID: 'p',
        kind: 'shell',
        status: 'idle',
        focused: false,
        title: '~',
        titleParts: { head: '~', tail: '' },
        directory: '~',
        label: null,
        branch: null,
        changes: null,
        agent: null,
        zoom: { zoomed: false, available: false },
        sync: { active: false, excluded: false },
        height: PANE_CHROME_LIMITS.nativeHeight,
        size: { width: 400, badges: { label: false, agent: false, branch: false }, buttons: 4, folded },
        controls,
        items: [],
        contributions: null,
        renaming: false
    };
}

function button(key: string, pinned = false): PaneChromeControlDescriptor {
    return { key, kind: 'action', label: key, icon: 'close', testID: `t-${key}`, enabled: true, pinned };
}

describe('the pane chrome vocabulary', () => {
    it('names one placement for every pane kind', () => {
        expect(PANE_CHROME_PLACEMENT).toBe('pane.chrome');
    });

    it('keeps the action ids the header already draws, so no `data-menu-item` moves', () => {
        expect([...PANE_CHROME_ACTION_IDS]).toEqual([
            'copy',
            'edit',
            'refresh',
            'split-right',
            'split-down',
            'new-web',
            'close'
        ]);
        expect(isPaneChromeActionID('split-down')).toBe(true);
        expect(isPaneChromeActionID('rename')).toBe(false);
        expect(isPaneChromeActionID('__proto__')).toBe(false);
    });

    /**
     * The number is stated twice - where the band is painted and where it is clamped - and this is
     * what stops the two drifting. A clamp that defaulted to a different native height than the
     * header draws would resize every pane in the window the first time anything declared.
     */
    it('clamps against the same native band the header paints', () => {
        expect(PANE_CHROME_LIMITS.nativeHeight).toBe(PANE_HEADER_HEIGHT);
        expect(PANE_CHROME_LIMITS.nativeHeight).toBe(24);
    });
});

describe('paneChromeHeight (ratified decision 4)', () => {
    it('leaves an undeclared pane on the host band, whatever its height', () => {
        expect(paneChromeHeight(null, 800)).toBe(24);
        // The clamp is NOT applied to the default: a 60 px pane's ceiling is 15, and shrinking the
        // bundled header on a pane nobody declared anything for would resize its PTY for nothing.
        expect(paneChromeHeight(null, 60)).toBe(24);
        expect(paneChromeHeight(null, 0)).toBe(24);
        // A host that draws its own band keeps drawing it.
        expect(paneChromeHeight(null, 800, 32)).toBe(32);
    });

    it('honours a declaration under both ceilings', () => {
        // 800 px pane: the fraction allows 200, so 96 is the binding ceiling and 48 fits under it.
        expect(paneChromeHeight(48, 800)).toBe(48);
        expect(paneChromeHeight(96, 800)).toBe(96);
    });

    it('cuts a declaration to the smaller of 96 px and a quarter of the pane', () => {
        expect(paneChromeHeight(400, 800)).toBe(96);
        // 240 px pane: a quarter is 60, which is the smaller ceiling.
        expect(paneChromeHeight(96, 240)).toBe(60);
        // A pane shorter than four native bands: the ceiling drops below 24 and a declaration
        // goes with it. 80 / 4 = 20.
        expect(paneChromeHeight(40, 80)).toBe(20);
        expect(paneChromeHeight(1000, 80)).toBe(20);
    });

    it('treats every hostile number as the declaration it is not', () => {
        expect(paneChromeHeight(0, 800)).toBe(0);
        expect(paneChromeHeight(-40, 800)).toBe(0);
        expect(paneChromeHeight(Number.NaN, 800)).toBe(24);
        expect(paneChromeHeight(Number.POSITIVE_INFINITY, 800)).toBe(24);
        expect(paneChromeHeight(Number.NEGATIVE_INFINITY, 800)).toBe(24);
        expect(paneChromeHeight(Number.MAX_SAFE_INTEGER, 800)).toBe(96);
        // A pane with no measurable height has no ceiling to compute, so the native band stands.
        expect(paneChromeHeight(96, Number.NaN)).toBe(24);
        expect(paneChromeHeight(96, Number.POSITIVE_INFINITY)).toBe(24);
        expect(paneChromeHeight(96, 0)).toBe(24);
        expect(paneChromeHeight(96, -800)).toBe(24);
    });

    it('rounds rather than truncating, so a fractional declaration lands on a pixel', () => {
        expect(paneChromeHeight(47.4, 800)).toBe(47);
        expect(paneChromeHeight(47.6, 800)).toBe(48);
    });
});

describe('paneChromeRow', () => {
    it('folds from the pinned control inward and never reaches it', () => {
        const row = descriptor([button('a'), button('b'), button('c'), button('close', true)], 2);
        expect(paneChromeRow(row).inline.map((entry) => entry.key)).toEqual(['a']);
        expect(paneChromeRow(row).overflow.map((entry) => entry.key)).toEqual(['b', 'c']);
        expect(paneChromeRow(row).pinned.map((entry) => entry.key)).toEqual(['close']);
    });

    it('folds nothing at zero and clamps a fold larger than the row', () => {
        const none = descriptor([button('a'), button('close', true)], 0);
        expect(paneChromeRow(none).overflow).toEqual([]);
        const all = descriptor([button('a'), button('b'), button('close', true)], 99);
        expect(paneChromeRow(all).inline).toEqual([]);
        expect(paneChromeRow(all).overflow.map((entry) => entry.key)).toEqual(['a', 'b']);
        expect(paneChromeRow(all).pinned.map((entry) => entry.key)).toEqual(['close']);
    });
});

describe('paneChromeParks (ratified decision 5)', () => {
    it('parks only a web pane, and only under a band taller than the native one', () => {
        expect(paneChromeParks('web', 24)).toBe(false);
        expect(paneChromeParks('web', 25)).toBe(true);
        expect(paneChromeParks('web', 96)).toBe(true);
        expect(paneChromeParks('shell', 96)).toBe(false);
        expect(paneChromeParks('markdown', 96)).toBe(false);
        expect(paneChromeParks('web', Number.NaN)).toBe(false);
    });
});

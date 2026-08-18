import { describe, expect, it } from 'vitest';

import {
    currentPaneShare,
    enclosingSplitPath,
    ratioAtPath,
    ratioForShare,
    resizePaneShare,
    shareForRatio,
    updatingSplitRatio
} from './ratio.js';
import { EMPTY_LAYOUT, leaf, split } from './types.js';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';
const B = 'BBBBBBBB-0000-0000-0000-000000000002';
const C = 'CCCCCCCC-0000-0000-0000-000000000003';
const MISSING = 'FFFFFFFF-0000-0000-0000-00000000000F';

describe('updatingSplitRatio', () => {
    it('12. updateRatioAtRoot', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(updatingSplitRatio(layout, 'd', 0.7)).toEqual(
            split('horizontal', 0.7, leaf(A), leaf(B))
        );
    });

    it('13. updateRatioNestedLeft touches only the inner split', () => {
        const layout = split('horizontal', 0.5, split('vertical', 0.5, leaf(A), leaf(B)), leaf(C));
        expect(updatingSplitRatio(layout, 'dL', 0.3)).toEqual(
            split('horizontal', 0.5, split('vertical', 0.3, leaf(A), leaf(B)), leaf(C))
        );
    });

    it('14. updateRatioNestedRight touches only the inner split', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        expect(updatingSplitRatio(layout, 'dR', 0.8)).toEqual(
            split('horizontal', 0.5, leaf(A), split('vertical', 0.8, leaf(B), leaf(C)))
        );
    });

    it('15. updateRatioClampsToRange', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(ratioAtPath(updatingSplitRatio(layout, 'd', 0.01), 'd')).toBe(0.1);
        expect(ratioAtPath(updatingSplitRatio(layout, 'd', 0.99), 'd')).toBe(0.9);
        expect(ratioAtPath(updatingSplitRatio(layout, 'd', -5), 'd')).toBe(0.1);
        expect(ratioAtPath(updatingSplitRatio(layout, 'd', 42), 'd')).toBe(0.9);
    });

    it('16. updateRatioAmbiguousFirstPaneHandledCorrectly', () => {
        const layout = split('horizontal', 0.5, split('horizontal', 0.5, leaf(A), leaf(B)), leaf(C));

        const root = updatingSplitRatio(layout, 'd', 0.7);
        expect(ratioAtPath(root, 'd')).toBe(0.7);
        expect(ratioAtPath(root, 'dL')).toBe(0.5);

        const inner = updatingSplitRatio(layout, 'dL', 0.3);
        expect(ratioAtPath(inner, 'd')).toBe(0.5);
        expect(ratioAtPath(inner, 'dL')).toBe(0.3);
    });

    it('no-ops when the path walks off the tree', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(updatingSplitRatio(layout, 'dLR', 0.3)).toEqual(layout);
        expect(updatingSplitRatio(leaf(A), 'd', 0.3)).toEqual(leaf(A));
        expect(updatingSplitRatio(EMPTY_LAYOUT, 'd', 0.3)).toEqual(EMPTY_LAYOUT);
    });

    it('treats any nav character other than "L" as "R"', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        expect(updatingSplitRatio(layout, 'dX', 0.8)).toEqual(updatingSplitRatio(layout, 'dR', 0.8));
    });
});

describe('ratioAtPath', () => {
    it('48. ratioAtPathReadsNestedRatio', () => {
        const layout = split('horizontal', 0.6, leaf(A), split('vertical', 0.3, leaf(B), leaf(C)));
        expect(ratioAtPath(layout, 'd')).toBe(0.6);
        expect(ratioAtPath(layout, 'dR')).toBe(0.3);
        expect(ratioAtPath(layout, 'dL')).toBeNull();
    });

    it('returns null for a leaf or empty root', () => {
        expect(ratioAtPath(leaf(A), 'd')).toBeNull();
        expect(ratioAtPath(EMPTY_LAYOUT, 'd')).toBeNull();
    });
});

describe('enclosingSplitPath', () => {
    it('44. enclosingSplitPathRootLeafIsNil', () => {
        expect(enclosingSplitPath(leaf(A), A)).toBeNull();
        expect(enclosingSplitPath(EMPTY_LAYOUT, A)).toBeNull();
    });

    it('45. enclosingSplitPathRootSplit', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(enclosingSplitPath(layout, A)).toEqual({
            path: 'd',
            paneIsFirst: true,
            direction: 'horizontal'
        });
        expect(enclosingSplitPath(layout, B)).toEqual({
            path: 'd',
            paneIsFirst: false,
            direction: 'horizontal'
        });
    });

    it('46. enclosingSplitPathNested picks the innermost split', () => {
        const layout = split('horizontal', 0.6, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        expect(enclosingSplitPath(layout, A)).toEqual({
            path: 'd',
            paneIsFirst: true,
            direction: 'horizontal'
        });
        expect(enclosingSplitPath(layout, B)).toEqual({
            path: 'dR',
            paneIsFirst: true,
            direction: 'vertical'
        });
        expect(enclosingSplitPath(layout, C)).toEqual({
            path: 'dR',
            paneIsFirst: false,
            direction: 'vertical'
        });
    });

    it('47. enclosingSplitPathMissingPaneIsNil', () => {
        const layout = split('horizontal', 0.6, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        expect(enclosingSplitPath(layout, MISSING)).toBeNull();
    });
});

describe('pane resize share math (§12.5)', () => {
    it('converts share to the stored first-child ratio', () => {
        expect(shareForRatio(0.6, true)).toBe(0.6);
        expect(shareForRatio(0.6, false)).toBeCloseTo(0.4, 12);
        expect(ratioForShare(0.35, true)).toBe(0.35);
        expect(ratioForShare(0.35, false)).toBe(0.65);
    });

    it('resizes a first-child pane to an exact share', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        const result = resizePaneShare(layout, A, 0.75);
        expect(result).not.toBeNull();
        expect(result?.splitPath).toBe('d');
        expect(result?.ratio).toBe(0.75);
        expect(result?.targetShare).toBe(0.75);
        expect(ratioAtPath(result?.layout ?? EMPTY_LAYOUT, 'd')).toBe(0.75);
    });

    it('inverts the ratio for a second-child pane', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        const result = resizePaneShare(layout, C, 0.65);
        expect(result?.splitPath).toBe('dR');
        expect(result?.targetShare).toBe(0.65);
        expect(result?.ratio).toBe(0.35);
        expect(ratioAtPath(result?.layout ?? EMPTY_LAYOUT, 'd')).toBe(0.5);
    });

    it('clamps the requested share to [0.1, 0.9] before converting', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(resizePaneShare(layout, A, 0.02)?.targetShare).toBe(0.1);
        const shrunk = resizePaneShare(layout, B, 0.98);
        expect(shrunk?.targetShare).toBe(0.9);
        // 1 - 0.9 lands just under the clamp floor; the reported ratio is the stored one.
        expect(shrunk?.ratio).toBe(0.1);
        expect(ratioAtPath(shrunk?.layout ?? EMPTY_LAYOUT, 'd')).toBe(0.1);
    });

    it('returns null when the pane has no sibling to resize against', () => {
        expect(resizePaneShare(leaf(A), A, 0.6)).toBeNull();
        expect(resizePaneShare(split('horizontal', 0.5, leaf(A), leaf(B)), MISSING, 0.6)).toBeNull();
    });

    it('reads the current share for --grow/--shrink', () => {
        const layout = split('horizontal', 0.6, leaf(A), split('vertical', 0.25, leaf(B), leaf(C)));
        expect(currentPaneShare(layout, A)).toBe(0.6);
        expect(currentPaneShare(layout, B)).toBe(0.25);
        expect(currentPaneShare(layout, C)).toBe(0.75);
        expect(currentPaneShare(leaf(A), A)).toBeNull();
    });
});

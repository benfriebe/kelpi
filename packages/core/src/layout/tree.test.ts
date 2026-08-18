import { describe, expect, it } from 'vitest';

import {
    allPaneIDs,
    containsPane,
    isEmptyLayout,
    nextPaneID,
    previousPaneID,
    removing,
    replacing,
    splitting,
    swappingLeaves
} from './tree.js';
import { EMPTY_LAYOUT, leaf, split } from './types.js';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';
const B = 'BBBBBBBB-0000-0000-0000-000000000002';
const C = 'CCCCCCCC-0000-0000-0000-000000000003';
const NEW = 'FFFFFFFF-0000-0000-0000-00000000000F';

describe('allPaneIDs', () => {
    it('1. leafReturnsOneID', () => {
        expect(allPaneIDs(leaf(A))).toEqual([A]);
    });

    it('2. emptyReturnsNoIDs', () => {
        expect(allPaneIDs(EMPTY_LAYOUT)).toEqual([]);
    });

    it('3. splitReturnsAllIDs in DFS first-then-second order', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        expect(allPaneIDs(layout)).toEqual([A, B, C]);
    });
});

describe('isEmptyLayout / containsPane', () => {
    it('is a literal case check, not a leaf count', () => {
        expect(isEmptyLayout(EMPTY_LAYOUT)).toBe(true);
        expect(isEmptyLayout(leaf(A))).toBe(false);
        expect(isEmptyLayout(split('horizontal', 0.5, leaf(A), leaf(B)))).toBe(false);
    });

    it('contains matches allPaneIDs membership', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(containsPane(layout, A)).toBe(true);
        expect(containsPane(layout, C)).toBe(false);
        expect(containsPane(EMPTY_LAYOUT, A)).toBe(false);
    });
});

describe('replacing', () => {
    it('swaps a leaf for an arbitrary subtree, preserving other ratios', () => {
        const layout = split('horizontal', 0.6, leaf(A), leaf(B));
        const replacement = split('vertical', 0.25, leaf(B), leaf(C));
        expect(replacing(layout, B, replacement)).toEqual(
            split('horizontal', 0.6, leaf(A), split('vertical', 0.25, leaf(B), leaf(C)))
        );
    });

    it('is a deep-equal no-op for an absent id, and for empty', () => {
        const layout = split('horizontal', 0.6, leaf(A), leaf(B));
        expect(replacing(layout, C, leaf(NEW))).toEqual(layout);
        expect(replacing(EMPTY_LAYOUT, A, leaf(NEW))).toEqual(EMPTY_LAYOUT);
    });

    it('does not mutate the input tree', () => {
        const inner = split('vertical', 0.5, leaf(B), leaf(C));
        const layout = split('horizontal', 0.5, leaf(A), inner);
        replacing(layout, B, leaf(NEW));
        expect(layout).toEqual(split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C))));
    });
});

describe('splitting', () => {
    it('4. splitLeafCreatesThreePanes — existing pane first, new pane second, ratio 0.5', () => {
        const result = splitting(leaf(A), A, 'horizontal', NEW);
        expect(result.layout).toEqual(split('horizontal', 0.5, leaf(A), leaf(NEW)));
        expect(result.newPaneID).toBe(NEW);
        expect(allPaneIDs(result.layout)).toEqual([A, NEW]);
        expect(result.layout.kind === 'split' ? result.layout.ratio : null).toBe(0.5);
    });

    it('5. splitNestedLeaf yields ids in order [a, b, new]', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        const result = splitting(layout, B, 'vertical', NEW);
        expect(allPaneIDs(result.layout)).toEqual([A, B, NEW]);
        expect(result.layout).toEqual(
            split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(NEW)))
        );
    });

    it('leaves the layout unchanged but still reports newPaneID for an absent source', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        const result = splitting(layout, C, 'vertical', NEW);
        expect(result.layout).toEqual(layout);
        expect(result.newPaneID).toBe(NEW);
    });
});

describe('removing', () => {
    it('6. removeLeafFromSplitPromotesSibling', () => {
        expect(removing(split('horizontal', 0.5, leaf(A), leaf(B)), A)).toEqual(leaf(B));
    });

    it('7. removeFromNestedSplit keeps the outer ratio and collapses the inner split', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        expect(removing(layout, B)).toEqual(split('horizontal', 0.5, leaf(A), leaf(C)));
    });

    it('8. removeLastPaneReturnsEmpty', () => {
        expect(removing(leaf(A), A)).toEqual(EMPTY_LAYOUT);
    });

    it('promotes the sibling subtree intact, without redistributing the lost ratio', () => {
        const sibling = split('vertical', 0.2, leaf(B), leaf(C));
        const layout = split('horizontal', 0.75, leaf(A), sibling);
        expect(removing(layout, A)).toEqual(sibling);
    });

    it('is a structural no-op for an absent id and for empty', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(removing(layout, C)).toEqual(layout);
        expect(removing(EMPTY_LAYOUT, A)).toEqual(EMPTY_LAYOUT);
    });
});

describe('focus order navigation', () => {
    const three = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));

    it('9. nextPaneCycles', () => {
        expect(nextPaneID(three, A)).toBe(B);
        expect(nextPaneID(three, B)).toBe(C);
        expect(nextPaneID(three, C)).toBe(A);
    });

    it('10. previousPaneCycles', () => {
        const two = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(previousPaneID(two, A)).toBe(B);
        expect(previousPaneID(two, B)).toBe(A);
    });

    it('11. singlePaneReturnsNilForNavigation', () => {
        expect(nextPaneID(leaf(A), A)).toBeNull();
        expect(previousPaneID(leaf(A), A)).toBeNull();
    });

    it('returns null for an id that is not in the tree', () => {
        expect(nextPaneID(three, NEW)).toBeNull();
        expect(previousPaneID(three, NEW)).toBeNull();
    });
});

describe('swappingLeaves', () => {
    it('17. swapTwoLeavesInSimpleSplit', () => {
        expect(swappingLeaves(split('horizontal', 0.5, leaf(A), leaf(B)), A, B)).toEqual(
            split('horizontal', 0.5, leaf(B), leaf(A))
        );
    });

    it('18. swapLeavesInNestedSplit preserves structure and ratios', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        expect(swappingLeaves(layout, A, C)).toEqual(
            split('horizontal', 0.5, leaf(C), split('vertical', 0.5, leaf(B), leaf(A)))
        );
    });

    it('19. swapSamePaneIsNoOp', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(swappingLeaves(layout, A, A)).toEqual(layout);
    });

    it('20. swapWithNonExistentPaneReplacesOneLeaf (documented one-way rename)', () => {
        const result = swappingLeaves(split('horizontal', 0.5, leaf(A), leaf(B)), A, C);
        const ids = allPaneIDs(result);
        expect(ids).toContain(C);
        expect(ids).toContain(B);
        expect(ids).not.toContain(A);
    });
});

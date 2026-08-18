import { describe, expect, it } from 'vitest';

import {
    buildLayout,
    evenSplit,
    isPredefinedLayoutKind,
    nextLayoutIndex,
    orderIDsWithFocusedFirst,
    PREDEFINED_LAYOUT_DISPLAY_NAMES,
    PREDEFINED_LAYOUT_ORDER,
    predefinedLayoutAtIndex,
    predefinedLayoutIndex,
    rebuildLayout,
    tiledSplit
} from './predefined.js';
import { allPaneIDs } from './tree.js';
import { EMPTY_LAYOUT, leaf, split } from './types.js';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';
const B = 'BBBBBBBB-0000-0000-0000-000000000002';
const C = 'CCCCCCCC-0000-0000-0000-000000000003';
const D = 'DDDDDDDD-0000-0000-0000-000000000004';
const E = 'EEEEEEEE-0000-0000-0000-000000000005';

describe('canonical order', () => {
    it('is even-horizontal, even-vertical, main-horizontal, main-vertical, tiled', () => {
        expect(PREDEFINED_LAYOUT_ORDER).toEqual([
            'even-horizontal',
            'even-vertical',
            'main-horizontal',
            'main-vertical',
            'tiled'
        ]);
        expect(predefinedLayoutIndex('tiled')).toBe(4);
        expect(predefinedLayoutAtIndex(0)).toBe('even-horizontal');
        expect(predefinedLayoutAtIndex(5)).toBeNull();
    });

    it('exposes display names and a kind guard', () => {
        expect(PREDEFINED_LAYOUT_DISPLAY_NAMES['main-horizontal']).toBe('Main Horizontal');
        expect(PREDEFINED_LAYOUT_DISPLAY_NAMES.tiled).toBe('Tiled');
        expect(isPredefinedLayoutKind('even-vertical')).toBe(true);
        expect(isPredefinedLayoutKind('grid')).toBe(false);
    });
});

describe('guards', () => {
    it('31. singlePaneReturnsLeafForAll', () => {
        for (const kind of PREDEFINED_LAYOUT_ORDER) {
            expect(buildLayout(kind, [A])).toEqual(leaf(A));
        }
    });

    it('32. emptyPaneIDsReturnsEmpty', () => {
        for (const kind of PREDEFINED_LAYOUT_ORDER) {
            expect(buildLayout(kind, [])).toEqual(EMPTY_LAYOUT);
        }
    });
});

describe('even-horizontal', () => {
    it('33. two panes', () => {
        expect(buildLayout('even-horizontal', [A, B])).toEqual(
            split('horizontal', 0.5, leaf(A), leaf(B))
        );
    });

    it('34. three panes', () => {
        expect(buildLayout('even-horizontal', [A, B, C])).toEqual(
            split('horizontal', 1 / 3, leaf(A), split('horizontal', 0.5, leaf(B), leaf(C)))
        );
    });

    it('35. four panes', () => {
        expect(buildLayout('even-horizontal', [A, B, C, D])).toEqual(
            split(
                'horizontal',
                0.25,
                leaf(A),
                split('horizontal', 1 / 3, leaf(B), split('horizontal', 0.5, leaf(C), leaf(D)))
            )
        );
    });

    it('produces unclamped shares below 0.1 for large N (deliberate)', () => {
        const ids = Array.from({ length: 12 }, (_, i) => `AAAAAAAA-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`);
        const layout = buildLayout('even-horizontal', ids);
        expect(layout.kind === 'split' ? layout.ratio : null).toBe(1 / 12);
    });
});

describe('even-vertical', () => {
    it('36. two panes', () => {
        expect(buildLayout('even-vertical', [A, B])).toEqual(
            split('vertical', 0.5, leaf(A), leaf(B))
        );
    });

    it('is the same comb as even-horizontal with the other direction', () => {
        expect(buildLayout('even-vertical', [A, B, C])).toEqual(evenSplit('vertical', [A, B, C]));
    });
});

describe('main-horizontal', () => {
    it('37. two panes', () => {
        expect(buildLayout('main-horizontal', [A, B])).toEqual(
            split('vertical', 0.6, leaf(A), leaf(B))
        );
    });

    it('38. three panes — main on top, the rest in an even row', () => {
        expect(buildLayout('main-horizontal', [A, B, C])).toEqual(
            split('vertical', 0.6, leaf(A), split('horizontal', 0.5, leaf(B), leaf(C)))
        );
    });
});

describe('main-vertical', () => {
    it('39. two panes', () => {
        expect(buildLayout('main-vertical', [A, B])).toEqual(
            split('horizontal', 0.6, leaf(A), leaf(B))
        );
    });

    it('40. three panes — main on the left, the rest in an even column', () => {
        expect(buildLayout('main-vertical', [A, B, C])).toEqual(
            split('horizontal', 0.6, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)))
        );
    });
});

describe('tiled', () => {
    it('41. two panes', () => {
        expect(buildLayout('tiled', [A, B])).toEqual(split('horizontal', 0.5, leaf(A), leaf(B)));
    });

    it('42. three panes — first half gets the floor', () => {
        expect(buildLayout('tiled', [A, B, C])).toEqual(
            split('horizontal', 1 / 3, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)))
        );
    });

    it('43. four panes — a 2x2 grid of columns a/b | c/d', () => {
        expect(buildLayout('tiled', [A, B, C, D])).toEqual(
            split(
                'horizontal',
                0.5,
                split('vertical', 0.5, leaf(A), leaf(B)),
                split('vertical', 0.5, leaf(C), leaf(D))
            )
        );
    });

    it('five panes alternate direction per depth', () => {
        expect(buildLayout('tiled', [A, B, C, D, E])).toEqual(
            split(
                'horizontal',
                2 / 5,
                split('vertical', 0.5, leaf(A), leaf(B)),
                split('vertical', 1 / 3, leaf(C), split('horizontal', 0.5, leaf(D), leaf(E)))
            )
        );
    });

    it('tiledSplit can start from the other direction', () => {
        expect(tiledSplit([A, B], 'vertical')).toEqual(split('vertical', 0.5, leaf(A), leaf(B)));
    });
});

describe('id preservation', () => {
    it('49. allPaneIDsPreserved — every kind, five ids, no dupes and no losses', () => {
        const ids = [A, B, C, D, E];
        for (const kind of PREDEFINED_LAYOUT_ORDER) {
            const built = allPaneIDs(buildLayout(kind, ids));
            expect(new Set(built)).toEqual(new Set(ids));
            expect(built).toHaveLength(ids.length);
        }
    });

    it('preserves ids for every N from 1 to 8 and every kind', () => {
        const pool = Array.from(
            { length: 8 },
            (_, i) => `AAAAAAAA-0000-0000-0000-00000000000${i}`
        );
        for (let n = 1; n <= pool.length; n += 1) {
            const ids = pool.slice(0, n);
            for (const kind of PREDEFINED_LAYOUT_ORDER) {
                const built = allPaneIDs(buildLayout(kind, ids));
                expect(new Set(built)).toEqual(new Set(ids));
                expect(built).toHaveLength(n);
            }
        }
    });
});

describe('cycling (§11)', () => {
    it('restarts at index 0 after a manual change, then wraps', () => {
        expect(nextLayoutIndex(null)).toBe(0);
        expect(nextLayoutIndex(0)).toBe(1);
        expect(nextLayoutIndex(3)).toBe(4);
        expect(nextLayoutIndex(4)).toBe(0);
    });

    it('hoists the focused pane to the front so it becomes the main pane', () => {
        expect(orderIDsWithFocusedFirst([A, B, C], C)).toEqual([C, A, B]);
        expect(orderIDsWithFocusedFirst([A, B, C], A)).toEqual([A, B, C]);
        expect(orderIDsWithFocusedFirst([A, B, C], null)).toEqual([A, B, C]);
        expect(orderIDsWithFocusedFirst([A, B, C], 'FFFFFFFF-0000-0000-0000-00000000000F')).toEqual([
            A,
            B,
            C
        ]);
    });

    it('rebuilds from the current tree leaves order with the focused pane first', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        expect(rebuildLayout(layout, 'main-vertical', B)).toEqual(
            split('horizontal', 0.6, leaf(B), split('vertical', 0.5, leaf(A), leaf(C)))
        );
        expect(rebuildLayout(layout, 'even-horizontal', null)).toEqual(
            buildLayout('even-horizontal', [A, B, C])
        );
    });
});

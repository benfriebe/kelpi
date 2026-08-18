import { describe, expect, it } from 'vitest';

import {
    decodePaneLayoutJSON,
    emptyLayout,
    encodePaneLayout,
    encodePaneLayoutJSON,
    leafLayout,
    parsePaneLayout,
    parsePaneLayoutJSON,
    splitLayout
} from './pane-layout-json.js';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';
const B = 'BBBBBBBB-0000-0000-0000-000000000002';
const C = 'CCCCCCCC-0000-0000-0000-000000000003';

describe('parsePaneLayout', () => {
    it('decodes the three cases in the Swift shape', () => {
        expect(parsePaneLayout({ empty: {} })).toEqual(emptyLayout);
        expect(parsePaneLayout({ leaf: { _0: A } })).toEqual(leafLayout(A));
        expect(
            parsePaneLayout({
                split: { _0: 'horizontal', ratio: 0.6, first: { leaf: { _0: A } }, second: { empty: {} } }
            })
        ).toEqual(splitLayout('horizontal', 0.6, leafLayout(A), emptyLayout));
    });

    it('parses UUIDs case-insensitively and normalizes them uppercase', () => {
        const parsed = parsePaneLayout({ leaf: { _0: A.toLowerCase() } });
        expect(parsed).toEqual(leafLayout(A));
    });

    it('ignores unknown keys inside a case payload', () => {
        expect(parsePaneLayout({ leaf: { _0: A, bogus: 1 } })).toEqual(leafLayout(A));
        expect(
            parsePaneLayout({
                split: {
                    _0: 'vertical',
                    ratio: 0.5,
                    first: { leaf: { _0: A } },
                    second: { leaf: { _0: B } },
                    future: 'ignored'
                }
            })
        ).toEqual(splitLayout('vertical', 0.5, leafLayout(A), leafLayout(B)));
    });

    it('rejects an outer object that does not name exactly one known case', () => {
        expect(parsePaneLayout({})).toBeNull();
        expect(parsePaneLayout({ leaf: { _0: A }, empty: {} })).toBeNull();
        expect(parsePaneLayout({ node: { _0: A } })).toBeNull();
        expect(parsePaneLayout([{ leaf: { _0: A } }])).toBeNull();
        expect(parsePaneLayout('leaf')).toBeNull();
        expect(parsePaneLayout(null)).toBeNull();
    });

    it('rejects malformed case payloads', () => {
        expect(parsePaneLayout({ leaf: {} })).toBeNull();
        expect(parsePaneLayout({ leaf: { _0: 'not-a-uuid' } })).toBeNull();
        expect(parsePaneLayout({ leaf: A })).toBeNull();
        expect(
            parsePaneLayout({ split: { _0: 'diagonal', ratio: 0.5, first: { empty: {} }, second: { empty: {} } } })
        ).toBeNull();
        // direction strings are case-sensitive
        expect(
            parsePaneLayout({ split: { _0: 'Horizontal', ratio: 0.5, first: { empty: {} }, second: { empty: {} } } })
        ).toBeNull();
        // ratio must be a JSON number, not a numeric string
        expect(
            parsePaneLayout({ split: { _0: 'horizontal', ratio: '0.5', first: { empty: {} }, second: { empty: {} } } })
        ).toBeNull();
        expect(parsePaneLayout({ split: { _0: 'horizontal', ratio: 0.5, first: { empty: {} } } })).toBeNull();
    });

    it('accepts any payload under "empty" (Swift never reads a payload-free case value)', () => {
        expect(parsePaneLayout({ empty: {} })).toEqual(emptyLayout);
        expect(parsePaneLayout({ empty: null })).toEqual(emptyLayout);
        expect(parsePaneLayout({ empty: { stray: true } })).toEqual(emptyLayout);
    });
});

describe('decodePaneLayoutJSON', () => {
    it('falls back to empty for missing, blank and undecodable columns', () => {
        expect(decodePaneLayoutJSON(null)).toEqual(emptyLayout);
        expect(decodePaneLayoutJSON(undefined)).toEqual(emptyLayout);
        expect(decodePaneLayoutJSON('')).toEqual(emptyLayout);
        expect(decodePaneLayoutJSON('{')).toEqual(emptyLayout);
        expect(decodePaneLayoutJSON('{"leaf":{"_0":"nope"}}')).toEqual(emptyLayout);
        expect(parsePaneLayoutJSON('{"leaf":{"_0":"nope"}}')).toBeNull();
    });
});

describe('encodePaneLayout', () => {
    it('writes the Swift shape with uppercase UUIDs', () => {
        expect(encodePaneLayoutJSON(emptyLayout)).toBe('{"empty":{}}');
        expect(encodePaneLayoutJSON(leafLayout(A.toLowerCase()))).toBe(`{"leaf":{"_0":"${A}"}}`);
        expect(
            encodePaneLayoutJSON(splitLayout('horizontal', 0.6, leafLayout(A), splitLayout('vertical', 0.4, leafLayout(B), emptyLayout)))
        ).toBe(
            `{"split":{"_0":"horizontal","ratio":0.6,"first":{"leaf":{"_0":"${A}"}},` +
                `"second":{"split":{"_0":"vertical","ratio":0.4,"first":{"leaf":{"_0":"${B}"}},"second":{"empty":{}}}}}}`
        );
    });

    it('round-trips a tree through encode → decode (spec test 30)', () => {
        const tree = splitLayout('horizontal', 0.6, leafLayout(A), splitLayout('vertical', 0.4, leafLayout(B), leafLayout(C)));
        expect(decodePaneLayoutJSON(encodePaneLayoutJSON(tree))).toEqual(tree);
    });

    it('produces a value equal to the documented spec example', () => {
        const tree = splitLayout(
            'horizontal',
            0.6,
            leafLayout(A),
            splitLayout('vertical', 0.4, leafLayout(B), emptyLayout)
        );
        expect(encodePaneLayout(tree)).toEqual({
            split: {
                _0: 'horizontal',
                ratio: 0.6,
                first: { leaf: { _0: A } },
                second: {
                    split: { _0: 'vertical', ratio: 0.4, first: { leaf: { _0: B } }, second: { empty: {} } }
                }
            }
        });
    });
});

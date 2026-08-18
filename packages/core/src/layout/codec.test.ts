import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { decodeLayoutJSON, encodeLayoutJSON, isUUIDString, layoutToJSONValue } from './codec.js';
import { allPaneIDs } from './tree.js';
import { EMPTY_LAYOUT, leaf, split } from './types.js';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';
const B = 'BBBBBBBB-0000-0000-0000-000000000002';
const C = 'CCCCCCCC-0000-0000-0000-000000000003';

const FIXTURE_URL = new URL('../../fixtures/layout-json.json', import.meta.url);

describe('layout JSON encoding (§2)', () => {
    it('30. codableRoundTrip', () => {
        const layout = split('horizontal', 0.6, leaf(A), split('vertical', 0.4, leaf(B), leaf(C)));
        expect(decodeLayoutJSON(encodeLayoutJSON(layout))).toEqual(layout);
    });

    it('writes the Swift Codable shape: case key, `_0` for the unlabeled value', () => {
        expect(layoutToJSONValue(leaf(A))).toEqual({ leaf: { _0: A } });
        expect(layoutToJSONValue(EMPTY_LAYOUT)).toEqual({ empty: {} });
        expect(layoutToJSONValue(split('horizontal', 0.6, leaf(A), EMPTY_LAYOUT))).toEqual({
            split: {
                _0: 'horizontal',
                ratio: 0.6,
                first: { leaf: { _0: A } },
                second: { empty: {} }
            }
        });
    });

    it('writes UUIDs uppercase and parses them case-insensitively', () => {
        const lower = A.toLowerCase();
        expect(encodeLayoutJSON(leaf(lower))).toContain(A);
        expect(decodeLayoutJSON(`{"leaf":{"_0":"${lower}"}}`)).toEqual(leaf(A));
    });

    it('decodes the documented split example', () => {
        const json = `{"split":{"_0":"horizontal","ratio":0.6,
            "first":{"leaf":{"_0":"${A}"}},
            "second":{"split":{"_0":"vertical","ratio":0.4,
                "first":{"leaf":{"_0":"${B}"}},"second":{"empty":{}}}}}}`;
        expect(decodeLayoutJSON(json)).toEqual(
            split('horizontal', 0.6, leaf(A), split('vertical', 0.4, leaf(B), EMPTY_LAYOUT))
        );
    });

    it('tolerates unknown sibling keys and key order', () => {
        const json = `{"split":{"second":{"leaf":{"_0":"${B}"}},"unknown":1,"ratio":0.25,"first":{"leaf":{"_0":"${A}"}},"_0":"vertical"}}`;
        expect(decodeLayoutJSON(json)).toEqual(split('vertical', 0.25, leaf(A), leaf(B)));
    });

    it('falls back to empty for missing, blank and malformed input (never throws)', () => {
        expect(decodeLayoutJSON(null)).toEqual(EMPTY_LAYOUT);
        expect(decodeLayoutJSON(undefined)).toEqual(EMPTY_LAYOUT);
        expect(decodeLayoutJSON('')).toEqual(EMPTY_LAYOUT);
        expect(decodeLayoutJSON('not json')).toEqual(EMPTY_LAYOUT);
        expect(decodeLayoutJSON('[]')).toEqual(EMPTY_LAYOUT);
        expect(decodeLayoutJSON('{}')).toEqual(EMPTY_LAYOUT);
        expect(decodeLayoutJSON('{"leaf":{"_0":"not-a-uuid"}}')).toEqual(EMPTY_LAYOUT);
        expect(decodeLayoutJSON(`{"leaf":{"_0":"${A}"},"empty":{}}`)).toEqual(EMPTY_LAYOUT);
        expect(
            decodeLayoutJSON(`{"split":{"_0":"diagonal","ratio":0.5,"first":{"leaf":{"_0":"${A}"}},"second":{"leaf":{"_0":"${B}"}}}}`)
        ).toEqual(EMPTY_LAYOUT);
        expect(
            decodeLayoutJSON(`{"split":{"_0":"horizontal","first":{"leaf":{"_0":"${A}"}},"second":{"leaf":{"_0":"${B}"}}}}`)
        ).toEqual(EMPTY_LAYOUT);
        expect(decodeLayoutJSON(`{"split":{"_0":"horizontal","ratio":"0.5"}}`)).toEqual(EMPTY_LAYOUT);
    });

    it('decodes a payload-free "empty" case however it is written', () => {
        expect(decodeLayoutJSON('{"empty":5}')).toEqual(EMPTY_LAYOUT);
        expect(decodeLayoutJSON(`{"split":{"_0":"vertical","ratio":0.5,"first":{"leaf":{"_0":"${A}"}},"second":{"empty":5}}}`)).toEqual(
            split('vertical', 0.5, leaf(A), EMPTY_LAYOUT)
        );
    });

    it('validates UUID shape', () => {
        expect(isUUIDString(A)).toBe(true);
        expect(isUUIDString(A.toLowerCase())).toBe(true);
        expect(isUUIDString('AAAAAAAA-0000-0000-0000-00000000000')).toBe(false);
        expect(isUUIDString('')).toBe(false);
    });

    it('preserves fractional ratios through a round trip', () => {
        const layout = split('horizontal', 1 / 3, leaf(A), split('vertical', 0.5099552901745478, leaf(B), leaf(C)));
        expect(decodeLayoutJSON(encodeLayoutJSON(layout))).toEqual(layout);
    });
});

describe('real-database layoutJSON fixtures', () => {
    const rows: { layoutJSON: string }[] = existsSync(FIXTURE_URL)
        ? (JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as { layoutJSON: string }[])
        : [];

    it.skipIf(rows.length === 0)('decodes every captured layout and re-encodes identically', () => {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            const layout = decodeLayoutJSON(row.layoutJSON);
            expect(layout).not.toEqual(EMPTY_LAYOUT);
            const ids = allPaneIDs(layout);
            expect(ids.length).toBeGreaterThan(0);
            expect(new Set(ids).size).toBe(ids.length);
            for (const id of ids) expect(isUUIDString(id)).toBe(true);
            expect(decodeLayoutJSON(encodeLayoutJSON(layout))).toEqual(layout);
        }
    });
});

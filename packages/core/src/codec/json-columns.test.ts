import { describe, expect, it } from 'vitest';

import {
    decodeChildOrderJSON,
    decodeLabelsJSON,
    decodeWebTabsJSON,
    encodeChildOrderJSON,
    encodeLabelsJSON,
    encodeWebTabsJSON,
    parseChildOrderJSON,
    parseLabelsJSON,
    parseWebTabsJSON
} from './json-columns.js';

const A = '11111111-2222-3333-4444-555555555555';
const B = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

describe('labelsJSON', () => {
    it('decodes an ordered string array', () => {
        expect(decodeLabelsJSON('["frontend","wip"]')).toEqual(['frontend', 'wip']);
        expect(decodeLabelsJSON('[]')).toEqual([]);
    });

    it('degrades to [] and never partially decodes', () => {
        expect(parseLabelsJSON('["frontend",3]')).toBeNull();
        expect(decodeLabelsJSON('["frontend",3]')).toEqual([]);
        expect(decodeLabelsJSON('{"a":1}')).toEqual([]);
        expect(decodeLabelsJSON('nope')).toEqual([]);
        expect(decodeLabelsJSON(null)).toEqual([]);
        expect(decodeLabelsJSON('')).toEqual([]);
    });

    it('encodes verbatim (normalization is an app-level invariant, not the codec)', () => {
        expect(encodeLabelsJSON(['frontend', 'wip'])).toBe('["frontend","wip"]');
        expect(decodeLabelsJSON(encodeLabelsJSON(['a b', 'ünï']))).toEqual(['a b', 'ünï']);
    });
});

describe('childOrderJSON', () => {
    it('decodes a UUID array uppercased, preserving order', () => {
        expect(decodeChildOrderJSON(`["${A.toLowerCase()}","${B}"]`)).toEqual([A, B]);
    });

    it('is all-or-nothing on a malformed element', () => {
        expect(parseChildOrderJSON(`["${A}","nope"]`)).toBeNull();
        expect(decodeChildOrderJSON(`["${A}","nope"]`)).toEqual([]);
        expect(decodeChildOrderJSON(null)).toEqual([]);
        expect(decodeChildOrderJSON('[]')).toEqual([]);
    });

    it('encodes uppercase UUIDs', () => {
        expect(encodeChildOrderJSON([A.toLowerCase(), B])).toBe(`["${A}","${B}"]`);
    });
});

describe('webTabsJSON', () => {
    const tabsText = `[{"id":"${A}","url":"https://example.com","title":"Example Domain"},{"id":"${B}","url":"http://localhost:3000","title":""}]`;

    it('decodes tabs with all three fields present', () => {
        expect(decodeWebTabsJSON(tabsText)).toEqual([
            { id: A, url: 'https://example.com', title: 'Example Domain' },
            { id: B, url: 'http://localhost:3000', title: '' }
        ]);
    });

    it('round-trips', () => {
        expect(encodeWebTabsJSON(decodeWebTabsJSON(tabsText))).toBe(tabsText);
    });

    it('degrades to [] on a missing field, bad id or broken JSON', () => {
        expect(parseWebTabsJSON(`[{"id":"${A}","url":"https://example.com"}]`)).toBeNull();
        expect(parseWebTabsJSON('[{"id":"nope","url":"u","title":"t"}]')).toBeNull();
        expect(decodeWebTabsJSON('[{"id":"nope","url":"u","title":"t"}]')).toEqual([]);
        expect(decodeWebTabsJSON(null)).toEqual([]);
        expect(decodeWebTabsJSON('')).toEqual([]);
    });
});

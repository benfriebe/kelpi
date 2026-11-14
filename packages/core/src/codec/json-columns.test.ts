import { describe, expect, it } from 'vitest';

import {
    decodeChildOrderJSON,
    decodeLabelsJSON,
    decodeWebTabsJSON,
    encodeChildOrderJSON,
    encodeLabelsJSON,
    encodeWebTabsJSON,
    encodeWorkspaceTabsJSON,
    parseChildOrderJSON,
    parseLabelsJSON,
    parseWebTabsJSON,
    parseWorkspaceTabsJSON
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

describe('workspace.tabsJSON (workspace-feature.md §12)', () => {
    const TAB = 'b5eddb88-1b61-412d-8d02-e62026261a9e';
    const PANE = 'c003c0e3-27d5-4f86-a99d-845f64e629a2';

    it('round-trips a tab, ids uppercased, a blank name read as none and `seen` defaulting to true', () => {
        const text = encodeWorkspaceTabsJSON([
            { id: TAB, name: 'main', layout: { kind: 'leaf', paneID: PANE }, focusedPaneID: PANE, seen: false }
        ]);
        expect(parseWorkspaceTabsJSON(text)).toEqual([
            { id: TAB.toUpperCase(), name: 'main', layout: { kind: 'leaf', paneID: PANE.toUpperCase() }, focusedPaneID: PANE.toUpperCase(), seen: false }
        ]);
        const bare = JSON.stringify([{ id: TAB, name: '', layout: { empty: {} }, focusedPaneID: null }]);
        expect(parseWorkspaceTabsJSON(bare)).toEqual([
            { id: TAB.toUpperCase(), name: null, layout: { kind: 'empty' }, focusedPaneID: null, seen: true }
        ]);
    });

    it('skips an entry that does not decode, keeping the others', () => {
        const good = { id: TAB, name: null, layout: { leaf: { _0: PANE } }, focusedPaneID: PANE, seen: true };
        const text = JSON.stringify([{ id: 'not-a-uuid', layout: { empty: {} } }, { ...good, name: 4 }, good]);
        expect(parseWorkspaceTabsJSON(text)?.map((tab) => tab.id)).toEqual([TAB.toUpperCase()]);
    });

    it('reads an absent column, or one that is not an array, as no tabs at all', () => {
        expect(parseWorkspaceTabsJSON(null)).toBeNull();
        expect(parseWorkspaceTabsJSON('{"id":1}')).toBeNull();
        expect(parseWorkspaceTabsJSON('nope')).toBeNull();
    });
});

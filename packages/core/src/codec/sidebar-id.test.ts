import { describe, expect, it } from 'vitest';

import {
    decodeTopLevelOrderJSON,
    encodeSidebarID,
    encodeTopLevelOrderJSON,
    groupSidebarID,
    parseSidebarID,
    parseSidebarIDArray,
    parseTopLevelOrderJSON,
    workspaceSidebarID
} from './sidebar-id.js';

const W = '11111111-2222-3333-4444-555555555555';
const G = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

describe('parseSidebarID', () => {
    it('decodes both cases and uppercases the UUID', () => {
        expect(parseSidebarID({ workspace: { _0: W.toLowerCase() } })).toEqual(workspaceSidebarID(W));
        expect(parseSidebarID({ group: { _0: G } })).toEqual(groupSidebarID(G));
    });

    it('rejects unknown cases, multi-key objects and bad UUIDs', () => {
        expect(parseSidebarID({ folder: { _0: W } })).toBeNull();
        expect(parseSidebarID({ workspace: { _0: W }, group: { _0: G } })).toBeNull();
        expect(parseSidebarID({ workspace: { _0: 'nope' } })).toBeNull();
        expect(parseSidebarID({ workspace: W })).toBeNull();
        expect(parseSidebarID(null)).toBeNull();
    });
});

describe('topLevelOrder', () => {
    it('decodes an ordered array preserving order', () => {
        const text = `[{"workspace":{"_0":"${W}"}},{"group":{"_0":"${G}"}}]`;
        expect(decodeTopLevelOrderJSON(text)).toEqual([workspaceSidebarID(W), groupSidebarID(G)]);
    });

    it('is all-or-nothing: one bad entry fails the whole array', () => {
        const text = `[{"workspace":{"_0":"${W}"}},{"group":{"_0":"nope"}}]`;
        expect(parseTopLevelOrderJSON(text)).toBeNull();
        expect(decodeTopLevelOrderJSON(text)).toEqual([]);
        expect(parseSidebarIDArray([{ workspace: { _0: W } }, 7])).toBeNull();
    });

    it('falls back to [] for missing / blank / undecodable values', () => {
        expect(decodeTopLevelOrderJSON(null)).toEqual([]);
        expect(decodeTopLevelOrderJSON(undefined)).toEqual([]);
        expect(decodeTopLevelOrderJSON('')).toEqual([]);
        expect(decodeTopLevelOrderJSON('nonsense')).toEqual([]);
        expect(decodeTopLevelOrderJSON('{}')).toEqual([]);
        expect(decodeTopLevelOrderJSON('[]')).toEqual([]);
    });

    it('encodes the Swift shape with uppercase UUIDs', () => {
        expect(encodeSidebarID(workspaceSidebarID(W.toLowerCase()))).toEqual({ workspace: { _0: W } });
        expect(encodeTopLevelOrderJSON([workspaceSidebarID(W), groupSidebarID(G)])).toBe(
            `[{"workspace":{"_0":"${W}"}},{"group":{"_0":"${G}"}}]`
        );
    });
});

/**
 * The built-in editor's match model (content-panes.md §4.4).
 *
 * The rules are §3.13's, which `find.test.ts` holds against the injected `__kelpiFind`; these
 * hold the same rules against the string scan the editor runs, so ⌘F finds the same things on
 * both sides of ⌘E.
 */

import { describe, expect, it } from 'vitest';

import { fieldOffset, findSegments, findTextMatches, shownRun, stepMatch } from './text-find';

describe('findTextMatches', () => {
    it('finds every occurrence, in document order, as [start, end) offsets', () => {
        expect(findTextMatches('alpha beta gamma\nbeta', 'beta')).toEqual([
            { start: 6, end: 10 },
            { start: 17, end: 21 }
        ]);
    });

    it('folds case, and keeps the offsets of the ORIGINAL text', () => {
        expect(findTextMatches('Beta BETA beta', 'bEtA')).toEqual([
            { start: 0, end: 4 },
            { start: 5, end: 9 },
            { start: 10, end: 14 }
        ]);
    });

    it('is a literal substring search: regex metacharacters match only themselves', () => {
        expect(findTextMatches('axb a.b (x) [y] $z^ a\\b', 'a.b')).toEqual([{ start: 4, end: 7 }]);
        expect(findTextMatches('axb a.b (x) [y] $z^ a\\b', '(x)')).toEqual([{ start: 8, end: 11 }]);
        expect(findTextMatches('axb a.b (x) [y] $z^ a\\b', '[y]')).toEqual([{ start: 12, end: 15 }]);
        expect(findTextMatches('axb a.b (x) [y] $z^ a\\b', '$z^')).toEqual([{ start: 16, end: 19 }]);
        expect(findTextMatches('axb a.b (x) [y] $z^ a\\b', 'a\\b')).toEqual([{ start: 20, end: 23 }]);
    });

    it('does not overlap matches, as a global regex scan does not', () => {
        expect(findTextMatches('aaaa', 'aa')).toEqual([
            { start: 0, end: 2 },
            { start: 2, end: 4 }
        ]);
    });

    it('matches nothing for an empty needle or an empty buffer', () => {
        expect(findTextMatches('anything', '')).toEqual([]);
        expect(findTextMatches('', 'x')).toEqual([]);
    });
});

describe('stepMatch', () => {
    it('wraps around modulo the match count, both ways', () => {
        expect(stepMatch(0, 3, 1)).toBe(1);
        expect(stepMatch(2, 3, 1)).toBe(0);
        expect(stepMatch(0, 3, -1)).toBe(2);
        expect(stepMatch(1, 3, -1)).toBe(0);
    });

    it('is -1 with no matches, and starts from the nearest end with nothing selected', () => {
        expect(stepMatch(0, 0, 1)).toBe(-1);
        expect(stepMatch(-1, 4, 1)).toBe(0);
        expect(stepMatch(-1, 4, -1)).toBe(3);
        // A selection past a list that shrank under it re-enters from an end, never past it.
        expect(stepMatch(9, 4, 1)).toBe(0);
    });
});

describe('findSegments', () => {
    const text = 'one beta\ntwo beta\nthree beta';
    const matches = findTextMatches(text, 'beta');

    it('splits the slice into plain runs and marks, flagging the selected match', () => {
        expect(findSegments(text, 0, text.length, matches, 1)).toEqual([
            { text: 'one ', kind: 'text' },
            { text: 'beta', kind: 'match' },
            { text: '\ntwo ', kind: 'text' },
            { text: 'beta', kind: 'current' },
            { text: '\nthree ', kind: 'text' },
            { text: 'beta', kind: 'match' }
        ]);
    });

    it('draws only the window it is given, with the match indices still global', () => {
        // Line 2 alone: [9, 17).
        expect(findSegments(text, 9, 17, matches, 1)).toEqual([
            { text: 'two ', kind: 'text' },
            { text: 'beta', kind: 'current' }
        ]);
        expect(findSegments(text, 18, text.length, matches, 1)).toEqual([
            { text: 'three ', kind: 'text' },
            { text: 'beta', kind: 'match' }
        ]);
    });

    it('clips a match that straddles either edge of the window', () => {
        expect(findSegments('abcdef', 2, 4, [{ start: 1, end: 5 }], 0)).toEqual([{ text: 'cd', kind: 'current' }]);
    });

    it('is one plain run when nothing in the window matches', () => {
        expect(findSegments(text, 0, 4, matches, 0)).toEqual([{ text: 'one ', kind: 'text' }]);
    });
});

describe('fieldOffset / shownRun: a buffer that still has its CRLFs', () => {
    it('maps a buffer offset to the textarea offset, one fewer per CRLF before it', () => {
        const text = 'ab\r\ncd\r\nef';
        expect(fieldOffset(text, 0)).toBe(0);
        expect(fieldOffset(text, 2)).toBe(2);
        // `c` is at 4 in the buffer and 3 in the field, `e` at 8 and 6.
        expect(fieldOffset(text, 4)).toBe(3);
        expect(fieldOffset(text, 8)).toBe(6);
        expect(fieldOffset(text, text.length)).toBe(text.replace(/\r\n/g, '\n').length);
    });

    it('leaves a buffer with no CR, and a lone CR (one character either way), alone', () => {
        expect(fieldOffset('plain\ntext', 7)).toBe(7);
        expect(fieldOffset('a\rb', 3)).toBe(3);
    });

    it('drops the CR of a line ending from a highlight run, and nothing else', () => {
        expect(shownRun('one\r\ntwo\r')).toBe('one\ntwo');
        expect(shownRun('a\rb')).toBe('a\rb');
        expect(shownRun('plain')).toBe('plain');
    });
});

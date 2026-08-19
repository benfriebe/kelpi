/**
 * The parsing primitives (cli.md §7). These are the cases that interact — a rewrite that
 * "cleans them up" breaks real invocations, so each quirk is pinned here.
 */

import { describe, expect, it, afterEach } from 'vitest';

import {
    extractPositionalTail,
    hasHelpFlag,
    isHelpToken,
    isUUID,
    parseDouble,
    parseFlag,
    parseFlagAll,
    parseIntStrict,
    parseOptionalAmountFlag,
    parseUIntStrict,
    popSwitch,
    rejectLeftoverArgs
} from './args.js';
import { ExitError, resetIO, setIO } from './io.js';

function captureIO(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    setIO({ out: (text) => out.push(text), err: (text) => err.push(text) });
    return { out, err };
}

afterEach(() => {
    resetIO();
});

describe('parseFlag', () => {
    it('finds the flag anywhere in argv and removes both tokens', () => {
        const args = ['echo', 'hi', '--target', 'worker-1', 'there'];
        expect(parseFlag('--target', args)).toBe('worker-1');
        expect(args).toEqual(['echo', 'hi', 'there']);
    });

    it('consumes a dash-prefixed value (so `--name --json` names the pane "--json")', () => {
        const args = ['--name', '--json'];
        expect(parseFlag('--name', args)).toBe('--json');
        expect(args).toEqual([]);
    });

    it('leaves a value-less trailing flag in argv so the leftover check rejects it', () => {
        const args = ['--json', '--target'];
        expect(parseFlag('--target', args)).toBeNull();
        // The flag token survives — this is what turns `--target` at the end into
        // "unknown option --target" rather than a silent no-op.
        expect(args).toEqual(['--json', '--target']);
    });

    it('only takes the FIRST occurrence, which is what makes repeats loopable', () => {
        const args = ['--add', 'a', '--add', 'b'];
        expect(parseFlagAll('--add', args)).toEqual(['a', 'b']);
        expect(args).toEqual([]);
    });
});

describe('popSwitch', () => {
    it('removes the first occurrence and consumes no value', () => {
        const args = ['--json', 'text', '--json'];
        expect(popSwitch('--json', args)).toBe(true);
        expect(args).toEqual(['text', '--json']);
        expect(popSwitch('--nope', args)).toBe(false);
    });
});

describe('parseOptionalAmountFlag', () => {
    it('defaults when the next token is not a number, and keeps that token', () => {
        const args = ['--grow', '--json'];
        expect(parseOptionalAmountFlag('--grow', 0.05, args)).toBe(0.05);
        expect(args).toEqual(['--json']);
    });

    it('eats the next token when it parses as a float', () => {
        const args = ['--shrink', '0.2', 'rest'];
        expect(parseOptionalAmountFlag('--shrink', 0.05, args)).toBe(0.2);
        expect(args).toEqual(['rest']);
    });

    it('is null when absent', () => {
        const args = ['--json'];
        expect(parseOptionalAmountFlag('--grow', 0.05, args)).toBeNull();
        expect(args).toEqual(['--json']);
    });
});

describe('extractPositionalTail', () => {
    it('protects a payload that looks like a flag', () => {
        const args = ['css:#i', '--', '--submit'];
        expect(extractPositionalTail(args)).toEqual(['--submit']);
        expect(args).toEqual(['css:#i']);
        // With the tail removed, the flag parser cannot see `--submit`.
        expect(popSwitch('--submit', args)).toBe(false);
    });

    it('is empty without a terminator', () => {
        const args = ['css:#i', '--submit'];
        expect(extractPositionalTail(args)).toEqual([]);
        expect(args).toEqual(['css:#i', '--submit']);
    });
});

describe('rejectLeftoverArgs', () => {
    it('does nothing on an empty argv', () => {
        const io = captureIO();
        rejectLeftoverArgs([], 'nex pane list');
        expect(io.err).toEqual([]);
    });

    it('reports a dash token as an unknown option', () => {
        const io = captureIO();
        expect(() => {
            rejectLeftoverArgs(['--nope'], 'nex pane list');
        }).toThrow(ExitError);
        expect(io.err.join('')).toBe('nex pane list: unknown option --nope\n');
    });

    it('appends the positional hint so a bare uuid points at --target', () => {
        const io = captureIO();
        expect(() => {
            rejectLeftoverArgs(['abc'], 'nex pane capture', {
                positionalHint: 'target panes with --target <name-or-uuid>'
            });
        }).toThrow(ExitError);
        expect(io.err.join('')).toBe(
            "nex pane capture: unexpected argument 'abc' — target panes with --target <name-or-uuid>\n"
        );
    });

    it('prints the usage block after the message when one is supplied', () => {
        const io = captureIO();
        expect(() => {
            rejectLeftoverArgs(['abc'], 'nex pane list', { usage: (write) => write('USAGE\n') });
        }).toThrow(ExitError);
        expect(io.err.join('')).toBe("nex pane list: unexpected argument 'abc'\nUSAGE\n");
    });
});

describe('scalar parsers', () => {
    it.each([
        ['0.5', 0.5],
        ['-1', -1],
        ['1e3', 1000],
        ['', null],
        [' 1', null],
        ['1 ', null],
        ['abc', null]
    ])('parseDouble(%j)', (input, expected) => {
        expect(parseDouble(input)).toBe(expected);
    });

    it('treats inf/nan as values, not parse failures (the isFinite guards depend on it)', () => {
        expect(parseDouble('inf')).toBe(Infinity);
        expect(Number.isNaN(parseDouble('nan') as number)).toBe(true);
    });

    it.each([
        ['12', 12],
        ['-3', -3],
        ['+4', 4],
        ['1.5', null],
        ['0x10', null],
        ['', null]
    ])('parseIntStrict(%j)', (input, expected) => {
        expect(parseIntStrict(input)).toBe(expected);
    });

    it.each([
        ['0', 0],
        ['7', 7],
        ['-1', null],
        ['x', null]
    ])('parseUIntStrict(%j)', (input, expected) => {
        expect(parseUIntStrict(input)).toBe(expected);
    });

    it('recognises canonical UUIDs in either case', () => {
        expect(isUUID('9C2B9A2E-1111-2222-3333-444455556666')).toBe(true);
        expect(isUUID('9c2b9a2e-1111-2222-3333-444455556666')).toBe(true);
        expect(isUUID('worker-1')).toBe(false);
        expect(isUUID('9C2B9A2E11112222')).toBe(false);
    });
});

describe('help tokens', () => {
    it('accepts the three token forms and the two flag forms', () => {
        expect(['-h', '--help', 'help'].every(isHelpToken)).toBe(true);
        expect(isHelpToken('--halp')).toBe(false);
        expect(hasHelpFlag(['--target', 'x', '--help'])).toBe(true);
        expect(hasHelpFlag(['--target', 'x'])).toBe(false);
    });
});

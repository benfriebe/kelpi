/// <reference types="node" />
// Required because @types/node is not auto-included for this project (pnpm-symlinked
// typeRoots); scoped to this test file, which reads the spec doc as its fixture.

/**
 * Conformance against the spec text itself: the allowlist block (§4), the command summary
 * table (§6.0) and the wire-field dictionary (§7) are parsed out of
 * `docs/current/wire-protocol.md` so drift between the doc and this package fails loudly.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isReplyCommand, REPLY_COMMANDS } from '../allowlist.js';
import { WIRE_FIELD_TYPES, type WireFieldKind } from './fields.js';
import { isWireCommand, WIRE_COMMANDS } from './messages.js';

const SPEC = readFileSync(new URL('../../../../docs/current/wire-protocol.md', import.meta.url), 'utf8');

function allowlistFromSpec(): string[] {
    const section = SPEC.split('## 4. Reply allowlist')[1];
    expect(section).toBeDefined();
    const fenced = /```([\s\S]*?)```/.exec(section as string);
    expect(fenced).not.toBeNull();
    return (fenced?.[1] ?? '')
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
}

interface SpecCommandRow {
    readonly command: string;
    readonly mode: 'R/R' | 'F&F';
}

function commandTableFromSpec(): SpecCommandRow[] {
    const section = SPEC.split('### 6.0 Summary table')[1]?.split('### 6.1')[0] ?? '';
    const rows: SpecCommandRow[] = [];
    for (const line of section.split('\n')) {
        const match = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(R\/R|F&F)\s*\|/.exec(line);
        if (match) rows.push({ command: match[1] as string, mode: match[2] as 'R/R' | 'F&F' });
    }
    return rows;
}

const SPEC_TYPE_NAMES: Readonly<Record<string, WireFieldKind>> = {
    string: 'string',
    'string (UUID)': 'uuid',
    int: 'int',
    bool: 'bool',
    uint64: 'uint64',
    double: 'double',
    'string[]': 'string[]'
};

function fieldDictionaryFromSpec(): Map<string, WireFieldKind> {
    const section = SPEC.split('## 7. Full wire-field dictionary')[1]?.split('## 8.')[0] ?? '';
    const fields = new Map<string, WireFieldKind>();
    for (const line of section.split('\n')) {
        const match = /^\|\s*(`[^|]+`)\s*\|\s*([^|]+?)\s*\|/.exec(line);
        if (!match) continue;
        const kind = SPEC_TYPE_NAMES[match[2] as string];
        if (kind === undefined) continue;
        for (const name of (match[1] as string).matchAll(/`([a-z0-9_]+)`/g)) {
            fields.set(name[1] as string, kind);
        }
    }
    return fields;
}

describe('reply allowlist (§4)', () => {
    const specAllowlist = allowlistFromSpec();

    it('parses a non-trivial allowlist out of the spec', () => {
        expect(specAllowlist.length).toBeGreaterThan(50);
    });

    it('matches the spec set exactly', () => {
        expect([...REPLY_COMMANDS].sort()).toEqual([...specAllowlist].sort());
    });

    it('recognizes every allowlisted name through isReplyCommand', () => {
        for (const command of specAllowlist) expect(isReplyCommand(command)).toBe(true);
        expect(isReplyCommand('start')).toBe(false);
        expect(isReplyCommand('nonsense')).toBe(false);
    });
});

describe('command summary table (§6.0)', () => {
    const rows = commandTableFromSpec();

    it('covers every documented command', () => {
        expect(rows.length).toBeGreaterThan(60);
        expect([...new Set(rows.map((row) => row.command))].sort()).toEqual([...WIRE_COMMANDS].sort());
    });

    it('agrees with the allowlist on request/response vs fire-and-forget', () => {
        for (const row of rows) {
            expect(isWireCommand(row.command)).toBe(true);
            expect(isReplyCommand(row.command)).toBe(row.mode === 'R/R');
        }
    });
});

describe('wire-field dictionary (§7)', () => {
    const specFields = fieldDictionaryFromSpec();

    it('lists the same keys as the decoder knows', () => {
        expect(specFields.size).toBeGreaterThan(60);
        expect([...specFields.keys()].sort()).toEqual(Object.keys(WIRE_FIELD_TYPES).sort());
    });

    it('agrees on every field type', () => {
        for (const [field, kind] of specFields) {
            expect((WIRE_FIELD_TYPES as Record<string, WireFieldKind>)[field]).toBe(kind);
        }
    });
});

/// <reference types="node" />
// The reference is required because @types/node is not auto-included for this project
// (pnpm-symlinked typeRoots); it is scoped to this test file, which is the only file here
// allowed to touch node APIs.

/**
 * Round-trip conformance against JSON captured from a live Swift-app `nex.db`.
 * Fixtures are the real on-disk bytes: if these break, an adopted database breaks.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { decodeLabelsJSON } from './json-columns.js';
import { isJSONObject } from './json.js';
import { encodePaneLayout, encodePaneLayoutJSON, parsePaneLayoutJSON, type PaneLayout } from './pane-layout-json.js';
import { decodeTopLevelOrderJSON, encodeTopLevelOrderJSON } from './sidebar-id.js';
import {
    formatWireTimestamp,
    looksLikeUnixMillis,
    parseEpochSecondsColumn,
    parseWireTimestamp
} from './timestamps.js';
import { isUUIDString } from './uuid.js';

function readFixtureRows(name: string): readonly Record<string, unknown>[] {
    const text = readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`fixture ${name} is not an array`);
    return parsed.map((row) => {
        if (!isJSONObject(row)) throw new Error(`fixture ${name} has a non-object row`);
        return row;
    });
}

function requireString(row: Record<string, unknown>, key: string): string {
    const value = row[key];
    if (typeof value !== 'string') throw new Error(`expected string column ${key}`);
    return value;
}

function leafIDs(layout: PaneLayout): string[] {
    switch (layout.kind) {
        case 'empty':
            return [];
        case 'leaf':
            return [layout.paneID];
        case 'split':
            return [...leafIDs(layout.first), ...leafIDs(layout.second)];
    }
}

describe('layoutJSON fixtures (real nex.db)', () => {
    const rows = readFixtureRows('layout-json.json');

    it('captures every real layout string', () => {
        expect(rows.length).toBe(8);
    });

    it.each(rows.map((row, index) => [index, requireString(row, 'layoutJSON')] as const))(
        'row %i decodes, re-encodes to the same structure, and re-decodes identically',
        (_index, layoutJSON) => {
            const decoded = parsePaneLayoutJSON(layoutJSON);
            expect(decoded).not.toBeNull();
            if (decoded === null) return;

            // Structural (key-order-insensitive) equality with the Swift-written JSON.
            expect(encodePaneLayout(decoded)).toEqual(JSON.parse(layoutJSON));

            // parse → serialize → parse is stable.
            const reserialized = encodePaneLayoutJSON(decoded);
            expect(parsePaneLayoutJSON(reserialized)).toEqual(decoded);
            expect(encodePaneLayoutJSON(parsePaneLayoutJSON(reserialized) as PaneLayout)).toBe(reserialized);

            // Swift shape markers: `_0`-keyed cases, uppercase UUIDs.
            expect(reserialized).toContain('"_0"');
            const ids = leafIDs(decoded);
            expect(ids.length).toBeGreaterThan(0);
            for (const id of ids) {
                expect(isUUIDString(id)).toBe(true);
                expect(id).toBe(id.toUpperCase());
            }
        }
    );

    it('accepts the same layouts written lowercase (Swift parses case-insensitively)', () => {
        for (const row of rows) {
            const layoutJSON = requireString(row, 'layoutJSON');
            const fromUpper = parsePaneLayoutJSON(layoutJSON);
            const fromLower = parsePaneLayoutJSON(layoutJSON.replace(/"([0-9A-F-]{36})"/g, (_m, id: string) => `"${id.toLowerCase()}"`));
            expect(fromLower).toEqual(fromUpper);
        }
    });
});

describe('topLevelOrder fixture (real nex.db)', () => {
    const rows = readFixtureRows('top-level-order.json');
    const value = requireString(rows[0] ?? {}, 'value');

    it('decodes the real sidebar order', () => {
        const order = decodeTopLevelOrderJSON(value);
        expect(order.length).toBe(12);
        expect(order[0]).toEqual({ kind: 'workspace', id: 'A4E8A251-9D7C-4427-8358-6377F67E6B35' });
        expect(order[1]).toEqual({ kind: 'group', id: '7F429BA5-7F39-477B-AC5B-236ADBB5FE5A' });
        expect(order.filter((entry) => entry.kind === 'group').length).toBe(7);
    });

    it('re-encodes to the same structure and re-decodes identically', () => {
        const order = decodeTopLevelOrderJSON(value);
        const reserialized = encodeTopLevelOrderJSON(order);
        expect(JSON.parse(reserialized)).toEqual(JSON.parse(value));
        expect(decodeTopLevelOrderJSON(reserialized)).toEqual(order);
        expect(reserialized).toContain('"_0"');
    });
});

describe('workspace scalar fixtures (real nex.db)', () => {
    const rows = readFixtureRows('workspace-scalars.json');

    it('reads epoch-SECONDS timestamps and never mistakes them for millis', () => {
        expect(rows.length).toBe(3);
        for (const row of rows) {
            for (const key of ['createdAt', 'lastAccessedAt']) {
                const seconds = parseEpochSecondsColumn(row[key]);
                expect(seconds).not.toBeNull();
                if (seconds === null) continue;
                expect(looksLikeUnixMillis(seconds)).toBe(false);
                // Sanity: these rows are from 2026-era usage, not 1970 or the year 58000.
                expect(seconds).toBeGreaterThan(1_700_000_000);
                expect(seconds).toBeLessThan(2_000_000_000);
            }
        }
    });

    it('formats timestamps to the seconds-precision wire shape', () => {
        const created = parseEpochSecondsColumn(rows[0]?.['createdAt']);
        expect(created).not.toBeNull();
        if (created === null) return;
        const wire = formatWireTimestamp(created);
        expect(wire).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(wire).not.toContain('.');
        const reparsed = parseWireTimestamp(wire);
        expect(reparsed).not.toBeNull();
        expect(Math.floor(created)).toBe(reparsed === null ? Number.NaN : Math.floor(reparsed));
    });

    it('decodes the stored labels arrays', () => {
        for (const row of rows) {
            expect(decodeLabelsJSON(requireString(row, 'labelsJSON'))).toEqual([]);
        }
        expect(rows.every((row) => isUUIDString(requireString(row, 'id')))).toBe(true);
    });
});

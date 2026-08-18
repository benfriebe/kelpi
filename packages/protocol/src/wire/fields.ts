/**
 * The flat wire-field dictionary (wire-protocol.md §7) and the type-strict field readers.
 *
 * The Swift server decodes every line into ONE flat Codable struct, so a wrong-typed known
 * key poisons the whole message even when the command in question never reads that key.
 * Unknown keys are ignored. JSON `null` decodes as "absent" (Codable `decodeIfPresent`).
 */

import { normalizeUuid } from './vocab.js';

export type WireFieldKind = 'string' | 'uuid' | 'bool' | 'int' | 'uint64' | 'double' | 'string[]';

export const WIRE_FIELD_TYPES = {
    command: 'string',
    pane_id: 'uuid',
    message: 'string',
    title: 'string',
    body: 'string',
    session_id: 'string',
    background_tasks: 'int',
    agent: 'string',
    direction: 'string',
    path: 'string',
    name: 'string',
    color: 'string',
    target: 'string',
    text: 'string',
    key: 'string',
    bare: 'bool',
    new_name: 'string',
    cascade: 'bool',
    force: 'bool',
    index: 'int',
    group: 'string',
    profile: 'string',
    workspace: 'string',
    scope: 'string',
    reuse: 'bool',
    repo_path: 'string',
    target_path: 'string',
    lines: 'int',
    scrollback: 'bool',
    repo: 'string',
    url: 'string',
    mode: 'string',
    hard: 'bool',
    tab: 'string',
    make_active: 'bool',
    since: 'uint64',
    level: 'string',
    clear: 'bool',
    follow: 'bool',
    send_to: 'string',
    submit: 'bool',
    disarm: 'bool',
    private: 'bool',
    domain: 'string',
    all: 'bool',
    selector: 'string',
    double: 'bool',
    right: 'bool',
    at_x: 'double',
    at_y: 'double',
    replace: 'bool',
    max_bytes: 'int',
    attribute: 'string',
    for: 'string',
    url_match: 'string',
    timeout_ms: 'int',
    value_or_label: 'string',
    block: 'string',
    behavior: 'string',
    script: 'string',
    action: 'string',
    excluded: 'bool',
    worktree: 'string',
    branch: 'string',
    update_main: 'bool',
    ratio: 'double',
    delta: 'double',
    anchor: 'string',
    zone: 'string',
    label_op: 'string',
    label_values: 'string[]',
    order: 'string[]',
    by: 'string',
    descending: 'bool'
} as const satisfies Record<string, WireFieldKind>;

export type WireFieldName = keyof typeof WIRE_FIELD_TYPES;

/** Optional string fields whose empty string is normalized to "absent" (§2.2). */
export const EMPTY_STRING_NORMALIZED_FIELDS: ReadonlySet<string> = new Set([
    'target',
    'workspace',
    'group',
    'profile',
    'worktree',
    'branch',
    'repo',
    'scope',
    'level',
    'send_to',
    'domain',
    'selector',
    'url_match',
    'for',
    'mode',
    'block',
    'behavior',
    'target_path'
]);

export interface WireFieldTypeError {
    readonly field: WireFieldName;
    readonly kind: WireFieldKind;
}

function matchesKind(value: unknown, kind: WireFieldKind): boolean {
    switch (kind) {
        case 'string':
        case 'uuid':
            return typeof value === 'string';
        case 'bool':
            return typeof value === 'boolean';
        case 'int':
            return typeof value === 'number' && Number.isInteger(value);
        case 'uint64':
            return typeof value === 'number' && Number.isInteger(value) && value >= 0;
        case 'double':
            return typeof value === 'number' && Number.isFinite(value);
        case 'string[]':
            return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    }
}

/** Returns the first known key whose JSON type is wrong, or undefined when the line is clean. */
export function validateWireFields(raw: Record<string, unknown>): WireFieldTypeError | undefined {
    for (const key of Object.keys(raw)) {
        const kind: WireFieldKind | undefined = (WIRE_FIELD_TYPES as Record<string, WireFieldKind>)[key];
        if (kind === undefined) continue;
        const value = raw[key];
        if (value === null || value === undefined) continue;
        if (!matchesKind(value, kind)) return { field: key as WireFieldName, kind };
    }
    return undefined;
}

export interface WireFieldAccess {
    /** String value with §2.2 empty-string normalization applied for the fields that get it. */
    text(key: WireFieldName): string | undefined;
    /** String value with no normalization: an empty string stays an empty string. */
    rawText(key: WireFieldName): string | undefined;
    /** String value that must be non-empty (the "required non-empty" guards). */
    nonEmpty(key: WireFieldName): string | undefined;
    bool(key: WireFieldName): boolean | undefined;
    flag(key: WireFieldName, fallback: boolean): boolean;
    int(key: WireFieldName): number | undefined;
    number(key: WireFieldName): number | undefined;
    list(key: WireFieldName): readonly string[] | undefined;
    /** `pane_id` normalized to an uppercase UUID; a syntactically invalid id reads as absent. */
    paneId(): string | undefined;
    has(key: WireFieldName): boolean;
}

/** Field readers over an already type-validated wire object. */
export function createFieldAccess(raw: Record<string, unknown>): WireFieldAccess {
    const read = (key: WireFieldName): unknown => {
        const value = raw[key];
        return value === null ? undefined : value;
    };

    const rawText = (key: WireFieldName): string | undefined => {
        const value = read(key);
        return typeof value === 'string' ? value : undefined;
    };

    return {
        rawText,
        text(key) {
            const value = rawText(key);
            if (value === undefined) return undefined;
            if (value === '' && EMPTY_STRING_NORMALIZED_FIELDS.has(key)) return undefined;
            return value;
        },
        nonEmpty(key) {
            const value = rawText(key);
            return value !== undefined && value.length > 0 ? value : undefined;
        },
        bool(key) {
            const value = read(key);
            return typeof value === 'boolean' ? value : undefined;
        },
        flag(key, fallback) {
            const value = read(key);
            return typeof value === 'boolean' ? value : fallback;
        },
        int(key) {
            const value = read(key);
            return typeof value === 'number' ? value : undefined;
        },
        number(key) {
            const value = read(key);
            return typeof value === 'number' ? value : undefined;
        },
        list(key) {
            const value = read(key);
            return Array.isArray(value) ? (value as readonly string[]) : undefined;
        },
        paneId() {
            const value = rawText('pane_id');
            return value === undefined ? undefined : normalizeUuid(value);
        },
        has(key) {
            return read(key) !== undefined;
        }
    };
}

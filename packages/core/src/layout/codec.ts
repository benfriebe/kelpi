/**
 * Persisted layout JSON — Swift's auto-synthesized Codable enum encoding.
 * Spec: docs/pane-layout.md §2, §15.2.
 *
 * Shape: one key naming the case; the unlabeled associated value is keyed `_0`
 * (direction for split, UUID for leaf); labeled values keep their labels.
 * Unknown sibling keys are tolerated; UUIDs parse case-insensitively and are
 * written uppercase so a rollback to the Swift app keeps working.
 */

import type { PaneLayout } from './types.js';
import { EMPTY_LAYOUT, leaf, split } from './types.js';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUUIDString(value: string): boolean {
    return UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function layoutToJSONValue(layout: PaneLayout): unknown {
    switch (layout.kind) {
        case 'leaf':
            return { leaf: { _0: layout.paneID.toUpperCase() } };
        case 'split':
            return {
                split: {
                    _0: layout.direction,
                    ratio: layout.ratio,
                    first: layoutToJSONValue(layout.first),
                    second: layoutToJSONValue(layout.second)
                }
            };
        case 'empty':
            return { empty: {} };
    }
}

export function encodeLayoutJSON(layout: PaneLayout): string {
    return JSON.stringify(layoutToJSONValue(layout));
}

class LayoutDecodeError extends Error {}

function decodeNode(value: unknown): PaneLayout {
    if (!isRecord(value)) throw new LayoutDecodeError('layout node is not an object');

    const present = (['leaf', 'split', 'empty'] as const).filter((key) => key in value);
    const caseKey = present[0];
    if (present.length !== 1 || caseKey === undefined) {
        throw new LayoutDecodeError(`expected exactly one case key, found ${present.length}`);
    }

    // Swift's synthesized decoder sets a payload-free case without reading its
    // associated value, so anything under "empty" decodes.
    if (caseKey === 'empty') return EMPTY_LAYOUT;

    const payload = value[caseKey];
    if (!isRecord(payload)) throw new LayoutDecodeError('case payload is not an object');

    if (caseKey === 'leaf') {
        const id = payload['_0'];
        if (typeof id !== 'string' || !isUUIDString(id)) {
            throw new LayoutDecodeError('leaf _0 is not a UUID string');
        }
        return leaf(id.toUpperCase());
    }

    const direction = payload['_0'];
    if (direction !== 'horizontal' && direction !== 'vertical') {
        throw new LayoutDecodeError('split _0 is not a SplitDirection');
    }
    const ratio = payload['ratio'];
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
        throw new LayoutDecodeError('split ratio is not a number');
    }
    return split(direction, ratio, decodeNode(payload['first']), decodeNode(payload['second']));
}

/**
 * Parse `layoutJSON`. Never throws: a missing, empty or malformed value falls
 * back to `empty` exactly like the Swift load path (§2).
 */
export function decodeLayoutJSON(json: string | null | undefined): PaneLayout {
    if (json === null || json === undefined || json.length === 0) return EMPTY_LAYOUT;
    try {
        return decodeNode(JSON.parse(json));
    } catch {
        return EMPTY_LAYOUT;
    }
}

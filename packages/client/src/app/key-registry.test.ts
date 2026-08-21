/**
 * The key-action registry is COMPLETE — every bindable action dispatches, and nothing in it is
 * dead.
 *
 * This exists because of a defect the second capability re-score found (00-INDEX gap #6): four
 * actions — `open_web_pane`, `rename_workspace`, `new_group`, `open_diff` — were catalogued in
 * `NEX_ACTIONS`, round-tripped through the config file, rendered their shortcut inside a menu,
 * and did **nothing** when pressed, because `App.tsx`'s registry had no entry for them. Nothing
 * failed; the gap was found by hand-diffing two lists a year after the fact. That is the class
 * of bug this file exists to make impossible, and the reason it is a *completeness* test rather
 * than four more behaviour tests: the four are wired now, and the next action someone adds to
 * `NEX_ACTIONS` is the one that would otherwise repeat the story.
 *
 * It reads the SOURCE rather than the object because the registry is built inside a component's
 * `useMemo` and is not exported — the same trade `app/smoke-contract.test.ts` makes for
 * `scripts/smoke.mjs`. What it parses is exactly the registry literal: keys at the literal's own
 * indentation, plus the `workspaceSwitchHandlers` spread that supplies the nine
 * `switch_to_workspace_N` entries. A handler nested inside another handler is indented deeper
 * and is not a key, which is what keeps the parse honest.
 *
 * If this test ever fails because the registry was reformatted rather than because an action
 * went unwired, fix the parse — do not delete the assertion.
 */

import { NEX_ACTIONS, type NexAction } from '@nex/core/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx');
const source = readFileSync(appPath, 'utf8');

const REGISTRY_OPEN = 'const keyActions = useMemo<KeyActionRegistry>(';

/** The registry object literal, from `() => ({` to the `}),` that closes it. */
function registrySource(): string {
    const start = source.indexOf(REGISTRY_OPEN);
    expect(start, `${REGISTRY_OPEN} is not in App.tsx`).toBeGreaterThan(-1);
    const body = source.slice(start);
    // The literal is one indentation level in from the `const`, so its closer is the first
    // `        }),` at that exact depth.
    const end = body.indexOf('\n        }),');
    expect(end, 'the keyActions literal has no closing "}),"').toBeGreaterThan(-1);
    return body.slice(0, end);
}

/** Every action the registry wires, in source order. */
function wiredActions(): string[] {
    const body = registrySource();
    const wired: string[] = [];
    for (const line of body.split('\n')) {
        // Keys sit at 12 spaces — the literal's own level. Anything deeper belongs to a nested
        // handler body and is not a registry entry.
        const key = /^ {12}([a-z][a-z0-9_]*):/.exec(line);
        if (key !== null) {
            wired.push(key[1] as string);
            continue;
        }
        // The nine `switch_to_workspace_N` handlers are built by a helper, not spelled out.
        if (/^ {12}\.\.\.workspaceSwitchHandlers\(/.test(line)) {
            for (let index = 1; index <= 9; index += 1) wired.push(`switch_to_workspace_${String(index)}`);
        }
    }
    return wired;
}

describe('App.tsx key-action registry', () => {
    it('wires every action in NEX_ACTIONS', () => {
        const wired = new Set(wiredActions());
        const missing = NEX_ACTIONS.filter((action: NexAction) => !wired.has(action));
        expect(
            missing,
            `these actions are bindable and would do nothing when pressed: ${missing.join(', ')}`
        ).toEqual([]);
    });

    it('wires nothing that is not an action', () => {
        // A typo'd key is a silently dead entry — it type-checks as an excess property only
        // because `KeyActionRegistry` is a `Partial<Record<…>>` keyed by a union, and an
        // object literal with an unknown key is caught by TS *today* but not by a spread or a
        // computed key, which is how the registry acquires entries in practice.
        const catalogued = new Set<string>(NEX_ACTIONS);
        const stray = wiredActions().filter((action) => !catalogued.has(action));
        expect(stray, `not bindable actions: ${stray.join(', ')}`).toEqual([]);
    });

    it('wires each action exactly once', () => {
        const wired = wiredActions();
        const seen = new Set<string>();
        const duplicates = wired.filter((action) => !seen.add(action));
        // A second entry for the same action silently wins over the first — a real hazard in a
        // 51-entry literal grouped by feature area.
        expect(duplicates, `duplicated registry entries: ${duplicates.join(', ')}`).toEqual([]);
    });

    it('parses the registry it claims to (guard against a silently empty parse)', () => {
        // Without this, a reformat that broke the regex would make every assertion above pass
        // vacuously — the failure mode the smoke-contract test guards the same way.
        expect(wiredActions()).toHaveLength(NEX_ACTIONS.length);
        expect(NEX_ACTIONS).toHaveLength(51);
    });
});

/**
 * The merge engine, against goldens produced by the REAL Swift-era `merge_hooks.py`
 * (`../../tests/fixtures/hooks/`, regenerable with its `generate.sh`).
 *
 * Every case here is a situation a user is actually in when they run the installer — a fresh
 * machine, a config full of their own hooks, a pre-v0.19 install with absolute paths and a
 * `"startup"` matcher — and the assertion is byte equality with what the Python wrote. That is
 * the only claim worth making about a port of a merge algorithm: not "it looks right", but
 * "same input, same bytes".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseJsonObject, type JsonObject } from '../json.js';
import { baseCommand, mergeHooks, kelpiInvocationPattern, renderHookFile } from './merge.js';
import { CLAUDE_HOOK_WIRINGS, CODEX_HOOK_WIRINGS, canonicalBases, hookPayload } from './spec.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'hooks');

function fixture(name: string): string {
    return fs.readFileSync(path.join(fixtures, name), 'utf8');
}

function parse(name: string): JsonObject {
    const parsed = parseJsonObject(fixture(name));
    if (parsed === null) throw new Error(`fixture ${name} is not a JSON object`);
    return parsed;
}

const claudePayload = hookPayload(CLAUDE_HOOK_WIRINGS, 'kelpi');
const claudeBases = canonicalBases(CLAUDE_HOOK_WIRINGS);
const codexPayload = hookPayload(CODEX_HOOK_WIRINGS, 'kelpi');
const codexBases = canonicalBases(CODEX_HOOK_WIRINGS);

function installClaude(settings: JsonObject): string {
    return renderHookFile(mergeHooks(settings, claudePayload, claudeBases));
}

describe('baseCommand', () => {
    it('is the prefix before the first " --", trimmed', () => {
        expect(baseCommand('kelpi event stop')).toBe('kelpi event stop');
        expect(baseCommand('kelpi event stop --agent codex')).toBe('kelpi event stop');
        expect(baseCommand('/Applications/Nex.app/Contents/Helpers/nex event start  ')).toBe(
            '/Applications/Nex.app/Contents/Helpers/nex event start'
        );
        // A `-x` short flag is NOT a boundary — only the literal " --" is.
        expect(baseCommand('kelpi event stop -v')).toBe('kelpi event stop -v');
    });
});

describe('against the Python goldens', () => {
    it('creates a fresh Claude settings.json byte-for-byte', () => {
        expect(installClaude({})).toBe(fixture('expected-claude-fresh.json'));
    });

    it('creates a fresh Codex hooks.json byte-for-byte', () => {
        expect(renderHookFile(mergeHooks({}, codexPayload, codexBases))).toBe(fixture('expected-codex-fresh.json'));
    });

    it('is idempotent: a re-run over its own output changes nothing', () => {
        const once = installClaude({});
        const twice = installClaude(parse('expected-claude-fresh.json'));
        expect(twice).toBe(once);
        expect(twice).toBe(fixture('expected-claude-rerun.json'));
    });

    it('preserves the user\'s own hooks and appends a matcher-less kelpi group', () => {
        const merged = installClaude(parse('input-claude-usermerge.json'));
        expect(merged).toBe(fixture('expected-claude-usermerge.json'));
        // Spelled out, because these are the two halves of the trade-off:
        expect(merged).toContain('"command": "say done"'); // unrelated user hook survives
        expect(merged).toContain('"command": "~/.claude/audit.sh"'); // unrelated event untouched
        expect(merged).not.toContain('notify.sh'); // composite embedding a kelpi base is swept
        expect(merged).toContain('"model": "opus"'); // non-hook settings untouched
    });

    it('migrates a pre-v0.19 install: absolute paths swept, "startup" matcher normalised', () => {
        const before = fixture('input-claude-stale.json');
        expect(before).toContain('"matcher": "startup"');
        expect(before).toContain('/Applications/Nex.app/Contents/Helpers/nex event stop');

        const merged = installClaude(parse('input-claude-stale.json'));
        expect(merged).toBe(fixture('expected-claude-stale-migrated.json'));
        expect(merged).not.toContain('startup'); // SessionStart now fires for resume/clear/compact
        expect(merged).not.toContain('/Applications/Nex.app'); // no double-firing absolute variant
        // The event the old installer never wrote is appended at the END of the map.
        expect(Object.keys(JSON.parse(merged).hooks)).toEqual([
            'Stop',
            'Notification',
            'SessionStart',
            'UserPromptSubmit',
            'SessionEnd'
        ]);
    });

    it('dedupes a bare claude command and a stale matcher out of the Codex file', () => {
        const merged = renderHookFile(mergeHooks(parse('input-codex-stale.json'), codexPayload, codexBases));
        expect(merged).toBe(fixture('expected-codex-stale-migrated.json'));
        // The hand-wired `kelpi event stop` (no --agent) shared the base, so it was replaced
        // rather than left to double-fire alongside the codex-flagged one.
        expect(merged.match(/kelpi event stop/g)).toHaveLength(1);
        expect(merged).toContain('kelpi event stop --agent codex');
    });
});

describe('kelpiInvocationPattern', () => {
    const stop = kelpiInvocationPattern('kelpi event stop');

    it('recognises every shape the CLI can be invoked as', () => {
        expect(stop).not.toBeNull();
        for (const command of [
            'kelpi event stop',
            '/usr/local/bin/kelpi event stop',
            '/Applications/Nex.app/Contents/Helpers/nex event stop',
            '/Users/x/new_nex/packages/cli/dist/kelpi.js event stop',
            "'/Users/x/my apps/Kelpi.app/Contents/Resources/cli/kelpi' event stop",
            'node /opt/kelpi/dist/kelpi.mjs event stop',
            'notify.sh && kelpi event stop'
        ]) {
            expect(stop?.test(command), command).toBe(true);
        }
    });

    it('does not claim someone else\'s command', () => {
        for (const command of [
            'annex event stop', // a different binary that merely ends in "kelpi"
            'kelpi event start', // a different verb
            'kelpi-helper event stop',
            'echo kelpi event stopped'
        ]) {
            expect(stop?.test(command), command).toBe(false);
        }
    });

    it('has no pattern for a command that is not a kelpi event invocation', () => {
        expect(kelpiInvocationPattern('say done')).toBeNull();
    });
});

describe('absolute-path command prefixes', () => {
    const absolute = '/Users/dev/new_nex/packages/cli/dist/kelpi.js';

    it('sweeps a bare install written by the old script (extraBases, both directions)', () => {
        const payload = hookPayload(CLAUDE_HOOK_WIRINGS, absolute);
        const merged = renderHookFile(mergeHooks(parse('expected-claude-fresh.json'), payload, claudeBases));
        const hooks = JSON.parse(merged).hooks as Record<string, { hooks: { command: string }[] }[]>;
        for (const wiring of CLAUDE_HOOK_WIRINGS) {
            const commands = (hooks[wiring.event] ?? []).flatMap((group) => group.hooks.map((h) => h.command));
            expect(commands).toEqual([`${absolute} event ${wiring.verb}`]);
        }
    });

    it('and the reverse: a bare re-install sweeps the absolute variant', () => {
        const payload = hookPayload(CLAUDE_HOOK_WIRINGS, absolute);
        const withAbsolute = mergeHooks({}, payload, claudeBases);
        const merged = installClaude(withAbsolute);
        expect(merged).toBe(fixture('expected-claude-fresh.json'));
    });
});

describe('malformed and hostile shapes', () => {
    it('leaves a non-object group alone instead of destroying it', () => {
        const settings: JsonObject = { hooks: { Stop: ['nonsense'] } };
        const merged = JSON.parse(installClaude(settings));
        expect(merged.hooks.Stop[0]).toBe('nonsense');
        expect(merged.hooks.Stop[1].hooks[0].command).toBe('kelpi event stop');
    });

    it('replaces a non-object `hooks` value rather than merging into it', () => {
        const settings: JsonObject = { hooks: 'nope' };
        expect(JSON.parse(installClaude(settings)).hooks.Stop).toHaveLength(1);
    });

    it('prunes a group whose hooks list empties, and one that never had a list', () => {
        const settings: JsonObject = {
            hooks: {
                Stop: [
                    { matcher: 'startup', hooks: [{ type: 'command', command: 'kelpi event stop' }] },
                    { matcher: 'other' }
                ]
            }
        };
        const merged = JSON.parse(installClaude(settings));
        expect(merged.hooks.Stop).toHaveLength(1);
        expect(merged.hooks.Stop[0].matcher).toBeUndefined();
    });

    it('joins an existing matcher-less group rather than adding a second one', () => {
        const settings: JsonObject = {
            hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }
        };
        const merged = JSON.parse(installClaude(settings));
        expect(merged.hooks.Stop).toHaveLength(1);
        expect(merged.hooks.Stop[0].hooks.map((h: { command: string }) => h.command)).toEqual([
            'say done',
            'kelpi event stop'
        ]);
    });

    it('does not alias the incoming payload (a second merge cannot corrupt the first)', () => {
        const first = JSON.parse(installClaude({}));
        first.hooks.Stop[0].hooks[0].command = 'tampered';
        expect(installClaude({})).toBe(fixture('expected-claude-fresh.json'));
    });
});

/**
 * The hook-config deep merge — a line-by-line port of the Swift era's `scripts/merge_hooks.py`
 * (CLI-148, CLI-149).
 *
 * Claude Code's `settings.json` and Codex CLI's `hooks.json` share one three-level shape:
 *
 *     { "hooks": { "<Event>": [ { "matcher"?: string, "hooks": [ {type, command}, … ] }, … ] } }
 *
 * so one merge serves both files. Three behaviours are the whole contract, and each exists
 * because of a failure someone actually hit:
 *
 *  1. **Unrelated user hooks survive.** The installer is re-run as the repair path `nex doctor`
 *     suggests, so it must never be a config rewrite.
 *  2. **nex-managed commands are deduped by their flag-less base** — everything before the first
 *     ` --`. Any existing command *containing* that base is removed, which is what makes
 *     `/Applications/Nex.app/Contents/Helpers/nex event stop` (the old absolute-path install),
 *     a bare `nex event stop`, and `nex event stop --agent codex` all one identity instead of
 *     three hooks that double-fire on every turn.
 *  3. **Groups are matched by matcher.** An incoming matcher-less group joins an existing
 *     matcher-less group; a *stale* group (the pre-v0.19 `"matcher": "startup"` SessionStart)
 *     loses its nex command in step 2, empties, gets pruned, and the matcher-less replacement is
 *     appended — which is exactly how issue #181 heals on a re-run.
 *
 * The documented trade-off comes with it: a *composite* user command that embeds a nex base
 * (`notify.sh && nex event stop`) is swept from that event too. Keeping it would double-fire the
 * nex event, which is the worse failure mode. `merge_hooks.py` says so in its docstring and the
 * port keeps the behaviour rather than "improving" it into a wire difference.
 *
 * Port deviation (deliberate, and the reason `extraBases` exists): the Swift installer always
 * wrote a bare `nex`, so the incoming command's own base was a sufficient dedupe identity. This
 * CLI may write an ABSOLUTE path (a dev checkout, or an app bundle that is not on `PATH`), whose
 * base — `/Users/x/nex.js event stop` — is not a substring of the bare `nex event stop` an older
 * installer left behind. Passing the canonical bare bases as `extraBases` restores the sweep in
 * both directions. With a bare command prefix the two sets are identical and the behaviour is
 * byte-for-byte the Python's.
 *
 * Everything here is pure: JSON in, JSON out, no filesystem. `./hooks.ts` owns the IO.
 */

import type { JsonObject, JsonValue } from '../json.js';

/** `merge_hooks.py`'s `base_command`: the prefix before the first ` --`, trimmed. */
export function baseCommand(command: string): string {
    return (command.split(' --')[0] ?? '').trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The second half of the dedupe identity, and the reason it exists.
 *
 * The Python's substring sweep worked because every path it had to recognise ended in `/nex`, so
 * the bare base `nex event stop` was literally inside `/Applications/Nex.app/Contents/Helpers/nex
 * event stop`. This CLI's bundle is `dist/nex.js`, and `nex.js event stop` does **not** contain
 * `nex event stop` — a substring-only sweep would leave the old hook in place beside the new one
 * and every agent turn would fire twice.
 *
 * So each incoming command also contributes a structural pattern derived from its own trailing
 * `event <verb>`: "a token whose basename is `nex` (optionally `.js`/`.mjs`/`.cjs`, optionally
 * quoted), followed by `event <that verb>` at the end of the base". It recognises a bare `nex`,
 * any absolute path, a `node …/nex.js` invocation and the `notify.sh && nex event stop` composite
 * alike — and it is used in UNION with the Python's substring test, never instead of it, so the
 * sweep is always a superset of what the shell installer did.
 */
export function nexInvocationPattern(base: string): RegExp | null {
    const match = /\bevent\s+([A-Za-z0-9._-]+)$/.exec(base);
    const verb = match?.[1];
    if (verb === undefined) return null;
    return new RegExp(`(^|[\\s/'"])nex(\\.[cm]?js)?['"]?\\s+event\\s+${escapeRegExp(verb)}$`);
}

function isObject(value: JsonValue | undefined): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural clone, so a merged result never aliases the caller's incoming template. */
function clone<T extends JsonValue>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** Python's `g.get("matcher") == new_matcher`, with absent and `null` reading the same. */
function sameMatcher(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The command strings a group would run — non-command entries read as absent. */
function commandOf(hook: JsonValue): string | null {
    if (!isObject(hook)) return null;
    if (hook['type'] !== 'command') return null;
    const command = hook['command'];
    return typeof command === 'string' ? command : null;
}

/**
 * Merge `newHooks` (an event → groups map) into `settings`, in place, and return `settings`.
 *
 * `settings` is mutated exactly like the Python's dict is, including `setdefault` semantics:
 * a missing `hooks` key is created, and a missing event key is appended to the END of the map,
 * so key order in the written file matches what the shell installer produced.
 */
export function mergeHooks(
    settings: JsonObject,
    newHooks: JsonObject,
    extraBases: readonly string[] = []
): JsonObject {
    const existingHooks = settings['hooks'];
    const hooks: JsonObject = isObject(existingHooks) ? existingHooks : {};
    settings['hooks'] = hooks;

    for (const [event, incoming] of Object.entries(newHooks)) {
        if (!Array.isArray(incoming)) continue;
        const current = hooks[event];
        const groups: JsonValue[] = Array.isArray(current) ? current : [];
        hooks[event] = groups;

        for (const rawGroup of incoming) {
            if (!isObject(rawGroup)) continue;
            const newMatcher = rawGroup['matcher'];
            const newInner = Array.isArray(rawGroup['hooks']) ? rawGroup['hooks'] : [];

            const bases = new Set<string>(extraBases.filter((base) => base.length > 0));
            const patterns: RegExp[] = [];
            for (const hook of newInner) {
                const command = commandOf(hook);
                if (command === null || command.length === 0) continue;
                const base = baseCommand(command);
                bases.add(base);
                const pattern = nexInvocationPattern(base);
                if (pattern !== null) patterns.push(pattern);
            }
            const isNexManaged = (command: string | null): boolean => {
                if (command === null) return false;
                if ([...bases].some((base) => command.includes(base))) return true;
                const base = baseCommand(command);
                return patterns.some((pattern) => pattern.test(base));
            };

            // Sweep every group of this event, then drop the ones that emptied. A group entry
            // that is not an object is left untouched: the Python would have raised on it, so
            // there is no behaviour to match, and preserving unknown data beats deleting it.
            for (const group of groups) {
                if (!isObject(group)) continue;
                const inner = group['hooks'];
                group['hooks'] = (Array.isArray(inner) ? inner : []).filter(
                    (hook) => !isNexManaged(commandOf(hook))
                );
            }
            const kept = groups.filter((group) => {
                if (!isObject(group)) return true;
                const inner = group['hooks'];
                return Array.isArray(inner) && inner.length > 0;
            });
            groups.splice(0, groups.length, ...kept);

            const target = groups.find((group) => isObject(group) && sameMatcher(group['matcher'], newMatcher));
            if (target !== undefined && isObject(target) && Array.isArray(target['hooks'])) {
                (target['hooks'] as JsonValue[]).push(...clone(newInner));
            } else {
                groups.push(clone(rawGroup));
            }
        }
    }

    return settings;
}

/** `json.dump(data, f, indent=2)` + a trailing newline — byte-identical to the Python's write. */
export function renderHookFile(settings: JsonObject): string {
    return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * WHICH hooks get installed — the single table `nex install-hooks` writes and `nex doctor`
 * checks (AGNT-123, AGNT-124).
 *
 * Order is contract, not taste: it is the order the Swift `install-hooks.sh` heredocs listed,
 * and JSON object key order is insertion order, so keeping it means a file this CLI creates on
 * a fresh machine is **byte-identical** to the one the shell script produced (with the same
 * command prefix). `tests/install-hooks.test.ts` asserts exactly that against fixtures generated
 * by running the real `scripts/install-hooks.sh` / `merge_hooks.py`.
 *
 * Codex differences are not omissions: Codex CLI has **no** `SessionEnd` and **no**
 * `Notification` event, so it gets four hooks and `PermissionRequest` — its "waiting on
 * approval" signal — carries the notification. Every Codex command takes `--agent codex`, which
 * is what makes `Pane.agentKind` label the badge "codex" and pick `codex resume` over
 * `claude --resume` (issue #101).
 */

import type { JsonObject, JsonValue } from '../json.js';

export interface HookWiring {
    /** The event name as the agent CLI spells it. */
    readonly event: string;
    /** The `nex event <verb>` this event fires. */
    readonly verb: string;
    /** `--agent codex`, or nothing for Claude Code (absent = claude on the wire). */
    readonly agent?: 'codex';
}

/** The five Claude Code hooks, in `install-hooks.sh`'s order. */
export const CLAUDE_HOOK_WIRINGS: readonly HookWiring[] = [
    { event: 'Stop', verb: 'stop' },
    { event: 'Notification', verb: 'notification' },
    { event: 'SessionStart', verb: 'session-start' },
    { event: 'SessionEnd', verb: 'session-end' },
    { event: 'UserPromptSubmit', verb: 'start' }
];

/** The four Codex CLI hooks, in `install-hooks.sh`'s order. */
export const CODEX_HOOK_WIRINGS: readonly HookWiring[] = [
    { event: 'Stop', verb: 'stop', agent: 'codex' },
    { event: 'PermissionRequest', verb: 'notification', agent: 'codex' },
    { event: 'SessionStart', verb: 'session-start', agent: 'codex' },
    { event: 'UserPromptSubmit', verb: 'start', agent: 'codex' }
];

/** `<prefix> event stop [--agent codex]`. */
export function hookCommand(wiring: HookWiring, commandPrefix: string): string {
    const agent = wiring.agent === undefined ? '' : ` --agent ${wiring.agent}`;
    return `${commandPrefix} event ${wiring.verb}${agent}`;
}

/**
 * The `hooks` map to merge in: one **matcher-less** group per event.
 *
 * Matcher-less is load-bearing for `SessionStart`. A pre-v0.19 installer wrote
 * `"matcher": "startup"`, which never fires for `claude --continue` / `--resume`, so those
 * sessions never bound a session id (issue #181). No matcher = every source.
 */
export function hookPayload(wirings: readonly HookWiring[], commandPrefix: string): JsonObject {
    const payload: JsonObject = {};
    for (const wiring of wirings) {
        const group: JsonValue = {
            hooks: [{ type: 'command', command: hookCommand(wiring, commandPrefix) }]
        };
        const existing = payload[wiring.event];
        if (Array.isArray(existing)) existing.push(group);
        else payload[wiring.event] = [group];
    }
    return payload;
}

/**
 * The bare `nex event <verb>` bases, handed to the merge as `extraBases`.
 *
 * They are what lets an install whose command prefix is an absolute path still sweep the bare
 * `nex event stop` an older installer wrote (and vice versa) — see `./merge.ts`'s note.
 */
export function canonicalBases(wirings: readonly HookWiring[]): string[] {
    return wirings.map((wiring) => `nex event ${wiring.verb}`);
}

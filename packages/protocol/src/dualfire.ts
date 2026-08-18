/**
 * The `session_id` dual-fire (wire-protocol.md §3.1, port note 7).
 *
 * After a line parses, if the command is neither `session-start` nor `session-end`, and the
 * line carries a valid `pane_id` plus a non-empty `session_id`, the server synthesizes an
 * extra `sessionStarted(paneID, sessionID, agent)` event **after** the primary one. That is
 * how a bare `stop` / `notification` hook keeps the pane's tracked session id fresh.
 * `session-end` is excluded because its whole purpose is to drop the id.
 *
 * Deliberate fix (PLAN.md): the synthesized event never gets a reply handle, even when the
 * primary command is allowlisted — the Swift server allocates a second, never-answered
 * handle there.
 */

import { isReplyCommand } from './allowlist.js';
import type { WireDecodeSuccess } from './wire/decode.js';
import type { WireCommandName, WireMessage } from './wire/messages.js';
import type { AgentKind } from './wire/vocab.js';

export interface SynthesizedSessionStart {
    readonly kind: 'session-start-dualfire';
    /** The original wire command name the event was synthesized from (allowlist tagging). */
    readonly source_command: WireCommandName;
    readonly pane_id: string;
    readonly session_id: string;
    readonly agent: AgentKind;
}

const DUAL_FIRE_EXCLUDED: ReadonlySet<WireCommandName> = new Set(['session-start', 'session-end']);

/** Returns the synthesized session-start event for a decoded line, when the rule applies. */
export function synthesizeSessionStart(decoded: WireDecodeSuccess): SynthesizedSessionStart | undefined {
    const command = decoded.message.command;
    if (DUAL_FIRE_EXCLUDED.has(command)) return undefined;
    const paneId = decoded.hook.pane_id;
    const sessionId = decoded.hook.session_id;
    if (paneId === undefined || sessionId === undefined || sessionId.length === 0) return undefined;
    return {
        kind: 'session-start-dualfire',
        source_command: command,
        pane_id: paneId,
        session_id: sessionId,
        agent: decoded.hook.agent
    };
}

export type WireDispatchItem =
    | { readonly kind: 'message'; readonly message: WireMessage; readonly reply: boolean }
    | { readonly kind: 'session-start-dualfire'; readonly event: SynthesizedSessionStart; readonly reply: false };

/**
 * The ordered dispatch sequence for one decoded line: the primary message first, then the
 * synthesized session-start (never with a reply handle).
 */
export function dispatchSequence(decoded: WireDecodeSuccess): readonly WireDispatchItem[] {
    const primary: WireDispatchItem = {
        kind: 'message',
        message: decoded.message,
        reply: isReplyCommand(decoded.message.command)
    };
    const dualFire = synthesizeSessionStart(decoded);
    return dualFire === undefined
        ? [primary]
        : [primary, { kind: 'session-start-dualfire', event: dualFire, reply: false }];
}

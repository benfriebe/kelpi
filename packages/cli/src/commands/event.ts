/**
 * `kelpi event …` — the Claude Code / Codex hook entrypoint (cli.md §8).
 *
 * Three invariants this path must never break, because it fires on every agent turn on
 * machines where Kelpi may not even be running:
 *   - exit 0 on every transport problem, with warnings suppressed unless `KELPI_VERBOSE_HOOKS`;
 *   - silent exit 0 when `KELPI_PANE_ID` is unset (running outside a pane is not an error);
 *   - a typo'd `--agent` is LOUD (exit 1) — a silently-degraded agent kind is worse than a
 *     visible failure, because it would mislabel the pane and pick the wrong resume command.
 *
 * `background_tasks` (issues #215/#220) is an *observed*, undocumented Claude Code field, so
 * the counting is terminal-status EXCLUSION rather than a `status == "running"` match: a
 * future release that renames the active state would otherwise silently re-introduce the
 * flip-to-waiting bug the field exists to fix.
 *
 * `permission-request` (#388) is the one verb that waits for a reply and prints to stdout;
 * the invariants above still hold for it, and it adds a 3.5 s ceiling on its own runtime.
 */

import fs from 'node:fs';

import { parseFlag } from '../args.js';
import { profileName, requirePaneID, silentRequested, verboseHooksRequested } from '../env.js';
import { errLine, exit, printLine } from '../io.js';
import { asString, parseJsonObject, type JsonObject, type JsonValue } from '../json.js';
import {
    handleFireAndForgetTransportFailure,
    sendJSON,
    sendJSONAndReadReply,
    setSuppressFireAndForgetWarnings
} from '../transport.js';

const VALID_EVENTS = new Set([
    'stop',
    'start',
    'error',
    'notification',
    'session-start',
    'session-end',
    'permission-request'
]);
const VALID_AGENTS = new Set(['claude', 'codex']);

/** A background unit that declares one of these is finished; anything else is in flight. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
    'completed',
    'complete',
    'done',
    'success',
    'succeeded',
    'failed',
    'failure',
    'error',
    'errored',
    'cancelled',
    'canceled',
    'killed',
    'stopped',
    'timeout',
    'timed_out',
    'aborted',
    'skipped'
]);

/**
 * Count in-flight background units. A non-array, or an array of non-objects, counts 0 — the
 * defensive guard that keeps a renamed/misshaped field on legacy behavior.
 */
export function countBackgroundTasks(value: JsonValue | undefined): number {
    if (!Array.isArray(value)) return 0;
    let count = 0;
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
        const status = (entry as JsonObject)['status'];
        if (typeof status !== 'string') {
            count += 1; // no status key ⇒ presence implies in-flight
            continue;
        }
        if (!TERMINAL_TASK_STATUSES.has(status.toLowerCase())) count += 1;
    }
    return count;
}

/**
 * The `last_assistant_message` cap (#387), in UTF-8 bytes. Even escaped six-fold as JSON it
 * stays far below the 64 MB request line limit (wire-protocol.md §2.1).
 */
export const ASSISTANT_MESSAGE_MAX_BYTES = 64 * 1024;

/**
 * Cut `text` to at most `maxBytes` of UTF-8, on a code point boundary so a surrogate pair is
 * never split. `truncated` is true only when something was cut.
 */
export function capAssistantMessage(
    text: string,
    maxBytes: number = ASSISTANT_MESSAGE_MAX_BYTES
): { text: string; truncated: boolean } {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
    let bytes = 0;
    let end = 0;
    for (const char of text) {
        const point = char.codePointAt(0) ?? 0;
        // A lone surrogate counts 3, as the UTF-8 encoder writes it as U+FFFD.
        const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
        if (bytes + size > maxBytes) break;
        bytes += size;
        end += char.length;
    }
    return { text: text.slice(0, end), truncated: true };
}

/** The verbs that carry the hook's `transcript_path` on the wire (#387). */
const TRANSCRIPT_EVENTS = new Set(['notification', 'stop', 'session-start']);

/**
 * The hook fields a plugin acts on (#387), each only when stdin carries it as a non-empty
 * string, so a payload without them stays wire-identical to the older CLI. Codex sends the
 * same keys when it sends them at all; `tool_name` comes from its PermissionRequest, which
 * is wired to `notification --agent codex`.
 */
export function agentHookFields(eventType: string, agent: string | null, json: JsonObject): JsonObject {
    const nonEmpty = (key: string): string | undefined => {
        const value = asString(json[key]);
        return value !== undefined && value.length > 0 ? value : undefined;
    };
    const fields: JsonObject = {};
    if (eventType === 'notification') {
        const notificationType = nonEmpty('notification_type');
        if (notificationType !== undefined) fields['notification_type'] = notificationType;
        const toolName = agent === 'codex' ? nonEmpty('tool_name') : undefined;
        if (toolName !== undefined) fields['tool_name'] = toolName;
    }
    if (eventType === 'stop') {
        const lastAssistantMessage = nonEmpty('last_assistant_message');
        if (lastAssistantMessage !== undefined) {
            const capped = capAssistantMessage(lastAssistantMessage);
            fields['last_assistant_message'] = capped.text;
            if (capped.truncated) fields['last_assistant_message_truncated'] = true;
        }
    }
    const transcriptPath = nonEmpty('transcript_path');
    if (transcriptPath !== undefined && TRANSCRIPT_EVENTS.has(eventType)) fields['transcript_path'] = transcriptPath;
    return fields;
}

/** The hook payload Claude Code / Codex pipe on stdin; absent or unparseable reads as null. */
export function readStdinJSON(): JsonObject | null {
    if (process.stdin.isTTY === true) return null;
    let raw = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            raw = fs.readFileSync(0, 'utf8');
            break;
        } catch (error) {
            // A non-blocking stdin can answer EAGAIN before the writer's first flush.
            if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') return null;
            const buffer = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(buffer, 0, 0, 10);
        }
    }
    if (raw.length === 0) return null;
    return parseJsonObject(raw);
}

/** The read timeout on the daemon's reply, in seconds; its provider deadline is about 2 s. */
export const PERMISSION_REPLY_TIMEOUT_SECONDS = 3;

/**
 * The hard ceiling on `kelpi event permission-request`, from start to exit. Claude keeps the
 * hook running after the user answers, and a late "allow" would dismiss a prompt the user is
 * already reading, so the verb bounds its own runtime instead of trusting the transport's
 * timers (a refused pane route alone is retried for 5 s).
 */
export const PERMISSION_GUARD_MS = 3500;

/** The stdin strings the request forwards, each only when non-empty. */
const PERMISSION_REQUEST_FIELDS = ['mcp_server', 'cwd', 'permission_mode', 'session_id'] as const;

/**
 * The `permission-request` wire request built from Claude's PermissionRequest stdin (#388), or
 * null when stdin names no tool, in which case nothing is sent. Only the documented fields
 * travel: `permission_suggestions` and the other session fields Claude adds stay behind.
 */
export function permissionRequestPayload(paneID: string, json: JsonObject | null): JsonObject | null {
    if (json === null) return null;
    const nonEmpty = (key: string): string | undefined => {
        const value = asString(json[key]);
        return value !== undefined && value.length > 0 ? value : undefined;
    };
    const toolName = nonEmpty('tool_name');
    if (toolName === undefined) return null;
    const toolInput = json['tool_input'];
    const payload: JsonObject = {
        command: 'permission-request',
        pane_id: paneID,
        tool_name: toolName,
        tool_input: typeof toolInput === 'object' && toolInput !== null && !Array.isArray(toolInput) ? toolInput : {}
    };
    for (const key of PERMISSION_REQUEST_FIELDS) {
        const value = nonEmpty(key);
        if (value !== undefined) payload[key] = value;
    }
    return payload;
}

/**
 * Claude's PermissionRequest decision JSON for an `ok:true` reply, or null to print nothing.
 * Null covers abstain and any behavior this CLI does not know, because Claude reads a silent
 * exit 0 as "no decision" and shows its own prompt. A deny never sets `interrupt`: that drops
 * the message and looks to Claude like the user pressed Escape.
 */
export function permissionDecisionOutput(reply: JsonObject): string | null {
    const behavior = reply['behavior'];
    if (behavior !== 'allow' && behavior !== 'deny') return null;
    const decision: JsonObject = { behavior };
    const message = asString(reply['message']);
    if (behavior === 'deny' && message !== undefined && message.length > 0) decision['message'] = message;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

/** A `kelpi event` diagnostic: stderr only, and only under `KELPI_VERBOSE_HOOKS`. */
function hookWarning(text: string): void {
    if (verboseHooksRequested() && !silentRequested()) errLine(`Warning: ${text}`);
}

/**
 * `kelpi event permission-request` (#388): the one request/reply verb in the family. It prints
 * Claude's decision on allow or deny and nothing otherwise, so every failure (abstain, an
 * `ok:false`, no daemon, a timeout) fails open to Claude's own prompt and never to "allow".
 */
async function handlePermissionRequest(paneID: string, agent: string | null): Promise<void> {
    const label = 'kelpi event permission-request';
    if (agent === 'codex') {
        hookWarning(`${label}: Codex permission decisions are not supported; nothing was sent.`);
        return;
    }

    // `process.exit`, not io's `exit`: that one is a throw, which from a timer would be an
    // uncaught exception and exit 1. Nothing has been printed yet, so there is nothing for
    // an eager exit to truncate.
    const guard = setTimeout(() => {
        hookWarning(`${label}: no decision within ${String(PERMISSION_GUARD_MS)} ms; leaving the prompt to Claude.`);
        process.exit(0);
    }, PERMISSION_GUARD_MS);
    try {
        const payload = permissionRequestPayload(paneID, readStdinJSON());
        if (payload === null) return;

        const data = await sendJSONAndReadReply(payload, { timeoutSeconds: PERMISSION_REPLY_TIMEOUT_SECONDS });
        if (data === null) handleFireAndForgetTransportFailure(label);
        if (data.length === 0) {
            hookWarning(`${label}: no response from Kelpi (upgrade required?)`);
            return;
        }
        const reply = parseJsonObject(data);
        if (reply === null) {
            hookWarning(`${label}: invalid JSON response`);
            return;
        }
        if (reply['ok'] !== true) {
            hookWarning(`${label}: ${asString(reply['error']) ?? 'unknown error'}`);
            return;
        }
        const output = permissionDecisionOutput(reply);
        if (output !== null) printLine(output);
    } finally {
        clearTimeout(guard);
    }
}

export async function handleEvent(args: string[]): Promise<void> {
    if (!verboseHooksRequested()) setSuppressFireAndForgetWarnings(true);

    const eventType = args.shift();
    if (eventType === undefined) {
        errLine(
            'Usage: kelpi event stop|start|error|notification|session-start|session-end|permission-request [--agent claude|codex] [--message ...] [--title ...] [--body ...]'
        );
        exit(1);
    }
    if (!VALID_EVENTS.has(eventType)) {
        errLine(`Unknown event type: ${eventType}`);
        errLine('Valid events: stop, start, error, notification, session-start, session-end, permission-request');
        exit(1);
    }

    const paneID = requirePaneID();

    const message = parseFlag('--message', args);
    let title = parseFlag('--title', args);
    let body = parseFlag('--body', args);
    const agent = parseFlag('--agent', args);
    if (agent !== null && !VALID_AGENTS.has(agent)) {
        errLine(`Unknown --agent value: ${agent} (valid: claude, codex)`);
        exit(1);
    }

    if (eventType === 'permission-request') {
        await handlePermissionRequest(paneID, agent);
        return;
    }

    const stdinJSON = readStdinJSON();

    if (eventType === 'notification') {
        if (agent === 'codex') {
            // Codex has no Notification hook; PermissionRequest is wired here instead, and it
            // carries `tool_name` rather than a message. Works with no stdin at all.
            const json = stdinJSON ?? {};
            title ??= asString(json['title']) ?? 'Codex';
            if (body === null) {
                const stdinMessage = asString(json['message']);
                const tool = asString(json['tool_name']);
                if (stdinMessage !== undefined) body = stdinMessage;
                else if (tool !== undefined && tool.length > 0) body = `Approval requested: ${tool}`;
                else body = 'Waiting for approval';
            }
        } else if (stdinJSON !== null) {
            // Guarded on stdin actually carrying JSON: a manual `kelpi event notification
            // --body x` must keep omitting the title so the server renders its neutral
            // "Agent" default.
            title ??= asString(stdinJSON['title']) ?? 'Claude Code';
            body ??= asString(stdinJSON['message']) ?? null;
        }
    }

    // Sub-agent lifecycle must not touch the pane indicator (the root agent omits agent_id).
    const agentID = stdinJSON === null ? undefined : asString(stdinJSON['agent_id']);
    if (agentID !== undefined && agentID.length > 0 && (eventType === 'stop' || eventType === 'start')) {
        return;
    }

    const sessionID = stdinJSON === null ? undefined : asString(stdinJSON['session_id']);

    let backgroundTaskCount = 0;
    if ((eventType === 'stop' || eventType === 'notification') && stdinJSON !== null) {
        backgroundTaskCount = countBackgroundTasks(stdinJSON['background_tasks']);
    }

    const payload: JsonObject = { command: eventType, pane_id: paneID };
    if (message !== null) payload['message'] = message;
    if (title !== null && title !== undefined) payload['title'] = title;
    if (body !== null && body !== undefined) payload['body'] = body;
    if (sessionID !== undefined) payload['session_id'] = sessionID;
    // Whenever a session id is being bound (directly or via the dual-fire), report the
    // profile this hook is running under, so a later resume rebuilds the same environment.
    // `session-end` drops the id, so the profile would be dead weight there.
    if (sessionID !== undefined && eventType !== 'session-end') {
        const profile = profileName();
        if (profile !== undefined) payload['profile'] = profile;
    }
    // Absent means claude server-side, keeping the common Claude-hook path wire-identical.
    if (agent !== null) payload['agent'] = agent;
    // Only when non-zero, so the common no-background path is wire-identical to pre-#215.
    if (backgroundTaskCount > 0) payload['background_tasks'] = backgroundTaskCount;
    // #387: only the hook fields stdin actually carried, so a manual call is unchanged.
    if (stdinJSON !== null) Object.assign(payload, agentHookFields(eventType, agent, stdinJSON));

    await sendJSON(payload, `kelpi event ${eventType}`);
}

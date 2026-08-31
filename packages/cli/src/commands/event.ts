/**
 * `kelpi event …` — the Claude Code / Codex hook entrypoint (cli.md §8).
 *
 * Three invariants this path must never break, because it fires on every agent turn on
 * machines where Kelpi may not even be running:
 *   - exit 0 on every transport problem, with warnings suppressed unless `KELPI_VERBOSE_HOOKS`;
 *   - silent exit 0 when `NEX_PANE_ID` is unset (running outside a pane is not an error);
 *   - a typo'd `--agent` is LOUD (exit 1) — a silently-degraded agent kind is worse than a
 *     visible failure, because it would mislabel the pane and pick the wrong resume command.
 *
 * `background_tasks` (issues #215/#220) is an *observed*, undocumented Claude Code field, so
 * the counting is terminal-status EXCLUSION rather than a `status == "running"` match: a
 * future release that renames the active state would otherwise silently re-introduce the
 * flip-to-waiting bug the field exists to fix.
 */

import fs from 'node:fs';

import { parseFlag } from '../args.js';
import { profileName, requirePaneID, verboseHooksRequested } from '../env.js';
import { errLine, exit } from '../io.js';
import { asString, parseJsonObject, type JsonObject, type JsonValue } from '../json.js';
import { sendJSON, setSuppressFireAndForgetWarnings } from '../transport.js';

const VALID_EVENTS = new Set(['stop', 'start', 'error', 'notification', 'session-start', 'session-end']);
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

export async function handleEvent(args: string[]): Promise<void> {
    if (!verboseHooksRequested()) setSuppressFireAndForgetWarnings(true);

    const eventType = args.shift();
    if (eventType === undefined) {
        errLine(
            'Usage: kelpi event stop|start|error|notification|session-start|session-end [--agent claude|codex] [--message ...] [--title ...] [--body ...]'
        );
        exit(1);
    }
    if (!VALID_EVENTS.has(eventType)) {
        errLine(`Unknown event type: ${eventType}`);
        errLine('Valid events: stop, start, error, notification, session-start, session-end');
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

    await sendJSON(payload, `kelpi event ${eventType}`);
}

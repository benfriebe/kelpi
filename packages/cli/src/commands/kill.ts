/**
 * `kelpi kill` (cli.md "Running services", docs/running-services.md §6): stop a service `kelpi ps`
 * lists, by port or by id. A pane's foreground job gets Ctrl-C, a process stack SIGTERM (SIGKILL
 * with `--force`), a compose project Docker's stop. The daemon waits up to 5 s for it to exit and
 * says what is still running.
 *
 * A port names the whole service that listens on it (`:3000` on a turbo stack stops the stack);
 * `--member` narrows it to one process and what runs under it.
 */

import { hasHelpFlag, parseFlag, popSwitch } from '../args.js';
import { replyTimeoutSeconds } from '../env.js';
import { errLine, exit, printLine, writeOut } from '../io.js';
import { asBool, asInt, asString, stableStringify, type JsonObject, type JsonValue } from '../json.js';
import { decodeReply } from '../reply.js';
import { killUsage } from '../usage.js';

/** A scan, a `ps`, the 5 s wait and a Docker stop (up to its own stop timeout) fit in this. */
const KILL_REPLY_TIMEOUT_SECONDS = 60;

/** `:3000` or `3000` is a port; anything else is a service id from `kelpi ps --json`. */
export function parsePortTarget(token: string): number | null {
    const match = /^:?(\d{1,5})$/.exec(token);
    if (match === null) return null;
    const port = Number(match[1]);
    return port >= 1 && port <= 65_535 ? port : null;
}

function processes(count: number): string {
    return `${String(count)} process${count === 1 ? '' : 'es'}`;
}

function containers(count: number): string {
    return `${String(count)} container${count === 1 ? '' : 's'}`;
}

function portsNote(result: JsonObject): string {
    const ports = Array.isArray(result['ports']) ? result['ports'].map((port) => asInt(port)).filter((port) => port !== undefined) : [];
    return ports.length === 0 ? '' : `; port${ports.length === 1 ? '' : 's'} ${ports.join(' ')}`;
}

/** One line per service: what was done, and what is left. */
export function describeStop(result: JsonObject): string {
    const name = asString(result['name']) ?? asString(result['id']) ?? '?';
    const id = asString(result['id']) ?? '';
    const action = asString(result['action']);
    const signalled = asInt(result['signalled']) ?? 0;
    const remaining = Array.isArray(result['remaining']) ? result['remaining'] : null;
    const stopped = asBool(result['stopped']);
    const ports = portsNote(result);
    let line: string;
    if (action === 'interrupt') {
        line =
            remaining === null
                ? `Sent Ctrl-C to the pane running ${name}${ports}.`
                : stopped === true
                  ? `Stopped ${name} with Ctrl-C in its pane${ports}.`
                  : `Sent Ctrl-C to the pane running ${name}; ${processes(remaining.length)} still running after the wait. \`kelpi kill ${id}\` sends SIGTERM next, \`--force\` SIGKILL.`;
    } else if (action === 'stop-containers') {
        const failed = Array.isArray(result['failed']) ? result['failed'].map((entry) => asString(entry) ?? '') : [];
        line =
            remaining === null
                ? `Asked Docker to stop ${name} (${containers(signalled)}${ports}).`
                : failed.length > 0
                  ? `${name}: Docker did not stop ${String(failed.length)} of ${containers(signalled)}: ${failed.join('; ')}`
                  : stopped === true
                    ? `Stopped ${name} (${containers(signalled)}${ports}).`
                    : `${name}: ${containers(remaining.length)} still stopping after the wait.`;
    } else {
        const killed = asString(result['signal']) === 'SIGKILL';
        line =
            remaining === null
                ? `Sent ${killed ? 'SIGKILL' : 'SIGTERM'} to ${name} (${processes(signalled)}${ports}).`
                : stopped === true
                  ? `${killed ? 'Killed' : 'Stopped'} ${name} (${processes(signalled)}${ports}).`
                  : `${name}: ${String(remaining.length)} of ${processes(signalled)} still running after the wait. \`kelpi kill --force ${id}\` ends them.`;
    }
    const skipped = Array.isArray(result['skipped']) ? result['skipped'] : [];
    if (skipped.length > 0) line += ` Left alone: ${skipped.map((pid) => String(pid as JsonValue)).join(' ')} (not yours to stop).`;
    const restartedBy = asString(result['restarted_by']);
    if (restartedBy !== undefined) line += ` Its port is in use again by ${restartedBy}: a supervisor restarted it.`;
    return line;
}

export async function handleKill(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(killUsage);
        exit(0);
    }
    const member = parseFlag('--member', args);
    const force = popSwitch('--force', args);
    const yes = popSwitch('--yes', args);
    const noWait = popSwitch('--no-wait', args);
    const asJSON = popSwitch('--json', args);
    const bad = args.find((token) => token.startsWith('-'));
    if (bad !== undefined) {
        errLine(`kelpi kill: unknown option ${bad}`);
        writeOut(killUsage);
        exit(1);
    }
    if (args.length === 0) {
        errLine('kelpi kill: name a port (:3000) or a service id from `kelpi ps --json`');
        exit(1);
    }
    const ports = args.map(parsePortTarget);
    const port = ports[0];
    if (ports.some((entry) => entry !== null) && args.length > 1) {
        errLine('kelpi kill: give one port, or one or more service ids');
        exit(1);
    }
    if (member !== null && args.length > 1) {
        errLine('kelpi kill: --member takes one service');
        exit(1);
    }

    const payload: JsonObject = { command: 'running-stop' };
    if (port !== null && port !== undefined) payload['port'] = port;
    else payload['ids'] = [...args];
    if (member !== null) payload['member'] = member;
    if (force) payload['force'] = true;
    if (yes) payload['confirmed'] = true;
    if (noWait) payload['wait_ms'] = 0;

    const reply = await decodeReply(payload, 'kelpi kill', {
        timeoutSeconds: Math.max(replyTimeoutSeconds(), KILL_REPLY_TIMEOUT_SECONDS)
    });
    const results = (Array.isArray(reply['results']) ? reply['results'] : []).filter(
        (entry): entry is JsonObject => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    );
    if (asJSON) printLine(stableStringify(results as unknown as JsonValue));
    let failed = false;
    for (const result of results) {
        const error = asString(result['error']);
        if (error !== undefined) {
            failed = true;
            const code = asString(result['code']);
            // D2: stopping someone else's app is the user's call, never an agent's alone.
            const hint = code === 'NEEDS_CONFIRM' ? ' Once the user agrees, run it again with --yes.' : '';
            errLine(`kelpi kill: ${error}.${hint}`);
            continue;
        }
        if (asBool(result['stopped']) === false) failed = true;
        if (!asJSON) printLine(describeStop(result));
    }
    if (failed) exit(1);
}

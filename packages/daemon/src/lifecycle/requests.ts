/**
 * Who asked the daemon to stop or restart (#314).
 *
 * A stop is a SIGTERM from whichever process ran `kelpid stop`, so the daemon itself cannot say
 * who asked. On 2026-10-01 a recalled `kelpid stop` in an idle pane ended every terminal, and the
 * pane, the tty and the time had to be pieced together from `~/.zsh_history`. So the CLI writes
 * one line to `<run dir>/lifecycle.log` BEFORE it signals: the time, the verb, the daemon it is
 * aimed at, and the process, terminal and pane asking.
 *
 * Best-effort throughout. A run dir that cannot be written, or a `ps` that is missing, costs the
 * line, never the stop.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RUN_FILE_MODE } from './rundir.js';

export const LIFECYCLE_LOG_NAME = 'lifecycle.log';
/** The log is a line per stop or restart; past this it is moved to `lifecycle.log.1`. */
export const LIFECYCLE_LOG_MAX_BYTES = 256 * 1024;

export interface LifecycleRequest {
    readonly verb: 'stop' | 'restart';
    /** The daemon being signalled. */
    readonly targetPid: number;
    /** How the request got past the prompt: `confirmed`, `--force`, `not interactive`, `nothing running`. */
    readonly how: string;
}

export interface Requester {
    readonly pid: number;
    readonly ppid: number;
    /** The parent's command name, when `ps` could say. */
    readonly parent?: string | undefined;
    /** `/dev/ttys012`, or undefined with no controlling terminal. */
    readonly tty?: string | undefined;
    /** `KELPI_PANE_ID` when the request came from inside a pane. */
    readonly paneID?: string | undefined;
    /** The command as typed, after the interpreter and script path. */
    readonly argv: readonly string[];
}

/** One `ps` call for this process's tty and its parent's name. Undefined fields when it fails. */
function psFacts(pid: number, ppid: number): { tty?: string; parent?: string } {
    try {
        const out = execFileSync('ps', ['-o', 'pid=,tty=,comm=', '-p', `${String(pid)},${String(ppid)}`], {
            encoding: 'utf8',
            timeout: 1000,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const facts: { tty?: string; parent?: string } = {};
        for (const line of out.split('\n')) {
            const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
            if (match === null) continue;
            const [, rowPid, tty, command] = match;
            if (Number(rowPid) === pid && tty !== undefined && tty !== '??' && tty !== '?') {
                facts.tty = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
            }
            if (Number(rowPid) === ppid && command !== undefined) facts.parent = path.basename(command.trim());
        }
        return facts;
    } catch {
        return {};
    }
}

export function currentRequester(env: NodeJS.ProcessEnv = process.env): Requester {
    const facts = psFacts(process.pid, process.ppid);
    const paneID = env['KELPI_PANE_ID']?.trim();
    return {
        pid: process.pid,
        ppid: process.ppid,
        ...(facts.parent !== undefined ? { parent: facts.parent } : {}),
        ...(facts.tty !== undefined ? { tty: facts.tty } : {}),
        ...(paneID !== undefined && paneID.length > 0 ? { paneID } : {}),
        argv: process.argv.slice(2)
    };
}

/**
 * `2026-10-01T13:21:54.700Z stop of pid 59608 requested by pid 1234 (ppid 1200 zsh, tty
 * /dev/ttys012, pane <uuid>): kelpid stop [confirmed]`
 */
export function lifecycleRequestLine(request: LifecycleRequest, requester: Requester, now: Date): string {
    const facts = [
        `ppid ${String(requester.ppid)}${requester.parent === undefined ? '' : ` ${requester.parent}`}`,
        requester.tty === undefined ? 'no tty' : `tty ${requester.tty}`,
        ...(requester.paneID === undefined ? [] : [`pane ${requester.paneID}`])
    ];
    const command = ['kelpid', ...requester.argv].join(' ');
    return (
        `${now.toISOString()} ${request.verb} of pid ${String(request.targetPid)} requested by pid ` +
        `${String(requester.pid)} (${facts.join(', ')}): ${command} [${request.how}]`
    );
}

/** Append the request to `<run dir>/lifecycle.log`. Never throws. */
export function recordLifecycleRequest(
    runDir: string,
    request: LifecycleRequest,
    options: { readonly requester?: Requester; readonly now?: Date; readonly env?: NodeJS.ProcessEnv } = {}
): void {
    try {
        const file = path.join(runDir, LIFECYCLE_LOG_NAME);
        try {
            if (fs.statSync(file).size > LIFECYCLE_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
        } catch {
            // No log yet.
        }
        const line = lifecycleRequestLine(request, options.requester ?? currentRequester(options.env), options.now ?? new Date());
        fs.appendFileSync(file, `${line}\n`, { mode: RUN_FILE_MODE });
    } catch {
        // A run dir we cannot write to costs the record, not the stop.
    }
}

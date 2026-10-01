/**
 * `kelpi daemon status|start|restart|stop` (#311): the daemon's own verbs, under the name that is
 * on PATH.
 *
 * The packaged app installs `kelpi`, not `kelpid`, so the only way to restart the daemon from a
 * terminal used to be typing `…/Resources/node …/Resources/daemon/kelpid.js restart` in full.
 * That long line then sat in shell history, and a recalled `stop` version of it ended every
 * terminal and agent on 2026-10-01. This runs the `kelpid` bundled beside this CLI with the same
 * arguments and the same terminal, so `stop` keeps `kelpid`'s question and `restart` keeps
 * terminals, and there is one implementation of each.
 *
 * It needs the daemon's machine: a CLI talking to a daemon over `KELPI_SOCKET=tcp:…` from
 * another host has no `kelpid` to run and no process to signal.
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isHelpToken } from '../args.js';
import { env } from '../env.js';
import { errLine, exit, writeErr, writeOut } from '../io.js';
import { daemonUsage } from '../usage.js';

const VERBS = new Set(['status', 'start', 'restart', 'stop']);

/**
 * Where `kelpid.js` is, given this CLI's own file:
 *
 *   1. `KELPID_ENTRY`, the override `kelpid` itself honours (a dev instance sets it).
 *   2. `<cli>/../daemon/kelpid.js`: the packaged app (`Resources/cli/kelpi.js`, `Resources/daemon/`).
 *   3. `<cli>/../../daemon/dist/kelpid.js`: a source checkout (`packages/cli/dist/kelpi.js`).
 */
export function daemonEntryCandidates(cliFile: string, environment: NodeJS.ProcessEnv): string[] {
    const override = environment['KELPID_ENTRY']?.trim();
    if (override !== undefined && override.length > 0) return [path.resolve(override)];
    const dir = path.dirname(cliFile);
    return [path.resolve(dir, '..', 'daemon', 'kelpid.js'), path.resolve(dir, '..', '..', 'daemon', 'dist', 'kelpid.js')];
}

function thisFile(): string {
    try {
        return realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return process.argv[1] ?? '';
    }
}

export async function handleDaemon(args: string[]): Promise<void> {
    const verb = args[0];
    if (verb === undefined || isHelpToken(verb)) {
        (verb === undefined ? writeErr : writeOut)(daemonUsage);
        exit(verb === undefined ? 1 : 0);
    }
    if (!VERBS.has(verb)) {
        errLine(`kelpi daemon: unknown command: ${verb}`);
        writeErr(daemonUsage);
        exit(1);
    }
    const environment = env();
    const candidates = daemonEntryCandidates(thisFile(), environment);
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (entry === undefined) {
        errLine(`kelpi daemon: no kelpid next to this kelpi (looked at ${candidates.join(', ')}).`);
        errLine('Repair: run it on the machine the daemon runs on, from the Kelpi app\'s own CLI, or set KELPID_ENTRY.');
        exit(1);
    }
    // The same Node that runs this CLI: the packaged launcher runs both under the app's `node`.
    const code = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit', env: environment });
        child.on('error', (error) => {
            errLine(`kelpi daemon: could not run ${entry}: ${error.message}`);
            resolve(1);
        });
        child.on('exit', (status, signal) => resolve(status ?? (signal === null ? 1 : 128)));
    });
    exit(code);
}

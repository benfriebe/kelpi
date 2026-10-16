/**
 * `kelpi daemon status|start|restart|stop|restart-old-terminals|import` (#311, #372, #360): the
 * daemon's own verbs, under the name that is on PATH.
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
 *
 * `import` (#360) is the move from the legacy Nex app, which is otherwise reachable only through
 * that long `kelpid` line. Before running it, this warns when Nex is still running: a Kelpi
 * started beside it resumes the same agent sessions Nex resumes, and each one then runs twice.
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isHelpToken } from '../args.js';
import { env } from '../env.js';
import { errLine, exit, writeErr, writeOut } from '../io.js';
import { pidsOfExecutable, runProcess, type ProcessRunner } from '../proc.js';
import { daemonUsage } from '../usage.js';

const VERBS = new Set(['status', 'start', 'restart', 'stop', 'restart-old-terminals', 'import']);

/** The legacy app's executable, as `ps -o comm=` prints it. */
const NEX_APP_EXECUTABLE = '/Nex.app/Contents/MacOS/Nex';

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

/**
 * The environment the packaged app gives a daemon it starts (`daemonSpawnEnv` in
 * `packages/shell/src/daemon.ts`), for a daemon started by this CLI instead: `kelpi daemon start`
 * after an import (#360), or a `restart`. Without it that daemon serves no web client (a blank
 * window), puts no `kelpi` on its panes' PATH, and reports the compiled-in `0.3.0-dev` as its
 * version, so the next app launch takes it for an old daemon and replaces it.
 *
 * Only for the CLI inside an app bundle (`<App>/Contents/Resources/cli/kelpi.js`; `cliFile` is
 * its real path), and each value only when the caller has not set it. `KELPID_ENTRY` never
 * decides it: a dev instance sets that and is not packaged. `KELPI_CLI_VERSION` is the app's
 * version, which the packaged launcher exports (`packages/shell/src/packaging.ts`).
 */
export function packagedDaemonEnv(cliFile: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const cliDir = path.dirname(cliFile);
    const resources = path.dirname(cliDir);
    if (path.basename(cliDir) !== 'cli' || path.basename(resources) !== 'Resources') return environment;
    const unset = (name: string): boolean => (environment[name]?.trim() ?? '') === '';
    const result: NodeJS.ProcessEnv = { ...environment };
    const client = path.join(resources, 'client');
    if (unset('KELPID_CLIENT_DIR') && existsSync(path.join(client, 'index.html'))) result['KELPID_CLIENT_DIR'] = client;
    if (unset('KELPID_HELPERS_DIR') && existsSync(path.join(cliDir, 'kelpi'))) result['KELPID_HELPERS_DIR'] = cliDir;
    const version = environment['KELPI_CLI_VERSION']?.trim();
    if (unset('KELPID_VERSION') && version !== undefined && version.length > 0) result['KELPID_VERSION'] = version;
    return result;
}

/** The warning `kelpi daemon import` prints while the Nex app runs, or undefined. */
export function nexRunningWarning(psOutput: string): string | undefined {
    const pids = pidsOfExecutable(psOutput, NEX_APP_EXECUTABLE);
    if (pids.length === 0) return undefined;
    return `Warning: Nex is running (pid ${pids.join(', ')}). Quit it before starting Kelpi, or each agent session both apps resume runs twice.`;
}

async function warnIfNexRuns(run: ProcessRunner): Promise<void> {
    try {
        const ps = await run('/bin/ps', ['-axo', 'pid=,comm=']);
        const warning = nexRunningWarning(ps.stdout);
        if (warning !== undefined) errLine(warning);
    } catch {
        // A check that cannot run says nothing; the import itself does not depend on it.
    }
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
    const cliFile = thisFile();
    const environment = packagedDaemonEnv(cliFile, env());
    const candidates = daemonEntryCandidates(cliFile, environment);
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (entry === undefined) {
        errLine(`kelpi daemon: no kelpid next to this kelpi (looked at ${candidates.join(', ')}).`);
        errLine('Repair: run it on the machine the daemon runs on, from the Kelpi app\'s own CLI, or set KELPID_ENTRY.');
        exit(1);
    }
    if (verb === 'import') await warnIfNexRuns(runProcess);
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

/**
 * Doctor checks 1–5 (cli.md §16), with the two the daemon architecture changes.
 *
 * Unchanged: `transport` (what we would dial), `socket`/`resolve` (can we reach it at all),
 * `ping` (a real request/response through the same dispatcher a command uses — the check that
 * actually proves the wire works).
 *
 * **`process` is daemon-aware.** The Swift check grepped `ps` for
 * `Kelpi.app/Contents/MacOS/Kelpi` and FAILed when the app was gone, which is wrong in the new
 * world: a healthy `kelpid` is the normal case and there may be no `.app` at all. It now
 * accepts, in order: a live pid record in the daemon run dir (`daemon-v<N>.pid`, cross-checked
 * with `kill(pid, 0)`), a `kelpid` / `kelpid.js` process in `ps`, or the Swift app. Only when NONE
 * of those exist is it a FAIL. TCP still SKIPs — the daemon is on another host.
 *
 * **`version` compares identities, and the protocol first.** CLI and daemon are separate
 * artifacts now, so a version-string difference is advisory (WARN, exit code unchanged) while
 * a PROTOCOL mismatch is the actionable one: it means the two cannot agree on the wire even if
 * both are healthy. Equal version AND build ⇒ PASS.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION } from '@kelpi/protocol';

import { asInt, asString, parseJsonObject } from '../json.js';
import type { ProcessResult } from '../proc.js';
import { describeTransportFailure, takeLastTransportFailure, type Transport } from '../transport.js';
import type { CliIdentity } from '../version.js';
import type { DoctorCheck } from './types.js';

export interface PingFacts {
    pid?: number | undefined;
    version?: string | undefined;
    build?: string | undefined;
    protocol?: number | undefined;
    /** The daemon's CLI-compat socket is degraded (another Kelpi owns it); from `ping`. */
    compat?: { path: string; error: string } | undefined;
    /** The `KELPI_SOCKET` / `NEX_SOCKET` value the daemon injects into pane environments; from `ping`. */
    paneRoute?: string | undefined;
}

export function transportCheck(transport: Transport, fromEnv?: boolean): DoctorCheck {
    if (transport.kind === 'unix') {
        const provenance =
            fromEnv === undefined ? '' : fromEnv ? ' (from KELPI_SOCKET)' : ' (the default; KELPI_SOCKET unset)';
        return { name: 'transport', status: 'PASS', detail: `Unix socket at ${transport.path}${provenance}` };
    }
    return {
        name: 'transport',
        status: 'PASS',
        detail: `TCP ${transport.host}:${String(transport.port)} (from KELPI_SOCKET)`
    };
}

export interface ReachabilityDeps {
    socketExists(path: string): boolean;
    resolveHost(host: string): Promise<boolean>;
}

export async function reachabilityCheck(transport: Transport, deps: ReachabilityDeps): Promise<DoctorCheck> {
    if (transport.kind === 'unix') {
        if (!deps.socketExists(transport.path)) {
            return {
                name: 'socket',
                status: 'FAIL',
                detail: `Unix socket file ${transport.path} does not exist.`,
                repair: 'Is Kelpi running? Launch the Kelpi app and re-run `kelpi doctor`.'
            };
        }
        return { name: 'socket', status: 'PASS', detail: 'socket file exists' };
    }
    if (!(await deps.resolveHost(transport.host))) {
        return {
            name: 'resolve',
            status: 'FAIL',
            detail: `cannot resolve host "${transport.host}"`,
            repair:
                'Check the hostname in KELPI_SOCKET. From a dev container use `tcp:host.docker.internal:<port>`.'
        };
    }
    return { name: 'resolve', status: 'PASS', detail: 'hostname resolves' };
}

/**
 * The ping round trip. `reply === null` is a transport failure (rendered with the same
 * categorized text a real command would print); an EMPTY reply means a peer that closed
 * without answering.
 */
export function pingCheck(reply: string | null, facts: PingFacts): DoctorCheck {
    if (reply === null) {
        const failure = takeLastTransportFailure();
        if (failure === null) {
            return {
                name: 'ping',
                status: 'FAIL',
                detail: 'kelpi doctor: transport failure (no diagnostic captured).',
                repair: 'Re-run with more verbose tooling, or restart Kelpi.'
            };
        }
        const [line, repair] = describeTransportFailure(failure, 'kelpi doctor');
        return { name: 'ping', status: 'FAIL', detail: line, repair };
    }
    if (reply.length === 0) {
        return {
            name: 'ping',
            status: 'FAIL',
            detail:
                'connected, but Kelpi closed the connection before replying — likely a pre-ping (<v0.26) Kelpi, or the app is wedged.',
            repair: 'Rebuild and relaunch Kelpi if you\'re on a recent main; if `ping` still fails, restart the app.'
        };
    }
    const json = parseJsonObject(reply);
    if (json === null || json['ok'] !== true) {
        return {
            name: 'ping',
            status: 'FAIL',
            detail: `received malformed reply (${String(Buffer.byteLength(reply, 'utf8'))} bytes).`,
            repair: 'Restart Kelpi. If reproducible, file an issue with the raw bytes.'
        };
    }
    facts.pid = asInt(json['pid']);
    facts.version = asString(json['version']);
    facts.build = asString(json['build']);
    facts.protocol = asInt(json['protocol']);
    const compat = json['compat'];
    if (typeof compat === 'object' && compat !== null && !Array.isArray(compat)) {
        const record = compat as Record<string, unknown>;
        const compatPath = record['path'];
        const compatError = record['error'];
        if (typeof compatPath === 'string' && typeof compatError === 'string') {
            facts.compat = { path: compatPath, error: compatError };
        }
    }
    facts.paneRoute = asString(json['pane_route']);
    return {
        name: 'ping',
        status: 'PASS',
        detail: `round-trip ok (app pid ${facts.pid === undefined ? '?' : String(facts.pid)})`
    };
}

/**
 * Where agent events actually route — the check the routing fix (7a7875d) earned.
 *
 * Three stories it can tell:
 *   - the answering daemon is the SWIFT app (its ping carries no `protocol` field): name it,
 *     because a port CLI dialing the default socket on a machine running both apps reaches
 *     the Swift daemon and every port-pane event silently vanishes there;
 *   - the port daemon answered but its CLI-compat socket is DEGRADED (the Swift app owns
 *     it): plain-terminal `kelpi` commands are reaching the other app, panes are unaffected
 *     (their `KELPI_SOCKET` is injected at spawn);
 *   - everything is where it should be, in which case the pane route is printed so a user
 *     can see what their panes carry.
 */
export function routingCheck(facts: PingFacts): DoctorCheck {
    if (facts.pid === undefined) {
        return { name: 'routing', status: 'SKIP', detail: 'no daemon answered ping' };
    }
    if (facts.protocol === undefined) {
        return {
            name: 'routing',
            status: 'WARN',
            detail:
                'the answering daemon is the Swift Nex app (no `protocol` field in its ping reply), not this CLI\'s own daemon.',
            repair:
                'Inside Kelpi panes, commands route automatically (the pane env carries KELPI_SOCKET). In plain terminals, set KELPI_SOCKET=tcp:127.0.0.1:<port> to reach the daemon, or quit the Swift app so it releases /tmp/nex.sock.'
        };
    }
    if (facts.compat !== undefined) {
        return {
            name: 'routing',
            status: 'WARN',
            detail: `this daemon's CLI-compat socket ${facts.compat.path} is degraded: ${facts.compat.error}. Plain-terminal \`kelpi\` commands on the default socket reach a DIFFERENT app; panes are unaffected${facts.paneRoute === undefined ? '' : ` (their injected KELPI_SOCKET is ${facts.paneRoute})`}.`,
            repair:
                'Quit the other Kelpi app to let this daemon reclaim the compat socket (it retries on "Restart Socket Server"), or set KELPI_SOCKET explicitly in plain terminals.'
        };
    }
    return {
        name: 'routing',
        status: 'PASS',
        detail:
            facts.paneRoute === undefined
                ? 'compat socket serving; no pane route reported (older daemon)'
                : `compat socket serving; panes carry KELPI_SOCKET=${facts.paneRoute}`
    };
}

// ── the daemon run dir (a local mirror of lifecycle/rundir.ts, no @kelpi/daemon dependency) ──

export function resolveRunDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
    const override = env['KELPID_RUN_DIR']?.trim();
    if (override !== undefined && override.length > 0) {
        return path.resolve(override.startsWith('~') ? path.join(home, override.slice(1)) : override);
    }
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'kelpid', 'run');
    const xdg = env['XDG_RUNTIME_DIR']?.trim();
    if (xdg !== undefined && xdg.length > 0) return path.join(path.resolve(xdg), 'kelpid');
    return path.join(home, '.local', 'state', 'kelpid', 'run');
}

export interface DaemonRecord {
    readonly pid: number;
    readonly protocol: number;
    readonly version?: string | undefined;
}

export function readDaemonRecord(runDir: string, readFile: (path: string) => string | null): DaemonRecord | null {
    const raw = readFile(path.join(runDir, `daemon-v${String(PROTOCOL_VERSION)}.pid`));
    if (raw === null) return null;
    const json = parseJsonObject(raw);
    if (json === null) return null;
    const pid = asInt(json['pid']);
    if (pid === undefined || pid <= 0) return null;
    return {
        pid,
        protocol: asInt(json['protocol']) ?? PROTOCOL_VERSION,
        version: asString(json['version'])
    };
}

export interface ProcessDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly home: string;
    run(path: string, args: readonly string[]): Promise<ProcessResult>;
    readFile(path: string): string | null;
    isAlive(pid: number): boolean;
}

/**
 * `ps` rows whose comm ends with a Kelpi (or Nex) app executable path. The `Nex` form covers
 * both the shipped Swift app and pre-rename port bundles — the doctor keeps seeing them.
 */
function swiftAppPids(psOutput: string): number[] {
    const pids: number[] = [];
    for (const line of psOutput.split('\n')) {
        const trimmed = line.trim();
        const separator = trimmed.indexOf(' ');
        if (separator < 0) continue;
        const pid = Number.parseInt(trimmed.slice(0, separator), 10);
        const comm = trimmed.slice(separator + 1).trim();
        if (!Number.isInteger(pid)) continue;
        if (comm.endsWith('Kelpi.app/Contents/MacOS/Kelpi') || comm.endsWith('Nex.app/Contents/MacOS/Nex')) {
            pids.push(pid);
        }
    }
    return pids;
}

/** `ps` rows whose command line runs `kelpid` or `kelpid.js` (a bundled daemon under node). */
function daemonPids(psOutput: string, selfPid: number): number[] {
    const pids: number[] = [];
    for (const line of psOutput.split('\n')) {
        const trimmed = line.trim();
        const separator = trimmed.indexOf(' ');
        if (separator < 0) continue;
        const pid = Number.parseInt(trimmed.slice(0, separator), 10);
        if (!Number.isInteger(pid) || pid === selfPid) continue;
        const command = trimmed.slice(separator + 1);
        // `nexd` forms stay recognised: during the rename transition the running daemon may
        // still be a pre-rename bundle, and a doctor that cannot see it would misdiagnose.
        const runsDaemon = command
            .split(/\s+/)
            .some(
                (token) =>
                    token === 'kelpid' ||
                    token.endsWith('/kelpid') ||
                    token.endsWith('/kelpid.js') ||
                    token === 'nexd' ||
                    token.endsWith('/nexd') ||
                    token.endsWith('/nexd.js')
            );
        if (runsDaemon) pids.push(pid);
    }
    return pids;
}

export async function processCheck(transport: Transport, deps: ProcessDeps, facts: PingFacts): Promise<DoctorCheck> {
    if (transport.kind === 'tcp') {
        return {
            name: 'process',
            status: 'SKIP',
            detail: 'skipped (TCP transport — running Kelpi is on a remote host).'
        };
    }

    const runDir = resolveRunDir(deps.env, deps.platform, deps.home);
    const record = readDaemonRecord(runDir, deps.readFile);
    const liveRecord = record !== null && deps.isAlive(record.pid) ? record : null;

    // `ps -axo pid=,comm=` for the app (exact executable path) and `pid=,command=` for the
    // daemon (a bundled `kelpid.js` runs under node, so `comm` is just the node binary).
    const comm = await deps.run('/bin/ps', ['-axo', 'pid=,comm=']);
    const full = await deps.run('/bin/ps', ['-axo', 'pid=,command=']);
    const appPids = swiftAppPids(comm.stdout);
    const kelpidPids = daemonPids(full.stdout, process.pid);

    const known = new Set<number>(kelpidPids);
    for (const pid of appPids) known.add(pid);
    if (liveRecord !== null) known.add(liveRecord.pid);

    if (known.size === 0) {
        return {
            name: 'process',
            status: 'FAIL',
            detail: 'no running kelpid or Kelpi.app process found',
            repair:
                'Start the daemon (`kelpid start`) or launch Kelpi from /Applications, then re-run `kelpi doctor`.'
        };
    }
    const pids = [...known].sort((left, right) => left - right);
    if (facts.pid !== undefined && !known.has(facts.pid)) {
        return {
            name: 'process',
            status: 'WARN',
            detail: `found pids [${pids.join(', ')}], but ping replied from pid ${String(facts.pid)} — multiple Kelpi instances?`,
            repair: 'Quit the stale instances (`kill <pid>`) and keep one running.'
        };
    }
    if (liveRecord !== null) {
        const extra = appPids.length > 0 ? `; Kelpi.app pids: ${appPids.join(', ')}` : '';
        return {
            name: 'process',
            status: 'PASS',
            detail: `kelpid running (pid ${String(liveRecord.pid)}, protocol ${String(liveRecord.protocol)})${extra}`
        };
    }
    const label = kelpidPids.length > 0 ? 'kelpid running' : 'Kelpi.app running';
    return { name: 'process', status: 'PASS', detail: `${label} (pids: ${pids.join(', ')})` };
}

/**
 * Identity drift. New semantics, documented in the package README:
 *   - no version from ping ⇒ SKIP (the ping FAIL already carries the actionable bit);
 *   - PROTOCOL mismatch ⇒ WARN, and it is the one that means "these two cannot talk";
 *   - same version AND build ⇒ PASS;
 *   - anything else ⇒ WARN, advisory only (the CLI and the daemon ship separately now, so a
 *     locally-built CLI against a packaged daemon is a normal, working configuration).
 */
export function versionCheck(cli: CliIdentity, facts: PingFacts): DoctorCheck {
    const daemonVersion = facts.version;
    if (daemonVersion === undefined) {
        return { name: 'version', status: 'SKIP', detail: 'skipped (ping did not return a version)' };
    }
    if (facts.protocol !== undefined && facts.protocol !== cli.protocol) {
        return {
            name: 'version',
            status: 'WARN',
            detail: `CLI speaks protocol ${String(cli.protocol)}; kelpid ${daemonVersion} speaks protocol ${String(facts.protocol)}.`,
            repair:
                'Protocol drift, not just version drift: rebuild both sides from the same checkout (`pnpm --filter @kelpi/cli build`, `pnpm --filter @kelpi/daemon build`) so they speak the same wire.'
        };
    }
    const daemonBuild = facts.build;
    if (daemonVersion === cli.version && (daemonBuild === undefined || daemonBuild === cli.build)) {
        return { name: 'version', status: 'PASS', detail: `CLI ${cli.version} matches kelpid ${daemonVersion}` };
    }
    const daemonIdentity = daemonBuild === undefined ? daemonVersion : `${daemonVersion} (build ${daemonBuild})`;
    return {
        name: 'version',
        status: 'WARN',
        detail: `CLI is ${cli.version} (build ${cli.build}); kelpid is ${daemonIdentity}.`,
        repair:
            'Advisory only — the CLI and the daemon are separate artifacts and the wire protocol matches. Rebuild both from one checkout if they are meant to be the same release.'
    };
}

/** Production wiring for the filesystem/process side of the checks. */
export const nodeDoctorDeps = {
    socketExists: (target: string): boolean => {
        try {
            fs.statSync(target);
            return true;
        } catch {
            return false;
        }
    },
    readFile: (target: string): string | null => {
        try {
            return fs.readFileSync(target, 'utf8');
        } catch {
            return null;
        }
    },
    isDirectory: (target: string): boolean => {
        try {
            return fs.statSync(target).isDirectory();
        } catch {
            return false;
        }
    },
    isAlive: (pid: number): boolean => {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
    },
    platform: os.platform()
};

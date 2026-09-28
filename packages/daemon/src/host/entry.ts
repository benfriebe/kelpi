/**
 * The terminal host's process entry (`dist/terminal-host.js`; `docs/terminal-host.md` §2).
 *
 *     node terminal-host.js --run-dir <dir> [--log <file>]
 *
 * Launched detached by a daemon (`ensureTerminalHost`). It reads the run dir's host token, exits
 * quietly if another host already answers, and otherwise listens until it is told to shut down,
 * gets a terminating signal (it hangs up every terminal first), or sits idle with no terminals
 * and no daemon.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DAEMON_VERSION } from '../boot/version.js';
import { readToken } from '../lifecycle/rundir.js';
import { nodePtySpawner } from '../pty/spawner.js';
import { clearHostPidRecord, resolveHostPaths, writeHostPidRecord } from './launch.js';
import { HOST_PROTOCOL_VERSION } from './protocol.js';
import { leaseRuntime, releaseRuntime } from './runtime.js';
import { TerminalHostServer } from './server.js';

function argValue(argv: readonly string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
}

function answers(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.createConnection(socketPath);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

export async function runTerminalHost(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    const runDir = argValue(argv, '--run-dir');
    if (runDir === undefined) {
        process.stderr.write('usage: terminal-host --run-dir <dir> [--log <file>]\n');
        process.exit(2);
    }
    const logFile = argValue(argv, '--log') ?? process.env['KELPID_TERMINAL_HOST_LOG'];
    const log = (line: string): void => {
        const text = `${new Date().toISOString()} [terminal-host ${process.pid}] ${line}\n`;
        if (logFile !== undefined) {
            try {
                fs.appendFileSync(logFile, text);
            } catch {
                // logging must never take the host down
            }
        } else {
            process.stderr.write(text);
        }
    };

    const paths = resolveHostPaths(runDir);
    const token = readToken(paths);
    if (token === undefined) {
        log(`no token at ${paths.token}; the daemon writes it before launching a host`);
        process.exit(1);
    }
    if (await answers(paths.socket)) {
        log('another terminal host is already listening; exiting');
        process.exit(0);
    }
    try {
        fs.unlinkSync(paths.socket);
    } catch {
        // no stale socket
    }

    const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
    const lease = leaseRuntime(runtimeDir);
    let exiting = false;
    const server = new TerminalHostServer({
        socketPath: paths.socket,
        token,
        spawner: nodePtySpawner,
        hostVersion: DAEMON_VERSION,
        log,
        onExit: (reason) => {
            if (exiting) return;
            exiting = true;
            clearHostPidRecord(paths);
            releaseRuntime(lease);
            log(`exit (${reason})`);
            process.exit(0);
        }
    });

    // The socket is born 0600: nothing but this user may even try the token.
    const previousMask = process.umask(0o177);
    try {
        await server.start();
    } finally {
        process.umask(previousMask);
    }
    writeHostPidRecord(paths, {
        pid: process.pid,
        protocol: HOST_PROTOCOL_VERSION,
        startedAt: new Date().toISOString(),
        version: DAEMON_VERSION,
        runtimeDir
    });
    log(`listening on ${paths.socket}`);

    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
        process.on(signal, () => {
            log(`${signal}: hanging up every terminal`);
            void server.shutdown(signal);
        });
    }
    process.on('uncaughtException', (error) => {
        log(`uncaught: ${error.stack ?? String(error)}`);
    });
}


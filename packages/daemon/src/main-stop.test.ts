/**
 * `kelpid stop`'s guard (#311) and the line it leaves in the lifecycle log (#314).
 *
 * The daemon here is a stand-in: a control socket that answers `ping` with the pid of a `sleep`
 * child, so the SIGTERM lands on that child and never on the test runner (`main.test.ts` says why
 * a real in-process daemon cannot be stopped).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveDaemonVersion } from './boot/index.js';
import { isProcessAlive, LIFECYCLE_LOG_NAME, resolveRunPaths, writePidRecord } from './lifecycle/index.js';
import { parseKelpidArgs, runKelpid, type CliIO } from './main.js';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
});

const ROUTE = 'tcp:127.0.0.1:52144';
const PANE = 'AAAAAAAA-0000-4000-8000-000000000001';

interface FakeDaemon {
    readonly env: NodeJS.ProcessEnv;
    readonly runDir: string;
    readonly victim: ChildProcess;
    readonly pid: number;
}

/** A `sleep` posing as the daemon, and a control socket that answers `ping` for it. */
async function fakeDaemon(ping: Record<string, unknown>, options: { handoff?: boolean } = {}): Promise<FakeDaemon> {
    const root = fs.mkdtempSync(path.join('/tmp', 'kelpid-stop-'));
    const runDir = path.join(root, 'run');
    const env: NodeJS.ProcessEnv = { KELPID_RUN_DIR: runDir, KELPID_SOCKET_PATH: path.join(root, 'kelpi.sock') };
    const paths = resolveRunPaths({ env, protocol: resolveDaemonVersion(env).protocol });
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

    const victim = spawn('sleep', ['30'], { stdio: 'ignore' });
    const pid = victim.pid as number;
    const server = net.createServer((socket) => {
        socket.on('data', () => {
            socket.write(`${JSON.stringify({ ok: true, version: 'test', build: 'test', pid, pane_route: ROUTE, ...ping })}\n`);
        });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    writePidRecord(paths, { pid, ...(options.handoff === true ? { handoff: true } : {}) });

    cleanups.push(async () => {
        victim.kill('SIGKILL');
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { env, runDir, victim, pid };
}

interface Captured extends CliIO {
    readonly stdout: string[];
    readonly stderr: string[];
    readonly questions: string[];
}

function io(env: NodeJS.ProcessEnv, options: { interactive?: boolean; answer?: boolean } = {}): Captured {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const questions: string[] = [];
    return {
        stdout,
        stderr,
        questions,
        env,
        out: (line) => stdout.push(line),
        err: (line) => stderr.push(line),
        interactive: options.interactive ?? false,
        confirm: (question) => {
            questions.push(question);
            return Promise.resolve(options.answer ?? false);
        }
    };
}

async function exited(child: ChildProcess): Promise<boolean> {
    for (let i = 0; i < 50 && isProcessAlive(child.pid as number); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !isProcessAlive(child.pid as number);
}

const BUSY = { terminals: { live: 42, agents: 3, running: 1, waiting: 2 } };

describe('kelpid stop with live terminals', () => {
    it('asks first at a terminal, and a no (the default) leaves the daemon running', async () => {
        const daemon = await fakeDaemon(BUSY, { handoff: true });
        const captured = io(daemon.env, { interactive: true, answer: false });

        expect(await runKelpid(['stop'], captured)).toBe(1);

        expect(captured.questions).toEqual(['Stop anyway? [y/N] ']);
        expect(captured.stderr[0]).toBe(
            `This stops kelpid (pid ${String(daemon.pid)} in ${daemon.runDir}) and ends 42 terminals (3 agent sessions: 1 running, 2 waiting).`
        );
        expect(captured.stderr.join('\n')).toContain('kelpi daemon restart');
        expect(captured.stderr.at(-1)).toBe('kelpid was not stopped.');
        expect(isProcessAlive(daemon.pid)).toBe(true);
        expect(fs.existsSync(path.join(daemon.runDir, LIFECYCLE_LOG_NAME))).toBe(false);
    });

    it('stops on a yes, and writes down who asked before signalling', async () => {
        const daemon = await fakeDaemon(BUSY, { handoff: true });
        const captured = io({ ...daemon.env, KELPI_PANE_ID: PANE, KELPI_SOCKET: ROUTE }, { interactive: true, answer: true });

        expect(await runKelpid(['stop'], captured)).toBe(0);

        expect(captured.stderr[0]).toContain('including the terminal you are typing in');
        expect(await exited(daemon.victim)).toBe(true);
        const log = fs.readFileSync(path.join(daemon.runDir, LIFECYCLE_LOG_NAME), 'utf8');
        expect(log).toMatch(
            new RegExp(`^\\S+Z stop of pid ${String(daemon.pid)} requested by pid ${String(process.pid)} \\(ppid \\d+.*, pane ${PANE}\\): kelpid .* \\[confirmed\\]\\n$`)
        );
    });

    it('does not ask with --force or --yes', async () => {
        for (const flag of ['--force', '--yes', '-y']) {
            const daemon = await fakeDaemon(BUSY);
            const captured = io(daemon.env, { interactive: true });
            expect(await runKelpid(['stop', flag], captured)).toBe(0);
            expect(captured.questions).toEqual([]);
            expect(await exited(daemon.victim)).toBe(true);
        }
    });

    it('warns a script on stderr and stops, as it always did', async () => {
        const daemon = await fakeDaemon(BUSY);
        const captured = io(daemon.env, { interactive: false });

        expect(await runKelpid(['stop'], captured)).toBe(0);

        expect(captured.questions).toEqual([]);
        expect(captured.stderr[0]).toMatch(/^Warning: This stops kelpid .* and ends 42 terminals/);
        expect(await exited(daemon.victim)).toBe(true);
        expect(fs.readFileSync(path.join(daemon.runDir, LIFECYCLE_LOG_NAME), 'utf8')).toContain('[not interactive]');
    });

    it('does not offer a restart that would end the shells anyway', async () => {
        const daemon = await fakeDaemon(BUSY, { handoff: false });
        const captured = io(daemon.env, { interactive: true, answer: false });
        await runKelpid(['stop'], captured);
        expect(captured.stderr.join('\n')).not.toContain('restart');
    });

    it('treats a daemon that did not report its terminals as having some', async () => {
        const daemon = await fakeDaemon({});
        const captured = io(daemon.env, { interactive: true, answer: false });
        expect(await runKelpid(['stop'], captured)).toBe(1);
        expect(captured.stderr[0]).toContain('ends every terminal it is running');
    });
});

describe('kelpid stop with nothing running in it', () => {
    it('stops without asking', async () => {
        const daemon = await fakeDaemon({ terminals: { live: 0, agents: 0, running: 0, waiting: 0 } });
        const captured = io(daemon.env, { interactive: true });

        expect(await runKelpid(['stop'], captured)).toBe(0);

        expect(captured.questions).toEqual([]);
        expect(captured.stdout).toEqual([`kelpid stopped (pid ${String(daemon.pid)})`]);
        expect(await exited(daemon.victim)).toBe(true);
    });
});

describe('parseKelpidArgs', () => {
    it('parses the stop flags', () => {
        expect(parseKelpidArgs(['stop'])).toMatchObject({ force: false, yes: false });
        expect(parseKelpidArgs(['stop', '--force'])).toMatchObject({ command: 'stop', force: true });
        expect(parseKelpidArgs(['stop', '--yes'])).toMatchObject({ command: 'stop', yes: true });
        expect(parseKelpidArgs(['-y', 'stop'])).toMatchObject({ command: 'stop', yes: true });
    });
});

/**
 * `kelpid restart-old-terminals` and the old-host lines in `kelpid status` (#372).
 *
 * The daemon is a stand-in: a control socket that answers `ping` with a `terminal_hosts` block
 * and records any `restart-old-terminals` it is sent. The real restart is
 * `boot/terminal-host.test.ts`'s.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveDaemonVersion } from './boot/index.js';
import { createLineBuffer } from '@kelpi/protocol';
import { resolveRunPaths, writePidRecord } from './lifecycle/index.js';
import { runKelpid, type CliIO } from './main.js';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
});

const PANE_A = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_B = 'AAAAAAAA-0000-4000-8000-000000000002';

const DRAINING = {
    terminal_hosts: {
        current: { pid: 222, protocol: 2, version: '0.2.16' },
        old: [
            {
                pid: 111,
                protocol: 1,
                version: '0.2.15',
                reason: 'can leak one of the pseudo-terminals every app on the Mac shares, one for each terminal it opens',
                started_at: '2026-10-01T00:00:00.000Z',
                pane_ids: [PANE_A, PANE_B],
                agents: 1,
                busy_agents: 1
            }
        ]
    }
};

/** A control socket posing as the daemon: `ping` answers `ping`, anything else is recorded. */
async function fakeDaemon(ping: Record<string, unknown>): Promise<{ env: NodeJS.ProcessEnv; commands: string[] }> {
    const root = fs.mkdtempSync(path.join('/tmp', 'kelpid-old-'));
    const runDir = path.join(root, 'run');
    const env: NodeJS.ProcessEnv = { KELPID_RUN_DIR: runDir, KELPID_SOCKET_PATH: path.join(root, 'kelpi.sock') };
    const paths = resolveRunPaths({ env, protocol: resolveDaemonVersion(env).protocol });
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const commands: string[] = [];
    const server = net.createServer((socket) => {
        const buffer = createLineBuffer();
        socket.on('data', (chunk: Buffer) => {
            for (const line of buffer.push(chunk)) {
                const command = String((JSON.parse(line) as { command?: unknown }).command);
                commands.push(command);
                const reply = command === 'ping' ? { ok: true, version: 'test', build: 'test', pid: process.pid, ...ping } : { ok: true, panes: 2, resumed: 1 };
                socket.write(`${JSON.stringify(reply)}\n`);
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    writePidRecord(paths, { pid: process.pid });
    cleanups.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { env, commands };
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

describe('kelpid restart-old-terminals', () => {
    it('says what restarts and asks first at a terminal; a no sends nothing', async () => {
        const daemon = await fakeDaemon(DRAINING);
        const captured = io(daemon.env, { interactive: true, answer: false });

        expect(await runKelpid(['restart-old-terminals'], captured)).toBe(1);

        expect(captured.stderr[0]).toBe(
            'This restarts 2 terminals still on an older terminal host on the current one. ' +
                'Each shell starts again in its folder and 1 Claude or Codex session resumes ' +
                '(1 working right now: the turn in progress is interrupted). Anything else running in them stops.'
        );
        expect(captured.questions).toEqual(['Restart them? [y/N] ']);
        expect(captured.stderr.at(-1)).toBe('Nothing was restarted.');
        expect(daemon.commands).toEqual(['ping']);
    });

    it('restarts on a yes and reports what came back', async () => {
        const daemon = await fakeDaemon(DRAINING);
        const captured = io({ ...daemon.env, KELPI_PANE_ID: PANE_B.toLowerCase() }, { interactive: true, answer: true });

        expect(await runKelpid(['restart-old-terminals'], captured)).toBe(0);

        // Typed in one of them: it ends with the rest.
        expect(captured.stderr[0]).toContain('including in the terminal you are typing in');
        expect(daemon.commands).toEqual(['ping', 'restart-old-terminals']);
        expect(captured.stdout).toEqual([
            'Restarted 2 terminals on the current terminal host and resumed 1 agent session. The old terminal host has exited.'
        ]);
    });

    it('does not ask with --force, and warns a script instead of asking', async () => {
        for (const [args, interactive] of [[['restart-old-terminals', '--force'], true], [['restart-old-terminals'], false]] as const) {
            const daemon = await fakeDaemon(DRAINING);
            const captured = io(daemon.env, { interactive });
            expect(await runKelpid([...args], captured)).toBe(0);
            expect(captured.questions).toEqual([]);
            expect(daemon.commands).toEqual(['ping', 'restart-old-terminals']);
        }
    });

    it('has nothing to do without an older host', async () => {
        const daemon = await fakeDaemon({ terminal_hosts: { current: { pid: 222, protocol: 2, version: '0.2.16' }, old: [] } });
        const captured = io(daemon.env, { interactive: true });
        expect(await runKelpid(['restart-old-terminals'], captured)).toBe(0);
        expect(captured.stdout).toEqual(['No terminals are running on an older terminal host.']);
        expect(daemon.commands).toEqual(['ping']);
    });
});

describe('kelpid status with an older terminal host', () => {
    it('names both hosts and how to restart the old one', async () => {
        const daemon = await fakeDaemon(DRAINING);
        const captured = io(daemon.env);
        await runKelpid(['status'], captured);
        expect(captured.stdout).toContain('  terminal host: pid 222 (0.2.16, generation 2)');
        expect(captured.stdout).toContain(
            '  old terminal host: pid 111 (generation 1, started 2026-10-01T00:00:00.000Z), 2 terminals, 1 agent session'
        );
        expect(captured.stdout).toContain('    To restart them on the current host now: kelpi daemon restart-old-terminals');

        const json = io(daemon.env);
        await runKelpid(['status', '--json'], json);
        expect(JSON.parse(json.stdout[0] ?? '{}')).toMatchObject({
            terminal_hosts: { current: { pid: 222 }, old: [{ pid: 111, pane_ids: [PANE_A, PANE_B], busy_agents: 1 }] }
        });
    });
});

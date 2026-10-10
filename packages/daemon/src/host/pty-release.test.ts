/**
 * Ending a terminal gives its pty back (#370).
 *
 * node-pty 1.1.0 left a `/dev/ptmx` and a kqueue open in the process that spawned each terminal,
 * for good. The host runs for weeks across daemon restarts, so every pane ever closed held one of
 * the 511 ptys macOS has for the whole machine, and once they were gone no terminal app on the Mac
 * could open a new one. This counts the descriptors in the process that owns the ptys, which here
 * is the test's own: the host runs in-process with the real node-pty spawner.
 *
 * It lives in its own file so it gets a process of its own, with no other test's terminals in it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodePtySpawner } from '../pty/spawner.js';
import type { PtySpawnRequest } from '../pty/types.js';
import { connectTerminalHost, type HostPtyHandle, type TerminalHostClient } from './client.js';
import { TerminalHostServer } from './server.js';

const TOKEN = 'a'.repeat(64);
const decoder = new TextDecoder();

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startHostAndConnect(): Promise<TerminalHostClient> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kth-'));
    const socketPath = path.join(dir, 'h.sock');
    const server = new TerminalHostServer({ socketPath, token: TOKEN, spawner: nodePtySpawner, hostVersion: 'test' });
    await server.start();
    cleanups.push(async () => {
        await server.shutdown('test over');
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const client = await connectTerminalHost({ socketPath, token: TOKEN, mode: 'attach' });
    cleanups.push(() => client.close());
    return client;
}

const request = (key: string): PtySpawnRequest => ({
    file: '/bin/sh',
    args: [],
    cwd: os.tmpdir(),
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', PS1: '' },
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
    key
});

/** Spawns a shell, waits until it runs what it is sent, and hands back its exit. */
async function readyShell(client: TerminalHostClient, key: string): Promise<{ handle: HostPtyHandle; exited: Promise<number> }> {
    const handle = client.createSpawner()(request(key)) as HostPtyHandle;
    const exited = new Promise<number>((resolve) => handle.onExit((code) => resolve(code)));
    let text = '';
    const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${key} never answered; saw ${JSON.stringify(text)}`)), 5_000);
        handle.onData((data) => {
            text += decoder.decode(data);
            if (text.includes('READY[42]')) {
                clearTimeout(timer);
                resolve();
            }
        });
    });
    // Assembled by the shell, so the echo of the line itself can never match.
    handle.write('printf "READY[%s]\\n" $((6*7))\n');
    await ready;
    return { handle, exited };
}

interface Descriptors {
    readonly ptmx: ReadonlySet<string>;
    readonly kqueue: ReadonlySet<string>;
}

/** The fds this process holds on a pty master or a kqueue, read from lsof's field output. */
function descriptors(): Descriptors {
    // By path: a run whose PATH lacks /usr/sbin (one started from launchd) still finds it.
    const output = execFileSync('/usr/sbin/lsof', ['-nP', '-w', '-p', String(process.pid), '-F', 'ftn'], { encoding: 'utf8' });
    const ptmx = new Set<string>();
    const kqueue = new Set<string>();
    let fd = '';
    for (const line of output.split('\n')) {
        const value = line.slice(1);
        if (line.startsWith('f')) fd = value;
        else if (line.startsWith('t') && value === 'KQUEUE') kqueue.add(fd);
        else if (line.startsWith('n') && value === '/dev/ptmx') ptmx.add(fd);
    }
    return { ptmx, kqueue };
}

/**
 * The fds opened since `baseline` that are still open, polled until there are none or the deadline
 * passes. By fd rather than by count, so a descriptor something else closes meanwhile cannot
 * cancel out one that leaked.
 */
async function leakedSince(baseline: Descriptors, deadlineMs = 3_000): Promise<{ ptmx: string[]; kqueue: string[] }> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
        const now = descriptors();
        const leaked = {
            ptmx: [...now.ptmx].filter((fd) => !baseline.ptmx.has(fd)),
            kqueue: [...now.kqueue].filter((fd) => !baseline.kqueue.has(fd))
        };
        if ((leaked.ptmx.length === 0 && leaked.kqueue.length === 0) || Date.now() > deadline) return leaked;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

describe.skipIf(process.platform !== 'darwin')('terminal host: an ended terminal releases its pty (#370)', () => {
    it('leaves no /dev/ptmx or kqueue behind, whether the pane closes or the shell exits', { timeout: 30_000 }, async () => {
        const client = await startHostAndConnect();

        // One terminal first, so whatever node-pty and the host open once is in the baseline.
        const warmup = await readyShell(client, 'WARMUP');
        warmup.handle.write('exit\n');
        await warmup.exited;
        const baseline = descriptors();

        const shells = await Promise.all(Array.from({ length: 10 }, (_, index) => readyShell(client, `PANE-${index}`)));
        shells.forEach(({ handle }, index) => {
            // Closing a pane hangs its shell up; typing `exit` ends it from the inside.
            if (index % 2 === 0) handle.kill('SIGHUP');
            else handle.write('exit\n');
        });
        await Promise.all(shells.map(({ exited }) => exited));

        expect(await leakedSince(baseline)).toEqual({ ptmx: [], kqueue: [] });
    });
});

/// <reference types="node" />

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createControlServer, type ControlServer } from '../control/server.js';
import type { ControlDispatcher } from '../seams.js';
import { isDaemonAlive, probeDaemon, spawnDetached } from './detach.js';
import { resolveRunPaths, writePidRecord, type RunPaths } from './rundir.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the detached child to actually write something (the log file is pre-created). */
async function waitForFile(target: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(target)) {
            const contents = fs.readFileSync(target, 'utf8');
            if (contents.length > 0) return contents;
        }
        await delay(25);
    }
    throw new Error(`timed out waiting for ${target}`);
}

describe('spawnDetached', () => {
    let directory: string;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-detach-'));
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('runs a JS entry through the node binary, detached, and does not block the parent', async () => {
        const entry = path.join(directory, 'entry.mjs');
        const output = path.join(directory, 'out.txt');
        fs.writeFileSync(
            entry,
            [
                "import fs from 'node:fs';",
                'const [target] = process.argv.slice(2);',
                'fs.writeFileSync(target, `${process.pid}:${process.argv.slice(3).join(",")}`);'
            ].join('\n')
        );

        const child = spawnDetached(entry, [output, 'alpha']);
        expect(child.command).toBe(process.execPath);
        expect(child.args).toEqual([entry, output, 'alpha']);
        expect(child.pid).toBeGreaterThan(0);

        const contents = await waitForFile(output);
        expect(contents).toBe(`${child.pid}:alpha`);
    });

    it('execs a non-script entry directly', async () => {
        const output = path.join(directory, 'sh.txt');
        const child = spawnDetached('/bin/sh', ['-c', `printf hi > ${output}`]);
        expect(child.command).toBe('/bin/sh');
        expect(child.args).toEqual(['-c', `printf hi > ${output}`]);
        expect(await waitForFile(output)).toBe('hi');
    });

    it('appends child output to a log file when asked', async () => {
        const logFile = path.join(directory, 'logs', 'kelpid.log');
        spawnDetached('/bin/sh', ['-c', 'printf detached-hello'], { logFile });
        const contents = await waitForFile(logFile);
        expect(contents).toContain('detached-hello');
    });

    it('passes cwd and env through', async () => {
        const entry = path.join(directory, 'env.mjs');
        const output = path.join(directory, 'env.txt');
        fs.writeFileSync(
            entry,
            ["import fs from 'node:fs';", 'fs.writeFileSync(process.argv[2], `${process.env.KELPID_TEST_VAR}|${process.cwd()}`);'].join(
                '\n'
            )
        );
        const workingDirectory = fs.realpathSync(directory);
        spawnDetached(entry, [output], { cwd: workingDirectory, env: { ...process.env, KELPID_TEST_VAR: 'set' } });
        expect(await waitForFile(output)).toBe(`set|${workingDirectory}`);
    });
});

describe('daemon liveness probe', () => {
    let directory: string;
    let paths: RunPaths;
    let server: ControlServer | undefined;

    const dispatcher: ControlDispatcher = (message, reply) => {
        if (reply === null) return;
        if (message.command === 'ping') {
            reply.send({ ok: true, version: '0.1.0', build: '7', pid: process.pid });
        } else {
            reply.send({ ok: false, error: 'unsupported' });
        }
        reply.close();
    };

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-live-'));
        paths = resolveRunPaths({ dir: directory });
    });

    afterEach(async () => {
        await server?.stop();
        server = undefined;
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('reports no daemon for an empty run dir', async () => {
        const probe = await probeDaemon(paths, { timeoutMs: 300 });
        expect(probe.alive).toBe(false);
        expect(probe.reason).toBe('ENOENT');
        expect(probe.record).toBeUndefined();
        expect(probe.stalePidRecord).toBe(false);
        expect(await isDaemonAlive(paths, { timeoutMs: 300 })).toBe(false);
    });

    it('reports a daemon that answers ping on the run dir socket', async () => {
        server = createControlServer({ socketPath: paths.socket, dispatcher });
        await server.start();
        writePidRecord(paths, { version: '0.1.0' });

        const probe = await probeDaemon(paths, { timeoutMs: 1000 });
        expect(probe.alive).toBe(true);
        expect(probe.pid).toBe(process.pid);
        expect(probe.version).toBe('0.1.0');
        expect(probe.build).toBe('7');
        expect(probe.record?.pid).toBe(process.pid);
        expect(probe.stalePidRecord).toBe(false);
        expect(await isDaemonAlive(paths, { timeoutMs: 1000 })).toBe(true);
    });

    it('flags a pid record left behind by a crashed daemon', async () => {
        writePidRecord(paths, { pid: 2 ** 22 + 12345 });
        const probe = await probeDaemon(paths, { timeoutMs: 300 });
        expect(probe.alive).toBe(false);
        expect(probe.stalePidRecord).toBe(true);
        expect(probe.pid).toBe(2 ** 22 + 12345);
    });
});

/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION } from '@kelpi/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    clearRunFiles,
    ensureRunDir,
    ensureToken,
    expandTilde,
    generateToken,
    isPidRecordStale,
    isProcessAlive,
    readPidRecord,
    readToken,
    resolveRunDir,
    resolveRunPaths,
    writePidRecord,
    writeToken
} from './rundir.js';

const HOME = '/Users/tester';

function mode(target: string): number {
    return fs.statSync(target).mode & 0o777;
}

describe('run dir resolution', () => {
    it('uses ~/Library/Application Support/nexd/run on darwin', () => {
        expect(resolveRunDir({ env: {}, platform: 'darwin', home: HOME })).toBe(
            path.join(HOME, 'Library', 'Application Support', 'nexd', 'run')
        );
    });

    it('prefers XDG_RUNTIME_DIR on linux', () => {
        expect(resolveRunDir({ env: { XDG_RUNTIME_DIR: '/run/user/501' }, platform: 'linux', home: HOME })).toBe(
            '/run/user/501/nexd'
        );
    });

    it('falls back to ~/.local/state/kelpid/run on linux without XDG_RUNTIME_DIR', () => {
        expect(resolveRunDir({ env: {}, platform: 'linux', home: HOME })).toBe(
            path.join(HOME, '.local', 'state', 'nexd', 'run')
        );
    });

    it('lets KELPID_RUN_DIR win on every platform, expanding ~', () => {
        for (const platform of ['darwin', 'linux'] as const) {
            expect(resolveRunDir({ env: { KELPID_RUN_DIR: '~/kelpid-run' }, platform, home: HOME })).toBe(
                path.join(HOME, 'kelpid-run')
            );
        }
        expect(resolveRunDir({ env: { KELPID_RUN_DIR: '  ' }, platform: 'darwin', home: HOME })).toBe(
            path.join(HOME, 'Library', 'Application Support', 'nexd', 'run')
        );
    });

    it('expands ~ only in leading position', () => {
        expect(expandTilde('~', HOME)).toBe(HOME);
        expect(expandTilde('~/a/b', HOME)).toBe(path.join(HOME, 'a', 'b'));
        expect(expandTilde('/a/~/b', HOME)).toBe('/a/~/b');
        expect(expandTilde('~user/x', HOME)).toBe('~user/x');
    });

    it('names the socket, token and pid file after the protocol version', () => {
        const paths = resolveRunPaths({ dir: '/tmp/rundir' });
        expect(paths.protocol).toBe(PROTOCOL_VERSION);
        expect(paths.socket).toBe(`/tmp/rundir/daemon-v${PROTOCOL_VERSION}.sock`);
        expect(paths.token).toBe(`/tmp/rundir/daemon-v${PROTOCOL_VERSION}.token`);
        expect(paths.pid).toBe(`/tmp/rundir/daemon-v${PROTOCOL_VERSION}.pid`);
    });

    it('keeps generations side by side when the protocol bumps', () => {
        const current = resolveRunPaths({ dir: '/tmp/rundir', protocol: 1 });
        const next = resolveRunPaths({ dir: '/tmp/rundir', protocol: 2 });
        expect(current.socket).not.toBe(next.socket);
        expect(path.dirname(current.socket)).toBe(path.dirname(next.socket));
    });
});

describe('run dir files', () => {
    let directory: string;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-run-'));
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('creates the run dir 0700 even under a permissive umask', () => {
        const paths = resolveRunPaths({ dir: path.join(directory, 'nested', 'run') });
        ensureRunDir(paths);
        expect(mode(paths.dir)).toBe(0o700);
        ensureRunDir(paths); // idempotent
        expect(mode(paths.dir)).toBe(0o700);
    });

    it('round-trips a 0600 token and keeps it stable across calls', () => {
        const paths = resolveRunPaths({ dir: directory });
        expect(readToken(paths)).toBeUndefined();

        const token = ensureToken(paths);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(mode(paths.token)).toBe(0o600);
        expect(readToken(paths)).toBe(token);
        expect(ensureToken(paths)).toBe(token);
    });

    it('mints distinct tokens', () => {
        expect(generateToken()).not.toBe(generateToken());
        expect(generateToken(8)).toHaveLength(16);
    });

    it('treats an empty token file as no token', () => {
        const paths = resolveRunPaths({ dir: directory });
        writeToken(paths, '');
        expect(readToken(paths)).toBeUndefined();
        const minted = ensureToken(paths);
        expect(minted).toHaveLength(64);
    });

    it('writes a 0600 pid record and reads it back', () => {
        const paths = resolveRunPaths({ dir: directory });
        expect(readPidRecord(paths)).toBeUndefined();

        const written = writePidRecord(paths, { http_port: 8123, version: '0.1.0' });
        expect(written.pid).toBe(process.pid);
        expect(written.protocol).toBe(paths.protocol);
        expect(mode(paths.pid)).toBe(0o600);

        const read = readPidRecord(paths);
        expect(read).toEqual(written);
        expect(read?.socket).toBe(paths.socket);
        expect(Number.isNaN(Date.parse(read?.started_at ?? ''))).toBe(false);
    });

    it('reads a corrupt or truncated pid record as absent', () => {
        const paths = resolveRunPaths({ dir: directory });
        ensureRunDir(paths);
        for (const contents of ['', 'not json', '[]', '{"pid":"123"}', '{"pid":-4}', '{}']) {
            fs.writeFileSync(paths.pid, contents);
            expect(readPidRecord(paths)).toBeUndefined();
        }
    });

    it('detects a stale pid record', () => {
        const paths = resolveRunPaths({ dir: directory });
        writePidRecord(paths);
        expect(isPidRecordStale(readPidRecord(paths))).toBe(false);

        // A process that definitely exited: run one and reuse its pid.
        const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());
        expect(deadPid).toBeGreaterThan(0);
        writePidRecord(paths, { pid: deadPid });
        expect(isProcessAlive(deadPid)).toBe(false);
        expect(isPidRecordStale(readPidRecord(paths))).toBe(true);
        expect(isPidRecordStale(undefined)).toBe(true);
    });

    it('knows this process is alive and rejects nonsense pids', () => {
        expect(isProcessAlive(process.pid)).toBe(true);
        expect(isProcessAlive(0)).toBe(false);
        expect(isProcessAlive(-1)).toBe(false);
        expect(isProcessAlive(1.5)).toBe(false);
    });

    it('clears the pid record on clean shutdown but keeps the token', () => {
        const paths = resolveRunPaths({ dir: directory });
        const token = ensureToken(paths);
        writePidRecord(paths);

        clearRunFiles(paths);
        expect(fs.existsSync(paths.pid)).toBe(false);
        expect(readToken(paths)).toBe(token);

        clearRunFiles(paths, { token: true }); // and again with nothing left to remove
        expect(readToken(paths)).toBeUndefined();
    });
});

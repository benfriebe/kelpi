/**
 * `kelpi daemon` (#311): the bundled CLI runs `kelpid` with the same arguments, terminal and exit
 * code. The `kelpid` here is a stand-in script, so nothing real is started or stopped.
 */

import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { daemonEntryCandidates, nexRunningWarning, packagedDaemonEnv } from '../src/commands/daemon.js';
import { buildCLI, runCLI, scratchHome } from './harness.js';

beforeAll(async () => {
    await buildCLI();
}, 60_000);

/** A `kelpid.js` that prints what it was given and exits with the code in its first argument's tail. */
function fakeKelpid(): string {
    const file = path.join(scratchHome(), 'kelpid.js');
    fs.writeFileSync(
        file,
        [
            "const args = process.argv.slice(2);",
            "process.stdout.write(`kelpid ${args.join(' ')} run=${process.env.KELPID_RUN_DIR ?? ''}\\n`);",
            "process.exitCode = args.includes('stop') ? 3 : 0;"
        ].join('\n')
    );
    return file;
}

describe('kelpi daemon', () => {
    it('runs kelpid with the verb and flags, in the caller environment, and keeps its exit code', async () => {
        const entry = fakeKelpid();
        const env = { KELPID_ENTRY: entry, KELPID_RUN_DIR: '/tmp/some-run-dir' };

        const restart = await runCLI(['daemon', 'restart'], { env });
        expect(restart).toMatchObject({ code: 0, stdout: 'kelpid restart run=/tmp/some-run-dir\n' });

        const stop = await runCLI(['daemon', 'stop', '--force'], { env });
        expect(stop).toMatchObject({ code: 3, stdout: 'kelpid stop --force run=/tmp/some-run-dir\n' });
    });

    it('forwards import, the move from the Nex app (#360), with its flags', async () => {
        const env = { KELPID_ENTRY: fakeKelpid(), KELPID_RUN_DIR: '/tmp/some-run-dir' };
        const result = await runCLI(['daemon', 'import', '--dry-run', '--from', '/tmp/nex.db'], { env });
        expect(result).toMatchObject({ code: 0, stdout: 'kelpid import --dry-run --from /tmp/nex.db run=/tmp/some-run-dir\n' });
    });

    it('refuses an unknown verb and prints its usage', async () => {
        const result = await runCLI(['daemon', 'pair'], { env: { KELPID_ENTRY: fakeKelpid() } });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('kelpi daemon: unknown command: pair');
        expect(result.stderr).toContain('kelpi daemon restart');
    });

    it('prints its usage for --help on stdout', async () => {
        const result = await runCLI(['daemon', '--help']);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Running terminals and agents are kept');
    });

    it('is listed in the global usage', async () => {
        const result = await runCLI(['--help'], { env: { KELPI_REQUIRE_SOCKET: '1' } });
        expect(result.stderr).toContain('kelpi daemon restart');
        expect(result.stderr).toContain('kelpi daemon stop [--force]');
        expect(result.stderr).toContain('kelpi daemon import [--dry-run] [--force]');
    });

    it('says so when there is no kelpid to run', async () => {
        const result = await runCLI(['daemon', 'status'], { env: { KELPID_ENTRY: '/nonexistent/kelpid.js' } });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('no kelpid next to this kelpi');
    });
});

describe('daemonEntryCandidates', () => {
    it('looks beside the packaged CLI, then in the source tree, unless KELPID_ENTRY says', () => {
        expect(daemonEntryCandidates('/App/Contents/Resources/cli/kelpi.js', {})).toEqual([
            '/App/Contents/Resources/daemon/kelpid.js',
            '/App/Contents/daemon/dist/kelpid.js'
        ]);
        expect(daemonEntryCandidates('/repo/packages/cli/dist/kelpi.js', {})[1]).toBe('/repo/packages/daemon/dist/kelpid.js');
        expect(daemonEntryCandidates('/anything/kelpi.js', { KELPID_ENTRY: '/opt/kelpid.js' })).toEqual(['/opt/kelpid.js']);
    });
});

describe('packagedDaemonEnv (#360)', () => {
    /** A packaged app's Resources, with the client build and CLI launcher the shell checks for. */
    function app(options: { client?: boolean; launcher?: boolean } = {}): { resources: string; cliFile: string } {
        const resources = path.join(scratchHome(), 'Kelpi.app', 'Contents', 'Resources');
        fs.mkdirSync(path.join(resources, 'cli'), { recursive: true });
        fs.mkdirSync(path.join(resources, 'client'), { recursive: true });
        if (options.client !== false) fs.writeFileSync(path.join(resources, 'client', 'index.html'), '<!doctype html>');
        if (options.launcher !== false) fs.writeFileSync(path.join(resources, 'cli', 'kelpi'), '#!/bin/sh\n');
        const cliFile = path.join(resources, 'cli', 'kelpi.js');
        fs.writeFileSync(cliFile, '');
        return { resources, cliFile };
    }

    it('gives a daemon this CLI starts what the app gives the one it starts', () => {
        const { resources, cliFile } = app();
        expect(packagedDaemonEnv(cliFile, { HOME: '/Users/dev', KELPI_CLI_VERSION: '0.5.2' })).toEqual({
            HOME: '/Users/dev',
            KELPI_CLI_VERSION: '0.5.2',
            KELPID_CLIENT_DIR: path.join(resources, 'client'),
            KELPID_HELPERS_DIR: path.join(resources, 'cli'),
            KELPID_VERSION: '0.5.2'
        });
    });

    it('keeps every value the caller set', () => {
        const { cliFile } = app();
        const caller = {
            KELPI_CLI_VERSION: '0.5.2',
            KELPID_CLIENT_DIR: '/mine/client',
            KELPID_HELPERS_DIR: '/mine/bin',
            KELPID_VERSION: '9.9.9'
        };
        expect(packagedDaemonEnv(cliFile, caller)).toEqual(caller);
    });

    it('sets only what the bundle has', () => {
        const { cliFile } = app({ client: false, launcher: false });
        expect(packagedDaemonEnv(cliFile, {})).toEqual({});
    });

    it('leaves a source checkout and a dev instance alone', () => {
        const checkout = path.join(scratchHome(), 'packages', 'cli', 'dist', 'kelpi.js');
        const env = { KELPI_CLI_VERSION: '0.5.2', KELPID_ENTRY: '/App/Contents/Resources/daemon/kelpid.js' };
        expect(packagedDaemonEnv(checkout, env)).toBe(env);
    });
});

describe('nexRunningWarning (#360)', () => {
    it('names the Nex app by its executable, and nothing else', () => {
        const ps = [
            '  412 /Applications/Kelpi.app/Contents/MacOS/Kelpi',
            ' 9001 /Applications/Nex.app/Contents/MacOS/Nex',
            ' 9002 /Applications/Nex.app/Contents/Helpers/nex',
            ' 9003 /usr/bin/nex'
        ].join('\n');
        expect(nexRunningWarning(ps)).toBe(
            'Warning: Nex is running (pid 9001). Quit it before starting Kelpi, or each agent session both apps resume runs twice.'
        );
        expect(nexRunningWarning('  412 /Applications/Kelpi.app/Contents/MacOS/Kelpi\n')).toBeUndefined();
    });
});

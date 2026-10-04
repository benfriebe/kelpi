/**
 * `kelpi daemon` (#311): the bundled CLI runs `kelpid` with the same arguments, terminal and exit
 * code. The `kelpid` here is a stand-in script, so nothing real is started or stopped.
 */

import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { daemonEntryCandidates } from '../src/commands/daemon.js';
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
        const result = await runCLI(['--help']);
        expect(result.stderr).toContain('kelpi daemon restart');
        expect(result.stderr).toContain('kelpi daemon stop [--force]');
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

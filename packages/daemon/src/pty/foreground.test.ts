import { describe, expect, it } from 'vitest';

import { createForegroundReader } from './foreground.js';

describe('createForegroundReader', () => {
    it('asks ps for the terminal foreground group and the process group, and compares them', async () => {
        const asked: string[][] = [];
        const reader = (stdout: string) =>
            createForegroundReader({
                platform: 'darwin',
                runPs: async (args) => {
                    asked.push([...args]);
                    return stdout;
                }
            });
        // The shell is its own group leader and holds the terminal: nothing else is running.
        expect(await reader(' 4242  4242  4242\n')(4242)).toBe(true);
        // A job (the agent) holds it.
        expect(await reader(' 4242  5000  4242\n')(4242)).toBe(false);
        expect(asked[0]).toEqual(['-o', 'pid=,tpgid=,pgid=', '-p', '4242']);
    });

    it('rejects whenever it cannot tell: no terminal, no row for the pid, ps failing or throwing', async () => {
        const reader = (run: () => Promise<string>) => createForegroundReader({ platform: 'darwin', runPs: run });
        await expect(reader(async () => ' 4242     0  4242\n')(4242)).rejects.toThrow(/no foreground process group/);
        await expect(reader(async () => ' 4242    -1  4242\n')(4242)).rejects.toThrow(/no foreground process group/);
        await expect(reader(async () => '')(4242)).rejects.toThrow(/no foreground process group/);
        // A row for some other process is not an answer for this one.
        await expect(reader(async () => ' 4243  4243  4243\n')(4242)).rejects.toThrow(/no foreground process group/);
        await expect(reader(async () => Promise.reject(new Error('timed out')))(4242)).rejects.toThrow('timed out');
        await expect(
            reader(() => {
                throw new Error('spawn EAGAIN');
            })(4242)
        ).rejects.toThrow('spawn EAGAIN');
    });

    it('reads /proc/<pid>/stat on Linux, counting fields from the last parenthesis', async () => {
        const paths: string[] = [];
        const stat = (tpgid: number) => `4242 (zsh (my) shell) S 1 4242 4242 34816 ${String(tpgid)} 4194560 0 0`;
        const reader = (tpgid: number) =>
            createForegroundReader({
                platform: 'linux',
                readProcStat: async (path) => {
                    paths.push(path);
                    return stat(tpgid);
                }
            });
        expect(await reader(4242)(4242)).toBe(true);
        expect(await reader(5000)(4242)).toBe(false);
        expect(paths[0]).toBe('/proc/4242/stat');
    });

    it('answers every ask made in one turn with ONE ps, for every pid asked about', async () => {
        const asked: string[][] = [];
        const reader = createForegroundReader({
            platform: 'darwin',
            runPs: async (args) => {
                asked.push([...args]);
                // Its own order, and a row only for the pids that exist.
                return '  30  31  30\n   7   7   7\n';
            }
        });
        const answers = Promise.allSettled([reader(7), reader(30), reader(7), reader(99)]);
        expect(await answers).toEqual([
            { status: 'fulfilled', value: true },
            { status: 'fulfilled', value: false },
            { status: 'fulfilled', value: true },
            { status: 'rejected', reason: new Error('no foreground process group for pid 99') }
        ]);
        expect(asked).toEqual([['-o', 'pid=,tpgid=,pgid=', '-p', '7,30,99']]);
    });

    it('never answers an ask from a sample that was already running when it was asked', async () => {
        const releases: ((stdout: string) => void)[] = [];
        let calls = 0;
        const reader = createForegroundReader({
            platform: 'darwin',
            runPs: () => {
                calls += 1;
                return new Promise((resolve) => {
                    releases.push(resolve);
                });
            }
        });
        const first = reader(7);
        await new Promise((resolve) => setImmediate(resolve));
        expect(calls).toBe(1);
        // Asked while the first sample is out: it waits for a sample of its own.
        const second = reader(7);
        releases[0]?.('7 7 7');
        expect(await first).toBe(true);
        await new Promise((resolve) => setImmediate(resolve));
        expect(calls).toBe(2);
        // The agent took the terminal between the two samples; the second ask sees it.
        releases[1]?.('7 8 7');
        expect(await second).toBe(false);
        // Never cached: the next ask is a new lookup.
        const third = reader(7);
        await new Promise((resolve) => setImmediate(resolve));
        releases[2]?.('7 7 7');
        expect(await third).toBe(true);
        expect(calls).toBe(3);
    });

    it('reads /proc once per pid on Linux, batched the same way', async () => {
        const paths: string[] = [];
        const reader = createForegroundReader({
            platform: 'linux',
            readProcStat: async (path) => {
                paths.push(path);
                return `1 (zsh) S 1 1 1 34816 1 4194560`;
            }
        });
        expect(await Promise.all([reader(1), reader(1)])).toEqual([true, true]);
        expect(paths).toEqual(['/proc/1/stat']);
    });
});

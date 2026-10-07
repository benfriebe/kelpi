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
        expect(await reader(' 4242  4242\n')(4242)).toBe(true);
        // A job (the agent) holds it.
        expect(await reader(' 5000  4242\n')(4242)).toBe(false);
        expect(asked[0]).toEqual(['-o', 'tpgid=,pgid=', '-p', '4242']);
    });

    it('rejects whenever it cannot tell: no terminal, nothing printed, ps failing', async () => {
        const reader = (run: () => Promise<string>) => createForegroundReader({ platform: 'darwin', runPs: run });
        await expect(reader(async () => '    0  4242\n')(4242)).rejects.toThrow(/no foreground process group/);
        await expect(reader(async () => '   -1  4242\n')(4242)).rejects.toThrow(/no foreground process group/);
        await expect(reader(async () => '')(4242)).rejects.toThrow(/no foreground process group/);
        await expect(reader(async () => Promise.reject(new Error('timed out')))(4242)).rejects.toThrow('timed out');
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

    it('shares one lookup between concurrent asks for the same pid', async () => {
        let calls = 0;
        let release: (value: string) => void = () => {};
        const reader = createForegroundReader({
            platform: 'darwin',
            runPs: () => {
                calls += 1;
                return new Promise((resolve) => {
                    release = resolve;
                });
            }
        });
        const first = reader(7);
        const second = reader(7);
        release('7 7');
        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(calls).toBe(1);
        // Never cached: the next ask is a new lookup.
        const third = reader(7);
        release('8 7');
        expect(await third).toBe(false);
        expect(calls).toBe(2);
    });
});

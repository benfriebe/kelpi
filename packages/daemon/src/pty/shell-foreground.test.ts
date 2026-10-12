import { describe, expect, it } from 'vitest';

import { createShellForegroundProbe, parseShellForeground } from './shell-foreground.js';

describe('parseShellForeground', () => {
    it('is at a prompt when the shell owns the foreground group', () => {
        // What macOS `ps -o tpgid=,comm=` prints for a login zsh idling at its prompt.
        expect(parseShellForeground(26073, '26073 -zsh\n')).toBe(true);
        expect(parseShellForeground(512, '  512 /bin/bash\n')).toBe(true);
        expect(parseShellForeground(77, '77 /opt/homebrew/bin/fish')).toBe(true);
    });

    it('is not when a command holds the terminal', () => {
        expect(parseShellForeground(26073, '26226 -zsh\n')).toBe(false);
    });

    it('is not for a process that has no line editor to redraw on ⌃L', () => {
        expect(parseShellForeground(9, '9 /bin/sh')).toBe(false);
        expect(parseShellForeground(9, '9 claude')).toBe(false);
    });

    it('is not when ps has nothing to say', () => {
        expect(parseShellForeground(9, '')).toBe(false);
        expect(parseShellForeground(9, 'garbage')).toBe(false);
    });
});

describe('createShellForegroundProbe', () => {
    it('asks ps for exactly the one pid, with the timeout', async () => {
        const calls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
        const probe = createShellForegroundProbe({
            timeoutMs: 250,
            runPs: async (args, timeoutMs) => {
                calls.push({ args, timeoutMs });
                return '41 -zsh\n';
            }
        });

        expect(await probe(41)).toBe(true);
        expect(calls).toEqual([{ args: ['-o', 'tpgid=,comm=', '-p', '41'], timeoutMs: 250 }]);
    });

    it('answers not-at-a-prompt when ps fails, which is the branch that types nothing', async () => {
        const probe = createShellForegroundProbe({
            runPs: async () => {
                throw new Error('ps: timed out');
            }
        });

        expect(await probe(41)).toBe(false);
    });

    it('reads a real shell on a real terminal', async () => {
        // This test process is not a terminal's foreground shell, whatever runs it.
        expect(await createShellForegroundProbe()(process.pid)).toBe(false);
    });
});

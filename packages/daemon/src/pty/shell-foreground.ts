/**
 * Is a pane's shell waiting at its prompt right now? Asked of the OS, for ⌘K (`pane-clear`).
 *
 * Ghostty's `clear_screen` does two different things depending on the answer
 * (`src/termio/Termio.zig` `clearScreen`). At a prompt it erases everything and sends the shell
 * a form feed, so the shell redraws its prompt at the top. Anywhere else it only erases what is
 * above the cursor, because a form feed typed at a running program is that program's input.
 * Ghostty knows from shell integration's semantic prompt marks (OSC 133). Kelpi's zsh
 * integration reports only the directory (`shell-integration.ts`), and bash and fish have none,
 * so this asks the kernel instead: the shell is at its prompt when its own process group is the
 * terminal's foreground group. Every job-control shell hands the terminal to a command's group
 * while it runs and takes it back for the prompt, so the answer does not depend on any rc file.
 *
 * One `ps` per ⌘K (about 10 ms on macOS), bounded by a timeout. An answer the OS will not give
 * (process gone, `ps` missing, timed out) is "not at a prompt", which is the safe branch: it
 * never types anything.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Longest a ⌘K waits on `ps` before it clears without the form feed. */
export const SHELL_FOREGROUND_TIMEOUT_MS = 500;

/**
 * Shells whose line editor redraws the prompt on ⌃L (zle, readline, fish's reader, tcsh's
 * editor, reedline). A plain `sh` or `dash` would echo it into the line instead, so it is not
 * here and gets the branch that types nothing.
 */
const LINE_EDITING_SHELLS: ReadonlySet<string> = new Set(['zsh', 'bash', 'fish', 'tcsh', 'nu']);

export type ShellForegroundProbe = (pid: number) => Promise<boolean>;

export interface ShellForegroundProbeOptions {
    readonly timeoutMs?: number | undefined;
    /** Runs `ps` and resolves its stdout (tests). */
    readonly runPs?: ((args: readonly string[], timeoutMs: number) => Promise<string>) | undefined;
}

/**
 * `ps -o tpgid=,comm=` for one pid, read: the terminal's foreground process group, then the
 * command. A login shell's `comm` is `-zsh`, and macOS can report a full path.
 */
export function parseShellForeground(pid: number, stdout: string): boolean {
    const match = /^\s*(-?\d+)\s+(.+?)\s*$/.exec(stdout.split('\n').find((line) => line.trim() !== '') ?? '');
    if (match === null) return false;
    if (Number(match[1]) !== pid) return false;
    const name = (match[2] ?? '').replace(/^-/, '').split('/').pop() ?? '';
    return LINE_EDITING_SHELLS.has(name);
}

/** A probe of whether `pid`, a pane's shell, holds its terminal and is a line-editing shell. */
export function createShellForegroundProbe(options: ShellForegroundProbeOptions = {}): ShellForegroundProbe {
    const timeoutMs = options.timeoutMs ?? SHELL_FOREGROUND_TIMEOUT_MS;
    const runPs = options.runPs ?? execPs;
    return async (pid) => {
        try {
            return parseShellForeground(pid, await runPs(['-o', 'tpgid=,comm=', '-p', String(pid)], timeoutMs));
        } catch {
            return false;
        }
    };
}

const PS = '/bin/ps';

/** `ps` from its home on both platforms, so a daemon whose PATH lacks `/bin` still finds it. */
function execPs(args: readonly string[], timeoutMs: number): Promise<string> {
    const file = existsSync(PS) ? PS : 'ps';
    return new Promise((resolve, reject) => {
        execFile(file, [...args], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => {
            if (error !== null) reject(error);
            else resolve(stdout);
        });
    });
}

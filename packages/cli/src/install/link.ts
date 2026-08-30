/**
 * `kelpi install-hooks --link` — the CLI symlink half of `install-hooks.sh` (CLI-143, CLI-144).
 *
 * The shell script's rules, kept verbatim in behaviour:
 *
 *   - the destination is `$KELPI_INSTALL_DIR`, default `/usr/local/bin`, and it is **created** if
 *     missing (`mkdir -p`);
 *   - the entry is a **symlink, never a copy**. The `cp` install shipped before April 2025 is
 *     the whole reason `CLIInstallService` exists: a copied binary keeps working after a Sparkle
 *     update and silently answers with last month's CLI (issue #39). A symlink cannot drift;
 *   - a warning when the install directory is not on the current `PATH`, because the hooks run
 *     a bare `kelpi` (see `./self.ts` for why a non-interactive shell makes this bite).
 *
 * And one rule the script did not need, because a user runs a downloaded script knowing it may
 * ask for a password: **never sudo, never silently.** An unwritable `/usr/local/bin` (the
 * default on a machine that has never had Homebrew) is reported with the exact command to run by
 * hand. Escalating privileges from inside a CLI subcommand that the user thought was about hook
 * configuration is not a repair, it is a surprise.
 */

import path from 'node:path';

import type { InstallFs } from './fs.js';

export const DEFAULT_INSTALL_DIR = '/usr/local/bin';
export const LINK_NAME = 'kelpi';

export type LinkAction = 'linked' | 'unchanged' | 'failed' | 'would-link';

export interface LinkResult {
    readonly ok: boolean;
    readonly action: LinkAction;
    /** The link that was (or would be) created. */
    readonly path: string;
    /** What it points at. */
    readonly target: string;
    readonly onPath: boolean;
    /** The command to run by hand when we could not do it (always present, never executed). */
    readonly manualCommand: string;
    readonly reason?: string;
}

export interface LinkOptions {
    readonly installDir: string;
    /** The file to point at — normally this CLI's resolved path. */
    readonly target: string;
    /** `PATH`, for the "not on PATH" warning. */
    readonly pathValue?: string | undefined;
    readonly dryRun: boolean;
}

/** Is `dir` one of the entries in `PATH`? Trailing slashes are normalised away. */
export function directoryOnPath(dir: string, pathValue: string | undefined): boolean {
    const normalise = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value);
    const wanted = normalise(dir);
    return (pathValue ?? '')
        .split(':')
        .filter((entry) => entry.length > 0)
        .some((entry) => normalise(entry) === wanted);
}

export function linkCli(options: LinkOptions, fsys: InstallFs): LinkResult {
    const linkPath = path.join(options.installDir, LINK_NAME);
    const onPath = directoryOnPath(options.installDir, options.pathValue);
    const manualCommand = `sudo mkdir -p ${options.installDir} && sudo ln -sfn ${options.target} ${linkPath}`;
    const base = { path: linkPath, target: options.target, onPath, manualCommand };

    // Already pointing at us: nothing to do, and nothing to report as a change.
    if (fsys.isSymlink(linkPath) && fsys.readLink(linkPath) === options.target) {
        return { ...base, ok: true, action: 'unchanged' };
    }
    if (options.dryRun) return { ...base, ok: true, action: 'would-link' };

    try {
        fsys.mkdirp(options.installDir);
    } catch (error) {
        return {
            ...base,
            ok: false,
            action: 'failed',
            reason: `could not create ${options.installDir}: ${error instanceof Error ? error.message : String(error)}`
        };
    }
    if (!fsys.isWritable(options.installDir)) {
        return {
            ...base,
            ok: false,
            action: 'failed',
            reason: `${options.installDir} is not writable by this user`
        };
    }
    try {
        // unlink + symlink rather than `ln -sf`: `ln -sf` onto an existing *directory symlink*
        // creates the link INSIDE it, which would leave `/usr/local/bin/kelpi/kelpi`.
        fsys.remove(linkPath);
        fsys.symlink(options.target, linkPath);
    } catch (error) {
        return {
            ...base,
            ok: false,
            action: 'failed',
            reason: error instanceof Error ? error.message : String(error)
        };
    }
    return { ...base, ok: true, action: 'linked' };
}

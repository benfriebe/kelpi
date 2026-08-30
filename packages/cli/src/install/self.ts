/**
 * What the installed hooks should actually invoke (CLI-145's port half).
 *
 * The Swift installer had it easy: it symlinked one known binary into `/usr/local/bin` and then
 * wrote a bare `kelpi` into every hook. This CLI ships several ways — a workspace checkout run as
 * `node dist/kelpi.js`, a `pnpm link`, a launcher inside `Kelpi.app/Contents/Resources/cli` — so the
 * command has to be *resolved* rather than assumed:
 *
 *   1. `--command <prefix>` wins outright (scripts, tests, and anyone with an opinion);
 *   2. otherwise, if a `kelpi` on `PATH` resolves to THIS binary, the hooks get the bare `kelpi` —
 *      short, survives an app update, and byte-matches what the Swift installer wrote;
 *   3. otherwise the hooks get this binary's absolute path, shell-quoted if it needs it.
 *
 * **PATH assumption, stated once because it is the thing that breaks silently:** a hook command
 * runs in whatever shell Claude Code / Codex spawns, which is a *non-interactive* shell that
 * does not read `~/.zshrc`. It inherits the PATH of the agent process. So a bare `kelpi` only
 * works when the install directory is on the PATH that the agent CLI itself was started with —
 * which is why case 2 verifies a real `PATH` hit instead of trusting that `/usr/local/bin` is
 * there, why case 3 exists at all, and why `install-hooks` prints a warning when the directory
 * it linked into is not on the current PATH (`./link.ts`).
 */

import path from 'node:path';

import type { InstallFs } from './fs.js';

export interface SelfResolution {
    /** The absolute, symlink-resolved path of the running CLI entry (null if unknowable). */
    readonly executable: string | null;
    /** The prefix to bake into hook commands. */
    readonly command: string;
    /** True when the prefix is the bare `kelpi` because PATH really resolves to us. */
    readonly onPath: boolean;
    /** Which PATH entry answered, when one did. */
    readonly pathEntry?: string;
}

/** POSIX single-quoting, for a path with spaces or shell metacharacters. */
export function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The file this process is running from.
 *
 * `argv[1]` is the bundle (`dist/kelpi.js`) under both `node dist/kelpi.js` and a shebang exec, and
 * it is realpath-resolved so a `/usr/local/bin/kelpi` symlink reports the file it points at.
 */
export function resolveSelfExecutable(argv: readonly string[], fsys: InstallFs): string | null {
    const entry = argv[1];
    if (entry === undefined || entry.length === 0) return null;
    const absolute = path.isAbsolute(entry) ? entry : path.resolve(entry);
    return fsys.realPath(absolute) ?? absolute;
}

/**
 * Does a `kelpi` on `PATH` resolve to this binary?
 *
 * Two shapes count, because the packaged app installs a *launcher* rather than the bundle: the
 * PATH entry can realpath to the running file itself, or to a sibling named `kelpi` in the same
 * directory (the launcher that `exec`s this bundle under the app's own Node).
 */
export function findSelfOnPath(
    executable: string | null,
    pathValue: string | undefined,
    fsys: InstallFs
): string | null {
    if (executable === null) return null;
    const siblingLauncher = path.join(path.dirname(executable), 'kelpi');
    const entries = (pathValue ?? '').split(':').filter((entry) => entry.length > 0);
    for (const entry of entries) {
        const candidate = path.join(entry, 'kelpi');
        if (!fsys.exists(candidate)) continue;
        const resolved = fsys.realPath(candidate);
        if (resolved === null) continue;
        if (resolved === executable || resolved === siblingLauncher) return entry;
    }
    return null;
}

export interface ResolveCommandOptions {
    /** `--command`, when given. */
    readonly override?: string | undefined;
    readonly argv: readonly string[];
    readonly pathValue?: string | undefined;
}

export function resolveHookCommand(options: ResolveCommandOptions, fsys: InstallFs): SelfResolution {
    const executable = resolveSelfExecutable(options.argv, fsys);
    const override = options.override?.trim();
    if (override !== undefined && override.length > 0) {
        return { executable, command: override, onPath: override === 'kelpi' };
    }
    const entry = findSelfOnPath(executable, options.pathValue, fsys);
    if (entry !== null) return { executable, command: 'kelpi', onPath: true, pathEntry: entry };
    // No PATH hit: an absolute command always fires, at the cost of breaking if the app moves.
    // `install-hooks --link` + a re-run is the documented way back to the bare form.
    return { executable, command: executable === null ? 'kelpi' : shellQuote(executable), onPath: false };
}

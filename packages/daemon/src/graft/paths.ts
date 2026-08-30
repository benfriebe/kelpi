/**
 * Path canonicalization for graft (graft-git.md §4.8 + port note 11).
 *
 * Every parent-root comparison graft makes — the `alreadyActive` claim, orphan matching,
 * `graft stop --repo <path>` — runs on a canonical path: standardized (`.`/`..` collapsed)
 * **and symlinks resolved**. On macOS that is what makes `/tmp/x` and `/private/tmp/x` the
 * same repo, which the integration tests depend on.
 *
 * Foundation's `resolvingSymlinksInPath` resolves what it can and leaves the rest; Node's
 * `fs.realpathSync` throws `ENOENT` the moment any component is missing. So the helper walks
 * up to the longest existing prefix, resolves that, and re-appends the missing tail — a
 * deleted worktree still canonicalizes to a comparable path instead of throwing mid-stop.
 */

import fs from 'node:fs';
import path from 'node:path';

import { expandTilde } from '../git/index.js';

/** Injection seam for tests; defaults to `fs.realpathSync`. */
export type RealpathFn = (input: string) => string;

/**
 * Standardize + resolve symlinks, tolerating a missing suffix. Relative input is resolved
 * against `process.cwd()` (matching Foundation's behavior for a relative path).
 */
export function canonicalizePath(input: string, realpath: RealpathFn = fs.realpathSync): string {
    const trimmed = input.trim();
    if (trimmed === '') return '';
    const resolved = path.resolve(trimmed);
    const missing: string[] = [];
    let current = resolved;
    for (;;) {
        try {
            const real = realpath(current);
            if (missing.length === 0) return real;
            return path.join(real, ...missing.reverse());
        } catch {
            const parent = path.dirname(current);
            // Hit the filesystem root without resolving anything: hand back the standardized
            // form rather than inventing one.
            if (parent === current) return resolved;
            missing.push(path.basename(current));
            current = parent;
        }
    }
}

/**
 * The socket layer's `standardizedPath` + canonicalize: expand `~` against `home` first, so a
 * CLI-supplied `--repo ~/code/kelpi` matches a session recorded as `/Users/ben/code/kelpi`.
 */
export function canonicalizeUserPath(
    input: string,
    home: string,
    realpath: RealpathFn = fs.realpathSync
): string {
    const expanded = expandTilde(input.trim(), home);
    return canonicalizePath(expanded, realpath);
}

/** `lastPathComponent` — the folder name graft matches `--repo <name>` against. */
export function lastPathComponent(value: string): string {
    const normalized = value.trim().replace(/\/+$/, '');
    if (normalized === '') return '';
    return path.basename(normalized);
}

export function directoryExists(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

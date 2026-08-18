/**
 * Pure helpers around worktree naming and git error text.
 *
 * Spec: docs/current/app-state-core.md §4.2.1–4.2.3, docs/current/graft-git.md §8.1–8.2, §8.6.
 * These strings reach the user verbatim (CLI reply / GUI alert), so the shapes are contract.
 */

import path from 'node:path';

import { isGitCommandError } from './exec.js';

/** Settings default; `<repo>` expands per `resolvedWorktreeBasePath`. */
export const DEFAULT_WORKTREE_BASE_PATH = '~/nex/worktrees/<repo>';

const REPO_TOKEN = '<repo>';

/**
 * `sanitizedGitName(name)` — safe as BOTH a path component and a git ref. Preserves case,
 * `/`, `.`, `_`, `-`; an already-valid name is a fixed point; nothing surviving → null.
 */
export function sanitizedGitName(name: string): string | null {
    let slug = name.replace(/[^A-Za-z0-9/._-]+/g, '-');
    slug = slug.replace(/-{2,}/g, '-');
    slug = slug.replace(/\/{2,}/g, '/');
    slug = slug.replace(/\.{2,}/g, '.');
    slug = slug.replace(/^[-/._ ]+/, '').replace(/[-/._ ]+$/, '');
    return slug === '' ? null : slug;
}

/** Expand a leading `~` against `home`; anything else is returned untouched. */
export function expandTilde(value: string, home: string): string {
    if (value === '~') return home;
    if (value.startsWith('~/')) return path.join(home, value.slice(2));
    return value;
}

/**
 * Foundation `standardizingPath` in spirit: expand `~`, collapse `.`/`..`, drop a trailing
 * separator. Symlinks are deliberately NOT resolved at this layer (graft canonicalizes further).
 */
export function standardizePath(value: string, home: string): string {
    const expanded = expandTilde(value.trim(), home);
    if (expanded === '') return expanded;
    const normalized = path.normalize(expanded);
    if (normalized.length > 1 && normalized.endsWith(path.sep)) return normalized.slice(0, -1);
    return normalized;
}

/**
 * `resolvedWorktreeBasePath(template, repoPath)` (§4.2.2 / §8.2):
 *   1. a template STARTING with `<repo>` expands that prefix to the full repo path;
 *   2. any other `<repo>` expands to the repo's directory name;
 *   3. a leading `~` expands to home.
 */
export function resolvedWorktreeBasePath(
    template: string,
    repoPath: string,
    home: string
): string {
    const repoName = path.basename(repoPath);
    let result = template;
    if (result.startsWith(REPO_TOKEN)) {
        result = repoPath + result.slice(REPO_TOKEN.length);
    }
    result = result.split(REPO_TOKEN).join(repoName);
    return expandTilde(result, home);
}

/** Full worktree path for a sanitized folder name. */
export function worktreePathFor(input: {
    readonly template: string;
    readonly repoPath: string;
    readonly home: string;
    readonly folderName: string;
}): string {
    const base = resolvedWorktreeBasePath(input.template, input.repoPath, input.home);
    return path.join(base, input.folderName);
}

/**
 * `worktreeErrorMessage(err)` (§4.2.3 / §8.6): git prints an informational
 * `Preparing worktree (…)` line BEFORE the real diagnostic, so the LAST `fatal:`/`error:`
 * line wins; else the last non-empty line; else the whole stderr; else the error description.
 */
export function worktreeErrorMessage(error: unknown): string {
    if (isGitCommandError(error) && error.stderr.trim() !== '') {
        const lines = error.stderr
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const line = lines[index];
            if (line === undefined) continue;
            const lowered = line.toLowerCase();
            if (lowered.startsWith('fatal:') || lowered.startsWith('error:')) return line;
        }
        const last = lines[lines.length - 1];
        return last ?? error.stderr;
    }
    if (error instanceof Error) return error.message;
    return String(error);
}

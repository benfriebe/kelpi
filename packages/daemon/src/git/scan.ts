/**
 * `GitService.scanForRepos` (graft-git.md §GIT-066): walk a directory tree looking for git
 * checkouts, so Settings ▸ Repositories' "Scan Directory" can fill an empty registry in one
 * gesture.
 *
 * Ported rule for rule from `Nex/Services/GitService.swift:117-150`, because every one of them
 * is observable in the result list:
 *
 *   - **Depth is bounded at 3** and counted from the chosen root (`walk(root, 0)`), so a
 *     `~/code` full of `<org>/<repo>` still resolves while a home directory scan cannot walk
 *     the whole disk. The caller fixes the depth (`AppReducer+RepoGit.swift:31-35`); it stays
 *     a parameter here only so the tests can prove the bound.
 *   - **A directory containing `.git` — file OR directory — is a repo**, and the walk does NOT
 *     descend into it. The file form is what a linked worktree has, so worktrees are found;
 *     not descending is what keeps `.git/modules/...` and vendored checkouts out.
 *   - **Hidden entries are skipped** (`.skipsHiddenFiles`), so `.build`, `.cache` and friends
 *     cost nothing.
 *   - **Results sort case-insensitively by name** (`localizedCaseInsensitiveCompare`), which is
 *     the order the registry list then shows them in.
 *
 * Unreadable directories are skipped rather than thrown from: a scan that dies on one
 * permission-denied subfolder would be useless on a real home directory.
 */

import fs from 'node:fs';
import path from 'node:path';

/** One find: the directory itself is the repo path, its basename the proposed name. */
export interface ScannedRepo {
    readonly path: string;
    readonly name: string;
}

/** The Swift caller's fixed depth. */
export const REPO_SCAN_MAX_DEPTH = 3;

export interface ScanForReposOptions {
    readonly maxDepth?: number | undefined;
    /** Injected filesystem (tests). Only the three members the walk uses. */
    readonly fsImpl?: {
        readdirSync: typeof fs.readdirSync;
        existsSync: typeof fs.existsSync;
    };
}

export function scanForRepos(rootPath: string, options: ScanForReposOptions = {}): ScannedRepo[] {
    const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? REPO_SCAN_MAX_DEPTH));
    const io = options.fsImpl ?? fs;
    const found: ScannedRepo[] = [];

    const walk = (directory: string, depth: number): void => {
        if (depth > maxDepth) return;
        // `.git` as a directory (a normal checkout) or as a file (a linked worktree).
        if (io.existsSync(path.join(directory, '.git'))) {
            found.push({ path: directory, name: path.basename(directory) });
            return; // never recurse into a repo
        }
        let entries: fs.Dirent[];
        try {
            entries = io.readdirSync(directory, { withFileTypes: true });
        } catch {
            return; // unreadable → skipped, exactly like `try?` in the Swift walk
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue; // skipsHiddenFiles
            // A symlink is followed the way `.isDirectoryKey` follows one: `readdirSync`
            // answers for its target, and a symlink to a FILE throws there and is skipped.
            // Loops cannot run away — the depth bound is the fence.
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            walk(path.join(directory, entry.name), depth + 1);
        }
    };

    walk(path.normalize(rootPath), 0);
    return found.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'accent' }));
}

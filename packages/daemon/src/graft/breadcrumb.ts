/**
 * The crash-recovery breadcrumb (`<parentRepoRoot>/.git/nex-graft-active`, graft-git.md §2).
 *
 * Compatibility is the whole point (port note 5): a user can upgrade from the Swift app with a
 * breadcrumb already on disk, so the path, the field names, `version: 1` and the sorted-key
 * encoding stay byte-identical, and decoding is deliberately tolerant:
 *
 *   - unparseable JSON / not an object / `version != 1` → **treat as no breadcrumb and LEAVE
 *     THE FILE ALONE** (misreading someone else's file is worse than ignoring it);
 *   - legacy records predating the branch/SHA capture simply omit `preGraftBranch` /
 *     `preGraftSha` → null, which `restoreParent` handles with its `checkout -f HEAD --`
 *     fallback;
 *   - legacy records from the old commit-based design carry `worktreePreGraftSha`, which the
 *     stop/recover paths honour with a worktree `reset --mixed`;
 *   - `stashed` is derivable, so a record missing it is still readable.
 */

import fs from 'node:fs';
import path from 'node:path';

export const BREADCRUMB_FILENAME = 'nex-graft-active';
export const BREADCRUMB_VERSION = 1;

export interface GraftBreadcrumb {
    readonly version: 1;
    readonly stashed: boolean;
    readonly assocId: string;
    readonly stashRef: string | null;
    readonly worktreePath: string;
    readonly branch: string;
    readonly preGraftBranch: string | null;
    readonly preGraftSha: string | null;
    readonly worktreePreGraftSha: string | null;
}

/** `<parentRepoRoot>/.git/nex-graft-active` — literal, even for an unusual git dir layout. */
export function breadcrumbPath(parentRepoRoot: string): string {
    return path.join(parentRepoRoot, '.git', BREADCRUMB_FILENAME);
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/** Sorted keys, compact — matches the Swift encoder byte for byte. */
export function encodeBreadcrumb(crumb: GraftBreadcrumb): string {
    return JSON.stringify({
        assocId: crumb.assocId,
        branch: crumb.branch,
        preGraftBranch: crumb.preGraftBranch,
        preGraftSha: crumb.preGraftSha,
        stashRef: crumb.stashRef,
        stashed: crumb.stashed,
        version: crumb.version,
        worktreePath: crumb.worktreePath,
        worktreePreGraftSha: crumb.worktreePreGraftSha
    });
}

/** Tolerant decode; `null` means "no usable breadcrumb" (never "delete this file"). */
export function decodeBreadcrumb(text: string): GraftBreadcrumb | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== BREADCRUMB_VERSION) return null;

    const worktreePath = stringOrNull(record['worktreePath']);
    if (worktreePath === null) return null;

    const stashRef = stringOrNull(record['stashRef']);
    const stashed =
        typeof record['stashed'] === 'boolean' ? record['stashed'] : stashRef !== null;
    return {
        version: BREADCRUMB_VERSION,
        stashed,
        assocId: stringOrNull(record['assocId']) ?? '',
        stashRef,
        worktreePath,
        // A very old record may not name the branch at all; the sentinel is the honest answer.
        branch: stringOrNull(record['branch']) ?? 'HEAD',
        preGraftBranch: stringOrNull(record['preGraftBranch']),
        preGraftSha: stringOrNull(record['preGraftSha']),
        worktreePreGraftSha: stringOrNull(record['worktreePreGraftSha'])
    };
}

/** Read + decode; missing file, unreadable file and garbage all answer `null`. */
export function readBreadcrumb(parentRepoRoot: string): GraftBreadcrumb | null {
    let text: string;
    try {
        text = fs.readFileSync(breadcrumbPath(parentRepoRoot), 'utf8');
    } catch {
        return null;
    }
    return decodeBreadcrumb(text);
}

/** Throws when the git dir is not writable — `start` treats that as a rollback trigger. */
export function writeBreadcrumb(parentRepoRoot: string, crumb: GraftBreadcrumb): void {
    fs.writeFileSync(breadcrumbPath(parentRepoRoot), encodeBreadcrumb(crumb), 'utf8');
}

/** Best-effort delete; a missing file is success. */
export function removeBreadcrumb(parentRepoRoot: string): void {
    try {
        fs.rmSync(breadcrumbPath(parentRepoRoot), { force: true });
    } catch {
        // Recovery re-runs are harmless; never fail a stop because of this.
    }
}

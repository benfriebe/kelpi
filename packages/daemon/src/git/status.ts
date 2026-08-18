/**
 * Working-tree dirtiness + in-flight-operation types and their parsers (graft-git.md §2, §3.2).
 *
 * Two deliberately different notions of "state" live here:
 *
 *   - `RepoGitStatus` — what the sidebar/inspector badge shows. `changedFiles` is the
 *     **porcelain line count, untracked files INCLUDED**; `additions`/`deletions` come from
 *     `git diff --shortstat HEAD` and therefore count **tracked edits only** (staged ones too).
 *     A repo without a HEAD (fresh `git init`) makes the shortstat fail; that error is
 *     swallowed and the counts stay 0 (port note 16 — the sidebar depends on this exactly).
 *   - `RepoState` — whether a git *operation* is in flight (merge/rebase/…). A filthy working
 *     tree is still `clean` here. Graft refuses to start or sync while either side is busy.
 */

export type RepoGitStatus =
    | { readonly kind: 'unknown' }
    | { readonly kind: 'clean' }
    | {
          readonly kind: 'dirty';
          /** Porcelain line count — untracked files included. */
          readonly changedFiles: number;
          readonly additions: number;
          readonly deletions: number;
      };

/**
 * In-flight git operations, detected from marker files in the resolved git dir. The Swift
 * enum carries an `unknown(String)` case that its own detector can never produce; the port
 * drops it rather than modelling a state nothing emits (the describe strings are unchanged).
 */
export type RepoState = 'clean' | 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'bisect';

/** `repoBusy`'s human text: "merge in progress", "rebase in progress", … */
export function describeRepoState(state: RepoState): string {
    switch (state) {
        case 'clean':
            return 'clean';
        case 'merge':
            return 'merge in progress';
        case 'rebase':
            return 'rebase in progress';
        case 'cherryPick':
            return 'cherry-pick in progress';
        case 'revert':
            return 'revert in progress';
        case 'bisect':
            return 'bisect in progress';
    }
}

export interface ShortstatCounts {
    readonly additions: number;
    readonly deletions: number;
}

/**
 * `" 3 files changed, 27 insertions(+), 12 deletions(-)"` → `{additions: 27, deletions: 12}`.
 * Split on `,`; each part contributes its leading integer to whichever of insertion/deletion
 * its text mentions. Anything unparseable contributes nothing (so `""` → `{0, 0}`).
 */
export function parseShortstat(text: string): ShortstatCounts {
    let additions = 0;
    let deletions = 0;
    for (const rawPart of text.split(',')) {
        const part = rawPart.trim();
        const match = /^(\d+)/.exec(part);
        if (match === null) continue;
        const value = Number.parseInt(match[1] as string, 10);
        if (!Number.isFinite(value)) continue;
        if (part.includes('insertion')) additions = value;
        if (part.includes('deletion')) deletions = value;
    }
    return { additions, deletions };
}

/** Non-empty `git status --porcelain` lines. */
export function porcelainLines(text: string): string[] {
    return text.split('\n').filter((line) => line.trim() !== '');
}

/** `git stash list --format=%H` output → the SHA at each stash index. */
export function parseStashList(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
}

/** `"No local changes to save"` in stdout means `git stash push` created nothing. */
export const NOTHING_TO_STASH = 'No local changes to save';

export interface WorktreeInfo {
    readonly path: string;
    readonly branch: string | null;
    readonly isMain: boolean;
}

/**
 * `git worktree list --porcelain` → entries. `worktree <path>` opens an entry, `branch
 * refs/heads/<name>` names it, `bare` marks it main — and git always lists the main worktree
 * first, so the first entry is force-marked main regardless.
 */
export function parseWorktreeList(text: string): WorktreeInfo[] {
    const entries: { path: string; branch: string | null; isMain: boolean }[] = [];
    let current: { path: string; branch: string | null; isMain: boolean } | null = null;
    const flush = (): void => {
        if (current !== null) entries.push(current);
        current = null;
    };
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '') continue;
        if (line.startsWith('worktree ')) {
            flush();
            current = { path: line.slice('worktree '.length).trim(), branch: null, isMain: false };
            continue;
        }
        if (current === null) continue;
        if (line.startsWith('branch ')) {
            const ref = line.slice('branch '.length).trim();
            const prefix = 'refs/heads/';
            current.branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
            continue;
        }
        if (line === 'bare') current.isMain = true;
    }
    flush();
    const first = entries[0];
    if (first !== undefined) entries[0] = { ...first, isMain: true };
    return entries;
}

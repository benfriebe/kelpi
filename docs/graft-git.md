# Graft + Git subsystem (daemon git module)

Behavioral specification of Kelpi's git-facing subsystem, as implemented in the
TypeScript daemon (`packages/daemon/src/git/`, `packages/daemon/src/graft/`), the `kelpi`
CLI (`packages/cli/src/commands/graft.ts`) and the web client
(`packages/client/src/app/graft.ts`, `packages/client/src/state/graft.ts`). Covers:

1. **GitService** — the daemon's git primitive layer (branch/status/diff/worktree ops,
   stash, tree-level sync primitives, process conventions).
2. **Graft** — worktree-to-parent-repo live mirroring: sessions, the sync engine,
   crash-recovery breadcrumbs, the lock model (issue #231), the `graft-*` wire verbs,
   and the UI state machine (toggle, swap prompt, orphan banner).
3. **Worktree workspace flows** — `workspace create --worktree`, the GUI worktree
   creation flows, name sanitization, `resolvedWorktreeBasePath`, `--update-main`,
   deletion/pruning.
4. **Watchers** — `RecursiveFSWatcher` (drives graft sync) and `GitHeadWatcher`
   (drives sub-second sidebar branch/status refresh), plus their debounce rules and
   downstream update actions.

Everything here is current behavior of Kelpi. The "Compatibility rationale" section at
the end records the quirks the code keeps on purpose so the pre-port `kelpi` CLI, hook
scripts and saved state (breadcrumbs, persisted associations) keep working.

---

## 1. What graft is (user-visible)

Graft continuously **mirrors a linked git worktree's file content into the parent
repository's working tree** without moving the parent's HEAD or branch.

Motivating scenario: an agent works on a feature branch in a worktree
(`~/kelpi/worktrees/my-feature`), while the user's dev server / editor / preview runs in
the main checkout (`~/code/myrepo`). Toggling graft on makes every save in the
worktree appear in the parent's working tree within ~half a second, so the dev server
hot-reloads the agent's work. Toggling graft off restores the parent exactly to its
pre-graft state (including popping any uncommitted edits that were stashed at start).

Key user-visible guarantees:

- The **parent's branch/HEAD never moves** during a graft session. Only its index +
  working tree are overwritten to match the worktree's content.
- **Untracked files in the parent that the worktree does NOT track** (node_modules,
  build output, ignored files) are left alone. An untracked parent file at a path the
  worktree tracks is overwritten by the next sync pass, exactly like a tracked one: the
  mirror is one-way (`packages/daemon/src/graft/service.test.ts:236-270`,
  `packages/daemon/tests/compat/graft.test.ts:359-378`).
- The **worktree is never touched**: its index, branch ref, HEAD, and staged state
  are all preserved verbatim (the sync reads the worktree via a throw-away index).
- Uncommitted parent edits at start time are **auto-stashed** (with untracked files)
  and **auto-popped** at stop.
- **One graft per parent repo** at a time. Trying to graft a second worktree into the
  same parent prompts the user to swap.
- A crash mid-session leaves a **breadcrumb file** in the parent's `.git` dir; on next
  launch the app shows a recovery banner that restores the parent and pops the stash.

The mirror direction is one-way: worktree → parent. Changes made directly in the
parent while grafting will be clobbered by the next sync pass.

What gets mirrored: the sync snapshot is "worktree HEAD tree + all staged and
unstaged edits + untracked (non-ignored) files" — i.e. `git add -A` semantics against
a temp index. Ignored files in the worktree are not mirrored.

---

## 2. Data model

Interfaces (`packages/daemon/src/store/types.ts` for the persisted records,
`packages/daemon/src/graft/types.ts` for the engine's; wire naming noted where it
differs):

```ts
interface Repo {
  id: string;              // UUID
  path: string;            // parent repo root (main checkout)
  name: string;            // defaults to last path component of path
  remoteURL?: string;      // `git remote get-url origin`
  lastAccessedAt: Date;
  isAutoDiscovered: boolean; // true when created by pane-cwd auto-detection; GC'd when unused
}

interface RepoAssociation {
  id: string;              // UUID — doubles as the graft session id
  repoID: string;          // -> Repo.id
  worktreePath: string;    // absolute path of the worktree root (may equal repo.path for the main checkout)
  branchName?: string;     // last-known branch of the worktree (refreshed by HEAD watcher)
  isAutoDetected: boolean; // created by pane-cwd auto-link (subject to auto-unlink GC)
}
// Associations live per-workspace: WorkspaceState.repoAssociations: RepoAssociation[]

type GraftSessionStatus =
  | { kind: "starting" }
  | { kind: "watching" }
  | { kind: "syncing" }
  | { kind: "error"; message: string };

interface GraftSession {
  id: string;              // == RepoAssociation.id
  worktreePath: string;
  parentRepoRoot: string;  // canonicalized (see §4.8)
  branch: string;          // worktree's branch at start; literal "HEAD" when detached
  status: GraftSessionStatus;
  stashRef?: string;       // SHA of the auto-stash made in the parent at start
  lastSyncAt?: number;     // epoch ms of the last successful sync pass (wire: `last_sync`, ISO 8601)
  preGraftBranch?: string; // parent's branch at start ("HEAD" literal when detached)
  preGraftSha?: string;    // parent's HEAD SHA at start
  worktreePreGraftSha?: string; // ALWAYS null for sessions created by the current
                                // (tree-based) design; kept for legacy breadcrumbs
}

interface GraftOrphan {
  id: string;              // breadcrumb's assocId if parseable as UUID, else a fresh UUID
  parentRepoRoot: string;  // canonicalized
  worktreePath: string;
  branch: string;          // the breadcrumb's branch ("HEAD" when the record has none)
  stashRef?: string;
  preGraftBranch?: string;
  preGraftSha?: string;
  worktreePreGraftSha?: string;
}

type GraftSessionEvent =
  | { kind: "started"; session: GraftSession }
  | { kind: "updated"; session: GraftSession }
  | { kind: "stopped"; id: string };

// Typed errors thrown by the graft service:
type GraftError =
  | { kind: "alreadyActive"; parentRepoRoot: string }
  | { kind: "repoBusy"; state: string }             // "merge in progress", "rebase in progress", ...
  | { kind: "missingWorktree"; worktreePath: string }
  | { kind: "branchResolutionFailed"; worktreePath: string } // defined but not thrown by current code
  | { kind: "stashPopConflict"; stashRef: string; underlying: string }
  | { kind: "notAWorktree"; path: string }          // association points at the main checkout itself
  | { kind: "unknown"; message: string };
```

Git-side value types:

```ts
interface ScannedRepo { path: string; name: string; }         // name = last path component

interface WorktreeInfo { path: string; branch?: string; isMain: boolean; }

interface RepoRootInfo {
  worktreeRoot: string;    // `git rev-parse --show-toplevel`, standardized
  parentRepoRoot: string;  // derived from --git-common-dir (see §3 resolveRepoRoot)
}

// In-flight git *operations* (not dirtiness). The marker check can only yield the five
// named states or clean; there is no `unknown` case (packages/daemon/src/git/status.ts:31).
type RepoState = "clean" | "merge" | "rebase" | "cherryPick" | "revert" | "bisect";

// Working-tree dirtiness for the sidebar/inspector badges:
type RepoGitStatus =
  | { kind: "unknown" }
  | { kind: "clean" }
  | { kind: "dirty"; changedFiles: number;      // porcelain line count, INCLUDES untracked
      additions: number; deletions: number };    // from `git diff --shortstat HEAD` — tracked edits only
```

The breadcrumb file (crash-recovery record):

```ts
interface GraftBreadcrumb {           // JSON, sorted keys, written to
  version: 1;                         // <parentRepoRoot>/.git/kelpi-graft-active
  stashed: boolean;                   // stashRef != null at write time
  assocId: string;                    // association UUID string
  stashRef: string | null;
  worktreePath: string;
  branch: string;
  preGraftBranch: string | null;      // absent/null in very old breadcrumbs
  preGraftSha: string | null;
  worktreePreGraftSha: string | null; // only non-null in legacy (commit-based-design) breadcrumbs
}
```

Example on disk:

```json
{"assocId":"5E9C1B4E-6C1D-4A6B-9A87-2C51F0B0D001","branch":"feature/x","preGraftBranch":"main","preGraftSha":"9f72d4f0c2b1...","stashRef":"deadbeef42...","stashed":true,"version":1,"worktreePath":"/Users/ben/kelpi/worktrees/feature-x","worktreePreGraftSha":null}
```

Reading rules: unparseable JSON → treat as no breadcrumb (leave the file alone —
better than misinterpreting it); `version != 1` → treat as no breadcrumb.

Further tolerant-decode rules (`packages/daemon/src/graft/breadcrumb.ts:61-90`): JSON
that is not an object (a string, an array) → no breadcrumb; a missing or empty
`worktreePath` → no breadcrumb; a missing `stashed` is derived from `stashRef != null`;
a missing `assocId` decodes as `""` (so the orphan gets a fresh UUID, §4.10); a missing
`branch` decodes as `"HEAD"`; empty strings in the optional SHA/branch fields
(`stashRef`, `preGraftBranch`, `preGraftSha`, `worktreePreGraftSha`) are normalized to
`null`. Encoding (`breadcrumb.ts:46-58`) is compact JSON with sorted keys so a record
written by the daemon is byte-identical to one written by the pre-port app.

---

## 3. GitService — the daemon's git primitive layer

### 3.1 Process conventions (`runGit`)

Every operation shells out to git (`packages/daemon/src/git/exec.ts`):

- Executable: the first `git` on `PATH` (`resolveGitExecutable`, `exec.ts:94-106`),
  falling back to the bare name `git` so spawn still produces a normal ENOENT when git
  is not installed. The `KELPI_GIT` environment variable overrides the resolution
  (`exec.ts:97`; used by tests and odd installs).
- `cwd` = the repo/worktree path argument. **No `-C` flag is used** (except in the
  CLI's `pruneWorktree`, which is a separate binary).
- Environment: inherits the daemon's full environment. When an op supplies extra env
  (only `writeTreeForWorktree` does, for `GIT_INDEX_FILE`), it is **merged over** the
  inherited environment, not a replacement.
- stdout and stderr are captured separately, with a 64 MiB `maxBuffer` (`exec.ts:26`)
  so a `git diff` of a large tree is not truncated into a parse error.
- **No timeout by default.** Calls block until git exits. (`git fetch` during
  `--update-main` can take a long time; the CLI compensates with a 120s reply
  timeout, see §7.6.) `RunGitOptions` (`exec.ts:60-75`) accepts an optional
  `timeoutMs`, a `maxBuffer` and an `AbortSignal` (the diff pane uses the signal to
  kill a superseded `git diff`). `createGitService` (`packages/daemon/src/git/service.ts:137-144`)
  takes `timeoutMs` for ordinary reads and `longTimeoutMs` for the worktree/fetch
  family; the latter is clamped **up** to `MIN_LONG_GIT_TIMEOUT_MS = 120000`
  (`exec.ts:23`, `exec.ts:155-158`) so a daemon-side budget can never be shorter than
  the CLI's 120s reply wait. The daemon constructs its shared service with no options
  (`packages/daemon/src/boot/compose.ts:602`), so in production there is still no
  timeout.
- Exit code 0 → return stdout as a UTF-8 string (possibly empty).
- A spawn failure whose `code` is a string (`ENOENT`, `EACCES`: git itself is missing,
  not a failed git command) rejects with the raw Node error, not a `GitCommandError`
  (`exec.ts:136-140`).
- Exit code != 0 → throw:

```ts
class GitCommandError extends Error {   // packages/daemon/src/git/exec.ts:28-54
  kind: "commandFailed";
  command: string;      // "git " + args.join(" ")
  exitCode: number;
  stderr: string;       // trimmed, may be empty; used verbatim in user-facing error messages
  cwd: string;          // the directory git ran in
  // message = stderr, or "<command> exited with code <n>" when stderr is empty
}
```

The `stderr` field is load-bearing: graft sync errors and worktree-creation alerts
surface it directly (see `describeSyncError` §4.6 and `worktreeErrorMessage` §6.6).

### 3.2 API surface

Each function below lists the exact git invocation(s) and output handling. The
`GitService` interface is `packages/daemon/src/git/service.ts:56-135`.

#### `scanForRepos(rootPath, maxDepth) -> ScannedRepo[]`

Pure filesystem walk (no git spawn), a standalone function in
`packages/daemon/src/git/scan.ts:46-76` rather than a `GitService` member.
Depth-first from `rootPath` (depth 0), up to `maxDepth` levels (`REPO_SCAN_MAX_DEPTH
= 3`; `repo-scan` passes its optional `max_depth`, §8.10):

- A directory containing a `.git` entry (**file or directory** — worktrees have a
  `.git` file) is a repo: record `{path, name: lastPathComponent}` and **do not
  recurse into it**.
- Hidden files/dirs are skipped when enumerating children.
- Symlinked directories are followed (the depth bound is the fence against loops);
  an unreadable directory is skipped rather than thrown from.
- Result sorted by `name`, case-insensitive ascending.

#### `getRemoteURL(repoPath) -> string | null`

`git remote get-url origin`. Trim; empty or any failure → null (never throws;
`packages/daemon/src/git/service.ts:278-285`).

#### `getCurrentBranch(path) -> string | null`

`git rev-parse --abbrev-ref HEAD`. Trim; empty → null. **Detached HEAD prints the
literal string `"HEAD"`**: callers (graft) treat that as a sentinel. Any failure →
null (never throws; `service.ts:253-260`).

#### `getStatus(path) -> RepoGitStatus`

1. `git status --porcelain`; split lines, drop empties.
2. Zero lines → `clean`.
3. Otherwise `git diff --shortstat HEAD` (note: **against HEAD**, so staged edits are
   counted too; plain `--shortstat` would miss stage-only changes). Errors here are
   swallowed (e.g. fresh repo with no HEAD) → additions/deletions 0.
4. Return `dirty(changedFiles: lineCount, additions, deletions)` where
   additions/deletions parse from the shortstat line.

`parseShortstat(text)`: split on `,`; for each part trim, take the leading integer;
if the part contains `"insertion"` set additions, if `"deletion"` set deletions.
Handles `" 3 files changed, 27 insertions(+), 12 deletions(-)"`,
`" 1 file changed, 5 insertions(+)"`, `""` → (0,0).

#### `createWorktree(repoPath, worktreePath, branchName)`

Try `git worktree add <worktreePath> <branchName>` (attach to an **existing**
branch). On any failure, fall back to
`git worktree add -b <branchName> <worktreePath>` (create a new branch off current
HEAD). The fallback's error is what propagates.

#### `createWorktreeFromBase(repoPath, worktreePath, branchName, baseRef)`

`git worktree add -b <branchName> <worktreePath> <baseRef>` — new branch based on an
explicit ref (e.g. `origin/main`). Used by the `--update-main` flow only.

#### `defaultBranch(repoPath) -> string`

Resolution order (each step falls through on failure/no match):

1. `git ls-remote --symref origin HEAD` — scan output lines starting with `ref:`;
   the ref token is the first whitespace-separated field after `ref:`; if it starts
   with `refs/heads/`, return the remainder. (Robust when the *local* `origin/HEAD`
   symref is unset, which is common and which `git fetch` does not create.)
2. `git symbolic-ref --short refs/remotes/origin/HEAD` — e.g. `origin/main`; return
   the substring after the first `/` (or the whole string if no `/`).
3. Literal `"main"`.

#### `fetch(repoPath, remote)`

`git fetch <remote>`. Blocking, no timeout.

#### `removeWorktree(repoPath, worktreePath)`

`git worktree remove <worktreePath>` (non-forcing — git refuses dirty/locked
worktrees and the primary checkout).

#### `listWorktrees(repoPath) -> WorktreeInfo[]`

`git worktree list --porcelain`, parsed line-by-line:

- `worktree <path>` starts a new entry (flushing the previous one).
- `branch refs/heads/<name>` → `branch = <name>` (strip `refs/heads/`).
- `bare` → mark the entry `isMain = true`.
- After parsing, the **first entry is always force-marked `isMain = true`** (git
  lists the main worktree first).

#### `pruneWorktrees(repoPath)`

`git worktree prune`.

#### `resolveRepoRoot(path) -> RepoRootInfo | null`

Maps any directory to its (worktreeRoot, parentRepoRoot) pair:

1. If `path` doesn't exist or isn't a directory → null (avoid spawning git for
   transient pwd values).
2. `git rev-parse --show-toplevel --git-common-dir` (one spawn, two output lines).
   Failure → null. Trim both lines; need ≥ 2 non-empty lines.
3. `worktreeRoot` = line 1. `commonDir` = line 2; if relative (e.g. `.git` for the
   main worktree), resolve against `worktreeRoot`.
4. Standardize `commonDir`; if its last path component is `.git`, the parent repo
   root is its parent directory; otherwise (bare repo — common dir *is* the repo)
   use the standardized common dir itself.
5. Return both paths standardized (`.`/`..` collapsed, but symlinks NOT resolved at
   this layer — graft canonicalizes further, §4.8).

For the main checkout, `worktreeRoot == parentRepoRoot`. For a linked worktree they
differ — that difference is graft's precondition.

#### `getDiff(repoPath, targetPath?) -> string`

`git diff --no-color` plus `-- <targetPath>` when targetPath is non-empty. Raw patch
text returned. (Feeds the diff pane; included here for API completeness.)

#### `resolveHeadPath(worktreePath) -> string`

`git rev-parse --git-path HEAD` → absolute path of the worktree's HEAD file. For the
main worktree this is `<repo>/.git/HEAD` (git may print it **relative**, e.g.
`.git/HEAD` — resolve against `worktreePath`); for a linked worktree it's
`<repo>/.git/worktrees/<name>/HEAD` (absolute). Standardize before returning. This
is the file `GitHeadWatcher` watches.

#### `stashPushIncludeUntracked(repoPath, message) -> string | null`

1. `git stash push --include-untracked -m <message>`. Exit code is 0 both when a
   stash was created and when there was nothing to stash — disambiguate by checking
   stdout for the substring `"No local changes to save"` → return null.
2. Otherwise `git rev-parse refs/stash` → trimmed SHA (empty → null).

The returned SHA (not a `stash@{N}` index) is what gets recorded, so the stash stays
addressable even if other stashes land later.

#### `stashPopRef(repoPath, stashRef)`

1. `git stash list --format=%H` → array of SHAs (index = stash position).
2. Find the index whose SHA equals `stashRef`. **Not found → silently succeed**
   (user dropped the stash; the rest of the stop sequence continues).
3. `git stash pop stash@{<index>}`. A conflict here throws (graft wraps it in
   `stashPopConflict`).

#### `addAllAndCommit(worktreePath, message, noVerify) -> string[]`

Not part of the service. The pre-port app carried this legacy commit-based-graft
primitive (`git add -A`; `git diff --name-only --cached` → staged paths; if none,
return `[]` without committing; else `git commit -m <message>`, appending
`--no-verify` when requested; return the staged paths). Nothing needs it, so the
`GitService` interface (`packages/daemon/src/git/service.ts:56-135`) omits it
(Compatibility rationale item 19).

#### `checkoutBranchForce(repoPath, branchOrSha)`

`git checkout -f <branchOrSha> --`.

#### `checkoutHeadForce(repoPath)`

`git checkout -f HEAD --` — discard working-tree changes without moving HEAD. Used
only as the legacy-breadcrumb restore fallback.

#### `repoState(repoPath) -> RepoState`

1. `git rev-parse --git-dir`; resolve relative output against `repoPath`.
2. Check for marker files/dirs inside that git dir, in order:
   `MERGE_HEAD` → merge; `rebase-merge` or `rebase-apply` → rebase;
   `CHERRY_PICK_HEAD` → cherryPick; `REVERT_HEAD` → revert; `BISECT_LOG` → bisect;
   otherwise `clean`.

Note "clean" here means *no operation in flight* — a dirty working tree is still
`clean` for this check. (For a linked worktree, `--git-dir` is the per-worktree dir
`.git/worktrees/<name>`, so an in-progress rebase in the worktree is detected there.)

#### `getHeadSha(repoPath) -> string`

`git rev-parse HEAD`, trimmed.

#### `resetHard(repoPath, sha)` / `resetMixed(repoPath, sha)`

`git reset --hard <sha>` / `git reset --mixed <sha>`.

#### `writeTreeForWorktree(worktreePath) -> string`

The worktree-side sync primitive. Computes a tree SHA representing "the worktree's
current content as one committable snapshot" **without touching the worktree's real
index**:

```
tempIndex = <tmpdir>/kelpi-graft-index-<uuid>       // deleted afterwards (best-effort)
env = { GIT_INDEX_FILE: tempIndex }               // merged over inherited env
git read-tree HEAD          (cwd=worktree, env)   // seed temp index from HEAD's tree
git add -A                  (cwd=worktree, env)   // stage every change into the temp index
git write-tree              (cwd=worktree, env)   // -> tree SHA (trimmed)
```

Because `add -A` runs against the temp index, untracked (non-ignored) files are
included in the snapshot; the user's real staging state is untouched.

#### `readTreeInto(repoPath, treeSha)`

The parent-side sync primitive: `git read-tree --reset -u <treeSha>` — reset the
parent's index to the tree AND update the working tree to match. Tracked files that
differ are overwritten; tracked files absent from the tree are deleted; untracked
files in the parent are preserved. HEAD/branch refs are untouched.

Failure mode to know: older gits refused to clobber an **untracked** parent file at a
path that is **tracked** in the incoming tree, with stderr
`error: Untracked working tree file '<path>' would be overwritten by merge.`
The git the daemon runs (2.50+) overwrites the file silently and the session stays
`watching`. `describeSyncError` (§4.6) still renders that stderr as `Sync blocked - ...`
for the older case, but the current tests assert the clobber
(`packages/daemon/tests/compat/graft.test.ts:359-378`,
`packages/daemon/src/graft/service.test.ts:236-270`).

#### `toplevel(directory) -> string | null`

`git rev-parse --show-toplevel` in `directory` (`packages/daemon/src/git/service.ts:346-355`).
Returns null without spawning when `directory` does not exist or is not a directory;
otherwise the first non-empty output line, path-normalized, or null on any git
failure.

#### `worktreeAdd(request)`

The shared `performWorktreeAdd` of §8.3 as a service member
(`service.ts:326-345`). `request = {repoPath, worktreePath, branchName, updateMain,
remote?}`; `remote` defaults to `origin` and names both the remote fetched and the
`<remote>/<default>` base ref when `updateMain` is set.

#### `sweepGraftTempIndexes(directory = os.tmpdir(), now, maxAgeMs = 24h) -> number`

Standalone helper (`service.ts:210-234`), not a `GitService` member. Best-effort
deletion of `kelpi-graft-index-*` files in the temp dir whose mtime is older than 24
hours; younger files are left alone because another daemon may be mid-`write-tree`.
Returns the number of files removed; never throws (an unreadable directory counts as
zero). The daemon calls it once at boot (`packages/daemon/src/boot/compose.ts:1543`),
which is the startup sweep Compatibility rationale item 18 describes.

---

## 4. GraftService — the sync engine

A singleton service (`packages/daemon/src/graft/service.ts`) owning all active graft
sessions. All state lives in maps keyed by association id; the single-threaded event
loop is the mutex, so every "lock { ... }" block below is a synchronous step with no
`await` inside it. Sessions do NOT survive daemon restart (that's what breadcrumbs are
for).

Internal state (`service.ts:163-169`):

```ts
sessions:        Map<assocId, GraftSession>
watcherTasks:    Map<assocId, {watcher, pending}>  // the recursive FS watch + "a batch landed
                                                   // mid-pass" flag (code name: `watchers`; §4.3)
activeSyncTasks: Map<assocId, Promise>    // the currently-running sync pass, if any (code: `activeSync`)
startingRoots:   Set<string>              // canonical parent roots with a start() mid-flight
startTasks:      Map<assocId, Promise>    // in-flight start() work, awaited by a racing stop() (§4.4)
stopTasks:       Map<assocId, Promise>    // in-flight stop() work, for coalescing
subscribers:     Set<listener>            // updates() listeners (§4.9)
```

### 4.1 The lock model (issue #231) — derive claims from sessions

**Invariant: there is no standalone "busy roots" registry.** A parent root is
claimed iff (a) it is in `startingRoots` (a `start()` is mid-flight, before the
session is published) or (b) some live session's `parentRepoRoot` equals it. The
`alreadyActive` check computes this union on demand.

Why: an earlier design kept a separate busy set; a removal path dropped the session
without releasing the set, leaving a root permanently rejected with `alreadyActive`
that neither `graft status` nor `graft stop` could see or clear until app restart
(issue #231). Deriving the claim from `sessions` guarantees whatever holds a claim
is always visible via `activeSessions()` and releasable via `stop()`.

Corollaries baked into the rest of the system:

- `graft-status` and `graft-stop` consult the **service's** sessions, never the UI
  mirror (§7).
- Every association-removal path (workspace delete, repo removal, association
  removal, auto-unlink, cascade deletes) dispatches an unconditional `forceStop`
  through the service — a no-op for ids the service doesn't know (§8.3).
- When a start fails with `alreadyActive` and the UI mirror has no session for that
  root, the UI queries the service to find the hidden owner and offers the swap
  prompt (§6.3).

### 4.2 `start(association) -> GraftSession` (throws GraftError)

```
worktreePath = association.worktreePath

info = resolveRepoRoot(worktreePath)               // §3
if !info: throw missingWorktree(worktreePath)
parentRepoRoot = canonicalize(info.parentRepoRoot) // §4.8
worktreeRoot   = canonicalize(info.worktreeRoot)

// Refuse grafting the main checkout onto itself.
if worktreeRoot == parentRepoRoot: throw notAWorktree(worktreePath)

// Claim the root (atomically with the check):
lock {
  claimed = startingRoots.has(parentRepoRoot)
         || any(sessions.values, s => s.parentRepoRoot == parentRepoRoot)
             // NOTE: sessions in ANY status count, including .error
  if claimed: throw alreadyActive(parentRepoRoot)
  startingRoots.add(parentRepoRoot)
}
// From here every failure path must release startingRoots.

// Parent must have no operation in flight:
state = repoState(parentRepoRoot)                  // errors → release claim, rethrow
if state != clean: release; throw repoBusy(describe(state))
   // describe: "merge in progress", "rebase in progress", "cherry-pick in progress",
   //           "revert in progress", "bisect in progress" (git/status.ts:34)

// Capture parent restore points BEFORE touching anything:
preGraftBranch = getCurrentBranch(parentRepoRoot)  // may be literal "HEAD" (detached);
                                                   // never throws: a failing read records
                                                   // null, which restoreParent (§4.7) treats
                                                   // like the detached sentinel (reset only)
preGraftSha    = getHeadSha(parentRepoRoot)        // errors → release claim, rethrow

// Auto-stash the parent's uncommitted changes (incl. untracked):
stashRef = null
if getStatus(parentRepoRoot) is dirty:
  stashRef = stashPushIncludeUntracked(parentRepoRoot, "kelpi-graft:" + association.id)
  // errors → release claim, rethrow

// Any later failure runs rollbackAfterStash(originalError):
//   if stashRef: try stashPopRef(parent, stashRef)
//     if the pop ALSO fails: best-effort write a breadcrumb
//       {version:1, stashed:true, assocId, stashRef, worktreePath,
//        branch: association.branchName ?? "HEAD",
//        preGraftBranch, preGraftSha, worktreePreGraftSha: null}
//       so the user has a recovery path on next launch
//   release startingRoots
//   rethrow the ORIGINAL error (never mask it with the pop failure)

// Resolve the worktree's branch (display + breadcrumb only — the tree-based sync
// never uses it to move refs):
branch = getCurrentBranch(worktreePath)            // "HEAD" literal if detached
      ?? association.branchName
      ?? "HEAD"
// getCurrentBranch never throws (§3.2); a failed read is null and falls through to
// association.branchName ?? "HEAD". The rollbackAfterStash catch around this step
// (service.ts:336-341) is therefore unreachable in practice and kept as a guard.

worktreePreGraftSha = null   // tree-based design never rewinds the worktree

// Persist the breadcrumb BEFORE the initial sync — a crash after this point is
// recoverable on relaunch:
writeBreadcrumb(parentRepoRoot, {version:1, stashed: stashRef != null,
  assocId: association.id, stashRef, worktreePath, branch,
  preGraftBranch, preGraftSha, worktreePreGraftSha: null})
// errors → rollbackAfterStash

// Initial sync (same code path as every later batch):
try runSyncPass(worktreePath, parentRepoRoot)      // §4.5
catch e:
  removeBreadcrumb(parentRepoRoot)                 // nothing half-grafted on disk
  rollbackAfterStash(e)

session = { id: association.id, worktreePath, parentRepoRoot, branch,
            status: watching, stashRef, lastSync: now(),
            preGraftBranch, preGraftSha, worktreePreGraftSha: null }

// Atomically publish + transfer the claim from startingRoots to the session
// (no gap a concurrent start could slip through):
lock { sessions.set(id, session); startingRoots.delete(parentRepoRoot) }
emit started(session)

// Spawn the watcher loop (see §4.4) and register it in watcherTasks under the
// SAME lock hold that creates it.
return session
```

Behavioral notes:

- The breadcrumb's message tag `kelpi-graft:<assocId>` makes the auto-stash
  identifiable in `git stash list`.
- The `alreadyActive` check counts `.error` sessions: a live session that failed a
  sync still owns the watcher, the claim, and the breadcrumb.
- `start` on an association whose worktree path doesn't exist / isn't a repo →
  `missingWorktree`.

### 4.3 File watching per session

Each session runs a recursive FS watcher on `worktreePath` (see §9.1 for watcher
semantics): batches of changed paths, debounce **500ms**, ignoring any path with a
component in `{".git", "node_modules", "target", ".DS_Store"}`.

The consumer loop is **serial** — one batch handled at a time:

```
for await batch in watchStream:
  // Atomically: only spawn a sync task if this session's watcher is still
  // registered (stop() removes the registration first — this check makes
  // stop-vs-new-batch a total order and prevents a sync from landing after
  // the parent has been restored):
  syncTask = lock {
    if !watcherTasks.has(assocId): return null    // stop happened → exit loop
    t = spawn handleBatch(assocId, batch)
    activeSyncTasks.set(assocId, t)
    return t
  }
  if syncTask == null: return
  await syncTask
  lock { activeSyncTasks.delete(assocId) }        // no-op if stop() already took it
```

`handleBatch(assocId, batch)`:

```
session = sessions.get(assocId); if !session: return
setStatusAndEmit(assocId, syncing)                // emit updated(...)
try:
  runSyncPass(session.worktreePath, session.parentRepoRoot)
  mutateAndEmit(assocId, s => { s.status = watching; s.lastSync = now() })
catch e:
  mutateAndEmit(assocId, s => { s.status = error(describeSyncError(e)) })
  // The session STAYS ALIVE: watcher keeps running; the next batch retries
  // (an error status does not block handleBatch).
```

The batch's path list is currently unused beyond triggering the pass (no
changed-paths log is kept).

The daemon implements this loop as a per-session `pending` flag drained by a serial
`pump` (`packages/daemon/src/graft/service.ts:122-126`, `service.ts:228-262`): the
watcher's `onBatch` sets `watchers.get(id).pending = true` and calls `pump(id)`;
`pump` returns immediately if a pass is already in `activeSync` or the watcher entry
is gone (stop happened), otherwise clears the flag, runs `handleBatch` and re-runs
itself when the pass settles. Any number of batches that land during a pass collapse
into exactly one follow-up pass, which is the same outcome as queueing them since
batch contents are unused.

### 4.4 `stop(associationID)` (throws)

Concurrent stops for the same id **coalesce**: the first caller creates the stop
task and registers it in `stopTasks`; later callers await the same task and get its
real outcome (success or the thrown error). The owner removes the entry when done.
This matters because removal paths fire `forceStop` unconditionally and the CLI can
stop concurrently — a second initiator must neither re-run the restore + stash pop
(spurious conflict) nor report "stopped" before teardown actually finished.

The actual teardown (`performStop`):

```
// 1. Cancel the watcher FIRST so no NEW sync pass can begin. Runs even for ids
//    with no session — stop is a thorough no-op cleanup.
task = lock { watcherTasks.delete(assocId) }; task?.cancel()

// 2. Await any sync pass already in flight. Without this, a pass sitting inside
//    read-tree survives the cancel and re-applies the worktree's tree AFTER the
//    restore below, corrupting the parent and breaking the stash pop.
inFlight = lock { activeSyncTasks.delete(assocId) }; await inFlight

// 3. No session? Done (idempotent no-op).
session = sessions.get(assocId); if !session: return

// 4. Legacy-only: rewind the worktree if a pre-graft SHA was recorded
//    (only true for sessions recovered from old commit-based breadcrumbs).
//    Best-effort — failure never blocks the parent restore.
if session.worktreePreGraftSha && dirExists(session.worktreePath):
  try resetMixed(session.worktreePath, session.worktreePreGraftSha)

// 5. Restore the parent (see §4.7).
try restoreParent(session.parentRepoRoot, session.preGraftBranch, session.preGraftSha)
catch e:
  // LEAVE the breadcrumb (recovery banner picks it up next launch — the user's
  // stash is still on disk). Drop the in-memory session so the root claim is
  // released and the toggle reflects reality.
  lock { sessions.delete(assocId) }; emit stopped(assocId); throw e

// 6. Pop the auto-stash.
if session.stashRef:
  try stashPopRef(session.parentRepoRoot, session.stashRef)
  catch e:
    // Conflict: leave stash AND breadcrumb on disk; drop the session; surface
    // a typed error so the caller can tell the user.
    lock { sessions.delete(assocId) }; emit stopped(assocId)
    throw stashPopConflict(session.stashRef, String(e))

// 7. Clean exit.
removeBreadcrumb(session.parentRepoRoot)
lock { sessions.delete(assocId) }
emit stopped(assocId)
```

Stop-during-start: before step 1, `performStop` first awaits any in-flight `start()`
for the same id (tracked in `startTasks`, registered by `start()` and released when
the start settles; `packages/daemon/src/graft/service.ts:393-401`,
`service.ts:422-433`), swallowing the start's failure. A stop that races a start
therefore tears down the published session instead of leaving an ownerless one
behind; a failed start owns nothing and the cleanup below is still correct. This
closes the window the pre-port app accepted (Compatibility rationale item 17).
`graft stop --repo <path>`'s orphan fallback (§7.3) is kept as the escape hatch for
sessions whose associations were deleted.

### 4.5 `runSyncPass(worktreePath, parentRepoRoot)` (throws)

Runs for the initial sync and every batch:

```
// 1. Parent must still be operation-free. A user running `git merge` in the
//    parent between syncs must not have it wiped by read-tree. Abort this pass;
//    the session stays alive and the next batch retries.
if repoState(parentRepoRoot) != clean: throw repoBusy(...)

// 2. Worktree directory must still exist (user may have rm -rf'd it).
if !dirExists(worktreePath): throw missingWorktree(worktreePath)

// 3. Worktree must also be operation-free — otherwise write-tree would snapshot
//    conflict markers (`<<<<<<<`) mid-merge and mirror them into the parent.
if repoState(worktreePath) != clean: throw repoBusy(...)

// 4. Snapshot the worktree via the throw-away index (§3 writeTreeForWorktree).
tree = writeTreeForWorktree(worktreePath)

// 5. Apply to the parent (§3 readTreeInto): overwrites index + working tree,
//    preserves parent's HEAD/branch and untracked files.
readTreeInto(parentRepoRoot, tree)
```

### 4.6 Sync error rendering (`describeSyncError`)

For a `GitCommandError` with non-empty stderr (`packages/daemon/src/graft/errors.ts:124-131`):

- stderr containing `"Untracked working tree file"` (an older read-tree refusing to
  clobber a parent untracked file that the worktree tracks) →
  `"Sync blocked - <first line of stderr>"` (ASCII hyphen; `errors.ts:129`,
  asserted by `errors.test.ts:58-64`). The path in the message is the file the user
  must remove or commit in the parent. This branch is only reachable on gits that
  still refuse; the daemon's supported git overwrites the file instead (§3.2
  `readTreeInto`).
- otherwise → `"Sync failed: <stderr>"`.

Any other error → `"Sync failed: <stringified error>"`.

This string becomes `session.status.error.message`, shown in the tooltip and in
`graft status` output.

### 4.7 `restoreParent(parentRepoRoot, preGraftBranch?, preGraftSha?)`

```
if !preGraftSha:                       // very old breadcrumbs predate the capture
  checkoutHeadForce(parentRepoRoot)    // best-effort: clears working-tree drift only
  return
if preGraftBranch && preGraftBranch != "" && preGraftBranch != "HEAD":
  checkoutBranchForce(parentRepoRoot, preGraftBranch)  // git checkout -f <branch> --
resetHard(parentRepoRoot, preGraftSha)                 // git reset --hard <sha>
```

`"HEAD"` sentinel = parent was detached at start; skip the branch switch and let the
reset land on the detached position. Under the tree-based design HEAD never moved,
so this is effectively a working-tree+index restore — but the same path also rewinds
checkpoint commits when recovering a legacy breadcrumb.

### 4.8 Path canonicalization

`canonicalize(path)` = standardize (expand `.`/`..`, clean up) **then resolve
symlinks**. On macOS this maps `/tmp/...` → `/private/tmp/...`. All
`parentRepoRoot` comparisons (claims, orphan matching, `--repo` path matching) use
canonicalized paths. The socket layer's `standardizedPath` helper additionally
expands `~` before doing the same (for CLI-supplied `--repo` args, §7.3).

### 4.9 `activeSessions()`, `updates()`

- `activeSessions()` → snapshot array of all sessions (undefined order).
- `updates(listener) → unsubscribe` (`packages/daemon/src/graft/service.ts:549-554`):
  the listener receives every `started`/`updated`/`stopped` event from registration
  on; calling the returned function unregisters it. A listener that throws is
  reported through `onError` and does not stop delivery to the others.
- Also on the service (`service.ts:70-93`): `session(id)` → the snapshot of one
  session or null; `claimedRoots()` → `startingRoots ∪ live session roots`
  (`service.ts:610-614`, used by the orphan refresh in §4.10 and §7.7); `shutdown()`
  → the clean-quit flush of §5.

### 4.10 Orphans (crash recovery)

`detectOrphans(parentRepoRoots: string[]) -> GraftOrphan[]`

For each root (canonicalized), read `<root>/.git/kelpi-graft-active`; if a valid
version-1 breadcrumb exists, produce an orphan (id = `assocId` parsed as UUID, or a
fresh random UUID when unparseable). Called once at daemon boot with the deduped set
of registered repo paths: `unique(repoRegistry.map(r => r.path))`
(`packages/daemon/src/boot/compose.ts:1547-1562`); the result fills the orphan
registry behind the inspector banner and is broadcast as `graft-orphans` (§7.7).

Detection also re-runs on demand: `graft-session-list {refresh:true}`
(`packages/daemon/src/ws/graft.ts:161-172`) re-scans every registered repo for a
breadcrumb, drops any orphan whose `parentRepoRoot` is in `claimedRoots()` (a healthy
live graft has a breadcrumb on disk by design, and reporting it as interrupted would
be wrong), and replaces the registry wholesale. The client sends `refresh: true` on
every connect and every inspector open (`packages/client/src/app/graft.ts:334-347`).
This is a deliberate superset of the once-at-launch scan: the daemon runs for days and
repos are registered after boot, so a breadcrumb inside a repo added later would
otherwise go unnoticed until the next restart.

`recoverOrphan(orphan)` (throws) — mirrors the stop sequence using breadcrumb data:

```
if orphan.worktreePreGraftSha && dirExists(orphan.worktreePath):
  try resetMixed(orphan.worktreePath, orphan.worktreePreGraftSha)   // best-effort
restoreParent(orphan.parentRepoRoot, orphan.preGraftBranch, orphan.preGraftSha)
if orphan.stashRef:
  stashPopRef(...) — on failure throw stashPopConflict(stashRef, underlying)
removeBreadcrumb(orphan.parentRepoRoot)
```

Any failure leaves the breadcrumb on disk so recovery can be retried.

`dismissOrphan(orphan)` — delete the breadcrumb only. The stash (if any) stays in
`git stash list`; the parent is left as-is.

---

## 5. Clean-quit flush

On daemon shutdown (before termination proceeds): stop **every session the
service holds** (not a UI mirror), with a hard cap of **2 seconds** total
(`GRAFT_SHUTDOWN_GRACE_MS`, `packages/daemon/src/graft/service.ts:45`); sessions
that can't stop in time fall back to the breadcrumb/orphan-recovery path on next
launch. `GraftService.shutdown()` (`service.ts:594-608`) races
`Promise.allSettled(stop(id) for every session)` against the grace delay, then closes
every remaining OS watch regardless so the process can exit. The daemon's stop
sequence awaits it (`packages/daemon/src/boot/compose.ts:1264`) on SIGTERM/SIGINT and
on `kelpid stop`, before the final state flush. Purpose: a clean quit must not leave
`kelpi-graft-active` breadcrumbs behind, or the recovery banner would fire on every
launch.

---

## 6. Graft UI feature (state machine for the web client)

The client keeps a **mirror** of sessions plus UI-only state:

```ts
interface GraftUIState {
  sessions: GraftSession[];       // keyed by association id
  orphans: GraftOrphan[];         // drives the recovery banner
  swapPrompt: GraftSwapPrompt | null;
}
interface GraftSwapPrompt {
  id: string;                     // == newAssociation.id (dedupes repeat prompts)
  newAssociation: RepoAssociation;
  existingSessionID: string;
  existingBranch: string;
  existingWorktreePath: string;
  parentRepoRoot: string;
}
```

The mirror is best-effort; the **service is the source of truth** and several flows
below exist to re-converge the two (issue #231). The reducer is
`packages/client/src/state/graft.ts`, the flows (toggle, swap, orphan recovery) are
`packages/client/src/app/graft.ts`, and the button, banner and dialog are
`packages/client/src/chrome/GraftControls.tsx`. The client talks to the daemon over
the WS-only verbs of §7.7.

### 6.1 Launch

`onAppLaunched(parentRepoRoots)`:
1. Subscribe to the service's `updates()` stream; apply events to the mirror:
   `started`/`updated` upsert by id, `stopped` removes. (Resubscribing cancels the
   prior subscription.)
2. `detectOrphans(parentRepoRoots)` → replace `orphans` wholesale.

On a **first launch** (no persisted workspaces) this is still dispatched with an
empty roots array so the updates subscription installs — otherwise a CLI-started
graft on first run would be invisible to status/stop/quit-flush.

In the daemon/client split both steps live daemon-side: the daemon subscribes to the
service at boot (`packages/daemon/src/boot/compose.ts:967-969`) and runs
`detectOrphans` over the registry (§4.10). The client's equivalent is `sync()`
(`packages/client/src/app/graft.ts:334-347`): on every connect and inspector open it
sends `graft-session-list {refresh:true}` (§7.7), merges the returned sessions into
the mirror (`mergeSessions`, `packages/client/src/state/graft.ts:107-118`: the
daemon's list is authoritative, and only this client's own `starting`/`error`
placeholders survive it), and replaces `orphans` wholesale. Between syncs the
`graft-changed` and `graft-orphans` broadcasts (§7.7) drive the same two reducers.

### 6.2 Toggle (per-association button)

`toggleGraft(association)`:

- **No mirror session** → optimistic UX: insert a placeholder session
  `{id: assoc.id, worktreePath, parentRepoRoot: "", branch: assoc.branchName ?? "",
  status: starting}` so the icon flips instantly, then call service `start`:
  - success → replace placeholder with the real session (`startSucceeded`);
  - failure → `startFailed` (see 6.3).
- **Mirror session with status `error`** → "retry" semantics: remove the mirror
  entry, then service `stop(assoc.id)` first (the errored session may still own the
  watcher/claim/breadcrumb — a placeholder from a failed start owns nothing, and
  stop is a no-op for it):
  - stop succeeds → re-dispatch `toggleGraft` (fresh start attempt);
  - stop fails → do NOT retry-start (a fresh start would overwrite the recovery
    breadcrumb and orphan the stash). Show error:
    `"Couldn't unwind the previous graft: <err>. Resolve the repo state, then toggle to retry."`
- **Mirror session in any other status** → service `stop(assoc.id)`:
  - success → `stopSucceeded` removes the mirror entry;
  - failure → `stopFailed` sets the mirror session's status to `error(<stringified>)`
    (red dot + tooltip; the toggle now offers the retry path above).

### 6.3 Start failure handling

`startFailed(association, failure)` — first always remove the optimistic
placeholder, then:

- `failure = alreadyActive(parentRepoRoot)`:
  1. If the mirror has a session whose `parentRepoRoot` matches → set `swapPrompt`
     from it. Done.
  2. Otherwise query service `activeSessions()`:
     - found an owner with `owner.id == association.id` → the service session IS
       this association; the mirror simply lost track. Re-adopt it into the mirror
       (shown as active), **no prompt** (swapping with itself is meaningless).
     - found a different owner → re-adopt the owner into the mirror (so it is
       visible in the inspector and stoppable if the user cancels) AND set
       `swapPrompt`.
     - no owner visible (e.g. a start on the same root is mid-flight, claim held by
       `startingRoots`) → surface an error session:
       `"Another graft is already active for <root>. Stop it first, then retry."`
- `failure = other(message)` → re-insert an error-status session
  `{id, worktreePath, parentRepoRoot: "", branch: assoc.branchName ?? "",
  status: error(message)}` so the red dot/tooltip persists until retried.

### 6.4 Swap prompt

Shown as a confirmation dialog:

- Title: `Already grafting into <lastPathComponent(parentRepoRoot)>`
- Message: `"<existingBranch> (<existingWorktreeName>) is already grafting into this
  repository. Only one graft per parent repo is allowed. Swap to mirror <newBranch>
  (<newWorktreeName>) instead, or keep the existing graft and resolve manually."`
  (`newBranch` falls back to the new worktree's folder name when the association has
  no branchName.)
- Buttons: **"Stop existing & swap"** (destructive) and **"Keep existing"** (cancel).
  Dismissing the dialog = cancel.

`confirmSwap(prompt)`: clear the prompt; insert an optimistic `.starting`
placeholder for the new association; then **sequentially**:

1. service `stop(prompt.existingSessionID)`. On failure → `startFailed(other:
   "Couldn't stop the existing graft: <err>. The existing graft is still active; the
   new one was not started.")` and abort (the existing graft survives).
2. service `start(prompt.newAssociation)`. On failure → `startFailed(other:
   "Existing graft was stopped, but the new graft failed to start: <err>. Toggle the
   icon again to retry.")` (both sides gone — say so clearly).

`cancelSwap`: clear the prompt; the existing session keeps running.

### 6.5 forceStop (removal paths)

`forceStop(assocID)` — dispatched by every path that deletes an association
(workspace delete, bulk delete, group cascade delete, repo removal, association
removal, auto-unlink). Always calls service `stop(assocID)` regardless of what the
mirror thinks (issue #231); never retry-starts. Success removes the mirror session;
failure marks it `error` (if a mirror entry exists). For ids the service doesn't
know, stop is a cheap no-op.

### 6.6 Visuals (recreate in web UI)

Per-association toggle button in the workspace inspector, next to each repo row:

- Icon: circular-arrows glyph; "filled" variant when a session exists.
- Status dot (top-trailing overlay, ~5px):
  - `starting` → solid yellow
  - `syncing` → yellow, **pulsing** (distinguishes an actively-syncing session from
    a stuck start at a glance)
  - `watching` → green
  - `error` → red
- Tooltips:
  - no session: `"Mirror <branch|this worktree>'s tracked files into the parent
    repo's working tree. Parent's branch stays put; untracked files (node_modules,
    build output) are untouched."`
  - starting: `"Starting graft..."`
  - syncing: `"Syncing <branch>..."`
  - watching: `"Mirroring <branch> into the parent. Last sync <relative time |
    "Watching">. Stop to restore the parent's working tree."`
  - error: `"Graft error: <message>"`

Orphan recovery banner (above the repo association list in the inspector), one per
orphan: warning triangle, title **"Graft was interrupted"**, subtitle = parent repo
folder name, buttons **Restore** (`recoverOrphan`) and **Dismiss** (`dismissOrphan`).
`recoverOrphan` removes the banner optimistically; if recovery fails (typically a
stash-pop conflict) the orphan is re-inserted so the banner reappears (the
breadcrumb + stash are still on disk and the user needs a retry affordance). The
error string is logged; banner copy stays generic.

---

## 7. `graft-*` wire verbs

All three are request/response commands (in the reply allowlist): the server sends
one newline-terminated JSON object then closes the connection (EOF ends the CLI
read). Requests are single-line JSON with a `"command"` key.

### 7.1 Scope resolution (start/stop)

Request fields: `workspace` (name-or-UUID), `repo` (name or path), `pane_id`
(UUID string; the CLI only includes it when neither `--workspace` nor `--repo` was
passed). Empty strings are normalized to absent.

`resolveGraftAssociations(workspaceFilter, repoFilter, paneID)`
(`packages/daemon/src/handlers/app/graft.ts:56-108`):

```
if workspaceFilter:
  ws = resolveWorkspaceLenient(workspaceFilter)  // lenient: a UUID-shaped token matches
                                                 // by id; else the FIRST workspace whose
                                                 // name matches case-insensitively; else a
                                                 // workspace whose slug equals the token
                                                 // (duplicate names are not rejected; the
                                                 // same resolver pane-move-to-workspace
                                                 // uses, packages/core/src/resolve/workspace.ts:59-71)
  if !ws: FAIL "workspace not found: <filter>"
  scope = [ws]
else if paneID:
  ws = workspaceContainingPane(paneID)       // parked panes included
  if !ws: FAIL "no workspace contains the requesting pane"
  scope = [ws]
else if repoFilter:
  scope = allWorkspaces                      // repo-only filter searches everywhere
else:
  FAIL "graft requires --workspace, --repo, or KELPI_PANE_ID"
       // literal reply text (handlers/app/graft.ts:41); the CLI reads KELPI_PANE_ID (§7.5)

results = []
for ws in scope, assoc in ws.repoAssociations:
  if repoFilter:
    matches = assoc.worktreePath == repoFilter
           || lastPathComponent(assoc.worktreePath) == repoFilter
           || repoRegistry[assoc.repoID]?.name == repoFilter
    if !matches: continue
  results.push(assoc)
if results.empty: FAIL "no repo associations matched the requested scope"
```

Workspace + repo filters compose (repo filters within the one workspace).

### 7.2 `graft-start`

Request examples:

```json
{"command":"graft-start","pane_id":"5E9C1B4E-6C1D-4A6B-9A87-2C51F0B0D001"}
{"command":"graft-start","workspace":"feature-x"}
{"command":"graft-start","repo":"my-feature"}
{"command":"graft-start","workspace":"feature-x","repo":"/Users/ben/kelpi/worktrees/my-feature"}
```

Handler (`packages/daemon/src/handlers/app/graft.ts:112-160`): resolve scope (failure
→ `{"ok":false,"error":"<msg>","error_kind":"scope"}`); then for each
association in scope call service `start(assoc)`, collecting successes and the last
error. Reply:

- all failed / none started:
  `{"ok":false,"error":"<last error message>","error_kind":"<kind>"}`
  (fallback text `"graft start failed"` if somehow no error was captured)
- all started:
  ```json
  {"ok":true,"started":[
    {"association_id":"5E9C...","worktree_path":"/Users/ben/kelpi/worktrees/my-feature",
     "branch":"feature/x","parent_repo_root":"/Users/ben/code/myrepo"}]}
  ```
- partial:
  `{"ok":true,"started":[...],"partial_error":"<last error>","partial_error_kind":"<kind>"}`

CLI rendering (`kelpi graft start [--workspace ..] [--repo ..]`): on `ok:false` the CLI
prints `kelpi graft-start: <error>` to stderr and exits 1. On success, one line per
entry: `started <branch> (<association_id>) at <worktree_path>`; empty list prints
`No associations started.`; `partial_error` prints
`Partial failure: <msg>` to stderr (exit code stays 0).

Note: error strings are human-readable prose built by `GraftError`
(`packages/daemon/src/graft/errors.ts:54-101`), e.g.
`another graft is already active for /Users/ben/code/myrepo`,
`repository is busy: merge in progress`,
`worktree not found or not a git checkout: <path>`,
`<path> is the repository's main checkout, not a linked worktree`,
`couldn't restore the parent's stashed changes (stash <sha>): <underlying>`
(the compat test `packages/daemon/tests/compat/graft.test.ts:269` asserts the prose).
Every `ok:false` reply also carries a machine-readable `error_kind`
(`alreadyActive | repoBusy | missingWorktree | branchResolutionFailed |
stashPopConflict | notAWorktree | unknown`, or `scope` when resolution failed before
the engine ran; `handlers/app/graft.ts:41-46`, `:124-157`); a partial start adds
`partial_error_kind`. See Compatibility rationale item 7.

### 7.3 `graft-stop`

Request shape identical to `graft-start`.

Handler (`packages/daemon/src/handlers/app/graft.ts:179-267`):

1. Resolve scope. A resolution **failure is non-fatal iff** `repo` was supplied and
   `workspace` was not — the owning association may have been deleted with its
   workspace (issue #231) and only the service still knows the session; proceed with
   an empty association set so the fallback below can match it. Any other failure
   (no scope at all, unknown workspace, pane not found) → `{"ok":false,"error":...}`.
2. Fetch **service** `activeSessions()` (never the UI mirror).
   `targetIDs = active ids ∩ resolved association ids`.
3. **Orphan fallback** (only when `repo` filter present): additionally match any
   active session not already targeted where `repoFilter` (as given, or
   tilde-expanded + standardized + symlink-resolved) equals any of:
   `session.worktreePath`, its last path component, `session.parentRepoRoot`, or its
   last path component.
4. No targets → `{"ok":true,"stopped":[]}` (CLI prints `No active sessions in
   scope.`).
5. For each target call service `stop(id)`; collect successes and failures. Reply:

```json
{"ok":true,"stopped":["5E9C1B4E-..."]}
{"ok":false,"stopped":["5E9C1B4E-..."],
 "failed":[{"association_id":"AB12...",
            "error":"couldn't restore the parent's stashed changes (stash deadbeef42...): ...",
            "error_kind":"stashPopConflict"}],
 "error":"couldn't restore the parent's stashed changes (stash deadbeef42...): ...",
 "error_kind":"stashPopConflict"}
```

`ok` is `failures.isEmpty`.

CLI rendering quirk (see Compatibility rationale item 8): the `ok:false` stop reply
also carries a summary `error` (the single failure's message, or
`<n> graft sessions failed to stop: <m1>; <m2>`) and the first failure's
`error_kind` beside `stopped`/`failed` (`handlers/app/graft.ts:242-262`). The CLI runs
the generic `{ok,error?}` envelope check first (`packages/cli/src/reply.ts:35-45`), so
it prints `kelpi graft-stop: <error>` and exits 1 **before** its per-id `failed`
renderer (`packages/cli/src/commands/graft.ts:86-92`) runs; that renderer only
executes on `ok:true` replies, where `failed` is never present. `failed[]` stays in
the reply for clients that render it.

### 7.4 `graft-status`

Request: `{"command":"graft-status"}` — no scope parameters.

Reply reports the **service's** sessions (source of truth — a session the UI mirror
lost must still show up here so every `alreadyActive` rejection is explainable):

```json
{"ok":true,"sessions":[
  {"association_id":"5E9C1B4E-...",
   "worktree_path":"/Users/ben/kelpi/worktrees/my-feature",
   "parent_repo_root":"/Users/ben/code/myrepo",
   "branch":"feature/x",
   "status":"watching",
   "stash_ref":"deadbeef42...",
   "last_sync":"2026-08-18T09:30:12Z"}]}
```

Per-session JSON (`graftSessionEntry`, `packages/daemon/src/graft/wire.ts:14-27`):
`status` ∈ `"starting" | "watching" | "syncing" | "error"`; when error, an `"error"`
key carries the message. `stash_ref` and `last_sync` (ISO 8601, second precision)
are present only when set.

CLI: `kelpi graft status [--json]` — `--json` prints the sessions array (sorted keys);
otherwise `No active graft sessions.` or one line per session:
`<branch> [<status>] <worktree_path>`.

### 7.5 CLI command surface

```
kelpi graft start [--workspace <name-or-uuid>] [--repo <name-or-path>]
kelpi graft stop  [--workspace <name-or-uuid>] [--repo <name-or-path>]
kelpi graft status [--json]
```

With no filters, start/stop send `pane_id` from `$KELPI_PANE_ID` (caller's workspace
scope; `packages/cli/src/commands/graft.ts:55`, `packages/cli/src/env.ts:36`). Unknown
action → usage error, exit 1.

### 7.6 Reply-envelope conventions (context)

The CLI's request/response framing: send one JSON line, read until EOF with a
5-second receive timeout (`KELPI_REPLY_TIMEOUT` env overrides; `workspace create
--worktree` uses a 120s override because `git worktree add` + `git fetch` can be
slow). Transport failure / empty reply / invalid JSON / `ok:false` → stderr message +
exit 1.

### 7.7 WS-only graft verbs and broadcasts

The web client does not use the three socket verbs above: it addresses one
association row, needs typed failures, and must be able to recover a breadcrumb,
which has no CLI verb. `packages/daemon/src/ws/graft.ts` therefore exposes five
**WS-only, association-scoped** commands (`ws/graft.ts:57-63`), matched before the
socket decoder like the other WS-only families. Every reply reads from the service,
never from a client mirror (issue #231):

- `graft-session-list {refresh?}` → `{ok:true, sessions:[...], orphans:[...]}`. The
  client's initial sync and the §6.3 owner lookup. `refresh: true` re-runs orphan
  detection over the registry first (§4.10).
- `graft-session-start {association_id}` → `{ok:true, association_id, session}` or
  `{ok:false, association_id, error, error_kind, parent_repo_root?}`
  (`ws/graft.ts:182-206`). `parent_repo_root` is set when the engine threw
  `alreadyActive`; it is what the client's swap prompt names (§6.3). An unknown
  association id fails with `no repo association matches '<id>'`.
- `graft-session-stop {association_id}` → `{ok:true, association_id}` or
  `{ok:false, association_id, error, error_kind}`. Idempotent daemon-side (§4.4),
  which is what makes the retry-an-errored-session path of §6.2 safe.
- `graft-orphan-recover {association_id}` → runs `recoverOrphan` (§4.10) on the
  registry entry; `{ok:false, association_id, error}` on failure, with the orphan
  and the breadcrumb both kept (`ws/graft.ts:89-131`).
- `graft-orphan-dismiss {association_id}` → deletes the breadcrumb only; an id not in
  the registry fails with `no interrupted graft matches '<id>'`.

Two untyped broadcasts keep every connected client's mirror current:

- `graft-changed {type, sessions:[...]}` (`graftChangedEvent`,
  `packages/daemon/src/graft/wire.ts:39-44`) carries the **full** session list, not a
  per-event started/updated/stopped delta. The daemon sends it on every engine event
  (`packages/daemon/src/boot/compose.ts:967-969`); the client's reducer merges the
  list and preserves only its own `starting`/`error` placeholders
  (`packages/client/src/state/graft.ts:107-118`).
- `graft-orphans {type, orphans:[...]}` (`graftOrphansEvent`, `wire.ts:51-65`; entries
  carry `association_id`, `parent_repo_root`, `worktree_path`, `branch` and
  `stash_ref` when set) is sent on every change to the orphan registry
  (`compose.ts:1126-1128`: boot detection, a refresh, a recover, a dismiss), so a
  second window's banner disappears when the first window restores.

The client-side calls are `graftList` / `graftStart` / `graftStop` /
`graftRecoverOrphan` / `graftDismissOrphan`
(`packages/client/src/connection/commands.ts:1243-1290`); start, stop and recover use
the 120s worktree command timeout because each can run git for a while.

---

## 8. Worktree workspace flows

### 8.1 Name sanitization (`sanitizedGitName`)

Single source of truth for turning a user-entered worktree/branch name into a value
safe as both a filesystem path component and a git ref. Applied server-side on every
path (GUI sheet, inspector, socket `workspace-create`); the GUI also shows the
sanitized preview live.

```
slug = name.replace(/[^A-Za-z0-9\/._-]+/g, "-")   // anything unsafe → single hyphen
slug = slug.replace(/-{2,}/g, "-")
slug = slug.replace(/\/{2,}/g, "/")
slug = slug.replace(/\.{2,}/g, ".")
slug = trim leading/trailing chars in "-/._ "     // note: space included
return slug === "" ? null : slug
```

Properties: preserves case, `/` (for `feature/foo` namespacing), `.`, `_`, `-`; an
already-valid name is a fixed point; a name that reduces to nothing returns null and
the caller surfaces `"\"<name>\" isn't a usable worktree name. Use letters, numbers,
or - _ / . characters."` (branch variant says "branch name"). Best-effort: does NOT
enforce every `git check-ref-format` rule (e.g. a path component starting with `.`);
residual git rejections surface via `worktreeErrorMessage` (§8.6).

### 8.2 Worktree base path (`resolvedWorktreeBasePath`)

Setting `worktreeBasePath` (config key, Settings > General > Worktrees), default
`"~/kelpi/worktrees/<repo>"` (`packages/daemon/src/git/names.ts:13`,
`packages/core/src/config/general.ts:118`, `packages/protocol/src/ws/settings.ts:394`);
a blank value falls back to the default. Resolution given a repo path
(`resolvedWorktreeBasePath`, `names.ts:55-68`):

1. If the setting **starts with** `<repo>`, replace that prefix with the **full repo
   path** (so `"<repo>/worktrees"` → `/Users/ben/code/myrepo/worktrees`).
2. Any other occurrence of `<repo>` is replaced with the repo's **directory name**
   (last path component).
3. Expand leading `~`.

Final worktree path = `resolvedBase + "/" + sanitizedFolderName`.

### 8.3 `performWorktreeAdd` (shared by GUI + socket)

```
if updateMain:
  def = defaultBranch(repoPath)              // §3
  fetch(repoPath, "origin")
  createWorktreeFromBase(repoPath, worktreePath, branch, "origin/" + def)
else:
  createWorktree(repoPath, worktreePath, branch)   // existing-branch-first fallback
```

### 8.4 Inspector flow (`createWorktree` action)

From the workspace inspector (`workspace-add-worktree`,
`packages/daemon/src/ws/repos.ts:420-486`; the client sends it from
`packages/client/src/connection/commands.ts:1180-1191`): sanitize worktree name +
branch name (branch defaults to the worktree name; either failing → error reply,
nothing spawned); resolve the repo by `repo_id` (must be registered) or a
standardized `repo_path`; compute the path; run `performWorktreeAdd` (§8.3, via
`GitService.worktreeAdd`) with the sheet's `update_main` flag (`repos.ts:458`), so
`--update-main` semantics apply on this path too; on success register the repo if
new, or clear `isAutoDiscovered` if the registry already carried it as
auto-discovered (`ensureRepo(..., {promote: true})`, `repos.ts:468`), append a
`RepoAssociation {repoID, worktreePath, branchName: safeBranch, isAutoDetected:
false}` to the workspace and persist; the association reconciler (§8.8) then starts
the HEAD watcher and reads status. On failure reply
`{ok:false, error: worktreeErrorMessage(err)}` (the client shows it as a transient
alert with a dismiss action).

### 8.5 New-workspace-with-worktree flow

GUI sheet (`createWorkspaceWithWorktree`) and socket `workspace-create --worktree`
share the same shape:

1. Sanitize worktree + branch names (branch defaults to the worktree name when
   omitted). Failure → error (sheet stays open / `{"ok":false,...}` reply).
2. `worktreePath = resolvedWorktreeBasePath(repoPath) + "/" + folderName`.
3. `performWorktreeAdd(repoPath, worktreePath, safeBranch, updateMain)` (async).
4. On success, create the workspace with a **worktree seed**
   `{path: worktreePath, branchName: safeBranch}`:
   - the first pane's working directory = the worktree path (not the repo root);
   - the repo is registered (if new) and an association is added pointing at the
     **worktree path** with the seed's branch;
   - the repo is promoted out of auto-discovered status;
   - HEAD watchers start for the new association; git status refreshes immediately
     (so the dirty badge doesn't lag until the 30s timer).
5. On failure, no workspace is created; error surfaces via `worktreeCreationError`
   (GUI) or the `{"ok":false,"error":worktreeErrorMessage(e)}` reply (socket).

Socket specifics (`workspace-create` wire fields: `worktree`, `branch`,
`update_main`, `repo`; empty strings normalize to nil):

```json
{"command":"workspace-create","name":"feature-x","worktree":"feature-x",
 "branch":"feature/x","update_main":true,"repo":"/Users/ben/code/myrepo",
 "group":"experiments"}
```

- The CLI **always** sends `repo` when `--worktree` is set (defaults to the CLI's
  cwd). Server guards: missing/empty repo → `{"ok":false,"error":"--worktree
  requires a source repo (pass --repo <path>)"}`.
- `repo` path is standardized; matched against the registry by standardized path
  (found → reuse the Repo id; else mint a new Repo).
- `--group` on the worktree path only composes with an **existing** group: unknown →
  `{"ok":false,"error":"unknown group: <g> — --worktree only supports existing
  groups; create it first (`kelpi group create`) or omit --group"}`; ambiguous name →
  `{"ok":false,"error":"group name is ambiguous: <g> (use the id or rename an
  existing group)"}`. (Never creates a group — a failed worktree add would orphan
  it.)
- Success reply (sent only **after** the worktree add and workspace dispatch):

```json
{"ok":true,"workspace_id":"<uuid>","workspace_name":"feature-x",
 "worktree_path":"/Users/ben/kelpi/worktrees/feature-x","branch":"feature/x",
 "group":"experiments"}
```

- CLI success line: `created workspace <name> (<id>)[ in group <g>] with worktree
  <path> on branch <branch>`. Reply read timeout is extended to 120s for this
  command.

### 8.6 `worktreeErrorMessage`

Turning a `GitCommandError` into an actionable message: `git worktree add` prints an
informational `Preparing worktree (…)` line to stderr **before** the real
diagnostic, so:

1. If the error has non-empty stderr: split into trimmed non-empty lines; return the
   **last** line starting (case-insensitively) with `fatal:` or `error:`; else the
   last line; else the whole stderr.
2. Otherwise the error's generic description.

Examples surfaced: `fatal: '<path>' already exists`,
`fatal: '<branch>' is already checked out at '<path>'`.

### 8.7 Deleting worktrees

- **Inspector "remove association" with delete-worktree checked**
  (`remove-repo-association {workspace_id, association_id, delete_worktree: true}`,
  `packages/daemon/src/ws/repos.ts:369-418`): run a **non-forcing** `git worktree
  remove` (§3.2 `removeWorktree`) FIRST. If git refuses (dirty or locked worktree),
  the association is the main checkout itself (standardized paths equal), or the
  parent repo is no longer registered, reply
  `{ok:false, error: <worktreeErrorMessage or the reason>, workspace_id,
  association_id}` and keep the association in place, so the directory is never
  stranded with nothing in the window pointing at it (`repos.ts:402-405`). Only
  after a successful removal is `remove-repo-association` dispatched and persisted;
  the store reconciler (§8.8, `packages/daemon/src/graft/associations.ts:176-186`)
  then stops the HEAD watcher and force-stops the graft session, i.e. AFTER the
  worktree directory is gone rather than before. That ordering is safe because
  graft's stop awaits any in-flight sync and operates on the parent root, not the
  dying worktree dir; a sync pass that fires in between reports `missingWorktree`
  and the session stays alive until the force-stop lands. The success reply carries
  `worktree_path` and `worktree_deleted: true`. Without the checkbox, just drop the
  association (`worktree_deleted: false`).
- **CLI `workspace delete --prune-worktree`**: after a successful workspace delete
  the CLI (client-side, its own git spawns via `/usr/bin/env git`;
  `packages/cli/src/commands/workspace.ts:275-311`) takes the deleted
  workspace's directory (`path` in the delete reply — a shell pane's current cwd; an
  empty workspace has none, documented limitation), resolves the worktree root via
  `git -C <path> rev-parse --show-toplevel`, resolves the main worktree via
  `git -C <path> rev-parse --path-format=absolute --git-common-dir` (parent dir of
  the common dir; falls back to the root itself), then runs a **non-forcing**
  `git -C <mainWorktree> worktree remove <root>` so git isn't invoked from inside
  the tree being removed. Failures (dirty/locked worktree, primary checkout,
  non-repo path) become a `Warning:` with git's stderr folded in and do NOT change
  the exit code — the workspace stays deleted. Per-id JSON adds
  `worktree_pruned: bool` and `worktree_error` on failure.

### 8.8 Removal paths that must fire graft forceStop + HEAD-watcher stop

Every path that drops associations dispatches, per removed association id, BOTH a
`stopHeadWatcher` and a graft `forceStop` (unconditional — issue #231):

- workspace delete (single, bulk multi-select, ⌘W-last-pane path)
- group cascade delete (all member workspaces' associations)
- repo removal from the registry (cascades association removal across all
  workspaces, also drops cached git statuses)
- inspector association removal (with or without worktree deletion)
- auto-unlink GC (below)

### 8.9 Auto-link / auto-unlink (association lifecycle context)

Not graft-specific but it feeds graft's association set
(`packages/daemon/src/git/autodetect.ts`):

- On pane cwd change (and pane creation, including a restored pane and a pane spawned
  with its cwd already inside a checkout: the triggers come from a store reconciler,
  `RepoAutoDetectService.start()`, that diffs the pane set on every event batch, not
  from the OSC 7 report alone; issue #48), debounce **500ms**, then
  `resolveRepoRoot(cwd)`; if resolved and the pane is still in that directory tree
  (`isPathInside`, `autodetect.ts:127-133`: exact-or-prefix match on canonicalized
  paths, i.e. standardized and then symlinks resolved on both sides, so `/tmp` and
  `/private/tmp` spellings match) and the auto-detect setting is on: find-or-create a
  Repo whose canonicalized path equals `parentRepoRoot` (`autodetect.ts:205-209`;
  marked `isAutoDiscovered: true` when created), and add a
  `RepoAssociation {worktreePath: worktreeRoot, isAutoDetected: true}` to the pane's
  workspace unless one for that worktree already exists. Follow-ups: resolve branch +
  status async, start a HEAD watcher, resolve the repo's remote URL, persist once.
- Auto-unlink: on pane close/cwd changes (also a shell exit, a reaped parked source or
  a workspace delete: any pane vanishing from the store, via the same reconciler;
  issue #48), debounce **5s**, then remove every
  `isAutoDetected` association whose worktree no longer contains any pane's cwd
  (exact-or-prefix match on canonicalized paths, standardized and then symlinks
  resolved on both sides, so `/tmp` and `/private/tmp` spellings match; including
  parked panes). GC auto-discovered repos with no remaining associations anywhere.
  Fire stopHeadWatcher + graft forceStop per removed association.

### 8.10 Repo registry verbs (Settings > Repositories)

The registry that associations point into (`Repo`, §2) has its own editing surface,
four WS-only verbs in `packages/daemon/src/ws/repos.ts` (`repos.ts:73-87`). They edit
the global registry rather than a workspace's associations; every mutation is an
existing store action, so persistence and the CLI's view stay identical to a change
made any other way. Registry lookups compare `repoKey` = standardized and
symlink-resolved path (`repos.ts:199-208`), so `/var/...` and `/private/var/...`
spellings of one repo never register twice.

- `repo-add {path, name?}` (`repos.ts:508-565`): `path` is standardized. Already
  registered and **auto-discovered** → promoted to manual
  (`set-repo-auto-discovered {isAutoDiscovered: false}`,
  `packages/daemon/src/store/types.ts:316-325`) and persisted, so the auto-unlink GC
  can never collect a repo the user asked for by hand; already registered and manual
  → `ok` with the existing row, unchanged; new → registered with `name ?? basename`,
  `remoteURL` from a best-effort `getRemoteURL`, `isAutoDiscovered: false`. The path
  is deliberately not required to be a checkout (a directory picker can pick
  anything; the row is honest about being remote-less). Reply:
  `{ok:true, repo_id, promoted, already_registered, repo}`.
- `repo-remove {repo_id}` (`repos.ts:567-586`): dispatches `remove-repo`; the reducer
  drops the repo AND every association pointing at it from every workspace, and the
  reconciler (§8.8) stops each vanished row's HEAD watcher and force-stops its graft
  session. Reply: `{ok:true, repo_id, name, path, removed_associations:[ids]}`.
- `repo-rename {repo_id, name}` (`repos.ts:588-614`): display name only; the path is
  identity and never moves.
- `repo-scan {path, max_depth?}` (`repos.ts:616-667`): `scanForRepos` (§3.2) from the
  standardized `path` (depth 3 unless `max_depth` is a finite number); every find not
  already in the registry is added (`isAutoDiscovered: false`, remote URL read
  best-effort), already-registered finds are reported rather than dropped. Reply:
  `{ok:true, root, scanned, added:[repos], skipped:[paths]}`.

Promotion out of auto-discovered status also happens on the two worktree-creation
paths: `workspace-create --worktree` clears the flag on an already-registered
auto-discovered repo (`packages/daemon/src/handlers/app/workspaces.ts:300-325`), and
`workspace-add-worktree` does the same through `ensureRepo(..., {promote: true})`
(§8.4). A plain `add-repo-association` registers a new repo as manual but does not
promote an existing auto-discovered one (`repos.ts:272-310`).

---

## 9. Watchers

### 9.1 RecursiveFSWatcher (drives graft sync)

Recursive directory watcher (`watchRecursive`, `packages/daemon/src/graft/watcher.ts`,
a recursive non-persistent `fs.watch` on the worktree root). Semantics:

- `start(rootPath, debounce = 500ms, ignoredComponents = {".git", "node_modules",
  "target", ".DS_Store"})` → stream of `string[]` batches.
- **File-level events** (not just directory-level), delivered without deferral.
- **Filtering**: a changed path is dropped if ANY of its `/`-separated components is
  in the ignored set.
- **Debounce/batching**: trailing debounce. Changed paths accumulate into a set;
  each incoming event (re)schedules the flush `debounce` after the latest event;
  the flush emits the **sorted, deduplicated** array and clears the set. So a burst
  of writes yields one batch ~500ms after the last write.
- Consumer cancellation tears down the underlying watch; teardown drops any pending
  batch.
- Empty batches are never emitted.
- Batches that arrive while the consumer is busy are not lost: graft's consumer
  processes serially, and a batch that arrives during a sync pass sets the session's
  `pending` flag so exactly one follow-up pass runs when the current one finishes
  (§4.3).
- **Filtering runs on the root-relative path**, not the absolute path
  (`watcher.ts:13-15`), so a worktree that happens to live under a directory named
  `target` or `node_modules` is still watched.
- An event whose filename is `null` (the platform could not name the entry) is
  attributed to the root path itself and still schedules a batch rather than being
  dropped (`watcher.ts:119-127`).
- **Watch-attach failure**: if `fs.watch` throws at start (the worktree vanished
  between the initial sync and the watch), the error is reported through `onError`
  and the watcher stays unattached (`watching = false`, `watcher.ts:129-141`). The
  session is already published and stays live but unwatched; no batch will fire, and
  a later pass (a retry through stop/start) reports `missingWorktree` honestly.
- **Post-attach catch-up pass**: the recursive `fs.watch` is FSEvents on macOS, and an
  FSEvents stream delivers nothing for a change made before the stream is live on
  libuv's CF thread. `start` publishes the session as soon as the watch is created, so a
  write made the instant `graft start` returns can fall inside that window and would
  otherwise never be observed (the session says `watching`, nothing mirrors, and no later
  event repairs it). So `startWatcher` runs catch-up passes every `GRAFT_WATCH_CATCH_UP_MS`
  (1500 ms) until the watcher reports its first delivered event (`watcher.live`, the only
  available proof that the stream is up), at most `GRAFT_WATCH_CATCH_UP_MAX` (20, thirty
  seconds of coverage), each routed through the same `pending` + `pump` path as a real batch
  so it is serialised with them. `stop` and `shutdown` cancel the pending one: a pass that
  fired after the restore would re-apply the worktree over the restored parent.

### 9.2 GitHeadWatcher (drives sidebar branch/status refresh)

Watches the **HEAD file** of each registered `RepoAssociation` — resolved via
`resolveHeadPath` (§3), i.e. `<repo>/.git/HEAD` for the main worktree,
`<repo>/.git/worktrees/<name>/HEAD` for a linked worktree — and emits a unit event
whenever HEAD changes. This is what makes the sidebar branch label update within
~200ms of a `git checkout` / `git switch` / `git reset`, at zero at-rest CPU.

Mechanics (`createHeadWatchService`, `packages/daemon/src/graft/head-watcher.ts`; a
non-recursive `fs.watch` on the HEAD file's **parent directory**, filtered to the
`HEAD` entry):

- `git checkout` typically rewrites HEAD via temp-file + **atomic rename**, which
  kills the inode of a file-level watch. Watching the directory and filtering events
  by `basename(filename) === "HEAD"` is rename-proof by construction, so there is no
  re-open dance (Compatibility rationale item 10). An event with a `null` filename is
  treated as a HEAD change (it costs one debounced git read).
- On ANY matching event: **emit** (the consumer only sees the logical "HEAD changed"
  signal), after the 150ms debounce below (`HEAD_CHANGE_DEBOUNCE_MS`,
  `head-watcher.ts:21`).
- `start(associationID, worktreePath)` is keyed per association; starting again for
  the same id cancels and replaces the prior watch (an epoch counter makes a slow
  `resolveHeadPath` unable to resurrect a watch that was stopped meanwhile).
  `stop(associationID)` is idempotent and also cancels a pending debounce.
  `stopAll()` on teardown.
- Failure to resolve the HEAD path (`resolveHeadPath` throws: not a repo, or git
  unavailable) → the watcher silently no-ops. A directory watch that fails to attach
  is reported through `onError` and the entry is kept without a handle.

Downstream pipeline (per association; `createRepoAssociationWatch`,
`packages/daemon/src/graft/associations.ts:111-140`):

```
startHeadWatcher(workspaceID, associationID, worktreePath):
  headPath = resolveHeadPath(worktreePath)     // failure → give up silently
  for each event: dispatch headChanged(workspaceID, associationID)

headChanged:                                   // debounced 150ms, restart-on-new-event
  // coalesces the double event of checkout's temp-file + rename
  status = getStatus(assoc.worktreePath)  (fallback: unknown)
  branch = getCurrentBranch(assoc.worktreePath) (fallback: null)
  -> gitStatuses[associationID] = status        (in-memory)
  -> onWorktreeChanged(worktreePath)            (the pane-branch producer, §9.4)
  -> association.branchName = branch            (persisted; dispatched only when it changed)
```

Watchers are started: at state load for every persisted association; on worktree
creation; on auto-link; on workspace-create with repos/worktree seed. Stopped on
every association-removal path (§8.8).

### 9.3 Polling backstop

Independent of the watchers, a 30-second timer runs `refreshGitStatus`, which — for
the **active workspace only** — re-runs `getStatus` + `getCurrentBranch` for each of
its associations. Also triggered when the inspector opens, when a workspace is
created with a worktree seed, and at state load. This catches dirtiness changes that
don't touch HEAD (file edits) without watching whole repos.

### 9.4 Pane-branch producer

Independent of the per-association `branchName`, every pane carries its own
`gitBranch` (the branch chip in the pane header, the status footer and a
markdown/diff pane's header). `createPaneBranchWatch`
(`packages/daemon/src/git/branch.ts`) is its producer: one store reconciler that
resolves `git rev-parse --abbrev-ref HEAD` in each pane's **own** working directory
whenever that directory changes (an OSC 7 pwd report, a split inheriting a cwd, a
markdown/diff pane opening, a restore at boot).

- Per-pane **120ms debounce** (`BRANCH_RESOLVE_DEBOUNCE_MS`, `branch.ts:50`), so a
  burst of `cd`s costs one `git rev-parse`.
- Per-directory **3s cache** (`BRANCH_CACHE_TTL_MS`, `branch.ts:60`), so N panes
  sharing a cwd cost one spawn between them.
- The dispatch of `pane-branch-changed {paneID, branch}` is **conditional**
  (`branch.ts:171`): a re-resolve that agrees with what the pane already carries
  writes nothing, so the chip cannot flicker and the delta stream stays quiet.
- A detached HEAD keeps git's literal answer `"HEAD"`; a directory that is not a
  checkout (or a failing git) yields `null`, which the renderers draw as nothing.
- Only visible panes are resolved (a parked pane has no header to draw a branch in);
  a pane that moved or vanished while git ran is not written to.

Second trigger: `repoChanged(worktreePath)` (`branch.ts:230`) drops the cache for
every directory inside the worktree and re-resolves the panes sitting in it. The
association watcher fires it as `onWorktreeChanged(worktreePath)` on every
association refresh (`packages/daemon/src/graft/associations.ts:132-136`, wired in
`packages/daemon/src/boot/compose.ts:979-995`), so a `git checkout` in one pane moves
the branch chip in every pane inside that worktree without a second HEAD watcher.

---

## 10. Lifecycle integration summary

- **Launch** (`packages/daemon/src/boot/compose.ts`): after persisted state loads →
  the association reconciler starts HEAD watchers for all associations, reads
  branch/status once and arms the 30s timer (§9.2, §9.3) → the daemon subscribes to
  service events (`compose.ts:967`) → sweep stale temp indexes (`compose.ts:1543`) →
  `detectOrphans(unique(repoRegistry paths))` fills the orphan registry
  (`compose.ts:1551`). First-run (no workspaces) still runs with `[]`.
- **Quit**: flush all service graft sessions (2s cap) before terminating (§5).
- **Crash**: breadcrumbs → orphan banner on next launch (§4.10, §6.6).

---

## Compatibility rationale

These items record quirks the code preserves on purpose so the pre-port `kelpi` CLI,
hook scripts and saved state (breadcrumbs, persisted associations) keep working, and
the deliberate divergences from the pre-port app and why they are safe:

1. **Git binary + spawning.** The daemon resolves `git` from PATH (`KELPI_GIT`
   overrides), inherits its own environment, merges `GIT_INDEX_FILE` over it, and
   invokes git with `cwd` rather than `-C` (§3.1). There is **no timeout** in
   production; the runner supports optional budgets, and any budget on the
   worktree/fetch family is clamped up to 120s because the CLI already waits 120s
   for `workspace create --worktree` (§7.6): a daemon-side timeout shorter than that
   would fail a command the CLI is still prepared to wait for.
2. **Git calls are async, but the graft engine's ordering guarantees hold.** One
   sync pass at a time per session (the `pending` flag + serial `pump`, §4.3), stop
   awaits the in-flight pass, and watcher-vs-stop registration is a synchronous step
   with no `await` inside it (§4.3/§4.4). The pre-port app got the same guarantees
   from blocking git calls inside a mutex; the daemon gets them from the
   single-threaded event loop and explicit awaits.
3. **Lock derivation (issue #231) is a hard invariant.** There is no standalone
   busy-roots set. Claim = startingRoots ∪ live session roots; status and stop read
   the service, not any client mirror; removal paths always call stop
   unconditionally; stop is an idempotent no-op for unknown ids (which is why stop
   runs its watcher/sync cleanup steps before the "no session" early-return, §4.4).
4. **Stop coalescing** (§4.4) matters in the daemon even more than in a single-process
   app: the wire layer, workspace deletion, the inspector and the quit flush can all
   race stops for the same id. They coalesce onto one promise and every awaiter gets
   its real outcome.
5. **Breadcrumb compatibility.** The exact path
   (`<parentRepoRoot>/.git/kelpi-graft-active`), JSON field names, sorted-key
   encoding, `version: 1`, and tolerant decoding (invalid/unknown-version → ignore,
   don't delete) are all kept (`packages/daemon/src/graft/breadcrumb.ts`). A user
   can upgrade with a breadcrumb on disk from the pre-port app and the daemon
   recovers it, including legacy breadcrumbs where `preGraftBranch`/`preGraftSha`
   are absent (fallback = `git checkout -f HEAD --`) and where `worktreePreGraftSha`
   is set (worktree `reset --mixed` on recovery).
6. **Wire compatibility.** The pre-port `kelpi` CLI keeps working unchanged: request
   field names (`workspace`, `repo`, `pane_id`, `worktree`, `branch`,
   `update_main`), reply shapes (`started[]` with
   `association_id`/`worktree_path`/`branch`/`parent_repo_root`; `stopped[]` +
   optional `failed[]`; `sessions[]` per §7.4), `ok` semantics (stop's `ok = no
   failures`), empty-string-to-nil normalization, and the reply-then-EOF framing.
   `last_sync` is ISO 8601 at second precision. The scope-required error text still
   names `NEX_PANE_ID` (§7.1) because it is a reply string the old CLI printed
   verbatim.
7. **Error strings.** The pre-port app put stringified enum cases on the wire (e.g.
   `alreadyActive(parentRepoRoot: "/x")`, `stashPopConflict(stashRef: "...",
   underlying: "...")`). Nothing machine-parses them (the CLI just prints), so the
   daemon uses human-readable messages instead (`packages/daemon/src/graft/errors.ts`)
   while keeping them informative (root path, stash SHA, git stderr), since they are
   the user's only diagnostics. The additive `error_kind` field on every `ok:false`
   reply is the stable machine-readable form (§7.2).
8. **Known CLI quirk.** A partial `graft-stop` failure replies `ok:false`, and the CLI
   runs its generic envelope check first, so it never renders the `failed` list
   (§7.3). The daemon therefore also includes a summary `error` string in that reply
   (`packages/daemon/src/handlers/app/graft.ts:242-262`) so the CLI prints something
   useful instead of `unknown error`; the `failed` array stays for clients that
   render it. The reply shape is otherwise unchanged.
9. **FS watching.** The recursive watcher is a recursive `fs.watch`
   (`packages/daemon/src/graft/watcher.ts`). The must-keep semantics hold: 500ms
   trailing debounce, component-based ignore list (`.git`, `node_modules`, `target`,
   `.DS_Store`), dedup+sort per batch, and, critically, events under `.git` never
   trigger sync passes (otherwise graft's own git activity would self-trigger).
   Components are checked on the root-relative path so the emitted absolute paths
   never match the ignore list through an ancestor directory (§9.1).
10. **HEAD watching.** The pre-port app watched the HEAD file's descriptor and re-opened
    it 200ms after a rename, an inode-watch artifact. The daemon instead watches the
    HEAD file's **parent directory** for changes to the `HEAD` entry
    (`packages/daemon/src/graft/head-watcher.ts`), which sidesteps atomic-rename
    inode death, while preserving per-association identity, idempotent stop, the
    silent no-op for non-repos, the 150ms downstream debounce before running `git
    status` + branch resolve, and the "linked worktree HEAD lives under
    `.git/worktrees/<name>/HEAD`" resolution via `rev-parse --git-path HEAD` (§9.2).
11. **Path canonicalization.** Root claims and `--repo` matching use standardize +
    resolve-symlinks (`packages/daemon/src/graft/paths.ts`): `path.resolve` plus
    `fs.realpathSync` on the longest existing prefix, with the missing tail
    re-appended, because Node's realpath throws the moment any component is missing
    while the pre-port app resolved what it could. `/tmp` vs `/private/tmp`
    equivalence on macOS comes from this; tests rely on it.
12. **Session/association identity.** The graft session id IS the association id.
    The service accepts a start for an association whose id it has never seen and
    enforces uniqueness on the parent root, not the id.
13. **UI mirror is a client concern.** The web client receives the full session list
    over the WebSocket (`graft-changed`, §7.7) and merges it with the same
    upsert/remove semantics, and implements the toggle/swap/orphan state machine of
    §6 client-side, while every source-of-truth decision (claims, stop targets,
    status, orphan detection) stays daemon-side.
14. **Quit flush** is the daemon-shutdown flush: on SIGTERM/SIGINT and `kelpid stop`
    the daemon stops all sessions with a bounded (2s) grace period before exit
    (§5); breadcrumbs cover the rest. An Electron-shell quit goes through daemon
    shutdown handling rather than skipping it.
15. **`repoState` marker files** are read directly from the resolved git dir; for
    worktrees `rev-parse --git-dir` points at the per-worktree dir, and the code
    does not shortcut to `<root>/.git`.
16. **`getStatus` counts** untracked files in `changedFiles` but not in
    additions/deletions (`diff --shortstat HEAD`), and swallows shortstat errors
    (fresh repo without HEAD). Sidebar badges depend on these exact semantics.
17. **Stop-during-start.** The pre-port app accepted that stopping an association
    whose start was still mid-flight left an ownerless live session. The daemon
    closes this window: stop awaits an in-flight start for the same id before
    tearing down (§4.4). `graft stop --repo <path>`'s orphan fallback is kept
    regardless, because it is also the escape hatch for sessions whose associations
    were deleted.
18. **The `kelpi-graft-index-*` temp index files** go to the OS temp dir and are
    best-effort deleted (the `.lock` twin too); a crashed sync can leave them.
    Harmless, and `sweepGraftTempIndexes` (§3.2) removes day-old leftovers at boot
    without robbing a concurrent daemon's in-flight sync.
19. **`addAllAndCommit`** was dead code for graft (legacy commit-based design) that
    remained on the pre-port service surface; nothing else needs it, so the daemon's
    `GitService` omits it (§3.2).
20. **Worktree flows**: sanitization is identical (it is user-visible in path
    previews and replies), the `<repo>` placeholder semantics in the base path are
    kept, `--update-main` = ls-remote-default + fetch + branch off
    `origin/<default>`, and `worktreeErrorMessage` prefers the last `fatal:`/`error:`
    line because the raw first stderr line of `git worktree add` is misleading
    (`packages/daemon/src/git/names.ts`).

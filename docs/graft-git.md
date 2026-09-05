# Graft + Git subsystem (daemon git module)

Behavioral specification of Kelpi's git-facing subsystem, written for the TypeScript
daemon port. Covers:

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

Everything here is current behavior of the Swift app; the TS implementer should
reproduce it unless the "Port notes" section at the end says otherwise.

---

## 1. What graft is (user-visible)

Graft continuously **mirrors a linked git worktree's file content into the parent
repository's working tree** without moving the parent's HEAD or branch.

Motivating scenario: an agent works on a feature branch in a worktree
(`~/nex/worktrees/my-feature`), while the user's dev server / editor / preview runs in
the main checkout (`~/code/myrepo`). Toggling graft on makes every save in the
worktree appear in the parent's working tree within ~half a second, so the dev server
hot-reloads the agent's work. Toggling graft off restores the parent exactly to its
pre-graft state (including popping any uncommitted edits that were stashed at start).

Key user-visible guarantees:

- The **parent's branch/HEAD never moves** during a graft session. Only its index +
  working tree are overwritten to match the worktree's content.
- **Untracked files in the parent** (node_modules, build output, `.env`, etc.) are
  left alone — only tracked files are overwritten/removed.
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

TS-ish interfaces (wire naming noted where it differs):

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
  lastSync?: Date;
  preGraftBranch?: string; // parent's branch at start ("HEAD" literal when detached)
  preGraftSha?: string;    // parent's HEAD SHA at start
  worktreePreGraftSha?: string; // ALWAYS null for sessions created by the current
                                // (tree-based) design; kept for legacy breadcrumbs
}

interface GraftOrphan {
  id: string;              // breadcrumb's assocId if parseable as UUID, else a fresh UUID
  parentRepoRoot: string;  // canonicalized
  worktreePath: string;
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

// In-flight git *operations* (not dirtiness):
type RepoState = "clean" | "merge" | "rebase" | "cherryPick" | "revert" | "bisect"
               | { unknown: string };

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
{"assocId":"5E9C1B4E-6C1D-4A6B-9A87-2C51F0B0D001","branch":"feature/x","preGraftBranch":"main","preGraftSha":"9f72d4f0c2b1...","stashRef":"deadbeef42...","stashed":true,"version":1,"worktreePath":"/Users/ben/nex/worktrees/feature-x","worktreePreGraftSha":null}
```

Reading rules: unparseable JSON → treat as no breadcrumb (leave the file alone —
better than misinterpreting it); `version != 1` → treat as no breadcrumb.

---

## 3. GitService — the daemon's git primitive layer

### 3.1 Process conventions (`runGit`)

Every operation shells out to git:

- Executable: `/usr/bin/git` (hard-coded in the Swift app; the port should resolve
  `git` from PATH — see Port notes).
- `cwd` = the repo/worktree path argument. **No `-C` flag is used** (except in the
  CLI's `pruneWorktree`, which is a separate binary).
- Environment: inherits the daemon's full environment. When an op supplies extra env
  (only `writeTreeForWorktree` does, for `GIT_INDEX_FILE`), it is **merged over** the
  inherited environment, not a replacement.
- stdout and stderr are captured separately.
- **No timeout.** Calls block until git exits. (`git fetch` during
  `--update-main` can take a long time; the CLI compensates with a 120s reply
  timeout, see §7.6.)
- Exit code 0 → return stdout as a UTF-8 string (possibly empty).
- Exit code != 0 → throw:

```ts
interface GitCommandError {
  kind: "commandFailed";
  command: string;      // "git " + args.join(" ")
  exitCode: number;
  stderr?: string;      // trimmed; used verbatim in user-facing error messages
}
```

The `stderr` field is load-bearing: graft sync errors and worktree-creation alerts
surface it directly (see `describeSyncError` §4.6 and `worktreeErrorMessage` §6.6).

### 3.2 API surface

Each function below lists the exact git invocation(s) and output handling.

#### `scanForRepos(rootPath, maxDepth) -> ScannedRepo[]`

Pure filesystem walk (no git spawn). Depth-first from `rootPath` (depth 0), up to
`maxDepth` levels (the app always calls with `maxDepth = 3`):

- A directory containing a `.git` entry (**file or directory** — worktrees have a
  `.git` file) is a repo: record `{path, name: lastPathComponent}` and **do not
  recurse into it**.
- Hidden files/dirs are skipped when enumerating children.
- Result sorted by `name`, case-insensitive ascending.

#### `getRemoteURL(repoPath) -> string | null`

`git remote get-url origin`. Trim; empty → null. Throws on non-zero exit (callers
generally swallow with `try?`).

#### `getCurrentBranch(path) -> string | null`

`git rev-parse --abbrev-ref HEAD`. Trim; empty → null. **Detached HEAD prints the
literal string `"HEAD"`** — callers (graft) treat that as a sentinel.

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

Legacy primitive (from graft's old commit-based design; currently unused by graft
but part of the service API): `git add -A`; `git diff --name-only --cached` → staged
paths; if none, return `[]` without committing; else `git commit -m <message>`
(append `--no-verify` when requested); return the staged paths.

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

Failure mode to know: if the parent has an **untracked** file at a path that is
**tracked** in the incoming tree, git refuses with stderr
`error: Untracked working tree file '<path>' would be overwritten by merge.`
Graft surfaces this specially (§4.6).

---

## 4. GraftService — the sync engine

A singleton service owning all active graft sessions. All state lives in maps keyed
by association id, guarded by one mutex. Sessions do NOT survive daemon restart
(that's what breadcrumbs are for).

Internal state:

```ts
sessions:        Map<assocId, GraftSession>
watcherTasks:    Map<assocId, Task>       // the FS-watch consumer loop
activeSyncTasks: Map<assocId, Task>       // the currently-running sync pass, if any
startingRoots:   Set<string>              // canonical parent roots with a start() mid-flight
stopTasks:       Map<assocId, Promise>    // in-flight stop() work, for coalescing
subscribers:     Map<uuid, EventSink>     // updates() stream continuations
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
   //           "revert in progress", "bisect in progress", or the unknown string

// Capture parent restore points BEFORE touching anything:
preGraftBranch = getCurrentBranch(parentRepoRoot)  // may be literal "HEAD" (detached)
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
// errors → rollbackAfterStash

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

Known (accepted) race window: stopping an association whose `start()` is still
mid-flight (session not yet published) is a no-op here, and the start then completes
into a live session with no owning association. That session stays visible in
`activeSessions()`/`graft status`, is matchable by `graft stop --repo <path>`
(orphan fallback, §7.3), triggers the swap prompt on the next start against its
root, and is flushed by the quit path.

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

For a `GitCommandError` with non-empty stderr:

- stderr containing `"Untracked working tree file"` (read-tree refusing to clobber a
  parent untracked file that the worktree tracks) →
  `"Sync blocked — <first line of stderr>"`. The path in the message is the file the
  user must remove or commit in the parent.
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
- `updates()` → a new event stream per subscriber; each receives all
  `started`/`updated`/`stopped` events from subscription time on. Terminating the
  stream unregisters the subscriber.

### 4.10 Orphans (crash recovery)

`detectOrphans(parentRepoRoots: string[]) -> GraftOrphan[]`

For each root (canonicalized), read `<root>/.git/kelpi-graft-active`; if a valid
version-1 breadcrumb exists, produce an orphan (id = `assocId` parsed as UUID, or a
fresh random UUID when unparseable). Called once at app launch with the deduped set
of registered repo paths: `unique(repoRegistry.map(r => r.path))`.

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

On daemon/app shutdown (before termination proceeds): stop **every session the
service holds** (not a UI mirror), with a hard cap of **2 seconds** total; sessions
that can't stop in time fall back to the breadcrumb/orphan-recovery path on next
launch. In the mac app this runs synchronously inside the AppKit
`applicationShouldTerminate` hook, before the quit-confirmation dialog logic.
Purpose: a clean quit must not leave `kelpi-graft-active` breadcrumbs behind, or the
recovery banner would fire on every launch.

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
below exist to re-converge the two (issue #231).

### 6.1 Launch

`onAppLaunched(parentRepoRoots)`:
1. Subscribe to the service's `updates()` stream; apply events to the mirror:
   `started`/`updated` upsert by id, `stopped` removes. (Resubscribing cancels the
   prior subscription.)
2. `detectOrphans(parentRepoRoots)` → replace `orphans` wholesale.

On a **first launch** (no persisted workspaces) this is still dispatched with an
empty roots array so the updates subscription installs — otherwise a CLI-started
graft on first run would be invisible to status/stop/quit-flush.

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

`resolveGraftAssociations(workspaceFilter, repoFilter, paneID)`:

```
if workspaceFilter:
  ws = resolveWorkspace(workspaceFilter)     // UUID match wins; else case-sensitive
                                             // unique name; ambiguous/unknown → fail
  if !ws: FAIL "workspace not found: <filter>"
  scope = [ws]
else if paneID:
  ws = workspaceContainingPane(paneID)
  if !ws: FAIL "no workspace contains the requesting pane"
  scope = [ws]
else if repoFilter:
  scope = allWorkspaces                      // repo-only filter searches everywhere
else:
  FAIL "graft requires --workspace, --repo, or NEX_PANE_ID"

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
{"command":"graft-start","workspace":"feature-x","repo":"/Users/ben/nex/worktrees/my-feature"}
```

Handler: resolve scope (failure → `{"ok":false,"error":"<msg>"}`); then for each
association in scope call service `start(assoc)`, collecting successes and the last
error. Reply:

- all failed / none started:
  `{"ok":false,"error":"<last error, stringified>"}`
  (fallback text `"graft start failed"` if somehow no error was captured)
- all started:
  ```json
  {"ok":true,"started":[
    {"association_id":"5E9C...","worktree_path":"/Users/ben/nex/worktrees/my-feature",
     "branch":"feature/x","parent_repo_root":"/Users/ben/code/myrepo"}]}
  ```
- partial:
  `{"ok":true,"started":[...],"partial_error":"<last error>"}`

CLI rendering (`kelpi graft start [--workspace ..] [--repo ..]`): on `ok:false` the CLI
prints `kelpi graft-start: <error>` to stderr and exits 1. On success, one line per
entry: `started <branch> (<association_id>) at <worktree_path>`; empty list prints
`No associations started.`; `partial_error` prints
`Partial failure: <msg>` to stderr (exit code stays 0).

Note: error strings are the stringified Swift enum, e.g.
`alreadyActive(parentRepoRoot: "/Users/ben/code/myrepo")` — see Port notes.

### 7.3 `graft-stop`

Request shape identical to `graft-start`.

Handler:

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
 "failed":[{"association_id":"AB12...","error":"stashPopConflict(...)"}]}
```

`ok` is `failures.isEmpty`.

CLI rendering quirk (current behavior — see Port notes): the CLI runs the generic
`{ok,error?}` envelope check first, so an `ok:false` stop reply (which carries
`failed` but no `error` key) prints `kelpi graft-stop: unknown error` and exits 1
**without** rendering the per-id `failed` list. The pretty per-failure printing only
runs on `ok:true` replies, where `failed` is never present.

### 7.4 `graft-status`

Request: `{"command":"graft-status"}` — no scope parameters.

Reply reports the **service's** sessions (source of truth — a session the UI mirror
lost must still show up here so every `alreadyActive` rejection is explainable):

```json
{"ok":true,"sessions":[
  {"association_id":"5E9C1B4E-...",
   "worktree_path":"/Users/ben/nex/worktrees/my-feature",
   "parent_repo_root":"/Users/ben/code/myrepo",
   "branch":"feature/x",
   "status":"watching",
   "stash_ref":"deadbeef42...",
   "last_sync":"2026-08-18T09:30:12Z"}]}
```

Per-session JSON: `status` ∈ `"starting" | "watching" | "syncing" | "error"`; when
error, an `"error"` key carries the message. `stash_ref` and `last_sync`
(ISO 8601, second precision) are present only when set.

CLI: `kelpi graft status [--json]` — `--json` prints the sessions array (sorted keys);
otherwise `No active graft sessions.` or one line per session:
`<branch> [<status>] <worktree_path>`.

### 7.5 CLI command surface

```
kelpi graft start [--workspace <name-or-uuid>] [--repo <name-or-path>]
kelpi graft stop  [--workspace <name-or-uuid>] [--repo <name-or-path>]
kelpi graft status [--json]
```

With no filters, start/stop send `pane_id` from `$NEX_PANE_ID` (caller's workspace
scope). Unknown action → usage error, exit 1.

### 7.6 Reply-envelope conventions (context)

The CLI's request/response framing: send one JSON line, read until EOF with a
5-second receive timeout (`KELPI_REPLY_TIMEOUT` env overrides; `workspace create
--worktree` uses a 120s override because `git worktree add` + `git fetch` can be
slow). Transport failure / empty reply / invalid JSON / `ok:false` → stderr message +
exit 1.

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

Setting `worktreeBasePath`, default `"~/nex/worktrees/<repo>"`. Resolution given a
repo path:

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

From the workspace inspector ("add worktree" for a registered repo):
sanitize worktree name + branch name (either failing → transient
`worktreeCreationError` alert, nothing spawned); compute path; run the **plain**
`createWorktree` (no update-main option on this path); on success append a
`RepoAssociation {repoID, worktreePath, branchName: safeBranch}` to the workspace,
mark the repo not-auto-discovered, persist, refresh git status, and start a HEAD
watcher for the new association. On failure set `worktreeCreationError` to
`worktreeErrorMessage(err)` (alert with a dismiss action).

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
 "worktree_path":"/Users/ben/nex/worktrees/feature-x","branch":"feature/x",
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
  (`removeWorktreeAssociation(deleteWorktree: true)`): remove the association +
  cached git status, dispatch graft `forceStop(assocID)` FIRST (otherwise the
  session keeps mirroring a worktree that is about to disappear, leaving the parent
  mid-mirror and the breadcrumb stranded), stop the HEAD watcher, then best-effort
  `removeWorktree(repo.path, assoc.worktreePath)` (errors swallowed), persist.
  graftStop and removeWorktree may run concurrently — safe because graft's stop
  awaits any in-flight sync and operates on the parent root, not the dying worktree
  dir. Without the checkbox, same minus the git removal.
- **CLI `workspace delete --prune-worktree`**: after a successful workspace delete
  the CLI (client-side, its own git spawns via `/usr/bin/env git`) takes the deleted
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

Not graft-specific but it feeds graft's association set:

- On pane cwd change (and pane creation), debounce **500ms**, then
  `resolveRepoRoot(cwd)`; if resolved and the pane is still in that directory tree
  and the auto-detect setting is on: find-or-create a Repo for `parentRepoRoot`
  (marked `isAutoDiscovered: true` when created), and add a
  `RepoAssociation {worktreePath: worktreeRoot, isAutoDetected: true}` to the pane's
  workspace unless one for that worktree already exists. Follow-ups: resolve branch +
  status async, start a HEAD watcher, resolve the repo's remote URL, persist once.
- Auto-unlink: on pane close/cwd changes, debounce **5s**, then remove every
  `isAutoDetected` association whose worktree no longer contains any pane's cwd
  (prefix match on standardized paths, including parked panes). GC auto-discovered
  repos with no remaining associations anywhere. Fire stopHeadWatcher + graft
  forceStop per removed association.

---

## 9. Watchers

### 9.1 RecursiveFSWatcher (drives graft sync)

Recursive directory watcher (FSEvents on macOS; the port needs an equivalent —
e.g. `fs.watch` recursive / `@parcel/watcher` / chokidar). Semantics to preserve:

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
- Batches queue if the consumer is slow (graft's consumer processes serially; a
  batch that arrives during a sync pass is buffered and handled next).

### 9.2 GitHeadWatcher (drives sidebar branch/status refresh)

Watches the **HEAD file** of each registered `RepoAssociation` — resolved via
`resolveHeadPath` (§3), i.e. `<repo>/.git/HEAD` for the main worktree,
`<repo>/.git/worktrees/<name>/HEAD` for a linked worktree — and emits a unit event
whenever HEAD changes. This is what makes the sidebar branch label update within
~200ms of a `git checkout` / `git switch` / `git reset`, at zero at-rest CPU.

Mechanics (kqueue file-descriptor watch in Swift; port with `fs.watch` on the file):

- Watch events: write, extend, rename, delete on the HEAD file.
- On ANY event: **emit** (the consumer only sees the logical "HEAD changed"
  signal).
- `git checkout` typically rewrites HEAD via temp-file + **atomic rename**, so the
  watched inode dies: on a rename/delete event, schedule a **re-open of the same
  path after 200ms** and keep the same consumer stream (the delay lets git finish
  writing the new file). If the re-open fails (file gone), the stream finishes.
- `start(associationID, headPath)` is keyed per association; starting again for the
  same id cancels and replaces the prior watch. `stop(associationID)` is idempotent
  and also cancels a pending re-open. `stopAll()` on teardown.
- Failure to open the HEAD path initially → the watcher silently no-ops (stream
  ends immediately). The app treats this as "not a repo, nothing to watch".

Downstream pipeline (per association):

```
startHeadWatcher(workspaceID, associationID, worktreePath):
  headPath = resolveHeadPath(worktreePath)     // failure → give up silently
  for each event: dispatch headChanged(workspaceID, associationID)

headChanged:                                   // debounced 150ms, restart-on-new-event
  // coalesces the double event of checkout's temp-file + rename
  status = getStatus(assoc.worktreePath)  (fallback: unknown)
  branch = getCurrentBranch(assoc.worktreePath) (fallback: null)
  -> gitStatuses[associationID] = status        (in-memory)
  -> association.branchName = branch            (persisted)
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

---

## 10. Lifecycle integration summary

- **Launch**: after persisted state loads → start HEAD watchers for all
  associations → `refreshGitStatus` + 30s timer → graft
  `onAppLaunched(unique(repoRegistry paths))` (subscribes to service events +
  detects orphans). First-run (no workspaces) still dispatches with `[]`.
- **Quit**: flush all service graft sessions (2s cap) before terminating (§5).
- **Crash**: breadcrumbs → orphan banner on next launch (§4.10, §6.6).

---

## Port notes

Things the TS daemon must get right, plus deliberate divergence opportunities:

1. **Git binary + spawning.** The Swift app hard-codes `/usr/bin/git` and inherits
   the app environment. The daemon should resolve `git` from PATH (configurable),
   keep the env-merge semantics for `GIT_INDEX_FILE`, and keep cwd-based invocation.
   There are **no timeouts** today; consider adding generous ones (esp. `fetch`) but
   remember the CLI already assumes a slow `workspace create --worktree` (120s reply
   timeout) — a daemon-side timeout must be longer than that or surfaced as a
   structured error.
2. **All git calls are currently blocking-synchronous inside async wrappers.** In
   Node, spawn async; but preserve the graft engine's ordering guarantees: one sync
   pass at a time per session, stop awaits the in-flight pass, watcher-vs-stop
   registration is atomic (§4.3/§4.4). A per-session mutex or task queue is the
   natural TS shape.
3. **Lock derivation (issue #231) is a hard invariant.** Do not introduce a
   standalone busy-roots set. Claim = startingRoots ∪ live session roots; status and
   stop must read the service, not any client mirror; removal paths must always call
   stop unconditionally; stop must be an idempotent no-op for unknown ids (this also
   means stop must run its watcher/sync cleanup steps before the "no session"
   early-return, exactly as spec'd).
4. **Stop coalescing** (§4.4) matters in the daemon even more than in-app: the wire
   layer, workspace-deletion, and quit-flush can all race stops for the same id.
   Coalesce onto one promise and propagate its real outcome to all awaiters.
5. **Breadcrumb compatibility.** Keep the exact path
   (`<parentRepoRoot>/.git/kelpi-graft-active`), JSON field names, `version: 1`, and
   tolerant decoding (invalid/unknown-version → ignore, don't delete). Users may
   upgrade with a breadcrumb on disk from the Swift app; the daemon must recover it,
   including legacy breadcrumbs where `preGraftBranch`/`preGraftSha` are absent
   (fallback = `git checkout -f HEAD --`) and where `worktreePreGraftSha` is set
   (worktree `reset --mixed` on recovery).
6. **Wire compatibility.** The `kelpi` CLI must keep working unchanged: request field
   names (`workspace`, `repo`, `pane_id`, `worktree`, `branch`, `update_main`),
   reply shapes (`started[]` with `association_id`/`worktree_path`/`branch`/
   `parent_repo_root`; `stopped[]` + optional `failed[]`; `sessions[]` per §7.4),
   `ok` semantics (stop's `ok = no failures`), empty-string-to-nil normalization,
   and the reply-then-EOF framing. `last_sync` is ISO 8601.
7. **Error strings.** Today's `error` values are stringified Swift enums (e.g.
   `alreadyActive(parentRepoRoot: "/x")`, `stashPopConflict(stashRef: "...",
   underlying: "...")`). Nothing machine-parses them (the CLI just prints), so the
   port may use cleaner human-readable messages — but keep them informative
   (root path, stash SHA, git stderr) since they are the user's only diagnostics.
   Consider adding a stable machine-readable `error_kind` field as an additive
   improvement.
8. **Known CLI quirk** (safe to fix daemon-side only if kept wire-compatible): a
   partial `graft-stop` failure replies `ok:false` without an `error` key, so the
   current CLI prints `unknown error` and never renders the `failed` list. If you
   keep the reply shape, consider also including a summary `error` string so the
   existing CLI prints something useful; the `failed` array must stay for future
   clients.
9. **FS watching.** macOS FSEvents gives recursive file-level events cheaply; in
   Node use a recursive watcher library. Must-keep semantics: 500ms trailing
   debounce, component-based ignore list (`.git`, `node_modules`, `target`,
   `.DS_Store`), dedup+sort per batch, and — critically — events under `.git` must
   NOT trigger sync passes (otherwise graft's own git activity self-triggers).
   Watch that your watcher reports paths in a form whose components can be checked
   (absolute paths are fine).
10. **HEAD watching.** Watching the file (not the directory) plus the 200ms
    reopen-after-rename dance is an inode-watch artifact. A TS port can instead
    watch the HEAD file's **parent directory** for changes to the `HEAD` entry,
    which sidesteps atomic-rename inode death — as long as it preserves: per-
    association identity, idempotent stop, silent no-op for non-repos, the 150ms
    downstream debounce before running `git status` + branch resolve, and the
    "linked worktree HEAD lives under `.git/worktrees/<name>/HEAD`" resolution via
    `rev-parse --git-path HEAD`.
11. **Path canonicalization.** Reproduce standardize+resolve-symlinks for root
    claims and `--repo` matching (Node: `path.normalize` + `fs.realpathSync`-style,
    tolerating non-existent paths by resolving the longest existing prefix — the
    macOS behavior resolves what it can). `/tmp` vs `/private/tmp` equivalence on
    macOS comes from this; tests rely on it.
12. **Session/association identity.** The graft session id IS the association id.
    The service must accept a start for an association whose id it has never seen
    and enforce uniqueness on the parent root, not the id.
13. **UI mirror is a client concern.** In the new architecture the web client
    should subscribe to graft session events over the WebSocket (map
    `started/updated/stopped` to the same upsert/remove semantics) and implement
    the toggle/swap/orphan state machine of §6 client-side, while every
    source-of-truth decision (claims, stop targets, status) stays daemon-side.
14. **Quit flush** becomes daemon-shutdown flush: on SIGTERM/SIGINT stop all
    sessions with a bounded (2s) grace period before exit; breadcrumbs cover the
    rest. An Electron-shell quit must not skip daemon shutdown handling.
15. **`repoState` marker files** are read directly from the resolved git dir; for
    worktrees `rev-parse --git-dir` points at the per-worktree dir — do not
    shortcut to `<root>/.git`.
16. **`getStatus` counts** untracked files in `changedFiles` but not in
    additions/deletions (`diff --shortstat HEAD`), and swallows shortstat errors
    (fresh repo without HEAD). Sidebar badges depend on these exact semantics.
17. **Concurrency edge already accepted upstream**: stop-during-start leaves an
    ownerless live session (§4.4 note). The port may close this window (e.g. by
    having stop await an in-flight start for the same id), but if it does, keep
    `graft stop --repo <path>`'s orphan fallback — it is also the escape hatch for
    sessions whose associations were deleted.
18. **The `kelpi-graft-index-*` temp index files** go to the OS temp dir and are
    best-effort deleted; a crashed sync can leave them. Harmless; consider a
    startup sweep.
19. **`addAllAndCommit`** is dead code for graft (legacy commit-based design) but
    still part of the service surface; port it only if something else needs it.
20. **Worktree flows**: keep sanitization identical (it is user-visible in path
    previews and replies), keep `<repo>` placeholder semantics in the base path,
    keep `--update-main` = ls-remote-default + fetch + branch off
    `origin/<default>`, and keep `worktreeErrorMessage`'s prefer-the-`fatal:`-line
    behavior — the raw first stderr line of `git worktree add` is misleading.

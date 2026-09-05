# Kelpi Persistence Subsystem — Behavioral Specification

Source of truth: `Nex/Services/DatabaseService.swift`, `Nex/Services/PersistenceService.swift`,
plus the model types they serialize (`Pane`, `PaneLayout`, `WorkspaceGroup`, `WebPaneState`,
`GroupIcon`, `SidebarID`, `Repo`, `RepoAssociation`, `WorkspaceColor`, `PaneType`) and the
load/save wiring in `AppReducer` (`.appLaunched`, `.stateLoaded`, `.persistState`).
Tests: `KelpiTests/DatabaseMigrationTests.swift`.

This document specifies BEHAVIOR for a TypeScript daemon implementation. The implementer will
not read the Swift source.

---

## 1. Overview

Kelpi persists its full workspace/pane/repo/group state to a single SQLite database:

```
~/Library/Application Support/Kelpi/nex.db
```

The directory is created on startup if missing (`mkdir -p` semantics). The database is opened
with:

- **WAL journal mode** (the production connection is a GRDB `DatabasePool`, which enables WAL;
  tests use an in-memory queue).
- **`PRAGMA foreign_keys = ON`** on every connection (cascade deletes depend on it).

The persistence strategy is deliberately simple:

- **Save**: every state-mutating action in the app dispatches a `persistState` action. That
  action snapshots the ENTIRE app state into flat record arrays and hands them to a debounced
  writer. After a 500 ms quiet period, the writer runs ONE transaction that **deletes every row
  in every entity table and re-inserts the snapshot**. There are no per-field updates, no
  diffing, no dirty tracking.
- **Load**: happens exactly once, at app launch. The whole database is read into in-memory
  state, some transient fields are reset (see §7), and from then on the DB is write-only until
  the next launch.

There is no schema-level referential integrity beyond the two FK cascades described below; the
"clear + reinsert" model means the DB is always a self-consistent snapshot of one moment of app
state (modulo the debounce window).

---

## 2. Schema — every table, every column

Conventions used by the current implementation:

- **IDs** are TEXT columns containing UUID strings. When written by the app they are UPPERCASE
  (Swift's `UUID.uuidString`), e.g. `"11111111-2222-3333-4444-555555555555"`. Parsing on load
  is case-insensitive.
- **Timestamps** are REAL (declared `DOUBLE`) columns containing Unix epoch **seconds** as a
  float (e.g. `1755500000.123456`). Not milliseconds, not ISO strings.
- **Booleans** are stored as SQLite integers 0/1 (declared `BOOLEAN`).
- **Enums** are stored as their raw string value (e.g. pane `type` = `"shell"`).
- **Arrays / trees** are stored as JSON text in TEXT columns (exact JSON shapes in §3).

### 2.1 `workspace`

| column          | type    | null | default | meaning |
|-----------------|---------|------|---------|---------|
| `id`            | TEXT PK | no   |         | workspace UUID |
| `name`          | TEXT    | no   |         | display name |
| `slug`          | TEXT    | no*  | `''`    | filesystem-safe slug (see §6.3). *Added in v3 with default `''`; loader regenerates when empty. |
| `color`         | TEXT    | no   |         | `WorkspaceColor` raw value: one of `red, orange, yellow, green, blue, purple, pink, gray, black, white`. Unknown value on load falls back to `blue`. |
| `layoutJSON`    | TEXT    | no   |         | JSON-encoded `PaneLayout` tree (§3.1). Undecodable → treated as `empty` on load. |
| `focusedPaneID` | TEXT    | yes  |         | UUID of focused pane; NULL allowed; invalid UUID → nil on load |
| `createdAt`     | DOUBLE  | no   |         | epoch seconds |
| `lastAccessedAt`| DOUBLE  | no   |         | epoch seconds; bumped when the workspace is activated |
| `sortOrder`     | INTEGER | no   | 0       | index in the app's flat workspace array at save time. Load orders by this column. |
| `labelsJSON`    | TEXT    | no   | `'[]'`  | JSON array of strings, e.g. `["frontend","wip"]`. Ordered, deduped case-sensitively by the app; the DB stores whatever the app has. Undecodable → `[]`. |
| `icon`          | TEXT    | yes  |         | prefix-qualified icon string (§3.4): `"system:star.fill"` or `"emoji:📁"`. NULL / unparseable → default avatar (first letter of name). |
| `profileName`   | TEXT    | yes  |         | assigned workspace-profile name (env-var set). NULL = unassigned (resolves the built-in `default` profile at spawn time). The app normalizes `"default"` / empty string to NULL before it ever reaches the DB. |

Note: there is **no group membership column**. A workspace belongs to a group iff its UUID
appears in some `workspace_group.childOrderJSON`; it is top-level iff it appears in the
`topLevelOrder` app-state value (§2.4). This is the only representation of grouping.

### 2.2 `pane`

| column          | type    | null | default   | meaning |
|-----------------|---------|------|-----------|---------|
| `id`            | TEXT PK | no   |           | pane UUID |
| `workspaceID`   | TEXT    | no   |           | FK → `workspace(id)` **ON DELETE CASCADE** |
| `label`         | TEXT    | yes  |           | user-assigned pane label (used by CLI `--target` name resolution) |
| `type`          | TEXT    | no   | `'shell'` | `PaneType` raw value: `shell | markdown | scratchpad | diff | web`. Unknown value on load → `shell`. |
| `workingDirectory` | TEXT | no   |           | absolute path; new panes default to the user's home directory |
| `createdAt`     | DOUBLE  | no   |           | epoch seconds |
| `lastActivityAt`| DOUBLE  | no   |           | epoch seconds |
| `agentSessionID`| TEXT    | yes  |           | last reported agent session id (Claude/Codex). Named `claudeSessionID` v4→v14, renamed in v15. Drives auto-resume on next launch (§7.3), then is cleared. |
| `status`        | TEXT    | yes  | `'idle'`  | `PaneStatus` raw value: `idle | running | waitingForInput`. Unknown → `idle` on load. (Loaded but immediately reset to `idle` for all non-idle panes — see §7.2.) |
| `filePath`      | TEXT    | yes  |           | for `markdown` panes: the previewed file; for `diff` panes: optional path scope of `git diff` |
| `content`       | TEXT    | yes  |           | scratchpad text body (scratchpad panes only; never written to a file on disk) |
| `webURL`        | TEXT    | yes  |           | LEGACY single-tab URL for `web` panes. Written on save as a fallback for pre-v13 readers; **ignored on load whenever `webTabsJSON` decodes**. Always NULL for non-web panes and for private web panes. |
| `webTabsJSON`   | TEXT    | yes  |           | JSON array of `WebTab` objects (§3.3). NULL/empty → blank web pane. NULL for private panes. |
| `webActiveTabID`| TEXT    | yes  |           | UUID of the active tab; NULL or stale → falls back to first tab. NULL for private panes. |
| `webIsPrivate`  | BOOLEAN | yes  |           | per-pane private browsing flag. Persisted even though the pane's tabs are not, so a restored private pane comes back BLANK but still private (non-persistent cookie store). NULL → false. |
| `agentKind`     | TEXT    | yes  |           | `AgentKind` raw value: `claude | codex`. Last-known agent CLI for this pane; picks the resume command (`claude --resume <id>` vs `codex resume <id>`). NULL = never saw an agent (treated as `claude` where a default is needed). Deliberately NOT cleared on load (§7.3). |

### 2.3 `repo` and `repoAssociation`

`repo` — global registry of known git repos:

| column          | type    | null | default | meaning |
|-----------------|---------|------|---------|---------|
| `id`            | TEXT PK | no   |         | repo UUID |
| `path`          | TEXT    | no, **UNIQUE** | | absolute repo path. Uniqueness enforced by the DB (second insert with same path throws). |
| `name`          | TEXT    | no   |         | display name; defaults to last path component when created |
| `remoteURL`     | TEXT    | yes  |         | e.g. `https://github.com/user/repo.git` |
| `lastAccessedAt`| DOUBLE  | no   |         | epoch seconds |
| `isAutoDiscovered` | BOOLEAN | no | 0      | true when the repo entered the registry via cwd auto-detection rather than explicit user action |

`repoAssociation` — links a workspace to a repo (possibly via a worktree):

| column          | type    | null | default | meaning |
|-----------------|---------|------|---------|---------|
| `id`            | TEXT PK | no   |         | association UUID |
| `workspaceID`   | TEXT    | no   |         | FK → `workspace(id)` **ON DELETE CASCADE** |
| `repoID`        | TEXT    | no   |         | FK → `repo(id)` **ON DELETE CASCADE** |
| `worktreePath`  | TEXT    | no   |         | the checkout path this workspace works in (repo root, or a linked worktree path) |
| `branchName`    | TEXT    | yes  |         | branch of that checkout, when known |
| `isAutoDetected`| BOOLEAN | no   | 0       | true when the association was inferred from a pane's cwd rather than explicitly added |

Both cascades are exercised by tests: deleting a workspace row removes its associations;
deleting a repo row removes its associations. (In practice the app rarely relies on the
cascade because saves clear-and-reinsert everything, but ad-hoc `DELETE` statements do.)

### 2.4 `appState` — key/value singleton store

| column  | type    | null |
|---------|---------|------|
| `key`   | TEXT PK | no   |
| `value` | TEXT    | yes  |

Exactly two keys are written today:

| key                 | value |
|---------------------|-------|
| `activeWorkspaceID` | UUID string of the active workspace, or NULL |
| `topLevelOrder`     | JSON array of `SidebarID` values (§3.2) — the ordered top-level sidebar entries (workspaces AND group headers, interleaved) |

Unlike the entity tables, `appState` rows are **upserted, never cleared** — an unknown key
written by a future version would survive saves from an older version.

### 2.5 `workspace_group`

| column          | type    | null | default | meaning |
|-----------------|---------|------|---------|---------|
| `id`            | TEXT PK | no   |         | group UUID |
| `name`          | TEXT    | no   |         | display name |
| `color`         | TEXT    | yes  |         | `WorkspaceColor` raw value or NULL (no tint) |
| `isCollapsed`   | BOOLEAN | no   | 0       | sidebar collapse state (persisted — survives restart) |
| `childOrderJSON`| TEXT    | no   | `'[]'`  | JSON array of member workspace UUID strings, in sidebar render order (§3.2) |
| `createdAt`     | DOUBLE  | no   |         | epoch seconds |
| `sortOrder`     | INTEGER | no   | 0       | index in the app's groups array at save time; load orders by this |
| `icon`          | TEXT    | yes  |         | same prefix-qualified icon format as workspaces (§3.4) |

### 2.6 Migration bookkeeping table

GRDB's migrator records applied migrations in its own table:

```sql
CREATE TABLE grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY);
```

One row per applied migration identifier (`"v1_initial"` … `"v18_pane_agent_kind"`). On
startup, any registered migration whose identifier is not present is run, in registration
order, each in its own transaction, and its identifier inserted. A TS port keeping the same
DB file must honor this table (see Port notes).

---

## 3. JSON encodings stored inside TEXT columns

These come from Swift's synthesized `Codable`. The shapes below were verified empirically
against the exact enum declarations. Object key ORDER is arbitrary (Swift's JSONEncoder does
not sort keys); parsers must not depend on it. UUIDs are emitted uppercase; parse
case-insensitively.

### 3.1 `workspace.layoutJSON` — the `PaneLayout` tree

`PaneLayout` is a recursive enum:

```ts
type PaneLayout =
  | { empty: {} }
  | { leaf:  { _0: string } }                     // _0 = pane UUID
  | { split: {
        _0: "horizontal" | "vertical";            // split direction
        ratio: number;                            // first child's share, (0,1); UI clamps drags to [0.1, 0.9]
        first: PaneLayout;
        second: PaneLayout;
      } };
```

- `horizontal` = children side by side (left/right); `vertical` = stacked (top/bottom).
- `ratio` is the FIRST child's fraction of the available axis.

Example (one pane on the left at 60%, two stacked on the right):

```json
{"split":{"_0":"horizontal","ratio":0.6,
  "first":{"leaf":{"_0":"11111111-2222-3333-4444-555555555555"}},
  "second":{"split":{"_0":"vertical","ratio":0.5,
    "first":{"leaf":{"_0":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"}},
    "second":{"empty":{}}}}}}
```

An empty workspace stores `{"empty":{}}`. A single pane stores
`{"leaf":{"_0":"<UUID>"}}`.

**Load fallback**: if `layoutJSON` fails to decode (any parse error), the layout becomes
`empty`. The loader does NOT reconcile the layout against the pane rows — a layout referencing
a pane that has no row, or a pane row absent from the layout, is loaded as-is.

### 3.2 UUID arrays and `topLevelOrder`

- `workspace_group.childOrderJSON`: plain JSON array of UUID strings:
  `["11111111-...","AAAAAAAA-..."]`.
- `appState["topLevelOrder"]`: JSON array of tagged sidebar entries:

```json
[{"workspace":{"_0":"11111111-2222-3333-4444-555555555555"}},
 {"group":{"_0":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"}}]
```

```ts
type SidebarID =
  | { workspace: { _0: string } }
  | { group:     { _0: string } };
```

### 3.3 `pane.webTabsJSON` — web pane tabs

```ts
interface WebTab { id: string /* UUID */; url: string; title: string; }
```

```json
[{"id":"5F0C...-...","url":"https://example.com","title":"Example Domain"},
 {"id":"71AB...-...","url":"http://localhost:3000","title":""}]
```

All three fields are always present (title may be `""`).

### 3.4 Icon storage string (workspace `icon`, group `icon`)

NOT JSON — a flat prefix-qualified string chosen for hand-readability:

- `"system:<sf-symbol-name>"`, e.g. `"system:star.fill"` — an SF Symbol identifier, rendered
  tinted with the workspace/group color. (Web port: map to an equivalent icon set or ship the
  SF Symbol name through as an opaque token.)
- `"emoji:<grapheme>"`, e.g. `"emoji:📁"` — a single grapheme rendered as plain text (its own
  colors, no tint).

Parsing rules: unknown prefix → nil; empty payload after the prefix → nil. Nil renders the
fallback (workspace: first-letter avatar; group: color-tinted folder glyph).

### 3.5 `workspace.labelsJSON`

Plain JSON array of strings: `["frontend","wip"]`. App-level invariants (not DB-enforced):
labels are trimmed, non-empty, order-preserving, deduped case-sensitively.

---

## 4. Migration history (all 18, in order)

Migration identifiers are strings; each runs once, recorded in `grdb_migrations`. From v4
onward, every `ALTER TABLE ADD COLUMN` (and the v15 rename) is **guarded**: it first checks
the live column list and skips if the column already exists (or, for v15, if the target name
already exists / the source is missing). This guard exists because pre-release builds sometimes
created columns before the migration record was written; re-running `ADD COLUMN` on an existing
column throws and would wedge startup. A port re-implementing these migrations should keep the
guards (idempotency).

| id | what it does |
|----|--------------|
| `v1_initial` | Creates `workspace` (id, name, color, layoutJSON, focusedPaneID, createdAt, lastAccessedAt, sortOrder DEFAULT 0), `pane` (id, workspaceID FK CASCADE, label, type DEFAULT 'shell', workingDirectory, createdAt, lastActivityAt), `appState` (key PK, value). |
| `v2_repos` | Creates `repo` (id, path UNIQUE, name, remoteURL, lastAccessedAt) and `repoAssociation` (id, workspaceID FK CASCADE, repoID FK CASCADE, worktreePath, branchName). |
| `v3_workspace_slug` | `workspace` + `slug TEXT DEFAULT ''`. |
| `v4_agent_session` | `pane` + `claudeSessionID TEXT` (nullable) and + `status TEXT DEFAULT 'idle'`. Guarded. |
| `v5_markdown_panes` | `pane` + `filePath TEXT`. Guarded. |
| `v6_scratchpad_content` | `pane` + `content TEXT`. Guarded. |
| `v7_repo_assoc_auto_detected` | `repoAssociation` + `isAutoDetected BOOLEAN NOT NULL DEFAULT 0`. Guarded. |
| `v8_repo_auto_discovered` | `repo` + `isAutoDiscovered BOOLEAN NOT NULL DEFAULT 0`. Guarded. |
| `v9_workspace_groups` | Creates `workspace_group` (id, name, color NULL, isCollapsed DEFAULT 0, childOrderJSON DEFAULT '[]', createdAt, sortOrder DEFAULT 0). |
| `v10_workspace_group_icon` | `workspace_group` + `icon TEXT` (nullable). Guarded. |
| `v11_workspace_labels` | `workspace` + `labelsJSON TEXT NOT NULL DEFAULT '[]'`. Guarded. |
| `v12_web_pane_url` | `pane` + `webURL TEXT`. Guarded. |
| `v13_web_pane_tabs` | `pane` + `webTabsJSON TEXT` and + `webActiveTabID TEXT`. Guarded (each column independently). |
| `v14_web_pane_private` | `pane` + `webIsPrivate BOOLEAN` (nullable). Guarded. |
| `v15_rename_agent_session` | RENAMES `pane.claudeSessionID` → `agentSessionID` (agent-generic). Runs only when the old column exists AND the new one doesn't. |
| `v16_workspace_icon` | `workspace` + `icon TEXT`. Guarded. |
| `v17_workspace_profile` | `workspace` + `profileName TEXT`. Guarded. |
| `v18_pane_agent_kind` | `pane` + `agentKind TEXT` (`"claude"`/`"codex"`, issue #101 — picks the resume command on restart). Guarded. |

---

## 5. Save path

### 5.1 Triggers

There is no timer and no save-on-quit flush for the DB. Saves happen because reducer actions
dispatch `persistState` after mutating persisted state. The trigger set is broad — effectively
"anything that changes durable state", including:

- workspace create / rename / recolor / re-icon / delete / reorder / move between groups
- group create / rename / delete / collapse / reorder / sort / icon
- pane create / split / close / move / label / resize (ratio changes) / layout cycle & select
- agent lifecycle (`agentStarted` / `agentStopped` — persists status + session id)
- agent `session-start` / `session-end` (session id binding / clearing)
- repo registry changes, repo association changes, worktree flows
- workspace labels & profiles, web pane tab changes, markdown/scratchpad edits (content)
- active workspace switch, focus changes
- one save at the tail of the launch restore sequence (§7.3)

### 5.2 Debounce semantics

```
save(snapshot):
  cancel any pending write task
  schedule: sleep 500 ms → if not cancelled → writeRecords(snapshot)
```

- The snapshot is taken SYNCHRONOUSLY at dispatch time (full deep copy of persisted state into
  flat record arrays). The debounce delays the WRITE, not the capture — so the write that lands
  is the LAST snapshot, and intermediate snapshots are discarded wholesale.
- Rapid mutations therefore coalesce to one transaction, at the cost of a ≤500 ms window in
  which a crash/force-quit loses the latest changes. **Normal quit does NOT flush the DB
  debounce** (the quit path flushes markdown-editor file writes and graft sessions only), so
  quitting within 500 ms of the last mutation can lose that mutation. Accepted behavior today.

### 5.3 The write transaction (clear + reinsert)

One transaction, in this exact order (delete order respects FKs):

```
DELETE FROM repoAssociation;  DELETE FROM pane;  DELETE FROM workspace;
DELETE FROM repo;             DELETE FROM workspace_group;
INSERT all repo rows
INSERT all workspace rows          (sortOrder = index in app's workspace array)
INSERT all pane rows               (flattened: for each workspace, its visible panes in order)
INSERT all repoAssociation rows
INSERT all workspace_group rows    (sortOrder = index in app's groups array)
UPSERT appState rows               ("activeWorkspaceID", "topLevelOrder")
```

- `appState` rows use save/upsert; the table is never cleared.
- Any error rolls back the transaction and is logged to console and **swallowed** — the app
  keeps running with the previous DB contents intact.
- Pane row insert order doubles as the de-facto pane ordering on load (there is no ORDER BY on
  panes; SQLite returns them in rowid ≈ insert order). Display order actually comes from the
  layout tree, but list surfaces (`pane list`) reflect array order, which round-trips through
  insert order in practice.

### 5.4 Field mapping notes on save

- **Layout**: the record stores `savedLayout ?? layout`. `savedLayout` is set while a pane is
  ZOOMED (temporarily maximized) — it holds the pre-zoom tree. So a zoomed workspace persists
  its un-zoomed layout; zoom state itself does not survive restart.
- **Web panes** (`type == "web"`, sidecar state lives in a per-workspace `webPanes` map keyed
  by pane id):
  - `webIsPrivate` is ALWAYS written for web panes (true/false).
  - If private: `webURL`, `webTabsJSON`, `webActiveTabID` are all written NULL — tabs/URLs of
    private panes intentionally do not survive restart.
  - If not private: `webTabsJSON` = full tab array (omitted/NULL when the tab list is empty),
    `webActiveTabID` = active tab UUID, and `webURL` = the ACTIVE tab's URL (legacy fallback
    only).
  - Non-web panes write NULL for all four columns.
- **Scratchpad content** is persisted in `pane.content`.
- **Timestamps** are converted Date → epoch seconds (float).
- **Parked panes are NOT saved.** A pane parked by `kelpi open --here` (off-layout but PTY kept
  alive) lives in a separate `parkedPanes` lane that the snapshot ignores — it vanishes on
  restart (its ghostty surface couldn't be restored anyway).
- `recentlyClosedPanes` (reopen-closed-pane stack) is NOT saved.

---

## 6. Load path

Runs once, from app launch, before any UI/daemon state exists. Single read transaction.

### 6.1 Read + decode

```
repos       ← SELECT * FROM repo                         (skip rows with unparseable id UUID)
workspaces  ← SELECT * FROM workspace ORDER BY sortOrder (skip unparseable id)
  for each workspace:
    panes   ← SELECT * FROM pane WHERE workspaceID = ?   (skip unparseable id)
    assocs  ← SELECT * FROM repoAssociation WHERE workspaceID = ?
                                                         (skip unparseable id or repoID)
    decode layoutJSON (fallback: empty)
    decode labelsJSON (fallback: [])
    color   ← WorkspaceColor(raw) ?? blue
    icon    ← parse icon string (fallback: nil)
    slug    ← record.slug, or makeSlug(name, id) when record.slug == ""   // legacy backfill
    focused ← UUID(focusedPaneID) (fallback: nil)
activeWorkspaceID ← appState["activeWorkspaceID"] parsed as UUID (fallback: nil)
groups      ← SELECT * FROM workspace_group ORDER BY sortOrder (skip unparseable id)
    childOrder ← decode childOrderJSON as [UUID] (fallback: [])
topLevelOrder ← decode appState["topLevelOrder"] as [SidebarID] (fallback: [])
```

Per-pane decode:

- `type` ← `PaneType(raw) ?? shell`; `status` ← `PaneStatus(raw) ?? idle`;
  `agentKind` ← `AgentKind(raw)` or nil (strict — unknown string → nil).
- `isEditing` is DERIVED: `true` iff type is `scratchpad` (scratchpads restore into edit
  mode); all other panes restore in view mode.
- Web pane sidecar (only when type is `web`):
  1. If `webTabsJSON` is non-null, non-empty, and decodes → use it as the tab list.
  2. Else if `webURL` is non-null and non-empty → one tab `{id: newUUID, url: webURL, title: ""}`
     (pre-v13 rows).
  3. Else → zero tabs (blank pane; this is the restored form of a private pane).
  - `activeTabID` ← parse `webActiveTabID` as UUID, else first tab's id, else nil.
  - `isPrivate` ← `webIsPrivate ?? false`.
- Fields with no column are initialized to their defaults (see §8 transient list).

**Any thrown error during the whole load** (not per-row) → log and return the empty result
(no workspaces, no groups, no order, no active id, no repos): the app then behaves like a
first launch, without touching the broken DB file.

### 6.2 Post-load fixups (the `stateLoaded` handler)

Case A — **zero workspaces loaded** (fresh install or wiped DB):

- Create a workspace named `"Default"` (random-ish color from the palette avoiding recent
  picks, one shell pane cwd = home dir, layout = leaf of that pane, that pane focused), make
  it active, and proceed with launch (drain queued file-opens etc.). Nothing is written to the
  DB until the next `persistState`.

Case B — normal restore:

1. Install loaded workspaces / groups / repos into state.
2. `activeWorkspaceID` ← loaded value, else first workspace's id.
3. `topLevelOrder`: if the loaded array is EMPTY (legacy DB from before groups existed),
   synthesize it as `[workspace(id) for each workspace, in loaded order]`; otherwise use it
   verbatim. (No validation that entries reference live workspaces/groups.)
4. Capture **resumable panes**: every pane (across all workspaces) with a non-null
   `agentSessionID` yields a tuple `(paneID, sessionID, kind ?? claude)`. Captured BEFORE
   clearing.
5. **Clear** every pane's `agentSessionID` (set nil) and reset every non-`idle` pane's
   `status` to `idle`. Rationale: status is tied to a live PTY, which never survives restart;
   a stale persisted `running` would otherwise falsely trigger the "agents still running"
   quit-confirmation dialog (issue #129). `agentKind` is deliberately NOT cleared — it is a
   last-known display value and the resume tuples already captured it.
6. Spawn terminal surfaces for every `shell` pane (workingDirectory, workspace profile env).
7. **Auto-resume**: if any resumable tuples exist, wait 2 seconds (surfaces/PTYs settling),
   then for each tuple type the resume command into that pane's PTY:
   - command = `claude --resume <sessionID>` (kind claude) or `codex resume <sessionID>`
     (kind codex);
   - SKIPPED (silently) unless the session id passes the shell-safety allowlist:
     non-empty, ≤128 chars, every char ASCII alphanumeric or `.` `_` `-`. This is a security
     gate — the id arrived over the local socket and is being typed into a shell.
8. AFTER the resume commands are sent, dispatch one `persistState` — this writes the
   CLEARED session ids back to the DB. Ordering is deliberate: if the app crashes before the
   resumes execute, the ids are still on disk and the next launch retries.
9. Kick off git status refresh, HEAD watchers for every repo association, label→preset
   migration, queued Finder file-opens, graft recovery.

### 6.3 Slug generation (legacy backfill)

`makeSlug(name, id)`:

```
base   = name.lowercased(), every run of [^a-z0-9] replaced with "-", trimmed of "-"
suffix = first 8 chars of the UUID string, lowercased
slug   = base == "" ? suffix : base + "-" + suffix
```

e.g. `("My App!", 5F0C24D9-…)` → `"my-app-5f0c24d9"`. Applied on load only when the stored
slug is the empty string (v3 default); also applied on workspace create and rename.

---

## 7. What is persisted vs. transient

### 7.1 Persisted (survives restart)

App level: workspace list + order, group list + order + collapse state, top-level sidebar
order, active workspace id, repo registry, repo associations.

Per workspace: id, name, slug, color, icon, profileName, labels, layout tree (un-zoomed),
focused pane id, createdAt, lastAccessedAt.

Per pane: id, owning workspace, label, type, workingDirectory, filePath, scratchpad content,
agentSessionID (written, but consumed-and-cleared by the next launch), agentKind, status
(written, but reset to idle on load), createdAt, lastActivityAt, web tabs + active tab +
private flag (tabs/URLs withheld for private panes).

### 7.2 Deliberately transient (reset every launch)

Workspace: `focusHistory`, `parkedPanes` (and any pane in them, PTY included),
`recentlyClosedPanes`, `zoomedPaneID` + `savedLayout` (the un-zoomed tree is what gets saved),
search state (`searchingPaneID`, needle, counts), `currentLayoutIndex` (predefined-layout cycle
position), `isSyncInputActive` + `syncInputExcluded` (sync-input always starts off).

Pane: `title` (live terminal/web title), `gitBranch` (re-detected), `isEditing` (recomputed:
scratchpad → true), `externalEditorCommand`, `markdownFontSize` (resets to 14),
`parkedSourcePaneID`, `agentStartedAt` (elapsed-time badge starts blank until the agent
re-emits a start), `backgroundTaskCount` (0).

Web pane sidecar: console ring buffer, inspector arm state + nonce + result queue, batch
inspect session, last batch target. Only `tabs` / `activeTabID` / `isPrivate` persist.

App: `pendingFileOpens`, socket reply handles, git status caches, keybindings (config file,
not DB), settings (UserDefaults/config file, not this DB).

### 7.3 Restore-with-teeth summary (the resume contract)

`agentSessionID` + `agentKind` exist so that a restart can put the user back INTO their agent
sessions: launch reads them, clears the ids in memory, spawns PTYs, waits 2 s, types
`claude --resume <id>` / `codex resume <id>` into each affected pane (allowlist permitting),
and only then persists the cleared state. `kelpi event session-end` clears a pane's session id
at runtime when the ending session matches (so an exited session isn't resumed); Codex has no
session-end hook, so a stale codex id may persist and be resumed (known limitation).

---

## 8. Equivalent SQLite DDL for the TS daemon

This is the schema as it exists after v18, expressed as plain DDL. (SQLite's ALTER-produced
schema differs cosmetically — column order and the absence of NOT NULL on late-added columns
are preserved here.)

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE workspace (
  id             TEXT PRIMARY KEY,          -- UUID (uppercase as written)
  name           TEXT NOT NULL,
  color          TEXT NOT NULL,             -- red|orange|yellow|green|blue|purple|pink|gray|black|white
  layoutJSON     TEXT NOT NULL,             -- PaneLayout JSON (§3.1)
  focusedPaneID  TEXT,
  createdAt      DOUBLE NOT NULL,           -- epoch seconds
  lastAccessedAt DOUBLE NOT NULL,
  sortOrder      INTEGER NOT NULL DEFAULT 0,
  slug           TEXT DEFAULT '',
  labelsJSON     TEXT NOT NULL DEFAULT '[]',
  icon           TEXT,                      -- "system:<name>" | "emoji:<grapheme>"
  profileName    TEXT
);

CREATE TABLE pane (
  id               TEXT PRIMARY KEY,
  workspaceID      TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  label            TEXT,
  type             TEXT NOT NULL DEFAULT 'shell',  -- shell|markdown|scratchpad|diff|web
  workingDirectory TEXT NOT NULL,
  createdAt        DOUBLE NOT NULL,
  lastActivityAt   DOUBLE NOT NULL,
  agentSessionID   TEXT,                    -- was claudeSessionID before v15
  status           TEXT DEFAULT 'idle',     -- idle|running|waitingForInput
  filePath         TEXT,
  content          TEXT,                    -- scratchpad body
  webURL           TEXT,                    -- legacy single-tab fallback
  webTabsJSON      TEXT,                    -- [WebTab] JSON (§3.3)
  webActiveTabID   TEXT,
  webIsPrivate     BOOLEAN,                 -- 0/1/NULL(=false)
  agentKind        TEXT                     -- claude|codex|NULL
);

CREATE TABLE appState (
  key   TEXT PRIMARY KEY,                   -- "activeWorkspaceID", "topLevelOrder"
  value TEXT
);

CREATE TABLE repo (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  remoteURL       TEXT,
  lastAccessedAt  DOUBLE NOT NULL,
  isAutoDiscovered BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE repoAssociation (
  id           TEXT PRIMARY KEY,
  workspaceID  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  repoID       TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  worktreePath TEXT NOT NULL,
  branchName   TEXT,
  isAutoDetected BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE workspace_group (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  color          TEXT,
  isCollapsed    BOOLEAN NOT NULL DEFAULT 0,
  childOrderJSON TEXT NOT NULL DEFAULT '[]', -- [UUID] JSON
  createdAt      DOUBLE NOT NULL,
  sortOrder      INTEGER NOT NULL DEFAULT 0,
  icon           TEXT
);

-- GRDB migration ledger (must be honored when adopting an existing nex.db)
CREATE TABLE IF NOT EXISTS grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY);
```

TS-ish record interfaces (as read/written, before decoding the JSON columns):

```ts
interface WorkspaceRow {
  id: string; name: string; slug: string; color: string;
  layoutJSON: string; focusedPaneID: string | null;
  createdAt: number; lastAccessedAt: number; sortOrder: number;
  labelsJSON: string; icon: string | null; profileName: string | null;
}
interface PaneRow {
  id: string; workspaceID: string; label: string | null; type: string;
  workingDirectory: string; filePath: string | null; content: string | null;
  agentSessionID: string | null; agentKind: string | null; status: string;
  createdAt: number; lastActivityAt: number;
  webURL: string | null; webTabsJSON: string | null;
  webActiveTabID: string | null; webIsPrivate: 0 | 1 | null;
}
interface AppStateRow { key: string; value: string | null; }
interface RepoRow {
  id: string; path: string; name: string; remoteURL: string | null;
  lastAccessedAt: number; isAutoDiscovered: 0 | 1;
}
interface RepoAssociationRow {
  id: string; workspaceID: string; repoID: string;
  worktreePath: string; branchName: string | null; isAutoDetected: 0 | 1;
}
interface WorkspaceGroupRow {
  id: string; name: string; color: string | null; isCollapsed: 0 | 1;
  childOrderJSON: string; createdAt: number; sortOrder: number; icon: string | null;
}
```

---

## 9. Invariants and edge cases (checklist)

1. Entity tables are always a single-moment snapshot: partial writes are impossible (one
   transaction), and a failed write leaves the previous snapshot intact.
2. Debounce window: up to 500 ms of the newest state can be lost on crash OR on normal quit
   (no DB flush at quit). The launch-restore save (§6.2 step 8) is intentionally ordered
   AFTER resume commands so a crash mid-restore retries resumes.
3. `appState` is upsert-only; never cleared. Only two keys today.
4. `repo.path` UNIQUE is the only value-level DB constraint; app logic must dedupe repos by
   path before insert or the whole save transaction fails (and is swallowed).
5. Rows with unparseable UUIDs are silently skipped on load (row-level tolerance);
   a hard read error abandons the entire load and boots as a fresh install without
   destroying the file.
6. Unknown enum strings degrade: color→blue, pane type→shell, status→idle, agentKind→null,
   icon→null. Layout/labels/childOrder/topLevelOrder JSON parse failures degrade to
   empty/[]-equivalents.
7. `slug == ""` on load ⇒ regenerate via `makeSlug` (v3 legacy rows).
8. `topLevelOrder == []` on load ⇒ synthesize from flat workspace order (pre-groups DB).
9. Group membership = presence in a group's `childOrderJSON`; top-level presence =
   `topLevelOrder`. No column on `workspace` encodes grouping. Nothing validates that the two
   are disjoint/exhaustive — app logic maintains that invariant.
10. Private web panes persist ONLY `type='web'` + `webIsPrivate=1` (+ generic pane fields);
    tabs, URLs, and cookies are dropped by design.
11. `webTabsJSON` is authoritative; `webURL` is a write-only legacy fallback consumed only
    when `webTabsJSON` is null/empty/undecodable.
12. `agentSessionID` round-trip: persisted at runtime, consumed for resume at next launch,
    cleared in memory immediately, cleared on disk only after resume commands are sent.
13. Session ids are typed into shells at restore; the ASCII-allowlist gate
    (`[A-Za-z0-9._-]{1,128}`) is a security boundary and MUST be preserved by any port.
14. `agentKind` survives load un-cleared (last-known badge value + resume verb selection).
15. Panes are stored flat with a `workspaceID`; the layout tree is per-workspace JSON. There
    is no reconciliation between them at load. Keep writes atomic so they can't diverge.
16. Zoom is never persisted: the snapshot stores `savedLayout ?? layout`.
17. Parked panes and recently-closed snapshots are never persisted.
18. Scratchpad panes restore with `isEditing = true`; content comes from `pane.content` only
    (never a file).
19. Deleting a workspace/repo row via raw SQL cascades to `repoAssociation` (and workspace →
    pane); requires `foreign_keys=ON` on the connection.
20. First launch (empty DB or unreadable DB): create one workspace named "Default" with a
    single shell pane in the home directory; persist on the next mutation.

---

## Port notes

Things the TypeScript daemon port must get right, and places it may deliberately diverge:

**Must keep (behavioral contract):**

- **DB adoption**: if the daemon adopts an existing `nex.db`, it must (a) run/verify the same
  migration ledger (`grdb_migrations` identifiers `v1_initial` … `v18_pane_agent_kind`), only
  applying migrations whose identifiers are absent, keeping the per-migration column-existence
  guards; and (b) parse the exact JSON shapes in §3 — most notably the Swift-Codable enum
  encodings with `_0` keys for `PaneLayout` and `SidebarID`, uppercase UUIDs (parse
  case-insensitively), and epoch-SECONDS float timestamps (not ms — a naive `Date.now()` write
  would corrupt every timestamp by 1000×).
- **Graceful degradation table** (§9 items 5–8): unknown enums, broken JSON, empty slug, empty
  topLevelOrder each have a defined fallback; none may crash the load or drop sibling rows.
- **Resume pipeline** (§6.2 steps 4–8) including the session-id shell-safety allowlist and the
  clear-in-memory / persist-after-resume ordering. The 2 s settle delay is an empirical PTY
  warm-up value; keep something equivalent.
- **Transient-field reset** (§7.2), especially status→idle on load — clients (quit dialogs,
  status bar, `pane list`, `workspace delete` running-agents guard) all assume a fresh boot
  has zero active agents until hooks re-report.
- **Private web pane contract**: flag persists, contents never do.
- **`repo.path` UNIQUE + FK cascades + `foreign_keys=ON`** (better-sqlite3 requires the pragma
  per connection, same as GRDB).

**Where the port can and probably should diverge:**

- **Daemon-owned DB location**: `~/Library/Application Support/Kelpi/nex.db` is a macOS-ism. A
  headless daemon should choose an XDG-style path (e.g. `~/.local/share/kelpi/nex.db` with
  `$KELPI_DATA_DIR` override) and, on first run, MIGRATE by copying the legacy macOS path's file
  if present so existing users keep their workspaces. Keep WAL mode (the daemon is long-lived
  and single-writer; WAL also allows concurrent read snapshots for the web client).
- **Per-field / per-entity saves**: the clear-and-reinsert full-snapshot model is simple and
  matches TCA's "state is one value" world, but in a daemon that mutates state at higher
  frequency (every socket command, every client edit) it causes needless churn (every pane row
  rewritten because one label changed) and briefly holds a write lock on the whole dataset.
  A port can keep the SAME schema but move to upsert/delete-by-id per entity, ideally still
  behind a short debounce and always inside one transaction per logical mutation. If it does,
  it must take over the invariants the snapshot model gave for free: orphan deletion (pane
  rows for deleted workspaces — the FK cascade covers this if deletes go through the
  `workspace` table), `sortOrder` renumbering on reorder, and appState upserts.
- **Timestamps**: if the daemon owns fresh DBs (no adoption), switching to INTEGER epoch-ms or
  ISO-8601 TEXT is reasonable — but then the adoption/migration step must convert, and the
  wire surfaces (`workspace list` prints ISO 8601 already) must stay unchanged.
- **JSON columns**: `layoutJSON`'s `_0`-keyed encoding is an artifact of Swift, not a design.
  For daemon-created DBs a cleaner tagged form (`{"type":"split","direction":"horizontal",...}`)
  is fine — but the reader must accept BOTH forms if old DBs are adopted, or a one-time v19
  migration should rewrite the column. Same for `topLevelOrder`'s SidebarID encoding. Pick one:
  dual-read or rewrite-migration; do not write the Swift shapes from TS by hand unless you
  keep byte-compatibility tests.
- **Quit flush**: a daemon can (and should) flush the pending debounced write on graceful
  shutdown (SIGTERM handler), eliminating the 500 ms loss window the Mac app tolerates.
- **appState growth**: the key/value table is the natural home for new daemon-level singletons
  (schema version of the TS layer, last-connected client, etc.). Remember it is upsert-only —
  design keys to be forward/backward compatible.
- **Session resume ownership**: in the new architecture the daemon owns PTYs, so restore no
  longer needs an app-launch trigger — the daemon can resume sessions on ITS start, and a
  reconnecting client just renders. The allowlist gate must move with it. Also note the Mac
  app types the resume command into the shell (visible to the user, runs under the user's
  shell env/profile); a daemon spawning `claude --resume X` directly as the PTY command would
  change semantics (shell rc files, cwd inheritance, what happens when the command exits) —
  emulate the "type into an interactive shell" behavior.
- **Settings/keybindings/profiles are NOT in this DB** — they live in `~/.config/nex/config`
  and (macOS) UserDefaults. The port's daemon config story is a separate subsystem; nothing in
  `nex.db` should absorb it silently.
- **Graft sessions** are not in this DB either (breadcrumb files + in-memory service); listed
  here only so no one goes looking for a table.

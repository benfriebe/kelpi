# Socket command handlers — behavioral specification

Source of truth: `Nex/AppReducer+Socket.swift` (the socket reduce-block), plus the shared
helpers it calls in `Nex/AppReducer.swift` (`resolvePaneTarget`, `resolveWorkspace`,
`resolveGroup`, `paneSendText`, `tailLines`, graft handlers, `handlePing`),
`Nex/AppReducer+RepoGit.swift` (`performWorktreeAdd`, `worktreeErrorMessage`),
`Nex/Services/SocketServer.swift` (`ReplyHandle`), and the model helpers referenced below.

This document specifies how every wire command is **handled** once it has been parsed off the
socket. Wire framing/parsing (newline-delimited JSON, `"command"` key, the
`replyCommandAllowlist`) is specced in the socket-server doc; this doc picks up at the point
where the daemon holds a decoded message plus an optional reply handle.

Audience: TypeScript implementers of the new headless daemon. The `kelpi` CLI must keep working
unchanged, so every reply key, error string, and resolution rule below is normative.

---

## 1. The reply handle contract

Every handler receives an optional **reply handle** (`reply`). It is non-null only for
commands in the reply allowlist; all other commands (and messages from pre-request/response
CLIs) get `null`.

```ts
interface ReplyHandle {
  id: number;                      // unique per connection slot
  send(json: object): void;        // writes ONE newline-terminated JSON line to the client FD
  close(): void;                   // cancels the client read source -> client sees EOF
  sendAndClose(json: object): void; // send + close
  error(message: string): void;    // sendAndClose({ ok: false, error: message })
}
```

Rules:

- **Request/response mode** (every command except `web-console --follow`): call `send`
  exactly once, then `close`. One JSON line, then EOF.
- **Streaming mode**: call `send` repeatedly without `close`. The daemon holds the handle
  (e.g. in the web-console subscriber map) and writes newline-delimited JSON lines as events
  arrive. The stream ends when the *client* disconnects; the transport layer then delivers a
  synthetic `socketSubscriberDisconnected(replyID)` message so the daemon can release the
  held handle.
- **Legacy fire-and-forget** (`reply == null`): all guards and validations still run. On
  success the side effect is still performed; on failure the command is silently dropped
  (no error is deliverable). Old CLIs keep working against a new server this way.
- Success payloads always include `"ok": true`; failures are exactly
  `{"ok": false, "error": "<message>", ...optional extras}`. The CLI exits non-zero on
  `ok: false`.
- Dropping a handle on the floor is safe — the transport's EOF path closes orphaned FDs.

### Reply-before-effect ordering

Many handlers send the success reply **before** the side effect actually executes
(`pane-split`, `pane-create`, `pane-close`, `pane-send`, `pane-send-key`, `pane-resize`,
`pane-move-adjacent`, `pane-name`, `pane-sync`, `pane-sync-exclude`, the non-worktree
`workspace-create`, `workspace-delete`). The ack is optimistic: new-entity UUIDs are minted
up front and threaded into the effect so the acked id is guaranteed to be the real one.
Async handlers (`pane-capture`, `graft-*`, worktree `workspace-create`) reply only after the
async work resolves.

---

## 2. Name-or-id resolution semantics

There are **two different workspace resolvers** in the codebase with different matching
rules. This asymmetry is load-bearing for CLI compatibility.

### 2.1 `resolveWorkspace(nameOrID)` — the strict instance resolver

Used by: `pane list --workspace`, `pane sync --workspace`, `resolvePaneTarget`'s
`--workspace` scope, `pane split/create --workspace`, `workspace-move`, `workspace-delete`,
`workspace-profile`, `workspace-label`, `workspace-list --group` (via `resolveGroup`).

```
resolveWorkspace(nameOrID):
  if nameOrID parses as UUID and a workspace with that id exists -> that workspace
  matches = workspaces where name == nameOrID   // CASE-SENSITIVE exact match
  if matches.length == 1 -> matches[0]
  else -> null                                   // both "not found" and "ambiguous"
```

- **UUID wins**: a valid UUID string that matches a workspace id always resolves, even if
  some workspace is *named* that UUID string.
- A UUID string that matches no workspace id falls through to the name match (so a
  workspace literally named a UUID is still reachable).
- Ambiguous names (2+ workspaces with the same exact name) return `null`. Callers that
  want to distinguish "ambiguous" from "missing" must re-check themselves (only
  `workspace-delete` does; see §6.4).

### 2.2 `resolveGroup(nameOrID)` — identical contract for groups

Same algorithm over the group collection: UUID-wins, then case-sensitive exact unique name,
`null` for missing/ambiguous.

### 2.3 Static `resolveWorkspace(target, state)` — the lenient resolver

Used **only** by `pane-move-to-workspace` and the graft scope resolver (`graft-start`/
`graft-stop` `--workspace`). Different rules:

```
staticResolveWorkspace(target):
  if target parses as UUID and workspace exists       -> that id
  first workspace whose name matches target
       case-INSENSITIVELY (locale-aware compare)      -> that id   // FIRST match, no ambiguity guard
  first workspace whose slug == target                -> that id
  else -> null
```

Note: case-insensitive, first-match (state order) on collision, and it also accepts the
workspace **slug** (`makeSlug`: lowercased name, non-alphanumeric runs → `-`, trimmed,
suffixed with the first 8 hex chars of the id, e.g. `my-project-a1b2c3d4`).

### 2.4 `resolvePaneTarget(paneID, target, workspaceFilter)` — the pane resolver

The shared resolver behind `pane close`, `send`, `send-key`, `capture`, `name`, `resize`,
`move-adjacent` (moved pane), `sync exclude/include`, and the `--target` branches of
`split`/`create`. Inputs:

- `paneID` — the caller's own pane UUID, forwarded from `NEX_PANE_ID` (may be absent).
- `target` — the `--target <name-or-uuid>` value (may be absent).
- `workspaceFilter` — the `--workspace <name-or-id>` value (may be absent).

Returns either `{ paneID, workspace }` or an error string suitable for
`{ok:false,error:...}`. Full algorithm:

```
resolvePaneTarget(paneID, target, workspaceFilter):
  // 1. Resolve the explicit workspace scope up front.
  scopedWorkspace = null
  if workspaceFilter != null:
    scopedWorkspace = resolveWorkspace(workspaceFilter)          // strict resolver, §2.1
    if scopedWorkspace == null:
      return error("workspace not found: {workspaceFilter}")

  // 2. Resolve the pane. `target` takes precedence over `paneID`.
  if target != null:
    if target parses as UUID:
      if scopedWorkspace != null:
        if scopedWorkspace has no pane with that id:
          return error("no pane with UUID '{target}' in workspace '{scopedWorkspace.name}'")
      else:
        if no workspace has a pane with that id:
          return error("no pane with UUID '{target}'")
      resolvedID = target
    else:                                                        // label lookup
      if scopedWorkspace != null:
        candidates = scopedWorkspace.panes where label == target // case-sensitive exact
        originName = null
      else if paneID != null and some workspace's panes contain paneID:
        origin     = that workspace                              // the caller's own workspace
        candidates = origin.panes where label == target
        originName = origin.name
      else if paneID != null:                                    // stale NEX_PANE_ID
        return error("origin pane '{paneID}' no longer exists; pass --workspace <name-or-id> to address a pane in another workspace")
      else:
        return error("label '{target}' requires --workspace <name-or-id> when called from outside a Kelpi pane")

      switch candidates.length:
        0 -> return error("no pane with label '{target}'" + scopeSuffix)
             // scopeSuffix:
             //   scoped:  " in workspace '{scopedWorkspace.name}'"
             //   origin:  " in workspace '{originName}' (use --workspace <name-or-id> to address another workspace)"
             //   neither: ""   (unreachable given the guards above)
        1 -> resolvedID = candidates[0].id
        n -> return error("label '{target}' is ambiguous ({n} matches); pass --workspace <name-or-id> to disambiguate")

  else if paneID != null:                                        // no --target: act on the caller pane
    if no workspace's panes contain paneID:
      return error("no pane with UUID '{paneID}'")
    resolvedID = paneID
  else:
    return error("missing pane_id and target")                   // defensive; wire decoder rejects this

  // 3. Locate the containing workspace and enforce the scope.
  workspace = the workspace whose panes contain resolvedID
  if none: return error("pane not found: {resolvedID}")
  if scopedWorkspace != null and workspace.id != scopedWorkspace.id:
    return error("pane '{resolvedID}' is not in workspace '{scopedWorkspace.name}'")

  return found(resolvedID, workspace)
```

Key invariants:

- **UUID targets are global**; label targets require a scope (explicit `--workspace` or
  implicit caller workspace). There is deliberately **no global label fallback** — a bare
  label with neither scope is refused, never guessed.
- Label matching is **case-sensitive exact**.
- Only **visible** panes are searched (a workspace's `panes` collection / layout). Parked
  panes (shells parked by `kelpi open --here`) are *not* user-addressable through this
  resolver.
- A UUID `--target` combined with `--workspace` must be a member of that workspace (two
  different error strings depending on which check fails, see algorithm).

### 2.5 `resolvePaneInWorkspace(workspace, ref)` — anchor resolver

Used only for the `pane-move-adjacent` **anchor**, which must share the moved pane's
workspace:

```
resolvePaneInWorkspace(ws, ref):
  if ref parses as UUID: return ws.panes has ref ? ref : null
  matches = ws.panes where label == ref
  return matches.length == 1 ? matches[0].id : null
```

### 2.6 `resolveGroupMember(token, members)` — group-reorder token resolver

```
resolveGroupMember(token, members /* ordered UUIDs of live group members */):
  if token parses as UUID and members contains it -> token
  matches = members whose workspace.name == token    // case-sensitive
  return matches.length == 1 ? matches[0] : null
```

### 2.7 `workspaceContainingPane(paneID)` — lifecycle-routing lookup

Searches **both** the visible `panes` and the `parkedPanes` lane. Used by the agent
lifecycle handlers (so events on parked shells aren't dropped), by `pane-sync`'s implicit
workspace scope, and by the graft pane-scope path. Contrast with the user-command
resolvers above, which search `panes` only.

---

## 3. Agent lifecycle handlers (fire-and-forget)

These have no reply handle. All of them route via `workspaceContainingPane` (parked panes
included) and silently drop the event when no workspace owns the pane.

Pane status values: `"idle" | "running" | "waitingForInput"`.

### 3.1 `start` → agentStarted(paneID, agent)

- `agent` is `"claude"` or `"codex"` (absent/unknown wire value ⇒ `claude`,
  case-insensitive mapping).
- If the pane's status is already `running`, reset it to `idle` first — a start while
  running means the previous stop was missed (user interrupted the agent), and the status
  lifecycle must stay clean.
- Then: forward the start to the owning workspace's agent-status logic (sets status
  `running`, records `agentKind`, starts the running timer) and refresh external
  indicators (menu bar / dock badge).

### 3.2 `stop` → agentStopped(paneID, backgroundTaskCount)

`backgroundTaskCount` defaults to 0 when the wire field is absent.

```
isFocused        = (activeWorkspaceID == ws.id) && (ws.focusedPaneID == paneID)
isAppActive      = <is the app frontmost?>         // web port: is any client window focused
hasBackgroundWork = backgroundTaskCount > 0
shouldNotify     = (!isFocused || !isAppActive) && !hasBackgroundWork
shouldBounce     = !isAppActive && !hasBackgroundWork
title            = pane.title ?? ws.name
```

Effects, in order:
1. Forward the stop (with the count) to the workspace — with `count > 0` the pane **stays
   `running`** instead of flipping to `waitingForInput` (issues #215/#220); with 0 it goes
   `waitingForInput`.
2. Refresh external indicators.
3. If `shouldNotify`: post a desktop notification `title` / body
   `"Agent is waiting for input"` tagged with `paneID` + `workspaceID` (clicking it focuses
   the pane).
4. If `shouldBounce`: request user attention (macOS dock bounce; web port: equivalent
   attention affordance).

The suppression while background work is in flight kills the notification churn from the
repeat Stops Claude fires as each background shell/subagent completes.

### 3.3 `error` → agentError(paneID, message)

Forward to the workspace (status handling), refresh indicators, and **always** post a
desktop notification with title `"Agent Error"` and body = the wire `message` (no
focus/app-active gating).

### 3.4 `notification` → notification(paneID, title, body, backgroundTaskCount)

Deliberately routed **through the agentStopped path** so the same background-aware status
rule applies (a Notification arriving mid-background-work keeps the pane `running`):

1. Forward `agentStopped(paneID, backgroundTaskCount)` to the workspace.
2. Refresh external indicators.
3. If `!isFocused || !isAppActive`: post the notification with the **wire-provided**
   `title`/`body`. Unlike the synthetic stop-path notification this one is *not* suppressed
   by background work — it may be an actionable permission prompt.

### 3.5 `session-start` → sessionStarted(paneID, sessionID, agent)

Forward to the workspace (binds `agentSessionID`, updates `agentKind`) and refresh
external indicators.

### 3.6 `session-end` → sessionEnded(paneID, sessionID)

Forward to the workspace (clears the pane's tracked session id **only when it still equals
the ending `sessionID`**, issue #178) and then **persist state** — the cleared id must
survive the next launch or a restart would `--resume` a dead session.

---

## 4. Pane command handlers

### 4.1 `pane-split` → handlePaneSplit

Inputs: `paneID?` (NEX_PANE_ID), `direction?` (`horizontal`/`vertical`; default
horizontal), `path?` (`--path`), `name?` (`--name`, the label), `target?`, `workspaceFilter?`.

Routing precedence (identical for `pane-create`):

```
if target == null and workspaceFilter != null:
  // --workspace alone selects the DESTINATION workspace outright,
  // beating the caller's forwarded NEX_PANE_ID.
  ws = resolveWorkspace(workspaceFilter)
       or error("workspace not found: {workspaceFilter}")
  source = ws.focusedPaneID ?? ws.panes.first?.id
       or error("workspace '{ws.name}' has no pane to split — use `kelpi pane create --workspace {workspaceFilter}`")
else if target != null or paneID != null:
  (source, ws) = resolvePaneTarget(paneID, target, workspaceFilter)   // errors pass through
else:
  error("pane split requires --target or --workspace when called from outside a Kelpi pane")
```

Then (defensive re-lookup): if the workspace vanished, `error("workspace not found")`.

Side effects & reply:
1. Mint `newID` (fresh UUID) up front.
2. Set focus to the resolved source pane (the split-at-path action splits the *focused*
   pane, so focus must be set first; this focus change is user-visible).
3. **Reply immediately** (before the pane exists):

```json
{"ok": true, "pane_id": "<newID>", "workspace_id": "<ws uuid>", "workspace_name": "dev", "label": "worker-1"}
```

`label` is included only when `name` is non-null and non-empty.

4. Dispatch the split: with `path` → split the focused pane with the new pane's cwd set to
   `path`; without → split `source` directly. Both carry `direction ?? horizontal`,
   `label = name`, and the pre-minted `newID` so the created pane really gets the acked id.

### 4.2 `pane-create` → handlePaneCreate

Same inputs minus `direction`. Same three-way routing as `pane-split`, except the
`--workspace`-alone branch does **not** require the workspace to have a pane
(`source = ws.focusedPaneID ?? ws.panes.first?.id`, possibly null), and the
outside-caller error string is
`"pane create requires --target or --workspace when called from outside a Kelpi pane"`.

After the defensive workspace check:

1. Mint `newID`; **reply immediately** with the same payload shape as `pane-split`.
2. `source = resolvedSource ?? ws.focusedPaneID ?? ws.panes.first?.id`.
3. If `source == null` (**empty workspace**): dispatch create-first-pane carrying `newID`,
   `label = name`, `workingDirectory = path` — this is the route a split-only handler
   cannot serve, and the acked pane must actually get the label/path.
4. Otherwise (populated workspace): focus `source`; with `path` → split-at-path
   (default horizontal) with `label`/`newID`; without → plain horizontal split of `source`
   with `label`/`newID`.

### 4.3 `pane-close` → handlePaneClose

Resolve via `resolvePaneTarget`. On error: `{ok:false,error}`. On success:

```json
{"ok": true, "pane_id": "<uuid>", "workspace_id": "<uuid>", "workspace_name": "dev", "label": "worker-1"}
```

(`label` only when the pane has one.) Then dispatch the workspace's close-pane action
(which handles layout removal, focus fallback, surface teardown, persistence). Legacy
`reply == null`: still dispatch the close on success.

### 4.4 `pane-name` → handlePaneName

Resolve via `resolvePaneTarget` (works with no `--target` = rename the caller pane).
`newLabel = name == "" ? null : name` — an empty string **clears** the label. Mutates the
pane's label synchronously, replies:

```json
{"ok": true, "pane_id": "<uuid>", "workspace_id": "<uuid>", "workspace_name": "dev", "label": "new-name"}
```

(`label` omitted when cleared.) Then persist state.

### 4.5 `pane-send` → handlePaneSend

Inputs: `paneID?`, `target` (required by the wire), `text`, `workspaceFilter?`, `bare`.
Resolve via `resolvePaneTarget`. Success reply (sent **before** the PTY write):

```json
{"ok": true, "pane_id": "<uuid>", "workspace_id": "<uuid>", "workspace_name": "dev", "bare": false, "label": "worker-1"}
```

Then write to the pane's PTY:
- `bare == true`: write the text bytes verbatim (no trailing Enter). Bracketed-paste
  wrapping, if any, is the terminal write path's concern.
- `bare == false`: write the text then an Enter keystroke, so the receiver runs it as a
  command.

The same write helper is reused by the web-pane element picker (which defaults to bare).

### 4.6 `pane-send-key` → handlePaneSendKey

Inputs: `paneID?`, `target`, `key`, `workspaceFilter?`.

**Key validation runs before target resolution** so an unknown key never resolves (or
touches) a pane. `normalizedKey = key.toLowerCase()`; the allowlist (order matters for the
error string):

```
enter, return, tab, escape, esc, space, backspace, up, down, left, right, ctrl-c
```

Unknown → `{ok:false,error:"unknown key '<key>' (valid: enter, return, tab, escape, esc, space, backspace, up, down, left, right, ctrl-c)"}`.

Then resolve via `resolvePaneTarget`; success reply (before the keystroke):

```json
{"ok": true, "pane_id": "...", "workspace_id": "...", "workspace_name": "dev", "key": "enter", "label": "worker-1"}
```

Then synthesize the named key on the pane's terminal, outside any bracketed-paste
envelope. Byte-mapped keys (enter/return `\r`, tab `\t`, escape `\x1b`, space, backspace,
ctrl-c `\x03`) are sent as raw bytes through the key-event path with no modifiers so the
PTY line discipline sees them (ctrl-c ⇒ SIGINT); arrow keys are sent as key events with no
text so the terminal encodes them per DECCKM mode (`\eOA` vs `\e[A`).

### 4.7 `pane-capture` → handlePaneCapture

Inputs: `paneID?`, `target?`, `workspaceFilter?`, `lines?`, `includeScrollback`.

Validation order:
1. `lines != null && lines <= 0` → `error("lines must be a positive integer (got {lines})")`.
   (The CLI pre-validates, but raw socket clients can send anything.)
2. `resolvePaneTarget` (no `--target` ⇒ capture the caller's own pane, requires
   NEX_PANE_ID).
3. Defensive pane lookup → `error("pane not found: {uuid}")`.
4. Pane type must be `shell` → `error("pane is not a terminal (type: markdown)")` (the
   actual type raw value: `markdown`/`scratchpad`/`diff`/`web`).

Then asynchronously read the pane's terminal contents (viewport, or viewport + full
scrollback when `includeScrollback`). If the surface died mid-read →
`{ok:false,error:"pane closed during capture"}`. Apply `tailLines` when `lines` given:

```
tailLines(text, n):
  if n <= 0 or text == "": return ""
  hadTrailingNewline = text ends with "\n"
  body = hadTrailingNewline ? text without last char : text
  parts = body.split("\n")          // KEEP empty segments
  out = last n parts joined by "\n"
  return hadTrailingNewline ? out + "\n" : out
```

Success reply:

```json
{"ok": true, "pane_id": "...", "workspace_id": "...", "workspace_name": "dev", "text": "…captured lines…\n", "label": "worker-1"}
```

### 4.8 `pane-move` (directional form) → fire-and-forget

Inputs: `paneID` (required), `direction` (`left|right|up|down`). No reply, no errors.
Find the workspace whose `panes` contain the pane (silently drop if none), focus the pane,
then dispatch the workspace's directional-move action (swap/move toward the neighbouring
pane in the layout).

### 4.9 `pane-resize` → handlePaneResize

Inputs: `paneID?`, `target?`, `workspaceFilter?`, `ratio?` (`--ratio`), `delta?`
(`--grow` = +delta, `--shrink` = −delta; the CLI encodes both as one signed delta).

1. Resolve via `resolvePaneTarget`.
2. If the workspace has a zoomed pane → `error("cannot resize while a pane is zoomed — un-zoom first")`
   (while zoomed the live layout is a single leaf; the real tree is parked, so a resize
   cannot map to a split).
3. Locate the pane's **immediate enclosing split**: the deepest split node whose direct
   first/second child is the pane's leaf. If none (pane is the sole root leaf) →
   `error("pane {uuid} has no sibling to resize against (it is the only pane in its workspace)")`.
   The result carries `(path, paneIsFirst, direction)` where `path` is the split-path
   string: `"d"` = root split, each appended `L`/`R` navigates into the first/second child
   (e.g. `"dLR"`).
4. Compute the desired **pane share** (the pane's own fraction of the split):
   - `ratio` given → `desiredShare = ratio`.
   - `delta` given → `currentRatio = layout ratio at path, default 0.5 if unreadable`;
     `currentShare = paneIsFirst ? currentRatio : 1 - currentRatio`;
     `desiredShare = currentShare + delta`.
   - Neither → `error("pane resize requires --ratio or --grow/--shrink")`.
5. `clampedShare = clamp(desiredShare, 0.1, 0.9)`;
   `newRatio = paneIsFirst ? clampedShare : 1 - clampedShare` (the split node always
   stores the **first child's** fraction).
6. Rewrite the split node's ratio (the write path clamps to [0.1, 0.9] again) and clear the
   workspace's tracked predefined-layout index (a manual ratio breaks the predefined
   layout, mirroring GUI divider drags).
7. Reply:

```json
{"ok": true, "pane_id": "...", "workspace_id": "...", "workspace_name": "dev",
 "split_path": "dL", "ratio": 0.7, "target_share": 0.3, "label": "coordinator"}
```

(`ratio` = the stored first-child ratio, `target_share` = the clamped share of the target
pane; they differ when the pane is the second child.)

8. Persist state.

### 4.10 `pane-move-adjacent` → handlePaneMoveAdjacent

The CLI form of GUI drag-and-drop. Inputs: `paneID?`, `target` (moved pane), `anchor`
(pane to dock against), `zone` (`top|bottom|left|right`), `workspaceFilter?`.

1. Resolve the moved pane via `resolvePaneTarget`.
2. Resolve the anchor via `resolvePaneInWorkspace(movedPane's workspace, anchor)` — the
   anchor **must** live in the same workspace (the layout move operates on one tree).
   Failure → `error("no pane matching '{anchor}' in workspace '{ws.name}'")` (covers
   missing, other-workspace, and ambiguous-label anchors alike).
3. `anchorID == movedID` → `error("cannot move a pane adjacent to itself")`.
4. Zone name mapping for the reply: `top→"above"`, `bottom→"below"`, `left→"left-of"`,
   `right→"right-of"`.
5. Reply (before the move):

```json
{"ok": true, "pane_id": "<moved>", "anchor_id": "<anchor>", "zone": "below",
 "workspace_id": "...", "workspace_name": "dev", "label": "worker-1"}
```

6. Dispatch the workspace's move-pane action (re-parents the moved pane's leaf onto the
   given edge of the anchor — same operation as GUI drag-drop) **and** persist state.

### 4.11 `pane-move-to-workspace` → inline (fire-and-forget, no reply)

Inputs: `paneID` (required), `toWorkspace` (string), `create` (bool).

```
sourceWS = workspace whose panes contain paneID; if none: drop.
targetWSID = staticResolveWorkspace(toWorkspace)      // §2.3: UUID, case-insensitive name, slug

if targetWSID == null and create:
  newID = uuid()
  append a NEW workspace:
    name  = toWorkspace verbatim
    slug  = makeSlug(toWorkspace, newID)
    color = nextRandomColor()      // random WorkspaceColor != the trailing workspace's color
    panes = [], layout = empty, focusedPaneID = null
    createdAt = lastAccessedAt = now
  append to topLevelOrder; sidebar scrolls the new workspace into view
  targetWSID = newID

if targetWSID == null or targetWSID == sourceWS.id: drop.
pane = sourceWS.panes[paneID]; if missing: drop.

// Web sidecar: a web pane's tab/URL state lives in ws.webPanes[paneID],
// not on the Pane struct — capture it before removal or the target gets
// a blank pane and `kelpi web url` fails with "web pane state missing".
webState = pane.type == "web" ? sourceWS.webPanes[paneID] : null

REMOVE from source:
  panes.remove(paneID); webPanes.delete(paneID) if webState
  syncInputExcluded.delete(paneID)                     // else a later move-back silently re-applies the opt-out
  layout = layout.removing(paneID); currentLayoutIndex = null
  focusHistory: remove all entries == paneID
  if focusedPaneID == paneID:
    focusedPaneID = popFocusFromHistory(excluding paneID) ?? newLayout.allPaneIDs.first
  if searchingPaneID == paneID:
    clear searchingPaneID / searchNeedle / searchTotal / searchSelected
    if pane.type == "markdown": also clear the in-document find highlights for that pane
  if zoomedPaneID == paneID:
    layout = savedLayout.removing(paneID)               // restore the parked tree minus the pane
    zoomedPaneID = null; savedLayout = null

ADD to target:
  panes.append(pane); webPanes[paneID] = webState if any
  if target layout is empty: layout = leaf(paneID)
  else:
    anchor = target.focusedPaneID ?? target layout's first leaf
    layout = layout.splitting(anchor, direction: horizontal, newPaneID: paneID)
  setFocus(paneID); currentLayoutIndex = null
  activeWorkspaceID = targetWSID                        // the app switches to the destination

FINALLY:
  push fresh sync-group snapshots for BOTH source and target to the
  keystroke-broadcast layer (the direct state mutation bypasses the
  per-workspace bookkeeping that normally does this)
  persist state
```

### 4.12 `pane-list` → handlePaneList (pure read)

Inputs: `paneID?`, `workspaceFilter?`, `scope?` (`null | "all" | "current"`). Requires a
reply handle (no-op without one).

Validation:
- `workspaceFilter != null && scope == "current"` →
  `error("workspace and --current are mutually exclusive")`.
- `scope` null or `"all"`: with `workspaceFilter` → strict `resolveWorkspace` or
  `error("workspace not found: {filter}")`, listing that one workspace; without → all
  workspaces (state order).
- `scope == "current"`: requires `paneID` owned by some workspace's `panes`, else
  `error("no workspace contains the requesting pane")`; lists that workspace.
- any other scope value → `error("unknown scope: {scope}")` (empty string when null).

Per workspace, panes are enumerated in **layout order** (the layout tree's leaf order),
skipping ids with no backing pane; parked panes never appear (not in the layout).
Timestamps: ISO 8601 with internet date-time format.

```jsonc
{"ok": true, "panes": [
  {
    "id": "5B2C…-full-uuid",
    "type": "shell",                       // shell|markdown|scratchpad|diff|web
    "workspace_id": "…",
    "workspace_name": "dev",
    "working_directory": "/Users/me/proj",
    "status": "running",                   // idle|running|waitingForInput
    "is_focused": true,
    "is_active_workspace": true,
    "created_at": "2026-08-18T01:02:03Z",
    "last_activity_at": "2026-08-18T01:05:00Z",
    // optional keys — present only when set:
    "label": "coordinator",
    "title": "zsh — proj",
    "git_branch": "main",
    "agent_session_id": "full-session-uuid",
    "agent": "claude",                     // last-known kind, never cleared — NOT "attached now"
    "background_tasks": 2,                 // only when > 0
    "file_path": "/Users/me/notes.md",     // markdown/diff/web panes
    "group_id": "…", "group_name": "Client X"   // only when the workspace is in a group
  }
]}
```

### 4.13 `pane-sync` (`on|off|toggle|status`) → handlePaneSync

Workspace resolution (note: **not** `resolvePaneTarget`):
1. `workspaceFilter` given → strict `resolveWorkspace` or
   `error("workspace not found: {filter}")`.
2. else `paneID` given → `workspaceContainingPane(paneID)` (**parked panes count** here).
3. else → `error("pane sync requires --workspace or NEX_PANE_ID")`.

`action` lowercased: `on` → nextActive true; `off` → false; `toggle` → `!current`;
`status` → reply the current snapshot and stop (read-only, no mutation); anything else →
`error("unknown sync action '{action}' (valid: on, off, toggle, status)")`.

For the mutating verbs, the reply is a **predicted post-change snapshot** built before
dispatch: copy the workspace, set `isSyncInputActive = nextActive`, and clear the excluded
set when `nextActive == false`. Then dispatch the actual state change. (The real reducer
clears the excluded set on **every** activation change and no-ops when the value is
unchanged — so a `sync on` while already on keeps exclusions, and exclusions staged while
sync was off are wiped on the next transition. The reply snapshot can diverge from final
state only in the staged-while-off corner case; see Port notes.)

Sync status reply shape (shared by `status`, `on/off/toggle`, and `exclude/include`):

```jsonc
{
  "ok": true,
  "workspace_id": "…",
  "workspace_name": "dev",
  "active": true,
  "synced_pane_ids": ["<uuid>", "<uuid>"],       // sorted lexicographically by uuid string
  "excluded": [ {"id": "<uuid>", "label": "logs"} ]  // sorted by uuid string; label optional;
                                                     // excluded ids with no live pane are skipped
}
```

`synced_pane_ids` is the computed broadcast group: empty unless sync is active AND at
least two `shell`-type, non-excluded panes qualify (a lone terminal never syncs to
itself); non-shell panes are always filtered out.

### 4.14 `pane-sync-exclude` (exclude/include) → handlePaneSyncExclude

Inputs: `paneID?`, `target` (required), `workspaceFilter?`, `excluded` (bool).
Resolve via `resolvePaneTarget` (same scoping as `pane send`). Build the predicted
snapshot (insert/remove the pane id in the excluded set), reply with the sync-status shape
above, then dispatch the exclusion change (the reducer additionally no-ops when the pane
id isn't in that workspace's visible panes, and refreshes the broadcast group).

---

## 5. Cross-cutting pane/workspace bookkeeping

- **refreshSyncGroup**: every state change that alters a workspace's pane set, sync flag,
  or exclusion set must push the freshly computed `syncedPaneIDs` snapshot for that
  workspace into the keystroke-broadcast layer. Handlers that dispatch workspace actions
  get this for free (the workspace reducer does it); `pane-move-to-workspace` mutates
  state directly and therefore pushes snapshots for **both** source and target workspaces
  explicitly.
- **persistState**: state persistence is debounced (500 ms full-state serialize). Handlers
  that mutate app state inline emit an explicit persist: `pane-name`, `pane-resize`,
  `pane-move-adjacent`, `pane-move-to-workspace`, `workspace-label`, `group-create`,
  `group-reorder`/`group-sort`, `session-end`. Handlers that only dispatch workspace/app
  actions rely on those actions' own persistence (`close-pane`, `split`, `create`,
  `delete-workspace`, `move-workspace-to-group`, …).
- **sidebarScrollTarget**: creating a workspace or group over the socket records it as the
  sidebar scroll target so the GUI scrolls the new row into view (issue #187). Web port:
  same UX — scroll the sidebar to the newly created entity.

---

## 6. Workspace command handlers

### 6.1 `workspace-list` → handleWorkspaceList (pure read)

Input: `group?` (name-or-id filter). Requires a reply handle.

- Non-empty `group` filter → `resolveGroup` (strict) or
  `error("no group matches '{filter}'")` — an unknown/ambiguous group is an **error**, not
  an empty list, so scripts can tell "no such group" from "empty group". The filter set is
  the group's `childOrder` members.
- Ordering: walk the sidebar's top-level order; a workspace entry contributes itself, a
  group entry contributes its members in child order (**regardless of the group's
  collapsed state** — unlike the GUI's visible order). Dedupe throughout. Then append any
  workspace unreachable through the top-level order, in state order, so a recoverable
  ordering inconsistency can never hide a workspace from the CLI. Finally apply the group
  filter, preserving order.

Entry shape (timestamps plain ISO 8601):

```jsonc
{"ok": true, "workspaces": [
  {
    "id": "…", "name": "dev", "color": "blue",           // red|orange|yellow|green|blue|purple|pink|gray|black|white
    "pane_count": 3,
    "is_active": true,
    "created_at": "2026-08-18T01:00:00Z",
    "last_accessed_at": "2026-08-18T02:00:00Z",
    "labels": ["wip", "client-x"],                        // always present, possibly []
    // optional:
    "last_activity_at": "2026-08-18T02:05:00Z",           // max of the panes' lastActivityAt; absent with no panes
    "agent_session_id": "…",                              // the FIRST pane carrying one
    "group_id": "…", "group_name": "Client X"             // absent for top-level workspaces
  }
]}
```

### 6.2 `workspace-create` → handleSocketWorkspaceCreate

Inputs: `name?`, `path?`, `color?`, `group?`, `profile?`, `worktree?`, `branch?`,
`updateMain` (bool), `repo?`. `workspaceName = name ?? "Workspace"`.

Three branches, checked in this order:

#### (a) Worktree branch (`worktree` non-null, non-empty) — issue #222

1. **Group pre-resolution** (`trimmedGroup` = trimmed `group`): if given,
   `resolveGroup` must succeed → resolvedGroupID. If it fails but **any** group has that
   exact name → `error("group name is ambiguous: {g} (use the id or rename an existing group)")`;
   otherwise →
   `error("unknown group: {g} — --worktree only supports existing groups; create it first (`kelpi group create`) or omit --group")`.
   The worktree path never creates a group (a failed async worktree add would orphan it).
2. `repoPathRaw = repo ?? path`; missing/empty →
   `error("--worktree requires a source repo (pass --repo <path>)")`. Standardize the path.
3. Sanitize names with the shared git-name sanitizer (preserves `A-Za-z0-9/._-`, collapses
   everything else — and runs of `-`/`/`/`.` — to single separators, trims leading/trailing
   `-/._ `; returns null when nothing survives):
   - `folderName = sanitize(worktree)` or `error("\"{worktree}\" isn't a usable worktree name")`
   - `worktreeBranch = branch (if non-empty) else worktree`;
     `safeBranch = sanitize(worktreeBranch)` or `error("\"{worktreeBranch}\" isn't a usable branch name")`
4. Find the source repo in the repo registry by standardized path, or mint a new
   `Repo{ id: uuid(), path, name: lastPathComponent }` (registered on success).
5. `worktreePath = resolvedWorktreeBasePath(repoPath) + "/" + folderName`. The base path
   setting expands `~` and a `<repo>` placeholder (`<repo>` at the start ⇒ the full repo
   path; elsewhere ⇒ the repo's directory name).
6. Pre-mint the workspace id. Then **asynchronously**:
   - `updateMain == false`: `git worktree add <worktreePath> -b <safeBranch>` off current
     HEAD.
   - `updateMain == true`: resolve the repo's default branch (via
     `git ls-remote --symref`), `git fetch origin`, then create the worktree branched off
     `origin/<default>`.
   - On success: dispatch workspace creation seeded with the worktree (name, color,
     `repos:[sourceRepo]`, resolved groupID, profile, the pre-minted id, and a worktree
     seed `{path, branchName}` so the first pane opens in the worktree and a repo
     association is attached). Reply:

     ```json
     {"ok": true, "workspace_id": "…", "workspace_name": "feature-x",
      "worktree_path": "/Users/me/worktrees/feature-x", "branch": "feature-x", "group": "Client X"}
     ```
     (`group` present only when a group was resolved.)
   - On failure: `{ok:false, error: worktreeErrorMessage(err)}` where the message is
     derived from git's stderr: prefer the **last** line starting with `fatal:`/`error:`
     (case-insensitive), else the last non-empty line, else the whole stderr, else the
     generic error description. (git prints "Preparing worktree (…)" *before* the real
     fatal line, so first-line reporting is wrong.)
   - The CLI runs this command with an extended read timeout (slow `git fetch`).

#### (b) Top-level branch (no worktree, `group` missing or whitespace-only)

Pre-mint the id, **reply immediately** —

```json
{"ok": true, "workspace_id": "…", "workspace_name": "Workspace"}
```

— then dispatch workspace creation with `name`, `color`, `workingDirectory = path`,
`profileName = profile`, and the pre-minted id (that action appends the workspace with one
pane, spawns its surface, activates it, persists).

#### (c) Group branch (no worktree, non-blank `group`)

1. Ambiguity pre-check **before any mutation**: `existingGroup = resolveGroup(trimmed)`;
   if null but any group has that exact name →
   `error("group name is ambiguous: {g} (use the id or rename an existing group)")`.
2. Pre-mint the workspace id; construct the workspace inline:
   `color = color ?? nextRandomColor()`; the built-in single starter pane's
   `workingDirectory = path` when given;
   `profileName = normalizedAssignment(profile)` (trims; empty or `"default"` ⇒ null).
3. Capture `previousActiveID` (the currently active workspace) **before** activating the
   new one — it anchors near-selection placement.
4. Append the workspace to state and the top-level order; make it active; set the sidebar
   scroll target.
5. Resolve or create the group: use `existingGroup.id`, or append a brand-new group
   `{id: uuid(), name: trimmed}` to state + top-level order.
6. Placement index inside the group's child order, honoring the user's
   new-workspace-placement setting: `endOfList` ⇒ append (null index); `nearSelection` ⇒
   the slot right after `previousActiveID`'s position in the target group's child order
   when present, else append. (A freshly created group has an empty child order, so both
   modes append.)
7. **Reply**: `{"ok": true, "workspace_id": …, "workspace_name": …, "group": "<trimmed name>"}`.
8. Effects: (i) spawn the first pane's terminal surface with env resolved from the
   assigned profile (falling back to the built-in `default` profile), and (ii) dispatch
   move-workspace-to-group(workspaceID, groupID, index) — which itself persists, so no
   explicit persist here (it would race).

### 6.3 `workspace-move` → handleSocketWorkspaceMove (fire-and-forget)

Inputs: `nameOrID`, `group?`, `index?`. Strict `resolveWorkspace`; null ⇒ silent no-op.
`group == null` targets the top level; non-null must resolve via `resolveGroup` (creation
deliberately unsupported here — that's `workspace-create --group`), null ⇒ silent no-op.
Dispatch move-workspace-to-group(workspaceID, groupID-or-null, index).

### 6.4 `workspace-delete` → handleWorkspaceDelete

Inputs: `nameOrID`, `force` (bool). (The CLI's bulk form loops one message per id;
`--prune-worktree` is entirely client-side, driven by the reply's `path`.)

```
ws = resolveWorkspace(nameOrID)
if ws == null:
  // Distinguish ambiguity from absence for actionable scripting errors:
  if nameOrID is not a UUID and count(workspaces where name == nameOrID) > 1:
    error("workspace name is ambiguous: {nameOrID} (use the id)")
  else:
    error("workspace not found: {nameOrID}")

// Last-workspace guard — matches the GUI's disabled Delete item; deliberately
// stricter than the ⌘W close-last-pane path (which can reach zero workspaces).
if total workspace count <= 1:
  error("refusing to delete the last workspace")

// Running-agents guard — an "active agent" is any pane, visible OR parked,
// whose status != "idle" (i.e. running or waitingForInput).
n = ws.activeAgentCount
if !force and n > 0:
  reply {"ok": false,
         "error": "workspace {ws.name} has {n} running agent(s); pass --force to delete anyway",
         "active_agents": n}
  // literal noun: "agent" when n == 1, "agents" otherwise
  return
```

Success reply, sent before the delete executes:

```json
{"ok": true, "workspace_id": "…", "workspace_name": "feature-x", "path": "/Users/me/worktrees/feature-x"}
```

`path` = the working directory of the first **shell** pane, falling back to the first pane
of any type; omitted when the workspace has no panes (documented limitation: an empty
workspace's worktree can't be auto-pruned). Then dispatch workspace deletion (closes
remaining panes/surfaces, removes from orders, fixes active workspace, persists).

Legacy `reply == null`: guards still apply; delete dispatched on success, dropped silently
on failure.

### 6.5 `workspace-profile` → fire-and-forget

Strict `resolveWorkspace`; null ⇒ silent no-op (UUID-wins / unique-name / ambiguous⇒no-op).
Dispatch set-profile(profile-or-null) on the workspace (normalization of
`"default"`/empty to null happens in that action's handling).

### 6.6 `workspace-label` → handleWorkspaceLabel

Inputs: `nameOrID`, `op` (`"set"|"add"|"remove"|"clear"`), `values: string[]`.

1. Strict `resolveWorkspace` or `error("no workspace matches '{nameOrID}'")`.
2. Normalize every value: trim whitespace/newlines, clamp to **64 characters**, drop
   values that normalize to empty.
3. Apply, mutating the workspace's ordered `labels: string[]` inline (so the reply shows
   the post-mutation set):

| op | empty-normalized guard | mutation | `introduced` |
|---|---|---|---|
| `set` | `error("no label value to set (use --clear to remove all labels)")` — a set whose values all normalize away must NOT silently wipe labels | dedupe (first occurrence wins, order preserved); replace the whole list | the deduped list |
| `add` | `error("no label value to add")` | append each value not already present (order preserved) | **all** normalized values (already-present ones included; harmless, see back-fill) |
| `remove` | `error("no label value to remove")` | remove every matching value | — |
| `clear` | (values ignored) | `labels = []` | — |
| other | — | `error("unknown label operation '{op}'")` | — |

4. Reply:

```json
{"ok": true, "workspace_id": "…", "workspace_name": "dev", "labels": ["wip", "client-x"]}
```

5. Effects: persist state, **plus preset back-fill** — for each `introduced` label,
   ensure a label preset exists with the default gray color. Creating a preset is a no-op
   when a preset with that name already exists, so a user's chosen color is never
   overwritten. This keeps the invariant that every applied label is a managed preset
   (visible/recolorable in Settings ▸ Labels). `remove`/`clear` never delete presets.

---

## 7. Group command handlers

### 7.1 `group-list` → handleGroupList (pure read)

Requires a reply handle. Order: group ids appearing in the sidebar's top-level order
(deduped — a corrupted order with a duplicate entry must not list a group twice), then any
groups missing from that order appended in state order (never hide a group). Member lists
follow each group's child order, skipping dangling ids.

```jsonc
{"ok": true, "groups": [
  {
    "id": "…", "name": "Client X",
    "workspaces": [ {"id": "…", "name": "dev"}, {"id": "…", "name": "staging"} ],
    "color": "blue"        // optional — omitted when the group has no color
  }
]}
```

### 7.2 `group-create` → fire-and-forget

Trim the name; whitespace-only ⇒ silent no-op (a blank group would render as empty header
chrome and be unreachable by name resolution once duplicated). Append
`{id: uuid(), name: trimmed, color?}` to groups and the top-level order, set the sidebar
scroll target to the new group header, persist. Icon is deliberately **not** settable over
the wire (UI-only affordance).

### 7.3 `group-rename` / `group-delete` → fire-and-forget

`resolveGroup(nameOrID)`; null ⇒ silent no-op. Rename dispatches the rename action with
the new name; delete dispatches deletion with the `cascade` flag (without cascade,
children promote to top level; with it, member workspaces are deleted too).

### 7.4 `group-reorder` / `group-sort` → handleGroupReorder (shared)

`group-reorder` carries `explicitOrder: string[]`; `group-sort` carries
`sortBy: string` + `descending: bool`. Exactly one is set per message.

1. `resolveGroup` or `error("no group matches '{nameOrID}'")`.
2. `members` = the group's child order filtered to ids with a live workspace, **deduped**
   (a corrupted child order with duplicates must not break the sort-key table build).
3. **Explicit order**: resolve each token via `resolveGroupMember` (§2.6) —
   non-member/unknown/ambiguous → `error("'{token}' is not a workspace in group '{group.name}'")`;
   a repeated resolution → `error("workspace '{token}' listed more than once")`. Members
   omitted from the order keep their prior relative order at the **tail**.
4. **Sort**: key = lowercased `sortBy`:
   - `name` → workspace name, locale-aware case-insensitive ascending.
   - `last-activity` / `last_activity` → max of the workspace's panes'
     `lastActivityAt`, epoch-minimum when no panes.
   - `last-accessed` / `last_accessed` / `last-modified` / `last_modified` →
     workspace `lastAccessedAt`.
   - other → `error("unknown sort key '{sortBy}' (use name|last-activity|last-accessed)")`.
   Stable: ties keep prior relative order (original index tiebreak). `descending`
   inverts the **key comparison**, not the final array — so ties still keep their
   original order rather than flipping.
5. Neither given → `error("no order or sort key given")` (defensive).
6. Ids present in the stored child order whose workspace vanished are preserved at the
   tail (never drop ids from the stored order).
7. Write the new child order; reply:

```json
{"ok": true, "group_id": "…", "group_name": "Client X",
 "order": ["<uuid>", "<uuid>", "<uuid>"]}
```

`order` contains only the **live** members (the preserved dangling ids are excluded from
the reply), full UUID strings, final order. Then persist state.

---

## 8. File & layout commands (all fire-and-forget)

### 8.1 `open` → openFile(path, paneID?, reuse)

The CLI's `kelpi open`/`kelpi md` markdown route. If `paneID` is set and some workspace's
`panes` contain it: focus that pane, then open the markdown file in that workspace —
reusing the caller's pane (converting it in place) when `reuse` is true, else opening a
new markdown pane. Otherwise fall back to the active workspace (no reuse); with no active
workspace, drop.

### 8.2 `diff` → openDiff(repoPath, targetPath?, paneID?)

Same routing shape: with a known `paneID`, focus it and open the diff pane in its
workspace; else the active workspace. `repoPath` is the repo to diff, `targetPath` the
optional path scope. Never reuses a pane.

### 8.3 `layout-cycle` → layoutCycle(paneID)

Workspace containing the pane (visible panes only); drop if none. Dispatch
cycle-predefined-layout on that workspace.

### 8.4 `layout-select` → layoutSelect(paneID, name)

Same workspace lookup, **and** `name` must be a valid predefined layout raw value:
`even-horizontal | even-vertical | main-horizontal | main-vertical | tiled` — otherwise
silently drop. Dispatch select-layout.

---

## 9. Graft handlers (`graft-start` / `graft-stop` / `graft-status`)

Graft mirrors a worktree's changes onto its parent repo checkout via a background sync
service. Sessions are keyed by **association id** (the workspace↔repo association's UUID).

### 9.1 Scope resolution — `resolveGraftAssociations(workspaceFilter, repoFilter, paneID)`

```
if workspaceFilter != null:
  wsID = staticResolveWorkspace(workspaceFilter)      // LENIENT resolver (§2.3)
  if none -> failure("workspace not found: {workspaceFilter}")
  scope = [that workspace]
else if paneID != null:
  ws = workspaceContainingPane(paneID)                // parked panes included
  if none -> failure("no workspace contains the requesting pane")
  scope = [ws]
else if repoFilter != null:
  scope = ALL workspaces
else:
  failure("graft requires --workspace, --repo, or NEX_PANE_ID")

results = []
for ws in scope, for assoc in ws.repoAssociations:
  if repoFilter != null:
    match = assoc.worktreePath == repoFilter
         or lastPathComponent(assoc.worktreePath) == repoFilter
         or repoRegistry[assoc.repoID].name == repoFilter
    if !match: continue
  results.append(assoc)

if results empty -> failure("no repo associations matched the requested scope")
```

### 9.2 `graft-start`

Resolve scope; failure → `{ok:false,error}`. Then asynchronously, for each association in
order, ask the graft service to start a session. Collect successes as

```json
{"association_id": "…", "worktree_path": "/…", "branch": "feature-x", "parent_repo_root": "/…"}
```

Reply:
- all failed → `{"ok": false, "error": "<last error's description>"}` (fallback
  `"graft start failed"` if no error text);
- partial → `{"ok": true, "started": [...], "partial_error": "<last error>"}`;
- all succeeded → `{"ok": true, "started": [...]}`.

### 9.3 `graft-stop`

Resolve scope, with one deliberate tolerance: a resolution **failure is non-fatal iff
`repoFilter != null && workspaceFilter == null`** — the session's owning association may
have been deleted with its workspace (issue #231) and only the service still knows it. All
other failures (no scope at all, unknown workspace) reply `{ok:false,error}` immediately.

Then asynchronously, against the **service's** live sessions (never the reducer mirror —
they can diverge, and a mirror-lost session must still be stoppable):

```
targetIDs = active sessions whose id ∈ resolved association ids
if repoFilter != null:
  // Orphan fallback: match remaining sessions by path.
  for session in active where session.id ∉ targetIDs:
    candidates = [ session.worktreePath, lastPathComponent(worktreePath),
                   session.parentRepoRoot, lastPathComponent(parentRepoRoot) ]
    if candidates contains repoFilter
       or candidates contains canonicalize(repoFilter):
         // canonicalize = expand ~, standardize, resolve symlinks (/tmp -> /private/tmp)
      targetIDs.append(session.id)

if targetIDs empty: reply {"ok": true, "stopped": []}    // NOT an error
else:
  stop each; collect successes (uuid strings) and failures {"association_id", "error"}
  reply {"ok": <failures empty>, "stopped": [...], "failed": [...]?}   // "failed" only when non-empty
```

### 9.4 `graft-status`

No scoping. Reports the **service's** sessions (source of truth; a mirror-lost session
must still show up so "already active" rejections are explainable):

```jsonc
{"ok": true, "sessions": [
  {
    "association_id": "…",
    "worktree_path": "/…",
    "parent_repo_root": "/…",
    "branch": "feature-x",
    "status": "watching",            // starting|watching|syncing|error
    "error": "…",                    // only when status == "error"
    "stash_ref": "stash@{0}",        // optional
    "last_sync": "2026-08-18T02:00:00Z"  // optional, ISO 8601
  }
]}
```

---

## 10. `ping`

Always succeeds:

```json
{"ok": true, "version": "0.32.0", "build": "123", "pid": 48213}
```

`version`/`build` from the app's version metadata (`"unknown"` fallback); `pid` is the
server process id (used by `kelpi doctor` to triage stale socket files and CLI/app drift).

---

## 11. `socketSubscriberDisconnected(replyID)`

Synthetic message from the transport whenever a client connection carrying a reply handle
drops. Fires for **every** dropped handle, not just streaming ones — the handler must be a
cheap no-op for ordinary request/response calls. Behavior: remove `replyID` from every
pane's web-console subscriber map, then drop panes whose subscriber maps became empty.

---

## 12. Web-pane verbs (delegated)

The following commands flow through this same dispatch point but are handled by the
web-pane subsystem (see its spec): `web-open`, `web-navigate`, `web-url`, `web-back`,
`web-forward`, `web-reload`, `web-capture`, `web-tabs`, `web-tab-new`, `web-tab-close`,
`web-tab-select`, `web-console` (the only streaming command), `web-inspect`,
`web-inspect-result`, `web-private`, `web-cookies-list`, `web-cookies-clear`,
`web-cookies-delete`, `web-click`, `web-type`, `web-qtext`, `web-qattr`, `web-qcount`,
`web-qexists`, `web-qdom`, `web-wait`, `web-select`, `web-scroll`, `web-hover`, `web-key`,
`web-exec`. All of them (except `web-open`, which takes only `paneID`/`url`/`isPrivate`)
scope their target via the tuple `{paneID?, target?, workspaceFilter?}` with resolution
semantics analogous to `resolvePaneTarget` but restricted to web panes.

---

## 13. Quick reference — reply payloads

| Command | Success payload keys (beyond `ok:true`) |
|---|---|
| pane-split / pane-create | `pane_id` (new pane), `workspace_id`, `workspace_name`, `label?` |
| pane-close | `pane_id`, `workspace_id`, `workspace_name`, `label?` |
| pane-name | `pane_id`, `workspace_id`, `workspace_name`, `label?` (omitted when cleared) |
| pane-send | `pane_id`, `workspace_id`, `workspace_name`, `bare`, `label?` |
| pane-send-key | `pane_id`, `workspace_id`, `workspace_name`, `key` (normalized), `label?` |
| pane-capture | `pane_id`, `workspace_id`, `workspace_name`, `text`, `label?` |
| pane-resize | `pane_id`, `workspace_id`, `workspace_name`, `split_path`, `ratio`, `target_share`, `label?` |
| pane-move-adjacent | `pane_id`, `anchor_id`, `zone`, `workspace_id`, `workspace_name`, `label?` |
| pane-list | `panes: [...]` |
| pane-sync / pane-sync-exclude | `workspace_id`, `workspace_name`, `active`, `synced_pane_ids`, `excluded` |
| workspace-list | `workspaces: [...]` |
| workspace-create | `workspace_id`, `workspace_name`, `group?` (+ `worktree_path`, `branch` on the worktree path) |
| workspace-delete | `workspace_id`, `workspace_name`, `path?` (failure may add `active_agents`) |
| workspace-label | `workspace_id`, `workspace_name`, `labels` |
| group-list | `groups: [...]` |
| group-reorder / group-sort | `group_id`, `group_name`, `order` |
| graft-start | `started: [...]`, `partial_error?` |
| graft-stop | `stopped: [...]`, `failed?: [...]` (`ok` false only when a stop failed) |
| graft-status | `sessions: [...]` |
| ping | `version`, `build`, `pid` |

Fire-and-forget (no reply ever): agent lifecycle events, `pane-move` (directional),
`pane-move-to-workspace`, `workspace-move`, `workspace-profile`, `group-create`,
`group-rename`, `group-delete`, `open`, `diff`, `layout-cycle`, `layout-select`.

---

## Port notes

Things the TypeScript daemon must get right, or may deliberately do differently:

1. **Two workspace resolvers with different semantics.** The strict resolver
   (UUID-wins → case-sensitive exact unique name → null) backs almost everything; the
   lenient static resolver (UUID → case-insensitive **first-match** name → slug) backs only
   `pane-move-to-workspace` and graft's `--workspace`. Port both as-is for CLI
   compatibility; consider unifying later behind a flag, but note the lenient one has **no
   ambiguity guard** — two workspaces named "Dev"/"dev" resolve to whichever comes first
   in state order.
2. **Error strings are contract.** The CLI prints them verbatim and scripts grep them
   (e.g. the delete flow keys off `active_agents`, doctor keys off ping fields). Copy them
   character-for-character, including the backticked repair hints and the smart em-dash
   free phrasing shown above.
3. **Reply-before-effect + pre-minted UUIDs.** `pane-split`/`pane-create` ack with a pane
   id that does not exist yet; the id is threaded into the creation path. The daemon must
   guarantee the created pane gets exactly the acked id (single-threaded state mutation
   makes this trivial in Node; do not introduce an await between mint and enqueue that
   could let another command interleave a conflicting layout change).
4. **`reply == null` legacy path.** Every handler must run its guards and perform the
   side effect on success even with no reply handle. Do not make the reply handle
   load-bearing for the mutation.
5. **Parked-pane asymmetry.** Agent lifecycle routing, `pane-sync`'s implicit scope, and
   graft's pane scope use the parked-inclusive lookup; every user pane command
   (`resolvePaneTarget`, list, capture, etc.) sees only visible panes. If the new
   architecture drops the parked-pane concept, the lifecycle handlers can share one
   lookup — but `pane list` must still never show a non-layout pane.
6. **`pane-sync` reply is a prediction.** The reply snapshot clears exclusions only when
   turning sync **off**, while the authoritative state change clears them on *every*
   activation transition and no-ops when unchanged. Divergence is visible only when
   exclusions were staged while sync was off and the caller then runs `sync on` — the
   reply would report them excluded though the final state cleared them. A port may fix
   this by computing the reply from post-mutation state (recommended), since the current
   behavior is arguably a bug, but be aware the Swift app ships the predictive version.
7. **NSApp.isActive / dock bounce.** The stop/notification suppression logic depends on
   "is the app frontmost" and "is this pane focused in the active workspace". In the
   daemon+web world, define `isAppActive` as "any connected client has window focus" (or
   per-client) and route the attention request (dock bounce) to the Electron shell;
   desktop notifications go through whichever client(s) can display them. Keep the
   background-task suppression rule exactly: count > 0 ⇒ pane stays `running`, no
   synthetic notification, no bounce.
8. **ISO 8601 formatting differs by handler.** `pane-list` uses the internet date-time
   option; `workspace-list` and graft use default ISO 8601 formatting. In practice both
   emit `YYYY-MM-DDThh:mm:ssZ`; in TS, `new Date().toISOString()` adds milliseconds —
   strip them (`.replace(/\.\d{3}Z$/, "Z")`) to match.
9. **Stable orderings in replies.** `synced_pane_ids` and the `excluded` array are sorted
   by UUID string; `pane-list` follows layout-tree leaf order; `workspace-list`/`group-list`
   follow sidebar order with a dedupe + never-hide append; `group-reorder`'s reply filters
   dangling ids while the stored order keeps them at the tail. Scripts diff these outputs;
   preserve the sorts.
10. **The split-path encoding** (`"d"` + `L`/`R` per level, first-child ratio storage,
    clamp [0.1, 0.9]) leaks into the `pane-resize` reply (`split_path`, `ratio`,
    `target_share`). The port's layout tree must expose the same addressing or translate
    at the reply boundary.
11. **Worktree create is the only handler that mutates git.** It is async, replies late,
    and must not create groups (ambiguous/unknown group is rejected up front, before the
    worktree add, precisely so a failure can't orphan a group). Error text mining from git
    stderr (last `fatal:`/`error:` line) is part of the UX.
12. **Preset back-fill on labels** dispatches one add-preset per introduced label with the
    gray default and relies on add-preset being a no-op for existing names. `add` marks
    *all* normalized values as introduced (even already-present ones) — harmless because
    of the no-op, but keep it or dedupe consciously.
13. **Persistence triggers.** Inline-mutating handlers (§5 list) must schedule a persist;
    dispatched-action handlers rely on the target action persisting. When porting to a
    single state store, the simplest faithful model is: any handler that changed state
    schedules the debounced persist.
14. **The `notification` command mutates status.** It is not just a toast: it routes
    through the agent-stopped state machine with the background count. Dropping that
    coupling would break the "awaiting input" status on Claude permission prompts.
15. **`pane-capture` is the only pane command with an async read**; handle the
    surface-died race with the exact `"pane closed during capture"` error. In the port,
    the terminal state lives in-process (ghostty-vt), so the race window shrinks but the
    pane can still close between resolution and read.
16. **Zoom interactions.** `pane-resize` refuses while zoomed (specific error), and
    `pane-move-to-workspace` un-zooms by restoring the saved layout minus the moved pane.
    Any port of zoom must preserve these two touch points.
17. **`workspace-delete --prune-worktree` is client-side.** The server's only contribution
    is the `path` field (first shell pane's cwd). Keep emitting it or the CLI flag
    silently stops working.

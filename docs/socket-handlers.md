# Socket command handlers — behavioral specification

Implementation: the pane handlers under `packages/daemon/src/handlers/pane/` (`create.ts`,
`lifecycle.ts`, `input.ts`, `geometry.ts`, `sync.ts`, `list.ts`, with the shared reply and
resolution helpers plus `tailLines` in `support.ts`), the app handlers under
`packages/daemon/src/handlers/app/` (`events.ts`, `workspaces.ts`, `groups.ts`, `files.ts`,
`layout.ts`, `graft.ts`, `ping.ts`, with `ok`/`fail` in `context.ts` and the reply orderings in
`common.ts`), the name-or-id resolvers in `packages/core/src/resolve/` (`workspace.ts`,
`pane-target.ts`, `ids.ts`), the git helpers in `packages/daemon/src/git/` (`service.ts`,
`names.ts` for `worktreeErrorMessage`), and the reply handle in
`packages/daemon/src/control/reply.ts` (seam declared in `packages/daemon/src/seams.ts`).

This document specifies how every wire command is **handled** once it has been parsed off the
socket. Wire framing/parsing (newline-delimited JSON, `"command"` key, the
`replyCommandAllowlist`) is specced in the socket-server doc; this doc picks up at the point
where the daemon holds a decoded message plus an optional reply handle.

Audience: anyone changing the daemon's command handlers or the `kelpi` CLI. The CLI, the hook
scripts and saved state depend on every reply key, error string, and resolution rule below, so
all of them are normative.

---

## 1. The reply handle contract

Every handler receives an optional **reply handle** (`reply`). It is non-null only for
commands in the reply allowlist; all other commands (and messages from pre-request/response
CLIs) get `null`.

```ts
interface ReplyHandle {                          // packages/daemon/src/seams.ts:14
  send(payload: object): void;   // writes ONE newline-terminated JSON line; no-op after close/disconnect
  close(): void;                 // ends the connection -> client sees EOF; idempotent
  readonly closed: boolean;      // true once closed or the peer disconnected
  onDisconnect(cb: () => void): void; // fires once when the client hangs up
}
```

The transport implementation is `createReplyHandle` in `packages/daemon/src/control/reply.ts:43`.
`onDisconnect` registers a callback the transport fires exactly once when the client
connection drops; registering on a handle that is already dead runs the callback
immediately. There is no `id`, `sendAndClose` or `error` member. Handlers do not call
`send`/`close` directly: the pane family uses `sendOK`/`sendError`
(`packages/daemon/src/handlers/pane/support.ts:46`) and the app family uses `ok`/`fail`
(`packages/daemon/src/handlers/app/context.ts:187`), each of which sends exactly one line and
then closes.

Rules:

- **Request/response mode** (every command except `web-console --follow`): call `send`
  exactly once, then `close`. One JSON line, then EOF.
- **Streaming mode**: call `send` repeatedly without `close`. The daemon holds the handle
  (e.g. in the web-console subscriber map) and writes newline-delimited JSON lines as events
  arrive. The stream ends when the *client* disconnects; the transport then fires the
  handle's `onDisconnect` callbacks so the daemon can release the held handle (see §11).
- **Legacy fire-and-forget** (`reply == null`): all guards and validations still run. On
  success the side effect is still performed; on failure the command is silently dropped
  (no error is deliverable). Old CLIs keep working against a new server this way.
- Success payloads always include `"ok": true`; failures are exactly
  `{"ok": false, "error": "<message>", ...optional extras}`. The CLI exits non-zero on
  `ok: false`.
- Dropping a handle on the floor is safe — the transport's EOF path closes orphaned FDs.

### Reply-before-effect ordering

Many handlers send the success reply **before** the side effect actually executes
(`pane-split`, `pane-create`, `pane-close`, `pane-send`, `pane-send-key`,
`pane-move-adjacent`, the non-worktree `workspace-create`, `workspace-delete`). The ack is
optimistic: new-entity UUIDs are minted up front and threaded into the effect so the acked
id is guaranteed to be the real one. Handlers whose reply describes the resulting state
(`pane-name`, `pane-resize`, `pane-sync`, `pane-sync-exclude`, `workspace-label`) apply the
change first and reply from post-mutation state (`handlers/pane/lifecycle.ts:56`,
`geometry.ts:87`, `sync.ts:87`). Async handlers (`pane-capture`, `graft-*`, worktree
`workspace-create`) reply only after the async work resolves.

---

## 2. Name-or-id resolution semantics

There are **two different workspace resolvers** in the codebase with different matching
rules. This asymmetry is load-bearing for CLI compatibility. Both live in
`packages/core/src/resolve/workspace.ts` (`resolveWorkspaceStrict`, `resolveGroupStrict`,
`resolveWorkspaceLenient`, `resolveGroupMember`); the pane resolvers are in
`packages/core/src/resolve/pane-target.ts`.

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

- `paneID`: the caller's own pane UUID, forwarded from `KELPI_PANE_ID` (may be absent).
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
      else if paneID != null:                                    // stale KELPI_PANE_ID
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
included) and silently drop the event when no workspace owns the pane. The handlers are in
`packages/daemon/src/handlers/app/events.ts`; the per-pane status machine they feed is
`packages/core/src/agent/machine.ts`.

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
isAppActive      = <is any attached client window visible?>   // deps.isAppActive, boot/compose.ts:1099
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
   the pane). The daemon broadcasts it as a `notification` event to the attached clients,
   which display it (`events.ts:77`).
4. If `shouldBounce`: request user attention by broadcasting an `attention-request` event
   to the attached clients (the Electron shell bounces the dock) (`events.ts:89`).

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

The wire message also carries an optional non-empty `profile` (the `KELPI_PROFILE` the hook
saw in the agent's own environment; `packages/protocol/src/wire/decode.ts:175`). The handler
forwards it (`events.ts:126`) and the pane records it as `agentProfileName`; an event without
one (an older CLI) keeps the last-known value (`packages/core/src/agent/machine.ts:139`). A
later resume spawn reads it back so the pane gets the environment the session actually ran
in (`handlers/pane/support.ts:151`).

### 3.6 `session-end` → sessionEnded(paneID, sessionID)

Forward to the workspace (clears the pane's tracked session id **only when it still equals
the ending `sessionID`**, issue #178) and then **persist state** — the cleared id must
survive the next launch or a restart would `--resume` a dead session. A matching end also
clears `agentProfileName` together with the id, so a later resume can never spawn under a
stale profile (`machine.ts:164`).

---

## 4. Pane command handlers

### 4.1 `pane-split` → handlePaneSplit

Inputs: `paneID?` (KELPI_PANE_ID), `direction?` (`horizontal`/`vertical`; default
horizontal), `path?` (`--path`), `name?` (`--name`, the label), `target?`, `workspaceFilter?`.
Implemented in `packages/daemon/src/handlers/pane/create.ts`.

Routing precedence (identical for `pane-create`):

```
if target == null and workspaceFilter != null:
  // --workspace alone selects the DESTINATION workspace outright,
  // beating the caller's forwarded KELPI_PANE_ID.
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
`newLabel = name == "" ? null : name`: an empty string **clears** the label. Note the wire
decoder rejects `pane-name` without a non-empty `name`
(`pane-name requires a non-empty name`, `packages/protocol/src/wire/decode.ts:219`;
wire-protocol.md §6), so over the socket a label can only be replaced, never cleared; the
clear branch is kept for in-process callers (`handlers/pane/lifecycle.ts:52`). Dispatches the
label change synchronously, replies:

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

Then write to the pane's PTY through the paste pipeline (`sendText` in
`packages/daemon/src/pty/input.ts:136`; terminal-surface.md §9.1). Both bare and non-bare
text go through `encodePasteText` (`pty/input.ts:97`): embedded `ESC[200~`/`ESC[201~`
markers are removed, `\r\n`/`\n` become `\r`, remaining C0 controls and DEL are dropped (TAB
and CR survive), and the result is wrapped in `ESC[200~ ... ESC[201~` only when the pane's
live VT has bracketed paste on. The text is therefore never written verbatim: a `--bare`
payload containing an escape sequence is silently filtered.
- `bare == true`: write the filtered text alone (no trailing Enter).
- `bare == false`: write the filtered text, then `\r` as a second, separate write outside the
  envelope, so the receiver runs it as a command (a TUI sees a real submit).

The write goes through `writeDirect`, so it is never mirrored to sync-group siblings.
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
   KELPI_PANE_ID).
3. Defensive pane lookup → `error("pane not found: {uuid}")`.
4. Pane type must be `shell` → `error("pane is not a terminal (type: markdown)")` (the
   actual type raw value: `markdown`/`scratchpad`/`diff`/`web`).
5. Flush a deferred first spawn: a pane whose first spawn is still waiting for a client's
   geometry has no server-side terminal yet, so the handler runs that spawn now
   (`ctx.spawn.flushSpawn(paneID)`, `handlers/pane/input.ts:95`) rather than answering with
   an empty screen. A no-op for every other pane.

Without a reply handle the command is a no-op (a pure read has nothing to drop;
`input.ts:74`). Then asynchronously read the pane's terminal contents (viewport, or viewport
+ full scrollback when `includeScrollback`). If the surface died mid-read →
`{ok:false,error:"pane closed during capture"}`; if the read throws while the pane still
exists (an emulator fault) → `{ok:false,error:"pane capture failed: <error>"}`
(`input.ts:136`). Either way the client gets a line rather than waiting for an EOF that
never comes. Apply `tailLines` when `lines` given:

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
(pane to dock against), `zone` (`above|below|left-of|right-of`, the wire vocabulary of
wire-protocol.md §5.4; the CLI sends exactly those names and the decoder rejects anything
else with `pane-move-adjacent requires zone above|below|left-of|right-of`,
`packages/protocol/src/wire/decode.ts:259`), `workspaceFilter?`. Implemented in
`packages/daemon/src/handlers/pane/geometry.ts`.

1. Resolve the moved pane via `resolvePaneTarget`.
2. Resolve the anchor via `resolvePaneInWorkspace(movedPane's workspace, anchor)` — the
   anchor **must** live in the same workspace (the layout move operates on one tree).
   Failure → `error("no pane matching '{anchor}' in workspace '{ws.name}'")` (covers
   missing, other-workspace, and ambiguous-label anchors alike).
3. `anchorID == movedID` → `error("cannot move a pane adjacent to itself")`.
4. The reply echoes `zone` exactly as received; the handler converts it to the layout's
   internal edge only for the move itself (`dropZoneForWireEdge`, `geometry.ts:173`).
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
  broadcast reveal-pane { workspaceID: targetWSID, paneID }   // the port's active workspace is
                                                              // per client, so "the app switches"
                                                              // is this untargeted fan-out, exactly
                                                              // as workspace-create (§6.2); #52
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
3. else → `error("pane sync requires --workspace or KELPI_PANE_ID")` (`handlers/pane/sync.ts:28`).

`action` lowercased: `on` → nextActive true; `off` → false; `toggle` → `!current`;
`status` → reply the current snapshot and stop (read-only, no mutation); anything else →
`error("unknown sync action '{action}' (valid: on, off, toggle, status)")`.

For the mutating verbs the handler dispatches the activation change first
(`set-sync-input-active`, `handlers/pane/sync.ts:87`) and replies with the snapshot of the
resulting state, read back from the store (`replyWithCurrentSync`, `sync.ts:117`). The
reducer clears the excluded set on **every** activation change and no-ops when the value is
unchanged (`store/reducers/agent.ts:115`): so a `sync on` while already on keeps
exclusions, and exclusions staged while sync was off are wiped on the next transition. The
reply therefore always equals final state; the predictive reply of the pre-port app, which
could disagree in the staged-while-off corner case, is deliberately not reproduced (see
Compatibility rationale, item 6).

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
Resolve via `resolvePaneTarget` (same scoping as `pane send`). Dispatch the exclusion
change (`set-sync-input-excluded`, `sync.ts:108`; the reducer no-ops when the pane id isn't
in that workspace's visible panes or when the flag is unchanged), then reply with the
sync-status shape above computed from the updated workspace, and refresh the broadcast
group.

---

## 5. Cross-cutting pane/workspace bookkeeping

- **refreshSyncGroup**: every state change that alters a workspace's pane set, sync flag,
  or exclusion set must push the freshly computed `syncedPaneIDs` snapshot for that
  workspace into the keystroke-broadcast layer. Handlers that dispatch workspace actions
  get this for free (the workspace reducer does it); `pane-move-to-workspace` mutates
  state directly and therefore pushes snapshots for **both** source and target workspaces
  explicitly.
- **persistState**: state persistence is debounced (500 ms full-state serialize) and is
  triggered by the store itself: boot subscribes the persistence layer to every store
  change (`packages/daemon/src/boot/compose.ts:883`), so every dispatched action schedules a
  save and no handler needs an explicit persist (the pane handlers never call one; the app
  handlers' `deps.persist()` calls are redundant with the subscription). The one exception
  is `session-end`, which forces an immediate flush via `persistNow`
  (`handlers/app/events.ts:60`) so a cleared session id survives a crash before the next
  launch (issue #178).
- **sidebarScrollTarget**: the Swift recorded a workspace or group created over the socket
  as the sidebar scroll target so the GUI scrolled the new row into view (issue #187). The
  daemon has no sidebar, so the port reaches clients two different ways (issue #57 sh-13):
  - `workspace-create` broadcasts `reveal-pane` to EVERY attached client
    (`handlers/app/workspaces.ts:207`), and each client's reveal handler activates the
    workspace and queues the scroll (`packages/client/src/App.tsx:450`). A create has an
    obvious destination and later commands land there, so every window follows.
  - `group-create` scrolls only the client that issued the request, off the reply's
    `group_id` (`packages/client/src/App.tsx:1225`). A new group is an empty header that
    activates nothing, so other windows are left where they are. The `deps.scrollTarget`
    call in `handlers/app/groups.ts:89` is the Swift seam kept for an in-process consumer;
    boot wires none (`handlers/app/context.ts:173` defaults it to a no-op), so over the
    socket it is inert by design.

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
   `Repo{ id: uuid(), path, name: lastPathComponent }` (registered on success). On success
   an already-registered source repo is marked manually kept (`isAutoDiscovered = false`)
   so the registry GC can never collect the parent of a worktree the user built on purpose;
   a new repo is registered the same way (`handlers/app/workspaces.ts:300`, §GIT-103).
5. `worktreePath = resolvedWorktreeBasePath(repoPath) + "/" + folderName`. The base path
   setting expands `~` and a `<repo>` placeholder (`<repo>` at the start ⇒ the full repo
   path; elsewhere ⇒ the repo's directory name).
6. Pre-mint the workspace id. Then **asynchronously** (`worktreeAdd` in
   `packages/daemon/src/git/service.ts:326`):
   - `updateMain == false`: first try `git worktree add <worktreePath> <safeBranch>`, which
     attaches the worktree to an already-existing local branch of that name; only if that
     fails, `git worktree add -b <safeBranch> <worktreePath>` off current HEAD
     (`service.ts:312`). It is this second command's stderr that feeds
     `worktreeErrorMessage`. Net effect: a pre-existing branch named like the worktree is
     reused rather than failing with "a branch named ... already exists".
   - `updateMain == true`: resolve the repo's default branch (via
     `git ls-remote --symref`), `git fetch origin`, then
     `git worktree add -b <safeBranch> <worktreePath> origin/<default>`.
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
pane, spawns its surface, activates it, persists). After every successful branch of this
command the handler also broadcasts `{type: "reveal-pane", workspaceID, paneID}` to the
attached clients (`revealCreatedWorkspace`, `handlers/app/workspaces.ts:207`): the active
workspace is per client, and the reducer's `lastActiveWorkspaceID` moves only what
`workspace list` calls active, so without the reveal a create issued from a terminal would
leave every open window on the old workspace. Clients treat it as "activate the workspace,
then focus the pane"; the issuing client reveals itself from the reply as well, and arriving
twice is idempotent.

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
   explicit persist here (it would race). Placing the workspace into the group also
   force-expands the target group (`isCollapsed: false`,
   `store/reducers/workspaces.ts:139`), so the new row is visible in the sidebar. The
   `reveal-pane` broadcast described under (b) fires here too.

### 6.3 `workspace-move` → handleSocketWorkspaceMove (fire-and-forget)

Inputs: `nameOrID`, `group?`, `index?`. Strict `resolveWorkspace`; null ⇒ silent no-op.
`group == null` (or an empty string, `handlers/app/workspaces.ts:522`) targets the top
level; non-null must resolve via `resolveGroup` (creation deliberately unsupported here, 
that's `workspace-create --group`), null ⇒ silent no-op. Dispatch
move-workspace-to-group(workspaceID, groupID-or-null, index, expandOnDrop).

`expandOnDrop` carries the `expand-group-on-workspace-drop` setting (SET-012, default on;
read live through `deps.expandGroupOnDrop`, `handlers/app/context.ts:70`). With the setting
off, moving a workspace into a collapsed group leaves the group collapsed around the row it
just swallowed (`workspaces.ts:528`). The sidebar's drag-and-drop is this same verb, so the
setting is applied at the verb rather than at the gesture and governs the CLI form as well.

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

The last-workspace guard has one caller allowed past it: the handler takes an `allowLast`
flag and the guard is `state.workspaces.length <= 1 && !allowLast`
(`handlers/app/workspaces.ts:475`). `allow_last` is deliberately **not** a wire field: the
decoder never reads it (`packages/protocol/src/wire/decode.ts:325`), so nothing arriving over
the control socket can set it and `kelpi workspace delete` still refuses. The GUI's own
`delete-workspace` verb sets it when ⌘W closes the last pane of the last workspace, so that
path runs through this handler and can reach zero workspaces (§WS-156 / §APP-067).

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
workspace, drop. Afterwards refresh the workspace's sync group (`--here` parks a shell,
which changes the broadcast group) (`handlers/app/files.ts:90`).

A relative `path` is resolved before the open (`resolveAgainstPane`, `files.ts:54`,
§CONT-130/131): it is joined onto the originating pane's working directory, else onto the
target workspace's focused pane's; absolute and `~`-prefixed paths are left exactly as they
came. The `kelpi` CLI absolutises before it sends, so this chain only affects raw socket
clients and the shell's `open-file` forward, which would otherwise resolve against the
daemon's own cwd.

### 8.2 `diff` → openDiff(repoPath, targetPath?, paneID?)

Same routing shape: with a known `paneID`, focus it and open the diff pane in its
workspace; else the active workspace. `repoPath` is the repo to diff, `targetPath` the
optional path scope. Never reuses a pane. Both `repo_path` and `target_path` go through the
same relative-path resolution as `open` (`files.ts:100`), and the sync group is refreshed
afterwards (`files.ts:120`).

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
Handlers: `packages/daemon/src/handlers/app/graft.ts`.

Every `ok:false` reply from the three verbs also carries a machine-readable `error_kind`
(scope failures use `"scope"`, engine failures `graftErrorKind(err)`), and a partial start
adds `partial_error_kind` (`graft.ts:8`). These fields are additive: the CLI ignores them,
so future clients can branch on them without parsing prose.

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
  failure("graft requires --workspace, --repo, or KELPI_PANE_ID")   // graft.ts:41

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
- all failed → `{"ok": false, "error": "<last error's description>", "error_kind": …}`
  (fallback `"graft start failed"` if no error text) (`graft.ts:144`);
- partial → `{"ok": true, "started": [...], "partial_error": "<last error>", "partial_error_kind": …}`;
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
  stop each; collect successes (uuid strings) and failures {"association_id", "error", "error_kind"}
  reply {"ok": <failures empty>, "stopped": [...], "failed": [...]?}   // "failed" only when non-empty
```

A partial or full stop failure additionally carries a top-level summary `error` (the single
failure's text, or `"N graft sessions failed to stop: <errors joined by '; '>"`) plus
`error_kind` from the first failure (`graft.ts:247`). The shipped CLI runs its generic
envelope check first and would otherwise print "unknown error" without ever rendering the
`failed` list; `failed` stays for clients that do render it.

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

`version`/`build` from the daemon's version metadata (`"unknown"` fallback); `pid` is the
server process id (used by `kelpi doctor` to triage stale socket files and CLI/app drift).

The reply carries further additive blocks (`packages/daemon/src/handlers/app/ping.ts:33`),
read by `kelpid status` and `kelpi doctor`:

- `protocol`: the wire protocol version.
- `tcp {requested, host, bound?, error?}`: present when a TCP listener was configured; a
  daemon whose `tcp-port` never bound still answers on the Unix socket, and this block is
  where that stops being invisible (§SET-021 / §AGNT-005).
- `compat {path, error}`: present when the shared compatibility socket could not be bound
  (for example because another Kelpi owns it).
- `pane_route`: the `KELPI_SOCKET` value injected into panes.
- `persistence {ok, degraded, path, failed_saves, last_save_at, error?, errno?, phase?}`:
  the persistence layer's health.

---

## 11. `socketSubscriberDisconnected(replyID)`

There is no synthetic message and nothing is dispatched. Disconnect is a callback on the
reply handle: `onDisconnect(cb)` registers a callback, and when the peer vanishes the
transport calls the handle's `peerGone()`, which fires every registered callback exactly
once (`packages/daemon/src/control/reply.ts:48`, `:92`); registering on a handle that is
already dead runs the callback immediately. A streaming handler (today only
`web-console --follow`) sends the drain as line 1, keeps the handle open, and does
`reply.onDisconnect(unsubscribe)` so its console subscriber slot is released when the
client hangs up; when the pane closes the service's `end` callback closes the handle
instead (`packages/daemon/src/webpane/handlers.ts:470`). Ordinary request/response
handlers register nothing and pay nothing.

---

## 12. Web-pane verbs (delegated)

The following commands flow through this same dispatch point but are handled by the
web-pane subsystem (see its spec): `web-open`, `web-navigate`, `web-url`, `web-back`,
`web-forward`, `web-reload`, `web-capture`, `web-tabs`, `web-tab-new`, `web-tab-close`,
`web-tab-select`, `web-console` (the only streaming command), `web-inspect`,
`web-inspect-result`, `web-private`, `web-cookies-list`, `web-cookies-clear`,
`web-cookies-delete`, `web-click`, `web-type`, `web-q-text`, `web-q-attr`, `web-q-count`,
`web-q-exists`, `web-q-dom`, `web-wait`, `web-select`, `web-scroll`, `web-hover`, `web-key`,
`web-exec` (handler table in `packages/daemon/src/webpane/handlers.ts`). All of them (except
`web-open`, which takes only `paneID`/`url`/`isPrivate`) scope their target via the tuple
`{paneID?, target?, workspaceFilter?}` with resolution semantics analogous to
`resolvePaneTarget` but restricted to web panes.

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
| graft-start | `started: [...]`, `partial_error?`, `partial_error_kind?` (failures add `error_kind`) |
| graft-stop | `stopped: [...]`, `failed?: [...]` (`ok` false only when a stop failed; then also `error`, `error_kind`) |
| graft-status | `sessions: [...]` |
| ping | `version`, `build`, `pid`, `protocol`, `tcp?`, `compat?`, `pane_route?`, `persistence?` |

Fire-and-forget (no reply ever): agent lifecycle events, `pane-move` (directional),
`pane-move-to-workspace`, `workspace-move`, `workspace-profile`, `group-create`,
`group-rename`, `group-delete`, `open`, `diff`, `layout-cycle`, `layout-select`.

---

## Compatibility rationale

These items record quirks that Kelpi preserves on purpose so the pre-port `kelpi` CLI, the
hook scripts and saved state keep working; each explains why the code does something odd.

1. **Two workspace resolvers with different semantics.** The strict resolver
   (UUID-wins → case-sensitive exact unique name → null) backs almost everything; the
   lenient resolver (UUID → case-insensitive **first-match** name → slug) backs only
   `pane-move-to-workspace` and graft's `--workspace`. Both are kept as-is for CLI
   compatibility (`packages/core/src/resolve/workspace.ts`); they could be unified later
   behind a flag, but note the lenient one has **no ambiguity guard**, two workspaces named
   "Dev"/"dev" resolve to whichever comes first in state order.
2. **Error strings are contract.** The CLI prints them verbatim and scripts grep them
   (e.g. the delete flow keys off `active_agents`, doctor keys off ping fields). The daemon
   emits them character-for-character, including the backticked repair hints and the em-dash
   free phrasing shown above.
3. **Reply-before-effect + pre-minted UUIDs.** `pane-split`/`pane-create` ack with a pane
   id that does not exist yet; the id is threaded into the creation path. The daemon
   guarantees the created pane gets exactly the acked id (single-threaded state mutation
   makes this trivial in Node; there is no await between mint and dispatch that could let
   another command interleave a conflicting layout change).
4. **`reply == null` legacy path.** Every handler runs its guards and performs the side
   effect on success even with no reply handle. The reply handle is never load-bearing for
   the mutation (`sendOK`/`ok` are no-ops on a null handle).
5. **Parked-pane asymmetry.** Agent lifecycle routing, `pane-sync`'s implicit scope, and
   graft's pane scope use the parked-inclusive lookup (`workspaceContainingPane`); every user
   pane command (`resolvePaneTarget`, list, capture, etc.) sees only visible panes
   (`workspaceContainingVisiblePane`). `pane list` never shows a non-layout pane.
6. **`pane-sync` reply is computed from post-mutation state.** The pre-port app replied with
   a prediction that cleared exclusions only when turning sync **off**, while the
   authoritative state change clears them on *every* activation transition and no-ops when
   unchanged; the two diverged when exclusions were staged while sync was off and the caller
   then ran `sync on` (the reply reported them excluded though the final state cleared
   them). Kelpi dispatches first and reads the workspace back (`handlers/pane/sync.ts:117`),
   so the reply always matches final state. The reducer's clear-on-every-transition and
   no-op-when-unchanged rules are unchanged.
7. **App-active / dock bounce.** The stop/notification suppression logic depends on "is the
   app frontmost" and "is this pane focused in the active workspace". In the daemon+client
   world `isAppActive` is "any attached client window is visible" (`boot/compose.ts:1099`),
   `isFocused` comes from the client-aware `deps.isPaneFocused` when one is wired (else the
   daemon's last-active workspace + focused pane), the attention request is broadcast to the
   attached clients and the Electron shell bounces the dock, and desktop notifications are
   broadcast to whichever client(s) can display them. The background-task suppression rule
   is kept exactly: count > 0 ⇒ pane stays `running`, no synthetic notification, no bounce.
8. **ISO 8601 formatting is uniform.** `pane-list`, `workspace-list` and graft all emit
   `YYYY-MM-DDThh:mm:ssZ` at seconds precision; `wireTimestamp` in
   `handlers/app/common.ts` strips the milliseconds `toISOString()` would add so the output
   matches what scripts already parse.
9. **Stable orderings in replies.** `synced_pane_ids` and the `excluded` array are sorted
   by UUID string; `pane-list` follows layout-tree leaf order; `workspace-list`/`group-list`
   follow sidebar order with a dedupe + never-hide append; `group-reorder`'s reply filters
   dangling ids while the stored order keeps them at the tail. Scripts diff these outputs,
   so the sorts are preserved.
10. **The split-path encoding** (`"d"` + `L`/`R` per level, first-child ratio storage,
    clamp [0.1, 0.9]) leaks into the `pane-resize` reply (`split_path`, `ratio`,
    `target_share`). The layout tree exposes the same addressing
    (`handlers/pane/geometry.ts`, pane-layout.md §12.5).
11. **Worktree create is the only handler that mutates git.** It is async, replies late,
    and never creates groups (ambiguous/unknown group is rejected up front, before the
    worktree add, precisely so a failure can't orphan a group). Error text mining from git
    stderr (last `fatal:`/`error:` line, `git/names.ts:85`) is part of the UX.
12. **Preset back-fill on labels** dispatches one add-preset per introduced label with the
    gray default and relies on add-preset being a no-op for existing names. `add` marks
    *all* normalized values as introduced (even already-present ones) — harmless because
    of the no-op, and kept as-is.
13. **Persistence triggers.** With a single state store the model is the simplest faithful
    one: any dispatched action schedules the debounced persist, because boot subscribes the
    persistence layer to the store (`boot/compose.ts:883`). The explicit `deps.persist()`
    calls in the app handlers are redundant with that subscription; `session-end` alone
    forces an immediate flush.
14. **The `notification` command mutates status.** It is not just a toast: it routes
    through the agent-stopped state machine with the background count. Dropping that
    coupling would break the "awaiting input" status on Claude permission prompts.
15. **`pane-capture` is the only pane command with an async read**; the surface-died race
    answers with the exact `"pane closed during capture"` error. The terminal state lives
    in-process (ghostty-vt), so the race window is small, but the pane can still close
    between resolution and read, and a read that throws while the pane still exists gets
    the distinct `"pane capture failed: …"` line instead.
16. **Zoom interactions.** `pane-resize` refuses while zoomed (specific error), and
    `pane-move-to-workspace` un-zooms by restoring the saved layout minus the moved pane.
    Both touch points are preserved.
17. **`workspace-delete --prune-worktree` is client-side.** The server's only contribution
    is the `path` field (first shell pane's cwd). It keeps emitting it; otherwise the CLI
    flag would silently stop working.

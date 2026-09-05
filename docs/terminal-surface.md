# Terminal Surface Subsystem — Behavioral Specification

Source of truth for this spec (Swift, current macOS app):

- `Nex/Ghostty/GhosttyApp.swift` — libghostty runtime singleton, action/callback dispatch
- `Nex/Ghostty/GhosttyConfig.swift`, `GhosttyConfigClient.swift`, `NexGhosttyDefaults.swift` — config load/read
- `Nex/Ghostty/GhosttySurface.swift` — per-surface C-API handle (input, capture, named keys)
- `Nex/Ghostty/SurfaceView.swift` — NSView host: keyboard/mouse/IME, resize, focus, drag-drop
- `Nex/Ghostty/ClipboardImageHelper.swift` — image-paste-to-temp-file
- `Nex/Services/SurfaceManager.swift` — registry of all surfaces, sync-input broadcast, send/capture API
- `Nex/Features/PaneGrid/SurfaceContainerView.swift` — SwiftUI↔NSView bridge, lazy-create, focus grab

This document describes WHAT the terminal layer does so it can be re-implemented in the new
architecture: a headless TypeScript daemon owning PTYs + terminal state (node-pty + ghostty-vt WASM),
a web client rendering with ghostty-web, and thin Electron/remote shells. Each section ends with a
**Port target** note saying where the capability lands in the new architecture
(`daemon/PTY`, `daemon/vt`, `client`, or split).

---

## 1. Concepts and ownership model

In the current app there is exactly one **surface** per terminal pane. A surface bundles:

1. A PTY with a spawned child process (login shell by default, or an explicit command).
2. Terminal emulator state (grid, scrollback, modes like DECCKM/bracketed-paste, selection).
3. A renderer (Metal layer) presenting that state.
4. An input translator (macOS key events → terminal byte sequences / control functions).

All four live inside libghostty today. In the port they split:

| Responsibility | Current owner | New owner |
|---|---|---|
| PTY spawn/kill, env, cwd, command, SIGWINCH | libghostty (in-process) | **daemon** (node-pty) |
| Terminal emulation state (grid, scrollback, modes, title/pwd OSC parsing) | libghostty | **daemon** (ghostty-vt WASM) — must be server-side so capture, sync-input, and multiple attached clients all see one truth |
| Rendering | libghostty Metal layer | **client** (ghostty-web) |
| Key-event → bytes translation | libghostty (`ghostty_surface_key`) | split: client translates for interactive typing; **daemon must also translate** for `pane send-key` / sync-input so those work with zero clients attached |
| Focus / occlusion / scale | NSView + libghostty | client (render concerns only); daemon keeps a "focused pane" notion for notification suppression |

### 1.1 Key identity: `paneID`

Every surface is keyed by the pane UUID (`paneID`). All cross-layer routing —
socket commands, sync groups, notifications, capture — resolves through this key.
libghostty callbacks that only carry a raw C surface pointer are resolved back to a
`paneID` by reverse lookup in the surface registry (`SurfaceManager.paneID(for:)`);
in the port every event should natively carry the `paneID`.

### 1.2 Registry semantics (`SurfaceManager`)

A single process-wide registry `Map<paneID, Surface>` with these behavioral guarantees:

- **Duplicate-create guard**: `createSurface(paneID, ...)` is a no-op if a surface for that
  paneID already exists. Two racing creators exist today (the reducer effect and the lazy
  view-mount fallback); *first caller wins* and the second must not replace the live PTY.
  The daemon must keep this idempotency: `createSurface` for an existing pane returns the
  existing surface untouched.
- **Persistence across workspace switches**: switching workspaces detaches the surface from
  the visible view hierarchy but never destroys it. The PTY keeps running and the emulator
  keeps consuming output. In the daemon this is automatic (PTY + vt state live server-side,
  regardless of what any client shows) — but the client must not tear down / re-spawn on
  workspace switch either; it re-attaches to the existing server-side surface.
- **Destroy is explicit**: only `destroySurface(paneID)` (pane closed, shell exited, workspace
  deleted, external editor finished) frees the surface. `destroyAll()` on app teardown.
- Registry also holds per-workspace **sync groups** (section 8).

### 1.3 Surface lifecycle state machine

```
                createSurface(paneID, cwd, opts)
    (none) ─────────────────────────────────────────▶ ALIVE
                                                        │
       child process exits (shell `exit`, editor quits) │──▶ emits "process exited" event
                                                        │    app decides: close pane /
                                                        │    flip markdown pane out of
                                                        │    external-editor mode / evict
                                                        │    parked pane  → destroySurface
                                                        │
                destroySurface(paneID)                  ▼
    ALIVE ─────────────────────────────────────────▶ (freed: PTY killed, state dropped)
```

Events that trigger `destroySurface` in the current app (all initiated by app logic, not by
the surface itself):

- `closePane` (user ⌘W, CLI `pane close`, process-exit auto-close)
- workspace deleted (all its panes' surfaces)
- markdown external editor exits (`paneProcessTerminated` on a markdown pane using `$EDITOR`
  in a surface → destroy that surface, keep the pane, flip back to preview mode)
- a *parked* pane's process dies → evict from parked lane + destroy
- app quit (`destroyAll`)

**Teardown hazard (informational, macOS-specific)**: `ghostty_surface_free` joins the PTY IO
thread; a child that traps/ignores SIGHUP makes the free hang for tens of seconds, so the
current app frees surfaces on a background serial queue (issue #136). Port implication: when
killing a PTY in node-pty, do `SIGHUP` → wait briefly → escalate to `SIGKILL`. Don't block
the daemon event loop waiting for a stubborn child; don't let one stuck teardown serialize
behind it every later teardown (the current app accepts this flaw — the port should not).

**Port target**: daemon owns the registry and lifecycle. `createSurface`/`destroySurface`
become daemon operations; process-exit is a node-pty `onExit` event.

---

## 2. PTY spawn configuration

`createSurface` today takes:

```ts
interface CreateSurfaceOptions {
  paneID: string;            // UUID; key for everything
  workingDirectory: string;  // absolute path; default when pane model created it: os.homedir()
  backgroundOpacity?: number; // default 1.0 — RENDER concern only (layer opacity), not PTY
  command?: string;          // optional; when set, run this instead of the login shell.
                             // Today only used for markdown external-editor panes
                             // (e.g. `vim '/path/to/file.md'` built by EditorService).
  env?: Record<string, string>; // resolved workspace-profile vars (already includes NEX_PROFILE)
}
```

### 2.1 Environment injection

The spawned PTY environment = inherited process env, overlaid with an **ordered** list built
as follows (`SurfaceView.mergedEnvVars`, pure function, unit-tested today):

```
1. NEX_PANE_ID = <paneID UUID string>            (uppercase-hyphen UUID, e.g. "8F14E45F-...")
2. PATH       = <helpersDir> + ":" + <inherited PATH or "/usr/local/bin:/usr/bin:/bin">
3. ...profile vars, sorted by key ascending, EXCLUDING reserved keys
```

- **Reserved keys**: `NEX_PANE_ID`, `PATH`. Profile entries with these names are silently
  dropped — built-ins always win.
- `helpersDir` is the directory containing the bundled `kelpi` CLI (today
  `<bundle>/Contents/Helpers`; in the port, wherever the daemon ships its CLI). Its purpose:
  the `kelpi` binary must be found on PATH inside every pane, ahead of anything else (on macOS it
  also disambiguates from the `Kelpi` app binary on case-insensitive filesystems).
- The profile env dict arrives with `NEX_PROFILE=<profileName>` already merged in by the
  profile resolver (`WorkspaceProfilesClient.resolveEnv`): resolver reads
  `~/.config/nex/config` fresh on every call (no caching, no watcher), takes the named
  profile's vars (empty for the virtual `default` profile unless the user defined vars),
  and sets `NEX_PROFILE=<name>` **last** so a config line spoofing `NEX_PROFILE` loses.
  Unassigned workspaces resolve profile name `"default"` — so **every** pane ends up with
  `NEX_PROFILE` set.
- Injection is **spawn-time only**. Live PTYs keep their birth env; changing a workspace's
  profile affects only later spawns.

Every spawn path must inject this env identically (this was a real bug class: the lazy
view-mount fallback races the reducer effect, and both must inject or profiles get flaky):

1. workspace create → first pane
2. split / `pane create` (GUI or CLI)
3. app-restart restore of persisted shell panes (per-workspace profile, resolved once per
   profile name and cached for the batch)
4. markdown ⌘E external-editor surface (with `command`)
5. reopen-closed-pane (restores a shell pane; then, if an agent session id was captured,
   types the resume command — see 2.3)
6. lazy view-mount fallback (client asks daemon "ensure surface exists for pane X")

### 2.2 Working directory and command

- `workingDirectory` is passed straight to the PTY spawn (libghostty `working_directory`).
  Defaults: new pane model defaults to the user's home directory; splits inherit the source
  pane's current `workingDirectory` (which tracks live pwd via OSC — section 7.2);
  `pane create --path` / `pane split --path` override.
- `command == undefined` → spawn the user's login shell (libghostty reads it from passwd /
  `$SHELL` per its config). `command` set → run that command line instead;
  when the command exits the surface reports child-exit (section 7.3) rather than lingering.
  (libghostty force-sets `wait-after-command=true` for command surfaces; the app compensates
  by treating the `SHOW_CHILD_EXITED` action as the close signal. In the port just treat
  node-pty `onExit` as the signal uniformly.)
- `font_size = 0` (use config default), scale factor from the screen — render concerns.

### 2.3 Post-spawn typed commands (restore/resume)

After restoring surfaces on app relaunch (and on reopen-closed-pane), the app *types* an
agent resume command into the pane rather than spawning with it:

```
sleep 2 seconds   // let the shell finish printing its prompt
sendCommand(paneID, "claude --resume <sessionID>")     // or "codex resume <sessionID>"
```

- `sendCommand` = write text + press Enter (section 9.1).
- The session id passes a shell-safety allowlist first (`isSafeSessionID`): non-empty,
  ≤128 chars, ASCII alphanumerics plus `.`, `_`, `-` only. Fails → the resume is skipped
  entirely (never typed).
- The 2-second delay is a heuristic; the port may keep it or wait for first prompt output.

**Port target**: daemon (node-pty `spawn(shellOrCommand, { cwd, env })`). The env-merge
function should be ported as a pure, tested function with identical ordering and reserved-key
filtering.

---

## 3. Ghostty configuration

### 3.1 Config sources and precedence (low → high)

1. libghostty compiled-in defaults
2. **Kelpi-managed defaults** (`KelpiGhosttyDefaults.source`, written to a temp file and loaded
   before user files so the user can override):

   ```
   search-background = #F2D027
   search-foreground = #000000
   search-selected-background = #FF7A00
   search-selected-foreground = #000000
   ```

   (High-contrast in-terminal search match colors, aligned with the markdown find overlay.)
3. User's ghostty config: default files (`~/.config/ghostty/config` / XDG / app-support) plus
   recursive includes — i.e. the user's existing Ghostty setup (font, theme, colors,
   keybinds, shell-integration, etc.) applies to Kelpi terminals wholesale.
4. Optional **override file** (appearance settings): when the user changes background
   color/theme/opacity in Kelpi Settings, the app writes a tiny override file and rebuilds the
   whole config with it loaded last:

   ```
   theme = <themeName>            # when a named theme is chosen
   background-opacity = <0..1>
   ```
   or
   ```
   background = #rrggbb           # when an explicit color is chosen
   background-opacity = <0..1>
   ```

   then hot-applies it to the running terminal app (`ghostty_app_update_config`) so **live
   surfaces re-theme without respawn**.

### 3.2 Config keys Kelpi itself reads

Kelpi reads exactly two resolved values out of the finalized ghostty config, exposing them as
`GhosttyConfigClient { backgroundOpacity: number /*default 1.0*/, backgroundColor: RGB /*default: system window background*/ }`:

- `background-opacity` (double)
- `background` (RGB color) — note this is the *resolved* value, i.e. after any `theme` is
  applied, so reading it back after a theme change yields the theme's background.

These drive: pane container fill, markdown/scratchpad/diff pane backgrounds (so non-terminal
panes match the terminal), window transparency compositing, and layer opacity
(`opacity >= 1.0` → opaque layers). On appearance change the app updates all of these live and
broadcasts a "config changed" event so non-terminal panes re-render.

Saved appearance settings (opacity, custom RGB) are persisted app-side (UserDefaults today)
and re-applied over the loaded config at startup **before** any surface is created.

**Port target**: split. The daemon should parse the user's ghostty config (or a Kelpi config)
to serve font/theme/colors to ghostty-web clients; the two-key read-back
(background + opacity) becomes part of a "resolved appearance" object served to all clients
so terminal and non-terminal panes agree. Live re-theme = daemon pushes a config-changed
event; clients re-style without touching PTYs.

---

## 4. Rendering & visibility management (client-side concerns)

The current app's Metal/NSView plumbing translates to these behavioral requirements for the
web client:

- **Draw on output**: when the emulator processes new PTY output, the visible view must
  repaint. (Current bug class fixed by issue #194: a surface created while hidden/occluded
  got zero draws and stayed blank. The port's client should subscribe to server-side state
  updates and paint whenever they arrive, plus force a full re-sync on tab visibilitychange /
  window focus — the equivalent of `resyncVisibleSurfaces()` on app activation.)
- **Zero-size guard**: never propagate a zero-size layout to the renderer or the PTY;
  transient zero bounds occur during re-parenting/layout. Skip, and sync when real bounds
  arrive (the "initial-size rescue": first non-zero layout pass forces a size-sync + draw).
- **Reattach re-sync**: when a pane's view re-enters the visible hierarchy (workspace switch
  back, split collapse), re-assert its pixel size and request a repaint after layout settles.
- **Occlusion**: libghostty is told focus and occlusion per surface
  (`setFocus(bool)` / `setOcclusion(bool)`); occlusion lets it skip rendering work. Web
  equivalent: pause render loops for hidden panes; keep the daemon consuming PTY output
  regardless.
- **Opacity**: layer opacity flips with `backgroundOpacity >= 1.0`; sub-1.0 opacity makes the
  window composite translucently. Web equivalent: CSS alpha on the terminal background.

**Port target**: client (ghostty-web). None of this touches the daemon except that the daemon
must keep consuming PTY output for invisible surfaces (backpressure: never pause the PTY
because no client is watching).

---

## 5. Resize handling

- The surface is told its size in **pixels** (`width = cssWidth * scale`,
  `height = cssHeight * scale`); libghostty derives cols×rows from cell metrics and delivers
  SIGWINCH to the PTY.
- **Debounce**: interactive resizes (split drag, maximize, window resize) fire many
  intermediate sizes. The current app debounces 100 ms and sends only the final size, so the
  shell gets a single SIGWINCH instead of a redraw storm. Port: same debounce, applied
  where the resize originates (client sends final size; daemon applies
  `pty.resize(cols, rows)` + updates vt dimensions).
- **Scale changes** (monitor DPI change) re-send content scale; web equivalent:
  `devicePixelRatio` changes re-derive the pixel size.
- **Grid/cell queries**: the app exposes
  - `gridSize(paneID) → {columns, rows} | null` (null if either is 0), and
  - `cellSize(paneID) → {width, height}` in CSS points (pixel cell size ÷ scale)

  used by the resize overlay: while dragging a divider over a terminal pane it shows
  `"<cols> x <rows>"` (computed as `floor(paneFrame.width / cellWidth)` etc.); over
  non-terminal panes it falls back to pixel dimensions `"<w> x <h>"`. The `pane resize`
  CLI reply and any HUD need these numbers server-side, so the daemon's vt layer should
  own cols/rows and cell metrics should be reported by the rendering client (or derived
  from the agreed font metrics).

**Port target**: split. Client measures and debounces; daemon applies to node-pty and vt
state; daemon answers grid-size queries.

### 5.1 Size control: one owner per daemon

With several UIs attached (a desktop window plus a remote/tailnet browser), each measures
its own window and they disagree — and a PTY has exactly one size. PTY geometry therefore
follows exactly **one client at a time**, the *size owner*:

- **Implicit claim**: a connection's FIRST `attach-pane` claims ownership — a freshly
  opened UI sizes the panes, which is the last-connected-wins behaviour that always held.
  Later attaches (workspace switches remounting panes) do NOT move ownership.
- **Explicit take-back**: the `take-size-control` client message claims ownership at any
  time. The daemon applies the taker's cached geometry to every pane it is attached to in
  one step — no re-measure round trip.
- **Caching**: every client's geometry reports (`attach-pane` sizes and `resize-pane`) are
  always CACHED per connection; only the owner's are APPLIED. The cache mirrors what the
  client currently renders (entries drop on `detach-pane`).
- **Owner disconnect**: ownership transfers to the most recent remaining ready client that
  has reported any geometry, and that client's cached layout applies immediately — panes
  must not stay frozen at a window that no longer exists. With no candidate the owner is
  null and the next geometry report from anyone claims.
- **Broadcast**: every ownership change fans out as `size-control
  {ownerClientID}`, and the standing value is replayed to each client at handshake
  completion. A client compares it against its own `welcome.clientID`.
- **UI rule**: the take-back affordance (top bar, `take-size-control` chip) renders ONLY on
  a client that knows the owner is someone else. The owner — and a client with no owner
  known — sees nothing.
- A non-owner's `attach-pane` subscribes at the pane's **current** geometry (its measured
  size is cached, not applied), so the replay it receives matches what the owner set.

---

## 6. Focus handling

- Clicking a terminal pane focuses it (mouse-down grabs keyboard focus before the click is
  forwarded as mouse input).
- Gaining focus: tell the emulator `focus=true` (affects cursor style/blink and focus
  reporting mode `CSI I`/`CSI O` if the app enabled it) and emit a **paneFocused(paneID)**
  event that the app-state layer uses to set the workspace's `focusedPaneID`
  (only if the pane is in the active workspace and not already focused).
- Losing focus: `focus=false`.
- **Authoritative focus** (`SurfaceManager.focus(paneID)`): reducer effects (e.g. keyboard
  pane navigation, notification "Open" action, status bar pane selection) forcibly move
  focus to a pane's surface even if something else holds it.
- **Polite focus** (view-mount path): when the focused pane's view (re)mounts it grabs focus
  *unless* a text editor currently holds it (sidebar rename field, command palette input) —
  two guards: an app-level "sidebar editing" flag suppresses the grab, and a final check
  bails if the current focus owner is a text input. Prevents re-renders from stealing the
  caret mid-typing.
- Focus-related quirk worth preserving: raising the window restores its previous
  focus owner first, so programmatic pane selection must apply *after* that restoration
  (the current app defers the focus dispatch one runloop turn).

**Port target**: mostly client (DOM focus), but the daemon should track "focused pane per
attached client / active workspace" because desktop-notification suppression (section 7.4)
and status clearing depend on it.

---

## 7. Events from the terminal (ghostty → app)

libghostty surfaces raise **actions**; the app converts each into a `paneID`-keyed event and
routes it into app state. The port's daemon gets these from ghostty-vt (OSC/CSI parsing) and
node-pty (exit). Full inventory with app behavior:

### 7.1 Title change (`SET_TITLE`, from OSC 0/2)

→ `paneTitleChanged(paneID, title)`:
- sets `pane.title = title`
- bumps `pane.lastActivityAt = now`
- (title shows in pane header chrome; `lastActivityAt` drives workspace sorting/`last_activity_at` in `workspace list`)

### 7.2 Working-directory change (`PWD`, from OSC 7 via shell integration)

→ `paneDirectoryChanged(paneID, directory)`:
- sets `pane.workingDirectory = directory` (this is why splits inherit the *live* cwd)
- bumps `pane.lastActivityAt`
- async: re-detects the git branch for the new directory → `pane.gitBranch`
- additionally, app-level: if the new pwd falls inside any repo-association worktree of the
  pane's workspace (path-prefix match on standardized paths), immediately refresh that
  association's git HEAD status (instant sidebar update on `cd ../other-worktree`).

### 7.3 Close / child exit

Two sources collapse into one event `surfaceProcessExited(paneID)`:
- `close_surface_cb` — the emulator asks to close (e.g. shell exited normally,
  `wait-after-command=false` path)
- `SHOW_CHILD_EXITED` action — child process exited on a command-backed surface (the app
  returns "handled" so ghostty's own "Process exited. Press any key…" banner is suppressed,
  and treats it as a close request)

App behavior on `surfaceProcessExited`:
1. If the pane is a **parked** pane (hidden original of a `kelpi open --here` markdown
   takeover): evict it from the parked lane, null out any `parkedSourcePaneID` references,
   destroy the surface. Pane restore is no longer possible.
2. Else if the pane is a **markdown pane using an external editor** (`$EDITOR` in a bound
   surface): flip the pane back to preview mode (`isEditing=false`,
   `externalEditorCommand=null`), destroy the surface, keep the pane. (The markdown file
   watcher then reloads any changes the editor wrote.)
3. Else: **close the pane** (normal `closePane` flow — collapses the split, may close the
   workspace if it was the last pane, destroys the surface).

**Port**: node-pty `onExit` is the single source; the daemon emits
`processExited(paneID, exitCode)` and app logic above lives in the daemon's workspace layer.

### 7.4 Desktop notification (OSC 9 / OSC 777)

→ `desktopNotification(paneID, title, body)`:
- **Suppressed** iff (pane's workspace is the active workspace) AND (pane is the focused
  pane) AND (app is frontmost/active). i.e. you don't get notified about the terminal you're
  looking at.
- Otherwise post a desktop notification:
  - title/body from the OSC payload
  - identifier `"kelpi-<paneID>"` → posting again for the same pane **replaces** the previous
    notification (dedup per pane)
  - two action buttons: **Open** (also the default click action) and **Dismiss**
  - **Open** → activate the app, switch to the pane's workspace, focus the pane
  - **Dismiss** → nothing
  - notifications are shown even when the app is foreground (banner + sound) — suppression is
    purely the focus rule above
  - `removeNotification(paneID)` clears delivered+pending notifications for a pane (called
    when the user visits the pane, so stale notifications don't linger).

**Port**: daemon parses the OSC (ghostty-vt) and applies the suppression rule using its
focused-pane knowledge, then fans out to clients: Electron shell → native notification;
web/mobile → Web Notifications; the "Open" action round-trips to workspace-switch + focus.

### 7.5 Bell (`RING_BELL`)

Handled = **ignored** (returned `true` with no behavior). No visual bell, no sound, no badge.
Port may keep ignoring it (or improve; today's contract is: nothing happens).

### 7.6 Open URL / CMD-click on `.md` path (`OPEN_URL`)

When the user cmd-clicks a link-detected token in the terminal:
- The matched string is trimmed of whitespace (ghostty's URL regex includes trailing
  spaces to EOL) and of trailing `.` characters, then path-standardized.
- If it ends in `.md` → the app intercepts: `openFileAtPath(path, fromPaneID)` — opens a
  markdown pane; relative paths are resolved against the source pane's `workingDirectory`
  (or the focused pane's, or left as-is).
- Anything else → *not handled*; ghostty's default opener behavior applies (macOS `open(1)`;
  in the web client this becomes "open in browser tab / web pane" per product choice).

### 7.7 In-terminal search actions (`START_SEARCH`, `END_SEARCH`, `SEARCH_TOTAL`, `SEARCH_SELECTED`)

Kelpi drives libghostty's scrollback search via **binding actions** (strings executed against a
surface — `performBindingAction(paneID, action)`):

- open/update search: `search:<needle>` (empty needle: `search:`)
- next / previous match: `navigate_search:next` / `navigate_search:previous`
- close: `end_search`

libghostty answers with actions the app folds into per-pane search UI state:

- `START_SEARCH(needle)` → search overlay opens for that pane, prefilled with `needle`
- `END_SEARCH` → overlay closes
- `SEARCH_TOTAL(total)` → "N matches" count
- `SEARCH_SELECTED(selected)` → "i of N" current-match index

Match highlight colors come from the config keys in section 3.1.

**Port**: ghostty-vt/ghostty-web need an equivalent search capability; the four state updates
become daemon→client events; the three verbs become client→daemon (or client-local) commands.
If ghostty-web does search client-side, keep the same UI contract (needle, total, selected).

### 7.8 Render wakeup (`RENDER`)

Emulator processed output → host must repaint (see section 4). Resolution is by registry
lookup so a render draining for an already-freed surface is dropped harmlessly. Purely a
client concern in the port (server pushes state deltas; client paints).

### 7.9 Wakeup / tick

libghostty asks the host to pump its event loop (`wakeup_cb` → `ghostty_app_tick` on main).
Not portable — node's event loop replaces it.

---

## 8. Synchronise input (tmux-style, issue #121)

### 8.1 State

`SurfaceManager` holds `syncGroups: Map<workspaceID, Set<paneID>>`:

- Replaced **wholesale** per workspace on every sync-state change by app logic
  (`setSyncGroup(workspaceID, paneIDs)`); empty set removes the entry.
- The app computes the group as: all `.shell` panes of the workspace, minus the excluded
  set, and **only when ≥2 qualify** (a lone terminal never syncs with itself).
- The group is refreshed on every action that mutates the pane set while sync is active
  (create/split/close/open/reopen/process-terminated), so new panes join and dead panes drop
  out automatically.
- `isSyncing(paneID)` — membership query for the pane-header badge.
- `syncTargetIDs(sourcePaneID)` — union of all groups containing the source, minus the
  source. (Groups are per-workspace, so in practice at most one group matches.)

### 8.2 Broadcast mechanics

Two mirror paths, both **best-effort** (targets whose surfaces are gone are silently
skipped; membership lookup + surface resolution happen under one lock so they can't drift):

1. **Key events** (`broadcastKey(from, keyEvent)`): called immediately after local delivery
   of every translated key event on the keyDown path (both the committed-text and bare-key
   branches). The *same fully-translated event* (keycode, mods, consumed_mods, text bytes)
   is replayed into each sibling surface. keyUp and flagsChanged are **not** mirrored
   (only the press that carries the input).
2. **Text payloads** (`broadcastText(from, text)`): the non-keyDown insertText path —
   dictation, macOS Services paste, drag-drop — mirrors the raw string via the text path.

Not mirrored: mouse input, scroll, IME preedit updates, programmatic sends
(`pane send` / `pane send-key` target one pane only).

Overhead when sync is off: a single map lookup per keystroke.

**Port target**: daemon. This is a strong argument for daemon-side key translation: with
input arriving from a web client as key events, the daemon can either (a) have the client
send translated bytes and broadcast *bytes* to sibling PTYs, or (b) translate server-side
per-pane. Note the subtlety the current design encodes: the event is translated **once**
(against the source surface) and the same result is written to all siblings — so siblings in
different terminal modes (e.g. one in DECCKM) receive the source's encoding. Mirroring bytes
written to the source PTY is the faithful port.

---

## 9. Programmatic input (CLI-driven)

These are the daemon-critical paths — they must work with **no client attached**.

### 9.1 `pane send` — text + Enter (`sendCommand`)

Wire: `pane-send` → resolve target → reply → then:

- `bare=false` (default): `sendText(text)` then `sendEnterKey()`.
- `bare=true` (`--bare`): `sendText(text)` only.

`sendText` goes through libghostty's **paste path** (`ghostty_surface_text`), which means:
- if the foreground app enabled **bracketed paste**, the text is wrapped in
  `ESC[200~ ... ESC[201~` — this is why TUIs like Claude Code / vim receive `pane send`
  text as a paste (safe, not auto-executed);
- libghostty's unsafe-paste protection applies (control bytes in pasted text are rejected
  by default).

`sendEnterKey` is deliberately NOT part of the paste: it is a synthesized Return key
press+release through the key-event path (`keycode=0x24`, `mods=NONE`, `text="\r"`,
`unshifted_codepoint=0x0D`), so it lands **outside** the bracketed-paste envelope. For a
plain shell this executes the line; for a bracketed-paste TUI the Enter is a real submit
keystroke after the paste. This ordering/framing is the load-bearing contract:
**text-as-paste, then Enter-as-keystroke**.

### 9.2 `pane send-key` — named keystrokes (`sendNamedKey`)

Wire: `pane-send-key` with a key name. The reducer validates the name against the allowlist
**before** resolving the target (unknown key → structured error
`unknown key '<k>' (valid: enter, return, tab, escape, esc, space, backspace, up, down, left, right, ctrl-c)`).
Names are lowercased for lookup (`Enter`/`ENTER`/`enter` all work).

Each named key is delivered as a synthesized **press+release pair** through the key-event
path with `mods=NONE`, `consumed_mods=NONE`, `composing=false`. The release never carries
text. The full table:

| name(s) | macOS keycode | unshifted codepoint | `text` bytes sent | notes |
|---|---|---|---|---|
| `enter`, `return` | 0x24 | 0x0D | `"\r"` | |
| `tab` | 0x30 | 0x09 | `"\t"` | |
| `escape`, `esc` | 0x35 | 0x1B | `"\x1B"` | |
| `space` | 0x31 | 0x20 | `" "` | |
| `backspace` | 0x33 | 0x7F | `"\x7F"` | DEL byte, the PTY byte for macOS Delete |
| `ctrl-c` | 0x08 (C) | 0x03 | `"\x03"` | see below |
| `up` | 0x7E | 0xF700 | **nil** | see below |
| `down` | 0x7D | 0xF701 | **nil** | |
| `left` | 0x7B | 0xF702 | **nil** | |
| `right` | 0x7C | 0xF703 | **nil** | |

Two crucial nuances:

- **`ctrl-c` uses `mods=NONE` with `text="\x03"`**, not `mods=CTRL`. With CTRL set,
  libghostty's CSI-u/Kitty keyboard encoding could emit `\x1b[3;5u` instead of the raw ETX
  byte, and the foreground process would never get SIGINT. Sending the raw byte lets the
  kernel line discipline deliver SIGINT. Port rule: for byte-mapped keys, write the raw
  byte(s) to the PTY (unless the terminal is in an enhanced keyboard-protocol mode the vt
  layer says should re-encode them — mirror whatever ghostty-vt does for a
  mods=NONE key event carrying text).
- **Arrow keys carry no text** so the emulator translates by terminal mode: application
  cursor keys (DECCKM on) → `ESC O A/B/D/C`; normal mode → `ESC [ A/B/D/C`. The port MUST
  consult the pane's live DECCKM state (owned by daemon-side ghostty-vt) when encoding
  arrows — hardcoding `\x1b[A` breaks TUIs that enable DECCKM (vim, less, claude).
- Why not send these via the paste path: `ghostty_surface_text` runs unsafe-paste detection
  (control bytes rejected) and bracketed-paste wrapping — exactly what a keystroke must not
  get.

### 9.3 Capture — `pane capture` (`captureContents` / `readText`)

Reads the pane's terminal contents as **plain text** (no colors/attributes):

- `includeScrollback=false` (default): the **viewport** region — exactly what's visible.
- `includeScrollback=true` (`--scrollback`): the **screen** region — full history including
  scrollback.
- Implemented as a region read from top-left to bottom-right of the chosen region
  (viewport vs screen coordinate space), non-rectangular.
- Returns `null` if the surface is gone / read fails → CLI gets
  `{"ok":false,"error":"pane closed during capture"}`.
- Empty region → empty string (not null).
- The socket layer then optionally tails the last N lines (`--lines N`, must be > 0 —
  `lines <= 0` from a raw socket client is rejected with
  `"lines must be a positive integer (got N)"`), and rejects non-`shell` panes with
  `"pane is not a terminal (type: <t>)"` **before** reading.
- Reply shape:

  ```json
  {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main",
   "text":"...captured text...","label":"worker-1"}
  ```
  (`label` only when the pane has one.)

**Port target**: daemon/vt. ghostty-vt must expose "read region as text" for viewport and
full screen. This must not require any client to be attached.

### 9.4 Selection read

The app reads the current selection (offsets) to answer macOS IME queries
(`selectedRange`). Selection as a first-class read ("what's selected, as text/offsets")
lives in the emulator. In the port, selection likely becomes client-side in ghostty-web;
nothing else in the system consumes it today besides IME plumbing and copy-on-select
behavior inside libghostty.

---

## 10. Interactive keyboard input path (client-side spec)

How a physical keystroke becomes terminal bytes today — the web client + ghostty-web must
reproduce the observable behavior, not the AppKit mechanics:

1. **keyDown** arrives. The event may first be re-modified by the emulator's
   "key translation mods" (ghostty can ask the host to translate with a modified modifier
   set — e.g. macOS `option-as-alt` handling); hidden device-side bits are preserved.
2. The (possibly re-modified) event runs through the platform's **text input system**
   (IME/dead keys). Outcomes:
   - **Committed text** (one or more strings — a dead-key failure like `'` + `s` on US-Intl
     commits two strings in one keystroke): for each string, send one key event with
     `composing=false` and `text=<string>`, keycode/mods from the original event.
   - **No committed text** (bare key like arrows/enter, or still composing): send one key
     event with `composing = (currently in preedit) || (preedit was just cleared by this
     event)`, and `text` derived from the event characters (see filter below).
3. **Text filter** applied to whatever text rides on the event (`ghosttyText`):
   - empty → `nil`
   - first UTF-8 byte < 0x20 (C0 control) → `nil` — so the emulator's keymap encodes the
     proper sequence instead (e.g. Shift+Tab must become `ESC [ Z`, not the raw 0x19 macOS
     hands over). Emoji/astral text passes through untouched.
   - Additionally on the raw-event path (`ghosttyCharacters`): single control chars are
     re-derived without the Ctrl modifier, and characters in the macOS function-key range
     U+F700–U+F8FF (arrows, F-keys) are stripped to `nil`.
4. **Key event fields** (what the emulator needs to encode correctly):
   - `action`: press / repeat (`isARepeat`) / release
   - `keycode`: physical key code
   - `mods`: shift/ctrl/alt/super/caps + left/right device-side bits
   - `consumed_mods`: which modifiers the text-input system already consumed producing the
     text — everything except ctrl and cmd (so shift/option/caps are marked consumed). This
     is what lets ghostty avoid double-applying shift to a translated character while still
     encoding ctrl combos.
   - `unshifted_codepoint`: the character the key would produce with **no** modifiers.
   - `composing`: IME preedit flag.
   - `text`: filtered committed text or nil.
5. **keyUp** → release event (no text). **flagsChanged** (modifier-only transitions) → a
   press or release event for the specific modifier key, with left/right detection via
   device-side mask bits; suppressed entirely while composing (marked text present).
6. After local delivery, press events are mirrored to sync siblings (section 8).

### 10.1 IME / preedit

- Marked text (preedit) is tracked host-side. Inside a keystroke, preedit state is
  conveyed via the key event's `composing` flag; **outside** a keystroke (IME layout switch
  mid-compose, dictation) preedit changes are pushed explicitly:
  `sendPreedit(text)` on set, `sendPreedit("")` on clear.
- Committed text arriving **outside** a keystroke (dictation, Services paste, drag-drop)
  goes through the plain text path `sendText(str)` + sync-mirror `broadcastText`.
- The IME candidate window / dictation mic is positioned at the terminal cursor: the
  emulator exposes an "IME point" (x, y, w, h of the cursor cell) which the host converts to
  screen coordinates; zero-length ranges collapse the width (dictation indicator quirk).
- Terminal answers "current selection range" from emulator selection offsets (for macOS
  IME reconversion features).

**Port target**: client (ghostty-web is expected to own key translation + IME using DOM
composition events). Daemon needs the resulting bytes only — EXCEPT the named-key and
sync-broadcast paths (sections 9.2, 8.2), which must be reproducible server-side.

---

## 11. Mouse input (client-side spec)

- Coordinates are top-left-origin, in CSS points relative to the pane.
- Left button: position update + press/release (with mods). Mouse-down also focuses
  the pane first.
- Right button: position + press/release (with mods). No app context menu on terminal panes
  — right-click goes to the emulator (which may report it to the PTY app or do its own
  thing, e.g. selection extension per ghostty config).
- Drag / move: position updates with mods (enables hover reporting + drag-selection).
- Scroll: delta x/y with a `precise` flag (bit 0 of scroll mods) distinguishing trackpad
  pixel-precise scrolling from wheel-line scrolling. The emulator handles scrollback
  vs. mouse-report-mode routing (`mouseCaptured` exposes whether the terminal app captures
  the mouse).
- No mouse mirroring to sync groups.

**Port target**: client → ghostty-web; if mouse reporting modes are enabled by the PTY app,
encoded reports must be produced against daemon-side mode state (ghostty-web + daemon vt
must agree; simplest is client sends semantic mouse events to daemon-side vt which encodes).

---

## 12. Clipboard

### 12.1 Copy (terminal → clipboard)

The emulator initiates clipboard **writes** (copy-on-select, `copy_to_clipboard` binding,
OSC 52 writes): host receives the text and puts it on the system clipboard verbatim.
(Current app: general pasteboard, plain string.)

### 12.2 Paste (clipboard → terminal)

The emulator initiates clipboard **reads** (paste binding, OSC 52 reads). Host resolution
order:

1. Clipboard has a non-empty **string** → complete the request with it (this covers text
   and copied file URLs).
2. Clipboard has **image data** (PNG, or TIFF convertible to PNG) → write it to a temp file
   `<tmpdir>/kelpi-clipboard-images/clipboard-<uuid>.png` and complete the request with the
   **shell-escaped file path** — i.e. pasting a screenshot into a terminal pastes a path to
   a PNG. (Built for agent workflows: paste an image to Claude Code.)
3. Neither → report "cannot service" so a performable paste binding can pass through to the
   terminal instead of being consumed.

Confirm-protected reads (ghostty asks "really paste?" for bracketed-paste-unsafe content)
are **auto-confirmed** — Kelpi never shows a paste-confirmation dialog.

Note the paste text itself then flows through the emulator's paste pipeline (bracketed-paste
wrap + unsafe-paste filtering), same as `pane send`.

`supports_selection_clipboard = false` — no X11-style middle-click selection clipboard.

### 12.3 Shell escaping

Used for image-paste paths and drag-dropped files. Escape by prefixing `\` before every
character in the set:

```
space \ ( ) [ ] { } < > " ' ` ! # $ & ; | * ? tab
```

### 12.4 Drag-and-drop onto a terminal pane

Accepted types: file URLs, URLs, plain string. On drop:
- URLs → each becomes `shellEscape(fileURL ? path : absoluteURL)`, joined with single
  spaces → inserted as text.
- else string content → inserted as-is.
- Insertion uses the outside-keystroke text path (so it is paste-piped AND mirrored to sync
  siblings via `broadcastText`).

**Port target**: split. Copy/paste UX is client-side (browser clipboard API; Electron gets
the richer image flow — the temp-PNG trick needs filesystem access, so in the web client
image paste should round-trip through the daemon: upload the image, daemon writes the temp
file *on the machine where the PTY runs*, daemon pastes the escaped path). OSC 52
reads/writes surface in the daemon's vt layer and must be bridged to the *focused client's*
clipboard with appropriate consent rules.

---

## 13. Accessibility

The terminal view is exposed as a text-area accessibility element with help text
"Terminal content area". Web equivalent: `role="textbox"`/ARIA labeling on the terminal
canvas container plus whatever ghostty-web offers for screen-reader output.

---

## 14. App-level surface API summary (the daemon's internal interface)

The complete surface-facing API the rest of the app consumes today — this is effectively the
daemon's internal `SurfaceService` contract:

```ts
interface SurfaceService {
  // lifecycle
  createSurface(opts: CreateSurfaceOptions): void;       // idempotent per paneID
  destroySurface(paneID: string): void;                  // kill PTY (SIGHUP→SIGKILL), drop state
  destroyAll(): void;
  activeSurfaceCount(): number;

  // input
  sendText(paneID: string, text: string): void;          // paste path (bracketed-paste aware)
  sendCommand(paneID: string, command: string): void;    // sendText + Enter keystroke
  sendKey(paneID: string, keyName: string): boolean;     // named-key table (section 9.2); false = unknown name
  // (interactive key/mouse/IME arrive from clients, not through this API)

  // read
  captureContents(paneID: string, includeScrollback: boolean): string | null;
  gridSize(paneID: string): { columns: number; rows: number } | null;
  cellSize(paneID: string): { width: number; height: number } | null;  // CSS pt (client-informed)

  // search (in-terminal find)
  performBindingAction(paneID: string, action: string): boolean;
  //   used with: "search:<needle>", "navigate_search:next", "navigate_search:previous", "end_search"

  // sync input
  setSyncGroup(workspaceID: string, paneIDs: Set<string>): void;  // wholesale replace; empty = off
  isSyncing(paneID: string): boolean;
  syncTargetIDs(sourcePaneID: string): Set<string>;
  broadcastKey(sourcePaneID: string, key: KeyEvent): void;   // best-effort mirror
  broadcastText(sourcePaneID: string, text: string): void;   // best-effort mirror

  // focus / render (client-facing in the port)
  focus(paneID: string): void;                            // authoritative focus move
  resyncVisibleSurfaces(): void;                          // repaint-rescue on app activation
  setAllSurfacesOpaque(isOpaque: boolean): void;          // appearance change

  // reverse lookup (dissolves in the port — events carry paneID natively)
  paneIDForRawSurface(raw: unknown): string | null;
}

// events emitted (all paneID-keyed):
type SurfaceEvent =
  | { kind: "titleChanged"; paneID: string; title: string }
  | { kind: "pwdChanged"; paneID: string; pwd: string }
  | { kind: "processExited"; paneID: string }             // + exitCode in the port
  | { kind: "desktopNotification"; paneID: string; title: string; body: string }
  | { kind: "openFile"; paneID: string | null; path: string }   // cmd-click .md
  | { kind: "searchStart"; paneID: string; needle: string }
  | { kind: "searchEnd"; paneID: string }
  | { kind: "searchTotal"; paneID: string; total: number }
  | { kind: "searchSelected"; paneID: string; selected: number }
  | { kind: "paneFocused"; paneID: string }               // from client focus
  | { kind: "render"; paneID: string };                   // becomes state-delta push
```

Wire-level socket handlers already specced elsewhere sit on top of this:
`pane-send` (→ sendText/sendCommand), `pane-send-key` (→ sendKey, with allowlist
validation *before* target resolution), `pane-capture` (→ captureContents + tail +
type guard).

---

## 15. Invariants & edge cases checklist

1. `createSurface` is idempotent per paneID; the first creator wins.
2. Env order is deterministic: `NEX_PANE_ID`, `PATH`, then profile vars sorted by key;
   `NEX_PANE_ID`/`PATH` can never be overridden by a profile; `NEX_PROFILE` is always
   present and always wins over a spoofed config line.
3. Surfaces (PTY + emulator state) outlive UI attachment; only explicit destroy ends them.
4. Never size a surface/renderer to zero; coalesce resize storms to one final size
   (~100 ms debounce) so the PTY sees one SIGWINCH.
5. `pane send` text = paste semantics (bracketed-paste envelope when the app enabled it);
   the trailing Enter (when not `--bare`) is a keystroke outside the envelope.
6. `pane send-key` byte-mapped keys deliver raw bytes with mods=NONE (ctrl-c ⇒ 0x03 ⇒
   SIGINT via line discipline); arrow keys are encoded from live terminal mode (DECCKM).
7. Unknown send-key names are rejected before target resolution; capture rejects
   non-shell panes and `lines <= 0`; capture of a vanished pane errors
   `"pane closed during capture"`, not empty success.
8. Sync broadcast: press events + outside-keystroke text only; one translation, fan-out to
   all live siblings; dead siblings skipped silently; groups per workspace; group exists
   only when ≥2 eligible shell panes; wholesale replacement on every change.
9. Desktop notifications: suppressed only for (active workspace ∧ focused pane ∧ app
   active); per-pane dedup id `kelpi-<paneID>`; Open ⇒ activate + workspace switch + focus.
10. Title/pwd changes bump `lastActivityAt`; pwd change re-detects git branch and pings
    matching repo-association HEAD refresh.
11. Process exit: parked pane → evict; markdown external editor → back to preview (pane
    survives); otherwise pane closes.
12. Resume commands are typed (not spawned), ~2 s after surface creation, and only if the
    session id matches `^[A-Za-z0-9._-]{1,128}$`.
13. Clipboard read fallback order: string → image-as-temp-PNG-path (shell-escaped) →
    decline; confirm-protected reads auto-confirm.
14. Cmd-click intercepts only `.md` paths (after whitespace/trailing-dot trim); other URLs
    follow default opener behavior.
15. Bell is a no-op.
16. Appearance changes rebuild config with an override file loaded last and re-theme live
    surfaces without respawning PTYs; `background`/`background-opacity` read-back is from
    the *resolved* config (theme-aware).
17. Kelpi search-color defaults sit between compiled-in defaults and user config (user wins).
18. PTY teardown must not block other work and must escalate SIGHUP → SIGKILL for children
    that trap SIGHUP (fixing the current app's accepted head-of-line-blocking flaw).

---

## Port notes

**What moves where**

- **daemon / node-pty**: spawn (cwd, merged env, shell-or-command), resize (cols/rows),
  kill with SIGHUP→SIGKILL escalation, exit events. Section 2 is the spec; port
  `mergedEnvVars` as a pure tested function.
- **daemon / ghostty-vt (server-side emulator state — non-negotiable)**: grid + scrollback,
  modes (DECCKM, bracketed paste, mouse reporting), OSC parsing (title, pwd, desktop
  notification, OSC 52 clipboard), region text reads for `pane capture`, search if the vt
  build supports it. Server-side emulation is what makes capture, sync-input, named keys,
  and multi-client attach work with zero clients connected — the defining constraint of the
  new architecture.
- **daemon logic**: registry + idempotent create, sync groups + broadcast, named-key table
  (with DECCKM-aware arrows), sendText/sendCommand (paste framing + Enter-as-keystroke),
  desktop-notification suppression rule (requires the daemon to track the focused pane and
  "a client is active"), resume typing, temp-PNG image paste bridging.
- **client / ghostty-web**: rendering, focus/occlusion, resize measurement + debounce,
  interactive key/mouse/IME translation, selection, clipboard UX, visibility re-sync,
  accessibility. The client sends *bytes or semantic events* to the daemon; pick one
  consistently (see next point).

**Decisions the port must make explicitly**

1. **Where interactive key translation happens.** Current app translates in-process against
   live terminal state. If ghostty-web translates client-side, it must know mode state
   (DECCKM, kitty-keyboard) — either mirrored to the client or by the client sending
   semantic key events for the daemon's vt to encode. Whichever is chosen, sync-input
   should mirror the **bytes written to the source PTY** to sibling PTYs (matches today's
   "translate once, replay to siblings" semantics), and `pane send-key` must be encodable
   entirely server-side.
2. **Bracketed paste for `pane send`.** Reproduce exactly: text through the paste pipeline
   (envelope when the app requested it, unsafe-paste filtering), Enter as a separate
   keystroke. ghostty-vt should expose the paste entry point; if not, the daemon must
   implement envelope + control-byte filtering itself, keyed off vt mode state.
3. **Notification transport.** OSC 9/777 → daemon event → per-client presentation
   (Electron native / Web Notifications), with the suppression rule evaluated using the
   daemon's focused-pane + client-activity knowledge; "Open" round-trips to
   workspace-switch + focus. Keep per-pane replace-on-repost dedup.
4. **Clipboard bridging.** OSC 52 and copy-on-select events surface in the daemon but the
   clipboard belongs to the *client machine*. Define a bridge (likely: forward to the
   focused/attached client; require the page to be focused for writes). Image paste in web
   needs a daemon round-trip because the temp PNG must exist on the PTY host's filesystem.
5. **macOS keycodes in the named-key table** are an implementation detail of the current
   encoder — what matters downstream are the byte mappings (`\r`, `\t`, `\x1B`, space,
   `\x7F`, `\x03`) and mode-aware arrows. The daemon may drop keycodes entirely if its
   encoder doesn't need them.
6. **Search.** If ghostty-vt lacks search, the daemon can implement text search over its own
   grid/scrollback and emit the same start/end/total/selected events; highlight rendering
   then needs a client-side mechanism. Keep the Kelpi default match colors overridable by
   user config.
7. **`cellSize` provenance.** Today it comes from the emulator's font metrics ÷ backing
   scale. In the port the renderer (client) owns font metrics; the daemon needs cols/rows
   authoritative (it drives PTY size), while cell-pixel size is client-reported. Make the
   client the source of "px per cell" and the daemon the source of "cols × rows".
8. **Multi-client focus.** "Focused pane" becomes per-client; notification suppression
   should suppress only when *some* active client has the pane focused and visible. Define
   this before implementing section 7.4.

**Things deliberately NOT in this subsystem** (specced elsewhere): pane/workspace layout
and split-ratio math (`PaneLayout`), socket wire framing and target resolution
(`resolvePaneTarget`), agent status lifecycle, markdown/diff/web panes, keybinding maps.
This doc covers only what those layers *call into* the surface layer for.

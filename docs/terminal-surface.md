# Terminal Surface Subsystem — Behavioral Specification

This document specifies Kelpi's terminal layer: how a PTY is spawned and torn down, how its
emulator state is kept server-side, how programmatic and interactive input reach it, and how the
events it raises (title, pwd, exit, notifications, clipboard) flow back into app state. The layer
is split across a headless TypeScript daemon owning PTYs + terminal state (node-pty +
`@xterm/headless`), a web client rendering with ghostty-web, and thin Electron/remote shells. Each
section ends with a **Location** note saying where the capability lives
(`daemon/PTY`, `daemon/vt`, `client`, or split).

Implementation index:

- `packages/daemon/src/pty/manager.ts`: PtyManager: spawn/kill, inherited env, cwd, resize, sync-input byte mirroring
- `packages/core/src/env/merged-env.ts`: spawn-time environment composition (`mergedEnvVars`, `resolveProfileEnv`)
- `packages/daemon/src/term/service.ts`: server-side terminal state (`@xterm/headless`): capture, snapshot, modes, OSC parsing
- `packages/daemon/src/pty/input.ts`: `pane send` / `pane send-key` encoding (paste pipeline, named keys)
- `packages/daemon/src/ws/streams.ts`: PTY streams to attached clients: attach replay, resize, flow control
- `packages/daemon/src/ws/desktop.ts`: ⌘-click targets, image paste, external-editor hosting
- `packages/daemon/src/handlers/app/osc-notifications.ts`, `clipboard.ts`: OSC 9/777 and OSC 52 delivery
- `packages/client/src/terminal/TerminalPane.tsx`: the pane host: keyboard/mouse/IME, resize measurement, focus, accessibility
- `packages/client/src/app/open-file.ts`: drag-drop onto a terminal, shell escaping
- `packages/daemon/src/seams.ts`: the internal interfaces (section 14)

---

## 1. Concepts and ownership model

Kelpi has exactly one **surface** per terminal pane. A surface bundles:

1. A PTY with a spawned child process (login shell by default, or an explicit command).
2. Terminal emulator state (grid, scrollback, modes like DECCKM/bracketed-paste, selection).
3. A renderer (a ghostty-web canvas in the client) presenting that state.
4. An input translator (browser key events → terminal byte sequences / control functions).

The four are split between the daemon and the client:

| Responsibility | Owner |
|---|---|
| PTY spawn/kill, env, cwd, command, SIGWINCH | **daemon** (node-pty, `packages/daemon/src/pty/manager.ts`) |
| Terminal emulation state (grid, scrollback, modes, title/pwd OSC parsing) | **daemon** (`@xterm/headless`, `packages/daemon/src/term/service.ts`), kept server-side so capture, sync-input, and multiple attached clients all see one truth |
| Rendering | **client** (ghostty-web, `packages/client/src/terminal/renderer.ts`) |
| Key-event → bytes translation | split: the client translates for interactive typing (the engine, plus the pane's own kitty-keyboard and mouse encoders, sections 10.2 and 11); the **daemon also translates** for `pane send-key` / sync-input so those work with zero clients attached (`packages/daemon/src/pty/input.ts`) |
| Focus / occlusion / scale | client (render concerns only); the daemon keeps a "focused pane" notion per attached client for notification suppression (`packages/daemon/src/ws/sync.ts:2609-2616`) |

### 1.1 Key identity: `paneID`

Every surface is keyed by the pane UUID (`paneID`). All cross-layer routing —
socket commands, sync groups, notifications, capture — resolves through this key.
Every event raised by the terminal state service (`packages/daemon/src/term/service.ts`) and
by the PTY manager natively carries the `paneID`; there is no reverse lookup from a raw
surface handle anywhere in the system.

### 1.2 Registry semantics (`SurfaceManager`)

A single process-wide registry `Map<paneID, PtyEntry>` (`PtyManagerImpl.entries`,
`packages/daemon/src/pty/manager.ts:128`) with these behavioral guarantees:

- **Duplicate-create guard**: `spawn({paneID, ...})` is a no-op if a PTY for that paneID
  already exists (`manager.ts:155`). Racing creators exist by design: a CLI `pane create`
  can race boot restore (`packages/daemon/src/boot/resume.ts:122-127`); *first caller wins*
  and the second never replaces the live PTY. `spawnPaneIfShell`
  (`packages/daemon/src/handlers/pane/support.ts:200-253`) and the terminal state service's
  `attach` are idempotent in the same way.
- **Persistence across workspace switches**: switching workspaces unmounts the pane's renderer
  in the client but never destroys the surface. The PTY keeps running and the emulator keeps
  consuming output: PTY + vt state live server-side regardless of what any client shows, and
  the client never tears down / re-spawns on workspace switch; it re-attaches to the existing
  server-side surface and receives a replay (section 4.1).
- **Destroy is explicit**: only `kill(paneID)` (pane closed, shell exited, workspace deleted,
  external editor finished) frees the surface. `killAll()` on daemon shutdown.
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

Events that trigger `kill` (all initiated by daemon logic, not by the surface itself):

- `closePane` (user ⌘W, CLI `pane close`, process-exit auto-close)
- workspace deleted (all its panes' surfaces)
- markdown external editor exits (`pane-process-terminated` on a markdown pane using `$EDITOR`
  in a surface → release that surface's terminal state, keep the pane, flip back to preview
  mode; section 7.3)
- a *parked* pane's process dies → evict from parked lane + destroy
- daemon shutdown (`killAll`)

**Teardown**: `kill` sends `SIGHUP`, waits a short grace (`DEFAULT_KILL_GRACE_MS`, 300 ms)
and escalates to `SIGKILL` for a child that traps or ignores SIGHUP
(`packages/daemon/src/pty/manager.ts:279-296`). The pane leaves the registry immediately, so
`has()` is false and a fresh spawn may reuse the id while the old child is still being reaped
(a stale exit from that child is then ignored, `manager.ts:404-417`). Teardown never blocks the
daemon event loop waiting for a stubborn child, and one stuck teardown never serializes every
later teardown behind it (the pre-port app accepted that head-of-line-blocking flaw,
issue #136; Kelpi does not). `killAll()` resolves within `DEFAULT_KILL_ALL_TIMEOUT_MS` (2 s)
even if a child never reaps.

**Location**: daemon owns the registry and lifecycle. `spawn`/`kill` are `PtyManager`
operations; process-exit is a node-pty `onExit` event.

---

## 2. PTY spawn configuration

`PtyManager.spawn` (`packages/daemon/src/seams.ts:33-51`) takes:

```ts
interface PtySpawnOptions {
  paneID: string;            // UUID; key for everything
  cwd: string;               // absolute path; default when the pane model created it: os.homedir()
  env: ReadonlyArray<readonly [string, string]>; // the ORDERED overlay from section 2.1
                             // (already includes KELPI_PROFILE)
  cols: number;              // birth grid (section 2.4)
  rows: number;
  shell?: string;            // login shell resolved by the caller; undefined = user's default shell
  command?: string;          // optional; when set, run this instead of the login shell.
                             // Only used for markdown external-editor panes
                             // (e.g. `vim '/path/to/file.md'`, packages/daemon/src/content/external-editor.ts).
}
```

Background opacity is a render concern only (section 3.2) and never reaches the PTY.

### 2.1 Environment injection

The spawned PTY environment = inherited daemon env (see the inheritance rule below), overlaid
with an **ordered** list built as follows (`mergedEnvVars`,
`packages/core/src/env/merged-env.ts:89-106`, pure function, unit-tested):

```
1. KELPI_PANE_ID = <paneID UUID string>            (uppercase-hyphen UUID, e.g. "8F14E45F-...")
2. PATH          = <helpersDir> + ":" + <inherited PATH or "/usr/local/bin:/usr/bin:/bin">
3. KELPI_SOCKET  = tcp:127.0.0.1:<port>             (only when the daemon has a TCP control listener;
                                                     routes the pane's `kelpi` CLI back to THIS daemon
                                                     rather than the shared default socket)
4. ...profile vars, sorted by key ascending, EXCLUDING reserved keys
```

- **Reserved keys**: `KELPI_PANE_ID`, `KELPI_SOCKET`, `PATH` (`RESERVED_ENV_KEYS`,
  `merged-env.ts:18-23`). Profile entries with these names are silently dropped, built-ins
  always win.
- `helpersDir` is the directory containing the bundled `kelpi` CLI, handed to the daemon by
  the shell as `KELPID_HELPERS_DIR` (`packages/daemon/src/boot/compose.ts:157`). Its purpose:
  the `kelpi` binary must be found on PATH inside every pane, ahead of anything else (on macOS
  it also disambiguates from the `Kelpi` app binary on case-insensitive filesystems). With no
  helpers dir (headless/dev boot) PATH is the inherited PATH untouched, never a leading `:`
  (`packages/daemon/src/handlers/pane/support.ts:164-171`).
- The `KELPI_SOCKET` route is read at env-build time, not captured, so it exists only once the
  run-dir control server has bound its TCP listener and survives a live re-bind
  (`compose.ts:916-920`). The CLI honours the `tcp:` form and silently falls back to the
  default socket for anything else.
- The profile env dict arrives with `KELPI_PROFILE=<profileName>` already merged in by the
  profile resolver (`resolveProfileEnv`, `merged-env.ts:57-66`): the profile reader
  (`createProfileReader`, `packages/daemon/src/boot/config.ts:100-107`) reads
  `~/.config/kelpi/config` fresh on every call (no caching), the resolver takes the named
  profile's vars (empty for the virtual `default` profile unless the user defined vars), and
  sets `KELPI_PROFILE=<name>` **last** so a config line spoofing `KELPI_PROFILE` loses.
  Unassigned workspaces resolve profile name `"default"` — so **every** pane ends up with
  `KELPI_PROFILE` set (the CLI reads `KELPI_PANE_ID` / `KELPI_PROFILE`,
  `packages/cli/src/env.ts:36-64`). A non-`default` name with no `profile` lines behind it is
  still injected but logged once as a probable typo (`support.ts:173-190`). No `NEX_*`
  variable is injected: Kelpi and the pre-port app share no environment by design
  (`merged-env.ts:2-7`).
- **Inheritance rule** (`buildEnv`, `packages/daemon/src/pty/manager.ts:369-401`): the daemon's
  `process.env` is copied minus every key matching `CLAUDE_*`, plus `CLAUDECODE` and
  `AI_AGENT` (`inheritableEnvKey`, `manager.ts:96-98`). Those describe whatever Claude session
  happened to launch the daemon, and leaking them into a pane made every `claude --resume`
  think it was a child of a session that no longer existed. The daemon's own `$TERM` is never
  inherited: the pane gets the configured default (`xterm-256color`) unless the overlay carries
  a `TERM` of its own. `COLORTERM=truecolor` is set when absent. The overlay applies after the
  filter, so a profile that deliberately sets `CLAUDE_CONFIG_DIR` still lands.
- Injection is **spawn-time only**. Live PTYs keep their birth env; changing a workspace's
  profile affects only later spawns.

Every spawn path injects this env identically through `spawnEnvVars` / `restoreEnvVars`
(`support.ts:156-192`, `packages/daemon/src/boot/resume.ts:98-119`):

1. workspace create → first pane
2. split / `pane create` (GUI or CLI)
3. daemon-restart restore of persisted shell panes (per-workspace profile; profiles are read
   once per launch batch, and a pane with a recorded resume tuple spawns under the tuple's
   profile instead, see 2.3)
4. markdown external-editor surface (with `command`): spawned by the "$EDITOR" chip's wire
   command `markdown-external-editor {pane_id, action:'open'}`
   (`packages/daemon/src/ws/desktop.ts:338-341`), never by ⌘E, whose binding only toggles
   the built-in editor or closes a running session (`packages/client/src/App.tsx:1186-1195`)
5. reopen-closed-pane (restores a shell pane; then, if an agent session id was captured,
   types the resume command — see 2.3)
6. ~~lazy view-mount fallback~~ (none: a client's `attach-pane` never creates a PTY; it only
   sizes, snapshots and subscribes (`packages/daemon/src/ws/streams.ts:351-397`,
   `packages/daemon/src/ws/sync.ts:1943-1970`), and a pane with no terminal state replays an
   empty snapshot. Its first geometry report may release a deferred spawn (section 2.4). The
   duplicate-create guard still matters for a CLI `pane create` racing boot restore.)

### 2.2 Working directory and command

- `workingDirectory` is passed straight to the PTY spawn as `cwd`. Defaults: new pane model
  defaults to the user's home directory; splits inherit the source pane's current
  `workingDirectory` (which tracks live pwd via OSC, section 7.2); `pane create --path` /
  `pane split --path` override. A requested directory that is missing or not a directory
  would make the child die instantly (the spawn's chdir fails), so `resolveSpawnCwd`
  (`packages/daemon/src/pty/manager.ts:100-110`) falls back to `$HOME`, then to `/` if even
  that is gone.
- `command == undefined` → spawn the user's login shell: the explicit `shell` option, else
  `$SHELL` from the merged env, else `/bin/sh` (`resolveShell`, `manager.ts:112-125`).
  `command` set → the command is hosted as `<shell> -c <command>` (`manager.ts:165-170`); an
  empty or whitespace-only command is ignored so a blank field can never turn an interactive
  pane into `sh -c ''` (an instant exit). When the command exits the surface reports
  child-exit (section 7.3) rather than lingering: node-pty `onExit` is the signal uniformly.
- A spawn that throws on a shell other than `/bin/sh` (a broken `$SHELL`) is retried once on
  `/bin/sh` (`manager.ts:172-195`). If that also throws, the manager reports the error and
  emits a synthetic exit with code `-1` on the next tick (`reportSpawnFailure`,
  `manager.ts:420-427`), so the normal process-exited path (section 7.3) runs instead of the
  pane waiting forever.
- Font size and scale factor are render concerns (the client reads them from the resolved
  appearance, section 3.2).

### 2.3 Post-spawn typed commands (restore/resume)

After restoring surfaces on daemon relaunch (and on reopen-closed-pane), the daemon *types* an
agent resume command into the pane rather than spawning with it:

```
sleep 2 seconds   // let the shell finish printing its prompt (RESUME_SETTLE_DELAY_MS)
sendText(paneID, "claude --resume <sessionID>", {bare: false})     // or "codex resume <sessionID>"
```

- `sendText` with `bare=false` = write text + press Enter (section 9.1).
- The session id passes a shell-safety allowlist first (`isSafeSessionID`,
  `packages/core/src/agent/session.ts:31-42`): non-empty, ≤128 chars, ASCII alphanumerics
  plus `.`, `_`, `-` only. Fails → `resumeCommand` returns null and the resume is skipped
  entirely (never typed).
- The 2-second delay (`RESUME_SETTLE_DELAY_MS`, `session.ts:87`) is a heuristic that lets the
  shell finish printing its prompt.
- **Profile of a resumed pane**: a resume tuple carries the `KELPI_PROFILE` the session was
  launched under. When present, and the id passes the allowlist, the pane's env is resolved
  from that profile (`sessionProfileName`) rather than the workspace's current assignment,
  so the resumed agent lands in the environment it knows
  (`packages/daemon/src/boot/resume.ts:110-150`,
  `packages/daemon/src/handlers/pane/support.ts:149-160`). A tuple whose id will never
  produce a typed command does not drag its profile into the pane. A resume into a pane the
  spawn gate (section 2.4) is still holding flushes the spawn first.

**Location**: daemon (node-pty `spawn({file, args, cwd, env, cols, rows})`). The env-merge
function is a pure, tested function with contractual ordering and reserved-key filtering
(`mergedEnvVars`).

### 2.4 Spawn geometry: last-known grid and the deferred spawn gate

The server emulator does not reflow on a column change (section 5.2), so a shell born at
80×24 and resized a moment later leaves a wrongly-wrapped prompt in scrollback forever. Every
spawn path therefore settles the birth grid before it spawns:

- **Last-known geometry** (`packages/daemon/src/pty/geometry.ts`): every client attach and
  every resize records the pane's grid, persisted to `pane-geometry.json` beside the database
  (memory-only for a `:memory:` daemon), debounced 750 ms and capped at 500 panes. Every spawn
  path asks `sizeFor(paneID)` first: the pane's own last size, else the most recent size any
  pane reported. The file is a cache, never a source of truth; a missing or corrupt one costs
  exactly the fixed-grid behaviour, and nothing here throws into a spawn path.
- **Deferred spawn** (`packages/daemon/src/pty/spawn-gate.ts`): a pane the cache has never
  seen (a fresh install's first pane, a split's child, a markdown pane's first "$EDITOR"
  session) is offered to the gate, which holds the spawn until the client's first geometry
  report for that pane (`report()` runs it synchronously at that size, before the attach that
  carried it snapshots),
  a hard timeout (`DEFAULT_SPAWN_DEFER_TIMEOUT_MS`, 2 s, then the caller's fallback size), or a
  demand (`flush()`: a keystroke, a `pane send`, a resume command, or a `pane capture`, which
  flushes explicitly, `packages/daemon/src/handlers/pane/input.ts:95-98`). `cancel()` is wired
  to `pty.kill`, so a pane closed while deferred never spawns. Exactly one spawn runs per pane
  and a throwing callback is reported and swallowed.
- **Policy** (`packages/daemon/src/boot/compose.ts:443-448`): the gate defers only while a
  client is attached or inside the boot window where one is expected; the fallback-to-latest
  read is a good guess but not a reason to skip waiting, so a pane whose own size is unknown
  is deferred even when `latest()` has an answer (`compose.ts:921-928`). A headless daemon
  (the CLI-only flows) spawns immediately as before.
- Fallback grid: `DEFAULT_COLS`/`DEFAULT_ROWS` = 80×24. Both `spawnPaneIfShell`
  (`packages/daemon/src/handlers/pane/support.ts:222-253`) and boot restore
  (`packages/daemon/src/boot/resume.ts:159-195`) re-read store state when the deferred spawn
  finally runs, since the pane may have been closed or retyped in the meantime.

---

## 3. Ghostty configuration

### 3.1 Config sources and precedence (low → high)

1. The client renderer's compiled-in defaults (ghostty-web).
2. **Kelpi defaults the user can override**: the four search-highlight colours are kelpi-config
   keys in `~/.config/kelpi/config` (`packages/core/src/config/chrome.ts:52-66`, defaults at
   `chrome.ts:75-78`, parsed at `chrome.ts:253-268`):

   ```
   search-match-color = #F2D027
   search-match-text-color = #000000
   search-match-current-color = #FF7A00
   search-match-current-text-color = #000000
   ```

   (High-contrast in-terminal search match colors, aligned with the markdown find overlay.)
   Every search highlight in Kelpi is drawn by Kelpi itself (the terminal search reveal, the
   injected markdown/diff find script, the web pane's find script), so there is no defaults
   file laid under the user's ghostty config; an unparseable or blank value keeps the default.
3. User's `~/.config/ghostty/config` (or whatever `KELPID_GHOSTTY_CONFIG` names,
   `packages/daemon/src/settings/service.ts:85-93`): the daemon parses it and serves the
   resolved appearance to every client, so the user's existing Ghostty setup (font, theme,
   colors, padding) applies to Kelpi terminals. `config-file` includes are not followed
   (`packages/daemon/src/settings/ghostty.ts:1-24`). `theme = <name>` is resolved by the
   daemon against the ghostty theme search directories (`packages/daemon/src/settings/theme.ts`;
   `KELPID_GHOSTTY_THEME_DIRS` replaces the search path): a theme file's six document colours
   and `palette = N=#hex` lines are understood, includes inside a theme are not followed, and
   nothing here ships a palette. A name that resolves to nothing keeps the current palette and
   the reason is shown in Settings ▸ Appearance.
4. There is **no override file**. When the user changes background color/theme/opacity in
   Kelpi Settings, the daemon writes the key (`theme`, `background`, `background-opacity`, …)
   straight into the user's ghostty config, atomically and preserving every unrelated line
   (`commitGhostty`, `service.ts:465-473`; the file is created only when a write needs
   somewhere to land, never removed). Both config files are watched; any change re-reads both
   and, only when the resulting snapshot actually differs, broadcasts `settings-changed`, so
   **live surfaces re-theme without respawn** (`service.ts:1-24`).

### 3.2 Config keys Kelpi itself reads

The daemon reads these keys out of the user's ghostty config (`parseGhosttyAppearance`,
`packages/daemon/src/settings/ghostty.ts:11-70`) and serves them on the settings snapshot's
`appearance` object (`packages/daemon/src/settings/service.ts:310-328`):

- `background` (RGB color) — note this is the *resolved* value, i.e. after any `theme` is
  applied, so reading it back after a theme change yields the theme's background. A resolved
  theme's background applies only when the config names no `background` line of its own
  (`hasExplicitBackground`); an explicit line always wins (`service.ts:226-239`).
- `background-opacity` (double, 0..1; default 1.0)
- `font-family` (repeated lines accumulate into a fallback stack; `font-family = ""` clears
  it) and `font-size`
- `theme` (verbatim, it may be `dark:X,light:Y`; resolved as in section 3.1)
- `window-padding-x`, `window-padding-y` (whole pixels, rounded and clamped to 0–64; unset
  means the client's shipped default)

`isDark` is computed once from the resolved background by the daemon so its rendered
markdown/diff HTML and the client chrome cannot disagree.

These drive: pane container fill, markdown/scratchpad/diff pane backgrounds (so non-terminal
panes match the terminal), window transparency compositing, and layer opacity
(`opacity >= 1.0` → opaque layers). On appearance change the daemon updates the snapshot and
broadcasts `settings-changed` so terminal and non-terminal panes re-render.

There is no separate app-side store for appearance: a Settings change is written into the
ghostty config itself (section 3.1), so the file is the single source of truth at startup and
after a hand edit alike.

**Location**: split. The daemon parses the user's ghostty config and the kelpi config and
serves font/theme/colors to ghostty-web clients as a "resolved appearance" object shared by
every client, so terminal and non-terminal panes agree. Live re-theme = the daemon pushes
`settings-changed`; clients re-style without touching PTYs.

---

## 4. Rendering & visibility management (client-side concerns)

The web client's rendering obligations:

- **Draw on output**: when the emulator processes new PTY output, the visible view repaints.
  (A surface created while hidden/occluded once got zero draws and stayed blank, issue #194.
  The client subscribes to the pane's PTY stream and paints whenever bytes arrive, and a
  re-attach always brings a full replay, section 4.1.)
- **Zero-size guard**: never propagate a zero-size layout to the renderer or the PTY;
  transient zero bounds occur during re-parenting/layout. Skip, and sync when real bounds
  arrive (the "initial-size rescue": first non-zero layout pass forces a size-sync + draw).
  The daemon enforces the same guard on its side (`packages/daemon/src/ws/streams.ts:405-410`,
  `packages/daemon/src/pty/manager.ts:257-264`).
- **Reattach re-sync**: when a pane's view re-enters the visible hierarchy (workspace switch
  back, split collapse), re-assert its pixel size and request a repaint after layout settles.
- **Occlusion**: hidden panes have no renderer at all (the mount policy in section 4.1
  unmounts them), so no render loop runs for them; the daemon keeps consuming PTY output
  regardless.
- **Opacity**: layer opacity flips with `backgroundOpacity >= 1.0`; sub-1.0 opacity makes the
  window composite translucently, as CSS alpha on the terminal background.

**Location**: client (ghostty-web). None of this touches the daemon except that the daemon
keeps consuming PTY output for invisible surfaces (backpressure: it never pauses the PTY
because no client is watching, section 4.1).

### 4.1 Attach replay, flow control and renderer mounting

- **Attach contract** (`packages/daemon/src/ws/streams.ts:8-40`, `:351-397`): an attaching
  client gets exactly one `replay` frame (the serialized server-side VT snapshot, taken through
  `snapshotAsync` so bytes fed but not yet parsed are included) followed by gapless `output`.
  The pane is registered as "attaching" first (live bytes for it are ignored while it is), the
  snapshot is taken, and the continuation flips the pane live **synchronously**, so no I/O
  callback can run between the snapshot settling and the first live byte. The pane's VT modes
  (`pane-modes`, section 10.2) follow right behind the replay. Re-attaching an already-attached
  pane is a geometry update, not a second replay.
- **Flow control** (`PTY_FLOW_CONTROL_WINDOW_BYTES`, 512 KiB,
  `packages/protocol/src/ws/pty.ts:34`): the daemon counts unacked payload bytes per
  (client, pane). Past the window it stops sending to THAT client and queues; past
  `DEFAULT_CLIENT_QUEUE_BYTES` (1 MiB, `streams.ts:73`) it drops the queue, re-seeds the client
  with a fresh `replay` and sends a `pty-resync` notice on the JSON channel. The PTY is never
  paused and other viewers are never slowed down: a slow phone must not stall an agent.
- **Renderer mount cap** (`packages/client/src/terminal/mount-policy.ts`): only the active
  workspace's visible panes get a live engine, LRU-capped at `DEFAULT_MOUNT_LIMIT` (12), where
  "used" means focused or newly appeared. Eviction disposes the engine and detaches the PTY
  stream; re-mounting re-attaches and the daemon replays the snapshot, so the pane comes back
  with its screen intact.
- **Chunked replays** (`packages/client/src/terminal/ingest.ts`): a replay is applied in
  `REPLAY_CHUNK_BYTES` (64 KiB) writes under an `REPLAY_TICK_BUDGET_MS` (8 ms) budget per task,
  so a multi-megabyte snapshot cannot wedge the main thread and stall the flow-control acks.
  A second replay always resets the engine first, a newer replay supersedes one still being
  applied (a CAN byte aborts any escape sequence the cut left open), and live bytes that
  arrive while a replay is pending are held (up to 256 KiB) and released after it painted.

---

## 5. Resize handling

- The client measures the pane host in CSS pixels (times `devicePixelRatio` for the canvas),
  the engine derives cols×rows from its cell metrics, and the client reports the grid
  (`attach-pane` sizes and `resize-pane`); the daemon applies it to the server VT and the
  PTY, which delivers SIGWINCH to the child.
- **Debounce**: interactive resizes (split drag, maximize, window resize) fire many
  intermediate sizes. The client debounces 100 ms (`DEFAULT_RESIZE_DEBOUNCE_MS`,
  `packages/client/src/terminal/TerminalPane.tsx:57-70`) so a settled resize sends only the
  final size and the shell gets a single SIGWINCH instead of a redraw storm. The debounce has
  a 100 ms max-wait ceiling (`RESIZE_MAX_WAIT_MS`): a pure trailing debounce starved under a
  continuous divider drag, so the geometry is republished about 10 times a second while the
  drag runs, as a native terminal does. The daemon applies `pty.resize(cols, rows)` and the vt
  dimensions (section 5.2 for the ordering).
- **Scale changes** (monitor DPI change): `devicePixelRatio` changes re-derive the pixel size.
- **Grid/cell queries**:
  - `gridSize(paneID) → {cols, rows} | null` is answered by the daemon's terminal state
    service (`packages/daemon/src/term/service.ts:690`), and
  - cell size in CSS pixels is client-reported (the engine's font metrics), never known to
    the daemon.

  These are used by the resize overlay: while dragging a divider over a terminal pane it shows
  `"<cols> x <rows>"` from the pane's measured grid; over a pane with no cell size it falls
  back to pixel dimensions `"<w> x <h>"` (`packages/client/src/grid/PaneGrid.tsx:177-182`).
  The `pane resize` CLI reply needs these numbers server-side, so the daemon's vt layer owns
  cols/rows and cell metrics are reported by the rendering client.

**Location**: split. Client measures and debounces; daemon applies to node-pty and vt state;
daemon answers grid-size queries.

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

### 5.2 Applying a resize: VT before PTY, the settled resync, and no column reflow

- **Order** (`packages/daemon/src/ws/streams.ts:399-435`): a resize is applied to the
  server-side VT first, then to the PTY, then recorded in the geometry cache (section 2.4).
  The PTY resize is the ioctl that raises SIGWINCH and the shell starts repainting for the
  new geometry the moment it lands; doing the VT first means a repaint emitted for geometry N
  is never parsed at geometry N-1.
- **Post-resize resync** (`DEFAULT_RESIZE_RESYNC_MS`, 150 ms, `streams.ts:74-92`): a pane has
  two emulators, the daemon's and the client's, and a resize is the one event that makes them
  disagree over identical bytes. Once a pane's grid has held still for 150 ms the daemon
  re-snapshots and sends a fresh `replay` to every live attached client. It is server-initiated
  (no new wire verb; the client applies a mid-stream replay by resetting and rewriting) and
  cannot loop, because a replay provokes no resize and an unchanged grid arms no timer. The
  150 ms sits behind the client's 100 ms debounce so a drag storm becomes exactly one resync
  per settled gesture. The client renderer suspends its paint before the resize and resumes
  when the replay lands, so the canvas keeps the last good frame across the window
  (`packages/client/src/terminal/renderer.ts:918-940`).
- **No column reflow** (`NO_REFLOW`, `packages/daemon/src/term/service.ts:56-120`): the server
  emulator is configured not to reflow on a column change (xterm's `windowsPty` policy). A
  shell's line editor repaints on SIGWINCH assuming the terminal did not move its text; with
  reflow on, each shrink inserted a row under zle's arithmetic and a 90-step width drag left 13
  stale prompt copies in the buffer, against 1 with reflow off (measured). Rows keep xterm's
  stock behaviour, applied first at the old width, so a taller viewport still pulls history
  down out of scrollback (`applyGrid`, `service.ts:706-745`); a column shrink hand-trims the
  cells it stranded past the grid. Every buffer read (capture, search, ⌘-click) is bounded to
  `min(cols, line.length)` for the same reason.

---

## 6. Focus handling

- Clicking a terminal pane focuses it (mouse-down grabs keyboard focus before the click is
  forwarded as mouse input).
- Gaining focus: tell the engine `focus=true` (affects cursor style/blink and focus reporting
  mode `CSI I`/`CSI O` if the app enabled it) and send `focus-report {workspaceID, paneID}`
  to the daemon (`packages/protocol/src/ws/messages.ts:84-92`). Focus is **daemon-canonical**
  (`focusReport`, `packages/daemon/src/ws/sync.ts:1756-1769`): the report records that
  client's focused pane, activates the reported workspace for that client
  (`setActiveWorkspace`, which may dispatch `set-active-workspace`), and dispatches
  `focus-pane` unless the workspace already has that pane focused. The last report from any
  client wins, with no active-workspace guard, so focused-pane-dependent CLI commands keep
  their semantics whichever window the user is in.
- Losing focus: `focus=false`.
- **Authoritative focus** (`focus-pane` dispatched by the daemon): handler effects (e.g.
  keyboard pane navigation, notification "Open" action, status bar pane selection, a ⌘-click
  that opens a markdown pane) forcibly move focus to a pane even if something else holds it;
  the client follows the store's `focusedPaneID`.
- **Polite focus** (view-mount path, `shouldGrabFocus`,
  `packages/client/src/app/pane-focus.ts:59-77`): when the focused pane's surface (re)mounts
  it grabs focus *unless* a text editor outside any pane currently holds it (sidebar rename
  field, command palette input): two guards: an app-level "sidebar editing" flag suppresses
  the grab, and a final check bails if the current focus owner is an editable element that is
  not another pane's surface. Prevents re-renders from stealing the caret mid-typing.
- Focus-related quirk worth preserving: raising the window restores its previous
  focus owner first, so programmatic pane selection applies *after* that restoration
  (the focus dispatch is deferred one turn).

**Location**: mostly client (DOM focus), but the daemon tracks the focused pane and active
workspace per attached client (`attends`, `packages/daemon/src/ws/sync.ts:2609-2616`) because
desktop-notification suppression (section 7.4) and status clearing depend on it.

---

## 7. Events from the terminal (ghostty → app)

The daemon's terminal state service (`packages/daemon/src/term/service.ts:760-815`) parses
OSC sequences off the PTY stream and node-pty reports exit; each becomes a `paneID`-keyed
event that boot (`packages/daemon/src/boot/compose.ts`) routes into the store. Full inventory
with app behavior:

### 7.1 Title change (`SET_TITLE`, from OSC 0/2)

→ `pane-title-changed` (`packages/daemon/src/store/reducers/agent.ts:73-83`; xterm routes
OSC 0 and OSC 2 to the one `onTitleChange` hook, `service.ts:777`):
- sets `pane.title = title`
- bumps `pane.lastActivityAt = now`
- a repeat of the current title is dropped before the dispatch, so an app that re-asserts
  its title every redraw does not become a delta per frame (`compose.ts:1067-1076`)
- (title shows in pane header chrome; `lastActivityAt` drives workspace sorting/`last_activity_at` in `workspace list`)

### 7.2 Working-directory change (`PWD`, from OSC 7 via shell integration)

→ `pane-directory-changed` (`packages/daemon/src/store/reducers/agent.ts:84-94`, dispatched
by `onPaneDirectory`, `compose.ts:1047-1065`; an unchanged directory is dropped):
- sets `pane.workingDirectory = directory` (this is why splits inherit the *live* cwd)
- bumps `pane.lastActivityAt`
- async: re-detects the git branch for the new directory → `pane.gitBranch`
- additionally, app-level: if the new pwd falls inside any repo-association worktree of the
  pane's workspace (exact-or-prefix match on canonicalized paths, `isPathInside`), immediately
  refresh that association's git HEAD status, branch and dirtiness (instant sidebar update on
  `cd ../other-worktree`). The auto-detect store reconciler spots the move and calls its
  `refreshAssociation` hook, which compose.ts wires to `repoWatch.refresh` (the same read a
  HEAD change makes); it is not gated on the auto-detect setting (issue #48).

### 7.3 Close / child exit

One source: node-pty `onExit`, surfaced as `PtyManager.onExit(paneID, exitCode)`
(`packages/daemon/src/pty/manager.ts:360-365`, `:404-417`). It fires for a shell that exited
normally, for a command-backed surface whose command finished, and (with exit code `-1`) for a
spawn that failed outright (section 2.2). A pane killed and re-spawned before its old child
was reaped does not report the stale exit. Boot's exit listener
(`packages/daemon/src/boot/compose.ts:890-900`) dispatches `pane-process-terminated`; during
shutdown the exits of the children being killed are ignored so the panes about to be persisted
stay open. Attached clients additionally receive `pane-exit {paneID, exitCode, signal?}` on
the JSON channel (`packages/protocol/src/ws/messages.ts:621-626`).

Behavior on `pane-process-terminated` (`paneProcessTerminated`,
`packages/daemon/src/store/reducers/panes.ts:288-317`):
1. If the pane is a **parked** pane (hidden original of a `kelpi open --here` markdown
   takeover): evict it from the parked lane, null out any `parkedSourcePaneID` references,
   destroy the surface. Pane restore is no longer possible.
2. Else if the pane is a **markdown pane using an external editor** (`$EDITOR` in a bound
   surface): flip the pane back to preview mode (`isEditing=false`,
   `externalEditorCommand=null`), destroy the surface, keep the pane. (The markdown file
   watcher then reloads any changes the editor wrote.)
3. Else, if the pane is a **shell** pane: **close the pane** (the normal `closePane` flow,
   `closePaneInWorkspace`, `panes.ts:185-229`: collapses the split, destroys the surface).
   The reducer never deletes the workspace: when the exiting shell was its last pane the
   workspace is left with `panes = []`, an empty layout and `focusedPaneID = null`
   (`panes.ts:314`; boot's exit listener dispatches nothing further,
   `compose.ts:890-899`). Only the client's close-pane keybinding maps "close the last
   pane" to workspace deletion (`closeFocused`, `packages/client/src/App.tsx:1364-1380`).
   A non-shell pane whose PTY exits after it has already left external-editor mode
   (⌘E out of a live editor session) is left untouched (`panes.ts:305-315`); boot's exit
   listener only releases its terminal state (`term.dispose`) so the next `$EDITOR` session
   starts from a clean screen rather than replaying the last one's.

**Location**: daemon. node-pty `onExit` is the single source; the branch logic above lives in
the daemon's workspace reducer.

### 7.4 Desktop notification (OSC 9 / OSC 777)

→ `createOscNotificationSink` (`packages/daemon/src/handlers/app/osc-notifications.ts:41-63`,
parsed by `packages/daemon/src/term/osc-notify.ts:53-86`):
- **Suppressed** iff some attached client whose document is visible has the pane's workspace
  as its active workspace AND that pane as its focused pane (AND, when that client reported a
  visibility set, the pane is in it) AND at least one attached client's document is visible
  (`attends` / `isPaneAttended` / `presence`, `packages/daemon/src/ws/sync.ts:2609-2616`,
  `:2752-2764`; the matrix is `notificationDecision('osc')`,
  `packages/core/src/agent/notifications.ts:25-46`). With no client attached nothing is
  attended, so a headless daemon posts. i.e. you don't get notified about the terminal
  someone is looking at. A pane in a background workspace can never be attended, so it always
  notifies.
- Otherwise broadcast `notification {kind: 'osc', paneID, workspaceID, title, body,
  dedupeKey}` to every client:
  - body from the OSC payload; title from OSC 777, else (OSC 9 carries none) the pane's
    title, else the workspace name. Both fields have C0/DEL controls stripped and are capped
    at 512 characters (`OSC_NOTIFY_MAX_LENGTH`, truncated rather than dropped); an empty body,
    or an OSC 777 whose verb is not `notify`, raises nothing. `lastActivityAt` is not bumped:
    a notification is a message *about* the pane, not activity in it.
  - `dedupeKey` `"kelpi-<paneID>"` → posting again for the same pane **replaces** the previous
    notification (dedup per pane)
  - two action buttons: **Open** (also the default click action) and **Dismiss**
  - **Open** → activate the app, switch to the pane's workspace, focus the pane
  - **Dismiss** → nothing
  - notifications are shown even when the app is foreground (banner + sound) — suppression is
    purely the focus rule above
  - there is no `removeNotification` on the wire: the daemon publishes a notification but
    never a retraction (`packages/shell/src/agents.ts:443-452`). Each client withdraws its
    own. The Electron shell closes the live `kelpi-<paneID>` notification only when the pane
    leaves the waiting set (`noLongerWaitingPanes`, `packages/shell/src/status.ts:583-591`),
    so a native OSC toast on an idle pane is never retracted by visiting it. The browser
    client closes its notification and toast when the user focuses the pane
    (`packages/client/src/state/bridge.ts:390-391`,
    `packages/client/src/state/notifications.ts:187-199`).

**Location**: daemon parses the OSC (`term/osc-notify.ts`) and applies the suppression rule
using its per-client focus knowledge, then fans out to clients: Electron shell → native
notification; web/mobile → Web Notifications; the "Open" action round-trips to
workspace-switch + focus. Open/Dismiss presentation is the shell's.

### 7.5 Bell (`RING_BELL`)

**Ignored.** The daemon's emulator registers no BEL handler, and although the client renderer
exposes an `onBell` hook (`packages/client/src/terminal/TerminalPane.tsx:260`, `:626`) nothing
above the pane subscribes to it. No visual bell, no sound, no badge. The contract is: nothing
happens.

### 7.6 Open URL / CMD-click on `.md` path (`OPEN_URL`)

A ⌘-click on a terminal cell is a daemon round-trip (`open-terminal-target`,
`packages/daemon/src/ws/desktop.ts:272-332`; the client sends the clicked cell from
`packages/client/src/App.tsx:2066-2067`, `:3704`). The client sends `pane_id`, `row`, `col`;
the daemon reads the wrap-joined logical line under that cell from its own buffer
(`cellText`, `packages/daemon/src/term/service.ts:589-637`) and takes the token at that
offset:
- the token is trimmed of trailing `.`, then `,;:`, then `.` again, and a balanced wrapper
  pair (`()`, `[]`, `<>`, quotes) is stripped (`tokenAt`, `desktop.ts:168-193`);
- an `http(s)://` URL → reply `opened: "external", url` and the client hands it to the OS
  opener (`urlFromToken`, `desktop.ts:205-213`);
- otherwise the token is resolved against the pane's `workingDirectory` (with `~` expansion
  and path normalisation, `resolveTerminalPath`, `desktop.ts:196-202`); if it ends in `.md`
  (case-sensitive) **and the file exists** → open a markdown pane beside the source pane and
  focus the source pane first (`opened: "markdown"`); a `.md` token whose file is missing
  answers `opened: "missing"` and nothing opens (deliberate: a ⌘-click on prose must not leave
  a broken preview behind);
- anything else → `opened: "none"`.

### 7.7 In-terminal search actions (`START_SEARCH`, `END_SEARCH`, `SEARCH_TOTAL`, `SEARCH_SELECTED`)

Search runs on the daemon over the pane's server-side buffer
(`packages/daemon/src/ws/search.ts`, `packages/daemon/src/term/search.ts`, dispatched at
`packages/daemon/src/ws/sync.ts:2125-2149`): one buffer, one match list, identical counts in
every attached window, and it works for a pane whose renderer was evicted (section 4.1).
Neither renderer exposes a find API, which is why it moved server-side.

One WS-only verb, `terminal-search`, with an `action`:

- `toggle` (`workspace_id`) → open/close the bar (the reducer's own rule)
- `set` (`pane_id`/`workspace_id`, `needle`) → new needle; counts recomputed
- `next` / `prev` → advance / step back the selection; both directions wrap. With nothing
  selected yet `next` lands on the first match and `prev` on the last, so the counter reads
  `-/N` until navigated
- `close` → clear the bar and every count
- `status` → read-only snapshot

`searchingPaneID`, `searchNeedle`, `searchTotal` and `searchSelected` are **workspace state**
and ride the delta stream as part of `workspace-upserted`, so every window agrees. The reply
additionally carries the selected match's position as `linesFromBottom`, since absolute line
indices do not survive the crossing between the two engines; each client's engine turns it
into its own viewport coordinates. Soft-wrapped rows are re-joined before matching and every
row is read bounded to the grid (section 5.2). Counts are computed only for **shell** panes: a
markdown/diff pane's find runs inside its own sandboxed frame and a web pane's in the host's
`webContents`, so for those the reply reports `total: null` and the client's own backend counts.

Match highlight colors come from the kelpi-config keys in section 3.1.

**Location**: daemon (`ws/search.ts`, `term/search.ts`); the client is a viewer of the
daemon's answer and scrolls its engine to the reveal.

### 7.8 Render wakeup (`RENDER`)

Emulator processed output → the client repaints (see section 4). The daemon pushes `output`
frames on the pane's PTY stream (`packages/daemon/src/ws/streams.ts`); the client's ingest
(`packages/client/src/terminal/ingest.ts`) writes them into the engine, which schedules its
own frame. A pane with no mounted renderer is detached from the stream (section 4.1), so
nothing is drawn for it and nothing is lost. Purely a client concern.

### 7.9 Wakeup / tick

There is no host tick: node's event loop drives the daemon, and the client engine schedules
its own frames.

---

## 8. Synchronise input (tmux-style, issue #121)

### 8.1 State

`PtyManager` holds `syncGroups: Map<workspaceID, Set<paneID>>`
(`packages/daemon/src/pty/manager.ts:129`):

- Replaced **wholesale** per workspace on every sync-state change by the handlers
  (`setSyncGroup(workspaceID, paneIDs)`, called through `refreshSyncGroup`,
  `packages/daemon/src/handlers/pane/support.ts:140-146`); empty set removes the entry.
- The group is computed as: all `.shell` panes of the workspace, minus the excluded set,
  and **only when ≥2 qualify** (a lone terminal never syncs with itself).
- The group is refreshed on every action that mutates the pane set while sync is active
  (create/split/close/open/reopen/process-terminated), so new panes join and dead panes drop
  out automatically.
- `isSyncing(paneID)`: membership query for the pane-header badge (`KelpiPtyManager`,
  `manager.ts:50-61`).
- `syncTargetIDs(sourcePaneID)` — union of all groups containing the source, minus the
  source. (Groups are per-workspace, so in practice at most one group matches.)

### 8.2 Broadcast mechanics

One mirror path, **best-effort** (targets whose PTYs are gone or have exited are silently
skipped; membership lookup and the writes happen in one synchronous call so they can't drift):
`PtyManager.write(paneID, bytes)` (`packages/daemon/src/pty/manager.ts:239-246`) writes the
bytes to the source PTY and then the *exact same bytes* to every sibling from
`syncTargetIDs`. `writeDirect` is the un-mirrored path. What rides the mirrored path:

1. **Key events**: the bytes the client engine produced for a key press, sent on the pane's
   PTY stream as an `input` frame and written with `write`. The event is translated once,
   against the source pane, and the same result is replayed into each sibling. keyUp and
   modifier-only transitions carry no bytes in the legacy encoding, so only the press that
   carries the input is mirrored; a kitty-protocol release (section 10.2) does carry bytes
   and is kept off the mirror by the frame type below.
2. **Text payloads**: text committed outside a keystroke is mirrored the same way: an IME
   composition through the engine's paste path, a drag-drop through the `drop-text` desktop
   command (`packages/daemon/src/ws/desktop.ts`), which paste-pipes the text and then calls
   `sendText(..., {bare: true, mirror: true})`, the one `TerminalInput` call that uses `write`
   rather than `writeDirect` (`packages/daemon/src/pty/input.ts`, section 12.4).

Not mirrored: mouse input, kitty key releases, scroll, IME preedit updates, programmatic
sends (`pane send` / `pane send-key` target one pane only and use `writeDirect`,
`packages/daemon/src/pty/input.ts:7-10`), replay, resume typing, and the kitty keyboard
query reply (section 10.2). Mouse reports and kitty releases are encoded on the client and
would be indistinguishable from keystrokes by their bytes, so the client sends them as a
separate `inputDirect` PTY frame (`packages/protocol/src/ws/pty.ts`,
`PtyStreamHandle.writeDirect`), which the stream handler routes to `writeDirect`
(`packages/daemon/src/ws/streams.ts`); the `input` frame is the only client frame that
mirrors. A sibling in another mouse mode (or none) would otherwise receive the source's cell
coordinates as typed text (issue #51).

Overhead when sync is off: a single map lookup per keystroke.

**Location**: daemon. Kelpi mirrors the **bytes written to the source PTY** to sibling PTYs
rather than translating per pane: the event is translated **once** (against the source
surface) and the same result is written to all siblings, so siblings in different terminal
modes (e.g. one in DECCKM) receive the source's encoding.

---

## 9. Programmatic input (CLI-driven)

These are the daemon-critical paths, they work with **no client attached**. Both are
implemented by `TerminalInput` (`packages/daemon/src/pty/input.ts`) from the pane's live VT
modes, and both use `writeDirect` so nothing here is mirrored to sync siblings (section 8.2).
A send into a pane whose first spawn the gate is still holding flushes the spawn first
(section 2.4).

### 9.1 `pane send` — text + Enter (`sendCommand`)

Wire: `pane-send` → resolve target → reply → then:

- `bare=false` (default): `sendText(text, {bare: false})` = paste, then Enter.
- `bare=true` (`--bare`): the paste only.

`sendText` goes through the daemon's own **paste pipeline** (`encodePasteText`,
`packages/daemon/src/pty/input.ts:82-111`), keyed off the pane's live vt modes:
- embedded `ESC[200~` / `ESC[201~` are removed, so pasted text can never close (or fake) its
  own envelope;
- CRLF and LF are normalised to CR (the byte a terminal receives for Enter);
- remaining C0 controls (TAB excepted) and DEL are dropped, so a payload cannot smuggle
  escape sequences into the pane (the daemon does this filtering itself in place of an
  unsafe-paste prompt; there is no confirmation dialog, section 12.2);
- if the foreground app enabled **bracketed paste**, the result is wrapped in
  `ESC[200~ ... ESC[201~` — this is why TUIs like Claude Code / vim receive `pane send`
  text as a paste (safe, not auto-executed).

A payload that filters down to nothing writes nothing (the Enter below still follows,
`input.ts:131-135`).

The Enter is deliberately NOT part of the paste: it is a second, separate `writeDirect` of
the single byte `\r` (`ENTER_BYTES`), so it lands **outside** the bracketed-paste envelope.
For a plain shell this executes the line; for a bracketed-paste TUI the Enter is a real
submit keystroke after the paste. This ordering/framing is the load-bearing contract:
**text-as-paste, then Enter-as-keystroke**.

### 9.2 `pane send-key` — named keystrokes (`sendNamedKey`)

Wire: `pane-send-key` with a key name. The handler validates the name against the allowlist
**before** resolving the target (unknown key → `UnknownNamedKeyError`, `input.ts:33-45`,
which the handler turns into the structured error
`unknown key '<k>' (valid: enter, return, tab, escape, esc, space, backspace, up, down, left, right, ctrl-c)`).
Names are lowercased for lookup (`Enter`/`ENTER`/`enter` all work).

Each named key is written straight to the PTY with `writeDirect` (`encodeNamedKey`,
`input.ts:46-80`): byte-mapped keys as their raw byte(s), arrows encoded from the pane's live
DECCKM state. The full table:

| name(s) | bytes sent | notes |
|---|---|---|
| `enter`, `return` | `"\r"` | |
| `tab` | `"\t"` | |
| `escape`, `esc` | `"\x1B"` | |
| `space` | `" "` | |
| `backspace` | `"\x7F"` | DEL byte, the PTY byte for the Delete key |
| `ctrl-c` | `"\x03"` | see below |
| `up` | `ESC [ A` / `ESC O A` | mode-dependent, see below |
| `down` | `ESC [ B` / `ESC O B` | |
| `left` | `ESC [ D` / `ESC O D` | |
| `right` | `ESC [ C` / `ESC O C` | |

Two crucial nuances:

- **`ctrl-c` is the raw ETX byte**, never a modifier-encoded key. A CSI-u/kitty keyboard
  encoding (`\x1b[3;5u`) would never reach the line discipline as ETX, and the foreground
  process would never get SIGINT. Sending the raw byte lets the kernel line discipline
  deliver SIGINT. Rule: for byte-mapped keys, write the raw byte(s) to the PTY.
- **Arrow keys are encoded by terminal mode**: application cursor keys (DECCKM on) →
  `ESC O A/B/D/C`; normal mode → `ESC [ A/B/D/C`. The daemon consults the pane's live
  DECCKM state (`modes()` on the terminal state service) when encoding arrows, hardcoding
  `\x1b[A` breaks TUIs that enable DECCKM (vim, less, claude). A pane with no terminal state
  yet encodes with both modes off (`DEFAULT_VT_MODES`).
- Why not send these via the paste path: the paste pipeline drops control bytes and applies
  bracketed-paste wrapping, exactly what a keystroke must not get.

### 9.3 Capture — `pane capture` (`captureContents` / `readText`)

Reads the pane's terminal contents as **plain text** (no colors/attributes):

- `includeScrollback=false` (default): the **viewport** region — exactly what's visible.
- `includeScrollback=true` (`--scrollback`): the **screen** region — full history including
  scrollback.
- Implemented as a region read from top-left to bottom-right of the chosen region
  (viewport vs screen coordinate space), non-rectangular (`readRegion`,
  `packages/daemon/src/term/service.ts:856-905`):
  - the **active** buffer is read, so an app on the alternate screen captures that screen
    (which has no scrollback);
  - soft-wrapped rows (`isWrapped`) are re-joined into one logical line, so a wrapped command
    line does not come back with a spurious newline;
  - each row is read bounded to `min(cols, line.length)` (required under the no-reflow
    policy, section 5.2, so cells a shrink stranded past the grid never appear) and its
    trailing run of blanks is dropped; interior blanks are preserved;
  - trailing blank lines are trimmed.
- The handler flushes a deferred spawn first (section 2.4) and reads through `captureAsync`,
  which awaits every queued VT write, so bytes fed moments earlier are included
  (`packages/daemon/src/handlers/pane/input.ts:95-98`, `:129-135`).
- Fails if the surface is gone / read throws → CLI gets
  `{"ok":false,"error":"pane closed during capture"}`.
- Empty region → empty string (not null).
- The socket layer then optionally tails the last N lines (`--lines N`, must be > 0 —
  `lines <= 0` from a raw socket client is rejected with
  `"lines must be a positive integer (got N)"`), and rejects non-`shell` panes with
  `"pane is not a terminal (type: <t>)"` **before** reading (`input.ts:79`, `:91`).
- Reply shape:

  ```json
  {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main",
   "text":"...captured text...","label":"worker-1"}
  ```
  (`label` only when the pane has one.)

**Location**: daemon/vt. The terminal state service exposes "read region as text" for
viewport and full screen. This does not require any client to be attached.

### 9.4 Selection read

Selection is client-side: the engine owns it, the renderer exposes `onSelectionChange`
(`packages/client/src/terminal/renderer.ts:897`) and the pane forwards it to the app
(`packages/client/src/terminal/TerminalPane.tsx:266`, `:632`). The daemon holds no selection
state; nothing else in the system consumes selection besides the client's copy-on-select
behaviour (section 12.1).

---

## 10. Interactive keyboard input path (client-side spec)

How a physical keystroke becomes terminal bytes. The client engine (ghostty-web, behind
`packages/client/src/terminal/renderer.ts`) owns key translation for the legacy encoding; the
pane host (`packages/client/src/terminal/TerminalPane.tsx`) intercepts ahead of it only for
the kitty keyboard protocol (section 10.2). The observable contract:

1. **keydown** arrives at the pane host. The app's own key dispatcher is a window-level
   capture listener that has already run and consumed anything that is a Kelpi binding, so a
   bound ⌘ chord never reaches the terminal. Modifier handling such as `option-as-alt`
   follows the ghostty config the engine was given.
2. The engine's `keydown` listener takes it (the vendored engine,
   `vendor/ghostty-web-patched/source/lib/input-handler.ts:260-283`, registers `keydown`,
   `paste`, `beforeinput` and the three composition events, and no `keyup`). A keystroke the
   browser marks as composing (`event.isComposing` or `keyCode === 229`) is dropped
   (`:338-340`); the key that ends a composition is queued and replayed after
   `compositionend`, as text and only when it is a single character (`:345-350`,
   `:579-590`).
3. **Browser-owned chords**: Ctrl/Cmd+V is left to the browser so the `paste` event fires
   (section 12.2) and Cmd+C is left to the selection manager (`:374-385`); neither is
   encoded.
4. **Encode**: `event.code` is mapped to a ghostty key (`mapKeyCode`, `:389`). An event with
   no mappable code (a synthetic or virtual-keyboard event) is written as text only when it
   is an unmodified single Unicode scalar, else dropped (`:390-412`). Otherwise the engine
   calls the WASM key encoder with `{action: PRESS, key, mods, utf8}` (`:461-466`): `mods`
   is read off the event (`extractModifiers`, `:314`, `:414`) and `utf8` is `event.key` only
   when that is a single Unicode scalar, so named keys (`Enter`, `ArrowUp`, `F1`, `Dead`)
   carry none (`:424-429`). DECCKM and DECNKM are synced into the encoder before every
   encode (`:436-439`). There is no text filter and no consumed-modifier computation:
   `KeyEvent.consumedMods` exists in the type
   (`vendor/ghostty-web-patched/source/lib/types.ts:346`) but nothing in the engine
   populates it. A mapped key always has its browser default prevented, even when the
   encoding comes back empty (`:456-457`); non-empty output is written to the PTY
   (`:473-475`).
5. **Text outside the encoder**: composed text is written by `compositionend` (`:562-567`),
   and any other text the hidden textarea inserts (`beforeinput` with `inputType ===
   'insertText'`) is written by a bridge that skips it when the last keydown already emitted
   the same bytes within 100 ms (`:515-530`). No `keyup` listener exists, so the legacy path
   never sees a release; a release is encoded only by Kelpi's own kitty layer when an
   application negotiated `report event types` (section 10.2).
6. After local delivery, the bytes written to the source PTY are mirrored to sync siblings
   (section 8).

### 10.1 IME / preedit

- Marked text (preedit) is tracked client-side. The engine's key path never encodes a
  composing keystroke (section 10, step 2); `compositionstart` / `compositionend` on the pane
  host bracket it (`TerminalPane.tsx:929-963`), and the kitty encoder is bypassed for the whole
  composition (`event.isComposing` or `keyCode === 229` counts as composing too).
- Committed text arriving **outside** a keystroke (a composed string committed by
  `compositionend`, drag-drop) goes through the plain text path.
- The IME candidate window is positioned at the terminal cursor by the engine's hidden
  textarea.
- The daemon never sees a preedit: only committed bytes cross the socket.

**Location**: client (ghostty-web owns key translation + IME using DOM composition events;
the pane's own encoders cover kitty keyboard and mouse reporting). The daemon needs the
resulting bytes only, EXCEPT the named-key and sync-broadcast paths (sections 9.2, 8.2),
which are reproduced server-side.

### 10.2 Kitty keyboard protocol

The engine registers one `keydown` listener and no `keyup` listener, and never calls its own
`setKittyFlags`, so a protocol whose subject is press/repeat/**release** is implemented in
Kelpi's own layer on both sides of the wire:

- **Daemon** (`packages/daemon/src/term/kitty-keyboard.ts`): the negotiated flags are read
  off the VT stream the daemon already parses: `CSI > flags u` pushes onto the active
  screen's stack, `CSI < n u` pops, `CSI = flags ; mode u` sets in place, and RIS clears both
  screens' flags and stacks. The alternate screen has its own stack, so a full-screen app that
  dies without popping cannot leave the shell underneath in a protocol it never asked for.
  Every incoming value is masked with `SUPPORTED_KITTY_FLAGS` (disambiguate | report event
  types | report all keys; `report alternate keys` and `report associated text` are not
  advertised because a browser cannot supply the layout data they need).
- **Query reply**: `CSI ? u` is answered with `CSI ? flags u` written to the PTY through
  `writeDirect` (`onKittyReply`, `packages/daemon/src/term/service.ts:279-291`,
  `packages/daemon/src/boot/compose.ts:524-535`), the one place where parsing output owes the
  PTY input; it is never mirrored into a synchronise-input sibling.
- **Streaming**: the flags ride `VtModes.kittyKeyboardFlags` (`packages/daemon/src/seams.ts:77-96`)
  alongside DECCKM, bracketed paste and the mouse modes. `pane-modes` is sent right after
  every replay (`packages/daemon/src/ws/streams.ts:396`) and on every real transition
  (`onModesChange`, `service.ts:268-277`, fires only when the modes actually changed).
- **Client** (`packages/client/src/terminal/kitty-keyboard.ts`,
  `TerminalPane.tsx:922-963`): the pane intercepts `keydown` / `keyup` in the capture phase
  and encodes `CSI number ; modifiers : event u` (and the `~` / letter functional forms)
  itself, calling `stopImmediatePropagation` so the engine never sees a consumed event. With
  `flags === 0` nothing is intercepted, and even with flags set a key whose kitty encoding is
  its legacy encoding is handed back to the engine (only the engine knows whether DECCKM
  applies), so plain typing stays byte-identical by construction. Lock modifiers (caps/num
  lock) are never reported. Composition bypasses the encoder entirely (section 10.1). A
  press or repeat encoding is written as a mirrored `input` frame; a release encoding
  (`:3u`) is written as the un-mirrored `inputDirect` frame, so only the press that carries
  the input reaches a synchronise-input sibling (section 8.2).

---

## 11. Mouse input (client-side spec)

- Coordinates are top-left-origin, in CSS pixels relative to the pane.
- Left button: position update + press/release (with mods). Mouse-down also focuses
  the pane first.
- Right button: position + press/release (with mods). No app context menu on terminal panes:
  right-click goes to the terminal (which may report it to the PTY app or do its own
  thing, e.g. selection extension per ghostty config).
- Drag / move: position updates with mods (enables hover reporting + drag-selection).
- Scroll: delta x/y, with trackpad pixel-precise scrolling distinguished from wheel-line
  scrolling. When no mouse mode is set the engine scrolls its own scrollback; when a mouse
  mode is set the wheel becomes button 64/65 reports (horizontal 66/67), accumulated against
  the cell height so each whole cell is one press.
- **Mouse reporting** is implemented in Kelpi's own layer, not the engine's
  (`packages/client/src/terminal/mouse.ts`; the engine parses the DECSET modes and then
  ignores them). The daemon tracks DEC mouse tracking (9 / 1000 / 1002 / 1003) and format
  (1005 / 1006 / 1015 / 1016) off the VT stream (`packages/daemon/src/term/mouse-modes.ts`)
  and streams them as `pane-modes` (section 10.2); the pane intercepts pointer events in the
  capture phase before the engine's canvas handlers (`TerminalPane.tsx:408-410`, `:844`) and
  encodes the reports itself, transcribing ghostty's encoding: `shouldReport` per mode,
  button codes with the `+4/+8/+16` modifier bits and the `+32` motion bit, motion reported
  only when the cell changed, X10's 223-cell ceiling, and raw bytes (not UTF-8) on the wire
  for the X10 and URXVT formats. Turning reporting on suppresses the engine's selection for
  the same events, which is what a real terminal does, with ghostty's
  `mouse-shift-capture = false` default as the escape hatch (`mouse.ts:440-450`): a
  shift-held button press or release is recorded as held but not reported and is handed to
  the engine, so shift-drag still selects while an application owns the mouse (`:459-465`,
  `:503-510`); shift-held motion bypasses reporting only while a button is down, so a bare
  shift+move under mode 1003 still reports (`:477-481`); shift+wheel is still reported, with
  the shift bit set (`:519-544`). `mouseTracking: 'none'` resets the reporter.
- No mouse mirroring to sync groups: every report is written as the un-mirrored
  `inputDirect` PTY frame (section 8.2), never as `input`.

**Location**: client. Encoded reports are produced against daemon-side mode state, which the
daemon streams to every attached client so the engine and the daemon vt agree.

---

## 12. Clipboard

### 12.1 Copy (terminal → clipboard)

Copy-on-select and the copy binding are client-side (the engine writes the browser/Electron
clipboard directly). **OSC 52 writes** are parsed by the daemon's vt
(`packages/daemon/src/term/osc52.ts`, registered at
`packages/daemon/src/term/service.ts:796-815`, which claims the sequence) and honoured by
`createClipboardWriteSink` (`packages/daemon/src/handlers/app/clipboard.ts:57-107`) only when
the `clipboard-write` setting is on (default **off**; read live at event time, so a Settings
toggle or a hand edit of `~/.config/kelpi/config` governs the very next sequence). A dropped
write leaves one log line naming the setting. Only the clipboard selection (`c`, or omitted)
is honoured: `p`/`s` are ignored with a log, since there is no primary selection to write and
silently redirecting to the clipboard would overwrite what the user copied. An empty payload
(ghostty's clipboard *clear*) and anything over 100 KiB decoded
(`OSC_52_MAX_DECODED_BYTES`, dropped rather than truncated) are dropped with a reason;
`52;cs;…` (a multi-byte selection field) is malformed. An accepted write is broadcast as
`clipboard-write {paneID, workspaceID, text, bytes}` to every attached client
(`packages/protocol/src/ws/messages.ts:594-620`), parked panes and background workspaces
included, and each client writes the text to its **own** machine's clipboard
(`packages/client/src/state/clipboard.ts`: the Electron main process for a shell window,
`navigator.clipboard` best-effort in a browser). Logs carry the pane id and byte count,
never the text.

### 12.2 Paste (clipboard → terminal)

**OSC 52 reads** (`OSC 52 ; c ; ?`, any selection) are refused unconditionally
(`clipboard.ts:59-68`): nothing is written back to the PTY, the refusal is logged, and no
setting enables them. A terminal that answers hands the developer's clipboard to whatever
runs in the pane, which in this architecture can be an agent, an `ssh` session on another
machine, or a `cat` of a file someone else wrote. The refusal is structural: the sink has no
PTY reference and the service subscribes to no `onData`, so nothing can turn a read into a
reply.

The paste binding itself is client-side. Resolution order:

1. Clipboard has a non-empty **string** → the engine pastes it (this covers text and copied
   file URLs); the text flows through the paste pipeline (bracketed-paste wrap), same as
   `pane send`.
2. Clipboard has **no text** but has a PNG image → the client's capture-phase paste listener
   (`packages/client/src/App.tsx:3641-3665`) uploads the bytes (`paste-image`, base64 over
   the WS command channel, `App.tsx:2134-2151`; PNG only, since a browser clipboard already hands
   over PNG, and an unknown type is refused rather than written with a lying extension); the
   daemon (`packages/daemon/src/ws/desktop.ts:449-505`) caps it at `MAX_PASTE_IMAGE_BYTES`
   (24 MiB), writes `<tmpdir>/kelpi-clipboard-images/clipboard-<uuid>.png` **on the machine
   the PTY runs on** and types the **shell-escaped file path** bare (no Enter) through the
   same paste pipeline as `pane send --bare`, i.e. pasting a screenshot into a terminal
   pastes a path to a PNG. (Built for agent workflows: paste an image to Claude Code.)
3. Neither → nothing is typed.

Kelpi never shows a paste-confirmation dialog: the daemon's paste filter (section 9.1) does
the unsafe-paste protection instead.

No selection clipboard is exposed to programs (OSC 52 `p`/`s` are ignored, section 12.1).

### 12.3 Shell escaping

Used for image-paste paths and drag-dropped files (`shellEscapePath`,
`packages/client/src/app/open-file.ts:225-234`; the daemon's image paste applies the same
set, `packages/daemon/src/ws/desktop.ts:94-100`). Escape by prefixing `\` before every
character in the set:

```
space \ ( ) [ ] { } < > " ' ` ! # $ & ; | * ? tab
```

### 12.4 Drag-and-drop onto a terminal pane

Accepted content: file paths only (`terminalDropText` / `pathsFromDrop`,
`packages/client/src/app/open-file.ts:81-108`, `:249-253`; the drop handler is
`packages/client/src/App.tsx:3618-3632`). On drop:
- `text/uri-list` entries that are `file://` URLs (empty or `localhost` host) → each decoded
  path becomes `shellEscape(path)`, joined with single spaces → typed into the pane. Every
  entry is typed, in order (the window-level markdown route takes only the first).
- Otherwise, `text/plain` lines that are path-shaped (`/`, `~/`, `./`, `../`, `file://`
  prefixes) → the same escape-and-join.
- A drag offering neither (an `http(s)://` URL, arbitrary text) is refused: nothing is typed
  and the window-level open route is not consulted either.
- Insertion uses the outside-keystroke text path (so it is paste-piped AND mirrored to sync
  siblings, section 8.2): the client sends the joined text as the `drop-text` desktop
  command (`commands.dropText`, `packages/daemon/src/ws/desktop.ts`), never as
  `pane-send --bare`, because `pane send` is a programmatic send and is exempt from
  mirroring (section 9). The daemon applies the section 9.1 paste pipeline and writes bare
  (no Enter) with `mirror: true`.

**Location**: split. Copy/paste UX is client-side (browser clipboard API); image paste
round-trips through the daemon because the temp PNG must exist on the machine where the PTY
runs. OSC 52 writes surface in the daemon's vt layer and are bridged to every attached
client's clipboard behind the `clipboard-write` gate; OSC 52 reads are refused.

---

## 13. Accessibility

The terminal host is exposed as a multi-line text-area element (`role="textbox"` with the
multi-line attribute, since `textbox` alone reads as a single-line field) carrying the help
text "Terminal content area" as its description (`TERMINAL_ACCESSIBILITY_HELP`,
`packages/client/src/terminal/TerminalPane.tsx:135-155`, `:1204`), plus whatever ghostty-web
offers for screen-reader output.

---

## 14. App-level surface API summary (the daemon's internal interface)

The surface API the rest of the daemon consumes is three seams in
`packages/daemon/src/seams.ts:30-118`:

```ts
interface PtyManager {                                    // packages/daemon/src/pty/manager.ts
  // lifecycle
  spawn(opts: PtySpawnOptions): void;                     // idempotent per paneID (section 2)
  has(paneID: string): boolean;
  kill(paneID: string): void;                             // SIGHUP → grace → SIGKILL, never blocks
  killAll(): Promise<void>;

  // input
  write(paneID: string, data: Uint8Array | string): void;       // mirrors the bytes to sync siblings
  writeDirect(paneID: string, data: Uint8Array | string): void; // no mirroring: programmatic sends,
                                                                // replay, resume typing, kitty reply
  resize(paneID: string, cols: number, rows: number): void;

  // sync input
  setSyncGroup(workspaceID: string, paneIDs: ReadonlySet<string>): void; // wholesale replace; empty = off

  // events
  onData(cb: (paneID: string, data: Uint8Array) => void): () => void;
  onExit(cb: (paneID: string, exitCode: number) => void): () => void;   // = processExited
}
// The widened KelpiPtyManager (manager.ts:50-61) adds pid(paneID), count() (= the old
// activeSurfaceCount), paneIDs(), isSyncing(paneID), syncTargetIDs(sourcePaneID).

interface TerminalStateService {                          // packages/daemon/src/term/service.ts
  attach(paneID: string, cols: number, rows: number): void;
  feed(paneID: string, data: Uint8Array): void;
  resize(paneID: string, cols: number, rows: number): void;
  capture(paneID: string, opts: { scrollback: boolean }): string;   // section 9.3
  snapshot(paneID: string): { data: Uint8Array; cols: number; rows: number };
  modes(paneID: string): VtModes;                         // DECCKM, bracketed paste, mouse, kitty flags
  dispose(paneID: string): void;
}
// The implementation adds captureAsync / snapshotAsync / modesAsync / flush (await pending
// writes first), cellText (section 7.6), search (section 7.7) and gridSize (section 5).

interface TerminalInput {                                 // packages/daemon/src/pty/input.ts
  sendText(paneID: string, text: string, opts: { bare: boolean }): void; // paste pipeline, then Enter unless bare
  sendNamedKey(paneID: string, key: string): void;        // throws UnknownNamedKeyError for a name outside the vocabulary
}
```

Events (all paneID-keyed) are callbacks on the terminal state service and the PTY manager:
`onTitleChange`, `onDirectoryChange`, `onOscNotification`, `onClipboardRequest` (OSC 52),
`onModesChange` (real transitions only), `onKittyReply`; `processExited` is
`PtyManager.onExit(paneID, exitCode)`. Clients learn of an exit as `pane-exit {exitCode}`
(`packages/protocol/src/ws/messages.ts:621-626`); the store action `pane-process-terminated`
carries only the `paneID`. Focus arrives from clients as `focus-report` (section 6); cmd-click
is the `open-terminal-target` round-trip (section 7.6); search state rides the workspace
deltas (section 7.7); render is the PTY stream itself (section 7.8).

`focus`, `resyncVisibleSurfaces`, `setAllSurfacesOpaque` and `cellSize` are client concerns
and have no daemon member. There is no reverse lookup: events carry the `paneID` natively.

Wire-level socket handlers already specced elsewhere sit on top of this:
`pane-send` (→ `sendText`), `pane-send-key` (→ `sendNamedKey`, with allowlist validation
*before* target resolution), `pane-capture` (→ `captureAsync` + tail + type guard).

---

## 15. Invariants & edge cases checklist

1. `createSurface` is idempotent per paneID; the first creator wins.
2. Env order is deterministic: `KELPI_PANE_ID`, `PATH`, `KELPI_SOCKET` (when the daemon has
   a TCP control route), then profile vars sorted by key; `KELPI_PANE_ID`/`KELPI_SOCKET`/
   `PATH` can never be overridden by a profile; `KELPI_PROFILE` is always present and always
   wins over a spoofed config line. `CLAUDE_*` session markers and the daemon's own `TERM`
   are never inherited.
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
9. Desktop notifications: suppressed only when some visible attached client has (active
   workspace ∧ focused pane) and some client is visible; a headless daemon always posts;
   per-pane dedup id `kelpi-<paneID>`; Open ⇒ activate + workspace switch + focus.
10. Title/pwd changes bump `lastActivityAt`; pwd change re-detects git branch and pings
    matching repo-association HEAD refresh.
11. Process exit: parked pane → evict; markdown external editor → back to preview (pane
    survives); otherwise a shell pane closes (a non-shell pane is left open and only its
    terminal state is released).
12. Resume commands are typed (not spawned), ~2 s after surface creation, and only if the
    session id matches `^[A-Za-z0-9._-]{1,128}$`; the pane spawns under the profile the
    session was launched with when the tuple recorded one.
13. Clipboard: OSC 52 reads are always refused with no reply; OSC 52 writes need
    `clipboard-write = true` and go to every attached client's own clipboard. Paste order:
    string → (no text) PNG image as a temp-PNG path on the PTY host (shell-escaped, typed
    bare) → nothing; there is no paste-confirmation dialog.
14. Cmd-click intercepts only existing `.md` paths (after trailing-dot/punctuation/wrapper
    trim, resolved against the pane's cwd); `http(s)` URLs are handed to the OS opener; a
    missing `.md` file opens nothing.
15. Bell is a no-op.
16. Appearance changes are written through into the user's ghostty config (no override
    file) and re-theme live surfaces without respawning PTYs; `background` read-back is from
    the *resolved* config (theme-aware, explicit line wins); the daemon serves seven keys.
17. Kelpi search-color defaults are kelpi-config keys the user can override (user wins).
18. PTY teardown never blocks other work and escalates SIGHUP → SIGKILL for children that
    trap SIGHUP (the pre-port app's accepted head-of-line-blocking flaw is gone).
19. Spawn geometry: a pane spawns at its last-known grid, or waits for the first client
    geometry report (bounded by a 2 s timeout, released early by any demand), and only
    falls back to 80×24 when nothing is attached; the server emulator never reflows columns.
20. Attach = one replay, then gapless output; a slow client is queued and re-seeded, never
    the PTY paused; focus is daemon-canonical, last report from any client wins.

---

## Compatibility rationale

These notes record the quirks Kelpi preserves on purpose so that the pre-port `kelpi` CLI,
hook scripts and saved state keep working, and why the layer is split the way it is.

**Where things live**

- **daemon / node-pty**: spawn (cwd, merged env, shell-or-command), resize (cols/rows),
  kill with SIGHUP→SIGKILL escalation, exit events. Section 2 is the spec; `mergedEnvVars`
  is a pure tested function (`packages/core/src/env/merged-env.ts`).
- **daemon / `@xterm/headless` (server-side emulator state, non-negotiable)**: grid +
  scrollback, modes (DECCKM, bracketed paste, mouse reporting, kitty keyboard flags), OSC
  parsing (title, pwd, desktop notification, OSC 52 clipboard), region text reads for
  `pane capture`, search over the buffer. Server-side emulation is what makes capture,
  sync-input, named keys, and multi-client attach work with zero clients connected, the
  defining constraint of the architecture.
- **daemon logic**: registry + idempotent create, sync groups + byte mirroring, named-key
  table (with DECCKM-aware arrows), `sendText` (paste framing + Enter-as-keystroke),
  desktop-notification suppression rule (the daemon tracks the focused pane per client and
  "a client is visible"), resume typing, temp-PNG image paste bridging, spawn geometry.
- **client / ghostty-web**: rendering, focus/occlusion, resize measurement + debounce,
  interactive key/mouse/IME translation (with Kelpi's own kitty-keyboard and mouse
  encoders), selection, clipboard UX, visibility re-sync, accessibility. The client sends
  *bytes* to the daemon, consistently (see decision 1).

**Decisions, and how they were taken**

1. **Where interactive key translation happens.** The pre-port app translated in-process
   against live terminal state. Kelpi translates client-side: the engine encodes the legacy
   forms, and mode state the client needs (DECCKM, bracketed paste, mouse modes, kitty
   flags) is mirrored to the client as `pane-modes`. Sync-input mirrors the **bytes written
   to the source PTY** to sibling PTYs (`PtyManager.write`, matching the old "translate once,
   replay to siblings" semantics), and `pane send-key` is encoded entirely server-side
   (`packages/daemon/src/pty/input.ts`).
2. **Bracketed paste for `pane send`.** Reproduced exactly: text through the paste pipeline
   (envelope when the app requested it, control-byte filtering), Enter as a separate
   keystroke. The daemon implements envelope + control-byte filtering itself, keyed off vt
   mode state (`encodePasteText`, `input.ts:82-111`), because the emulator exposes no paste
   entry point of its own.
3. **Notification transport.** OSC 9/777 → daemon event → per-client presentation
   (Electron native / Web Notifications), with the suppression rule evaluated using the
   daemon's per-client focused-pane + visibility knowledge; "Open" round-trips to
   workspace-switch + focus. Per-pane replace-on-repost dedup (`kelpi-<paneID>`) is kept.
4. **Clipboard bridging.** OSC 52 events surface in the daemon but the clipboard belongs to
   the *client machine*. The bridge is a broadcast: an accepted write goes to every attached
   client, and each writes its own clipboard. Writes are gated by `clipboard-write` (default
   off) and reads are refused outright, which is stricter than the pre-port app (it honoured
   OSC 52 unconditionally in both directions, auto-confirming every read); the only consent
   rule that survives a daemon whose clipboard lives on a different machine from the PTY is
   "no". Image paste round-trips through the daemon because the temp PNG must exist on the
   PTY host's filesystem.
5. **macOS keycodes in the named-key table** were an implementation detail of the pre-port
   encoder — what matters downstream are the byte mappings (`\r`, `\t`, `\x1B`, space,
   `\x7F`, `\x03`) and mode-aware arrows. The daemon's encoder writes those bytes directly
   and carries no keycodes. The unknown-key error string is byte-for-byte the old CLI's, so
   scripts that match on it keep working.
6. **Search.** Neither renderer exposes find, so the daemon implements text search over its
   own grid/scrollback (`packages/daemon/src/term/search.ts`) and publishes the same
   searching/needle/total/selected state as workspace deltas; highlight rendering is a
   client-side reveal. The Kelpi default match colors stay overridable by user config as
   kelpi-config keys.
7. **`cellSize` provenance.** The renderer (client) owns font metrics; the daemon holds
   cols/rows authoritatively (it drives PTY size), while cell-pixel size is client-reported.
   The client is the source of "px per cell" and the daemon the source of "cols × rows".
8. **Multi-client focus.** "Focused pane" is per-client, and workspace focus is
   daemon-canonical (last report wins); notification suppression suppresses only when *some*
   visible client has the pane focused in its active workspace (section 7.4).

**Things deliberately NOT in this subsystem** (specced elsewhere): pane/workspace layout
and split-ratio math, socket wire framing and target resolution
(`resolvePaneTarget`), agent status lifecycle, markdown/diff/web panes, keybinding maps.
This doc covers only what those layers *call into* the surface layer for.

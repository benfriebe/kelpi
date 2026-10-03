# Kelpi architecture

Kelpi is a ground-up port of the Nex terminal multiplexer (macOS SwiftUI + libghostty, at
`/Users/ben/code/nex`) to a daemon + web-client architecture. The goals, in priority order:

1. **Daemon-owned sessions**: PTYs, terminal state, workspaces, and agent tracking live in a
   headless daemon that survives app restarts and app updates. Closing the laptop lid or updating
   the app never kills an agent.
2. **Attach from anywhere**: the desktop app on the same machine, a browser on a remote machine,
   or a phone, initially over localhost and tailnets (Tailscale handles authn + encryption;
   the daemon binds loopback + tailnet interfaces only).
3. **CLI compatibility**: existing `kelpi` command verbs and newline-JSON reply framing remain
   compatible; plugin operations add an explicit envelope. Claude Code / Codex hooks
   (`kelpi event …`) report to the daemon, so agent tracking no longer requires a GUI at all.
4. **Ghostty-quality terminals**: rendering via `ghostty-web` (the libghostty-vt WASM core with an
   xterm.js-compatible API) in the client; server-side terminal state in the daemon so capture,
   scrollback, and reattach work with no client connected.

## Process model

```
┌────────────────────────────── host machine ──────────────────────────────┐
│                                                                          │
│  kelpid (daemon, Node)                                                   │
│  ├─ PTY manager ─────────────────┐  every PTY lives in the terminal host │
│  ├─ Terminal state (headless VT + ring buffer per pane)                  │
│  ├─ Domain store (workspaces, groups, panes, layout, agents, labels)     │
│  ├─ Persistence (SQLite)                                                 │
│  ├─ Control listener: versioned Unix socket (+ optional TCP)             │
│  │    └─ existing kelpi CLI protocol, byte-compatible                    │
│  └─ HTTP+WS listener: 127.0.0.1:<port> (+ tailnet bind)                  │
│       ├─ serves the web client (static assets, versioned with daemon)    │
│       └─ WS: state-sync channel + per-pane PTY streams                   │
│                                   │                                      │
│  terminal host (Node) ◄───────────┘  owns the PTYs (node-pty); outlives  │
│  └─ shells and agents               every daemon restart and app update  │
│                                                                          │
│  Electron shell (desktop)          browser / PWA (remote, mobile)        │
│  └─ loads UI from daemon URL       └─ same UI via tailscale serve        │
│     + tray, dock badge, notifs,                                          │
│       global shortcuts, Finder,                                          │
│       updater (no preload)                                               │
└──────────────────────────────────────────────────────────────────────────┘
```

- **The daemon is the app.** All product logic lives in `kelpid`. Clients are views: they render
  synced state and send commands. The web client is served BY the daemon, so UI and daemon logic
  always update atomically together and remote browsers are version-matched by construction.
- **The Electron shell is deliberately thin**: window chrome, tray, dock badge, desktop
  notifications, global shortcuts, Finder Open With, embedded web panes (WebContentsView + CDP)
  and the updater. It loads the UI from the daemon's localhost URL, and it has **no preload**: the
  window's page and the main process never talk directly. Everything between them (menu commands,
  native pickers, dropped files' paths, the update sheet) goes through the daemon; the directions
  are documented in `packages/daemon/src/ws/desktop.ts`.
- **Shells live in the terminal host**, a small separate process that owns every PTY, so the
  daemon can restart (an app update, a promote, a crash) while every shell keeps running
  ([terminal host](docs/terminal-host.md)).

## Daemon lifecycle

The daemon is **spawned on demand by the app (or CLI), detached**, so it survives its spawner.
It is not a launchd service; its lifetime is tied to the login session (it exits when the login
session ends, and on demand via `kelpid stop`).

- Socket paths are **protocol-versioned**: `~/Library/Application Support/kelpid/run/
  daemon-v<PROTO>.sock` + `.token` + `.pid` on macOS. The current generation is 2.
  A client that speaks proto N connects to `daemon-v<N>.sock`, spawning the daemon if absent.
- **Updates hand the terminals over.** A **handoff** (SIGUSR2) checkpoints each terminal into the
  terminal host, detaches without killing anything and exits; the next daemon reattaches every
  pane to its live PTY, restores its screen and drains the output produced in between, exactly
  once. `kelpid restart`, a promote and an app update all use it:
  - a packaged app stamps its version on the daemon it starts (`KELPID_VERSION`);
  - on launch, it hands off any daemon older than itself, then starts its own
    (`packages/shell/src/daemon.ts`);
  - shells and agents keep running through the update.

  `kelpid stop` (SIGTERM) keeps its meaning: every shell ends. A daemon protocol bump still
  inherits the shells. Only a change to the host's own protocol (`H`) ends the old host's shells,
  once, on the first boot of the new version ([versioning](docs/terminal-host.md#11-versioning)).
  Keep both protocols additive so bumps stay rare.
- The daemon code ships inside the app bundle (and as a standalone package for headless hosts),
  so there is no separate installer.
- A `.token` file (0600) next to the socket authenticates local WS clients; tailnet clients are
  authenticated by being on the tailnet (same trust model as the current TCP transport). The
  check happens in the WS **handshake**, not the HTTP upgrade: a browser cannot see why an
  upgrade was refused (every refusal reaches it as close 1006, indistinguishable from a network
  drop), so an unauthenticated socket is upgraded and then told `rejected` with a reason it can
  show a human. `kelpid url` prints the URL that carries the token.

## Protocols

Three channels, one source of truth:

1. **Control protocol (compat)**: the existing newline-JSON `{"command": …}` protocol on
   the versioned run socket and `/tmp/kelpi.sock` compatibility socket + optional TCP:
   existing commands retain their reply framing (`{"ok":true,…}` / `{"ok":false,"error":…}`)
   and fire-and-forget versus request/response split. See the
   [wire contract](docs/wire-protocol.md) and [handlers](docs/socket-handlers.md).
2. **State sync (WS)**: clients receive a full snapshot on attach, then ordered deltas
   (JSON patches of the domain store). Client sends commands (the same verbs as the control
   protocol, plus UI-only ones like focus). Includes a protocol-version hello; too-old clients
   get a structured "update me" reply.
3. **PTY streams (WS)**: one multiplexed binary channel per client: raw PTY output per attached
   pane (client feeds bytes straight into ghostty-web), input bytes upstream, resize events.
   On attach the daemon replays the pane's state (VT snapshot or ring-buffer tail) before
   going live.

Plugin control requests use `{"command":"plugin","action":"…","text":"<JSON object>"}`,
with explicit reply and stream framing. The same plugin service handles the WebSocket
adapter; installed views use revocable leases rather than the daemon owner token. See the
[wire contract](docs/wire-protocol.md) and [plugin API](docs/plugins.md).

Protocol generation 2 and the default `kelpi-v2.db` database generation preserve plugin pane
identities without letting older binaries restore them as terminals. The default database
is copied once from a sibling `kelpi.db`; custom database paths require the documented
[upgrade/downgrade procedure](docs/plugins.md#database-and-protocol-upgrade).

## Terminal state: daemon-side

Each shell pane = one node-pty process (held by the terminal host) + one server-side terminal state
holder in the daemon + one bounded raw ring buffer (default ~1MB/pane, spooling to disk optional
later). A handoff leaves each terminal's state with the host as a checkpoint, so the next daemon
restores the screen rather than starting blank.

- Server-side state serves: `pane capture` (viewport + scrollback) with no client attached,
  reattach snapshots, and future search.
- Implementation preference: ghostty-vt WASM headless in Node if its API supports feed + text
  dump (research doc decides); fallback: ring buffer + replay into a headless VT
  (`@xterm/headless`) on demand. The choice is enclosed in a `TerminalState` interface so the
  fallback can be swapped without touching callers.
- Sync input (tmux-style) is a daemon concern: the broadcast group logic runs where input lands.

## Client

- **Rendering**: ghostty-web per terminal pane; DOM/CSS grid for the layout tree (ported
  `PaneLayout` algorithms, spec in `docs/pane-layout.md`); markdown/diff panes render
  client-side from daemon-provided file content + change events. CSV panes never move a whole
  file: the daemon indexes it and serves rows by range, and the client draws a virtualised grid
  over the rows on screen (`docs/csv-pane.md`).
- **State**: a thin store that mirrors daemon state (snapshot + deltas). No client-side domain
  logic beyond optimistic echo; every mutation is a command to the daemon.
- **Web panes** (embedded browser): Electron owns the native WebContentsView + CDP page surface.
  Browser/phone and secondary-daemon views can display remote controls and shared browser
  state; the live page remains in its owning native host. Streaming page pixels into a remote
  client is not implemented. Plugin browser chrome uses the same ownership boundary.

## Plugin architecture

The [plugin roadmap](docs/plugin-roadmap.md) tracks the delivered phases and remaining plan.
The workbench resolves bundled feature bindings and installed views through registered
identities and placements. Workspaces, Inspector, desktop toolbar/status and document,
terminal and browser renderers have replacement contracts. Named containers compose views
without changing daemon pane ownership.

Installed HTML views run in opaque-origin frames with a scoped MessageChannel and the public
`@kelpi/plugin-sdk`. Each activated backend runs in a supervised Node child beside its daemon.
Both are explicitly trusted: UI APIs also expose daemon file/process operations, so frame
isolation is not a restricted execution runtime.

Commands, events and versioned services connect plugins to the daemon and selected viewing
window. Native adapters retain PTY/page lifetimes, save authority, focus coordination and
fallback. Local installation copies validated bytes into content-addressed revisions;
guarded updates, history and rollback preserve usable code and compatible saved state.
The [plugin guide](docs/plugins.md) specifies these contracts and their limits.

The command palette and the shared quick pick, input, dialog and notification requests are one
window interaction surface (`packages/client/src/interaction/`), and Settings sections and fields
are one descriptor model (`packages/client/src/settings/`). A plugin view can be selected in
Settings as the presenter for `interaction.palette`, `interaction.prompts`,
`interaction.notifications` or `settings.window`, with the bundled rendering as the recovery
floor; request authority, expiry, validation and drafts stay with the host. Native toasts are host
chrome and are not projected to a presenter.
The bundled terminal mirrors its size owner's replay grid, and the public terminal SDK carries
that grid and size ownership to replacement renderers; the
[terminal guide](docs/plugin-terminals.md#replay-geometry-and-size-ownership) specifies it.

## Repo layout (pnpm workspace)

```
kelpi/
├─ ARCHITECTURE.md
├─ packages/
│  ├─ protocol/         wire + WS message types, protocol version, runtime validation
│  ├─ core/             pure domain logic: layout tree, resolution rules, agent state machine,
│  │                    and the Kelpi mark every surface draws (`core/icon`)
│  ├─ daemon/           kelpid: PTY, VT state, store, sqlite, control + WS servers, static serving
│  ├─ client/           web UI (React + Vite)
│  ├─ plugin-sdk/       standalone plugin runtime helpers and public type declarations
│  ├─ shell/            Electron wrapper
│  └─ cli/              the `kelpi` CLI
└─ …
```

The layout/resolution/agent modules in `packages/core` are pure and unit-tested against
conformance cases extracted from the Swift tests. The separate Node-only
`@kelpi/core/plugin-package` subpath performs bounded filesystem/archive IO shared by the
CLI and daemon; browser code does not import that subpath.

## What is explicitly deferred

- Old and new terminal hosts side by side across a host-protocol bump (today a bump ends the old
  host's shells once; daemon-protocol bumps and ordinary updates already keep them)
- Windows support; Linux is kept compiling but untested in v1
- Streaming native browser page pixels to browser/phone clients (remote controls are supported)
- Ghostty config file compatibility beyond: colors/opacity, font family/size, theme
- Auth beyond token file + tailnet trust (no user accounts)

## Decision log

| Decision | Choice | Why |
| --- | --- | --- |
| Client shell | Electron over Tauri | proven PTY/terminal hosts, single language, CDP for web panes, consistent Chromium everywhere |
| Daemon language | TypeScript/Node | IO-bound workload; shares ghostty-vt WASM + protocol types with client; one language |
| Update model | terminal host + daemon handoff | shells outlive every daemon restart and app update; the host is small and rarely changes, so the daemon updates freely; replaced the earlier side-by-side versioned daemons, which kept old sessions alive but on old code |
| Terminal render | ghostty-web | libghostty-vt fidelity + xterm-compatible API. Each terminal has its own WASM instance and heap; the compiled module and key encoder are shared. Disposing a terminal releases its engine references. See [vendor provenance](vendor/ghostty-web-patched/PROVENANCE.md) and [related merged fixes](docs/plugin-roadmap.md#completed-and-merged). |
| UI delivery | daemon-served, shell loads URL | atomic UI+daemon updates; remote browsers version-matched; thin shell |
| Remote access | bind tailnet + `tailscale serve` | zero auth code; matches existing SSH-tunnel philosophy |

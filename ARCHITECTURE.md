# Kelpi — Architecture

Kelpi is a ground-up port of the Nex terminal multiplexer (macOS SwiftUI + libghostty, at
`/Users/ben/code/nex`) to a daemon + web-client architecture. The goals, in priority order:

1. **Daemon-owned sessions**: PTYs, terminal state, workspaces, and agent tracking live in a
   headless daemon that survives app restarts and app updates. Closing the laptop lid or updating
   the app never kills an agent.
2. **Attach from anywhere**: the desktop app on the same machine, a browser on a remote machine,
   or a phone — initially over localhost and tailnets (Tailscale handles authn + encryption;
   the daemon binds loopback + tailnet interfaces only).
3. **CLI compatibility**: the existing `kelpi` CLI and its newline-JSON wire protocol keep working
   unchanged. Claude Code / Codex hooks (`kelpi event …`) report to the daemon, so agent tracking no
   longer requires a GUI at all.
4. **Ghostty-quality terminals**: rendering via `ghostty-web` (the libghostty-vt WASM core with an
   xterm.js-compatible API) in the client; server-side terminal state in the daemon so capture,
   scrollback, and reattach work with no client connected.

## Process model

```
┌────────────────────────────── host machine ──────────────────────────────┐
│                                                                          │
│  kelpid (daemon, Node)                                                     │
│  ├─ PTY manager (node-pty)          one PTY per shell pane               │
│  ├─ Terminal state (ghostty-vt / headless VT + ring buffer per pane)     │
│  ├─ Domain store (workspaces, groups, panes, layout, agents, labels)     │
│  ├─ Persistence (SQLite)                                                 │
│  ├─ Control listener: unix socket /tmp/nex.sock (+ optional TCP)         │
│  │    └─ existing kelpi CLI protocol, byte-compatible                      │
│  └─ HTTP+WS listener: 127.0.0.1:<port> (+ tailnet bind)                  │
│       ├─ serves the web client (static assets, versioned with daemon)    │
│       └─ WS: state-sync channel + per-pane PTY streams                   │
│                                                                          │
│  Electron shell (desktop)          browser / PWA (remote, mobile)        │
│  └─ loads UI from daemon URL       └─ same UI via tailscale serve        │
│     + tray, dock badge, notifs,                                          │
│       global shortcuts, Finder                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

- **The daemon is the app.** All product logic lives in `kelpid`. Clients are views: they render
  synced state and send commands. The web client is served BY the daemon, so UI and daemon logic
  always update atomically together and remote browsers are version-matched by construction.
- **The Electron shell is deliberately thin** and rarely updated: window chrome, tray, dock badge,
  desktop notifications, global shortcuts, Finder Open With, and embedded web panes
  (WebContentsView + CDP). It loads the UI from the daemon's localhost URL.

## Daemon lifecycle

The daemon is **spawned on demand by the app (or CLI), detached**, so it survives its spawner.
It is not a launchd service; its lifetime is tied to the login session (it exits when the login
session ends, and on demand via `kelpid stop`).

- Socket paths are **protocol-versioned**: `~/Library/Application Support/NewKelpi/daemon/
  daemon-v<PROTO>.sock` + `.token` + `.pid`. A client that speaks proto N connects to
  `daemon-v<N>.sock`, spawning the daemon if absent.
- **App/daemon updates = side-by-side versioning, not hot handoff.** When a protocol bump ships,
  new clients spawn a new daemon on the new socket; the old daemon keeps running, still owning its
  sessions, until they drain. Nothing is ever killed by an update. (A ring-buffer PTY broker that
  lets new daemons adopt old sessions is a possible later upgrade — deliberately deferred; keep
  the protocol additive within a generation so bumps are rare.)
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

1. **Control protocol (compat)** — the existing newline-JSON `{"command": …}` protocol on
   `/tmp/nex.sock` + optional TCP, byte-compatible with the current CLI: same commands, same
   reply framing (`{"ok":true,…}` / `{"ok":false,"error":…}`), same fire-and-forget vs
   request/response split. Spec: `docs/current/wire-protocol.md` + `socket-handlers.md`.
2. **State sync (WS)** — clients receive a full snapshot on attach, then ordered deltas
   (JSON patches of the domain store). Client sends commands (the same verbs as the control
   protocol, plus UI-only ones like focus). Includes a protocol-version hello; too-old clients
   get a structured "update me" reply.
3. **PTY streams (WS)** — one multiplexed binary channel per client: raw PTY output per attached
   pane (client feeds bytes straight into ghostty-web), input bytes upstream, resize events.
   On attach the daemon replays the pane's state (VT snapshot or ring-buffer tail) before
   going live.

## Terminal state: daemon-side

Each shell pane = one node-pty process + one server-side terminal state holder + one bounded raw
ring buffer (default ~1MB/pane, spooling to disk optional later).

- Server-side state serves: `pane capture` (viewport + scrollback) with no client attached,
  reattach snapshots, and future search.
- Implementation preference: ghostty-vt WASM headless in Node if its API supports feed + text
  dump (research doc decides); fallback: ring buffer + replay into a headless VT
  (`@xterm/headless`) on demand. The choice is enclosed in a `TerminalState` interface so the
  fallback can be swapped without touching callers.
- Sync input (tmux-style) is a daemon concern: the broadcast group logic runs where input lands.

## Client

- **Rendering**: ghostty-web per terminal pane; DOM/CSS grid for the layout tree (ported
  `PaneLayout` algorithms, spec in `docs/current/pane-layout.md`); markdown/diff panes render
  client-side from daemon-provided file content + change events.
- **State**: a thin store that mirrors daemon state (snapshot + deltas). No client-side domain
  logic beyond optimistic echo; every mutation is a command to the daemon.
- **Web panes** (embedded browser): Electron-only feature via WebContentsView + CDP (capture,
  console streaming, element picker get CDP-native implementations). In a plain browser client,
  web panes render as "open externally" placeholders initially.

## Repo layout (pnpm workspace)

```
new_nex/
├─ ARCHITECTURE.md, PLAN.md
├─ docs/
│  ├─ current/          specs of the existing app (port contracts)
│  └─ research/         stack + ghostty-web research
├─ packages/
│  ├─ protocol/         wire + WS message types, protocol version, zod schemas
│  ├─ core/             pure domain logic: layout tree, resolution rules, agent state machine
│  ├─ daemon/           kelpid: PTY, VT state, store, sqlite, control + WS servers, static serving
│  ├─ client/           web UI (React + Vite)
│  ├─ shell/            Electron wrapper
│  └─ cli/              TS rewrite of the kelpi CLI (phase 2; Swift CLI keeps working meanwhile)
└─ …
```

`packages/core` is deliberately pure (no IO) so the layout/resolution/agent logic is unit-tested
against conformance cases extracted from the Swift tests.

## What is explicitly deferred

- PTY broker / cross-version session adoption (side-by-side daemons are the v1 answer)
- Windows support; Linux is kept compiling but untested in v1
- Browser-client web panes (Electron-only in v1)
- Ghostty config file compatibility beyond: colors/opacity, font family/size, theme
- Auth beyond token file + tailnet trust (no user accounts)

## Decision log

| Decision | Choice | Why |
| --- | --- | --- |
| Client shell | Electron over Tauri | proven PTY/terminal hosts, single language, CDP for web panes, consistent Chromium everywhere |
| Daemon language | TypeScript/Node | IO-bound workload; shares ghostty-vt WASM + protocol types with client; one language |
| Update model | side-by-side versioned daemons | zero-risk updates without FD-handoff engineering; old sessions never die |
| Terminal render | ghostty-web | libghostty-vt fidelity + xterm-compat API; faster than xterm.js. **One WASM instance is shared by every terminal in the tab**, which is what the client's engine-startup serialization, poisoned-engine containment and per-pane retry are for — `packages/client/src/terminal/`, `docs/audit/renderer-start-flake/` |
| UI delivery | daemon-served, shell loads URL | atomic UI+daemon updates; remote browsers version-matched; thin shell |
| Remote access | bind tailnet + `tailscale serve` | zero auth code; matches existing SSH-tunnel philosophy |

# New Nex

A ground-up port of [Nex](https://github.com/benfriebe/nex) — the macOS terminal multiplexer built
on libghostty — to a **daemon + web client** architecture.

The daemon (`nexd`) owns the sessions: PTYs, terminal state, workspaces, layouts and agent
tracking live in a headless Node process that survives app restarts and updates. Clients (an
Electron shell on the desktop, or any browser over a tailnet) attach to it and render. The
existing `nex` CLI and the Claude Code / Codex hooks keep working unchanged — the daemon speaks
the same newline-JSON control protocol on the same socket.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the process model and [`PLAN.md`](PLAN.md) for the
milestone plan. Behavioural contracts for every subsystem live in [`docs/current/`](docs/current).

## Status

Milestone 2 — the daemon — is in progress. `nexd` boots, restores persisted workspaces, spawns
PTYs, serves the control protocol and exposes an HTTP + WebSocket endpoint. The web client
(M3) and the Electron shell (M4) are not built yet, so `http://127.0.0.1:<port>` currently
answers with a "client not built" page while `/healthz`, the control socket and `/ws` all work.

## Quickstart

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm --filter @nex/daemon build        # esbuild → packages/daemon/dist/nexd.js
```

Start the daemon. It detaches by default, so it outlives the shell that started it:

```bash
packages/daemon/dist/nexd.js start
packages/daemon/dist/nexd.js status
```

```
nexd is running (pid 77182)
  version: 0.1.0 (build 1)
  protocol: 1
  control: /tmp/nex.sock
  discovery: ~/Library/Application Support/nexd/run/daemon-v1.sock
  http: http://127.0.0.1:59329
  url: http://127.0.0.1:59329/?token=8f3c…
  run dir: ~/Library/Application Support/nexd/run
```

Open the client with the `url` line, never the bare `http:` one — the WebSocket handshake is
gated on the run dir's token, so an origin without `?token=` loads the page and is then refused
(the client says so and stops, rather than retrying). `nexd url` prints exactly that line and
nothing else, so it pipes:

```bash
open "$(packages/daemon/dist/nexd.js url)"
```

The token is remembered in `localStorage` and stripped from the address bar on arrival, so
later visits to the bare origin work — until the daemon's run dir is recreated, at which point
open a fresh `nexd url` again.

`--foreground` runs it in the current process instead (what a supervisor or a container wants),
and `nexd stop` shuts it down cleanly — pending state is flushed to SQLite before the PTYs are
killed.

### Talking to it

Anything that speaks the control protocol works, including `nc`:

```bash
echo '{"command":"ping"}'           | nc -U /tmp/nex.sock
echo '{"command":"workspace-list"}' | nc -U /tmp/nex.sock
```

The shipped Swift CLI (`/Applications/Nex.app/Contents/Helpers/nex`) talks to whatever
`NEX_SOCKET` names. Point it at a development daemon over TCP:

```bash
# daemon: listen on loopback TCP as well as the unix socket
NEXD_TCP_PORT=19400 packages/daemon/dist/nexd.js start

# CLI: reach it over that port
NEX_SOCKET=tcp:127.0.0.1:19400 nex pane list
NEX_SOCKET=tcp:127.0.0.1:19400 nex pane send --target worker-1 "echo hello"
```

The same variable is how a dev container or a remote agent reaches the daemon
(`NEX_SOCKET=tcp:host.docker.internal:19400`, or an SSH reverse tunnel).

### Running beside the real Nex.app

The production control socket is `/tmp/nex.sock`, which the Swift app owns while it is running —
`nexd` refuses to steal a live socket. During development, give the daemon its own endpoints:

```bash
NEXD_SOCKET_PATH=/tmp/nexd-dev.sock \
NEXD_TCP_PORT=19400 \
NEXD_DB_PATH=~/.local/share/nexd-dev/nex.db \
NEXD_RUN_DIR=~/.local/state/nexd-dev \
packages/daemon/dist/nexd.js start --foreground
```

`NEX_SOCKET` only selects a TCP endpoint (absent means the hardcoded `/tmp/nex.sock`), so TCP is
how the shipped CLI reaches a development daemon:

```bash
NEX_SOCKET=tcp:127.0.0.1:19400 nex workspace list
```

A development daemon has its own run dir, and therefore its own token — so ask that daemon for
its URL rather than reusing one from another instance:

```bash
NEXD_RUN_DIR=~/.local/state/nexd-dev open "$(packages/daemon/dist/nexd.js url)"
```

`nexd --help` lists every environment override (run dir, control socket, TCP port, HTTP
host/port, database, config file, client build directory, log file).

## Repository layout

```
packages/
├─ protocol/   wire message types, type-strict decode, reply allowlist, WS protocol
├─ core/       pure domain: layout tree, resolvers, agent state machine, env, config, codecs
├─ daemon/     nexd: store, PTY manager, terminal state, control + HTTP/WS servers, SQLite
├─ client/     web UI (M3)
├─ shell/      Electron wrapper (M4)
└─ cli/        TypeScript rewrite of the nex CLI (M8)
```

## Development

```bash
pnpm check          # typecheck + the full test suite
pnpm test           # vitest across every package
pnpm typecheck      # tsc -b protocol core daemon
pnpm --filter @nex/daemon watch    # rebuild the bundle on change
```

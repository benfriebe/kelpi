# Terminal Host: shells that outlive the daemon

Status: design for #273. This document specifies moving PTY ownership out of `kelpid` into a small,
long-lived **terminal host** process, so the daemon can restart (an app update, a local promote, a
crash) while every shell keeps running.

## 1. Why, and what changes

Today each pane's shell is a child of the daemon. `stop()` kills every PTY (`pty.killAll()`, SIGHUP
then SIGKILL), and even a SIGKILL'd daemon takes its shells with it, because closing a PTY master
hangs up the child's session. Nothing about a terminal is saved: the next daemon spawns fresh
shells at each pane's last cwd and types `claude --resume <id>` where a session was tracked. Dev
servers, builds, ssh and Codex sessions are lost, and a promote kills the session that ran it.

After this change:

- The **host** owns the PTYs and nothing else. It is a separate process that survives the daemon.
- The **daemon** reaches it through the existing `PtySpawner` / `PtyProcessHandle` seam
  (`packages/daemon/src/pty/types.ts`), so the PTY manager, the spawn gate, the terminal service,
  the stream hub and plugins keep working unchanged.
- A **handoff restart** (new) saves each terminal's emulator state into the host, detaches without
  killing, and exits. The next daemon reattaches every pane to its live PTY, restores the saved
  state, and drains the output produced in between, exactly once.
- A **stop** keeps today's meaning: every shell dies and the host exits.

Non-goals for this change: surviving a crash of the host itself (the shells die, as they do when
the daemon dies today; the daemon respawns them, section 8.2), running two host protocol versions
side by side (section 11), and periodic crash-recovery checkpoints (section 8.1).

## 2. Processes

```
Kelpi.app ──spawns──▶ kelpid (daemon) ──spawns, detached──▶ terminal host ──▶ shells
                          ▲  token-authenticated unix socket  │
                          └───────────────────────────────────┘
```

- The daemon launches the host detached (`spawnDetached`, the same helper `kelpid start` uses) with
  its own `process.execPath` (the bundled Node) and the host entry, and adopts a host that is
  already running. One host per run dir, like the daemon.
- Run-dir files, next to the daemon's `daemon-v<N>.*`: `terminal-host-v<H>.sock`, `.token`
  (0600, 64 hex chars) and `.pid` (a JSON record with pid, start time, protocol, and the runtime
  directory it was launched from). `H` is the host protocol version, starting at 1.
- The host is a single esbuild bundle (`dist/terminal-host.js`, beside `kelpid.js` and
  `runner.mjs`) that loads node-pty from the payload's `node_modules`, exactly as the daemon does.

## 3. Host protocol

A deliberately small, stable protocol, because the host is meant to be updated rarely.

**Framing.** Length-prefixed frames on the unix socket: `u32 length (big-endian) | u8 type |
payload`. Control frames carry UTF-8 JSON; `data` frames carry a small binary header and raw
bytes, so terminal output is never base64'd or JSON-escaped.

**Handshake.** The first frame on a connection is `hello { protocol, token }`. The host answers
`welcome { protocol, hostVersion, pid, terminals: TerminalInfo[] }` or `refused { reason }` and
closes. `TerminalInfo` = `{ tid, key, pid, cols, rows, produced, checkpoint: { offset } | null,
exited: { code, signal } | null }`. `key` is the pane id; `tid` is the host's own incarnation id,
so a pane re-spawned under the same pane id never receives a stale exit.

**One attached daemon at a time.** A new authenticated `hello` supersedes the current connection
(`superseded` is sent, then that socket is closed). The daemon's own single-instance rule (the
busy run-dir socket) is what prevents two live daemons.

| daemon → host | meaning |
|---|---|
| `spawn { tid, key, file, args, cwd, env, cols, rows, name, fallbackFile }` | fully resolved request, as `PtySpawnRequest` today; `fallbackFile` replaces the manager's retry-with-`/bin/sh` |
| `write { tid } + bytes` | input |
| `resize { tid, cols, rows }` | |
| `pause { tid }` / `resume { tid }` | the terminal service's parse-backlog backpressure |
| `kill { tid, signal }` | the manager keeps its SIGHUP → 300 ms → SIGKILL escalation |
| `attach { tid }` | start streaming a terminal adopted from a previous daemon (section 7) |
| `hold` | stop forwarding output; retain it (section 6) |
| `checkpoint { tid, offset } + blob` | opaque emulator state, valid as of byte `offset` |
| `detach { reason: 'handoff' }` | keep every terminal, expect a successor |
| `shutdown` | kill every terminal, then exit |

| host → daemon | meaning |
|---|---|
| `spawned { tid, pid }` / `spawn-failed { tid, message }` | |
| `data { tid, offset } + bytes` | `offset` = position of the first byte in that terminal's output stream |
| `exit { tid, code, signal }` | |
| `attached { tid, checkpoint: { offset } + blob \| null, from, gap }` | then `data` from `from` |
| `held` | every `data` frame sent before the hold is on the wire before this |

Writes are ordered by the socket, so input that follows a `spawn` needs no queueing on either side.

## 4. Offsets, retention and exactly-once

- The host counts every byte it reads from each PTY (`produced`), and each `data` frame carries its
  starting offset.
- The daemon counts what it has fed into that pane's `@xterm/headless` terminal (`fed`). A
  checkpoint names `fed` after a `flush`, so the blob and the offset describe the same instant.
- The host keeps a per-terminal **retention ring** (default 4 MiB) of recent output, indexed by
  offset.
  - While a daemon is attached, the ring is trimmed to its size as usual.
  - Once a terminal has a checkpoint and no daemon is streaming it, the host must retain every byte
    after the checkpoint offset. When the ring would overflow, the host **pauses that PTY** instead
    of dropping output. A noisy child blocks for the few seconds of a restart; nothing is lost.
- On `attach`, the host streams from the checkpoint offset if it still holds it (`gap: false`),
  otherwise from the oldest byte it has (`gap: true`, section 8.1).

## 5. Daemon integration

- **`hostPtySpawner`** implements `PtySpawner` over a `TerminalHostClient`. The returned handle
  sends frames and surfaces `data` / `exit` through the manager's existing listeners. `pid` is 0
  until `spawned` arrives; nothing in production reads it synchronously after `spawn` (only
  `KelpiPtyManager.pid`, which is diagnostic).
- **`PtyManager.adopt(paneID, handle)`** (new) registers a handle that already exists, wiring
  `onData` / `onExit` exactly as `spawn` does. `withSpawnGate` passes it through.
- **`TerminalStateService.restore(paneID, blob)`** (new) writes the saved VT stream into a freshly
  attached pane terminal and restores the state that lives outside xterm (kitty keyboard flags and
  stacks for both screens, mouse format), so the stream hub's next snapshot is the same screen.
- **Modes.** `createDaemon({ terminalHost })`: `'external'` (the host process) is what `kelpid
  start` uses; tests that build a daemon directly keep the in-process `nodePtySpawner` unless they
  opt in. `KELPID_TERMINAL_HOST=0` forces in-process for `kelpid start` as an escape hatch.

**The blob** is JSON, versioned: `{ v: 1, cols, rows, snapshot, kitty, mouseFormat }`, where
`snapshot` is the serialize-addon VT stream the stream hub already replays into clients (screen,
scrollback, alternate screen, DECCKM, bracketed paste, mouse tracking). It lives only in the host's
memory, never on disk, because scrollback can hold secrets.

## 6. Handoff (the old daemon)

Triggered by `SIGUSR2` (section 10). In order:

1. Everything `stop()` does before `killAll`: flush content, set `stopping`, unsubscribe the store
   and PTY listeners from pane-closing effects, shut graft and plugins down, `persistence.flush()`.
2. Send `hold`. Keep feeding any `data` that arrives until `held`.
3. For each live pane: `term.flush`, serialize, send `checkpoint { tid, offset: fed } + blob`.
4. Send `detach { reason: 'handoff' }` and close the socket. Do **not** call `killAll`.
5. The rest of `stop()`: geometry flush, listeners, persistence close, run files. Exit 0.

If the host is unreachable at step 2, fall back to a normal stop (the shells are gone anyway).

## 7. Reattach (the next daemon)

In `start()`, before `spawnRestoredPanes`:

1. Connect to the host, launching one if none answers. `welcome.terminals` lists what survived.
2. For each restored **shell** pane whose id matches a live terminal: `term.attach(pane, cols,
   rows)` at the host's size, `attach { tid }`, then:
   - `gap: false` with a blob: `term.restore(pane, blob)`, then feed the drained output as usual.
   - otherwise: section 8.1.
   - `pty.adopt(pane, handle)`.
3. Adopted panes skip the spawn gate and resume typing: their agent is still running. Their
   `ResumeTuple` (session id, kind, profile) goes back into the store so the header and status
   reflect the live session until its next hook event.
4. Panes with no live terminal take today's path (fresh spawn, resume typing).
5. Host terminals with no matching pane are killed (the pane was closed while no daemon ran).

Clients connect afterwards and attach through the stream hub as today; the snapshot they receive is
the restored screen.

## 8. Failure paths

### 8.1 Daemon crash (no checkpoint)

The host notices the socket close and keeps every terminal. The next daemon reattaches as in
section 7, but with `gap: true` or no blob. It feeds the host's retained tail into a fresh terminal
(best effort: the scrollback may start mid-screen), then nudges each terminal with a one-column
resize and back, so full-screen programs repaint. Periodic checkpoints for crashes are left for
later.

### 8.2 Host crash (the daemon is alive)

Every shell dies with the host. The client sees the socket close and reports `hostLost(paneIDs)`
instead of per-terminal exits, so panes are **not** closed. The daemon relaunches the host,
disposes and re-attaches each affected pane terminal, and respawns it through the boot-restore path
(fresh shell, resume typing), exactly what a daemon restart does today.

### 8.3 Spawn failure

The host tries `file`, then `fallbackFile`, and reports `spawn-failed` if both fail; the handle
emits a synthetic exit of -1, matching `reportSpawnFailure` today.

## 9. Lifecycle

- **Launch.** Only the daemon launches a host, and only when none answers on the run-dir socket.
- **Exit.** The host exits after `shutdown`, on SIGTERM/SIGHUP (it hangs up every PTY first), or
  when it has no terminals and no attached daemon for 5 s.
- **Per-version runtime copy.** A packaged daemon (its entry is inside `*.app/Contents/Resources/`)
  copies the host runtime (`terminal-host.js`, `package.json`, node-pty's `lib/` and prebuilds)
  into `~/Library/Application Support/kelpid/terminal-host/<content-hash>/` and launches the host
  from there, so an app update never replaces the files under a running host, including the
  `spawn-helper` it execs for every new terminal. The Node binary is the one exception: it is only
  executed at launch, and a running process keeps its mapped image. Development runs launch in
  place. Copies are pruned to the newest three plus the one the live host's pid record names.

## 10. Triggers

- **`SIGTERM` / `kelpid stop`**: a full stop, as today: `killAll`, then `shutdown` to the host.
- **`SIGUSR2`**: handoff and exit (section 6). The successor is started by whoever sent it.
- **`kelpid restart`** (new): `SIGUSR2`, wait for the old daemon to exit, then `kelpid start`.
- **`scripts/self-upgrade.mjs`**: the restarter sends the daemon `SIGUSR2` instead of `SIGTERM`,
  then relaunches the app, whose daemon reattaches. The pane that ran the promote survives it.
- **The app updater (#272)** will use the same `SIGUSR2`.

**The pane route.** Every shell carries `KELPI_SOCKET=tcp:127.0.0.1:<port>`, the daemon's
pane-route listener, which is ephemeral today. A surviving shell would point at a dead port after
a restart, breaking agent hooks and `kelpi` commands inside it. The daemon now saves that port
beside the HTTP port file (`daemon-v<N>.route-port`) and asks for it again on boot, falling back
to an ephemeral port (with a warning) only if it is taken.

## 11. Versioning

- `H` names the socket, so daemons only ever talk to a host of their own protocol.
- A daemon that finds a live host of another version (another `terminal-host-v*.sock` answering)
  logs it and leaves it alone; its shells keep running until they exit. Shipping a new `H` requires
  its own migration (either restart the old host with a warning, or route old terminals to it); that
  is out of scope until a second version exists.
- The checkpoint blob carries its own `v`; a daemon that cannot read a blob treats the terminal as
  `gap: true`.

## 12. Security

- The socket and token are 0600 in the 0700 run dir, and the token is compared in constant time.
  A connection that does not authenticate within 2 s is closed.
- The host inherits no pane environment of its own: every spawn carries its fully resolved env.
- Blobs stay in memory.

## 13. Tests

- **Unit:** framing (split and coalesced frames), the retention ring (offsets, trim, hold-and-pause
  policy), the handshake and supersede rules, blob encode/decode.
- **Real PTY, host alone:** spawn / write / read / resize / pause / resume / kill / exit; detach and
  attach with a checkpoint delivers output produced during the gap exactly once; a flood while
  held pauses the PTY rather than dropping bytes.
- **Daemon integration:** a daemon with an external host: create a pane, print a marker, enter the
  alternate screen with kitty keyboard flags, hand off, start a second daemon: same shell pid, the
  snapshot shows the marker and the alternate screen, kitty flags restored, output printed during
  the gap appears once; a normal stop still kills the shells and the host exits; a host crash
  respawns shells without closing panes; the pane route port survives.
- **CLI:** `kelpid restart`.
- **Scenario and packaged smoke:** a pane's pid survives `SIGUSR2` plus relaunch.

## 14. Implementation order

1. Host process: protocol, retention ring, server, client library, with unit and real-PTY tests.
2. Daemon on the host: `hostPtySpawner`, launch and adopt, host-loss handling, pane-route port,
   bundling and staging, the per-version runtime copy. Behaviour otherwise unchanged.
3. Handoff and reattach: `SIGUSR2`, checkpoints, `adopt`, `restore`, boot integration, `kelpid
   restart`.
4. Promote script, scenario, packaged smoke, docs.

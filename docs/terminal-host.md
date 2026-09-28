# Terminal Host: shells that outlive the daemon

This document specifies the **terminal host** (#273): a small, long-lived process that owns every
PTY, so the daemon can restart (an app update, a local promote, a crash) while every shell keeps
running.

Implementation index:

- `packages/daemon/src/host/protocol.ts`: the wire format and message validation
- `packages/daemon/src/host/retention.ts`: per-terminal output addressed by offset
- `packages/daemon/src/host/server.ts`: the host (terminals, attach rules, hold, checkpoints)
- `packages/daemon/src/host/client.ts`: the daemon's side; each terminal is a `PtyProcessHandle`
- `packages/daemon/src/host/slot.ts`: the spawner the PTY manager holds (queues until connected)
- `packages/daemon/src/host/launch.ts`, `entry.ts`, `main.ts`: run-dir files, launch, process entry
- `packages/daemon/src/host/runtime.ts`: the per-version runtime copy for packaged apps
- `packages/daemon/src/host/blob.ts`: the checkpoint a handoff leaves with the host
- `packages/daemon/src/boot/compose.ts`: connect, adopt, hand off, host loss
- `packages/daemon/src/term/service.ts`: `checkpointAsync`, `restore`, `markReplay`

## 1. Why, and what changed

Before the host, each pane's shell was a child of the daemon. `stop()` killed every PTY, and even
a SIGKILL'd daemon took its shells with it, because closing a PTY master hangs up the child's
session. Nothing about a terminal was saved: the next daemon spawned fresh shells and typed
`claude --resume <id>` where a session was tracked. Dev servers, builds, ssh and Codex sessions
were lost, and a promote killed the session that ran it.

Now:

- The **host** owns the PTYs and nothing else. It survives the daemon.
- The **daemon** reaches it through the existing `PtySpawner` / `PtyProcessHandle` seam, so the
  PTY manager, the spawn gate, the terminal service, the stream hub and plugins are unchanged.
- A **handoff** (SIGUSR2) checkpoints each terminal into the host, detaches without killing, and
  exits. The next daemon reattaches every pane to its live PTY, restores the saved state, and
  drains the output produced in between, exactly once.
- A **stop** (SIGTERM, `kelpid stop`) keeps its meaning: every shell dies and the host exits.

`kelpid start` runs the host by default. `KELPID_TERMINAL_HOST=0` keeps PTYs in-process (shells then
die with the daemon, as before). Daemons built directly by tests run in-process unless they pass
`terminalHost`.

## 2. Processes and files

```
Kelpi.app ──spawns──▶ kelpid ──spawns, detached──▶ terminal host ──▶ shells
                        ▲  token-authenticated unix socket  │
                        └───────────────────────────────────┘
```

- Only a daemon launches a host, and only once it owns its run dir (its run-dir socket is bound):
  attaching first could take the host from a live daemon. It adopts a host that already answers.
- Run-dir files: `host-v<H>.sock`, `.token` (0600) and `.pid` (a JSON record with the pid, start
  time, protocol, version and the runtime directory). The names are short on purpose: sandbox run
  dirs sit near macOS's 104-byte socket-path limit. `H` is the host protocol version (1).
- The host is launched from `/` (it outlives worktrees) with a minimal environment: every spawn
  carries its own fully resolved env. It logs to `<run dir>/terminal-host.log`.
- The host is `dist/terminal-host.js`, bundled beside `kelpid.js` with the same node-pty. A
  packaged daemon launches it from a per-version copy (§9).

## 3. Protocol

Length-prefixed frames on the unix socket: `u32 length | u8 type | payload`. Control frames are
JSON; `write` and `data` carry a small binary header and raw bytes; `checkpoint` and `attached`
are `u32 jsonLength | json | blob`.

**Handshake.** `hello { protocol, token, mode }` → `welcome { protocol, hostVersion, pid, terminals }`
or `refused`. The token is compared in constant time; an unauthenticated connection is closed
after 2 s. `mode: 'probe'` reads the welcome without taking over. `terminals` lists
`{ tid, key, pid, cols, rows, produced, checkpointOffset, exited }`, where `key` is the pane id
and `tid` the host's incarnation id (a UUID), so a pane re-spawned under the same id never gets a
stale exit.

**One attached daemon.** A new `attach` hello supersedes the current daemon (`superseded`, then
the socket closes), except while the current one is between `hold` and `detach`: the newcomer
waits until the handoff finishes (at most 15 s), so a successor launched early cannot cut it short.

| daemon → host | |
|---|---|
| `spawn { tid, key, file, args, cwd, env, cols, rows, name, fallbackFile? }` | the host tries `fallbackFile` (`/bin/sh`) if `file` fails |
| `write` / `resize` / `pause` / `resume` / `kill { signal }` | |
| `attach { tid }` | stream a terminal a previous daemon left (§7) |
| `hold` | stop streaming and retain everything (§6) |
| `checkpoint { tid, offset } + blob` | emulator state as of byte `offset` |
| `detach` | keep every terminal for a successor |
| `forget { tid }` | no pane for it: hang it up if live, and drop it |
| `shutdown` | hang up every terminal, then exit |

| host → daemon | |
|---|---|
| `spawned { tid, pid, warning? }` / `spawn-failed { tid, message }` | a failed spawn becomes exit -1 |
| `data { tid, offset } + bytes` | `offset` = position of the first byte |
| `exit { tid, code, signal }` | |
| `attached { tid, checkpointOffset, from, until, gap, cols, rows } + blob` | then `data` from `from`; `until - from` is replay |
| `held` | every `data` sent before the hold precedes it |

## 4. Offsets, retention and exactly-once

- The host numbers every byte each PTY produces. The daemon's handle tracks the offset just past
  the last byte it delivered, which (with the manager feeding the terminal service synchronously)
  is exactly what the emulator has been fed.
- Per terminal, the host keeps a 4 MiB retention ring. `hold` pins it at the bytes produced so far
  without dropping anything; a `checkpoint` pins it at its offset and drops what it covers. Nothing
  after a pin is evicted: when pinned output outgrows the ring, the host **pauses that PTY**
  instead. A noisy child blocks for the second or two of a handoff; no byte is lost.
- `attach` replays from the checkpoint when the ring still holds it (`gap: false`), otherwise from
  the oldest byte it has (`gap: true`).

## 5. The daemon side

- `HostSpawnerSlot` backs the PTY manager. Before the host connects, a spawn gets a pending handle
  whose calls are queued and replayed once bound, so a `pane-create` racing the boot is not lost.
  If no host can be started, the slot runs PTYs in-process with a loud warning.
- `PtyManager.adopt(pane, handle)` registers a live terminal; `forget(pane)` drops one without an
  exit (host loss); `pid()` reads live and is never 0 (`kill(0)` would hit the process group).
- **Checkpoint** (`TerminalStateService.checkpointAsync`): the serialize-addon stream the stream hub
  already replays into clients (screen, scrollback, alternate screen, DECCKM, bracketed paste,
  mouse tracking), plus what it omits: the scroll region with the cursor put back after DECSTBM's
  homing, and a hidden cursor. Kitty flags and stacks (both screens) and the mouse format travel
  beside it. If the parser is mid-sequence or holds half a UTF-8 character, the checkpoint steps
  back to where that sequence began (`tailBack`); replaying the start of a sequence is harmless.
- **The blob** (`host/blob.ts`) is `u32 headerLength | header JSON | snapshot`, header
  `{ v: 1, cols, rows, kitty, mouseFormat, title }`. The title rides along because the store does
  not persist it. The blob lives only in the host's memory, never on disk.
- **Restore** writes the snapshot through the terminal's normal write queue, before anything fed
  afterwards, with every side effect suppressed, then puts the kitty and mouse state back.
- **Replay modes.** Each queued write carries a mode that the parser hooks read while xterm parses
  it: live (everything runs); replay (no kitty query reply: the asking application timed out long
  ago and a late answer would land at its prompt as typed text); quiet replay (also no OSC 9/777
  notification and no OSC 52 clipboard write, for bytes a previous daemon may already have acted
  on). `markReplay(pane, bytes, quiet)` marks the next bytes fed.

## 6. Handoff (the old daemon)

SIGUSR2 or `Daemon.handoff()`. The order is what keeps a pane from coming back wrong:

1. Flush editor buffers.
2. A daemon still restoring finishes first (at most 10 s): otherwise panes it has not saved would be
   ended as orphans by the successor, and resumes it has not typed would be lost.
3. Close the control, compat and WS listeners: no command, hook event or client arrives mid-way.
4. `hold`. Until the host confirms, output is still fed and exits still close their panes (and are
   saved), so a shell that exits now is not resurrected.
5. Only then drop the store and PTY listeners and dispose the services.
6. Checkpoint every hosted terminal at `received - tailBack`, then `detach`.
7. Unwind graft sessions exactly as a stop does (leaving the breadcrumb would greet every update
   with the orphan-recovery banner; surviving shells then see the parent checkout), dispose
   plugins, flush and close persistence, exit.

A daemon with no host (in-process mode, or the host is gone) treats SIGUSR2 as a clean full stop.
The pid record advertises `handoff: true`: a daemon from before the host dies on an unhandled
SIGUSR2 without saving, so restarters send those SIGTERM.

## 7. Adoption (the next daemon)

In `start()`, after connecting and before the boot restore:

1. For each restored **shell** pane, the newest live terminal with its key is adopted. Exited
   terminals, older duplicates and terminals with no pane are forgotten (ended).
2. Adopting a pane: `term.attach` at the host's size, `attach`, restore the blob if there was a
   clean checkpoint, mark the replayed bytes (`until - from`, quiet when there was no clean
   checkpoint), then `pty.adopt`, which delivers the queued replay through the normal path.
3. Adopted panes skip the spawn gate and are removed from the resume tuples: typing
   `claude --resume` into a live agent would land in its session. Their agent state (session id,
   status, start time, background tasks), which the load reset cleared, is put back
   (`pane-agent-state-restored`), and so is the title.
4. Everything else takes the usual path: fresh shell at the last cwd, resume typed.

Clients connect afterwards and attach through the stream hub as ever; their snapshot is the
restored screen.

**The pane route.** Every shell carries `KELPI_SOCKET=tcp:127.0.0.1:<port>`, the daemon's
ephemeral pane-route listener. The daemon records it in `<run dir>/pane-route.port` (deliberately
not named by the daemon protocol, so a protocol bump still inherits the shells) and asks for the
same port on boot, falling back to a fresh one with a warning if it is taken. The re-pinned port
is still reported as the internal route, not as a configured `tcp-port`. Inside a pane, the
`kelpi` CLI retries a refused pane-route connection for up to 5 s (`KELPI_ROUTE_RETRY_MS`), so an
agent hook fired during a handoff is not lost.

## 8. Failure paths

- **Daemon crash.** The host keeps every terminal. The next daemon adopts them from the retained
  tail (`gap: true`): best effort, fed as a quiet replay, then a repaint nudge that bounces only the
  kernel window size by one column (the host resizes the PTY; the daemon's emulator is left alone,
  since shrinking it would trim scrollback). Periodic crash checkpoints are future work.
- **Host crash.** Every shell dies with it. The client reports the connection as lost instead of
  emitting exits, so no pane closes. The daemon ends a host that is alive but dropped it,
  relaunches one, and respawns and resumes the affected panes exactly as a restart used to.
  Attached clients keep their old screen and receive the new shell's output; there is no pane-wide
  re-seed yet.
- **Superseded.** Another daemon attached to this run dir's host. This daemon stops using it and
  runs any new terminal in-process; it never reconnects (two daemons would otherwise ping-pong).
- **Spawn failure.** The host tries the fallback shell; if that fails the handle exits with -1, as
  the manager always reported a failed spawn. The first failure is reported through `onError`.
- **Other host versions.** A daemon ends any live host of another protocol (SIGTERM, which makes it
  hang up its terminals) before restoring panes, and an in-process daemon ends any host at all, so
  no pane ever runs two shells.

**Not carried across a restart** (as before the host): parked shell panes and markdown panes in
external-editor mode are not persisted, so the successor finds no pane for their terminals and
ends them. OSC 8 hyperlinks in content from before the handoff are not in the snapshot.

## 9. Lifecycle

- **Exit.** On `shutdown`; on SIGTERM, SIGINT or SIGHUP (it hangs up every PTY first, then SIGKILLs
  what ignored it); when its socket file disappears (a deleted run dir, a test sandbox); after 5 s
  with no terminals and no daemon; or, while it only holds exits no daemon has heard about, after
  10 minutes. A launched host nobody attaches to within 30 s exits too.
- **Per-version runtime copy.** A packaged daemon (its entry is under `*.app/Contents/Resources/`)
  copies `terminal-host.js`, `package.json` and node-pty to `<state dir>/terminal-host/<hash>/`
  beside the database, restores `spawn-helper`'s execute bit, strips any quarantine flag, and
  launches from there: an app update never replaces the files under a running host, including the
  `spawn-helper` it execs for every new terminal. A running host holds a lease file in its copy;
  pruning keeps leased copies, the current one and the newest three. The Node binary is not
  copied: it is executed once, and a running process keeps its mapped image.

## 10. Restarting

- **`kelpid stop`, SIGTERM**: a full stop. Shells die; the host exits.
- **SIGUSR2**: hand off and exit. Whoever sent it starts the successor.
- **`kelpid restart`**: leaves `<run dir>/daemon-v<N>.respawn`, sends SIGUSR2, and the old daemon
  starts its own successor with its own environment and entry (never the environment of the shell
  that ran `restart`). A daemon without `handoff` gets a full stop and start.
- **`scripts/self-upgrade.mjs`**: the restarter sends SIGUSR2 to daemons that advertise handoff
  (and waits up to 30 s), SIGTERM to older ones, then relaunches the app, whose daemon adopts.
  The first promote INTO a host build restarts the old way; every one after keeps terminals.
- **The app updater (#272)** will use SIGUSR2 the same way.

## 11. Versioning

`H` names the socket, so a daemon only attaches to a host of its own protocol and ends others
(§8). Changing `H` therefore ends the shells of the old host once, on the first boot of the new
version; running old and new hosts side by side, with old terminals routed to the old host, is
the upgrade path if that ever becomes worth it. The blob carries its own version; a daemon that
cannot read a blob treats the terminal as `gap: true`.

## 12. Tests

- `host/protocol.test.ts`, `retention.test.ts`, `runtime.test.ts`: framing, offsets, pins and
  pause-instead-of-drop, the runtime copy and leases.
- `host/host.test.ts`: real PTYs across a handoff (the gap delivered exactly once), a vanished
  daemon's tail replayed with a gap, shutdown, fallback shells, auth, supersede and waiting
  successors, host loss, idle and socket-removed exits, forgetting.
- `term/handoff.test.ts`: checkpoint round trips (alternate screen, scroll region, hidden cursor,
  modes), stepping back over CSI, OSC and UTF-8, replay suppression.
- `boot/terminal-host.test.ts`: a daemon with a real host (shells are the host's children; a full
  stop ends both; no host falls back to in-process; a SIGKILLed host's pane respawns without
  closing), and end to end, a shell handed to a second daemon keeps its pid, screen, gap output
  once and agent state, gets no typed resume, and a full-screen program's modes survive.
- `scripts/scenarios/terminal-survives-daemon-restart.mjs`: the same through a real window and CLI
  (it declares `export const terminalHost = true`; every other sandbox keeps the host off, since a
  harness restart there is a real crash by contract).
- The packaged smoke: the app's daemon hands off and a daemon from the bundle adopts the shell.

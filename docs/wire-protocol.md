# Kelpi Wire Protocol — Compatibility Contract

This document specifies the complete IPC wire protocol between the `kelpi` CLI (and agent
hooks) and the Kelpi daemon, as implemented in the TypeScript daemon
(`packages/daemon/src/control/server.ts`, the command handlers under
`packages/daemon/src/handlers/` and `packages/daemon/src/webpane/`, and the decoder and
allowlist in `packages/protocol/src/`). The daemon honors this contract so the **`kelpi` CLI
binary, hook scripts and saved state keep working unchanged** across upgrades.

Everything here is derived from the current TypeScript source. Where behavior is quirky, the
quirk is documented as-is and explained in "Compatibility rationale" at the end.

---

## 1. Transports

The daemon runs two control servers, both speaking the newline-JSON protocol in this
document (`packages/daemon/src/boot/compose.ts:1437-1480`):

- the **run-dir server** on `<run dir>/daemon-v<PROTOCOL_VERSION>.sock`
  (`packages/daemon/src/lifecycle/rundir.ts:7`). It always also binds a loopback TCP
  listener: the configured `tcp-port` when the run-dir path is itself the compat path,
  otherwise an ephemeral port. That port is the **pane route**: it is injected into every
  pane as `KELPI_SOCKET=tcp:127.0.0.1:<port>` and reported by `ping` as `pane_route`
  (§6.8). A busy run-dir socket is fatal at startup (a daemon of this protocol version is
  already running);
- the **compat server** on `/tmp/kelpi.sock` plus the configured `tcp-port`, which is what
  a plain terminal reaches. Its bind failure is non-fatal: the daemon keeps running on the
  run-dir server, remembers the failure, and reports it in `ping`'s `compat` block
  (`packages/daemon/src/boot/compose.ts:792-814`).

Each server listens on two transports simultaneously (the second is optional):

### 1.1 Unix domain socket (always on)

- Path: **`/tmp/kelpi.sock`** (hardcoded in the CLI, `packages/cli/src/transport.ts:35`; not
  per-user, not under `$TMPDIR`). The legacy Swift app's `/tmp/nex.sock` is never used: the
  two apps run side by side with nothing shared. `KELPID_SOCKET_PATH` (development only)
  moves the daemon's compat socket (`packages/daemon/src/control/endpoints.ts:18-19`); the
  CLI then needs `KELPI_SOCKET=tcp:…` or a symlink to reach it.
- On startup, if a file already exists at the path the server first sends
  `{"command":"ping"}` to it (1 s budget). Any JSON-object reply means a live daemon owns
  the socket and startup fails (`ECONTROLBUSY`) rather than stealing it; only a socket that
  does not answer is unlinked before `bind`/`listen`
  (`packages/daemon/src/control/server.ts:296-320`, `packages/daemon/src/control/probe.ts`).
- After binding, the socket file is `chmod 0600` (same-UID only;
  `packages/daemon/src/control/server.ts:377-381`).
- On clean shutdown, the socket file is unlinked **only if this server instance actually
  started** (guards against a second/test instance deleting the live socket;
  `packages/daemon/src/control/server.ts:405-414`).
- A write to a vanished client fails with `EPIPE` (or `ECONNRESET` on a `^C`) and is
  reported as a non-fatal transport error instead of killing the process (a client may `^C`
  between sending a request and the reply being written;
  `packages/daemon/src/control/server.ts:283`).

### 1.2 TCP listener (optional)

- Enabled by the config line `tcp-port = <port>` in `~/.config/kelpi/config`
  (`KELPID_CONFIG_PATH` overrides the location, `packages/daemon/src/boot/config.ts:42-50`;
  `tcp-port = 0` or absent = no listener, `config.ts:103-105`). The daemon binds it at
  startup and re-binds it on config reload (stopping any previous TCP listener first; the
  Unix socket stays up: `packages/daemon/src/control/server.ts:420-450`).
- `KELPID_TCP_PORT` (and `KELPID_SOCKET_PATH`) outrank the config file at boot and stay in
  force across config reloads: a settings write that changes `tcp-port` is ignored while the
  env override is active (`packages/daemon/src/control/endpoints.ts:60-62`,
  `packages/daemon/src/boot/compose.ts:724-729`).
- A failed bind (port in use) is **not fatal**: the Unix socket keeps serving, the failure is
  recorded as `{requested, bound: null, error}` and surfaced through `ping`'s `tcp` block
  (§6.8; `packages/daemon/src/control/server.ts:341-363`).
- Binds **`127.0.0.1` only** (never `0.0.0.0`): the host may be `127.0.0.1`, `localhost` or
  `::1`; anything else is refused when the server is constructed
  (`packages/daemon/src/control/server.ts:31`).
- **No authentication.** Security model: loopback-only; remote access is via SSH reverse
  tunnels (`ssh -R <port>:localhost:<port> remote`) or `host.docker.internal:<port>` from
  dev containers.
- Protocol on TCP is byte-identical to the Unix socket.

### 1.3 Client-side transport selection (the `kelpi` CLI)

- Env var `KELPI_SOCKET` (the value the daemon injects into every pane's environment,
  `packages/core/src/env/merged-env.ts:14-16`; `NEX_SOCKET` is not read):
  - Absent/empty or not starting with `tcp:` → Unix socket at `/tmp/kelpi.sock`.
  - `tcp:<host>:<port>` → TCP (IPv4, `family: 4`). A malformed value (missing port,
    non-numeric or out-of-range port) silently falls back to the Unix socket
    (`packages/cli/src/transport.ts:39-54`), unless `KELPI_REQUIRE_SOCKET` is set, in which
    case the command refuses to dial at all (sandbox guard,
    `packages/cli/src/transport.ts:205-212`).
- The caller's pane id comes from `KELPI_PANE_ID` (`packages/cli/src/env.ts:35-37`) and its
  profile from `KELPI_PROFILE`; the daemon injects only `KELPI_*` names and reserves them
  against profile overrides (`packages/core/src/env/merged-env.ts:18-20`).
- The CLI opens **one connection per command**, writes exactly one JSON line, then:
  - fire-and-forget: closes immediately, exit 0 (with a stderr `Warning:` if the connect
    failed, suppressible via `KELPI_SILENT=1`; `kelpi event …` auto-suppresses unless
    `KELPI_VERBOSE_HOOKS=1`).
  - request/response: sets an **inactivity** read timeout (restarts on every received
    chunk; default **5 s**, override via `KELPI_REPLY_TIMEOUT=<seconds>`; per-command
    overrides: `web wait` uses `max(ceil(--timeout)+5, KELPI_REPLY_TIMEOUT)` s with
    `--timeout` defaulting to 10 s, `web exec` similarly with a 30 s default `--timeout`
    (`packages/cli/src/commands/web.ts:900`, `:955`), `workspace create --worktree` uses
    **120 s**, `kelpi doctor`'s ping uses **2 s** (`packages/cli/src/commands/doctor.ts:61`)),
    reads until EOF, parses the accumulated bytes as one JSON object
    (`packages/cli/src/transport.ts:278-304`).
  - streaming (`web console --follow` only): no read timeout at all; reads
    newline-delimited JSON lines until EOF or SIGINT (SIGINT closes the FD).
- CLI reply handling: transport failure → categorized `Error:`/`Repair:` stderr text and
  exit 1. **Empty reply** (connection closed with 0 bytes, or read timeout) is treated as
  "older Kelpi that doesn't support this command" and is a non-zero exit
  (`packages/cli/src/reply.ts:25-31`), except `kelpi pane send`, which treats an empty
  reply as success (a pre-request/response app acted, then closed;
  `packages/cli/src/commands/pane.ts:368-370`). `{"ok":false}` → error printed from the
  `error` field, exit non-zero.

---

## 2. Framing

### 2.1 Request framing

- **Newline-delimited JSON objects, UTF-8.** One JSON object per line, `\n` terminated.
- The server splits each received chunk on `\n` (empty segments skipped), trims
  leading/trailing whitespace from each line, and JSON-decodes each line independently.
- Multiple messages in one chunk/connection are legal and are dispatched **in order**.
- A line that fails to JSON-decode or names an unknown `command` is **silently dropped**:
  no reply, no error, connection left open. A line that names a known command but has a
  wrong-typed known key or fails that command's field guards is likewise dropped **when the
  command is fire-and-forget**; when the command is in the reply allowlist (§4) the server
  answers `{"ok":false,"error":"<detail>"}` and closes, so the CLI prints the error instead
  of waiting out its read timeout (`packages/daemon/src/control/server.ts:159-170`).
- Lines are buffered per connection until `\n`, so a request split across reads is
  reassembled (`packages/protocol/src/framing.ts:76-103`; the pre-port server's
  4096-byte-chunk drop is gone, Compatibility rationale item 2). A single line longer than
  64 MB is discarded (up to and including its terminator), counted in the buffer's
  `overflows`, and framing resumes on the next line (`framing.ts:41`).

### 2.2 Field decoding rules

The server decodes each line into a single flat struct with **snake_case keys** (exact key
names are listed per command below). Rules:

- Unknown keys are ignored.
- **Type-strict:** every field must be its native JSON type. A wrong-typed field (e.g.
  `"index": "3"` instead of `"index": 3`, or `"bare": "true"` instead of `true`) fails the
  decode of the **entire message** → silently dropped. Booleans are JSON booleans, counts
  are JSON numbers, `label_values`/`order` are JSON arrays of strings.
- A JSON `null` for a known key reads as **absent**, not as a type error: the validator
  skips null values and the field readers map null to undefined
  (`packages/protocol/src/wire/fields.ts:143`, `:168-171`), so `{"bare":null}` decodes
  with `bare` defaulting to `false`.
- `since` is an unsigned 64-bit integer; a negative value fails the decode.
- Many optional string fields are normalized: **empty string → treated as absent**
  (documented per command; applies to `target`, `workspace`, `group`, `profile`,
  `worktree`, `branch`, `repo`, `scope`, `level`, `send_to`, `domain`, `selector` (for
  `web-key`), `url_match`, `for`, `mode`, `block`, `behavior`, `target_path`).
- `pane_id` must be a syntactically valid UUID string; an invalid UUID makes
  `pane_id` behave as absent (for commands where it's optional) or drops the message (for
  commands where it's required). UUID parsing is `normalizeUuid`
  (`packages/protocol/src/wire/vocab.ts:144`): case-insensitive, canonical 8-4-4-4-12 hex
  form. UUIDs in replies are emitted **uppercase**.

### 2.3 Reply framing

- Replies are only ever sent for commands in the **reply allowlist** (§4). For everything
  else the server writes nothing, ever; the connection sits open until the client closes
  it (client EOF → the server's socket `close` event releases every handle bound to that
  connection, `packages/daemon/src/control/server.ts:288-293`).
- A reply is a **single JSON object serialized to one line + `\n`** (compact
  `JSON.stringify` output, `packages/protocol/src/replies/serialize.ts:11`; key order
  unspecified). After sending, the server closes the client connection (which is the
  client's EOF signal / end-of-reply marker).
- Success replies always contain `"ok": true`; failures always contain `"ok": false` and a
  human-readable `"error": "<message>"` string. Failure replies may carry extra fields
  (e.g. `active_agents` on the workspace-delete running-agents refusal).
- Reply writes go through `socket.write`; on any write error (e.g. `EPIPE`) the reply is
  abandoned and the error reported as non-fatal (`packages/daemon/src/control/reply.ts:63-72`).
- If the client disconnects before the reply is written, the reply handle goes stale and
  `send`/`close` become no-ops.

### 2.4 Streaming replies (`web-console` with `follow:true` only)

- The catch-up drain reply is sent **without closing** the connection. Every subsequent
  console line for that pane is pushed as its own newline-terminated JSON object.
- The stream ends when the **client** disconnects (EOF/SIGINT closes the client FD) or
  when the **pane closes**. On client disconnect the server's socket `close` event releases
  every reply handle bound to that connection and fires each handle's disconnect callbacks
  once; the console-follow handler registers its unsubscribe there
  (`reply.onDisconnect(unsubscribe)`, `packages/daemon/src/webpane/handlers.ts:451-484`,
  `packages/daemon/src/control/reply.ts:92-101`). On pane close the console store ends every
  subscriber for that pane (`packages/daemon/src/webpane/console.ts:116-122`, driven by the
  store's `pane-removed` event in `packages/daemon/src/webpane/service.ts:356-359`) and the
  handler's `end` callback closes the connection server-side. The disconnect notification is
  **never parseable from the wire**: it exists only inside the server.
- The drain line (the first line of the stream) also carries `"follow": true`
  (`packages/daemon/src/webpane/handlers.ts:462`).

### 2.5 Reply-handle lifecycle (server internals the port must reproduce)

- When a parsed message's wire command is in the allowlist, the server allocates a
  **reply handle** bound to the client connection *before* dispatching to the app core
  (`createReplyHandle`, `packages/daemon/src/control/reply.ts:43-109`, allocated per
  connection in `packages/daemon/src/control/server.ts:257-266`). Handles are objects
  closed over the socket; there is no numeric handle id.
- `send(json)` writes one JSON line to that connection (no-op once the peer is gone or the
  handle closed). `close()` ends the writable side (that FIN is the CLI's EOF) and destroys
  the socket once the bytes flush. The contract is: **exactly one reply line then EOF** for
  every allowlisted command except the `web-console --follow` stream.
- When a connection dies for any reason, **all** handles bound to it are released
  (`peerGone`, `packages/daemon/src/control/server.ts:288-293`) and each one's disconnect
  callbacks fire once (the console-follow registry uses this to drop its subscriber; an
  ordinary request handle has none).
- Handles are safe to drop without replying: the client's read timeout handles it. But the
  CLI treats that as an error, so the daemon always replies.
- Fire-and-forget commands are dispatched with **no** handle (`null`), and every handler
  must tolerate that (legacy path).

### 2.6 Dispatch ordering

All parsed messages from a chunk are handed to the app core **synchronously, in wire
order** (`dispatchWireLine`, `packages/daemon/src/control/server.ts:159-180`). Reply handles
are allocated before dispatch, so the handle is always bound to its connection when the
handler runs.

---

## 3. The `command` key and parse pipeline

Every request carries `"command": "<verb>"`. Parsing happens in three stages:

1. **Explicit command chain** — each of the following commands is matched by name and has
   its own field guards (documented per command in §6): `workspace-create`,
   `workspace-list`, `workspace-move`, `workspace-delete`, `workspace-profile`,
   `workspace-label`, `group-list`, `group-create`, `group-rename`, `group-delete`,
   `group-reorder`, `group-sort`, `open`, `diff`, `pane-close`, `pane-list`,
   `pane-capture`, `graft-start`, `graft-stop`, `graft-status`, `ping`, all `web-*`
   commands, `pane-sync`, `pane-sync-exclude`, `pane-send-key`, `pane-send`,
   `pane-split`, `pane-create`, `pane-name`, `pane-resize`, `pane-move-adjacent`.
   These are all parsed **before** the mandatory-`pane_id` guard, which is why
   `pane-send` / `pane-split` / `pane-create` / `pane-name` (and the close/capture/
   send-key/sync family) work from a plain shell with no `KELPI_PANE_ID`.
2. **Mandatory-`pane_id` guard** — anything not matched above must carry a valid
   `pane_id` UUID or the message is dropped.
3. **Fallback switch** on the remaining commands, all of which require the `pane_id`:
   `start`, `stop`, `error`, `notification`, `session-start`, `session-end`, `pane-move`,
   `pane-move-to-workspace`, `layout-cycle`, `layout-select`. Unknown command → dropped.

### 3.1 The `session_id` dual-fire

`session_id` is a common field on all Claude Code / Codex hook stdin JSON, and the CLI
forwards it on every `kelpi event` message. After a line parses successfully, if:

- the command is **not** `session-start` and **not** `session-end`, and
- the line carries a valid `pane_id` UUID, and
- the line carries a non-empty `session_id`,

then the server synthesizes an **additional** `session-start`-equivalent internal event
(`sessionStarted(paneID, sessionID, agent, profile?)`) right after the primary one,
carrying the line's `agent` field (mapped as in §5.1) and, when the line reported one,
its `profile` field (the CLI's effective `KELPI_PROFILE`, non-empty; used to rebuild
the session's environment on resume — agent-lifecycle.md §6.1). This is how e.g. a bare
`stop` hook keeps the pane's tracked session id fresh. `session-end` is excluded because
its whole purpose is to *drop* the id — a dual-fire would immediately re-attach it (and
it clears the recorded profile beside the id, agent-lifecycle.md §5.6).

The synthesized event is tagged with the **original wire command name** for allowlist
purposes but never receives a reply handle, even when the primary command is allowlisted:
`dispatchSequence` marks the synthesized item `reply: false` and the server passes `null`
for it (`packages/protocol/src/dualfire.ts:56-67`,
`packages/daemon/src/control/server.ts:172-180`; Compatibility rationale item 7). Since
every command that realistically carries `session_id` (the `kelpi event` family) is
fire-and-forget, this only matters for hand-rolled clients.

---

## 4. Reply allowlist — fire-and-forget vs request/response

Whether a command gets a reply is determined **solely by its wire command name** against
this fixed set (not by any request field):

```
workspace-list, group-list,
pane-list, pane-close, pane-capture, pane-send, pane-send-key,
pane-split, pane-create, pane-name, pane-resize, pane-move-adjacent,
pane-sync, pane-sync-exclude,
workspace-create, workspace-delete, workspace-label,
group-reorder, group-sort,
graft-start, graft-stop, graft-status,
ping,
web-open, web-navigate, web-url, web-back, web-forward, web-reload, web-capture,
web-tabs, web-tab-new, web-tab-close, web-tab-select,
web-console, web-inspect, web-inspect-result,
web-private, web-cookies-list, web-cookies-clear, web-cookies-delete,
web-click, web-type,
web-q-text, web-q-attr, web-q-count, web-q-exists, web-q-dom,
web-wait,
web-select, web-scroll, web-hover, web-key,
web-exec
```

Everything else is **fire-and-forget**: `start`, `stop`, `error`, `notification`,
`session-start`, `session-end`, `pane-move`, `pane-move-to-workspace`,
`workspace-move`, `workspace-profile`, `group-create`, `group-rename`, `group-delete`,
`layout-cycle`, `layout-select`, `open`, `diff`. For these the wire behavior is
byte-identical to the pre-request/response protocol: the server reads, acts, and never
writes.

---

## 5. Shared vocabularies

### 5.1 `agent` field (agent kind)

Values: `"claude"`, `"codex"`. Matching is **case-insensitive**; absent or unrecognized →
`claude` (so an old CLI without the field keeps pre-Codex behavior). Appears on `start`
and `session-start` (and rides along on any message for the dual-fire, §3.1).

### 5.2 Split direction (`direction` on `pane-split`)

`"horizontal"` (side-by-side) | `"vertical"` (stacked). Any other value → parsed as
absent (the handler picks its default); the message is **not** dropped.

### 5.3 Move direction (`direction` on `pane-move`)

`"left"` | `"right"` | `"up"` | `"down"`. Any other value → message dropped.

### 5.4 Drop zone (`zone` on `pane-move-adjacent`)

`"above"` | `"below"` | `"left-of"` | `"right-of"` (mapping to top/bottom/left/right
edges of the anchor). Missing or unrecognized → message dropped.

### 5.5 Workspace color (`color` on `workspace-create` / `group-create`)

`"red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "gray" | "black" |
"white"`. Unrecognized → treated as absent (handler picks a random color); message not
dropped.

### 5.6 Named keys (`key` on `pane-send-key`)

Validated (after lowercasing) against:
`enter, return, tab, escape, esc, space, backspace, up, down, left, right, ctrl-c`.
Unknown → `{"ok":false,"error":"unknown key '<key>' (valid: <comma-joined list>)"}`.

### 5.7 Pane target resolution (`pane_id` / `target` / `workspace` triple)

Used by `pane-close`, `pane-capture`, `pane-send`, `pane-send-key`, `pane-name`,
`pane-resize`, `pane-sync-exclude`, `pane-move-adjacent` (for both `target` and
`anchor`), and every targeted `web-*` command. Wire shape:

- `pane_id` (optional): the **caller's own** pane UUID from `KELPI_PANE_ID`. Used as the
  addressed pane only when `target` is absent; otherwise it merely scopes label lookup.
- `target` (optional string): name-or-UUID of the addressed pane.
- `workspace` (optional string): name-or-UUID of a workspace to scope label lookup.

Parse-time guard (shared): at least one of `pane_id` (valid UUID) / `target` must be
present. Every command that carries the triple is in the reply allowlist (§4), so a
message with neither is answered `{"ok":false,"error":"<command> requires pane_id or
target"}` and the connection closed, not dropped
(`packages/protocol/src/wire/decode.ts:146-150`,
`packages/daemon/src/control/server.ts:159-170`). Empty-string `target`/`workspace`
count as absent.

Resolution algorithm (server-side, produces either a pane or an error string):

```
if workspace filter given:
    ws = resolveWorkspace(filter)            # UUID match wins; else unique
                                             # case-sensitive name match
    if none -> error "workspace not found: <filter>"
if target given:                             # target WINS over pane_id
    if target parses as UUID:
        if workspace filter: pane must be in that ws
            else -> error "no pane with UUID '<target>' in workspace '<ws.name>'"
        else: pane must exist in ANY workspace
            else -> error "no pane with UUID '<target>'"
    else:  # label lookup — never global
        if workspace filter: candidates = panes in ws with label == target
        elif pane_id given and some workspace contains it:
            candidates = panes in the CALLER's workspace with label == target
        elif pane_id given (stale — no workspace contains it):
            error "origin pane '<uuid>' no longer exists; pass --workspace
                   <name-or-id> to address a pane in another workspace"
        else:
            error "label '<target>' requires --workspace <name-or-id> when
                   called from outside a Kelpi pane"
        0 matches -> error "no pane with label '<target>'[ in workspace '<name>'
                     (use --workspace <name-or-id> to address another workspace)]"
        1 match  -> resolved
        >1       -> error "label '<target>' is ambiguous (<n> matches); pass
                     --workspace <name-or-id> to disambiguate"
elif pane_id given:
    pane must exist in some workspace, else error "no pane with UUID '<uuid>'"
then (either branch):
    ws = workspace containing the resolved pane
    if workspace filter given and ws != filter:
        error "pane '<id>' is not in workspace '<ws filter name>'"
```

Labels are matched **case-sensitively and exactly**. UUID targets are global (unless
narrowed by `workspace`). Errors are returned as `{"ok":false,"error":"..."}` on
request/response commands and silently ignored on the legacy fire-and-forget path.

Only **visible** (non-parked) panes resolve: every lookup above filters parked panes out,
so a parked pane is never user-addressable (`packages/core/src/resolve/pane-target.ts:27-33`,
`:173-176`). The final scope check is what turns a `pane_id`-only request under a
`workspace` filter naming a different workspace into
`pane '<id>' is not in workspace '<name>'` (`pane-target.ts:191-193`); the label path never
reaches it because its candidates were already drawn from the filtered workspace.

### 5.8 Workspace / group name-or-id resolution

`resolveWorkspace` / `resolveGroup`: if the token parses as a UUID and an entity with
that id exists, it wins. Otherwise it must be a **unique case-sensitive name** match;
zero or ≥2 matches fail (fire-and-forget commands then no-op; request/response commands
reply with an error, ambiguous names getting a distinct "ambiguous" message).

Two paths use a **lenient** resolver instead (`resolveWorkspaceLenient`,
`packages/core/src/resolve/workspace.ts:59-71`): `pane-move-to-workspace`'s destination
`name` (`packages/daemon/src/handlers/pane/geometry.ts:187-190`) and the graft commands'
`workspace` scope (`packages/daemon/src/handlers/app/graft.ts:63-67`). There the token is
tried as a UUID, then as a **case-insensitive first-match** name with no ambiguity guard
(two workspaces named `Dev` and `dev` resolve to whichever comes first), then as an exact
slug match.

---

## 6. Command reference

Notation: `req` = required (guard drops or errors without it), `opt` = optional,
`R/R` = request/response (in the allowlist), `F&F` = fire-and-forget. All requests also
carry `"command"`.

### 6.0 Summary table

| command | mode | required fields | optional fields |
|---|---|---|---|
| `start` | F&F | `pane_id` | `agent`, `session_id`†, `profile`† |
| `stop` | F&F | `pane_id` | `background_tasks`, `session_id`†, `agent`†, `profile`† |
| `error` | F&F | `pane_id` | `message`, `session_id`†, `agent`†, `profile`† |
| `notification` | F&F | `pane_id` | `title`, `body`, `background_tasks`, `session_id`†, `agent`†, `profile`† |
| `session-start` | F&F | `pane_id`, `session_id` | `agent`, `profile` |
| `session-end` | F&F | `pane_id`, `session_id` | — |
| `pane-split` | R/R | one of `pane_id`/`target`/`workspace` | `direction`, `path`, `name` |
| `pane-create` | R/R | one of `pane_id`/`target`/`workspace` | `path`, `name` |
| `pane-close` | R/R | one of `pane_id`/`target` | `workspace` |
| `pane-name` | R/R | one of `pane_id`/`target`; `name` | `workspace` |
| `pane-send` | R/R | `target`, `text` (non-empty) | `pane_id`, `workspace`, `bare` |
| `pane-send-key` | R/R | `target`, `key` | `pane_id`, `workspace` |
| `pane-resize` | R/R | one of `pane_id`/`target`; exactly one of `ratio`/`delta` | `workspace` |
| `pane-move` | F&F | `pane_id`, `direction` | — |
| `pane-move-adjacent` | R/R | `target`, `anchor`, `zone` | `pane_id`, `workspace` |
| `pane-move-to-workspace` | F&F | `pane_id`, `name` | `text` (`"true"` = create) |
| `pane-list` | R/R | — | `pane_id`, `workspace`, `scope` |
| `pane-capture` | R/R | one of `pane_id`/`target` | `workspace`, `lines`, `scrollback` |
| `pane-sync` | R/R | `action` | `pane_id`, `workspace` |
| `pane-sync-exclude` | R/R | `target`, `excluded` | `pane_id`, `workspace` |
| `workspace-list` | R/R | — | `group` |
| `workspace-create` | R/R | — | `name`, `path`, `color`, `group`, `profile`, `worktree`, `branch`, `update_main`, `repo` |
| `workspace-move` | F&F | `name` | `group`, `index` |
| `workspace-delete` | R/R | `name` | `force` |
| `workspace-profile` | F&F | `name` | `profile` |
| `workspace-label` | R/R | `name`, `label_op` | `label_values` |
| `group-list` | R/R | — | — |
| `group-create` | F&F | `name` | `color` |
| `group-rename` | F&F | `name`, `new_name` | — |
| `group-delete` | F&F | `name` | `cascade` |
| `group-reorder` | R/R | `name` | `order` |
| `group-sort` | R/R | `name`, `by` | `descending` |
| `layout-cycle` | F&F | `pane_id` | — |
| `layout-select` | F&F | `pane_id`, `name` | — |
| `open` | F&F | `path` | `pane_id`, `reuse` |
| `diff` | F&F | `repo_path` | `target_path`, `pane_id` |
| `graft-start` | R/R | — | `workspace`, `repo`, `pane_id` |
| `graft-stop` | R/R | — | `workspace`, `repo`, `pane_id` |
| `graft-status` | R/R | — | — |
| `ping` | R/R | — | — |
| `web-open` | R/R | `url` (non-empty) | `pane_id`, `private`, `target`, `direction` |
| `web-navigate` | R/R | pane-target*; `url` (non-empty) | — |
| `web-url` | R/R | pane-target* | — |
| `web-back` | R/R | pane-target* | — |
| `web-forward` | R/R | pane-target* | — |
| `web-reload` | R/R | pane-target* | `hard` |
| `web-capture` | R/R | pane-target* | `mode` |
| `web-tabs` | R/R | pane-target* | — |
| `web-tab-new` | R/R | pane-target* | `url`, `make_active` |
| `web-tab-close` | R/R | pane-target*; `tab` | — |
| `web-tab-select` | R/R | pane-target*; `tab` | — |
| `web-console` | R/R | pane-target* | `since`, `level`, `clear`, `follow` |
| `web-inspect` | R/R | pane-target* | `send_to`, `submit`, `disarm` |
| `web-inspect-result` | R/R | pane-target* | `clear` |
| `web-private` | R/R | pane-target*; `private` | — |
| `web-cookies-list` | R/R | pane-target* | — |
| `web-cookies-clear` | R/R | pane-target* | `domain`, `all` |
| `web-cookies-delete` | R/R | pane-target*; `name` | `domain` |
| `web-click` | R/R | pane-target*; `selector` | `double`, `right`, `at_x`, `at_y` |
| `web-type` | R/R | pane-target*; `selector`, `text` | `submit`, `replace` |
| `web-q-text` | R/R | pane-target*; `selector` | `max_bytes` |
| `web-q-attr` | R/R | pane-target*; `selector`, `attribute` | — |
| `web-q-count` | R/R | pane-target*; `selector` | — |
| `web-q-exists` | R/R | pane-target*; `selector` | — |
| `web-q-dom` | R/R | pane-target*; `selector` | `max_bytes` |
| `web-wait` | R/R | pane-target*; exactly one of `selector`/`url_match` | `for`, `timeout_ms` |
| `web-select` | R/R | pane-target*; `selector`, `value_or_label` | — |
| `web-scroll` | R/R | pane-target*; `selector` | `block`, `behavior` |
| `web-hover` | R/R | pane-target*; `selector` | — |
| `web-key` | R/R | pane-target*; `key` | `selector` |
| `web-exec` | R/R | pane-target*; `script` (non-empty) | — |

`pane-target*` = §5.7 triple: at least one of `pane_id` (valid UUID) / `target`
(non-empty), plus optional `workspace`. † = rides along on hook events and triggers
the session_id dual-fire (§3.1); the CLI forwards `session_id` on every `kelpi event`,
and `profile` (the CLI's effective `KELPI_PROFILE`, when set) beside it on every
session-id-bearing event except `session-end`.

---

### 6.1 Agent lifecycle events (all F&F)

Sent by `kelpi event …` from Claude Code / Codex hooks. `pane_id` is the target pane's
UUID (from `KELPI_PANE_ID`). All are silently dropped when `pane_id` is missing/invalid.

**`start`** — main agent loop began (UserPromptSubmit hook). Resets the pane's
background-task count to 0 and marks the pane running; sets the pane's agent kind.

```json
{"command":"start","pane_id":"1B4E4E5A-9F2B-4C58-8D1F-2A81D9A3E111"}
{"command":"start","pane_id":"1B4E…","agent":"codex","session_id":"abc-123"}
```

**`stop`** — main loop finished (Stop hook). `background_tasks` (int, default 0) is the
number of still-running background shells/subagents; > 0 keeps the pane "running"
instead of flipping to "waiting for input" and suppresses the desktop notification +
dock bounce.

```json
{"command":"stop","pane_id":"1B4E…"}
{"command":"stop","pane_id":"1B4E…","background_tasks":2,"session_id":"abc-123"}
```

**`error`** — agent error. `message` defaults to `"Unknown error"`.

```json
{"command":"error","pane_id":"1B4E…","message":"tool crashed"}
```

**`notification`** — desktop notification (Notification hook / Codex PermissionRequest).
`title` defaults to `"Agent"`, `body` to `""`. `background_tasks` as on `stop`.

```json
{"command":"notification","pane_id":"1B4E…","title":"Claude","body":"Needs approval","background_tasks":1}
```

**`session-start`** — bind an agent session id to the pane. `session_id` required
non-empty; `agent` optional (§5.1); `profile` optional (the CLI's effective
`KELPI_PROFILE`, empty treated as absent — recorded so a resume can rebuild the
session's environment, agent-lifecycle.md §6.1; absent keeps the pane's last-known
value).

```json
{"command":"session-start","pane_id":"1B4E…","session_id":"3f2a…","agent":"claude","profile":"work"}
```

**`session-end`** — the session ended; the app clears the pane's tracked session id
(and the profile recorded beside it, agent-lifecycle.md §5.6) **only if it still
matches** `session_id` (required non-empty). Never dual-fires.

```json
{"command":"session-end","pane_id":"1B4E…","session_id":"3f2a…"}
```

---

### 6.2 Pane commands

#### `pane-split` (R/R)

Split an existing pane. Anchor precedence in the handler: `target` (name-or-UUID) >
`workspace` (split that workspace's focused/first pane) > caller `pane_id`. Guard: at
least one of `pane_id` (valid UUID) / `target` / `workspace` present.
`direction`: `"horizontal"`/`"vertical"` (invalid → absent → handler default).
`path` = new pane's working directory; `name` = new pane's label.

```json
{"command":"pane-split","pane_id":"1B4E…","direction":"horizontal","path":"/tmp","name":"worker"}
```

Reply (shared with `pane-create`; the new pane's UUID is minted server-side before the
pane is built):

```json
{"ok":true,"pane_id":"<NEW pane uuid>","workspace_id":"<uuid>","workspace_name":"main","label":"worker"}
```

(`label` only present when a non-empty `name` was given.)

#### `pane-create` (R/R)

Create a pane in a workspace (splitting off the focused pane, or laying out the first
pane when the workspace is empty). Guard identical to `pane-split` (`workspace` alone is
sufficient). When `workspace` is given without `target`, it wins outright — even over
the caller's `pane_id`. Same reply shape as `pane-split`.

```json
{"command":"pane-create","workspace":"beta","path":"/Users/ben/code","name":"builder"}
```

#### `pane-close` (R/R)

Close the resolved pane (§5.7; `target` wins over `pane_id`).

```json
{"command":"pane-close","pane_id":"1B4E…"}
{"command":"pane-close","target":"worker","workspace":"beta"}
```

Reply:

```json
{"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"beta","label":"worker"}
```

(`label` only when the pane has one.) Errors per §5.7.

#### `pane-name` (R/R)

Set/clear the resolved pane's label. `name` required **non-empty on the wire**; the
handler treats it as the new label. Reply:

```json
{"command":"pane-name","pane_id":"1B4E…","name":"coordinator"}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main","label":"coordinator"}
```

#### `pane-send` (R/R)

Write `text` to the resolved pane's PTY. `target` required (label or UUID; `pane_id`
only scopes label lookup), `text` required non-empty. `bare` (default `false`): when
false, an Enter keystroke follows the text; when true, text only. Reply is sent
**before** the keystrokes are delivered:

```json
{"command":"pane-send","pane_id":"1B4E…","target":"worker","text":"ls -la","bare":false}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main","bare":false,"label":"worker"}
```

#### `pane-send-key` (R/R)

Deliver one named keystroke (§5.6) outside any bracketed-paste envelope. Key name is
lowercased then validated **before** target resolution. Byte-mapped keys
(enter/tab/escape/space/backspace/ctrl-c) are injected as their raw byte through the
key-event path (so ctrl-c → `0x03` → SIGINT); arrow keys are translated per terminal
mode (DECCKM).

```json
{"command":"pane-send-key","target":"worker","workspace":"beta","key":"enter"}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"beta","key":"enter","label":"worker"}
```

#### `pane-resize` (R/R)

Resize the resolved pane against its immediate split sibling. Guard: pane-target triple
AND **exactly one** of `ratio` (number, absolute target share of the addressed pane,
0<r<1) / `delta` (number, signed share adjustment; grow positive, shrink negative) —
both or neither is answered `{"ok":false,"error":"pane-resize requires exactly one of ratio / delta"}` and the connection is closed (`packages/protocol/src/wire/decode.ts:243`), the same shape as every other guard failure on an allowlisted command. The handler maps the pane to its enclosing split,
converts the requested pane *share* to the split's stored first-child ratio (a
second-child pane's share is `1 - ratio`), clamps the effective share to `[0.1, 0.9]`,
and resets any tracked predefined-layout index. Refuses a sole-leaf pane (no sibling:
`pane <id> has no sibling to resize against (it is the only pane in its workspace)`) and,
before the split lookup, any workspace with a zoomed pane (`cannot resize while a pane is
zoomed`, followed by an un-zoom hint; `packages/daemon/src/handlers/pane/geometry.ts:47-61`).

```json
{"command":"pane-resize","target":"coordinator","workspace":"main","ratio":0.7}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main",
   "split_path":"dL","ratio":0.7,"target_share":0.7,"label":"coordinator"}
```

`split_path` is the split-path **string** of the enclosing split: `"d"` is the root
split and each appended `L`/`R` steps into a split's first/second child (so `"dL"` is the
first child of the root split, `"dLR"` the second child of that). Kelpi builds it in
`enclosingSplitPath` (`packages/core/src/layout/ratio.ts:61-77`), returns it as
`ResizeResult.splitPath: string` (`packages/core/src/layout/ratio.ts:80,118`) and copies
it onto the wire unchanged (`packages/daemon/src/handlers/pane/geometry.ts:98`). It is the
same path shape `layout-select` and pane-layout §7.3 use, and `PaneResizeReply.split_path`
(`packages/protocol/src/replies/types.ts`) is typed `string` to match (issue #49; the
protocol serialize test pins the shape). `ratio` is the stored first-child ratio after the
write; `target_share` is the clamped share of the addressed pane.

#### `pane-move` (F&F)

Directional move of the **caller** pane. `pane_id` and `direction`
(`left|right|up|down`) both required; invalid direction drops the message.

```json
{"command":"pane-move","pane_id":"1B4E…","direction":"left"}
```

#### `pane-move-adjacent` (R/R)

Re-parent pane `target` onto an edge of pane `anchor` (the CLI form of GUI
drag-and-drop). `target` + `anchor` (both name-or-UUID) + `zone`
(`above|below|left-of|right-of`) required; `pane_id` only scopes label lookup.
`anchor` must resolve within the moved pane's workspace; anchor==target is refused
(`"cannot move a pane adjacent to itself"`).

```json
{"command":"pane-move-adjacent","target":"logs","anchor":"coordinator","zone":"below","workspace":"main"}
→ {"ok":true,"pane_id":"<moved uuid>","anchor_id":"<anchor uuid>","zone":"below",
   "workspace_id":"<uuid>","workspace_name":"main","label":"logs"}
```

#### `pane-move-to-workspace` (F&F)

Move the caller pane to another workspace. `pane_id` required; destination
workspace name-or-id rides in **`name`** (required non-empty). **Quirk:** the
"create the workspace if missing" flag rides in the **`text`** field as the literal
string `"true"` (anything else, or absent, = false). The destination is resolved with the
lenient resolver (§5.8; `packages/daemon/src/handlers/pane/geometry.ts:187-190`).

```json
{"command":"pane-move-to-workspace","pane_id":"1B4E…","name":"scratch","text":"true"}
```

#### `pane-list` (R/R)

List panes. `pane_id` optional (required only when `scope=="current"`); `workspace`
(name-or-id filter) and `scope` (`"all"` default, or `"current"`) optional and mutually
exclusive (`workspace` + `scope:"current"` → error). Unknown workspace → error; unknown
scope value → `{"ok":false,"error":"unknown scope: <scope>"}`. Panes are listed in
layout order per workspace, workspaces in state order.

```json
{"command":"pane-list","workspace":"main"}
```

Reply — `panes` array; per-entry always-present keys:
`id` (uppercase UUID), `type` (`shell|markdown|scratchpad|diff|web`), `workspace_id`,
`workspace_name`, `working_directory`, `status` (`idle|running|waitingForInput`),
`is_focused` (bool), `is_active_workspace` (bool), `created_at` / `last_activity_at`
(ISO 8601 UTC, whole seconds; `packages/core/src/codec/timestamps.ts:91`). Conditionals:
`label`, `title`, `git_branch`,
`agent_session_id` (full id), `agent` (`claude|codex`, last-known), `background_tasks`
(only when > 0), `file_path`, `group_id` + `group_name` (only when the workspace is in
a group).

```json
{"ok":true,"panes":[
  {"id":"1B4E…","type":"shell","workspace_id":"…","workspace_name":"main",
   "working_directory":"/Users/ben/code/kelpi","status":"running","is_focused":true,
   "is_active_workspace":true,"created_at":"2026-08-18T09:00:00Z",
   "last_activity_at":"2026-08-18T09:05:12Z","label":"coordinator",
   "agent":"claude","agent_session_id":"3f2a…"}]}
```

#### `pane-capture` (R/R)

Read a pane's terminal contents. Pane-target triple; `lines` (int, optional) tails the
output to the last N lines after read; `scrollback` (bool, default false) extends the
read region from the visible viewport to the full screen. Non-`shell` panes are
rejected: `{"ok":false,"error":"pane is not a terminal (type: <type>)"}`. If the pane
vanishes mid-capture: `{"ok":false,"error":"pane closed during capture"}`.

```json
{"command":"pane-capture","target":"worker","workspace":"beta","lines":50,"scrollback":true}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"beta",
   "text":"…terminal contents…\n","label":"worker"}
```

Tail semantics: a trailing `\n` on the captured text is preserved through the tail
operation; empty input tails to `""`.

A present `lines` that is <= 0 fails with `lines must be a positive integer (got N)` before
the target is resolved (`packages/daemon/src/handlers/pane/input.ts:77-81`). A read that
throws for a still-present pane answers `{"ok":false,"error":"pane capture failed: <error>"}`
(`input.ts:136-147`).

#### `pane-sync` (R/R)

Workspace-wide synchronized input. `action` required: `"on"`, `"off"`, `"toggle"`, or
`"status"` (read-only). Workspace scope: `workspace` name-or-id, else the caller's
workspace via `pane_id`. All four actions reply with the same status payload:

```json
{"command":"pane-sync","pane_id":"1B4E…","action":"on"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"main","active":true,
   "synced_pane_ids":["<uuid>","<uuid>"],
   "excluded":[{"id":"<uuid>","label":"logs"}]}
```

`synced_pane_ids` is sorted lexicographically; `excluded` entries are sorted by id and
carry `label` only when set. The sync group only contains shell panes, minus the
excluded set, and only when ≥2 qualify.

`action` is lowercased before matching; an unknown value →
`{"ok":false,"error":"unknown sync action '<action>' (valid: on, off, toggle, status)"}`.
With neither a resolvable `workspace` nor a `pane_id` that some workspace contains →
`pane sync requires --workspace or NEX_PANE_ID` (the error text still names the legacy
variable; `packages/daemon/src/handlers/pane/sync.ts:28`). The caller lookup is
parked-inclusive (a parked shell still belongs to its workspace), and the reply is computed
from post-mutation state (`sync.ts:61-85`).

#### `pane-sync-exclude` (R/R)

Opt a single pane out of / back into the active sync group. Pane-target triple with
`target` required, plus required bool `excluded` (true = exclude, false = re-include;
missing → message dropped). Idempotent. Replies with the same sync-status payload as
`pane-sync`.

```json
{"command":"pane-sync-exclude","target":"logs","workspace":"main","excluded":true}
```

---

### 6.3 Workspace commands

#### `workspace-list` (R/R)

`group` (optional name-or-id) scopes to one group's members; unknown/ambiguous group →
`{"ok":false,"error":"no group matches '<filter>'"}` (distinct from an empty group,
which succeeds with `[]`-ish content). Order: sidebar order (top-level items and group
members interleaved as displayed, collapsed groups included), then any orphaned
workspaces appended.

```json
{"command":"workspace-list"}
→ {"ok":true,"workspaces":[
    {"id":"<uuid>","name":"main","color":"blue","pane_count":3,"is_active":true,
     "created_at":"2026-08-01T10:00:00Z","last_accessed_at":"2026-08-18T08:00:00Z",
     "labels":["wip"],
     "last_activity_at":"2026-08-18T08:59:00Z",
     "agent_session_id":"3f2a…",
     "group_id":"<uuid>","group_name":"projects"}]}
```

Always-present per entry: `id`, `name`, `color`, `pane_count`, `is_active`,
`created_at`, `last_accessed_at`, `labels` (array, possibly empty). Conditionals:
`last_activity_at` (max across panes; absent when no panes), `agent_session_id`
(first pane carrying one), `group_id`/`group_name` (absent for top-level).

#### `workspace-create` (R/R)

All fields optional. `name` defaults to `"Workspace"`; `path` seeds the first pane's
cwd; `color` per §5.5 (invalid/absent → random); `group` creates the group if missing
(unless `worktree` is set — then the group must already exist); `profile` assigns a
workspace profile (empty string = none). Worktree flow (all empty strings normalized to
absent): `worktree` = worktree/folder name to create, `branch` (defaults to the
worktree name), `update_main` (bool, default false — fetch and branch off
`origin/<default>`), `repo` = source repo path (the CLI always sends it when `worktree`
is set; the handler falls back to `path`, and only when both are absent or blank →
`{"ok":false,"error":"--worktree requires a source repo (pass --repo <path>)"}`;
`packages/daemon/src/handlers/app/workspaces.ts:253-257`).

```json
{"command":"workspace-create","name":"Test","color":"blue","group":"projects"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"Test","group":"projects"}

{"command":"workspace-create","name":"feat-x","worktree":"feat-x","branch":"feat-x",
 "update_main":true,"repo":"/Users/ben/code/kelpi"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x",
   "worktree_path":"/…/worktrees/feat-x","branch":"feat-x"}
```

Ambiguous `group` name → `{"ok":false,"error":"group name is ambiguous: <name> (use
the id or rename an existing group)"}`. With `worktree`, an unknown group →
`{"ok":false,"error":"unknown group: <name> — --worktree only supports existing
groups; create it first (`kelpi group create`) or omit --group"}`. Worktree git failures
→ `{"ok":false,"error":"<git error text>"}`. The CLI reads this command with a 120 s
timeout when `worktree` is set (slow `git fetch` is not a spurious failure).

Names are sanitized before any git work: an unusable `worktree` →
`{"ok":false,"error":"\"<name>\" isn't a usable worktree name"}`, an unusable `branch` →
`{"ok":false,"error":"\"<branch>\" isn't a usable branch name"}`
(`packages/daemon/src/handlers/app/workspaces.ts:260-272`). The `group` token is trimmed
(`workspaces.ts:232`), and the worktree reply also carries `group` when the workspace was
placed in one (`workspaces.ts:352-358`).

#### `workspace-move` (F&F)

`name` (required non-empty) = workspace name-or-id. `group` = destination group name
(nil / empty = top level); `index` (int) = position. No reply; resolution failures
no-op silently.

```json
{"command":"workspace-move","name":"Test","group":"projects","index":0}
```

#### `workspace-delete` (R/R)

`name` (required non-empty) = workspace name-or-id; `force` (bool, default false).
Refusals: last remaining workspace; ambiguous name; unknown name; running-agents guard
without force —

```json
{"command":"workspace-delete","name":"feat-x","force":false}
→ {"ok":false,"error":"workspace feat-x has 2 running agents; pass --force to delete anyway",
   "active_agents":2}
```

Success (the `path` field — a shell pane's cwd, else the first pane's cwd, absent for
an empty workspace — feeds the CLI's `--prune-worktree`):

```json
{"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x","path":"/…/worktrees/feat-x"}
```

The CLI performs bulk delete as one request per id and any `--prune-worktree` git work
client-side.

#### `workspace-profile` (F&F)

`name` (required non-empty) = workspace name-or-id; `profile` = profile name (absent
or empty = clear).

```json
{"command":"workspace-profile","name":"main","profile":"work"}
```

#### `workspace-label` (R/R)

`name` (required non-empty) = workspace name-or-id; `label_op` (required non-empty) ∈
`set|add|remove|clear` (unknown op → `{"ok":false,"error":"unknown label operation
'<op>'"}`); `label_values` = array of strings (default `[]`; values are trimmed, truncated
to 64 characters and empties dropped server-side, `packages/core/src/resolve/ids.ts:45-55`).
`set` replaces, `add` appends dedup-preserving, `remove` drops matches, `clear` empties. A
`set`/`add`/`remove` whose values all normalize away is refused rather than applied:
`{"ok":false,"error":"no label value to set (use --clear to remove all labels)"}`
(`"no label value to add"`, `"no label value to remove"`), so a `set` that normalizes to
nothing never silently wipes the label set
(`packages/daemon/src/handlers/app/workspaces.ts:571-600`). Unknown workspace →
`{"ok":false,"error":"no workspace matches '<name>'"}`. Introduced labels also gain a gray
label preset.

```json
{"command":"workspace-label","name":"main","label_op":"add","label_values":["wip","urgent"]}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"main","labels":["wip","urgent"]}
```

---

### 6.4 Group commands

#### `group-list` (R/R)

No parameters. Groups in sidebar order (unplaced groups appended; duplicates
de-duplicated); members in each group's child order.

```json
{"command":"group-list"}
→ {"ok":true,"groups":[
    {"id":"<uuid>","name":"projects","color":"blue",
     "workspaces":[{"id":"<uuid>","name":"main"},{"id":"<uuid>","name":"beta"}]}]}
```

`color` present only when the group has one.

#### `group-create` (F&F)

`name` required non-empty; `color` per §5.5 (invalid → absent).

```json
{"command":"group-create","name":"projects","color":"blue"}
```

#### `group-rename` (F&F)

`name` (name-or-id) and `new_name` both required non-empty.

```json
{"command":"group-rename","name":"projects","new_name":"clients"}
```

#### `group-delete` (F&F)

`name` (name-or-id) required non-empty; `cascade` (bool, default false — without it,
children promote to top level).

```json
{"command":"group-delete","name":"projects","cascade":true}
```

#### `group-reorder` (R/R)

`name` (name-or-id) required non-empty; `order` = array of member tokens (each a
member workspace UUID or a name unique within the group; default `[]`). A non-member
token or duplicate → error, nothing written. Members omitted from `order` keep their
relative order at the tail.

```json
{"command":"group-reorder","name":"projects","order":["beta","main"]}
→ {"ok":true,"group_id":"<uuid>","group_name":"projects",
   "order":["<uuid-of-beta>","<uuid-of-main>", "…tail…"]}
```

(The reply `order` lists only current members, as full uppercase UUIDs, in the final
child order.)

#### `group-sort` (R/R)

`name` (name-or-id) and `by` both required non-empty. `by` ∈ `name` (case-insensitive
workspace name) | `last-activity` (most recent pane activity) | `last-accessed` (alias
`last-modified`; workspace lastAccessedAt). `by` is lowercased and also accepts the
underscore aliases `last_activity`, `last_accessed`, `last_modified`; unknown →
`{"ok":false,"error":"unknown sort key '<by>' (use name|last-activity|last-accessed)"}`
(`packages/daemon/src/handlers/app/groups.ts:136-144`, `:203-207`). `descending` (bool,
default false). Stable sort. Reply shape mirrors `group-reorder`.

```json
{"command":"group-sort","name":"projects","by":"last-activity","descending":true}
```

---

### 6.5 Layout commands (both F&F)

```json
{"command":"layout-cycle","pane_id":"1B4E…"}
{"command":"layout-select","pane_id":"1B4E…","name":"tiled"}
```

`pane_id` required (identifies the workspace via the caller pane). `layout-select`'s
`name` required non-empty; valid names are the predefined layouts
(`even-horizontal`, `even-vertical`, `main-horizontal`, `main-vertical`, `tiled`) —
validation happens in the handler, silently.

### 6.6 File / diff commands (both F&F)

**`open`**: open a markdown pane for `path` (required non-empty).
`pane_id` optional (originating pane); `reuse` (bool, default false) = replace the
originating pane in place (`kelpi open --here` / `kelpi md --here`).

```json
{"command":"open","path":"/Users/ben/notes/plan.md","pane_id":"1B4E…","reuse":true}
```

**`diff`** — open a git-diff pane. `repo_path` required non-empty; `target_path`
optional file/dir scope (empty → absent); `pane_id` optional.

```json
{"command":"diff","repo_path":"/Users/ben/code/kelpi","target_path":"packages/daemon","pane_id":"1B4E…"}
```

Both route to the workspace containing the visible pane named by `pane_id`, else the
active workspace; with no active workspace the message is dropped
(`packages/daemon/src/handlers/app/files.ts:29-37`). A relative `path` / `repo_path` /
`target_path` is joined to the originating pane's working directory, else to the target
workspace's focused pane's; absolute and `~`-prefixed paths pass through untouched
(`files.ts:39-65`). The `kelpi` CLI absolutises before sending, so this only matters for raw
socket clients.

### 6.7 Graft commands (all R/R)

Scope resolution: `workspace` (name-or-id, resolved with the lenient resolver of §5.8;
`packages/daemon/src/handlers/app/graft.ts:63-67`) and/or `repo` (repo name or path); with
neither, `pane_id` scopes to the caller's workspace; no scope at all → error. Every graft
failure reply also carries a machine-readable `error_kind` string (scope failures:
`"scope"`; `graft.ts:8-14`, `:125`, `:143-157`); a partial start adds `partial_error_kind`
beside `partial_error`.

**`graft-start`**

```json
{"command":"graft-start","pane_id":"1B4E…"}
→ {"ok":true,"started":[
    {"association_id":"<uuid>","worktree_path":"/…","branch":"feat-x",
     "parent_repo_root":"/…"}]}
```

Partial success adds `"partial_error":"<last error>"`; zero started →
`{"ok":false,"error":"<last error | graft start failed>"}`.

**`graft-stop`** — same request shape. A `repo` filter that matches no association is
not fatal (orphaned sessions are matched by path against the service's live sessions).
No targets → `{"ok":true,"stopped":[]}`. Otherwise:

```json
{"ok":true,"stopped":["<uuid>", "…"]}
{"ok":false,"stopped":["<uuid>"],
 "failed":[{"association_id":"<uuid>","error":"…","error_kind":"…"}],
 "error":"<the one failure, or 'N graft sessions failed to stop: …'>","error_kind":"…"}
```

(`ok` is false iff any stop failed; `failed` and the summary `error` present only then. The
summary is the single failure's text, or `N graft sessions failed to stop: <errors joined
by '; '>`, so the CLI's generic envelope check has something to print;
`packages/daemon/src/handlers/app/graft.ts:234-261`.)

**`graft-status`** — no parameters.

```json
{"command":"graft-status"}
→ {"ok":true,"sessions":[
    {"association_id":"<uuid>","worktree_path":"/…","parent_repo_root":"/…",
     "branch":"feat-x","status":"watching"}]}
```

`status` ∈ `starting|watching|syncing|error`; `error` (message) present when status is
error; optional `stash_ref`, `last_sync` when known.

### 6.8 `ping` (R/R)

Health check + version probe (used by `kelpi doctor`). No parameters.

```json
{"command":"ping"}
→ {"ok":true,"version":"0.1.0","build":"1","pid":48291,"protocol":1,
   "pane_route":"tcp:127.0.0.1:52144",
   "persistence":{"ok":true,"degraded":false,"path":"/…/kelpi.db","failed_saves":0,"last_save_at":"2026-08-18T09:05:12Z"}}
```

`version` = daemon version, `build` = build number (compiled-in constants, overridable via
`KELPID_VERSION` / `KELPID_BUILD`; `"unknown"` is never emitted;
`packages/daemon/src/boot/version.ts:16-21`, `:34-40`), `pid` = the server process id (lets
callers confirm which instance owns the socket). The reply carries additive blocks the CLI
ignores unless it understands them (`packages/daemon/src/handlers/app/ping.ts:33-64`):

- `protocol` (int): the compiled-in `PROTOCOL_VERSION`, the same number in the run-dir
  socket name.
- `tcp` `{requested, host, bound?, error?}`: present only when a `tcp-port` was configured;
  `bound` when the listener is up, `error` when the bind failed (§1.2).
- `compat` `{path, error}`: present only when the compat socket (§1) is degraded.
- `pane_route`: the `KELPI_SOCKET` value injected into panes, present once the run-dir
  server's TCP listener is bound.
- `persistence` `{ok, degraded, path, failed_saves, last_save_at, error?, errno?, phase?}`:
  the database health, so a daemon whose store failed to open does not look healthy.

`kelpid status` and the daemon's own startup probe parse these blocks
(`packages/daemon/src/control/probe.ts:20-108`).

### 6.9 Web pane commands (all R/R)

All use the §5.7 pane-target triple except `web-open`, which always creates a new pane:
when its `pane_id` resolves to a visible pane the new pane is created in that pane's
workspace, otherwise in the active workspace (no workspace at all →
`{"ok":false,"error":"no active workspace"}`; `packages/daemon/src/webpane/handlers.ts:105-113`,
`:181-186`). `web-open` also accepts an optional `target` (the pane to split off) and
`direction` (§5.2; unrecognized → absent), decoded in
`packages/protocol/src/wire/decode.ts:417-431`: the handler splits that pane when it is a
visible pane of the routed workspace and otherwise ignores the anchor
(`webpane/handlers.ts:190-200`). Only the GUI sends them; the CLI never does. Reply payload
details are specified in the web-pane subsystem doc; every reply follows the `{"ok":true,…}` /
`{"ok":false,"error":…}` convention on a single line + EOF, except the
`web-console --follow` stream (§2.4). Request shapes:

```json
{"command":"web-open","url":"https://example.com","private":false,"pane_id":"1B4E…"}
{"command":"web-navigate","target":"browser","url":"https://example.com"}
{"command":"web-url","pane_id":"1B4E…"}
{"command":"web-back","target":"browser","workspace":"main"}
{"command":"web-forward","target":"browser"}
{"command":"web-reload","target":"browser","hard":true}
{"command":"web-capture","target":"browser","mode":"screenshot"}
{"command":"web-tabs","target":"browser"}
{"command":"web-tab-new","target":"browser","url":"https://x.test","make_active":true}
{"command":"web-tab-close","target":"browser","tab":"2"}
{"command":"web-tab-select","target":"browser","tab":"A7C0…-uuid"}
{"command":"web-console","target":"browser","since":42,"level":"error","clear":false,"follow":false}
{"command":"web-inspect","target":"browser","send_to":"coordinator","submit":false,"disarm":false}
{"command":"web-inspect-result","target":"browser","clear":true}
{"command":"web-private","target":"browser","private":true}
{"command":"web-cookies-list","target":"browser"}
{"command":"web-cookies-clear","target":"browser","domain":"example.com","all":false}
{"command":"web-cookies-delete","target":"browser","name":"sid","domain":"example.com"}
{"command":"web-click","target":"browser","selector":"text:Submit","double":false,"right":false,"at_x":4,"at_y":8}
{"command":"web-type","target":"browser","selector":"css:#q","text":"hello","submit":true,"replace":true}
{"command":"web-q-text","target":"browser","selector":"css:main","max_bytes":4096}
{"command":"web-q-attr","target":"browser","selector":"css:a.next","attribute":"href"}
{"command":"web-q-count","target":"browser","selector":"css:li"}
{"command":"web-q-exists","target":"browser","selector":"text:Done"}
{"command":"web-q-dom","target":"browser","selector":"css:#app","max_bytes":8192}
{"command":"web-wait","target":"browser","selector":"css:.spinner","for":"hidden","timeout_ms":15000}
{"command":"web-wait","target":"browser","url_match":"/dashboard/","for":"url-match","timeout_ms":0}
{"command":"web-select","target":"browser","selector":"css:#country","value_or_label":"Australia"}
{"command":"web-scroll","target":"browser","selector":"css:#footer","block":"end","behavior":"smooth"}
{"command":"web-hover","target":"browser","selector":"css:.menu"}
{"command":"web-key","target":"browser","key":"Escape","selector":"css:#modal"}
{"command":"web-exec","target":"browser","script":"return await $('h1').innerText"}
```

Parse guards and defaults (beyond the shared triple):

| command | guards | defaults |
|---|---|---|
| `web-open` | `url` non-empty (else `{"ok":false,"error":"web-open requires a non-empty url"}`, `packages/protocol/src/wire/decode.ts:419`); pane-target NOT required | `private:false` |
| `web-navigate` | `url` non-empty | — |
| `web-reload` | — | `hard:false` |
| `web-capture` | — | `mode:"meta"` (empty string also → `"meta"`; values: `meta`, `text`, `screenshot`, `dom`, `all`; anything else → `{"ok":false,"error":"unknown capture mode '<mode>' (allowed: meta, text, screenshot, dom, all)"}` before the host is contacted, `packages/daemon/src/webpane/handlers.ts:316-325`) |
| `web-tab-new` | — | `url:""` (blank tab), `make_active:true` |
| `web-tab-close` / `web-tab-select` | `tab` non-empty (UUID string or numeric index; resolved server-side, UUID tried first) | — |
| `web-console` | — | `since:0` (full buffer), `level:null` (empty → null), `clear:false`, `follow:false` |
| `web-inspect` | — | `send_to:null` (empty → null), `submit:false`, `disarm:false` |
| `web-inspect-result` | — | `clear:false` |
| `web-private` | `private` **must be present** (bool) else `{"ok":false,"error":"web-private requires private"}` (`packages/protocol/src/wire/decode.ts:508`) | — |
| `web-cookies-clear` | `all:true` together with a `domain` → `{"ok":false,"error":"--all and --domain are mutually exclusive"}`; without a connected host → `{"ok":true,…,"deleted":0}` (`packages/daemon/src/webpane/handlers.ts:599-611`) | `domain:null` (empty → null), `all:false` |
| `web-cookies-delete` | `name` non-empty | `domain:null` |
| `web-click` | `selector` non-empty | `double:false`, `right:false`; `at_x`/`at_y` both optional doubles (both must be present to apply; else element center) |
| `web-type` | `selector` non-empty; `text` present (empty allowed) | `submit:false`, `replace:true` |
| `web-q-text` / `web-q-dom` | `selector` non-empty | `max_bytes:null` (JS default) |
| `web-q-attr` | `selector` and `attribute` non-empty | — |
| `web-q-count` / `web-q-exists` / `web-hover` | `selector` non-empty | — |
| `web-wait` | exactly one of `selector` / `url_match` non-empty (neither or both → `{"ok":false,"error":"web-wait requires exactly one of selector / url_match"}`, `packages/protocol/src/wire/decode.ts:586`) | `for:null` (empty → null), `timeout_ms:0` (0/absent → JS default 10000) |
| `web-select` | `selector` non-empty; `value_or_label` present (empty allowed) | — |
| `web-scroll` | `selector` non-empty | `block:"center"` (∈ start/center/end), `behavior:"instant"` (∈ instant/smooth) |
| `web-key` | `key` non-empty | `selector:null` (empty → null; null = document.activeElement) |
| `web-exec` | `script` non-empty | — |

Note the `for` wire key maps to the wait condition (`visible`, `hidden`, `exists`,
`count=N`, `text=X`, `url-match`); the `count=`/`text=` suffixes are parsed downstream,
not at the wire.

---

## 7. Full wire-field dictionary

Every key the request decoder knows, its JSON type, and which commands use it. Any
other key is ignored. (A known key with the wrong type poisons the whole message —
§2.2.)

| wire key | type | used by |
|---|---|---|
| `command` | string | all (required) |
| `pane_id` | string (UUID) | most; see per-command |
| `message` | string | `error` |
| `title`, `body` | string | `notification` |
| `session_id` | string | `session-start`, `session-end`, dual-fire on any |
| `background_tasks` | int | `stop`, `notification` |
| `agent` | string | `start`, `session-start` (+ dual-fire) |
| `direction` | string | `pane-split`, `pane-move`, `web-open` (GUI split anchor) |
| `path` | string | `pane-split`, `pane-create`, `workspace-create`, `open` |
| `name` | string | `pane-split`/`pane-create` (label), `pane-name` (new label), `workspace-*` (name-or-id or new name), `group-*` (name-or-id), `layout-select` (layout name), `pane-move-to-workspace` (dest ws), `web-cookies-delete` (cookie name) |
| `color` | string | `workspace-create`, `group-create` |
| `target` | string | pane-target commands, `web-open` (GUI split anchor) |
| `text` | string | `pane-send`; **`pane-move-to-workspace`'s create flag (`"true"`)**; `web-type` |
| `key` | string | `pane-send-key`, `web-key` |
| `bare` | bool | `pane-send` |
| `new_name` | string | `group-rename` |
| `cascade` | bool | `group-delete` |
| `force` | bool | `workspace-delete` |
| `index` | int | `workspace-move` |
| `group` | string | `workspace-create`, `workspace-move`, `workspace-list` |
| `profile` | string | `workspace-create`, `workspace-profile`, `session-start` (+ dual-fire on any session-id-bearing event, §3.1) |
| `workspace` | string | pane-target commands, `pane-list`, `pane-sync`, `graft-*`, `pane-split`/`pane-create` (destination) |
| `scope` | string | `pane-list` |
| `reuse` | bool | `open` |
| `repo_path`, `target_path` | string | `diff` |
| `lines` | int | `pane-capture` |
| `scrollback` | bool | `pane-capture` |
| `repo` | string | `graft-start`, `graft-stop`, `workspace-create` (worktree source) |
| `url` | string | `web-open`, `web-navigate`, `web-tab-new` |
| `mode` | string | `web-capture` |
| `hard` | bool | `web-reload` |
| `tab` | string | `web-tab-close`, `web-tab-select` |
| `make_active` | bool | `web-tab-new` |
| `since` | uint64 | `web-console` |
| `level` | string | `web-console` |
| `clear` | bool | `web-console`, `web-inspect-result` |
| `follow` | bool | `web-console` |
| `send_to` | string | `web-inspect` |
| `submit` | bool | `web-inspect`, `web-type` |
| `disarm` | bool | `web-inspect` |
| `private` | bool | `web-open`, `web-private` |
| `domain` | string | `web-cookies-clear`, `web-cookies-delete` |
| `all` | bool | `web-cookies-clear` |
| `selector` | string | `web-click`, `web-type`, `web-q-*`, `web-wait`, `web-select`, `web-scroll`, `web-hover`, `web-key` |
| `double`, `right` | bool | `web-click` |
| `at_x`, `at_y` | double | `web-click` |
| `replace` | bool | `web-type` |
| `max_bytes` | int | `web-q-text`, `web-q-dom` |
| `attribute` | string | `web-q-attr` |
| `for` | string | `web-wait` |
| `url_match` | string | `web-wait` |
| `timeout_ms` | int | `web-wait` |
| `value_or_label` | string | `web-select` |
| `block`, `behavior` | string | `web-scroll` |
| `script` | string | `web-exec` |
| `action` | string | `pane-sync` |
| `excluded` | bool | `pane-sync-exclude` |
| `worktree`, `branch` | string | `workspace-create` |
| `update_main` | bool | `workspace-create` |
| `ratio`, `delta` | double | `pane-resize` |
| `anchor`, `zone` | string | `pane-move-adjacent` |
| `label_op` | string | `workspace-label` |
| `label_values` | string[] | `workspace-label` |
| `order` | string[] | `group-reorder` |
| `by` | string | `group-sort` |
| `descending` | bool | `group-sort` |

---

## 8. Invariants and edge cases (checklist)

1. One JSON object per `\n`-terminated line; requests and replies alike.
2. An undecodable line, an unknown command, or a malformed fire-and-forget request is
   silently dropped: never a reply, never a close. A malformed *allowlisted* request gets
   `{"ok":false,"error":…}` + EOF (§2.1).
3. Reply iff the wire command is in the allowlist (§4); exactly one reply line then
   server-side close (client sees EOF), except `web-console` with `follow:true`.
4. Every success reply has `"ok": true`; every failure has `"ok": false` +
   string `"error"`; extra fields allowed on both.
5. Fire-and-forget commands never elicit any bytes from the server; the server holds
   the connection open until client EOF.
6. `target` beats `pane_id` when both are present on a pane-target command.
7. Label lookups are never global: they require workspace scope (explicit `workspace`
   or implicit caller `pane_id`); UUID lookups are global (narrowed by `workspace`
   when given).
8. Empty-string optional fields (target/workspace/group/profile/…) equal absent.
9. `session_id` on any command except `session-start`/`session-end` also (re)binds the
   pane's session id, carrying the same line's `agent` value — and its `profile`
   value, when present (§3.1).
10. Multiple request lines per connection are processed in order; each allowlisted line
    gets its own reply handle on the same FD (the CLI never does this — the first
    `close()` tears down the FD and orphans the rest).
11. Reply JSON is compact, single-line, key order unspecified; UUIDs uppercase;
    timestamps ISO 8601 UTC, whole seconds (`packages/core/src/codec/timestamps.ts:91`).
12. The `ping` reply is the CLI's version-drift probe: `version`/`build` must reflect
    the running daemon.
13. Writing a reply to a disappeared client must be harmless (no crash, no retry).
14. The server never initiates messages except (a) replies and (b) `web-console`
    follow-stream lines.

---

## 9. Compatibility rationale

These items record the quirks the daemon preserves on purpose, and the few places it
deliberately differs from the pre-port app, so the pre-port `kelpi` CLI, hook scripts and
saved state keep working:

1. **Byte-compat surface.** The compatibility target is: request key names/types,
   command names, guard behavior (what gets dropped vs. errored), the allowlist
   membership, reply framing (one JSON line + EOF), and reply field names/types.
   JSON key order, whitespace, and UUID casing inside replies are *not* load-bearing
   for the current CLI (it JSON-parses replies), but UUIDs stay uppercase anyway:
   scripts built on `--json` output may compare ids textually against values they got
   from earlier replies.

2. **Per-connection line buffering, same framing.** The pre-port server dropped any JSON
   line split across 4096-byte reads. The daemon buffers per connection until `\n`
   (`packages/protocol/src/framing.ts`), a strict superset of the old behavior that makes
   large `web-exec` payloads over TCP work. The per-line cap is 64 MB, deliberately far
   above anything `web-exec --file` or a `pane-send` of large text produces.

3. **Silent drop vs. error replies.** The pre-port app never answered a malformed
   allowlisted request, and the CLI surfaced that as "empty reply (Kelpi version may not
   support this command)" after its 5 s timeout. The daemon replies
   `{"ok":false,"error":…}` to malformed *allowlisted* commands instead
   (`packages/daemon/src/control/server.ts:159-170`); the CLI handles that fine, so the
   experience is strictly better. It still **never** replies to fire-and-forget commands
   (the CLI isn't reading; on some paths it has already closed its socket and the write
   would just EPIPE, harmless but noisy) and never replies to undecodable lines (nobody
   can know whether the sender expects a reply).

4. **Reply-then-close is the EOF contract.** The CLI reads *until EOF*, not until the
   first newline, for ordinary request/response commands. The daemon therefore ends the
   connection after the reply line (`packages/daemon/src/control/reply.ts:77-88`); without
   that every CLI call would hang for the 5 s timeout even though the reply arrived.
   Conversely for `web-console follow` the daemon does NOT close; the CLI disables its
   timeout and loops on lines.

5. **Client-disconnect cleanup.** When a connection dies, any long-lived reply handle
   bound to it (console-follow subscribers; conceptually any future stream) is released
   through the handle's disconnect callbacks so the daemon stops pushing events
   (`packages/daemon/src/control/server.ts:288-293`). Ordinary request handles just become
   no-ops.

6. **Dispatch ordering.** All messages from one chunk are dispatched in order into the
   app core, per connection; the dual-fire `session-start` is processed *after* its
   primary message (`packages/protocol/src/dualfire.ts:56-67`).

7. **The dual-fire quirk** (§3.1) is implemented exactly (it is how session ids stay
   bound across `stop`/`notification`), including the `session-end` exclusion. The daemon
   does not allocate a reply handle for the synthesized event even when the primary
   command is allowlisted; the pre-port app allocated a second, never-answered handle
   there, a latent leak with no observable CLI behavior, so the fix changes nothing on
   the wire.

8. **Type-strict decoding.** The daemon matches the "wrong type poisons the line" behavior
   rather than coercing (`"true"` string is not `true`), except for the
   `pane-move-to-workspace` `text:"true"` create-flag quirk, which is a *string*
   comparison and stays one (`packages/protocol/src/wire/decode.ts`).

9. **`/tmp/kelpi.sock` is a fixed, world-known path with no auth.** The trust model is
   "same UID on the same box" (and note `/tmp` is sticky but the socket is user-owned).
   The path stays because the CLI hardcodes it; the file mode is tightened to `0600`
   (`packages/daemon/src/control/server.ts:34`). TCP stays loopback-only, no auth (tunnels
   provide security). The daemon's WebSocket transport for GUI clients is a *separate*
   protocol surface; this newline-JSON contract holds on the Unix socket and TCP listener
   the CLI uses.

10. **Stale-socket handling.** The pre-port app unlinked the existing socket file
    unconditionally before binding, so a second instance stole the socket from the first.
    The daemon pings the existing socket first and refuses to start when it answers
    (`ECONTROLBUSY`, `packages/daemon/src/control/server.ts:296-320`); only a dead socket
    is unlinked. On shutdown it unlinks only what it bound. `ping`'s `pid` field exists so
    `kelpi doctor` can tell who owns the socket.

11. **Timeout budget.** Handlers reply within ~5 s (default CLI timeout) except the known
    long-poll commands (`web-wait`, `web-exec`: the CLI extends per `--timeout`;
    `workspace-create` with `worktree`: the CLI allows 120 s). Anything async (capture,
    graft git work, web JS evaluation) still sends its reply from the async completion.

12. **Allowlist is by command name only.** A future command that wants a reply must be
    added to the allowlist; conversely nothing in the request opts into a reply. The
    table lives in one place in the daemon (`packages/protocol/src/allowlist.ts`).

13. **Error strings are UX, not API**: the CLI prints them verbatim; scripts branch on
    `ok` (and typed extras like `active_agents`, `found`). Matching the pre-port app's
    wording is nice for doc/tests continuity but only `ok`/field names are contract. One
    exception-ish case: `kelpi web exists` exits 0/1 from the reply's `found` field, so
    field names in web replies matter (see the web-pane subsystem doc).

14. **Enum vocabularies embedded** (`packages/protocol/src/wire/vocab.ts`): agent kinds
    (`claude|codex`, case-insensitive, default claude), split directions
    (`horizontal|vertical`), move directions (`left|right|up|down`), zones
    (`above|below|left-of|right-of`), colors (10 names, §5.5), named keys (§5.6), pane
    types (`shell|markdown|scratchpad|diff|web`), pane statuses
    (`idle|running|waitingForInput`), sync actions (`on|off|toggle|status`), label ops
    (`set|add|remove|clear`), sort keys
    (`name|last-activity|last-accessed|last-modified`, plus their underscore aliases),
    pane-list scopes (`all|current`), capture modes (`meta|text|screenshot|dom|all`),
    graft statuses (`starting|watching|syncing|error`).

15. **`pane-split`/`pane-create` mint the new pane id up front** and return it in the
    reply *before* the pane exists. The daemon does the same (generate the UUID, reply,
    then build) so `kelpi pane split --json | jq .pane_id` keeps returning the real id
    immediately.

16. **`pane-send` replies before delivering keystrokes**: the reply means "target
    resolved and accepted", not "bytes hit the PTY". That ordering is kept; orchestrator
    scripts pipeline `pane send` + `pane send-key` and rely on low latency, not on
    delivery confirmation.

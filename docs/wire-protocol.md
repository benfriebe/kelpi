# Kelpi Wire Protocol — Compatibility Contract

This document specifies the complete IPC wire protocol between the `kelpi` CLI (and agent
hooks) and the Kelpi daemon, as implemented in the TypeScript daemon
(`packages/daemon/src/control/server.ts`, the command handlers under
`packages/daemon/src/handlers/` and `packages/daemon/src/webpane/`, and the decoder and
allowlist in `packages/protocol/src/`). The daemon honors this contract so the **`kelpi` CLI
binary, hook scripts and saved state keep working unchanged** across upgrades.

The sections below specify the established command vocabulary. Plugin extensions use the
additional envelope described here and the [plugin API guide](plugins.md); see the
[roadmap](plugin-roadmap.md) for implementation progress. Where behavior is quirky, the
quirk is documented as-is and explained in "Compatibility rationale" at the end.

## Plugin envelope and protocol generation

The current control/discovery (process) generation is **2**, and the WebSocket (client-sync)
generation is **3**. They were one number until generation 3, which moved the WebSocket one alone:

- **Process generation** (`PROTOCOL_VERSION`, `packages/protocol/src/index.ts`): what `ping`
  and `/healthz` report as `protocol`, and what names the run-dir files (`daemon-v2.sock`,
  `.token`, `.pid`). Moving it makes an updated app start a second daemon beside the running
  one instead of handing it off, so only a change to the control socket or the run dir moves it.
- **WebSocket generation** (`WS_PROTOCOL_VERSION`, `packages/protocol/src/ws/messages.ts`): what a
  client's `hello` must match exactly. A mismatch is refused with `protocol-mismatch` ("daemon
  speaks client protocol v3, client speaks v2; update Kelpi so the app and the daemon run the
  same version"), and the client stops retrying and shows that sentence.
  - 2: plugin pane records.
  - 3: nested workspaces (app-state-core.md §2.9): `childOrder` and `childrenCollapsed` on every
    workspace, and the `nest-workspaces` / `set-workspace-children-collapsed` verbs. A nested
    workspace lives only in its parent's `childOrder`, so a generation 2 client would have no
    row for it; it is refused instead.

The socket wire (this document) is unversioned: new fields and verbs are additive, and the CLI
detects a daemon that predates one from its reply (for nesting, the missing `parent_id` echo
on `workspace-create` and `workspace-list`).

Plugin operations use a known `plugin` command; plugin-defined command/service names are
nested data, not new top-level wire verbs:

```json
{"command":"plugin","action":"list","text":"{}"}
```

The `text` field contains an encoded JSON object. One-shot operations return
`{"ok":true,"result":…}` or `{"ok":false,"error":"…"}` and close the reply. The `watch` action
starts with `{ok, epoch, sequence, state}` and then sends `{ok, event}` lines; disconnect
releases its subscription. The CLI prints one-shot `result` values and retains the watch
envelopes unchanged.
A plugin's own `kelpi <verb>` uses the `cli-list` and `cli` actions of this envelope
([CLI verbs](plugins.md#cli-verbs)); it adds no wire verb.

`plugin init`, `validate` and `pack` run locally without a daemon request. `plugin dev`
validates local snapshots and uses identity-guarded `dev-install` requests. Installation
paths are on the daemon machine; this envelope does not upload packages to remote hosts.
Use the [CLI reference](cli.md#plugin-commands) for public commands and the
[development guide](plugin-development.md) for the private-instance workflow.

Wire decoding, reply allowlisting and dispatch remain explicit in
[decode.ts](../packages/protocol/src/wire/decode.ts),
[allowlist.ts](../packages/protocol/src/allowlist.ts) and
[PluginService](../packages/daemon/src/plugins/service.ts). WebSocket management operations
require the daemon owner; view API calls are bound to their own revocable lease.
Database generation and downgrade constraints are documented in the
[upgrade notes](plugins.md#database-and-protocol-upgrade).

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
  (`KELPID_CONFIG_PATH` overrides the location, `packages/daemon/src/boot/config.ts:48-56`;
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
- `tool_input` (`permission-request`, #388) is the one **object** field: it must be a plain
  JSON object, and an array, a string or any other JSON type fails the decode like any other
  wrong-typed known key.
- Many optional string fields are normalized: **empty string → treated as absent**
  (documented per command; applies to `target`, `workspace`, `group`, `profile`,
  `worktree`, `branch`, `repo`, `scope`, `level`, `send_to`, `domain`, `selector` (for
  `web-key`), `url_match`, `for`, `mode`, `block`, `behavior`, `target_path`). Not `parent` or
  `parent_pane_id` (app-state-core.md §2.9): an empty one is an unset variable far more often
  than a choice, and "no parent" would create a top-level workspace or list every workspace, so
  the handlers refuse it (`parent must name a workspace (got an empty value)`).
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
  (e.g. `active_agents` on the workspace-delete agent-panes refusal).
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
   `workspace-label`, `workspace-mute`, `workspace-rename`, `workspace-icon`, `workspace-color`,
   `group-list`, `group-create`, `group-rename`, `group-delete`, `group-move`, `group-set-repo`,
   `group-reorder`, `group-sort`, `open`, `diff`,
   `pane-close`, `pane-list`, `pane-capture`, `graft-start`, `graft-stop`,
   `graft-status`, `ping`, `restart-old-terminals`, all `web-*` commands, `pane-sync`, `pane-sync-exclude`,
   `pane-send-key`, `pane-send`, `pane-split`, `pane-create`, `pane-name`, `pane-resize`,
   `pane-font-size`, `pane-clear`, `pane-move-adjacent`.
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
plugin, workspace-list, group-list,
pane-list, pane-close, pane-capture, pane-send, pane-send-key,
pane-split, pane-create, pane-name, pane-resize, pane-font-size, pane-clear,
pane-move-adjacent, pane-sync, pane-sync-exclude,
workspace-create, workspace-delete, workspace-nest, workspace-label, workspace-mute, workspace-rename,
workspace-icon, workspace-color,
group-set-repo, group-reorder, group-sort,
graft-start, graft-stop, graft-status,
ping, restart-old-terminals,
permission-request,
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
`group-move`, `layout-cycle`, `layout-select`, `open`, `diff`. For these the wire
behavior is byte-identical to the pre-request/response protocol: the server reads, acts,
and never writes.

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
A `key` that is none of those but is exactly ONE printable ASCII character (`!` to `~`) is a key
too, typed as itself: the phone's quick replies answer an agent's menu with its hotkey (`1`, `y`),
which `pane-send` would deliver inside a bracketed-paste envelope. Anything else →
`{"ok":false,"error":"unknown key '<key>' (valid: <comma-joined list>)"}`, which is also what a
daemon from before single-character keys answers for one.

### 5.7 Pane target resolution (`pane_id` / `target` / `workspace` triple)

Used by `pane-close`, `pane-capture`, `pane-send`, `pane-send-key`, `pane-name`,
`pane-resize`, `pane-font-size`, `pane-clear`, `pane-sync-exclude`, `pane-move-adjacent` (for both `target` and
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
| `permission-request` | R/R | `pane_id`, `tool_name` (non-empty) | `tool_input`, `mcp_server`, `cwd`, `permission_mode`, `session_id`†, `agent`†, `profile`† |
| `pane-split` | R/R | one of `pane_id`/`target`/`workspace` | `direction`, `path`, `name` |
| `pane-create` | R/R | one of `pane_id`/`target`/`workspace` | `path`, `name` |
| `pane-close` | R/R | one of `pane_id`/`target` | `workspace` |
| `pane-name` | R/R | one of `pane_id`/`target`; `name` | `workspace` |
| `pane-send` | R/R | `target`, `text` (non-empty) | `pane_id`, `workspace`, `bare`, `if_revision` |
| `pane-send-key` | R/R | `target`, `key` | `pane_id`, `workspace`, `if_revision` |
| `pane-resize` | R/R | one of `pane_id`/`target`; exactly one of `ratio`/`delta` | `workspace` |
| `pane-font-size` | R/R | one of `pane_id`/`target`; exactly one of `size`/`reset` | `workspace` |
| `pane-clear` | R/R | one of `pane_id`/`target` | `workspace` |
| `pane-move` | F&F | `pane_id`, `direction` | — |
| `pane-move-adjacent` | R/R | `target`, `anchor`, `zone` | `pane_id`, `workspace` |
| `pane-move-to-workspace` | F&F | `pane_id`, `name` | `text` (`"true"` = create), `focus` |
| `pane-list` | R/R | — | `pane_id`, `workspace`, `scope` |
| `pane-capture` | R/R | one of `pane_id`/`target` | `workspace`, `lines`, `scrollback`, `settle_ms` |
| `pane-sync` | R/R | `action` | `pane_id`, `workspace` |
| `pane-sync-exclude` | R/R | `target`, `excluded` | `pane_id`, `workspace` |
| `workspace-list` | R/R | — | `group`, `parent` |
| `workspace-create` | R/R | — | `name`, `path`, `color`, `group`, `profile`, `worktree`, `branch`, `update_main`, `repo`, `muted`, `icon`, `group_defaults`, `parent`, `parent_pane_id`, `focus` |
| `workspace-move` | F&F | `name` | `group`, `index` |
| `workspace-nest` | R/R | `name`, `parent` | `index` |
| `workspace-delete` | R/R | `name` | `force`, `cascade`, `worktree_paths`, `force_worktree_paths`, `prune_worktrees`, `delete_branches`, `batch_ids` |
| `workspace-profile` | F&F | `name` | `profile` |
| `workspace-label` | R/R | `name`, `label_op` | `label_values` |
| `workspace-mute` | R/R | `name` | `muted` |
| `workspace-rename` | R/R | `name`, `new_name` | - |
| `workspace-icon` | R/R | `name` | `icon` |
| `workspace-color` | R/R | `name` | `color` |
| `group-list` | R/R | — | — |
| `group-create` | F&F | `name` | `color` |
| `group-rename` | F&F | `name`, `new_name` | — |
| `group-delete` | F&F | `name` | `cascade` |
| `group-move` | F&F | `name`, `index` | — |
| `group-set-repo` | R/R | `name`; one of `repo`/`repo_id`/`clear`/`create_worktree` | `repo`, `repo_id`, `clear`, `create_worktree` |
| `group-reorder` | R/R | `name` | `order` |
| `group-sort` | R/R | `name`, `by` | `descending` |
| `layout-cycle` | F&F | `pane_id` | — |
| `layout-select` | F&F | `pane_id`, `name` | — |
| `open` | F&F | `path` | `pane_id`, `reuse`, `focus`, `as` |
| `diff` | F&F | `repo_path` | `target_path`, `pane_id`, `focus` |
| `graft-start` | R/R | — | `workspace`, `repo`, `pane_id` |
| `graft-stop` | R/R | — | `workspace`, `repo`, `pane_id` |
| `graft-status` | R/R | — | — |
| `ping` | R/R | — | — |
| `restart-old-terminals` | R/R | — | — |
| `plugin` | R/R | — | `action`, `text` (JSON object encoded as a string; see [plugins](plugins.md)) |
| `web-open` | R/R | `url` (non-empty) | `pane_id`, `private`, `target`, `direction`, `focus`, `gesture` |
| `web-navigate` | R/R | pane-target*; `url` (non-empty) | `gesture`, `typed` |
| `web-url` | R/R | pane-target* | — |
| `web-back` | R/R | pane-target* | `gesture` |
| `web-forward` | R/R | pane-target* | `gesture` |
| `web-reload` | R/R | pane-target* | `hard`, `gesture` |
| `web-capture` | R/R | pane-target* | `mode` |
| `web-tabs` | R/R | pane-target* | — |
| `web-tab-new` | R/R | pane-target* | `url`, `make_active`, `gesture`, `focus` |
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

Optional on `stop` (#387): `last_assistant_message` (string, the text of the agent's final
reply, capped by the CLI at 64 KiB of UTF-8 cut on a code point boundary),
`last_assistant_message_truncated` (bool, sent only as `true` when the CLI cut the text;
ignored without a message) and `transcript_path` (string). Empty strings read as absent.

```json
{"command":"stop","pane_id":"1B4E…","session_id":"abc-123","last_assistant_message":"Done.","transcript_path":"/Users/me/.claude/projects/-work-app/abc-123.jsonl"}
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

Optional on `notification` (#387): `notification_type` (string, Claude's
`permission_prompt`, `idle_prompt`, `elicitation_dialog`, …), `transcript_path` (string) and
`tool_name` (string, the tool a Codex PermissionRequest asks about; sent only with
`agent:"codex"`). Empty strings read as absent.

```json
{"command":"notification","pane_id":"1B4E…","title":"Claude Code","body":"Claude needs your permission to use Bash","notification_type":"permission_prompt","transcript_path":"/Users/me/.claude/projects/-work-app/abc-123.jsonl"}
{"command":"notification","pane_id":"1B4E…","title":"Codex","body":"Approval requested: Bash","agent":"codex","tool_name":"Bash"}
```

**`session-start`** — bind an agent session id to the pane. `session_id` required
non-empty; `agent` optional (§5.1); `profile` optional (the CLI's effective
`KELPI_PROFILE`, empty treated as absent — recorded so a resume can rebuild the
session's environment, agent-lifecycle.md §6.1; absent keeps the pane's last-known
value).

```json
{"command":"session-start","pane_id":"1B4E…","session_id":"3f2a…","agent":"claude","profile":"work"}
```

Optional on `session-start` (#387): `transcript_path` (string, empty treated as absent).

The #387 hook fields are forwarded by `kelpi event` only when the hook's stdin carries them
(agent-lifecycle.md §3). `notification_type` and `last_assistant_message` are Claude-only:
they come from Claude Code's documented hook payloads, and a Codex payload is forwarded the
same way only if it carries the same keys. `transcript_path` is common to both agents'
payloads; `tool_name` is forwarded only from Codex.

**`session-end`** — the session ended; the app clears the pane's tracked session id
(and the profile recorded beside it, agent-lifecycle.md §5.6) **only if it still
matches** `session_id` (required non-empty). Never dual-fires.

```json
{"command":"session-end","pane_id":"1B4E…","session_id":"3f2a…"}
```

---

### 6.1.1 `permission-request` (R/R)

Sent by `kelpi event permission-request` from Claude Code's `PermissionRequest` hook (#388).
It is the one agent hook verb that gets a reply: the daemon asks the selected
`kelpi.agent.permissions` provider ([plugin-services.md](plugin-services.md)) for a decision
and answers with it, so the CLI can print Claude's decision JSON. Because the verb is
allowlisted, a missing or invalid `pane_id` is answered with `{"ok":false,…}` rather than
dropped.

| field | type | req/opt | notes |
|---|---|---|---|
| `pane_id` | string (UUID) | req | `KELPI_PANE_ID` |
| `tool_name` | string | req | non-empty; without it the line is rejected (`permission-request requires tool_name`) |
| `tool_input` | object | opt | the tool's arguments; absent or `null` reads as `{}`; any other type rejects the line (§2.2) |
| `mcp_server` | string | opt | MCP tools only |
| `cwd` | string | opt | the hook's working directory |
| `permission_mode` | string | opt | Claude's permission mode (`default`, `acceptEdits`, …) |
| `session_id` | string | opt | the hook's session id; the provider is told this one, and the pane's bound session only when it is absent |

The optional strings read an empty string as absent. `session_id`, `agent` and `profile` ride
along as on any hook event, and the dual-fire (§3.1) applies; the daemon reads the agent kind
from the pane, not from the line. The session id it tells the provider is the line's own when
present, since the dual-fire binds it to the pane only after the handler ran, and a provider that
remembers grants per session would otherwise hear the previous session's id after a missed
SessionStart.
`kelpi event permission-request` itself sends only `session_id` and `profile` of the three,
`profile` only beside `session_id` (cli.md §8.7).

```json
{"command":"permission-request","pane_id":"1B4E…","tool_name":"Bash","tool_input":{"command":"mv a b","description":"Rename a"},"cwd":"/work/app","permission_mode":"default","session_id":"abc-123"}
```

Reply: `{"ok":true,"behavior":"allow"|"deny"|"abstain","message"?:string,"provider"?:string}`.

- `behavior` is the provider's decision. `abstain` means no decision: the CLI prints nothing and
  Claude shows its own prompt.
- `message` is passed through only on `deny`, when the provider gave one.
- `provider` is the id of the provider the daemon asked: `kelpi.agent.permissions.bundled`
  (which always abstains) or the selected plugin provider's id.
- The daemon waits at most **2 s**. A provider that times out, throws or returns a malformed
  result is answered as `abstain`, with one warning line in the daemon log naming the provider
  and the reason. Nothing but the provider's own `allow` is ever answered as `allow`.
- The deadlines form one ladder, each shorter than the next: the provider gets 2 s, the CLI's
  reply read times out after 3 s of silence and its guard ends the process at 3.5 s, and
  Claude's own hook timeout (installed as `"timeout": 5`) is 5 s.
  The 2 s bounds the provider only: a plugin `before` operation hook matching
  `permission-request` or `*` runs before the handler for up to 5 s, so the CLI's 3.5 s guard
  and Claude's 5 s timeout are what bound the whole request, and both fail open to the prompt.
- Each decision, fallbacks included, is also published to plugins as one `agent.event` of
  type `permission-request` after the reply (agent-lifecycle.md §7.7); an unknown pane, or
  one whose agent events are muted (#372), publishes none.
- A pane no workspace owns (the parked-inclusive lookup, as for §6.1): `{"ok":false,"error":"unknown pane"}`.
- A pane whose agent events are muted while its terminal restarts on a new host (#372):
  `{"ok":true,"behavior":"abstain"}`, without asking any provider.

```json
{"ok":true,"behavior":"allow","provider":"example.policy.permissions"}
{"ok":true,"behavior":"deny","message":"rm -rf is never allowed","provider":"example.policy.permissions"}
{"ok":true,"behavior":"abstain","provider":"kelpi.agent.permissions.bundled"}
```

---

### 6.2 Pane commands

#### `pane-split` (R/R)

Split an existing pane. Anchor precedence in the handler: `target` (name-or-UUID) >
`workspace` (split that workspace's focused/first pane) > caller `pane_id`. Guard: at
least one of `pane_id` (valid UUID) / `target` / `workspace` present.
`direction`: `"horizontal"`/`"vertical"` (invalid → absent → handler default).
`path` = new pane's working directory; `name` = new pane's label.
`focus` (bool, default false, issue #295): `true` moves focus to the new pane; absent or
false opens it in the **background** (the workspace's focused pane and focus history do not
change, and the source pane is not focused first). The GUI sends `true` for its own gestures;
the CLI sends it only with `--focus`. See §9 item 17.

```json
{"command":"pane-split","pane_id":"1B4E…","direction":"horizontal","path":"/tmp","name":"worker"}
{"command":"pane-split","pane_id":"1B4E…","name":"worker","focus":true}
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
the caller's `pane_id`. Same reply shape as `pane-split`, and the same `focus` field with the
same background default (the first pane of an empty workspace takes its focus regardless).

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

`if_revision` (int, optional, 0 allowed) makes the send conditional on the screen. After
target resolution the daemon compares it with the pane's current screen revision (see
`pane-capture`), and the comparison and the write happen in the same synchronous handler
turn. On a mismatch nothing is written and the reply is
`{"ok":false,"error":"screen changed","code":"SCREEN_CHANGED","revision":<current>}`. On a
match the ack gains `revision` (the matched value), so a caller can tell a daemon that
honoured the guard from an older one that ignored the unknown field. Without `if_revision`
the request and reply are exactly as above.
An `if_revision` no revision can equal (a negative one) answers `SCREEN_CHANGED`, not a
validation error.

```json
{"command":"pane-send","target":"worker","text":"y","bare":false,"if_revision":42}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main","bare":false,"revision":42,"label":"worker"}
{"command":"pane-send","target":"worker","text":"y","bare":false,"if_revision":41}
→ {"ok":false,"error":"screen changed","code":"SCREEN_CHANGED","revision":42}
```

#### `pane-send-key` (R/R)

Deliver one named keystroke, or one printable character (§5.6), outside any bracketed-paste
envelope. Key name is
lowercased then validated **before** target resolution. Byte-mapped keys
(enter/tab/escape/space/backspace/ctrl-c) are injected as their raw byte through the
key-event path (so ctrl-c → `0x03` → SIGINT); arrow keys are translated per terminal
mode (DECCKM).

```json
{"command":"pane-send-key","target":"worker","workspace":"beta","key":"enter"}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"beta","key":"enter","label":"worker"}
```

`if_revision` works as on `pane-send`: key validation stays first, then target resolution,
then the revision check, then the ack (with `revision` on a match) and the key. A stale value
answers the same `SCREEN_CHANGED` reply and sends nothing.

```json
{"command":"pane-send-key","target":"worker","key":"enter","if_revision":42}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main","key":"enter","revision":42,"label":"worker"}
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

#### `pane-font-size` (R/R)

Give the resolved terminal pane a text size of its own, or drop it (config-keybindings.md
§7.6). Guard: pane-target triple AND **exactly one** of `size` (integer, 8-32: the Appearance
tab's Font size row's range) / `reset` (`true`) — both, neither, or a `size` out of range is
answered `{"ok":false,"error":"pane-font-size requires exactly one of size / reset"}` (or
`pane-font-size size must be 8-32`) and the connection is closed. The handler refuses a pane
that does not render a terminal (`pane <id> is not a terminal pane`): a shell does, and so does
a markdown pane while an external `$EDITOR` runs in it. The size is stored on the pane
(`Pane.terminalFontSize`, persisted; pane-layout.md §13.2), so every viewer draws the pane at it
and it survives a restart; `reset` stores null, and the pane follows the daemon-wide ghostty
`font-size` again. `font_size` in the reply is what was stored (`null` after a reset). The
window's ⌘= / ⌘- / ⌘0 send this under `font-size-scope = pane`; the window does the arithmetic,
so the wire carries a finished size, never a step
(`packages/daemon/src/handlers/pane/font-size.ts`).

```json
{"command":"pane-font-size","target":"coordinator","workspace":"main","size":16}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main",
   "label":"coordinator","font_size":16}
```

#### `pane-clear` (R/R)

Clear the resolved terminal pane's screen and scrollback: the window's ⌘K (`clear_screen`,
config-keybindings.md §4), which is Ghostty's macOS `clear_screen`. Guard: the pane-target
triple. The handler refuses a pane that does not render a terminal (`pane <id> is not a
terminal pane`), as `pane-font-size` does.

The daemon clears the pane by putting VT sequences into the pane's **output** stream, so the
daemon's own screen (what `pane capture` and a reattach read), every attached client and every
plugin subscriber see one clear at one point in the stream. What it sends follows Ghostty's
`Termio.clearScreen`:

- **Alternate screen**: nothing. A full-screen app owns that grid; `cleared` is `false` and
  `reason` is `"alternate-screen"`.
- **The pane's shell is in the foreground** (its own process group holds the terminal and it is
  a shell with a line editor: zsh, bash, fish, tcsh, nushell): the screen and scrollback are
  erased and the shell is sent a form feed (`0x0c`, ⌃L) so it redraws its prompt, and whatever
  had been typed at it, at the top. The ⌃L goes to that pane only, never to a synchronised-input
  sibling.
- **Anything else** (a command is running, or the shell cannot be identified): the scrollback is
  erased and the rows above the cursor are REMOVED, as Ghostty's `eraseActive` removes them: the
  cursor's row becomes the top row, what is below it moves up with it, and the cursor moves with
  its row (scroll up, then cursor up, by the cursor's row). Nothing is typed at the program.

```json
{"command":"pane-clear","target":"worker","workspace":"main"}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main",
   "label":"worker","cleared":true}
```

#### `pane-move` (F&F)

Directional move of the **caller** pane. `pane_id` and `direction`
(`left|right|up|down`) both required; invalid direction drops the message. `focus` (bool,
default false, issue #295): `true` focuses the caller first and leaves it focused; absent
moves it in the background. The GUI's move key bindings send `true`; the CLI only with
`--focus`.

```json
{"command":"pane-move","pane_id":"1B4E…","direction":"left"}
```

#### `pane-move-adjacent` (R/R)

Re-parent pane `target` onto an edge of pane `anchor` (the CLI form of GUI
drag-and-drop). `target` + `anchor` (both name-or-UUID) + `zone`
(`above|below|left-of|right-of`) required; `pane_id` only scopes label lookup.
`anchor` must resolve within the moved pane's workspace; anchor==target is refused
(`"cannot move a pane adjacent to itself"`). `focus` (bool, default false, issue #295):
`true` focuses the moved pane; absent docks it in the background. GUI drag-to-dock sends
`true`; the CLI only with `--focus`.

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
lenient resolver (§5.8; `packages/daemon/src/handlers/pane/geometry.ts:187-190`). `focus`
(bool, default false, issue #298): absent moves the pane in the **background**, so no window
is revealed to the destination and the daemon's active workspace stays; `true` (the window's
"Move to workspace", `kelpi pane move-to-workspace --focus`) follows the pane there. One
exception: when the moved pane is the focused pane of the active workspace (the pane the user
is typing in), the move follows it even without `focus`, so the keystrokes stay in its PTY.

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
`id` (uppercase UUID), `type` (`shell|markdown|scratchpad|diff|csv|web`), `workspace_id`,
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
(`input.ts:199-209`).

`settle_ms` (int, optional) waits for the pane to go quiet before the read: the reply is
held until the pane has had no output for `settle_ms`, counted from when the request is
handled and restarted by every byte that arrives. Values above 10000 are clamped to 10000
(the cap is `CAPTURE_SETTLE_CAP_MS`); a value <= 0 fails with
`settle_ms must be a positive integer (got N)` after the `lines` check and before the target
is resolved. If the cap is reached first the read happens anyway, at the cap.

The reply always carries three more fields next to `text`, all read in the same synchronous
turn as the text (after the flush): `revision` (int, the pane's screen revision),
`cursor` (`{"row":<int>,"col":<int>}`, 0-based, viewport-relative, on the active screen) and
`alt_screen` (bool, whether the alternate screen is active). `settled` (bool) is present only
when `settle_ms` was sent: `true` when the pane was quiet for `settle_ms`, `false` when the
cap came first or the pane's terminal was restarted during the wait.

```json
{"command":"pane-capture","target":"worker","settle_ms":500}
→ {"ok":true,"pane_id":"<uuid>","workspace_id":"<uuid>","workspace_name":"main",
   "text":"…terminal contents…\n","revision":42,"cursor":{"row":23,"col":2},
   "alt_screen":false,"settled":true,"label":"worker"}
```

The revision is a per-pane counter that rises by 1 on every output feed with non-empty data
(counted when the bytes are queued, not when they are parsed), on every restore of a
non-empty snapshot, and on every resize that changes the grid. Within one daemon run a pane id
never repeats a revision: the daemon seeds new terminal state (attach, or the lazy create on
first feed) one past every revision it has issued, so a pane whose terminal state is disposed
and created again (restart old terminals, a forgotten shell) carries on above its old values.
A pane with no terminal state reads 0. It is not persisted, but a new daemon seeds its counter
from the clock (milliseconds since the epoch at start, a 13-digit safe integer), past any value
an earlier daemon could plausibly have issued, so a revision captured before a restart (terminal
host handoff, in-app update) is refused with `SCREEN_CHANGED` rather than matching a live screen
by accident. That is not a hard guarantee: a daemon that averaged more than one revision a
millisecond over its life, or a clock that stepped back between the two, could leave the new seed
inside the old range. Pass it back as `if_revision` on `pane-send` / `pane-send-key` to type
only if nothing has reached the screen since this capture.

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
`pane sync requires --workspace or KELPI_PANE_ID` (`packages/daemon/src/handlers/pane/sync.ts:28`).
The caller lookup is
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

`parent` (optional name-or-id) scopes to the workspaces nested under that one (app-state-core.md
§2.9), in sidebar order; an unknown or ambiguous parent → the `workspace-delete` resolution
errors (`workspace not found: <name>` / `workspace name is ambiguous: <name> (use the id)`); an
empty or whitespace one → `parent must name a workspace (got an empty value)`. A filtered reply
echoes the resolved parent as top-level `parent_id` and `parent_name`. A daemon that predates
nesting ignores `parent` and lists every workspace without them, which is how `kelpi workspace
list --parent` and the plugin SDK refuse its reply instead of passing everything on.
A nested workspace is listed directly after its parent, collapsed or not, and with `group` it is
listed with its parent's group.

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
     "labels":["wip"],"muted":false,
     "last_activity_at":"2026-08-18T08:59:00Z",
     "agent_session_id":"3f2a…",
     "group_id":"<uuid>","group_name":"projects"}]}
```

Always-present per entry: `id`, `name`, `color`, `pane_count`, `is_active`,
`created_at`, `last_accessed_at`, `labels` (array, possibly empty), `muted` (bool; see
`workspace-mute`). Conditionals: `icon` (the flat DB spelling, `"emoji:🔥"` /
`"system:star"`; absent for the letter avatar),
`last_activity_at` (max across panes; absent when no panes), `agent_session_id`
(first pane carrying one), `group_id`/`group_name` (absent for top-level; a nested workspace
reports its parent's group), `parent_id`/`parent_name` (the workspace it is nested under,
app-state-core.md §2.9; absent when not nested), `repos` (the
workspace's repo associations in stored order, each `{"repo_id", "repo_name", "repo_path",
"worktree_path", "branch"}` with `repo_name`/`repo_path` absent when the repo left the
registry and `branch` absent when unknown; the whole field is absent when there are none).

#### `workspace-create` (R/R)

All fields optional. `name` defaults to `"Workspace"`; `path` seeds the first pane's
cwd; `color` per §5.5 (invalid/absent → random); `group` creates the group if missing
(unless `worktree` is set — then the group must already exist); `profile` assigns a
workspace profile (empty string = none); `muted` (bool, default false) creates the
workspace already muted, so its first pane never raises an attention signal (see
`workspace-mute`). Every success reply carries `muted`, the state the workspace was created
in, so a caller that asked for `muted` can tell a daemon that predates it (which drops the
unknown field and creates the workspace unmuted); `kelpi workspace create --muted` then exits
non-zero. `icon` creates the workspace with that sidebar icon, spelled and validated as for
`workspace-icon`; one that is refused fails the whole create before anything is made (no
workspace, group or worktree). A success reply carries `icon` only when one was set, so
`kelpi workspace create --icon` can tell a daemon that predates it in the same way. Worktree flow (all empty strings normalized to
absent): `worktree` = worktree/folder name to create, `branch` (defaults to the
worktree name), `update_main` (bool: fetch and branch off `origin/<default>`; absent means
the group's `createWorktree` switch when the workspace goes into a group that has one on,
else false), `repo` = source repo path (the handler falls back to the group's default
repository, then to `path`, and only when all are absent or blank →
`{"ok":false,"error":"--worktree requires a source repo (pass --repo <path>)"}`). The `kelpi`
CLI sends `repo` whenever `--repo` is given; with `--group` and no `--repo` it sends its cwd
as `path` instead, so the group's repository is preferred and the cwd is the fallback.

Focus (issue #307): `focus` (bool, default false). Absent creates the workspace in the
**background**: no window is revealed to it and the daemon's `lastActiveWorkspaceID` (what
`workspace-list` calls ACTIVE) does not move, so the daemon and the windows keep agreeing by
moving neither. The new row is appended to the end of its scope (the parent's children, the
group, or the top level) whatever `new-workspace-placement` says, and a collapsed group or
parent still opens so the row is visible; the windows scroll their sidebar to it and highlight
it briefly. When no workspace is active at all, the new one becomes active anyway. `true` (the
window's own gestures, `kelpi workspace create --focus`) switches as before: the new workspace
becomes active and a `reveal-pane` is broadcast to every window. This applies on every branch
(plain, group, repository, worktree).

Group defaults (app-state-core.md §5.5): `group_defaults` (bool, default true) applies the
group's default repository to whatever the request leaves unsaid, for a group that already
exists. Without `worktree`, a `repo` (explicit, or the group's) is resolved to a registered
repository (registered if new; a path inside a linked worktree registers its parent), the
workspace starts with it associated, and the first pane opens in that checkout unless `path`
is given; the reply then comes AFTER the effect and carries `repo_path`. A `repo` that is not
inside a git repository (and is not already registered) → `{"ok":false,"error":"<path> is not
inside a git repository"}`, with nothing created. The New Workspace sheet sends
`"group_defaults":false`: it has already shown the group's defaults and sends the user's
final choice, including "no repository". The worktree reply also carries `update_main` (the
value used) and `repo_path` (the source repository).

```json
{"command":"workspace-create","name":"Test","color":"blue","group":"projects"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"Test","muted":false,"group":"projects"}

{"command":"workspace-create","name":"feat-x","worktree":"feat-x","branch":"feat-x",
 "update_main":true,"repo":"/Users/ben/code/kelpi"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x",
   "worktree_path":"/…/worktrees/feat-x","branch":"feat-x","update_main":true,
   "repo_path":"/Users/ben/code/kelpi","muted":false}

{"command":"workspace-create","name":"fix-y","group":"kelpi","worktree":"fix-y","path":"/Users/ben"}
→ (group "kelpi" has repo /Users/ben/code/kelpi with createWorktree on: the worktree
   branches off the freshly fetched origin/<default> of that repo, and the reply says
   "update_main":true,"repo_path":"/Users/ben/code/kelpi")
```

With `update_main` true, the branch is always created (`-b`), so a branch name that already
exists is refused before the fetch: `{"ok":false,"error":"branch '<name>' already exists, and
update main always creates a new branch off origin/<default>: choose another worktree or
branch name, or turn off update main to check out the existing branch"}` (graft-git.md §8.5).

Ambiguous `group` name → `{"ok":false,"error":"group name is ambiguous: <name> (use
the id or rename an existing group)"}`. With `worktree`, an unknown group →
`{"ok":false,"error":"unknown group: <name> — --worktree only supports existing
groups; create it first (`kelpi group create`) or omit --group"}`. Worktree git failures
→ `{"ok":false,"error":"<git error text>"}`. The CLI reads this command with a 120 s
timeout when `worktree` is set (slow `git fetch` is not a spurious failure).

The control-socket reply above is the whole contract, and it did not change with issue #294.
Over the WS sync socket (which carries the same request object in a `command` frame), a
worktree create additionally streams `command-progress` frames to the connection that sent it,
keyed by that frame's `id`, every one before the `command-reply` and none after it:
`{"type":"command-progress","id":"<command id>","progress":{"kind":"worktree-create",
"steps":[{"id":"fetch","status":"running","percent":45,…},…],"cancelled"?:true}}`
(graft-git.md §8.5.1 has the step shapes; a create that cannot report steps sends one frame
with `"steps":[]` and `"detailed":false`, and cannot be cancelled). A WS create may also carry `request_id` (a short
client-minted string, read by the WS session before this decoder and never a control-socket
field), which the WS-only `workspace-create-cancel {request_id}` from the same connection uses
to cancel it: the create then fails with `{"ok":false,"error":"worktree create cancelled"}`
after removing the partial worktree and branch (graft-git.md §8.5.2). A second create for a
worktree path or branch that another create of the same repository is still making fails at once
with `another create is already making …` (any transport). A client that predates
either ignores the unknown frame type and gets the reply as before.

Names are sanitized before any git work: an unusable `worktree` →
`{"ok":false,"error":"\"<name>\" isn't a usable worktree name"}`, an unusable `branch` →
`{"ok":false,"error":"\"<branch>\" isn't a usable branch name"}`
(`packages/daemon/src/handlers/app/workspaces.ts:260-272`). The `group` token is trimmed
(`workspaces.ts:232`), and the worktree reply also carries `group` when the workspace was
placed in one (`workspaces.ts:352-358`).

Nesting (app-state-core.md §2.9): `parent` (workspace name-or-id) creates the workspace nested
under that one; `parent_pane_id` (a pane UUID; `kelpi workspace create --nested` forwards
`KELPI_PANE_ID`) nests it under the workspace holding that pane. Both are checked before
anything is created, on every branch (plain, repository, worktree): both given →
`give either parent or parent_pane_id, not both`; with `group` →
`a nested workspace follows its parent's group: pass a parent or a group, not both`; an unknown
or ambiguous `parent` → `parent workspace not found: <name>` /
`parent workspace name is ambiguous: <name> (use the id)`; an empty or whitespace `parent` →
`parent must name a workspace (got an empty value)` (and `parent_pane_id` → `parent_pane_id
must name a pane (got an empty value)`); an unknown pane →
`no pane matches '<id>', so there is no workspace to nest under`; a parent that is itself nested
→ `'<name>' is nested itself; workspaces nest one level deep`. A nested create takes the group
defaults (§5.5 repository and worktree switch) from the parent's group, and never creates a
group. Every success reply of a nested create carries `parent_id` and `parent_name`, what the
store holds, so a caller can tell a daemon that predates nesting (which drops both fields and
creates the workspace at the top level); `kelpi workspace create --parent/--nested` then exits
non-zero.

The repository and worktree branches check the parent again once their git work is done, since
it can be deleted (or nested under another workspace) meanwhile. The repository branch has made
nothing yet, so it fails whole: `parent '<name>' was deleted while the workspace was being
created`, or `parent '<name>' changed while the workspace was being created: <refusal>`. The
worktree branch already has its worktree, so (like a cancel that arrives after git, graft-git.md
§8.5.2) it completes, at the top level, and the reply adds `"parent_lost": true` and
`parent_lost_reason` (the same sentence) in place of `parent_id`. The CLI exits non-zero with
that sentence, and the plugin SDK rejects with `PARENT_LOST`.

```json
{"command":"workspace-create","name":"worker-1","parent":"orchestrator"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"worker-1","muted":false,
   "parent_id":"<uuid>","parent_name":"orchestrator"}
```

#### `workspace-nest` (R/R)

`name` (required non-empty) = workspace name-or-id; `parent` (required) = the workspace to nest it
under, name-or-id; `index` (int, optional) = position among the parent's nested workspaces after
removal (absent = append). Nests the workspace one level deep, or reorders it within its parent.
Request/response, unlike `workspace-move`, because nesting can be refused and the caller needs the
reason (app-state-core.md §2.9): unknown/ambiguous `name` → the `workspace-delete` resolution
errors; unknown/ambiguous `parent` → the same, prefixed `parent `; the parent is nested itself →
`'<name>' is nested itself; workspaces nest one level deep`; an empty or whitespace `parent` →
`parent must name a workspace (got an empty value)`; the workspace has nested workspaces
of its own → `'<name>' has nested workspaces; workspaces nest one level deep`; the two are the
same → `'<name>' cannot be nested under itself`. Un-nesting is `workspace-move`.

```json
{"command":"workspace-nest","name":"worker-2","parent":"orchestrator","index":0}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"worker-2",
   "parent_id":"<uuid>","parent_name":"orchestrator","index":0}
```

#### `workspace-move` (F&F)

`name` (required non-empty) = workspace name-or-id. `group` = destination group name
(nil / empty = top level); `index` (int) = position. A nested workspace is taken out of its
parent (app-state-core.md §2.9); nesting is `workspace-nest`. No reply; resolution failures
no-op silently.

```json
{"command":"workspace-move","name":"Test","group":"projects","index":0}
```

#### `workspace-delete` (R/R)

`name` (required non-empty) = workspace name-or-id; `force` (bool, default false);
`cascade` (bool, default false; app-state-core.md §2.9) also deletes the workspaces nested under
it: their panes are closed with the parent's, the last-workspace guard counts them, the agent
guard sums their agents with the parent's (the error then reads `workspace <name> and its nested
workspace(s) have …`), worktree cleanup treats each as an owner of its own worktrees, and the
success reply carries `deleted_children` (their ids) and `deleted_child_names` (their names, index
for index), so a caller deleting several targets can tell one this cascade already took from one
that never existed. Without `cascade` they move into the deleted
workspace's sidebar slot. Refusals: last remaining workspace; ambiguous name; unknown name; agent-panes guard
without force (running, waiting for input, or idle with a bound session, including
parked panes; see agent-lifecycle §11) —

```json
{"command":"workspace-delete","name":"feat-x","force":false}
→ {"ok":false,"error":"workspace feat-x has 2 running agents; pass --force to delete anyway",
   "active_agents":2,"running":2,"waiting":0,"inactive":0}
```

Success (`path` = a shell pane's cwd, else the first pane's cwd, absent for an empty
workspace; kept for scripts, and for a CLI talking to a daemon that predates the worktree
fields below):

```json
{"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x","path":"/…/worktrees/feat-x"}
```

**Worktree cleanup** (graft-git.md §8.7). Optional fields ask the daemon to remove linked
worktrees with the workspace, on its own host:

- `worktree_paths` (string[]): the worktrees to remove, by path as the window's preview named
  them (the delete dialog's ticked rows). Only a worktree that this workspace, or a workspace
  of its batch, had a repo association for is planned;
- `force_worktree_paths` (string[]): of `worktree_paths`, the ones the user agreed to lose
  uncommitted changes in. Removed with `git worktree remove --force` when uncommitted
  changes (modified or untracked files) are the ONLY thing keeping them; never one another
  workspace uses, one with another worktree inside it, or a detached HEAD holding commits no
  branch has, and never a locked one. The entry then carries `discarded_changes` (the count).
  Ignored with `prune_worktrees`, which never forces, and while a plugin provider owns
  `kelpi.git`;
- `prune_worktrees` (bool, default false): every worktree Kelpi made (directly inside the
  worktree base path) that this workspace or its batch had a row for, or a shell in when it
  was deleted, and that is safe to remove; any other worktree is left alone and not listed.
  The CLI's `--prune-worktree` and the window's `remove` setting;
- `delete_branches` (bool, default false): also delete each removed worktree's branch, when
  every commit on it is reachable from another branch, a remote-tracking ref or a tag and it
  is not the branch `origin/HEAD` names;
- `batch_ids` (string[]): workspaces deleted EARLIER in the same gesture (a bulk or group
  delete sends its cleanup on the last delete, after the others have replied). Their rows,
  shells and pane exits count as this delete's. Only workspaces the daemon actually deleted in
  the last two minutes count, each once; any other id is ignored, so a workspace a plugin hook
  kept is still there, and still counts as using its worktrees.

The guards and the delete itself are unchanged. With `worktree_paths` or `prune_worktrees`
present, the reply is sent **after** the git work rather than before the effect: the panes are
killed, the workspace is deleted and persisted, then (once its panes and its batch's have
exited, at most 2 s each) the rows are planned against the state as it is then and each
worktree the plan allows is removed with a non-forcing `git worktree remove`:

```json
{"command":"workspace-delete","name":"feat-x","force":true,"worktree_paths":["/…/worktrees/feat-x"],"delete_branches":true}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x","path":"/…/worktrees/feat-x",
   "worktrees":[{"association_id":"<assoc-uuid>","worktree_path":"/…/worktrees/feat-x",
                 "branch":"feat-x","removed":true,"branch_deleted":true}]}
```

Entry fields: `association_id` (absent for a worktree planned from a shell's cwd),
`worktree_path`, `branch` (absent on a detached HEAD), `removed` (bool), `discarded_changes`
(a forced removal: how many uncommitted changes went with it), `blocked` (when the
plan kept it: `shared`, `nested`, `dirty`, `unreadable` or `detached-commits`), `error` (why
not, in words: the plan's reason, or git's own refusal such as a lock), and with
`delete_branches`, `branch_deleted` (bool) and `branch_error`. With `worktree_paths`, a named
row that is not a linked worktree answers `"error":"the main checkout, not a worktree"` (or
"not a linked worktree …"), and a path no deleted workspace had a row for answers
`"error":"not a worktree of the deleted workspaces"`. A workspace with nothing to prune
answers `"worktrees":[]`. A failed removal never fails the reply: the workspace is gone
either way.

The CLI performs bulk delete as one request per id.

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

#### `workspace-mute` (R/R)

`name` (required non-empty) = workspace name-or-id; `muted` (bool) = the new state, and
absent toggles the current one. A muted workspace's agents keep their pane status but raise
no attention signal: the daemon marks their `notification` / `attention-request` broadcasts
`muted: true` and hands them to plugin observers only, so no such message reaches a window
session; plugin views see them inside `plugin-event` and must honour the flag
(agent-lifecycle.md §7.6). The reply carries the post-mutation state. Unknown or ambiguous
workspace → `{"ok":false,"error":"no workspace matches '<name>'"}`.

```json
{"command":"workspace-mute","name":"feat-x","muted":true}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x","muted":true}

{"command":"workspace-mute","name":"feat-x"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x","muted":false}
```

This is request/response, unlike the fire-and-forget `workspace-profile`: a toggle has to
report the state it produced, and a caller scripting a fan-out needs an error when the name
does not resolve.

#### `workspace-rename` (R/R)

`name` (required non-empty) = workspace name-or-id (§5.8, strict); `new_name` (required
non-empty) = the name to give it. The CLI's spelling of the sidebar's inline rename (⇧⌘R), with
the same rules (`packages/daemon/src/handlers/app/workspaces.ts` ▸ `handleWorkspaceRename`):
`new_name` is trimmed, whitespace only is refused, there is no length or character limit, and
a name another workspace already has is allowed (a later name lookup then reports the
ambiguity). The reducer recomputes the workspace's slug and the rename reaches every attached
client through the ordinary store delta. The reply names the workspace by id and carries the
name it has now (`workspace_name`) and the one it had (`old_name`); renaming to the current
name succeeds without writing anything, and the two are then equal.

```json
{"command":"workspace-rename","name":"feat-x","new_name":"auth refactor"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"auth refactor","old_name":"feat-x"}
```

Refusals: `{"ok":false,"error":"workspace not found: <name>"}`, `{"ok":false,"error":"workspace
name is ambiguous: <name> (use the id)"}` (the same two messages as `workspace-delete`), and
`{"ok":false,"error":"workspace name cannot be empty"}` for a whitespace-only `new_name`. An
absent or empty `new_name` fails the decoder guard and, the command being allowlisted, is
answered `{"ok":false,"error":"workspace-rename requires new_name"}` (§2.1).

It is request/response, unlike `group-rename`, so an agent learns whether the name resolved
and what the workspace is called now. The GUI does not use it: the sidebar keeps its WS-only
`rename-workspace`, which addresses the workspace by id (`packages/daemon/src/ws/sync.ts`).
Against a daemon that predates the verb, the line names an unknown command and is dropped
without a reply (§2.1), which the CLI reports as "no response from Kelpi (upgrade required?)"
with exit 1.

#### `workspace-icon` (R/R)

`name` (required non-empty) = workspace name-or-id (§5.8, strict); `icon` = the sidebar icon
in the flat spelling the DB stores, `"emoji:<grapheme>"` (or `"system:<symbol>"`), and absent
or `null` clears it back to the workspace's first letter. The CLI's spelling of the sidebar's
Change Icon / Reset to Letter, validated the way the GUI's WS-only `set-workspace-icon` is
(`iconRefusal` in `@kelpi/core/codec`): an `emoji:` payload must be exactly one grapheme of at
most 16 code points that passes the emoji heuristic, so a ZWJ sequence (`👩‍🍳`), a flag or a skin
tone is one icon and `emoji:a` or `emoji:🔥🔥` is refused; a `system:` name is an opaque token of
at most 128 characters. The icon reaches every
attached client through the ordinary store delta. Setting the icon the workspace already has
succeeds without writing anything; the reply's `old_icon` (the icon before) then equals `icon`.

```json
{"command":"workspace-icon","name":"feat-x","icon":"emoji:👩‍🍳"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x","icon":"emoji:👩‍🍳","old_icon":null}
{"command":"workspace-icon","name":"feat-x"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x","icon":null,"old_icon":"emoji:👩‍🍳"}
```

Refusals: `workspace not found: <name>` and `workspace name is ambiguous: <name> (use the
id)` (as for `workspace-rename`), `'<x>' is not an icon: give emoji:<emoji> or
system:<symbol>` for a string that is not in the flat spelling (the empty string included:
unlike the WS-only verb, which reads anything unparseable as "clear", a script that sent a
string meant to set something), `'<grapheme>' is not a usable icon: give one emoji or
symbol` for an `emoji:` payload the heuristic refuses, `the icon is too long: give one emoji or
symbol` for one grapheme of more than 16 code points (not echoed back), and `the symbol name is
too long: at most 128 characters`.

Group icons have no such verb: they stay a sidebar gesture (socket-handlers.md §7.2). Against a
daemon that predates the verb, the CLI reports "no response from Kelpi (upgrade required?)" with
exit 1, as for `workspace-rename`.

#### `workspace-color` (R/R)

`name` (required non-empty) = workspace name-or-id (§5.8, strict); `color` = one of the ten
`WorkspaceColor` values (`red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `gray`,
`black`, `white`), matched after trimming and lowercasing, so `" Purple "` is `purple`. The
CLI's spelling of the sidebar's color picker (#393); the GUI keeps its WS-only `set-bulk-color`.
Unlike `workspace-create`'s `color`, an unknown value is refused, not dropped. There is no "clear": a workspace always has a color, so an absent `color` is
refused too. The color reaches every attached client through the ordinary store delta. Setting
the color the workspace already has succeeds without writing anything; the reply's `old_color`
then equals `color`.

```json
{"command":"workspace-color","name":"feat-x","color":"purple"}
→ {"ok":true,"workspace_id":"<uuid>","workspace_name":"feat-x","color":"purple","old_color":"blue"}
```

Refusals: `workspace not found: <name>` and `workspace name is ambiguous: <name> (use the
id)` (as for `workspace-rename`), `workspace-color requires color: give one of red, orange, …,
white` for an absent or blank `color`, `a workspace always has a color; give one of red, orange,
…, white` for `none`, `default` or `clear`, and `'<x>' is not a workspace color: give one of red,
orange, …, white` for anything else. Group colors have no such verb.

---

### 6.4 Group commands

#### `group-list` (R/R)

No parameters. Groups in sidebar order (unplaced groups appended; duplicates
de-duplicated); members in each group's child order, each followed by the workspaces nested under
it (app-state-core.md §2.9), which carry `parent_id` and `parent_name`. Those belong to the group
too: they are what `workspace-list` `group` lists and what `group-delete` `cascade` deletes.

```json
{"command":"group-list"}
→ {"ok":true,"groups":[
    {"id":"<uuid>","name":"projects","color":"blue",
     "workspaces":[{"id":"<uuid>","name":"main"},{"id":"<uuid>","name":"beta"}]}]}
```

`color` present only when the group has one. `repo` (`{"id","name","path"}`) and
`create_worktree` (bool) are present only while the group has a default repository
(app-state-core.md §5.5; set with `group-set-repo`).

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

#### `group-move` (F&F)

`name` (name-or-id) and `index` (int) both required. The slot is the group's own place
in the sidebar's TOP-LEVEL order (app-state-core.md §4.7), which is the group-header
drag. `index` is the slot in the post-move order (the handler removes then inserts), and
one outside `0 ..< count` is a silent no-op, as is an unresolvable `name`. `group-reorder`
is the other axis entirely: it rewrites a group's member order.

```json
{"command":"group-move","name":"projects","index":0}
```

#### `group-set-repo` (R/R)

A group's default repository and its "new workspaces create a worktree from latest main"
switch (app-state-core.md §5.5). `name` (name-or-id) required non-empty, plus at least one
of: `repo` (a path: one the registry holds exactly is that row as is; any other path inside a
checkout names that checkout's main repository, registered if the registry lacks it),
`repo_id` (a registry row by id, taken as is: what the GUI's repository sheet sends for a registry row, so a
registered monorepo subfolder or linked worktree is never re-resolved into a different repo),
`clear` (bool: no repository, and the switch goes off with it), `create_worktree` (bool: the
switch; absent keeps it). More than one of `repo` / `repo_id` / `clear`, or `clear` with
`"create_worktree":true`, is a guard error; so is a request carrying none of them. An unknown
`repo_id` → `{"ok":false,"error":"no repo matches '<id>'"}`. A repository a group adopts is
promoted out of auto-discovered status, so the auto-unlink GC never collects it. The switch alone on a group with no repository
→ `{"ok":false,"error":"group '<name>' has no repository to create worktrees from: set one
first (kelpi group set-repo <group> <path>)"}`; a path outside any repository →
`{"ok":false,"error":"<path> is not inside a git repository"}`; unknown or ambiguous group →
`{"ok":false,"error":"no group matches '<name>'"}`. The reply is the group's state after the
change.

```json
{"command":"group-set-repo","name":"kelpi","repo":"~/code/kelpi","create_worktree":true}
→ {"ok":true,"group_id":"<uuid>","group_name":"kelpi",
   "repo":{"id":"<uuid>","name":"kelpi","path":"/Users/ben/code/kelpi"},"create_worktree":true}

{"command":"group-set-repo","name":"kelpi","clear":true}
→ {"ok":true,"group_id":"<uuid>","group_name":"kelpi","repo":null,"create_worktree":false}
```

Removing a repository from the registry clears every group's `repo` that pointed at it.

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

**`open`**: open a document pane for `path` (required non-empty): a csv table pane when the
path ends in `.csv` or `.tsv` (case-insensitive; issue #324, [csv-pane.md](csv-pane.md) §2),
otherwise a markdown pane. `as` (string, optional) forces the pane type; its only valid value is
`"markdown"` (what `kelpi md` sends, so a csv opens as markdown source), an empty string counts
as absent, and any other value is a field-level reject (§2.2). A daemon that predates the field
ignores it, and opens markdown for every path.
`pane_id` optional (originating pane); `reuse` (bool, default false) = replace the
originating pane in place (`kelpi open --here` / `kelpi md --here`); `focus` (bool, default
false, issue #295) = take the focus. Without it the preview opens in the background beside
the originating pane, and a background `reuse` keeps the focus where it was unless the
originating pane was the focused one (then the preview inherits it).

```json
{"command":"open","path":"/Users/ben/notes/plan.md","pane_id":"1B4E…","reuse":true}
{"command":"open","path":"/Users/ben/data/sales.csv","as":"markdown"}
```

**`diff`** — open a git-diff pane. `repo_path` required non-empty; `target_path`
optional file/dir scope (empty → absent); `pane_id` optional; `focus` (bool, default false,
issue #298) = take the focus. Without it the diff pane opens in the background beside the
originating pane, as `open` does; the window's Open Diff action and inspector, and
`kelpi diff --focus`, send `true`.

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
error; optional `stash_ref`, `last_sync` when known; `stop_incomplete: true` only when a stop
failed on the parent's index lock and has not finished (graft-git.md §4.4, #342).

### 6.8 `ping` (R/R)

Health check + version probe (used by `kelpi doctor`). No parameters.

```json
{"command":"ping"}
→ {"ok":true,"version":"0.1.0","build":"1","pid":48291,"protocol":1,
   "pane_route":"tcp:127.0.0.1:52144",
   "terminals":{"live":4,"agents":1,"running":0,"waiting":1},
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
- `http` `{host, port}`: the kernel-reported primary HTTP/WS bind, present once it is listening.
  Tailnet URL/pair commands use this live endpoint; a missing or malformed block is unknown,
  never a reason to infer IPv4 loopback from CLI environment or saved port metadata.
- `pane_route`: the `KELPI_SOCKET` value injected into panes, present once the run-dir
  server's TCP listener is bound.
- `persistence` `{ok, degraded, path, failed_saves, last_save_at, error?, errno?, phase?}`:
  the database health, so a daemon whose store failed to open does not look healthy.
- `terminals` `{live, agents, running, waiting}`: live terminals (panes with a PTY) and the agent
  sessions among them. `kelpid stop` reads it to say what a stop ends (#311); an older daemon
  omits it, which a reader treats as unknown, never as none.
- `terminal_hosts` `{current, old}` (#372): `current` is `{pid, protocol, version}` of the
  terminal host new terminals start on, or null when they run in-process; `old` lists hosts of
  an older generation still draining (`docs/terminal-host.md` §11), each
  `{pid, protocol, version, reason, started_at, pane_ids, agents, busy_agents}`. Absent from a
  daemon composed without a terminal host, and from older daemons.

### 6.8.1 `restart-old-terminals` (R/R)

Restart every terminal still on an older terminal host on the current one, then let that host
exit (#372, `docs/terminal-host.md` §11). Each pane gets a fresh shell in the directory its old
shell was in, and its Claude or Codex session is resumed as after a restart. No parameters.

```json
{"command":"restart-old-terminals"}
→ {"ok":true,"panes":3,"resumed":1}
```

`panes` counts the panes that got a fresh shell and `resumed` the resume commands typed. With
nothing draining, or no terminal host at all, it is `{"ok":true,"panes":0,"resumed":0}`. It
replies after the old host has exited and the resumes are typed, a few seconds; a second request
meanwhile joins the first. A daemon that is stopping answers `{"ok":false,"error":…}`.

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
(`webpane/handlers.ts:190-200`). Only the GUI sends them; the CLI never does. `web-open` also
takes `focus` (bool, default false, issue #295): absent opens the pane in the background, and
the GUI's globe, context menu and ⌘⇧O send `true`, as does `kelpi web open --focus`.
`web-tab-new` takes `focus` too (bool, default false, issue #298): `true` focuses the pane
before the tab is added, so a blank tab's URL bar can take the caret (WEB-002); absent leaves
the workspace's focus alone. ⌘T, the tab strip's "+" and the palette send `true`, as does
`kelpi web tab-new --focus`. It is independent of `gesture` (#375), which says who drives the
tab, and of `make_active`, which says whether the new tab becomes the pane's active one. Reply payload
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

Two reply-side notes, because they change what a caller sees without changing any request
(web-pane.md §5.2, issue #76). A `web-tabs` tab entry carries `"live":false` when its renderer
died and the daemon has not rebuilt it; the key is **absent** on a healthy tab, so a reply for a
pane that has never crashed is unchanged. And `web-reload` on such a tab rebuilds the pane
rather than reaching a browser view that no longer exists: it answers `{"ok":true,…,"rebuilt":true}`
instead of `{"ok":false,"error":"web pane has no live tab <uuid>"}`. Neither is a new wire field:
`live` and `rebuilt` are reply keys, and §7 below is the REQUEST dictionary.

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
| `notification_type` | string | `notification` (#387, Claude-only) |
| `last_assistant_message` | string | `stop` (#387, Claude-only, at most 64 KiB of UTF-8) |
| `last_assistant_message_truncated` | bool | `stop` (#387, `true` only when the CLI cut the message) |
| `transcript_path` | string | `notification`, `stop`, `session-start` (#387) |
| `tool_name` | string | `notification` (#387, Codex PermissionRequest), `permission-request` (#388, required) |
| `tool_input` | object | `permission-request` (#388) |
| `mcp_server`, `cwd`, `permission_mode` | string | `permission-request` (#388) |
| `direction` | string | `pane-split`, `pane-move`, `web-open` (GUI split anchor) |
| `path` | string | `pane-split`, `pane-create`, `workspace-create`, `open` |
| `name` | string | `pane-split`/`pane-create` (label), `pane-name` (new label), `workspace-*` (name-or-id or new name), `group-*` (name-or-id), `layout-select` (layout name), `pane-move-to-workspace` (dest ws), `web-cookies-delete` (cookie name) |
| `color` | string | `workspace-create`, `workspace-color`, `group-create` |
| `target` | string | pane-target commands, `web-open` (GUI split anchor) |
| `text` | string | `pane-send`; **`pane-move-to-workspace`'s create flag (`"true"`)**; `web-type` |
| `key` | string | `pane-send-key`, `web-key` |
| `bare` | bool | `pane-send` |
| `new_name` | string | `group-rename`, `workspace-rename` |
| `cascade` | bool | `group-delete`, `workspace-delete` |
| `force` | bool | `workspace-delete` |
| `worktree_paths`, `force_worktree_paths`, `batch_ids` | string[] | `workspace-delete` |
| `prune_worktrees`, `delete_branches` | bool | `workspace-delete` |
| `index` | int | `workspace-move`, `workspace-nest`, `group-move` |
| `group` | string | `workspace-create`, `workspace-move`, `workspace-list` |
| `profile` | string | `workspace-create`, `workspace-profile`, `session-start` (+ dual-fire on any session-id-bearing event, §3.1) |
| `workspace` | string | pane-target commands, `pane-list`, `pane-sync`, `graft-*`, `pane-split`/`pane-create` (destination) |
| `scope` | string | `pane-list` |
| `reuse` | bool | `open` |
| `as` | string | `open` (`"markdown"` only: force a markdown pane for a `.csv`/`.tsv` path, #324, or an image path, content-panes.md §12) |
| `repo_path`, `target_path` | string | `diff` |
| `lines` | int | `pane-capture` |
| `scrollback` | bool | `pane-capture` |
| `repo` | string | `graft-start`, `graft-stop`, `workspace-create` (worktree source, or the repo to associate), `group-set-repo` |
| `url` | string | `web-open`, `web-navigate`, `web-tab-new` |
| `mode` | string | `web-capture` |
| `hard` | bool | `web-reload` |
| `tab` | string | `web-tab-close`, `web-tab-select` |
| `make_active` | bool | `web-tab-new` |
| `since` | uint64 | `web-console` |
| `level` | string | `web-console` |
| `clear` | bool | `web-console`, `web-inspect-result`, `group-set-repo` |
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
| `muted` | bool | `workspace-create`, `workspace-mute` |
| `icon` | string | `workspace-create`, `workspace-icon` |
| `worktree`, `branch` | string | `workspace-create` |
| `update_main` | bool | `workspace-create` |
| `ratio`, `delta` | double | `pane-resize` |
| `size` | int | `pane-font-size` |
| `reset` | bool | `pane-font-size` |
| `anchor`, `zone` | string | `pane-move-adjacent` |
| `label_op` | string | `workspace-label` |
| `label_values` | string[] | `workspace-label` |
| `order` | string[] | `group-reorder` |
| `by` | string | `group-sort` |
| `descending` | bool | `group-sort` |
| `create_worktree` | bool | `group-set-repo` |
| `repo_id` | string | `group-set-repo` |
| `group_defaults` | bool | `workspace-create` |
| `parent` | string | `workspace-create`, `workspace-nest`, `workspace-list` (workspace name-or-id, app-state-core.md §2.9) |
| `parent_pane_id` | string (UUID) | `workspace-create` (nest under the workspace holding this pane, §2.9) |
| `focus` | bool | `pane-split`, `pane-create`, `open`, `web-open`, `pane-move`, `pane-move-adjacent` (absent = background, #295); `workspace-create` (#307), `diff`, `pane-move-to-workspace`, `web-tab-new` (#298), all absent = background |
| `gesture` | bool | `web-open`, `web-navigate`, `web-back`, `web-forward`, `web-reload`, `web-tab-new` (the GUI's mark for a navigation the user made; only those pages enter the browsing history, #375; the CLI never sends it) |
| `typed` | bool | `web-navigate` (the URL bar's submit or a picked suggestion, ranked as typed in the browsing history, #375) |
| `settle_ms` | int | `pane-capture` (wait for that much quiet before reading, capped at 10000, #390) |
| `if_revision` | int | `pane-send`, `pane-send-key` (refuse with `SCREEN_CHANGED` unless the screen revision still matches, #390) |

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
    `workspace-create` with `worktree`: the CLI allows 120 s; `group-set-repo`, and
    `workspace-create` with `repo` or `group` but no `worktree`, which may resolve a repository
    with git before replying: the CLI allows 30 s). Anything async (capture, graft git work,
    repository resolution, web JS evaluation) still sends its reply from the async completion.

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
    types (`shell|markdown|scratchpad|diff|csv|web|plugin`), pane statuses
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

17. **Pane-creating and pane-moving verbs work in the background by default (issue #295).**
    `pane-split`, `pane-create`, `open` and `web-open` used to move focus to the new pane, and
    `pane-move` / `pane-move-adjacent` to the moved pane, and the window then moved the
    keyboard there, so an agent spawning or docking panes pulled the user's typing into the
    wrong pane. The optional `focus` bool is an additive field: absent (or `false`) now means
    **background**, and `true` restores the old behaviour. Compatibility, in each direction:
    - **Old CLI or agent, new daemon:** its creates and moves happen in the background. This
      is the deliberate behaviour change, and the point of it.
    - **New CLI, old daemon:** the `focus` key is ignored as an unknown field (§2.2), so
      `--focus` is a no-op there and every create and move focuses, as that daemon always did.
    - **Old window client, new daemon:** a window client that predates the field (a cached
      phone PWA bundle, an older remote-view client) sends its gestures without `focus`, so
      until it reloads the current bundle the panes it creates or moves land in the background
      and the user has to click them. This is a transition-only effect: the bundle the daemon
      serves sends `focus: true` for every gesture.
    The window's own gestures send `focus: true` explicitly, so they are unaffected. The
    plugin SDK's `panes.create`, `panes.split`, `panes.move`, `panes.moveAdjacent` and
    `files.open` helpers send `focus: true` unless the plugin passes `focus: false`, because
    they assume a user's click; plugin code that runs without a gesture (a backend reacting to
    events or timers) must pass `focus: false`. A raw plugin `command` follows the wire
    default.

18. **Agent hook fields are additive (issue #387).** `notification` gains `notification_type`,
    `transcript_path` and `tool_name`; `stop` gains `last_assistant_message`,
    `last_assistant_message_truncated` and `transcript_path`; `session-start` gains
    `transcript_path` (§6.1). All are optional and decoded only when present, so a line
    without them decodes to exactly the message it always did. Compatibility, in each
    direction:
    - **Old CLI, new daemon:** the hook never sends the keys, the decoder leaves them off the
      message, and the daemon behaves as before (decoder tests in
      `packages/protocol/src/wire/decode.test.ts`).
    - **New CLI, old daemon:** the keys are unknown to that daemon's decoder and ignored
      (§2.2), so the event is handled exactly as an older CLI's.
    - **Same version:** the CLI sends each key only when the hook's stdin carried it as a
      non-empty string, so a manual `kelpi event stop` stays wire-identical. The one new key
      that can be large, `last_assistant_message`, is capped at 64 KiB by the CLI: even
      escaped six-fold as JSON, far below the 64 MB line limit (§2.1).

19. **`permission-request` is a new request/response verb (issue #388).** It adds the allowlist
    entry, the §6.1.1 command and four request keys (`tool_input`, `mcp_server`, `cwd`,
    `permission_mode`; `tool_input` is the first object-typed field, §2.2). Compatibility, in
    each direction:
    - **Old CLI, new daemon:** an older CLI has no `kelpi event permission-request` and never
      sends the verb or the new keys, so nothing it sends decodes differently.
    - **New CLI, old daemon:** the older daemon's decoder rejects the line as an unknown
      command, which it never answers (§9 item 3). The CLI gets no reply, prints nothing once
      its own deadline passes, and Claude shows its normal prompt.
    - **Same version:** the daemon always replies, within its 2 s provider deadline, and fails
      open to `abstain`, never to `allow` (§6.1.1).
      A plugin `before` operation hook on the command runs first and can delay that reply;
      the CLI's own deadline then leaves the prompt to Claude.

20. **Screen revision, `settle_ms` and `if_revision` (issue #390).** `pane-capture` now reports
    the pane's screen revision with the text, and `pane-send` / `pane-send-key` can refuse unless
    the revision still matches, so an agent that read a prompt does not type into a screen that
    has moved on. All three request fields are additive and optional. Compatibility, in each
    direction:
    - **Old CLI or agent, new daemon:** captures gain `revision`, `cursor` and `alt_screen`
      (extra keys an old reader ignores), and sends and send-keys are unchanged because they
      carry no `if_revision`.
    - **New CLI, old daemon:** `if_revision` and `settle_ms` are ignored as unknown fields
      (§2.2). The send is typed unguarded, and the capture returns at once without `revision`,
      `cursor` or `alt_screen`. The ack of a guarded send lacks `revision`, which is how a
      caller can tell the daemon did not check.
    - **Old window client, new daemon:** no effect, the window client sends none of these fields.
    The revision counts what the daemon has fed to its terminal state. With the terminal host
    (#273, `docs/terminal-host.md`), output the host has read from the PTY but the daemon has not
    yet fed is not counted, so the guard covers what the daemon had seen, which is also what the
    capture showed. Within one daemon run a pane id never repeats a revision (new terminal state
    is seeded past every value the daemon has issued, and a pane with no terminal state reads 0),
    and a new daemon seeds its counter from the clock (milliseconds since the epoch at start),
    past any value an earlier daemon could plausibly have issued, so a stale revision from before a
    restart is refused with `SCREEN_CHANGED`, never reissued for a different screen.

21. **Workspace creation, diffs, moves to another workspace and new web tabs work in the
    background by default (issues #307 and #298).** Item 17's rule, extended to the verbs it
    left out: `workspace-create` used to reveal the new workspace to every window and make it
    the daemon's active one, `diff` focused its caller and then the diff pane,
    `pane-move-to-workspace` made the destination active and revealed it, and `web-tab-new`
    let a blank tab's URL bar take the caret in a pane the user was not in. Each now takes the
    optional `focus` bool: absent (or `false`) is **background**, `true` restores the old
    behaviour. `pane-move-to-workspace` follows the pane without `focus` in one case: when it
    moves the focused pane of the active workspace (the pane the user is typing in).
    `web-tab-new`'s `focus` focuses the pane before the tab is added and is independent of
    `gesture` (#375). The plugin `views.open` method (`kelpi plugin open`) follows the same
    rule through its JSON `focus` argument. Compatibility, in each direction:
    - **Old CLI or agent, new daemon:** its creates, diffs, moves and new tabs happen in the
      background. As in item 17, this is the deliberate behaviour change. A script that ran
      `kelpi workspace create` and then relied on the new workspace being ACTIVE (a
      `kelpi pane create` with no `--workspace`, say) now lands in the user's workspace and must
      name `--workspace`, or pass `--focus`.
    - **New CLI, old daemon:** `focus` is ignored as an unknown field (§2.2), so `--focus` is
      a no-op and every one of these switches or focuses, as that daemon always did.
    - **Old window client, new daemon:** a window client that predates the field sends its
      creates, Open Diff, "Move to workspace" and ⌘T without `focus`, so until it reloads they
      happen in the background. The issuing window still activates a workspace it created
      from the create's reply, so only the user's OTHER windows stay put.
    For a focusing `workspace-create` the daemon's `reveal-pane` broadcast is a backstop, not
    the mechanism: the issuing window activates the new workspace from the reply, and the
    broadcast only takes the user's other windows along. Because a background create or move
    leaves `lastActiveWorkspaceID` alone, the `active-workspace-changed` domain event (a
    window's delta, a plugin's `state.changed`) no longer fires for one; a consumer that waited
    for it after a create should read the create's reply instead. The plugin SDK's `workspaces.create`, `panes.moveToWorkspace`,
    `git.diff` and `openView` helpers send `focus: true` unless the plugin passes
    `focus: false`, as item 17's pane helpers do.

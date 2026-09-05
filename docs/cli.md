# kelpi CLI: behavioral specification

Source of truth: `/Users/ben/code/kelpi/Tools/nex-cli/nex.swift` (single-file Swift CLI, ~5300 lines),
`/Users/ben/code/kelpi/scripts/install-hooks.sh`, `/Users/ben/code/kelpi/scripts/merge_hooks.py`.

This document is a contract. The new TypeScript daemon must keep this exact CLI working
unchanged (same wire protocol, same reply envelopes), and a future TS rewrite of the CLI
must reproduce every behavior described here: flags, parsing rules, stdout/stderr text,
exit codes, timeouts, and routing heuristics.

Terminology used throughout:

- "fire-and-forget": the CLI opens a connection, writes one JSON line, closes, and exits 0
  regardless of what the server does. Transport failure does NOT change the exit code
  (still 0), it only prints a `Warning:` to stderr (suppressible, see section 5.8).
- "request/response": the CLI writes one JSON line, then reads until the server closes the
  connection (EOF), decodes the reply, and exits non-zero on any failure.
- "the caller pane": the pane identified by the `KELPI_PANE_ID` environment variable, which
  the app injects into every PTY it spawns.

---

## 1. Scope and role

`kelpi` is a standalone binary bundled inside the app at `Kelpi.app/Contents/Helpers/nex` and
symlinked into `/usr/local/bin` (or `$KELPI_INSTALL_DIR`) by `install-hooks.sh`. It has two
jobs:

1. **Agent hook entrypoint** (`kelpi event ...`): Claude Code and Codex CLI lifecycle hooks
   call it on every Stop/Start/Notification/SessionStart/SessionEnd fire. These must be
   silent, fast, and never fail (exit 0 even when the app is not running).
2. **Scripting/orchestration surface**: everything else (`pane`, `workspace`, `group`,
   `layout`, `open`, `md`, `diff`, `graft`, `web`, `doctor`). These are used by humans and
   by orchestrator agents (the `nex-agentic` skill), and mostly follow request/response
   semantics with meaningful exit codes.

The CLI has no local state. Everything is one process invocation: parse args, maybe read
stdin, open a socket, write one newline-terminated JSON object, optionally read the reply,
print, exit.

### 1.1 Build/packaging (current)

- Compiled with `swiftc -O -o kelpi nex.swift` (see `Tools/nex-cli/Makefile`); the app build
  runs this as a post-build script and copies the binary into `Contents/Helpers/`.
- `install-hooks.sh` symlinks it (symlink, not copy, so version resolution works; see 3.1).

---

## 2. Wire protocol basics

- Transport: Unix domain socket at `/tmp/kelpi.sock` (default) or TCP to `127.0.0.1`-bound
  listener (opt-in via `KELPI_SOCKET`, see section 4).
- Framing: the client sends exactly one JSON object serialized on a single line, terminated
  by `\n`. Field types are native JSON (strings, numbers, booleans, arrays); the top-level
  discriminator key is `"command"`.
- Reply (request/response commands only): the server writes a single newline-terminated
  JSON line and then closes the connection. The client reads until EOF and parses the
  accumulated bytes as one JSON object. Success replies are `{"ok": true, ...}`; failures
  are `{"ok": false, "error": "<message>", ...extra fields...}`.
- Streaming (only `web-console` with `"follow": true`): after the first reply line the
  server keeps the connection open and writes one JSON object per line per event until the
  client closes or the server ends the stream.

Example request (as bytes on the wire):

```json
{"command":"pane-close","target":"worker-1","pane_id":"9C2B9A2E-1111-2222-3333-444455556666","workspace":"alpha"}
```

Example success reply:

```json
{"ok":true,"pane_id":"0A1B2C3D-....","label":"worker-1","workspace_name":"alpha"}
```

Example failure reply:

```json
{"ok":false,"error":"no pane matched target 'worker-1'"}
```

---

## 3. Global invocation

```
kelpi <subcommand> [args...]
```

Top-level subcommands: `event`, `pane`, `workspace`, `group`, `layout`, `open`, `md`,
`diff`, `graft`, `web`, `doctor`, plus the pseudo-subcommands `--version`/`version` and
`--help`/`-h`/`help`.

- No arguments at all: print the global usage block to **stderr**, exit 1.
- `kelpi --version` or `kelpi version`: print `kelpi <version>` to stdout, exit 0.
- `kelpi --help` / `-h` / `help`: print the global usage block (note: it is written to
  **stderr**, an existing quirk), exit 0.
- Unknown subcommand: `Unknown command: <x>\n` to stderr, then the usage block, exit 1.

### 3.1 Version resolution

The reported version is derived from the app bundle the binary lives in:

1. Get own executable path (`_NSGetExecutablePath`), **resolve symlinks** (this is why
   the installer uses `ln -s`, not `cp`: a copied binary cannot find the bundle).
2. From `<...>/Kelpi.app/Contents/Helpers/nex`, go up two components to
   `<...>/Kelpi.app/Contents/` and read `Info.plist` there.
3. Use `CFBundleShortVersionString`. Any failure at any step yields the literal string
   `"dev"`.

The version participates in `kelpi doctor`'s `version` check (compared against the running
app's version returned by `ping`).

TS port: the daemon should return `version` from `ping`, and a TS CLI should resolve its
own version from its package metadata; `"dev"` remains the fallback string.

---

## 4. Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `KELPI_PANE_ID` | almost all commands | UUID of the caller's pane. Injected by the app into every PTY it spawns. Used (a) as the implicit target for caller-scoped commands, and (b) to scope label resolution to the caller's workspace. |
| `KELPI_SOCKET` | transport selection | Absent/empty or any value not starting with `tcp:` selects the Unix socket at `/tmp/kelpi.sock` (the unix path itself is NOT configurable). `tcp:<host>:<port>` selects TCP. Malformed `tcp:` values (missing port, non-UInt16 port) silently fall back to the Unix socket. The host may not contain a colon (split on the first `:` after the prefix, max 1 split). |
| `KELPI_REPLY_TIMEOUT` | reply reading | Positive integer seconds; overrides the default request/response read timeout of **5 seconds**. Non-integer or <=0 values are ignored. |
| `KELPI_SILENT` | fire-and-forget failure path | If set (to anything), fully suppress the transport-failure `Warning:` stderr lines on fire-and-forget commands. Exit code is unchanged (0). |
| `KELPI_VERBOSE_HOOKS` | `kelpi event ...` only | `kelpi event` auto-suppresses fire-and-forget warnings (hooks fire constantly and would spam terminals when Kelpi is closed). Setting `KELPI_VERBOSE_HOOKS` (to anything) re-enables the warnings for event commands. |
| `HOME` | table rendering, doctor | Used to render `~`-relative cwd in `pane list`, and to resolve `~/.claude` / `~/.codex` in doctor's hooks checks (falls back to the passwd-database home directory when `HOME` is unset). |
| `KELPI_REQUIRE_SOCKET` | transport selection | The sandbox-harness guard. If set (to anything), the silent unix fallback above becomes a refusal to dial at all: any invocation whose `KELPI_SOCKET` does not name a well-formed `tcp:` route fails with `requiredSocketUnmet` (request/response commands exit 1; fire-and-forget commands keep their exit-0 warning contract) and `/tmp/kelpi.sock` is never touched. Set by sandboxed harnesses (ui-audit, smokes, verify.mjs) so a stale or missing route env can never silently address the live daemon. Not for normal interactive use. |
| `KELPI_PROFILE` | `kelpi event ...` only | The effective profile name the pane's PTY was spawned with (injected by the daemon). Hooks attach it beside `session_id` (the wire `profile` field) so the daemon can resume the session under the same profile (agent-lifecycle.md §6.1). Non-empty only; every other command ignores it. |

### 4.1 `requirePaneID()` semantics

Commands whose implicit subject is the caller pane call `requirePaneID()`:

- If `KELPI_PANE_ID` is **unset**: exit **0 silently** (no output at all). This is a
  deliberate design so hooks and scripts run outside Kelpi do nothing rather than fail.
- If set (including set to an empty string), the value is used as-is. (Only some newer code
  paths additionally treat empty-string as absent via an explicit `isEmpty` check; those
  are called out per command below.)

Commands that use `requirePaneID()` (silent exit 0 outside a pane): `event *` (all),
`pane close` (no `--target` form), `pane move` (directional form), `pane move-to-workspace`,
`pane list --current`, `pane capture` (no `--target` form), `layout cycle`, `layout select`.

Commands that instead print a usage error and exit 1 when neither `KELPI_PANE_ID` nor an
explicit target/workspace is available: `pane split`, `pane create`, `pane name`,
`pane resize`, and all `web` verbs (via the target-scope rule, section 11.2).

---

## 5. Transport layer

### 5.1 Sending (both transports)

1. Serialize payload to JSON (no sorted keys guaranteed on the request side), append `\n`.
2. If serialization fails: exit 1 immediately (practically unreachable).
3. `socket()` + `connect()`. TCP resolves via `getaddrinfo` with `AF_INET` (IPv4 only),
   `SOCK_STREAM` (hostnames like `host.docker.internal` and IP literals both work).
4. `send()` the entire line.
5. Fire-and-forget: close, done. Request/response: set `SO_RCVTIMEO` (see 5.3), read until
   EOF, close.

### 5.2 Reading replies (`readUntilEOF`)

Loop `read(fd, 4096)`:

- `n > 0`: append, continue.
- `n == 0` (EOF): return accumulated bytes (possibly empty).
- `n < 0` with `EINTR`: retry.
- `n < 0` with `EAGAIN`/`EWOULDBLOCK` (the receive timeout fired): return accumulated
  bytes (treated exactly like an empty reply so callers can print "upgrade required").
- any other errno: return `nil` if nothing was accumulated yet, else the partial buffer.

A `nil` return from the whole send helper means transport failure; an **empty but non-nil**
buffer means "connected, sent, but no reply arrived before close/timeout" and is surfaced
as the `emptyReply` failure category or per-command "may not support this command"
messages.

### 5.3 Read timeouts

- Default: 5 seconds (`KELPI_REPLY_TIMEOUT` overrides globally).
- Per-command overrides (passed as `readTimeoutOverride`):
  - `doctor`'s ping check: 2 seconds.
  - `workspace create --worktree ...`: 120 seconds (worktree add + optional `git fetch`).
  - `web wait`: `max(ceil(--timeout seconds) + 5, defaultTimeout)`.
  - `web exec`: `max(ceil(--timeout seconds) + 5, defaultTimeout)` with `--timeout`
    defaulting to 30.
- Streaming (`web console --follow`): **no read timeout at all**; the socket blocks
  indefinitely between lines.

### 5.4 Failure classification (`TransportFailure`)

Every send helper resets a module-global `lastTransportFailure = nil` at entry (so chained
sends inside one CLI process, e.g. doctor's ping followed by other checks, or bulk
workspace delete, never surface a stale diagnostic), then stashes a category on failure:

| Category | Trigger |
|---|---|
| `unixSocketMissing(path)` | `connect` errno `ENOENT` (socket file absent) |
| `unixConnectRefused(path)` | `connect` errno `ECONNREFUSED` (stale socket file) |
| `unixConnectFailed(path, errno)` | any other unix `connect` errno |
| `tcpResolveFailed(host)` | `getaddrinfo` failed |
| `tcpConnectFailed(host, port, errno)` | TCP `connect` failed |
| `createSocketFailed(errno)` | `socket(2)` failed (fd exhaustion etc.) |
| `emptyReply(command)` | connected and sent, but `readUntilEOF` returned `nil` (read error before any byte, e.g. ECONNRESET). Note: a genuinely empty (0-byte) reply does NOT set this; it is handled by per-command empty-reply text. `command` is the wire `"command"` value from the payload when available, else the CLI label. |

### 5.5 Failure rendering (`printTransportFailure`)

Two lines to stderr:

```
<prefix>: <error line>
Repair: <repair line>
```

`<prefix>` is `Error` for request/response commands, `Warning` for fire-and-forget. If no
category was captured, prints the single line
`"<command>: transport failure (no diagnostic captured).\n"`.

Exact error/repair text per category (with `\(command)` = the CLI-facing label like
`kelpi pane close`, and errno rendered as `errno N: <strerror text>`):

- `unixSocketMissing`:
  - Error: `<command>: cannot reach Kelpi — socket <path> does not exist.`
  - Repair: `Is Kelpi running? Launch the app, then retry. If Kelpi is running but using TCP, set KELPI_SOCKET=tcp:<host>:<port>.`
- `unixConnectRefused`:
  - Error: `<command>: socket <path> exists but connect was refused — Kelpi is not listening (likely stale socket from a previous crash).`
  - Repair: `Restart Kelpi (panes and workspaces are persisted to ~/Library/Application Support/Kelpi/nex.db so they will be restored). If the file remains after Kelpi quits, remove it with `rm <path>`.`
- `unixConnectFailed`:
  - Error: `<command>: connect to <path> failed (errno N: <msg>).`
  - Repair: `Run `kelpi doctor` for full IPC diagnostics.`
- `tcpResolveFailed`:
  - Error: `<command>: cannot resolve host "<host>" (from KELPI_SOCKET).`
  - Repair: `Check the hostname in KELPI_SOCKET. From a dev container the usual value is `tcp:host.docker.internal:<port>`.`
- `tcpConnectFailed`:
  - Error: `<command>: TCP connect to <host>:<port> failed (errno N: <msg>).`
  - Repair: `Confirm Kelpi has `tcp-port = <port>` set in ~/.config/nex/config and is running. If you're tunneling, check the SSH reverse tunnel is up.`
- `createSocketFailed`:
  - Error: `<command>: socket(2) failed (errno N: <msg>).`
  - Repair: `Process-level failure — check for FD exhaustion. Run `kelpi doctor` for diagnostics.`
- `emptyReply`:
  - Error: `<command>: no response from Kelpi for `<wire-command>` (connected, then peer closed before replying).`
  - Repair: `Likely an older Kelpi that doesn't recognise the command, or the app is wedged. Run `kelpi doctor` to confirm. Restart Kelpi if the doctor reports the app pid is responsive but commands hang.`

### 5.6 Fire-and-forget failure path

On any transport failure a fire-and-forget send calls
`handleFireAndForgetTransportFailure(command)`:

- If warnings are not suppressed (see below), print the failure with the `Warning` prefix.
- **Exit 0** always.

Suppression logic:
- `KELPI_SILENT` set (any value): suppress.
- `kelpi event ...` sets an internal suppress flag unless `KELPI_VERBOSE_HOOKS` is set.

### 5.7 Fire-and-forget command list

`event *` (all six), `pane move <direction>`, `pane move-to-workspace`, `workspace move`,
`workspace profile`, `group create`, `group rename`, `group delete`, `layout cycle`,
`layout select`, `open` (markdown route), `md`, `diff`.

Everything else is request/response.

### 5.8 Streaming transport (only `web console --follow`)

- SIGINT handler installed before the loop: closes the active stream fd, then
  `exit(128 + signal)` (i.e. 130 for Ctrl-C).
- Connect and send exactly like a normal request; do NOT set any read timeout.
- Read newline-delimited lines; invoke the line callback with each complete line's raw
  bytes (no trailing newline). Return on EOF or read error (except EINTR retry).
- Connection failures return `false` to the caller (which prints the transport failure
  under the label `kelpi web console --follow` and exits 1).

---

## 6. Reply decoding pipeline and exit codes

Request/response commands share four helpers. Behavior is specified here once:

### 6.1 `readReplyOrExit(payload, command, readTimeoutOverride?) -> bytes`

- Transport failure (`nil`): `printTransportFailure(command)` (Error prefix), exit 1.
- Empty (0-byte) reply: print exactly

  ```
  <command>: no response from Kelpi (upgrade required?)
  Repair: if the running Kelpi is recent, the app may be wedged — try `kelpi doctor` first, then restart Kelpi if needed.
  ```

  to stderr, exit 1.
- Otherwise return bytes.

### 6.2 `parseReplyOrExit(bytes, command) -> object`

- Invalid JSON (or not an object): `"<command>: invalid JSON response\n"` to stderr, exit 1.
- `ok == false`: `"<command>: <error-or-'unknown error'>\n"` to stderr, exit 1.
- Else return parsed object.

### 6.3 `decodeReply` = 6.1 then 6.2. Used by most commands.

### 6.4 `decodeReplyAllowingFailure` (bulk `workspace delete` only)

Like `decodeReply` but a **well-formed `{ok:false}` is returned** instead of exiting, so
the batch loop can record the per-id failure and continue. Transport failure, empty reply,
and invalid JSON stay fatal for the whole batch (exit 1).

### 6.5 Commands with bespoke empty-reply handling

These call the raw send and check `data.isEmpty` themselves before `parseReplyOrExit`:

- `pane send`: empty reply is treated as **success, exit 0, no output** (compatibility with
  pre-request/response servers that acted then closed silently).
- `pane send-key`, `pane resize`, `pane move` (adjacent form), `pane sync *`: empty reply
  prints `kelpi pane <verb>: empty reply (Kelpi version may not support this command)` to
  stderr, exit 1.

### 6.6 Exit code summary

| Code | Meaning |
|---|---|
| 0 | Success. Also: fire-and-forget always (even on transport failure); `requirePaneID` silent exits; `kelpi web exists` when found. |
| 1 | Usage errors, unknown targets/ambiguous labels (`ok:false`), transport failures on request/response commands, invalid JSON replies, `web exists` not found, `web attr` attribute absent, `web cookies delete` zero matches, `pane id` outside a pane, doctor with a FAILed check, any failed delete in a `workspace delete` batch. |
| 2 | `kelpi doctor <unexpected arg>` only. |
| 128+sig | Streaming loop terminated by signal (SIGINT => 130). |

---

## 7. Argument parsing primitives

There is no general argv framework; parsing is done with four helpers plus per-command
positional logic. A TS rewrite must reproduce their exact semantics because they interact
(order of consumption matters).

### 7.1 `parseFlag(name, args) -> string | null`

- Finds the **first** occurrence of the literal token `name` anywhere in the remaining
  args (flags can appear before or after positionals).
- The value is the token immediately following it, **even if that token starts with `-`**
  (so `--name --json` consumes `--json` as the name value).
- Removes both tokens from args, returns the value.
- If the flag is absent: returns null, args unchanged.
- If the flag is present but is the **last** token (no value): returns null and **leaves
  the flag token in args**, where it later trips the leftover-args rejection as an
  "unknown option".
- Repeatable flags (`workspace label --add a --add b`) are collected by calling
  `parseFlag` in a loop until it returns null.

### 7.2 `popSwitch(name, args) -> bool`

Presence-only boolean flag; removes the first occurrence, returns true; false if absent.
Consumes no value.

### 7.3 `parseOptionalAmountFlag(name, default, args) -> number | null`

For `pane resize --grow [amt]` / `--shrink [amt]`: null when the flag is absent. When
present, consume the next token **only if it parses as a float** (else keep it and use the
default), remove the flag, return the amount.

### 7.4 `extractPositionalTail(args) -> string[]`

POSIX `--` terminator support, used only by `web click`, `web type`, `web select`:
if `--` appears, everything after it is removed from args and returned as raw positionals
that no flag parser will touch (so `kelpi web type css:#i -- --submit` types the literal
string `--submit`). Without `--`, returns `[]`.

### 7.5 `rejectLeftoverArgs(args, command, positionalHint?, usage?)`

Called after a subcommand consumed everything it recognizes. No-op when args is empty.
Otherwise, looking at the first leftover token:

- Starts with `-`: `"<command>: unknown option <tok>\n"` to stderr.
- Otherwise with a hint: `"<command>: unexpected argument '<tok>' — <hint>\n"`.
- Otherwise: `"<command>: unexpected argument '<tok>'\n"`.

Then optionally print the subcommand usage block to stderr, exit 1. Rationale (issue #237):
silent fallthrough is dangerous for verbs whose no-target default is "the calling pane"
(`kelpi pane capture <uuid>` must not silently capture the caller).

Commands wired to `rejectLeftoverArgs`: `pane split`, `pane create`, `pane resize`,
`pane move` (adjacent form), `pane list`, `pane capture`, `workspace list`,
`workspace create`, `workspace label`, `group reorder`, `group sort`. Several other
commands implement equivalent bespoke checks (`pane close`, `pane name`, `pane send-key`,
`pane sync`, `workspace profile`, `workspace delete`, `group list`, `doctor`); commands
NOT listed here silently ignore extra args (e.g. `diff`, `layout select`, `group create`,
most `web` verbs, `md`/`open` after the first positional).

### 7.6 Help flags

- `-h` / `--help` accepted by: all `pane` subcommands with usage printers (split, create,
  close, name, resize, send, move, capture, list), `pane sync` (also bare `help`),
  `workspace` (group-level and per subcommand), `group` (group-level, plus
  `reorder`/`sort`), `web` (group-level, also `help`), `web cookies`, `md`, `open`,
  `graft`. Help goes to **stdout**, exit 0. (Exception: `graft` help goes to stderr and
  exits 0; the top-level `kelpi --help` usage goes to stderr and exits 0.)
- `event`, `layout`, `diff`, `group create/rename/delete`, `pane move-to-workspace`,
  `pane send-key`, `pane id` have no dedicated help flag handling; a `--help` there is
  either an invalid value error or silently ignored per that command's parsing.

---

## 8. `kelpi event` (hook entrypoint)

```
kelpi event stop|start|error|notification|session-start|session-end
          [--agent claude|codex] [--message ...] [--title ...] [--body ...]
```

Fire-and-forget. Warnings auto-suppressed unless `KELPI_VERBOSE_HOOKS` is set.

Parsing/validation order:

1. Missing event type: usage line to stderr, exit 1.
2. Event type not in `{stop, start, error, notification, session-start, session-end}`:
   `Unknown event type: <x>` + `Valid events: ...` to stderr, exit 1.
3. `requirePaneID()`: silently exit 0 when `KELPI_PANE_ID` is unset.
4. Parse `--message`, `--title`, `--body`, `--agent`.
5. `--agent` present but not in `{claude, codex}`:
   `Unknown --agent value: <x> (valid: claude, codex)` to stderr, exit 1 (loud on purpose:
   the error lands in the agent's hook output; a typo would otherwise degrade silently to
   claude server-side).

### 8.1 stdin JSON

If stdin is **not a TTY** (`isatty == 0`), read the currently-available stdin data once and
try to parse it as a JSON object. Claude Code and Codex both pipe a JSON payload with at
least `session_id` to every hook. Parse failures / empty stdin are silently ignored
(`stdinJSON = null`).

### 8.2 Notification title/body composition (only for `eventType == "notification"`)

Precedence: explicit `--title`/`--body` flags always win; the logic below only fills the
gaps.

- `--agent codex` (Codex has no Notification hook; its `PermissionRequest` hook is wired to
  `kelpi event notification --agent codex`):
  - Uses `stdinJSON` or `{}` (works with no stdin at all).
  - title default: `stdin.title` else `"Codex"`.
  - body default: `stdin.message` if present; else if `stdin.tool_name` is a non-empty
    string, `"Approval requested: <tool_name>"`; else `"Waiting for approval"`.
- claude (default), **only when stdin actually carried JSON**:
  - title default: `stdin.title` else `"Claude Code"`.
  - body default: `stdin.message` (may end up absent).
  - A manual no-stdin `kelpi event notification --body x` deliberately omits the title so
    the server renders its neutral "Agent" default.

### 8.3 Sub-agent filtering

If `stdinJSON.agent_id` is a **non-empty string** (Claude Code sets it on hooks fired by
sub-agents; the root agent omits it) AND the event is `stop` or `start`: return without
sending anything (exit 0). Sub-agent lifecycle must not toggle the pane indicator. All
other events pass through regardless of `agent_id`.

### 8.4 `session_id`

`stdinJSON.session_id` (string) is forwarded verbatim when present, on every event type.
Server-side contract notes (implemented in the daemon, not the CLI):
- `session-start` / dual-fire `session_id` binding attaches the id to the pane so restart
  can `claude --resume <id>` / `codex resume <id>`.
- `session-end` clears the pane's tracked session id only when it still matches the ending
  session (issue #178).

### 8.5 `background_tasks` counting (issues #215/#220)

Only for `stop` and `notification` events, and only when `stdinJSON.background_tasks` is
an **array of objects**. This is an observed (undocumented) Claude Code field: a live
snapshot of in-flight `run_in_background` shells and background subagents. Guard
defensively: missing / renamed / wrong-shaped field => count 0 => legacy behavior.

Counting predicate: count an entry **unless** it declares a terminal status. Specifically,
for each entry:

- No `status` key, or `status` is not a string: **count it** (presence implies in-flight).
- `status.toLowerCase()` in the terminal set: skip.

Terminal statuses (exact set):

```
completed, complete, done, success, succeeded,
failed, failure, error, errored,
cancelled, canceled, killed, stopped,
timeout, timed_out, aborted, skipped
```

The count is attached to the payload as `background_tasks` (a JSON **number**) only when
`> 0`, keeping the common path wire-identical to pre-#215 clients.

### 8.6 Event wire payload

```json
{
  "command": "stop",                    // the event type verbatim
  "pane_id": "<KELPI_PANE_ID>",
  "message": "...",                     // only if --message given
  "title": "...",                       // only if resolved (flag or defaulting rules)
  "body": "...",                        // only if resolved
  "session_id": "...",                  // only if stdin carried one
  "agent": "codex",                     // only if --agent was passed (absent = claude)
  "background_tasks": 2                 // only if count > 0
}
```

The command label used for warning attribution is `kelpi event <type>`.

---

## 9. `kelpi pane`

Dispatcher: `kelpi pane <action>`; missing action prints
`Usage: kelpi pane split|create|close|name|send|send-key|move|list|capture|sync|id [...]` to
stderr, exit 1. Unknown action prints `Unknown pane action: <x>` +
`Valid actions: split, create, close, name, send, send-key, move, move-to-workspace, list, capture, sync, id`,
exit 1.

### 9.0 Target resolution model (server-side contract, referenced everywhere)

- A `target` that parses as a UUID resolves **globally** across all workspaces.
- A `target` that is a label requires a workspace scope: either implicit (the caller's
  workspace via the forwarded `pane_id`) or explicit (`workspace` name-or-id in the
  payload). A bare label with neither is an `ok:false` error (no global fallback).
- `workspace` fields accept a workspace UUID or a case-sensitive name; names must resolve
  uniquely (ambiguous => error).
- The CLI forwards `pane_id` (= `KELPI_PANE_ID`, only when non-empty) alongside `target` on
  most commands purely to enable the implicit workspace scoping.

### 9.1 `kelpi pane id`

Local only, never touches the socket. Prints `KELPI_PANE_ID` and exits 0 when it is set and
non-empty; exits 1 (no output) otherwise.

### 9.2 `kelpi pane split`

```
kelpi pane split [--direction horizontal|vertical] [--path /dir] [--name <label>]
               [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--json]
```

- `--help`/`-h`: usage to stdout, exit 0.
- Leftovers rejected (`rejectLeftoverArgs`, usage printed).
- Requires at least one of `--target`, `--workspace`, or a non-empty `KELPI_PANE_ID`;
  otherwise: `kelpi pane split: requires --target <name-or-uuid> or --workspace <name-or-id> when called from outside a Kelpi pane`
  + usage to stderr, exit 1.
- Payload: `{"command":"pane-split", direction?, path?, name?, target?, workspace?, pane_id?}`
  (pane_id = non-empty `KELPI_PANE_ID`). Direction is forwarded verbatim (server defaults it,
  the CLI performs no validation).
- Request/response via the shared pane-mutation printer (9.2.1). The reply carries the
  **newly created** pane's id.

Server semantics (contract): with `--target`, splits that pane; with only `--workspace`,
splits that workspace's focused pane; with neither, splits the caller pane. Reply includes
`pane_id` (new pane), `workspace_id`, `workspace_name`, `label?`.

#### 9.2.1 Shared pane-mutation printer (`split`/`create`/`name`)

Decodes via `decodeReply` under the label `kelpi pane <verb>`. Then:

- `--json`: print the reply object minus the `ok` key, compact JSON with **sorted keys**,
  single line.
- Default: one-line ack `"<verb-phrase>: <pane_id>[ (<label>)][ in workspace <name>]"`,
  where verb-phrase is `split pane`, `created pane`, `renamed pane` respectively, and
  `pane_id` falls back to `?` when missing.

### 9.3 `kelpi pane create`

```
kelpi pane create [--path /dir] [--name <label>] [--workspace <name-or-uuid>]
                [--target <name-or-uuid>] [--json]
```

Same structure as split (help, leftover rejection, outside-pane guard with message
`requires --workspace <name-or-id> or --target <name-or-uuid> when called from outside a Kelpi pane`).
Payload: `{"command":"pane-create", path?, name?, target?, workspace?, pane_id?}`.
Printer verb: `created pane`.

Server semantics (contract): destination workspace precedence is `--target`'s workspace >
`--workspace` (wins over the caller's forwarded pane_id) > caller pane's workspace. Into an
empty workspace, creates the first pane (with the label/path applied); otherwise splits the
focused pane. Reply carries the real new pane id.

### 9.4 `kelpi pane close`

```
kelpi pane close [--target <name-or-uuid>] [--workspace <name-or-uuid>]
```

- `--help`/`-h`: dedicated usage to stdout, exit 0.
- After consuming `--target`/`--workspace` (+their values), any remaining token not in
  `{--target, --workspace, --help, -h}` is rejected:
  - starts with `-`: `kelpi pane close: unknown option <tok>`
  - else: `kelpi pane close: unexpected argument '<tok>' — use --target <name-or-uuid> to address a specific pane`
  then usage to stderr, exit 1. **Positional targets are rejected by design** (issue #108:
  a typo'd positional used to silently close the caller).
- `--workspace` without `--target`:
  `kelpi pane close: --workspace requires --target <name-or-uuid>` + usage, exit 1 (a bare
  workspace scope would otherwise fall through to closing the caller).
- With `--target`: payload `{"command":"pane-close","target":..., pane_id?}` (pane_id only
  when `KELPI_PANE_ID` non-empty; used only for label scoping). Works from outside a pane.
- Without `--target`: `requirePaneID()` (silent exit 0 outside a pane); payload
  `{"command":"pane-close","pane_id":...}`.
- `workspace` added to payload when given.
- Request/response via `decodeReply`; success prints
  `pane deleted: <pane_id>[ (<label>)][ in workspace <name>]`.

### 9.5 `kelpi pane name`

```
kelpi pane name <name>
kelpi pane name --target <name-or-uuid> [--workspace <name-or-uuid>] [--json] <name>
```

- Help to stdout, exit 0.
- Consume `--target`, `--workspace`, `--json`. Then any remaining token starting with `-`
  is `unknown option` (usage, exit 1). The remaining non-dash tokens must be exactly one
  non-empty positional (the new label), else
  `kelpi pane name: exactly one <name> argument is required` (usage, exit 1). Consequence:
  a label starting with `-` cannot be set via CLI.
- Requires `--target` or a non-empty `KELPI_PANE_ID`, else
  `kelpi pane name: requires --target <name-or-uuid> when called from outside a Kelpi pane`.
- Payload: `{"command":"pane-name","name":<label>, target?, workspace?, pane_id?}`.
- Printer verb: `renamed pane` (reply includes the resolved `pane_id`).

### 9.6 `kelpi pane resize` (issue #241)

```
kelpi pane resize [--target X] [--workspace Y] (--ratio <0..1> | --grow [amt] | --shrink [amt]) [--json]
```

- Help to stdout, exit 0.
- Exactly one directive of `--ratio` / `--grow` / `--shrink`, else
  `kelpi pane resize: exactly one of --ratio / --grow / --shrink is required` + usage, exit 1.
- Leftovers rejected with hint `size panes with --ratio / --grow / --shrink`.
- Outside-pane guard: needs `--target` or non-empty `KELPI_PANE_ID`
  (`requires --target <name-or-uuid> when called from outside a Kelpi pane`).
- `--ratio` must parse as a float strictly between 0 and 1 (exclusive), else
  `kelpi pane resize: --ratio must be a number between 0 and 1 (exclusive)`, exit 1.
- `--grow [amt]` / `--shrink [amt]`: optional-amount flags, default step 0.05.
- Payload: `{"command":"pane-resize", ratio? , delta?, target?, workspace?, pane_id?}`
  where `delta = +grow` or `-shrink` (only one of ratio/delta present).
- Bespoke empty-reply handling (6.5). `--json` prints reply minus `ok` (compact, sorted).
- Default ack: `resized <pane_id>[ (<label>)][ to NN% of its split][ in workspace <ws>]`
  where NN = `target_share * 100` rounded to 0 decimals (`%.0f%%` formatting).

Server semantics (contract): resolves the target like `pane name`; finds the enclosing
split; translates the requested pane share to the split's stored first-child ratio (a
second-child's share is `1 - ratio`); clamps effective share to `[0.1, 0.9]`; refuses a
sole-leaf pane (no sibling). Reply:
`{ok, pane_id, workspace_id, workspace_name, split_path, ratio, target_share, label?}`.

### 9.7 `kelpi pane send`

```
kelpi pane send [--bare] [--json] --target <name-or-uuid> [--workspace <name-or-uuid>] <command...>
```

- Help to stdout, exit 0.
- `--target` (or the legacy quiet alias `--to`) is **required**; missing => usage to
  stderr, exit 1.
- Flags parsed first (`--workspace`, `--bare`, `--json`); everything remaining is joined
  with single spaces to form the text. Empty text => usage, exit 1. There is **no `--`
  terminator** here, so a literal `--bare`/`--json` inside the text is consumed as a flag
  (known limitation; keep it for compatibility).
- Payload:

  ```json
  {"command":"pane-send","target":"worker-1","text":"ls -la","bare":false,
   "pane_id":"<caller uuid, only when KELPI_PANE_ID non-empty>","workspace":"alpha"}
  ```

  Note `bare` is always present (boolean).
- Empty reply => success, exit 0, silent (6.5).
- `--json`: reply minus `ok`, compact sorted.
- Default ack: `sent to <id>` or `sent (bare) to <id>` (using the reply's `bare` field),
  plus optional ` (<label>)` and ` in workspace <ws>`.

Server semantics: writes text to the target PTY; unless `bare`, follows with an Enter
keystroke. Reply includes resolved `pane_id`, `label?`, `workspace_name?`, `bare`.

### 9.8 `kelpi pane send-key`

```
kelpi pane send-key --target <name-or-uuid> [--workspace <name-or-uuid>] <key>
```

- `--target` required (non-empty), else usage line to stderr, exit 1.
- Remaining dash-prefixed tokens => `kelpi pane send-key: unknown option <tok>` + usage,
  exit 1. Exactly one positional key token required, else usage + the valid-key list line:
  `       <key> is one of: enter, return, tab, escape, esc, space, backspace, up, down, left, right, ctrl-c`.
- The CLI does **not** validate the key name; the server rejects unknown names with a
  structured error before touching the surface.
- Payload: `{"command":"pane-send-key","target":...,"key":<verbatim>, pane_id?, workspace?}`.
- Bespoke empty-reply error (6.5). No `--json`.
- Ack: `sent <key> to <id>[ (<label>)][ in workspace <ws>]` where `<key>` is the reply's
  `key` field, falling back to the input lowercased.

Server semantics (contract): named keystroke delivered outside any bracketed-paste
envelope. Byte-mapped keys (enter/return, tab, escape/esc, space, backspace, ctrl-c) go
through the key-event path with no modifiers and the raw byte as text (ctrl-c => 0x03 so
the PTY line discipline raises SIGINT); arrow keys ship no text so the terminal-mode
translation applies (DECCKM `\eOA` vs `\e[A`). Works without `KELPI_PANE_ID`; UUID targets
global, labels need scope.

### 9.9 `kelpi pane move`

Two forms, auto-detected: the presence of `--target` or any zone flag selects the adjacent
form.

**Directional (fire-and-forget, caller pane):**

```
kelpi pane move <left|right|up|down>
```

- `requirePaneID()` (silent exit 0 outside).
- Missing direction => usage to stderr, exit 1. Invalid =>
  `Invalid direction: <x>` + `Valid directions: left, right, up, down`, exit 1.
- Payload: `{"command":"pane-move","pane_id":...,"direction":"left"}`. No reply.

**Adjacent (request/response, issue #241):**

```
kelpi pane move --target X (--above|--below|--left-of|--right-of) Y [--workspace Z] [--json]
```

- Zone flags are value-taking flags (the value is the anchor pane Y).
- `--target` missing while a zone flag is present:
  `kelpi pane move: the adjacent form requires --target <name-or-uuid>` + usage, exit 1.
- Exactly one zone flag required:
  `kelpi pane move: exactly one of --above / --below / --left-of / --right-of <anchor> is required`.
- Leftovers rejected with hint
  `dock a pane with --target X --below/--above/--left-of/--right-of Y`.
- Payload: `{"command":"pane-move-adjacent","target":X,"anchor":Y,
  "zone":"above"|"below"|"left-of"|"right-of", workspace?, pane_id?}`.
- Bespoke empty-reply error. `--json` prints reply minus `ok` (compact sorted).
- Ack: `moved <pane_id>[ (<label>)] <zone> <anchor_id>[ in workspace <ws>]` (ids fall back
  to the input strings).

Server semantics (contract): X resolved like `pane name`; Y must resolve **within X's
workspace**; edges map to drop zones top/bottom/left/right; rejects X == Y, a missing
anchor, or a cross-workspace anchor. Reply:
`{ok, pane_id, anchor_id, zone, workspace_id, workspace_name, label?}`.

### 9.10 `kelpi pane move-to-workspace`

```
kelpi pane move-to-workspace --to-workspace <name-or-uuid> [--create]
```

- `requirePaneID()` first (silent exit 0 outside a pane).
- `--to-workspace` required, else usage, exit 1.
- Fire-and-forget payload (legacy field names, keep them exactly):

  ```json
  {"command":"pane-move-to-workspace","pane_id":"...","name":"<dest>","text":"true"}
  ```

  `"text":"true"` (a string!) is present only when `--create` was passed.

### 9.11 `kelpi pane list`

```
kelpi pane list [--workspace <name-or-id> | --current] [--json] [--no-header]
```

- Help to stdout, exit 0. Leftovers rejected.
- `--workspace` and `--current` together:
  `pane list: --workspace and --current are mutually exclusive`, exit 1.
- `--current` requires `KELPI_PANE_ID` via `requirePaneID()` (silent exit 0 outside);
  payload gains `"pane_id"` and `"scope":"current"`.
- Payload: `{"command":"pane-list", workspace?, pane_id?, scope?}`.
- Reply contract: `{ok:true, "panes":[ {...}, ... ]}` where each pane object has at least:
  `id` (full pane UUID), `label?`, `type` (`shell|markdown|scratchpad|diff|web`),
  `workspace_name`, `status`, `agent_session_id?` (full UUID), `working_directory`,
  plus `agent?` (last-known agent kind), `background_tasks?`, `group_id?`/`group_name?`
  in the JSON (the table renderer only uses the columns below).
- `--json`: print the `panes` **array unwrapped**, compact JSON, sorted keys, exit 0.
- Table rendering (`--no-header` omits the header row):
  - Columns: `ID  LABEL  TYPE  WORKSPACE  STATUS  SESSION  CWD`.
  - ID prints the **full UUID** (copy-pasteable into `--target`; issue #240).
  - LABEL: `label` or `-`. TYPE: `type` or `-`.
  - SESSION: `-` when `agent_session_id` empty; else truncated as `first8…last4`
    (only when length >= 12, else verbatim; the ellipsis is the single character `…`).
  - CWD: `working_directory` with a leading `$HOME` prefix replaced by `~`.
  - Column widths: max of header (when shown) and data lengths; two-space gutter; last
    column (CWD) unpadded to avoid trailing whitespace.

### 9.12 `kelpi pane capture`

```
kelpi pane capture [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--lines N] [--scrollback]
```

- Help to stdout, exit 0. Leftovers rejected with hint
  `target panes with --target <name-or-uuid>` (a bare positional UUID must fail loudly,
  never fall back to capturing the caller).
- `--lines` must parse as a positive integer, else
  `kelpi pane capture: --lines must be a positive integer`, exit 1.
- With `--target`: payload includes `target` and (when `KELPI_PANE_ID` non-empty) `pane_id`
  for label scoping. Without: `requirePaneID()` (silent exit 0 outside) and `pane_id` is
  the subject.
- Payload: `{"command":"pane-capture", target?, pane_id?, workspace?, lines?, scrollback?}`
  (`scrollback` only present, as `true`, when the switch was given; `lines` a number).
- Reply: `{ok:true, "text":"..."}`. On success the CLI writes the raw `text` bytes to
  stdout **without appending a trailing newline** (captured output usually ends in one).
- Server contract: without `--scrollback` reads the visible viewport; with it, the full
  screen+scrollback. Non-terminal panes (markdown/scratchpad/diff) are refused with a
  typed `ok:false` error. `--lines N` limits to the last N lines.

### 9.13 `kelpi pane sync` (issue #121)

```
kelpi pane sync (on|off|toggle|status) [--workspace <name-or-uuid>] [--json]
kelpi pane sync exclude --target <name-or-uuid> [--workspace <name-or-uuid>] [--json]
kelpi pane sync include --target <name-or-uuid> [--workspace <name-or-uuid>] [--json]
```

- Missing mode => usage to stderr, exit 1. `-h|--help|help` => usage to stdout, exit 0.
- `--workspace` and `--json` are parsed **before** the mode switch.
- Modes `on|off|toggle|status`:
  - A stray `--target X` is a hard error:
    `kelpi pane sync <mode>: --target <X> is not valid here (the toggle is workspace-wide). Use `kelpi pane sync exclude --target ...` to opt a pane out.`
    exit 1.
  - Any other leftover: `kelpi pane sync <mode>: unexpected argument '<tok>'`, exit 1.
  - Payload: `{"command":"pane-sync","action":"<mode>", workspace?, pane_id?}`.
- Modes `exclude|include`:
  - `--target` required (non-empty), else usage line, exit 1. Leftovers rejected.
  - Payload: `{"command":"pane-sync-exclude","target":...,"excluded":true|false, workspace?, pane_id?}`
    (`excluded` = mode == exclude).
- Unknown mode: `Unknown sync mode: <x>` + usage, exit 1.
- All forms request/response with bespoke empty-reply error (6.5) under labels
  `kelpi pane sync <mode>`.
- `--json`: reply minus `ok`, compact sorted.
- Default human rendering (from reply fields `active: bool`,
  `synced_pane_ids: string[]`, `excluded: [{id, label?}]`, `workspace_name`):

  ```
  workspace: <name-or-?>
  sync     : on|off
  synced   : N pane[s]            (only when active)
  excluded : lbl1, lbl2           (only when active and non-empty; label falls back to id, then "?")
  ```

Behavioral contract (server): the sync group is workspace-wide over shell panes minus the
excluded set, only "active" when >= 2 qualify; every `on`/`off`/`toggle` clears the
exclusion set, so `exclude` must run after `on`. Scope defaults to the caller's workspace
via `KELPI_PANE_ID`; `--workspace` overrides.

---

## 10. `kelpi workspace`

Dispatcher: missing action => group usage to stderr, exit 1; `--help|-h|help` => group
usage to stdout, exit 0; unknown action => `Unknown workspace action: <x>` +
`Valid actions: list, create, move, delete, profile, label`, exit 1.

### 10.1 `kelpi workspace list`

```
kelpi workspace list [--group <name-or-id>] [--json] [--no-header]
```

- Help to stdout, exit 0. Leftovers rejected.
- Payload: `{"command":"workspace-list", group?}`.
- Reply: `{ok:true, "workspaces":[...]}` in sidebar order (members of collapsed groups
  included). Each entry (server contract): `id`, `name`, `color`, `pane_count`,
  `is_active`, `created_at`, `last_accessed_at`, `labels` (always present, possibly `[]`),
  optional `last_activity_at`, optional `agent_session_id`, optional
  `group_id`/`group_name` (both absent for top-level). Timestamps ISO 8601.
- `--group` scoping an unknown/ambiguous group is an `ok:false` error (distinct from an
  empty group => empty list, exit 0).
- `--json`: the array unwrapped, compact, sorted keys.
- Table columns: `ID  NAME  GROUP  PANES  ACTIVE  LABELS`.
  - ID short-form `first8…last4` (>=12 chars only).
  - GROUP: `group_name` or `-`.
  - ACTIVE: `●` when `is_active` else `-`.
  - LABELS: comma-joined (no spaces) or `-`.
  - Width computation like pane list; LABELS (last column) unpadded. Note: LABELS does not
    participate in width computation (it is always last).

### 10.2 `kelpi workspace create`

```
kelpi workspace create [--name "..."] [--path /dir] [--color blue] [--group <name>]
                     [--profile <name>] [--json]
kelpi workspace create --worktree <name> [--branch <name>] [--repo <path>]
                     [--update-main] [--group <existing>] [--json]
```

- Help to stdout, exit 0. Leftovers rejected.
- Payload: `{"command":"workspace-create", name?, path?, color?, group?, profile?}`.
  When `--worktree` is given, additionally: `worktree`, `branch?`,
  `update_main: true` (only when the switch was passed), and **always** `repo`
  (= `--repo` value, defaulting to the CLI process's cwd).
- Request/response. Read timeout 120 seconds when `--worktree` present (worktree add plus
  optional `git fetch`), default otherwise.
- `--json`: prints the **full reply including `ok`**, compact, sorted keys.
- Default output variants (from reply fields; name falls back to the `--name` argument or
  `"Workspace"`, id to `?`):
  - worktree: `created workspace <name> (<id>)[ in group <g>] with worktree <path> on branch <branch>`
    (branch falls back to `?`).
  - plain with group: `created workspace <name> (<id>) in group <g>`
  - plain: `created workspace <name> (<id>)`

Server contract highlights: `--group` creates the group if missing UNLESS `--worktree` is
present (then the group must already exist; unknown/ambiguous => `ok:false`, avoiding an
orphaned group on worktree-add failure). Ambiguous `--group` name => `ok:false`
"...ambiguous...". `--profile` assigns a workspace profile at creation. Worktree path is
`resolvedWorktreeBasePath/<sanitized-name>`; `--branch` defaults to the worktree name;
`--update-main` fetches and branches off `origin/<default>` (resolved via
`git ls-remote --symref`). Worktree reply adds `worktree_path` and `branch`.

### 10.3 `kelpi workspace move`

```
kelpi workspace move <name-or-id> (--group <name> | --top-level) [--index N]
```

- Help to stdout, exit 0. Missing name-or-id => usage to stderr, exit 1.
- Neither/both of `--group`/`--top-level`:
  `workspace move requires --group <name> or --top-level` /
  `workspace move can't take both --group and --top-level`, exit 1.
- `--index` must parse as an integer, else `--index must be an integer`, exit 1.
- Fire-and-forget payload: `{"command":"workspace-move","name":<name-or-id>, group?, index?}`
  where `index` is a native JSON number and `--top-level` is expressed by **omitting**
  `group` entirely. No output on success.
- Server contract: `--group` requires an existing group (unlike create).

### 10.4 `kelpi workspace delete`

```
kelpi workspace delete <name-or-id> [<name-or-id> ...] [--force|-y] [--prune-worktree] [--json]
```

- Help to stdout, exit 0.
- `--force` and `-y` are popped **unconditionally** (both consumed even when passed
  together); either sets force.
- Remaining args must all be bare name-or-id targets; any dash-prefixed token =>
  `Unknown option for workspace delete: <tok>` + usage line, exit 1.
- Exact-duplicate ids deduped preserving first-seen order. Zero targets => usage, exit 1.
- Loop: one `{"command":"workspace-delete","name":<id>,"force":<bool>}` request per id via
  `decodeReplyAllowingFailure` (6.4; transport/empty/invalid-JSON is fatal for the whole
  batch, `ok:false` is recorded and the loop continues).
- Per-id result record (for `--json`): `{"id": <argument as typed>, "ok": bool}` plus on
  success `workspace_id?`, `workspace_name`, `path?`, and when `--prune-worktree`:
  `worktree_pruned: bool`, `worktree_error?`; on failure `error` and `active_agents?`
  (from a running-agents refusal).
- Human output: per success `deleted workspace <name>`; per prune result an indented
  `  <message>` on success or `Warning: <message>` to stderr on failure; per failed delete
  `kelpi workspace delete: <error>` to stderr.
- `--json`: single-line compact sorted array of the records (printed at the end).
- Exit 1 if **any** delete failed (prune failures do NOT affect the exit code).

Server contract: refuses to delete the last remaining workspace; refuses (without force) a
workspace with active agents:
`{ok:false,"error":"…has N running agent(s); pass --force…","active_agents":N}`; ambiguous
names get a distinct "ambiguous" error; success reply carries `workspace_id`,
`workspace_name`, and `path` (a shell pane's current cwd; absent for empty workspaces).

#### 10.4.1 `pruneWorktree(path)` algorithm (CLI-side, best effort)

```
top = run(env git -C <path> rev-parse --show-toplevel)
if top failed: return (false, "not a git worktree, skipped prune: <path>[ (<stderr>)]")
root = trim(top.stdout)
common = run(env git -C <path> rev-parse --path-format=absolute --git-common-dir)
runDir = common ok ? dirname(trim(common.stdout))   # <main>/.git -> <main>
                   : root                            # fallback
rm = run(env git -C <runDir> worktree remove <root>) # NON-forcing on purpose
if rm ok: return (true, "removed worktree: <root>")
return (false, "git worktree remove failed for <root>[: <stderr>]")
```

Non-forcing means git refuses dirty/locked worktrees and the primary checkout; those
become warnings, and the workspace remains deleted regardless. When the deleted workspace
had no panes there is no `path`; message:
`workspace <name> had no panes; no directory to prune`.

Subprocesses are run capturing stdout and stderr concurrently (a sequential drain can
deadlock on >16KB pipe output).

### 10.5 `kelpi workspace profile`

```
kelpi workspace profile <name-or-id> (<profile> | --clear)
```

- Help to stdout, exit 0. Missing name-or-id => usage to stderr, exit 1.
- Exactly one of positional `<profile>` / `--clear`, else
  `workspace profile requires either <profile> or --clear`, exit 1.
- Trailing tokens rejected:
  `workspace profile: unexpected argument(s): <joined>`, exit 1 (a stray word would pin
  the wrong profile/account silently).
- Fire-and-forget payload: `{"command":"workspace-profile","name":<name-or-id>, profile?}`
  where `--clear` omits `profile` entirely (server treats missing/empty as clear).

### 10.6 `kelpi workspace label` (issue #225)

```
kelpi workspace label <name-or-id> (--set v [--set v ...] | --add v [...] | --remove v [...] | --clear) [--json]
```

- Help to stdout, exit 0. Missing name-or-id => usage to stderr, exit 1.
- `--set`/`--add`/`--remove` are repeatable (collected in loops).
- A literal `--style` anywhere =>
  `workspace label: --style is not yet supported; set label colors in Settings ▸ Labels`,
  exit 1 (deliberate pointer; colors are set in the GUI settings).
- Leftovers rejected. Exactly one operation, else
  `workspace label requires exactly one of --set / --add / --remove / --clear`, exit 1.
- Payload:
  `{"command":"workspace-label","name":<name-or-id>,"label_op":"set|add|remove|clear","label_values":[...]}`
  (`clear` ships `[]`).
- Request/response. `--json`: full reply **including `ok`**, compact sorted.
- Default: `"<workspace_name> labels: a, b"` or `"<name> labels: (none)"`
  (workspace name falls back to the input argument).

Server contract: values normalized (trimmed, empties dropped); `set` replaces, `add`
dedup-appends, `remove` drops matches, `clear` empties; each label a `set`/`add`
introduces also gets a gray label preset (existing presets never overwritten);
`remove`/`clear` leave presets intact. Reply
`{ok, workspace_id, workspace_name, labels}` reflects the post-mutation set.

---

## 11. `kelpi group`

Dispatcher: missing action => `Usage: kelpi group list|create|rename|delete|reorder|sort [...]`
to stderr, exit 1; `--help|-h|help` => overview (with subcommand one-liners) to stdout,
exit 0; unknown => `Unknown group action: <x>` +
`Valid actions: list, create, rename, delete, reorder, sort`, exit 1.

### 11.1 `kelpi group list`

```
kelpi group list [--json] [--no-header]
```

- Leftover args (after the two switches) => usage line, exit 1.
- Payload `{"command":"group-list"}`; reply `{ok, "groups":[...]}` where each group has
  `id`, `name`, `color?`, `workspaces: [{id, name}]` in sidebar order.
- `--json`: the array unwrapped, compact sorted. Empty => `[]`, exit 0.
- Table: `ID  NAME  COLOR  WORKSPACES`; ID short-uuid; COLOR falls back `-`; WORKSPACES is
  `name (shortid)` pairs comma-joined (name-less members print just the short id), `-`
  when empty; last column unpadded.

### 11.2 `kelpi group create <name> [--color blue]`

Fire-and-forget `{"command":"group-create","name":..., color?}`. Missing name => usage,
exit 1.

### 11.3 `kelpi group rename <name-or-id> <new-name>`

Fire-and-forget `{"command":"group-rename","name":...,"new_name":...}`. Missing either
positional => usage, exit 1.

### 11.4 `kelpi group delete <name-or-id> [--cascade]`

Fire-and-forget `{"command":"group-delete","name":...,"cascade":<bool>}` (`cascade` a
native JSON boolean, always present). Without cascade the server promotes children to top
level.

### 11.5 `kelpi group reorder` (issue #225)

```
kelpi group reorder <name-or-id> --order <id1,id2,...> [--json]
```

- Help to stdout, exit 0. Missing name-or-id => usage to stderr, exit 1.
- `--order` required, else `group reorder requires --order <id1,id2,...>`, exit 1.
- Leftovers rejected. The order string is split on commas **and/or spaces**, empties
  dropped; empty result => `group reorder: --order was empty`, exit 1.
- Payload: `{"command":"group-reorder","name":...,"order":[...]}` (each token a member
  UUID or a name unique within the group).
- Reply `{ok, group_id, group_name, order}` (full member UUIDs, post-reorder). Shared
  renderer: `--json` => full reply incl. `ok`, compact sorted; default =>
  `group <group_name> order: <id1>, <id2>, ...` (group name falls back `?`).
- Server contract: non-member or duplicate token => error, nothing written; omitted
  members keep their relative order at the tail.

### 11.6 `kelpi group sort` (issue #225)

```
kelpi group sort <name-or-id> --by name|last-activity|last-accessed [--desc] [--json]
```

- Help/missing-name handling as reorder. `--by` required, else
  `group sort requires --by name|last-activity|last-accessed`, exit 1 (value forwarded
  verbatim; the server validates keys, including the `last-modified` alias for
  last-accessed).
- Payload: `{"command":"group-sort","name":...,"by":...,"descending":<bool>}`.
- Same reply/renderer as reorder. Sorting is stable server-side, ascending by default.

---

## 12. `kelpi layout`

```
kelpi layout cycle
kelpi layout select <name>
```

- Missing action => `Usage: kelpi layout cycle|select <name>`, exit 1.
- `requirePaneID()` before dispatch (silent exit 0 outside a pane) — note this happens
  even before validating the action.
- `cycle`: fire-and-forget `{"command":"layout-cycle","pane_id":...}`.
- `select`: missing name => usage +
  `Valid layouts: even-horizontal, even-vertical, main-horizontal, main-vertical, tiled`,
  exit 1. Fire-and-forget `{"command":"layout-select","pane_id":...,"name":<verbatim>}`
  (no client-side validation of the layout name).
- Unknown action => `Unknown layout action: <x>` + `Valid actions: cycle, select`, exit 1.

---

## 13. `kelpi open`, `kelpi md`, `kelpi diff` (file/URL routing)

### 13.1 Routing tables (exact contents)

```ts
const markdownOpenExtensions = new Set([
  "md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "markdn",
]);

const webOpenExtensions = new Set([
  "html", "htm", "pdf", "svg", "png", "jpg", "jpeg", "gif", "webp",
]);

// Applies ONLY to the bare dotted-hostname case in `kelpi open`.
// Deliberately excludes TLDs colliding with common file extensions
// (.sh, .ai, .app, .pl, .rs, .so, .cc, .zip, .mov, .md, .pt ...).
const webOpenCommonTLDs = new Set([
  // generic
  "com","org","net","edu","gov","mil","int","info","biz",
  "name","pro","io","co","dev","xyz","tech","online","site",
  "store","blog","cloud","page","wiki","news","email","me",
  // country/regional (low collision; .pt intentionally omitted: PyTorch checkpoints)
  "us","uk","ca","au","nz","de","fr","es","it","nl","se",
  "no","fi","dk","ie","eu","jp","cn","kr","in","br","mx",
  "ru","ch","at","be","za","tv","fm","gg","to","ly",
  "id","sg","hk",
]);
```

### 13.2 `localFileURL(forWebArg arg) -> string | null` (issue #177)

Used by `web open` / `web navigate` / `web tab-new` and (indirectly, as the "is it local?"
oracle) by `kelpi open`. Returns a percent-encoded `file://` URL when the argument denotes a
local path, else null (caller forwards the raw string; the app treats it as URL/host).

```
trimmed = arg.trim()
if trimmed == "": return null
if trimmed contains "://": return null                      # already a full URL
# Opaque scheme without "://" (data:, mailto:, about:, tel:, vscode:, ...):
if trimmed has a ":" AND trimmed[0] is a letter:
    scheme = text before the first ":"
    if every char of scheme is letter|digit|'+'|'-'|'.'
       AND the char right after ":" is NOT a digit:          # digit => host:port, not scheme
        return null

looksLikePath = trimmed starts with "/" | "./" | "../" | "~"
path = trimmed; if starts with "~": expand tilde
absolute = standardize(resolve(path, against cwd))           # file URL

if looksLikePath: return absolute.file URL string            # even if it doesn't exist
# Bare argument: only a file when a REGULAR FILE with a NON-EMPTY EXTENSION exists at
# that name in the cwd. Directories and extensionless names are never files here, so
# dev hostnames like `app` / `web` / `api` that collide with cwd dirs aren't hijacked;
# `./app` forces a local path.
if exists(absolute) AND not directory AND absolute has a path extension:
    return absolute.file URL string
return null
```

The produced string is a standard `file:///...` URL with percent-encoding (spaces etc.).

### 13.3 `webTargetForOpenArg(arg) -> string | null`

The `kelpi open` URL/host detector, the mirror image of `localFileURL`:

```
trimmed = arg.trim(); if "": return null
if localFileURL(trimmed) != null: return null            # explicit paths + existing files stay local
if trimmed contains "://": return trimmed                # real URL (any scheme)

authority = trimmed up to the first "/", "?" or "#"
if authority == "": return null
host = authority; hasPort = false
if host has a ":" whose suffix (after the LAST ":") is non-empty and all digits:
    hasPort = true; host = part before that colon
if host == "": return null
lower = host.lowercase()

if lower == "localhost": return trimmed                  # incl. localhost:port
octets = lower.split "." keeping empties
if 4 octets, all non-empty, each parses as 0..255: return trimmed   # IPv4 literal
if hasPort: return trimmed                               # any host:port is web
labels = lower.split "." keeping empties
if labels.count >= 2 AND all labels non-empty AND labels.last in webOpenCommonTLDs:
    return trimmed                                       # bare dotted host w/ known TLD
return null                                              # bare words, backup.1, notes.txt, foo.museum
```

Note the interaction: `./google.com` is a file (explicit path); an existing local file
`report.pdf` in the cwd stays local even though `.pdf` is a web extension type — it goes
through the file router (which then routes it to a web pane as `file://`).

### 13.4 `kelpi open [--here] <path-or-url>`

- `-h|--help|help` as first arg: 4-line help to stdout, exit 0:

  ```
  Usage: kelpi open [--here] <path-or-url>
  URLs & hostnames (google.com, https://…, localhost:3000) → web pane.
  Local files route by type: .md/.markdown → markdown pane;
  .html/.htm/.pdf/.svg and images (.png/.jpg/.gif/.webp) → web pane.
  ```

- `--here` popped; then exactly one positional required and it must not start with `-`,
  else usage to stderr, exit 1.
- If `webTargetForOpenArg` returns a URL: if `--here` was given, print
  `kelpi open: --here is ignored for URLs (web panes always open in a new pane)` to stderr;
  then send `web-open` (13.7) and print its ack. Request/response.
- Else, resolve to an absolute standardized path; lowercase the path extension:
  - in `markdownOpenExtensions`: markdown route (13.6), honoring `--here`.
  - in `webOpenExtensions`: if `--here`, stderr note
    `kelpi open: --here is ignored for web files (web panes always open in a new pane)`;
    send `web-open` with the `file://` absolute URL string.
  - otherwise: multi-line error to stderr, exit 1:

    ```
    kelpi open: don't know how to open '.<ext>' files      (or: ... open files without an extension)
           URLs & hostnames (e.g. google.com) open a web pane;
           Markdown (.md, .markdown) opens a preview pane; .html/.htm/.pdf/.svg and
           images (.png/.jpg/.gif/.webp) open a web pane.
           Use `kelpi md <file>` to force a markdown pane, or `kelpi web open <url>`.
    ```

### 13.5 `kelpi md [--here] <filepath>`

- Help token as first arg: `Usage: kelpi md [--here] <filepath>` to stdout, exit 0.
- `--here` popped; one positional required, must not start with `-`, else usage, exit 1.
- Always the markdown route (13.6) regardless of extension (the escape hatch for forcing
  markdown on any file). The path is standardized to absolute against cwd.

### 13.6 Markdown route (shared by `md` and `open`)

Fire-and-forget payload:

```json
{"command":"open","path":"/abs/standardized/path.md","pane_id":"<KELPI_PANE_ID if set, even empty>","reuse":true}
```

`reuse` present only with `--here` (reuse the calling pane instead of opening a new one).
Note this path forwards `KELPI_PANE_ID` even when it is an empty string (plain `if let`, no
isEmpty check).

### 13.7 `kelpi open`'s web route

Request/response payload `{"command":"web-open","url":<url>, pane_id?}` (pane_id only when
`KELPI_PANE_ID` non-empty), decoded via the standard envelope and printed with the basic web
printer under the label/verb `open`: `open ok: <pane_id>[ (<url>)]`.

### 13.8 `kelpi diff [<path>]`

Fire-and-forget:

```json
{"command":"diff","repo_path":"<cwd>","target_path":"/abs/path","pane_id":"..."}
```

- `repo_path` is always the CLI's cwd.
- `target_path` present only when a positional was given; resolved absolute against cwd,
  standardized.
- `pane_id` included whenever `KELPI_PANE_ID` is set (even empty).
- Extra positionals beyond the first are silently ignored. No help flag.

---

## 14. `kelpi graft`

Dispatcher: missing action => `Usage: kelpi graft start|stop|status` to stderr, exit 1;
`-h|--help|help` prints the graft usage block to **stderr** and returns (exit 0);
unknown => `Unknown graft action: <x>` + `Valid actions: start, stop, status`, exit 1.

### 14.1 `kelpi graft start` / `kelpi graft stop`

```
kelpi graft start [--workspace <name-or-uuid>] [--repo <name-or-path>]
kelpi graft stop  [--workspace <name-or-uuid>] [--repo <name-or-path>]
```

- Payload: `{"command":"graft-start"|"graft-stop", workspace?, repo?}`. When **neither**
  filter is given and `KELPI_PANE_ID` is set, `pane_id` is attached (default scope = the
  caller's workspace).
- Request/response (`decodeReply`, label `kelpi graft-start` / `kelpi graft-stop`).
- `start` rendering: for each entry of reply `started: [{association_id, branch, worktree_path}]`
  print `started <branch> (<assoc>) at <path>` (each field falls back `-`); empty =>
  `No associations started.`. A reply `partial_error: string` prints
  `Partial failure: <msg>` to stderr (exit stays 0).
- `stop` rendering: for each id in reply `stopped: string[]` print `stopped <id>`;
  empty => `No active sessions in scope.`. If reply `failed: [{association_id, error}]` is
  non-empty, print `failed <id>: <err>` per entry to stderr and **exit 1**.

### 14.2 `kelpi graft status [--json]`

Payload `{"command":"graft-status"}`. Reply `{ok, sessions:[...]}`.
`--json`: the sessions array unwrapped, compact sorted. Default: per session
`<branch> [<status>] <worktree_path>` (fields fall back `-`); empty =>
`No active graft sessions.`.

---

## 15. `kelpi web`

All web verbs are request/response. Dispatcher: missing action => web usage to stderr,
exit 1; `-h|--help|help` => usage to stdout, exit 0; unknown =>
`Unknown web action: <x>` + usage, exit 1.

### 15.1 Target scope rule (`attachWebTargetScope`)

Applied to every verb except `open`. Adds `target?`, `workspace?`, and `pane_id?`
(non-empty `KELPI_PANE_ID`) to the payload, then enforces client-side (before any socket
traffic):

- label target (non-UUID) + no `--workspace` + no origin pane:
  `kelpi web <verb>: --target by label requires --workspace <name-or-id> when called outside a Kelpi pane`, exit 1.
- no target at all + no origin pane:
  `kelpi web <verb>: no --target supplied and KELPI_PANE_ID is not set`, exit 1.

Server-side, no target means "the caller pane" (which must be a web pane, or the verb
errors), a UUID target is global, a label target resolves in the scoped workspace.

### 15.2 Reply envelope handling (`decodeWebReply`)

- Uses `readReplyOrExit` under label `kelpi web <verb>` (so transport/empty-reply behave per
  section 6.1).
- Invalid JSON: `kelpi web <verb>: invalid JSON response`, exit 1.
- With `--json`: the **full reply including `ok` is pretty-printed** (multi-line, sorted
  keys) BEFORE the ok check, so failures still dump their JSON.
- `ok == false`: without `--json`, `kelpi web <verb>: <error>` to stderr; either way exit 1.

### 15.3 `kelpi web open [--private] <url>`

- Explicit `--target`/`--workspace` present anywhere => 3-line error, exit 1:

  ```
  kelpi web open: --target / --workspace are not supported (open always creates a new pane).
         Use `kelpi web navigate <url> --target X [--workspace Y]` to redirect an existing pane's active tab,
         or `kelpi web tab-new <url> --target X` to open in a new tab.
  ```

- One positional URL required, non-empty, must not start with `-`
  (`kelpi web open: unexpected option '<x>' (URL must not start with '-')`).
- URL is passed through `localFileURL` first (13.2); the file URL replaces the argument
  when it resolves. Payload: `{"command":"web-open","url":...,
  "private":true?, pane_id?}`.
- Printed with the basic printer: `open ok: <pane_id>[ (<url>)]`.

### 15.4 `kelpi web navigate <url> [--target X] [--workspace Y]`

Same URL validation and `localFileURL` mapping. Payload
`{"command":"web-navigate","url":...}` + scope. Basic printer: `navigate ok: ...`.

### 15.5 `kelpi web url|back|forward|reload`

- `url`: payload `{"command":"web-url"}` + scope. Prints `<url>\t<title>` when title
  non-empty, else just `<url>`.
- `back`/`forward`: `{"command":"web-back"|"web-forward"}` + scope; basic printer.
- `reload [--hard]`: `{"command":"web-reload", hard:true?}` + scope; basic printer.

### 15.6 `kelpi web capture [--mode meta|text|screenshot|dom|all]`

- Mode defaults to `meta`; invalid =>
  `kelpi web capture: unknown --mode '<m>' (allowed: meta, text, screenshot, dom, all)`,
  exit 1.
- Payload `{"command":"web-capture","mode":...}` + scope.
- Rendering by reply `mode`:
  - `text`: print reply `text` if present.
  - `dom`: print reply `html` if present.
  - `screenshot`: print reply `path` if present, else `png_base64` (caller pipes to
    `base64 -D`).
  - `all`: dump the whole reply as compact sorted JSON.
  - `meta` (default): `url:    <url>` line, then `title:  <t>` when non-empty, then
    `bytes:  <n>` when `byte_count` present.

### 15.7 Tabs

- `tabs [--json] [--no-header]`: payload `{"command":"web-tabs"}` + scope. Reply
  `{ok, tabs:[{index, active, title, url, id?}]}`. `--json` => tabs array compact sorted.
  Plain: header `IDX  A  TITLE                    URL` (unless `--no-header`), rows via
  format `%-3d  %@  %-24@  %@` with `*` for active (space otherwise) and title clipped at
  >24 chars to 23 + `…`.
- `tab-new [<url>] [--no-focus]`: url optional (empty string allowed); non-empty urls go
  through `localFileURL`. Payload `{"command":"web-tab-new","url":...,
  "make_active": !noFocus}` + scope. Basic printer.
- `tab-close <ref>` / `tab-select <ref>`: one required positional; payload
  `{"command":"web-tab-close"|"web-tab-select","tab":<ref>}` + scope. Basic printer.

### 15.8 `kelpi web console`

```
kelpi web console [--target ...] [--workspace ...] [--since N] [--level log|debug|info|warn|error]
                [--clear] [--follow] [--json]
```

- `--since` must be an unsigned integer
  (`kelpi web console: --since must be an unsigned integer (got '<x>')`, exit 1).
- `--level` restricted to `log|debug|info|warn|error`
  (`kelpi web console: --level must be one of log|debug|info|warn|error`, exit 1).
- Payload: `{"command":"web-console", since?, level?, clear:true?, follow:true?}` + scope.
- Non-follow: `decodeReply` under `kelpi web console`. Reply
  `{ok, lines:[{seq, level, message}], dropped?, next_since?}`.
  - `--json`: whole reply compact sorted, one line.
  - Plain: `(dropped N lines before this batch — buffer was full)` to **stderr** when
    `dropped > 0`; each line as `[<seq>] <level>: <message>`; then
    `(next_since=N)` to stderr when present.
- `--follow` (streaming, 5.8): the first server line is the catch-up drain in the same
  envelope; if it carries `ok:false` => `kelpi web console: <error>` to stderr, exit 1.
  Plain mode prints the drain like the non-follow case then
  `(following — press Ctrl-C to stop)` to stderr; every subsequent line is a single
  console entry object, printed as `[seq] level: message` (with a
  `(dropped N lines)` stderr notice when a line object carries `dropped > 0`).
  `--json` prints each received object (drain and entries alike) as compact sorted JSON
  lines. Unparseable stream lines are silently skipped. Connection failure => transport
  failure under `kelpi web console --follow`, exit 1.

### 15.9 `kelpi web inspect` / `inspect-result`

- `inspect [--send-to <pane>] [--submit] [--disarm]`: payload
  `{"command":"web-inspect", send_to?, submit:true?, disarm:true?}` + scope. Rendering
  from reply: `armed == false` => `inspect disarmed: <pane_id>`; armed with empty
  `send_to` => `inspect armed: <pane_id> — click an element in the web pane to capture`;
  armed with send_to => `inspect armed: <pane_id> → will paste to <send_to>` plus
  ` (+submit)` when reply `submit` is true.
- `inspect-result [--clear] [--json]`: payload `{"command":"web-inspect-result",
  clear:true?}` + scope. Reply `results: [{selector, url, tag, ...}]`. `--json` => array
  compact sorted. Plain: `(no pending inspect results)` when empty; else per result
  `<tag>  <selector>  (<url>)`.

### 15.10 `kelpi web private on|off`

- Mode required; accepted truthy `on|true|1|yes`, falsy `off|false|0|no`
  (case-insensitive); else `kelpi web private: expected 'on' or 'off' (got '<x>')`, exit 1.
- Payload `{"command":"web-private","private":<bool>}` + scope.
- Print: `private on|off: <pane_id>[ (no change)]` (suffix when reply `changed` false).

### 15.11 `kelpi web cookies`

Sub-dispatcher (missing/unknown action or help mirrors the other groups; help to stdout).

- `list [--json]`: `{"command":"web-cookies-list"}` + scope. `--json` => `cookies` array
  compact sorted. Plain: `(no cookies)` when empty; else header
  `DOMAIN                     NAME                 VALUE` and rows sorted by
  (domain, name), format `%-26@  %-20@  %@` with clipping domain>24 => 23+`…`,
  name>20 => 19+`…`, value>40 => 39+`…`.
- `clear [--domain <d>] [--all]`: `--all` with `--domain` =>
  `kelpi web cookies clear: --all and --domain are mutually exclusive`, exit 1. Payload
  `{"command":"web-cookies-clear", domain?, all:true?}` + scope. Print:
  `cleared all site data` when `--all` or reply `cleared_site_data`; else
  `deleted N cookie[s][ for <domain>]`.
- `delete <name> [--domain <d>]`: name via `--name` flag or first positional; payload
  `{"command":"web-cookies-delete","name":..., domain?}` + scope. Reply `deleted: int`;
  zero => `no cookie matched name '<name>'`, **exit 1**; else
  `deleted N cookie[s] named '<name>'`.

### 15.12 Actuator verbs (`click`, `type`, `select`, `scroll`, `hover`, `key`, `wait`)

Common: `--json` dumps the full pretty reply (15.2); default prints the one-liner below;
`ok:false` => stderr + exit 1.

- `click <selector> [--double] [--right] [--at x,y]`: `--` tail supported. `--at` must be
  two comma-separated numbers (`kelpi web click: --at must be 'x,y' numbers (got '<v>')`).
  Payload `{"command":"web-click","selector":..., double?, right?, at_x?, at_y?}`.
  Print: `clicked` or `clicked: "<text>"` (reply `text` when non-empty).
- `type <selector> <text> [--submit] [--no-replace]`: `--` tail supported; both
  positionals required (text may be empty string? No: selector must be non-empty; text is
  just popped, may be an empty string token). Payload
  `{"command":"web-type","selector":...,"text":..., submit?, replace:false?}`
  (`--no-replace` sends `replace: false`; default omits the key). Print:
  `typed: <reply.value>`.
- `select <selector> <value-or-label>`: `--` tail supported. Payload
  `{"command":"web-select","selector":...,"value_or_label":...}`. Print:
  `selected: <label-or-value>` (label preferred when non-empty).
- `scroll <selector> [--top|--bottom|--smooth]`: `--top` + `--bottom` =>
  `kelpi web scroll: --top and --bottom are mutually exclusive`, exit 1. Payload
  `{"command":"web-scroll","selector":...,"block":"start"|"end"|"center",
  "behavior":"smooth"|"instant"}`. Print: `scrolled`.
- `hover <selector>`: `{"command":"web-hover","selector":...}`. Print: `hovered`.
- `key <key-name> [--selector <sel>]`: `{"command":"web-key","key":..., selector?}`.
  Print: `key: <reply.key>`.
- `wait (--selector <sel> | --url-match <substr-or-regex>) [--for visible|hidden|exists|count=N|text=X] [--timeout S]`:
  exactly one of selector/url-match
  (`kelpi web wait: one of --selector or --url-match is required` /
  `kelpi web wait: --selector and --url-match are mutually exclusive`). `--timeout` must be
  a positive finite number of seconds (rejects `inf`, `1e309`;
  `kelpi web wait: --timeout must be a positive finite number of seconds (got '<x>')`),
  default 10. Payload `{"command":"web-wait","timeout_ms":<int seconds*1000>,
  selector?, url_match?, for?}`. Socket read timeout = `max(ceil(s)+5, default)`.
  Print (only reached when the condition fired; a timeout is an `ok:false` reply):
  `matched <condition> in <waited_ms> ms` (condition falls back `exists`, waited 0).

### 15.13 Read verbs (`text`, `attr`, `count`, `exists`, `dom`)

Wire commands are prefixed `web-q-`: `web-q-text`, `web-q-attr`, `web-q-count`,
`web-q-exists`, `web-q-dom`. All take a required non-empty `<selector>` positional
(plus `<attribute>` for attr). `--max-bytes N` (text, dom) must be a positive integer
(`kelpi web <verb>: --max-bytes must be a positive integer (got '<x>')`).

Default rendering / exit semantics:

- `text`: print reply `text` (possibly empty line).
- `attr`: reply `present: bool` distinguishes absent from empty. Absent => **exit 1**, no
  output. Present => print `value` (may be empty), exit 0.
- `count`: print reply `count` (int, default 0).
- `exists`: no output; exit 0 when reply `found` true, exit 1 otherwise. **The exit-code
  behavior survives `--json`** (JSON dump prints, then exit 1 when not found) so
  until-loops keep working.
- `dom`: print reply `outer_html`.

### 15.14 `kelpi web exec`

```
kelpi web exec [--target X] [--workspace Y] [--timeout S] (--file <path> | <js>) [--json]
```

- `--timeout`: positive finite seconds, default **30** (exec scripts routinely chain
  `kelpi.wait`, which alone defaults to 10s JS-side).
- Script source: `--file <path>` (unreadable =>
  `kelpi web exec: cannot read --file '<path>'`, exit 1) else the first positional; neither
  => usage, exit 1.
- Payload `{"command":"web-exec","script":<source>}` + scope. Note: the CLI does NOT ship
  the timeout on the wire; it only pads its socket read timeout to
  `max(ceil(s)+5, default)`.
- Default rendering of reply `result`:
  - JSON null: print nothing.
  - string: printed raw (unquoted).
  - boolean: `true`/`false`.
  - number: integer-preserving formatting (no trailing `.0` for integers).
  - anything else (object/array): compact sorted JSON (fragments allowed).
- JS-side contract (server subsystem): the script runs inside an async wrapper with
  `$` / `$$` / `kelpi` bound to the actuator helpers; a single trailing expression is
  returned automatically; multi-statement scripts need an explicit `return`.

---

## 16. `kelpi doctor`

```
kelpi doctor [--json]
```

- Any leftover argument: `kelpi doctor: unexpected argument: <x>` +
  `Usage: kelpi doctor [--json]`, exit **2**.
- Runs seven checks in order, collecting `{name, status, detail, repair?}` records where
  status is one of `PASS | WARN | FAIL | SKIP`.
- Exit code: 1 if **any check FAILed**, else 0. WARNs never change the exit code (scripts
  gate on transport/app health, not advisory drift).
- Human output: per check `[STATUS] <name>: <detail>`, plus a second line
  `        → <repair>` for non-PASS checks that carry a repair. Then a blank line and
  either `All checks passed.` or `Summary: N fail(s), M warn(s).`.
- `--json`: `{"ok": <exitCode==0>, "checks":[{"name","status"(lowercased),"detail","repair"?}]}`
  compact on one line.

### 16.1 Check 1: `transport`

Always PASS; detail `Unix socket at /tmp/kelpi.sock` or `TCP <host>:<port> (from KELPI_SOCKET)`.

### 16.2 Check 2: `socket` (unix) / `resolve` (tcp)

- Unix: `stat` the socket path. Missing => FAIL,
  detail `Unix socket file <path> does not exist.`,
  repair `Is Kelpi running? Launch the Kelpi app and re-run `kelpi doctor`.`
  Present => PASS `socket file exists`.
- TCP: `getaddrinfo(host)` (no port). Failure => FAIL `cannot resolve host "<host>"`,
  repair `Check the hostname in KELPI_SOCKET. From a dev container use `tcp:host.docker.internal:<port>`.`
  Success => PASS `hostname resolves`.

### 16.3 Check 3: `ping`

Sends `{"command":"ping"}` with a **2 second** read timeout. This is the one check that
exercises the same dispatch path real commands use.

- Transport failure (nil): FAIL with the standard categorized error/repair text rendered
  under the command label `kelpi doctor` (or, with no diagnostic captured,
  detail `kelpi doctor: transport failure (no diagnostic captured).`,
  repair `Re-run with more verbose tooling, or restart Kelpi.`).
- Empty reply: FAIL,
  detail `connected, but Kelpi closed the connection before replying — likely a pre-ping (<v0.26) Kelpi, or the app is wedged.`,
  repair `Rebuild and relaunch Kelpi if you're on a recent main; if `ping` still fails, restart the app.`
- Not JSON or `ok != true`: FAIL `received malformed reply (<n> bytes).`,
  repair `Restart Kelpi. If reproducible, file an issue with the raw bytes.`
- Otherwise PASS `round-trip ok (app pid <pid-or-?>)`, and stash `pid` and `version` from
  the reply for the next two checks.

Ping reply contract (daemon must implement):
`{"ok":true,"version":"<short version>","build":"<build>","pid":<int>}`.

### 16.4 Check 4: `process`

- TCP transport: SKIP,
  detail `skipped (TCP transport — running Kelpi is on a remote host).`
- Unix: run `/bin/ps -axo pid=,comm=`, keep rows whose comm **ends with**
  `Kelpi.app/Contents/MacOS/Kelpi`, parse pids. (Deliberately `ps`, not `pgrep`: pgrep
  matching is inconsistent across macOS sandbox contexts.)
  - No pids: FAIL `no running Kelpi.app process found`,
    repair `Launch Kelpi from /Applications (or wherever you installed it), then re-run `kelpi doctor`.`
  - Ping pid known but not among the pids: WARN
    `found pids [..], but ping replied from pid N — multiple Kelpi instances?`,
    repair `Quit the stale instances (`kill <pid>`) and keep one running.`
  - Else PASS `Kelpi.app running (pids: a, b)`.

### 16.5 Check 5: `version`

- No version from ping: SKIP `skipped (ping did not return a version)`.
- Exact string equality CLI vs app: PASS `CLI <v> matches app <v>`; else WARN
  `CLI is <v>; app is <w>.`,
  repair `Rebuild Kelpi (or relaunch from the latest build) so the bundled CLI matches the running app.`

### 16.6 Check 6: `hooks` (Claude Code, local filesystem only)

Expected hook set (kept in lockstep with `install-hooks.sh`; substring matching over the
accepted CLI spellings — `kelpi`, the pre-rename `nex`, and the entry-file forms `kelpi.js` /
`nex.js` — so absolute paths, a hook that runs `/…/dist/kelpi.js event stop`, and extra flags
all count):

```ts
const expectedHooks: Array<[event: string, command: string]> = [
  ["Stop",             "kelpi event stop"],
  ["Notification",     "kelpi event notification"],
  ["SessionStart",     "kelpi event session-start"],
  ["SessionEnd",       "kelpi event session-end"],
  ["UserPromptSubmit", "kelpi event start"],
];
const sessionStartSources = ["startup", "resume", "clear", "compact"];
```

Procedure (dir = `~/.claude` resolved through `$HOME`, passwd fallback):

1. Try to read and JSON-parse `settings.json` then `settings.local.json` in that order
   (later files take precedence for scalar settings, mirroring Claude Code). Track
   unreadable-but-present files.
2. If neither file exists/parses and none were unreadable:
   - `~/.claude` directory exists: WARN
     `no Claude Code settings in ~/.claude — kelpi hooks are not installed, so agent status and session ids won't track.`
   - No directory: SKIP `skipped (no ~/.claude directory — Claude Code not detected)`
     (machine doesn't run Claude Code; don't nag).
3. Otherwise accumulate `problems`:
   - Unreadable files: `not valid JSON: <names> (Claude Code itself needs these parseable)`.
   - `disableAllHooks`: take the **last file that defines it** (local over user); if true:
     `"disableAllHooks": true is set — every hook (including kelpi's) is disabled, so session ids and agent status won't track`.
   - Missing hooks: for each expected (event, command), gather all groups under
     `hooks.<event>` across all parsed files (casting per element so one malformed entry
     cannot hide a valid sibling); a group "wires" the command when any inner hook object
     has a string `command` **containing** the expected command as a substring. If no
     group wires it: `missing hook(s): Ev → `cmd`, ...`.
   - SessionStart matcher coverage: over the groups wiring `kelpi event session-start`,
     collect each group's `matcher` (string or nil; nil = fires for every source). A
     source is covered when any group's matcher is nil or `matcherCovers(matcher, source)`.
     If any of the four sources is uncovered:
     `SessionStart matcher "<m1>", "<m2>" misses source(s): <list>` plus, when `resume` is
     among them,
     ` — resumed sessions (`claude --continue` / `--resume`) won't bind their session id (issue #181)`.
4. No problems: PASS `all kelpi hooks wired in ~/.claude (checked <files>)`.
   Problems: WARN
   `hook config drift in ~/.claude (checked <files>; project-level settings scopes not checked): <problems joined with "; ">`,
   repair
   `Re-run the bundled installer (safe to re-run — it merges, dedupes, and normalises kelpi-managed hooks): /Applications/Nex.app/Contents/Resources/scripts/install-hooks.sh`.

Drift is always WARN, never FAIL: IPC is healthy; only agent tracking degrades.

#### 16.6.1 `matcherCovers(matcher, source)` (Claude Code's documented matcher semantics)

```
m = matcher.trim()
if m == "" or m == "*": return true
if every scalar of m is in [A-Za-z0-9_- ,|] (incl. space):
    # a |- or ,-separated list of exact strings
    return m.split(on: "|" or ",").map(trim).contains(source)
# otherwise an unanchored regex, JS-style `new RegExp(m).test(source)`
if m fails to compile as a regex: return false     # Claude Code wouldn't fire it either
return regex-search(m, source) matched
```

### 16.7 Check 7: `codex-hooks`

Expected set:

```ts
const expectedCodexHooks = [
  ["Stop",              "kelpi event stop --agent codex"],
  ["PermissionRequest", "kelpi event notification --agent codex"],
  ["SessionStart",      "kelpi event session-start --agent codex"],
  ["UserPromptSubmit",  "kelpi event start --agent codex"],
];
```

(Codex has no SessionEnd or Notification event; PermissionRequest is the
"waiting on approval" signal.)

Procedure (dir = `~/.codex`):

- No directory: SKIP `skipped (no ~/.codex directory — Codex CLI not detected)`.
- No `hooks.json`: WARN
  `no hooks.json in ~/.codex — kelpi Codex hooks are not installed, so Codex panes won't track status or session ids (needs Codex CLI ≥ 0.142).`
- Invalid JSON: WARN `~/.codex/hooks.json is not valid JSON (Codex itself needs it parseable).`
- Same substring wiring check over `hooks.<event>` groups. All present: PASS
  `all kelpi Codex hooks wired in ~/.codex/hooks.json (trust state not verifiable — run /hooks inside codex if they don't fire; inline [hooks] in config.toml not checked)`.
  Missing: WARN
  `Codex hook config drift in ~/.codex/hooks.json (inline [hooks] in config.toml not checked): missing hook(s): <list>`.
- Repair for all WARNs:
  `Re-run the bundled installer (/Applications/Nex.app/Contents/Resources/scripts/install-hooks.sh), then run /hooks inside codex once to trust the kelpi hooks.`

Documented limitations: inline `[hooks]` tables in codex's `config.toml` are not parsed
(can false-warn), and hook trust is not inspectable (a wired-but-untrusted hook passes the
check but never fires), hence the `/hooks` step in every repair.

---

## 17. `install-hooks.sh`

Bash, `set -euo pipefail`. Run after installing Kelpi.app; safe to re-run (idempotent by way
of `merge_hooks.py` dedupe). Steps:

1. **Locate the app bundle**: `/Applications/Nex.app`, else `./Kelpi.app`; neither => error
   message and exit 1. The kelpi binary must exist at `<app>/Contents/Helpers/nex` (else
   error, exit 1).
2. **Install the CLI**: `mkdir -p $INSTALL_DIR` (default `/usr/local/bin`, overridable via
   `KELPI_INSTALL_DIR`), then `ln -sf <bundle-binary> $INSTALL_DIR/kelpi` (symlink so version
   resolution finds Info.plist; see 3.1). If `$INSTALL_DIR` is not on the current `PATH`,
   print a warning (hooks invoke bare `kelpi`, so the dir must be on PATH in the shells
   Claude Code runs hooks from).
3. **Claude Code hooks** into `$HOME/.claude/settings.json`:
   - The canonical hooks JSON wires the five `expectedHooks` events, each as one
     matcher-less group with one `{"type":"command","command":"kelpi event <x>"}` hook.
     (Matcher-less SessionStart fires for all sources: startup/resume/clear/compact.)
   - File exists: `python3 merge_hooks.py <file> <hooks-json>` (section 18).
   - File absent: write the hooks JSON verbatim as the new settings.json (2-space indent,
     trailing newline).
4. **Skill install**: if `<app>/Contents/Resources/skills/nex-agentic` exists, copy its
   `SKILL.md` to `~/.claude/skills/nex-agentic/SKILL.md`.
5. **Codex hooks** (runs last, non-fatal: a malformed `~/.codex/hooks.json` must not abort
   an installer whose primary job already succeeded):
   - Only when `~/.codex` exists (else print a skip note).
   - Same merge-or-create flow against `~/.codex/hooks.json` with the four
     `expectedCodexHooks` commands (each carrying `--agent codex`). Merge/write failures
     print warnings and continue.
   - Always prints the trust note: Codex requires one-time hook trust; run `/hooks` inside
     codex (repeat whenever the file changes); requires Codex CLI >= 0.142.
6. Final message: restart running agent sessions to pick up the new hooks.

---

## 18. `merge_hooks.py`

`merge_hooks.py <settings-path> <hooks-json>`; exit 2 on wrong arg count. Reads the
settings file (must be valid JSON; a parse exception propagates as a non-zero exit, which
the Codex path of the installer tolerates), merges, writes back with 2-space indent and a
trailing newline. Claude's `settings.json` and Codex's `hooks.json` share the same
three-level `hooks` shape, so one merger serves both.

Merge algorithm (preserves unrelated user hooks):

```
base_command(cmd) = cmd.split(" --")[0].strip()
  # the flag-less prefix is the kelpi-managed identity:
  # "kelpi event stop", "kelpi event stop --agent codex", and
  # "/Applications/Nex.app/.../kelpi event stop" all share base "kelpi event stop"
  # (via the substring test below).

settings.setdefault("hooks", {})
for (event, new_groups) in incoming.hooks:
    existing = settings.hooks.setdefault(event, [])
    for new_group in new_groups:                       # {matcher?, hooks:[...]}
        new_bases = { base_command(h.command)
                      for h in new_group.hooks
                      if h.type == "command" and h.command }
        is_kelpi_managed(cmd) = cmd != null and any(base in cmd for base in new_bases)
                                              # SUBSTRING containment
        # 1. Sweep: remove every kelpi-managed command hook from ALL existing groups
        #    of this event (absolute-path variants, flagged variants, and even
        #    composite user commands embedding a kelpi base, e.g.
        #    "notify.sh && kelpi event stop" — removing those is the deliberate
        #    trade-off; keeping them would double-fire, the worse failure).
        for grp in existing: grp.hooks = [h for h in grp.hooks
                                          if not (h.type == "command"
                                                  and is_kelpi_managed(h.command))]
        # 2. Prune groups left empty by the sweep (this is how stale matcher
        #    groups, e.g. pre-v0.19 SessionStart "startup", get migrated away).
        existing = [g for g in existing if g.hooks]
        # 3. Insert: find an existing group whose matcher == new_group.matcher
        #    (null == null counts); extend its hooks, else append new_group.
```

Consequences worth testing in a port:

- Re-running is idempotent (the sweep removes the previous install before re-adding).
- Upgrading a bare `kelpi event stop` to `kelpi event stop --agent codex` replaces rather than
  duplicates (both share the base).
- A stale `SessionStart` group with `"matcher": "startup"` collapses into the incoming
  matcher-less group, fixing issue #181 on re-run.
- Non-kelpi hooks in shared groups survive; groups only die when the sweep empties them.

---

## 19. Consolidated wire-command inventory (client -> server)

Fire-and-forget: `stop`, `start`, `error`, `notification`, `session-start`, `session-end`
(the event family; command = event name), `pane-move`, `pane-move-to-workspace`,
`workspace-move`, `workspace-profile`, `group-create`, `group-rename`, `group-delete`,
`layout-cycle`, `layout-select`, `open`, `diff`.

Request/response: `ping`, `pane-split`, `pane-create`, `pane-close`, `pane-name`,
`pane-resize`, `pane-send`, `pane-send-key`, `pane-move-adjacent`, `pane-list`,
`pane-capture`, `pane-sync`, `pane-sync-exclude`, `workspace-list`, `workspace-create`,
`workspace-delete`, `workspace-label`, `group-list`, `group-reorder`, `group-sort`,
`graft-start`, `graft-stop`, `graft-status`, and the web family: `web-open`,
`web-navigate`, `web-url`, `web-back`, `web-forward`, `web-reload`, `web-capture`,
`web-tabs`, `web-tab-new`, `web-tab-close`, `web-tab-select`, `web-console` (streaming
with `follow:true`), `web-inspect`, `web-inspect-result`, `web-private`,
`web-cookies-list`, `web-cookies-clear`, `web-cookies-delete`, `web-click`, `web-type`,
`web-q-text`, `web-q-attr`, `web-q-count`, `web-q-exists`, `web-q-dom`, `web-select`,
`web-scroll`, `web-hover`, `web-key`, `web-exec`, `web-wait`.

---

## 20. Port notes

Things the TypeScript port must get right, or may deliberately change:

1. **The daemon must speak this protocol byte-for-byte.** One JSON object per line in;
   one newline-terminated JSON reply then close (EOF is the CLI's end-of-reply signal;
   never keep the connection open after a non-streaming reply, or every CLI call will hang
   until its 5s timeout and report "no response from Kelpi (upgrade required?)"). The
   `web-console follow:true` stream is the single connection the server holds open.
2. **`{ok:false}` replies must be well-formed JSON with an `error` string**, on their own
   line, followed by close. The CLI's exit codes and stderr text depend on this envelope.
3. **Fire-and-forget commands get no reply.** Sending one anyway is harmless (the CLI
   never reads on those paths), but never block on them server-side; the CLI has already
   closed its end.
4. **Preserve legacy field quirks**: `pane-move-to-workspace` uses `"name"` for the
   destination and the string `"text":"true"` for --create; `workspace-profile` clears by
   omitting `profile`; `workspace-move` expresses top-level by omitting `group`;
   `pane-send` always ships a boolean `bare`; `group-delete` ships a native boolean
   `cascade` and `workspace-delete` a native boolean `force`; the web query verbs are
   `web-q-*` on the wire even though the CLI verbs are `text/attr/count/exists/dom`.
5. **Empty-reply compatibility shims**: `pane send` treats a 0-byte reply as success; the
   other bespoke handlers treat it as "server too old". A new daemon should simply always
   reply, making these dead paths, but a TS CLI rewrite must keep them for mixed-version
   tolerance.
6. **The Unix socket path `/tmp/kelpi.sock` is hardcoded** in the CLI (only the TCP
   alternative is configurable via `KELPI_SOCKET`). The daemon must bind exactly there for
   the existing CLI to find it. If the port wants a different path, it needs a new CLI or
   a symlink strategy.
7. **`ping` is a hard requirement**: reply
   `{"ok":true,"version":...,"build":...,"pid":<daemon pid>}` within 2 seconds. It backs
   doctor and version-drift detection. Under the new architecture, decide what `version`
   means (daemon version vs CLI bundle version) and keep it comparable to the CLI's own
   reported version, or doctor will WARN forever.
8. **Doctor's `process` check is macOS-app-shaped**: it greps `ps` for
   `Kelpi.app/Contents/MacOS/Kelpi`. A TS CLI rewrite should re-point this at the daemon
   process (and the Electron shell separately, if desired); against the old CLI this check
   will FAIL when the Swift app is gone even though the daemon is healthy, so a ported
   daemon that must satisfy the *old* CLI's doctor cannot fully pass it (transport, socket,
   ping, version, hooks all can; `process` cannot). Acceptable: doctor exits non-zero only
   on FAIL, and `process` FAIL is exactly the "app not running" signal users will see,
   so either ship a renamed daemon binary path check in a new CLI or accept the FAIL
   during transition.
9. **Version resolution via Info.plist symlink-walking is Swift-app-specific.** A TS CLI
   should embed its version at build time; keep `"dev"` as the unknown fallback and keep
   `kelpi --version` printing `kelpi <version>`.
10. **stdout/stderr discipline matters**: acks and data to stdout; usage errors, warnings,
    `Repair:` lines, `(next_since=...)`, `(dropped ...)`, and the follow banner to stderr.
    Scripts pipe stdout (e.g. `pane capture`, `web capture --mode screenshot | base64 -D`),
    so nothing advisory may leak into stdout. `pane capture` writes raw bytes with no
    added trailing newline.
11. **Parsing quirks to reproduce faithfully in a CLI rewrite**: flags anywhere in argv;
    values consumed even when dash-prefixed; flag-at-end leaves the flag token to be
    rejected as unknown; `--` tail only on `web click|type|select`; `pane send` joins all
    leftovers with single spaces (no quoting round-trip: consecutive spaces in the
    original text are collapsed by the shell anyway, but a quoted argument containing
    literal `--json` will be eaten as a flag); labels cannot start with `-`.
12. **The routing tables (13.1) and the two routing functions (13.2, 13.3) are
    user-visible contracts** exercised by muscle memory (`kelpi open google.com`,
    `kelpi web open foo.html`, `./app` to force a path). Port them with table-driven tests:
    scheme detection (letter-led colon, non-digit next), `host:port`, IPv4, localhost,
    known-TLD gating, existing-file-with-extension rule, directory/extensionless
    exclusion, tilde expansion.
13. **`background_tasks` is an observed, undocumented Claude Code field.** Keep the
    terminal-status-exclusion counting (8.5) exactly: counting only `"running"` would
    silently re-introduce the flip-to-waiting bug on a Claude Code release that renames
    active states.
14. **The `event` path must never fail or spam**: exit 0 on every transport problem,
    suppress warnings by default (`KELPI_VERBOSE_HOOKS` opt-in), silent exit 0 without
    `KELPI_PANE_ID`. Hooks run on every agent turn on machines where Kelpi may not be running.
15. **`workspace delete --prune-worktree` and `workspace create --worktree` shell out to
    git on the CLI side / server side respectively.** In the new architecture the daemon
    owns worktree creation (`workspace-create` with `worktree` fields, 120s client
    timeout) while the *prune* is CLI-local (runs `git` from the caller's machine). If the
    daemon moves to a different host than the CLI (tailnet clients), CLI-local pruning
    breaks; consider moving prune server-side behind a new reply field while keeping the
    CLI flags stable.
16. **doctor's hooks checks are CLI-local filesystem reads** (`~/.claude`, `~/.codex`);
    they inspect the machine where the CLI (and thus the agent CLIs) run, which stays
    correct in the remote-daemon world. Do not move them server-side.
17. **Table renderers** (pane list, workspace list, group list, web tabs, cookies) are
    parsed by humans and occasionally by scripts with `--no-header`; keep column order,
    the `…` short-uuid form, `-` placeholders, the `●` active marker, and full pane UUIDs
    in `pane list` (issue #240).
18. **Timeout envelope**: default 5s (`KELPI_REPLY_TIMEOUT` override), 2s ping, 120s
    worktree create, `wait`/`exec` padded by +5s over their logical timeouts. A daemon
    reply path that can exceed these must be extended in both places.
19. **`--json` output shapes differ by family** and scripts depend on them: pane mutation
    verbs and sync strip the `ok` key (compact, sorted); `workspace create`/`label`,
    `group reorder`/`sort` include `ok` (compact, sorted); list verbs unwrap the array;
    `workspace delete` emits a bespoke per-id array; web verbs pretty-print the full
    envelope including `ok` (multi-line). Do not normalize these in a rewrite.
20. **Concurrent pipe draining** for subprocesses (doctor's `ps`, prune's git) avoids a
    real deadlock at >16KB of child output; a Node rewrite using `child_process.execFile`
    gets this for free, but a manual stream implementation must drain stdout and stderr
    concurrently.

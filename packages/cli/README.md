# `@kelpi/cli` — the `kelpi` command line

A TypeScript rewrite of the shipped Swift `nex` binary (`nex 0.32.0`, bundled at
`Nex.app/Contents/Helpers/nex`). It speaks the same control protocol, prints the same lines to
the same streams, and exits with the same codes, so it is a drop-in replacement for scripts,
agents and the Claude Code / Codex hooks.

Contract: [`docs/current/cli.md`](../../docs/current/cli.md). Measured deltas of the shipped
binary: [`docs/compat-status.md`](../../docs/compat-status.md).

## Install

```bash
pnpm --filter @kelpi/cli build          # → packages/cli/dist/kelpi.js (executable, shebang'd)
node packages/cli/dist/kelpi.js install-hooks --link
```

`install-hooks --link` symlinks this binary into `/usr/local/bin` (or `$KELPI_INSTALL_DIR` /
`--install-dir`) and then wires the agent hooks — see [Hooks](#hooks-kelpi-install-hooks) below.
The symlink half alone is still just `ln -sf "$PWD/packages/cli/dist/kelpi.js" /usr/local/bin/kelpi`.

`dist/kelpi.js` is a single dependency-free file: `node dist/kelpi.js …` works from anywhere, and
so does exec'ing it directly (mode 0755 + `#!/usr/bin/env node`). Nothing needs to be installed
beside it — unlike the daemon, it has no native dependencies.

The Swift installer symlinked the binary so it could find its `Info.plist` and report a
version; this CLI has no bundle to walk, so a symlink is now just a symlink. Version identity
comes from compiled-in constants, overridable at runtime for a packaging step:

| Variable | Meaning |
|---|---|
| `KELPI_CLI_VERSION` | Overrides the reported version (`kelpi --version`, doctor). |
| `KELPI_CLI_BUILD` | Overrides the reported build id (doctor only). |

## Hooks: `kelpi install-hooks`

The port of `scripts/install-hooks.sh` + `merge_hooks.py` from the Swift repo, as a subcommand
(gap #1) — which is also what `kelpi doctor`'s `hooks` / `codex-hooks` repair lines now name,
since the port ships no shell script for them to point at.

```
kelpi install-hooks [--claude-dir <dir>] [--codex-dir <dir>] [--command <prefix>]
                  [--link [--install-dir <dir>]] [--dry-run] [--json]
```

| It writes | Where | Events |
|---|---|---|
| 5 Claude Code hooks | `~/.claude/settings.json` (`--claude-dir`) | `Stop`, `Notification`, `SessionStart` (**matcher-less**), `SessionEnd`, `UserPromptSubmit` |
| 4 Codex CLI hooks, `--agent codex` | `~/.codex/hooks.json` (`--codex-dir`), only when the directory exists | `Stop`, `PermissionRequest`, `SessionStart`, `UserPromptSubmit` |

Behaviour carried over verbatim from the Python, and verified byte-for-byte against goldens it
generated (`tests/fixtures/hooks/`, regenerable with their `generate.sh`):

- unrelated user hooks are preserved; only kelpi-managed commands are replaced;
- dedupe is by the command's **flag-less base** (everything before the first ` --`), and any
  existing command *containing* that base goes — so `/Applications/Nex.app/Contents/Helpers/nex
  event stop`, a bare `kelpi event stop` and `kelpi event stop --agent codex` are one identity, not
  three hooks firing three times. The documented trade-off comes too: a composite user command
  embedding a kelpi base (`notify.sh && kelpi event stop`) is swept from that event;
- an incoming group joins an existing group with the **same matcher**, so the pre-v0.19
  `"matcher": "startup"` SessionStart group empties, is pruned, and is replaced by a
  matcher-less one — the issue #181 repair;
- output is `json.dump(..., indent=2)` + a trailing newline, so a re-run is byte-identical.

Added on top, because a subcommand is re-run more casually than a downloaded script: an
existing file is copied to `<file>.kelpi-backup` before it changes; an unchanged result is
reported as `unchanged` instead of rewritten; `--dry-run` writes nothing; and a file that is
not valid JSON is **refused**, never overwritten (fatal for Claude, a warning for Codex — the
Codex section is best-effort by design, exactly as the shell script's was).

### What the hooks invoke, and the PATH assumption

Hook commands run in the *non-interactive* shell the agent CLI spawns: it does not read
`~/.zshrc` and inherits the agent process's own `PATH`. So the command is resolved rather than
assumed — `--command` wins if given; otherwise a bare `kelpi` when a `kelpi` on `PATH` really
resolves to this binary (verified, not hoped); otherwise this binary's absolute path,
shell-quoted. `--link` runs first so a fresh machine can reach the bare form on its first run,
and warns when the install directory is not on `PATH`. An unwritable directory prints the
`sudo` command to run by hand: this CLI never escalates privileges itself.

## Parity statement

Everything in `cli.md` is implemented: `event` (all six, hook payload parsing on stdin,
`background_tasks` terminal-status-exclusion counting, sub-agent filtering), `pane`
(split/create/close/name/send/send-key/capture/resize/list/sync/id, both `move` forms,
`move-to-workspace`), `workspace` (list/create incl. `--worktree`/delete incl.
`--prune-worktree`/move/profile/label), `group` (list/create/rename/delete/reorder/sort),
`layout`, `open`/`md`/`diff` routing, the whole `web` family, `graft`, `ping` (through
`doctor`) and `doctor`. The parsing primitives are ported bug-for-bug: flags anywhere in argv,
dash-prefixed values consumed, a value-less trailing flag left to be rejected as an unknown
option, `--` tails only on `web click|type|select`, `pane send` joining leftovers with single
spaces, and the leftover-argument rejection that makes `kelpi pane capture <uuid>` fail loudly.

How this is measured, and what "parity" is worth:

- **The compat suite runs against this binary.** `packages/daemon/tests/compat` boots real
  daemons, drives a CLI as a child process and asserts exit codes and parsed JSON. All 103
  tests pass with `KELPI_COMPAT_CLI` pointed at `dist/kelpi.js`, and they still pass against the
  shipped Swift binary:

  ```bash
  KELPI_COMPAT_CLI="$PWD/packages/cli/dist/kelpi.js" npx vitest run packages/daemon/tests/compat
  ```

- **A differential run** over ~114 parse-level invocations (usage errors, scope guards, bad
  values, transport failures against a dead port) found no divergence in exit code, stdout or
  stderr between this CLI and the shipped binary. The only differences are the version string
  and three usage-block lines the shipped binary forgot to list (`workspace label`,
  `group reorder|sort`) plus the `--follow` documentation below.

### Two deliberate divergences

1. **`web console --follow` is implemented.** `cli.md` §15.8 documents it and the daemon has
   spoken it since M6, but the shipped 0.32.0 binary predates the flag (it would silently send
   `follow:false`). This CLI holds the connection open with no read timeout, prints the
   catch-up drain as line 1, then one console entry per line, and exits **130** on Ctrl-C after
   closing the socket so the daemon releases the held reply handle.
2. **`web capture` keeps the SHIPPED flag set**, not `cli.md`'s. `cli.md` §15.6 documents
   `--mode dom|all` and a `--json` envelope dump; the binary that ships accepts
   `--mode meta|text|screenshot` only, refuses the others client-side with
   `unknown --mode '<m>' (allowed: meta, text, screenshot)`, and silently drops `--json`
   (docs/compat-status.md delta 8, pinned by `web.test.ts`). A drop-in replacement has to
   behave like the thing it replaces, so the client-side narrowing is reproduced; the daemon
   still accepts the full documented mode set.

## `kelpi doctor` in the daemon world

Seven checks, same names, same PASS/WARN/FAIL/SKIP vocabulary, same exit rule (non-zero only
when something FAILs). Two of them are re-pointed at `kelpid`:

**`process`** — the Swift check grepped `ps` for `Kelpi.app/Contents/MacOS/Kelpi` and FAILed when
the app was absent, which in the new architecture is the normal case. It now accepts any of:

1. a **live pid record** in the daemon run dir (`daemon-v<PROTOCOL>.pid`, resolved from
   `KELPID_RUN_DIR` or the platform default, and cross-checked with `kill(pid, 0)` so a stale
   record does not count);
2. a **`kelpid` / `kelpid.js` process** in the process table (a bundled daemon runs under `node`,
   so its `comm` is the node binary and only the full command line shows it);
3. the **Swift app**, exactly as before.

Only when none of the three exists is it a FAIL ("no running kelpid or Kelpi.app process found").
TCP transport still SKIPs — the daemon is on another host and its process table is not ours to
read.

**`version`** — the CLI and the daemon are separate artifacts now, so a version-string
difference is not the "you forgot to relaunch the app" signal it used to be. The check
therefore compares, in order:

| Situation | Status |
|---|---|
| ping returned no version | SKIP |
| `protocol` differs from the CLI's compiled `PROTOCOL_VERSION` | WARN — "protocol drift", the one that actually breaks the wire |
| version **and** build identical | PASS |
| anything else | WARN, explicitly advisory ("the CLI and the daemon are separate artifacts and the wire protocol matches") |

Neither WARN changes the exit code, so `kelpi doctor` stays usable as a transport/app-health gate
in scripts.

`hooks` and `codex-hooks` are unchanged: local reads of `~/.claude/settings.json` +
`settings.local.json` and `~/.codex/hooks.json`, including the SessionStart matcher-coverage
check that catches a pre-v0.19 `"matcher": "startup"` (issue #181). They inspect the machine
where the agent CLIs run, which stays correct when the daemon lives elsewhere.

## Transport

`NEX_SOCKET` selects the transport, exactly as before: absent (or any value not starting with
`tcp:`) is the **hardcoded** Unix socket `/tmp/nex.sock`; `tcp:<host>:<port>` is TCP. A
malformed `tcp:` value falls back to the Unix socket silently. Other environment variables:
`NEX_PANE_ID`, `KELPI_REPLY_TIMEOUT` (seconds, default 5), `KELPI_SILENT`, `KELPI_VERBOSE_HOOKS`,
`HOME`.

Failures are categorized (`unixSocketMissing`, `unixConnectRefused`, `tcpResolveFailed`,
`tcpConnectFailed`, `emptyReply`, …) and rendered as an `Error:`/`Repair:` pair — `Warning:` on
fire-and-forget commands, which always exit 0.

## Tests

```bash
npx vitest run packages/cli            # unit + integration (builds dist/kelpi.js first)
```

- `src/*.test.ts` — the pure halves: parsing primitives, the routing tables, table renderers,
  transport-failure text, the doctor checks (with synthetic filesystems and process tables).
- `tests/integration.test.ts` — the **bundled binary** as a child process against a fake
  control server on an ephemeral TCP port: exit codes, stream discipline, the exact JSON on the
  wire, the `--follow` stream and its Ctrl-C exit.

The tests never touch `/tmp/nex.sock`, `~/.config`, `~/Library/Application Support` or any
real daemon: every path is a private temp directory and every socket is a local TCP listener
the test owns.

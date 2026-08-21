# New Nex

A ground-up port of [Nex](https://github.com/benfriebe/nex) — the macOS terminal multiplexer built
on libghostty — to a **daemon + web client** architecture.

The daemon (`nexd`) owns the sessions: PTYs, terminal state, workspaces, layouts and agent
tracking live in a headless Node process that survives app restarts and updates. Clients (an
Electron shell on the desktop, or any browser over a tailnet) attach to it and render. The
existing `nex` CLI and the Claude Code / Codex hooks keep working unchanged — the daemon speaks
the same newline-JSON control protocol on the same socket.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the process model, [`docs/PARITY.md`](docs/PARITY.md)
for where the port stands against the macOS app, and [`PLAN.md`](PLAN.md) for the milestone plan.
Behavioural contracts for every subsystem live in [`docs/current/`](docs/current).

## Status

**Wire parity, an audited UI whose defect ledger is down to one accepted engine limit and one
newly-found minor, and 96% of the shipped app's feature surface.** The daemon, the web client, the
Electron shell, content panes, web panes, graft, the `nex` CLI rewrite and the legacy `nex.db`
importer are all built and green against the shipped Swift binary. The window has been driven end to
end and photographed a dozen times over: the campaign opened with **17 defects + 6 nits, two of them
blockers**, and stands at **no blockers — 1 accepted major (the daemon's VT does not reflow on
resize), 2 minors, 1 nit.** Four of the five findings the re-audits added are closed: the
intermittent terminal-renderer start failure, the **packaged `Nex.app`** window (`smoke:packaged` is
58/58), a context submenu that opened past the window's right edge, and a sidebar that resolved
every drop target ~2 px per row above the rows themselves. The fifth is new, and is the honest cost
of re-scoring: the status bar's `doc N +A -B` ships, passes four unit tests, and renders **nothing**
for a repo under a symlinked path.

A green ledger was not the same as a finished product. An item-by-item inventory of the shipped
app — [`docs/capabilities/`](docs/capabilities/00-INDEX.md), **1490 scored items** across ten
domains — found 285 behaviours with no port-side implementation at all. Three burn-downs took that
column to **4**, and coverage from 73.6% to **95.9%**, while the audit grew to **93 flows, 626
assertions**. What is still open is ranked in that index's §2, now headed by the engine's IME and
modifier-key limits — the mouse-reporting gap that headed it last time was closed by taking mouse
reporting away from the engine and writing it into the port, byte-identically to ghostty's own
encoder.

- [`docs/PARITY.md`](docs/PARITY.md) — the honest ledger: what is at parity and how it was proven,
  **what a person actually sees** (the UI audit and its severity-ordered defect list, with the
  screenshot that settles each row), where the port deliberately differs from the macOS app, and
  the remaining functional gaps.
- [`docs/capabilities/`](docs/capabilities/00-INDEX.md) — the item-by-item capability inventory
  against `nex 0.32.0`: 1490 scored items across ten domains, each with the Swift source that
  defines it and the port-side file (or the grep that proves the absence), plus a ranked gap list.
- [`docs/audit/`](docs/audit/) — the audit runs. [`run-J/`](docs/audit/run-J/index.md) is current
  (93 flows); the fourteen scoped runs beside it are one per feature area;
  [`run-F/FINDINGS.md`](docs/audit/run-F/FINDINGS.md) is the crop-level verdict table that closed
  the original ledger. Superseded runs keep their per-step prose and lose their screenshots — the
  policy, and what is kept and why, is [`docs/audit/README.md`](docs/audit/README.md).
- [`docs/compat-status.md`](docs/compat-status.md) — what the **real, shipped Swift CLI** can do
  against `nexd`, as measured.
- [`PLAN.md`](PLAN.md) — the milestone lineage.

Gates (2026-08-21): `pnpm check` **4260 passed**, 1 skipped; the compat suite 103/103 against
**both** the shipped Swift CLI and the TypeScript one; four live smokes green (client 39, shell 32,
web 46, terminal 19) and the packaged one too, **58/58**; the terminal-renderer start stress
**0 stranded in 48 panes**; the UI audit **624 of 626 assertions, 0 step errors** across **93 real
user flows** — the two failures are two findings, one of them new (the footer's blank diff stats)
and one the accepted VT-reflow limit; and capability coverage against the shipped app at **95.9%**
of 1490 inventoried items, up from 73.6% before the burn-downs. Nothing here is called done without
a screenshot that shows it.

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

### The `nex` CLI

This repo also ships its own `nex` — a TypeScript rewrite of the Swift binary that speaks the
same protocol, prints the same lines and exits with the same codes (it passes the same 103-test
compat suite the shipped binary does):

```bash
pnpm --filter @nex/cli build                          # → packages/cli/dist/nex.js
node packages/cli/dist/nex.js install-hooks --link    # symlink + Claude/Codex hooks
nex doctor                                            # daemon-aware: checks nexd, not Nex.app
```

`dist/nex.js` is a single dependency-free file with a shebang, so it needs nothing installed
beside it. [`packages/cli/README.md`](packages/cli/README.md) covers the two deliberate
divergences (`web console --follow`, `web capture`'s flag set) and what `doctor` now checks.

### Hooks: `nex install-hooks`

Agent status, session ids and desktop notifications all come from lifecycle hooks that Claude
Code and Codex CLI fire; without them a pane never leaves "idle". `nex install-hooks` is this
repo's replacement for the Swift app's `scripts/install-hooks.sh` — it writes the five Claude
hooks into `~/.claude/settings.json` and, when `~/.codex` exists, the four Codex hooks into
`~/.codex/hooks.json`:

```bash
nex install-hooks --dry-run     # show what would change, write nothing
nex install-hooks               # merge (safe to re-run — this is what `nex doctor` suggests)
nex install-hooks --link        # …and symlink this CLI into /usr/local/bin first
```

It **merges**: your own hooks survive, nex-managed ones are deduped by their flag-less base
(so an old absolute-path install is replaced rather than left to double-fire), and a stale
pre-v0.19 `"matcher": "startup"` SessionStart group is migrated to a matcher-less one so
`claude --resume` binds its session id again. An existing file is copied to `<file>.nex-backup`
before it changes, and a file that is not valid JSON is refused rather than overwritten. A
packaged `Nex.app` installs the symlink itself — on first launch it offers, on later launches
it repairs drift, and the tray's **Install CLI** item does it on demand.

**PATH assumption.** The hooks run in the *non-interactive* shell Claude Code spawns, which
does not read your `~/.zshrc` and inherits the agent's own `PATH`. `install-hooks` writes a bare
`nex` only when a `nex` on the current `PATH` really resolves to this binary; otherwise it
writes the absolute path, so the hooks fire either way. `--install-dir` / `NEX_INSTALL_DIR`
move the symlink elsewhere, and an unwritable directory prints the `sudo` command to run by
hand — it never escalates on its own.

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

Beside the database the daemon keeps `pane-geometry.json`: the last grid (cols × rows) each
pane was actually rendered at. It is a cache, not state — but it is what lets a restored pane's
shell be **born** at the size it will be shown at instead of at 80×24. The emulator does not
reflow, so a prompt printed at the wrong width stays wrong in every snapshot after it; deleting
the file costs one badly-wrapped first prompt per pane and nothing else.

## Importing from the macOS app

The Swift app keeps its state in `~/Library/Application Support/Nex/nex.db`; the daemon owns a
separate database (`~/Library/Application Support/nexd/nex.db`, or `NEXD_DB_PATH`) so the two can
run side by side during the port. `nexd import` copies the first into the second, once.

The daemon must be stopped: it holds the whole state in memory and its next save would overwrite
whatever the import wrote. That is also the order that gets your sessions back:

```bash
nexd stop
nexd import          # or: nexd import --dry-run   to see the report first
nexd start
```

On that `start` the panes come back, and every pane that had an agent session resumes it —
`claude --resume <id>` or `codex resume <id>`, chosen by the pane's last-known agent — exactly as
a Nex.app restart would. Session ids that fail the shell-safety allowlist are skipped, and the
report says which.

```
nexd import
  from: /Users/you/Library/Application Support/Nex/nex.db
  to:   /Users/you/Library/Application Support/nexd/nex.db
imported 12 workspace(s), 34 pane(s), 7 group(s), 3 repo(s)
  agent session(s) to resume on the next start: 2
  warnings:
    regenerated 1 empty workspace slug(s) from name + id (legacy v3 rows)
Next: `nexd start` — panes are restored and agent sessions resume automatically.
```

| flag | meaning |
|------|---------|
| `--from <db>` | legacy database (default: the Swift app's path above) |
| `--to <db>` | daemon database (default: `NEXD_DB_PATH`, else the platform default) |
| `--force` | replace a target that already holds workspaces — the existing database is copied aside as `<target>.<timestamp>.bak` first |
| `--dry-run` | print the report and write nothing (not even an empty database) |
| `--json` | one JSON report on stdout; the two paths still go to stderr |

The whole flow is verified end to end — fixture database → `import` → `start` → state read back
over the real `nex` CLI, including both agent kinds resuming into their PTYs — in
[`docs/PARITY.md`](docs/PARITY.md) ▸ "Legacy import, end to end".

Both paths are printed before anything is opened. The source is opened **read-only** and is never
written, migrated or deleted, so importing twice — or importing into a scratch `--to` — is safe.
Without `--force`, a target that already holds workspaces is refused; a running daemon is refused
regardless of `--force`.

What comes across: workspaces (name, color, icon, labels, profile, layout tree, focused pane),
groups (order, collapse state, members), the sidebar order, panes of every type (shell, markdown,
scratchpad, diff, web) with their working directories, files, scratchpad contents and web tabs,
plus the repo registry and its associations. What does not: live pane statuses (reset to idle —
no PTY survives an import), private web-pane tabs (the private flag persists, the contents never
do), and parked/recently-closed panes (the Swift app never persisted them either).

Rows the Swift loader would silently drop — an unparseable UUID, an orphaned pane, a corrupt
layout — are dropped the same way and *reported*: `skipped` names the table, id and reason, and
`warnings` covers every fallback taken (unknown enum, undecodable JSON, regenerated slug,
synthesized sidebar order). Tables the daemon does not own (`scheduledTask`, `workspaceFolder`)
are listed as ignored and left alone, and a database whose migration ledger carries newer
identifiers is read with a warning rather than refused.

## Install and run

### From source (development)

The daemon is the only thing you strictly need — a browser is a complete client. The Electron
shell adds the native chrome (tray, dock badge, global hotkey, native notifications, web panes).

```bash
pnpm install
pnpm --filter @nex/daemon build     # esbuild → packages/daemon/dist/nexd.js
pnpm --filter @nex/client build     # vite    → packages/client/dist
pnpm --filter @nex/shell build      # esbuild → packages/shell/dist/main.js

NEXD_CLIENT_DIR=packages/client/dist pnpm --filter @nex/shell start
```

`start` runs `electron .`, which discovers a running daemon or starts one detached (and leaves it
running when you quit). To use the browser instead, start the daemon yourself and open
`nexd url` — see [Quickstart](#quickstart) above.

### As an app (`pnpm dist`)

```bash
pnpm dist                                          # client + daemon + shell, then electron-forge make
open packages/shell/out/Nex-darwin-arm64/Nex.app
```

`pnpm dist` builds all three bundles and produces, in `packages/shell/out/`:

| artifact | what it is |
|----------|------------|
| `Nex-darwin-arm64/Nex.app` | the app bundle (also what `open` above launches) |
| `make/Nex.dmg` | the DMG, for handing to another machine |
| `make/zip/darwin/arm64/Nex-darwin-arm64-<version>.zip` | the ZIP — Squirrel.Mac's format, for when auto-update is switched on |

Use `pnpm --filter @nex/shell package` for just the `.app` (no DMG/ZIP), and
`pnpm --filter @nex/shell smoke:packaged` to verify a build end to end: it packages the app,
launches it with a throwaway environment and asserts that it starts its own daemon, serves its
own client, answers the shipped `nex` CLI, runs a real PTY, and leaves the daemon alive on quit.

> **Green as of 2026-08-20: 47/47**, window included. It stopped at `did-finish-load` through
> 2026-08-19 evening because `EnableCookieEncryption` was fused on: Chromium then wants the
> cookie-store key out of the macOS login keychain before its network service will serve anything,
> and on an ad-hoc-signed build that call blocks on an authorization dialog nothing can answer —
> so no request is ever made and the window sits on an empty document, silently. The fuse now
> travels with the signing identity (`docs/PARITY.md` ▸ Known gaps #9). **When you do the signing
> work below**, the fuse comes back on and this smoke needs `--mock-keychain`, because its sandbox
> `HOME` has no login keychain in it.

Inside `Nex.app/Contents/Resources`:

```
app.asar     the shell: dist/main.js + package.json, and nothing else
daemon/      nexd.js + node_modules/node-pty   ← outside the asar, on purpose
client/      the built web UI                  ← outside the asar
node         a Node 24 runtime for the daemon  ← outside the asar
```

The three staged directories sit outside the archive because a plain `node` process — not
Electron — executes the daemon: `node` cannot run a script inside an asar, and `dlopen` cannot
load node-pty's `pty.node` out of one. On launch the shell finds its daemon at
`Resources/daemon/nexd.js`, runs it under `Resources/node` (never `ELECTRON_RUN_AS_NODE`, which
is fused off), and hands it `NEXD_CLIENT_DIR=…/Resources/client`. All three are overridable —
`NEXD_ENTRY`, `NEXD_NODE`, `NEXD_CLIENT_DIR` — and a daemon that is *already* running is adopted
as-is, so a packaged app and a development daemon coexist.

Two things about the build worth knowing:

- **The bundled `node` is whichever Node built the app** (or `NEX_NODE_BINARY`), copied in and
  checked for version and architecture. That is fine locally and not fine for a release — see
  below.
- **The icon is generated, not designed**: `src/packaging.ts` draws it and writes a real `.icns`,
  so a build never silently ships the stock Electron icon. Replacing it means dropping a designed
  `.icns` in and pointing `packagerConfig.icon` at it. (macOS keeps the file's original name,
  `electron.icns`, inside the bundle; `CFBundleIconFile` is what matters.)

Auto-update is wired but **off**, and off by default in every build: `update-electron-app` is
loaded lazily behind `NEX_AUTO_UPDATE=1`, so a packaged app makes no update request at all. It
must stay off until the two conditions in `packages/shell/src/updater.ts` hold — a **public**
GitHub repo (`update.electronjs.org` serves no private ones) and a signed, notarized build.

### Signing and notarization — not done yet

Nothing in the current output is signed or notarized:

| | today |
|---|---|
| Code signature | ad-hoc only (an arm64 requirement, applied automatically; identity `com.github.Electron`) |
| Developer ID | none — `forge.config.cjs` has no `osxSign` block by default |
| Notarization / stapling | none |
| Bundled `node` | copied unsigned from the build machine |
| Auto-update | off (and must stay off: Squirrel cannot install an unsigned update) |
| Cookie encryption | off — the fuse needs a stable code identity for its keychain key, so it turns on with step 1 below |

In practice: the app runs on the machine that built it, and on any other Mac it is quarantined
("Nex is damaged and can't be opened") until someone runs
`xattr -dr com.apple.quarantine /Applications/Nex.app`. Do not ship it to anyone yet.

The checklist for closing that gap, in order:

1. A **Developer ID Application** certificate in the login keychain. `NEX_MACOS_IDENTITY="Developer ID Application: …"` already opts `pnpm dist` into `osxSign` with it — **and, in the same step, flips `EnableCookieEncryption` back on**, because that fuse needs a code identity stable enough for the keychain's ACL (`cookieEncryptionFuseEnabled`, `packages/shell/src/packaging.ts`). Expect a one-time "Nex wants to use your confidential information stored in Nex Safe Storage" prompt on first launch, and run the packaged smoke with `--mock-keychain` from then on.
2. **Sign the bundled `node`** and replace it with an official Node build for the target arch. It is a redistributed executable inside the bundle, so it needs its own signature; with the hardened runtime it also needs the JIT entitlements (`com.apple.security.cs.allow-jit`, `…allow-unsigned-executable-memory`).
3. **Notarize + staple**: add `osxNotarize` (notarytool with an App Store Connect API key) to `forge.config.cjs`, then `xcrun stapler staple` the `.app` and the `.dmg`.
4. **Verify** on a machine that never saw the build: `spctl -a -vvv -t install Nex.app` and `codesign --verify --deep --strict --verbose=2 Nex.app`.
5. Only then consider `NEX_AUTO_UPDATE`, and only if the repo is public.

Fuse flipping already happens before signing (Forge's fuses plugin runs in `packageAfterCopy`),
so the order above needs no rearranging — but re-run `pnpm --filter @nex/shell smoke:packaged`
after any signing change, since a mis-signed bundle fails at launch, not at build time.

### Remote access over Tailscale

The daemon listens on loopback only. `tailscale serve` fronts that port with HTTPS at
`https://<machine>.<tailnet>.ts.net`, reachable from any device on the tailnet (including a
phone), with certificates handled for you. Verified against `tailscale` 1.98.10:

```bash
# the HTTP port the daemon actually bound
port=$(packages/daemon/dist/nexd.js status --json | jq -r .http_port)

tailscale serve --bg "$port"     # background; foreground is the same command without --bg
tailscale serve status           # what is currently proxied
```

Then open it with the daemon's token — the tailnet only decides *who can reach the port*; the
WebSocket handshake is still gated on the run dir's token:

```bash
url=$(packages/daemon/dist/nexd.js url)                                   # http://127.0.0.1:<port>/?token=…
host=$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')     # <machine>.<tailnet>.ts.net
open "https://$host/?${url#*\?}"
```

The token is stored in `localStorage` and stripped from the address bar, so later visits to
`https://$host/` just work until the daemon's run dir is recreated.

Stop sharing with `tailscale serve reset`. Use `serve`, never `funnel` — `funnel` publishes to
the open internet, and this port is a shell. Proxied requests arrive with Tailscale's identity
headers (`Tailscale-User-Login`, `Tailscale-User-Name`), which is where per-user gating would
go if it is ever wanted.

## Repository layout

```
packages/
├─ protocol/   wire message types, type-strict decode, reply allowlist, WS protocol
├─ core/       pure domain: layout tree, resolvers, agent state machine, env, config, codecs
├─ daemon/     nexd: store, PTY manager, terminal state, control + HTTP/WS servers, SQLite,
│              content + web-pane + graft services, legacy nex.db importer
├─ client/     web UI: terminal rendering, pane grid, sidebar, settings, web-pane chrome
├─ shell/      Electron wrapper: tray, dock, notifications, web-pane host, packaging
└─ cli/        the `nex` CLI, a TypeScript rewrite of the shipped Swift binary
```

## Development

```bash
pnpm check          # typecheck + the full test suite   (the gate — must stay green)
pnpm test           # vitest across every package
pnpm typecheck      # tsc -b protocol core daemon cli, then client + shell
pnpm --filter @nex/daemon watch    # rebuild the bundle on change
```

Beyond the unit suites, four **live** smokes boot real daemons on private paths (never
`/tmp/nex.sock`) and assert what only a running system can prove:

```bash
node packages/client/scripts/smoke.mjs      # 33 checks: HTTP + WS + delta + PTY round trip
node packages/shell/scripts/smoke.mjs       # 29 checks: adopt-or-spawn, quit gate, daemon survives
node packages/shell/scripts/web-smoke.mjs   # 46 checks: real Chromium, real CDP, real CLI
node packages/shell/scripts/packaged-smoke.mjs   # 47 checks: the built Nex.app, end to end
```

`terminal-smoke.mjs` (19 checks: font, columns, re-attach, re-boot) drives the same stack for
terminal *fidelity*, and one more harness exists for the terminal's one intermittent failure:

```bash
# run-F N1 — creates panes six-at-a-time across workspaces and requires that none is stranded
# on "terminal renderer failed to start". `--faults <0..1>` plants the exact upstream error to
# exercise the retry path on demand; `--client-dist <dir>` points it at another bundle.
node packages/shell/scripts/renderer-start-stress.mjs --rounds 8 --panes 6 --workspaces 3
```

And the compat harness drives a real CLI binary against a real daemon — either implementation:

```bash
npx vitest run packages/daemon/tests/compat                                  # shipped Swift CLI
NEX_COMPAT_CLI="$PWD/packages/cli/dist/nex.js" \
  npx vitest run packages/daemon/tests/compat                                # the TypeScript CLI
```

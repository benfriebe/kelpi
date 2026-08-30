# Kelpi

A ground-up port of [Nex](https://github.com/benfriebe/nex) — the macOS terminal multiplexer built
on libghostty — to a **daemon + web client** architecture, renamed **Kelpi** (kelpi.sh) after the
Australian herding dog, because a nex.ai already exists.

The daemon (`kelpid`) owns the sessions: PTYs, terminal state, workspaces, layouts and agent
tracking live in a headless Node process that survives app restarts and updates. Clients (an
Electron shell on the desktop, or any browser over a tailnet) attach to it and render. The
existing `nex` CLI name and the Claude Code / Codex hooks keep working unchanged — the daemon
speaks the same newline-JSON control protocol on the same socket.

## Naming

The product is **Kelpi**: the app is `Kelpi.app`, the CLI is `kelpi`, the daemon is `kelpid`, the
packages are `@kelpi/*`. The **wire and the disk keep their pre-rename names** — they are
contracts with the shipped Swift app and with every existing install, and none of them spells the
brand at a user:

- `/tmp/nex.sock` — the CLI-compat control socket the Swift ecosystem connects to
- `NEX_PANE_ID` / `NEX_PROFILE` / `NEX_SOCKET` — the pane environment contract
- `~/.config/nex/config` — the settings file
- `~/Library/Application Support/nexd/` — the daemon's run dir and database (`nex.db`)
- `~/nex/worktrees/` — the default worktree base
- `nex-agentic` — the bundled Claude Code skill
- `/usr/local/bin/nex` — healed (never created) beside the primary `/usr/local/bin/kelpi`, and a
  `nex` compat launcher ships in the bundle, so every hook installed before the rename keeps
  resolving; `kelpi install-hooks` migrates hook entries to the `kelpi` spelling when re-run

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the process model, [`docs/PARITY.md`](docs/PARITY.md)
for where the port stands against the macOS app, and [`PLAN.md`](PLAN.md) for the milestone plan.
Behavioural contracts for every subsystem live in [`docs/current/`](docs/current).

## Status

**Wire parity, a 108-flow UI audit with nothing left failing on purpose, and 100% of the shipped
app's feature surface accounted for — all ten domains complete, nothing left unimplemented, and
every deliberate divergence carrying its argument in the ledger
(`TERM-034`, reclassified divergent 2026-08-23 — the selection half of macOS text services; its sibling `TERM-033` closed 2026-08-22 the
only way it could — a human session with a real Japanese input method,
`docs/audit/ime-human-session/`).** The daemon, the web client, the Electron shell, content panes, web panes, graft, the
`kelpi` CLI rewrite and the legacy `nex.db` importer are all built and green against the shipped Swift
binary. The window has been driven end to end and photographed a dozen times over: the campaign
opened with **17 defects + 6 nits, two of them blockers**, and stands at **no blockers — 1 accepted
major (the daemon's VT does not reflow on resize), 1 minor, 2 nits, and 1 defect in the audit
harness itself.** Every finding the re-audits
added is now closed, including the two that survived three full runs: the status bar's
`doc N +A -B`, which shipped with four passing unit tests and rendered **nothing** for a repo under
a symlinked path (the association carries git's physical path and the pane its logical one), and a
reattach flow that had been typing its marker into the wrong pane behind an open modal. The first
was fixed in the daemon and proven on an audit step left **byte-identical** to the one that failed;
the second was never a daemon defect at all. The footer row that replaced them — the left cluster
painting over the system stats — is **closed** too, and so is what it was hiding: the same row
starved from the other end, whose last tenth turned out to be a circular width measurement rather
than the constant everyone blamed. The assertion that named it, byte-identical for three runs, now
reads `192.9 → 0.0 px` and passes in two independent full runs. **Nothing in the harness fails on
purpose any more.** What replaced it in the ledger is a defect in the *harness*: a cleanup that
identifies the pane a split just made by its DOM position, against a grid that sorts panes by uuid
on purpose — a coin flip that had been winning every run until this one.

A green ledger was not the same as a finished product. An item-by-item inventory of the shipped
app — [`docs/capabilities/`](docs/capabilities/00-INDEX.md), **1490 scored items** across ten
domains — found 285 behaviours with no port-side implementation at all. Eight burn-downs took that
column to **zero** and coverage from 73.6% to **100% accounted**, while the audit grew to **108
flows, 1042 assertions**. All ten domains now have no partials and no gaps left at all — the last
open item, `TERM-034`, was reclassified divergent-by-design on the owner's decision (2026-08-23):
its plumbing is AppKit's `NSTextInputClient`, which Electron does not expose for canvas text. Nothing on the list is
work anybody plans to do. The last two entries that were *arguments* are what the eighth wave turned
into code: the launch-time skill refresh now migrates a drifted `SKILL.md` exactly once — backing
the old bytes up rather than destroying them the way the Swift does — and OSC 52 is implemented on
the daemon's own VT, with writes behind a `clipboard-write` key that ships **off** and reads refused
outright. The seventh wave before it put the shipped app's whole File
menu in the menu bar, made `theme = <name>` resolve to a real terminal palette, and gave the legacy
label→preset migration its one-shot marker. The sixth wave's subject was the window itself: a hidden
title bar with the traffic lights drawn into the client's own 32 px strip, ⌘N opening the New
Workspace sheet, a View menu with Toggle Inspector in it, an inspector that slides, and a
"No workspace selected" state you can actually reach. The terminal engine is vendored (`ghostty-web 0.4.0-nex.2`
= upstream v0.4.0 + two open PRs + one adaptation this repo wrote), which turned "engine-owned,
unreachable" into a permanent audit step: composed CJK reaches the PTY exactly once, and the preedit
is now marked text **on the cursor cell** — measured 0×0 px off a cell the terminal was told to move
to, at two different cells. The Kitty keyboard protocol, which headed the gap list for three passes as "the only missing item a
user would notice", was closed the same way the mouse gap was — by taking it off the engine: the
daemon negotiates it off the VT stream and answers `CSI ? u` into the PTY, the client encodes the
keys above the engine's own listener, and the legacy path is proven byte-identical on an audit step
left unchanged. What is still open is ranked in that index's §2, and **nothing in it is a piece of
work** — the list is now a refusal, a security decline and two things a browser cannot observe. The
mouse-reporting
gap that once headed it was closed by taking mouse reporting away from the engine and writing it
into the port, byte-identically to ghostty's own encoder.

- [`docs/PARITY.md`](docs/PARITY.md) — the honest ledger: what is at parity and how it was proven,
  **what a person actually sees** (the UI audit and its severity-ordered defect list, with the
  screenshot that settles each row), where the port deliberately differs from the macOS app, and
  the remaining functional gaps.
- [`docs/capabilities/`](docs/capabilities/00-INDEX.md) — the item-by-item capability inventory
  against `kelpi 0.32.0`: 1490 scored items across ten domains, each with the Swift source that
  defines it and the port-side file (or the grep that proves the absence), plus a ranked gap list.
- [`docs/audit/`](docs/audit/) — the audit runs. [`run-P/`](docs/audit/run-P/index.md) is
  **current** — 108 flows, 1042 assertions, **0 failed, 0 step errors**, one new flow
  (`terminal-osc52`) and every pre-existing step carrying exactly the assertion count it carried in
  `run-O`. It took six attempts, and the five that failed are recorded because the first two bought two latent
  harness hazards nine runs had been passing by luck
  ([`run-P-attempts/`](docs/audit/run-P-attempts/README.md));
  [`run-O/`](docs/audit/run-O/index.md) and [`run-N/`](docs/audit/run-N/index.md)
  precede it; the scoped runs beside them are one per feature area;
  [`run-F/FINDINGS.md`](docs/audit/run-F/FINDINGS.md) is the crop-level verdict table that closed
  the original ledger. Superseded runs keep their per-step prose and lose their screenshots — the
  policy, and what is kept and why, is [`docs/audit/README.md`](docs/audit/README.md).
- [`docs/compat-status.md`](docs/compat-status.md) — what the **real, shipped Swift CLI** can do
  against `kelpid`, as measured.
- [`PLAN.md`](PLAN.md) — the milestone lineage.

Gates (2026-08-22): `pnpm check` **5008 passed**, 1 skipped; the compat suite 103/103 against
**both** the shipped Swift CLI and the TypeScript one; four live smokes green (client 39, shell 58,
web 46, terminal 19) and the packaged one too, **60/60** against a bundle repackaged from this tree,
which also quits cleanly and leaves its daemon running; the terminal-renderer start stress
**0 stranded in 48 panes**; the UI audit **1042 of 1042 assertions, 0 failed, 0 step errors, 0 renderer console
errors** across **108 real user flows** (`run-P`). The assertion that named the open footer bug for three runs
now **passes** — `192.9 → 0.0 px`, reproduced in four independent runs — so nothing in the harness is
failing on purpose any more. The results that carry the most weight are again on steps that did
**not** change: the terminal input matrix is assertion-for-assertion identical to the previous three
runs' and still passes, and the reattach-after-relaunch flow is 11/11 with the window's whole title
bar replaced underneath it. **Nothing is red.** The reds the two failed attempts carried turned out to be one
harness defect with two faces — a coin-flip pane cleanup and a centre-aimed "focus" click that
could land on a split button — both fixed, both asserted, with the diagnosis instrumentation
(per-step state timeline, CLI invocation log, process logs) now part of every run's artefact
([`docs/audit/run-O-attempts/`](docs/audit/run-O-attempts/README.md)).
Capability coverage against the shipped app is **100% accounted** across 1490 inventoried items
(1324 implemented, 39 divergent by design with the argument recorded, 127 superseded by the
architecture), up from 73.6% before the burn-downs, with all ten domains complete and the missing
and partial columns both empty.
Nothing here is called done without a screenshot that shows it.

## Quickstart

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm --filter @kelpi/daemon build        # esbuild → packages/daemon/dist/kelpid.js
```

Start the daemon. It detaches by default, so it outlives the shell that started it:

```bash
packages/daemon/dist/kelpid.js start
packages/daemon/dist/kelpid.js status
```

```
kelpid is running (pid 77182)
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
(the client says so and stops, rather than retrying). `kelpid url` prints exactly that line and
nothing else, so it pipes:

```bash
open "$(packages/daemon/dist/kelpid.js url)"
```

The token is remembered in `localStorage` and stripped from the address bar on arrival, so
later visits to the bare origin work — until the daemon's run dir is recreated, at which point
open a fresh `kelpid url` again.

`--foreground` runs it in the current process instead (what a supervisor or a container wants),
and `kelpid stop` shuts it down cleanly — pending state is flushed to SQLite before the PTYs are
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
KELPID_TCP_PORT=19400 packages/daemon/dist/kelpid.js start

# CLI: reach it over that port
NEX_SOCKET=tcp:127.0.0.1:19400 kelpi pane list
NEX_SOCKET=tcp:127.0.0.1:19400 kelpi pane send --target worker-1 "echo hello"
```

The same variable is how a dev container or a remote agent reaches the daemon
(`NEX_SOCKET=tcp:host.docker.internal:19400`, or an SSH reverse tunnel).

### The `kelpi` CLI

This repo also ships its own `kelpi` — a TypeScript rewrite of the Swift binary that speaks the
same protocol, prints the same lines and exits with the same codes (it passes the same 103-test
compat suite the shipped binary does):

```bash
pnpm --filter @kelpi/cli build                          # → packages/cli/dist/kelpi.js
node packages/cli/dist/kelpi.js install-hooks --link    # symlink + Claude/Codex hooks
kelpi doctor                                            # daemon-aware: checks kelpid, not Kelpi.app
```

`dist/kelpi.js` is a single dependency-free file with a shebang, so it needs nothing installed
beside it. [`packages/cli/README.md`](packages/cli/README.md) covers the two deliberate
divergences (`web console --follow`, `web capture`'s flag set) and what `doctor` now checks.

### Hooks: `kelpi install-hooks`

Agent status, session ids and desktop notifications all come from lifecycle hooks that Claude
Code and Codex CLI fire; without them a pane never leaves "idle". `kelpi install-hooks` is this
repo's replacement for the Swift app's `scripts/install-hooks.sh` — it writes the five Claude
hooks into `~/.claude/settings.json` and, when `~/.codex` exists, the four Codex hooks into
`~/.codex/hooks.json`:

```bash
kelpi install-hooks --dry-run     # show what would change, write nothing
kelpi install-hooks               # merge (safe to re-run — this is what `kelpi doctor` suggests)
kelpi install-hooks --link        # …and symlink this CLI into /usr/local/bin first
```

It **merges**: your own hooks survive, kelpi-managed ones are deduped by their flag-less base
(so an old absolute-path install is replaced rather than left to double-fire), and a stale
pre-v0.19 `"matcher": "startup"` SessionStart group is migrated to a matcher-less one so
`claude --resume` binds its session id again. An existing file is copied to `<file>.kelpi-backup`
before it changes, and a file that is not valid JSON is refused rather than overwritten. A
packaged `Kelpi.app` installs the symlink itself — on first launch it offers, on later launches
it repairs drift, and the tray's **Install CLI** item does it on demand.

**PATH assumption.** The hooks run in the *non-interactive* shell Claude Code spawns, which
does not read your `~/.zshrc` and inherits the agent's own `PATH`. `install-hooks` writes a bare
`kelpi` only when a `kelpi` on the current `PATH` really resolves to this binary; otherwise it
writes the absolute path, so the hooks fire either way. `--install-dir` / `KELPI_INSTALL_DIR`
move the symlink elsewhere, and an unwritable directory prints the `sudo` command to run by
hand — it never escalates on its own.

### Running beside the real Kelpi.app

The production control socket is `/tmp/nex.sock`, which the Swift app owns while it is running —
`kelpid` refuses to steal a live socket. During development, give the daemon its own endpoints:

```bash
KELPID_SOCKET_PATH=/tmp/kelpid-dev.sock \
KELPID_TCP_PORT=19400 \
KELPID_DB_PATH=~/.local/share/kelpid-dev/nex.db \
KELPID_RUN_DIR=~/.local/state/kelpid-dev \
packages/daemon/dist/kelpid.js start --foreground
```

`NEX_SOCKET` only selects a TCP endpoint (absent means the hardcoded `/tmp/nex.sock`), so TCP is
how the shipped CLI reaches a development daemon:

```bash
NEX_SOCKET=tcp:127.0.0.1:19400 kelpi workspace list
```

A development daemon has its own run dir, and therefore its own token — so ask that daemon for
its URL rather than reusing one from another instance:

```bash
KELPID_RUN_DIR=~/.local/state/kelpid-dev open "$(packages/daemon/dist/kelpid.js url)"
```

`kelpid --help` lists every environment override (run dir, control socket, TCP port, HTTP
host/port, database, config file, client build directory, log file).

Beside the database the daemon keeps `pane-geometry.json`: the last grid (cols × rows) each
pane was actually rendered at. It is a cache, not state — but it is what lets a restored pane's
shell be **born** at the size it will be shown at instead of at 80×24. The emulator does not
reflow, so a prompt printed at the wrong width stays wrong in every snapshot after it; deleting
the file costs one badly-wrapped first prompt per pane and nothing else.

## Importing from the macOS app

The Swift app keeps its state in `~/Library/Application Support/Kelpi/nex.db`; the daemon owns a
separate database (`~/Library/Application Support/nexd/nex.db`, or `KELPID_DB_PATH`) so the two can
run side by side during the port. `kelpid import` copies the first into the second, once.

The daemon must be stopped: it holds the whole state in memory and its next save would overwrite
whatever the import wrote. That is also the order that gets your sessions back:

```bash
kelpid stop
kelpid import          # or: kelpid import --dry-run   to see the report first
kelpid start
```

On that `start` the panes come back, and every pane that had an agent session resumes it —
`claude --resume <id>` or `codex resume <id>`, chosen by the pane's last-known agent — exactly as
a Kelpi.app restart would. Session ids that fail the shell-safety allowlist are skipped, and the
report says which.

```
kelpid import
  from: /Users/you/Library/Application Support/Kelpi/nex.db
  to:   /Users/you/Library/Application Support/nexd/nex.db
imported 12 workspace(s), 34 pane(s), 7 group(s), 3 repo(s)
  agent session(s) to resume on the next start: 2
  warnings:
    regenerated 1 empty workspace slug(s) from name + id (legacy v3 rows)
Next: `kelpid start` — panes are restored and agent sessions resume automatically.
```

| flag | meaning |
|------|---------|
| `--from <db>` | legacy database (default: the Swift app's path above) |
| `--to <db>` | daemon database (default: `KELPID_DB_PATH`, else the platform default) |
| `--force` | replace a target that already holds workspaces — the existing database is copied aside as `<target>.<timestamp>.bak` first |
| `--dry-run` | print the report and write nothing (not even an empty database) |
| `--json` | one JSON report on stdout; the two paths still go to stderr |

The whole flow is verified end to end — fixture database → `import` → `start` → state read back
over the real `kelpi` CLI, including both agent kinds resuming into their PTYs — in
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
pnpm --filter @kelpi/daemon build     # esbuild → packages/daemon/dist/kelpid.js
pnpm --filter @kelpi/client build     # vite    → packages/client/dist
pnpm --filter @kelpi/shell build      # esbuild → packages/shell/dist/main.js

KELPID_CLIENT_DIR=packages/client/dist pnpm --filter @kelpi/shell start
```

`start` runs `electron .`, which discovers a running daemon or starts one detached (and leaves it
running when you quit). To use the browser instead, start the daemon yourself and open
`kelpid url` — see [Quickstart](#quickstart) above.

### As an app (`pnpm dist`)

```bash
pnpm dist                                          # client + daemon + shell, then electron-forge make
open packages/shell/out/Kelpi-darwin-arm64/Kelpi.app
```

`pnpm dist` builds all three bundles and produces, in `packages/shell/out/`:

| artifact | what it is |
|----------|------------|
| `Kelpi-darwin-arm64/Kelpi.app` | the app bundle (also what `open` above launches) |
| `make/Kelpi.dmg` | the DMG, for handing to another machine |
| `make/zip/darwin/arm64/Kelpi-darwin-arm64-<version>.zip` | the ZIP — Squirrel.Mac's format, for when auto-update is switched on |

Use `pnpm --filter @kelpi/shell package` for just the `.app` (no DMG/ZIP), and
`pnpm --filter @kelpi/shell smoke:packaged` to verify a build end to end: it packages the app,
launches it with a throwaway environment and asserts that it starts its own daemon, serves its
own client, answers the shipped `kelpi` CLI, runs a real PTY, and leaves the daemon alive on quit.

> **Green as of 2026-08-20: 47/47**, window included. It stopped at `did-finish-load` through
> 2026-08-19 evening because `EnableCookieEncryption` was fused on: Chromium then wants the
> cookie-store key out of the macOS login keychain before its network service will serve anything,
> and on an ad-hoc-signed build that call blocks on an authorization dialog nothing can answer —
> so no request is ever made and the window sits on an empty document, silently. The fuse now
> travels with the signing identity (`docs/PARITY.md` ▸ Known gaps #9). **When you do the signing
> work below**, the fuse comes back on and this smoke needs `--mock-keychain`, because its sandbox
> `HOME` has no login keychain in it.

Inside `Kelpi.app/Contents/Resources`:

```
app.asar     the shell: dist/main.js + package.json, and nothing else
daemon/      kelpid.js + node_modules/node-pty   ← outside the asar, on purpose
client/      the built web UI                  ← outside the asar
node         a Node 24 runtime for the daemon  ← outside the asar
```

The three staged directories sit outside the archive because a plain `node` process — not
Electron — executes the daemon: `node` cannot run a script inside an asar, and `dlopen` cannot
load node-pty's `pty.node` out of one. On launch the shell finds its daemon at
`Resources/daemon/kelpid.js`, runs it under `Resources/node` (never `ELECTRON_RUN_AS_NODE`, which
is fused off), and hands it `KELPID_CLIENT_DIR=…/Resources/client`. All three are overridable —
`KELPID_ENTRY`, `KELPID_NODE`, `KELPID_CLIENT_DIR` — and a daemon that is *already* running is adopted
as-is, so a packaged app and a development daemon coexist.

Two things about the build worth knowing:

- **The bundled `node` is whichever Node built the app** (or `KELPI_NODE_BINARY`), copied in and
  checked for version and architecture. That is fine locally and not fine for a release — see
  below.
- **The icon is generated, not designed**: `src/packaging.ts` draws it and writes a real `.icns`,
  so a build never silently ships the stock Electron icon. Replacing it means dropping a designed
  `.icns` in and pointing `packagerConfig.icon` at it. (macOS keeps the file's original name,
  `electron.icns`, inside the bundle; `CFBundleIconFile` is what matters.)

Auto-update is wired but **off**, and off by default in every build: `update-electron-app` is
loaded lazily behind `KELPI_AUTO_UPDATE=1`, so a packaged app makes no update request at all. It
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
("Kelpi is damaged and can't be opened") until someone runs
`xattr -dr com.apple.quarantine /Applications/Nex.app`. Do not ship it to anyone yet.

The checklist for closing that gap, in order:

1. A **Developer ID Application** certificate in the login keychain. `KELPI_MACOS_IDENTITY="Developer ID Application: …"` already opts `pnpm dist` into `osxSign` with it — **and, in the same step, flips `EnableCookieEncryption` back on**, because that fuse needs a code identity stable enough for the keychain's ACL (`cookieEncryptionFuseEnabled`, `packages/shell/src/packaging.ts`). Expect a one-time "Kelpi wants to use your confidential information stored in Kelpi Safe Storage" prompt on first launch, and run the packaged smoke with `--mock-keychain` from then on.
2. **Sign the bundled `node`** and replace it with an official Node build for the target arch. It is a redistributed executable inside the bundle, so it needs its own signature; with the hardened runtime it also needs the JIT entitlements (`com.apple.security.cs.allow-jit`, `…allow-unsigned-executable-memory`).
3. **Notarize + staple**: add `osxNotarize` (notarytool with an App Store Connect API key) to `forge.config.cjs`, then `xcrun stapler staple` the `.app` and the `.dmg`.
4. **Verify** on a machine that never saw the build: `spctl -a -vvv -t install Kelpi.app` and `codesign --verify --deep --strict --verbose=2 Kelpi.app`.
5. Only then consider `KELPI_AUTO_UPDATE`, and only if the repo is public.

Fuse flipping already happens before signing (Forge's fuses plugin runs in `packageAfterCopy`),
so the order above needs no rearranging — but re-run `pnpm --filter @kelpi/shell smoke:packaged`
after any signing change, since a mis-signed bundle fails at launch, not at build time.

### Remote access over Tailscale

The daemon listens on loopback only. `tailscale serve` fronts that port with HTTPS at
`https://<machine>.<tailnet>.ts.net`, reachable from any device on the tailnet (including a
phone), with certificates handled for you. Verified against `tailscale` 1.98.10:

```bash
# the HTTP port the daemon actually bound
port=$(packages/daemon/dist/kelpid.js status --json | jq -r .http_port)

tailscale serve --bg "$port"     # background; foreground is the same command without --bg
tailscale serve status           # what is currently proxied
```

Then open it with the daemon's token — the tailnet only decides *who can reach the port*; the
WebSocket handshake is still gated on the run dir's token:

```bash
url=$(packages/daemon/dist/kelpid.js url)                                   # http://127.0.0.1:<port>/?token=…
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
├─ daemon/     kelpid: store, PTY manager, terminal state, control + HTTP/WS servers, SQLite,
│              content + web-pane + graft services, legacy nex.db importer
├─ client/     web UI: terminal rendering, pane grid, sidebar, settings, web-pane chrome
├─ shell/      Electron wrapper: tray, dock, notifications, web-pane host, packaging
└─ cli/        the `kelpi` CLI, a TypeScript rewrite of the shipped Swift binary
```

## Development

```bash
pnpm check          # typecheck + the full test suite   (the gate — must stay green)
pnpm test           # vitest across every package
pnpm typecheck      # tsc -b protocol core daemon cli, then client + shell
pnpm --filter @kelpi/daemon watch    # rebuild the bundle on change
```

Beyond the unit suites, four **live** smokes boot real daemons on private paths (never
`/tmp/nex.sock`) and assert what only a running system can prove:

```bash
node packages/client/scripts/smoke.mjs      # 33 checks: HTTP + WS + delta + PTY round trip
node packages/shell/scripts/smoke.mjs       # 29 checks: adopt-or-spawn, quit gate, daemon survives
node packages/shell/scripts/web-smoke.mjs   # 46 checks: real Chromium, real CDP, real CLI
node packages/shell/scripts/packaged-smoke.mjs   # 47 checks: the built Kelpi.app, end to end
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
KELPI_COMPAT_CLI="$PWD/packages/cli/dist/kelpi.js" \
  npx vitest run packages/daemon/tests/compat                                # the TypeScript CLI
```

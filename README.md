# Kelpi

**Kelpi** (kelpi.sh) is a terminal multiplexer built for driving fleets of AI agents, with a
**daemon + web client** architecture. It is a ground-up port of **Nex** — the macOS terminal
multiplexer built on SwiftUI + libghostty — rebuilt around a daemon and renamed Kelpi, at full
feature parity with the app it replaces.

The daemon (`kelpid`) owns the sessions: PTYs, terminal state, workspaces, layouts and agent
tracking live in a headless Node process that survives app restarts and updates. Clients attach
to it and render — an Electron shell on the desktop, or any browser over a tailnet. Closing the
laptop lid or updating the app never kills an agent.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the process model.

## What Kelpi is today

- **Workspaces, groups and panes** with a full layout tree (splits, focus, sidebar ordering,
  collapse state), persisted to SQLite and restored across daemon restarts — panes come back, and
  every pane with a tracked agent session resumes it (`claude --resume <id>` / `codex resume <id>`).
- **A real terminal**: the vendored `ghostty-web` engine, with the Kitty keyboard protocol, mouse
  reporting, IME/CJK composition, OSC 52 (writes behind a `clipboard-write` key that ships off,
  reads refused), search highlighting, themes, and per-pane font/size. One accepted limitation:
  the daemon's VT does not reflow on resize.
- **Content panes** beyond the shell: markdown (edit/preview), scratchpad, diff, and web panes
  (real Chromium via the shell, with console capture, screenshots, and an element picker).
- **Agent awareness**: lifecycle hooks from Claude Code and Codex CLI drive pane status, session
  ids and desktop notifications; `kelpi install-hooks` wires them and `kelpi doctor` verifies the
  whole chain.
- **Graft**: git-worktree-backed workspaces (default base `~/kelpi/worktrees/<repo>`), with repo
  associations and status surfaced in the UI.
- **A native shell**: menu bar, tray, dock badge, global hotkey, native notifications,
  hidden-titlebar window with inline traffic lights, an inspector, and Finder "Open With" for
  markdown.
- **A settings system** over `~/.config/kelpi/config`: keybindings (with conflict detection),
  appearance, terminal themes, repositories, TCP exposure — edited live in the client, applied by
  the daemon as the settings authority.
- **The `kelpi` CLI**: a single-file, dependency-free binary speaking the daemon's newline-JSON
  control protocol — panes, workspaces, groups, events, web-pane control, doctor, install-hooks,
  and the legacy importer. The shipped Swift `nex` CLI works against the same socket unchanged.
- **Self-hosting tooling**: an impact-mapped verification battery, a promote flow that upgrades
  the running instance from inside itself, a second full instance for development, and a
  sub-second HMR loop.

## Naming

Everything is **Kelpi**: the app is `Kelpi.app`, the CLI is `kelpi`, the daemon is `kelpid`, the
packages are `@kelpi/*`, the socket is `/tmp/kelpi.sock`, panes carry `KELPI_PANE_ID` /
`KELPI_PROFILE` / `KELPI_SOCKET`, the config is `~/.config/kelpi/config`, the daemon's state is
`~/Library/Application Support/kelpid/kelpi.db`, new worktrees go under `~/kelpi/worktrees/`, and
the bundled Claude Code skill is `kelpi-agentic`.

The pre-rename `nex` names survive as a **compatibility surface**, migrated automatically:

- On its first boot the daemon **copies** the pre-rename state over — `nexd/nex.db` (plus
  `pane-geometry.json`) becomes `kelpid/kelpi.db`, and `~/.config/nex/config` becomes
  `~/.config/kelpi/config`. Copy-only, the originals stay behind, and sandboxes (anything with
  the env overrides set) never migrate.
- The daemon keeps a **symlink at `/tmp/nex.sock`** pointing at `/tmp/kelpi.sock`, so the
  shipped Swift `nex` and every pre-rename hook still connect. A live foreign socket there (the
  Swift app running) is never touched.
- Panes get **both** env spellings injected; the CLI reads `KELPI_*` first and falls back to
  `NEX_*`, and its unix default falls back to `/tmp/nex.sock` when only a pre-cutover daemon is
  running.
- `/usr/local/bin/nex` is healed (never created) beside the primary `/usr/local/bin/kelpi`; a
  `nex` compat launcher ships in the bundle, and `kelpi install-hooks` migrates hook entries to
  the `kelpi` spelling when re-run.

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
  control: /tmp/kelpi.sock
  discovery: ~/Library/Application Support/kelpid/run/daemon-v1.sock
  http: http://127.0.0.1:59329
  url: http://127.0.0.1:59329/?token=8f3c…
  run dir: ~/Library/Application Support/kelpid/run
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
echo '{"command":"ping"}'           | nc -U /tmp/kelpi.sock
echo '{"command":"workspace-list"}' | nc -U /tmp/kelpi.sock
```

The CLI talks to whatever `KELPI_SOCKET` names. Point it at a development daemon over TCP:

```bash
# daemon: listen on loopback TCP as well as the unix socket
KELPID_TCP_PORT=19400 packages/daemon/dist/kelpid.js start

# CLI: reach it over that port
KELPI_SOCKET=tcp:127.0.0.1:19400 kelpi pane list
KELPI_SOCKET=tcp:127.0.0.1:19400 kelpi pane send --target worker-1 "echo hello"
```

The same variable is how a dev container or a remote agent reaches the daemon
(`KELPI_SOCKET=tcp:host.docker.internal:19400`, or an SSH reverse tunnel).

### The `kelpi` CLI

```bash
pnpm --filter @kelpi/cli build                          # → packages/cli/dist/kelpi.js
node packages/cli/dist/kelpi.js install-hooks --link    # symlink + Claude/Codex hooks
kelpi doctor                                            # daemon-aware: checks kelpid, not Kelpi.app
```

`dist/kelpi.js` is a single dependency-free file with a shebang, so it needs nothing installed
beside it. [`packages/cli/README.md`](packages/cli/README.md) covers the command surface and what
`doctor` checks.

### Hooks: `kelpi install-hooks`

Agent status, session ids and desktop notifications all come from lifecycle hooks that Claude
Code and Codex CLI fire; without them a pane never leaves "idle". `kelpi install-hooks` writes
the five Claude hooks into `~/.claude/settings.json` and, when `~/.codex` exists, the four Codex
hooks into `~/.codex/hooks.json`:

```bash
kelpi install-hooks --dry-run     # show what would change, write nothing
kelpi install-hooks               # merge (safe to re-run — this is what `kelpi doctor` suggests)
kelpi install-hooks --link        # …and symlink this CLI into /usr/local/bin first
```

It **merges**: your own hooks survive, kelpi-managed ones are deduped by their flag-less base
(so an old absolute-path or `nex`-spelled install is replaced rather than left to double-fire),
and a stale `"matcher": "startup"` SessionStart group is migrated to a matcher-less one so
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

### Running a second daemon

The production control socket is `/tmp/kelpi.sock`; `kelpid` refuses to steal a live socket.
During development, give a daemon its own endpoints:

```bash
KELPID_SOCKET_PATH=/tmp/kelpid-dev.sock \
KELPID_TCP_PORT=19400 \
KELPID_DB_PATH=~/.local/share/kelpid-dev/kelpi.db \
KELPID_RUN_DIR=~/.local/state/kelpid-dev \
packages/daemon/dist/kelpid.js start --foreground
```

`KELPI_SOCKET` only selects a TCP endpoint (absent means the default `/tmp/kelpi.sock`), so TCP
is how a CLI reaches a development daemon:

```bash
KELPI_SOCKET=tcp:127.0.0.1:19400 kelpi workspace list
```

A development daemon has its own run dir, and therefore its own token — so ask that daemon for
its URL rather than reusing one from another instance:

```bash
KELPID_RUN_DIR=~/.local/state/kelpid-dev open "$(packages/daemon/dist/kelpid.js url)"
```

`kelpid --help` lists every environment override (run dir, control socket, TCP port, HTTP
host/port, database, config file, client build directory, log file).
`scripts/dev-instance.mjs` automates all of the above — it stands up a complete second Kelpi
(daemon + client + helpers) on private endpoints, beside the one you are using.

Beside the database the daemon keeps `pane-geometry.json`: the last grid (cols × rows) each
pane was actually rendered at. It is a cache, not state — but it is what lets a restored pane's
shell be **born** at the size it will be shown at instead of at 80×24. The emulator does not
reflow, so a prompt printed at the wrong width stays wrong in every snapshot after it; deleting
the file costs one badly-wrapped first prompt per pane and nothing else.

## Importing from the legacy macOS app

The pre-Kelpi Swift app (Nex) keeps its state in `~/Library/Application Support/Nex/nex.db`; the
daemon owns a separate database (`~/Library/Application Support/kelpid/kelpi.db`, or `KELPID_DB_PATH`)
so the two can run side by side. `kelpid import` copies the first into the second, once.

The daemon must be stopped: it holds the whole state in memory and its next save would overwrite
whatever the import wrote. That is also the order that gets your sessions back:

```bash
kelpid stop
kelpid import          # or: kelpid import --dry-run   to see the report first
kelpid start
```

On that `start` the panes come back, and every pane that had an agent session resumes it —
`claude --resume <id>` or `codex resume <id>`, chosen by the pane's last-known agent. Session ids
that fail the shell-safety allowlist are skipped, and the report says which.

| flag | meaning |
|------|---------|
| `--from <db>` | legacy database (default: the Swift app's path above) |
| `--to <db>` | daemon database (default: `KELPID_DB_PATH`, else the platform default) |
| `--force` | replace a target that already holds workspaces — the existing database is copied aside as `<target>.<timestamp>.bak` first |
| `--dry-run` | print the report and write nothing (not even an empty database) |
| `--json` | one JSON report on stdout; the two paths still go to stderr |

Both paths are printed before anything is opened. The source is opened **read-only** and is never
written, migrated or deleted, so importing twice — or importing into a scratch `--to` — is safe.
Without `--force`, a target that already holds workspaces is refused; a running daemon is refused
regardless of `--force`.

What comes across: workspaces (name, color, icon, labels, profile, layout tree, focused pane),
groups (order, collapse state, members), the sidebar order, panes of every type (shell, markdown,
scratchpad, diff, web) with their working directories, files, scratchpad contents and web tabs,
plus the repo registry and its associations. What does not: live pane statuses (reset to idle —
no PTY survives an import), private web-pane tabs (the private flag persists, the contents never
do), and parked/recently-closed panes. Undecodable rows are dropped and *reported*: `skipped`
names the table, id and reason, and `warnings` covers every fallback taken.

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
own client, answers the CLI, runs a real PTY, and leaves the daemon alive on quit.

Inside `Kelpi.app/Contents/Resources`:

```
app.asar     the shell: dist/main.js + package.json, and nothing else
daemon/      kelpid.js + node_modules/node-pty   ← outside the asar, on purpose
client/      the built web UI                    ← outside the asar
cli/         the kelpi CLI + its launchers       ← outside the asar
node         a Node 24 runtime for the daemon    ← outside the asar
```

The staged directories sit outside the archive because a plain `node` process — not Electron —
executes the daemon: `node` cannot run a script inside an asar, and `dlopen` cannot load
node-pty's `pty.node` out of one. On launch the shell finds its daemon at
`Resources/daemon/kelpid.js`, runs it under `Resources/node` (never `ELECTRON_RUN_AS_NODE`, which
is fused off), and hands it `KELPID_CLIENT_DIR=…/Resources/client`. All three are overridable —
`KELPID_ENTRY`, `KELPID_NODE`, `KELPID_CLIENT_DIR` — and a daemon that is *already* running is
adopted as-is, so a packaged app and a development daemon coexist.

Two things about the build worth knowing:

- **The bundled `node` is whichever Node built the app** (or `KELPI_NODE_BINARY`), copied in and
  checked for version and architecture. That is fine locally and not fine for a release — see
  below.
- **The icon is generated, not designed**: `src/packaging.ts` draws it and writes a real `.icns`,
  so a build never silently ships the stock Electron icon. Replacing it means dropping a designed
  `.icns` in and pointing `packagerConfig.icon` at it.

Auto-update is wired but **off**, and off by default in every build: `update-electron-app` is
loaded lazily behind `KELPI_AUTO_UPDATE=1`, so a packaged app makes no update request at all. It
must stay off until the two conditions in `packages/shell/src/updater.ts` hold — a **public**
GitHub repo (`update.electronjs.org` serves no private ones) and a signed, notarized build.

### Signing and notarization — not done yet

Nothing in the current output is signed or notarized:

| | today |
|---|---|
| Code signature | ad-hoc only (an arm64 requirement, applied automatically) |
| Developer ID | none — `forge.config.cjs` has no `osxSign` block by default |
| Notarization / stapling | none |
| Bundled `node` | copied unsigned from the build machine |
| Auto-update | off (and must stay off: Squirrel cannot install an unsigned update) |
| Cookie encryption | off — the fuse needs a stable code identity for its keychain key, so it turns on with step 1 below |

In practice: the app runs on the machine that built it, and on any other Mac it is quarantined
("Kelpi is damaged and can't be opened") until someone runs
`xattr -dr com.apple.quarantine /Applications/Kelpi.app`. Do not ship it to anyone yet.

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
phone), with certificates handled for you:

```bash
# the HTTP port the daemon actually bound
port=$(packages/daemon/dist/kelpid.js status --json | jq -r .http_port)

tailscale serve --bg "$port"     # background; foreground is the same command without --bg
tailscale serve status           # what is currently proxied
```

Then open it with the daemon's token — the tailnet only decides *who can reach the port*; the
WebSocket handshake is still gated on the run dir's token:

```bash
url=$(packages/daemon/dist/kelpid.js url)                                 # http://127.0.0.1:<port>/?token=…
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
└─ cli/        the `kelpi` CLI
```

## Development

```bash
pnpm check          # typecheck + the full test suite   (the gate — must stay green)
pnpm test           # vitest across every package
pnpm typecheck      # tsc -b protocol core daemon cli, then client + shell
pnpm --filter @kelpi/daemon watch    # rebuild the bundle on change
```

The verification tooling is tiered — the diff picks the tier, not optimism:

```bash
node scripts/verify.mjs             # scoped: exactly the tests + audit steps the diff touches
node scripts/verify.mjs --full      # the full battery: typecheck, every suite, five smokes,
                                    # a repackage, and the UI audit
node scripts/dev-hmr.mjs            # sub-second inner loop against a sandboxed instance
node scripts/dev-instance.mjs       # a complete second Kelpi beside the one you are using
node scripts/self-upgrade.mjs       # run the battery, package, and promote the RUNNING
                                    # instance to this tree's build (detached restart; panes
                                    # and agent sessions come back and resume)
```

Beyond the unit suites, four **live** smokes boot real daemons on private paths (never
the shared `/tmp/kelpi.sock`) and assert what only a running system can prove:

```bash
node packages/client/scripts/smoke.mjs           # HTTP + WS + delta + PTY round trip
node packages/shell/scripts/smoke.mjs            # adopt-or-spawn, quit gate, daemon survives
node packages/shell/scripts/web-smoke.mjs        # real Chromium, real CDP, real CLI
node packages/shell/scripts/packaged-smoke.mjs   # the built Kelpi.app, end to end
```

`terminal-smoke.mjs` drives the same stack for terminal *fidelity* (font, columns, re-attach,
re-boot), and `renderer-start-stress.mjs` creates panes six-at-a-time across workspaces and
requires that none is stranded on "terminal renderer failed to start".

The compat harness drives a real CLI binary against a real daemon — either implementation:

```bash
npx vitest run packages/daemon/tests/compat                                  # the Swift nex CLI
KELPI_COMPAT_CLI="$PWD/packages/cli/dist/kelpi.js" \
  npx vitest run packages/daemon/tests/compat                                # the TypeScript CLI
```

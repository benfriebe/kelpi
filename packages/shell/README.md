# @kelpi/shell — the Electron shell

The desktop wrapper. It owns a window, a tray, a dock badge, a global hotkey and the quit
dialog — and **no product logic**: the UI is loaded from the daemon's own HTTP server, so app
code and daemon code always update together (ARCHITECTURE.md, "the Electron shell is
deliberately thin").

```
src/
├─ main.ts          app lifecycle: single instance, window + frame restore, navigation policy
├─ daemon.ts        discover-or-spawn the daemon; never stop one
├─ status.ts        the main process's OWN status WebSocket → dock badge, bounce, tray
├─ agents.ts        pure: the agent-count mirror and everything derived from it
├─ quit.ts          the quit gate (Electron wiring)   settings.ts  its policy + settings file
├─ hotkey.ts        `global-hotkey` from the shared config file → an Electron accelerator
├─ window-state.ts  frame persistence + the off-screen clamp
├─ icon.ts          the tray icon, rasterized and PNG-encoded in code (no binary assets)
├─ control.ts       a minimal control-protocol client (Finder "Open With" → daemon `open`)
├─ resources.ts     the packaged `Contents/Resources` layout — written by the build, read here
├─ packaging.ts     build-time only: the app icon + ICNS, the asar allowlist, Node-runtime checks
├─ updater.ts       auto-update, off unless `KELPI_AUTO_UPDATE=1` (and then only when packaged)
├─ log.ts           `[shell] …` lines on stdout; the smoke asserts on them
└─ webhost/         the web-pane host (M6): WebContentsViews + CDP behind the daemon's host RPC
   ├─ client.ts     its OWN daemon WebSocket, claiming the `web-pane-host` role
   ├─ dispatch.ts   verb → CLI-shaped envelope (Electron-free, so it is unit-testable)
   ├─ registry.ts   pane → tabs → views; reconciles the daemon's lifecycle notifications
   ├─ geometry.ts   CSS px → DIP + the content-area clamp (pure arithmetic, unit-tested)
   ├─ embed.ts      which view is in the window, and when it goes back to the holder (pure)
   ├─ tab.ts        one `WebContentsView` + its CDP session (the only Electron-aware module)
   ├─ scripts.ts    the injected page scripts (actuator, picker, find) + eval wrappers
   ├─ console-format.ts  CDP console/network events → the spec's message strings
   ├─ sessions.ts   per-pane storage partitions + the cookie surface
   └─ caps.ts       byte budgets, UTF-8 clamping, the inspect-payload sanitiser
```

## Web panes (M6)

The daemon owns web-pane *state* and cannot render a page; this process can. `webhost/`
connects as an ordinary WS client claiming `web-pane-host`
(`packages/daemon/src/webpane/HOST_PROTOCOL.md`), mirrors the daemon's panes and tabs onto real
`WebContentsView`s, and answers every verb that needs a live browser — the whole `kelpi web`
surface: navigate/back/forward/reload, `capture` (meta/text/dom/screenshot/all), the actuator
(`click`, `type`, `q-*`, `wait`, `select`, `scroll`, `hover`, `key`), `exec`, the element
picker, cookies, find and zoom.

**Views are born off-screen and only move when somebody can see them.** Every tab is created in
a holder window that is never shown, which is what makes the whole automation surface work with
no UI at all. When the web UI **running in this shell's own window** reports where it drew a
pane's page area, the daemon forwards it as `pane-geometry` and `embed.ts` re-parents that
pane's active view into the window at those bounds (`geometry.ts` converts CSS px → DIP and
clamps to the content area); hiding the pane, switching workspace, closing the window or
quitting sends it straight back to the holder. The pairing that makes this safe is a
window id: the host declares it at registration and the shell loads the UI with the same id
(`?shellWindow=`), so geometry from any *other* client — a browser, another machine — is
ignored and those clients keep drawing the placeholder card. Two consequences worth knowing:

- a `WebContentsView` has **no renderer until something is loaded**, and every CDP command
  silently hangs until then, so each tab bootstraps with an `about:blank` load before the
  domains are enabled and the scripts are injected (`tab.ts`);
- `webSecurity` stays **on**. Chromium already lets a `file://` document load sibling
  subresources, which is the feature `kelpi web open ./page.html` needs; turning it off would buy
  only cross-file `fetch` at the cost of making every page an agent visits same-origin-free.

## The rule that outranks everything else

**The shell never stops the daemon.** Closing the window, ⌘Q, `app.quit()`, a SIGTERM — none
of them signal `kelpid`. Quitting the app leaves every PTY, agent and workspace running, and the
next launch attaches to exactly the sessions that were there. `scripts/smoke.mjs` asserts this
by pinging the daemon after Electron has exited. Nothing in this package may grow a "stop the
daemon" path; the tray's daemon item is *Start* (when none is running) or *Reconnect* (when one
is), never *Restart*.

## Running it

```bash
pnpm --filter @kelpi/daemon build        # the shell spawns this bundle when nothing is running
pnpm --filter @kelpi/shell build         # esbuild → dist/main.js (CJS, electron external)
pnpm --filter @kelpi/shell start         # electron .
```

With no daemon running it starts one, detached, and waits for it to answer. To point a
development shell at throwaway paths (the shipped Swift app owns `/tmp/nex.sock` on a dev
machine, and the daemon's default run dir is shared):

```bash
KELPID_RUN_DIR=/tmp/kelpid-dev-run \
KELPID_SOCKET_PATH=/tmp/kelpid-dev.sock \
KELPID_DB_PATH=/tmp/kelpid-dev.db \
KELPID_CONFIG_PATH=/tmp/kelpid-dev-config \
pnpm --filter @kelpi/shell start
```

Environment it reads: `KELPID_RUN_DIR` (which daemon to talk to), `KELPID_ENTRY` (the `kelpid`
script to spawn), `KELPID_NODE` (the Node binary to spawn it with), `KELPID_LOG_FILE` (where a
spawned daemon's output goes), `KELPID_CONFIG_PATH` (the shared `kelpi` config, for
`global-hotkey`), `KELPI_AUTO_UPDATE` (off unless `1`; see `src/updater.ts`). Everything else it
inherits and passes to the daemon it spawns — plus, in a packaged app only, `KELPID_CLIENT_DIR`
pointing at the client build in its own Resources (an explicit one always wins).

## Packaging

```bash
pnpm dist                              # from the repo root: all three bundles, then make
pnpm --filter @kelpi/shell package       # just out/Kelpi-darwin-<arch>/Kelpi.app
pnpm --filter @kelpi/shell make          # + out/make/Kelpi.dmg and the Squirrel-shaped ZIP
pnpm --filter @kelpi/shell icon          # re-render out/staging/icon.icns on its own
```

`forge.config.cjs` is the whole configuration and its header is the long-form explanation. The
short version: `app.asar` holds `dist/main.js` and `package.json` and nothing else (an allowlist,
`packagedAppIgnore`), while three things are staged into `Contents/Resources` *outside* the
archive by `scripts/stage-resources.mjs` — the daemon payload (`packages/daemon/scripts/
stage-payload.mjs` owns its contents: the bundle plus the node-pty tree its `require` resolves
to), the built client, and a Node 24 runtime. They have to be outside because a plain `node`
process runs the daemon: `node` cannot execute a script inside an asar, and `dlopen` cannot load
`pty.node` out of one. `src/resources.ts` is the single description of that layout — the Forge
config writes it, `daemon.ts` reads it, `scripts/packaged-smoke.mjs` asserts it.

Fuses (stack.md §1) are flipped in the binary: `runAsNode`, `nodeOptions` and `nodeCliInspect`
off, `onlyLoadAppFromAsar` and asar integrity validation on. Turning `runAsNode` off is
load-bearing rather than decorative — it forecloses the "run the daemon with
`ELECTRON_RUN_AS_NODE`" shortcut that stack.md rules out, which is why the bundled `node` exists.

**Cookie encryption is the one conditional fuse**, and the condition is the code signature
(`cookieEncryptionFuseEnabled` in `src/packaging.ts` has the whole story). Fused on, Chromium
fetches the cookie-store key from the macOS login keychain before its network service will serve
anything; on an ad-hoc-signed build — whose code identity changes with every build — that call
blocks forever inside `SecItemAdd → makeLoginAuthUI → AuthorizationCopyRights`, waiting on an
authorization dialog nothing can answer. The window then never loads, with no `did-fail-load` and
nothing in the log (`docs/PARITY.md` ▸ Known gaps #9). So it turns on in the same step as the
Developer ID, and `packaged-smoke.mjs` asserts that rule from the fuse wire in phase 1.

Nothing is signed or notarized (ad-hoc only, as arm64 requires); the repo README's *Install and
run* section carries the gap and the release checklist. `KELPI_MACOS_IDENTITY` opts into `osxSign`.

## Tests

```bash
pnpm --filter @kelpi/shell test           # vitest, this package's own project
pnpm --filter @kelpi/shell smoke          # the real thing: Electron + a private daemon
pnpm --filter @kelpi/shell smoke:web      # the web-pane host, driven by the shipped Swift CLI
pnpm --filter @kelpi/shell smoke:terminal # terminal fidelity: glyphs, columns, re-attach
pnpm --filter @kelpi/shell smoke:packaged # electron-forge package, then launch the .app itself
```

The unit tests cover the pure modules only (bounds clamp, badge/tray derivation, hotkey parse
and staged swap, icon encoding, entry/port resolution, and — for the web host — the registry,
the verb dispatch, the console formatting, the byte clamps and the host WS client). Anything
that imports `electron` cannot load under plain Node, so the smokes cover it instead:

- `scripts/smoke.mjs` boots a throwaway daemon on private paths, launches the real shell, and
  asserts the window loaded the daemon URL, the status socket handshook, a CLI-driven agent
  transition moved the dock badge, the quit gate holds a quit while an agent is active, and the
  daemon is still alive after the app exits.
- `scripts/web-smoke.mjs` adds the web host: it serves a small fixture site, opens a web pane
  with the **shipped Swift `nex` binary** (`NEX_SOCKET=tcp:…`, never `/tmp/nex.sock`) and drives
  the real Chromium behind it — capture/exec/actuator, the console pipeline's exact message
  formats, tabs, `file://` sibling assets, the element picker's nonce round trip, cookies and
  the private-partition rebuild. It then plays the web UI with a synthetic WS client tagged as
  the page inside this shell's window: a geometry report must move the pane's live view into the
  real window (and one from any other client must not), hiding it must return the view to the
  holder, and the pane must stay drivable throughout. Finally it asserts that quitting the shell
  releases the role (`no web pane host connected`) and that a fresh shell gets the daemon's
  `pane-open` replay.
  With no Swift CLI installed it skips (exit 0); `KELPI_COMPAT_CLI` points it at another copy.
- `scripts/terminal-smoke.mjs` is the one that would have caught what 3000 structural tests did
  not: how the terminal LOOKS. It gives a sandbox `$HOME` a powerlevel10k-shaped zsh prompt
  (Nerd Font private-use glyphs, a `$COLUMNS`-wide dotted filler, a right-aligned timestamp),
  opens the app at three real window sizes, and checks that the bundled Nerd Font is loaded in
  the window (no tofu), that the canvas fits inside its pane, and that a `$COLUMNS`-wide ruler
  and the prompt each occupy exactly `$COLUMNS` — a renderer that disagrees with the PTY by one
  column overruns the edge and clips the timestamp. Then it quits and relaunches: the replayed
  history must come back ONCE, at the width it was serialized for, and a daemon restart must
  spawn the shell at the remembered grid rather than 80×24. Screenshots every step with
  `--out <dir>` so a human can look, which is the real acceptance.
- `scripts/packaged-smoke.mjs` covers everything that is only true inside `Kelpi.app`: it runs
  `electron-forge package`, reads the asar header back to prove the allowlist held, reads the
  fuses out of the binary, then launches the **packaged** app with a private environment that
  names no daemon, no client and no Node — so all three have to come from its own Resources. It
  asserts the daemon process really is the bundled Node, that the served page is the staged
  client byte for byte, that the shipped `kelpi` CLI gets a ping and can drive a real PTY (the only
  proof node-pty loaded its native module from inside the bundle), that **the window really
  loaded the daemon-served client** (`did-finish-load` — the check that was red through run-F, and
  the one whose failure message carries the diagnosis), and that the daemon is still running after
  the app quits. 47 checks, ~30s; keeps the packaged app unless `--clean-app`. A *signed* build
  needs `--mock-keychain`, since it has cookie encryption fused on and the smoke's private `HOME`
  contains no login keychain to satisfy it.

Note the shell is **not** part of the repo-root vitest projects or the root `typecheck` script
(neither includes `packages/shell`, and the root config is not this package's to edit) —
`pnpm --filter @kelpi/shell test` and `pnpm --filter @kelpi/shell typecheck` run them.

## Security posture

Per docs/research/stack.md §1, the daemon URL is treated as remote content even though it is
ours: `contextIsolation` + `sandbox` on, `nodeIntegration` off, `webviewTag` off, navigation
allowlisted to the daemon origin, `setWindowOpenHandler` → `shell.openExternal` for validated
http(s) only, permissions limited to clipboard + notifications on the daemon origin.

There is **no preload script at all**. The renderer needs nothing from the shell, because the
main process gets its state from its own daemon socket rather than from the page — so there is
no `contextBridge` surface for a compromised page to reach. Adding one should be the last
resort, not the first.

## Not done here (later milestones)

- **Signing and notarization**: packaging is done (above), but the output is ad-hoc-signed only.
  The checklist — Developer ID, signing the bundled `node`, `osxNotarize` + stapling, then
  auto-update — is in the repo README's *Install and run* section.
- **Visual web panes**: the host (above) is a headless automation surface; putting the views on
  screen at the pane's rect needs a client→shell channel (there is deliberately no preload
  bridge yet) and the chrome from `docs/current/web-pane.md` §16 in the client.
- **The GUI-only web surfaces**: element-pickup batch mode (§12), favourites (§14) and the
  find-in-page bar (§10) have no wire verbs today; `webhost/dispatch.ts` already answers `find`
  and `zoom` so wiring them daemon-side is a handler, not a port.
- **Notification → pane navigation**: clicking a notification raises the window; switching
  workspace and focusing the pane needs a deep link the client understands.
- **Live hotkey re-registration**: the config is read once at launch (Settings UI is M8);
  `swapGlobalHotkey` is already the staged-swap primitive that a settings change will call.

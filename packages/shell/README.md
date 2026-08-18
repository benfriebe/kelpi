# @nex/shell — the Electron shell

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
├─ log.ts           `[shell] …` lines on stdout; the smoke asserts on them
└─ webhost/         the web-pane host (M6): WebContentsViews + CDP behind the daemon's host RPC
   ├─ client.ts     its OWN daemon WebSocket, claiming the `web-pane-host` role
   ├─ dispatch.ts   verb → CLI-shaped envelope (Electron-free, so it is unit-testable)
   ├─ registry.ts   pane → tabs → views; reconciles the daemon's lifecycle notifications
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
`WebContentsView`s, and answers every verb that needs a live browser — the whole `nex web`
surface: navigate/back/forward/reload, `capture` (meta/text/dom/screenshot/all), the actuator
(`click`, `type`, `q-*`, `wait`, `select`, `scroll`, `hover`, `key`), `exec`, the element
picker, cookies, find and zoom.

**v1 is an automation surface, not a rendered pane.** The views live in an off-screen holder
window that is never shown, while the web client keeps drawing its placeholder card for web
panes. That is deliberate: the shell has no preload bridge, so the client cannot tell it where
a pane's rectangle is, and everything an agent needs works without pixels on screen. Visual
embedding — re-parenting these same views into the main window at the pane's rect — is the
documented follow-up and touches only `tab.ts`'s bounds/ownership plus a new client→shell
channel. Two consequences worth knowing:

- a `WebContentsView` has **no renderer until something is loaded**, and every CDP command
  silently hangs until then, so each tab bootstraps with an `about:blank` load before the
  domains are enabled and the scripts are injected (`tab.ts`);
- `webSecurity` stays **on**. Chromium already lets a `file://` document load sibling
  subresources, which is the feature `nex web open ./page.html` needs; turning it off would buy
  only cross-file `fetch` at the cost of making every page an agent visits same-origin-free.

## The rule that outranks everything else

**The shell never stops the daemon.** Closing the window, ⌘Q, `app.quit()`, a SIGTERM — none
of them signal `nexd`. Quitting the app leaves every PTY, agent and workspace running, and the
next launch attaches to exactly the sessions that were there. `scripts/smoke.mjs` asserts this
by pinging the daemon after Electron has exited. Nothing in this package may grow a "stop the
daemon" path; the tray's daemon item is *Start* (when none is running) or *Reconnect* (when one
is), never *Restart*.

## Running it

```bash
pnpm --filter @nex/daemon build        # the shell spawns this bundle when nothing is running
pnpm --filter @nex/shell build         # esbuild → dist/main.js (CJS, electron external)
pnpm --filter @nex/shell start         # electron .
```

With no daemon running it starts one, detached, and waits for it to answer. To point a
development shell at throwaway paths (the shipped Swift app owns `/tmp/nex.sock` on a dev
machine, and the daemon's default run dir is shared):

```bash
NEXD_RUN_DIR=/tmp/nexd-dev-run \
NEXD_SOCKET_PATH=/tmp/nexd-dev.sock \
NEXD_DB_PATH=/tmp/nexd-dev.db \
NEXD_CONFIG_PATH=/tmp/nexd-dev-config \
pnpm --filter @nex/shell start
```

Environment it reads: `NEXD_RUN_DIR` (which daemon to talk to), `NEXD_ENTRY` (the `nexd`
script to spawn), `NEXD_NODE` (the Node binary to spawn it with), `NEXD_LOG_FILE` (where a
spawned daemon's output goes), `NEXD_CONFIG_PATH` (the shared `nex` config, for
`global-hotkey`). Everything else it inherits and passes to the daemon it spawns.

## Tests

```bash
pnpm --filter @nex/shell test          # vitest, this package's own project
pnpm --filter @nex/shell smoke         # the real thing: Electron + a private daemon
pnpm --filter @nex/shell smoke:web     # the web-pane host, driven by the shipped Swift CLI
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
  the private-partition rebuild, then asserts that quitting the shell releases the role
  (`no web pane host connected`) and that a fresh shell gets the daemon's `pane-open` replay.
  With no Swift CLI installed it skips (exit 0); `NEX_COMPAT_CLI` points it at another copy.

Note the shell is **not** part of the repo-root vitest projects or the root `typecheck` script
(neither includes `packages/shell`, and the root config is not this package's to edit) —
`pnpm --filter @nex/shell test` and `pnpm --filter @nex/shell typecheck` run them.

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

- **Packaging** (M8): Forge config, signing/notarization, `@electron/fuses`, and the bundled
  daemon payload. `daemon.ts` already looks for `<resourcesPath>/daemon/nexd.js` and
  `<resourcesPath>/node`, so packaging only has to place those files.
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

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
└─ log.ts           `[shell] …` lines on stdout; the smoke asserts on them
```

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
```

The unit tests cover the pure modules only (bounds clamp, badge/tray derivation, hotkey parse
and staged swap, icon encoding, entry/port resolution). Anything that imports `electron` cannot
load under plain Node, so `scripts/smoke.mjs` covers it instead: it boots a throwaway daemon on
private paths, launches the real shell, and asserts the window loaded the daemon URL, the
status socket handshook, a CLI-driven agent transition moved the dock badge, the quit gate
holds a quit while an agent is active, and the daemon is still alive after the app exits.

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
- **Web panes** (M6): `WebContentsView` + CDP. None of that exists yet.
- **Notification → pane navigation**: clicking a notification raises the window; switching
  workspace and focusing the pane needs a deep link the client understands.
- **Live hotkey re-registration**: the config is read once at launch (Settings UI is M8);
  `swapGlobalHotkey` is already the staged-swap primitive that a settings change will call.

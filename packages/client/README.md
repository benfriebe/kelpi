# @kelpi/client — the web client

The UI half of New Kelpi. It renders daemon state and sends commands; **no domain logic lives
here** (ARCHITECTURE.md: "clients are views"). Every mutation is a control-protocol verb the
`kelpi` CLI could equally have sent, so the browser and the CLI can never drift.

```
src/
├─ connection/   one WebSocket: handshake + reconnect, command RPC, PTY streams
├─ state/        the zustand mirror of DaemonState (+ this client's UI state) and the bridge
├─ terminal/     TerminalRenderer (ghostty-web | xterm.js), mount policy, TerminalPane
├─ grid/         the pane grid: frames, dividers, zoom, headers, focus ring
├─ content/      markdown / diff / scratchpad panes: the sandboxed frame, editor, subscriptions
├─ chrome/       sidebar, top bar, status footer, command palette, theme, keybindings
├─ app/          assembly helpers: daemon-target resolution, the web-pane placeholder
├─ App.tsx       the assembly: everything above, wired to a KelpiRuntime
└─ main.tsx      entrypoint: resolve target → build runtime → render
```

## Running it

The daemon **serves the built client**, so the production path needs no dev server at all.
There are two ways to work:

### 1. `vite dev` against a running daemon (fast iteration)

```bash
# terminal 1, a development daemon on its own paths (never /tmp/kelpi.sock, which the
# shipped Swift app owns on a dev machine)
pnpm --filter @kelpi/daemon build
KELPID_SOCKET_PATH=/tmp/kelpid-dev.sock \
KELPID_HTTP_PORT=19470 \
KELPID_TCP_PORT=19400 \
KELPID_DB_PATH=/tmp/kelpid-dev.db \
KELPID_RUN_DIR=/tmp/kelpid-dev-run \
node packages/daemon/dist/kelpid.js start --foreground

# terminal 2
pnpm --filter @kelpi/client dev     # http://localhost:5173
```

The client dials the daemon at its own origin by default, which on :5173 is the Vite server —
so one of these has to be true:

- **the WS proxy** (already configured): `vite.config.ts` proxies `/ws` to the daemon's
  **HTTP/WS** port, `http://127.0.0.1:19470` by default — the same port that serves the built
  client, not the control TCP port. Set `KELPI_DAEMON_URL=http://127.0.0.1:<port>` before
  `pnpm dev` if your daemon took a different one; or
- **`?daemon=`**: open `http://localhost:5173/?daemon=http://127.0.0.1:19470`, which bypasses
  the proxy entirely.

Either way the daemon's handshake is token-gated, so add the token once. `kelpid url` prints that
daemon's ready-to-open URL; on :5173 you want its token plus a `?daemon=`:

```bash
TOKEN=$(KELPID_RUN_DIR=/tmp/kelpid-dev-run node packages/daemon/dist/kelpid.js url | sed 's/.*token=//')
open "http://localhost:5173/?daemon=http://127.0.0.1:19470&token=$TOKEN"
```

`?daemon=` and `?token=` are remembered in `localStorage` and then **stripped from the address
bar** (a token in the URL ends up in history and screenshots). Clear a stale value with an empty
parameter: `?daemon=&token=`. A token the daemon refuses is forgotten automatically, so a stale
one cannot wedge every later visit — the client shows the daemon's refusal and stops retrying
instead of looping on "Reconnecting…".

### 2. daemon-served (what ships)

```bash
pnpm --filter @kelpi/client build                    # → packages/client/dist
KELPID_CLIENT_DIR=$PWD/packages/client/dist \
KELPID_HTTP_PORT=19470 \
node packages/daemon/dist/kelpid.js start --foreground
open "$(node packages/daemon/dist/kelpid.js url)"
```

`KELPID_CLIENT_DIR` is the static-dir mechanism (`daemon/src/ws/http.ts`); with it unset the
daemon answers with a "client not built" page and everything else (control socket, `/ws`,
`/healthz`) still works. Assets under `/assets/` are content-hashed and served immutable;
any unknown path falls back to `index.html`, so deep links work.

`/favicon.svg`, `/favicon.png` and `/apple-touch-icon.png` are the build outputs with fixed
names, because `index.html` links them: the Kelpi mark, printed from `@kelpi/core/icon` by a
plugin in `vite.config.ts` rather than checked in, so the tab icon is the same drawing as the
Dock tile and the menu-bar glyph. The dev server answers the same paths. Once the client
mounts, `chrome/favicon.ts` swaps the href of both icon links for a canvas render of the mark
carrying the agent status dot (§8.2's waiting-beats-running rule).

The PNGs are not spares. Safari renders no SVG favicon and re-reads no icon a script swapped
in, so on an iPhone attached over the tailnet `/favicon.png` is the only icon there will ever
be, and `/apple-touch-icon.png` is what "Add to Home Screen" installs.

## The live smoke

```bash
node packages/client/scripts/smoke.mjs            # rebuilds both packages, then checks
node packages/client/scripts/smoke.mjs --keep     # …and leaves the daemon up to poke at
node packages/client/scripts/smoke.mjs --no-build --verbose
```

It boots a throwaway daemon (its own tmp socket, DB, run dir and HOME — **never**
`/tmp/kelpi.sock`) and asserts the things only a live system can prove: the page and its bundle
are served, the WS handshake completes, a snapshot arrives, a workspace created with the **real
Swift `kelpi` CLI** shows up as a delta on the socket, an attached pane replays before it streams,
and `echo …` typed as PTY input comes back as output. Exit code 0 means every check passed.

The Swift CLI is optional: without `/Applications/Nex.app/Contents/Helpers/nex` the same verbs
are exercised over the WS command channel instead (override the path with `KELPI_COMPAT_CLI`).

## Terminal engine

`ghostty-web` is the default renderer — Ghostty's VT core as WASM, behind an xterm.js-shaped
API. The escape hatch is a build-time flag:

```bash
VITE_TERMINAL_ENGINE=xterm pnpm --filter @kelpi/client build
```

Both engines sit behind `TerminalRenderer` (`src/terminal/renderer.ts`) and are code-split, so
only the selected one is downloaded. The xterm build additionally pulls in
`@xterm/xterm/css/xterm.css`, which `main.tsx` imports **only** for that engine. Known
ghostty-web gaps are catalogued in `../kelpi-docs/research/ghostty-web-spike.md`.

## Terminal font

The client **bundles** `JetBrainsMono Nerd Font` (regular + bold WOFF2, SIL OFL 1.1) in
`src/assets/fonts/`, declared as `@font-face` in `styles.css`. This is not a style choice: it
is the same family libghostty bundles and falls back to for missing glyphs, which is why
powerlevel10k / starship prompts rendered correctly in the Swift app. No system monospace on
macOS carries Powerline separators or Nerd Font private-use icons, so without it every such
prompt is a row of tofu boxes.

`src/terminal/fonts.ts` owns three things that have to agree:

- **the stack** — `[the user's ghostty font-family] → JetBrainsMono Nerd Font → ui-monospace /
  Menlo → monospace`, so a user font that lacks the icons still renders them;
- **the load gate** — both engines measure their cell exactly once, at construction, and
  `canvas.measureText` before the face loads silently measures the fallback. Every pane awaits
  `loadTerminalFonts()` first (bounded by `TERMINAL_FONT_WAIT_MS`, so a slow link costs a late
  correction via `onTerminalFontsReady` rather than a blank pane);
- **the measuring rule** — `measureCellSize` mirrors ghostty-web's own
  `ceil(measureText('M').width)`, so the columns a pane attaches with are the columns the
  engine can actually draw. Measure any other way and the canvas ends up wider than the pane,
  which is the clipped-right-edge / overrunning-filler bug.

Regenerate the WOFF2 files with `node scripts/build-fonts.mjs --ttf-dir <ghostty>/src/font/res`
(provenance and licence: `src/assets/fonts/README.md`).

## Theming

`chrome/theme.ts` resolves the palette (shell-ui.md §2) and `ThemeProvider` writes it to
`documentElement` as `--kelpi-*` custom properties. `src/styles.css` defines the same tokens for
both appearances as the pre-hydration state, and is the sole owner of the `--kelpi-term-*` family
that the terminal engines read off the DOM. Add a token there, not in a component.

## Tests

```bash
npx vitest run --project client      # jsdom, colocated *.test.ts(x)
npx tsc -p packages/client/tsconfig.json
```

`App.test.tsx` drives the whole app against a scripted socket (`connection/testing.ts`) with a
snapshot built by the daemon's own store — the jsdom counterpart of the live smoke.

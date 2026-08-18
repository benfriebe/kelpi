# @nex/client — the web client

The UI half of New Nex. It renders daemon state and sends commands; **no domain logic lives
here** (ARCHITECTURE.md: "clients are views"). Every mutation is a control-protocol verb the
`nex` CLI could equally have sent, so the browser and the CLI can never drift.

```
src/
├─ connection/   one WebSocket: handshake + reconnect, command RPC, PTY streams
├─ state/        the zustand mirror of DaemonState (+ this client's UI state) and the bridge
├─ terminal/     TerminalRenderer (ghostty-web | xterm.js), mount policy, TerminalPane
├─ grid/         the pane grid: frames, dividers, zoom, headers, focus ring
├─ chrome/       sidebar, top bar, status footer, command palette, theme, keybindings
├─ app/          assembly helpers: daemon-target resolution, the content-pane placeholder
├─ App.tsx       the assembly: everything above, wired to a NexRuntime
└─ main.tsx      entrypoint: resolve target → build runtime → render
```

## Running it

The daemon **serves the built client**, so the production path needs no dev server at all.
There are two ways to work:

### 1. `vite dev` against a running daemon (fast iteration)

```bash
# terminal 1 — a development daemon on its own paths (never /tmp/nex.sock, which the
# shipped Swift app owns on a dev machine)
pnpm --filter @nex/daemon build
NEXD_SOCKET_PATH=/tmp/nexd-dev.sock \
NEXD_HTTP_PORT=19470 \
NEXD_TCP_PORT=19400 \
NEXD_DB_PATH=/tmp/nexd-dev.db \
NEXD_RUN_DIR=/tmp/nexd-dev-run \
node packages/daemon/dist/nexd.js start --foreground

# terminal 2
pnpm --filter @nex/client dev     # http://localhost:5173
```

The client dials the daemon at its own origin by default, which on :5173 is the Vite server —
so one of these has to be true:

- **the WS proxy** (already configured): `vite.config.ts` proxies `/ws` to the daemon's
  **HTTP/WS** port, `http://127.0.0.1:19470` by default — the same port that serves the built
  client, not the control TCP port. Set `NEX_DAEMON_URL=http://127.0.0.1:<port>` before
  `pnpm dev` if your daemon took a different one; or
- **`?daemon=`**: open `http://localhost:5173/?daemon=http://127.0.0.1:19470`, which bypasses
  the proxy entirely.

Either way the daemon's WS upgrade is token-gated, so add the token once:

```bash
open "http://localhost:5173/?daemon=http://127.0.0.1:19470&token=$(cat /tmp/nexd-dev-run/daemon-v1.token)"
```

`?daemon=` and `?token=` are remembered in `localStorage` and then **stripped from the address
bar** (a token in the URL ends up in history and screenshots). Clear a stale value with an empty
parameter: `?daemon=&token=`.

### 2. daemon-served (what ships)

```bash
pnpm --filter @nex/client build                    # → packages/client/dist
NEXD_CLIENT_DIR=$PWD/packages/client/dist \
NEXD_HTTP_PORT=19470 \
node packages/daemon/dist/nexd.js start --foreground
open "http://127.0.0.1:19470/?token=$(cat ~/Library/Application\ Support/nexd/run/daemon-v1.token)"
```

`NEXD_CLIENT_DIR` is the static-dir mechanism (`daemon/src/ws/http.ts`); with it unset the
daemon answers with a "client not built" page and everything else (control socket, `/ws`,
`/healthz`) still works. Assets under `/assets/` are content-hashed and served immutable;
any unknown path falls back to `index.html`, so deep links work.

## The live smoke

```bash
node packages/client/scripts/smoke.mjs            # rebuilds both packages, then checks
node packages/client/scripts/smoke.mjs --keep     # …and leaves the daemon up to poke at
node packages/client/scripts/smoke.mjs --no-build --verbose
```

It boots a throwaway daemon (its own tmp socket, DB, run dir and HOME — **never**
`/tmp/nex.sock`) and asserts the things only a live system can prove: the page and its bundle
are served, the WS handshake completes, a snapshot arrives, a workspace created with the **real
Swift `nex` CLI** shows up as a delta on the socket, an attached pane replays before it streams,
and `echo …` typed as PTY input comes back as output. Exit code 0 means every check passed.

The Swift CLI is optional: without `/Applications/Nex.app/Contents/Helpers/nex` the same verbs
are exercised over the WS command channel instead (override the path with `NEX_COMPAT_CLI`).

## Terminal engine

`ghostty-web` is the default renderer — Ghostty's VT core as WASM, behind an xterm.js-shaped
API. The escape hatch is a build-time flag:

```bash
VITE_TERMINAL_ENGINE=xterm pnpm --filter @nex/client build
```

Both engines sit behind `TerminalRenderer` (`src/terminal/renderer.ts`) and are code-split, so
only the selected one is downloaded. The xterm build additionally pulls in
`@xterm/xterm/css/xterm.css`, which `main.tsx` imports **only** for that engine. Known
ghostty-web gaps are catalogued in `docs/research/ghostty-web-spike.md`.

## Theming

`chrome/theme.ts` resolves the palette (shell-ui.md §2) and `ThemeProvider` writes it to
`documentElement` as `--nex-*` custom properties. `src/styles.css` defines the same tokens for
both appearances as the pre-hydration state, and is the sole owner of the `--nex-term-*` family
that the terminal engines read off the DOM. Add a token there, not in a component.

## Tests

```bash
npx vitest run --project client      # jsdom, colocated *.test.ts(x)
npx tsc -p packages/client/tsconfig.json
```

`App.test.tsx` drives the whole app against a scripted socket (`connection/testing.ts`) with a
snapshot built by the daemon's own store — the jsdom counterpart of the live smoke.

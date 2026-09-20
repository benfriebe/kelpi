# Driving Kelpi from a script or an agent

Three things live here, for three jobs:

| | what | when |
|---|---|---|
| `audit.mjs` | the regression battery: ~127 fixed steps of real gestures against a real window, with screenshots, run by `verify.mjs --full` and every promote | proving the app has not regressed |
| `lib/driver.mjs` | one import that boots or attaches to an instance and gives you the page, the shell's native surfaces and the helpers | testing the change you are making |
| `../scenario.mjs` + `../scenarios/*.mjs` | a runner and the scenarios written with the driver, one per behaviour, selected and run by `verify.mjs` in both tiers | the same, as a repeatable file |

The audit measures. A scenario checks one thing, is written by whoever changes that thing, and runs against the tree that carries the change. Issues #47, #53 and #55 were fixed with unit tests only, because the only way to exercise them for real was to add a step to a 29,000-line file; the scenarios beside this README are what those fixes should have shipped with.

## Running a scenario

```bash
node scripts/scenario.mjs                      # every scenario, in a fresh sandbox (builds first)
node scripts/scenario.mjs confirm-dialog-keys  # one, by name, --no-build to skip the build
node scripts/scenario.mjs --keep <name>        # leave the sandbox up to poke at afterwards
node scripts/scenario.mjs --window hidden      # without taking the screen (runs serialize; below)
```

Against a dev instance you already have up (`node scripts/dev-instance.mjs` prints both values):

```bash
node scripts/scenario.mjs --attach <debugPort> --harness <state>/harness.sock <name>
```

Results go to `docs/audit/scenarios/<stamp>/results.json` with screenshots beside it. Exit code 1 if any check failed.

A sandbox is private: its own run dir, control socket, database and ephemeral ports, torn down at the end. It never touches the daemon or app you are using. By default it opens a real window on your screen; `--window hidden` is the functional lane below, which does not.

## Writing one

A scenario is an ES module with a default export:

```js
export default async function ({ page, harness, cli, sandbox, shell, daemon, rec, d, sleep }) {
    const created = JSON.parse(await cli.ok(['pane', 'create', '--workspace', 'Default', '--json']));
    await d.settleDom(page, `document.querySelector('[data-testid="pane-header-${created.pane_id}"]')`);
    await d.openSidebarMenu(page, d.PAGE.workspaceRows, 'Default');
    await d.clickMenuItem(page, 'Rename');
    rec.check('a rename field appeared', await d.settleDom(page, `document.activeElement?.tagName === 'INPUT'`));
    await rec.shot(page, 'renaming');
}
```

- `page` is `lib/cdp.mjs`'s page: `eval(js)`, `waitFor(js)`, `click(selector)`, `clickAt(x, y)`, `rightClick`, `key(code, { modifiers: d.MOD.meta | d.MOD.shift })`, `type(text)`, `drag`, `box(selector)`, `screenshot(file)`.
- `harness` is the shell's native-surface channel (below).
- `cli` is the sandbox's `kelpi`: `run(args, { env })` gives `{ code, stdout, stderr }`; `ok(args)` requires exit 0 and returns stdout. Pass `env: { KELPI_PANE_ID }` to speak as a pane. An invocation the CLI cannot PARSE throws out of `run` as well as `ok`, because that is a bug in the caller and never a product outcome. All five shapes, read off the first line of stderr: `Unknown command:`, `Unknown <group> action:`, `Unknown option for <command>:`, and `rejectLeftoverArgs`'s `<command>: unknown option <flag>` and `<command>: unexpected argument '<x>'`, which is how every command other than `workspace delete` refuses a flag it does not know. #202 is what one costs when it resolves instead: `workspace delete --name <name>` (delete takes positional names; its sibling `create` takes `--name`) exited 1 into a result nobody read, and the workspace stayed active for the next 28 steps and blanked four of them.
- `shell` is the shell process this runner launched: `lines` (every stdout/stderr line so far), `text()`, `waitForLine(pattern, label, timeoutMs)`. It is `null` under `--attach`, where the runner did not start the shell and cannot read its pipe, so a scenario that needs it must check and say so. Use it only for behaviour whose sole external evidence is a log line: the web-pane placement trail (`web pane <id> view owner=main|holder bounds=… (reason)`) is the case it was added for, because a native view is composited by the window and never appears in the renderer's own frames.
- `daemon` is the sandbox's own daemon, restartable in place: `stop()`, `start()`, `restart()`, plus `pid`, `child`, `generation` (how many processes this sandbox has had), `exited`, `text()` (which spans restarts) and `lastStopMs` / `lastStartMs`. `null` under `--attach`, where the daemon belongs to whoever started the instance and stopping it would take their session down, so an arm that needs one checks for null and says so. See [the daemon handle](#the-daemon-handle-stopping-the-primary-daemon) below.
- `rec.check(label, ok, detail)` is the assertion; `rec.note`, `rec.shot(page, label)`.
- `d` is the driver module: `PAGE` (the testid anchors), `settle`, `settleDom`, `domPaneIDs`, `clickPaneHeader`, `focusPaneBody`, `runInTerminal`, `openSettingsRoot`, `openSettingsTab`, `clickMenuItem`, `openSubmenu`, `clickSubmenuItem`, `openSidebarMenu`, `contextMenuRows`, `clickDialogButton`, `findMenuItem`.

`openSidebarMenu` (shared with the audit, in `lib/aim.mjs`) scrolls its row into view, re-measures it immediately before pressing, refuses a point outside the sidebar's scroller, waits for the menu rather than sleeping past it and retries once. A row measured where it could no longer be clicked is what #204 was: in a full run the list outgrew the scroller, the press landed on the footer, and all the harness could say was `(no-menu)`. It now names the point, both rects and what `elementFromPoint` found there.

Rules that keep scenarios honest: wait on a condition (`settle`, `settleDom`, `page.waitFor`), not on a sleep, except where the wait IS the assertion (a negative check needs a dwell). Prefer `data-testid` anchors; add one to the client rather than matching on text or CSS. A scenario that fails should say what it saw: pass the detail to `rec.check`.

Every instance returned by `d.boot()` carries `rendererErrors`. Boot sets
`KELPI_HARNESS_DEFER_LOAD=1` alongside the private harness socket: the shell loads an inert
`about:blank` document, giving CDP a running renderer while holding the first client document.
The driver waits for that blank target and subscribes to `Runtime.exceptionThrown` and
`console.error` before enabling Runtime, then releases the first app navigation through
`harness.loadClient()` only after Runtime acknowledges. A refused or timed-out watcher setup
rejects boot and tears down the private instance; it cannot substitute for app readiness.
A failed first mount therefore reaches the first scenario's named renderer check even when no
app root appears. `beforeLoad(page)` is an optional boot hook for CDP setup after the watcher is
armed and before navigation; `renderer-errors-at-boot` uses it to inject a failing first document.
Failed boots close their partial private instances.

The runner calls `instance.rendererErrors.finish(rec)` after each scenario, consuming that
instance's accumulated lines once. Dedicated placement instances get their own watcher from
boot. The shared lane continues watching while a dedicated instance runs; its idle-period errors
remain attributed to the next shared-lane scenario, preserving the existing attribution rule. `d.attach()` starts watching as soon as it connects, but cannot recover errors that
predate attachment. Callers that boot additional instances can drain those watchers into their own
recorders. The standalone audit has its own startup and console collector; it does not call
`driver.boot()` and does not opt into the deferred-load gate.


### The daemon handle: stopping the primary daemon

A window that has lost its daemon is a state a great deal of the client is written for, and nothing in the DOM can put it there: the plugin views draw "Connecting to daemon…", the presenter slots fall back to their bundled children, the reconnect backs off from 500 ms to 15 s, and every promise a plugin was awaiting is settled by the scope that is being disposed. `daemon` is how a scenario reaches it (#199):

```js
const before = daemon.pid;
await daemon.restart();                       // stop, start, wait for /healthz
await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 30_000 });
rec.check('the daemon really was replaced', daemon.pid !== before && daemon.generation === 2);
```

The restart is IN PLACE: `makeSandbox` fixes the run dir, the socket, the ports and the database, and the token is minted once and re-read on every later start, so the daemon that comes back is the same identity at the same address and the client's saved token is still good. What the window does in between is therefore the behaviour under test rather than an artefact of a new address.

Four things to know before writing a check against it:

- **`/healthz` is not "the client reconnected".** `start()` waits for the daemon's HTTP listener and stops there. The window's own `data-connection` on `[data-testid="kelpi-app"]` is the authority, and it is worth OBSERVING rather than polling for: a `MutationObserver` installed before the restart catches the disconnected state whatever the backoff does, where a poll can miss a fast reconnect and report that the window never noticed.
- **Every PTY dies with the old process, in the WHOLE instance.** A restart is a real daemon death, not a handover, so a pane's shell is a new process with an empty scrollback afterwards. `scenario.mjs` runs every scenario of a run in one instance, so that is every pane the earlier scenarios made, not only the restarting scenario's, and a generation that ends in SIGKILL (below) also loses `persistence.close()` and the run files. So put a restart arm LATE in a scenario, leave the instance able to boot a fresh pane afterwards, and never let a later step lean on a pane created before the restart. A check that reads pane text across a restart has to say which side of it each reading came from.
- **A plugin view's iframe is destroyed and rebuilt.** `PluginView`'s main effect depends on the connection status, so its cleanup disposes the view's UI scope and the document is cleared; nothing a scenario left inside that frame survives. Instrument the HOST page, not the frame, for anything that has to be read after the restart.
- **`--attach` has no handle.** It is `null` there, and for a stronger reason than `shell` is: that instance belongs to whoever started it.

Print `lastStopMs` and `lastStartMs` beside a restart rather than only its total. A stop at or above 8000 ms is `startDaemon`'s SIGTERM window elapsing and the SIGKILL behind it, which was **issue #212**, now FIXED: a reading at the cap is a regression to report, not a known bug. What it used to be: `ws/server.ts` ▸ `stop()` closed the WebSockets it tracks and then awaited `server.close()`, whose callback waits for every connection to drain, so the renderer's leftover keep-alive HTTP sockets (the client document, and the `/plugin-assets/...` fetches that build each plugin view's srcDoc) held the listener open; `boot/compose.ts` sat in `ws.stop()` until the SIGKILL, which lands after `persistence.flush()` and `pty.killAll()` and so skipped `persistence.close()`, `clearRunFiles(paths)` and the final `kelpid stopped` line. Measured before the fix, on 2026-09-13: `plugin-interaction-presenters`, which rebuilds plugin views shortly before its restart, hit it in nine runs of fourteen (stops of 8002 to 8005 ms against 12 to 14 ms in the other five) with the arm green each time, while all nine `plugin-settings-presenter` runs and five standalone probes never did. `closeAsync` now sweeps the idle connections the moment the listener closes and destroys whatever is left 250 ms later, so it always resolves; measured after, on 2026-09-14: five runs of `node scripts/scenario.mjs plugin-interaction-presenters plugin-settings-presenter --window hidden` on the #212 fix, ten restarts in all, stops of 9 to 20 ms, no run anywhere near the cap, and every replaced daemon logging `kelpid stopped`.

`stop()` alone leaves the sandbox daemonless for as long as the scenario wants (the state the fallbacks are written for); `start()` brings it back; `restart()` is the pair. The instance's own `stop()` stops whichever process is current, so a run that restarted the daemon still tears its sandbox down. `scripts/scenarios/plugin-interaction-presenters.mjs` and `plugin-settings-presenter.mjs` each end with an arm that uses it.

## The native surfaces: the shell's harness channel

CDP reaches the client, which is a web page. The application menu, native accelerators, native dialogs and the dock are Electron main-process surfaces, and a scenario reaches them through a Unix socket the shell opens only when `KELPI_HARNESS_SOCKET` names a path (`packages/shell/src/harness.ts`; a user's shell never carries it and is byte-identical without it). `driver.boot` sets it; `dev-instance.mjs` sets it and prints the path.

| op | does |
|---|---|
| `harness.menu()` | the application menu as a tree: `{ id, label, accelerator, enabled, visible, type, role, checked, submenu }` |
| `harness.menuClick({ id })` or `({ path: ['View', 'Toggle Sidebar'] })` | fires that item's click handler as Electron would |
| `harness.press('Cmd+Alt+S')` | lands a native accelerator: clicks the first enabled item bound to it (Electron spellings normalised) |
| `harness.counters()` | `{ dockBounces, lastBounce, dialogs, lastDialog: { title, message, buttons, response }, notifications, lastNotification, recentNotifications, externalOpens, lastExternalUrl }` |
| `harness.armDialog({ response: 1 })` | the next native `dialog.showMessageBox` resolves with that instead of showing; one-shot |
| `harness.notificationClick({ index, action })` | fires that notification's click handler, or the named action button's ("Open" / "Dismiss"), exactly as the OS would |
| `harness.notificationClose({ index })` | fires its close handler, as a swiped-away banner does |
| `harness.window()`, `focus()`, `blur()` | the main window's focus, bounds, `visible` and `minimized`; the dock only bounces while it is unfocused. `minimized` is there so a scenario can OBSERVE what a chord did without calling `minimize()` and being the thing that did it (#95) |
| `harness.hide()`, `minimize()`, `restore()` | what ⌘H and ⌘M do to the window, and the two events that undo them; each answers `{ visible, minimized }` read back after the call. Real `BrowserWindow` calls, because the behaviour they exist for is the shell parking every web pane's view on `hide`/`minimize` and restoring it on `show`/`restore` (issue #75), which a synthesised event would not reproduce. They cannot be reached through `menuClick`/`press`: those are `role` rows, which `menu-click` refuses |
| `harness.crash(paneID)` | kills the renderer behind that web pane's active tab (`webContents.forcefullyCrashRenderer`), as macOS does under memory pressure. Answers `{ paneID, tabID, crashed: true }`, or refuses with `no live view for pane <id>` when the pane has no view and `this shell has no web pane host` when there is no web host at all |
| `harness.clipboardRead()`, `clipboardWrite(text)` | the system clipboard, through the MAIN process. Both answer `{ text }`, and the write's `text` is the pasteboard READ BACK afterwards, so a seed is proven in one round trip. Use these and never `navigator.clipboard` in the page: the page's version throws `NotAllowedError: Document is not focused` the moment the window is not focused, which is a state most of this battery puts it in on purpose (issue #109) |

Newline-delimited JSON on the socket, `{ id, op, ... }` in, `{ id, ok, result | error }` out, if you want to speak it without the driver.

### Crashing a pane on purpose

`crash` exists because issue #76's recovery is three processes wide (a renderer dies in the shell, the shell disposes and re-places the view, the daemon re-announces the pane, the client draws a card if it does not) and only the last of those is reachable from a renderer. CDP's `Page.crash` is not an alternative: it needs a debugger attached to the PANE's own target, and `--remote-debugging-port` exposes the shell window's page, not the `WebContentsView` inside it.

It kills a real process, so it is the one op that changes the instance under the test rather than reading it. Keep it to a sandbox (which is all `KELPI_HARNESS_SOCKET` ever reaches), and remember the daemon rebuilds the pane automatically for the FIRST death in 30 s: to see the "This page stopped responding" card, wait for the rebuild and crash it again (web-pane.md §5.2). `scripts/ui-audit/web-view-rebuild.mjs` and `scripts/scenarios/web-pane-crashed-card.mjs` both do exactly that.

### External opens

`externalOpens` / `lastExternalUrl` are every `shell.openExternal` the shell asked for this run and the last URL it named, whole (#83). They exist because "the browser opened, at this address" is otherwise invisible to a driver: the URL goes to the OS and nothing about it comes back through CDP, the DOM or the CLI, which is what left the ⌘-click path (terminal-surface.md §7.6) with no live coverage of the thing it is for.

**Under the channel the real open does NOT happen.** The wrapper records and swallows, exactly the way an armed `dialog.showMessageBox` is answered without being shown, and the caller's promise resolves as it always did. This is not a nicety: a battery that popped a browser window onto the machine every time a step ⌘-clicked a link would be unrunnable, and several sandboxes at once would fight over the foreground. A user's shell has no wrapper and opens links for real (`packages/shell/src/harness.ts` ▸ `wrapExternalOpen`). See `../scenarios/cmd-click-codex-links.mjs`.

### Notifications

`new Notification(...)` is a class import, so there is no property to replace the way `app.dock.bounce` and `dialog.showMessageBox` are replaced. Every notification the shell posts therefore goes through one seam instead (`packages/shell/src/notify-present.ts`; `notify.ts` has the request shape and `harness-protocol.ts` the recording rules), and the channel swaps the presenter behind it. A user's shell is unchanged: the seam builds the same options object each call site built, passes on only the keys it was given, and registers only the listeners the caller supplied, `notify-present.test.ts` pins that.

A notification is recorded when it is SHOWN, not when it is built, and each record is:

```
{ seq, title, body, actions: string[], paneID: string|null, silent, key: string|null, displayed, closed }
```

`seq` is its ordinal in the run; `key` is agent-lifecycle.md §7.5's identifier (`kelpi-<paneID>`), which is what makes replace-on-repost assertable, a pane never has two records with the same `key` and `closed: false`. `counters().notifications` is the exact count for the whole run and `recentNotifications` is the last 20, oldest first. The `index` both ops take is a position in THAT list (negatives count from the end), and omitting it means the most recent one.

Both ops call the call site's own handler, so what a scenario exercises is the shipped path: `notificationClick()` runs §7.5's default click (activate, switch to that workspace, focus that pane) and `notificationClick({ action: 'Open' })` runs the button that §AGNT-073 registers alongside it. See `../scenarios/notification-shown-and-opened.mjs`.

Under the channel the shell still posts for real, which is harmless. `KELPI_HARNESS_QUIET_NOTIFICATIONS=1` (forwarded to the sandbox by `lib/stack.mjs`, like the throttle flag) records without posting, for a machine running several sandboxes at once or one whose Notification Centre a human is also reading; it changes nothing else, and `displayed` on the record says which way a run went.

## The functional lane: no screen, several at once

`--window hidden | offscreen | onscreen` places the scenario's window somewhere other than in front of you. Unset, nothing changes: the shell builds the window it has always built, and a run today is byte-identical to a run before the lane existed. The shell-side gate is two variables, `KELPI_HARNESS_SOCKET` (already set for every sandbox) **and** `KELPI_HARNESS_WINDOW`, read by `packages/shell/src/audit-window.ts`, which is where the audit's placement mechanics already lived; the audit's own `KELPI_AUDIT` gate is untouched and neither lane can open the other. A user's shell, a packaged build and every existing probe get the shipped window, pinned by `audit-window.test.ts`.

```bash
node scripts/scenario.mjs --no-build --window hidden                  # every scenario, no screen
node scripts/scenario.mjs --no-build --window hidden a & \
node scripts/scenario.mjs --no-build --window hidden b ; wait         # queued, own sandbox each
```

Each run gets its own run dir, socket, database and ephemeral ports. **The desktop and clipboard are still shared.** The earlier four-run measurement (4 × 23 checks green) did not establish clipboard isolation. Scenario runners (including `--attach`), audit runs and the five shell smokes now acquire one machine-wide desktop test slot before starting their work (#207), across worktrees and window placements. A waiting run prints its wait every 30 seconds and fails after 30 minutes without starting a desktop test. `verify.mjs` invokes these guarded runners; it does not hold a second slot. Audit shard children acquire individually, and their parent never owns the slot.

`lib/desktop-slot.mjs` reserves loopback TCP port **19735** for the runner lifetime, through teardown and `--keep`. Binding is atomic; process exit releases the reservation in the kernel. `lib/desktop-lifecycle.mjs` installs SIGINT/SIGTERM handling before private resources start, registers partial boots and each shared/dedicated/restarted process, and holds the slot until their teardown settles. Repeated signals do not bypass cleanup; a failed cleanup retains the slot with an explicit diagnostic. New process creation is refused once teardown begins. `--keep` remains protected until cancellation finishes cleanup. There is no inherited bypass or stale lock file to delete. An unrelated listener on that port also blocks tests and yields the same explicit timeout; the harness never stops it. This cooperative guard cannot isolate the pasteboard from a person, an older checkout, a standalone driver probe or another unguarded tool. SIGKILL and runtime crashes cannot run this cleanup and may leave orphan descendants after the kernel releases the slot; there is no PID-based recovery of a dead runner. Coordinate those uses separately. Non-desktop unit tests and typechecks do not acquire it.

**Issue #207 remains an unconfirmed intermittent failure.** Serialization removes an allowed source of interference; it does not prove what caused the historical missing paste or lone `/`. PR #228's clipboard-at-press, caret, toast and full-capture diagnostics remain in `terminal-copy-paste-chords`. The image-paste path is specified product behavior and is unchanged. A green run under the guard is not a reproduction or a root-cause finding.

The results directory is stamped to the millisecond and disambiguated by pid, so queued runs never write over each other.

**Safe for**: everything a scenario asserts, which is DOM state, CDP input, the CLI, the harness channel's menu / accelerators / dialogs / dock counters / notification records, and the app's own activity signalling. **Not safe for**: anything that measures pixels. Under `hidden` a screenshot comes back blank white (`Page.captureScreenshot` composites the window's alpha), under `offscreen` it comes back at half resolution with sub-pixel geometry quantised differently. `rec.shot` writes that caveat into the note it records, and `results.json` carries the placement, so a picture is never silently worth less than it looks. Strict acceptance retains scenario EYES obligations too: hidden captures cannot satisfy them. Use the strict verifier’s `--scenario-window onscreen` option for a fresh run with reviewable images; the desktop reservation is still required.

### A scenario can declare the placement it needs (`windowPlacement`)

Two of the lane's properties fight each other. `hidden` is the same window at zero opacity, which is what gives the machine's owner their screen back — and AppKit counts a zero-opacity frame as visible **only while nothing is in front of it**. Put the owner's own window over the lane's rectangle and the frame is occluded. Nothing in the DOM notices; two things do:

- a scenario that drives a real native page. Chromium treats the window's `WebContentsView`s as hidden, throttles them and **drops the CDP input dispatched to them**. `plugin-browser-features`, measured on 2026-09-13 on one tree minutes apart: `hidden` 37/44 and an abort in 86 s, with `clicks: 0` and `cookies: ""` in the fixture page's own state; `offscreen` 65/66 in 20 s. That is almost certainly the unexplained cause in issue #206, "a click that never reached the page", where a concurrent visible audit window is recorded as a possible factor.
- a scenario whose precondition is the app going inactive. `dock-bounce-stop-only` behind `confirm-dialog-keys`: `hidden` 5/7 (the page still reads `visible` 8 s after `harness.hide()`), `offscreen` 7/7 in 1.8 s, run for run. Issue #109 filed the same scenario as "a scenario whose occlusion precondition the environment could not meet" and it cost a promote.

So a scenario may declare the weakest placement it can be trusted at:

```js
export const windowPlacement = 'offscreen';
```

`scripts/scenario.mjs` honours it by giving that scenario an instance of its own at the declared placement, because a placement is fixed when the shell builds its window and "raise it" can only mean a second instance. The rule is a **floor, never a ceiling** (`lib/placement.mjs`, unit-tested in `lib/placement.test.mjs`):

| the run | the declaration | what runs |
| --- | --- | --- |
| `--window hidden` | none | the lane's window |
| `--window hidden` | `offscreen` | its own `offscreen` instance |
| `--window onscreen` | `offscreen` | the lane's window (never lowered) |
| no `--window` | `offscreen` | the shipped window, untouched, with a warning |
| any | not a placement | the lane's window, with a warning |

The placement each scenario ran at is printed beside its name (`▶ name  [window offscreen, its own instance]`) and written into `results.json`. A scenario on its own instance cannot leak into the shared sandbox, so the runner records its post-condition as `leaked: null` rather than as an empty list. Declare it only from a measurement: the cost is a 20 s boot, and `offscreen` also halves the screenshots' resolution.

### An audit flow can declare the placement it needs

The full audit normally uses one visible `default` window because its screenshots are visual evidence. That window can still be covered, which makes Chromium drop CDP input sent to a native `WebContentsView`. A flow declares its floor in `lib/shards.mjs`; `web-batch-pickup`, `web-batch-internals`, and `web-console-frames` declare `offscreen` after #206's reproduced occlusion evidence.

When the audit is at `default` or `hidden`, the parent runs those declarations in one private offscreen process and runs each chain writer there as setup. Placement children run serially, each finishing cleanup before the next starts, because private instances still share the machine's screen and clipboard. The aggregate retains the normal process's canonical writer entry and omits successful setup duplicates; failed duplicates remain as attributed `web-pane-setup-shard-N` entries, including their assertions, errors and artifacts. A narrow `--only` run starts only groups containing requested steps and runs their chain writers in that same process; `--no-chain` explicitly disables that setup. An audit already requested at `offscreen` or `onscreen` is not split; those placements cannot be covered, and `onscreen` keeps its higher-fidelity screenshots. Before pickup clicks, both batch flows check the native page’s `document.visibilityState`; a hidden page produces one environmental step error naming occlusion and an actionable `--window onscreen` rerun, while retaining the existing post-click diagnostics for races.

### What was measured

One second of each, per placement, blurred as well as focused, because `dock-bounce-stop-only` blurs the window on purpose (`BrowserWindow.blur()` is `orderBack:` on macOS):

| placement | rAF focused | rAF blurred | timers/s blurred | `visibilityState` blurred | dpr | screenshot | the three scenarios |
|---|---|---|---|---|---|---|---|
| unset (shipped) | not measured | not measured | not measured | hidden (inferred: the bounce fires, so the daemon saw an inactive app) | 2 | 2560×1640 real | **3/3** |
| `hidden` | 121 | 0 | 6 | hidden | 2 | 2560×1640 **blank white** | **3/3** |
| `offscreen` | 76 | 76 | 220 | visible | **1** | 1280×820 real | 2/3 |
| `onscreen` | 121 | 121 | 208 | visible | 2 | 2560×1640 real | 2/3 |
| `hidden`, `KELPI_HARNESS_WINDOW_THROTTLE=0` | 121 | 121 | 220 | visible | 2 | blank | 2/3 |

The table is that measurement, and it was taken over the three scenarios that existed then. Its last column is now history: issue #109 replaced `dock-bounce-stop-only`'s wait-for-occlusion with a driven `harness.hide()`, and it passes 3/3 at every placement in the table (the `visibilityState blurred` column is unchanged, and still the reason the old shape could not work). `notification-shown-and-opened` (#67) came later: 20/20 at `hidden` and 20/20 at `offscreen`, which is the difference between it and `dock-bounce-stop-only`. Its preconditions are the daemon's suppression matrix (§7.1/§7.2 need `!isFocused || !isAppActive`, and it parks the agent's pane in a workspace that is not the active one), not the window's occlusion, so a placement nothing ever covers costs it nothing. It has not been run at `onscreen`, which takes the screen.

Two findings decided the design.

**The lane keeps Chromium's background throttling on**, which is the opposite of what the audit's lane does. Turning it off keeps the renderer at full speed while the window is buried, but Electron implements it by pinning the render widget out of the hidden state, so the page reports `visibilityState: 'visible'` for ever. The client reports exactly that to the daemon, the daemon's `isAppActive` is `presence().anyVisible`, and the stop-only dock bounce is gated on the app being *inactive* (agent-lifecycle §7.1). So a lane with throttling off tells the product that somebody is always watching, and `dock-bounce-stop-only` fails at *every* placement, `onscreen` included. A test lane that changes the thing under test is the mistake `audit-window.ts` rejects `hide()` and `minimize()` for; this is the same mistake in a quieter costume. `KELPI_HARNESS_WINDOW_THROTTLE=0` is there for a run that wants the audit's behaviour anyway, and so that "what does the flag buy?" stays a question you answer by running the scenarios twice.

**Throttling costs a scenario nothing**, which is why keeping it is free: a scenario waits from Node over CDP (`settle`, `settleDom`, `page.waitFor`), and `Runtime.evaluate` is answered by a throttled renderer as promptly as by a busy one. The audit needed the flag because its animation steps advance on double-rAF gates *inside* the page; nothing in a scenario does.

### No placement makes a blurred window look inactive (and what the scenario does instead)

A blurred window is not an inactive app. `BrowserWindow.blur()` is `orderBack:` on macOS, so the renderer only goes `hidden` when something is then in FRONT of the frame: never at `onscreen` or `offscreen`, where nothing ever covers it, and (measured on 2026-09-07, correcting the table above) not reliably at `hidden` either, because AppKit still counts a zero-opacity frame as visible. What used to decide it was whatever else happened to be on the machine's screen: `dock-bounce-stop-only` passed inside two daytime promotes on 2026-09-07 because the owner's own Kelpi window covered the harness frame, and failed 5/7 in every run that had nothing in front of it, on main included (issue #109).

So the scenario no longer waits for occlusion, it DRIVES the state: `harness.hide()` is `app.hide()` on macOS, exactly what ⌘H does, and it takes the window out of AppKit's visible set with nothing needing to cover it. It stays hidden across the notification and the stop (the whole window in which the daemon has to believe the app inactive) and calls `restore()` then `focus()` before it returns, so the sandbox is handed on as it was found. Measured after that change: 7/7 at `hidden`, `offscreen` and `onscreen`, with nothing covering the window in any of them.

The blur assertion stayed: window focus is the SHELL's half of the gate (`status.ts`) and hiding is not a substitute for it. What is still true of `onscreen` and `offscreen` is the fact underneath, so a scenario that wants an inactive app has to ask for one rather than assume the placement gave it one.

That is a property of those two placements, not a scenario bug and not a product bug, but it is worth noting that the daemon's "is anyone looking?" is the renderer's document visibility alone, so a window that is visible but not the frontmost app counts as active. `client/src/state/activation.ts` already distinguishes the two (`appActive && documentVisible`) for the client's own dwell timer; the daemon does not. Out of scope here, and left alone deliberately.

### No lane window is ever the key window (#109)

**The rule: a lane window (`hidden`, `offscreen`, `onscreen`) never becomes the key window on its own, and the machine's real keyboard never reaches it.** Every keystroke a lane delivers goes through CDP (`Input.dispatchKeyEvent` and friends), which the render widget answers directly and which needs no key status, so the window has nothing to gain from being key and one very expensive thing to lose by it.

What it used to lose. `hidden` paints the window at zero opacity and makes it click-through, and it was still shown with `show()`, which on macOS is `makeKeyAndOrderFront:` plus an app activation. Measured on the base tree at `--window hidden`, three questions answered from outside CDP:

| | before | after |
|---|---|---|
| frontmost app right after boot | `Electron` | the person's own app |
| `harness.focus()` with the person typing in TextEdit | took the key window: frontmost `Electron` | left it: frontmost `TextEdit` |
| a CGEvent keystroke posted the way a physical one arrives, while CDP typed `echo caret-ok` | `sh-3.2$ echstructoure caret-ok` → `sh: echstructoure: command not found` | `sh-3.2$ echo caret-ok` → `caret-ok` |

That is the machine's owner typing into an invisible test terminal while their own keystrokes vanish from wherever they thought they were typing, and it is the shape PR #113 recorded and could not attribute (`sh-3.2$ ortecho caret-ok`, `stctureecho caret-ok`), and the shape the phone program recorded as "`terminal-ls` can mangle its own typed fixture on a first run" (`cd <path>` arriving as ` to bcd <path>`).

Every lane placement is `focusable: false` now (`packages/shell/src/audit-window.ts` ▸ `auditWindowFocusable`), which on macOS makes the frame refuse key status, so AppKit has nowhere to route a key event even when the app is frontmost and `show()`, `focus()` and `Page.bringToFront` all stop being able to steal it. The window is shown with `showInactive()`. The shell's log line carries `focusable=` so the policy is checkable from outside the process.

What key status was buying is the page's own belief that it is focused, which the client genuinely reads (`TerminalPane.tsx` seeds `windowFocused` from `document.hasFocus()`, `chrome/attention.ts` gates on it) and which CDP key routing needs. The lane pays that back through `Emulation.setFocusEmulationEnabled` instead of through the OS, so **in the lane `harness.focus()` means "make the page believe it is focused" and `harness.blur()` the reverse**, rather than "make the OS window key". `driver.mjs` ▸ `boot` turns emulation on at boot and wraps the two ops; `audit.mjs` does the same for a placed audit run. Focus emulation does not touch `document.visibilityState`, so `harness.hide()` still drives the app inactive exactly as the section above describes.

`harness.window().focused` is `false` for the whole of a lane run and says so honestly. No scenario asserts `focused === true`; the two that read the field (`dock-bounce-stop-only`, `notification-shown-and-opened`) assert `focused === false`, which is the state a keyless window is already in.

The `default` placement (the on-screen full audit, and every user launch) keeps `focusable: true` and is unchanged: a visible window that could not be typed into would be a worse lie than the one this fixes. Measured: `fresh-boot,terminal-ls,terminal-cursor-focus` at the default placement is assertion-identical either side of the change, `terminal-cursor-focus`'s window-blur half included.

## The rule

**A change to a UI surface ships with a scenario (or an audit step) that exercises it against the real app, and `verify.mjs` runs it.** Unit tests pin the reducer; they do not press the key. The rule was social until it was not: #47, #53 and #55 were each fixed with unit tests alone, the promote's "full audit passed" never pressed what they changed, and all three shipped broken.

A UI surface is everything under `packages/client/src/` and `packages/shell/src/` (the client's rendered surfaces, and the main process that owns the menu, the accelerators, the native dialogs, the dock and the window). Documentation and this harness are never UI. A `SURFACES` entry in `verify.mjs` can add `ui: true` to claim a path outside those two trees. The decision is one pure module, `lib/verify-plan.mjs`, unit-tested under the root vitest's `harness` project.

**What verify does now.** On a diff that touches a UI surface it refuses, naming the files, unless one of these is true:

- a scenario **`covers`** the file (below), in which case verify RUNS that scenario;
- the diff writes or edits a scenario under `scripts/scenarios/` (untracked ones count: `git diff` cannot see a new file, so verify asks git for those separately), in which case verify runs it;
- the diff edits `audit.mjs`, i.e. it added an audit step;
- you opted out, out loud (below).

Both tiers run scenarios at `--no-build --window hidden`, so scenarios do not take the screen; the desktop lease still serializes shared clipboard and app state:

| tier | what runs |
|---|---|
| `verify.mjs` (impact-scoped) | the scenario files the diff touched, plus every scenario whose `covers` intersects the diff. Before the scoped audit, because a scenario is seconds and the audit is minutes. |
| `verify.mjs --full` | every scenario, after the shell tests and before the audit. `self-upgrade.mjs` runs `--full`, so this is on the path of every promote. |

Verify builds bundles before scenarios, which run `--no-build`; the audit also uses the content-hashed build cache, so unchanged bundles are reused.

### `covers`

A scenario names the source it drives, and verify re-runs it whenever that source moves:

```js
export const covers = ['packages/client/src/chrome/Sidebar.tsx', 'packages/shell/src/menu.ts'];
```

Entries are exact paths or directory prefixes (`packages/core/src/config/`), matched on path segments, so `chrome` never claims `chromeless.ts`. Without it the only scenarios a diff could select are the ones it happens to edit, which is the wrong set twice over: a `Sidebar.tsx` change would re-run nothing, and a scenario nobody touched would never guard anything again. Declare what the scenario actually presses, not everything it transitively depends on; the three scenarios here say why they chose theirs, in a comment above the export.

### The opt-out

```bash
node scripts/verify.mjs --no-scenario "why this change cannot be exercised"
```

The reason is retained in the unique acceptance report. `--no-scenario` permits diagnostic execution but leaves UI acceptance **unverified**; it cannot waive missing evidence. A reason is required.

## Strict acceptance and diagnostic retries

`verify.mjs` evaluates actual Vitest `testResults[].assertionResults`, audit `steps[].assertions` and step errors, and scenario `summaries[].results` (`label`, `ok`, `detail`). Summary counters must agree with those records. A frozen plan records the selected scenario files and order, audit steps, and Vitest files and full test names before execution. Each member declares required assertions and a minimum count; audit setup and visual-only steps explicitly declare their zero-assertion role. Missing members, reordered scenarios, empty asserting members and substituted assertion names cannot pass. Vitest collection includes a separate file inventory, so an empty selected test file is still required. Exit zero with a failed assertion, a harness error, or a cleanup leak fails acceptance. Missing, malformed, stale, empty, skipped or unsupported evidence is unverified. Failed takes precedence over unverified, which takes precedence over verified. Only verified exits zero; failed exits 1 and unverified exits 2.

The battery still runs independent checks to completion and retains diagnostic retries. A scenario failure replays the recorded prefix through the first failure in a fresh sandbox, then runs isolated diagnostics; original first-attempt artifacts remain intact. A failed first attempt stays failed even when its retry passes. Both attempts are recorded, and a failed build precondition leaves downstream checks unrun. Retry history describes ordering observations; it never changes acceptance. Vitest still caps workers at eight.

Each invocation owns `docs/audit/acceptance/<timestamp>-<uuid>/`: `acceptance.json`, `acceptance.md`, and `battery/` with raw first-attempt and retry reports and diagnostics. No previous invocation is deleted or read as an arbitrary “latest” result. Artifact paths and SHA256 digests, exact HEAD/reference commits, arguments, machine/runtime identity, and before/after Git status are retained. Dirty or untracked source prevents commit acceptance. A report-writing failure is fatal: Markdown and a hashed completion receipt are written before the final authoritative JSON; publication requires all three unchanged outputs and the final artifact manifest. `--plan` writes no acceptance report and exits 2; no-op runs also remain unverified.

Harness changes run their actual registered harness unit tests. A scoped green test run is useful local evidence, but it does not establish an original incident fix without a concrete regression receipt. Smokes without a supported structured assertion reporter currently leave acceptance unverified even when their process exits zero; this is an explicit remaining evidence gap.

```bash
node scripts/verify.mjs --since <baseline-commit> --acceptance /absolute/incident-manifest.json
```

### Incident evidence contract (version 1)

A reviewable manifest names the behavior and exact assertions. `scope: "synthetic-probe"` is supported as an honest limited claim and cannot establish original incident acceptance. Surface `covers` declarations only select checks; they do not prove an incident was reproduced.

```json
{
  "schemaVersion": 1,
  "incidents": [{
    "id": "issue-123-copy",
    "behavior": "Copy places exactly the selected terminal text on the clipboard after the recorded preceding scenarios",
    "scope": "incident",
    "assertions": ["clipboard equals selected text"],
    "regressions": [{ "path": "/absolute/run/regression.json", "sha256": "<actual SHA256>" }],
    "requiredEnvironments": ["local"],
    "requiredVisuals": [],
    "visualSignoffs": []
  }],
  "auditVisualSignoffs": [],
  "scenarioVisualSignoffs": []
}
```

`regression` can name one receipt; `regressions` supports separate cases for multiple environments. Every case uses the exact baseline and candidate commits and the same immutable test/args within that case. An incident may explicitly declare `reference` as a full baseline commit when its bug was introduced after the run-wide baseline; otherwise it inherits the run reference. Completion cannot change that baseline, and public summaries preserve each receipt’s actual baseline. Relevant environment kinds are `local`, `installed-tailscale`, `remote-codex`, `safari`, `physical-phone`, and `native-ime`. Both sides of each required environment case identify the actual environment with `{id, kind, details}`. For non-local kinds this label alone is unverified: `environment.evidence` requires the exact `head`, `sessionId`, `buildDigest`, `operator`, hashed `facts`, and an independent `review`. Facts are retained JSON artifacts with those same identity fields and a role of `build`, `session`, or `device`; remote kinds also need `transport`, and physical-phone/native-ime need `native-events`. Build facts bind nonempty output hashes; session facts name a live non-emulated driver; device facts identify hardware, OS/version and non-virtual status. Safari requires Safari/WebKit/version; physical-phone requires a native-device session on phone/tablet hardware; remote transports require distinct peers and a connection identity; native-event facts require actual trusted events and native IME composition where relevant. The reviewer must differ from the operator, attest independently after the session, and bind the exact fact-list digest and build/session/head. The gate checks reproducible corroboration, not resistance to an administrator fabricating every fact. Local loopback, emulation, CDP, or synthetic IME events cannot substitute for a required real environment. Requirements are review inputs: reviewers must name all environments relevant to the incident; a validator cannot infer incident scope from prose.

An incident visual signoff is `{id, head, runId, regression:{path,sha256}, reviewer, at, verdict:"passed", artifacts:[{path,sha256}]}`. Audit visual signoffs additionally require `runId` matching the actual raw audit run, `id` matching its step, review time after execution, and digests for every screenshot for that step. Scenario signoffs live in `scenarioVisualSignoffs` and additionally bind `report:{path,sha256}` to the exact raw attempt, with `id` matching a frozen visual requirement such as `plugin-terminal-geometry:shot:terminal-lab-owns-its-box`. The recorder retains each screenshot’s path, SHA256, label, placement and blank-window flag, plus structured requirements derived from existing `EYES` notes or `rec.eyes(reason)`. Every required screenshot must belong to the original run’s retained artifact manifest and signoff. Scenario approval requires onscreen captures or the prospectively declared native-focus default-window proof described below; hidden, offscreen, absent, changed, uniform or unsupported PNGs remain unverified. Reviews must follow execution, identify the reviewer and cover the actual image content. A fresh visible run is necessary when the original captures were hidden; a signoff cannot replace those bytes. Missing/failed reviews cannot be waived. Keep reviewer identities and all raw clipboard/environment diagnostics private unless intentionally sanitized for publication.

### Execute identical regression evidence

Supply two explicit clean worktrees and one self-contained Node test. The runner retains immutable source, arguments, runner identity, raw assertion reports, stdout/stderr, and clean commit snapshots for both attempts. It does not modify either worktree or switch branches. Runner sources carry distinct roles and expected module paths for the entrypoint and each gate dependency; duplicate unrelated artifacts cannot replace them.

```bash
node scripts/acceptance-regression.mjs \
  --baseline /absolute/original-worktree --candidate /absolute/fixed-worktree \
  --test /absolute/incident-test.mjs --assertions 'clipboard equals selected text' \
  --out /absolute/private-evidence -- identical test arguments
```

The test runs with its working directory at each worktree and receives `KELPI_REGRESSION_ROOT` and a unique `KELPI_REGRESSION_REPORT`. It must write a JSON object with `schemaVersion:1`, `assertions:[{name,ok}]`, `errors:[]`, `environment:{id,kind,details}`, and `cleanup:{attempted:true,completed:true,errors:[],leaks:[]}`. Exit 1 means completed named assertion failure; exit 0 means success. A baseline crash, signal, config/import error, missing report, or absent named failure is unverified, not a reproduced bug. Candidate failures fail. Assertion sets must match between baseline and candidate. A runner receipt verifies only its recorded regression case, not PR acceptance.

The repository retains a reusable regression for the acceptance-gate defects themselves. It executes actual verifier/battery source bytes in a VM, substitutes only external I/O, and requires healthy structured controls before seven named adverse checks. This is evidence for gate behavior; it does not reproduce a pairing, Copy, or paste product incident. Use the final committed fixture bytes on both clean commits:

```bash
node scripts/acceptance-regression.mjs \
  --baseline /absolute/original-worktree --candidate /absolute/fixed-worktree \
  --test /absolute/fixed-worktree/scripts/ui-audit/fixtures/acceptance-regression.mjs \
  --assertions 'first-failure-survives-passing-retry,failed-audit-assertion-blocks-success,forged-audit-summary-cannot-erase-failure,forged-scenario-summary-cannot-erase-failure,cleanup-leak-blocks-success,missing-required-report-blocks-success,final-report-write-failure-is-fatal' \
  --out /absolute/private-gate-evidence
```

The fixture also accepts explicit `--repo` and absolute `--out` for exploratory runs. It requires the exact repository root, writes outside that source repository, and refuses an existing report. A mutable candidate pass is exploratory only; changing fixture bytes requires a new baseline/candidate pair.


After collecting missing receipts or reviewing screenshots, re-evaluate the explicit original run in a new retained directory:

```bash
node scripts/acceptance-report.mjs --root /absolute/candidate-worktree \
  --report /absolute/original-run/acceptance.json \
  --manifest /absolute/completed-manifest.json --out /absolute/private-evidence
```

Re-evaluation cannot erase original first failures or dirty execution. It checks artifact digests again and keeps the original report.

### First-failure diagnostics and replay

Scenario and audit reports carry top-level `provenance` with actual `head`, requested head, run ID, ISO start time, dirty files, tracked-diff digest and executed bundle/scenario hashes. Scenario checks preserve `summaries[].results[] {label,ok,detail}` and add `failureClass` (`product`, `fixture`, `harness`, `cleanup`) for failures. Per-summary `firstFailure` retains its check index, monotonic observation time and artifact paths. Audit checks retain `steps[].assertions[] {name,ok,detail}` with corresponding first-failure information.

A scenario report's `sequence.firstFailure` names the original index, selected file and preceding files. `--replay /absolute/original/results.json --through INDEX` runs that original prefix in a fresh sandbox; changed source, commit, bundle hashes, placement, attach/keep, replacement positionals and nonempty outputs are rejected. `replayOf` cites the preserved original. An instrumentation change needs a separately named comparison run and cannot be called equivalent replay.

Copy/paste recording arms before input. Passive 256-entry rings capture selection calls, document/element focus, visibility, user activation, terminal write/reset/replay activity and clipboard operation outcomes. First-failure JSON is frozen before cleanup; restoration is recorded separately. After an incident assertion, await `rec.flushFirstFailure()` before a later action changes selection, clipboard contents, focus or the renderer document; the capture is asynchronous even though the assertion is synchronous. Wrappers preserve original returns, promises and exceptions, and observer errors fail evidence as harness errors. Diagnostics never retry keys or repair selection/focus. Only exact allowlisted synthetic selection/clipboard strings are retained, capped at 160 characters; arbitrary content is redacted to length.

The recorder adds timing overhead and diagnostic selection reads. Renderer/process clocks provide local order, not a global total order; navigation can lose older document histories. Passing instrumentation cannot explain an earlier failure. Cleanup explicitly distinguishes shared-sandbox postconditions from standalone/dedicated state removed at awaited teardown. Loopback remote daemons, viewport emulation and CDP composition still do not certify installed Tailscale, remote Codex, Safari, physical phones or native OS IME.

### Exact-head publication

Prepare a sanitized Markdown/JSON preview; this makes only a read-only GitHub request to confirm the open PR still has the exact report HEAD:

```bash
node scripts/acceptance-publish.mjs --report /absolute/run/acceptance.json \
  --repo owner/repo --pr 123 --out /absolute/publication-preview
```

After publishing the sanitized report through an authorized workflow, add `--publish --target-url https://github.com/owner/repo/pull/123#issuecomment-123456` to send the `kelpi/acceptance` commit status. The command parses and hashes one report byte snapshot, rechecks that snapshot and retained artifact/completion digests, fetches the actual comment and verifies its PR association and byte-for-byte equality with the sanitized Markdown preview, then posts to the exact PR HEAD. Missing, stale or unrelated comments and report drift refuse publication. Public JSON and Markdown use generated component/incident/visual/run IDs, validated hashes and allowlisted environment kinds; arbitrary private labels never flow into either format. Canonical run IDs and resolved output containment prevent path traversal. Verified maps to success, failed to failure, and unverified to pending. A GitHub required-check policy is a separate repository setting. The publisher never uploads raw screenshots, clipboard content, local paths, environment identity, or diagnostic text.

## Where this stops

- **A native menu accelerator cannot be pressed from here at all** (#95, measured on this
  Electron). A CDP-injected key event has no backing `NSEvent`, and Electron's macOS handler for
  an unhandled key is `[[NSApp mainMenu] performKeyEquivalent:event.os_event]`, a message to nil
  for a synthetic event. A probe that pressed ⌘H and ⌘M through CDP with `document.body` focused,
  i.e. with nothing consuming them, left `harness.window()` at `visible: true, minimized: false`
  every time. `harness.press('Cmd+H')` is not a way round it either: it finds the row and calls
  its handler, and a macOS-native `role` row's work happens in Cocoa rather than in that click,
  so the app stays up. `menu()` reads the row and its accelerator, `hide()`/`minimize()` do the
  window call, and what happens between a chord and the accelerator is unreachable. A scenario
  about such a chord asserts the two ends: the row exists with that accelerator, and the page
  left the key un-prevented (`terminal-leaves-platform-chords.mjs`).
- The functional lane is scenarios only. The AUDIT is still one visible window per run: 107 of its 118 steps are `needs-eyes`, so a placement that costs the pictures costs it its product (`audit-window.ts` has that table; offscreen reproduced 113 of 118 steps and turned two green assertions red).
- A scenario that opens an external editor must write its fixture at the shared path `<sandbox.root>/scenario-external-editor` before it presses "Open in $EDITOR". The daemon resolves `$VISUAL`/`$EDITOR` through a login shell and caches the answer for its whole lifetime (`daemon/src/content/external-editor.ts`, CONT-086), so in one sandbox the FIRST scenario to open an editor decides the command string every later one gets. `plugin-authoring` used to name a script inside the temp directory it deleted on the way out, and `plugin-terminal-features`' press then ran a file that no longer existed — its third lane failure, red in every full lane and green alone (#205). Sharing the path makes the cached command run whichever scenario is running.
- A multi-scenario run checks a short post-condition after every scenario and NAMES the one that broke it: the active workspace, the phone's remembered place (`kelpi.phone.last-place`), any workbench slot still holding a plugin view, stray web panes and workspaces, an open Settings overlay, a lingering modal, whether the page still believes it is focused, the viewport, and the URL. It is an enforced cleanup failure — `⚠ scenario <name> leaked: <what>` in the log, per-scenario `leaked` and a top-level `leaks` array in `results.json`. It exists because three deterministic ordering failures were filed as load-sensitive flakes and laundered into passes by the battery's isolated retry for a fortnight (issue #205): a phone left on a shut-down remote host, an engine count leftover web panes could never reach, and a ⌘C that could not run because an earlier scenario had told the page it was not focused. A scenario on its own instance (`windowPlacement`) records `leaked: null`: its sandbox went with it, so there was nothing to check.
- Scenario code can still inspect hidden screenshots, but strict acceptance refuses visual signoff for hidden or blank captures and retains outstanding visual requirements.
- A scenario that needs an INACTIVE app has to drive the window there; no placement grants it. `harness.hide()` is the gesture (`app.hide()`, i.e. ⌘H), and a scenario that uses it restores the window before it returns because the battery runs every scenario in one sandbox. `dock-bounce-stop-only` is the worked example, and it now passes at all three placements (issue #109); before it, that scenario read the screen's weather and called it a product verdict.
- The channel sees the notifications the SHELL posts. The browser client's own `Notification` (`client/src/state/notifications.ts`) is a different presenter on the other side of CDP, and §7.5's two halves withdraw on different triggers; a scenario that wants the client's toast asserts on the page.
- The helpers in `driver.mjs` are copies of the audit's private ones, not shared with it. The audit can be pointed at the driver once the phone campaign stops touching `audit.mjs`.
- **The surface rule selects coverage; incident acceptance separately requires actual before/after assertions.** A `covers` entry is a claim by whoever wrote it, and nothing verifies the claim: once `confirm-dialog-keys` covers `Sidebar.tsx`, every future `Sidebar.tsx` change is discharged by it, including the ones it does not press. That is the same bargain the surface map already makes (maintained, not inferred), and it is why the PR still says which scenario ran and what it asserted.
- Discharging is per DIFF, not per file: one scenario written anywhere in `scripts/scenarios/`, or one edit to `audit.mjs`, satisfies the rule for every UI file in that diff. `verify.mjs` prints the files no `covers` entry names, so the gap is visible; it does not refuse on it.
- Untracked source is included in verification planning and prevents exact-commit acceptance until committed.
- Nothing runs the rule at commit or push time. It is a `verify.mjs` gate, which means it is on the promote path (`--full`) and on the path of anyone who runs verify, and nowhere else.
- The retry is per COMPONENT, not per check. A vitest run that dies without naming a failed file (a crash, a config error, an OOM-killed worker) has nothing to isolate, so it is not retried and it is not excused: the battery fails and the summary says the report named nothing. The full audit is not retried; the strict verifier reads its raw assertions and step errors regardless of process status.
- A green retry remains diagnostic evidence beside the failed first attempt. Investigating and fixing that failure requires a subsequent reviewed change; retries never authorize acceptance.

The shell-spawned-daemon phases in `smoke.mjs` and `packaged-smoke.mjs` use a fresh private owner channel (`KELPI_TEST_OWNER_PORT` / `KELPI_TEST_OWNER_TOKEN`). The daemon authenticates before startup and consumes these variables so panes and plugins cannot inherit the capability. The channel outlives the shell: the test still exercises the real detached spawn and bundled Node selection, and quitting the app still leaves its daemon running. Cleanup requests shutdown through that live channel; foreground test daemons queue that request (and catchable signals) until startup settles, then await their own resource cleanup. They acknowledge successful teardown explicitly, including startup failures after cleanup and cancellation before boot. Startup and teardown never run concurrently: a stuck startup retains the slot rather than allowing resources to appear after cleanup. Ordinary daemon launches keep their existing signal handling. Logs and PID files remain diagnostic evidence and never authorize a kill. The runner requires the teardown receipt, channel closure and process disappearance; PID reuse can conservatively block cleanup but cannot cause an unrelated process to be signalled. If a shell launch dies before ownership can be established, cleanup reports the unknown state and retains the desktop slot; it does not guess that no daemon was started. This includes partial startup before the channel handshake. An unresponsive owned daemon likewise retains the slot instead of inviting a recovery PID kill.

Direct helper subprocesses (including plugin development and document-watch CLIs, build/CLI probes) use `spawnDesktopHelper`, which registers them before the first await, refuses launches during cancellation, and shares one awaited stop with ordinary scenario cleanup. Fixture servers use `listenDesktopServer` for the same reason. A cancelled scenario's eventual `finally` is not the owner of these resources: the leaf scope stops them even when its cancellation race finishes first.

### Strict build and completion bindings

The strict verifier forces one core build before scenario/audit execution and records complete tracked-source input hashes, the source tree and diff digest, and every output file from all four core dist trees. It retains the build receipt and passes its path and SHA256 to child runners; observed runtime outputs must equal those bound build outputs. Runtime plugin builds use separate source/input/output bindings, including required runtime identities selected before execution. Missing or contradictory provenance remains unverified; cache existence alone cannot authorize strict acceptance. Local Node regression fixtures remain legitimate evidence for their declared gate scope, never physical or remote device evidence.

`acceptance-report.mjs` completes manifests additively: it retains every original incident, assertion, environment/visual requirement, receipt, failed review and attempt. New receipts and reviews may fill missing evidence; they cannot erase an observed failure or remove an original requirement. Original report and artifact bytes remain retained, and any original failed aggregate remains failed after completion.

Build-cache sidecars now use schema v2: stable pre-build input digests bind the actual output hashes, and legacy, altered or partial receipts force a rebuild. Replay requires complete matching source/build key sets and preserves plugin bindings captured after build and before each install. The recorder defaults to a bounded 1,024-event history; target availability and retained history are separate facts, and loss of required history makes diagnostics incomplete and fails the harness. These records do not establish native menu, bridge or PTY ordering, and do not resolve the historical Copy/paste cause.

The private cleanup fixture accepts `--root`/`--out` or its environment inputs and refuses output overwrite; the recorder regression separately targets the diagnostics defects introduced at its explicitly declared baseline. These bounded fixtures exercise harness behavior without claiming real desktop or device acceptance.

### Source contracts and reviewable strict runs

`node scripts/verify.mjs --since <baseline> --acceptance /absolute/manifest.json --scenario-window onscreen` runs the real strict verifier with visible scenario captures. Only `hidden` (the default) and `onscreen` are accepted. The execution plan freezes the choice and every scenario command, including retries, uses it. Obtain the desktop reservation before running; this option does not bypass it. Public summaries include sanitized scenario/audit visual counts and image hashes/placement, while requirement prose, reviewer identities and paths stay private.

The source planner freezes named successful assertion paths and source visual obligations before execution. Guarded early exits cannot certify full scenario completion; callback returns do not truncate the enclosing function. Literal loops expand into their actual names, and passing predicates select supported branches. Unknown dynamic names, loops, callbacks and excess path expansion leave the contract incomplete instead of substituting a one-check minimum. Setup and visual-only audit members remain explicit. The workspace-switch audit’s dynamic pane checks also feed one fixed-name aggregate that fails for any wrong pane or zero eligible terminals; this aggregate is required by its frozen plan.

The immutable `fixtures/review-gap-regression.mjs` adds six private Node regression cases for source-plan truncation, scenario and audit visual omissions, recorder rollback ownership and runtime output drift. Run the same bytes on both clean commits through `acceptance-regression.mjs`; mutable-source tests and synthetic PNG controls are development checks, not product or visual acceptance.


### Local incident fixtures

The `fixtures/` directory retains standalone product regressions for workspace deletion, Settings search, remote ordering, remote navigation trust, mirrored terminal panning and first-document renderer errors. Run the same immutable test bytes through `acceptance-regression.mjs` against two explicit clean worktrees. The local product fixtures force a build, retain every core dist file hash, tracked source hashes, native harness identity, post-boot renderer errors and owned teardown receipts. A boot that rejects before returning runtime handles leaves cleanup unverified and requires external inspection before another desktop run.

These fixtures exercise local private daemons and Electron. CDP input does not certify physical shortcuts, Safari, phone gestures or native IME. The Settings test retains passive pointer/focus/input order with bundled and real Settings Lab presenters. The pan test requires positive overflow and movement on both axes. Remote trust tests two private remote hosts, credential isolation, navigation, revocation and persistence over local transport; installed Tailscale and real remote Codex need separate evidence. The startup fixture tests known injected first-document faults and healthy controls, not an unrelated Copy failure in the same PR.

A receipt is evidence only for its named assertions and exact commits. Keep earlier failed attempts and their instrumentation identities: adding passive observers can alter timing. Running a fixture is not itself proof that a revision passes.

The audit cleanup planner recognizes only an awaited call to the exact imported `cleanupSteps` helper with statically proven, reachable receipt callbacks. Shadowed or unresolved helpers and unsupported control flow fail closed. Runtime cleanup receipts remain required. Phone emulation restoration is an explicit cleanup assertion; phone screenshots require visual review.

Copy/paste recording includes a redacted append-only Node event journal alongside bounded renderer history. Journal write loss and incomplete renderer history remain explicit. Observations of clipboard APIs and acquired bridge/PTY paths do not establish native menu dispatch, daemon receipt, kernel delivery or a cross-process total order. Instrumentation does not repair selection, focus or input.

### Verifying another exact product checkout

A reviewed harness can verify an older or independently developed product branch without copying harness files into that branch. Both checkouts must be clean, have their own workspace dependencies, and remain at their explicitly supplied commits for the entire run:

```sh
node /absolute/harness/scripts/verify.mjs \
  --target-root /absolute/product \
  --target-head <full-product-commit> \
  --harness-head <full-harness-commit> \
  --since <full-product-parent-commit> \
  --acceptance /absolute/incident-manifest.json \
  --scenario-window onscreen \
  --out /absolute/new-evidence-directory
```

The target supplies product source, tests, configuration, workspace packages, builds and runtime binaries. The harness supplies the verifier, scenario/audit/smoke entrypoints, helpers and reviewed assertion inventories. The frozen execution context records both canonical roots, commits, complete source manifests and their digests. Actual tracked bytes are compared with the commit, including edits hidden from `git status`; workspace links that resolve outside the target and linked build outputs are rejected. Existing generated core outputs are retained before a fresh build. Runtime boundaries and final completion recheck both identities, and publication names both commits. An attached application cannot establish this private-runtime contract.

The scenario catalog is selected from the target's scenario names and resolved to reviewed harness implementations. A target scenario missing from the harness makes acceptance incomplete. `lib/target-scenario-origins.json` retains the source origins of the additional issue scenarios. This mechanism does not certify a scenario merely because its `covers` list names a changed file: an incident manifest still requires the immutable before/after regression described in [the incident fixtures](../incident-regressions/README.md).

### Reviewed assertion inventories and smoke evidence

Static discovery is supplemented only by explicit reviewed contracts in `lib/assertion-declarations.json`. Each contract identifies its runner namespace, source file and member, and binds the source plus its discovered local helper graph and fixture files to exact SHA256 values. Its successful paths list every assertion label in execution order. A small set of source-controlled geometric alternatives can be represented as ordered segments; every segment must consume one entire declared alternative and the full report must be exhausted. Partial paths, dropped or extra receipts, reordered checks and source/helper drift remain incomplete. Structural parser errors and discovered visual requirements cannot be removed by declaring an exception. Repeated assertion prose receives deterministic, collision-safe occurrence identities.

The five shell smoke entrypoints emit structured assertions, the pre-execution selection, source/build observations, process status and actual desktop cleanup receipts when run by the verifier. Matching summary counters or an exit status of zero cannot replace a missing assertion, incomplete cleanup, runtime identity or required visual review. Signing-dependent packaged-smoke expectations are selected from the explicit signing environment before execution. All attempts remain in the retained report.

A scenario that needs the host document to own native focus declares `export const requiresNativeFocus = true`. The runner validates this as a boolean and creates a private focusable default window when a lane window cannot meet that precondition. The scenario checks host/frame/pane focus before clipboard mutation and flushes first-failure evidence immediately. These local CDP checks do not establish physical keyboard, native menu, Safari, phone or IME behavior; those environment requirements remain separate.

The same pinned harness evaluates a retained external-target report with `acceptance-report.mjs --root /absolute/product ...` and publishes it with `acceptance-publish.mjs`. Completion is additive: include new regression receipts and artifact-bound visual signoffs without replacing the original requirements or failed attempts. Keep original reports, retries and private environment facts intact. Public PR reports contain sanitized identities, result counts, missing environment kinds and artifact hashes; private paths, clipboard contents and device/session details remain in local evidence.

Incident visual signoffs identify the exact regression receipt (`regression: { path, sha256 }`) and its `runId`, candidate `head`, reviewer and review time. The review must occur after that run completes. Every signed image must be a retained candidate-side `visual` fact from that regression and decode as a nonblank PNG; text/log artifacts, baseline images and unrelated screenshots cannot satisfy a visual requirement.

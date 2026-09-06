# Driving Kelpi from a script or an agent

Three things live here, for three jobs:

| | what | when |
|---|---|---|
| `audit.mjs` | the regression battery: ~127 fixed steps of real gestures against a real window, with screenshots, run by `verify.mjs --full` and every promote | proving the app has not regressed |
| `lib/driver.mjs` | one import that boots or attaches to an instance and gives you the page, the shell's native surfaces and the helpers | testing the change you are making |
| `../scenario.mjs` + `../scenarios/*.mjs` | a runner and the scenarios written with the driver, one per behaviour | the same, as a repeatable file |

The audit measures. A scenario checks one thing, is written by whoever changes that thing, and runs against the tree that carries the change. Issues #47, #53 and #55 were fixed with unit tests only, because the only way to exercise them for real was to add a step to a 29,000-line file; the scenarios beside this README are what those fixes should have shipped with.

## Running a scenario

```bash
node scripts/scenario.mjs                      # every scenario, in a fresh sandbox (builds first)
node scripts/scenario.mjs confirm-dialog-keys  # one, by name, --no-build to skip the build
node scripts/scenario.mjs --keep <name>        # leave the sandbox up to poke at afterwards
node scripts/scenario.mjs --window hidden      # without taking the screen, and in parallel (below)
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
export default async function ({ page, harness, cli, sandbox, rec, d, sleep }) {
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
- `cli` is the sandbox's `kelpi`: `run(args, { env })` gives `{ code, stdout, stderr }`; `ok(args)` requires exit 0 and returns stdout. Pass `env: { KELPI_PANE_ID }` to speak as a pane.
- `rec.check(label, ok, detail)` is the assertion; `rec.note`, `rec.shot(page, label)`.
- `d` is the driver module: `PAGE` (the testid anchors), `settle`, `settleDom`, `domPaneIDs`, `clickPaneHeader`, `focusPaneBody`, `runInTerminal`, `openSettingsRoot`, `openSettingsTab`, `clickMenuItem`, `openSubmenu`, `clickSubmenuItem`, `openSidebarMenu`, `contextMenuRows`, `clickDialogButton`, `findMenuItem`.

Rules that keep scenarios honest: wait on a condition (`settle`, `settleDom`, `page.waitFor`), not on a sleep, except where the wait IS the assertion (a negative check needs a dwell). Prefer `data-testid` anchors; add one to the client rather than matching on text or CSS. A scenario that fails should say what it saw: pass the detail to `rec.check`.

## The native surfaces: the shell's harness channel

CDP reaches the client, which is a web page. The application menu, native accelerators, native dialogs and the dock are Electron main-process surfaces, and a scenario reaches them through a Unix socket the shell opens only when `KELPI_HARNESS_SOCKET` names a path (`packages/shell/src/harness.ts`; a user's shell never carries it and is byte-identical without it). `driver.boot` sets it; `dev-instance.mjs` sets it and prints the path.

| op | does |
|---|---|
| `harness.menu()` | the application menu as a tree: `{ id, label, accelerator, enabled, visible, type, role, checked, submenu }` |
| `harness.menuClick({ id })` or `({ path: ['View', 'Toggle Sidebar'] })` | fires that item's click handler as Electron would |
| `harness.press('Cmd+Alt+S')` | lands a native accelerator: clicks the first enabled item bound to it (Electron spellings normalised) |
| `harness.counters()` | `{ dockBounces, lastBounce, dialogs, lastDialog: { title, message, buttons, response } }` |
| `harness.armDialog({ response: 1 })` | the next native `dialog.showMessageBox` resolves with that instead of showing; one-shot |
| `harness.window()`, `focus()`, `blur()` | the main window's focus and bounds; the dock only bounces while it is unfocused |

Newline-delimited JSON on the socket, `{ id, op, ... }` in, `{ id, ok, result | error }` out, if you want to speak it without the driver.

## The functional lane: no screen, several at once

`--window hidden | offscreen | onscreen` places the scenario's window somewhere other than in front of you. Unset, nothing changes: the shell builds the window it has always built, and a run today is byte-identical to a run before the lane existed. The shell-side gate is two variables, `KELPI_HARNESS_SOCKET` (already set for every sandbox) **and** `KELPI_HARNESS_WINDOW`, read by `packages/shell/src/audit-window.ts`, which is where the audit's placement mechanics already lived; the audit's own `KELPI_AUDIT` gate is untouched and neither lane can open the other. A user's shell, a packaged build and every existing probe get the shipped window, pinned by `audit-window.test.ts`.

```bash
node scripts/scenario.mjs --no-build --window hidden                  # every scenario, no screen
node scripts/scenario.mjs --no-build --window hidden a & \
node scripts/scenario.mjs --no-build --window hidden b ; wait         # two at once, own sandbox each
```

Each run already gets its own run dir, socket, database and ephemeral ports, so parallelism was only ever blocked by the window. Measured on this machine: **four full runs at once, 4 × 23 checks, all green, each scenario at its serial time** (3.4 s / 1.7 s / 1.6 s per run against a 3.4 / 1.8 / 1.6 serial control). The results directory is stamped to the millisecond and disambiguated by pid, so parallel runs never write over each other.

**Safe for**: everything a scenario asserts, which is DOM state, CDP input, the CLI, the harness channel's menu / accelerators / dialogs / dock counters, and the app's own activity signalling. **Not safe for**: anything that measures pixels. Under `hidden` a screenshot comes back blank white (`Page.captureScreenshot` composites the window's alpha), under `offscreen` it comes back at half resolution with sub-pixel geometry quantised differently. `rec.shot` writes that caveat into the note it records, and `results.json` carries the placement, so a picture is never silently worth less than it looks. Pixel checks belong in the audit.

### What was measured

One second of each, per placement, blurred as well as focused, because `dock-bounce-stop-only` blurs the window on purpose (`BrowserWindow.blur()` is `orderBack:` on macOS):

| placement | rAF focused | rAF blurred | timers/s blurred | `visibilityState` blurred | dpr | screenshot | the three scenarios |
|---|---|---|---|---|---|---|---|
| unset (shipped) | not measured | not measured | not measured | hidden (inferred: the bounce fires, so the daemon saw an inactive app) | 2 | 2560×1640 real | **3/3** |
| `hidden` | 121 | 0 | 6 | hidden | 2 | 2560×1640 **blank white** | **3/3** |
| `offscreen` | 76 | 76 | 220 | visible | **1** | 1280×820 real | 2/3 |
| `onscreen` | 121 | 121 | 208 | visible | 2 | 2560×1640 real | 2/3 |
| `hidden`, `KELPI_HARNESS_WINDOW_THROTTLE=0` | 121 | 121 | 220 | visible | 2 | blank | 2/3 |

Two findings decided the design.

**The lane keeps Chromium's background throttling on**, which is the opposite of what the audit's lane does. Turning it off keeps the renderer at full speed while the window is buried, but Electron implements it by pinning the render widget out of the hidden state, so the page reports `visibilityState: 'visible'` for ever. The client reports exactly that to the daemon, the daemon's `isAppActive` is `presence().anyVisible`, and the stop-only dock bounce is gated on the app being *inactive* (agent-lifecycle §7.1). So a lane with throttling off tells the product that somebody is always watching, and `dock-bounce-stop-only` fails at *every* placement, `onscreen` included. A test lane that changes the thing under test is the mistake `audit-window.ts` rejects `hide()` and `minimize()` for; this is the same mistake in a quieter costume. `KELPI_HARNESS_WINDOW_THROTTLE=0` is there for a run that wants the audit's behaviour anyway, and so that "what does the flag buy?" stays a question you answer by running the scenarios twice.

**Throttling costs a scenario nothing**, which is why keeping it is free: a scenario waits from Node over CDP (`settle`, `settleDom`, `page.waitFor`), and `Runtime.evaluate` is answered by a throttled renderer as promptly as by a busy one. The audit needed the flag because its animation steps advance on double-rAF gates *inside* the page; nothing in a scenario does.

### `onscreen` and `offscreen` never look inactive

Neither is ever occluded (one is parked where nothing covers it, the other is on no screen at all), so a blurred window there still reports itself visible, the daemon still calls the app active, and no `attention-request` is ever broadcast. `dock-bounce-stop-only` therefore fails 2 checks at both, and it now says which: it asserts the precondition the daemon actually gates on (`document.visibilityState === 'hidden'`) as well as the one the shell gates on (window focus), with a detail naming the placement. Run it at `--window hidden`, or with no `--window` at all.

That is a property of those two placements, not a scenario bug and not a product bug, but it is worth noting that the daemon's "is anyone looking?" is the renderer's document visibility alone, so a window that is visible but not the frontmost app counts as active. `client/src/state/activation.ts` already distinguishes the two (`appActive && documentVisible`) for the client's own dwell timer; the daemon does not. Out of scope here, and left alone deliberately.

## The rule

A change to a UI surface ships with a scenario (or an audit step) that exercises it against the real app, and its PR says which one ran. Unit tests pin the reducer; they do not press the key. `verify.mjs` does not yet enforce this; until it does, the reviewer asks.

## Where this stops

- The functional lane is scenarios only. The AUDIT is still one visible window per run: 107 of its 118 steps are `needs-eyes`, so a placement that costs the pictures costs it its product (`audit-window.ts` has that table; offscreen reproduced 113 of 118 steps and turned two green assertions red).
- Nothing enforces the lane's caveat. A scenario can still take a screenshot under `--window hidden` and assert on it; the note says the pixels are worthless, and no code stops you.
- `dock-bounce-stop-only` cannot run at `--window onscreen` or `--window offscreen` (above). A scenario that needs an inactive app needs a window macOS agrees is not visible.
- Notifications are not counted yet: `new Notification(...)` is a class import and is not wrapped. The dock and dialogs are.
- The helpers in `driver.mjs` are copies of the audit's private ones, not shared with it. The audit can be pointed at the driver once the phone campaign stops touching `audit.mjs`.

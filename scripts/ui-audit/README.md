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
```

Against a dev instance you already have up (`node scripts/dev-instance.mjs` prints both values):

```bash
node scripts/scenario.mjs --attach <debugPort> --harness <state>/harness.sock <name>
```

Results go to `docs/audit/scenarios/<stamp>/results.json` with screenshots beside it. Exit code 1 if any check failed.

A sandbox is private: its own run dir, control socket, database and ephemeral ports, torn down at the end. It never touches the daemon or app you are using. It does open a real window on your screen, because a window nobody can see stops rendering (see `packages/shell/src/audit-window.ts` for the measurements); one scenario run at a time.

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

## The rule

A change to a UI surface ships with a scenario (or an audit step) that exercises it against the real app, and its PR says which one ran. Unit tests pin the reducer; they do not press the key. `verify.mjs` does not yet enforce this; until it does, the reviewer asks.

## Where this stops

- One real window per run, so scenarios are serial on one machine. The functional lane that could run hidden in parallel is not built yet (`audit-window.ts` measured offscreen at 113 of 118 steps reproduced, which is fine for assertions that do not measure pixels).
- Notifications are not counted yet: `new Notification(...)` is a class import and is not wrapped. The dock and dialogs are.
- The helpers in `driver.mjs` are copies of the audit's private ones, not shared with it. The audit can be pointed at the driver once the phone campaign stops touching `audit.mjs`.

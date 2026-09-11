# Chrome Lab

A build-free, UI-only replacement toolbar and status bar. Both use `window.kelpi.ui` and
receive their state from `onChrome`; there are no native imports or backend processes.

Start an isolated instance from the repository root:

```sh
pnpm install --frozen-lockfile
node scripts/dev-instance.mjs --state out/plugin-chrome-playground
```

In its Settings → Plugins, install the absolute path to `examples/plugins/chrome-lab`, then select **Chrome Lab
toolbar** for `topbar` and **Chrome Lab status** for `statusbar`. Keep using that instance's
CLI and socket so testing stays separate from your installed Kelpi. The
[development guide](../../../docs/plugin-development.md#start-a-private-instance) provides a
`kelpi_test` helper for an external terminal.

The toolbar provides physical sidebar toggles, layout selection, input synchronisation,
connection status, size control and the shared window command menu. The status bar shows the
focused directory/branch, Git changes, real system metrics and agent counts. Clicking an
agent count opens a shared quick pick and navigates to the chosen pane. Both retain other
plugins' live menu/item contributions, including their conditions and badges.

Window chrome belongs to the primary daemon. Selecting a remote workspace disables primary
layout/input/plugin actions; explicit agent navigation selects its primary-daemon target.
Remote-owned plugin panes cannot access another daemon's window chrome.

Settings, Plugins and Restart UI remain in the menu. The host keeps the native window buttons
and drag strip outside the plugin iframe. Disable Chrome Lab to restore native chrome;
enabling it restores your saved selections. From the checkout root, run
`kelpi_test plugin dev examples/plugins/chrome-lab --trust` while editing. Compatible retained
revisions are available in Settings → Plugins → Versions; reload restarts only installed bytes.

The contract and its limits are in [the chrome guide](../../../docs/plugin-chrome.md).
Validation: `node scripts/scenario.mjs plugin-chrome-features --window hidden`; use
`--window onscreen` for screenshots. See the [plugin roadmap](../../../docs/plugin-roadmap.md)
for overall progress and the [validation record](../../../docs/plugin-validation.md) for dated results.

# Layout Lab

A build-free, UI-only example of the root arrangement: a toolbar, a status bar and a bottom panel
that each declare their band height in the manifest, and render the window's arrangement commands
(Zen Mode, the three band toggles, Reset Window Arrangement) from the chrome snapshot.

First [prepare the source checkout](../../../docs/plugin-development.md#prepare-a-source-checkout),
then start an isolated instance from its root:

```sh
node scripts/dev-instance.mjs --state out/plugin-layout-playground
```

In its Settings → Plugins, install the absolute path to `examples/plugins/layout-lab`, then select
**Layout Lab toolbar** for `topbar`, **Layout Lab status** for `statusbar` and **Layout Lab panel**
for `panel.bottom`. The three bands come up at the 36, 22 and 180 px the manifest declares
(`bandHeights`); without a declaration they would be 44, 32 and 220.

- **Zen Mode** hides the toolbar, the status bar, the bottom panel and both sidebars, and gives
  the pane grid the window. Leave it with ⌃⌘Return, View ▸ Toggle Zen Mode, the palette, or the
  handle in the 8 px strip the host draws where the toolbar was.
- **Hide Toolbar**, **Hide Status Bar** and **Hide Bottom Panel** toggle one band each. A hidden
  band keeps this view loaded and tells it `visible=false`; the panel counts how often it was
  hidden without a reload.
- **Reset Window Arrangement** shows every band and leaves Zen Mode. It is also in Settings →
  Plugins → Workbench views, beside **Restore bundled views**.

The arrangement belongs to the window, not to this plugin: disabling Layout Lab puts the bundled
bars back at their own heights and leaves whatever you hid hidden. The strip, the chord, the menu
and Settings stay host-drawn whatever is selected.

The contract is in [the plugin guide](../../../docs/plugins.md#hiding-bands-and-zen-mode).
Validation: `node scripts/scenario.mjs plugin-root-layout --window hidden`; use
`--window onscreen` for screenshots. See the [validation record](../../../docs/plugin-validation.md)
for dated results.

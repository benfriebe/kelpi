# UI Lab

A build-free example of reactive native menu/header/status contributions, grouped settings,
editable shortcuts and shared window prompts. Its backend publishes a counter and action
conditions; its view uses the injected public SDK without access to the host DOM.

Follow the [private development setup](../../../docs/plugin-development.md#start-a-private-instance).
Run these commands from the checkout root using its `kelpi_test` helper:

```sh
kelpi_test plugin validate examples/plugins/ui-lab
kelpi_test plugin install examples/plugins/ui-lab --trust
kelpi_test plugin open example.ui-lab example.ui-lab.panel
kelpi_test plugin contributions --json
```

Click a native **UI Lab** item or press Ctrl+Alt+U to increment the counter. The panel's
**Disable actions** and **Hide items** controls update native items, menus and the shortcut.
Settings → Plugins exposes the Appearance and Behavior groups, including density and a
counter step from 1 to 10. The panel also demonstrates a quick pick, input, dialog and
actionable notification. The view can occupy a pane or the secondary sidebar.

Prompts belong to the primary workbench window; an embedded remote-owned view cannot present
them in another daemon's window. Closing or replacing the view cancels its pending prompts.
The counter and contribution state are volatile and restart with the backend; settings persist.

Run `kelpi_test plugin dev examples/plugins/ui-lab --trust` while editing. It applies changed
validated revisions. Reload restarts the installed bytes; Settings → Plugins → Versions
selects compatible retained code. The development guide explains packaging and recovery limits.

Run `node scripts/scenario.mjs plugin-ui-services --window hidden` for the interaction scenario,
or use `--window onscreen` for screenshots. See the [UI contract](../../../docs/plugin-ui.md),
[dated validation record](../../../docs/plugin-validation.md), and
[plugin roadmap](../../../docs/plugin-roadmap.md) for supported behavior and remaining work.

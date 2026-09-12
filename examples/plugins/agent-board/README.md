# Agent Board

A complete, build-free Kelpi plugin: background activity history, a live pane list, persisted
filter state, settings, and a button that creates a real terminal through the shared command
API. Its view supports panes, either sidebar, the bottom panel, workspace, toolbar,
status bar and Settings. Native document, terminal and browser replacements use their own contracts.

Follow the [private development setup](../../../docs/plugin-development.md#start-a-private-instance),
then run these commands from the checkout root using its `kelpi_test` helper:

```sh
kelpi_test plugin validate ./examples/plugins/agent-board
kelpi_test plugin install ./examples/plugins/agent-board --trust
kelpi_test plugin run example.agent-board.open
kelpi_test plugin run example.agent-board.history
```

Choose `Agent Board` in Settings → Plugins → Workbench views to replace a sidebar or another
slot. Use `kelpi_test plugin disable example.agent-board` to restore bundled views; enabling it
recovers the saved pane. Run `kelpi_test plugin dev ./examples/plugins/agent-board --trust`
while editing to install changed revisions. Reload only restarts the installed copy.
Compatible retained code is available through Settings → Plugins → Versions or `plugin rollback`.

Run `node scripts/scenario.mjs plugin-workbench --window hidden` for the Agent Board interaction
scenario, or use `--window onscreen` for screenshots. The
[validation record](../../../docs/plugin-validation.md) records dated runs and their source revisions.

This example is fully trusted code and runs on the daemon machine. See the
[plugin guide](../../../docs/plugins.md) for the API and execution model, the
[development guide](../../../docs/plugin-development.md) for packages and recovery, and the
[plugin roadmap](../../../docs/plugin-roadmap.md) for overall progress and remaining scope.

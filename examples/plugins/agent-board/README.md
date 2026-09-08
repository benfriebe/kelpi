# Agent Board

A complete, build-free Kelpi plugin: background activity history, a live pane list, persisted
filter state, settings, and a button that creates a real terminal through the shared command
API. The same view can occupy every supported placement.

```sh
kelpi plugin install ./examples/plugins/agent-board --trust
kelpi plugin run example.agent-board.open
kelpi plugin run example.agent-board.history
```

Choose `Agent Board` in Settings → Plugins → Workbench views to replace a sidebar or another
slot. Use `kelpi plugin disable example.agent-board` to restore bundled views; enabling it
recovers the saved pane. Reinstall this directory after editing it. Reload restarts the
installed copy.

This example is fully trusted code and runs on the daemon machine. See the
[plugin guide](../../../docs/plugins.md) for the API and execution model.

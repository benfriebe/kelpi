# Workbench Lab

A build-free example of custom panes, nested workbench containers, operation hooks, and
service providers using Kelpi plugin API version 1.

Start an [isolated development instance](../../../docs/plugins.md#try-the-example), then
install `examples/plugins/agent-board` and this directory through that instance's
Settings → Plugins. Workbench Lab declares Agent Board as a required dependency.

In **Workbench views**, choose **Workspace with tools** for the workspace placement. The
native pane grid appears beside a contributed Dashboard/Notes tab container. Each named
slot can be changed independently, and the Notes tab saves text in plugin storage.

The **Open Lab dashboard** command opens the same dashboard as a normal pane. Its shortcut
can be edited in Settings → Plugins. The dashboard uses typed SDK operations to list and
create workspaces. **Try the operation guard** demonstrates a before hook: only the example
name `Blocked by Workbench Lab` is refused. An after hook records allowed workspace creation
from CLI, native UI, and plugin callers.

Choose **Lab annotated files** under **Service providers** to try the replacement file
service. Dashboard reads gain a `[Workbench Lab]` prefix; the provider delegates actual
file access to the bundled implementation. Disabling Agent Board stops its dependent Lab
views/provider; enabling it restores the saved layout and provider selection.

Edit these files and install the directory again to update the running example. Reload
restarts the installed copy. See the [authoring guide](../../../docs/plugins.md) for the
container schema, API contracts, lifecycle behavior, and supported extension boundaries.

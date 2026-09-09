# Sidebar Lab

Two build-free replacements for the Workspaces and Inspector sidebars. They use only the
public `window.kelpi` SDK and run without a backend, dependencies, or host DOM access.

```sh
kelpi plugin install ./examples/plugins/sidebar-lab --trust
```

Use the CLI/socket from your isolated development instance. In **Settings → Plugins →
Workbench views**, choose **Sidebar Lab Workspaces** and **Sidebar Lab Inspector** on either
side. Both views also support pane placement:

```sh
kelpi plugin open example.sidebar-lab example.sidebar-lab.workspaces
kelpi plugin open example.sidebar-lab example.sidebar-lab.inspector
```

Workspaces supports live filtering by host/name/group/label, native or alphabetical order,
pane counts, connected remote workspace selection, and local workspace creation/renaming.
The filter and display preferences survive reloads and are shared between instances of the
same view on one daemon. Names and user data are rendered as text.

Inspector lists this daemon's workspace repositories and their status, refreshes Git data,
opens diffs, adds repository associations, and creates terminals in repository folders.
It also focuses/splits panes, sends an explicitly entered command to a selected terminal,
and reads its last 80 lines. Folder-path and repository-list preferences persist.

Window navigation can show connected hosts; mutation APIs still belong to the view's own
daemon. Remote rows provide selection, while creation/rename controls clearly name the owner.
If the window is viewing a remote workspace, the primary Inspector says which local daemon
it continues to inspect. A direct remote client manages that remote daemon as its own host.
A remote-owned pane embedded in another daemon's workbench cannot control that window's
navigation; it displays the unavailable capability and keeps its own daemon actions usable.

Storage belongs to the plugin on its owning daemon; local and remote preferences stay
independent. Hidden views pause refresh work. Errors remain visible so you can correct the
request or refresh the data; failed mutations are never retried automatically.
Disabling the plugin restores bundled sidebars; reenabling restores the selected views and
their preferences. After source edits, install the directory again; reload restarts the
installed revision.

The UI mounts into `#sidebar-root`, preserving document assets. Form buttons call SDK actions;
Enter is handled locally for single-line inputs, preserving the iframe's navigation restrictions.

This example demonstrates replacement features through the public API. Workspace deletion,
drag ordering, full settings, Git recovery flows, authentication, and terminal lifecycle
ownership continue to use Kelpi's existing controls and protocols.

The real interaction scenario is `node scripts/scenario.mjs plugin-sidebar-features`.

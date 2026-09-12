# Toolbar and status feature modules

Toolbar and Status join Workspaces and Inspector as registered bundled feature bindings.
Their rendering, status models, navigation lifecycle and toolbar command declarations live
under `packages/client/src/features`. `App.tsx` supplies the owning runtime and window
callbacks; `WorkbenchSlot` resolves the registered native binding or the selected plugin.
The same bindings work inside compatible named containers, with one native instance per host.

[Chrome Lab](../examples/plugins/chrome-lab) replaces both bars using only the public browser
SDK. It also renders other plugins' live menu and item contributions, so replacing the bars
preserves their extension points. No backend or application rebuild is required to install it.

The [plugin roadmap](plugin-roadmap.md) tracks the wider extension work. The
[development guide](plugin-development.md) covers authoring, packaging and retained versions.

## Try it beside your installed Kelpi

First [prepare the source checkout](plugin-development.md#prepare-a-source-checkout).
Then run from its root:

```sh
node scripts/dev-instance.mjs --state out/plugin-chrome-playground
```

Use its Settings → Plugins to install the absolute path to `examples/plugins/chrome-lab`.
Choose **Chrome Lab toolbar** for `topbar` and **Chrome Lab status** for `statusbar`. The instance has its own
state, configuration, sockets and Electron profile. An external terminal must use the
`KELPI_SOCKET` printed by the script, `KELPI_REQUIRE_SOCKET=1`, and this checkout's
`node packages/cli/dist/kelpi.js`; the development guide provides a `kelpi_test` helper.
Run `kelpi_test plugin dev examples/plugins/chrome-lab --trust` from the checkout root for
live editing. Settings → Plugins → Versions selects compatible retained revisions while
preserving the workbench's saved placements.

## Window chrome API

Browser views can read the current primary-daemon chrome model and subscribe to updates:

```js
await kelpi.ready;
const stop = kelpi.ui.onChrome(snapshot => {
    renderWorkspace(snapshot.workspace);
    renderSidebars(snapshot.sidebars);
    renderAgentCounts(snapshot.agents);
}, error => showUnavailable(error.message));
addEventListener('pagehide', stop, { once: true });

const shown = await kelpi.ui.getChrome();
if (shown.workspace && shown.ready) {
    await kelpi.ui.executeChromeCommand('kelpi.layout.select.tiled', {
        workspaceID: shown.workspace.id
    });
}
```

The standalone [SDK declarations](../packages/plugin-sdk/chrome.d.ts) define the complete DTO:

| Field | Meaning |
| --- | --- |
| `connection`, `ready` | Primary daemon transport and usable snapshot state. No connection URLs, tokens or raw connection error details. |
| `workspace`, `focusedPane` | Primary selection, layout, input sync and focused pane identity, directory, branch and agent status. |
| `sidebars.left/right` | Selected view ID/title and logical visibility on each physical side, including swapped native sidebars. |
| `sizeControl` | `unclaimed`, `this-window`, or `other-window`; no foreign client identifiers. |
| `commands` | Current command IDs, labels, enablement, checked state and menu sections. |
| `agents`, `agentPanes` | Global counts and explicit pane/workspace targets for the primary daemon's visible agent panes. |
| `git` | Focused pane's repository change counts using the native footer's path matching. |
| `systemStats` | Enabled metrics with native display formatting, or `null` until the daemon supplies a sample. An empty array means all metrics are hidden. |
| `items` | Current `workspace.header` and `statusbar` contributions, including text, badges, tooltips, tone, enablement and an optional command ID. |

The model stays alive when either native bar is replaced or a container tab is hidden. It
uses the existing daemon mirror, repository model and system sampler; replacements do not
start another Git poller or sampler. Public snapshots are copied and frozen. They include the
full message envelope within 256 KiB; oversized snapshots produce an explicit subscriber error.

Delivery is initial/latest state, with one outstanding acknowledged frame and one replacement.
Awaited callbacks apply backpressure. Each browser feed permits 64 listeners; unsubscribing
releases an awaited callback and cancels its queued delivery. Closing, failing or reloading a
view releases the host feed. This is window state, not the daemon event stream or a durable
replay log. A new window/view starts a new subscription. Navigation and chrome feeds have
independent sequence numbers and acknowledgements.

## Shared commands

Use IDs from the current snapshot, check `enabled`, and pass the displayed workspace ID for
workspace-scoped actions. The host validates current state again when invoked.

| Command ID | Target / behavior |
| --- | --- |
| `kelpi.layout.cycle` | Requires the currently selected `workspaceID`; uses its current focused pane. |
| `kelpi.layout.select.<layout>` | Same target; layout IDs come from `snapshot.layouts`. |
| `kelpi.input.toggleSync` | Requires the currently selected `workspaceID`. |
| `kelpi.sidebar.left`, `kelpi.sidebar.right` | Toggle the view host on that physical side. |
| `kelpi.inspector.toggle` | Toggle Inspector's native host, wherever placed. |
| `kelpi.window.takeSizeControl` | Request PTY geometry ownership for the invoking window; observe the subsequent model update. |
| `kelpi.pane.focus` | Requires explicit `workspaceID` and `paneID`; selects that primary workspace, reveals the pane and hands back the caret. |
| `kelpi.window.openPlugins`, `kelpi.window.openSettings`, `kelpi.window.openHelp`, `kelpi.window.openPalette` | Open the owning window's existing surfaces. |
| `kelpi.window.installCLI`, `kelpi.window.checkUpdates` | Discoverable only when a desktop shell is attached. |
| `kelpi.window.restartSocket`, `kelpi.window.restartUI` | Existing socket-server restart and renderer reload. Restart UI preserves daemon-owned panes and sessions. |
| `menu:<menu-id>`, `item:<placement>:<item-id>` | Opaque IDs returned in discovery; invoke the current contributed entry and recheck its visibility/enablement before dispatch. Pass the displayed `workspaceID` when one exists. |

Replacement desktop chrome should expose the enabled `kelpi.window.takeSizeControl` command
when `sizeControl === 'other-window'`. The bundled terminal may clip a larger owner's grid;
this gives the user a way to fit their window again. Observe the subsequent ownership update
before treating the request as effective. Native desktop and phone controls provide this
route; the desktop chrome API remains unavailable on phone.

Layout/input requests await their daemon command reply and reject failures; they never retry
a mutation. Other commands retain native dispatch semantics: a successful call does not mean
a shell update finished or size ownership changed. Restart UI may tear down the requesting
view before its promise settles. Unknown, unavailable, disabled or stale commands reject.
Native menu groups preserve their separators and existing recovery actions.

Native status navigation validates the destination and cancels its delayed caret handoff on
subsequent navigation or window disposal. It does not recreate the destination pane or PTY.

## Ownership and recovery

Chrome belongs to the primary daemon and viewing window. An embedded pane owned by a secondary
daemon receives an unavailable result instead of reading or changing another daemon's chrome.
A direct browser attachment to that daemon has its own primary chrome and preferences.
Backend/CLI calls cannot select an arbitrary attached window through this browser-only API.

`remoteWorkspaceSelected` reports when the primary grid displays a secondary daemon. Primary
layout/input and plugin contribution commands are disabled in that state. Explicit primary
agent navigation still selects its named workspace/pane. Chrome APIs never retarget a plugin's
files, terminals, storage or domain APIs to another daemon.

Replacement toolbar/status placements and chrome APIs apply to the desktop workbench. Phone
plugin panes keep their existing APIs; desktop chrome is unavailable there. Window controls,
the drag strip, authentication, pane ownership and recovery stay in the host. Settings and
Plugins remain accessible through keyboard commands even if a replacement fails. Disabling
or removing the plugin restores native bars while retaining preferred selections; reenabling
it restores the replacements. Ordinary plugin-view errors retain their local retry control.

That recovery floor is shared with the interaction presenters: `kelpi.window.openPalette`,
`openSettings`, `openPlugins`, `openHelp` and `restartUI` stay enabled whatever is selected for
the toolbar, the status bar, the palette or the prompts, and the native menu and their shortcuts
never route through a plugin. A palette or prompts presenter is selected in the same Workbench
views list and falls back to bundled the same way; see
[selectable interaction presenters](plugin-ui.md#selectable-interaction-presenters).

## Validation

Run `node scripts/scenario.mjs plugin-chrome-features --window hidden`. It uses private daemons to
exercise replacement controls, sidebar swaps, status navigation, Git/system data, other plugin
contributions, shared menus, multiple clients, remote ownership, reload and native fallback.
Feature, bridge, SDK, and native assembly tests cover the corresponding contracts. Use
`--window onscreen` for visual inspection; the [validation record](plugin-validation.md)
records dated runs against specific source revisions.

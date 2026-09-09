# Bundled features and replacement sidebars

Workspaces and Inspector are registered feature modules. The shell supplies their host
contracts; it no longer assembles either sidebar's JSX or implements their domain actions.
The [Sidebar Lab](../examples/plugins/sidebar-lab) example replaces both views using the
public browser SDK, without native imports, a backend, or access to the host document.

## Native feature contract

`packages/client/src/features/definitions.ts` contains pure view identities and placement
metadata. Discovery imports these definitions without starting subscriptions or importing
React implementations. A `BundledFeatureBinding` pairs a definition with a render function;
`WorkbenchProvider` accepts bindings and resolves them by identity. Duplicate bindings fail
explicitly.

The workbench passes visibility, physical side and the view picker to the selected binding.
It owns placement, container resolution and single-instance native ownership. A container
can wrap its host's native view, including in a retained hidden tab. It cannot instantiate
another host's feature or duplicate the same native view.

Workspaces has separate model, lifecycle and action contracts. Its lifecycle retains queued
reveal, create, rename and selection requests while the view is unmounted. Mounted chrome
publishes and clears its selection/Escape handles. Retained command callbacks resolve the
current mirror before choosing a workspace. Creation still uses reply IDs to activate and
reveal the new row; command failures use the host's error presentation.

Inspector owns repository reads, refresh triggers, graft subscriptions and repository
actions. Its model remains mounted while its view is closed or replaced: the footer and
workspace creation form also use that data. Repository actions use live workspace/focus
getters and report sheet errors without closing the form. The existing daemon operations
retain ownership of mutations, validation, persistence and Git orchestration.

These modules are bundled TypeScript components. Installed plugins continue to run through
the isolated iframe bridge and public SDK. Toolbar and Status also use registered feature bindings and a shared window command model;
see the [chrome feature guide](plugin-chrome.md). Native pane features still use their existing
adapters.

## Window navigation for plugins

The view-only navigation API exposes connected hosts and their workspace summaries:

```js
await kelpi.ready;
const snapshot = await kelpi.ui.getNavigation();
const owner = snapshot.hosts.find(host => host.kind === 'local');

const stop = kelpi.ui.onNavigation(
    next => renderWorkspaceList(next),
    error => showError(error.message)
);

// The same operation selects a workspace on the primary or a configured remote host.
const first = owner?.workspaces[0];
if (owner && first) await kelpi.ui.selectWorkspace(owner.id, first.id);
addEventListener('pagehide', stop, { once: true });
```

A snapshot contains `hosts` and `active`. Each host has an opaque window-local ID, display
name, `local`/`remote` kind, connection status and workspace rows. Rows contain ID, name,
color, pane count and optional group ID/name/color. `active` is a host/workspace pair or
`null`. Collapsed groups remain discoverable. Connection URLs, credentials, filesystem
paths and connection error details are excluded.

Host IDs survive ordinary updates and reconnects. Removing an entry or changing its name
or URL invalidates the old ID. Selection validates the host, workspace and connection before
changing the window. Local selections use the same activation, reveal and Git refresh path
as native workspace selection. Remote selections use the window's remote-workspace view.

`onNavigation` delivers initial state and coalesced updates. The bridge holds one outstanding
message and the latest replacement; it waits for acknowledgment before sending the next.
Unsubscription, failed views and unmounting release their subscriptions. Snapshots and their
message envelopes are limited to 256 KiB; oversized snapshots produce an explicit error
instead of an incomplete workspace list. Supply an error listener to show recovery UI; an
unhandled subscription error uses the normal plugin view failure display.

Navigation belongs to the primary workbench runtime. A remote-owned pane embedded in a
different daemon's workbench receives an unavailable error when requesting it. A client
connected directly to a remote daemon exposes that daemon as its local owner.

Navigation does not change the owner of `workspaces`, `panes`, `git`, `terminal` or storage
API calls. Those operations still target the daemon hosting the plugin. Sidebar Lab labels
this boundary when displaying remote navigation and keeps its local and remote preferences
independent.

## Validate locally

Start `node scripts/dev-instance.mjs --state out/plugin-playground` from this worktree, then
install `examples/plugins/sidebar-lab` through that instance's Settings → Plugins. Its CLI,
database, sockets and Electron profile are separate from the installed Kelpi application.
Select the example's Workspaces and Inspector views in either sidebar placement.

The interaction scenario is `node scripts/scenario.mjs plugin-sidebar-features`. Feature
tests live under `packages/client/src/features`; navigation and bridge tests live under
`packages/client/src/plugins` and `packages/plugin-sdk/tests`.

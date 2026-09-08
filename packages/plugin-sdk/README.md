# @kelpi/plugin-sdk

Public types, shared runtime helpers and the `getKelpi()` browser accessor for Kelpi plugin API version 1.
No React, Electron, or daemon-store imports are required. This workspace package is not yet
published to npm.

Kelpi injects `window.kelpi` before a plugin view's scripts load. The accessor returns that
same object; `await api.ready` waits for its private host channel. Backends receive a
`BackendAPI` in their exported `activate(api)` function and do not call `getKelpi()`.

See [the authoring guide](../../docs/plugins.md), [public types](index.d.ts), and the
[Agent Board example](../../examples/plugins/agent-board). Bundle dependencies and install
the resulting directory with `kelpi plugin install <directory> --trust`.

## Start a plugin

Using the CLI/socket of your isolated development instance:

```sh
kelpi plugin init ./my-board --id example.my-board --name "My Board"
kelpi plugin install ./my-board --trust
kelpi plugin open example.my-board example.my-board.home
```

The generated package needs no build and contains a pane/sidebar UI plus a backend command.
`init` works without a daemon and refuses existing directories. Install the directory again
after edits; `reload` restarts the installed copy without copying changed source files.

## Typed host operations

Browser views and backends share these helpers:

```ts
const workspace = await api.workspaces.create({ name: 'Review', color: 'blue' });
const pane = await api.panes.create({ workspaceID: workspace.workspaceID, name: 'Tests' });
await api.terminal.send(pane.paneID, 'pnpm test');
const output = await api.terminal.capture(pane.paneID, { scrollback: true, lines: 80 });
const associations = await api.git.status(workspace.workspaceID, { refresh: true });
await api.ui.reveal(pane.paneID);
```

The [domain declarations](domain.d.ts) describe workspaces, groups, panes, layouts, terminal
input/capture/search/sync, agent lifecycle reports/restart, repositories/worktrees/graft and
application settings. Inputs and results use camelCase (`workspaceID`, `paneCount`); list helpers
return arrays and mutation helpers unwrap the successful reply. Snapshots retain their daemon
state shape, including epoch/sequence. `agents.reportStart` reports lifecycle state; launching
arbitrary programs remains an explicit terminal or process operation.

`api.settings` belongs to the current plugin. `api.appSettings` reads/writes the daemon's
application settings, including appearance, profiles and native keybindings. The general
settings writer accepts only documented writable keys. Filesystem reveal acknowledges a
desktop reveal request; it needs an attached compatible desktop to produce a visible effect.

Scoped helpers prefer explicit options, then the live view/backend command context. This includes
`panes.create()`, `panes.list({scope:'current'})`, file opening, diffs and graft operations. A sidebar
with workspace context can create/list panes there; file and diff helpers use that workspace's
focused or first visible pane; `reuse:true` requires an actual caller pane or explicit `paneID`.
Terminal `search(workspaceID, action, options)` controls that workspace's find UI: toggle starts
on its focused pane, while set/next/prev operate on its existing search pane.
An empty source workspace or background call without the required
scope rejects with `CONTEXT_UNAVAILABLE`. These helpers do not silently redirect to the daemon's
last-active workspace. Raw `api.command` retains its explicit wire-field semantics.

Typed command helpers reject failures with `KelpiError` (`code`, `method`, `details`).
`COMMAND_FAILED` retains the original reply in `details`, including fields such as
`active_agents` or partial graft failures. `TRANSPORT_ERROR` means the host call rejected;
`INVALID_REPLY` means the daemon returned an invalid envelope. The raw `api.command(payload,
context)` remains compatible with the CLI/UI wire protocol and returns `{ok:false}` replies
unchanged. Fire-and-forget operations such as layout selection and group rename resolve when
dispatch is acknowledged; their existing daemon no-op semantics still apply.

## Hooks and service providers

Declare contributions in `kelpi.plugin.json`, then register them in the backend's `activate`:

```js
export function activate(api) {
    const guard = api.hooks.register('example.my-board.guard', invocation => {
        if (invocation.phase === 'before' && invocation.payload.name === 'protected') {
            return { allow: false, reason: 'This workspace is protected by My Board.' };
        }
        return { allow: true };
    });
    const provider = api.providers.register('example.my-board.files', {
        read: args => api.services.call('kelpi.files', 1, 'read', args, { provider: 'bundled' }),
        write: args => api.services.call('kelpi.files', 1, 'write', args, { provider: 'bundled' }),
    });
    return () => { guard(); provider(); };
}
```

For this example declare a `before` hook for `workspace-delete`, and a provider for the
`kelpi.files` version 1 service implementing both `read` and `write`. The complete contribution
schema, deadlines, ordering and failure behavior are in the authoring guide. Before hooks must
return an explicit allow/refuse decision; after hooks observe the result. Hook and provider
registration is backend-only.

`api.services.list()` returns versioned contracts, providers and `selectedProviderID` /
`activeProviderID`. `services.call(service, version, method, args, {provider?})` uses the active
provider unless explicitly overridden. `services.select(service, version, providerID)` persists
the selection; `null` clears it. The bundled files provider is also available through the
`bundled` call override, so a replacement can delegate without recursively calling itself.
`api.files.read/write` honor the selected provider. Plugin result dictionaries are passed through
unchanged, including keys containing underscores.

Browser views can read `api.ui.getWorkbench()` to discover current slots, views and active tabs,
then call `api.ui.selectView(slot, viewID)` or `api.ui.activateTab(containerID, slotID)` to build
their own workbench controls. The host validates compatible placements, container ownership and
the view's daemon context. These operations belong to the hosting UI and are absent from the
backend API. `api.onContext(listener)` delivers the initial view environment after `ready` and
then changes to workspace context, theme, visibility and saved state. It returns a disposer that
also cancels queued callbacks; hidden retained tabs do not relay host keyboard shortcuts or focus.

```sh
kelpi plugin services
kelpi plugin service-call kelpi.files read --args '{"path":"/tmp/example.txt"}'
kelpi plugin service-select kelpi.files example.my-board.files
kelpi plugin service-select kelpi.files default
```

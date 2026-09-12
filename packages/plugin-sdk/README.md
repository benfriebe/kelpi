# @kelpi/plugin-sdk

Public types, shared runtime helpers and the `getKelpi()` browser accessor for Kelpi plugin API version 1.
No React, Electron, or daemon-store imports are required. The checkout provides a standalone
npm artifact for projects outside the monorepo; packing it is separate from registry publication.

Kelpi injects `window.kelpi` before a plugin view's scripts load. The accessor returns that
same object; `await api.ready` waits for its private host channel. Backends receive a
`BackendAPI` in their exported `activate(api)` function and do not call `getKelpi()`.

See the [plugin reference](https://github.com/benfriebe/kelpi/blob/main/docs/plugins.md),
[roadmap](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-roadmap.md),
[public types](index.d.ts), and [native service contracts](services.d.ts).
Repository guide and example links below point to `main`; declaration links refer to files
included in this SDK artifact. The [Agent Board example](https://github.com/benfriebe/kelpi/tree/main/examples/plugins/agent-board)
demonstrates custom panes and general workbench placements.

## Start a plugin

Using the CLI/socket of your isolated development instance:

```sh
kelpi plugin init ./my-board --id example.my-board --name "My Board"
kelpi plugin validate ./my-board
kelpi plugin install ./my-board --trust
kelpi plugin open example.my-board example.my-board.home
```

The generated package needs no build and contains a pane/sidebar UI plus a backend command.
`init` works without a daemon and refuses existing directories. Select `--template sidebar`,
`document` or `browser` for a more specific starting point. Run
`kelpi plugin dev ./my-board --trust` in another terminal to validate and apply changed
revisions. Invalid edits and failed updates retain the previous working version; `reload`
restarts the installed copy without copying source changes.

Use `kelpi plugin pack ./my-board --out ./my-board.kelpi-plugin` to create a portable plugin
artifact, then install it with `kelpi plugin install ./my-board.kelpi-plugin --trust`.
The output must be outside the source directory and must not already exist. Packing does
not install the plugin or upload it anywhere.
`plugin history`, `plugin rollback` and Settings → Plugins → Versions expose retained builds.
The [development guide](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-development.md)
covers external projects and the private instance workflow.

## Install and verify the SDK artifact

The SDK's npm `.tgz` provides types and helpers; it is not a `.kelpi-plugin` package. From a
Kelpi checkout, create it in an existing destination directory:

```sh
npm pack ./packages/plugin-sdk --ignore-scripts --pack-destination /tmp
```

In your external plugin project, install the filename printed by `npm pack`, for example:

```sh
npm install /tmp/kelpi-plugin-sdk-0.1.0.tgz
```

Backend types compile with a Node-only TypeScript library configuration; view types also
require `DOM`. Bundle imported runtime helpers into your browser assets before packing the
plugin. A plain HTML view can use injected `window.kelpi` without an SDK runtime dependency.

From the Kelpi repository root, `pnpm --filter @kelpi/plugin-sdk test:package` packs the real
SDK, installs it into a temporary external consumer, and checks backend/view types and runtime
imports. It does not publish to npm. The
[validation guide](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-validation.md)
describes broader plugin lifecycle and UI checks.

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

## Terminal renderers

Native terminal replacements use the view-only `kelpi.terminal.attach` API. Its dedicated
binary feed acknowledges output only after the renderer consumes it and preserves the
daemon-owned process across swaps, reload and fallback. It also carries terminal modes,
presentation and host actions such as live selection and phone keys. See the
[terminal contract](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-terminals.md), [types](terminal.d.ts) and
[Terminal Lab](https://github.com/benfriebe/kelpi/tree/main/examples/plugins/terminal-lab). Existing terminal commands and watches
remain available to backend and ordinary pane plugins.

Replay frames currently contain bytes without the native replay grid, and terminal
presentation does not expose size ownership. A replacement therefore cannot yet reproduce
the bundled renderer's owner-grid mirroring through this API. Terminal Lab fits its own
measured box; see the [geometry limitation](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-terminals.md#replay-geometry-limitation)
and the planned SDK follow-up.

## Browser renderers

`kelpi.browser` exposes the owning daemon's native tabs, navigation, Find, favourites,
private mode, capture, inspection/batch tools and cookies. Watch invalidations include
native picker revisions. The view-only `browser.attach({element, onPresentation, onAction})`
places an existing native page in a measured slot and preserves its live session across
renderer swaps. Use `surface.setCovered(true)` for HTML popups over the native page, and
`surface.focus()` for local caret handoff. Remote controls can be available even when the
current window cannot display that daemon's native page. See the
[browser contract](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-browser.md), [types](browser-pane.d.ts) and
[Browser Lab](https://github.com/benfriebe/kelpi/tree/main/examples/plugins/browser-lab).

## Documents

Native document source is available through `api.documents.get/edit/save/setMode/refresh`
and `watch/unwatch`. Mutations require an observed revision and reject stale writes with
`DOCUMENT_CONFLICT`. Browser document renderers also use `stage` and `applyDraft` to preserve
each input outside their iframe before serialized writes. See the
[document contract](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-documents.md), [types](documents.d.ts) and
[Document Lab](https://github.com/benfriebe/kelpi/tree/main/examples/plugins/document-lab) for rendering, recovery and remote scope.

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
the selection; `null` clears it. Every bundled service accepts the `bundled` call override,
so a replacement can delegate without recursively calling itself. Plugin result dictionaries
are passed through unchanged, including keys containing underscores.

Built-in service calls infer their arguments and results from the [public service map](services.d.ts):

```ts
const branch = await api.services.call('kelpi.git', 1, 'getCurrentBranch', { repoPath: '/code/project' });
// branch: string | null
const status = await api.services.call('kelpi.git', 1, 'getStatus', { repoPath: '/code/project' });
if (status.kind === 'dirty') console.log(status.changedFiles);
const output = await api.services.call('kelpi.process', 1, 'exec', { file: 'git', args: ['--version'] });
const rendered = await api.services.call('kelpi.content.render', 1, 'render', {
    kind: 'markdown', source: '# Hello', backgroundColor: '#181818', fontSize: 14, assetBase: null,
});
```

`kelpi.git@1` replaces the daemon's Git primitives used by repository discovery/status,
worktree commands, graft, and diff generation. The high-level `api.git` helpers continue to
run normal Kelpi commands with their existing workspace and state guards. The low-level
service takes explicit repository/worktree paths and returns direct values, with `null`
for successful mutation methods. It does not create workspace records for the caller.

`kelpi.content.render@1` replaces HTML generation for native Markdown and diff previews.
The native editor, source buffers, file watches, save lifecycle, and frame ownership remain
with Kelpi. `kelpi.process@1` backs managed `api.process.exec`; `kelpi.files@1` still backs
`api.files.read/write`. Neither service redirects arbitrary Node calls, terminal processes,
or all internal file access. See the [service guide](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-services.md) for native
reach, limits, fallback behavior, and the complete Git method catalog.

For provider authors, `BuiltinProviderMethods<'kelpi.content.render'>` describes a complete
implementation. An explicit type argument on registration checks the same contract:

```ts
api.providers.register<'kelpi.content.render'>('example.my-board.renderer', {
    render: args => api.services.call('kelpi.content.render', 1, 'render', args, { provider: 'bundled' }),
});
```

Declare the matching provider, version, and complete method list in the manifest. Registration
typing does not change runtime discovery. Custom contracts still use
`services.call<MyResult>('example.my-board.catalog', 1, 'read', args)` and generic JSON handlers.

Browser views can read `api.ui.getWorkbench()` to discover current slots, views and active tabs,
then call `api.ui.selectView(slot, viewID)` or `api.ui.activateTab(containerID, slotID)` to build
their own workbench controls. The host validates compatible placements, container ownership and
the view's daemon context. These operations belong to the hosting UI and are absent from the
backend API. `api.onContext(listener)` delivers the initial view environment after `ready` and
then changes to workspace context, theme, visibility and saved state. It returns a disposer that
also cancels queued callbacks; hidden retained tabs do not relay host keyboard shortcuts or focus.

`api.contributions.get/update` reads and atomically patches the current plugin instance's
volatile context and native item overrides. Browser views also have `ui.showQuickPick`,
`ui.showInput`, `ui.showDialog` and `ui.showNotification`, returning the user's choice or null
on cancellation. These prompts belong to their attached view and hosting window. See the
[UI guide](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-ui.md), [types](ui.d.ts), and [UI Lab](https://github.com/benfriebe/kelpi/tree/main/examples/plugins/ui-lab)
for conditions, grouped settings, scope and lifetime rules.

```sh
kelpi plugin services
kelpi plugin service-call kelpi.files read --args '{"path":"/tmp/example.txt"}'
kelpi plugin service-select kelpi.files example.my-board.files
kelpi plugin service-select kelpi.files default
```


## Toolbar and status replacements

Browser views can use `ui.getChrome()` / `ui.onChrome(listener, onError)` to read the owning
primary desktop window's layout, physical sidebar visibility, connection, agent counts, Git
status, metrics and live contributions. `ui.executeChromeCommand(id, target?)` invokes the
same current command registry as native chrome. Pass the displayed `workspaceID` for layout,
input and contributed actions so stale targets reject explicitly.

The [chrome guide](https://github.com/benfriebe/kelpi/blob/main/docs/plugin-chrome.md) documents the full contract and ownership
rules. [Chrome Lab](https://github.com/benfriebe/kelpi/tree/main/examples/plugins/chrome-lab) replaces both bars without a backend.

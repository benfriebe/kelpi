# Kelpi plugins

Plugins can add custom panes, replace workbench views, register commands, and run background
code on the daemon machine. They install independently of the Kelpi application build.
Plugins can also define nested UI containers, guard commands, and supply versioned services.
They can contribute conditional menus and native status/header items, publish live context
and badges, group settings, and present shared prompts and actionable notifications. The
[UI contribution guide](plugin-ui.md) and [UI Lab](../examples/plugins/ui-lab) cover these APIs.
The included [Agent Board](../examples/plugins/agent-board) uses the same HTML view as a pane,
sidebar, inspector, bottom panel, workspace, toolbar, status bar, or settings view.

This is the first implementation of the [extensibility audit](plugin-extensibility-audit.md).
The supported contract is **plugin API version 1** and **Kelpi protocol generation 2**.

## Try the example

To test this checkout beside your existing Kelpi, start an isolated instance from the
worktree root:

```sh
node scripts/dev-instance.mjs --state out/plugin-playground
```

It builds this tree and uses its own database, sockets, ports, configuration, and Electron
profile. Ctrl-C stops that instance; the named state directory survives for your next test.
Install examples through its Settings → Plugins, or run its CLI from one of its terminal
panes. An external terminal must use the `KELPI_SOCKET` printed by the script and this
checkout's `node packages/cli/dist/kelpi.js`, so commands reach the test instance.

From a checkout with the new daemon and CLI built and running:

```sh
kelpi plugin install ./examples/plugins/agent-board --trust
kelpi plugin list
kelpi plugin run example.agent-board.open
kelpi plugin run example.agent-board.history
```

You can also install a local directory or `.kelpi-plugin` file in Settings → Plugins. The source must exist on
the **daemon machine**, including when using Kelpi from another device. Installation requires
an explicit trust acknowledgement. Paired device credentials can use installed plugins;
installing, removing, enabling, disabling, or reloading them requires the daemon owner.

Use **Settings → Plugins → Workbench views** to choose **Workspaces**, **Inspector**, or an
installed plugin on either side. To put Inspector on the left and Workspaces on the right,
set **sidebar.primary** (left) to **Inspector**; the two built-in views trade sides in one
action. Setting **sidebar.secondary** (right) to **Workspaces** does the same. Choosing
Workspaces on the left restores their original arrangement. Inspector and plugin headers
also have a view picker; the Workspaces filter keeps its full width without a picker beside it.

The built-in views keep their width, controls, and keyboard shortcuts when they move.
Workspaces resizes from the edge nearest the pane grid on either side. Each built-in view
has one host; selecting a view already on the other side exchanges the two views when their
placements permit it. Plugin views can still appear on both sides. Plugin sidebars retain
their header picker and **Manage plugins…** shortcut. Choices survive window reloads.

[Sidebar Lab](../examples/plugins/sidebar-lab) provides dedicated Workspaces and Inspector
replacements, including connected-daemon navigation, repository tools and persisted display
preferences. Install `./examples/plugins/sidebar-lab` to try it. The
[feature guide](plugin-features.md) explains the native module contract and navigation scope.

Settings → Plugins → Workbench views also lets you change the other placements.
The default views are registered native adapters; external contributions use the same slot
selection and fallback rules. Preferences belong to the client and stable daemon identity.
If a plugin is missing, disabled, or its backend fails, the workbench restores the bundled
view. The preferred selection remains saved, so enabling the plugin restores it. The Plugins
management controls and “Restore bundled views” remain reachable through Settings and the
command palette even when a custom view replaces the workspace or top bar.

Plugin panes participate in normal splits, moves, zoom, parking, and close/reopen. They retain
their descriptor and JSON state when the plugin is missing, disabled, updated, or removed.
Parked plugin panes also survive daemon restarts. A missing plugin never spawns a terminal.

[Chrome Lab](../examples/plugins/chrome-lab) replaces the toolbar and status bar using live
window chrome state and the shared command registry. It preserves other plugins' menu/item
contributions. See the [chrome feature guide](plugin-chrome.md) for commands, status data,
ownership and the isolated development workflow.

[Document Lab](../examples/plugins/document-lab) replaces Markdown, Scratchpad and Diff bodies
while preserving their native pane IDs and buffers. The [document guide](plugin-documents.md)
covers shared SDK/CLI source APIs, guarded revisions, renderer selection and pending-input
recovery, including remote and phone views.

## Package format

The [development guide](plugin-development.md) covers templates, live editing, portable
artifacts and version controls in Settings using a private instance.

Start a build-free local package with `kelpi plugin init ./my-plugin --id example.my-plugin`.
This command works offline without a daemon and refuses to overwrite an existing directory.

Validate the source and create a portable artifact without executing its code or contacting
a daemon:

```sh
kelpi plugin validate ./my-plugin --json
kelpi plugin pack ./my-plugin --out ./my-plugin.kelpi-plugin --json
kelpi plugin validate ./my-plugin.kelpi-plugin --json
kelpi plugin install ./my-plugin.kelpi-plugin --trust
```

Validation checks API compatibility, manifest declarations, entry files, portable paths,
and package limits. The report includes the manifest version, dependencies, content revision,
and each file's size and SHA-256 digest. Installed dependency availability is checked by the
daemon, rather than by offline validation. Validation never runs the backend or proves that
its code works.

The version 1 `.kelpi-plugin` format is gzip-compressed JSON containing canonical, sorted
paths and base64 file bytes. Packing the same bytes produces the same artifact, independently
of source timestamps or directory enumeration order. The embedded revision is checked when
reading it; this detects corruption, but is not a signature or a trust decision. Package output
must be outside the source directory and must not already exist. Symlinks, special files,
path traversal, case/Unicode aliases, and file/directory collisions are rejected. Both directory
installs and artifact installs use the same validation and content identity.

Ship prebuilt, self-contained JavaScript and browser assets:

```text
my-plugin/
  kelpi.plugin.json
  backend.mjs          optional Node backend, outside ui/
  ui/
    index.html
    app.js
    style.css
```

```json
{
  "id": "acme.dashboard",
  "name": "Dashboard",
  "version": "1.0.0",
  "apiVersion": 1,
  "trust": "full",
  "backend": "backend.mjs",
  "activation": "startup",
  "contributes": {
    "views": [{
      "id": "acme.dashboard.board",
      "title": "Dashboard",
      "entry": "ui/index.html",
      "stateVersion": 1,
      "placements": ["pane", "sidebar.primary", "panel.bottom"]
    }],
    "commands": [{
      "id": "acme.dashboard.open",
      "title": "Open Dashboard",
      "shortcut": "super+shift+b",
      "menu": "both"
    }],
    "settings": {
      "showIdle": { "title": "Show idle panes", "type": "boolean", "default": true }
    }
  }
}
```

IDs use lowercase dot-separated namespaces; contribution IDs start with the plugin ID.
`kelpi.*` is reserved for bundled features. Commands and views must have unique IDs.
Settings support string, number, or boolean defaults. Declared backend commands must match
the commands registered during activation.

Supported placements are `pane`, `sidebar.primary`, `sidebar.secondary`, `panel.bottom`,
`topbar`, `statusbar`, `workspace`, `settings`, `document.markdown`, `document.scratchpad`, and
`document.diff`, `terminal`, and `browser`. A view can support several placements. Document, terminal and browser placements accept isolated
views, not containers. Workbench chrome placement controls apply to the desktop layout.
Plugin panes and document, terminal and browser renderers also work in phone and secondary-daemon workspaces.
Browser controls target the owning daemon; native page display requires its Electron host window.
Native window controls, layout/focus ownership,
authentication, and recovery controls remain part of the application kernel.

`startup` activates a backend when the daemon starts, with no UI required. `on-demand`
(the default) activates when a view attaches or a declared command runs. Backends remain
active until disabled, reloaded, removed, replaced, or the daemon stops. View instances have
independent lifetimes. Background work that must outlive a pane belongs in the backend.

The installer validates the manifest and entries, rejects symlinks, copies the exact package
bytes, and gives that revision a SHA-256 identity. It skips `.git` and `node_modules`.
Bundle dependencies into your backend and UI before installing. Limits are 32 MiB and 2,000
files per package, 100 installed plugins, and 100 contributions per contribution array.
Portable paths are limited to 512 UTF-8 bytes in total and 255 bytes per component.

Reinstalling a package first installed by the older directory-only installer may assign a
new revision to identical files because the new hash uses a portable path order. Existing
installed packages and saved panes remain usable.

To apply edits, build the source directory and **install it again**. Installation switches
the selected revision and refreshes attached views. `kelpi plugin reload <id>` restarts the
installed copy; it does not copy edits from the original directory. Plugin data and settings
survive reinstall and removal.
Reinstalling the same healthy revision is a no-op; use `reload` when you want to restart it.
For continuous development, `kelpi plugin dev <directory> --trust` validates and applies
stable changed revisions. It keeps watching after invalid edits or failed updates.

## Updates and recovery

Inspect retained revisions and switch back using their full content identity:

```sh
kelpi plugin history acme.dashboard --json
kelpi plugin rollback acme.dashboard
kelpi plugin rollback acme.dashboard --revision <full-sha256-from-history>
```

Without `--revision`, rollback selects the most recently selected other revision. An explicit
revision can select either an older or newer retained version. Version strings are labels;
two builds with the same version can contain different bytes. History reports the current
selection, original installation time, and compatibility problems for each entry. Up to 100
recently selected revisions are retained in the registry. Older package directories are not
automatically deleted. On upgrade from the old installer, history begins with the currently
selected revision; untracked older directories are not automatically trusted as history.

Before changing a plugin, Kelpi checks contribution ownership, required dependencies and
enabled dependents, and saved state. A revision that removes a saved view or cannot read its
saved `stateVersion` is refused. This covers open, parked and recently closed plugin panes,
and retained state for native document, terminal and browser renderers. Higher state versions
must be handled by the plugin when its view attaches; Kelpi does not invent state migrations.
After a view writes a newer state version, rolling back to code that declares an older version
is blocked, with the saved state retained.

An enabled backend update is checked for activation before the new selection is committed.
An inactive on-demand backend is probed, then stopped after a successful update; its first
installation remains lazy. Startup and already-running backends stay active.
If activation fails, Kelpi restores the previous revision and restarts it when necessary.
Plugin storage and settings writes during this provisional activation are held until it
succeeds; a recovery journal handles a daemon interruption during their commit (it does not
provide a power-loss durability guarantee). Opening panes or
writing pane state from provisional activation is refused; perform those operations after
activation, such as from a registered command or attached view.

Revision switching preserves pane IDs, descriptors, saved state, and native terminal/browser
sessions. It restarts plugin code and remounts its views. Selecting an older revision does
not rewind data written by a previously successful version. Full-trust code can also change
external files, processes and services; revision recovery cannot undo those effects.

## Backend and view APIs

The [SDK declarations](../packages/plugin-sdk/index.d.ts) are standalone and do not import
Kelpi's internal stores or React types. The SDK package is available in this workspace as
`@kelpi/plugin-sdk`; it has not been published to a package registry.

To use it from a project outside this repository, create and install its npm artifact:

```sh
# From this checkout; choose an existing destination directory.
npm pack ./packages/plugin-sdk --pack-destination /tmp
# From your external plugin project.
npm install /tmp/kelpi-plugin-sdk-0.1.0.tgz
```

Bundle imported SDK runtime code with your browser assets before packaging. A build-free view
can use the injected `window.kelpi` without a runtime dependency. Backend types work in a
Node-only TypeScript project; view types additionally require the DOM library. Run
`pnpm --filter @kelpi/plugin-sdk test:package` to pack the actual SDK, install it into a temporary
external project, and verify both type environments and runtime imports without publishing.

Backends export `activate(api)` from their entry module. Activation may return an async
cleanup function; alternatively export `deactivate()`. Register handlers before activation
resolves. A simple backend is:

```js
export function activate(api) {
    api.commands.register('acme.dashboard.open', () => api.openView('acme.dashboard.board'));
    const off = api.events.on('state.changed', async event => {
        await api.storage.set('lastSequence', event.sequence);
    });
    return () => off();
}
```

Each HTML document receives `window.kelpi` before its scripts run. It can use ordinary HTML,
React, Vue, Svelte, or another framework bundled as browser code. Use relative asset URLs.
The SDK's `getKelpi()` returns the same object if you prefer an imported, typed accessor.

The SDK includes typed `workspaces`, `groups`, `panes`, `layout`, `terminal`, `browser`, `agents`, `git`,
and `appSettings` helpers over Kelpi's existing operations. Their public DTOs use camelCase,
and command failures reject with `KelpiError`; the raw `command()` API retains its original
reply shape. `settings` remains plugin-scoped; `appSettings` targets application settings.
See the [SDK guide](../packages/plugin-sdk/README.md) and [domain types](../packages/plugin-sdk/domain.d.ts)
for operation-specific arguments, results, and dispatch-versus-completion semantics.

```js
const api = window.kelpi;
await api.ready;
const snapshot = await api.snapshot();
document.body.textContent = `${snapshot.state.workspaces.length} workspaces`;
```

| API | Behavior |
| --- | --- |
| `snapshot()` | Daemon state DTO with event epoch and sequence. |
| `command(payload, context?)` | The existing CLI/UI command router, including workspace, pane, agent, git, settings, search, content, and native web-host operations. |
| `openView(viewID, {workspaceID?, state?})` | Create this plugin's registered pane view in the specified or contextual workspace. Returns pane/workspace IDs. |
| `commands.register(id, handler)` | Backend only. Handler receives JSON arguments and invocation context. |
| `commands.execute(id, args?)` | Invoke a declared command, including another installed plugin's command. |
| `events.on(name, listener)` / `emit(name, data?)` | Subscribe to a named event or `*`; emit an event under this plugin's namespace. Returns an unsubscribe function. |
| `storage.get(key)` / `storage.set(key, value)` | Persistent JSON belonging to this plugin on this daemon. |
| `settings.get()` / `settings.set(key, value)` | Manifest defaults plus persisted overrides; changes emit `settings.changed`. |
| `files.read(path)` / `files.write(path, text)` | UTF-8 files on the daemon machine; reads are limited to 256 KiB. |
| `process.exec(file, args?, {cwd?})` | Run a program on the daemon machine; argv is passed directly, without a shell. Returns stdout/stderr. |
| `terminal.watch(paneID)` | Subscribe to an existing PTY and receive its initial base64 snapshot and geometry. `terminal.output` events identify the returned subscription. |
| `terminal.unwatch(subscription)` | Release a terminal subscription. |
| `terminal.attach({cols, rows, onFrame, onAction?})` | Terminal replacement view only. Attach an emulator to this pane's existing process with consumed-frame acknowledgements, raw input, modes, geometry and host actions. See [terminal renderers](plugin-terminals.md). |
| `browser.get/watch/unwatch` | Observe native tabs, navigation, host availability, favourites and inspector revisions on the owning daemon. |
| `browser.attach({element, onPresentation, onAction?})` | Browser replacement view only. Place the existing native page inside a measured slot; retain tabs and sessions across swaps. The [browser guide](plugin-browser.md) covers shared navigation, capture, cookies, inspection and batch APIs. |
| `ui.reveal(paneID)` | Ask the invoking window to reveal a pane; broadcasts when no window context exists. |
| `setState(object)` | View only. Persist this pane's state and current manifest state version. |
| `ui.activateWorkspace(id)` / `ui.focusPane(workspaceID, paneID)` | View only. Change selection in the attached client runtime. |
| `ui.getNavigation()` / `ui.onNavigation(listener, onError?)` | View only. Read/watch the primary window's connected hosts, workspace summaries and active selection. Returns opaque host IDs without connection credentials. |
| `ui.selectWorkspace(hostID, workspaceID)` | View only. Select a connected local or remote workspace in this window; domain commands retain their owning daemon. |
| `ui.notify(message)` | View only. Show a Kelpi notification. |
| `call(method, args?)` | Generic JSON bridge used by these helpers; method names are in `PluginService.api`. |

Use explicit workspace/pane IDs in raw command payloads, following the
[wire catalog](wire-protocol.md), [socket handlers](socket-handlers.md), and existing
[UI command router](../packages/daemon/src/ws/sync.ts). For example:

```js
const result = await kelpi.command({ command: 'workspace-list' });
if (!result.ok) throw new Error(result.error);
```

Raw commands preserve their existing `{ok, ...}` replies. Bridge errors reject promises;
callers must also inspect a raw command's `ok`. Streaming `follow` commands and content/web
console subscriptions are excluded from the one-shot command API. Use events and
`terminal.watch`, and resnapshot when needed. Plugin administration is excluded from this
API. Full-trust backends can additionally import Node modules and invoke the daemon's CLI.
Backends and managed processes receive this daemon's `KELPI_SOCKET` and
`KELPI_REQUIRE_SOCKET=1`, so a missing route fails instead of falling back to another local
daemon. Managed processes read the current route at launch; reload a backend after changing
its daemon's control listener if it spawns CLI processes directly from its inherited environment.

Invocation context contains a stable `daemonID` and, when applicable, `clientID`, `windowID`,
`workspaceID`, `paneID`, and `viewID`. Backends inherit command context across async calls.
A sidebar has workspace/view context and does not claim the currently focused terminal as
its own pane. Background callbacks should pass explicit IDs. Remote panes use the remote
runtime: files, processes, commands, and storage execute on that daemon.

## State, events, focus, and appearance

`kelpi.state` and `kelpi.stateVersion` contain the persisted pane state and the version that
wrote it. Migrate your own state when its version differs, then call `setState` to save at
the manifest's current version. Slot views have no pane to write; use plugin storage for
their preferences. JSON values must be finite, acyclic, plain data without prototype keys,
within 256 KiB and 32 levels. The whole storage object also has the 256 KiB limit.

`snapshot()` provides a sequence anchor. Subscribe before taking the snapshot, then discard
events at or before its sequence. `state.changed` contains the same serialized domain events
as client replication. `daemon.<type>` exposes daemon broadcasts; `settings.changed` and
`terminal.output` are plugin service events. Custom emissions are named `<plugin-id>.<name>`.
The epoch changes on every daemon restart, while daemon identity stays stable.

Backend and frame delivery each use a bounded queue (32 events / 512 KiB), with one event
awaiting acknowledgement. Awaited listeners apply backpressure. Overflow emits `gap`:
take a fresh snapshot instead of assuming every intermediate event arrived. Delivery is
ordered within an epoch, with no durable replay or exactly-once promise. `kelpi plugin watch`
streams an initial snapshot followed by events; closing the connection unsubscribes it.

The host forwards visibility, persisted state, theme variables, and claimed Kelpi shortcuts
to a view. Theme variables are `--kelpi-bg`, `--kelpi-fg`, `--kelpi-fg-secondary`,
`--kelpi-fg-tertiary`, `--kelpi-surface`, `--kelpi-border`, and `--kelpi-accent`.
Pane focus follows pointer/focus events inside the frame. Only shortcuts claimed by Kelpi
are forwarded out of it; ordinary typing remains in the custom UI. Built-in shortcuts win
collisions; the first available plugin command wins a collision between plugins. Commands
also appear in the palette, plus the optional pane/workspace menu. Set a command's `menu` to
`pane.header` to contribute a pane-header action, including the header's overflow behavior.
Settings → Plugins lets users change, disable, and restore each plugin shortcut. Overrides
belong to the client and stable daemon identity, survive reload, and update mounted views.
Unmodified typing and Shift-only shortcuts are rejected; bundled shortcuts retain priority.
Plugin shortcuts use the same early keyboard capture boundary as native commands so a focused
terminal cannot swallow them. Modal overlays and remote-workspace focus suspend the primary
daemon's plugin keybindings. `onContext(listener)` reports the view's initial environment
after `ready`, then context/state/theme/visibility changes; its return function unsubscribes.

## Custom containers and named slots

`contributes.containers` registers host-rendered view compositions. A container has `id`,
`title`, `placements`, `layout` (`row`, `column`, or `tabs`), and `slots`. Each slot declares
a namespaced `id`, `title`, optional `defaultView`, and optional `weight` (0.1–100). A view
or another container participates by listing that slot ID in its `placements`.

```json
{
  "id": "example.my-plugin.tools",
  "title": "Workspace with tools",
  "placements": ["workspace"],
  "layout": "row",
  "slots": [
    { "id": "example.my-plugin.main", "title": "Workspace", "defaultView": "kelpi.workspace", "weight": 3 },
    { "id": "example.my-plugin.details", "title": "Details", "defaultView": "example.my-plugin.dashboard" }
  ]
}
```

This is a container entry; its accompanying dashboard view must include
`example.my-plugin.details` in `placements`. Select the container in Workbench views.
The slot selectors let users replace, clear, and restore individual child views. Slot choices
and active tabs persist per client/daemon; instances of the same container share those
preferences. Hidden tabs retain their documents while receiving `visible=false`; their
iframes cannot claim host shortcuts or focus. A hidden native grid pauses measurement and
focus handling while retaining its pane instances and terminal streams.

Views can call `ui.getWorkbench()` to discover slots/views/active tabs,
`ui.selectView(slotID, viewID)` to choose a compatible view (empty string clears a custom slot),
and `ui.activateTab(containerID, slotID)` to show a tab. Invalid slots, incompatible views, and
cycles reject without modifying the layout. These are client-local operations and require
the view's owning daemon to match the workbench runtime; remote/headless callers cannot
silently change another daemon's primary layout.

Bundled renderers and external views share a renderer registry. Native adapters stay scoped
to their owning host: a workspace container can wrap `kelpi.workspace`, and a sidebar
container can wrap that sidebar's native view. Each native host renders once. Referencing
an unavailable adapter shows a recoverable placeholder. Containers are workbench views;
individual plugin panes retain their separate descriptor, saved state, and frame ownership.

Container/slot IDs must be unique in the plugin namespace. Foreign slot/default references
require a declared dependency. Cyclic defaults and incompatible local defaults are rejected
at installation; cyclic saved choices are also rejected. Limits are 32 slots per container,
16 nested containers, and 128 mounted views per root host. Disabling or removing a container
plugin restores the bundled root while retaining the user's preferred layout.

The [Workbench Lab example](../examples/plugins/workbench-lab) wraps the native grid in a
row layout with nested dashboard/notes tabs. Install Agent Board first, then Workbench Lab,
and choose **Workspace with tools** for the workspace placement in Settings.

## Dependencies

Declare prerequisites in top-level `dependencies`:

```json
[{ "pluginID": "example.agent-board", "version": "^1.0.0", "optional": false }]
```

Version requirements accept exact semver, `^version`, `~version`, or `*`; other range syntax
is rejected. Prereleases require an explicit matching prerelease requirement. Dependencies
activate before their consumers. New installations or updates with missing, disabled, failed,
incompatible, or cyclic required dependencies are refused before selection changes.
If an installed dependency later becomes unavailable, its consumers report an actionable
plugin error and use bundled UI fallback. Installing or reenabling a dependency recovers
eligible startup consumers. Disabling/reloading a required
dependency stops its dependent backends and revokes their views first. Unavailable optional
dependencies are skipped. Dependency discovery does not download or trust new packages.

## Operation hooks

Declare `contributes.hooks` entries with `id`, `phase` (`before`/`after`), `commands` (exact
names or `*`), optional `priority` (-1000–1000, default 0), and optional `timeoutMs`
(25–5000, default 1000). Register every declared hook during backend activation:

```js
api.hooks.register('example.my-plugin.guard', operation => {
    return operation.payload.name === 'protected'
        ? { allow: false, reason: 'This workspace is protected.' }
        : { allow: true };
});
```

Hooks cover the shared CLI dispatcher and native UI command entry, including UI-only
commands and commands called from plugins. Each invocation identifies its command, immutable
JSON payload, daemon/client/workspace/pane context, source, and correlation ID. A command
crossing both adapters is intercepted once. Ordering is ascending priority, plugin ID, then
hook ID. Existing handlers validate current state after before hooks finish, outside reducers
and database transactions. Recursive invocations carry a bounded trace; a hook does not
reenter itself. Plugin administration and ping remain outside hooks for recovery.

A before hook must explicitly return allow or refuse; refusal reaches the caller without
performing the operation. Invalid decisions, errors, and timeouts fail the current operation
and fail that backend. Future operations bypass failed/disabled hooks. All before hooks share
a 5-second budget, so adding plugins cannot introduce an unbounded aggregate delay.

After hooks observe the command's first result without delaying or changing it. Legacy
fire-and-forget CLI operations report `completion: "dispatched"`; early acknowledgements and
streaming replies preserve their existing meaning. An after hook is not proof that detached
background work completed. After-hook failures are logged and share a separate 5-second
budget. State/event subscriptions remain available for subsequent domain changes.
Invocation envelopes are limited to 256 KiB; an oversized after observation is logged and
skipped without changing the original command result. Cancelling a view's pending before
hook stops that request without failing an otherwise healthy shared backend.

## Service providers

Declare a versioned service in `contributes.services` with `id`, `title`, positive integer
`version`, and explicit `methods`. Declare implementations in `contributes.providers` with
their own `id`/`title`, `service`, matching `version`, all required `methods`, and optional
`timeoutMs` (25–30000). A provider may implement an owned service, a dependency's service,
or a bundled service. Register its methods with `api.providers.register(id, methods)`.

The daemon exposes four version-1 bundled services:

| Service | Native reach |
| --- | --- |
| `kelpi.git` | Git primitives used by repository discovery/status, worktree commands, graft, and diff generation. Kelpi's command guards and state ownership remain in place. |
| `kelpi.content.render` | HTML generation for native Markdown and diff previews, including already-open previews when the provider changes. Source buffers, editing, watches, and save ownership remain with Kelpi. |
| `kelpi.process` | Managed `api.process.exec` and explicit service calls. This does not replace PTY spawning or arbitrary Node subprocesses. |
| `kelpi.files` | SDK `files.read/write` and explicit service calls, preserving the existing version-1 contract. Internal editor saves and unrelated file access retain their existing behavior. |

Every service supports explicit bundled delegation, for example
`api.services.call('kelpi.git', 1, 'getStatus', args, {provider: 'bundled'})`.
The SDK infers built-in method arguments/results and exports `BuiltinProviderMethods` for
typed implementations. The [native service guide](plugin-services.md) lists exact contracts,
provider examples, and lifecycle boundaries. Built-in adapters validate inputs and provider
results; ordinary high-level SDK helpers retain their command and reply semantics.

Settings → Plugins → Service providers and `kelpi plugin service-select` choose providers
explicitly. Selections are daemon-scoped, persisted, and retained when a provider disappears.
A failed or disabled selection falls back to the bundled implementation where one exists.
Custom services require an explicit provider choice; installation order never picks one.
The failing call returns its error, avoiding an automatic retry of a possibly completed write.
Later calls use the fallback. Explicit requests for an unavailable provider fail.
Native content previews additionally recover from renderer errors or oversized documents by
rendering the complete document with the bundled renderer, retaining the user's selection.

```sh
kelpi plugin services
kelpi plugin service-select kelpi.files example.workbench-lab.files
kelpi plugin service-call kelpi.files read --args '{"path":"/path/to/file.txt"}'
kelpi plugin service-select kelpi.files default
```

The SDK offers `services.list`, `services.call`, and `services.select`. Discovery reports
declared contracts, provider availability, and both preferred and active provider IDs.
Method/version mismatches and recursive provider calls fail with diagnostics. Hook/provider
registrations must match the manifest before activation completes and are revoked on stop.
`services.changed` carries the discovery array; `services.invalidated` carries service keys
such as `['kelpi.git@1']` when selection, reload, failure, or dependencies change the effective
implementation. Native previews, Inspector data, and Git footer data refresh on invalidation.

## Execution and recovery

All installed plugins are **fully trusted code with the daemon account's access**. This
includes UI-only plugins because their API exposes files, processes, and Kelpi commands.
The installation acknowledgement is an access decision, not a declaration of an OS sandbox.

Backends run in separate Node processes, outside the daemon reducer loop. Activation has a
10-second timeout; commands have a 30-second timeout; process execution has a 25-second
timeout and bounded output. There are at most 64 concurrent operations per plugin and 64
pending command invocations per backend. Excessive IPC fails that backend. Errors and a
bounded log are visible in Settings and `kelpi plugin logs <id>`. Disable stops the process,
rejects pending calls, releases views/subscriptions, and kills a backend that will not exit
within one second. Arbitrary subprocesses a trusted backend creates itself remain its own
cleanup responsibility; these limits do not impose an OS CPU/memory sandbox.

Views run in opaque-origin `sandbox="allow-scripts"` frames with a CSP and a private
MessageChannel. They receive neither the owner token nor access to the host DOM. Their
assets are limited to the installed revision's `ui/` directory and a revocable view lease;
the service worker never caches these URLs. Host initialization and uncaught view errors
show a recoverable placeholder. Unmount/disconnect/reload revokes the lease and cancels
direct command/process requests and terminal/browser subscriptions owned by that view.

The supported boundary is registered views/containers, commands, events, operation hooks,
and versioned services. Private functions and arbitrary native OS controls are not plugin
APIs. Further internal replacements require explicit adapters with their own lifecycle and
result contracts. Terminal and browser renderers have explicit SDK attachments; transport,
process/page ownership, authentication and editor save ownership remain native.
An untrusted runtime, marketplace, signatures, automatic remote distribution, and a published
SDK remain outside this local-plugin implementation. Local package updates and retained
revision recovery are supported.

## Database and protocol upgrade

The daemon now defaults to `kelpi-v2.db` in its existing data directory. On first use it
copies a sibling `kelpi.db` into the new generation using SQLite `VACUUM INTO`, then applies
the plugin-pane migration. The snapshot includes committed WAL data; the old database is
unchanged and usable by the old binary. Subsequent boots never overwrite an existing new
generation. Stop the older daemon before switching to the new version: continued edits to
the old database after the copy are independent and are not merged back.

Plugin installations, identity, storage, and settings live in `<db-path>.plugins/`.
The pane descriptor and parking flag live in the main database. Protocol generation 2 uses
`daemon-v2` run files and refuses generation 1 WebSocket clients. Upgrade the UI, shell,
daemon, and CLI together; refresh installed browser clients.

An explicit `KELPID_DB_PATH` remains authoritative. If you use a custom path, choose a new
path or make a consistent backup before upgrading it; an older daemon must never open the
upgraded custom database. Rolling back the default installation returns to the old database
as it stood at the copy, not the changes subsequently made in generation 2.

## Validation

`node scripts/scenario.mjs plugin-authoring` creates a plugin outside the repository and
checks deterministic packaging, live valid/invalid edits, failed activation recovery,
Settings rollback, saved-state compatibility and native session preservation.

`pnpm check` covers protocol validation, real child activation/failure/recovery, restart and
parked-pane persistence, shared command cancellation, client binding, CLI streams, iframe
isolation, and the existing product tests. `node scripts/verify.mjs --full` additionally runs
the build/package smokes, full UI audit, and all real-app scenarios.

`node scripts/scenario.mjs plugin-extensions` installs Workbench Lab and its dependency into
an isolated daemon. It covers nested containers, programmatic slot selection, retained tabs,
typed SDK calls, before/after hooks through CLI and UI, provider selection/delegation/fallback,
editable shortcuts, and dependency failure/recovery. `sidebar-swap` checks Inspector on the
left, Workspaces on the right, filtering, resizing, and persisted placement.

`node scripts/scenario.mjs plugin-workbench` installs Agent Board into an isolated daemon,
drives the real iframe, opens a terminal through its SDK, checks saved pane state, replaces
the sidebar, forwards Kelpi shortcuts from the iframe, and exercises reload, view errors,
retry, and disable/recovery. It removes its plugin and workspace afterward.

`node scripts/scenario.mjs plugin-remote` uses two isolated daemons to verify remote file,
process, and pane commands; a real daemon restart; stable identity and saved state; the
ordinary browser client; and remote plugin panes in the phone layout.
After packaging the app, `KELPI_PLUGIN_PACKAGED=1` runs that scenario's remote daemon and
backend children from the packaged application's payload.

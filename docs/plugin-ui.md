# Reactive contributions and shared window UI

Plugins can add native menu entries, header controls and status items alongside their custom
views. They can also ask the owning Kelpi window to present a quick pick, input prompt,
dialog or actionable notification. [UI Lab](../examples/plugins/ui-lab) demonstrates both
contracts without a build step.

The [plugin roadmap](plugin-roadmap.md) tracks overall progress. The
[development guide](plugin-development.md) covers private testing, templates, packages and rollback.

## Try UI Lab beside your installed Kelpi

From the checkout root, after `pnpm install --frozen-lockfile`, run:

```sh
node scripts/dev-instance.mjs --state out/plugin-playground
```

In that instance, install the absolute path to `examples/plugins/ui-lab` through Settings → Plugins.
From one of its terminal panes, use its CLI to open the example:

```sh
kelpi plugin open example.ui-lab example.ui-lab.panel
kelpi plugin contributions --json
```

An external terminal must use the `KELPI_SOCKET` printed by the development script,
`KELPI_REQUIRE_SOCKET=1`, and `node packages/cli/dist/kelpi.js` from this checkout. The development
guide provides a `kelpi_test` helper. The instance has separate data, sockets,
configuration and an Electron profile. Ctrl-C stops it; its named state directory persists.

Click a native **UI Lab** item to increment its badge. The example's **Disable actions**
and **Hide items** controls update native menus, items and its Ctrl+Alt+U shortcut. Settings
→ Plugins exposes Appearance and Behavior groups, including density choices and a counter
step constrained to 1–10. The example also demonstrates each shared prompt and cancellation.
For live editing, run `kelpi_test plugin dev examples/plugins/ui-lab --trust` from the checkout
root. Reload restarts the installed copy. Settings → Plugins → Versions selects compatible
retained revisions; each backend restart reseeds this example's volatile counter/contributions.

## Menus, items and conditions

Declare commands and their placements in `kelpi.plugin.json`:

```json
{
  "commands": [{
    "id": "acme.checks.run", "title": "Run checks",
    "enablement": { "context.ready": true }
  }],
  "menus": [{
    "id": "acme.checks.pane-menu", "command": "acme.checks.run",
    "placement": "pane", "group": "Checks", "order": 10,
    "when": { "pane.exists": true }
  }],
  "items": [{
    "id": "acme.checks.status", "placement": "statusbar",
    "text": "Checks", "badge": "0", "tone": "info",
    "command": "acme.checks.run",
    "when": { "connection": "connected" }
  }]
}
```

These fields belong inside `contributes`. IDs must be unique within the plugin's namespace;
item and menu commands must name one of its declared commands. Register command handlers in
the backend as usual. Items without a command render as text.

| Contribution | Placements | Additional fields |
| --- | --- | --- |
| Menus | `pane`, `workspace`, `pane.header`, `palette` | `group`, `order`, `when`, `enablement` |
| Native items | `statusbar`, `workspace.header`, `pane.header` | `text`, `tooltip`, `badge`, `tone`, `command`, `order`, `when`, `enablement` |

`when` hides a contribution when false. `enablement` keeps it visible but disables its
action. Command conditions also apply to its menu entries, items and shortcut. A runtime
item patch cannot bypass a false condition. Menus retain compatibility with legacy
`command.menu` placements, including `"pane.header"`; explicit placements replace the
corresponding inferred entry. Commands
still appear in the palette by default unless an explicit palette rule limits their display.
Groups and numeric order provide deterministic menu ordering.

Conditions are a conjunction of strict scalar equalities, without an expression language.
`null` matches a missing fact. Host facts are:

| Fact | Value |
| --- | --- |
| `connection` | `idle`, `connecting`, `connected`, `reconnecting`, `closed`, `rejected` |
| `workspace.exists`, `workspace.hasRepos` | Boolean |
| `pane.exists`, `pane.hasAgent`, `pane.focused` | Boolean |
| `pane.type` | `shell`, `markdown`, `scratchpad`, `diff`, `web`, `plugin`, or null |
| `context.<key>` | The current plugin's published scalar, or null |

Pane menus and headers resolve their explicit pane's owning workspace, including when that
pane is not focused. Window menus, palette entries and status/workspace items use the
primary runtime's current selection. Embedded remote pane headers read and invoke their own
daemon's contributions. They do not install another set of window shortcuts. Window chrome
continues to belong to the primary runtime.

Conditions are UI behavior, not authorization. CLI commands, backend calls and raw API calls
do not evaluate window facts. Enforce an operation's requirements inside its command handler
or an operation hook when they must apply to every caller.

## Publish reactive state

Both browser views and backends have the same API:

```js
await api.contributions.update({
  context: { ready: true, count: 3 },
  items: { 'acme.checks.status': { text: 'Checks passed', badge: '3', tone: 'success' } }
});
const current = await api.contributions.get();
await api.contributions.update({ context: { count: null }, items: { 'acme.checks.status': null } });
```

Updates merge atomically. A null context value deletes the key; a null item resets all its
overrides to the manifest defaults. Patches can target only declared items; individual
fields do not accept null. Item patches support `text`, `tooltip`, `badge`, `tone`,
`visible` and `enabled`. Tones are `default`, `info`, `success`, `warning` and `error`.

State belongs to one plugin instance on one daemon and is shared by its attached views.
It is volatile: disable, backend failure, reload, removal or daemon restart clears it.
Seed it during activation or view initialization. Persistent preferences belong in settings
or plugin storage. Concurrent patches are serialized by the daemon; use one backend writer
if an update depends on reading a counter first.

`plugin.contributions.changed` carries a complete `{pluginID, instanceID, sequence, state}`
snapshot in `event.data`. Subscribers must resnapshot after a `gap`. Kelpi's native UI
coalesces updates and rejects obsolete snapshots, instances and disconnected subscriptions.
Retained actions recheck current manifests, conditions and targets before dispatch.

Limits: 100 declarations per collection; 32 predicates per condition; 64 context keys;
4,096 characters per context string; 32 KiB total state per plugin. Local context keys start
with a lowercase letter and contain up to 64 letters, digits, dots or hyphens. Item text is
limited to 200 characters, tooltips to 1,000 and badges to 32. Order is an integer from
−10,000 to 10,000. Invalid patches reject without a partial update.

## Grouped settings

`contributes.settingGroups` declares `{id, title, description?, order?}` groups. Each entry
in the existing settings map can add `group`, `description`, `order`, `enum`, and numeric
`min`/`max`. Ungrouped settings remain under General. Enum choices must match the setting's
type, and the default must satisfy its choices and bounds. Enums contain 1–100 unique
choices; numeric choices must also satisfy the declared bounds.

Settings UI, defaults and daemon writes share validation. Incomplete numeric input stays in
the editor while the user types; invalid values display an error without being persisted.
Concurrent edits and incoming settings events do not let an old reply replace a newer value.
An invalid saved value after a plugin upgrade falls back to the declared default without
silently rewriting the saved file.

## Shared prompts and notifications

These methods are browser-only, on `kelpi.ui`:

```js
const choice = await kelpi.ui.showQuickPick({
  title: 'Choose a task', items: [{ id: 'test', label: 'Run tests', description: 'Current workspace' }]
});
const label = await kelpi.ui.showInput({ title: 'Task label', value: 'Tests', maxLength: 80 });
const action = await kelpi.ui.showDialog({
  title: 'Start task', message: 'Run the selected task?', cancelID: 'cancel',
  actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'run', label: 'Run', kind: 'primary' }]
});
const response = await kelpi.ui.showNotification({
  message: 'Task finished', tone: 'success', actions: [{ id: 'open', label: 'Open results' }]
});
```

Quick picks return an enabled item ID, inputs return entered text (including an empty string),
and dialogs/notifications return an explicitly chosen action ID. Escape and dismissal return
null for modal prompts. Notification dismissal and expiry return null; notifications do not
handle Escape. `cancelID` selects a dialog's initial focus; Escape still returns null.
Input also supports `prompt`, `placeholder` and `password`.
See the [public types](../packages/plugin-sdk/ui.d.ts) for all options.

Kelpi queues modal prompts, provides filtering and keyboard/focus handling, and waits behind
existing native modals. Native and plugin shortcuts cannot mutate a pane behind a prompt;
the native Close shortcut cancels the prompt. Web panes use the existing modal/overlay
parking mechanism. Notifications use a separate stack with at most four visible; each
expires ten seconds after entering that stack. This timer continues while the window is
hidden or another modal is open.

Each attached view owns a disposable scope. View failure, reload, disconnect, disable and
unmount cancel that scope's active/queued prompts and notifications. A destroyed iframe
cannot observe a result or continue its JavaScript. Prompts have no ordinary
35-second RPC deadline. Limits are eight pending requests per view, 32 per window, 200 quick
pick items, eight actions, 256 KiB per request, and input lengths up to 16,384 characters
(default 4,096). Malformed requests reject with an error.

Window UI is available only through the primary workbench runtime. An embedded remote
pane receives an explicit unavailable error; a window connected directly to that remote
daemon can present its prompts normally. Backends use events/commands to coordinate with a
view when they need an interactive response. No host DOM or native window handle is exposed.

## Automated validation

`pnpm check` covers schema validation, ownership, lifecycle resets, settings races, SDK
contracts, retained actions and prompt behavior. `node scripts/scenario.mjs plugin-ui-services --window hidden`
exercises UI Lab through a private daemon and real Electron window. The
[validation record](plugin-validation.md) records past runs and their source revisions. Use
`--window onscreen` to inspect screenshots; a historical pass does not validate a later checkout.

# Reactive contributions and shared window UI

Plugins can add native menu entries, header controls and status items alongside their custom
views. They can also ask the owning Kelpi window to present a quick pick, input prompt,
dialog or actionable notification. [UI Lab](../examples/plugins/ui-lab) demonstrates both
contracts without a build step.

The [plugin roadmap](plugin-roadmap.md) tracks overall progress. The
[development guide](plugin-development.md) covers private testing, templates, packages and rollback.

## Try UI Lab beside your installed Kelpi

First [prepare the source checkout](plugin-development.md#prepare-a-source-checkout).
Then run from its root:

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

These fields keep their own draft session and are drawn by the bundled panel inside the native
Plugins section, whoever is selected for
[the Settings presenter](#selectable-settings-presenter).

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

## Shared interaction contracts

The palette session and the shared prompts above are owned by one window interaction surface
(`packages/client/src/interaction/`), created for the window's primary workbench runtime. The
bundled presenters render it; they no longer hold request authority. Plugins see no new API in
this phase: `kelpi.ui.show*` and command contributions behave as documented above, and the
plugin-facing model in `packages/client/src/plugins/ui-services.ts` is now an adapter over the
surface with its previous shapes.

What the surface guarantees, independently of who renders:

| Rule | Behaviour |
| --- | --- |
| Ownership | Every request has an owner: a plugin view scope, or a stable native id such as `native:shortcut`. A request from an embedded remote runtime is refused with the existing unavailable error. Native owners bypass the per-view limit, never the per-window limit. |
| Palette activation | Items are descriptors only; no command handler crosses into the session snapshot. Activation re-resolves the item against a fresh read of contributions and the daemon mirror, refuses disabled, stale-session or vanished workspace/pane targets, and executes at most once. |
| Queueing | One visible modal request at a time; the rest wait. A prompt raised while the palette is open stays hidden until the palette dismisses; opening the palette over a visible prompt is refused; both wait behind an existing native modal such as Settings. |
| Cancellation | Owner disposal (reload, disable, disconnect, unmount, view failure) cancels its requests with null. Presenter failure never answers a request and never produces a non-null result. |
| Focus | The surface records the focus origin before a *prompt* presenter takes focus (a palette session captures no origin: nothing in it claims the caret from the window), and releases in one order: a pending palette pane hand-off wins, else the origin is restored when it is still focusable, else the caret goes to the fallback pane. A pane hand-off is cancelled when a queued prompt becomes visible, so the caret cannot land behind a prompt. |
| Keyboard | Escape and the rebindable Close chord cancel the visible request or dismiss the palette. Composing keystrokes (IME) never activate or cancel. Window shortcuts, plugin shortcuts, Settings and Help chords and native menu commands stand down while a request is *active* - at the front of the queue, painted or still waiting behind a native modal - with the recovery command and web-page chord relays exempt. |
| Native pages | A visible modal request or an open palette parks native pages through the existing whole-window modal presence, registered once for the surface; notifications keep the finer overlay rectangle. |

The destructive sidebar and agent confirmations, the quit confirmation, phone sheets and the
native toast stack remain native and are not routed through the surface. A plugin view can be
selected to present the palette or the shared prompts; see
[selectable interaction presenters](#selectable-interaction-presenters).

## Selectable interaction presenters

Two placements are selected independently in Settings → Plugins → Workbench views:

| Placement | What it draws |
| --- | --- |
| `interaction.palette` | The command palette, inside the content row box, with the title bar and status footer live behind it. |
| `interaction.prompts` | Modal quick picks, inputs and dialogs, in the window's modal portal. Notifications stay bundled in this release. |

Both placements appear in `ui.getWorkbench().slots` for discovery, and `ui.selectView` refuses
both: a prompts presenter renders other plugins' requests, so the choice stays the user's.

[Interaction Lab](../examples/plugins/interaction-lab) is the reference presenter for both
placements: plain JavaScript, no backend, no build. Install its directory in a private instance,
select it for either placement, and open the palette or raise a prompt from another plugin such
as UI Lab. Its README lists the diagnostics and the deliberate crash and stall hooks the live
scenario uses to prove the fallback. A listener that throws is caught by the SDK and its frame
is still acknowledged; only an uncaught view error, a missing readiness report, an
unacknowledged live frame, an undeliverable frame or a call budget breach fails a presenter.
A container cannot declare either placement, because a presenter owns its whole overlay.
Presenters are desktop-only in this release; a phone window keeps the bundled ones, and the
snapshot reports `formFactor` so a view can say why.

A selected view reads its placement's projection and acts through `kelpi.ui`:

```js
const stop = kelpi.ui.onInteraction(async snapshot => {
  render(snapshot);                       // snapshot.placement names this surface
  await kelpi.ui.reportPresenterReady();  // required within 5 seconds of the first frame
}, error => reportError(error.message));

// interaction.palette: the host owns the session, its query and its selection.
await kelpi.ui.setPaletteQuery(sessionID, 'tests');
await kelpi.ui.setPaletteSelection(sessionID, itemID);
await kelpi.ui.activatePaletteItem(sessionID, itemID);
await kelpi.ui.dismissPalette(sessionID);

// interaction.prompts: one visible request at a time. Null cancels it.
await kelpi.ui.respondInteraction(requestID, itemID);
addEventListener('pagehide', stop, { once: true });
```

`getInteraction()` reads the same projection once. Every call is checked against the placement
the view was selected into: the palette methods belong to `interaction.palette` and
`respondInteraction` to `interaction.prompts`, and a call from the other placement is refused. See
the [public types](../packages/plugin-sdk/interaction.d.ts) for every field.

Each placement receives only its own half of the surface:

| Snapshot field | `interaction.palette` | `interaction.prompts` |
| --- | --- | --- |
| `palette` | The open session: query, scope, the whole item universe, `selectedID`, `remoteWorkspaceSelected`. Null while closed. | Always null. |
| `paletteOpen` | Both placements. The palette outranks a queued prompt. | Both placements. |
| `prompt` | Always null. | The visible modal request: `requestID`, `owner`, `kind` (`quickPick`, `input` or `dialog`) and its validated options. |
| `queued` | Always zero. | Modal requests waiting behind `prompt`. |
| `notifications` | Always empty. | Always empty in this release: reserved, and the bundled stack draws notifications. |
| `visible`, `formFactor` | Both placements. `visible: false` means present nothing. | Both placements. |

Withheld from both: command handlers and `run` closures (rows are descriptors, activation goes
back through the host), the `pluginID` of any owner (a presenter renders `displayName` and an
opaque window-local `ref`), the other placement's half, opening the palette (a presenter may
only dismiss it), focus authority, and every connection URL, credential, foreign client ID and
other plugin's storage. Native owners get a minted ref like any other owner. Palette rows do
carry contributed command IDs and plugin display names, which is not new exposure: a view's
`ui.getWorkbench().views` already lists every contributed view and its plugin ID.

Escape and the rebindable Close chord still reach the host: a presenter is granted that small
chord set only, and everything else (typing, arrows, Enter, filtering, the focus trap) belongs
to the view. Composing keystrokes never activate or cancel.

Presenter limits:

| Rule | Limit |
| --- | --- |
| Readiness | `reportPresenterReady()` within 5 seconds of the first frame. |
| Acknowledgement | Each frame carrying a new prompt or palette session is acknowledged within 5 seconds. |
| Calls | 240 presenter calls per rolling second. A breach fails the presenter. |
| Payload | 256 KiB per frame; a palette query of at most 1,024 characters. |

An acknowledgement proves the frame reached the view's sandbox, not that the view drew or
understood it, and only the outstanding frame's acknowledgement counts. Recovery therefore never
depends on the presenter agreeing: **Retry presenter** in Settings, the palette chord and the
native menu are the routes back.

The bundled presenter is the recovery floor and cannot be selected away. A view error, a failed
connection, a missed readiness or acknowledgement deadline, an oversized or non-JSON frame, and
an exhausted call budget are all failures. On failure the placement latches to bundled for the
rest of the window session, a native failure toast is raised, the live request keeps its ID and
is re-presented by the bundled presenter, and the palette placement additionally dismisses its
session with reason `presenter-failed`. A failure never settles a request and never produces an
answer. A missing, disabled or failed plugin, and a disconnected daemon, resolve to bundled the
same way, and the saved selection is retained throughout. The latch clears on plugin reload or
rollback, on a selection change, and on **Retry presenter** in Settings → Plugins → Workbench
views. `kelpi.window.openPalette`, `openSettings`, `openPlugins`, `openHelp` and `restartUI`
stay enabled whatever is selected, and the native menu and their shortcuts never route through
a presenter.

A `ui.showInput({ password: true })` request is always presented by the bundled presenter and
never reaches a plugin presenter: the snapshot reports `prompt: null` while such a request is
visible, and `queued` still counts it. Destructive native confirmations are carved out the same
way. Notifications are carved out too in this release: `showNotification` results are drawn by
the native stack, `notifications` is always empty, and selectable notification presentation is
later scope.

## Selectable Settings presenter

One further placement, `settings.window`, is selected in the same Settings → Plugins → Workbench
views list. A selected view draws the rail and the panel inside the host's Settings dialog. The
host keeps the dialog frame and backdrop, modal presence, Escape and Close, the Tab trap, focus
capture and release, the reopen focus rule and the native sections.

The placement appears in `ui.getWorkbench().slots` for discovery and `ui.selectView` refuses it:
Settings is where a broken presenter is recovered from, so the choice stays the user's. A
container cannot declare it, because a presenter owns the whole dialog body. Presenters are
desktop-only in this release: a phone window keeps the bundled sheet and never selects one, so a
frame a presenter receives always reports `formFactor: 'desktop'`.

A selected view reads the projection and acts through `kelpi.ui`:

```js
const stop = kelpi.ui.onSettingsPresentation(async frame => {
  render(frame);                          // frame.sections is the rail, frame.sectionID the route
  await kelpi.ui.reportPresenterReady();  // required within 5 seconds of the first frame
}, error => reportError(error.message));

await kelpi.ui.setSettingsSection('appearance');
await kelpi.ui.setSettingsDraft(fieldID, '19400');  // holds a value; writes nothing
await kelpi.ui.commitSettingsField(fieldID);        // re-resolved and re-validated host-side
await kelpi.ui.resetSettingsField(fieldID);         // drops the draft, keeps the committed value
await kelpi.ui.closeSettings();                     // the dialog's own Close
addEventListener('pagehide', stop, { once: true });
```

`getSettingsPresentation()` reads the same projection once. `reportPresenterReady` is shared with
the interaction presenters. See the
[public types](../packages/plugin-sdk/settings.d.ts) for every field.

Each frame carries the whole rail and only the current section's contents:

| Frame field | What it holds |
| --- | --- |
| `sections` | Every rail entry in order: `id`, `title`, `icon` and `native`. A presenter routes the rail; it cannot add to or remove from it. |
| `sectionID`, `native` | Where the host is routed, and whether the bundled panel is drawing that section or the remainder of it. |
| `groups` | The current section's cards: `id`, `title` and an optional `detail`. Empty when the section is fully native. |
| `fields` | The current section's projected fields: `id`, `sectionID`, `groupID`, `kind`, `label`, `detail`, `value`, and per kind `choices`, `min`, `max`, `step` or `maxLength`, plus `draft`, `error`, `busy` and `disabled`. Empty when the section is fully native. |
| `dirty` | Fields with an uncommitted draft. |
| `visible`, `formFactor` | `visible: false` means present nothing. `formFactor` is always `desktop` in a frame a presenter receives. |

Withheld: every config key, verb name, file path and write closure (a presenter sends a field id
and the host owns the mapping, so a leaked key cannot bypass the daemon's writable-key
allowlist), the audit `testID` of any row, the pairing URL and its token, paired device ids,
profile environment values, repository paths, raw transport and global hotkey errors, and every
other plugin's id, storage and connection URL. Destructive actions are native buttons the host
draws and a presenter cannot invoke.

These sections are drawn by the bundled panel whatever is selected, and a frame routed to one of
them reports `native: true` with no groups and no fields:

| Section | Why it stays native |
| --- | --- |
| Plugins | The whole section: Versions and rollback, **Restore bundled views**, **Retry presenter**, enable and disable, providers, shortcuts and plugin schema fields. A replaceable surface that could hide the route back to a working window is not a recovery floor. |
| Remote | Pairing, the once-shown URL, the QR and revoke: it holds credentials. |
| Profiles | Profile environment values are arbitrary secrets. |
| Keybindings | Both key recorders capture raw keystrokes in the capture phase. |
| Labels, Repositories, Web | Hand-built editors: the colour picker, filesystem paths, and drag reordering. |

General, Workspaces and Appearance are the projected sections. Each of them also carries a
host-drawn remainder, so all three report `native: true` alongside their fields and the host draws
the remainder below them. A section is fully native only when it publishes no fields at all.

| Projected section | Host-drawn remainder |
| --- | --- |
| General | The two rows that report an outcome rather than a value, the failed TCP bind line and the CLI compatibility note, plus the pointer at Workspaces and the footer naming the config file. |
| Workspaces | The pointer at General and the footer naming the config file. |
| Appearance | The preset theme gallery, the theme importer and the share codes, the chrome colour map and the agent-status colours, the terminal theme picker with its background swatch and its resolved-appearance readout, the group-band fill slider, the per-metric stat toggles, the adaptive sparkline colour, the search highlight preview, and every Reset. |

None of those is a value-and-verb row, so none of them is a descriptor a frame could carry. A
presenter draws the projected fields of the current section and leaves the space below them to the
host.

Presenter limits are the interaction presenters' limits, and mean the same things:

| Rule | Limit |
| --- | --- |
| Readiness | `reportPresenterReady()` within 5 seconds of the first frame. |
| Acknowledgement | A frame that routes to a different section, changes the set of projected fields (a row appearing or disappearing), or is the first frame after the dialog opens, is acknowledged within 5 seconds. A frame that only restates the same fields (a new value, draft, error or busy flag) arms nothing. |
| Calls | 240 presenter calls per rolling second. A breach fails the presenter. |
| Payload | 256 KiB per frame. |

Drafts live in the host, keyed to the field, so who paints is the only thing a failure changes.
A view error, a failed connection, a missed readiness or acknowledgement deadline, an oversized
or non-JSON frame and an exhausted call budget all fail the presenter. On failure the placement
latches to the bundled panel for the rest of the window session, a native failure toast is
raised, the dialog stays open on the same section, and every draft and error is still there. A
failure never commits a field. A missing, disabled or failed plugin and a disconnected daemon
resolve to bundled the same way, and the saved selection is retained throughout. The latch clears
on plugin reload or rollback, on a selection change, and on **Retry presenter** in Settings →
Plugins → Workbench views. `kelpi.window.openSettings`, `openPlugins`, `openPalette`, `openHelp`
and `restartUI`, `⌘,`, the native menu and the palette never route through a presenter.

## Automated validation

`pnpm check` covers schema validation, ownership, lifecycle resets, settings races, SDK
contracts, retained actions and prompt behavior. `node scripts/scenario.mjs plugin-ui-services --window hidden`
exercises UI Lab through a private daemon and real Electron window, and
`node scripts/scenario.mjs plugin-interaction-presenters --window hidden` drives Interaction Lab
as the selected palette and prompts presenter, including a second plugin's prompts, presenter
crash and watchdog fallback with the live request intact, disable and reload, and the phone form
factor keeping the bundled presenters. The
[validation record](plugin-validation.md) records past runs and their source revisions. Use
`--window onscreen` to inspect screenshots; a historical pass does not validate a later checkout.

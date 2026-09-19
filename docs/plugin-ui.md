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
selected to present the palette, the shared prompts or the notification stack; see
[selectable interaction presenters](#selectable-interaction-presenters).

## Selectable interaction presenters

Three placements are selected independently in Settings → Plugins → Workbench views:

| Placement | What it draws |
| --- | --- |
| `interaction.palette` | The command palette, inside the content row box, with the title bar and status footer live behind it. |
| `interaction.prompts` | Modal quick picks, inputs and dialogs, in the window's modal portal. |
| `interaction.notifications` | The plugin notification stack, in a corner box the host places and the presenter sizes. |

All three appear in `ui.getWorkbench().slots` for discovery, and `ui.selectView` refuses all
three: a prompts or notifications presenter renders other plugins' requests, so the choice stays
the user's.

[Interaction Lab](../examples/plugins/interaction-lab) is the reference presenter for all three
placements: plain JavaScript, no backend, no build. Install its directory in a private instance,
select it for any placement, and open the palette or raise a prompt or a notification from another
plugin such as UI Lab. Its README lists the diagnostics and the deliberate crash and stall hooks the
live scenario uses to prove the fallback. A listener that throws is caught by the SDK and its frame
is still acknowledged; only an uncaught view error, a missing readiness report, an
unacknowledged live frame, an undeliverable frame or a call budget breach fails a presenter.
A container cannot declare any of the three, because a presenter owns its whole overlay.
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

// interaction.notifications: settle any visible notice, and size the corner box.
await kelpi.ui.respondInteraction(notice.requestID, actionID); // null dismisses it
await kelpi.ui.setNotificationBoxHeight(stack.getBoundingClientRect().height);
addEventListener('pagehide', stop, { once: true });
```

`getInteraction()` reads the same projection once. Every call is checked against the placement
the view was selected into: the palette methods belong to `interaction.palette`,
`setNotificationBoxHeight` to `interaction.notifications`, `respondInteraction` to whichever of
`interaction.prompts` and `interaction.notifications` published the request, and a call from
another placement is refused. See the
[public types](../packages/plugin-sdk/interaction.d.ts) for every field.

Each placement receives only its own part of the surface:

| Snapshot field | `interaction.palette` | `interaction.prompts` | `interaction.notifications` |
| --- | --- | --- | --- |
| `palette` | The open session: query, scope, the whole item universe, `selectedID`, `remoteWorkspaceSelected`. Null while closed. | Always null. | Always null. |
| `paletteOpen` | Every placement. The palette outranks a queued prompt. | Every placement. | Every placement. |
| `prompt` | Always null. | The visible modal request: `requestID`, `owner`, `kind` (`quickPick`, `input` or `dialog`) and its validated options. | Always null. |
| `queued` | Always zero. | Modal requests waiting behind `prompt`. | Visible notices this frame could not carry (see the box below). Usually zero. |
| `notifications` | Always empty. | Always empty. | The visible notices, oldest first, at most four and as many as fit one frame: `requestID`, `owner`, and `message`, `detail`, `tone` and `actions`. |
| `visible`, `formFactor` | Every placement. `visible: false` means present nothing. | Every placement. | Every placement, and `visible` is false whenever the stack is empty. |

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
| Acknowledgement | Each frame carrying a new prompt, a new palette session or a notification that was not in the previous frame is acknowledged within 5 seconds. A frame that only drops an expired notice arms nothing. |
| Calls | 240 presenter calls per rolling second. A breach fails the presenter. |
| Payload | 256 KiB per frame; a palette query of at most 1,024 characters. |
| Notification box | A declared height of 0 or more, clamped to 45% of the window height. |

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
way.

### The notification box

A notification is not modal: it is a corner box over a window that stays usable, so the geometry
is split. The host draws the frame exactly where the bundled stack sits - the window's
bottom-right corner, 40 px up and 12 px in, at most 360 px wide - and registers the rect it covers
so the web panes underneath park and no others do. A presenter never registers a window modal.

The height is the presenter's: `setNotificationBoxHeight(pixels)` declares what its own cards
need, and the host clamps it to the smaller of two ceilings.

| Ceiling | Value | Why |
| --- | --- | --- |
| Window | 45% of the window height | A corner box may not grow into a window modal that nothing registered. |
| Content | 200 px per visible notice | A presenter is a plugin like any other and can raise its own notification every ten seconds, so a declaration alone must not be able to hold a box bigger than the cards in it: that box is a transparent rect that swallows clicks, parks the pages under it, and covers the native toast stack it shares the corner (and `z-40`) with, including the toast that says a presenter has failed. |

Before a presenter declares anything the host budgets 96 px per visible notice, so a first notice
is never drawn into a box of no height, and a stack taller than its box scrolls inside it. A
declaration belongs to the view that made it: a reload, a **Retry presenter** or a different
selection drops it, and the next presenter starts at the default again. The frame is not painted
at all while `notifications` is empty, so an idle stack intercepts no clicks and parks no pages,
and the selected view stays mounted and hidden so the first notice costs no attach - which is also
why a presenter should declare nothing while the stack is empty, since an unpainted frame measures
zero.

A frame is bounded at 256 KiB like every other, and the option limits are character limits: a
maximal notice (2,048 characters of message, 8,192 of detail, eight actions) serializes to about
77 KiB once JSON expands its control characters, so four of them do not fit. The host carries the
notices that fit, in visible order, and counts the rest in `queued`; a withheld notice keeps its
ID and its expiry clock, cannot be answered by a presenter that was not shown it, and arrives in a
later frame as earlier ones are settled. The alternative - letting the frame burst - would fail the
placement and latch the user's chosen presenter out over somebody else's notification.

Expiry stays host-owned. The 10 second clock runs from the moment a notice enters the visible
stack, the host settles it with null, and the notice simply leaves the next frame; a presenter
runs no clock and cannot extend one. `respondInteraction(requestID, actionID)` settles a notice
the published projection carries and `null` dismisses it, exactly as the bundled card's × does;
any other id is refused, including the prompts placement's visible request.

Native toasts are not projected. A daemon notification, a failed command and a presenter failure
are host chrome drawn by the window's own toast stack, and a notifications presenter is told
nothing about them: only plugin `ui.showNotification` requests reach it. Withheld exactly as the
prompts placement withholds: no `pluginID`, no verb name, an owner is a display name and an opaque
window-local ref.

## Selectable Settings presenter

One further placement, `settings.window`, is selected in the same Settings → Plugins → Workbench
views list. A selected view draws the rail and the panel inside the host's Settings dialog. The
host keeps the dialog frame and backdrop, modal presence, Escape and Close, the Tab trap, focus
capture and release, the reopen focus rule and the native sections.

The placement appears in `ui.getWorkbench().slots` for discovery and `ui.selectView` refuses it:
Settings is where a broken presenter is recovered from, so the choice stays the user's. A
container cannot declare it, because a presenter owns the whole dialog body.
[Settings Lab](../examples/plugins/settings-lab) is the reference presenter: plain JavaScript, no
backend, no build. Install its directory in a private instance, select it for `settings.window`,
and open Settings; its README lists the diagnostics and the crash and stall hooks that
`node scripts/scenario.mjs plugin-settings-presenter --window hidden` uses to prove the fallback. Presenters are
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

## Pane chrome

Every pane wears a 24 px header: a status dot or a type glyph, a label chip, a middle-truncated
title, the ZOOM and SYNC badges, an agent badge, a git branch chip, the per-kind controls, the
split controls and the close ✕. The placement that will replace it is `pane.chrome`, one presenter
for every pane kind, and **this release ships both phases: the shared model, the height authority,
parking and the projection (phase A), and the selectable presenter, its fallback, its watchdogs and
the Pane Lab example (phase B).** A view selected for it in Settings → Plugins → Workbench views
draws the header band of every visible pane of the displayed workspace. Selection is Settings-only:
the placement appears in `ui.getWorkbench().slots` and `ui.selectView` refuses it, because a header
presenter draws every pane's close ✕ and every other plugin's `pane.header` items.

### The shared model

`packages/client/src/pane-chrome/` is the pane-header sibling of the shared settings model. One
closure-free descriptor per pane carries everything the bundled header draws - the pane id, kind
and status, the title and the split that middle-truncates it, the home-abbreviated directory, the
label, the branch and its change counts, the agent's kind, elapsed and background tasks, the zoom,
sync and focus flags, the painted band height, the size-control state (which badges this width
seated and how many controls folded), the trailing control row, and other plugins' `pane.header`
items as descriptors. One surface owns every action the header performs: focus, split, zoom,
rename, close, run a control, run an item, open the pane menu. Ids in, no closures out, and every
call re-resolved against a fresh model, so a control that went disabled or disappeared between the
render and the click refuses instead of running.

The bundled `PaneHeader` draws from that descriptor and acts through that surface and nothing else.
Its DOM, its class names and every `data-testid` are unchanged, which the PaneHeader and grid
suites assert unmodified.

Three things stay host-drawn, for the reasons the Settings dialog keeps its native sections: the
inline rename FIELD (the caret is the host's), the pane context menu and the `•••` (portals with
their own overlay registration), and the box another plugin's items are rendered into as text.
`renamePane` opens the host's field; `closePane` routes through the host's existing confirmation.
A presenter never draws a host-owned text input or a destructive confirmation.

### Height authority

The band is the one thing a presenter declares that the host has to act on, so it follows the
notification box's rule exactly: **the presenter declares, the host clamps, and the native value
applies until something is declared.**

| Ceiling | Value | Why |
| --- | --- | --- |
| Fixed | 96 px | Four native bands. Enough for the two-line header a real plugin asks for, nowhere near enough to take a terminal's visible lines. |
| Pane | 25% of that pane's height | A 96 px band over a 140 px pane is a pane that is mostly chrome, so the same declaration is honoured in full on a tall pane and cut down on a short one rather than refused. |

The smaller of the two wins and the floor is 0. `paneChromeHeight(null, …)` returns the host's own
band **without** consulting a ceiling, which is the one deliberate difference from
`notificationBoxHeight`: a short pane's ceiling is below 24, so clamping the undeclared default
would shrink the bundled header - and resize the PTY under it - on a pane nobody has asked anything
of.

`setPaneChromeHeight(paneID, pixels)` has three inputs and three answers, and the store and the
clamp give the same ones:

| Declared | Answer |
| --- | --- |
| `null` | Withdrawn. The pane is back on the native band next frame, and a presenter can hand one back without being torn down. |
| A negative number | 0, which is a legal band. The clamp already said `[0, ceiling]`, so this agrees with it rather than inventing a second rule. |
| NaN or an infinity | Refused; the current band stands. They are not heights, there is nothing to clamp them to, and treating them as a withdrawal would make one arithmetic slip inside a presenter look exactly like a deliberate hand-back. |

A declaration also goes back on its own. Every pane withdraws its band when its chrome unmounts,
and the whole store is emptied when the grid changes the workspace it is showing or goes away
(a workspace switch, a remote workspace selected, the mirror emptying under a dropped connection).
Without that a closed pane's entry would outlive it forever, and the cost is not a map entry: the
daemon can hand a new pane the id a closed one had, and a workspace switched away from and back
would apply the stale band on the first frame, before any presenter could re-declare, which is a
live PTY resized against a band nobody asked for.

The host owns the declarations in a per-pane store, and `PaneGrid`'s body rect uses the clamped
value. Everything downstream follows the band without being told: the header is a fixed-height row
and the body is the `flex-1` under it, so a terminal's cols and rows (the body box divided by the
cell size) and a web pane's native DIP bounds both move with it. A declaration belongs to the view
that made it - a reload, a different selection or a fallback drops every one of them at once, which
is what keeps decision 8's all-or-nothing fallback from leaving a PTY sized against a dead header.

### Web panes and parking

Nothing in the document composites above a native `WebContentsView`, so a band drawn into pixels
the page still holds is invisible. A declared band taller than the native one over a web pane
therefore enrols itself in the host's overlay registry, and the pane parks its page exactly as it
does for the `•••` menu.

Only a band that is **on screen** enrols. `PaneGrid` never unmounts a pane to hide it: a zoomed-out
pane, and every pane of a workspace the window is not showing, keeps its DOM at its last known rect
under `visibility: hidden`, and that rect is still what the overlay registry would measure. With
two web panes both declaring a band and one of them zoomed, an unconditional registration would put
the hidden pane's band inside the visible pane's page hole and park the page the user is actually
looking at, for the whole length of the zoom. A band nobody can see covers nothing, so it registers
nothing.

At rest the two boxes are adjacent rather than overlapping - the page hole begins where the band
ends - so the registration costs nothing once the geometry settles. Measured with a temporary 96 px
declaration on a live web pane: the band grew from 24 px to 96 px, the body moved down by exactly
72 px, the native view moved from `753,88 525×706` to `753,160 525×634` in one `moved` placement
with **zero parks**, the page stayed live throughout (`data-visible="true"`,
`data-overlay-covered="false"`), a click in the page area still reached the pane, and withdrawing
the declaration restored both the 24 px band and the original bounds. Decision 5's fallback - web
panes keeping the native header - is therefore not needed.

### The frame

One frame carries every visible pane of the displayed workspace, with the focused and zoomed pane
named once at the top, bounded at 256 KiB like every other frame. A pane's title is whatever its
shell last wrote to the terminal's OSC, so a workspace can overrun the budget; an oversized frame
is undeliverable and an undeliverable frame fails the placement, which would latch the user's
chosen presenter out over somebody else's window title. So the frame **stops at the first pane that
does not fit** and counts that pane and every pane after it in `withheld`. The panes carried are
always a prefix of the workspace, in its own order, so `withheld` means "everything after these" -
a presenter can draw a header row from that, and could not from an arbitrary subset with one wide
pane dropped and a narrow one three places later carried. A withheld pane keeps its native header,
exactly as a withheld notice keeps its expiry clock.

Withheld: absolute paths beyond the home abbreviation, PTY handles and pids, agent session ids,
every other plugin's `pluginID`, the command behind any control or item, connection URLs and a web
pane's page URL, every run closure, and the `data-testid` of every control.

A control and an item are a display name, an icon, an enabled flag and an opaque **ref**. The ref
is what makes the rest of that list true: a contribution id is `<pluginID>.<name>`, so publishing a
control under its own key would name the owner and the verb in the same breath as saying they are
withheld. Refs are scoped to their pane and assigned per KEY rather than per row position, the host keeps the
mapping privately (exactly as `settings/sections.ts` keeps a field's write target), and a
well-formed ref the current row does not hold resolves to nothing. The position version was a
defect: `c0` meant "whatever is first in this row", a click is always painted from a frame at least
one commit old, and a plugin command arriving at the head of the row therefore made a press on Split
right run Close. A token now names one control of one pane for that pane's life, so a late click
either activates the control it was drawn on - which `surface.runControl` re-resolves against a
fresh model and refuses if it has gone or gone disabled - or activates nothing. Both halves of the row are reachable and each
only through its own call: `activatePaneControl(paneID, ref)` presses a control - the host's own
`copy`, `edit`, `refresh`, the splits, the globe and the ✕, or another plugin's `pane.header`
command button - and `runPaneHeaderItem(paneID, ref)` activates one of the chips in the host's box.
Whatever a ref resolves to is then re-resolved against a fresh model before it runs, so a control
that went disabled or disappeared between the frame and the press refuses rather than firing.

Native by decision, whatever is selected: the focus ring, the pane context menu, the rename field,
every destructive confirmation, the dividers, the resize badge, the terminal's mirror clip wash and
the find bar. Pane chrome presenters are desktop-only: a phone window keeps its own header, which
owns the software-keyboard inset a presenter cannot read, so a frame reports
`formFactor: 'desktop'`.

The [public types](../packages/plugin-sdk/pane-chrome.d.ts) describe the frame and the presenter
calls (`focusChromePane`, `splitPane`, `toggleZoom`, `renamePane`, `closePane`,
`activatePaneControl`, `runPaneHeaderItem`, `openPaneMenu`, `beginPaneDrag`, `setPaneChromeHeight`
and the shared `reportPresenterReady`), and `WindowPaneChromeAPI` is part of `ViewAPI.ui`.

The focus call is `focusChromePane` and not phase A's declared `focusPane`. `ViewAPI['ui']` already
has `focusPane(workspaceID, paneID)`, so intersecting the two would have made one name with two
overloads and left `browser.js` dispatching on argument count - a plugin that passed one argument
by mistake would silently have called the other verb. Nothing else in the contract collides.

A container cannot declare `pane.chrome`, for the reason the interaction placements refuse one: a
presenter owns one 24 px band per pane, a container's own chrome is a slot-picker header, and there
is no room for it in a band that size.

### The geometry: one frame, clipped per pane

A pane chrome presenter draws a header for every visible pane, and the panes are scattered across a
grid. Two shapes were possible and they are not equivalent.

| | One frame over the grid, host-clipped | One frame per pane |
| --- | --- | --- |
| View instances | 1 | N |
| Plugin attaches, leases, sandboxed documents | 1 | N |
| Feeds and acknowledgement streams | 1 | N |
| Readiness watchdogs and failure latches | 1 | N, coordinated for an all-or-nothing fallback |
| Can a narrow pane's header take its neighbours into account? | Yes - one frame carries them all | No |

An absolutely positioned iframe per pane cannot be drawn by ONE view, so the second shape is N view
instances. **The first is what ships.** `PaneGrid` mounts one `PluginView` over its own container,
so the frame's coordinate space is the grid's, and each pane's band rectangle travels in the frame
(`rect`) for the presenter to position a header at. The host applies a `clip-path` built from those
same rectangles, which removes the frame from paint AND from hit testing everywhere else: a click
below a band reaches the terminal under it, and a press on a divider reaches the divider.

Measured on the live window (`plugin-pane-chrome`, six-pane workspace): **one** iframe for the whole
grid, one lease, one feed, readiness reported in well under the 5 s window, and the whole scenario -
attach, 27 checks, two failure-and-retry cycles, a daemon restart and a phone round trip - in about
13 s. The second shape would have paid one plugin attach, one sandboxed document and one feed per
pane, and would have had to keep N latches in step to honour decision 8's all-or-nothing.

Two costs, stated plainly:

- **The frame carries each band's rectangle.** That is the layout the user is already looking at,
  in CSS px, with the origin at the grid's top-left, so it says nothing about where the window is or
  what else is on the display. It is the price of one view drawing N headers.
- **The pane-move drag needs one extra call.** It is raised from the native header's
  `onPointerDown`, and a presenter's own pixels cannot raise it - so `beginPaneDrag(paneID)` says
  that the press just made in a band was the start of one. The host then takes pointer events back
  from every frame in the grid (the class it already applies for a native drag), reads its origin
  from the first move it sees, draws its own drop zones and commits through its own verb. Nothing
  about the gesture is the presenter's, and nothing about it is lost.

The band itself stays the host's, always. `PaneGrid` lays a pane's body out under a fixed-height
row, so the row has to exist whoever is painting in it: the host paints its fill and its hairline,
enrols it in the overlay registry when it is a taller band over a web pane, withdraws its
declaration when the pane goes, and keeps the focus-on-press. The presenter's rectangle is inset by
the focus ring's 2 px on three sides and by the hairline's 1 px on the fourth, exactly as a web
pane's page hole reserves the ring's gutter, so nothing a presenter draws can paint over the ring.

While a presenter draws a pane's band, that pane's bundled header keeps the box and gives up
everything it painted - the glyph, the chips, the title, the contributions box and the whole
trailing control row. `data-testid="pane-header-<id>"` is unchanged (the audit harness counts panes
with it in eleven places) and `data-presented` is what says who is painting.

### Selection, watchdogs and fallback

The bundled header draws on every pane whenever any of these holds, checked in this order:

1. presenters are disabled for this grid (the phone, and every standalone render);
2. no plugin is selected for the placement - which covers a plugin that is missing, disabled or
   failed, because `viewRegistry` filters those out and `resolveSlot` lands on the bundled default.
   The user's selection is retained across all of it;
3. the daemon connection is not up;
4. this generation has failed. `generation` is `viewID:revision:instanceID`, so a reload, a rollback
   or a different selection clears the latch by moving the generation; nothing else does except the
   explicit **Retry presenter** on the `pane.chrome` row in Settings → Plugins → Workbench views.

Two watchdogs, on the interaction presenters' numbers: **5 s** to report having painted after the
first frame, and **5 s** to acknowledge a frame whose SHAPE moved - a pane opened or closed, the
workspace changed, the rename field went up, the withheld count moved. A frame that only carries new
geometry or a new title is not waited for: a divider drag moves every rect at pointer rate and a
shell rewrites its title whenever it likes, and a working presenter must not be failed for being
busy. The call budget is 240 calls per rolling second, and a breach fails the placement as well as
rejecting the call.

Failure is **all-or-nothing** (ratified decision 8), and the reason is geometry rather than
tidiness: a band belongs to a pane's body rect, which is what a PTY's cols and rows and a web pane's
native bounds are computed from. Failing one pane back to 24 px while another kept a declared 96
would leave a live shell sized against a header nobody is drawing. So a failure clears every
declaration at once and every pane is back on the native band in the same commit, with a failure
toast and the Settings row reading `Failed: …`.

Two things lift a pane ABOVE the presenter's frame, and for one reason: host chrome the user has to
reach cannot be under an iframe. The **inline rename field**, while it is up - the host takes that
band back in full and the frame still says `renaming: true`, so the presenter knows the title is not
its to draw. And the **pane search overlay**, which is `absolute right-2 top-2 z-30` inside the pane
wrapper: a `z-30` inside a `zIndex: 1` stacking context cannot reach past a sibling at 2, so the
band covered the find bar's top edge at 24 px and swallowed it whole under a declared one.

The **caret** never stays in a band either. A click on a control inside the frame moves focus into
an iframe that claims no chords, so from that moment typing, Escape, the palette and every window
chord went into a sandbox that dropped them. The host hands the caret straight back to the focused
pane, which is what the bundled header gets for free by being made of buttons.

A **declared band belongs to a carried pane**, and the host enforces both ends of that. A pane that
leaves the frame - withheld by the byte budget, zoomed out, gone from the workspace - has its
declaration withdrawn, because a bundled 24 px header floating inside a 96 px band is a live PTY
sized against chrome nobody draws. And a presenter may hand a band back for any pane whose header is
still mounted, carried or not: refusing a WITHDRAWAL for a pane that had left the frame left the
presenter holding a declaration it could never undo. Standing the placement down - choosing the
bundled header, disabling the plugin, uninstalling it - drops every declaration in the same commit
that unmounts the presenter.

`changes` is filled from the same `footerGitStats` the status footer draws `doc N +A -B` from,
matched per pane by the longest worktree path containing the pane's canonical working directory. The
bundled header draws a branch chip and no counts, exactly as before; the numbers exist in the model
so a presenter can draw them.

### Review follow-up

An independent review of phase A landed seven changes on top of the first cut, each recorded here
because each was a rule stated one way and implemented another:

- **A hidden pane's band no longer parks a visible pane's page.** The enrolment was unconditional
  and `PaneGrid` keeps hidden panes mounted at their last rect, so a zoomed-out web pane's band lay
  inside the zoomed one's page hole.
- **The frame's refs are opaque.** A control's key and an item's id were published verbatim, and
  for another plugin's contribution both of those name the owner - the one thing the withheld list
  promises they do not.
- **Controls have an activation path.** Only `items` had a call behind it, so every host control
  and every plugin command button was published with no way to press it; `activatePaneControl` is
  the other half.
- **Declarations are withdrawn.** The store only ever grew, so a closed pane's band outlived it and
  came back on a workspace switch.
- **Containers cannot declare `pane.chrome`**, as they cannot declare the other presented
  placements.
- **The store and the clamp agree** on what a negative and a non-finite declaration mean, and the
  contract has `null` for withdrawal.
- **The budget cut is a prefix**, not a subset.

Two more were cleanups rather than defects: the `pane.header` items are resolved once per pane per
render instead of twice (the grid re-resolves on every render, divider drags included), and the
contributions box takes its presence and its count from the one list rather than from the rendered
node and the list separately.

### Phase B review follow-up

An independent review found ten things, and the onscreen screenshots an eleventh. The three that
mattered most were all the same shape - a rule stated one way and enforced somewhere it could not
run: declared bands survived every stand-down because the branch that dropped them lived in a
component that unmounts on exactly that move; every pane was headerless from the moment a plugin was
selected until it first painted, because the swap keyed on the selection rather than on the
presenter's own readiness; and the terminal find bar was painted over by the band, because a `z-30`
inside a `zIndex: 1` pane wrapper cannot reach past a sibling at 2. Two more were contracts that did
not hold: a ref was a row position, so a click painted one commit ago could activate its neighbour,
and a band could never be withdrawn once its pane left the frame. The caret, the pane-move drag and
a failure latch that outlived its selection are in the sections above.
`docs/plugin-validation.md` has the table, item by item, with the test that holds each one.

### Pane Lab

[Pane Lab](../examples/plugins/pane-lab) is the build-free example: one view for `pane.chrome`
drawing a band per carried pane from the frame, declaring a two-line band on panes at least 420 px
wide and handing it back when they narrow, routing focus, zoom, the menu, the controls and the other
plugins' items through the calls, and printing the withheld count. Its README has the test ids and
the diagnostics, including the deliberate `crash(mode)` and `stall()` hooks the live scenario uses
to drive the two watchdogs.

## Automated validation

`pnpm check` covers schema validation, ownership, lifecycle resets, settings races, SDK
contracts, retained actions, prompt behavior and the pane chrome model, height clamp, parking
predicate, frame bound, band geometry and presenter host. `node scripts/scenario.mjs
plugin-ui-services --window hidden` exercises UI Lab through a private daemon and real Electron
window; `node scripts/scenario.mjs plugin-interaction-presenters --window hidden` drives Interaction
Lab as the selected palette and prompts presenter, including a second plugin's prompts, presenter
crash and watchdog fallback with the live request intact, disable and reload, and the phone form
factor keeping the bundled presenters; and `node scripts/scenario.mjs plugin-pane-chrome --window
hidden` drives Pane Lab as the selected header presenter, including a withheld pane keeping its
bundled header, another plugin's item activated by ref, a declared 96 px band measured against the
shell's own `stty size` and a web pane's native bounds, forged and cross-pane refs refused, the
all-or-nothing fallback with its toast and Retry, a daemon restart and the phone keeping its own
header. The
[validation record](plugin-validation.md) records past runs and their source revisions. Use
`--window onscreen` to inspect screenshots; a historical pass does not validate a later checkout.

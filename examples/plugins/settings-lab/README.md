# Settings Lab

A build-free, UI-only Settings presenter. **Settings Lab** draws the rail and the panel of the
window's Settings dialog for `settings.window`. The view uses `window.kelpi.ui` only, receives its
state from `onSettingsPresentation`, and has no backend, no native imports and no access to the host
DOM.

First [prepare the source checkout](../../../docs/plugin-development.md#prepare-a-source-checkout),
then start an isolated instance from its root:

```sh
node scripts/dev-instance.mjs --state out/plugin-settings-playground
```

In its Settings → Plugins, install the absolute path to `examples/plugins/settings-lab`, then pick
**Settings Lab** for `settings.window` in **Workbench views**. The placement is Settings-only: it
appears in `ui.getWorkbench().slots`, but `ui.selectView` refuses it, because Settings is where a
broken presenter is recovered from and the choice has to stay the user's. The entry marked
**(bundled)** in that select is the recovery floor: choosing it hands the dialog back on its own,
without **Restore bundled views**. Keep using that instance's CLI and socket so testing stays
separate from your installed Kelpi.

## What it does

The rail comes from `sections`, every entry of it, and clicking one routes the host through
`setSettingsSection`. `section.icon` is an SF Symbol name rather than a glyph, so the view maps the
names it knows to its own drawing and leaves an unknown one blank, with the name still on the cell
for anyone reading the DOM.

The panel is the routed section: a card per entry in `groups`, holding the fields that named it in
`groupID`, drawn by `kind` - a switch, a text box, a number box, a picker, a segmented row, a range
slider and a `#rrggbb` text box. Each row renders the field's `draft`, its `error`, its `busy` flag
while a write is in flight, and its `disabled` state. Typing holds a value with `setSettingsDraft`
and writes nothing; **Commit** asks for the write with `commitSettingsField` and **Reset** drops the
draft with `resetSettingsField`. The controls that have no draft phase - a switch, a picker, a
segment - hold and commit in one gesture, which is what the bundled panel does. Enter commits a text
or number row. A field whose `groupID` names no card in the frame is drawn in one of its own rather
than dropped. The header counts the fields holding a draft across every section, and **Close** is
`closeSettings`, the dialog's own Close.

Every control is re-dressed on every frame, not only when its row is built: the label, a text row's
`maxLength`, a number's `min`/`max`/`step` and a picker's `choices` are all republished each time,
so a control never goes on describing a field the host has since changed.

Nothing leaves the view that the frame said was out of bounds. A text draft is capped at the field's
own `maxLength`, a choice can only be one the field published in `choices`, a number is clamped into
`min`/`max` and snapped onto `step`, a colour has to be `#rrggbb`, a control character is never sent
into a line-oriented config file, and a `disabled` field is drawn and not edited. When what was sent
is not what was typed, the row says so, and `change` and `blur` catch the box up with the value the
host is actually holding: a box showing one thing while the host holds another is worse than a
visible correction. A refusal the view made itself is drawn differently from one the host sent back,
and both are pruned when the field they belong to leaves the frame.

The two dragged kinds coalesce. A range drag fires one `input` event per pixel and the presenter
budget is 240 calls per rolling second, so a number or slider draft waits about 50 ms and sends
once. **Commit**, Enter, `change` and `blur` each flush whatever is waiting before they act, so a
click that lands inside that window still commits the value just dragged to.

A frame with `visible: false` means present nothing: the panel is emptied, every `data-testid` this
view owns comes off, and the drafts stay where they live, in the host.

## What it does not do

There is no config key, verb name, file path or write closure anywhere in this plugin. A field is
named by an opaque, window-local id and the host owns the mapping, so nothing this view can say
bypasses the daemon's writable-key allowlist. The host also keeps everything that makes the dialog a
dialog: the frame and the backdrop, the modal presence, Escape and Close, the Tab trap, the focus
capture and release, and the reopen focus rule. A presenter routes and edits; it never opens the
window, and it cannot invoke a destructive action, which stays a native button the host draws.

Some sections are drawn by the bundled panel whatever is selected. Plugins in full (Versions and
rollback, **Restore bundled views**, **Retry presenter**, enable and disable, providers, shortcuts
and plugin schema fields), Remote, Profiles, Repositories, Labels, Keybindings and Web report
`native: true` with no groups and no fields, and the lab draws the rail entry and the note rather
than pretending to the panel. The route to switching a presenter off must never depend on the
presenter.

General, Workspaces and Appearance are the projected sections, and each of them also carries a
host-drawn remainder, so all three report `native: true` **alongside** their fields. The lab draws
what `fields` lists and leaves the space below it to the host:

| Projected section | What the lab cannot draw |
| --- | --- |
| General | The two rows that report an outcome rather than a value (the failed TCP bind, the CLI compatibility note), the pointer at Workspaces, and the footer naming the config file. |
| Workspaces | The pointer at General and the config-file footer. |
| Appearance | The preset theme gallery, the theme importer and the share codes, the chrome colour map and the agent-status colours, the terminal theme picker with its background swatch and resolved-appearance readout, the group-band fill slider, the per-metric stat toggles, the adaptive sparkline colour, the search highlight preview, and every Reset. |

Presenters are desktop-only in this release, so a phone window keeps the bundled sheet and never
selects one: a frame this view receives always reports `formFactor: 'desktop'`.

## Recovery, on purpose

The bundled panel is the recovery floor and cannot be selected away. The view exposes two deliberate
failure hooks on `globalThis.settingsLab`, so the recovery paths can be driven without a message
channel:

| Hook | Effect |
| --- | --- |
| `settingsLab.crash()` | The next `onSettingsPresentation` callback throws. The arming is cleared by that frame, so exactly one frame is affected: nothing at all is drawn for it, and the frame after it renders normally. The SDK catches a listener error, so the host still receives that frame's acknowledgement and sees no failure. Armed before the FIRST frame, that frame reports no readiness either, because readiness is claimed by the render it never reached. The frame after it renders and reports readiness as usual, so the 5 second readiness watchdog only takes the dialog back if no further frame arrives first. |
| `settingsLab.crash('uncaught')` | The same one frame, and the error is also rethrown where nothing catches it, which the SDK reports as a view error and the host fails on immediately, whichever frame it was. |
| `settingsLab.stall()` | Every frame from the next one on returns a promise that never settles, so nothing is acknowledged and the 5 second acknowledgement watchdog takes the dialog back. Only a frame that moves to a different section, changes the set of projected fields, or is the first after the dialog opens, arms that watchdog; a frame restating the same fields arms nothing. |

A failure never commits a field and never loses one. The bundled panel takes the placement back for
the rest of the window session, the dialog stays open on the same section, every draft and every
error is still there, a native failure toast is raised, and **Retry presenter** appears beside the
selection in Settings → Plugins → Workbench views. `globalThis.settingsLab` also carries `snapshot`,
`frames`, `ready` and `lastError`, and `document.body.dataset` carries `ready`, `visible` and
`section`.

The test ids this view publishes, all of them present only while it is painting:

| Test id | What it marks |
| --- | --- |
| `lab-settings` | The whole shell. Its presence is the signal that this presenter is drawing. |
| `lab-settings-rail` | The rail. |
| `lab-settings-rail-item` | One rail entry, with `data-section-id`, `data-native` and `aria-current`. |
| `lab-settings-field` | One field row, with `data-field-id`, `data-kind`, and `data-draft` / `data-busy` / `data-disabled` / `data-error` as the frame reports them. |
| `lab-settings-input` | The row's control. One per row, except a segmented row, where each segment carries it with its own `data-value`. |
| `lab-settings-commit`, `lab-settings-reset` | The row's two buttons, each also carrying `data-field-id`. |
| `lab-settings-dirty` | The count of fields holding a draft, with `data-count`. |
| `lab-settings-native-note` | The note that the host draws the rest, with `data-native` of `remainder` or `full`. |
| `lab-settings-close` | The dialog's own Close. |

From the checkout root, run `kelpi_test plugin dev examples/plugins/settings-lab --trust` while
editing. Compatible retained revisions are available in Settings → Plugins → Versions; reload
restarts only installed bytes.

The contract and its limits are in [the UI guide](../../../docs/plugin-ui.md#selectable-settings-presenter),
and the public types in [settings.d.ts](../../../packages/plugin-sdk/settings.d.ts).
Unit coverage: `npx vitest run packages/client/src/features/settings-lab.test.ts`. See the
[plugin roadmap](../../../docs/plugin-roadmap.md) for overall progress and the
[validation record](../../../docs/plugin-validation.md) for dated results.

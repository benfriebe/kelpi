# Interaction Lab

A build-free, UI-only pair of interaction presenters. **Interaction Lab palette** draws the command
palette for `interaction.palette` and **Interaction Lab prompts** draws modal quick picks, inputs and
dialogs for `interaction.prompts`. Both views use `window.kelpi.ui` only, receive their state from
`onInteraction`, and have no backend, no native imports and no access to the host DOM.

First [prepare the source checkout](../../../docs/plugin-development.md#prepare-a-source-checkout),
then start an isolated instance from its root:

```sh
node scripts/dev-instance.mjs --state out/plugin-interaction-playground
```

In its Settings → Plugins, install the absolute path to `examples/plugins/interaction-lab`, then
pick **Interaction Lab palette** for `interaction.palette` and **Interaction Lab prompts** for
`interaction.prompts`. Both placements are Settings-only: they appear in
`ui.getWorkbench().slots`, but `ui.selectView` refuses them, because a prompts presenter renders
other plugins' requests. The entry marked **(bundled)** in each of those two selects is the recovery
floor: choosing it hands that placement back on its own, without touching the other one and without
**Restore bundled views**. Install `examples/plugins/ui-lab` beside it to raise real prompts from
another owner. Keep using that instance's CLI and socket so testing stays separate from your
installed Kelpi.

## What it does

The palette view renders the session's whole item universe and applies the matching rule itself: a
`w:`/`p:` prefix picks the scope the snapshot reports, then each term must appear in the row's
title, subtitle or workspace name. Arrows move the selection, clamped and never wrapping, Enter
activates, typing goes to the query field, and a click activates a row. Selection and query changes
go back to the host, which owns both; activation goes back as an id, which the host re-resolves
against a fresh read and runs at most once. Disabled rows never activate. The session's
`remoteWorkspaceSelected` is drawn as a badge. Escape and the rebindable Close chord reach the host,
and Escape also dismisses through `dismissPalette` here, so one path closes the palette either way.

The prompts view renders the one visible request: a quick pick with its own filter field and its
enabled and disabled rows, an input with its prompt, placeholder, initial value and `maxLength`, or a
dialog with its actions and its cancel action. It shows `owner.displayName` and the count of requests
queued behind the visible one. Choosing answers with `respondInteraction`; **Cancel** answers null,
which cancels. A frame with `visible: false`, or with no request in it, renders nothing.

## What it does not do

Notifications and password inputs stay bundled in this release. A prompts presenter presents the
three modal kinds only: `notifications` is always empty, a `showInput({ password: true })` request
reports `prompt: null` while `queued` still counts it, and native destructive confirmations are
carved out the same way. Presenters are desktop-only, so a phone window keeps the bundled ones and
the snapshot's `formFactor` says why. Neither view opens the palette, holds focus authority, sees a
`pluginID`, a command handler or an owner's identity beyond an opaque window-local ref, or registers
a modal presence: the host keeps all of that whoever is drawing.

## Recovery, on purpose

The bundled presenter is the recovery floor and cannot be selected away. Each view exposes two
deliberate failure hooks on `globalThis.interactionLab`, so the recovery paths can be driven without
a message channel:

| Hook | Effect |
| --- | --- |
| `interactionLab.crash()` | The next `onInteraction` callback throws. The arming is cleared by that frame, so exactly one frame is affected: nothing at all is drawn for it, and the frame after it renders normally. The SDK catches a listener error, so the host still receives that frame's acknowledgement and sees no failure. Armed before the FIRST frame, that frame reports no readiness either, because readiness is claimed by the render it never reached. The frame after it renders and reports readiness as usual, so the 5 second readiness watchdog only takes the placement back if no further frame arrives first. |
| `interactionLab.crash('uncaught')` | The same one frame, and the error is also rethrown where nothing catches it, which the SDK reports as a view error and the host fails on immediately, whichever frame it was. |
| `interactionLab.stall()` | Every frame from the next one on returns a promise that never settles, so nothing is acknowledged and the 5 second acknowledgement watchdog takes the placement back. |

A failure never settles a request: the live request keeps its id, the bundled presenter re-presents
it, the palette session is dismissed with reason `presenter-failed`, and **Retry presenter** appears
beside the selection in Settings → Plugins → Workbench views. `globalThis.interactionLab` also
carries `snapshot`, `frames`, `ready` and `lastError`, and `document.body.dataset.ready` becomes
`true` once `reportPresenterReady()` has resolved.

From the checkout root, run `kelpi_test plugin dev examples/plugins/interaction-lab --trust` while
editing. Compatible retained revisions are available in Settings → Plugins → Versions; reload
restarts only installed bytes.

The contract and its limits are in [the UI guide](../../../docs/plugin-ui.md#selectable-interaction-presenters),
and the public types in [interaction.d.ts](../../../packages/plugin-sdk/interaction.d.ts).
Unit coverage: `npx vitest run packages/client/src/features/interaction-lab.test.ts`. See the
[plugin roadmap](../../../docs/plugin-roadmap.md) for overall progress and the
[validation record](../../../docs/plugin-validation.md) for dated results.

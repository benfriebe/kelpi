# Interaction Lab

A build-free set of three interaction presenters, plus a backend command that asks through them.
**Interaction Lab palette** draws the
command palette for `interaction.palette`, **Interaction Lab prompts** draws modal quick picks,
inputs and dialogs for `interaction.prompts`, and **Interaction Lab notifications** draws the
corner notification stack for `interaction.notifications`. All three use `window.kelpi.ui` only,
receive their state from `onInteraction`, and have no native imports and no access to the host
DOM. The backend is one command, described in [Asking from a backend](#asking-from-a-backend).

First [prepare the source checkout](../../../docs/plugin-development.md#prepare-a-source-checkout),
then start an isolated instance from its root:

```sh
node scripts/dev-instance.mjs --state out/plugin-interaction-playground
```

In its Settings → Plugins, install the absolute path to `examples/plugins/interaction-lab`, then
pick **Interaction Lab palette** for `interaction.palette`, **Interaction Lab prompts** for
`interaction.prompts` and **Interaction Lab notifications** for `interaction.notifications`. All
three placements are Settings-only: they appear in `ui.getWorkbench().slots`, but `ui.selectView`
refuses them, because these presenters render other plugins' requests. The entry marked
**(bundled)** in each of those three selects is the recovery floor: choosing it hands that placement
back on its own, without touching the others and without **Restore bundled views**. Install
`examples/plugins/ui-lab` beside it to raise real prompts and notifications from another owner. Keep
using that instance's CLI and socket so testing stays separate from your installed Kelpi.

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

The notifications view renders the visible stack, oldest at the top, each card with its owner, its
tone, its message, its detail and its actions. An action answers with its id; **×** answers null,
which is the same settle a dismissal has always been. The host draws the frame in the window's
bottom-right corner at the bundled stack's own rect and paints it only while the stack has something
in it, so this view declares just its HEIGHT, measured from its cards, through
`setNotificationBoxHeight` - and the host clamps that to 45% of the window. The ten second expiry is
the host's: a notice that times out is settled with null and leaves the next frame, so this view
runs no clock of its own.

## What it does not do

Password inputs stay bundled: a `showInput({ password: true })` request reports `prompt: null` while
`queued` still counts it, and native destructive confirmations are carved out the same way. Native
toasts - a daemon notification, a failed command, a presenter failure - are host chrome and are
never projected, so the notifications view draws plugin requests only. Each placement receives its
own half of the window and nothing else: the prompts view's `notifications` is always empty, and the
notifications view's `prompt`, `palette` and `queued` are always null or zero. Presenters are
desktop-only, so a phone window keeps the bundled ones and the snapshot's `formFactor` says why. No
view opens the palette, holds focus authority, sees a `pluginID`, a command handler or an owner's
identity beyond an opaque window-local ref, or registers a window modal: the host keeps all of that
whoever is drawing, and the corner frame registers only the rect it covers.

## Asking from a backend

`backend.mjs` registers **Interaction Lab: Ask before running** (`example.interaction-lab.ask`),
bound to ⌃⌥I (`ctrl+alt+i`) and listed in the palette. With no view mounted, the backend asks
**Run it?** with a dialog in the window whose shortcut or palette ran it, then shows a notification
naming the action that came back (`Interaction Lab: run` or `Interaction Lab: cancel`), or
`Interaction Lab: cancelled` when Escape dismissed the dialog. The command returns the action id,
or null on Escape. With **Interaction Lab prompts** and **Interaction Lab notifications** selected,
this plugin's own presenters draw both, owned by **Interaction Lab**, exactly as they draw a view's.
Holding the dialog open past 30 seconds still returns the answer: the command's timer waits for it.

A shell has no window to ask in, so the same command run from the CLI rejects:

```sh
kelpi_test plugin run example.interaction-lab.ask
# kelpi plugin: NO_WINDOW: the command has no window; run it from a shortcut, the palette or a menu, or pass { windowID }
```

In the backend that rejection is a `KelpiError` whose `code` is `NO_WINDOW`; the command does not
catch it, so the CLI prints its message and no dialog opens anywhere. Disabling or reloading the
plugin while the dialog is open closes it. See
[prompts from a backend](../../../docs/plugin-ui.md#prompts-from-a-backend) for routing, limits and
timeouts.

## Recovery, on purpose

The bundled presenter is the recovery floor and cannot be selected away. Each view exposes two
deliberate failure hooks on `globalThis.interactionLab`, so the recovery paths can be driven without
a message channel:

| Hook | Effect |
| --- | --- |
| `interactionLab.crash()` | The next `onInteraction` callback throws. The arming is cleared by that frame, so exactly one frame is affected: nothing at all is drawn for it, and the frame after it renders normally. The SDK catches a listener error, so the host still receives that frame's acknowledgement and sees no failure. Armed before the FIRST frame, that frame reports no readiness either, because readiness is claimed by the render it never reached. The frame after it renders and reports readiness as usual, so the 5 second readiness watchdog only takes the placement back if no further frame arrives first. |
| `interactionLab.crash('uncaught')` | The same one frame, and the error is also rethrown where nothing catches it, which the SDK reports as a view error and the host fails on immediately, whichever frame it was. |
| `interactionLab.stall()` | Every frame from the next one on returns a promise that never settles, so nothing is acknowledged and the 5 second acknowledgement watchdog takes the placement back. |
| `interactionLab.declare(pixels)` | The notifications view only: declare that box height instead of the measured one, and keep declaring it until `declare(null)` goes back to measuring. The host clamps whatever arrives, so an absurd number is how the clamp is proven. |

A failure never settles a request: the live request keeps its id, the bundled presenter re-presents
it (every notification in the stack included, with its clock still running), the palette session is
dismissed with reason `presenter-failed`, and **Retry presenter** appears beside the selection in
Settings → Plugins → Workbench views. `globalThis.interactionLab` also carries `snapshot`, `frames`,
`ready` and `lastError` in every view, plus `notices` and `boxHeight` in the notifications one, and
`document.body.dataset.ready` becomes `true` once `reportPresenterReady()` has resolved.

From the checkout root, run `kelpi_test plugin dev examples/plugins/interaction-lab --trust` while
editing. Compatible retained revisions are available in Settings → Plugins → Versions; reload
restarts only installed bytes.

The contract and its limits are in [the UI guide](../../../docs/plugin-ui.md#selectable-interaction-presenters),
and the public types in [interaction.d.ts](../../../packages/plugin-sdk/interaction.d.ts).
Unit coverage: `npx vitest run packages/client/src/features/interaction-lab.test.ts`. See the
[plugin roadmap](../../../docs/plugin-roadmap.md) for overall progress and the
[validation record](../../../docs/plugin-validation.md) for dated results.

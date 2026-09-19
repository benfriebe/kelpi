# Pane Lab

A build-free, UI-only pane chrome presenter. **Pane Lab** draws the header band of every visible
pane for `pane.chrome`. The view uses `window.kelpi.ui` only, receives its state from
`onPaneChrome`, and has no backend, no native imports and no access to the host DOM.

First [prepare the source checkout](../../../docs/plugin-development.md#prepare-a-source-checkout),
then start an isolated instance from its root:

```sh
node scripts/dev-instance.mjs --state out/plugin-pane-playground
```

In its Settings → Plugins, install the absolute path to `examples/plugins/pane-lab`, then pick
**Pane Lab** for `pane.chrome` in **Workbench views**. The placement is Settings-only: it appears in
`ui.getWorkbench().slots`, but `ui.selectView` refuses it, because a header presenter draws every
pane's close ✕ and every other plugin's `pane.header` items, so the choice has to stay the user's.
The entry marked **(bundled)** in that select is the recovery floor: choosing it hands every band
back on its own, without **Restore bundled views**. Keep using that instance's CLI and socket so
testing stays separate from your installed Kelpi.

## What it does

One frame arrives per change and carries every visible pane of the displayed workspace. Each pane
carries a `rect` - where its band is, in the presenter frame's own coordinate space - and the view
draws one absolutely positioned header there. There is one view for the whole grid, not one per
pane: the host mounts a single frame over `PaneGrid` and clips it to the bands it granted, so
anything drawn outside a rect is removed from paint and from hit testing, and a click below a band
reaches the terminal under it.

A band draws the pane's status dot, its kind, its label chip, the middle-truncated title (`head` may
ellipsize, `tail` never does - the split travels with the fact so two presenters cannot truncate the
same path two ways), the ZOOM and SYNC badges, the git branch, the working tree's change counts as
`doc N +A -B`, and the agent's badge line with its elapsed seconds. Then the host's own controls and
the other plugins' `pane.header` items, each drawn from its opaque ref.

A pane at least 420 px wide gets a **two-line band**: the title row, then the home-abbreviated
directory, the branch, the counts and the agent clock. That is `setPaneChromeHeight(paneID, 44)`,
and the host clamps it to the smaller of 96 px and a quarter of that pane's height before the pane's
body - a terminal's rows, a web pane's native bounds - is laid out under it. A pane that narrows
back below the threshold gets `setPaneChromeHeight(paneID, null)`, which hands the band back without
the view being torn down. Nothing is re-sent while it has not changed: the budget is 240 calls per
rolling second, and a breach fails the placement rather than dropping a call, so a declaration per
frame per pane would be a presenter that killed itself during a divider drag.

Every gesture is a `kelpi.ui` call and the host re-validates all of it:

| Gesture | Call |
| --- | --- |
| Press anywhere in a band | `focusChromePane(paneID)` |
| Double-click a band | `toggleZoom(paneID)` |
| Right-click a band | `openPaneMenu(paneID)` - the host's own menu, which stays native |
| A control button | `activatePaneControl(paneID, ref)` |
| Another plugin's item | `runPaneHeaderItem(paneID, ref)` |

A press that lands on a control or an item is neither: a button consumes its own tap, exactly as the
bundled header's do. Every press is defaulted away and nothing in a band is selectable
(`user-select: none`), because a header is chrome and a press dragged across it should move the pane
rather than smear a text selection over the title.

**The pane MOVE is not this view's to start.** A mouse press that lands inside an iframe keeps every
later move and the release inside that iframe's document, because Chromium settles where a gesture
is routed when the button goes down. No call could change that, so the host keeps a narrow drag grip
at the leading edge of every band it presents and runs its own gesture from a press there. The `rect`
each pane carries already excludes it, so this view neither draws it nor has to know it is there.

Split, close, the globe and the per-kind buttons are all controls, so they all go through
`activatePaneControl`; `closePane` and `renamePane` exist as their own calls for a presenter that
wants to offer them outside the row, and both hand straight back to the host - `closePane` raises
the host's confirmation and `renamePane` opens the host's inline field. While that field is up the
host takes the band back and the frame reports `renaming: true`, so the title is not this view's to
draw.

`withheld` is how many visible panes the 256 KiB frame budget could not carry. Those panes keep the
bundled header, so nothing is missing from the window - but a presenter that ignored the count would
be drawing an incomplete row and calling it the whole one, so the view prints it.

`visible: false` means present nothing: the window is showing another workspace, the grid is hidden,
or the bundled header has the bands back. The view blanks itself and every `data-testid` goes with
it, which is what makes their presence the signal that this presenter is painting.

## What it never sees

No absolute path beyond the `~/…` abbreviation, no PTY handle, no pid, no agent session id, no page
URL, no other plugin's id, no command name behind any control or item, and no `data-testid` from the
bundled header. A control and an item are a display name, an icon name, an enabled flag and an
opaque **ref** that is minted per frame, scoped to its pane, and means nothing outside the frame it
arrived in. The host keeps the mapping privately and re-resolves it against a fresh model before
anything runs, so a ref from an older frame, from another pane, or invented, activates nothing.

The view never draws a destructive confirmation and never draws a text input, because neither is
its to draw. It also never draws the focus ring, the dividers, the resize badge, the pane context
menu, the terminal's mirror clip wash or the find bar: those stay native, and the band's rectangle
is inset by the focus ring's 2 px on three sides so the ring paints over nothing this view drew.

## Test ids and diagnostics

| Test id | What it is |
| --- | --- |
| `lab-pane-header` | One pane's band. `data-pane-id`, `data-kind`, `data-status`, `data-focused`, `data-height`, `data-tall` |
| `lab-pane-facts` | The facts half of the first row: everything in it is a fact, never a button |
| `lab-pane-title` | That band's title, as `head` + `tail` |
| `lab-pane-branch` | The git branch chip |
| `lab-pane-control` | One trailing control. `data-ref`, `data-kind`, `data-pinned`, `data-icon` |
| `lab-pane-item` | One of another plugin's items. `data-ref`, `data-tone` |
| `lab-pane-withheld` | The count of panes the budget could not carry. `data-count` |

`document.body.dataset` carries `ready`, `visible`, `panes`, `withheld` and `workspace`.

```js
globalThis.paneLab = {
    snapshot,              // the last frame delivered
    ready, frames,         // readiness reported, frames received
    lastError,             // the last refusal or failure, as text
    lastPress, pressMoves, // the last press on a band, and the moves this FRAME saw under it
    crash(mode),           // 'listener' throws inside the listener; 'uncaught' fails the placement
    stall(),               // stop acknowledging, so the 5 s watchdog fires
    declare(paneID, px)    // declare a band by hand, or null to hand it back
};
```

`crash('uncaught')` and `stall()` are the two deliberate failure hooks, and they differ:
`crash('uncaught')` rethrows where nothing catches it, which the SDK reports as a view error and the
host fails the placement on; `stall()` only arms, and the watchdog fires on the next frame whose
SHAPE moved - a pane opened or closed, the workspace changed, the rename field went up. A frame that
only carries new geometry or a new title is not waited for, because a divider drag moves every rect
at pointer rate and a working presenter must not be failed for being busy.

Either failure latches **every** pane back to the bundled header at once, keyed
`viewID:revision:instanceID`, and drops every declared band with it - all-or-nothing, so no terminal
is left sized against a header nobody is drawing. Settings → Plugins → Workbench views reports it on
the `pane.chrome` row and offers **Retry presenter**; a reload, a rollback or a different selection
clears the latch on its own by moving the generation.

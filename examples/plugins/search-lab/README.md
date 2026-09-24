# Search Lab

A build-free, UI-only pane search presenter. **Search Lab** draws the find bar that ⌘F opens over a
shell pane, for `pane.search`. The view uses `window.kelpi.ui` only, receives its state from
`onPaneSearch`, and has no backend, no native imports and no access to the host DOM.

First [prepare the source checkout](../../../docs/plugin-development.md#prepare-a-source-checkout),
then start an isolated instance from its root:

```sh
node scripts/dev-instance.mjs --state out/plugin-search-playground
```

**An installed example is a COPY.** A running instance keeps using the copy it installed until the
plugin is reinstalled or reloaded, so editing files in this directory changes nothing in a window
that is already up. Reinstall the path (or `kelpi plugin reload example.search-lab`) after every
edit; a stale copy cost a round of manual testing once already.

In its Settings → Plugins, install the absolute path to `examples/plugins/search-lab`, then pick
**Search Lab** for `pane.search` in **Workbench views**. The placement is Settings-only: it appears
in `ui.getWorkbench().slots`, but `ui.selectView` refuses it, because this presenter owns a text
input and the caret for as long as a search is open, so the choice has to stay the user's. The entry
marked **(bundled)** in that select is the recovery floor: choosing it hands the bar back on its
own, without **Restore bundled views**. Keep using that instance's CLI and socket so testing stays
separate from your installed Kelpi.

## What it does

Focus a shell pane, press ⌘F, and the bar in its top-right corner is this view rather than Kelpi's.
Type, and the needle reaches the daemon; the counter reads back what the daemon counted. Return and
⇧Return step, ⌘G and ⇧⌘G step, the arrows step, `Aa` toggles case sensitivity and recounts, and
Escape, ⌘F or the `×` close the search and put the caret back in the shell.

One frame arrives per change and carries the ONE pane being searched: its id and kind, the needle,
the case flag, the total, the selected index, where that match sits, and a `box` - the rectangle the
bar may occupy, in the presenter frame's own coordinate space. There is one view for the whole grid,
not one per pane: the host mounts a single frame over the pane grid and clips it to that box, so
anything drawn outside it is removed from paint and from hit testing, and a click below the bar
reaches the terminal under it.

**Shell panes only.** A markdown or diff preview counts matches inside its own sandboxed frame and a
web pane counts inside its page, so neither has a total the daemon could state and both keep their
native bars. ⌘F over one of those opens Kelpi's own bar, not this one.

**Opening a search is not this view's to do**, and there is no call for it. ⌘F, the menu, the
palette row and `terminal.search(workspaceID, 'toggle')` are the ways a search opens; a presenter
that could open the bar could put a text field over any pane at any moment.

**The reveal is not this view's either.** Scrolling to a match and highlighting it belong to the
terminal renderer, including a replacement renderer, which receives search through its own contract.
`searchNext` moves the daemon's selection and the renderer follows.

## The box it declares

The bar lays itself out to its content (`width: max-content`), measures what the browser actually
produced, and declares that with `setSearchBoxSize(paneID, { width, height })`. The host clamps the
width to the smaller of 480 px and the pane's inner width, and the height to the smaller of 96 px
and a quarter of the pane, then clips this frame to the clamped rectangle at the pane's
top-trailing corner. Until something is declared the box is the native bar's own measured box, so a
presenter that declares nothing is drawn in exactly the space the bar it replaced occupied.

**The bar lays itself out inside the box it was granted**, and the field is what yields. A clip is
not a layout: a bar wider than its box is drawn in full and then cut, and what a flex row loses to a
cut on its trailing edge is the trailing end - the counter and every button. On a 131 px pane the
first cut of this example showed the needle and nothing else, with no way to step or close. So the
granted width is the bar's `max-width` and only the field gives ground, which is the native bar's
own answer; the size it DECLARES is still its natural one, measured with that ceiling lifted, so a
pane that widens gets the whole bar back.

The field gives ground ALONE, down to a 72 px floor, and then whole controls go in a fixed order:
the ↑ and ↓ buttons first (Return, ⇧Return, ⌘G and ⇧⌘G still step), then the counter, whose text
moves to the field's tooltip. The `Aa` toggle and the `×` never go: one is the only sign the search
is case sensitive, the other is the way out. The second cut let the counter shrink beside the field,
and the onscreen shots showed why a flex row is not an order: it shares a shortfall out by size, so
a 246 px box cut the counter to "1 of", and a 112 px box left the field an empty square with the `×`
past the clip. `fit()` in `ui/pane-search.js` picks the tier (`data-fit` on the bar: `full`,
`compact`, `tight`) from the granted width.

The declaration is re-measured from a `ResizeObserver` over the bar, because a counter going from
`3 of 9` to `312 of 4096` is a wider bar and this document reflowing is the one thing the host
cannot see. Nothing is re-sent while it has not changed: the budget is 240 calls per rolling second
and a breach fails the placement rather than dropping a call, so a declaration per frame would be a
presenter that killed itself while somebody typed.

`setSearchBoxSize(paneID, null)` hands the box back without the view being torn down.

## The caret and the four chords

The field takes the caret when Kelpi shows this bar, exactly as Kelpi's own bar autofocuses. It is
**not** contained: clicking the terminal underneath moves the caret to the terminal, because a find
bar is not modal. When Kelpi focuses this frame the field takes the caret in the same task, rather
than on the next frame, so a fast keystroke never lands on the frame's body in between. The frame
that OPENS a session seeds the field and places the caret at its end, but takes focus only if this
document already has it: that frame arrives while Kelpi's own bar is still drawing, and a field that
focused itself then would pull the caret out of the bar the user is typing into.

**The hand-over from Kelpi's own bar.** A ⌘F pressed before this view has painted opens Kelpi's bar,
and the user may start typing there. This view is fed the needle as it goes - Kelpi hands a
presenter the needle it is still sending, not the daemon's older one - and the field follows it on
every frame until the user types into this field. So when Kelpi's bar stands down mid-word, the
field already holds what was typed and the caret is after it.

The caret goes to the **end** of whatever needle was already there and nothing is selected. That is
the bundled bar's own rule, and it is deliberate: selecting the text made the first keystroke
silently replace a needle the user had just come back to.

Four chords are relayed into the window and no others:

| Chord | What happens |
| --- | --- |
| Escape | Kelpi closes the search and hands the caret back to the pane |
| The toggle-search chord (⌘F by default, rebindable) | the same |
| ⌘G | `searchNext`, while this frame or the searched pane holds the caret |
| ⇧⌘G | `searchPrevious`, likewise |

Where Ctrl is the primary modifier the stepping chords are Ctrl-G and Shift-Ctrl-G.

Everything else stays inside the frame and reaches nothing in the window - typing, arrows, Tab,
Return. That is why Return and ⇧Return are bound in this view rather than relayed: they are its own
keys. A chord the host does not relay cannot leak into the shell under the bar, which is the whole
reason the grant is a short explicit list.

`visible: false` means present nothing: no search is open, the window is showing another workspace,
the grid is hidden, or the native bar has the box back. The view blanks itself and every
`data-testid` goes with it, which is what makes their presence the signal that this presenter is
painting.

## What it never sees

No scrollback. A find bar is the surface most obviously next to the buffer it searches, and the
frame carries none of it: a plugin that wants the text reads it with
`capture(pane, { scrollback })` under its own identity, where it is an auditable call by a named
plugin rather than a standing grant riding in on a UI placement.

No other pane's state, no path, no workspace id, no other plugin's id, no run closure and no
`data-testid` from the bar it replaced. The needle is capped at 1,024 characters: a longer one set
by another plugin through `terminal.search` arrives truncated with `needleTruncated` set, because an
oversized frame would fail the user's chosen presenter over somebody else's string.

## Test ids and diagnostics

| Test id | What it is |
| --- | --- |
| `lab-search` | The bar. `data-pane-id` names the pane being searched |
| `lab-search-input` | The needle field |
| `lab-search-count` | The counter: `3 of 17`, `9 matches`, `no matches`, `counting`, or empty |
| `lab-search-next` | Next match |
| `lab-search-previous` | Previous match |
| `lab-search-case` | The case toggle. `aria-pressed` is the state |
| `lab-search-close` | Close the search |

`document.body.dataset` carries `ready` and `visible`.

```js
globalThis.searchLab = {
    snapshot,       // the last frame delivered
    ready, frames,  // readiness reported, frames received
    lastError,      // the last refusal or failure, as text
    held,           // this boot is holding its readiness report (see holdNextBoot)
    paintedAt,      // when the paint wait ended; after it, only a hold delays the report
    readyAt, readyNeedle, readyFrameNeedle, readyTyped, // when readiness was reported, the field, the frame's needle and whether the field was typed into
    crash(mode),    // 'listener' throws inside the listener; 'uncaught' fails the placement
    stall(),        // stop acknowledging, so the 5 s watchdog fires
    declare(size),  // declare a box by hand, or null to hand it back
    holdNextBoot(), // ask the NEXT boot to hold its readiness report (kept in plugin storage)
    releaseReady()  // let a held boot report readiness
};
```

`holdNextBoot()` is the hand-over hook. Enabling or reloading the plugin boots it in a new document,
so the request is left in plugin storage, and the next boot reads it, clears it, and keeps painting
and acknowledging frames behind Kelpi's own bar without reporting readiness until `releaseReady()`.
That is the window in which a needle typed into Kelpi's bar is still in transit, and the live
scenario releases inside it and reads `readyNeedle` and `readyFrameNeedle` back.

`crash('uncaught')` and `stall()` are the two deliberate failure hooks, and they differ:
`crash('uncaught')` rethrows where nothing catches it, which the SDK reports as a view error and the
host fails the placement on; `stall()` only arms, and the watchdog fires on the next frame that
OPENS a session. A frame that only carries a new needle or a new total is not waited for, because a
shell rewrites its buffer whenever it likes and a working presenter must not be failed for being
busy.

Either failure latches the placement back to Kelpi's own bar, keyed `viewID:revision:instanceID`,
drops the declared box with it, and turns case sensitivity back off, because Kelpi's bar has no
toggle to show it with. **The needle survives**, and Kelpi's field takes the caret: the needle, the total and the selection were never this view's, they are
workspace state on the daemon's delta stream, so the bar that comes back is the bar the user was
already using. Settings → Plugins → Workbench views reports the failure on the `pane.search` row and
offers **Retry presenter**; a reload, a rollback or a different selection clears the latch on its own
by moving the generation.

## One thing two windows can disagree about

The needle, the total and the selected match are workspace state, so a second window watching the
same pane reads the same counter and closing the bar in one closes it in both. Case sensitivity is
not: Kelpi's search verb takes it per request and stores nothing, so the host holds it for the window
for the length of one search session. The `Aa` toggle is therefore local to the window whose bar you
are drawing, and the totals it produces are published to both. It also leaves with this view: if the
placement fails or is handed back while a search is open, the flag goes off and the needle is
recounted, because Kelpi's own bar could not show that it was on.

# Recent workspace switcher (⌃Tab) — design

Date: 2026-10-05 · Branch: `feat/recent-workspace-switcher`

## Goal

Switch between workspaces in most-recently-used order, the way Firefox's ⌃Tab cycles tabs:
hold ⌃, tap Tab to step back through recent workspaces in an on-screen switcher, release ⌃ to
go there. A quick ⌃Tab toggles between the last two workspaces.

## Decisions (agreed in chat)

- **Hold-to-cycle with a switcher overlay**, not a plain toggle.
- **Order comes from the daemon's `lastAccessedAt`**, so it survives restarts and a fresh
  window has history straight away.
- **Default ⌃Tab / ⌃⇧Tab**, rebindable.

## Behaviour

1. **⌃Tab** starts a gesture. The list is every LOCAL workspace (collapsed groups included):
   the active workspace first, then the rest by `lastAccessedAt`, newest first. The highlight
   starts on the second row (the previous workspace).
2. While the gesture's modifiers are held:
   - **Tab** (`next_recent_workspace` again) moves the highlight one row down; **⌃⇧Tab**
     (`previous_recent_workspace`) one row up. Both wrap.
   - **Escape** cancels: nothing switches.
   - **Clicking a row** commits that row.
3. **Releasing the modifiers commits**: the highlighted workspace is activated through the
   existing `activateWorkspace` path (`features/workspaces-actions.ts`), which reveals it in the
   sidebar and expands a collapsed group. Nothing is activated while stepping, so only the
   destination is stamped and no intermediate workspace mounts its panes.
4. **Quick tap**: the overlay is shown only once the modifiers have been held for
   `SWITCHER_SHOW_DELAY_MS` (150 ms). A press and release inside that window commits the second
   row without the overlay ever painting.
5. **Window blur** (⌘Tab away, a click outside the window) commits the highlighted row, the same
   as a release. Keyups that happen while the window is not focused are never delivered, so
   waiting would leave the gesture stuck open.
6. **Fewer than two workspaces**: the action is not consumed (falls through), so ⌃Tab reaches
   the terminal as it does today.
7. **Starting the gesture with ⌃⇧Tab** starts on the LAST row (the least recent), mirroring
   Firefox.

## Bindings

- Two new `KelpiAction`s in the **Workspaces** category (`packages/core/src/config/actions.ts`):
  - `next_recent_workspace` — "Next Recent Workspace", default `ctrl+tab`
  - `previous_recent_workspace` — "Previous Recent Workspace", default `ctrl+shift+tab`
- Defaults added to `packages/core/src/config/bindings.ts`.
- **Monitor layer only**, not `MENU_BAR_ACTIONS`: a native menu accelerator cannot observe the
  modifier release the gesture ends on.
- **The held modifiers are the trigger's own** (excluding Shift, which only picks direction).
  Rebinding to `alt+tab` makes the gesture end when ⌥ is released. A trigger with no ⌃/⌥/⌘
  (a bare key) has nothing to hold, so it behaves as a quick tap every time.
- Not being menu-bar actions, they do not fire while a chrome text field (sidebar filter,
  inline rename) has focus, the same as `next_workspace` (`config-keybindings.md` §7.2 step 6).

## Ordering

- Pure function `recentWorkspaceOrder(state, activeID, localSeq)` in a new
  `packages/client/src/app/recent-workspaces.ts`:
  - input: the client mirror's `workspaces` (each already carries `lastAccessedAt`, epoch
    seconds — the mirror is a `DaemonState` and `hydrateWorkspace` keeps every field), the
    active workspace ID, and a client-local activation sequence map.
  - output: workspace IDs, active first, then by `lastAccessedAt` descending.
  - **Ties** (two activations inside one second — `lastAccessedAt` is whole seconds): broken by
    the client's own activation sequence (`Map<workspaceID, number>`, bumped whenever this
    window sees `activeWorkspaceID` change), higher first; remaining ties by sidebar order.
- **No protocol change.** `serializeWorkspaceEnvelope` / `serializeWorkspace` already spread
  `lastAccessedAt` onto the wire; only the client starts reading it. A value that is missing or
  not a number sorts as 0 (oldest).

## Gesture state machine

New `packages/client/src/app/recent-switcher.ts`, framework-free and unit-tested:

```
idle --(action, ≥2 workspaces)--> holding{order, index, heldMods, shownAt=null}
holding --(action again)--> holding{index ± 1 (wrap)}
holding --(timer 150 ms, mods still held)--> holding{shown=true}   (overlay renders)
holding --(keyup leaves none of heldMods down)--> commit(order[index]) -> idle
holding --(Escape)--> idle (no switch)
holding --(window blur)--> commit(order[index]) -> idle
holding --(row click)--> commit(row) -> idle
```

- The machine reads modifier state from each keyup/keydown event's `ctrlKey`/`altKey`/
  `metaKey`, not from tracking individual key codes, so a missed keydown cannot strand it.
- `App.tsx` wires it: the `keyActions` entries call `switcher.step(±1)`; a window `keyup`
  listener and a `blur` listener feed it; the overlay component renders from its state.

## Overlay

- New `packages/client/src/chrome/RecentWorkspaceSwitcher.tsx`: a centred list styled like
  `CommandPalette` (same tokens, density and motion rules). Each row shows the workspace's
  avatar/colour and name, as the sidebar does; the highlighted row uses the palette's selected
  style. No search field.
- While shown it holds DOM focus on its own container (as the palette does), and it counts as a
  modal overlay for `closeModalOverlay` / the dispatcher's step 0/1, with one exception: the two
  recent-workspace actions and Escape still reach the switcher.

## Web panes

- ⌃Tab inside a focused page already reaches the window: the shell's `before-input-event` relay
  (`packages/shell/src/webhost/keys.ts`) forwards every chord in the binding map that carries
  ⌘, ⌃ or ⌥. No shell change is expected.
- The page keeps keyboard focus after the relay, so the window sees neither the next Tab nor the
  ⌃ release until the overlay opens and takes DOM focus. Therefore, for a gesture started from
  a web pane:
  - the overlay opens immediately (no 150 ms delay), taking focus so the rest of the gesture
    is delivered to the window;
  - if the overlay cannot take focus from the page (to be measured by the scenario below), the
    fallback is a commit on a 400 ms idle timeout after the last step.
- This is the part of the design most likely to need adjusting; the scenario decides.

## Known trade-offs

- **Apps that read ⌃Tab lose it.** Terminal programs on the kitty keyboard protocol receive ⌃Tab
  today; once bound, Kelpi takes it. `keybind = ctrl+tab=unbind` (and the shift variant) gives
  it back. Documented in `config-keybindings.md`.
- **Remote-daemon workspaces are excluded**: their `lastAccessedAt` comes from another daemon's
  clock and is not comparable.
- **Shared order across windows**: `lastAccessedAt` is daemon-wide, so two windows interleave
  their histories.

## Docs

- `docs/config-keybindings.md`: the two actions in §4 "Workspaces", the default map in §5.2
  (49 triggers), the action count in §4's intro, and a short subsection under §7 on the
  hold-and-release gesture and the web-pane focus hand-off.

## Testing

- **Unit**
  - `app/recent-workspaces.test.ts`: active first, newest-first order, tie-break by local
    sequence then sidebar order, missing timestamp sorts last, remote workspaces excluded.
  - `app/recent-switcher.test.ts`: quick tap commits row 2 and never shows; hold past 150 ms
    shows; Tab/⌃⇧Tab wrap; release of a non-held modifier does not commit; Escape cancels; blur
    commits; fewer than two workspaces does not consume; `alt+tab` rebinding ends on ⌥ release.
  - `core` config tests: the defaults parse and round-trip; actions appear in the Workspaces
    category.
- **Scenario** `scripts/scenarios/recent-workspace-switcher.mjs` (real window, CDP input):
  three workspaces visited A→B→C; ⌃Tab tap lands on B; ⌃Tab again lands on C; hold ⌃,
  Tab, Tab, release lands on the third most recent; the overlay is visible during the hold and
  gone after; Escape mid-hold leaves the workspace unchanged; the same tap and hold starting
  from a focused web pane.
- `node scripts/verify.mjs` on the branch before the PR.

## Out of scope

- Remote-daemon workspaces in the list.
- Per-window history.
- Pane-level MRU switching.

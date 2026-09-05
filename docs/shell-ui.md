# Shell UI — behavioral specification

Subsystem: the app shell / chrome of Kelpi — everything the user sees around the terminal
surfaces. This is a UI behavior inventory written for the TypeScript/web port. It describes
WHAT the current macOS app does, so an equivalent UX can be built in web tech (the daemon
serves the state; the web client renders this shell). Sizes are given in CSS-pixel-equivalent
points; treat them as a starting layout, not a pixel contract.

Source of truth read for this spec: `ContentView.swift`, `NexApp.swift`, `AppDelegate.swift`,
`Chrome/` (RootChromeView, WindowTitleBar, WindowFrameRestorer), `Features/PaneGrid/*`,
`Features/Workspace/*` (list, inspector, sheets, drag-drop math), `Features/CommandPalette/*`,
`Features/Help/*`, `Features/StatusBar/*`, `Theme/*`, plus the supporting models
(`SidebarID`, `WorkspaceColor`, `GroupIcon`, `LabelPreset`, `PaneLayout` drop zones,
`QuitGate`, `WorkspaceDeleteGate`, command-palette reducer).

---

## 1. Window structure

One main window. Vertical stack:

```
┌──────────────────────────────────────────────────────────┐
│ WindowTitleBar (32 high, custom-drawn, traffic lights    │
│ float over its left edge; ••• menu + sidebar toggle      │
│ float over its right edge)                               │
├──────────┬───────────────────────────────┬───────────────┤
│ Sidebar  │ Pane grid (active workspace)  │ Inspector     │
│ (optional│                               │ (optional,    │
│ 180–300, │                               │ fixed 280)    │
│ default  │                               │               │
│ 220)     │                               │               │
├──────────┴───────────────────────────────┴───────────────┤
│ StatusBarView (24 high, bottom footer)                   │
└──────────────────────────────────────────────────────────┘
```

- Window minimum size 600 × 400.
- The middle row is clipped to its own bounds so full-height pane dividers can never draw
  up into the title bar.
- Sidebar visibility (`isSidebarVisible`) and inspector visibility (`isInspectorVisible`)
  are app-level booleans toggled by keybindings (`toggle_sidebar`, default ⌘⇧S;
  `toggle_inspector`, default ⌘I) and by the title-bar controls. Toggling animates
  (default ease, ~0.25s).
- Sidebar has a 1px divider line on its trailing edge (theme `divider` color) and an
  invisible resize handle at that edge: zero-width strip with a ±3pt hit inset, shows a
  left-right resize cursor on hover, drag adjusts width clamped to **[180, 300]**. The
  width is view-local state (not persisted).
- When no workspace is active, the pane-grid slot shows an empty state: a large terminal
  glyph (48pt, very faint), "No workspace selected" (secondary text), and a
  "Create Workspace" button that opens the New Workspace sheet.
- A command-palette overlay can cover the middle row (see §9).
- Dropping a `.md` file anywhere on the window opens it as a markdown pane
  (`openFileAtPath`, same path as Finder Open With).

### Single-window discipline (macOS)

The macOS app enforces exactly one main window: a registry records the first main window
as "primary"; any later main window (macOS spawns one when a document is opened while the
app runs) is closed immediately, and terminal surfaces refuse to re-parent into a
non-primary window (otherwise the surfaces would be stranded blank). The primary claim is
relinquished when the window closes so a Dock-reopened window can re-claim it.
*Port relevance:* the web client is naturally single-window per tab; the Electron shell
should keep one main BrowserWindow and route file-opens into it.

### Window frame persistence (Electron shell)

The macOS app persists, outside the DB (UserDefaults):

- the windowed frame (`kelpi.mainWindow.frame`) on every move/resize, **skipping** saves
  while in native fullscreen or during the enter/exit-fullscreen transition, so the stored
  frame is always the windowed one;
- a fullscreen boolean (`kelpi.mainWindow.isFullScreen`); on launch the windowed frame is
  restored first, then fullscreen is re-entered if the flag is set.

On restore, the frame is clamped: it is kept only if some screen fully fits it AND that
screen contains the window's top 28pt "drag strip" with at least 80pt of grabbable width;
otherwise the window is recentred on the current screen (shrunk to fit). This prevents
restoring a window whose title bar is off every remaining display.

---

## 2. Theming (ChromeTheme)

The app chrome (sidebar, title bar, pane headers, footer, sheets, palette) uses its own
palette, deliberately independent of the terminal (ghostty) theme. It is resolved — never
stored in app state — from three inputs:

1. `chromeAppearance` preference: `"system" | "light" | "dark"`. `system` follows the OS
   appearance live; `light`/`dark` force the whole window scheme.
2. The OS color scheme (for the `system` case).
3. Per-appearance user color overrides (Settings ▸ Appearance), stored as
   `"<light|dark>:<key>" → "RRGGBB"` strings.

### Token set and preset values

```ts
interface ChromeTheme {
  // surfaces
  windowBackground: Color;   // gaps between panes / behind empty grid
  sidebarBackground: Color;
  surfaceBackground: Color;  // sheets, palette, popovers, Settings
  headerBackground: Color;   // pane headers, search overlay, resize overlay
  footerBackground: Color;   // bottom status bar AND the title bar
  // text
  textPrimary: Color;
  textSecondary: Color;
  textTertiary: Color;
  // structure
  divider: Color;
  selectionFill: Color;      // sidebar selected/active row fill (accent @ ~0.16/0.24)
  selectionStroke: Color;    // sidebar selected/active row outline
  accent: Color;             // sidebar highlight + global tint
  paneFocus: Color;          // focused-pane border (independently themable)
  // semantic status
  statusRunning: Color;
  statusWaiting: Color;
  statusInactive: Color;
  activeAgent: Color;        // amber agent badge / elapsed timer
  groupBandOpacity: number;  // fill opacity for group header bands
}
```

| token | light | dark |
|---|---|---|
| windowBackground | `#EAE8E2` | `#0A0A0C` |
| sidebarBackground | `#EFEEE9` | `#0C0C10` |
| surfaceBackground | `#FFFFFF` | `#101013` |
| headerBackground | `#F7F6F2` | `#13131A` |
| footerBackground | `#EFEEE9` | `#0C0C10` |
| textPrimary | `#2B2B2E` | `#E6E6EA` |
| textSecondary | `#6B6C70` | `#9A9AA0` |
| textTertiary | `#9A9A96` | `#6A6A72` |
| divider | `#DEDCD5` | `#24242B` |
| selectionFill | `#5E8AC4` @ 0.16 | `#5276B8` @ 0.24 |
| selectionStroke | `#5E8AC4` | `#5276B8` |
| accent | `#5E8AC4` | `#6F9BD8` |
| paneFocus | `#5E8AC4` | `#6F9BD8` |
| statusRunning | `#4FA46B` | `#5FBE89` |
| statusWaiting | `#5E8AC4` | `#6F9BD8` |
| statusInactive | `#9A9A96` | `#8A8A92` |
| activeAgent | `#A97C17` | `#D3A329` |
| groupBandOpacity | 0.30 | 0.22 |

### Overridable keys

User overrides exist for: `windowBackground`, `sidebarBackground`, `footerBackground`,
`headerBackground`, `surfaceBackground`, `accent`, `paneFocus`, `divider`,
`statusRunning`, `statusWaiting`, `statusInactive` (the last three form a separate
"Agent status" settings section). Overriding `accent` ALSO rewrites `selectionStroke`
(same value) and `selectionFill` (accent @ 0.18). `textPrimary/Secondary/Tertiary`,
`activeAgent`, and `groupBandOpacity` are not user-overridable. Overrides are stored per
concrete bucket (`light:` / `dark:`) — a color picked in dark mode never leaks into
light mode.

Resolution algorithm:

```
base   = appearance == system ? (osDark ? darkPreset : lightPreset)
                              : presetFor(appearance)
bucket = concrete bucket string ("light" | "dark") for the resolved appearance
for key in overridableKeys:
    hex = overrides["<bucket>:<key>"]; if valid RRGGBB → apply
```

### Sidebar tint knobs

Additional appearance settings, threaded to the sidebar as environment values:

```ts
interface SidebarFillStroke {
  avatarFill: number;    // default 0.20 — workspace avatar fill opacity
  avatarStroke: number;  // default 0.45 — avatar border opacity
  groupFill: number;     // default -1 = "use theme.groupBandOpacity"
  groupStroke: number;   // default 0.0 — group band border opacity
}
// plus sidebarColorIntensity: number (default 1.0) — multiplies all of the above
```

Effective opacity is always `min(1, value * intensity)`.

### Built-in chrome themes

A preset gallery the user can apply in one click (writes the palette into the matching
bucket's overrides and switches Light/Dark to suit; the terminal theme is untouched).
Seven presets: **Dracula, Nord, Gruvbox Dark, Tokyo Night, Catppuccin Mocha** (dark) and
**Solarized Light, Gruvbox Light** (light). Each specifies the 11 overridable colors
(see `BuiltInChromeThemes.swift` for exact hex tables — carry them over verbatim).

### Theme sharing

`ChromeStyleTheme` is a shareable JSON bundle:

```json
{
  "version": 1,
  "name": "My Look",
  "colorOverrides": { "dark:accent": "BD93F9", "light:divider": "DEDCD5" },
  "sidebarColorIntensity": 1.0,
  "sidebarAvatarFillOpacity": 0.20,
  "sidebarAvatarStrokeOpacity": 0.45,
  "sidebarGroupFillOpacity": -1,
  "sidebarGroupStrokeOpacity": 0.0,
  "sparklineColorHex": "BD93F9",
  "sparklineWidth": 28,
  "sparklineStyle": "line"
}
```

Two wire forms: a pretty-JSON `.nextheme` file, and a one-line share code
`kelpi-theme:<base64(compact JSON)>`. Import accepts the prefixed code, bare base64, or raw
JSON pasted directly. A `version` greater than the app's known version is rejected with
"This theme was made with a newer version of Kelpi (vN)."; junk input → "That doesn't look
like a Kelpi theme." Importing restyles chrome only — it never changes the recipient's
light/dark mode or terminal background.

### Terminal-background interplay ("vibrancy")

The ghostty config supplies `backgroundColor` + `backgroundOpacity` (user's terminal
theme, possibly overridden in Settings ▸ Appearance). Rules:

- Non-terminal pane bodies (markdown, scratchpad, diff, web) are painted with
  `ghosttyBackgroundColor` at `ghosttyBackgroundOpacity` so they blend with the terminal
  panes.
- If `backgroundOpacity >= 1`, the window paints an opaque `theme.windowBackground`
  backdrop behind everything.
- If `backgroundOpacity < 1`, the window itself is made non-opaque (macOS: transparent
  window background) and the chrome backdrop is **not** painted, so transparent terminal
  cells see through to the desktop. Chrome surfaces (sidebar/headers/footer) still paint
  their own opaque colors.
- Appearance changes re-broadcast the config so open non-terminal panes repaint live.

### Utility formats used across the chrome

- `chromeHomeAbbreviated(path)`: home dir → `~` (`/Users/x` → `~`, `/Users/x/a` → `~/a`).
- `chromeElapsedLabel(start, now)`: `"Ns"` under a minute, `"Nm Ss"` under an hour,
  `"Nh Mm"` above; negatives clamp to 0.

---

## 3. Title bar

Custom 32pt-high bar drawn as content at the very top (macOS hides the native title bar).
Background = `theme.footerBackground` with a 1px bottom divider.

**Identity cluster** (perfectly centered, non-interactive — clicks fall through to the
drag region):

```
● WorkspaceName · 3 panes
```

- Dot (7pt): if any pane in the active workspace is `waitingForInput` → `statusWaiting`;
  else if any is `running` → `statusRunning`; else the workspace's own color. No active
  workspace → `textTertiary`, and the name falls back to "Kelpi" with no pane count.
- Name: 12pt semibold `textPrimary`; count: `textTertiary`; single line, tail-truncated.
- Horizontal insets: 80 leading (clears traffic lights), 86 trailing (clears controls).

**Drag & double-click:** empty bar area drags the window; double-click in the strip
(excluding the two gutter insets) performs the user's OS "double-click title bar"
preference — Zoom (default), Minimize, or nothing.

**Trailing controls** (top-right, clickable):

- `•••` menu: "Settings…", "Show Inspector"/"Hide Inspector" (toggles inspector),
  divider, "Restart Socket Server".
- Sidebar-toggle button (sidebar glyph), tooltip "Toggle sidebar".

Both are tinted `textSecondary`, 13pt.

---

## 4. Pane grid

Renders the active workspace's `PaneLayout` tree as absolutely-positioned pane views plus
divider handles, computed mathematically from the tree (`paneFrames(in: bounds)` /
`splitDividers(in: bounds)`). Pane view identity is stable across layout changes — panes
are only moved/resized, never re-created (critical for keeping terminal state alive; in
web, keep DOM nodes stable across layout mutations).

- Divider thickness: **2pt**.
- Empty layout state: centered terminal glyph (36pt faint), "No panes", and a
  "New Pane" button; pressing **Return** (no modifiers) activates it. Background fills
  with `theme.windowBackground`.

### 4.1 Pane composition

Each pane = vertical stack of **header** + **body**, clamped and clipped to its computed
frame, with these overlays:

- **Focus ring**: when the pane is the workspace's `focusedPaneID`, a 2pt inner border in
  `theme.paneFocus` around the whole pane (header + body).
- **Search overlay** (top-trailing, see §4.5) when this pane is the searching pane.
- **Resize dimensions overlay** (centered, see §4.4) while `isResizing`.
- **Drag translucency**: the pane being header-dragged renders at 50% opacity.
- Background behind non-shell bodies: ghostty background color/opacity (see §2).

Body by pane type:

- `shell` — the terminal surface (ghostty; ghostty-web in the port).
- `markdown` — preview (WKWebView-rendered HTML) or, in edit mode, either the built-in
  plain-text editor or an embedded terminal running the user's `$EDITOR`.
- `scratchpad` — plain-text editor bound to `pane.scratchpadContent`.
- `diff` — rendered `git diff` HTML; takes a `refreshToken` (uint bumped by the header
  refresh button; view-local per grid, not persisted).
- `web` — the embedded browser pane (own subsystem; the grid supplies tabs/activeTab/
  private flag/favourites and ~20 callbacks; see the web-pane spec).

Clicking anywhere in any pane body (including web views and editors) emits a
pane-focused event that drives `focusPane` — every pane type participates in the same
focus flow. When a focused shell pane's surface is (re)shown it grabs keyboard focus,
EXCEPT while a sidebar inline rename/filter text field is active (a
`sidebarTextEditingActive` flag suppresses focus stealing so re-renders can't yank the
caret out of the field).

### 4.2 Pane header

A slim bar (≈20pt content height; 8pt horizontal, 2pt vertical padding) at the top of
every pane. Background `theme.headerBackground`, 1px bottom divider. Focus is shown by
the pane ring, not the header.

Left-to-right contents:

1. **Type glyph / status dot** (10pt slot):
   - shell → a 10pt circle colored by status: `running` → `statusRunning`,
     `waitingForInput` → `statusWaiting`, `idle` → `textTertiary` (halved opacity when
     the pane isn't focused). Color transitions animate ~0.3s.
   - markdown → document icon; scratchpad → note icon; diff → `±` icon; web → globe
     icon; all secondary-colored.
2. **Label chip** (if `pane.label` set and type ≠ markdown): small tag icon + label text
   (10pt monospace), accent-colored text on accent @ 0.12 rounded fill.
3. **Path/title text** (11pt monospace, middle-truncated; `textPrimary` when focused,
   else `textSecondary`). Display string:
   - scratchpad → `"Scratchpad"`
   - markdown → file basename
   - diff → `"diff: <basename of filePath, or of workingDirectory if no filePath>"`
   - shell/web → `pane.title ?? pane.workingDirectory`, home-abbreviated (`~/…`)
4. **ZOOM badge** (only when the workspace is zoomed AND has >1 pane): orange badge
   (expand icon + "ZOOM", 10pt mono, orange @ 0.12 fill); clicking it un-zooms.
   Tooltip "Toggle zoom".
5. **SYNC badges** (synchronise-input, workspace-level flag):
   - sync active AND pane not excluded → amber badge (broadcast icon + "SYNC");
     tooltip "Synchronise input is on — keystrokes mirror to peer panes". Shown even in a
     single-pane workspace (deliberate "you left it on" cue).
   - sync active AND pane excluded → dimmed gray badge (dashed-rect icon + "SYNC OFF",
     9pt); tooltip "Excluded from the workspace sync group".
6. `Spacer` — everything after is right-aligned.
7. **Agent badge** (shell panes with `agentSessionID != nil` only):
   - `running` → amber (`theme.activeAgent`) badge: `"<agentKind ?? "claude">"`, then
     `" · <elapsed>"` if `agentStartedAt` is known (live 1s ticker, e.g. `claude · 4m 9s`),
     then `" · N running"` if `backgroundTaskCount > 0`.
   - `waitingForInput` → blue-ish (`statusWaiting`) badge `"awaiting input"`.
   - `idle` → nothing.
8. **Git branch badge** (if `pane.gitBranch`): branch icon + name, 10pt mono, secondary
   on gray @ 0.1.
9. **Per-type buttons** (each 20×20 hit target, 10pt secondary icon at 60% opacity):
   - markdown (view mode only): **copy** button (doc-on-doc icon, tooltip "Copy whole
     file") → opens a two-item popup menu at the cursor: "Copy as Markdown" / "Copy as
     Rich Text".
   - markdown: **edit toggle** — pencil icon when previewing (tooltip "Edit (⌘E)"),
     eye icon when editing (tooltip "Preview (⌘E)").
   - diff: **refresh** (circular-arrow icon, tooltip "Refresh diff") → bumps the pane's
     refresh token, re-running `git diff`.
10. **Split right** (2×1 rect icon, tooltip "Split right (⌘D)").
11. **Split down** (1×2 rect icon, tooltip "Split down (⌘⇧D)").
12. **New web pane** (globe icon, tooltip "New web pane (⇧-click splits down)") — click
    opens a fresh web pane split to the right of this pane; shift-click splits below.
13. **Close** (× icon, tooltip "Close pane (⌘W)").

Header gestures:

- Single click → focus the pane.
- Double click → toggle zoom (maximise this pane over the grid; state is
  `zoomedPaneID` on the workspace).
- Drag (≥8pt) → pane move drag (§4.3).
- Right-click → context menu (below).

**Header context menu** (all panes unless noted):

```
Rename…                       (opens Rename Pane sheet)
Close Pane                    (destructive)
──────────
Split Right
Split Down
New Web Pane
──────────                    (shell panes only)
Status ▸  Idle / Running / Awaiting Input   (current gets a checkmark;
                                             manual status override)
──────────                    (only when other workspaces exist)
Move to Workspace ▸  <workspace names>       (fire-and-forget move)
──────────                    (only while workspace sync is active)
Include in Sync | Exclude from Sync          (toggles this pane's membership)
──────────
Open in Finder                (markdown/diff w/ filePath → reveal file;
                               otherwise open workingDirectory)
Copy Working Directory        (puts cwd on the clipboard)
```

**Menu-stability requirement:** agent activity mutates pane fields (status, title,
elapsed timer) every second. The current app goes to great lengths (equatable projection +
a hit-test-transparent live overlay copy) so those ticks can never rebuild the header's
context menu and dismiss an open submenu. In web, an open context menu must similarly
survive high-frequency re-renders of the row/header beneath it.

**Menu-over-a-web-page requirement (port only):** this menu opens from a pane header, and
on a web pane it lands over the page area. The current app pays nothing for that — a
`WKWebView` is an AppKit subview in the same window and an `NSMenu` is its own window, so
the menu simply floats over a page that keeps rendering. In the port the page is a native
`WebContentsView` the shell composites **above** the client's document, so a menu over it
is invisible until the view is parked, and parking it left the pane empty for as long as
the menu was up (issue #12). The requirement, therefore: **the page's content must stay
visible while a menu is over it.** The port meets it with a **POSTER**: it photographs the
page before it parks. The client holds the view on screen, asks the host for one frame
(the `poster` verb, `daemon/src/webpane/HOST_PROTOCOL.md` §3.6), paints it in the hole and
only then hands the view back, so the menu draws over a still frame of the page it was
covering. Every failure (no host, no on-screen view, a frame too large to send, no answer
inside the client's deadline) falls back to the empty hole rather than to a delayed menu,
and **falls back silently** — no error surfaces for a poster nobody asked for.

Two properties are what make the swap invisible, and both were learned by shipping without
them (the owner's follow-up: "it no longer disappears, but it flickers and jumps"):

- **The picture is on screen before the view leaves.** Parking is a socket message the
  shell acts on within a millisecond; an `<img>` committed in the same tick cannot appear
  before the next composited frame, so the pane showed its own background for one to two
  frames. The client holds the view until a decode plus a double `requestAnimationFrame`
  says the frame is painted.
- **The picture stands exactly where the view stood.** The shell rounds and clamps every
  edge when it places the view, and a replaced element sizes itself from its intrinsic
  aspect, so a poster laid out on the pane's own CSS box was 0.76% too large on a 2×
  display: the page grew when the menu opened and snapped back when it closed. The frame
  now carries the box it is a picture of (HOST_PROTOCOL §3.6) and is laid out on that.

- **The page is not re-laid-out for a menu.** A parked view used to go back to the
  off-screen holder, which re-pins its viewport to the automation default (1280x800 @1x):
  the page reflowed on the way out and again on the way back, and the frames between the
  view returning and the page repainting showed that layout clipped into the pane. A menu
  is over in a second and the pane has not moved, so the view is now hidden where it
  stands and the page never learns anything happened.
- **The frame is copied from the compositor, not asked of the page.** A capture served by
  the page's own main thread cannot answer while the page is busy, which is most real
  pages at the moment you right-click, and the pane then parked with nothing at all.

All four are measured frame by frame by `scripts/ui-audit/poster-swap-flicker.mjs` (which
also runs against the packaged app), because neither a jsdom test nor a settled screenshot
can see a swap that is only wrong for two frames, and nothing that samples the CLIENT can
see the guest page's own layout at all.

### 4.3 Moving panes by drag (header drag)

- Dragging a header ≥8pt starts a pane move. The source pane dims to 50%.
- On every drag tick, hit-test the cursor against all other panes' frames. If over a
  target pane, compute the **drop zone** = nearest edge by normalized center distance:
  `nx = (x - midX)/(w/2)`, `ny = (y - midY)/(h/2)`; `|nx| > |ny|` → left/right else
  top/bottom.
- Drop-zone preview: the corresponding half of the target pane is overlaid with
  accent @ 0.2 fill + accent @ 0.5 2px border, 4pt corner radius (left zone = left half,
  top zone = top half, etc.). Not hit-testable.
- On release over a valid zone → `movePane(paneID, targetPaneID, zone)`: the reducer
  re-parents the dragged pane adjacent to the target (zone → before/after in a
  horizontal/vertical split). Release over nothing → no-op.

### 4.4 Divider drag & resize overlay

Dividers are 2pt bars in `theme.divider`, overlaid with gray @ 0.2 normally and
accent @ 0.5 while dragging; the hit area extends ±4pt beyond the visual bar; hover shows
the appropriate resize cursor.

Drag semantics: each divider carries `{splitPath, available, firstSize}` where
`available = containerExtent - dividerThickness`. During drag,
`newRatio = (firstSize + dragDelta) / available` → `updateSplitRatio(splitPath, ratio)`.
The layout engine clamps ratios to **[0.1, 0.9]** and resets any active predefined-layout
index (a manual resize breaks the "even-horizontal etc." association).

**Resize dimensions overlay:** while any divider is being dragged, OR while the grid
container itself is resizing (window/sidebar/inspector changes), every pane shows a
centered floating chip: 13pt medium monospace text on `headerBackground`, rounded 6,
drop shadow, non-interactive. Text is `"<cols> x <rows>"` computed from the terminal's
cell size for shell panes, falling back to `"<widthPx> x <heightPx>"` for panes without a
cell size. The overlay hides **750ms** after the last resize event (divider release or
last grid-size change).

### 4.5 Search overlay

Floating bar pinned to the pane's top-right corner (4pt top / 8pt trailing padding),
shown when the workspace's `searchingPaneID` equals this pane (opened by the terminal
search keybinding; also used by markdown/web find). Chrome: `headerBackground`, rounded
8, shadow.

Contents:

- Text field, placeholder "Search", 160pt wide, 12pt monospace, auto-focused on appear.
  Every keystroke fires `searchNeedleChanged(needle)` live.
- Match-count label inside the field's trailing edge: `"<selected+1>/<total>"` when a
  selection index exists, `"-/<total>"` when only a total is known; hidden while the
  field is empty.
- **Enter** → navigate next; **Shift+Enter** → navigate previous.
- Two chevron buttons: chevron-up = next, chevron-down = previous (matches terminal
  search moving "up" through scrollback for next). Disabled/dimmed while the field is
  empty.
- × button → `searchClose` (also bound to the `close_search` keybinding, Esc by default).

State (`searchNeedle`, `searchTotal`, `searchSelected`) lives on the workspace; results
stream in from the active pane's search engine (terminal, markdown find, or web find —
the web pane drops results from non-active tabs).

### 4.6 Focus & focus-follows-mouse

- `focusPane` updates `focusedPaneID`; the ring moves; the surface grabs keyboard focus.
- **Focus-follows-mouse** (config `focus-follows-mouse`, plus
  `focus-follows-mouse-delay` in ms): hovering over an unfocused pane focuses it —
  immediately at delay 0, else after the delay; moving away before the delay elapses
  cancels. Implemented per pane-hover with a cancelable timer.
- Focusing a pane (or activating the app) schedules a **600ms** timer that clears the
  focused pane's status back to idle (`clearPaneStatus`) — i.e. an "awaiting input"
  badge auto-clears shortly after the user attends to that pane. The timer is
  re-scheduled (canceling the old one) on each focus/activation, and only runs when the
  pane's status ≠ idle.
- App activation additionally clears the dock badge and re-syncs external indicators.

---

## 5. Sidebar (workspace list)

Vertical structure: **filter field** (always on top) → either the main list or the
filtered list → footer. Background `theme.sidebarBackground`.

### 5.1 Filter field

A rounded pill (textPrimary @ 0.05 fill, @ 0.08 border, radius 10) with a magnifier icon
and a plain text field, placeholder **"Filter workspaces or labels"**. Behavior:

- Matching: case-insensitive substring against workspace **name OR any label**;
  whitespace-trimmed needle. Empty needle → normal list.
- Result order: sidebar walk order, but **descends into collapsed groups too** (filtering
  is find-anything).
- **Enter** → activate the first match, clear selection, clear the filter, blur.
- **Esc** → clear the filter and blur (next keystroke goes to the active pane).
- A trailing ×-circle button (visible while non-empty) clears + blurs.
- Filter text is view-local: not persisted, not in app state; keyboard workspace
  shortcuts keep addressing the full set.

**Filtered list**: flat rows (no groups, no drag & drop, no ⌘N badges — the badge index
would be wrong). Each row is the normal workspace row (inset 0) plus, when the workspace
is in a group, a tiny `"in <GroupName>"` caption underneath. Click → activate + clear
filter (find-then-go). Cmd-click AND Shift-click both simply toggle selection here
(range-select is unsupported while filtered because the range basis skips collapsed
groups). Right-click → the same workspace context menu. Empty state: "No matches" /
"Try a different filter or clear the field."

### 5.2 List model

Sidebar order is `topLevelOrder: SidebarID[]` where

```ts
type SidebarID = { workspace: UUID } | { group: UUID };
```

Groups hold `childOrder: UUID[]` and `isCollapsed: boolean`. The rendered list flattens
this into entries:

```ts
type RenderedEntry =
  | { kind: "workspaceRow"; workspaceID: UUID; depth: 0 | 1 }
  | { kind: "groupHeader"; groupID: UUID }
  | { kind: "groupEmpty"; groupID: UUID };   // expanded empty group placeholder
```

A collapsed group emits only its header. `visibleWorkspaceOrder` = the workspaces in
rendered order, **skipping collapsed groups' children** — this drives ⌘1…⌘9 badges,
next/previous workspace cycling, and shift-range selection.

Rows animate reorders with a spring (~0.35s response, 0.8 damping), keyed on the full
flattened layout (top-level order + every group's child order) so cross-container moves
animate too.

The list scrolls with a thin overlay scrollbar. Content has 4pt vertical padding and an
8pt trailing gutter so the ⌘N badges clear the scrollbar. Below the last row, a flexible
spacer absorbs clicks (committing any in-progress inline rename) and offers a
right-click menu: "New Workspace" / "New Group".

### 5.3 Workspace row

Layout: `[avatar 22×22] [name + label chips] …spacer… [⌘N badge]`, 6pt vertical / 8pt
horizontal padding, plus a 2pt outer vertical gap. Nested rows (depth 1) are inset 24pt
from the left (applied outside the background so the selection ring indents too).

- **Avatar**: rounded square (radius 5), fill = workspace color at
  `avatarFill × intensity`, 1px border at `avatarStroke × intensity`. Content by icon:
  - none → first grapheme of the name, uppercased (11pt bold rounded, workspace color);
    empty name → `"?"`.
  - `emoji` icon → the emoji (12pt, native colors).
  - `systemName` icon → the SF-symbol glyph tinted the workspace color.
  - **Status dot** overlaid on the avatar's top-right corner (offset +3,−3): 9pt pulsing
    circle with a 1.5px ring in the sidebar background color. Waiting (any pane
    `waitingForInput`) wins over running; nothing when neither. Pulse = opacity 1 ↔ 0.35,
    1s ease-in-out, auto-reversing forever.
- **Name**: 13pt semibold always (weight never changes with active state so long names
  don't rewrap); `textPrimary` when active, `textSecondary` otherwise; 1 line.
- **Label chips** under the name: up to **3** inline chips + `"+N"` overflow indicator.
  Chip = capsule, 9pt medium text, 5×1 padding; preset-styled labels use the preset's
  solid background + contrast-computed (or explicit) text color, unstyled labels use a
  neutral gray fill with secondary text.
- **⌘N badge**: `"⌘<index+1>"` (10pt monospace, tertiary) shown only when the row's
  index in `visibleWorkspaceOrder` is 0–8. A negative index (filtered list) suppresses it.
- **Backgrounds** (rounded 7):
  - selected (multi-select): `selectionFill` fill + `selectionStroke` @ 0.7 1px outline.
  - active: `selectionFill` @ 0.7 fill + `selectionStroke` 1.5px outline (drawn on top
    of the selected style when both apply).

Row interactions:

- Click → clear selection, activate workspace. (Clicking also commits any in-progress
  group rename first, via blur.)
- Cmd-click → toggle this row in `selectedWorkspaceIDs` (multi-select).
- Shift-click → range select from the anchor over `visibleWorkspaceOrder`.
- Right-click → context menu (§5.6).
- Drag (≥5pt) → reorder / regroup (§5.5).

### 5.4 Group header row

A full-width pill "band" (rounded 8): fill = group color (or neutral tertiary when
colorless) at `groupBandOpacity × intensity` (or the user's `groupFill` override), plus an
optional border (`groupStroke`). Same height as a workspace row.

Contents: `[icon 22×22] [name 13pt bold] …spacer… [chevron]`.

- Icon: default = folder glyph tinted group color (`folder.fill` when colored, outlined
  `folder` when not); custom SF symbol (tinted; "folder" auto-upgrades to filled when
  colored); or emoji (native palette). Same pulsing status dot on the icon corner,
  aggregated over the group's children (waiting > running).
- Chevron: right when collapsed, down when expanded.
- Click header → toggle collapse. Right-click → group context menu (§5.7).
- **Inline rename**: initiated from the context menu. The name becomes a text field
  (auto-focused; focus assignment is deferred a tick so it reliably lands). Enter with a
  non-empty trimmed value commits; Esc cancels; blur commits silently (unless
  empty/unchanged → cancel), matching Finder folders. While renaming, the drag gesture
  is detached (so text selection works) and clicking elsewhere in the sidebar commits
  via blur.
- **Expanded group visuals**: children indent 24pt and a 1.5pt vertical guide line runs
  down the left (at 18pt inset, aligned under the folder icon) in the group color (or
  divider color when colorless), spanning all child rows and the empty placeholder.
- **Empty expanded group**: a placeholder row "No workspaces" (12pt tertiary); the whole
  row is right-clickable with the group context menu.

### 5.5 Sidebar drag & drop

This is the most intricate interaction in the shell. Two drag modes share cursor-offset
state: workspace drags and group drags.

**Geometry model.** Every row reports its measured height keyed by `SidebarID`. Drop
resolution walks `topLevelOrder` top-to-bottom (descending into effectively-expanded
groups) accumulating y from the 4pt content padding, producing **zones**:

```ts
type DropZoneKind =
  | { kind: "topLevelWorkspace"; id: UUID; postRemoveTopIndex: number }
  | { kind: "groupHeader"; groupID: UUID; postRemoveTopIndex: number }
  | { kind: "groupChild"; groupID: UUID; childID: UUID; postRemoveChildIndex: number }
  | { kind: "groupEmpty"; groupID: UUID };
interface DropZone { kind: DropZoneKind; yTop: number; yBottom: number }
```

Dragged rows are omitted from zones but still advance the y cursor (their slots remain in
the layout flow). Indices are **post-remove** — the position after the source is detached
— so they feed the move reducers directly.

Cursor-Y → target resolution:

```ts
type DropTarget =
  | { kind: "topLevel"; index: number }
  | { kind: "intoGroup"; groupID: UUID; index: number }
  | { kind: "ontoGroupHeader"; groupID: UUID };   // append
```

- top-level workspace zone: top half → before (`index`), bottom half → after (`index+1`).
- group header zone: top half → top-level before the group; bottom half →
  `ontoGroupHeader` (append into it).
- group child zone: top/bottom half → before/after that child.
- empty-group placeholder zone: → into that group at index 0.
- cursor below every zone: → top level, after the last top-level entry.
- cursor outside all zones otherwise → no target.

**Workspace drag mechanics:**

- Threshold 5pt; the drag doesn't start until all row heights are measured.
- The grabbed row tracks the cursor exactly (offset = cursorY − grabOffset − restingY),
  rendered above siblings, at 80% opacity, scaled 1.03, with a drop shadow. Cursor
  tracking must NOT animate; everything else springs.
- **Live-apply:** `topLevel` and `intoGroup` targets are applied to state *while
  dragging*, so sibling rows shift out of the way in real time (the reorder itself is
  the drop indicator). `ontoGroupHeader` is **preview-only** (the cursor transits headers
  constantly): it renders as an accent @ 0.18 tint over the header band, and the grabbed
  row previews a nested indent (depth ≥ 1) while it's the target. A between-rows target
  that is not live-applied renders a 2pt accent line at the insertion y.
- **Spring-loading:** hovering a *collapsed* group (header or its would-be children) for
  **650ms** transiently expands it for the rest of the drag (persisted `isCollapsed`
  untouched). Leaving the group cancels/collapses. On release the spring-loaded group
  stays visually open through the drop animation, then collapses.
- **Auto-scroll:** when the cursor is within **40pt** of the viewport top/bottom, scroll
  3pt every 15ms (~200pt/s). Because the OS emits no drag events while the pointer is
  stationary, each tick re-derives the content-space cursor position
  (`viewportY + scrollOffset`) and re-runs the whole target/live-apply/spring-load logic.
- **Empty-group placeholder physics:** when a drag live-applies the group's only member
  in/out, the "No workspaces" placeholder stays/reappears under the dragged row so the
  group's total height is constant while the cursor sweeps it (no layout jumps). Walker
  math mirrors this phantom placeholder exactly.
- **Landing animation:** releasing a single row onto a collapsed group header that stays
  collapsed (setting `expandGroupOnWorkspaceDrop` off and not spring-loaded) animates the
  row to the header's y, shrinking to 0.2 scale at 15% opacity ("falls into the group"),
  then commits the move; the preview state clears ~400ms later. Otherwise release simply
  springs everything home while committing.
- **Multi-drag:** grabbing a row that belongs to a ≥2 multi-selection drags the whole
  selection: the grabbed row shows a `+N` accent capsule at its trailing edge; the other
  selected rows collapse to zero height (hidden) for the duration. During the drag only
  the grabbed row live-applies (single-row gap keeps the target obvious); on release the
  full selection is consolidated **atomically** via a bulk move
  (`moveWorkspacesToGroup(ids, groupID|null, index)`), computed by re-walking zones with
  the entire selection excluded; if the cursor sits in a vacated slot (walker returns
  nothing), fall back to the grabbed row's current container+index converted to a
  post-bulk-remove index.

**Group drag mechanics:** dragging a group header moves the whole group as a block.
Only top-level positions are valid (groups never nest). The dragged group renders
collapsed for the drag's duration. Resolution uses **spans** — one per top-level entry
covering its full block height (header + children if expanded) — with top-half/bottom-half
→ before/after, and below-everything → end. Targets live-apply via `moveGroup(id, index)`.
Same lift styling and auto-scroll as workspace drags.

### 5.6 Workspace context menu

Single-workspace version (also used in the filtered list):

```
Rename…                          → Rename Workspace sheet
Color ▸                          → 10 colors (red orange yellow green blue purple pink gray black white)
Profile ▸                        → "default" + config-defined profiles; active one checked;
                                   an assigned-but-deleted profile stays listed so the
                                   check never disappears
Change Icon ▸
    Symbol ▸                     → curated SF symbols with labels:
                                   Folder, Tray, Archive, Star, Flag, Pin, Bookmark,
                                   Build(hammer), Tests(testtube.2), Terminal,
                                   Package(shippingbox), Docs(book), AI(sparkles)
    Emoji ▸                      → 📁 📂 ⭐ 🔥 💼 🎯 🧪 🐛 📝 🚀 ☁️ 🎨
    Custom Emoji…                → custom emoji sheet
    ──────────
    Reset to Letter              → clears icon (back to first-letter avatar)
Labels ▸                         → every preset with a real-color swatch dot
                                   (checkmark drawn inside when applied); click toggles.
                                   Then any applied free-form labels (checkmark, click
                                   removes). Then "Manage Labels…" → Settings ▸ Labels.
Move to Group ▸                  → "Remove from Group" (when grouped) / each group
                                   (current disabled) / "New Group…" (creates a group
                                   seeded with this workspace, placeholder name,
                                   auto-starts inline rename)
──────────
Select All Workspaces            (disabled when everything is selected)
Deselect All                     (only when a selection exists)
──────────
Delete                           (disabled when it's the last workspace; gated by the
                                  workspace-delete confirmation, §12.2)
```

Bulk version (row is part of a ≥2 selection):

```
"N workspaces selected"          (inert caption)
Color N Workspaces ▸             → sets color on all
Label N Workspaces ▸             → presets with tri-state swatches: check = on all,
                                   dash = on some, plain = none. Click applies-to-all
                                   unless already on all, then removes-from-all.
                                   Free-form labels found on any selected workspace
                                   listed below a divider with check/minus icons.
                                   "Manage Labels…" at the bottom.
Group N Workspaces…              → New Group sheet (name + optional color), then an
                                   atomic group-create with the selection as children
Move N Workspaces to Group ▸     → Remove from Group / each group (disabled when all
                                   selected rows are already in it); atomic bulk move
──────────
Select All Workspaces / Deselect All
──────────
Delete N Workspaces…             → bulk delete confirmation (§12.3); disabled when the
                                   selection is ALL workspaces
```

The tri-state swatches are real-color circles (11pt) with a contrast-colored check or
dash drawn inside — native menus can't tint icons, hence pre-rendered images; in web,
render colored dots directly.

### 5.7 Group context menu

```
New Workspace              → New Workspace sheet pre-scoped to this group
──────────
Rename…                    → inline rename in the header row
Color ▸                    → "None" + the 10 colors
Change Icon ▸              → Symbol ▸ / Emoji ▸ / Custom Emoji… / Reset to Folder
Expand | Collapse
──────────
Delete Group…              → group delete confirmation (§12.4)
```

### 5.8 Selection header & footer

- **Selection header** (pinned above the list whenever `selectedWorkspaceIDs` is
  non-empty): `"N selected"` + "Select All" (hidden when everything is selected) +
  "Clear", on accent @ 0.12.
- **Footer** (pinned at the bottom, opaque sidebar background + top divider):
  `+ New Workspace` (plain button, opens the sheet) · a small chevron-down menu with
  "New Workspace" / "New Group" · right-aligned `⌘N` hint. "New Group" creates a group
  with an auto-unique placeholder name ("New Group", "New Group 2", …) and immediately
  enters inline rename.

### 5.9 Scroll-new-entry-into-view

Creating a workspace/group (UI, palette jump, or CLI) sets a one-shot
`sidebarScrollTarget: SidebarID`. The list consumes it: waits for the new row to be
measured, then scrolls the minimum distance to fully reveal it (honoring the pinned
header/footer insets), animated ~0.22s. A workspace hidden inside a collapsed group
resolves to its group header instead. While the filter is active, the request is dropped.
Command-palette confirms also set this target so a far-away workspace scrolls into view.

---

## 6. Inspector

Right-hand panel, fixed width **280**, sidebar background, only rendered when visible AND
a workspace is active. Header row "Inspector" + ×-circle close button, then a divider,
then a scrollable stack of three sections (12pt padding, dividers between):

**Workspace section** — "Workspace" caption; a 4×16 rounded bar in the workspace color +
name; "N pane(s)" caption; a **Profile** dropdown (built-in `default` first, then config
profiles, plus the currently-assigned name even if it vanished from the config; selecting
dispatches `setProfile` — applies to future pane spawns only).

**Repositories section** — "Repositories" caption. Content:

- Graft-orphan banners for any orphaned graft breadcrumbs matching this workspace's
  association paths (graft subsystem).
- "No repositories associated" caption when empty.
- Associations grouped by repo, main checkout first, worktrees indented 12pt beneath:
  - Row = `[git-status dot 8pt: gray unknown / green clean / red dirty]`
    `[icon: drive for main, branch for worktree]`
    `[title: repo name (main) or branch name (worktree)]` with a sub-line of
    `[branch (main rows)]` `[dirty stats: doc icon + file count, "+adds" green,
    "-dels" red, 10pt mono]`; then right-aligned buttons:
    - worktree rows only: the **graft toggle** (graft subsystem).
    - **± diff button** (tooltip "Show diff for this repo") → opens a diff pane for
      that path.
    - **terminal button** (tooltip "Open terminal at this path (Shift: split
      vertical)") → splits a new shell pane at the association path; shift = split
      down instead of right.
  - Row context menu: "Remove" (drops the association), and for worktrees
    "Remove & Delete Worktree" (also deletes the git worktree).
  - When a repo group has worktrees but no main association, a non-interactive repo
    header anchors them.
- **Add menu** (borderless "+ Add", disabled when the repo registry is empty):
  "Add Repository" → multi-select repo picker sheet; "New Worktree" → if the workspace
  (or registry) resolves to exactly one candidate repo, jump straight to the Create
  Worktree sheet, otherwise a single-select repo picker first.
- Worktree-creation failures surface as an alert "Couldn't create worktree" + message.

Inspector icon buttons show a hover background, brighten on hover, and use a pointer
cursor.

**Panes section** — "Panes" caption; one row per pane: terminal icon,
`title ?? label ?? "Shell"`, right-aligned focused-pane indicator (blue arrow-circle) and,
when the workspace has >1 pane, an × close button per row.

---

## 7. Command palette

Toggled by the `command_palette` keybinding (default **⌘P**; also in the app menu).
Overlay covers the content row (not title/status bar) with an almost-invisible backdrop —
clicking anywhere outside dismisses. The panel (440 wide, `surfaceBackground`, radius 10,
big shadow) slides in from the top with a fade (~0.15s), pinned 40pt from the top.

Structure:

- Search row: magnifier icon + plain text field, placeholder
  **"Jump to workspace or pane..."**, auto-focused, 14pt.
- Results list (max height 300, scrollable) or, with a non-empty query and no items,
  a "No results" row.

**Item universe** (rebuilt from state on every read):

- One item per workspace: icon `rectangle.stack`, title = name, subtitle = "N pane(s)".
- One item per pane (in layout order): icon per type (terminal/doc/note/±/globe);
  title = `label ?? title ?? cwd(~)`; subtitle = the terminal title when a distinct label
  exists, the cwd when only a label exists, else empty.

**Filtering** (substring, not fuzzy):

- Lowercase the query, trim leading whitespace.
- Scope prefixes: `w:` → workspaces only, `p:` → panes only (prefix stripped).
- Split the rest on spaces → terms; every term must be contained in
  `title + " " + subtitle + " " + workspaceName` (lowercased). No terms → whole scope.
- Empty query → everything (workspace, its panes, next workspace, …).

**Row rendering:** workspace-color dot (8pt) · type icon · title (13pt) over subtitle
(11pt secondary) · trailing tag — for workspace items a neutral `"workspace"` chip; for
pane items a chip with the workspace name on the workspace color @ 0.7 with white text.
Selected row = accent @ 0.2 background.

**Keyboard/mouse:** ↑/↓ move the selection (clamped, scrolls the row to center);
hovering a row selects it; Enter or click confirms; Esc (or backdrop click) dismisses.
Query changes reset the selection to 0.

**Confirm:** close the palette; activate the item's workspace (bumping
`lastAccessedAt`, persisting, refreshing git status); focus the item's pane if it is a
pane item; set the sidebar scroll target; and ~200ms later (after the fade-out) hand
keyboard focus to the destination pane's surface. Dismiss/Esc paths do the same focus
handoff to the previously focused pane so the keyboard never lands nowhere. Confirming
with an empty result list just closes.

---

## 8. Bottom status bar

24pt-high footer, `footerBackground`, 1px top divider, 11pt text in `textSecondary`,
12pt horizontal padding.

**Left cluster** (focused pane of the active workspace; empty if none):

1. cwd, home-abbreviated, middle-truncated.
2. Git branch (branch icon + name, tertiary) when known.
3. Working-tree dirty stats for the repo association containing the pane's cwd (longest
   path-prefix match wins): `doc N` files (tertiary) + `+A` green + `-B` red, 10pt mono.
   Hidden when clean/untracked.
4. Agent segment when the pane has an agent session: running → `<agentKind> <elapsed>`
   in `activeAgent` amber (elapsed only when a start time is known; 1s ticker);
   waiting → `awaiting input` in `statusWaiting`; idle → nothing.

**Right cluster** (fixed, never wraps): optional system-stat gauges (§8.1), then three
agent counts, then a live `HH:MM` clock (1s ticker, monospaced digits).

Counts: `● N running` / `● N waiting` / `● N inactive` — dot in the corresponding theme
status color, count right-aligned in a fixed 14pt slot (no jitter at 9→10).
Definitions over ALL workspaces: running = panes with status running; waiting = status
waitingForInput; inactive = attached agent session (`agentSessionID != null`) with idle
status. A zero count is inert; a non-zero count is a button that opens a popover
(252 wide, `surfaceBackground`): title row (dot + "Running agents" / "Awaiting input" /
"Inactive agents"), then one row per pane — workspace-color dot, workspace name
(secondary), `·`, pane title (primary, middle-truncated), and for running rows a live
elapsed timer in amber. Clicking a row activates that workspace + focuses that pane and
closes the popover. (macOS must also juggle first-responder restoration; web just
focuses.)

### 8.1 System stat gauges

Gated by `showSystemStats` (master toggle) and a per-metric enabled set. Metric kinds, in
canonical order: `cpu`, `memory`, `load`, `network`, `diskIO`, `diskSpace`. Each gauge:
9pt icon (`cpu`, `memorychip`, gauge, `network`, drive-with-clock, `internaldrive`) +
compact value (monospaced digits) right-aligned in a fixed per-kind slot, in
`textTertiary`; optionally followed by an inline **sparkline** (default width 28,
height 11) when `showSystemStatGraphs` is on and ≥2 samples exist.

- Sampling: every **2s** while enabled; a rolling history of **60 samples** (~2 min) is
  kept per metric (all metrics are sampled so a newly enabled one has history).
- Sparkline styles: `line` (1px trace + 15%-opacity area fill) or `dots` (columns of
  stacked dots, 3pt column / 2.6pt row spacing, filled count tracks the value; unfilled
  dots at 12% opacity). Percentage-bounded metrics (cpu, memory, diskSpace) scale to a
  fixed 0–100; the rest auto-scale to the window max.
- Sparkline color: user hex override (`sparklineColorHex`) or `textSecondary`.
- Hover popover (220 wide): metric name + icon; verbose breakdown line; a larger
  196×52 filled graph in a bordered rounded box; `now / min / max / avg` mini-columns;
  caption `"last N samples · ~2Ns"`. Value formatting: percentages as `NN%`, load as
  `0.00`, network/diskIO as a byte-rate string.

---

## 9. Menu-bar (tray) status item

An 18×18 icon in the macOS menu bar (system tray equivalent): a terminal glyph with a
6pt status dot on the top-right corner — waiting color when any pane waits (priority),
else running color when any runs, else no dot (and the icon renders monochrome/template).
Colors come from the chrome theme's status colors.

Clicking toggles a popover (280 wide, height fits content up to 400):

- Empty state: check-circle icon + "All clear".
- Otherwise a scrollable list grouped by workspace (groups sorted by name): a group
  header (workspace-color dot + name, caption-bold), then rows per active pane —
  monospace pane title (middle-truncated) + status dot on the right (waiting = pulsing
  ring, running = solid green). Row click → activate the app + main window, switch to
  that workspace, focus that pane, close the popover.
- The popover closes on any outside click.

Items shown are the running/waiting panes (`StatusBarItem { workspaceName,
workspaceColor, paneTitle, paneID, workspaceID, status }`), pushed to the controller by
the reducer whenever counts change.

---

## 10. Sheets

All sheets sit on `surfaceBackground`. Enter = default action, Esc = cancel throughout.

### 10.1 New Workspace (360 wide)

Fields, top to bottom:

1. Title "New Workspace".
2. **Name** text field (auto-focused; Enter submits). Create is disabled while the
   trimmed name is empty.
3. **Color** swatch row: the 10 workspace colors as 24pt circles; the selected one gets
   a 2px primary ring. Initial value: random, excluding the color of the current last
   workspace (so neighbors differ). The row is a single keyboard-focus stop; ←/→ cycle
   the selection.
4. **Group** dropdown (only when groups exist): "No group" + each group. Default: a
   pending group scope if the sheet was opened from a group's "New Workspace" item;
   else, when the `inheritGroupOnNewWorkspace` setting is on, the active workspace's
   group; else none.
5. **Profile** dropdown: `default` first, then config-defined profiles.
6. **Repositories** (only when the repo registry is non-empty): the chosen repos as rows
   (drive icon + name + ×-circle remove), plus "+ Add Repository" → multi-select repo
   picker sheet.
7. **Worktree section** (only when exactly ONE repo is selected):
   - "Create git worktree" checkbox; when on:
   - "Worktree name" field; "Branch name" field — the branch mirrors the worktree name
     until the user hand-edits the branch (then mirroring stops; it resumes if they make
     them equal again). Enter in the branch field submits when valid.
   - "Update main first (fetch + branch off origin)" checkbox.
   - Live preview (tertiary caption): `"<resolvedWorktreeBasePath>/<sanitizedName>"` and
     `"branch: <sanitizedBranch>"` — names are git-sanitized (spaces/unsafe chars →
     hyphens); an unsanitizable value renders `<name>`/`<branch>` and disables Create.
8. Error line (red caption) when an async worktree creation failed — the sheet stays
   open for retry; the Create button un-disables when the error arrives.
9. Cancel / **Create**. Create is disabled while a worktree submission is in flight
   (double-submit guard). The worktree route dispatches
   `createWorkspaceWithWorktree(...)`; success dismisses the sheet from the reducer;
   failure surfaces the inline error. The plain route dispatches
   `createWorkspace(name, color, repos, groupID, profileName)`.

Keyboard: Tab / Shift-Tab cycle through every *visible* control in reading order
(name → color → group → profile → repo removes → add-repo → worktree toggle →
worktree fields → cancel → create), wrapping; the Create stop is omitted while disabled.

### 10.2 Rename Workspace (300 wide)

Title, a text field pre-filled with the current name, Cancel / **Rename** (disabled when
the trimmed value is empty; Enter submits).

### 10.3 Rename Pane (320 wide)

Title "Rename Pane", field placeholder "Pane label (leave empty to clear)" pre-filled
with the current label; submitting an **empty** string clears the label (falls back to
cwd/title display). Rename dispatches the same `pane-name` wire command as the CLI.

### 10.4 New Group (320 wide)

Used by "Group N Selected Workspaces…". Title "New Group"; caption
"Group N selected workspace(s)."; name field pre-filled with the unique placeholder name;
a color row of 16pt circles — a "None" stroke-only swatch first, then the 10 colors, the
chosen one showing a small checkmark; Cancel / **Create** (disabled while empty).

### 10.5 Custom Emoji (340 wide)

Shared by group icons and workspace icons. Title `Custom Emoji for "<name>"`; caption
explaining input rules; a large-font text field (placeholder 🔥) that hard-truncates its
content to the **first grapheme cluster** on every change (ZWJ sequences / flags / skin
tones survive as one grapheme); a "browse emoji" button that opens the OS emoji picker
routed into the field; Cancel / **Set Icon** (disabled unless the grapheme passes the
emoji-ish validation). Validation accepts: emoji-presentation base scalars; explicit
U+FE0F on an emoji-capable base (❤️, keycaps); bare non-ASCII `Emoji=Yes` scalars (✂, ©);
non-ASCII symbol-category glyphs (⛙ ♞ → ⌘). It rejects letters, digits, punctuation,
whitespace, ASCII, and lone modifiers.

### 10.6 Create Worktree (320 wide, inspector flow)

Title "New Worktree"; caption "Create a worktree for **<repo>**" plus a "Change" link
(only when >1 repo is registered) that reopens the repo picker; worktree-name and
branch-name fields with the same mirroring behavior as §10.1; the same sanitized live
preview; Cancel / **Create** (disabled unless both sanitize to something usable; Enter in
the branch field submits).

---

## 11. Help window

Separate small window (420×300, content-sized, centered), opened by Help ▸ "Kelpi Help"
(⌘?): app icon 64pt + "Kelpi" + "Version X.Y.Z"; a "Keyboard Shortcuts" section that is
just a pointer — "View and customize all keyboard shortcuts in" + a
"Settings > Keybindings" link button; a "GitHub Repository" link.

---

## 12. Confirmation dialogs

All confirmations put **Cancel as the default/Return button** with the destructive action
second, and honor their "Don't ask again" suppression even when Cancel is clicked.

### 12.1 Quit confirmation

Every termination path (menu Quit, ⌘Q, OS logout, updater relaunch) first flushes pending
markdown auto-saves and stops graft sessions, then — unless disabled by the
`confirmQuitWhenActive` setting/suppression — shows a warning dialog:

- Title "Quit Kelpi?".
- Body: with active agents → "Kelpi has N active agent(s) across M workspace(s). Quitting
  will terminate all sessions."; with none → "Are you sure you want to quit Kelpi?".
- Buttons Cancel (default) / Quit (destructive); "Don't ask again" checkbox writes the
  same key as the Settings toggle.

"Active agents" = panes (including parked ones) with status running or waitingForInput.

### 12.2 Workspace delete gate

Deleting a single workspace with active agents (running/waiting panes), when the
`confirmWorkspaceDeleteWhenActive` setting is on: warning dialog
`Delete "<name>"?` / "This workspace has N active agent(s). Deleting it will terminate
it/them." Cancel (default) / Delete (destructive) / "Don't ask again". No active agents,
or setting off → delete immediately. The sidebar Delete item is disabled when only one
workspace remains. (The CLI's `--force` bypass is server-side and independent.)

### 12.3 Bulk delete confirmation

"Delete N workspace(s)?" with body "This cannot be undone. Panes and surfaces in these
workspaces will be closed." Delete (destructive) / Cancel. Mounted at the sidebar-body
level so it works while the filter view is active.

### 12.4 Group delete confirmation

Title `Delete "<group>"?`. Empty group → body "This group is empty and will be removed."
with a single "Delete Group" action. Non-empty → body explaining the choice, with TWO
destructive options: "Move Workspaces to Top Level" (delete group, promote children) and
"Delete Group and N Workspace(s)" (cascade), plus Cancel.

### 12.5 Graft swap prompt

`Already grafting into <repo>` — body naming the existing graft branch/worktree and the
requested one, options "Stop existing & swap" (destructive) / "Keep existing" (cancel).
(Graft subsystem supplies the state; the shell just presents it.)

---

## 13. App bootstrap & cross-cutting shell behaviors

Once-per-app startup (guarded so a second window can never re-run it): start the terminal
runtime; load ghostty config and apply saved appearance overrides (opacity/custom
background) BEFORE any pane spawns; request notification permission and wire its
"Open" action to activate-workspace + focus-pane; set up the tray item; register the
global hotkey callback; dispatch `appLaunched` (async state load); start the socket
server (+ TCP listener when `tcp-port` configured) and route every wire message into the
reducer; wire the Finder file-open bridge (cold-launch arrivals are buffered, then queued
in state until the persistence load lands, then flushed); wire the quit gate; start the
keyboard shortcut monitor.

Shell-level event plumbing the web client must reproduce with daemon events:

- terminal title change → `surfaceTitleChanged(paneID, title)` (header/status bar text);
- terminal pwd change → `surfaceDirectoryChanged` (header path, git branch refresh);
- terminal child exit → `surfaceProcessExited(paneID)`;
- terminal-emitted desktop notification → notification service;
- OSC/file-open from terminal → `openFileAtPath(path, fromPaneID)`;
- terminal search lifecycle → search overlay open/close/total/selected;
- app became active → clear dock badge, refresh indicators, repaint any surface that
  went blank while occluded, schedule the focused pane's 600ms status clear.

Menu-bar app menus mirror the keybinding map: New Workspace (⌘N), New Group (⌘⇧G),
Preview Markdown… (⌘O), New Web Pane (⌘⇧O), Command Palette (⌘P), workspace switch
(⌘1…⌘9), Select/Deselect All Workspaces, Toggle Sidebar (⌘⇧S), Toggle Inspector (⌘I) —
all shortcuts are user-rebindable, the menu reflects the current binding.

---

## 14. Data shapes referenced by this spec

```ts
type UUID = string;

type PaneStatus = "idle" | "running" | "waitingForInput";
type AgentKind = "claude" | "codex";
type PaneType = "shell" | "markdown" | "scratchpad" | "diff" | "web";

interface Pane {                      // fields the shell UI reads
  id: UUID;
  type: PaneType;
  label?: string;                     // user tag; header chip + palette title
  title?: string;                     // live terminal title
  workingDirectory: string;
  gitBranch?: string;
  status: PaneStatus;
  filePath?: string;                  // markdown/diff target
  isEditing: boolean;                 // markdown edit mode
  externalEditorCommand?: string;     // when editing in $EDITOR terminal
  scratchpadContent?: string;
  agentSessionID?: string;
  agentKind?: AgentKind;
  agentStartedAt?: string;            // ISO; drives elapsed badges
  backgroundTaskCount: number;        // transient; "· N running"
  markdownFontSize: number;
}

type WorkspaceColor =
  | "red" | "orange" | "yellow" | "green" | "blue"
  | "purple" | "pink" | "gray" | "black" | "white";
// black/white are adaptive monochromes: black = dark gray in light mode /
// mid gray in dark; white = light gray / near-white — always visible on the chrome.

type GroupIcon =
  | { kind: "systemName"; name: string }   // stored "system:<name>"
  | { kind: "emoji"; grapheme: string };   // stored "emoji:<grapheme>"

interface WorkspaceGroup {
  id: UUID; name: string; color?: WorkspaceColor; icon?: GroupIcon;
  isCollapsed: boolean; childOrder: UUID[];
}

interface LabelPreset { name: string; color: LabelColor; textColor?: LabelColor }
interface ResolvedLabelStyle { background: Color; text: Color }
// text = explicit override, else black/white by sRGB luminance (> 0.6 → black)

interface CommandPaletteItem {
  id: string;              // "ws:<uuid>" | "pane:<uuid>"
  icon: string; title: string; subtitle: string;
  workspaceID: UUID; workspaceName: string;
  paneID: UUID | null; workspaceColor: WorkspaceColor;
}

interface ChromeStatusSummary { running: number; waiting: number; inactive: number }

interface StatusBarItem {   // tray popover rows
  workspaceName: string; workspaceColor: WorkspaceColor;
  paneTitle: string; paneID: UUID; workspaceID: UUID; status: PaneStatus;
}

// Pane-grid drag & drop
type PaneDropZone = "top" | "bottom" | "left" | "right";

// Sidebar drag & drop — see §5.5 for DropZoneKind / DropTarget.
```

Sidebar/selection state on the app: `topLevelOrder: SidebarID[]`,
`groups`, `selectedWorkspaceIDs: Set<UUID>`, `renamingGroupID?`, `renamingWorkspaceID?`,
`renamingPaneID?`, `sidebarScrollTarget?: SidebarID`, `isCommandPaletteVisible`,
`commandPaletteQuery`, `commandPaletteSelectedIndex`, `isSidebarVisible`,
`isInspectorVisible`, plus the various confirmation-prompt slots
(`bulkDeleteConfirmationIDs`, `groupDeleteConfirmation`, `groupBulkCreatePrompt`,
`groupCustomEmojiPrompt`, `workspaceCustomEmojiPrompt`, `worktreeCreationError`).

---

## 15. Port notes

**Architecture split.** In the port, everything in this doc is client-side rendering over
daemon state. The daemon owns: workspaces/groups/panes/layout, order lists, selection is
debatable (keep selection client-local; it is ephemeral UI state), pane statuses, agent
metadata, git statuses, persistence, and the confirmation *policies* (e.g. last-workspace
guard, active-agent counts). The client owns: filter text, drag state, row measurements,
palette open/query/selection (unless you want palette sync across clients — current app
treats it as app state but nothing external reads it), sidebar width, hover/focus timers,
resize-overlay visibility, diff refresh tokens.

**Things that must be daemon-authoritative** (multiple clients may be attached):
active workspace + focused pane, sync-input group, zoom state, pane labels/statuses,
sidebar order mutations (move/group/reorder are already wire commands), workspace/group
CRUD. UI-only affordances today with **no wire command** — group/workspace icon
management, label presets, chrome theme settings — will need daemon endpoints (or
client-persisted settings) in the port; note the CLAUDE.md states group icon management
is deliberately UI-only, so keep it off the CLI wire protocol but the web client still
needs a persistence path (daemon settings store).

**Live-apply drag model.** Sidebar drags mutate real order state *during* the drag
(live-apply) — dozens of `moveWorkspace/moveWorkspaceToGroup/moveGroup` dispatches per
drag. Over a WebSocket this would spam persistence and other clients. Recommended port
adaptation: perform live-apply against a client-local shadow of the order lists for
rendering, and commit ONE atomic move (or the bulk move) to the daemon on release. The
post-remove-index semantics of `moveWorkspace(toIndex)` / `moveWorkspaceToGroup(groupID,
index)` / `moveWorkspacesToGroup(ids, groupID, index)` / `moveGroup(toIndex)` must be
preserved exactly (remove-then-insert).

**Menu stability.** Two macOS bugs shaped this code (issues #124/#227): open context
menus being destroyed by unrelated re-renders (agent status ticks). Web context menus
built as portals with state-independent lifetimes avoid the workaround entirely — but
keep the requirement: an open menu/submenu must survive 1s-cadence status updates in the
row beneath it.

**Focus management.** The app carefully sequences keyboard-focus handoff (palette close →
200ms → focus surface; popover row click → focus surface before dismissal; suppression of
focus grabs while sidebar text fields are editing; status-bar/tray navigation racing
window first-responder restoration). In web this collapses to `element.focus()` ordering,
but keep: (a) closing the palette/search always returns focus to the focused pane;
(b) inline editors are never robbed of focus by re-renders; (c) selecting a pane from
tray/status popovers focuses it *after* switching workspaces.

**Timers to reproduce:** 600ms focused-pane status auto-clear; 750ms resize-overlay
linger; 650ms drag spring-load; 40pt/3pt/15ms drag auto-scroll; 1s pulse animation; 1s
elapsed/clock tickers; 2s system-stat sampling with 60-sample history; 500ms editor
debounces (other subsystem); 0.15s palette transition; ~0.35s spring for sidebar
reorders; 0.22s scroll-reveal.

**Terminal-surface identity.** The grid's contract — pane DOM/view instances are stable
across every layout mutation, only repositioned — is essential for ghostty-web too.
Render panes as absolutely-positioned siblings keyed by pane id (the current app computes
frames from the layout tree into a flat coordinate space; replicate that rather than
nesting flex containers, so moves/splits never re-mount a terminal).

**System stats** are sampled in-process on macOS. In the port the daemon (or Electron
main) must sample and stream them; remote/mobile clients then show daemon-host stats,
which is arguably the more useful semantic.

**Tray + dock.** The menu-bar item, dock badge, and desktop notifications are Electron
main-process features; the web-only client can degrade to a favicon badge/notification
API. Keep the waiting-beats-running priority and theme-colored dots.

**One mark, every surface.** The Dock tile, the menu-bar glyph and the browser tab all
draw the same Kelpi mark: the kelpie head in `core/assets/kelpi-icon.svg`, restated as
path data in `@kelpi/core/icon` and rendered rather than shipped as a binary. The art
lives in core precisely so the browser can draw it too. A client attached over the tailnet
therefore carries the app's identity in its tab, and none of the forms it takes there is a
placeholder glyph or a checked-in image:

- the served document links `/favicon.svg`, `/favicon.png` and `/apple-touch-icon.png`,
  all three printed from that data at build time;
- once the client is running, it replaces the href of *every* `link[rel~="icon"]` with a
  canvas render of the same mark carrying the status dot.

Both raster forms are load-bearing rather than fallbacks. Safari renders no SVG favicon
and re-reads no icon that script swapped in, so on an iPhone `/favicon.png` is the only
icon that ever shows and it is never badged; the mark has to be right without the badge.

Every small render applies the same stroke floor (`KELPIE_MIN_STROKE_FRACTION`: one device
pixel at 16px). The drawing's own hairline is ~1.2% of its square, which at tab size is a
fifth of a pixel, so a form that skipped the floor would render a grey ghost and then
visibly thicken the moment the client mounted.

**macOS-specific behaviors that need Electron equivalents:** quit interception with the
flush-then-confirm pipeline; window frame persistence + off-screen clamping; single
instance/window; Finder file-open routing; "double-click title bar" preference (Electron:
just zoom/maximize); native emoji picker (web: an emoji-picker component; the
first-grapheme truncation and emoji validation logic port directly).

**Vibrancy caveat.** Terminal `backgroundOpacity < 1` currently makes the whole window
transparent to the desktop. In a browser this is impossible; in Electron it needs a
transparent BrowserWindow. A reasonable web fallback: treat opacity < 1 as opacity 1 for
the window, but keep the non-terminal panes' tinted-background blending (they blend
against the chrome, which still looks correct).

**Hex colors are canonical.** All chrome colors are plain sRGB hex — they translate to
CSS custom properties directly. Implement `resolve(appearance, system, overrides)` as a
pure function producing a CSS-variable set; the two adaptive workspace monochromes
(black/white) need light/dark variants via the same mechanism.

**Suppression settings** (`confirmQuitWhenActive`, `confirmWorkspaceDeleteWhenActive`)
live in UserDefaults today, shared between dialog checkboxes and Settings toggles with a
change broadcast. Port them into the daemon settings store so Settings UI and dialogs
stay in sync across clients.

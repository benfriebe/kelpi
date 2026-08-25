# ghostty-web 0.4.0-nex.4 (vendored)

A build of `ghostty-web` v0.4.0 carrying two open upstream PRs — applied after a line-by-line
review in the orchestrating session and explicit user authorization to integrate both — plus three
Nex-authored adaptations on top of them (`-nex.2`: the caret-anchored IME; `-nex.3`: an
`allowTransparency` that does something; `-nex.4`: a cursor that knows whether its surface has
focus).

| Version | What it added |
|---|---|
| `0.4.0-nex.1` | upstream v0.4.0 + PR #120 + PR #159 + the local adaptations they needed |
| `0.4.0-nex.2` | the IME (hidden textarea **and** preedit) anchored to the cursor cell |
| `0.4.0-nex.3` | `allowTransparency` HONOURED: the default background is cleared, not filled |
| `0.4.0-nex.4` | `setFocused` — an unfocused surface draws ghostty's steady hollow cursor |

## Base

- Upstream: https://github.com/coder/ghostty-web at tag `v0.4.0`
- `ghostty-vt.wasm`: byte-identical to the npm `ghostty-web@0.4.0` package (the patches are
  TypeScript-only; no wasm rebuild)
- Built with the repo's own `vite build` (bun unavailable; `pnpm install` + `npx vite build`,
  wasm copied beside/into dist as `build:wasm-copy` does)

## Patches carried

1. **PR #120** — "fix: Korean/CJK IME composition events not captured" (fixes upstream #119).
   Composition listeners move to the hidden textarea, `contenteditable` is removed from the
   container, focus routes to the textarea, composition preview chip, and the wide-character
   continuation-cell fix in selection-manager (CJK copy spacing).
2. **PR #159** — "refactor(input): route every keydown through the Ghostty encoder".
   Deletes the printable/special-key fast paths; every keydown goes through ghostty's WASM key
   encoder with a per-option cache (Home/End honor DECCKM, Shift+Enter emits the fixterms
   sequence as native ghostty does).

## Local adaptations (v0.4.0 lacks parts of the PRs' base)

- **inputElement bridge**: v0.4.0's `InputHandler` does not know its textarea. Added a
  `private inputElement` member + optional constructor parameter; `terminal.ts` passes
  `this.textarea`.
- **beforeinput bridge + keydown dedupe**: upstream main forwards textarea-inserted text via a
  `beforeinput` listener with 100ms keydown dedupe; v0.4.0 has neither, and PR #120 depends on
  them once focus lives on the textarea. Minimally ported (`handleBeforeInput`,
  `recordKeyDownData`, `lastKeyDownData/Time`, `BEFORE_INPUT_IGNORE_MS`), `insertText` only.
- **Printable fallback for code-less key events**: PR #159 drops any keydown whose
  `KeyboardEvent.code` is unmapped. Synthetic keyboards (CDP without `code`, some mobile IMEs)
  send none. When `code` fails to map and no ctrl/meta/alt is held, a single-Unicode-scalar
  `event.key` is emitted directly (upstream 0.4.0's old behavior for exactly these events).
- **Composition-terminator hardening**: `processPendingKeyAfterComposition` only replays
  single-character keys; a composition ended by a named key (e.g. "Enter") would otherwise
  write the literal key name to the PTY.
- **PR #120's upstream-main-only context dropped**: the engine mouse listeners and
  `shouldIgnoreCompositionEnd` referenced by the PR's surrounding context do not exist at
  v0.4.0 and were not introduced (Nex does its own mouse reporting client-side).
- **PR #159's upstream-main-only fields dropped**: the paste/beforeinput/composition dedupe
  field block from newer main was not taken wholesale; only `syncedEncoderOptions` and the
  reused `TextDecoder` (plus the dedupe trio above).

## Nex adaptation: caret-anchored IME (`0.4.0-nex.2`, 2026-08-21)

PR #120 made composition *arrive*; it did not put it anywhere sensible. Both of the elements a
CJK user reads while typing were pinned to the engine **container**:

- the hidden `<textarea>` at `left:0; top:0`, 1×1 — and that box is what the browser hands the
  OS as the composition rect, so the input method's candidate window opened at the pane's
  top-left corner however far down the screen the caret was;
- the preedit at `top:4px; right:4px` as an amber `조합중: …` chip, i.e. the user's own
  in-flight text displayed at the opposite corner from where it was going to land.

`0.4.0-nex.2` moves both onto the cursor cell, xterm.js-style, in `lib/terminal.ts`:

- **`syncImeCaret(cursorX, cursorY)`** — called once per rendered frame from the render loop
  with the cursor the renderer just drew, and it returns after four number comparisons unless
  the cell box actually changed. The render loop rather than `onCursorMove` on purpose: that
  event only fires on a row change, so it misses ordinary typing along a row, and it never fires
  on a resize (which changes the cell box without moving the cursor). The box is computed in the
  coordinate space the absolutely-positioned textarea and preedit share — `canvas.offsetLeft/Top`
  plus `cursor × cell`, both resolved against the same containing block — so an embedder whose
  canvas does not sit at the container's origin (Nex pads the pane by 2px for its focus ring)
  still anchors exactly. `viewportY` is added in and the result is clamped to the canvas, so a
  scrolled-back terminal keeps the candidate window inside the pane instead of floating it over
  the surrounding app.
- **The textarea is sized to the cell** (`width/height/fontSize/lineHeight`), not left 1×1: some
  IMEs read a 1px box in a cell's corner as the corner of the pane. It is also
  `pointer-events: none` now — it sits under the pointer whenever the pointer is over the caret,
  and a hit-test it stole from the canvas would break selection drags that start there. Focus is
  routed programmatically (canvas `mousedown` → `textarea.focus()`), so nothing is lost.
- **The preedit is marked text at the caret** — `data-ime-preedit`, the terminal's own font at
  the terminal's own cell height, painted on the theme background over the cells it is about to
  fill, under a solid underline ~10% of a cell thick (macOS marked text). `updatePreedit()`
  applies the *same* cached caret box the textarea uses, so the two can never point at different
  cells, and a long preedit near the right edge is shifted left only as far as it overflows the
  canvas.
- **It cannot outlive its composition**: `compositionstart` / `compositionupdate` /
  `compositionend` and `blur` all route through one `setPreedit(text)` with `''` as the cleared
  state, and clearing removes the text as well as hiding the element.

The `조합중:` label is gone with the chip — the preedit now shows the in-flight string alone,
which is what marked text is.

Not addressed here, and still open: nothing reports a caret rect to the *OS* beyond the textarea
box (that is the browser's job and it is what the box exists for), and modifier press/release
(TERM-030) remains unimplemented — the bundle still registers zero `keyup` listeners.

## Nex adaptation: `allowTransparency`, honoured (`0.4.0-nex.3`, 2026-08-25)

`ITerminalOptions.allowTransparency` has existed since v0.4.0. It was read once, into
`baseOptions` (`lib/terminal.ts:162`), and then never again: the renderer was constructed
without it and every paint of the DEFAULT background was an opaque
`fillStyle = theme.background; fillRect(…)`. So an embedder that painted a translucent fill
behind the canvas — the entire purpose of the option — still got a solid terminal.

That is the engine half of **N17**: a Nex sandbox seeded with `background-opacity = 0.85`
showed zero bleed-through on a terminal pane. The window was created transparent, the DOM
carried the alpha, and the canvas painted over all of it.

`-nex.3` makes the option mean what it says, in `lib/renderer.ts`:

- **`paintDefaultBackground(x, y, w, h)`** — one seam for the four places that used to write
  `fillStyle = theme.background; fillRect(…)`: `resize()`, `renderLine()`, `clear()` and the
  scrollbar's clear strip. With the option OFF it is literally those two statements. With it on
  the rectangle is `clearRect`ed, and the canvas has always been
  `getContext('2d', { alpha: true })`, so the element behind it shows through. **Clearing, not
  filling with an `rgba()`** — these rectangles are repainted per frame and per line, and a
  translucent fill would COMPOUND, darkening a cell towards opaque the longer it sat there.
- **`isDefaultCellBackground(r, g, b)`** — upstream decides "this cell has no background of its
  own" by `(0, 0, 0)`, which holds only when the WASM terminal was configured without a
  `bgColor`. Nex configures one (the ghostty `background` key), and every untouched cell then
  reports *that* colour, so pass 1 filled every cell opaquely and the cleared line underneath
  was never seen. Under `allowTransparency` a cell whose background IS the theme background
  counts as default too. `defaultBackgroundRGB` caches the components and `setTheme` refreshes
  it alongside the palette.
- `lib/terminal.ts` passes `this.options.allowTransparency` into the `CanvasRenderer`.

Text is untouched: glyphs, explicit `SGR 48` cell backgrounds, selection and cursor all still
paint opaque, which is what ghostty's own `background-opacity` does — it dims the background,
never the characters.

The honest edge, stated where the code makes it: an application that sets a cell's background
EXPLICITLY to the exact theme background becomes translucent there rather than opaque. Nothing
on screen can tell those apart except the desktop behind the window, and the alternative is the
defect this removes.

## Nex adaptation: the cursor follows surface focus (`0.4.0-nex.4`, 2026-08-25)

Upstream ghostty-web draws ONE cursor: a filled block, blinking, in every terminal on the page,
forever. That is fine for the single-terminal embedder it was written for and wrong for a
multiplexer — put four panes on screen and all four blink, so nothing on the canvas says which
one takes the keys. §N20 is the owner reporting exactly that.

Native ghostty draws two cursors and the difference is focus, not style. `src/renderer/cursor.zig`
is the whole rule, in priority order:

```zig
if (!state.cursor.visible) return null;      // DECTCEM still hides it
if (!opts.focused) return .block_hollow;     // ← before blink, before visual_style
if (state.cursor.blinking and !opts.blink_visible) return null;
return .fromTerminal(state.cursor.visual_style);
```

So an unfocused surface shows a hollow block **always** (steady, whatever the blink phase) and
**whatever style the terminal asked for** — a bar or underline cursor becomes an outline too.
`ghostty_surface_set_focus` is what feeds `opts.focused`, and on macOS it is driven by
`window.isKeyWindow && surface == focusedSurface && isFirstResponder`
(`BaseTerminalController.syncFocusToSurfaceTree`), which is why a backgrounded ghostty window has
no blinking cursor in it at all.

`-nex.4` ports that, in `lib/renderer.ts` plus three lines of `lib/terminal.ts`:

- **`CanvasRenderer.setFocused(focused)`** — the port of the C call. Two effects and no others:
  the treatment `renderCursor` picks, and the blink TIMER, which is stopped on focus loss and
  restarted *showing* on focus gain (`src/renderer/Thread.zig:379-424` does precisely this, so a
  pane that has just been clicked never opens on the dark half of someone else's phase).
- **`renderHollowCursor(x, y)`** — ghostty draws the hollow block as a sprite: fill the cell,
  punch out everything inset by `metrics.cursor_thickness`
  (`src/font/sprite/draw/special.zig:300-323`). That thickness is not measured from the font — it
  defaults to 1 and only `adjust-cursor-thickness` moves it (`src/font/Metrics.zig:32-34`) — and
  ghostty's metrics are DEVICE pixels. So this paints a one-device-pixel border under an identity
  transform rather than 1/dpr under the renderer's DPR-scaled one: a fractional cell origin would
  otherwise put the rectangle between device pixels and anti-alias the outline into a grey smear.
  The glyph underneath keeps its ordinary foreground, because ghostty's cursor-text inversion is
  applied to the filled block only (`renderer/generic.zig:2519`, `if (style == .block)`).
- **`cursorStateDirty`** — the cursor cell has to be repainted when the treatment changes and
  nothing else asks for it: no bytes arrived, the cursor did not move, and with `cursorBlink` off
  the per-frame "redraw the cursor line" branch is not taken either. Without it a pane that lost
  focus while idle kept its filled block painted until the next keystroke.
- **`Terminal.setFocused(focused)`** remembers the flag and passes it to the renderer it builds in
  `open()`, so an embedder that reports focus while the engine is still loading — every pane in a
  restored grid but one — does not come up blinking.

`RendererOptions.focused` defaults to `true`, so an embedder that never calls any of this gets
upstream's behaviour byte for byte.

Not addressed here: ghostty's `cursor-style-blink` and `adjust-cursor-thickness` config keys are
not parsed anywhere in this port, so the blink is whatever the embedder passes (`cursorBlink`,
`true` in Nex) and the outline is ghostty's default 1 px.

## Verification of `0.4.0-nex.4` (2026-08-25)

Sandboxed throughout, same discipline as below (`mkdtemp` root, `NEXD_*` overrides, ephemeral
non-reserved ports, private Electron `--user-data-dir`).

- **Device-pixel readback of the cursor cell, live, two panes** — audit step
  `terminal-cursor-focus` (new), [`docs/audit/n20-cursor-focus`](../../docs/audit/n20-cursor-focus/).
  The cursor is parked on a known cell by a CUP escape and held there by `cat`, then the cell is
  sampled five times 300 ms apart (1200 ms — longer than two 530 ms blink periods), counting the
  pixels that are NOT the background colour read from the next cell along. On a 20 × 24 device-px
  cell:
  - **unfocused: `88` lit, which is exactly the perimeter** (2·20 + 2·24 − 4), *identical in all
    five frames* (one distinct frame hash), all four edge probes lit `[255,255,255,255]` and the
    centre on the background `[10,10,12,255]`; the pixel one in from the corner is background, so
    the border is the single device pixel ghostty draws at dpr 2;
  - **focused: `480` of `480`** at its brightest — the whole cell — and `0` in another frame
    (`lit 0 → 480 → 480 → 0 → 0`, two distinct frame hashes): filled, and blinking;
  - both treatments are painted in the SAME colour (focused fill `[255,255,255,255]` = unfocused
    outline), i.e. one theme, two treatments.
- **The window's half, same readback**: a `blur` on the window takes the focused pane to
  `88 → 88 → 88 → 88 → 88`, one distinct frame — hollow and steady — and a `focus` restores
  `480 → 0 → 480 → 480 → 0`. Dispatched rather than acted out, because taking the OS focus away
  from the harness takes it away from the debugger driving it; the listener, the state and the
  paint are the ones a real ⌘Tab reaches, and the step says so under `needs-eyes`.
- **On the PACKAGED app's own client bytes**, which is what the owner runs: `pnpm --filter
  @nex/shell package`, then the same step against
  `Nex.app/Contents/Resources/client` (`NEX_AUDIT_CLIENT_DIR`, added to the harness for this) —
  **21 assertions, 0 failed, 0 step errors, 0 renderer console errors**, the same 88/480 numbers.
  The staged tree is byte-identical to `packages/client/dist` (`diff -rq` clean;
  `ghostty-web-Bfp8I_An.js` sha256 `0fdaaaf1…`). What could NOT be done here: driving the packaged
  BINARY over CDP. `Nex.app`'s DevTools port accepts a TCP connection and then never answers
  `/json` — reproduced standalone with no daemon involved (`curl` times out, `lsof` shows the
  listener), so `audit.mjs --packaged` cannot attach at all. That is older than this change and
  independent of it (this patch touches only the client bundle), and it is worth a ledger row of
  its own.
- **Terminal fidelity, unchanged**: `fresh-boot, terminal-glyphs, terminal-size-matrix,
  terminal-input-matrix, split-keybinding, terminal-ime, terminal-cursor-focus` in one run —
  **98 assertions, 0 failed, 0 step errors**
  ([`docs/audit/n20-cursor-focus-fidelity`](../../docs/audit/n20-cursor-focus-fidelity/)). The IME
  step matters most here: it measures the textarea and preedit against the cursor CELL, and it
  still reports **off by 0×0 px** at both probes.
- `pnpm --filter @nex/shell smoke:terminal` — **19/19**, including the `tall` / `re-attach` /
  `re-boot` phases that were red under the concurrent window work at `-nex.3`.
- Client unit suite via `vitest run packages/client` — **149 files, 2195 tests**, all passing,
  including `vendor-engine.test.ts` (extended with the `-nex.4` markers and the version bump) and
  the new `TerminalPane` / adapter cases.
- Rebuild sanity: `dist/ghostty-web.js` is **696.56 kB** as vite reports it (was 691.93 kB at
  `-nex.3`, +4.63 kB), sha256 `d96985f76e37733c9625ddce3215a9caf02fe185fc86a9512e407dae55d64f34`;
  `ghostty-web.umd.cjs` sha256 `03ab14cb18d425b231deba7d750d4870382d85116f5fef250a39df7c4c77676d`;
  `index.d.ts` sha256 `2d4f75a1c2ca701e873c5139c107817b9ecf5861fa8d665fd28b6d7929f99b2c` (it
  exports `setFocused` on both the Terminal and the renderer);
  `__vite-browser-external-2447137e.js` byte-identical to `-nex.3`
  (`f8c456031e5001c0cda4837cd9ee3a33d79beeba120ec633ec9d990632fb2aa6`); `ghostty-vt.wasm`
  re-copied byte-identical (`sha256 d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a`).
  The bundle still contains `data-ime-preedit` / `data-ime-caret` / `syncImeCaret` /
  `paintDefaultBackground` and no `조합중`, and now also `setFocused`, `renderHollowCursor` and
  `cursorStateDirty`.
- `npx tsc --noEmit` on the snapshot reports only the pre-existing `bun-types` complaint; `vite
  build` prints the four known `Bun` / `fs/promises` errors from `lib/ghostty.ts` and exits 0, as
  documented below.
- What is still NOT verified, and cannot be from here: that a real ⌘Tab away from the app (rather
  than a dispatched `blur`) stops the cursor blinking. Chromium's delivery of the window event is
  the one link a page cannot observe about itself.

### Re-verified independently (the N19/N20 verifier, 2026-08-25)

- **The rebuild recipe above was run as written, in a scratch sandbox, and it reproduces `dist/`
  BYTE-IDENTICALLY.** `cp -R source /tmp/…` → the repo's own `ghostty-vt.wasm` at the root →
  `pnpm install` → `npx vite build` → `cp ghostty-vt.wasm dist/`. All five artifacts match the
  hashes documented above to the byte (`ghostty-web.js` `d96985f7…`, `ghostty-web.umd.cjs`
  `03ab14cb…`, `index.d.ts` `2d4f75a1…`, `__vite-browser-external-2447137e.js` `f8c45603…`,
  `ghostty-vt.wasm` `d6f0326f…`), vite reports **696.56 kB** as documented, and the build prints
  exactly the four `Bun` / `fs/promises` errors and exits 0. The installed
  `packages/client/node_modules/ghostty-web` is `0.4.0-nex.4` with the same `dist` hash.
- **The Zig this section quotes was read, not taken on trust**: `src/renderer/cursor.zig` in the
  Swift checkout returns `.block_hollow` immediately after the `!state.cursor.visible` check and
  before both the blink check and `.fromTerminal(state.cursor.visual_style)`, exactly as
  transcribed.
- **Live, twice more**: [`run-V`](../../docs/audit/run-V/index.md) step 70 — the same 88-of-88
  perimeter unfocused and 480-of-480 focused, one frame hash against two, window blur `88 × 5` and
  window focus `480 → 0 → 480 → 480 → 0` — and, because that step runs after the appearance steps
  drag the client to `background-opacity 0.85`, its background probe reads `[0,0,0,0]`: §N17's
  cleared canvas and §N20's cursor **compose**. Re-measured on the packaged app's own staged
  renderer bytes in [`run-V-packaged-client`](../../docs/audit/run-V-packaged-client/index.md)
  (9 steps / 66 assertions / 0 failed), and the transparency pair re-run in both directions with
  the cursor in place (`run-V-attempts/scoped-transparency-{opaque,transparent}window`, 11
  assertions each, 0 failed).
- Gates around it: `pnpm typecheck` clean, shell suite 578 / 578, and all five live smokes green on
  a freshly packaged bundle (39 / 71 / 46 / **19 terminal fidelity** / 61).

## Verification of `0.4.0-nex.3` (2026-08-25)

Sandboxed throughout (`scripts/ui-audit/lib/stack.mjs`: `mkdtemp` root, `NEXD_*` overrides,
ephemeral non-reserved ports, private Electron `--user-data-dir`), never the dev stack.

- **Canvas readback, live pane, `background-opacity = 0.85`** — `getImageData` on the engine's
  own canvas at four rows down the pane plus three margin pixels: **`(0, 0, 0, 0)` at all
  seven**, on the boot pane *and* on a pane created afterwards by `nex pane split`. Before the
  patch the same seven read `(10, 10, 12, 255)`.
- **On the PACKAGED app too**, which is where the defect was reported: the same readback against
  `packages/shell/out/Nex-darwin-arm64/Nex.app`'s own binary and its own staged client — window
  logged `transparent (background-opacity 0.85)`, `data-terminal-transparent="true"`, all seven
  points `(0, 0, 0, 0)` on both panes, glyph alpha 255, and the app root / `<body>` / grid all
  `rgba(0, 0, 0, 0)` with the pane's `rgba(10, 10, 12, 0.85)` the only painted layer.
- **Glyphs stayed opaque** in the same frame: the prompt row scanned 900 × 24 device px, **max
  alpha 255**, 934 lit pixels (i.e. the text and only the text).
- **The opaque default is unchanged**: with no `background-opacity` line the window logs
  `opaque (background-opacity 1.00)`, the pane reports `data-terminal-transparent="false"`, and
  the same seven pixels read `(10, 10, 12, 255)` with the prompt-row scan fully lit
  (21600/21600) — the fill path, untouched.
- `pnpm --filter @nex/shell smoke:terminal` — **14/19**, and the five that fail are *not* this
  patch's. They are the `tall`, `re-attach` and `re-boot` phases, every one of them a claim
  about the WINDOW's restored bounds and the daemon's geometry cache (`prompt widths [122,122]`
  against `COLUMNS=84` — the wide session's grid surviving into the tall one). The `wide` and
  `narrow` phases, which exercise exactly the chain this patch touches — the Nerd font, the
  canvas fitting the pane, `$COLUMNS`, a `$COLUMNS`-wide ruler and a p10k-shaped prompt filling
  it exactly — are **green**. The smoke rebuilds the shell bundle before it runs, and
  `packages/shell/src/main.ts` is being rewritten concurrently in this working tree by the N14 /
  N15 / N16 lanes (`showWindow`, `presentWindow`, a new `ready-to-show` focus handoff); nothing
  in this change can move a window or a column count. Re-run once those land to attribute it
  properly.
- Client unit suite via `vitest run packages/client` — **148 files, 2170 tests**, all passing,
  including this directory's `vendor-engine.test.ts` (extended with the `-nex.3` markers).
- Rebuild sanity: `dist/ghostty-web.js` is **691.93 kB** (was 689.55 kB at `-nex.2`'s recipe
  numbers), still contains `data-ime-preedit` / `data-ime-caret` / `syncImeCaret` and no
  `조합중`, and now also `paintDefaultBackground`. `ghostty-vt.wasm` re-copied byte-identical
  (`sha256 d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a`).
- What is still NOT verified here, and cannot be: that the desktop is actually visible through
  the pane. A CDP screenshot composites the PAGE, not the screen behind the window. Every layer
  between the two is asserted (window flag, computed styles, canvas alpha); the last inch is a
  human looking at a real screen.

## Verification at integration time (2026-08-21)

- Root `pnpm check` green; terminal-fidelity smoke 19/19; audit steps fresh-boot,
  terminal-glyphs, terminal-size-matrix, terminal-input-matrix, split-keybinding: 55
  assertions, 0 failed (byte-identical ctrl+key codes, DECCKM arrows, SGR mouse reports).
- IME end to end: real `CompositionEvent`s on the engine textarea in a live pane delivered
  한글 to the PTY exactly once (one 6-byte UTF-8 input frame observed on the wire; rendered
  glyphs verified by screenshot under `cat`).

## Verification of `0.4.0-nex.2` (2026-08-21)

- `pnpm --filter @nex/shell smoke:terminal` — **19/19**, unchanged (the caret sync runs on every
  frame in every one of those panes; the geometry, ruler and re-attach checks are the regression
  net for it).
- `pnpm --filter @nex/client` unit suite via `vitest run packages/client` — 95 files, **1355
  tests**, all passing.
- Audit `--only fresh-boot,terminal-input-matrix,terminal-ime --no-build` → `docs/audit/terminal-ime-caret/`
  — **54 assertions, 0 failed, 0 step errors**, of which `terminal-ime` is 29: the 21 that
  guarded `-nex.1` plus 8 new positional ones. The numbers that matter, all from that run's
  `index.md`:
  - textarea at rest, cursor parked by `printf '\033[3;10H'`: measured `{x:294,y:86,w:8,h:15}`
    against a computed cell origin of `{x:294,y:86}` — **off by 0×0 px**, and a whole cell in
    size rather than the old 1×1;
  - preedit while composing at the same cell: **off by 0×0 px**, `2px solid` underline, one cell
    tall, carrying 한 and nothing else;
  - a second cell (`CUP(7,24)`): both elements again **0×0 px** off, and 14 cells right / 4 rows
    down from the first probe, so the anchor moved with the cursor rather than sitting at a
    fixed offset from the container;
  - after `compositionend`: preedit `display:none` with its text removed, and the textarea at
    `454` where it composed at `406` — **6 cells**, exactly the width the committed 테스트 takes
    on screen.
- Screenshots read, not just captured: `03-terminal-ime-preedit-at-caret.png`,
  `03-terminal-ime-preedit-tracked.png`, `03-terminal-ime-composing.png` (한 underlined at the
  caret under `sh-3.2$ cat`), `03-terminal-ime-composed.png` (`한글 Q`, no preedit left behind).
- What is still NOT verified, here or anywhere in CI: that macOS then opens the candidate window
  at that box. The rect is what the browser reports; the drawing is the input method's, in a
  surface CDP cannot see. TERM-033 stays partial for that reason.

## `source/` — the patched TypeScript, and how to rebuild from it

`dist/` is the artifact the app loads, and the root `.gitignore` ignores every `dist/` in the
tree — so the built engine is **not** in git and a fresh clone has to rebuild it. `source/` is
what makes that possible: it is the exact patched tree the shipping `dist/` was built from
(`lib/` including `lib/addons` and `lib/providers` and the upstream unit tests, plus
`package.json`, `vite.config.js`, `tsconfig.json`, `biome.json`, `.prettierrc`). No
`node_modules`, no `.git`, no `dist` — those are reproduced, not carried.

One thing that looks wrong and is not: `source/package.json` says `"version": "0.3.0"`, because
that is what upstream's own `v0.4.0` tag says. The `-nex` version lives in this directory's
`package.json` (the one the workspace override installs), not in the snapshot.

Rebuilding, exactly as this vendor dir was built (bun is not required, and is not available in
the environment this was produced in):

```sh
cp -R vendor/ghostty-web-patched/source /tmp/gweb            # or any scratch dir
cd /tmp/gweb
cp <upstream v0.4.0>/ghostty-vt.wasm .                       # must sit at the ROOT: the build
                                                             # inlines it as a data: URI
pnpm install                                                 # vite + vite-plugin-dts only
npx vite build                                               # NOT `npm run build` (that shells
                                                             # out to bun and re-builds the wasm)
cp ghostty-vt.wasm dist/                                     # what `build:wasm-copy` does
cp -R dist/* <repo>/vendor/ghostty-web-patched/dist/
cd <repo> && pnpm install && pnpm --filter @nex/client build
```

The wasm is the one thing `source/` does not carry (413 KB of binary, byte-identical to npm
`ghostty-web@0.4.0`); `vendor/ghostty-web-patched/ghostty-vt.wasm` **is** in git, so the copy
above can come from there:
`sha256 d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a`.

Sanity checks on a rebuild: `dist/ghostty-web.js` is ~680 KiB (696.56 kB as vite reports it,
+4.63 kB over `-nex.3`), and it contains `data-ime-preedit`, `data-ime-caret`, `syncImeCaret`,
`paintDefaultBackground` (`-nex.3`), `setFocused` / `renderHollowCursor` / `cursorStateDirty`
(`-nex.4`) and no `조합중` (the chip label `-nex.2` removed). Those
markers are asserted in CI by `packages/client/src/terminal/vendor-engine.test.ts`, which also
pins the version this file documents — bump both together or the guard fails. `npx tsc
--noEmit` on the snapshot reports only the four pre-existing `Bun` / `fs/promises` errors in
`lib/ghostty.ts` (the tsconfig asks for `bun-types`, which the npm install does not provide);
nothing in `terminal.ts`, `renderer.ts` or `input-handler.ts`.

`vite build` prints those same four errors and still exits 0 — that is expected, not a broken
build; the `dist/` line count at the end is the signal to read.

## Refreshing

When upstream ships 0.5.0 (release PR #182 pending): check whether #120/#159 merged, drop this
vendor dir and the root `pnpm.overrides['ghostty-web']`, take the npm release, and re-run the
terminal smoke + audit input matrix + the IME audit step before trusting it.

Note that **none** of the three Nex adaptations is an upstream PR. Taking a future npm release
wholesale would:

- put the preedit back in the container's corner and reopen TERM-032 / TERM-033 — so re-apply
  the `syncImeCaret` / `setPreedit` / `updatePreedit` trio and the textarea styling in `open()`,
  or carry them as this vendor dir does;
- make `allowTransparency` inert again, which turns every `background-opacity < 1` terminal
  solid and reopens **N17** — so re-apply `paintDefaultBackground`, `isDefaultCellBackground`
  and the option's journey from `this.options` into the `CanvasRenderer`; and
- take `setFocused` away, at which point every pane on screen blinks a filled block again and
  **N20** is back — so re-apply `setFocused` on both the Terminal and the renderer,
  `renderHollowCursor`, the `cursorStateDirty` repaint and the `!this.focused` clause in the
  render loop's cursor-visibility test. The client half (`TerminalRenderer.setSurfaceFocus`,
  `EngineHandle.setSurfaceFocus`, the pane's `focused && visible && windowFocused`) lives in this
  repo and survives; it would simply be talking to an engine that ignores it.

The last two are the easy ones to lose. Nothing about transparency is visible on an opaque
config, which is what almost every developer runs; and a lone terminal blinking a filled block is
CORRECT, so the cursor regression only shows up with two panes open and only if someone looks.
`vendor-engine.test.ts` fails on the missing markers of all three, the `window-transparency` step
asserts the live canvas's alpha, and `terminal-cursor-focus` counts the lit pixels in a cursor
cell in both panes — those are the net.

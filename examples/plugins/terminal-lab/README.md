# Terminal Lab

An SDK-only replacement for existing shell panes and native documents running an external
editor. The example has no backend or private Kelpi imports. It renders the existing process
with the repository's pinned xterm 6 dependency.

From the checkout root, run:

```sh
pnpm install --frozen-lockfile
node scripts/build-terminal-lab.mjs
node scripts/dev-instance.mjs --state out/plugin-terminals-playground
```

In that private instance, install this directory's absolute path through Settings → Plugins, then choose
**Terminal Lab** in a terminal's renderer picker. The matching Settings placement is
`terminal`. Your regular Kelpi installation and its processes remain separate. With the private
`kelpi_test` helper from the [development guide](../../../docs/plugin-development.md), run
`kelpi_test plugin dev examples/plugins/terminal-lab --trust` from the checkout root while
editing, and rerun `node scripts/build-terminal-lab.mjs` whenever source changes. Dev does
not build the example for you. Build before validation, packing or installation; plugin reload
only restarts the installed copy. Settings → Plugins → Versions switches compatible retained
renderers while keeping the native process alive.

The example consumes acknowledged replay/output frames, resets its parser and screen for each
authoritative replay, preserves a scroll position separately from the native pane, and handles
host selection, paste, focus, search and phone keyboard actions. Hidden views remain attached
without resizing the process. Showing the phone keyboard requires the explicit keyboard action.

`ui/helpers.js` contains the input, geometry and replay rules. `ui/renderer.js` implements the
public Kelpi terminal contract, and `ui/xterm-adapter.js` restores authoritative input modes.
The generated `bundle.js`, `bundle.css` and xterm license are
ignored by Git and built entirely from installed dependencies, with no downloads.

This example uses pinned xterm adapter details: `_core._renderService.dimensions.css.cell`
for measured cell sizes, and `_core.coreService.onUserInput` to recognize asynchronous IME
commits. It restores application cursor keys, bracketed paste and mouse modes through
`_core.coreService.decPrivateModes` and `_core.coreMouseService` after a replay and on mode
updates. Applying modes outside the parser preserves unfinished output escape sequences.
DOM capture on the terminal root applies one-shot phone modifiers before xterm's textarea
handlers. Phone characters without a physical key code use US key positions and inferred Shift;
text that the adapter cannot modify keeps the emulator's ordinary input path.
A scoped `_core.coreMouseService.triggerMouseEvent` wrapper identifies mouse output
at the synchronous emulator call, including when native browser dispatch runs microtasks
between DOM listeners. It restores ordinary routing as soon as that call returns. Parser
responses and mouse reports use `writeDirect`, while keyboard/paste text uses `write`.
Input is never classified by
matching escape-sequence strings. Fitting reserves a 14-pixel scrollbar gutter. These xterm
details must be reviewed when upgrading the dependency.

The emulator supports its own DEC keyboard/mouse modes, bracketed paste, composition and
selection. It supports legacy, SGR and SGR-pixel mouse encodings. UTF-8 and urxvt mouse
encodings are unavailable in xterm 6, so the adapter disables mouse reporting while either is
negotiated. It retains all streamed mode metadata but does not implement Kelpi's custom Kitty
keyboard encoder or Ghostty-specific rendering features. Advanced terminal behavior remains a
renderer choice; the bundled renderer is available in the same picker.

For validation, `globalThis.terminalLab` exposes the real emulator and session, presentation,
modes, modifiers, and replay/reveal counters. `document.body.dataset.ready` becomes `true` only
after an authoritative replay has been consumed. This diagnostic object does not substitute
rendered text or create a second terminal process.

Run `node scripts/scenario.mjs plugin-terminal-features --window hidden` for the native process
scenario, or `--window onscreen` for screenshots. See the
[terminal contract](../../../docs/plugin-terminals.md),
[dated validation record](../../../docs/plugin-validation.md), and
[plugin roadmap](../../../docs/plugin-roadmap.md) for supported behavior and remaining work.

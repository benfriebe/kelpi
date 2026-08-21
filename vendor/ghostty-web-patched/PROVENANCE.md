# ghostty-web 0.4.0-nex.1 (vendored)

A build of `ghostty-web` v0.4.0 carrying two open upstream PRs, applied after a line-by-line
review in the orchestrating session and explicit user authorization to integrate both.

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

## Verification at integration time (2026-08-21)

- Root `pnpm check` green; terminal-fidelity smoke 19/19; audit steps fresh-boot,
  terminal-glyphs, terminal-size-matrix, terminal-input-matrix, split-keybinding: 55
  assertions, 0 failed (byte-identical ctrl+key codes, DECCKM arrows, SGR mouse reports).
- IME end to end: real `CompositionEvent`s on the engine textarea in a live pane delivered
  한글 to the PTY exactly once (one 6-byte UTF-8 input frame observed on the wire; rendered
  glyphs verified by screenshot under `cat`).

## Refreshing

When upstream ships 0.5.0 (release PR #182 pending): check whether #120/#159 merged, drop this
vendor dir and the root `pnpm.overrides['ghostty-web']`, take the npm release, and re-run the
terminal smoke + audit input matrix + the IME audit step before trusting it.

/**
 * Terminal rendering (WP3.2).
 *
 *   `renderer.ts`     — `TerminalRenderer`, the engine seam: ghostty-web (default) or
 *                       `@xterm/xterm` (`VITE_TERMINAL_ENGINE=xterm`), both behind the same
 *                       xterm-compatible subset
 *   `fonts.ts`        — the bundled Nerd Font, its load gate and the engines' own cell
 *                       measuring rule (glyph coverage + correct cols depend on both)
 *   `ingest.ts`       — replay-then-live byte ordering for one pane
 *   `TerminalPane.tsx`— the React component: engine + PTY stream + resize/focus/visibility
 *   `mount-policy.ts` — which panes may hold a live renderer (cap + LRU eviction)
 *
 * Hands-on engine gaps: `docs/research/ghostty-web-spike.md`.
 *
 * Note for assembly: the `xterm` fallback engine needs `@xterm/xterm/css/xterm.css` loaded by
 * the host page; ghostty-web needs no stylesheet.
 */

export {
    DEFAULT_RESIZE_DEBOUNCE_MS,
    TerminalPane,
    measureGeometry,
    shouldGrabFocus,
    type TerminalGeometry,
    type TerminalPaneProps,
    type TerminalPtyApi
} from './TerminalPane';

export { PENDING_LIVE_LIMIT_BYTES, createTerminalIngest, type IngestTarget, type TerminalIngest } from './ingest';

export {
    BUNDLED_TERMINAL_FONT_FAMILY,
    BUNDLED_TERMINAL_FONT_WEIGHTS,
    TERMINAL_FONT_FALLBACKS,
    TERMINAL_FONT_WAIT_MS,
    loadTerminalFonts,
    measureCellSize,
    onTerminalFontsReady,
    resetTerminalFontsForTests,
    terminalFontStack,
    terminalFontsReady,
    type MeasuredCell
} from './fonts';

export {
    DEFAULT_MOUNT_LIMIT,
    EMPTY_MOUNT_STATE,
    createMountPolicy,
    planMounts,
    visiblePaneIDs,
    type MountDecision,
    type MountPolicy,
    type MountPolicyState,
    type MountRequest,
    type VisiblePanesInput
} from './mount-policy';

export {
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    DEFAULT_SCROLLBACK_BYTES,
    DEFAULT_SCROLLBACK_LINES,
    DEFAULT_TERMINAL_ENGINE,
    DEFAULT_TERMINAL_THEME,
    PENDING_WRITE_LIMIT_BYTES,
    TERMINAL_ENGINES,
    TERMINAL_RESET_SEQUENCE,
    TERMINAL_TOKEN_NAMES,
    compactTheme,
    configuredTerminalEngine,
    createRendererFromLoader,
    createTerminalRenderer,
    engineLoader,
    estimateCellSize,
    isEngineColor,
    loadGhosttyEngine,
    loadXtermEngine,
    resolveTerminalEngine,
    resolveTerminalTheme,
    type CellSize,
    type EngineDisposable,
    type EngineHandle,
    type EngineLoader,
    type ResolvedRendererOptions,
    type TerminalEngine,
    type TerminalRenderer,
    type TerminalRendererFactory,
    type TerminalRendererOptions,
    type TerminalTheme,
    type XtermLikeTerminal
} from './renderer';

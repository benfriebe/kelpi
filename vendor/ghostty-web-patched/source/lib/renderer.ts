/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, ILink } from './types';
import { CellFlags } from './types';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
  /**
   * Let whatever is BEHIND the canvas show through the default background. Default: false.
   *
   * `ITerminalOptions.allowTransparency` has existed since v0.4.0 and reached `this.options`,
   * but nothing ever read it: every paint of the DEFAULT background was an opaque
   * `fillRect(theme.background)`, so an embedder that painted a translucent fill behind the
   * canvas — the whole point of the option — got a solid terminal anyway.
   *
   * With it on, those paints become `clearRect`: the canvas is already
   * `getContext('2d', { alpha: true })`, so a cleared cell composites straight through to the
   * element behind it, while text and any cell carrying an EXPLICIT background colour stay
   * fully opaque. That is what ghostty's own `background-opacity` does natively — the opacity
   * applies to the default background only, never to the glyphs.
   *
   * Off (the default) every code path below is byte-for-byte what it always was.
   */
  allowTransparency?: boolean;
  /**
   * Does the surface holding this terminal have KEYBOARD FOCUS? Default: true.
   *
   * Native ghostty draws two different cursors and the difference is focus, not style: the
   * focused surface gets the cursor the terminal asked for (blinking if it asked for that),
   * and an unfocused one gets a STEADY HOLLOW BLOCK — `src/renderer/cursor.zig:59-60`,
   * "If we're not focused, our cursor is always visible so that we can show the hollow box",
   * which returns `.block_hollow` BEFORE the blink check and regardless of the requested
   * bar/underline style. `ghostty_surface_set_focus` is what drives it.
   *
   * Upstream ghostty-web has no such concept: every terminal on the page blinks a filled block
   * forever, so a grid of panes reads as if all of them had the caret. The default here is
   * `true` so a single-terminal embedder that never calls `setFocused` sees exactly the
   * behaviour it always saw.
   */
  focused?: boolean;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

/**
 * Border thickness, in DEVICE pixels, of the unfocused (hollow) cursor.
 *
 * ghostty's `font.Metrics.cursor_thickness` — the value `cursor_hollow_rect` insets by — is not
 * measured from the font. It defaults to 1 and only the `adjust-cursor-thickness` config moves
 * it (`src/font/Metrics.zig:32-34`, `src/font/SharedGridSet.zig:670`), and ghostty's metrics are
 * device pixels. That config key is not plumbed through this port, so this is the constant
 * ghostty ships with.
 */
const CURSOR_OUTLINE_DEVICE_PX = 1;

// ============================================================================
// Default Theme
// ============================================================================

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  /** See `RendererOptions.allowTransparency`. */
  private allowTransparency: boolean;
  /** `theme.background` as components, kept in step with it. See `isDefaultCellBackground`. */
  private defaultBackgroundRGB: { r: number; g: number; b: number } | null;
  /**
   * The default colours the WASM TERMINAL was CONSTRUCTED with (vendor 0.4.0-nex.7 — Nex §N18).
   *
   * Not the theme's: `ghostty_terminal_new_with_config` takes `bg_color`/`fg_color` once and
   * there is no export that moves them, so every cell the VT has not explicitly coloured reports
   * those components for the life of the terminal — *including* after `setTheme`. Painting them
   * literally is what leaves a live theme change stranded on the old palette; see
   * `liveThemeColor`. `null` for an embedder that configured neither, which is upstream's own
   * case and is left exactly as it was.
   */
  private terminalDefaultBackgroundRGB: { r: number; g: number; b: number } | null = null;
  /** The construction `fg_color`, the foreground half of the pair above. */
  private terminalDefaultForegroundRGB: { r: number; g: number; b: number } | null = null;
  private devicePixelRatio: number;
  private metrics: FontMetrics;
  private palette: string[];

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };
  /** See `RendererOptions.focused`. */
  private focused: boolean;
  /**
   * The cursor's TREATMENT changed (focus flipped) without the cursor moving.
   *
   * Filled-block ↔ hollow-outline is a repaint of the cursor cell that nothing else asks for:
   * the row is not dirty (no bytes arrived), the cursor did not move, and with `cursorBlink`
   * off the per-frame "redraw the cursor line" branch is not taken either. Without this flag a
   * pane that lost focus while idle keeps its filled block painted until the next keystroke.
   */
  private cursorStateDirty: boolean = false;
  /**
   * Paint is SUSPENDED — the canvas is a frozen frame, not a live surface (vendor
   * 0.4.0-nex.6). See `setPaintSuspended`.
   */
  private paintSuspended: boolean = false;
  /**
   * The previous frame drew the scrollbar (vendor 0.4.0-nex.8).
   *
   * `renderScrollbar` clears a strip at the canvas's right edge to the default background on
   * every frame it runs — its backdrop against ghosting — and that strip overlaps the last
   * one-to-two COLUMNS of text. While the scrollbar is visible that is the intended paint
   * order (backdrop, then thumb, over the cells). The defect was the frame the scrollbar
   * stopped: `render()` skips `renderScrollbar` entirely at `scrollbarOpacity <= 0`, no row is
   * dirty (the fade runs after the wheel has settled), so NOTHING repaints the strip — the
   * rightmost cells stay erased until the application happens to rewrite those rows. Every
   * scroll gesture left the terminal's right edge visually cut off.
   *
   * Tracking the transition lets `render()` force one full-frame walk on the first frame
   * without a scrollbar, which repaints the strip's cells and costs one forced render per
   * fade-out.
   */
  private scrollbarWasPainted: boolean = false;

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.allowTransparency = options.allowTransparency ?? false;
    this.focused = options.focused ?? true;
    this.defaultBackgroundRGB = CanvasRenderer.parseRGB(this.theme.background);
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;

    // Build color palette (16 ANSI colors)
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled. An unfocused terminal never blinks (ghostty stops the
    // blink timer on focus loss — `src/renderer/Thread.zig:398-404`), so there is nothing to
    // start until it takes focus.
    if (this.cursorBlink && this.focused) {
      this.startCursorBlink();
    }
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');
    const width = Math.ceil(widthMetrics.width);

    // Measure height using ascent + descent with padding for glyph overflow
    const ascent = widthMetrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = widthMetrics.actualBoundingBoxDescent || this.fontSize * 0.2;

    // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
    // and anti-aliasing pixels
    const height = Math.ceil(ascent + descent) + 2;
    const baseline = Math.ceil(ascent) + 1; // Offset baseline by half the padding

    return { width, height, baseline };
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  /**
   * `#RGB` / `#RRGGBB` / `rgb(r, g, b)` → components, or null for anything else.
   *
   * Only `allowTransparency` needs this, and only to answer one question: is this cell's
   * background the DEFAULT one? See `isDefaultCellBackground`.
   */
  private static parseRGB(color: string): { r: number; g: number; b: number } | null {
    const trimmed = color.trim();
    if (trimmed.startsWith('#')) {
      let hex = trimmed.slice(1);
      if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }
      if (hex.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
      const value = Number.parseInt(hex, 16);
      return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
    }
    const match = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (match === null) return null;
    return {
      r: Number.parseInt(match[1], 10),
      g: Number.parseInt(match[2], 10),
      b: Number.parseInt(match[3], 10),
    };
  }

  /** `0xRRGGBB` → components, the form `ghostty_terminal_new_with_config` takes (nex.7). */
  private static rgbFromInt(color: number | null): { r: number; g: number; b: number } | null {
    if (color === null || !Number.isFinite(color)) return null;
    const value = color >>> 0;
    return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
  }

  /**
   * Lay down the DEFAULT background over a rectangle — the one paint `allowTransparency` owns.
   *
   * Every site that used to write `fillStyle = this.theme.background; fillRect(…)` goes through
   * here instead, so the opaque and the see-through cases cannot drift apart. With the option
   * off this is literally those two statements. With it on the rectangle is CLEARED, which on
   * an `alpha: true` canvas (this one always has been) leaves the element behind it — the
   * embedder's translucent pane fill — to show through.
   *
   * Clearing rather than filling with an `rgba()` is deliberate: these rectangles are repainted
   * per frame and per line, and a translucent fill would COMPOUND, so a cell would darken
   * towards opaque the longer it sat on screen. A clear is idempotent.
   */
  private paintDefaultBackground(x: number, y: number, width: number, height: number): void {
    if (this.allowTransparency) {
      this.ctx.clearRect(x, y, width, height);
      return;
    }
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(x, y, width, height);
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Suspend or resume PAINTING (vendor 0.4.0-nex.6 — Nex §N24).
   *
   * While suspended `render()` returns without touching the canvas and `resize()` carries the
   * pixels across instead of clearing to the background, so the canvas holds the LAST GOOD
   * FRAME for as long as the embedder asks it to.
   *
   * Why an engine needs this at all: a widening `ghostty_terminal_resize` under heap churn can
   * leave cells in the terminal's own storage that were never written by the VT — they read back
   * as runs of monotonically increasing codepoints at a constant stride, i.e. non-text memory
   * seen as text — and every frame from then until something rewrites the screen paints them.
   * The state is inside libghostty-vt (the wasm is a prebuilt binary here), so it cannot be
   * fixed at the source; what CAN be guaranteed is that no frame is ever produced from it. Nex's
   * embedder resizes, suspends, and resumes when the authoritative server-side replay has been
   * written back in — see `TerminalRenderer.resize` in the app.
   *
   * Upstream behaviour is untouched for any embedder that never calls this: the flag starts
   * `false` and nothing else sets it.
   */
  public setPaintSuspended(suspended: boolean): void {
    this.paintSuspended = suspended;
  }

  /** Is paint currently suspended? (`setPaintSuspended`) */
  public isPaintSuspended(): boolean {
    return this.paintSuspended;
  }

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    /**
     * vendor 0.4.0-nex.6: while paint is suspended the canvas is the frozen last good frame,
     * and setting `canvas.width`/`height` below wipes it. Take a copy first and lay it back
     * down afterwards, so a suspended resize shows the previous content at its previous size
     * (any newly exposed area is background) rather than a blank pane.
     */
    let frozen: HTMLCanvasElement | null = null;
    if (this.paintSuspended && this.canvas.width > 0 && this.canvas.height > 0) {
      const copy = document.createElement('canvas');
      copy.width = this.canvas.width;
      copy.height = this.canvas.height;
      const copyCtx = copy.getContext('2d');
      if (copyCtx) {
        copyCtx.drawImage(this.canvas, 0, 0);
        frozen = copy;
      }
    }

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = cssWidth * this.devicePixelRatio;
    this.canvas.height = cssHeight * this.devicePixelRatio;

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.paintDefaultBackground(0, 0, cssWidth, cssHeight);

    // …and, when suspended, put the frozen frame back on top of it (nex.6). The context is
    // scaled by the DPR, so the device-pixel copy is drawn at its CSS size.
    if (frozen !== null) {
      this.ctx.drawImage(
        frozen,
        0,
        0,
        frozen.width / this.devicePixelRatio,
        frozen.height / this.devicePixelRatio
      );
    }
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    // vendor 0.4.0-nex.6 (§N24): paint is suspended — produce NO frame at all. Deliberately the
    // first statement in the method, before the buffer is read, so a suspended terminal never
    // converts a single cell into a pixel. Dirty flags are left alone (`clearDirty()` below is
    // skipped with everything else), so the forced render on resume redraws from a clean slate.
    if (this.paintSuspended) return;

    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    // vendor 0.4.0-nex.8: the scrollbar's backdrop clears the rightmost strip of the canvas on
    // every frame it is drawn (see `scrollbarWasPainted`). The first frame WITHOUT a scrollbar
    // must repaint the cells that strip erased, and no dirty flag says so — the fade-out ends
    // with the buffer idle — so the transition itself forces the full walk.
    const scrollbarPainted = !!scrollbackProvider && scrollbarOpacity > 0;
    if (this.scrollbarWasPainted && !scrollbarPainted) {
      forceAll = true;
    }
    this.scrollbarWasPainted = scrollbarPainted;

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvas.width !== dims.cols * this.metrics.width * this.devicePixelRatio ||
      this.canvas.height !== dims.rows * this.metrics.height * this.devicePixelRatio;

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // Check if cursor position changed, if blinking, or if the cursor's TREATMENT changed
    // under it (focus flipped — see `cursorStateDirty`): all three need the cursor line
    // redrawn so the previous frame's cursor is erased before this one's is painted.
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    if (cursorMoved || this.cursorBlink || this.cursorStateDirty) {
      // Mark cursor lines as needing redraw
      if (!forceAll && !buffer.isRowDirty(cursor.y)) {
        // Need to redraw cursor line
        const line = buffer.getLine(cursor.y);
        if (line) {
          this.renderLine(line, cursor.y, dims.cols);
        }
      }
      if (cursorMoved && this.lastCursorPosition.y !== cursor.y) {
        // Also redraw old cursor line if cursor moved to different line
        if (!forceAll && !buffer.isRowDirty(this.lastCursorPosition.y)) {
          const line = buffer.getLine(this.lastCursorPosition.y);
          if (line) {
            this.renderLine(line, this.lastCursorPosition.y, dims.cols);
          }
        }
      }
    }

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      // Must check the correct buffer based on viewportY (scrollback vs screen)
      for (let y = 0; y < dims.rows; y++) {
        let line: GhosttyCell[] | null = null;

        // Same logic as rendering: fetch from scrollback or screen
        if (viewportY > 0) {
          if (y < viewportY && scrollbackProvider) {
            // This row is from scrollback
            // Floor viewportY for array access (handles fractional values during smooth scroll)
            const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
            line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
          } else {
            // This row is from visible screen
            const screenRow = y - Math.floor(viewportY);
            line = buffer.getLine(screenRow);
          }
        } else {
          // At bottom - fetch from visible screen
          line = buffer.getLine(y);
        }

        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Track if anything was actually rendered
    let anyLinesRendered = false;

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      // When scrolled, always force render all lines since we're showing scrollback
      const needsRender =
        viewportY > 0
          ? true
          : forceAll || buffer.isRowDirty(y) || selectionRows.has(y) || hyperlinkRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      anyLinesRendered = true;

      // Fetch line from scrollback or visible screen
      let line: GhosttyCell[] | null = null;
      if (viewportY > 0) {
        // Scrolled up - need to fetch from scrollback + visible screen
        // When scrolled up N lines, we want to show:
        // - Scrollback lines (from the end) + visible screen lines

        // Check if this row should come from scrollback or visible screen
        if (y < viewportY && scrollbackProvider) {
          // This row is from scrollback (upper part of viewport)
          // Get from end of scrollback buffer
          // Floor viewportY for array access (handles fractional values during smooth scroll)
          const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
          line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
        } else {
          // This row is from visible screen (lower part of viewport)
          const screenRow = viewportY > 0 ? y - Math.floor(viewportY) : y;
          line = buffer.getLine(screenRow);
        }
      } else {
        // At bottom - fetch from visible screen
        line = buffer.getLine(y);
      }

      if (line) {
        this.renderLine(line, y, dims.cols);
      }
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Render cursor (only if we're at the bottom, not scrolled).
    //
    // The blink PHASE only gates a focused cursor. Unfocused, ghostty shows the hollow box
    // "always" (`src/renderer/cursor.zig:58-60`) — the terminal's own visibility (DECTCEM,
    // `cursor.visible`) still hides it, exactly as the `!state.cursor.visible` check that runs
    // one line earlier over there does.
    if (viewportY === 0 && cursor.visible && (this.cursorVisible || !this.focused)) {
      this.renderCursor(cursor.x, cursor.y);
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect).
    // vendor 0.4.0-nex.8: the same condition `scrollbarPainted` was computed from above — the
    // two must not drift, or the strip-restoring forceAll fires on the wrong frame.
    if (scrollbackProvider && scrollbarOpacity > 0) {
      this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }

    // Update last cursor position
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };
    // The focus flip has been painted.
    this.cursorStateDirty = false;

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(line: GhosttyCell[], y: number, cols: number): void {
    const lineY = y * this.metrics.height;

    // Clear line background with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    this.paintDefaultBackground(0, lineY, cols * this.metrics.width, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y);
    }
  }

  /**
   * Does this cell carry the DEFAULT background — the one the theme paints per line?
   *
   * Upstream's rule is `(0, 0, 0)`, on the assumption that a cell with no explicit SGR
   * background comes back as zeroes. That holds only when the WASM terminal was configured
   * without a `bgColor`: hand it one (Nex does — the ghostty `background` key), and every
   * untouched cell reports that colour instead, so the two-pass renderer fills each of them
   * opaquely and the theme fill underneath is never seen. Invisible while both are the same
   * opaque colour; fatal the moment the fill is meant to be see-through.
   *
   * So under `allowTransparency` a cell whose background IS the theme background counts as
   * default too, and is left alone for `paintDefaultBackground`'s clear to show through.
   *
   * The honest edge: an application that sets a cell's background EXPLICITLY to the exact
   * theme background (`SGR 48;2;…`) becomes translucent there rather than opaque. Nothing on
   * screen can tell the two apart except the desktop behind the window, and the alternative —
   * every cell opaque — is the defect this exists to remove.
   *
   * vendor 0.4.0-nex.7 adds the third clause, and it is the one that survives a THEME CHANGE:
   * the components above are the theme's, which `setTheme` moves, while the cell's are the
   * TERMINAL's, which nothing moves — so after a live `theme =` the two no longer meet and
   * every untouched cell was being painted in the old background again (opaquely, over the
   * cleared line, which is §N18). `isTerminalDefaultBackground` asks the question the cell can
   * actually answer, at every opacity.
   */
  private isDefaultCellBackground(r: number, g: number, b: number): boolean {
    if (r === 0 && g === 0 && b === 0) return true;
    if (this.isTerminalDefaultBackground(r, g, b)) return true;
    if (!this.allowTransparency) return false;
    const base = this.defaultBackgroundRGB;
    return base !== null && r === base.r && g === base.g && b === base.b;
  }

  /**
   * Is this the background the WASM terminal was CONSTRUCTED with (vendor 0.4.0-nex.7)?
   *
   * `false` for every embedder that never called `setTerminalDefaultColors` — which is what
   * keeps upstream's behaviour exactly upstream's.
   */
  private isTerminalDefaultBackground(r: number, g: number, b: number): boolean {
    const base = this.terminalDefaultBackgroundRGB;
    return base !== null && r === base.r && g === base.g && b === base.b;
  }

  /** The foreground half of `isTerminalDefaultBackground` (vendor 0.4.0-nex.7). */
  private isTerminalDefaultForeground(r: number, g: number, b: number): boolean {
    const base = this.terminalDefaultForegroundRGB;
    return base !== null && r === base.r && g === base.g && b === base.b;
  }

  /**
   * The LIVE theme's colour for a cell colour that is one of the terminal's construction
   * defaults, or `null` when the cell carries a colour of its own (vendor 0.4.0-nex.7).
   *
   * This is the paint-time palette lookup the two default slots need. A cell's `fg_r/g/b` and
   * `bg_r/g/b` are resolved RGB, frozen at whatever the terminal was configured with, so a
   * renderer that paints them literally can never follow a theme change; asking "is this one of
   * the two defaults, and if so what is the theme's answer NOW" makes the default slots live
   * without inventing state.
   *
   * Deliberately limited to those two slots. The 16 palette entries are frozen in the same way,
   * but a cell that reports an ANSI colour is indistinguishable from a true-colour cell that
   * happens to match it, and remapping those would move colours an application asked for by
   * value. Before a theme change the mapping is the identity in pixels (the terminal's defaults
   * ARE the theme's), so the whole of its effect lives in the window §N18 is about.
   */
  private liveThemeColor(r: number, g: number, b: number): string | null {
    if (this.isTerminalDefaultBackground(r, g, b)) return this.theme.background;
    if (this.isTerminalDefaultForeground(r, g, b)) return this.theme.foreground;
    return null;
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // Only draw cell background if it's different from the default (black)
    // This lets the theme background (drawn earlier) show through for default cells
    const isDefaultBg = this.isDefaultCellBackground(bg_r, bg_g, bg_b);
    if (!isDefaultBg) {
      // vendor 0.4.0-nex.7: an INVERSE cell paints its FOREGROUND here, and that slot is frozen
      // at construction like the background is — so it goes through the live theme too, or the
      // block stays the previous theme's colour (§N18). `null` for a colour of the cell's own.
      this.ctx.fillStyle = this.liveThemeColor(bg_r, bg_g, bg_b) ?? this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    // Set text style
    let fontStyle = '';
    if (cell.flags & CellFlags.ITALIC) fontStyle += 'italic ';
    if (cell.flags & CellFlags.BOLD) fontStyle += 'bold ';
    this.ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;

    // Set text color - use selection foreground if selected
    if (isSelected) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    } else {
      // Extract colors and handle inverse
      let fg_r = cell.fg_r,
        fg_g = cell.fg_g,
        fg_b = cell.fg_b;

      if (cell.flags & CellFlags.INVERSE) {
        // When inverted, foreground becomes background
        fg_r = cell.bg_r;
        fg_g = cell.bg_g;
        fg_b = cell.bg_b;
      }

      // vendor 0.4.0-nex.7: the glyph's colour is the terminal's DEFAULT foreground for every
      // cell nothing coloured explicitly, and that default is frozen at construction — so text
      // already on screen kept the previous theme's foreground across a live `theme =` for the
      // same reason the cell backgrounds kept its background (§N18). One lookup, and only for
      // the two default slots; anything the application coloured itself is painted as it asked.
      this.ctx.fillStyle = this.liveThemeColor(fg_r, fg_g, fg_b) ?? this.rgbToCSS(fg_r, fg_g, fg_b);
    }

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // Get the character to render - use grapheme lookup for complex scripts
    let char: string;
    if (cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString) {
      // Cell has additional codepoints - get full grapheme cluster
      char = this.currentBuffer.getGraphemeString(y, x);
    } else {
      // Simple cell - single codepoint
      char = String.fromCodePoint(cell.codepoint || 32); // Default to space if null
    }
    this.ctx.fillText(char, textX, textY);

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw underline
    if (cell.flags & CellFlags.UNDERLINE) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Draw hyperlink underline (for OSC8 hyperlinks)
    if (cell.hyperlink_id > 0) {
      const isHovered = cell.hyperlink_id === this.hoveredHyperlinkId;

      // Only show underline when hovered (cleaner look)
      if (isHovered) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }

    // Draw regex link underline (for plain text URLs)
    if (this.hoveredLinkRange) {
      const range = this.hoveredLinkRange;
      // Check if this cell is within the hovered link range
      const isInRange =
        (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
        (y > range.startY && y < range.endY) ||
        (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX));

      if (isInRange) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }
  }

  /**
   * Render cursor
   */
  private renderCursor(x: number, y: number): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    // vendor 0.4.0-nex.4: an UNFOCUSED surface's cursor is a hollow block, whatever style the
    // terminal asked for. `src/renderer/cursor.zig:59-60` returns `.block_hollow` before it
    // ever looks at `visual_style`, so a bar or underline cursor becomes an outline too.
    if (!this.focused) {
      this.renderHollowCursor(cursorX, cursorY);
      return;
    }

    this.ctx.fillStyle = this.theme.cursor;

    switch (this.cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  /**
   * The unfocused cursor: a hollow block outlining the cell (vendor 0.4.0-nex.4).
   *
   * ghostty draws this as a sprite — `font/sprite/draw/special.zig:300-323`
   * (`cursor_hollow_rect`): fill the whole cell, then punch out everything inset by
   * `metrics.cursor_thickness`. So it is a border of exactly that thickness around the full
   * cell, in the cursor colour, over a cell whose glyph keeps its normal foreground (the
   * cursor-text inversion is applied to the FILLED block only — `renderer/generic.zig:2519`,
   * `if (style == .block)`).
   *
   * `cursor_thickness` is not derived from the font: it defaults to 1 and is only moved by the
   * `adjust-cursor-thickness` config (`font/Metrics.zig:32-34`). ghostty's metrics are in
   * DEVICE pixels (its surface is sized in them), so the outline is one device pixel — which is
   * why this paints under an identity transform instead of the DPR-scaled one the rest of the
   * renderer uses. Painting 1/dpr in scaled space would land the rectangle between device
   * pixels on a fractional cell origin and anti-alias the outline into a grey smear; snapping
   * to the device grid keeps every edge a single fully-lit row of pixels, which is both what
   * ghostty draws and what a pixel readback can verify.
   */
  private renderHollowCursor(cursorX: number, cursorY: number): void {
    const dpr = this.devicePixelRatio;
    const left = Math.round(cursorX * dpr);
    const top = Math.round(cursorY * dpr);
    const width = Math.round(this.metrics.width * dpr);
    const height = Math.round(this.metrics.height * dpr);
    // ghostty's `Minimums.cursor_thickness` is 1 (`font/Metrics.zig:65`), and so is the
    // unadjusted default; a cell too small to hold two edges plus a gap keeps a filled block,
    // which is what `width -| thickness * 2` saturating to zero does over there.
    const thickness = Math.max(1, CURSOR_OUTLINE_DEVICE_PX);
    if (width <= 0 || height <= 0) return;

    this.ctx.save();
    // Identity transform: these are DEVICE pixels, not the CSS pixels the rest of the paint
    // path works in.
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = this.theme.cursor;
    if (width <= thickness * 2 || height <= thickness * 2) {
      this.ctx.fillRect(left, top, width, height);
    } else {
      this.ctx.fillRect(left, top, width, thickness); // top
      this.ctx.fillRect(left, top + height - thickness, width, thickness); // bottom
      this.ctx.fillRect(left, top + thickness, thickness, height - thickness * 2); // left
      this.ctx.fillRect(
        left + width - thickness,
        top + thickness,
        thickness,
        height - thickness * 2
      ); // right
    }
    this.ctx.restore();
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      // Note: Render loop should redraw cursor line automatically
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    // Kept in step with the background the palette below is derived from, so a theme change
    // cannot leave `isDefaultCellBackground` matching the PREVIOUS background's components.
    this.defaultBackgroundRGB = CanvasRenderer.parseRGB(this.theme.background);

    // Rebuild palette
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];
  }

  /**
   * Declare the default colours the WASM terminal was CONSTRUCTED with (vendor 0.4.0-nex.7).
   *
   * Both arguments are the `0xRRGGBB` integers handed to `ghostty_terminal_new_with_config` as
   * `bg_color` / `fg_color` — not the theme's, and not a copy of them: the point is precisely
   * that the two can DIFFER, because `setTheme` moves the theme and nothing can move the
   * terminal's. Pass `null` (or never call this) for a terminal that was configured without the
   * colour, which leaves upstream's `(0, 0, 0)` rule as the only default test — exactly the
   * behaviour every other embedder gets.
   *
   * Called once, from `Terminal.open()`, beside the `createTerminal` that consumed the same
   * numbers. See `liveThemeColor` for what the renderer does with them.
   */
  public setTerminalDefaultColors(background: number | null, foreground: number | null): void {
    this.terminalDefaultBackgroundRGB = CanvasRenderer.rgbFromInt(background);
    this.terminalDefaultForegroundRGB = CanvasRenderer.rgbFromInt(foreground);
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      // An unfocused terminal shows a steady outline; its timer starts when it takes focus.
      if (this.focused) this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  /**
   * Does the surface holding this terminal have keyboard focus? (vendor 0.4.0-nex.4)
   *
   * The port of `ghostty_surface_set_focus`. Focus changes two things and only these two:
   *
   *   - the cursor's TREATMENT — filled, in the terminal's requested style, when focused; a
   *     steady hollow block when not (`renderCursor` / `renderHollowCursor`);
   *   - the blink TIMER — ghostty stops it on focus loss and, on focus gain, shows the cursor
   *     immediately and restarts it (`src/renderer/Thread.zig:379-424`), so a pane that has
   *     just been clicked never opens on the dark half of someone else's blink phase.
   *
   * Nothing about input routing lives here: `focus()` / `blur()` still own the DOM caret. An
   * embedder that never calls this keeps upstream's always-focused behaviour.
   */
  public setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    // The cursor cell has to be repainted even though nothing in the buffer changed.
    this.cursorStateDirty = true;
    if (focused) {
      this.cursorVisible = true;
      if (this.cursorBlink && this.cursorBlinkInterval === undefined) this.startCursorBlink();
    } else {
      this.stopCursorBlink();
    }
  }

  /** Focus state, for embedders that need to read back what they set. */
  public isFocused(): boolean {
    return this.focused;
  }

  /**
   * Get current font metrics
   */

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    this.paintDefaultBackground(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = viewportY / scrollbackLength; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(scrollbarX, scrollbarPadding, scrollbarWidth, scrollbarTrackHeight);

    // Draw scrollbar thumb with opacity
    const isScrolled = viewportY > 0;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);
  }
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    this.hoveredLinkRange = range;
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    this.paintDefaultBackground(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
  }
}

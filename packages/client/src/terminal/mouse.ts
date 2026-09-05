/**
 * DEC mouse reporting, implemented in the PORT'S layer rather than the engine's.
 *
 * Why this file exists at all (../kelpi-docs/capabilities/00-INDEX.md gap #1, §TERM-037…§TERM-039):
 * `ghostty-web@0.4.0` parses DECSET 9 / 1000 / 1002 / 1003 / 1005 / 1006 / 1015 and then
 * **ignores** them — its canvas `mousedown` starts a text selection, `mousemove` extends it,
 * `mouseup` copies it, and `hasMouseTracking()` is never consulted by the input path. A real
 * press → drag → release under 1002 + 1006 produced *zero* reports (run-I's mouse step). So a
 * mouse-mode TUI — vim, tmux, htop, less — had no mouse in a Kelpi pane on the default engine.
 *
 * The fix is engine-agnostic on purpose: the daemon streams the modes (`pane-modes`, from the
 * `@xterm/headless` instance that already sees every PTY byte), the pane intercepts pointer
 * events in the CAPTURE phase before the engine's own canvas handlers can see them, and this
 * module turns them into bytes. Nothing here knows which renderer is underneath, and turning
 * mouse reporting on suppresses the engine's selection for the same events — which is what a
 * real terminal does.
 *
 * **The encoding is ghostty's, transcribed.** Every rule below has a line in
 * `ghostty/src/input/mouse_encode.zig`: `shouldReport` (:172-192), `buttonCode` (:194-240) with
 * its legacy-release-is-button-3, its `+4/+8/+16` modifier bits and its `+32` motion bit, the
 * four wire formats (:120-168) including X10's 223-cell ceiling and UTF-8's `+33` codepoints,
 * and the motion dedupe that only reports when the CELL changed (:106-116). The wheel
 * accumulator is `Surface.zig`'s `scrollCallback` (:3413-3560): pixels accumulate against the
 * cell height and each whole cell is one button-64/65 press, horizontals are 66/67.
 *
 * Bytes, not a string: X10 and URXVT put raw bytes ≥ 0x80 on the wire, and running those
 * through `TextEncoder` would silently turn one byte into a two-byte UTF-8 sequence. Only the
 * UTF-8 format (1005) is *meant* to be UTF-8, and it says so.
 */

/** DEC tracking mode, in xterm's vocabulary (`@kelpi/protocol` `WsMouseTrackingMode`). */
export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/** Coordinate encoding (`@kelpi/protocol` `WsMouseFormat`). */
export type MouseFormat = 'x10' | 'utf8' | 'sgr' | 'urxvt' | 'sgr-pixels';

/** The pane VT modes a client mirrors; the mouse pair is what this module reads. */
export interface PaneVtModes {
    readonly applicationCursorKeys: boolean;
    readonly bracketedPaste: boolean;
    readonly mouseTracking: MouseTrackingMode;
    readonly mouseFormat: MouseFormat;
    /**
     * Kitty keyboard protocol flags (§TERM-030), read by `./kitty-keyboard.ts` rather than by
     * this module — it rides here because the daemon sends one modes object per pane. Optional
     * so every existing `PaneVtModes` literal stays valid; absent reads as `0`, which is
     * "protocol off, legacy encoding".
     */
    readonly kittyKeyboardFlags?: number | undefined;
}

/** A pane nothing has reported modes for yet: no tracking, so nothing is intercepted. */
export const IDLE_PANE_MODES: PaneVtModes = {
    applicationCursorKeys: false,
    bracketedPaste: false,
    mouseTracking: 'none',
    mouseFormat: 'x10',
    kittyKeyboardFlags: 0
};

export type MouseAction = 'press' | 'release' | 'motion';

/**
 * Buttons ghostty can encode. `null` is motion with nothing held (button code 3).
 *
 * `wheel-*` are ghostty's `.four`…`.seven` (64…67); `back` / `forward` are its `.eight` /
 * `.nine` (128 / 129), which is what a five-button mouse's side buttons report.
 */
export type MouseButton =
    | 'left'
    | 'middle'
    | 'right'
    | 'wheel-up'
    | 'wheel-down'
    | 'wheel-left'
    | 'wheel-right'
    | 'back'
    | 'forward';

export interface MouseModifiers {
    readonly shift: boolean;
    readonly alt: boolean;
    readonly ctrl: boolean;
}

export const NO_MODIFIERS: MouseModifiers = { shift: false, alt: false, ctrl: false };

/** One normalized event, in SURFACE-space pixels (0,0 = the grid's top-left). */
export interface MouseReportEvent {
    readonly action: MouseAction;
    readonly button: MouseButton | null;
    readonly mods: MouseModifiers;
    readonly x: number;
    readonly y: number;
}

/**
 * The grid the pixels are measured against.
 *
 * `width`/`height` are the surface box (used for the out-of-viewport rule, which is about the
 * pointer having LEFT the terminal); `cols`/`rows` clamp the cell the pixels resolve to.
 */
export interface MouseGridMetrics {
    readonly cols: number;
    readonly rows: number;
    readonly cellWidth: number;
    readonly cellHeight: number;
    readonly width: number;
    readonly height: number;
}

export interface EncodeMouseOptions {
    readonly tracking: MouseTrackingMode;
    readonly format: MouseFormat;
    readonly metrics: MouseGridMetrics;
    /** Any button currently down — including this event, when it is a press. */
    readonly anyButtonPressed: boolean;
    /** The last cell reported for this pane; motion to the same cell is dropped. */
    readonly lastCell?: { readonly x: number; readonly y: number } | null | undefined;
}

export interface Cell {
    readonly x: number;
    readonly y: number;
}

const ESC = 0x1b;

/** `mouse_encode.zig:172-192`. */
export function shouldReport(event: MouseReportEvent, tracking: MouseTrackingMode): boolean {
    switch (tracking) {
        case 'none':
            return false;
        // X10 reports presses of the three real buttons and nothing else — no wheel, no
        // release, no motion.
        case 'x10':
            return (
                event.action === 'press' &&
                (event.button === 'left' || event.button === 'middle' || event.button === 'right')
            );
        // 1000: press and release (wheel included), never motion.
        case 'vt200':
            return event.action !== 'motion';
        // 1002: motion only while a button is down.
        case 'drag':
            return event.button !== null;
        // 1003: everything.
        case 'any':
            return true;
    }
}

/** `mouse_encode.zig:194-240`. Returns null for a button with no encoding. */
export function buttonCode(
    event: MouseReportEvent,
    tracking: MouseTrackingMode,
    format: MouseFormat
): number | null {
    let code: number;
    if (event.button === null) {
        // Motion with nothing held.
        code = 3;
    } else if (event.action === 'release' && format !== 'sgr' && format !== 'sgr-pixels') {
        // Legacy formats cannot say WHICH button came up, so a release is always button 3.
        code = 3;
    } else {
        switch (event.button) {
            case 'left':
                code = 0;
                break;
            case 'middle':
                code = 1;
                break;
            case 'right':
                code = 2;
                break;
            case 'wheel-up':
                code = 64;
                break;
            case 'wheel-down':
                code = 65;
                break;
            case 'wheel-left':
                code = 66;
                break;
            case 'wheel-right':
                code = 67;
                break;
            case 'back':
                code = 128;
                break;
            case 'forward':
                code = 129;
                break;
        }
    }

    // X10 (mode 9) carries no modifiers at all.
    if (tracking !== 'x10') {
        if (event.mods.shift) code += 4;
        if (event.mods.alt) code += 8;
        if (event.mods.ctrl) code += 16;
    }
    if (event.action === 'motion') code += 32;
    return code;
}

/** Surface pixels → zero-based cell, clamped to the grid (`mouse_encode.zig:258-267`). */
export function positionToCell(x: number, y: number, metrics: MouseGridMetrics): Cell {
    const cellWidth = metrics.cellWidth > 0 ? metrics.cellWidth : 1;
    const cellHeight = metrics.cellHeight > 0 ? metrics.cellHeight : 1;
    const col = Math.floor(x / cellWidth);
    const row = Math.floor(y / cellHeight);
    return {
        x: Math.max(0, Math.min(Math.max(0, metrics.cols - 1), col)),
        y: Math.max(0, Math.min(Math.max(0, metrics.rows - 1), row))
    };
}

/** `mouse_encode.zig:249-254`: is the pointer outside the surface entirely? */
export function positionOutOfViewport(x: number, y: number, metrics: MouseGridMetrics): boolean {
    return x < 0 || y < 0 || x > metrics.width || y > metrics.height;
}

function ascii(text: string, into: number[]): void {
    for (let index = 0; index < text.length; index += 1) into.push(text.charCodeAt(index) & 0xff);
}

/** UTF-8 encode one codepoint (1005's coordinates are codepoints, not bytes). */
function utf8(codepoint: number, into: number[]): void {
    if (codepoint < 0x80) {
        into.push(codepoint);
        return;
    }
    if (codepoint < 0x800) {
        into.push(0xc0 | (codepoint >> 6), 0x80 | (codepoint & 0x3f));
        return;
    }
    into.push(0xe0 | (codepoint >> 12), 0x80 | ((codepoint >> 6) & 0x3f), 0x80 | (codepoint & 0x3f));
}

export interface EncodedMouseReport {
    readonly bytes: Uint8Array;
    /** The cell the report addressed — the caller stores it for motion dedupe. */
    readonly cell: Cell;
}

/**
 * One event → the bytes a mouse-mode application expects, or null when this event is not
 * reported (mode says no, pointer left the surface, motion within the same cell, …).
 */
export function encodeMouseReport(
    event: MouseReportEvent,
    options: EncodeMouseOptions
): EncodedMouseReport | null {
    const { tracking, format, metrics } = options;
    if (!shouldReport(event, tracking)) return null;

    // Out-of-surface: a release is always reported (a TUI that saw the press must see the
    // release), and anything else only in a motion-tracking mode with a button held — which is
    // what lets a drag start inside the pane and continue outside it.
    if (event.action !== 'release' && positionOutOfViewport(event.x, event.y, metrics)) {
        if (tracking !== 'drag' && tracking !== 'any') return null;
        if (!options.anyButtonPressed) return null;
    }

    const cell = positionToCell(event.x, event.y, metrics);

    // Motion is per-CELL, not per-pixel; only 1016 (pixel reporting) wants every move.
    if (event.action === 'motion' && format !== 'sgr-pixels') {
        const last = options.lastCell;
        if (last !== null && last !== undefined && last.x === cell.x && last.y === cell.y) return null;
    }

    const code = buttonCode(event, tracking, format);
    if (code === null) return null;

    const out: number[] = [];
    switch (format) {
        case 'x10': {
            // A single byte per coordinate caps the reportable grid at 223 columns/rows; xterm
            // drops the report rather than wrapping, and so does ghostty.
            if (cell.x > 222 || cell.y > 222) return null;
            out.push(ESC, 0x5b, 0x4d, 32 + code, 32 + cell.x + 1, 32 + cell.y + 1);
            break;
        }
        case 'utf8': {
            out.push(ESC, 0x5b, 0x4d, 32 + code);
            utf8(cell.x + 33, out);
            utf8(cell.y + 33, out);
            break;
        }
        case 'sgr': {
            ascii(
                `[<${String(code)};${String(cell.x + 1)};${String(cell.y + 1)}${
                    event.action === 'release' ? 'm' : 'M'
                }`,
                out
            );
            break;
        }
        case 'urxvt': {
            ascii(`[${String(32 + code)};${String(cell.x + 1)};${String(cell.y + 1)}M`, out);
            break;
        }
        case 'sgr-pixels': {
            const px = Math.round(event.x);
            const py = Math.round(event.y);
            ascii(
                `[<${String(code)};${String(px)};${String(py)}${
                    event.action === 'release' ? 'm' : 'M'
                }`,
                out
            );
            break;
        }
    }
    return { bytes: Uint8Array.from(out), cell };
}

// ── the stateful side: one reporter per pane ────────────────────────────────────────

/** The subset of a DOM mouse/wheel event this module reads — so tests need no DOM. */
export interface PointerLike {
    /** Client coordinates; the reporter subtracts the surface origin itself. */
    readonly clientX: number;
    readonly clientY: number;
    /** DOM `MouseEvent.button`: 0 left, 1 middle, 2 right, 3 back, 4 forward. */
    readonly button?: number | undefined;
    readonly shiftKey?: boolean | undefined;
    readonly altKey?: boolean | undefined;
    readonly ctrlKey?: boolean | undefined;
    readonly metaKey?: boolean | undefined;
}

export interface WheelLike extends PointerLike {
    readonly deltaX: number;
    readonly deltaY: number;
    /** 0 = pixels (a trackpad / precise wheel), 1 = lines, 2 = pages. */
    readonly deltaMode?: number | undefined;
}

/** Where the grid sits on screen, plus its metrics. Null = not measurable yet. */
export type MetricsSource = () => (MouseGridMetrics & { readonly originX: number; readonly originY: number }) | null;

export interface MouseReporterOptions {
    readonly modes: () => PaneVtModes;
    readonly metrics: MetricsSource;
    readonly write: (bytes: Uint8Array) => void;
}

/**
 * A runaway wheel delta must not become hundreds of reports in one gesture. Chromium's own
 * deltas are two or three cell-heights, so this only ever fires for synthetic input — but a
 * pane that hangs the PTY on one flick would be a worse bug than the one this file fixes.
 */
export const MAX_WHEEL_REPORTS_PER_EVENT = 64;

export interface MouseReporter {
    /** True while an application has asked for mouse events. */
    readonly active: boolean;
    /** True while a reported (non-shift-bypassed) drag is in progress. */
    readonly dragging: boolean;
    /** Returns true when the event was CONSUMED — the engine must not also see it. */
    down(event: PointerLike): boolean;
    move(event: PointerLike): boolean;
    up(event: PointerLike): boolean;
    wheel(event: WheelLike): boolean;
    /** Forget pressed buttons and dedupe state (pane teardown, mode off, focus loss). */
    reset(): void;
}

function modifiersOf(event: PointerLike): MouseModifiers {
    return {
        shift: event.shiftKey === true,
        // Ghostty's "alt" bit is the Option key; a browser also has Meta, which the DEC
        // protocol has no bit for — ⌘ is left to the app's own keybindings, as in ghostty.
        alt: event.altKey === true,
        ctrl: event.ctrlKey === true
    };
}

const DOM_BUTTONS: Record<number, MouseButton> = {
    0: 'left',
    1: 'middle',
    2: 'right',
    3: 'back',
    4: 'forward'
};

/**
 * Per-pane reporting state: which buttons are down, the last cell (motion dedupe) and the
 * sub-cell wheel remainder.
 */
export function createMouseReporter(options: MouseReporterOptions): MouseReporter {
    /**
     * Every button seen go down inside the pane — reported ones AND shift-bypassed ones.
     *
     * Ghostty keeps its `click_state` for bypassed presses too (`Surface.zig:3879-3886`:
     * "we mark the click state because we need that to properly make some mouse reports"), and
     * the motion rule below depends on knowing a button is down even when its press went to the
     * engine's selection instead of to the application.
     */
    const held = new Set<MouseButton>();
    let lastCell: Cell | null = null;
    let pendingScrollX = 0;
    let pendingScrollY = 0;
    /** True once a press was REPORTED; the pane uses it to own the rest of the drag. */
    let capturing = false;

    const modes = (): PaneVtModes => options.modes();

    const emit = (event: MouseReportEvent, metrics: MouseGridMetrics): boolean => {
        const current = modes();
        const report = encodeMouseReport(event, {
            tracking: current.mouseTracking,
            format: current.mouseFormat,
            metrics,
            anyButtonPressed: held.size > 0,
            lastCell
        });
        if (report === null) return false;
        lastCell = report.cell;
        options.write(report.bytes);
        return true;
    };

    const surface = (
        event: PointerLike
    ): { metrics: MouseGridMetrics; x: number; y: number } | null => {
        const measured = options.metrics();
        if (measured === null) return null;
        return {
            metrics: measured,
            x: event.clientX - measured.originX,
            y: event.clientY - measured.originY
        };
    };

    /**
     * Shift is the universal "let me select anyway" override, and it is ghostty's default
     * (`mouse-shift-capture = false`; `Surface.zig:3844-3846` — "if we have shift-pressed and
     * we aren't allowed to capture it, then we do not do a mouse report").
     *
     * It applies to BUTTON events, and to motion **only while a button is held**
     * (`Surface.zig:4582-4589`: "This only applies if there is a mouse button pressed so that
     * movement reports are not affected"). `scrollCallback` never consults it at all, so
     * shift+wheel still reports — with the shift bit set — exactly as ghostty does.
     */
    const shifted = (event: PointerLike): boolean => event.shiftKey === true;

    return {
        get active(): boolean {
            return modes().mouseTracking !== 'none';
        },
        get dragging(): boolean {
            return capturing;
        },
        down(event): boolean {
            if (modes().mouseTracking === 'none') return false;
            const button = DOM_BUTTONS[event.button ?? 0];
            if (button === undefined) return false;
            // Recorded even when the report is bypassed — see `held`.
            held.add(button);
            if (shifted(event)) return false;
            const box = surface(event);
            if (box === null) return false;
            capturing = true;
            emit(
                { action: 'press', button, mods: modifiersOf(event), x: box.x, y: box.y },
                box.metrics
            );
            // Consumed even where the mode declined to encode it: reporting is on, so the
            // engine must not turn this press into a selection either way.
            return true;
        },
        move(event): boolean {
            const tracking = modes().mouseTracking;
            if (tracking === 'none') return false;
            // Shift + a held button = the user is selecting; hands off.
            if (shifted(event) && held.size > 0) return false;
            // `drag` (1002) reports motion only while a button is held; `any` (1003) always.
            if (tracking !== 'any' && held.size === 0) return false;
            const box = surface(event);
            if (box === null) return false;
            // The first button found held is what gets reported for a multi-button drag —
            // ghostty's own comment says the spec does not say (`Surface.zig:4591-4596`).
            const button = (['left', 'middle', 'right'] as const).find((candidate) =>
                held.has(candidate)
            );
            emit(
                {
                    action: 'motion',
                    button: button ?? null,
                    mods: modifiersOf(event),
                    x: box.x,
                    y: box.y
                },
                box.metrics
            );
            return true;
        },
        up(event): boolean {
            if (modes().mouseTracking === 'none') return false;
            const button = DOM_BUTTONS[event.button ?? 0];
            if (button === undefined) return false;
            // A release for a press this pane never saw belongs to whoever did see it.
            if (!held.delete(button)) return false;
            if (held.size === 0) capturing = false;
            if (shifted(event)) return false;
            const box = surface(event);
            if (box === null) return true;
            emit(
                { action: 'release', button, mods: modifiersOf(event), x: box.x, y: box.y },
                box.metrics
            );
            return true;
        },
        wheel(event): boolean {
            if (modes().mouseTracking === 'none') return false;
            const box = surface(event);
            if (box === null) return false;
            const metrics = box.metrics;
            const cellHeight = metrics.cellHeight > 0 ? metrics.cellHeight : 1;
            const cellWidth = metrics.cellWidth > 0 ? metrics.cellWidth : 1;
            const precise = (event.deltaMode ?? 0) === 0;

            // `Surface.zig:3413-3487`: precise deltas are pixels and accumulate; discrete ticks
            // are normalized to at least one whole cell so a single detent always scrolls once.
            const verticalPixels = precise
                ? event.deltaY
                : ticks(event.deltaY, event.deltaMode ?? 1, metrics.rows) * cellHeight;
            const horizontalPixels = precise
                ? event.deltaX
                : ticks(event.deltaX, event.deltaMode ?? 1, metrics.cols) * cellWidth;

            pendingScrollY += verticalPixels;
            pendingScrollX += horizontalPixels;
            const verticalSteps = Math.trunc(pendingScrollY / cellHeight);
            const horizontalSteps = Math.trunc(pendingScrollX / cellWidth);
            pendingScrollY -= verticalSteps * cellHeight;
            pendingScrollX -= horizontalSteps * cellWidth;

            const mods = modifiersOf(event);
            // A wheel report is always a PRESS; there is no release for a detent.
            const send = (button: MouseButton, count: number): void => {
                const total = Math.min(Math.abs(count), MAX_WHEEL_REPORTS_PER_EVENT);
                for (let index = 0; index < total; index += 1) {
                    emit({ action: 'press', button, mods, x: box.x, y: box.y }, metrics);
                }
            };
            // Browser convention: deltaY < 0 is "away from the user" = scroll up.
            if (verticalSteps !== 0) send(verticalSteps < 0 ? 'wheel-up' : 'wheel-down', verticalSteps);
            if (horizontalSteps !== 0) {
                send(horizontalSteps < 0 ? 'wheel-left' : 'wheel-right', horizontalSteps);
            }
            // Consumed regardless of whether a whole cell accumulated: reporting is on, so the
            // engine must not scroll its own viewport underneath the application.
            return true;
        },
        reset(): void {
            held.clear();
            lastCell = null;
            pendingScrollX = 0;
            pendingScrollY = 0;
            capturing = false;
        }
    };
}

/** Discrete wheel units → whole ticks, never rounding a real flick down to zero. */
function ticks(delta: number, deltaMode: number, pageUnits: number): number {
    if (delta === 0) return 0;
    const unit = deltaMode === 2 ? Math.max(1, pageUnits) : 1;
    const bounded = delta > 0 ? Math.max(delta, 1) : Math.min(delta, -1);
    return bounded * unit;
}

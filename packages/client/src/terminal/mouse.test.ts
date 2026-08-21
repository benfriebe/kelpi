/**
 * The mouse-report encoder, byte for byte.
 *
 * Every expectation here is checked against `ghostty/src/input/mouse_encode.zig` and
 * `Surface.zig`'s `scrollCallback` — the port implements DEC mouse reporting itself because no
 * renderer it ships does (§TERM-037), so "matches ghostty" is the only definition of correct
 * available, and it has to be asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import {
    buttonCode,
    createMouseReporter,
    encodeMouseReport,
    positionToCell,
    shouldReport,
    type MouseGridMetrics,
    type MouseReportEvent,
    type MouseTrackingMode,
    type PaneVtModes
} from './mouse';

/** 10 px × 20 px cells, an 80 × 24 grid — so pixel→cell arithmetic is readable. */
const METRICS: MouseGridMetrics = {
    cols: 80,
    rows: 24,
    cellWidth: 10,
    cellHeight: 20,
    width: 800,
    height: 480
};

const NONE = { shift: false, alt: false, ctrl: false };

function text(bytes: Uint8Array): string {
    return [...bytes].map((byte) => (byte === 0x1b ? '\\e' : String.fromCharCode(byte))).join('');
}

function encode(
    event: MouseReportEvent,
    options: {
        tracking?: MouseTrackingMode;
        format?: 'x10' | 'utf8' | 'sgr' | 'urxvt' | 'sgr-pixels';
        anyButtonPressed?: boolean;
        lastCell?: { x: number; y: number } | null;
        metrics?: MouseGridMetrics;
    } = {}
): string | null {
    const report = encodeMouseReport(event, {
        tracking: options.tracking ?? 'drag',
        format: options.format ?? 'sgr',
        metrics: options.metrics ?? METRICS,
        anyButtonPressed: options.anyButtonPressed ?? false,
        lastCell: options.lastCell ?? null
    });
    return report === null ? null : text(report.bytes);
}

describe('shouldReport — mouse_encode.zig:172-192', () => {
    const press: MouseReportEvent = { action: 'press', button: 'left', mods: NONE, x: 0, y: 0 };

    it('never reports with tracking off', () => {
        for (const action of ['press', 'release', 'motion'] as const) {
            expect(shouldReport({ ...press, action }, 'none')).toBe(false);
        }
    });

    it('X10 reports presses of the three real buttons only', () => {
        expect(shouldReport(press, 'x10')).toBe(true);
        expect(shouldReport({ ...press, button: 'middle' }, 'x10')).toBe(true);
        expect(shouldReport({ ...press, action: 'release' }, 'x10')).toBe(false);
        expect(shouldReport({ ...press, action: 'motion' }, 'x10')).toBe(false);
        expect(shouldReport({ ...press, button: 'wheel-up' }, 'x10')).toBe(false);
    });

    it('vt200 reports press and release (wheel included) but never motion', () => {
        expect(shouldReport(press, 'vt200')).toBe(true);
        expect(shouldReport({ ...press, action: 'release' }, 'vt200')).toBe(true);
        expect(shouldReport({ ...press, button: 'wheel-down' }, 'vt200')).toBe(true);
        expect(shouldReport({ ...press, action: 'motion' }, 'vt200')).toBe(false);
    });

    it('drag reports motion only with a button, any reports everything', () => {
        expect(shouldReport({ ...press, action: 'motion', button: 'left' }, 'drag')).toBe(true);
        expect(shouldReport({ ...press, action: 'motion', button: null }, 'drag')).toBe(false);
        expect(shouldReport({ ...press, action: 'motion', button: null }, 'any')).toBe(true);
    });
});

describe('buttonCode — mouse_encode.zig:194-240', () => {
    const at = (event: Partial<MouseReportEvent>): MouseReportEvent => ({
        action: 'press',
        button: 'left',
        mods: NONE,
        x: 0,
        y: 0,
        ...event
    });

    it('numbers the buttons the way the protocol does', () => {
        expect(buttonCode(at({ button: 'left' }), 'drag', 'sgr')).toBe(0);
        expect(buttonCode(at({ button: 'middle' }), 'drag', 'sgr')).toBe(1);
        expect(buttonCode(at({ button: 'right' }), 'drag', 'sgr')).toBe(2);
        expect(buttonCode(at({ button: 'wheel-up' }), 'drag', 'sgr')).toBe(64);
        expect(buttonCode(at({ button: 'wheel-down' }), 'drag', 'sgr')).toBe(65);
        expect(buttonCode(at({ button: 'wheel-left' }), 'drag', 'sgr')).toBe(66);
        expect(buttonCode(at({ button: 'wheel-right' }), 'drag', 'sgr')).toBe(67);
        expect(buttonCode(at({ button: 'back' }), 'drag', 'sgr')).toBe(128);
        expect(buttonCode(at({ button: 'forward' }), 'drag', 'sgr')).toBe(129);
    });

    it('encodes a legacy release as button 3, and an SGR release as the real button', () => {
        expect(buttonCode(at({ action: 'release', button: 'right' }), 'drag', 'x10')).toBe(3);
        expect(buttonCode(at({ action: 'release', button: 'right' }), 'drag', 'urxvt')).toBe(3);
        expect(buttonCode(at({ action: 'release', button: 'right' }), 'drag', 'sgr')).toBe(2);
    });

    it('adds 4/8/16 for shift/alt/ctrl, and 32 for motion', () => {
        expect(buttonCode(at({ mods: { shift: true, alt: false, ctrl: false } }), 'drag', 'sgr')).toBe(4);
        expect(buttonCode(at({ mods: { shift: false, alt: true, ctrl: false } }), 'drag', 'sgr')).toBe(8);
        expect(buttonCode(at({ mods: { shift: false, alt: false, ctrl: true } }), 'drag', 'sgr')).toBe(16);
        expect(buttonCode(at({ mods: { shift: true, alt: true, ctrl: true } }), 'drag', 'sgr')).toBe(28);
        expect(buttonCode(at({ action: 'motion' }), 'drag', 'sgr')).toBe(32);
        expect(buttonCode(at({ action: 'motion', button: null }), 'any', 'sgr')).toBe(35);
    });

    it('X10 tracking carries no modifiers at all', () => {
        expect(buttonCode(at({ mods: { shift: true, alt: true, ctrl: true } }), 'x10', 'x10')).toBe(0);
    });
});

describe('positionToCell', () => {
    it('floors pixels into cells', () => {
        expect(positionToCell(0, 0, METRICS)).toEqual({ x: 0, y: 0 });
        expect(positionToCell(9.9, 19.9, METRICS)).toEqual({ x: 0, y: 0 });
        expect(positionToCell(10, 20, METRICS)).toEqual({ x: 1, y: 1 });
        expect(positionToCell(45, 61, METRICS)).toEqual({ x: 4, y: 3 });
    });

    it('clamps to the grid rather than reporting a cell that does not exist', () => {
        expect(positionToCell(100_000, 100_000, METRICS)).toEqual({ x: 79, y: 23 });
        expect(positionToCell(-5, -5, METRICS)).toEqual({ x: 0, y: 0 });
    });
});

describe('encodeMouseReport — the four wire formats', () => {
    const press: MouseReportEvent = { action: 'press', button: 'left', mods: NONE, x: 45, y: 61 };

    it('SGR (1006): CSI < b ; x ; y M/m, 1-based', () => {
        expect(encode(press, { format: 'sgr' })).toBe('\\e[<0;5;4M');
        expect(encode({ ...press, action: 'release' }, { format: 'sgr' })).toBe('\\e[<0;5;4m');
    });

    it('X10 (default): CSI M with three 32-offset bytes', () => {
        // cell (4,3) → bytes 32+0, 32+4+1, 32+3+1 = ' ', '%', '$'
        expect(encode(press, { format: 'x10' })).toBe('\\e[M %$');
    });

    it('X10 drops a report it cannot express (past column 223)', () => {
        const wide: MouseGridMetrics = { ...METRICS, cols: 400, width: 4000 };
        expect(encode({ ...press, x: 3000 }, { format: 'x10', metrics: wide })).toBeNull();
        // SGR has no such ceiling.
        expect(encode({ ...press, x: 3000 }, { format: 'sgr', metrics: wide })).toBe('\\e[<0;301;4M');
    });

    it('UTF-8 (1005): the button stays one byte, the coordinates are codepoints + 33', () => {
        const wide: MouseGridMetrics = { ...METRICS, cols: 400, width: 4000 };
        const report = encodeMouseReport(
            { ...press, x: 3000 },
            { tracking: 'drag', format: 'utf8', metrics: wide, anyButtonPressed: false }
        );
        // cell.x = 300 → codepoint 333 → two UTF-8 bytes; cell.y = 3 → 36 = '$'
        expect([...(report?.bytes ?? [])]).toEqual([0x1b, 0x5b, 0x4d, 32, 0xc5, 0x8d, 36]);
    });

    it('URXVT (1015): decimal button + 32, then the coordinates', () => {
        expect(encode(press, { format: 'urxvt' })).toBe('\\e[32;5;4M');
        // Legacy release → button 3 → 35.
        expect(encode({ ...press, action: 'release' }, { format: 'urxvt' })).toBe('\\e[35;5;4M');
    });

    it('SGR-pixels (1016) reports pixels, not cells', () => {
        expect(encode(press, { format: 'sgr-pixels' })).toBe('\\e[<0;45;61M');
    });
});

describe('encodeMouseReport — the rules around the encoding', () => {
    const motion: MouseReportEvent = { action: 'motion', button: 'left', mods: NONE, x: 45, y: 61 };

    it('drops motion inside the same cell, and reports it once the cell changes', () => {
        expect(encode(motion, { lastCell: { x: 4, y: 3 } })).toBeNull();
        expect(encode(motion, { lastCell: { x: 3, y: 3 } })).toBe('\\e[<32;5;4M');
    });

    it('reports every move in pixel mode, same cell or not', () => {
        expect(encode(motion, { format: 'sgr-pixels', lastCell: { x: 4, y: 3 } })).toBe('\\e[<32;45;61M');
    });

    it('drops a press outside the surface', () => {
        expect(encode({ ...motion, action: 'press', x: -20 })).toBeNull();
        expect(encode({ ...motion, action: 'press', y: 900 })).toBeNull();
    });

    it('reports motion outside the surface while a button is held (drag-out), never without', () => {
        expect(encode({ ...motion, x: 900 }, { anyButtonPressed: true })).toBe('\\e[<32;80;4M');
        expect(encode({ ...motion, x: 900 }, { anyButtonPressed: false })).toBeNull();
        // vt200 has no motion tracking, so an out-of-surface motion is dropped outright.
        expect(encode({ ...motion, x: 900 }, { tracking: 'vt200', anyButtonPressed: true })).toBeNull();
    });

    it('always reports a release, even from outside the surface', () => {
        // A TUI that saw the press has to see the release or it thinks the button is still down.
        expect(encode({ ...motion, action: 'release', x: 5000, y: 5000 })).toBe('\\e[<0;80;24m');
    });
});

// ── the stateful reporter ───────────────────────────────────────────────────────────

function reporter(overrides: Partial<PaneVtModes> = {}) {
    const written: string[] = [];
    let modes: PaneVtModes = {
        applicationCursorKeys: false,
        bracketedPaste: false,
        mouseTracking: 'drag',
        mouseFormat: 'sgr',
        ...overrides
    };
    const instance = createMouseReporter({
        modes: () => modes,
        // Origin at (100, 50) so a client coordinate is never accidentally a surface one.
        metrics: () => ({ ...METRICS, originX: 100, originY: 50 }),
        write: (bytes) => written.push(text(bytes))
    });
    return {
        reporter: instance,
        written,
        setModes(next: Partial<PaneVtModes>): void {
            modes = { ...modes, ...next };
        }
    };
}

describe('createMouseReporter — press, drag, release', () => {
    it('encodes a full click-drag-release gesture', () => {
        const h = reporter();
        expect(h.reporter.down({ clientX: 145, clientY: 111, button: 0 })).toBe(true);
        expect(h.reporter.move({ clientX: 185, clientY: 131, button: 0 })).toBe(true);
        expect(h.reporter.up({ clientX: 185, clientY: 131, button: 0 })).toBe(true);
        expect(h.written).toEqual(['\\e[<0;5;4M', '\\e[<32;9;5M', '\\e[<0;9;5m']);
    });

    it('does not report anything with tracking off, and consumes nothing', () => {
        const h = reporter({ mouseTracking: 'none' });
        expect(h.reporter.down({ clientX: 145, clientY: 111, button: 0 })).toBe(false);
        expect(h.reporter.move({ clientX: 185, clientY: 131, button: 0 })).toBe(false);
        expect(h.reporter.up({ clientX: 185, clientY: 131, button: 0 })).toBe(false);
        expect(h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 0, deltaY: -120 })).toBe(false);
        expect(h.written).toEqual([]);
        expect(h.reporter.active).toBe(false);
    });

    it('SHIFT bypasses reporting so the engine can select — ghostty Surface.zig:3844-3846', () => {
        const h = reporter();
        expect(h.reporter.down({ clientX: 145, clientY: 111, button: 0, shiftKey: true })).toBe(false);
        expect(h.reporter.move({ clientX: 185, clientY: 131, button: 0, shiftKey: true })).toBe(false);
        expect(h.reporter.up({ clientX: 185, clientY: 131, button: 0, shiftKey: true })).toBe(false);
        expect(h.written).toEqual([]);
    });

    it('shift does NOT suppress bare motion in any-motion mode (Surface.zig:4582-4589)', () => {
        const h = reporter({ mouseTracking: 'any' });
        expect(h.reporter.move({ clientX: 145, clientY: 111, shiftKey: true })).toBe(true);
        expect(h.written).toEqual(['\\e[<39;5;4M']); // 3 (no button) + 4 (shift) + 32 (motion)
    });

    it('reports the modifiers held during the press', () => {
        const h = reporter();
        h.reporter.down({ clientX: 145, clientY: 111, button: 2, ctrlKey: true, altKey: true });
        expect(h.written).toEqual(['\\e[<26;5;4M']); // right (2) + alt (8) + ctrl (16)
    });

    it('drops motion that stays inside one cell', () => {
        const h = reporter();
        h.reporter.down({ clientX: 145, clientY: 111, button: 0 });
        h.reporter.move({ clientX: 148, clientY: 115, button: 0 });
        h.reporter.move({ clientX: 149, clientY: 118, button: 0 });
        expect(h.written).toEqual(['\\e[<0;5;4M']);
    });

    it('does not report bare motion in 1002, and does in 1003', () => {
        const drag = reporter();
        expect(drag.reporter.move({ clientX: 145, clientY: 111 })).toBe(false);
        expect(drag.written).toEqual([]);

        const any = reporter({ mouseTracking: 'any' });
        expect(any.reporter.move({ clientX: 145, clientY: 111 })).toBe(true);
        expect(any.written).toEqual(['\\e[<35;5;4M']);
    });

    it('ignores a release for a press it never saw', () => {
        const h = reporter();
        expect(h.reporter.up({ clientX: 145, clientY: 111, button: 0 })).toBe(false);
        expect(h.written).toEqual([]);
    });

    it('tracks a drag that leaves the pane and comes back', () => {
        const h = reporter();
        h.reporter.down({ clientX: 145, clientY: 111, button: 0 });
        // Well outside the 800×480 surface: still reported, because a button is down.
        h.reporter.move({ clientX: 2000, clientY: 111, button: 0 });
        h.reporter.up({ clientX: 2000, clientY: 111, button: 0 });
        expect(h.written).toEqual(['\\e[<0;5;4M', '\\e[<32;80;4M', '\\e[<0;80;4m']);
    });

    it('reset() forgets held buttons, so a re-mounted pane does not report a stale drag', () => {
        const h = reporter();
        h.reporter.down({ clientX: 145, clientY: 111, button: 0 });
        expect(h.reporter.dragging).toBe(true);
        h.reporter.reset();
        expect(h.reporter.dragging).toBe(false);
        expect(h.reporter.move({ clientX: 300, clientY: 200, button: 0 })).toBe(false);
    });
});

describe('createMouseReporter — the wheel', () => {
    it('reports a pixel wheel as button 64/65, one report per whole cell', () => {
        const h = reporter();
        // 20 px cells: -60 px = three cells up.
        expect(h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 0, deltaY: -60 })).toBe(true);
        expect(h.written).toEqual(['\\e[<64;5;4M', '\\e[<64;5;4M', '\\e[<64;5;4M']);
        h.written.length = 0;
        h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 0, deltaY: 40 });
        expect(h.written).toEqual(['\\e[<65;5;4M', '\\e[<65;5;4M']);
    });

    it('accumulates sub-cell deltas instead of losing them', () => {
        // Surface.zig:3441-3457 — a trackpad's 8 px nudges have to add up to a scroll.
        const h = reporter();
        for (let index = 0; index < 2; index += 1) {
            h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 0, deltaY: -8 });
        }
        expect(h.written).toEqual([]);
        h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 0, deltaY: -8 });
        expect(h.written).toEqual(['\\e[<64;5;4M']);
    });

    it('a discrete line tick is always at least one whole scroll', () => {
        const h = reporter();
        h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 0, deltaY: -0.1, deltaMode: 1 });
        expect(h.written).toEqual(['\\e[<64;5;4M']);
    });

    it('reports horizontal wheel as 66/67', () => {
        const h = reporter();
        h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: -20, deltaY: 0 });
        expect(h.written).toEqual(['\\e[<66;5;4M', '\\e[<66;5;4M']);
        h.written.length = 0;
        h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 30, deltaY: 0 });
        expect(h.written).toEqual(['\\e[<67;5;4M', '\\e[<67;5;4M', '\\e[<67;5;4M']);
    });

    it('reports the wheel with SHIFT held rather than bypassing it', () => {
        // `scrollCallback` never consults shift-capture, so the shift bit rides in the button.
        const h = reporter();
        h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 0, deltaY: -20, shiftKey: true });
        expect(h.written).toEqual(['\\e[<68;5;4M']); // 64 + 4
    });

    it('X10 tracking never reports the wheel, but still consumes it', () => {
        const h = reporter({ mouseTracking: 'x10' });
        expect(h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 0, deltaY: -60 })).toBe(true);
        expect(h.written).toEqual([]);
    });

    it('caps a pathological delta instead of flooding the PTY', () => {
        const h = reporter();
        h.reporter.wheel({ clientX: 145, clientY: 111, deltaX: 0, deltaY: -100_000 });
        expect(h.written).toHaveLength(64);
    });
});

describe('createMouseReporter — mode changes mid-gesture', () => {
    it('follows the format the daemon last reported', () => {
        const h = reporter();
        h.reporter.down({ clientX: 145, clientY: 111, button: 0 });
        h.setModes({ mouseFormat: 'x10' });
        h.reporter.up({ clientX: 145, clientY: 111, button: 0 });
        expect(h.written).toEqual(['\\e[<0;5;4M', '\\e[M#%$']);
    });

    it('an application turning reporting off mid-drag stops the reports', () => {
        const h = reporter();
        h.reporter.down({ clientX: 145, clientY: 111, button: 0 });
        h.setModes({ mouseTracking: 'none' });
        expect(h.reporter.move({ clientX: 300, clientY: 200, button: 0 })).toBe(false);
        expect(h.written).toEqual(['\\e[<0;5;4M']);
    });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty, SelectionManager, Terminal, type CanvasRenderer } from 'ghostty-web';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copySelection } from '../app/clipboard';

// Exercise the installed bundle, its real WASM, and the actual mouse selection listeners.
// Only canvas painting/metrics and the clipboard sink are doubles; no desktop is involved.
let ghostty: Ghostty;
beforeAll(async () => {
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../vendor/ghostty-web-patched/ghostty-vt.wasm')
    )));
    ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture() {
    const term = new Terminal({ ghostty, cols: 80, rows: 10 });
    const vt = ghostty.createTerminal(80, 10, { scrollbackLimit: 10 });
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientHeight', { value: 200 });
    canvas.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 200, right: 800, width: 800, height: 200, x: 0, y: 0, toJSON() {} });
    const textarea = document.createElement('textarea');
    const renderer = {
        getCanvas: () => canvas,
        getMetrics: () => ({ width: 10, height: 20 })
    } as unknown as CanvasRenderer;
    const selection = new SelectionManager(term, renderer, vt, textarea);
    Object.assign(term, { isOpen: true, wasmTerm: vt, selectionManager: selection });
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
    const line = (n: number) => `conversation-${String(n).padStart(5, '0')}`;
    let next = 0;
    const writeLines = (count: number) => {
        for (let i = 0; i < count; i++) term.write(`${line(next++)}\r\n`);
    };
    const release = () => document.dispatchEvent(new MouseEvent('mouseup', { button: 0, shiftKey: true }));
    const select = (startRow: number, endRow = startRow, backward = false, finish = true) => {
        const first = { clientX: 1, clientY: startRow * 20 + 10 };
        const last = { clientX: 179, clientY: endRow * 20 + 10 };
        canvas.dispatchEvent(new MouseEvent('mousedown', { ...(backward ? last : first), button: 0, shiftKey: true }));
        canvas.dispatchEvent(new MouseEvent('mousemove', { ...(backward ? first : last), buttons: 1, shiftKey: true }));
        if (finish) release();
    };
    const dispose = () => { selection.dispose(); vt.free(); };
    return { term, vt, selection, canvas, line, writeLines, select, release, dispose };
}

describe('selection across real scrollback trimming (#170)', () => {
    it.each([false, true])('keeps retained conversation text attached to its rows (backward=%s)', backward => {
        const f = fixture();
        try {
            f.writeLines(1100);
            f.term.viewportY = 100;
            f.select(2, 3, backward);
            const selected = `${f.line(993)}\n${f.line(994)}`;
            expect(f.term.getSelection()).toBe(selected);
            const before = f.vt.getScrollbackLength();
            f.writeLines(100);
            expect(f.vt.getScrollbackLength()).toBeLessThan(before); // a real page was trimmed
            expect(f.term.getSelection()).toBe(selected);
            const coords = f.selection.getSelectionCoords();
            expect(coords).not.toBeNull();
            // The highlight and the copy read must refer to the same retained row.
            const row = f.vt.getScrollbackLength() - Math.floor(f.term.viewportY) + coords!.startRow;
            const visible = (f.vt.getScrollbackLine(row) ?? []).map(c => c.codepoint ? String.fromCodePoint(c.codepoint) : ' ').join('').trimEnd();
            expect(visible).toBe(f.line(993));
        } finally { f.dispose(); }
    });

    it('preserves a selection across a batched write with a trim hidden by net growth', () => {
        const f = fixture();
        try {
            f.writeLines(1100);
            f.select(3);
            const selected = f.line(1094);
            expect(f.term.getSelection()).toBe(selected);
            const before = f.vt.getScrollbackLength();
            // 650 rows append, 589 trim: length alone looks like ordinary growth.
            f.term.write(Array.from({ length: 650 }, (_, n) => `${f.line(1100 + n)}\r\n`).join(''));
            expect(f.vt.getScrollbackLength()).toBeGreaterThan(before);
            expect(f.term.getSelection()).toBe(selected);
        } finally { f.dispose(); }
    });

    it.each([false, true])('clears and announces a selection whose endpoint was discarded (partial=%s)', partial => {
        const f = fixture();
        try {
            f.writeLines(1100);
            // The first page ends at row 588. Span that boundary in the partial case.
            f.term.viewportY = f.vt.getScrollbackLength() - (partial ? 586 : 3);
            f.select(1, 4);
            expect(f.term.getSelection()).not.toBe('');
            const selectionChanged = vi.fn();
            f.selection.onSelectionChange(selectionChanged);
            f.writeLines(100);
            expect(f.term.getSelection()).toBe('');
            expect(f.selection.getSelectionCoords()).toBeNull();
            expect(f.term.hasSelection()).toBe(false);
            expect(selectionChanged).toHaveBeenCalledOnce();
        } finally { f.dispose(); }
    });

    it('keeps selected history across a status-line repaint and ordinary scrollback growth', () => {
        const f = fixture();
        try {
            f.writeLines(200);
            f.term.viewportY = 40;
            f.select(3);
            const selected = f.line(154);
            expect(f.term.getSelection()).toBe(selected);
            f.term.write('\x1b[10;1H\x1b[2Kstatus is still running');
            expect(f.term.getSelection()).toBe(selected);
            f.writeLines(20);
            expect(f.term.getSelection()).toBe(selected);
        } finally { f.dispose(); }
    });

    it.each(['\x1bc', '\x1b[?1049h', '\x1b[3J'])('clears stale endpoints on reset, screen switch, or history erasure (%j)', control => {
        const f = fixture();
        try {
            f.writeLines(100);
            f.term.viewportY = 40;
            f.select(3);
            expect(f.term.getSelection()).not.toBe('');
            f.term.write(control);
            expect(f.term.getSelection()).toBe('');
            expect(f.selection.getSelectionCoords()).toBeNull();
            f.term.write('\x1b[?1049l');
            expect(f.term.getSelection()).toBe(''); // switching back must not resurrect it
        } finally { f.dispose(); }
    });

    it('keeps active-screen text selected when only history is erased', () => {
        const f = fixture();
        try {
            f.writeLines(100);
            f.select(3);
            expect(f.term.getSelection()).toBe(f.line(94));
            f.term.write('\x1b[3J');
            expect(f.vt.getScrollbackLength()).toBe(0);
            expect(f.term.getSelection()).toBe(f.line(94));
        } finally { f.dispose(); }
    });

    it('announces explicit clearing once', () => {
        const f = fixture();
        try {
            f.writeLines(20);
            f.select(3);
            const changed = vi.fn();
            f.selection.onSelectionChange(changed);
            f.term.clearSelection();
            expect(changed).toHaveBeenCalledOnce();
            f.term.clearSelection();
            expect(changed).toHaveBeenCalledOnce();
            expect(f.term.getSelection()).toBe('');
        } finally { f.dispose(); }
    });
});

describe.each(['alternate', 'region', 'colored-region'] as const)('selection during %s row rotation (#170)', mode => {
    const prepare = () => {
        const f = fixture();
        if (mode === 'alternate') f.term.write('\x1b[?1049h');
        f.writeLines(9);
        if (mode !== 'alternate') f.term.write('\x1b[2;10r\x1b[10;1H');
        // SGR backgrounds take the native copy/clear path instead of eraseRowBounded.
        if (mode === 'colored-region') f.term.write('\x1b[44m');
        return f;
    };

    it('keeps surviving text selected and its highlight on the same row', () => {
        const f = prepare();
        try {
            f.select(4);
            f.writeLines(2);
            expect(f.term.getSelection()).toBe(f.line(4));
            expect(f.selection.getSelectionCoords()).toEqual({ startCol: 0, startRow: 2, endCol: 17, endRow: 2 });
            const copied = vi.fn(async () => {});
            expect(copySelection({ focusedPaneID: () => 'pane', selectionFor: () => f.term.getSelection(), writeText: copied, onError: vi.fn() })).toBe(true);
            expect(copied).toHaveBeenCalledExactlyOnceWith(f.line(4));
            expect(f.vt.getCursor()).toMatchObject({ x: 0, y: 9 });
        } finally { f.dispose(); }
    });

    it.each([false, true])('clears when an endpoint leaves the region and Copy declines (partial=%s)', partial => {
        const f = prepare();
        try {
            f.select(1, partial ? 4 : 1, partial);
            expect(f.term.getSelection()).toContain(f.line(1));
            const changes: string[] = [];
            f.selection.onSelectionChange(() => changes.push(f.term.getSelection()));
            f.writeLines(4);
            expect(f.term.getSelection()).toBe('');
            expect(f.term.hasSelection()).toBe(false);
            expect(f.selection.getSelectionCoords()).toBeNull();
            expect(changes.filter(text => text === '')).toHaveLength(1);
            const copied = vi.fn(async () => {});
            expect(copySelection({ focusedPaneID: () => 'pane', selectionFor: () => f.term.getSelection(), writeText: copied, onError: vi.fn() })).toBe(false);
            expect(copied).not.toHaveBeenCalled();
            expect(f.vt.getCursor()).toMatchObject({ x: 0, y: 9 });
        } finally { f.dispose(); }
    });

    it('stops drag autoscroll and cannot copy replacement text on mouseup', () => {
        vi.useFakeTimers();
        const f = prepare();
        try {
            f.select(1, 4, false, false);
            f.canvas.dispatchEvent(new MouseEvent('mouseleave', { clientY: 210, buttons: 1, shiftKey: true }));
            expect(vi.getTimerCount()).toBe(1);
            f.writeLines(4);
            expect(f.term.getSelection()).toBe('');
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(200);
            f.canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 179, clientY: 90, buttons: 1, shiftKey: true }));
            f.release();
            expect(f.term.hasSelection()).toBe(false);
            expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });
});

describe('selection in native row-copy operations (#170)', () => {
    it.each([
        { control: '\x1b[2;1H\x1b[2M', row: 2 }, // delete two rows above the selection
        { control: '\x1b[2;1H\x1b[2L', row: 6 }, // insert two rows above the selection
        { control: '\x1b[2S', row: 2 },           // explicit scroll up
        { control: '\x1b[2T', row: 6 }            // explicit scroll down
    ])('follows retained text through $control', ({ control, row }) => {
        const f = fixture();
        try {
            f.writeLines(9);
            f.select(4);
            f.term.write(control);
            expect(f.term.getSelection()).toBe(f.line(4));
            expect(f.selection.getSelectionCoords()).toEqual({ startCol: 0, startRow: row, endCol: 17, endRow: row });
        } finally { f.dispose(); }
    });

    it('clears when reverse scrolling discards the bottom endpoint', () => {
        const f = fixture();
        try {
            f.writeLines(9);
            f.select(4, 8);
            const changed = vi.fn();
            f.selection.onSelectionChange(changed);
            f.term.write('\x1b[2T');
            expect(f.term.getSelection()).toBe('');
            expect(f.selection.getSelectionCoords()).toBeNull();
            expect(changed).toHaveBeenCalledOnce();
        } finally { f.dispose(); }
    });

    it.each(['\x1b[2;10r', '\x1b[?69h\x1b[20;60s'])('preserves selections outside the scrolling rectangle (%j)', margins => {
        const f = fixture();
        try {
            f.writeLines(9);
            f.select(0);
            f.term.write(`${margins}\x1b[44m\x1b[2S`);
            expect(f.term.getSelection()).toBe(f.line(0));
            expect(f.selection.getSelectionCoords()).toEqual({ startCol: 0, startRow: 0, endCol: 17, endRow: 0 });
        } finally { f.dispose(); }
    });
});

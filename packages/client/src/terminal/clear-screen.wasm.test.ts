// @vitest-environment node
//
// No DOM: the daemon's emulator is headless and the engine is driven through the wasm's own API,
// as `replay-geometry.wasm.test.ts` does (see its header for why this file opts out of jsdom).

/**
 * ⌘K's clear, through BOTH real emulators: the daemon's and the one a window draws with.
 *
 * The clear is never applied to an engine directly. The daemon reads its own `@xterm/headless`
 * screen, builds an erase and puts it into the pane's OUTPUT stream
 * (`daemon/src/term/clear-screen.ts`), and every client's libghostty-vt parses that stream. So
 * the clear is only correct if the two emulators, fed the same bytes, erase the same things. The
 * daemon's own tests can only see the daemon's half; this file runs the shipped wasm beside it
 * and compares.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createScreenClearer, createTerminalStateService } from '@kelpi/daemon/term';
import { Ghostty, type GhosttyTerminal } from 'ghostty-web';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '..', '..', '..', '..', 'vendor', 'ghostty-web-patched', 'ghostty-vt.wasm');

const PANE = 'pane-clear';
const COLS = 30;
const ROWS = 6;
const encoder = new TextEncoder();

/** Forty numbered lines and a prompt: enough to push most of them into the scrollback. */
const HISTORY = `${Array.from({ length: 40 }, (_, index) => `out ${String(index + 1)}`).join('\r\n')}\r\n$ ls`;

function rowTexts(vt: GhosttyTerminal): string[] {
    return Array.from({ length: vt.rows }, (_, row) =>
        (vt.getLine(row) ?? [])
            .map((cell) => (cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint)))
            .join('')
            .replace(/\s+$/u, '')
    );
}

/** The daemon's viewport, one entry per row, so it lines up with `rowTexts`. */
function captureRows(capture: string, rows: number): string[] {
    const lines = capture.split('\n').map((line) => line.replace(/\s+$/u, ''));
    while (lines.length < rows) lines.push('');
    return lines.slice(0, rows);
}

const engines: GhosttyTerminal[] = [];
afterEach(() => {
    for (const engine of engines.splice(0)) engine.free();
});

/**
 * One pane, two emulators, one stream: everything the daemon would hand its clients is also
 * written into a ghostty engine, in order, exactly as the WS stream delivers it.
 */
async function pane() {
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasmPath)));
    const ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log: () => {} } }), module);
    const client = ghostty.createTerminal(COLS, ROWS);
    engines.push(client);
    const term = createTerminalStateService();
    term.attach(PANE, COLS, ROWS);
    const output = (data: string): void => {
        term.feed(PANE, encoder.encode(data));
        client.write(data);
    };
    const typed: string[] = [];
    const clearAt = (atPrompt: boolean) =>
        createScreenClearer({
            flush: (paneID) => term.flush(paneID),
            screenCursor: (paneID) => term.screenCursor(paneID),
            shellPid: () => 1,
            shellAtPrompt: async () => atPrompt,
            injectOutput: (_paneID, data) => output(data),
            writeInput: (_paneID, data) => typed.push(data)
        })(PANE);
    const daemonRows = async (): Promise<string[]> => captureRows(await term.captureAsync(PANE, { scrollback: false }), ROWS);
    const daemonScrollback = async (): Promise<string> => await term.captureAsync(PANE, { scrollback: true });
    return { term, client, output, typed, clearAt, daemonRows, daemonScrollback };
}

describe('⌘K clears the same screen in the daemon and in the window', () => {
    it('starts from a pane with history in both, so the clears below have something to erase', async () => {
        const p = await pane();
        p.output(HISTORY);
        expect(p.client.getScrollbackLength()).toBeGreaterThan(30);
        expect(await p.daemonScrollback()).toContain('out 1\n');
        expect(rowTexts(p.client)).toEqual(await p.daemonRows());
    });

    it('at a prompt: no scrollback and a blank screen in both, and the shell is sent ⌃L', async () => {
        const p = await pane();
        p.output(HISTORY);

        expect(await p.clearAt(true)).toEqual({ cleared: true });

        expect(p.client.getScrollbackLength()).toBe(0);
        expect(rowTexts(p.client).every((row) => row === '')).toBe(true);
        expect(await p.daemonScrollback()).toBe('');
        expect(p.typed).toEqual(['\x0c']);
        // zsh's answer to ⌃L, which is what lands next: home, clear, the prompt and its buffer.
        p.output('\x1b[H\x1b[2J$ ls');
        expect(rowTexts(p.client)[0]).toBe('$ ls');
        expect(rowTexts(p.client)).toEqual(await p.daemonRows());
        expect(p.client.getScrollbackLength()).toBe(0);
    });

    it('away from a prompt: the cursor row moves to the top, with its cursor, in both', async () => {
        const p = await pane();
        p.output(HISTORY);

        expect(await p.clearAt(false)).toEqual({ cleared: true });

        expect(p.client.getScrollbackLength()).toBe(0);
        expect(rowTexts(p.client)).toEqual(['$ ls', '', '', '', '', '']);
        expect(p.client.getCursor()).toMatchObject({ y: 0, x: 4 });
        expect(rowTexts(p.client)).toEqual(await p.daemonRows());
        expect(p.typed).toEqual([]);
        // And the running program's next write continues its line in both.
        p.output(' -la');
        expect(rowTexts(p.client)[0]).toBe('$ ls -la');
        expect(rowTexts(p.client)).toEqual(await p.daemonRows());
    });

    it('away from a prompt: what a program drew below its cursor moves up with it, in both', async () => {
        const p = await pane();
        p.output(HISTORY);
        p.output('\x1b[4;1H\x1b[J> prompt\x1b[5;1Hstatus\x1b[4;9H');

        await p.clearAt(false);

        expect(rowTexts(p.client)).toEqual(['> prompt', 'status', '', '', '', '']);
        expect(rowTexts(p.client)).toEqual(await p.daemonRows());
        expect(p.client.getCursor()).toMatchObject({ y: 0, x: 8 });
        expect(p.client.getScrollbackLength()).toBe(0);
    });

    it('on the alternate screen: nothing reaches either emulator, and the history survives', async () => {
        const p = await pane();
        p.output(HISTORY);
        const before = p.client.getScrollbackLength();
        p.output('\x1b[?1049h\x1b[Hvim');

        expect(await p.clearAt(true)).toEqual({ cleared: false, reason: 'alternate-screen' });

        expect(p.typed).toEqual([]);
        p.output('\x1b[?1049l');
        expect(p.client.getScrollbackLength()).toBe(before);
        expect(await p.daemonScrollback()).toContain('out 1\n');
    });
});

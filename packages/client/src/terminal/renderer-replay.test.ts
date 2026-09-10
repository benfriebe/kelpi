// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, type GhosttyTerminal } from 'ghostty-web';
import { expect, it } from 'vitest';

import { TerminalStateServiceImpl } from '../../../daemon/src/term/service';
import { createTerminalIngest } from './ingest';
import { createRendererFromLoader, type XtermLikeTerminal } from './renderer';

const encoder = new TextEncoder();
const wasmPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../vendor/ghostty-web-patched/ghostty-vt.wasm'
);

async function createGhostty(withModule = true): Promise<Ghostty> {
    const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasmPath)));
    const instance = await WebAssembly.instantiate(module, { env: { log: () => {} } });
    return new Ghostty(instance, withModule ? module : undefined);
}

/** Run the shipped VT with a DOM-free facade; only canvas and input listeners are omitted. */
function engineTerminal(vt: GhosttyTerminal): XtermLikeTerminal {
    return {
        get cols() {
            return vt.cols;
        },
        get rows() {
            return vt.rows;
        },
        open: () => {},
        write: (data) => vt.write(data),
        reset: () => {
            throw new Error('Replay must use an in-stream reset');
        },
        resize: (cols, rows) => vt.resize(cols, rows),
        dispose: () => vt.free(),
        focus: () => {},
        blur: () => {},
        onData: () => ({ dispose: () => {} })
    };
}

function clientRows(vt: GhosttyTerminal): string[] {
    return Array.from({ length: vt.rows }, (_, row) =>
        (vt.getLine(row) ?? [])
            .map((cell) => (cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint)))
            .join('')
            .trimEnd()
    );
}

/** Compare physical rows: capture() joins soft wraps and would miss shifted/overwritten cells. */
function daemonRows(service: TerminalStateServiceImpl): string[] {
    const panes = (
        service as unknown as {
            panes: Map<
                string,
                {
                    term: {
                        rows: number;
                        buffer: {
                            active: {
                                viewportY: number;
                                getLine(
                                    row: number
                                ): { translateToString(trim: boolean): string } | undefined;
                            };
                        };
                    };
                }
            >;
        }
    ).panes;
    const terminal = panes.get('pane')!.term;
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, row) =>
        (buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').trimEnd()
    );
}

it.each([300, 6000])(
    'keeps %i lines equal to daemon snapshots after repeated pane resizes and Enter',
    async (lines) => {
        const ghostty = await createGhostty();
        const vt = ghostty.createTerminal(50, 18);
        const daemon = new TerminalStateServiceImpl();
        let resets = 0;
        const renderer = createRendererFromLoader(
            'ghostty',
            async () => ({
                terminal: engineTerminal(vt),
                resetForReplay: () => {
                    expect(vt.resetForReplay()).toBe(true);
                    resets += 1;
                },
                setPaintSuspended: () => {}
            }),
            { cols: 50, rows: 18 }
        );
        const scheduled = new Set<() => void>();
        const ingest = createTerminalIngest(renderer, {
            chunkBytes: 4096,
            tickBudgetMs: 0,
            schedule: (run) => {
                scheduled.add(run);
                return () => scheduled.delete(run);
            }
        });
        const finishReplay = (): void => {
            while (scheduled.size > 0) {
                const next = [...scheduled][0]!;
                scheduled.delete(next);
                next();
            }
        };
        const output = async (data: string): Promise<void> => {
            daemon.feed('pane', encoder.encode(data));
            await daemon.flush('pane');
            ingest.live(data);
        };

        try {
            daemon.attach('pane', 50, 18);
            // Long CLI JSON output fills several scrollback pages and wraps at the narrow grid.
            // Resizing those pages before RIS used to append their old contents to later lines.
            const history =
                Array.from(
                    { length: lines },
                    (_, i) => `${i}: provider is available "selectedProviderID": "example.service-lab.git"`
                ).join('\r\n') + '\r\n$ ';
            daemon.feed('pane', encoder.encode(history));
            await daemon.flush('pane');
            ingest.replay(daemon.snapshot('pane').data);
            finishReplay();
            expect(resets).toBe(0);
            // A slow-load attach queues the replay before the engine exists. The engine that
            // flushes it is fresh — its own WASM instance, nothing written — so the queued
            // reset is a no-op rather than a second instance; the resizes below, onto an
            // engine that HAS been written to, take the fresh-storage path every time.
            await renderer.open({ querySelector: () => null } as unknown as HTMLElement);
            await expect.poll(() => clientRows(vt)).toEqual(daemonRows(daemon));
            expect(resets).toBe(0);

            await output('\x1b[?1h\x1b[?2004h');
            for (const [cols, rows] of [
                [120, 40],
                [60, 18],
                [132, 32],
                [50, 18],
                [120, 40]
            ] as const) {
                renderer.resize(cols, rows);
                daemon.resize('pane', cols, rows);
                expect([renderer.cols, renderer.rows]).toEqual([cols, rows]);
                expect([vt.cols, vt.rows]).toEqual([cols, rows]);
                // Input encoding must retain its modes throughout the wait for the replay.
                expect(vt.getMode(1, false)).toBe(true);
                expect(vt.getMode(2004, false)).toBe(true);

                await daemon.flush('pane');
                const resetsBefore = resets;
                ingest.replay(daemon.snapshot('pane').data);
                expect(resets).toBe(resetsBefore + 1);
                expect(renderer.paintHeld).toBe(true);
                while (scheduled.size > 0) {
                    const next = [...scheduled][0]!;
                    scheduled.delete(next);
                    next();
                    expect(renderer.paintHeld).toBe(scheduled.size > 0);
                }
                expect(clientRows(vt)).toEqual(daemonRows(daemon));
                expect(vt.getMode(1, false)).toBe(true);
                expect(vt.getMode(2004, false)).toBe(true);

                // Several subsequent prompts force recycled rows back through the viewport.
                await output('\r\n$ '.repeat(rows + 1));
                expect(clientRows(vt)).toEqual(daemonRows(daemon));
            }
        } finally {
            ingest.pause();
            renderer.dispose();
            daemon.disposeAll();
        }
    }
);

it('keeps configured colours, dimensions, scrollback limit and cached grapheme readers across reset', async () => {
    const ghostty = await createGhostty();
    const vt = ghostty.createTerminal(50, 18, {
        fgColor: 0xabcdef,
        bgColor: 0x123456,
        cursorColor: 0x654321,
        scrollbackLimit: 20000
    });
    try {
        vt.resize(90, 24);
        vt.write('e\u0301');
        vt.getLine(0);
        expect(vt.getGraphemeString(0, 0)).toBe('e\u0301');
        const colours = vt.getColors();
        const history = 'history\r\n'.repeat(300);
        vt.write(history);
        const scrollback = vt.getScrollbackLength();

        expect(vt.resetForReplay()).toBe(true);
        expect([vt.cols, vt.rows]).toEqual([90, 24]);
        expect(clientRows(vt).every((line) => line === '')).toBe(true);
        expect(vt.getColors()).toEqual(colours);
        vt.write('n\u0303');
        vt.getLine(0);
        expect(vt.getGraphemeString(0, 0)).toBe('n\u0303');
        vt.write(history);
        expect(vt.getScrollbackLength()).toBe(scrollback);
    } finally {
        vt.free();
    }
});

it('leaves directly constructed instances intact when no compiled module is available', async () => {
    const ghostty = await createGhostty(false);
    const vt = ghostty.createTerminal(50, 18);
    try {
        vt.write('still here');
        expect(vt.resetForReplay()).toBe(false);
        expect(clientRows(vt)[0]).toBe('still here');
    } finally {
        vt.free();
    }
});

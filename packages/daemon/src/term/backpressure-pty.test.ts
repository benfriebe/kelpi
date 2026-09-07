import { expect, it, vi } from 'vitest';
import headless from '@xterm/headless';
import { createPtyManager } from '../pty/manager.js';
import { createTerminalStateService } from './service.js';

it.skipIf(process.platform === 'win32')('drains sustained real PTY output through pause/resume without losing its tail', async () => {
    const errors = vi.fn();
    const pty = createPtyManager({ onError: errors });
    const flow: boolean[] = [];
    let releaseFirstWrite: () => void = () => {};
    const backlogged = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
    const originalWrite = headless.Terminal.prototype.write;
    // Hold the first completion until read-ahead crosses the threshold. Otherwise a fast
    // parser or slow CI disk can legitimately drain all 56 MiB without ever needing to pause.
    const slowFirstWrite = vi.spyOn(headless.Terminal.prototype, 'write').mockImplementationOnce(function (this: InstanceType<typeof headless.Terminal>, data, done) {
        originalWrite.call(this, data, () => { void backlogged.then(() => done?.()); });
    });
    const term = createTerminalStateService({
        scrollback: 0,
        onError: errors,
        onBackpressure: (paneID, paused) => {
            flow.push(paused);
            if (paused) {
                pty.pauseOutput(paneID);
                releaseFirstWrite();
            } else pty.resumeOutput(paneID);
        }
    });
    let received = 0;
    const unsubscribe = pty.onData((paneID, bytes) => {
        received += bytes.byteLength;
        term.feed(paneID, bytes);
    });
    const exited = new Promise<number>(resolve => pty.onExit((_paneID, code) => resolve(code)));
    try {
        pty.spawn({
            paneID: 'busy', shell: '/bin/sh', cwd: '/tmp', env: [], cols: 80, rows: 24,
            // NULs make volume independent of scrollback and terminal width. dd is present
            // on both supported Unix platforms, and stderr must not pollute the sentinel.
            command: "dd if=/dev/zero bs=1048576 count=56 2>/dev/null; printf 'pty-burst-complete'"
        });
        expect(await exited).toBe(0);
        expect(await term.captureAsync('busy', { scrollback: false })).toContain('pty-burst-complete');
        expect(received).toBe(56 * 1024 * 1024 + 'pty-burst-complete'.length);
        expect(flow).toContain(true);
        expect(flow.at(-1)).toBe(false);
        expect(errors).not.toHaveBeenCalled();
    } finally {
        releaseFirstWrite();
        slowFirstWrite.mockRestore();
        unsubscribe();
        term.disposeAll();
        await pty.killAll();
    }
}, 30_000);

import { expect, it, vi } from 'vitest';
import headless from '@xterm/headless';
import { createTerminalStateService, WRITE_HIGH_WATER_BYTES } from './service.js';

it('replays a burst beyond xterm’s old 50 MB queue limit without rejection or data loss', async () => {
    const onBackpressure = vi.fn();
    const onError = vi.fn();
    const term = createTerminalStateService({ scrollback: 0, onBackpressure, onError });
    const chunk = new Uint8Array(1024 * 1024); // NULs exercise volume without growing scrollback.
    try {
        for (let i = 0; i < 51; i++) term.feed('busy', chunk);
        term.feed('busy', 'burst-complete');
        term.feed('quiet', 'other-pane');
        expect(onBackpressure.mock.calls).toEqual([['busy', true]]);
        expect(await term.captureAsync('quiet', { scrollback: false })).toContain('other-pane');
        expect(await term.captureAsync('busy', { scrollback: false })).toContain('burst-complete');
        expect(onBackpressure.mock.calls).toEqual([['busy', true], ['busy', false]]);
        expect(onError).not.toHaveBeenCalled();
    } finally { term.disposeAll(); }
}, 15_000);

it('settles failed writes, reports them, and can parse subsequent output', async () => {
    const onError = vi.fn();
    const term = createTerminalStateService({ onError });
    const failed = vi.spyOn(headless.Terminal.prototype, 'write').mockImplementationOnce(() => { throw new Error('write failed'); });
    try {
        term.feed('p', 'first');
        await expect(term.flush('p')).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledWith('p', expect.objectContaining({ message: 'write failed' }));
        term.feed('p', 'second');
        expect(await term.captureAsync('p', { scrollback: false })).toContain('second');
    } finally { failed.mockRestore(); term.disposeAll(); }
});

it('unpauses and settles all queued writes when a pane is disposed', async () => {
    const onBackpressure = vi.fn();
    const term = createTerminalStateService({ onBackpressure });
    const blocked = vi.spyOn(headless.Terminal.prototype, 'write').mockImplementation(() => {});
    try {
        term.feed('p', new Uint8Array(WRITE_HIGH_WATER_BYTES));
        term.feed('p', 'queued');
        const flush = term.flush('p');
        term.dispose('p');
        await expect(flush).resolves.toBeUndefined();
        expect(onBackpressure.mock.calls).toEqual([['p', true], ['p', false]]);
    } finally { blocked.mockRestore(); term.disposeAll(); }
});

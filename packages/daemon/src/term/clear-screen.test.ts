import { afterEach, describe, expect, it } from 'vitest';

import { FORM_FEED, clearScreenSequence, createScreenClearer, type ScreenClearerDeps } from './clear-screen.js';
import { TerminalStateServiceImpl } from './service.js';

const encoder = new TextEncoder();
const services: TerminalStateServiceImpl[] = [];

afterEach(() => {
    for (const service of services.splice(0)) service.disposeAll();
});

/** A real headless emulator, 20x5, with `lines` of output already parsed. */
async function paneWith(lines: number): Promise<TerminalStateServiceImpl> {
    const service = new TerminalStateServiceImpl();
    services.push(service);
    service.attach('p', 20, 5);
    const text = Array.from({ length: lines }, (_, index) => `line ${String(index + 1)}`).join('\r\n');
    service.feed('p', encoder.encode(text));
    await service.flush('p');
    return service;
}

/** The clearer over a real emulator, with the output stream feeding that emulator back. */
function clearerFor(service: TerminalStateServiceImpl, overrides: Partial<ScreenClearerDeps> = {}) {
    const typed: string[] = [];
    const clear = createScreenClearer({
        flush: (paneID) => service.flush(paneID),
        screenCursor: (paneID) => service.screenCursor(paneID),
        shellPid: () => 4242,
        shellAtPrompt: async () => true,
        injectOutput: (paneID, data) => service.feed(paneID, encoder.encode(data)),
        writeInput: (_paneID, data) => typed.push(data),
        ...overrides
    });
    return { clear, typed };
}

describe('clearScreenSequence', () => {
    it('sends nothing on the alternate screen, prompt or not', () => {
        expect(clearScreenSequence({ alternate: true, row: 3, col: 2 }, true)).toBeNull();
        expect(clearScreenSequence({ alternate: true, row: 3, col: 2 }, false)).toBeNull();
    });

    it('erases the screen, then the scrollback, at a prompt', () => {
        expect(clearScreenSequence({ alternate: false, row: 3, col: 2 }, true)).toBe('\x1b[H\x1b[2J\x1b[3J');
    });

    it('removes the rows above the cursor and takes the cursor up with its row, away from a prompt', () => {
        expect(clearScreenSequence({ alternate: false, row: 3, col: 2 }, false)).toBe('\x1b[3S\x1b[3A\x1b[3J');
    });

    it('has only the scrollback to erase with the cursor on the top row', () => {
        expect(clearScreenSequence({ alternate: false, row: 0, col: 7 }, false)).toBe('\x1b[3J');
    });
});

describe('createScreenClearer, on a real emulator', () => {
    it('at a prompt: empties screen and scrollback, then sends the shell a form feed', async () => {
        const service = await paneWith(12);
        expect(service.capture('p', { scrollback: true })).toContain('line 1');
        const { clear, typed } = clearerFor(service);

        expect(await clear('p')).toEqual({ cleared: true });
        await service.flush('p');

        expect(service.capture('p', { scrollback: true })).toBe('');
        expect(typed).toEqual([FORM_FEED]);
    });

    it('away from a prompt: drops everything above the cursor row, which moves to the top with its cursor', async () => {
        const service = await paneWith(12);
        const { clear, typed } = clearerFor(service, { shellAtPrompt: async () => false });

        expect(await clear('p')).toEqual({ cleared: true });
        await service.flush('p');

        // The cursor sat at the end of "line 12" on the bottom row. That row is the top row now,
        // the cursor is still at its end, and the program's next write continues that line.
        expect(service.capture('p', { scrollback: true })).toBe('line 12');
        expect(service.screenCursor('p')).toEqual({ alternate: false, row: 0, col: 7 });
        service.feed('p', encoder.encode('!'));
        await service.flush('p');
        expect(service.capture('p', { scrollback: false }).split('\n').at(-1)).toBe('line 12!');
        expect(typed).toEqual([]);
    });

    it('keeps what a running program drew below its cursor, moved up with the cursor row', async () => {
        const service = await paneWith(12);
        // An agent's frame: the cursor parked on the input row, a status line drawn under it.
        service.feed('p', encoder.encode('\x1b[4;1H\x1b[J> prompt\x1b[5;1Hstatus\x1b[4;9H'));
        await service.flush('p');
        const { clear } = clearerFor(service, { shellAtPrompt: async () => false });

        await clear('p');
        await service.flush('p');

        expect(service.capture('p', { scrollback: true })).toBe('> prompt\nstatus');
        expect(service.screenCursor('p')).toEqual({ alternate: false, row: 0, col: 8 });
    });

    it('asks nothing of a pane with no shell to ask about, and types nothing at it', async () => {
        const service = await paneWith(3);
        const asked: number[] = [];
        const { clear, typed } = clearerFor(service, {
            shellPid: () => undefined,
            shellAtPrompt: async (pid) => {
                asked.push(pid);
                return true;
            }
        });

        expect(await clear('p')).toEqual({ cleared: true });
        expect(asked).toEqual([]);
        expect(typed).toEqual([]);
    });

    it('leaves a full-screen app alone', async () => {
        const service = await paneWith(12);
        service.feed('p', encoder.encode('\x1b[?1049h\x1b[Hvim'));
        await service.flush('p');
        const injected: string[] = [];
        const { clear, typed } = clearerFor(service, { injectOutput: (_paneID, data) => injected.push(data) });

        expect(await clear('p')).toEqual({ cleared: false, reason: 'alternate-screen' });
        expect(injected).toEqual([]);
        expect(typed).toEqual([]);
    });

    it('reads the cursor only after output fed moments ago has been parsed', async () => {
        const service = await paneWith(2);
        // Not flushed: the clear must wait for it, or it would restore a stale cursor.
        service.feed('p', encoder.encode('\r\nline 3\r\nline 4'));
        const { clear } = clearerFor(service, { shellAtPrompt: async () => false });

        await clear('p');
        await service.flush('p');

        expect(service.capture('p', { scrollback: true })).toBe('line 4');
    });

    it('answers no-terminal for a pane the emulator does not have', async () => {
        const service = await paneWith(1);
        const { clear } = clearerFor(service);

        expect(await clear('other')).toEqual({ cleared: false, reason: 'no-terminal' });
    });
});

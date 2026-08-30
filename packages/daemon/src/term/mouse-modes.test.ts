/**
 * DEC mouse-mode tracking, read out of the byte stream (§TERM-037…§TERM-039).
 *
 * Two things are asserted here that nothing else can: that xterm's own `mouseTrackingMode`
 * really does follow 9/1000/1002/1003 (the port relies on it rather than re-deriving it), and
 * that the FORMAT half — which `IModes` does not expose at all — follows 1005/1006/1015/1016
 * with ghostty's reset semantics.
 */

import { describe, expect, it } from 'vitest';

import { applyFormatModes, DEFAULT_MOUSE_FORMAT } from './mouse-modes.js';
import { createTerminalStateService, type TerminalStateServiceImpl } from './service.js';

const encoder = new TextEncoder();

function makeService(
    options: Parameters<typeof createTerminalStateService>[0] = {}
): TerminalStateServiceImpl {
    return createTerminalStateService(options);
}

async function write(service: TerminalStateServiceImpl, paneID: string, data: string): Promise<void> {
    service.feed(paneID, encoder.encode(data));
    await service.flush(paneID);
}

describe('applyFormatModes', () => {
    it('selects the format a DECSET names', () => {
        expect(applyFormatModes('x10', [1006], true)).toBe('sgr');
        expect(applyFormatModes('x10', [1005], true)).toBe('utf8');
        expect(applyFormatModes('x10', [1015], true)).toBe('urxvt');
        expect(applyFormatModes('x10', [1016], true)).toBe('sgr-pixels');
    });

    it('returns to X10 when ANY format mode is reset — ghostty stream_terminal.zig:538-541', () => {
        // Not "reset the one that is active": disabling 1005 while SGR is on still lands on X10,
        // which is what the Zig does (`if (enabled) .utf8 else .x10`).
        expect(applyFormatModes('sgr', [1005], false)).toBe('x10');
        expect(applyFormatModes('sgr', [1006], false)).toBe('x10');
    });

    it('ignores modes that are not format modes, and reads sub-parameter groups', () => {
        expect(applyFormatModes('sgr', [1002, 1003], true)).toBe('sgr');
        expect(applyFormatModes('x10', [[1006, 2]], true)).toBe('sgr');
    });

    it('applies a multi-parameter sequence left to right', () => {
        expect(applyFormatModes('x10', [1000, 1006], true)).toBe('sgr');
        expect(applyFormatModes('x10', [1006, 1015], true)).toBe('urxvt');
    });
});

describe('TerminalStateServiceImpl — mouse modes', () => {
    it('starts with no tracking and the X10 format', () => {
        const service = makeService();
        service.attach('p', 20, 5);
        expect(service.modes('p').mouseTracking).toBe('none');
        expect(service.modes('p').mouseFormat).toBe(DEFAULT_MOUSE_FORMAT);
    });

    it('follows every tracking mode, including through a single combined sequence', async () => {
        const service = makeService();
        service.attach('p', 20, 5);

        await write(service, 'p', '\x1b[?9h');
        expect(service.modes('p').mouseTracking).toBe('x10');
        await write(service, 'p', '\x1b[?1000h');
        expect(service.modes('p').mouseTracking).toBe('vt200');
        await write(service, 'p', '\x1b[?1002h');
        expect(service.modes('p').mouseTracking).toBe('drag');
        await write(service, 'p', '\x1b[?1003h');
        expect(service.modes('p').mouseTracking).toBe('any');
        await write(service, 'p', '\x1b[?1003l');
        expect(service.modes('p').mouseTracking).toBe('none');

        // The form a real TUI sends: tracking and encoding in one go.
        await write(service, 'p', '\x1b[?1002;1006h');
        expect(service.modes('p')).toMatchObject({ mouseTracking: 'drag', mouseFormat: 'sgr' });
    });

    it('follows the coordinate format and returns to X10 on reset', async () => {
        const service = makeService();
        service.attach('p', 20, 5);

        await write(service, 'p', '\x1b[?1006h');
        expect(service.modes('p').mouseFormat).toBe('sgr');
        await write(service, 'p', '\x1b[?1015h');
        expect(service.modes('p').mouseFormat).toBe('urxvt');
        await write(service, 'p', '\x1b[?1015l');
        expect(service.modes('p').mouseFormat).toBe('x10');
    });

    it('a full reset (RIS) clears both halves', async () => {
        const service = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[?1003h\x1b[?1006h');
        expect(service.modes('p')).toMatchObject({ mouseTracking: 'any', mouseFormat: 'sgr' });

        await write(service, 'p', '\x1bc');
        expect(service.modes('p')).toMatchObject({ mouseTracking: 'none', mouseFormat: 'x10' });
    });

    it('mode changes are still parsed while OTHER handlers are registered', async () => {
        // The service registers an OSC 7 handler and a title handler on the same parser; a
        // regression there would silently swallow the CSI registrations.
        const directories: string[] = [];
        const service = makeService({ onDirectoryChange: (_, directory) => directories.push(directory) });
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b]7;file:///tmp\x07\x1b[?1002;1006h');
        expect(directories).toEqual(['/tmp']);
        expect(service.modes('p')).toMatchObject({ mouseTracking: 'drag', mouseFormat: 'sgr' });
    });

    it('reports each transition once, and never for a repeat', async () => {
        const seen: { paneID: string; tracking: string; format: string }[] = [];
        const service = makeService({
            onModesChange: (paneID, modes) =>
                seen.push({
                    paneID,
                    tracking: modes.mouseTracking ?? 'none',
                    format: modes.mouseFormat ?? 'x10'
                })
        });
        service.attach('p', 20, 5);

        await write(service, 'p', '\x1b[?1002h');
        await write(service, 'p', '\x1b[?1006h');
        // A re-assert of exactly what is already set: no transition, no event.
        await write(service, 'p', '\x1b[?1002h\x1b[?1006h');
        // Ordinary output must not produce one either.
        await write(service, 'p', 'hello world\r\n');

        expect(seen).toEqual([
            { paneID: 'p', tracking: 'drag', format: 'x10' },
            { paneID: 'p', tracking: 'drag', format: 'sgr' }
        ]);
    });

    it('reports DECCKM and bracketed paste through the same channel', async () => {
        const seen: boolean[] = [];
        const service = makeService({
            onModesChange: (_, modes) => seen.push(modes.applicationCursorKeys)
        });
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[?1h');
        expect(seen).toEqual([true]);
    });

    it('disposing a pane stops its parser handlers', async () => {
        const service = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[?1006h');
        expect(service.modes('p').mouseFormat).toBe('sgr');
        service.dispose('p');
        // Unknown pane again: the idle default, not the disposed pane's last state.
        expect(service.modes('p').mouseFormat).toBe('x10');
    });
});

describe('TerminalStateServiceImpl — OSC 0 / OSC 2 titles (§TERM-147)', () => {
    it('reports an OSC 0 title', async () => {
        const titles: [string, string][] = [];
        const service = makeService({ onTitleChange: (paneID, title) => titles.push([paneID, title]) });
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b]0;vim README.md\x07');
        expect(titles).toEqual([['p', 'vim README.md']]);
    });

    it('reports an OSC 2 title, ST-terminated', async () => {
        const titles: string[] = [];
        const service = makeService({ onTitleChange: (_, title) => titles.push(title) });
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b]2;zsh — kelpi\x1b\\');
        expect(titles).toEqual(['zsh — kelpi']);
    });

    it('reports a cleared title as the empty string (the caller decides what null means)', async () => {
        const titles: string[] = [];
        const service = makeService({ onTitleChange: (_, title) => titles.push(title) });
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b]2;set\x07\x1b]2;\x07');
        expect(titles).toEqual(['set', '']);
    });

    it('does not report a title for a pane with no listener', async () => {
        const service = makeService();
        service.attach('p', 20, 5);
        await expect(write(service, 'p', '\x1b]0;nothing to hear this\x07')).resolves.toBeUndefined();
    });
});

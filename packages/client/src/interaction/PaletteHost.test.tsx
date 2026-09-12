/**
 * The bundled palette adapter: session in, `CommandPaletteProps` out, an id back.
 *
 * Driven through a REAL surface with a fake source, because the three things worth pinning are
 * all interactions between the two: the query round trip, the single activation, and the exit
 * window the session's empty universe would otherwise blank out.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInteractionSurface, type InteractionSurface } from './surface';
import type { InteractionPaletteItem, InteractionPaletteSource } from './contract';
import { PaletteHost } from './PaletteHost';

const OWNER = { id: 'native:test', kind: 'native', displayName: 'Command Palette' } as const;

const ITEMS: readonly InteractionPaletteItem[] = [
    { id: 'ws:one', kind: 'workspace', icon: 'rectangle.stack', title: 'Notes', subtitle: '1 pane',
        workspaceID: 'one', workspaceName: 'Notes', paneID: null, workspaceColor: 'blue' },
    { id: 'cmd:new-scratchpad', kind: 'command', icon: 'note', title: 'New Scratchpad', subtitle: 'a note pane',
        workspaceID: null, workspaceName: '', paneID: null, workspaceColor: null }
];

function fixture(execute: InteractionPaletteSource['execute'] = vi.fn(async () => {})) {
    const source: InteractionPaletteSource = { subscribe: () => () => {}, snapshot: () => ({ items: ITEMS }), execute };
    const surface: InteractionSurface = createInteractionSurface({ focus: {
        fallbackPaneID: () => 'pane-fallback', handBackCaret: vi.fn(), paneHandoff: vi.fn(), handoffDelayMs: 0
    } });
    surface.palette.setSource(source);
    const view = render(<PaletteHost surface={surface} />);
    return { surface, source, view, execute };
}

const field = (): HTMLElement => screen.getByLabelText('Jump to workspace or pane');

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('bundled palette adapter', () => {
    it('paints nothing until the session opens, then the session universe', () => {
        const h = fixture();
        expect(screen.queryByTestId('command-palette')).toBeNull();
        act(() => { h.surface.palette.open(OWNER); });
        expect(screen.getAllByTestId('palette-row').map((row) => row.textContent)).toEqual([
            expect.stringContaining('Notes'), expect.stringContaining('New Scratchpad')
        ]);
    });

    it('routes typing to the session and confirms through activate, exactly once', async () => {
        const h = fixture();
        act(() => { h.surface.palette.open(OWNER); });
        const id = h.surface.palette.getSnapshot().sessionID;
        expect(id).not.toBeNull();

        fireEvent.change(field(), { target: { value: 'scratch' } });
        expect(h.surface.palette.getSnapshot().query).toBe('scratch');
        expect(screen.getAllByTestId('palette-row')).toHaveLength(1);

        await act(async () => { fireEvent.click(screen.getByTestId('palette-row')); });
        expect(h.execute).toHaveBeenCalledExactlyOnceWith('cmd:new-scratchpad', { workspaceID: null, paneID: null });
        // Activation is what closes the session; the adapter never writes the open bit itself.
        expect(h.surface.palette.getSnapshot().open).toBe(false);
        expect(h.surface.palette.getSnapshot().sessionID).toBeNull();
    });

    it('keeps the last universe on screen through the exit animation', () => {
        const h = fixture();
        act(() => { h.surface.palette.open(OWNER); });
        act(() => { fireEvent.keyDown(field(), { key: 'Escape' }); });
        // §H19: the panel is still mounted and playing its 150 ms exit. The session's universe is
        // empty by now, so without the adapter's hold the list would blank out mid-fade.
        expect(h.surface.palette.getSnapshot().items).toHaveLength(0);
        expect(screen.getAllByTestId('palette-row')).toHaveLength(2);
    });

    it('reports a refused activation through the surface without an unhandled rejection', async () => {
        const failures: string[] = [];
        const source: InteractionPaletteSource = {
            subscribe: () => () => {}, snapshot: () => ({ items: ITEMS }),
            execute: vi.fn(async () => { throw new Error('Palette command is no longer available.'); })
        };
        const surface = createInteractionSurface({ reportFailure: (_label, detail) => failures.push(detail) });
        surface.palette.setSource(source);
        render(<PaletteHost surface={surface} />);
        act(() => { surface.palette.open(OWNER); });
        await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
        expect(failures).toEqual(['Palette command is no longer available.']);
    });
});

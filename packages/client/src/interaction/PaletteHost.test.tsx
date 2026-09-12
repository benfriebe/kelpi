/**
 * The bundled palette adapter: session in, `CommandPaletteProps` out, an id back.
 *
 * Driven through a REAL surface with a fake source, because the three things worth pinning are
 * all interactions between the two: the query round trip, the single activation, and the exit
 * window the session's empty universe would otherwise blank out.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodePluginManifest } from '@kelpi/protocol';
import { modalPresenceCount, registerModal } from '../chrome/modal-presence';
import type { KelpiRuntime } from '../state';
import { BUNDLED_VIEWS, resolveSidebarViews, type ViewContribution } from '../plugins/registry';
import { WorkbenchProvider } from '../plugins/Workbench';
import { createInteractionSurface, type InteractionSurface } from './surface';
import type { InteractionPaletteItem, InteractionPaletteSource } from './contract';
import { resetInteractionPresenterFailures, type InteractionPresenterHost, type InteractionPresenterSnapshot } from './presenter';
import { PaletteHost } from './PaletteHost';

/** The mounted presenter, standing in for the isolated view (see `InteractionHost.test.tsx`). */
interface MountedPresenter {
    viewID: string;
    visible?: boolean | undefined;
    focused?: boolean | undefined;
    presenter?: InteractionPresenterHost | undefined;
    onError?: ((message: string) => void) | undefined;
    frames: InteractionPresenterSnapshot[];
}
const view: { current: MountedPresenter | null } = { current: null };

vi.mock('../plugins/PluginView', () => ({
    PluginView: (props: MountedPresenter): ReactElement => {
        const frames = view.current?.frames ?? [];
        view.current = { ...props, frames };
        useEffect(() => props.presenter?.subscribe(value => { frames.push(value); }), [props.presenter]);
        return <div data-testid={`plugin-view-${props.viewID}`}><iframe title="presenter frame" /></div>;
    }
}));

const PRESENTER_VIEW = 'sample.present.view';
const PRESENTER: ViewContribution = {
    ...decodePluginManifest({ id: 'sample.present', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        views: [{ id: PRESENTER_VIEW, title: 'Lab presenter', entry: 'ui/index.html', placements: ['interaction.palette'] }]
    } }).contributes.views[0]!,
    pluginID: 'sample.present'
};
const runtime = { connection: { status: 'connected', on: () => () => {} } } as unknown as KelpiRuntime;

function Selected({ children }: { children: ReactNode }): ReactElement {
    const views = [...BUNDLED_VIEWS, PRESENTER];
    const selections = { 'interaction.palette': PRESENTER_VIEW } as const;
    return <WorkbenchProvider runtime={runtime} chords={[]} layout={{
        views, selections, activeTabs: {}, sidebars: resolveSidebarViews(views, selections),
        select: () => {}, activateTab: () => {}
    }}>{children}</WorkbenchProvider>;
}

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

const releases: Array<() => void> = [];
afterEach(() => {
    for (const release of releases.splice(0)) release();
    cleanup();
    resetInteractionPresenterFailures();
    view.current = null;
    vi.restoreAllMocks();
    expect(modalPresenceCount()).toBe(0);
});

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

describe('a selected palette presenter', () => {
    function fixture(items: readonly InteractionPaletteItem[] = ITEMS) {
        const source: InteractionPaletteSource = { subscribe: () => () => {}, snapshot: () => ({ items }), execute: vi.fn(async () => {}) };
        const paneHandoff = vi.fn();
        const failures: string[] = [];
        const surface = createInteractionSurface({
            focus: { fallbackPaneID: () => 'pane-fallback', handBackCaret: vi.fn(), paneHandoff, handoffDelayMs: 0 },
            reportFailure: (_label, detail) => failures.push(detail)
        });
        surface.palette.setSource(source);
        render(<Selected><PaletteHost surface={surface} presenters chords={['0/Escape']} /></Selected>);
        return { surface, paneHandoff, failures };
    }

    it('stays mounted and non-interactive until the session opens, then takes the content box', async () => {
        const h = fixture();
        // Attaching the frame on ⌘P would put a lease request and a 10 s readiness window in front
        // of the window's most-used gesture, so it is mounted from the start - just not painted.
        const wrapper = screen.getByTestId('interaction-presenter-palette');
        expect(wrapper.dataset['interactionPresenter']).toBe(PRESENTER_VIEW);
        expect(wrapper.hidden).toBe(true);
        expect(wrapper.style.display).toBe('none');
        expect(wrapper.className).toContain('absolute inset-0');
        expect(view.current).toMatchObject({ visible: false, focused: false });
        // The bundled card is not in the tree at all while a presenter is drawing.
        expect(screen.queryByTestId('palette-backdrop')).toBeNull();

        await act(async () => { h.surface.palette.open(OWNER); });
        expect(screen.getByTestId('interaction-presenter-palette').hidden).toBe(false);
        expect(view.current).toMatchObject({ visible: true, focused: true });
        expect(view.current!.frames.at(-1)!.palette!.items.map(item => item.id)).toEqual(['ws:one', 'cmd:new-scratchpad']);
        expect(view.current!.frames.at(-1)!.prompt).toBeNull();
    });

    it('hands the palette back to the bundled card when the presenter fails, and reopens into it', async () => {
        const h = fixture();
        act(() => { h.surface.palette.open(OWNER); });
        act(() => { view.current!.onError!('the presenter went away'); });

        // §2.7: the palette arm dismisses its own session, activates nothing, and still hands the
        // caret back - the user is left in the window, not in a dead overlay.
        expect(h.surface.palette.getSnapshot()).toMatchObject({ open: false, sessionID: null });
        expect(h.surface.hasPendingPaneHandoff()).toBe(true);
        await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); });
        expect(h.paneHandoff).toHaveBeenCalledWith('pane-fallback');
        expect(h.failures).toEqual(['the presenter went away']);
        expect(screen.queryByTestId(`plugin-view-${PRESENTER_VIEW}`)).toBeNull();
        expect(screen.getByTestId('interaction-presenter-palette').dataset['interactionPresenter']).toBe('bundled');

        // ⌘P again: the latch holds for the window session, so the bundled card takes it.
        act(() => { h.surface.palette.open(OWNER); });
        expect(screen.getByTestId('command-palette')).toBeDefined();
        expect(screen.getAllByTestId('palette-row')).toHaveLength(2);
    });
});

describe('the palette presenter’s host guarantees', () => {
    function fixture(items: readonly InteractionPaletteItem[] = ITEMS) {
        const source: InteractionPaletteSource = { subscribe: () => () => {}, snapshot: () => ({ items }), execute: vi.fn(async () => {}) };
        const failures: string[] = [];
        const surface = createInteractionSurface({
            focus: { fallbackPaneID: () => 'pane-fallback', handBackCaret: vi.fn(), paneHandoff: vi.fn(), handoffDelayMs: 0 },
            reportFailure: (_label, detail) => failures.push(detail)
        });
        surface.palette.setSource(source);
        render(<Selected><PaletteHost surface={surface} presenters chords={['0/Escape']} /></Selected>);
        return { surface, failures };
    }

    it('cancels on Escape, which the bundled card would otherwise have answered inside itself', () => {
        const h = fixture();
        act(() => { h.surface.palette.open(OWNER); });
        expect(screen.getByTestId('interaction-presenter-palette').hidden).toBe(false);

        // The relay re-dispatches the granted chord on the owner window. Without a host listener for
        // the palette (unlike a prompt, whose Escape `InteractionHost` owns) this session would have
        // no keyboard cancel at all once a presenter is drawing it.
        fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
        expect(h.surface.palette.getSnapshot().open).toBe(true);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(h.surface.palette.getSnapshot()).toMatchObject({ open: false, sessionID: null });
    });

    it('stops containing focus while a modal peer holds the window', () => {
        const outside = document.createElement('button');
        document.body.append(outside);
        const h = fixture();
        act(() => { h.surface.palette.open(OWNER); });
        const frame = screen.getByTitle('presenter frame');
        const focusFrame = vi.spyOn(frame, 'focus');

        // A palette may be opened OVER Settings or Help - that is how those pages stay recoverable -
        // so a presenter drawing it must not drag the caret back out of the page behind it.
        act(() => { releases.push(registerModal()); });
        act(() => { outside.focus(); outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
        expect(focusFrame).not.toHaveBeenCalled();

        act(() => { for (const release of releases.splice(0)) release(); });
        act(() => { outside.focus(); outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
        expect(focusFrame).toHaveBeenCalled();
    });

    it('hands the palette to the bundled card when a frame cannot be delivered at all', async () => {
        const big = 'x'.repeat(2048);
        const h = fixture(Array.from({ length: 200 }, (_, index) => ({
            id: `cmd:${String(index)}`, kind: 'command' as const, icon: 'terminal', title: big, subtitle: big,
            workspaceID: null, workspaceName: '', paneID: null, workspaceColor: null
        })));
        await act(async () => { h.surface.palette.open(OWNER); });

        // An oversized frame is not something a watchdog can rescue: the placement fails at once and
        // the bundled card takes the session's own universe back.
        expect(h.failures).toEqual(['Window interaction snapshot is invalid or exceeds 256 KiB.']);
        expect(screen.queryByTestId(`plugin-view-${PRESENTER_VIEW}`)).toBeNull();
        expect(screen.getByTestId('interaction-presenter-palette').dataset['interactionPresenter']).toBe('bundled');
        act(() => { h.surface.palette.open(OWNER); });
        expect(screen.getAllByTestId('palette-row')).toHaveLength(200);
    });
});

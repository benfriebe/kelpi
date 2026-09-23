/**
 * The root arrangement inside the workbench: hidden bands, declared band heights, the persisted
 * store and its Settings row. The model itself is `arrangement.test.ts`; the assembly's routes onto
 * it (chord, menu, strip, report) are `App.arrangement.test.tsx`.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { PlacementSettings, WorkbenchProvider, WorkbenchSlot, useWorkbenchLayout, type ArrangedWorkbenchLayout } from './Workbench';
import { DEFAULT_ARRANGEMENT, setBandVisible, toggleZenMode, type RootArrangement } from './arrangement';

let plugins: readonly PluginInfo[] = [];
let daemonID: string | null = 'arrangement-daemon';
vi.mock('./client', () => ({ usePlugins: () => ({ plugins, daemonID }) }));
vi.mock('./PluginView', () => ({ PluginView: (props: { viewID: string; visible?: boolean }) =>
    <div data-testid={props.viewID} data-visible={String(props.visible)} /> }));

const runtime = { connection: { target: 'ws://local.test/ws' } } as KelpiRuntime;
function bands(bandHeights?: Record<string, number>): PluginInfo {
    return { manifest: decodePluginManifest({ id: 'sample.bands', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: { views: [
        { id: 'sample.bands.bar', title: 'Bar', entry: 'ui/index.html', placements: ['topbar', 'statusbar', 'panel.bottom'], ...(bandHeights ? { bandHeights } : {}) }
    ] } }), enabled: true, status: 'inactive', error: null, revision: 'r', instanceID: 'i' };
}

let layout: ArrangedWorkbenchLayout | null = null;
function Harness(): React.JSX.Element {
    const current = useWorkbenchLayout(runtime);
    layout = current;
    return <WorkbenchProvider layout={current} runtime={runtime} chords={[]}>
        <PlacementSettings />
        <WorkbenchSlot placement="topbar">{() => <div data-testid="native-topbar" />}</WorkbenchSlot>
        <WorkbenchSlot placement="panel.bottom" />
        <WorkbenchSlot placement="statusbar">{() => <div data-testid="native-statusbar" />}</WorkbenchSlot>
    </WorkbenchProvider>;
}
const arrange = (update: (current: RootArrangement) => RootArrangement): void => { act(() => layout!.arrange(update)); };
const slot = (placement: string): HTMLElement => document.querySelector<HTMLElement>(`[data-workbench-slot="${placement}"]`)!;
const select = (placement: string, viewID: string): void => { fireEvent.change(screen.getByLabelText(placement), { target: { value: viewID } }); };

beforeEach(() => { localStorage.clear(); daemonID = 'arrangement-daemon'; plugins = [bands()]; layout = null; });
afterEach(cleanup);

describe('hidden root bands', () => {
    it('stops drawing a hidden bundled bar and draws it again, selection untouched', () => {
        render(<Harness />);
        expect(screen.getByTestId('native-topbar')).toBeDefined();
        arrange(current => setBandVisible(current, 'topbar', false));
        expect(screen.queryByTestId('native-topbar')).toBeNull();
        expect(screen.getByTestId('native-statusbar')).toBeDefined();
        arrange(current => setBandVisible(current, 'topbar', true));
        expect(screen.getByTestId('native-topbar')).toBeDefined();
    });

    it('keeps a hidden plugin view mounted, display none and told it is not visible, as a hidden tab is', () => {
        render(<Harness />);
        select('statusbar', 'sample.bands.bar');
        const view = (): HTMLElement => slot('statusbar').querySelector<HTMLElement>('[data-testid="sample.bands.bar"]')!;
        const before = view();
        expect(before.getAttribute('data-visible')).toBe('true');
        arrange(current => setBandVisible(current, 'statusbar', false));
        expect(slot('statusbar').style.display).toBe('none');
        expect(slot('statusbar').getAttribute('data-band-hidden')).toBe('true');
        expect(view()).toBe(before);
        expect(view().getAttribute('data-visible')).toBe('false');
        // Hiding is not a selection: the saved choice is exactly what it was.
        expect(JSON.parse(localStorage.getItem('kelpi.workbench.v1:arrangement-daemon')!)).toEqual({ statusbar: 'sample.bands.bar' });
        arrange(current => setBandVisible(current, 'statusbar', true));
        expect(slot('statusbar').style.display).toBe('');
        expect(view().getAttribute('data-visible')).toBe('true');
    });

    it('marks hidden bands in Settings, says what is hidden, and resets from there', () => {
        render(<Harness />);
        const status = (): string => screen.getByTestId('window-arrangement-status').textContent ?? '';
        expect(status()).toBe('Window arrangement: every band shown');
        arrange(current => setBandVisible(setBandVisible(current, 'topbar', false), 'panel.bottom', false));
        expect(status()).toBe('Window arrangement: toolbar hidden, bottom panel hidden');
        expect(screen.getByLabelText('topbar').closest('label')!.textContent).toContain('topbar (hidden)');
        expect(screen.getByLabelText('statusbar').closest('label')!.textContent).not.toContain('(hidden)');
        arrange(toggleZenMode);
        expect(status()).toBe('Window arrangement: Zen Mode');
        fireEvent.click(screen.getByTestId('reset-window-arrangement'));
        expect(layout!.arrangement).toEqual(DEFAULT_ARRANGEMENT);
        expect(status()).toBe('Window arrangement: every band shown');
    });
});

describe('declared band heights', () => {
    it('applies the manifest’s heights to a plugin view, holds the bottom panel to half the window, and keeps the bundled bars as they are', () => {
        plugins = [bands({ topbar: 36, statusbar: 22, 'panel.bottom': 180 })];
        render(<Harness />);
        for (const placement of ['topbar', 'statusbar', 'panel.bottom']) select(placement, 'sample.bands.bar');
        expect(slot('topbar').style.height).toBe('36px');
        expect(slot('statusbar').style.height).toBe('22px');
        expect(slot('panel.bottom').style.height).toBe('180px');
        expect(slot('panel.bottom').style.maxHeight).toBe('50vh');
        expect(slot('topbar').style.maxHeight).toBe('');
    });

    it('keeps each band’s long-standing height when nothing is declared', () => {
        render(<Harness />);
        for (const placement of ['topbar', 'statusbar', 'panel.bottom']) select(placement, 'sample.bands.bar');
        expect([slot('topbar').style.height, slot('statusbar').style.height, slot('panel.bottom').style.height]).toEqual(['44px', '32px', '220px']);
    });
});

describe('the persisted arrangement', () => {
    it('saves beside the selections, and mirrors to the address key read before the daemon is known', () => {
        render(<Harness />);
        arrange(toggleZenMode);
        const saved = JSON.parse(localStorage.getItem('kelpi.workbench.layout.v1:arrangement-daemon')!);
        expect(saved).toEqual(toggleZenMode(DEFAULT_ARRANGEMENT));
        expect(JSON.parse(localStorage.getItem('kelpi.workbench.layout.v1:local.test')!)).toEqual(saved);
        cleanup();
        // A window opened before the daemon's identity arrives starts from the mirror, so a Zen Mode
        // launch never draws its toolbar and then takes it away.
        daemonID = null;
        render(<Harness />);
        expect(layout!.arrangement).toEqual(toggleZenMode(DEFAULT_ARRANGEMENT));
        expect(screen.queryByTestId('native-topbar')).toBeNull();
    });

    it('carries a change made before the daemon’s identity arrived over to the daemon’s key', () => {
        // The daemon's key holds an older arrangement; this window has not learned the identity yet.
        localStorage.setItem('kelpi.workbench.layout.v1:arrangement-daemon', JSON.stringify(DEFAULT_ARRANGEMENT));
        daemonID = null;
        const view = render(<Harness />);
        arrange(toggleZenMode);
        daemonID = 'arrangement-daemon';
        view.rerender(<Harness />);
        // Zen Mode survives the identity arriving, and both keys now agree on it.
        expect(layout!.arrangement).toEqual(toggleZenMode(DEFAULT_ARRANGEMENT));
        expect(JSON.parse(localStorage.getItem('kelpi.workbench.layout.v1:arrangement-daemon')!)).toEqual(toggleZenMode(DEFAULT_ARRANGEMENT));
        expect(JSON.parse(localStorage.getItem('kelpi.workbench.layout.v1:local.test')!)).toEqual(toggleZenMode(DEFAULT_ARRANGEMENT));
    });

    it('reads the daemon’s saved arrangement when the identity arrives and nothing changed before it', () => {
        localStorage.setItem('kelpi.workbench.layout.v1:arrangement-daemon', JSON.stringify(toggleZenMode(DEFAULT_ARRANGEMENT)));
        daemonID = null;
        const view = render(<Harness />);
        expect(layout!.arrangement).toEqual(DEFAULT_ARRANGEMENT);
        daemonID = 'arrangement-daemon';
        view.rerender(<Harness />);
        expect(layout!.arrangement).toEqual(toggleZenMode(DEFAULT_ARRANGEMENT));
    });

    it('is not live-synced: another window writing the store leaves this one as it is', () => {
        render(<Harness />);
        const other = JSON.stringify(toggleZenMode(DEFAULT_ARRANGEMENT));
        act(() => {
            localStorage.setItem('kelpi.workbench.layout.v1:arrangement-daemon', other);
            window.dispatchEvent(new StorageEvent('storage', { key: 'kelpi.workbench.layout.v1:arrangement-daemon', newValue: other }));
        });
        expect(layout!.arrangement).toEqual(DEFAULT_ARRANGEMENT);
        expect(screen.getByTestId('native-topbar')).toBeDefined();
    });

    it('reads a corrupt store as the defaults and keeps a stable setter across renders', () => {
        localStorage.setItem('kelpi.workbench.layout.v1:arrangement-daemon', '{not json');
        const view = render(<Harness />);
        expect(layout!.arrangement).toEqual(DEFAULT_ARRANGEMENT);
        const first = layout!.arrange;
        view.rerender(<Harness />);
        expect(layout!.arrange).toBe(first);
    });
});

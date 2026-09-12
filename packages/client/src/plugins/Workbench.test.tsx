import { useContext, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { PlacementSettings, WorkbenchProvider, WorkbenchSidebar, WorkbenchSlot, useWorkbenchLayout } from './Workbench';
import { PluginHostUIContext, requestHostUI, type PluginHostUI } from './host-ui';

let plugins: readonly PluginInfo[] = [];
let daemonID = 'composition-daemon';
let bridge: PluginHostUI | null = null;
vi.mock('./client', () => ({ usePlugins: () => ({ plugins, daemonID }) }));
vi.mock('./PluginView', () => ({ PluginView: (props: { viewID: string; visible?: boolean }) => {
    const [count, setCount] = useState(0);
    return <button data-testid={props.viewID} data-visible={String(props.visible)} onClick={() => setCount(value => value + 1)}>{props.viewID}: {count}</button>;
} }));

const runtime = { connection: { target: 'ws://local.test/ws' } } as KelpiRuntime;
function plugin(layout: 'row' | 'column' | 'tabs' = 'row', native = 'kelpi.workspace'): PluginInfo {
    return { manifest: decodePluginManifest({ id: 'sample.board', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        containers: [{ id: 'sample.board.layout', title: 'Dashboard', placements: ['workspace', 'sidebar.primary', 'sidebar.secondary'], layout, slots: [
            { id: 'sample.board.main', title: 'Main', defaultView: native, weight: 3 },
            { id: 'sample.board.detail', title: 'Details', defaultView: 'sample.board.metrics' }
        ] }],
        views: [
            { id: 'sample.board.metrics', title: 'Metrics', entry: 'ui/index.html', placements: ['sample.board.main', 'sample.board.detail'] },
            { id: 'sample.board.activity', title: 'Activity', entry: 'ui/index.html', placements: ['sample.board.detail'] }
        ]
    } }), enabled: true, status: 'inactive', error: null, revision: 'r', instanceID: 'i' };
}
function NativeView(props: { visible?: boolean }): React.JSX.Element {
    const [count, setCount] = useState(0);
    return <button data-testid="native-view" data-visible={String(props.visible ?? true)} onClick={() => setCount(value => value + 1)}>Native: {count}</button>;
}
function BridgeObserver(): null { bridge = useContext(PluginHostUIContext); return null; }
function Harness(props: { sidebar?: boolean }): React.JSX.Element {
    const layout = useWorkbenchLayout(runtime);
    return <WorkbenchProvider layout={layout} runtime={runtime} chords={[]}>
        <BridgeObserver />
        <PlacementSettings />
        {props.sidebar ? <WorkbenchSidebar placement="sidebar.primary" nativeViewID="kelpi.workspaces" onManagePlugins={() => {}}>{() => <NativeView />}</WorkbenchSidebar> : <WorkbenchSlot placement="workspace">{context => <NativeView visible={context.visible} />}</WorkbenchSlot>}
    </WorkbenchProvider>;
}

beforeEach(() => { localStorage.clear(); daemonID = 'composition-daemon'; plugins = [plugin()]; bridge = null; });
afterEach(cleanup);

describe('the presented interaction placements', () => {
    function presenter(): PluginInfo {
        return { manifest: decodePluginManifest({ id: 'sample.present', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
            views: [{ id: 'sample.present.view', title: 'Lab presenter', entry: 'ui/index.html', placements: ['interaction.palette', 'interaction.prompts'] }]
        } }), enabled: true, status: 'inactive', error: null, revision: 'r', instanceID: 'i' };
    }

    it('is discoverable but never selectable by a plugin: the choice is the user’s, in Settings', () => {
        plugins = [presenter()];
        render(<Harness />);
        // Discovery, so a presenter can find out whether it is the one drawing.
        expect(requestHostUI(bridge, runtime, 'ui.getWorkbench', {})).toMatchObject({ slots: expect.arrayContaining([
            { id: 'interaction.palette', title: 'interaction.palette', viewID: 'kelpi.palette' },
            { id: 'interaction.prompts', title: 'interaction.prompts', viewID: 'kelpi.prompts' }
        ]) });
        /*
         * Selection, though, is refused for BOTH - the one place `ui.selectView` departs from every
         * other root slot. A plugin that could select itself as the prompts presenter would be
         * rendering other plugins' requests, `ui.showInput({ password: true })` included, on its own
         * say-so. A topbar it selects itself into replaces only its own chrome.
         */
        for (const slot of ['interaction.palette', 'interaction.prompts']) {
            expect(() => requestHostUI(bridge, runtime, 'ui.selectView', { slot, viewID: 'sample.present.view' })).toThrow('Workbench slot is not registered.');
            expect(requestHostUI(bridge, runtime, 'ui.getWorkbench', {})).toMatchObject({ slots: expect.arrayContaining([
                { id: slot, title: slot, viewID: slot === 'interaction.palette' ? 'kelpi.palette' : 'kelpi.prompts' }
            ]) });
        }

        // The Settings select is the route that does work, and it is a user gesture.
        act(() => { fireEvent.change(screen.getByLabelText('interaction.prompts'), { target: { value: 'sample.present.view' } }); });
        expect(requestHostUI(bridge, runtime, 'ui.getWorkbench', {})).toMatchObject({ slots: expect.arrayContaining([
            { id: 'interaction.prompts', title: 'interaction.prompts', viewID: 'sample.present.view' }
        ]) });
    });
});

describe('workbench composition', () => {
    it('scopes plugin UI requests to their daemon and rejects invalid selections explicitly', () => {
        render(<Harness />);
        expect(() => requestHostUI(null, runtime, 'ui.getWorkbench', {})).toThrow('unavailable');
        expect(() => requestHostUI(bridge, { ...runtime } as KelpiRuntime, 'ui.selectView', { slot: 'workspace', viewID: 'sample.board.layout' })).toThrow('unavailable');
        expect(() => requestHostUI(bridge, runtime, 'ui.selectView', { slot: 'sample.missing.slot', viewID: 'sample.board.layout' })).toThrow('not registered');
        expect(() => requestHostUI(bridge, runtime, 'ui.selectView', { slot: 'workspace', viewID: 'sample.board.metrics' })).toThrow('incompatible');
        expect(() => requestHostUI(bridge, runtime, 'ui.selectView', { slot: 'workspace', viewID: '' })).toThrow('incompatible');
        expect(requestHostUI(bridge, runtime, 'ui.getWorkbench', {})).toMatchObject({ slots: expect.arrayContaining([{ id: 'workspace', title: 'workspace', viewID: 'kelpi.workspace' }]) });
        act(() => { requestHostUI(bridge, runtime, 'ui.selectView', { slot: 'workspace', viewID: 'sample.board.layout' }); });
        expect(document.querySelector('[data-workbench-container]')).not.toBeNull();
        expect(() => requestHostUI(bridge, runtime, 'ui.activateTab', { containerID: 'sample.board.layout', slotID: 'sample.board.detail' })).toThrow('not registered');
    });
    it('refuses a plugin request that would create a container cycle', () => {
        const info = plugin();
        const container = info.manifest.contributes.containers![0]!;
        plugins = [{ ...info, manifest: decodePluginManifest({ ...info.manifest, contributes: { ...info.manifest.contributes, containers: [
            { ...container, placements: [...container.placements, 'sample.board.loop'] },
            { id: 'sample.board.nested', title: 'Nested', placements: ['sample.board.detail'], layout: 'column', slots: [{ id: 'sample.board.loop', title: 'Loop' }] }
        ] } }) }];
        render(<Harness />);
        act(() => { requestHostUI(bridge, runtime, 'ui.selectView', { slot: 'sample.board.detail', viewID: 'sample.board.nested' }); });
        expect(() => requestHostUI(bridge, runtime, 'ui.selectView', { slot: 'sample.board.loop', viewID: 'sample.board.layout' })).toThrow('cycle');
    });
    it('hands focus from a panel to the selected tab for a programmatic tab change', () => {
        plugins = [plugin('tabs')];
        render(<Harness />);
        act(() => { requestHostUI(bridge, runtime, 'ui.selectView', { slot: 'workspace', viewID: 'sample.board.layout' }); });
        screen.getByTestId('native-view').focus();
        act(() => { requestHostUI(bridge, runtime, 'ui.activateTab', { containerID: 'sample.board.layout', slotID: 'sample.board.detail' }); });
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Details' }));
        expect(requestHostUI(bridge, runtime, 'ui.getWorkbench', {})).toMatchObject({ activeTabs: { 'sample.board.layout': 'sample.board.detail' } });
        expect(() => requestHostUI(bridge, runtime, 'ui.activateTab', { containerID: 'sample.board.layout', slotID: 'sample.board.missing' })).toThrow('not registered');
    });
    it('wraps a native renderer, changes a child view and persists its choice per daemon', () => {
        const view = render(<Harness />);
        fireEvent.change(screen.getByLabelText('workspace'), { target: { value: 'sample.board.layout' } });
        expect(document.querySelector('[data-workbench-container="sample.board.layout"]')).not.toBeNull();
        fireEvent.click(screen.getByTestId('native-view'));
        fireEvent.change(screen.getByLabelText('Details view'), { target: { value: 'sample.board.activity' } });
        expect(screen.getByTestId('sample.board.activity')).toBeDefined();
        expect(screen.getByTestId('native-view').textContent).toBe('Native: 1');
        expect(JSON.parse(localStorage.getItem('kelpi.workbench.v1:composition-daemon')!)).toMatchObject({ workspace: 'sample.board.layout', 'sample.board.detail': 'sample.board.activity' });
        view.unmount();
        const restarted = render(<Harness />);
        expect(screen.getByTestId('sample.board.activity')).toBeDefined();
        restarted.unmount();
        daemonID = 'other-daemon';
        render(<Harness />);
        expect(document.querySelector('[data-workbench-container]')).toBeNull();
        expect(screen.getByTestId('native-view')).toBeDefined();
    });
    it('keeps tab contents mounted, relays visibility and supports arrow-key navigation', () => {
        plugins = [plugin('tabs', 'sample.board.metrics')];
        render(<Harness />);
        fireEvent.change(screen.getByLabelText('workspace'), { target: { value: 'sample.board.layout' } });
        const main = document.querySelector('[data-workbench-slot="sample.board.main"]') as HTMLElement;
        const details = document.querySelector('[data-workbench-slot="sample.board.detail"]') as HTMLElement;
        fireEvent.click(within(main).getByTestId('sample.board.metrics'));
        expect(within(main).getByTestId('sample.board.metrics').getAttribute('data-visible')).toBe('true');
        expect(within(details).getByTestId('sample.board.metrics').getAttribute('data-visible')).toBe('false');
        const first = screen.getByRole('tab', { name: 'Main' });
        fireEvent.keyDown(first, { key: 'ArrowRight' });
        expect(screen.getByRole('tab', { name: 'Details' })).toBe(document.activeElement);
        expect(main.hidden).toBe(true);
        expect(details.hidden).toBe(false);
        expect(within(main).getByTestId('sample.board.metrics').getAttribute('data-visible')).toBe('false');
        fireEvent.keyDown(screen.getByRole('tab', { name: 'Details' }), { key: 'Home' });
        expect(within(main).getByTestId('sample.board.metrics').textContent).toBe('sample.board.metrics: 1');
    });
    it('recovers bundled chrome on plugin removal and restores the preferred layout on return', () => {
        const mounted = render(<Harness />);
        fireEvent.change(screen.getByLabelText('workspace'), { target: { value: 'sample.board.layout' } });
        plugins = [];
        mounted.rerender(<Harness />);
        expect(document.querySelector('[data-workbench-container]')).toBeNull();
        expect(screen.getByTestId('native-view')).toBeDefined();
        plugins = [plugin()];
        mounted.rerender(<Harness />);
        expect(document.querySelector('[data-workbench-container]')).not.toBeNull();
    });
    it('idles hidden native adapters and restores the active tab after restarting', () => {
        plugins = [plugin('tabs')];
        const view = render(<Harness />);
        fireEvent.change(screen.getByLabelText('workspace'), { target: { value: 'sample.board.layout' } });
        fireEvent.click(screen.getByTestId('native-view'));
        fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
        expect(screen.getByTestId('native-view').getAttribute('data-visible')).toBe('false');
        expect(screen.getByTestId('native-view').textContent).toBe('Native: 1');
        expect(JSON.parse(localStorage.getItem('kelpi.workbench.tabs.v1:composition-daemon')!)).toEqual({ 'sample.board.layout': 'sample.board.detail' });
        view.unmount();
        render(<Harness />);
        expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByTestId('native-view').getAttribute('data-visible')).toBe('false');
    });
    it('mounts a bundled adapter once even when two slots request it', () => {
        const original = plugin();
        plugins = [{ ...original, manifest: { ...original.manifest, contributes: { ...original.manifest.contributes, containers: original.manifest.contributes.containers!.map(container => ({ ...container, slots: container.slots.map(slot => ({ ...slot, defaultView: 'kelpi.workspace' })) })) } } }];
        render(<Harness />);
        fireEvent.change(screen.getByLabelText('workspace'), { target: { value: 'sample.board.layout' } });
        expect(screen.getAllByTestId('native-view')).toHaveLength(1);
        expect(screen.getByText('Pane grid is already displayed in another slot.')).toBeDefined();
    });
    it('keeps the Workspaces filter host free of a picker and retains container recovery controls', () => {
        plugins = [plugin('column', 'kelpi.workspaces')];
        render(<Harness sidebar />);
        expect(screen.queryByTestId('sidebar-view-picker-sidebar.primary')).toBeNull();
        fireEvent.change(screen.getByLabelText('sidebar.primary'), { target: { value: 'sample.board.layout' } });
        expect(screen.getByTestId('sidebar-view-picker-sidebar.primary')).toBeDefined();
        expect(screen.getAllByTestId('native-view')).toHaveLength(1);
        fireEvent.change(screen.getByLabelText('Details view'), { target: { value: '' } });
        expect(screen.queryByTestId('sample.board.metrics')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Restore Details' }));
        expect(screen.getByTestId('sample.board.metrics')).toBeDefined();
    });
});

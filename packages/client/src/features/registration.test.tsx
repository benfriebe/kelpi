import { useEffect, useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';

import type { KelpiRuntime } from '../state';
import { PlacementSettings, WorkbenchProvider, WorkbenchSidebar, WorkbenchSlot, useWorkbenchLayout } from '../plugins/Workbench';
import { INSPECTOR_FEATURE, WORKSPACES_FEATURE, TOOLBAR_FEATURE, STATUSBAR_FEATURE } from './definitions';
import { featureBindings, type BundledFeatureBinding, type FeatureRenderContext } from './feature';

let plugins: readonly PluginInfo[] = [];
const active = new Map<string, number>();
const mounted = new Map<string, number>();
const disposed = new Map<string, number>();
const count = (values: Map<string, number>, id: string): number => values.get(id) ?? 0;

function track(id: string): () => void {
    active.set(id, count(active, id) + 1);
    mounted.set(id, count(mounted, id) + 1);
    return () => {
        active.set(id, count(active, id) - 1);
        disposed.set(id, count(disposed, id) + 1);
    };
}

vi.mock('../plugins/client', () => ({ usePlugins: () => ({ plugins, daemonID: 'feature-registration' }) }));
vi.mock('../plugins/PluginView', () => ({ PluginView: (props: { viewID: string; visible?: boolean }) => {
    useEffect(() => track(props.viewID), [props.viewID]);
    return <div data-testid={props.viewID} data-visible={String(props.visible)}>{props.viewID}</div>;
} }));

const runtime = { connection: { target: 'ws://feature.test/ws' } } as KelpiRuntime;

function NativeFeature(props: { id: string; context: FeatureRenderContext }): React.JSX.Element {
    const [clicks, setClicks] = useState(0);
    useEffect(() => track(props.id), [props.id]);
    return <div data-testid={props.id} data-side={props.context.side} data-inset={props.context.trafficLightInset} data-visible={String(props.context.visible)}>
        {props.id === 'kelpi.inspector' ? props.context.viewPicker : null}
        <button data-testid={`${props.id}.counter`} onClick={() => setClicks(value => value + 1)}>{clicks}</button>
    </div>;
}

function bindings(): readonly BundledFeatureBinding[] {
    return [WORKSPACES_FEATURE, INSPECTOR_FEATURE].map(definition => ({
        definition,
        render: context => <NativeFeature id={definition.id} context={context} />
    }));
}

function extension(): PluginInfo {
    return { manifest: decodePluginManifest({ id: 'sample.sidebar', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        containers: [
            { id: 'sample.sidebar.layout', title: 'Wrapped Workspaces', placements: ['sidebar.primary', 'sidebar.secondary'], layout: 'column', slots: [
                { id: 'sample.sidebar.main', title: 'Main', defaultView: 'kelpi.workspaces' },
                { id: 'sample.sidebar.duplicate', title: 'Duplicate', defaultView: 'kelpi.workspaces' },
                { id: 'sample.sidebar.foreign', title: 'Other feature', defaultView: 'kelpi.inspector' }
            ] },
            { id: 'sample.sidebar.tabs', title: 'Tabbed Workspaces', placements: ['sidebar.primary', 'sidebar.secondary'], layout: 'tabs', slots: [
                { id: 'sample.sidebar.native', title: 'Workspaces tab', defaultView: 'kelpi.workspaces' },
                { id: 'sample.sidebar.detail', title: 'Plugin tab', defaultView: 'sample.sidebar.custom' }
            ] }
        ],
        views: [{ id: 'sample.sidebar.custom', title: 'Custom sidebar', entry: 'ui/index.html',
            placements: ['sidebar.primary', 'sidebar.secondary', 'sample.sidebar.detail'] }]
    } }), enabled: true, status: 'inactive', error: null, revision: 'revision', instanceID: 'instance' };
}

function Harness(props: { features: readonly BundledFeatureBinding[] }): React.JSX.Element {
    const layout = useWorkbenchLayout(runtime);
    // The workbench has one native owner of each feature. App moves those hosts when the
    // selection swaps sides; containers can wrap only the feature owned by their host.
    const swapped = layout.sidebars['sidebar.primary'].id === 'kelpi.inspector' || layout.sidebars['sidebar.secondary'].id === 'kelpi.workspaces';
    const workspacesPlacement = swapped ? 'sidebar.secondary' : 'sidebar.primary';
    const inspectorPlacement = swapped ? 'sidebar.primary' : 'sidebar.secondary';
    return <WorkbenchProvider layout={layout} runtime={runtime} chords={[]} features={props.features}>
        <PlacementSettings />
        <section data-testid="workspaces-host" data-placement={workspacesPlacement}>
            <WorkbenchSidebar placement={workspacesPlacement} nativeViewID="kelpi.workspaces" onManagePlugins={() => {}} />
        </section>
        <section data-testid="inspector-host" data-placement={inspectorPlacement}>
            <WorkbenchSidebar placement={inspectorPlacement} nativeViewID="kelpi.inspector" onManagePlugins={() => {}} />
        </section>
    </WorkbenchProvider>;
}

function selectLeft(viewID: string): void {
    fireEvent.change(screen.getByLabelText('sidebar.primary'), { target: { value: viewID } });
}

beforeEach(() => { localStorage.clear(); plugins = [extension()]; active.clear(); mounted.clear(); disposed.clear(); });
afterEach(cleanup);

describe('bundled feature registration in the workbench', () => {
    it('rejects ambiguous native ownership in the feature registry', () => {
        const features = bindings();
        expect(() => featureBindings([features[0]!, features[0]!])).toThrow('already registered: kelpi.workspaces');
    });

    it('renders registered native sidebars without child renderers and swaps their placement', () => {
        render(<Harness features={bindings()} />);
        expect(screen.getByTestId('kelpi.workspaces').dataset.side).toBe('left');
        expect(screen.getByTestId('kelpi.inspector').dataset.side).toBe('right');
        expect(screen.queryByRole('button', { name: 'Left sidebar view' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Right sidebar view' })).toBeDefined();
        fireEvent.click(screen.getByTestId('kelpi.workspaces.counter'));

        selectLeft('kelpi.inspector');
        expect(screen.getByTestId('workspaces-host').dataset.placement).toBe('sidebar.secondary');
        expect(screen.getByTestId('inspector-host').dataset.placement).toBe('sidebar.primary');
        expect(screen.getByTestId('kelpi.workspaces').dataset.side).toBe('right');
        expect(screen.getByTestId('kelpi.inspector').dataset.side).toBe('left');
        expect(screen.getByRole('button', { name: 'Left sidebar view' })).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Right sidebar view' })).toBeNull();
        expect(screen.getAllByTestId('kelpi.workspaces')).toHaveLength(1);
        expect(screen.getAllByTestId('kelpi.inspector')).toHaveLength(1);
        expect(screen.getByTestId('kelpi.workspaces.counter').textContent).toBe('1');
        expect(count(mounted, 'kelpi.workspaces')).toBe(1);
        expect(count(mounted, 'kelpi.inspector')).toBe(1);
    });

    it('lets a container wrap its native feature once and refuses another host’s feature', () => {
        render(<Harness features={bindings()} />);
        selectLeft('sample.sidebar.layout');
        const host = within(screen.getByTestId('workspaces-host'));
        expect(host.getAllByTestId('kelpi.workspaces')).toHaveLength(1);
        expect(host.queryByTestId('kelpi.inspector')).toBeNull();
        expect(screen.getAllByTestId('kelpi.inspector')).toHaveLength(1);
        expect(host.getByText('Workspaces is already displayed in another slot.')).toBeDefined();
        expect(host.getByText('Inspector is unavailable in this host. Choose another view.')).toBeDefined();
        expect(host.getByTestId('kelpi.workspaces').dataset.side).toBe('left');
        expect(host.getByRole('button', { name: 'Left sidebar view' })).toBeDefined();
        expect(count(active, 'kelpi.workspaces')).toBe(1);
        expect(count(active, 'kelpi.inspector')).toBe(1);
    });

    it('passes container tab visibility to registered features while preserving their local state', () => {
        render(<Harness features={bindings()} />);
        selectLeft('sample.sidebar.tabs');
        fireEvent.click(screen.getByTestId('kelpi.workspaces.counter'));
        expect(screen.getByTestId('kelpi.workspaces').dataset.visible).toBe('true');
        fireEvent.click(screen.getByRole('tab', { name: 'Plugin tab' }));
        expect(screen.getByTestId('kelpi.workspaces').dataset.visible).toBe('false');
        expect(screen.getByTestId('sample.sidebar.custom').dataset.visible).toBe('true');
        fireEvent.click(screen.getByRole('tab', { name: 'Workspaces tab' }));
        expect(screen.getByTestId('kelpi.workspaces.counter').textContent).toBe('1');
        expect(screen.getByTestId('kelpi.workspaces').dataset.visible).toBe('true');
        expect(count(active, 'kelpi.workspaces')).toBe(1);
    });

    it('disposes the replaced feature view, recovers it when the plugin disappears, and cleans up on unmount', () => {
        const features = bindings();
        const view = render(<Harness features={features} />);
        selectLeft('sample.sidebar.custom');
        expect(screen.queryByTestId('kelpi.workspaces')).toBeNull();
        expect(screen.getByTestId('sample.sidebar.custom')).toBeDefined();
        expect(count(active, 'kelpi.workspaces')).toBe(0);
        expect(count(disposed, 'kelpi.workspaces')).toBe(1);
        expect(count(active, 'sample.sidebar.custom')).toBe(1);
        expect(count(mounted, 'kelpi.inspector')).toBe(1);

        plugins = [];
        view.rerender(<Harness features={features} />);
        expect(screen.getByTestId('kelpi.workspaces')).toBeDefined();
        expect(screen.queryByTestId('sample.sidebar.custom')).toBeNull();
        expect(count(disposed, 'sample.sidebar.custom')).toBe(1);
        expect(count(active, 'kelpi.workspaces')).toBe(1);
        expect(count(mounted, 'kelpi.inspector')).toBe(1);
        view.unmount();
        expect([...active.values()].every(value => value === 0)).toBe(true);
        expect(count(disposed, 'kelpi.workspaces')).toBe(2);
        expect(count(disposed, 'kelpi.inspector')).toBe(1);
    });
});


describe('registered toolbar and status hosts', () => {
    it('resolves root bindings, retains hidden native tabs, bounds ownership and restores missing providers', () => {
        plugins = [{ manifest: decodePluginManifest({ id: 'sample.chrome', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
            views: [{ id: 'sample.chrome.bar', title: 'Replacement bar', entry: 'ui/index.html', placements: ['topbar', 'statusbar', 'sample.chrome.custom'] }],
            containers: [{ id: 'sample.chrome.tabs', title: 'Toolbar tabs', placements: ['topbar'], layout: 'tabs', slots: [
                { id: 'sample.chrome.native', title: 'Native', defaultView: 'kelpi.topbar' },
                { id: 'sample.chrome.custom', title: 'Custom', defaultView: 'sample.chrome.bar' },
                { id: 'sample.chrome.duplicate', title: 'Duplicate', defaultView: 'kelpi.topbar' },
                { id: 'sample.chrome.foreign', title: 'Foreign', defaultView: 'kelpi.statusbar' }
            ] }]
        } }), enabled: true, status: 'inactive', error: null, revision: 'r', instanceID: 'i' }];
        function ChromeHarness() {
            const layout = useWorkbenchLayout(runtime);
            const features = [TOOLBAR_FEATURE, STATUSBAR_FEATURE].map(definition => ({ definition,
                render: (context: FeatureRenderContext) => <NativeFeature id={definition.id} context={context} /> }));
            return <WorkbenchProvider layout={layout} runtime={runtime} chords={[]} features={features}>
                <PlacementSettings /><WorkbenchSlot placement="topbar" trafficLightInset={86} /><WorkbenchSlot placement="statusbar" />
            </WorkbenchProvider>;
        }
        const h = render(<ChromeHarness />);
        expect(screen.getByTestId('kelpi.topbar').dataset.inset).toBe('86');
        expect(screen.getByTestId('kelpi.statusbar')).toBeDefined();
        fireEvent.change(screen.getByLabelText('topbar'), { target: { value: 'sample.chrome.tabs' } });
        expect(screen.getAllByTestId('kelpi.topbar')).toHaveLength(1);
        expect(screen.getAllByTestId('kelpi.statusbar')).toHaveLength(1);
        expect(screen.getByTestId('kelpi.topbar').dataset.inset).toBe('0');
        fireEvent.click(screen.getByTestId('kelpi.topbar.counter')); const mounts = count(mounted, 'kelpi.topbar');
        fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
        expect(screen.getByTestId('kelpi.topbar').dataset.visible).toBe('false');
        fireEvent.click(screen.getByRole('tab', { name: 'Native' }));
        expect(screen.getByTestId('kelpi.topbar.counter').textContent).toBe('1');
        expect(count(mounted, 'kelpi.topbar')).toBe(mounts);
        fireEvent.change(screen.getByLabelText('statusbar'), { target: { value: 'sample.chrome.bar' } });
        expect(screen.queryByTestId('kelpi.statusbar')).toBeNull();
        plugins = plugins.map(plugin => ({ ...plugin, enabled: false })); h.rerender(<ChromeHarness />);
        expect(screen.getAllByTestId('kelpi.topbar')).toHaveLength(1); expect(screen.getAllByTestId('kelpi.statusbar')).toHaveLength(1);
        expect(screen.getByTestId('kelpi.topbar').dataset.inset).toBe('86');
    });
});

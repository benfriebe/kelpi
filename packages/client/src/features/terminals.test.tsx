import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import type { TerminalPaneProps } from '../terminal/TerminalPane';
import { TerminalFeaturePane } from './TerminalFeaturePane';

let plugins: PluginInfo[] = [];
let rendererError = 'Renderer failed';
const mounted = vi.fn(), released = vi.fn();
vi.mock('../plugins/client', () => ({
    usePlugins: (runtime: KelpiRuntime) => ({ plugins, daemonID: new URL(runtime.connection.target).host }),
    getCurrentPlugins: () => plugins
}));
vi.mock('../terminal/TerminalPane', () => ({ TerminalPane: (props: TerminalPaneProps) => {
    useEffect(() => { mounted(props.paneID, 'native'); return () => { released(props.paneID, 'native'); }; }, [props.paneID]);
    return <div data-testid={`native-${props.paneID}`} data-visible={props.visible} data-focused={props.focused} />;
} }));
vi.mock('../plugins/PluginView', () => ({ PluginView: (props: { paneID: string; viewID: string; terminal: TerminalPaneProps; onError(message: string): void }) => {
    useEffect(() => { mounted(props.paneID, props.viewID); return () => { released(props.paneID, props.viewID); }; }, [props.paneID, props.viewID]);
    return <button data-testid={`plugin-${props.paneID}`} data-visible={props.terminal.visible} data-focused={props.terminal.focused}
        onClick={() => props.onError(rendererError)}>{props.viewID}</button>;
} }));
/**
 * A store with just the one slice `TerminalFeaturePane` reads: who owns PTY sizing (#166).
 *
 * `null` is "unknown, or nobody", which is the answer that makes a pane behave exactly as it did
 * before #166 — the right default for a file about renderer SELECTION, which is not about sizing.
 */
const sizeControlStore = (): KelpiRuntime['store'] => {
    const state = { daemon: { sizeControlOwnerID: null, clientID: null } };
    return {
        getState: () => state,
        getInitialState: () => state,
        setState: () => undefined,
        subscribe: () => () => undefined
    } as unknown as KelpiRuntime['store'];
};
const runtime = (host: string) =>
    ({ connection: { target: `ws://${host}/ws` }, store: sizeControlStore() } as KelpiRuntime);
const local = runtime('terminal.test'), remote = runtime('remote-terminal.test');
const props = { runtime: local, workspaceID: 'W', paneID: 'P', ptyApi: { subscribe: vi.fn() }, focused: true, visible: true };
beforeEach(() => {
    localStorage.clear(); mounted.mockClear(); released.mockClear(); rendererError = 'Renderer failed';
    plugins = [{ manifest: decodePluginManifest({ id: 'sample.terminal', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        views: [{ id: 'sample.terminal.body', title: 'Custom terminal', entry: 'ui/index.html', placements: ['terminal'] }]
    } }), enabled: true, status: 'inactive', error: null, revision: 'one', instanceID: 'one' }];
});
afterEach(cleanup);
const choose = (id: string) => fireEvent.change(screen.getAllByLabelText('Terminal renderer')[0]!, { target: { value: id } });

describe('replaceable terminal feature', () => {
    it('switches renderers without replacing the pane or its transport and persists the choice', async () => {
        const view = render(<TerminalFeaturePane {...props} />);
        expect(screen.getByTestId('native-P')).toBeDefined();
        choose('sample.terminal.body');
        expect(screen.getByTestId('plugin-P')).toBeDefined();
        expect(released).toHaveBeenCalledWith('P', 'native');
        expect(props.ptyApi.subscribe).not.toHaveBeenCalled();
        await act(async () => {});
        view.unmount();
        render(<TerminalFeaturePane {...props} />);
        expect(screen.getByTestId('plugin-P')).toBeDefined();
        choose('kelpi.shell');
        expect(screen.getByTestId('native-P')).toBeDefined();
    });

    it('keeps a hidden renderer mounted while updating visibility and focus', () => {
        const view = render(<TerminalFeaturePane {...props} />);
        choose('sample.terminal.body');
        const before = mounted.mock.calls.length;
        view.rerender(<TerminalFeaturePane {...props} visible={false} focused={false} />);
        expect(screen.getByTestId('plugin-P').dataset.visible).toBe('false');
        view.rerender(<TerminalFeaturePane {...props} />);
        expect(mounted.mock.calls).toHaveLength(before);
        expect(screen.getByTestId('plugin-P').dataset.focused).toBe('true');
    });

    it.each(['Renderer failed', ''])('falls back on failure "%s", retries explicitly, and recovers after plugin reload', message => {
        rendererError = message;
        const view = render(<TerminalFeaturePane {...props} />);
        choose('sample.terminal.body'); fireEvent.click(screen.getByTestId('plugin-P'));
        expect(screen.getByTestId('native-P')).toBeDefined();
        expect(screen.getByRole('status').textContent).toContain('bundled terminal');
        fireEvent.click(screen.getByText('Retry renderer'));
        expect(screen.getByTestId('plugin-P')).toBeDefined();
        fireEvent.click(screen.getByTestId('plugin-P'));
        plugins = [{ ...plugins[0]!, instanceID: 'two' }]; view.rerender(<TerminalFeaturePane {...props} />);
        expect(screen.getByTestId('plugin-P')).toBeDefined();
        plugins = [{ ...plugins[0]!, enabled: false }]; view.rerender(<TerminalFeaturePane {...props} />);
        expect(screen.getByTestId('native-P')).toBeDefined();
    });

    it('shares a selection across panes of one daemon and isolates remote choices', async () => {
        render(<><TerminalFeaturePane {...props} /><TerminalFeaturePane {...props} paneID="P2" />
            <TerminalFeaturePane {...props} runtime={remote} paneID="R" /></>);
        choose('sample.terminal.body');
        await waitFor(() => expect(screen.getByTestId('plugin-P2')).toBeDefined());
        expect(screen.getByTestId('native-R')).toBeDefined();
    });
});

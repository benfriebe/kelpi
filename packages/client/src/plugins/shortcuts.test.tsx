import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import { createKelpiRuntime } from '../state/bridge';
import { createKelpiStore } from '../state/store';
import { createFakeSocketFactory, completeHandshake } from '../connection/testing';
import { usePluginCommands } from './commands';
import { PluginShortcuts } from './PluginShortcuts';
import { normalizePluginShortcut } from './shortcuts';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const plugin: PluginInfo = { manifest: decodePluginManifest({ id: 'sample.keys', version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs', contributes: {
    commands: [{ id: 'sample.keys.run', title: 'Run example', shortcut: 'ctrl+alt+b' }]
} }), enabled: true, revision: 'r1', instanceID: 'i1', status: 'running', error: null };

function setup(daemonID = 'daemon-one') {
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://daemon.test/ws', token: 'test', socketFactory: sockets.factory, notifications: null });
    const calls = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => ({ ok: true, result: payload['action'] === 'list' ? [plugin] as never : payload['action'] === 'identity' ? { daemonID } : null }));
    runtime.connect(); completeHandshake(sockets.last());
    function Host(props: { reserved?: string[]; blocked?: boolean; onKey?: () => void }) {
        const commands = usePluginCommands(runtime, props.reserved ?? [], () => props.blocked ?? false);
        return <><output data-testid="chords">{commands.chords.join(',')}</output><input aria-label="Terminal target" onKeyDown={event => { event.preventDefault(); props.onKey?.(); }} /><PluginShortcuts runtime={runtime} plugin={plugin} /></>;
    }
    return { runtime, calls, Host };
}

describe('editable plugin shortcuts', () => {
    it('requires a non-typing modifier and normalizes aliases', () => {
        expect(normalizePluginShortcut('command+shift+b')).toBe('shift+super+b');
        expect(normalizePluginShortcut('')).toBeNull();
        for (const input of ['b', 'shift+b', 'banana+b']) expect(() => normalizePluginShortcut(input)).toThrow('Cmd, Ctrl, or Alt');
    });

    it('updates live command handling, disables a default, and restores it across mounts', async () => {
        const { runtime, calls, Host } = setup();
        try {
            const rendered = render(<Host />);
            await waitFor(() => expect(screen.getByTestId('chords').textContent).toBe('3/KeyB'));
            fireEvent.change(screen.getByLabelText('Shortcut for Run example'), { target: { value: 'ctrl+alt+j' } });
            fireEvent.click(screen.getByText('Save shortcut'));
            await waitFor(() => expect(screen.getByTestId('chords').textContent).toBe('3/KeyJ'));
            act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true, cancelable: true })); });
            await waitFor(() => expect(calls.mock.calls.some(([payload]) => payload['action'] === 'run')).toBe(true));
            rendered.unmount();
            render(<Host />);
            await waitFor(() => expect(screen.getByTestId('chords').textContent).toBe('3/KeyJ'));
            fireEvent.change(screen.getByLabelText('Shortcut for Run example'), { target: { value: '' } });
            fireEvent.click(screen.getByText('Save shortcut'));
            await waitFor(() => expect(screen.getByTestId('chords').textContent).toBe(''));
            fireEvent.click(screen.getByText('Restore default'));
            await waitFor(() => expect(screen.getByTestId('chords').textContent).toBe('3/KeyB'));
        } finally { runtime.dispose(); }
    });

    it('preserves bundled priority and daemon isolation even at the same address', async () => {
        localStorage.setItem('kelpi.plugin-shortcuts.v1:daemon-one', JSON.stringify({ 'sample.keys.run': 'ctrl+alt+j' }));
        const first = setup();
        try {
            const rendered = render(<first.Host reserved={['3/KeyJ']} />);
            await waitFor(() => expect((screen.getByLabelText('Shortcut for Run example') as HTMLInputElement).value).toBe('ctrl+alt+j'));
            expect(screen.getByTestId('chords').textContent).toBe('');
            rendered.unmount();
        } finally { first.runtime.dispose(); }
        const second = setup('daemon-two');
        try {
            render(<second.Host />);
            await waitFor(() => expect(screen.getByTestId('chords').textContent).toBe('3/KeyB'));
        } finally { second.runtime.dispose(); }
    });

    it('handles bound keys before terminal consumption while leaving modal input to its owner', async () => {
        const { runtime, calls, Host } = setup();
        const terminalKey = vi.fn();
        try {
            const rendered = render(<Host onKey={terminalKey} />);
            await waitFor(() => expect(screen.getByTestId('chords').textContent).toBe('3/KeyB'));
            fireEvent.keyDown(screen.getByLabelText('Terminal target'), { code: 'KeyB', ctrlKey: true, altKey: true });
            expect(terminalKey).not.toHaveBeenCalled();
            expect(calls.mock.calls.filter(([payload]) => payload['action'] === 'run')).toHaveLength(1);
            rendered.rerender(<Host onKey={terminalKey} blocked />);
            fireEvent.keyDown(screen.getByLabelText('Terminal target'), { code: 'KeyB', ctrlKey: true, altKey: true });
            expect(terminalKey).toHaveBeenCalledTimes(1);
            expect(calls.mock.calls.filter(([payload]) => payload['action'] === 'run')).toHaveLength(1);
        } finally { runtime.dispose(); }
    });
});

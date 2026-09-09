import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { decodePluginManifest, type JsonObject, type PluginInfo } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandReply } from '../connection';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { PluginSettings } from './PluginsTab';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const ID = 'sample.settings';
const plugin: PluginInfo = { manifest: decodePluginManifest({ id: ID, version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
    settingGroups: [
        { id: `${ID}.advanced`, title: 'Advanced', description: 'Background behavior.', order: 10 },
        { id: `${ID}.display`, title: 'Display', description: 'Adjust the presentation.', order: -1 }
    ],
    settings: {
        mode: { title: 'Size', type: 'string', default: 'small', enum: ['small', 'large'], group: `${ID}.display`, order: 2 },
        count: { title: 'Rows', type: 'number', default: 2, min: 1, max: 10, group: `${ID}.display`, order: 1, description: 'Rows to show.' },
        enabled: { title: 'Run in background', type: 'boolean', default: false, group: `${ID}.advanced` },
        notes: { title: 'Notes', type: 'string', default: 'Default notes' }
    }
} }), enabled: true, status: 'running', instanceID: 'i1', revision: 'r1', error: null };
const VALUES = { count: 4, mode: 'small', enabled: false, notes: 'Saved notes' };

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function setup() {
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://settings.test/ws', socketFactory: sockets.factory, notifications: null });
    const read = vi.fn<() => Promise<CommandReply>>().mockResolvedValue({ ok: true, result: VALUES });
    const write = vi.fn<(args: JsonObject) => Promise<CommandReply>>().mockResolvedValue({ ok: true, result: null });
    vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => {
        const args = JSON.parse(String(payload['text'])) as JsonObject;
        return args['key'] === undefined ? read() : write(args);
    });
    runtime.connect(); completeHandshake(sockets.last());
    const report = vi.fn();
    let sequence = 0;
    const changed = (key: string, value: string | number | boolean, owner = ID) => sockets.last().emit({ type: 'plugin-event', event: {
        epoch: 'epoch', sequence: ++sequence, name: 'settings.changed', pluginID: owner, data: { key, value }
    } });
    return { runtime, sockets, read, write, report, changed };
}
const input = (title: string) => screen.getByLabelText(title) as HTMLInputElement;
async function loaded(): Promise<void> { await waitFor(() => expect(input('Rows').disabled).toBe(false)); }

describe('grouped plugin settings', () => {
    it('orders groups and fields, associates descriptions, and uses enum/boolean controls', async () => {
        const h = setup();
        try {
            render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />);
            await loaded();
            const groups = screen.getAllByRole('group');
            expect(groups.map(group => group.querySelector('legend')?.textContent)).toEqual(['General', 'Display', 'Advanced']);
            expect(within(groups[1]!).getByText('Adjust the presentation.')).toBeTruthy();
            expect([...groups[1]!.querySelectorAll('input,select')].map(field => field.getAttribute('aria-label'))).toEqual(['Rows', 'Size']);
            const described = input('Rows').getAttribute('aria-describedby');
            expect(described && document.getElementById(described)?.textContent).toBe('Rows to show.');
            expect(input('Rows').value).toBe('4');
            expect(screen.getByRole('combobox', { name: 'Size' })).toBeTruthy();
            expect(screen.getByRole('checkbox', { name: 'Run in background' })).toBeTruthy();
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('keeps invalid number drafts editable and sends only finite values within bounds', async () => {
        const h = setup();
        try {
            render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
            for (const value of ['-', '1e', '', 'NaN', 'Infinity', '1e999', '0', '11']) {
                fireEvent.change(input('Rows'), { target: { value } });
                expect(input('Rows').value).toBe(value);
                expect(input('Rows').getAttribute('aria-invalid')).toBe('true');
                expect(h.write).not.toHaveBeenCalled();
            }
            fireEvent.change(input('Rows'), { target: { value: '10' } });
            await waitFor(() => expect(h.write).toHaveBeenCalledWith({ pluginID: ID, key: 'count', value: 10 }));
            expect(input('Rows').getAttribute('aria-invalid')).toBeNull();
            fireEvent.change(screen.getByRole('combobox', { name: 'Size' }), { target: { value: 'large' } });
            fireEvent.click(screen.getByRole('checkbox', { name: 'Run in background' }));
            await waitFor(() => expect(h.write).toHaveBeenCalledTimes(3));
            expect(h.write).toHaveBeenCalledWith({ pluginID: ID, key: 'mode', value: 'large' });
            expect(h.write).toHaveBeenCalledWith({ pluginID: ID, key: 'enabled', value: true });
            expect(h.report).not.toHaveBeenCalled();
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('serializes each field and coalesces newer edits without losing another live setting', async () => {
        const h = setup(), first = deferred<CommandReply>();
        h.write.mockReturnValueOnce(first.promise);
        try {
            render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
            fireEvent.change(input('Notes'), { target: { value: 'First edit' } });
            fireEvent.change(input('Notes'), { target: { value: 'Intermediate edit' } });
            fireEvent.change(input('Notes'), { target: { value: 'Newest edit' } });
            expect(h.write).toHaveBeenCalledTimes(1);
            act(() => h.changed('enabled', true));
            await act(async () => first.resolve({ ok: true, result: null }));
            expect(h.write.mock.calls.map(([args]) => args['value'])).toEqual(['First edit', 'Newest edit']);
            expect(input('Notes').value).toBe('Newest edit');
            expect(input('Run in background').checked).toBe(true);
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it.each([false, true])('persists the final valid edit with Settings closed=%s before the first acknowledgement', async close => {
        const h = setup(), first = deferred<CommandReply>();
        let saved = 'Before';
        h.read.mockImplementation(async () => ({ ok: true, result: { ...VALUES, notes: saved } }));
        h.write.mockImplementation(async args => {
            saved = String(args['value']);
            return h.write.mock.calls.length === 1 ? first.promise : { ok: true, result: null };
        });
        try {
            const view = render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
            fireEvent.change(input('Notes'), { target: { value: 'N' } });
            fireEvent.change(input('Notes'), { target: { value: 'Newest complete value' } });
            expect(h.write).toHaveBeenCalledTimes(1);
            if (close) view.unmount(); // Closing Settings and switching tabs both unmount the panel.
            await act(async () => first.resolve({ ok: true, result: null }));
            expect(h.write.mock.calls.map(([args]) => args['value'])).toEqual(['N', 'Newest complete value']);
            expect(saved).toBe('Newest complete value');
            if (close) { render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded(); }
            expect(input('Notes').value).toBe('Newest complete value');
            expect(h.report).not.toHaveBeenCalled();
            cleanup();
            const reads = h.read.mock.calls.length;
            h.sockets.last().emit({ type: 'plugin-event', event: { epoch: 'epoch', sequence: 10, name: 'gap', data: null } });
            expect(h.read).toHaveBeenCalledTimes(reads);
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('shares the pending save with a reopened panel so an old queued edit cannot overwrite a newer edit', async () => {
        const h = setup(), first = deferred<CommandReply>(), latest = deferred<CommandReply>();
        let saved = 'Before';
        h.read.mockImplementation(async () => ({ ok: true, result: { ...VALUES, notes: saved } }));
        h.write.mockImplementation(async args => {
            saved = String(args['value']);
            return h.write.mock.calls.length === 1 ? first.promise : latest.promise;
        });
        try {
            const original = render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
            fireEvent.change(input('Notes'), { target: { value: 'First edit' } });
            fireEvent.change(input('Notes'), { target: { value: 'Old queued edit' } });
            original.unmount();
            const reopenedReport = vi.fn();
            const reopened = render(<PluginSettings runtime={h.runtime} plugin={plugin} report={reopenedReport} />); await loaded();
            expect(input('Notes').value).toBe('Old queued edit');
            fireEvent.change(input('Notes'), { target: { value: 'Newest reopened edit' } });
            expect(h.write).toHaveBeenCalledTimes(1);
            await act(async () => first.resolve({ ok: true, result: null }));
            expect(h.write.mock.calls.map(([args]) => args['value'])).toEqual(['First edit', 'Newest reopened edit']);
            expect(input('Notes').value).toBe('Newest reopened edit');
            reopened.unmount();
            await act(async () => latest.resolve({ ok: true, result: null }));
            render(<PluginSettings runtime={h.runtime} plugin={plugin} report={reopenedReport} />); await loaded();
            expect(saved).toBe('Newest reopened edit');
            expect(input('Notes').value).toBe(saved);
            expect(h.report).not.toHaveBeenCalled();
            expect(reopenedReport).not.toHaveBeenCalled();
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it.each(['reload', 'revision', 'disable', 'remove', 'dispose', 'reconnect'] as const)(
        'drops queued writes when %s retires their owner after Settings closes', async lifecycle => {
            const h = setup(), first = deferred<CommandReply>();
            h.write.mockReturnValueOnce(first.promise);
            try {
                const view = render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
                fireEvent.change(input('Notes'), { target: { value: 'First edit' } });
                fireEvent.change(input('Notes'), { target: { value: 'Retired queued edit' } });
                view.unmount();
                act(() => {
                    if (lifecycle === 'dispose') h.runtime.dispose();
                    else if (lifecycle === 'reconnect') { h.runtime.connection.resync('new connection'); completeHandshake(h.sockets.last()); }
                    else h.sockets.last().emit({ type: 'plugins-changed', epoch: 'epoch', plugins: lifecycle === 'remove' ? [] : [{ ...plugin,
                        ...(lifecycle === 'reload' ? { instanceID: 'i2' } : {}),
                        ...(lifecycle === 'revision' ? { revision: 'r2' } : {}),
                        ...(lifecycle === 'disable' ? { enabled: false, status: 'disabled' } : {})
                    }] });
                });
                await act(async () => first.resolve({ ok: true, result: null }));
                expect(h.write).toHaveBeenCalledTimes(1);
                expect(h.report).not.toHaveBeenCalled();
            } finally { cleanup(); h.runtime.dispose(); }
        }
    );

    it('fences queued writes as soon as the mounted plugin is disabled, before React receives new props', async () => {
        const h = setup(), first = deferred<CommandReply>();
        h.write.mockReturnValueOnce(first.promise);
        try {
            render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
            fireEvent.change(input('Notes'), { target: { value: 'First edit' } });
            fireEvent.change(input('Notes'), { target: { value: 'Retired queued edit' } });
            await act(async () => {
                h.sockets.last().emit({ type: 'plugins-changed', plugins: [{ ...plugin, enabled: false, status: 'disabled' }] });
                first.resolve({ ok: true, result: null });
            });
            expect(h.write).toHaveBeenCalledTimes(1);
            expect(input('Notes').disabled).toBe(true);
            expect(h.report).not.toHaveBeenCalled();
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it.each(['plugin', 'runtime'] as const)('keeps a replacement %s isolated from the previous owner\'s queued writes and late replies', async replacement => {
        const h = setup(), other = replacement === 'runtime' ? setup() : h, first = deferred<CommandReply>();
        h.write.mockReturnValueOnce(first.promise);
        try {
            const view = render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
            fireEvent.change(input('Notes'), { target: { value: 'Old first edit' } });
            fireEvent.change(input('Notes'), { target: { value: 'Old queued edit' } });
            const current = replacement === 'plugin' ? { ...plugin, instanceID: 'i2' } : plugin;
            view.rerender(<PluginSettings runtime={other.runtime} plugin={current} report={other.report} />); await loaded();
            fireEvent.change(input('Notes'), { target: { value: 'Replacement edit' } });
            await act(async () => first.reject(new Error('Retired owner')));
            expect(input('Notes').value).toBe('Replacement edit');
            expect(h.write.mock.calls.map(([args]) => args['value'])).toEqual(replacement === 'plugin' ? ['Old first edit', 'Replacement edit'] : ['Old first edit']);
            expect(h.report).not.toHaveBeenCalled();
            expect(other.report).not.toHaveBeenCalled();
        } finally { cleanup(); h.runtime.dispose(); if (other !== h) other.runtime.dispose(); }
    });

    it('rolls a failed save back to a newer daemon event and reports the failure', async () => {
        const h = setup(), pending = deferred<CommandReply>();
        h.write.mockReturnValueOnce(pending.promise);
        try {
            render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
            fireEvent.change(input('Notes'), { target: { value: 'Local edit' } });
            act(() => { h.changed('notes', 'Peer edit'); h.changed('count', 9, 'unrelated.plugin'); });
            await act(async () => pending.reject(new Error('Setting write failed')));
            expect(input('Notes').value).toBe('Peer edit');
            expect(input('Rows').value).toBe('4');
            expect(screen.getByRole('alert').textContent).toBe('Setting write failed');
            expect(h.report).toHaveBeenCalledOnce();
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('does not replace a newer invalid draft when an earlier valid save fails', async () => {
        const h = setup(), pending = deferred<CommandReply>();
        h.write.mockReturnValueOnce(pending.promise);
        try {
            render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
            fireEvent.change(input('Rows'), { target: { value: '3' } });
            fireEvent.change(input('Rows'), { target: { value: '1e' } });
            await act(async () => pending.reject(new Error('Earlier write failed')));
            expect(input('Rows').value).toBe('1e');
            expect(screen.getByRole('alert').textContent).toBe('Enter a valid number.');
            expect(h.write).toHaveBeenCalledTimes(1);
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('preserves a focused numeric draft and a daemon value newer than a successful save acknowledgement', async () => {
        const h = setup(), pending = deferred<CommandReply>();
        h.write.mockReturnValueOnce(pending.promise);
        try {
            render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />); await loaded();
            fireEvent.focus(input('Rows'));
            fireEvent.change(input('Rows'), { target: { value: '1.' } });
            act(() => h.changed('count', 8));
            await act(async () => pending.resolve({ ok: true, result: null }));
            expect(input('Rows').value).toBe('1.');
            fireEvent.blur(input('Rows'));
            expect(input('Rows').value).toBe('8');
            expect(h.write).toHaveBeenCalledExactlyOnceWith({ pluginID: ID, key: 'count', value: 1 });
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('preserves live events newer than the initial settings read', async () => {
        const h = setup(), pending = deferred<CommandReply>();
        h.read.mockReturnValueOnce(pending.promise);
        try {
            render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />);
            expect(input('Rows').disabled).toBe(true);
            act(() => h.changed('count', 8));
            await act(async () => pending.resolve({ ok: true, result: VALUES }));
            expect(input('Rows').value).toBe('8');
            expect(input('Notes').value).toBe('Saved notes');
            expect(input('Rows').disabled).toBe(false);
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('drops old-instance reads and writes after a reload, and detaches on unmount', async () => {
        const h = setup(), oldRead = deferred<CommandReply>(), oldWrite = deferred<CommandReply>();
        h.read.mockReturnValueOnce(oldRead.promise);
        try {
            const view = render(<PluginSettings runtime={h.runtime} plugin={plugin} report={h.report} />);
            view.rerender(<PluginSettings runtime={h.runtime} plugin={{ ...plugin, instanceID: 'i2' }} report={h.report} />);
            await loaded();
            await act(async () => oldRead.resolve({ ok: true, result: { ...VALUES, count: 1 } }));
            expect(input('Rows').value).toBe('4');
            h.write.mockReturnValueOnce(oldWrite.promise);
            fireEvent.change(input('Notes'), { target: { value: 'Old instance edit' } });
            h.read.mockResolvedValue({ ok: true, result: { ...VALUES, notes: 'Reloaded notes' } });
            view.rerender(<PluginSettings runtime={h.runtime} plugin={{ ...plugin, instanceID: 'i3' }} report={h.report} />);
            await loaded();
            await act(async () => oldWrite.reject(new Error('Retired instance')));
            expect(input('Notes').value).toBe('Reloaded notes');
            expect(h.report).not.toHaveBeenCalled();
            const count = h.read.mock.calls.length;
            view.unmount();
            h.sockets.last().emit({ type: 'plugin-event', event: { epoch: 'epoch', sequence: 10, name: 'gap', data: null } });
            expect(h.read).toHaveBeenCalledTimes(count);
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('renders disabled plugin fields without fetching or saving their values', () => {
        const h = setup();
        try {
            render(<PluginSettings runtime={h.runtime} plugin={{ ...plugin, enabled: false, status: 'disabled' }} report={h.report} />);
            expect(input('Rows').disabled).toBe(true);
            expect(input('Run in background').disabled).toBe(true);
            expect(h.read).not.toHaveBeenCalled();
            expect(h.write).not.toHaveBeenCalled();
        } finally { cleanup(); h.runtime.dispose(); }
    });
});

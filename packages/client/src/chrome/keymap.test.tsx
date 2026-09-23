import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';

import { chordKeysForBindings } from '../content/bridge';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { createPluginChrome, type ChromeKeymap, type ChromeSnapshot } from '../plugins/chrome';
import { usePluginCommands } from '../plugins/commands';
import { resolvePluginChords } from '../plugins/shortcuts';
import { createKelpiRuntime } from '../state/bridge';
import { createKelpiStore } from '../state/store';
import { KEYMAP_SNAPSHOT_BYTES, boundKeymap, buildKeymap, nativeChordOwners, type KeymapPluginCommand } from './keymap';
import { clientKeyBindings } from './keys';

afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
});

interface Command extends KeymapPluginCommand {
    readonly shortcut?: string | undefined;
    readonly visible: boolean;
    readonly enabled: boolean;
}

function command(name: string, shortcut?: string, extra: Partial<Command> = {}): Command {
    return {
        id: `sample.one.${name}`,
        title: `Sample ${name}`,
        pluginID: 'sample.one',
        pluginName: 'Sample One',
        shortcut,
        visible: true,
        enabled: true,
        ...extra
    };
}

function keymap(
    options: { lines?: string[]; commands?: Command[]; global?: string | null; macLike?: boolean } = {}
): ChromeKeymap {
    const macLike = options.macLike ?? true;
    const bindings = clientKeyBindings(options.lines ?? [], macLike);
    const native = nativeChordOwners(bindings, options.global ?? null, macLike);
    const plugins = resolvePluginChords(options.commands ?? [], native.keys(), macLike);
    return buildKeymap({ bindings, native, plugins, macLike });
}

const nativeShortcut = (map: ChromeKeymap, action: string): string | null | undefined =>
    map.sections.flatMap((section) => section.actions).find((row) => row.action === action)?.shortcut;
const pluginRow = (map: ChromeKeymap, id: string) =>
    map.plugins.flatMap((plugin) => plugin.commands).find((row) => row.id === id);

describe('the keymap model', () => {
    it('lists native actions by visible category from the live map, rebinds and unbinds included', () => {
        const map = keymap();
        expect(map.sections.map((section) => section.category)).toEqual([
            'Pane Management',
            'Navigation',
            'Workspaces',
            'View',
            'Files',
            'Search',
            'Clipboard',
            'Terminal'
        ]);
        expect(nativeShortcut(map, 'split_right')).toBe('⌘D');
        expect(nativeShortcut(keymap({ lines: ['super+shift+k=split_right'] }), 'split_right')).toBe('⇧⌘K');
        expect(nativeShortcut(keymap({ lines: ['super+d=unbind'] }), 'split_right')).toBeNull();
        expect(map.plugins).toEqual([]);
        expect(map.withheld).toBe(0);
    });

    it('groups plugin commands under their display name with the shortcut that runs them', () => {
        const map = keymap({
            commands: [
                command('run', 'ctrl+alt+b'),
                command('plain'),
                command('other', 'super+alt+j', { id: 'sample.two.other', pluginID: 'sample.two', pluginName: 'Sample Two' })
            ]
        });
        expect(map.plugins).toEqual([
            {
                name: 'Sample One',
                commands: [
                    { id: 'sample.one.run', title: 'Sample run', shortcut: '⌃⌥B', shadowed: null },
                    { id: 'sample.one.plain', title: 'Sample plain', shortcut: null, shadowed: null }
                ]
            },
            { name: 'Sample Two', commands: [{ id: 'sample.two.other', title: 'Sample other', shortcut: '⌥⌘J', shadowed: null }] }
        ]);
    });

    it('spells a plugin chord the way the platform fires it', () => {
        const map = keymap({ commands: [command('run', 'super+shift+b')], macLike: false });
        expect(pluginRow(map, 'sample.one.run')?.shortcut).toBe('Ctrl+Shift+B');
        expect(nativeShortcut(map, 'split_right')).toBe('Ctrl+D');
    });

    it('lists a conditional command with its shortcut whatever its context says', () => {
        const map = keymap({ commands: [command('hidden', 'ctrl+alt+h', { visible: false }), command('disabled', 'ctrl+alt+d', { enabled: false })] });
        expect(pluginRow(map, 'sample.one.hidden')).toMatchObject({ shortcut: '⌃⌥H', shadowed: null });
        expect(pluginRow(map, 'sample.one.disabled')).toMatchObject({ shortcut: '⌃⌥D', shadowed: null });
    });

    it('shows no shortcut for an unbound override or one that can never fire', () => {
        const map = keymap({ commands: [command('cleared', undefined), command('typing', 'b'), command('shifted', 'shift+b'), command('nonsense', 'banana+b')] });
        for (const id of ['cleared', 'typing', 'shifted', 'nonsense']) {
            expect(pluginRow(map, `sample.one.${id}`)).toMatchObject({ shortcut: null, shadowed: null });
        }
    });

    it('names the native action, window chord or global hotkey that runs on a shadowed plugin shortcut', () => {
        const map = keymap({
            global: 'ctrl+alt+space',
            commands: [command('split', 'super+d'), command('settings', 'super+comma'), command('help', 'super+shift+slash'), command('global', 'ctrl+alt+space')]
        });
        expect(pluginRow(map, 'sample.one.split')).toEqual({
            id: 'sample.one.split',
            title: 'Sample split',
            shortcut: null,
            shadowed: { shortcut: '⌘D', by: 'Split Right', plugin: null }
        });
        expect(pluginRow(map, 'sample.one.settings')?.shadowed).toEqual({ shortcut: '⌘,', by: 'Settings', plugin: null });
        expect(pluginRow(map, 'sample.one.help')?.shadowed).toEqual({ shortcut: '⇧⌘/', by: 'Kelpi Help', plugin: null });
        expect(pluginRow(map, 'sample.one.global')?.shadowed).toEqual({ shortcut: '⌃⌥Space', by: 'Global hotkey', plugin: null });
    });

    it('frees a plugin shortcut the user unbinds natively, and shadows one a rebind takes', () => {
        const freed = keymap({ lines: ['super+d=unbind'], commands: [command('split', 'super+d')] });
        expect(pluginRow(freed, 'sample.one.split')).toMatchObject({ shortcut: '⌘D', shadowed: null });
        const taken = keymap({ lines: ['ctrl+alt+b=toggle_zoom'], commands: [command('run', 'ctrl+alt+b')] });
        expect(pluginRow(taken, 'sample.one.run')?.shadowed).toEqual({ shortcut: '⌃⌥B', by: 'Toggle Zoom', plugin: null });
    });

    it('gives a collision between plugins to the first command that applies', () => {
        const second = { id: 'sample.two.run', pluginID: 'sample.two', pluginName: 'Sample Two' };
        const both = keymap({ commands: [command('run', 'ctrl+alt+b'), command('run', 'ctrl+alt+b', second)] });
        expect(pluginRow(both, 'sample.one.run')).toMatchObject({ shortcut: '⌃⌥B', shadowed: null });
        expect(pluginRow(both, 'sample.two.run')).toMatchObject({
            shortcut: null,
            shadowed: { shortcut: '⌃⌥B', by: 'Sample run', plugin: 'Sample One' }
        });
        // An earlier command that does not apply right now claims nothing: the later one runs, and
        // the earlier one is still told what its chord would run the moment it did apply.
        const idle = keymap({ commands: [command('run', 'ctrl+alt+b', { visible: false }), command('run', 'ctrl+alt+b', second)] });
        expect(pluginRow(idle, 'sample.one.run')).toMatchObject({ shortcut: '⌃⌥B', shadowed: null });
        expect(pluginRow(idle, 'sample.two.run')).toMatchObject({ shortcut: '⌃⌥B', shadowed: null });
    });

    it('keeps two plugins that share a display name apart', () => {
        const map = keymap({ commands: [command('a', 'ctrl+alt+a'), command('b', 'ctrl+alt+c', { id: 'sample.two.b', pluginID: 'sample.two' })] });
        expect(map.plugins.map((plugin) => [plugin.name, plugin.commands.length])).toEqual([
            ['Sample One', 1],
            ['Sample One', 1]
        ]);
    });

    it('reserves exactly the chords the window claims before a plugin', () => {
        const bindings = clientKeyBindings([], true);
        const owners = nativeChordOwners(bindings, 'ctrl+alt+space', true);
        for (const key of chordKeysForBindings(bindings)) expect(owners.has(key)).toBe(true);
        for (const key of ['8/Comma', '8/Slash', '12/Slash', '3/Space']) expect(owners.has(key)).toBe(true);
        // Copy is omitted from the content-frame relay but a plugin still may not take it.
        expect(owners.get('8/KeyC')).toBe('Copy');
    });
});

describe('the bounded snapshot keymap', () => {
    const many = (plugins: number, commands: number): ChromeKeymap =>
        keymap({
            commands: Array.from({ length: plugins }, (_, plugin) =>
                Array.from({ length: commands }, (_, index) =>
                    command(`c${index}`, index === 0 ? `ctrl+alt+${String.fromCharCode(97 + (plugin % 26))}` : undefined, {
                        id: `sample.p${plugin}.c${index}`,
                        title: `${'T'.repeat(190)} ${index}`,
                        pluginID: `sample.p${plugin}`,
                        pluginName: `${'P'.repeat(190)} ${plugin}`
                    })
                )
            ).flat()
        });

    it('publishes the whole map when it fits', () => {
        const map = keymap({ commands: [command('run', 'ctrl+alt+b')] });
        expect(boundKeymap(map)).toEqual(map);
    });

    it('carries a prefix of the plugin commands within budget and counts the rest', () => {
        const full = many(100, 100);
        const bounded = boundKeymap(full);
        const carried = bounded.plugins.flatMap((plugin) => plugin.commands);
        const all = full.plugins.flatMap((plugin) => plugin.commands);
        expect(carried.length).toBeGreaterThan(100);
        expect(carried).toEqual(all.slice(0, carried.length));
        expect(bounded.withheld).toBe(all.length - carried.length);
        expect(bounded.sections).toBe(full.sections);
        expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(KEYMAP_SNAPSHOT_BYTES);
    });

    it('keeps the largest keymap deliverable inside the chrome frame, frozen and closure-free', () => {
        const snapshot = {
            connection: 'connected', ready: true, remoteWorkspaceSelected: false, workspace: null, focusedPane: null,
            sidebars: { left: { viewID: 'kelpi.workspaces', title: 'Workspaces', visible: true }, right: { viewID: 'kelpi.inspector', title: 'Inspector', visible: false } },
            sizeControl: 'this-window', layouts: [], commands: [], agents: { running: 0, waiting: 0, inactive: 0 }, agentPanes: [], git: null, systemStats: null, items: [],
            keymap: boundKeymap(many(100, 100))
        } satisfies ChromeSnapshot;
        const model = createPluginChrome({ snapshot: () => snapshot, execute: () => {} });
        const published = model.getChrome();
        expect(published.keymap.withheld).toBeGreaterThan(0);
        expect(published.keymap).toEqual(snapshot.keymap);
        expect(Object.isFrozen(published.keymap.plugins[0]?.commands[0])).toBe(true);
        model.dispose();
    });
});

describe('the dispatcher and the model agree', () => {
    const manifest = (id: string, name: string, commands: object[]) =>
        decodePluginManifest({ id, name, version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs', contributes: { commands } });
    const plugin = (id: string, name: string, extra: Partial<PluginInfo> = {}): PluginInfo => ({
        manifest: manifest(id, name, [
            { id: `${id}.run`, title: `${name} run`, shortcut: 'ctrl+alt+b' },
            { id: `${id}.later`, title: `${name} later`, when: { 'context.never': true } }
        ]),
        enabled: true,
        revision: 'r1',
        instanceID: `${id}-i1`,
        status: 'running',
        error: null,
        ...extra
    });

    function Host(props: { runtime: ReturnType<typeof createKelpiRuntime>; reserved: readonly string[] }) {
        const commands = usePluginCommands(props.runtime, props.reserved);
        const bindings = clientKeyBindings([], true);
        const map = buildKeymap({ bindings, native: nativeChordOwners(bindings, null, true), plugins: commands.shortcuts, macLike: true });
        return (
            <>
                <output data-testid="chords">{commands.chords.join(',')}</output>
                <output data-testid="keymap">{JSON.stringify(map.plugins)}</output>
            </>
        );
    }

    it('lists only enabled, running plugins, with their overrides, and the chord the dispatcher holds', async () => {
        localStorage.setItem('kelpi.plugin-shortcuts.v1:daemon-one', JSON.stringify({ 'sample.one.run': 'ctrl+alt+j' }));
        const plugins = [
            plugin('sample.one', 'Sample One'),
            plugin('sample.two', 'Sample Two'),
            plugin('sample.off', 'Disabled', { enabled: false, status: 'disabled' }),
            plugin('sample.bad', 'Failed', { status: 'failed', error: 'boom' })
        ];
        const sockets = createFakeSocketFactory();
        const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://daemon.test/ws', token: 'test', socketFactory: sockets.factory, notifications: null });
        vi.spyOn(runtime.commands, 'raw').mockImplementation(async (payload) => ({
            ok: true,
            result: payload['action'] === 'list' ? (plugins as never) : payload['action'] === 'identity' ? { daemonID: 'daemon-one' } : null
        }));
        runtime.connect();
        completeHandshake(sockets.last());
        try {
            render(<Host runtime={runtime} reserved={[...nativeChordOwners(clientKeyBindings([], true), null, true).keys()]} />);
            await waitFor(() => expect(screen.getByTestId('chords').textContent).toBe('3/KeyJ,3/KeyB'));
            const groups = JSON.parse(screen.getByTestId('keymap').textContent ?? '[]') as ChromeKeymap['plugins'];
            expect(groups.map((group) => group.name)).toEqual(['Sample One', 'Sample Two']);
            // The rebind moved Sample One off ⌃⌥B, so Sample Two's default is free again.
            expect(groups[0]?.commands).toEqual([
                { id: 'sample.one.run', title: 'Sample One run', shortcut: '⌃⌥J', shadowed: null },
                { id: 'sample.one.later', title: 'Sample One later', shortcut: null, shadowed: null }
            ]);
            expect(groups[1]?.commands[0]).toEqual({ id: 'sample.two.run', title: 'Sample Two run', shortcut: '⌃⌥B', shadowed: null });
        } finally {
            runtime.dispose();
        }
    });
});

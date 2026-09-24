import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';

import { canonicalTriggerForPlatform, parseKeyTrigger } from '@kelpi/core/config';

import { chordKeysForBindings, chordKeysForTrigger } from '../content/bridge';
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
                    { id: 'sample.one.run', title: 'Sample run', shortcut: '⌃⌥B', shadowed: null, currently: null },
                    { id: 'sample.one.plain', title: 'Sample plain', shortcut: null, shadowed: null, currently: null }
                ]
            },
            { name: 'Sample Two', commands: [{ id: 'sample.two.other', title: 'Sample other', shortcut: '⌥⌘J', shadowed: null, currently: null }] }
        ]);
    });

    it('spells a plugin chord the way the platform fires it', () => {
        const map = keymap({ commands: [command('run', 'super+shift+b')], macLike: false });
        expect(pluginRow(map, 'sample.one.run')?.shortcut).toBe('Ctrl+Shift+B');
        expect(nativeShortcut(map, 'split_right')).toBe('Ctrl+D');
    });

    it('lists a conditional command with its shortcut whatever its context says', () => {
        const map = keymap({ commands: [command('hidden', 'ctrl+alt+h', { visible: false }), command('disabled', 'ctrl+alt+d', { enabled: false })] });
        expect(pluginRow(map, 'sample.one.hidden')).toMatchObject({ shortcut: '⌃⌥H', shadowed: null, currently: null });
        expect(pluginRow(map, 'sample.one.disabled')).toMatchObject({ shortcut: '⌃⌥D', shadowed: null, currently: null });
    });

    it('shows no shortcut for an unbound override or one that can never fire', () => {
        const map = keymap({ commands: [command('cleared', undefined), command('typing', 'b'), command('shifted', 'shift+b'), command('nonsense', 'banana+b')] });
        for (const id of ['cleared', 'typing', 'shifted', 'nonsense']) {
            expect(pluginRow(map, `sample.one.${id}`)).toMatchObject({ shortcut: null, shadowed: null, currently: null });
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
            shadowed: { shortcut: '⌘D', by: 'Split Right', plugin: null },
            currently: null
        });
        expect(pluginRow(map, 'sample.one.settings')?.shadowed).toEqual({ shortcut: '⌘,', by: 'Settings', plugin: null });
        expect(pluginRow(map, 'sample.one.help')?.shadowed).toEqual({ shortcut: '⇧⌘/', by: 'Kelpi Help', plugin: null });
        expect(pluginRow(map, 'sample.one.global')?.shadowed).toEqual({ shortcut: '⌃⌥Space', by: 'Global hotkey', plugin: null });
    });

    it('frees a plugin shortcut the user unbinds natively, and shadows one a rebind takes', () => {
        const freed = keymap({ lines: ['super+d=unbind'], commands: [command('split', 'super+d')] });
        expect(pluginRow(freed, 'sample.one.split')).toMatchObject({ shortcut: '⌘D', shadowed: null, currently: null });
        const taken = keymap({ lines: ['ctrl+alt+b=toggle_zoom'], commands: [command('run', 'ctrl+alt+b')] });
        expect(pluginRow(taken, 'sample.one.run')?.shadowed).toEqual({ shortcut: '⌃⌥B', by: 'Toggle Zoom', plugin: null });
    });

    it('gives a collision between plugins to the first command that applies', () => {
        const second = { id: 'sample.two.run', pluginID: 'sample.two', pluginName: 'Sample Two' };
        const both = keymap({ commands: [command('run', 'ctrl+alt+b'), command('run', 'ctrl+alt+b', second)] });
        expect(pluginRow(both, 'sample.one.run')).toMatchObject({ shortcut: '⌃⌥B', shadowed: null, currently: null });
        expect(pluginRow(both, 'sample.two.run')).toMatchObject({
            shortcut: null,
            shadowed: { shortcut: '⌃⌥B', by: 'Sample run', plugin: 'Sample One' }
        });
        // An earlier command that does not apply right now claims nothing: the later one runs, and
        // the earlier one is still told what its chord would run the moment it did apply.
        // Right now the later one holds the chord, and the earlier row says so.
        const idle = keymap({ commands: [command('run', 'ctrl+alt+b', { visible: false }), command('run', 'ctrl+alt+b', second)] });
        expect(pluginRow(idle, 'sample.one.run')).toEqual({
            id: 'sample.one.run', title: 'Sample run', shortcut: '⌃⌥B', shadowed: null,
            currently: { by: 'Sample run', plugin: 'Sample Two' }
        });
        expect(pluginRow(idle, 'sample.two.run')).toMatchObject({ shortcut: '⌃⌥B', shadowed: null, currently: null });
        // Nothing holds an idle command's chord unless a later live command claims it.
        const alone = keymap({ commands: [command('run', 'ctrl+alt+b', { enabled: false })] });
        expect(pluginRow(alone, 'sample.one.run')).toMatchObject({ shortcut: '⌃⌥B', currently: null });
        // Once every command applies, the first one wins and the later one is shadowed instead.
        expect(pluginRow(both, 'sample.one.run')?.currently).toBeNull();
    });

    it('keeps two plugins that share a display name apart', () => {
        const map = keymap({ commands: [command('a', 'ctrl+alt+a'), command('b', 'ctrl+alt+c', { id: 'sample.two.b', pluginID: 'sample.two' })] });
        expect(map.plugins.map((plugin) => [plugin.name, plugin.commands.length])).toEqual([
            ['Sample One', 1],
            ['Sample One', 1]
        ]);
    });

    it('reserves exactly the chords the window claimed before a plugin, no more and no fewer', () => {
        // The formula `App.tsx` used before the reserved set gained names, verbatim.
        const previous = (bindings: ReturnType<typeof clientKeyBindings>, globalHotkey: string | null, macLike: boolean): string[] => {
            const contentPaneChords = [...new Set([...chordKeysForBindings(bindings), '8/Comma', '8/Slash', '12/Slash'])].sort();
            const globalTrigger = globalHotkey ? parseKeyTrigger(globalHotkey) : null;
            return [...new Set([
                ...contentPaneChords,
                ...[...bindings.values()].flatMap((binding) => chordKeysForTrigger(binding.trigger)),
                ...(globalTrigger ? chordKeysForTrigger(canonicalTriggerForPlatform(globalTrigger, macLike)) : [])
            ])].sort();
        };
        const cases: readonly (readonly [readonly string[], string | null, boolean])[] = [
            [[], 'ctrl+alt+space', true],
            [[], null, true],
            [['super+d=unbind', 'ctrl+alt+b=toggle_zoom', 'super+comma=split_down'], 'super+shift+space', false],
            [['super+c=unbind'], null, false]
        ];
        for (const [lines, globalHotkey, macLike] of cases) {
            const bindings = clientKeyBindings(lines, macLike);
            expect([...nativeChordOwners(bindings, globalHotkey, macLike).keys()].sort()).toEqual(previous(bindings, globalHotkey, macLike));
        }
        // Copy is omitted from the content-frame relay but a plugin still may not take it.
        expect(nativeChordOwners(clientKeyBindings([], true), null, true).get('8/KeyC')).toBe('Copy');
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

    it('never exceeds the budget it is given, whatever the withheld count grows to', () => {
        // One group, so the joining-comma allowance cannot hide a four-digit count's extra bytes.
        const full = many(1, 1200);
        const size = (value: ChromeKeymap): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
        const floor = size({ ...full, plugins: [], withheld: 1200 });
        for (let budget = floor; budget < floor + 6_000; budget += 1) {
            expect(size(boundKeymap(full, budget))).toBeLessThanOrEqual(budget);
        }
        // Below the native half nothing plugin-shaped is carried, and the native half still is.
        expect(boundKeymap(full, 10)).toEqual({ sections: full.sections, plugins: [], withheld: 1200 });
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

    function connect(plugins: readonly PluginInfo[]) {
        const sockets = createFakeSocketFactory();
        const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://daemon.test/ws', token: 'test', socketFactory: sockets.factory, notifications: null });
        vi.spyOn(runtime.commands, 'raw').mockImplementation(async (payload) => ({
            ok: true,
            result: payload['action'] === 'list' ? (plugins as never) : payload['action'] === 'identity' ? { daemonID: 'daemon-one' } : null
        }));
        runtime.connect();
        completeHandshake(sockets.last());
        return runtime;
    }

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
        const runtime = connect(plugins);
        try {
            render(<Host runtime={runtime} reserved={[...nativeChordOwners(clientKeyBindings([], true), null, true).keys()]} />);
            await waitFor(() => expect(screen.getByTestId('chords').textContent).toBe('3/KeyJ,3/KeyB'));
            const groups = JSON.parse(screen.getByTestId('keymap').textContent ?? '[]') as ChromeKeymap['plugins'];
            expect(groups.map((group) => group.name)).toEqual(['Sample One', 'Sample Two']);
            // The rebind moved Sample One off ⌃⌥B, so Sample Two's default is free again.
            expect(groups[0]?.commands).toEqual([
                { id: 'sample.one.run', title: 'Sample One run', shortcut: '⌃⌥J', shadowed: null, currently: null },
                { id: 'sample.one.later', title: 'Sample One later', shortcut: null, shadowed: null, currently: null }
            ]);
            expect(groups[1]?.commands[0]).toEqual({ id: 'sample.two.run', title: 'Sample Two run', shortcut: '⌃⌥B', shadowed: null, currently: null });
        } finally {
            runtime.dispose();
        }
    });
    it('keeps the resolution, and so the keymap, through a mirror tick that changes no command', async () => {
        const runtime = connect([plugin('sample.one', 'Sample One')]);
        const seen: { commands: unknown; shortcuts: unknown }[] = [];
        const reserved: readonly string[] = [];
        function Probe() {
            const commands = usePluginCommands(runtime, reserved);
            seen.push({ commands: commands.commands, shortcuts: commands.shortcuts });
            return <output data-testid="count">{commands.shortcuts.length}</output>;
        }
        try {
            render(<Probe />);
            await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
            const before = seen.at(-1)!;
            act(() => runtime.store.getState().setPaletteQuery('unrelated'));
            const after = seen.at(-1)!;
            // The tick re-derived the command rows, and the resolution built from them stayed put.
            expect(after).not.toBe(before);
            expect(after.commands).not.toBe(before.commands);
            expect(after.shortcuts).toBe(before.shortcuts);
        } finally {
            runtime.dispose();
        }
    });
});

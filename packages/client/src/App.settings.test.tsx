/**
 * Assembly tests for settings sync (M8): what the daemon's config files actually DO to the
 * running client.
 *
 * The unit tests either side of this prove the daemon reads the files and the store holds the
 * result. What only assembly can show is the consequence: a rebound key produces a different
 * wire command, the ghostty background flips the chrome bucket and tints the pane fill, and
 * `focus-follows-mouse` turns a hover into a focus report.
 */

import type { JsonObject } from '@nex/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createNexRuntime, createNexStore, type NexRuntime } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    // `paneID` is the NEW pane; the split source defaults to the workspace's focused pane.
    store.dispatch({ type: 'split-pane', workspaceID: W1, paneID: PANE_B, direction: 'horizontal', now: NOW });
    return store.getState() as unknown as JsonObject;
}

interface SettingsInput {
    readonly keybindLines?: readonly string[];
    readonly focusFollowsMouse?: boolean;
    readonly focusFollowsMouseDelay?: number;
    readonly backgroundColor?: string;
    readonly backgroundOpacity?: number;
    readonly isDark?: boolean;
    readonly fontFamily?: string | null;
    readonly fontSize?: number | null;
}

function settingsPayload(input: SettingsInput = {}): Record<string, unknown> {
    return {
        keybindLines: input.keybindLines ?? [],
        general: {
            focusFollowsMouse: input.focusFollowsMouse ?? false,
            focusFollowsMouseDelay: input.focusFollowsMouseDelay ?? 100,
            theme: null
        },
        appearance: {
            backgroundColor: input.backgroundColor ?? '#0a0a0c',
            backgroundOpacity: input.backgroundOpacity ?? 1,
            fontFamily: input.fontFamily ?? null,
            fontSize: input.fontSize ?? null,
            isDark: input.isDark ?? true,
            theme: null
        }
    };
}

interface Harness {
    readonly runtime: NexRuntime;
    readonly renderers: ReturnType<typeof createFakeRendererFactory>;
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    /** Push a `settings-changed` broadcast (the live-edit path). */
    push(input: SettingsInput): void;
}

function setup(input: SettingsInput | null = {}): Harness {
    const sockets = createFakeSocketFactory();
    const store = createNexStore();
    const runtime = createNexRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store,
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    const renderers = createFakeRendererFactory();
    render(<App runtime={runtime} createRenderer={renderers.factory} />);

    act(() => {
        const socket = sockets.last();
        socket.open();
        socket.emit({
            type: 'welcome',
            protocolVersion: 1,
            clientID: 'client-1',
            daemon: { version: '0.1.0', build: 'test', pid: 4242 },
            ...(input === null ? {} : { settings: settingsPayload(input) })
        });
        socket.emit({ type: 'snapshot', seq: 0, state: snapshotState() });
    });

    return {
        runtime,
        renderers,
        socket: () => sockets.last(),
        commands: () =>
            sockets
                .last()
                .messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        push(next) {
            act(() => {
                sockets.last().emit({ type: 'settings-changed', settings: settingsPayload(next) });
            });
        }
    };
}

afterEach(() => {
    cleanup();
});

// ── keybindings ─────────────────────────────────────────────────────────────────────

describe('the key dispatcher is built from the synced keybind lines', () => {
    const pressCtrlAltT = (): void => {
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyT', ctrlKey: true, altKey: true });
        });
    };

    it('ignores a trigger the config never bound', () => {
        const h = setup();
        pressCtrlAltT();
        expect(h.commands().filter((command) => command['command'] === 'pane-split')).toHaveLength(0);
    });

    it('honours a config-file override', () => {
        const h = setup({ keybindLines: ['ctrl+alt+t=split_right'] });
        pressCtrlAltT();
        const splits = h.commands().filter((command) => command['command'] === 'pane-split');
        expect(splits).toHaveLength(1);
        expect(splits[0]?.['direction']).toBe('horizontal');
    });

    it('honours an `unbind` line: the shipped ⌘D stops splitting', () => {
        const h = setup({ keybindLines: ['super+d=unbind'] });
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyD', metaKey: true });
        });
        expect(h.commands().filter((command) => command['command'] === 'pane-split')).toHaveLength(0);
    });

    it('rebuilds the dispatcher when the file changes while the client is running', () => {
        const h = setup();
        pressCtrlAltT();
        expect(h.commands().filter((command) => command['command'] === 'pane-split')).toHaveLength(0);

        h.push({ keybindLines: ['ctrl+alt+t=split_down'] });
        pressCtrlAltT();
        const splits = h.commands().filter((command) => command['command'] === 'pane-split');
        expect(splits).toHaveLength(1);
        expect(splits[0]?.['direction']).toBe('vertical');
    });

    it('falls back to the shipped defaults when the daemon sends no settings at all', () => {
        const h = setup(null);
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyD', metaKey: true });
        });
        expect(h.commands().filter((command) => command['command'] === 'pane-split')).toHaveLength(1);
    });
});

// ── appearance ──────────────────────────────────────────────────────────────────────

describe('appearance follows the ghostty config', () => {
    // `applyToDocument` stamps <html> as well, so the provider's own DIV has to be named
    // explicitly — it is the one carrying the `--nex-*` custom properties for the tree.
    const themeRoot = (): HTMLElement => {
        const element = document.querySelector('div[data-nex-theme]');
        if (element === null) throw new Error('no theme container rendered');
        return element as HTMLElement;
    };

    it('picks the chrome bucket from the daemon’s luminance verdict, not the OS', () => {
        setup({ backgroundColor: '#ffffff', isDark: false });
        expect(themeRoot().dataset['nexTheme']).toBe('light');
    });

    it('flips live when the ghostty background changes', () => {
        const h = setup({ backgroundColor: '#ffffff', isDark: false });
        expect(themeRoot().dataset['nexTheme']).toBe('light');
        h.push({ backgroundColor: '#1a1b26', isDark: true });
        expect(themeRoot().dataset['nexTheme']).toBe('dark');
    });

    it('tints every pane container with the background at the ghostty opacity', () => {
        setup({ backgroundColor: '#1a1b26', backgroundOpacity: 0.5, isDark: true });
        expect(themeRoot().style.getPropertyValue('--nex-term-bg')).toBe('rgba(26, 27, 38, 0.5)');
        const pane = screen.getByTestId(`pane-${PANE_A}`).querySelector('[data-terminal-status]');
        expect((pane as HTMLElement).style.backgroundColor).toBe('rgba(26, 27, 38, 0.5)');
    });

    it('hands the engine an opaque hex background (ghostty-web maps rgba() to black)', () => {
        const h = setup({ backgroundColor: '#1a1b26', backgroundOpacity: 0.5, isDark: true });
        // Every pane's engine gets the same appearance; the first one built is enough.
        const renderer = h.renderers.instances[0];
        // `normalizeHexColor` uppercases; what matters is that it is an opaque HEX.
        expect(renderer?.options?.theme?.background).toBe('#1A1B26');
    });

    it('passes the ghostty font through to the engine', () => {
        const h = setup({ fontFamily: 'Menlo', fontSize: 15 });
        const renderer = h.renderers.instances[0];
        expect(renderer?.options?.fontFamily).toBe('Menlo');
        expect(renderer?.options?.fontSize).toBe(15);
    });

    it('leaves the engine on its own defaults when ghostty sets no font', () => {
        const h = setup();
        const renderer = h.renderers.instances[0];
        expect(renderer?.options?.fontFamily).toBeUndefined();
        expect(renderer?.options?.fontSize).toBeUndefined();
    });
});

// ── focus follows mouse ─────────────────────────────────────────────────────────────

describe('focus-follows-mouse comes from the config file', () => {
    const hover = (paneID: string): void => {
        act(() => {
            fireEvent.pointerEnter(screen.getByTestId(`pane-${paneID}`));
        });
    };
    const focusReports = (h: Harness): Record<string, unknown>[] =>
        h
            .socket()
            .messages()
            .filter((message) => message['type'] === 'focus-report');

    // The split leaves PANE_B focused, so PANE_A is the pane a hover can actually move to.
    it('does nothing while the setting is off', () => {
        const h = setup();
        const before = focusReports(h).length;
        hover(PANE_A);
        expect(focusReports(h)).toHaveLength(before);
    });

    it('focuses the hovered pane immediately at delay 0', () => {
        const h = setup({ focusFollowsMouse: true, focusFollowsMouseDelay: 0 });
        hover(PANE_A);
        expect(focusReports(h).at(-1)?.['paneID']).toBe(PANE_A);
    });

    it('waits out the configured delay before focusing', async () => {
        const h = setup({ focusFollowsMouse: true, focusFollowsMouseDelay: 40 });
        hover(PANE_A);
        expect(focusReports(h).at(-1)?.['paneID']).not.toBe(PANE_A);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 70));
        });
        expect(focusReports(h).at(-1)?.['paneID']).toBe(PANE_A);
    });

    it('turns on live when the config file changes', () => {
        const h = setup();
        hover(PANE_A);
        expect(focusReports(h).at(-1)?.['paneID']).not.toBe(PANE_A);
        h.push({ focusFollowsMouse: true, focusFollowsMouseDelay: 0 });
        hover(PANE_A);
        expect(focusReports(h).at(-1)?.['paneID']).toBe(PANE_A);
    });
});

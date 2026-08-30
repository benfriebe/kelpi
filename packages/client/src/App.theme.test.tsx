/**
 * §APP-014 assembly: `theme = <name>`, resolved by the daemon, applied to a RUNNING client.
 *
 * The unit tests either side of this prove the daemon finds the theme file and that the merge
 * is faithful. What only assembly can show is the consequence, and it is the whole of the
 * item: a `settings-changed` broadcast carrying a resolved palette re-themes the panes that
 * are already on screen — no relaunch, no re-mount — which is what libghostty's
 * `ghostty_app_update_config` did for the Swift app.
 *
 * Shaped after `App.settings.test.tsx`, whose harness this borrows: same fake socket, same
 * fake renderer, same `push()` for the live edit.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from './state';
import { DEFAULT_TERMINAL_THEME } from './terminal';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

/** The `Nord` file's colours, as the daemon would have parsed them. */
const NORD_PALETTE = {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#eceff4',
    red: '#bf616a',
    brightBlue: '#81a1c1'
};

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: PANE_A,
        name: 'dev',
        color: 'blue',
        now: NOW
    });
    return store.getState() as unknown as JsonObject;
}

interface ThemeInput {
    readonly backgroundColor?: string;
    readonly isDark?: boolean;
    readonly name?: string | null;
    readonly path?: string | null;
    readonly palette?: Readonly<Record<string, string>>;
    readonly error?: string | null;
    /** Omit `terminalTheme` entirely — an older daemon that has never heard of §APP-014. */
    readonly legacy?: boolean;
}

function settingsPayload(input: ThemeInput = {}): Record<string, unknown> {
    const appearance: Record<string, unknown> = {
        backgroundColor: input.backgroundColor ?? '#0a0a0c',
        backgroundOpacity: 1,
        fontFamily: null,
        fontSize: null,
        isDark: input.isDark ?? true,
        theme: input.name ?? null
    };
    if (input.legacy !== true) {
        appearance['terminalTheme'] = {
            name: input.name ?? null,
            path: input.path ?? (input.name === undefined || input.name === null ? null : `/themes/${input.name}`),
            palette: input.palette ?? {},
            error: input.error ?? null
        };
    }
    return {
        keybindLines: [],
        general: { focusFollowsMouse: false, focusFollowsMouseDelay: 100, theme: null },
        appearance
    };
}

interface Harness {
    readonly runtime: KelpiRuntime;
    readonly renderers: ReturnType<typeof createFakeRendererFactory>;
    socket(): FakeWebSocket;
    push(input: ThemeInput): void;
}

function setup(input: ThemeInput = {}): Harness {
    const sockets = createFakeSocketFactory();
    const store = createKelpiStore();
    const runtime = createKelpiRuntime({
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
            settings: settingsPayload(input)
        });
        socket.emit({ type: 'snapshot', seq: 0, state: snapshotState() });
    });
    return {
        runtime,
        renderers,
        socket: () => sockets.last(),
        push(next) {
            act(() => {
                sockets.last().emit({ type: 'settings-changed', settings: settingsPayload(next) });
            });
        }
    };
}

/** The provider's own div — `applyToDocument` stamps `<html>` too, so it is named explicitly. */
function themeRoot(): HTMLElement {
    const element = document.querySelector('div[data-kelpi-theme]');
    if (element === null) throw new Error('no theme container rendered');
    return element as HTMLElement;
}

/** The last theme this pane's engine was actually given. */
function appliedTheme(h: Harness): Record<string, unknown> {
    const themes = h.renderers.last().themes;
    const last = themes.at(-1);
    if (last === undefined) throw new Error('the renderer was never given a theme');
    return last as Record<string, unknown>;
}

afterEach(() => {
    cleanup();
});

describe('a resolved terminal theme reaches the panes', () => {
    it('hands the theme’s colours to the engine, over the preset', () => {
        const h = setup({ name: 'Nord', palette: NORD_PALETTE, backgroundColor: '#2e3440' });
        const theme = appliedTheme(h);
        expect(theme['foreground']).toBe('#d8dee9');
        expect(theme['red']).toBe('#bf616a');
        expect(theme['brightBlue']).toBe('#81a1c1');
        // Not named by the theme → still the preset's value, never blanked.
        expect(theme['brightWhite']).toBe(DEFAULT_TERMINAL_THEME.brightWhite);
    });

    it('publishes the palette as --kelpi-term-* on the theme container', () => {
        setup({ name: 'Nord', palette: NORD_PALETTE, backgroundColor: '#2e3440' });
        const style = themeRoot().style;
        expect(style.getPropertyValue('--kelpi-term-fg')).toBe('#d8dee9');
        expect(style.getPropertyValue('--kelpi-term-red')).toBe('#bf616a');
        // The pane FILL stays the background at the ghostty opacity (§APP-012), not the raw hex.
        expect(style.getPropertyValue('--kelpi-term-bg')).toContain('46, 52, 64');
    });

    it('re-themes a pane that is ALREADY on screen when the config changes', () => {
        const h = setup();
        const before = appliedTheme(h);
        expect(before['foreground']).toBe(DEFAULT_TERMINAL_THEME.foreground);

        h.push({ name: 'Nord', palette: NORD_PALETTE, backgroundColor: '#2e3440' });
        const after = appliedTheme(h);
        expect(after['foreground']).toBe('#d8dee9');
        expect(themeRoot().style.getPropertyValue('--kelpi-term-fg')).toBe('#d8dee9');
        // One renderer throughout: the pane was re-themed, not rebuilt.
        expect(h.renderers.instances).toHaveLength(1);
        expect(h.renderers.last().disposed).toBe(false);
    });

    it('drops back to the preset when the theme is removed', () => {
        const h = setup({ name: 'Nord', palette: NORD_PALETTE, backgroundColor: '#2e3440' });
        expect(appliedTheme(h)['foreground']).toBe('#d8dee9');
        h.push({});
        expect(appliedTheme(h)['foreground']).toBe(DEFAULT_TERMINAL_THEME.foreground);
        expect(themeRoot().style.getPropertyValue('--kelpi-term-fg')).toBe('');
    });

    it('keeps the preset — and changes nothing — when the name does not resolve', () => {
        const h = setup({ name: 'Made Up', path: null, error: 'No ghostty theme file named “Made Up” was found.' });
        const theme = appliedTheme(h);
        expect(theme['foreground']).toBe(DEFAULT_TERMINAL_THEME.foreground);
        expect(String(theme['background']).toLowerCase()).toBe('#0a0a0c');
        expect(themeRoot().style.getPropertyValue('--kelpi-term-fg')).toBe('');
    });

    it('is unbothered by a daemon that never sends the field at all', () => {
        const h = setup({ legacy: true });
        expect(appliedTheme(h)['foreground']).toBe(DEFAULT_TERMINAL_THEME.foreground);
    });
});

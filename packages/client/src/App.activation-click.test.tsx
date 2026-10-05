/**
 * #339 - clicking a pane of a background window focuses THAT pane.
 *
 * The shell reports the window inactive (`shell-activation`), and the next primary press is the
 * one that brought it forward: it moves the ring and the caret to the pane it landed in, and
 * nothing under it hears the press (no TUI mouse report, no selection, no button). Assembly-level
 * because the defect is about the ring and `document.activeElement` after a real press goes
 * through the real grid, which no unit below `App` can see.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const LEFT = 'DDDDDDDD-0000-4000-8000-000000000001';
const RIGHT = 'DDDDDDDD-0000-4000-8000-000000000002';
const SHELL_WINDOW = 'window-under-test';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: LEFT, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({
        type: 'split-pane',
        workspaceID: W1,
        paneID: RIGHT,
        direction: 'horizontal',
        sourcePaneID: LEFT,
        now: NOW,
        focus: false
    });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    focusReports(): Record<string, unknown>[];
}

async function setup(): Promise<Harness> {
    window.history.replaceState({}, '', `/?shellWindow=${SHELL_WINDOW}`);
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store: createKelpiStore(),
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory({ autoFocusOnOpen: true }).factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
    // The user is typing in the left pane, and every engine has finished its own opening grab.
    await waitFor(() => {
        expect(hostOf(LEFT).contains(document.activeElement)).toBe(true);
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(hostOf(LEFT).contains(document.activeElement)).toBe(true);
    return {
        socket: () => sockets.last(),
        focusReports: () => sockets.last().messages().filter((message) => message['type'] === 'focus-report')
    };
}

function hostOf(paneID: string): HTMLElement {
    const host = document.querySelector(`[data-pane-id="${paneID}"] [data-terminal-host]`);
    expect(host).not.toBeNull();
    return host as HTMLElement;
}

function ringOn(): string | null {
    return document.querySelector('[data-pane-id][data-focused="true"]')?.getAttribute('data-pane-id') ?? null;
}

function windowActive(h: Harness, active: boolean): void {
    act(() => {
        h.socket().emit({ type: 'shell-activation', active, windowID: SHELL_WINDOW });
    });
}

function clickOn(element: Element): void {
    act(() => {
        fireEvent.mouseDown(element);
        fireEvent.mouseUp(element);
        fireEvent.click(element);
    });
}

afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
});

describe('the click that brings a background window forward (#339)', () => {
    it('moves the ring and the caret to the pane it lands in', async () => {
        const h = await setup();
        expect(ringOn()).toBe(LEFT);
        windowActive(h, false);
        clickOn(hostOf(RIGHT));
        await waitFor(() => {
            expect(ringOn()).toBe(RIGHT);
        });
        expect(hostOf(RIGHT).contains(document.activeElement)).toBe(true);
        expect(h.focusReports()).toContainEqual({ type: 'focus-report', workspaceID: W1, paneID: RIGHT });
    });

    it('is not heard by anything inside the pane', async () => {
        const h = await setup();
        const heard: string[] = [];
        for (const type of ['mousedown', 'mouseup', 'click']) hostOf(RIGHT).addEventListener(type, () => heard.push(type));
        windowActive(h, false);
        clickOn(hostOf(RIGHT));
        await waitFor(() => {
            expect(ringOn()).toBe(RIGHT);
        });
        expect(heard).toEqual([]);
    });

    it('leaves the next click an ordinary one', async () => {
        const h = await setup();
        windowActive(h, false);
        clickOn(hostOf(RIGHT));
        windowActive(h, true);
        const heard: string[] = [];
        for (const type of ['mousedown', 'mouseup', 'click']) hostOf(LEFT).addEventListener(type, () => heard.push(type));
        clickOn(hostOf(LEFT));
        await waitFor(() => {
            expect(ringOn()).toBe(LEFT);
        });
        expect(heard).toEqual(['mousedown', 'mouseup', 'click']);
    });

    it('does nothing to an active window', async () => {
        await setup();
        const heard: string[] = [];
        for (const type of ['mousedown', 'mouseup', 'click']) hostOf(RIGHT).addEventListener(type, () => heard.push(type));
        clickOn(hostOf(RIGHT));
        await waitFor(() => {
            expect(ringOn()).toBe(RIGHT);
        });
        expect(heard).toEqual(['mousedown', 'mouseup', 'click']);
    });
});

/**
 * §H4 — the pane header abbreviates the daemon's home directory, exactly as the status footer
 * three rows below it does.
 *
 * `PaneHeaderView.swift:503` runs every header title through `chromeHomeAbbreviated`
 * (`ChromeTheme.swift:244-249`), unconditionally. The port has the same helper
 * (`grid/PaneHeader.tsx` `homeAbbreviated`) and the same `homeDirectory` prop, but the App only
 * ever handed the value to `<StatusFooter>` — so `PaneGrid` fell back to its `homeDirectory = ''`
 * default, `homeAbbreviated` returned early, and the SAME pane read `/Users/…` in its header and
 * `~/…` in the footer. `run-O/53-agent-lifecycle-quit-dialog.png` caught it as a literal `/home`.
 *
 * The assertion that matters is therefore not "the header abbreviates" on its own — it is that
 * the two surfaces agree, from one daemon-supplied home, in one render of the real App.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import type { JsonObject } from '@nex/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createNexRuntime, createNexStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const HOME = '/Users/test';
const CWD = `${HOME}/code/nex`;
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState(HOME));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: PANE_A,
        name: 'dev',
        color: 'blue',
        workingDirectory: CWD,
        now: NOW
    });
    return store.getState() as unknown as JsonObject;
}

/**
 * The handshake, spelled out rather than borrowed from `completeHandshake`, because the field
 * under test is the one that helper does not send: `daemon.home` (§APP-069 — the DAEMON host's
 * home, since every path this client renders is the daemon's).
 */
function handshake(socket: FakeWebSocket, options: { home?: string } = {}): void {
    socket.open();
    socket.emit({
        type: 'welcome',
        protocolVersion: 1,
        clientID: 'client-1',
        daemon: {
            version: '0.1.0',
            build: 'test',
            pid: 4242,
            ...(options.home === undefined ? {} : { home: options.home })
        }
    });
    socket.emit({ type: 'snapshot', seq: 0, state: snapshotState() });
}

function boot(options: { home?: string } = {}): void {
    const sockets = createFakeSocketFactory();
    const runtime = createNexRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store: createNexStore(),
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => {
        handshake(sockets.last(), options);
    });
}

afterEach(cleanup);

describe('the pane header path', () => {
    it('abbreviates the daemon home, and agrees with the footer about the same pane', () => {
        boot({ home: HOME });

        expect(screen.getByTestId(`pane-title-${PANE_A}`).textContent).toBe('~/code/nex');
        // The footer describes the same pane from the same home; the two must not disagree.
        expect(screen.getByTestId('footer-cwd').textContent).toBe('~/code/nex');
    });

    /**
     * A daemon that predates `home` sends no value at all (the field is optional), and the
     * fallback is the honest one: the full path, in BOTH places — never a header that abbreviates
     * against a footer that does not.
     */
    it('prints the full path when the daemon reports no home', () => {
        boot();

        expect(screen.getByTestId(`pane-title-${PANE_A}`).textContent).toBe(CWD);
        expect(screen.getByTestId('footer-cwd').textContent).toBe(CWD);
    });
});

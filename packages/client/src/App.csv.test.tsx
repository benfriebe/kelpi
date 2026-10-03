/**
 * #324 at the assembly: a csv pane mounted by the real App against a scripted daemon socket.
 *
 * What only the assembly can show: the grid speaks the csv verbs and NOT the content service,
 * ⌘E routes to the raw-text toggle (or explains why it cannot), ⌘F opens the grid's own find
 * bar, the header's header-row control sends `csv-set-header-row`, and on a phone the same pane
 * comes up touch-first.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import type { StorageLike } from './app/config';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { csvState } from './content/csv/testing';
import type { CsvPaneState } from './content/csv/types';
import { PHONE_PLACE_KEY } from './phone';
import { createFakePhoneWindow } from './phone/testing';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_CSV = 'DDDDDDDD-0000-4000-8000-0000000000C5';
const NOW = 1_755_500_000_000;

/**
 * A workspace whose focused pane is a csv pane. Built from a markdown pane and retyped, so the
 * fixture does not depend on the daemon reducer's csv route: the client renders whatever the
 * mirror says the pane is.
 */
function snapshotState(options: { editing?: boolean } = {}): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: PANE_CSV, filePath: '/repo/sales.csv', now: NOW });
    const state = JSON.parse(JSON.stringify(store.getState())) as { workspaces: { panes: Record<string, unknown>[] }[] };
    for (const workspace of state.workspaces) {
        for (const pane of workspace.panes) {
            if (pane['id'] !== PANE_CSV) continue;
            pane['type'] = 'csv';
            pane['csvHeaderRow'] = true;
            pane['isEditing'] = options.editing === true;
        }
    }
    return state as unknown as JsonObject;
}

function memoryStorage(initial: Record<string, string>): StorageLike {
    const map = new Map(Object.entries(initial));
    return {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        }
    };
}

interface Harness {
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    answer(command: string, reply: Record<string, unknown>): void;
    /** Answer the pane's `csv-subscribe`, then every `csv-rows` with a small table. */
    seed(overrides?: Partial<CsvPaneState>): Promise<void>;
}

const TABLE = [
    ['region', 'units'],
    ['north', '12'],
    ['south', '7'],
    ['east', '30']
];

function setup(options: { phone?: boolean; editing?: boolean } = {}): Harness {
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
    render(
        <App
            runtime={runtime}
            createRenderer={createFakeRendererFactory().factory}
            {...(options.phone === true
                ? {
                      formFactorWindow: createFakePhoneWindow(),
                      phoneHostStorage: memoryStorage({ [PHONE_PLACE_KEY]: JSON.stringify({ host: 'origin', workspaceID: W1 }) })
                  }
                : {})}
        />
    );
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState({ editing: options.editing === true }) });
    });
    const frames = (): Record<string, unknown>[] => sockets.last().messages().filter((message) => message['type'] === 'command');
    const answered = new Set<string>();
    const harness: Harness = {
        socket: () => sockets.last(),
        commands: () => frames().map((frame) => frame['payload'] as Record<string, unknown>),
        answer(command, reply) {
            const frame = [...frames()].reverse().find((entry) => (entry['payload'] as Record<string, unknown>)['command'] === command);
            if (frame === undefined) throw new Error(`no ${command} was sent`);
            act(() => {
                sockets.last().emit({ type: 'command-reply', id: frame['id'] as string, reply });
            });
        },
        async seed(overrides = {}) {
            const state = csvState({ paneID: PANE_CSV, rowCount: TABLE.length, columns: [0, 1], filePath: '/repo/sales.csv', ...overrides });
            await waitFor(() => {
                expect(harness.commands().some((payload) => payload['command'] === 'csv-subscribe')).toBe(true);
            });
            harness.answer('csv-subscribe', { ok: true, pane_id: PANE_CSV, state });
            for (let round = 0; round < 4; round++) {
                for (const frame of frames()) {
                    const payload = frame['payload'] as Record<string, unknown>;
                    const id = frame['id'] as string;
                    if (payload['command'] !== 'csv-rows' || answered.has(id)) continue;
                    answered.add(id);
                    const start = payload['start'] as number;
                    const count = payload['count'] as number;
                    const rows = TABLE.slice(start, start + count).map((cells, index) => ({ view: start + index, row: start + index, cells, fieldCount: cells.length }));
                    await act(async () => {
                        sockets.last().emit({
                            type: 'command-reply',
                            id,
                            reply: { ok: true, pane_id: PANE_CSV, rows: { generation: state.generation, revision: state.revision, start, columnStart: 0, columnIDs: [0, 1], rows, nextStart: null } }
                        });
                        await Promise.resolve();
                    });
                }
                await act(async () => {
                    await Promise.resolve();
                });
            }
        }
    };
    return harness;
}

function press(code: string, key: string, target: Window | Element = window): boolean {
    let notCancelled = true;
    act(() => {
        notCancelled = fireEvent.keyDown(target, { code, key, metaKey: true });
    });
    return notCancelled;
}

afterEach(cleanup);

describe('a csv pane in the window', () => {
    it('speaks the csv verbs, never the content service, and draws the grid', async () => {
        const h = setup();
        await h.seed();
        expect(h.commands().filter((payload) => payload['command'] === 'csv-subscribe')).toEqual([{ command: 'csv-subscribe', pane_id: PANE_CSV }]);
        expect(h.commands().some((payload) => payload['command'] === 'content-subscribe')).toBe(false);
        await waitFor(() => {
            expect(screen.getByTestId('csv-cell-1-0').textContent).toBe('north');
        });
        expect(screen.getByTestId('csv-header-1').textContent).toContain('units');
        expect(screen.getByTestId(`pane-header-row-${PANE_CSV}`)).toBeTruthy();
    });

    it('routes ⌘E to raw text through `markdown-set-mode`', async () => {
        const h = setup();
        await h.seed();
        const notCancelled = press('KeyE', 'e', screen.getByTestId(`csv-editor-${PANE_CSV}`));
        expect(notCancelled).toBe(false);
        // After the grid's edits are answered (none here).
        await waitFor(() => {
            expect(h.commands().filter((payload) => payload['command'] === 'markdown-set-mode')).toEqual([{ command: 'markdown-set-mode', pane_id: PANE_CSV, mode: 'edit' }]);
        });
    });

    it('sends the cell being typed, and waits for its answer, before ⌘E switches to raw text', async () => {
        const h = setup();
        await h.seed();
        const editor = screen.getByTestId(`csv-editor-${PANE_CSV}`);
        await waitFor(() => {
            expect(screen.getByTestId('csv-cell-1-0').textContent).toBe('north');
        });
        fireEvent.input(editor, { target: { value: 'kept' } });
        press('KeyE', 'e', editor);
        await act(async () => {
            await Promise.resolve();
        });
        const sent = (): string[] => h.commands().map((payload) => String(payload['command'])).filter((command) => command === 'csv-edit' || command === 'markdown-set-mode');
        // The daemon refuses grid edits once it shows raw text, so the edit goes first and the
        // switch waits for its answer.
        expect(sent()).toEqual(['csv-edit']);
        expect(h.commands().find((payload) => payload['command'] === 'csv-edit')).toMatchObject({ ops: [{ op: 'set-cell', row: 1, column: 0, value: 'kept' }] });
        h.answer('csv-edit', { ok: true, pane_id: PANE_CSV, state: csvState({ paneID: PANE_CSV, revision: 2, rowCount: TABLE.length, columns: [0, 1], filePath: '/repo/sales.csv' }) });
        await waitFor(() => {
            expect(sent()).toEqual(['csv-edit', 'markdown-set-mode']);
        });
    });

    it('sends the cell being typed, and waits for its answer, before ⌘W closes the pane', async () => {
        const h = setup();
        await h.seed();
        const editor = screen.getByTestId(`csv-editor-${PANE_CSV}`);
        await waitFor(() => {
            expect(screen.getByTestId('csv-cell-1-0').textContent).toBe('north');
        });
        fireEvent.input(editor, { target: { value: 'kept' } });
        press('KeyW', 'w', editor);
        await act(async () => {
            await Promise.resolve();
        });
        const sent = (): string[] => h.commands().map((payload) => String(payload['command'])).filter((command) => command === 'csv-edit' || command === 'pane-close');
        expect(sent()).toEqual(['csv-edit']);
        h.answer('csv-edit', { ok: true, pane_id: PANE_CSV, state: csvState({ paneID: PANE_CSV, revision: 2, rowCount: TABLE.length, columns: [0, 1], filePath: '/repo/sales.csv' }) });
        await waitFor(() => {
            expect(sent()).toEqual(['csv-edit', 'pane-close']);
        });
    });

    it('explains, instead of asking, when raw text is unavailable', async () => {
        const h = setup();
        await h.seed({ rawEditable: false, bytes: 50 * 1024 * 1024 });
        const notCancelled = press('KeyE', 'e', screen.getByTestId(`csv-editor-${PANE_CSV}`));
        expect(notCancelled).toBe(false);
        expect(h.commands().some((payload) => payload['command'] === 'markdown-set-mode')).toBe(false);
        expect(screen.getByTestId(`csv-status-notice-${PANE_CSV}`).textContent).toBe('Raw text (⌘E) is only available for files up to 2 MiB');
        // And the header's toggle is disabled with the same reason.
        const toggle = screen.getByTestId(`pane-edit-toggle-${PANE_CSV}`);
        expect(toggle.getAttribute('aria-label') ?? toggle.getAttribute('title')).toContain('2 MiB');
    });

    it('opens the grid’s own find bar on ⌘F and searches through `csv-find`', async () => {
        const h = setup();
        await h.seed();
        const notCancelled = press('KeyF', 'f', screen.getByTestId(`csv-editor-${PANE_CSV}`));
        expect(notCancelled).toBe(false);
        const field = screen.getByTestId(`content-find-input-${PANE_CSV}`);
        expect(h.commands().some((payload) => payload['command'] === 'terminal-search')).toBe(false);
        fireEvent.change(field, { target: { value: 'south' } });
        await waitFor(() => {
            expect(h.commands().some((payload) => payload['command'] === 'csv-find' && payload['query'] === 'south')).toBe(true);
        });
        expect(h.commands().some((payload) => payload['command'] === 'csv-find-step' && payload['query'] === 'south')).toBe(true);
    });

    it('sends `csv-set-header-row` from the header’s control', async () => {
        const h = setup();
        await h.seed();
        fireEvent.click(screen.getByTestId(`pane-header-row-${PANE_CSV}`));
        expect(h.commands().filter((payload) => payload['command'] === 'csv-set-header-row')).toEqual([{ command: 'csv-set-header-row', pane_id: PANE_CSV, on: false }]);
    });

    it('shows raw text through the content service when the pane is editing', async () => {
        const h = setup({ editing: true });
        await waitFor(() => {
            expect(h.commands().some((payload) => payload['command'] === 'content-subscribe')).toBe(true);
        });
        expect(h.commands().some((payload) => payload['command'] === 'csv-subscribe')).toBe(false);
        expect(screen.getByTestId(`pane-edit-toggle-${PANE_CSV}`).getAttribute('aria-label')).toBe('Table (⌘E)');
    });
});

describe('a csv pane on a phone', () => {
    /*
     * The grid's own "claim no caret on a phone" rule is pinned in `content/csv/CsvGrid.test.tsx`.
     * It is not asserted here: App's workspace-switch hand-off (`handCaretToPaneWhenReady`) reads
     * the DEFAULT window's form factor, which under jsdom is a desktop whatever `formFactorWindow`
     * the test hands App, so whether it lands first is a timing question in this harness.
     */
    it('comes up touch-first, with the phone controls in reach and tap-to-edit', async () => {
        const h = setup({ phone: true });
        await h.seed();
        await waitFor(() => {
            expect(screen.getByTestId('csv-cell-1-0').textContent).toBe('north');
        });
        const editor = screen.getByTestId(`csv-editor-${PANE_CSV}`);
        expect(screen.getByTestId(`csv-undo-${PANE_CSV}`)).toBeTruthy();
        expect(screen.getByTestId(`csv-header-toggle-${PANE_CSV}`)).toBeTruthy();
        // A tap on the selected cell edits, focusing inside the gesture.
        const cell = screen.getByTestId('csv-cell-1-0');
        fireEvent.touchStart(cell, { touches: [{ clientX: 10, clientY: 10 }] });
        fireEvent.touchEnd(cell, { changedTouches: [{ clientX: 10, clientY: 10 }] });
        expect(document.activeElement).toBe(editor);
        expect(editor.getAttribute('data-editing')).toBe('true');
    });
});

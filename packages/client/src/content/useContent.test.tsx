/**
 * The subscription lifecycle, driven through a real `KelpiConnection` over the fake socket — the
 * hook, the client and the wire format are proved together, because the interesting bugs live
 * between them (a subscribe that never went out, an unsubscribe that fired while a second view
 * was still mounted, a reconnect that left the pane mirroring a frozen document).
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type ReactElement } from 'react';

import {
    CommandClient,
    KelpiConnection,
    completeHandshake,
    createFakeSocketFactory,
    type FakeWebSocket
} from '../connection';
import { createContentClient, type ContentApi, type ContentClient } from './client';
import { contentState } from './testing';
import { useContent } from './useContent';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

interface Harness {
    readonly connection: KelpiConnection;
    readonly content: ContentClient;
    socket(): FakeWebSocket;
    /** Every `command` payload this client wrote, oldest first. */
    payloads(): Record<string, unknown>[];
    /** Answer the newest command with the given name (settles the client's promise chain). */
    reply(command: string, reply: Record<string, unknown>): Promise<void>;
}

function harness(): Harness {
    const sockets = createFakeSocketFactory();
    const connection = new KelpiConnection({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 }
    });
    const commands = new CommandClient(connection);
    const content = createContentClient({ connection, commands });
    connection.connect();
    act(() => {
        completeHandshake(sockets.last());
    });

    const frames = (): Record<string, unknown>[] => {
        const all: Record<string, unknown>[] = [];
        for (const socket of sockets.sockets) all.push(...socket.messages());
        return all;
    };

    return {
        connection,
        content,
        socket: () => sockets.last(),
        payloads: () =>
            frames()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        async reply(command, reply): Promise<void> {
            const frame = [...frames()]
                .reverse()
                .find(
                    (message) =>
                        message['type'] === 'command' &&
                        (message['payload'] as Record<string, unknown> | undefined)?.['command'] === command
                );
            if (frame === undefined) throw new Error(`no '${command}' command was sent`);
            // The reply travels through a promise, so the state lands a microtask later.
            await act(async () => {
                sockets.last().emit({ type: 'command-reply', id: frame['id'] as string, reply });
                await Promise.resolve();
            });
        }
    };
}

function Probe(props: { readonly content: ContentApi; readonly paneID: string }): ReactElement {
    const { state, error } = useContent(props.content, props.paneID);
    return (
        <div data-testid={`probe-${props.paneID}`} data-error={error ?? ''}>
            {state === null ? 'none' : `${state.mode}/${state.revision}/${state.text ?? ''}`}
        </div>
    );
}

function probeText(paneID = PANE): string {
    return screen.getByTestId(`probe-${paneID}`).textContent ?? '';
}

function commandNames(h: Harness): string[] {
    return h.payloads().map((payload) => payload['command'] as string);
}

afterEach(() => {
    cleanup();
});

describe('useContent lifecycle', () => {
    it('subscribes on mount and unsubscribes on unmount', () => {
        const h = harness();
        const view = render(<Probe content={h.content} paneID={PANE} />);

        expect(h.payloads().at(-1)).toMatchObject({ command: 'content-subscribe', pane_id: PANE });
        expect(probeText()).toBe('none');

        view.unmount();
        expect(h.payloads().at(-1)).toMatchObject({ command: 'content-unsubscribe', pane_id: PANE });
    });

    it('renders the subscribe reply’s snapshot and every later content-updated', async () => {
        const h = harness();
        render(<Probe content={h.content} paneID={PANE} />);

        await h.reply('content-subscribe', {
            ok: true,
            pane_id: PANE,
            state: contentState({ paneID: PANE, revision: 4, text: '# one\n' })
        });
        expect(probeText()).toBe('view/4/# one\n');

        act(() => {
            h.socket().emit({
                type: 'content-updated',
                paneID: PANE,
                state: contentState({ paneID: PANE, revision: 5, text: '# two\n' })
            });
        });
        expect(probeText()).toBe('view/5/# two\n');
    });

    it('drops a snapshot older than the one already applied', () => {
        const h = harness();
        render(<Probe content={h.content} paneID={PANE} />);

        act(() => {
            h.socket().emit({
                type: 'content-updated',
                paneID: PANE,
                state: contentState({ paneID: PANE, revision: 9, text: 'newer' })
            });
        });
        act(() => {
            h.socket().emit({
                type: 'content-updated',
                paneID: PANE,
                state: contentState({ paneID: PANE, revision: 8, text: 'older' })
            });
        });

        expect(probeText()).toBe('view/9/newer');
    });

    it('ignores an update addressed to another pane', () => {
        const h = harness();
        render(<Probe content={h.content} paneID={PANE} />);

        act(() => {
            h.socket().emit({
                type: 'content-updated',
                paneID: 'DDDDDDDD-0000-4000-8000-000000000002',
                state: contentState({ paneID: 'DDDDDDDD-0000-4000-8000-000000000002', text: 'other' })
            });
        });

        expect(probeText()).toBe('none');
    });

    it('shares one wire subscription between two views of a pane', () => {
        const h = harness();
        const first = render(<Probe content={h.content} paneID={PANE} />);
        render(<Probe content={h.content} paneID={PANE} />);

        expect(commandNames(h).filter((name) => name === 'content-subscribe')).toHaveLength(1);
        expect(h.content.listenerCount(PANE)).toBe(2);

        // The daemon must keep talking to us while the second view is still on screen.
        first.unmount();
        expect(commandNames(h)).not.toContain('content-unsubscribe');
        expect(h.content.listenerCount(PANE)).toBe(1);
    });

    it('replays the last snapshot to a view that joins an existing subscription', async () => {
        const h = harness();
        render(<Probe content={h.content} paneID={PANE} />);
        await h.reply('content-subscribe', {
            ok: true,
            pane_id: PANE,
            state: contentState({ paneID: PANE, revision: 2, text: 'shared' })
        });

        render(<Probe content={h.content} paneID={PANE} />);
        expect(screen.getAllByTestId(`probe-${PANE}`).map((node) => node.textContent)).toEqual([
            'view/2/shared',
            'view/2/shared'
        ]);
    });

    it('re-subscribes after a reconnect, because the daemon drops the session’s subscriptions', () => {
        const h = harness();
        render(<Probe content={h.content} paneID={PANE} />);
        const before = commandNames(h).filter((name) => name === 'content-subscribe').length;

        act(() => {
            h.connection.resync('test drop');
        });
        act(() => {
            completeHandshake(h.socket());
        });

        expect(commandNames(h).filter((name) => name === 'content-subscribe')).toHaveLength(before + 1);
    });

    it('surfaces a failed subscribe as an error the pane can render', async () => {
        const h = harness();
        render(<Probe content={h.content} paneID={PANE} />);

        await h.reply('content-subscribe', { ok: false, error: "no pane matches 'X'" });

        expect(screen.getByTestId(`probe-${PANE}`).dataset['error']).toBe("no pane matches 'X'");
        expect(probeText()).toBe('none');
    });

    it('drops a state payload that is not one', () => {
        const h = harness();
        render(<Probe content={h.content} paneID={PANE} />);

        act(() => {
            h.socket().emit({ type: 'content-updated', paneID: PANE, state: { paneID: PANE, type: 'web' } });
        });

        expect(probeText()).toBe('none');
    });
});

describe('content commands', () => {
    it('flushes pending text before asking the daemon to change mode', async () => {
        const h = harness();
        render(<Probe content={h.content} paneID={PANE} />);

        h.content.setText(PANE, '# edited\n');
        await act(async () => {
            void h.content.setMode(PANE, 'view');
            await Promise.resolve();
        });

        const names = commandNames(h);
        const text = names.indexOf('content-set-text');
        const mode = names.indexOf('markdown-set-mode');
        expect(text).toBeGreaterThanOrEqual(0);
        expect(mode).toBeGreaterThan(text);
        expect(h.payloads()[text]).toMatchObject({ text: '# edited\n' });
    });

    it('sends the buffer once more when the client is disposed', () => {
        const h = harness();
        render(<Probe content={h.content} paneID={PANE} />);

        h.content.setText(PANE, 'unsaved');
        h.content.dispose();

        expect(h.payloads().at(-1)).toMatchObject({ command: 'content-set-text', text: 'unsaved' });
    });
});

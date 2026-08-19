/**
 * §3.16's font-size stepping, client-side.
 *
 * The step→size arithmetic is deliberately here rather than at the call sites: the header
 * button, the ⌘= / ⌘- / ⌘0 bindings and any future menu item all say "increase" and let the
 * client resolve it against the state it already mirrors, so none of them can disagree about
 * what the current size is.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type ReactElement } from 'react';

import {
    CommandClient,
    NexConnection,
    completeHandshake,
    createFakeSocketFactory
} from '../connection';
import {
    CONTENT_FONT_SIZE_DEFAULT,
    CONTENT_FONT_SIZE_MAX,
    CONTENT_FONT_SIZE_MIN,
    createContentClient,
    nextFontSize,
    type ContentApi,
    type ContentClient
} from './client';
import { contentState } from './testing';
import { useContent } from './useContent';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

interface Harness {
    readonly content: ContentClient;
    payloads(): Record<string, unknown>[];
    /** Deliver a `content-updated` event the way the daemon does. */
    push(fontSize: number): void;
}

function harness(): Harness {
    const sockets = createFakeSocketFactory();
    const connection = new NexConnection({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 }
    });
    const content = createContentClient({ connection, commands: new CommandClient(connection) });
    connection.connect();
    act(() => {
        completeHandshake(sockets.last());
    });

    return {
        content,
        payloads: () => {
            const all: Record<string, unknown>[] = [];
            for (const socket of sockets.sockets) all.push(...socket.messages());
            return all
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>);
        },
        push(fontSize) {
            act(() => {
                sockets.last().emit({
                    type: 'content-updated',
                    paneID: PANE,
                    state: { ...contentState({ paneID: PANE, fontSize }), revision: fontSize }
                });
            });
        }
    };
}

function Probe(props: { readonly content: ContentApi }): ReactElement {
    const { state } = useContent(props.content, PANE);
    return <div data-testid="probe">{state === null ? 'none' : String(state.fontSize)}</div>;
}

function sizes(h: Harness): number[] {
    return h
        .payloads()
        .filter((payload) => payload['command'] === 'content-set-font-size')
        .map((payload) => payload['size'] as number);
}

afterEach(cleanup);

describe('nextFontSize', () => {
    it('is §3.16’s arithmetic exactly', () => {
        expect(nextFontSize(14, 'increase')).toBe(15);
        expect(nextFontSize(14, 'decrease')).toBe(13);
        expect(nextFontSize(21, 'reset')).toBe(CONTENT_FONT_SIZE_DEFAULT);
        expect(nextFontSize(CONTENT_FONT_SIZE_MAX, 'increase')).toBe(CONTENT_FONT_SIZE_MAX);
        expect(nextFontSize(CONTENT_FONT_SIZE_MIN, 'decrease')).toBe(CONTENT_FONT_SIZE_MIN);
    });

    it('falls back to the default for a size it cannot trust', () => {
        expect(nextFontSize(Number.NaN, 'increase')).toBe(CONTENT_FONT_SIZE_DEFAULT + 1);
        expect(nextFontSize(0, 'decrease')).toBe(CONTENT_FONT_SIZE_DEFAULT - 1);
    });
});

describe('ContentClient.setFontSize', () => {
    it('resolves the step against the mirrored state', async () => {
        const h = harness();
        render(<Probe content={h.content} />);
        h.push(18);
        expect(screen.getByTestId('probe').textContent).toBe('18');

        await act(async () => {
            void h.content.setFontSize(PANE, 'increase');
            await Promise.resolve();
        });
        expect(sizes(h)).toEqual([19]);

        h.push(19);
        await act(async () => {
            void h.content.setFontSize(PANE, 'reset');
            await Promise.resolve();
        });
        expect(sizes(h)).toEqual([19, CONTENT_FONT_SIZE_DEFAULT]);
    });

    it('sends nothing when the size is already at the bound', async () => {
        const h = harness();
        render(<Probe content={h.content} />);
        h.push(CONTENT_FONT_SIZE_MAX);

        await act(async () => {
            void h.content.setFontSize(PANE, 'increase');
            await Promise.resolve();
        });
        expect(sizes(h)).toEqual([]);
    });

    it('peek exposes the last mirrored state without subscribing', () => {
        const h = harness();
        expect(h.content.peek(PANE)).toBeNull();
        render(<Probe content={h.content} />);
        h.push(16);
        expect(h.content.peek(PANE)?.fontSize).toBe(16);
    });
});

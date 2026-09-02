/**
 * The connection screen's copy, pinned per socket status.
 *
 * `App.test.tsx` already drives these surfaces through a real socket, which is the test that
 * proves they appear at the right moment. This one is the opposite half and the cheaper one:
 * it renders each status directly, so a change to the wording or a test id shows up as a
 * failing string here rather than as a puzzling assertion three layers up in an App test.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { KelpiRuntime } from '../state';
import type { DaemonTarget } from './config';
import { ConnectionBanner, ConnectionSplash } from './ConnectionScreen';

afterEach(cleanup);

/** The splash and the banner touch exactly one runtime verb, so the stub is exactly one verb. */
function fakeRuntime(): KelpiRuntime & { connects: number } {
    const runtime = {
        connects: 0,
        connect() {
            runtime.connects += 1;
        }
    };
    return runtime as unknown as KelpiRuntime & { connects: number };
}

const ORIGIN_TARGET: DaemonTarget = { url: undefined, token: undefined, fromQuery: false };

function splash(status: string, error: string | null = null, target: DaemonTarget = ORIGIN_TARGET) {
    const runtime = fakeRuntime();
    render(<ConnectionSplash runtime={runtime} state={{ ui: { connection: status, connectionError: error } }} target={target} />);
    return runtime;
}

describe('ConnectionSplash', () => {
    it('names the socket state and the target for every status it handles', () => {
        const cases: readonly (readonly [string, string])[] = [
            ['idle', 'Connecting to kelpid'],
            ['connecting', 'Connecting to kelpid'],
            ['connected', 'Loading workspaces'],
            ['reconnecting', 'Reconnecting to kelpid'],
            ['closed', 'Disconnected from kelpid'],
            ['rejected', 'The daemon refused this connection']
        ];
        for (const [status, title] of cases) {
            splash(status);
            const node = screen.getByTestId('connection-splash');
            expect(node.dataset['status']).toBe(status);
            expect(node.textContent).toContain(title);
            // The target is always on screen: "which daemon" is half of what a stuck client needs.
            expect(node.textContent).toContain('origin');
            cleanup();
        }
    });

    it('spells out the daemon URL when the page was pointed at another host', () => {
        splash('connecting', null, { url: 'https://mac.tail.ts:7777', token: 'kd_a', fromQuery: true });
        expect(screen.getByTestId('connection-splash').textContent).toContain('https://mac.tail.ts:7777');
    });

    it('says nothing while the socket is still trying, and explains itself once it stops', () => {
        // idle and connecting carry no hint: there is nothing useful to say about a dial in
        // progress, and a hint there would be noise on every cold boot.
        splash('idle');
        expect(screen.getByTestId('connection-splash').textContent).not.toContain('retrying');
        cleanup();

        splash('reconnecting');
        expect(screen.getByTestId('connection-splash').textContent).toContain(
            'the socket dropped - retrying with backoff'
        );
        cleanup();

        splash('closed');
        expect(screen.getByTestId('connection-splash').textContent).toContain(
            'nothing is listening; start it with `kelpid start`'
        );
    });

    it('answers a refusal with the one command that mints a working link', () => {
        splash('rejected');
        // The hint A4 will rewrite for a phone: on a desktop the fix is a command, so name it.
        expect(screen.getByTestId('connection-splash').textContent).toContain(
            'open this page from `kelpid url`, which includes the daemon token'
        );
    });

    it("gives the daemon's own sentence body size when it refused, footnote size otherwise", () => {
        splash('rejected', "invalid or missing daemon token - open the client via 'kelpid url'");
        const rejectedError = screen.getByTestId('connection-error');
        expect(rejectedError.textContent).toContain('invalid or missing daemon token');
        expect(rejectedError.className).toContain('text-[13px]');
        cleanup();

        splash('closed', 'ECONNREFUSED');
        expect(screen.getByTestId('connection-error').className).toContain('text-[11px]');
    });

    it('omits the error line entirely when the daemon said nothing', () => {
        splash('connecting');
        expect(screen.queryByTestId('connection-error')).toBeNull();
    });

    it('offers a retry only once the socket has stopped trying by itself', () => {
        for (const status of ['idle', 'connecting', 'connected', 'reconnecting']) {
            splash(status);
            expect(screen.queryByTestId('connection-retry')).toBeNull();
            cleanup();
        }

        for (const status of ['closed', 'rejected']) {
            const runtime = splash(status);
            fireEvent.click(screen.getByTestId('connection-retry'));
            expect(runtime.connects).toBe(1);
            cleanup();
        }
    });
});

describe('ConnectionBanner', () => {
    function banner(status: string, error: string | null = null) {
        const runtime = fakeRuntime();
        render(<ConnectionBanner status={status} error={error} runtime={runtime} />);
        return runtime;
    }

    it('is a live region, so a drop is announced without stealing the view', () => {
        banner('reconnecting');
        const node = screen.getByTestId('connection-banner');
        expect(node.getAttribute('role')).toBe('status');
        expect(node.dataset['status']).toBe('reconnecting');
        expect(node.textContent).toContain('Reconnecting');
    });

    it('distinguishes a socket that is still trying from one that has given up', () => {
        banner('closed');
        expect(screen.getByTestId('connection-banner').textContent).toContain(
            'Disconnected - the view may be stale'
        );
        cleanup();

        banner('rejected');
        expect(screen.getByTestId('connection-banner').textContent).toContain(
            'The daemon refused this connection'
        );
    });

    it("carries the daemon's reason, and colours it as the actionable part when refused", () => {
        banner('rejected', 'bad-token');
        const rejectedError = screen.getByTestId('connection-banner-error');
        expect(rejectedError.textContent).toBe('bad-token');
        expect(rejectedError.style.color).not.toBe('');
        cleanup();

        banner('reconnecting');
        expect(screen.queryByTestId('connection-banner-error')).toBeNull();
    });

    it('offers retry on a dead socket only', () => {
        const reconnecting = banner('reconnecting');
        expect(screen.queryByText('retry')).toBeNull();
        expect(reconnecting.connects).toBe(0);
        cleanup();

        for (const status of ['closed', 'rejected']) {
            const runtime = banner(status);
            fireEvent.click(screen.getByText('retry'));
            expect(runtime.connects).toBe(1);
            cleanup();
        }
    });
});

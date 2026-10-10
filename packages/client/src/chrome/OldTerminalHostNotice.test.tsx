/**
 * The old-terminal-host notice (#372): what it says a restart costs, and its two answers.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WsOldTerminalHost } from '@kelpi/protocol';

import { OldTerminalHostNotice, oldHostKey, oldTerminalHostCopy, readLaterOldHosts, writeLaterOldHosts } from './OldTerminalHostNotice';

afterEach(() => {
    cleanup();
    localStorage.clear();
});

function host(overrides: Partial<WsOldTerminalHost> = {}): WsOldTerminalHost {
    return {
        pid: 111,
        protocol: 1,
        version: '0.2.15',
        reason: 'can leak one of the pseudo-terminals every app on the Mac shares, one for each terminal it opens',
        startedAt: null,
        paneIDs: ['A', 'B', 'C'],
        agents: 1,
        busyAgents: 0,
        ...overrides
    };
}

describe('oldTerminalHostCopy', () => {
    it('says how many, which version, why, and what a restart keeps', () => {
        expect(oldTerminalHostCopy([host()])).toEqual({
            title: 'Terminals on an older terminal host',
            body:
                '3 terminals (1 agent session) are still running on a terminal host an earlier version of Kelpi started, which ' +
                'can leak one of the pseudo-terminals every app on the Mac shares, one for each terminal it opens. ' +
                'It closes by itself when they do.',
            cost:
                'Restart them now to free what it holds: each shell starts again in its folder and Claude and Codex sessions ' +
                'resume. Anything else running in them stops.'
        });
    });

    it('warns about agents working right now, and reads right for one terminal', () => {
        const copy = oldTerminalHostCopy([host({ paneIDs: ['A'], agents: 1, busyAgents: 1 })]);
        expect(copy.body.startsWith('1 terminal (1 agent session) is still running on')).toBe(true);
        expect(copy.cost.endsWith('Anything else running in them stops, and 1 agent working right now is interrupted.')).toBe(true);
    });
});

describe('OldTerminalHostNotice', () => {
    it('restarts or waits, and holds the button while a restart runs', () => {
        const onRestart = vi.fn();
        const onLater = vi.fn();
        const { rerender } = render(<OldTerminalHostNotice hosts={[host()]} restarting={false} onRestart={onRestart} onLater={onLater} />);
        fireEvent.click(screen.getByTestId('old-terminal-host-restart'));
        fireEvent.click(screen.getByTestId('old-terminal-host-later'));
        expect(onRestart).toHaveBeenCalledTimes(1);
        expect(onLater).toHaveBeenCalledTimes(1);

        rerender(<OldTerminalHostNotice hosts={[host()]} restarting onRestart={onRestart} onLater={onLater} />);
        const button = screen.getByTestId('old-terminal-host-restart');
        expect(button.textContent).toBe('Restarting…');
        fireEvent.click(button);
        fireEvent.click(screen.getByTestId('old-terminal-host-later'));
        expect(onRestart).toHaveBeenCalledTimes(1);
        expect(onLater).toHaveBeenCalledTimes(1);
    });

    it('remembers "Later" per host, by pid and start, and reads junk as nothing', () => {
        expect(readLaterOldHosts()).toEqual([]);
        const key = oldHostKey(host({ startedAt: '2026-10-01T00:00:00.000Z' }));
        expect(key).not.toBe(oldHostKey(host({ startedAt: '2026-10-09T00:00:00.000Z' })));
        writeLaterOldHosts([key]);
        expect(readLaterOldHosts()).toEqual([key]);
        writeLaterOldHosts(Array.from({ length: 30 }, (_, index) => `${String(index)}@`));
        expect(readLaterOldHosts()).toHaveLength(20);
        localStorage.setItem('kelpi.old-terminal-hosts.later', 'not json');
        expect(readLaterOldHosts()).toEqual([]);
    });
});

/**
 * `ping`'s `terminals` block (#311): what `kelpid stop` says a stop would end.
 */

import { describe, expect, it } from 'vitest';

import type { AppContext } from './context.js';
import { terminalCounts } from './ping.js';
import { harness, id, seeded } from './testing.js';

type CountsContext = Pick<AppContext, 'store' | 'pty'>;

function context(panes: { id: string; status: string; agentSessionID: string | null; live: boolean }[][]): CountsContext {
    const workspaces = panes.map((visible, index) => ({
        id: id('aaaaaaaa', index + 1),
        panes: visible.filter((_, at) => at % 2 === 0),
        parkedPanes: visible.filter((_, at) => at % 2 === 1)
    }));
    const live = new Set(panes.flat().filter((pane) => pane.live).map((pane) => pane.id));
    return {
        store: { getState: () => ({ workspaces }) },
        pty: { has: (paneID: string) => live.has(paneID) }
    } as unknown as CountsContext;
}

describe('terminalCounts', () => {
    it('counts live terminals, visible and parked, and the agent sessions in them', () => {
        const pane = (n: number, status: string, agentSessionID: string | null, live = true) => ({
            id: id('dddddddd', n),
            status,
            agentSessionID,
            live
        });
        const counts = terminalCounts(
            context([
                [pane(1, 'idle', null), pane(2, 'running', 'claude-1'), pane(3, 'waitingForInput', 'claude-2')],
                [pane(4, 'idle', 'claude-3'), pane(5, 'running', 'claude-4', false), pane(6, 'idle', null, false)]
            ])
        );
        // Pane 5 and 6 have no PTY (exited, or a markdown pane), so they end nothing.
        expect(counts).toEqual({ live: 4, agents: 3, running: 1, waiting: 1 });
    });

    it('is in every ping reply', () => {
        const h = harness({ initial: seeded(2) });
        h.ctx.pty.spawn({ paneID: id('dddddddd', 1), cwd: '/', cols: 80, rows: 24, env: [] });
        expect(h.reply({ command: 'ping' })).toMatchObject({
            ok: true,
            terminals: { live: 1, agents: 0, running: 0, waiting: 0 }
        });
    });
});

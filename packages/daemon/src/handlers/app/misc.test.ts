import { WIRE_COMMANDS } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import type { DaemonState } from '../../store/index.js';
import { NOT_SUPPORTED_ERROR, STUBBED_COMMANDS } from './stubs.js';
import { harness, id, NOW, seeded } from './testing.js';

const W1 = id('aaaaaaaa', 1);
const W2 = id('aaaaaaaa', 2);
const P1 = id('dddddddd', 1);
const P2 = id('dddddddd', 2);
const PNEW = id('ffffffff', 1);

// ---------------------------------------------------------------------------
// layout-cycle / layout-select
// ---------------------------------------------------------------------------

describe('layout commands', () => {
    function twoPanes() {
        const h = harness({ initial: seeded(1) });
        h.dispatch({ type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'horizontal', now: NOW });
        return h;
    }

    it('cycles the predefined layout of the workspace holding the caller pane', () => {
        const h = twoPanes();
        expect(h.state().workspaces[0]?.currentLayoutIndex).toBeNull();
        expect(h.send({ command: 'layout-cycle', pane_id: P1 })).toEqual([]);
        expect(h.state().workspaces[0]?.currentLayoutIndex).toBe(0);
        h.send({ command: 'layout-cycle', pane_id: P1 });
        expect(h.state().workspaces[0]?.currentLayoutIndex).toBe(1);
    });

    it('selects a named layout and silently drops an unknown one', () => {
        const h = twoPanes();
        h.send({ command: 'layout-select', pane_id: P1, name: 'main-vertical' });
        expect(h.state().workspaces[0]?.currentLayoutIndex).toBe(3);
        h.send({ command: 'layout-select', pane_id: P1, name: 'diagonal' });
        expect(h.state().workspaces[0]?.currentLayoutIndex).toBe(3);
    });

    it('drops the message when no workspace holds the pane', () => {
        const h = twoPanes();
        const before = h.state();
        h.send({ command: 'layout-cycle', pane_id: id('9999aaaa', 1) });
        expect(h.state()).toBe(before);
    });

    it('does not address a PARKED pane', () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch(
            {
                type: 'open-markdown-pane',
                workspaceID: W1,
                paneID: P2,
                filePath: '/docs/a.md',
                reusePaneID: P1,
                now: NOW
            },
            { type: 'split-pane', workspaceID: W1, paneID: id('dddddddd', 5), direction: 'horizontal', now: NOW }
        );
        const before = h.state();
        h.send({ command: 'layout-cycle', pane_id: P1 });
        expect(h.state()).toBe(before);
    });
});

// ---------------------------------------------------------------------------
// open / diff
// ---------------------------------------------------------------------------

describe('open', () => {
    it('focuses the caller pane and opens a markdown pane in its workspace', () => {
        const h = harness({ initial: seeded(2), ids: [PNEW] });
        expect(h.send({ command: 'open', path: '/docs/readme.md', pane_id: P1 })).toEqual([]);
        const workspace = h.state().workspaces[0];
        expect(workspace?.panes.map((pane) => pane.id)).toEqual([P1, PNEW]);
        expect(workspace?.panes[1]).toMatchObject({
            type: 'markdown',
            filePath: '/docs/readme.md',
            label: 'readme.md',
            workingDirectory: '/docs'
        });
        expect(workspace?.focusedPaneID).toBe(PNEW);
        expect(workspace?.parkedPanes).toEqual([]);
    });

    it('reuses (parks) the caller pane with --here', () => {
        const h = harness({ initial: seeded(1), ids: [PNEW] });
        h.send({ command: 'open', path: '/docs/readme.md', pane_id: P1, reuse: true });
        const workspace = h.state().workspaces[0];
        expect(workspace?.panes.map((pane) => pane.id)).toEqual([PNEW]);
        expect(workspace?.parkedPanes.map((pane) => pane.id)).toEqual([P1]);
    });

    it('falls back to the active workspace (never reusing) without a known pane', () => {
        const h = harness({ initial: seeded(2), ids: [PNEW] });
        h.send({ command: 'open', path: '/docs/readme.md', reuse: true });
        expect(h.state().lastActiveWorkspaceID).toBe(W2);
        expect(h.state().workspaces[1]?.panes.map((pane) => pane.id)).toEqual([P2, PNEW]);
        expect(h.state().workspaces[1]?.parkedPanes).toEqual([]);
    });

    it('falls back to the active workspace when the pane id is unknown', () => {
        const h = harness({ initial: seeded(2), ids: [PNEW] });
        h.send({ command: 'open', path: '/docs/readme.md', pane_id: id('9999aaaa', 1) });
        expect(h.state().workspaces[1]?.panes).toHaveLength(2);
    });

    it('drops the message when there is no active workspace', () => {
        const empty: DaemonState = { ...seeded(0) };
        const h = harness({ initial: empty });
        const before = h.state();
        h.send({ command: 'open', path: '/docs/readme.md' });
        expect(h.state()).toBe(before);
    });
});

describe('diff', () => {
    it('opens a diff pane scoped to the target path and never reuses', () => {
        const h = harness({ initial: seeded(1), ids: [PNEW] });
        expect(
            h.send({ command: 'diff', repo_path: '/code/nex', target_path: 'src/app.ts', pane_id: P1 })
        ).toEqual([]);
        const workspace = h.state().workspaces[0];
        expect(workspace?.panes.map((pane) => pane.id)).toEqual([P1, PNEW]);
        expect(workspace?.panes[1]).toMatchObject({
            type: 'diff',
            workingDirectory: '/code/nex',
            // §CONT-131: a relative scope resolves against the CALLER pane's cwd, not the
            // daemon's. (The CLI absolutises first, so this is the raw-wire path.)
            filePath: '/Users/test/src/app.ts',
            label: 'app.ts'
        });
    });

    it('scopes to the repo when no target path is given', () => {
        const h = harness({ initial: seeded(1), ids: [PNEW] });
        h.send({ command: 'diff', repo_path: '/code/nex' });
        expect(h.state().workspaces[0]?.panes[1]).toMatchObject({
            filePath: null,
            label: 'nex',
            title: 'diff: nex'
        });
    });
});

// ---------------------------------------------------------------------------
// §CONT-130 / §CONT-131 — relative-path resolution
// ---------------------------------------------------------------------------

describe('relative path resolution (§CONT-130 / §CONT-131)', () => {
    const CALLER_CWD = '/work/caller';
    const FOCUSED_CWD = '/work/focused';

    /** One workspace, two panes: P1 is the caller, P2 is the one holding focus. */
    function twoPanesWithCwds() {
        const h = harness({ initial: seeded(1), ids: [PNEW] });
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'horizontal', now: NOW },
            { type: 'pane-directory-changed', paneID: P1, directory: CALLER_CWD, now: NOW },
            { type: 'pane-directory-changed', paneID: P2, directory: FOCUSED_CWD, now: NOW },
            { type: 'focus-pane', workspaceID: W1, paneID: P2 }
        );
        return h;
    }

    it('resolves a relative open against the ORIGINATING pane’s working directory', () => {
        const h = twoPanesWithCwds();
        h.send({ command: 'open', path: 'notes/todo.md', pane_id: P1 });
        const opened = h.state().workspaces[0]?.panes.find((pane) => pane.id === PNEW);
        expect(opened?.filePath).toBe('/work/caller/notes/todo.md');
    });

    it('falls back to the FOCUSED pane’s working directory with no known caller', () => {
        const h = twoPanesWithCwds();
        h.send({ command: 'open', path: 'notes/todo.md' });
        const opened = h.state().workspaces[0]?.panes.find((pane) => pane.id === PNEW);
        expect(opened?.filePath).toBe('/work/focused/notes/todo.md');
    });

    it('leaves an absolute path and a ~-path exactly as they came', () => {
        const h = twoPanesWithCwds();
        h.send({ command: 'open', path: '/docs/readme.md', pane_id: P1 });
        expect(
            h.state().workspaces[0]?.panes.find((pane) => pane.id === PNEW)?.filePath
        ).toBe('/docs/readme.md');

        const g = twoPanesWithCwds();
        g.send({ command: 'open', path: '~/notes.md', pane_id: P1 });
        expect(
            g.state().workspaces[0]?.panes.find((pane) => pane.id === PNEW)?.filePath
        ).toBe('~/notes.md');
    });

    it('applies the same chain to a diff’s repo path and its optional scope', () => {
        const h = twoPanesWithCwds();
        h.send({ command: 'diff', repo_path: 'repo', target_path: 'src/app.ts', pane_id: P1 });
        const opened = h.state().workspaces[0]?.panes.find((pane) => pane.id === PNEW);
        expect(opened?.workingDirectory).toBe('/work/caller/repo');
        expect(opened?.filePath).toBe('/work/caller/src/app.ts');
    });
});

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

describe('ping', () => {
    it('always succeeds with the doctor fields plus the additive protocol version', () => {
        const h = harness();
        expect(h.reply({ command: 'ping' })).toEqual({
            ok: true,
            version: '9.9.9',
            build: '4242',
            pid: process.pid,
            protocol: 1
        });
        expect(h.replies[0]?.closed).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// stubs + table coverage
// ---------------------------------------------------------------------------

describe('stubs + table coverage', () => {
    it('answers every REMAINING stubbed verb with an honest failure', () => {
        const h = harness({ initial: seeded(1) });
        for (const command of STUBBED_COMMANDS) {
            expect(h.table.get(command)).toBeDefined();
        }
        // M7 moved the graft family out of the stub list into `handlers/app/graft.ts`.
        expect(STUBBED_COMMANDS).not.toContain('graft-start');
        expect(NOT_SUPPORTED_ERROR).toBe('not supported yet');
    });

    it('stays silent on the fire-and-forget path', () => {
        const h = harness({ initial: seeded(1) });
        const handler = h.table.get('graft-status');
        expect(handler).toBeDefined();
        handler?.({ command: 'graft-status' }, h.ctx, null);
        expect(h.replies).toEqual([]);
    });
});

describe('sync-group bookkeeping', () => {
    it('shrinks the broadcast group when `open --here` parks a synced shell', () => {
        const h = harness({ initial: seeded(1), ids: [PNEW] });
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'horizontal', now: NOW },
            { type: 'set-sync-input-active', workspaceID: W1, active: true }
        );
        h.send({ command: 'open', path: '/docs/a.md', pane_id: P1, reuse: true });
        expect(h.syncGroups.at(-1)).toEqual({ workspaceID: W1, paneIDs: [] });
    });

    it('clears the deleted workspace’s group', () => {
        const h = harness({ initial: seeded(2) });
        h.reply({ command: 'workspace-delete', name: 'w1' });
        expect(h.syncGroups.at(-1)).toEqual({ workspaceID: W1, paneIDs: [] });
    });
});

describe('handler table', () => {
    it('covers every non-pane wire command', () => {
        const table = harness().table;
        const missing = WIRE_COMMANDS.filter(
            (command) => !command.startsWith('pane-') && !table.has(command)
        );
        expect(missing).toEqual([]);
    });

    it('deliberately leaves the pane-* family to its own handler module', () => {
        const table = harness().table;
        const claimed = [...table.keys()].filter((command) => command.startsWith('pane-'));
        expect(claimed).toEqual([]);
    });
});

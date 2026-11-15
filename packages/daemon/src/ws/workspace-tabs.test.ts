import { leaf } from '@kelpi/core/layout';
import type { JsonObject } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PaneHandlerContext } from '../handlers/pane/index.js';
import { harness, seedSplit, seedWorkspace, testID, W1, W2, type Harness } from '../handlers/pane/testing.js';
import { onScreenPaneIDs, tabPaneIDs, workspaceTabs } from '../store/tabs.js';
import type { WorkspaceTab } from '../store/types.js';
import {
    LIVE_DIRECTORY_DEADLINE_MS,
    createWorkspaceTabChannel,
    isWorkspaceTabCommand,
    type WorkspaceTabChannelOptions,
    type WorkspaceTabCommand
} from './workspace-tabs.js';
import { isPaneLifecycleCommand } from './panes.js';

const P0 = testID('D', 100);
const P1 = testID('D', 101);
const T1 = testID('F', 1);
const T2 = testID('F', 2);
const T3 = testID('F', 3);

interface Fixture {
    readonly h: Harness;
    readonly channel: ReturnType<typeof createWorkspaceTabChannel>;
    readonly agents: { paneID: string; workspaceID: string }[];
    /** `channel.run` for a verb that answers at once here (no live-directory seam to wait on). */
    readonly run: (command: WorkspaceTabCommand, payload: Record<string, unknown>) => JsonObject;
}

function fixture(
    extra: Partial<Omit<WorkspaceTabChannelOptions, 'ctx'>> & {
        readonly position?: 'after-current' | 'end';
        readonly tabs?: readonly string[];
        /** The OS's answer for where a shell is; absent = no seam, so every verb answers at once. */
        readonly liveWorkingDirectory?: PaneHandlerContext['liveWorkingDirectory'];
    } = {}
): Fixture {
    const h = harness(extra.liveWorkingDirectory === undefined ? {} : { liveWorkingDirectory: extra.liveWorkingDirectory });
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P0, path: '/tmp/work' });
    const tabIDs = [...(extra.tabs ?? [T1, T2, T3])];
    const agents: { paneID: string; workspaceID: string }[] = [];
    const channel = createWorkspaceTabChannel({
        ctx: {
            ...h.ctx,
            mintTabID: () => tabIDs.shift() ?? testID('F', 99),
            newTabPosition: () => extra.position ?? 'after-current'
        },
        startAgent: (paneID, workspaceID) => agents.push({ paneID, workspaceID }),
        ...(extra.newTabOpens === undefined ? {} : { newTabOpens: extra.newTabOpens })
    });
    const run = (command: WorkspaceTabCommand, payload: Record<string, unknown>): JsonObject => {
        const reply = channel.run(command, payload);
        if (reply instanceof Promise) throw new Error(`${command} waited, with nothing to wait on`);
        return reply;
    };
    return { h, channel, agents, run };
}

describe('the verbs', () => {
    it('ride the pane lifecycle channel', () => {
        expect(isWorkspaceTabCommand('workspace-tab-new')).toBe(true);
        expect(isPaneLifecycleCommand('workspace-tab-close')).toBe(true);
        expect(isPaneLifecycleCommand('pane-move-to-new-tab')).toBe(true);
        expect(isWorkspaceTabCommand('pane-close')).toBe(false);
    });
});

describe('workspace-tab-new', () => {
    it('opens a terminal tab in the workspace folder, spawned, and shows it', () => {
        const f = fixture();
        const reply = f.run('workspace-tab-new', { workspace_id: W1 });
        expect(reply).toMatchObject({ ok: true, tab_id: T1, kind: 'terminal' });
        const workspace = f.h.workspace(W1);
        expect(workspace.activeTabID).toBe(T1);
        const paneID = String(reply['pane_id']);
        expect(onScreenPaneIDs(workspace)).toEqual([paneID]);
        expect(f.h.pty.spawns.map((spawn) => spawn.paneID)).toContain(paneID);
        expect(workspace.panes.find((pane) => pane.id === paneID)?.workingDirectory).toBe('/tmp/work');
    });

    it('follows "New tabs go: at the end"', () => {
        const f = fixture({ position: 'end' });
        f.run('workspace-tab-new', { workspace_id: W1 });
        f.channel.run('workspace-tab-select', { workspace_id: W1, tab_id: W1 });
        f.run('workspace-tab-new', { workspace_id: W1 });
        expect(workspaceTabs(f.h.workspace(W1)).map((tab) => tab.id)).toEqual([W1, T1, T2]);
    });

    it('opens what "A new tab opens" says when the caller names no kind', () => {
        const f = fixture({ newTabOpens: () => 'agent' });
        const reply = f.run('workspace-tab-new', { workspace_id: W1 });
        expect(reply).toMatchObject({ ok: true, kind: 'agent' });
        expect(f.agents).toEqual([{ paneID: reply['pane_id'], workspaceID: W1 }]);
    });

    it('opens a web tab and a scratchpad tab without a PTY', () => {
        const f = fixture();
        const web = f.run('workspace-tab-new', { workspace_id: W1, kind: 'web' });
        const pad = f.run('workspace-tab-new', { workspace_id: W1, kind: 'scratchpad' });
        const workspace = f.h.workspace(W1);
        expect(workspace.panes.find((pane) => pane.id === web['pane_id'])?.type).toBe('web');
        expect(workspace.panes.find((pane) => pane.id === pad['pane_id'])?.type).toBe('scratchpad');
        expect(f.h.pty.spawns.map((spawn) => spawn.paneID)).not.toContain(web['pane_id']);
    });

    it('refuses an unknown kind and an unknown workspace', () => {
        const f = fixture();
        expect(f.run('workspace-tab-new', { workspace_id: W1, kind: 'diff' })).toMatchObject({ ok: false });
        expect(f.run('workspace-tab-new', { workspace_id: 'nope' })).toMatchObject({ ok: false });
    });

    it('opens a web tab at a url, which means a web tab when no kind is named', () => {
        const f = fixture({ newTabOpens: () => 'terminal' });
        const named = f.run('workspace-tab-new', { workspace_id: W1, kind: 'web', url: 'example.com/docs' });
        expect(named).toMatchObject({ ok: true, kind: 'web', url: 'https://example.com/docs' });
        const implied = f.run('workspace-tab-new', { workspace_id: W1, url: 'localhost:3000' });
        expect(implied).toMatchObject({ ok: true, kind: 'web', url: 'http://localhost:3000' });
        const web = f.h.workspace(W1).webPanes[named['pane_id'] as string];
        expect(web?.tabs.map((tab) => tab.url)).toEqual(['https://example.com/docs']);
    });

    it('opens about:blank as the blank page, and refuses a url on any other kind or an empty one', () => {
        const f = fixture();
        const blank = f.run('workspace-tab-new', { workspace_id: W1, kind: 'web', url: 'about:blank' });
        expect(f.h.workspace(W1).webPanes[blank['pane_id'] as string]?.tabs[0]?.url).toBe('');
        expect(f.run('workspace-tab-new', { workspace_id: W1, kind: 'terminal', url: 'example.com' })).toMatchObject({
            ok: false,
            error: 'workspace-tab-new: a url is for a web tab, not a terminal tab'
        });
        expect(f.run('workspace-tab-new', { workspace_id: W1, kind: 'web', url: '   ' })).toMatchObject({ ok: false });
    });
});

describe('workspace-tab-new of the same kind as a shell', () => {
    it('asks where the shell really is first, and opens the terminal there', async () => {
        const asked: string[] = [];
        const f = fixture({
            liveWorkingDirectory: (paneID) => {
                asked.push(paneID);
                return Promise.resolve('/tmp/work/deeper');
            }
        });
        const pending = f.channel.run('workspace-tab-new', { workspace_id: W1, kind: 'same' });
        expect(pending).toBeInstanceOf(Promise);
        const reply = await pending;
        expect(asked).toEqual([P0]);
        expect(reply).toMatchObject({ ok: true, kind: 'terminal' });
        const pane = f.h.workspace(W1).panes.find((candidate) => candidate.id === reply['pane_id']);
        expect(pane?.workingDirectory).toBe('/tmp/work/deeper');
        expect(f.h.pty.spawns.find((spawn) => spawn.paneID === reply['pane_id'])?.cwd).toBe('/tmp/work/deeper');
    });

    it('opens where the shell last said when the OS cannot say', async () => {
        const f = fixture({ liveWorkingDirectory: () => Promise.reject(new Error('no lsof')) });
        const reply = await f.channel.run('workspace-tab-new', { workspace_id: W1, kind: 'same' });
        expect(f.h.workspace(W1).panes.find((pane) => pane.id === reply['pane_id'])?.workingDirectory).toBe('/tmp/work');
    });

    it('opens nothing when the workspace went away while it asked', async () => {
        const f = fixture({ liveWorkingDirectory: () => Promise.resolve('/tmp/work') });
        const pending = f.channel.run('workspace-tab-new', { workspace_id: W1, kind: 'same' });
        f.h.store.dispatch({ type: 'delete-workspace', id: W1 });
        expect(await pending).toMatchObject({ ok: false });
        expect(f.h.pty.spawns).toEqual([]);
    });

    it('answers at once for a terminal tab, which never asks', () => {
        const f = fixture({ liveWorkingDirectory: () => Promise.resolve('/elsewhere') });
        expect(f.channel.run('workspace-tab-new', { workspace_id: W1, kind: 'terminal' })).not.toBeInstanceOf(Promise);
    });

    it('stops waiting on a lookup that never answers, and opens where the shell last said', async () => {
        vi.useFakeTimers();
        const f = fixture({ liveWorkingDirectory: () => new Promise<string | null>(() => undefined) });
        const pending = f.channel.run('workspace-tab-new', { workspace_id: W1, kind: 'same' });
        await vi.advanceTimersByTimeAsync(LIVE_DIRECTORY_DEADLINE_MS);
        const reply = await pending;
        expect(reply).toMatchObject({ ok: true });
        expect(f.h.workspace(W1).panes.find((pane) => pane.id === reply['pane_id'])?.workingDirectory).toBe('/tmp/work');
    });

    it('opens behind the tab the user switched to while it asked', async () => {
        let answer: (directory: string) => void = () => undefined;
        const f = fixture({
            tabs: [T1, T2, T3],
            liveWorkingDirectory: () =>
                new Promise<string>((resolve) => {
                    answer = resolve;
                })
        });
        f.run('workspace-tab-new', { workspace_id: W1, kind: 'terminal', focus: false });
        const pending = f.channel.run('workspace-tab-new', { workspace_id: W1, kind: 'same' });
        f.h.store.dispatch({ type: 'select-tab', workspaceID: W1, tabID: T1 });
        answer('/tmp/work/deeper');
        const reply = await pending;
        expect(reply).toMatchObject({ ok: true, tab_id: T2 });
        const workspace = f.h.workspace(W1);
        expect(workspace.activeTabID).toBe(T1);
        expect(workspaceTabs(workspace).find((tab) => tab.id === T2)?.seen).toBe(false);
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('workspace-tab-duplicate', () => {
    it('copies the tab just after it, spawns the copies\' shells where the sources are, and shows it', async () => {
        const f = fixture({ liveWorkingDirectory: (paneID) => Promise.resolve(paneID === P0 ? '/tmp/work/live' : '/tmp/other') });
        seedSplit(f.h, { workspaceID: W1, sourcePaneID: P0, paneID: P1, label: 'worker' });
        const reply = await f.channel.run('workspace-tab-duplicate', { workspace_id: W1, tab_id: W1 });
        expect(reply).toMatchObject({ ok: true, workspace_id: W1, tab_id: T1 });
        const copies = reply['pane_ids'] as string[];
        expect(copies).toHaveLength(2);
        const workspace = f.h.workspace(W1);
        expect(workspaceTabs(workspace).map((tab) => tab.id)).toEqual([W1, T1]);
        expect(workspace.activeTabID).toBe(T1);
        expect(onScreenPaneIDs(workspace)).toEqual(copies);
        expect(workspace.panes.find((pane) => pane.id === copies[0])?.workingDirectory).toBe('/tmp/work/live');
        expect(workspace.panes.find((pane) => pane.id === copies[1])?.label).toBeNull();
        expect(f.h.pty.spawns.map((spawn) => spawn.paneID)).toEqual(expect.arrayContaining(copies));
        expect(f.h.pty.spawns.find((spawn) => spawn.paneID === copies[0])?.cwd).toBe('/tmp/work/live');
    });

    it('copies into the background with focus: false', () => {
        const f = fixture();
        const reply = f.run('workspace-tab-duplicate', { workspace_id: W1, tab_id: W1, focus: false });
        expect(reply).toMatchObject({ ok: true, tab_id: T1 });
        const workspace = f.h.workspace(W1);
        expect(workspace.activeTabID).toBe(W1);
        expect(onScreenPaneIDs(workspace)).toEqual([P0]);
        expect(tabPaneIDs(workspace, workspaceTabs(workspace)[1] as WorkspaceTab)).toEqual(reply['pane_ids']);
    });

    it('refuses an unknown tab or workspace', () => {
        const f = fixture();
        expect(f.run('workspace-tab-duplicate', { workspace_id: W1, tab_id: T3 })).toMatchObject({ ok: false });
        expect(f.run('workspace-tab-duplicate', { workspace_id: 'nope', tab_id: W1 })).toMatchObject({ ok: false });
        expect(workspaceTabs(f.h.workspace(W1))).toHaveLength(1);
    });

    it('rides the pane lifecycle channel', () => {
        expect(isPaneLifecycleCommand('workspace-tab-duplicate')).toBe(true);
    });

    it('gives each shell its own deadline: one stuck lookup costs only its own directory', async () => {
        vi.useFakeTimers();
        const f = fixture({
            liveWorkingDirectory: (paneID) => (paneID === P0 ? new Promise<string | null>(() => undefined) : Promise.resolve('/tmp/live'))
        });
        seedSplit(f.h, { workspaceID: W1, sourcePaneID: P0, paneID: P1 });
        const pending = f.channel.run('workspace-tab-duplicate', { workspace_id: W1, tab_id: W1 });
        await vi.advanceTimersByTimeAsync(LIVE_DIRECTORY_DEADLINE_MS);
        const reply = await pending;
        const copies = reply['pane_ids'] as string[];
        const directories = copies.map((paneID) => f.h.workspace(W1).panes.find((pane) => pane.id === paneID)?.workingDirectory);
        expect(directories).toEqual(['/tmp/work', '/tmp/live']);
    });

    it('opens the copy behind the tab the user switched to while it asked', async () => {
        let answer: (directory: string) => void = () => undefined;
        const f = fixture({
            liveWorkingDirectory: () =>
                new Promise<string>((resolve) => {
                    answer = resolve;
                })
        });
        const other = f.run('workspace-tab-new', { workspace_id: W1, kind: 'terminal', focus: false });
        const pending = f.channel.run('workspace-tab-duplicate', { workspace_id: W1, tab_id: W1 });
        f.h.store.dispatch({ type: 'select-tab', workspaceID: W1, tabID: String(other['tab_id']) });
        answer('/tmp/work');
        const reply = await pending;
        const workspace = f.h.workspace(W1);
        expect(workspace.activeTabID).toBe(other['tab_id']);
        expect(workspaceTabs(workspace).find((tab) => tab.id === reply['tab_id'])?.seen).toBe(false);
    });

    it('saves what is being typed into the tab\'s documents first, so the copy has it', () => {
        const f = fixture();
        const SCRATCH = testID('D', 102);
        f.h.store.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: SCRATCH, now: 1 });
        f.h.store.dispatch({ type: 'scratchpad-content-changed', workspaceID: W1, paneID: SCRATCH, content: 'saved draft' });
        const flushed: string[][] = [];
        const channel = createWorkspaceTabChannel({
            ctx: {
                ...f.h.ctx,
                mintTabID: () => T1,
                // The content service's flush: the buffered keystrokes reach the store.
                prepareDocumentClose: (paneIDs) => {
                    flushed.push([...paneIDs]);
                    f.h.store.dispatch({ type: 'scratchpad-content-changed', workspaceID: W1, paneID: SCRATCH, content: 'saved draft plus the last line' });
                }
            }
        });
        const reply = channel.run('workspace-tab-duplicate', { workspace_id: W1, tab_id: W1 }) as JsonObject;
        expect(flushed[0]?.sort()).toEqual([P0, SCRATCH].sort());
        const copy = (reply['pane_ids'] as string[]).find((paneID) => f.h.workspace(W1).panes.find((pane) => pane.id === paneID)?.type === 'scratchpad');
        expect(f.h.workspace(W1).panes.find((pane) => pane.id === copy)?.scratchpadContent).toBe('saved draft plus the last line');
    });

    it('still copies when a document will not save, with what was saved', () => {
        const f = fixture();
        const channel = createWorkspaceTabChannel({
            ctx: {
                ...f.h.ctx,
                mintTabID: () => T1,
                prepareDocumentClose: () => {
                    throw new Error('could not save notes.md');
                }
            }
        });
        expect(channel.run('workspace-tab-duplicate', { workspace_id: W1, tab_id: W1 })).toMatchObject({ ok: true, tab_id: T1 });
    });

    it('mints a copied web pane\'s page id through the same seam as tab ids', () => {
        const f = fixture();
        f.h.store.dispatch({ type: 'open-web-pane', workspaceID: W1, paneID: P1, tabID: testID('A', 1), url: 'https://example.com', now: 1, sourcePaneID: P0 });
        const reply = f.run('workspace-tab-duplicate', { workspace_id: W1, tab_id: W1 });
        const webCopy = (reply['pane_ids'] as string[]).find((paneID) => f.h.workspace(W1).webPanes[paneID] !== undefined) as string;
        expect(f.h.workspace(W1).webPanes[webCopy]?.activeTabID).toBe(T1);
        expect(reply['tab_id']).toBe(T2);
    });
});

describe('workspace-tab-close', () => {
    it('ends the PTY of every pane the tab took', () => {
        const f = fixture();
        const reply = f.run('workspace-tab-new', { workspace_id: W1 });
        const paneID = String(reply['pane_id']);
        seedSplit(f.h, { workspaceID: W1, sourcePaneID: paneID, paneID: P1 });
        const closed = f.channel.run('workspace-tab-close', { workspace_id: W1, tab_id: T1 });
        expect(closed).toMatchObject({ ok: true, closed: 2 });
        expect(f.h.pty.killed.sort()).toEqual([paneID, P1].sort());
        expect(f.h.term.disposed.sort()).toEqual([paneID, P1].sort());
        expect(workspaceTabs(f.h.workspace(W1)).map((tab) => tab.id)).toEqual([W1]);
        expect(f.h.workspace(W1).layout).toEqual(leaf(P0));
    });

    it('keeps the last tab', () => {
        const f = fixture();
        const reply = f.channel.run('workspace-tab-close', { workspace_id: W1, tab_id: W1 });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply['error'])).toContain('at least one tab');
        expect(f.h.pty.killed).toEqual([]);
    });

    it('refuses when a document will not save, closing nothing', () => {
        const f = fixture();
        f.run('workspace-tab-new', { workspace_id: W1 });
        const refusing = createWorkspaceTabChannel({
            ctx: {
                ...f.h.ctx,
                prepareDocumentClose: () => {
                    throw new Error('could not save notes.md');
                }
            }
        });
        expect(refusing.run('workspace-tab-close', { workspace_id: W1, tab_id: T1 })).toEqual({
            ok: false,
            error: 'could not save notes.md'
        });
        expect(workspaceTabs(f.h.workspace(W1))).toHaveLength(2);
    });
});

describe('moving panes and tabs', () => {
    it('pane-move-to-new-tab answers with the tab the pane landed in', () => {
        const f = fixture();
        seedSplit(f.h, { workspaceID: W1, sourcePaneID: P0, paneID: P1 });
        expect(f.channel.run('pane-move-to-new-tab', { pane_id: P1 })).toMatchObject({ ok: true, tab_id: T1 });
        const workspace = f.h.workspace(W1);
        expect(workspace.activeTabID).toBe(T1);
        expect(workspace.layout).toEqual(leaf(P1));
    });

    it('pane-move-to-tab checks its zone, a wire edge beside the named pane', () => {
        const f = fixture();
        const opened = f.run('workspace-tab-new', { workspace_id: W1 });
        const target = String(opened['pane_id']);
        expect(f.channel.run('pane-move-to-tab', { pane_id: P0, tab_id: T1, zone: 'middle' })).toMatchObject({ ok: false });
        expect(
            f.channel.run('pane-move-to-tab', { pane_id: P0, tab_id: T1, target_pane_id: target, zone: 'left-of' })
        ).toMatchObject({ ok: true });
        expect(f.h.workspace(W1).layout).toMatchObject({ kind: 'split', first: { kind: 'leaf', paneID: P0 } });
        expect(workspaceTabs(f.h.workspace(W1)).map((tab) => tab.id)).toEqual([T1]);
    });

    it('workspace-tab-move-to-workspace carries the tab and its panes over', () => {
        const f = fixture();
        seedWorkspace(f.h, { id: W2, name: 'other', paneID: testID('D', 200) });
        const opened = f.run('workspace-tab-new', { workspace_id: W1 });
        const reply = f.channel.run('workspace-tab-move-to-workspace', { workspace_id: W1, tab_id: T1, to_workspace_id: W2 });
        expect(reply).toMatchObject({ ok: true, workspace_id: W2, tab_id: T1 });
        expect(f.h.workspace(W2).panes.map((pane) => pane.id)).toContain(opened['pane_id']);
        expect(f.h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P0]);
    });

    it('split-panes mints a tab per extra pane', () => {
        const f = fixture();
        seedSplit(f.h, { workspaceID: W1, sourcePaneID: P0, paneID: P1 });
        expect(f.channel.run('workspace-tab-split-panes', { workspace_id: W1, tab_id: W1 })).toMatchObject({
            ok: true,
            tab_ids: [T1]
        });
        const workspace = f.h.workspace(W1);
        expect(tabPaneIDs(workspace, workspaceTabs(workspace)[1] as never)).toEqual([P1]);
        expect(f.channel.run('workspace-tab-split-panes', { workspace_id: W1, tab_id: W1 })).toMatchObject({ ok: false });
    });

    it('merge-previous refuses the first tab', () => {
        const f = fixture();
        f.run('workspace-tab-new', { workspace_id: W1 });
        expect(f.channel.run('workspace-tab-merge-previous', { workspace_id: W1, tab_id: W1 })).toMatchObject({ ok: false });
        // The reply names the tab it went into (the one left), and the merged one as merged_tab_id.
        expect(f.channel.run('workspace-tab-merge-previous', { workspace_id: W1, tab_id: T1 })).toEqual({ ok: true, workspace_id: W1, tab_id: W1, merged_tab_id: T1 });
        expect(workspaceTabs(f.h.workspace(W1))).toHaveLength(1);
    });
});

describe('rename and reorder', () => {
    it('rename takes a string or null and nothing else', () => {
        const f = fixture();
        expect(f.channel.run('workspace-tab-rename', { workspace_id: W1, tab_id: W1, name: 'main' })).toMatchObject({ ok: true });
        expect(workspaceTabs(f.h.workspace(W1))[0]?.name).toBe('main');
        expect(f.channel.run('workspace-tab-rename', { workspace_id: W1, tab_id: W1, name: 3 })).toMatchObject({ ok: false });
        expect(f.channel.run('workspace-tab-rename', { workspace_id: W1, tab_id: W1, name: null })).toMatchObject({ ok: true });
        expect(workspaceTabs(f.h.workspace(W1))[0]?.name).toBeNull();
    });

    it('move needs an index', () => {
        const f = fixture();
        f.run('workspace-tab-new', { workspace_id: W1 });
        expect(f.channel.run('workspace-tab-move', { workspace_id: W1, tab_id: T1 })).toMatchObject({ ok: false });
        expect(f.channel.run('workspace-tab-move', { workspace_id: W1, tab_id: T1, index: 0 })).toMatchObject({ ok: true });
        expect(workspaceTabs(f.h.workspace(W1)).map((tab) => tab.id)).toEqual([T1, W1]);
    });
});

import { describe, expect, it } from 'vitest';

import { allPaneIDs } from '@kelpi/core/layout';
import { decodeWireObject } from '@kelpi/protocol';

import { activeTabIDOf, tabLayout, tabOfPane, tabPaneIDs, workspaceTabs } from '../../store/index.js';
import { NOW, W1, W2, harness, seedSplit, seedWorkspace, testID, type Harness, type TestReply } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const P3 = testID('3', 3);
const T2 = testID('F', 2);
const T3 = testID('F', 3);
const NEW = testID('9', 9);

/** The tab handlers answer after the channel settles (it may be asynchronous). */
async function settled(h: Harness, msg: Parameters<Harness['run']>[0]): Promise<Record<string, unknown>> {
    const reply: TestReply = h.run(msg);
    for (let attempt = 0; attempt < 5 && reply.payloads.length === 0; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return reply.only();
}

/** W1 "dev": tab 1 holds P1, tab 2 ("build", named) holds P2 and P3; tab 1 on screen. */
function seeded(): Harness {
    const h = harness({ minted: [NEW] });
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1, path: '/repo' });
    h.store.dispatch({
        type: 'create-tab',
        workspaceID: W1,
        tabID: T2,
        focus: false,
        create: { type: 'create-pane', workspaceID: W1, paneID: P2, now: NOW, workingDirectory: '/repo/build', focus: true }
    });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P2, paneID: P3, label: 'worker' });
    h.store.dispatch({ type: 'rename-tab', workspaceID: W1, tabID: T2, name: 'build' });
    // The split above follows its pane onto the screen; put the first tab back.
    h.store.dispatch({ type: 'select-tab', workspaceID: W1, tabID: W1 });
    return h;
}

describe('workspace-tab-list', () => {
    it("lists the caller's workspace's tabs with what the bar shows", async () => {
        const h = seeded();
        const reply = await settled(h, { command: 'workspace-tab-list', pane_id: P1, all: false });
        expect(reply).toMatchObject({ ok: true, workspace_id: W1, workspace_name: 'dev' });
        const tabs = reply['tabs'] as Record<string, unknown>[];
        expect(tabs.map((tab) => [tab['number'], tab['name'], tab['title'], tab['pane_count'], tab['is_active']])).toEqual([
            [1, null, 'repo', 1, true],
            [2, 'build', 'build', 2, false]
        ]);
        expect(tabs[1]).toMatchObject({ id: T2, pane_ids: [P2, P3], status: 'idle', zoomed: false });
    });

    it('lists every workspace with all, each entry naming its workspace', async () => {
        const h = seeded();
        seedWorkspace(h, { id: W2, name: 'ops', paneID: testID('4', 4) });
        const reply = await settled(h, { command: 'workspace-tab-list', all: true });
        const tabs = reply['tabs'] as Record<string, unknown>[];
        expect(tabs.map((tab) => tab['workspace_name'])).toEqual(['dev', 'dev', 'ops']);
    });

    it('says which workspace it could not find', async () => {
        const h = seeded();
        expect(await settled(h, { command: 'workspace-tab-list', workspace: 'nope', all: false })).toEqual({
            ok: false,
            error: 'workspace not found: nope'
        });
    });
});

describe('workspace-tab-new', () => {
    it('opens a terminal tab in the BACKGROUND by default, and says where it went', async () => {
        const h = seeded();
        const reply = await settled(h, { command: 'workspace-tab-new', pane_id: P1, kind: 'terminal', at_end: true, name: 'logs' });
        const workspace = h.workspace(W1);
        const tabs = workspaceTabs(workspace);
        expect(tabs).toHaveLength(3);
        expect(reply).toMatchObject({ ok: true, workspace_name: 'dev', tab_number: 3, pane_id: NEW, kind: 'terminal', name: 'logs' });
        expect(tabs[2]?.name).toBe('logs');
        // Background: the tab on screen and its focus are untouched.
        expect(activeTabIDOf(workspace)).toBe(W1);
        expect(workspace.focusedPaneID).toBe(P1);
        expect(h.pty.spawns.map((spawn) => spawn.paneID)).toEqual([NEW]);
    });

    it('shows the new tab with focus, at the position asked for', async () => {
        const h = seeded();
        const reply = await settled(h, { command: 'workspace-tab-new', workspace: 'dev', kind: 'scratchpad', index: 0, at_end: false, focus: true });
        expect(reply).toMatchObject({ ok: true, tab_number: 1, kind: 'scratchpad' });
        expect(activeTabIDOf(h.workspace(W1))).toBe(reply['tab_id']);
    });

    it("opens next to the CALLER's tab, and copies the caller for the same kind, not what is on screen", async () => {
        // Seeded: tab 1 (P1, /repo) is on screen; the caller P2 (/repo/build) is in tab 2 behind it.
        const h = seeded();
        const reply = await settled(h, { command: 'workspace-tab-new', pane_id: P2, kind: 'same', at_end: false });
        expect(reply).toMatchObject({ ok: true, tab_number: 3, kind: 'terminal' });
        expect(h.workspace(W1).panes.find((pane) => pane.id === NEW)?.workingDirectory).toBe('/repo/build');
        expect(activeTabIDOf(h.workspace(W1))).toBe(W1);
        // From a pane in tab 1, the new tab goes right after tab 1.
        const h2 = harness({ minted: [NEW] });
        seedWorkspace(h2, { id: W1, name: 'dev', paneID: P1, path: '/repo' });
        h2.store.dispatch({
            type: 'create-tab',
            workspaceID: W1,
            tabID: T2,
            focus: true,
            create: { type: 'create-pane', workspaceID: W1, paneID: P2, now: NOW, workingDirectory: '/repo/build', focus: true }
        });
        expect(await settled(h2, { command: 'workspace-tab-new', pane_id: P1, kind: 'terminal', at_end: false })).toMatchObject({ ok: true, tab_number: 2 });
    });

    it('refuses a kind it does not know', async () => {
        const h = seeded();
        const reply = await settled(h, { command: 'workspace-tab-new', pane_id: P1, kind: 'spreadsheet', at_end: false });
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain("unknown tab kind 'spreadsheet'");
    });

    it('opens a web tab at a url, and reports the address it was given', async () => {
        const h = seeded();
        const reply = await settled(h, { command: 'workspace-tab-new', pane_id: P1, url: 'example.com', at_end: true });
        expect(reply).toMatchObject({ ok: true, kind: 'web', url: 'https://example.com', tab_number: 3 });
        expect(h.workspace(W1).webPanes[reply['pane_id'] as string]?.tabs[0]?.url).toBe('https://example.com');
    });
});

describe('naming a tab', () => {
    it('finds a tab by number, by id, and by the title the bar shows', async () => {
        for (const tab of ['2', T2, 'build', 'BUILD']) {
            const h = seeded();
            const reply = await settled(h, { command: 'workspace-tab-select', pane_id: P1, tab });
            expect(reply).toMatchObject({ ok: true, tab_id: T2, tab_number: 2 });
            expect(activeTabIDOf(h.workspace(W1))).toBe(T2);
        }
    });

    it('says how many tabs there are when the number is past the last', async () => {
        const h = seeded();
        expect(await settled(h, { command: 'workspace-tab-select', pane_id: P1, tab: '7' })).toEqual({
            ok: false,
            error: "no tab 7 in workspace 'dev' (it has 2 tabs)"
        });
    });

    it('never guesses between two tabs with the same title', async () => {
        const h = seeded();
        h.store.dispatch({ type: 'rename-tab', workspaceID: W1, tabID: W1, name: 'build' });
        const reply = await settled(h, { command: 'workspace-tab-select', pane_id: P1, tab: 'build' });
        expect(reply).toEqual({ ok: false, error: "tab name 'build' is ambiguous in workspace 'dev': tabs 1, 2 (use a number or id)" });
    });

    it('prefers a name the user gave over a title a program set, in any case', async () => {
        const h = seeded();
        // Tab 1 is unnamed and titled after its pane, whose program now calls itself "build";
        // tab 2 is the one the user named "build". Neither "build" nor "Build" is ambiguous.
        h.store.dispatch({ type: 'pane-title-changed', paneID: P1, title: 'build', now: NOW });
        for (const tab of ['build', 'Build']) {
            expect(await settled(h, { command: 'workspace-tab-select', pane_id: P1, tab })).toMatchObject({ ok: true, tab_id: T2 });
        }
        // A derived title still reaches its tab when no name matches.
        h.store.dispatch({ type: 'pane-title-changed', paneID: P1, title: 'vim', now: NOW });
        expect(await settled(h, { command: 'workspace-tab-select', pane_id: P1, tab: 'VIM' })).toMatchObject({ ok: true, tab_id: W1 });
    });

    it("uses the caller's own tab when none is named, and asks for one from outside a pane", async () => {
        const h = seeded();
        expect(await settled(h, { command: 'workspace-tab-rename', pane_id: P3, name: 'workers', clear: false })).toMatchObject({
            ok: true,
            tab_id: T2,
            name: 'workers'
        });
        expect(await settled(h, { command: 'workspace-tab-rename', workspace: 'dev', name: 'x', clear: false })).toEqual({
            ok: false,
            error: "name a tab in workspace 'dev': a number, an id or a title"
        });
    });
});

describe('the tab verbs', () => {
    it('renames and clears a name', async () => {
        const h = seeded();
        await settled(h, { command: 'workspace-tab-rename', pane_id: P1, tab: '2', clear: true });
        expect(workspaceTabs(h.workspace(W1))[1]?.name).toBeNull();
    });

    it('moves a tab to a 0-based position or to the end, and refuses one past it', async () => {
        const h = seeded();
        expect(await settled(h, { command: 'workspace-tab-move', pane_id: P1, tab: '2', index: 0, at_end: false })).toMatchObject({
            ok: true,
            tab_number: 1
        });
        expect(await settled(h, { command: 'workspace-tab-move', pane_id: P1, tab: 'build', at_end: true })).toMatchObject({ tab_number: 2 });
        expect(await settled(h, { command: 'workspace-tab-move', pane_id: P1, tab: 'build', index: 5, at_end: false })).toEqual({
            ok: false,
            error: "no position 6 in workspace 'dev' (it has 2 tabs)"
        });
    });

    it('closes a tab and ends its panes, but never the only tab', async () => {
        const h = seeded();
        expect(await settled(h, { command: 'workspace-tab-close', pane_id: P1, tab: '2', force: false })).toMatchObject({ ok: true, closed: 2 });
        expect(h.pty.killed.sort()).toEqual([P2, P3].sort());
        expect(await settled(h, { command: 'workspace-tab-close', pane_id: P1, tab: '1', force: false })).toEqual({
            ok: false,
            error: 'a workspace keeps at least one tab'
        });
    });

    it('closes every other tab', async () => {
        const h = seeded();
        expect(await settled(h, { command: 'workspace-tab-close-others', pane_id: P1, tab: '1', force: false })).toMatchObject({ ok: true, closed: 2, tab_number: 1 });
        expect(workspaceTabs(h.workspace(W1))).toHaveLength(1);
    });

    it('refuses to close a tab whose panes hold agents unless forced, as workspace delete does', async () => {
        const h = seeded();
        h.store.dispatch({ type: 'pane-agent-event', paneID: P3, event: { type: 'agentStarted', agent: 'claude' }, now: NOW });
        expect(await settled(h, { command: 'workspace-tab-close', pane_id: P1, tab: 'build', force: false })).toEqual({
            ok: false,
            error: 'tab 2 has 1 running agent; pass --force to close anyway',
            active_agents: 1,
            running: 1,
            waiting: 0,
            inactive: 0
        });
        expect(workspaceTabs(h.workspace(W1))).toHaveLength(2);
        expect(h.pty.killed).toEqual([]);
        expect(await settled(h, { command: 'workspace-tab-close', pane_id: P1, tab: 'build', force: true })).toMatchObject({ ok: true, closed: 2 });
        expect(workspaceTabs(h.workspace(W1))).toHaveLength(1);
    });

    it('refuses close-others over agents in the other tabs, but not over the caller itself', async () => {
        const h = seeded();
        h.store.dispatch({ type: 'pane-agent-event', paneID: P2, event: { type: 'agentStarted', agent: 'claude' }, now: NOW });
        const refused = await settled(h, { command: 'workspace-tab-close-others', pane_id: P1, tab: '1', force: false });
        expect(refused).toMatchObject({ ok: false, active_agents: 1, running: 1 });
        expect(String(refused['error'])).toBe("the other tabs of workspace dev have 1 running agent; pass --force to close anyway");
        // An agent closing its own tab (the agent is the caller) is not asking about itself.
        expect(await settled(h, { command: 'workspace-tab-close', pane_id: P2, force: false })).toMatchObject({ ok: true, closed: 2 });
    });

    it('gives each pane its own tab, and merges a tab into the one before it', async () => {
        const h = seeded();
        const split = await settled(h, { command: 'workspace-tab-split-panes', pane_id: P1, tab: 'build' });
        expect(split).toMatchObject({ ok: true, tab_number: 2, tab_numbers: [3] });
        expect(workspaceTabs(h.workspace(W1))).toHaveLength(3);
        const merged = await settled(h, { command: 'workspace-tab-merge-previous', pane_id: P1, tab: '3' });
        expect(merged).toMatchObject({ ok: true, tab_id: T2, tab_number: 2 });
        expect(tabPaneIDs(h.workspace(W1), workspaceTabs(h.workspace(W1))[1]!).sort()).toEqual([P2, P3].sort());
    });

    it('moves a tab to another workspace by name, in the background', async () => {
        const h = seeded();
        seedWorkspace(h, { id: W2, name: 'ops', paneID: testID('4', 4) });
        const reply = await settled(h, { command: 'workspace-tab-move-to-workspace', pane_id: P1, tab: 'build', to_workspace: 'ops' });
        expect(reply).toMatchObject({ ok: true, workspace_id: W2, workspace_name: 'ops', tab_id: T2, tab_number: 2, from_workspace_id: W1 });
        expect(workspaceTabs(h.workspace(W1))).toHaveLength(1);
    });

    it('duplicates a tab by name, in the background, as the tab after it', async () => {
        const h = seeded();
        const reply = await settled(h, { command: 'workspace-tab-duplicate', pane_id: P1, tab: 'build' });
        expect(reply).toMatchObject({ ok: true, workspace_id: W1, tab_number: 3, source_tab_id: T2 });
        const tabs = workspaceTabs(h.workspace(W1));
        expect(tabs).toHaveLength(3);
        const copy = tabs[2]!;
        expect(reply['tab_id']).toBe(copy.id);
        expect(copy.name).toBe('build');
        // Two fresh shells, neither of them the originals, and no label carried over.
        const copies = tabPaneIDs(h.workspace(W1), copy);
        expect(copies).toHaveLength(2);
        expect(copies.some((id) => id === P2 || id === P3)).toBe(false);
        expect(h.workspace(W1).panes.filter((pane) => copies.includes(pane.id)).map((pane) => pane.label ?? null)).toEqual([null, null]);
        // Background: the caller's tab stays on screen.
        expect(activeTabIDOf(h.workspace(W1))).toBe(W1);
        expect(h.pty.spawns.map((spawn) => spawn.paneID).sort()).toEqual([...copies].sort());
    });

    it('shows the copy with --focus', async () => {
        const h = seeded();
        const reply = await settled(h, { command: 'workspace-tab-duplicate', pane_id: P1, tab: '2', focus: true });
        expect(activeTabIDOf(h.workspace(W1))).toBe(reply['tab_id']);
    });

    it('reports a duplicate of a tab it cannot find', async () => {
        const h = seeded();
        expect(await settled(h, { command: 'workspace-tab-duplicate', pane_id: P1, tab: 'nope' })).toEqual({
            ok: false,
            error: "no tab matching 'nope' in workspace 'dev'"
        });
    });
});

describe('moving a pane between tabs', () => {
    it('takes a pane out into a new tab, in the background', async () => {
        const h = seeded();
        const reply = await settled(h, { command: 'pane-move-to-new-tab', pane_id: P1, target: 'worker', at_end: true });
        const workspace = h.workspace(W1);
        expect(reply).toMatchObject({ ok: true, pane_id: P3, tab_number: 3 });
        expect(tabOfPane(workspace, P3)?.id).toBe(reply['tab_id']);
        expect(activeTabIDOf(workspace)).toBe(W1);
    });

    it('refuses a pane alone in its tab', async () => {
        const h = seeded();
        expect(await settled(h, { command: 'pane-move-to-new-tab', pane_id: P1, at_end: false })).toEqual({
            ok: false,
            error: 'the pane is alone in its tab already'
        });
    });

    it('moves a pane into a named tab, beside an anchor of that tab', async () => {
        const h = seeded();
        const reply = await settled(h, { command: 'pane-move-to-tab', pane_id: P1, tab: 'build', anchor: 'worker', zone: 'below' });
        expect(reply).toMatchObject({ ok: true, pane_id: P1, tab_id: T2, anchor_id: P3 });
        expect(tabOfPane(h.workspace(W1), P1)?.id).toBe(T2);
    });

    it('refuses an anchor outside the tab, and a move into the tab the pane is in', async () => {
        const h = seeded();
        h.store.dispatch({
            type: 'create-tab',
            workspaceID: W1,
            tabID: T3,
            focus: false,
            create: { type: 'create-pane', workspaceID: W1, paneID: testID('5', 5), now: NOW, focus: true }
        });
        expect(await settled(h, { command: 'pane-move-to-tab', pane_id: P1, tab: T3, anchor: 'worker' })).toEqual({
            ok: false,
            error: "no pane matching 'worker' in that tab"
        });
        expect(await settled(h, { command: 'pane-move-to-tab', pane_id: P2, tab: 'build' })).toEqual({
            ok: false,
            error: 'the pane is in that tab already'
        });
    });
});

/** A raw control-socket line through the real decoder, then the handler: a refusal at either step is the reply. */
async function decoded(h: Harness, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = decodeWireObject(raw);
    if (!result.ok) return { ok: false, error: result.detail };
    return settled(h, result.message);
}

function decodedMessage(raw: Record<string, unknown>): Parameters<Harness['run']>[0] {
    const result = decodeWireObject(raw);
    if (!result.ok) throw new Error(result.detail);
    return result.message;
}

describe('what a tab verb names, and nothing else', () => {
    it("refuses a blank tab rather than acting on the caller's own tab", async () => {
        const h = seeded();
        for (const raw of [
            { command: 'workspace-tab-close', pane_id: P1, tab: '' },
            { command: 'workspace-tab-close', pane_id: P1, tab: '   ' },
            { command: 'workspace-tab-close-others', pane_id: P1, tab: '' },
            { command: 'workspace-tab-move-to-workspace', pane_id: P1, tab: '', to_workspace: 'dev' }
        ]) {
            expect(await decoded(h, raw)).toEqual({ ok: false, error: 'tab is empty (an unset variable?)' });
        }
        expect(await decoded(h, { command: 'workspace-tab-close', pane_id: P1, tab: '2', workspace: '' })).toEqual({
            ok: false,
            error: 'workspace is empty (an unset variable?)'
        });
        expect(await decoded(h, { command: 'workspace-tab-move-to-workspace', pane_id: P1, tab: '2', to_workspace: '' })).toEqual({
            ok: false,
            error: 'to_workspace is empty (an unset variable?)'
        });
        expect(await decoded(h, { command: 'pane-move-to-tab', pane_id: P1, tab: '2', anchor: '' })).toEqual({
            ok: false,
            error: 'anchor is empty (an unset variable?)'
        });
        expect(workspaceTabs(h.workspace(W1))).toHaveLength(2);
        expect(h.workspace(W1).panes).toHaveLength(3);
    });

    it("acts on the tab the WS shape names by id, never the caller's own", async () => {
        const h = seeded();
        const reply = await decoded(h, { command: 'workspace-tab-close', pane_id: P1, workspace_id: W1, tab_id: T2 });
        expect(reply).toMatchObject({ ok: true, tab_id: T2 });
        expect(workspaceTabs(h.workspace(W1)).map((tab) => tab.id)).toEqual([W1]);
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1]);
    });

    it('refuses both spellings at once, and an id that names nothing', async () => {
        const h = seeded();
        expect(await decoded(h, { command: 'workspace-tab-select', pane_id: P1, tab: '2', tab_id: T2 })).toEqual({
            ok: false,
            error: 'give tab or tab_id, not both'
        });
        expect(await decoded(h, { command: 'workspace-tab-select', pane_id: P1, tab_id: T3 })).toEqual({
            ok: false,
            error: `no tab with id ${T3}`
        });
        expect(await decoded(h, { command: 'workspace-tab-select', pane_id: P1, workspace_id: W2, tab: '1' })).toEqual({
            ok: false,
            error: `no workspace with id ${W2}`
        });
    });

    it('moves a pane by the WS shape of pane-move-to-tab: tab_id and target_pane_id', async () => {
        const h = seeded();
        const reply = await decoded(h, { command: 'pane-move-to-tab', pane_id: P1, tab_id: T2, target_pane_id: P3, zone: 'below' });
        expect(reply).toMatchObject({ ok: true, tab_id: T2, anchor_id: P3 });
        expect(tabOfPane(h.workspace(W1), P1)?.id).toBe(T2);
    });

    it('moves a pane beside an anchor of its own tab, as pane move does', async () => {
        const h = seeded();
        const before = tabLayout(h.workspace(W1), workspaceTabs(h.workspace(W1))[1]!).layout;
        expect(allPaneIDs(before)).toEqual([P2, P3]);
        const reply = await decoded(h, { command: 'pane-move-to-tab', pane_id: P2, tab: 'build', anchor: 'worker', zone: 'below' });
        expect(reply).toMatchObject({ ok: true, pane_id: P2, tab_id: T2, anchor_id: P3, zone: 'below' });
        const after = tabLayout(h.workspace(W1), workspaceTabs(h.workspace(W1))[1]!).layout;
        expect(allPaneIDs(after)).toEqual([P3, P2]);
        expect(after).toMatchObject({ kind: 'split', direction: 'vertical' });
    });

    it('refuses a caller pane that no longer exists instead of acting on the workspace on screen', async () => {
        const h = seeded();
        seedWorkspace(h, { id: W2, name: 'ops', paneID: testID('4', 4) });
        const gone = testID('8', 8);
        expect(await decoded(h, { command: 'workspace-tab-new', pane_id: gone })).toEqual({
            ok: false,
            error: `origin pane '${gone}' no longer exists; pass --workspace <name-or-id> to address a tab in another workspace`
        });
        expect(workspaceTabs(h.workspace(W2))).toHaveLength(1);
        expect(workspaceTabs(h.workspace(W1))).toHaveLength(2);
    });

    it('tries a number past the last tab as a title, and keeps a number in range a position', async () => {
        const h = seeded();
        h.store.dispatch({ type: 'rename-tab', workspaceID: W1, tabID: T2, name: '7' });
        expect(await decoded(h, { command: 'workspace-tab-select', pane_id: P1, tab: '7' })).toMatchObject({ ok: true, tab_id: T2 });
        h.store.dispatch({ type: 'rename-tab', workspaceID: W1, tabID: T2, name: '1' });
        expect(await decoded(h, { command: 'workspace-tab-select', pane_id: P1, tab: '1' })).toMatchObject({ ok: true, tab_id: W1 });
    });

    it('finds a tab id in another workspace with no --workspace', async () => {
        const h = seeded();
        const opsTab = testID('F', 7);
        seedWorkspace(h, { id: W2, name: 'ops', paneID: testID('4', 4) });
        h.store.dispatch({
            type: 'create-tab',
            workspaceID: W2,
            tabID: opsTab,
            focus: false,
            create: { type: 'create-pane', workspaceID: W2, paneID: testID('6', 6), now: NOW, focus: true }
        });
        h.store.dispatch({ type: 'select-tab', workspaceID: W2, tabID: W2 });
        const reply = await decoded(h, { command: 'workspace-tab-select', pane_id: P1, tab: opsTab });
        expect(reply).toMatchObject({ ok: true, workspace_id: W2, tab_id: opsTab, tab_number: 2 });
        expect(activeTabIDOf(h.workspace(W2))).toBe(opsTab);
    });

    it('sends a tab to a workspace named in any case', async () => {
        const h = seeded();
        seedWorkspace(h, { id: W2, name: 'ops', paneID: testID('4', 4) });
        const reply = await decoded(h, { command: 'workspace-tab-move-to-workspace', pane_id: P1, tab: 'build', to_workspace: 'OPS' });
        expect(reply).toMatchObject({ ok: true, workspace_id: W2, tab_id: T2 });
    });

    it('answers with the name as stored: trimmed, and null once a blank name clears it', async () => {
        const h = seeded();
        expect(await decoded(h, { command: 'workspace-tab-rename', pane_id: P1, tab: '2', name: '  spaced  ' })).toMatchObject({ ok: true, name: 'spaced' });
        expect(await decoded(h, { command: 'workspace-tab-rename', pane_id: P1, tab: '2', name: '   ' })).toMatchObject({ ok: true, name: null });
        expect(await decoded(h, { command: 'workspace-tab-new', pane_id: P1, name: '  logs ' })).toMatchObject({ ok: true, name: 'logs' });
    });
});

describe('duplicate through the control socket, while the OS lookup is out', () => {
    function waiting(): { readonly h: Harness; readonly answer: (directory: string) => void } {
        const answers: ((directory: string) => void)[] = [];
        const h = harness({
            minted: [NEW],
            liveWorkingDirectory: () =>
                new Promise<string | null>((resolve) => {
                    answers.push(resolve);
                })
        });
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1, path: '/repo' });
        h.store.dispatch({
            type: 'create-tab',
            workspaceID: W1,
            tabID: T2,
            focus: false,
            create: { type: 'create-pane', workspaceID: W1, paneID: P2, now: NOW, workingDirectory: '/repo/build', focus: true }
        });
        h.store.dispatch({ type: 'select-tab', workspaceID: W1, tabID: W1 });
        return {
            h,
            answer: (directory) => {
                for (const resolve of answers.splice(0)) resolve(directory);
            }
        };
    }

    async function drain(reply: TestReply): Promise<void> {
        for (let attempt = 0; attempt < 10 && reply.payloads.length === 0; attempt += 1) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }

    it('answers once the lookup does, with the copy in the directory the shell is really in', async () => {
        const { h, answer } = waiting();
        const reply = h.run(decodedMessage({ command: 'workspace-tab-duplicate', pane_id: P1, tab: '2' }));
        await new Promise((resolve) => setImmediate(resolve));
        expect(reply.payloads).toHaveLength(0);
        answer('/repo/build/src');
        await drain(reply);
        expect(reply.only()).toMatchObject({ ok: true, tab_number: 3, source_tab_id: T2 });
        expect(h.pty.spawns.map((spawn) => spawn.cwd)).toEqual(['/repo/build/src']);
    });

    it('refuses the copy of a tab closed while it waited, and opens nothing', async () => {
        const { h, answer } = waiting();
        const reply = h.run(decodedMessage({ command: 'workspace-tab-duplicate', pane_id: P1, tab: '2' }));
        await new Promise((resolve) => setImmediate(resolve));
        h.store.dispatch({ type: 'close-tab', workspaceID: W1, tabID: T2 });
        answer('/repo/build/src');
        await drain(reply);
        expect(reply.only()).toMatchObject({ ok: false });
        expect(workspaceTabs(h.workspace(W1))).toHaveLength(1);
        expect(h.pty.spawns).toHaveLength(0);
    });
});

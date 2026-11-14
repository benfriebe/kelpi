import { describe, expect, it } from 'vitest';

import { activeTabIDOf, tabOfPane, tabPaneIDs, workspaceTabs } from '../../store/index.js';
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
        expect(await settled(h, { command: 'workspace-tab-close', pane_id: P1, tab: '2' })).toMatchObject({ ok: true, closed: 2 });
        expect(h.pty.killed.sort()).toEqual([P2, P3].sort());
        expect(await settled(h, { command: 'workspace-tab-close', pane_id: P1, tab: '1' })).toEqual({
            ok: false,
            error: 'a workspace keeps at least one tab'
        });
    });

    it('closes every other tab', async () => {
        const h = seeded();
        expect(await settled(h, { command: 'workspace-tab-close-others', pane_id: P1, tab: '1' })).toMatchObject({ ok: true, closed: 2, tab_number: 1 });
        expect(workspaceTabs(h.workspace(W1))).toHaveLength(1);
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

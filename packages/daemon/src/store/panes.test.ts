import { allPaneIDs, ratioAtPath } from '@kelpi/core/layout';
import { describe, expect, it } from 'vitest';
import { workspaceByID } from './derived.js';
import { harness, HOME, id, NOW, seededState, W1, W2 } from './testing.js';
import type { DaemonState, WorkspaceState } from './types.js';

const P0 = id('dddddddd', 100);
const PA = id('eeeeeeee', 1);
const PB = id('eeeeeeee', 2);
const PC = id('eeeeeeee', 3);

function ws(state: DaemonState, workspaceID = W1): WorkspaceState {
    const workspace = workspaceByID(state, workspaceID);
    if (workspace === null) throw new Error(`workspace ${workspaceID} missing`);
    return workspace;
}

describe('create-pane', () => {
    it('lays out the first pane of an empty workspace', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P0 });
        expect(ws(h.state()).layout).toEqual({ kind: 'empty' });

        h.dispatch({
            type: 'create-pane',
            workspaceID: W1,
            paneID: PA,
            now: NOW,
            label: 'worker',
            workingDirectory: '/tmp/work'
        });
        const workspace = ws(h.state());
        expect(workspace.panes).toHaveLength(1);
        expect(workspace.panes[0]?.label).toBe('worker');
        expect(workspace.panes[0]?.workingDirectory).toBe('/tmp/work');
        expect(workspace.layout).toEqual({ kind: 'leaf', paneID: PA });
        expect(workspace.focusedPaneID).toBe(PA);
    });

    it('falls back to the home directory for an empty path', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P0 });
        h.dispatch({
            type: 'create-pane',
            workspaceID: W1,
            paneID: PA,
            now: NOW,
            workingDirectory: ''
        });
        expect(ws(h.state()).panes[0]?.workingDirectory).toBe(HOME);
    });

    it('QUIRK: replaces the whole layout on a populated workspace (Swift behaviour kept)', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'create-pane', workspaceID: W1, paneID: PA, now: NOW });
        const workspace = ws(h.state());
        // Both panes still exist, but the original is orphaned from the layout.
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P0, PA]);
        expect(allPaneIDs(workspace.layout)).toEqual([PA]);
        // …and the layout index is deliberately NOT reset by this action.
        expect(workspace.currentLayoutIndex).toBeNull();
    });
});

describe('split-pane', () => {
    it('puts the new pane second at ratio 0.5 and inherits the source cwd', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'pane-directory-changed',
            paneID: P0,
            directory: '/repo',
            now: NOW
        });
        h.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: PA,
            direction: 'horizontal',
            now: NOW
        });
        const workspace = ws(h.state());
        expect(workspace.layout).toEqual({
            kind: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { kind: 'leaf', paneID: P0 },
            second: { kind: 'leaf', paneID: PA }
        });
        expect(workspace.panes[1]?.workingDirectory).toBe('/repo');
        expect(workspace.focusedPaneID).toBe(PA);
        expect(workspace.focusHistory).toEqual([P0]);
    });

    it('un-zooms first and clears the layout index', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'cycle-layout', workspaceID: W1 },
            { type: 'toggle-zoom', workspaceID: W1 }
        );
        expect(ws(h.state()).zoomedPaneID).toBe(PA);
        h.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: PB,
            direction: 'vertical',
            now: NOW
        });
        const workspace = ws(h.state());
        expect(workspace.zoomedPaneID).toBeNull();
        expect(workspace.savedLayout).toBeNull();
        expect(workspace.currentLayoutIndex).toBeNull();
        expect(allPaneIDs(workspace.layout).sort()).toEqual([P0, PA, PB].sort());
    });

    it('no-ops for a source pane that is parked or unknown', () => {
        const h = harness(seededState());
        const before = h.state();
        h.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: PA,
            direction: 'horizontal',
            sourcePaneID: 'not-a-pane',
            now: NOW
        });
        expect(h.state()).toBe(before);
    });
});

describe('split-pane-at-path', () => {
    it('uses the path as the new pane cwd and splits the focused pane', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'split-pane-at-path',
            workspaceID: W1,
            paneID: PA,
            path: '/srv/app',
            now: NOW
        });
        const workspace = ws(h.state());
        expect(workspace.panes[1]?.workingDirectory).toBe('/srv/app');
        expect(allPaneIDs(workspace.layout)).toEqual([P0, PA]);
    });

    it('QUIRK: a stale focused pane appends an orphan instead of failing', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: 'ghost-pane' });
        h.dispatch({
            type: 'split-pane-at-path',
            workspaceID: W1,
            paneID: PA,
            path: '/srv/app',
            now: NOW
        });
        const workspace = ws(h.state());
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P0, PA]);
        expect(allPaneIDs(workspace.layout)).toEqual([P0]); // PA never entered the tree
    });
});

describe('close-pane', () => {
    it('collapses the split and restores focus from history', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'split-pane', workspaceID: W1, paneID: PB, direction: 'vertical', now: NOW }
        );
        expect(ws(h.state()).focusHistory).toEqual([P0, PA]);
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: PB });
        const workspace = ws(h.state());
        expect(workspace.focusedPaneID).toBe(PA);
        expect(workspace.focusHistory).toEqual([P0]);
        expect(allPaneIDs(workspace.layout)).toEqual([P0, PA]);
        expect(workspace.currentLayoutIndex).toBeNull();
    });

    it('falls back to layout order when the history is exhausted', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'close-pane', workspaceID: W1, paneID: P0 },
            { type: 'close-pane', workspaceID: W1, paneID: PA }
        );
        expect(ws(h.state()).focusedPaneID).toBeNull();
        expect(ws(h.state()).panes).toHaveLength(0);
        expect(ws(h.state()).layout).toEqual({ kind: 'empty' });
    });

    it('snapshots the closed pane for reopen, capped at 10', () => {
        const h = harness(seededState());
        for (let index = 0; index < 12; index += 1) {
            const paneID = id('ffffffff', index + 1);
            h.dispatch(
                {
                    type: 'split-pane',
                    workspaceID: W1,
                    paneID,
                    direction: 'horizontal',
                    now: NOW,
                    label: `pane-${index}`
                },
                { type: 'close-pane', workspaceID: W1, paneID }
            );
        }
        const snapshots = ws(h.state()).recentlyClosedPanes;
        expect(snapshots).toHaveLength(10);
        expect(snapshots.at(-1)?.label).toBe('pane-11');
        expect(snapshots[0]?.label).toBe('pane-2');
    });

    /**
     * CONT-142 — the `ClosedPaneSnapshot` payload for the CONTENT pane types: the type itself,
     * the file path, the scratchpad's text and the markdown font size all have to survive the
     * close, because a reopened content pane is rebuilt from the snapshot alone
     * (WorkspaceFeature.swift:1282-1298 → :1906-1940).
     */
    it('CONT-142: snapshots type, file path, scratchpad text and font size for content panes', () => {
        const h = harness(seededState());
        h.dispatch(
            {
                type: 'open-markdown-pane',
                workspaceID: W1,
                paneID: PA,
                filePath: '/docs/readme.md',
                now: NOW
            },
            { type: 'set-markdown-font-size', workspaceID: W1, paneID: PA, size: 19 },
            { type: 'create-scratchpad', workspaceID: W1, paneID: PB, now: NOW },
            {
                type: 'scratchpad-content-changed',
                workspaceID: W1,
                paneID: PB,
                content: 'buy milk'
            },
            {
                type: 'open-diff-pane',
                workspaceID: W1,
                paneID: PC,
                repoPath: '/srv/app',
                targetPath: '/srv/app/src',
                now: NOW
            },
            { type: 'close-pane', workspaceID: W1, paneID: PC },
            { type: 'close-pane', workspaceID: W1, paneID: PB },
            { type: 'close-pane', workspaceID: W1, paneID: PA }
        );
        const snapshots = ws(h.state()).recentlyClosedPanes;
        expect(snapshots.map((snapshot) => snapshot.type)).toEqual(['diff', 'scratchpad', 'markdown']);
        expect(snapshots[0]).toMatchObject({
            type: 'diff',
            filePath: '/srv/app/src',
            workingDirectory: '/srv/app'
        });
        expect(snapshots[1]).toMatchObject({ type: 'scratchpad', scratchpadContent: 'buy milk' });
        expect(snapshots[2]).toMatchObject({
            type: 'markdown',
            filePath: '/docs/readme.md',
            markdownFontSize: 19
        });

        // …and the newest snapshot rebuilds a working pane: file path, font size, and the
        // scratchpad's edit mode all come back off the payload.
        h.dispatch({ type: 'reopen-closed-pane', workspaceID: W1, paneID: id('eeeeeeee', 9), now: NOW });
        expect(ws(h.state()).panes.at(-1)).toMatchObject({
            type: 'markdown',
            filePath: '/docs/readme.md',
            markdownFontSize: 19,
            isEditing: false
        });
        h.dispatch({ type: 'reopen-closed-pane', workspaceID: W1, paneID: id('eeeeeeee', 10), now: NOW });
        expect(ws(h.state()).panes.at(-1)).toMatchObject({
            type: 'scratchpad',
            scratchpadContent: 'buy milk',
            isEditing: true
        });
    });

    it('unparks the source pane when closing a `--here` replacement', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PA,
            filePath: '/docs/readme.md',
            reusePaneID: P0,
            now: NOW
        });
        let workspace = ws(h.state());
        expect(workspace.parkedPanes.map((pane) => pane.id)).toEqual([P0]);
        expect(workspace.panes.map((pane) => pane.id)).toEqual([PA]);
        expect(workspace.panes[0]?.parkedSourcePaneID).toBe(P0);

        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: PA });
        workspace = ws(h.state());
        expect(workspace.parkedPanes).toHaveLength(0);
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P0]);
        expect(workspace.layout).toEqual({ kind: 'leaf', paneID: P0 });
        expect(workspace.focusedPaneID).toBe(P0);
        // Direct assignment: the closed pane never lands in its own history.
        expect(workspace.focusHistory).toEqual([]);
        expect(workspace.recentlyClosedPanes).toHaveLength(0);
    });
});

describe('content panes', () => {
    it('QUIRK: opening markdown while zoomed does NOT un-zoom (Swift behaviour kept)', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'toggle-zoom', workspaceID: W1 },
            {
                type: 'open-markdown-pane',
                workspaceID: W1,
                paneID: PB,
                filePath: '/docs/a.md',
                now: NOW
            }
        );
        const workspace = ws(h.state());
        expect(workspace.zoomedPaneID).toBe(PA); // still "zoomed" over a two-leaf layout
        expect(workspace.savedLayout).not.toBeNull();
        expect(allPaneIDs(workspace.layout)).toEqual([PA, PB]);
    });

    it('names markdown panes after the file and diff panes after the scope', () => {
        const h = harness(seededState());
        h.dispatch(
            {
                type: 'open-markdown-pane',
                workspaceID: W1,
                paneID: PA,
                filePath: '/docs/readme.md',
                now: NOW
            },
            {
                type: 'open-diff-pane',
                workspaceID: W1,
                paneID: PB,
                repoPath: '/srv/app',
                targetPath: '/srv/app/src',
                now: NOW
            }
        );
        const panes = ws(h.state()).panes;
        expect(panes[1]).toMatchObject({
            type: 'markdown',
            label: 'readme.md',
            title: 'readme.md',
            workingDirectory: '/docs',
            filePath: '/docs/readme.md'
        });
        expect(panes[2]).toMatchObject({
            type: 'diff',
            label: 'src',
            title: 'diff: src',
            workingDirectory: '/srv/app',
            filePath: '/srv/app/src'
        });
    });

    it('opens a diff pane as a bare leaf when nothing is focused (no layout fallback)', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: null });
        h.dispatch({
            type: 'open-diff-pane',
            workspaceID: W1,
            paneID: PA,
            repoPath: '/srv/app',
            now: NOW
        });
        expect(ws(h.state()).layout).toEqual({ kind: 'leaf', paneID: PA });
    });

    it('creates a scratchpad in edit mode', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: PA, now: NOW });
        h.dispatch({
            type: 'scratchpad-content-changed',
            workspaceID: W1,
            paneID: PA,
            content: 'notes'
        });
        expect(ws(h.state()).panes[1]).toMatchObject({
            type: 'scratchpad',
            title: 'Scratchpad',
            isEditing: true,
            scratchpadContent: 'notes'
        });
    });

    /**
     * LAY-016 — the scratchpad's split source, both branches of the Swift `if let sourceID`
     * (WorkspaceFeature.swift:1192-1210): the focused pane (un-zooming first), and with
     * nothing focused a BARE LEAF that replaces the whole layout.
     */
    it('LAY-016: a scratchpad splits the focused pane, un-zooming first', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'toggle-zoom', workspaceID: W1 }
        );
        expect(ws(h.state()).zoomedPaneID).toBe(PA);

        h.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: PB, now: NOW });
        const workspace = ws(h.state());
        // The zoom is dropped and the scratchpad splits the pane that was focused (PA).
        expect(workspace.zoomedPaneID).toBeNull();
        expect(workspace.savedLayout).toBeNull();
        expect(allPaneIDs(workspace.layout)).toEqual([P0, PA, PB]);
        expect(workspace.focusedPaneID).toBe(PB);
        expect(workspace.currentLayoutIndex).toBeNull();
    });

    it('LAY-016: a scratchpad is a bare leaf when nothing is focused', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'focus-pane', workspaceID: W1, paneID: null },
            { type: 'create-scratchpad', workspaceID: W1, paneID: PB, now: NOW }
        );
        const workspace = ws(h.state());
        // Swift replaces the layout outright: the other panes survive as records but leave the
        // tree (`state.layout = .leaf(newPaneID)`).
        expect(workspace.layout).toEqual({ kind: 'leaf', paneID: PB });
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P0, PA, PB]);
        expect(workspace.focusedPaneID).toBe(PB);
    });

    /**
     * LAY-015 — which pane a WEB pane splits off: `sourcePaneID ?? focusedPaneID`, else a bare
     * leaf (WorkspaceFeature.swift:855-876). The caller-supplied anchor is the header globe /
     * pane context menu; `direction` is its ⇧-click contract (right vs down).
     */
    it('LAY-015: a web pane splits the caller-named pane in the caller-named direction', () => {
        const h = harness(seededState());
        h.dispatch(
            // Focus moves to PA, so an anchored open has to ignore the focused pane.
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            {
                type: 'open-web-pane',
                workspaceID: W1,
                paneID: PB,
                tabID: PC,
                url: 'https://example.com',
                sourcePaneID: P0,
                direction: 'vertical',
                now: NOW
            }
        );
        const layout = ws(h.state()).layout;
        if (layout.kind !== 'split') throw new Error('expected a split');
        // P0's leaf became the vertical split; PA is untouched on the other side.
        expect(layout.first).toEqual({
            kind: 'split',
            direction: 'vertical',
            ratio: 0.5,
            first: { kind: 'leaf', paneID: P0 },
            second: { kind: 'leaf', paneID: PB }
        });
        expect(layout.second).toEqual({ kind: 'leaf', paneID: PA });
        expect(ws(h.state()).focusedPaneID).toBe(PB);
    });

    it('LAY-015: a web pane falls back to the focused pane, and to a bare leaf with none', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: PA,
            tabID: PB,
            url: 'https://example.com',
            now: NOW
        });
        // No anchor: the focused pane (P0) is split, horizontally by default.
        expect(ws(h.state()).layout).toEqual({
            kind: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { kind: 'leaf', paneID: P0 },
            second: { kind: 'leaf', paneID: PA }
        });

        h.dispatch(
            { type: 'focus-pane', workspaceID: W1, paneID: null },
            {
                type: 'open-web-pane',
                workspaceID: W1,
                paneID: PC,
                tabID: id('eeeeeeee', 4),
                url: 'https://example.org',
                now: NOW
            }
        );
        const workspace = ws(h.state());
        expect(workspace.layout).toEqual({ kind: 'leaf', paneID: PC });
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P0, PA, PC]);
        // The sidecar still arrives — the bare-leaf branch only changes the tree.
        expect(workspace.webPanes[PC]?.tabs[0]?.url).toBe('https://example.org');
    });

    it('seeds the web sidecar with a normalized URL and drops it on close', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: PA,
            tabID: PB,
            url: 'example.com/docs',
            now: NOW
        });
        expect(ws(h.state()).webPanes[PA]).toEqual({
            tabs: [{ id: PB, url: 'https://example.com/docs', title: '' }],
            activeTabID: PB,
            isPrivate: false
        });
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: PA });
        expect(ws(h.state()).webPanes[PA]).toBeUndefined();
        expect(ws(h.state()).recentlyClosedPanes.at(-1)?.webState).not.toBeNull();
    });

    /**
     * WEB-004 — the `reusePaneID` park-and-replace branch, for a WEB pane.
     *
     * This is the `--here` machinery markdown uses, carried by `openWebPane` for the same reason
     * the Swift reducer carries it: the branch is written, correct, and — in **both** apps — has
     * no caller (`docs/web-pane.md` §3.2 step 4 says so verbatim: "currently no caller
     * passes it"). What has to hold is that a web pane taking a terminal's slot PARKS it rather
     * than destroying it, arrives with its own sidecar, and hands the slot back on close. A
     * silent regression here would lose a live PTY, so it is pinned even though the branch is
     * only reachable by dispatching the action directly.
     */
    it('parks the source pane when a web pane takes its slot, and unparks it on close (WEB-004)', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: PA,
            tabID: PB,
            url: 'example.com',
            reusePaneID: P0,
            now: NOW
        });
        let workspace = ws(h.state());
        // The terminal is parked, not closed: out of `panes`, out of the layout, and with no
        // reopen snapshot taken (it never "closed").
        expect(workspace.parkedPanes.map((pane) => pane.id)).toEqual([P0]);
        expect(workspace.panes.map((pane) => pane.id)).toEqual([PA]);
        expect(workspace.layout).toEqual({ kind: 'leaf', paneID: PA });
        expect(workspace.panes[0]?.parkedSourcePaneID).toBe(P0);
        expect(workspace.panes[0]?.type).toBe('web');
        expect(workspace.recentlyClosedPanes).toHaveLength(0);
        // …and the web pane arrived with the same sidecar the split path builds.
        expect(workspace.webPanes[PA]).toEqual({
            tabs: [{ id: PB, url: 'https://example.com', title: '' }],
            activeTabID: PB,
            isPrivate: false
        });

        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: PA });
        workspace = ws(h.state());
        expect(workspace.parkedPanes).toHaveLength(0);
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P0]);
        expect(workspace.layout).toEqual({ kind: 'leaf', paneID: P0 });
        expect(workspace.focusedPaneID).toBe(P0);
        // QUIRK, and a deliberate one: the UNPARK branch returns before the sidecar drop, so
        // `webPanes[PA]` outlives the pane. Swift does exactly the same — its unpark branch
        // (WorkspaceFeature.swift:1235-1260) returns before the `state.webPanes.removeValue`
        // the normal close performs at :1299-1301 — and since neither app can reach this branch
        // from a caller, the port keeps the shared behaviour rather than inventing a divergence.
        expect(workspace.webPanes[PA]).toBeDefined();
    });

    it('WEB-004: a reuse anchor that is not a visible pane falls back to a split', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: PA,
            tabID: PB,
            url: 'example.com',
            reusePaneID: PC,
            now: NOW
        });
        const workspace = ws(h.state());
        expect(workspace.parkedPanes).toHaveLength(0);
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P0, PA]);
        expect(workspace.panes[1]?.parkedSourcePaneID).toBeNull();
    });

    it('QUIRK: a private web pane reopens without a sidecar', () => {
        const h = harness(seededState());
        h.dispatch(
            {
                type: 'open-web-pane',
                workspaceID: W1,
                paneID: PA,
                tabID: PB,
                url: 'https://example.com',
                isPrivate: true,
                now: NOW
            },
            { type: 'close-pane', workspaceID: W1, paneID: PA }
        );
        expect(ws(h.state()).recentlyClosedPanes.at(-1)?.webState).toBeNull();
        h.dispatch({ type: 'reopen-closed-pane', workspaceID: W1, paneID: PC, now: NOW });
        expect(ws(h.state()).panes.at(-1)?.type).toBe('web');
        expect(ws(h.state()).webPanes[PC]).toBeUndefined();
    });
});

describe('reopen-closed-pane', () => {
    it('restores the most recent snapshot without its session id', () => {
        const h = harness(seededState());
        h.dispatch(
            {
                type: 'split-pane',
                workspaceID: W1,
                paneID: PA,
                direction: 'horizontal',
                now: NOW,
                label: 'agent'
            },
            {
                type: 'pane-agent-event',
                paneID: PA,
                event: { type: 'sessionStarted', sessionID: 'abc-123', agent: 'codex' },
                now: NOW
            },
            { type: 'close-pane', workspaceID: W1, paneID: PA },
            { type: 'reopen-closed-pane', workspaceID: W1, paneID: PB, now: NOW }
        );
        const restored = ws(h.state()).panes.at(-1);
        expect(restored).toMatchObject({
            id: PB,
            label: 'agent',
            agentSessionID: null,
            agentKind: 'codex',
            status: 'idle'
        });
        expect(ws(h.state()).recentlyClosedPanes).toHaveLength(0);
    });

    it('QUIRK: consumes (and loses) the snapshot when nothing is focused', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'close-pane', workspaceID: W1, paneID: PA },
            { type: 'focus-pane', workspaceID: W1, paneID: null },
            { type: 'reopen-closed-pane', workspaceID: W1, paneID: PB, now: NOW }
        );
        expect(ws(h.state()).recentlyClosedPanes).toHaveLength(0);
        expect(ws(h.state()).panes.map((pane) => pane.id)).toEqual([P0]);
    });
});

describe('pane-process-terminated', () => {
    it('drops a dead parked pane and clears the pointer on its replacement', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PA,
            filePath: '/docs/a.md',
            reusePaneID: P0,
            now: NOW
        });
        h.dispatch({ type: 'pane-process-terminated', paneID: P0 });
        const workspace = ws(h.state());
        expect(workspace.parkedPanes).toHaveLength(0);
        expect(workspace.panes[0]?.parkedSourcePaneID).toBeNull();
    });

    it('returns a markdown pane to preview when its external editor exits', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PA,
            filePath: '/docs/a.md',
            now: NOW
        });
        // Simulate the $EDITOR surface being attached (M5 owns the spawn itself).
        const state = h.state();
        const patched: DaemonState = {
            ...state,
            workspaces: state.workspaces.map((workspace) => ({
                ...workspace,
                panes: workspace.panes.map((pane) =>
                    pane.id === PA
                        ? { ...pane, isEditing: true, externalEditorCommand: 'vim /docs/a.md' }
                        : pane
                )
            }))
        };
        const h2 = harness(patched);
        h2.dispatch({ type: 'pane-process-terminated', paneID: PA });
        const pane = ws(h2.state()).panes.find((candidate) => candidate.id === PA);
        expect(pane).toMatchObject({ isEditing: false, externalEditorCommand: null });
    });

    it('closes the pane when a shell exits', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'pane-process-terminated', paneID: PA }
        );
        expect(ws(h.state()).panes.map((pane) => pane.id)).toEqual([P0]);
    });
});

describe('moving and resizing', () => {
    it('re-parents a pane onto an edge of another', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'split-pane', workspaceID: W1, paneID: PB, direction: 'horizontal', now: NOW },
            {
                type: 'move-pane-adjacent',
                workspaceID: W1,
                paneID: PB,
                targetPaneID: P0,
                zone: 'top'
            }
        );
        const workspace = ws(h.state());
        expect(workspace.layout).toMatchObject({
            kind: 'split',
            direction: 'horizontal',
            first: {
                kind: 'split',
                direction: 'vertical',
                first: { kind: 'leaf', paneID: PB },
                second: { kind: 'leaf', paneID: P0 }
            },
            second: { kind: 'leaf', paneID: PA }
        });
        expect(workspace.focusedPaneID).toBe(PB);
    });

    it('QUIRK: moving a pane onto itself still refocuses and clears the layout index', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'cycle-layout', workspaceID: W1 },
            { type: 'focus-pane', workspaceID: W1, paneID: PA }
        );
        const before = ws(h.state()).layout;
        h.dispatch({
            type: 'move-pane-adjacent',
            workspaceID: W1,
            paneID: P0,
            targetPaneID: P0,
            zone: 'left'
        });
        const workspace = ws(h.state());
        expect(workspace.layout).toEqual(before);
        expect(workspace.focusedPaneID).toBe(P0);
        expect(workspace.currentLayoutIndex).toBeNull();
    });

    it('swaps with the geometric neighbour, and no-ops while zoomed', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: PA,
            direction: 'horizontal',
            now: NOW
        });
        h.dispatch({ type: 'move-pane-direction', workspaceID: W1, direction: 'left' });
        expect(allPaneIDs(ws(h.state()).layout)).toEqual([PA, P0]);

        h.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
        const zoomed = h.state();
        h.dispatch({ type: 'move-pane-direction', workspaceID: W1, direction: 'right' });
        expect(h.state()).toBe(zoomed);
    });

    it('resizes a pane against its sibling and clamps the share', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: PA,
            direction: 'horizontal',
            now: NOW
        });
        h.dispatch({ type: 'resize-pane', workspaceID: W1, paneID: P0, share: 0.75 });
        expect(ratioAtPath(ws(h.state()).layout, 'd')).toBeCloseTo(0.75);

        h.dispatch({ type: 'resize-pane', workspaceID: W1, paneID: PA, share: 0.99 });
        // PA is the second child: its 0.9 clamp stores 0.1 for the first child.
        expect(ratioAtPath(ws(h.state()).layout, 'd')).toBeCloseTo(0.1);
        expect(ws(h.state()).currentLayoutIndex).toBeNull();
    });

    it('update-split-ratio clamps and resets the layout index', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'cycle-layout', workspaceID: W1 },
            { type: 'update-split-ratio', workspaceID: W1, splitPath: 'd', ratio: 0.02 }
        );
        expect(ratioAtPath(ws(h.state()).layout, 'd')).toBeCloseTo(0.1);
        expect(ws(h.state()).currentLayoutIndex).toBeNull();
    });
});

describe('move-pane-to-workspace', () => {
    it('detaches from the source, splits into the target and switches the active workspace', () => {
        const base = seededState();
        const h = harness(base);
        h.dispatch({
            type: 'create-workspace',
            id: W2,
            paneID: id('dddddddd', 200),
            name: 'other',
            color: 'red',
            now: NOW
        });
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'set-sync-input-active', workspaceID: W1, active: true },
            { type: 'set-sync-input-excluded', workspaceID: W1, paneID: PA, excluded: true },
            { type: 'move-pane-to-workspace', paneID: PA, toWorkspaceID: W2 }
        );
        const source = ws(h.state(), W1);
        const target = ws(h.state(), W2);
        expect(source.panes.map((pane) => pane.id)).toEqual([P0]);
        expect(source.syncInputExcluded).toEqual([]);
        expect(source.focusedPaneID).toBe(P0);
        expect(target.panes.map((pane) => pane.id)).toEqual([id('dddddddd', 200), PA]);
        expect(allPaneIDs(target.layout)).toEqual([id('dddddddd', 200), PA]);
        expect(target.focusedPaneID).toBe(PA);
        expect(h.state().lastActiveWorkspaceID).toBe(W2);
    });

    /**
     * LAY-083 — moving the ZOOMED pane out un-zooms the source and restores `savedLayout`
     * MINUS the pane that left (AppReducer+Socket.swift:357-363). The un-zoom runs after the
     * close-like refocus, so the layout the user is handed back is the saved one, not the
     * emptied zoom layout.
     */
    it('LAY-083: un-zooms the source when the zoomed pane moves to another workspace', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'create-workspace',
            id: W2,
            paneID: id('dddddddd', 202),
            name: 'other',
            color: 'red',
            now: NOW
        });
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'toggle-zoom', workspaceID: W1 }
        );
        expect(ws(h.state(), W1).zoomedPaneID).toBe(PA);
        expect(ws(h.state(), W1).savedLayout).not.toBeNull();

        h.dispatch({ type: 'move-pane-to-workspace', paneID: PA, toWorkspaceID: W2 });
        const source = ws(h.state(), W1);
        expect(source.zoomedPaneID).toBeNull();
        expect(source.savedLayout).toBeNull();
        // Not `empty` (which is what removing PA from the zoom layout leaves): the saved
        // two-leaf tree comes back with PA taken out of it.
        expect(source.layout).toEqual({ kind: 'leaf', paneID: P0 });
        expect(source.focusedPaneID).toBe(P0);
        expect(allPaneIDs(ws(h.state(), W2).layout)).toEqual([id('dddddddd', 202), PA]);
    });

    it('LAY-083: moving a pane that is NOT the zoomed one leaves the zoom alone', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'create-workspace',
            id: W2,
            paneID: id('dddddddd', 203),
            name: 'other',
            color: 'red',
            now: NOW
        });
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'toggle-zoom', workspaceID: W1 },
            // P0 is off-screen under the zoom; moving it must not disturb the zoom state.
            { type: 'move-pane-to-workspace', paneID: P0, toWorkspaceID: W2 }
        );
        const source = ws(h.state(), W1);
        expect(source.zoomedPaneID).toBe(PA);
        expect(source.layout).toEqual({ kind: 'leaf', paneID: PA });
        // The saved layout still holds both leaves; only the visible tree lost P0.
        expect(allPaneIDs(source.savedLayout ?? { kind: 'empty' })).toEqual([P0, PA]);
    });

    it('carries the web sidecar across', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'create-workspace',
            id: W2,
            paneID: id('dddddddd', 201),
            name: 'other',
            color: 'red',
            now: NOW
        });
        h.dispatch(
            {
                type: 'open-web-pane',
                workspaceID: W1,
                paneID: PA,
                tabID: PB,
                url: 'https://example.com',
                now: NOW
            },
            { type: 'move-pane-to-workspace', paneID: PA, toWorkspaceID: W2 }
        );
        expect(ws(h.state(), W1).webPanes[PA]).toBeUndefined();
        expect(ws(h.state(), W2).webPanes[PA]?.tabs[0]?.url).toBe('https://example.com');
    });
});

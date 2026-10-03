/**
 * #324: the csv document pane's store surface: `open-markdown-pane` with `paneType: 'csv'`,
 * the persisted `csvHeaderRow` flag (`set-csv-header-row`, close + reopen, snapshot), and the
 * raw-text mode that reuses `set-markdown-editing`.
 */

import { allPaneIDs } from '@kelpi/core/layout';
import { describe, expect, it } from 'vitest';

import { workspaceByID } from './derived.js';
import { fromSnapshot, toSnapshot } from './snapshot.js';
import { harness, id, NOW, seededState, W1 } from './testing.js';
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

function openCsv(paneID = PA, extra: { reusePaneID?: string; focus?: boolean } = {}) {
    return {
        type: 'open-markdown-pane' as const,
        workspaceID: W1,
        paneID,
        filePath: '/data/sales.csv',
        now: NOW,
        paneType: 'csv' as const,
        ...extra
    };
}

describe('open-markdown-pane with paneType csv', () => {
    it('opens a csv pane named after the file, split beside the focused pane', () => {
        const h = harness(seededState());
        h.dispatch(openCsv());
        const workspace = ws(h.state());
        expect(allPaneIDs(workspace.layout)).toEqual([P0, PA]);
        expect(workspace.panes[1]).toMatchObject({
            id: PA,
            type: 'csv',
            label: 'sales.csv',
            title: 'sales.csv',
            workingDirectory: '/data',
            filePath: '/data/sales.csv',
            isEditing: false,
            csvHeaderRow: true
        });
        expect(workspace.focusedPaneID).toBe(PA);
    });

    it('still opens a markdown pane without paneType', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: PA, filePath: '/data/sales.csv', now: NOW });
        expect(ws(h.state()).panes[1]?.type).toBe('markdown');
    });

    it('--here parks the source pane and takes its slot', () => {
        const h = harness(seededState());
        h.dispatch(openCsv(PA, { reusePaneID: P0 }));
        const workspace = ws(h.state());
        expect(allPaneIDs(workspace.layout)).toEqual([PA]);
        expect(workspace.panes.map((pane) => [pane.id, pane.type])).toEqual([[PA, 'csv']]);
        expect(workspace.panes[0]?.parkedSourcePaneID).toBe(P0);
        expect(workspace.parkedPanes.map((pane) => pane.id)).toEqual([P0]);
    });

    it('opens in the background without taking focus', () => {
        const h = harness(seededState());
        h.dispatch(openCsv(PA, { focus: false }));
        expect(ws(h.state()).focusedPaneID).toBe(P0);
        expect(ws(h.state()).panes[1]?.type).toBe('csv');
    });
});

describe('set-csv-header-row', () => {
    it('turns the header row off and on, emitting a pane-upserted event', () => {
        const h = harness(seededState());
        h.dispatch(openCsv());
        h.events.length = 0;
        h.dispatch({ type: 'set-csv-header-row', workspaceID: W1, paneID: PA, on: false });
        expect(ws(h.state()).panes[1]?.csvHeaderRow).toBe(false);
        expect(h.events).toContainEqual(
            expect.objectContaining({ kind: 'pane-upserted', paneID: PA, lane: 'visible' })
        );
        h.dispatch({ type: 'set-csv-header-row', workspaceID: W1, paneID: PA, on: true });
        expect(ws(h.state()).panes[1]?.csvHeaderRow).toBe(true);
    });

    it('is a no-op (same state) when unchanged, for a non-csv pane, or an unknown pane', () => {
        const h = harness(seededState());
        h.dispatch(openCsv());
        const before = h.state();
        h.dispatch({ type: 'set-csv-header-row', workspaceID: W1, paneID: PA, on: true });
        h.dispatch({ type: 'set-csv-header-row', workspaceID: W1, paneID: P0, on: false });
        h.dispatch({ type: 'set-csv-header-row', workspaceID: W1, paneID: PC, on: false });
        expect(h.state()).toBe(before);
        expect(ws(h.state()).panes[0]?.csvHeaderRow).toBe(true);
    });

    it('updates a parked csv pane', () => {
        const h = harness(seededState());
        // The csv pane takes P0's slot, then a markdown --here parks the csv pane in turn.
        h.dispatch(openCsv(PA, { reusePaneID: P0 }), {
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PB,
            filePath: '/docs/a.md',
            reusePaneID: PA,
            now: NOW
        });
        expect(ws(h.state()).parkedPanes.map((pane) => pane.id)).toContain(PA);
        h.dispatch({ type: 'set-csv-header-row', workspaceID: W1, paneID: PA, on: false });
        const parked = ws(h.state()).parkedPanes.find((pane) => pane.id === PA);
        expect(parked?.csvHeaderRow).toBe(false);
        expect(h.events).toContainEqual(
            expect.objectContaining({ kind: 'pane-upserted', paneID: PA, lane: 'parked' })
        );
    });
});

describe('set-markdown-editing on a csv pane (raw-text mode)', () => {
    it('enters and leaves raw-text mode', () => {
        const h = harness(seededState());
        h.dispatch(openCsv());
        h.dispatch({ type: 'set-markdown-editing', workspaceID: W1, paneID: PA, editing: true });
        expect(ws(h.state()).panes[1]?.isEditing).toBe(true);
        h.dispatch({ type: 'set-markdown-editing', workspaceID: W1, paneID: PA, editing: false });
        expect(ws(h.state()).panes[1]?.isEditing).toBe(false);
    });

    it('still refuses a shell pane', () => {
        const h = harness(seededState());
        const before = h.state();
        h.dispatch({ type: 'set-markdown-editing', workspaceID: W1, paneID: P0, editing: true });
        expect(h.state()).toBe(before);
    });

    it('does not let a csv pane change the markdown font size', () => {
        const h = harness(seededState());
        h.dispatch(openCsv());
        const before = h.state();
        h.dispatch({ type: 'set-markdown-font-size', workspaceID: W1, paneID: PA, size: 20 });
        expect(h.state()).toBe(before);
    });
});

describe('close + reopen keeps the header flag', () => {
    it('restores csvHeaderRow from the closed-pane snapshot', () => {
        const h = harness(seededState());
        h.dispatch(
            openCsv(),
            { type: 'set-csv-header-row', workspaceID: W1, paneID: PA, on: false },
            { type: 'close-pane', workspaceID: W1, paneID: PA }
        );
        expect(ws(h.state()).recentlyClosedPanes.at(-1)).toMatchObject({ type: 'csv', csvHeaderRow: false });
        h.dispatch({ type: 'reopen-closed-pane', workspaceID: W1, paneID: PB, now: NOW });
        expect(ws(h.state()).panes.at(-1)).toMatchObject({
            id: PB,
            type: 'csv',
            filePath: '/data/sales.csv',
            csvHeaderRow: false,
            isEditing: false
        });
    });
});

describe('snapshot persist / restore', () => {
    it('round-trips csvHeaderRow, and an older record without it restores headers on', () => {
        const h = harness(seededState());
        h.dispatch(openCsv(), { type: 'set-csv-header-row', workspaceID: W1, paneID: PA, on: false });
        const snapshot = toSnapshot(h.state());
        const persisted = snapshot.workspaces[0]?.panes.find((pane) => pane.id === PA);
        expect(persisted).toMatchObject({ type: 'csv', csvHeaderRow: false });

        const restored = fromSnapshot(snapshot, { homeDirectory: h.state().homeDirectory });
        const pane = ws(restored).panes.find((candidate) => candidate.id === PA);
        expect(pane).toMatchObject({ type: 'csv', csvHeaderRow: false, isEditing: false });

        const legacy = {
            ...snapshot,
            workspaces: snapshot.workspaces.map((workspace) => ({
                ...workspace,
                panes: workspace.panes.map((record) => {
                    const { csvHeaderRow: _dropped, ...rest } = record;
                    return rest;
                })
            }))
        };
        const fromLegacy = fromSnapshot(legacy, { homeDirectory: h.state().homeDirectory });
        expect(ws(fromLegacy).panes.find((candidate) => candidate.id === PA)?.csvHeaderRow).toBe(true);
    });
});

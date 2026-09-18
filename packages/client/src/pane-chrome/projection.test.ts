import { describe, expect, it } from 'vitest';

import { testPane } from '../grid/testing';

import { PANE_CHROME_LIMITS } from './contract';
import { paneChromeModel } from './model';
import { PANE_CHROME_FRAME_BUDGET, paneChromeBytes, projectPaneChrome } from './projection';

const NOW = 1_000_000;

/**
 * One pane as large as a pane can honestly get.
 *
 * A title is whatever the shell last wrote to its terminal's OSC and a working directory is
 * whatever the user cd'd into, so neither has a character limit the host imposes. These are long
 * enough to make the bound bite in a workspace of a plausible size, which is the only way to test
 * a budget at all.
 */
function maximalPane(index: number) {
    const segment = `directory-segment-${String(index).padStart(4, '0')}`;
    const directory = `/Users/ben/${Array.from({ length: 24 }, () => segment).join('/')}`;
    return paneChromeModel({
        pane: testPane(`pane-${String(index).padStart(4, '0')}`, {
            label: `label-${'x'.repeat(200)}`,
            title: `${'title-'.repeat(200)}${directory}`,
            workingDirectory: directory,
            gitBranch: `feature/${'branch-'.repeat(60)}`,
            status: 'running',
            agentSessionID: `session-${index}`,
            agentKind: 'claude',
            agentStartedAt: (NOW - 3600) * 1000,
            backgroundTaskCount: 7
        }),
        focused: index === 0,
        zoomAvailable: true,
        syncActive: true,
        homeDirectory: '/Users/ben',
        nowSeconds: NOW,
        paneWidth: 1200,
        commands: Array.from({ length: 6 }, (_, n) => ({
            id: `example.plugin.command-${n}-${'y'.repeat(80)}`,
            title: `Command ${n} ${'z'.repeat(120)}`,
            run: () => {}
        })),
        items: Array.from({ length: 6 }, (_, n) => ({
            id: `example.plugin.item-${n}-${'y'.repeat(80)}`,
            text: `Item ${n} ${'z'.repeat(120)}`,
            tooltip: 'w'.repeat(200),
            badge: '999',
            tone: 'warning' as const,
            enabled: true
        })),
        contributions: true
    }).descriptor;
}

describe('projectPaneChrome', () => {
    it('carries the workspace envelope once and every visible pane under it', () => {
        const panes = [0, 1, 2].map((index) =>
            paneChromeModel({
                pane: testPane(`p${index}`, { workingDirectory: '/Users/ben/code/kelpi' }),
                focused: index === 1,
                homeDirectory: '/Users/ben',
                nowSeconds: NOW,
                paneWidth: 900
            }).descriptor
        );
        const frame = projectPaneChrome({
            workspaceID: 'ws-1',
            formFactor: 'desktop',
            focusedPaneID: 'p1',
            zoomedPaneID: null,
            panes
        });
        expect(frame.placement).toBe('pane.chrome');
        expect(frame.formFactor).toBe('desktop');
        expect(frame.workspaceID).toBe('ws-1');
        expect(frame.focusedPaneID).toBe('p1');
        expect(frame.zoomedPaneID).toBeNull();
        expect(frame.panes.map((pane) => pane.paneID)).toEqual(['p0', 'p1', 'p2']);
        expect(frame.withheld).toBe(0);
        expect(frame.panes[0]?.title).toBe('~/code/kelpi');
        expect(frame.panes[0]?.directory).toBe('~/code/kelpi');
    });

    /**
     * The audit selectors stay host-side.
     *
     * `settings/contract.ts` withholds a row's `testID` for the same reason: it is the bundled
     * panel's handle on its own DOM, and a projection that carried it would be publishing the
     * host's test surface as API.
     */
    it('withholds every test id, and the contributions box becomes a count', () => {
        const descriptor = paneChromeModel({
            pane: testPane('p1'),
            focused: false,
            nowSeconds: NOW,
            paneWidth: 900,
            items: [
                { id: 'i1', text: 'Ready', tooltip: null, badge: null, tone: 'default', enabled: true }
            ],
            contributions: true
        }).descriptor;
        const frame = projectPaneChrome({
            workspaceID: 'ws-1',
            formFactor: 'desktop',
            panes: [descriptor]
        });
        expect(JSON.stringify(frame)).not.toContain('testID');
        expect(JSON.stringify(frame)).not.toContain('pane-close-p1');
        expect(frame.panes[0]?.contributions).toBe(1);
        // The items themselves still cross, as descriptors: decision 7's whole point.
        expect(frame.panes[0]?.items).toEqual(descriptor.items);
        // And so does every control, minus its test id.
        expect(frame.panes[0]?.controls.map((control) => control.key)).toEqual(
            descriptor.controls.map((control) => control.key)
        );
    });

    it('stays inside 256 KiB with a workspace of maximal panes, and counts what it dropped', () => {
        const panes = Array.from({ length: 200 }, (_, index) => maximalPane(index));
        const frame = projectPaneChrome({
            workspaceID: 'ws-huge',
            formFactor: 'desktop',
            focusedPaneID: panes[0]?.paneID ?? null,
            panes
        });
        const bytes = paneChromeBytes(frame);
        expect(bytes).toBeLessThanOrEqual(PANE_CHROME_LIMITS.payloadBytes);
        expect(bytes).toBeLessThanOrEqual(PANE_CHROME_FRAME_BUDGET);
        // It really did have to drop some: a bound nothing reaches proves nothing.
        expect(frame.withheld).toBeGreaterThan(0);
        expect(frame.panes.length).toBeGreaterThan(0);
        expect(frame.panes.length + frame.withheld).toBe(200);
        // In the workspace's own order, so the panes a presenter loses are at the end of a row
        // nobody can see all of anyway.
        expect(frame.panes.map((pane) => pane.paneID)).toEqual(
            panes.slice(0, frame.panes.length).map((pane) => pane.paneID)
        );
    });

    it('still reports its workspace when not one pane fits', () => {
        // One pane far past the whole budget on its own.
        const huge = paneChromeModel({
            pane: testPane('p1', { title: 'x'.repeat(PANE_CHROME_LIMITS.payloadBytes) }),
            focused: false,
            nowSeconds: NOW
        }).descriptor;
        const frame = projectPaneChrome({
            workspaceID: 'ws-1',
            formFactor: 'desktop',
            panes: [huge]
        });
        expect(frame.panes).toEqual([]);
        expect(frame.withheld).toBe(1);
        expect(frame.workspaceID).toBe('ws-1');
        expect(paneChromeBytes(frame)).toBeLessThanOrEqual(PANE_CHROME_FRAME_BUDGET);
    });

    it('states the form factor, because a phone keeps its own header (decision 8)', () => {
        const frame = projectPaneChrome({ workspaceID: 'ws-1', formFactor: 'phone', panes: [] });
        expect(frame.formFactor).toBe('phone');
        expect(frame.panes).toEqual([]);
        expect(frame.withheld).toBe(0);
    });
});

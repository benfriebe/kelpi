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
        const { frame } = projectPaneChrome({
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
        }).descriptor;
        const { frame } = projectPaneChrome({
            workspaceID: 'ws-1',
            formFactor: 'desktop',
            panes: [descriptor]
        });
        expect(JSON.stringify(frame)).not.toContain('testID');
        expect(JSON.stringify(frame)).not.toContain('pane-close-p1');
        expect(frame.panes[0]?.contributions).toBe(1);
        // Every control crosses, in row order, minus its test id and minus its key.
        expect(frame.panes[0]?.controls.map((control) => control.label)).toEqual(
            descriptor.controls.map((control) => control.label)
        );
        expect(frame.panes[0]?.items.map((item) => item.text)).toEqual(descriptor.items.map((item) => item.text));
    });

    /**
     * The owner's namespace is the thing a frame must not carry, and a contribution id is the
     * owner's namespace spelled out. A recursive scan rather than a `JSON.stringify().includes`,
     * so a leak cannot hide inside a nested object under a harmless-looking key.
     */
    it('carries no contribution id and no command name: every ref is opaque', () => {
        const descriptor = paneChromeModel({
            pane: testPane('p1'),
            focused: false,
            nowSeconds: NOW,
            paneWidth: 900,
            commands: [
                { id: 'example.board.inspect', title: 'Inspect with Board', run: () => {} },
                { id: 'example.board.pin', title: 'Pin', enabled: false, run: () => {} }
            ],
            items: [
                { id: 'example.board.status', text: 'Ready', tooltip: null, badge: '3', tone: 'success', enabled: true }
            ]
        }).descriptor;
        const { frame, refs } = projectPaneChrome({
            workspaceID: 'ws-1',
            formFactor: 'desktop',
            panes: [descriptor]
        });

        const strings: string[] = [];
        const walk = (value: unknown): void => {
            if (typeof value === 'string') { strings.push(value); return; }
            if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
            if (value !== null && typeof value === 'object') for (const [key, nested] of Object.entries(value)) { strings.push(key); walk(nested); }
        };
        walk(frame);
        expect(strings.filter((value) => value.includes('example.board'))).toEqual([]);
        expect(strings).not.toContain('key');
        expect(strings).not.toContain('pluginID');
        expect(strings).not.toContain('command');
        // The host's own controls are addressed by ref too: one rule, not a special case. (Their
        // keys are not searched for as STRINGS, because an icon name may legitimately equal one:
        // `split-right` is both a key and a drawing, and only the field says which.)
        expect(frame.panes[0]?.controls.every((control) => /^c\d+$/.test(control.ref))).toBe(true);
        expect(frame.panes[0]?.items.every((item) => /^i\d+$/.test(item.ref))).toBe(true);

        // The private table is the only way back, and it answers with the host-side identity.
        const inspect = frame.panes[0]?.controls[0];
        expect(inspect?.label).toBe('Inspect with Board');
        expect(refs.resolve('p1', inspect?.ref ?? '')).toEqual({ paneID: 'p1', what: 'control', id: 'example.board.inspect' });
        const chip = frame.panes[0]?.items[0];
        expect(refs.resolve('p1', chip?.ref ?? '')).toEqual({ paneID: 'p1', what: 'item', id: 'example.board.status' });
        // A ref from another pane, a forged one, and an item ref used as a control ref all miss.
        expect(refs.resolve('p2', inspect?.ref ?? '')).toBeUndefined();
        expect(refs.resolve('p1', 'c999')).toBeUndefined();
        expect(refs.resolve('p1', 'nonsense')).toBeUndefined();
        expect(refs.size).toBe(descriptor.controls.length + descriptor.items.length);
    });

    it('mints no refs for a pane the budget withheld', () => {
        const small = paneChromeModel({ pane: testPane('small'), focused: false, nowSeconds: NOW }).descriptor;
        const huge = paneChromeModel({
            pane: testPane('huge', { title: 'x'.repeat(PANE_CHROME_LIMITS.payloadBytes) }),
            focused: false,
            nowSeconds: NOW
        }).descriptor;
        const { frame, refs } = projectPaneChrome({
            workspaceID: 'ws-1',
            formFactor: 'desktop',
            panes: [small, huge]
        });
        expect(frame.panes.map((pane) => pane.paneID)).toEqual(['small']);
        expect(refs.resolve('huge', 'c0')).toBeUndefined();
        expect(refs.size).toBe(small.controls.length);
    });

    it('stays inside 256 KiB with a workspace of maximal panes, and counts what it dropped', () => {
        const panes = Array.from({ length: 200 }, (_, index) => maximalPane(index));
        const { frame } = projectPaneChrome({
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

    /**
     * The cut is a PREFIX, and the test is the one that would have passed with `continue`.
     *
     * A wide pane followed by a narrow one is the ordinary shape of a grid, and skipping the wide
     * one to carry the narrow one gave a presenter an arbitrary subset while the frame said "the
     * panes that fit, in order, and a count of the rest". There is no header row to draw from
     * that.
     */
    it('stops at the first pane that does not fit, rather than carrying smaller ones after it', () => {
        const narrow = (id: string) => paneChromeModel({ pane: testPane(id), focused: false, nowSeconds: NOW }).descriptor;
        const wide = paneChromeModel({
            pane: testPane('wide', { title: 'x'.repeat(PANE_CHROME_FRAME_BUDGET) }),
            focused: false,
            nowSeconds: NOW
        }).descriptor;
        const { frame } = projectPaneChrome({
            workspaceID: 'ws-1',
            formFactor: 'desktop',
            panes: [narrow('a'), wide, narrow('b'), narrow('c')]
        });
        expect(frame.panes.map((pane) => pane.paneID)).toEqual(['a']);
        // Three withheld, not one: everything from the pane that did not fit onwards.
        expect(frame.withheld).toBe(3);
        expect(frame.panes.length + frame.withheld).toBe(4);
    });

    it('still reports its workspace when not one pane fits', () => {
        // One pane far past the whole budget on its own.
        const huge = paneChromeModel({
            pane: testPane('p1', { title: 'x'.repeat(PANE_CHROME_LIMITS.payloadBytes) }),
            focused: false,
            nowSeconds: NOW
        }).descriptor;
        const { frame } = projectPaneChrome({
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
        const { frame } = projectPaneChrome({ workspaceID: 'ws-1', formFactor: 'phone', panes: [] });
        expect(frame.formFactor).toBe('phone');
        expect(frame.panes).toEqual([]);
        expect(frame.withheld).toBe(0);
    });
});

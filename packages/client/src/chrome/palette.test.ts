import { createStore as createDaemonStore, emptyDaemonState, type DaemonState } from '@kelpi/daemon/store';
import { describe, expect, it } from 'vitest';

import {
    buildPaletteItems,
    clampSelection,
    matchPaletteQuery,
    paletteNavigationOrder,
    parsePaletteQuery,
    type PaletteItem
} from './index';

const HOME = '/Users/test';
const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const P2 = 'dddddddd-0000-4000-8000-000000000002';
const P3 = 'dddddddd-0000-4000-8000-000000000003';
const NOW = 1_755_500_000_000;

function daemonState(): DaemonState {
    const store = createDaemonStore(emptyDaemonState(HOME));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: P1,
        name: 'kelpi-client',
        color: 'blue',
        workingDirectory: `${HOME}/code/kelpi`,
        now: NOW
    });
    store.dispatch({ type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'vertical', now: NOW + 1 });
    store.dispatch({ type: 'set-pane-label', workspaceID: W1, paneID: P2, label: 'worker' });
    store.dispatch({ type: 'pane-title-changed', paneID: P2, title: 'vim src/app.ts', now: NOW + 2 });
    store.dispatch({
        type: 'create-workspace',
        id: W2,
        paneID: P3,
        name: 'daemon',
        color: 'red',
        workingDirectory: `${HOME}/code/kelpid`,
        now: NOW + 3
    });
    return store.getState();
}

function items(): PaletteItem[] {
    return buildPaletteItems(daemonState().workspaces, { homeDirectory: HOME });
}

describe('item universe (§10.1)', () => {
    it('emits a workspace item then its panes in layout order', () => {
        expect(items().map((item) => item.id)).toEqual([
            `ws:${W1}`,
            `pane:${P1}`,
            `pane:${P2}`,
            `ws:${W2}`,
            `pane:${P3}`
        ]);
    });

    it('pluralizes the workspace subtitle and carries the workspace color', () => {
        const [first, , , second] = items();
        expect(first?.subtitle).toBe('2 panes');
        expect(first?.workspaceColor).toBe('blue');
        expect(second?.subtitle).toBe('1 pane');
    });

    it('titles a pane label ?? title ?? home-abbreviated cwd', () => {
        const byID = new Map(items().map((item) => [item.id, item]));
        // no label, no title → the cwd, home-abbreviated
        expect(byID.get(`pane:${P1}`)?.title).toBe('~/code/kelpi');
        expect(byID.get(`pane:${P1}`)?.subtitle).toBe('');
        // label + a distinct title → title as the subtitle
        expect(byID.get(`pane:${P2}`)?.title).toBe('worker');
        expect(byID.get(`pane:${P2}`)?.subtitle).toBe('vim src/app.ts');
    });

    it('uses the per-type icon token', () => {
        expect(items().find((item) => item.kind === 'pane')?.icon).toBe('terminal');
        expect(items().find((item) => item.kind === 'workspace')?.icon).toBe('rectangle.stack');
    });

    it('appends client commands after the state-derived items', () => {
        const withCommands = buildPaletteItems(daemonState().workspaces, {
            homeDirectory: HOME,
            commands: [
                {
                    id: 'cmd:split',
                    kind: 'command',
                    icon: 'plusminus',
                    title: 'Split Right',
                    subtitle: '⌘D',
                    workspaceID: null,
                    workspaceName: '',
                    paneID: null,
                    workspaceColor: null
                }
            ]
        });
        expect(withCommands.at(-1)?.id).toBe('cmd:split');
    });
});

describe('query parsing', () => {
    it('lowercases, drops leading whitespace and consumes the scope prefix', () => {
        expect(parsePaletteQuery('   KELPI Client')).toEqual({ scope: 'all', terms: ['kelpi', 'client'] });
        expect(parsePaletteQuery('w:dae')).toEqual({ scope: 'workspace', terms: ['dae'] });
        expect(parsePaletteQuery('p: vim  src')).toEqual({ scope: 'pane', terms: ['vim', 'src'] });
        expect(parsePaletteQuery('w:')).toEqual({ scope: 'workspace', terms: [] });
        // A prefix mid-query is NOT a scope — only a leading one is.
        expect(parsePaletteQuery('foo w:bar')).toEqual({ scope: 'all', terms: ['foo', 'w:bar'] });
    });
});

describe('matching (substring AND-of-terms — never fuzzy)', () => {
    const universe = items();
    const ids = (query: string): string[] => matchPaletteQuery(universe, query).map((item) => item.id);

    it('an empty query returns everything', () => {
        expect(ids('')).toHaveLength(universe.length);
        expect(ids('   ')).toHaveLength(universe.length);
    });

    it('matches substrings of title + subtitle + workspaceName', () => {
        expect(ids('worker')).toEqual([`pane:${P2}`]);
        // "client" only appears in the workspace NAME, and the pane items carry it too.
        expect(ids('client')).toEqual([`ws:${W1}`, `pane:${P1}`, `pane:${P2}`]);
        expect(ids('vim')).toEqual([`pane:${P2}`]);
    });

    it('requires EVERY term (AND, in any order)', () => {
        expect(ids('worker vim')).toEqual([`pane:${P2}`]);
        expect(ids('vim worker')).toEqual([`pane:${P2}`]);
        expect(ids('worker daemon')).toEqual([]);
    });

    it('is not fuzzy: non-contiguous letters do not match', () => {
        expect(ids('wrkr')).toEqual([]);
        expect(ids('nxc')).toEqual([]);
        expect(ids('kelpi-c')).toEqual([`ws:${W1}`, `pane:${P1}`, `pane:${P2}`]);
    });

    it('is case-insensitive', () => {
        expect(ids('WORKER')).toEqual([`pane:${P2}`]);
        expect(ids('Daemon')).toEqual([`ws:${W2}`, `pane:${P3}`]);
    });

    it('`w:` restricts to workspaces, `p:` to panes', () => {
        expect(ids('w:')).toEqual([`ws:${W1}`, `ws:${W2}`]);
        expect(ids('w:client')).toEqual([`ws:${W1}`]);
        expect(ids('p:')).toEqual([`pane:${P1}`, `pane:${P2}`, `pane:${P3}`]);
        expect(ids('p:client')).toEqual([`pane:${P1}`, `pane:${P2}`]);
        expect(ids('p:nope')).toEqual([]);
    });

    it('a scope prefix excludes command items', () => {
        const command: PaletteItem = {
            id: 'cmd:x',
            kind: 'command',
            icon: 'bolt',
            title: 'Split Right',
            subtitle: '',
            workspaceID: null,
            workspaceName: '',
            paneID: null,
            workspaceColor: null
        };
        const all = [...universe, command];
        expect(matchPaletteQuery(all, 'split').map((item) => item.id)).toEqual(['cmd:x']);
        expect(matchPaletteQuery(all, 'w:split')).toEqual([]);
        expect(matchPaletteQuery(all, 'p:split')).toEqual([]);
    });
});

/**
 * UI-FIDELITY M54 — the list is FLAT and interleaved, and the two tests that asserted the
 * grouped order were rewritten rather than kept: they pinned the very divergence the finding is
 * about (`paletteSections` regrouping a match into WORKSPACES / PANES, which put every workspace
 * above every pane). `CommandPaletteView.swift:47` is one `ForEach(items)` over the universe
 * `AppReducer.swift:192-240` builds — workspace, its panes, next workspace — so the navigation
 * order is the match itself.
 */
describe('order and selection', () => {
    it('the navigation order is the match, interleaved: each workspace then ITS panes', () => {
        expect(paletteNavigationOrder(items()).map((item) => item.id)).toEqual([
            `ws:${W1}`,
            `pane:${P1}`,
            `pane:${P2}`,
            `ws:${W2}`,
            `pane:${P3}`
        ]);
    });

    it('and it never reorders a filtered match — commands stay at the tail they were built on', () => {
        const command: PaletteItem = {
            id: 'cmd:split',
            kind: 'command',
            icon: 'bolt',
            title: 'Split Right',
            subtitle: '',
            workspaceID: null,
            workspaceName: '',
            paneID: null,
            workspaceColor: null
        };
        const universe = [...items(), command];
        expect(paletteNavigationOrder(matchPaletteQuery(universe, 'client')).map((item) => item.id)).toEqual([
            `ws:${W1}`,
            `pane:${P1}`,
            `pane:${P2}`
        ]);
        expect(paletteNavigationOrder(universe).at(-1)?.id).toBe('cmd:split');
    });

    it('clamps the selection without wrapping', () => {
        expect(clampSelection(-1, 3)).toBe(0);
        expect(clampSelection(5, 3)).toBe(2);
        expect(clampSelection(1, 0)).toBe(0);
    });
});

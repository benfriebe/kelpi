import { describe, expect, it } from 'vitest';
import {
    resolvePaneInWorkspace,
    resolvePaneTarget,
    visiblePanesOfWorkspace,
    workspaceContainingPane,
    workspaceContainingVisiblePane
} from './pane-target.js';
import type { PaneTargetResolution } from './pane-target.js';
import type { ResolveState } from './types.js';

const WS_MAIN = '11111111-0000-4000-8000-000000000001';
const WS_BETA = '22222222-0000-4000-8000-000000000002';
const P_COORDINATOR = 'AAAAAAAA-0000-4000-8000-00000000000A';
const P_WORKER_1 = 'BBBBBBBB-0000-4000-8000-00000000000B';
const P_WORKER_2 = 'CCCCCCCC-0000-4000-8000-00000000000C';
const P_BETA_WORKER = 'DDDDDDDD-0000-4000-8000-00000000000D';
const P_PARKED = 'EEEEEEEE-0000-4000-8000-00000000000E';
const P_GONE = 'FFFFFFFF-0000-4000-8000-00000000000F';

const state: ResolveState = {
    workspaces: [
        { id: WS_MAIN, name: 'main', slug: 'main-11111111' },
        { id: WS_BETA, name: 'beta', slug: 'beta-22222222' }
    ],
    panes: [
        { id: P_COORDINATOR, label: 'coordinator', workspaceID: WS_MAIN },
        { id: P_WORKER_1, label: 'worker', workspaceID: WS_MAIN },
        { id: P_WORKER_2, label: 'worker', workspaceID: WS_MAIN },
        { id: P_BETA_WORKER, label: 'worker', workspaceID: WS_BETA },
        { id: P_PARKED, label: 'parked', workspaceID: WS_MAIN, parked: true }
    ],
    groups: []
};

/** Single-label state: `worker` is unique in main. */
const simple: ResolveState = {
    ...state,
    panes: state.panes.filter((pane) => pane.id !== P_WORKER_2)
};

function error(result: PaneTargetResolution): string {
    if (result.ok) throw new Error(`expected failure, resolved ${result.paneID}`);
    return result.error;
}

function resolved(result: PaneTargetResolution): string {
    if (!result.ok) throw new Error(`expected success, got ${result.error}`);
    return result.paneID;
}

describe('resolvePaneTarget - workspace scope', () => {
    it('rejects an unknown workspace filter with the exact wire string', () => {
        expect(error(resolvePaneTarget(state, { target: 'worker', workspaceFilter: 'nope' }))).toBe(
            'workspace not found: nope'
        );
    });

    it('rejects an ambiguous workspace name through the strict resolver', () => {
        const ambiguous: ResolveState = {
            ...state,
            workspaces: [...state.workspaces, { id: P_GONE, name: 'main', slug: 'main-ffffffff' }]
        };
        expect(
            error(resolvePaneTarget(ambiguous, { target: 'coordinator', workspaceFilter: 'main' }))
        ).toBe('workspace not found: main');
    });
});

describe('resolvePaneTarget - UUID targets', () => {
    it('is global without a filter', () => {
        expect(resolved(resolvePaneTarget(state, { target: P_BETA_WORKER }))).toBe(P_BETA_WORKER);
        expect(resolved(resolvePaneTarget(state, { target: P_BETA_WORKER.toLowerCase() }))).toBe(
            P_BETA_WORKER
        );
    });

    it('reports the unscoped miss verbatim (echoing the token as typed)', () => {
        expect(error(resolvePaneTarget(state, { target: P_GONE }))).toBe(
            `no pane with UUID '${P_GONE}'`
        );
    });

    it('reports the scoped miss with the workspace name', () => {
        expect(
            error(resolvePaneTarget(state, { target: P_BETA_WORKER, workspaceFilter: 'main' }))
        ).toBe(`no pane with UUID '${P_BETA_WORKER}' in workspace 'main'`);
    });

    it('never resolves a parked pane', () => {
        expect(error(resolvePaneTarget(state, { target: P_PARKED }))).toBe(
            `no pane with UUID '${P_PARKED}'`
        );
    });
});

describe('resolvePaneTarget - label targets', () => {
    it('resolves within an explicit workspace scope', () => {
        expect(
            resolved(resolvePaneTarget(state, { target: 'worker', workspaceFilter: 'beta' }))
        ).toBe(P_BETA_WORKER);
    });

    it('resolves within the caller workspace implied by pane_id', () => {
        expect(resolved(resolvePaneTarget(simple, { paneID: P_COORDINATOR, target: 'worker' }))).toBe(
            P_WORKER_1
        );
    });

    it('matches labels case-sensitively', () => {
        expect(error(resolvePaneTarget(state, { target: 'Worker', workspaceFilter: 'beta' }))).toBe(
            "no pane with label 'Worker' in workspace 'beta'"
        );
    });

    it('refuses a bare label with no scope at all', () => {
        expect(error(resolvePaneTarget(state, { target: 'worker' }))).toBe(
            "label 'worker' requires --workspace <name-or-id> when called from outside a Kelpi pane"
        );
    });

    it('refuses a stale caller pane id', () => {
        expect(error(resolvePaneTarget(state, { paneID: P_GONE, target: 'worker' }))).toBe(
            `origin pane '${P_GONE}' no longer exists; pass --workspace <name-or-id> to address a pane in another workspace`
        );
    });

    it('adds the origin hint when a label misses in the caller workspace', () => {
        expect(
            error(resolvePaneTarget(state, { paneID: P_COORDINATOR, target: 'ghost' }))
        ).toBe(
            "no pane with label 'ghost' in workspace 'main' (use --workspace <name-or-id> to address another workspace)"
        );
    });

    it('reports ambiguity with the match count', () => {
        expect(error(resolvePaneTarget(state, { paneID: P_COORDINATOR, target: 'worker' }))).toBe(
            "label 'worker' is ambiguous (2 matches); pass --workspace <name-or-id> to disambiguate"
        );
        expect(error(resolvePaneTarget(state, { target: 'worker', workspaceFilter: 'main' }))).toBe(
            "label 'worker' is ambiguous (2 matches); pass --workspace <name-or-id> to disambiguate"
        );
    });

    it('does not see parked panes', () => {
        expect(error(resolvePaneTarget(state, { target: 'parked', workspaceFilter: 'main' }))).toBe(
            "no pane with label 'parked' in workspace 'main'"
        );
    });
});

describe('resolvePaneTarget - caller pane and final scope check', () => {
    it('acts on the caller pane when no target is given', () => {
        expect(resolved(resolvePaneTarget(state, { paneID: P_WORKER_1 }))).toBe(P_WORKER_1);
    });

    it('rejects an unknown caller pane', () => {
        expect(error(resolvePaneTarget(state, { paneID: P_GONE }))).toBe(
            `no pane with UUID '${P_GONE}'`
        );
    });

    it('is a defensive error when neither pane_id nor target is present', () => {
        expect(error(resolvePaneTarget(state, {}))).toBe('missing pane_id and target');
    });

    it('rejects a caller pane outside the requested workspace', () => {
        expect(
            error(resolvePaneTarget(state, { paneID: P_BETA_WORKER, workspaceFilter: 'main' }))
        ).toBe(`pane '${P_BETA_WORKER}' is not in workspace 'main'`);
    });

    it('reports a pane whose workspace vanished', () => {
        const orphaned: ResolveState = {
            ...state,
            panes: [{ id: P_GONE, label: null, workspaceID: 'nowhere' }]
        };
        expect(error(resolvePaneTarget(orphaned, { paneID: P_GONE }))).toBe(
            `pane not found: ${P_GONE}`
        );
    });

    it('resolves the target UUID to the stored canonical id', () => {
        const result = resolvePaneTarget(state, { target: P_WORKER_1.toLowerCase() });
        expect(result.ok && result.paneID).toBe(P_WORKER_1);
        expect(result.ok && result.workspace.name).toBe('main');
    });

    it('lets target win over pane_id', () => {
        expect(
            resolved(resolvePaneTarget(state, { paneID: P_COORDINATOR, target: P_BETA_WORKER }))
        ).toBe(P_BETA_WORKER);
    });
});

describe('lookup helpers', () => {
    it('visiblePanesOfWorkspace excludes parked panes', () => {
        expect(visiblePanesOfWorkspace(state, WS_MAIN).map((pane) => pane.id)).toEqual([
            P_COORDINATOR,
            P_WORKER_1,
            P_WORKER_2
        ]);
    });

    it('workspaceContainingPane sees parked panes, the visible variant does not', () => {
        expect(workspaceContainingPane(state, P_PARKED)?.id).toBe(WS_MAIN);
        expect(workspaceContainingVisiblePane(state, P_PARKED)).toBeNull();
    });

    it('resolvePaneInWorkspace takes a member UUID or a unique label', () => {
        expect(resolvePaneInWorkspace(state, WS_MAIN, P_WORKER_1)).toBe(P_WORKER_1);
        expect(resolvePaneInWorkspace(state, WS_MAIN, P_BETA_WORKER)).toBeNull();
        expect(resolvePaneInWorkspace(state, WS_MAIN, 'coordinator')).toBe(P_COORDINATOR);
        expect(resolvePaneInWorkspace(state, WS_MAIN, 'worker')).toBeNull();
        expect(resolvePaneInWorkspace(state, WS_BETA, 'worker')).toBe(P_BETA_WORKER);
    });
});

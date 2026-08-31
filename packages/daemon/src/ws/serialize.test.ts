import { WS_DELTA_KINDS } from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import {
    emptyDaemonState,
    makeWorkspaceState,
    type DaemonState,
    type DomainEvent,
    type DomainEventKind
} from '../store/types.js';
import { HOME, NOW, W1, seededState } from '../store/testing.js';
import { serializeDomainEvent, serializeState, serializeWorkspace } from './serialize.js';

function stateWithClosedPane(): DaemonState {
    const base = emptyDaemonState(HOME);
    const workspace = makeWorkspaceState({
        id: W1,
        name: 'dev',
        slug: 'dev',
        color: 'blue',
        createdAt: Math.floor(NOW / 1000)
    });
    return {
        ...base,
        workspaces: [
            {
                ...workspace,
                recentlyClosedPanes: [
                    {
                        workingDirectory: '/tmp',
                        label: 'gone',
                        type: 'shell',
                        filePath: null,
                        scratchpadContent: 'secret notes',
                        agentSessionID: null,
                        agentKind: null,
                        agentProfileName: null,
                        markdownFontSize: 13,
                        webState: null
                    }
                ]
            }
        ]
    };
}

describe('serializeState', () => {
    it('drops the daemon host home directory', () => {
        const serialized = serializeState(seededState());
        expect(serialized['homeDirectory']).toBeUndefined();
        expect(Object.keys(serialized).sort()).toEqual([
            'groups',
            'labelPresets',
            'lastActiveWorkspaceID',
            'repos',
            'topLevelOrder',
            'workspaces'
        ]);
    });

    it('keeps panes, layout and every transient render field', () => {
        const state = seededState();
        const workspace = state.workspaces[0];
        expect(workspace).toBeDefined();
        const serialized = serializeWorkspace(workspace as (typeof state.workspaces)[number]);
        expect(Array.isArray(serialized['panes'])).toBe(true);
        expect((serialized['panes'] as unknown[]).length).toBe(1);
        expect(serialized['layout']).toEqual(workspace?.layout);
        expect(serialized['focusedPaneID']).toBe(workspace?.focusedPaneID);
        expect(serialized['isSyncInputActive']).toBe(false);
    });

    it('replaces the reopen-closed-pane stack with a count', () => {
        const serialized = serializeState(stateWithClosedPane());
        const workspaces = serialized['workspaces'] as Record<string, unknown>[];
        const first = workspaces[0];
        expect(first?.['recentlyClosedPanes']).toBeUndefined();
        expect(first?.['recentlyClosedCount']).toBe(1);
        expect(JSON.stringify(serialized)).not.toContain('secret notes');
    });

    it('round-trips through JSON unchanged', () => {
        const serialized = serializeState(seededState());
        expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
    });
});

describe('serializeDomainEvent', () => {
    it('keeps the event kind and identity fields', () => {
        const event: DomainEvent = { kind: 'workspace-removed', id: W1 };
        expect(serializeDomainEvent(event)).toEqual({ kind: 'workspace-removed', id: W1 });
    });

    it('strips the undo stack from a workspace-upserted envelope', () => {
        const state = stateWithClosedPane();
        const workspace = state.workspaces[0];
        expect(workspace).toBeDefined();
        const { panes, parkedPanes, layout, zoomedPaneID, savedLayout, currentLayoutIndex, focusedPaneID, focusHistory, isSyncInputActive, syncInputExcluded, ...envelope } =
            workspace as (typeof state.workspaces)[number];
        void panes;
        void parkedPanes;
        void layout;
        void zoomedPaneID;
        void savedLayout;
        void currentLayoutIndex;
        void focusedPaneID;
        void focusHistory;
        void isSyncInputActive;
        void syncInputExcluded;

        const serialized = serializeDomainEvent({ kind: 'workspace-upserted', id: W1, workspace: envelope });
        const payload = serialized['workspace'] as Record<string, unknown>;
        expect(payload['recentlyClosedPanes']).toBeUndefined();
        expect(payload['recentlyClosedCount']).toBe(1);
        expect(payload['name']).toBe('dev');
    });

    it('serializes layout changes with their layout trees', () => {
        const serialized = serializeDomainEvent({
            kind: 'layout-changed',
            workspaceID: W1,
            layout: { kind: 'leaf', paneID: 'P' },
            zoomedPaneID: null,
            savedLayout: null,
            currentLayoutIndex: 2
        });
        expect(serialized).toEqual({
            kind: 'layout-changed',
            workspaceID: W1,
            layout: { kind: 'leaf', paneID: 'P' },
            zoomedPaneID: null,
            savedLayout: null,
            currentLayoutIndex: 2
        });
    });
});

describe('protocol conformance', () => {
    /**
     * This list must match `@kelpi/protocol`'s `WS_DELTA_KINDS`: clients replay these events with
     * the daemon's own `applyDomainEvents`, so a kind the protocol does not declare (or declares
     * and the store never emits) is a client that silently drops or mis-applies a delta. The
     * `satisfies` fails the build if a new `DomainEvent` kind appears without being listed.
     */
    const EMITTED_KINDS = [
        'workspace-upserted',
        'workspace-removed',
        'pane-upserted',
        'pane-removed',
        'layout-changed',
        'focus-changed',
        'sync-changed',
        'agent-status-changed',
        'group-upserted',
        'group-removed',
        'order-changed',
        'active-workspace-changed',
        'label-presets-changed',
        'repos-changed'
    ] as const satisfies readonly DomainEventKind[];

    it('declares exactly the delta kinds the protocol package names', () => {
        // Exhaustive the other way too: an unlisted kind makes this array type non-empty.
        const unlisted: Exclude<DomainEventKind, (typeof EMITTED_KINDS)[number]>[] = [];
        expect(unlisted).toEqual([]);
        expect([...EMITTED_KINDS].sort()).toEqual([...WS_DELTA_KINDS].sort());
    });
});

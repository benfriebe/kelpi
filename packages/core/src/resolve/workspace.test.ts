import { describe, expect, it } from 'vitest';
import {
    resolveGroupMember,
    resolveGroupStrict,
    resolveWorkspaceLenient,
    resolveWorkspaceStrict
} from './workspace.js';
import type { ResolveState } from './types.js';

const WS_MAIN = '11111111-0000-4000-8000-000000000001';
const WS_BETA = '22222222-0000-4000-8000-000000000002';
const WS_DUPE_A = '33333333-0000-4000-8000-000000000003';
const WS_DUPE_B = '44444444-0000-4000-8000-000000000004';
const GROUP_PROJECTS = '55555555-0000-4000-8000-000000000005';
const MISSING = '99999999-0000-4000-8000-000000000099';

const state: ResolveState = {
    workspaces: [
        { id: WS_MAIN, name: 'main', slug: 'main-11111111' },
        { id: WS_BETA, name: 'Beta', slug: 'beta-22222222' },
        { id: WS_DUPE_A, name: 'dupe', slug: 'dupe-33333333' },
        { id: WS_DUPE_B, name: 'dupe', slug: 'dupe-44444444' }
    ],
    panes: [],
    groups: [
        { id: GROUP_PROJECTS, name: 'projects' },
        { id: '66666666-0000-4000-8000-000000000006', name: 'twin' },
        { id: '77777777-0000-4000-8000-000000000007', name: 'twin' }
    ]
};

describe('resolveWorkspaceStrict', () => {
    it('resolves by UUID in either case', () => {
        expect(resolveWorkspaceStrict(state, WS_MAIN)?.name).toBe('main');
        expect(resolveWorkspaceStrict(state, WS_MAIN.toLowerCase())?.name).toBe('main');
    });

    it('matches names case-sensitively and exactly', () => {
        expect(resolveWorkspaceStrict(state, 'Beta')?.id).toBe(WS_BETA);
        expect(resolveWorkspaceStrict(state, 'beta')).toBeNull();
        expect(resolveWorkspaceStrict(state, 'mai')).toBeNull();
    });

    it('returns null for ambiguous names (callers re-check to distinguish)', () => {
        expect(resolveWorkspaceStrict(state, 'dupe')).toBeNull();
    });

    it('falls through to the name match when a UUID token matches no id', () => {
        const named: ResolveState = {
            ...state,
            workspaces: [...state.workspaces, { id: WS_BETA, name: MISSING, slug: 'x-1' }]
        };
        expect(resolveWorkspaceStrict(named, MISSING)?.name).toBe(MISSING);
    });

    it('lets a matching UUID win over a workspace named that UUID', () => {
        const named: ResolveState = {
            ...state,
            workspaces: [...state.workspaces, { id: WS_BETA, name: WS_MAIN, slug: 'x-1' }]
        };
        expect(resolveWorkspaceStrict(named, WS_MAIN)?.id).toBe(WS_MAIN);
    });
});

describe('resolveGroupStrict', () => {
    it('resolves by UUID, unique name, and refuses ambiguity', () => {
        expect(resolveGroupStrict(state, GROUP_PROJECTS)?.name).toBe('projects');
        expect(resolveGroupStrict(state, 'projects')?.id).toBe(GROUP_PROJECTS);
        expect(resolveGroupStrict(state, 'twin')).toBeNull();
        expect(resolveGroupStrict(state, 'Projects')).toBeNull();
    });
});

describe('resolveWorkspaceLenient', () => {
    it('is case-insensitive and takes the FIRST match with no ambiguity guard', () => {
        expect(resolveWorkspaceLenient(state, 'beta')?.id).toBe(WS_BETA);
        expect(resolveWorkspaceLenient(state, 'BETA')?.id).toBe(WS_BETA);
        expect(resolveWorkspaceLenient(state, 'dupe')?.id).toBe(WS_DUPE_A);
    });

    it('accepts the slug as a third lookup key', () => {
        expect(resolveWorkspaceLenient(state, 'dupe-44444444')?.id).toBe(WS_DUPE_B);
    });

    it('prefers a UUID id match, then name, then slug', () => {
        expect(resolveWorkspaceLenient(state, WS_BETA)?.id).toBe(WS_BETA);
        expect(resolveWorkspaceLenient(state, 'nope')).toBeNull();
    });

    it('differs from the strict resolver exactly where the spec says it does', () => {
        expect(resolveWorkspaceStrict(state, 'beta')).toBeNull();
        expect(resolveWorkspaceLenient(state, 'beta')).not.toBeNull();
        expect(resolveWorkspaceStrict(state, 'dupe')).toBeNull();
        expect(resolveWorkspaceLenient(state, 'dupe')).not.toBeNull();
        expect(resolveWorkspaceStrict(state, 'main-11111111')).toBeNull();
        expect(resolveWorkspaceLenient(state, 'main-11111111')?.id).toBe(WS_MAIN);
    });
});

describe('resolveGroupMember', () => {
    const members = [WS_DUPE_A, WS_MAIN];

    it('resolves a member UUID', () => {
        expect(resolveGroupMember(state, WS_MAIN.toLowerCase(), members)).toBe(WS_MAIN);
    });

    it('resolves a name unique within the group', () => {
        expect(resolveGroupMember(state, 'main', members)).toBe(WS_MAIN);
        expect(resolveGroupMember(state, 'dupe', members)).toBe(WS_DUPE_A);
    });

    it('refuses non-members, unknown names, and in-group ambiguity', () => {
        expect(resolveGroupMember(state, WS_BETA, members)).toBeNull();
        expect(resolveGroupMember(state, 'Beta', members)).toBeNull();
        expect(resolveGroupMember(state, 'dupe', [WS_DUPE_A, WS_DUPE_B])).toBeNull();
    });
});

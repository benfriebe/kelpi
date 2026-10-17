import { describe, expect, it, vi } from 'vitest';

import type { ChromeRepo } from '../chrome/types';
import type { SidebarEntry } from '../state';
import {
    createPhoneWorkspace,
    parsePlacementValue,
    phoneCreateInput,
    placementDefaults,
    placementOptions,
    placementValue,
    type PhoneCreateCommands,
    type PhoneNewWorkspaceDraft
} from './new-workspace';

const REPO: ChromeRepo = { id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/wt' };

/** Only the fields the placement walk reads. */
function entries(): readonly SidebarEntry[] {
    const workspace = (id: string, name: string) => ({ id, name });
    return [
        { kind: 'workspace', workspace: workspace('w1', 'solo') },
        {
            kind: 'group',
            group: { id: 'g1', name: 'Client', color: null, icon: null, isCollapsed: false, repoID: 'r1', createWorktree: true },
            workspaces: [workspace('w2', 'api')],
            // A nested child is never in an entry's own list, so it is never offered as a parent.
            nested: new Map([['w2', [workspace('w3', 'child')]]])
        }
    ] as unknown as readonly SidebarEntry[];
}

function draft(overrides: Partial<PhoneNewWorkspaceDraft> = {}): PhoneNewWorkspaceDraft {
    return { name: ' api ', placement: { kind: 'top' }, repo: null, worktree: null, ...overrides };
}

describe('placements', () => {
    it('round-trips through the picker value', () => {
        for (const placement of [{ kind: 'top' }, { kind: 'group', groupID: 'g1' }, { kind: 'parent', workspaceID: 'w2' }] as const) {
            expect(parsePlacementValue(placementValue(placement))).toEqual(placement);
        }
    });

    it('offers every group, and every workspace that is not itself nested as a parent', () => {
        const options = placementOptions(entries());
        expect(options.groups.map((group) => group.id)).toEqual(['g1']);
        expect(options.parents).toEqual([
            { id: 'w1', name: 'solo', groupID: null, groupName: null },
            { id: 'w2', name: 'api', groupID: 'g1', groupName: 'Client' }
        ]);
    });

    it('takes a group’s defaults in the group, and a parent group’s under the parent', () => {
        const options = placementOptions(entries());
        const withSwitch = { repoIDs: ['r1'], worktree: true };
        expect(placementDefaults({ kind: 'group', groupID: 'g1' }, options, [REPO])).toEqual(withSwitch);
        expect(placementDefaults({ kind: 'parent', workspaceID: 'w2' }, options, [REPO])).toEqual(withSwitch);
        expect(placementDefaults({ kind: 'parent', workspaceID: 'w1' }, options, [REPO])).toEqual({ repoIDs: [], worktree: false });
        // A repository the registry does not list (not read yet) prefills nothing.
        expect(placementDefaults({ kind: 'group', groupID: 'g1' }, options, [])).toEqual({ repoIDs: [], worktree: false });
    });
});

describe('phoneCreateInput', () => {
    it('sends the final choice literally, with focus as the host decides', () => {
        expect(phoneCreateInput(draft(), true)).toEqual({ name: 'api', groupDefaults: false, focus: true });
        expect(phoneCreateInput(draft({ placement: { kind: 'group', groupID: 'g1' } }), false)).toEqual({
            name: 'api',
            group: 'g1',
            groupDefaults: false,
            focus: false
        });
    });

    it('nests by parent, opens a plain repository at its path, and sends a worktree with its branch', () => {
        expect(phoneCreateInput(draft({ placement: { kind: 'parent', workspaceID: 'w2' }, repo: REPO }), true)).toEqual({
            name: 'api',
            parent: 'w2',
            path: '/src/app',
            groupDefaults: false,
            focus: true
        });
        expect(
            phoneCreateInput(draft({ repo: REPO, worktree: { name: 'fix', branch: 'ben/fix', updateMain: true } }), true)
        ).toEqual({ name: 'api', repo: '/src/app', worktree: 'fix', branch: 'ben/fix', updateMain: true, groupDefaults: false, focus: true });
    });
});

describe('createPhoneWorkspace', () => {
    function commands(reply: Record<string, unknown>): PhoneCreateCommands & { addRepoAssociation: ReturnType<typeof vi.fn> } {
        return {
            createWorkspace: vi.fn(() => Promise.resolve(reply)),
            addRepoAssociation: vi.fn(() => Promise.resolve({ ok: true }))
        } as unknown as PhoneCreateCommands & { addRepoAssociation: ReturnType<typeof vi.fn> };
    }

    it('associates a plain repository once the workspace exists', async () => {
        const client = commands({ ok: true, workspace_id: 'new' });
        await expect(createPhoneWorkspace(client, draft({ repo: REPO }), { focus: true })).resolves.toEqual({ ok: true, workspaceID: 'new' });
        expect(client.addRepoAssociation).toHaveBeenCalledWith({ workspaceID: 'new', path: '/src/app' });
    });

    it('leaves a worktree’s association to the daemon, and hands back a refusal', async () => {
        const client = commands({ ok: true, workspace_id: 'new' });
        await createPhoneWorkspace(client, draft({ repo: REPO, worktree: { name: 'fix', branch: 'fix', updateMain: false } }), { focus: true });
        expect(client.addRepoAssociation).not.toHaveBeenCalled();
        await expect(createPhoneWorkspace(commands({ ok: false, error: 'nope' }), draft(), { focus: true })).resolves.toEqual({
            ok: false,
            error: 'nope'
        });
    });
});

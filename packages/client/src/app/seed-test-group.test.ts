/**
 * Debug ▸ Seed Test Group's client half (§APP-028, §SET-194).
 *
 * What is asserted here is the FIXTURE — the names, the colour, the group membership and the
 * order — because that is what the checklist item claims and what a screenshot of the sidebar
 * can be checked against. The gesture that reaches it lives in the shell (`menu.test.ts`), and
 * the two meeting in the middle is `SEED_TEST_GROUP_COMMAND`, pinned in both suites.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    REVEAL_SUPPRESSION_MS,
    SEED_TEST_GROUP_COMMAND,
    TEST_FIXTURE_COLOR,
    TEST_GROUP_NAME,
    TEST_WORKSPACE_NAMES,
    consumeSuppressedReveal,
    seedTestGroup,
    suppressReveal,
    type SeedCommands,
    type SeedReply
} from './seed-test-group';

interface Recorder {
    readonly commands: SeedCommands;
    readonly calls: { readonly verb: string; readonly input: Record<string, unknown> }[];
}

function recorder(replies: {
    group?: SeedReply | (() => Promise<SeedReply>);
    workspace?: (name: string, index: number) => SeedReply;
}): Recorder {
    const calls: { verb: string; input: Record<string, unknown> }[] = [];
    let created = 0;
    return {
        calls,
        commands: {
            async createGroup(input) {
                calls.push({ verb: 'group-create', input: { ...input } });
                const answer = replies.group ?? { ok: true, group_id: 'GROUP-1' };
                return typeof answer === 'function' ? answer() : answer;
            },
            async createWorkspace(input) {
                calls.push({ verb: 'workspace-create', input: { ...input } });
                const index = created;
                created += 1;
                return (
                    replies.workspace?.(String(input.name), index) ?? {
                        ok: true,
                        workspace_id: `WS-${String(index + 1)}`
                    }
                );
            }
        }
    };
}

describe('the fixture', () => {
    it('is the one `AppReducer.seedTestGroup` builds: a gray group holding two gray monitors', async () => {
        expect(TEST_GROUP_NAME).toBe('Test Group');
        expect([...TEST_WORKSPACE_NAMES]).toEqual(['Test Monitor 1', 'Test Monitor 2']);
        expect(TEST_FIXTURE_COLOR).toBe('gray');

        const bound = recorder({});
        const result = await seedTestGroup({ commands: bound.commands });

        expect(result.ok).toBe(true);
        expect(bound.calls).toEqual([
            { verb: 'group-create', input: { name: 'Test Group', color: 'gray' } },
            { verb: 'workspace-create', input: { name: 'Test Monitor 1', color: 'gray', group: 'GROUP-1' } },
            { verb: 'workspace-create', input: { name: 'Test Monitor 2', color: 'gray', group: 'GROUP-1' } }
        ]);
        expect(result.groupID).toBe('GROUP-1');
        expect(result.workspaceIDs).toEqual(['WS-1', 'WS-2']);
    });

    it('creates the two workspaces IN ORDER, so the group’s childOrder is 1 then 2', async () => {
        const order: string[] = [];
        const commands: SeedCommands = {
            async createGroup() {
                return { ok: true, group_id: 'G' };
            },
            async createWorkspace(input) {
                const name = String(input.name);
                order.push(`start ${name}`);
                // The FIRST create is made slow: an implementation that fired both at once (a
                // `Promise.all`) would record `start 2` before `end 1`, and the group's
                // childOrder would be whichever reply won the race.
                if (name === 'Test Monitor 1') await new Promise<void>((resolve) => setTimeout(resolve, 5));
                order.push(`end ${name}`);
                return { ok: true, workspace_id: name };
            }
        };

        await seedTestGroup({ commands });

        expect(order).toEqual([
            'start Test Monitor 1',
            'end Test Monitor 1',
            'start Test Monitor 2',
            'end Test Monitor 2'
        ]);
    });

    it('reads the group back when the ack carried no id — which is what the daemon really sends', async () => {
        // `group-create` is a fire-and-forget wire verb; `ws/sync.ts` settles it `{ok:true}`.
        const bound = recorder({ group: { ok: true } });
        const listGroups = vi.fn(async () =>
            Promise.resolve({
                ok: true,
                // Two groups of the same name — a second seed in one session. The NEWEST wins,
                // because `group-list` answers in sidebar order and a new group is appended.
                groups: [
                    { id: 'OLD-TEST-GROUP', name: 'Test Group' },
                    { id: 'other', name: 'Work' },
                    { id: 'NEW-TEST-GROUP', name: 'Test Group' }
                ]
            })
        );
        const result = await seedTestGroup({ commands: { ...bound.commands, listGroups } });
        expect(result.ok).toBe(true);
        expect(result.groupID).toBe('NEW-TEST-GROUP');
        expect(bound.calls[1]?.input.group).toBe('NEW-TEST-GROUP');
        expect(bound.calls[2]?.input.group).toBe('NEW-TEST-GROUP');
    });

    it('falls back to the group NAME when there is no listing to read', async () => {
        const bound = recorder({ group: { ok: true } });
        const result = await seedTestGroup({ commands: bound.commands });
        expect(result.ok).toBe(true);
        expect(result.groupID).toBeUndefined();
        expect(bound.calls[1]?.input.group).toBe('Test Group');
    });

    it('falls back to the name when the listing fails or is malformed, rather than giving up', async () => {
        for (const listGroups of [
            () => Promise.reject(new Error('socket closed')),
            () => Promise.resolve({ ok: false, error: 'nope' }),
            () => Promise.resolve({ ok: true, groups: 'not-an-array' }),
            () => Promise.resolve({ ok: true, groups: [{ name: 'Test Group' }] })
        ]) {
            const bound = recorder({ group: { ok: true } });
            const result = await seedTestGroup({ commands: { ...bound.commands, listGroups } });
            expect(result.ok).toBe(true);
            expect(bound.calls[1]?.input.group).toBe('Test Group');
        }
    });

    it('never activates what it creates — the Swift seed leaves the active workspace alone', async () => {
        // Structural, and it is the point: the only verbs this module can reach are the two it
        // is handed. There is no activate/reveal in the seam at all, so the seed cannot move the
        // user, however `App.tsx` changes around it.
        const bound = recorder({});
        await seedTestGroup({ commands: bound.commands });
        expect(bound.calls.map((call) => call.verb)).toEqual([
            'group-create',
            'workspace-create',
            'workspace-create'
        ]);
    });
});

describe('failures are reported, never thrown', () => {
    it('stops before creating loose workspaces when the group cannot be made', async () => {
        const onFailure = vi.fn();
        const bound = recorder({ group: { ok: false, error: 'a group named Test Group already exists' } });

        const result = await seedTestGroup({ commands: bound.commands, onFailure });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('already exists');
        expect(bound.calls.map((call) => call.verb)).toEqual(['group-create']);
        expect(onFailure).toHaveBeenCalledWith('Seed Test Group', 'a group named Test Group already exists');
    });

    it('reports a failed workspace but still creates the other one', async () => {
        const onFailure = vi.fn();
        const bound = recorder({
            workspace: (name, index) =>
                name === 'Test Monitor 1'
                    ? { ok: false, error: 'nope' }
                    : { ok: true, workspace_id: `WS-${String(index + 1)}` }
        });

        const result = await seedTestGroup({ commands: bound.commands, onFailure });

        expect(result.ok).toBe(false);
        expect(result.workspaceIDs).toEqual(['WS-2']);
        expect(onFailure).toHaveBeenCalledWith('Seed Test Group', 'Test Monitor 1: nope');
    });

    it('swallows a rejected promise — a dev menu row must not take the renderer down', async () => {
        const onFailure = vi.fn();
        const commands: SeedCommands = {
            createGroup: () => Promise.reject(new Error('socket closed')),
            createWorkspace: () => Promise.resolve({ ok: true })
        };

        const result = await seedTestGroup({ commands, onFailure });

        expect(result).toEqual({ ok: false, workspaceIDs: [], error: 'socket closed' });
        expect(onFailure).toHaveBeenCalledWith('Seed Test Group', 'socket closed');
    });

    it('survives having no reporter at all', async () => {
        const bound = recorder({ group: { ok: false } });
        await expect(seedTestGroup({ commands: bound.commands })).resolves.toMatchObject({ ok: false });
    });
});

describe('keeping the view where it was', () => {
    it('announces each workspace id as its create is acknowledged, in order', async () => {
        const seen: string[] = [];
        const bound = recorder({});
        await seedTestGroup({
            commands: bound.commands,
            onWorkspaceCreated: (id) => seen.push(id)
        });
        // Both, in creation order — this is what the call site suppresses reveals for, and a
        // missed id is a window that jumps to a workspace nobody asked for.
        expect(seen).toEqual(['WS-1', 'WS-2']);
    });

    it('announces nothing for a create that failed or answered without an id', async () => {
        const seen: string[] = [];
        const bound = recorder({
            workspace: (name, index) =>
                name === 'Test Monitor 1' ? { ok: false, error: 'nope' } : { ok: true, ...(index < 0 ? {} : {}) }
        });
        await seedTestGroup({ commands: bound.commands, onWorkspaceCreated: (id) => seen.push(id) });
        expect(seen).toEqual([]);
    });

    it('suppresses exactly one reveal per id, and only inside its window', () => {
        const pending = new Map<string, number>();
        const now = 1_000_000;
        suppressReveal(pending, 'WS-1', now);

        // A different workspace's reveal is untouched…
        expect(consumeSuppressedReveal(pending, 'OTHER', now + 5)).toBe(false);
        // …the seeded one is swallowed once…
        expect(consumeSuppressedReveal(pending, 'WS-1', now + 5)).toBe(true);
        // …and a LATER reveal of the same workspace (a notification click) is honoured.
        expect(consumeSuppressedReveal(pending, 'WS-1', now + 6)).toBe(false);
    });

    it('expires rather than swallowing a reveal an hour later', () => {
        const pending = new Map<string, number>();
        const now = 1_000_000;
        suppressReveal(pending, 'WS-1', now);
        expect(consumeSuppressedReveal(pending, 'WS-1', now + REVEAL_SUPPRESSION_MS + 1)).toBe(false);
        expect(pending.size).toBe(0);
    });

    it('prunes stale entries as it goes, so a daemon that never reveals cannot leak them', () => {
        const pending = new Map<string, number>();
        suppressReveal(pending, 'GHOST-1', 0);
        suppressReveal(pending, 'GHOST-2', 0);
        consumeSuppressedReveal(pending, 'SOMETHING-ELSE', REVEAL_SUPPRESSION_MS + 1);
        expect(pending.size).toBe(0);
    });
});

describe('the command name', () => {
    it('is the string the shell’s Debug row relays (`shell/src/menu.ts`)', () => {
        expect(SEED_TEST_GROUP_COMMAND).toBe('seed-test-group');
    });
});

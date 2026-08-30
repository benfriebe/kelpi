/**
 * `kelpi group *`: create / list / rename / delete (± cascade) / reorder / sort.
 *
 * `group create|rename|delete` are fire-and-forget (exit 0, no output, no reply), so every
 * assertion about them is made through the request/response `group list --json` that follows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    startCompatDaemon,
    swiftCLIAvailable,
    type CompatDaemon,
    type GroupListEntryJSON,
    type WorkspaceListEntryJSON
} from './harness.js';

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

interface OrderReply {
    readonly ok: boolean;
    readonly group_id: string;
    readonly group_name: string;
    readonly order: readonly string[];
}

describe.skipIf(!swiftCLIAvailable())('compat: kelpi group', () => {
    let kelpi: CompatDaemon;

    beforeEach(async () => {
        kelpi = await startCompatDaemon();
    }, 60_000);

    afterEach(async () => {
        await kelpi?.stop();
    });

    /** alpha, beta, gamma in one group, in creation order. */
    async function seedGroup(): Promise<GroupListEntryJSON> {
        for (const name of ['alpha', 'beta', 'gamma']) {
            await kelpi.json(['workspace', 'create', '--name', name, '--group', 'squad', '--json']);
        }
        const [group] = await kelpi.json<GroupListEntryJSON[]>(['group', 'list', '--json']);
        if (group === undefined) throw new Error('seed failed: no group');
        return group;
    }

    it('lists an empty group set as [] and exits 0', async () => {
        const result = await kelpi.run(['group', 'list', '--json']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([]);
    }, 60_000);

    it('creates groups (fire-and-forget) and lists them with their members', async () => {
        const create = await kelpi.run(['group', 'create', 'squad', '--color', 'red']);
        expect(create.code).toBe(0);
        expect(create.stdout).toBe(''); // fire-and-forget: not one byte back

        await kelpi.json(['workspace', 'create', '--name', 'alpha', '--group', 'squad', '--json']);
        await kelpi.json(['workspace', 'create', '--name', 'beta', '--group', 'squad', '--json']);

        const groups = await kelpi.json<GroupListEntryJSON[]>(['group', 'list', '--json']);
        expect(groups).toHaveLength(1);
        const group = groups[0]!;
        expect(group.id).toMatch(UUID);
        expect(group.name).toBe('squad');
        expect(group.color).toBe('red');
        expect(group.workspaces.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
        for (const member of group.workspaces) expect(member.id).toMatch(UUID);
    }, 60_000);

    it('renames a group, keeping its id and members', async () => {
        const before = await seedGroup();
        expect((await kelpi.run(['group', 'rename', 'squad', 'crew'])).code).toBe(0);

        const [after] = await kelpi.json<GroupListEntryJSON[]>(['group', 'list', '--json']);
        expect(after?.id).toBe(before.id);
        expect(after?.name).toBe('crew');
        expect(after?.workspaces.map((entry) => entry.name)).toEqual(['alpha', 'beta', 'gamma']);
    }, 60_000);

    it('reorders members, tailing the ones the order omits', async () => {
        const group = await seedGroup();
        const idOf = (name: string): string =>
            group.workspaces.find((entry) => entry.name === name)?.id ?? '';

        const reply = await kelpi.json<OrderReply>([
            'group', 'reorder', 'squad', '--order', 'gamma,alpha', '--json'
        ]);
        expect(reply.ok).toBe(true);
        expect(reply.group_id).toBe(group.id);
        expect(reply.group_name).toBe('squad');
        // Omitted members keep their relative order at the tail; the reply is full UUIDs.
        expect(reply.order).toEqual([idOf('gamma'), idOf('alpha'), idOf('beta')]);

        const [after] = await kelpi.json<GroupListEntryJSON[]>(['group', 'list', '--json']);
        expect(after?.workspaces.map((entry) => entry.name)).toEqual(['gamma', 'alpha', 'beta']);
    }, 60_000);

    it('rejects a bad reorder without writing anything', async () => {
        await seedGroup();
        const ordered = ['alpha', 'beta', 'gamma'];

        const unknownGroup = await kelpi.run(['group', 'reorder', 'nogroup', '--order', 'alpha', '--json']);
        expect(unknownGroup.code).toBe(1);
        expect(unknownGroup.stderr).toContain("no group matches 'nogroup'");

        const duplicate = await kelpi.run(['group', 'reorder', 'squad', '--order', 'alpha,alpha', '--json']);
        expect(duplicate.code).toBe(1);
        expect(duplicate.stderr).toContain("workspace 'alpha' listed more than once");

        const nonMember = await kelpi.run(['group', 'reorder', 'squad', '--order', 'Default', '--json']);
        expect(nonMember.code).toBe(1);
        expect(nonMember.stderr).toContain("'Default' is not a workspace in group 'squad'");

        // Nothing was written by any of the three rejections.
        const [after] = await kelpi.json<GroupListEntryJSON[]>(['group', 'list', '--json']);
        expect(after?.workspaces.map((entry) => entry.name)).toEqual(ordered);
    }, 60_000);

    it('sorts members by name, ascending and descending', async () => {
        const group = await seedGroup();
        await kelpi.json(['group', 'reorder', 'squad', '--order', 'gamma,beta,alpha', '--json']);

        const ascending = await kelpi.json<OrderReply>(['group', 'sort', 'squad', '--by', 'name', '--json']);
        expect(ascending.order).toEqual(
            ['alpha', 'beta', 'gamma'].map((name) => group.workspaces.find((entry) => entry.name === name)?.id)
        );

        const descending = await kelpi.json<OrderReply>([
            'group', 'sort', 'squad', '--by', 'name', '--desc', '--json'
        ]);
        expect(descending.order).toEqual(
            ['gamma', 'beta', 'alpha'].map((name) => group.workspaces.find((entry) => entry.name === name)?.id)
        );

        const badKey = await kelpi.run(['group', 'sort', 'squad', '--by', 'nonsense', '--json']);
        expect(badKey.code).toBe(1);
        expect(badKey.stderr).toContain("unknown sort key 'nonsense'");
    }, 60_000);

    it('promotes members to top level on a plain delete, and removes them with --cascade', async () => {
        await seedGroup();
        expect((await kelpi.run(['group', 'delete', 'squad'])).code).toBe(0);
        expect(await kelpi.json<GroupListEntryJSON[]>(['group', 'list', '--json'])).toEqual([]);

        let workspaces = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(workspaces.map((entry) => entry.name).sort()).toEqual(['Default', 'alpha', 'beta', 'gamma']);
        for (const entry of workspaces) expect(entry.group_id).toBeUndefined();

        // Re-group them, then cascade.
        expect((await kelpi.run(['group', 'create', 'crew'])).code).toBe(0);
        for (const name of ['alpha', 'beta', 'gamma']) {
            expect((await kelpi.run(['workspace', 'move', name, '--group', 'crew'])).code).toBe(0);
        }
        expect((await kelpi.run(['group', 'delete', 'crew', '--cascade'])).code).toBe(0);

        workspaces = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(workspaces.map((entry) => entry.name)).toEqual(['Default']);
        expect(await kelpi.json<GroupListEntryJSON[]>(['group', 'list', '--json'])).toEqual([]);
    }, 60_000);
});

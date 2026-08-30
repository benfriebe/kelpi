/**
 * `kelpi workspace *` against the daemon: create / list / label / move / delete.
 *
 * Assertions are on exit codes and parsed JSON only. The human table (`ID NAME GROUP PANES
 * ACTIVE LABELS`) is rendered entirely CLI-side from the same JSON, so asserting its text
 * would test the Swift binary, not the daemon.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    startCompatDaemon,
    swiftCLIAvailable,
    type CompatDaemon,
    type WorkspaceListEntryJSON
} from './harness.js';

/** Swift `UUID.uuidString`: uppercase, hyphenated (PLAN.md compatibility decision). */
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
/** Seconds-precision ISO 8601 — the Swift `.withInternetDateTime` formatter. */
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

interface CreateReply {
    readonly ok: boolean;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly group?: string;
}

interface LabelReply {
    readonly ok: boolean;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly labels: readonly string[];
}

interface DeleteRecord {
    readonly id: string;
    readonly ok: boolean;
    readonly workspace_id?: string;
    readonly workspace_name?: string;
    readonly path?: string;
    readonly error?: string;
    readonly active_agents?: number;
}

describe.skipIf(!swiftCLIAvailable())('compat: kelpi workspace', () => {
    let kelpi: CompatDaemon;

    beforeEach(async () => {
        kelpi = await startCompatDaemon();
    }, 60_000);

    afterEach(async () => {
        await kelpi?.stop();
    });

    it('creates a workspace and returns the full reply (incl. ok) under --json', async () => {
        const reply = await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'alpha', '--json']);
        // cli.md §10.2: workspace create prints the FULL reply including `ok` (unlike the
        // pane-mutation printer, which strips it).
        expect(reply.ok).toBe(true);
        expect(reply.workspace_name).toBe('alpha');
        expect(reply.workspace_id).toMatch(UUID);
        expect(reply.group).toBeUndefined();

        const grouped = await kelpi.json<CreateReply>([
            'workspace',
            'create',
            '--name',
            'beta',
            '--group',
            'squad',
            '--json'
        ]);
        // `--group` creates the group when absent (only `--worktree` requires an existing one).
        expect(grouped).toMatchObject({ ok: true, workspace_name: 'beta', group: 'squad' });

        // The plain (non-json) form still exits 0 and names the new workspace.
        const plain = await kelpi.run(['workspace', 'create', '--name', 'gamma']);
        expect(plain.code).toBe(0);
        expect(plain.stdout).toContain('created workspace gamma');
    }, 60_000);

    it('lists every workspace with the documented entry schema', async () => {
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'alpha', '--json']);
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'beta', '--group', 'squad', '--json']);

        const list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(list.map((entry) => entry.name)).toEqual(['Default', 'alpha', 'beta']);

        for (const entry of list) {
            expect(entry.id).toMatch(UUID);
            expect(typeof entry.name).toBe('string');
            expect(typeof entry.pane_count).toBe('number');
            expect(typeof entry.is_active).toBe('boolean');
            expect(entry.created_at).toMatch(ISO_SECONDS);
            expect(entry.last_accessed_at).toMatch(ISO_SECONDS);
            // `labels` is ALWAYS present, even when empty (cli.md §10.1).
            expect(Array.isArray(entry.labels)).toBe(true);
            // group_id / group_name are both-or-neither.
            expect(entry.group_id === undefined).toBe(entry.group_name === undefined);
        }

        expect(list.filter((entry) => entry.is_active)).toHaveLength(1);
        expect(list.find((entry) => entry.name === 'beta')?.group_name).toBe('squad');
        expect(list.find((entry) => entry.name === 'alpha')?.group_id).toBeUndefined();
        // A workspace with panes reports last_activity_at (max over its panes).
        expect(list.find((entry) => entry.name === 'alpha')?.last_activity_at).toMatch(ISO_SECONDS);
    }, 60_000);

    it('scopes `list --group` and rejects an unknown group', async () => {
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'beta', '--group', 'squad', '--json']);
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'alpha', '--json']);

        const scoped = await kelpi.json<WorkspaceListEntryJSON[]>([
            'workspace',
            'list',
            '--group',
            'squad',
            '--json'
        ]);
        expect(scoped.map((entry) => entry.name)).toEqual(['beta']);

        // Unknown group is an error reply (distinct from an empty group, which lists `[]`).
        const missing = await kelpi.run(['workspace', 'list', '--group', 'ghost', '--json']);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("no group matches 'ghost'");
        expect(missing.stdout).toBe('');
    }, 60_000);

    it('edits labels with set / add / remove / clear', async () => {
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'alpha', '--json']);

        const set = await kelpi.json<LabelReply>([
            'workspace', 'label', 'alpha', '--set', 'ship-it', '--set', 'review', '--json'
        ]);
        expect(set).toMatchObject({ ok: true, workspace_name: 'alpha' });
        expect(set.labels).toEqual(['ship-it', 'review']);

        // add is dedup-appending: an existing value must not duplicate.
        const added = await kelpi.json<LabelReply>([
            'workspace', 'label', 'alpha', '--add', 'ship-it', '--add', 'urgent', '--json'
        ]);
        expect(added.labels).toEqual(['ship-it', 'review', 'urgent']);

        const removed = await kelpi.json<LabelReply>(['workspace', 'label', 'alpha', '--remove', 'review', '--json']);
        expect(removed.labels).toEqual(['ship-it', 'urgent']);

        const cleared = await kelpi.json<LabelReply>(['workspace', 'label', 'alpha', '--clear', '--json']);
        expect(cleared.labels).toEqual([]);

        // The change is visible to a fresh read.
        const list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(list.find((entry) => entry.name === 'alpha')?.labels).toEqual([]);

        const unknown = await kelpi.run(['workspace', 'label', 'ghost', '--add', 'x', '--json']);
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toContain("no workspace matches 'ghost'");
    }, 60_000);

    it('moves a workspace into an existing group only', async () => {
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'alpha', '--json']);

        // Fire-and-forget: exit 0 and no output either way — the difference is in the state.
        const ghost = await kelpi.run(['workspace', 'move', 'alpha', '--group', 'ghost']);
        expect(ghost.code).toBe(0);
        let list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(list.find((entry) => entry.name === 'alpha')?.group_name).toBeUndefined();

        expect((await kelpi.run(['group', 'create', 'squad'])).code).toBe(0);
        expect((await kelpi.run(['workspace', 'move', 'alpha', '--group', 'squad'])).code).toBe(0);
        list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(list.find((entry) => entry.name === 'alpha')?.group_name).toBe('squad');

        expect((await kelpi.run(['workspace', 'move', 'alpha', '--top-level'])).code).toBe(0);
        list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(list.find((entry) => entry.name === 'alpha')?.group_id).toBeUndefined();
    }, 60_000);

    it('refuses to delete the last workspace', async () => {
        const result = await kelpi.run(['workspace', 'delete', 'Default', '--json']);
        expect(result.code).toBe(1);
        const records = JSON.parse(result.stdout) as DeleteRecord[];
        expect(records).toEqual([
            { id: 'Default', ok: false, error: 'refusing to delete the last workspace' }
        ]);

        // Without --json the error goes to stderr under the command label.
        const plain = await kelpi.run(['workspace', 'delete', 'Default']);
        expect(plain.code).toBe(1);
        expect(plain.stderr).toContain('nex workspace delete: refusing to delete the last workspace');

        // Nothing was deleted.
        const list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(list).toHaveLength(1);
    }, 60_000);

    it('guards a workspace with a running agent until --force', async () => {
        const created = await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'agents', '--json']);
        const pane = await kelpi.json<{ pane_id: string }>([
            'pane', 'create', '--workspace', 'agents', '--name', 'worker', '--json'
        ]);
        expect((await kelpi.run(['event', 'start'], { paneID: pane.pane_id })).code).toBe(0);

        const guarded = await kelpi.run(['workspace', 'delete', 'agents', '--json']);
        expect(guarded.code).toBe(1);
        const [refusal] = JSON.parse(guarded.stdout) as DeleteRecord[];
        expect(refusal?.ok).toBe(false);
        expect(refusal?.active_agents).toBe(1);
        // Exact wording (singular "agent" at n == 1) — socket-handlers.md §6.4.
        expect(refusal?.error).toBe('workspace agents has 1 running agent; pass --force to delete anyway');

        const forced = await kelpi.run(['workspace', 'delete', 'agents', '--force', '--json']);
        expect(forced.code).toBe(0);
        const [deleted] = JSON.parse(forced.stdout) as DeleteRecord[];
        expect(deleted).toMatchObject({
            id: 'agents',
            ok: true,
            workspace_id: created.workspace_id,
            workspace_name: 'agents'
        });
        // `path` = a shell pane's cwd, which is what `--prune-worktree` would act on.
        expect(deleted?.path).toBe(kelpi.home);

        const list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(list.map((entry) => entry.name)).toEqual(['Default']);
    }, 60_000);

    it('reports per-id results for a bulk delete and exits 1 when any failed', async () => {
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'alpha', '--json']);
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'beta', '--json']);

        const result = await kelpi.run(['workspace', 'delete', 'alpha', 'ghost', 'beta', '--json']);
        expect(result.code).toBe(1); // one delete failed ⇒ the batch is non-zero
        const records = JSON.parse(result.stdout) as DeleteRecord[];
        expect(records.map((record) => [record.id, record.ok])).toEqual([
            ['alpha', true],
            ['ghost', false],
            ['beta', true]
        ]);
        expect(records[1]?.error).toBe('workspace not found: ghost');

        // The two good deletes still happened — a failure mid-batch is not a rollback.
        const list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(list.map((entry) => entry.name)).toEqual(['Default']);
    }, 60_000);

    it('distinguishes an ambiguous name from a missing one', async () => {
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'dup', '--json']);
        await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'dup', '--json']);

        const ambiguous = await kelpi.run(['workspace', 'delete', 'dup']);
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stderr).toContain('workspace name is ambiguous: dup (use the id)');

        // The id always resolves, even while the name does not.
        const list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        const first = list.find((entry) => entry.name === 'dup');
        const byID = await kelpi.run(['workspace', 'delete', first?.id ?? '', '--json']);
        expect(byID.code).toBe(0);
        expect((JSON.parse(byID.stdout) as DeleteRecord[])[0]?.workspace_id).toBe(first?.id);
    }, 60_000);
});

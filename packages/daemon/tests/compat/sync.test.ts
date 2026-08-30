/**
 * `kelpi pane sync` — tmux-style synchronise-input, driven by the real CLI.
 *
 * Two contract details this pins down:
 *   - the reply reflects **post-mutation** state (a PLAN.md "deliberate fix" over the Swift
 *     app, which answered `sync on` with the pre-toggle snapshot);
 *   - the group is only "active" with ≥ 2 eligible shell panes, and every on/off/toggle
 *     transition clears the exclusion set — so `exclude` must run after `on`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startCompatDaemon, swiftCLIAvailable, type CompatDaemon } from './harness.js';

interface SyncReply {
    readonly active: boolean;
    readonly synced_pane_ids: readonly string[];
    readonly excluded: readonly { readonly id: string; readonly label?: string }[];
    readonly workspace_id: string;
    readonly workspace_name: string;
}

describe.skipIf(!swiftCLIAvailable())('compat: kelpi pane sync', () => {
    let kelpi: CompatDaemon;

    beforeEach(async () => {
        kelpi = await startCompatDaemon();
    }, 60_000);

    afterEach(async () => {
        await kelpi?.stop();
    });

    const sync = (args: readonly string[]): Promise<SyncReply> =>
        kelpi.json<SyncReply>(['pane', 'sync', ...args, '--workspace', 'alpha', '--json']);

    it('toggles a workspace-wide group and honours exclusions', async () => {
        await kelpi.json(['workspace', 'create', '--name', 'alpha', '--json']);
        const first = await kelpi.json<{ pane_id: string }>([
            'pane', 'create', '--workspace', 'alpha', '--name', 'w1', '--json'
        ]);
        const second = await kelpi.json<{ pane_id: string }>([
            'pane', 'create', '--workspace', 'alpha', '--name', 'w2', '--json'
        ]);

        const off = await sync(['status']);
        expect(off.active).toBe(false);
        expect(off.workspace_name).toBe('alpha');

        const on = await sync(['on']);
        expect(on.active).toBe(true);
        // Three shell panes qualify (the workspace's own first pane plus the two we made).
        expect(on.synced_pane_ids).toHaveLength(3);
        expect(on.synced_pane_ids).toContain(first.pane_id);
        expect(on.synced_pane_ids).toContain(second.pane_id);
        expect(on.excluded).toEqual([]);

        const excluded = await kelpi.json<SyncReply>([
            'pane', 'sync', 'exclude', '--target', first.pane_id, '--workspace', 'alpha', '--json'
        ]);
        expect(excluded.excluded).toEqual([{ id: first.pane_id, label: 'w1' }]);
        expect(excluded.synced_pane_ids).not.toContain(first.pane_id);
        expect(excluded.synced_pane_ids).toHaveLength(2);
        // A read-only status agrees with the mutation's own reply.
        expect(await sync(['status'])).toEqual(excluded);

        const included = await kelpi.json<SyncReply>([
            'pane', 'sync', 'include', '--target', first.pane_id, '--workspace', 'alpha', '--json'
        ]);
        expect(included.excluded).toEqual([]);
        expect(included.synced_pane_ids).toHaveLength(3);

        // Every transition clears exclusions — this is why `exclude` must follow `on`.
        await kelpi.json(['pane', 'sync', 'exclude', '--target', second.pane_id, '--workspace', 'alpha', '--json']);
        const toggledOff = await sync(['toggle']);
        expect(toggledOff.active).toBe(false);
        expect(toggledOff.excluded).toEqual([]);

        const back = await sync(['toggle']);
        expect(back.active).toBe(true);
        expect(back.excluded).toEqual([]);
        expect(back.synced_pane_ids).toHaveLength(3);

        expect((await sync(['off'])).active).toBe(false);
    }, 60_000);

    it('never "syncs" a lone pane to itself', async () => {
        await kelpi.json(['workspace', 'create', '--name', 'alpha', '--json']);
        const on = await sync(['on']);
        // `active` is the workspace toggle, so it flips — but the computed broadcast group
        // stays empty: a lone terminal never syncs to itself (socket-handlers.md §4.13).
        expect(on.active).toBe(true);
        expect(on.synced_pane_ids).toEqual([]);
    }, 60_000);
});

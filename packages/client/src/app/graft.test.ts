/**
 * Graft's effect half: the toggle's three meanings, the alreadyActive branches, the swap's two
 * distinct failures, and the orphan flows. Driven through `createGraftController` against a
 * scripted command surface, so every branch is reachable without rendering anything.
 */

import { describe, expect, it } from 'vitest';

import { createGraftController, type GraftCommands, type GraftController } from './graft';
import {
    EMPTY_GRAFT_STATE,
    graftReducer,
    type GraftAction,
    type GraftState,
    type GraftSwapPrompt
} from '../state/graft';
import type { CommandReply } from '../connection';

const A1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const A2 = 'CCCCCCCC-0000-4000-8000-000000000002';

const TARGET = { id: A1, worktreePath: '/work/wt', branch: 'feature' };

interface Script {
    start?: (input: { associationID: string }) => CommandReply | Promise<CommandReply>;
    stop?: (input: { associationID: string }) => CommandReply | Promise<CommandReply>;
    list?: () => CommandReply | Promise<CommandReply>;
    recover?: (input: { associationID: string }) => CommandReply | Promise<CommandReply>;
    dismiss?: (input: { associationID: string }) => CommandReply | Promise<CommandReply>;
}

interface Harness {
    readonly controller: GraftController;
    state(): GraftState;
    readonly actions: GraftAction[];
    readonly calls: string[];
}

function harness(script: Script = {}, initial: GraftState = EMPTY_GRAFT_STATE): Harness {
    let state = initial;
    const actions: GraftAction[] = [];
    const calls: string[] = [];
    const commands: GraftCommands = {
        async graftStart(input) {
            calls.push(`start:${input.associationID}`);
            return (await script.start?.(input)) ?? { ok: true, session: sessionEntry(input.associationID) };
        },
        async graftStop(input) {
            calls.push(`stop:${input.associationID}`);
            return (await script.stop?.(input)) ?? { ok: true };
        },
        async graftList() {
            calls.push('list');
            return (await script.list?.()) ?? { ok: true, sessions: [], orphans: [] };
        },
        async graftRecoverOrphan(input) {
            calls.push(`recover:${input.associationID}`);
            return (await script.recover?.(input)) ?? { ok: true };
        },
        async graftDismissOrphan(input) {
            calls.push(`dismiss:${input.associationID}`);
            return (await script.dismiss?.(input)) ?? { ok: true };
        }
    };
    const controller = createGraftController({
        commands,
        dispatch: (action) => {
            actions.push(action);
            state = graftReducer(state, action);
        },
        getState: () => state
    });
    return { controller, state: () => state, actions, calls };
}

function sessionEntry(id: string, overrides: CommandReply = {}): CommandReply {
    return {
        association_id: id,
        worktree_path: '/work/wt',
        parent_repo_root: '/work/repo',
        branch: 'feature',
        status: 'watching',
        ...overrides
    };
}

describe('toggle — no session (§GIT-035)', () => {
    it('places the optimistic `.starting` row BEFORE the command, then swaps in the real one', async () => {
        const h = harness();
        const pending = h.controller.toggle(TARGET);
        expect(h.state().sessions[A1]?.status).toBe('starting');
        await pending;
        expect(h.state().sessions[A1]).toMatchObject({ status: 'watching', parentRepoRoot: '/work/repo' });
        expect(h.calls).toEqual([`start:${A1}`]);
    });

    it('leaves an `.error` row carrying the daemon’s message when the start fails (§GIT-036)', async () => {
        const h = harness({ start: () => ({ ok: false, error: 'repository is busy: merge in progress' }) });
        await h.controller.toggle(TARGET);
        expect(h.state().sessions[A1]).toMatchObject({
            status: 'error',
            error: 'repository is busy: merge in progress'
        });
    });

    it('turns a transport rejection into the same visible `.error` row', async () => {
        const h = harness({
            start: () => {
                throw new Error('disconnected');
            }
        });
        await h.controller.toggle(TARGET);
        expect(h.state().sessions[A1]).toMatchObject({ status: 'error', error: 'disconnected' });
    });
});

describe('toggle — a live session', () => {
    it('stops it', async () => {
        const h = harness();
        await h.controller.toggle(TARGET);
        await h.controller.toggle(TARGET);
        expect(h.calls).toEqual([`start:${A1}`, `stop:${A1}`]);
        expect(h.state().sessions[A1]).toBeUndefined();
    });

    it('re-marks it `.error` when the stop fails rather than dropping the row (§GIT-036)', async () => {
        const h = harness({ stop: () => ({ ok: false, error: 'stash pop conflict' }) });
        await h.controller.toggle(TARGET);
        await h.controller.toggle(TARGET);
        expect(h.state().sessions[A1]).toMatchObject({ status: 'error', error: 'stash pop conflict' });
    });
});

describe('toggle — an `.error` session is a RETRY (§GIT-037)', () => {
    it('unwinds through the service first, then starts again', async () => {
        const h = harness({ start: () => ({ ok: false, error: 'boom' }) });
        await h.controller.toggle(TARGET); // → error placeholder
        const second = harness({}, h.state());
        await second.controller.toggle(TARGET);
        expect(second.calls).toEqual([`stop:${A1}`, `start:${A1}`]);
        expect(second.state().sessions[A1]?.status).toBe('watching');
    });

    it('NEVER re-starts when the unwind fails, and says why', async () => {
        const errored = harness({ start: () => ({ ok: false, error: 'boom' }) });
        await errored.controller.toggle(TARGET);

        const h = harness({ stop: () => ({ ok: false, error: 'dirty parent' }) }, errored.state());
        await h.controller.toggle(TARGET);
        expect(h.calls).toEqual([`stop:${A1}`]);
        expect(h.state().sessions[A1]?.error).toBe(
            "Couldn't unwind the previous graft: dirty parent. Resolve the repo state, then toggle to retry."
        );
    });
});

describe('alreadyActive (§GIT-038…§GIT-040)', () => {
    const refused = { ok: false, error: 'another graft is already active for /work/repo', error_kind: 'alreadyActive', parent_repo_root: '/work/repo' };

    it('prompts against an owner this client can already see (§GIT-038)', async () => {
        const seeded = harness();
        await seeded.controller.toggle({ id: A2, worktreePath: '/work/other', branch: 'other' });

        const h = harness({ start: () => refused }, seeded.state());
        await h.controller.toggle(TARGET);
        expect(h.calls).toEqual([`start:${A1}`]); // no service lookup needed
        expect(h.state().swapPrompt).toMatchObject({
            associationID: A1,
            newBranch: 'feature',
            existingSessionID: A2,
            parentRepoRoot: '/work/repo'
        });
        // The optimistic row is gone: the user has a choice to make, not a running graft.
        expect(h.state().sessions[A1]).toBeUndefined();
    });

    it('asks the SERVICE who owns the root when the mirror cannot see one (§GIT-039)', async () => {
        const h = harness({
            start: () => refused,
            list: () => ({ ok: true, sessions: [sessionEntry(A2, { branch: 'other', worktree_path: '/work/other' })] })
        });
        await h.controller.toggle(TARGET);
        expect(h.calls).toEqual([`start:${A1}`, 'list']);
        expect(h.state().swapPrompt).toMatchObject({ existingSessionID: A2, existingBranch: 'other' });
        // The service's session is re-adopted so the prompt's "existing" side is visible.
        expect(h.state().sessions[A2]).toMatchObject({ status: 'watching' });
    });

    it('surfaces an error when NOBODY owns the contested root (§GIT-039)', async () => {
        const h = harness({ start: () => refused, list: () => ({ ok: true, sessions: [] }) });
        await h.controller.toggle(TARGET);
        expect(h.state().swapPrompt).toBeNull();
        expect(h.state().sessions[A1]?.error).toBe(
            'Another graft is already active for /work/repo. Stop it first, then retry.'
        );
    });

    it('re-adopts silently when the owner IS this association — no swapping with itself (§GIT-040)', async () => {
        const h = harness({
            start: () => refused,
            list: () => ({ ok: true, sessions: [sessionEntry(A1)] })
        });
        await h.controller.toggle(TARGET);
        expect(h.state().swapPrompt).toBeNull();
        expect(h.state().sessions[A1]).toMatchObject({ status: 'watching' });
    });
});

describe('the swap (§GIT-041, §GIT-042)', () => {
    const prompt: GraftSwapPrompt = {
        associationID: A1,
        newBranch: 'feature',
        newWorktreePath: '/work/wt',
        existingSessionID: A2,
        existingBranch: 'other',
        existingWorktreePath: '/work/other',
        parentRepoRoot: '/work/repo'
    };

    it('stops the existing session and starts the new one, in that order', async () => {
        const h = harness();
        await h.controller.confirmSwap(prompt);
        expect(h.calls).toEqual([`stop:${A2}`, `start:${A1}`]);
        expect(h.state().swapPrompt).toBeNull();
        expect(h.state().sessions[A1]?.status).toBe('watching');
    });

    it('says the EXISTING graft survived when the stop fails', async () => {
        const h = harness({ stop: () => ({ ok: false, error: 'locked' }) });
        await h.controller.confirmSwap(prompt);
        expect(h.calls).toEqual([`stop:${A2}`]);
        expect(h.state().sessions[A1]?.error).toBe(
            "Couldn't stop the existing graft: locked. The existing graft is still active; the new one was not started."
        );
    });

    it('says BOTH sides are gone when the stop worked and the start did not', async () => {
        const h = harness({ start: () => ({ ok: false, error: 'dirty worktree' }) });
        await h.controller.confirmSwap(prompt);
        expect(h.state().sessions[A1]?.error).toBe(
            'Existing graft was stopped, but the new graft failed to start: dirty worktree. Toggle the icon again to retry.'
        );
    });

    it('cancelling clears the prompt and touches nothing (§GIT-042)', () => {
        const h = harness({}, { ...EMPTY_GRAFT_STATE, swapPrompt: prompt });
        h.controller.cancelSwap();
        expect(h.state().swapPrompt).toBeNull();
        expect(h.calls).toEqual([]);
    });
});

describe('orphans (§GIT-045)', () => {
    const orphan = {
        associationID: A1,
        parentRepoRoot: '/work/repo',
        worktreePath: '/work/wt',
        branch: 'feature'
    };
    const seeded: GraftState = { ...EMPTY_GRAFT_STATE, orphans: [orphan] };

    it('removes the banner optimistically and keeps it removed on success', async () => {
        const h = harness({}, seeded);
        await h.controller.recoverOrphan(orphan);
        expect(h.calls).toEqual([`recover:${A1}`]);
        expect(h.state().orphans).toEqual([]);
    });

    it('puts the banner BACK when recovery fails — the breadcrumb is still on disk', async () => {
        const h = harness({ recover: () => ({ ok: false, error: 'CONFLICT (content)' }) }, seeded);
        await h.controller.recoverOrphan(orphan);
        expect(h.state().orphans).toEqual([orphan]);
    });

    it('dismiss drops the row and does not resurrect it on a transport failure', async () => {
        const h = harness(
            {
                dismiss: () => {
                    throw new Error('disconnected');
                }
            },
            seeded
        );
        await h.controller.dismissOrphan(orphan);
        expect(h.state().orphans).toEqual([]);
    });
});

describe('sync', () => {
    it('seeds both halves from `graft-session-list`', async () => {
        const h = harness({
            list: () => ({
                ok: true,
                sessions: [sessionEntry(A1)],
                orphans: [{ association_id: A2, parent_repo_root: '/work/repo', worktree_path: '/work/other' }]
            })
        });
        await h.controller.sync();
        expect(h.state().sessions[A1]?.status).toBe('watching');
        expect(h.state().orphans).toHaveLength(1);
    });

    it('leaves state alone when the daemon refuses or the socket is down', async () => {
        const refused = harness({ list: () => ({ ok: false, error: 'graft is not available' }) });
        await refused.controller.sync();
        expect(refused.actions).toEqual([]);

        const offline = harness({
            list: () => {
                throw new Error('disconnected');
            }
        });
        await offline.controller.sync();
        expect(offline.actions).toEqual([]);
    });
});

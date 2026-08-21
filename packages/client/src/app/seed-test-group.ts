/**
 * Debug ▸ Seed Test Group (§APP-028, §SET-194).
 *
 * The shipped app's one development affordance: a `#if DEBUG` menu whose reducer appends a gray
 * "Test Group" holding two gray workspaces, "Test Monitor 1" and "Test Monitor 2", each with its
 * default pane and a live surface (`Nex/AppReducer.swift:2038-2080`, reached from
 * `Nex/Commands/NexCommands.swift:71-77`). It exists so a sidebar, a group or a layout change can
 * be looked at against more than one Default row.
 *
 * ## Why this is composed out of ordinary verbs
 *
 * The Swift builds the fixture by mutating reducer state directly: it appends two
 * `WorkspaceFeature.State`s (whose initialiser mints one pane, so each workspace arrives with a
 * pane and a `.leaf` layout), a `WorkspaceGroup` with `childOrder: [ws1, ws2]`, pushes the group
 * onto `topLevelOrder`, then spawns a surface per pane and persists.
 *
 * There is no equivalent move here and there should not be one: state lives in the daemon, and a
 * seeding *wire verb* would be a port-only command in a protocol this checklist scores against
 * 0.32.0. `group-create` + two `workspace-create`s produce exactly the same end state — a group
 * at the end of the sidebar order holding two gray workspaces in creation order, each with the
 * one pane and live PTY every new workspace gets, all of it persisted by the handlers that
 * already do that — and every one of those verbs already exists and is already exercised.
 *
 * Two properties are worth stating because they are not free:
 *
 *  - **Order matters.** The workspaces are created one after the other, `await`ed, so the group's
 *    `childOrder` is `[Test Monitor 1, Test Monitor 2]` rather than whichever reply came back
 *    first. `Promise.all` here would be a race that is right most of the time.
 *  - **It does not steal the view.** The Swift seed never touches `activeWorkspaceID`; the user
 *    stays where they were and the group simply appears. So this deliberately does NOT go through
 *    `App.tsx`'s `runCreateWorkspace`, which activates and reveals what it creates — it calls the
 *    command client directly. That is only half of it: the DAEMON also reveals every workspace it
 *    creates (`handlers/app/workspaces.ts` ▸ `revealCreatedWorkspace`), which no caller can opt
 *    out of, so the call site in `App.tsx` puts the view back afterwards — guarded on the user
 *    still standing on one of the workspaces this seed made. The two halves together are what
 *    reproduce the Swift's end state; the audit's `debug-menu` step is where that is checked on
 *    a real window rather than asserted here.
 *
 * Everything here is pure over an injected `SeedCommands`, so the whole sequence — including the
 * failure paths — is testable without a window or a daemon.
 */

/** A command reply, in the shape `connection/commands.ts` produces. */
export type SeedReply = Record<string, unknown>;

/** The verbs the seed needs, narrowed so a test can hand it plain functions. */
export interface SeedCommands {
    createGroup(input: { name: string; color?: 'gray' }): Promise<SeedReply>;
    createWorkspace(input: { name: string; color?: 'gray'; group?: string }): Promise<SeedReply>;
    /**
     * Optional, and only ever called when the create's ack carried no `group_id` — which is the
     * REAL daemon's behaviour today: `group-create` is a fire-and-forget wire verb and
     * `ws/sync.ts` settles it with a bare `{ok:true}`.
     *
     * Without it the group could only be addressed by name, and a second seed in the same
     * session would then hit "ambiguous group" instead of building a second fixture the way the
     * Swift does (its seed appends a group per invocation, duplicate names and all).
     */
    listGroups?: (() => Promise<SeedReply>) | undefined;
}

export interface SeedTestGroupDeps {
    readonly commands: SeedCommands;
    /** Reported the same way every other failed verb in `App.tsx` is. */
    readonly onFailure?: ((title: string, message: string) => void) | undefined;
    /**
     * Called with each workspace id the instant its create is acknowledged — before the daemon's
     * own `reveal-pane` for it can be processed, and that ordering is a guarantee rather than a
     * hope: the handler replies first and broadcasts the reveal afterwards
     * (`handlers/app/workspaces.ts` ▸ `handleWorkspaceCreate` → `dispatchCreate`), and this
     * callback runs in the reply's own microtask while the broadcast is a later socket event.
     *
     * `App.tsx` uses it to suppress exactly those reveals, which is how the seed keeps the
     * Swift's "the group appears, the user does not move" behaviour.
     */
    readonly onWorkspaceCreated?: ((workspaceID: string) => void) | undefined;
}

/**
 * The `menu-command` the shell's Debug row relays. It must equal `SEED_TEST_GROUP_COMMAND` in
 * `shell/src/menu.ts` — the two packages do not share a module for menu command names (nor does
 * `toggle-sidebar`), so the string is stated in both places and asserted in both test suites.
 */
export const SEED_TEST_GROUP_COMMAND = 'seed-test-group';

/** The fixture's names and colour, matching `AppReducer.seedTestGroup` exactly. */
export const TEST_GROUP_NAME = 'Test Group';
export const TEST_WORKSPACE_NAMES = ['Test Monitor 1', 'Test Monitor 2'] as const;
export const TEST_FIXTURE_COLOR = 'gray';

export interface SeedTestGroupResult {
    readonly ok: boolean;
    /** The created group's id, when the group verb answered with one. */
    readonly groupID?: string | undefined;
    /** The created workspaces' ids, in creation order. */
    readonly workspaceIDs: readonly string[];
    /** Present when `ok` is false: what went wrong, already human-readable. */
    readonly error?: string | undefined;
}

// ── one-shot reveal suppression ─────────────────────────────────────────────────────

/**
 * How long a seeded workspace's own `reveal-pane` stays ignorable.
 *
 * Bounded rather than open-ended on purpose: if the reveal never arrives (an older daemon that
 * does not broadcast one), an unbounded entry would silently swallow a *legitimate* reveal of
 * that same workspace an hour later. Ten seconds is far longer than the gap between a reply and
 * the broadcast that follows it, and far shorter than anything a user would notice.
 */
export const REVEAL_SUPPRESSION_MS = 10_000;

/** Mark one workspace's next reveal as "this window asked for it, do not act on it". */
export function suppressReveal(pending: Map<string, number>, workspaceID: string, now = Date.now()): void {
    pending.set(workspaceID, now + REVEAL_SUPPRESSION_MS);
}

/**
 * Should this reveal be ignored? One shot: a suppressed id is consumed by the first reveal that
 * matches it, so a second reveal of the same workspace (a notification click, say) is honoured.
 * Expired entries are dropped rather than obeyed.
 */
export function consumeSuppressedReveal(
    pending: Map<string, number>,
    workspaceID: string,
    now = Date.now()
): boolean {
    for (const [id, deadline] of pending) {
        if (deadline <= now) pending.delete(id);
    }
    const deadline = pending.get(workspaceID);
    if (deadline === undefined) return false;
    pending.delete(workspaceID);
    return deadline > now;
}

function ok(reply: SeedReply): boolean {
    return reply['ok'] === true;
}

function errorOf(reply: SeedReply): string {
    const error = reply['error'];
    return typeof error === 'string' && error.length > 0 ? error : 'command failed';
}

function idOf(reply: SeedReply, key: string): string | undefined {
    const value = reply[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The id of the group we just made, read back from `group-list`.
 *
 * The LAST match wins: `group-list` answers in sidebar order and a new group is appended, so on
 * a second seed the newest "Test Group" is the one the monitors belong in. A failed or
 * unavailable listing is not an error — the caller falls back to addressing the group by name,
 * which is right whenever there is only one.
 */
async function resolveGroupID(deps: SeedTestGroupDeps): Promise<string | undefined> {
    const list = deps.commands.listGroups;
    if (list === undefined) return undefined;
    let reply: SeedReply;
    try {
        reply = await list();
    } catch {
        return undefined;
    }
    if (!ok(reply)) return undefined;
    const groups = reply['groups'];
    if (!Array.isArray(groups)) return undefined;
    let found: string | undefined;
    for (const entry of groups) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        if (record['name'] !== TEST_GROUP_NAME) continue;
        const id = record['id'];
        if (typeof id === 'string' && id.length > 0) found = id;
    }
    return found;
}

/**
 * Create the fixture. Resolves with what was made; never throws — a dev menu item that could
 * take the renderer down with it would be worse than one that does nothing.
 *
 * A failed `group-create` stops the sequence: two loose "Test Monitor" workspaces at top level
 * are not the fixture, and they would have to be cleaned up by hand. A failed *workspace* create
 * is reported but does not roll the group back, matching what the rest of the client does with a
 * half-finished multi-verb gesture (say what failed; leave what succeeded).
 */
export async function seedTestGroup(deps: SeedTestGroupDeps): Promise<SeedTestGroupResult> {
    const fail = (message: string): SeedTestGroupResult => {
        deps.onFailure?.('Seed Test Group', message);
        return { ok: false, workspaceIDs: [], error: message };
    };

    let groupReply: SeedReply;
    try {
        groupReply = await deps.commands.createGroup({ name: TEST_GROUP_NAME, color: TEST_FIXTURE_COLOR });
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
    if (!ok(groupReply)) return fail(errorOf(groupReply));

    const groupID = idOf(groupReply, 'group_id') ?? (await resolveGroupID(deps));
    const workspaceIDs: string[] = [];
    let error: string | undefined;
    for (const name of TEST_WORKSPACE_NAMES) {
        try {
            const reply = await deps.commands.createWorkspace({
                name,
                color: TEST_FIXTURE_COLOR,
                // The group is addressed by id when we have one and by name otherwise — the
                // daemon's own `resolveGroup` accepts either, and a reply without `group_id` is
                // still a group that exists.
                ...(groupID === undefined ? { group: TEST_GROUP_NAME } : { group: groupID })
            });
            if (!ok(reply)) {
                error = errorOf(reply);
                deps.onFailure?.('Seed Test Group', `${name}: ${error}`);
                continue;
            }
            const id = idOf(reply, 'workspace_id');
            if (id !== undefined) {
                workspaceIDs.push(id);
                deps.onWorkspaceCreated?.(id);
            }
        } catch (thrown) {
            error = thrown instanceof Error ? thrown.message : String(thrown);
            deps.onFailure?.('Seed Test Group', `${name}: ${error}`);
        }
    }

    return {
        ok: error === undefined,
        ...(groupID === undefined ? {} : { groupID }),
        workspaceIDs,
        ...(error === undefined ? {} : { error })
    };
}

/**
 * Issues #307 and #298: the agent-facing commands #295 missed run in the BACKGROUND too.
 *
 * `kelpi workspace create` used to switch every window to the new workspace, so a coordinator
 * spawning workers pulled the user's view and keyboard away mid-sentence. `kelpi diff`, `pane
 * move-to-workspace` and a blank `web tab-new` took the focus as well. This is the sibling of
 * `background-panes-keep-the-keyboard.mjs`, with the same shape: the user is mid-line in a
 * terminal, an agent pane runs each command through the sandbox CLI, and afterwards:
 *
 *   - the window is still on the user's workspace (its sidebar row is the active one) and
 *     `workspace list` still calls it ACTIVE;
 *   - the daemon's focused pane, the ring and the DOM caret are still the user's terminal;
 *   - the rest of the line, typed after the command, lands in the user's terminal.
 *
 * A created workspace shows in the sidebar, inside its group, wearing the "just created"
 * highlight. Then the opt-ins: moving the pane the user is typing in follows it (the keystrokes
 * stay in its PTY), `workspace create --focus` switches, and the New Workspace sheet (the user's
 * own gesture) still switches.
 *
 * No pixel is measured: every assertion is DOM state, the CLI, or a keystroke reaching a real
 * PTY. The screenshots are evidence for the PR, not checks.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The source this presses (the scenario rule; ui-audit/README.md). */
export const covers = [
    'packages/daemon/src/handlers/app/workspaces.ts',
    'packages/daemon/src/store/reducers/workspaces.ts',
    'packages/daemon/src/handlers/app/files.ts',
    'packages/daemon/src/handlers/pane/geometry.ts',
    'packages/daemon/src/store/reducers/panes.ts',
    'packages/daemon/src/webpane/handlers.ts',
    'packages/client/src/app/new-workspace-cue.ts',
    'packages/client/src/chrome/Sidebar.tsx',
    'packages/client/src/webpane/hooks.ts',
    'packages/client/src/connection/commands.ts',
    'packages/client/src/features/workspaces-actions.ts',
    'packages/cli/src/commands/workspace.ts',
    'packages/cli/src/commands/openmd.ts',
    'packages/cli/src/commands/pane.ts',
    'packages/cli/src/commands/web.ts'
];

/** ⌘N and the sheet need CDP input to reach the window (see `placement.mjs`). */
export const windowPlacement = 'offscreen';

const GROUP = 'Bg307 Team';
const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'kelpi-scenario',
    GIT_AUTHOR_EMAIL: 'scenario@example.com',
    GIT_COMMITTER_NAME: 'kelpi-scenario',
    GIT_COMMITTER_EMAIL: 'scenario@example.com'
};

/** The pane whose SURFACE holds the caret, or '' when the caret is not in a pane at all. */
const CARET_PANE = `(() => {
    const a = document.activeElement;
    if (a === null) return '';
    const pane = a.closest('[data-pane-id]');
    return pane === null ? '' : (pane.getAttribute('data-pane-id') ?? '');
})()`;

/** The pane wearing the focus ring. */
const RINGED_PANE = `(() => {
    const el = document.querySelector('[data-pane-id][data-focused="true"]');
    return el === null ? '' : (el.getAttribute('data-pane-id') ?? '');
})()`;

/** The workspace whose sidebar row is the active one: what the window is showing. */
const ACTIVE_ROW = `(() => {
    const el = document.querySelector('[data-testid="workspace-row"][data-active="true"]');
    return el === null ? '' : (el.getAttribute('data-workspace-id') ?? '');
})()`;

const rowOf = (workspaceID) => `document.querySelector('[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]')`;
const paneInDom = (paneID) => `document.querySelector('[data-pane-id="${paneID}"]') !== null`;

export default async function ({ page, cli, rec, d, sleep, sandbox }) {
    if (sandbox === undefined || sandbox === null) {
        rec.check('this scenario boots its own sandbox (it makes a git repo and drives the CLI)', false, 'run without --attach');
        return;
    }
    const listed = async () => JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const activeInList = async () => (await listed()).find((workspace) => workspace.is_active)?.id ?? '';
    const panesOf = async (workspace) => JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspace, '--json']));
    const daemonFocus = async (workspace) => (await panesOf(workspace)).find((pane) => pane.is_focused)?.id ?? '';

    const typeText = async (text) => {
        await page.type(text);
        await sleep(150);
    };
    /** Did `marker` arrive on its own line in this pane's screen (i.e. `echo` ran there)? */
    const landedIn = async (paneID, marker) => {
        let capture = '';
        const ok = await d.settle(
            async () => {
                capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                return capture.split('\n').some((line) => line.trim() === marker);
            },
            { ceilingMs: 8_000, intervalMs: 300 }
        );
        return { ok, tail: capture.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' | ') };
    };

    // A repository for the worktree create: one commit, no origin, so no update-main fetch.
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'bg307-repo-')));
    const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
    git('init', '-q', '--initial-branch=main');
    fs.writeFileSync(path.join(repo, 'README.md'), '# bg307\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(repo, 'README.md'), '# bg307\n\nchanged, so the diff has something to show\n');

    const created = [];
    const userName = 'Background307';
    try {
        // The user's own workspace, which they asked for: --focus takes the window there.
        const own = JSON.parse(await cli.ok(['workspace', 'create', '--name', userName, '--focus', '--json']));
        const userWS = own.workspace_id ?? own.id;
        created.push(userWS);
        await cli.ok(['group', 'create', GROUP]);
        await d.settleDom(page, `${rowOf(userWS)}?.getAttribute('data-active') === 'true'`, { ceilingMs: 10_000 });
        const user = (await panesOf(userName))[0]?.id;
        rec.check('the user\'s workspace is on screen with its first terminal', typeof user === 'string' && (await page.eval(ACTIVE_ROW)) === userWS);
        if (typeof user !== 'string') return;

        const agent = JSON.parse(await cli.ok(['pane', 'split', '--workspace', userName, '--name', 'agent', '--json'])).pane_id;
        await d.settleDom(page, paneInDom(agent), { ceilingMs: 10_000 });
        await d.settleDom(page, `document.querySelectorAll('[data-pane-id="${user}"] [data-pane-surface] textarea').length > 0`, { ceilingMs: 30_000 });
        await page.click(`[data-pane-id="${user}"] [data-pane-surface]`);
        await d.settle(async () => (await page.eval(CARET_PANE)) === user, { ceilingMs: 8_000 });
        rec.check(
            'precondition: the user\'s terminal has the ring, the caret and the daemon\'s focus, and its workspace is ACTIVE',
            (await page.eval(RINGED_PANE)) === user && (await page.eval(CARET_PANE)) === user && (await daemonFocus(userName)) === user && (await activeInList()) === userWS,
            `ring ${String(await page.eval(RINGED_PANE))}, caret ${String(await page.eval(CARET_PANE))}, daemon ${await daemonFocus(userName)}, active ${await activeInList()}`
        );

        /**
         * One agent command while the user is mid-command. `workspace` names the workspace it
         * should create (so the scenario can check the sidebar), `newPane` asks for the pane it
         * added to the user's workspace.
         */
        const midTyping = async (label, marker, args, { from = agent, shot, workspace, group, newPane = false, timeoutMs } = {}) => {
            const before = new Set((await panesOf(userName)).map((pane) => pane.id));
            await typeText(`echo ${marker.slice(0, 4)}`);
            const result = await cli.run(args, { paneID: from, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
            rec.check(`${label}: the CLI call succeeded`, result.code === 0, `${args.join(' ')} -> ${String(result.code)} ${result.stderr}`);

            let made;
            if (workspace !== undefined) {
                await d.settle(
                    async () => {
                        made = (await listed()).find((entry) => entry.name === workspace);
                        return made !== undefined;
                    },
                    { ceilingMs: 30_000, intervalMs: 300 }
                );
                if (made !== undefined) created.push(made.id);
                const shown = made !== undefined && (await d.settleDom(page, `${rowOf(made.id)} !== null`, { ceilingMs: 10_000 }));
                const highlighted = shown && (await d.settleDom(page, `${rowOf(made.id)}?.getAttribute('data-just-created') === 'true'`, { ceilingMs: 3_000 }));
                rec.check(`${label}: the new workspace shows in the sidebar, wearing the "just created" highlight`, shown && highlighted, JSON.stringify(made ?? null));
                if (group !== undefined && made !== undefined) {
                    rec.check(`${label}: its row is inside ${group}`, made.group_name === group && String(await page.eval(`${rowOf(made.id)}?.getAttribute('data-group-id') ?? ''`)).toUpperCase() === String(made.group_id).toUpperCase(), JSON.stringify(made));
                }
                if (shot !== undefined) await rec.shot(page, `${shot}-highlight`);
            }
            let added = '';
            if (newPane) {
                await d.settle(
                    async () => {
                        added = (await panesOf(userName)).map((pane) => pane.id).find((id) => !before.has(id)) ?? '';
                        return added !== '';
                    },
                    { ceilingMs: 8_000, intervalMs: 200 }
                );
                rec.check(`${label}: a new pane joined the user's workspace`, added !== '' && (await d.settleDom(page, paneInDom(added), { ceilingMs: 10_000 })));
                await cli.run(['layout', 'select', 'tiled'], { paneID: user });
            }
            // Past every mount-time handoff (1.5 s) before asking who has the keyboard.
            await sleep(1_800);
            if (shot !== undefined) await rec.shot(page, shot);
            const activeRow = await page.eval(ACTIVE_ROW);
            const active = await activeInList();
            rec.check(
                `${label}: the window stays on the user's workspace, and workspace list still calls it ACTIVE`,
                activeRow === userWS && active === userWS,
                `active row ${String(activeRow)}, ACTIVE ${active}, user ${userWS}`
            );
            const focus = await daemonFocus(userName);
            const ring = await page.eval(RINGED_PANE);
            const caret = await page.eval(CARET_PANE);
            rec.check(
                `${label}: the daemon's focus, the ring and the caret all stay on the user's terminal`,
                focus === user && ring === user && caret === user,
                `daemon ${focus}, ring ${String(ring)}, caret ${String(caret)}, user ${user}`
            );
            await typeText(marker.slice(4));
            await page.key('Enter');
            const typed = await landedIn(user, marker);
            rec.check(`${label}: the rest of what the user typed landed in their own terminal`, typed.ok, `capture tail: ${typed.tail}`);
            return { made, added };
        };

        // ── #307: workspace create, three ways ────────────────────────────────────────────
        await midTyping('workspace create', 'bgws1', ['workspace', 'create', '--name', 'bg-worker-1'], {
            workspace: 'bg-worker-1',
            shot: 'background-workspace-create'
        });
        await midTyping('workspace create --group', 'bgws2', ['workspace', 'create', '--name', 'bg-worker-2', '--group', GROUP], {
            workspace: 'bg-worker-2',
            group: GROUP,
            shot: 'background-workspace-create-in-group'
        });
        await midTyping(
            'workspace create --worktree --group',
            'bgws3',
            ['workspace', 'create', '--name', 'bg-wt', '--worktree', 'bg-wt', '--repo', repo, '--group', GROUP],
            { workspace: 'bg-wt', group: GROUP, timeoutMs: 120_000, shot: 'background-workspace-create-worktree' }
        );

        // ── #298: diff, a blank tab, move-to-workspace ───────────────────────────────────
        const { added: diffPane } = await midTyping('diff', 'bgdf4', ['diff'], { newPane: true, shot: 'background-diff' });
        // A diff from the repo itself, so it has a change to show (the CLI diffs its cwd).
        await cli.run(['diff'], { paneID: agent, cwd: repo });

        const { added: webPane } = await midTyping('web open about:blank', 'bgwo5', ['web', 'open', 'about:blank'], { newPane: true });
        if (webPane !== '') {
            await midTyping('web tab-new (blank) in a web pane the user is not in', 'bgtb6', ['web', 'tab-new', '--target', webPane], {
                shot: 'background-blank-tab'
            });
        }

        if (diffPane !== '') {
            await midTyping('pane move-to-workspace (an agent pane, elsewhere)', 'bgmv7', ['pane', 'move-to-workspace', '--to-workspace', 'bg-worker-1'], {
                from: diffPane,
                shot: 'background-move-to-workspace'
            });
            const moved = (await panesOf('bg-worker-1')).some((pane) => pane.id === diffPane);
            rec.check('pane move-to-workspace: the pane really moved', moved && !(await panesOf(userName)).some((pane) => pane.id === diffPane));
        }

        // ── the pane the user is typing in follows when it is moved ───────────────────────
        await typeText('echo self');
        const selfMove = await cli.run(['pane', 'move-to-workspace', '--to-workspace', 'bg-worker-2'], { paneID: user });
        rec.check('self move: the CLI call succeeded', selfMove.code === 0, selfMove.stderr);
        const bgWorker2 = (await listed()).find((entry) => entry.name === 'bg-worker-2')?.id ?? '';
        await d.settle(async () => (await page.eval(ACTIVE_ROW)) === bgWorker2, { ceilingMs: 8_000 });
        await d.settle(async () => (await page.eval(CARET_PANE)) === user, { ceilingMs: 8_000 });
        await sleep(1_000);
        await rec.shot(page, 'self-move-follows-the-pane');
        rec.check(
            'self move: the window follows the user\'s pane to its new workspace, with the caret still in it',
            (await page.eval(ACTIVE_ROW)) === bgWorker2 && (await activeInList()) === bgWorker2 && (await page.eval(CARET_PANE)) === user,
            `active row ${String(await page.eval(ACTIVE_ROW))}, ACTIVE ${await activeInList()}, caret ${String(await page.eval(CARET_PANE))}`
        );
        await typeText('move8');
        await page.key('Enter');
        const selfTyped = await landedIn(user, 'selfmove8');
        rec.check('self move: the rest of the line landed in the same terminal', selfTyped.ok, `capture tail: ${selfTyped.tail}`);

        // ── the opt-in: --focus switches ──────────────────────────────────────────────────
        const focused = JSON.parse((await cli.run(['workspace', 'create', '--name', 'bg-focused', '--focus', '--json'], { paneID: agent })).stdout);
        const focusedID = focused.workspace_id ?? focused.id;
        if (typeof focusedID === 'string') created.push(focusedID);
        const switched = await d.settle(async () => (await page.eval(ACTIVE_ROW)) === focusedID, { ceilingMs: 10_000 });
        await sleep(800);
        await rec.shot(page, 'focus-flag-switches');
        rec.check(
            'workspace create --focus: the window and ACTIVE switch to the new workspace',
            switched && (await activeInList()) === focusedID,
            `active row ${String(await page.eval(ACTIVE_ROW))}, ACTIVE ${await activeInList()}, new ${String(focusedID)}`
        );

        // ── the user's own gesture: ⌘N and the New Workspace sheet still switch ────────────
        const idsBeforeSheet = new Set((await listed()).map((entry) => entry.id));
        await page.key('KeyN', { modifiers: d.MOD.meta, key: 'n' });
        const sheet = await d.settleDom(page, `document.querySelector('[data-testid="new-workspace-sheet"]') !== null`, { ceilingMs: 5_000 });
        rec.check('⌘N opens the New Workspace sheet', sheet);
        if (sheet) {
            // Past the sheet's entry animation, or the click can land where Create is going to be.
            await sleep(1_000);
            await page.click('[data-testid="new-workspace-form"] input[aria-label="New workspace name"]');
            await page.insertText('bg-sheet');
            await sleep(200);
            await page.click('[data-testid="new-workspace-submit"]');
            const closedSheet = `document.querySelector('[data-testid="new-workspace-sheet"]') === null`;
            if (!(await d.settleDom(page, closedSheet, { ceilingMs: 3_000 }))) {
                // The click did not land (a pane's caret handoff can still be settling from the
                // previous switch). Submit the sheet's own form instead: the same onSubmit, the
                // same create the gesture sends.
                rec.note(`the Create click did not submit (${String(await page.eval(`document.querySelector('[data-testid="new-workspace-error"]')?.innerText ?? 'no error shown'`))}); submitting the form`);
                await page.eval(`document.querySelector('[data-testid="new-workspace-form"]')?.requestSubmit()`);
                await d.settleDom(page, closedSheet, { ceilingMs: 10_000 });
            }
            let sheetID = '';
            await d.settle(
                async () => {
                    // Whatever the sheet created (it prefills a name), found by id, not by name.
                    sheetID = (await listed()).find((entry) => !idsBeforeSheet.has(entry.id))?.id ?? '';
                    return sheetID !== '' && (await page.eval(ACTIVE_ROW)) === sheetID;
                },
                { ceilingMs: 10_000, intervalMs: 300 }
            );
            if (sheetID !== '') created.push(sheetID);
            await sleep(800);
            await rec.shot(page, 'sheet-gesture-switches');
            rec.check(
                'the New Workspace sheet (a gesture): the window and ACTIVE switch to what it created',
                sheetID !== '' && (await page.eval(ACTIVE_ROW)) === sheetID && (await activeInList()) === sheetID,
                `active row ${String(await page.eval(ACTIVE_ROW))}, ACTIVE ${await activeInList()}, new ${sheetID}`
            );
        }
    } finally {
        for (const id of created.reverse()) await cli.run(['workspace', 'delete', id, '--force']);
        await cli.run(['group', 'delete', GROUP]);
    }
}

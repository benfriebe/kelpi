/**
 * #285: a workspace group can have a default repository, and a switch that makes new workspaces
 * in it create a worktree off the latest main (app-state-core.md §5.5).
 *
 * Everything here is real: a bare `origin` and a clone of it under the sandbox root (so
 * `git fetch origin` has somewhere to fetch from), the group menu's Repository ▸ (its Choose
 * Folder… answered through the shell's `KELPI_AUDIT_CHOOSE_FOLDER` seam, exactly as
 * `repo-folder-selector` answers it), the New Workspace sheet raised from the group's own menu,
 * and git on disk. A commit lands on origin AFTER the clone, so a worktree whose HEAD is that
 * commit proves the create fetched first; the clone's own `main` is checked untouched.
 *
 * Then the same group from the CLI: `workspace create --group` defaulting the repo and update
 * main, the clear refusal of a branch that already exists, and removing the repository from the
 * registry clearing the group's repo.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The source this drives, so `verify.mjs` re-runs it when any hop moves. */
export const covers = [
    'packages/client/src/chrome/Sidebar.tsx',
    'packages/client/src/chrome/NewWorkspaceSheet.tsx',
    'packages/client/src/features/workspaces.tsx',
    'packages/client/src/features/workspaces-actions.ts',
    'packages/client/src/connection/commands.ts',
    'packages/daemon/src/handlers/app/groups.ts',
    'packages/daemon/src/handlers/app/workspaces.ts',
    'packages/daemon/src/handlers/app/repos.ts',
    'packages/daemon/src/git/service.ts',
    'packages/cli/src/commands/group.ts',
    'packages/cli/src/commands/workspace.ts'
];

/** CDP input has to reach the window for the menus and the sheet (see `placement.mjs`). */
export const windowPlacement = 'offscreen';

const GROUP = 'App Team';
const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'kelpi-scenario',
    GIT_AUTHOR_EMAIL: 'scenario@example.com',
    GIT_COMMITTER_NAME: 'kelpi-scenario',
    GIT_COMMITTER_EMAIL: 'scenario@example.com'
};

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(dir, file, text, message) {
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
}

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    if (sandbox === undefined || sandbox === null || cli === undefined || cli === null) {
        rec.check('this scenario boots its own sandbox (it scripts the folder panel and drives the CLI)', false, 'run without --attach');
        return;
    }

    // ── fixtures: origin (bare), a seed clone that pushes, and the repo the group will use ────
    const root = fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'group-repo-')));
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    const repo = path.join(root, 'app');
    git(root, 'init', '-q', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', '-q', origin, seed);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const firstSha = commit(seed, 'README.md', '# app\n', 'first');
    git(seed, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', origin, repo);
    // The commit the worktree must be cut from: on origin, NOT yet in the clone.
    const latestSha = commit(seed, 'CHANGELOG.md', 'latest\n', 'latest on origin');
    git(seed, 'push', '-q', 'origin', 'main');
    rec.check(
        'fixture: origin is one commit ahead of the clone the group will use',
        git(repo, 'rev-parse', 'origin/main') === firstSha && git(origin, 'rev-parse', 'main') === latestSha,
        `clone origin/main ${git(repo, 'rev-parse', 'origin/main')}, origin main ${git(origin, 'rev-parse', 'main')}`
    );
    rec.note(`fixtures: origin ${origin}, repo ${repo}; first ${firstSha.slice(0, 8)}, latest ${latestSha.slice(0, 8)}`);

    const listed = async () => JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const groups = async () => JSON.parse(await cli.ok(['group', 'list', '--json']));
    const ourGroup = async () => (await groups()).find((group) => group.name === GROUP);
    const created = [];
    const answerFile = d.chooseFolderAnswerPath(sandbox);
    const headerSelector = '[data-testid="group-header"]';

    /** The Repository ▸ submenu of our group, opened from its header's context menu. */
    const openRepositoryMenu = async () => {
        await d.openSidebarMenu(page, headerSelector, GROUP);
        return d.openSubmenu(page, 'Repository');
    };
    const closeMenus = async () => {
        await page.key('Escape');
        await d.settleDom(page, `document.querySelector('${d.PAGE.contextMenu}') === null`, { ceilingMs: 3_000 });
    };
    const sheetState = async () =>
        JSON.parse(
            String(
                await page.eval(`JSON.stringify({
                    open: document.querySelector('[data-testid="new-workspace-sheet"]') !== null,
                    group: document.querySelector('[data-testid="new-workspace-group"]')?.value ?? null,
                    repos: Array.from(document.querySelectorAll('[data-testid^="new-workspace-repo-remove-"]')).map(el => el.getAttribute('aria-label')),
                    worktree: document.querySelector('[data-testid="new-workspace-worktree-toggle"]')?.checked ?? null,
                    updateMain: document.querySelector('[data-testid="new-workspace-worktree-update-main"]')?.checked ?? null,
                    error: document.querySelector('[data-testid="new-workspace-error"]')?.innerText ?? null
                })`)
            )
        );
    const openNewWorkspaceFromGroup = async () => {
        await d.openSidebarMenu(page, headerSelector, GROUP);
        await d.clickMenuItem(page, 'New Workspace');
        return d.settleDom(page, `document.querySelector('[data-testid="new-workspace-sheet"]') !== null`, { ceilingMs: 5_000 });
    };
    const typeInto = async (selector, text) => {
        await page.click(selector);
        await page.eval(`(() => { const el = document.querySelector('${selector}'); el?.select?.(); })()`);
        await page.insertText(text);
    };

    try {
        // ── 1 · a group, and its repository set from the group menu (Choose Folder…) ─────────
        await cli.ok(['group', 'create', GROUP]);
        rec.check('the group exists', await d.settleDom(page, `Array.from(document.querySelectorAll('${headerSelector}')).some(el => (el.innerText ?? '').includes(${JSON.stringify(GROUP)}))`, { ceilingMs: 5_000 }));

        const before = await openRepositoryMenu();
        rec.check(
            'Repository ▸ offers Choose Folder… and None (ticked), and no worktree switch while there is no repo',
            before.some((row) => row.id === 'repo:choose') &&
                before.find((row) => row.id === 'repo:none')?.checked === 'true' &&
                !before.some((row) => row.id === 'repo:worktree'),
            JSON.stringify(before)
        );
        await rec.shot(page, 'repository-menu-no-repo');
        // The header's height with no repo, to prove the indicator does not change it.
        const bareHeight = await page.eval(
            `Math.round(Array.from(document.querySelectorAll('${headerSelector}')).find(el => (el.innerText ?? '').includes(${JSON.stringify(GROUP)}))?.getBoundingClientRect().height ?? 0)`
        );
        d.scriptFolderAnswer(sandbox, repo);
        await d.clickSubmenuItem(page, 'repo:choose');
        const set = await d.settle(async () => (await ourGroup())?.repo?.path === repo, { ceilingMs: 15_000, intervalMs: 200 });
        const afterChoose = await ourGroup();
        rec.check('Choose Folder… registers the folder and makes it the group’s repository', set, JSON.stringify(afterChoose));
        rec.check('…with the worktree switch still off', afterChoose?.create_worktree === false, JSON.stringify(afterChoose));

        // The group header names its repository, with the full path as the tooltip.
        const headerIndicator = async () =>
            JSON.parse(
                String(
                    await page.eval(`(() => {
                        const head = Array.from(document.querySelectorAll('${headerSelector}')).find(el => (el.innerText ?? '').includes(${JSON.stringify(GROUP)}));
                        const box = head?.querySelector('[data-testid="group-repo"]') ?? null;
                        const r = head?.getBoundingClientRect();
                        return JSON.stringify({
                            name: box?.querySelector('[data-testid="group-repo-name"]')?.textContent ?? null,
                            title: box?.getAttribute('title') ?? null,
                            worktree: box?.querySelector('[data-testid="group-repo-worktree"]') !== null && box !== null,
                            height: r === undefined ? null : Math.round(r.height)
                        });
                    })()`)
                )
            );
        const indicatorShown = await d.settle(async () => (await headerIndicator()).name === 'app', { ceilingMs: 5_000, intervalMs: 150 });
        const plainIndicator = await headerIndicator();
        rec.check(
            'the group header shows the repo name, with its full path as the tooltip, and no worktree mark yet',
            indicatorShown && plainIndicator.title === repo && plainIndicator.worktree === false,
            JSON.stringify(plainIndicator)
        );
        await rec.shot(page, 'group-header-repo-indicator');

        // The switch appears once there is a repo; it toggles in place.
        const withRepo = await openRepositoryMenu();
        const repoRow = withRepo.find((row) => row.label === 'app');
        rec.check(
            'the registered repo is listed and ticked, and the worktree switch is now offered',
            repoRow?.checked === 'true' && withRepo.some((row) => row.id === 'repo:worktree'),
            JSON.stringify(withRepo)
        );
        await d.clickSubmenuItem(page, 'repo:worktree');
        const switched = await d.settle(async () => (await ourGroup())?.create_worktree === true, { ceilingMs: 10_000, intervalMs: 200 });
        rec.check('the switch turns on (kelpi group list --json says create_worktree: true)', switched, JSON.stringify(await ourGroup()));
        const boxOn = await d.settleDom(
            page,
            `document.querySelector('${d.PAGE.contextSubmenu} [data-menu-item="repo:worktree"]')?.getAttribute('aria-checked') === 'true'`,
            { ceilingMs: 3_000 }
        );
        rec.check('the menu stays open and its checkbox shows the new state', boxOn);
        await rec.shot(page, 'repository-menu-switch-on');
        await closeMenus();
        const switchIndicator = await headerIndicator();
        rec.check(
            'with the switch on, the header adds the worktree mark and says so in the tooltip',
            switchIndicator.worktree === true && switchIndicator.title === `${repo}\nNew workspaces create a worktree from latest main`,
            JSON.stringify(switchIndicator)
        );
        rec.check(
            'and the header is no taller than it was before it had a repo',
            typeof bareHeight === 'number' && bareHeight > 0 && switchIndicator.height === bareHeight,
            `${String(bareHeight)} → ${String(switchIndicator.height)}`
        );
        await rec.shot(page, 'group-header-repo-indicator-worktree-switch');
        const table = await cli.ok(['group', 'list']);
        rec.check('kelpi group list shows the repository with the switch', table.includes('app +worktree'), table);

        // ── 2 · New Workspace from the group's menu: the sheet is prefilled ─────────────────────
        const groupID = (await ourGroup())?.id ?? '';
        rec.check('New Workspace from the group menu opens the sheet', await openNewWorkspaceFromGroup());
        const prefilled = await sheetState();
        rec.check(
            'the sheet preselects the group, its repository, the worktree toggle and update main',
            prefilled.group?.toUpperCase() === groupID.toUpperCase() &&
                prefilled.repos.length === 1 &&
                prefilled.repos[0] === 'Remove app' &&
                prefilled.worktree === true &&
                prefilled.updateMain === true,
            JSON.stringify(prefilled)
        );
        // The worktree and branch names follow the workspace name, through the daemon's sanitizer.
        await typeInto('[aria-label="New workspace name"]', 'Fix Login Bug');
        const fieldValues = async () =>
            JSON.parse(
                String(
                    await page.eval(`JSON.stringify({
                        worktree: document.querySelector('[data-testid="new-workspace-worktree-name"]')?.value ?? null,
                        branch: document.querySelector('[data-testid="new-workspace-worktree-branch"]')?.value ?? null,
                        preview: document.querySelector('[data-testid="new-workspace-worktree-preview"]')?.innerText ?? null
                    })`)
                )
            );
        const followed = await fieldValues();
        rec.check(
            'typing "Fix Login Bug" fills the worktree and branch names with fix-login-bug',
            followed.worktree === 'fix-login-bug' && followed.branch === 'fix-login-bug' && (followed.preview ?? '').includes('fix-login-bug'),
            JSON.stringify(followed)
        );
        await sleep(200);
        await rec.shot(page, 'sheet-prefilled-worktree-from-latest-main');
        await page.click('[data-testid="new-workspace-submit"]');
        const closed = await d.settleDom(page, `document.querySelector('[data-testid="new-workspace-sheet"]') === null`, { ceilingMs: 60_000 });
        rec.check('Create closes the sheet once the worktree is made', closed, JSON.stringify(await sheetState()));

        const fix = (await listed()).find((workspace) => workspace.name === 'Fix Login Bug');
        if (fix !== undefined) created.push(fix.id);
        const fixRepo = fix?.repos?.[0];
        rec.check(
            'the CLI sees the workspace in the group with one association, on the autofilled branch fix-login-bug',
            fix?.group_name === GROUP && fix?.repos?.length === 1 && fixRepo?.branch === 'fix-login-bug' && fixRepo?.repo_path === repo,
            JSON.stringify(fix)
        );
        const worktreePath = fixRepo?.worktree_path ?? '';
        const onDisk = worktreePath !== '' && worktreePath !== repo && fs.existsSync(path.join(worktreePath, '.git'));
        rec.check(
            'the association is a worktree on disk, in a folder named fix-login-bug, not the repo itself',
            onDisk && path.basename(worktreePath) === 'fix-login-bug',
            worktreePath
        );
        if (onDisk) {
            const head = git(worktreePath, 'rev-parse', 'HEAD');
            const branch = git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD');
            const base = git(worktreePath, 'merge-base', 'HEAD', 'origin/main');
            rec.check('the worktree is on the new branch fix-login-bug', branch === 'fix-login-bug', branch);
            rec.check(
                'its base is origin/main AFTER a fetch: the commit pushed to origin after the clone',
                base === latestSha && head === latestSha && git(repo, 'rev-parse', 'origin/main') === latestSha,
                `head ${head}, merge-base ${base}, latest ${latestSha}`
            );
            rec.check('the local main is untouched', git(repo, 'rev-parse', 'main') === firstSha, git(repo, 'rev-parse', 'main'));
        }
        await sleep(400);
        await rec.shot(page, 'created-worktree-workspace');

        // ── 3 · the same sheet with the worktree unticked: a plain association ─────────────────
        rec.check('the sheet opens again from the group menu', await openNewWorkspaceFromGroup());
        const again = await sheetState();
        rec.check('…prefilled the same way', again.repos[0] === 'Remove app' && again.worktree === true, JSON.stringify(again));
        // A worktree name the user typed is theirs: changing the workspace name no longer moves it.
        await typeInto('[aria-label="New workspace name"]', 'Plain One');
        const beforeEdit = await fieldValues();
        await typeInto('[data-testid="new-workspace-worktree-name"]', 'kept-name');
        await typeInto('[aria-label="New workspace name"]', 'Plain Renamed');
        const afterEdit = await fieldValues();
        rec.check(
            'after the worktree name is edited by hand, a new workspace name does not overwrite it',
            beforeEdit.worktree === 'plain-one' && afterEdit.worktree === 'kept-name' && afterEdit.branch === 'kept-name',
            JSON.stringify({ beforeEdit, afterEdit })
        );
        await rec.shot(page, 'sheet-worktree-name-kept-after-edit');
        await typeInto('[aria-label="New workspace name"]', 'Plain One');
        await page.click('[data-testid="new-workspace-worktree-toggle"]');
        const unticked = await sheetState();
        rec.check('unticking hides the worktree fields and keeps the repo', unticked.worktree === false && unticked.repos.length === 1, JSON.stringify(unticked));
        await rec.shot(page, 'sheet-worktree-unticked');
        await page.click('[data-testid="new-workspace-submit"]');
        await d.settleDom(page, `document.querySelector('[data-testid="new-workspace-sheet"]') === null`, { ceilingMs: 20_000 });
        const plainReady = await d.settle(
            async () => ((await listed()).find((workspace) => workspace.name === 'Plain One')?.repos?.length ?? 0) === 1,
            { ceilingMs: 10_000, intervalMs: 200 }
        );
        const plain = (await listed()).find((workspace) => workspace.name === 'Plain One');
        if (plain !== undefined) created.push(plain.id);
        rec.check(
            'the unticked create just associates the repository itself (no worktree), on main',
            plainReady && plain?.repos?.[0]?.worktree_path === repo && plain?.repos?.[0]?.branch === 'main' && plain?.group_name === GROUP,
            JSON.stringify(plain)
        );
        rec.check(
            'and made no second worktree',
            git(repo, 'worktree', 'list').split('\n').length === 2,
            git(repo, 'worktree', 'list')
        );

        // ── 4 · the CLI in the same group ───────────────────────────────────────────────────────
        rec.note(`before the CLI creates: ${JSON.stringify(await ourGroup())}`);
        const fromCli = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'CLI Tree', '--group', GROUP, '--worktree', 'cli-tree', '--json']));
        if (typeof fromCli.workspace_id === 'string') created.push(fromCli.workspace_id);
        rec.check(
            'kelpi workspace create --group --worktree uses the group’s repo and updates main by default',
            fromCli.ok === true && fromCli.repo_path === repo && fromCli.update_main === true && fromCli.branch === 'cli-tree',
            JSON.stringify(fromCli)
        );
        const taken = await cli.run(['workspace', 'create', '--name', 'Dup', '--group', GROUP, '--worktree', 'fix-login-bug']);
        rec.check(
            'an update-main worktree on a branch that already exists fails with the clear message',
            taken.code !== 0 && taken.stderr.includes("branch 'fix-login-bug' already exists") && taken.stderr.includes('turn off update main'),
            taken.stderr
        );
        const optOut = await cli.run(['workspace', 'create', '--name', 'Reuse', '--group', GROUP, '--worktree', 'fix-login-2', '--no-update-main', '--json']);
        const optOutReply = optOut.code === 0 ? JSON.parse(optOut.stdout) : {};
        if (typeof optOutReply.workspace_id === 'string') created.push(optOutReply.workspace_id);
        rec.check('--no-update-main opts out of the group’s default', optOut.code === 0 && optOutReply.update_main === false, optOut.stdout + optOut.stderr);
        const plainCli = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'CLI Plain', '--group', GROUP, '--json']));
        if (typeof plainCli.workspace_id === 'string') created.push(plainCli.workspace_id);
        rec.check('without --worktree the group’s repo is associated', plainCli.repo_path === repo, JSON.stringify(plainCli));

        // ── 5 · a registered SUBFOLDER row is picked as is: no duplicate, the right row ticked ──
        for (const id of created.splice(0)) await cli.run(['workspace', 'delete', id, '--force']);
        const sub = path.join(repo, 'packages', 'web');
        fs.mkdirSync(sub, { recursive: true });
        const rowNames = async () =>
            JSON.parse(String(await page.eval(`JSON.stringify(Array.from(document.querySelectorAll('[data-testid^="repo-row-"]')).map(el => (el.innerText ?? '').split('\\n')[0].trim()))`)));
        const rowIDOf = async (name) =>
            page.eval(
                `(Array.from(document.querySelectorAll('[data-testid^="repo-row-"]')).find(el => (el.innerText ?? '').split('\\n')[0].trim() === ${JSON.stringify(name)})?.getAttribute('data-testid') ?? '').slice('repo-row-'.length)`
            );
        const closeSettings = async () => {
            await page.key('Escape');
            await d.settleDom(page, `document.querySelector('${d.PAGE.settingsPanel}') === null`, { ceilingMs: 3_000 });
        };
        await d.openSettingsTab(page, 'repositories');
        await page.click('[data-testid="repo-path"]');
        await page.insertText(sub);
        await page.click('[data-testid="repo-add"]');
        const subAdded = await d.settle(async () => (await rowNames()).includes('web'), { ceilingMs: 10_000, intervalMs: 200 });
        const beforePick = await rowNames();
        rec.check('Settings registers the monorepo subfolder as a row of its own', subAdded, JSON.stringify(beforePick));
        await closeSettings();

        const menuWithSub = await openRepositoryMenu();
        const webRow = menuWithSub.find((row) => row.label === 'web');
        await d.clickSubmenuItem(page, webRow?.id ?? 'repo:missing');
        const picked = await d.settle(async () => (await ourGroup())?.repo?.path === sub, { ceilingMs: 10_000, intervalMs: 200 });
        rec.check('picking the subfolder row makes THAT row the group’s repo, not its top level', picked, JSON.stringify(await ourGroup()));
        const ticked = await openRepositoryMenu();
        rec.check(
            'the menu ticks the subfolder row, and only it',
            ticked.find((row) => row.label === 'web')?.checked === 'true' && ticked.find((row) => row.label === 'app')?.checked === 'false',
            JSON.stringify(ticked)
        );
        await rec.shot(page, 'repository-menu-subfolder-row-ticked');
        await closeMenus();
        await d.openSettingsTab(page, 'repositories');
        const afterPick = await rowNames();
        rec.check('and registered no duplicate', JSON.stringify(afterPick) === JSON.stringify(beforePick), JSON.stringify(afterPick));

        // ── 6 · removing the repository from the registry clears the group's repo ──────────────
        for (const name of ['web', 'app']) {
            const rowID = await rowIDOf(name);
            if (typeof rowID === 'string' && rowID !== '') {
                await page.click(`[data-testid="repo-remove-${rowID}"]`);
                await d.settleDom(page, `document.querySelector('[data-testid="repo-row-${rowID}"]') === null`, { ceilingMs: 5_000 });
            }
            if (name === 'web') {
                const cleared = await d.settle(async () => (await ourGroup())?.repo === undefined, { ceilingMs: 5_000, intervalMs: 200 });
                rec.check('removing the group’s repository from the registry clears its repo and switch', cleared, JSON.stringify(await ourGroup()));
            }
        }
        await closeSettings();
    } finally {
        for (const id of created) await cli.run(['workspace', 'delete', id, '--force']);
        await cli.run(['group', 'delete', GROUP]);
        fs.rmSync(answerFile, { force: true });
    }
}

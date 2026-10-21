/**
 * New workspace on a phone: the drawer's New workspace opens a sheet that puts the workspace in a
 * group or nests it under another, starts it in a repository and makes it a git worktree on its own
 * branch (`packages/client/src/phone/new-workspace.ts`).
 *
 * Everything here is real: a bare `origin` and a clone of it under the sandbox root, a group whose
 * default repository is that clone with its worktree switch on, the phone form factor from CDP
 * device and touch emulation (no `?form=` override), taps through the touch pipeline, and git on
 * disk. A commit lands on origin AFTER the clone, so a worktree whose HEAD is that commit proves
 * the create fetched first.
 *
 *   1. the sheet opens in the on-screen workspace's group, prefilled with its repository and a
 *      worktree off latest main, and the worktree and branch names follow the typed name
 *   2. Create makes the worktree workspace in the group and the phone shows it
 *   3. the same name again is refused inline, and the sheet stays open
 *   4. Nested under a top-level workspace creates a child with no group and no repository
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const covers = [
    'packages/client/src/phone/PhoneNewWorkspaceSheet.tsx',
    'packages/client/src/phone/new-workspace.ts',
    'packages/client/src/phone/PhoneShell.tsx',
    'packages/client/src/phone/PhonePicker.tsx',
    'packages/daemon/src/handlers/app/workspaces.ts'
];

/** Touch input has to reach the window (see `placement.mjs`). */
export const windowPlacement = 'offscreen';

const GROUP = 'App Team';
const PLACE_KEY = 'kelpi.phone.last-place';
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

const sel = (id) => `[data-testid="${id}"]`;

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    if (sandbox === undefined || sandbox === null || cli === undefined || cli === null) {
        rec.check('this scenario boots its own sandbox (it drives the CLI and git)', false, 'run without --attach');
        return;
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────
    const root = fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'phone-new-ws-')));
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    const repo = path.join(root, 'app');
    git(root, 'init', '-q', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', '-q', origin, seed);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    commit(seed, 'README.md', '# app\n', 'first');
    git(seed, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', origin, repo);
    const latestSha = commit(seed, 'CHANGELOG.md', 'latest\n', 'latest on origin');
    git(seed, 'push', '-q', 'origin', 'main');

    const listed = async () => JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const byName = async (name) => (await listed()).find((workspace) => workspace.name === name);
    const created = [];

    await cli.ok(['group', 'create', GROUP]);
    // Before the group has a repository, so these two are plain workspaces.
    const dev = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'dev', '--group', GROUP, '--focus', '--json']));
    const docs = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'docs', '--json']));
    created.push(dev.workspace_id, docs.workspace_id);
    await cli.ok(['group', 'set-repo', GROUP, repo, '--worktree']);
    rec.check('fixture: dev in the group, docs at top level, the group defaulting to the clone with its worktree switch on', true);

    const sheet = async () =>
        JSON.parse(
            String(
                await page.eval(`(() => {
                    const q = (id) => document.querySelector('[data-testid="' + id + '"]');
                    const placement = q('phone-new-workspace-placement');
                    return JSON.stringify({
                        open: q('phone-new-workspace-sheet') !== null,
                        placement: placement?.value ?? null,
                        placementLabel: placement?.selectedOptions?.[0]?.textContent ?? null,
                        options: Array.from(placement?.options ?? []).map(o => o.textContent),
                        repo: q('phone-new-workspace-repo')?.selectedOptions?.[0]?.textContent ?? null,
                        worktree: q('phone-new-workspace-worktree')?.checked ?? null,
                        updateMain: q('phone-new-workspace-update-main')?.checked ?? null,
                        worktreeName: q('phone-new-workspace-worktree-name')?.value ?? null,
                        branch: q('phone-new-workspace-branch')?.value ?? null,
                        preview: q('phone-new-workspace-preview')?.innerText ?? null,
                        error: q('phone-new-workspace-error')?.innerText ?? null,
                        button: q('phone-new-workspace-create')?.textContent ?? null,
                        panel: (() => { const r = q('phone-new-workspace-sheet-panel')?.getBoundingClientRect(); return r ? [r.width, r.height] : null; })(),
                        createVisible: (() => {
                            const b = q('phone-new-workspace-create')?.getBoundingClientRect();
                            return b !== undefined && b.height > 0 && b.top >= 0 && b.bottom <= window.innerHeight;
                        })()
                    });
                })()`)
            )
        );
    const openSheet = async () => {
        await page.tap(sel('phone-bar-workspace'));
        await d.settleDom(page, `document.querySelector('${sel('phone-new-workspace')}') !== null`, { ceilingMs: 5_000 });
        await page.tap(sel('phone-new-workspace'));
        return d.settleDom(page, `document.querySelector('${sel('phone-new-workspace-sheet')}') !== null`, { ceilingMs: 5_000 });
    };
    /** A native `<select>` opens a system picker CDP cannot drive, so its choice is set the way React reads one. */
    const choose = (id, value) =>
        page.eval(`(() => {
            const el = document.querySelector('${sel(id)}');
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
            el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
    const typeName = async (text) => {
        await page.tap(sel('phone-new-workspace-name'));
        await page.eval(`document.querySelector('${sel('phone-new-workspace-name')}').select()`);
        await page.insertText(text);
    };
    const closed = () => d.settleDom(page, `document.querySelector('${sel('phone-new-workspace-sheet')}') === null`, { ceilingMs: 60_000 });

    const savedPlace = await page.eval(`localStorage.getItem('${PLACE_KEY}')`);
    try {
        await page.eval(`localStorage.setItem('${PLACE_KEY}', JSON.stringify({ host: 'origin', workspaceID: '${dev.workspace_id}' }))`);
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        rec.check(
            'the window is a phone, on dev',
            await d.settleDom(page, `document.documentElement.dataset.formFactor === 'phone' && document.querySelector('${sel('phone-title-workspace')}')?.textContent === 'dev'`, { ceilingMs: 10_000 })
        );

        // ── 1 · the sheet, prefilled from the group ──────────────────────────────────────────
        rec.check('New workspace at the drawer’s foot opens the sheet', await openSheet());
        const prefilled = await d.settle(async () => (await sheet()).worktree === true, { ceilingMs: 5_000, intervalMs: 150 });
        const first = await sheet();
        rec.check(
            'it opens in dev’s group, with the group’s repository and a worktree off the latest main',
            prefilled && first.placementLabel === GROUP && first.repo === 'app' && first.updateMain === true,
            JSON.stringify(first)
        );
        // The sandbox's own first workspace is listed too, so this asks for ours rather than the whole list.
        rec.check(
            'Location leads with No group, then the group, and offers both workspaces as parents',
            first.options[0] === 'No group' && first.options[1] === GROUP && first.options.includes(`dev (${GROUP})`) && first.options.includes('docs'),
            JSON.stringify(first.options)
        );
        rec.check('the sheet fits the phone’s width', first.panel !== null && first.panel[0] <= 390, JSON.stringify(first.panel));
        await sleep(200);
        await rec.shot(page, 'phone-new-workspace-prefilled');

        await typeName('Fix Login');
        const followed = await sheet();
        rec.check('with the worktree’s fields open, Create is still on screen without scrolling', followed.createVisible === true, JSON.stringify(followed));
        rec.check(
            'the worktree and branch follow the name, and the preview names the folder',
            followed.worktreeName === 'fix-login' && followed.branch === 'fix-login' && (followed.preview ?? '').includes('fix-login'),
            JSON.stringify(followed)
        );
        await page.eval(`document.activeElement?.blur()`);
        await sleep(200);
        await rec.shot(page, 'phone-new-workspace-worktree-filled');

        // ── 2 · Create ───────────────────────────────────────────────────────────────────────
        await page.tap(sel('phone-new-workspace-create'));
        rec.check('Create closes the sheet once the worktree is made', await closed(), JSON.stringify(await sheet()));
        const fix = await byName('Fix Login');
        if (fix !== undefined) created.push(fix.id);
        const fixRepo = fix?.repos?.[0];
        rec.check(
            'the workspace is in the group, on branch fix-login, as a worktree of the clone',
            fix?.group_name === GROUP && fixRepo?.branch === 'fix-login' && fixRepo?.repo_path === repo,
            JSON.stringify(fix)
        );
        const worktreePath = fixRepo?.worktree_path ?? '';
        if (worktreePath !== '' && fs.existsSync(path.join(worktreePath, '.git'))) {
            rec.check('the worktree was cut from origin’s latest main', git(worktreePath, 'rev-parse', 'HEAD') === latestSha, worktreePath);
        } else {
            rec.check('the worktree exists on disk', false, worktreePath);
        }
        rec.check(
            'the phone shows the new workspace',
            await d.settleDom(page, `document.querySelector('${sel('phone-title-workspace')}')?.textContent === 'Fix Login'`, { ceilingMs: 10_000 })
        );
        await sleep(300);
        await rec.shot(page, 'phone-new-workspace-created');

        // ── 3 · a refusal stays in the sheet ─────────────────────────────────────────────────
        rec.check('the sheet opens again', await openSheet());
        await d.settle(async () => (await sheet()).worktree === true, { ceilingMs: 5_000, intervalMs: 150 });
        await typeName('Fix Login');
        await page.tap(sel('phone-new-workspace-create'));
        const refused = await d.settle(async () => (await sheet()).error !== null, { ceilingMs: 30_000, intervalMs: 200 });
        const refusal = await sheet();
        rec.check('the same branch again is refused inline, with the sheet still open', refused && refusal.open && refusal.button === 'Create', JSON.stringify(refusal));
        await page.eval(`document.activeElement?.blur()`);
        await sleep(200);
        await rec.shot(page, 'phone-new-workspace-refused');

        // ── 4 · nested under a top-level workspace ───────────────────────────────────────────
        await choose('phone-new-workspace-placement', `parent:${docs.workspace_id}`);
        const nestedSheet = await sheet();
        rec.check(
            'nested under docs (top level) nothing is prefilled, and the refusal of the last draft is gone',
            nestedSheet.placementLabel === 'docs' && nestedSheet.repo === 'None' && nestedSheet.worktree === null && nestedSheet.error === null,
            JSON.stringify(nestedSheet)
        );
        await typeName('docs child');
        await page.eval(`document.activeElement?.blur()`);
        await sleep(200);
        await rec.shot(page, 'phone-new-workspace-nested');
        await page.tap(sel('phone-new-workspace-create'));
        rec.check('Create closes the sheet', await closed(), JSON.stringify(await sheet()));
        const child = await d.settle(async () => (await byName('docs child')) !== undefined, { ceilingMs: 10_000, intervalMs: 200 });
        const childRow = await byName('docs child');
        if (childRow !== undefined) created.push(childRow.id);
        rec.check(
            'the child is nested under docs, with no group and no repository',
            child && (childRow?.parent_id ?? '').toUpperCase() === String(docs.workspace_id).toUpperCase() && (childRow?.group_name ?? null) === null && (childRow?.repos?.length ?? 0) === 0,
            JSON.stringify(childRow)
        );
        await page.tap(sel('phone-bar-workspace'));
        await sleep(400);
        await rec.shot(page, 'phone-drawer-after');
        await page.key('Escape');
    } finally {
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
        await page.send('Emulation.clearDeviceMetricsOverride');
        await page.eval(savedPlace === null ? `localStorage.removeItem('${PLACE_KEY}')` : `localStorage.setItem('${PLACE_KEY}', ${JSON.stringify(savedPlace)})`);
        for (const id of created.reverse()) await cli.run(['workspace', 'delete', id, '--force']);
    }
}

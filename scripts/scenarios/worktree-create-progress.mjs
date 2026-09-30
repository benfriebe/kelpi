/**
 * #294: a worktree create shows its steps while it runs, reuses the sheet's prefetch, names the
 * step that failed, and can be cancelled without leaving anything behind.
 *
 * Everything is real: bare `origin`s and clones under the sandbox root, groups whose repository
 * switch pre-ticks "Create git worktree" and "Update main first" (so the sheet prefetches the
 * moment it opens), the New Workspace sheet raised from each group's menu, the daemon's log, and
 * git on disk. Git is slowed with each fixture repo's OWN configuration, never a product seam:
 *
 *   - `remote.origin.uploadpack` is a wrapper that pipes `git-upload-pack` through a throttle
 *     (about 0.8 MB/s), and origin gets an 8 MB commit after the clone, so a fetch takes seconds
 *     and git prints a moving "Receiving objects" percentage;
 *   - a `post-checkout` hook sleeps (3 s, and 10 s for the cancel step), holding
 *     `git worktree add` open after its checkout so the step can be seen, screenshotted and
 *     cancelled.
 *
 * Steps:
 *   1. group A: open the sheet (the prefetch starts and finishes on its own), then Create: the
 *      fetch step says "prefetched N s ago" and the log records the skip;
 *   2. group B: open the sheet and Create at once: the create JOINS the running prefetch and shows
 *      its percentage; Escape does not close the sheet, it shows the hint; the worktree step runs;
 *      the sheet closes and the worktree is on origin's latest commit;
 *   3. group A again: a branch that already exists fails on the worktree step, with git's
 *      message, and the form comes back;
 *   4. the same sheet: Cancel during `worktree add` removes the new directory and branch (and only
 *      those), and the sheet says so.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The source this drives, so `verify.mjs` re-runs it when any hop moves. */
export const covers = [
    'packages/client/src/chrome/NewWorkspaceSheet.tsx',
    'packages/client/src/chrome/WorktreeCreateProgress.tsx',
    'packages/client/src/chrome/worktree.ts',
    'packages/client/src/chrome/Sidebar.tsx',
    'packages/client/src/features/workspaces.tsx',
    'packages/client/src/features/workspaces-actions.ts',
    'packages/client/src/connection/commands.ts',
    'packages/client/src/connection/socket.ts',
    'packages/daemon/src/handlers/app/workspaces.ts',
    'packages/daemon/src/ws/sync.ts',
    'packages/daemon/src/ws/repos.ts',
    'packages/daemon/src/git/worktree-add.ts',
    'packages/daemon/src/git/fetch-cache.ts',
    'packages/daemon/src/git/worktree-steps.ts',
    'packages/daemon/src/git/progress.ts',
    'packages/daemon/src/git/exec.ts',
    'packages/daemon/src/boot/compose.ts'
];

/** CDP input has to reach the window for the menus and the sheet (see `placement.mjs`). */
export const windowPlacement = 'offscreen';

const GROUP_A = 'Prefetch Team';
const GROUP_B = 'Slow Fetch Team';
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

function tryGit(cwd, ...args) {
    try {
        return git(cwd, ...args);
    } catch {
        return null;
    }
}

function commit(dir, message) {
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
}

/** A bare origin, a seed that pushes, and a slowed clone the group uses; origin then moves 8 MB ahead. */
function fixture(root, name) {
    const origin = path.join(root, `${name}-origin.git`);
    const seed = path.join(root, `${name}-seed`);
    const repo = path.join(root, name);
    git(root, 'init', '-q', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', '-q', origin, seed);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    fs.writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`);
    const firstSha = commit(seed, 'first');
    git(seed, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', origin, repo);
    // 400 random 20 kB files: an 8 MB pack that does not compress, so the fetch takes a while.
    const assets = path.join(seed, 'assets');
    fs.mkdirSync(assets);
    for (let index = 0; index < 400; index += 1) {
        fs.writeFileSync(path.join(assets, `blob-${String(index)}.bin`), execFileSync('head', ['-c', '20000', '/dev/urandom']));
    }
    const latestSha = commit(seed, 'latest on origin: 8 MB of assets');
    git(seed, 'push', '-q', 'origin', 'main');

    const throttle = path.join(root, `${name}-slow-upload-pack.sh`);
    fs.writeFileSync(
        throttle,
        '#!/bin/sh\n' +
            '# Test fixture: git-upload-pack at about 0.8 MB/s, so a fetch shows its meter.\n' +
            'git-upload-pack "$@" | perl -e \'$|=1; while (sysread(STDIN, $b, 16384)) { syswrite(STDOUT, $b); select(undef, undef, undef, 0.02); }\'\n',
        { mode: 0o755 }
    );
    git(repo, 'config', 'remote.origin.uploadpack', throttle);
    // How long the hook holds the add open, read per run so the cancel step can lengthen it.
    const hookSeconds = path.join(root, `${name}-hook-seconds`);
    fs.writeFileSync(hookSeconds, '3\n');
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(
        hook,
        `#!/bin/sh\n# Test fixture: hold \`git worktree add\` open so its step can be seen.\nsleep "$(cat '${hookSeconds}')"\n`,
        { mode: 0o755 }
    );
    return { origin, seed, repo, firstSha, latestSha, hookSeconds };
}

export default async function ({ page, cli, sandbox, daemon, rec, d, sleep }) {
    if (sandbox === undefined || sandbox === null || cli === undefined || cli === null || daemon === undefined || daemon === null) {
        rec.check('this scenario boots its own sandbox (it drives the CLI and reads the daemon log)', false, 'run without --attach');
        return;
    }

    const root = fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'wt-progress-')));
    const a = fixture(root, 'alpha');
    const b = fixture(root, 'beta');
    rec.note(`fixtures under ${root}: alpha latest ${a.latestSha.slice(0, 8)}, beta latest ${b.latestSha.slice(0, 8)}`);
    rec.check(
        'fixture: both clones are one 8 MB commit behind their origin',
        git(a.repo, 'rev-parse', 'origin/main') === a.firstSha && git(b.repo, 'rev-parse', 'origin/main') === b.firstSha
    );

    const listed = async () => JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const created = [];
    const log = () => daemon.text();
    const headerSelector = '[data-testid="group-header"]';
    const sheetOpen = `document.querySelector('[data-testid="new-workspace-sheet"]') !== null`;
    const sheetClosed = `document.querySelector('[data-testid="new-workspace-sheet"]') === null`;
    const stepStatus = (id) => `document.querySelector('[data-testid="new-workspace-step-${id}"]')?.getAttribute('data-status') ?? null`;
    const state = async () =>
        JSON.parse(
            String(
                await page.eval(`JSON.stringify({
                    open: ${sheetOpen},
                    phase: document.querySelector('[data-testid="new-workspace-progress"]')?.getAttribute('data-phase') ?? null,
                    steps: Object.fromEntries(Array.from(document.querySelectorAll('[data-testid^="new-workspace-step-"][data-status]')).map(el => [
                        el.getAttribute('data-testid').slice('new-workspace-step-'.length),
                        { status: el.getAttribute('data-status'), percent: el.getAttribute('data-percent'),
                          detail: el.querySelector('[data-testid$="-detail"]')?.textContent ?? null,
                          phase: el.querySelector('[data-testid$="-phase"]')?.textContent ?? null }
                    ])),
                    elapsed: document.querySelector('[data-testid="new-workspace-progress-elapsed"]')?.textContent ?? null,
                    hint: document.querySelector('[data-testid="new-workspace-progress-hint"]')?.textContent ?? null,
                    error: document.querySelector('[data-testid="new-workspace-error"]')?.innerText ?? null,
                    fieldsDisabled: document.querySelector('[data-testid="new-workspace-fields"]')?.disabled ?? null,
                    cancel: document.querySelector('[data-testid="new-workspace-cancel"]')?.textContent ?? null,
                    worktree: document.querySelector('[data-testid="new-workspace-worktree-toggle"]')?.checked ?? null,
                    updateMain: document.querySelector('[data-testid="new-workspace-worktree-update-main"]')?.checked ?? null
                })`)
            )
        );
    const openFromGroup = async (group) => {
        await d.openSidebarMenu(page, headerSelector, group);
        await d.clickMenuItem(page, 'New Workspace');
        return d.settleDom(page, sheetOpen, { ceilingMs: 5_000 });
    };
    /** Is the element inside the sheet's visible (scrolled) area, as a user would see it? */
    const inView = async (selector) =>
        page.eval(`(() => {
            const sheet = document.querySelector('[data-testid="new-workspace-sheet"]');
            const el = document.querySelector('${selector}');
            if (sheet === null || el === null) return false;
            const s = sheet.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
        })()`);
    /** A user scrolls a control into view before pressing it; so does this. */
    const press = async (selector) => {
        await page.eval(`document.querySelector('${selector}')?.scrollIntoView({ block: 'nearest' })`);
        await page.click(selector);
    };
    /** A user scrolls a field back into view before typing in it; so does this. */
    const typeInto = async (selector, text) => {
        await page.eval(`document.querySelector('${selector}')?.scrollIntoView({ block: 'nearest' })`);
        await page.click(selector);
        await page.eval(`(() => { const el = document.querySelector('${selector}'); el?.select?.(); })()`);
        await page.insertText(text);
    };
    const worktreeBase = (repo) => path.join(sandbox.home, 'kelpi', 'worktrees', path.basename(repo));

    try {
        for (const [group, fx] of [[GROUP_A, a], [GROUP_B, b]]) {
            await cli.ok(['group', 'create', group]);
            await cli.ok(['group', 'set-repo', group, fx.repo, '--worktree']);
        }
        rec.check(
            'both groups exist with their repository and the worktree switch on',
            await d.settleDom(page, `Array.from(document.querySelectorAll('${headerSelector}')).filter(el => /Prefetch Team|Slow Fetch Team/.test(el.innerText ?? '')).length === 2`, { ceilingMs: 5_000 })
        );

        // ── 1 · the prefetch finishes while the sheet is open; Create skips the fetch ──────────
        rec.check('group A: New Workspace opens the sheet', await openFromGroup(GROUP_A));
        const prefilled = await state();
        rec.check('the sheet is pre-ticked: worktree and update main', prefilled.worktree === true && prefilled.updateMain === true, JSON.stringify(prefilled));
        const prefetchStarted = await d.settle(async () => log().includes(`worktree-prefetch: fetching origin/main for ${a.repo}`), { ceilingMs: 10_000, intervalMs: 100 });
        rec.check('opening the sheet started a background fetch of origin/main (daemon log)', prefetchStarted, log().split('\n').filter((l) => l.includes('worktree-')).join(' | '));
        const prefetchDone = await d.settle(async () => new RegExp(`worktree-prefetch: origin/main for ${a.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} done in \\d+ ms`).test(log()), { ceilingMs: 90_000, intervalMs: 250 });
        rec.check('…and it finished on its own, before Create was pressed', prefetchDone);
        rec.check('the prefetch already moved origin/main to origin’s latest commit', git(a.repo, 'rev-parse', 'origin/main') === a.latestSha);
        await typeInto('[aria-label="New workspace name"]', 'Skip It');
        const clickedAt = Date.now();
        await press('[data-testid="new-workspace-submit"]');
        const skipped = await d.settle(async () => (await state()).steps.fetch?.status === 'skipped', { ceilingMs: 10_000, intervalMs: 50 });
        const skipState = await state();
        rec.check(
            'the fetch step is skipped, "prefetched N s ago"',
            skipped && /^prefetched \d+(\.\d)? s ago$/.test(skipState.steps.fetch?.detail ?? ''),
            JSON.stringify(skipState.steps)
        );
        rec.check('…while the worktree step runs, and the fields are disabled', skipState.steps['worktree-add']?.status === 'running' && skipState.fieldsDisabled === true, JSON.stringify(skipState));
        rec.check('the sheet scrolled so the steps and Cancel are in view', (await inView('[data-testid="new-workspace-progress"]')) && (await inView('[data-testid="new-workspace-cancel"]')));
        await rec.shot(page, 'fetch-skipped-prefetched');
        const skipClosed = await d.settleDom(page, sheetClosed, { ceilingMs: 30_000 });
        const skipMs = Date.now() - clickedAt;
        rec.check('Create closes the sheet once the worktree is made', skipClosed);
        rec.note(`create with a reused prefetch: ${String(skipMs)} ms from Create to close (3 s of it is the fixture's post-checkout hook)`);
        rec.check('the daemon log records the skip', /worktree-create: fetch of origin\/main skipped for .*alpha: prefetched/.test(log()), log().split('\n').filter((l) => l.includes('worktree-create')).join(' | '));
        rec.check('…and where the default branch came from (the local origin/HEAD)', log().includes(`worktree-create: default branch of ${a.repo} is main (from origin/HEAD)`));
        const skipWorkspace = (await listed()).find((workspace) => workspace.name === 'Skip It');
        if (skipWorkspace !== undefined) created.push(skipWorkspace.id);
        const skipPath = path.join(worktreeBase(a.repo), 'skip-it');
        rec.check('the worktree is on origin’s latest commit, on branch skip-it', fs.existsSync(skipPath) && git(skipPath, 'rev-parse', 'HEAD') === a.latestSha && git(skipPath, 'rev-parse', '--abbrev-ref', 'HEAD') === 'skip-it');

        // ── 2 · Create at once: the create joins the running prefetch and shows its meter ─────
        rec.check('group B: New Workspace opens the sheet', await openFromGroup(GROUP_B));
        await typeInto('[aria-label="New workspace name"]', 'Slow Fetch');
        const joinedAt = Date.now();
        await press('[data-testid="new-workspace-submit"]');
        const percentShown = await d.settle(
            async () => {
                const now = await state();
                const percent = Number(now.steps.fetch?.percent ?? 'NaN');
                return now.steps.fetch?.status === 'running' && percent > 5 && percent < 95 && (now.steps.fetch?.phase ?? '').startsWith('Receiving objects');
            },
            { ceilingMs: 60_000, intervalMs: 50 }
        );
        const running = await state();
        rec.check(
            'the fetch step runs with git’s percentage and a determinate bar ("Receiving objects N%")',
            percentShown && /^Receiving objects \d+%$/.test(running.steps.fetch?.phase ?? ''),
            JSON.stringify(running.steps)
        );
        rec.check('…joined to the prefetch the sheet started (no second fetch)', (running.steps.fetch?.detail ?? '').includes('finishing the prefetch'), running.steps.fetch?.detail);
        rec.check('…with the elapsed time ticking', /^\d+\.\d s$|^\d+ s$/.test(running.elapsed ?? ''), running.elapsed);
        rec.check('the finished step is ticked, the rest pending', running.steps['resolve-default-branch']?.status === 'done' && running.steps['worktree-add']?.status === 'pending');
        await rec.shot(page, 'progress-fetch-percent');
        await page.key('Escape');
        await sleep(150);
        const escaped = await state();
        rec.check('Escape does not close a running create; the sheet says to press Cancel', escaped.open && (escaped.hint ?? '').includes('Press Cancel'), JSON.stringify(escaped));
        rec.check('…and keeps Cancel in view under the hint', await inView('[data-testid="new-workspace-cancel"]'));
        await rec.shot(page, 'escape-blocked-hint');
        const addRunning = await d.settle(async () => (await state()).steps['worktree-add']?.status === 'running', { ceilingMs: 60_000, intervalMs: 50 });
        const adding = await state();
        rec.check('then the fetch is ticked and the worktree step runs', addRunning && adding.steps.fetch?.status === 'done', JSON.stringify(adding.steps));
        await rec.shot(page, 'progress-worktree-add');
        const joinedClosed = await d.settleDom(page, sheetClosed, { ceilingMs: 60_000 });
        const joinedMs = Date.now() - joinedAt;
        rec.check('the sheet closes when the workspace exists', joinedClosed);
        rec.note(`create that joined a running prefetch: ${String(joinedMs)} ms from Create to close`);
        rec.check('the daemon log records the join', /worktree-create: fetch of origin\/main for .*beta joined the prefetch already running/.test(log()));
        rec.check('exactly one fetch ran for beta (the prefetch)', (log().match(new RegExp(`worktree-prefetch: fetching origin/main for ${b.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) ?? []).length === 1 && !/worktree-create: fetched origin\/main for .*beta/.test(log()));
        const slowWorkspace = (await listed()).find((workspace) => workspace.name === 'Slow Fetch');
        if (slowWorkspace !== undefined) created.push(slowWorkspace.id);
        const slowPath = path.join(worktreeBase(b.repo), 'slow-fetch');
        rec.check(
            'the worktree is cut from the commit pushed to origin after the clone; the local main is untouched',
            fs.existsSync(slowPath) && git(slowPath, 'rev-parse', 'HEAD') === b.latestSha && git(b.repo, 'rev-parse', 'main') === b.firstSha
        );

        // ── 3 · a branch that already exists: the worktree step fails, the form comes back ─────
        rec.check('group A again: the sheet opens', await openFromGroup(GROUP_A));
        await typeInto('[aria-label="New workspace name"]', 'Branch Taken');
        await typeInto('[data-testid="new-workspace-worktree-branch"]', 'skip-it');
        await press('[data-testid="new-workspace-submit"]');
        const failed = await d.settle(async () => (await state()).phase === 'failed', { ceilingMs: 20_000, intervalMs: 50 });
        const failure = await state();
        rec.check(
            'the worktree step is marked failed, and the error line says why',
            failed && failure.steps['worktree-add']?.status === 'failed' && (failure.error ?? '').includes("branch 'skip-it' already exists"),
            JSON.stringify(failure)
        );
        rec.check('the form is enabled again and the sheet stays open for a retry', failure.fieldsDisabled === false && failure.open === true);
        rec.check('the failed step, the error and the buttons are in view', (await inView('[data-testid="new-workspace-error"]')) && (await inView('[data-testid="new-workspace-submit"]')));
        await sleep(200);
        await rec.shot(page, 'failure-branch-exists');

        // ── 4 · Cancel during `worktree add`: only what this create made is removed ────────────
        // A long hold, so the Cancel click cannot miss the window on a loaded machine.
        fs.writeFileSync(a.hookSeconds, '10\n');
        await typeInto('[data-testid="new-workspace-worktree-name"]', 'cancel-me');
        await typeInto('[data-testid="new-workspace-worktree-branch"]', 'cancel-me');
        await typeInto('[aria-label="New workspace name"]', 'Cancel Me');
        const cancelPath = path.join(worktreeBase(a.repo), 'cancel-me');
        const fields = JSON.parse(String(await page.eval(`JSON.stringify({
            name: document.querySelector('[aria-label="New workspace name"]')?.value,
            worktree: document.querySelector('[data-testid="new-workspace-worktree-name"]')?.value,
            branch: document.querySelector('[data-testid="new-workspace-worktree-branch"]')?.value
        })`)));
        rec.check('the retry is set up: Cancel Me, worktree and branch cancel-me', fields.name === 'Cancel Me' && fields.worktree === 'cancel-me' && fields.branch === 'cancel-me', JSON.stringify(fields));
        await press('[data-testid="new-workspace-submit"]');
        const inAdd = await d.settle(async () => (await state()).steps['worktree-add']?.status === 'running', { ceilingMs: 20_000, intervalMs: 50 });
        // Let git make the branch and the directory (the hook runs after both exist).
        const partial = await d.settle(async () => fs.existsSync(cancelPath) && tryGit(a.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/cancel-me') !== null, { ceilingMs: 10_000, intervalMs: 50 });
        rec.check('mid-create: git has made the branch cancel-me and its directory', inAdd && partial, `${String(inAdd)} ${String(partial)} ${git(a.repo, 'worktree', 'list')}`);
        rec.check('the sheet scrolled Cancel back into view when the create started', await inView('[data-testid="new-workspace-cancel"]'));
        await page.click('[data-testid="new-workspace-cancel"]');
        await sleep(60);
        const cancelling = await state();
        rec.check('Cancel sends the cancel and reads "Cancelling…"', cancelling.cancel === 'Cancelling…' || cancelling.phase === 'cancelled', JSON.stringify(cancelling));
        const cancelled = await d.settle(async () => (await state()).phase === 'cancelled', { ceilingMs: 20_000, intervalMs: 50 });
        const after = await state();
        rec.check(
            'the sheet says it was cancelled, marks the step, and re-enables the form',
            cancelled && after.steps['worktree-add']?.status === 'failed' && (after.error ?? '').startsWith('Create cancelled') && after.fieldsDisabled === false && after.open,
            JSON.stringify(after)
        );
        await sleep(200);
        await rec.shot(page, 'cancelled');
        rec.check('the half-made worktree directory is gone', !fs.existsSync(cancelPath), cancelPath);
        rec.check('the branch this create made is gone', tryGit(a.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/cancel-me') === null);
        rec.check('git no longer lists the worktree', !git(a.repo, 'worktree', 'list', '--porcelain').includes('cancel-me'));
        rec.check(
            'what existed before is untouched: skip-it and its worktree, and main',
            tryGit(a.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/skip-it') !== null && fs.existsSync(skipPath) && git(a.repo, 'rev-parse', 'main') === a.firstSha
        );
        rec.check('no workspace was created by the cancelled create', !(await listed()).some((workspace) => workspace.name === 'Cancel Me'));
        rec.check('the daemon log says what the cancel removed', /worktree-create: cancelled during worktree-add for .*cancel-me; removed (worktree, )?branch cancel-me; no directory left/.test(log()), log().split('\n').filter((l) => l.includes('cancelled during')).join(' | '));
        await press('[data-testid="new-workspace-cancel"]');
        rec.check('with nothing running, Cancel closes the sheet again', await d.settleDom(page, sheetClosed, { ceilingMs: 5_000 }));
    } finally {
        if (await page.eval(sheetOpen)) await page.key('Escape');
        for (const id of created) await cli.run(['workspace', 'delete', id, '--force']);
        for (const group of [GROUP_A, GROUP_B]) await cli.run(['group', 'delete', group]);
    }
}

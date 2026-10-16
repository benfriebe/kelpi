/**
 * #2: a workspace's pull request status, on its sidebar row and in its inspector
 * (workspace-feature.md section 11, shell-ui.md 5.3 and 6).
 *
 * Real from the repo up: a git repo under the sandbox root whose `origin` is
 * `https://github.com/acme/widgets`, on a branch `feat-x`, associated with a new workspace by
 * the CLI. The one stand-in is `gh` itself: every sandbox daemon runs
 * `scripts/ui-audit/fixtures/gh-stub.mjs` (`KELPI_GH`), and this scenario scripts its answers
 * with `d.scriptGh`. So the daemon's whole path runs: the association's branch, origin read
 * and parsed, the default branch skipped, `gh auth status`, `gh pr list` with the right
 * arguments, the fork filter, the head-commit check, the store, the WebSocket and the row.
 *
 * Then Settings ▸ General ▸ "Show pull request status" is pressed off and on: off clears the
 * glyph and writes `workspace-pr-status = false`; on looks up again at once and finds the
 * PR merged.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const covers = [
    'packages/client/src/chrome/Sidebar.tsx',
    'packages/client/src/chrome/Inspector.tsx',
    'packages/client/src/chrome/PullRequestGlyph.tsx',
    'packages/client/src/settings/sections.ts',
    'packages/daemon/src/github/pr-poller.ts',
    'packages/daemon/src/github/gh.ts',
    'packages/daemon/src/github/remote.ts',
    'scripts/ui-audit/fixtures/gh-stub.mjs'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
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

function wirePR(number, state, head, overrides = {}) {
    return {
        number,
        title: overrides.title ?? `Add the widget catalogue ${TAG}`,
        url: `https://github.com/acme/widgets/pull/${String(number)}`,
        state,
        isDraft: false,
        headRefName: 'feat-x',
        headRefOid: head,
        headRepository: { name: 'widgets' },
        headRepositoryOwner: { login: overrides.owner ?? 'acme' }
    };
}

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    if (sandbox === undefined || sandbox === null || cli === undefined || cli === null) {
        rec.check('this scenario boots its own sandbox (it scripts the sandbox gh and drives the CLI)', false, 'run without --attach');
        return;
    }

    const readKelpi = () => (fs.existsSync(sandbox.configPath) ? fs.readFileSync(sandbox.configPath, 'utf8') : null);
    const originalKelpi = readKelpi();
    const configured = (key) =>
        [...(readKelpi() ?? '').matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(\\S+)[ \\t]*$`, 'gm'))].at(-1)?.[1] ?? null;
    const inspectorAtStart = await page.eval(`document.querySelector('[data-testid="inspector"]') !== null`);
    let workspaceID = null;

    // ── fixture: a repo on GitHub (by its origin), on a feature branch ─────────────────────────
    const repo = path.join(fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'pr-status-'))), 'widgets');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '--initial-branch=main');
    fs.writeFileSync(path.join(repo, 'README.md'), '# widgets\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    git(repo, 'checkout', '-q', '-b', 'feat-x');
    fs.writeFileSync(path.join(repo, 'catalogue.md'), 'widgets\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'catalogue');
    const tip = git(repo, 'rev-parse', 'HEAD');
    rec.note(`fixture: ${repo} on feat-x at ${tip.slice(0, 8)}, origin https://github.com/acme/widgets.git`);

    const row = () => `[data-testid="workspace-pr-${String(workspaceID)}"]`;
    const glyph = async () =>
        JSON.parse(
            String(
                await page.eval(`(() => {
                    const el = document.querySelector('${row()}');
                    return JSON.stringify(el === null ? null : {
                        state: el.getAttribute('data-pr-state'),
                        title: el.getAttribute('title'),
                        label: el.getAttribute('aria-label'),
                        icon: el.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null,
                        inRow: el.closest('[data-testid="workspace-row"]')?.getAttribute('data-workspace-id') ?? null
                    });
                })()`)
            )
        );
    const listed = async () =>
        JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find((entry) => entry.id.toLowerCase() === String(workspaceID).toLowerCase());

    /** Settings ▸ General ▸ "Show pull request status", set and confirmed in the file and the switch. */
    const setPrStatus = async (enabled) => {
        const toggle = '[data-testid="workspace-pr-status-toggle"]';
        await d.openSettingsTab(page, 'general');
        if (!(await d.settleDom(page, `document.querySelector('${toggle}')`, { ceilingMs: 8_000 }))) {
            throw new Error('Settings ▸ General has no workspace-pr-status toggle');
        }
        await page.eval(`document.querySelector('${toggle}')?.scrollIntoView({ block: 'center' })`);
        await sleep(200);
        if ((await page.eval(`document.querySelector('${toggle}').checked`)) !== enabled) await page.click(toggle);
        rec.check(
            `the toggle writes workspace-pr-status = ${String(enabled)} to the daemon's config`,
            await d.settle(() => configured('workspace-pr-status') === String(enabled), { ceilingMs: 8_000, intervalMs: 80 }),
            String(configured('workspace-pr-status'))
        );
        await page.click('[data-testid="settings-close"]').catch(() => {});
        await d.settleDom(page, `document.querySelector('${d.PAGE.settingsPanel}') === null`, { ceilingMs: 5_000 });
    };

    try {
        // ── open: the row shows it ───────────────────────────────────────────────────────
        d.scriptGh(sandbox, { loggedIn: true, pulls: { 'feat-x': [wirePR(12, 'OPEN', tip)] } });
        // An earlier scenario in this lane may have left the poller standing down on the
        // unscripted (logged-out) stub for its ten minutes; off and on asks gh again at once.
        await setPrStatus(false);
        await setPrStatus(true);
        const created = JSON.parse(
            await cli.ok(['workspace', 'create', '--name', `PR status ${TAG}`, '--path', repo, '--repo', repo, '--json'])
        );
        workspaceID = created.workspace_id;
        rec.check('fixture: the workspace is created with the repo associated', typeof workspaceID === 'string', JSON.stringify(created));

        const open = await d.settle(async () => (await glyph())?.state === 'open', { ceilingMs: 20_000, intervalMs: 150 });
        const openGlyph = await glyph();
        rec.check('the row shows an open PR glyph within one lookup of the association appearing', open, JSON.stringify(openGlyph));
        rec.check(
            'its tooltip and accessible name say which PR and what state, and it draws the open mark',
            openGlyph?.title === 'Pull request #12 open' && openGlyph?.label === 'Pull request #12 open' && openGlyph?.icon === 'pull-request',
            JSON.stringify(openGlyph)
        );
        rec.check('it sits on its own workspace\'s row', openGlyph?.inRow?.toLowerCase() === String(workspaceID).toLowerCase(), String(openGlyph?.inRow));

        const calls = d.ghCalls(sandbox);
        const prCall = calls.find((args) => args[0] === 'pr' && args.includes('--head=feat-x'));
        rec.check(
            'the daemon asked gh for this branch on origin, and never for the default branch',
            prCall !== undefined && prCall.includes('--repo=github.com/acme/widgets') && prCall.includes('--state=all') &&
                !calls.some((args) => args.includes('--head=main')),
            JSON.stringify(calls)
        );

        const entry = await listed();
        rec.check(
            '`workspace list --json` carries the same PR',
            JSON.stringify(entry?.pull_requests) ===
                JSON.stringify([{ branch: 'feat-x', number: 12, repo_id: entry?.repos?.[0]?.repo_id, state: 'open', title: `Add the widget catalogue ${TAG}`, url: 'https://github.com/acme/widgets/pull/12' }]),
            JSON.stringify(entry?.pull_requests)
        );

        // ── the inspector lists it as a link ─────────────────────────────────────────────
        await page.click(`[data-testid="workspace-row"][data-workspace-id="${String(workspaceID)}"]`);
        if (!(await page.eval(`document.querySelector('[data-testid="inspector"]') !== null`))) {
            await page.click('[data-testid="toggle-inspector"]');
        }
        const linked = await d.settleDom(page, `document.querySelector('[data-testid="inspector-pr-link"]') !== null`, { ceilingMs: 8_000 });
        const link = JSON.parse(
            String(
                await page.eval(`(() => {
                    const el = document.querySelector('[data-testid="inspector-pr-link"]');
                    return JSON.stringify(el === null ? null : {
                        href: el.getAttribute('href'),
                        target: el.getAttribute('target'),
                        text: (el.textContent ?? '').trim(),
                        state: el.getAttribute('data-pr-state')
                    });
                })()`)
            )
        );
        rec.check(
            'the inspector lists the PR under its repository, as a link to GitHub that opens outside the window',
            linked && link?.href === 'https://github.com/acme/widgets/pull/12' && link?.target === '_blank' &&
                link?.text === `#12Add the widget catalogue ${TAG}` && link?.state === 'open',
            JSON.stringify(link)
        );
        await rec.shot(page, 'open-pr-row-and-inspector');
        rec.note(
            'EYES open-pr-row-and-inspector: the new workspace\'s sidebar row ends in a green pull-request mark, and the inspector\'s Repositories section lists "#12 Add the widget catalogue" with the same green mark under the widgets repo.'
        );

        // ── off: the glyph goes; on: it looks again and finds it merged ──────────────────
        d.scriptGh(sandbox, {
            loggedIn: true,
            pulls: { 'feat-x': [wirePR(12, 'MERGED', tip), wirePR(13, 'OPEN', tip, { owner: 'someone-else', title: 'A fork\'s feat-x' })] }
        });
        await setPrStatus(false);
        rec.check(
            'turned off, the row\'s glyph and the inspector\'s link go at once',
            await d.settleDom(page, `document.querySelector('${row()}') === null && document.querySelector('[data-testid="inspector-pr-link"]') === null`, { ceilingMs: 8_000 })
        );
        rec.check('and `workspace list --json` has no pull_requests', (await listed())?.pull_requests === undefined);

        await setPrStatus(true);
        const merged = await d.settle(async () => (await glyph())?.state === 'merged', { ceilingMs: 20_000, intervalMs: 150 });
        const mergedGlyph = await glyph();
        rec.check(
            'turned on, it looks again at once and the row shows the PR merged (a fork\'s open PR on a branch of the same name does not count)',
            merged && mergedGlyph?.title === 'Pull request #12 merged' && mergedGlyph?.icon === 'pull-request-merged',
            JSON.stringify(mergedGlyph)
        );
        rec.check(
            'the inspector\'s link follows',
            await d.settleDom(page, `document.querySelector('[data-testid="inspector-pr-link"]')?.getAttribute('data-pr-state') === 'merged'`, { ceilingMs: 8_000 })
        );
        await rec.shot(page, 'merged-pr-row-and-inspector');
        rec.note(
            'EYES merged-pr-row-and-inspector: the same row now ends in a purple merge mark, and the inspector\'s line for #12 carries the purple mark too. There is no second line for the fork\'s PR #13.'
        );
    } finally {
        d.scriptGh(sandbox, null);
        if (workspaceID !== null) {
            await cli.run(['workspace', 'delete', String(workspaceID), '--force']).catch(() => {});
        }
        if ((await page.eval(`document.querySelector('[data-testid="inspector"]') !== null`)) !== inspectorAtStart) {
            await page.click('[data-testid="toggle-inspector"]').catch(() => {});
        }
        if (originalKelpi !== null && readKelpi() !== originalKelpi) fs.writeFileSync(sandbox.configPath, originalKelpi);
    }
}

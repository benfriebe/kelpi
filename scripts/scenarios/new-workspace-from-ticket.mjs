/**
 * docs/integrations.md and shell-ui.md §10.1's From ticket: link GitHub with the device flow, find
 * an issue or a pull request in the New Workspace sheet's ticket picker, and create a workspace
 * from it, with its worktree, its ticket file and its agent's first prompt.
 *
 * GitHub is a STAND-IN, never the real one: `scripts/fixtures/fake-github.cjs` serves the device
 * flow, `GET /user` and the three GraphQL operations the daemon asks, on loopback, and records
 * every request. The sandbox daemon is restarted once with `KELPI_GITHUB_API_URL`,
 * `KELPI_GITHUB_WEB_URL`, `KELPI_GITHUB_CLIENT_ID` and `KELPID_INTEGRATIONS_PATH` pointing at the
 * fake and at a credential file of this run's own (docs/integrations.md §9.1), and restarted
 * again at the end without them.
 *
 * git never leaves the machine either. A bare repository stands in for github.com/acme/api, with
 * `main`, the pull request's head branch and `refs/pull/8/head`. The registered clone's `origin`
 * is `https://github.com/acme/api.git` as written, and a REPO-LOCAL `url.<base>.insteadOf` (global
 * git config is never touched) rewrites every GitHub URL onto a folder of bare repositories, so
 * git uses the bare one for acme/api and finds nothing for any other. The daemon matches the
 * ticket's repository on the URL as written (docs/integrations.md §9.6: a GitHub URL rewritten
 * onto a mirror counts), and fetches from the mirror.
 *
 * The agent is the Phase 1 stand-in (`scripts/fixtures/fake-codex.cjs`), set as the default agent
 * (`new-workspace-agent = codex`) with `agent-codex-command` pointing at it.
 *
 * Steps:
 *   1. Settings ▸ Repositories registers the clone; Settings ▸ Integrations says GitHub is not
 *      connected; Connect shows the fake's user code and an
 *      Open GitHub button, which hands https://github.com/login/device to the shell's external
 *      opener (the harness swallows it); the daemon polls the fake (pending twice, then a token),
 *      verifies it with GET /user and stores it in integrations.json, 0600 in a 0700 folder; the
 *      status turns "Connected as @octo-fake". The token never reaches the window: not a WS
 *      frame, not the DOM, not web storage.
 *   2. ⌥⌘N opens the sheet with the picker up: the three @me lists, a dimmed row for a repository
 *      nobody registered; typed text searches once, after the pause, scoped to `org:acme`; a rate
 *      limit (403, `x-ratelimit-remaining: 0`, `retry-after`) shows the rate-limited state, is
 *      honoured without asking GitHub again, and Try again works once it lifts; a pasted issue URL
 *      is looked up at once.
 *   3. Issue #7 prefills the name, the repository, a worktree on `7-fix-login-timeout` with Update
 *      main, the default agent and a one-line prompt naming `.kelpi/ticket-7.md`; the Tab loop
 *      leads with From ticket… and the ticket's ✕; Create shows the ticket's steps, makes the
 *      worktree off origin/main, writes `.kelpi/ticket-7.md` and `.kelpi/.gitignore` (git status
 *      stays clean), stores the ticket (the Inspector's link row) and leaves the prompt on the
 *      fake codex's composer, unsubmitted.
 *   4. Escape closes the picker first (the caret back on From ticket…), then the sheet.
 *   5. Pull request #8 prefills its head branch with no Update main, shows the pull request's own
 *      steps, and checks out `fix/retry-401` tracking origin's branch at the head commit.
 *   6. Picking #7 again shows "#7 is already open in …" with Switch to it, which switches.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** The source this drives, so `verify.mjs` re-runs it when any hop moves. */
export const covers = [
    'packages/client/src/chrome/TicketPicker.tsx',
    'packages/client/src/chrome/NewWorkspaceSheet.tsx',
    'packages/client/src/chrome/WorktreeCreateProgress.tsx',
    'packages/client/src/chrome/worktree.ts',
    'packages/client/src/chrome/github-links.ts',
    'packages/client/src/chrome/Inspector.tsx',
    'packages/client/src/settings/IntegrationsTab.tsx',
    'packages/client/src/settings/SettingsOverlay.tsx',
    'packages/client/src/features/workspaces-actions.ts',
    'packages/client/src/features/workspaces.tsx',
    'packages/client/src/connection/commands.ts',
    'packages/daemon/src/integrations/',
    'packages/daemon/src/git/pr-checkout.ts',
    'packages/daemon/src/git/ticket-file.ts',
    'packages/daemon/src/git/repo-facts.ts',
    'packages/daemon/src/git/worktree-steps.ts',
    'packages/daemon/src/handlers/app/workspaces.ts',
    'packages/daemon/src/handlers/app/context.ts',
    'packages/daemon/src/store/ticket.ts',
    'packages/daemon/src/ws/integrations.ts',
    'packages/daemon/src/ws/sync.ts',
    'packages/daemon/src/boot/compose.ts',
    'packages/protocol/src/ws/integrations.ts',
    'packages/core/src/tickets/',
    'scripts/fixtures/fake-github.cjs',
    'scripts/fixtures/fake-codex.cjs'
];

/** CDP input has to reach the window for the sheet, its sub-sheet and Settings (see `placement.mjs`). */
export const windowPlacement = 'offscreen';

const FAKE_GITHUB = 'scripts/fixtures/fake-github.cjs';
const FAKE_CODEX = 'scripts/fixtures/fake-codex.cjs';
const SHEET = '[data-testid="new-workspace-sheet"]';
const PICKER = '[data-testid="new-workspace-ticket-picker"]';
const SEARCH = '[data-testid="ticket-picker-search"]';
const NAME = '[aria-label="New workspace name"]';
const AGENT = '[data-testid="new-workspace-agent"]';
const SUBMIT = '[data-testid="new-workspace-submit"]';
const FROM_TICKET = '[data-testid="new-workspace-from-ticket"]';
const ROW = (ref) => `[data-testid="ticket-picker-row-${ref}"]`;
const ISSUE_URL = 'https://github.com/acme/api/issues/7';
const ISSUE_NAME = '#7 Fix login timeout';
const ISSUE_BRANCH = '7-fix-login-timeout';
const ISSUE_PROMPT = `Work on issue #7: Fix login timeout (${ISSUE_URL}). Read @.kelpi/ticket-7.md first, it has the full issue.`;
const PR_NAME = '#8 Retry on 401';
const PR_BRANCH = 'fix/retry-401';
const PR_URL = 'https://github.com/acme/api/pull/8';
const GITHUB_ENV_KEYS = ['KELPI_GITHUB_API_URL', 'KELPI_GITHUB_WEB_URL', 'KELPI_GITHUB_CLIENT_ID', 'KELPID_INTEGRATIONS_PATH'];

/** A single-quoted shell word (the sandbox paths have no quotes, but a path is never trusted). */
const sq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

export default async function ({ page, cli, sandbox, daemon, harness, rec, d, sleep, repoRoot }) {
    if (sandbox === undefined || sandbox === null || cli === undefined || cli === null || daemon === undefined || daemon === null) {
        rec.check('this scenario boots its own sandbox (it restarts the daemon against a fake GitHub)', false, 'run without --attach');
        return;
    }
    const require = createRequire(import.meta.url);
    const { startFakeGitHub } = require(path.join(repoRoot, FAKE_GITHUB));

    // ── fixtures: the stand-in for github.com/acme/api, and the clone Kelpi registers ──────────
    const root = fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'ticket-')));
    // Hermetic git for the fixture's own commands: the sandbox HOME, no system config, no prompt.
    const gitEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: sandbox.home,
        XDG_CONFIG_HOME: path.join(sandbox.home, '.config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'kelpi-scenario',
        GIT_AUTHOR_EMAIL: 'scenario@example.com',
        GIT_COMMITTER_NAME: 'kelpi-scenario',
        GIT_COMMITTER_EMAIL: 'scenario@example.com'
    };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
    const gitOr = (cwd, fallback, ...args) => {
        try {
            return git(cwd, ...args);
        } catch {
            return fallback;
        }
    };
    const bare = path.join(root, 'remotes', 'acme', 'api.git');
    const seed = path.join(root, 'seed');
    const clone = path.join(root, 'api');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    git(root, 'init', '-q', '--bare', '--initial-branch=main', bare);
    git(root, 'init', '-q', '--initial-branch=main', seed);
    fs.writeFileSync(path.join(seed, 'README.md'), '# api\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'first');
    git(seed, 'push', '-q', bare, 'main');
    git(seed, 'checkout', '-q', '-b', PR_BRANCH);
    fs.mkdirSync(path.join(seed, 'src'));
    fs.writeFileSync(path.join(seed, 'src', 'auth.ts'), 'export const retries = 1;\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'Retry once on 401');
    git(seed, 'push', '-q', bare, `${PR_BRANCH}:refs/heads/${PR_BRANCH}`, `${PR_BRANCH}:refs/pull/8/head`);
    git(seed, 'checkout', '-q', 'main');
    git(root, 'clone', '-q', bare, clone);
    // The commit an issue's worktree must be cut from: on the "GitHub" side, not yet in the clone.
    fs.writeFileSync(path.join(seed, 'CHANGELOG.md'), 'latest\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'latest on main');
    git(seed, 'push', '-q', bare, 'main');
    const mainSha = git(bare, 'rev-parse', 'main');
    const prHeadSha = git(bare, 'rev-parse', `refs/heads/${PR_BRANCH}`);

    // `https://github.com/<owner>/<name>.git` is the bare repository `remotes/<owner>/<name>.git`,
    // for this clone only. Every GitHub URL is rewritten (a fork's, any other), so git cannot
    // reach the network from it: anything but acme/api names a folder that does not exist.
    const mirror = `${path.join(root, 'remotes')}/`;
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/api.git');
    for (const github of ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']) git(clone, 'config', '--add', `url.${mirror}.insteadOf`, github);
    // A beat in every fetch, so the sheet's fetch step is seen running (a local fetch is instant).
    git(clone, 'config', 'remote.origin.uploadpack', 'sleep 1; git-upload-pack');
    const remoteV = git(clone, 'remote', '-v');
    rec.check(
        'fixture: origin is https://github.com/acme/api.git as written, the bare repository after the repo-local insteadOf',
        git(clone, 'config', 'remote.origin.url') === 'https://github.com/acme/api.git' && remoteV.includes(`${bare} (fetch)`),
        remoteV
    );
    rec.check(
        'fixture: any other GitHub URL resolves to a local folder too, never the network',
        git(clone, 'ls-remote', '--get-url', 'https://github.com/other-org/tools.git') === path.join(root, 'remotes', 'other-org', 'tools.git') &&
            git(clone, 'ls-remote', '--get-url', 'git@github.com:acme/api.git') === bare,
        git(clone, 'ls-remote', '--get-url', 'https://github.com/other-org/tools.git')
    );
    rec.check('fixture: the bare repository is one commit ahead of the clone', git(clone, 'rev-parse', 'origin/main') !== mainSha, `${git(clone, 'rev-parse', 'origin/main')} vs ${mainSha}`);
    rec.note(`fixtures: bare ${bare}, clone ${clone}, main ${mainSha.slice(0, 8)}, PR head ${prHeadSha.slice(0, 8)}`);

    // The fake codex behind a wrapper that gives every launch its own directory (Phase 1's).
    const launches = path.join(root, 'launches.txt');
    fs.writeFileSync(launches, '');
    const codexWrapper = path.join(root, 'bin', 'fake-codex');
    fs.mkdirSync(path.dirname(codexWrapper), { recursive: true });
    fs.writeFileSync(
        codexWrapper,
        '#!/bin/sh\n' +
            '# Test fixture: the fake codex, with a state directory of its own for this launch.\n' +
            `dir=${sq(path.join(root, 'launch-'))}"$$"\n` +
            `printf '%s\\t%s\\n' "$dir" "$PWD" >> ${sq(launches)}\n` +
            `KELPI_FAKE_AGENT_DIR="$dir" exec ${sq(process.execPath)} ${sq(path.join(repoRoot, FAKE_CODEX))} "$@"\n`,
        { mode: 0o755 }
    );
    const launchRows = () =>
        fs
            .readFileSync(launches, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [dir, cwd] = line.split('\t');
                return { dir, cwd };
            });
    const fakeState = (dir) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        } catch {
            return null;
        }
    };

    // ── the fake GitHub, and the daemon pointed at it ──────────────────────────────────────────
    const fakeLog = path.join(root, 'github-requests.json');
    const fake = await startFakeGitHub({ logFile: fakeLog, prHeadSha });
    const credentialsDir = path.join(root, 'credentials');
    const credentialsFile = path.join(credentialsDir, 'integrations.json');
    const requests = () => fake.requests();
    const searches = () => requests().filter((entry) => entry.operation === 'KelpiTicketSearch');
    const resolves = () => requests().filter((entry) => entry.operation === 'KelpiTicketResolve');

    const originalConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    const originalEnv = Object.fromEntries(GITHUB_ENV_KEYS.map((key) => [key, sandbox.env[key]]));
    const originalClipboard = String((await harness.clipboardRead()).text ?? '');
    const listed = async () => JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const homeID = (await listed()).find((workspace) => workspace.is_active === true)?.id ?? null;
    const created = [];
    let repoID = null;
    let inspectorOpened = false;
    const frames = [];
    const offFrames = [];

    // ── helpers ────────────────────────────────────────────────────────────────────────────
    const connection = () => page.eval(`document.querySelector('[data-connection]')?.getAttribute('data-connection') ?? null`);
    /** Restart the daemon (its env is `sandbox.env`, read at every start) and wait for the window to come back. */
    const restartDaemon = async () => {
        await page.eval(`(() => {
            const root = document.querySelector('[data-connection]');
            globalThis.__ticketRestartTrail = [];
            if (root === null) return;
            new MutationObserver(() => globalThis.__ticketRestartTrail.push(root.getAttribute('data-connection')))
                .observe(root, { attributes: true, attributeFilter: ['data-connection'] });
        })()`);
        await daemon.restart();
        return d.settleDom(
            page,
            `globalThis.__ticketRestartTrail.some(state => state !== 'connected') && document.querySelector('[data-connection]')?.getAttribute('data-connection') === 'connected'`,
            { ceilingMs: 30_000 }
        );
    };
    const testID = (id) => `[data-testid="${id}"]`;
    /** The sheet scrolls once a ticket fills it: bring a control into its view before pressing it. */
    const press = async (selector) => {
        await page.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' })`);
        await sleep(50);
        return page.click(selector);
    };
    const textOf = async (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);
    const exists = async (selector) => (await page.eval(`document.querySelector(${JSON.stringify(selector)}) !== null`)) === true;
    const closeSettings = async () => {
        if (!(await exists(d.PAGE.settingsPanel))) return true;
        await page.click('[data-testid="settings-close"]');
        return d.settleDom(page, `document.querySelector('${d.PAGE.settingsPanel}') === null`, { ceilingMs: 3_000 });
    };
    const sheet = async () =>
        JSON.parse(
            String(
                await page.eval(`(() => {
                    const q = (id) => document.querySelector('[data-testid="' + id + '"]');
                    const chip = q('new-workspace-ticket');
                    const active = document.activeElement;
                    return JSON.stringify({
                        open: q('new-workspace-sheet') !== null,
                        picker: q('new-workspace-ticket-picker') !== null,
                        fromTicket: q('new-workspace-from-ticket') !== null,
                        name: document.querySelector('${NAME}')?.value ?? null,
                        chip: chip === null ? null : { kind: chip.getAttribute('data-kind'), text: chip.innerText.replace(/\\s+/g, ' ').trim() },
                        existing: q('new-workspace-ticket-existing')?.innerText?.replace(/\\s+/g, ' ').trim() ?? null,
                        warnings: Array.from(document.querySelectorAll('[data-testid="new-workspace-ticket-warning"]')).map(el => el.textContent),
                        repos: Array.from(document.querySelectorAll('[data-testid^="new-workspace-repo-remove-"]')).map(el => el.getAttribute('data-testid').slice('new-workspace-repo-remove-'.length)),
                        worktree: q('new-workspace-worktree-toggle')?.checked ?? null,
                        worktreeName: q('new-workspace-worktree-name')?.value ?? null,
                        branch: q('new-workspace-worktree-branch')?.value ?? null,
                        updateMain: q('new-workspace-worktree-update-main')?.checked ?? null,
                        agent: q('new-workspace-agent')?.value ?? null,
                        prompt: q('new-workspace-agent-prompt')?.value ?? null,
                        send: q('new-workspace-agent-send')?.checked ?? null,
                        error: q('new-workspace-error')?.innerText ?? null,
                        focus: active?.getAttribute('data-testid') ?? active?.getAttribute('aria-label') ?? null
                    });
                })()`)
            )
        );
    const picker = async () =>
        JSON.parse(
            String(
                await page.eval(`(() => {
                    const root = document.querySelector('[data-testid="ticket-picker"]');
                    if (root === null) return 'null';
                    const search = root.querySelector('${SEARCH}');
                    const problem = root.querySelector('[data-testid="ticket-picker-problem"]');
                    return JSON.stringify({
                        query: search?.value ?? null,
                        focused: document.activeElement === search,
                        sections: Array.from(root.querySelectorAll('[data-testid^="ticket-picker-section-"]')).map(el => ({
                            id: el.getAttribute('data-testid').slice('ticket-picker-section-'.length),
                            title: el.firstElementChild?.textContent ?? '',
                            rows: Array.from(el.querySelectorAll('[data-testid^="ticket-picker-row-"]')).map(row => ({
                                ref: row.getAttribute('data-testid').slice('ticket-picker-row-'.length),
                                pickable: row.getAttribute('data-pickable') === 'true',
                                text: row.innerText.replace(/\\s+/g, ' ').trim()
                            }))
                        })),
                        loading: root.querySelector('[data-testid="ticket-picker-loading"]') !== null,
                        short: root.querySelector('[data-testid="ticket-picker-short"]') !== null,
                        resolving: root.querySelector('[data-testid="ticket-picker-resolving"]')?.innerText ?? null,
                        problem: problem === null ? null : {
                            code: problem.getAttribute('data-code'),
                            title: problem.querySelector('[data-testid="ticket-picker-problem-title"]')?.textContent ?? '',
                            text: problem.innerText.replace(/\\s+/g, ' ').trim(),
                            buttons: Array.from(problem.querySelectorAll('button')).map(b => b.getAttribute('data-testid'))
                        }
                    });
                })()`)
            )
        );
    const sectionRows = (state, id) => state?.sections.find((section) => section.id === id)?.rows ?? null;
    const pressFromTicketChord = () => page.key('KeyN', { modifiers: d.MOD.alt | d.MOD.meta, key: 'n', keyCode: 78 });
    /** The picker is a native <select>: its popup is the OS's, so the value is set as a choice would set it. */
    const chooseAgent = async (label) =>
        page.eval(`(() => {
            const el = document.querySelector('${AGENT}');
            const option = Array.from(el?.options ?? []).find(o => o.text === ${JSON.stringify(label)});
            if (el === null || option === undefined) return false;
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
    const workspaceNamed = async (name) => {
        let found;
        await d.settle(async () => {
            found = (await listed()).find((workspace) => workspace.name === name);
            return found !== undefined;
        }, { ceilingMs: 20_000, intervalMs: 200 });
        if (found !== undefined && !created.includes(found.id)) created.push(found.id);
        return found;
    };
    const activeWorkspaceID = async () => (await listed()).find((workspace) => workspace.is_active === true)?.id ?? null;
    const firstPane = async (workspaceID) => {
        let pane;
        await d.settle(async () => {
            pane = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']))[0];
            return pane !== undefined;
        }, { ceilingMs: 15_000, intervalMs: 200 });
        return pane?.id ?? null;
    };
    const worktreeOf = (branch) => {
        const blocks = git(clone, 'worktree', 'list', '--porcelain').split('\n\n');
        const block = blocks.find((entry) => entry.split('\n').includes(`branch refs/heads/${branch}`));
        return block === undefined ? null : block.split('\n')[0].slice('worktree '.length);
    };
    /** Record every step row the progress panel draws, with its label and status, from now on. */
    const watchSteps = () =>
        page.eval(`(() => {
            globalThis.__ticketSteps?.observer?.disconnect();
            const seen = [];
            const last = new Map();
            const read = () => {
                for (const li of document.querySelectorAll('li[data-testid^="new-workspace-step-"]')) {
                    const id = li.getAttribute('data-testid').slice('new-workspace-step-'.length);
                    const status = li.getAttribute('data-status');
                    const label = li.querySelector('span.shrink-0:not([aria-hidden])')?.textContent ?? '';
                    // Every change of a row, in order: a re-plan may relabel one mid-create.
                    if (last.get(id) === status + '|' + label) continue;
                    last.set(id, status + '|' + label);
                    seen.push({ id, status, label });
                }
            };
            const observer = new MutationObserver(read);
            observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
            globalThis.__ticketSteps = { seen, observer };
            read();
        })()`);
    const stepsSeen = async () =>
        JSON.parse(String(await page.eval(`(() => { const s = globalThis.__ticketSteps; s?.observer?.disconnect(); return JSON.stringify(s?.seen ?? []); })()`)));
    const stepOrder = (seen) => [...new Set(seen.map((entry) => entry.id))];
    /** Every label a step was drawn with, in order of appearance. */
    const labelsOf = (seen, id) => [...new Set(seen.filter((entry) => entry.id === id).map((entry) => entry.label))];
    /** The label a step was last drawn with. */
    const labelOf = (seen, id) => seen.filter((entry) => entry.id === id).at(-1)?.label ?? null;
    const reached = (seen, id, status, label) => seen.some((entry) => entry.id === id && entry.status === status && (label === undefined || entry.label === label));
    /** The launcher's one outcome line per launch (`launcher.ts` ▸ `finish`). */
    const outcomeIn = (paneID) => new RegExp(`agent launch: pane ${paneID} \\(codex\\) (launched|sent|prefilled|fallback|failed)(?: \\(([\\w-]+)\\))?`).exec(daemon.text());
    /** ⌘V exactly as Chromium delivers it on macOS: the chord AND the editing command. */
    const pasteChord = async () => {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyV', key: 'v', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: d.MOD.meta, commands: ['paste'] });
        await sleep(40);
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyV', key: 'v', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: d.MOD.meta });
    };

    try {
        // ── 0 · the daemon, against the fake ─────────────────────────────────────────────────
        // Phase 1's agent setup, as config: the stand-in codex, and Codex as the sheet's default.
        fs.writeFileSync(
            sandbox.configPath,
            `${originalConfig.replace(/\n?$/, '\n')}agent-codex-command = ${codexWrapper}\nnew-workspace-agent = codex\n`
        );
        Object.assign(sandbox.env, {
            KELPI_GITHUB_API_URL: fake.apiURL,
            KELPI_GITHUB_WEB_URL: fake.webURL,
            KELPI_GITHUB_CLIENT_ID: fake.clientID,
            KELPID_INTEGRATIONS_PATH: credentialsFile
        });
        rec.check('the daemon restarts with the fake GitHub and the window reconnects', await restartDaemon(), String(await connection()));
        const notes = daemon.text();
        rec.check(
            'the daemon logs that GitHub API and web requests go to the fake (and nowhere else)',
            notes.includes(`integrations: GitHub API requests go to ${fake.apiURL} (KELPI_GITHUB_API_URL)`) &&
                notes.includes(`integrations: GitHub web requests go to ${fake.webURL} (KELPI_GITHUB_WEB_URL)`),
            notes.split('\n').filter((line) => line.includes('integrations:')).join(' | ')
        );

        // Every frame the window sends or receives from here on: the token must be in none of them.
        await page.send('Network.enable');
        offFrames.push(
            page.on('Network.webSocketFrameReceived', ({ response }) => frames.push({ dir: 'in', data: String(response?.payloadData ?? '') })),
            page.on('Network.webSocketFrameSent', ({ response }) => frames.push({ dir: 'out', data: String(response?.payloadData ?? '') }))
        );

        // ── 1 · Settings: register the clone, then link GitHub with the device flow ─────────────
        await d.openSettingsTab(page, 'repositories');
        await page.click('[data-testid="repo-path"]');
        await page.insertText(clone);
        await page.click('[data-testid="repo-add"]');
        const repoRow = await d.settle(async () => {
            repoID = await page.eval(
                `(Array.from(document.querySelectorAll('[data-testid^="repo-row-"]')).find(el => (el.innerText ?? '').split('\\n')[0].trim() === 'api')?.getAttribute('data-testid') ?? '').slice('repo-row-'.length) || null`
            );
            return typeof repoID === 'string' && repoID !== '';
        }, { ceilingMs: 10_000, intervalMs: 200 });
        rec.check('Settings ▸ Repositories registers the clone', repoRow, String(repoID));

        await page.click('[data-testid="settings-tab-button-integrations"]');
        rec.check('Settings ▸ Integrations opens', await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-integrations"]') !== null`, { ceilingMs: 3_000 }));
        rec.check('GitHub is not connected', (await textOf(testID('integrations-github-status-line'))) === 'Not connected', String(await textOf(testID('integrations-github-status-line'))));
        // Not a check: the list reads the registry's `remote_url` (`git remote get-url origin`, after
        // insteadOf), so a GitHub remote rewritten onto a mirror is listed as not searched, while
        // search and resolve DO match it (step 2 sees `org:acme`). Recorded for the reader.
        rec.note(`Searchable repositories: ${String(await textOf(testID('integrations-repos'))).replace(/\s+/g, ' ')}`);
        rec.check('Connect… is offered (the build has a client ID: the fake’s)', await exists(testID('integrations-github-connect-button')));
        await page.click(testID('integrations-github-connect-button'));
        const codeShown = await d.settleDom(page, `document.querySelector('[data-testid="integrations-github-user-code"]')?.textContent === ${JSON.stringify(fake.userCode)}`, { ceilingMs: 10_000 });
        rec.check('Connect shows the fake’s user code', codeShown, String(await textOf(testID('integrations-github-user-code'))));
        rec.check('…with Open GitHub, Copy, Cancel and a countdown', (await exists(testID('integrations-github-open'))) && (await exists(testID('integrations-github-copy'))) && (await exists(testID('integrations-github-cancel'))) && /expires in \d+:\d\d/.test(String(await textOf(testID('integrations-github-countdown')))));
        await rec.shot(page, 'integrations-device-code');
        const opensBefore = await harness.counters();
        await page.click(testID('integrations-github-open'));
        const opened = await d.settle(async () => (await harness.counters()).externalOpens > opensBefore.externalOpens, { ceilingMs: 5_000, intervalMs: 100 });
        const opensAfter = await harness.counters();
        rec.check(
            'Open GitHub hands https://github.com/login/device to the shell’s external opener (the harness swallows it: no browser opens)',
            opened && opensAfter.externalOpens === opensBefore.externalOpens + 1 && opensAfter.lastExternalUrl === 'https://github.com/login/device',
            `${String(opensBefore.externalOpens)} -> ${String(opensAfter.externalOpens)}, ${String(opensAfter.lastExternalUrl)}`
        );
        const connected = await d.settleDom(page, `document.querySelector('[data-testid="integrations-github-status-line"]')?.textContent === 'Connected as @${fake.viewer}'`, { ceilingMs: 45_000 });
        rec.check(`the daemon completes the device flow: "Connected as @${fake.viewer}"`, connected, String(await textOf(testID('integrations-github-status-line'))));
        const statusDetail = String(await textOf(testID('integrations-github-status')));
        rec.check('…signed in with GitHub, scopes repo; the code is gone and Disconnect is offered', statusDetail.includes('Signed in with GitHub.') && statusDetail.includes('Scopes: repo.') && !(await exists(testID('integrations-github-user-code'))) && (await exists(testID('integrations-github-disconnect-button'))), statusDetail);
        await rec.shot(page, 'integrations-connected');
        const flow = requests().filter((entry) => entry.base === 'web' || entry.operation === 'GET /user');
        rec.check(
            'the daemon asked the fake: device code, the token twice pending then issued, then GET /user',
            JSON.stringify(flow.map((entry) => `${entry.operation}:${entry.note ?? entry.status}`)) ===
                JSON.stringify(['device-code:200', 'access-token:authorization_pending', 'access-token:authorization_pending', 'access-token:token issued', 'GET /user:200']),
            JSON.stringify(flow.map((entry) => [entry.operation, entry.note ?? entry.status]))
        );
        const polls = flow.filter((entry) => entry.operation === 'access-token').map((entry) => entry.at);
        rec.check('…polling no faster than every 5 s', polls.length === 3 && polls.slice(1).every((at, index) => at - polls[index] >= 4_900), JSON.stringify(polls.map((at) => at - polls[0])));
        const stored = (() => {
            try {
                return JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
            } catch {
                return null;
            }
        })();
        const fileMode = fs.existsSync(credentialsFile) ? fs.statSync(credentialsFile).mode & 0o777 : null;
        const dirMode = fs.existsSync(credentialsDir) ? fs.statSync(credentialsDir).mode & 0o777 : null;
        rec.check(
            'integrations.json holds the token as an OAuth link for the fake login, bound to the fake’s endpoints, 0600 in a 0700 folder',
            stored?.v === 1 &&
                stored.accounts?.[0]?.login === fake.viewer &&
                stored.accounts[0].how === 'oauth' &&
                stored.accounts[0].credential?.accessToken === fake.token &&
                stored.accounts[0].endpoints?.api === fake.apiURL &&
                stored.accounts[0].endpoints?.web === fake.webURL &&
                fileMode === 0o600 &&
                dirMode === 0o700,
            `mode ${fileMode?.toString(8)}, dir ${dirMode?.toString(8)}, login ${String(stored?.accounts?.[0]?.login)}, how ${String(stored?.accounts?.[0]?.how)}, endpoints ${JSON.stringify(stored?.accounts?.[0]?.endpoints)}`
        );
        const clientLeak = await page.eval(`(() => {
            const token = ${JSON.stringify(fake.token)};
            const stores = [localStorage, sessionStorage].flatMap(s => Object.keys(s).map(k => k + '=' + s.getItem(k)));
            return document.documentElement.outerHTML.includes(token) || stores.some(entry => entry.includes(token));
        })()`);
        rec.check('the token is nowhere in the window: not the DOM, not local or session storage', clientLeak === false);
        rec.check('the window saw the user code over its socket (the frame capture works)', frames.some((frame) => frame.dir === 'in' && frame.data.includes(fake.userCode)), `${String(frames.length)} frames`);
        rec.check('Settings closes', await closeSettings());

        // ── 2 · ⌥⌘N: the picker, its lists, a typed search, a rate limit, a pasted link ─────────
        const searchesBefore = searches().length;
        await pressFromTicketChord();
        const pickerUp = await d.settleDom(page, `document.querySelector('${SHEET}') !== null && document.querySelector('${PICKER}') !== null && document.activeElement === document.querySelector('${SEARCH}')`, { ceilingMs: 5_000 });
        rec.check('⌥⌘N opens New Workspace with the ticket picker up, the caret in its search field', pickerUp, JSON.stringify(await sheet()));
        const listsUp = await d.settle(async () => (await picker())?.sections.length === 3, { ceilingMs: 10_000, intervalMs: 100 });
        const lists = await picker();
        rec.check(
            'the empty query shows the three @me lists, in order, from the fake',
            listsUp &&
                JSON.stringify(lists.sections.map((section) => [section.id, section.title])) ===
                    JSON.stringify([['authored', 'Your open pull requests'], ['review-requested', 'Waiting for your review'], ['assigned', 'Issues assigned to you']]),
            JSON.stringify(lists?.sections.map((section) => [section.id, section.title]))
        );
        const authored = sectionRows(lists, 'authored')?.[0];
        const review = sectionRows(lists, 'review-requested')?.[0];
        const assigned = sectionRows(lists, 'assigned')?.[0];
        rec.check('…your pull request #8, pickable, as PR · #8 · title · acme/api · author', authored?.ref === 'acme/api#8' && authored.pickable && /^pr\b/i.test(authored.text) && authored.text.includes('#8') && authored.text.includes('Retry on 401') && authored.text.includes('acme/api · octo-fake'), JSON.stringify(authored));
        rec.check('…the issue assigned to you, #7, pickable', assigned?.ref === 'acme/api#7' && assigned.pickable && /^issue\b/i.test(assigned.text) && assigned.text.includes('#7') && assigned.text.includes('Fix login timeout') && assigned.text.includes('acme/api · reporter-one'), JSON.stringify(assigned));
        rec.check(
            '…and a review request in a repository nobody registered: dimmed, not pickable, saying what to do',
            review?.ref === 'other-org/tools#3' && review.pickable === false && review.text.includes('Add other-org/tools in Settings ▸ Repositories to start a workspace from it.'),
            JSON.stringify(review)
        );
        const firstSearch = searches().slice(searchesBefore);
        rec.check(
            'the daemon asked ONE GraphQL search for the three lists, each as a variable',
            firstSearch.length === 1 &&
                JSON.stringify(firstSearch[0].variables) ===
                    JSON.stringify({
                        q0: 'is:open is:pr author:@me archived:false sort:updated-desc',
                        q1: 'is:open is:pr review-requested:@me archived:false sort:updated-desc',
                        q2: 'is:open is:issue assignee:@me archived:false sort:updated-desc'
                    }),
            JSON.stringify(firstSearch.map((entry) => entry.variables))
        );
        await rec.shot(page, 'picker-default-lists');

        // Typed text: one search, 300 ms after the last keystroke, from two characters.
        const typedFrom = requests().length;
        await page.insertText('l');
        rec.check('one character asks for more instead of searching', await d.settleDom(page, `document.querySelector('[data-testid="ticket-picker-short"]') !== null`, { ceilingMs: 2_000 }));
        for (const char of 'ogin') {
            await sleep(70);
            await page.insertText(char);
        }
        const typedUp = await d.settle(async () => (sectionRows(await picker(), 'results') ?? []).some((row) => row.ref === 'acme/api#7'), { ceilingMs: 10_000, intervalMs: 100 });
        rec.check('typing "login" lists issue #7 under Results', typedUp, JSON.stringify(await picker()));
        const typed = requests().slice(typedFrom);
        const typedSearches = typed.filter((entry) => entry.operation === 'KelpiTicketSearch');
        rec.check(
            'debounced: exactly one search reached GitHub, for the whole word, scoped to org:acme',
            typedSearches.length === 1 && typedSearches[0].variables?.q0 === 'login in:title is:open archived:false sort:updated-desc org:acme',
            JSON.stringify(typedSearches.map((entry) => entry.variables))
        );
        rec.check(
            '…after asking once whether acme is an organization or a user',
            JSON.stringify(typed.filter((entry) => entry.operation === 'KelpiOwners').map((entry) => entry.variables)) === JSON.stringify([{ o0: 'acme' }]),
            JSON.stringify(typed.map((entry) => entry.operation))
        );

        // A rate limit, for one search: the state, its way out, and the daemon honouring it.
        fake.armRateLimit({ operation: 'KelpiTicketSearch', retryAfterS: 3 });
        await page.eval(`document.querySelector('${SEARCH}')?.select()`);
        await page.insertText('timeout');
        const limited = await d.settle(async () => (await picker())?.problem?.code === 'rate-limited', { ceilingMs: 10_000, intervalMs: 100 });
        const limitState = await picker();
        rec.check(
            'a 403 with x-ratelimit-remaining: 0 and retry-after shows the rate-limited state, when to retry, and Try again',
            limited &&
                limitState.problem.title === 'GitHub’s rate limit is used up' &&
                limitState.problem.text.includes('Try again in 3 s.') &&
                JSON.stringify(limitState.problem.buttons) === JSON.stringify(['ticket-picker-problem-retry']),
            JSON.stringify(limitState?.problem)
        );
        await rec.shot(page, 'picker-rate-limited');
        const timeoutAsks = () => searches().filter((entry) => String(entry.variables?.q0 ?? '').startsWith('timeout '));
        rec.check('…GitHub was asked once, and answered with the limit', timeoutAsks().length === 1 && timeoutAsks()[0].status === 403, JSON.stringify(timeoutAsks().map((entry) => entry.status)));
        await press(testID('ticket-picker-problem-retry'));
        await sleep(600);
        rec.check(
            'Try again before the limit lifts is refused by the daemon itself: still rate-limited, GitHub not asked',
            timeoutAsks().length === 1 && (await picker())?.problem?.code === 'rate-limited',
            JSON.stringify({ asks: timeoutAsks().length, problem: (await picker())?.problem })
        );
        await sleep(3_200);
        await press(testID('ticket-picker-problem-retry'));
        const recovered = await d.settle(async () => {
            const state = await picker();
            return state?.problem === null && (sectionRows(state, 'results') ?? []).some((row) => row.ref === 'acme/api#7');
        }, { ceilingMs: 10_000, intervalMs: 100 });
        rec.check('once it lifts, Try again searches again and lists #7', recovered && timeoutAsks().length === 2 && timeoutAsks()[1].status === 200, JSON.stringify(await picker()));

        // A pasted link is looked up at once: no search, no row to pick.
        const pasteFrom = requests().length;
        const seeded = String((await harness.clipboardWrite(ISSUE_URL)).text);
        rec.check('the clipboard holds the issue URL', seeded === ISSUE_URL, seeded);
        await page.eval(`document.querySelector('${SEARCH}')?.select()`);
        await pasteChord();
        const pastedResolved = await d.settleDom(page, `document.querySelector('${PICKER}') === null && document.querySelector('[data-testid="new-workspace-ticket"]') !== null`, { ceilingMs: 15_000 });
        const afterPaste = requests().slice(pasteFrom);
        rec.check('pasting https://github.com/acme/api/issues/7 resolves it at once and closes the picker', pastedResolved, JSON.stringify(await sheet()));
        rec.check(
            '…one KelpiTicketResolve for acme/api #7, and no search for the pasted text',
            JSON.stringify(afterPaste.map((entry) => [entry.operation, entry.variables])) === JSON.stringify([['KelpiTicketResolve', { owner: 'acme', name: 'api', number: 7 }]]),
            JSON.stringify(afterPaste.map((entry) => [entry.operation, entry.variables]))
        );

        // ── 3 · issue #7: the prefill, the Tab loop, the create ───────────────────────────────
        const prefilled = await sheet();
        rec.note(`prefilled sheet: ${JSON.stringify(prefilled)}`);
        rec.check('the ticket chip names Issue #7, its title and acme/api', prefilled.chip?.kind === 'issue' && prefilled.chip.text.includes('#7') && prefilled.chip.text.includes('Fix login timeout') && prefilled.chip.text.includes('acme/api'), JSON.stringify(prefilled.chip));
        rec.check('the name is "#7 Fix login timeout", with the caret in it', prefilled.name === ISSUE_NAME && prefilled.focus === 'New workspace name', JSON.stringify([prefilled.name, prefilled.focus]));
        rec.check('the repository is the registered clone, the only one chosen', JSON.stringify(prefilled.repos) === JSON.stringify([repoID]), JSON.stringify(prefilled.repos));
        rec.check(
            `a worktree is on, named and branched ${ISSUE_BRANCH}, with Update main ticked`,
            prefilled.worktree === true && prefilled.worktreeName === ISSUE_BRANCH && prefilled.branch === ISSUE_BRANCH && prefilled.updateMain === true,
            JSON.stringify([prefilled.worktree, prefilled.worktreeName, prefilled.branch, prefilled.updateMain])
        );
        rec.check('the agent is Codex, the default this run set', prefilled.agent === 'codex', String(prefilled.agent));
        rec.check(
            'the prompt is one line naming .kelpi/ticket-7.md, and Send immediately is off',
            prefilled.prompt === ISSUE_PROMPT && !prefilled.prompt.includes('\n') && prefilled.send === false,
            JSON.stringify([prefilled.prompt, prefilled.send])
        );
        await rec.shot(page, 'sheet-prefilled-issue');

        // The Tab loop, derived from what is on screen in the documented order (shell-ui.md §10.1).
        const stops = JSON.parse(
            String(
                await page.eval(`(() => {
                    const has = (id) => document.querySelector('[data-testid="' + id + '"]') !== null;
                    const order = ['new-workspace-from-ticket', 'new-workspace-ticket-clear'];
                    if (has('new-workspace-ticket-switch')) order.push('new-workspace-ticket-switch');
                    order.push('New workspace name', 'new-workspace-colors');
                    if (has('new-workspace-group')) order.push('new-workspace-group');
                    order.push('new-workspace-profile', 'new-workspace-muted');
                    for (const el of document.querySelectorAll('[data-testid^="new-workspace-repo-remove-"]')) order.push(el.getAttribute('data-testid'));
                    order.push('new-workspace-add-repo', 'new-workspace-worktree-toggle', 'new-workspace-worktree-name', 'new-workspace-worktree-branch',
                        'new-workspace-worktree-update-main', 'new-workspace-agent', 'new-workspace-agent-prompt', 'new-workspace-agent-send',
                        'new-workspace-cancel', 'new-workspace-submit');
                    return JSON.stringify(order);
                })()`)
            )
        );
        const nameAt = stops.indexOf('New workspace name');
        const walked = [];
        for (let step = 0; step < stops.length; step += 1) {
            await page.key('Tab', { key: 'Tab' });
            await sleep(60);
            walked.push((await sheet()).focus);
        }
        const expectedWalk = [...stops.slice(nameAt + 1), ...stops.slice(0, nameAt + 1)];
        rec.check(
            'the Tab loop includes From ticket… and the ticket’s ✕, leading the sheet, and wraps',
            JSON.stringify(walked) === JSON.stringify(expectedWalk),
            `${JSON.stringify(walked)} vs ${JSON.stringify(expectedWalk)}`
        );
        rec.check('Tab typed nothing into the prompt', (await sheet()).prompt === ISSUE_PROMPT);

        await watchSteps();
        const issueLaunchesBefore = launchRows().length;
        await press(SUBMIT);
        const issueClosed = await d.settleDom(page, `document.querySelector('${SHEET}') === null`, { ceilingMs: 60_000 });
        rec.check('Create runs and closes the sheet', issueClosed, JSON.stringify(await sheet()));
        const issueSteps = await stepsSeen();
        rec.note(`issue steps: ${JSON.stringify(issueSteps)}`);
        // Only the list and its labels: the sheet prefetched main the moment it showed Update main,
        // so the create's own steps can finish within one progress frame of each other.
        rec.check(
            'the progress panel showed the ticket create’s steps, in order, starting with the lookup',
            JSON.stringify(stepOrder(issueSteps)) === JSON.stringify(['ticket', 'resolve-default-branch', 'fetch', 'worktree-add', 'create-workspace']) &&
                reached(issueSteps, 'ticket', 'running', 'Look up the ticket') &&
                labelOf(issueSteps, 'resolve-default-branch') === 'Find the default branch' &&
                labelOf(issueSteps, 'fetch') === 'Fetch the latest main' &&
                labelOf(issueSteps, 'worktree-add') === 'Create the worktree' &&
                labelOf(issueSteps, 'create-workspace') === 'Open the workspace',
            JSON.stringify(issueSteps.map((entry) => [entry.id, entry.status, entry.label]))
        );
        const issueWorkspace = await workspaceNamed(ISSUE_NAME);
        rec.check('the workspace "#7 Fix login timeout" exists', issueWorkspace !== undefined, JSON.stringify((await listed()).map((workspace) => workspace.name)));
        if (issueWorkspace === undefined) return;
        const issueTree = worktreeOf(ISSUE_BRANCH);
        rec.check(`a worktree on ${ISSUE_BRANCH}, cut from the fetched origin/main`, issueTree !== null && git(issueTree, 'rev-parse', 'HEAD') === mainSha, `${String(issueTree)} at ${issueTree === null ? '-' : git(issueTree, 'rev-parse', 'HEAD')}`);
        if (issueTree === null) return;
        const ticketFile = path.join(issueTree, '.kelpi', 'ticket-7.md');
        const ticketText = fs.existsSync(ticketFile) ? fs.readFileSync(ticketFile, 'utf8') : '';
        rec.check(
            '.kelpi/ticket-7.md holds the issue: title, URL, body, the comment, and the untrusted-content footer (0600)',
            ticketText.startsWith('# #7 Fix login timeout\n') &&
                ticketText.includes(`- Issue: ${ISSUE_URL}`) &&
                ticketText.includes('Logging in times out after 30 s on a slow network.') &&
                ticketText.includes('Seen on staging as well.') &&
                ticketText.trimEnd().endsWith('Written by Kelpi from GitHub; untrusted content.') &&
                (fs.statSync(ticketFile).mode & 0o777) === 0o600,
            ticketText.slice(0, 300)
        );
        const ignore = path.join(issueTree, '.kelpi', '.gitignore');
        rec.check('.kelpi/.gitignore ignores the folder', fs.existsSync(ignore) && fs.readFileSync(ignore, 'utf8').trim() === '*');
        rec.check('git status of the worktree stays clean', git(issueTree, 'status', '--porcelain') === '', git(issueTree, 'status', '--porcelain'));

        // The agent: the stand-in codex started in the worktree, the prompt on its composer only.
        const issuePane = await firstPane(issueWorkspace.id);
        await d.settle(async () => outcomeIn(issuePane ?? '-') !== null, { ceilingMs: 45_000, intervalMs: 200 });
        const issueOutcome = outcomeIn(issuePane ?? '-');
        rec.check('the daemon reports the agent launch prefilled', issueOutcome?.[1] === 'prefilled', String(issueOutcome?.[0]));
        const issueLaunch = launchRows()[issueLaunchesBefore] ?? null;
        rec.check('the fake codex started once, in the worktree', issueLaunch !== null && launchRows().length === issueLaunchesBefore + 1 && fs.realpathSync(issueLaunch.cwd) === fs.realpathSync(issueTree), JSON.stringify(launchRows()));
        const composed = await d.settle(async () => fakeState(issueLaunch?.dir ?? '-')?.composer === ISSUE_PROMPT, { ceilingMs: 5_000, intervalMs: 100 });
        // A dwell, because "nothing submitted" is a negative: an Enter after the paste would land now.
        await sleep(1_500);
        const codexState = fakeState(issueLaunch?.dir ?? '-');
        rec.check(
            'its composer holds the ticket prompt, from one paste, unsubmitted',
            composed && codexState?.composer === ISSUE_PROMPT && codexState.pastes === 1 && codexState.submitted.length === 0 && JSON.stringify(codexState.argv) === '[]',
            JSON.stringify(codexState)
        );

        // The Inspector shows the ticket the workspace remembers, as a link (not opened).
        if ((await activeWorkspaceID()) !== issueWorkspace.id) await page.click(`[data-testid="workspace-row"][data-workspace-id="${issueWorkspace.id}"]`);
        if (!(await exists('[data-testid="inspector"]'))) {
            await harness.menuClick({ path: ['View', 'Toggle Inspector'] });
            inspectorOpened = true;
        }
        const ticketRow = await d.settleDom(page, `document.querySelector('[data-testid="inspector-workspace-ticket"]') !== null`, { ceilingMs: 5_000 });
        const inspectorRow = JSON.parse(
            String(
                await page.eval(`JSON.stringify((() => {
                    const el = document.querySelector('[data-testid="inspector-workspace-ticket"]');
                    return el === null ? null : { tag: el.tagName, title: el.getAttribute('title'), text: el.innerText.replace(/\\s+/g, ' ').trim() };
                })())`)
            )
        );
        rec.check(
            'the Inspector shows the stored ticket as a link row: #7 and its title, to the issue’s page',
            ticketRow && inspectorRow?.tag === 'BUTTON' && inspectorRow.title === ISSUE_URL && inspectorRow.text.includes('#7') && inspectorRow.text.includes('Fix login timeout'),
            JSON.stringify(inspectorRow)
        );
        await rec.shot(page, 'inspector-ticket-row');
        if (inspectorOpened) {
            await harness.menuClick({ path: ['View', 'Toggle Inspector'] });
            inspectorOpened = false;
        }

        // ── 4 · Escape: the picker first, then the sheet ──────────────────────────────────────
        const beforeEscape = (await listed()).length;
        await pressFromTicketChord();
        rec.check('⌥⌘N opens the sheet with the picker again', await d.settleDom(page, `document.querySelector('${PICKER}') !== null`, { ceilingMs: 5_000 }));
        await page.key('Escape');
        const pickerGone = await d.settleDom(page, `document.querySelector('${PICKER}') === null && document.querySelector('${SHEET}') !== null`, { ceilingMs: 3_000 });
        rec.check('Escape closes the picker only, and the caret returns to From ticket…', pickerGone && (await sheet()).focus === 'new-workspace-from-ticket', JSON.stringify(await sheet()));
        await page.key('Escape');
        const sheetGone = await d.settleDom(page, `document.querySelector('${SHEET}') === null`, { ceilingMs: 3_000 });
        await sleep(300);
        rec.check('a second Escape closes the sheet, creating nothing', sheetGone && (await listed()).length === beforeEscape, `${String(beforeEscape)} -> ${String((await listed()).length)}`);

        // ── 5 · pull request #8: its head branch, its own steps, a tracking worktree ────────────
        await page.click('[data-testid="sidebar-new-workspace"]');
        rec.check('the sidebar’s New Workspace opens the plain sheet, with From ticket… in its title row', await d.settleDom(page, `document.querySelector('${SHEET}') !== null && document.querySelector('${FROM_TICKET}') !== null && document.querySelector('${PICKER}') === null`, { ceilingMs: 5_000 }));
        await press(FROM_TICKET);
        const prRowUp = await d.settleDom(page, `document.querySelector('${ROW('acme/api#8')}') !== null`, { ceilingMs: 10_000 });
        rec.check('From ticket… opens the picker on the lists', prRowUp, JSON.stringify(await picker()));
        const prResolvesBefore = resolves().length;
        await press(ROW('acme/api#8'));
        const prPicked = await d.settleDom(page, `document.querySelector('${PICKER}') === null && document.querySelector('[data-testid="new-workspace-ticket"]')?.getAttribute('data-kind') === 'pr'`, { ceilingMs: 15_000 });
        rec.check('clicking pull request #8 resolves it and prefills the sheet', prPicked && resolves().length === prResolvesBefore + 1 && resolves().at(-1).variables?.number === 8, JSON.stringify(await sheet()));
        const prSheet = await sheet();
        rec.note(`prefilled sheet: ${JSON.stringify(prSheet)}`);
        rec.check(
            `the pull request’s head branch ${PR_BRANCH} fills the branch, fix-retry-401 the worktree, and Update main is not offered`,
            prSheet.name === PR_NAME && prSheet.worktree === true && prSheet.worktreeName === 'fix-retry-401' && prSheet.branch === PR_BRANCH && prSheet.updateMain === null,
            JSON.stringify(prSheet)
        );
        rec.check(
            'the prompt names the pull request, its branch and .kelpi/ticket-8.md',
            prSheet.prompt === `Pick up pull request #8: Retry on 401 (${PR_URL}) on branch ${PR_BRANCH}. Read @.kelpi/ticket-8.md first, it has the description and recent review comments.`,
            String(prSheet.prompt)
        );
        rec.check('no agent for this one (None chosen)', (await chooseAgent('None')) === true && (await sheet()).agent === 'none');
        await rec.shot(page, 'sheet-prefilled-pr');
        await watchSteps();
        await press(SUBMIT);
        const prClosed = await d.settleDom(page, `document.querySelector('${SHEET}') === null`, { ceilingMs: 60_000 });
        rec.check('Create runs and closes the sheet', prClosed, JSON.stringify(await sheet()));
        const prSteps = await stepsSeen();
        rec.note(`pull request steps: ${JSON.stringify(prSteps)}`);
        rec.check(
            'the progress panel showed the pull request’s steps: look up, fetch the pull request, check it out, open',
            JSON.stringify(stepOrder(prSteps)) === JSON.stringify(['ticket', 'fetch', 'worktree-add', 'create-workspace']) &&
                reached(prSteps, 'ticket', 'done') &&
                reached(prSteps, 'fetch', 'running', 'Fetch the pull request') &&
                reached(prSteps, 'fetch', 'done', 'Fetch the pull request') &&
                labelOf(prSteps, 'worktree-add') === 'Check out the pull request' &&
                !prSteps.some((entry) => entry.id === 'resolve-default-branch'),
            JSON.stringify(prSteps.map((entry) => [entry.id, entry.status, entry.label]))
        );
        // The daemon's FIRST frame names its guessed mode (`pr-head` for a /pull/ URL), so the rows
        // never flicker to a plain create's labels before the re-plan frame.
        const mislabelled = ['Fetch the latest main', 'Create the worktree'].filter((label) => prSteps.some((entry) => entry.label === label));
        rec.check(
            'the pull request’s rows never show a plain create’s labels, not even before the ticket answers',
            mislabelled.length === 0 &&
                labelsOf(prSteps, 'fetch').every((label) => label === 'Fetch the pull request') &&
                labelsOf(prSteps, 'worktree-add').every((label) => label === 'Check out the pull request'),
            `fetch ${JSON.stringify(labelsOf(prSteps, 'fetch'))}, worktree-add ${JSON.stringify(labelsOf(prSteps, 'worktree-add'))}`
        );
        const prWorkspace = await workspaceNamed(PR_NAME);
        rec.check('the workspace "#8 Retry on 401" exists', prWorkspace !== undefined, JSON.stringify((await listed()).map((workspace) => workspace.name)));
        const prTree = worktreeOf(PR_BRANCH);
        rec.check(`a worktree on ${PR_BRANCH} at the pull request’s head commit`, prTree !== null && git(prTree, 'rev-parse', 'HEAD') === prHeadSha, String(prTree));
        if (prTree !== null) {
            rec.check(
                '…tracking the remote branch: @{u} is origin/fix/retry-401',
                gitOr(prTree, '', 'rev-parse', '--abbrev-ref', '@{u}') === `origin/${PR_BRANCH}` &&
                    gitOr(clone, '', 'config', `branch.${PR_BRANCH}.remote`) === 'origin' &&
                    gitOr(clone, '', 'config', `branch.${PR_BRANCH}.merge`) === `refs/heads/${PR_BRANCH}`,
                `${gitOr(prTree, '(none)', 'rev-parse', '--abbrev-ref', '@{u}')} remote=${gitOr(clone, '-', 'config', `branch.${PR_BRANCH}.remote`)} merge=${gitOr(clone, '-', 'config', `branch.${PR_BRANCH}.merge`)}`
            );
            const prTicket = path.join(prTree, '.kelpi', 'ticket-8.md');
            const prText = fs.existsSync(prTicket) ? fs.readFileSync(prTicket, 'utf8') : '';
            rec.check(
                '.kelpi/ticket-8.md holds the pull request: branches, description, review and the unresolved inline comment',
                prText.startsWith('# #8 Retry on 401\n') &&
                    prText.includes(`- Pull request: ${PR_URL}`) &&
                    prText.includes('- Base branch: main') &&
                    prText.includes(`- Head branch: ${PR_BRANCH} (from acme/api)`) &&
                    prText.includes('Looks right; one note inline.') &&
                    prText.includes('on src/auth.ts:12') &&
                    prText.includes('Cap the retries at one.'),
                prText.slice(0, 400)
            );
            rec.check('git status of the pull request’s worktree stays clean', git(prTree, 'status', '--porcelain') === '', git(prTree, 'status', '--porcelain'));
        }

        // ── 6 · #7 again: already open, and Switch to it ──────────────────────────────────────
        if ((await activeWorkspaceID()) === issueWorkspace.id && prWorkspace !== undefined) {
            await page.click(`[data-testid="workspace-row"][data-workspace-id="${prWorkspace.id}"]`);
            await d.settle(async () => (await activeWorkspaceID()) === prWorkspace.id, { ceilingMs: 5_000, intervalMs: 100 });
        }
        rec.check('a workspace other than #7’s is active', (await activeWorkspaceID()) !== issueWorkspace.id, String(await activeWorkspaceID()));
        const countBeforeSwitch = (await listed()).length;
        await pressFromTicketChord();
        const issueRowUp = await d.settleDom(page, `document.querySelector('${ROW('acme/api#7')}') !== null`, { ceilingMs: 10_000 });
        rec.check('⌥⌘N lists #7 again', issueRowUp, JSON.stringify(await picker()));
        await press(ROW('acme/api#7'));
        const bannerUp = await d.settleDom(page, `document.querySelector('${PICKER}') === null && document.querySelector('[data-testid="new-workspace-ticket-existing"]') !== null`, { ceilingMs: 15_000 });
        const again = await sheet();
        rec.check(
            'picking #7 again shows "#7 is already open in #7 Fix login timeout." with Switch to it',
            bannerUp && String(again.existing).startsWith(`#7 is already open in ${ISSUE_NAME}.`) && String(again.existing).endsWith('Switch to it') && (await exists(testID('new-workspace-ticket-switch'))),
            JSON.stringify(again.existing)
        );
        await rec.shot(page, 'sheet-already-open');
        await press(testID('new-workspace-ticket-switch'));
        const switched = await d.settle(async () => (await activeWorkspaceID()) === issueWorkspace.id, { ceilingMs: 5_000, intervalMs: 100 });
        rec.check(
            'Switch to it switches to #7’s workspace and closes the sheet, creating nothing',
            switched && (await d.settleDom(page, `document.querySelector('${SHEET}') === null`, { ceilingMs: 3_000 })) && (await listed()).length === countBeforeSwitch,
            `active ${String(await activeWorkspaceID())}, ${String(countBeforeSwitch)} -> ${String((await listed()).length)}`
        );
        rec.check(
            '…and the sidebar shows it active',
            (await page.eval(`document.querySelector('[data-testid="workspace-row"][data-workspace-id="${issueWorkspace.id}"]')?.getAttribute('data-active')`)) === 'true'
        );

        // ── 7 · what went where: only the fake, only with the token, never the token elsewhere ──
        const all = requests();
        rec.note(`fake GitHub saw ${String(all.length)} requests: ${all.map((entry) => `${entry.operation ?? entry.path}:${String(entry.status)}`).join(', ')}`);
        rec.check('every request the fake saw was one it knows (nothing unexpected)', all.every((entry) => !entry.unexpected && entry.base !== 'unknown'), JSON.stringify(all.filter((entry) => entry.unexpected)));
        rec.check('every API request carried exactly the fake token as a Bearer credential', all.filter((entry) => entry.base === 'api').every((entry) => entry.auth === 'token'), JSON.stringify(all.filter((entry) => entry.base === 'api' && entry.auth !== 'token')));
        rec.check('the device flow’s requests carried no credential', all.filter((entry) => entry.base === 'web').every((entry) => entry.auth === 'none'));
        rec.check('the token never travelled in a URL or a body', all.every((entry) => !entry.tokenElsewhere));
        rec.check('every request said User-Agent: Kelpi/<version>', all.every((entry) => /^Kelpi\/\S+$/.test(entry.userAgent)), JSON.stringify([...new Set(all.map((entry) => entry.userAgent))]));
        rec.check(
            'the token and the device code never crossed the window’s socket',
            frames.length > 0 && !frames.some((frame) => frame.data.includes(fake.token) || frame.data.includes(fake.deviceCode)),
            `${String(frames.length)} frames`
        );
        const logText = daemon.text();
        rec.check('the daemon’s log names neither the token nor the device code', !logText.includes(fake.token) && !logText.includes(fake.deviceCode));
        const dbHolds = ['', '-wal'].some((suffix) => {
            const file = `${sandbox.env.KELPID_DB_PATH}${suffix}`;
            return fs.existsSync(file) && fs.readFileSync(file).includes(Buffer.from(fake.token));
        });
        rec.check('the daemon’s database does not hold the token', !dbHolds);
    } finally {
        for (const off of offFrames) off();
        if (await page.eval(`document.querySelector('${PICKER}') !== null`).catch(() => false)) await page.key('Escape');
        if (await page.eval(`document.querySelector('${SHEET}') !== null`).catch(() => false)) await page.key('Escape');
        if (inspectorOpened) await harness.menuClick({ path: ['View', 'Toggle Inspector'] }).catch(() => {});
        await closeSettings().catch(() => {});
        for (const id of created) await cli.run(['workspace', 'delete', id, '--force']);
        // Unregister the clone, so the registry is handed on as it was found.
        if (repoID !== null) {
            try {
                await d.openSettingsTab(page, 'repositories');
                if (await exists(`[data-testid="repo-remove-${repoID}"]`)) {
                    await page.click(`[data-testid="repo-remove-${repoID}"]`);
                    await d.settleDom(page, `document.querySelector('[data-testid="repo-row-${repoID}"]') === null`, { ceilingMs: 5_000 });
                }
                await closeSettings();
            } catch (error) {
                rec.note(`cleanup: the clone could not be unregistered (${error instanceof Error ? error.message : String(error)})`);
            }
        }
        // The daemon as it was: no fake GitHub, no credential file, the original config.
        fs.writeFileSync(sandbox.configPath, originalConfig);
        for (const key of GITHUB_ENV_KEYS) {
            if (originalEnv[key] === undefined) delete sandbox.env[key];
            else sandbox.env[key] = originalEnv[key];
        }
        try {
            rec.check('cleanup: the daemon restarts without the fake GitHub and the window reconnects', await restartDaemon(), String(await connection()));
        } catch (error) {
            rec.check('cleanup: the daemon restarts without the fake GitHub', false, error instanceof Error ? error.message : String(error));
        }
        await fake.close();
        await harness.clipboardWrite(originalClipboard).catch(() => {});
        const home = `[data-testid="workspace-row"][data-workspace-id="${String(homeID)}"]`;
        if (homeID !== null && (await d.settleDom(page, `document.querySelector(${JSON.stringify(home)})`, { ceilingMs: 8_000 }))) await page.click(home);
    }
}

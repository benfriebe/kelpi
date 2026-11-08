#!/usr/bin/env node
/**
 * Regenerate the README's screenshots (`docs/assets/readme/*.png`) from a sandboxed Kelpi.
 *
 *     node scripts/readme-screenshots.mjs              # builds first, like the scenario runner
 *     node scripts/readme-screenshots.mjs --no-build   # reuse the bundles already on disk
 *     node scripts/readme-screenshots.mjs --out /tmp/shots
 *
 * Everything runs in a private sandbox (`scripts/ui-audit/lib/driver.mjs` ▸ `boot`): its own
 * daemon, socket, database, HOME and Electron profile, so it never touches the Kelpi you are
 * using. The window is the harness's `offscreen` lane: it is parked past the edge of the screen,
 * so the run never covers yours. AppKit gives an off-screen window a 1x backing store, so the
 * page is rendered at device scale factor 2 through CDP emulation and captured from the
 * renderer's own surface, which gives 2560x1640 pictures of the 1280x820 window. A web pane is
 * a native view that surface does not contain, so it is captured from its own target at the same
 * scale and composited into place.
 *
 * After the tour it installs the example Agent Board plugin (`examples/plugins/agent-board`, as
 * `plugin-workbench.mjs` does) and shows it in the right sidebar and in Settings ▸ Plugins, and it
 * photographs the hero workspace under three of Settings ▸ Appearance's preset themes, each with
 * the terminal theme of the same name. All of that is the sandbox's own config: the daemon's
 * `KELPID_CONFIG_PATH` and `KELPID_GHOSTTY_CONFIG`, never yours.
 *
 * The demo is staged, but nothing in it is faked: the repositories are real git repos under the
 * sandbox HOME, the terminals run real commands (`node --test`, `git log`, a small dev server),
 * the coordinator really spawns and drives its workers with the `kelpi` CLI, and the status
 * badges come from `kelpi event`, the hook command Claude Code and Codex fire. No agent CLI is
 * launched.
 *
 * The PNGs are written as captured, 350 to 500 KB each. Quantise them to a 256-colour palette
 * before committing, which brings each to 80 to 160 KB with no visible change to the UI (for
 * example `pngquant --quality 80-95 --ext .png --force docs/assets/readme/*.png`, or Pillow's
 * `quantize(256, method=FASTOCTREE, dither=NONE)`, which is what the committed set used).
 *
 * The demo is Paddock, a grazing planner (`scripts/demo-fixture.mjs`): an API group on
 * `~/paddock-api` and a Web group on `~/paddock-web`. The demo HOME is laid out so nothing on
 * screen names this machine: the prompt is a plain `~/paddock-api (main) $`, and new worktrees go
 * under /tmp/kelpi-readme (a symlink into the sandbox, removed afterwards). Look at every picture
 * before committing it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};
const outDir = path.resolve(value('--out') ?? path.join(repoRoot, 'docs', 'assets', 'readme'));
fs.mkdirSync(outDir, { recursive: true });

// The sandbox lives under os.tmpdir(). On macOS that is a /var/folders symlink, and git and the
// daemon resolve it to /private/var/folders, so the client could not shorten a repo path to `~`.
// A real path from the start keeps every path on screen relative to the sandbox HOME.
process.env.TMPDIR = fs.realpathSync(os.tmpdir());
// This may be started from inside a Kelpi pane: nothing the sandbox runs may inherit that pane.
delete process.env.KELPI_PANE_ID;
delete process.env.KELPI_SOCKET;
// The agent events below would otherwise post real notifications to this Mac's notification
// centre; the harness still records them.
process.env.KELPI_HARNESS_QUIET_NOTIFICATIONS = '1';

const { runDesktopTest } = await import('./ui-audit/lib/desktop-lifecycle.mjs');
const d = await import('./ui-audit/lib/driver.mjs');
const { connect, listTargets } = await import('./ui-audit/lib/cdp.mjs');
const { freePort } = await import('./ui-audit/lib/stack.mjs');
const { sleep } = d;
const { GITCONFIG, ZSHRC, makeRepos, write } = await import('./demo-fixture.mjs');
const log = (line) => console.log(`[readme] ${line}`);

// ── capture ─────────────────────────────────────────────────────────────────────────

const SCALE = 2;
const WORKTREE_LINK = '/tmp/kelpi-readme';
const AGENT_BOARD = path.join(repoRoot, 'examples', 'plugins', 'agent-board');
const AGENT_BOARD_VIEW = 'example.agent-board.board';

/**
 * The themes the gallery shows: a chrome preset from Settings ▸ Appearance ▸ Preset themes, and
 * the built-in terminal theme of the same name. Kelpi reads a terminal theme's colours from a
 * ghostty theme file (`packages/daemon/src/settings/theme.ts`), normally found in Ghostty's own
 * install. The sandbox cannot count on one, so these are the themes' published palettes, written
 * into the `themes` directory beside the sandbox's ghostty config, the first place Kelpi looks.
 *
 * Chosen to read as three different looks at thumbnail size, and different from the default.
 * Dracula was tried first and dropped: its #282a36 is applied, but the captures render every
 * colour slightly darker (#282a36 comes out as #24262f), and at that size it read as the default.
 */
const THEMES = [
    {
        preset: 'Nord', terminal: 'Nord', file: 'theme-nord',
        colors: { background: '#2e3440', foreground: '#d8dee9', 'cursor-color': '#eceff4', 'selection-background': '#eceff4', 'selection-foreground': '#4c566a' },
        palette: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#596377', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']
    },
    {
        preset: 'Gruvbox Dark', terminal: 'Gruvbox Dark', file: 'theme-gruvbox-dark',
        colors: { background: '#282828', foreground: '#ebdbb2', 'cursor-color': '#ebdbb2', 'selection-background': '#665c54', 'selection-foreground': '#ebdbb2' },
        palette: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']
    },
    {
        preset: 'Solarized Light', terminal: 'iTerm2 Solarized Light', file: 'theme-solarized-light',
        colors: { background: '#fdf6e3', foreground: '#657b83', 'cursor-color': '#657b83', 'selection-background': '#eee8d5', 'selection-foreground': '#586e75' },
        palette: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']
    }
];

function writeThemeFiles(sandbox) {
    for (const theme of THEMES) {
        const lines = [
            ...Object.entries(theme.colors).map(([key, color]) => `${key} = ${color}`),
            ...theme.palette.map((color, index) => `palette = ${String(index)}=${color}`)
        ];
        write(path.join(path.dirname(sandbox.ghosttyConfigPath), 'themes', theme.terminal), `${lines.join('\n')}\n`);
    }
}

/** Render at SCALE; `size` pins the viewport too (a web pane's view, to exactly its hole). */
async function emulateScale(session, size) {
    await session.send('Emulation.setDeviceMetricsOverride', {
        width: size === undefined ? 0 : Math.round(size.width),
        height: size === undefined ? 0 : Math.round(size.height),
        deviceScaleFactor: SCALE,
        mobile: false
    });
}

async function captureSurface(session) {
    const shot = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    return shot.data;
}

/** Where a web pane's native view sits: the page hole the client leaves for it, in CSS px. */
async function webBounds(page, paneID) {
    const rect = await page.eval(`(() => {
        const el = document.querySelector('[data-testid="web-page-${paneID}"]');
        if (el === null || el.getAttribute('data-visible') !== 'true') return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    })()`);
    return rect === null ? null : JSON.parse(rect);
}

// ── the run ─────────────────────────────────────────────────────────────────────────

await runDesktopTest(async () => {
    log(`booting a sandbox${has('--no-build') ? ' (no build)' : ' (building first; skip with --no-build)'}`);
    const t = await d.boot({ repoRoot, label: 'readme', build: !has('--no-build'), log, window: 'offscreen' });
    const { page, cli, sandbox, harness } = t;
    const written = [];
    let webSession = null;
    let linkedWorktrees = false;

    const shot = async (name, { web } = {}) => {
        await sleep(600);
        let data = await captureSurface(page);
        if (web !== undefined) {
            const bounds = await webBounds(page, web.paneID);
            if (bounds === null) throw new Error(`web pane ${web.paneID} is not on screen`);
            const overlay = await captureSurface(web.session);
            data = await page.eval(`(async () => {
                const decode = async (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
                const [base, view] = await Promise.all([decode(${JSON.stringify(data)}), decode(${JSON.stringify(overlay)})]);
                const canvas = document.createElement('canvas');
                canvas.width = base.width;
                canvas.height = base.height;
                const g = canvas.getContext('2d');
                g.drawImage(base, 0, 0);
                g.drawImage(view, ${String(bounds.x * SCALE)}, ${String(bounds.y * SCALE)}, ${String(bounds.width * SCALE)}, ${String(bounds.height * SCALE)});
                return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
            })()`, { timeoutMs: 60_000 });
        }
        const file = path.join(outDir, `${name}.png`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        written.push(file);
        log(`wrote ${path.relative(repoRoot, file)}`);
    };

    const json = async (argv, opts) => JSON.parse(await cli.ok([...argv, '--json'], opts));
    const asPane = (paneID) => ({ env: { KELPI_PANE_ID: paneID } });
    const capture = async (paneID) => (await cli.run(['pane', 'capture', '--target', paneID])).stdout;
    const waitForText = async (paneID, needle, ceilingMs = 20_000) => {
        const ok = await d.settle(async () => (await capture(paneID)).includes(needle), { ceilingMs, intervalMs: 200 });
        if (!ok) throw new Error(`pane ${paneID} never showed ${JSON.stringify(needle)}:\n${await capture(paneID)}`);
    };
    const send = async (paneID, text) => {
        await cli.ok(['pane', 'send', '--target', paneID, text]);
    };
    /** Type a command at a pane's prompt and wait for the prompt to come back. */
    const run = async (paneID, text, { until, ceilingMs } = {}) => {
        const before = (await capture(paneID)).split('$ ').length;
        await send(paneID, text);
        if (until !== undefined) await waitForText(paneID, until, ceilingMs);
        else await d.settle(async () => (await capture(paneID)).split('$ ').length > before, { ceilingMs: ceilingMs ?? 15_000, intervalMs: 200 });
        await sleep(250);
    };
    const panesOf = async (workspace) => json(['pane', 'list', '--workspace', workspace]);
    const showWorkspace = async (workspaceID) => {
        const row = `[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]`;
        await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 10_000 });
        await page.click(row);
        await sleep(900);
    };
    /** Choose an option in a React-controlled <select>, the way a click on it would. */
    const choose = (selector, value) => page.eval(`(() => {
        const select = document.querySelector(${JSON.stringify(selector)});
        if (select === null) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    const closeSettings = async () => {
        await page.click('[data-testid="settings-close"]');
        await d.settleDom(page, `document.querySelector('[data-testid="settings-close"]') === null`, { ceilingMs: 3_000 });
        await sleep(400);
    };
    const inspectorOpen = () => page.eval(`document.querySelector('[data-testid="toggle-inspector"]')?.getAttribute('aria-pressed') === 'true'`);
    const setInspector = async (open) => {
        if ((await inspectorOpen()) !== open) await page.click('[data-testid="toggle-inspector"]');
        await sleep(700);
    };
    const createWorkspace = async (name, extra = []) => {
        const created = await json(['workspace', 'create', '--focus', '--name', name, ...extra]);
        const workspaceID = created.workspace_id;
        await d.settle(async () => (await panesOf(workspaceID)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });
        const [pane] = await panesOf(workspaceID);
        await waitForText(pane.id, '$ ');
        return { workspaceID, paneID: pane.id };
    };

    try {
        // ── the demo HOME: dotfiles, two repos, and zsh instead of the sandbox's /bin/sh ──
        write(path.join(sandbox.home, '.zshrc'), ZSHRC);
        write(path.join(sandbox.home, '.gitconfig'), GITCONFIG);
        const { api, web } = makeRepos(sandbox);
        writeThemeFiles(sandbox);
        // New worktrees go under a short, stable path instead of the sandbox's temp directory,
        // which the New Workspace sheet would print in full: a symlink into the sandbox, so
        // everything still lives (and dies) with it.
        fs.mkdirSync(path.join(sandbox.root, 'worktrees'));
        if (fs.lstatSync(WORKTREE_LINK, { throwIfNoEntry: false })?.isSymbolicLink() === true) fs.unlinkSync(WORKTREE_LINK);
        fs.symlinkSync(path.join(sandbox.root, 'worktrees'), WORKTREE_LINK);
        linkedWorktrees = true;
        fs.appendFileSync(sandbox.configPath, `worktree-base-path = ${WORKTREE_LINK}/<repo>\n`);
        // The daemon reads SHELL from its own environment, which the sandbox keeps closed. Its
        // restart reuses the same env object, so set it there and restart the sandbox's daemon.
        sandbox.env.SHELL = '/bin/zsh';
        await t.daemon.restart();
        await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 30_000 });
        await emulateScale(page);

        const devPort = await freePort();

        // ── workspaces ───────────────────────────────────────────────────────────────
        const [initial] = await json(['workspace', 'list']);
        await cli.ok(['workspace', 'rename', initial.id, 'dotfiles']);

        await cli.ok(['group', 'create', 'API', '--color', 'blue']);
        await cli.ok(['group', 'set-repo', 'API', api, '--worktree']);
        await cli.ok(['group', 'create', 'Web', '--color', 'green']);
        await cli.ok(['group', 'set-repo', 'Web', web, '--worktree']);

        const hero = await createWorkspace('rest-days', ['--group', 'API', '--color', 'purple']);
        const flaky = await createWorkspace('flaky-tests', ['--group', 'API', '--color', 'blue']);
        const preview = await createWorkspace('preview', ['--group', 'Web', '--color', 'green']);
        const docs = await createWorkspace('spring-rotation', ['--path', api, '--color', 'orange']);

        // Each workspace is shown before anything runs in it: a pane that has never been on
        // screen has no measured grid, and the emulator does not reflow what it printed.

        // flaky-tests: an agent that is running.
        await showWorkspace(flaky.workspaceID);
        await cli.ok(['pane', 'name', 'agent'], asPane(flaky.paneID));
        await run(flaky.paneID, 'node --test', { until: 'pass 6' });
        await cli.ok(['event', 'start'], asPane(flaky.paneID));

        // spring-rotation: a terminal and the plan as a markdown preview.
        await showWorkspace(docs.workspaceID);
        await run(docs.paneID, 'git log --oneline');
        await run(docs.paneID, 'kelpi md docs/rotation-plan.md');
        await d.settle(async () => (await panesOf(docs.workspaceID)).length === 2, { ceilingMs: 15_000, intervalMs: 200 });
        await cli.ok(['event', 'stop'], asPane(docs.paneID));

        // preview: the dev server, and its page in a web pane beside it.
        await showWorkspace(preview.workspaceID);
        await cli.ok(['pane', 'name', 'dev-server'], asPane(preview.paneID));
        await send(preview.paneID, `PORT=${String(devPort)} npm run dev`);
        await waitForText(preview.paneID, 'dev server ready');
        const opened = await cli.ok(['web', 'open', `http://127.0.0.1:${String(devPort)}/`], asPane(preview.paneID));
        const webPaneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1];
        if (webPaneID === undefined) throw new Error(`web open said: ${opened}`);
        await cli.ok(['pane', 'resize', '--target', 'dev-server', '--workspace', preview.workspaceID, '--ratio', '0.4']);

        // rest-days: the coordinator drives two workers with the CLI.
        await showWorkspace(hero.workspaceID);
        await cli.ok(['pane', 'name', 'coordinator'], asPane(hero.paneID));
        await run(hero.paneID, 'kelpi pane split --direction vertical --name worker-1', { until: '(worker-1)' });
        await run(hero.paneID, 'kelpi pane split --target worker-1 --direction horizontal --name worker-2', { until: '(worker-2)' });
        const heroPanes = await panesOf(hero.workspaceID);
        const byLabel = (label) => heroPanes.find((pane) => pane.label === label)?.id;
        const worker1 = byLabel('worker-1');
        const worker2 = byLabel('worker-2');
        if (worker1 === undefined || worker2 === undefined) throw new Error(`workers missing: ${JSON.stringify(heroPanes)}`);
        await waitForText(worker1, '$ ');
        await waitForText(worker2, '$ ');
        await sleep(800);
        await run(hero.paneID, 'kelpi pane send --target worker-1 "node --test"', { until: 'sent to' });
        await waitForText(worker1, 'pass 6');
        await run(hero.paneID, 'kelpi pane send --target worker-2 "git log --oneline --graph"', { until: 'sent to' });
        await waitForText(worker2, 'Initial grazing planner');
        await cli.ok(['event', 'start'], asPane(hero.paneID));
        await cli.ok(['event', 'stop'], asPane(worker1));
        await cli.ok(['event', 'start'], asPane(worker2));
        await sleep(500);
        await run(hero.paneID, 'kelpi pane list');

        // ── 1 · the hero: sidebar, group, the coordinator and its workers ─────────────
        await showWorkspace(hero.workspaceID);
        await shot('hero');

        // ── 2 · Settings ──────────────────────────────────────────────────────────────────
        await d.openSettingsTab(page, 'keybindings');
        await sleep(600);
        await shot('settings');
        await page.key('Escape');
        await d.settleDom(page, `document.querySelector('[data-testid="settings-close"]') === null`, { ceilingMs: 3_000 });
        await sleep(300);

        // ── 3 · markdown beside a terminal ────────────────────────────────────────────
        await showWorkspace(docs.workspaceID);
        await shot('markdown');

        // ── 4 · the web pane ──────────────────────────────────────────────────────────
        await showWorkspace(preview.workspaceID);
        await d.settle(async () => (await webBounds(page, webPaneID)) !== null, { ceilingMs: 15_000, intervalMs: 200 });
        // The page's own renderer is a separate CDP target on the same debug port.
        const findTarget = async () => (await listTargets(sandbox.debugPort)).find((entry) => String(entry.url).startsWith(`http://127.0.0.1:${String(devPort)}`));
        await d.settle(async () => (await findTarget()) !== undefined, { ceilingMs: 15_000, intervalMs: 200 });
        const webTarget = await findTarget();
        if (webTarget === undefined) throw new Error('the web pane has no CDP target');
        webSession = await connect(webTarget.webSocketDebuggerUrl, { repoRoot });
        await emulateScale(webSession, await webBounds(page, webPaneID));
        await sleep(800);
        await shot('web-pane', { web: { paneID: webPaneID, session: webSession } });
        await webSession.send('Emulation.clearDeviceMetricsOverride', {});

        // ── 5 · a new workspace with a worktree, from the group's menu ────────────────
        await showWorkspace(hero.workspaceID);
        await d.openSidebarMenu(page, '[data-testid="group-header"]', 'Web');
        await d.clickMenuItem(page, 'New Workspace');
        await d.settleDom(page, `document.querySelector('[data-testid="new-workspace-sheet"]') !== null`, { ceilingMs: 5_000 });
        await page.click('[aria-label="New workspace name"]');
        await page.insertText('rain-chart');
        await sleep(300);
        await page.eval(`document.querySelector('[data-testid="new-workspace-submit"]')?.scrollIntoView({ block: 'nearest' })`);
        await page.click('[data-testid="new-workspace-submit"]');
        const counting = await d.settle(
            async () => {
                const percent = Number(await page.eval(`document.querySelector('[data-testid="new-workspace-step-fetch"]')?.getAttribute('data-percent') ?? 'NaN'`));
                return percent >= 35 && percent <= 80;
            },
            { ceilingMs: 60_000, intervalMs: 50 }
        );
        if (!counting) log('the fetch step never showed a percentage between 35 and 80; capturing what is there');
        await shot('new-workspace-worktree');
        await d.settleDom(page, `document.querySelector('[data-testid="new-workspace-sheet"]') === null`, { ceilingMs: 60_000 });

        // ── 6 · themes: the hero again under three presets ────────────────────────────
        // Before the plugin shots: those open the right sidebar, and a pane narrowed while on
        // screen loses what it printed past the new width (the emulator does not reflow).
        await showWorkspace(hero.workspaceID);
        const configFiles = [sandbox.configPath, sandbox.ghosttyConfigPath];
        const shippedLook = configFiles.map((file) => fs.readFileSync(file, 'utf8'));
        for (const theme of THEMES) {
            await d.openSettingsTab(page, 'appearance');
            const slug = theme.preset.toLowerCase().replace(/\s+/g, '-');
            await page.eval(`document.querySelector('[data-testid="theme-preset-${slug}"]')?.scrollIntoView({ block: 'center' })`);
            await page.click(`[data-testid="theme-preset-${slug}"]`);
            await sleep(400);
            if (!(await choose('[data-testid="terminal-theme-select"]', theme.terminal))) throw new Error('no terminal theme picker');
            const resolved = await d.settleDom(page, `document.querySelector('[data-testid="terminal-theme-resolved"]') !== null`, { ceilingMs: 5_000 });
            if (!resolved) throw new Error(`the ${theme.terminal} terminal theme did not resolve: ${String(await page.eval(`document.querySelector('[data-testid="terminal-theme-error"]')?.textContent ?? 'no note'`))}`);
            await closeSettings();
            await sleep(800);
            await shot(theme.file);
        }
        // Back to the shipped look for the plugin shots: the daemon watches both config files,
        // so putting back what they held before the presets restores the default theme.
        configFiles.forEach((file, index) => fs.writeFileSync(file, shippedLook[index]));
        await sleep(1500);

        // ── 7 · a plugin: the example Agent Board, as the right sidebar ──────────────
        await page.watchFrames();
        await cli.ok(['plugin', 'install', AGENT_BOARD, '--trust']);
        await showWorkspace(flaky.workspaceID);
        await d.openSettingsTab(page, 'plugins');
        await d.settleDom(page, `document.querySelector('select[aria-label="sidebar.secondary"]')`, { ceilingMs: 5_000 });
        await choose('select[aria-label="sidebar.secondary"]', AGENT_BOARD_VIEW);
        await sleep(500);
        await page.eval(`document.querySelector('[data-testid="plugin-placements"]')?.scrollIntoView({ block: 'start' })`);
        await sleep(400);
        await shot('plugin-settings');
        await closeSettings();
        await setInspector(true);
        const boardFrame = '[data-workbench-slot="sidebar.secondary"] iframe';
        const boardReady = await d.settle(async () => {
            try { return (await page.evalInFrame(boardFrame, `document.querySelectorAll('.pane').length`)) > 0; } catch { return false; }
        }, { ceilingMs: 15_000, intervalMs: 200 });
        if (!boardReady) throw new Error('the Agent Board sidebar never listed a pane');
        await shot('plugin-sidebar');
        await setInspector(false);

        log(`done: ${String(written.length)} screenshots in ${path.relative(repoRoot, outDir) || outDir}`);
    } finally {
        try { webSession?.close(); } catch { /* already gone */ }
        if (has('--keep')) {
            log(`--keep: sandbox ${sandbox.root}, debug ${String(sandbox.debugPort)}, control tcp:127.0.0.1:${String(sandbox.controlPort)}; Ctrl-C to end`);
            await new Promise(() => {});
        }
        await t.stop();
        if (linkedWorktrees) fs.rmSync(WORKTREE_LINK, { force: true });
    }
});
process.exit(process.exitCode ?? 0);

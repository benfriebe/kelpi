#!/usr/bin/env node
/**
 * The visual/interactive audit harness — the validation layer the structural tests are not.
 *
 * 3038 unit tests and a green wire-compat suite said this port was done. The first human to
 * LOOK at it found real defects in the first minute. That gap is structural: nothing in the
 * repo ever rendered a pixel, pressed ⌘D, or read a terminal the way a person does. This does.
 *
 * What it is: a private daemon + a private Electron shell, driven through the Chrome DevTools
 * Protocol as a user drives it — real `Input.dispatchKeyEvent` into the ghostty-web canvas,
 * real `Input.dispatchMouseEvent` on real dividers, real CLI processes over a real socket —
 * with a PNG captured after every step and a machine-checkable assertion wherever one exists.
 * Where none exists (glyph tofu, clipped columns, spacing, contrast, "does the web view
 * actually appear"), the step is flagged **needs-eyes** and the PNG is the deliverable.
 *
 * Usage:
 *
 *     node scripts/ui-audit/audit.mjs                       # docs/audit/<timestamp>/
 *     node scripts/ui-audit/audit.mjs --out docs/audit/run2  # re-runnable, fixed directory
 *     node scripts/ui-audit/audit.mjs --packaged             # drive the packaged Nex.app
 *     node scripts/ui-audit/audit.mjs --no-build --keep --verbose
 *
 * Isolation: everything lives under a fresh `mkdtemp` with ephemeral ports. It never touches
 * `/tmp/nex.sock`, `/tmp/nexd-dev*`, or ports 19733/19734/9223 — the developer's own stack.
 *
 * Concurrency: every bundle (daemon, CLI, client, shell) is rebuilt from source at the START of
 * a run, so the screenshots always describe the working tree as it is at that moment, even
 * while other agents are editing it.
 *
 * Exit code is 0 unless the harness itself broke. A failed *assertion* is a finding, not a
 * harness failure — read `FINDINGS.md`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOD, connect, sleep, waitForPageTarget } from './lib/cdp.mjs';
import { createReport } from './lib/report.mjs';
import {
    buildAll,
    freePort,
    makeCli,
    makeSandbox,
    startDaemon,
    startShell,
    waitForHealthz
} from './lib/stack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// ── options ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const options = {
        out: null,
        build: true,
        packaged: false,
        keep: false,
        verbose: false,
        only: null
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out') options.out = argv[++i] ?? null;
        else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
        else if (arg === '--no-build') options.build = false;
        else if (arg === '--packaged') options.packaged = true;
        else if (arg === '--keep') options.keep = true;
        else if (arg === '--verbose') options.verbose = true;
        else if (arg === '--only') options.only = (argv[++i] ?? '').split(',').filter(Boolean);
        else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length).split(',').filter(Boolean);
        else if (arg === '--help' || arg === '-h') {
            process.stdout.write(
                'usage: node scripts/ui-audit/audit.mjs [--out <dir>] [--packaged] [--no-build] [--keep] [--verbose] [--only a,b]\n'
            );
            process.exit(0);
        } else throw new Error(`unknown argument: ${arg}`);
    }
    return options;
}

const options = parseArgs(process.argv.slice(2));

function timestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return (
        `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    );
}

const outDir = path.resolve(repoRoot, options.out ?? path.join('docs', 'audit', timestamp()));

function gitCommit() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
        return 'unknown';
    }
}

// ── fixtures the flows need on disk ─────────────────────────────────────────────────

/**
 * A glyph torture line. Terminal font stacks fail loudly and specifically: box-drawing and
 * powerline glyphs fall back to tofu, emoji come out monochrome or double-width-wrong, CJK
 * breaks the cell grid. Claude Code's own prompt frame is box-drawing, so this is not academic.
 *
 * **The private-use rows are written as `\u{...}` escapes, and must stay that way.** They were
 * literal characters in the first version of this file and arrived at the audit as *runs of
 * spaces* — invisible in every editor, invisible in the diff, and the cause of a headline
 * finding ("Powerline and Nerd Font glyphs render as nothing at all") that was really a broken
 * fixture. A fixture that can silently lose the thing it tests is worse than no fixture; the
 * `terminal-nerdfont-prompt` step asserts on the same codepoints so a repeat cannot pass quietly.
 */
const PUA = {
    sep: '\u{E0B0}',
    sepThin: '\u{E0B1}',
    sepLeft: '\u{E0B2}',
    branch: '\u{E0A0}',
    lock: '\u{E0A2}',
    lineNo: '\u{E0A1}',
    folder: '\u{F07B}',
    home: '\u{F015}',
    node: '\u{E718}',
    git: '\u{F1D3}',
    python: '\u{E73C}',
    rust: '\u{E7A8}',
    check: '\u{F00C}',
    bolt: '\u{F0E7}',
    apple: '\u{F179}'
};

const GLYPH_FIXTURE = [
    'printf \'%s\\n\' "ascii   : The quick brown fox jumps over the lazy dog 0123456789"',
    'printf \'%s\\n\' "box     : ╭──────────────╮ │ ├─┤ └┘ ═╬═ ░▒▓█ ▁▂▃▄▅▆▇█"',
    `printf '%s\\n' "powerln : ${PUA.sep} ${PUA.sepThin} ${PUA.sepLeft} ${PUA.branch} ${PUA.lock} ${PUA.lineNo}"`,
    `printf '%s\\n' "nerdfont: ${PUA.folder} ${PUA.home} ${PUA.node} ${PUA.git} ${PUA.python} ${PUA.rust} ${PUA.check} ${PUA.bolt} ${PUA.apple}"`,
    'printf \'%s\\n\' "emoji   : ✅ ❌ ⚠️  🚀 🔥 ⏳ 📁 🧪"',
    'printf \'%s\\n\' "cjk     : 日本語のテキスト 中文文本 한국어"',
    'printf \'%s\\n\' "arrows  : → ← ↑ ↓ ⇒ ⇐ ▸ ▾ ✓ ✗ · … ± ≈ ≠"',
    'printf \'%s\\n\' "color   : $(printf \'\\033[31mRED \\033[32mGREEN \\033[33mYELLOW \\033[34mBLUE \\033[35mMAGENTA \\033[36mCYAN\\033[0m\')"',
    'printf \'%s\\n\' "bold    : $(printf \'\\033[1mBOLD\\033[0m \\033[2mDIM\\033[0m \\033[3mITALIC\\033[0m \\033[4mUNDER\\033[0m \\033[7mREVERSE\\033[0m\')"'
].join('\n');

/**
 * A REAL shell prompt made of Nerd Font glyphs — the thing the font fix exists for.
 *
 * The glyph torture line above proves the engine can *print* a private-use codepoint. It does
 * not prove the case that made this a defect: a powerlevel10k / starship user whose PS1 is
 * built out of Powerline separators (U+E0B0/U+E0B2), a branch glyph (U+E0A0) and Nerd Font
 * icons. That prompt is redrawn on every keystroke and every resize, so if the face behind it
 * is missing the glyphs the user stares at tofu (or, worse, at nothing — the previous run's
 * M2 was *blank* PUA cells) for the whole session.
 *
 * Sourced (`. prompt.sh`), not run, so the interactive shell actually adopts the PS1 and every
 * later screenshot in the run carries the prompt. The sample rows are printed as well, so a
 * single screenshot shows both the live prompt and a labelled reference row.
 *
 * Escapes are written as JS `\u{...}` on purpose: a literal PUA character in this source is
 * invisible in every editor and diff, and "the fixture silently lost its glyphs" is exactly
 * the failure this step is supposed to catch.
 */
const PROMPT_FIXTURE = [
    '# powerlevel10k-shaped prompt: [icon] dir \\ue0b0 [branch glyph] branch \\ue0b0',
    `SEP='${PUA.sep}'`,
    `SEPTHIN='${PUA.sepThin}'`,
    `BRANCH='${PUA.branch}'`,
    `FOLDER='${PUA.folder}'`,
    `NODE='${PUA.node}'`,
    `GIT='${PUA.git}'`,
    `CHECK='${PUA.check}'`,
    `LIGHTNING='${PUA.bolt}'`,
    `PYTHON='${PUA.python}'`,
    `APPLE='${PUA.apple}'`,
    'ESC=$(printf \'\\033\')',
    'BLUE="${ESC}[44;97m"; BLUEFG="${ESC}[34m"; GREEN="${ESC}[42;30m"; GREENFG="${ESC}[32m"',
    'YELLOW="${ESC}[43;30m"; YELLOWFG="${ESC}[33m"; RESET="${ESC}[0m"',
    '',
    '# a labelled reference row, so the screenshot names what it is showing',
    'printf \'%s\\n\' "prompt glyphs: ${SEP} ${SEPTHIN} ${BRANCH} ${FOLDER} ${NODE} ${GIT} ${CHECK} ${LIGHTNING} ${PYTHON} ${APPLE}"',
    '',
    '# the same prompt, rendered once as output (survives `clear`, readable next to the live one)',
    'printf \'%s\\n\' "${BLUE} ${APPLE} audit ${GREEN}${BLUEFG}${SEP}${RESET}${GREEN} ${FOLDER} work ${YELLOW}${GREENFG}${SEP}${RESET}${YELLOW} ${BRANCH} main ${SEPTHIN} ${CHECK} ${RESET}${YELLOWFG}${SEP}${RESET}"',
    '',
    '# …and adopt it as the live PS1, so every later screenshot carries a Nerd Font prompt.',
    '# The colour escapes are wrapped in \\[ \\]: readline has to know which bytes are',
    '# non-printing or it mis-measures the prompt and wraps the echoed command on top of it —',
    '# which looks exactly like a rendering defect in a screenshot. The GLYPHS stay outside.',
    'PS1="\\[${BLUE}\\] ${APPLE} audit \\[${GREEN}${BLUEFG}\\]${SEP}\\[${RESET}${GREEN}\\] ${FOLDER} \\\\W \\[${YELLOW}${GREENFG}\\]${SEP}\\[${RESET}${YELLOW}\\] ${BRANCH} main \\[${RESET}${YELLOWFG}\\]${SEP}\\[${RESET}\\] "',
    'export PS1'
].join('\n');

/** The codepoints `PROMPT_FIXTURE` draws, for round-trip and font-coverage assertions. */
const PROMPT_GLYPHS = [
    [PUA.sep, 'powerline separator'],
    [PUA.sepThin, 'powerline thin separator'],
    [PUA.branch, 'branch'],
    [PUA.folder, 'folder'],
    [PUA.node, 'node'],
    [PUA.git, 'git'],
    [PUA.check, 'check'],
    [PUA.bolt, 'lightning'],
    [PUA.python, 'python'],
    [PUA.apple, 'apple']
];

/**
 * A Claude-Code-shaped prompt box drawn to the terminal's OWN reported width, plus a ruler
 * whose last five cells are the marker `[END]`.
 *
 * This is the whole "cols overrun" question made visible: the ruler is exactly `tput cols`
 * cells wide, so if the client hands the PTY more columns than it can paint, the `]` is off
 * the right edge; if it hands over fewer, the row wraps and `[END]` lands on a second line.
 * Both failures are unmissable in the screenshot AND countable in `nex pane capture`.
 *
 * Written with literal UTF-8 box-drawing characters — macOS `/bin/sh` is bash 3.2, whose
 * `printf` has no `\\u` escape and whose `tr` cannot map to a multibyte character.
 */
const WIDTH_FIXTURE = `cols=$(tput cols); rows=$(tput lines)
printf 'reported: %s cols x %s rows\\n' "$cols" "$rows"
ruler=""
i=1
while [ $i -le $cols ]; do
  case $(( i % 10 )) in
    0) ruler="$ruler|" ;;
    5) ruler="$ruler+" ;;
    *) ruler="$ruler-" ;;
  esac
  i=$(( i + 1 ))
done
printf '%s[END]\\n' "$(printf '%s' "$ruler" | cut -c1-$(( cols - 5 )))"
dash=""
i=1
while [ $i -le $(( cols - 2 )) ]; do dash="$dash─"; i=$(( i + 1 )); done
printf '╭%s╮\\n' "$dash"
printf '│ %-*s│\\n' $(( cols - 3 )) "full-width prompt box: type a message"
printf '╰%s╯\\n' "$dash"
`;

const MARKDOWN_FIXTURE = `---
title: Audit Fixture
author: ui-audit
tags: [markdown, audit]
---

# Markdown pane fixture

A paragraph with **bold**, _italic_, \`inline code\`, and a [link](https://example.com).

## A list

1. first item
2. second item
   - nested bullet
   - another

## A table

| column | meaning |
| --- | --- |
| one | the first |
| two | the second |

## A code block

\`\`\`ts
export function greet(name: string): string {
    return \`hello \${name}\`;
}
\`\`\`

> A blockquote, for the vertical rhythm.

---

Task list:

- [x] done
- [ ] not done
`;

function writeFixtures(sandbox) {
    const work = sandbox.work;
    fs.writeFileSync(path.join(work, 'glyphs.sh'), `${GLYPH_FIXTURE}\n`);
    fs.writeFileSync(path.join(work, 'prompt.sh'), `${PROMPT_FIXTURE}\n`);
    fs.writeFileSync(path.join(work, 'width.sh'), WIDTH_FIXTURE);
    fs.writeFileSync(path.join(work, 'AUDIT.md'), MARKDOWN_FIXTURE);
    // A few files so `ls` has something to say.
    for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
        fs.writeFileSync(path.join(work, name), `${name}\n`);
    }
    return work;
}

/** A tiny git repo with real staged + unstaged changes, so the diff pane has a diff. */
function makeRepo(sandbox) {
    const repo = path.join(sandbox.root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const git = (args) =>
        execFileSync('git', args, {
            cwd: repo,
            encoding: 'utf8',
            env: {
                PATH: sandbox.env.PATH,
                HOME: sandbox.home,
                GIT_AUTHOR_NAME: 'Audit',
                GIT_AUTHOR_EMAIL: 'audit@example.invalid',
                GIT_COMMITTER_NAME: 'Audit',
                GIT_COMMITTER_EMAIL: 'audit@example.invalid'
            }
        });
    git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(
        path.join(repo, 'service.ts'),
        ['export function total(values: number[]): number {', '    let sum = 0;', '    for (const value of values) sum += value;', '    return sum;', '}', ''].join('\n')
    );
    fs.writeFileSync(path.join(repo, 'README.md'), '# Audit repo\n\nOriginal line.\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'initial']);
    // now the working-tree change the diff pane must render
    fs.writeFileSync(
        path.join(repo, 'service.ts'),
        [
            'export function total(values: readonly number[]): number {',
            '    // an added comment line',
            '    return values.reduce((sum, value) => sum + value, 0);',
            '}',
            ''
        ].join('\n')
    );
    fs.writeFileSync(path.join(repo, 'README.md'), '# Audit repo\n\nEdited line.\nA brand new line.\n');
    return repo;
}

/** A local site for the web pane — a real origin beats `about:blank` for judging embedding. */
async function startFixtureSite() {
    const port = await freePort();
    const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>Nex UI Audit Fixture</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  header { padding: 24px 32px; background: linear-gradient(90deg,#2563eb,#7c3aed); color: white; }
  main { padding: 24px 32px; }
  .card { border: 1px solid #334155; border-radius: 10px; padding: 16px; margin: 12px 0; background:#111c33; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; background: #38bdf8; color: #082f49; }
</style></head>
<body>
  <header><h1 id="hello">Nex web pane fixture</h1><p>If you can read this inside a Nex pane, embedding works.</p></header>
  <main>
    <div class="card"><h2>Card one</h2><p>Some body copy to judge rendering, spacing and colour against.</p></div>
    <div class="card"><h2>Card two</h2><button id="go">Click me</button> <span id="out">idle</span></div>
  </main>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('out').textContent = 'clicked';
    });
    console.log('fixture page loaded');
  </script>
</body></html>`;
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(body);
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    server.unref();
    return { port, url: `http://127.0.0.1:${String(port)}/`, close: () => server.close() };
}

// ── page helpers (the vocabulary the flows speak) ────────────────────────────────────

const PAGE = {
    app: '[data-testid="nex-app"]',
    sidebar: '[data-testid="sidebar"]',
    workspaceRows: '[data-testid="workspace-row"]',
    grid: '[data-testid="pane-grid"]',
    footer: '[data-testid="status-footer"]',
    topBar: '[data-testid="top-bar"]',
    settingsPanel: '[data-testid="settings-panel"]',
    settingsButton: '[data-testid="sidebar-settings"]',
    contextMenu: '[data-testid="context-menu"]'
};

/**
 * How many panes the DOM shows.
 *
 * Counted off the pane HEADERS, not `[data-pane-id]`: the grid puts that attribute on the pane
 * container and `TerminalPane` puts it on its own root too, so a naive count double-counts
 * every shell pane. Exactly one header exists per pane.
 */
const paneCountExpr = `document.querySelectorAll('[data-testid^="pane-header-"]').length`;

/** Pane ids in DOM order — the audit addresses panes the way a user points at them. */
const paneIDsExpr = `Array.from(document.querySelectorAll('[data-testid^="pane-header-"]')).map(el => el.getAttribute('data-testid').slice('pane-header-'.length))`;

async function domPaneIDs(page) {
    return (await page.eval(paneIDsExpr)) ?? [];
}

/** Focus a pane by clicking its body — a real click, so focus follows the real code path. */
async function focusPaneBody(page, paneID) {
    const box = await page.box(`[data-testid="pane-body-${paneID}"]`);
    if (box === null) throw new Error(`no pane body for ${paneID}`);
    await page.clickAt(box.x + Math.min(60, box.width / 2), box.y + Math.min(40, box.height / 2));
    await sleep(200);
    return box;
}

/** Type a shell command into the focused terminal and press Return. */
async function runInTerminal(page, command, { settleMs = 900 } = {}) {
    await page.type(command);
    await page.key('Enter');
    await sleep(settleMs);
}

/**
 * Resize the actual window, the way dragging its corner would.
 *
 * `Browser.setWindowBounds` moves the real `BrowserWindow` (Electron implements the Browser
 * domain against it), which is the honest test: it goes through the OS, the compositor and the
 * renderer's own resize, exactly like a user's drag. Chromium builds that do not expose the
 * Browser domain fall back to `Emulation.setDeviceMetricsOverride`, which resizes the layout
 * viewport only — enough to exercise the client's ResizeObserver → cols → PTY path, and the
 * mechanism is recorded in the report so nobody has to guess which one ran.
 */
async function windowBounds(page) {
    const { windowId } = await page.send('Browser.getWindowForTarget');
    const { bounds } = await page.send('Browser.getWindowBounds', { windowId });
    return { windowId, bounds };
}

async function resizeWindow(page, width, height) {
    let mechanism = 'Browser.setWindowBounds';
    try {
        const { windowId } = await windowBounds(page);
        await page.send('Browser.setWindowBounds', {
            windowId,
            bounds: { width, height, windowState: 'normal' }
        });
    } catch {
        mechanism = 'Emulation.setDeviceMetricsOverride';
        await page.send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 0,
            mobile: false
        });
    }
    // The grid reflows on a ResizeObserver, the engine re-measures, the PTY gets a SIGWINCH and
    // the shell repaints — none of it synchronous with the resize call.
    await sleep(1400);
    const inner = await page.eval('({ w: window.innerWidth, h: window.innerHeight })');
    return { mechanism, inner };
}

/** Click a context-menu row by its visible label. */
async function clickMenuItem(page, label) {
    const clicked = await page.eval(
        `(() => {
            const menu = document.querySelector('[data-testid="context-menu"]');
            if (menu === null) return 'no-menu';
            const rows = Array.from(menu.querySelectorAll('[role="menuitem"]'));
            const row = rows.find(el => (el.textContent ?? '').trim().startsWith(${JSON.stringify(label)}));
            if (row === undefined) return 'no-row:' + rows.map(r => (r.textContent ?? '').trim()).join('/');
            const r = row.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
    );
    if (typeof clicked !== 'string' || !clicked.startsWith('{')) {
        throw new Error(`context menu item "${label}" not found (${String(clicked)})`);
    }
    const point = JSON.parse(clicked);
    await page.clickAt(point.x, point.y);
    await sleep(300);
}

// ── the run ─────────────────────────────────────────────────────────────────────────

async function main() {
    const startedAt = new Date().toISOString();
    process.stdout.write(`nex UI audit → ${outDir}\n`);

    if (options.build) {
        await buildAll(repoRoot, { log: (message) => process.stdout.write(`  ${message}\n`) });
    }

    const clientDir = path.join(repoRoot, 'packages', 'client', 'dist');
    if (!options.packaged && !fs.existsSync(path.join(clientDir, 'index.html'))) {
        throw new Error(`the web client is not built: ${clientDir}`);
    }

    const sandbox = await makeSandbox(repoRoot, {
        label: 'ui',
        ...(options.packaged ? {} : { clientDir })
    });
    if (options.packaged) delete sandbox.env.NEXD_ENTRY;

    const work = writeFixtures(sandbox);
    const repo = makeRepo(sandbox);
    const site = await startFixtureSite();

    const report = createReport({
        outDir,
        meta: {
            startedAt,
            commit: gitCommit(),
            shellMode: options.packaged ? 'packaged Nex.app' : 'dev electron (packages/shell)',
            sandboxRoot: sandbox.root,
            httpPort: sandbox.httpPort,
            controlPort: sandbox.controlPort,
            debugPort: sandbox.debugPort,
            fixtureSite: site.url,
            workDir: work,
            repoDir: repo
        }
    });

    const cli = makeCli(sandbox, { repoRoot });

    /**
     * A killed run must not leave an orphan daemon + Electron behind on a developer's machine.
     * The shell is spawned detached (so a ⌘Q dialog cannot take the harness with it), which
     * means Ctrl-C would otherwise strand it.
     */
    const teardownSignals = ['SIGINT', 'SIGTERM'];
    const onSignal = () => {
        try {
            runtime.shell?.child?.kill('SIGKILL');
            runtime.daemon?.child?.kill('SIGKILL');
        } catch {
            // best effort
        }
        process.exit(130);
    };
    for (const signal of teardownSignals) process.on(signal, onSignal);
    /**
     * The live processes. Held in one mutable object because the reattach flow deliberately
     * kills the shell and starts another: teardown must find the CURRENT pair, not the ones
     * that existed when the flows were built.
     */
    const runtime = { daemon: null, shell: null, page: null };

    const skip = (id) => options.only !== null && !options.only.includes(id);

    try {
        // The daemon's first pane should open in the fixture dir, so `ls` has content.
        runtime.daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
        await waitForHealthz(sandbox.base);

        runtime.shell = startShell(sandbox, {
            repoRoot,
            packaged: options.packaged,
            verbose: options.verbose,
            extraEnv: { NEX_AUDIT: '1' }
        });
        const target = await waitForPageTarget(sandbox.debugPort, { timeoutMs: 90_000 });
        const page = await connect(target.webSocketDebuggerUrl, { repoRoot, verbose: false });
        runtime.page = page;
        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('DOM.enable');
        await page.watchFrames();

        // Collect renderer console errors for the whole run — a silent red console is a finding.
        const consoleErrors = [];
        page.on('Runtime.consoleAPICalled', (params) => {
            if (params.type === 'error' || params.type === 'warning') {
                consoleErrors.push(
                    `${params.type}: ${(params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' ')}`
                );
            }
        });
        page.on('Runtime.exceptionThrown', (params) => {
            consoleErrors.push(`exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '?'}`);
        });

        await page.waitFor(`document.querySelector('${PAGE.app}') !== null`, {
            timeoutMs: 60_000,
            label: 'the app to mount'
        });
        // Give the first terminal time to load its WASM engine and paint.
        await sleep(2500);

        const flows = buildFlows({ report, page, cli, sandbox, work, repo, site, consoleErrors, runtime, repoRoot, options });
        for (const flow of flows) {
            if (skip(flow.id)) continue;
            const recorder = report.step(flow.id, { expect: flow.expect, needsEyes: flow.needsEyes === true });
            await report.guard(recorder, () => flow.run(recorder));
        }

        // The console tally is its own step so it lands in the report even when nothing failed.
        const consoleStep = report.step('renderer-console', {
            expect: 'the renderer produced no errors or warnings across the whole session.'
        });
        await report.guard(consoleStep, async () => {
            const unique = [...new Set(consoleErrors)];
            consoleStep.check('no renderer console errors/warnings', unique.length === 0, `${String(unique.length)} distinct`);
            if (unique.length > 0) consoleStep.block('renderer console', unique.slice(0, 60).join('\n'));
        });
    } finally {
        try {
            runtime.page?.close();
        } catch {
            // already gone
        }
        site.close();
        if (runtime.shell !== null) await runtime.shell.quit();
        if (runtime.daemon !== null) await runtime.daemon.stop();

        const summary = report.write();
        process.stdout.write(
            `\n${String(summary.total)} steps · ${String(summary.assertions)} assertions · ` +
                `${String(summary.failedAssertions)} failed · ${String(summary.errored)} step errors · ` +
                `${String(summary.eyes)} need eyes\n`
        );
        process.stdout.write(`report: ${path.join(outDir, 'index.md')}\n`);
        if (options.keep) process.stdout.write(`sandbox kept: ${sandbox.root}\n`);
        else sandbox.cleanup();
    }
}

// ── the flows ───────────────────────────────────────────────────────────────────────

function buildFlows(ctx) {
    const { page, cli, sandbox, work, repo, site, runtime, repoRoot, options: runOptions } = ctx;
    /** Mutable across flows: the panes the audit created, so later steps can address them. */
    const state = { firstPane: null, mdPane: null, diffPane: null, webPane: null, secondWorkspace: null };

    return [
        // ── boot ────────────────────────────────────────────────────────────────────
        {
            id: 'fresh-boot',
            expect:
                'A window with a sidebar (one "Default" workspace), a centred title-bar identity, one focused terminal pane showing a shell prompt, and a footer with cwd + agent counts + clock.',
            needsEyes: true,
            async run(recorder) {
                await recorder.shot(page);
                const shape = await page.eval(
                    `(() => ({
                        app: document.querySelector('${PAGE.app}') !== null,
                        sidebar: document.querySelector('${PAGE.sidebar}') !== null,
                        rows: document.querySelectorAll('${PAGE.workspaceRows}').length,
                        grid: document.querySelector('${PAGE.grid}') !== null,
                        panes: ${paneCountExpr},
                        footer: (document.querySelector('${PAGE.footer}')?.innerText ?? '').replace(/\\n/g, ' | '),
                        topBar: (document.querySelector('${PAGE.topBar}')?.innerText ?? '').replace(/\\n/g, ' | '),
                        terminals: document.querySelectorAll('[data-terminal-host]').length,
                        canvases: document.querySelectorAll('[data-terminal-host] canvas').length,
                        bodyBg: getComputedStyle(document.body).backgroundColor,
                        title: document.title
                    }))()`
                );
                recorder.check('app root mounted', shape.app === true);
                recorder.check('sidebar present', shape.sidebar === true);
                recorder.check('exactly one workspace row', shape.rows === 1, `rows=${String(shape.rows)}`);
                recorder.check('exactly one pane', shape.panes === 1, `panes=${String(shape.panes)}`);
                recorder.check('a terminal canvas painted', shape.canvases >= 1, `canvases=${String(shape.canvases)}`);
                recorder.check('footer rendered', shape.footer.length > 0, shape.footer);
                recorder.note(`top bar: ${shape.topBar}`);
                recorder.note(`document.title: ${shape.title}`);
                recorder.note(`body background: ${shape.bodyBg}`);
                const panes = await cli.json(['pane', 'list', '--json']);
                state.firstPane = panes[0]?.id ?? null;
                recorder.check('daemon agrees: one pane', panes.length === 1, `cli reports ${String(panes.length)}`);
                recorder.eyes('spacing, contrast, focus ring, prompt legibility, title-bar affordances vs shell-ui.md §3');
            }
        },

        // ── terminal: typing and reading ────────────────────────────────────────────
        {
            id: 'terminal-ls',
            expect:
                'Typing `ls -la` into the focused pane echoes the keystrokes and prints a directory listing; the same text is readable through `nex pane capture`.',
            needsEyes: true,
            async run(recorder) {
                const paneID = (await domPaneIDs(page))[0];
                state.firstPane = paneID ?? state.firstPane;
                await focusPaneBody(page, paneID);
                await runInTerminal(page, `cd ${work}`);
                await runInTerminal(page, 'ls -la');
                await sleep(600);
                await recorder.shot(page);
                const capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                recorder.block('nex pane capture', capture);
                recorder.check('keystrokes reached the PTY', capture.includes('ls -la'), 'the typed command is echoed');
                recorder.check('listing contains the fixture files', capture.includes('alpha.txt') && capture.includes('AUDIT.md'));
                recorder.eyes('does the listing on screen match the capture text, column for column?');
            }
        },
        {
            id: 'terminal-long-line',
            expect:
                'A 420-character single logical line wraps cleanly across rows with no dropped or duplicated characters, and the trailing marker `<<<END420` is visible.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.firstPane;
                await focusPaneBody(page, paneID);
                await runInTerminal(
                    page,
                    `printf 'START420>>>%s<<<END420\\n' "$(printf 'x%.0s' $(seq 1 400))"`,
                    { settleMs: 1200 }
                );
                await recorder.shot(page);
                const capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                recorder.block('nex pane capture', capture);
                const joined = capture.replace(/\n/g, '');
                recorder.check('the wrapped line starts where expected', joined.includes('START420>>>'));
                recorder.check('the wrapped line ends where expected', joined.includes('<<<END420'));
                const xs = (joined.match(/x/g) ?? []).length;
                recorder.check('all 400 filler characters survived', xs >= 400, `counted ${String(xs)} (>=400 because the echoed command also contains x)`);
                recorder.eyes('does the wrap land at the right column, with no clipped or doubled glyphs at the seam?');
            }
        },
        {
            id: 'terminal-full-width',
            expect:
                'A ruler drawn to the terminal\'s own `tput cols`, ending in `[END]`, occupies exactly one row and its final `]` is fully visible; a box-drawn full-width prompt frame closes flush with the right edge.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.firstPane;
                await focusPaneBody(page, paneID);
                await runInTerminal(page, 'clear', { settleMs: 400 });
                await runInTerminal(page, `sh ${path.join(work, 'width.sh')}`, { settleMs: 1800 });
                await recorder.shot(page);
                const capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                recorder.block('nex pane capture', capture);
                const reported = /reported:\s+(\d+)\s+cols\s+x\s+(\d+)\s+rows/.exec(capture);
                recorder.check('the PTY reports a size', reported !== null, reported === null ? capture.slice(0, 200) : `${reported[1]}x${reported[2]}`);
                if (reported !== null) recorder.note(`PTY size: ${reported[1]} cols x ${reported[2]} rows`);
                const endLines = capture.split('\n').filter((line) => line.includes('[END]'));
                recorder.check('the full-width ruler is a single unwrapped row', endLines.length === 1, `${String(endLines.length)} rows contain [END]`);
                if (endLines.length === 1 && reported !== null) {
                    const width = [...endLines[0].trimEnd()].length;
                    recorder.check(
                        'the ruler row is exactly the reported width',
                        width === Number(reported[1]),
                        `row is ${String(width)} cells, PTY says ${reported[1]}`
                    );
                }
                // Does the canvas overflow its container? That is the "cols overrun" signature.
                const overflow = await page.eval(
                    `(() => {
                        const host = document.querySelector('[data-testid="pane-body-${paneID}"] [data-terminal-host]');
                        if (host === null) return null;
                        const canvas = host.querySelector('canvas');
                        const h = host.getBoundingClientRect();
                        const c = canvas === null ? null : canvas.getBoundingClientRect();
                        return { host: { w: h.width, h: h.height },
                                 canvas: c === null ? null : { w: c.width, h: c.height },
                                 scrollW: host.scrollWidth, clientW: host.clientWidth };
                    })()`
                );
                recorder.note(`terminal host geometry: ${JSON.stringify(overflow)}`);
                if (overflow !== null && overflow.canvas !== null) {
                    recorder.check(
                        'the terminal canvas fits inside its pane body',
                        overflow.canvas.w <= overflow.host.w + 1,
                        `canvas ${String(Math.round(overflow.canvas.w))}px vs host ${String(Math.round(overflow.host.w))}px`
                    );
                }
                recorder.eyes('is the final `]` of [END] painted, and does the box frame close flush with the pane edge?');
            }
        },
        {
            id: 'terminal-glyphs',
            expect:
                'Box-drawing, powerline, Nerd Font, emoji, CJK and arrow glyphs all render as real glyphs (no ▯ tofu boxes), and SGR colour/bold/dim/italic/underline/reverse are visually distinct.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.firstPane;
                await focusPaneBody(page, paneID);
                await runInTerminal(page, 'clear', { settleMs: 400 });
                await runInTerminal(page, `sh ${path.join(work, 'glyphs.sh')}`, { settleMs: 1600 });
                await recorder.shot(page);
                const capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                recorder.block('nex pane capture', capture);
                recorder.check('box-drawing round-trips through the VT', capture.includes('╭') && capture.includes('█'));
                recorder.check('emoji round-trip through the VT', capture.includes('🚀'));
                recorder.check('CJK round-trips through the VT', capture.includes('日本語'));
                // The fixture's own integrity: the first version of this file shipped the two
                // private-use rows as runs of spaces, and the audit reported the empty rows as
                // a renderer defect. A fixture that loses its glyphs must fail loudly.
                const puaMissing = Object.entries(PUA)
                    .filter(([, glyph]) => !capture.includes(glyph))
                    .map(([name]) => name);
                recorder.check(
                    'the private-use rows actually carry their glyphs (fixture integrity)',
                    puaMissing.length === 0,
                    puaMissing.length === 0 ? `${String(Object.keys(PUA).length)} codepoints` : `missing: ${puaMissing.join(', ')}`
                );
                recorder.eyes('TOFU CHECK — every row must show real glyphs, not ▯/□ boxes. This is the known font defect.');
            }
        },
        {
            id: 'terminal-nerdfont-prompt',
            expect:
                'A powerlevel10k-shaped prompt — Powerline separators, a branch glyph and Nerd Font icons — renders as real glyphs both in the printed sample row and in the LIVE prompt the shell now draws. No tofu, and no blank cells where a private-use glyph should be.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.firstPane ?? (await domPaneIDs(page))[0];
                await focusPaneBody(page, paneID);
                await runInTerminal(page, 'clear', { settleMs: 400 });
                await runInTerminal(page, `. ${path.join(work, 'prompt.sh')}`, { settleMs: 1400 });
                // A command after the source, so the screenshot holds the live PS1 twice.
                await runInTerminal(page, 'echo prompt is live', { settleMs: 900 });
                await recorder.shot(page);

                const capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                recorder.block('nex pane capture', capture);
                const missing = PROMPT_GLYPHS.filter(([glyph]) => !capture.includes(glyph)).map(
                    ([glyph, name]) => `${name} U+${glyph.codePointAt(0).toString(16).toUpperCase()}`
                );
                recorder.check(
                    'every prompt glyph round-trips through the VT',
                    missing.length === 0,
                    missing.length === 0 ? `${String(PROMPT_GLYPHS.length)} codepoints` : `missing: ${missing.join(', ')}`
                );

                /**
                 * The closest thing to a machine tofu check that exists: `document.fonts.check`
                 * answers "can the loaded faces render this text in this font?" — false is
                 * precisely the state that paints a box (or, with these codepoints, nothing).
                 */
                const coverage = await page.eval(
                    `(() => {
                        const family = '13px "JetBrainsMono Nerd Font"';
                        const glyphs = ${JSON.stringify(PROMPT_GLYPHS.map(([glyph, name]) => [glyph, name]))};
                        const loaded = Array.from(document.fonts).filter(f => f.family.includes('JetBrainsMono')).map(f => f.family + ' ' + f.weight + ' ' + f.status);
                        return {
                            loaded,
                            missing: glyphs.filter(([g]) => !document.fonts.check(family, g)).map(([g, n]) => n),
                            stack: (() => {
                                const host = document.querySelector('[data-terminal-host]');
                                return host === null ? null : getComputedStyle(host).fontFamily;
                            })()
                        };
                    })()`
                );
                recorder.note(`bundled faces: ${JSON.stringify(coverage?.loaded ?? [])}`);
                recorder.note(`terminal host font-family: ${String(coverage?.stack ?? 'n/a')}`);
                recorder.check(
                    'the bundled Nerd Font is loaded in the renderer',
                    (coverage?.loaded ?? []).some((entry) => entry.endsWith('loaded')),
                    JSON.stringify(coverage?.loaded ?? [])
                );
                recorder.check(
                    'the loaded faces cover every prompt glyph',
                    (coverage?.missing ?? ['unknown']).length === 0,
                    (coverage?.missing ?? []).join(', ')
                );
                recorder.eyes(
                    'TOFU CHECK (the M2 regression): the separators must be solid filled triangles, the branch/folder/icons real pictograms — not ▯, not blank.'
                );
            }
        },
        {
            id: 'terminal-size-matrix',
            expect:
                'At three different window sizes the terminal grid stays exactly as wide as the pane: the full-width ruler is one unwrapped row of exactly `tput cols` cells, its final `]` is fully painted, the first column is not clipped by the border, and the canvas neither overruns the pane nor leaves a column-wide gap.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.firstPane ?? (await domPaneIDs(page))[0];
                let original = null;
                try {
                    original = (await windowBounds(page)).bounds;
                } catch {
                    recorder.note('Browser domain unavailable; using viewport emulation');
                }
                recorder.note(`original window bounds: ${JSON.stringify(original)}`);

                // Deliberately spread: a narrow window, the default, and a wide one. Each pass
                // re-runs the width fixture, because the fixture is drawn to whatever `tput
                // cols` says AT THAT MOMENT — the only honest way to ask "did the resize leave
                // the PTY and the canvas agreeing?".
                for (const [label, width, height] of [
                    ['narrow', 900, 680],
                    ['medium', 1280, 820],
                    ['wide', 1680, 1000]
                ]) {
                    const resized = await resizeWindow(page, width, height);
                    recorder.note(
                        `${label}: asked ${String(width)}x${String(height)} · ${resized.mechanism} · innerWidth ${String(resized.inner?.w)}`
                    );
                    await focusPaneBody(page, paneID);
                    await runInTerminal(page, 'clear', { settleMs: 400 });
                    await runInTerminal(page, `sh ${path.join(work, 'width.sh')}`, { settleMs: 1800 });
                    await recorder.shot(page, label);

                    const capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                    recorder.artifact(`${label}-capture.txt`, capture);
                    const reported = /reported:\s+(\d+)\s+cols\s+x\s+(\d+)\s+rows/.exec(capture);
                    recorder.check(`${label}: the PTY reports a size`, reported !== null, reported === null ? '' : `${reported[1]}x${reported[2]}`);
                    const endLines = capture.split('\n').filter((line) => line.includes('[END]'));
                    recorder.check(
                        `${label}: the full-width ruler is a single unwrapped row`,
                        endLines.length === 1,
                        `${String(endLines.length)} rows contain [END]`
                    );
                    if (endLines.length === 1 && reported !== null) {
                        const cells = [...endLines[0].trimEnd()].length;
                        recorder.check(
                            `${label}: the ruler row is exactly the reported width`,
                            cells === Number(reported[1]),
                            `row ${String(cells)} cells vs PTY ${reported[1]} cols`
                        );
                    }

                    const geometry = await page.eval(
                        `(() => {
                            const body = document.querySelector('[data-testid="pane-body-${paneID}"]');
                            const host = body === null ? null : body.querySelector('[data-terminal-host]');
                            if (host === null) return null;
                            const canvas = host.querySelector('canvas');
                            const h = host.getBoundingClientRect();
                            const b = body.getBoundingClientRect();
                            const c = canvas === null ? null : canvas.getBoundingClientRect();
                            return {
                                body: { w: b.width, h: b.height },
                                host: { w: h.width, h: h.height, left: h.left - b.left, right: b.right - h.right },
                                canvas: c === null ? null : { w: c.width, h: c.height, left: c.left - h.left, right: h.right - c.right },
                                scrollW: host.scrollWidth,
                                clientW: host.clientWidth
                            };
                        })()`
                    );
                    recorder.note(`${label}: geometry ${JSON.stringify(geometry)}`);
                    if (geometry !== null && geometry.canvas !== null) {
                        recorder.check(
                            `${label}: the canvas does not overrun the pane body`,
                            geometry.canvas.w <= geometry.host.w + 1,
                            `canvas ${String(Math.round(geometry.canvas.w))}px vs host ${String(Math.round(geometry.host.w))}px`
                        );
                        // The other half of the same defect: a grid a whole column narrower than
                        // the pane is a visible dead stripe down the right edge.
                        recorder.check(
                            `${label}: the canvas leaves less than one column unused`,
                            geometry.host.w - geometry.canvas.w < 12,
                            `${String(Math.round(geometry.host.w - geometry.canvas.w))}px unused`
                        );
                        recorder.check(
                            `${label}: the host does not scroll horizontally`,
                            geometry.scrollW <= geometry.clientW + 1,
                            `scrollWidth ${String(Math.round(geometry.scrollW))} vs clientWidth ${String(Math.round(geometry.clientW))}`
                        );
                    }
                    recorder.eyes(
                        `${label} (${String(width)}x${String(height)}): is the FIRST character of every row fully visible (not half-eaten by the border), and is the final \`]\` of [END] fully painted?`
                    );
                }

                // Hand the rest of the run the window it started with.
                if (original !== null) {
                    await resizeWindow(page, original.width, original.height);
                } else {
                    await page.send('Emulation.clearDeviceMetricsOverride');
                    await sleep(1200);
                }
                await focusPaneBody(page, paneID);
                await runInTerminal(page, 'clear', { settleMs: 500 });
                await recorder.shot(page, 'restored');
            }
        },

        // ── splitting ───────────────────────────────────────────────────────────────
        {
            id: 'split-keybinding',
            expect: 'Pressing ⌘D splits the focused pane to the right: two panes side by side, a 2px divider between them, the new pane focused with its own prompt.',
            needsEyes: true,
            async run(recorder) {
                const before = await page.eval(paneCountExpr);
                // `--only split-keybinding` skips the step that records the first pane, so
                // resolve it from the DOM rather than depending on run order.
                state.firstPane = state.firstPane ?? (await domPaneIDs(page))[0];
                // The real user path: the terminal has keyboard focus, because it always does.
                await focusPaneBody(page, state.firstPane);
                const focusInfo = await page.eval(
                    `(() => { const el = document.activeElement;
                              return { tag: el?.tagName ?? null, contentEditable: el?.isContentEditable ?? null,
                                       testid: el?.getAttribute?.('data-testid') ?? null }; })()`
                );
                recorder.note(`focus before ⌘D: ${JSON.stringify(focusInfo)}`);
                await page.key('KeyD', { modifiers: MOD.meta });
                await sleep(2000);
                await recorder.shot(page);
                let after = await page.eval(paneCountExpr);
                recorder.check('⌘D splits while the TERMINAL has focus (the only way a user does it)', after === before + 1, `${String(before)} → ${String(after)}`);

                if (after === before) {
                    // Isolate the cause: can the harness deliver ⌘D at all? Focus chrome and retry.
                    // If this one works, the keystroke is fine and the terminal focus is the blocker.
                    await page.click(PAGE.workspaceRows);
                    await sleep(400);
                    await page.key('KeyD', { modifiers: MOD.meta });
                    await sleep(2000);
                    const afterChrome = await page.eval(paneCountExpr);
                    recorder.check(
                        'CONTROL: the same ⌘D works when chrome (the sidebar) has focus',
                        afterChrome === before + 1,
                        `${String(before)} → ${String(afterChrome)} — if this passes, the keystroke is fine and terminal focus is what breaks the binding`
                    );
                    recorder.note(
                        'diagnosis: ghostty-web marks its host element contenteditable, and the client\'s ' +
                            'isEditableTarget() treats a contenteditable target as "the user is typing into chrome", ' +
                            'so every non-MENU_BAR action is skipped whenever a terminal pane has focus.'
                    );
                    await recorder.shot(page, 'after-chrome-focus-retry');
                    after = afterChrome;
                }
                const panes = await cli.json(['pane', 'list', '--json']);
                recorder.check('daemon agrees', panes.length === after, `cli=${String(panes.length)} dom=${String(after)}`);
                const layout = await page.eval(
                    `(() => Array.from(document.querySelectorAll('[data-testid^="pane-header-"]')).map(el => {
                        const r = el.parentElement.getBoundingClientRect();
                        return { id: el.getAttribute('data-testid').slice(12), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                    }))()`
                );
                recorder.note(`pane frames: ${JSON.stringify(layout)}`);
                if (layout.length === 2) {
                    recorder.check(
                        'the split is horizontal (side by side)',
                        Math.abs(layout[0].y - layout[1].y) < 4 && Math.abs(layout[0].x - layout[1].x) > 50,
                        `y delta ${String(Math.abs(layout[0].y - layout[1].y))}`
                    );
                }
                const dividers = await page.eval(`document.querySelectorAll('[data-testid^="divider-"]').length`);
                recorder.check('a divider handle exists', dividers >= 1, `${String(dividers)} dividers`);

                /**
                 * Where did the caret go? The Swift app (and this step's own expectation
                 * sentence) put focus on the NEW pane, which is what makes "split, then type"
                 * work without touching the mouse. Reading it off the DOM turns an eyes-only
                 * impression — "the ring is still on the left one" — into a regression check.
                 */
                const focusAfter = await page.eval(
                    `(() => {
                        const headers = Array.from(document.querySelectorAll('[data-testid^="pane-header-"]'));
                        const focused = headers.filter(el => el.getAttribute('data-focused') === 'true')
                            .map(el => el.getAttribute('data-testid').slice('pane-header-'.length));
                        return { focused, order: headers.map(el => el.getAttribute('data-testid').slice('pane-header-'.length)) };
                    })()`
                );
                const newPane = (focusAfter.order ?? []).find((id) => id !== state.firstPane) ?? null;
                recorder.note(`focus after the split: ${JSON.stringify(focusAfter)} (new pane ${String(newPane)})`);
                if (newPane !== null) {
                    recorder.check(
                        'the NEW pane takes focus after the split',
                        (focusAfter.focused ?? []).includes(newPane),
                        `focused=${JSON.stringify(focusAfter.focused)}, new=${String(newPane)}`
                    );
                }
                recorder.eyes('divider thickness/contrast, focus ring on the NEW pane, both prompts legible');
            }
        },
        {
            id: 'split-cli',
            expect: '`nex pane split --direction vertical` adds a third pane stacked below the target, and the UI updates live without a reload.',
            async run(recorder) {
                const before = await page.eval(paneCountExpr);
                const reply = await cli.json(['pane', 'split', '--direction', 'vertical', '--target', state.firstPane, '--json']);
                recorder.note(`split reply: ${JSON.stringify(reply)}`);
                await sleep(2200);
                await recorder.shot(page);
                const after = await page.eval(paneCountExpr);
                recorder.check('the CLI split reached the UI', after === before + 1, `${String(before)} → ${String(after)}`);
                recorder.check('the reply names the new pane', typeof reply.pane_id === 'string' && reply.pane_id.length > 0, String(reply.pane_id));
                const present = await page.eval(
                    `document.querySelector('[data-testid="pane-header-' + ${JSON.stringify(String(reply.pane_id))} + '"]') !== null`
                );
                recorder.check('the new pane id is in the DOM', present === true);
            }
        },
        {
            id: 'keybinding-blast-radius',
            expect:
                'With a terminal focused (the normal state), every default keybinding fires: pane commands (⌘D, ⌘], ⇧⌘Space) as well as menu-bar ones (⌘P, ⇧⌘S).',
            async run(recorder) {
                await focusPaneBody(page, state.firstPane);
                const activeInfo = await page.eval(
                    `(() => { const el = document.activeElement;
                              return { tag: el?.tagName, contentEditable: el?.isContentEditable,
                                       inTerminal: el?.closest?.('[data-terminal-host]') !== null }; })()`
                );
                recorder.note(`focused element: ${JSON.stringify(activeInfo)}`);

                /**
                 * Each probe reads a single observable BEFORE and AFTER the chord, and "fired"
                 * means the observable moved. Never `element === null` on its own: a missing
                 * element would make a dead binding look alive.
                 */
                const probes = [
                    {
                        name: '⌘P — command_palette (menu-bar action)',
                        observe: `document.querySelector('[data-testid="command-palette"]') === null ? 'closed' : 'open'`,
                        press: () => page.key('KeyP', { modifiers: MOD.meta }),
                        undo: () => page.key('Escape')
                    },
                    {
                        name: '⇧⌘S — toggle_sidebar (menu-bar action)',
                        observe: `document.querySelector('[data-testid="sidebar"]') === null ? 'hidden' : 'shown'`,
                        press: () => page.key('KeyS', { modifiers: MOD.meta | MOD.shift }),
                        undo: () => page.key('KeyS', { modifiers: MOD.meta | MOD.shift })
                    },
                    {
                        name: '⇧⌘Space — cycle_layout (pane action)',
                        observe: `(document.querySelector('[data-testid="layout-cycle"]')?.innerText ?? '<<no layout control>>').trim()`,
                        press: () => page.key('Space', { modifiers: MOD.meta | MOD.shift }),
                        undo: null
                    },
                    {
                        name: '⌘] — focus_next_pane (pane action)',
                        observe: `Array.from(document.querySelectorAll('[data-testid^="pane-header-"]')).find(el => el.getAttribute('data-focused') === 'true')?.getAttribute('data-testid') ?? '<<none focused>>'`,
                        press: () => page.key('BracketRight', { modifiers: MOD.meta, key: ']', keyCode: 221 }),
                        undo: null
                    },
                    {
                        name: '⌘D — split_right (pane action)',
                        observe: paneCountExpr,
                        press: () => page.key('KeyD', { modifiers: MOD.meta }),
                        undo: null,
                        cleanup: true
                    }
                ];

                const dead = [];
                for (const probe of probes) {
                    await focusPaneBody(page, state.firstPane);
                    const before = await page.eval(probe.observe);
                    await probe.press();
                    await sleep(1100);
                    const after = await page.eval(probe.observe);
                    const fired = String(after) !== String(before);
                    if (!fired) dead.push(probe.name);
                    recorder.check(
                        `${probe.name} fires while a terminal is focused`,
                        fired,
                        `${String(before)} → ${String(after)}`
                    );
                    if (probe.undo !== null && fired) {
                        await probe.undo();
                        await sleep(500);
                    }
                    if (probe.cleanup === true && fired) {
                        // Undo the extra pane so later steps see a predictable grid.
                        const ids = await domPaneIDs(page);
                        const extra = ids[ids.length - 1];
                        if (extra !== state.firstPane) await cli.run(['pane', 'close', '--target', extra]);
                        await sleep(1200);
                    }
                }
                await recorder.shot(page);
                // The diagnosis is only printed when there is something to diagnose: an
                // unconditional note reads, on a green run, as if the defect were still open.
                if (dead.length > 0) {
                    recorder.note(
                        `dead with a terminal focused: ${dead.join(', ')}. A split between menu-bar ` +
                            'actions (working) and pane actions (dead) points at dispatcher step 6 — ' +
                            '`isEditableTarget(event.target)` — rather than at key delivery.'
                    );
                } else {
                    recorder.note(
                        'every probe fired with the terminal focused — the pane keymap is live in the ' +
                            'state the app actually boots in.'
                    );
                }
            }
        },
        {
            id: 'divider-drag',
            expect: 'Dragging the vertical divider ~140px to the right widens the left pane and narrows the right one; a size overlay appears during the drag.',
            needsEyes: true,
            async run(recorder) {
                const dividers = await page.eval(
                    `Array.from(document.querySelectorAll('[data-testid^="divider-"]')).map(el => {
                        const r = el.getBoundingClientRect();
                        return { id: el.getAttribute('data-testid'), x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height, top: r.y, height: r.height };
                    })`
                );
                recorder.note(`dividers: ${JSON.stringify(dividers)}`);
                const vertical = dividers.find((divider) => divider.h > divider.w);
                if (vertical === undefined) {
                    recorder.check('a vertical divider exists to drag', false, JSON.stringify(dividers));
                    return;
                }
                /**
                 * Divider hit strips are 10 px bands, and at a T-junction two of them overlap —
                 * the centre of a full-height divider can sit underneath the perpendicular one,
                 * whose element wins `elementFromPoint`. Walk down the bar until the point
                 * really belongs to the divider we mean to drag, and say so if none does.
                 */
                let grabY = vertical.y;
                let owner = null;
                for (const fraction of [0.5, 0.25, 0.75, 0.12, 0.88]) {
                    const candidate = vertical.top + vertical.height * fraction;
                    owner = await page.eval(
                        `(() => { const el = document.elementFromPoint(${String(vertical.x)}, ${String(candidate)});
                                  return el?.closest?.('[data-testid^="divider-"]')?.getAttribute('data-testid') ?? String(el?.tagName ?? 'none'); })()`
                    );
                    if (owner === vertical.id) {
                        grabY = candidate;
                        break;
                    }
                }
                recorder.note(`grab point (${String(Math.round(vertical.x))}, ${String(Math.round(grabY))}) belongs to ${String(owner)}`);
                recorder.check(
                    'the divider is grabbable somewhere along its length',
                    owner === vertical.id,
                    `elementFromPoint resolved to ${String(owner)}; overlapping hit strips at a T-junction can shadow it`
                );
                const widthsBefore = await page.eval(
                    `Object.fromEntries(Array.from(document.querySelectorAll('[data-testid^="pane-header-"]')).map(el => [el.getAttribute('data-testid').slice(12), Math.round(el.parentElement.getBoundingClientRect().width)]))`
                );
                // Press, move, sample the live overlay, screenshot, keep moving, then release —
                // the extra moves after the capture mean a slow screenshot cannot swallow the
                // gesture, and the sampled overlay is a machine-checkable version of "you can
                // see the new size while dragging".
                await page.mouse('mouseMoved', vertical.x, grabY, { button: 'none', buttons: 0 });
                await page.mouse('mousePressed', vertical.x, grabY, { button: 'left', clickCount: 1 });
                for (let step = 1; step <= 10; step++) {
                    await page.mouse('mouseMoved', vertical.x + step * 14, grabY, { button: 'left', buttons: 1 });
                    await sleep(25);
                }
                const midDrag = await page.eval(
                    `(() => ({ dragging: document.querySelector('[data-testid="${vertical.id}"]')?.getAttribute('data-dragging') ?? null,
                               badges: Array.from(document.querySelectorAll('[data-testid^="pane-size-"]')).map(el => el.innerText) }))()`
                );
                recorder.note(`mid-drag: ${JSON.stringify(midDrag)}`);
                recorder.check('the divider reports itself as dragging', midDrag.dragging === 'true', String(midDrag.dragging));
                recorder.check(
                    'a live cols × rows overlay is shown while dragging',
                    (midDrag.badges ?? []).length > 0 && /\d+\s*[x×]\s*\d+/.test(String(midDrag.badges[0])),
                    JSON.stringify(midDrag.badges)
                );
                await recorder.shot(page, 'mid-drag');
                for (let step = 11; step <= 14; step++) {
                    await page.mouse('mouseMoved', vertical.x + step * 14, grabY, { button: 'left', buttons: 1 });
                    await sleep(25);
                }
                await page.mouse('mouseReleased', vertical.x + 196, grabY, { button: 'left', clickCount: 1 });
                await sleep(900);
                await recorder.shot(page, 'after');
                const widthsAfter = await page.eval(
                    `Object.fromEntries(Array.from(document.querySelectorAll('[data-testid^="pane-header-"]')).map(el => [el.getAttribute('data-testid').slice(12), Math.round(el.parentElement.getBoundingClientRect().width)]))`
                );
                recorder.note(`widths before: ${JSON.stringify(widthsBefore)}`);
                recorder.note(`widths after:  ${JSON.stringify(widthsAfter)}`);
                const changed = Object.keys(widthsBefore).filter(
                    (id) => widthsAfter[id] !== undefined && Math.abs(widthsAfter[id] - widthsBefore[id]) > 20
                );
                recorder.check('the drag resized panes', changed.length >= 1, `changed: ${changed.join(', ') || 'none'}`);
                recorder.eyes('does a size overlay (cols×rows) show during the drag, and does the terminal reflow to the new width?');
            }
        },
        {
            id: 'close-pane',
            expect: '⌘W closes the focused pane and the survivors re-flow to fill the space.',
            async run(recorder) {
                const before = await page.eval(paneCountExpr);
                const ids = await domPaneIDs(page);
                const victim = ids.find((id) => id !== state.firstPane) ?? ids[ids.length - 1];
                await focusPaneBody(page, victim);
                await page.key('KeyW', { modifiers: MOD.meta });
                await sleep(1400);
                await recorder.shot(page);
                let after = await page.eval(paneCountExpr);
                recorder.check('⌘W closes the focused TERMINAL pane', after === before - 1, `${String(before)} → ${String(after)}`);
                if (after === before) {
                    recorder.note('falling back to `nex pane close --target` so the rest of the audit can continue');
                    await cli.run(['pane', 'close', '--target', victim]);
                    await sleep(1400);
                    await recorder.shot(page, 'cli-fallback');
                    after = await page.eval(paneCountExpr);
                    recorder.check('the CLI could close it', after === before - 1, `${String(before)} → ${String(after)}`);
                }
                const gone = await page.eval(`document.querySelector('[data-testid="pane-header-${victim}"]') === null`);
                recorder.check('the closed pane left the DOM', gone === true);
                const panes = await cli.json(['pane', 'list', '--json']);
                recorder.check('daemon agrees', panes.length === after, `cli=${String(panes.length)} dom=${String(after)}`);
            }
        },

        // ── workspaces ──────────────────────────────────────────────────────────────
        {
            id: 'workspace-create-ui',
            expect: 'Clicking "New Workspace" opens an inline name field; typing "Audit Two" and pressing Return adds a second sidebar row and switches to it.',
            needsEyes: true,
            async run(recorder) {
                const before = await page.eval(`document.querySelectorAll('${PAGE.workspaceRows}').length`);
                const clicked = await page.eval(
                    `(() => {
                        const button = Array.from(document.querySelectorAll('button')).find(el => (el.textContent ?? '').trim() === 'New Workspace');
                        if (button === undefined) return null;
                        const r = button.getBoundingClientRect();
                        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
                    })()`
                );
                recorder.check('the New Workspace button exists', typeof clicked === 'string', String(clicked));
                if (typeof clicked !== 'string') return;
                const point = JSON.parse(clicked);
                await page.clickAt(point.x, point.y);
                await sleep(400);
                await recorder.shot(page, 'form');
                const hasField = await page.eval(`document.activeElement?.tagName === 'INPUT'`);
                recorder.check('an input took focus', hasField === true, `activeElement=${String(await page.eval('document.activeElement?.tagName'))}`);
                await page.insertText('Audit Two');
                await sleep(200);
                await page.key('Enter');
                await sleep(1800);
                await recorder.shot(page);
                const after = await page.eval(`document.querySelectorAll('${PAGE.workspaceRows}').length`);
                recorder.check('a second workspace row appeared', after === before + 1, `${String(before)} → ${String(after)}`);
                const workspaces = await cli.json(['workspace', 'list', '--json']);
                recorder.note(`workspaces: ${workspaces.map((workspace) => `${workspace.name}${workspace.is_active ? '*' : ''}`).join(', ')}`);
                const created = workspaces.find((workspace) => workspace.name === 'Audit Two');
                recorder.check('the daemon named it "Audit Two"', created !== undefined, workspaces.map((w) => w.name).join(', '));
                state.secondWorkspace = created?.id ?? null;
                recorder.check('the new workspace became active', created?.is_active === true, `is_active=${String(created?.is_active)}`);
                recorder.eyes('does the new row have an avatar, colour and pane count consistent with the first?');
            }
        },
        {
            id: 'workspace-create-cli',
            expect:
                '`nex workspace create` adds a workspace AND the window follows it — the new workspace becomes the one you are looking at, the way it does when you create one from the sidebar.',
            needsEyes: true,
            async run(recorder) {
                const before = await page.eval(`document.querySelectorAll('${PAGE.workspaceRows}').length`);
                const reply = await cli.json(['workspace', 'create', '--name', 'Audit CLI', '--json']);
                recorder.note(`create reply: ${JSON.stringify(reply)}`);
                await sleep(2500);
                await recorder.shot(page);
                const after = await page.eval(`document.querySelectorAll('${PAGE.workspaceRows}').length`);
                recorder.check('the new workspace appears in the sidebar', after === before + 1, `${String(before)} → ${String(after)}`);

                // Poll both sides: the question is whether they AGREE, not whether either moved.
                let daemonActive = null;
                let uiIdentity = '';
                for (let attempt = 0; attempt < 8; attempt++) {
                    const list = await cli.json(['workspace', 'list', '--json']);
                    daemonActive = list.find((workspace) => workspace.is_active)?.name ?? null;
                    uiIdentity = String(
                        await page.eval(`(document.querySelector('[data-testid="top-bar-identity"]')?.innerText ?? '').split('\\n')[0].trim()`)
                    );
                    if (daemonActive === 'Audit CLI' && uiIdentity.includes('Audit CLI')) break;
                    await sleep(600);
                }
                recorder.note(`after ~5s: daemon active=${String(daemonActive)} · window shows="${uiIdentity}"`);
                recorder.check('the daemon made the new workspace active', daemonActive === 'Audit CLI', String(daemonActive));
                recorder.check(
                    'the window is showing the workspace the daemon calls active',
                    uiIdentity.includes(String(daemonActive)),
                    `window shows "${uiIdentity}" while the daemon calls "${String(daemonActive)}" active`
                );
                // Leave the audit where the later flows expect it.
                await cli.run(['workspace', 'delete', 'Audit CLI', '--force']);
                await sleep(1500);
            }
        },
        {
            id: 'workspace-rename-context',
            expect: 'Right-clicking a workspace row opens the context menu from shell-ui.md §5.6; "Rename…" turns the row into an inline editor and the committed name shows everywhere.',
            needsEyes: true,
            async run(recorder) {
                await page.rightClick(`${PAGE.workspaceRows}`);
                await sleep(400);
                await recorder.shot(page, 'menu');
                const items = await page.eval(
                    `Array.from(document.querySelectorAll('[data-testid="context-menu"] [role="menuitem"]')).map(el => (el.textContent ?? '').trim())`
                );
                recorder.note(`menu items: ${JSON.stringify(items)}`);
                recorder.check('the context menu opened', Array.isArray(items) && items.length > 0);
                for (const expected of ['Rename…', 'Change Icon', 'Color', 'Labels', 'Delete']) {
                    recorder.check(`menu has "${expected}"`, items.some((item) => item.startsWith(expected)), items.join(' / '));
                }
                await clickMenuItem(page, 'Rename…');
                await sleep(300);
                const editing = await page.eval(`document.activeElement?.tagName === 'INPUT'`);
                recorder.check('an inline editor took focus', editing === true);
                await page.eval(`document.activeElement.select?.()`);
                await page.insertText('Renamed One');
                await sleep(150);
                await recorder.shot(page, 'editing');
                await page.key('Enter');
                await sleep(1200);
                await recorder.shot(page);
                const workspaces = await cli.json(['workspace', 'list', '--json']);
                recorder.check(
                    'the rename reached the daemon',
                    workspaces.some((workspace) => workspace.name === 'Renamed One'),
                    workspaces.map((workspace) => workspace.name).join(', ')
                );
                const inSidebar = await page.eval(
                    `Array.from(document.querySelectorAll('${PAGE.workspaceRows}')).map(el => (el.innerText ?? '').replace(/\\n/g, ' ')).join(' || ')`
                );
                recorder.note(`sidebar rows: ${inSidebar}`);
                recorder.check('the sidebar shows the new name', String(inSidebar).includes('Renamed One'));
            }
        },
        {
            id: 'workspace-switch',
            expect: 'Clicking a sidebar row activates that workspace (its panes replace the grid, the title-bar identity updates); ⌘2 activates the second workspace.',
            needsEyes: true,
            async run(recorder) {
                await page.click(`${PAGE.workspaceRows}`);
                await sleep(1200);
                await recorder.shot(page, 'click');
                // Poll rather than sample once: a one-shot read cannot tell "the daemon never
                // heard about it" from "the daemon had not answered yet".
                let activeAfterClick = null;
                for (let attempt = 0; attempt < 8; attempt++) {
                    const list = await cli.json(['workspace', 'list', '--json']);
                    activeAfterClick = list.find((workspace) => workspace.is_active) ?? null;
                    if (activeAfterClick?.name === 'Renamed One') break;
                    await sleep(600);
                }
                recorder.check(
                    'clicking a sidebar row activates that workspace daemon-side',
                    activeAfterClick?.name === 'Renamed One',
                    `after ~5s the daemon still reports active=${String(activeAfterClick?.name)}`
                );
                const identity = await page.eval(`(document.querySelector('[data-testid="top-bar-identity"]')?.innerText ?? '').replace(/\\n/g,' ')`);
                recorder.note(`title-bar identity: ${identity}`);
                recorder.check('the title bar names the active workspace', String(identity).includes('Renamed One'), identity);

                await page.key('Digit2', { modifiers: MOD.meta });
                await sleep(1200);
                await recorder.shot(page, 'cmd2');
                const afterKey = await cli.json(['workspace', 'list', '--json']);
                const activeAfterKey = afterKey.find((workspace) => workspace.is_active);
                recorder.check('⌘2 activated the second workspace', activeAfterKey?.name === 'Audit Two', `active=${String(activeAfterKey?.name)}`);
                const identity2 = await page.eval(`(document.querySelector('[data-testid="top-bar-identity"]')?.innerText ?? '').replace(/\\n/g,' ')`);
                recorder.check('the title bar followed', String(identity2).includes('Audit Two'), identity2);
                // back to the first workspace for the content-pane flows
                await page.key('Digit1', { modifiers: MOD.meta, key: '1', keyCode: 49 });
                await sleep(1000);
                recorder.eyes('is the active row visually distinct (selection fill, colour dot) from the inactive one?');
            }
        },

        // ── content panes ───────────────────────────────────────────────────────────
        {
            id: 'tidy-grid',
            expect:
                'Closing the spare panes leaves one full-width terminal, so the content panes that follow open at a size a human can actually judge.',
            async run(recorder) {
                const before = await page.eval(paneCountExpr);
                const panes = (await cli.json(['pane', 'list', '--json'])).filter((pane) => pane.is_active_workspace);
                const keep = panes.find((pane) => pane.id === state.firstPane) ?? panes[0];
                for (const pane of panes) {
                    if (pane.id === keep.id) continue;
                    await cli.run(['pane', 'close', '--target', pane.id]);
                    await sleep(500);
                }
                await sleep(1200);
                await recorder.shot(page);
                const after = await page.eval(paneCountExpr);
                state.firstPane = keep.id;
                recorder.check('the active workspace is down to one pane', after === 1, `${String(before)} → ${String(after)}`);
                const box = await page.box(`[data-testid="pane-body-${keep.id}"]`);
                recorder.note(`surviving pane body: ${JSON.stringify(box === null ? null : { w: Math.round(box.width), h: Math.round(box.height) })}`);
                recorder.check('the survivor filled the grid', (box?.width ?? 0) > 600, `${String(Math.round(box?.width ?? 0))}px wide`);
            }
        },
        {
            id: 'markdown-pane',
            expect:
                '`nex md AUDIT.md` opens a markdown pane rendering the front-matter table, headings, list, table, fenced code block, blockquote and task list — styled, not raw.',
            needsEyes: true,
            async run(recorder) {
                const file = path.join(work, 'AUDIT.md');
                const output = await cli.ok(['md', file]);
                recorder.note(`cli: ${output.trim()}`);
                await sleep(2200);
                await recorder.shot(page);
                const panes = await cli.json(['pane', 'list', '--json']);
                const md = panes.find((pane) => pane.type === 'markdown');
                state.mdPane = md?.id ?? null;
                recorder.check('a markdown pane exists', md !== undefined, panes.map((pane) => pane.type).join(', '));
                if (md === undefined) return;
                // The preview lives in a `srcdoc` iframe sandboxed to allow-scripts, so the
                // assertions have to run INSIDE it — the host page only sees an empty element.
                const rendered = await page.evalInFrame(
                    `[data-testid="content-iframe-${md.id}"]`,
                    `(() => ({ text: (document.body.innerText ?? '').slice(0, 900),
                               headings: document.querySelectorAll('h1,h2,h3').length,
                               tables: document.querySelectorAll('table').length,
                               code: document.querySelectorAll('pre').length,
                               lists: document.querySelectorAll('ul,ol').length,
                               links: document.querySelectorAll('a').length,
                               tasks: document.querySelectorAll('input[type=checkbox]').length,
                               frontMatter: document.querySelectorAll('.front-matter, table').length }))()`
                );
                recorder.note(`markdown DOM: ${JSON.stringify({ ...rendered, text: undefined })}`);
                if (rendered !== null) {
                    recorder.block('rendered markdown text', rendered.text);
                    recorder.check('headings rendered as headings', rendered.headings >= 3, `${String(rendered.headings)} h1-h3`);
                    recorder.check('the markdown table rendered as a <table>', rendered.tables >= 1, `${String(rendered.tables)} tables`);
                    recorder.check('the fenced block rendered as <pre>', rendered.code >= 1, `${String(rendered.code)} pre`);
                    recorder.check('lists rendered', rendered.lists >= 2, `${String(rendered.lists)} lists`);
                    recorder.check(
                        'front matter was extracted, not shown raw',
                        !rendered.text.includes('---\ntitle:'),
                        'no raw YAML fence in the output'
                    );
                } else {
                    recorder.check('the markdown pane body is in the DOM', false, 'no pane body element');
                }
                recorder.eyes('typography, code-block styling, table borders, front-matter presentation, copy button on hover');
            }
        },
        {
            id: 'markdown-edit-toggle',
            expect: '⌘E flips the markdown pane from preview to a monospace plain-text editor showing the raw source; ⌘E again returns to the preview.',
            needsEyes: true,
            async run(recorder) {
                if (state.mdPane === null) {
                    recorder.check('a markdown pane to toggle', false, 'previous step produced none');
                    return;
                }
                await page.click(`[data-testid="pane-header-${state.mdPane}"]`);
                await sleep(400);
                await page.key('KeyE', { modifiers: MOD.meta });
                await sleep(1200);
                await recorder.shot(page, 'edit');
                const editing = await page.eval(
                    `(() => {
                        const area = document.querySelector('[data-testid="content-textarea-${state.mdPane}"]');
                        const gutter = document.querySelector('[data-testid="content-gutter-${state.mdPane}"]');
                        const frame = document.querySelector('[data-testid="content-iframe-${state.mdPane}"]');
                        return { textareas: area === null ? 0 : 1,
                                 gutter: gutter === null ? 0 : 1,
                                 previewFrame: frame === null ? 0 : 1,
                                 font: area === null ? null : getComputedStyle(area).fontFamily,
                                 raw: (area?.value ?? '').slice(0, 200) };
                    })()`
                );
                recorder.note(`edit-mode DOM: ${JSON.stringify({ textareas: editing?.textareas, gutter: editing?.gutter, previewFrame: editing?.previewFrame, font: editing?.font })}`);
                recorder.check('an editor surface appeared', (editing?.textareas ?? 0) >= 1, `${String(editing?.textareas)} textarea`);
                recorder.check('the preview frame was replaced, not stacked', (editing?.previewFrame ?? 1) === 0, `previewFrame=${String(editing?.previewFrame)}`);
                recorder.check('the editor is monospaced', /mono/i.test(String(editing?.font ?? '')), String(editing?.font));
                recorder.check(
                    'the editor holds the raw source',
                    String(editing?.raw ?? '').includes('---') && String(editing?.raw ?? '').includes('# Markdown pane fixture'),
                    String(editing?.raw ?? '').slice(0, 80)
                );
                await page.key('KeyE', { modifiers: MOD.meta });
                await sleep(1000);
                await recorder.shot(page, 'preview');
                const back = await page.eval(
                    `document.querySelectorAll('[data-testid="content-textarea-${state.mdPane}"]').length`
                );
                recorder.check('⌘E returned to preview', back === 0, `${String(back)} textareas remain`);
                recorder.eyes('is the editor monospaced and legible, and does the header pencil/eye icon flip?');
            }
        },
        {
            id: 'diff-pane',
            expect:
                '`nex diff <repo>` opens a diff pane with per-file collapsible sections and GitHub-style green additions / red deletions for both changed files.',
            needsEyes: true,
            async run(recorder) {
                const output = await cli.ok(['diff'], { cwd: repo });
                recorder.note(`cli: ${output.trim()}`);
                await sleep(2200);
                await recorder.shot(page);
                const panes = await cli.json(['pane', 'list', '--json']);
                const diff = panes.find((pane) => pane.type === 'diff');
                state.diffPane = diff?.id ?? null;
                recorder.check('a diff pane exists', diff !== undefined, panes.map((pane) => pane.type).join(', '));
                if (diff === undefined) return;
                const rendered = await page.evalInFrame(
                    `[data-testid="content-iframe-${diff.id}"]`,
                    `(() => ({ text: (document.body.innerText ?? '').slice(0, 1200),
                               adds: document.querySelectorAll('.line-add').length,
                               dels: document.querySelectorAll('.line-del').length,
                               hunks: document.querySelectorAll('.line-hunk').length,
                               files: document.querySelectorAll('details.file, .file-header').length }))()`
                );
                if (rendered !== null) {
                    recorder.block('rendered diff text', rendered.text);
                    recorder.note(`diff DOM: adds=${String(rendered.adds)} dels=${String(rendered.dels)} hunks=${String(rendered.hunks)} files=${String(rendered.files)}`);
                    recorder.check('added lines carry the .line-add class', rendered.adds >= 2, `${String(rendered.adds)} .line-add`);
                    recorder.check('removed lines carry the .line-del class', rendered.dels >= 2, `${String(rendered.dels)} .line-del`);
                    recorder.check('per-file sections rendered', rendered.files >= 2, `${String(rendered.files)} file blocks`);
                    recorder.check('the diff mentions both changed files', rendered.text.includes('service.ts') && rendered.text.includes('README.md'), 'service.ts + README.md');
                    recorder.check('added lines are present', rendered.text.includes('+') && rendered.text.includes('reduce'), 'the new reduce() line');
                    recorder.check('removed lines are present', rendered.text.includes('Original line.') || rendered.text.includes('let sum = 0'), 'an original line shows as removed');
                } else {
                    recorder.check('the diff pane body is in the DOM', false, 'no pane body element');
                }
                recorder.eyes('add/delete colouring, hunk headers, sticky file headers, monospace alignment');
            }
        },
        {
            id: 'web-pane',
            expect:
                '`nex web open <url>` opens a web pane and the page is EMBEDDED in the window at the pane\'s rect — the fixture\'s purple header and cards visible inside the Nex frame, not in a separate window.',
            needsEyes: true,
            async run(recorder) {
                const output = await cli.ok(['web', 'open', site.url], { timeoutMs: 60_000 });
                recorder.note(`cli: ${output.trim()}`);
                await sleep(3000);
                await recorder.shot(page);
                const panes = await cli.json(['pane', 'list', '--json']);
                const web = panes.find((pane) => pane.type === 'web');
                state.webPane = web?.id ?? null;
                recorder.check('a web pane exists', web !== undefined, panes.map((pane) => pane.type).join(', '));
                if (web === undefined) return;
                const url = await cli.run(['web', 'url', '--target', String(web?.id)], { timeoutMs: 40_000 });
                recorder.note(`nex web url → ${url.stdout.trim() || url.stderr.trim()}`);
                recorder.check('the live view reports the fixture title', url.stdout.includes('Nex UI Audit Fixture'), url.stdout.trim());
                const capture = await cli.run(['web', 'capture', '--target', String(web?.id), '--mode', 'text'], { timeoutMs: 40_000 });
                recorder.block('nex web capture --mode text', `${capture.stdout}\n${capture.stderr}`.slice(0, 1500));
                recorder.check('the page text is readable through the host', capture.stdout.includes('Nex web pane fixture'), 'header text present');
                const placeholder = await page.eval(
                    `(() => {
                        const host = document.querySelector('[data-testid="pane-body-${String(web?.id)}"]');
                        if (host === null) return null;
                        const r = host.getBoundingClientRect();
                        return { text: (host.innerText ?? '').slice(0, 200), w: Math.round(r.width), h: Math.round(r.height) };
                    })()`
                );
                recorder.note(`web pane body: ${JSON.stringify(placeholder)}`);
                recorder.eyes('IS THE PAGE ACTUALLY VISIBLE inside the pane, at the right rect, under the pane header — or is the pane empty/placeholder?');
            }
        },

        // ── settings ────────────────────────────────────────────────────────────────
        {
            id: 'settings-open',
            expect: 'The gear in the sidebar footer opens a settings overlay with five tabs (Appearance, Workspaces, Keybindings, Labels, Profiles) over a dimmed backdrop.',
            needsEyes: true,
            async run(recorder) {
                await page.click(PAGE.settingsButton);
                await sleep(900);
                await recorder.shot(page);
                const shape = await page.eval(
                    `(() => ({
                        panel: document.querySelector('${PAGE.settingsPanel}') !== null,
                        backdrop: document.querySelector('[data-testid="settings-backdrop"]') !== null,
                        tabs: Array.from(document.querySelectorAll('[data-testid^="settings-tab-button-"]')).map(el => (el.textContent ?? '').trim()),
                        close: document.querySelector('[data-testid="settings-close"]') !== null
                    }))()`
                );
                recorder.check('the settings panel opened', shape.panel === true);
                recorder.check('there is a dimmed backdrop', shape.backdrop === true);
                recorder.check('all five tabs are present', (shape.tabs ?? []).length === 5, (shape.tabs ?? []).join(', '));
                recorder.check('a close affordance exists', shape.close === true);
                recorder.eyes('overlay elevation, padding, tab affordance, whether the panel is centred and readable');
            }
        },
        ...['appearance', 'workspaces', 'keybindings', 'labels', 'profiles'].map((tab) => ({
            id: `settings-tab-${tab}`,
            expect: `The ${tab} tab renders its full contents with no empty regions, clipped text or unstyled controls.`,
            needsEyes: true,
            async run(recorder) {
                await page.click(`[data-testid="settings-tab-button-${tab}"]`);
                await sleep(700);
                await recorder.shot(page);
                const body = await page.eval(
                    `(() => {
                        const panel = document.querySelector('${PAGE.settingsPanel}');
                        if (panel === null) return null;
                        return { text: (panel.innerText ?? '').slice(0, 1200),
                                 inputs: panel.querySelectorAll('input,select,button,textarea,[role="button"],[role="switch"],[role="radio"],[data-testid="appearance-swatch"]').length,
                                 height: Math.round(panel.getBoundingClientRect().height) };
                    })()`
                );
                recorder.check('the tab rendered content', body !== null && body.text.trim().length > 20, `${String(body?.text.length ?? 0)} chars`);
                recorder.check('the tab has interactive controls', (body?.inputs ?? 0) > 0, `${String(body?.inputs)} controls`);
                if (body !== null) recorder.block(`${tab} tab text`, body.text);
                recorder.eyes(`${tab} tab: alignment, control styling, empty states, truncation`);
            }
        })),
        {
            id: 'keybinding-record',
            expect:
                'On the Keybindings tab, activating a row\'s recorder captures the next chord: pressing ⌃⌥T shows the new shortcut on that row and writes a `keybind =` line to the config file.',
            needsEyes: true,
            async run(recorder) {
                await page.click('[data-testid="settings-tab-button-keybindings"]');
                await sleep(600);
                const before = fs.readFileSync(sandbox.configPath, 'utf8');
                const rowBefore = await page.eval(
                    `(document.querySelector('[data-testid="keybinding-row-split_right"]')?.innerText ?? '').replace(/\\n/g, ' | ')`
                );
                recorder.note(`split_right row before: ${String(rowBefore)}`);
                recorder.check('the split_right row exists', String(rowBefore).length > 0, String(rowBefore));
                // Scroll it into view: the tab is a long list and a click needs a real hit box.
                await page.eval(
                    `document.querySelector('[data-testid="keybinding-row-split_right"]')?.scrollIntoView({ block: 'center' })`
                );
                await sleep(300);
                await page.click('[data-testid="keybinding-record-split_right"]');
                await sleep(500);
                await recorder.shot(page, 'recording');
                const recordingLabel = await page.eval(
                    `(document.querySelector('[data-testid="keybinding-record-split_right"]')?.innerText ?? '').trim()`
                );
                recorder.note(`record button label while armed: ${String(recordingLabel)}`);
                recorder.check(
                    'the recorder entered capture mode',
                    /press a key/i.test(String(recordingLabel)),
                    String(recordingLabel)
                );
                await page.key('KeyT', { modifiers: MOD.ctrl | MOD.alt, key: 't', keyCode: 84 });
                await sleep(1500);
                await recorder.shot(page, 'recorded');
                const rowAfter = await page.eval(
                    `(document.querySelector('[data-testid="keybinding-row-split_right"]')?.innerText ?? '').replace(/\\n/g, ' | ')`
                );
                recorder.note(`split_right row after: ${String(rowAfter)}`);
                recorder.check(
                    'the row shows the newly recorded chord',
                    /⌃/.test(String(rowAfter)) && /⌥/.test(String(rowAfter)) && /T/.test(String(rowAfter)),
                    String(rowAfter)
                );
                const message = await page.eval(
                    `(document.querySelector('[data-testid="recorder-message"]')?.innerText ?? '').trim()`
                );
                if (String(message).length > 0) recorder.note(`recorder message: ${String(message)}`);
                const after = fs.readFileSync(sandbox.configPath, 'utf8');
                recorder.block('config file after recording', after || '(empty)');
                recorder.check(
                    'the new binding was persisted to the config file',
                    after !== before && /keybind\s*=/.test(after),
                    after.trim().slice(0, 200) || '(config unchanged)'
                );
                recorder.eyes('does the row read as changed (chip + enabled Reset), and is the chord rendered legibly?');
            }
        },
        {
            id: 'settings-close',
            expect: 'Escape (or the close button) dismisses the overlay and returns focus to the grid.',
            async run(recorder) {
                await page.key('Escape');
                await sleep(600);
                let open = await page.eval(`document.querySelector('${PAGE.settingsPanel}') !== null`);
                if (open === true) {
                    recorder.note('Escape did not close the overlay — falling back to the close button');
                    await page.click('[data-testid="settings-close"]');
                    await sleep(600);
                    open = await page.eval(`document.querySelector('${PAGE.settingsPanel}') !== null`);
                    recorder.check('Escape closes the settings overlay', false, 'needed the close button instead');
                } else {
                    recorder.check('Escape closes the settings overlay', true);
                }
                await recorder.shot(page);
                recorder.check('the overlay is gone', open === false);
            }
        },

        // ── agent lifecycle ─────────────────────────────────────────────────────────
        {
            id: 'agent-start',
            expect:
                '`nex event start` on a pane turns its header status dot amber, shows a "claude · <elapsed>" badge, and increments the footer\'s running count.',
            needsEyes: true,
            async run(recorder) {
                const shellPanes = (await cli.json(['pane', 'list', '--json'])).filter((pane) => pane.type === 'shell');
                const paneID = shellPanes[0]?.id;
                state.agentPane = paneID;
                recorder.check('a shell pane to attach an agent to', paneID !== undefined);
                if (paneID === undefined) return;
                // `nex event` takes its hook payload on stdin, exactly as Claude Code delivers
                // it; the session id is what makes the pane show an agent badge at all.
                const sessionID = 'audit-0000-1111-2222';
                await cli.ok(['event', 'session-start'], { paneID, stdin: JSON.stringify({ session_id: sessionID }) });
                await cli.ok(['event', 'start'], { paneID, stdin: JSON.stringify({ session_id: sessionID }) });
                await sleep(2500);
                await recorder.shot(page);
                const panes = await cli.json(['pane', 'list', '--json']);
                const pane = panes.find((item) => item.id === paneID);
                recorder.check('the daemon marks the pane running', pane?.status === 'running', `status=${String(pane?.status)}`);
                const header = await page.eval(
                    `(() => {
                        const el = document.querySelector('[data-testid="pane-header-${paneID}"]');
                        if (el === null) return null;
                        const dot = document.querySelector('[data-testid="pane-status-dot-${paneID}"]');
                        return { text: (el.innerText ?? '').replace(/\\n/g, ' | '),
                                 status: dot?.getAttribute('data-status') ?? null,
                                 dotColor: dot === null ? null : getComputedStyle(dot).backgroundColor };
                    })()`
                );
                recorder.note(`pane header: ${JSON.stringify(header)}`);
                recorder.check('the header status dot reads running', header?.status === 'running', String(header?.status));
                recorder.check('the header shows an agent badge', /claude/i.test(String(header?.text)), String(header?.text));
                const footer = await page.eval(`(document.querySelector('${PAGE.footer}')?.innerText ?? '').replace(/\\n/g,' ')`);
                recorder.note(`footer: ${footer}`);
                recorder.check('the footer counts one running agent', /1\s*running/.test(String(footer)), String(footer));
                recorder.eyes('badge colour/elapsed formatting, dot animation, whether the tray/dock reflect it');
            }
        },
        {
            id: 'agent-notification',
            expect:
                '`nex event notification` raises a desktop notification and flips the pane to "awaiting input": blue dot, "awaiting input" badge, footer waiting count = 1.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.agentPane;
                if (paneID === undefined) {
                    recorder.check('a pane with an agent', false);
                    return;
                }
                const result = await cli.run(['event', 'notification', '--title', 'Audit', '--body', 'Approval requested: Bash'], {
                    paneID,
                    stdin: JSON.stringify({ session_id: 'audit-0000-1111-2222' })
                });
                recorder.note(`cli exit ${String(result.code)} ${result.stdout.trim()}${result.stderr.trim()}`);
                await sleep(2000);
                await recorder.shot(page);
                const panes = await cli.json(['pane', 'list', '--json']);
                const pane = panes.find((item) => item.id === paneID);
                recorder.check('the daemon marks the pane waiting', pane?.status === 'waitingForInput', `status=${String(pane?.status)}`);
                const header = await page.eval(
                    `(() => {
                        const el = document.querySelector('[data-testid="pane-header-${paneID}"]');
                        const dot = document.querySelector('[data-testid="pane-status-dot-${paneID}"]');
                        return el === null ? null : { text: (el.innerText ?? '').replace(/\\n/g,' | '), status: dot?.getAttribute('data-status') ?? null };
                    })()`
                );
                recorder.note(`pane header: ${JSON.stringify(header)}`);
                recorder.check('the header shows awaiting input', /awaiting input/i.test(String(header?.text)), String(header?.text));
                const footer = await page.eval(`(document.querySelector('${PAGE.footer}')?.innerText ?? '').replace(/\\n/g,' ')`);
                recorder.note(`footer: ${footer}`);
                recorder.check('the footer counts one waiting agent', /1\s*waiting/.test(String(footer)), String(footer));
                const toast = await page.eval(`(document.querySelector('[data-testid="toast-stack"]')?.innerText ?? '').replace(/\\n/g,' ')`);
                recorder.note(`toast stack: ${String(toast) || '(empty)'}`);
                recorder.eyes('is there any in-app surfacing of the notification, and does the tray icon change?');
            }
        },
        {
            id: 'agent-stop',
            expect: '`nex event stop` clears the running state; the badge and the footer running count go back down.',
            async run(recorder) {
                const paneID = state.agentPane;
                if (paneID === undefined) {
                    recorder.check('a pane with an agent', false);
                    return;
                }
                // Put the pane back in `running` first: stopping an already-waiting pane proves
                // nothing about the transition this step is meant to check.
                await cli.ok(['event', 'start'], { paneID, stdin: JSON.stringify({ session_id: 'audit-0000-1111-2222' }) });
                await sleep(1200);
                const midway = (await cli.json(['pane', 'list', '--json'])).find((item) => item.id === paneID);
                recorder.check('the pane is running again before the stop', midway?.status === 'running', `status=${String(midway?.status)}`);
                await cli.ok(['event', 'stop'], { paneID, stdin: JSON.stringify({ session_id: 'audit-0000-1111-2222', background_tasks: [] }) });
                await sleep(1800);
                await recorder.shot(page);
                const panes = await cli.json(['pane', 'list', '--json']);
                const pane = panes.find((item) => item.id === paneID);
                recorder.check('a stop flips running → awaiting input', pane?.status === 'waitingForInput', `status=${String(pane?.status)}`);
                const footer = await page.eval(`(document.querySelector('${PAGE.footer}')?.innerText ?? '').replace(/\\n/g,' ')`);
                recorder.note(`footer: ${footer}`);
                recorder.check('the footer shows zero running', /0\s*running/.test(String(footer)), String(footer));
            }
        },

        // ── the real parity assertion ───────────────────────────────────────────────
        {
            id: 'capture-parity',
            expect:
                'What the CLI says is on the screen and what is on the screen are the same thing: a nonce typed through the canvas appears verbatim in `nex pane capture`, in the same row order, and the screenshot shows it.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.firstPane;
                await focusPaneBody(page, paneID);
                await runInTerminal(page, 'clear', { settleMs: 500 });
                const nonce = `PARITY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
                for (let row = 1; row <= 5; row++) {
                    await runInTerminal(page, `printf 'row%02d %s col=%s\\n' ${String(row)} ${nonce} $(tput cols)`, { settleMs: 350 });
                }
                await sleep(900);
                await recorder.shot(page);
                const capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                recorder.block('nex pane capture (compare against the screenshot above, row by row)', capture);
                recorder.artifact('capture.txt', capture);
                const rows = capture.split('\n').filter((line) => line.includes(nonce) && /^row\d\d /.test(line.trim()));
                recorder.check('the capture contains the nonce', capture.includes(nonce), nonce);
                recorder.check('all five output rows are present, in order', rows.length === 5, `${String(rows.length)} rows: ${rows.map((row) => row.trim().slice(0, 12)).join(', ')}`);
                const ordered = rows.every((row, index) => row.trim().startsWith(`row0${String(index + 1)}`));
                recorder.check('the rows are in emission order', ordered, rows.map((row) => row.trim().slice(0, 5)).join(' '));
                const scrollback = await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
                recorder.check('--scrollback returns at least as much', scrollback.length >= capture.length, `${String(scrollback.length)} vs ${String(capture.length)} bytes`);
                recorder.eyes('PARITY: read the five rows off the screenshot and compare them character-for-character with the capture block.');
            }
        },

        // ── the daemon-survives story ───────────────────────────────────────────────
        {
            id: 'reattach-after-relaunch',
            expect:
                'Quitting the shell leaves the daemon (and every PTY) alive; a fresh shell reattaches to the SAME workspaces and panes — same count, same ids, terminal scrollback intact, nothing duplicated.',
            needsEyes: true,
            async run(recorder) {
                const beforePanes = await cli.json(['pane', 'list', '--json']);
                const beforeWorkspaces = await cli.json(['workspace', 'list', '--json']);
                recorder.note(`before: ${String(beforePanes.length)} panes, ${String(beforeWorkspaces.length)} workspaces`);
                const marker = `REATTACH-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
                await focusPaneBody(page, state.firstPane);
                await runInTerminal(page, `printf '%s\\n' ${marker}`, { settleMs: 700 });

                page.close();
                await runtime.shell.quit();
                await sleep(1500);

                const stillUp = await fetch(`${sandbox.base}/healthz`).then((response) => response.ok).catch(() => false);
                recorder.check('the daemon survived the shell quitting', stillUp === true);
                const survivedPanes = await cli.json(['pane', 'list', '--json']);
                recorder.check('the panes survived too', survivedPanes.length === beforePanes.length, `${String(survivedPanes.length)} vs ${String(beforePanes.length)}`);

                const relaunched = startShell(sandbox, {
                    repoRoot,
                    packaged: runOptions.packaged,
                    verbose: runOptions.verbose,
                    extraEnv: { NEX_AUDIT: '1' }
                });
                runtime.shell = relaunched;
                const target = await waitForPageTarget(sandbox.debugPort, { timeoutMs: 90_000 });
                const nextPage = await connect(target.webSocketDebuggerUrl, { repoRoot });
                runtime.page = nextPage;
                await nextPage.send('Page.enable');
                await nextPage.send('Runtime.enable');
                await nextPage.send('DOM.enable');
                await nextPage.watchFrames();
                await nextPage.waitFor(`document.querySelector('${PAGE.app}') !== null`, { timeoutMs: 60_000, label: 'the relaunched app' });
                await sleep(4000);
                await recorder.shot(nextPage);

                const afterPanes = await cli.json(['pane', 'list', '--json']);
                const afterWorkspaces = await cli.json(['workspace', 'list', '--json']);
                recorder.note(`after: ${String(afterPanes.length)} panes, ${String(afterWorkspaces.length)} workspaces`);
                recorder.check('pane count is unchanged after relaunch', afterPanes.length === beforePanes.length, `${String(beforePanes.length)} → ${String(afterPanes.length)}`);
                recorder.check('workspace count is unchanged after relaunch', afterWorkspaces.length === beforeWorkspaces.length, `${String(beforeWorkspaces.length)} → ${String(afterWorkspaces.length)}`);
                const sameIDs = afterPanes.map((pane) => pane.id).sort().join(',') === beforePanes.map((pane) => pane.id).sort().join(',');
                recorder.check('the pane IDS are the same (no re-creation)', sameIDs, sameIDs ? 'identical' : 'ids changed');

                const domPanes = await nextPage.eval(paneCountExpr);
                const activeWorkspacePanes = afterPanes.filter((pane) => pane.is_active_workspace).length;
                recorder.check(
                    'the DOM shows exactly the active workspace\'s panes (no duplicates)',
                    domPanes === activeWorkspacePanes,
                    `dom=${String(domPanes)} daemon(active ws)=${String(activeWorkspacePanes)}`
                );
                const domRows = await nextPage.eval(`document.querySelectorAll('${PAGE.workspaceRows}').length`);
                recorder.check(
                    'the sidebar shows each workspace once',
                    domRows === afterWorkspaces.length,
                    `rows=${String(domRows)} workspaces=${String(afterWorkspaces.length)}`
                );
                const dupIDs = await nextPage.eval(
                    `(() => { const ids = Array.from(document.querySelectorAll('[data-testid^="pane-header-"]')).map(el => el.getAttribute('data-testid').slice(12));
                              const seen = new Set(); const dupes = new Set();
                              for (const id of ids) { if (seen.has(id)) dupes.add(id); seen.add(id); }
                              return Array.from(dupes); })()`
                );
                recorder.check('no pane id appears twice in the DOM', (dupIDs ?? []).length === 0, JSON.stringify(dupIDs));

                const capture = await cli.ok(['pane', 'capture', '--target', state.firstPane, '--scrollback']);
                recorder.block('scrollback after relaunch', capture.slice(-2000));
                const occurrences = (capture.match(new RegExp(marker, 'g')) ?? []).length;
                recorder.check('the pre-quit scrollback survived', occurrences >= 1, `${String(occurrences)} occurrences of ${marker}`);
                recorder.check(
                    'the scrollback was not duplicated on reattach',
                    occurrences <= 2,
                    `${String(occurrences)} occurrences (1 echo + 1 output is normal; more means replay duplication)`
                );
                recorder.eyes('DUPLICATION CHECK — does the reattached terminal show the same lines twice? Compare against the pre-quit screenshots.');
            }
        }
    ];
}

main().catch((error) => {
    process.stderr.write(`\nAUDIT HARNESS FAILED: ${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
});

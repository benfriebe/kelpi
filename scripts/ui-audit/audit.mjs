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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOD, connect, listTargets, sleep, waitForPageTarget } from './lib/cdp.mjs';
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
    // A deterministic stand-in for the user's $EDITOR (CONT-081…091). It prints a marker so the
    // screenshot proves WHICH process is hosted, then blocks on stdin so the pane stays in
    // editor mode until the step ends it — ctrl-D (a real keystroke into the PTY) makes it exit
    // on its own, which is the CONT-091 path. Nothing here depends on vim being installed or on
    // how fast it paints.
    const editorScript = path.join(work, 'audit-editor.sh');
    fs.writeFileSync(
        editorScript,
        '#!/bin/sh\nprintf "NEX-AUDIT-EDITOR %s\\n" "$1"\ncat > /dev/null\n'
    );
    fs.chmodSync(editorScript, 0o755);
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
        response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            // The cookie panel needs a real cookie to list, and a page that sets one through a
            // response header is the honest way to get it into the pane's partition.
            'set-cookie': 'nexaudit=fixture-cookie; Path=/; Max-Age=3600'
        });
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

/**
 * Open the Settings overlay on a given tab, whatever state it is in.
 *
 * Clicking the sidebar gear while the overlay is ALREADY open lands on the modal backdrop and
 * closes it — which is correct behaviour and a trap for any step that assumes the gear is a
 * plain "open". Steps that need a particular tab call this instead of re-deriving the dance.
 */
async function openSettingsTab(page, tab) {
    const open = await page.eval(`document.querySelector('${PAGE.settingsPanel}') !== null`);
    if (open !== true) {
        await page.click(PAGE.settingsButton);
        await sleep(700);
    }
    await page.click(`[data-testid="settings-tab-button-${tab}"]`);
    await sleep(600);
}

async function domPaneIDs(page) {
    return (await page.eval(paneIDsExpr)) ?? [];
}

/**
 * The WIDEST shell pane currently on screen, or null when there is none.
 *
 * Three later steps need "a terminal a person would use", and each of them broke on a different
 * wrong answer to that question when the grid still holds the content panes earlier steps left:
 *
 *   - `pane-context-menu` took the DOM's first header and got a MARKDOWN pane, so the shell-only
 *     Status submenu was (correctly) absent and every step downstream of `state.firstPane` —
 *     ⌘F, ⇧⌘T, ⇧⌘N, `pane capture`, the OSC 7 `cd` — was pointed at a preview iframe;
 *   - `cmd-click-path` took the first shell and got a 260 px one, where the absolute path it
 *     prints soft-wraps and the cell under the click holds a fragment, not the token;
 *   - `repo-autodetect` took `state.firstPane`, which by then could belong to a workspace the
 *     inspector was not showing, so the row it waited for was never going to appear.
 *
 * On-screen (i.e. in the active workspace's grid) answers the third, `type === 'shell'` the
 * first, and widest the second. It is a harness-targeting rule, not a product rule: narrow-pane
 * behaviour is a separate question, recorded in docs/PARITY.md's ledger as N3.
 */
async function widestShellPane(page, cli) {
    const domIDs = new Set(await domPaneIDs(page));
    const shells = (await cli.json(['pane', 'list', '--json'])).filter(
        (pane) => pane.type === 'shell' && domIDs.has(pane.id)
    );
    let best = null;
    for (const pane of shells) {
        const box = await page.box(`[data-testid="pane-body-${pane.id}"]`);
        const width = box?.width ?? 0;
        if (best === null || width > best.width) best = { id: pane.id, width };
    }
    return best;
}

/**
 * How much ink a pane's canvas is actually painting.
 *
 * "Ink" is every pixel that is not the most-common colour on the canvas — which, on a terminal,
 * is always the background. It is the only mechanical read there is on what a pane SHOWS: the
 * grid is a canvas, so there is no text to query, and every cross-pane bleed found so far (a
 * pane wearing its predecessor's screen after a remount) was caught by a person opening a PNG.
 * Counting ink turns that into a number the daemon's own answer can be compared against.
 */
async function paneInkPixels(page, paneID) {
    return await page.eval(
        `(() => {
            const canvas = document.querySelector('[data-pane-id="${paneID}"] canvas');
            if (canvas === null) return null;
            const ctx = canvas.getContext('2d');
            if (ctx === null) return null;
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            const counts = new Map();
            for (let i = 0; i < data.length; i += 4) {
                const key = data[i] + ',' + data[i + 1] + ',' + data[i + 2];
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            let background = null;
            let most = -1;
            for (const [key, count] of counts) {
                if (count > most) { most = count; background = key; }
            }
            const total = data.length / 4;
            return { ink: total - most, total, background };
        })()`
    );
}

/**
 * A pane may not paint much more than its own content could account for.
 *
 * A deliberately generous UPPER bound, not a match: the defect it exists for is a pane painting
 * a screenful of another pane's output while its own VT holds a bare prompt — what a remount
 * did while `renderer.ts`'s `reset()` swallowed the RIS because the engine was still loading,
 * so the replay landed on the WASM grid the previous pane had left behind.
 *
 * The unit is a **cell the capture says is in use** (every column up to the last non-space one,
 * per line), not a glyph: a powerline prompt colours whole cells, blanks included, so counting
 * only visible characters would charge a pane for ink its own content legitimately paints. The
 * per-cell budget is then the cost of a FULLY inked cell — at a 2× device pixel ratio an 8×17
 * CSS-pixel cell is 544 device pixels — so no honest screen can exceed it.
 *
 * Measured both ways on the workspace-switch step: 756 ink pixels for a 7-cell prompt when the
 * pane paints its own screen, 21 675 for the same 7 cells when it came back wearing its
 * neighbour's grid, against a 10 900 budget.
 */
const INK_FLOOR_PIXELS = 6_000;
const INK_PER_CELL_PIXELS = 700;

/** Cells the daemon's capture says are in use — the denominator for the ink budget. */
function capturedCells(capture) {
    return String(capture)
        .split('\n')
        .reduce((total, line) => total + line.replace(/\s+$/, '').length, 0);
}

/**
 * Panes whose renderer never came up — `TerminalPane`'s `status === 'error'`, which paints
 * "terminal renderer failed to start" across the pane.
 *
 * Worth its own read because nothing else sees it: the daemon is happy, the pane is in the DOM
 * at the right size, `nex pane capture` answers from the server-side VT — and the person looking
 * at the window has a sentence where their shell should be. Checked wherever a pane is REVEALED
 * (a create, a workspace switch), which is where an engine is built in a hurry.
 */
async function panesFailedToRender(page) {
    return (
        (await page.eval(
            `Array.from(document.querySelectorAll('[data-terminal-status="error"]')).map(el => el.getAttribute('data-pane-id'))`
        )) ?? []
    );
}

/**
 * How many engines each pane had to build before it came up (`data-terminal-attempts`).
 *
 * The flake N1 catalogues is upstream and still fires — ghostty-web 0.4 throws
 * `RangeError: offset is out of bounds` out of `write()` on a freshly created terminal — but a
 * pane now rebuilds on a fresh engine instead of stranding. This read is what keeps that
 * visible: `> 1` is a pane that RECOVERED, which is a note in the report, not a failure.
 */
async function paneStartAttempts(page) {
    return (
        (await page.eval(
            `Array.from(document.querySelectorAll('[data-terminal-attempts]')).map((el) => ({
                id: el.getAttribute('data-pane-id'),
                attempts: Number(el.getAttribute('data-terminal-attempts') || '0')
            }))`
        )) ?? []
    );
}

/** Focus a pane by clicking its body — a real click, so focus follows the real code path. */
/**
 * A CDP session on the EMBEDDED page (the shell's `WebContentsView`), not on Nex's renderer.
 *
 * Two things need it. The picks in the pickup flow have to be real clicks on real elements. And
 * the browser-shortcut chords have to be pressed *where a user presses them* — inside a page
 * that has keyboard focus — because that is the only path that exercises the host's
 * `before-input-event` forwarding (`shell/webhost/keys.ts`). Dispatching them at Nex's renderer
 * instead would test a state a user cannot be in: with a native view focused, Chromium routes
 * keyboard input to that view and the renderer never sees it.
 */
async function webViewSession(sandbox, site, repoRoot) {
    const targets = await listTargets(sandbox.debugPort);
    const target = targets.find(
        (entry) => entry.type === 'page' && typeof entry.url === 'string' && entry.url.startsWith(site.url)
    );
    if (target === undefined) return null;
    return connect(target.webSocketDebuggerUrl, { repoRoot });
}

/**
 * Focus a WEB pane the way a person does: click its chrome.
 *
 * `pane-body-…` is not clickable for a web pane — the shell's native `WebContentsView` covers
 * that rect exactly, so a synthetic click there lands in the page, not in this document, and the
 * pane never takes focus. The chrome row above the page IS ours, so the click goes there (offset
 * past the back/forward/reload buttons so it hits the row's background rather than a control).
 */
async function focusWebPane(page, paneID) {
    const box = await page.box(`[data-testid="web-pane-${paneID}"]`);
    if (box === null) throw new Error(`no web pane ${paneID}`);
    // 8 px down is inside the chrome row; 4 px in from the right edge is past the last button
    // only when the row is wide, so aim just left of the URL field's right edge instead.
    await page.clickAt(box.x + box.width / 2, box.y + 4);
    await sleep(250);
    return box;
}

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

/**
 * The trigger the LIVE binding map holds for an action, read out of the Help overlay.
 *
 * Earlier steps rebind keys through Settings (run-H had `split_right` on ⌃⌥T by the time the
 * file-open steps ran), so a step that presses a hard-coded ⌘O is testing the wrong thing when
 * it fails. The overlay is built from the same `KeyBindingMap` the dispatcher resolves, so
 * reading it is reading the map — and the ••• menu opens it with a CLICK, which no rebinding
 * can take away.
 */
const GLYPH_MODIFIERS = { '⌘': MOD.meta, '⇧': MOD.shift, '⌥': MOD.alt, '⌃': MOD.ctrl };
const GLYPH_KEYS = {
    Return: 'Enter',
    Space: 'Space',
    Tab: 'Tab',
    Escape: 'Escape',
    '←': 'ArrowLeft',
    '→': 'ArrowRight',
    '↑': 'ArrowUp',
    '↓': 'ArrowDown'
};

/** `⇧⌘K` → `{ code: 'KeyK', modifiers }`; null when nothing is bound or it cannot be typed. */
export function parseShortcutGlyphs(display) {
    if (typeof display !== 'string' || display === '') return null;
    let modifiers = 0;
    let rest = display;
    while (rest.length > 0 && GLYPH_MODIFIERS[rest[0]] !== undefined) {
        modifiers |= GLYPH_MODIFIERS[rest[0]];
        rest = rest.slice(1);
    }
    if (rest === '') return null;
    if (GLYPH_KEYS[rest] !== undefined) return { code: GLYPH_KEYS[rest], modifiers };
    if (rest.length === 1 && /[A-Z]/.test(rest)) return { code: `Key${rest}`, modifiers };
    if (rest.length === 1 && /[0-9]/.test(rest)) return { code: `Digit${rest}`, modifiers };
    return null;
}

/** Open Help through the ••• menu, read one action's trigger, close it again. */
async function liveShortcut(page, action) {
    await page.click('[data-testid="titlebar-menu-toggle"]');
    await sleep(300);
    await clickMenuItem(page, 'Nex Help');
    await sleep(600);
    const display = await page.eval(
        `document.querySelector('[data-help-action="${action}"] [data-help-shortcut]')?.getAttribute('data-help-shortcut') ?? ''`
    );
    await page.click('[data-testid="help-close"]');
    await sleep(300);
    return { display, key: parseShortcutGlyphs(display) };
}

/** Press whatever the live map has bound to `action`. Returns what it pressed. */
async function pressBoundAction(page, action) {
    const bound = await liveShortcut(page, action);
    if (bound.key === null) return bound;
    await page.key(bound.key.code, { modifiers: bound.key.modifiers });
    return bound;
}

/** Click a context-menu row by its visible label. */
async function clickMenuItem(page, label) {
    const clicked = await page.eval(
        `(() => {
            const menu = document.querySelector('[data-testid="context-menu"]');
            if (menu === null) return 'no-menu';
            // A CHECKED row's text starts with the checkmark glyph, so a bare startsWith could
            // never find the item that is currently selected — which is exactly the row a
            // "put it back" step has to click.
            const text = (el) => (el.textContent ?? '').trim().replace(/^[✓✔]\\s*/, '');
            const rows = Array.from(menu.querySelectorAll('[role="menuitem"]'));
            const row = rows.find(el => text(el).startsWith(${JSON.stringify(label)}));
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
        // CONT-082/083's resolution order ends at the process environment when the sandbox HOME
        // has no rc files, so this is what the daemon's `$EDITOR` probe finds.
        sandbox.env.EDITOR = path.join(work, 'audit-editor.sh');
        runtime.daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
        await waitForHealthz(sandbox.base);

        runtime.shell = startShell(sandbox, {
            repoRoot,
            packaged: options.packaged,
            verbose: options.verbose,
            extraEnv: {
                NEX_AUDIT: '1',
                // The ⌘O step's scripted answer to the native open panel — an OS window CDP
                // cannot click. See `shell/src/main.ts` `promptOpenFile`.
                NEX_AUDIT_OPEN_FILE: path.join(sandbox.root, 'open-file-answer.txt')
            }
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

/**
 * `rgb(…)` / `rgba(…)` → components, so a step can ask two questions about a computed colour:
 * is it OPAQUE, and which side of the light/dark line is it on. Both matter for content panes —
 * run-B's blocker L1 was a document painting dark ink over a canvas that was still white.
 */
function parseCssColor(value) {
    const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i.exec(String(value ?? ''));
    if (match === null) return null;
    return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4])
    };
}

/** content-panes.md §3.1's rule, so the audit judges a canvas the way the renderer does. */
function perceivedLuminance(color) {
    return (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
}

/**
 * The one assertion run-B's blocker L1 needed and nobody could make: what colour is the
 * document's CANVAS, measured from inside the sandboxed frame?
 *
 * The daemon emits the document transparent (content-panes.md §3.8, a WKWebView contract) and
 * the client shows it in an `allow-scripts` iframe — an opaque origin, isolated into its own
 * process, compositing over Chromium's WHITE base. Every structural assertion passed while the
 * pane was dark ink on white. So: the canvas must be OPAQUE, and it must be on the same side of
 * the luminance line as the `dark`/`light` class the daemon chose for the ink.
 */
function checkFrameCanvas(recorder, rendered, label) {
    const canvas = parseCssColor(rendered.canvas);
    recorder.note(`${label} canvas: ${String(rendered.canvas)} · color-scheme ${String(rendered.colorScheme)} · html.${rendered.darkDoc === true ? 'dark' : 'light'}`);
    recorder.check(
        `the ${label} document paints an opaque canvas (not Chromium's white base)`,
        canvas !== null && canvas.a === 1,
        String(rendered.canvas)
    );
    if (canvas === null) return;
    const luminance = perceivedLuminance(canvas);
    recorder.check(
        `the ${label} canvas matches the theme its ink was chosen for`,
        rendered.darkDoc === true ? luminance < 0.5 : luminance >= 0.5,
        `luminance ${luminance.toFixed(3)} for html.${rendered.darkDoc === true ? 'dark' : 'light'}`
    );
}

function buildFlows(ctx) {
    const { page, cli, sandbox, work, repo, site, runtime, repoRoot, options: runOptions } = ctx;
    /** Mutable across flows: the panes the audit created, so later steps can address them. */
    const state = { firstPane: null, mdPane: null, diffPane: null, webPane: null, secondWorkspace: null, openedByDialog: null };


    /**
     * Graft / repo-registry helpers. They exist so the four flows below can each run alone
     * under `--only`: every one of them provisions the worktree, the association and the
     * inspector it needs instead of inheriting them from whichever step ran before.
     */
    const gitEnv = {
        PATH: sandbox.env.PATH,
        HOME: sandbox.home,
        GIT_AUTHOR_NAME: 'Audit',
        GIT_AUTHOR_EMAIL: 'audit@example.invalid',
        GIT_COMMITTER_NAME: 'Audit',
        GIT_COMMITTER_EMAIL: 'audit@example.invalid'
    };
    const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
    const breadcrumbPath = () => path.join(repo, '.git', 'nex-graft-active');

    /** A linked worktree carrying one file the parent does not have, so a graft is VISIBLE. */
    function graftWorktree() {
        const wt = path.join(sandbox.root, 'graft-wt');
        if (fs.existsSync(wt)) return wt;
        git(['worktree', 'add', '-q', '-b', 'graft-branch', wt]);
        fs.writeFileSync(path.join(wt, 'GRAFT-MARKER.md'), 'mirrored by graft\n');
        git(['add', '.'], wt);
        git(['commit', '-q', '-m', 'graft marker'], wt);
        return wt;
    }

    /** A second, unrelated repository for the auto-detect and registry flows. */
    function autoDetectRepo() {
        const dir = path.join(sandbox.root, 'autodetect-repo');
        if (fs.existsSync(dir)) return dir;
        fs.mkdirSync(dir, { recursive: true });
        git(['init', '-q', '-b', 'main'], dir);
        fs.writeFileSync(path.join(dir, 'file.txt'), 'auto\n');
        git(['add', '.'], dir);
        git(['commit', '-q', '-m', 'initial'], dir);
        return dir;
    }

    /** `makeRepo`'s dirty working tree, restored after a flow that checks the parent out. */
    function redirtyRepo() {
        fs.writeFileSync(
            path.join(repo, 'service.ts'),
            ['export function total(values: readonly number[]): number {', '    // an added comment line', '    return values.reduce((sum, value) => sum + value, 0);', '}', ''].join('\n')
        );
        fs.writeFileSync(path.join(repo, 'README.md'), '# Audit repo\n\nEdited line.\nA brand new line.\n');
    }

    async function ensureInspector() {
        const open = await page.eval(`document.querySelector('[data-testid="inspector"]') !== null`);
        if (open === true) return;
        await page.click('[data-testid="toggle-inspector"]');
        await page.waitFor(`document.querySelector('[data-testid="inspector"]') !== null`, {
            timeoutMs: 10_000,
            label: 'the inspector'
        });
        await sleep(600);
    }

    /** Every association row on screen, with whether it carries a graft toggle. */
    async function inspectorRows() {
        const raw = await page.eval(
            `Array.from(document.querySelectorAll('[data-testid^="inspector-assoc-"]'))
                .filter(el => !el.getAttribute('data-testid').startsWith('inspector-assoc-menu'))
                .map(el => JSON.stringify({
                    id: el.getAttribute('data-testid').slice('inspector-assoc-'.length),
                    worktree: el.getAttribute('data-worktree'),
                    path: el.getAttribute('title') ?? '',
                    text: (el.innerText ?? '').replace(/\\n/g, ' | '),
                    hasGraft: el.querySelector('[data-testid^="graft-toggle-"]') !== null
                }))`
        );
        return (raw ?? []).map((entry) => JSON.parse(entry));
    }

    /** A second linked worktree, for the one-graft-per-parent contest (§GIT-038…§GIT-042). */
    function rivalWorktree() {
        const wt = path.join(sandbox.root, 'graft-wt-2');
        if (fs.existsSync(wt)) return wt;
        git(['worktree', 'add', '-q', '-b', 'rival-branch', wt]);
        fs.writeFileSync(path.join(wt, 'RIVAL-MARKER.md'), 'mirrored by the rival\n');
        git(['add', '.'], wt);
        git(['commit', '-q', '-m', 'rival marker'], wt);
        return wt;
    }

    /** The worktree's association id, adding it through the inspector's own sheet if needed. */
    async function ensureAssociation(recorder, worktreePath) {
        const name = path.basename(worktreePath);
        const matches = (row) => row.worktree === 'true' && row.path.endsWith(`/${name}`);
        const existing = (await inspectorRows()).find(matches);
        if (existing !== undefined) return existing.id;
        await page.click('[data-testid="inspector-add-repo"]');
        await sleep(300);
        await page.click('[data-menu-item="add-repo"]');
        await sleep(300);
        await page.click('[data-testid="add-repo-path"]');
        await page.insertText(worktreePath);
        await page.click('[data-testid="add-repo-submit"]');
        try {
            await page.waitFor(
                `Array.from(document.querySelectorAll('[data-testid^="inspector-assoc-"]')).some(el => el.getAttribute('data-worktree') === 'true' && (el.getAttribute('title') ?? '').endsWith('/${name}'))`,
                { timeoutMs: 20_000, label: `the ${name} association row` }
            );
        } catch (error) {
            recorder.check('the worktree could be associated', false, String(error?.message ?? error));
            return null;
        }
        await sleep(500);
        const row = (await inspectorRows()).find(matches);
        return row?.id ?? null;
    }

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

                /**
                 * Every pane-header button says what it does (run-B m1). The audit found an
                 * I-beam glyph sitting in the header with nothing in §4.2's list to explain it;
                 * an icon-only control that carries no accessible name is unreadable to a
                 * screen reader AND to a person hovering it, so the name is the thing to
                 * assert — the glyph is an eyes call, the label is not.
                 */
                const headerButtons = await page.eval(
                    `Array.from(document.querySelectorAll('[data-testid^="pane-header-"] button')).map(el => ({
                        testid: el.getAttribute('data-testid'),
                        label: (el.getAttribute('aria-label') ?? '').trim(),
                        tooltip: (el.getAttribute('title') ?? '').trim()
                    }))`
                );
                recorder.note(`pane header buttons: ${JSON.stringify(headerButtons)}`);
                const unlabelled = (headerButtons ?? []).filter(
                    (button) => button.label.length === 0 || button.tooltip.length === 0
                );
                recorder.check(
                    'every pane-header button carries a label and a tooltip',
                    (headerButtons ?? []).length > 0 && unlabelled.length === 0,
                    unlabelled.length === 0
                        ? `${String((headerButtons ?? []).length)} buttons, all named`
                        : `unlabelled: ${unlabelled.map((button) => button.testid).join(', ')}`
                );
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

                /**
                 * The pixels the ordinary foreground is actually painted with (run-B L4).
                 *
                 * "The terminal text looks dim" is exactly the kind of finding that only eyes
                 * could reach — until the canvas is sampled. ghostty-web paints into a 2D
                 * context, so `getImageData` returns the truth: the brightest pixel over the
                 * printed rows IS the default foreground the VT resolved (glyph strokes at
                 * 13px hit full coverage somewhere). Comparing it against the theme's declared
                 * `--nex-term-fg` turns "reads like SGR dim" into a number.
                 */
                const paint = await page.eval(
                    `(() => {
                        const canvas = document.querySelector('[data-pane-id="${paneID}"] canvas') ?? document.querySelector('[data-terminal-host] canvas');
                        if (canvas === null) return { error: 'no canvas' };
                        const ctx = canvas.getContext('2d');
                        if (ctx === null) return { error: 'no 2d context' };
                        const height = Math.min(canvas.height, Math.round(canvas.height * 0.5));
                        const data = ctx.getImageData(0, 0, canvas.width, height).data;
                        const counts = new Map();
                        let brightest = { lum: -1, rgb: null };
                        for (let i = 0; i < data.length; i += 4) {
                            const r = data[i], g = data[i + 1], b = data[i + 2];
                            const key = r + ',' + g + ',' + b;
                            counts.set(key, (counts.get(key) ?? 0) + 1);
                            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                            if (lum > brightest.lum) brightest = { lum, rgb: key };
                        }
                        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
                        const root = getComputedStyle(document.documentElement);
                        return {
                            brightest,
                            top,
                            dpr: window.devicePixelRatio,
                            canvas: { w: canvas.width, h: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight },
                            themeFg: root.getPropertyValue('--nex-term-fg').trim(),
                            themeBg: root.getPropertyValue('--nex-term-bg').trim()
                        };
                    })()`
                );
                recorder.note(`canvas paint: ${JSON.stringify(paint)}`);
                if (paint?.error === undefined) {
                    /**
                     * The INK, not the brightest pixel. The most-painted colour is the
                     * background; the next one is the default foreground — thousands of pixels
                     * of ordinary text, against a few hundred for any single SGR colour.
                     * Measuring the brightest pixel instead would be satisfied by one white
                     * emoji while every line of text was painted `#2B2B2E`, which is exactly
                     * the state run-B was in.
                     */
                    const background = String(paint.top?.[0]?.[0] ?? '10,10,12');
                    const ink = String((paint.top ?? []).find((entry) => entry[0] !== background)?.[0] ?? background);
                    const rgb = ink.split(',').map(Number);
                    const [r, g, b] = rgb.length === 3 ? rgb : [0, 0, 0];
                    const channel = (value) => {
                        const srgb = value / 255;
                        return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
                    };
                    const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
                    // Contrast against the pane background, which is the darkest thing painted.
                    const bg = 0.2126 * channel(10) + 0.7152 * channel(10) + 0.0722 * channel(11);
                    const contrast = (Math.max(luminance, bg) + 0.05) / (Math.min(luminance, bg) + 0.05);
                    recorder.note(`terminal ink rgb(${String(r)}, ${String(g)}, ${String(b)}) · contrast vs pane bg ≈ ${contrast.toFixed(1)}:1`);
                    recorder.check(
                        'ordinary terminal text is painted at full strength (not SGR-dim)',
                        contrast >= 7,
                        `the most-painted ink is rgb(${String(r)}, ${String(g)}, ${String(b)}), ${contrast.toFixed(1)}:1 against the pane background; the theme asks for ${String(paint.themeFg)}`
                    );
                }
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

                /**
                 * Middle truncation, measured (run-B m9). A split is where it starts to matter:
                 * two half-width headers cannot show a `/var/folders/…` path whole, and
                 * `text-overflow: ellipsis` on its own throws away the tail — the only part
                 * that says WHICH directory. §4.2 item 3 asks for the middle to go instead,
                 * which the header does by ellipsizing a head span and pinning the last path
                 * segment beside it.
                 *
                 * So the check is geometric, not textual: of the titles that are too long for
                 * their header, every one must still paint its tail segment inside the title
                 * box. `title.right + 1` is the box; a tail pushed past it would be clipped.
                 */
                const titles = await page.eval(
                    `Array.from(document.querySelectorAll('[data-testid^="pane-title-"]')).map(el => {
                        const spans = Array.from(el.children);
                        const head = spans[0] ?? null;
                        const tail = spans[1] ?? null;
                        const box = el.getBoundingClientRect();
                        return {
                            pane: el.getAttribute('data-testid').slice('pane-title-'.length),
                            full: (el.getAttribute('title') ?? '').trim(),
                            headText: (head?.textContent ?? '').trim(),
                            tailText: (tail?.textContent ?? '').trim(),
                            ellipsized: head === null ? false : head.scrollWidth > head.clientWidth + 1,
                            tailInside: tail === null ? false : tail.getBoundingClientRect().right <= box.right + 1
                        };
                    })`
                );
                recorder.note(`pane header titles: ${JSON.stringify(titles)}`);
                const truncated = (titles ?? []).filter((title) => title.ellipsized);
                recorder.check(
                    'a half-width pane header is too narrow for its path (so truncation is under test)',
                    truncated.length >= 1,
                    `${String(truncated.length)} of ${String((titles ?? []).length)} titles are ellipsized`
                );
                recorder.check(
                    'a truncated pane-header path keeps its last segment (middle truncation, §4.2 item 3)',
                    truncated.every(
                        (title) =>
                            title.tailText.length > 0 &&
                            title.tailInside &&
                            title.full.endsWith(title.tailText) &&
                            title.tailText.startsWith('/')
                    ),
                    JSON.stringify(
                        truncated.map((title) => ({ tail: title.tailText, inside: title.tailInside }))
                    )
                );
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
                // run-F N1: this is the step the intermittent renderer-start failure was caught
                // on, and it was caught five minutes late — by the closing console tally, not
                // here. A pane created by the CLI is a pane BUILT IN A HURRY, which is exactly
                // where the shared WASM engine used to strand one.
                const failedSplit = await panesFailedToRender(page);
                recorder.check(
                    'the pane the CLI split off has a live terminal, not the renderer-failed placeholder',
                    failedSplit.length === 0,
                    `panes showing "terminal renderer failed to start": ${JSON.stringify(failedSplit)}`
                );
                // Noted, not asserted: a pane that needed a second engine RECOVERED, which is
                // the retry doing its job, not a defect. Recording it keeps the upstream flake
                // rate visible run over run instead of invisible once it stops hurting.
                const retried = (await paneStartAttempts(page)).filter((pane) => pane.attempts > 1);
                if (retried.length > 0) recorder.note(`panes that needed a second engine: ${JSON.stringify(retried)}`);
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
                /**
                 * A layout with a real T-junction, chosen rather than inherited: `main-vertical`
                 * is one full-height divider down the middle and a split right column, which is
                 * the shape the overlap check below needs (the keybinding step before this one
                 * may have left an even-horizontal grid, which has no crossing at all).
                 *
                 * `nex layout` is caller-pane scoped (`requirePaneID()`), so it is run AS a
                 * pane — without `NEX_PANE_ID` the CLI exits 0 having done nothing, which is
                 * how this check silently found no junction to test.
                 */
                const anchorPane = (await domPaneIDs(page))[0];
                await cli.run(['layout', 'select', 'main-vertical'], { paneID: anchorPane });
                await sleep(1400);
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

                /**
                 * The T-junction itself (run-B m8). Where a perpendicular divider crosses this
                 * one, both 10px grab strips cover the same square and the DOM hands the press
                 * to whichever element paints last — grabbing the wrong divider means the drag
                 * runs across its fixed axis and nothing moves. Press exactly on the crossing
                 * and ask which divider took it; release without moving, so nothing commits.
                 */
                const crossing = dividers.find(
                    (divider) =>
                        divider.id !== vertical.id &&
                        divider.w > divider.h &&
                        // its bar runs somewhere along the vertical divider's span…
                        divider.y > vertical.top &&
                        divider.y < vertical.top + vertical.height &&
                        // …and reaches (within a grab strip of) the vertical divider's x.
                        vertical.x >= divider.x - divider.w / 2 - 6 &&
                        vertical.x <= divider.x + divider.w / 2 + 6
                );
                if (crossing === undefined) {
                    recorder.note('no T-junction in this layout — the overlap check needs a crossing divider');
                } else {
                    await page.mouse('mouseMoved', vertical.x, crossing.y, { button: 'none', buttons: 0 });
                    await page.mouse('mousePressed', vertical.x, crossing.y, { button: 'left', clickCount: 1 });
                    await sleep(120);
                    const grabbed = await page.eval(
                        `Array.from(document.querySelectorAll('[data-testid^="divider-"]'))
                            .filter(el => el.getAttribute('data-dragging') === 'true')
                            .map(el => el.getAttribute('data-testid'))`
                    );
                    await page.mouse('mouseReleased', vertical.x, crossing.y, { button: 'left', clickCount: 1 });
                    await sleep(200);
                    recorder.note(`press at the T-junction (${String(Math.round(vertical.x))}, ${String(Math.round(crossing.y))}) grabbed ${JSON.stringify(grabbed)}`);
                    recorder.check(
                        'a press at a T-junction grabs the divider whose bar it is on',
                        Array.isArray(grabbed) && grabbed.length === 1 && grabbed[0] === vertical.id,
                        `expected ${vertical.id}, got ${JSON.stringify(grabbed)}`
                    );
                }
                const widthsBefore = await page.eval(
                    `Object.fromEntries(Array.from(document.querySelectorAll('[data-testid^="pane-header-"]')).map(el => [el.getAttribute('data-testid').slice(12), Math.round(el.parentElement.getBoundingClientRect().width)]))`
                );
                // Press, move, sample the live overlay, screenshot, keep moving, then release —
                // the extra moves after the capture mean a slow screenshot cannot swallow the
                // gesture, and the sampled overlay is a machine-checkable version of "you can
                // see the new size while dragging".
                const badgesExpr =
                    `Object.fromEntries(Array.from(document.querySelectorAll('[data-testid^="pane-size-"]')).map(el => [el.getAttribute('data-testid').slice(10), el.innerText.trim()]))`;
                await page.mouse('mouseMoved', vertical.x, grabY, { button: 'none', buttons: 0 });
                await page.mouse('mousePressed', vertical.x, grabY, { button: 'left', clickCount: 1 });
                for (let step = 1; step <= 3; step++) {
                    await page.mouse('mouseMoved', vertical.x + step * 14, grabY, { button: 'left', buttons: 1 });
                    await sleep(25);
                }
                // Early in the gesture…
                const badgesEarly = await page.eval(badgesExpr);
                for (let step = 4; step <= 10; step++) {
                    await page.mouse('mouseMoved', vertical.x + step * 14, grabY, { button: 'left', buttons: 1 });
                    await sleep(25);
                }
                // …and ~100px further along it. A chip that reads the same at both points is
                // showing a snapshot, not a size (run-B L5).
                const badgesLate = await page.eval(badgesExpr);
                const movedChips = Object.keys(badgesEarly ?? {}).filter(
                    (paneID) => (badgesLate ?? {})[paneID] !== undefined && badgesLate[paneID] !== badgesEarly[paneID]
                );
                recorder.note(`chips at +42px: ${JSON.stringify(badgesEarly)}`);
                recorder.note(`chips at +140px: ${JSON.stringify(badgesLate)}`);
                recorder.check(
                    'the cols × rows chips track the drag instead of showing the pre-drag grid',
                    movedChips.length >= 1,
                    `chips that changed during the gesture: ${movedChips.join(', ') || 'none'}`
                );
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
                // run-F N1: closing a pane frees a terminal on the shared WASM instance, and
                // the survivors re-measure against it. Nothing here should have gone dark.
                const failedClose = await panesFailedToRender(page);
                recorder.check(
                    'no survivor fell back to the renderer-failed placeholder',
                    failedClose.length === 0,
                    `panes showing "terminal renderer failed to start": ${JSON.stringify(failedClose)}`
                );
            }
        },

        // ── workspaces ──────────────────────────────────────────────────────────────
        {
            id: 'workspace-create-ui',
            expect: 'Clicking "New Workspace" opens an inline name field; typing "Audit Two" and pressing Return adds a second sidebar row and switches to it.',
            needsEyes: true,
            async run(recorder) {
                const before = await page.eval(`document.querySelectorAll('${PAGE.workspaceRows}').length`);
                // By test id first: the label carries its ⌘N hint inside the button, so an exact
                // text match is a selector that breaks the moment the button gains an affordance.
                const clicked = await page.eval(
                    `(() => {
                        const button = document.querySelector('[data-testid="sidebar-new-workspace"]')
                            ?? Array.from(document.querySelectorAll('button')).find(el => (el.textContent ?? '').trim().startsWith('New Workspace'));
                        if (button === undefined || button === null) return null;
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
                /**
                 * …and the window went there. Creating a workspace from the sidebar and being
                 * left looking at the old one is run-B L3's first half: the row appears, the
                 * daemon calls the new workspace active, and the grid never moves.
                 */
                let identity = '';
                for (let attempt = 0; attempt < 8; attempt++) {
                    identity = String(
                        await page.eval(`(document.querySelector('[data-testid="top-bar-identity"]')?.innerText ?? '').split('\\n')[0].trim()`)
                    );
                    if (identity.includes('Audit Two')) break;
                    await sleep(500);
                }
                recorder.note(`title-bar identity after the create: "${identity}"`);
                recorder.check(
                    'the window switched to the workspace it just created',
                    identity.includes('Audit Two'),
                    `window shows "${identity}"`
                );
                /**
                 * The pane you were just switched to has to be READABLE. Switching on create
                 * put a brand-new pane on screen a few hundred ms after its shell started,
                 * which is a moment nothing used to look at — and the first thing it showed
                 * was a screen of mojibake.
                 */
                const created2 = (await cli.json(['pane', 'list', '--json'])).find(
                    (pane) => pane.workspace_name === 'Audit Two'
                );
                if (created2 !== undefined) {
                    const capture = await cli.ok(['pane', 'capture', '--target', created2.id]);
                    recorder.block('nex pane capture (the new workspace’s pane)', capture);
                    const hosts = await page.eval(
                        `Array.from(document.querySelectorAll('[data-terminal-host]')).map(el => {
                            const pane = el.closest('[data-pane-id]');
                            const r = el.getBoundingClientRect();
                            return { pane: pane?.getAttribute('data-pane-id') ?? null,
                                     canvases: el.querySelectorAll('canvas').length,
                                     onScreen: r.width > 0 && r.height > 0 };
                        })`
                    );
                    recorder.note(`terminal hosts on screen: ${JSON.stringify(hosts)}`);
                    recorder.check(
                        'each terminal host holds exactly one canvas (no stale one left behind)',
                        Array.isArray(hosts) && hosts.every((host) => host.canvases <= 1),
                        JSON.stringify(hosts)
                    );
                    // Anything outside the prompt's own character set is corruption.
                    const junk = capture.replace(/[\x20-\x7E\s]/g, '');
                    recorder.check(
                        'the freshly revealed pane shows a clean prompt, not mojibake',
                        junk.length === 0,
                        `${String(junk.length)} non-ASCII characters in the capture: ${JSON.stringify(junk.slice(0, 60))}`
                    );
                }
                const failedUI = await panesFailedToRender(page);
                recorder.check(
                    'the new workspace\u2019s pane has a live terminal, not the renderer-failed placeholder',
                    failedUI.length === 0,
                    `panes showing "terminal renderer failed to start": ${JSON.stringify(failedUI)}`
                );
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
                const failedCLI = await panesFailedToRender(page);
                recorder.check(
                    'the revealed pane has a live terminal, not the renderer-failed placeholder',
                    failedCLI.length === 0,
                    `panes showing "terminal renderer failed to start": ${JSON.stringify(failedCLI)}`
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

                /**
                 * The menu must not sit on the row it acts on (run-B m7). Opening at the
                 * pointer put the panel over the workspace being renamed or deleted, so the one
                 * thing a destructive menu has to keep on screen — WHICH one — was behind it.
                 * Overlap is measured as area against the row that was right-clicked (the first
                 * row, which is what `rightClick` targets), so a menu that merely brushes the
                 * NEXT row still passes.
                 */
                const placement = await page.eval(
                    `(() => {
                        const row = document.querySelector('${PAGE.workspaceRows}');
                        const menu = document.querySelector('${PAGE.contextMenu}');
                        if (row === null || menu === null) return null;
                        const r = row.getBoundingClientRect();
                        const m = menu.getBoundingClientRect();
                        const overlapX = Math.max(0, Math.min(r.right, m.right) - Math.max(r.left, m.left));
                        const overlapY = Math.max(0, Math.min(r.bottom, m.bottom) - Math.max(r.top, m.top));
                        return {
                            row: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
                            menu: { top: Math.round(m.top), bottom: Math.round(m.bottom), left: Math.round(m.left), right: Math.round(m.right) },
                            overlap: Math.round(overlapX * overlapY)
                        };
                    })()`
                );
                recorder.note(`menu placement: ${JSON.stringify(placement)}`);
                recorder.check(
                    'the context menu opens clear of the row it acts on',
                    placement !== null && placement.overlap === 0,
                    placement === null ? 'no row/menu to measure' : `${String(placement.overlap)}px² of the row is covered`
                );
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
                /**
                 * What this click IS matters to the reading of the assertion below. When the
                 * window is already showing the row being clicked, the click is the idempotent
                 * re-assert of run-B L3 — the case that used to be a total no-op, leaving
                 * `nex workspace list` naming the wrong workspace for the rest of the session.
                 * Recorded rather than asserted: which workspace the run arrives here on
                 * depends on the steps before it, and the assertion is the same either way.
                 */
                const before = await page.eval(
                    `(document.querySelector('[data-testid="top-bar-identity"]')?.innerText ?? '').split('\\n')[0].trim()`
                );
                const beforeDaemon =
                    (await cli.json(['workspace', 'list', '--json'])).find((workspace) => workspace.is_active)?.name ??
                    null;
                recorder.note(
                    `before the click: window shows "${String(before)}", daemon calls "${String(beforeDaemon)}" active` +
                        (String(before).includes('Renamed One')
                            ? ' — this click is the IDEMPOTENT re-assert (the row is already the one on screen)'
                            : '')
                );
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

                /**
                 * The panes the switch brought back must show THEIR OWN screens.
                 *
                 * Switching workspace evicts the background workspace's engines
                 * (`mount-policy.ts`) and remounts them on the way back, and a remounted pane
                 * used to come up wearing the screen of whichever pane had last held its WASM
                 * slot — a garbled grid on a plain sidebar click, with the daemon perfectly
                 * innocent (`nex pane capture` was always clean). Nothing in the DOM can be
                 * asked what a canvas says, so the check is the ink: a pane whose VT holds a
                 * bare prompt cannot be painting a screenful of somebody else's output.
                 */
                const failedSwitch = await panesFailedToRender(page);
                recorder.check(
                    'every pane the switch brought back has a live terminal',
                    failedSwitch.length === 0,
                    `panes showing "terminal renderer failed to start": ${JSON.stringify(failedSwitch)}`
                );
                for (const paneID of await domPaneIDs(page)) {
                    // Ink first: a pane with no canvas is a content pane, and `pane capture`
                    // rejects those — so the absence of a canvas is the skip condition, not an
                    // error to recover from.
                    const paint = await paneInkPixels(page, paneID);
                    if (paint === null) continue;
                    const capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                    const cells = capturedCells(capture);
                    const budget = INK_FLOOR_PIXELS + INK_PER_CELL_PIXELS * cells;
                    recorder.note(
                        `pane ${paneID.slice(0, 8)}: ${String(cells)} cells in use in the daemon's VT, ` +
                            `${String(paint.ink)} ink pixels on screen (budget ${String(budget)})`
                    );
                    recorder.check(
                        `the revealed pane ${paneID.slice(0, 8)} paints its own screen, not a leftover one`,
                        paint.ink <= budget,
                        `${String(paint.ink)} ink pixels for a capture using ${String(cells)} cells — a remounted pane wearing another pane's grid is what this catches`
                    );
                }

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

                /**
                 * The survivor is the most-resized pane in the whole run — three window sizes,
                 * four splits, two closes — and by this step its screen is a wall of glyphs,
                 * because `@xterm/headless` re-wraps instead of reflowing (ledger L6) and the
                 * grid has been re-wrapped at 128 → 81 → 178 → 51 → 128 columns. A screenshot
                 * alone cannot tell that apart from the client painting somebody else's grid,
                 * which is the defect the workspace-switch step catches on a remount. So make
                 * the same read here: print what the daemon's VT actually holds, and bound the
                 * ink by it. A mess the daemon agrees with is L6; ink beyond the budget is the
                 * client's.
                 *
                 * …and on THIS pane, after this many resizes, it can no longer be an assertion.
                 *
                 * L6 turned out to be worse than the ledger said. The claim there was that the
                 * daemon merely *scrambles* — "`nex pane capture` holds the same scrambled text
                 * the screen shows". It does not: run-H measured 280 k ink pixels on screen
                 * against **53 cells across the daemon's visible screen AND its scrollback**, and
                 * the screenshot (`17-tidy-grid.png`) shows this pane's own glyph torture-test
                 * output — not a neighbour's. So after five re-wraps the daemon's VT has *lost*
                 * history the client still holds, and no budget derived from the daemon can tell
                 * "the client is painting its own stale history" (L6, accepted) from "the client
                 * is painting another pane's screen" (the remount bleed, the defect this guard
                 * was built for).
                 *
                 * Rather than assert something it cannot decide, this records the numbers and
                 * hands the question to the eye — the same treatment N1's retry count gets, and
                 * for the same reason: keeping the measurement visible run over run is worth more
                 * than a red mark that always means L6. The cross-pane guard itself is NOT lost;
                 * it still asserts on the panes that matter for a bleed — the ones a workspace
                 * switch REVEALS (steps 16/17 of the run-G lineage), which have not been through
                 * a resize storm and where the daemon's capture is still a fair bound.
                 */
                const survivorCapture = await cli.ok(['pane', 'capture', '--target', keep.id]);
                recorder.block('nex pane capture (the survivor)', survivorCapture);
                const survivorHistory = await cli.ok(['pane', 'capture', '--target', keep.id, '--scrollback']);
                const survivorPaint = await paneInkPixels(page, keep.id);
                if (survivorPaint !== null) {
                    const cells = capturedCells(survivorCapture);
                    const historyCells = Math.max(cells, capturedCells(survivorHistory));
                    const budget = INK_FLOOR_PIXELS + INK_PER_CELL_PIXELS * historyCells;
                    recorder.note(
                        `survivor ${keep.id.slice(0, 8)}: ${String(cells)} cells on the daemon's visible screen, ` +
                            `${String(historyCells)} across its scrollback, ` +
                            `${String(survivorPaint.ink)} ink pixels on screen ` +
                            `(a bleed-free pane would be under ${String(budget)}; over it means L6 has ` +
                            `diverged the two VTs — see the eyes note)`
                    );
                    recorder.eyes(
                        survivorPaint.ink <= budget
                            ? 'the survivor is within its own VT’s ink budget — nothing to judge here'
                            : `the survivor paints ${String(survivorPaint.ink)} ink pixels where the daemon's VT ` +
                              `holds only ${String(historyCells)} cells (L6). CHECK THE SCREENSHOT: this is ` +
                              `expected to be THIS pane's own earlier output re-wrapped — glyph rows it printed ` +
                              `itself. Another pane's prompt or another pane's text in it is the remount bleed ` +
                              'and is a blocker.'
                    );
                }
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
                               frontMatter: document.querySelectorAll('.front-matter, table').length,
                               // run-B L1: the CANVAS, read from inside the sandboxed frame.
                               canvas: getComputedStyle(document.documentElement).backgroundColor,
                               colorScheme: getComputedStyle(document.documentElement).colorScheme,
                               darkDoc: document.documentElement.classList.contains('dark') }))()`
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
                    checkFrameCanvas(recorder, rendered, 'markdown preview');
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

                /**
                 * A long line runs past the right edge (`wrap="off"`, which is what a source
                 * editor should do) — run-B's m10 called it "clipped with no visible horizontal
                 * scrollbar", from a screenshot taken while macOS's overlay scroller was idle.
                 * The question a picture cannot settle is whether the rest of the line is
                 * REACHABLE: scroll the editor and see whether it moves.
                 */
                const scroller = await page.eval(
                    `(() => {
                        const area = document.querySelector('[data-testid="content-textarea-${state.mdPane}"]');
                        if (area === null) return null;
                        const before = area.scrollLeft;
                        area.scrollLeft = area.scrollWidth;
                        const after = area.scrollLeft;
                        area.scrollLeft = before;
                        return { scrollWidth: Math.round(area.scrollWidth), clientWidth: Math.round(area.clientWidth), after: Math.round(after) };
                    })()`
                );
                recorder.note(`editor h-scroll: ${JSON.stringify(scroller)}`);
                if (scroller !== null && scroller.scrollWidth > scroller.clientWidth) {
                    recorder.check(
                        'a line wider than the editor is reachable by scrolling, not just cut off',
                        scroller.after > 0,
                        `scrollWidth ${String(scroller.scrollWidth)} vs clientWidth ${String(scroller.clientWidth)}, scrolled to ${String(scroller.after)}`
                    );
                }
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
                               files: document.querySelectorAll('details.file, .file-header').length,
                               canvas: getComputedStyle(document.documentElement).backgroundColor,
                               colorScheme: getComputedStyle(document.documentElement).colorScheme,
                               darkDoc: document.documentElement.classList.contains('dark'),
                               // §5.4's per-file horizontal scroller: it must EXIST and, when a
                               // line is wider than the pane, actually be scrollable — a clipped
                               // line with no way to reach its tail is the defect (run-B L1).
                               scrollers: Array.from(document.querySelectorAll('.hunks')).map((el) => ({
                                   overflowX: getComputedStyle(el).overflowX,
                                   scrollWidth: el.scrollWidth,
                                   clientWidth: el.clientWidth,
                                   scrollable: el.scrollWidth > el.clientWidth
                               })) }))()`
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
                    checkFrameCanvas(recorder, rendered, 'diff');
                    const scrollers = rendered.scrollers ?? [];
                    recorder.note(`hunk scrollers: ${JSON.stringify(scrollers)}`);
                    recorder.check(
                        'every file has the §5.4 horizontal scroll container',
                        scrollers.length >= 2 && scrollers.every((entry) => entry.overflowX === 'auto'),
                        scrollers.map((entry) => entry.overflowX).join(', ') || 'none'
                    );
                    recorder.check(
                        'a line wider than the pane is reachable by scrolling, not just cut off',
                        scrollers.some((entry) => entry.scrollable),
                        scrollers.map((entry) => `${String(entry.scrollWidth)}/${String(entry.clientWidth)}`).join(' ')
                    );
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
                        const host = document.querySelector('[data-testid="web-page-${String(web?.id)}"]');
                        if (host === null) return null;
                        const r = host.getBoundingClientRect();
                        return { text: (host.innerText ?? '').slice(0, 200),
                                 x: Math.round(r.x), y: Math.round(r.y),
                                 w: Math.round(r.width), h: Math.round(r.height),
                                 dpr: window.devicePixelRatio };
                    })()`
                );
                recorder.note(`web page hole: ${JSON.stringify(placeholder)}`);

                /**
                 * The placement, proved from BOTH ends.
                 *
                 * The shell logs `owner=main bounds=…` when it re-parents the view into the
                 * window — that is the host's account of what it did. The other end is the page
                 * itself: an embedded view is laid out by the pane's rect, so its own
                 * `innerWidth`/`innerHeight`/`devicePixelRatio` have to match the hole the client
                 * drew. Run-B's L2 was invisible to the first check and caught by the second —
                 * the view WAS attached, and the page inside it was still laid out at the
                 * off-screen automation viewport (1280×800 @1×), so the pane showed its clipped
                 * top-left corner.
                 */
                const placement = runtime.shell?.lines.filter((line) =>
                    line.includes(`web pane ${String(web?.id)} view owner=`)
                ) ?? [];
                const lastPlacement = placement[placement.length - 1] ?? '(none)';
                recorder.note(`shell placement log: ${lastPlacement}`);
                recorder.check('the shell re-parented the view into its own window', lastPlacement.includes('owner=main'), lastPlacement);

                const targets = await listTargets(sandbox.debugPort);
                const viewTarget = targets.find(
                    (entry) => entry.type === 'page' && typeof entry.url === 'string' && entry.url.startsWith(site.url)
                );
                recorder.check('the embedded page has its own CDP target', viewTarget !== undefined, String(targets.length) + ' targets');
                if (viewTarget !== undefined && placeholder !== null) {
                    const view = await connect(viewTarget.webSocketDebuggerUrl, { repoRoot });
                    const metrics = await view.eval(
                        '({ iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio })'
                    );
                    view.close();
                    recorder.note(`embedded page viewport: ${JSON.stringify(metrics)}`);
                    recorder.check(
                        'the page is laid out at the pane\'s width, not the automation viewport',
                        Math.abs((metrics?.iw ?? 0) - placeholder.w) <= 2,
                        `page ${String(metrics?.iw)}px vs hole ${String(placeholder.w)}px`
                    );
                    recorder.check(
                        'the page is laid out at the pane\'s height',
                        Math.abs((metrics?.ih ?? 0) - placeholder.h) <= 2,
                        `page ${String(metrics?.ih)}px vs hole ${String(placeholder.h)}px`
                    );
                    recorder.check(
                        'the page renders at the window\'s device pixel ratio',
                        (metrics?.dpr ?? 0) === placeholder.dpr,
                        `page ${String(metrics?.dpr)} vs window ${String(placeholder.dpr)}`
                    );
                }
                recorder.eyes('IS THE PAGE ACTUALLY VISIBLE inside the pane, at the right rect, under the pane header — the fixture\'s purple header and BOTH cards, unclipped?');

                /**
                 * Tidy the grid before the web-UX steps drive this pane's toolbar and its page.
                 *
                 * The web pane is the fourth split off the same edge, so it inherits ~130 CSS px
                 * — narrower than its own toolbar's intrinsic width (six 22 px buttons, their
                 * gaps and the URL field ≈ 195 px). The overflowing controls are then clipped by
                 * the pane's `overflow-hidden`, still report a box, and swallow every click; and
                 * the fixture page inside a 130 px viewport re-wraps so hard that a pick lands on
                 * a different element than the one the step named. Both are why run-H's
                 * pickup / favourites-menu / storage steps failed while the same steps passed
                 * under `--only` (529 px). So do here what `tidy-grid` does above, and for the
                 * same stated reason — "so the panes that follow open at a size a human can
                 * actually judge": the markdown and diff panes have been fully asserted by now,
                 * so close them and even what is left, which leaves the web pane ~640 px.
                 *
                 * The narrow-pane clipping itself is a real (minor) finding and is recorded in
                 * docs/PARITY.md's ledger as N3 — it is not what these steps are for.
                 */
                const spare = (await cli.json(['pane', 'list', '--json'])).filter(
                    (pane) =>
                        pane.is_active_workspace === true &&
                        pane.type !== 'shell' &&
                        pane.type !== 'web'
                );
                for (const pane of spare) {
                    await cli.run(['pane', 'close', '--target', String(pane.id)]);
                    await sleep(400);
                }
                // `nex layout` is one of the `requirePaneID()` verbs (§CLI-017): with no
                // `NEX_PANE_ID` it exits 0 SILENTLY and does nothing, so the pane id has to ride
                // along or this is a no-op that looks like a success.
                await cli.run(['layout', 'select', 'even-horizontal'], { paneID: String(web?.id) });
                await sleep(1800);
                const evened = await page.box(`[data-testid="pane-body-${String(web?.id)}"]`);
                recorder.note(`web pane width after evening the grid: ${String(Math.round(evened?.width ?? 0))}px`);
            }
        },

        // ── web pane UX: find, ⌘L, element pickup, favourites, cookies ───────────────
        //
        // Everything below drives the SAME pane the step above opened. They are ordered the way
        // a person would use them, and each one leaves the pane in a state the next can start
        // from (the batch step cancels itself; the favourite step un-stars what it starred).
        {
            id: 'web-find',
            expect:
                '⌘F over a web pane opens a find bar; typing "fixture" marks the page (yellow #F2D027, current match orange #FF7A00) and the bar reads 1/1.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.webPane;
                if (paneID === null) {
                    recorder.check('a web pane exists to search', false);
                    return;
                }
                // Nex's idea of focus first (a click on the pane's own chrome)…
                await focusWebPane(page, paneID);
                // …then the chord where a user would press it: inside the page, which is what
                // makes this a test of the host's chord forwarding rather than of CDP.
                const view = await webViewSession(sandbox, site, repoRoot);
                if (view !== null) {
                    await view.clickAt(30, 400);
                    await sleep(250);
                    await view.key('KeyF', { modifiers: MOD.meta, key: 'f' });
                    view.close();
                }
                await sleep(600);
                const forwarded = (runtime.shell?.lines ?? []).filter((line) => line.includes('forwarding'));
                recorder.note(`shell forwarding log: ${forwarded.slice(-3).join(' | ') || '(none)'}`);
                recorder.check(
                    'the host took the chord from the page and gave it to Nex',
                    forwarded.some((line) => line.includes('meta+KeyF')),
                    forwarded.at(-1) ?? '(none)'
                );
                const barPresent = await page.eval(
                    `document.querySelector('[data-testid="web-find-input-${paneID}"]') !== null`
                );
                recorder.check('⌘F opened the web pane\'s find bar', barPresent === true);
                if (barPresent !== true) {
                    await recorder.shot(page);
                    return;
                }
                await page.click(`[data-testid="web-find-input-${paneID}"]`);
                // `insertText`, not `type`: a React-controlled input receives both the synthetic
                // keyDown's `text` and the following `char` event, and ends up with every
                // character doubled ("ffiixxttuurree").
                await page.insertText('fixture');
                await sleep(900);
                await recorder.shot(page);

                const count = await page.eval(
                    `(document.querySelector('[data-testid="web-find-count-${paneID}"]')?.textContent ?? '')`
                );
                recorder.note(`find count: ${String(count)}`);
                recorder.check('the bar reports a real match count from the page', String(count) === '1/1', String(count));

                // The other end: the marks are IN the page, made by the injected script.
                const targets = await listTargets(sandbox.debugPort);
                const viewTarget = targets.find(
                    (entry) => entry.type === 'page' && typeof entry.url === 'string' && entry.url.startsWith(site.url)
                );
                if (viewTarget !== undefined) {
                    const view = await connect(viewTarget.webSocketDebuggerUrl, { repoRoot });
                    const marks = await view.eval(
                        `(() => {
                            const nodes = Array.from(document.querySelectorAll('mark.nex-webfind-match'));
                            const current = nodes.find((node) => node.classList.contains('nex-webfind-current'));
                            return { count: nodes.length,
                                     text: nodes.map((node) => node.textContent).join('|'),
                                     currentBg: current === undefined ? '' : getComputedStyle(current).backgroundColor,
                                     otherBg: nodes.length > 0 ? getComputedStyle(nodes[0]).backgroundColor : '' };
                        })()`
                    );
                    view.close();
                    recorder.note(`page marks: ${JSON.stringify(marks)}`);
                    recorder.check('the page really carries <mark> highlights', (marks?.count ?? 0) === 1, String(marks?.count));
                    recorder.check(
                        'the current match uses the spec\'s orange (#FF7A00 = rgb(255,122,0))',
                        String(marks?.currentBg ?? '').replace(/\s/g, '') === 'rgb(255,122,0)',
                        String(marks?.currentBg)
                    );
                }

                // Escape closes the bar AND unmarks the page (WEB-065's "forget the needle").
                await page.key('Escape', { key: 'Escape' });
                await sleep(500);
                const closed = await page.eval(
                    `document.querySelector('[data-testid="web-find-${paneID}"]') === null`
                );
                recorder.check('Escape closed the find bar', closed === true);
                recorder.eyes('find bar: is the needle field, the n/N counter and the ↑ ↓ ✕ row legible and aligned under the URL bar? Are the page marks visible in the screenshot?');
            }
        },
        {
            id: 'web-url-bar-shortcut',
            expect: '⌘L moves the caret into the web pane\'s URL bar and selects the whole address (the priority key layer).',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.webPane;
                if (paneID === null) {
                    recorder.check('a web pane exists', false);
                    return;
                }
                await focusWebPane(page, paneID);
                const view = await webViewSession(sandbox, site, repoRoot);
                if (view !== null) {
                    await view.clickAt(30, 400);
                    await sleep(250);
                    await view.key('KeyL', { modifiers: MOD.meta, key: 'l' });
                    view.close();
                }
                await sleep(600);
                recorder.note(
                    `shell forwarding log: ${(runtime.shell?.lines ?? []).filter((line) => line.includes('forwarding')).slice(-3).join(' | ') || '(none)'}`
                );
                await recorder.shot(page);
                const focus = await page.eval(
                    `(() => {
                        const active = document.activeElement;
                        return { testid: active?.getAttribute?.('data-testid') ?? '',
                                 selected: active?.selectionStart === 0 && active?.selectionEnd === (active?.value ?? '').length,
                                 value: active?.value ?? '' };
                    })()`
                );
                recorder.note(`focus after ⌘L: ${JSON.stringify(focus)}`);
                recorder.check('⌘L focused the URL bar', focus?.testid === `web-url-${paneID}`, String(focus?.testid));
                recorder.check('the whole address is selected, ready to be typed over', focus?.selected === true);
                // Leave the caret out of the bar so later steps' shortcuts are not deferred.
                await page.key('Escape', { key: 'Escape' });
                recorder.eyes('URL bar focus ring / selection highlight');
            }
        },
        {
            id: 'web-batch-pickup',
            expect:
                'The scope button starts a batch: clicking two page elements adds two numbered rows to the panel and two numbered badges to the page; Send pastes one `# nex inspect batch` block into a shell pane.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.webPane;
                if (paneID === null) {
                    recorder.check('a web pane exists', false);
                    return;
                }
                // The WIDEST on-screen shell: the destination must be in this web pane's
                // workspace (WEB-133), and the pasted `# nex inspect batch …` header is ~50
                // columns — in a 33-column pane it soft-wraps and `pane capture` returns it as
                // two screen rows, which reads as a missing header when it is really a narrow
                // pane. Same class of harness artefact as `widestShellPane`'s three callers.
                const shell = await widestShellPane(page, cli);
                recorder.check('there is a shell pane to send the batch to', shell !== null);

                await page.click(`[data-testid="web-batch-toggle-${paneID}"]`);
                await sleep(900);
                const opened = await page.eval(
                    `document.querySelector('[data-testid="web-batch-panel-${paneID}"]') !== null`
                );
                recorder.check('the scope button opened the pickup panel', opened === true);

                // The picks happen in the PAGE, through the armed picker — a real click on a
                // real element, which is the only way the payload can be honest.
                const targets = await listTargets(sandbox.debugPort);
                const viewTarget = targets.find(
                    (entry) => entry.type === 'page' && typeof entry.url === 'string' && entry.url.startsWith(site.url)
                );
                recorder.check('the embedded page is reachable for the picks', viewTarget !== undefined);
                if (viewTarget !== undefined) {
                    const view = await connect(viewTarget.webSocketDebuggerUrl, { repoRoot });
                    const armed = await view.eval('window.__nexInspectorArmed ? window.__nexInspectorArmed() : null');
                    recorder.check('the page picker is armed (sticky)', armed === true, String(armed));
                    await view.click('#hello');
                    await sleep(700);
                    // WEB-142/WEB-143: the pick opens its comment popover, and while that is open
                    // the picker is SUSPENDED — so the next element cannot be picked until Done
                    // dismisses it. Pressing the popover's own button is the real gesture.
                    const dismissed = await view.eval(
                        `(() => {
                            const popover = document.querySelector('[data-nex-batch-popover]');
                            if (popover === null) return 'no popover';
                            const buttons = popover.querySelectorAll('button');
                            const done = buttons[buttons.length - 1];
                            if (done === undefined) return 'no button';
                            done.click();
                            return done.textContent;
                        })()`
                    );
                    recorder.check('the pick opened its comment popover, with a Done button', dismissed === 'Done', String(dismissed));
                    await sleep(500);
                    await view.click('#go');
                    await sleep(700);
                    await view.eval(
                        `(() => {
                            const popover = document.querySelector('[data-nex-batch-popover]');
                            const buttons = popover === null ? [] : popover.querySelectorAll('button');
                            const done = buttons[buttons.length - 1];
                            if (done !== undefined) done.click();
                            return true;
                        })()`
                    );
                    await sleep(400);
                    const badges = await view.eval(
                        `(() => {
                            const nodes = Array.from(document.querySelectorAll('[data-nex-batch-marker]'));
                            return { count: nodes.length, labels: nodes.map((node) => node.textContent).join(','),
                                     ring: document.querySelector('[data-nex-batch-focus-ring]') !== null };
                        })()`
                    );
                    view.close();
                    recorder.note(`page badges: ${JSON.stringify(badges)}`);
                    recorder.check('the page shows one numbered badge per pick', (badges?.count ?? 0) === 2, String(badges?.count));
                    recorder.check('the badges are numbered 1,2 to match the panel rows', String(badges?.labels) === '1,2', String(badges?.labels));
                }

                await sleep(400);
                await recorder.shot(page, 'picked');
                const rows = await page.eval(
                    `(() => {
                        const nodes = Array.from(document.querySelectorAll('[data-testid^="web-batch-item-"]'));
                        return { count: nodes.length,
                                 chips: nodes.map((node) => node.querySelector('[data-testid^="web-batch-chip-"]')?.textContent ?? '').join(','),
                                 selectors: nodes.map((node) => node.querySelector('[data-testid^="web-batch-selector-"]')?.textContent ?? '').join(' | ') };
                    })()`
                );
                recorder.note(`panel rows: ${JSON.stringify(rows)}`);
                recorder.check('the panel lists both picks', (rows?.count ?? 0) === 2, String(rows?.count));
                recorder.check('each row carries its numbered chip', String(rows?.chips) === '1,2', String(rows?.chips));

                // Annotate the first row, then send to the shell pane.
                const firstComment = await page.eval(
                    `document.querySelector('[data-testid^="web-batch-comment-"]')?.getAttribute('data-testid') ?? ''`
                );
                if (String(firstComment) !== '') {
                    await page.click(`[data-testid="${String(firstComment)}"]`);
                    await page.insertText('the page heading');
                    await sleep(500);
                }

                if (shell !== null) {
                    await page.eval(
                        `(() => {
                            const select = document.querySelector('[data-testid="web-batch-destination-${paneID}"]');
                            if (select === null) return false;
                            select.value = ${JSON.stringify(String(shell.id))};
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                            return true;
                        })()`
                    );
                    await sleep(300);
                    await recorder.shot(page, 'ready-to-send');
                    await page.click(`[data-testid="web-batch-send-${paneID}"]`);
                    await sleep(1500);

                    const capture = await cli.run(['pane', 'capture', '--target', String(shell.id), '--scrollback']);
                    const text = `${capture.stdout}\n${capture.stderr}`;
                    recorder.artifact('batch-paste.txt', text);
                    recorder.block('nex pane capture (destination shell)', text.slice(-1600));
                    /**
                     * The needle is `nex inspect batch`, not `# nex inspect batch`.
                     *
                     * What lands in the destination is a SHELL's echo of a pasted line, and a
                     * line long enough to wrap is re-drawn by readline — so `pane capture` can
                     * return the header's halves in either order and with the leading `# `
                     * consumed by the redraw. That is a terminal fact, not a payload defect:
                     * the three assertions below read the payload itself and are exact. Match
                     * the header's distinguishing words, over the de-wrapped text as well as
                     * the raw rows.
                     */
                    const dewrapped = text.split('\n').join('');
                    recorder.check(
                        'the batch header reached the shell pane',
                        text.includes('nex inspect batch') || dewrapped.includes('nex inspect batch'),
                        'header present'
                    );
                    recorder.check('the payload names both picked elements', text.includes('hello') && text.includes('go'), 'both selectors present');
                    recorder.check('the annotation rode along', text.includes('the page heading'), 'comment present');
                }

                await sleep(400);
                await recorder.shot(page, 'after-send');
                const torndown = await page.eval(
                    `document.querySelector('[data-testid="web-batch-panel-${paneID}"]') === null`
                );
                recorder.check('sending tore the batch down', torndown === true);
                recorder.eyes('pickup panel: numbered chips, selector truncation, comment fields, destination picker and Send — and the page badges/focus ring in the "picked" shot');
            }
        },
        {
            id: 'web-favourite',
            expect:
                'The URL-bar star saves the current page: it fills, the favourite appears in the bookmarks menu and in Settings ▸ Web, and clicking it again removes it.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.webPane;
                if (paneID === null) {
                    recorder.check('a web pane exists', false);
                    return;
                }
                const starState = async () =>
                    page.eval(
                        `document.querySelector('[data-testid="web-favourite-star-${paneID}"]')?.getAttribute('data-saved') ?? ''`
                    );
                recorder.check('the star starts hollow', String(await starState()) === 'false', String(await starState()));

                await page.click(`[data-testid="web-favourite-star-${paneID}"]`);
                await sleep(900);
                await recorder.shot(page, 'starred');
                recorder.check('the star filled after saving', String(await starState()) === 'true', String(await starState()));

                await page.click(`[data-testid="web-favourites-menu-${paneID}"]`);
                await sleep(500);
                await recorder.shot(page, 'menu');
                const menu = await page.eval(
                    `(() => {
                        const list = document.querySelector('[data-testid="web-favourites-list-${paneID}"]');
                        return { present: list !== null, text: (list?.innerText ?? '').slice(0, 200) };
                    })()`
                );
                recorder.note(`bookmarks menu: ${JSON.stringify(menu)}`);
                recorder.check('the bookmarks menu lists the saved page', menu?.present === true && String(menu?.text).includes('Fixture'), String(menu?.text));

                // "Manage favourites…" is the deep link into Settings ▸ Web.
                await page.click(`[data-testid="web-favourites-manage-${paneID}"]`);
                await sleep(900);
                await recorder.shot(page, 'settings-web');
                const tab = await page.eval(
                    `(() => {
                        const panel = document.querySelector('[data-testid="settings-tab-web"]');
                        return { present: panel !== null, text: (panel?.innerText ?? '').slice(0, 400),
                                 rows: document.querySelectorAll('[data-testid^="settings-favourite-title-"]').length };
                    })()`
                );
                recorder.note(`Settings ▸ Web: ${JSON.stringify(tab)}`);
                recorder.check('"Manage favourites…" opened Settings on the Web tab', tab?.present === true);
                recorder.check('the tab lists the favourite', (tab?.rows ?? 0) === 1, String(tab?.rows));

                // Rename it there, and prove the new title reaches the pane's menu.
                const titleField = await page.eval(
                    `document.querySelector('[data-testid^="settings-favourite-title-"]')?.getAttribute('data-testid') ?? ''`
                );
                if (String(titleField) !== '') {
                    await page.click(`[data-testid="${String(titleField)}"]`);
                    await page.eval(
                        `(() => {
                            const input = document.querySelector('[data-testid="${String(titleField)}"]');
                            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            setter.call(input, 'Audit fixture');
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            return true;
                        })()`
                    );
                    await page.enter();
                    await sleep(800);
                    await recorder.shot(page, 'renamed');
                    const renamed = await page.eval(
                        `document.querySelector('[data-testid^="settings-favourite-title-"]')?.value ?? ''`
                    );
                    recorder.check('the rename committed on Return', String(renamed) === 'Audit fixture', String(renamed));
                }

                await page.click('[data-testid="settings-close"]');
                await sleep(700);
                await page.click(`[data-testid="web-favourite-star-${paneID}"]`);
                await sleep(800);
                recorder.check('clicking the filled star removed the favourite', String(await starState()) === 'false', String(await starState()));
                recorder.eyes('star fill colour, the bookmarks dropdown, and the Settings ▸ Web list (rows, reorder buttons, footer note)');
            }
        },
        {
            id: 'web-cookie-panel',
            expect:
                'The storage button lists the fixture\'s cookie grouped under its domain, and the private-session toggle asks before switching.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.webPane;
                if (paneID === null) {
                    recorder.check('a web pane exists', false);
                    return;
                }
                await page.click(`[data-testid="web-storage-toggle-${paneID}"]`);
                await sleep(1200);
                await recorder.shot(page, 'panel');
                const groups = await page.eval(
                    `(() => {
                        const panel = document.querySelector('[data-testid="web-storage-${paneID}"]');
                        const buttons = Array.from(document.querySelectorAll('[data-testid^="web-cookie-group-"]'));
                        return { present: panel !== null,
                                 groups: buttons.map((node) => (node.textContent ?? '').trim()),
                                 collapsed: buttons.every((node) => node.getAttribute('data-open') === 'false') };
                    })()`
                );
                recorder.note(`cookie groups: ${JSON.stringify(groups)}`);
                recorder.check('the storage panel opened', groups?.present === true);
                recorder.check(
                    'the fixture\'s cookie is grouped under its domain',
                    (groups?.groups ?? []).some((label) => label.includes('127.0.0.1')),
                    (groups?.groups ?? []).join(' / ')
                );
                recorder.check('groups start collapsed', groups?.collapsed === true);

                const domainButton = await page.eval(
                    `document.querySelector('[data-testid^="web-cookie-group-"]')?.getAttribute('data-testid') ?? ''`
                );
                if (String(domainButton) !== '') {
                    await page.click(`[data-testid="${String(domainButton)}"]`);
                    await sleep(500);
                    await recorder.shot(page, 'expanded');
                    const rows = await page.eval(
                        `Array.from(document.querySelectorAll('[data-testid^="web-cookie-127"]')).map((node) => (node.textContent ?? '').trim()).join(' | ')`
                    );
                    recorder.note(`cookie rows: ${String(rows)}`);
                    recorder.check('the cookie the fixture set is listed by name and value', String(rows).includes('nexaudit'), String(rows));
                }

                // WEB-049: the private toggle asks first, in the direction it is going.
                await page.click(`[data-testid="web-private-toggle-${paneID}"]`);
                await sleep(500);
                await recorder.shot(page, 'private-confirm');
                const confirm = await page.eval(
                    `(document.querySelector('[data-testid="web-storage-confirm-${paneID}"]')?.innerText ?? '')`
                );
                recorder.note(`private confirmation: ${String(confirm).slice(0, 200)}`);
                recorder.check('flipping private mode asks first', String(confirm).length > 20, String(confirm).slice(0, 80));
                recorder.check(
                    'the warning names what going private costs',
                    String(confirm).toLowerCase().includes('discard'),
                    String(confirm).slice(0, 120)
                );
                await page.click(`[data-testid="web-storage-confirm-cancel-${paneID}"]`);
                await sleep(300);
                await page.click(`[data-testid="web-storage-close-${paneID}"]`);
                recorder.eyes('storage panel: accordion rows, cookie name/value truncation, the confirmation block and the two buttons');
            }
        },

        // ── settings ────────────────────────────────────────────────────────────────
        {
            id: 'settings-open',
            expect: 'The gear in the sidebar footer opens a settings overlay whose tab rail carries General, Appearance, Workspaces, Keybindings, Labels, Profiles and Web, over a dimmed backdrop.',
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
                // Containment rather than a count: tabs are added by feature work (Web arrived
                // with favourites), and a hard count turns that into a false regression.
                for (const label of ['General', 'Keybindings', 'Appearance', 'Labels', 'Profiles', 'Workspaces', 'Web']) {
                    recorder.check(`the ${label} tab is present`, (shape.tabs ?? []).includes(label), (shape.tabs ?? []).join(', '));
                }
                recorder.check('a close affordance exists', shape.close === true);
                recorder.eyes('overlay elevation, padding, tab affordance, whether the panel is centred and readable');
            }
        },
        ...['general', 'appearance', 'workspaces', 'keybindings', 'labels', 'profiles', 'web'].map((tab) => ({
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
                if (tab === 'web' && (body?.inputs ?? 0) === 0) {
                    // A favourites list with nothing in it has nothing to operate: the Swift
                    // empty state is a star glyph and a sentence pointing at the URL bar, and
                    // inventing a control here would be inventing a feature.
                    const empty = await page.eval(
                        `document.querySelector('[data-testid="settings-favourites-empty"]') !== null`
                    );
                    recorder.check('the empty favourites list says so, and says where to add one', empty === true);
                } else {
                    recorder.check('the tab has interactive controls', (body?.inputs ?? 0) > 0, `${String(body?.inputs)} controls`);
                }
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
        // ── appearance, system stats, global hotkey (SET-023…046, APP-078…085, SET-081…084) ──
        {
            id: 'appearance-preset-theme',
            expect:
                'Settings ▸ Appearance shows a grid of seven chrome preset swatches; clicking Gruvbox Dark writes `chrome-appearance` + `chrome-colors` into the nex config, reports which theme was applied, and repaints the window chrome without touching the ghostty file.',
            needsEyes: true,
            async run(recorder) {
                await openSettingsTab(page, 'appearance');
                const ghosttyBefore = fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
                await recorder.shot(page, 'before');

                const presets = await page.eval(
                    `Array.from(document.querySelectorAll('[data-testid^="theme-preset-"]')).map(el => el.getAttribute('data-testid'))`
                );
                recorder.check('the seven preset swatches render', (presets ?? []).length === 7, (presets ?? []).join(', '));

                await page.eval(
                    `document.querySelector('[data-testid="theme-preset-gruvbox-dark"]')?.scrollIntoView({ block: 'center' })`
                );
                await sleep(250);
                await page.click('[data-testid="theme-preset-gruvbox-dark"]');
                await sleep(1200);
                await recorder.shot(page, 'applied');

                const status = await page.eval(
                    `(document.querySelector('[data-testid="theme-status"]')?.innerText ?? '').trim()`
                );
                recorder.note(`status line: ${String(status)}`);
                recorder.check('the status line names the applied theme', /Gruvbox Dark/.test(String(status)), String(status));

                const config = fs.readFileSync(sandbox.configPath, 'utf8');
                recorder.block('nex config after applying the preset', config || '(empty)');
                recorder.check('chrome-appearance was written', /chrome-appearance\s*=\s*dark/.test(config), config.slice(0, 200));
                recorder.check(
                    'the palette was written as chrome-colors',
                    /chrome-colors\s*=.*FE8019/.test(config),
                    (config.match(/chrome-colors.*/) ?? ['(absent)'])[0].slice(0, 160)
                );

                // SET-030: a chrome theme must NOT touch the terminal background.
                const ghosttyAfter = fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
                recorder.check('the ghostty config was left alone', ghosttyAfter === ghosttyBefore, ghosttyAfter.slice(0, 160));

                // The palette actually reached the document, not just the file.
                const accent = await page.eval(
                    `getComputedStyle(document.documentElement).getPropertyValue('--nex-accent').trim()`
                );
                recorder.note(`--nex-accent after apply: ${String(accent)}`);
                recorder.check(
                    'the chrome accent variable took the preset colour',
                    String(accent).toUpperCase().includes('FE8019'),
                    String(accent)
                );
                recorder.eyes('did the SIDEBAR, header and status footer actually change colour — and is the preset grid legible?');
            }
        },
        {
            id: 'appearance-ghostty-write',
            expect:
                'The Appearance tab writes the ghostty-owned keys into ~/.config/ghostty/config: dragging Background opacity and picking a terminal theme both land in that file, every unrelated line survives, and the change reaches the live terminal panes.',
            needsEyes: true,
            async run(recorder) {
                await openSettingsTab(page, 'appearance');
                const before = fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
                recorder.block('ghostty config before', before);

                // The background picker is a native colour input; the value is set directly and
                // an input event dispatched, which is what a picker does.
                await page.eval(
                    `(() => {
                        const el = document.querySelector('[data-testid="terminal-background-input"]');
                        if (el === null) return false;
                        el.scrollIntoView({ block: 'center' });
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                        setter.call(el, '#2d1b3d');
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    })()`
                );
                await sleep(1600);
                await recorder.shot(page, 'background');

                const afterBackground = fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
                recorder.block('ghostty config after the background pick', afterBackground);
                recorder.check(
                    'the background landed in the GHOSTTY config',
                    /background\s*=\s*#2d1b3d/i.test(afterBackground),
                    afterBackground.slice(0, 200)
                );
                recorder.check(
                    'the unrelated comment line survived byte-for-byte',
                    afterBackground.includes('# audit sandbox ghostty config'),
                    afterBackground.slice(0, 200)
                );

                // The daemon re-reads and broadcasts, so the pane fill must follow.
                //
                // Read off the ROOT THEME CONTAINER, not `documentElement`: `--nex-term-bg` is
                // assigned as an inline style on the provider's own div (only the chrome tokens
                // are mirrored onto the document), and `documentElement` carries the
                // stylesheet's static fallback — which is the pre-change colour, so reading it
                // there would pass on a daemon that never wrote anything.
                const paneFill = await page.eval(
                    `(() => {
                        // \`documentElement\` also carries \`data-nex-theme\` (the provider mirrors
                        // the bucket onto it), so the FIRST match is the html element and its
                        // \`--nex-term-bg\` is the stylesheet's static fallback. The provider's
                        // own div is the one holding the inline assignment.
                        const hosts = Array.from(document.querySelectorAll('[data-nex-theme]'))
                            .filter((el) => el !== document.documentElement);
                        const host = hosts[0];
                        if (host === undefined) return '(no theme container)';
                        return getComputedStyle(host).getPropertyValue('--nex-term-bg').trim();
                    })()`
                );
                recorder.note(`--nex-term-bg after the write: ${String(paneFill)}`);
                recorder.check(
                    'the live pane fill followed the ghostty write',
                    /45\s*,\s*27\s*,\s*61/.test(String(paneFill)) || String(paneFill).toLowerCase().includes('2d1b3d'),
                    String(paneFill)
                );

                // Opacity: a slider, so a real input event on the range.
                await page.eval(
                    `(() => {
                        const el = document.querySelector('[data-testid="terminal-opacity-slider"]');
                        if (el === null) return false;
                        el.scrollIntoView({ block: 'center' });
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                        setter.call(el, '0.85');
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    })()`
                );
                await sleep(1600);
                await recorder.shot(page, 'opacity');
                const afterOpacity = fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
                recorder.block('ghostty config after the opacity drag', afterOpacity);
                recorder.check(
                    'the opacity landed in the ghostty config',
                    /background-opacity\s*=\s*0\.85/.test(afterOpacity),
                    afterOpacity.slice(0, 200)
                );

                // A terminal theme: writes `theme` AND clears the explicit background (SET-040).
                await page.eval(
                    `(() => {
                        const el = document.querySelector('[data-testid="terminal-theme-select"]');
                        if (el === null) return false;
                        el.scrollIntoView({ block: 'center' });
                        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
                        setter.call(el, 'Nord');
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    })()`
                );
                await sleep(1600);
                await recorder.shot(page, 'theme');
                const afterTheme = fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
                recorder.block('ghostty config after the theme pick', afterTheme);
                recorder.check('the theme landed in the ghostty config', /theme\s*=\s*Nord/.test(afterTheme), afterTheme.slice(0, 200));
                recorder.check(
                    'the explicit background was cleared so the theme is not outranked',
                    !/^\s*background\s*=/m.test(afterTheme),
                    afterTheme.slice(0, 200)
                );
                recorder.eyes('did the TERMINAL PANES behind the sheet actually change colour when the background was picked?');
            }
        },
        {
            id: 'appearance-system-stats',
            expect:
                'Turning on the extra metrics and the mini graphs in Settings ▸ Appearance makes the footer show six live gauges with real values and sparklines; hovering one opens a detail popover with now/min/max/avg.',
            needsEyes: true,
            async run(recorder) {
                await openSettingsTab(page, 'appearance');
                // Enable every metric plus the graphs, then close the sheet and look at the
                // footer — the gauges are the thing being audited, not the switches.
                for (const kind of ['network', 'diskIO', 'diskSpace']) {
                    await page.eval(
                        `document.querySelector('[data-testid="stats-kind-toggle-${kind}"]')?.scrollIntoView({ block: 'center' })`
                    );
                    await sleep(200);
                    await page.click(`[data-testid="stats-kind-toggle-${kind}"]`);
                    await sleep(600);
                }
                await page.eval(`document.querySelector('[data-testid="stats-graphs"]')?.setAttribute('open', '')`);
                await sleep(300);
                await page.eval(
                    `document.querySelector('[data-testid="stats-graphs-toggle"]')?.scrollIntoView({ block: 'center' })`
                );
                await sleep(200);
                await page.click('[data-testid="stats-graphs-toggle"]');
                await sleep(800);
                await recorder.shot(page, 'settings');

                const config = fs.readFileSync(sandbox.configPath, 'utf8');
                recorder.check(
                    'the enabled metric set was written sorted',
                    /system-stats\s*=\s*cpu,diskIO,diskSpace,load,memory,network/.test(config),
                    (config.match(/system-stats.*/) ?? ['(absent)'])[0]
                );
                recorder.check(
                    'mini graphs were enabled in the config',
                    /show-system-stat-graphs\s*=\s*true/.test(config),
                    (config.match(/show-system-stat-graphs.*/) ?? ['(absent)'])[0]
                );

                await page.key('Escape');
                // Two sample intervals, so every gauge has ≥2 points and a sparkline can draw.
                await sleep(5000);
                await recorder.shot(page, 'footer');

                const gauges = await page.eval(
                    `Array.from(document.querySelectorAll('[data-testid^="stat-gauge-"]')).map(el => ({
                        id: el.getAttribute('data-testid'),
                        value: el.getAttribute('data-value'),
                        graph: el.querySelector('svg') !== null
                    }))`
                );
                recorder.block('footer gauges', JSON.stringify(gauges ?? [], null, 2));
                recorder.check('all six gauges render', (gauges ?? []).length === 6, String((gauges ?? []).length));
                recorder.check(
                    'the gauges are in canonical order',
                    JSON.stringify((gauges ?? []).map((g) => g.id)) ===
                        JSON.stringify([
                            'stat-gauge-cpu',
                            'stat-gauge-memory',
                            'stat-gauge-load',
                            'stat-gauge-network',
                            'stat-gauge-diskIO',
                            'stat-gauge-diskSpace'
                        ]),
                    (gauges ?? []).map((g) => g.id).join(', ')
                );
                // Real values, not placeholders: memory and disk space on a live machine are
                // never 0 %, and the load average is a real number.
                const byID = Object.fromEntries((gauges ?? []).map((g) => [g.id, g.value]));
                recorder.check(
                    'memory reads a real percentage',
                    /^\d+%$/.test(String(byID['stat-gauge-memory'])) && byID['stat-gauge-memory'] !== '0%',
                    String(byID['stat-gauge-memory'])
                );
                recorder.check(
                    'disk space reads a real percentage',
                    /^\d+%$/.test(String(byID['stat-gauge-diskSpace'])) && byID['stat-gauge-diskSpace'] !== '0%',
                    String(byID['stat-gauge-diskSpace'])
                );
                recorder.check(
                    'the load average reads as N.NN',
                    /^\d+\.\d{2}$/.test(String(byID['stat-gauge-load'])),
                    String(byID['stat-gauge-load'])
                );
                recorder.check(
                    'network and disk I/O read as rates',
                    /\/s$/.test(String(byID['stat-gauge-network'])) && /\/s$/.test(String(byID['stat-gauge-diskIO'])),
                    `${String(byID['stat-gauge-network'])} · ${String(byID['stat-gauge-diskIO'])}`
                );
                const sparklines = await page.eval(
                    `document.querySelectorAll('[data-testid^="stat-sparkline-"] polyline').length`
                );
                recorder.check('sparklines are drawn beside the values', Number(sparklines) >= 6, String(sparklines));

                // The hover popover.
                const box = await page.box('[data-testid="stat-gauge-memory"]');
                if (box !== null) {
                    await page.mouse('mouseMoved', box.x + box.width / 2, box.y + box.height / 2, {
                        button: 'none',
                        buttons: 0
                    });
                    await sleep(700);
                }
                await recorder.shot(page, 'popover');
                const popover = await page.eval(
                    `(document.querySelector('[data-testid="stat-popover-memory"]')?.innerText ?? '').replace(/\\n/g, ' | ')`
                );
                recorder.note(`memory popover: ${String(popover)}`);
                recorder.check('hovering a gauge opens its detail popover', String(popover).length > 0, String(popover));
                recorder.check(
                    'the popover carries the breakdown and the window summary',
                    /Memory/.test(String(popover)) &&
                        /\//.test(String(popover)) &&
                        /now/.test(String(popover)) &&
                        /avg/.test(String(popover)) &&
                        /samples/.test(String(popover)),
                    String(popover)
                );
                recorder.eyes(
                    'do the gauges read as one row (icon + value + sparkline, no jitter), and does the popover sit clear of the footer?'
                );
            }
        },
        {
            id: 'appearance-sidebar-tint',
            expect:
                'The Sidebar sliders in Settings ▸ Appearance are live: dragging "Avatar fill" and "Colour intensity" writes the nex config and visibly changes the workspace avatar in the sidebar behind the sheet.',
            needsEyes: true,
            async run(recorder) {
                await openSettingsTab(page, 'appearance');
                await page.eval(
                    `document.querySelector('[data-testid="sidebar-intensity"]')?.scrollIntoView({ block: 'center' })`
                );
                await sleep(300);
                await recorder.shot(page, 'before');

                const avatarFillBefore = await page.eval(
                    `(() => {
                        const avatar = document.querySelector('${PAGE.workspaceRows} span[aria-hidden]');
                        return avatar === null ? null : getComputedStyle(avatar).backgroundColor;
                    })()`
                );
                recorder.note(`avatar fill before: ${String(avatarFillBefore)}`);

                const drag = async (testID, value) => {
                    await page.eval(
                        `(() => {
                            const el = document.querySelector('[data-testid="${testID}-slider"]');
                            if (el === null) return false;
                            el.scrollIntoView({ block: 'center' });
                            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                            setter.call(el, '${value}');
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            return true;
                        })()`
                    );
                    await sleep(1400);
                };

                await drag('sidebar-avatar-fill', '0.90');
                await drag('sidebar-intensity', '1.50');
                await recorder.shot(page, 'dragged');

                const config = fs.readFileSync(sandbox.configPath, 'utf8');
                recorder.check(
                    'the avatar fill was written',
                    /sidebar-avatar-fill\s*=\s*0\.90/.test(config),
                    (config.match(/sidebar-avatar-fill.*/) ?? ['(absent)'])[0]
                );
                recorder.check(
                    'the colour intensity was written',
                    /sidebar-color-intensity\s*=\s*1\.50/.test(config),
                    (config.match(/sidebar-color-intensity.*/) ?? ['(absent)'])[0]
                );

                // The variables reached the theme container…
                const vars = await page.eval(
                    `(() => {
                        const hosts = Array.from(document.querySelectorAll('[data-nex-theme]'))
                            .filter((el) => el !== document.documentElement);
                        const host = hosts[0];
                        if (host === undefined) return null;
                        const read = (name) => getComputedStyle(host).getPropertyValue(name).trim();
                        return { fill: read('--nex-avatar-fill'), intensity: read('--nex-sidebar-intensity') };
                    })()`
                );
                recorder.note(`tint variables: ${JSON.stringify(vars)}`);
                recorder.check(
                    'the tint variables reached the theme container',
                    vars !== null && Number(vars.fill) === 0.9 && Number(vars.intensity) === 1.5,
                    JSON.stringify(vars)
                );

                // …and, the part that actually matters, the AVATAR is painted differently.
                const avatarFillAfter = await page.eval(
                    `(() => {
                        const avatar = document.querySelector('${PAGE.workspaceRows} span[aria-hidden]');
                        return avatar === null ? null : getComputedStyle(avatar).backgroundColor;
                    })()`
                );
                recorder.note(`avatar fill after: ${String(avatarFillAfter)}`);
                recorder.check(
                    'the sidebar avatar is repainted, not just the config',
                    avatarFillBefore !== null &&
                        avatarFillAfter !== null &&
                        avatarFillBefore !== avatarFillAfter,
                    `${String(avatarFillBefore)} → ${String(avatarFillAfter)}`
                );
                recorder.eyes('is the workspace avatar behind the sheet visibly more saturated than in the "before" shot?');
            }
        },
        {
            id: 'global-hotkey-record',
            expect:
                'Settings ▸ Keybindings ▸ Global records a system-wide hotkey: pressing ⌃⌥⇧K shows it as a chip and writes `global-hotkey = ctrl+alt+shift+k` into the nex config, and the "press again to hide" toggle becomes enabled.',
            needsEyes: true,
            async run(recorder) {
                await openSettingsTab(page, 'keybindings');
                await page.eval(
                    `document.querySelector('[data-testid="global-hotkey-section"]')?.scrollIntoView({ block: 'center' })`
                );
                await sleep(300);
                await recorder.shot(page, 'before');

                const emptyBefore = await page.eval(
                    `(document.querySelector('[data-testid="global-hotkey-empty"]')?.innerText ?? '').trim()`
                );
                recorder.check('the unset state shows an em-dash', String(emptyBefore) === '—', String(emptyBefore));
                const repressBefore = await page.eval(
                    `document.querySelector('[data-testid="global-hotkey-repress-toggle"]')?.disabled === true`
                );
                recorder.check('the repress toggle is disabled with no hotkey set', repressBefore === true);

                const before = fs.readFileSync(sandbox.configPath, 'utf8');
                await page.click('[data-testid="global-hotkey-record"]');
                await sleep(400);
                await recorder.shot(page, 'recording');
                const armed = await page.eval(
                    `(document.querySelector('[data-testid="global-hotkey-record"]')?.innerText ?? '').trim()`
                );
                recorder.check('the recorder armed', /press a key/i.test(String(armed)), String(armed));

                await page.key('KeyK', { modifiers: MOD.ctrl | MOD.alt | MOD.shift, key: 'K', keyCode: 75 });
                await sleep(1500);
                await recorder.shot(page, 'recorded');

                const chip = await page.eval(
                    `(document.querySelector('[data-testid="global-hotkey-chip"]')?.innerText ?? '').trim()`
                );
                recorder.note(`global hotkey chip: ${String(chip)}`);
                recorder.check(
                    'the chip shows the recorded chord',
                    /⌃/.test(String(chip)) && /⌥/.test(String(chip)) && /⇧/.test(String(chip)) && /K/.test(String(chip)),
                    String(chip)
                );

                const after = fs.readFileSync(sandbox.configPath, 'utf8');
                recorder.block('nex config after recording the global hotkey', after || '(empty)');
                recorder.check(
                    'the hotkey was written to the config file',
                    after !== before && /global-hotkey\s*=\s*ctrl\+alt\+shift\+k/.test(after),
                    (after.match(/global-hotkey.*/) ?? ['(absent)'])[0]
                );

                const repressAfter = await page.eval(
                    `document.querySelector('[data-testid="global-hotkey-repress-toggle"]')?.disabled === false`
                );
                recorder.check('the repress toggle is now enabled', repressAfter === true);

                // The ✕ clears it, writing the explicit `none`.
                await page.click('[data-testid="global-hotkey-clear"]');
                await sleep(1200);
                const cleared = fs.readFileSync(sandbox.configPath, 'utf8');
                recorder.check(
                    'the ✕ clears the hotkey in the file',
                    /global-hotkey\s*=\s*none/.test(cleared),
                    (cleared.match(/global-hotkey.*/) ?? ['(absent)'])[0]
                );
                await recorder.shot(page, 'cleared');
                recorder.eyes('is the Global section legible as its own group, and does the chip read as a shortcut?');
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

        // ── the workspace inspector, bulk operations, and the sidebar's width ───────
        {
            id: 'inspector-open',
            expect:
                'The top bar’s inspector button opens a 280 px trailing panel scoped to the active workspace: its name, its pane count, the ten-colour row, the profile picker, an empty Repositories section, and every pane of the workspace listed with the focused one marked.',
            needsEyes: true,
            async run(recorder) {
                await page.click('[data-testid="toggle-inspector"]');
                await page.waitFor(`document.querySelector('[data-testid="inspector"]') !== null`, {
                    timeoutMs: 5000,
                    label: 'the inspector to open'
                });
                await sleep(600);
                await recorder.shot(page);

                const seen = await page.eval(
                    `(() => {
                        const panel = document.querySelector('[data-testid="inspector"]');
                        if (panel === null) return null;
                        const rect = panel.getBoundingClientRect();
                        const paneRows = Array.from(document.querySelectorAll('[data-testid^="inspector-pane-"]'))
                            .filter(el => !el.getAttribute('data-testid').startsWith('inspector-pane-focused'));
                        return JSON.stringify({
                            width: Math.round(rect.width),
                            name: document.querySelector('[data-testid="inspector-workspace-name"]')?.textContent ?? '',
                            workspaceText: (document.querySelector('[data-testid="inspector-workspace"]')?.innerText ?? '').replace(/\\n/g, ' | '),
                            colors: document.querySelectorAll('[data-testid^="inspector-color-"]').length,
                            profile: document.querySelector('[data-testid="inspector-profile"]')?.value ?? null,
                            repos: (document.querySelector('[data-testid="inspector-repos"]')?.innerText ?? '').replace(/\\n/g, ' | '),
                            paneRows: paneRows.length,
                            focusMarkers: document.querySelectorAll('[data-testid^="inspector-pane-focused-"]').length
                        });
                    })()`
                );
                recorder.check('the inspector rendered', typeof seen === 'string', String(seen));
                if (typeof seen !== 'string') return;
                const info = JSON.parse(seen);
                recorder.note(`inspector: ${JSON.stringify(info)}`);
                recorder.check('it is the shipped app’s 280 pt width', info.width === 280, `${String(info.width)} px`);

                const panes = await cli.json(['pane', 'list', '--json']);
                const workspaces = await cli.json(['workspace', 'list', '--json']);
                const active = workspaces.find((workspace) => workspace.is_active === true);
                recorder.check(
                    'it names the ACTIVE workspace',
                    active !== undefined && info.name === active.name,
                    `panel "${String(info.name)}" vs daemon "${String(active?.name)}"`
                );
                const activePanes = panes.filter((pane) => pane.workspace_id === active?.id);
                recorder.check(
                    'the pane list matches the daemon’s panes for that workspace',
                    info.paneRows === activePanes.length,
                    `${String(info.paneRows)} rows vs ${String(activePanes.length)} panes`
                );
                recorder.check('it prints the pane count', /\d+ panes?/.test(String(info.workspaceText)), String(info.workspaceText));
                recorder.check('the ten-colour row is there', info.colors === 10, `${String(info.colors)} swatches`);
                recorder.check('the profile picker leads with the built-in default', info.profile === 'default', String(info.profile));
                recorder.check(
                    'exactly one pane is marked as focused',
                    info.focusMarkers === 1,
                    `${String(info.focusMarkers)} markers`
                );
                recorder.check(
                    'with no associations it says so rather than showing an empty box',
                    String(info.repos).includes('No repositories associated'),
                    String(info.repos)
                );
                recorder.eyes('is the panel legible at 280 px — sections separated, nothing clipped, buttons discoverable?');
            }
        },
        {
            id: 'inspector-repo-status',
            expect:
                'Adding the fixture repository through the inspector registers it and renders one association row: a RED dot (the fixture has uncommitted changes), the repo name, its branch, and real diff stats read from git.',
            needsEyes: true,
            async run(recorder) {
                await page.click('[data-testid="inspector-add-repo"]');
                await sleep(300);
                await page.click('[data-menu-item="add-repo"]');
                await sleep(300);
                await page.click('[data-testid="add-repo-path"]');
                await page.insertText(repo);
                await recorder.shot(page, 'sheet');
                await page.click('[data-testid="add-repo-submit"]');

                await page.waitFor(
                    `document.querySelectorAll('[data-testid^="inspector-assoc-"]').length > 0`,
                    { timeoutMs: 15_000, label: 'the association row' }
                );
                await sleep(800);
                await recorder.shot(page);

                const row = await page.eval(
                    `(() => {
                        const el = Array.from(document.querySelectorAll('[data-testid^="inspector-assoc-"]'))
                            .find(node => !node.getAttribute('data-testid').startsWith('inspector-assoc-menu'));
                        if (el === undefined) return null;
                        return JSON.stringify({
                            text: (el.innerText ?? '').replace(/\\n/g, ' | '),
                            status: el.querySelector('[data-testid="inspector-status-dot"]')?.getAttribute('data-status') ?? null,
                            dotColor: getComputedStyle(el.querySelector('[data-testid="inspector-status-dot"]')).backgroundColor,
                            stats: el.querySelector('[data-testid="inspector-stats"]')?.innerText ?? null,
                            worktree: el.getAttribute('data-worktree'),
                            buttons: Array.from(el.querySelectorAll('button')).map(b => b.getAttribute('aria-label'))
                        });
                    })()`
                );
                recorder.check('an association row appeared', typeof row === 'string', String(row));
                if (typeof row !== 'string') return;
                const info = JSON.parse(row);
                recorder.note(`association row: ${JSON.stringify(info)}`);
                recorder.check(
                    'the dot reports the fixture repo as dirty, and is painted red',
                    info.status === 'dirty' && /rgb\(224,\s*101,\s*92\)/.test(String(info.dotColor)),
                    `${String(info.status)} / ${String(info.dotColor)}`
                );
                recorder.check(
                    'it is grouped as the main checkout, not a worktree',
                    info.worktree === 'false',
                    String(info.worktree)
                );
                recorder.check('the repo name and branch are shown', /repo/.test(String(info.text)) && /main/.test(String(info.text)), String(info.text));
                // The fixture's working tree: two edited files, so the stats must be non-zero.
                recorder.check(
                    'real diff stats came back from git',
                    /2 files/.test(String(info.stats)) && /\+\d/.test(String(info.stats)),
                    String(info.stats)
                );
                recorder.check(
                    'every row button carries an accessible label (§WS-150)',
                    Array.isArray(info.buttons) && info.buttons.length >= 3 && info.buttons.every((label) => typeof label === 'string' && label.length > 0),
                    JSON.stringify(info.buttons)
                );

                // §WS-141: the "plusminus" button opens a diff pane for that path.
                const before = await page.eval(paneCountExpr);
                await page.click('[data-testid^="inspector-diff-"]');
                await sleep(1500);
                const after = await page.eval(paneCountExpr);
                recorder.check('the diff button opened a pane', after === before + 1, `${String(before)} → ${String(after)}`);
                const panes = await cli.json(['pane', 'list', '--json']);
                // git answers with the REAL path (`/private/var/...` on macOS), which is what the
                // association carries and therefore what the diff pane opens on.
                const repoReal = fs.realpathSync(repo);
                const diffPane = panes.find(
                    (pane) => pane.type === 'diff' && (pane.working_directory === repo || pane.working_directory === repoReal)
                );
                recorder.check(
                    'the daemon opened it as a DIFF pane on the association’s path',
                    diffPane !== undefined,
                    panes.map((pane) => `${pane.type}:${pane.working_directory}`).join(', ')
                );
                await recorder.shot(page, 'diff-pane');
                if (diffPane !== undefined) await cli.ok(['pane', 'close', '--target', diffPane.id]);
                await sleep(600);
                recorder.eyes('do the dot, the branch and the +/- stats read clearly at this size?');
            }
        },
        {
            id: 'inspector-worktree-create',
            expect:
                'The inspector’s Add ▸ New Worktree creates a REAL git worktree: the sheet previews the sanitized path and branch, Create runs `git worktree add`, and the new worktree shows up on disk, in `git worktree list`, and as an indented association row with a green (clean) dot.',
            needsEyes: true,
            async run(recorder) {
                await page.click('[data-testid="inspector-add-repo"]');
                await sleep(300);
                await page.click('[data-menu-item="new-worktree"]');
                await page.waitFor(`document.querySelector('[data-testid="worktree-sheet"]') !== null`, {
                    timeoutMs: 5000,
                    label: 'the worktree sheet'
                });
                await page.click('[data-testid="worktree-name"]');
                await page.insertText('Audit WT');
                await sleep(250);
                await recorder.shot(page, 'sheet');

                const preview = await page.eval(
                    `(document.querySelector('[data-testid="worktree-preview"]')?.innerText ?? '').replace(/\\n/g, ' | ')`
                );
                const expectedPath = `${sandbox.home}/nex/worktrees/repo/Audit-WT`;
                recorder.note(`preview: ${String(preview)}`);
                recorder.check(
                    'the preview shows the sanitized folder the daemon will actually create',
                    String(preview).includes(expectedPath),
                    `${String(preview)} (expected ${expectedPath})`
                );
                recorder.check(
                    'and the sanitized branch it will create',
                    String(preview).includes('branch: Audit-WT'),
                    String(preview)
                );

                await page.click('[data-testid="worktree-create"]');
                await page.waitFor(
                    `document.querySelector('[data-testid="worktree-sheet"]') === null`,
                    { timeoutMs: 60_000, label: 'the worktree create to finish' }
                );
                await sleep(1500);
                await recorder.shot(page);

                const created = fs.existsSync(expectedPath);
                recorder.check('the worktree exists on disk', created, expectedPath);
                let listed = '';
                try {
                    listed = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
                } catch (error) {
                    listed = String(error.message ?? error);
                }
                recorder.block('git worktree list', listed.trim());
                recorder.check('git itself lists the new worktree', listed.includes('Audit-WT'), listed.trim());

                const rows = await page.eval(
                    `JSON.stringify(Array.from(document.querySelectorAll('[data-testid^="inspector-assoc-"]'))
                        .filter(el => !el.getAttribute('data-testid').startsWith('inspector-assoc-menu'))
                        .map(el => ({
                            worktree: el.getAttribute('data-worktree'),
                            status: el.querySelector('[data-testid="inspector-status-dot"]')?.getAttribute('data-status') ?? null,
                            indent: Math.round(el.getBoundingClientRect().x - el.closest('[data-testid="inspector-repos"]').getBoundingClientRect().x),
                            text: (el.innerText ?? '').replace(/\\n/g, ' ')
                        })))`
                );
                const parsed = JSON.parse(String(rows));
                recorder.note(`association rows: ${JSON.stringify(parsed)}`);
                recorder.check('both the main checkout and the worktree are listed', parsed.length === 2, String(parsed.length));
                const worktreeRow = parsed.find((entry) => entry.worktree === 'true');
                recorder.check('the worktree row is labelled by its branch', worktreeRow !== undefined && /Audit-WT/.test(String(worktreeRow.text)), JSON.stringify(worktreeRow));
                recorder.check(
                    'a fresh worktree reads as clean (green dot)',
                    worktreeRow?.status === 'clean',
                    String(worktreeRow?.status)
                );
                recorder.check(
                    'and it is indented under its parent repo (§WS-139)',
                    (worktreeRow?.indent ?? 0) >= 8,
                    `${String(worktreeRow?.indent)} px`
                );
                recorder.eyes('does the worktree row read as a child of the repo above it?');
            }
        },
        {
            id: 'workspace-create-worktree',
            expect:
                'The New Workspace form’s "Create git worktree" section creates the workspace AND a real git worktree in one go: the preview shows the sanitized path, Create runs `git worktree add`, the new workspace opens in the worktree, and its first pane’s cwd is that directory.',
            needsEyes: true,
            async run(recorder) {
                await page.click('[data-testid="sidebar-new-workspace"]');
                await sleep(400);
                await page.insertText('Worktree WS');
                await sleep(200);
                const hasToggle = await page.eval(
                    `document.querySelector('[data-testid="new-workspace-worktree-toggle"]') !== null`
                );
                recorder.check(
                    'the form offers "Create git worktree" now that a repo is registered',
                    hasToggle === true,
                    String(hasToggle)
                );
                if (hasToggle !== true) return;
                await page.click('[data-testid="new-workspace-worktree-toggle"]');
                await sleep(300);
                await page.click('[data-testid="new-workspace-worktree-name"]');
                await page.insertText('audit branch');
                await sleep(300);
                await recorder.shot(page, 'form');

                const preview = await page.eval(
                    `(document.querySelector('[data-testid="new-workspace-worktree-preview"]')?.innerText ?? '').replace(/\\n/g, ' | ')`
                );
                const expectedPath = `${sandbox.home}/nex/worktrees/repo/audit-branch`;
                recorder.note(`preview: ${String(preview)}`);
                recorder.check(
                    'the preview shows the sanitized worktree path',
                    String(preview).includes(expectedPath),
                    `${String(preview)} (expected ${expectedPath})`
                );
                recorder.check(
                    'and the branch it mirrors from the name',
                    String(preview).includes('branch: audit-branch'),
                    String(preview)
                );
                const updateMain = await page.eval(
                    `document.querySelector('[data-testid="new-workspace-worktree-update-main"]') !== null`
                );
                recorder.check('the "Update main first" checkbox is offered', updateMain === true, String(updateMain));

                const before = await cli.json(['workspace', 'list', '--json']);
                await page.click('[data-testid="new-workspace-submit"]');
                await sleep(4000);
                await recorder.shot(page);

                const after = await cli.json(['workspace', 'list', '--json']);
                recorder.check('a workspace was created', after.length === before.length + 1, `${String(before.length)} → ${String(after.length)}`);
                const created = after.find((workspace) => workspace.name === 'Worktree WS');
                recorder.check('it carries the name that was typed', created !== undefined, after.map((w) => w.name).join(', '));
                recorder.check('the worktree exists on disk', fs.existsSync(expectedPath), expectedPath);
                const panes = await cli.json(['pane', 'list', '--json']);
                const firstPane = panes.find((pane) => pane.workspace_id === created?.id);
                recorder.check(
                    'its first pane opened IN the worktree',
                    firstPane !== undefined && String(firstPane.working_directory) === expectedPath,
                    `${String(firstPane?.working_directory)} vs ${expectedPath}`
                );
                let listed = '';
                try {
                    listed = execFileSync('git', ['branch', '--list', 'audit-branch'], { cwd: repo, encoding: 'utf8' });
                } catch (error) {
                    listed = String(error.message ?? error);
                }
                recorder.check('git created the branch it previewed', listed.includes('audit-branch'), listed.trim());
                recorder.eyes('did the window follow the new workspace, and does its pane show a live prompt?');
            }
        },
        {
            id: 'sidebar-resize',
            expect:
                'The sidebar’s invisible edge handle resizes it, clamped to 180–300 px from a 220 px default, and the width survives a drag past both limits.',
            needsEyes: true,
            async run(recorder) {
                const widthOf = () =>
                    page.eval(
                        `(() => { const el = document.querySelector('[data-testid="sidebar-resizer"]');
                          return el === null ? null : Math.round(el.parentElement.getBoundingClientRect().width); })()`
                    );
                const start = await widthOf();
                recorder.check('the sidebar starts at the shipped 220 pt default', start === 220, `${String(start)} px`);

                const handle = await page.box('[data-testid="sidebar-resizer"]');
                recorder.check('the drag handle is present and hittable', handle !== null && handle.width > 0, JSON.stringify(handle));
                if (handle === null) return;
                const cursor = await page.eval(
                    `getComputedStyle(document.querySelector('[data-testid="sidebar-resizer"]')).cursor`
                );
                recorder.check('it shows a horizontal resize cursor', String(cursor).includes('resize'), String(cursor));

                await page.drag(handle.cx, handle.cy, handle.cx + 60, handle.cy);
                await sleep(400);
                const widened = await widthOf();
                await recorder.shot(page, 'widened');
                recorder.check('dragging right widens it', widened > start, `${String(start)} → ${String(widened)}`);

                await page.drag(handle.cx + 60, handle.cy, handle.cx + 600, handle.cy);
                await sleep(400);
                const clampedMax = await widthOf();
                recorder.check('and it clamps at 300', clampedMax === 300, `${String(clampedMax)} px`);

                const wide = await page.box('[data-testid="sidebar-resizer"]');
                await page.drag(wide.cx, wide.cy, wide.cx - 600, wide.cy);
                await sleep(400);
                const clampedMin = await widthOf();
                await recorder.shot(page, 'narrowed');
                recorder.check('and at 180 on the way back', clampedMin === 180, `${String(clampedMin)} px`);

                // Leave it at the default so later screenshots look like the shipped app.
                const narrow = await page.box('[data-testid="sidebar-resizer"]');
                await page.drag(narrow.cx, narrow.cy, narrow.cx + 40, narrow.cy);
                await sleep(400);
                recorder.note(`final width: ${String(await widthOf())} px`);
                recorder.eyes('at 180 px, are the rows still readable — name, badge, labels not overlapping?');
            }
        },
        {
            id: 'bulk-workspace-ops',
            expect:
                'Selecting two workspaces and right-clicking one swaps the whole menu for the bulk variant: "N workspaces selected", Colour N, Label N with a tri-state, Group N, Move N, Delete N. Colour and Label each land on BOTH workspaces in one command.',
            needsEyes: true,
            async run(recorder) {
                let workspaces = await cli.json(['workspace', 'list', '--json']);
                // Self-provisioning, so the step stands alone under `--only`.
                if (workspaces.length < 2) {
                    await cli.ok(['workspace', 'create', '--name', 'Bulk Two']);
                    await sleep(1500);
                    workspaces = await cli.json(['workspace', 'list', '--json']);
                }
                recorder.check('the audit has at least two workspaces to select', workspaces.length >= 2, String(workspaces.length));
                if (workspaces.length < 2) return;
                const [first, second] = workspaces;

                // Seed a label preset the way a user would: the CLI back-fills one on `--add`.
                await cli.ok(['workspace', 'label', first.id, '--add', 'audit-label']);
                await sleep(500);

                const rowBox = async (id) =>
                    await page.box(`[data-workspace-id="${id}"]`);
                const boxA = await rowBox(first.id);
                const boxB = await rowBox(second.id);
                recorder.check('both rows are on screen', boxA !== null && boxB !== null, `${JSON.stringify(boxA)} ${JSON.stringify(boxB)}`);
                if (boxA === null || boxB === null) return;

                // ⌘-click toggles selection, the way the shipped sidebar does.
                await page.clickAt(boxA.cx, boxA.cy, { modifiers: MOD.meta });
                await sleep(200);
                await page.clickAt(boxB.cx, boxB.cy, { modifiers: MOD.meta });
                await sleep(300);
                const header = await page.eval(
                    `(document.querySelector('[data-testid="selection-header"]')?.innerText ?? '').replace(/\\n/g, ' ')`
                );
                recorder.check('the selection header counts two', String(header).includes('2 selected'), String(header));

                await page.clickAt(boxA.cx, boxA.cy, { button: 'right' });
                await sleep(400);
                await recorder.shot(page, 'menu');
                const items = await page.eval(
                    `JSON.stringify([...new Set(Array.from(document.querySelectorAll('[data-testid="context-menu"] [role="menuitem"], [data-testid="context-menu"] > div > div'))
                        .map(el => (el.textContent ?? '').trim().replace('▸', '')).filter(Boolean))])`
                );
                const labels = JSON.parse(String(items));
                recorder.note(`bulk menu: ${labels.join(' / ')}`);
                recorder.check('it is headed by the selection count', labels.some((label) => label === '2 workspaces selected'), labels.join(' / '));
                for (const expected of ['Color 2 Workspaces', 'Label 2 Workspaces', 'Group 2 Workspaces…', 'Delete 2 Workspaces…']) {
                    recorder.check(`the menu offers "${expected}"`, labels.some((label) => label.startsWith(expected.replace('…', ''))), labels.join(' / '));
                }

                /**
                 * Submenus open on HOVER, so they need a real pointer: React derives
                 * `onMouseEnter` from Chromium's own `mouseover`, which a synthesized DOM event
                 * does not produce. Both helpers therefore drive `Input.dispatchMouseEvent`.
                 */
                const hoverMenuItem = async (id) => {
                    const box = await page.box(`[data-menu-item="${id}"]`);
                    if (box === null) throw new Error(`no menu item ${id}`);
                    await page.mouse('mouseMoved', box.cx, box.cy, { button: 'none', buttons: 0 });
                    await sleep(400);
                };
                const clickSubmenuItem = async (needle) => {
                    const raw = await page.eval(
                        `(() => {
                            const el = Array.from(document.querySelectorAll('[data-testid="context-submenu"] [role="menuitem"]'))
                                .find(node => (node.textContent ?? '').includes(${JSON.stringify(needle)}));
                            if (el === undefined) return null;
                            const r = el.getBoundingClientRect();
                            return JSON.stringify({ cx: r.x + r.width / 2, cy: r.y + r.height / 2 });
                        })()`
                    );
                    if (typeof raw !== 'string') throw new Error(`no submenu item matching ${needle}`);
                    const point = JSON.parse(raw);
                    await page.clickAt(point.cx, point.cy);
                    await sleep(900);
                };

                // Colour N: one command, both workspaces.
                await hoverMenuItem('bulk-color');
                await clickSubmenuItem('purple');
                const recoloured = await cli.json(['workspace', 'list', '--json']);
                const colours = [first.id, second.id].map(
                    (id) => recoloured.find((workspace) => workspace.id === id)?.color
                );
                recorder.check('both selected workspaces turned purple', colours.every((colour) => colour === 'purple'), JSON.stringify(colours));

                // Label N: the tri-state row applies to every selected workspace.
                await page.clickAt(boxA.cx, boxA.cy, { button: 'right' });
                await sleep(400);
                await hoverMenuItem('bulk-labels');
                const triState = await page.eval(
                    `JSON.stringify(Array.from(document.querySelectorAll('[data-testid="context-submenu"] [role="menuitem"]'))
                        .map(el => (el.textContent ?? '').trim()))`
                );
                recorder.note(`label submenu: ${String(triState)}`);
                recorder.check(
                    'the label applied to only one of the two shows the mixed dash',
                    String(triState).includes('–audit-label'),
                    String(triState)
                );
                await recorder.shot(page, 'labels');
                await clickSubmenuItem('audit-label');
                const labelled = await cli.json(['workspace', 'list', '--json']);
                const applied = [first.id, second.id].map((id) =>
                    (labelled.find((workspace) => workspace.id === id)?.labels ?? []).includes('audit-label')
                );
                recorder.check('the label landed on BOTH workspaces', applied.every(Boolean), JSON.stringify(applied));
                await recorder.shot(page);

                // Clear the selection and go back to the first workspace, so the steps that
                // follow still find the pane they were photographing.
                await page.clickAt(boxA.cx, boxA.cy, { modifiers: MOD.meta });
                await page.clickAt(boxB.cx, boxB.cy, { modifiers: MOD.meta });
                await sleep(200);
                const home = await page.box(`[data-workspace-id="${String(first.id)}"]`);
                if (home !== null) await page.clickAt(home.cx, home.cy);
                await sleep(1200);
                await page.click('[data-testid="toggle-inspector"]');
                await sleep(400);
                recorder.eyes('does the bulk menu read as a different menu, with the count line at the top?');
            }
        },

        // ── pane UX: the context menu, search, reopen, scratchpad, ⌘W ───────────────
        {
            id: 'pane-context-menu',
            expect:
                'Right-clicking a pane header opens Nex’s own menu (not the browser’s) with Rename…, Close Pane, Split Right, Split Down, New Web Pane, Status ▸, Move to Workspace ▸, Open in Finder and Copy Working Directory — and the Status submenu checkmarks the pane’s current value.',
            needsEyes: true,
            async run(recorder) {
                // Address the widest SHELL pane on screen — see `widestShellPane` for why every
                // one of the three qualifiers is load-bearing. Everything below this step drives
                // `state.firstPane` as a terminal (⌘F, ⇧⌘T, ⇧⌘N, `pane capture`, the OSC 7 `cd`).
                const target = await widestShellPane(page, cli);
                state.firstPane = target?.id ?? (await domPaneIDs(page))[0] ?? state.firstPane;
                recorder.note(
                    `target pane: ${String(state.firstPane)} (shell, ${String(Math.round(target?.width ?? 0))}px wide)`
                );
                await page.rightClick(`[data-testid="pane-header-${state.firstPane}"]`);
                await sleep(300);
                await recorder.shot(page);

                const menu = await page.eval(
                    `(() => {
                        const root = document.querySelector('[data-testid="context-menu"]');
                        if (root === null) return null;
                        return Array.from(root.querySelectorAll('[data-menu-item]')).map(el => ({
                            id: el.getAttribute('data-menu-item'),
                            label: (el.querySelector('span.flex-1')?.textContent ?? '').trim()
                        }));
                    })()`
                );
                recorder.note(`pane menu: ${JSON.stringify(menu)}`);
                recorder.check('the pane header opens Nex’s own context menu', menu !== null);
                const labels = (menu ?? []).map((item) => item.label);
                for (const wanted of [
                    'Rename…',
                    'Close Pane',
                    'Split Right',
                    'Split Down',
                    'New Web Pane',
                    'Status',
                    'Copy Working Directory'
                ]) {
                    recorder.check(`the menu offers "${wanted}"`, labels.includes(wanted), labels.join(' / '));
                }
                // The Electron shell is the only client that can reveal a path, and the audit
                // runs inside it — in a plain browser the item is deliberately absent.
                recorder.check(
                    '"Open in Finder" is offered inside the Electron shell',
                    labels.includes('Open in Finder'),
                    labels.join(' / ')
                );

                const statusBox = await page.box('[data-menu-item="status"]');
                recorder.check('a shell pane offers the Status submenu', statusBox !== null);
                if (statusBox !== null) {
                    // HOVER, not click: `ContextMenu` opens a submenu on mouseenter and the
                    // click handler TOGGLES it, so clicking a submenu row opens then closes it.
                    await page.mouse('mouseMoved', statusBox.cx, statusBox.cy, { button: 'none' });
                    await sleep(350);
                    await recorder.shot(page, 'status-submenu');
                    const submenu = await page.eval(
                        `(() => {
                            const root = document.querySelector('[data-testid="context-submenu"]');
                            if (root === null) return null;
                            return Array.from(root.querySelectorAll('[data-menu-item]')).map(el => ({
                                id: el.getAttribute('data-menu-item'),
                                text: (el.textContent ?? '').trim()
                            }));
                        })()`
                    );
                    recorder.note(`status submenu: ${JSON.stringify(submenu)}`);
                    recorder.check(
                        'the Status submenu offers Idle / Running / Awaiting Input',
                        (submenu ?? []).length === 3,
                        JSON.stringify(submenu)
                    );
                    const checked = (submenu ?? []).filter((row) => row.text.startsWith('✓'));
                    recorder.check(
                        'exactly one status is checkmarked (the pane’s current one)',
                        checked.length === 1,
                        JSON.stringify(checked)
                    );

                    // Drive the manual override and read it back off the wire (TERM-107/AGNT-057).
                    //
                    // Retried once: the submenu opens on mouseenter and the row's rect is read
                    // the moment it mounts, so a click can occasionally land on the frame before
                    // it settles. One re-hover-and-click distinguishes "the override does not
                    // work" from "the pointer arrived a frame early", which is the difference
                    // between a finding and a flake.
                    let status = null;
                    for (let attempt = 0; attempt < 2 && status !== 'running'; attempt++) {
                        if (attempt > 0) {
                            await page.rightClick(`[data-testid="pane-header-${state.firstPane}"]`);
                            await sleep(400);
                            const retryBox = await page.box('[data-menu-item="status"]');
                            if (retryBox === null) break;
                            await page.mouse('mouseMoved', retryBox.cx, retryBox.cy, { button: 'none' });
                            await sleep(500);
                        }
                        await clickMenuItem(page, 'Running');
                        await sleep(900);
                        const panes = await cli.json(['pane', 'list', '--json']);
                        status = panes.find((pane) => pane.id === state.firstPane)?.status ?? null;
                    }
                    await recorder.shot(page, 'status-running');
                    recorder.check(
                        'Status ▸ Running reaches the daemon',
                        status === 'running',
                        JSON.stringify({ status })
                    );
                    // Put it back, so later steps see the idle pane they expect.
                    await page.rightClick(`[data-testid="pane-header-${state.firstPane}"]`);
                    await sleep(300);
                    const again = await page.box('[data-menu-item="status"]');
                    if (again !== null) {
                        await page.mouse('mouseMoved', again.cx, again.cy, { button: 'none' });
                        await sleep(350);
                        await clickMenuItem(page, 'Idle');
                        await sleep(700);
                    }
                }
                await page.key('Escape');
                await sleep(200);
                recorder.eyes('menu spacing, the submenu arrow, the checkmark column, and the destructive red on Close Pane');
            }
        },
        {
            id: 'terminal-search',
            expect:
                '⌘F over a terminal opens a floating search bar at the pane’s top-right. Typing a marker printed into the scrollback shows a live match count; Return jumps to a match and the counter reads "1/N"; Escape closes the bar.',
            needsEyes: true,
            async run(recorder) {
                const paneID = state.firstPane;
                await focusPaneBody(page, paneID);
                // A marker with a known number of occurrences, then enough filler that the
                // matches are scrollback hits rather than text already on screen.
                const marker = `SEARCHME${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
                await runInTerminal(page, `for i in 1 2 3; do printf '%s hit %s\\n' ${marker} $i; done`, {
                    settleMs: 900
                });
                await runInTerminal(page, 'printf "filler\\n%.0s" $(seq 1 40)', { settleMs: 1000 });

                await page.key('KeyF', { modifiers: MOD.meta });
                await sleep(800);
                await recorder.shot(page, 'bar-open');
                const opened = await page.eval(
                    `document.querySelector('[data-testid="pane-search-${paneID}"]') !== null`
                );
                recorder.check('⌘F opened the search bar over the terminal pane', opened === true);
                if (opened !== true) return;

                await page.click(`[data-testid="pane-search-input-${paneID}"]`);
                await page.insertText(marker);
                await sleep(1000);
                await recorder.shot(page, 'counted');
                const counted = await page.eval(
                    `(() => {
                        const bar = document.querySelector('[data-testid="pane-search-${paneID}"]');
                        const count = document.querySelector('[data-testid="pane-search-count-${paneID}"]');
                        return { total: bar?.getAttribute('data-search-total') ?? null,
                                 selected: bar?.getAttribute('data-search-selected') ?? null,
                                 text: (count?.textContent ?? '').trim() };
                    })()`
                );
                recorder.note(`search counts: ${JSON.stringify(counted)}`);
                recorder.check(
                    'the daemon found the marker in the scrollback',
                    Number(counted.total ?? '0') > 0,
                    `total=${String(counted.total)}`
                );
                recorder.check(
                    'the counter reads "-/N" before anything is selected',
                    counted.text === `-/${String(counted.total)}`,
                    counted.text
                );

                await page.key('Enter');
                await sleep(900);
                await recorder.shot(page, 'first-match');
                const stepped = await page.eval(
                    `(() => {
                        const bar = document.querySelector('[data-testid="pane-search-${paneID}"]');
                        const count = document.querySelector('[data-testid="pane-search-count-${paneID}"]');
                        return { selected: bar?.getAttribute('data-search-selected') ?? null,
                                 text: (count?.textContent ?? '').trim() };
                    })()`
                );
                recorder.note(`after Return: ${JSON.stringify(stepped)}`);
                recorder.check(
                    'Return selects a match and the counter becomes 1-based',
                    stepped.text === `1/${String(counted.total)}`,
                    stepped.text
                );

                await page.key('Escape');
                await sleep(600);
                await recorder.shot(page, 'closed');
                const closed = await page.eval(
                    `document.querySelector('[data-testid="pane-search-${paneID}"]') === null`
                );
                recorder.check('Escape closes the bar', closed === true);
                recorder.eyes(
                    'is the bar legible over the terminal, is the counter inside the field, and did the viewport scroll to the highlighted match?'
                );
            }
        },
        {
            id: 'reopen-closed-pane',
            expect:
                'Closing a named pane and pressing ⇧⌘T brings it back: a NEW pane carrying the closed one’s label and working directory, split off the focused pane.',
            needsEyes: true,
            async run(recorder) {
                const created = await cli.json([
                    'pane',
                    'split',
                    '--target',
                    state.firstPane,
                    '--name',
                    'undo-me',
                    '--json'
                ]);
                await sleep(2200);
                const born = String(created.pane_id);
                recorder.note(`created ${born} labelled undo-me`);

                await cli.ok(['pane', 'close', '--target', born]);
                await sleep(1400);
                await recorder.shot(page, 'after-close');
                const afterClose = await cli.json(['pane', 'list', '--json']);
                recorder.check(
                    'the pane is gone',
                    afterClose.every((pane) => pane.id !== born),
                    afterClose.map((pane) => pane.label ?? pane.type).join(', ')
                );

                // The keystroke has to reach the client, so give the window focus first.
                await focusPaneBody(page, state.firstPane);
                await page.key('KeyT', { modifiers: MOD.meta | MOD.shift });
                await sleep(2500);
                await recorder.shot(page);

                const afterReopen = await cli.json(['pane', 'list', '--json']);
                const restored = afterReopen.find((pane) => pane.label === 'undo-me');
                recorder.note(
                    `panes after ⇧⌘T: ${afterReopen.map((pane) => `${pane.id.slice(0, 8)}:${pane.label ?? pane.type}`).join(', ')}`
                );
                recorder.check('⇧⌘T restored a pane carrying the closed pane’s label', restored !== undefined);
                if (restored !== undefined) {
                    recorder.check(
                        'and it is a NEW pane id (a restore, not an un-delete)',
                        restored.id !== born,
                        `${born} → ${String(restored.id)}`
                    );
                    recorder.check(
                        'with the closed pane’s working directory',
                        restored.working_directory === afterClose[0]?.working_directory,
                        String(restored.working_directory)
                    );
                    await cli.ok(['pane', 'close', '--target', restored.id]);
                    await sleep(1000);
                }
                recorder.eyes('did the restored pane come up with a live prompt, and does its label chip read "undo-me"?');
            }
        },
        {
            id: 'scratchpad-create',
            expect:
                '⇧⌘N creates a "Scratchpad" pane, focused and already in edit mode, split off the focused pane.',
            needsEyes: true,
            async run(recorder) {
                const before = await cli.json(['pane', 'list', '--json']);
                await focusPaneBody(page, state.firstPane);
                await page.key('KeyN', { modifiers: MOD.meta | MOD.shift });
                await sleep(2200);
                await recorder.shot(page);

                const after = await cli.json(['pane', 'list', '--json']);
                const scratch = after.find((pane) => pane.type === 'scratchpad');
                recorder.check('a scratchpad pane exists', scratch !== undefined, after.map((pane) => pane.type).join(', '));
                recorder.check(
                    'and it is the only new pane',
                    after.length === before.length + 1,
                    `${String(before.length)} → ${String(after.length)}`
                );
                if (scratch !== undefined) {
                    const header = await page.eval(
                        `(document.querySelector('[data-testid="pane-title-${scratch.id}"]')?.textContent ?? '').trim()`
                    );
                    recorder.check('the header titles it "Scratchpad"', header === 'Scratchpad', String(header));
                    const editable = await page.eval(
                        `document.querySelector('[data-pane-id="${scratch.id}"] textarea') !== null`
                    );
                    recorder.check('it opens in edit mode (an editable body)', editable === true);
                    await cli.ok(['pane', 'close', '--target', scratch.id]);
                    await sleep(1000);
                }
                recorder.eyes('does the scratchpad read as a note pane — glyph, title, caret in the editor?');
            }
        },
        {
            id: 'last-pane-close-deletes-workspace',
            expect:
                '⌘W on the LAST pane of a workspace deletes the workspace rather than leaving an empty one behind; with no running agents, nothing is asked first.',
            needsEyes: true,
            async run(recorder) {
                const created = await cli.json(['workspace', 'create', '--name', 'ephemeral', '--json']);
                await sleep(2000);
                const workspaceID = String(created.workspace_id);
                recorder.note(`created workspace ${workspaceID}`);

                // Switch to it in the UI: ⌘W acts on the workspace THIS client is looking at.
                const row = await page.box(`[data-workspace-id="${workspaceID}"]`);
                recorder.check('the new workspace has a sidebar row', row !== null);
                if (row === null) return;
                await page.clickAt(row.cx, row.cy);
                await sleep(2000);
                await recorder.shot(page, 'before');

                const panesBefore = await cli.json(['pane', 'list', '--workspace', workspaceID, '--json']);
                recorder.check('it has exactly one pane', panesBefore.length === 1, String(panesBefore.length));
                if (panesBefore.length !== 1) return;

                await focusPaneBody(page, String(panesBefore[0].id));
                await page.key('KeyW', { modifiers: MOD.meta });
                await sleep(2500);
                await recorder.shot(page, 'after');

                const gate = await page.eval(
                    `document.querySelector('[data-testid="agent-delete-gate"]') !== null`
                );
                recorder.check('no confirmation is asked for an idle workspace', gate === false);
                const workspaces = await cli.json(['workspace', 'list', '--json']);
                recorder.check(
                    'the workspace is gone, not left empty',
                    workspaces.every((workspace) => workspace.id !== workspaceID),
                    workspaces.map((workspace) => workspace.name).join(', ')
                );
                const empty = await page.eval(
                    `document.querySelector('[data-testid="pane-grid-empty"]') !== null`
                );
                recorder.check('and the window is not left on the empty-grid placeholder', empty === false);
                recorder.eyes('did the sidebar row disappear and the window land on another workspace with live panes?');
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

        // ── file opening, $EDITOR, Help, the ••• menu (gaps #9/#15/#24/#25) ─────────
        {
            id: 'open-file-dialog',
            expect:
                '⌘O asks the Electron shell for a native open panel over the daemon (the shell has no preload); the chosen path comes back as an `open` command and a markdown pane appears. The panel itself is an OS window CDP cannot click, so the harness scripts its ANSWER and the rest of the round trip runs for real.',
            needsEyes: true,
            async run(recorder) {
                const target = path.join(work, 'AUDIT.md');
                const answerFile = path.join(sandbox.root, 'open-file-answer.txt');
                fs.writeFileSync(answerFile, `${target}\n`);

                const before = await cli.json(['pane', 'list', '--json']);
                // Whatever the LIVE map has on `open_file` — earlier steps rebind keys through
                // Settings, and a hard-coded ⌘O would then be testing the wrong keystroke.
                const bound = await pressBoundAction(page, 'open_file');
                recorder.note(`open_file is bound to ${bound.display === '' ? '(nothing)' : bound.display}`);
                recorder.check('an "open file" shortcut is bound at all', bound.key !== null, bound.display);
                await sleep(2500);
                await recorder.shot(page);

                const after = await cli.json(['pane', 'list', '--json']);
                const created = after.filter(
                    (pane) => !before.some((old) => old.id === pane.id)
                );
                recorder.note(`panes ${String(before.length)} → ${String(after.length)}; new: ${JSON.stringify(created.map((pane) => ({ id: pane.id, type: pane.type, cwd: pane.cwd })))}`);
                recorder.check('⌘O created exactly one pane', created.length === 1, `${String(created.length)} new`);
                recorder.check(
                    'and it is a markdown pane for the chosen file',
                    created[0]?.type === 'markdown',
                    created[0]?.type ?? 'none'
                );
                recorder.check(
                    'the shell consumed the scripted answer (proving it ran the dialog path)',
                    !fs.existsSync(answerFile),
                    fs.existsSync(answerFile) ? 'answer file still present' : 'consumed'
                );
                if (created[0] !== undefined) {
                    const inDom = await page.eval(
                        `document.querySelector('[data-testid="pane-header-${created[0].id}"]') !== null`
                    );
                    recorder.check('the new pane is on screen', inDom === true);
                    state.openedByDialog = created[0].id;
                }
                recorder.eyes('does the window show a rendered markdown preview for AUDIT.md, opened without touching the CLI?');
            }
        },
        {
            id: 'external-editor',
            expect:
                'The "$EDITOR" affordance on a markdown preview turns the pane into a terminal hosting the resolved editor (CONT-081). Quitting that process returns the pane to preview by itself (CONT-091), and ⌘E ends a live session the same way (CONT-090).',
            needsEyes: true,
            async run(recorder) {
                // Self-provisioning: `--only external-editor` opens its own markdown pane
                // rather than depending on whichever earlier step happened to run.
                let paneID = state.openedByDialog ?? state.mdPane;
                if (paneID === null || paneID === undefined) {
                    await cli.ok(['md', path.join(work, 'AUDIT.md')]);
                    await sleep(2200);
                    const panes = await cli.json(['pane', 'list', '--json']);
                    paneID = panes.find((pane) => pane.type === 'markdown')?.id ?? null;
                }
                if (paneID === null || paneID === undefined) {
                    recorder.check('a markdown pane to edit', false, 'no markdown pane available');
                    return;
                }
                const affordance = `[data-testid="open-external-editor-${paneID}"]`;
                const present = await page.eval(`document.querySelector('${affordance}') !== null`);
                recorder.check('the preview offers an "$EDITOR" affordance', present === true);
                if (present !== true) return;

                await page.click(affordance);
                await sleep(2600);
                await recorder.shot(page, 'hosted');

                const hosted = await page.eval(
                    `(() => {
                        const term = document.querySelector('[data-pane-id="${paneID}"][data-terminal-status]');
                        const frame = document.querySelector('[data-testid="content-iframe-${paneID}"]');
                        return { terminal: term === null ? 0 : 1, preview: frame === null ? 0 : 1,
                                 status: term?.getAttribute('data-terminal-status') ?? null };
                    })()`
                );
                recorder.note(`hosted-editor DOM: ${JSON.stringify(hosted)}`);
                recorder.check('the preview was replaced by a terminal', (hosted?.terminal ?? 0) === 1, JSON.stringify(hosted));
                recorder.check('and the preview frame is gone, not stacked behind it', (hosted?.preview ?? 1) === 0, JSON.stringify(hosted));

                const panes = await cli.json(['pane', 'list', '--json']);
                const pane = panes.find((entry) => entry.id === paneID);
                recorder.check('the pane is STILL a markdown pane on the wire', pane?.type === 'markdown', pane?.type ?? 'gone');
                // The sync group admits shell panes only, so a hosted editor can never be
                // mirrored into (CONT-089's sibling rule).
                const sync = await cli.json(['pane', 'sync', 'status', '--json']).catch(() => null);
                recorder.note(`sync status while hosting: ${JSON.stringify(sync)}`);

                // CONT-091: end the editor process itself (ctrl-D into the PTY, a real
                // keystroke) and watch the pane come back on its own — nothing asked it to.
                await focusPaneBody(page, paneID);
                await page.key('KeyD', { modifiers: MOD.ctrl });
                await sleep(2600);
                await recorder.shot(page, 'editor-exited');
                const afterExit = await page.eval(
                    `(() => {
                        const term = document.querySelector('[data-pane-id="${paneID}"][data-terminal-status]');
                        const frame = document.querySelector('[data-testid="content-iframe-${paneID}"]');
                        return { terminal: term === null ? 0 : 1, preview: frame === null ? 0 : 1 };
                    })()`
                );
                recorder.note(`after the editor exited: ${JSON.stringify(afterExit)}`);
                recorder.check(
                    'the editor exiting returns the pane to preview (it does NOT close the pane)',
                    (afterExit?.preview ?? 0) === 1 && (afterExit?.terminal ?? 1) === 0,
                    JSON.stringify(afterExit)
                );
                const stillThere = (await cli.json(['pane', 'list', '--json'])).some((entry) => entry.id === paneID);
                recorder.check('the pane itself survived', stillThere);

                // CONT-090: ⌘E out of a LIVE session tears the surface down the same way.
                await page.waitFor(
                    `document.querySelector('[data-testid="open-external-editor-${paneID}"]') !== null`,
                    { timeoutMs: 15_000, label: 'the preview to come back' }
                );
                await page.click(affordance);
                await page.waitFor(
                    `document.querySelector('[data-pane-id="${paneID}"][data-terminal-status]') !== null`,
                    { timeoutMs: 15_000, label: 'the second editor session' }
                );
                await sleep(1200);
                await page.click(`[data-testid="pane-header-${paneID}"]`);
                await sleep(300);
                const editKey = await pressBoundAction(page, 'toggle_markdown_edit');
                recorder.note(`toggle_markdown_edit is bound to ${editKey.display === '' ? '(nothing)' : editKey.display}`);
                await sleep(2200);
                await recorder.shot(page, 'closed-with-cmd-e');
                const afterCmdE = await page.eval(
                    `(() => {
                        const term = document.querySelector('[data-pane-id="${paneID}"][data-terminal-status]');
                        const frame = document.querySelector('[data-testid="content-iframe-${paneID}"]');
                        return { terminal: term === null ? 0 : 1, preview: frame === null ? 0 : 1 };
                    })()`
                );
                recorder.note(`after ⌘E: ${JSON.stringify(afterCmdE)}`);
                recorder.check('⌘E ends a live editor session', (afterCmdE?.preview ?? 0) === 1, JSON.stringify(afterCmdE));
                recorder.eyes('did the pane visibly become a terminal running the editor (look for the NEX-AUDIT-EDITOR line), and a rendered preview again afterwards?');
            }
        },
        {
            id: 'cmd-click-path',
            expect:
                '⌘-clicking a `.md` path printed in a terminal opens it as a markdown pane (CONT-122 / TERM-052). The client turns the click into a CELL from the pane\u2019s own grid and the daemon reads the token there, because neither renderer exposes a word-under-cursor API.',
            needsEyes: true,
            async run(recorder) {
                // Self-provisioning, and specifically the WIDEST on-screen SHELL pane: earlier
                // steps leave markdown panes in the grid (only a terminal has cells to click),
                // and the absolute path printed below soft-wraps in a narrow one — the cell
                // under the click then holds a path FRAGMENT, which the daemon correctly
                // refuses to open.
                const shellPane = await widestShellPane(page, cli);
                const clickPane = shellPane?.id ?? null;
                if (clickPane === null) {
                    recorder.check('a terminal pane to click in', false, 'no visible shell pane');
                    return;
                }
                recorder.note(`click pane: ${clickPane} (${String(Math.round(shellPane.width))}px wide)`);
                state.firstPane = state.firstPane ?? clickPane;
                await focusPaneBody(page, clickPane);
                // ABSOLUTE paths on purpose. A relative token is resolved against the pane's
                // `workingDirectory`, which only follows the shell when it emits OSC 7 — `sh`
                // does not, so a relative `AUDIT.md` would correctly resolve to a file that is
                // not there and the daemon would (correctly) report `missing`. The relative
                // case is covered by `ws/desktop.test.ts`; what this step is proving is the
                // click → cell → token → pane path through real pixels.
                // CLEAR first. The click below aims a few rows down from the pane's TOP, which
                // is only where fresh output lands on an empty screen — and by this point in a
                // full run the pane has a screen full of earlier steps' output, so the click
                // would land on whatever happened to be there. Clearing makes the step's own
                // assumption true instead of hoping for it.
                await runInTerminal(page, `printf '\\033[2J\\033[3J\\033[H'`, { settleMs: 600 });
                await runInTerminal(
                    page,
                    `for i in 1 2 3 4 5 6 7 8; do printf '%s\\n' ${path.join(work, 'AUDIT.md')}; done`,
                    { settleMs: 1400 }
                );
                await recorder.shot(page, 'paths-on-screen');

                const before = await cli.json(['pane', 'list', '--json']);
                const box = await page.box(`[data-pane-id="${clickPane}"] [data-terminal-host]`);
                recorder.check('the terminal host has a box to click in', box !== null);
                if (box === null) return;

                // A few neighbouring x offsets: the separators between tokens are the only
                // cells that resolve to nothing, and one of these is inside a token.
                let created = [];
                let attempts = 0;
                // The output sits at the TOP of the pane (a fresh screen scrolls down from
                // there), so the click has to be a few rows in — not at the geometric centre,
                // which on a tall pane is blank screen with no token to read.
                const clickY = box.y + 60;
                const hit = await page.eval(
                    `(() => {
                        const el = document.elementFromPoint(${JSON.stringify(box.x + 30)}, ${JSON.stringify(clickY)});
                        const host = el?.closest?.('[data-terminal-host]') ?? null;
                        const paneRoot = host?.closest?.('[data-pane-id]') ?? null;
                        const r = host?.getBoundingClientRect?.() ?? null;
                        return { tag: el?.tagName ?? null, host: host !== null,
                                 paneID: paneRoot?.getAttribute('data-pane-id') ?? null,
                                 rect: r === null ? null : { w: Math.round(r.width), h: Math.round(r.height) } };
                    })()`
                );
                recorder.note(`click target: ${JSON.stringify(hit)}`);
                // Diagnostic: does a ⌘-click reach the app root at all, and what cell does the
                // client compute for it? A silent failure here is otherwise indistinguishable
                // from "the daemon found no token".
                await page.eval(
                    `(() => {
                        window.__nexClickProbe = [];
                        document.addEventListener('click', (event) => {
                            const host = event.target?.closest?.('[data-terminal-host]') ?? null;
                            window.__nexClickProbe.push({ meta: event.metaKey, button: event.button,
                                                          host: host !== null, x: event.clientX, y: event.clientY });
                        }, true);
                        return 'armed';
                    })()`
                );
                recorder.check('the click lands inside a terminal host', hit?.host === true, JSON.stringify(hit));
                outer: for (const dy of [0, 22, 44, 66]) {
                    for (const dx of [20, 26, 32, 38, 44]) {
                        attempts += 1;
                        await page.clickAt(box.x + dx, clickY + dy, { modifiers: MOD.meta });
                        await sleep(900);
                        const after = await cli.json(['pane', 'list', '--json']);
                        created = after.filter((pane) => !before.some((old) => old.id === pane.id));
                        if (created.length > 0) break outer;
                    }
                }
                const probe = await page.eval(`JSON.stringify(window.__nexClickProbe ?? [])`);
                recorder.note(`click probe: ${String(probe).slice(0, 500)}`);
                await recorder.shot(page, 'after-click');
                recorder.note(`⌘-click attempts: ${String(attempts)}; created: ${JSON.stringify(created.map((pane) => ({ id: pane.id, type: pane.type, label: pane.label })))}`);
                recorder.check('a ⌘-click on the path opened a pane', created.length >= 1, `${String(created.length)} after ${String(attempts)} clicks`);
                recorder.check(
                    'and it is a markdown pane named after the file',
                    created[0]?.type === 'markdown' && String(created[0]?.label ?? '').includes('AUDIT.md'),
                    `${String(created[0]?.type)} / ${String(created[0]?.label)}`
                );
                if (created[0] !== undefined) {
                    await cli.ok(['pane', 'close', '--target', created[0].id]);
                    await sleep(600);
                }
                recorder.eyes('did the path under the cursor open, rather than the click just moving the caret?');
            }
        },
        {
            id: 'drop-markdown',
            expect:
                'Dropping a .md path onto the window opens it as a markdown pane; a non-.md drop is refused with a message instead of silence (CONT-121 / APP-103 / TERM-041). The OS drag itself is not simulated — the event and the DataTransfer are real, the mouse gesture that would produce them is not.',
            needsEyes: true,
            async run(recorder) {
                const dropExpr = (uri) =>
                    `(() => {
                        const app = document.querySelector('[data-testid="nex-app"]');
                        if (app === null) return 'no-app';
                        const dt = new DataTransfer();
                        dt.setData('text/uri-list', ${JSON.stringify('')} + ${JSON.stringify(uri)});
                        for (const type of ['dragenter', 'dragover', 'drop']) {
                            app.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
                        }
                        return 'dispatched';
                    })()`;

                const before = await cli.json(['pane', 'list', '--json']);
                const ok = await page.eval(dropExpr(`file://${path.join(work, 'AUDIT.md')}`));
                recorder.note(`markdown drop: ${String(ok)}`);
                await sleep(2200);
                await recorder.shot(page, 'dropped');
                const after = await cli.json(['pane', 'list', '--json']);
                const created = after.filter((pane) => !before.some((old) => old.id === pane.id));
                recorder.check('the dropped .md opened a pane', created.length === 1, `${String(created.length)} new`);
                recorder.check('and it is a markdown pane', created[0]?.type === 'markdown', created[0]?.type ?? 'none');

                // A non-markdown drop must say why rather than doing nothing.
                const beforeReject = await cli.json(['pane', 'list', '--json']);
                await page.eval(dropExpr(`file://${path.join(work, 'alpha.txt')}`));
                await sleep(1200);
                await recorder.shot(page, 'refused');
                const toast = await page.eval(
                    `(document.body.innerText ?? '').includes('not a .md file')`
                );
                const afterReject = await cli.json(['pane', 'list', '--json']);
                recorder.check('a non-.md drop creates nothing', afterReject.length === beforeReject.length, `${String(beforeReject.length)} → ${String(afterReject.length)}`);
                recorder.check('and says why', toast === true);
                if (created[0] !== undefined) {
                    await cli.ok(['pane', 'close', '--target', created[0].id]);
                    await sleep(600);
                }
                recorder.eyes('is the refusal legible as a toast rather than a silent no-op?');
            }
        },
        {
            id: 'terminal-drop-and-paste',
            expect:
                'Dropping paths onto a TERMINAL types them shell-escaped instead of opening them (TERM-040), a drag carrying no path types nothing (TERM-041), and pasting an image writes it beside the other clipboard images and types that path (TERM-043).',
            needsEyes: true,
            async run(recorder) {
                // The WIDEST on-screen shell: this step reads back a ~70-character clipboard
                // path out of `pane capture`, and in a 33-column pane the shell's own readline
                // redraw splits and rotates it across rows so no substring match can find it.
                const shellPane = await widestShellPane(page, cli);
                if (shellPane === null) {
                    recorder.check('a terminal pane to drop onto', false, 'no visible shell pane');
                    return;
                }
                await focusPaneBody(page, shellPane.id);
                // Clear the screen AND the scrollback (`3J`) first. By this point in a full run
                // this pane has been re-wrapped at five window widths, and ledger L6 means the
                // daemon's VT holds the *fragments* of earlier prompts rather than the rows the
                // screen shows — so `pane capture` returns a shredded prompt line and the path
                // this step has to read back out of it arrives split across rows that are not
                // adjacent. A clean VT is the only way to make the read-back honest.
                await runInTerminal(page, `printf '\\033[2J\\033[3J\\033[H'`, { settleMs: 700 });

                // A path with a space in it, so the escaping is visible in the screenshot.
                const spaced = path.join(work, 'drop target.md');
                fs.writeFileSync(spaced, '# dropped\n');
                const dropOnTerminal = (uri) =>
                    `(() => {
                        const host = document.querySelector('[data-pane-id="${shellPane.id}"] [data-terminal-host]');
                        if (host === null) return 'no-host';
                        const dt = new DataTransfer();
                        ${uri === null ? "dt.setData('text/plain', 'just some words');" : `dt.setData('text/uri-list', ${JSON.stringify(uri)});`}
                        for (const type of ['dragenter', 'dragover', 'drop']) {
                            host.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
                        }
                        return 'dispatched';
                    })()`;

                const beforePanes = (await cli.json(['pane', 'list', '--json'])).length;
                await page.eval(dropOnTerminal(`file://${encodeURI(spaced)}`));
                await sleep(1600);
                await recorder.shot(page, 'dropped-onto-terminal');
                const typed = await cli.ok(['pane', 'capture', '--target', shellPane.id, '--lines', '6']);
                recorder.block('terminal after the drop', typed.slice(-300));
                recorder.check(
                    'the dropped path was TYPED, with its space escaped',
                    typed.includes('drop\\ target.md'),
                    typed.slice(-160)
                );
                const afterPanes = (await cli.json(['pane', 'list', '--json'])).length;
                recorder.check(
                    'and no markdown pane was opened for it (the terminal route wins)',
                    afterPanes === beforePanes,
                    `${String(beforePanes)} → ${String(afterPanes)}`
                );

                // TERM-041: a drag with no path types nothing at all.
                await page.eval(dropOnTerminal(null));
                await sleep(1200);
                const afterRefusal = await cli.ok(['pane', 'capture', '--target', shellPane.id, '--lines', '6']);
                recorder.check(
                    'a drag carrying no path types nothing',
                    !afterRefusal.includes('just some words'),
                    afterRefusal.slice(-160)
                );

                // Clear the composed line so the pasted path lands alone on a fresh prompt (the
                // dropped path runs as a bogus command, which is exactly what a real user would
                // see if they hit Return on it).
                await page.key('Enter');
                await sleep(900);

                // TERM-043: a pasted PNG, dispatched as a real ClipboardEvent with a real File.
                const pasteExpr = `(() => {
                    const host = document.querySelector('[data-pane-id="${shellPane.id}"] [data-terminal-host]');
                    if (host === null) return 'no-host';
                    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
                    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                    const file = new File([bytes], 'shot.png', { type: 'image/png' });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    host.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
                    return 'pasted';
                })()`;
                await page.eval(pasteExpr);
                await sleep(1800);
                await recorder.shot(page, 'pasted-image');
                // 20 rows, not 6: the pasted path is long enough to soft-wrap, and the earlier
                // drop in this same step leaves a failed command plus its error above it, so a
                // 6-row window can scroll the path's own first half out of the capture.
                const afterPaste = await cli.ok(['pane', 'capture', '--target', shellPane.id, '--lines', '20']);
                recorder.block('terminal after the paste', afterPaste.slice(-300));
                // Read the LAST line only: the path was pasted onto a fresh prompt, so this is
                // the whole path the daemon typed — including whichever temp root it chose.
                /**
                 * Match the FILE NAME, then resolve it on disk — not the whole absolute path.
                 *
                 * `pane capture` returns screen rows, and the path the daemon types is long
                 * enough to wrap behind this fixture's powerline prompt. Re-joining the rows
                 * recovers a soft wrap, but not a redraw: readline rewrites a wrapped input line
                 * as the user keeps typing, and the daemon's VT then holds the prompt row and the
                 * continuation in an order that no substring of the original path survives. Every
                 * full run has failed here for that reason and no other — the picture beside it
                 * shows the path on screen, correctly.
                 *
                 * So assert the two things the item is actually about: the daemon **typed a
                 * clipboard-image file name into the pane**, and that file **exists on the
                 * daemon's filesystem under `nex-clipboard-images`**. The uuid makes the name
                 * unique, so finding it on disk proves the directory as surely as reading the
                 * prefix off a wrapped row would.
                 */
                const flattened = afterPaste.trimEnd().split('\n').join('');
                const match = /clipboard-[0-9a-f]{8}-[0-9a-f-]+\.png/.exec(flattened);
                recorder.check(
                    'the pasted image typed a clipboard-image file name into the pane',
                    match !== null,
                    flattened.slice(-200)
                );
                if (match !== null) {
                    // Two candidate roots, because the DAEMON's temp directory is not this
                    // process's: the harness runs with the sandbox's `TMPDIR` (a `/var/folders`
                    // path) while the daemon resolves `/tmp`. The uuid in the name makes the
                    // search unambiguous either way.
                    const roots = [...new Set([os.tmpdir(), '/tmp'])];
                    const candidates = roots.map((root) => path.join(root, 'nex-clipboard-images', match[0]));
                    const written = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
                    recorder.check(
                        'and the file really exists on the daemon’s filesystem, under nex-clipboard-images',
                        written !== null,
                        written ?? `not at any of: ${candidates.join(' , ')}`
                    );
                    if (written !== null) fs.rmSync(written, { force: true });
                }
                recorder.eyes('does the terminal show the escaped path and then the clipboard-image path, both un-submitted?');
            }
        },
        {
            id: 'help-overlay',
            expect:
                '⌘? opens a Help overlay listing the app version, the keybindings read from the LIVE map (a rebound key shows its new trigger), the CLI pointers and the GitHub link. Escape closes it.',
            needsEyes: true,
            async run(recorder) {
                await page.key('Slash', { modifiers: MOD.meta | MOD.shift, key: '?' });
                await sleep(700);
                await recorder.shot(page);

                const help = await page.eval(
                    `(() => {
                        const root = document.querySelector('[data-testid="help-overlay"]');
                        if (root === null) return null;
                        const rows = Array.from(root.querySelectorAll('[data-help-action]')).map(el => ({
                            action: el.getAttribute('data-help-action'),
                            shortcut: el.querySelector('[data-help-shortcut]')?.getAttribute('data-help-shortcut') ?? ''
                        }));
                        return {
                            version: root.querySelector('[data-testid="help-version"]')?.textContent ?? '',
                            categories: Array.from(root.querySelectorAll('[data-help-category]')).map(el => el.getAttribute('data-help-category')),
                            rows: rows.length,
                            bound: rows.filter(r => r.shortcut !== '').length,
                            splitRight: rows.find(r => r.action === 'split_right')?.shortcut ?? '',
                            cli: (root.querySelector('[data-testid="help-cli"]')?.textContent ?? '').slice(0, 300),
                            github: root.querySelector('[data-testid="help-github"]')?.getAttribute('href') ?? ''
                        };
                    })()`
                );
                recorder.note(`help overlay: ${JSON.stringify(help)}`);
                recorder.check('⌘? opened the Help overlay', help !== null);
                if (help !== null) {
                    recorder.check('it names a version', /Version \S+/.test(help.version), help.version);
                    recorder.check('it lists the six binding categories', help.categories.length === 6, help.categories.join(' / '));
                    recorder.check('it lists bound shortcuts from the live map', help.bound >= 10, `${String(help.bound)} of ${String(help.rows)} bound`);
                    // The claim is "read from the live map", so the assertion is against the
                    // SOURCE of that map — the daemon's config file — not a fixed default: an
                    // earlier step may legitimately have rebound the key through Settings.
                    const configText = fs.readFileSync(sandbox.configPath, 'utf8');
                    const rebound = /^\s*keybind\s*=\s*(\S+)=split_right\s*$/m.exec(configText)?.[1] ?? null;
                    recorder.note(`config keybind for split_right: ${rebound ?? '(default)'}`);
                    recorder.check(
                        rebound === null
                            ? 'Split Right shows its default ⌘D'
                            : `Split Right shows the REBOUND trigger from the config file (${rebound})`,
                        rebound === null
                            ? help.splitRight === '⌘D'
                            : help.splitRight !== '' && help.splitRight !== '⌘D',
                        `${help.splitRight} vs config ${rebound ?? 'super+d'}`
                    );
                    recorder.check('it points at the CLI', help.cli.includes('nex doctor'), help.cli.slice(0, 120));
                    recorder.check('it links the repository', help.github.startsWith('https://github.com/'), help.github);
                }

                await page.key('Escape');
                await sleep(400);
                const gone = await page.eval(`document.querySelector('[data-testid="help-overlay"]') === null`);
                recorder.check('Escape closes it', gone === true);
                // ⌘? must not ALSO reach the focused terminal: `preventDefault` alone leaves the
                // engine's own keydown listener free to encode the character (run-H).
                const shellPaneID = (await cli.json(['pane', 'list', '--json'])).find(
                    (pane) => pane.type === 'shell'
                )?.id;
                const leaked =
                    shellPaneID === undefined
                        ? ''
                        : await cli.ok(['pane', 'capture', '--target', shellPaneID, '--lines', '4']).catch(() => '');
                recorder.note(`terminal tail after ⌘?: ${JSON.stringify(leaked.slice(-120))}`);
                recorder.check(
                    'the ⌘? keystroke did not leak a "?" into the focused terminal',
                    !/\$ *\?/.test(leaked),
                    leaked.slice(-80)
                );
                recorder.eyes('is the overlay legible — two columns, shortcuts right-aligned, nothing clipped?');
            }
        },
        {
            id: 'titlebar-menu',
            expect:
                'The ••• title-bar menu opens with Settings…, a Show/Hide Inspector item whose title reflects the current state, Nex Help, Install CLI + Check for Updates… (Electron only) and Restart Socket Server — and the restart really rebinds the control socket, so the CLI still answers afterwards.',
            needsEyes: true,
            async run(recorder) {
                await page.click('[data-testid="titlebar-menu-toggle"]');
                await sleep(400);
                await recorder.shot(page, 'open');

                const menu = await page.eval(
                    `(() => {
                        const root = document.querySelector('[data-testid="context-menu"]');
                        if (root === null) return null;
                        return Array.from(root.querySelectorAll('[data-menu-item]')).map(el => ({
                            id: el.getAttribute('data-menu-item'),
                            label: (el.querySelector('span.flex-1')?.textContent ?? '').trim()
                        }));
                    })()`
                );
                recorder.note(`••• menu: ${JSON.stringify(menu)}`);
                recorder.check('the ••• button opens a menu', menu !== null);
                const labels = (menu ?? []).map((item) => item.label);
                for (const wanted of ['Settings…', 'Nex Help', 'Install CLI', 'Check for Updates…', 'Restart Socket Server']) {
                    recorder.check(`the menu offers "${wanted}"`, labels.includes(wanted), labels.join(' / '));
                }
                recorder.check(
                    'the Inspector row reflects the current state',
                    labels.includes('Show Inspector') || labels.includes('Hide Inspector'),
                    labels.join(' / ')
                );

                // APP-054: rebind the control listeners, then prove the CLI still lands.
                const pingBefore = await cli.json(['doctor', '--json']).catch(() => null);
                await clickMenuItem(page, 'Restart Socket Server');
                await sleep(1500);
                await recorder.shot(page, 'restarted');
                const toast = await page.eval(
                    `(document.querySelector('[data-testid="toast-stack"]')?.textContent ?? document.body.textContent ?? '').slice(0, 400)`
                );
                recorder.note(`after restart: ${String(toast).slice(0, 200)}`);

                // The real proof: a fresh CLI process over the rebound listener.
                let answered = false;
                for (let attempt = 0; attempt < 6 && !answered; attempt++) {
                    const result = await cli.run(['pane', 'list', '--json']);
                    answered = result.code === 0;
                    if (!answered) await sleep(700);
                }
                recorder.check('the CLI still reaches the daemon after the socket restart', answered);
                recorder.note(`doctor before: ${pingBefore === null ? 'n/a' : 'ok'}`);
                recorder.eyes('did the menu look like a native menu (rows, separators, shortcut hints)?');
            }
        },
        // ── the daemon-survives story ───────────────────────────────────────────────
        // ── graft + repo registry (gaps #4 / #6 / #19) ───────────────────────────────
        //
        // The graft engine was compat-tested from the start; what these prove is the half a
        // person can actually reach: the inspector's toggle, its status dot, the interrupted-
        // graft banner, auto-detect reacting to a real `cd`, and Settings ▸ Repositories.
        // Every one of them acts on a REAL git worktree and checks the parent checkout on disk.
        {
            id: 'graft-toggle',
            expect:
                'The inspector\u2019s graft toggle mirrors a worktree into its parent checkout: the icon fills, a green "watching" dot appears in its corner, and the parent\u2019s working tree really does gain the worktree\u2019s file (with a recovery breadcrumb beside it). Toggling again restores the parent \u2014 the mirrored file goes, the parent\u2019s own uncommitted edit comes back out of the stash, and the breadcrumb is deleted. The toggle appears on worktree rows only, never on the main checkout (\u00a7GIT-046\u2026\u00a7GIT-049).',
            needsEyes: true,
            async run(recorder) {
                const wt = graftWorktree();
                await ensureInspector();
                const associationID = await ensureAssociation(recorder, wt);
                if (associationID === null) return;

                const rows = await inspectorRows();
                recorder.note(`association rows: ${JSON.stringify(rows)}`);
                recorder.check(
                    'the toggle is on the worktree row',
                    rows.some((row) => row.worktree === 'true' && row.hasGraft === true),
                    JSON.stringify(rows.map((row) => `${row.id.slice(0, 8)}:${row.worktree}:${String(row.hasGraft)}`))
                );
                recorder.check(
                    'and NOT on the main-checkout row (\u00a7GIT-049)',
                    rows.every((row) => row.worktree === 'true' || row.hasGraft === false),
                    JSON.stringify(rows.map((row) => `${row.worktree}:${String(row.hasGraft)}`))
                );
                const before = await page.eval(
                    `document.querySelector('[data-testid="graft-toggle-${associationID}"]')?.getAttribute('title') ?? ''`
                );
                recorder.check(
                    'its tooltip explains what graft does before you press it (\u00a7GIT-048)',
                    String(before).includes("tracked files into the parent repo's working tree"),
                    String(before).slice(0, 120)
                );
                await recorder.shot(page, 'before');

                await page.click(`[data-testid="graft-toggle-${associationID}"]`);
                await page.waitFor(
                    `document.querySelector('[data-testid="graft-dot-${associationID}"]') !== null`,
                    { timeoutMs: 20_000, label: 'the graft status dot' }
                );
                await page.waitFor(
                    `document.querySelector('[data-testid="graft-dot-${associationID}"]')?.getAttribute('data-status') === 'watching'`,
                    { timeoutMs: 30_000, label: 'the session to settle into watching' }
                );
                await sleep(400);
                await recorder.shot(page, 'grafting');

                const live = await page.eval(
                    `(() => {
                        const dot = document.querySelector('[data-testid="graft-dot-${associationID}"]');
                        const button = document.querySelector('[data-testid="graft-toggle-${associationID}"]');
                        if (dot === null || button === null) return null;
                        return JSON.stringify({
                            status: dot.getAttribute('data-status'),
                            color: getComputedStyle(dot).backgroundColor,
                            icon: button.querySelector('[data-icon]')?.getAttribute('data-icon') ?? '',
                            tooltip: button.getAttribute('title') ?? ''
                        });
                    })()`
                );
                const info = typeof live === 'string' ? JSON.parse(live) : null;
                recorder.note(`graft button while running: ${JSON.stringify(info)}`);
                recorder.check('the dot reads "watching" and is painted green', info?.status === 'watching' && /rgb\(95,\s*190,\s*137\)/.test(String(info?.color)), `${String(info?.status)} / ${String(info?.color)}`);
                recorder.check('the icon swapped to the filled variant (\u00a7GIT-046)', info?.icon === 'graft-active', String(info?.icon));
                recorder.check('the tooltip now names the branch it mirrors (\u00a7GIT-048)', String(info?.tooltip).startsWith('Mirroring graft-branch into the parent.'), String(info?.tooltip).slice(0, 120));

                const mirrored = path.join(repo, 'GRAFT-MARKER.md');
                recorder.check('the PARENT checkout really gained the worktree\u2019s file', fs.existsSync(mirrored), mirrored);
                recorder.check('a recovery breadcrumb sits in the parent\u2019s .git', fs.existsSync(breadcrumbPath()), breadcrumbPath());

                await page.click(`[data-testid="graft-toggle-${associationID}"]`);
                await page.waitFor(
                    `document.querySelector('[data-testid="graft-dot-${associationID}"]') === null`,
                    { timeoutMs: 30_000, label: 'the session to stop' }
                );
                await sleep(500);
                await recorder.shot(page, 'stopped');
                recorder.check('stopping removed the mirrored file from the parent', !fs.existsSync(mirrored));
                recorder.check('the breadcrumb was deleted', !fs.existsSync(breadcrumbPath()));
                recorder.check(
                    'the parent\u2019s own uncommitted edit came back out of the stash',
                    fs.readFileSync(path.join(repo, 'README.md'), 'utf8').includes('Edited line.'),
                    fs.readFileSync(path.join(repo, 'README.md'), 'utf8').trim().slice(0, 80)
                );
                recorder.eyes('is the dot legible at 5 px in the button\u2019s corner \u2014 and is the running state obvious at a glance?');
            }
        },
        {
            id: 'graft-swap-prompt',
            expect:
                'Only one worktree may graft into a parent repo at a time. Toggling a second one raises the "Already grafting into <repo>" confirmation naming both branches: "Keep existing" leaves the first running, and "Stop existing & swap" stops it and starts the second — which the parent’s working tree then proves by holding the SECOND worktree’s file (§GIT-038…§GIT-042, §GIT-050 / §WS-144).',
            needsEyes: true,
            async run(recorder) {
                const first = graftWorktree();
                const rival = rivalWorktree();
                await ensureInspector();
                const firstID = await ensureAssociation(recorder, first);
                const rivalID = await ensureAssociation(recorder, rival);
                if (firstID === null || rivalID === null) return;

                const dotOf = (id) => `document.querySelector('[data-testid="graft-dot-${id}"]')?.getAttribute('data-status') ?? 'none'`;
                const startAndWait = async (id) => {
                    await page.click(`[data-testid="graft-toggle-${id}"]`);
                    await page.waitFor(`(${dotOf(id)}) === 'watching'`, {
                        timeoutMs: 30_000,
                        label: `the ${id.slice(0, 8)} session to settle`
                    });
                };

                if ((await page.eval(dotOf(firstID))) !== 'watching') await startAndWait(firstID);
                const firstState = await page.eval(dotOf(firstID));
                if (firstState !== 'watching') {
                    recorder.note(
                        `first toggle tooltip: ${String(await page.eval(`document.querySelector('[data-testid="graft-toggle-${firstID}"]')?.getAttribute('title') ?? ''`))}`
                    );
                }
                recorder.check('the first worktree is grafting', firstState === 'watching', String(firstState));

                // The contested start: the engine refuses it, and the client turns that typed
                // refusal into a question rather than an error.
                await page.click(`[data-testid="graft-toggle-${rivalID}"]`);
                await page.waitFor(`document.querySelector('[data-testid="graft-swap-dialog"]') !== null`, {
                    timeoutMs: 30_000,
                    label: 'the swap confirmation'
                });
                await sleep(400);
                await recorder.shot(page, 'prompt');
                const dialog = await page.eval(
                    `(() => {
                        const el = document.querySelector('[data-testid="graft-swap-dialog"]');
                        if (el === null) return null;
                        return JSON.stringify({
                            title: el.getAttribute('aria-label') ?? '',
                            text: (el.innerText ?? '').replace(/\\n/g, ' | '),
                            confirm: el.querySelector('[data-testid="graft-swap-confirm"]')?.textContent ?? '',
                            keep: el.querySelector('[data-testid="graft-swap-keep"]')?.textContent ?? ''
                        });
                    })()`
                );
                const info = typeof dialog === 'string' ? JSON.parse(dialog) : null;
                recorder.note(`swap dialog: ${JSON.stringify(info)}`);
                recorder.check('it is titled after the contested repository', String(info?.title) === `Already grafting into ${path.basename(repo)}`, String(info?.title));
                recorder.check('it names the branch that already holds the repo', String(info?.text).includes('graft-branch'), String(info?.text));
                recorder.check('and the branch being offered instead', String(info?.text).includes('rival-branch'), String(info?.text));
                recorder.check('the destructive answer is "Stop existing & swap"', String(info?.confirm).includes('Stop existing'), String(info?.confirm));
                recorder.check('the safe answer is "Keep existing"', String(info?.keep).includes('Keep existing'), String(info?.keep));

                // Cancel leaves the world exactly as it was (§GIT-042).
                await page.click('[data-testid="graft-swap-keep"]');
                await page.waitFor(`document.querySelector('[data-testid="graft-swap-dialog"]') === null`, {
                    timeoutMs: 10_000,
                    label: 'the dialog to close'
                });
                await sleep(400);
                await recorder.shot(page, 'kept');
                recorder.check('"Keep existing" leaves the first graft running', (await page.eval(dotOf(firstID))) === 'watching');
                recorder.check('and starts nothing for the second', (await page.eval(dotOf(rivalID))) === 'none');
                recorder.check(
                    'the parent still holds the FIRST worktree’s file',
                    fs.existsSync(path.join(repo, 'GRAFT-MARKER.md')) && !fs.existsSync(path.join(repo, 'RIVAL-MARKER.md'))
                );

                // Now the swap itself: stop the incumbent, start the challenger, in that order.
                await page.click(`[data-testid="graft-toggle-${rivalID}"]`);
                await page.waitFor(`document.querySelector('[data-testid="graft-swap-dialog"]') !== null`, {
                    timeoutMs: 30_000,
                    label: 'the swap confirmation again'
                });
                await page.click('[data-testid="graft-swap-confirm"]');
                await page.waitFor(`(${dotOf(rivalID)}) === 'watching'`, {
                    timeoutMs: 40_000,
                    label: 'the swapped-in session'
                });
                await sleep(600);
                await recorder.shot(page, 'swapped');
                recorder.check('the second worktree is now the one grafting', (await page.eval(dotOf(rivalID))) === 'watching');
                recorder.check('and the first has stopped', (await page.eval(dotOf(firstID))) === 'none');
                recorder.check(
                    'the parent’s working tree now holds the SECOND worktree’s file instead',
                    fs.existsSync(path.join(repo, 'RIVAL-MARKER.md')) && !fs.existsSync(path.join(repo, 'GRAFT-MARKER.md')),
                    `rival=${String(fs.existsSync(path.join(repo, 'RIVAL-MARKER.md')))} first=${String(fs.existsSync(path.join(repo, 'GRAFT-MARKER.md')))}`
                );

                // Leave the fixture as it was found.
                await page.click(`[data-testid="graft-toggle-${rivalID}"]`);
                await page.waitFor(`(${dotOf(rivalID)}) === 'none'`, { timeoutMs: 30_000, label: 'the last session to stop' });
                recorder.check('stopping the swapped-in graft restores the parent', !fs.existsSync(path.join(repo, 'RIVAL-MARKER.md')));
                recorder.eyes('does the dialog make the choice obvious — which branch is losing, which is winning, and which button is destructive?');
            }
        },
        {
            id: 'graft-orphan-banner',
            expect:
                'A breadcrumb left by an interrupted graft surfaces as a yellow "Graft was interrupted" banner above the repo list, naming the parent repo\u2019s folder, with Restore and Dismiss. Restore replays the stop sequence and clears the breadcrumb; Dismiss deletes the breadcrumb only (\u00a7GIT-051 / \u00a7WS-145).',
            needsEyes: true,
            async run(recorder) {
                const wt = graftWorktree();
                await ensureInspector();
                const associationID = await ensureAssociation(recorder, wt);
                if (associationID === null) return;
                const worktreePath = await page.eval(
                    `document.querySelector('[data-testid="inspector-assoc-${associationID}"]')?.getAttribute('title') ?? ''`
                );
                recorder.note(`planting a breadcrumb for ${String(worktreePath)}`);

                const plant = () => {
                    fs.writeFileSync(
                        breadcrumbPath(),
                        JSON.stringify({
                            assocId: associationID,
                            branch: 'graft-branch',
                            preGraftBranch: 'main',
                            preGraftSha: null,
                            stashRef: null,
                            stashed: false,
                            version: 1,
                            worktreePath: String(worktreePath),
                            worktreePreGraftSha: null
                        })
                    );
                };
                // The daemon looks for breadcrumbs at boot and whenever a client asks; the
                // client asks when the inspector opens, so this is the gesture a user makes.
                const reopenInspector = async () => {
                    await page.click('[data-testid="toggle-inspector"]');
                    await sleep(400);
                    await page.click('[data-testid="toggle-inspector"]');
                    await sleep(900);
                };

                plant();
                await reopenInspector();
                await page.waitFor(
                    `document.querySelector('[data-testid^="graft-orphan-"]') !== null`,
                    { timeoutMs: 20_000, label: 'the interrupted-graft banner' }
                );
                await recorder.shot(page, 'banner');
                const banner = await page.eval(
                    `(() => {
                        const el = document.querySelector('[data-testid^="graft-orphan-"]');
                        if (el === null) return null;
                        const box = el.getBoundingClientRect();
                        const list = document.querySelector('[data-testid^="inspector-assoc-"]')?.getBoundingClientRect();
                        return JSON.stringify({
                            text: (el.innerText ?? '').replace(/\\n/g, ' | '),
                            background: getComputedStyle(el).backgroundColor,
                            aboveList: list === undefined ? null : box.top < list.top,
                            restore: el.querySelector('[data-testid^="graft-orphan-restore-"]') !== null,
                            dismiss: el.querySelector('[data-testid^="graft-orphan-dismiss-"]') !== null
                        });
                    })()`
                );
                const info = typeof banner === 'string' ? JSON.parse(banner) : null;
                recorder.note(`orphan banner: ${JSON.stringify(info)}`);
                recorder.check('it says the graft was interrupted', String(info?.text).includes('Graft was interrupted'), String(info?.text));
                recorder.check('it names the parent repo\u2019s folder', String(info?.text).includes(path.basename(repo)), String(info?.text));
                recorder.check('it is painted the warning yellow', /rgba?\(211,\s*163,\s*41/.test(String(info?.background)), String(info?.background));
                recorder.check('it sits ABOVE the repo list', info?.aboveList !== false, String(info?.aboveList));
                recorder.check('it offers both Restore and Dismiss', info?.restore === true && info?.dismiss === true, JSON.stringify(info));

                await page.click(`[data-testid="graft-orphan-restore-${associationID}"]`);
                await page.waitFor(
                    `document.querySelector('[data-testid^="graft-orphan-"]') === null`,
                    { timeoutMs: 30_000, label: 'the banner to clear after Restore' }
                );
                await sleep(400);
                await recorder.shot(page, 'restored');
                recorder.check('Restore replayed the stop sequence and cleared the breadcrumb', !fs.existsSync(breadcrumbPath()));
                // Restore checks the parent out clean; the fixture's dirty state is what the
                // rest of the audit reads, so it is put back exactly as `makeRepo` left it.
                redirtyRepo();

                plant();
                await reopenInspector();
                await page.waitFor(
                    `document.querySelector('[data-testid^="graft-orphan-"]') !== null`,
                    { timeoutMs: 20_000, label: 'the banner again' }
                );
                await page.click(`[data-testid="graft-orphan-dismiss-${associationID}"]`);
                await page.waitFor(
                    `document.querySelector('[data-testid^="graft-orphan-"]') === null`,
                    { timeoutMs: 20_000, label: 'the banner to clear after Dismiss' }
                );
                await sleep(300);
                await recorder.shot(page, 'dismissed');
                recorder.check('Dismiss deletes the breadcrumb', !fs.existsSync(breadcrumbPath()));
                recorder.check(
                    'and leaves the parent\u2019s working tree alone',
                    fs.readFileSync(path.join(repo, 'README.md'), 'utf8').includes('Edited line.')
                );
                recorder.eyes('does the banner read as a warning without shouting \u2014 and are Restore/Dismiss obviously the two answers?');
            }
        },
        {
            id: 'repo-autodetect',
            expect:
                'A pane that `cd`s into a git repository auto-links it to the workspace: the repo appears in the inspector\u2019s Repositories list within a second, registered as auto-discovered. Leaving it again auto-unlinks the association and garbage-collects the repo (\u00a7GIT-074\u2026\u00a7GIT-081).',
            needsEyes: true,
            async run(recorder) {
                const target = autoDetectRepo();
                await ensureInspector();
                // The inspector shows the ACTIVE workspace's associations, so the pane that
                // `cd`s has to be one of that workspace's own panes — `state.firstPane` may by
                // now belong to another workspace, and the row would never appear.
                const paneID = (await widestShellPane(page, cli))?.id ?? (await domPaneIDs(page))[0] ?? null;
                if (paneID === null) {
                    recorder.check('a terminal pane to cd in', false, 'none');
                    return;
                }
                // Clear whatever half-typed line the pane is carrying before sending a command
                // to it. Two earlier steps deliberately leave one — the drop step types a path
                // and does NOT submit it, the clipboard-image step likewise — and `pane send`
                // appends, so the `cd` would ride on the tail of a bogus command, fail, and emit
                // no OSC 7. Under `--only` the pane is pristine and this is a no-op, which is
                // exactly why the scoped run passed while the full run timed out here.
                await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
                await sleep(500);

                const before = await inspectorRows();
                recorder.note(`rows before: ${JSON.stringify(before.map((row) => row.text))}`);

                // A shell reports its directory with OSC 7; ghostty's shell integration emits
                // it on every `cd`. Nothing injects that integration in this port yet, so the
                // step emits the sequence the integration would — the DAEMON's half (debounce,
                // resolve, link, GC) is what is under test.
                await cli.ok([
                    'pane',
                    'send',
                    '--target',
                    paneID,
                    `cd ${target} && printf '\\033]7;file://%s%s\\007' "$(hostname)" "$PWD"`
                ]);
                await page.waitFor(
                    `Array.from(document.querySelectorAll('[data-testid^="inspector-assoc-"]')).some(el => (el.innerText ?? '').includes('autodetect-repo'))`,
                    { timeoutMs: 20_000, label: 'the auto-linked repository row' }
                );
                await sleep(500);
                await recorder.shot(page, 'linked');

                const panes = await cli.json(['pane', 'list', '--json']);
                const pane = panes.find((entry) => entry.id === paneID);
                recorder.check(
                    'the pane\u2019s working directory followed the shell (OSC 7)',
                    String(pane?.cwd ?? pane?.working_directory ?? '').includes('autodetect-repo'),
                    String(pane?.cwd ?? pane?.working_directory)
                );
                const after = await inspectorRows();
                recorder.check(
                    'the repository auto-linked into the workspace',
                    after.some((row) => row.text.includes('autodetect-repo')),
                    JSON.stringify(after.map((row) => row.text))
                );
                recorder.check(
                    'it is a main checkout, so it carries no graft toggle (\u00a7GIT-049)',
                    after.filter((row) => row.text.includes('autodetect-repo')).every((row) => row.hasGraft === false),
                    JSON.stringify(after.filter((row) => row.text.includes('autodetect-repo')))
                );

                await cli.ok([
                    'pane',
                    'send',
                    '--target',
                    paneID,
                    `cd ${work} && printf '\\033]7;file://%s%s\\007' "$(hostname)" "$PWD"`
                ]);
                // §GIT-080's debounce is a deliberate 5 s: a pane that steps out and back must
                // keep its association.
                await page.waitFor(
                    `!Array.from(document.querySelectorAll('[data-testid^="inspector-assoc-"]')).some(el => (el.innerText ?? '').includes('autodetect-repo'))`,
                    { timeoutMs: 25_000, label: 'the auto-unlink sweep' }
                );
                await sleep(400);
                await recorder.shot(page, 'unlinked');
                recorder.check('leaving the repository auto-unlinked it', true, 'row gone');
                recorder.eyes('did the row appear and disappear on its own, without the user touching the inspector?');
            }
        },
        {
            id: 'settings-repositories',
            expect:
                'Settings \u25b8 Repositories lists the registry (name, path, remote URL), filters it, adds a repository by path, removes one, and carries \u00a7GIT-074\u2019s "Auto-detect from pane directories" toggle \u2014 which writes `auto-detect-repos` into the config file.',
            needsEyes: true,
            async run(recorder) {
                const extra = autoDetectRepo();
                const open = await page.eval(`document.querySelector('${PAGE.settingsPanel}') !== null`);
                if (open !== true) {
                    await page.click(PAGE.settingsButton);
                    await sleep(800);
                }
                await page.click('[data-testid="settings-tab-button-repositories"]');
                await sleep(700);
                // Self-provisioning: under `--only` nothing has registered a repository yet,
                // so the fixture repo is added first and the list assertions below have
                // something real to read.
                const seeded = await page.eval(
                    `document.querySelectorAll('[data-testid^="repo-row-"]').length > 0`
                );
                if (seeded !== true) {
                    await page.click('[data-testid="repo-path"]');
                    await page.insertText(repo);
                    await page.click('[data-testid="repo-add"]');
                    await page.waitFor(`document.querySelectorAll('[data-testid^="repo-row-"]').length > 0`, {
                        timeoutMs: 20_000,
                        label: 'the seeded repository row'
                    });
                    await sleep(400);
                }
                await recorder.shot(page, 'tab');

                const rows = () =>
                    page.eval(
                        `Array.from(document.querySelectorAll('[data-testid^="repo-row-"]')).map(el => JSON.stringify({
                            id: el.getAttribute('data-testid').slice('repo-row-'.length),
                            origin: el.getAttribute('data-origin'),
                            text: (el.innerText ?? '').replace(/\\n/g, ' | ')
                        }))`
                    );
                const initial = (await rows()).map((row) => JSON.parse(row));
                recorder.note(`registry rows: ${JSON.stringify(initial.map((row) => row.text))}`);
                recorder.check('the tab lists the registry', initial.length > 0, `${String(initial.length)} rows`);
                recorder.check(
                    'each row shows a name and its path',
                    initial.every((row) => row.text.includes('/')),
                    JSON.stringify(initial[0]?.text)
                );

                await page.click('[data-testid="repo-path"]');
                await page.insertText(extra);
                await page.click('[data-testid="repo-add"]');
                await page.waitFor(
                    `Array.from(document.querySelectorAll('[data-testid^="repo-row-"]')).some(el => (el.innerText ?? '').includes('autodetect-repo'))`,
                    { timeoutMs: 20_000, label: 'the added repository row' }
                );
                await sleep(300);
                await recorder.shot(page, 'added');
                const added = (await rows()).map((row) => JSON.parse(row));
                const addedRow = added.find((row) => row.text.includes('autodetect-repo'));
                recorder.check('Add Repo registered the typed path', addedRow !== undefined, JSON.stringify(added.map((row) => row.text)));

                await page.click('[data-testid="repo-filter"]');
                await page.insertText('autodetect');
                await sleep(400);
                const filtered = (await rows()).map((row) => JSON.parse(row));
                recorder.check(
                    'the filter narrows the list to matching name or path (\u00a7SET-052)',
                    filtered.length === 1 && filtered[0].text.includes('autodetect-repo'),
                    JSON.stringify(filtered.map((row) => row.text))
                );
                await page.eval(
                    `(() => { const el = document.querySelector('[data-testid="repo-filter"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
                );
                await sleep(300);
                const nonsense = 'zzzz-no-such-repo';
                await page.click('[data-testid="repo-filter"]');
                await page.insertText(nonsense);
                await sleep(300);
                const emptyText = await page.eval(
                    `document.querySelector('[data-testid="repo-empty"]')?.innerText ?? ''`
                );
                recorder.check(
                    'an over-narrow filter says "No matching repositories" (\u00a7SET-057)',
                    String(emptyText).includes('No matching repositories'),
                    String(emptyText).replace(/\n/g, ' | ')
                );
                await recorder.shot(page, 'filtered');
                await page.eval(
                    `(() => { const el = document.querySelector('[data-testid="repo-filter"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
                );
                await sleep(300);

                if (addedRow !== undefined) {
                    await page.click(`[data-testid="repo-remove-${addedRow.id}"]`);
                    await page.waitFor(
                        `!Array.from(document.querySelectorAll('[data-testid^="repo-row-"]')).some(el => (el.innerText ?? '').includes('autodetect-repo'))`,
                        { timeoutMs: 20_000, label: 'the removed repository row' }
                    );
                    recorder.check('Remove drops it from the registry (\u00a7GIT-071)', true, addedRow.id);
                }

                const configBefore = fs.readFileSync(sandbox.configPath, 'utf8');
                await page.click('[data-testid="auto-detect-toggle"]');
                await sleep(900);
                const configAfter = fs.readFileSync(sandbox.configPath, 'utf8');
                recorder.block('config file after toggling auto-detect', configAfter || '(empty)');
                recorder.check(
                    'the auto-detect toggle writes the config key (\u00a7GIT-074)',
                    /auto-detect-repos\s*=\s*false/.test(configAfter) && configAfter !== configBefore,
                    configAfter.trim().slice(-120)
                );
                const toggleState = await page.eval(
                    `document.querySelector('[data-testid="auto-detect-toggle"]')?.checked === true`
                );
                recorder.check('and the switch follows the daemon\u2019s value, not local state', toggleState === false, String(toggleState));
                await recorder.shot(page, 'auto-detect-off');
                await page.click('[data-testid="auto-detect-toggle"]');
                await sleep(900);
                const restored = fs.readFileSync(sandbox.configPath, 'utf8');
                recorder.check('toggling back writes it on again', /auto-detect-repos\s*=\s*true/.test(restored), restored.trim().slice(-120));

                await page.key('Escape');
                await sleep(500);
                recorder.eyes('is the tab legible \u2014 rows readable at this width, buttons discoverable, the empty state honest?');
            }
        },
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
                    extraEnv: {
                        NEX_AUDIT: '1',
                        NEX_AUDIT_OPEN_FILE: path.join(sandbox.root, 'open-file-answer.txt')
                    }
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
        },

    ];
}

main().catch((error) => {
    process.stderr.write(`\nAUDIT HARNESS FAILED: ${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
});

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
 * The demo HOME is laid out so nothing on screen names this machine: repos live at ~/acme-web,
 * the prompt is a plain `~/acme-web (main) $`, and new worktrees go under /tmp/kelpi-readme (a
 * symlink into the sandbox, removed afterwards). Look at every picture before committing it.
 */

import { execFileSync } from 'node:child_process';
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
const log = (line) => console.log(`[readme] ${line}`);

// ── the demo repository ─────────────────────────────────────────────────────────────

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Sam Rivera',
    GIT_AUTHOR_EMAIL: 'sam@acme.test',
    GIT_COMMITTER_NAME: 'Sam Rivera',
    GIT_COMMITTER_EMAIL: 'sam@acme.test'
};
const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file, text, mode) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, mode === undefined ? undefined : { mode });
};

const ZSHRC = `# readme-screenshots: a plain, readable prompt for the demo
autoload -Uz vcs_info
precmd() { vcs_info }
zstyle ':vcs_info:git:*' formats ' %F{magenta}(%b)%f'
setopt PROMPT_SUBST
PROMPT='%F{blue}%~%f\${vcs_info_msg_0_} %F{242}$%f '
HISTFILE=/dev/null
unsetopt PROMPT_SP
export CLICOLOR=1 PAGER=cat GIT_PAGER=cat
`;

const CART_JS = `// Cart totals for the checkout. Amounts are integer cents throughout.

export function subtotal(items) {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function applyDiscount(amount, discount) {
    if (discount === undefined) return amount;
    if (discount.type === 'percent') return Math.round(amount * (1 - discount.value / 100));
    return Math.max(0, amount - discount.value);
}

export function tax(amount, rate) {
    return Math.round(amount * rate);
}

export function total(items, { discount, taxRate = 0.1, shipping = 0 } = {}) {
    const discounted = applyDiscount(subtotal(items), discount);
    return discounted + tax(discounted, taxRate) + shipping;
}
`;

const CART_TEST = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, subtotal, tax, total } from '../src/cart.js';

const items = [
    { sku: 'TEE-01', price: 2500, quantity: 2 },
    { sku: 'MUG-02', price: 1450, quantity: 1 }
];

describe('cart', () => {
    it('adds up line items', () => assert.equal(subtotal(items), 6450));
    it('applies a percentage discount', () => assert.equal(applyDiscount(6450, { type: 'percent', value: 10 }), 5805));
    it('never discounts below zero', () => assert.equal(applyDiscount(500, { type: 'fixed', value: 900 }), 0));
    it('rounds tax to the nearest cent', () => assert.equal(tax(5805, 0.0825), 479));
    it('adds shipping after tax', () => assert.equal(total(items, { shipping: 500 }), 7595));
    it('handles an empty cart', () => assert.equal(total([]), 0));
});
`;

const SERVER_JS = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.PORT ?? 4173);
const root = path.join(import.meta.dirname, 'public');
const types = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
    const started = Date.now();
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url);
    fs.readFile(file, (error, body) => {
        res.writeHead(error ? 404 : 200, { 'content-type': types[path.extname(file)] ?? 'text/plain' });
        res.end(error ? 'not found' : body);
        console.log(\`\${req.method} \${req.url} \${error ? 404 : 200} \${Date.now() - started}ms\`);
    });
}).listen(port, '127.0.0.1', () => {
    console.log(\`acme-web dev server ready on http://127.0.0.1:\${port}\`);
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Checkout · Acme</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header><strong>acme</strong><nav><a>Shop</a><a>Journal</a><a class="cart">Cart (3)</a></nav></header>
<main>
  <section class="form">
    <h1>Checkout</h1>
    <ol class="steps"><li class="done">Cart</li><li class="now">Shipping</li><li>Payment</li></ol>
    <label>Email<input value="sam@acme.test"></label>
    <div class="row"><label>First name<input value="Sam"></label><label>Last name<input value="Rivera"></label></div>
    <label>Address<input value="12 Harbour Street"></label>
    <div class="row"><label>City<input value="Wellington"></label><label>Postcode<input value="6011"></label></div>
    <fieldset>
      <label class="option picked"><input type="radio" checked> Standard <span>3 to 5 days</span><b>$5.00</b></label>
      <label class="option"><input type="radio"> Express <span>next day</span><b>$12.00</b></label>
    </fieldset>
    <button>Continue to payment</button>
  </section>
  <aside>
    <h2>Order summary</h2>
    <div class="item"><i class="swatch tee"></i><div>Organic tee<small>Size M · Qty 2</small></div><b>$50.00</b></div>
    <div class="item"><i class="swatch mug"></i><div>Stoneware mug<small>Qty 1</small></div><b>$14.50</b></div>
    <div class="code"><input placeholder="Discount code" value="WELCOME10"><button>Apply</button></div>
    <dl>
      <dt>Subtotal</dt><dd>$64.50</dd>
      <dt>Discount (10%)</dt><dd>−$6.45</dd>
      <dt>Tax</dt><dd>$5.81</dd>
      <dt>Shipping</dt><dd>$5.00</dd>
      <dt class="total">Total</dt><dd class="total">$68.86</dd>
    </dl>
  </aside>
</main>
</body>
</html>
`;

const STYLE_CSS = `* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d1d1f; background: #f6f4f0; }
header { display: flex; justify-content: space-between; align-items: center; padding: 14px 28px; background: #fff; border-bottom: 1px solid #e7e3dc; }
header strong { font-size: 18px; letter-spacing: -0.02em; }
nav a { margin-left: 18px; color: #555; }
nav .cart { color: #1d1d1f; font-weight: 600; }
main { display: grid; grid-template-columns: 1fr; gap: 20px; padding: 22px 28px; }
@media (min-width: 600px) { main { grid-template-columns: 1.3fr 1fr; } }
h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -0.02em; }
h2 { margin: 0 0 12px; font-size: 16px; }
.steps { display: flex; gap: 14px; padding: 0; margin: 0 0 16px; list-style: none; color: #999; font-size: 12px; }
.steps .done { color: #2f7d4f; } .steps .now { color: #1d1d1f; font-weight: 600; }
label { display: block; margin-bottom: 10px; font-size: 12px; color: #666; }
input { display: block; width: 100%; margin-top: 4px; padding: 9px 11px; font: inherit; color: #1d1d1f; background: #fff; border: 1px solid #ddd8cf; border-radius: 8px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
fieldset { margin: 6px 0 14px; padding: 0; border: 0; }
.option { display: flex; align-items: center; gap: 8px; padding: 10px 12px; margin-bottom: 8px; color: #1d1d1f; font-size: 13px; background: #fff; border: 1px solid #ddd8cf; border-radius: 8px; }
.option input { width: auto; margin: 0; } .option span { color: #888; } .option b { margin-left: auto; }
.option.picked { border-color: #1d1d1f; box-shadow: 0 0 0 1px #1d1d1f; }
button { padding: 11px 16px; font: 600 14px/1 inherit; color: #fff; background: #1d1d1f; border: 0; border-radius: 8px; }
aside { align-self: start; padding: 18px; background: #fff; border: 1px solid #e7e3dc; border-radius: 12px; }
.item { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.item small { display: block; color: #888; } .item b { margin-left: auto; font-weight: 500; }
.swatch { width: 40px; height: 40px; border-radius: 8px; }
.tee { background: linear-gradient(135deg, #9fb8a4, #6f8f78); } .mug { background: linear-gradient(135deg, #e3c9a8, #c19a6b); }
.code { display: flex; gap: 8px; margin: 4px 0 14px; } .code input { margin: 0; } .code button { padding: 0 14px; background: #efece6; color: #1d1d1f; }
dl { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin: 0; padding-top: 12px; border-top: 1px solid #eee9e1; }
dt { color: #666; } dd { margin: 0; text-align: right; }
.total { padding-top: 8px; font-size: 16px; font-weight: 700; color: #1d1d1f; }
`;

const PLAN_MD = `# Checkout redesign

Split the old single-page checkout into three steps, keep the cart math in one module, and
ship behind the \`checkout-v2\` flag.

## Status

| Area | Owner | State |
|------|-------|-------|
| Cart totals | worker-1 | ✅ tests passing |
| Shipping step | worker-2 | 🚧 in review |
| Payment step | coordinator | ⏳ next |

## Tasks

- [x] Move totals into \`src/cart.js\` (integer cents)
- [x] Round tax per order, not per line
- [ ] Shipping options from the rates API
- [ ] Remember the discount code across steps

## Rollout

1. Dogfood with staff accounts.
2. 10% of traffic for a week, watching conversion.
3. Remove the old page.

> Totals are computed once, on the server, and the page only renders them.

\`\`\`js
total(items, { discount: { type: 'percent', value: 10 }, shipping: 500 })
\`\`\`
`;

const README_MD = `# acme-web

The Acme storefront. \`npm run dev\` serves it on port 4173; \`npm test\` runs the unit tests.
`;

/** A bare origin under the sandbox root, and a clone of it at ~/acme-web with some history. */
function makeRepo(sandbox) {
    const origins = path.join(sandbox.root, 'origins');
    const origin = path.join(origins, 'acme-web.git');
    const seed = path.join(origins, 'acme-web-seed');
    fs.mkdirSync(origins, { recursive: true });
    git(origins, 'init', '-q', '--bare', '--initial-branch=main', origin);
    git(origins, 'clone', '-q', origin, seed);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const commit = (message, files) => {
        for (const [file, text] of Object.entries(files)) write(path.join(seed, file), text);
        git(seed, 'add', '.');
        git(seed, 'commit', '-q', '-m', message);
    };
    commit('Initial storefront', {
        'README.md': README_MD,
        'package.json': `${JSON.stringify({ name: 'acme-web', private: true, type: 'module', scripts: { dev: 'node server.js', test: 'node --test' } }, null, 2)}\n`,
        '.gitignore': 'node_modules/\n'
    });
    commit('Add a dev server for the static pages', { 'server.js': SERVER_JS });
    commit('Checkout page: shipping step', { 'public/index.html': INDEX_HTML, 'public/style.css': STYLE_CSS });
    commit('Move cart totals into src/cart.js', { 'src/cart.js': CART_JS });
    commit('Test the cart totals', { 'test/cart.test.js': CART_TEST });
    commit('Write up the checkout redesign plan', { 'docs/checkout-plan.md': PLAN_MD });
    git(seed, 'push', '-q', 'origin', 'main');
    const repo = path.join(sandbox.home, 'acme-web');
    git(sandbox.home, 'clone', '-q', origin, repo);
    // A few commits on origin after the clone, so "update main first" has something to fetch.
    // About 3 MB of assets that do not compress, served slowly by the fixture's own upload-pack
    // wrapper, so the New Workspace sheet's fetch step visibly counts up.
    for (let index = 0; index < 150; index += 1) {
        write(path.join(seed, 'public', 'img', `product-${String(index).padStart(3, '0')}.bin`), execFileSync('head', ['-c', '20000', '/dev/urandom']));
    }
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'Product photography');
    git(seed, 'push', '-q', 'origin', 'main');
    const throttle = path.join(origins, 'slow-upload-pack.sh');
    write(
        throttle,
        '#!/bin/sh\n# Fixture: git-upload-pack at about 0.8 MB/s, so a fetch shows its progress.\n' +
            'git-upload-pack "$@" | perl -e \'$|=1; while (sysread(STDIN, $b, 16384)) { syswrite(STDOUT, $b); select(undef, undef, undef, 0.02); }\'\n',
        0o755
    );
    git(repo, 'config', 'remote.origin.uploadpack', throttle);
    return { repo, origin };
}

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
        const created = await json(['workspace', 'create', '--name', name, ...extra]);
        const workspaceID = created.workspace_id;
        await d.settle(async () => (await panesOf(workspaceID)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });
        const [pane] = await panesOf(workspaceID);
        await waitForText(pane.id, '$ ');
        return { workspaceID, paneID: pane.id };
    };

    try {
        // ── the demo HOME: dotfiles, a repo, and zsh instead of the sandbox's /bin/sh ─────
        write(path.join(sandbox.home, '.zshrc'), ZSHRC);
        write(path.join(sandbox.home, '.gitconfig'), '[user]\n\tname = Sam Rivera\n\temail = sam@acme.test\n[init]\n\tdefaultBranch = main\n');
        const { repo } = makeRepo(sandbox);
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

        await cli.ok(['group', 'create', 'Acme', '--color', 'blue']);
        await cli.ok(['group', 'set-repo', 'Acme', repo, '--worktree']);

        const hero = await createWorkspace('checkout-v2', ['--group', 'Acme', '--color', 'purple']);
        const flaky = await createWorkspace('flaky-tests', ['--group', 'Acme', '--color', 'blue']);
        const storefront = await createWorkspace('storefront', ['--path', repo, '--color', 'green']);
        const docs = await createWorkspace('design-docs', ['--path', repo, '--color', 'orange']);

        // Each workspace is shown before anything runs in it: a pane that has never been on
        // screen has no measured grid, and the emulator does not reflow what it printed.

        // flaky-tests: an agent that is running.
        await showWorkspace(flaky.workspaceID);
        await cli.ok(['pane', 'name', 'agent'], asPane(flaky.paneID));
        await run(flaky.paneID, 'node --test', { until: 'pass 6' });
        await cli.ok(['event', 'start'], asPane(flaky.paneID));

        // design-docs: a terminal and the plan as a markdown preview.
        await showWorkspace(docs.workspaceID);
        await run(docs.paneID, 'git log --oneline -- docs src');
        await run(docs.paneID, 'kelpi md docs/checkout-plan.md');
        await d.settle(async () => (await panesOf(docs.workspaceID)).length === 2, { ceilingMs: 15_000, intervalMs: 200 });
        await cli.ok(['event', 'stop'], asPane(docs.paneID));

        // storefront: the dev server, and its page in a web pane beside it.
        await showWorkspace(storefront.workspaceID);
        await cli.ok(['pane', 'name', 'dev-server'], asPane(storefront.paneID));
        await send(storefront.paneID, `PORT=${String(devPort)} npm run dev`);
        await waitForText(storefront.paneID, 'dev server ready');
        const opened = await cli.ok(['web', 'open', `http://127.0.0.1:${String(devPort)}/`], asPane(storefront.paneID));
        const webPaneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1];
        if (webPaneID === undefined) throw new Error(`web open said: ${opened}`);
        await cli.ok(['pane', 'resize', '--target', 'dev-server', '--workspace', storefront.workspaceID, '--ratio', '0.4']);

        // checkout-v2: the coordinator drives two workers with the CLI.
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
        await waitForText(worker2, 'Initial storefront');
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
        await showWorkspace(storefront.workspaceID);
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
        await d.openSidebarMenu(page, '[data-testid="group-header"]', 'Acme');
        await d.clickMenuItem(page, 'New Workspace');
        await d.settleDom(page, `document.querySelector('[data-testid="new-workspace-sheet"]') !== null`, { ceilingMs: 5_000 });
        await page.click('[aria-label="New workspace name"]');
        await page.insertText('search-autocomplete');
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

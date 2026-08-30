#!/usr/bin/env node
/**
 * Live smoke test for TERMINAL VISUAL FIDELITY — the defect class unit tests cannot see.
 *
 * 3038 structural tests passed while the first human look at the UI found tofu boxes, a prompt
 * filler running off the right edge and a re-attach that painted stacked copies of the prompt.
 * Nothing in jsdom can catch that: it has no canvas, no fonts and no window. This smoke boots
 * the REAL stack (a sandbox `kelpid` + the real Electron shell), gives the shell a
 * powerlevel10k-SHAPED zsh prompt — Nerd Font private-use glyphs, a full-width dotted filler,
 * a right-aligned timestamp — and then checks the three things that were wrong:
 *
 *   1. **glyphs**: the bundled `JetBrainsMono Nerd Font` is actually loaded in the window.
 *      Without it every Powerline separator and icon renders as a tofu box.
 *   2. **geometry**: the shell's `$COLUMNS` equals the width the pane can actually draw. The
 *      fixture's `ruler` prints a line exactly `$COLUMNS` wide ending in `#`, and the prompt
 *      pads itself to exactly `$COLUMNS`; either being off by even one column means the
 *      renderer and the PTY disagree — the filler overruns and the timestamp is clipped.
 *      Checked at THREE window sizes, each a real window (bounds restored from
 *      `window-state.json`), not an emulated viewport.
 *   3. **re-attach**: quitting the shell and relaunching replays the daemon's snapshot. The
 *      prompt history must come back ONCE, at the size it was serialized for.
 *
 * It also screenshots every step, so a human can look — which is the actual acceptance bar.
 *
 * Isolation rules (non-negotiable — the production app owns the real socket on a dev machine):
 * every path lives in a fresh `mkdtemp` dir, the control socket is `<tmp>/kelpid.sock` and NEVER
 * `/tmp/nex.sock`, HOME is a throwaway (the fixture writes `.zshrc` there; the real `$HOME` is
 * never touched), Electron gets its own `--user-data-dir`, and every port is ephemeral.
 *
 *   node packages/shell/scripts/terminal-smoke.mjs [--no-build] [--out <dir>] [--verbose] [--keep]
 *
 * Exit code 0 = every check passed. Requires zsh (macOS has it) and a GUI session.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(shellRoot, '..', '..');
const require = createRequire(path.join(shellRoot, 'package.json'));
const WebSocket = require('ws');

const daemonEntry = path.join(repoRoot, 'packages', 'daemon', 'dist', 'kelpid.js');
const shellEntry = path.join(shellRoot, 'dist', 'main.js');
const clientDist = path.join(repoRoot, 'packages', 'client', 'dist');
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'kelpi.js');

const argv = process.argv.slice(2);
const options = {
    build: !argv.includes('--no-build'),
    verbose: argv.includes('--verbose'),
    keep: argv.includes('--keep'),
    outDir: argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null
};

/** Window sizes the geometry is checked at. Wide, narrow and tall on purpose. */
const SIZES = [
    { label: 'wide', width: 1680, height: 1000 },
    { label: 'narrow', width: 900, height: 760 },
    { label: 'tall', width: 1200, height: 1180 }
];

// ── tiny harness (same shape as the other smokes) ───────────────────────────────────

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, condition, detail = '') {
    results.push({ name, ok: Boolean(condition) });
    process.stdout.write(`  ${condition ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}\n`);
    return Boolean(condition);
}

async function waitFor(label, predicate, timeoutMs = 60_000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(intervalMs);
    }
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// ── the fixture prompt ──────────────────────────────────────────────────────────────
//
// A powerlevel10k-SHAPED prompt without installing p10k (and without ever reading the real
// `~/.p10k.zsh`): Nerd Font private-use glyphs, a filler computed from `$COLUMNS` on every
// draw, and a right-aligned timestamp. Everything lives inside PROMPT, so a SIGWINCH repaints
// it in place exactly as p10k does — which is what makes "one prompt, exactly $COLUMNS wide"
// a meaningful assertion. Built line by line because zsh's `${...}` and JS template literals
// use the same syntax.
const FIXTURE_ZSHRC = [
    'setopt PROMPT_SUBST',
    'autoload -Uz add-zsh-hook',
    'zmodload -F zsh/datetime b:strftime 2>/dev/null',
    '',
    '# Nerd Font glyphs (private use area) + powerline separators.',
    "typeset -g KELPI_SEP=$'\\ue0b1' KELPI_FOLDER=$'\\uf07b' KELPI_BRANCH=$'\\ue0a0'",
    "typeset -g KELPI_CLOCK=$'\\uf017' KELPI_OS=$'\\uf179' KELPI_ARROW=$'\\ue0b0'",
    '',
    '# A glyph probe line: any of these rendering as a box means the font never loaded.',
    'glyphs() {',
    "  print -r -- $'\\uf07b \\uf015 \\ue0b0 \\ue0b1 \\ue0a0 \\uf017 \\uf179 \\uf09b \\uf120 \\uf126 \\uf013 \\ue796 \\uf0e7'",
    '}',
    '',
    "# A ruler exactly $COLUMNS wide: every 10th column is a digit, the last column is '#'.",
    'ruler() {',
    '  local -i i n=COLUMNS',
    '  local out=""',
    '  for (( i = 1; i <= n; i++ )); do',
    '    if (( i == n )); then',
    '      out+="#"',
    '    elif (( i % 10 == 0 )); then',
    '      out+=$(( (i / 10) % 10 ))',
    '    else',
    '      out+="-"',
    '    fi',
    '  done',
    '  print -r -- "$out"',
    '  print -r -- "COLUMNS=$COLUMNS LINES=$LINES"',
    '}',
    '',
    'kelpi_prompt_parts() {',
    '  local now',
    "  strftime -s now '%H:%M:%S' $EPOCHSECONDS 2>/dev/null || now='--:--:--'",
    '  typeset -g KELPI_LEFT="${KELPI_ARROW} ${KELPI_FOLDER} ${PWD/#$HOME/~} ${KELPI_SEP} ${KELPI_BRANCH} main "',
    '  typeset -g KELPI_RIGHT=" ${KELPI_CLOCK} ${now} ${KELPI_OS} "',
    '}',
    'add-zsh-hook precmd kelpi_prompt_parts',
    'kelpi_prompt_parts',
    '',
    'kelpi_fill() {',
    '  local -i pad=$(( COLUMNS - ${#KELPI_LEFT} - ${#KELPI_RIGHT} ))',
    '  (( pad < 1 )) && return',
    '  print -rn -- "${(l:$pad::·:)}"',
    '}',
    '',
    "# %F{n} is zero-width to zsh's own arithmetic and PROMPT_SUBST re-evaluates the fill on",
    '# every draw, so the line is ALWAYS exactly $COLUMNS wide — the width oracle.',
    "PROMPT='%F{39}${KELPI_LEFT}%F{240}$(kelpi_fill)%F{108}${KELPI_RIGHT}%f",
    "%F{240}╰─%F{120}❯%f '",
    "RPROMPT=''",
    'export PAGER=cat'
].join('\n');

// ── sandbox ─────────────────────────────────────────────────────────────────────────

async function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexterm-'));
    const home = path.join(root, 'home');
    const userData = path.join(root, 'electron');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(home, '.zshrc'), FIXTURE_ZSHRC);

    const socketPath = path.join(root, 'kelpid.sock');
    if (socketPath === '/tmp/nex.sock') throw new Error('refusing to touch the production socket');
    fs.writeFileSync(path.join(root, 'config'), '');

    const controlPort = await freePort();
    const httpPort = await freePort();
    const debugPort = await freePort();
    return {
        root,
        home,
        userData,
        controlPort,
        debugPort,
        base: `http://127.0.0.1:${httpPort}`,
        env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: home,
            SHELL: '/bin/zsh',
            TERM: 'xterm-256color',
            // Without a UTF-8 locale zsh pads prompts in BYTES, and the fixture's own width
            // arithmetic would be the thing under test instead of the terminal.
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
            KELPID_RUN_DIR: path.join(root, 'run'),
            KELPID_SOCKET_PATH: socketPath,
            KELPID_TCP_PORT: String(controlPort),
            KELPID_DB_PATH: path.join(root, 'nex.db'),
            KELPID_CONFIG_PATH: path.join(root, 'config'),
            KELPID_HTTP_PORT: String(httpPort),
            KELPID_HTTP_HOST: '127.0.0.1',
            KELPID_ENTRY: daemonEntry,
            KELPID_CLIENT_DIR: clientDist
        },
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function startDaemon(sandbox) {
    const log = [];
    const child = spawn(process.execPath, [daemonEntry, 'start', '--foreground'], {
        cwd: repoRoot,
        env: sandbox.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let exited = false;
    const collect = (chunk) => {
        log.push(chunk);
        if (options.verbose) process.stderr.write(`[daemon] ${chunk}`);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', () => {
        exited = true;
    });
    return {
        log: () => log.join(''),
        async stop() {
            if (exited) return;
            child.kill('SIGTERM');
            await Promise.race([new Promise((resolve) => child.on('exit', resolve)), sleep(8000)]);
            if (!exited) child.kill('SIGKILL');
        }
    };
}

function electronBinary() {
    for (const candidate of [
        path.join(shellRoot, 'node_modules', '.bin', 'electron'),
        path.join(repoRoot, 'node_modules', '.bin', 'electron')
    ]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('electron is not installed (pnpm install)');
}

function startShell(sandbox) {
    const child = spawn(
        electronBinary(),
        ['.', `--user-data-dir=${sandbox.userData}`, `--remote-debugging-port=${String(sandbox.debugPort)}`],
        {
            cwd: shellRoot,
            env: { ...sandbox.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        }
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    if (options.verbose) {
        child.stdout.on('data', (chunk) => process.stderr.write(`[shell] ${chunk}`));
        child.stderr.on('data', (chunk) => process.stderr.write(`[shell] ${chunk}`));
    } else {
        child.stdout.resume();
        child.stderr.resume();
    }
    let exited = false;
    child.on('exit', () => {
        exited = true;
    });
    return {
        async quit() {
            if (!exited) {
                try {
                    process.kill(-child.pid, 'SIGTERM');
                } catch {
                    child.kill('SIGTERM');
                }
                await Promise.race([new Promise((resolve) => child.on('exit', resolve)), sleep(10_000)]);
            }
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                /* already gone */
            }
            await sleep(300);
        }
    };
}

// ── CDP (the window is only inspectable from inside) ────────────────────────────────

async function connectPage(port) {
    const target = await waitFor('a CDP page target', async () => {
        try {
            const response = await fetch(`http://127.0.0.1:${String(port)}/json`);
            const targets = await response.json();
            return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
        } catch {
            return undefined;
        }
    });
    const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    let nextID = 1;
    const pending = new Map();
    socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        const entry = message.id === undefined ? undefined : pending.get(message.id);
        if (entry === undefined) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = nextID++;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
            }, 30_000).unref?.();
        });
    const api = {
        close: () => socket.close(),
        async evaluate(expression) {
            const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(result.exceptionDetails)}`);
            return result.result.value;
        },
        async screenshot(file) {
            const shot = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        },
        async click() {
            const point = await api.evaluate(`(() => {
                const host = document.querySelector('[data-terminal-host]');
                if (host === null) return null;
                const rect = host.getBoundingClientRect();
                return { x: rect.left + 60, y: rect.top + 60 };
            })()`);
            if (point === null) throw new Error('no terminal to focus');
            for (const type of ['mousePressed', 'mouseReleased']) {
                await send('Input.dispatchMouseEvent', {
                    type,
                    x: point.x,
                    y: point.y,
                    button: 'left',
                    clickCount: 1,
                    buttons: type === 'mousePressed' ? 1 : 0
                });
            }
            await sleep(150);
        },
        async type(value) {
            for (const character of value) {
                const upper = character.toUpperCase();
                const params = {
                    key: character,
                    text: character,
                    unmodifiedText: character,
                    windowsVirtualKeyCode: /[a-z]/i.test(character) ? upper.charCodeAt(0) : character.charCodeAt(0)
                };
                await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
                await send('Input.dispatchKeyEvent', { type: 'char', ...params });
                await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
            }
        },
        async enter() {
            const params = { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' };
            await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
        },
        send
    };
    await send('Page.enable');
    await send('Runtime.enable');
    return api;
}

const PANE_PROBE = `(() => {
    const host = document.querySelector('[data-terminal-host]');
    if (host === null) return { error: 'no terminal host' };
    const canvas = host.querySelector('canvas');
    const rect = host.getBoundingClientRect();
    const status = document.querySelector('[data-terminal-status]');
    return {
        hostWidth: Math.round(rect.width),
        canvasWidth: canvas ? parseFloat(canvas.style.width || '0') : 0,
        status: status ? status.getAttribute('data-terminal-status') : null,
        nerdFontLoaded: typeof document.fonts !== 'undefined'
            && [...document.fonts].some((face) => face.family.includes('Nerd Font') && face.status === 'loaded')
    };
})()`;

// ── the daemon's own view (the width oracle) ────────────────────────────────────────

function cli(sandbox, args) {
    const result = spawnSync(process.execPath, [cliEntry, ...args], {
        env: { ...sandbox.env, NEX_SOCKET: `tcp:127.0.0.1:${String(sandbox.controlPort)}` },
        encoding: 'utf8',
        timeout: 20_000
    });
    return result.stdout ?? '';
}

function analyse(text) {
    const lines = text.split('\n');
    const ruler = lines.find((line) => line.trimEnd().endsWith('#') && line.includes('---'));
    const prompts = lines.filter((line) => line.includes('main') && line.includes('·'));
    return {
        columns: Number(/COLUMNS=(\d+)/.exec(text)?.[1] ?? 0),
        rulerWidth: ruler === undefined ? null : [...ruler].length,
        promptWidths: prompts.map((line) => [...line].length)
    };
}

// ── one window ──────────────────────────────────────────────────────────────────────

async function session(sandbox, label, size, { type }) {
    fs.writeFileSync(
        path.join(sandbox.userData, 'window-state.json'),
        JSON.stringify({ bounds: { x: 40, y: 40, width: size.width, height: size.height }, fullScreen: false })
    );
    const shell = startShell(sandbox);
    try {
        const cdp = await connectPage(sandbox.debugPort);
        const probe = await waitFor(`${label}: a live terminal`, async () => {
            const value = await cdp.evaluate(PANE_PROBE);
            return value && value.status === 'live' ? value : undefined;
        });
        await sleep(2500);

        const paneID = JSON.parse(cli(sandbox, ['pane', 'list', '--json']))[0]?.id;
        if (paneID === undefined) throw new Error('the daemon reports no pane');

        if (type) {
            await cdp.click();
            await cdp.type('clear; ruler; glyphs');
            await cdp.enter();
            await sleep(1500);
        }

        const settled = await cdp.evaluate(PANE_PROBE);
        if (options.outDir !== null) await cdp.screenshot(path.join(options.outDir, `${label}.png`));
        const text = cli(sandbox, ['pane', 'capture', '--target', paneID]);
        cdp.close();
        return { probe: settled ?? probe, stats: analyse(text), text };
    } finally {
        await shell.quit();
        await sleep(1200);
    }
}

// ── the run ─────────────────────────────────────────────────────────────────────────

async function ensureBuilds() {
    const builds = [
        ['@kelpi/daemon', daemonEntry, ['pnpm', ['--filter', '@kelpi/daemon', 'build']]],
        ['@kelpi/client', path.join(clientDist, 'index.html'), ['pnpm', ['--filter', '@kelpi/client', 'build']]],
        ['@kelpi/cli', cliEntry, ['pnpm', ['--filter', '@kelpi/cli', 'build']]],
        ['@kelpi/shell', shellEntry, ['node', [path.join(shellRoot, 'scripts', 'bundle.mjs')]]]
    ];
    for (const [name, artefact, [command, args]] of builds) {
        if (!options.build && fs.existsSync(artefact)) continue;
        process.stdout.write(`building ${name}…\n`);
        const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`${name} build failed:\n${result.stdout}${result.stderr}`);
    }
}

async function main() {
    await ensureBuilds();
    if (options.outDir !== null) fs.mkdirSync(options.outDir, { recursive: true });

    const sandbox = await makeSandbox();
    process.stdout.write(`sandbox: ${sandbox.root}\n`);
    const daemon = startDaemon(sandbox);
    try {
        await waitFor('the daemon to answer /healthz', async () => {
            try {
                return (await fetch(`${sandbox.base}/healthz`)).ok;
            } catch {
                return false;
            }
        });

        let last = null;
        for (const size of SIZES) {
            process.stdout.write(`\n${size.label} — a real ${String(size.width)}×${String(size.height)} window\n`);
            const run = await session(sandbox, size.label, size, { type: true });
            const { columns, rulerWidth, promptWidths } = run.stats;

            check(
                `${size.label}: the bundled Nerd Font is loaded in the window`,
                run.probe.nerdFontLoaded,
                'without it every Powerline/Nerd glyph is a tofu box'
            );
            check(
                `${size.label}: the canvas fits inside the pane`,
                run.probe.canvasWidth > 0 && run.probe.canvasWidth <= run.probe.hostWidth,
                `canvas ${String(run.probe.canvasWidth)}px, pane ${String(run.probe.hostWidth)}px`
            );
            check(
                `${size.label}: the shell's $COLUMNS is a full pane width`,
                columns > 0 && Math.abs(run.probe.hostWidth / columns - run.probe.canvasWidth / columns) < 1,
                `COLUMNS=${String(columns)}`
            );
            check(
                `${size.label}: a $COLUMNS-wide ruler occupies exactly $COLUMNS`,
                rulerWidth === columns,
                `ruler ${String(rulerWidth)} vs COLUMNS ${String(columns)}`
            );
            check(
                `${size.label}: the p10k-shaped prompt fills exactly $COLUMNS`,
                promptWidths.length > 0 && promptWidths.every((width) => width === columns),
                `prompt widths ${JSON.stringify(promptWidths)}`
            );
            last = { size, columns };
        }

        process.stdout.write('\nre-attach — quit the window, relaunch, replay\n');
        const reattach = await session(sandbox, 'reattach', last.size, { type: false });
        check(
            're-attach: the prompt history comes back ONCE, not stacked',
            reattach.stats.promptWidths.length === 1,
            `${String(reattach.stats.promptWidths.length)} prompt line(s): ${JSON.stringify(reattach.stats.promptWidths)}`
        );
        check(
            're-attach: it is replayed at the width it was serialized for',
            reattach.stats.promptWidths.every((width) => width === last.columns),
            `expected ${String(last.columns)}`
        );

        process.stdout.write('\nre-boot — the daemon restarts and re-spawns the shell with no window open\n');
        await daemon.stop();
        await sleep(1500);
        const rebooted = startDaemon(sandbox);
        try {
            await waitFor('the rebooted daemon', async () => {
                try {
                    return (await fetch(`${sandbox.base}/healthz`)).ok;
                } catch {
                    return false;
                }
            });
            const reboot = await session(sandbox, 'reboot', last.size, { type: false });
            check(
                're-boot: the restored shell was born at the remembered width',
                reboot.stats.promptWidths.length > 0 &&
                    reboot.stats.promptWidths.every((width) => width === last.columns),
                `prompt widths ${JSON.stringify(reboot.stats.promptWidths)}, expected ${String(last.columns)}`
            );
            let remembered = null;
            try {
                remembered = JSON.parse(fs.readFileSync(path.join(sandbox.root, 'pane-geometry.json'), 'utf8'));
            } catch {
                // A build with no geometry cache at all is exactly the state this check exists
                // to catch; it must read as a failed check, not as a crashed smoke.
            }
            check(
                're-boot: the geometry cache persisted the pane grid',
                remembered !== null &&
                    Object.values(remembered.panes ?? {}).some((entry) => entry.cols === last.columns),
                remembered === null ? 'no pane-geometry.json beside the database' : JSON.stringify(remembered.latest)
            );
        } finally {
            await rebooted.stop();
        }
    } catch (error) {
        check('the smoke ran to completion', false, String(error?.message ?? error));
        if (options.verbose) process.stderr.write(daemon.log());
    } finally {
        await daemon.stop();
        if (options.keep) process.stdout.write(`kept sandbox ${sandbox.root}\n`);
        else sandbox.cleanup();
    }

    const failed = results.filter((entry) => !entry.ok);
    process.stdout.write(
        `\n${String(results.length - failed.length)}/${String(results.length)} checks passed` +
            `${options.outDir === null ? '' : ` — screenshots in ${options.outDir}`}\n`
    );
    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exit(1);
});

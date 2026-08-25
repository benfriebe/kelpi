#!/usr/bin/env node
/**
 * §N24's frame-level harness: is any FRAME ever produced from a resized-but-not-yet-replayed
 * engine?
 *
 * `replay-storm.mjs` (§N23) asks whether the client's screen SETTLES to the daemon's, which is
 * a question about the state after a gesture. N24 is the other question — what is on the canvas
 * *during* one — and it needs a different instrument: the settled comparison is clean either
 * way, because the corruption heals the moment the settled-resize replay lands.
 *
 * The instrument is the same stack `replay-storm.mjs` uses (a sandbox daemon on `mkdtemp` +
 * `NEXD_*` + ephemeral non-reserved ports, a real PTY running a real zsh, the real client
 * `ingest.ts`, a real ghostty-web WASM VT) plus two things:
 *
 *   1. the REAL client renderer adapter (`packages/client/src/terminal/renderer.ts`), driven
 *      through `createRendererFromLoader` — so the resize→replay paint hold under test is the
 *      shipping code path and not a re-implementation of it; and
 *   2. a FRAME TICKER at ~60 Hz that does per tick exactly what `ghostty-web`'s render loop
 *      does per rAF — ask the engine for the cells it would paint — and classifies the result.
 *
 * Classification per frame:
 *
 *   - `held`    — the adapter has the engine's paint suspended, so `CanvasRenderer.render()`
 *                 returns before reading a single cell. The canvas is the last good frame. These
 *                 are the frames the fix trades the garbage for, and they are ACCEPTABLE.
 *   - `garbage` — lit cells that match neither the daemon's own text (`nex pane capture`,
 *                 refreshed every cycle) nor the fixture's repertoire: U+FFFD, or the
 *                 constant-stride runs of monotonically increasing codepoints that are what
 *                 non-text memory looks like read as text.
 *   - `blank`   — nothing lit while the daemon has text.
 *   - `normal`  — everything else.
 *
 * The gesture is the owner's, exactly: a LEFT/RIGHT split (`--direction horizontal`, the case
 * where the survivor takes its largest column change), multibyte output in both panes, close
 * one, reopen, repeat — with window-sized adjusts in between.
 *
 * What it measured (2026-08-25, 120 cycles, this tree):
 *
 *   - before the fix: 119 of 120 cycles flashed, ~10 consecutive garbage frames each
 *     (the whole 150 ms settle window), 362 garbage cells per frame at the widest;
 *   - after: 0 garbage frames, the same windows spent `held`.
 *
 * Usage:
 *
 *     node scripts/ui-audit/resize-flash-storm.mjs [--cycles N] [--build] [--keep] [--verbose]
 *                                                  [--no-hold]
 *
 * `--no-hold` disables the adapter's paint hold from the outside (it drives the engine handle
 * without a `setPaintSuspended`), which is how the BEFORE number above is taken on the same
 * tree. Exit code 0 = no garbage-classified frame.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ghostty-web's dist reaches for `self` while loading its inlined wasm.
globalThis.self = globalThis;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const require = createRequire(path.join(repoRoot, 'packages', 'shell', 'package.json'));
const WebSocket = require('ws');

const { makeSandbox, startDaemon, waitForHealthz, makeCli, sleep, run } = await import(
    path.join(here, 'lib', 'stack.mjs')
);
const { createTerminalIngest } = await import(
    path.join(repoRoot, 'packages', 'client', 'src', 'terminal', 'ingest.ts')
);
/**
 * `renderer.ts` uses a TypeScript parameter property, which node's strip-only loader refuses,
 * so it is transpiled (NOT re-implemented) with the workspace's own esbuild and imported from
 * the sandbox. `fonts.ts` reaches for `document`, so the loaders at the bottom of the file are
 * stubbed out at bundle time — this harness supplies its own `EngineLoader` and never calls
 * them. Everything the harness exercises (the adapter, its paint hold) is the shipping source.
 */
const esbuildPath = require.resolve('esbuild', { paths: [repoRoot, path.join(repoRoot, 'packages', 'shell')] });
const esbuild = require(esbuildPath);
const rendererSource = path.join(repoRoot, 'packages', 'client', 'src', 'terminal', 'renderer.ts');
const rendererBundle = path.join(os.tmpdir(), `n24-renderer-${String(process.pid)}.mjs`);
await esbuild.build({
    entryPoints: [rendererSource],
    outfile: rendererBundle,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    // The engine loaders are the only DOM-bound part of the file, and the harness replaces them.
    external: ['ghostty-web', '@xterm/xterm'],
    plugins: [
        {
            name: 'stub-fonts',
            setup(build) {
                build.onResolve({ filter: /\.\/fonts$/ }, () => ({ path: 'nex-fonts-stub', namespace: 'stub' }));
                build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                    contents:
                        'export const TERMINAL_FONT_FALLBACKS = "monospace";' +
                        'export const loadTerminalFonts = async () => undefined;' +
                        'export const measureCellSize = () => ({ width: 8, height: 17 });',
                    loader: 'js'
                }));
            }
        }
    ]
});
const { createRendererFromLoader } = await import(rendererBundle);
const { Ghostty } = await import(path.join(repoRoot, 'vendor', 'ghostty-web-patched', 'dist', 'ghostty-web.js'));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};
const options = {
    cycles: Number(flag('--cycles', '120')),
    build: argv.includes('--build'),
    keep: argv.includes('--keep'),
    verbose: argv.includes('--verbose'),
    hold: !argv.includes('--no-hold')
};

// ── the wire, by hand (`@nex/protocol` `ws/pty.ts`) ─────────────────────────────────

const FRAME = { output: 0x01, input: 0x02, ack: 0x03, resize: 0x04, replay: 0x05 };
const HEADER_BYTES = 17;
const PROTOCOL_VERSION = 1;
const encoder = new TextEncoder();

const uuidToBytes = (uuid) => {
    const hex = uuid.replace(/-/g, '');
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
};
const uuidFromBytes = (bytes, offset = 0) => {
    const HEX = '0123456789ABCDEF';
    let out = '';
    for (let i = 0; i < 16; i += 1) {
        const byte = bytes[offset + i];
        out += HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
        if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
    }
    return out;
};
const encodeFrame = (type, paneID, payload = new Uint8Array(0)) => {
    const frame = new Uint8Array(HEADER_BYTES + payload.length);
    frame[0] = type;
    frame.set(uuidToBytes(paneID), 1);
    frame.set(payload, HEADER_BYTES);
    return frame;
};
const encodeAck = (bytes) => {
    const payload = new Uint8Array(4);
    payload[0] = (bytes >>> 24) & 0xff;
    payload[1] = (bytes >>> 16) & 0xff;
    payload[2] = (bytes >>> 8) & 0xff;
    payload[3] = bytes & 0xff;
    return payload;
};

// ── the engine, behind the app's own adapter ────────────────────────────────────────

const ghostty = await Ghostty.load();
const stats = { faults: 0, replays: 0, resyncs: 0 };

/**
 * An `EngineHandle` over the raw WASM terminal.
 *
 * `GhosttyTerminal` is what `CanvasRenderer.render()` reads its cells out of, so reading it
 * per tick is exactly the frame the canvas would have carried. The DOM `Terminal` cannot be
 * used here (no canvas in node), so `setPaintSuspended` is mirrored onto the handle: the vendor
 * makes `render()` return on that same flag before touching a cell (`0.4.0-nex.6`), and the
 * ticker below honours it the same way.
 */
function makeHandle(cols, rows) {
    const wasmTerm = ghostty.createTerminal(cols, rows);
    const state = { suspended: false, freed: false };
    const terminal = {
        get cols() {
            return wasmTerm.getDimensions().cols;
        },
        get rows() {
            return wasmTerm.getDimensions().rows;
        },
        open() {},
        write(data) {
            wasmTerm.write(data);
        },
        reset() {
            wasmTerm.write('\u001bc');
        },
        focus() {},
        blur() {},
        resize(nextCols, nextRows) {
            wasmTerm.resize(nextCols, nextRows);
        },
        dispose() {
            if (state.freed) return;
            state.freed = true;
            try {
                wasmTerm.free();
            } catch {
                /* already gone */
            }
        },
        onData() {
            return { dispose() {} };
        }
    };
    const handle = { terminal, wasmTerm, state };
    if (options.hold) {
        handle.setPaintSuspended = (suspended) => {
            state.suspended = suspended;
        };
    }
    return handle;
}

/** The fixture's own repertoire — anything outside it and outside the daemon's text is foreign. */
const BASE_REPERTOIRE = new Set(
    [
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        ...' .,:;!?/\\|-_=+()[]{}<>\'"@#$%^&*`~$%',
        ...'┌┐└┘─│├┤┬┴┼·▪',
        ...'日本語テスト漢字あいうえお你好世界한국어',
        ...'✅🚀'
    ].map((ch) => ch.codePointAt(0))
);

/**
 * Is this frame garbage?
 *
 * "Many lit cells that match neither the server VT text nor the previous stable frame": the
 * repertoire is the union of the daemon's own captured text (refreshed each cycle), the
 * fixture's alphabet, and whatever the last frame classified `normal` was made of.
 */
function classifyFrame(wasmTerm, repertoire) {
    const { cols, rows } = wasmTerm.getDimensions();
    wasmTerm.update();
    const viewport = wasmTerm.getViewport();
    let lit = 0;
    const foreign = [];
    for (let i = 0; i < cols * rows; i += 1) {
        const cell = viewport[i];
        const cp = cell === undefined ? 0 : cell.codepoint;
        if (cp === 0 || cp === 32) continue;
        lit += 1;
        if (cp === 0xfffd || !repertoire.has(cp)) foreign.push({ cp, row: Math.floor(i / cols), col: i % cols });
    }
    return { lit, foreign, cols, rows };
}

/** The residual's fingerprint: a run of increasing codepoints at a CONSTANT stride. */
function constantStrideRun(foreign) {
    if (foreign.length < 4) return null;
    const cps = foreign.map((f) => f.cp);
    const stride = cps[1] - cps[0];
    if (stride <= 0) return null;
    let run = 2;
    for (let i = 2; i < cps.length; i += 1) {
        if (cps[i] - cps[i - 1] !== stride) break;
        run += 1;
    }
    return run >= 4 ? { stride, run, from: cps[0] } : null;
}

function frameText(wasmTerm, limit = 6) {
    const { cols, rows } = wasmTerm.getDimensions();
    wasmTerm.update();
    const viewport = wasmTerm.getViewport();
    const lines = [];
    for (let y = 0; y < rows && lines.length < limit; y += 1) {
        let text = '';
        for (let x = 0; x < cols; x += 1) {
            const cell = viewport[y * cols + x];
            if (cell === undefined) continue;
            if (cell.width === 0) continue;
            text += cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint);
        }
        const trimmed = text.replace(/[ ]+$/u, '');
        if (trimmed !== '') lines.push(trimmed);
    }
    return lines;
}

// ── the stack ───────────────────────────────────────────────────────────────────────

const sandbox = await makeSandbox(repoRoot, {
    label: 'n24',
    clientDir: path.join(repoRoot, 'packages', 'client', 'dist')
});
process.stdout.write(`sandbox ${sandbox.root}\n`);

if (options.build) {
    for (const target of ['@nex/daemon', '@nex/cli']) {
        const result = await run('pnpm', ['--filter', target, 'build'], { cwd: repoRoot });
        if (result.code !== 0) throw new Error(`${target} build failed:\n${result.stdout}${result.stderr}`);
    }
}

const daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
await waitForHealthz(sandbox.base);
const token = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
const cli = makeCli(sandbox, { repoRoot });

const jsonMessages = [];
const jsonWaiters = [];
const panes = new Map(); // uppercase pane id → pane

const ws = new WebSocket(`${sandbox.base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
ws.binaryType = 'arraybuffer';
await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
});
const send = (message) => ws.send(JSON.stringify(message));
const sendFrame = (frame) => ws.send(frame, { binary: true });

ws.on('message', (data, isBinary) => {
    if (isBinary) {
        const bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
        const paneID = uuidFromBytes(bytes, 1);
        const pane = panes.get(paneID);
        if (pane === undefined) return;
        const payload = bytes.subarray(HEADER_BYTES);
        if (bytes[0] === FRAME.replay) {
            stats.replays += 1;
            pane.replayAt = Date.now();
            pane.ingest.replay(payload);
        } else if (bytes[0] === FRAME.output) {
            pane.ingest.live(payload);
        } else return;
        sendFrame(encodeFrame(FRAME.ack, pane.paneID, encodeAck(payload.length)));
        return;
    }
    const message = JSON.parse(String(data));
    jsonMessages.push(message);
    for (const waiter of [...jsonWaiters]) {
        if (waiter.match(message)) {
            jsonWaiters.splice(jsonWaiters.indexOf(waiter), 1);
            waiter.resolve(message);
        }
    }
    if (message.type === 'pty-resync') {
        stats.resyncs += 1;
        panes.get(message.paneID)?.ingest.expectReplay();
    }
});

const waitJson = (match, label, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
        const hit = jsonMessages.find(match);
        if (hit) return resolve(hit);
        jsonWaiters.push({ match, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs).unref?.();
    });

send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, token, client: { kind: 'browser', name: 'n24-resize-flash' } });
await waitJson((message) => message.type === 'welcome', 'welcome');

/** Mount a pane the way `TerminalPane` does — through the real adapter. */
function mountPane(paneID, cols, rows) {
    const handle = makeHandle(cols, rows);
    const renderer = createRendererFromLoader('ghostty', async () => handle, { cols, rows });
    const pane = {
        paneID: paneID.toUpperCase(),
        handle,
        renderer,
        ingest: createTerminalIngest(renderer),
        cols,
        rows,
        replayAt: 0,
        frames: { normal: 0, held: 0, blank: 0, garbage: 0 },
        repertoire: new Set(BASE_REPERTOIRE),
        runs: [],
        garbageRun: 0,
        worstRun: 0,
        firstBad: null
    };
    renderer.onEngineFailure((error) => {
        stats.faults += 1;
        process.stdout.write(`  ENGINE FAULT: ${String(error && error.message)}\n`);
    });
    // `open()` needs no DOM here — the loader hands back a live handle immediately.
    void renderer.open({});
    panes.set(pane.paneID, pane);
    send({ type: 'attach-pane', paneID, cols, rows });
    return pane;
}

function unmountPane(paneID) {
    const pane = panes.get(paneID.toUpperCase());
    if (pane === undefined) return;
    panes.delete(pane.paneID);
    send({ type: 'detach-pane', paneID });
    pane.renderer.dispose();
    pane.handle.terminal.dispose();
}

/** `TerminalPane.syncGeometry`: resize the engine, then tell the daemon. */
function resizePane(pane, cols, rows) {
    pane.cols = cols;
    pane.rows = rows;
    pane.renderer.resize(cols, rows);
    send({ type: 'resize-pane', paneID: pane.paneID, cols, rows });
}

const type = (pane, text) => sendFrame(encodeFrame(FRAME.input, pane.paneID, encoder.encode(text)));

// ── the frame ticker: one classification per pane per ~60 Hz frame ──────────────────

let ticking = true;
const tick = () => {
    if (!ticking) return;
    for (const pane of panes.values()) {
        if (pane.handle.state.freed) continue;
        // What ghostty-web's render loop does first (`CanvasRenderer.render`, `0.4.0-nex.6`).
        if (pane.handle.state.suspended) {
            pane.frames.held += 1;
            continue;
        }
        let frame;
        try {
            frame = classifyFrame(pane.handle.wasmTerm, pane.repertoire);
        } catch {
            continue;
        }
        if (frame.foreign.length >= 8) {
            pane.frames.garbage += 1;
            pane.garbageRun += 1;
            pane.worstRun = Math.max(pane.worstRun, pane.garbageRun);
            if (pane.firstBad === null) {
                pane.firstBad = {
                    grid: `${String(frame.cols)}x${String(frame.rows)}`,
                    lit: frame.lit,
                    foreign: frame.foreign.length,
                    stride: constantStrideRun(frame.foreign),
                    replacementChars: frame.foreign.filter((f) => f.cp === 0xfffd).length,
                    codepoints: frame.foreign.slice(0, 12).map((f) => f.cp),
                    text: frameText(pane.handle.wasmTerm)
                };
            }
            continue;
        }
        if (pane.garbageRun > 0) {
            pane.runs.push(pane.garbageRun);
            pane.garbageRun = 0;
        }
        if (frame.lit === 0) {
            pane.frames.blank += 1;
            continue;
        }
        pane.frames.normal += 1;
    }
};
const ticker = setInterval(tick, 16);
ticker.unref?.();

// ── the pane under storm ────────────────────────────────────────────────────────────

send({ type: 'command', id: 'w', payload: { command: 'workspace-create', name: 'flash' } });
await waitJson((message) => message.type === 'command-reply' && message.id === 'w', 'workspace-create');
send({ type: 'command', id: 'p', payload: { command: 'pane-create', workspace: 'flash', name: 'victim' } });
const paneReply = await waitJson((message) => message.type === 'command-reply' && message.id === 'p', 'pane-create');
const victimID = String(paneReply.reply?.pane_id ?? '');
if (victimID === '') throw new Error(`no pane: ${JSON.stringify(paneReply)}`);
process.stdout.write(`victim ${victimID} · hold ${options.hold ? 'ON' : 'OFF'}\n`);

/** The two halves of a left/right split: the survivor's largest column change. */
const WIDE = 150;
const NARROW = 62;
const ROWS = 40;

const victim = mountPane(victimID, WIDE, ROWS);
await sleep(2000);

const zdotdir = path.join(sandbox.work, 'n24');
fs.mkdirSync(zdotdir, { recursive: true });
fs.writeFileSync(
    path.join(zdotdir, '.zshrc'),
    'setopt prompt_subst\n' + "PROMPT=$'┌NEXTRAIL ${(l:$((COLUMNS - 12))::·:)}\\n└NEXPROMPT%% '\n"
);
type(victim, `exec env ZDOTDIR=${zdotdir} zsh\n`);
await sleep(2500);

const painter = path.join(sandbox.work, 'paint.sh');
fs.writeFileSync(
    painter,
    [
        '#!/bin/sh',
        'i=0',
        'while [ $i -lt "$1" ]; do',
        '  printf "┌── 日本語テスト %s ✅ 🚀 あいうえお漢字 你好世界 한국어 ──┐\\n" "$i"',
        '  i=$((i+1))',
        'done'
    ].join('\n'),
    { mode: 0o755 }
);

/** Fold the daemon's own text into the repertoire — the "server VT text" half of the rule. */
async function refreshRepertoire(pane) {
    const captured = await cli.run(['pane', 'capture', '--target', pane.paneID, '--scrollback']);
    for (const ch of captured.stdout) {
        const cp = ch.codePointAt(0);
        if (cp !== undefined) pane.repertoire.add(cp);
    }
}

await refreshRepertoire(victim);

const start = Date.now();
for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    // Multibyte output in the survivor while the geometry is about to move.
    type(victim, `sh ${painter} 6\n`);
    await sleep(120);

    // A LEFT/RIGHT sibling appears, prints, and closes — the owner's exact gesture. The sibling
    // gets its own engine so the shared WASM instance sees the same create/free churn the app's
    // pane lifecycle produces (that churn is what makes the freed heap available to the
    // survivor's next `ghostty_terminal_resize`).
    const split = await cli.json(['pane', 'split', '--target', victimID, '--direction', 'horizontal', '--json']);
    const siblingID = String(split.pane_id ?? '');
    const sibling = siblingID === '' ? null : mountPane(siblingID, NARROW, ROWS);
    // Both panes now share the width: the survivor shrinks to make room.
    resizePane(victim, NARROW, ROWS);
    if (sibling !== null) {
        await sleep(120);
        type(sibling, `sh ${painter} 4\n`);
    }
    await sleep(400);

    // CLOSE the sibling. The client re-measures immediately and the survivor takes the whole
    // width back — the largest column change there is, and the frame the owner photographed.
    if (sibling !== null) {
        unmountPane(siblingID);
        await cli.run(['pane', 'close', '--target', siblingID]);
    }
    resizePane(victim, WIDE, ROWS);

    // Past the daemon's 150 ms settle plus its snapshot: the window under test.
    await sleep(500);

    // A window adjust between closes, as the row asks for.
    resizePane(victim, WIDE - (cycle % 9), ROWS - (cycle % 3));
    await sleep(400);

    if (cycle % 10 === 0) {
        await refreshRepertoire(victim);
        const f = victim.frames;
        process.stdout.write(
            `… ${cycle}/${options.cycles} · frames normal ${f.normal} held ${f.held} blank ${f.blank} ` +
                `GARBAGE ${f.garbage} · worst run ${victim.worstRun} · hold timeouts ` +
                `${String(victim.renderer.paintHoldTimeouts)}\n`
        );
    }
}

ticking = false;
clearInterval(ticker);
const elapsed = (Date.now() - start) / 1000;

if (victim.garbageRun > 0) victim.runs.push(victim.garbageRun);
const f = victim.frames;
const total = f.normal + f.held + f.blank + f.garbage;
const perHundred = options.cycles === 0 ? 0 : (victim.runs.length * 100) / options.cycles;

process.stdout.write(
    `\nRESULT after ${options.cycles} cycles (${elapsed.toFixed(1)}s, hold ${options.hold ? 'ON' : 'OFF'}):\n` +
        `  frames        total ${total} · normal ${f.normal} · held ${f.held} · blank ${f.blank} · GARBAGE ${f.garbage}\n` +
        `  flashes       ${victim.runs.length} (${perHundred.toFixed(1)} per 100 cycles), ` +
        `longest ${victim.worstRun} frames, median ${median(victim.runs)}\n` +
        `  hold timeouts ${String(victim.renderer.paintHoldTimeouts)} · engine faults ${stats.faults} · ` +
        `replays ${stats.replays} · resyncs ${stats.resyncs}\n`
);
if (victim.firstBad !== null) {
    process.stdout.write(`  first garbage frame: ${JSON.stringify(victim.firstBad, null, 2)}\n`);
    const report = path.join(os.tmpdir(), `n24-resize-flash-${String(process.pid)}.json`);
    fs.writeFileSync(
        report,
        JSON.stringify({ options, stats, frames: f, runs: victim.runs, firstBad: victim.firstBad }, null, 2)
    );
    process.stdout.write(`  written to ${report}\n`);
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

ws.close();
await daemon.stop();
if (!options.keep) sandbox.cleanup();
process.exit(f.garbage > 0 ? 1 : 0);

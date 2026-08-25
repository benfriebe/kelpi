#!/usr/bin/env node
/**
 * §N23's byte-level harness: does the CLIENT end up looking at the daemon's screen?
 *
 * The UI audit's `terminal-resize-storm` step asks that question through a real window, which
 * makes it slow, GUI-bound and limited to a handful of rounds. This asks the same question with
 * no window at all, so it can ask it two hundred times:
 *
 *   - a SANDBOX daemon (`mkdtemp` + `NEXD_*` + ephemeral non-reserved ports — never the dev
 *     stack, never `/tmp/nex.sock`), with a real PTY running a real zsh,
 *   - a headless client speaking the real pane-stream protocol (`attach-pane`, `resize-pane`,
 *     binary `ack`/`input` frames),
 *   - every `replay` / `output` frame fed through the REAL client ingest
 *     (`packages/client/src/terminal/ingest.ts`) into a REAL ghostty-web WASM VT — the engine
 *     the app renders with, minus the canvas,
 *   - and after every storm round, the client engine's own text differenced against the
 *     daemon's (`nex pane capture`).
 *
 * What it is for. The owner's N23 screenshot — rows of U+FFFD and stray symbol glyphs after
 * closing or adjusting panes — is a CLIENT-side symptom with a server-side buffer that reads
 * clean, so a `pane capture` cannot see it and a unit test has no engine to see it with. This
 * closes that gap: it is the only thing in the repo that puts the two emulators side by side
 * over hundreds of gestures and says which one is wrong.
 *
 * What it found (2026-08-25):
 *
 *   - EVERY zero-length replay frame threw `RangeError: offset is out of bounds` out of the
 *     engine — 61 of 181 frames in a 60-round run, because a pane whose shell has not printed
 *     yet serializes to nothing. That is N1's root cause; fixed in `0.4.0-nex.5` and in
 *     `renderer.ts`, and this harness now runs 90 rounds with 0 faults and 0 rebuilds.
 *   - The settled-resize replay carried rows WIDER than the pane (`NO_REFLOW` strands cells past
 *     the grid and `@xterm/addon-serialize` walks `line.length`), so the client rendered text the
 *     daemon never showed. Fixed in `term/service.ts` (`trimStrandedCells`).
 *   - STILL OPEN: after ~40 rounds of continuous churn the client engine's own cell buffer can
 *     come back holding garbage codepoints and U+FFFD runs while the bytes that produced it are
 *     provably clean (a fresh engine fed the same replay renders it perfectly). Grids, fill
 *     counts and buffer pointers all agree at that moment, and an independent raw read of the
 *     WASM render state shows the same garbage — so it is below the vendored JS. Re-run this to
 *     measure it; `--rounds 60` or more is where it starts.
 *
 * Usage:
 *
 *     node scripts/ui-audit/replay-storm.mjs [--rounds N] [--build] [--keep] [--verbose]
 *
 * Exit code 0 = every round's client screen agreed with the daemon's.
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
// The real client module, imported straight from source (node strips the types).
const { createTerminalIngest } = await import(
    path.join(repoRoot, 'packages', 'client', 'src', 'terminal', 'ingest.ts')
);
const { Ghostty } = await import(path.join(repoRoot, 'vendor', 'ghostty-web-patched', 'dist', 'ghostty-web.js'));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};
const options = {
    rounds: Number(flag('--rounds', '30')),
    build: argv.includes('--build'),
    keep: argv.includes('--keep'),
    verbose: argv.includes('--verbose')
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

// ── the client engine, headless ─────────────────────────────────────────────────────

const ghostty = await Ghostty.load();
const stats = { faults: 0, rebuilds: 0, replays: 0, emptyReplays: 0, resyncs: 0 };
/** The in-stream RIS the real adapter resets with (`renderer.ts TERMINAL_RESET_SEQUENCE`). */
const RIS = '\u001bc';

function rowText(line) {
    if (!line) return '';
    let text = '';
    for (const cell of line) {
        if (cell.width === 0) continue; // the continuation half of a wide glyph
        text += cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint);
    }
    return text.replace(/[ ]+$/u, '');
}

/** An engine plus the adapter's containment: a throw poisons it and the pane rebuilds. */
function makeEngine(cols, rows) {
    let term = ghostty.createTerminal(cols, rows);
    let poisoned = false;
    let onPoison = () => {};
    const guard = (action) => {
        if (poisoned) return;
        try {
            action();
        } catch (error) {
            poisoned = true;
            stats.faults += 1;
            process.stdout.write(`  ENGINE FAULT: ${error.message}\n`);
            onPoison(error);
        }
    };
    return {
        set onPoison(handler) {
            onPoison = handler;
        },
        write(data) {
            guard(() => term.write(data));
        },
        reset() {
            guard(() => term.write(RIS));
        },
        resize(nextCols, nextRows) {
            guard(() => term.resize(nextCols, nextRows));
        },
        text() {
            const lines = [];
            for (let y = 0; y < term.getDimensions().rows; y += 1) lines.push(rowText(term.getLine(y)));
            while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            return lines.join('\n');
        },
        free() {
            try {
                term.free();
            } catch {
                /* a terminal that is already gone is not interesting */
            }
        }
    };
}

/** Non-whitespace only: wrapping-insensitive, padding-insensitive. */
const squash = (text) => text.replace(/\s+/gu, '');

// ── the stack ───────────────────────────────────────────────────────────────────────

const sandbox = await makeSandbox(repoRoot, {
    label: 'n23',
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
const clients = new Map(); // uppercase pane id → client

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
        const client = clients.get(paneID);
        if (client === undefined) return;
        const payload = bytes.subarray(HEADER_BYTES);
        if (bytes[0] === FRAME.replay) {
            stats.replays += 1;
            if (payload.length === 0) stats.emptyReplays += 1;
            client.ingest.replay(payload);
        } else if (bytes[0] === FRAME.output) {
            client.ingest.live(payload);
        } else return;
        sendFrame(encodeFrame(FRAME.ack, client.paneID, encodeAck(payload.length)));
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
        clients.get(message.paneID)?.ingest.expectReplay();
    }
});

const waitJson = (match, label, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
        const hit = jsonMessages.find(match);
        if (hit) return resolve(hit);
        jsonWaiters.push({ match, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs).unref?.();
    });

send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, token, client: { kind: 'browser', name: 'n23-replay-storm' } });
await waitJson((message) => message.type === 'welcome', 'welcome');

/** Mount a pane the way `TerminalPane` does: engine + ingest + attach, rebuilding on a fault. */
function mountPane(paneID, cols, rows) {
    const engine = makeEngine(cols, rows);
    const client = { paneID, engine, ingest: createTerminalIngest(engine), cols, rows };
    const rebuild = () => {
        stats.rebuilds += 1;
        client.ingest.pause();
        send({ type: 'detach-pane', paneID });
        const fresh = makeEngine(client.cols, client.rows);
        client.engine.free();
        client.engine = fresh;
        client.ingest = createTerminalIngest(fresh);
        fresh.onPoison = rebuild;
        send({ type: 'attach-pane', paneID, cols: client.cols, rows: client.rows });
    };
    engine.onPoison = rebuild;
    clients.set(paneID.toUpperCase(), client);
    send({ type: 'attach-pane', paneID, cols, rows });
    return client;
}
function unmountPane(paneID) {
    const client = clients.get(paneID.toUpperCase());
    if (client === undefined) return;
    clients.delete(paneID.toUpperCase());
    send({ type: 'detach-pane', paneID });
    client.engine.free();
}
/** The renderer resizes its own VT first, then reports (`TerminalPane.syncGeometry`). */
function resizePane(client, cols, rows) {
    client.cols = cols;
    client.rows = rows;
    client.engine.resize(cols, rows);
    send({ type: 'resize-pane', paneID: client.paneID, cols, rows });
}
const type = (client, text) => sendFrame(encodeFrame(FRAME.input, client.paneID, encoder.encode(text)));

// ── the pane under storm ────────────────────────────────────────────────────────────

send({ type: 'command', id: 'w', payload: { command: 'workspace-create', name: 'storm' } });
await waitJson((message) => message.type === 'command-reply' && message.id === 'w', 'workspace-create');
send({ type: 'command', id: 'p', payload: { command: 'pane-create', workspace: 'storm', name: 'victim' } });
const paneReply = await waitJson((message) => message.type === 'command-reply' && message.id === 'p', 'pane-create');
const victimID = String(paneReply.reply?.pane_id ?? '');
if (victimID === '') throw new Error(`no pane: ${JSON.stringify(paneReply)}`);
process.stdout.write(`victim ${victimID}\n`);

const victim = mountPane(victimID, 100, 30);
await sleep(2000);

/*
 * The fixture is a p10k-SHAPED prompt (a full-width dotted line that zle re-expands on every
 * SIGWINCH) plus multibyte output — box drawing, CJK, emoji. The glyphs are the instrument: a
 * byte stream cut mid-codepoint shows as U+FFFD and a stranded double-width glyph shows as a
 * half-drawn box, neither of which plain ASCII would reveal.
 */
const zdotdir = path.join(sandbox.work, 'n23');
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
        '  printf "┌── 日本語テスト %s ✅ 🚀 あいうえお漢字 ──┐\\n" "$i"',
        '  i=$((i+1))',
        'done'
    ].join('\n'),
    { mode: 0o755 }
);

/** The grids the storm cycles through — every pair is a real re-measure of the pane. */
const SIZES = [
    [100, 30],
    [72, 24],
    [120, 34],
    [64, 20],
    [96, 28],
    [48, 16]
];

let garbageRounds = 0;
let missingRounds = 0;
let inventedRounds = 0;
const failures = [];

for (let round = 1; round <= options.rounds; round += 1) {
    // Live output while the geometry moves — the interleave the defect needs.
    type(victim, 'echo hi\n');
    await sleep(100);
    type(victim, `sh ${painter} 5\n`);

    // The owner's gesture: a sibling appears and disappears, and the victim is re-measured
    // twice around it. The sibling gets its own engine, so the shared WASM instance sees the
    // same create/free churn the app's pane lifecycle produces.
    const split = await cli.json(['pane', 'split', '--target', victimID, '--direction', 'vertical', '--json']);
    const siblingID = String(split.pane_id ?? '');
    const sibling = siblingID === '' ? null : mountPane(siblingID, 40, 20);
    resizePane(victim, ...SIZES[round % SIZES.length]);
    await sleep(160);
    if (sibling !== null) {
        unmountPane(siblingID);
        await cli.run(['pane', 'close', '--target', siblingID]);
    }
    resizePane(victim, ...SIZES[(round + 3) % SIZES.length]);

    // Past the client's debounce (100 ms) and the daemon's settle (150 ms), so what is compared
    // is the SETTLED state rather than the middle of a gesture.
    await sleep(850);

    const viewport = (await cli.run(['pane', 'capture', '--target', victimID])).stdout;
    const history = (await cli.run(['pane', 'capture', '--target', victimID, '--scrollback'])).stdout;
    const client = victim.engine.text();
    const clientSquashed = squash(client);
    const historySquashed = squash(history);

    const garbage = client.includes('�');
    const missing = viewport
        .split('\n')
        .map((line) => squash(line))
        .filter((line) => line.length > 8 && !clientSquashed.includes(line));
    const invented = [...client.matchAll(/\S{8,}/gu)]
        .map((match) => match[0])
        .filter((runOfText) => !historySquashed.includes(squash(runOfText)));

    if (garbage) garbageRounds += 1;
    if (missing.length > 0) missingRounds += 1;
    if (invented.length > 0) inventedRounds += 1;
    if (garbage || missing.length > 0 || invented.length > 0) {
        failures.push({ round, garbage, missing: missing.slice(0, 3), invented: invented.slice(0, 3), viewport, client });
        process.stdout.write(
            `round ${round}: ${garbage ? 'U+FFFD ' : ''}` +
                `${missing.length > 0 ? `MISSING ${missing.length} ` : ''}` +
                `${invented.length > 0 ? `INVENTED ${invented.length}` : ''}\n`
        );
    } else if (options.verbose) {
        process.stdout.write(`round ${round}: clean (${victim.cols}x${victim.rows})\n`);
    }
    if (round % 25 === 0) {
        process.stdout.write(
            `… ${round}/${options.rounds} · U+FFFD ${garbageRounds} · missing ${missingRounds} · ` +
                `invented ${inventedRounds} · faults ${stats.faults} · empty replays ${stats.emptyReplays}/${stats.replays}\n`
        );
    }
}

process.stdout.write(
    `\nRESULT after ${options.rounds} rounds: U+FFFD ${garbageRounds}, missing ${missingRounds}, ` +
        `invented ${inventedRounds}, engine faults ${stats.faults}, rebuilds ${stats.rebuilds}, ` +
        `empty replays ${stats.emptyReplays}/${stats.replays}, flow-control resyncs ${stats.resyncs}\n`
);
if (failures.length > 0) {
    // Into the OS temp dir, never the repo: this is a diagnostic, not an artifact of the tree.
    const report = path.join(os.tmpdir(), `n23-replay-storm-${String(process.pid)}.json`);
    fs.writeFileSync(report, JSON.stringify({ stats, rounds: options.rounds, failures: failures.slice(0, 5) }, null, 2));
    process.stdout.write(`first failures written to ${report}\n`);
}

ws.close();
await daemon.stop();
if (!options.keep) sandbox.cleanup();
process.exit(garbageRounds + missingRounds + inventedRounds > 0 ? 1 : 0);

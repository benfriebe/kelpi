/**
 * An SDK-only renderer that does NOT own PTY sizing shows the owner's screen, not a scramble of it.
 *
 * This is `terminal-mirrors-owner-grid.mjs` (#166, the bundled pane) re-run against the PUBLIC
 * plugin contract: replay frames carry `grid: {cols, rows} | null`, presentation frames carry
 * `ownsSize`, and Terminal Lab (`examples/plugins/terminal-lab/ui/renderer.js`) mirrors from those
 * two fields alone. Nothing private crosses the frame boundary, so what passes here is what any
 * third-party renderer can do.
 *
 * The shape being proved, per `docs/terminal-surface.md` section 5.1: a second client takes size
 * control at 40x12, every byte the daemon sends afterwards is composed for a 40-column screen, and
 * the replay that re-seeds this renderer was serialised at 40 columns with no newline between a
 * soft-wrapped row and its continuation. An emulator left at the window's own ~190 columns lays
 * those halves side by side. So the emulator is resized to the stated grid BEFORE the bytes are
 * written, and xterm (which sizes `.xterm-screen` from cols x rows rather than from the box it was
 * opened in) letterboxes inside the view where the box is bigger and is clipped by the container's
 * `overflow: hidden` where it is smaller. Never scaled: a transform would move the cells out from
 * under the pointer, which check 5 measures with a real click and the process's own SGR report.
 *
 * A mirror never changes what the renderer REPORTS. It keeps measuring its own box and keeps
 * sending that measurement, which is what check 3 counts on the wire and check 8 collects when the
 * chip hands size control back and the PTY lands on the window's own columns.
 *
 * TWO DELIBERATE DEPARTURES from the bundled scenario, both because this pane runs the private
 * fixture process (`scripts/fixtures/plugin-terminal.cjs`) rather than a shell:
 *   - The PTY proof is the fixture's own `process.stdout.columns`, recorded in its `state.json` on
 *     every SIGWINCH, instead of `tput cols`. The fixture holds the PTY and logs stdin verbatim, so
 *     no shell is left to run a command; `stdout.columns` is the same ioctl answer, read one layer
 *     closer to the process.
 *   - The long line is the fixture's own repaint label, which persists on the alt screen, instead
 *     of a `printf` the fixture would swallow.
 *
 * Check 10 (stale handle) disposes the live session in place rather than reading a handle across a
 * renderer switch: a switch tears the iframe down, so the old `session` object cannot outlive it to
 * be asked anything. Disposal is what that teardown does to the session one step earlier. It
 * measures the SDK's own refusal and nothing further: the host's session-id guard
 * (`packages/client/src/plugins/terminal.ts`) is unreachable through the public handle, because the
 * SDK throws before a message is ever sent, and it stays covered by that module's unit tests.
 *
 * Check 11 (embedded remote ownership) reuses the second-sandbox scaffolding from
 * `plugin-terminal-features.mjs`. Ownership is per runtime, and a desktop window shows one
 * workspace at a time, so the two halves are asserted in sequence: the remote pane mirrors while a
 * raw client of the REMOTE daemon owns its size, and the local pane, revisited, does not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonIDFromSandbox, restoreBundledSlots } from '../ui-audit/lib/workbench.mjs';
import { buildTerminalLab } from '../build-terminal-lab.mjs';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';

export const covers = [
    'examples/plugins/terminal-lab/',
    'packages/plugin-sdk/terminal.d.ts',
    'packages/plugin-sdk/browser.js',
    'packages/client/src/plugins/terminal.ts',
    'packages/client/src/plugins/terminal-pane.ts',
    'packages/client/src/features/TerminalFeaturePane.tsx',
    'packages/client/src/connection/pty.ts',
    // Check 7 reads `data-terminal-mirror` off the bundled pane and checks 1, 8 and 9 read the
    // top bar's `take-size-control` chip, so this scenario guards those two surfaces as well.
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/chrome/TopBar.tsx'
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginID = 'example.terminal-lab', viewID = `${pluginID}.terminal`;
const fixturePath = path.join(repoRoot, 'scripts/fixtures/plugin-terminal.cjs');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const frame = id => `[data-testid="plugin-view-${id}"] iframe`;
const paneRoot = id => `[data-pane-id="${id}"][data-terminal-status]`;
const normal = value => value.replaceAll('\r', '').split('\n').map(line => line.trimEnd()).join('\n').trimEnd();
const ptyFrame = (type, paneID, payload) => Buffer.concat([Buffer.from([type]), Buffer.from(paneID.replaceAll('-', ''), 'hex'), payload]);
const gridPayload = (cols, rows) => { const payload = Buffer.alloc(4); payload.writeUInt16BE(cols); payload.writeUInt16BE(rows, 2); return payload; };

/** The owner's grid: narrow enough that the label below soft-wraps in the daemon's VT. */
const OWNER_COLS = 40, OWNER_ROWS = 12;
/** The grid for the clipping half: wider than the emulated 900px window can hold. */
const WIDE_COLS = 120, WIDE_ROWS = 30;
/** The grid the second observer claims, so check 9 cannot pass on a stale 40x12. */
const LATE_COLS = 64, LATE_ROWS = 20;
/**
 * 113 printable characters, doing two jobs at once: three rows at the owner's 40 columns, two of
 * them wrap continuations, and one unwrapped row at 120 columns that is far wider than the 900px
 * window can show, so the clip in check 4 is visible and not merely measurable. Its tail is the
 * marker a reader must NOT find on screen there.
 */
const LONG_LINE = `${'A'.repeat(38)}-HALF-TWO-${'B'.repeat(26)}-END${'C'.repeat(22)}-CLIPPED-TAIL`;
/** The cell the real click in check 5 must land on, one-based, as the process will report it. */
const TARGET_COL = 5, TARGET_ROW = 3;

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    await page.watchFrames();
    const packagePath = await buildTerminalLab(repoRoot);
    const originalURL = await page.eval('location.href');
    const originalConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    const json = async (args, target = cli) => JSON.parse(await target.ok(args));
    const initialWorkspaces = new Set((await json(['workspace', 'list', '--json'])).map(item => item.id));

    // ── the renderer, seen only through what a plugin may read ──────────────────────
    const inside = (id, expression) => page.evalInFrame(frame(id), expression);
    const check = (id, expression, ceilingMs = 15_000) => d.settle(async () => {
        try { return await inside(id, expression); } catch { return false; }
    }, { ceilingMs });
    const ready = id => check(id, `document.body.dataset.ready === 'true' && !!globalThis.terminalLab?.session`);
    const native = id => d.settleDom(page, `document.querySelector('[data-terminal-pane="${id}"]')?.dataset.terminalRenderer === 'kelpi.shell' && document.querySelector('[data-terminal-pane="${id}"] [data-terminal-status="live"]')`);
    const choose = async (id, selected = viewID) => {
        const selector = `[data-terminal-pane="${id}"] select[aria-label="Terminal renderer"]`;
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(selector)})`)) throw new Error('Terminal renderer selector is missing');
        await page.eval(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.value = ${JSON.stringify(selected)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    };
    /** The PHYSICAL rows of the viewport, which is what the owner's grid decided. */
    const rows = id => inside(id, `(() => { const t = terminalLab.terminal, b = t.buffer.active; return Array.from({length:t.rows}, (_, i) => { const line = b.getLine(b.baseY+i); return line ? line.translateToString(true) : ''; }); })()`);
    /**
     * The same viewport with soft-wrapped rows rejoined, which is the shape `kelpi pane capture`
     * prints: the daemon reads its VT by LOGICAL line, so a row and its wrap continuation come back
     * as one string. Comparing physical rows against that would fail on a correct mirror and pass
     * on the #166 defect, which glues the halves into one physical row.
     */
    const logical = id => inside(id, `(() => {
        const t = terminalLab.terminal, b = t.buffer.active, out = [];
        for (let i = 0; i < t.rows; i++) {
            const line = b.getLine(b.baseY + i);
            if (!line) { out.push(''); continue; }
            const next = i + 1 < t.rows ? b.getLine(b.baseY + i + 1) : null;
            const text = line.translateToString(!(next && next.isWrapped));
            if (line.isWrapped && out.length) out[out.length - 1] += text; else out.push(text);
        }
        return out.join(String.fromCharCode(10));
    })()`);
    /**
     * Everything the mirror is measured from, read inside the sandboxed frame in one round trip:
     * the emulator's grid, the screen element xterm sized from it, the container that clips it, and
     * the renderer's own diagnostics. `screen*` are iframe-viewport coordinates, which is what a
     * page-level click has to be built from.
     */
    const probe = id => inside(id, `(() => {
        const root = document.getElementById('terminal');
        const screen = root.querySelector('.xterm-screen');
        const cell = terminalLab.terminal._core._renderService.dimensions?.css?.cell ?? null;
        const style = getComputedStyle(root);
        const pad = { x: parseFloat(style.paddingLeft) || 0, y: parseFloat(style.paddingTop) || 0 };
        const emulator = root.querySelector('.xterm');
        const box = root.getBoundingClientRect(), area = screen ? screen.getBoundingClientRect() : null;
        return {
            mirror: document.body.dataset.mirror ?? null,
            diagnostic: terminalLab.mirror, measured: terminalLab.measured,
            ownsSize: terminalLab.presentation.ownsSize,
            cols: terminalLab.terminal.cols, rows: terminalLab.terminal.rows,
            cellWidth: cell?.width ?? 0, cellHeight: cell?.height ?? 0,
            contentWidth: box.width - pad.x * 2, contentHeight: box.height - pad.y * 2,
            contentLeft: box.left + pad.x, contentTop: box.top + pad.y,
            screenWidth: area?.width ?? 0, screenHeight: area?.height ?? 0,
            screenLeft: area?.left ?? 0, screenTop: area?.top ?? 0,
            overflowX: style.overflowX, overflowY: style.overflowY,
            contentOverflow: root.scrollWidth - root.clientWidth,
            transform: style.transform,
            xtermTransform: emulator === null ? 'none' : getComputedStyle(emulator).transform,
            // What the letterbox is actually made of, for a reader of this record: the emulator
            // root, the scrolling viewport and the screen element xterm sizes from cols x rows.
            layers: ['.xterm', '.xterm-viewport', '.xterm-screen'].map(selector => {
                const element = root.querySelector(selector);
                if (element === null) return { selector, missing: true };
                const rect = element.getBoundingClientRect(), computed = getComputedStyle(element);
                return { selector, top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height),
                    background: computed.backgroundColor, overflowY: computed.overflowY, position: computed.position };
            })
        };
    })()`);
    /**
     * Switch the window to a workspace the way a plugin has to: `kelpi.ui.selectWorkspace` from
     * inside a view. Fire and forget on purpose, because a successful switch tears down the very
     * iframe that asked for it and an awaited call would never resolve. The host list is read
     * first, in its own round trip, so a switch that finds no matching host leaves evidence here
     * instead of an unhandled rejection inside the frame.
     */
    const selectWorkspace = async (fromPane, workspaceID, hostName) => {
        const match = hostName === undefined ? `host.kind === 'local'` : `host.name === ${JSON.stringify(hostName)}`;
        const hosts = await inside(fromPane, `(async () => (await kelpi.ui.getNavigation()).hosts.map(host => ({ id: host.id, name: host.name, kind: host.kind, connection: host.connection })))()`);
        rec.note(`hosts this view can navigate: ${JSON.stringify(hosts)}`);
        await inside(fromPane, `void (async () => { const navigation = await kelpi.ui.getNavigation(); const host = navigation.hosts.find(host => ${match}); await kelpi.ui.selectWorkspace(host.id, ${JSON.stringify(workspaceID)}); })(); true`);
    };
    /** The sidebar row for a workspace, which is the user's own way back when a view cannot ask. */
    const reveal = async workspaceID => {
        const selector = `[data-workspace-id="${workspaceID}"]`;
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(selector)})`, { ceilingMs: 6000 })) return false;
        await page.click(selector); return true;
    };
    /** A probe that answers null while the frame is being rebuilt, for use inside a settle. */
    const look = async id => { try { return await probe(id); } catch { return null; } };
    /** The columns the screen element can actually paint, from the cell xterm measured with. */
    const screenCols = g => (g === null || !(g.cellWidth > 0) ? 0 : Math.round(g.screenWidth / g.cellWidth));
    /** Anchored top-left inside the container's content box, which is what letterboxes and clips. */
    const anchored = g => g !== null && Math.abs(g.screenLeft - g.contentLeft) <= 1 && Math.abs(g.screenTop - g.contentTop) <= 1;
    const mirrored = (id, grid) => d.settle(async () => (await look(id))?.mirror === grid, { ceilingMs: 12_000 });

    // ── the private fixture process, which holds the PTY and logs every byte ─────────
    const fixtures = [];
    const state = item => { try { return JSON.parse(fs.readFileSync(path.join(item.root, 'state.json'), 'utf8')); } catch { return null; } };
    const input = item => fs.readFileSync(path.join(item.root, 'input.bin'));
    const alive = item => {
        try { process.kill(item.pid, 0); return state(item)?.pid === item.pid; } catch { return false; }
    };
    const control = async (item, value) => {
        const sequence = (state(item)?.sequence ?? 0) + 1;
        const file = path.join(item.root, 'command.json');
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...value, sequence })); fs.renameSync(`${file}.tmp`, file);
        if (!await d.settle(() => state(item)?.sequence === sequence)) throw new Error('Private terminal fixture did not accept control');
        return d.settle(() => state(item)?.sequence === sequence && !state(item)?.busy, { ceilingMs: 30_000 });
    };
    const launch = async (target, root, workspaceID, paneID) => {
        fs.mkdirSync(root, { recursive: true });
        await target.ok(['pane', 'send', '--target', paneID, `exec ${quote(process.execPath)} ${quote(fixturePath)} ${quote(root)}`]);
        const item = { cli: target, root, workspaceID, paneID, pid: 0 };
        if (!await d.settle(() => state(item)?.pid > 0)) throw new Error('Private raw terminal fixture did not start');
        item.pid = state(item).pid; fixtures.push(item); return item;
    };
    const create = async (target, root, name) => {
        const created = await json(['workspace', 'create', '--name', name, '--json'], target);
        const workspaceID = created.workspace_id ?? created.id;
        const panes = await json(['pane', 'list', '--workspace', workspaceID, '--json'], target);
        return launch(target, root, workspaceID, panes[0].id);
    };
    /** The screen the daemon's own VT holds, which is the screen a mirror must be showing. */
    const agrees = async (item, label) => {
        let last;
        const equal = await d.settle(async () => {
            try {
                const server = normal(await item.cli.ok(['pane', 'capture', '--target', item.paneID]));
                const client = normal(await logical(item.paneID));
                last = { server: server.slice(-1200), client: client.slice(-1200) };
                return client === server && client.includes(label);
            } catch (error) { last = { error: error.message }; return false; }
        }, { ceilingMs: 20_000 });
        if (!equal) rec.note(`Viewport mismatch: ${JSON.stringify(last)}`);
        return equal;
    };

    // ── a raw second client, which is what a phone or a tailnet browser is ───────────
    const observers = [];
    const observe = async (base, runDir, paneID, cols, rows, name) => {
        const token = fs.readFileSync(path.join(runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${token}`);
        socket.binaryType = 'arraybuffer'; observers.push(socket);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`${name} never handshook`)), 10_000);
            socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, token, client: { kind: 'browser', name } })));
            socket.addEventListener('message', ({ data }) => {
                if (typeof data === 'string') { if (JSON.parse(data).type === 'snapshot') { clearTimeout(timeout); resolve(); } return; }
                // Ack whatever arrives, so the daemon never pauses this stream mid-scenario.
                const bytes = Buffer.from(data);
                if (bytes[0] !== 1 && bytes[0] !== 5) return;
                const ack = Buffer.alloc(4); ack.writeUInt32BE(bytes.length - 17);
                if (socket.readyState === WebSocket.OPEN) socket.send(ptyFrame(3, paneID, ack));
            });
            socket.addEventListener('error', error => { clearTimeout(timeout); reject(error); }, { once: true });
        });
        socket.send(JSON.stringify({ type: 'attach-pane', paneID, cols, rows }));
        return socket;
    };
    const claim = (socket, paneID, cols, rows) => {
        socket.send(JSON.stringify({ type: 'take-size-control' }));
        socket.send(ptyFrame(4, paneID, gridPayload(cols, rows)));
    };

    /**
     * Every geometry report this renderer sends, off the wire. A mirror must keep producing these:
     * the report is the daemon's takeover cache and this viewer's own snapshot request.
     */
    const reports = [];
    /**
     * What a failing run leaves behind beside its screenshot: the fixture processes' own state and
     * raw input log, and each renderer's diagnostics. An eleven-act run that dies in act nine is
     * otherwise a screenshot of a workspace and nothing to read.
     */
    const diagnostics = async label => {
        const items = [];
        for (const item of fixtures) {
            const renderer = await inside(item.paneID, `({ session: terminalLab.session.id, presentation: terminalLab.presentation, mirror: terminalLab.mirror, measured: terminalLab.measured, cols: terminalLab.terminal.cols, rows: terminalLab.terminal.rows, dataset: { ...document.body.dataset } })`).catch(error => ({ unavailable: error.message }));
            items.push({ paneID: item.paneID, workspaceID: item.workspaceID, state: state(item), alive: alive(item), inputBase64: input(item).toString('base64'), renderer });
        }
        const host = await page.eval(`({ chip: !!document.querySelector('[data-testid="take-size-control"]'), terminals: Array.from(document.querySelectorAll('[data-terminal-pane]'), element => ({ paneID: element.dataset.terminalPane, renderer: element.dataset.terminalRenderer, mirror: element.querySelector('[data-pane-id]')?.getAttribute('data-terminal-mirror') ?? null })) })`).catch(error => ({ unavailable: error.message }));
        fs.writeFileSync(path.join(rec.outDir, `${label}-diagnostics.json`), JSON.stringify({ reports, items, host }, null, 2) + '\n');
    };

    let remoteSandbox, remoteDaemon, local, offReports;
    try {
        // ── 1. Terminal Lab attached, and this window sizes the process ─────────────
        local = await create(cli, path.join(sandbox.root, 'geometry-fixture'), 'Terminal Geometry');
        await cli.ok(['plugin', 'install', packagePath, '--trust']);
        await choose(local.paneID);
        if (!await ready(local.paneID)) throw new Error('Terminal Lab failed to consume its initial replay');
        const own = await probe(local.paneID);
        rec.note(`owning geometry: ${JSON.stringify(own)}`);
        rec.check('an owning renderer mirrors nothing and renders its own measured grid',
            own?.mirror === null && own?.diagnostic === null && own?.ownsSize === true &&
            own.cols === own.measured?.cols && own.rows === own.measured?.rows && own.cols > OWNER_COLS,
            `${String(own?.mirror)} · emulator ${String(own?.cols)}x${String(own?.rows)} · measured ${JSON.stringify(own?.measured)}`);
        // Against what the box can HOLD, not against the emulator's own answer: `screenCols === cols`
        // is true by construction (xterm sizes the screen from cols x rows). 14 is the scrollbar
        // gutter `gridFromMetrics` reserves, so an owning view paints every column its box has room
        // for and leaves less than one cell plus that gutter unpainted.
        rec.check('the screen element fills the view to the sub-cell remainder, minus the scrollbar gutter',
            own.cols === Math.floor((own.contentWidth - 14) / own.cellWidth) && own.contentWidth - own.screenWidth < own.cellWidth + 14,
            `${String(own?.cols)} cols of ${String(own?.cellWidth)}px in a ${String(own?.contentWidth)}px box, ${String(Math.round((own?.contentWidth ?? 0) - (own?.screenWidth ?? 0)))}px unpainted`);
        rec.check('the chip is not offered to a window that owns sizing',
            (await page.eval(`document.querySelector('[data-testid="take-size-control"]') === null`)) === true);
        const windowCols = own.cols;
        await rec.shot(page, 'terminal-lab-owns-its-box');
        rec.note('EYES - the screenshot above: one terminal pane filling its workspace, its picker reading "Terminal renderer: Terminal Lab", the fixture header (KELPI TERMINAL LAB / PID / 赤 緑 🐙 café / READY) painted at the top-left, and terminal background filling the pane edge to edge with no second shade, no scrollbar and no "Take size control" chip in the top bar. This is the baseline every later shot is compared against.');

        await page.send('Network.enable');
        offReports = page.on('Network.webSocketFrameSent', ({ response }) => {
            if (response.opcode !== 1) return;
            try {
                const message = JSON.parse(response.payloadData);
                if (message.type === 'resize-pane' && message.paneID === local.paneID) reports.push({ cols: message.cols, rows: message.rows, force: message.force === true });
            } catch { /* not every text frame is JSON we care about */ }
        });

        // ── 2. a second client takes size control at 40x12 ──────────────────────────
        const observer = await observe(sandbox.base, sandbox.runDir, local.paneID, OWNER_COLS, OWNER_ROWS, 'kelpi-geometry-observer');
        claim(observer, local.paneID, OWNER_COLS, OWNER_ROWS);
        rec.check('the window is told another client owns sizing (the chip appears)',
            await d.settleDom(page, `document.querySelector('[data-testid="take-size-control"]')`));
        const letterbox = await mirrored(local.paneID, `${OWNER_COLS}x${OWNER_ROWS}`);
        const after = await probe(local.paneID);
        rec.note(`mirrored geometry: ${JSON.stringify(after)}`);
        rec.check('the renderer publishes the owner grid it is mirroring',
            letterbox && after?.ownsSize === false && after?.diagnostic?.cols === OWNER_COLS && after?.diagnostic?.rows === OWNER_ROWS,
            `${String(after?.mirror)} · ownsSize ${String(after?.ownsSize)}`);
        rec.check('the emulator is at the owner grid and letterboxed inside a wider view',
            after?.cols === OWNER_COLS && after?.rows === OWNER_ROWS && screenCols(after) === OWNER_COLS &&
            after.screenWidth < after.contentWidth && anchored(after),
            `emulator ${String(after?.cols)}x${String(after?.rows)} · screen ${String(after?.screenWidth)}px anchored at ${String(Math.round(after?.screenLeft ?? 0))} in a ${String(after?.contentWidth)}px box`);
        rec.check('nothing is scaled to fit: no transform on the container or the emulator root',
            (after?.transform === 'none' || after?.transform === undefined) && (after?.xtermTransform === 'none' || after?.xtermTransform === undefined),
            `${String(after?.transform)} / ${String(after?.xtermTransform)}`);
        // The fixture repaints its own header with this label, so the long line lives on the alt
        // screen instead of being swallowed by a process that logs stdin and runs nothing.
        if (!await control(local, { op: 'paint', label: LONG_LINE })) throw new Error('The fixture never repainted its long line');
        const wrapped = await agrees(local, '-END');
        const capture = await cli.ok(['pane', 'capture', '--target', local.paneID]);
        fs.writeFileSync(path.join(rec.outDir, 'owner-width-capture.txt'), capture);
        rec.note(`kelpi pane capture (the owner-width screen the renderer must be showing):\n${capture}`);
        rec.check('the soft-wrapped owner line reads exactly as the daemon capture prints it', wrapped, capture.slice(-200));
        const physical = await rows(local.paneID);
        rec.note(`physical rows under the mirror: ${JSON.stringify(physical.slice(0, 6))}`);
        rec.check('and it wraps at the OWNER\'s 40th column, on three physical rows, not glued into one',
            physical.includes(LONG_LINE.slice(0, OWNER_COLS)) && physical.includes(LONG_LINE.slice(OWNER_COLS, OWNER_COLS * 2)) &&
            physical.includes(LONG_LINE.slice(OWNER_COLS * 2)) && !physical.includes(LONG_LINE),
            JSON.stringify(physical.filter(line => /[ABC]{4}/.test(line))));
        const held = await probe(local.paneID);
        rec.check('the mirror survives that output and the process is untouched',
            held?.mirror === `${OWNER_COLS}x${OWNER_ROWS}` && screenCols(held) === OWNER_COLS && alive(local),
            `${String(held?.mirror)} · screen ${String(screenCols(held))} cols · pid ${String(local.pid)}`);
        await rec.shot(page, 'terminal-lab-letterboxed-mirror');
        rec.note(`EYES - the screenshot above: the plugin renderer is now painting a NARROW (40-column) screen anchored to the TOP-LEFT of the same pane, with plain pane background filling the rest of the pane to its right and below it, no scrollbar and no second shade of background. The long line runs to the right edge of that narrow screen and CONTINUES on the next two rows (…-HALF-TWO-BBB…-END, then …-CLIPPED-TAIL). What it must NOT show is those parts side by side on one row, and it must NOT show the 40 columns stretched to fill the pane.`);

        // ── 3. a mirror still measures its own box, and still reports it ────────────
        const reportsBefore = reports.length;
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false });
        const remeasured = await d.settle(async () => {
            const g = await look(local.paneID);
            return g?.mirror === `${OWNER_COLS}x${OWNER_ROWS}` && reports.length > reportsBefore && g.measured?.cols !== OWNER_COLS;
        }, { ceilingMs: 10_000 });
        const measuring = await probe(local.paneID);
        rec.note(`reports while mirroring: ${JSON.stringify(reports.slice(reportsBefore))}`);
        rec.check('a mirroring renderer keeps reporting its own measurement, never the mirrored grid',
            remeasured && reports.slice(reportsBefore).every(item => item.cols !== OWNER_COLS || item.rows !== OWNER_ROWS) &&
            measuring?.cols === OWNER_COLS && measuring?.measured?.cols > OWNER_COLS,
            `measured ${JSON.stringify(measuring?.measured)} · emulator ${String(measuring?.cols)}x${String(measuring?.rows)}`);
        rec.check('and the daemon cached that report rather than applying it: the PTY is still the owner\'s',
            state(local)?.cols === OWNER_COLS && state(local)?.rows === OWNER_ROWS,
            `fixture stdout ${String(state(local)?.cols)}x${String(state(local)?.rows)}`);

        // ── 4. the other direction: a viewer NARROWER than the owner is clipped ─────
        //
        // The letterbox has two sides and only one of them is a letterbox. A viewer with fewer
        // columns than the owner cannot show every column, and what it must do is show the owner's
        // screen clipped at its own edge: never re-wrap the owner's rows, which is the defect, and
        // never offer a scroll, which would slide the emulator's pixels under the host's chrome.
        // 900px keeps the DESKTOP shell (a coarse pointer is what makes a phone) while leaving the
        // view far narrower than the owner's 120 columns.
        claim(observer, local.paneID, WIDE_COLS, WIDE_ROWS);
        await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
        const clipped = await d.settle(async () => {
            const g = await look(local.paneID);
            return g?.mirror === `${WIDE_COLS}x${WIDE_ROWS}` && g.cols === WIDE_COLS && g.contentWidth > 0 && g.screenWidth > g.contentWidth && anchored(g);
        }, { ceilingMs: 12_000 });
        const narrow = await probe(local.paneID);
        rec.note(`narrow viewer: ${JSON.stringify(narrow)}`);
        rec.check('a viewer narrower than the owner keeps the owner grid and is clipped, not re-wrapped',
            clipped && screenCols(narrow) === WIDE_COLS,
            `${String(narrow?.mirror)} · screen ${String(screenCols(narrow))} cols (${String(narrow?.screenWidth)}px) in a ${String(narrow?.contentWidth)}px box`);
        /*
         * "Clipped" is a statement about the CONTAINER, and `clip` rather than `hidden` is the
         * whole of it. Both paint away what does not fit, but a `hidden` box is still a scroll
         * container: script can set `scrollLeft`, a wheel gesture can pan it, and `focus()` without
         * `preventScroll` scrolls it to reveal the caret. Any of those would slide the emulator's
         * own pixels under the host's chrome, so the container must not be scrollable at all.
         * The overflowing content itself is measured one check up (screen wider than the box).
         */
        rec.check('and the container clips rather than offering a scroll: overflow clip on both axes',
            narrow?.overflowX === 'clip' && narrow?.overflowY === 'clip' && narrow.screenWidth > narrow.contentWidth,
            JSON.stringify({ overflowX: narrow?.overflowX, overflowY: narrow?.overflowY, contentOverflow: narrow?.contentOverflow }));
        rec.check('the clipped screen still reads exactly as the daemon capture prints it', await agrees(local, '-END'));
        rec.check('and the owner\'s line runs past this view\'s right edge, cut rather than re-wrapped',
            LONG_LINE.length * narrow.cellWidth > narrow.contentWidth && (await rows(local.paneID)).includes(LONG_LINE),
            `${String(Math.round(LONG_LINE.length * (narrow?.cellWidth ?? 0)))}px of text on one row in a ${String(Math.round(narrow?.contentWidth ?? 0))}px view`);
        await rec.shot(page, 'terminal-lab-clipped-narrow-viewer');
        rec.note('EYES - the screenshot above: the window is now 900px wide and the pane is NARROWER than the owner\'s 120 columns. The long line of A\'s, B\'s and C\'s runs off the RIGHT EDGE of the pane and is cut mid-line: the text ends flush against the pane border with no ellipsis, no horizontal scrollbar anywhere, and no shrunken or squashed characters. The marker at its end, -CLIPPED-TAIL, must NOT be visible, and the line must NOT have been re-wrapped onto a second row.');
        await page.send('Emulation.clearDeviceMetricsOverride');

        // ── 5. a real click under a mirror reports the cell the user pointed at ─────
        //
        // The fixture negotiates mouse tracking 'drag' with SGR encoding, so the process itself
        // says which cell it was told about. Cells are resolved by xterm from the screen element's
        // own rect against an UNSCALED cell, so the answer is the mirrored grid's cell and not a
        // fraction of the view's width. A renderer that stretched 40 columns across the whole pane
        // would answer this same pixel with a much larger column.
        claim(observer, local.paneID, OWNER_COLS, OWNER_ROWS);
        if (!await mirrored(local.paneID, `${OWNER_COLS}x${OWNER_ROWS}`)) throw new Error('The renderer did not return to the letterboxed owner grid');
        const pointing = await probe(local.paneID);
        const iframeBox = await page.box(frame(local.paneID));
        const target = {
            x: Math.round(iframeBox.x + pointing.screenLeft + (TARGET_COL - 0.5) * pointing.cellWidth),
            y: Math.round(iframeBox.y + pointing.screenTop + (TARGET_ROW - 0.5) * pointing.cellHeight)
        };
        const stretched = Math.ceil(((TARGET_COL - 0.5) * pointing.cellWidth) / (pointing.contentWidth / OWNER_COLS));
        const offset = input(local).length;
        await page.clickAt(target.x, target.y);
        const expected = `\x1b[<0;${String(TARGET_COL)};${String(TARGET_ROW)}M`;
        const reported = await d.settle(() => input(local).subarray(offset).toString('latin1').includes(expected), { ceilingMs: 8000 });
        rec.note(`mouse: clicked cell ${String(TARGET_COL)}x${String(TARGET_ROW)} of the mirrored grid; a screen stretched to the ${String(Math.round(pointing.contentWidth))}px view would have answered column ${String(stretched)}`);
        rec.check('a click inside the letterbox reports the mirrored grid\'s cell to the process',
            reported && await check(local.paneID, `terminalLab.modes.mouseTracking === 'drag' && terminalLab.modes.mouseFormat === 'sgr'`),
            JSON.stringify(input(local).subarray(offset).toString('latin1')));

        // ── 6. hidden and revealed: the reattached renderer mirrors again ───────────
        const other = await json(['workspace', 'create', '--name', 'Terminal Geometry Hidden Check', '--json']);
        const otherWorkspaceID = other.workspace_id ?? other.id;
        const otherPane = (await json(['pane', 'list', '--workspace', otherWorkspaceID, '--json']))[0].id;
        if (!await ready(otherPane)) throw new Error('The other workspace renderer did not attach');
        await selectWorkspace(otherPane, local.workspaceID);
        rec.check('a renderer hidden by a workspace switch reattaches, mirrors again and keeps its process',
            await ready(local.paneID) && await mirrored(local.paneID, `${OWNER_COLS}x${OWNER_ROWS}`) && alive(local) && await agrees(local, '-END'));
        await cli.ok(['workspace', 'delete', otherWorkspaceID, '--force']);

        // ── 7. the same grid through the other renderer, and back ──────────────────
        await choose(local.paneID, 'kelpi.shell');
        const bundled = await d.settleDom(page, `document.querySelector('${paneRoot(local.paneID)}')?.getAttribute('data-terminal-mirror') === '${OWNER_COLS}x${OWNER_ROWS}'`);
        rec.check('the bundled renderer mirrors the same grid through its own contract', bundled && await native(local.paneID) && alive(local),
            String(await page.eval(`document.querySelector('${paneRoot(local.paneID)}')?.getAttribute('data-terminal-mirror')`)));
        await choose(local.paneID);
        rec.check('switching back to the SDK renderer re-establishes the mirror on the same process',
            await ready(local.paneID) && await mirrored(local.paneID, `${OWNER_COLS}x${OWNER_ROWS}`) && alive(local) && await agrees(local, '-END'));

        // ── 8. the chip takes it back: own box again, and the PTY follows ───────────
        await page.click('[data-testid="take-size-control"]');
        const reclaimed = await d.settle(async () => {
            const g = await look(local.paneID);
            return g?.mirror === null && g.diagnostic === null && g.ownsSize === true && g.cols === g.measured?.cols && screenCols(g) === g.cols;
        }, { ceilingMs: 12_000 });
        const back = await probe(local.paneID);
        rec.note(`after take-size-control: ${JSON.stringify(back)}`);
        rec.check('taking size control clears the mirror and puts the emulator back on this box',
            reclaimed, `${String(back?.mirror)} · emulator ${String(back?.cols)} vs measured ${String(back?.measured?.cols)}`);
        rec.check('and the chip goes away again',
            await d.settleDom(page, `document.querySelector('[data-testid="take-size-control"]') === null`));
        // The PTY itself: the fixture records `process.stdout.columns` on every SIGWINCH, which is
        // the ioctl answer one layer closer to the process than `tput` could read it.
        const followed = await d.settle(() => state(local)?.cols === back?.measured?.cols && state(local)?.rows === back?.measured?.rows, { ceilingMs: 12_000 });
        rec.check('the PTY is the window\'s measurement again, neither 40 nor 120 columns',
            followed && state(local)?.cols !== OWNER_COLS && state(local)?.cols !== WIDE_COLS && Math.abs(state(local)?.cols - windowCols) <= 2,
            `fixture stdout ${String(state(local)?.cols)}x${String(state(local)?.rows)} vs measured ${JSON.stringify(back?.measured)}`);
        await rec.shot(page, 'terminal-lab-after-take-size-control');
        rec.note('EYES - the screenshot above: the narrow screen is gone. The renderer fills the whole pane again, the fixture header and the long line of A\'s now laid out for the window\'s own width, and the top bar has no "Take size control" chip.');

        // ── 9. the owner disconnects, and a fresh one arrives ──────────────────────
        claim(observer, local.paneID, OWNER_COLS, OWNER_ROWS);
        if (!await mirrored(local.paneID, `${OWNER_COLS}x${OWNER_ROWS}`)) throw new Error('The observer could not retake size control');
        observer.close();
        const succeeded = await d.settle(async () => {
            const g = await look(local.paneID);
            return g?.mirror === null && g.ownsSize === true && g.cols === g.measured?.cols;
        }, { ceilingMs: 15_000 });
        // Against the window's OWN measurement, the way check 8 does it: "anything but 40" would
        // pass on a stale 120 from act four.
        const successor = await probe(local.paneID);
        const inherited = await d.settle(() => state(local)?.cols === successor?.measured?.cols && state(local)?.rows === successor?.measured?.rows, { ceilingMs: 15_000 });
        rec.check('an owner disconnecting hands sizing to this window: the mirror clears and the PTY follows it',
            succeeded && inherited && await d.settleDom(page, `document.querySelector('[data-testid="take-size-control"]') === null`) && alive(local),
            `fixture stdout ${String(state(local)?.cols)}x${String(state(local)?.rows)} vs measured ${JSON.stringify(successor?.measured)}`);
        const late = await observe(sandbox.base, sandbox.runDir, local.paneID, LATE_COLS, LATE_ROWS, 'kelpi-geometry-late-observer');
        claim(late, local.paneID, LATE_COLS, LATE_ROWS);
        rec.check('a fresh owner re-establishes the mirror at its own grid',
            await mirrored(local.paneID, `${LATE_COLS}x${LATE_ROWS}`) && await agrees(local, '-END') && alive(local),
            String((await probe(local.paneID))?.mirror));

        // ── 10. a session handle does not outlive its attachment ───────────────────
        //
        // A renderer switch tears the iframe down, so the old `session` cannot be held across one
        // to be asked anything. Disposal is what that teardown does to the session one step
        // earlier. What this measures is the SDK's own refusal: the host's session-id guard sits
        // behind it and cannot be reached through the public handle (see the header).
        const stale = await inside(local.paneID, `(() => {
            const session = terminalLab.session;
            terminalLab.dispose();
            const answer = { resize: null, write: null };
            try { session.resize(31, 11); answer.resize = 'accepted'; } catch (error) { answer.resize = String(error.message); }
            try { session.write('STALE'); answer.write = 'accepted'; } catch (error) { answer.write = String(error.message); }
            return answer;
        })()`);
        await sleep(200);
        rec.check('a disposed session refuses to resize or to write',
            /disposed/i.test(String(stale?.resize)) && /disposed/i.test(String(stale?.write)) &&
            state(local)?.cols === LATE_COLS && alive(local),
            JSON.stringify(stale));
        await choose(local.paneID, 'kelpi.shell'); if (!await native(local.paneID)) throw new Error('The bundled renderer did not resume after disposal');
        await choose(local.paneID);
        rec.check('a fresh renderer attaches over the disposed one and mirrors the standing owner',
            await ready(local.paneID) && await mirrored(local.paneID, `${LATE_COLS}x${LATE_ROWS}`) && alive(local));

        // ── 11. ownership is per runtime: an embedded remote pane ──────────────────
        late.close();
        if (!await d.settle(async () => (await look(local.paneID))?.mirror === null, { ceilingMs: 15_000 })) {
            throw new Error('The local renderer never un-mirrored after the last observer left');
        }
        remoteSandbox = await makeSandbox(repoRoot, { label: 'geometry-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
        remoteDaemon = startDaemon(remoteSandbox, { repoRoot }); await waitForHealthz(remoteSandbox.base);
        const remoteCLI = makeCli(remoteSandbox, { repoRoot });
        await remoteCLI.ok(['plugin', 'install', packagePath, '--trust']);
        const remote = await create(remoteCLI, path.join(remoteSandbox.root, 'geometry-fixture'), 'Remote Geometry');
        const remoteToken = fs.readFileSync(path.join(remoteSandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        fs.writeFileSync(sandbox.configPath, `${originalConfig}\nremote-daemon = GeometryRemote:${remoteSandbox.base}/?token=${remoteToken}\n`);
        if (!await check(local.paneID, `(async () => (await kelpi.ui.getNavigation()).hosts.some(host => host.name === 'GeometryRemote' && host.connection === 'connected'))()`)) {
            throw new Error('The remote geometry daemon did not connect');
        }
        await selectWorkspace(local.paneID, remote.workspaceID, 'GeometryRemote');
        await choose(remote.paneID);
        if (!await ready(remote.paneID)) throw new Error('The remote replacement did not attach');
        const remoteOwn = await probe(remote.paneID);
        rec.check('a remote pane with no other client owns its own runtime\'s sizing',
            remoteOwn?.mirror === null && remoteOwn?.ownsSize === true && remoteOwn.cols === remoteOwn.measured?.cols,
            JSON.stringify({ mirror: remoteOwn?.mirror, ownsSize: remoteOwn?.ownsSize }));
        const remoteObserver = await observe(remoteSandbox.base, remoteSandbox.runDir, remote.paneID, OWNER_COLS, OWNER_ROWS, 'kelpi-geometry-remote-observer');
        claim(remoteObserver, remote.paneID, OWNER_COLS, OWNER_ROWS);
        // The same long line on the remote process, so the remote letterbox is visible and not
        // merely measurable: the remote fixture's stock screen is too short to show a wrap.
        if (!await control(remote, { op: 'paint', label: LONG_LINE })) throw new Error('The remote fixture never repainted its long line');
        rec.check('a raw client of the REMOTE daemon makes the embedded remote pane mirror',
            await mirrored(remote.paneID, `${OWNER_COLS}x${OWNER_ROWS}`) && await agrees(remote, '-END') && alive(remote),
            String((await probe(remote.paneID))?.mirror));
        await rec.shot(page, 'terminal-lab-remote-mirror');
        rec.note('EYES - the screenshot above: the sidebar shows a second host (GEOMETRYREMOTE) with its workspace selected, and that host\'s terminal pane paints the same narrow 40-column letterbox as the local one did: the long line broken across three rows at the 40th column, plain background to its right and below, no scrollbar. The local workspace above it is still listed and untouched.');
        // Ownership is per runtime, and a desktop window shows one workspace at a time, so the
        // other half is asserted by going back: the local daemon never heard of that owner.
        // The way back is the sidebar row, which is the user's own: a plugin view hosted by a
        // REMOTE daemon is refused this window's navigation outright ("Workbench UI is unavailable
        // for this daemon in this window"), so `kelpi.ui.selectWorkspace` is not available there.
        if (!await reveal(local.workspaceID) || !await ready(local.paneID)) throw new Error('The window did not return to the local workspace');
        const unaffected = await probe(local.paneID);
        rec.check('and the local pane is untouched by it: no mirror, and it still sizes its own PTY',
            unaffected?.mirror === null && unaffected?.ownsSize === true && unaffected.cols === unaffected.measured?.cols &&
            state(local)?.cols === unaffected.measured?.cols && alive(local) && alive(remote),
            `local ${String(unaffected?.mirror)} · fixture stdout ${String(state(local)?.cols)}`);
    } catch (error) {
        await diagnostics('failure').catch(() => {});
        await rec.shot(page, 'terminal-geometry-failure').catch(() => {});
        throw error;
    } finally {
        await diagnostics('final').catch(() => {});
        for (const socket of observers) { try { socket.close(); } catch { /* already gone */ } }
        await sleep(200);
        offReports?.();
        fs.writeFileSync(sandbox.configPath, originalConfig);
        await page.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
        await page.send('Page.navigate', { url: originalURL }).catch(() => {});
        // The workbench slots this scenario chose are the WINDOW's and outlive `plugin remove`,
        // so they go back to their bundled views before the plugin does (#205, #201).
        try {
            const restored = await restoreBundledSlots(page, d, { terminal: 'kelpi.shell' }, { daemonID: daemonIDFromSandbox(sandbox) });
            if (!restored.ok) rec.note(`cleanup: the workbench placements were not restored — ${String(restored.detail)}`);
            if (restored.others !== null) rec.note(`cleanup: a stopped daemon's store still holds ${String(restored.others)}`);
        } catch (error) {
            rec.note(`cleanup: the workbench placements were not restored — ${error instanceof Error ? error.message : String(error)}`);
        }
        await cli.run(['plugin', 'remove', pluginID]);
        for (const workspace of await json(['workspace', 'list', '--json'])) if (!initialWorkspaces.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        if (remoteDaemon) await remoteDaemon.stop();
        remoteSandbox?.cleanup();
    }
}

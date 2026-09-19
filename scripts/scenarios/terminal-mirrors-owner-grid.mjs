/**
 * #166 — a window that does NOT own PTY sizing shows the owner's screen, not a scramble of it.
 *
 * Two clients, one pane, different widths, against the real app: the Electron window the user is
 * looking at, and a second native client (a raw client-sync WebSocket, which is what a phone or a
 * tailnet browser is from the daemon's side) that attaches at 40x12 and takes size control. From
 * that moment the window is a NON-OWNER: the PTY is 40 columns wide, every byte it emits is
 * composed for a 40-column screen, and the replay that re-seeds the window's engine was serialised
 * at 40 columns with no newline between a soft-wrapped row and its continuation
 * (`@xterm/addon-serialize`; `daemon/src/term/service.ts`).
 *
 * Before #166 the window's engine stayed at its own ~200 columns and laid those halves side by
 * side: fixed-stride fragments at the owner's width, reproduced by every later replay, which is
 * the steady-state screenshot in #165. `kelpi pane capture` read clean throughout, which is why
 * this has to be measured in the window.
 *
 * What the window does now is MIRROR: the replay states its grid (`replayGrid`,
 * `packages/protocol/src/ws/pty.ts`), the pane resizes its engine to it before applying the bytes
 * (`TerminalPane.tsx` ▸ `adoptReplayGrid`) and the engine — which sizes its own canvas from
 * cols×rows and not from the box it is given — letterboxes inside the pane. So the measurement
 * that proves it is a GEOMETRY one, taken off the real canvas with the real font's cell metrics:
 * a 40-column canvas inside a much wider pane cannot be holding an 84-character row.
 *
 * The escape hatch is the `take-size-control` chip, and the last act checks it both ways: the
 * engine comes back to the window's own box AND the PTY follows it (`tput cols` inside the pane
 * answers with the window's columns, not the observer's).
 */

import fs from 'node:fs';
import path from 'node:path';

import { PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';

export const covers = [
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/connection/pty.ts',
    'packages/client/src/features/TerminalFeaturePane.tsx',
    'packages/client/src/chrome/TopBar.tsx',
    'packages/daemon/src/ws/streams.ts',
    'packages/protocol/src/ws/pty.ts'
];

/** The observer's window: narrow enough that an ordinary line soft-wraps in the daemon's VT. */
const OWNER_COLS = 40;
const OWNER_ROWS = 12;
/** 84 printable characters: three rows at 40 columns, two of them wrap continuations. */
const LONG_LINE = `${'A'.repeat(38)}-HALF-TWO-${'B'.repeat(26)}-END`;

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();

const ptyFrame = (type, paneID, payload) =>
    Buffer.concat([Buffer.from([type]), Buffer.from(paneID.replaceAll('-', ''), 'hex'), payload]);

const gridPayload = (cols, rows) => {
    const payload = Buffer.alloc(4);
    payload.writeUInt16BE(cols);
    payload.writeUInt16BE(rows, 2);
    return payload;
};

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    const paneRoot = (id) => `[data-pane-id="${id}"][data-terminal-status]`;
    /** The pane's own box and its engine canvas, in CSS pixels, plus the cell it measured with. */
    const geometry = (id) =>
        page.eval(`(() => {
            const root = document.querySelector('${paneRoot(id)}');
            if (root === null) return null;
            const host = root.querySelector('[data-terminal-host]');
            const canvas = host?.querySelector('canvas') ?? null;
            const cell = (root.getAttribute('data-terminal-cell') ?? '').split('x').map(Number);
            const hostBox = host?.getBoundingClientRect() ?? null;
            const canvasBox = canvas?.getBoundingClientRect() ?? null;
            return {
                mirror: root.getAttribute('data-terminal-mirror'),
                cellWidth: cell[0] ?? 0,
                cellHeight: cell[1] ?? 0,
                hostWidth: hostBox?.width ?? 0,
                hostHeight: hostBox?.height ?? 0,
                canvasWidth: canvasBox?.width ?? 0,
                canvasHeight: canvasBox?.height ?? 0
            };
        })()`);
    /** Columns the canvas can actually paint, from the cell the pane published. */
    const canvasCols = (g) => (g === null || !(g.cellWidth > 0) ? 0 : Math.round(g.canvasWidth / g.cellWidth));
    const hostCols = (g) => (g === null || !(g.cellWidth > 0) ? 0 : Math.floor(g.hostWidth / g.cellWidth));

    /*
     * A workspace of this scenario's own, for the reason `terminal-copy-paste-chords.mjs` and
     * `workspace-switch-keeps-the-caret.mjs` both state: the battery runs every scenario against
     * ONE sandbox, and by the time this one runs the scenarios before it have created workspaces,
     * moved the active one and split panes into Default. `pane list` then answers with panes that
     * are not on this window's screen at all - which is how the first run of this file inside a
     * battery failed at its own first gate ("the pane never came up live") while passing on its
     * own. `workspace create` reveals the new workspace to every client, so the window is on it by
     * the time the settle returns, and it starts with exactly one full-width pane, which is what
     * the letterbox measurement below needs.
     */
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initialWorkspaceIDs = new Set(startingWorkspaces.map((workspace) => workspace.id));
    const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', `Mirror-${TAG}`, '--json']));
    const workspaceID = created.workspace_id ?? created.id;
    rec.check('a workspace of its own', typeof workspaceID === 'string', JSON.stringify(created));
    if (typeof workspaceID !== 'string') return;
    await d.settleDom(page, `document.querySelector('[data-workspace-id="${workspaceID}"]')`, { ceilingMs: 10_000 });
    await d.settle(async () => (await d.domPaneIDs(page)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });
    const paneID = (await d.domPaneIDs(page))[0] ?? '';
    rec.check('a shell pane on screen to watch', paneID !== '', paneID);
    if (paneID === '') return;
    if (!(await d.settleDom(page, `document.querySelector('${paneRoot(paneID)}[data-terminal-status="live"]')`))) {
        throw new Error('the pane never came up live in the window');
    }

    // ── 1. the window owns sizing: no mirror, the canvas fills its box ───────────────
    const own = await geometry(paneID);
    rec.note(`window pane geometry: ${JSON.stringify(own)}`);
    rec.check('no mirror while this window sizes the PTY', own?.mirror === null, String(own?.mirror));
    rec.check(
        'the canvas fills the pane box to the sub-cell remainder',
        canvasCols(own) === hostCols(own) && hostCols(own) > OWNER_COLS,
        `canvas ${String(canvasCols(own))} cols vs host ${String(hostCols(own))} cols`
    );
    const windowCols = canvasCols(own);
    rec.check(
        'the chip is not offered to a window that owns sizing',
        (await page.eval(`document.querySelector('[data-testid="take-size-control"]') === null`)) === true
    );

    // ── 2. a second client takes size control at 40x12 ──────────────────────────────
    const token = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
    const observer = new WebSocket(`${sandbox.base.replace(/^http/, 'ws')}/ws?token=${token}`);
    observer.binaryType = 'arraybuffer';
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('the size observer never handshook')), 10_000);
            observer.addEventListener('open', () =>
                observer.send(
                    JSON.stringify({
                        type: 'hello',
                        protocolVersion: PROTOCOL_VERSION,
                        token,
                        client: { kind: 'browser', name: 'kelpi-166-size-observer' }
                    })
                )
            );
            observer.addEventListener('message', ({ data }) => {
                if (typeof data === 'string') {
                    if (JSON.parse(data).type === 'snapshot') {
                        clearTimeout(timeout);
                        resolve();
                    }
                    return;
                }
                // Ack whatever arrives, so the daemon never pauses this stream mid-scenario.
                const bytes = Buffer.from(data);
                if (bytes[0] !== 1 && bytes[0] !== 5) return;
                const ack = Buffer.alloc(4);
                ack.writeUInt32BE(bytes.length - 17);
                if (observer.readyState === WebSocket.OPEN) observer.send(ptyFrame(3, paneID, ack));
            });
            observer.addEventListener('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            }, { once: true });
        });
        observer.send(JSON.stringify({ type: 'attach-pane', paneID, cols: OWNER_COLS, rows: OWNER_ROWS }));
        observer.send(JSON.stringify({ type: 'take-size-control' }));
        observer.send(ptyFrame(4, paneID, gridPayload(OWNER_COLS, OWNER_ROWS)));

        // The chip is the user-visible half of the hand-off; it is also the signal that the
        // window's store has the broadcast, which is what its panes read.
        rec.check(
            'the window is told another client owns sizing (the chip appears)',
            await d.settleDom(page, `document.querySelector('[data-testid="take-size-control"]')`)
        );

        // ── 3. the window mirrors the owner's grid ──────────────────────────────────
        const mirrored = await d.settle(async () => (await geometry(paneID))?.mirror === `${OWNER_COLS}x${OWNER_ROWS}`, {
            ceilingMs: 8000
        });
        const after = await geometry(paneID);
        rec.note(`mirrored geometry: ${JSON.stringify(after)}`);
        rec.check('the pane publishes the owner grid it is mirroring', mirrored, String(after?.mirror));
        rec.check(
            'the engine is letterboxed: a 40-column canvas inside a much wider pane',
            canvasCols(after) === OWNER_COLS && hostCols(after) >= windowCols,
            `canvas ${String(canvasCols(after))} cols inside a ${String(hostCols(after))}-col box`
        );

        // ── 4. the long line the defect used to glue ────────────────────────────────
        //
        // The daemon's VT wraps this at 40 columns, and the serialiser writes the halves with no
        // newline between them. A 40-column canvas cannot hold 84 characters on one row, so the
        // geometry above is already the proof; the capture and the screenshot are what a reader
        // compares by eye (`capture-parity`'s method).
        await cli.ok(['pane', 'send', '--target', paneID, `printf '%s\\n' ${JSON.stringify(LONG_LINE)}`]);
        const wrapped = await d.settle(async () => (await cli.ok(['pane', 'capture', '--target', paneID])).includes('-END'), {
            ceilingMs: 8000
        });
        const capture = await cli.ok(['pane', 'capture', '--target', paneID]);
        rec.check('the line reached the pane', wrapped, capture.slice(-200));
        fs.writeFileSync(path.join(rec.outDir, 'owner-width-capture.txt'), capture);
        rec.note(`kelpi pane capture (the owner-width screen the window must be showing):\n${capture}`);
        const held = await geometry(paneID);
        rec.check(
            'the mirror survives the output: still 40 columns on the canvas',
            held?.mirror === `${OWNER_COLS}x${OWNER_ROWS}` && canvasCols(held) === OWNER_COLS,
            `${String(held?.mirror)} · canvas ${String(canvasCols(held))} cols`
        );
        await rec.shot(page, 'mirroring-the-owner-grid');
        rec.note(
            'EYES - the screenshot above: the terminal pane shows a narrow (40-column) screen in the top-left of its box, the long line broken across two rows exactly as the capture prints it, with empty pane background to its right. What it must NOT show is fragments of that line side by side on one row.'
        );

        // ── 5. a narrower viewer pans the owner's unscaled canvas (#178) ───────────
        observer.send(ptyFrame(4, paneID, gridPayload(120, 30)));
        // 900px keeps the DESKTOP shell (a coarse pointer is what makes a phone, and the override
        // does not claim one) while leaving the pane box far narrower than the owner's 120 columns.
        // Much smaller and the desktop layout squeezes the content area to zero, which would make
        // the comparison below true for the wrong reason.
        await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
        const clipped = await d.settle(async () => {
            const g = await geometry(paneID);
            return g?.mirror === '120x30' && canvasCols(g) === 120 && hostCols(g) > 0 && hostCols(g) < 120;
        }, { ceilingMs: 10_000 });
        const narrow = await geometry(paneID);
        rec.note(`narrow viewer: ${JSON.stringify(narrow)}`);
        rec.check(
            'a viewer NARROWER than the owner keeps the owner grid and is clipped, not re-wrapped',
            clipped,
            `${String(narrow?.mirror)} · canvas ${String(canvasCols(narrow))} cols inside a ${String(hostCols(narrow))}-col box`
        );
        const viewport = () => page.eval(`(() => {
            const root = document.querySelector('${paneRoot(paneID)}');
            const host = root?.querySelector('[data-terminal-host]');
            const canvas = host?.querySelector('canvas');
            if (!root || !host || !canvas) return null;
            const h = host.getBoundingClientRect(), c = canvas.getBoundingClientRect();
            return { x: host.scrollLeft, y: host.scrollTop,
                maxX: host.scrollWidth - host.clientWidth, maxY: host.scrollHeight - host.clientHeight,
                rootX: root.scrollLeft, rootY: root.scrollTop, clip: root.dataset.terminalClip,
                focused: document.activeElement === host.querySelector('textarea'),
                hostX: h.x, hostY: h.y, canvasX: c.x, canvasY: c.y,
                width: c.width, height: c.height, cx: h.x + h.width / 2, cy: h.y + h.height / 2,
                overflow: getComputedStyle(host).overflow,
                left: !!root.querySelector('[data-testid="terminal-clip-left-${paneID}"]'),
                right: !!root.querySelector('[data-testid="terminal-clip-right-${paneID}"]') };
        })()`);
        const beforePan = await viewport();
        const expectedClip = `${120 - hostCols(narrow)}x${Math.max(0, 30 - Math.floor(narrow.hostHeight / narrow.cellHeight))}`;
        rec.check('the narrow mirror publishes its clipped cells', beforePan?.clip === expectedClip && beforePan.maxX > 0, JSON.stringify(beforePan));
        await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: beforePan.cx, y: beforePan.cy,
            deltaX: 2000, deltaY: 2000 });
        rec.check('wheel reaches the far columns and rows', await d.settle(async () => {
            const v = await viewport();
            return v.x === v.maxX && v.y === v.maxY && v.x > 0;
        }), JSON.stringify(await viewport()));
        const panned = await viewport();
        rec.check('only the host scrolls and the unscaled canvas follows it',
            panned.rootX === 0 && panned.rootY === 0 && panned.hostX === beforePan.hostX &&
            panned.hostY === beforePan.hostY && panned.width === beforePan.width && panned.height === beforePan.height &&
            Math.abs(panned.canvasX - beforePan.canvasX + panned.x) < 1 &&
            Math.abs(panned.canvasY - beforePan.canvasY + panned.y) < 1 && panned.left && !panned.right,
            JSON.stringify(panned));
        rec.check('panning keeps the owner grid', (await geometry(paneID))?.mirror === '120x30');
        await rec.shot(page, 'panned-to-owner-right-edge');

        // #178: exercise the real engine input proxies as well as the canvas geometry.
        const imeGeometry = () => page.eval(`(() => {
            const root = document.querySelector('${paneRoot(paneID)}');
            const canvas = root.querySelector('canvas');
            const area = root.querySelector('textarea');
            const host = root.querySelector('[data-terminal-host]');
            const cb = canvas.getBoundingClientRect();
            const ab = area.getBoundingClientRect();
            const hb = host.getBoundingClientRect();
            area.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true,data:'PAN'}));
            const pre = root.querySelector('[data-ime-preedit]');
            const pb = pre.getBoundingClientRect();
            const result = {pan:[host.scrollLeft,host.scrollTop],canvas:[cb.x,cb.y],area:[ab.x,ab.y],
                areaStyle:[area.style.left,area.style.top],canvasOffset:[canvas.offsetLeft,canvas.offsetTop],
                host:[hb.x,hb.y],pre:[pb.x,pb.y],root:[root.scrollLeft,root.scrollTop]};
            area.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:''}));
            return result;
        })()`);
        const imeProbe = await imeGeometry();
        rec.note('IME pan geometry '+JSON.stringify(imeProbe));
        rec.check('IME caret follows the panned canvas',
            Math.abs(imeProbe.area[0] - imeProbe.canvas[0] - parseFloat(imeProbe.areaStyle[0]) + imeProbe.canvasOffset[0]) < 1 &&
            Math.abs(imeProbe.area[1] - imeProbe.canvas[1] - parseFloat(imeProbe.areaStyle[1]) + imeProbe.canvasOffset[1]) < 1 &&
            imeProbe.pre[0] === imeProbe.area[0] && imeProbe.pre[1] === imeProbe.area[1],
            JSON.stringify(imeProbe));
        await page.eval(`document.querySelector('${paneRoot(paneID)} textarea').blur()`);
        const clickBefore = await viewport();
        await page.send('Input.dispatchMouseEvent', {type:'mousePressed',x:clickBefore.cx,y:clickBefore.cy,button:'left',clickCount:1});
        await page.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:clickBefore.cx,y:clickBefore.cy,button:'left',clickCount:1});
        await sleep(100);
        const clickAfter = await viewport();
        rec.check('refocusing a panned canvas preserves the viewport',
            clickAfter.focused && clickBefore.x===clickAfter.x && clickBefore.y===clickAfter.y && clickAfter.rootX===0 && clickAfter.rootY===0,
            JSON.stringify({before:clickBefore,after:clickAfter}));

        // Focus must not scroll the fixed root to expose an absolute caret beyond the viewer box.
        await cli.ok(['pane','send','--target',paneID,"printf '\\033[20;110H'"]);
        await sleep(150);
        await page.eval(`document.querySelector('${paneRoot(paneID)} textarea').blur()`);
        const farCaretBefore=await viewport();
        await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:farCaretBefore.cx,y:farCaretBefore.cy,button:'left',clickCount:1});
        await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:farCaretBefore.cx,y:farCaretBefore.cy,button:'left',clickCount:1});
        await sleep(100);
        const farCaretAfter=await viewport();
        rec.check('refocus with a far-right cursor keeps pane root stationary',farCaretAfter.focused&&farCaretAfter.rootX===0&&farCaretAfter.rootY===0&&farCaretAfter.x===farCaretBefore.x&&farCaretAfter.y===farCaretBefore.y,
            JSON.stringify({before:farCaretBefore,after:farCaretAfter}));
        await cli.ok(['pane','send','--target',paneID,"printf '\\033[1;1H'"]);
        // Restore a failed probe's root position so the remaining checks can still run.
        await page.eval(`(() => {const r=document.querySelector('${paneRoot(paneID)}');r.scrollLeft=0;r.scrollTop=0;})()`);
        await sleep(150);
        // Put both widths inside one measured cell interval. A fixed viewport delta can cross
        // a column boundary when a retained side panel or different font changes the host width.
        const resizeSeed = await geometry(paneID);
        const viewportWidth = await page.eval('window.innerWidth');
        const cellWidth = resizeSeed?.cellWidth;
        if (!(cellWidth >= 4) || !(hostCols(resizeSeed) > 0)) {
            throw new Error(`sub-cell resize needs measurable host/cell geometry: ${JSON.stringify(resizeSeed)}`);
        }
        const targetHostWidth = (hostCols(resizeSeed) + 0.75) * cellWidth;
        const wideWidth = Math.round(viewportWidth + targetHostWidth - resizeSeed.hostWidth);
        const shrink = Math.floor(cellWidth / 2);
        const smallWidth = wideWidth - shrink;
        const resizePlan = { seed: resizeSeed, viewportWidth, cellWidth, targetHostWidth, wideWidth, smallWidth, shrink };
        await page.send('Emulation.setDeviceMetricsOverride', {width:wideWidth,height:600,deviceScaleFactor:1,mobile:false});
        const wideSettled = await d.settle(async () => {
            const g = await geometry(paneID);
            return g !== null && Math.abs(g.hostWidth - (resizeSeed.hostWidth + wideWidth - viewportWidth)) < 0.5;
        });
        const wideGeometry = await geometry(paneID);
        if (!wideSettled || wideGeometry.cellWidth !== cellWidth ||
            Math.floor((wideGeometry.hostWidth - shrink) / cellWidth) !== hostCols(wideGeometry)) {
            throw new Error(`sub-cell resize precondition not established: ${JSON.stringify({plan:resizePlan,before:wideGeometry})}`);
        }
        const beforeSmallResize=await viewport();
        await page.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:beforeSmallResize.cx,y:beforeSmallResize.cy,deltaX:2000,deltaY:0});
        await sleep(100);
        const atWideEdge=await viewport();
        // No wheel, focus or scroll action follows this shrink until the assertion is recorded.
        await page.send('Emulation.setDeviceMetricsOverride',{width:smallWidth,height:600,deviceScaleFactor:1,mobile:false});
        await sleep(250);
        const afterSmallResize=await viewport();
        const smallGeometry = await geometry(paneID);
        rec.check('a sub-cell shrink reveals the newly clipped right edge',
            atWideEdge.x === atWideEdge.maxX && !atWideEdge.right &&
            hostCols(smallGeometry) === hostCols(wideGeometry) &&
            afterSmallResize.clip === atWideEdge.clip && afterSmallResize.x === atWideEdge.x &&
            afterSmallResize.maxX > atWideEdge.maxX && afterSmallResize.right,
            JSON.stringify({plan:resizePlan,beforeGeometry:wideGeometry,afterGeometry:smallGeometry,before:atWideEdge,after:afterSmallResize}));
        await page.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:afterSmallResize.cx,y:afterSmallResize.cy,deltaX:2000,deltaY:0});

        // Exercise real engine selection after an X pan, with a deterministic word in a hidden column.
        await cli.ok(['pane','send','--target',paneID,"printf '\\033[10;90HREVIEWWORD\\033[1;1H'"]);
        await sleep(200);
        const wordGeometry=await geometry(paneID);
        const wordView=await viewport();
        const point={x:wordView.canvasX+91*wordGeometry.cellWidth,y:wordView.canvasY+9.5*wordGeometry.cellHeight};
        await page.eval(`(() => {window.__reviewSavedClipboardWrite=navigator.clipboard.writeText;
            navigator.clipboard.writeText=async text=>{window.__reviewCopied=text;};})()`);
        try {
            await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:2});
            await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:2});
            await sleep(100);
            const selection=await page.eval(`({copied:window.__reviewCopied,length:document.querySelector('${paneRoot(paneID)}').dataset.terminalSelection})`);
            rec.check('real double-click selects the visible panned word',selection.copied==='REVIEWWORD',JSON.stringify({point,selection,viewport:await viewport()}));
        } finally {
            await page.eval(`navigator.clipboard.writeText=window.__reviewSavedClipboardWrite;delete window.__reviewSavedClipboardWrite;delete window.__reviewCopied`);
        }
        // Real phone form factor and trusted two-finger input, not synthetic TouchEvents.
        const savedPlace = await page.eval(`localStorage.getItem('kelpi.phone.last-place')`);
        try {
            await page.eval(`localStorage.setItem('kelpi.phone.last-place', JSON.stringify({host:'origin',workspaceID:'${workspaceID}'}))`);
            await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
            rec.check('phone form factor has a live mirrored pane', await d.settleDom(page,
                `document.documentElement.dataset.formFactor === 'phone' && document.querySelector('${paneRoot(paneID)}[data-terminal-mirror="120x30"]')`));
            // 60 rows guarantees a vertical pan axis on the phone as well as the desktop.
            observer.send(ptyFrame(4, paneID, gridPayload(120, 60)));
            await d.settle(async () => (await geometry(paneID))?.mirror === '120x60');
            const phoneBefore = await viewport();
            // Reset through the actual wheel route before measuring the touch gesture.
            await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: phoneBefore.cx, y: phoneBefore.cy,
                deltaX: -10000, deltaY: -10000 });
            await d.settle(async () => (await viewport())?.x === 0 && (await viewport())?.y === 0);
            const v = await viewport();
            await page.touch('touchStart', [{ x: v.cx + 30, y: v.cy + 50 }, { x: v.cx + 70, y: v.cy + 50 }]);
            for (let i = 1; i <= 8; i++) {
                await page.touch('touchMove', [{ x: v.cx + 30 - i * 10, y: v.cy + 50 - i * 10 },
                    { x: v.cx + 70 - i * 10, y: v.cy + 50 - i * 10 }]);
                await sleep(20);
            }
            await page.touch('touchEnd', []);
            const phoneAfter = await viewport();
            rec.check('two fingers pan both axes on a phone without moving the pane root',
                phoneAfter.x > 40 && phoneAfter.y > 40 && phoneAfter.rootX === 0 && phoneAfter.rootY === 0 &&
                (await geometry(paneID))?.mirror === '120x60', JSON.stringify(phoneAfter));
            const phoneIme = await imeGeometry();
            rec.check('IME caret and composition follow both phone pan axes',
                Math.abs(phoneIme.area[0] - phoneIme.canvas[0] - parseFloat(phoneIme.areaStyle[0]) + phoneIme.canvasOffset[0]) < 1 &&
                Math.abs(phoneIme.area[1] - phoneIme.canvas[1] - parseFloat(phoneIme.areaStyle[1]) + phoneIme.canvasOffset[1]) < 1 &&
                phoneIme.pre[0] === phoneIme.area[0] && phoneIme.pre[1] === phoneIme.area[1], JSON.stringify(phoneIme));
            await rec.shot(page, 'phone-two-finger-pan');
        } finally {
            await page.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
            await page.send('Emulation.clearDeviceMetricsOverride');
            await page.eval(savedPlace === null ? `localStorage.removeItem('kelpi.phone.last-place')` :
                `localStorage.setItem('kelpi.phone.last-place', ${JSON.stringify(savedPlace)})`);
            observer.send(ptyFrame(4, paneID, gridPayload(120, 30)));
        }
        await page.send('Emulation.clearDeviceMetricsOverride');
        await d.settle(async () => (await geometry(paneID))?.mirror === '120x30', { ceilingMs: 8000 });

        // ── 6. the chip takes it back: own box again, and the PTY follows ───────────
        await page.click('[data-testid="take-size-control"]');
        const reclaimed = await d.settle(async () => {
            const g = await geometry(paneID);
            return g?.mirror === null && canvasCols(g) === hostCols(g) && canvasCols(g) === windowCols;
        }, { ceilingMs: 8000 });
        const back = await geometry(paneID);
        rec.note(`after take-size-control: ${JSON.stringify(back)}`);
        rec.check(
            'taking size control puts the engine back on the window box',
            reclaimed,
            `${String(back?.mirror)} · canvas ${String(canvasCols(back))} vs host ${String(hostCols(back))}`
        );
        rec.check('taking size control clears the pan offsets', (await viewport())?.x === 0 && (await viewport())?.y === 0);
        rec.check(
            'and the chip goes away again',
            await d.settleDom(page, `document.querySelector('[data-testid="take-size-control"]') === null`)
        );

        // The PTY itself, asked inside the pane: the ioctl followed the takeover, not the observer.
        await cli.ok(['pane', 'send', '--target', paneID, `printf 'COLS=%s\\n' "$(tput cols)"`]);
        const ptyCols = await d.settle(async () => /COLS=(\d+)/.test(await cli.ok(['pane', 'capture', '--target', paneID])), {
            ceilingMs: 8000
        });
        const reported = /COLS=(\d+)/.exec(await cli.ok(['pane', 'capture', '--target', paneID]));
        const columns = Number(reported?.[1] ?? 0);
        rec.check(
            'the PTY is the window\'s width again, not the observer\'s',
            ptyCols && columns !== OWNER_COLS && columns !== 120 && Math.abs(columns - canvasCols(back)) <= 1,
            `tput cols = ${String(columns)}, canvas = ${String(canvasCols(back))}`
        );
        await rec.shot(page, 'after-taking-size-control');
    } finally {
        await page.send('Emulation.clearDeviceMetricsOverride');
        observer.close();
        await sleep(200);
        /*
         * The workspace this scenario opened for itself goes when this scenario does. In a battery
         * every scenario shares one sandbox, and a workspace left behind changes what `Default`
         * holds, moves every later workspace's ⌘-digit ordinal, and leaves the window looking
         * somewhere its successor did not choose (#205 ▸ cleanup discipline).
         */
        for (const workspace of JSON.parse(await cli.ok(['workspace', 'list', '--json']))) {
            if (!initialWorkspaceIDs.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        }
        if (startingWorkspace !== null) {
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);
        }
    }
}

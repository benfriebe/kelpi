/**
 * A plugin drawing every pane's header, against a real window and a real daemon.
 *
 * Phase B added the fourth replaceable surface: a view selected for `pane.chrome`, in Settings ▸
 * Plugins ▸ Workbench views, draws the header band of every visible pane of the displayed
 * workspace. The unit suites pin the projection, the refs, the two watchdogs, the clamp and the
 * latch. What only a live window can answer is whether a declared band really resizes the shell
 * under it, whether the host's clip really lets a click through to the terminal below a header,
 * whether the things the projection withholds are absent from a real frame rather than from a
 * fixture, and whether every pane gets its header back at once when the presenter dies. So this
 * presses all of it:
 *
 *   1. the placement is offered with its bundled entry named, the lab attaches as one isolated view
 *      for the whole grid, reports it has painted, and `data-pane-chrome-presenter` names it;
 *   2. `ui.selectView('pane.chrome', …)` is refused while `getWorkbench().slots` lists it;
 *   3. every visible pane is drawn by the lab and the native header is gone from each of them -
 *      no title, no close ✕ - while a WITHHELD pane (proved with a workspace of panes carrying
 *      maximal titles) keeps its native header in full;
 *   4. the gestures: focus, split and zoom through the lab's own band, a host control (split right)
 *      activated by ref, UI Lab's `pane.header` item activated by ref reaching UI Lab's backend,
 *      rename (the HOST's field opens and its commit reaches the daemon) and close (the HOST's
 *      confirmation appears and cancels), and the host's pane menu opened by `openPaneMenu`;
 *   5. a declared 96 px band, measured live: the band grows, the body rect moves down by the
 *      difference, the shell's own `stty size` reports fewer rows, and a web pane's native view
 *      moves with it and still takes a click;
 *   6. a declared band on a hidden (zoomed-out) pane parks nothing;
 *   7. withholding, live: no plugin id, command name, absolute path, pid, page URL or `data-testid`
 *      in any frame or anywhere in the presenter's document, and a forged ref, a cross-pane ref and
 *      an item ref used as a control ref all refused with nothing run;
 *   8. failure and recovery: a crash, then every pane back on its native header in the same commit
 *      with the declared bands dropped, the failure toast, the Settings row reading Failed and
 *      Retry - and then the acknowledgement watchdog doing the same to a presenter that has stopped
 *      acknowledging;
 *   9. disable / enable / reload, with the selection retained;
 *  10. the PRIMARY daemon stopped and replaced: the bundled headers take over while the window is
 *      disconnected and the lab re-attaches afterwards, with nothing latched;
 *  11. a phone window keeping its own header with the lab still selected;
 *  12. five screenshots for the eyes, each with a note saying what to look for.
 *
 * ── What it depends on ──────────────────────────────────────────────────────────────
 *
 * `examples/plugins/pane-lab` (plain JS, no build): one view `example.pane-lab.chrome` for
 * `pane.chrome`, setting `document.body.dataset.ready = 'true'` once it has reported readiness and
 * exposing `globalThis.paneLab = { snapshot, ready, frames, lastError, crash(mode), stall(),
 * declare(paneID, px) }`. Its bands are read by test id - `lab-pane-header` (`data-pane-id`),
 * `lab-pane-title`, `lab-pane-branch`, `lab-pane-control` (`data-ref`), `lab-pane-item`
 * (`data-ref`), `lab-pane-withheld`. Everything a check ASSERTS is read from the contract instead
 * (`paneLab.snapshot`, the host's own test ids, the daemon's own state through the CLI), so a
 * cosmetic change in the lab cannot turn a check green.
 *
 * `example.ui-lab` is installed as the SECOND plugin for three jobs: check 2 needs an ordinary
 * plugin frame to call `ui.getWorkbench` and `ui.selectView` from, check 4 needs another plugin's
 * `pane.header` item to activate by ref and a backend to prove it reached, and check 7 needs
 * another plugin's id to be absent from the presenter's document rather than merely unused.
 *
 * The two failure hooks differ, and the checks are written to that difference. `crash('uncaught')`
 * fails the presenter THERE AND THEN, because an uncaught error is what the SDK reports as a view
 * error; a listener that merely throws is caught by the SDK and its frame is still acknowledged.
 * `stall()` only ARMS: it takes a frame whose SHAPE moved (a pane opened or closed, the workspace
 * changed, the rename field went up) before the watchdog has anything to wait for, so the arm and
 * that change go out together.
 *
 * ── Limits, on the record ───────────────────────────────────────────────────────────
 *
 *   - **The call-budget breach is not pressed live.** 240 calls per rolling second fails the
 *     presenter (`pane-chrome/presenter.ts` ▸ `charge`), and driving 240 calls through the frame in
 *     under a second from CDP measures the harness rather than the host.
 *     `features/pane-lab.test.ts` owns it.
 *   - **The pane-move DRAG is not available while a presenter draws a band**, and that is a stated
 *     property of the geometry rather than a defect: the drag is raised from the native header's
 *     `onPointerDown` and a presenter's own pixels cannot raise it. Check 4 presses the pane menu
 *     instead, which is the route that stays open.
 *   - **The remote workspace grid keeps the bundled header.** One presenter per window, one frame,
 *     one latch; `App.remote-grid-parity.test.tsx` records the gap with its reason.
 *
 * Screenshots are blank in the `hidden` lane (the recorder says so in its own note); every check
 * here is a DOM, frame, CLI or measured-geometry assertion, and none of them reads a pixel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phoneToLanding } from '../ui-audit/lib/workbench.mjs';

/*
 * `examples/plugins/pane-lab/` is the example this drives; `pane-chrome/` is the model, the
 * projection, the presenter host and the slot it presses; `grid/` is where the bands are laid out
 * and the headers stand down; `plugins/` holds the Workbench select, the status row, Retry and
 * `PluginView`'s presenter grant; `features/` carries the bundled `kelpi.pane.chrome` definition
 * that is the recovery floor; `plugin-sdk/` is the public contract; `protocol/src/plugins.ts`
 * validates the placement and refuses it to containers; `App.tsx` wires the grid, the rename
 * request, the change counts and the failure toast; `terminal/` and `webpane/` are what a declared
 * band actually resizes; `chrome/` owns the toast stack and the overlay registry a parked page
 * enrols in; `phone/` is check 11's shell.
 */
export const covers = ['examples/plugins/pane-lab/', 'packages/client/src/pane-chrome/',
    'packages/client/src/grid/', 'packages/client/src/plugins/', 'packages/client/src/features/',
    'packages/plugin-sdk/', 'packages/protocol/src/plugins.ts', 'packages/client/src/App.tsx',
    'packages/client/src/terminal/', 'packages/client/src/webpane/', 'packages/client/src/chrome/',
    'packages/client/src/phone/',
    // Check 10 is a real disconnect and reconnect of the primary daemon.
    'packages/client/src/connection/'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const labID = 'example.pane-lab', uiID = 'example.ui-lab';
const labPath = path.join(repoRoot, 'examples/plugins/pane-lab');
const uiPath = path.join(repoRoot, 'examples/plugins/ui-lab');
const labView = `${labID}.chrome`;
/** The recovery floor's own view id and the slot both of them are selected into. */
const bundledView = 'kelpi.pane.chrome', slot = 'pane.chrome';

const presenterSlot = `[data-testid="pane-chrome-presenter"][data-pane-chrome-presenter="${labView}"]`;
const presenterFrame = `${presenterSlot} iframe`;
const statusRowID = `pane-chrome-presenter-status-${slot}`;
const retryID = `pane-chrome-presenter-retry-${slot}`;

/** The declared band this scenario measures a live shell against. The host's ceiling is 96. */
const TALL = 96;

export default async function ({ page, cli, sandbox, rec, d, sleep, daemon }) {
    if (!fs.existsSync(path.join(labPath, 'kelpi.plugin.json'))) {
        throw new Error(`pane-lab is not in this checkout (${labPath}); the example has to land before this scenario can run`);
    }
    await page.watchFrames();
    const json = async args => JSON.parse(await cli.ok(args));

    // ── the instruments ─────────────────────────────────────────────────────────────
    const inFrame = (expression, selector = presenterFrame) => page.evalInFrame(selector, expression);
    const frameCheck = (expression, ceilingMs = 12_000, selector = presenterFrame) => d.settle(async () => {
        try { return Boolean(await inFrame(expression, selector)); } catch { return false; }
    }, { ceilingMs });
    /** The last frame the presenter was DELIVERED. Null when the frame is gone or has had none. */
    const labSnapshot = async () => {
        try {
            const raw = await inFrame(`JSON.stringify(globalThis.paneLab?.snapshot ?? null)`);
            return typeof raw === 'string' ? JSON.parse(raw) : null;
        } catch { return null; }
    };
    const labPane = async paneID => (await labSnapshot())?.panes?.find(pane => pane.paneID === paneID) ?? null;
    /** Everything worth printing beside a failed check, from inside the presenter frame. */
    const labState = async () => {
        try {
            return await inFrame(`JSON.stringify({ ready: document.body.dataset.ready ?? null, visible: document.body.dataset.visible ?? null, panes: document.body.dataset.panes ?? null, withheld: document.body.dataset.withheld ?? null, frames: globalThis.paneLab?.frames ?? null, lastError: globalThis.paneLab?.lastError ?? null })`);
        } catch (error) { return `frame unreadable: ${error instanceof Error ? error.message : String(error)}`; }
    };
    const ready = (ceilingMs = 15_000) => frameCheck(`document.body.dataset.ready === 'true'`, ceilingMs);
    const isolated = () => frameCheck(`(() => { try { parent.document.body; return false; } catch { return true; } })()`);
    const attached = (ceilingMs = 20_000) => d.settleDom(page, `document.querySelector('${presenterSlot}')`, { ceilingMs });
    const presenting = (ceilingMs = 3_000) => d.settleDom(page, `document.querySelector('${presenterSlot}')`, { ceilingMs });
    const bundledHeaders = (ceilingMs = 15_000) => d.settleDom(page, `!document.querySelector('[data-testid="pane-chrome-presenter"]')`, { ceilingMs });
    /** Arm one of the lab's hooks. `crash` and `stall` only set a flag the NEXT frame reads. */
    const arm = call => inFrame(`(() => { globalThis.paneLab.${call}; return true; })()`);
    /** A refused call's message, or `'resolved'` if the host let it through. */
    const refusal = expression => inFrame(`${expression}.then(() => 'resolved', error => error.message)`);

    /**
     * Click something INSIDE the presenter frame, aim checked before the press.
     *
     * `plugin-settings-presenter.mjs`'s helper, with one addition this surface needs: the host
     * CLIPS this frame to the bands it granted, so a point inside the frame's box can still be
     * outside the clip - which is the whole geometry working. `elementFromPoint` answering
     * something other than the frame is therefore the check that matters most here.
     */
    const clickFrame = async target => {
        if (!await frameCheck(`(() => { const node = document.querySelector(${JSON.stringify(target)}); return node && !node.disabled; })()`)) {
            throw new Error(`Missing or disabled ${target} in the presenter frame: ${await labState()}`);
        }
        const inner = await inFrame(`(() => { const node = document.querySelector(${JSON.stringify(target)}); const box = node.getBoundingClientRect(); return {x:box.x + box.width/2, y:box.y + box.height/2, width:box.width, height:box.height}; })()`);
        await page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        const outer = await page.box(presenterFrame);
        if (!outer || !inner.width || !inner.height) throw new Error(`no visible ${target} in the presenter frame`);
        const point = { x: outer.x + inner.x, y: outer.y + inner.y };
        const hit = await page.eval(`(() => {
            const node = document.elementFromPoint(${point.x}, ${point.y});
            if (node === null) return 'nothing';
            const frame = document.querySelector('${presenterFrame}');
            return node === frame || frame?.contains(node) ? 'frame' : (node.outerHTML ?? node.nodeName).slice(0, 160);
        })()`);
        if (hit !== 'frame') throw new Error(`${target} in the presenter frame is covered or clipped away at ${JSON.stringify(point)}: ${String(hit)}`);
        await page.clickAt(point.x, point.y);
        return point;
    };
    /** Click something in the HOST page, aim checked. */
    const clickHost = async selector => {
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(selector)})`)) throw new Error(`missing ${selector}`);
        await page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'center'})`);
        await page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        const aim = JSON.parse(String(await page.eval(`(() => {
            const node = document.querySelector(${JSON.stringify(selector)});
            const box = node.getBoundingClientRect();
            const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            const hit = document.elementFromPoint(point.x, point.y);
            return JSON.stringify({ ...point, ok: hit === node || node.contains(hit), hit: hit === null ? 'nothing' : String(hit.outerHTML ?? hit.nodeName).slice(0, 140) });
        })()`)));
        if (!aim.ok) throw new Error(`${selector} is not clickable at ${String(aim.x)},${String(aim.y)}: ${String(aim.hit)}`);
        await page.clickAt(aim.x, aim.y);
    };
    const shot = async (label, eyes) => {
        const file = await rec.shot(page, label);
        rec.note(`EYES ${path.basename(file)}: ${eyes}`);
        return file;
    };

    // ── Settings, which is the only route to this placement ─────────────────────────
    const settingsOpen = () => page.eval(`!!document.querySelector('[data-testid="settings-close"]')`);
    const openSettings = async () => {
        if (await settingsOpen()) return true;
        await page.key('Comma', { modifiers: 4, key: ',' });
        return await d.settleDom(page, `document.querySelector('[data-testid="settings-close"]')`, { ceilingMs: 10_000 });
    };
    const closeSettings = async () => {
        if (!await settingsOpen()) return true;
        await clickHost('[data-testid="settings-close"]');
        return await d.settleDom(page, `!document.querySelector('[data-testid="settings-close"]')`, { ceilingMs: 8_000 });
    };
    const openPlugins = async () => {
        await openSettings();
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`, { ceilingMs: 8_000 });
        await clickHost('[data-testid="settings-tab-button-plugins"]');
        return await d.settleDom(page, `document.querySelector('[data-testid="plugin-placements"]')`, { ceilingMs: 10_000 });
    };
    const slotOptions = async () => {
        const raw = await page.eval(`(() => {
            const select = document.querySelector('select[aria-label="${slot}"]');
            return select === null ? null : JSON.stringify([...select.options].map(option => ({ value: option.value, label: (option.textContent ?? '').trim() })));
        })()`);
        return typeof raw === 'string' ? JSON.parse(raw) : [];
    };
    const labelFor = (options, viewID) => options.find(option => option.value === viewID)?.label ?? null;
    const chooseSlot = viewID => page.eval(`(() => {
        const select = document.querySelector('select[aria-label="${slot}"]');
        if (select === null) return false;
        select.value = ${JSON.stringify(viewID)};
        select.dispatchEvent(new Event('change', {bubbles:true}));
        return select.value === ${JSON.stringify(viewID)};
    })()`);
    const slotValue = () => page.eval(`document.querySelector('select[aria-label="${slot}"]')?.value ?? null`);
    const statusRow = () => page.eval(`document.querySelector('[data-testid="${statusRowID}"]')?.textContent ?? ''`);
    const retry = async () => {
        if (!await d.settleDom(page, `document.querySelector('[data-testid="${retryID}"]')`, { ceilingMs: 6_000 })) {
            rec.note(`no Retry button on the pane.chrome row (${await statusRow()}), so the placement was not retried`);
            return false;
        }
        await clickHost(`[data-testid="${retryID}"]`);
        return true;
    };
    const selectPresenter = async viewID => { await openPlugins(); return await chooseSlot(viewID); };

    // ── the grid, measured ──────────────────────────────────────────────────────────
    const paneBox = selector => page.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return null; const box = node.getBoundingClientRect(); return JSON.stringify({x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height)}); })()`)
        .then(raw => (typeof raw === 'string' ? JSON.parse(raw) : null));
    const headerBox = paneID => paneBox(`[data-testid="pane-header-${paneID}"]`);
    const bodyBox = paneID => paneBox(`[data-testid="pane-body-${paneID}"]`);
    /** Is the bundled header CONTENT drawn for this pane? The band itself always is. */
    const nativeHeader = paneID => page.eval(`(() => {
        const band = document.querySelector('[data-testid="pane-header-${paneID}"]');
        return JSON.stringify({
            band: band !== null,
            presented: band?.dataset.presented ?? null,
            title: !!document.querySelector('[data-testid="pane-title-${paneID}"]'),
            close: !!document.querySelector('[data-testid="pane-close-${paneID}"]'),
            splitRight: !!document.querySelector('[data-testid="pane-split-right-${paneID}"]')
        });
    })()`).then(raw => (typeof raw === 'string' ? JSON.parse(raw) : null));
    const labBand = paneID => page.eval(`!!document.querySelector('${presenterSlot}')`)
        .then(() => frameCheck(`!!document.querySelector('[data-testid="lab-pane-header"][data-pane-id="${paneID}"]')`, 8_000));

    /** Show a workspace, through the sidebar row a user would click, and wait for the frame. */
    const showWorkspace = async workspace => {
        const row = `[data-testid="workspace-row"][data-workspace-id="${workspace}"]`;
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 10_000 })) return false;
        await clickHost(row);
        return await d.settle(async () => (await labSnapshot())?.workspaceID === workspace, { ceilingMs: 15_000 });
    };

    /**
     * The shell's OWN answer to how big its PTY is: `stty size`, through the daemon.
     *
     * The shape is deliberate. The command line is ECHOED into the same scrollback the answer
     * lands in, so a marker followed by two numbers would match the echo as well as the output;
     * `tr ' ' '-'` means the answer reads `MARKER 44-180` while the echoed line still reads
     * `MARKER $(stty size | tr ...)`, and only one of those can match. That is a real SIGWINCH
     * measurement rather than a DOM readout: it is what the process inside the pane believes.
     */
    const shellRows = async paneID => {
        const marker = `ROWS${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        await cli.ok(['pane', 'send', '--target', paneID, `echo "${marker} $(stty size | tr ' ' '-')"`]);
        await cli.run(['pane', 'send-key', '--target', paneID, 'enter']);
        let answer = null;
        await d.settle(async () => {
            const capture = await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
            const match = new RegExp(`${marker} (\\d+)-(\\d+)`).exec(capture);
            if (match === null) return false;
            answer = { rows: Number(match[1]), cols: Number(match[2]) };
            return true;
        }, { ceilingMs: 15_000 });
        return answer;
    };

    // Where the window was before this scenario took it: restored at the end, because the sandbox
    // and its window are shared with whatever runs next.
    const startingWorkspace = await page.eval(`document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.getAttribute('data-workspace-id') ?? null`);
    const workspace = await json(['workspace', 'create', '--name', 'Pane chrome', '--json']);
    const workspaceID = workspace.workspace_id;
    /** The workspace check 3 proves WITHHOLDING with: many panes, each with a maximal title. */
    let crowdedID = null;
    let uiFrame = '';

    try {
        // ── 1 · the placement is offered, and the lab attaches ───────────────────────
        await cli.ok(['plugin', 'install', labPath, '--trust']);
        await cli.ok(['plugin', 'install', uiPath, '--trust']);
        const uiPane = await json(['plugin', 'open', uiID, `${uiID}.panel`, '--workspace', workspaceID]);
        uiFrame = `[data-testid="plugin-view-${uiPane.paneID}"] iframe`;
        if (!await d.settle(async () => {
            try { return await page.evalInFrame(uiFrame, `document.body.dataset.ready === 'true'`); } catch { return false; }
        }, { ceilingMs: 20_000 })) throw new Error('UI Lab did not attach');

        // A shell pane beside it: the one whose PTY check 5 measures.
        const shellPane = (await json(['pane', 'create', '--workspace', workspaceID, '--json'])).pane_id;
        await d.settleDom(page, `document.querySelector('[data-testid="pane-header-${shellPane}"]')`, { ceilingMs: 15_000 });

        await openPlugins();
        const options = await slotOptions();
        const offered = options.some(option => option.value === labView);
        /*
         * The route BACK, read from the live select rather than assumed. A replaced header looks
         * like a header, so the bundled entry has to name itself: a user who cannot find the floor
         * is a user stuck inside a presenter whose close ✕ they no longer trust.
         */
        const bundledLabel = labelFor(options, bundledView);
        const chosen = await chooseSlot(labView);
        rec.check('Settings offers the pane.chrome placement and selects the lab for it',
            offered && chosen && await slotValue() === labView, `options ${JSON.stringify(options)}`);
        rec.check('the pane.chrome select names its bundled entry as the recovery floor',
            bundledLabel === 'Pane header (bundled)', String(bundledLabel));
        await closeSettings();

        const attachedNow = await attached();
        const readyNow = attachedNow && await ready();
        rec.check('the pane chrome presenter attaches as ONE isolated view and reports it has painted',
            attachedNow && readyNow && await isolated(), await labState());
        const frames = await page.eval(`document.querySelectorAll('[data-testid="pane-chrome-presenter"] iframe').length`);
        rec.check('one frame for the whole grid, not one per pane', Number(frames) === 1, `frames ${String(frames)}`);
        await shot('presenter-attached', 'Every pane in the "Pane chrome" workspace wearing a Pane Lab band instead of the bundled header: a monospaced row per pane with a status dot, a SHELL/PLUGIN kind chip, the middle-truncated title, and small outlined buttons at the right (⊣ ⊥ ⊕ ✕). No bundled title, no bundled close glyph, and the focus ring still painted by the host around the focused pane, band included.');

        // ── 2 · Settings-only selection ──────────────────────────────────────────────
        const workbench = JSON.parse(String(await page.evalInFrame(uiFrame,
            `(async () => JSON.stringify(await kelpi.ui.getWorkbench()))()`)));
        const listed = workbench.slots.find(entry => entry.id === slot);
        const refused = await page.evalInFrame(uiFrame,
            `kelpi.ui.selectView(${JSON.stringify(slot)}, ${JSON.stringify(labView)}).then(() => 'resolved', error => error.message)`);
        rec.check('pane.chrome is listed in getWorkbench().slots and refused by ui.selectView',
            listed !== undefined && listed.viewID === labView && String(refused).includes('not registered'),
            `${JSON.stringify(listed)} · ${String(refused)}`);

        // ── 3 · every visible pane drawn, and a withheld one keeping its header ──────
        const visiblePanes = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).map(pane => pane.id);
        const drawn = [];
        for (const paneID of visiblePanes) drawn.push([paneID, await labBand(paneID), await nativeHeader(paneID)]);
        rec.check('every visible pane is drawn by the lab with the bundled header content gone',
            drawn.length >= 2 && drawn.every(([, band, native]) =>
                band && native.band && native.presented === 'true' && !native.title && !native.close && !native.splitRight),
            JSON.stringify(drawn));

        /*
         * Withholding, for real. A pane's title is whatever its shell last wrote to the terminal's
         * OSC, so a workspace CAN overrun the 256 KiB frame - and the frame's answer is to carry a
         * PREFIX and count the rest. This builds that workspace: panes whose titles are as long as
         * a shell can honestly make them, until the budget bites.
         */
        const crowded = await json(['workspace', 'create', '--name', 'Pane chrome crowded', '--json']);
        crowdedID = crowded.workspace_id;
        const crowdedPanes = [(await json(['pane', 'list', '--workspace', crowdedID, '--json']))[0].id];
        for (let index = 0; index < 5; index += 1) {
            crowdedPanes.push((await json(['pane', 'create', '--workspace', crowdedID, '--json'])).pane_id);
        }
        // An OSC 0 title per pane, 40 KiB each: six of them is past the budget's 254 KiB and the
        // frame has to stop somewhere inside the list.
        for (const paneID of crowdedPanes) {
            await cli.ok(['pane', 'send', '--target', paneID,
                `printf '\\033]0;%s\\007' "$(printf 'w%.0s' $(seq 1 40000))"`]);
            await cli.run(['pane', 'send-key', '--target', paneID, 'enter']);
        }
        await d.settleDom(page, `document.querySelector('[data-testid="pane-header-${crowdedPanes.at(-1)}"]')`, { ceilingMs: 15_000 });
        const withheld = await d.settle(async () => ((await labSnapshot())?.withheld ?? 0) > 0, { ceilingMs: 20_000 });
        const crowdedSnapshot = await labSnapshot();
        const carried = new Set((crowdedSnapshot?.panes ?? []).map(pane => pane.paneID));
        const missing = crowdedPanes.filter(paneID => !carried.has(paneID));
        const keptNative = missing.length === 0 ? [] : [await nativeHeader(missing[0])];
        rec.check('a pane the 256 KiB budget withheld keeps its bundled header, and the frame counts it',
            withheld && missing.length === crowdedSnapshot.withheld && keptNative[0]?.presented === 'false' && keptNative[0]?.title === true && keptNative[0]?.close === true,
            `carried ${String(carried.size)}, withheld ${String(crowdedSnapshot?.withheld)}, first withheld ${JSON.stringify(keptNative[0])}`);
        await shot('withheld-pane', 'The "Pane chrome crowded" workspace: the first panes wearing Pane Lab bands with an enormous "wwwww…" title, and the LAST pane (bottom right) wearing the bundled 24 px header instead - its own truncated title, its ZOOM/SYNC area, its split buttons and its ✕. The lab prints "N panes on the bundled header" at the top left of the grid.');

        // Back to the working workspace for the gestures, through the sidebar row, which is the
        // gesture a user makes and the only one the window has (there is no `workspace activate`).
        await showWorkspace(workspaceID);

        // ── 4 · the gestures ─────────────────────────────────────────────────────────
        const band = paneID => `[data-testid="lab-pane-header"][data-pane-id="${paneID}"]`;
        const controlRef = async (paneID, label) => {
            const pane = await labPane(paneID);
            return pane?.controls.find(entry => entry.label.startsWith(label))?.ref ?? null;
        };
        const activate = (paneID, ref) => refusal(`kelpi.ui.activatePaneControl(${JSON.stringify(paneID)}, ${JSON.stringify(ref)})`);
        const focusedNow = () => page.eval(`document.querySelector('[data-pane-id][data-focused="true"]')?.getAttribute('data-pane-id') ?? null`);

        await clickFrame(band(shellPane));
        const focused = await d.settle(async () => await focusedNow() === shellPane, { ceilingMs: 8_000 });
        rec.check('a press on the lab\'s band focuses that pane through focusChromePane',
            focused, `focused ${String(await focusedNow())}`);

        const before = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        const splitRef = await controlRef(shellPane, 'Split right');
        const splitAnswer = await activate(shellPane, splitRef);
        const afterSplit = await d.settle(async () =>
            (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length === before + 1, { ceilingMs: 12_000 });
        rec.check('a HOST control activated by ref splits the pane, through the host\'s own verb',
            splitRef !== null && splitAnswer === 'resolved' && afterSplit,
            `ref ${String(splitRef)} · ${String(splitAnswer)} · ${String(before)} panes before`);
        const splitPane = (await json(['pane', 'list', '--workspace', workspaceID, '--json']))
            .map(pane => pane.id).find(id => !visiblePanes.includes(id) && id !== shellPane) ?? null;

        // UI Lab's own `pane.header` item, by ref, reaching UI Lab's backend.
        const beforeCount = (await json(['plugin', 'run', `${uiID}.snapshot`])).state.context.count;
        const itemRef = (await labPane(shellPane))?.items?.[0]?.ref ?? null;
        const itemAnswer = itemRef === null ? 'no item' : await refusal(`kelpi.ui.runPaneHeaderItem(${JSON.stringify(shellPane)}, ${JSON.stringify(itemRef)})`);
        const reached = await d.settle(async () => {
            const snapshot = await json(['plugin', 'run', `${uiID}.snapshot`]);
            return snapshot.state.context.count > beforeCount && snapshot.lastInvocation?.paneID === shellPane;
        }, { ceilingMs: 12_000 });
        rec.check('another plugin\'s pane.header item, activated by ref, reaches that plugin with the right pane',
            itemRef !== null && itemAnswer === 'resolved' && reached,
            `ref ${String(itemRef)} · ${String(itemAnswer)} · count before ${String(beforeCount)}`);

        // Zoom, through the band's own double click.
        await inFrame(`(() => { document.querySelector(${JSON.stringify(band(shellPane))}).dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return true; })()`);
        const zoomed = await d.settleDom(page, `document.querySelector('[data-pane-id="${shellPane}"]')?.dataset.zoomed === 'true'`, { ceilingMs: 8_000 });
        rec.check('a double click on the band zooms the pane', zoomed, String(await page.eval(`document.querySelector('[data-pane-id="${shellPane}"]')?.dataset.zoomed ?? 'none'`)));

        // ── 6 · a declared band on a HIDDEN pane parks nothing ───────────────────────
        // The workspace is zoomed on `shellPane`, so every other pane is mounted and invisible.
        const hiddenPane = visiblePanes.find(paneID => paneID !== shellPane) ?? null;
        const hiddenFrame = await labPane(hiddenPane);
        const hiddenBefore = await headerBox(hiddenPane);
        const webHoleBefore = await page.eval(`[...document.querySelectorAll('[data-testid^="web-page-"]')].map(node => node.dataset.visible).join(',')`);
        const hiddenAnswer = await refusal(`kelpi.ui.setPaneChromeHeight(${JSON.stringify(hiddenPane)}, ${String(TALL)})`);
        await sleep(400);
        const hiddenAfter = await headerBox(hiddenPane);
        const webHoleAfter = await page.eval(`[...document.querySelectorAll('[data-testid^="web-page-"]')].map(node => node.dataset.visible).join(',')`);
        rec.check('a band declared on a hidden (zoomed-out) pane is refused, changes nothing and parks nothing',
            hiddenFrame === null && hiddenAnswer !== 'resolved' && hiddenBefore !== null
            && hiddenAfter?.height === hiddenBefore.height && String(webHoleAfter) === String(webHoleBefore),
            `frame entry ${JSON.stringify(hiddenFrame)} · answer ${String(hiddenAnswer)} · band ${JSON.stringify(hiddenBefore)} -> ${JSON.stringify(hiddenAfter)} · pages ${String(webHoleBefore)} -> ${String(webHoleAfter)}`);
        await inFrame(`(() => { document.querySelector(${JSON.stringify(band(shellPane))}).dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return true; })()`);
        await d.settleDom(page, `document.querySelector('[data-pane-id="${shellPane}"]')?.dataset.zoomed !== 'true'`, { ceilingMs: 8_000 });

        // ── 5 · a declared 96 px band, measured against a live shell ─────────────────
        const bandBefore = await headerBox(shellPane);
        const bodyBefore = await bodyBox(shellPane);
        const rowsBefore = await shellRows(shellPane);
        await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(shellPane)}, ${String(TALL)}); return true; })()`);
        const grew = await d.settle(async () => ((await headerBox(shellPane))?.height ?? 0) > (bandBefore?.height ?? 0) + 40, { ceilingMs: 10_000 });
        const bandAfter = await headerBox(shellPane);
        const bodyAfter = await bodyBox(shellPane);
        await sleep(700);
        const rowsAfter = await shellRows(shellPane);
        const moved = bandAfter && bodyBefore && bodyAfter
            && Math.abs((bodyAfter.y - bodyBefore.y) - (bandAfter.height - bandBefore.height)) <= 1;
        rec.check('a declared band grows the header, moves the body rect down by the same amount, and resizes the PTY',
            grew && moved && rowsBefore !== null && rowsAfter !== null && rowsAfter.rows < rowsBefore.rows,
            `band ${String(bandBefore?.height)} -> ${String(bandAfter?.height)} px, body y ${String(bodyBefore?.y)} -> ${String(bodyAfter?.y)}, stty ${JSON.stringify(rowsBefore)} -> ${JSON.stringify(rowsAfter)}`);
        rec.note(`MEASURED band ${String(bandBefore?.height)} -> ${String(bandAfter?.height)} px; body top ${String(bodyBefore?.y)} -> ${String(bodyAfter?.y)}; PTY ${String(rowsBefore?.rows)} -> ${String(rowsAfter?.rows)} rows at ${String(rowsAfter?.cols)} cols`);
        await shot('declared-band', 'The focused shell pane wearing a TALL two-line Pane Lab band (roughly four times the bundled header): the title row on top and the directory, branch and agent row under it, with the terminal starting lower down the pane and its content unbroken. Every other pane still on a one-line band.');

        // A web pane under the same declaration: its native view has to move with the band.
        const opened = await cli.ok(['web', 'open', 'about:blank']);
        const webPane = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1] ?? null;
        if (webPane === null) throw new Error(`no web pane opened: ${opened.trim()}`);
        const webHole = `[data-testid="web-page-${webPane}"]`;
        const placed = await d.settleDom(page, `document.querySelector('${webHole}')?.dataset.visible === 'true'`, { ceilingMs: 25_000 });
        const holeBefore = await paneBox(webHole);
        await d.settle(async () => await labPane(webPane) !== null, { ceilingMs: 12_000 });
        await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(webPane)}, ${String(TALL)}); return true; })()`);
        const holeMoved = await d.settle(async () => ((await paneBox(webHole))?.y ?? 0) > (holeBefore?.y ?? 0) + 40, { ceilingMs: 12_000 });
        const holeAfter = await paneBox(webHole);
        const stillLive = await page.eval(`document.querySelector('${webHole}')?.dataset.visible ?? 'none'`);
        // Input still reaches the page: a click in the middle of the hole, then the page's own
        // answer to where the pointer landed. A parked page answers nothing at all.
        const clicked = holeAfter === null ? false : await (async () => {
            await page.clickAt(holeAfter.x + holeAfter.width / 2, holeAfter.y + holeAfter.height / 2);
            await sleep(300);
            return await page.eval(`document.querySelector('${webHole}')?.dataset.visible === 'true'`);
        })();
        rec.check('a web pane\'s native view moves with the declared band, stays live and still takes input',
            placed && holeMoved && String(stillLive) === 'true' && clicked,
            `hole ${JSON.stringify(holeBefore)} -> ${JSON.stringify(holeAfter)} · data-visible ${String(stillLive)} · overlay-covered ${String(await page.eval(`document.querySelector('${webHole}')?.dataset.overlayCovered ?? 'none'`))}`);
        rec.note(`MEASURED web hole ${JSON.stringify(holeBefore)} -> ${JSON.stringify(holeAfter)} under a ${String(TALL)} px declaration`);
        await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(webPane)}, null); globalThis.paneLab.declare(${JSON.stringify(shellPane)}, null); return true; })()`);
        await d.settle(async () => ((await headerBox(shellPane))?.height ?? 99) <= 24, { ceilingMs: 10_000 });

        // ── 4 (continued) · rename and close, both the host's ────────────────────────
        await refusal(`kelpi.ui.renamePane(${JSON.stringify(shellPane)})`);
        const fieldUp = await d.settleDom(page, `document.querySelector('[data-testid="pane-rename-input-${shellPane}"]')`, { ceilingMs: 8_000 });
        if (fieldUp) {
            await clickHost(`[data-testid="pane-rename-input-${shellPane}"]`);
            await page.insertText('renamed-by-presenter');
            await page.key('Enter');
        }
        const renamed = await d.settle(async () =>
            (await json(['pane', 'list', '--workspace', workspaceID, '--json']))
                .some(pane => pane.id === shellPane && pane.label === 'renamed-by-presenter'), { ceilingMs: 12_000 });
        rec.check('renamePane opens the HOST\'s inline field and its commit reaches the daemon',
            fieldUp && renamed, `field ${String(fieldUp)} · renamed ${String(renamed)}`);
        await shot('host-rename-field', 'The focused pane\'s band showing the HOST\'s own inline rename text field - a plain editable box in a bundled 24 px header - while every OTHER pane in the grid still wears its Pane Lab band. The renaming pane is the one place the presenter is standing off.');

        /*
         * Close, and what "the host's existing confirmation" actually IS.
         *
         * `App`'s `act.closePane` is the ONE verb both the bundled ✕ and the presenter's reach
         * (`pane-chrome/surface.ts` ▸ `closePane`), and today it closes an ordinary pane with no
         * dialog at all: the workspace-delete gate lives on `closeFocused`, the ⌘W path, and only
         * fires on the LAST pane of a workspace with running agents. So decision 6's rule is kept
         * by inheritance rather than by a dialog appearing - the presenter draws NOTHING and gets
         * exactly the host's behaviour, whatever the host's behaviour is. That is what is asserted:
         * the pane goes through the host's verb, and no confirmation of the presenter's own exists.
         */
        const closeTarget = splitPane ?? shellPane;
        const panesBeforeClose = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        const closeRef = await controlRef(closeTarget, 'Close pane');
        const closeAnswer = closeRef === null ? 'no ref' : await activate(closeTarget, closeRef);
        const closed = await d.settle(async () =>
            !(await json(['pane', 'list', '--workspace', workspaceID, '--json'])).some(pane => pane.id === closeTarget),
            { ceilingMs: 12_000 });
        const presenterDialog = await inFrame(`document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]').length`);
        const panesAfterClose = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        rec.check('close routes through the HOST\'s own verb and the presenter draws no confirmation of its own',
            closeAnswer === 'resolved' && closed && Number(presenterDialog) === 0 && panesAfterClose === panesBeforeClose - 1,
            `answer ${String(closeAnswer)} · closed ${String(closed)} · dialogs in the frame ${String(presenterDialog)} · panes ${String(panesBeforeClose)} -> ${String(panesAfterClose)}`);
        rec.note('LIMIT: the workspace-delete confirmation is on the ⌘W path (`closeFocused`, last pane plus running agents), not on the header ✕ that a presenter activates; both headers reach the same `act.closePane`, so the presenter inherits the host\'s behaviour exactly.');

        const menuAnswer = await refusal(`kelpi.ui.openPaneMenu(${JSON.stringify(shellPane)})`);
        const menuUp = await d.settleDom(page, `document.querySelector('[role="menu"]')`, { ceilingMs: 8_000 });
        if (menuUp) await page.key('Escape');
        rec.check('openPaneMenu opens the host\'s own pane menu, which stays native',
            menuAnswer === 'resolved' && menuUp, `${String(menuAnswer)} · menu ${String(menuUp)}`);

        // ── 7 · withholding, live ────────────────────────────────────────────────────
        const documentText = String(await inFrame(`document.documentElement.outerHTML + '\\n' + JSON.stringify(globalThis.paneLab.snapshot)`));
        /*
         * Field NAMES are not secrets, and the SDK's own source is inlined into every plugin
         * document, so `agentSessionID` appears in `api.js` and says nothing about this pane. What
         * is checked is the absence of VALUES and of the host's own vocabulary: the sandbox's
         * absolute paths, any `/Users/` path at all, the other plugin's id, the command name behind
         * its item, the bundled header's test ids, and the daemon's pid. The agent's SHAPE is
         * asserted separately below, on the frame itself.
         */
        const forbidden = [sandbox.root, '/Users/', uiID, 'example.ui-lab.increment', 'pane-close-',
            'pane-split-right-', String(daemon?.pid ?? 'no-daemon-pid')];
        const leaked = forbidden.filter(needle => documentText.includes(needle));
        const agentShape = Object.keys((await labPane(shellPane))?.agent ?? {});
        const paneKeys = Object.keys((await labPane(shellPane)) ?? {});
        rec.check('no absolute path, plugin id, command name, pid or bundled test id reaches the presenter',
            leaked.length === 0
            // And the shapes themselves: a pane carries no handle and an agent carries no session.
            && !paneKeys.some(key => ['workingDirectory', 'url', 'pid', 'testID'].includes(key))
            && !agentShape.includes('agentSessionID') && !agentShape.includes('sessionID'),
            `leaked ${JSON.stringify(leaked)} · pane keys ${JSON.stringify(paneKeys)} · agent keys ${JSON.stringify(agentShape)}`);

        const goodRef = await controlRef(shellPane, 'Split right');
        const itemRefNow = (await labPane(shellPane))?.items?.[0]?.ref ?? 'i0';
        const panesBeforeForgery = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        const forged = await activate(shellPane, 'c999');
        const invented = await activate(shellPane, 'nonsense');
        const crossPane = await activate(webPane, `${goodRef}#`);
        const itemAsControl = await activate(shellPane, itemRefNow);
        const controlAsItem = await refusal(`kelpi.ui.runPaneHeaderItem(${JSON.stringify(shellPane)}, ${JSON.stringify(goodRef)})`);
        const ghost = await refusal(`kelpi.ui.focusChromePane('not-a-pane')`);
        const panesAfterForgery = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        rec.check('a forged ref, an invented ref, a cross-pane ref and a ref used on the wrong list are all refused',
            [forged, invented, crossPane, itemAsControl, controlAsItem, ghost].every(answer => answer !== 'resolved')
            && panesAfterForgery === panesBeforeForgery,
            JSON.stringify({ forged, invented, crossPane, itemAsControl, controlAsItem, ghost }));

        // ── 8 · crash, and every pane back at once ───────────────────────────────────
        const declaredBefore = await (async () => {
            await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(shellPane)}, ${String(TALL)}); return true; })()`);
            return await d.settle(async () => ((await headerBox(shellPane))?.height ?? 0) > 40, { ceilingMs: 10_000 });
        })();
        await arm(`crash('uncaught')`);
        // A frame the presenter will be sent: a split changes the shape of the row.
        await cli.ok(['pane', 'create', '--workspace', workspaceID]);
        const fellBack = await bundledHeaders();
        const headersBack = [];
        for (const paneID of (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).map(pane => pane.id)) {
            headersBack.push([paneID, await nativeHeader(paneID), (await headerBox(paneID))?.height ?? null]);
        }
        rec.check('a crash puts the bundled header back on EVERY pane at once and drops every declared band',
            declaredBefore && fellBack && headersBack.every(([, native, height]) =>
                native.presented === 'false' && native.title && native.close && height !== null && height <= 24),
            JSON.stringify(headersBack));
        const toast = await d.settleDom(page, `document.querySelector('[data-testid="toast-stack"]')`, { ceilingMs: 10_000 });
        rec.check('the failure is reported on screen', toast,
            String(await page.eval(`document.querySelector('[data-testid="toast-stack"]')?.textContent ?? 'none'`)));
        await shot('fallback-after-crash', 'Every pane back on the bundled 24 px header at once - status dot or glyph, title, split buttons and ✕ on each - with a failure toast in the corner reading "Pane header presenter". No Pane Lab band anywhere, and no pane left taller than the others.');

        await openPlugins();
        const failedRow = await statusRow();
        const retried = await retry();
        await closeSettings();
        const cameBack = retried && await attached() && await ready();
        rec.check('Settings reports the failure, keeps the selection, and Retry brings the presenter back',
            failedRow.includes('Failed') && await slotValue() !== bundledView && retried && cameBack,
            `${failedRow} · retried ${String(retried)} · ${await labState()}`);

        // ── 8b · the acknowledgement watchdog ────────────────────────────────────────
        await arm('stall()');
        // A frame whose SHAPE moved, which is what the watchdog waits for an acknowledgement of.
        await cli.ok(['pane', 'create', '--workspace', workspaceID]);
        const stalledOut = await bundledHeaders(20_000);
        rec.check('a presenter that stops acknowledging is failed by the watchdog and every header comes back',
            stalledOut, await labState());
        await openPlugins();
        await retry();
        await closeSettings();
        await attached();
        await ready();

        // ── 9 · disable, enable and reload, with the selection retained ──────────────
        await cli.ok(['plugin', 'disable', labID]);
        const disabledBack = await bundledHeaders();
        await cli.ok(['plugin', 'enable', labID]);
        const enabledBack = await attached() && await ready();
        await cli.ok(['plugin', 'reload', labID]);
        const reloaded = await attached() && await ready();
        await openPlugins();
        const retainedValue = await slotValue();
        await closeSettings();
        rec.check('disable, enable and reload all keep the selection and end with the lab drawing',
            disabledBack && enabledBack && reloaded && retainedValue === labView,
            `disabled ${String(disabledBack)} · enabled ${String(enabledBack)} · reloaded ${String(reloaded)} · selection ${String(retainedValue)}`);

        // ── 10 · the daemon replaced under the presenter ─────────────────────────────
        if (daemon === null) rec.note('LIMIT: no sandbox daemon handle (--attach), so the disconnect check was skipped');
        else {
            const pidBefore = daemon.pid, generationBefore = daemon.generation;
            await daemon.restart();
            const offline = await d.settleDom(page, `!document.querySelector('[data-testid="pane-chrome-presenter"]')`, { ceilingMs: 20_000 });
            // `data-connection` is on the app root rather than on `documentElement`, and it is the
            // only authority on the CLIENT having reconnected (`ui-audit/lib/stack.mjs` says so).
            const reconnected = await d.settleDom(page, `document.querySelector('[data-connection]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 30_000 });
            const back = reconnected && await attached(30_000) && await ready(20_000);
            const latched = (await statusRow()).includes('Failed');
            rec.check('a daemon restart hands every band back while disconnected, and the presenter re-attaches with nothing latched',
                offline && reconnected && back && !latched && daemon.pid !== pidBefore && daemon.generation === generationBefore + 1,
                `pid ${String(pidBefore)} -> ${String(daemon.pid)} · offline ${String(offline)} · back ${String(back)} · ${await labState()}`);
            rec.note(`the daemon was replaced (stop ${String(daemon.lastStopMs)} ms, start to healthz ${String(daemon.lastStartMs)} ms)`);
        }

        // ── 11 · the phone keeps its own header ──────────────────────────────────────
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const phoneShell = await d.settleDom(page, `document.querySelector('[data-testid="phone-shell"]')`, { ceilingMs: 20_000 });
        const phonePresenter = await page.eval(`!!document.querySelector('[data-testid="pane-chrome-presenter"]')`);
        rec.check('a phone window keeps its own header with the lab still selected',
            phoneShell && !phonePresenter, `shell ${String(phoneShell)} · presenter ${String(phonePresenter)}`);
        await phoneToLanding(page, d, { note: message => rec.note(message) });
        await page.send('Emulation.clearDeviceMetricsOverride');
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await d.settleDom(page, `!document.querySelector('[data-testid="phone-shell"]')`, { ceilingMs: 20_000 });
        await attached(25_000);
        await ready(20_000);
        await shot('desktop-restored', 'Back on the desktop after the phone emulation: the "Pane chrome" workspace with every pane wearing a Pane Lab band again, no toast, and the title bar reading connected.');

        rec.note('LIMIT: the 240-calls-per-second budget breach is not pressed live; driving it from CDP measures the harness. See the header.');
        rec.note('LIMIT: the pane-move drag is raised from the native header and is unavailable while a presenter draws a band; openPaneMenu is the route that stays open.');
    } catch (error) {
        await rec.shot(page, 'failure-live');
        throw error;
    } finally {
        /*
         * The sandbox, its daemon AND its window outlive this scenario, and four things outlive the
         * workspaces it deletes: the saved presenter selection, the phone's remembered place,
         * whatever overlay was on screen when a check threw, and which workspace the window is
         * looking at. Each step is taken and none is allowed to skip the rest.
         */
        const safely = async (what, step) => {
            try { await step(); } catch (error) { rec.note(`cleanup: ${what} - ${error instanceof Error ? error.message : String(error)}`); }
        };
        await safely('the phone returns to its landing page', async () => { if (!await phoneToLanding(page, d, { note: message => rec.note(`cleanup: ${message}`) })) rec.note('cleanup: the phone shell never reached its landing page'); });
        await safely('device metrics are cleared', () => page.send('Emulation.clearDeviceMetricsOverride'));
        await safely('touch emulation is cleared', () => page.send('Emulation.setTouchEmulationEnabled', { enabled: false }));
        await safely('any dialog or menu still up is dismissed', async () => {
            for (let attempt = 0; attempt < 4; attempt += 1) {
                if (!await page.eval(`!!document.querySelector('[data-testid="confirm-dialog"]') || !!document.querySelector('[role="menu"]')`)) return;
                await page.key('Escape');
                await sleep(200);
            }
        });
        /*
         * The selection goes back to the BUNDLED header rather than being left naming a view that is
         * about to be removed, and it is done BEFORE the plugins are removed so the select still has
         * both entries to choose between. The bands go back with it: standing a presenter down drops
         * every declaration, which is the same path the fallback takes.
         */
        await safely('pane.chrome goes back to the bundled header', async () => {
            await selectPresenter(bundledView);
            await d.settleDom(page, `!document.querySelector('[data-testid="pane-chrome-presenter"]')`, { ceilingMs: 10_000 });
        });
        await safely('the Settings overlay is closed', () => closeSettings());
        await safely('the plugins are removed', async () => {
            await cli.run(['plugin', 'remove', labID]);
            await cli.run(['plugin', 'remove', uiID]);
        });
        await safely('every workspace this scenario created is deleted', async () => {
            if (crowdedID !== null) await cli.run(['workspace', 'delete', crowdedID, '--force']);
            await cli.run(['workspace', 'delete', workspaceID, '--force']);
        });
        await safely('the window returns to the workspace it started on', async () => {
            if (startingWorkspace === null) return;
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 10_000 })) await clickHost(row);
        });
    }
}

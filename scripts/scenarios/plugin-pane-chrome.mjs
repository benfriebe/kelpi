import { executionRoots } from '../ui-audit/lib/execution-roots.mjs';
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
 *      rename (the HOST's field opens and its commit reaches the daemon), close (the HOST's
 *      confirmation appears and cancels), the host's pane menu opened by `openPaneMenu`, and the
 *      pane-move drag from the middle of the lab's own TITLE, through a region the presenter
 *      declared and the host laid its own surface over, with the double click, the right click and
 *      the still-pressable control row beside it;
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
 *   - **The remote workspace grid keeps the bundled header.** One presenter per window, one frame,
 *     one latch; `App.remote-grid-parity.test.tsx` records the gap with its reason.
 *
 * Screenshots are blank in the `hidden` lane (the recorder says so in its own note); every check
 * here is a DOM, frame, CLI or measured-geometry assertion, and none of them reads a pixel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { phoneToLanding } from '../ui-audit/lib/workbench.mjs';

/*
 * `examples/plugins/pane-lab/` is the example this drives; `pane-chrome/` is the model, the
 * projection, the presenter host and the slot it presses; `grid/` is where the bands are laid out
 * and the headers stand down; `plugins/` holds the Workbench select, the status row, Retry and
 * `PluginView`'s presenter grant; `features/` carries the bundled `kelpi.pane.chrome` definition
 * that is the recovery floor; `plugin-sdk/` is the public contract; `protocol/src/plugins.ts`
 * validates the placement, which check 1 is what would catch: a placement missing from
 * `PLUGIN_PLACEMENTS` fails the lab's manifest and the install with it. `App.tsx` wires the grid,
 * the rename request, the caret hand-back, the change counts and the failure toast; `terminal/` and
 * `webpane/` are what a declared band actually resizes and what the find bar and the element picker
 * are read from; `chrome/` owns the toast stack, whose TEXT the fallback check asserts; `phone/` is
 * check 11's shell.
 */
export const covers = ['examples/plugins/pane-lab/', 'packages/client/src/pane-chrome/',
    'packages/client/src/grid/', 'packages/client/src/plugins/', 'packages/client/src/features/',
    'packages/plugin-sdk/', 'packages/protocol/src/plugins.ts', 'packages/client/src/App.tsx',
    'packages/client/src/terminal/', 'packages/client/src/webpane/', 'packages/client/src/chrome/',
    'packages/client/src/phone/',
    // Check 10 is a real disconnect and reconnect of the primary daemon.
    'packages/client/src/connection/'];

/**
 * The lowest lane this can be trusted at.
 *
 * Check 5 drives a REAL native page: it clicks into a web pane's `WebContentsView` and waits for
 * the focus that click causes to come back through the shell and the daemon. `hidden` paints the
 * frame at zero opacity, and AppKit stops counting it as visible the moment anything is in front of
 * it - at which point Chromium drops the synthesized input CDP delivers to that view, exactly as
 * `plugin-browser-features` measured (`ui-audit/lib/placement.mjs`). Every other check here is DOM
 * and would be happy at `hidden`; this one would fail for the lane rather than for the code.
 */
export const windowPlacement = 'offscreen';

const { targetRoot: repoRoot, harnessRoot } = executionRoots();
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
    /**
     * Where something inside the presenter frame is, in the HOST's viewport, aim checked.
     *
     * Split out of `clickFrame` because a drag has to press and move rather than click, and
     * clicking first to find the point would have fired the gesture twice.
     */
    const aimFrame = async (target, fraction = 0.5) => {
        if (!await frameCheck(`(() => { const node = document.querySelector(${JSON.stringify(target)}); return node && !node.disabled; })()`)) {
            throw new Error(`Missing or disabled ${target} in the presenter frame: ${await labState()}`);
        }
        const inner = await inFrame(`(() => { const node = document.querySelector(${JSON.stringify(target)}); const box = node.getBoundingClientRect(); return {x:box.x + box.width * ${String(fraction)}, y:box.y + box.height/2, width:box.width, height:box.height}; })()`);
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
        return point;
    };

    const clickFrame = async target => {
        const point = await aimFrame(target);
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

    /**
     * Every web page's placement, as a list rather than a string.
     *
     * A list, because a check comparing two joined strings passes just as happily when BOTH are
     * empty - which is what the first cut did, enumerating web panes before one existed.
     */
    const pageStates = async () => {
        const raw = await page.eval(`JSON.stringify([...document.querySelectorAll('[data-testid^="web-page-"]')].map(node => ({ id: node.dataset.testid, visible: node.dataset.visible, covered: node.dataset.overlayCovered })))`);
        return typeof raw === 'string' ? JSON.parse(raw) : [];
    };

    /**
     * Read the shell's PTY size until it satisfies a predicate.
     *
     * A band change reaches a PTY through a resize observer, a layout, a report to the daemon and a
     * SIGWINCH, so a single read taken the moment the DOM settled can be the size from before all
     * of that. Every rows comparison in this scenario therefore waits for the number it expects to
     * MOVE rather than sampling once and hoping.
     */
    const settleRows = async (paneID, predicate, label) => {
        let last = null;
        const ok = await d.settle(async () => {
            const now = await shellRows(paneID, label);
            if (now === null) return false;
            last = now;
            return predicate(now);
        }, { ceilingMs: 30_000 });
        if (!ok) rec.note(`${label}: the PTY never reached the expected size; last read ${JSON.stringify(last)}`);
        return last;
    };

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
    const shellRows = async (paneID, label = 'the shell') => {
        /*
         * Retried once, and named when it fails.
         *
         * A loaded machine can leave a send un-echoed past any one ceiling, and the first cut then
         * compared a later reading against `null` - which is a check that fails for the wrong
         * reason and reads as a geometry regression. One retry covers the lost send; a second
         * failure is reported as what it is.
         */
        for (let attempt = 0; attempt < 2; attempt += 1) {
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
            }, { ceilingMs: 20_000 });
            if (answer !== null) return answer;
            rec.note(`${label} never echoed its stty marker on attempt ${String(attempt + 1)}; retrying once`);
        }
        rec.note(`FAILED READ: ${label} never echoed the marker, so its PTY size could not be read`);
        return null;
    };

    // Where the window was before this scenario took it: restored at the end, because the sandbox
    // and its window are shared with whatever runs next.
    const startingWorkspace = await page.eval(`document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.getAttribute('data-workspace-id') ?? null`);
    const workspace = await json(['workspace', 'create', '--name', 'Pane chrome', '--json']);
    const workspaceID = workspace.workspace_id;
    /** The workspace check 3 proves WITHHOLDING with: many panes, each with a maximal title. */
    let crowdedID = null;
    /** The web pane check 5 measures, hoisted so the cleanup can close it after a throw. */
    let webPaneID = null;
    let uiFrame = '';
    const metadataRepo = path.join(sandbox.home, 'pane-meta');
    let metadataPane = null;

    try {
        // ── 1 · the placement is offered, and the lab attaches ───────────────────────
        await cli.ok(['plugin', 'install', labPath, '--trust']);
        await cli.ok(['plugin', 'install', uiPath, '--trust']);
        const uiPane = await json(['plugin', 'open', uiID, `${uiID}.panel`, '--workspace', workspaceID]);
        uiFrame = `[data-testid="plugin-view-${uiPane.paneID}"] iframe`;
        if (!await d.settle(async () => {
            try { return await page.evalInFrame(uiFrame, `document.body.dataset.ready === 'true'`); } catch { return false; }
        }, { ceilingMs: 20_000 })) throw new Error('UI Lab did not attach');

        // A real private repository and hook-reported agent give the metadata row actual data.
        // Keep it below the sandbox HOME so the existing privacy check still sees only ~/pane-meta.
        fs.mkdirSync(metadataRepo);
        const git = args => execFileSync('git', args, { cwd: metadataRepo, stdio: ['ignore', 'pipe', 'pipe'] });
        git(['init', '--initial-branch=visual-band']);
        fs.writeFileSync(path.join(metadataRepo, 'notes.md'), '# Pane chrome fixture\n');
        git(['add', 'notes.md']);
        git(['-c', 'user.name=Kelpi Scenario', '-c', 'user.email=scenario@localhost', 'commit', '-m', 'Private fixture']);
        // A shell pane beside it: the one whose PTY check 5 measures.
        const shellPane = (await json(['pane', 'create', '--workspace', workspaceID, '--path', metadataRepo, '--json'])).pane_id;
        metadataPane = shellPane;
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
        // Reflow through the app's own layout control before asking a reviewer to inspect the
        // withheld header. Repeated right splits make the final panes progressively narrower; the
        // full-width row preset keeps the exact same six panes and frame budget while giving every bundled
        // title, ZOOM/SYNC area, split control and close button honest pixels of its own.
        await cli.ok(['layout', 'select', 'even-vertical'], { paneID: crowdedPanes[0] });
        if (!await frameCheck(`(() => {
            const count = document.querySelector('[data-testid="lab-pane-withheld"]');
            return count !== null && count.clientWidth >= count.scrollWidth && Number(count.dataset.count) > 0;
        })()`)) throw new Error('The bundled-pane count is still clipped');
        if (!await d.settle(async () => ((await headerBox(missing[0]))?.width ?? 0) > 700, { ceilingMs: 10_000 })) {
            throw new Error('The withheld native header did not receive the full-width layout');
        }
        await shot('withheld-pane', 'The "Pane chrome crowded" workspace: the first panes wearing Pane Lab bands with an enormous "wwwww…" title, and the LAST pane (bottom) wearing the bundled 24 px header instead - its own truncated title, its ZOOM/SYNC area, its split buttons and its ✕. The first carried Pane Lab band shows the full "+N bundled" count, identifying how many panes retain their native header.');

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

        /*
         * The web pane is opened HERE, before the zoom, and not where it is first measured: check 6
         * asks whether a band declared on a hidden pane parks a live page, and a check that
         * enumerates web panes when there are none is a check that cannot fail.
         */
        const opened = await cli.ok(['web', 'open', 'about:blank']);
        const webPane = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1] ?? null;
        if (webPane === null) throw new Error(`no web pane opened: ${opened.trim()}`);
        webPaneID = webPane;
        const placed = await d.settleDom(page, `document.querySelector('[data-testid="web-page-${webPane}"]')?.dataset.visible === 'true'`, { ceilingMs: 25_000 });
        rec.check('a web pane is placed and live before the parking checks', placed,
            String(await page.eval(`document.querySelector('[data-testid="web-page-${webPane}"]')?.dataset.visible ?? 'none'`)));
        await d.settle(async () => await labPane(webPane) !== null, { ceilingMs: 12_000 });

        // Zoom, through the band's own double click.
        await inFrame(`(() => { document.querySelector(${JSON.stringify(band(shellPane))}).dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return true; })()`);
        const zoomed = await d.settleDom(page, `document.querySelector('[data-pane-id="${shellPane}"]')?.dataset.zoomed === 'true'`, { ceilingMs: 8_000 });
        rec.check('a double click on the band zooms the pane', zoomed, String(await page.eval(`document.querySelector('[data-pane-id="${shellPane}"]')?.dataset.zoomed ?? 'none'`)));

        // ── 6 · a declared band on a HIDDEN pane parks nothing ───────────────────────
        // The workspace is zoomed on `shellPane`, so every other pane is mounted and invisible.
        const hiddenPane = visiblePanes.find(paneID => paneID !== shellPane) ?? null;
        const hiddenFrame = await labPane(hiddenPane);
        const hiddenBefore = await headerBox(hiddenPane);
        const webHoleBefore = await pageStates();
        const hiddenAnswer = await refusal(`kelpi.ui.setPaneChromeHeight(${JSON.stringify(hiddenPane)}, ${String(TALL)})`);
        await sleep(400);
        const hiddenAfter = await headerBox(hiddenPane);
        const webHoleAfter = await pageStates();
        await inFrame(`(() => { document.querySelector(${JSON.stringify(band(shellPane))}).dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return true; })()`);
        await d.settleDom(page, `document.querySelector('[data-pane-id="${shellPane}"]')?.dataset.zoomed !== 'true'`, { ceilingMs: 8_000 });
        // And again with the zoom released: a park that only shows up once the pages are back on
        // screen is the one this check exists to catch.
        await d.settle(async () => await labPane(webPane) !== null, { ceilingMs: 12_000 });
        const webHoleAfterZoom = await pageStates();
        rec.check('a band declared on a hidden (zoomed-out) pane is refused, changes nothing and parks nothing',
            hiddenFrame === null && String(hiddenAnswer).includes('not in the current pane chrome frame')
            && hiddenBefore !== null && hiddenAfter?.height === hiddenBefore.height
            && webHoleBefore.length > 0 && String(webHoleAfter) === String(webHoleBefore)
            && String(webHoleAfterZoom) === String(webHoleBefore),
            `frame entry ${JSON.stringify(hiddenFrame)} · answer ${String(hiddenAnswer)} · band ${JSON.stringify(hiddenBefore)} -> ${JSON.stringify(hiddenAfter)} · pages ${JSON.stringify(webHoleBefore)} -> ${JSON.stringify(webHoleAfter)} -> ${JSON.stringify(webHoleAfterZoom)}`);

        // ── 5 · a declared 96 px band, measured against a live shell ─────────────────
        // The app's tiled preset keeps the five live panes and all geometry assertions intact,
        // while avoiding the exponentially narrow tail produced by repeatedly splitting right.
        // That makes the two-line band and the host overlays reviewable in the screenshots below.
        await clickFrame(band(shellPane));
        await d.settle(async () => await focusedNow() === shellPane, { ceilingMs: 8_000 });
        await cli.ok(['layout', 'select', 'tiled'], { paneID: shellPane });
        await d.settle(async () => ((await headerBox(shellPane))?.width ?? 0) > 250, { ceilingMs: 10_000 });
        await cli.ok(['event', 'session-start', '--agent', 'codex'], {
            paneID: shellPane, stdin: JSON.stringify({ session_id: 'pane-visual-fixture' })
        });
        await cli.ok(['event', 'start', '--agent', 'codex'], { paneID: shellPane });
        if (!await d.settle(async () => {
            const pane = await labPane(shellPane);
            return pane?.branch === 'visual-band' && pane?.directory === '~/pane-meta' && Boolean(pane?.agent?.text);
        }, { ceilingMs: 15_000 })) throw new Error('The live repository/agent metadata did not reach Pane Lab');
        const bandBefore = await headerBox(shellPane);
        const bodyBefore = await bodyBox(shellPane);
        const rowsBefore = await shellRows(shellPane, 'the shell before the declaration');
        await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(shellPane)}, ${String(TALL)}); return true; })()`);
        const grew = await d.settle(async () => ((await headerBox(shellPane))?.height ?? 0) > (bandBefore?.height ?? 0) + 40, { ceilingMs: 10_000 });
        const bandAfter = await headerBox(shellPane);
        const bodyAfter = await bodyBox(shellPane);
        await sleep(700);
        const rowsAfter = await shellRows(shellPane, 'the shell under the declared band');
        const moved = bandAfter && bodyBefore && bodyAfter
            && Math.abs((bodyAfter.y - bodyBefore.y) - (bandAfter.height - bandBefore.height)) <= 1;
        rec.check('a declared band grows the header, moves the body rect down by the same amount, and resizes the PTY',
            grew && moved && rowsBefore !== null && rowsAfter !== null && rowsAfter.rows < rowsBefore.rows,
            `band ${String(bandBefore?.height)} -> ${String(bandAfter?.height)} px, body y ${String(bodyBefore?.y)} -> ${String(bodyAfter?.y)}, stty ${JSON.stringify(rowsBefore)} -> ${JSON.stringify(rowsAfter)}${rowsBefore === null || rowsAfter === null ? ' (the shell never echoed the marker; see the note above)' : ''}`);
        rec.note(`MEASURED band ${String(bandBefore?.height)} -> ${String(bandAfter?.height)} px; body top ${String(bodyBefore?.y)} -> ${String(bodyAfter?.y)}; PTY ${String(rowsBefore?.rows)} -> ${String(rowsAfter?.rows)} rows at ${String(rowsAfter?.cols)} cols`);
        if (!await frameCheck(`(() => {
            const row = document.querySelector('${band(shellPane)} .line-two');
            return ['dir', 'branch', 'agent'].every(kind => {
                const chip = row?.querySelector('[data-chip="' + kind + '"]');
                return chip && chip.textContent.trim() && chip.clientWidth >= chip.scrollWidth;
            });
        })()`)) throw new Error('The declared band metadata is missing or clipped');
        await shot('declared-band', 'The focused shell pane wearing a TALL two-line Pane Lab band (roughly four times the bundled header): the title row on top and the directory, branch and agent row under it, with the terminal starting lower down the pane and its content unbroken. Every other pane still on a one-line band.');

        // A web pane under the same declaration: its native view has to move with the band.
        const webHole = `[data-testid="web-page-${webPane}"]`;
        const holeBefore = await paneBox(webHole);
        await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(webPane)}, ${String(TALL)}); return true; })()`);
        const holeMoved = await d.settle(async () => ((await paneBox(webHole))?.y ?? 0) > (holeBefore?.y ?? 0) + 40, { ceilingMs: 12_000 });
        const holeAfter = await paneBox(webHole);
        const stillLive = await page.eval(`document.querySelector('${webHole}')?.dataset.visible ?? 'none'`);
        /*
         * Input still REACHES the page, proved by a round trip rather than by the host re-reading
         * its own attribute.
         *
         * The focus is taken somewhere else first, then a click lands in the middle of the moved
         * hole. A native `WebContentsView` that takes that click reports it to the shell, which
         * focuses the pane, which reaches the daemon and comes back on the delta stream as the
         * window's focused pane. A click that never got past the window - which is what a parked or
         * mis-placed view means - moves nothing at all.
         */
        const bodyOfShell = await bodyBox(shellPane);
        if (bodyOfShell !== null) await page.clickAt(bodyOfShell.x + bodyOfShell.width / 2, bodyOfShell.y + Math.min(60, bodyOfShell.height / 2));
        await d.settle(async () => await focusedNow() === shellPane, { ceilingMs: 8_000 });
        const caretBeforeClick = String(await page.eval(`document.activeElement?.tagName ?? 'none'`));
        /*
         * Zoomed for the click, and only for the click.
         *
         * A six-pane grid leaves this web pane a 64 px column, and a click aimed at the middle of
         * one is a click aimed at a scrollbar and a focus-ring gutter. The band is still declared
         * and still applied - the zoom changes which pixels the page occupies, not who drew the
         * chrome above it - so what is measured is unchanged and what is clicked is unambiguous.
         */
        await refusal(`kelpi.ui.toggleZoom(${JSON.stringify(webPane)})`);
        await d.settleDom(page, `document.querySelector('[data-pane-id="${webPane}"]')?.dataset.zoomed === 'true'`, { ceilingMs: 8_000 });
        await d.settle(async () => ((await paneBox(webHole))?.width ?? 0) > 200, { ceilingMs: 10_000 });
        const zoomedHole = await paneBox(webHole);
        if (zoomedHole !== null) {
            await page.clickAt(zoomedHole.x + zoomedHole.width / 2, zoomedHole.y + zoomedHole.height / 2);
        }
        /*
         * Two signals, either of which is the click having reached the native view: the pane the
         * window reports as focused becomes the web pane, or the caret leaves the host document
         * altogether - which is what happens when a `WebContentsView` takes a press, and cannot
         * happen if the click landed on the DOM in front of it.
         */
        const reachedPage = await d.settle(async () => {
            if (await focusedNow() === webPane) return true;
            const caret = String(await page.eval(`document.activeElement?.tagName ?? 'none'`));
            return caretBeforeClick === 'TEXTAREA' && caret !== 'TEXTAREA';
        }, { ceilingMs: 12_000 });
        rec.note(`web click: caret ${caretBeforeClick} -> ${String(await page.eval(`document.activeElement?.tagName ?? 'none'`))}, focus ${String(await focusedNow())}, wanted ${webPane}, zoomed hole ${JSON.stringify(zoomedHole)}`);
        await refusal(`kelpi.ui.toggleZoom(${JSON.stringify(webPane)})`);
        await d.settleDom(page, `document.querySelector('[data-pane-id="${webPane}"]')?.dataset.zoomed !== 'true'`, { ceilingMs: 8_000 });
        rec.check('a web pane\'s native view moves with the declared band, stays live and still takes input',
            placed && holeMoved && String(stillLive) === 'true' && reachedPage,
            `hole ${JSON.stringify(holeBefore)} -> ${JSON.stringify(holeAfter)} · data-visible ${String(stillLive)} · overlay-covered ${String(await page.eval(`document.querySelector('${webHole}')?.dataset.overlayCovered ?? 'none'`))} · focus after the click ${String(await focusedNow())}, wanted ${webPane}`);
        rec.note(`MEASURED web hole ${JSON.stringify(holeBefore)} -> ${JSON.stringify(holeAfter)} under a ${String(TALL)} px declaration`);
        await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(webPane)}, null); globalThis.paneLab.declare(${JSON.stringify(shellPane)}, null); return true; })()`);
        await d.settle(async () => ((await headerBox(shellPane))?.height ?? 99) <= 24, { ceilingMs: 10_000 });

        // ── 4 (continued) · rename and close, both the host's ────────────────────────
        // The preceding native-web click deliberately leaves Web focused. The inline input
        // stops pointer propagation, so clicking it cannot focus its pane. Give the real host
        // field room beside the agent/contribution badges without hiding any other pane band.
        await cli.ok(['layout', 'select', 'even-vertical'], { paneID: shellPane });
        if (!await d.settle(async () => ((await headerBox(shellPane))?.width ?? 0) > 700, { ceilingMs: 10_000 })) {
            throw new Error('The rename header did not receive the full-width layout');
        }
        await clickFrame(band(shellPane));
        if (!await d.settle(async () => await focusedNow() === shellPane, { ceilingMs: 8_000 })) throw new Error('The rename pane did not take focus');
        await refusal(`kelpi.ui.renamePane(${JSON.stringify(shellPane)})`);
        const fieldUp = await d.settleDom(page, `document.querySelector('[data-testid="pane-rename-input-${shellPane}"]')`, { ceilingMs: 8_000 });
        if (fieldUp) {
            await clickHost(`[data-testid="pane-rename-input-${shellPane}"]`);
            await page.insertText('renamed-by-presenter');
        }
        // Capture while the HOST field is still editable. The old shot ran after Enter, when the
        // very control named by the visual requirement had already unmounted.
        const renameVisual = async () => {
            await page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
            const state = await page.eval(`(() => {
                const input = document.querySelector('[data-testid="pane-rename-input-${shellPane}"]');
                const header = document.querySelector('[data-testid="pane-header-${shellPane}"]');
                if (!input || !header) return { visible: false, reason: 'missing host field' };
                const box = input.getBoundingClientRect();
                const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                const others = [...document.querySelectorAll('[data-testid^="pane-header-"]')].filter(node => {
                    const r = node.getBoundingClientRect();
                    return node !== header && getComputedStyle(node).visibility === 'visible' && r.width > 0 && r.height > 0;
                });
                return { visible: box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && hit === input,
                    value: input.value, editable: !input.disabled && !input.readOnly, active: document.activeElement === input,
                    focused: header.dataset.focused, presented: header.dataset.presented, height: header.getBoundingClientRect().height,
                    width: box.width, clientWidth: input.clientWidth, scrollWidth: input.scrollWidth,
                    otherBands: others.length, othersPresented: others.every(node => node.dataset.presented === 'true') };
            })()`);
            rec.note(`MEASURED rename capture ${JSON.stringify(state)}`);
            if (!state.visible || !state.editable || !state.active || state.value !== 'renamed-by-presenter'
                || state.focused !== 'true' || state.presented !== 'false' || state.height > 24
                || state.clientWidth < state.scrollWidth || state.otherBands !== 4 || !state.othersPresented) {
                throw new Error(`The host rename visual is not fully visible and editable: ${JSON.stringify(state)}`);
            }
        };
        await renameVisual();
        await shot('host-rename-field', 'The focused pane\'s band showing the HOST\'s own inline rename text field holding "renamed-by-presenter" - a plain editable box in a bundled 24 px header - while every OTHER pane in the tiled grid still wears its Pane Lab band. The renaming pane is the one place the presenter is standing off.');
        await renameVisual();
        if (fieldUp) await page.key('Enter');
        const renamed = await d.settle(async () =>
            (await json(['pane', 'list', '--workspace', workspaceID, '--json']))
                .some(pane => pane.id === shellPane && pane.label === 'renamed-by-presenter'), { ceilingMs: 12_000 });
        rec.check('renamePane opens the HOST\'s inline field and its commit reaches the daemon',
            fieldUp && renamed, `field ${String(fieldUp)} · renamed ${String(renamed)}`);
        await cli.ok(['layout', 'select', 'tiled'], { paneID: shellPane });

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

        /*
         * ── M4 · the caret never stays in a header band ──────────────────────────────
         *
         * A click on a control inside the presenter's frame moves focus into an iframe that claims
         * no chords, so from that moment every keystroke - typing, Escape, the palette, every
         * window chord - went into a sandbox that dropped it, until the user clicked the pane body
         * again. The host hands the caret straight back to the focused pane, which is what the
         * bundled header gets for free by being made of buttons.
         *
         * The observable is where the caret IS. A terminal's own text input is the pane surface, so
         * "the caret is on `[data-pane-surface]` and not inside the presenter's wrapper" is the
         * whole property, and the find bar below is what proves the chords came back with it.
         */
        const itemButton = `[data-testid="lab-pane-item"]`;
        let caretBack = null;
        if (await frameCheck(`!!document.querySelector('${band(shellPane)} ${itemButton}')`, 6_000)) {
            await clickFrame(`${band(shellPane)} ${itemButton}`);
            caretBack = await d.settle(async () => await page.eval(`(() => {
                const active = document.activeElement;
                if (active === null) return false;
                if (document.querySelector('[data-testid="pane-chrome-presenter"]')?.contains(active)) return false;
                return active.closest('[data-pane-surface]') !== null || active.hasAttribute('data-pane-surface');
            })()`), { ceilingMs: 8_000 });
        }
        rec.check('the caret goes back to the pane after a click on the presenter\'s own control',
            caretBack === true,
            `active ${String(await page.eval(`(() => { const a = document.activeElement; return a === null ? 'none' : `+"`${a.tagName}${a.closest('[data-pane-surface]') ? ' (pane surface)' : ''}${document.querySelector('[data-testid=\"pane-chrome-presenter\"]')?.contains(a) ? ' (inside the presenter)' : ''}`"+`; })()`))}`);

        /*
         * ── H3 · the find bar is still reachable under a declared band ───────────────
         *
         * `grid/PaneSearchOverlay.tsx` is `absolute right-2 top-2 z-30` inside the pane wrapper, and
         * a `z-30` inside a `zIndex: 1` stacking context cannot reach past the presenter's frame at
         * 2. At the native band that covered the bar's top edge; under a 96 px one the whole bar was
         * invisible and dead. The host lifts a pane carrying an overlay, exactly as it lifts a
         * renaming one. ⌘F reaching the host at all is the other half of the check above.
         */
        await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(shellPane)}, ${String(TALL)}); return true; })()`);
        await d.settle(async () => ((await headerBox(shellPane))?.height ?? 0) > 40, { ceilingMs: 10_000 });
        await cli.ok(['pane', 'send', '--target', shellPane, 'echo FINDABLE-ANCHOR']);
        await cli.run(['pane', 'send-key', '--target', shellPane, 'enter']);
        /*
         * The caret goes on the TERMINAL first, by clicking the pane body.
         *
         * `super+f` is `toggle_search`, and the window dispatches it for the focused pane - but the
         * press before this one landed in the presenter's frame, and a chord pressed while the
         * caret is still being handed back is a chord nobody answers. A click in the body is the
         * gesture a user makes before searching anyway.
         */
        const bodyBefore2 = await bodyBox(shellPane);
        if (bodyBefore2 !== null) await page.clickAt(bodyBefore2.x + bodyBefore2.width / 2, bodyBefore2.y + Math.min(60, bodyBefore2.height / 2));
        const findFocused = await d.settle(async () => await focusedNow() === shellPane, { ceilingMs: 8_000 });
        await sleep(200);
        await page.key('KeyF', { modifiers: 4 });
        const findBar = `[data-testid="pane-search-input-${shellPane}"]`;
        const findUp = await d.settleDom(page, `document.querySelector(${JSON.stringify(findBar)})`, { ceilingMs: 10_000 });
        if (!findUp) {
            rec.note(`find bar did not open: active ${String(await page.eval(`document.activeElement?.tagName ?? 'none'`))}, any search bar ${String(await page.eval(`[...document.querySelectorAll('[data-testid^="pane-search-"]')].map(node => node.dataset.testid).join(',') || 'none'`))}, caret owner ${String(await page.eval(`document.activeElement?.getAttribute?.('data-pane-surface') ?? document.activeElement?.closest?.('[data-pane-surface]')?.getAttribute('data-pane-surface') ?? 'none'`))}`);
        }
        let findCounted = false, findAimed = false;
        if (findUp) {
            // Aim-checked: a bar that is on screen but painted over by the presenter's band is
            // exactly the defect, and `page.click` would aim at its rect either way.
            /*
             * SETTLED, not sampled once. The bar mounting and the wrapper being lifted above the
             * presenter are two facts of the same render, and a hit test taken between the commit
             * and the paint answers with whatever was on top a frame earlier.
             */
            let aim = null;
            await d.settle(async () => {
                aim = JSON.parse(String(await page.eval(`(() => {
                    const node = document.querySelector(${JSON.stringify(findBar)});
                    const bar = document.querySelector('[data-testid="pane-search-${shellPane}"]');
                    if (node === null || bar === null) return JSON.stringify({ x: 0, y: 0, ok: false, hit: 'no bar' });
                    const box = node.getBoundingClientRect();
                    // A fifth of the way across the field, not its middle: a narrow pane squeezes
                    // the bar until its own Next button overlaps the centre of the input, and a hit
                    // test that demanded the input itself would be measuring the BAR's layout
                    // rather than whether the presenter's band is over it.
                    const point = { x: box.x + box.width * 0.2, y: box.y + box.height / 2 };
                    const hit = document.elementFromPoint(point.x, point.y);
                    return JSON.stringify({
                        ...point,
                        // What this check is about: the topmost thing here belongs to the HOST's
                        // find bar rather than to the presenter's frame.
                        ok: hit !== null && bar.contains(hit),
                        onInput: hit === node || node.contains(hit),
                        hit: hit === null ? 'nothing' : String(hit.outerHTML ?? hit.nodeName).slice(0, 120)
                    });
                })()`)));
                return aim.ok === true;
            }, { ceilingMs: 8_000 });
            findAimed = aim?.ok === true;
            if (findAimed) {
                await page.clickAt(aim.x, aim.y);
                // The caret has to be IN the field: a click that landed on one of the bar's own
                // buttons is still the bar being on top, but it types nowhere.
                if (aim.onInput !== true) await page.eval(`document.querySelector(${JSON.stringify(findBar)})?.focus()`);
                await page.insertText('FINDABLE-ANCHOR');
                findCounted = await d.settleDom(page, `(document.querySelector('[data-testid="pane-search-count-${shellPane}"]')?.textContent ?? '').includes('/')`, { ceilingMs: 10_000 });
            }
            rec.note(`find bar aim: ${JSON.stringify(aim)}`);
            // The shot is taken while the bar is UP: a picture of the pane after it closed is a
            // picture of nothing this check is about.
            await shot('find-bar-over-band', 'The focused shell pane wearing a TALL Pane Lab band with the host\'s own find bar drawn OVER it at the top right - the search field holding FINDABLE-ANCHOR, its match counter and its close button all fully visible above the plugin band rather than sliced by it.');
            await page.key('Escape');
        }
        rec.check('the terminal find bar is on top of a declared band, clickable, and counts its matches',
            findUp && findAimed && findCounted,
            `focused ${String(findFocused)} (${String(await focusedNow())} vs ${shellPane}) · open ${String(findUp)} · clickable ${String(findAimed)} · counted ${String(findCounted)} · count ${String(await page.eval(`document.querySelector('[data-testid="pane-search-count-${shellPane}"]')?.textContent ?? 'none'`))}`);

        await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(shellPane)}, null); return true; })()`);

        /*
         * ── DRAG · the pane-move gesture, and where the press has to happen ──────────
         *
         * The user found this by hand: dragging a Pane Lab band selected text inside the band
         * instead of moving the pane, while the scenario's own check passed. Two separate defects,
         * and the second is the one that matters.
         *
         *   1. The lab's band had no `user-select: none` and did not default the press away, so the
         *      browser started a native text selection across the header.
         *   2. **A mouse press that lands inside an iframe keeps every later move and the release
         *      inside that iframe's document.** Chromium settles the routing when the button goes
         *      down, so the host flipping the frame to `pointer-events: none` on hearing about the
         *      press is already too late. No call a presenter can make will start a host gesture
         *      from its own pixels, which is why `beginPaneDrag` is withdrawn and the host keeps a
         *      drag grip at the leading edge of every band instead.
         *
         * The old check passed because it dispatched a press with no pointer ever having entered
         * the frame and then teleported: CDP hit-tests each synthesized event, so the host saw
         * moves that a real pointer would never have sent it. Both halves are measured below with a
         * pointer that enters, presses, moves in steps with the button held, and releases.
         */
        const dragTarget = (await json(['pane', 'list', '--workspace', workspaceID, '--json']))
            .map(pane => pane.id).find(id => id !== shellPane) ?? null;
        const boxBefore = await paneBox(`[data-pane-id="${shellPane}"]`);
        const targetBox = dragTarget === null ? null : await paneBox(`[data-pane-id="${dragTarget}"]`);

        /*
         * First the measurement: a real press INSIDE the frame, and who sees the moves.
         *
         * Aimed at one of the lab's own controls, because that is now the part of the band the host
         * is NOT covering - the title has a host surface over it, which is the whole point of this
         * round. A press there is as inside the frame as a press can be.
         */
        const inFrameGrab = await (async () => {
            const bandBox = await paneBox(`[data-testid="pane-header-${shellPane}"]`);
            if (bandBox === null) return null;
            // Scan the band for a point the host is NOT covering: the title now has a host surface
            // over it, so the press has to land where the presenter's own row is.
            for (let at = 0.95; at > 0.05; at -= 0.05) {
                const point = { x: bandBox.x + bandBox.width * at, y: bandBox.y + bandBox.height / 2 };
                const hit = await page.eval(`(() => {
                    const node = document.elementFromPoint(${point.x}, ${point.y});
                    const frame = document.querySelector('${presenterFrame}');
                    return node !== null && (node === frame || frame?.contains(node)) ? 'frame' : String(node?.dataset?.testid ?? node?.nodeName ?? 'nothing');
                })()`);
                if (hit === 'frame') return point;
            }
            return null;
        })();
        if (inFrameGrab === null) rec.note('no point on the band reaches the presenter frame; the host is covering all of it');
        let captured = null;
        if (inFrameGrab !== null && targetBox !== null) {
            await page.mouse('mouseMoved', inFrameGrab.x, inFrameGrab.y, { button: 'none', buttons: 0 });
            await page.mouse('mousePressed', inFrameGrab.x, inFrameGrab.y);
            for (const step of [0.2, 0.5, 0.8]) {
                await page.mouse('mouseMoved',
                    inFrameGrab.x + (targetBox.x + targetBox.width / 2 - inFrameGrab.x) * step,
                    inFrameGrab.y + (targetBox.y + targetBox.height / 2 - inFrameGrab.y) * step,
                    { buttons: 1 });
                await sleep(50);
            }
            const framesMoves = Number(await inFrame(`globalThis.paneLab?.pressMoves ?? -1`).catch(() => -1));
            const hostArmed = await page.eval(`(document.querySelector('[data-testid="pane-grid"]')?.className ?? '').includes('pointer-events-none')`);
            const selection = String(await inFrame(`String(getSelection()?.toString() ?? '')`).catch(() => 'unreadable'));
            await page.mouse('mouseReleased', targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
            const movedByFramePress = await d.settle(async () => {
                const now = await paneBox(`[data-pane-id="${shellPane}"]`);
                return now !== null && boxBefore !== null && (now.x !== boxBefore.x || now.y !== boxBefore.y);
            }, { ceilingMs: 3_000 });
            captured = { framesMoves, hostArmed, selection, movedByFramePress };
            rec.note(`MEASURED after a press inside the frame: the frame saw ${String(framesMoves)} moves with the button down, the host's gesture armed ${String(hostArmed)}, the pane moved ${String(movedByFramePress)}, selection ${JSON.stringify(selection)}`);
        }
        /*
         * What is asserted, and what cannot be.
         *
         * ASSERTED: a press dragged across a band selects nothing (the user's actual symptom), and
         * it moves no pane - the presenter has no drag path of its own and is not supposed to.
         *
         * NOT ASSERTED, because this harness cannot: that the moves stayed in the frame.
         * `Input.dispatchMouseEvent` hit-tests every synthesized event on its own and keeps no
         * per-frame capture, so a CDP pointer teleports between documents where a real one cannot -
         * which is exactly why the previous version of this check passed while the user's mouse
         * failed. The frame counter is printed above for the record and is expected to read 0 here.
         * The cause is Chromium's routing rule, the evidence is the user's manual test, and the fix
         * is that the press now happens in the host's own grip where none of it applies.
         */
        rec.check('a press dragged from inside the presenter\'s frame selects nothing and moves no pane',
            captured !== null && captured.selection === '' && captured.movedByFramePress === false,
            JSON.stringify(captured));

        /*
         * And now the way a user actually reaches for a header: the TITLE, with the host's own
         * surface over it because the lab declared that rectangle as a drag region. The grip at the
         * leading edge is the floor for a presenter that declares nothing; it is not where anyone
         * reaches, which is what the user's second round found.
         */
        const dragSurface = `[data-testid^="pane-chrome-drag-${shellPane}-"]`;
        const surfaceBox = await paneBox(dragSurface);
        const gripBox = await paneBox(`[data-testid="pane-chrome-grip-${shellPane}"]`);
        const orderBefore = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).map(pane => pane.id).join(',');
        let dragMoved = false, zoned = false;
        if (surfaceBox !== null && targetBox !== null && boxBefore !== null) {
            // The MIDDLE of the title, which is where a hand goes.
            const from = { x: surfaceBox.x + surfaceBox.width / 2, y: surfaceBox.y + surfaceBox.height / 2 };
            const to = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height * 0.8 };
            await page.mouse('mouseMoved', from.x, from.y, { button: 'none', buttons: 0 });
            await page.mouse('mousePressed', from.x, from.y);
            for (const step of [0.1, 0.35, 0.6, 0.85, 1]) {
                await page.mouse('mouseMoved', from.x + (to.x - from.x) * step, from.y + (to.y - from.y) * step, { buttons: 1 });
                await sleep(50);
            }
            zoned = await d.settleDom(page, `document.querySelector('[data-testid="drop-zone-overlay"]')`, { ceilingMs: 4_000 });
            await page.mouse('mouseReleased', to.x, to.y);
            dragMoved = await d.settle(async () => {
                const now = await paneBox(`[data-pane-id="${shellPane}"]`);
                return now !== null && (now.x !== boxBefore.x || now.y !== boxBefore.y || now.width !== boxBefore.width);
            }, { ceilingMs: 12_000 });
        }
        const orderAfter = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).map(pane => pane.id).join(',');
        const selectionAfter = String(await inFrame(`String(getSelection()?.toString() ?? '')`).catch(() => 'unreadable'));
        rec.check('a drag from the middle of the lab\'s title moves the pane, in the daemon\'s own order',
            surfaceBox !== null && surfaceBox.width > 0 && dragMoved && zoned && orderAfter !== orderBefore
            && selectionAfter === '',
            `surface ${JSON.stringify(surfaceBox)} · grip ${JSON.stringify(gripBox)} · drop zone ${String(zoned)} · order ${orderBefore} -> ${orderAfter} · selection ${JSON.stringify(selectionAfter)}`);
        await shot('drag-from-the-title', 'A Pane Lab band being grabbed by its TITLE rather than by an edge strip: the pane has moved to a different place in the grid, and every band still shows the host\'s narrow grip at its leading edge as the floor for a presenter that declares nothing.');

        // The same surface is the bundled header's own double click and right click.
        const zoomedBefore = await page.eval(`document.querySelector('[data-pane-id="${shellPane}"]')?.dataset.zoomed ?? 'false'`);
        const surfaceNow = await paneBox(dragSurface);
        if (surfaceNow !== null) {
            await page.mouse('mouseMoved', surfaceNow.x + surfaceNow.width / 2, surfaceNow.y + surfaceNow.height / 2, { button: 'none', buttons: 0 });
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: surfaceNow.x + surfaceNow.width / 2, y: surfaceNow.y + surfaceNow.height / 2, button: 'left', buttons: 1, clickCount: 2 });
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: surfaceNow.x + surfaceNow.width / 2, y: surfaceNow.y + surfaceNow.height / 2, button: 'left', buttons: 0, clickCount: 2 });
        }
        const zoomedOn = await d.settleDom(page, `document.querySelector('[data-pane-id="${shellPane}"]')?.dataset.zoomed === 'true'`, { ceilingMs: 8_000 });
        const zoomedSurface = await paneBox(dragSurface);
        if (zoomedSurface !== null) {
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: zoomedSurface.x + zoomedSurface.width / 2, y: zoomedSurface.y + zoomedSurface.height / 2, button: 'left', buttons: 1, clickCount: 2 });
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zoomedSurface.x + zoomedSurface.width / 2, y: zoomedSurface.y + zoomedSurface.height / 2, button: 'left', buttons: 0, clickCount: 2 });
        }
        const zoomedOff = await d.settleDom(page, `document.querySelector('[data-pane-id="${shellPane}"]')?.dataset.zoomed !== 'true'`, { ceilingMs: 8_000 });
        rec.check('a double click on the title zooms the pane and un-zooms it, as the bundled header does',
            String(zoomedBefore) !== 'true' && zoomedOn && zoomedOff,
            `before ${String(zoomedBefore)} · on ${String(zoomedOn)} · off ${String(zoomedOff)}`);

        const menuSurface = await paneBox(dragSurface);
        if (menuSurface !== null) {
            await page.mouse('mouseMoved', menuSurface.x + menuSurface.width / 2, menuSurface.y + menuSurface.height / 2, { button: 'none', buttons: 0 });
            await page.mouse('mousePressed', menuSurface.x + menuSurface.width / 2, menuSurface.y + menuSurface.height / 2, { button: 'right', buttons: 2 });
            await page.mouse('mouseReleased', menuSurface.x + menuSurface.width / 2, menuSurface.y + menuSurface.height / 2, { button: 'right', buttons: 0 });
        }
        const menuFromSurface = await d.settleDom(page, `document.querySelector('[role="menu"]')`, { ceilingMs: 8_000 });
        if (menuFromSurface) await page.key('Escape');
        rec.check('a right click on the title opens the host\'s own pane menu',
            menuFromSurface, `surface ${JSON.stringify(menuSurface)}`);

        // And the region does NOT cover the row: a control under it would be a control nobody can
        // press, because nothing is forwarded back into the frame.
        const controlBefore = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        const stillSplit = await controlRef(shellPane, 'Split right');
        const stillWorks = stillSplit === null ? 'no ref' : await (async () => {
            await clickFrame(`${band(shellPane)} [data-testid="lab-pane-control"][data-ref="${stillSplit}"]`);
            return await d.settle(async () =>
                (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length === controlBefore + 1,
                { ceilingMs: 12_000 }) ? 'split' : 'nothing';
        })();
        rec.check('a lab control is still pressable: the declared region does not cover the row',
            stillWorks === 'split', `ref ${String(stillSplit)} · ${String(stillWorks)}`);

        // Forged regions: clamped into the band, and refused past the cap.
        const bandRect = (await labPane(shellPane))?.rect ?? null;
        const clampedAnswer = await refusal(`kelpi.ui.setPaneDragRegions(${JSON.stringify(shellPane)}, [{x:-9999,y:-9999,width:99999,height:99999}])`);
        const clampedBox = await d.settle(async () => {
            const surface = await paneBox(dragSurface);
            return surface !== null && bandRect !== null && surface.width <= bandRect.width + 1;
        }, { ceilingMs: 8_000 });
        const cappedAnswer = await refusal(`kelpi.ui.setPaneDragRegions(${JSON.stringify(shellPane)}, Array.from({length: 9}, () => ({x:0,y:0,width:4,height:4})))`);
        rec.check('a region reaching outside the band is clamped to it, and a ninth is refused by message',
            clampedAnswer === 'resolved' && clampedBox && /at most 8 drag regions/.test(String(cappedAnswer)),
            `clamped ${String(clampedAnswer)} into ${JSON.stringify(await paneBox(dragSurface))} of band ${JSON.stringify(bandRect)} · capped ${String(cappedAnswer)}`);

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
        const paneKeys = Object.keys((await labPane(shellPane)) ?? {});
        const controlKeys = Object.keys((await labPane(shellPane))?.controls?.[0] ?? {});
        /*
         * The SHAPES, not just the strings.
         *
         * The first cut read the agent's own keys, which are an empty set on a plain shell pane
         * with no agent attached - a check that could not fail. What the withheld list actually
         * promises is about every pane and every control in the frame, so that is what is walked:
         * no key anywhere names a session, a handle, a pid, a path or a test id, and a control
         * carries a ref rather than a key or a command.
         */
        const allKeys = new Set();
        const walk = value => {
            if (value === null || typeof value !== 'object') return;
            if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
            for (const [name, entry] of Object.entries(value)) { allKeys.add(name); walk(entry); }
        };
        walk(await labSnapshot());
        const shapeLeaks = [...allKeys].filter(name => /session|pid|handle|workingdirectory|testid|command|pluginid|url/i.test(name));
        rec.check('no absolute path, plugin id, command name, pid or bundled test id reaches the presenter',
            leaked.length === 0 && shapeLeaks.length === 0
            && !paneKeys.includes('workingDirectory') && controlKeys.includes('ref') && !controlKeys.includes('key'),
            `leaked ${JSON.stringify(leaked)} · key leaks ${JSON.stringify(shapeLeaks)} · pane keys ${JSON.stringify(paneKeys)} · control keys ${JSON.stringify(controlKeys)}`);

        const goodRef = await controlRef(shellPane, 'Split right');
        const itemRefNow = (await labPane(shellPane))?.items?.[0]?.ref ?? 'i0';
        const panesBeforeForgery = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        const countBeforeForgery = (await json(['plugin', 'run', `${uiID}.snapshot`])).state.context.count;
        /*
         * A GENUINE ref from another pane, not one with a character appended.
         *
         * The first cut forged all three by suffixing `#`, which made "a ref from another pane" the
         * same test as "an invented ref" three times over. `webPane`'s own first control ref is a
         * live token of a live pane, and it has to mean nothing on this one: refs are pane-scoped
         * and the host re-checks the pane as well as the table.
         */
        /*
         * A WELL-FORMED ref that no row of this pane holds.
         *
         * Not "the other pane's first ref": a token is a per-pane ordinal, so `c0` exists in every
         * pane and naming it on this one legitimately means THIS pane's own first control - which
         * is the scoping working, not a leak, and a presenter holds every carried pane's frame
         * anyway. What has to be refused is a token of the right SHAPE that this pane's table does
         * not hold, which is the shape a stale or guessed ref actually takes.
         */
        const shellRefs = ((await labPane(shellPane))?.controls ?? []).map(entry => entry.ref);
        const otherPaneRef = shellRefs.length === 0 ? null : `c${String(shellRefs.length)}`;
        const crossTarget = shellPane;
        const forged = await activate(shellPane, 'c999');
        const invented = await activate(shellPane, 'nonsense');
        const crossPane = otherPaneRef === null || crossTarget === null
            ? 'no row to reason about'
            : await activate(crossTarget, otherPaneRef);
        const itemAsControl = await activate(shellPane, itemRefNow);
        const controlAsItem = await refusal(`kelpi.ui.runPaneHeaderItem(${JSON.stringify(shellPane)}, ${JSON.stringify(goodRef)})`);
        const ghost = await refusal(`kelpi.ui.focusChromePane('not-a-pane')`);
        const answers = { forged, invented, crossPane, itemAsControl, controlAsItem, ghost };
        const panesAfterForgery = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        const countAfterForgery = (await json(['plugin', 'run', `${uiID}.snapshot`])).state.context.count;
        rec.check('a forged ref, an invented ref, a well-formed ref this row does not hold and a ref on the wrong list are all refused, with nothing run',
            // The MESSAGE, not merely "not resolved": a call that threw for some other reason would
            // otherwise read as a refusal.
            Object.values(answers).every(answer => /not in the current pane chrome frame/.test(String(answer)))
            && otherPaneRef !== null
            && panesAfterForgery === panesBeforeForgery
            // Nothing ran: no split, no close, and UI Lab's counter is where it was.
            && countAfterForgery === countBeforeForgery,
            `${JSON.stringify(answers)} · panes ${String(panesBeforeForgery)} -> ${String(panesAfterForgery)} · UI Lab count ${String(countBeforeForgery)} -> ${String(countAfterForgery)}`);

        /*
         * A genuinely STALE ref, replayed onto a row that has changed shape.
         *
         * This is the defect refs were re-designed for: they used to be row POSITIONS, so `c0` meant
         * "whatever is first in this row", and a click is always painted from a frame at least one
         * commit old. Disabling UI Lab takes its `pane.header` command out of the head of the row
         * and moves every host control along; the ref captured before it has to go on naming Split
         * right, not its neighbour.
         */
        const staleRef = await controlRef(shellPane, 'Split right');
        const rowBefore = (await labPane(shellPane))?.controls?.length ?? 0;
        await cli.ok(['plugin', 'disable', uiID]);
        const rowShrank = await d.settle(async () => ((await labPane(shellPane))?.controls?.length ?? 0) < rowBefore, { ceilingMs: 12_000 });
        const panesBeforeReplay = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        const replay = staleRef === null ? 'no ref' : await activate(shellPane, staleRef);
        const splitAgain = await d.settle(async () =>
            (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length === panesBeforeReplay + 1, { ceilingMs: 12_000 });
        rec.check('a ref painted from an older frame still names the control it was drawn on',
            rowShrank && replay === 'resolved' && splitAgain,
            `row ${String(rowBefore)} -> ${String((await labPane(shellPane))?.controls?.length)} · ref ${String(staleRef)} · ${String(replay)} · panes ${String(panesBeforeReplay)} -> ${String((await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length)}`);
        await cli.ok(['plugin', 'enable', uiID]);
        await d.settle(async () => ((await labPane(shellPane))?.items?.length ?? 0) > 0, { ceilingMs: 15_000 });

        // ── 8 · crash, and every pane back at once ───────────────────────────────────
        const rowsPlainBeforeCrash = await shellRows(shellPane, 'the shell before the crash declaration');
        const declaredBefore = await (async () => {
            await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(shellPane)}, ${String(TALL)}); return true; })()`);
            return await d.settle(async () => ((await headerBox(shellPane))?.height ?? 0) > 40, { ceilingMs: 10_000 });
        })();
        // Against the band that is actually on screen now, not against a number read before several
        // splits changed this pane's size: what is asserted is that the band TOOK rows and the
        // fallback gave them back.
        const rowsUnderCrashBand = rowsPlainBeforeCrash === null
            ? null
            : await settleRows(shellPane, now => now.rows < rowsPlainBeforeCrash.rows, 'the shell under the crash declaration');
        await arm(`crash('uncaught')`);
        // A frame the presenter will be sent: a split changes the shape of the row.
        await cli.ok(['pane', 'create', '--workspace', workspaceID]);
        const fellBack = await bundledHeaders();
        const headersBack = [];
        for (const paneID of (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).map(pane => pane.id)) {
            headersBack.push([paneID, await nativeHeader(paneID), (await headerBox(paneID))?.height ?? null]);
        }
        // The PTY is what a dropped band has to be measured against: a header nobody draws, still
        // sized into, is the whole reason the fallback is all-or-nothing.
        const rowsAfterCrash = rowsUnderCrashBand === null
            ? null
            : await settleRows(shellPane, now => now.rows > rowsUnderCrashBand.rows, 'the shell after the fallback');
        rec.check('a crash puts the bundled header back on EVERY pane at once and drops every declared band',
            declaredBefore && fellBack
            // A floor, because `[].every(...)` is true and a list that failed to build would pass.
            && headersBack.length >= 3
            && headersBack.every(([, native, height]) =>
                native.presented === 'false' && native.title && native.close && height !== null && height <= 24)
            && rowsPlainBeforeCrash !== null && rowsUnderCrashBand !== null && rowsAfterCrash !== null
            && rowsUnderCrashBand.rows < rowsPlainBeforeCrash.rows
            && rowsAfterCrash.rows === rowsPlainBeforeCrash.rows,
            `${JSON.stringify(headersBack)} · PTY ${JSON.stringify(rowsPlainBeforeCrash)} -> under the band ${JSON.stringify(rowsUnderCrashBand)} -> after the fallback ${JSON.stringify(rowsAfterCrash)}`);
        // And no host surface is left over a band nobody is presenting: a transparent rectangle
        // still taking presses over a bundled header would be the worst of both designs.
        const surfacesLeft = Number(await page.eval(`document.querySelectorAll('[data-testid^="pane-chrome-drag-"], [data-testid^="pane-chrome-grip-"]').length`));
        rec.check('the fallback leaves no drag surface behind', surfacesLeft === 0, `${String(surfacesLeft)} still in the DOM`);
        const toast = await d.settleDom(page, `document.querySelector('[data-testid="toast-stack"]')?.textContent?.includes('Pane header presenter')`, { ceilingMs: 10_000 });
        const toastText = String(await page.eval(`document.querySelector('[data-testid="toast-stack"]')?.textContent ?? 'none'`));
        rec.check('the failure is reported on screen, naming the surface and the reason',
            toast && toastText.includes('Pane header presenter') && /crashed on purpose/i.test(toastText),
            toastText);
        // Later split probes rebuild a narrow tail. Reflow only after the crash/PTY assertions.
        await cli.ok(['layout', 'select', 'even-vertical'], { paneID: shellPane });
        if (!await d.settleDom(page, `[...document.querySelectorAll('[data-testid^="pane-header-"]')].filter(node => node.getBoundingClientRect().width > 0).every(node => node.getBoundingClientRect().width > 700)`, { ceilingMs: 10_000 })) {
            throw new Error('Fallback headers did not receive the full-width layout');
        }
        await shot('fallback-after-crash', 'Every pane back on the bundled 24 px header at once - status dot or glyph, title, split buttons and ✕ on each - with a failure toast in the corner reading "Pane header presenter". No Pane Lab band anywhere, and no pane left taller than the others.');

        await cli.ok(['layout', 'select', 'tiled'], { paneID: shellPane });

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
        // A disabled presenter is a stood-down presenter: its bands go back with it, or every pane
        // keeps a tall band with the bundled 24 px header floating inside it.
        const disabledBands = (await headerBox(shellPane))?.height ?? null;
        await cli.ok(['plugin', 'enable', labID]);
        const enabledBack = await attached() && await ready();
        /*
         * The reload, SAMPLED: no pane may ever be headerless.
         *
         * The band swaps on the presenter's own readiness report, not on the selection, so while a
         * reloading view boots the bundled header has to be the one drawing. Sampling is what makes
         * that assertable: every sample taken while the presenter is not shown has to find a native
         * title on the pane, and at least one such sample has to exist or the check proves nothing.
         */
        await cli.ok(['plugin', 'reload', labID]);
        const samples = [];
        for (let attempt = 0; attempt < 120; attempt += 1) {
            const raw = await page.eval(`(() => {
                const slot = document.querySelector('[data-testid="pane-chrome-presenter"]');
                const band = document.querySelector('[data-testid="pane-header-${shellPane}"]');
                return JSON.stringify({
                    shown: slot?.dataset.shown ?? 'none',
                    presented: band?.dataset.presented ?? 'none',
                    title: !!document.querySelector('[data-testid="pane-title-${shellPane}"]')
                });
            })()`);
            const sample = typeof raw === 'string' ? JSON.parse(raw) : null;
            if (sample !== null) samples.push(sample);
            if (sample?.shown === 'true' && sample.presented === 'true') break;
            await sleep(30);
        }
        const booting = samples.filter(sample => sample.shown !== 'true');
        const headless = booting.filter(sample => sample.presented === 'true' || !sample.title);
        const reloaded = await attached() && await ready();
        await openPlugins();
        const retainedValue = await slotValue();
        const latchedAfterReload = (await statusRow()).includes('Failed');
        await closeSettings();
        rec.check('disable, enable and reload all keep the selection and end with the lab drawing',
            disabledBack && disabledBands !== null && disabledBands <= 24 && enabledBack && reloaded
            // Read while Settings is OPEN: a select queried after the dialog closed is a null read
            // that agrees with nothing.
            && retainedValue === labView && !latchedAfterReload,
            `disabled ${String(disabledBack)} band ${String(disabledBands)} · enabled ${String(enabledBack)} · reloaded ${String(reloaded)} · selection ${String(retainedValue)} · latched ${String(latchedAfterReload)}`);
        rec.check('no pane is ever headerless while a reloading presenter boots',
            booting.length > 0 && headless.length === 0 && samples.at(-1)?.presented === 'true',
            `${String(samples.length)} samples, ${String(booting.length)} before the swap, ${String(headless.length)} headless: ${JSON.stringify(headless.slice(0, 3))}`);

        // ── 10 · the daemon replaced under the presenter ─────────────────────────────
        if (daemon === null) rec.note('LIMIT: no sandbox daemon handle (--attach), so the disconnect check was skipped');
        else {
            const pidBefore = daemon.pid, generationBefore = daemon.generation;
            const transitionBegan = Date.now();
            let stoppedAt = null, offlineAt = null, offline = false, offlineState = null;
            let startBegan = null, healthyAt = null;
            try {
                await daemon.stop();
                stoppedAt = Date.now();
                // Keep the replacement DOWN until the client has actually shown the fallback.
                // `restart()` waits for the replacement's healthz before it returns, which made
                // this observation race a daemon that was already back.
                offline = await d.settleDom(page, `!document.querySelector('[data-testid="pane-chrome-presenter"]')`, { ceilingMs: 20_000 });
                offlineAt = Date.now();
                offlineState = await page.eval(`JSON.stringify({
                    connection: document.querySelector('[data-connection]')?.getAttribute('data-connection') ?? null,
                    presenter: document.querySelector('[data-testid="pane-chrome-presenter"]')?.getAttribute('data-pane-chrome-presenter') ?? null
                })`);
            } finally {
                // A failed/throwing observation must not strand the shared scenario daemon down.
                startBegan = Date.now();
                await daemon.start();
                healthyAt = Date.now();
            }
            // `data-connection` is on the app root rather than on `documentElement`, and it is the
            // only authority on the CLIENT having reconnected (`ui-audit/lib/stack.mjs` says so).
            const reconnected = await d.settleDom(page, `document.querySelector('[data-connection]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 30_000 });
            const reconnectedAt = Date.now();
            const back = reconnected && await attached(30_000) && await ready(20_000);
            // Opened first: the row is a Settings control, and reading one with the dialog closed
            // answers `''` whatever the truth is.
            await openPlugins();
            const latched = (await statusRow()).includes('Failed');
            const stillSelected = await slotValue();
            await closeSettings();
            rec.check('a daemon restart hands every band back while disconnected, and the presenter re-attaches with nothing latched',
                offline && reconnected && back && !latched && stillSelected === labView
                && daemon.pid !== pidBefore && daemon.generation === generationBefore + 1,
                `pid ${String(pidBefore)} -> ${String(daemon.pid)} · offline ${String(offline)} · back ${String(back)} · latched ${String(latched)} · selection ${String(stillSelected)} · ${await labState()}`);
            rec.note(`the daemon was replaced (stop ${String(daemon.lastStopMs)} ms, fallback observed +${String(offlineAt === null ? null : offlineAt - transitionBegan)} ms as ${String(offlineState)}, start to healthz ${String(daemon.lastStartMs)} ms, client reconnect ${String(startBegan === null ? null : reconnectedAt - startBegan)} ms after start; stop settled +${String(stoppedAt === null ? null : stoppedAt - transitionBegan)} ms, healthz +${String(healthyAt === null ? null : healthyAt - transitionBegan)} ms)`);
        }

        /*
         * ── H1 · standing the presenter down hands every band back ───────────────────
         *
         * The slot is mounted only while a presenter is selected, so choosing "Pane header
         * (bundled)" unmounts it - and the stand-down that dropped the declarations lived in a
         * render branch that could therefore never run. Every pane kept the band its departed
         * presenter had declared, with the bundled 24 px header floating inside it and every PTY
         * still sized against chrome nobody draws.
         */
        const rowsPlain = await shellRows(shellPane, 'the shell before the stand-down declaration');
        await inFrame(`(() => { globalThis.paneLab.declare(${JSON.stringify(shellPane)}, ${String(TALL)}); return true; })()`);
        const standDownGrew = await d.settle(async () => ((await headerBox(shellPane))?.height ?? 0) > 40, { ceilingMs: 10_000 });
        const rowsUnderBand = rowsPlain === null
            ? null
            : await settleRows(shellPane, now => now.rows < rowsPlain.rows, 'the shell under the band before the stand-down');
        await selectPresenter(bundledView);
        const stoodDown = await bundledHeaders();
        await closeSettings();
        const bandAfterStandDown = (await headerBox(shellPane))?.height ?? null;
        const rowsAfterStandDown = rowsPlain === null
            ? null
            : await settleRows(shellPane, now => now.rows === rowsPlain.rows, 'the shell after the stand-down');
        const nativeAfterStandDown = await nativeHeader(shellPane);
        rec.check('choosing the bundled header hands every declared band back, and the PTY with it',
            standDownGrew && stoodDown && bandAfterStandDown !== null && bandAfterStandDown <= 24
            && nativeAfterStandDown.presented === 'false' && nativeAfterStandDown.title
            && rowsPlain !== null && rowsUnderBand !== null && rowsAfterStandDown !== null
            && rowsUnderBand.rows < rowsPlain.rows && rowsAfterStandDown.rows === rowsPlain.rows,
            `band ${String(bandAfterStandDown)} px · native ${JSON.stringify(nativeAfterStandDown)} · stty ${JSON.stringify(rowsPlain)} -> under the band ${JSON.stringify(rowsUnderBand)} -> ${JSON.stringify(rowsAfterStandDown)}`);
        // And the row stops reporting a failure the window has moved past.
        await openPlugins();
        const rowAfterStandDown = await statusRow();
        await closeSettings();
        rec.check('the pane.chrome row reports Bundled once the placement is handed back',
            !rowAfterStandDown.includes('Failed') && rowAfterStandDown.includes('Bundled'), rowAfterStandDown);
        await selectPresenter(labView);
        await closeSettings();
        await attached();
        await ready();

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
        await cli.ok(['layout', 'select', 'even-vertical'], { paneID: shellPane });
        if (!await frameCheck(`(() => {
            const bands = [...document.querySelectorAll('[data-testid="lab-pane-header"]')];
            return bands.length > 0 && bands.every(node => node.getBoundingClientRect().width > 700);
        })()`)) throw new Error('Restored lab headers did not receive the full-width layout');
        await shot('desktop-restored', 'Back on the desktop after the phone emulation: the "Pane chrome" workspace with every pane wearing a Pane Lab band again, no toast, and the title bar reading connected.');

        rec.note('LIMIT: the 240-calls-per-second budget breach is not pressed live; driving it from CDP measures the harness. See the header.');
        rec.note('LIMIT: cross-document pointer capture cannot be reproduced through CDP, which hit-tests each synthesized event and keeps no per-frame capture. The drag grip is a host element for that reason; what is asserted here is that a press in the frame selects nothing and moves nothing, and that a press on the grip moves the pane.');
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
        await safely('any toast still on screen is dismissed', async () => {
            for (let attempt = 0; attempt < 6; attempt += 1) {
                if (!await page.eval(`!!document.querySelector('[data-testid="toast-stack"]')`)) return;
                const closed = await page.eval(`(() => { const button = document.querySelector('[data-testid="toast-stack"] button'); if (button === null) return false; button.click(); return true; })()`);
                if (closed !== true) return;
                await sleep(200);
            }
        });
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
        await safely('the web pane this scenario opened is closed', async () => {
            if (webPaneID === null) return;
            await cli.run(['pane', 'close', '--target', webPaneID]);
        });
        await safely('the fixture agent session ends', async () => {
            if (metadataPane !== null) await cli.ok(['event', 'session-end', '--agent', 'codex'], { paneID: metadataPane });
        });
        await safely('every workspace this scenario created is deleted', async () => {
            if (crowdedID !== null) await cli.run(['workspace', 'delete', crowdedID, '--force']);
            await cli.run(['workspace', 'delete', workspaceID, '--force']);
        });
        await safely('the private metadata repository is removed', () => fs.rmSync(metadataRepo, { recursive: true, force: true }));
        await safely('the window returns to the workspace it started on', async () => {
            if (startingWorkspace === null) return;
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 10_000 })) await clickHost(row);
        });
    }
}

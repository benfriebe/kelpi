/**
 * A plugin drawing the find bar, against a real window, a real daemon and a real shell.
 *
 * The fifth replaceable surface: a view selected for `pane.search`, in Settings ▸ Plugins ▸
 * Workbench views, draws the bar that ⌘F opens over a shell pane. The unit suites pin the
 * projection, the clamp, the call validation, the latches and the relay grant. What only a live
 * window can answer is whether a needle typed into a plugin's own `<input>` reaches the DAEMON's
 * scrollback search, whether the counter it reads back is the count of a buffer this scenario
 * printed itself, whether the four relayed chords reach the window while everything else stays in
 * the sandbox, and - the hazard this whole surface has - whether the caret comes back to the shell
 * when the bar closes. So this presses all of it:
 *
 *   1. the placement is offered with its bundled entry named, the lab attaches as one isolated view
 *      for the whole grid, reports it has painted, and `data-pane-search-presenter` names it;
 *   2. `ui.selectView('pane.search', …)` is refused while `getWorkbench().slots` lists it;
 *   3. ⌘F over a shell pane opens the LAB's bar at the native bar's own rectangle, with the native
 *      bar absent - and no sample, during the attach or during a reload, ever finds an open search
 *      with no bar at all;
 *   4. typing in the lab's input sets the daemon's needle and the count matches a scrollback this
 *      scenario printed: N marker lines, so the number is known before the bar is opened;
 *   5. the lab's next button and ⌘G step the daemon's selection; ⇧⌘G steps back; and with Terminal
 *      Lab as the renderer the reveal is measured in its own `revealCount` and selection;
 *   6. the case toggle changes the TOTAL, which is the only honest proof it reached the recount;
 *   7. the daemon is the authority: switching to the bundled bar mid-search finds the native field
 *      holding the same needle and the same counter;
 *   8. Escape and ⌘F close, and a marker typed immediately afterwards lands in the SHELL - the
 *      caret hand-back, measured with `pane capture` rather than with a focus read;
 *   9. a chord the host does not relay, typed into the lab's input, reaches neither the window nor
 *      the shell;
 *  10. an absurd declared box is clamped in both axes; a call for another pane and a call while the
 *      search is closed are refused by message with nothing run;
 *  11. ⌘F over a markdown preview and over a web pane still opens their NATIVE bars;
 *  12. failure and recovery: a crash, then the native bar back with the daemon's needle intact and
 *      its input focused, the failure toast, the Settings row reading Failed and Retry - and then
 *      the acknowledgement watchdog doing the same to a presenter that has stopped acknowledging;
 *  13. standing the placement down withdraws the declared box;
 *  14. disable, enable and reload, with the selection retained;
 *  15. the PRIMARY daemon stopped and replaced;
 *  16. Pane Lab and Search Lab selected TOGETHER with a 96 px band: the lab's bar sits above the
 *      band and still works;
 *  17. a phone window keeping the native bar with the lab still selected;
 *  18. screenshots for the eyes, each with a note saying what to look for.
 *
 * ── What it depends on ──────────────────────────────────────────────────────────────
 *
 * `examples/plugins/search-lab` (plain JS, no build): one view `example.search-lab.search` for
 * `pane.search`, setting `document.body.dataset.ready = 'true'` once it has reported readiness and
 * exposing `globalThis.searchLab = { snapshot, ready, frames, lastError, crash(mode), stall(),
 * declare(size) }`. Its bar is read by test id - `lab-search` (`data-pane-id`), `lab-search-input`,
 * `lab-search-count`, `lab-search-next`, `lab-search-previous`, `lab-search-case`,
 * `lab-search-close`. Everything a check ASSERTS is read from the contract instead
 * (`searchLab.snapshot`, the host's own test ids, the daemon's own state through the CLI), so a
 * cosmetic change in the lab cannot turn a check green.
 *
 * `example.ui-lab` is installed as a SECOND plugin for one job: check 2 needs an ordinary plugin
 * frame to call `ui.getWorkbench` and `ui.selectView` from. `example.pane-lab` is installed for
 * check 16, and `example.terminal-lab` (built by the scenario) for check 5's reveal.
 *
 * The two failure hooks differ, and the checks are written to that difference.
 * `crash('uncaught')` fails the presenter THERE AND THEN, because an uncaught error is what the SDK
 * reports as a view error; a listener that merely throws is caught by the SDK and its frame is
 * still acknowledged. `stall()` only ARMS: it takes a frame that OPENS a session before the
 * watchdog has anything to wait for, so the arm and the next ⌘F go out together.
 *
 * ── Limits, on the record ───────────────────────────────────────────────────────────
 *
 *   - **The call-budget breach is not pressed live.** 240 calls per rolling second fails the
 *     presenter (`pane-search/presenter.ts` ▸ `charge`), and driving 240 calls through the frame in
 *     under a second from CDP measures the harness rather than the host.
 *     `pane-search/presenter.test.ts` owns it.
 *   - **The BUNDLED terminal renderer's reveal is not observable from the DOM.** ghostty-web
 *     scrolls inside a canvas and publishes no scroll offset or selection to this document, so with
 *     the bundled renderer this scenario asserts the daemon's selection moving and says no more.
 *     Check 5 uses Terminal Lab, which publishes `revealCount` and a real selection, and that is
 *     where the reveal itself is measured.
 *   - **Cross-document FOCUS transfer cannot be proved through CDP.** A synthesized click is
 *     hit-tested per event and the harness has no per-frame focus model, so "the caret is in the
 *     lab's field" is asserted through the lab's own `document.activeElement` and through the
 *     CONSEQUENCE - a marker typed after a close landing in the shell - rather than through the
 *     host's idea of who has focus. A real user's tab order and a real pointer are the owner's
 *     manual test.
 *   - **A second attached client is not opened.** Check 7 proves daemon authority the cheaper way,
 *     by handing the same live session to the NATIVE bar and reading the needle back out of it.
 *
 * Screenshots are blank in the `hidden` lane (the recorder says so in its own note); every check
 * here is a DOM, frame, CLI or measured-geometry assertion, and none of them reads a pixel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTerminalLab } from '../build-terminal-lab.mjs';
import { phoneToLanding } from '../ui-audit/lib/workbench.mjs';

/*
 * `examples/plugins/search-lab/` is the example this drives; `pane-search/` is the contract, the
 * box store, the projection, the presenter host and the slot it presses; `grid/` is where the box
 * is laid out and the native bar stands down; `plugins/` holds the Workbench select, the status
 * row, Retry and `PluginView`'s presenter grant; `features/` carries the bundled `kelpi.pane.search`
 * definition that is the recovery floor; `plugin-sdk/` is the public contract;
 * `protocol/src/plugins.ts` validates the placement, which check 1 is what would catch: a placement
 * missing from `PLUGIN_PLACEMENTS` fails the lab's manifest and the install with it. `App.tsx`
 * wires the session, the write path, the chord grant, the caret hand-back and the failure toast;
 * `connection/` carries the search verbs and check 15's real disconnect; `terminal/` is what
 * reveals a match; `content/` and `webpane/` are the two bars check 11 proves are still native;
 * `chrome/` owns the key dispatcher the relay reaches and the toast stack whose TEXT is asserted;
 * `pane-chrome/` is check 16's band; `phone/` is check 17's shell.
 */
export const covers = ['examples/plugins/search-lab/', 'packages/client/src/pane-search/',
    'packages/client/src/grid/', 'packages/client/src/plugins/', 'packages/client/src/features/',
    'packages/plugin-sdk/', 'packages/protocol/src/plugins.ts', 'packages/client/src/App.tsx',
    'packages/client/src/connection/', 'packages/client/src/terminal/',
    'packages/client/src/content/', 'packages/client/src/webpane/',
    'packages/client/src/chrome/', 'packages/client/src/pane-chrome/',
    'packages/client/src/phone/', 'packages/daemon/src/ws/search.ts'];

/**
 * The lowest lane this can be trusted at.
 *
 * Check 11 drives a REAL native page: it focuses a web pane's `WebContentsView` and presses ⌘F over
 * it. `hidden` paints the frame at zero opacity, and AppKit stops counting it as visible the moment
 * anything is in front of it - at which point Chromium drops the synthesized input CDP delivers to
 * that view, exactly as `plugin-browser-features` measured (`ui-audit/lib/placement.mjs`). Every
 * other check here is DOM and would be happy at `hidden`; that one would fail for the lane rather
 * than for the code.
 */
export const windowPlacement = 'offscreen';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const labID = 'example.search-lab', uiID = 'example.ui-lab';
const chromeID = 'example.pane-lab', termID = 'example.terminal-lab';
const labPath = path.join(repoRoot, 'examples/plugins/search-lab');
const uiPath = path.join(repoRoot, 'examples/plugins/ui-lab');
const chromePath = path.join(repoRoot, 'examples/plugins/pane-lab');
const labView = `${labID}.search`;
/** The recovery floor's own view id and the slot both of them are selected into. */
const bundledView = 'kelpi.pane.search', slot = 'pane.search';
/** Pane chrome's pair, for check 16. */
const chromeView = `${chromeID}.chrome`, chromeSlot = 'pane.chrome', chromeBundled = 'kelpi.pane.chrome';

const presenterSlot = `[data-testid="pane-search-presenter"][data-pane-search-presenter="${labView}"]`;
const presenterFrame = `${presenterSlot} iframe`;
const statusRowID = `pane-search-presenter-status-${slot}`;
const retryID = `pane-search-presenter-retry-${slot}`;

/** How many marker lines the scrollback gets, so the counter has a number to be right about. */
const MARKERS = 12;
/** The band check 16 declares, which is pane chrome's own ceiling. */
const TALL = 96;

export default async function ({ page, cli, sandbox, rec, d, sleep, daemon }) {
    if (!fs.existsSync(path.join(labPath, 'kelpi.plugin.json'))) {
        throw new Error(`search-lab is not in this checkout (${labPath}); the example has to land before this scenario can run`);
    }
    await page.watchFrames();
    const termPath = await buildTerminalLab(repoRoot);
    const json = async args => JSON.parse(await cli.ok(args));

    // ── the instruments ─────────────────────────────────────────────────────────────
    const inFrame = (expression, selector = presenterFrame) => page.evalInFrame(selector, expression);
    const frameCheck = (expression, ceilingMs = 12_000, selector = presenterFrame) => d.settle(async () => {
        try { return Boolean(await inFrame(expression, selector)); } catch { return false; }
    }, { ceilingMs });
    /** The last frame the presenter was DELIVERED. Null when the frame is gone or has had none. */
    const labSnapshot = async () => {
        try {
            const raw = await inFrame(`JSON.stringify(globalThis.searchLab?.snapshot ?? null)`);
            return typeof raw === 'string' ? JSON.parse(raw) : null;
        } catch { return null; }
    };
    /** Everything worth printing beside a failed check, from inside the presenter frame. */
    const labState = async () => {
        try {
            return await inFrame(`JSON.stringify({ ready: document.body.dataset.ready ?? null, visible: document.body.dataset.visible ?? null, frames: globalThis.searchLab?.frames ?? null, lastError: globalThis.searchLab?.lastError ?? null, needle: document.querySelector('[data-testid="lab-search-input"]')?.value ?? null, count: document.querySelector('[data-testid="lab-search-count"]')?.textContent ?? null })`);
        } catch (error) { return `frame unreadable: ${error instanceof Error ? error.message : String(error)}`; }
    };
    const ready = (ceilingMs = 15_000) => frameCheck(`document.body.dataset.ready === 'true'`, ceilingMs);
    const isolated = () => frameCheck(`(() => { try { parent.document.body; return false; } catch { return true; } })()`);
    const attached = (ceilingMs = 20_000) => d.settleDom(page, `document.querySelector('${presenterSlot}')`, { ceilingMs });
    const drawing = (ceilingMs = 12_000) => frameCheck(`document.body.dataset.visible === 'true'`, ceilingMs);
    const nativeBarGone = (paneID, ceilingMs = 10_000) =>
        d.settleDom(page, `!document.querySelector('[data-testid="pane-search-${paneID}"]')`, { ceilingMs });
    const nativeBarUp = (paneID, ceilingMs = 12_000) =>
        d.settleDom(page, `document.querySelector('[data-testid="pane-search-input-${paneID}"]')`, { ceilingMs });
    /** Arm one of the lab's hooks. `crash` and `stall` only set a flag the NEXT frame reads. */
    const arm = call => inFrame(`(() => { globalThis.searchLab.${call}; return true; })()`);
    /** A refused call's message, or `'resolved'` if the host let it through. */
    const refusal = expression => inFrame(`${expression}.then(() => 'resolved', error => error.message)`);

    const paneBox = selector => page.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return null; const box = node.getBoundingClientRect(); return JSON.stringify({x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height)}); })()`)
        .then(raw => (typeof raw === 'string' ? JSON.parse(raw) : null));
    const paneWrapperBox = paneID => paneBox(`[data-pane-id="${paneID}"]`);
    const focusedNow = () => page.eval(`document.querySelector('[data-pane-id][data-focused="true"]')?.getAttribute('data-pane-id') ?? null`);
    /**
     * Where the bar actually IS on screen, in the host's viewport.
     *
     * The host's clamped rectangle translated by the frame's own offset, NOT the lab element's
     * `getBoundingClientRect`. The two differ on purpose: the lab lays its bar out to its content
     * and the host CLIPS the frame to the box it granted, so on a narrow pane the element measures
     * wider than anything a user can see. A check that measured the element would be measuring the
     * part the clip removes.
     */
    const labBoxOnScreen = async () => {
        const frame = await paneBox(presenterFrame);
        const box = (await labSnapshot())?.box ?? null;
        if (frame === null || box === null) return null;
        return { x: box.x + frame.x, y: box.y + frame.y, width: box.width, height: box.height };
    };
    /** The lab element's own measured box, frame-local: what it DREW, before the host's clip. */
    const labDrawnBox = async () => {
        const raw = await inFrame(`(() => { const node = document.querySelector('[data-testid="lab-search"]'); if (node === null || node.hidden) return null; const box = node.getBoundingClientRect(); return JSON.stringify({x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height)}); })()`);
        return typeof raw === 'string' ? JSON.parse(raw) : null;
    };

    // ── Settings, which is the only route to this placement ─────────────────────────
    const settingsOpen = () => page.eval(`!!document.querySelector('[data-testid="settings-close"]')`);
    /**
     * Press a control in the host's document, and AIM before pressing.
     *
     * The `pane.search` row is the last one in a scrollable Settings panel, so its box can sit
     * below the panel's visible area - and a click at a point the browser hit-tests to something
     * else is a click that reports success and does nothing, which is how the first run of this
     * scenario "retried" a presenter that never came back. So: scroll it into view, ask
     * `elementFromPoint` who is actually there, and fall back to a synthetic click with a NOTE
     * rather than silently pressing the wrong thing.
     */
    const clickHost = async selector => {
        const present = await page.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.scrollIntoView({ block: 'center' }); return true; })()`);
        if (present !== true) return false;
        await sleep(80);
        const box = await paneBox(selector);
        if (box === null) return false;
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        const aimed = await page.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); const hit = document.elementFromPoint(${String(x)}, ${String(y)}); return node !== null && hit !== null && (node === hit || node.contains(hit) || hit.contains(node)); })()`);
        if (aimed === true) { await page.clickAt(x, y); return true; }
        rec.note(`aim missed ${selector} at ${String(Math.round(x))},${String(Math.round(y))}; pressed it directly instead`);
        return await page.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.click(); return true; })()`) === true;
    };
    const openSettings = async () => {
        if (await settingsOpen()) return true;
        /*
         * `chrome/keys.ts` refuses every non-menu-bar action while a chrome TEXT FIELD has the
         * caret, which is the rule this whole surface is built around - and a search bar that is
         * still open is exactly such a field. So the caret is released before the chord, or ⌘,
         * is declined and Settings silently never opens.
         */
        await page.eval(`(() => { const node = document.activeElement; if (node !== null && typeof node.blur === 'function' && node !== document.body) node.blur(); return true; })()`);
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
    const slotOptions = async (which = slot) => {
        const raw = await page.eval(`(() => {
            const select = document.querySelector('select[aria-label="${which}"]');
            return select === null ? null : JSON.stringify([...select.options].map(option => ({ value: option.value, label: (option.textContent ?? '').trim() })));
        })()`);
        return typeof raw === 'string' ? JSON.parse(raw) : [];
    };
    const labelFor = (options, viewID) => options.find(option => option.value === viewID)?.label ?? null;
    const chooseSlot = (viewID, which = slot) => page.eval(`(() => {
        const select = document.querySelector('select[aria-label="${which}"]');
        if (select === null) return false;
        select.value = ${JSON.stringify(viewID)};
        select.dispatchEvent(new Event('change', {bubbles:true}));
        return select.value === ${JSON.stringify(viewID)};
    })()`);
    const slotValue = (which = slot) => page.eval(`document.querySelector('select[aria-label="${which}"]')?.value ?? null`);
    const statusRow = () => page.eval(`document.querySelector('[data-testid="${statusRowID}"]')?.textContent ?? ''`);
    const retry = async () => {
        if (!await d.settleDom(page, `document.querySelector('[data-testid="${retryID}"]')`, { ceilingMs: 6_000 })) {
            rec.note(`no Retry button on the pane.search row (${await statusRow()}), so the placement was not retried`);
            return false;
        }
        await clickHost(`[data-testid="${retryID}"]`);
        return true;
    };
    const selectPresenter = async (viewID, which = slot) => { await openPlugins(); return await chooseSlot(viewID, which); };

    const shot = async (label, eyes) => {
        const file = await rec.shot(page, label);
        rec.note(`EYES ${path.basename(file)}: ${eyes}`);
        return file;
    };

    // ── the shell, and what it is told ──────────────────────────────────────────────
    const send = async (paneID, line) => {
        await cli.ok(['pane', 'send', '--target', paneID, line]);
        await cli.run(['pane', 'send-key', '--target', paneID, 'enter']);
    };
    const capture = paneID => cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
    /** Put the caret on the pane body, which is the gesture a user makes before searching. */
    const focusPaneBody = async paneID => {
        const body = await paneBox(`[data-testid="pane-body-${paneID}"]`);
        if (body === null) return false;
        await page.clickAt(body.x + body.width / 2, body.y + Math.min(60, body.height / 2));
        return await d.settle(async () => await focusedNow() === paneID, { ceilingMs: 8_000 });
    };
    /** Open the search with the real chord, from the pane. */
    const openSearch = async paneID => {
        await focusPaneBody(paneID);
        await sleep(150);
        await page.key('KeyF', { modifiers: 4 });
    };
    /**
     * Type into the lab's field, the way a real find bar is typed into.
     *
     * `insertText` rather than `page.type`: CDP's key-at-a-time path dispatches a `keyDown` carrying
     * text AND a `char` event, and a real `<input>` inserts on both - measured here as
     * `NNEEEEDDLLEEFFIINNDD` for a ten-character needle. `page.type` exists for a TERMINAL, which is
     * a canvas and consumes the key event itself; a text field takes the IME-style commit instead,
     * which is what `plugin-pane-chrome` already does for the native find bar.
     */
    const typeIntoLab = async text => {
        // Inside the host's CLIPPED rectangle, not the element's own box: on a narrow pane the bar
        // is drawn wider than the clip, and a click outside the clip reaches the terminal instead -
        // which leaves the frame unfocused and sends `insertText` to the host document.
        const visible = await labBoxOnScreen();
        if (visible !== null && visible.width > 24) {
            await page.clickAt(visible.x + Math.min(24, visible.width / 3), visible.y + visible.height / 2);
        }
        // The click lands wherever the clip allows, so the focus is also asked for directly: this
        // helper is about the TYPING reaching the daemon, not about how the caret got there. Check 9
        // is where the caret's own position is asserted.
        await inFrame(`(() => { const node = document.querySelector('[data-testid="lab-search-input"]'); if (node === null) return false; node.focus(); node.setSelectionRange(node.value.length, node.value.length); return true; })()`);
        await page.insertText(text);
        return true;
    };
    const labNeedle = () => inFrame(`document.querySelector('[data-testid="lab-search-input"]')?.value ?? null`);
    const labCount = () => inFrame(`document.querySelector('[data-testid="lab-search-count"]')?.textContent ?? null`);
    const pressLab = testid => inFrame(`(() => { const node = document.querySelector('[data-testid="${testid}"]'); if (node === null) return false; node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`);

    // Where the window was before this scenario took it: restored at the end, because the sandbox
    // and its window are shared with whatever runs next.
    const startingWorkspace = await page.eval(`document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.getAttribute('data-workspace-id') ?? null`);
    const workspace = await json(['workspace', 'create', '--name', 'Pane search', '--json']);
    const workspaceID = workspace.workspace_id;
    /** The web pane check 11 measures, hoisted so the cleanup can close it after a throw. */
    let webPaneID = null;
    let uiFrame = '';

    try {
        // ── 1 · the placement is offered, and the lab attaches ───────────────────────
        await cli.ok(['plugin', 'install', labPath, '--trust']);
        await cli.ok(['plugin', 'install', uiPath, '--trust']);
        await cli.ok(['plugin', 'install', chromePath, '--trust']);
        await cli.ok(['plugin', 'install', termPath, '--trust']);
        const uiPane = await json(['plugin', 'open', uiID, `${uiID}.panel`, '--workspace', workspaceID]);
        uiFrame = `[data-testid="plugin-view-${uiPane.paneID}"] iframe`;
        if (!await d.settle(async () => {
            try { return await page.evalInFrame(uiFrame, `document.body.dataset.ready === 'true'`); } catch { return false; }
        }, { ceilingMs: 20_000 })) throw new Error('UI Lab did not attach');

        const shellPane = (await json(['pane', 'create', '--workspace', workspaceID, '--json'])).pane_id;
        await d.settleDom(page, `document.querySelector('[data-testid="pane-header-${shellPane}"]')`, { ceilingMs: 15_000 });
        // The scrollback the counter has to be right about: printed BEFORE the bar exists, so the
        // number is a fact of this scenario rather than something read back off the screen.
        await send(shellPane, `for i in $(seq 1 ${MARKERS}); do echo "NEEDLEFIND line $i"; done`);
        await d.settle(async () => (await capture(shellPane)).split('NEEDLEFIND').length - 1 >= MARKERS, { ceilingMs: 20_000 });

        await openPlugins();
        const options = await slotOptions();
        const offered = options.some(option => option.value === labView);
        const bundledLabel = labelFor(options, bundledView);
        const chosen = await chooseSlot(labView);
        rec.check('Settings offers the pane.search placement and selects the lab for it',
            offered && chosen && await slotValue() === labView, `options ${JSON.stringify(options)}`);
        rec.check('the pane.search select names its bundled entry as the recovery floor',
            bundledLabel === 'Pane search (bundled)', String(bundledLabel));
        await closeSettings();

        const up = await attached();
        const paintedFirst = up && await ready();
        rec.check('the lab attaches as ONE isolated view for the whole grid and reports it has painted',
            up && paintedFirst && await isolated()
            && await page.eval(`document.querySelectorAll('[data-testid="pane-search-presenter"] iframe').length`) === 1,
            `attached ${String(up)} · ${await labState()}`);

        // ── 2 · Settings-only selection ──────────────────────────────────────────────
        const workbench = await page.evalInFrame(uiFrame, `kelpi.ui.getWorkbench().then(value => JSON.stringify(value.slots))`);
        const listed = (typeof workbench === 'string' ? JSON.parse(workbench) : []).find(entry => entry.id === slot);
        const refused = await page.evalInFrame(uiFrame,
            `kelpi.ui.selectView(${JSON.stringify(slot)}, ${JSON.stringify(labView)}).then(() => 'resolved', error => error.message)`);
        rec.check('pane.search is listed in getWorkbench().slots and refused by ui.selectView',
            listed !== undefined && listed.viewID === labView && String(refused).includes('not registered'),
            `${JSON.stringify(listed)} · ${String(refused)}`);

        // ── 3 · ⌘F opens the LAB's bar, where the native one would have been ─────────
        //
        // The native rectangle is measured FIRST, from the bundled bar on the same pane, so the
        // comparison is against this window's own geometry rather than against a constant.
        await selectPresenter(bundledView);
        await closeSettings();
        await openSearch(shellPane);
        const nativeUp = await nativeBarUp(shellPane);
        const nativeBox = await paneBox(`[data-testid="pane-search-${shellPane}"]`);
        await page.key('Escape');
        await d.settleDom(page, `!document.querySelector('[data-testid="pane-search-${shellPane}"]')`, { ceilingMs: 8_000 });
        await selectPresenter(labView);
        await closeSettings();
        await attached();
        await ready();

        /*
         * Sampled from the chord onwards: a search may never be open with no bar at all.
         *
         * Every sample taken while the presenter is not drawing has to find the NATIVE bar, and at
         * least one such sample has to exist or the check proves nothing - the same shape
         * `plugin-pane-chrome` uses for its reload.
         */
        await focusPaneBody(shellPane);
        await sleep(150);
        await page.key('KeyF', { modifiers: 4 });
        const samples = [];
        for (let attempt = 0; attempt < 140; attempt += 1) {
            const raw = await page.eval(`(() => {
                const slot = document.querySelector('[data-testid="pane-search-presenter"]');
                return JSON.stringify({
                    shown: slot?.dataset.shown ?? 'none',
                    searching: slot?.dataset.paneId ?? '',
                    native: !!document.querySelector('[data-testid="pane-search-input-${shellPane}"]')
                });
            })()`);
            const sample = typeof raw === 'string' ? JSON.parse(raw) : null;
            if (sample !== null) samples.push(sample);
            if (sample?.shown === 'true' && sample.searching === shellPane) break;
            await sleep(25);
        }
        const opening = samples.filter(sample => sample.searching === shellPane && sample.shown !== 'true');
        const barless = opening.filter(sample => !sample.native);
        const labUp = await drawing();
        const labBox = await labBoxOnScreen();
        const gone = await nativeBarGone(shellPane);
        rec.check('⌘F over a shell pane opens the LAB\'s bar and the native bar is gone',
            labUp && gone && labBox !== null
            && await inFrame(`document.querySelector('[data-testid="lab-search"]')?.dataset.paneId`) === shellPane,
            `lab ${String(labUp)} · native gone ${String(gone)} · ${await labState()}`);
        const drawn = await labDrawnBox();
        rec.check('the lab\'s bar sits where the NATIVE bar sat, at the pane\'s top-trailing corner, and is clipped to it',
            nativeUp && nativeBox !== null && labBox !== null && drawn !== null
            && Math.abs(labBox.y - nativeBox.y) <= 2
            && Math.abs((labBox.x + labBox.width) - (nativeBox.x + nativeBox.width)) <= 4
            // The native bar holds itself to `calc(100% - 16px)` on a narrow pane and so does the
            // clamp, so the two agree on width as well as on where the trailing edge is.
            && Math.abs(labBox.width - nativeBox.width) <= 4
            // And the lab drew MORE than that: the clip is what a user sees, not the element.
            && drawn.width >= labBox.width,
            `native ${JSON.stringify(nativeBox)} · clipped ${JSON.stringify(labBox)} · drawn ${JSON.stringify(drawn)}`);
        rec.check('no search is ever open with no bar at all while the presenter is coming up',
            samples.length > 0 && barless.length === 0 && samples.at(-1)?.shown === 'true',
            `${String(samples.length)} samples, ${String(opening.length)} before the swap, ${String(barless.length)} barless: ${JSON.stringify(barless.slice(0, 3))}`);

        // ── 4 · typing reaches the DAEMON's needle, and the count is the buffer's ────
        await typeIntoLab('NEEDLEFIND');
        const needleReached = await d.settle(async () => (await labNeedle()) === 'NEEDLEFIND', { ceilingMs: 12_000 });
        const counted = await d.settle(async () => /\bof\b|matches/.test(String(await labCount() ?? '')), { ceilingMs: 15_000 });
        const countText = String(await labCount() ?? '');
        const snapshot = await labSnapshot();
        rec.check('typing in the lab\'s input sets the daemon\'s needle and counts the scrollback this scenario printed',
            needleReached && counted && snapshot?.needle === 'NEEDLEFIND'
            && typeof snapshot?.total === 'number' && snapshot.total >= MARKERS,
            `needle ${String(await labNeedle())} · count "${countText}" · frame ${JSON.stringify(snapshot && { needle: snapshot.needle, total: snapshot.total, selected: snapshot.selected })}`);

        // ── 5 · stepping, and the reveal ────────────────────────────────────────────
        const selectedNow = async () => (await labSnapshot())?.selected ?? null;
        await pressLab('lab-search-next');
        const steppedByButton = await d.settle(async () => await selectedNow() === 0, { ceilingMs: 10_000 });
        // ⌘G is relayed into the window and answered by the slot: it has no bound action anywhere,
        // so if the grant or the listener were wrong nothing at all would happen.
        await page.key('KeyG', { modifiers: 4 });
        const steppedByChord = await d.settle(async () => await selectedNow() === 1, { ceilingMs: 10_000 });
        await page.key('KeyG', { modifiers: 4 | 8 });
        const steppedBack = await d.settle(async () => await selectedNow() === 0, { ceilingMs: 10_000 });
        rec.check('the next button, ⌘G and ⇧⌘G step the daemon\'s selection',
            steppedByButton && steppedByChord && steppedBack,
            `button ${String(steppedByButton)} · ⌘G ${String(steppedByChord)} · ⇧⌘G ${String(steppedBack)} · selected ${String(await selectedNow())}`);
        /*
         * ── 5b · the reveal, with a PLUGIN terminal renderer underneath ──────────────
         *
         * The reveal stays native (ratified decision 7), and "native" includes a replacement
         * renderer, which receives search through its own contract. Terminal Lab is selected here
         * rather than anywhere else because it is the only renderer in this checkout that publishes
         * what it did: `terminalLab.revealCount` and a real xterm selection. The bundled renderer
         * scrolls inside a canvas and tells this document nothing, which is the limit in the header.
         */
        await page.key('Escape');
        await d.settle(async () => (await labSnapshot())?.visible !== true, { ceilingMs: 8_000 });
        const rendererSelect = `[data-terminal-pane="${shellPane}"] select[aria-label="Terminal renderer"]`;
        const rendererOffered = await d.settleDom(page, `document.querySelector(${JSON.stringify(rendererSelect)})`, { ceilingMs: 12_000 });
        let revealed = false, revealDetail = 'renderer select missing';
        if (rendererOffered) {
            await page.eval(`(() => { const select = document.querySelector(${JSON.stringify(rendererSelect)}); select.value = ${JSON.stringify(`${termID}.terminal`)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
            const termFrame = `[data-testid="plugin-view-${shellPane}"] iframe`;
            const termReady = await d.settle(async () => {
                try { return await page.evalInFrame(termFrame, `document.body.dataset.ready === 'true' && !!globalThis.terminalLab?.session`); } catch { return false; }
            }, { ceilingMs: 30_000 });
            const revealsBefore = termReady
                ? Number(await page.evalInFrame(termFrame, `globalThis.terminalLab?.revealCount ?? 0`))
                : -1;
            await openSearch(shellPane);
            await drawing();
            await typeIntoLab('NEEDLEFIND');
            await d.settle(async () => ((await labSnapshot())?.total ?? 0) >= MARKERS, { ceilingMs: 15_000 });
            await pressLab('lab-search-next');
            revealed = termReady && await d.settle(async () => {
                try { return Number(await page.evalInFrame(termFrame, `globalThis.terminalLab?.revealCount ?? 0`)) > revealsBefore; } catch { return false; }
            }, { ceilingMs: 15_000 });
            const selection = termReady
                ? await page.evalInFrame(termFrame, `JSON.stringify(globalThis.terminalLab?.terminal?.getSelectionPosition() ?? null)`)
                : null;
            revealDetail = `ready ${String(termReady)} · reveals ${String(revealsBefore)} -> ${termReady ? String(await page.evalInFrame(termFrame, `globalThis.terminalLab?.revealCount ?? 0`)) : 'n/a'} · selection ${String(selection)}`;
        }
        rec.check('a plugin terminal renderer and a search presenter compose: stepping still reveals the match in the pane',
            rendererOffered && revealed, revealDetail);
        // Back to the bundled renderer, so nothing after this measures Terminal Lab by accident.
        if (rendererOffered) {
            await page.eval(`(() => { const select = document.querySelector(${JSON.stringify(rendererSelect)}); if (select === null) return; select.value = 'kelpi.shell'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
            await d.settleDom(page, `document.querySelector('[data-terminal-pane="${shellPane}"]')?.dataset.terminalRenderer === 'kelpi.shell'`, { ceilingMs: 20_000 });
        }
        await drawing();

        await shot('lab-bar-over-shell', 'The focused shell pane with SEARCH LAB\'s bar in its top-right corner - a needle field holding NEEDLEFIND, a counter reading "1 of 12" or similar, an Aa toggle and up/down/× buttons - and NO second find bar anywhere. The bar must sit over the pane\'s header corner, fully visible, not sliced by the pane edge.');

        // ── 6 · the case toggle changes the TOTAL ───────────────────────────────────
        await inFrame(`(() => { const f = document.querySelector('[data-testid="lab-search-input"]'); f.value = 'needlefind'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        const lowered = await d.settle(async () => (await labSnapshot())?.needle === 'needlefind', { ceilingMs: 12_000 });
        const insensitiveTotal = await d.settle(async () => ((await labSnapshot())?.total ?? 0) >= MARKERS, { ceilingMs: 15_000 })
            ? (await labSnapshot())?.total ?? null : null;
        await pressLab('lab-search-case');
        const sensitive = await d.settle(async () => (await labSnapshot())?.caseSensitive === true, { ceilingMs: 10_000 });
        const sensitiveTotal = await d.settle(async () => ((await labSnapshot())?.total ?? null) === 0, { ceilingMs: 15_000 })
            ? 0 : (await labSnapshot())?.total ?? null;
        rec.check('the case toggle reaches the recount: a lower-case needle matches nothing once it is case sensitive',
            lowered && sensitive && insensitiveTotal !== null && insensitiveTotal >= MARKERS && sensitiveTotal === 0,
            `needle ${String((await labSnapshot())?.needle)} · insensitive ${String(insensitiveTotal)} -> sensitive ${String(sensitiveTotal)}`);
        // Back to a needle that matches, so the daemon-authority check has something to show.
        await pressLab('lab-search-case');
        await inFrame(`(() => { const f = document.querySelector('[data-testid="lab-search-input"]'); f.value = 'NEEDLEFIND'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await d.settle(async () => ((await labSnapshot())?.total ?? 0) >= MARKERS, { ceilingMs: 15_000 });

        // ── 7 · the daemon is the authority ─────────────────────────────────────────
        //
        // The same LIVE session handed to the native bar: the needle and the counter are workspace
        // state, so the bar that takes over is the bar the user was already using.
        const beforeHandover = await labSnapshot();
        await selectPresenter(bundledView);
        await closeSettings();
        const nativeBack = await nativeBarUp(shellPane);
        const nativeNeedle = await page.eval(`document.querySelector('[data-testid="pane-search-input-${shellPane}"]')?.value ?? null`);
        const nativeCount = await page.eval(`document.querySelector('[data-testid="pane-search-count-${shellPane}"]')?.textContent ?? null`);
        rec.check('handing the live session to the native bar finds the same needle and the same counter',
            nativeBack && nativeNeedle === beforeHandover?.needle && String(nativeCount ?? '').includes('/'),
            `needle ${String(nativeNeedle)} (lab had ${String(beforeHandover?.needle)}) · count ${String(nativeCount)}`);
        await selectPresenter(labView);
        await closeSettings();
        await attached();
        await ready();
        await drawing();

        // ── 8 · Escape and ⌘F close, and the caret comes back to the shell ──────────
        //
        // Measured with `pane capture` rather than with a focus read: what matters is not who the
        // window thinks has the caret, it is where the next keystroke LANDS.
        const escapeMarker = `CARET-ESC-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        await page.key('Escape');
        const closedByEscape = await d.settle(async () => (await labSnapshot())?.visible === false, { ceilingMs: 10_000 });
        await sleep(250);
        await page.type(escapeMarker);
        const escapeLanded = await d.settle(async () => (await capture(shellPane)).includes(escapeMarker), { ceilingMs: 12_000 });
        await cli.run(['pane', 'send-key', '--target', shellPane, 'ctrl+u']);

        const chordMarker = `CARET-CMDF-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        await openSearch(shellPane);
        await drawing();
        await inFrame(`(() => { document.querySelector('[data-testid="lab-search-input"]')?.focus(); return true; })()`);
        await page.key('KeyF', { modifiers: 4 });
        const closedByChord = await d.settle(async () => (await labSnapshot())?.visible === false, { ceilingMs: 10_000 });
        await sleep(250);
        await page.type(chordMarker);
        const chordLanded = await d.settle(async () => (await capture(shellPane)).includes(chordMarker), { ceilingMs: 12_000 });
        await cli.run(['pane', 'send-key', '--target', shellPane, 'ctrl+u']);
        rec.check('Escape and ⌘F both close the search, and the next keystroke lands in the SHELL',
            closedByEscape && escapeLanded && closedByChord && chordLanded,
            `escape closed ${String(closedByEscape)} landed ${String(escapeLanded)} · ⌘F closed ${String(closedByChord)} landed ${String(chordLanded)}`);

        // ── 9 · an unrelayed chord leaks nowhere ────────────────────────────────────
        await openSearch(shellPane);
        await drawing();
        await typeIntoLab('NEEDLE');
        // The caret has to actually BE in the lab's field, or this check measures nothing: a chord
        // pressed with the host holding the caret was never in the sandbox to leak out of it.
        const caretInField = await frameCheck(`document.activeElement?.dataset.testid === 'lab-search-input'`, 8_000);
        const needleBeforeLeak = (await labSnapshot())?.needle ?? null;
        const panesBefore = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        // ⌘D is `split_right`, which is bound, wired and destructive to this check if it fires. It
        // is not in the relay grant, so it must stay in the sandbox and do nothing at all.
        await page.key('KeyD', { modifiers: 4 });
        await sleep(700);
        const panesAfter = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        const stillOpen = (await labSnapshot())?.visible === true;
        const needleAfterLeak = (await labSnapshot())?.needle ?? null;
        rec.check('a chord the host does not relay stays in the frame: no split, no close, nothing typed',
            caretInField && panesAfter === panesBefore && stillOpen && needleAfterLeak === needleBeforeLeak,
            `caret in field ${String(caretInField)} · panes ${String(panesBefore)} -> ${String(panesAfter)} · bar still up ${String(stillOpen)} · needle ${String(needleBeforeLeak)} -> ${String(needleAfterLeak)}`);

        // ── 10 · the clamp, and two refusals by message ─────────────────────────────
        const wrapper = await paneWrapperBox(shellPane);
        await inFrame(`(() => { globalThis.searchLab.declare({ width: 99999, height: 99999 }); return true; })()`);
        const clamped = await d.settle(async () => {
            const box = (await labSnapshot())?.box ?? null;
            return box !== null && box.width <= 480 && box.height <= 96;
        }, { ceilingMs: 12_000 });
        // Compared in the HOST's viewport, because the frame's box is grid-local and the pane's is
        // not: two numbers in two coordinate spaces are not a containment test.
        const clampedOnScreen = await labBoxOnScreen();
        rec.check('an absurd declared box is clamped in BOTH axes and never leaves the pane',
            clamped && clampedOnScreen !== null && wrapper !== null
            && clampedOnScreen.width <= 480 && clampedOnScreen.height <= 96
            && clampedOnScreen.x >= wrapper.x - 1
            && clampedOnScreen.x + clampedOnScreen.width <= wrapper.x + wrapper.width + 1
            && clampedOnScreen.y + clampedOnScreen.height <= wrapper.y + wrapper.height + 1,
            `pane ${JSON.stringify(wrapper)} · box on screen ${JSON.stringify(clampedOnScreen)} · declared 99999x99999`);
        await inFrame(`(() => { globalThis.searchLab.declare(null); return true; })()`);

        const otherPane = (await json(['pane', 'list', '--workspace', workspaceID, '--json']))
            .map(pane => pane.id).find(id => id !== shellPane) ?? 'not-a-pane';
        const needleBeforeForged = (await labSnapshot())?.needle ?? null;
        const crossPane = await refusal(`kelpi.ui.setSearchNeedle(${JSON.stringify(otherPane)}, 'FORGED')`);
        const forged = await refusal(`kelpi.ui.searchNext('not-a-pane-at-all')`);
        const needleAfterForged = (await labSnapshot())?.needle ?? null;
        rec.check('a call naming another pane is refused by message, and re-reading proves nothing ran',
            String(crossPane).includes('not the one being searched')
            && String(forged).includes('not the one being searched')
            && needleAfterForged === needleBeforeForged,
            `cross-pane ${String(crossPane)} · forged ${String(forged)} · needle ${String(needleBeforeForged)} -> ${String(needleAfterForged)}`);

        // And a call while the search is CLOSED, which is what stops a presenter opening one.
        const searchedPane = (await labSnapshot())?.paneID ?? shellPane;
        await page.key('Escape');
        await d.settle(async () => (await labSnapshot())?.visible === false, { ceilingMs: 10_000 });
        const whileClosed = await refusal(`kelpi.ui.setSearchNeedle(${JSON.stringify(searchedPane)}, 'REOPEN')`);
        const stayedClosed = await page.eval(`!document.querySelector('[data-testid="pane-search-input-${shellPane}"]')`);
        rec.check('a presenter cannot open a search: every call while none is open is refused and nothing opens',
            String(whileClosed).includes('No search is open') && stayedClosed === true,
            `${String(whileClosed)} · native bar up ${String(!stayedClosed)}`);

        // ── 11 · the two bars that stay native ──────────────────────────────────────
        const repository = path.join(sandbox.work, 'search-docs');
        fs.mkdirSync(repository, { recursive: true });
        const markdownFile = path.join(repository, 'notes.md');
        fs.writeFileSync(markdownFile, '# Search Lab\n\nNEEDLEFIND in a preview\n');
        await cli.ok(['open', markdownFile], { cwd: repository, paneID: shellPane });
        let markdownPane = null;
        await d.settle(async () => {
            markdownPane = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).find(pane => pane.type === 'markdown')?.id ?? null;
            return markdownPane !== null;
        }, { ceilingMs: 20_000 });
        let markdownNative = false, markdownPresented = true;
        if (markdownPane !== null) {
            await focusPaneBody(markdownPane);
            await sleep(150);
            await page.key('KeyF', { modifiers: 4 });
            markdownNative = await d.settleDom(page, `document.querySelector('[data-testid="content-find-input-${markdownPane}"]')`, { ceilingMs: 12_000 });
            markdownPresented = (await labSnapshot())?.visible === true;
            await page.key('Escape');
        }

        const opened = await cli.ok(['web', 'open', 'about:blank']);
        const webPane = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1] ?? null;
        if (webPane === null) throw new Error(`no web pane opened: ${opened.trim()}`);
        webPaneID = webPane;
        await d.settleDom(page, `document.querySelector('[data-testid="web-page-${webPane}"]')?.dataset.visible === 'true'`, { ceilingMs: 25_000 });
        await focusPaneBody(webPane);
        await sleep(150);
        await page.key('KeyF', { modifiers: 4 });
        const webNative = await d.settleDom(page, `document.querySelector('[data-testid="web-find-input-${webPane}"]')`, { ceilingMs: 12_000 });
        const webPresented = (await labSnapshot())?.visible === true;
        rec.check('⌘F over a markdown preview and over a web pane still opens their NATIVE bars, and the presenter draws nothing',
            markdownNative && !markdownPresented && webNative && !webPresented,
            `markdown pane ${String(markdownPane)} native ${String(markdownNative)} presented ${String(markdownPresented)} · web native ${String(webNative)} presented ${String(webPresented)}`);
        // The shot is taken while the bar is UP: a picture of the pane after it closed is a picture
        // of nothing this check is about.
        await shot('native-bars-untouched', 'The WEB pane with KELPI\'S OWN find bar open in its corner - a field, a counter and a ✕ in the bundled recipe, not Search Lab\'s wording. No Search Lab bar anywhere on screen, and no second bar over the shell pane.');
        await page.key('Escape');

        // ── 12 · failure and recovery ───────────────────────────────────────────────
        await openSearch(shellPane);
        await drawing();
        await typeIntoLab('NEEDLEFIND');
        await d.settle(async () => ((await labSnapshot())?.total ?? 0) >= MARKERS, { ceilingMs: 15_000 });
        const needleBeforeCrash = (await labSnapshot())?.needle ?? null;
        await arm(`crash('uncaught')`);
        /*
         * A frame the crash can run inside, and it has to MOVE: the host de-duplicates by frame
         * content, so a step on a needle with no matches publishes nothing and the armed hook never
         * fires. Changing the needle always moves it.
         */
        await typeIntoLab('X');
        const fellBack = await nativeBarUp(shellPane, 20_000);
        const nativeNeedleAfterCrash = await page.eval(`document.querySelector('[data-testid="pane-search-input-${shellPane}"]')?.value ?? null`);
        const nativeCountAfterCrash = await page.eval(`document.querySelector('[data-testid="pane-search-count-${shellPane}"]')?.textContent ?? null`);
        // The toast is read BEFORE any settle: it expires, and a poll in front of it spends its life.
        const toast = await d.settleDom(page, `document.querySelector('[data-testid="toast-stack"]')?.textContent?.includes('Pane search presenter')`, { ceilingMs: 10_000 });
        const toastText = String(await page.eval(`document.querySelector('[data-testid="toast-stack"]')?.textContent ?? 'none'`));
        /*
         * The caret is SETTLED for, not read once. The native bar focuses itself on mount and the
         * focused pane's own claim answers the removed iframe by taking it, so the host re-asserts
         * the field for a bounded window afterwards - and a single read lands inside that window.
         */
        await d.settle(async () =>
            await page.eval(`document.activeElement?.getAttribute('data-testid') ?? null`) === `pane-search-input-${shellPane}`,
        { ceilingMs: 6_000 });
        const nativeFocusAfterCrash = await page.eval(`document.activeElement?.getAttribute('data-testid') ?? null`);
        const activeAfterCrash = await page.eval(`(() => { const node = document.activeElement; return node === null ? 'none' : node.tagName + ' [' + (node.getAttribute('data-testid') ?? '-') + '] ' + String(node.className || '-').slice(0, 40); })()`);
        /*
         * The needle SURVIVES, which is the whole point of the daemon owning it. A prefix rather
         * than an equality, because the frame the crash rode in on was the one that changed the
         * needle, so the daemon may or may not have stored that last character before the presenter
         * died - and either answer is the state being intact.
         */
        rec.check('a crash puts the NATIVE bar back with the daemon\'s needle intact and its input focused',
            fellBack && typeof nativeNeedleAfterCrash === 'string'
            && needleBeforeCrash !== null && nativeNeedleAfterCrash.startsWith(needleBeforeCrash)
            && nativeFocusAfterCrash === `pane-search-input-${shellPane}`
            && String(nativeCountAfterCrash ?? '').includes('/'),
            `needle ${String(needleBeforeCrash)} -> ${String(nativeNeedleAfterCrash)} · focus ${String(nativeFocusAfterCrash)} (active ${String(activeAfterCrash)}) · count ${String(nativeCountAfterCrash)}`);
        rec.check('the failure is reported on screen, naming the surface and the reason',
            toast && toastText.includes('Pane search presenter') && /crashed on purpose/i.test(toastText), toastText);
        await shot('fallback-after-crash', 'Kelpi\'s own find bar back over the shell pane, holding NEEDLEFIND with its counter, and a failure toast in the corner reading "Pane search presenter". No Search Lab bar anywhere.');

        await openPlugins();
        const failedRow = await statusRow();
        // Read while Settings is OPEN: a select queried after the dialog closed is a null read that
        // agrees with nothing.
        const retained = await slotValue();
        const retried = await retry();
        const rowAfterRetry = await statusRow();
        await closeSettings();
        const anySlot = await d.settleDom(page, `document.querySelector('[data-testid="pane-search-presenter"]')`, { ceilingMs: 20_000 });
        const slotBack = retried && anySlot && await attached();
        const cameBack = slotBack && await ready();
        // Printed whatever happens, because "the presenter did not come back" has three different
        // causes and the row, the plugin's own status and the slot's presence tell them apart.
        const pluginStatus = (await json(['plugin', 'list', '--json'])).find(entry => entry.manifest.id === labID);
        rec.check('Settings reports the failure, keeps the selection, and Retry brings the presenter back',
            failedRow.includes('Failed') && retained !== bundledView && retried && cameBack,
            `${failedRow} -> after retry "${rowAfterRetry}" · selection ${String(retained)} · retried ${String(retried)} · any slot ${String(anySlot)} · slot back ${String(slotBack)} · plugin ${JSON.stringify(pluginStatus && { enabled: pluginStatus.enabled, status: pluginStatus.status })} · ${await labState()}`);

        // ── 12b · the acknowledgement watchdog ──────────────────────────────────────
        await page.key('Escape');
        await d.settle(async () => (await labSnapshot())?.visible !== true, { ceilingMs: 8_000 });
        await arm('stall()');
        // A frame that OPENS a session, which is the one the watchdog waits for.
        await openSearch(shellPane);
        const stalledOut = await nativeBarUp(shellPane, 20_000);
        rec.check('a presenter that stops acknowledging is failed by the watchdog and the native bar comes back',
            stalledOut, await labState());
        await page.key('Escape');
        await openPlugins();
        await retry();
        await closeSettings();
        await attached();
        await ready();

        // ── 13 · standing the placement down withdraws the box ──────────────────────
        await openSearch(shellPane);
        await drawing();
        /*
         * A HEIGHT rather than a width. The width ceiling is the smaller of 480 px and the pane's
         * inner width, and by this point the workspace has a markdown pane in it, so the shell is
         * a couple of hundred pixels wide and no declaration can make the box wider than that. The
         * height ceiling is the smaller of 96 px and a quarter of the pane, which a tall pane has
         * room for - so the declaration is observable and the withdrawal is too.
         */
        await inFrame(`(() => { globalThis.searchLab.declare({ width: 200, height: 90 }); return true; })()`);
        const declaredBox = await d.settle(async () => ((await labSnapshot())?.box?.height ?? 0) >= 80, { ceilingMs: 12_000 });
        await selectPresenter(bundledView);
        await closeSettings();
        const nativeAfterStandDown = await nativeBarUp(shellPane);
        const nativeBoxAfter = await paneBox(`[data-testid="pane-search-${shellPane}"]`);
        rec.check('choosing the bundled bar withdraws the declared box and the native bar is its own size again',
            declaredBox && nativeAfterStandDown && nativeBoxAfter !== null && nativeBox !== null
            && Math.abs(nativeBoxAfter.height - nativeBox.height) <= 2,
            `declared ${String(declaredBox)} · native ${JSON.stringify(nativeBox)} -> ${JSON.stringify(nativeBoxAfter)}`);
        await openPlugins();
        const rowAfterStandDown = await statusRow();
        await closeSettings();
        rec.check('the pane.search row reports Bundled once the placement is handed back',
            !rowAfterStandDown.includes('Failed') && rowAfterStandDown.includes('Bundled'), rowAfterStandDown);
        await selectPresenter(labView);
        await closeSettings();
        await attached();
        await ready();

        // ── 14 · disable, enable and reload, with the selection retained ────────────
        await cli.ok(['plugin', 'disable', labID]);
        const disabledBack = await nativeBarUp(shellPane);
        await cli.ok(['plugin', 'enable', labID]);
        const enabledBack = await attached() && await ready();
        await cli.ok(['plugin', 'reload', labID]);
        const reloadSamples = [];
        for (let attempt = 0; attempt < 140; attempt += 1) {
            const raw = await page.eval(`(() => {
                const slot = document.querySelector('[data-testid="pane-search-presenter"]');
                return JSON.stringify({
                    shown: slot?.dataset.shown ?? 'none',
                    native: !!document.querySelector('[data-testid="pane-search-input-${shellPane}"]')
                });
            })()`);
            const sample = typeof raw === 'string' ? JSON.parse(raw) : null;
            if (sample !== null) reloadSamples.push(sample);
            if (sample?.shown === 'true') break;
            await sleep(25);
        }
        const bootingReload = reloadSamples.filter(sample => sample.shown !== 'true');
        const barlessReload = bootingReload.filter(sample => !sample.native);
        const reloaded = await attached() && await ready() && await drawing();
        await openPlugins();
        const retainedValue = await slotValue();
        const latchedAfterReload = (await statusRow()).includes('Failed');
        await closeSettings();
        rec.check('disable, enable and reload all keep the selection and end with the lab drawing',
            disabledBack && enabledBack && reloaded && retainedValue === labView && !latchedAfterReload,
            `disabled ${String(disabledBack)} · enabled ${String(enabledBack)} · reloaded ${String(reloaded)} · selection ${String(retainedValue)} · latched ${String(latchedAfterReload)}`);
        rec.check('the search is never left with no bar while a reloading presenter boots',
            reloadSamples.length > 0 && barlessReload.length === 0,
            `${String(reloadSamples.length)} samples, ${String(bootingReload.length)} before the swap, ${String(barlessReload.length)} barless: ${JSON.stringify(barlessReload.slice(0, 3))}`);

        // ── 15 · the daemon replaced under the presenter ────────────────────────────
        if (daemon === null) rec.note('LIMIT: no sandbox daemon handle (--attach), so the disconnect check was skipped');
        else {
            const pidBefore = daemon.pid, generationBefore = daemon.generation;
            await daemon.restart();
            const offline = await d.settleDom(page, `!document.querySelector('[data-testid="pane-search-presenter"]')`, { ceilingMs: 20_000 });
            const reconnected = await d.settleDom(page, `document.querySelector('[data-connection]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 30_000 });
            const back = reconnected && await attached(30_000) && await ready(20_000);
            await openPlugins();
            const latched = (await statusRow()).includes('Failed');
            const stillSelected = await slotValue();
            await closeSettings();
            rec.check('a daemon restart stands the placement down while disconnected, and the presenter re-attaches with nothing latched',
                offline && reconnected && back && !latched && stillSelected === labView
                && daemon.pid !== pidBefore && daemon.generation === generationBefore + 1,
                `pid ${String(pidBefore)} -> ${String(daemon.pid)} · offline ${String(offline)} · back ${String(back)} · latched ${String(latched)} · selection ${String(stillSelected)} · ${await labState()}`);
            rec.note(`the daemon was replaced (stop ${String(daemon.lastStopMs)} ms, start to healthz ${String(daemon.lastStartMs)} ms)`);
        }

        /*
         * The markers, printed again.
         *
         * A daemon restart replaces the process and every PTY dies with it, so the scrollback the
         * counter was right about in check 4 is gone and a needle typed after this point would
         * count zero - which is a true answer to the wrong question. Check 16 is about the two
         * presenters composing, so it needs a buffer to find something in.
         */
        await send(shellPane, `for i in $(seq 1 ${MARKERS}); do echo "NEEDLEFIND line $i"; done`);
        await d.settle(async () => (await capture(shellPane)).split('NEEDLEFIND').length - 1 >= MARKERS, { ceilingMs: 25_000 });

        // ── 16 · a search presenter ON TOP OF a pane chrome presenter ───────────────
        //
        // The two placements compose or they do not, and the answer is geometric: the chrome
        // presenter's frame sits at z 2 and this one at z 4, so a 96 px band must not swallow the
        // bar the way it swallowed the NATIVE one before #244 lifted the pane wrapper.
        await selectPresenter(chromeView, chromeSlot);
        await closeSettings();
        const chromeSlotUp = await d.settleDom(page, `document.querySelector('[data-testid="pane-chrome-presenter"][data-shown="true"]')`, { ceilingMs: 25_000 });
        await page.evalInFrame(`[data-testid="pane-chrome-presenter"] iframe`,
            `(() => { globalThis.paneLab.declare(${JSON.stringify(shellPane)}, ${String(TALL)}); return true; })()`);
        const bandGrew = await d.settle(async () => ((await paneBox(`[data-testid="pane-header-${shellPane}"]`))?.height ?? 0) > 60, { ceilingMs: 15_000 });
        await openSearch(shellPane);
        const barOverBand = await drawing();
        const barBoxOverBand = await labBoxOnScreen();
        const bandBox = await paneBox(`[data-testid="pane-header-${shellPane}"]`);
        // It still WORKS, which is the half a picture cannot prove: the needle still reaches the
        // daemon while another plugin owns the band underneath it.
        await typeIntoLab('NEEDLEFIND');
        const stillCounts = await d.settle(async () => ((await labSnapshot())?.total ?? 0) >= MARKERS, { ceilingMs: 15_000 });
        rec.check('with Pane Lab drawing a 96 px band, the Search Lab bar is above it and still drives the daemon',
            chromeSlotUp && bandGrew && barOverBand && stillCounts
            && barBoxOverBand !== null && bandBox !== null
            && barBoxOverBand.y >= bandBox.y - 2,
            `band ${JSON.stringify(bandBox)} · bar ${JSON.stringify(barBoxOverBand)} · total ${String((await labSnapshot())?.total)}`);
        await shot('search-over-pane-chrome', 'The shell pane wearing a TALL Pane Lab header band with SEARCH LAB\'s bar drawn OVER it at the top right - the needle field, the counter and the buttons all fully visible above the plugin band rather than sliced by it.');
        await page.key('Escape');
        await selectPresenter(chromeBundled, chromeSlot);
        await closeSettings();
        await d.settleDom(page, `!document.querySelector('[data-testid="pane-chrome-presenter"]')`, { ceilingMs: 15_000 });

        // ── 17 · the phone keeps the native bar ─────────────────────────────────────
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const phoneShell = await d.settleDom(page, `document.querySelector('[data-testid="phone-shell"]')`, { ceilingMs: 20_000 });
        const phonePresenter = await page.eval(`!!document.querySelector('[data-testid="pane-search-presenter"]')`);
        rec.check('a phone window keeps the native bar with the lab still selected',
            phoneShell && !phonePresenter, `shell ${String(phoneShell)} · presenter ${String(phonePresenter)}`);
        await phoneToLanding(page, d, { note: message => rec.note(message) });
        await page.send('Emulation.clearDeviceMetricsOverride');
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await d.settleDom(page, `!document.querySelector('[data-testid="phone-shell"]')`, { ceilingMs: 20_000 });
        await attached(25_000);
        await ready(20_000);
        await shot('desktop-restored', 'Back on the desktop after the phone emulation: the "Pane search" workspace with no find bar open anywhere, no toast, and the title bar reading connected.');

        rec.note('LIMIT: the 240-calls-per-second budget breach is not pressed live; driving it from CDP measures the harness. See the header.');
        rec.note('LIMIT: the bundled terminal renderer\'s scroll-to-match is inside a canvas and publishes nothing to this document, so the reveal itself is not asserted against it; what is asserted here is the daemon\'s selection moving.');
        rec.note('LIMIT: cross-document focus transfer cannot be reproduced through CDP, which hit-tests each synthesized event and keeps no per-frame focus model. The caret is asserted through its consequence - a marker typed after a close landing in the shell - and a real pointer and tab order are the owner\'s manual test.');
    } catch (error) {
        await rec.shot(page, 'failure-live');
        throw error;
    } finally {
        /*
         * The sandbox, its daemon AND its window outlive this scenario, and five things outlive the
         * workspace it deletes: two saved presenter selections, the phone's remembered place,
         * whatever overlay was on screen when a check threw, and which workspace the window is
         * looking at. Each step is taken and none is allowed to skip the rest.
         */
        const safely = async (what, step) => {
            try { await step(); } catch (error) { rec.note(`cleanup: ${what} - ${error instanceof Error ? error.message : String(error)}`); }
        };
        await safely('the phone returns to its landing page', async () => { if (!await phoneToLanding(page, d, { note: message => rec.note(`cleanup: ${message}`) })) rec.note('cleanup: the phone shell never reached its landing page'); });
        await safely('device metrics are cleared', () => page.send('Emulation.clearDeviceMetricsOverride'));
        await safely('touch emulation is cleared', () => page.send('Emulation.setTouchEmulationEnabled', { enabled: false }));
        await safely('any search still open is closed', async () => {
            for (let attempt = 0; attempt < 4; attempt += 1) {
                if (!await page.eval(`!!document.querySelector('[data-testid^="pane-search-input-"]') || document.querySelector('[data-testid="pane-search-presenter"]')?.dataset.shown === 'true'`)) return;
                await page.key('Escape');
                await sleep(200);
            }
        });
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
         * Both selections go back to the BUNDLED surface rather than being left naming a view that
         * is about to be removed, and it is done BEFORE the plugins are removed so the selects still
         * have both entries to choose between. The declared box goes back with it: standing a
         * presenter down drops the declaration, which is the same path the fallback takes.
         */
        await safely('pane.search goes back to the bundled bar', async () => {
            await selectPresenter(bundledView);
            await d.settleDom(page, `!document.querySelector('[data-testid="pane-search-presenter"]')`, { ceilingMs: 10_000 });
        });
        await safely('pane.chrome goes back to the bundled header', async () => {
            await selectPresenter(chromeBundled, chromeSlot);
            await d.settleDom(page, `!document.querySelector('[data-testid="pane-chrome-presenter"]')`, { ceilingMs: 10_000 });
        });
        await safely('the Settings overlay is closed', () => closeSettings());
        await safely('the plugins are removed', async () => {
            await cli.run(['plugin', 'remove', labID]);
            await cli.run(['plugin', 'remove', uiID]);
            await cli.run(['plugin', 'remove', chromeID]);
            await cli.run(['plugin', 'remove', termID]);
        });
        await safely('the web pane this scenario opened is closed', async () => {
            if (webPaneID === null) return;
            await cli.run(['pane', 'close', '--target', webPaneID]);
        });
        await safely('the workspace this scenario created is deleted', async () => {
            await cli.run(['workspace', 'delete', workspaceID, '--force']);
        });
        await safely('the window returns to the workspace it started on', async () => {
            if (startingWorkspace === null) return;
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 10_000 })) await clickHost(row);
        });
    }
}

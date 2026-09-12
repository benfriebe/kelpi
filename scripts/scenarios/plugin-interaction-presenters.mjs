/**
 * Selectable interaction presenters, against a real window.
 *
 * Step 3 of the palette-and-shared-prompt phase lets a plugin view be chosen, in Settings ▸ Plugins
 * ▸ Workbench views, to DRAW the command palette (`interaction.palette`) or the shared modal prompts
 * (`interaction.prompts`) that every other plugin raises through `kelpi.ui.show*`. The unit suites
 * pin the projection, the watchdogs and the latch; what only a real window can answer is whether the
 * chosen frame actually receives the session, whether a keystroke crossing the iframe boundary still
 * reaches the host, and - the one that matters most - whether a promise somebody is awaiting is
 * still answerable when the frame drawing it dies. So this scenario presses all of it:
 *
 *   1. both placements are offered in Settings, and the two chosen views attach as isolated frames;
 *   2. `ui.selectView` refuses both placements while `getWorkbench().slots` still lists them;
 *   3. ⌘P through the plugin palette: real session rows, typing that filters inside the iframe,
 *      Enter that creates exactly one pane, a disabled row that creates none, and the two relayed
 *      chords (Escape, ⌘W) that dismiss and hand the caret back to the pane;
 *   4. a UI Lab quick pick / input / dialog presented by the plugin: owner display name with no
 *      plugin id anywhere in the frame, answers that reach UI Lab, cancels that return null, native
 *      chords that stand down, `queued` counting a second request, and one waiting behind Settings;
 *   5. the two carve-outs: a password input and a notification stay bundled;
 *   6. failure and recovery: a crash while a prompt is LIVE, the same request id re-presented by the
 *      bundled dialog, an answer that still reaches its plugin, the failure toast, the Settings
 *      status row, Retry - and then the acknowledgement watchdog doing the same thing on a stall;
 *   7. disable / enable / reload, with the selection retained throughout;
 *   8. a palette presenter crashing with the palette OPEN: the session goes, ⌘P draws bundled;
 *   9. a phone window keeping both bundled presenters with the lab still selected;
 *  10. four screenshots for the eyes, each with a note saying what to look for.
 *
 * ── What it depends on ──────────────────────────────────────────────────────────────
 *
 * `examples/plugins/interaction-lab` (plain JS, no build): `example.interaction-lab.palette` for
 * `interaction.palette`, `example.interaction-lab.prompts` for `interaction.prompts`, each setting
 * `document.body.dataset.ready = 'true'` once it has reported readiness and exposing
 * `globalThis.interactionLab = { snapshot, ready, frames, lastError, crash(), stall() }`. The rows
 * and controls are read by test id - `lab-palette`, `lab-palette-input`, `lab-palette-row`,
 * `lab-prompt`, `lab-prompt-input`, `lab-prompt-item`, `lab-prompt-action` - with `data-item-id`,
 * `data-request-id` and `data-action-id` on the rows. Everything else is read from the CONTRACT
 * (`interactionLab.snapshot`, the host's own test ids), never from the example's private shape, so a
 * cosmetic change in the lab cannot silently turn a check green.
 *
 * Both failure hooks only ARM: they set a flag the next frame reads, so every use here produces a
 * frame afterwards (a request queued behind the live one, or a keystroke that moves the host-owned
 * palette query). `crash('uncaught')` is the mode used throughout, because a listener that merely
 * throws is caught by the SDK and its frame is still acknowledged - the acknowledgement proves the
 * frame reached the sandbox, never that the view drew it - while an uncaught error is what the SDK
 * reports as a view error and `InteractionPresenterSlot` fails the placement on.
 *
 * ── Two limits, on the record ───────────────────────────────────────────────────────
 *
 *   - **No daemon disconnect/reconnect.** Fallback rule 3 (`interaction/presenter-slot.tsx`) draws
 *     bundled while the connection is down, and the honest way to press it is to stop the PRIMARY
 *     daemon under a live window. `scripts/scenario.mjs` hands a scenario `cli`, `sandbox` and
 *     `shell` but not `t.daemon`, and `plugin-remote.mjs`'s scaffolding only buys a SECOND daemon,
 *     which is not the runtime a presenter is selected for (window UI is the primary runtime's,
 *     `docs/plugin-ui.md` ▸ Shared prompts). Disable, reload and the two watchdogs exercise the same
 *     latch-and-retry path here; the connection arm stays covered by `presenter-slot`'s unit suite.
 *   - **Native chords under a PAINTED presenter are absorbed by the frame, not relayed.** ⌘, and ⌘D
 *     are deliberately outside `interactionPresenterChords`, so with the caret inside the presenter
 *     iframe they never reach the host at all. Check 4's assertion is therefore the observable one -
 *     no pane appeared, no Settings opened, the request is still up - which is the promise either
 *     way; `plugin-ui-services.mjs` presses the same chords against the bundled presenter, where
 *     they DO reach the window and are stood down there.
 *
 * Screenshots are blank in the `hidden` lane (the recorder says so in its own note); every check
 * here is a DOM/CLI assertion, and none of them measures a pixel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * `examples/plugins/interaction-lab/` is the example this drives; `interaction/` is the surface and
 * the presenter slot it presses; `features/` carries `palette-source.ts`, whose descriptors are the
 * rows a presenter renders and whose `execute` is what an Enter must go back through; `plugins/`
 * holds the Workbench selects, the status row and `PluginView`'s presenter grant and chord relay;
 * `plugin-sdk/` is the public contract (`interaction.d.ts`); `protocol/src/plugins.ts` validates the
 * two placements and refuses them to containers.
 *
 * The last four are pressed just as hard, and each has already broken this scenario once: `App.tsx`
 * wires the surface, the presenter chord grant and the toast stack whose corner box sits over the
 * phone's pane rows; `chrome/` owns the bundled palette card and the modal-presence registry a
 * prompt waits behind; `phone/` is check 9's shell; `settings/` is the panel holding the presenter
 * selects, the status row and Retry.
 */
export const covers = ['examples/plugins/interaction-lab/', 'packages/client/src/interaction/', 'packages/client/src/features/',
    'packages/client/src/plugins/', 'packages/plugin-sdk/', 'packages/protocol/src/plugins.ts',
    'packages/client/src/App.tsx', 'packages/client/src/chrome/', 'packages/client/src/phone/', 'packages/client/src/settings/'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const labID = 'example.interaction-lab', uiID = 'example.ui-lab';
const labPath = path.join(repoRoot, 'examples/plugins/interaction-lab');
const uiPath = path.join(repoRoot, 'examples/plugins/ui-lab');
const paletteView = `${labID}.palette`, promptsView = `${labID}.prompts`;
/** Whichever wrapper draws carries the test id; `data-interaction-presenter` names who it is. */
const paletteSlot = `[data-interaction-presenter="${paletteView}"]`, promptsSlot = `[data-interaction-presenter="${promptsView}"]`;
const paletteFrame = `${paletteSlot} iframe`, promptsFrame = `${promptsSlot} iframe`;
const bundledPalette = '[data-testid="interaction-presenter-palette"][data-interaction-presenter="bundled"]';
const bundledPrompts = '[data-testid="interaction-presenter-prompts"][data-interaction-presenter="bundled"]';
const modal = '[data-testid="plugin-ui-dialog"]';
const notice = '[data-testid="plugin-ui-notification"]';

const CARET_PANE = `(() => {
    const active = document.activeElement;
    if (active === null) return '';
    const surface = active.closest('[data-pane-surface]');
    if (surface === null) return '';
    const pane = surface.closest('[data-pane-id]');
    return pane === null ? '' : (pane.getAttribute('data-pane-id') ?? '');
})()`;
const CARET_HTML = `(() => { const active = document.activeElement; return active === null ? '<null>' : String(active.outerHTML ?? active.nodeName).slice(0, 120); })()`;

export default async function ({ page, cli, rec, d, sleep }) {
    if (!fs.existsSync(path.join(labPath, 'kelpi.plugin.json'))) {
        throw new Error(`interaction-lab is not in this checkout (${labPath}); the example has to land before this scenario can run`);
    }
    await page.watchFrames();
    const json = async args => JSON.parse(await cli.ok(args));

    // ── the instruments ─────────────────────────────────────────────────────────────
    const inFrame = (selector, expression) => page.evalInFrame(selector, expression);
    const frameCheck = (selector, expression, ceilingMs = 12_000) => d.settle(async () => {
        try { return Boolean(await inFrame(selector, expression)); } catch { return false; }
    }, { ceilingMs });
    const labSnapshot = async selector => {
        const raw = await inFrame(selector, `JSON.stringify(globalThis.interactionLab?.snapshot ?? null)`);
        return typeof raw === 'string' ? JSON.parse(raw) : null;
    };
    /** Everything worth printing beside a failed check, from inside the presenter frame. */
    const labState = async selector => {
        try {
            return await inFrame(selector, `JSON.stringify({ ready: document.body.dataset.ready ?? null, frames: globalThis.interactionLab?.frames ?? null, lastError: globalThis.interactionLab?.lastError ?? null, snapshot: globalThis.interactionLab?.snapshot ?? null })`);
        } catch (error) { return `frame unreadable: ${error instanceof Error ? error.message : String(error)}`; }
    };
    const ready = selector => frameCheck(selector, `document.body.dataset.ready === 'true'`);
    const isolated = selector => frameCheck(selector, `(() => { try { parent.document.body; return false; } catch { return true; } })()`);
    const attached = (viewID, ceilingMs = 15_000) => d.settleDom(page, `document.querySelector('[data-interaction-presenter="${viewID}"]')`, { ceilingMs });
    const painted = (viewID, ceilingMs = 10_000) => d.settleDom(page, `document.querySelector('[data-interaction-presenter="${viewID}"]')?.hidden === false`, { ceilingMs });
    const standingBy = (viewID, ceilingMs = 10_000) => d.settleDom(page, `document.querySelector('[data-interaction-presenter="${viewID}"]')?.hidden === true`, { ceilingMs });
    const drawsBundled = (selector, ceilingMs = 10_000) => d.settleDom(page, `document.querySelector('${selector}')`, { ceilingMs });
    /**
     * Arm one of the lab's failure hooks. Both only set a flag that the NEXT frame reads, so every
     * use below has to produce a frame afterwards - a queued request, or a keystroke that moves the
     * host-owned palette query. `crash('uncaught')` is the mode that actually fails a presenter: a
     * listener that merely throws is caught by the SDK and its frame is still acknowledged, because
     * an acknowledgement proves a frame reached the sandbox and never that the view understood it.
     */
    const arm = (frame, call) => inFrame(frame, `(() => { globalThis.interactionLab.${call}; return true; })()`);
    const clickFrame = async (frame, target) => {
        if (!await frameCheck(frame, `(() => { const node = document.querySelector(${JSON.stringify(target)}); return node && !node.disabled; })()`)) {
            throw new Error(`Missing or disabled ${target} in ${frame}: ${await labState(frame)}`);
        }
        const inner = await inFrame(frame, `(() => { const node = document.querySelector(${JSON.stringify(target)}); node.scrollIntoView({block:'center',inline:'center'}); const box = node.getBoundingClientRect(); return {x:box.x + box.width/2, y:box.y + box.height/2, width:box.width, height:box.height}; })()`);
        // Two frames, as `plugin-ui-services.mjs` does: a box measured mid-layout aims at where the
        // pane used to be.
        await page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        const outer = await page.box(frame);
        if (!outer || !inner.width || !inner.height) throw new Error(`no visible ${target} in ${frame}`);
        const point = { x: outer.x + inner.x, y: outer.y + inner.y };
        /*
         * Aim checked before the press: a hidden overlay, a pane that moved or a frame scrolled
         * out from under the point all produce the same silent miss, and a click that lands on
         * something else is otherwise only visible as "the prompt never arrived" much later.
         */
        const hit = await page.eval(`(() => {
            const node = document.elementFromPoint(${point.x}, ${point.y});
            if (node === null) return 'nothing';
            const frame = document.querySelector(${JSON.stringify(frame)});
            return node === frame || frame?.contains(node) ? 'frame' : (node.outerHTML ?? node.nodeName).slice(0, 160);
        })()`);
        if (hit !== 'frame') throw new Error(`${target} in ${frame} is covered at ${JSON.stringify(point)}: ${String(hit)}`);
        await page.clickAt(point.x, point.y);
    };
    const selectAll = async () => {
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4 });
    };
    const typeInFrame = async (frame, target, text) => { await clickFrame(frame, target); await selectAll(); await page.insertText(text); };
    const openPalette = () => page.key('KeyP', { modifiers: 4, key: 'p', keyCode: 80 });
    /**
     * Focus a pane and open the palette on it, retried.
     *
     * ⌘P is a window shortcut, and the window stands down while a request is still ACTIVE - which
     * includes the tail of one that has just been cancelled, while the surface is releasing the
     * caret it took. Observed once at `docs/audit/scenarios/2026-09-12T06-15-17-041Z`, immediately
     * after an Escape that had already returned null to its plugin: the chord arrived into that
     * window and nothing opened. A user would press ⌘P again, and so does this.
     */
    const openPaletteOn = async (paneID, expect) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await d.focusPaneBody(page, paneID);
            await openPalette();
            if (await expect()) return true;
            await sleep(400);
        }
        return false;
    };
    const pluginPaletteOpen = (ceilingMs = 4_000) => painted(paletteView, ceilingMs);
    const bundledPaletteOpen = (ceilingMs = 4_000) => d.settleDom(page,
        `document.querySelector('${bundledPalette} [data-testid="command-palette"]') && document.querySelectorAll('[data-testid="palette-row"]').length > 0`, { ceilingMs });
    const closeChord = () => page.key('KeyW', { modifiers: 4, key: 'w', keyCode: 87 });
    const caretIn = paneID => d.settle(async () => await page.eval(CARET_PANE) === paneID, { ceilingMs: 5_000 });

    const openPlugins = async () => {
        await page.key('Comma', { modifiers: 4, key: ',' });
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`);
        await page.click('[data-testid="settings-tab-button-plugins"]');
        await d.settleDom(page, `document.querySelector('[data-testid="plugin-placements"]')`);
    };
    const closeSettings = async () => {
        await page.click('[data-testid="settings-close"]');
        await d.settleDom(page, `!document.querySelector('[data-testid="settings-close"]')`);
    };
    /** A slot select's options as `{value, label}` - the label matters: it is the route back. */
    const slotOptions = async slot => {
        const raw = await page.eval(`(() => {
            const select = document.querySelector('select[aria-label="${slot}"]');
            return select === null ? null : JSON.stringify([...select.options].map(option => ({ value: option.value, label: (option.textContent ?? '').trim() })));
        })()`);
        return typeof raw === 'string' ? JSON.parse(raw) : [];
    };
    const labelFor = (options, viewID) => options.find(option => option.value === viewID)?.label ?? null;
    const chooseSlot = (slot, viewID) => page.eval(`(() => {
        const select = document.querySelector('select[aria-label="${slot}"]');
        if (select === null) return false;
        select.value = ${JSON.stringify(viewID)};
        select.dispatchEvent(new Event('change', {bubbles:true}));
        return select.value === ${JSON.stringify(viewID)};
    })()`);
    const slotValue = slot => page.eval(`document.querySelector('select[aria-label="${slot}"]')?.value ?? null`);
    const statusRow = slot => page.eval(`document.querySelector('[data-testid="interaction-presenter-status-${slot}"]')?.textContent ?? ''`);
    /**
     * Click something in the host page that may be scrolled out of its own panel. `page.click` aims
     * at the element's rect whether or not anything else is over it, and the presenter rows sit at
     * the bottom of a scrolling Settings section, so this scrolls first and then checks the aim.
     */
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
    const retry = slot => clickHost(`[data-testid="interaction-presenter-retry-${slot}"]`);
    /** Click a button in the bundled dialog by its visible label, aim-checked like `clickHost`. */
    const clickModalButton = async label => {
        const aim = JSON.parse(String(await page.eval(`(() => {
            const buttons = [...document.querySelectorAll('${modal} button')];
            const button = buttons.find(node => (node.textContent ?? '').trim() === ${JSON.stringify(label)});
            if (button === undefined) return JSON.stringify({ ok: false, hit: 'no ${label} among ' + buttons.map(node => (node.textContent ?? '').trim()).join('/') });
            button.scrollIntoView({ block: 'center' });
            const box = button.getBoundingClientRect();
            const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            const hit = document.elementFromPoint(point.x, point.y);
            return JSON.stringify({ ...point, ok: hit === button || button.contains(hit), hit: hit === null ? 'nothing' : String(hit.outerHTML ?? hit.nodeName).slice(0, 140) });
        })()`)));
        if (!aim.ok) throw new Error(`the bundled dialog's "${label}" button is not clickable: ${String(aim.hit)}`);
        await page.clickAt(aim.x, aim.y);
    };
    /**
     * Wait for the native toast stack to empty.
     *
     * A toast is a real box in the bottom-right corner (`z-40`) for its six seconds. It no longer
     * holds whole-window modal presence - it registers its RECT - so nothing stands down for it any
     * more and it simply sits over whatever is beneath it. On a 390 px phone that is most of the
     * width, which is how the stall watchdog's failure toast ended up over the phone's pane rows.
     * Anything that clicks the lower right of the window waits for it first.
     */
    const toastsGone = (ceilingMs = 12_000) => d.settleDom(page, `!document.querySelector('[data-testid="toast-stack"]')`, { ceilingMs });
    /**
     * Put the phone shell back on its landing page.
     *
     * `phone/place.ts` remembers `{host, workspaceID}` in `localStorage` for whatever workspace the
     * phone last had on screen, and a remembered place means the next phone window opens THERE
     * instead of on the landing page - which is the host picker every other phone scenario starts
     * from (`plugin-remote`, `plugin-terminal-features`, `plugin-chrome-features`). Going back to
     * the landing page is what clears it (`phone/view.ts`), so this is the undo for check 9's two
     * taps rather than a poke at storage. A no-op on a desktop window and on the landing page,
     * where the button is deliberately not drawn.
     */
    const phoneToLanding = async () => {
        if (!await page.eval(`!!document.querySelector('[data-testid="phone-shell"]')`)) return true;
        if (await page.eval(`!!document.querySelector('[data-testid="phone-landing"]')`)) return true;
        if (!await d.settleDom(page, `document.querySelector('[data-testid="phone-open-landing"]')`, { ceilingMs: 5_000 })) return false;
        await clickHost('[data-testid="phone-open-landing"]');
        return await d.settleDom(page, `document.querySelector('[data-testid="phone-landing"]')`, { ceilingMs: 5_000 });
    };
    /**
     * Answer the BUNDLED dialog's input.
     *
     * Two things are proven rather than assumed, because both have been observed failing in a real
     * window. The field must actually HAVE the text before it is submitted: a pane's caret arbiter
     * can take the window back between the click and the keystrokes, and then the value went to a
     * terminal and the prompt is still pending with nothing to show for it. And the submit is the
     * dialog's own **Continue** button rather than Enter, which needs the field to hold the caret at
     * that exact moment: what this scenario is asserting is that the ANSWER reaches the requesting
     * plugin, not the bundled dialog's key handling (`plugin-ui-services.mjs` presses that).
     */
    const answerBundled = async (label, value) => {
        const input = `${modal} input[aria-label=${JSON.stringify(label)}]`;
        const started = Date.now();
        const diagnostics = async () => String(await page.eval(`JSON.stringify({
            dialogs: [...document.querySelectorAll('[data-testid="plugin-ui-dialog"]')].map(node => ({ request: node.getAttribute('data-request-id'), width: node.getBoundingClientRect().width })),
            backdropHidden: document.querySelector('[data-testid="plugin-ui-backdrop"]')?.hidden ?? null,
            value: document.querySelector(${JSON.stringify(input)})?.value ?? null,
            active: String(document.activeElement?.outerHTML ?? document.activeElement?.nodeName ?? '').slice(0, 120),
            presenters: [...document.querySelectorAll('[data-interaction-presenter]')].map(node => node.getAttribute('data-interaction-presenter') + (node.hidden ? ':hidden' : ':painted'))
        })`));
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(input)})?.getBoundingClientRect().width > 0`, { ceilingMs: 10_000 })) {
            throw new Error(`the bundled "${label}" input never became clickable: ${await diagnostics()}`);
        }
        const waited = Date.now() - started;
        let typed = false;
        for (let attempt = 0; attempt < 4 && !typed; attempt += 1) {
            await clickHost(input);
            await selectAll();
            await page.insertText(value);
            typed = await d.settleDom(page, `document.querySelector(${JSON.stringify(input)})?.value === ${JSON.stringify(value)}`, { ceilingMs: 2_000 });
        }
        if (!typed) throw new Error(`the bundled "${label}" field never took its text: ${await diagnostics()}`);
        await clickModalButton('Continue');
        return waited;
    };
    const shot = async (label, eyes) => {
        const file = await rec.shot(page, label);
        rec.note(`EYES ${path.basename(file)}: ${eyes}`);
        return file;
    };

    // Where the window was before this scenario took it: restored at the end, because the sandbox
    // and its window are shared with whatever runs next.
    const startingWorkspace = await page.eval(`document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.getAttribute('data-workspace-id') ?? null`);
    const workspace = await json(['workspace', 'create', '--name', 'Interaction presenters', '--json']);
    const workspaceID = workspace.workspace_id;
    const panes = () => json(['pane', 'list', '--workspace', workspaceID, '--json']);
    const uiSnapshot = () => json(['plugin', 'run', `${uiID}.snapshot`]);
    const toggle = (field, value) => cli.ok(['plugin', 'run', `${uiID}.toggle`, '--args', JSON.stringify({ field, value })]);
    let uiFrame = '';
    const uiReady = () => frameCheck(uiFrame, `document.body.dataset.ready === 'true'`);
    const output = (name, value) => frameCheck(uiFrame, `document.getElementById('${name}-result').textContent === ${JSON.stringify(JSON.stringify(value))}`);
    const raise = expression => inFrame(uiFrame, expression);
    /**
     * Press one of UI Lab's prompt buttons and prove the request was actually raised: its output
     * field reads `Waiting…` for exactly as long as the promise is pending, so a click that missed
     * the button, or a call the host refused, fails here with what the panel is really showing
     * rather than later as "the prompt never reached the presenter".
     */
    const askUILab = async name => {
        await clickFrame(uiFrame, `#${name}`);
        if (!await frameCheck(uiFrame, `document.getElementById('${name}-result').textContent === 'Waiting…'`, 6_000)) {
            throw new Error(`UI Lab did not raise its ${name} prompt: ${await inFrame(uiFrame, `JSON.stringify({ result: document.getElementById('${name}-result').textContent, disabled: document.getElementById('${name}').disabled, error: document.getElementById('error').textContent })`)}`);
        }
    };
    const dataset = key => frameCheck(uiFrame, `document.body.dataset.${key} !== undefined`);
    const datasetValue = key => inFrame(uiFrame, `document.body.dataset.${key} ?? null`);

    try {
        // ── 1 · both placements are offered, and both views attach ───────────────────
        await cli.ok(['plugin', 'install', labPath, '--trust']);
        await cli.ok(['plugin', 'install', uiPath, '--trust']);
        const shellPane = (await panes())[0].id;
        const uiPane = await json(['plugin', 'open', uiID, `${uiID}.panel`, '--workspace', workspaceID]);
        uiFrame = `[data-testid="plugin-view-${uiPane.paneID}"] iframe`;
        if (!await uiReady()) throw new Error('UI Lab did not attach');
        await openPlugins();
        const paletteChoices = await slotOptions('interaction.palette');
        const promptChoices = await slotOptions('interaction.prompts');
        const offered = labelFor(paletteChoices, paletteView) !== null && labelFor(promptChoices, promptsView) !== null;
        /*
         * The route BACK, read from the live select rather than assumed. A replaced palette looks
         * exactly like an unreplaced one, so the bundled entry has to say which one is the floor -
         * and a user who cannot find it is a user stuck with a presenter they no longer want.
         */
        const bundledLabels = [labelFor(paletteChoices, 'kelpi.palette'), labelFor(promptChoices, 'kelpi.prompts')];
        const chosen = await chooseSlot('interaction.palette', paletteView) && await chooseSlot('interaction.prompts', promptsView);
        const statuses = `${await statusRow('interaction.palette')} | ${await statusRow('interaction.prompts')}`;
        await closeSettings();
        const bothAttached = await attached(paletteView) && await attached(promptsView);
        const bothReady = await ready(paletteFrame) && await ready(promptsFrame);
        rec.check('Settings offers both interaction placements and selects the lab for each',
            offered && chosen && bothAttached,
            `palette options ${JSON.stringify(paletteChoices)}, prompt options ${JSON.stringify(promptChoices)}, status ${statuses}`);
        rec.check('each interaction select names its bundled entry as the recovery floor',
            JSON.stringify(bundledLabels) === JSON.stringify(['Command palette (bundled)', 'Prompts and notifications (bundled)']),
            JSON.stringify(bundledLabels));
        rec.check('both presenters attach as isolated views and report they have painted',
            bothReady && await isolated(paletteFrame) && await isolated(promptsFrame),
            `palette ${await labState(paletteFrame)} · prompts ${await labState(promptsFrame)}`);
        const projections = [await labSnapshot(paletteFrame), await labSnapshot(promptsFrame)];
        rec.check('each placement receives only its own half of the surface',
            projections[0]?.placement === 'interaction.palette' && projections[0]?.prompt === null && projections[0]?.queued === 0
            && projections[1]?.placement === 'interaction.prompts' && projections[1]?.palette === null
            && projections[0]?.formFactor === 'desktop' && projections[1]?.notifications?.length === 0,
            JSON.stringify(projections));

        // ── 2 · discoverable, never programmatically selectable ──────────────────────
        const slots = JSON.parse(await inFrame(uiFrame, `(async () => { const workbench = await kelpi.ui.getWorkbench(); return JSON.stringify(workbench.slots.filter(slot => slot.id.startsWith('interaction.'))); })()`));
        const refusals = [
            await inFrame(uiFrame, `kelpi.ui.selectView('interaction.prompts', ${JSON.stringify(promptsView)}).then(() => 'resolved', error => error.message)`),
            await inFrame(uiFrame, `kelpi.ui.selectView('interaction.palette', ${JSON.stringify(paletteView)}).then(() => 'resolved', error => error.message)`)
        ];
        rec.check('a plugin discovers both interaction slots but ui.selectView refuses them',
            refusals.every(message => message === 'Workbench slot is not registered.')
            && slots.find(slot => slot.id === 'interaction.palette')?.viewID === paletteView
            && slots.find(slot => slot.id === 'interaction.prompts')?.viewID === promptsView,
            `${JSON.stringify(slots)} · ${JSON.stringify(refusals)}`);

        // ── 3 · the palette, drawn by the plugin ─────────────────────────────────────
        if (!await openPaletteOn(shellPane, pluginPaletteOpen)
            || !await frameCheck(paletteFrame, `document.querySelectorAll('[data-testid="lab-palette-row"]').length > 0`)) {
            throw new Error(`the plugin palette drew no rows: ${await labState(paletteFrame)}`);
        }
        const rows = JSON.parse(await inFrame(paletteFrame, `JSON.stringify([...document.querySelectorAll('[data-testid="lab-palette-row"]')].map(row => row.getAttribute('data-item-id')))`));
        rec.check('⌘P opens the plugin palette with the window session’s own rows',
            rows.includes(`ws:${workspaceID}`) && rows.includes(`pane:${shellPane}`) && rows.includes('cmd:new-scratchpad')
            && await painted(paletteView) && await page.eval(`!document.querySelector('${bundledPalette}')`),
            `${rows.length} rows: ${JSON.stringify(rows.slice(0, 8))}`);
        await shot('plugin-palette-open', 'the palette card is the LAB’s: its own rows over the pane grid, with the title bar and the status footer still live behind it, and no bundled palette underneath.');
        await typeInFrame(paletteFrame, '[data-testid="lab-palette-input"]', 'New Scratchpad');
        const filtered = await frameCheck(paletteFrame, `document.querySelector('[data-testid="lab-palette-input"]').value === 'New Scratchpad' && document.querySelectorAll('[data-testid="lab-palette-row"]').length === 1 && document.querySelector('[data-testid="lab-palette-row"]').getAttribute('data-item-id') === 'cmd:new-scratchpad'`);
        rec.check('typing reaches the iframe and filters the session inside it', filtered, await labState(paletteFrame));
        const before = await panes();
        await page.key('Enter');
        const grew = await d.settle(async () => (await panes()).length === before.length + 1, { ceilingMs: 8_000 });
        await sleep(700);
        const after = await panes();
        rec.check('Enter on a command row runs it through the host exactly once',
            grew && after.length === before.length + 1
            && after.filter(pane => pane.type === 'scratchpad').length === 1
            && await standingBy(paletteView),
            `${before.length} → ${after.length} panes, ${after.filter(pane => pane.type === 'scratchpad').length} scratchpads`);

        await toggle('enabled', false);
        if (!await openPaletteOn(shellPane, pluginPaletteOpen)
            || !await frameCheck(paletteFrame, `document.querySelectorAll('[data-testid="lab-palette-row"]').length > 0`)) throw new Error('the plugin palette did not reopen');
        await typeInFrame(paletteFrame, '[data-testid="lab-palette-input"]', 'UI Lab: Increment');
        const disabledRow = JSON.parse(await inFrame(paletteFrame, `JSON.stringify((globalThis.interactionLab?.snapshot?.palette?.items ?? []).find(item => item.id === 'example.ui-lab.menu-palette') ?? null)`));
        const countBefore = (await uiSnapshot()).state.context.count;
        await page.key('Enter');
        await sleep(800);
        rec.check('a disabled row does not execute and leaves the session open',
            disabledRow?.disabled === true && (await uiSnapshot()).state.context.count === countBefore && await painted(paletteView),
            `row ${JSON.stringify(disabledRow)}, count ${String(countBefore)} → ${String((await uiSnapshot()).state.context.count)}`);
        await page.key('Escape');
        const escaped = await standingBy(paletteView) && await caretIn(shellPane);
        rec.check('Escape relayed out of the presenter dismisses the session and hands the caret to the pane',
            escaped, `caret in ${String(await page.eval(CARET_PANE)) || '<none>'}, want ${shellPane}; activeElement ${String(await page.eval(CARET_HTML))}`);
        await toggle('enabled', true);
        if (!await openPaletteOn(shellPane, pluginPaletteOpen)) throw new Error('the plugin palette did not reopen for the close chord');
        const panesBeforeChord = (await panes()).length;
        await closeChord();
        const chordDismissed = await standingBy(paletteView) && await caretIn(shellPane);
        rec.check('the relayed Close chord dismisses the palette without closing a pane',
            chordDismissed && (await panes()).length === panesBeforeChord,
            `panes ${String(panesBeforeChord)} → ${String((await panes()).length)}, caret in ${String(await page.eval(CARET_PANE)) || '<none>'}`);

        // ── 4 · another plugin's prompts, drawn by the lab ───────────────────────────
        await askUILab('pick');
        if (!await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt"]')`)) {
            throw new Error(`the quick pick did not reach the prompts presenter: ${await labState(promptsFrame)}`);
        }
        const prompt = (await labSnapshot(promptsFrame))?.prompt;
        const leaks = await inFrame(promptsFrame, `(() => {
            const html = document.documentElement.outerHTML;
            const snapshot = JSON.stringify(globalThis.interactionLab?.snapshot ?? null);
            return html.includes(${JSON.stringify(uiID)}) || snapshot.includes(${JSON.stringify(uiID)});
        })()`);
        rec.check('a plugin prompt reaches the presenter with a display name and no plugin id anywhere',
            prompt?.kind === 'quickPick' && prompt.owner?.displayName === 'UI Lab'
            && JSON.stringify(Object.keys(prompt.owner).sort()) === JSON.stringify(['displayName', 'ref'])
            && leaks === false && await page.eval(`!document.querySelector('${modal}')`),
            `prompt ${JSON.stringify(prompt)}, plugin id in frame: ${String(leaks)}`);
        await shot('plugin-prompt-dialog', 'the quick pick is drawn by the LAB’s prompts view: it shows the owner as "UI Lab" (never example.ui-lab), and no bundled dialog is behind it.');
        await clickFrame(promptsFrame, '[data-testid="lab-prompt-item"][data-item-id="green"]');
        rec.check('answering in the presenter returns the chosen id to the requesting plugin', await output('pick', 'green'));
        await askUILab('input');
        await typeInFrame(promptsFrame, '[data-testid="lab-prompt-input"]', 'Presented label');
        await page.key('Enter');
        rec.check('an input answered in the presenter returns its typed text', await output('input', 'Presented label'), await labState(promptsFrame));
        await askUILab('input');
        if (!await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt-input"]')`)) throw new Error('the second input did not reach the presenter');
        await page.key('Escape');
        rec.check('Escape cancels a presented request with null', await output('input', null));
        await askUILab('dialog');
        if (!await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt-action"][data-action-id="confirm"]')`)) throw new Error('the dialog did not reach the presenter');
        await clickFrame(promptsFrame, '[data-testid="lab-prompt-action"][data-action-id="confirm"]');
        rec.check('a dialog action answered in the presenter returns its action id', await output('dialog', 'confirm'));
        await askUILab('dialog');
        if (!await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt-action"]')`)) throw new Error('the dialog did not reopen');
        const panesBeforePrompt = (await panes()).length;
        await closeChord();
        rec.check('the Close chord cancels a presented request with null and preserves every pane',
            await output('dialog', null) && (await panes()).length === panesBeforePrompt);
        await askUILab('pick');
        if (!await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt-item"]')`)) throw new Error('the quick pick did not reopen');
        await page.key('KeyD', { modifiers: 4, key: 'd', keyCode: 68 });
        await page.key('Comma', { modifiers: 4, key: ',' });
        await sleep(600);
        rec.check('native split and Settings chords change nothing while a presented request is up',
            (await panes()).length === panesBeforePrompt && await page.eval(`!document.querySelector('[data-testid="settings-close"]')`)
            && await painted(promptsView) && (await labSnapshot(promptsFrame))?.prompt?.kind === 'quickPick',
            `panes ${String(panesBeforePrompt)} → ${String((await panes()).length)}`);
        await page.key('Escape');
        if (!await output('pick', null)) throw new Error('the quick pick did not cancel');
        await raise(`void kelpi.ui.showInput({title:'First queued'}).then(value => { document.body.dataset.firstQueued = JSON.stringify(value); }); true`);
        await raise(`void kelpi.ui.showInput({title:'Second queued'}).then(value => { document.body.dataset.secondQueued = JSON.stringify(value); }); true`);
        const queued = await d.settle(async () => {
            const snapshot = await labSnapshot(promptsFrame);
            return snapshot?.prompt?.options?.title === 'First queued' && snapshot.queued === 1;
        }, { ceilingMs: 8_000 });
        await page.key('Escape');
        const promoted = await d.settle(async () => {
            const snapshot = await labSnapshot(promptsFrame);
            return snapshot?.prompt?.options?.title === 'Second queued' && snapshot.queued === 0;
        }, { ceilingMs: 8_000 });
        rec.check('a second request waits behind the visible one and is counted as queued',
            queued && promoted && await datasetValue('firstQueued') === 'null',
            await labState(promptsFrame));
        await page.key('Escape');
        if (!await dataset('secondQueued')) throw new Error('the promoted request did not cancel');
        await openPlugins();
        await raise(`void kelpi.ui.showInput({title:'Behind Settings'}).then(value => { document.body.dataset.behindSettings = JSON.stringify(value); }); true`);
        const waiting = await d.settle(async () => {
            const snapshot = await labSnapshot(promptsFrame);
            return snapshot?.visible === false && snapshot.prompt?.options?.title === 'Behind Settings';
        }, { ceilingMs: 8_000 });
        const parked = waiting && await standingBy(promptsView) && await page.eval(`!!document.querySelector('[data-testid="settings-close"]')`);
        await closeSettings();
        const revealed = await painted(promptsView) && await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt"]') !== null`);
        rec.check('a request raised while Settings is open is withheld from the presenter until Settings closes',
            parked && revealed, await labState(promptsFrame));
        await page.key('Escape');
        if (!await dataset('behindSettings')) throw new Error('the parked request did not cancel');

        // ── 5 · the two carve-outs stay bundled ──────────────────────────────────────
        await raise(`void kelpi.ui.showInput({title:'Deploy token', password:true}).then(value => { document.body.dataset.secret = JSON.stringify(value); }); true`);
        const bundledPassword = await d.settleDom(page, `document.querySelector('${bundledPrompts} ${modal} input[aria-label="Deploy token"][type="password"]')`);
        const withheld = await d.settle(async () => {
            const snapshot = await labSnapshot(promptsFrame);
            return snapshot?.prompt === null && snapshot.queued === 1;
        }, { ceilingMs: 6_000 });
        rec.check('a password input is drawn by the bundled presenter and withheld from the plugin one',
            bundledPassword && withheld && await standingBy(promptsView) && await attached(promptsView),
            await labState(promptsFrame));
        await answerBundled('Deploy token', 'hunter2');
        rec.check('the withheld password request still settles to its requesting plugin',
            await frameCheck(uiFrame, `document.body.dataset.secret === ${JSON.stringify(JSON.stringify('hunter2'))}`),
            String(await datasetValue('secret')));
        await askUILab('notification');
        const bundledNotice = await d.settleDom(page, `document.querySelector('${notice}')`);
        const noticeWithheld = (await labSnapshot(promptsFrame))?.notifications?.length === 0;
        /*
         * The action button by what it IS, not by its position in the card, and aim-checked: the
         * native toast stack shares this corner of the window and is no longer something anything
         * stands down for, so a blind `page.click` here can press a toast instead.
         */
        await clickHost(`${notice} button:not([aria-label="Dismiss notification"])`);
        rec.check('a notification is drawn by the bundled stack and never projected to the presenter',
            bundledNotice && noticeWithheld && await output('notification', 'ack'));

        // ── 6 · failure, and the way back ────────────────────────────────────────────
        await askUILab('input');
        if (!await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt-input"]')`)) throw new Error('the input did not reach the presenter before the crash');
        const liveID = (await labSnapshot(promptsFrame))?.prompt?.requestID ?? null;
        await arm(promptsFrame, `crash('uncaught')`);
        // Nothing is delivered to a presenter that is already drawn, so a second request is raised
        // to produce the frame the crash rides in on. It queues behind the live input, which is
        // what makes this a failure with a request in flight rather than between two of them.
        await raise(`void kelpi.ui.showInput({title:'Raised into the crash'}).then(value => { document.body.dataset.afterCrash = JSON.stringify(value); }); true`);
        // Concurrently: the failure toast lives for ERROR_TOAST_MS (6 s), so it must not be waited
        // for behind a takeover that is allowed ten.
        const [tookOver, toast] = await Promise.all([
            d.settleDom(page, liveID === null
                ? `document.querySelector('${bundledPrompts} ${modal}')?.textContent.includes('UI Lab: enter a label')`
                : `document.querySelector('${bundledPrompts} ${modal}[data-request-id=${JSON.stringify(String(liveID))}]')`, { ceilingMs: 10_000 }),
            d.settleDom(page, `(document.querySelector('[data-testid="toast-stack"]')?.textContent ?? '').includes('Interaction presenter')`, { ceilingMs: 10_000 })
        ]);
        /*
         * The picture is the claim, so it waits for the dialog to have a BOX rather than for the
         * element to exist: "the bundled presenter takes over" is only true once the thing is
         * painted, and before the toast stopped owning the window this shot caught a bare grid.
         */
        const paintedOver = liveID !== null && await d.settleDom(page,
            `document.querySelector('${bundledPrompts} ${modal}[data-request-id=${JSON.stringify(String(liveID))}]')?.getBoundingClientRect().width > 0`, { ceilingMs: 10_000 });
        await shot('bundled-dialog-after-failure', 'the SAME request, now drawn by the bundled dialog - owner "UI Lab", title "UI Lab: enter a label", Cancel and Continue - with UI Lab behind it still reading "Waiting…", and the failure toast ("Interaction presenter · Uncaught Error: Interaction Lab crashed on purpose") in the bottom-right corner beside it, not instead of it. The toast registers its own rect rather than the window, so the dialog paints immediately; the note below is that measurement.');
        rec.check('a presenter crash re-presents the live request under its own id in the bundled dialog',
            tookOver && toast && liveID !== null && paintedOver && await drawsBundled(bundledPrompts),
            `request ${liveID === null ? 'id unreadable from the presenter before the crash' : String(liveID)}, painted ${String(paintedOver)}`);
        rec.note(`the bundled dialog became clickable ${String(await answerBundled('UI Lab: enter a label', 'Answered after the crash'))} ms after the crash`);
        rec.check('a failure never settles the request: the bundled answer still reaches its plugin',
            await output('input', 'Answered after the crash'));
        if (!await d.settleDom(page, `document.querySelector('${modal}')?.textContent.includes('Raised into the crash')`, { ceilingMs: 8_000 })) {
            throw new Error('the request queued behind the crash was not promoted by the bundled presenter');
        }
        await page.key('Escape');
        if (!await dataset('afterCrash')) throw new Error('the promoted request did not cancel');
        await openPlugins();
        const failedStatus = await d.settle(async () => (await statusRow('interaction.prompts')).includes('Failed'), { ceilingMs: 6_000 });
        // The presenter rows are the last thing in a long scrolling tab, so the picture is worth
        // nothing without this: Settings opens at the install field.
        await page.eval(`document.querySelector('[data-testid="interaction-presenter-status-interaction.prompts"]')?.scrollIntoView({block:'center'})`);
        await page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        await shot('settings-presenter-status', 'Settings ▸ Plugins ▸ Workbench views, scrolled to the presenter rows: the interaction.prompts row reads "Failed: …" with a "Retry presenter" button beside it, the interaction.palette row still names the lab, and both interaction selects above them still hold the lab views.');
        rec.check('Settings reports the failed presenter beside its retained selection',
            failedStatus && await slotValue('interaction.prompts') === promptsView,
            `${await statusRow('interaction.prompts')} · selected ${String(await slotValue('interaction.prompts'))}`);
        await retry('interaction.prompts');
        const clearedStatus = await d.settle(async () => !(await statusRow('interaction.prompts')).includes('Failed'), { ceilingMs: 6_000 });
        await closeSettings();
        const retried = await attached(promptsView, 12_000) && await ready(promptsFrame);
        const afterRetry = `cleared ${String(clearedStatus)} · presenters ${String(await page.eval(`JSON.stringify([...document.querySelectorAll('[data-interaction-presenter]')].map(node => node.getAttribute('data-interaction-presenter')))`))} · plugin ${JSON.stringify((await json(['plugin', 'list', '--json'])).filter(plugin => plugin.manifest.id === labID).map(plugin => ({ enabled: plugin.enabled, status: plugin.status, revision: plugin.revision })))}`;
        await askUILab('pick');
        const presentsAgain = await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt-item"]')`);
        await page.key('Escape');
        rec.check('Retry presenter re-attaches the view and it presents the next request',
            retried && presentsAgain && await output('pick', null), afterRetry);

        await arm(promptsFrame, 'stall()');
        await raise(`void kelpi.ui.showInput({title:'Stalled presenter'}).then(value => { document.body.dataset.stalled = JSON.stringify(value); }); true`);
        let stalledID = null;
        for (let attempt = 0; attempt < 20 && stalledID === null; attempt += 1) {
            try { stalledID = (await labSnapshot(promptsFrame))?.prompt?.requestID ?? null; } catch { /* the frame is stalled, not gone */ }
            if (stalledID === null) await sleep(150);
        }
        // The same id the presenter last saw, exactly as the crash arm requires it: a takeover
        // matched on a title alone would not prove the request survived rather than being re-raised.
        const watchdog = stalledID !== null && await d.settleDom(page,
            `document.querySelector('${bundledPrompts} ${modal}[data-request-id=${JSON.stringify(String(stalledID))}]')`, { ceilingMs: 15_000 });
        rec.note(`the bundled dialog became clickable ${String(await answerBundled('Stalled presenter', 'after the stall'))} ms after the stall watchdog fired`);
        const answered = await frameCheck(uiFrame, `document.body.dataset.stalled === ${JSON.stringify(JSON.stringify('after the stall'))}`);
        /*
         * Which watchdog fired, in the host's own words. `presenter-slot.tsx` fails a missed
         * readiness with "did not report that it had painted" and a missed acknowledgement with
         * "stopped acknowledging window updates", and only the second one is what this arm claims.
         */
        await openPlugins();
        const ackStatus = await d.settle(async () => (await statusRow('interaction.prompts')).includes('stopped acknowledging'), { ceilingMs: 6_000 });
        const ackRow = await statusRow('interaction.prompts');
        await closeSettings();
        rec.check('the acknowledgement watchdog fails a stalled presenter and the bundled one keeps the request',
            stalledID !== null && watchdog && answered && ackStatus,
            `request ${stalledID === null ? 'id unreadable while stalled' : String(stalledID)} · ${ackRow}`);

        // ── 7 · disable, enable, reload ──────────────────────────────────────────────
        await cli.ok(['plugin', 'disable', labID]);
        const gone = await d.settleDom(page, `!document.querySelector('${paletteSlot}') && !document.querySelector('${promptsSlot}')`);
        const bundledRows = await openPaletteOn(shellPane, bundledPaletteOpen);
        await page.key('Escape');
        await raise(`void kelpi.ui.showInput({title:'Bundled while disabled'}).then(value => { document.body.dataset.disabled = JSON.stringify(value); }); true`);
        const bundledDialog = await d.settleDom(page, `document.querySelector('${bundledPrompts} ${modal}')?.textContent.includes('Bundled while disabled')`);
        await page.key('Escape');
        rec.check('disabling the plugin puts both surfaces back on the bundled presenters',
            gone && bundledRows && bundledDialog && await drawsBundled(bundledPrompts));
        await openPlugins();
        const statusWhileDisabled = `${await statusRow('interaction.palette')} | ${await statusRow('interaction.prompts')}`;
        await closeSettings();
        await cli.ok(['plugin', 'enable', labID]);
        const back = await attached(paletteView) && await attached(promptsView) && await ready(paletteFrame) && await ready(promptsFrame);
        await openPlugins();
        const retained = await slotValue('interaction.palette') === paletteView && await slotValue('interaction.prompts') === promptsView;
        await closeSettings();
        rec.check('the selection is retained across disable and enable, and both presenters come back',
            back && retained, `while disabled: ${statusWhileDisabled}`);
        await cli.ok(['plugin', 'reload', labID]);
        const reloaded = await attached(promptsView, 20_000) && await ready(promptsFrame) && await ready(paletteFrame);
        await askUILab('pick');
        const presentsAfterReload = await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt-item"]')`);
        await page.key('Escape');
        rec.check('a plugin reload returns working presenters to both placements',
            reloaded && presentsAfterReload && await output('pick', null), await labState(promptsFrame));
        rec.note('LIMIT: the daemon-disconnect arm of the fallback is not pressed here; the runner hands a scenario no primary-daemon handle. See the header.');

        // ── 8 · a palette presenter that dies with the palette open ──────────────────
        if (!await openPaletteOn(shellPane, pluginPaletteOpen)) throw new Error('the plugin palette did not open before the crash');
        await arm(paletteFrame, `crash('uncaught')`);
        // The same rule as the prompts arm: the crash lands on the next frame, and a keystroke that
        // moves the host-owned query is the cheapest way to produce one over a live session.
        await typeInFrame(paletteFrame, '[data-testid="lab-palette-input"]', 'crash');
        const sessionGone = await d.settleDom(page, `!document.querySelector('[data-testid="command-palette"]') && document.querySelector('${bundledPalette}')`, { ceilingMs: 10_000 });
        const paneCount = (await panes()).length;
        const bundledNext = await openPaletteOn(shellPane, bundledPaletteOpen);
        await page.key('Escape');
        rec.check('a palette presenter crash dismisses the session and the next ⌘P draws the bundled palette',
            sessionGone && bundledNext && (await panes()).length === paneCount,
            `panes ${String(paneCount)} → ${String((await panes()).length)}`);
        await openPlugins();
        await retry('interaction.palette');
        await closeSettings();
        if (!(await attached(paletteView) && await ready(paletteFrame))) throw new Error('Retry did not bring the palette presenter back');

        // ── 9 · the phone keeps the bundled presenters ───────────────────────────────
        /*
         * The two failure toasts from checks 6 and 8 have to be gone before the window is narrowed:
         * at 390 px the corner stack is most of the width and it sits over the phone's pane rows,
         * so a tap aimed at one lands on the toast's text instead.
         */
        if (!await toastsGone()) rec.note('the toast stack did not empty before the phone section; a tap below may report being covered by it');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${workspaceID}"]`;
        if (await d.settleDom(page, `document.querySelector(${JSON.stringify(phoneRow)})`, { ceilingMs: 10_000 })) await clickHost(phoneRow);
        await openPalette();
        const phonePalette = await d.settleDom(page, `document.querySelector('${bundledPalette} [data-testid="command-palette"]')`, { ceilingMs: 8_000 });
        /*
         * The CLOSE chord, not Escape. The bundled card answers Escape from a capture handler on
         * its own panel, so it needs the caret, and on the phone sheet the field does not take it
         * (there is no hardware Escape on a phone, so nothing user-facing rides on that); ⌘W is the
         * one chord the dispatcher keeps for a modal overlay. The wait is for the 150 ms exit: the
         * sheet is the whole screen, so clicking the shell under it too early lands on a row.
         */
        await closeChord();
        if (!await d.settleDom(page, `!document.querySelector('[data-testid="command-palette"]')`, { ceilingMs: 8_000 })) {
            throw new Error('the phone palette did not dismiss on the close chord');
        }
        let phonePrompt = null;
        // The pane list is two taps in from the landing view, and each one re-lays-out the shell,
        // so both go through the aim-checked click rather than a rect measured a frame too early.
        if (await d.settleDom(page, `document.querySelector('[data-testid="phone-title"]')`, { ceilingMs: 10_000 })) {
            await clickHost('[data-testid="phone-title"]');
            if (await d.settleDom(page, `document.querySelector('[data-testid="phone-pane-show-${uiPane.paneID}"]')`, { ceilingMs: 10_000 })) {
                await clickHost(`[data-testid="phone-pane-show-${uiPane.paneID}"]`);
                if (await uiReady()) {
                    await raise(`void kelpi.ui.showInput({title:'Phone bundled prompt'}).then(value => { document.body.dataset.phone = JSON.stringify(value); }); true`);
                    phonePrompt = await d.settleDom(page, `document.querySelector('${bundledPrompts} ${modal}')?.textContent.includes('Phone bundled prompt')`, { ceilingMs: 8_000 });
                    await page.key('Escape');
                }
            }
        }
        if (phonePrompt === null) rec.note('SKIPPED: the phone prompt half - the phone shell never showed the UI Lab pane, so no request could be raised there.');
        rec.check('a phone window keeps both bundled presenters with the lab still selected',
            phonePalette && (phonePrompt === null || phonePrompt) && await page.eval(`!document.querySelector('${paletteSlot}') && !document.querySelector('${promptsSlot}')`),
            `palette ${String(phonePalette)}, prompt ${String(phonePrompt)}`);
        // Back to the landing page BEFORE the window widens again, while the shell is still mounted:
        // it is the one tap that forgets where this scenario took the phone.
        if (!await phoneToLanding()) rec.note('the phone shell did not return to its landing page; the next phone scenario may open where this one left it');
        await page.send('Emulation.clearDeviceMetricsOverride');
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        rec.check('returning to the desktop form factor re-attaches both plugin presenters',
            await attached(paletteView) && await attached(promptsView) && await ready(paletteFrame) && await ready(promptsFrame),
            `palette ${await labState(paletteFrame)} · prompts ${await labState(promptsFrame)}`);
        await shot('interaction-lab-ready', 'the ordinary window: both presenters selected and idle, the grid drawn normally, no dialog and no palette on screen.');
    } catch (error) {
        await rec.shot(page, 'failure-live');
        throw error;
    } finally {
        /*
         * The sandbox, its daemon AND its window are shared with every scenario that runs after this
         * one, and four things outlive the workspace this deletes: the phone's remembered place, the
         * saved presenter selections, whatever overlay was on screen when a check threw, and which
         * workspace the window is looking at. `plugin-remote` failed on the first of those in a pair
         * run - its phone host picker never drew, because the phone opened where this scenario had
         * left it instead of on the landing page - so each step is taken and none is allowed to
         * skip the rest.
         */
        const safely = async (what, step) => {
            try { await step(); } catch (error) { rec.note(`cleanup: ${what} — ${error instanceof Error ? error.message : String(error)}`); }
        };
        await safely('the phone returns to its landing page', async () => { if (!await phoneToLanding()) rec.note('cleanup: the phone shell never reached its landing page'); });
        await safely('device metrics are cleared', () => page.send('Emulation.clearDeviceMetricsOverride'));
        await safely('touch emulation is cleared', () => page.send('Emulation.setTouchEmulationEnabled', { enabled: false }));
        // A prompt or a palette left up by a thrown check owns the window: every chord below would
        // stand down behind it, including the ⌘, that opens Settings.
        await safely('any request or session still up is dismissed', async () => {
            for (let attempt = 0; attempt < 4; attempt += 1) {
                if (!await page.eval(`!!document.querySelector('[data-testid="plugin-ui-backdrop"]:not([hidden])') || !!document.querySelector('[data-testid="command-palette"]')`)) return;
                await closeChord();
                await sleep(250);
            }
        });
        await safely('the Settings overlay is closed', async () => {
            if (await page.eval(`!!document.querySelector('[data-testid="settings-close"]')`)) await closeSettings();
        });
        /*
         * The selections go back to the BUNDLED views rather than being left naming views that are
         * about to be removed. Both entries are the ones check 1 read the "(bundled)" label off, so
         * this also leaves the window on the recovery floor the next scenario expects.
         */
        await safely('both interaction placements go back to bundled', async () => {
            await openPlugins();
            await chooseSlot('interaction.palette', 'kelpi.palette');
            await chooseSlot('interaction.prompts', 'kelpi.prompts');
            await closeSettings();
        });
        await cli.run(['plugin', 'remove', labID]);
        await cli.run(['plugin', 'remove', uiID]);
        await cli.run(['workspace', 'delete', workspaceID, '--force']);
        await safely('the window returns to the workspace it started on', async () => {
            if (startingWorkspace === null) return;
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await clickHost(row);
        });
    }
}

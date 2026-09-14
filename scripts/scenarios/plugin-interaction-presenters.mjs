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
 *  10. the PRIMARY daemon stopped and replaced under a live palette session and a queued prompt:
 *      bundled while the connection is down, no latch, both presenters back, the queued promise
 *      settled and never answered late, nothing activated, the caret usable, nothing run twice;
 *  11. six screenshots for the eyes, each with a note saying what to look for.
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
 * ── Limits, on the record ───────────────────────────────────────────────────────────
 *
 *   - **The disconnected window is not covered on the PHONE.** Presenters are disabled outright on
 *     a phone (recovery floor rule 1, which check 9 reads), so the bundled palette and prompts are
 *     already the pair drawing there and losing the connection cannot change which presenter draws.
 *     Rule 3 has nothing left to do that rule 1 has not already done, so check 10 stays on the
 *     desktop window.
 *   - **A queued prompt's promise cannot be watched resolving inside the frame that raised it.**
 *     `PluginView`'s main effect depends on the connection, so a disconnect disposes the view's UI
 *     scope AND clears its document: the frame's `pagehide` fires about 30 ms into the restart,
 *     before any cancellation could be drawn in it, and the rebuilt panel is a fresh document. So
 *     "the promise settled with null exactly once" is not assertable from here at all, and check
 *     10 does not pretend otherwise: it asserts what the HOST can answer (no prompt on the
 *     surface, nothing queued behind it, no dialog drawn under any id, and a prompt raised after
 *     the reconnect that settles with its action) and records the frame's own readings as an
 *     observation in the detail.
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
    'packages/client/src/App.tsx', 'packages/client/src/chrome/', 'packages/client/src/phone/', 'packages/client/src/settings/',
    // Check 10 is a real disconnect and reconnect of the primary daemon, so the socket's status
    // machine and its backoff are things this scenario would now catch a regression in.
    'packages/client/src/connection/'];

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

export default async function ({ page, cli, rec, d, sleep, daemon }) {
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

        // ── 10 · the primary daemon goes away and comes back ─────────────────────────
        /*
         * Rule 3 of the recovery floor, at last pressed for real (#199). `presenter-slot.tsx` draws
         * bundled while the daemon connection is down, and the only honest way to reach that state
         * is to stop the PRIMARY daemon under a live window: `plugin-remote.mjs`'s scaffolding buys
         * a SECOND daemon, which is not the runtime a presenter is selected for (window UI is the
         * primary runtime's, `docs/plugin-ui.md` ▸ Shared prompts). `t.daemon.restart()` is the
         * runner's handle for it, and the restart is IN PLACE - same run dir, ports, database and
         * token - so the window loses its connection and finds THE SAME daemon again, which is what
         * makes the reconnect the behaviour under test rather than a new address.
         *
         * Three measurements decide how this arm is written, all taken on this tree:
         *
         *  1. **The gap can be half a second.** With a daemon that answers SIGTERM, healthz is back
         *     ~170 ms after the restart begins and `data-connection` ~450 ms in; when the daemon
         *     misses that eight-second window (four of six runs of this scenario, and none of
         *     `plugin-settings-presenter`'s: `stack.mjs` ▸ `restartableDaemon` has the reading) the
         *     window is down for about fifteen seconds instead. A poll sized for the slow case
         *     misses the fast one completely and reports that the client never noticed, so the
         *     disconnected state is OBSERVED instead: a MutationObserver installed before the
         *     restart records every change to the connection, to which presenter is mounted and to
         *     the toast stack.
         *  2. **A plugin view's iframe is destroyed and rebuilt.** `PluginView`'s main effect
         *     depends on the connection, so its cleanup disposes the view's UI scope and its body
         *     is cleared; the frame's `pagehide` fires ~30 ms into the restart, which is BEFORE any
         *     cancellation could be drawn in it. So the queued prompt's promise cannot be observed
         *     resolving inside the frame that raised it, and nothing read out of that frame
         *     afterwards can fail. This arm asserts only what the host can answer: no prompt on
         *     the surface, nothing queued, no dialog under any id, and a fresh prompt after the
         *     reconnect that is presented and settles with its action.
         *  3. **Every PTY dies with the old daemon.** The shell pane comes back with a new process
         *     and an empty scrollback, so the marker run before the restart must read EXACTLY zero
         *     afterwards rather than "no more than one": one is what a replay of buffered
         *     pre-restart input into the new shell would produce, which is the regression this
         *     reading exists to catch.
         *
         * The phone is deliberately not covered here: presenters are disabled outright on a phone
         * (rule 1, checked in 9), so the bundled palette and prompts are already the ones drawing
         * and a disconnect cannot change which presenter draws. There is nothing for rule 3 to do
         * there that rule 1 has not already done.
         */
        if (daemon === null) {
            rec.note('SKIPPED: the daemon-disconnect arm - this run attached to an instance it did not start, and `t.daemon` is null there because stopping somebody else’s daemon would take their session down.');
        } else {
            const MARKER = 'MARK', markerBefore = `${MARKER}-BEFORE`, markerAfter = `${MARKER}-AFTER`;
            const count = (text, needle) => text.split(needle).length - 1;
            const capture = () => cli.ok(['pane', 'capture', '--target', shellPane, '--scrollback']);
            const paneIDs = async () => (await panes()).map(pane => String(pane.id)).sort().join(',');
            /**
             * Record every change to the connection, to who is drawing and to the toast stack.
             *
             * A MutationObserver rather than a poll, for measurement 1 above: the window can be
             * disconnected for as little as half a second and the attribute changes are what this
             * is about, so the DOM's own notification is both cheaper and complete. The 100 ms
             * timer beside it is the backstop for a state that arrives with no mutation under it.
             */
            const trail = `(() => {
                const samples = [];
                const read = () => JSON.stringify({
                    connection: document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') ?? null,
                    presenters: [...document.querySelectorAll('[data-interaction-presenter]')].map(node => node.getAttribute('data-interaction-presenter')),
                    palette: document.querySelector('[data-testid="command-palette"]') !== null,
                    dialog: document.querySelector('${modal}')?.getAttribute('data-request-id') ?? null,
                    toast: (document.querySelector('[data-testid="toast-stack"]')?.textContent ?? '').slice(0, 120)
                });
                let last = '';
                const sample = () => { const now = read(); if (now === last) return; last = now; samples.push({ at: Date.now(), ...JSON.parse(now) }); };
                sample();
                const observer = new MutationObserver(sample);
                observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-connection', 'data-interaction-presenter', 'data-request-id', 'hidden'] });
                const timer = setInterval(sample, 100);
                globalThis.__daemonTrailStop = () => { observer.disconnect(); clearInterval(timer); sample(); return JSON.stringify(samples); };
                return true;
            })()`;

            // A marker whose OUTPUT differs from the line that produced it: the echoed command
            // carries `MARK-%s`, so every `MARK-BEFORE` in the capture is one execution.
            await d.focusPaneBody(page, shellPane);
            await d.runInTerminal(page, `printf '${MARKER}-%s\\n' BEFORE`, { settleMs: 1_200 });
            const markedBefore = await capture();
            const panesBeforeRestart = await paneIDs();

            if (!await openPaletteOn(shellPane, pluginPaletteOpen)) throw new Error('the plugin palette did not open before the restart');
            /*
             * The prompt is QUEUED rather than presented, and that is the point: the palette
             * session holds the window's modal presence, so the surface delivers the request to
             * the prompts presenter with `visible: false` and the wrapper stands down. A promise
             * nobody can even see is the worst thing to lose in a disconnect, so that is the one
             * this arm loses. Raised by evaluation rather than by pressing UI Lab's own button,
             * because the palette presenter is an overlay over the whole content row and a click
             * aimed at the pane under it lands on the overlay.
             */
            await raise(`void kelpi.ui.showDialog({ title: 'Across the restart', message: 'Queued behind the palette session.', cancelID: 'cancel', actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'confirm', label: 'Confirm', kind: 'primary' }] }).then(value => { document.body.dataset.acrossRestart = JSON.stringify(value); }); true`);
            const queuedPrompt = await d.settle(async () => {
                const snapshot = await labSnapshot(promptsFrame);
                return snapshot?.prompt?.options?.title === 'Across the restart';
            }, { ceilingMs: 8_000 });
            const queuedState = await labSnapshot(promptsFrame);
            if (!queuedPrompt) throw new Error(`the dialog never reached the prompts presenter before the restart: ${await labState(promptsFrame)}`);

            await page.eval(trail);
            const pidBefore = daemon.pid, generationBefore = daemon.generation;
            // Where a slow stop went, in the daemon's own words: `boot/compose.ts` logs
            // "kelpid stopped" as the LAST thing it does, so its absence is the SIGKILL landing
            // inside the shutdown (#212) rather than a machine that was merely busy.
            const textBefore = daemon.text().length;
            const startedAt = Date.now();
            await daemon.restart();
            const loggedStop = daemon.text().slice(textBefore).includes('kelpid stopped');
            const healthzMs = Date.now() - startedAt;
            const reconnected = await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 30_000 });
            const connectedMs = Date.now() - startedAt;
            // A dwell, on purpose: the claims below are about what does NOT arrive after the
            // reconnect (a stale answer, a late failure toast, a second execution), and a negative
            // read taken in the same tick as the reconnect proves nothing.
            await sleep(2_000);
            const samples = JSON.parse(String(await page.eval('globalThis.__daemonTrailStop()')));
            const offline = samples.filter(sample => sample.connection !== 'connected');
            rec.note(`the daemon was replaced in ${String(healthzMs)} ms (stop ${String(daemon.lastStopMs)} ms, start to healthz ${String(daemon.lastStartMs)} ms) and the window was back in ${String(connectedMs)} ms; ${String(samples.length)} recorded states, ${String(offline.length)} of them disconnected`);
            rec.note(loggedStop
                ? 'the replaced daemon logged its final "kelpid stopped" line, so it shut down cleanly'
                : 'the replaced daemon never logged "kelpid stopped": the SIGTERM window elapsed and the SIGKILL landed inside its shutdown, after persistence.flush() and pty.killAll() and before persistence.close() and clearRunFiles(). That is issue #212, not this handle.');
            for (const sample of samples) rec.note(`  +${String(sample.at - startedAt)} ms ${JSON.stringify({ connection: sample.connection, presenters: sample.presenters, palette: sample.palette, dialog: sample.dialog, toast: sample.toast })}`);
            rec.check('stopping the primary daemon disconnects the window, and the replacement reconnects it',
                reconnected && offline.length > 0 && samples.at(-1)?.connection === 'connected'
                && daemon.pid !== pidBefore && daemon.generation === generationBefore + 1,
                `pid ${String(pidBefore)} → ${String(daemon.pid)}, generation ${String(generationBefore)} → ${String(daemon.generation)}; connection states ${JSON.stringify([...new Set(samples.map(sample => sample.connection))])}`);

            const attachedAgain = await attached(paletteView, 20_000) && await attached(promptsView, 20_000);
            const readyAgain = attachedAgain && await ready(paletteFrame) && await ready(promptsFrame);
            rec.check('both presenters re-attach and report they have painted once the daemon is back',
                readyAgain, `palette ${await labState(paletteFrame)} · prompts ${await labState(promptsFrame)}`);

            /*
             * The palette session is the window's, not the daemon's, so losing the connection is
             * allowed to keep it or to drop it. What is NOT allowed is for the gap to run one of
             * its rows: a ⌘P session over a pane grid holds "create a scratchpad" under the caret,
             * and a surface that re-delivered its selection on reconnect would make the pane.
             */
            const sessionAfter = await painted(paletteView, 4_000);
            const panesAfterRestart = await paneIDs();
            rec.check('the palette session is either kept or dropped by the disconnect, and activates nothing',
                panesAfterRestart === panesBeforeRestart,
                `panes ${panesBeforeRestart === panesAfterRestart ? 'unchanged' : `${panesBeforeRestart} → ${panesAfterRestart}`}; the session was ${sessionAfter ? 'still up and drawn by the lab again' : 'dismissed'} afterwards, and the bundled palette drew it while the daemon was gone in ${String(offline.filter(sample => sample.palette).length)} of ${String(offline.length)} disconnected states`);
            if (sessionAfter) {
                await closeChord();
                if (!await standingBy(paletteView, 8_000)) rec.note('the palette session did not dismiss on the close chord after the restart');
            }

            await openPlugins();
            const statusesAfter = [await statusRow('interaction.palette'), await statusRow('interaction.prompts')];
            const selectionsAfter = [await slotValue('interaction.palette'), await slotValue('interaction.prompts')];
            await closeSettings();
            /*
             * The latch is what this check is really about. `generation` is
             * `viewID:revision:instanceID`, and a disconnect moves none of them, so a connection
             * that comes back must find the placement exactly as it left it: no failure recorded,
             * no Retry needed, the selection untouched. A toast anywhere in the trail would mean
             * the slot had FAILED the placement rather than stood it down.
             */
            rec.check('the slots fall back to bundled while the daemon is gone and never latch a failure',
                offline.every(sample => sample.presenters.every(name => name === 'bundled'))
                && offline.some(sample => sample.presenters.includes('bundled'))
                && samples.every(sample => sample.toast === '')
                && statusesAfter.every(status => !status.includes('Failed'))
                && JSON.stringify(selectionsAfter) === JSON.stringify([paletteView, promptsView]),
                `while disconnected the presenters were ${JSON.stringify([...new Set(offline.flatMap(sample => sample.presenters))])}; afterwards ${JSON.stringify(statusesAfter)} with ${JSON.stringify(selectionsAfter)} selected, and the toast stack stayed empty throughout`);

            /*
             * What is left of the request nobody could see.
             *
             * This check used to claim the promise "settled with null exactly once", and it could
             * not: the frame that raised it is torn down about 30 ms into the restart, so the
             * cancellation the disposal sends can never be drawn in it, and both of the readings
             * that were meant to prove it (a dataset key written by the frame, and the panel's
             * output field) live in the document that is destroyed. Two clauses that cannot fail
             * are worse than no clause, so the claim is now the one the HOST can answer: the
             * surface holds no prompt and nothing queued behind it, and no dialog is drawn under
             * any id. The frame readings stay in the detail as the observation they are.
             */
            const surfaceAfter = await labSnapshot(promptsFrame);
            const answerAfter = await datasetValue('acrossRestart');
            const dialogAfter = await page.eval(`document.querySelector('${modal}')?.getAttribute('data-request-id') ?? null`);
            const panelAfter = await inFrame(uiFrame, `document.getElementById('dialog-result')?.textContent ?? '<gone>'`);
            rec.check('the disconnect leaves no pending prompt on the surface and nothing drawn under its id',
                surfaceAfter?.prompt === null && surfaceAfter.queued === 0 && dialogAfter === null,
                `the request was ${String(queuedState?.prompt?.requestID ?? 'unreadable')} and withheld behind the palette session (visible ${String(queuedState?.visible)}); afterwards the surface holds ${JSON.stringify({ prompt: surfaceAfter?.prompt, queued: surfaceAfter?.queued })} and the window draws no dialog. Observed, not asserted: the rebuilt UI Lab panel reads ${JSON.stringify(panelAfter)} and carries ${answerAfter === null ? 'no recorded answer, because the frame was rebuilt and the promise died with the document that raised it' : `the answer ${String(answerAfter)}`}`);
            await askUILab('dialog');
            if (!await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt-action"][data-action-id="confirm"]')`)) {
                throw new Error(`a fresh dialog did not reach the presenter after the reconnect: ${await labState(promptsFrame)}`);
            }
            await clickFrame(promptsFrame, '[data-testid="lab-prompt-action"][data-action-id="confirm"]');
            const freshAnswer = await output('dialog', 'confirm');
            rec.check('a prompt raised after the reconnect is presented by the lab and settles with its action',
                freshAnswer && (await labSnapshot(promptsFrame))?.queued === 0,
                `UI Lab reads ${String(await inFrame(uiFrame, `document.getElementById('dialog-result')?.textContent ?? '<gone>'`))} and nothing is queued behind it`);

            const caretBack = await caretIn(shellPane) || await (async () => { await d.focusPaneBody(page, shellPane); return await caretIn(shellPane); })();
            await d.runInTerminal(page, `printf '${MARKER}-%s\\n' AFTER`, { settleMs: 1_500 });
            const markedAfter = await capture();
            /*
             * Two claims in one reading. The pane takes input again, which is the caret not being
             * stranded in a frame that no longer exists; and the pre-restart marker is EXACTLY
             * ABSENT afterwards, which is the only reading that can fail on the regression this is
             * named for. The old PTY died with the old daemon and the pane's shell is a new
             * process with an empty screen, so a clean run reads zero; a buffer of pre-restart
             * input replayed into that new shell would run the command again and read one, which
             * "no more than one" would have passed. The `markerAfter` half then proves the pane is
             * genuinely live rather than merely silent.
             */
            rec.check('the caret is not stranded and no command is replayed into the new shell',
                caretBack && count(markedBefore, markerBefore) === 1 && count(markedAfter, markerBefore) === 0
                && count(markedAfter, markerAfter) === 1,
                `${markerBefore} ×${String(count(markedBefore, markerBefore))} before the restart and ×${String(count(markedAfter, markerBefore))} after it (zero is the claim: the new shell must not replay it); the pane took ${markerAfter} ×${String(count(markedAfter, markerAfter))} afterwards; caret in ${String(await page.eval(CARET_PANE)) || '<none>'}`);
            await shot('after-daemon-restart', 'the window after its daemon was stopped and replaced: both lab presenters attached and idle again, the pane grid drawn normally with the shell pane’s new prompt, and no reconnect banner, no toast, no dialog and no palette anywhere.');
        }
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
        // Check 10's recorder, if a throw landed between installing it and reading it: an observer
        // and a 100 ms timer left running in the window are the next scenario's, not this one's.
        await safely('the connection recorder is stopped', () => page.eval(`(() => { if (typeof globalThis.__daemonTrailStop === 'function') globalThis.__daemonTrailStop(); return true; })()`));
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

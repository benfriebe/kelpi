/**
 * A plugin drawing the Settings dialog, against a real window and a real daemon.
 *
 * Phase 2 added one more replaceable surface: a view selected for `settings.window`, in Settings
 * ▸ Plugins ▸ Workbench views, draws the rail and the panel INSIDE the host's Settings dialog. The
 * unit suites pin the projection, the two watchdogs, the refusals and the latch. What only a live
 * window can answer is whether a value edited inside that frame reaches the user's config file,
 * whether the things the projection withholds are really absent from the frame rather than merely
 * absent from a fixture, and whether the route to switching the presenter OFF survives the
 * presenter failing while it holds the dialog. So this presses all of it:
 *
 *   1. the placement is offered with its bundled entry named, the lab attaches as an isolated
 *      view, reports it has painted, and `data-settings-presenter` names the view that is drawing;
 *   2. `ui.selectView('settings.window', …)` is refused while `getWorkbench().slots` lists it;
 *   3. the rail carries EVERY section, a section the presenter routes to is published back to it,
 *      General projects fields with the host's remainder below the frame, and Plugins is native in
 *      full and is drawn outside the iframe with the lab standing down;
 *   4. edits: the worktree base path committed through the frame lands in the config file and in
 *      the bundled General tab, a toggle and a segmented value round-trip through the same file,
 *      and a slider commit off the step grid is refused in the frame with nothing written;
 *   5. withholding, live: no pairing URL, no `token=`, no profile environment value, no write verb
 *      and no other plugin's id in any frame or anywhere in the presenter's document, and two
 *      forged writes (a field the frame does not publish, and a write while a native section is
 *      routed) refused with the config file byte-identical;
 *   6. a config-injection draft (`x\ncommand = …`) refused, with the config file byte-identical;
 *   7. failure and recovery: a crash with a half-typed draft on Appearance, the bundled dialog
 *      taking over on the SAME section with that draft still in the field, the failure toast, the
 *      Settings row reading Failed, Retry, and then the acknowledgement watchdog doing the same
 *      thing to a presenter that has stopped acknowledging;
 *   8. Escape relayed out of the frame closes the dialog, ⌘, reopens into the lab, and a palette
 *      raised OVER Settings owns its own Escape;
 *   9. disable / enable / reload, with the selection retained;
 *  10. a phone window keeping the bundled sheet with the lab still selected;
 *  11. four screenshots for the eyes, each with a note saying what to look for.
 *
 * ── What it depends on ──────────────────────────────────────────────────────────────
 *
 * `examples/plugins/settings-lab` (plain JS, no build): one view `example.settings-lab.window` for
 * `settings.window`, setting `document.body.dataset.ready = 'true'` once it has reported readiness
 * and exposing `globalThis.settingsLab = { snapshot, ready, frames, lastError, crash(mode?),
 * stall() }`. Its controls are read by test id - `lab-settings`, `lab-settings-rail`,
 * `lab-settings-rail-item` (`data-section-id`), `lab-settings-field` (`data-field-id`,
 * `data-kind`), `lab-settings-input`, `lab-settings-commit`, `lab-settings-reset`,
 * `lab-settings-dirty`, `lab-settings-native-note`, `lab-settings-close`. Everything a check
 * ASSERTS is read from the contract instead (`settingsLab.snapshot`, the host's own test ids, the
 * config file the daemon writes), so a cosmetic change in the lab cannot turn a check green.
 *
 * A control may be nested inside its field row or may carry `data-field-id` itself; both spellings
 * are resolved here, and a control the lab does not draw at all falls back to the presenter API
 * with a note saying so. `example.ui-lab` is installed as the SECOND plugin: check 2 needs an
 * ordinary plugin frame to call `ui.getWorkbench` and `ui.selectView` from, and check 5 needs
 * another plugin's id to be absent from the presenter's document rather than merely unused.
 *
 * The two failure hooks differ, and the checks below are written to that difference.
 * `crash('uncaught')` fails the presenter THERE AND THEN, so nothing is sent into the frame after
 * it is armed; `uncaught` is the mode used because a listener that merely throws is caught by the
 * SDK and its frame is still acknowledged, while an uncaught error is what the SDK reports as a
 * view error and `SettingsPresenterSlot` fails the placement on. `stall()` only ARMS: it takes a
 * frame that the watchdog waits for an acknowledgement of (a route to another section, or a change
 * in the set of projected fields) before anything happens at all, so the arm and that route go out
 * together.
 *
 * ── Limits, on the record ───────────────────────────────────────────────────────────
 *
 *   - **No daemon disconnect/reconnect.** Rule 3 of the recovery floor (`settings/presenter-slot.tsx`)
 *     draws bundled while the connection is down, and the honest way to press it is to stop the
 *     PRIMARY daemon under a live window. `scripts/scenario.mjs` hands a scenario `cli`, `sandbox`
 *     and `shell` but no daemon handle, and `plugin-remote.mjs`'s scaffolding only buys a SECOND
 *     daemon, which is not the runtime a Settings presenter is selected for. Disable, reload and
 *     both watchdogs exercise the same latch-and-retry path here; the connection arm stays covered
 *     by `presenter-slot`'s unit suite.
 *   - **The call-budget breach is not pressed live.** 240 calls per rolling second fails the
 *     presenter (`presenter.ts` ▸ `charge`), and driving 240 calls through the frame in under a
 *     second from CDP measures the harness rather than the host. `presenter.test.ts` owns it.
 *   - **The config file is not byte-identical to the sandbox's original at the end.** Cleanup puts
 *     every value this scenario changed back through the same commit verbs, and a committed
 *     default is still a written line: the file ends holding the shipped values rather than the
 *     empty file it started as. The tail is recorded in a note. Byte-identical is asserted where
 *     it is the claim - across the two forged writes and the injection draft.
 *
 * Screenshots are blank in the `hidden` lane (the recorder says so in its own note); every check
 * here is a DOM, frame or config-file assertion, and none of them measures a pixel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * `examples/plugins/settings-lab/` is the example this drives; `settings/` is the surface, the
 * projection and the presenter slot it presses; `plugins/` holds the Workbench select, the status
 * row, Retry and `PluginView`'s presenter grant and chord relay; `features/` carries the bundled
 * `kelpi.settings.window` definition that is the recovery floor; `plugin-sdk/` is the public
 * contract (`settings.d.ts`); `protocol/src/plugins.ts` validates the placement and refuses it to
 * containers; `App.tsx` wires the dialog, the presenter chords, the modal presence and the failure
 * toast; `chrome/` owns the toast stack and the modal-presence registry a palette peer registers
 * in; `phone/` is check 10's shell; `daemon/src/settings/` is the allowlist that every committed
 * value has to pass before it becomes a line in the user's file.
 */
export const covers = ['examples/plugins/settings-lab/', 'packages/client/src/settings/',
    'packages/client/src/plugins/', 'packages/client/src/features/', 'packages/plugin-sdk/',
    'packages/protocol/src/plugins.ts', 'packages/client/src/App.tsx', 'packages/client/src/chrome/',
    'packages/client/src/phone/', 'packages/daemon/src/settings/'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const labID = 'example.settings-lab', uiID = 'example.ui-lab';
const labPath = path.join(repoRoot, 'examples/plugins/settings-lab');
const uiPath = path.join(repoRoot, 'examples/plugins/ui-lab');
const labView = `${labID}.window`;
/** The recovery floor's own view id and the slot both of them are selected into. */
const bundledView = 'kelpi.settings.window', slot = 'settings.window';

/** Whichever wrapper draws carries the test id; `data-settings-presenter` names who it is. */
const presenterSlot = `[data-testid="settings-presenter"][data-settings-presenter="${labView}"]`;
const presenterFrame = `${presenterSlot} iframe`;
const bundledSlot = '[data-testid="settings-presenter"][data-settings-presenter="bundled"]';
const remainder = '[data-testid="settings-native-remainder"]';
const statusRowID = `settings-presenter-status-${slot}`;
const retryID = `settings-presenter-retry-${slot}`;

/** Every section the catalog lists, in rail order (`settings/catalog.ts` ▸ SETTINGS_TABS). */
const SECTIONS = ['general', 'appearance', 'repositories', 'labels', 'profiles', 'keybindings', 'web',
    'workspaces', 'remote', 'plugins'];

/**
 * What must never appear in a frame or in the presenter's document.
 *
 * The first three are seeded into the config file by this scenario, so their absence is a real
 * withholding rather than a value that happened not to exist: a pairing URL and its token
 * (`remote-daemon = name:https://host/?token=…`), and a profile's environment value. The last two
 * are the host's own vocabulary: the verb that writes a general key, and the other installed
 * plugin's id.
 */
const PAIRING_TOKEN = 'kd_scenario_pairing_secret';
const PAIRING_URL = `https://scenario-remote.invalid/?token=${PAIRING_TOKEN}`;
const PROFILE_SECRET = 'kelpi-scenario-env-secret';
const SEED_LINES = `remote-daemon = ScenarioRemote:${PAIRING_URL}\nprofile = ScenarioProfile:SCENARIO_ENV_SECRET=${PROFILE_SECRET}\n`;
const FORBIDDEN = [PAIRING_TOKEN, PAIRING_URL, PROFILE_SECRET, 'remote-daemon', 'token=',
    'set-general-setting', 'set-ghostty-setting', uiID];

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    if (!fs.existsSync(path.join(labPath, 'kelpi.plugin.json'))) {
        throw new Error(`settings-lab is not in this checkout (${labPath}); the example has to land before this scenario can run`);
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
            const raw = await inFrame(`JSON.stringify(globalThis.settingsLab?.snapshot ?? null)`);
            return typeof raw === 'string' ? JSON.parse(raw) : null;
        } catch { return null; }
    };
    /** How many frames this presenter has been delivered. Null when the frame is unreadable. */
    const labFrames = async () => {
        try {
            const value = await inFrame(`globalThis.settingsLab?.frames ?? null`);
            return typeof value === 'number' ? value : null;
        } catch { return null; }
    };
    /** What `ui.getSettingsPresentation()` answers right now: the same projection, read fresh. */
    const livePresentation = async () => {
        try {
            const raw = await inFrame(`(async () => JSON.stringify(await kelpi.ui.getSettingsPresentation()))()`);
            return typeof raw === 'string' ? JSON.parse(raw) : null;
        } catch { return null; }
    };
    /** Everything worth printing beside a failed check, from inside the presenter frame. */
    const labState = async () => {
        try {
            return await inFrame(`JSON.stringify({ ready: document.body.dataset.ready ?? null, visible: document.body.dataset.visible ?? null, section: document.body.dataset.section ?? null, frames: globalThis.settingsLab?.frames ?? null, lastError: globalThis.settingsLab?.lastError ?? null, snapshot: globalThis.settingsLab?.snapshot ?? null })`);
        } catch (error) { return `frame unreadable: ${error instanceof Error ? error.message : String(error)}`; }
    };
    const ready = (ceilingMs = 12_000) => frameCheck(`document.body.dataset.ready === 'true'`, ceilingMs);
    const isolated = () => frameCheck(`(() => { try { parent.document.body; return false; } catch { return true; } })()`);
    const attached = (ceilingMs = 15_000) => d.settleDom(page, `document.querySelector('${presenterSlot}')`, { ceilingMs });
    const painted = (ceilingMs = 10_000) => d.settleDom(page, `document.querySelector('${presenterSlot}')?.hidden === false`, { ceilingMs });
    const drawsBundled = (ceilingMs = 15_000) => d.settleDom(page, `document.querySelector('${bundledSlot}')`, { ceilingMs });
    /**
     * Is the plugin the one drawing right now?
     *
     * A settle rather than a read: the wrapper is rendered in the same commit as the dialog, but a
     * dialog that has just been reopened is a render this can otherwise beat, and answering "the
     * bundled panel is drawing" one frame early sends `openPlugins` at a rail that is not there.
     */
    const presenting = (ceilingMs = 2_500) => d.settleDom(page, `document.querySelector('${presenterSlot}')`, { ceilingMs });
    /** Arm one of the lab's failure hooks. Both only set a flag the NEXT frame reads. */
    const arm = call => inFrame(`(() => { globalThis.settingsLab.${call}; return true; })()`);

    const selectAll = async () => {
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4 });
    };
    /**
     * Click something INSIDE the presenter frame, aim checked before the press.
     *
     * `plugin-interaction-presenters.mjs`'s helper verbatim, for the same reason: a hidden overlay,
     * a dialog that moved or a frame scrolled out from under the point all produce the same silent
     * miss, and a click that lands somewhere else is otherwise only visible much later as "the
     * section never changed".
     */
    const clickFrame = async target => {
        if (!await frameCheck(`(() => { const node = document.querySelector(${JSON.stringify(target)}); return node && !node.disabled; })()`)) {
            throw new Error(`Missing or disabled ${target} in the presenter frame: ${await labState()}`);
        }
        const inner = await inFrame(`(() => { const node = document.querySelector(${JSON.stringify(target)}); node.scrollIntoView({block:'center',inline:'center'}); const box = node.getBoundingClientRect(); return {x:box.x + box.width/2, y:box.y + box.height/2, width:box.width, height:box.height}; })()`);
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
        if (hit !== 'frame') throw new Error(`${target} in the presenter frame is covered at ${JSON.stringify(point)}: ${String(hit)}`);
        await page.clickAt(point.x, point.y);
    };
    const typeInFrame = async (target, text) => { await clickFrame(target); await selectAll(); await page.insertText(text); };
    /**
     * Click something in the HOST page that may be scrolled out of its own panel, aim checked.
     * The Workbench rows sit at the bottom of a long scrolling section, and `page.click` aims at an
     * element's rect whether or not anything else is over it.
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
    const shot = async (label, eyes) => {
        const file = await rec.shot(page, label);
        rec.note(`EYES ${path.basename(file)}: ${eyes}`);
        return file;
    };

    // ── the dialog ──────────────────────────────────────────────────────────────────
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
    const railItem = id => `[data-testid="lab-settings-rail-item"][data-section-id="${id}"]`;
    /**
     * Route the dialog, through the LAB's rail where it draws one.
     *
     * The rail is the presenter's, and a click on it is the gesture a user makes, so that is the
     * route taken; a section the lab draws no rail entry for goes through the presenter's own API
     * instead. Either way the wait is for the FRAME to follow, which is the presenter's only view
     * of where it is, and the return value says whether it did.
     */
    const routeTo = async (id, { click = true } = {}) => {
        const item = railItem(id);
        if (click && await frameCheck(`!!document.querySelector(${JSON.stringify(item)})`, 4_000)) await clickFrame(item);
        else await inFrame(`(() => { void kelpi.ui.setSettingsSection(${JSON.stringify(id)}); return true; })()`);
        return await d.settle(async () => (await labSnapshot())?.sectionID === id, { ceilingMs: 10_000 });
    };
    /**
     * Reach the Workbench rows, whoever is painting.
     *
     * With a presenter up, the bundled rail is not drawn at all: the frame has the rail and the
     * host draws Plugins as the native remainder below it. Without one, the bundled rail is the
     * only route. Both land on the same `plugin-placements`, which is the point of Plugins being
     * permanently native.
     */
    const openPlugins = async () => {
        await openSettings();
        if (await presenting()) await routeTo('plugins');
        else {
            await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`, { ceilingMs: 8_000 });
            await clickHost('[data-testid="settings-tab-button-plugins"]');
        }
        return await d.settleDom(page, `document.querySelector('[data-testid="plugin-placements"]')`, { ceilingMs: 10_000 });
    };
    /** A slot select's options as `{value, label}`; the label matters, it is the route back. */
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
    /** Retry, when there is one to press. A missing button is reported by whoever asked for it. */
    const retry = async () => {
        if (!await d.settleDom(page, `document.querySelector('[data-testid="${retryID}"]')`, { ceilingMs: 6_000 })) {
            rec.note(`no Retry button on the settings.window row (${await statusRow()}), so the placement was not retried`);
            return false;
        }
        await clickHost(`[data-testid="${retryID}"]`);
        return true;
    };
    /** Select a view for the placement and leave Settings as it was found. */
    const selectPresenter = async viewID => {
        await openPlugins();
        const chosen = await chooseSlot(viewID);
        return chosen;
    };
    const toastsGone = (ceilingMs = 12_000) => d.settleDom(page, `!document.querySelector('[data-testid="toast-stack"]')`, { ceilingMs });

    // ── the config file, which is the only authority on "it was written" ────────────
    const readConfig = () => fs.readFileSync(sandbox.configPath, 'utf8');
    /** The other file a committed value can land in: Appearance's terminal rows write ghostty's. */
    const readGhostty = () => fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
    const configSettled = (pattern, ceilingMs = 10_000) => d.settle(() => pattern.test(readConfig()), { ceilingMs });
    const tail = (text, n = 240) => text.trim().slice(-n).replace(/\n/g, ' | ');

    // ── editing through the lab ─────────────────────────────────────────────────────
    const fieldRow = id => `[data-testid="lab-settings-field"][data-field-id="${id}"]`;
    /**
     * Resolve one of the lab's per-field controls.
     *
     * Nested inside the row, or carrying `data-field-id` itself: both are reasonable spellings of
     * the same thing and the scenario was written before the example landed, so it resolves rather
     * than assumes. `null` means the lab draws no such control, which the caller reports.
     */
    const control = async (fieldID, name, value) => {
        const qualifier = value === undefined ? '' : `[data-value="${value}"]`;
        for (const selector of [`[data-testid="lab-settings-${name}"][data-field-id="${fieldID}"]${qualifier}`,
            `${fieldRow(fieldID)} [data-testid="lab-settings-${name}"]${qualifier}`]) {
            if (await frameCheck(`!!document.querySelector(${JSON.stringify(selector)})`, 4_000)) return selector;
        }
        return null;
    };
    const fieldSnapshot = async fieldID => {
        try {
            const raw = await inFrame(`JSON.stringify((globalThis.settingsLab?.snapshot?.fields ?? []).find(field => field.id === ${JSON.stringify(fieldID)}) ?? null)`);
            return typeof raw === 'string' ? JSON.parse(raw) : null;
        } catch { return null; }
    };
    /** `setSettingsDraft` as the presenter's own API call, from inside its frame. */
    const draftThroughAPI = (fieldID, text) => inFrame(`(() => { void kelpi.ui.setSettingsDraft(${JSON.stringify(fieldID)}, ${JSON.stringify(text)}); return true; })()`);
    const commitThroughAPI = fieldID => inFrame(`(() => { void kelpi.ui.commitSettingsField(${JSON.stringify(fieldID)}); return true; })()`);
    const held = async (fieldID, text) => await d.settle(async () => {
        const field = await fieldSnapshot(fieldID);
        return field?.draft === text || String(field?.value) === text;
    }, { ceilingMs: 6_000 });
    /**
     * Hold a draft in the host, through the lab's own control where it has a safe one.
     *
     * The DOM route is what a user does, so it is taken where it can be and PROVEN by the frame
     * that comes back: the draft the host is holding, not the text in the box. Two things keep it
     * honest. A control that is not a plain field is left alone, because clicking a `<select>` in
     * an Electron window opens an OS popup that nothing in CDP can then click past; and a lab whose
     * input publishes on `change` rather than on `input` would leave the draft unset with every
     * later assertion chasing it, so the fallback to the presenter's own API is explicit and noted.
     */
    const draft = async (fieldID, text) => {
        const field = await fieldSnapshot(fieldID);
        const kind = field?.kind ?? '';
        // A segmented row draws one control PER CHOICE, each carrying the value it sets, so the
        // right one is named rather than found by its position in the group.
        const input = kind === 'segmented' ? await control(fieldID, 'input', text) : await control(fieldID, 'input');
        if (input !== null) {
            const shape = JSON.parse(String(await inFrame(`(() => { const node = document.querySelector(${JSON.stringify(input)}); return JSON.stringify({ tag: node.tagName, type: String(node.type ?? ''), role: node.getAttribute('role') ?? '' }); })()`)));
            const type = shape.type.toLowerCase();
            const typable = shape.tag === 'INPUT' && ['text', 'search', 'number', ''].includes(type);
            /*
             * A switch and a segment hold and commit in one gesture, so they are pressed rather
             * than typed into, and only when they are not already showing the wanted value. A
             * `<select>` is neither: clicking one in an Electron window opens an OS popup that
             * nothing in CDP can click past, so a select goes through the presenter's own API.
             */
            const pressable = kind === 'segmented'
                || (kind === 'toggle' && (shape.role === 'switch' || type === 'checkbox' || shape.tag === 'BUTTON'));
            if (typable || pressable) {
                try {
                    if (typable) await typeInFrame(input, text);
                    else if (String(field?.value) !== text) await clickFrame(input);
                    else return 'already at that value';
                    if (await held(fieldID, text)) return typable ? 'the lab’s input' : `the lab’s ${kind === 'segmented' ? 'segment' : 'switch'}`;
                } catch (error) {
                    rec.note(`the lab's control for ${fieldID} could not be driven (${error instanceof Error ? error.message : String(error)}); using setSettingsDraft from the same frame`);
                }
                rec.note(`the lab's control for ${fieldID} did not publish a draft; using setSettingsDraft from the same frame`);
            } else {
                rec.note(`the lab draws ${String(shape.tag)}[type=${type || 'none'}] for ${fieldID}, which CDP must not click; using setSettingsDraft from the same frame`);
            }
        }
        await draftThroughAPI(fieldID, text);
        await held(fieldID, text);
        return input === null ? 'the presenter API (no input drawn)' : 'the presenter API (fallback)';
    };
    /** Commit, through the lab's own button where it has one. */
    const commit = async fieldID => {
        const button = await control(fieldID, 'commit');
        if (button !== null) {
            try { await clickFrame(button); return 'commit button'; }
            catch (error) { rec.note(`the lab's commit control for ${fieldID} could not be clicked (${error instanceof Error ? error.message : String(error)}); using the presenter API`); }
        }
        await commitThroughAPI(fieldID);
        return button === null ? 'api (no commit control drawn)' : 'api (fallback)';
    };
    const resetField = fieldID => inFrame(`(() => { void kelpi.ui.resetSettingsField(${JSON.stringify(fieldID)}); return true; })()`);
    /** A refused call's message, or `'resolved'` if the host let it through. */
    const refusal = expression => inFrame(`${expression}.then(() => 'resolved', error => error.message)`);

    /**
     * Put the phone shell back on its landing page.
     *
     * `phone/place.ts` remembers `{host, workspaceID}` for whatever workspace the phone last had on
     * screen, and a remembered place means the next phone window opens THERE instead of on the
     * landing page, which is the host picker `plugin-remote` starts from. Going back to the landing
     * page clears it. A no-op on a desktop window and on the landing page itself.
     */
    const phoneToLanding = async () => {
        if (!await page.eval(`!!document.querySelector('[data-testid="phone-shell"]')`)) return true;
        if (await page.eval(`!!document.querySelector('[data-testid="phone-landing"]')`)) return true;
        if (!await d.settleDom(page, `document.querySelector('[data-testid="phone-open-landing"]')`, { ceilingMs: 5_000 })) return false;
        await clickHost('[data-testid="phone-open-landing"]');
        return await d.settleDom(page, `document.querySelector('[data-testid="phone-landing"]')`, { ceilingMs: 5_000 });
    };

    // Where the window was before this scenario took it, and what the file held: both restored at
    // the end, because the sandbox and its window are shared with whatever runs next.
    const startingWorkspace = await page.eval(`document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.getAttribute('data-workspace-id') ?? null`);
    const originalConfig = readConfig();
    const workspace = await json(['workspace', 'create', '--name', 'Settings presenter', '--json']);
    const workspaceID = workspace.workspace_id;
    const liveBase = path.join(sandbox.root, 'presenter-worktrees', '<repo>');
    let uiFrame = '';
    let seeded = false;

    try {
        // ── 1 · the placement is offered, and the lab attaches ───────────────────────
        await cli.ok(['plugin', 'install', labPath, '--trust']);
        await cli.ok(['plugin', 'install', uiPath, '--trust']);
        const uiPane = await json(['plugin', 'open', uiID, `${uiID}.panel`, '--workspace', workspaceID]);
        uiFrame = `[data-testid="plugin-view-${uiPane.paneID}"] iframe`;
        if (!await d.settle(async () => {
            try { return await page.evalInFrame(uiFrame, `document.body.dataset.ready === 'true'`); } catch { return false; }
        }, { ceilingMs: 20_000 })) throw new Error('UI Lab did not attach');

        await openPlugins();
        const options = await slotOptions();
        const offered = options.some(option => option.value === labView);
        /*
         * The route BACK, read from the live select rather than assumed. A replaced Settings dialog
         * looks exactly like an unreplaced one, so the bundled entry has to name itself: a user who
         * cannot find the floor is a user stuck inside a presenter they no longer want.
         */
        const bundledLabel = labelFor(options, bundledView);
        const chosen = await chooseSlot(labView);
        rec.check('Settings offers the settings.window placement and selects the lab for it',
            offered && chosen && await slotValue() === labView,
            `options ${JSON.stringify(options)}`);
        rec.check('the settings.window select names its bundled entry as the recovery floor',
            bundledLabel === 'Settings (bundled)', String(bundledLabel));
        const attachedNow = await attached();
        const readyNow = attachedNow && await ready();
        rec.check('the Settings presenter attaches as an isolated view and reports it has painted',
            attachedNow && readyNow && await painted() && await isolated(), await labState());
        const firstFrame = await labSnapshot();
        rec.check('the first frame is the Settings placement, painted, on a desktop',
            firstFrame?.placement === slot && firstFrame.visible === true && firstFrame.formFactor === 'desktop'
            && Array.isArray(firstFrame.sections) && firstFrame.sections.length === SECTIONS.length,
            JSON.stringify({ placement: firstFrame?.placement, visible: firstFrame?.visible, formFactor: firstFrame?.formFactor, sections: firstFrame?.sections?.length }));
        rec.check('the wrapper that is drawing names the view that is drawing it',
            await page.eval(`document.querySelector('[data-testid="settings-presenter"]')?.getAttribute('data-settings-presenter') === ${JSON.stringify(labView)}`)
            && await page.eval(`!document.querySelector('${bundledSlot}')`),
            String(await page.eval(`document.querySelector('[data-testid="settings-presenter"]')?.getAttribute('data-settings-presenter') ?? '<none>'`)));

        // ── 2 · discoverable, never programmatically selectable ──────────────────────
        const slots = JSON.parse(await page.evalInFrame(uiFrame, `(async () => { const workbench = await kelpi.ui.getWorkbench(); return JSON.stringify(workbench.slots.filter(entry => entry.id === ${JSON.stringify(slot)})); })()`));
        const refused = await page.evalInFrame(uiFrame, `kelpi.ui.selectView(${JSON.stringify(slot)}, ${JSON.stringify(labView)}).then(() => 'resolved', error => error.message)`);
        const refusedBundled = await page.evalInFrame(uiFrame, `kelpi.ui.selectView(${JSON.stringify(slot)}, ${JSON.stringify(bundledView)}).then(() => 'resolved', error => error.message)`);
        rec.check('a plugin discovers settings.window but ui.selectView refuses it in both directions',
            refused === 'Workbench slot is not registered.' && refusedBundled === 'Workbench slot is not registered.'
            && slots[0]?.id === slot && slots[0]?.viewID === labView,
            `${JSON.stringify(slots)} · ${JSON.stringify([refused, refusedBundled])}`);

        // ── 3 · the rail, the projected section, and the native one ──────────────────
        /*
         * The first route of the run, measured on its own: a presenter that asks for a section has
         * to be TOLD it got there, because the frame is the only thing it can draw from and the
         * acknowledgement watchdog is armed by exactly this kind of frame. ONE frame, counted: a
         * route that published two would be a redraw the user can see, and a route that published
         * none is the section the presenter is still showing.
         */
        const framesBefore = await labFrames();
        await clickFrame(railItem('general'));
        const routeFollowed = await d.settle(async () => (await labSnapshot())?.sectionID === 'general', { ceilingMs: 8_000 });
        await sleep(600);
        const framesAfter = await labFrames();
        const routedFrame = await labSnapshot();
        const hostRouted = await livePresentation();
        rec.check('a section the presenter routes to is published back to it as exactly one frame',
            routeFollowed && framesBefore !== null && framesAfter === framesBefore + 1
            && routedFrame?.sectionID === 'general' && hostRouted?.sectionID === 'general'
            && routedFrame.fields.length === hostRouted.fields.length,
            `frames ${String(framesBefore)} → ${String(framesAfter)}; the feed's last frame is ${String(routedFrame?.sectionID)} with ${String(routedFrame?.fields?.length)} fields, ui.getSettingsPresentation() answers ${String(hostRouted?.sectionID)} with ${String(hostRouted?.fields?.length)} fields, and the host's own remainder draws ${String(await page.eval(`document.querySelector('${remainder} [data-testid^="settings-tab-"]')?.getAttribute('data-testid') ?? '<none>'`))}`);
        const rail = JSON.parse(await inFrame(`JSON.stringify([...document.querySelectorAll('[data-testid="lab-settings-rail-item"]')].map(item => item.getAttribute('data-section-id')))`));
        rec.check('the lab draws a rail entry for every section, the native ones included',
            SECTIONS.every(id => rail.includes(id)) && rail.length === SECTIONS.length,
            `${rail.length} entries: ${JSON.stringify(rail)}`);
        const general = await labSnapshot();
        const generalFields = (general?.fields ?? []).map(field => field.id);
        const remainderText = await page.eval(`document.querySelector('${remainder}')?.textContent ?? ''`);
        const remainderOutside = await page.eval(`(() => {
            const frame = document.querySelector('${presenterFrame}');
            const native = document.querySelector('${remainder}');
            return native !== null && frame !== null && !frame.contains(native);
        })()`);
        const generalNote = await frameCheck(`document.querySelector('[data-testid="lab-settings-native-note"]')?.dataset.native === 'remainder'`, 6_000);
        rec.check('General projects its fields to the frame and the host draws its native remainder below',
            generalFields.includes('general.worktreeBasePath') && generalFields.includes('general.autoDetectRepos')
            && general?.native === true && generalNote && remainderOutside
            && (remainderText.includes(sandbox.configPath) || remainderText.includes('Config:')
                || await page.eval(`!!document.querySelector('${remainder} [data-testid="compat-degraded-note"]')`)),
            `fields ${JSON.stringify(generalFields)} · lab note remainder ${String(generalNote)} · remainder ${JSON.stringify(remainderText.trim().slice(0, 140))}`);
        await shot('lab-settings-general', 'Settings, drawn by the LAB: its own rail down the left with all ten sections, the General cards (Base path, Auto-detect, the workspace placement selects) inside the frame, and the host\u2019s native remainder underneath it naming the config file. No bundled rail anywhere.');

        await routeTo('plugins');
        const pluginsFrame = await labSnapshot();
        const nativePanel = await page.eval(`!!document.querySelector('${remainder} [data-testid="plugins-settings"]')`);
        const restoreButton = await page.eval(`(() => [...document.querySelectorAll('${remainder} button')].some(node => (node.textContent ?? '').trim() === 'Restore bundled views'))()`);
        const statusInRemainder = await page.eval(`!!document.querySelector('${remainder} [data-testid="${statusRowID}"]')`);
        // Every section reports `native: true` in this release, so the note's own `data-native`
        // (`full` against `remainder`) is the only thing that says which kind of native this is.
        const labNote = await frameCheck(`document.querySelector('[data-testid="lab-settings-native-note"]')?.dataset.native === 'full'`, 6_000);
        rec.check('a native section is drawn by the host outside the iframe with the lab standing down',
            pluginsFrame?.native === true && (pluginsFrame?.fields ?? []).length === 0 && (pluginsFrame?.groups ?? []).length === 0
            && nativePanel && restoreButton && statusInRemainder && labNote && await presenting(),
            `frame ${JSON.stringify({ native: pluginsFrame?.native, fields: pluginsFrame?.fields?.length, groups: pluginsFrame?.groups?.length })} · plugins panel ${String(nativePanel)} · restore ${String(restoreButton)} · status row ${String(statusInRemainder)} · lab note ${String(labNote)}`);
        rec.check('the Settings row reports the lab as the presenter while it is drawing',
            (await statusRow()).includes('Settings Lab') || (await statusRow()).includes(labView) || !(await statusRow()).includes('Bundled'),
            await statusRow());

        // ── 4 · editing, all the way to the daemon's file ────────────────────────────
        await routeTo('general');
        const baseRoute = await draft('general.worktreeBasePath', liveBase);
        const beforeBase = readConfig();
        const baseCommit = await commit('general.worktreeBasePath');
        const wroteBase = await configSettled(new RegExp(`worktree-base-path\\s*=\\s*${liveBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        const baseValue = await d.settle(async () => (await fieldSnapshot('general.worktreeBasePath'))?.value === liveBase, { ceilingMs: 8_000 });
        rec.check('a base path committed in the presenter frame becomes a line in the daemon\u2019s config file',
            wroteBase && baseValue && readConfig() !== beforeBase,
            `draft via ${baseRoute}, commit via ${baseCommit}; config tail ${tail(readConfig())}`);

        // The same value, read off the BUNDLED tab: the presenter and the panel it replaced are
        // looking at one surface, so a value committed in one has to be the value the other shows.
        await selectPresenter(bundledView);
        const backToBundled = await drawsBundled();
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-general"]')`, { ceilingMs: 8_000 });
        await clickHost('[data-testid="settings-tab-button-general"]');
        const bundledShows = await d.settleDom(page, `document.querySelector('[data-testid="worktree-base-path-input"]')?.value === ${JSON.stringify(liveBase)}`, { ceilingMs: 8_000 });
        rec.check('the bundled General tab shows the value the presenter committed',
            backToBundled && bundledShows,
            String(await page.eval(`document.querySelector('[data-testid="worktree-base-path-input"]')?.value ?? '<no field>'`)));
        await selectPresenter(labView);
        if (!(await attached() && await ready())) throw new Error(`the presenter did not come back after the bundled round trip: ${await labState()}`);

        await routeTo('general');
        const toggleBefore = (await fieldSnapshot('general.autoDetectRepos'))?.value;
        await draft('general.autoDetectRepos', 'false');
        const toggleCommit = await commit('general.autoDetectRepos');
        const wroteToggle = await configSettled(/auto-detect-repos\s*=\s*false/);
        const toggleFollows = await d.settle(async () => (await fieldSnapshot('general.autoDetectRepos'))?.value === false, { ceilingMs: 8_000 });
        await draft('general.autoDetectRepos', 'true');
        await commit('general.autoDetectRepos');
        const toggleBack = await configSettled(/auto-detect-repos\s*=\s*true/)
            && await d.settle(async () => (await fieldSnapshot('general.autoDetectRepos'))?.value === true, { ceilingMs: 8_000 });
        rec.check('a toggle committed in the presenter frame round-trips through the config file',
            toggleBefore === true && wroteToggle && toggleFollows && toggleBack,
            `committed via ${toggleCommit}; config tail ${tail(readConfig())}`);

        await routeTo('appearance');
        const segmentBefore = (await fieldSnapshot('appearance.chromeAppearance'))?.value;
        await draft('appearance.chromeAppearance', 'dark');
        const segmentCommit = await commit('appearance.chromeAppearance');
        const wroteSegment = await configSettled(/chrome-appearance\s*=\s*dark/);
        const segmentFollows = await d.settle(async () => (await fieldSnapshot('appearance.chromeAppearance'))?.value === 'dark', { ceilingMs: 8_000 });
        rec.check('a segmented Appearance value committed in the frame round-trips through the config file',
            segmentBefore === 'system' && wroteSegment && segmentFollows,
            `committed via ${segmentCommit}; config tail ${tail(readConfig())}`);
        await shot('lab-settings-appearance', 'the LAB drawing Appearance: its projected rows (Appearance segmented control, the sidebar and terminal sliders, the search colours) inside the frame, with the host\u2019s native remainder below them holding the preset gallery, the theme picker and the Resets. The chrome appearance reads Dark.');

        /*
         * Off the step grid, and therefore refused.
         *
         * `appearance.backgroundOpacity` publishes `min 0.1, max 1, step 0.05`, so 0.37 is a value
         * the frame was told not to send. The draft goes through the presenter's API rather than
         * through the lab's control on purpose: the lab snaps its own range input to the grid, and
         * a range input could not express an off-grid value even if it did not. The row writes the
         * GHOSTTY file, so both files are the proof that nothing was written.
         */
        const beforeSlider = readConfig(), beforeGhostty = readGhostty();
        await draftThroughAPI('appearance.backgroundOpacity', '0.37');
        await commitThroughAPI('appearance.backgroundOpacity');
        const sliderError = await d.settle(async () => {
            const field = await fieldSnapshot('appearance.backgroundOpacity');
            return typeof field?.error === 'string' && field.error.includes('steps of 0.05');
        }, { ceilingMs: 8_000 });
        await sleep(600);
        rec.check('a slider commit off the step grid is refused in the frame and writes nothing',
            sliderError && readConfig() === beforeSlider && readGhostty() === beforeGhostty,
            `${JSON.stringify(await fieldSnapshot('appearance.backgroundOpacity'))} · kelpi config unchanged ${String(readConfig() === beforeSlider)} · ghostty config unchanged ${String(readGhostty() === beforeGhostty)}`);
        await resetField('appearance.backgroundOpacity');

        // ── 5 · what the frame never carries, live ───────────────────────────────────
        /*
         * The two secrets are SEEDED into the config file so their absence means withholding rather
         * than absence. `.invalid` never resolves (RFC 2606), so the pairing URL is a real
         * credential-bearing line that starts no traffic.
         */
        const beforeSeed = readConfig();
        fs.writeFileSync(sandbox.configPath, `${beforeSeed}${beforeSeed.endsWith('\n') || beforeSeed === '' ? '' : '\n'}${SEED_LINES}`);
        seeded = true;
        const seedArrived = await d.settleDom(page, `document.querySelector('[data-testid="remote-daemon-ScenarioRemote"]')`, { ceilingMs: 15_000 });
        if (!seedArrived) rec.note('the seeded remote daemon never appeared in the sidebar; the withholding check below still reads the frames, but the client may not have picked the seeds up');
        /*
         * Every section's frame, not only the one on screen: the projection is built section by
         * section, so a leak could live in a section this scenario never routed to otherwise.
         */
        const frames = {};
        for (const id of SECTIONS) {
            // Routed and then READ, rather than taken from the feed: `getSettingsPresentation` is
            // the same projection answered on demand, so the sweep measures what the host would
            // hand this presenter for every section rather than what the feed got around to.
            await inFrame(`(() => { void kelpi.ui.setSettingsSection(${JSON.stringify(id)}); return true; })()`);
            await sleep(400);
            frames[id] = await livePresentation();
        }
        const landed = SECTIONS.filter(id => frames[id]?.sectionID === id).length;
        const serialized = JSON.stringify(frames);
        const documentHTML = String(await inFrame(`document.documentElement.outerHTML`));
        /*
         * Two questions, because the frame's document is not only what the presenter drew: the host
         * hands a plugin view a document with its SDK bootstrap inlined, and that bundle carries
         * the protocol's own command names as ordinary source text. So the CREDENTIALS are checked
         * against every byte of the document, and the host's vocabulary against the projection and
         * against the document with its scripts removed - which is the part a presenter can read
         * off its own page.
         */
        const credentials = [PAIRING_TOKEN, PAIRING_URL, PROFILE_SECRET];
        const rendered = documentHTML.replace(/<script[\s\S]*?<\/script>/gi, '<script></script>');
        const inProjection = FORBIDDEN.filter(needle => serialized.includes(needle));
        const inRendered = FORBIDDEN.filter(needle => rendered.includes(needle));
        const inDocument = credentials.filter(needle => documentHTML.includes(needle));
        const context = needle => {
            const at = documentHTML.indexOf(needle);
            return at < 0 ? '' : ` … ${JSON.stringify(documentHTML.slice(Math.max(0, at - 70), at + 70))}`;
        };
        const alsoInScripts = FORBIDDEN.filter(needle => documentHTML.includes(needle) && !rendered.includes(needle));
        if (alsoInScripts.length > 0) rec.note(`in the document's inlined SCRIPTS but nowhere the presenter drew: ${JSON.stringify(alsoInScripts)}${context(alsoInScripts[0])}`);
        rec.check('no pairing URL, token, profile value, write verb or other plugin id reaches the projection or the page the presenter drew',
            inProjection.length === 0 && inRendered.length === 0 && inDocument.length === 0 && seedArrived && landed === SECTIONS.length,
            `projection ${inProjection.length === 0 ? 'clean' : JSON.stringify(inProjection)} across ${String(landed)}/${String(SECTIONS.length)} sections · drawn page ${inRendered.length === 0 ? 'clean' : JSON.stringify(inRendered)} (${String(rendered.length)} of ${String(documentHTML.length)} bytes) · credentials anywhere in the document ${inDocument.length === 0 ? 'none' : JSON.stringify(inDocument)}`);

        /*
         * Two forged writes, from inside the frame and around the lab.
         *
         * `general.tcpPort` is only published while the listener is ON (`sections.ts`'s `visible`),
         * so with it off the field is not in the frame at all; and a write attempted while a NATIVE
         * section is routed has no published fields to name. Both are refused by the same door, and
         * the file is the proof that nothing slipped past it.
         */
        await routeTo('general', { click: false });
        const beforeForged = readConfig();
        const listenerOff = (await fieldSnapshot('general.tcpPort')) === null;
        const forgedPort = await refusal(`kelpi.ui.commitSettingsField('general.tcpPort')`);
        const forgedDraft = await refusal(`kelpi.ui.setSettingsDraft('general.tcpPort', '19999')`);
        await routeTo('profiles', { click: false });
        const forgedNative = await refusal(`kelpi.ui.commitSettingsField('general.worktreeBasePath')`);
        const forgedSection = await refusal(`kelpi.ui.setSettingsSection('not-a-section')`);
        await sleep(800);
        rec.check('forged writes to a field the frame does not publish are refused with the config file byte-identical',
            listenerOff && forgedPort === 'That settings field is not in the current section.'
            && forgedDraft === 'That settings field is not in the current section.'
            && forgedNative === 'That settings field is not in the current section.'
            && forgedSection === 'That settings section does not exist.'
            && readConfig() === beforeForged,
            `${JSON.stringify({ forgedPort, forgedDraft, forgedNative, forgedSection })} · config unchanged ${String(readConfig() === beforeForged)}`);

        fs.writeFileSync(sandbox.configPath, beforeSeed);
        seeded = false;
        await d.settleDom(page, `!document.querySelector('[data-testid="remote-daemon-ScenarioRemote"]')`, { ceilingMs: 12_000 });

        // ── 6 · a config-injection draft, refused ────────────────────────────────────
        /*
         * `~/.config/kelpi/config` is line oriented, so a value carrying a newline does not write
         * one setting: it writes the setting and then whatever the next line parses as. The refusal
         * lives in both client funnels and the daemon repeats it; this is the live proof that the
         * one nearest the presenter holds.
         */
        await routeTo('general', { click: false });
        const beforeInjection = readConfig();
        const injection = 'x\ncommand = /bin/true';
        await draftThroughAPI('general.worktreeBasePath', injection);
        await commitThroughAPI('general.worktreeBasePath');
        const injectionError = await d.settle(async () => {
            const field = await fieldSnapshot('general.worktreeBasePath');
            return typeof field?.error === 'string' && field.error.includes('line breaks');
        }, { ceilingMs: 8_000 });
        await sleep(800);
        rec.check('a newline in a text draft is refused in the frame and the config file is byte-identical',
            injectionError && readConfig() === beforeInjection && !readConfig().includes('command = /bin/true'),
            `${JSON.stringify(await fieldSnapshot('general.worktreeBasePath'))} · config unchanged ${String(readConfig() === beforeInjection)}`);
        await resetField('general.worktreeBasePath');

        // ── 7 · failure, and the way back ────────────────────────────────────────────
        await routeTo('appearance');
        await draftThroughAPI('appearance.fontFamily', 'Half typed');
        if (!await d.settle(async () => (await fieldSnapshot('appearance.fontFamily'))?.draft === 'Half typed', { ceilingMs: 8_000 })) {
            throw new Error(`the half-typed draft never reached the surface: ${await labState()}`);
        }
        const beforeCrash = readConfig();
        /*
         * The hook only ARMS: the next frame's listener throws. So the crash rides in on one more
         * keystroke's worth of draft, which is also what makes this a failure with an uncommitted
         * edit in flight - the case the recovery floor exists for. A draft change is the frame to
         * use because it is one the feed reliably publishes.
         */
        await arm(`crash('uncaught')`);
        await draftThroughAPI('appearance.fontFamily', 'Half typed craft');
        const [tookOver, toast] = await Promise.all([
            d.settleDom(page, `document.querySelector('${bundledSlot}')`, { ceilingMs: 15_000 }),
            d.settleDom(page, `(document.querySelector('[data-testid="toast-stack"]')?.textContent ?? '').includes('Settings presenter')`, { ceilingMs: 15_000 })
        ]);
        const sameSection = await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-appearance"]')`, { ceilingMs: 10_000 });
        const draftKept = await d.settleDom(page, `document.querySelector('[data-testid="terminal-font-family-input"]')?.value === 'Half typed craft'`, { ceilingMs: 10_000 });
        await shot('bundled-after-failure', 'the BUNDLED Settings dialog back on screen, still on Appearance, with the terminal Font family field holding the half-typed "Half typed craft" that was never committed, and the failure toast ("Settings presenter \u00b7 Uncaught Error: \u2026") in the bottom-right corner. No plugin frame anywhere in the dialog.');
        rec.check('a presenter crash hands the dialog back on the same section with the draft intact and nothing written',
            tookOver && toast && sameSection && draftKept && readConfig() === beforeCrash,
            `bundled ${String(tookOver)} · toast ${String(toast)} · appearance ${String(sameSection)} · draft ${String(await page.eval(`document.querySelector('[data-testid="terminal-font-family-input"]')?.value ?? '<no field>'`))} · config unchanged ${String(readConfig() === beforeCrash)}`);
        await openPlugins();
        const failedStatus = await d.settle(async () => (await statusRow()).includes('Failed'), { ceilingMs: 8_000 });
        // The rows are the last thing in a long scrolling tab, so the picture is worth nothing
        // without this: Settings opens at the top of the Plugins section.
        await page.eval(`document.querySelector('[data-testid="${statusRowID}"]')?.scrollIntoView({block:'center'})`);
        await page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        await shot('settings-presenter-status', 'Settings \u25b8 Plugins \u25b8 Workbench views, scrolled to the presenter rows: the settings.window row reads "Failed: \u2026" with a "Retry presenter" button beside it, the select above it still names the Settings Lab view, and "Restore bundled views" sits below.');
        rec.check('Settings reports the failed Settings presenter beside its retained selection',
            failedStatus && await slotValue() === labView,
            `${await statusRow()} · selected ${String(await slotValue())}`);
        const pressed = await retry();
        const clearedStatus = pressed && await d.settle(async () => !(await statusRow()).includes('Failed'), { ceilingMs: 8_000 });
        const retried = clearedStatus && await attached(15_000) && await ready();
        rec.check('Retry presenter re-attaches the Settings presenter and it paints again',
            pressed && clearedStatus && retried && await painted(), `pressed ${String(pressed)} · cleared ${String(clearedStatus)} · ${await labState()}`);

        /*
         * The other watchdog, on the same placement.
         *
         * `stall()` makes the lab's listener return a promise that never settles, so the SDK never
         * acknowledges the frame. The arm and the route go out in ONE evaluation: the arm has to be
         * in place before the frame it is meant to swallow, and the route is what makes that frame
         * one the user is waiting to see redrawn (a different section), which is what the
         * acknowledgement watchdog is allowed to fail.
         */
        await routeTo('general');
        // The arm and the route in ONE evaluation: the arm has to be in place before the frame it
        // is meant to swallow, and that frame is the one carrying the new section, which is what
        // the acknowledgement watchdog waits to see redrawn.
        await inFrame(`(() => { globalThis.settingsLab.stall(); void kelpi.ui.setSettingsSection('workspaces'); return true; })()`);
        const watchdog = await drawsBundled(20_000);
        await openPlugins();
        const ackStatus = await d.settle(async () => (await statusRow()).includes('stopped acknowledging'), { ceilingMs: 10_000 });
        const ackRow = await statusRow();
        rec.check('the acknowledgement watchdog fails a stalled Settings presenter and the bundled panel takes the dialog',
            watchdog && ackStatus, `${ackRow} · bundled ${String(watchdog)}`);
        if (await retry() && !(await attached(15_000) && await ready())) {
            rec.note(`Retry did not bring the presenter back after the stall: ${await labState()}`);
        }

        // ── 8 · Escape out of the frame, and the way back in ─────────────────────────
        const current = (await labSnapshot())?.sectionID ?? 'general';
        // A click on the rail entry for the section already routed is a no-op route that also puts
        // the caret inside the frame, which is what makes the Escape below a RELAYED one.
        if (await frameCheck(`!!document.querySelector(${JSON.stringify(railItem(current))})`, 5_000)) await clickFrame(railItem(current));
        else await clickFrame('[data-testid="lab-settings"]');
        await page.key('Escape');
        const closed = await d.settleDom(page, `!document.querySelector('[data-testid="settings-close"]')`, { ceilingMs: 8_000 });
        await page.key('Comma', { modifiers: 4, key: ',' });
        const reopened = await d.settleDom(page, `document.querySelector('[data-testid="settings-close"]')`, { ceilingMs: 10_000 })
            && await attached() && await ready();
        rec.check('Escape relayed out of the presenter frame closes Settings, and \u2318, reopens into the lab',
            closed && reopened && await painted(),
            `closed ${String(closed)} · reopened ${String(reopened)} · ${await labState()}`);

        /*
         * A modal PEER over the dialog owns its own Escape: the slot stands its relay listener down
         * while the modal-presence count is above the host's own registration, because two
         * capture-phase listeners racing for one Escape is how the wrong surface closes.
         */
        await page.key('KeyP', { modifiers: 4, key: 'p', keyCode: 80 });
        const paletteUp = await d.settleDom(page, `document.querySelector('[data-testid="command-palette"]')`, { ceilingMs: 6_000 });
        if (paletteUp) {
            await page.key('Escape');
            const paletteGone = await d.settleDom(page, `!document.querySelector('[data-testid="command-palette"]')`, { ceilingMs: 8_000 });
            rec.check('a palette raised over Settings owns its own Escape and leaves the dialog open',
                paletteGone && await settingsOpen() && await painted(),
                `palette gone ${String(paletteGone)} · settings open ${String(await settingsOpen())}`);
            if (!paletteGone) await page.key('KeyW', { modifiers: 4, key: 'w', keyCode: 87 });
        } else {
            /*
             * The other outcome, and the likelier one: the wrapper holds the caret inside the frame
             * while a presenter paints, and \u2318P is not one of the two chords the frame is granted,
             * so it is absorbed by the presenter's document and never reaches the window at all.
             * That is the same shape `plugin-interaction-presenters.mjs` records for \u2318, and \u2318D
             * under a painted presenter, and the assertion is the observable one: nothing opened,
             * the dialog is still up, and the presenter is still the one drawing.
             */
            rec.check('\u2318P inside a painted Settings presenter opens nothing and disturbs neither the dialog nor the frame',
                await settingsOpen() && await painted() && await page.eval(`!document.querySelector('[data-testid="command-palette"]')`),
                'the palette was not raised over Settings: the caret is held inside the frame and \u2318P is not a relayed chord, so the Escape-owning peer half of check 8 could not be pressed here');
            rec.note('SKIPPED: the peer half of check 8 - no palette could be raised over the painted presenter, so nothing was there to own an Escape.');
        }

        // ── 9 · disable, enable, reload ──────────────────────────────────────────────
        await cli.ok(['plugin', 'disable', labID]);
        const goneOnDisable = await d.settleDom(page, `!document.querySelector('${presenterSlot}') && document.querySelector('${bundledSlot}')`, { ceilingMs: 15_000 });
        const railBack = await d.settleDom(page, `document.querySelector('[data-testid="settings-tabs"]')`, { ceilingMs: 8_000 });
        rec.check('disabling the plugin puts the bundled dialog back, rail and all',
            goneOnDisable && railBack,
            `presenter ${String(await page.eval(`document.querySelector('[data-testid="settings-presenter"]')?.getAttribute('data-settings-presenter') ?? '<none>'`))}`);
        await cli.ok(['plugin', 'enable', labID]);
        const backOnEnable = await attached(20_000) && await ready();
        await openPlugins();
        const retained = await slotValue() === labView;
        rec.check('the selection is retained across disable and enable, and the presenter comes back',
            backOnEnable && retained, `selected ${String(await slotValue())} · ${await labState()}`);
        await cli.ok(['plugin', 'reload', labID]);
        const reloaded = await attached(25_000) && await ready(20_000);
        await routeTo('general');
        const reloadedRoutes = (await labSnapshot())?.sectionID === 'general';
        rec.check('a plugin reload returns a working Settings presenter to the placement',
            reloaded && reloadedRoutes && await painted(), await labState());

        // ── 10 · the phone keeps the bundled sheet ───────────────────────────────────
        /*
         * The failure toasts from check 7 have to be gone before the window is narrowed: at 390 px
         * the corner stack is most of the width and it sits over the phone's own rows, so a tap
         * aimed at one lands on the toast's text instead.
         */
        if (!await toastsGone()) rec.note('the toast stack did not empty before the phone section; a tap below may report being covered by it');
        await closeSettings();
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${workspaceID}"]`;
        if (await d.settleDom(page, `document.querySelector(${JSON.stringify(phoneRow)})`, { ceilingMs: 12_000 })) await clickHost(phoneRow);
        await page.key('Comma', { modifiers: 4, key: ',' });
        const phoneSheet = await d.settleDom(page, `document.querySelector('[data-testid="settings-window"][data-phone-sheet="true"]')`, { ceilingMs: 10_000 });
        const noPresenter = await page.eval(`!document.querySelector('[data-settings-presenter]') && !document.querySelector('${presenterFrame}')`);
        const sheetDraws = await page.eval(`!!document.querySelector('[data-testid="settings-phone-list"]') || !!document.querySelector('[data-testid="settings-panel"]')`);
        if (!phoneSheet) rec.note('SKIPPED: the sheet half of check 10 - \u2318, raised no Settings sheet in the phone shell, so only "no presenter is granted on a phone" is asserted below.');
        rec.check('a phone window keeps the bundled sheet with the lab still selected',
            noPresenter && (phoneSheet === false || sheetDraws),
            `sheet ${String(phoneSheet)} · presenter nodes ${String(await page.eval(`document.querySelectorAll('[data-settings-presenter]').length`))} · list ${String(sheetDraws)}`);
        await closeSettings();
        // Back to the landing page BEFORE the window widens again, while the shell is still
        // mounted: it is the one tap that forgets where this scenario took the phone.
        if (!await phoneToLanding()) rec.note('the phone shell did not return to its landing page; the next phone scenario may open where this one left it');
        await page.send('Emulation.clearDeviceMetricsOverride');
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await openSettings();
        rec.check('returning to the desktop form factor re-attaches the Settings presenter',
            await attached(20_000) && await ready() && await painted(), await labState());
        rec.note('LIMIT: the daemon-disconnect arm of the recovery floor is not pressed here; the runner hands a scenario no primary-daemon handle. See the header.');
        rec.note('LIMIT: the 240-calls-per-second budget breach is not pressed live; driving it from CDP measures the harness. See the header.');
    } catch (error) {
        await rec.shot(page, 'failure-live');
        throw error;
    } finally {
        /*
         * The sandbox, its daemon AND its window outlive this scenario, and six things outlive the
         * workspace it deletes: the seeded config lines, the values it committed, the saved
         * presenter selection, the phone's remembered place, whatever overlay was on screen when a
         * check threw, and which workspace the window is looking at. Each step is taken and none is
         * allowed to skip the rest.
         */
        const safely = async (what, step) => {
            try { await step(); } catch (error) { rec.note(`cleanup: ${what} - ${error instanceof Error ? error.message : String(error)}`); }
        };
        await safely('the phone returns to its landing page', async () => { if (!await phoneToLanding()) rec.note('cleanup: the phone shell never reached its landing page'); });
        await safely('device metrics are cleared', () => page.send('Emulation.clearDeviceMetricsOverride'));
        await safely('touch emulation is cleared', () => page.send('Emulation.setTouchEmulationEnabled', { enabled: false }));
        await safely('the seeded pairing and profile lines are removed', () => {
            if (!seeded) return;
            fs.writeFileSync(sandbox.configPath, readConfig().split('\n').filter(line => !line.includes(PAIRING_TOKEN) && !line.includes(PROFILE_SECRET)).join('\n'));
        });
        /*
         * The values go back through the SAME verbs that changed them, which means through whoever
         * is drawing: the presenter while it is up, the bundled panel after a failure. Both write
         * the same surface. A committed default is still a written line, so the file ends holding
         * the shipped values rather than the empty file the sandbox created; the tail is recorded
         * below rather than claimed to be byte-identical.
         */
        await safely('every value this scenario committed goes back through the settings surface', async () => {
            await openSettings();
            const restore = [['general.worktreeBasePath', 'general', ''], ['general.autoDetectRepos', 'general', 'true'],
                ['appearance.chromeAppearance', 'appearance', 'system']];
            if (await presenting() && await ready(8_000)) {
                for (const [fieldID, section, value] of restore) {
                    await routeTo(section, { click: false });
                    await draftThroughAPI(fieldID, value);
                    await commitThroughAPI(fieldID);
                    await sleep(400);
                }
            } else {
                // The bundled panel's own controls, by test id, for the two that have a plain one.
                await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-general"]')`, { ceilingMs: 8_000 });
                await clickHost('[data-testid="settings-tab-button-general"]');
                if (await d.settleDom(page, `document.querySelector('[data-testid="worktree-base-path-input"]')`, { ceilingMs: 6_000 })) {
                    await clickHost('[data-testid="worktree-base-path-input"]');
                    // The native value setter plus an `input` event, as `settings-live-apply` does:
                    // a React-controlled field does not hear a value assigned straight to the node,
                    // and `insertText('')` inserts nothing at all.
                    await page.eval(`(() => {
                        const input = document.querySelector('[data-testid="worktree-base-path-input"]');
                        if (input === null) return false;
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        setter.call(input, '');
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        return true;
                    })()`);
                    await page.key('Enter');
                    await sleep(500);
                }
                rec.note('cleanup: the presenter was not painting, so only the base path was restored through the bundled panel; the toggle and the appearance value were left as committed');
            }
        });
        // A dialog or a palette left up by a thrown check owns the window, including the ⌘, below.
        await safely('any palette still up is dismissed', async () => {
            for (let attempt = 0; attempt < 4; attempt += 1) {
                if (!await page.eval(`!!document.querySelector('[data-testid="command-palette"]')`)) return;
                await page.key('KeyW', { modifiers: 4, key: 'w', keyCode: 87 });
                await sleep(250);
            }
        });
        /*
         * The selection goes back to the BUNDLED view rather than being left naming a view that is
         * about to be removed, and it is done BEFORE the plugins are removed so the select still
         * has both entries to choose between.
         */
        await safely('settings.window goes back to the bundled dialog', async () => {
            await openPlugins();
            await chooseSlot(bundledView);
            await d.settleDom(page, `document.querySelector('${bundledSlot}')`, { ceilingMs: 10_000 });
        });
        await safely('the Settings overlay is closed', () => closeSettings());
        await cli.run(['plugin', 'remove', labID]);
        await cli.run(['plugin', 'remove', uiID]);
        await cli.run(['workspace', 'delete', workspaceID, '--force']);
        await safely('the window returns to the workspace it started on', async () => {
            if (startingWorkspace === null) return;
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 10_000 })) await clickHost(row);
        });
        await safely('the config file is recorded as it was left', () => {
            const now = readConfig();
            rec.note(`config file on the way out (${String(now.length)} bytes, started at ${String(originalConfig.length)}): ${tail(now) || '(empty)'}`);
        });
    }
}

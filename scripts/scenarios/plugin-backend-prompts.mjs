/**
 * #389: a plugin BACKEND asks through the window that ran its command, against a real window.
 *
 * The unit suites pin the daemon's routing, the client bridge and the SDK each on their own. What
 * only a real window can answer is whether a chord pressed in that window reaches the backend with
 * the window on its context, whether the prompt the backend raises comes back to THAT window and is
 * drawn there, whether the answer gets back to the backend, and whether a command held open by a
 * person still answers after its 30 second clock. So this scenario presses all of it, with the
 * Interaction Lab example's one command (`example.interaction-lab.ask`, bound to ctrl+alt+i):
 *
 *   1. the example installs with `--trust` and is listed enabled, its backend on demand;
 *   2. the shortcut raises the bundled dialog "Run it?", owned by "Interaction Lab" with no plugin
 *      id anywhere in it, and Run closes it and comes back as the notification "Interaction Lab: run";
 *   3. Escape on the same dialog comes back as "Interaction Lab: cancelled" (null);
 *   4. `kelpi plugin run` of the same command has no window, exits non-zero and prints NO_WINDOW;
 *   5. disabling the plugin with the dialog up closes it with nothing chosen and no notification;
 *   6. with `example.interaction-lab.prompts` selected for `interaction.prompts`, the backend's
 *      dialog is drawn INSIDE the lab's own iframe, owner "Interaction Lab" and no plugin id in the
 *      frame, and Run answered from inside the frame reaches the backend;
 *   7. a dialog held open for 35 seconds still answers `run`, and no "timed out" toast appears in
 *      the meantime: the command's own timer waits for a prompt it showed (the daemon's hold and the
 *      runner's exemption, end to end);
 *   8. the plugins are removed and the window is left on the bundled presenters it started with.
 *
 * Steps 2, 3, 5, 6 and 7 are run twice. Once as above, through the shortcut, which is the promise
 * the example makes. And once through a probe plugin this scenario writes into the sandbox, whose
 * command passes `{ windowID }` explicitly (the documented `target` argument) and is run with
 * `kelpi plugin run --args`, so the window routing, the client bridge, both presenters, the
 * withdrawal on disable and the command timer hold are proven even when the shortcut path is not.
 * The probe's command is a real `command:` invocation, so its return value comes back on the CLI:
 * the hold is proven by `run` arriving after the 30 second clock with exit 0. The CLI reads that
 * reply with a 35 second ceiling of its own (`cli/src/commands/plugin.ts`), so the probe holds its
 * dialog 31.5 seconds from the call rather than 35, and it fires its notification without awaiting
 * it: a notification's promise settles when its card goes, ten seconds on
 * (`interaction/contract.ts` notificationMs), which would carry the reply past that ceiling.
 *
 * ── What it depends on ──────────────────────────────────────────────────────────────
 *
 * `examples/plugins/interaction-lab` (plain JS, no build): `backend.mjs` shows the dialog
 * `{ title: 'Run it?', cancelID: 'cancel', actions: cancel / run }` and then a notification naming
 * the answer, `Interaction Lab: <action>` or `Interaction Lab: cancelled`. The prompts view is read
 * as `plugin-interaction-presenters.mjs` reads it: `document.body.dataset.ready`, the snapshot on
 * `globalThis.interactionLab`, and the test ids `lab-prompt`, `lab-prompt-owner` and
 * `lab-prompt-action` with `data-action-id`. The bundled dialog, the notification stack and the
 * native toasts are read by the host's own test ids (`plugin-ui-dialog`, `plugin-ui-notification`,
 * `toast-stack`). The window's own id is the `shellWindow` query parameter of its page.
 *
 * The chord is pressed over CDP with `code: 'KeyI'` and ctrl+alt, because the window's plugin
 * shortcut dispatcher matches on `event.code` and the modifier bits (`content/bridge.ts` chordKey).
 * Whether the dispatcher CLAIMED a press is read from the page (the event's `defaultPrevented` after
 * dispatch), so a press is retried only when nothing took it and a slow first activation of the
 * on-demand backend is never mistaken for a missed key and pressed twice. A claimed press whose
 * command fails shows the window's own toast (`plugins/commands.ts`), so a NO_WINDOW refusal is read
 * from there and ends the wait at once.
 *
 * Screenshots are blank in the `hidden` lane (the recorder says so in its own note); every check
 * here is a DOM/CLI assertion, and none of them measures a pixel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The example whose command this presses, the client bridge that presents its prompts, the daemon
 * module that routes and holds them, the runner that exempts them from the per-call timer, and the
 * SDK that sends them.
 */
export const covers = ['examples/plugins/interaction-lab/', 'packages/client/src/interaction/backend-prompts.ts', 'packages/daemon/src/plugins/prompts.ts', 'packages/daemon/src/plugins/runner.mjs', 'packages/plugin-sdk/api.js'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const labID = 'example.interaction-lab';
const labCommand = `${labID}.ask`;
const labPath = path.join(repoRoot, 'examples/plugins/interaction-lab');
const probeID = 'scenario.prompt-probe';
const probeCommand = `${probeID}.ask`;
const promptsView = `${labID}.prompts`;
const promptsSlot = `[data-interaction-presenter="${promptsView}"]`;
const promptsFrame = `${promptsSlot} iframe`;
const bundledPrompts = '[data-testid="interaction-presenter-prompts"][data-interaction-presenter="bundled"]';
const modal = '[data-testid="plugin-ui-dialog"]';
const bundledDialog = `${bundledPrompts} ${modal}`;
const notice = '[data-testid="plugin-ui-notification"]';

/**
 * The probe: Interaction Lab's command, but asking in the window its caller names, and returning
 * the answer without waiting on its notification (whose promise settles only when the card goes).
 */
const PROBE_MANIFEST = {
    id: probeID, name: 'Prompt Probe', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'on-demand', backend: 'backend.mjs',
    contributes: { commands: [{ id: probeCommand, title: 'Prompt Probe: Ask with an explicit window' }] }
};
const PROBE_BACKEND = `export function activate(api) {
    api.commands.register(${JSON.stringify(probeCommand)}, async (args) => {
        const target = typeof args?.windowID === 'string' ? { windowID: args.windowID } : undefined;
        const action = await api.ui.showDialog({
            title: 'Run it?', message: 'Prompt Probe asks in the window it was told.', cancelID: 'cancel',
            actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'run', label: 'Run', kind: 'primary' }],
        }, target);
        api.ui.showNotification({ message: action === null ? 'Prompt Probe: cancelled' : 'Prompt Probe: ' + action, tone: 'info' }, target).catch(() => null);
        return action;
    });
}
`;

/**
 * Counts presses of ctrl+alt+KeyI that reached the page and how many of them something claimed.
 * Read after the dispatch has finished, so it does not matter where this listener sits relative to
 * the plugin dispatcher's own, which is re-registered whenever the bindings change.
 */
const CHORD_PROBE = `(() => {
    if (globalThis.__labChord === undefined) {
        globalThis.__labChord = { presses: 0, claimed: 0 };
        window.addEventListener('keydown', event => {
            if (event.code !== 'KeyI' || !event.ctrlKey || !event.altKey) return;
            globalThis.__labChord.presses += 1;
            setTimeout(() => { if (event.defaultPrevented) globalThis.__labChord.claimed += 1; }, 0);
        }, true);
    }
    return JSON.stringify(globalThis.__labChord);
})()`;
/** Every distinct text the native toast stack showed, sampled every 100 ms: a toast lives six seconds. */
const TOAST_LOG = `(() => {
    if (globalThis.__toastLog === undefined) {
        globalThis.__toastLog = [];
        globalThis.__toastTimer = setInterval(() => {
            for (const node of document.querySelectorAll('[data-testid="toast-stack"] > *')) {
                const text = (node.textContent ?? '').trim();
                if (text && !globalThis.__toastLog.includes(text)) globalThis.__toastLog.push(text);
            }
        }, 100);
    }
    return true;
})()`;

export default async function ({ page, cli, rec, d, sleep, sandbox }) {
    if (!fs.existsSync(path.join(labPath, 'backend.mjs'))) {
        throw new Error(`interaction-lab has no backend in this checkout (${labPath}); #389 has to land before this scenario can run`);
    }
    await page.watchFrames();
    const json = async args => JSON.parse(await cli.ok(args));
    const describe = error => (error instanceof Error ? error.message : String(error));

    // ── the instruments ─────────────────────────────────────────────────────────────
    const inFrame = (selector, expression) => page.evalInFrame(selector, expression);
    const frameCheck = (selector, expression, ceilingMs = 12_000) => d.settle(async () => {
        try { return Boolean(await inFrame(selector, expression)); } catch { return false; }
    }, { ceilingMs });
    const labState = async () => {
        try {
            return await inFrame(promptsFrame, `JSON.stringify({ ready: document.body.dataset.ready ?? null, lastError: globalThis.interactionLab?.lastError ?? null, snapshot: globalThis.interactionLab?.snapshot ?? null })`);
        } catch (error) { return `frame unreadable: ${describe(error)}`; }
    };
    const pluginEntry = async id => (await json(['plugin', 'list', '--json'])).find(plugin => plugin.manifest?.id === id) ?? null;
    const bundledUp = () => page.eval(`document.querySelector('${bundledDialog}')?.getBoundingClientRect().width > 0`);
    const presenterUp = async () => {
        try { return Boolean(await inFrame(promptsFrame, `document.querySelector('[data-testid="lab-prompt-action"][data-action-id="run"]') !== null`)); } catch { return false; }
    };
    const dialogGone = (ceilingMs = 6_000) => d.settleDom(page, `document.querySelector('${modal}') === null`, { ceilingMs });
    /** What the bundled dialog shows: its owner line, its title, its message and its buttons. */
    const dialogInfo = async pluginID => JSON.parse(String(await page.eval(`(() => {
        const node = document.querySelector('${bundledDialog}');
        if (node === null) return 'null';
        const lines = [...node.querySelectorAll('p')].map(p => (p.textContent ?? '').trim());
        return JSON.stringify({ requestID: node.getAttribute('data-request-id'), owner: lines[0] ?? null, title: (node.querySelector('h2')?.textContent ?? '').trim(),
            message: lines[1] ?? null, buttons: [...node.querySelectorAll('button')].map(button => (button.textContent ?? '').trim()),
            pluginIDShown: node.outerHTML.includes(${JSON.stringify(pluginID)}) });
    })()`)));
    const notices = async () => JSON.parse(String(await page.eval(`JSON.stringify([...document.querySelectorAll('${notice}')].map(card => {
        const lines = [...card.querySelectorAll('p')].map(p => (p.textContent ?? '').trim());
        return { requestID: card.getAttribute('data-request-id'), owner: lines[0] ?? null, message: lines[1] ?? null };
    }))`)));
    const noticeSays = (message, ceilingMs = 8_000) => d.settle(async () => (await notices()).some(card => card.message === message), { ceilingMs });
    /**
     * Dismissed through the cards' own buttons: this is housekeeping between steps, not an assertion.
     * The window's toasts go too (a toast is its own dismiss button), because a failed command's
     * toast (`plugins/commands.ts`) has no expiry and would otherwise show up in every later step.
     */
    const clearNotices = async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const left = Number(await page.eval(`(() => {
                for (const button of document.querySelectorAll('${notice} button[aria-label="Dismiss notification"]')) button.click();
                for (const toast of document.querySelectorAll('[data-testid="toast-stack"] > button')) toast.click();
                return document.querySelectorAll('${notice}').length;
            })()`));
            if (left === 0) return true;
            await sleep(250);
        }
        return false;
    };
    const toasts = async () => JSON.parse(String(await page.eval(`JSON.stringify(globalThis.__toastLog ?? [])`)));
    const resetToasts = () => page.eval(`(() => { globalThis.__toastLog = []; return true; })()`);
    /** Click a button in the bundled dialog by its visible label, aim-checked first. */
    const clickModalButton = async label => {
        const aim = JSON.parse(String(await page.eval(`(() => {
            const buttons = [...document.querySelectorAll('${bundledDialog} button')];
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
    /** Click a control inside the presenter iframe, aim-checked against the host page first. */
    const clickFrame = async (frame, target) => {
        if (!await frameCheck(frame, `(() => { const node = document.querySelector(${JSON.stringify(target)}); return node && !node.disabled; })()`)) {
            throw new Error(`Missing or disabled ${target} in ${frame}: ${await labState()}`);
        }
        const inner = await inFrame(frame, `(() => { const node = document.querySelector(${JSON.stringify(target)}); node.scrollIntoView({block:'center',inline:'center'}); const box = node.getBoundingClientRect(); return {x:box.x + box.width/2, y:box.y + box.height/2, width:box.width, height:box.height}; })()`);
        await page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        const outer = await page.box(frame);
        if (!outer || !inner.width || !inner.height) throw new Error(`no visible ${target} in ${frame}`);
        const point = { x: outer.x + inner.x, y: outer.y + inner.y };
        const hit = await page.eval(`(() => {
            const node = document.elementFromPoint(${point.x}, ${point.y});
            if (node === null) return 'nothing';
            const frame = document.querySelector(${JSON.stringify(frame)});
            return node === frame || frame?.contains(node) ? 'frame' : (node.outerHTML ?? node.nodeName).slice(0, 160);
        })()`);
        if (hit !== 'frame') throw new Error(`${target} in ${frame} is covered at ${JSON.stringify(point)}: ${String(hit)}`);
        await page.clickAt(point.x, point.y);
    };
    const openPlugins = async () => {
        await page.key('Comma', { modifiers: d.MOD.meta, key: ',' });
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`);
        await page.click('[data-testid="settings-tab-button-plugins"]');
        await d.settleDom(page, `document.querySelector('[data-testid="plugin-placements"]')`);
    };
    const closeSettings = async () => {
        await page.click('[data-testid="settings-close"]');
        await d.settleDom(page, `!document.querySelector('[data-testid="settings-close"]')`);
    };
    const chooseSlot = (slot, viewID) => page.eval(`(() => {
        const select = document.querySelector('select[aria-label="${slot}"]');
        if (select === null) return false;
        select.value = ${JSON.stringify(viewID)};
        select.dispatchEvent(new Event('change', {bubbles:true}));
        return select.value === ${JSON.stringify(viewID)};
    })()`);
    const shot = async (label, eyes) => {
        const file = await rec.shot(page, label);
        rec.note(`EYES ${path.basename(file)}: ${eyes}`);
        return file;
    };

    // Where the window was before this scenario took it: restored at the end, because the sandbox
    // and its window are shared with whatever runs next.
    const startingWorkspace = await page.eval(`document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.getAttribute('data-workspace-id') ?? null`);
    const shellWindowID = await page.eval(`new URLSearchParams(location.search).get('shellWindow')`);
    rec.note(`this window's shell window id (the ?shellWindow= parameter): ${String(shellWindowID)}`);
    const workspace = await json(['workspace', 'create', '--name', 'Backend prompts', '--json']);
    const workspaceID = workspace.workspace_id;
    const shellPane = (await json(['pane', 'list', '--workspace', workspaceID, '--json']))[0].id;
    if (!await d.settleDom(page, `document.querySelector('[data-testid="pane-body-${shellPane}"]')?.getBoundingClientRect().width > 0`, { ceilingMs: 8_000 })) {
        const row = `[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]`;
        if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 5_000 })) await page.click(row);
        if (!await d.settleDom(page, `document.querySelector('[data-testid="pane-body-${shellPane}"]')?.getBoundingClientRect().width > 0`, { ceilingMs: 8_000 })) {
            throw new Error(`the new workspace's shell pane ${shellPane} never drew in the window`);
        }
    }
    await page.eval(TOAST_LOG);

    /**
     * Focus the shell pane and press ctrl+alt+i, retried only while nothing in the page claims the
     * chord (a window standing down behind the tail of a closed request, or a plugin list that has
     * not caught up after an enable). Returns how many presses it took, or 0 when none was claimed.
     */
    const pressAsk = async () => {
        for (let attempt = 1; attempt <= 4; attempt += 1) {
            const before = JSON.parse(String(await page.eval(CHORD_PROBE)));
            await d.focusPaneBody(page, shellPane);
            await page.key('KeyI', { modifiers: d.MOD.ctrl | d.MOD.alt, key: 'i', keyCode: 73 });
            const claimed = await d.settle(async () => JSON.parse(String(await page.eval(CHORD_PROBE))).claimed > before.claimed, { ceilingMs: 600 });
            if (claimed) return attempt;
            rec.note(`ctrl+alt+i press ${String(attempt)} was not claimed: ${String(await page.eval(CHORD_PROBE))}`);
            await sleep(700);
        }
        return 0;
    };
    /** Wait for the prompt to be drawn, for the window's NO_WINDOW toast, or for the call to settle. */
    const drawnOrRefused = async (drawn, call, ceilingMs = 15_000) => {
        const deadline = Date.now() + ceilingMs;
        while (Date.now() < deadline) {
            if (await drawn()) return 'drawn';
            if ((await toasts()).some(text => text.includes('NO_WINDOW'))) return 'refused';
            if (call?.settled) return 'settled';
            await sleep(100);
        }
        return 'nothing';
    };

    /**
     * The two ways a prompt is raised. Each returns whether it was drawn, a detail for the check,
     * and (for the probe) the CLI call that carries the command's return value.
     */
    const subjects = [
        {
            key: 'shortcut', via: 'ctrl+alt+i', pluginID: labID, owner: 'Interaction Lab',
            raise: async drawn => {
                await resetToasts();
                const presses = await pressAsk();
                const outcome = presses === 0 ? 'unclaimed' : await drawnOrRefused(drawn, null);
                return { drawn: outcome === 'drawn', call: null, startedAt: Date.now(), detail: `presses ${String(presses)} · ${outcome} · toasts ${JSON.stringify(await toasts())}` };
            }
        },
        {
            key: 'probe', via: 'kelpi plugin run with { windowID }', pluginID: probeID, owner: 'Prompt Probe',
            raise: async drawn => {
                await resetToasts();
                const startedAt = Date.now();
                const call = { settled: false, result: null, promise: null };
                call.promise = cli.run(['plugin', 'run', probeCommand, '--args', JSON.stringify({ windowID: shellWindowID })], { timeoutMs: 90_000 })
                    .then(result => { call.settled = true; call.result = result; return result; });
                const outcome = await drawnOrRefused(drawn, call);
                return { drawn: outcome === 'drawn', call, startedAt, detail: `${outcome}${call.settled ? ` · cli exit ${String(call.result.code)} ${call.result.stderr.trim()} ${call.result.stdout.trim()}` : ''} · toasts ${JSON.stringify(await toasts())}` };
            }
        }
    ];
    /** The command's return value as the CLI printed it, for the probe; null for the shortcut. */
    const returned = async raised => {
        if (raised.call === null) return null;
        const result = await raised.call.promise;
        return { code: result.code, value: result.stdout.trim(), stderr: result.stderr.trim(), ms: Date.now() - raised.startedAt };
    };
    const returnedValue = (value, want) => value === null || (value.code === 0 && value.value === JSON.stringify(want));

    /**
     * Run one numbered step; a throw inside it is a failed check of its own, and whatever request it
     * left up is cancelled, so the next step starts from a clear window.
     */
    const step = async (name, body) => {
        try { await body(); } catch (error) {
            rec.check(`${name}: ran to completion`, false, describe(error));
            await rec.shot(page, `failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => null);
            for (let attempt = 0; attempt < 3; attempt += 1) {
                if (!await page.eval(`!!document.querySelector('[data-testid="plugin-ui-backdrop"]:not([hidden])') || !!document.querySelector('${promptsSlot}:not([hidden])')`)) break;
                await page.key('Escape');
                await sleep(300);
            }
            await clearNotices();
        }
    };
    let presenterSelected = false;
    const selectPresenter = async viewID => {
        await openPlugins();
        const chosen = await chooseSlot('interaction.prompts', viewID);
        await closeSettings();
        return chosen === true;
    };

    // ── the steps every subject runs ─────────────────────────────────────────────────
    const tag = subject => (subject.key === 'shortcut' ? '' : ` [probe: ${subject.via}]`);

    const runAnswer = (subject, n) => step(`${n} ${subject.key} Run`, async () => {
        await clearNotices();
        const raised = await subject.raise(bundledUp);
        const info = raised.drawn ? await dialogInfo(subject.pluginID) : null;
        rec.check(`${subject.via} raises the backend's bundled dialog "Run it?" owned by "${subject.owner}", with no plugin id in it${tag(subject)}`,
            raised.drawn && info?.title === 'Run it?' && info.owner === subject.owner && info.pluginIDShown === false
            && info.buttons.includes('Run') && info.buttons.includes('Cancel'),
            `${raised.detail} · dialog ${JSON.stringify(info)}`);
        if (!raised.drawn) return;
        await shot(`backend-dialog-bundled-${subject.key}`, `the bundled dialog over the pane grid: a "${subject.owner}" owner line above the title "Run it?", the message, and Cancel and Run buttons; no plugin id anywhere.`);
        await clickModalButton('Run');
        const closed = await dialogGone();
        const said = await noticeSays(`${subject.owner}: run`);
        const cards = await notices();
        const value = await returned(raised);
        rec.check(`clicking Run closes the dialog and the backend's notification reports "run"${tag(subject)}`,
            closed && said && cards.some(card => card.message === `${subject.owner}: run` && card.owner === subject.owner) && returnedValue(value, 'run'),
            `closed ${String(closed)} · notices ${JSON.stringify(cards)} · command returned ${JSON.stringify(value)} · toasts ${JSON.stringify(await toasts())}`);
    });

    const runEscape = (subject, n) => step(`${n} ${subject.key} Escape`, async () => {
        await clearNotices();
        const raised = await subject.raise(bundledUp);
        if (!raised.drawn) {
            rec.check(`Escape closes the dialog and the backend's notification reports it cancelled (null)${tag(subject)}`, false, `no dialog to press Escape on: ${raised.detail}`);
            return;
        }
        await page.key('Escape');
        const closed = await dialogGone();
        const said = await noticeSays(`${subject.owner}: cancelled`);
        const value = await returned(raised);
        rec.check(`Escape closes the dialog and the backend's notification reports it cancelled (null)${tag(subject)}`,
            closed && said && returnedValue(value, null), `closed ${String(closed)} · notices ${JSON.stringify(await notices())} · command returned ${JSON.stringify(value)}`);
    });

    const runDisable = (subject, n) => step(`${n} ${subject.key} disable`, async () => {
        await clearNotices();
        const raised = await subject.raise(bundledUp);
        if (raised.drawn) {
            const disabled = await cli.run(['plugin', 'disable', subject.pluginID]);
            const closed = await dialogGone(8_000);
            await sleep(3_000);
            const cards = await notices();
            const value = await returned(raised);
            rec.check(`disabling the plugin while its dialog is open closes it with nothing chosen and no notification${tag(subject)}`,
                disabled.code === 0 && closed && cards.length === 0 && (value === null || value.code !== 0),
                `disable exit ${String(disabled.code)} ${disabled.stderr.trim()} · closed ${String(closed)} · notices ${JSON.stringify(cards)} · command returned ${JSON.stringify(value)}`);
            rec.note(`toasts while disabling ${subject.pluginID}: ${JSON.stringify(await toasts())}`);
        } else {
            rec.check(`disabling the plugin while its dialog is open closes it with nothing chosen and no notification${tag(subject)}`, false, `no dialog to withdraw: ${raised.detail}`);
            await cli.run(['plugin', 'disable', subject.pluginID]);
        }
        const enabled = await cli.run(['plugin', 'enable', subject.pluginID]);
        let entry = null;
        const back = await d.settle(async () => { entry = await pluginEntry(subject.pluginID); return entry?.enabled === true && entry.status !== 'failed' && entry.status !== 'disabled'; }, { ceilingMs: 10_000 });
        rec.check(`the plugin is enabled again${tag(subject)}`, enabled.code === 0 && back, `enable exit ${String(enabled.code)} · ${JSON.stringify(entry === null ? null : { enabled: entry.enabled, status: entry.status })}`);
    });

    const runPresenter = (subject, n) => step(`${n} ${subject.key} presenter`, async () => {
        await clearNotices();
        presenterSelected = await selectPresenter(promptsView);
        const attached = await d.settleDom(page, `document.querySelector('${promptsSlot}')`, { ceilingMs: 15_000 });
        const ready = attached && await frameCheck(promptsFrame, `document.body.dataset.ready === 'true'`);
        if (!presenterSelected || !ready) throw new Error(`the lab prompts presenter did not attach (chosen ${String(presenterSelected)}, attached ${String(attached)}): ${await labState()}`);
        try {
            const raised = await subject.raise(presenterUp);
            const snapshot = JSON.parse(String(await inFrame(promptsFrame, `JSON.stringify(globalThis.interactionLab?.snapshot ?? null)`)));
            const prompt = snapshot?.prompt ?? null;
            /*
             * The frame is the LAB's own document, so for the lab's own prompt its page may name its
             * own id (asset URLs, the SDK bootstrap) without anything leaking: there the claim is on
             * what was handed to it, the snapshot and the drawn panel. For the probe the frame
             * belongs to a different plugin, and the probe's id must appear nowhere in it at all.
             */
            const leaks = JSON.parse(String(await inFrame(promptsFrame, `(() => {
                const id = ${JSON.stringify(subject.pluginID)};
                const html = document.documentElement.outerHTML;
                const at = html.indexOf(id);
                return JSON.stringify({
                    document: at >= 0, documentExcerpt: at >= 0 ? html.slice(Math.max(0, at - 60), at + id.length + 20) : null,
                    panel: (document.querySelector('[data-testid="lab-prompt"]')?.outerHTML ?? '').includes(id),
                    snapshot: JSON.stringify(globalThis.interactionLab?.snapshot ?? null).includes(id),
                    owner: (document.querySelector('[data-testid="lab-prompt-owner"]')?.textContent ?? '').trim()
                });
            })()`)));
            const noBundled = await page.eval(`document.querySelector('${modal}') === null`);
            const noLeak = !leaks.panel && !leaks.snapshot && (subject.pluginID === labID || !leaks.document);
            rec.check(`with the lab selected for interaction.prompts the backend's dialog is drawn inside the lab's iframe, owner "${subject.owner}", no plugin id in the frame${tag(subject)}`,
                raised.drawn && prompt?.kind === 'dialog' && prompt.options?.title === 'Run it?' && prompt.owner?.displayName === subject.owner
                && JSON.stringify(Object.keys(prompt.owner ?? {}).sort()) === JSON.stringify(['displayName', 'ref'])
                && leaks.owner === subject.owner && noLeak && noBundled === true,
                `${raised.detail} · prompt ${JSON.stringify(prompt)} · frame ${JSON.stringify(leaks)} · bundled dialog absent ${String(noBundled)}`);
            if (!raised.drawn) return;
            await shot(`backend-dialog-in-presenter-${subject.key}`, `the LAB's prompts view draws the dialog (its "INTERACTION LAB" brand and a "${subject.owner}" owner badge, title "Run it?", Cancel and Run), and no bundled dialog is behind it.`);
            await clickFrame(promptsFrame, '[data-testid="lab-prompt-action"][data-action-id="run"]');
            const cleared = await frameCheck(promptsFrame, `document.querySelector('[data-testid="lab-prompt"]') === null`, 6_000);
            const said = await noticeSays(`${subject.owner}: run`);
            const value = await returned(raised);
            rec.check(`Run answered inside the presenter reaches the backend, whose notification reports "run"${tag(subject)}`,
                cleared && said && returnedValue(value, 'run'), `presenter cleared ${String(cleared)} · notices ${JSON.stringify(await notices())} · command returned ${JSON.stringify(value)}`);
        } finally {
            // Back on the bundled presenter, so the hold step measures the plain path and the
            // window is left as the next scenario expects it.
            const restored = await selectPresenter('kelpi.prompts');
            presenterSelected = !restored;
            rec.check(`the prompts placement goes back to the bundled presenter${tag(subject)}`,
                restored && await d.settleDom(page, `document.querySelector('${promptsSlot}') === null`, { ceilingMs: 8_000 }));
        }
    });

    const runHold = (subject, n) => step(`${n} ${subject.key} hold`, async () => {
        await clearNotices();
        const raised = await subject.raise(bundledUp);
        const label = subject.key === 'shortcut'
            ? 'a dialog held open 35 s still answers: the notification reports "run" and no timeout toast appeared'
            : `a dialog held open past the command's 30 s clock still answers: the command returns "run" with exit 0 and the notification reports "run"${tag(subject)}`;
        if (!raised.drawn) { rec.check(label, false, `no dialog to hold: ${raised.detail}`); return; }
        const first = (await dialogInfo(subject.pluginID))?.requestID ?? null;
        await resetToasts();
        // The probe's answer has to be back inside the CLI's own 35 s reply ceiling.
        const holdUntil = subject.key === 'shortcut' ? Date.now() + 35_000 : raised.startedAt + 31_500;
        await sleep(Math.max(0, holdUntil - Date.now()));
        const still = await dialogInfo(subject.pluginID);
        const heldMs = Date.now() - raised.startedAt;
        await clickModalButton('Run');
        const closed = await dialogGone();
        const said = await noticeSays(`${subject.owner}: run`);
        const value = await returned(raised);
        await sleep(1_500);
        const seen = await toasts();
        rec.check(label,
            still !== null && still.requestID === first && closed && said && !seen.some(text => /timed out|timeout/i.test(text))
            && (value === null || (returnedValue(value, 'run') && value.ms > 30_000)),
            `held ${String(heldMs)} ms · same request ${String(still?.requestID === first)} · closed ${String(closed)} · notices ${JSON.stringify(await notices())} · command returned ${JSON.stringify(value)} · toasts ${JSON.stringify(seen)}`);
    });

    const [shortcut, probe] = subjects;
    try {
        // ── 1 · installed, listed, on demand ─────────────────────────────────────────
        await step('1 install', async () => {
            const probeDir = path.join(sandbox.root, 'prompt-probe');
            fs.mkdirSync(probeDir, { recursive: true });
            fs.writeFileSync(path.join(probeDir, 'kelpi.plugin.json'), `${JSON.stringify(PROBE_MANIFEST, null, 2)}\n`);
            fs.writeFileSync(path.join(probeDir, 'backend.mjs'), PROBE_BACKEND);
            const installed = await cli.run(['plugin', 'install', labPath, '--trust']);
            const probeInstalled = await cli.run(['plugin', 'install', probeDir, '--trust']);
            let entry = null;
            const listed = await d.settle(async () => {
                entry = await pluginEntry(labID);
                return entry !== null && entry.enabled === true && ['inactive', 'starting', 'running'].includes(entry.status);
            }, { ceilingMs: 10_000 });
            rec.check('the example installs with --trust and is listed enabled with its backend on demand or running',
                installed.code === 0 && listed && Boolean(entry?.manifest?.backend),
                `install exit ${String(installed.code)} ${installed.stderr.trim()} · ${JSON.stringify(entry === null ? null : { enabled: entry.enabled, status: entry.status, backend: entry.manifest?.backend ?? null, activation: entry.manifest?.activation ?? null })}`);
            const probeEntry = await pluginEntry(probeID);
            rec.check('the probe plugin installs alongside it [probe]', probeInstalled.code === 0 && probeEntry?.enabled === true,
                `install exit ${String(probeInstalled.code)} ${probeInstalled.stderr.trim()} · ${JSON.stringify(probeEntry === null ? null : { enabled: probeEntry.enabled, status: probeEntry.status })}`);
        });

        // ── 2 · the shortcut asks in this window, and Run reaches the backend ────────
        await runAnswer(shortcut, '2');
        // ── 3 · Escape is null ───────────────────────────────────────────────────────
        await runEscape(shortcut, '3');

        // ── 4 · no window from the CLI ───────────────────────────────────────────────
        await step('4 CLI has no window', async () => {
            await clearNotices();
            const ran = await cli.run(['plugin', 'run', labCommand]);
            await sleep(1_500);
            const noDialog = await page.eval(`document.querySelector('${modal}') === null`);
            rec.check('`kelpi plugin run` of the command exits non-zero with NO_WINDOW and opens no dialog anywhere',
                ran.code !== 0 && ran.stderr.includes('NO_WINDOW') && noDialog === true && (await notices()).length === 0,
                `exit ${String(ran.code)} · stderr ${JSON.stringify(ran.stderr.trim())} · stdout ${JSON.stringify(ran.stdout.trim())} · dialog absent ${String(noDialog)}`);
        });

        // ── 5 · disabling the plugin withdraws an open dialog ────────────────────────
        await runDisable(shortcut, '5');
        // ── 6 · drawn by the lab's own prompts presenter ─────────────────────────────
        await runPresenter(shortcut, '6');
        // ── 7 · a dialog held past the command's 30 s clock ──────────────────────────
        await runHold(shortcut, '7');

        // ── 2-7 again, through the probe's explicit window ───────────────────────────
        await runAnswer(probe, '2p');
        await runEscape(probe, '3p');
        await runDisable(probe, '5p');
        await runPresenter(probe, '6p');
        await runHold(probe, '7p');
    } catch (error) {
        await rec.shot(page, 'failure-live');
        throw error;
    } finally {
        // ── 8 · cleanup: nothing of this scenario left in the sandbox ────────────────
        const safely = async (what, body) => {
            try { await body(); } catch (error) { rec.note(`cleanup: ${what}: ${describe(error)}`); }
        };
        for (const id of [labID, probeID]) {
            try {
                const logs = await cli.run(['plugin', 'logs', id]);
                rec.note(`plugin logs ${id} (exit ${String(logs.code)}): ${(logs.stdout || logs.stderr).trim().split('\n').slice(-12).join(' | ')}`);
            } catch (error) { rec.note(`plugin logs ${id} unreadable: ${describe(error)}`); }
        }
        await safely('any request still up is cancelled', async () => {
            for (let attempt = 0; attempt < 4; attempt += 1) {
                if (!await page.eval(`!!document.querySelector('[data-testid="plugin-ui-backdrop"]:not([hidden])') || !!document.querySelector('${promptsSlot}:not([hidden])')`)) return;
                await page.key('Escape');
                await sleep(250);
            }
        });
        await safely('the Settings overlay is closed', async () => {
            if (await page.eval(`!!document.querySelector('[data-testid="settings-close"]')`)) await closeSettings();
        });
        await safely('the prompts placement goes back to bundled', async () => { if (presenterSelected) await selectPresenter('kelpi.prompts'); });
        await safely('the corner is cleared', async () => { if (!await clearNotices()) rec.note('cleanup: the corner still holds a notification'); });
        await safely('the toast sampler is stopped', () => page.eval(`(() => { clearInterval(globalThis.__toastTimer); delete globalThis.__toastLog; delete globalThis.__toastTimer; return true; })()`));
        const removed = await cli.run(['plugin', 'remove', labID]);
        const probeRemoved = await cli.run(['plugin', 'remove', probeID]);
        const leftover = await Promise.all([pluginEntry(labID), pluginEntry(probeID)]).catch(() => 'unreadable');
        const deleted = await cli.run(['workspace', 'delete', workspaceID, '--force']);
        await safely('the probe source is deleted', () => fs.rmSync(path.join(sandbox.root, 'prompt-probe'), { recursive: true, force: true }));
        rec.check('cleanup removes both plugins and the scenario\'s workspace',
            removed.code === 0 && probeRemoved.code === 0 && JSON.stringify(leftover) === '[null,null]' && deleted.code === 0,
            `remove exit ${String(removed.code)} ${removed.stderr.trim()} / ${String(probeRemoved.code)} ${probeRemoved.stderr.trim()} · still listed ${JSON.stringify(leftover)} · workspace delete exit ${String(deleted.code)} ${deleted.stderr.trim()}`);
        await safely('the window returns to the workspace it started on', async () => {
            if (startingWorkspace === null) return;
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);
        });
    }
}

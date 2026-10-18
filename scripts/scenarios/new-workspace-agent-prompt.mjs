/**
 * shell-ui.md §10.1's Agent row: New Workspace starts an agent in the new workspace's first pane
 * with the prompt the sheet was given, prefilled or sent, and a prompt that could not be delivered
 * comes back as a sticky toast that copies it (agent-lifecycle.md §6.5, wire-protocol.md §6.3).
 *
 * The agent is a STAND-IN, never a real one: `scripts/fixtures/fake-codex.cjs` draws what the
 * daemon's codex readiness rule reads (the alternate screen, bracketed paste, a `›` composer row),
 * echoes a bracketed paste onto that composer, prints its argv, and counts as a submit only a bare
 * Enter outside a paste (`SUBMITTED:`). No network, no account. `agent-codex-command` is pointed at
 * a two-line wrapper that gives each launch its own state directory, set through Settings ▸
 * General ▸ Agents the way a user sets it.
 *
 * Everything else is the shipped route: the sidebar's New Workspace button, the sheet's Agent
 * picker, Prompt box and Send immediately, the create over the window's socket, the daemon's
 * launcher typing the launch line into a real shell and pasting into a real PTY, the
 * `agent-launch` frame and the window's toast.
 *
 * Steps:
 *   1. the sheet: the Agent row is drawn on None; Codex reveals Prompt and Send immediately; Tab
 *      walks them in order (and moves out of the prompt rather than typing a tab); Escape with the
 *      prompt focused still closes the sheet and creates nothing;
 *   2. prefill: a two-line prompt (Return types the newline, ⌘Return creates) lands on the fake
 *      composer as one paste, with no submit and no toast;
 *   3. Send immediately: the prompt arrives as the agent's argv, nothing is pasted, no toast;
 *   4. a command that does not exist: a sticky "Prompt not delivered to Codex" toast that copies
 *      the prompt when clicked, and nothing pasted into the shell.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The source this drives, so `verify.mjs` re-runs it when any hop moves. */
export const covers = [
    'packages/client/src/chrome/NewWorkspaceSheet.tsx',
    'packages/client/src/chrome/Sidebar.tsx',
    'packages/client/src/chrome/types.ts',
    'packages/client/src/chrome/index.ts',
    'packages/client/src/features/workspaces.tsx',
    'packages/client/src/features/workspaces-actions.ts',
    'packages/client/src/connection/commands.ts',
    'packages/client/src/settings/sections.ts',
    'packages/client/src/state/agent-launch.ts',
    'packages/client/src/state/bridge.ts',
    'packages/client/src/state/clipboard.ts',
    'packages/client/src/state/store.ts',
    'packages/client/src/state/index.ts',
    'packages/client/src/App.tsx',
    'packages/client/src/chrome/ToastStack.tsx',
    'packages/client/src/chrome/corner-layer.ts',
    'packages/daemon/src/agent-launch/',
    'packages/daemon/src/handlers/app/workspaces.ts',
    'packages/daemon/src/pty/foreground.ts',
    'packages/daemon/src/pty/input-observer.ts',
    'packages/daemon/src/pty/manager.ts',
    'packages/daemon/src/pty/shell-integration.ts',
    'packages/daemon/src/pty/spawn-gate.ts',
    'packages/daemon/src/term/service.ts',
    'packages/daemon/src/settings/service.ts',
    'packages/daemon/src/ws/sync.ts',
    'packages/daemon/src/boot/compose.ts',
    'packages/daemon/src/boot/dispatch.ts',
    'packages/core/src/agent/',
    'packages/core/src/config/general.ts',
    'packages/protocol/src/ws/messages.ts',
    'packages/protocol/src/ws/settings.ts',
    'packages/protocol/src/wire/fields.ts',
    'packages/protocol/src/wire/decode.ts',
    'packages/protocol/src/wire/vocab.ts',
    'scripts/fixtures/fake-codex.cjs'
];

/** CDP input has to reach the window for the sheet and the toast (see `placement.mjs`). */
export const windowPlacement = 'offscreen';

const FIXTURE = 'scripts/fixtures/fake-codex.cjs';
const SHEET = '[data-testid="new-workspace-sheet"]';
const NAME = '[aria-label="New workspace name"]';
const AGENT = '[data-testid="new-workspace-agent"]';
const PROMPT = '[data-testid="new-workspace-agent-prompt"]';
const SEND = '[data-testid="new-workspace-agent-send"]';
const SUBMIT = '[data-testid="new-workspace-submit"]';
const CODEX_INPUT = '[data-testid="agent-codex-command-input"]';
const LAUNCH_TOASTS = '[data-testid^="toast-agent-launch-"]';

/** A single-quoted shell word (the sandbox paths have no quotes, but a path is never trusted). */
const sq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

export default async function ({ page, cli, sandbox, daemon, harness, rec, d, sleep, repoRoot }) {
    if (sandbox === undefined || sandbox === null || cli === undefined || cli === null || daemon === undefined || daemon === null) {
        rec.check('this scenario boots its own sandbox (it sets the agent command and reads the daemon log)', false, 'run without --attach');
        return;
    }

    // ── fixtures: the fake codex behind a wrapper that gives every launch its own directory ──
    const root = fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'agent-')));
    const launches = path.join(root, 'launches.txt');
    fs.writeFileSync(launches, '');
    const wrapper = path.join(root, 'fake-codex');
    fs.writeFileSync(
        wrapper,
        '#!/bin/sh\n' +
            '# Test fixture: the fake codex, with a state directory of its own for this launch.\n' +
            `dir=${sq(path.join(root, 'launch-'))}"$$"\n` +
            `echo "$dir" >> ${sq(launches)}\n` +
            `KELPI_FAKE_AGENT_DIR="$dir" exec ${sq(process.execPath)} ${sq(path.join(repoRoot, FIXTURE))} "$@"\n`,
        { mode: 0o755 }
    );
    const missing = path.join(root, 'no-such-codex');
    const launchDirs = () => fs.readFileSync(launches, 'utf8').split('\n').filter(Boolean);
    const fakeState = (dir) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        } catch {
            return null;
        }
    };

    const originalConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    const originalClipboard = String((await harness.clipboardRead()).text ?? '');
    const listed = async () => JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspaces = await listed();
    const homeID = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const created = [];
    const log = () => daemon.text();

    // ── helpers ────────────────────────────────────────────────────────────────────────
    const codexCommandInConfig = () => /^agent-codex-command\s*=\s*(.*)$/m.exec(fs.readFileSync(sandbox.configPath, 'utf8'))?.[1]?.trim() ?? null;
    /** Settings ▸ General ▸ Agents ▸ Codex command, typed and committed with Return. */
    const setCodexCommand = async (value) => {
        await d.openSettingsTab(page, 'general');
        await page.eval(`document.querySelector('${CODEX_INPUT}')?.scrollIntoView({ block: 'center' })`);
        await page.click(CODEX_INPUT);
        await page.eval(`document.querySelector('${CODEX_INPUT}')?.select()`);
        await page.insertText(value);
        await page.enter();
        const written = await d.settle(async () => codexCommandInConfig() === value, { ceilingMs: 5_000, intervalMs: 100 });
        // Not Escape: in a text field it cancels the edit and stops there (`controls.tsx`).
        await page.click('[data-testid="settings-close"]');
        const closed = await d.settleDom(page, `document.querySelector('${d.PAGE.settingsPanel}') === null`, { ceilingMs: 3_000 });
        return written && closed;
    };
    const openSheet = async () => {
        await page.click('[data-testid="sidebar-new-workspace"]');
        return d.settleDom(page, `document.querySelector('${SHEET}') !== null && document.activeElement === document.querySelector('${NAME}')`, { ceilingMs: 5_000 });
    };
    const sheet = async () =>
        JSON.parse(
            String(
                await page.eval(`(() => {
                    const agent = document.querySelector('${AGENT}');
                    const prompt = document.querySelector('${PROMPT}');
                    return JSON.stringify({
                        open: document.querySelector('${SHEET}') !== null,
                        agent: agent?.value ?? null,
                        choices: Array.from(agent?.options ?? []).map(o => o.text),
                        prompt: prompt?.value ?? null,
                        placeholder: prompt?.getAttribute('placeholder') ?? null,
                        send: document.querySelector('${SEND}')?.checked ?? null,
                        hint: document.querySelector('[data-testid="new-workspace-agent-hint"]')?.textContent ?? null,
                        focus: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.getAttribute('aria-label') ?? null
                    });
                })()`)
            )
        );
    /** The picker is a native <select>: its popup is the OS's, so the value is set as a choice would set it. */
    const chooseAgent = async (label) =>
        page.eval(`(() => {
            const el = document.querySelector('${AGENT}');
            const option = Array.from(el?.options ?? []).find(o => o.text === ${JSON.stringify(label)});
            if (el === null || option === undefined) return false;
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
    const typeName = async (name) => {
        await page.click(NAME);
        await page.eval(`document.querySelector('${NAME}')?.select()`);
        await page.insertText(name);
    };
    /**
     * Each line as typed text, and a real Return keystroke between them: the box's own newline,
     * which the sheet must not take for a submit. (`page.type` sends a keyDown with text AND a
     * char event, which a textarea inserts twice.)
     */
    const typePrompt = async (lines) => {
        await page.eval(`document.querySelector('${PROMPT}')?.scrollIntoView({ block: 'nearest' })`);
        await page.click(PROMPT);
        for (const [index, line] of lines.entries()) {
            if (index > 0) await page.key('Enter');
            await page.insertText(line);
        }
    };
    const workspaceNamed = async (name) => {
        let found;
        await d.settle(async () => {
            found = (await listed()).find((workspace) => workspace.name === name);
            return found !== undefined;
        }, { ceilingMs: 15_000, intervalMs: 200 });
        if (found !== undefined) created.push(found.id);
        return found;
    };
    const firstPane = async (workspaceID) => {
        let pane;
        await d.settle(async () => {
            pane = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']))[0];
            return pane !== undefined;
        }, { ceilingMs: 15_000, intervalMs: 200 });
        return pane?.id ?? null;
    };
    const capture = async (paneID) => (await cli.run(['pane', 'capture', '--target', paneID])).stdout;
    // The launcher's one outcome line per launch (`launcher.ts` ▸ `finish`), not its progress lines.
    const outcomeIn = (paneID) =>
        new RegExp(`agent launch: pane ${paneID} \\(codex\\) (launched|sent|prefilled|fallback|failed)(?: \\(([\\w-]+)\\))?`).exec(log());
    const waitOutcome = async (paneID, ceilingMs) => {
        await d.settle(async () => outcomeIn(paneID) !== null, { ceilingMs, intervalMs: 200 });
        const match = outcomeIn(paneID);
        return match === null ? null : { outcome: match[1], reason: match[2] ?? null };
    };
    const launchToasts = async () =>
        JSON.parse(
            String(
                await page.eval(`JSON.stringify(Array.from(document.querySelectorAll('[data-testid="toast-stack"] button')).map(el => ({
                    id: el.getAttribute('data-testid'),
                    copy: el.getAttribute('data-copy') === 'true',
                    text: el.innerText ?? ''
                })).filter(t => t.id?.startsWith('toast-agent-launch-') || /not delivered|not started|Workspace not created/.test(t.text)))`)
            )
        );

    try {
        // ── 0 · the codex command points at the fake, set from Settings ▸ General ▸ Agents ──
        rec.check('Settings ▸ General ▸ Agents ▸ Codex command writes agent-codex-command', await setCodexCommand(wrapper), String(codexCommandInConfig()));

        // ── 1 · the sheet: the Agent row, its Tab stops, and Escape ─────────────────────────
        rec.check('the sidebar’s New Workspace opens the sheet, focus in the name', await openSheet());
        const fresh = await sheet();
        rec.check(
            'the Agent row is drawn, None / Claude Code / Codex, on None, with no prompt yet',
            fresh.agent === 'none' && JSON.stringify(fresh.choices) === JSON.stringify(['None', 'Claude Code', 'Codex']) && fresh.prompt === null && fresh.send === null,
            JSON.stringify(fresh)
        );
        await typeName('Escape Me');
        rec.check('choosing Codex in the picker', await chooseAgent('Codex'));
        const chosen = await sheet();
        rec.check(
            'Codex reveals the Prompt box (empty, its placeholder naming Codex) and Send immediately, unticked',
            chosen.agent === 'codex' && chosen.prompt === '' && chosen.placeholder === 'Optional: what to ask Codex' && chosen.send === false,
            JSON.stringify(chosen)
        );
        rec.check('the caption says the prompt is pasted for you to edit and send', chosen.hint === "The prompt is pasted into Codex's input for you to edit and send.", chosen.hint);
        await rec.shot(page, 'sheet-agent-codex');

        // The Tab loop, derived from what is on screen as `workspace-create-full` derives it: what
        // is fixed is the ORDER, with the Agent row's three stops last before Cancel and Create.
        await page.eval(`document.querySelector('${NAME}')?.focus()`);
        const expectedStops = JSON.parse(
            String(
                await page.eval(`(() => {
                    const has = (id) => document.querySelector('[data-testid="' + id + '"]') !== null;
                    const order = ['New workspace name', 'new-workspace-colors'];
                    if (has('new-workspace-group')) order.push('new-workspace-group');
                    order.push('new-workspace-profile', 'new-workspace-muted');
                    if (has('new-workspace-repos')) {
                        for (const el of document.querySelectorAll('[data-testid^="new-workspace-repo-remove-"]')) order.push(el.getAttribute('data-testid'));
                        order.push('new-workspace-add-repo');
                    }
                    if (has('new-workspace-worktree-toggle')) order.push('new-workspace-worktree-toggle');
                    order.push('new-workspace-agent', 'new-workspace-agent-prompt', 'new-workspace-agent-send', 'new-workspace-cancel', 'new-workspace-submit');
                    return JSON.stringify(order);
                })()`)
            )
        );
        const walked = [];
        for (let step = 0; step < expectedStops.length; step += 1) {
            await page.key('Tab', { key: 'Tab' });
            await sleep(60);
            walked.push((await sheet()).focus);
        }
        const expectedWalk = [...expectedStops.slice(1), expectedStops[0]];
        rec.check(
            'Tab walks Agent → Prompt → Send immediately → Cancel → Create, and wraps',
            JSON.stringify(walked) === JSON.stringify(expectedWalk),
            `${JSON.stringify(walked)} vs ${JSON.stringify(expectedWalk)}`
        );
        rec.check('Tab moved out of the Prompt box rather than typing a tab into it', (await sheet()).prompt === '', JSON.stringify((await sheet()).prompt));

        const beforeEscape = (await listed()).length;
        await typePrompt(['never sent']);
        rec.check('the focus is in the Prompt box', (await sheet()).focus === 'new-workspace-agent-prompt');
        await page.key('Escape');
        const escaped = await d.settleDom(page, `document.querySelector('${SHEET}') === null`, { ceilingMs: 3_000 });
        await sleep(300);
        rec.check('Escape from the Prompt box closes the sheet and creates nothing', escaped && (await listed()).length === beforeEscape, `${String(beforeEscape)} → ${String((await listed()).length)}`);

        // ── 2 · prefill: the prompt is pasted onto the agent's composer, never submitted ──────
        const prefillLines = ['Fix the flaky login test', 'then run the whole suite'];
        const prefillPrompt = prefillLines.join('\n');
        rec.check('the sheet opens again', await openSheet());
        rec.check('…on None again: the picker opens on the new-workspace-agent setting, not the last choice', (await sheet()).agent === 'none', JSON.stringify(await sheet()));
        await typeName('Agent Prefill');
        await chooseAgent('Codex');
        await typePrompt(prefillLines);
        const typed = await sheet();
        rec.check('Return in the Prompt box typed a newline and did not create', typed.open && typed.prompt === prefillPrompt, JSON.stringify(typed));
        await rec.shot(page, 'sheet-two-line-prompt');
        const prefillDirsBefore = launchDirs().length;
        await page.key('Enter', { modifiers: d.MOD.meta });
        rec.check('⌘Return creates from the Prompt box and closes the sheet', await d.settleDom(page, `document.querySelector('${SHEET}') === null`, { ceilingMs: 5_000 }));
        const prefillWorkspace = await workspaceNamed('Agent Prefill');
        const prefillPane = prefillWorkspace === undefined ? null : await firstPane(prefillWorkspace.id);
        rec.check('the workspace exists with its first pane', prefillPane !== null, JSON.stringify(prefillWorkspace));
        if (prefillPane === null) return;
        const prefilled = await waitOutcome(prefillPane, 40_000);
        rec.check('the daemon reports the launch prefilled', prefilled?.outcome === 'prefilled', JSON.stringify(prefilled));
        const prefillDir = launchDirs()[prefillDirsBefore] ?? null;
        rec.check('the configured command started the fake codex (one launch)', prefillDir !== null && launchDirs().length === prefillDirsBefore + 1, JSON.stringify(launchDirs()));
        const composed = await d.settle(async () => fakeState(prefillDir ?? '')?.composer === prefillPrompt, { ceilingMs: 5_000, intervalMs: 100 });
        const prefillState = fakeState(prefillDir ?? '');
        rec.check('the fake composer holds the two-line prompt, from ONE bracketed paste', composed && prefillState?.pastes === 1, JSON.stringify(prefillState));
        rec.check('…with no argv (a prefill types no prompt on the launch line)', JSON.stringify(prefillState?.argv) === '[]', JSON.stringify(prefillState?.argv));
        // A dwell, because "nothing submitted" is a negative: an Enter after the paste would land now.
        await sleep(1_500);
        const prefillScreen = await capture(prefillPane);
        rec.note(`prefill pane:\n${prefillScreen.trimEnd()}`);
        rec.check(
            'the pane shows the prompt on the composer rows',
            prefillScreen.includes(`› ${prefillLines[0]}`) && prefillScreen.includes(`  ${prefillLines[1]}`),
            prefillScreen.slice(0, 400)
        );
        rec.check('and nothing was submitted (no SUBMITTED: marker, on screen or in the fake’s record)', !prefillScreen.includes('SUBMITTED:') && (fakeState(prefillDir ?? '')?.submitted ?? ['?']).length === 0);
        rec.check('and no undelivered-prompt toast', (await launchToasts()).length === 0, JSON.stringify(await launchToasts()));
        await rec.shot(page, 'prefilled-pane');

        // ── 3 · Send immediately: the prompt is the agent's argument ───────────────────────────
        const sendLines = ['Summarise the README', 'in three bullets'];
        const sendPrompt = sendLines.join('\n');
        rec.check('the sheet opens for the send case', await openSheet());
        await typeName('Agent Send');
        await chooseAgent('Codex');
        await typePrompt(sendLines);
        await page.click(SEND);
        const ticked = await sheet();
        rec.check('Send immediately ticks, and the caption says the prompt runs at once', ticked.send === true && ticked.hint === 'Codex starts with the prompt and runs it at once.', JSON.stringify(ticked));
        const sendDirsBefore = launchDirs().length;
        await page.click(SUBMIT);
        rec.check('Create closes the sheet', await d.settleDom(page, `document.querySelector('${SHEET}') === null`, { ceilingMs: 5_000 }));
        const sendWorkspace = await workspaceNamed('Agent Send');
        const sendPane = sendWorkspace === undefined ? null : await firstPane(sendWorkspace.id);
        rec.check('the send workspace exists with its first pane', sendPane !== null, JSON.stringify(sendWorkspace));
        if (sendPane === null) return;
        const sent = await waitOutcome(sendPane, 40_000);
        rec.check('the daemon reports the launch sent', sent?.outcome === 'sent', JSON.stringify(sent));
        const sendDir = await d.settle(async () => launchDirs().length === sendDirsBefore + 1 && fakeState(launchDirs()[sendDirsBefore]) !== null, { ceilingMs: 10_000, intervalMs: 100 })
            ? launchDirs()[sendDirsBefore]
            : null;
        const sendState = sendDir === null ? null : fakeState(sendDir);
        rec.check(
            'the fake codex received the prompt as its one argument (with the launch line’s documented trailing space)',
            JSON.stringify(sendState?.argv) === JSON.stringify([`${sendPrompt} `]),
            JSON.stringify(sendState?.argv)
        );
        await sleep(1_000);
        const sendAfter = sendDir === null ? null : fakeState(sendDir);
        rec.check('nothing was pasted into it and nothing submitted', sendAfter?.pastes === 0 && sendAfter?.composer === '' && sendAfter?.submitted.length === 0, JSON.stringify(sendAfter));
        const sendScreen = await capture(sendPane);
        rec.note(`send pane:\n${sendScreen.trimEnd()}`);
        rec.check('the pane shows the argv the agent printed', sendScreen.includes(`ARGV: ${JSON.stringify([`${sendPrompt} `])}`), sendScreen.slice(0, 400));
        rec.check('and no undelivered-prompt toast', (await launchToasts()).length === 0, JSON.stringify(await launchToasts()));
        await rec.shot(page, 'sent-pane');

        // ── 4 · a command that does not exist: the prompt comes back, the shell gets nothing ──
        rec.check('the codex command now names a file that does not exist', await setCodexCommand(missing), String(codexCommandInConfig()));
        const missingLines = ['Do not paste me', 'into the shell'];
        const missingPrompt = missingLines.join('\n');
        rec.check('the sheet opens for the missing-command case', await openSheet());
        await typeName('Agent Missing');
        await chooseAgent('Codex');
        await typePrompt(missingLines);
        await page.click(SUBMIT);
        rec.check('Create closes the sheet', await d.settleDom(page, `document.querySelector('${SHEET}') === null`, { ceilingMs: 5_000 }));
        const missingWorkspace = await workspaceNamed('Agent Missing');
        const missingPane = missingWorkspace === undefined ? null : await firstPane(missingWorkspace.id);
        rec.check('the workspace exists with its first pane', missingPane !== null, JSON.stringify(missingWorkspace));
        if (missingPane === null) return;
        const toastSelector = `[data-testid="toast-agent-launch-${missingPane}"]`;
        const toastUp = await d.settleDom(page, `document.querySelector('${toastSelector}')`, { ceilingMs: 45_000 });
        const fellBack = await waitOutcome(missingPane, 5_000);
        rec.check('the daemon reports a fallback: the shell came back, the agent never started', fellBack?.outcome === 'fallback' && fellBack.reason === 'agent-exited', JSON.stringify(fellBack));
        const toast = (await launchToasts()).find((entry) => entry.id === `toast-agent-launch-${missingPane}`) ?? null;
        rec.check('a "Prompt not delivered to Codex" toast is up for the pane', toastUp && toast !== null, JSON.stringify(await launchToasts()));
        rec.check(
            '…saying why, offering the copy (copied already, or click to copy)',
            toast !== null &&
                /^Prompt not delivered to Codex: (copied to the clipboard|click to copy it)/.test(toast.text) &&
                toast.text.includes('Codex exited before it was ready for the prompt.') &&
                toast.copy === true,
            JSON.stringify(toast)
        );
        await rec.shot(page, 'prompt-not-delivered-toast');
        const missingScreen = await capture(missingPane);
        rec.note(`missing-command pane:\n${missingScreen.trimEnd()}`);
        const rows = missingScreen.split('\n').map((row) => row.trimEnd()).filter((row) => row !== '');
        const lastRow = rows.at(-1) ?? '';
        rec.check('the shell said the command was not found', /no such file|not found/i.test(missingScreen), missingScreen.slice(-300));
        rec.check(
            'nothing was pasted into the shell: the prompt is nowhere in the pane and the shell line is empty',
            !missingScreen.includes(missingLines[0]) && !missingScreen.includes(missingLines[1]) && /[$%#>]$/.test(lastRow) && !lastRow.includes(missing),
            JSON.stringify(lastRow)
        );
        // Sticky: an ordinary toast is gone after 6 s (`ERROR_TOAST_MS`); this one waits for the user.
        await sleep(7_000);
        rec.check('the toast is sticky: still up 7 s later', (await page.eval(`document.querySelector('${toastSelector}') !== null`)) === true);
        const seeded = String((await harness.clipboardWrite('NOT-THE-PROMPT')).text);
        await page.click(toastSelector);
        const copied = await d.settle(async () => String((await harness.clipboardRead()).text) === missingPrompt, { ceilingMs: 5_000, intervalMs: 100 });
        rec.check('clicking the toast copies the prompt to the clipboard', seeded === 'NOT-THE-PROMPT' && copied, JSON.stringify(String((await harness.clipboardRead()).text).slice(0, 80)));
        rec.check('…and dismisses it', await d.settleDom(page, `document.querySelector('${toastSelector}') === null`, { ceilingMs: 3_000 }));
    } finally {
        if (await page.eval(`document.querySelector('${SHEET}') !== null`)) await page.key('Escape');
        if (await page.eval(`document.querySelector('${d.PAGE.settingsPanel}') !== null`)) await page.key('Escape');
        for (const id of created) await cli.run(['workspace', 'delete', id, '--force']);
        fs.writeFileSync(sandbox.configPath, originalConfig);
        await harness.clipboardWrite(originalClipboard).catch(() => {});
        const home = `[data-testid="workspace-row"][data-workspace-id="${String(homeID)}"]`;
        if (homeID !== null && (await d.settleDom(page, `document.querySelector(${JSON.stringify(home)})`, { ceilingMs: 8_000 }))) await page.click(home);
    }
}

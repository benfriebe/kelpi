/**
 * Issue #295: a pane an agent creates opens in the BACKGROUND, so the user's typing stays put.
 *
 * The report: "My Claude sessions open new panes while I'm typing in another one, and the new
 * pane grabs focus. My typing ends up in the wrong pane." Every pane-creating CLI verb used to
 * focus the new pane (and pre-focus its source), and the window then moved the keyboard into it.
 *
 * What this does, in order, speaking through the sandbox CLI exactly as an agent in a pane would
 * (`KELPI_PANE_ID` set to that pane):
 *
 *   1. focus a terminal and start typing a command into it, WITHOUT pressing Enter;
 *   2. `kelpi pane split --name worker`, `pane create`, `web open about:blank` and `open notes.md`,
 *      one at a time, from the typing pane itself, and one more split from a separate agent pane;
 *   3. after each, keep typing, press Enter, and read the typing pane's own screen with
 *      `kelpi pane capture`: the finished line must have landed there. The daemon's focused pane,
 *      the ring and the DOM caret must all still name the typing pane;
 *   4. `kelpi pane split --focus` must move all three to the new pane (the opt-in still works);
 *   5. ⌘D in the window must still focus the pane it creates (the user's own gesture).
 *
 * No pixel is measured: every assertion is DOM state, the CLI, or a keystroke reaching a real
 * PTY. The screenshots are evidence for the PR, not checks.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The source this presses (the scenario rule; ui-audit/README.md). */
export const covers = [
    'packages/daemon/src/handlers/pane/create.ts',
    'packages/daemon/src/handlers/app/files.ts',
    'packages/daemon/src/webpane/handlers.ts',
    'packages/daemon/src/store/reducers/panes.ts',
    'packages/client/src/webpane/hooks.ts',
    'packages/client/src/connection/commands.ts',
    'packages/cli/src/commands/pane.ts'
];

/** The pane whose SURFACE holds the caret, or '' when the caret is not in a pane at all. */
const CARET_PANE = `(() => {
    const a = document.activeElement;
    if (a === null) return '';
    const pane = a.closest('[data-pane-id]');
    return pane === null ? '' : (pane.getAttribute('data-pane-id') ?? '');
})()`;

const CARET_HTML = `(() => { const a = document.activeElement; return a === null ? '<null>' : String(a.outerHTML ?? a.nodeName).slice(0, 120); })()`;

/** The pane wearing the focus ring. */
const RINGED_PANE = `(() => {
    const el = document.querySelector('[data-pane-id][data-focused="true"]');
    return el === null ? '' : (el.getAttribute('data-pane-id') ?? '');
})()`;

const paneInDom = (paneID) => `document.querySelector('[data-pane-id="${paneID}"]') !== null`;

export default async function ({ page, cli, rec, d, sleep, sandbox }) {
    const panesOf = async (workspace) => JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspace, '--json']));
    const daemonFocus = async (workspace) => (await panesOf(workspace)).find((pane) => pane.is_focused)?.id ?? '';

    /** Type, and wait long enough for the echo to be the shell's, not ours. */
    const typeText = async (text) => {
        await page.type(text);
        await sleep(150);
    };

    /** Did `marker` arrive on its own line in this pane's screen (i.e. `echo` ran there)? */
    const landedIn = async (paneID, marker) => {
        let capture = '';
        const ok = await d.settle(
            async () => {
                capture = await cli.ok(['pane', 'capture', '--target', paneID]);
                return capture.split('\n').some((line) => line.trim() === marker);
            },
            { ceilingMs: 8_000, intervalMs: 300 }
        );
        return { ok, tail: capture.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' | ') };
    };

    const workspaceName = 'Background295';
    let workspaceID = null;
    try {
        const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', workspaceName, '--json']));
        workspaceID = created.workspace_id ?? created.id;
        rec.check('a workspace of its own was created', typeof workspaceID === 'string', JSON.stringify(created));
        if (typeof workspaceID !== 'string') return;
        await d.settleDom(page, `document.querySelector('[data-workspace-id="${workspaceID}"]')`, { ceilingMs: 10_000 });

        const user = (await panesOf(workspaceName))[0]?.id;
        rec.check('the workspace has its first terminal', typeof user === 'string');
        if (typeof user !== 'string') return;

        // A separate agent pane, created in the background from outside any pane (the case a
        // coordinator in another pane is). The user then clicks into their own terminal.
        const agent = JSON.parse(
            await cli.ok(['pane', 'split', '--workspace', workspaceName, '--name', 'agent', '--json'])
        ).pane_id;
        await d.settleDom(page, paneInDom(agent), { ceilingMs: 10_000 });
        await d.settleDom(page, `document.querySelectorAll('[data-pane-id="${user}"] [data-pane-surface] textarea').length > 0`, { ceilingMs: 30_000 });
        // Click into the terminal body, which is how a person starts typing in a pane: the
        // engine's own mousedown puts the caret in its textarea.
        await page.click(`[data-pane-id="${user}"] [data-pane-surface]`);
        await d.settle(async () => (await page.eval(CARET_PANE)) === user, { ceilingMs: 8_000 });
        rec.check(
            'precondition: the user\'s terminal has the ring, the caret and the daemon\'s focus',
            (await page.eval(RINGED_PANE)) === user && (await page.eval(CARET_PANE)) === user && (await daemonFocus(workspaceName)) === user,
            `ring ${String(await page.eval(RINGED_PANE))}, caret ${String(await page.eval(CARET_PANE))} (${String(await page.eval(CARET_HTML))}), daemon ${await daemonFocus(workspaceName)}, user ${user}`
        );

        // `sandbox` is null under `--attach`; the daemon is on this machine either way.
        const notes = path.join(sandbox?.home ?? os.tmpdir(), 'notes-295.md');
        fs.writeFileSync(notes, '# Background notes\n\nOpened by an agent while the user typed.\n');

        /**
         * One agent create while the user is mid-command. `run` is the CLI call; `from` is the
         * pane whose `KELPI_PANE_ID` the agent speaks with.
         */
        const midTyping = async (label, marker, args, from, shot) => {
            const before = new Set((await panesOf(workspaceName)).map((pane) => pane.id));
            // Half a command, no Enter: the user is in the middle of typing.
            await typeText(`echo ${marker.slice(0, 4)}`);
            const result = await cli.run(args, { paneID: from });
            rec.check(`${label}: the CLI call succeeded`, result.code === 0, `${args.join(' ')} -> ${String(result.code)} ${result.stderr}`);
            let added = '';
            await d.settle(
                async () => {
                    added = (await panesOf(workspaceName)).map((pane) => pane.id).find((id) => !before.has(id)) ?? '';
                    return added !== '';
                },
                { ceilingMs: 8_000, intervalMs: 200 }
            );
            rec.check(`${label}: a new pane joined the layout`, added !== '' && (await d.settleDom(page, paneInDom(added), { ceilingMs: 10_000 })));
            // Every split halves the pane it splits off, so reflow into a grid to keep the
            // screenshots readable. A layout change is not a focus change either.
            await cli.run(['layout', 'select', 'tiled'], { paneID: user });
            // Every mount-time handoff (engine open, its delayed backup grab, WEB-002, the page
            // claim) is bounded at 1.5 s; wait past all of them before asking who has the keyboard.
            await sleep(1_800);
            if (shot !== undefined) await rec.shot(page, shot);
            const focus = await daemonFocus(workspaceName);
            const ring = await page.eval(RINGED_PANE);
            const caret = await page.eval(CARET_PANE);
            rec.check(
                `${label}: the daemon's focus, the ring and the caret all stay on the user's terminal`,
                focus === user && ring === user && caret === user,
                `daemon ${focus}, ring ${String(ring)}, caret ${String(caret)} (${String(await page.eval(CARET_HTML))}), user ${user}, new ${added}`
            );
            // …and the rest of the line the user was typing lands in the SAME pane.
            await typeText(marker.slice(4));
            await page.key('Enter');
            const typed = await landedIn(user, marker);
            rec.check(`${label}: the rest of what the user typed landed in their own terminal`, typed.ok, `capture tail: ${typed.tail}`);
            return added;
        };

        await midTyping('pane split --name worker', 'bgsplit1', ['pane', 'split', '--name', 'worker'], user, 'background-split-focus-stays');
        await midTyping('pane create', 'bgcreate2', ['pane', 'create', '--name', 'created'], user);
        await midTyping('web open about:blank', 'bgweb3', ['web', 'open', 'about:blank'], user, 'background-web-open-focus-stays');
        await midTyping('open notes.md', 'bgmark4', ['open', notes], user, 'background-markdown-focus-stays');
        await midTyping('pane split from a separate agent pane', 'bgagent5', ['pane', 'split', '--name', 'worker-2'], agent);

        /*
         * A page that tries to take the keyboard for itself on load. The web pane is a native
         * view the shell composites over this document, so the DOM caret alone cannot see it
         * steal: ask the page itself whether its document has focus.
         */
        const stealer = await midTyping(
            'web open (a page that autofocuses an input)',
            'bgpage6',
            ['web', 'open', 'data:text/html,<title>steal</title><input autofocus id=steal placeholder=steal>'],
            user
        );
        if (stealer !== '') {
            const probe = await cli.run(['web', 'exec', '--target', stealer, '--json', 'return { focused: document.hasFocus(), active: document.activeElement?.id ?? null };']);
            rec.note(`the autofocus page reports ${probe.stdout.trim() || probe.stderr.trim()}; the client document hasFocus=${String(await page.eval('document.hasFocus()'))}`);
            let pageFocused = null;
            try {
                const reply = JSON.parse(probe.stdout);
                pageFocused = (reply.result ?? reply).focused ?? null;
            } catch {
                pageFocused = null;
            }
            rec.check('web open (autofocus page): the page\'s document does not have the keyboard', pageFocused === false, probe.stdout.trim() || probe.stderr.trim());
        }

        // ── the opt-in: --focus takes the user to the new pane ────────────────────────────
        const focused = JSON.parse(
            (await cli.run(['pane', 'split', '--focus', '--name', 'focused', '--json'], { paneID: user })).stdout
        ).pane_id;
        await d.settleDom(page, paneInDom(focused), { ceilingMs: 10_000 });
        await cli.run(['layout', 'select', 'tiled'], { paneID: user });
        await d.settle(async () => (await page.eval(CARET_PANE)) === focused, { ceilingMs: 8_000 });
        await sleep(1_000);
        await rec.shot(page, 'focus-flag-moves-focus');
        rec.check(
            'pane split --focus: the daemon\'s focus, the ring and the caret move to the new pane',
            (await daemonFocus(workspaceName)) === focused && (await page.eval(RINGED_PANE)) === focused && (await page.eval(CARET_PANE)) === focused,
            `daemon ${await daemonFocus(workspaceName)}, ring ${String(await page.eval(RINGED_PANE))}, caret ${String(await page.eval(CARET_PANE))}, new ${focused}`
        );
        await typeText('echo focusflag6');
        await page.key('Enter');
        const intoFocused = await landedIn(focused, 'focusflag6');
        rec.check('pane split --focus: typing now reaches the new pane', intoFocused.ok, `capture tail: ${intoFocused.tail}`);

        // ── the user's own gesture: ⌘D still focuses what it creates ─────────────────────
        const beforeGesture = new Set((await panesOf(workspaceName)).map((pane) => pane.id));
        await page.key('KeyD', { modifiers: d.MOD.meta, key: 'd' });
        let gesture = '';
        await d.settle(
            async () => {
                gesture = (await panesOf(workspaceName)).map((pane) => pane.id).find((id) => !beforeGesture.has(id)) ?? '';
                return gesture !== '';
            },
            { ceilingMs: 8_000, intervalMs: 200 }
        );
        if (gesture !== '') await cli.run(['layout', 'select', 'tiled'], { paneID: gesture });
        await d.settle(async () => gesture !== '' && (await page.eval(CARET_PANE)) === gesture, { ceilingMs: 8_000 });
        await sleep(1_000);
        await rec.shot(page, 'cmd-d-focuses-new-pane');
        rec.check(
            '⌘D: the new pane takes the daemon\'s focus, the ring and the caret',
            gesture !== '' && (await daemonFocus(workspaceName)) === gesture && (await page.eval(RINGED_PANE)) === gesture && (await page.eval(CARET_PANE)) === gesture,
            `daemon ${await daemonFocus(workspaceName)}, ring ${String(await page.eval(RINGED_PANE))}, caret ${String(await page.eval(CARET_PANE))}, new ${gesture}`
        );
        await typeText('echo cmdd7');
        await page.key('Enter');
        const intoGesture = await landedIn(gesture, 'cmdd7');
        rec.check('⌘D: typing reaches the pane it created', intoGesture.ok, `capture tail: ${intoGesture.tail}`);
    } finally {
        if (typeof workspaceID === 'string') await cli.run(['workspace', 'delete', workspaceID, '--force']);
    }
}

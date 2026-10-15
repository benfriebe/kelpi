import { commandProblem, findSuggested, routeSuggested, typedReady } from './suggested.mjs';

/** @typedef {import('./suggested.mjs').Suggested} Suggested */
/** @typedef {import('./suggested.mjs').Routing} Routing */
/** @typedef {import('../../../packages/plugin-sdk/index.js').PaneInfo} PaneInfo */
/** @typedef {import('../../../packages/plugin-sdk/index.js').TerminalRead} TerminalRead */
/**
 * What one run did. `changed` says which guarded step found the screen moved: `before` nothing
 * was typed, `after` the command sits typed in Claude's box without Enter.
 * @typedef {{ ok: true, mode: 'session' } | { ok: true, mode: 'split', paneID: string, reason: string }
 *   | { ok: false, changed: 'before' | 'after' } | { ok: false, error: string }} Outcome
 */

const VERB = 'kelpi run-suggested';
const TYPED_NOT_RUN = "the screen changed before Enter; the command is typed in Claude's box, not run";
const usage = [
    'Usage: kelpi run-suggested [--target <pane>] [--print | --yes] [--json]',
    '',
    'Shows the command Claude last suggested in a pane: the last `! command` line or bash, sh,',
    'shell or zsh code block of its latest reply.',
    '  --target <pane>  a pane id, or a label in your workspace (default: the pane you run it in)',
    '  --print          print the command and stop',
    '  --yes            run it: in the Claude session when Claude waits at an empty prompt,',
    '                   otherwise in a new split',
    '  --json           print the result as JSON',
    '',
    'Exits 1 when there is nothing to run or it was not run, 2 on a usage error.',
].join('\n');

/** @param {import('../../../packages/plugin-sdk/index.js').BackendAPI} api */
export function activate(api) {
    // Per pane: the suggestion in Claude's last reply, and the last Notification since its last Stop.
    /** @type {Map<string, Suggested>} */
    const remembered = new Map();
    /** @type {Map<string, string>} */
    const lastNotification = new Map();
    let published = false;
    let publishing = false;

    // `when` has no per-pane plugin facts, so the header chip's condition is plugin-wide. `published`
    // moves only once an update lands; a failed one is retried by the next event or command.
    const publish = () => {
        const hasSuggestion = remembered.size > 0;
        if (publishing || hasSuggestion === published) return;
        publishing = true;
        api.contributions.update({ context: { hasSuggestion } }).then(
            () => { publishing = false; published = hasSuggestion; publish(); },
            () => { publishing = false; },
        );
    };

    const stopEvents = api.agents.onEvent(event => {
        // `muted` only asks a plugin not to echo the event as a notification, which this one never does.
        if (event.type === 'stop' || event.type === 'start') lastNotification.delete(event.paneID);
        if (event.type === 'notification' && event.notificationType) lastNotification.set(event.paneID, event.notificationType);
        // Abstain leaves Claude's own permission prompt on screen.
        if (event.type === 'permission-request' && event.behavior === 'abstain') lastNotification.set(event.paneID, 'permission_prompt');
        // A Stop without the reply's text (a hook running a CLI that does not forward it, a manual
        // `kelpi event stop`, or the second of two hook sets on one pane) leaves the entry alone.
        if (event.type === 'stop' && event.agent === 'claude' && typeof event.lastAssistantMessage === 'string') {
            // A reply that suggests nothing replaces the last one's suggestion. A reply cut at the hook's
            // cap offers nothing: its last suggestion may be past the cut, or the cut may end one early.
            const found = event.lastAssistantMessageTruncated ? null : findSuggested(event.lastAssistantMessage);
            if (found) remembered.set(event.paneID, found);
            else remembered.delete(event.paneID);
        }
        // A new session never runs the last one's suggestion, even when that one ended without a session-end.
        if (event.type === 'session-start' || event.type === 'session-end') {
            remembered.delete(event.paneID);
            lastNotification.delete(event.paneID);
        }
        publish();
    });

    /** Every pane, forgetting the ones that have closed. */
    const listPanes = async () => {
        const panes = await api.panes.list({ scope: 'all' });
        const live = new Set(panes.map(pane => pane.id));
        for (const paneID of [...remembered.keys(), ...lastNotification.keys()]) {
            if (!live.has(paneID)) { remembered.delete(paneID); lastNotification.delete(paneID); }
        }
        publish();
        return panes;
    };

    /**
     * The pane as it is now, its screen, and where the suggestion would run.
     * @param {string} paneID @param {Suggested} found @param {number} [settleMs]
     */
    const inspect = async (paneID, found, settleMs) => {
        const pane = (await listPanes()).find(entry => entry.id === paneID);
        if (!pane) return null;
        // The whole viewport, uncapped: the daemon reads it from the top row and trims only trailing
        // blank rows, so line N is the cursor's row N. A `lines` cap keeps the last N lines, shifting
        // every index in a taller pane. A soft-wrapped row joins the next, moving the box up a line:
        // promptReady then finds the cursor off the prompt line, which is the safe side.
        const read = await api.terminal.read(paneID, settleMs ? { scrollback: false, settleMs } : { scrollback: false });
        const routing = routeSuggested(found, {
            status: pane.status, agent: pane.agent, sessionID: pane.agentSessionID,
            lastNotificationType: lastNotification.get(paneID), screen: read.text, cursor: read.cursor,
        });
        return { pane, read, routing };
    };

    /**
     * Runs the suggestion where `routing` says. In the session it types `! command` only while the
     * screen is still the one `read` saw, and presses Enter only while Claude's box shows what was
     * typed (typedReady) and the screen is still the one that showed it.
     * @param {Suggested} found @param {PaneInfo} pane @param {Routing} routing @param {TerminalRead} read
     * @returns {Promise<Outcome>}
     */
    const run = async (found, pane, routing, read) => {
        /** @type {'before' | 'after'} */
        let step = 'before';
        try {
            if (routing.mode === 'session') {
                await api.terminal.send(pane.id, '! ' + found.command, { bare: true, ifRevision: read.revision });
                step = 'after';
                const typed = await api.terminal.read(pane.id, { scrollback: false, settleMs: 300 });
                // The revision alone would let Enter answer whatever drew meanwhile, such as a permission menu.
                if (!typedReady(typed.text, found.command)) return { ok: false, changed: 'after' };
                await api.terminal.sendKey(pane.id, 'enter', { ifRevision: typed.revision });
                return { ok: true, mode: 'session' };
            }
            const split = await api.panes.split(pane.id, { direction: 'horizontal', path: pane.workingDirectory, focus: true });
            // Let the new shell print its prompt first; send starts a shell that is not running yet.
            await api.terminal.read(split.paneID, { settleMs: 500 }).catch(() => null);
            // Without `bare`, send presses Enter; a code block's lines go as one text and run in turn.
            await api.terminal.send(split.paneID, found.command);
            return { ok: true, mode: 'split', paneID: split.paneID, reason: routing.reason };
        } catch (error) {
            const failure = /** @type {{ code?: string, message?: string }} */ (error);
            if (failure?.code === 'SCREEN_CHANGED') return { ok: false, changed: step };
            return { ok: false, error: failure?.message ?? String(error) };
        }
    };

    /**
     * A notification in the window that ran the command; without one (NO_WINDOW) there is nowhere to show it.
     * @param {import('../../../packages/plugin-sdk/index.js').UINotificationOptions} options
     */
    const notify = options => api.ui.showNotification(options).catch(() => null);

    /** @type {(args: unknown, context: import('../../../packages/plugin-sdk/index.js').Context) => Promise<string | null>} */
    const runFromWindow = async (_args, context) => {
        const paneID = context.paneID;
        if (!paneID) { await notify({ message: 'Run suggested: no pane is focused', tone: 'warning' }); return null; }
        const found = remembered.get(paneID);
        if (!found) { await notify({ message: 'Run suggested: Claude has not suggested a command in this pane', tone: 'info' }); return null; }
        const problem = commandProblem(found.command);
        if (problem) { await notify({ message: `Run suggested: not running it: ${problem}`, tone: 'warning' }); return null; }
        const before = await inspect(paneID, found);
        if (!before) { await notify({ message: 'Run suggested: the pane is gone', tone: 'warning' }); return null; }

        const inSession = before.routing.mode === 'session';
        /** @type {string | null} */
        let action;
        try {
            action = await api.ui.showDialog({
                title: "Run Claude's suggested command?",
                // The command itself, verbatim: it is what the user confirms.
                message: found.command,
                detail: before.routing.mode === 'session' ? 'Runs in this Claude session, so Claude sees the output.' : `Runs in a new shell split: ${before.routing.reason}.`,
                cancelID: 'cancel',
                actions: inSession
                    ? [{ id: 'cancel', label: 'Cancel' }, { id: 'split', label: 'Run in new split' }, { id: 'session', label: 'Run in this Claude session', kind: 'primary' }]
                    : [{ id: 'cancel', label: 'Cancel' }, { id: 'split', label: 'Run in new split', kind: 'primary' }],
            });
        } catch (error) {
            // NO_WINDOW: `kelpi plugin run` has no window to ask in.
            if (/** @type {{ code?: string }} */ (error)?.code === 'NO_WINDOW') return null;
            throw error;
        }
        if (action !== 'session' && action !== 'split') return action;

        /** @type {Outcome} */
        let outcome;
        if (action === 'split') {
            outcome = await run(found, before.pane, { mode: 'split', reason: 'you chose a new split' }, before.read);
        } else {
            // The dialog may have been open a while: check again, after any redraw closing it caused.
            const now = await inspect(paneID, found, 300);
            if (!now || now.routing.mode !== 'session') {
                await notify({ message: 'Run suggested: Claude is no longer waiting at its prompt, nothing was sent', ...(now?.routing.mode === 'split' ? { detail: now.routing.reason } : {}), tone: 'warning' });
                return action;
            }
            outcome = await run(found, now.pane, now.routing, now.read);
        }
        if (!outcome.ok && 'changed' in outcome) {
            await notify(outcome.changed === 'before'
                ? { message: 'Run suggested: the screen changed, nothing was sent', detail: 'It changed before the command was typed.', tone: 'warning' }
                : { message: `Run suggested: ${TYPED_NOT_RUN}`, tone: 'warning' });
        } else if (!outcome.ok) {
            await notify({ message: `Run suggested: ${outcome.error}`, tone: 'error' });
        }
        return action;
    };

    /** @param {string} message @param {number} [exitCode] */
    const fail = (message, exitCode = 1) => ({ stderr: `${VERB}: ${message}`, exitCode });

    /** @type {(args: any, context: import('../../../packages/plugin-sdk/index.js').Context) => Promise<import('../../../packages/plugin-sdk/index.js').CliResult>} */
    const runFromCli = async ({ argv = [], json = false } = {}, context) => {
        /** @type {string | undefined} */
        let target;
        let print = false, yes = false;
        for (let index = 0; index < argv.length; index++) {
            const word = argv[index];
            if (word === '--help') return { text: usage };
            if (word === '--print') print = true;
            else if (word === '--yes') yes = true;
            else if (word === '--target' && argv[index + 1] !== undefined) target = argv[++index];
            else return fail(`${word === '--target' ? '--target needs a pane' : `unknown argument ${word}`}\n\n${usage}`, 2);
        }
        if (print && yes) return fail(`--print and --yes cannot be combined\n\n${usage}`, 2);

        const panes = await listPanes();
        /** @type {PaneInfo | undefined} */
        let pane;
        if (target !== undefined) {
            const labelled = panes.filter(entry => entry.label === target && (!context.workspaceID || entry.workspaceID === context.workspaceID));
            pane = panes.find(entry => entry.id === target) ?? (labelled.length === 1 ? labelled[0] : undefined);
            if (!pane) return fail(labelled.length > 1 ? `more than one pane is labelled ${target}; pass its id` : `no pane ${target}`);
        } else {
            pane = panes.find(entry => entry.id === context.paneID);
            if (!pane) return fail('no target pane (run it inside a Kelpi pane or pass --target)');
        }

        const found = remembered.get(pane.id);
        if (!found) return { ...fail('Claude has not suggested a command in this pane'), ...(json ? { json: { found: false } } : {}) };
        const problem = commandProblem(found.command);
        if (problem) return fail(`not running it: ${problem}`);
        const shown = { text: found.command, json: { command: found.command, kind: found.kind } };
        if (print) return shown;
        // A verb cannot prompt, so without --yes it only shows what would run.
        if (!yes) return { ...shown, stderr: "Pass --yes to run it, or press the Run Claude's suggested command shortcut (Ctrl+Alt+R by default) in the pane to choose where it runs." };

        const now = await inspect(pane.id, found);
        if (!now) return fail(`pane ${pane.id} is gone`);
        const outcome = await run(found, now.pane, now.routing, now.read);
        if (!outcome.ok && 'changed' in outcome) {
            return fail(outcome.changed === 'before' ? 'the screen changed, nothing was sent' : TYPED_NOT_RUN);
        }
        if (!outcome.ok) return fail(outcome.error);
        if (outcome.mode === 'session') return { text: 'ran in the Claude session', json: { ...shown.json, ran: 'session', paneID: pane.id } };
        return { text: `ran in a new split: ${outcome.reason}`, json: { ...shown.json, ran: 'split', paneID: outcome.paneID, reason: outcome.reason } };
    };

    const disposers = [
        stopEvents,
        api.commands.register('example.run-suggested.run', runFromWindow),
        api.commands.register('example.run-suggested.cli', runFromCli),
    ];
    return () => { for (const dispose of disposers) dispose(); };
}

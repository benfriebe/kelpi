/**
 * Auto-approve: allow Claude's Bash commands for a limited time, in every Claude pane, for
 * unattended runs. The `kelpi.agent.permissions` provider (docs/plugin-services.md, "Agent
 * permission decisions"): Claude's PermissionRequest hook hands the daemon the real command and
 * the daemon asks this provider, so nothing is read from the screen. While on, a Bash command
 * that passes the never-auto-approve list (`policy.mjs`) is allowed; everything else abstains and
 * Claude shows its own prompt. It never denies. Nothing is persisted: a daemon or plugin restart
 * turns it off.
 */

import { judgeCommand } from './policy.mjs';

const SERVICE = 'kelpi.agent.permissions';
const PROVIDER = 'example.auto-approve.permissions';
const ITEM = 'example.auto-approve.status';
const DEFAULT_MINUTES = 10;
/** A week. */
const MAX_MINUTES = 10_080;
/** `status` keeps the latest commands left for the user, not all of a week-long run. */
const LEFT_CAP = 100;
/** A left command is kept to this many characters for display. */
const COMMAND_CAP = 200;
const MINUTE = 60_000;

const SELECT_HINT = `Select it with: kelpi plugin service-select ${SERVICE} ${PROVIDER} (or Settings > Plugins > Service providers).`;
/** @type {import('../../../packages/plugin-sdk/index.js').ContributionItemPatch} */
const OFF_ITEM = { text: 'Auto-approve off', tone: 'default', tooltip: `Click to turn auto-approve on for ${DEFAULT_MINUTES} minutes` };

const usage = [
    'Usage:',
    '  kelpi auto-approve on [minutes]   Allow Claude\'s Bash commands in every Claude pane',
    `                                    for this long (default ${DEFAULT_MINUTES} minutes, at most ${MAX_MINUTES})`,
    '  kelpi auto-approve off            Stop now',
    '  kelpi auto-approve status         On or off, until when, and what was approved or left',
    '  Add --json for the state as JSON.',
    '',
    'Only Bash commands are approved: MCP, Fetch and file edit prompts wait for you. It never',
    'approves a command on the never-auto-approve list (rm -r, git push, sudo, curl | sh, and',
    'others) or one that spans lines: those prompts wait for you. The list is best effort, not a',
    `sandbox. Nothing is approved until this plugin is the selected ${SERVICE}`,
    'provider. A daemon or plugin restart turns it off.',
].join('\n');

/** @param {string} text Every control character a space, so a left command cannot drive the terminal `status` prints to. */
const printable = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/** @param {Date} date HH:MM in local time, for the end shown to the user. */
const clock = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

/** @param {number} ms Time left for the status bar: whole minutes rounded up, "<1m" in the last one (a tick lands on its start). */
const timeLeft = (ms) => {
    if (ms <= MINUTE) return '<1m';
    const minutes = Math.ceil(ms / MINUTE);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
    return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours / 24}d`;
};

/**
 * @typedef {object} LeftCommand A command left for the user, and why.
 * @property {string} paneID
 * @property {string | null} workspaceID
 * @property {string} reason
 * @property {string} command
 * @property {string} at
 */

/**
 * @typedef {object} Selection Whether the daemon asks this provider.
 * @property {boolean} selected
 * @property {string | null} selectedProviderID
 * @property {string | null} activeProviderID
 * @property {string | null} error
 */

/** @param {import('../../../packages/plugin-sdk/index.js').BackendAPI} api */
export function activate(api) {
    // `deadline` (monotonic, performance.now()) decides, so setting the clock back cannot extend a
    // run. `wallEndsAt` is shown, and also ends it: the monotonic clock stops while the Mac sleeps.
    /** @type {number | null} */
    let deadline = null;
    /** @type {Date | null} */
    let wallEndsAt = null;
    let approved = 0;
    let leftCount = 0;
    /** @type {LeftCommand[]} */
    let left = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    let expiry = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let tick = null;

    const remaining = () => deadline === null || wallEndsAt === null ? 0 : Math.min(deadline - performance.now(), wallEndsAt.getTime() - Date.now());
    const isOn = () => remaining() > 0;

    const publish = () => {
        /** @type {import('../../../packages/plugin-sdk/index.js').ContributionItemPatch} */
        const item = isOn() && wallEndsAt !== null
            ? { text: `Auto-approve ${timeLeft(remaining())}`, tone: 'success', tooltip: `On until ${clock(wallEndsAt)}. Click to turn off.` }
            : OFF_ITEM;
        try {
            Promise.resolve(api.contributions.update({ items: { [ITEM]: item } })).catch(() => {});
        } catch {
            // Nothing to patch right now; the next change publishes again.
        }
    };
    const stop = () => {
        if (expiry !== null) clearTimeout(expiry);
        if (tick !== null) clearInterval(tick);
        expiry = tick = null;
        deadline = null;
        wallEndsAt = null;
    };
    const off = () => {
        stop();
        publish();
    };
    // A deadline the timers have not caught up with (a late timer, a machine that slept) is off now.
    const refresh = () => (deadline !== null && !isOn() ? off() : publish());
    /** @param {number} minutes Restarts the window and the counts from now, on or not. */
    const on = (minutes) => {
        stop();
        deadline = performance.now() + minutes * MINUTE;
        wallEndsAt = new Date(Date.now() + minutes * MINUTE);
        approved = 0;
        leftCount = 0;
        left = [];
        expiry = setTimeout(off, minutes * MINUTE);
        tick = setInterval(refresh, MINUTE);
        publish();
    };

    /**
     * @param {unknown} paneID
     * @param {unknown} workspaceID
     * @param {string} reason
     * @param {unknown} command
     */
    const leave = (paneID, workspaceID, reason, command) => {
        const text = typeof command === 'string' ? printable(command) : '';
        leftCount += 1;
        left.push({
            paneID: typeof paneID === 'string' ? paneID : '?',
            workspaceID: typeof workspaceID === 'string' ? workspaceID : null,
            reason,
            command: text.length > COMMAND_CAP ? `${text.slice(0, COMMAND_CAP)}…` : text,
            at: new Date().toISOString(),
        });
        if (left.length > LEFT_CAP) left.splice(0, left.length - LEFT_CAP);
    };

    /**
     * The service's one method. Synchronous and without I/O, well inside the daemon's 2 second
     * deadline. Only ever allow or abstain: a thrown error abstains here rather than in the daemon.
     * @param {import('../../../packages/plugin-sdk/index.js').Data} args An `AgentPermissionArgs`, checked as it is read.
     * @returns {import('../../../packages/plugin-sdk/index.js').AgentPermissionDecision}
     */
    const decide = (args) => {
        try {
            // Checked on every call, not left to the expiry timer: a late timer must never leak an allow.
            if (!isOn()) return { behavior: 'abstain' };
            if (args.agent !== 'claude' || args.toolName !== 'Bash') return { behavior: 'abstain' };
            const input = args.toolInput;
            const command = input !== null && typeof input === 'object' && !Array.isArray(input) ? input['command'] : undefined;
            const judgement = judgeCommand(command);
            if (judgement.allow) {
                approved += 1;
                return { behavior: 'allow' };
            }
            leave(args.paneID, args.workspaceID, judgement.reason, command);
        } catch {
            // Fall through to Claude's own prompt.
        }
        return { behavior: 'abstain' };
    };

    /**
     * Read through the services API, never from `decide`, which must not wait on the daemon.
     * @returns {Promise<Selection>}
     */
    const selection = async () => {
        try {
            const service = (await api.services.list()).find((entry) => entry.id === SERVICE);
            const selectedProviderID = service?.selectedProviderID ?? null;
            const activeProviderID = service?.activeProviderID ?? null;
            return { selected: selectedProviderID === PROVIDER, selectedProviderID, activeProviderID, error: null };
        } catch (error) {
            return { selected: false, selectedProviderID: null, activeProviderID: null, error: error instanceof Error ? error.message : String(error) };
        }
    };
    /** @param {Selection} found Why nothing is approved, or null when this provider is asked. */
    const warning = (found) => {
        if (found.error !== null) return `Could not check whether this plugin is the selected ${SERVICE} provider (${found.error}). ${SELECT_HINT}`;
        if (!found.selected) return `This plugin is not the selected ${SERVICE} provider, so nothing is approved. ${SELECT_HINT}`;
        if (found.activeProviderID !== PROVIDER) return `This plugin is the selected ${SERVICE} provider but is not available (the daemon asks ${found.activeProviderID ?? 'none'}), so nothing is approved.`;
        return null;
    };

    /** @param {Selection} found */
    const state = (found) => {
        const live = isOn();
        return {
            on: live,
            endsAt: live ? wallEndsAt?.toISOString() ?? null : null,
            remainingSeconds: live ? Math.ceil(remaining() / 1000) : 0,
            approved,
            leftCount,
            left: left.map((entry) => ({ ...entry })),
            selected: found.selected,
            selectedProviderID: found.selectedProviderID,
            activeProviderID: found.activeProviderID,
        };
    };
    const summary = () => {
        const counts = `${approved} approved, ${leftCount} left for you.`;
        const lines = [isOn() && wallEndsAt !== null ? `Auto-approve is on until ${clock(wallEndsAt)}. ${counts}` : `Auto-approve is off. ${counts}`];
        for (const entry of left) lines.push(`  ${entry.paneID}: ${entry.reason}${entry.command ? `: ${printable(entry.command)}` : ''}`);
        return lines.join('\n');
    };

    /** @param {string} message */
    const usageError = (message) => ({ stderr: `${message}\n\n${usage}`, exitCode: 2 });

    /**
     * `kelpi auto-approve on [minutes] | off | status [--json]`, from `contributes.cli`.
     * @param {Partial<import('../../../packages/plugin-sdk/index.js').CliInvocation>} invocation
     */
    const cli = async ({ argv, json } = {}) => {
        const words = Array.isArray(argv) ? argv.map(String) : [];
        const [action, ...rest] = words;
        if (words.includes('--help') || action === '-h' || action === 'help') return { text: usage };
        if (action === undefined) return usageError('Missing auto-approve action');
        if (action !== 'on' && action !== 'off' && action !== 'status') return usageError(`Unknown auto-approve action: ${action}`);
        let minutes = DEFAULT_MINUTES;
        if (action === 'on' && rest.length > 0) {
            const raw = rest.shift() ?? '';
            minutes = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
            if (!(minutes >= 1 && minutes <= MAX_MINUTES)) return usageError(`Minutes must be a whole number from 1 to ${MAX_MINUTES}`);
        }
        if (rest.length > 0) return usageError(`Unexpected argument to auto-approve ${action}: ${rest[0]}`);
        if (action === 'on') on(minutes);
        else if (action === 'off') off();
        else refresh();
        const found = await selection();
        const problem = action === 'off' ? null : warning(found);
        return {
            text: summary(),
            ...(json ? { json: state(found) } : {}),
            // On stderr, so a script reading the state line can tell the two apart.
            ...(problem === null ? {} : { stderr: problem }),
        };
    };

    /** @param {import('../../../packages/plugin-sdk/index.js').UINotificationOptions} options */
    const notify = (options) => {
        try {
            Promise.resolve(api.ui.showNotification(options)).catch(() => null);
        } catch {
            // No window to show it in, from `kelpi plugin run` for one: the toggle still happened.
        }
    };

    /** The palette command and the status bar item: off turns on for the default time, on turns off. */
    const toggle = async () => {
        if (isOn()) off();
        else on(DEFAULT_MINUTES);
        const found = await selection();
        if (!isOn() || wallEndsAt === null) notify({ message: 'Auto-approve is off.', tone: 'info' });
        else {
            const problem = warning(found);
            notify(problem === null
                ? { message: `Auto-approve is on until ${clock(wallEndsAt)}.`, tone: 'success' }
                : { message: `Auto-approve is on until ${clock(wallEndsAt)}, but nothing is approved.`, detail: problem, tone: 'warning' });
        }
        return state(found);
    };

    const disposers = [
        api.providers.register(PROVIDER, { decide }),
        api.commands.register('example.auto-approve.cli', cli),
        api.commands.register('example.auto-approve.toggle', toggle),
    ];
    publish();
    return () => {
        stop();
        for (const dispose of disposers.reverse()) dispose();
    };
}

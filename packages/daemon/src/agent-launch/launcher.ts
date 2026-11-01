/**
 * Starting an agent in a new workspace's first pane: the daemon's half.
 * Spec: docs/agent-lifecycle.md §6.5 (this module), docs/wire-protocol.md §6.3 (`start_agent`,
 * `agent_prompt`, `send_prompt`, and the `agent-launch` frame this module produces).
 *
 * `@kelpi/core/agent`'s launch module says WHAT to type and WHETHER an agent is ready; this one
 * owns the clock, the PTY, the terminal state and the session store, and decides WHEN. One
 * pending launch per pane, in memory only, through two phases:
 *
 *   1. **awaiting-shell**: nothing is typed before the pane has produced output (a write would
 *      force a spawn the gate is holding for the client's geometry, `pty/spawn-gate.ts`). Then
 *      the launch line is typed at the first sign the shell is at its prompt
 *      (`agentShellReadySignal`): for a zsh running Kelpi's shell integration, the integration's
 *      `precmd` report (OSC 7, `shellReported`) and then zle's own `CSI ? 2004 h` (a fresh
 *      DECSET, counted by the parser, even when an instant prompt latched 2004 on ~0.5 s early;
 *      `shellPasteEdgeMs` after the report at the latest); for zsh without it and fish,
 *      bracketed paste turning on; for any OTHER shell, bracketed paste (bash 5.1+) or
 *      `shellSettleMs` with no output since the LAST output. zsh and fish never take the quiet
 *      path: their startup prints and goes quiet before the prompt is up. `shellReadyCapMs`
 *      after the first output is the
 *      backstop, and there the line is typed only if a fresh foreground check finds the SHELL in
 *      charge of the terminal; anything else in front (`tmux attach`, an `ssh-add` passphrase
 *      prompt run by an rc file) is `failed` (`timeout`) with nothing typed. With no prompt the
 *      launch is `launched`; in send mode the prompt rides the line and the launch is `sent`.
 *      Send mode in a shell whose syntax the line is not (`shellSupportsSendMode`) is `failed`
 *      (`unsupported-shell`) with nothing typed.
 *   2. **awaiting-agent** (prefill only): every output chunk (once the terminal state has parsed
 *      it), mode change, session binding, keystroke and requested recheck asks the readiness
 *      predicate (`AgentReadiness`, default `defaultAgentReadiness`). Ready → one more,
 *      FRESH foreground check, and only if the shell does not have the terminal is the prompt
 *      pasted, bracketed and without Enter (`prefilled`). Anything else ends in `fallback`,
 *      including `readyMaxWaitMs` passing with the budget still held by a trust dialog.
 *
 * Exactly one `agent-launch` frame per launch (`deliver`), never a second: a finished launch is
 * forgotten, and after `abandonAll` (the daemon is stopping or handing off) the launcher is inert.
 * The frame's `prompt` / `promptFile` ride on `fallback` / `failed` only; logs carry the prompt
 * file's path and never the prompt.
 *
 * The launcher listens to PTY output, exits and the store only while a launch is pending, so a
 * daemon that never starts an agent pays nothing per byte.
 */

import {
    AGENT_READY_MAX_WAIT_MS,
    AGENT_READY_TIMEOUT_MS,
    AGENT_SHELL_READY_CAP_MS,
    AGENT_SHELL_SETTLE_MS,
    agentShellReadySignal,
    defaultAgentReadiness,
    sendModeCommandLine,
    shellBasename,
    shellSupportsSendMode,
    type AgentKind,
    type AgentLaunchModeName,
    type AgentLaunchModes,
    type AgentReadiness,
    type AgentReadinessResult,
    type AgentReadinessSignals,
    type AgentShellReadySignal
} from '@kelpi/core/agent';
import {
    WS_AGENT_LAUNCH_MESSAGE,
    type WsAgentLaunchMessage,
    type WsAgentLaunchOutcome,
    type WsAgentLaunchReason
} from '@kelpi/protocol';

import type { PtyManager, TerminalInput, VtModes } from '../seams.js';
import { findPaneAnywhere, type KelpiStore } from '../store/index.js';
import type { PromptFileStore } from './prompt-files.js';

// ── contracts ───────────────────────────────────────────────────────────────────────

/** What a create asked for, after the handler has validated and normalized it. */
export interface AgentLaunchRequest {
    readonly kind: AgentKind;
    /** `normalizeAgentPrompt`'s text; null = nothing to deliver (the agent is only started). */
    readonly prompt: string | null;
    /** Send mode: the prompt rides the launch line. False = prefill. */
    readonly send: boolean;
    /** The daemon-written copy of `prompt` (`PromptFileStore`); null exactly when `prompt` is. */
    readonly promptFile: string | null;
}

export interface AgentLaunchStart {
    /** The pane the create actually spawned (`spawnFirstPane`'s answer). */
    readonly paneID: string;
    readonly workspaceID: string;
    readonly request: AgentLaunchRequest;
    /** The WS session that sent the create (`ReplyHandle.originClientID`); absent = the CLI. */
    readonly originClientID?: string | undefined;
}

/** Hands one outcome frame to whoever should see it (`createAgentLaunchDelivery`). */
export type AgentLaunchDeliver = (message: WsAgentLaunchMessage, originClientID: string | undefined) => void;

export type AgentLaunchAbandonReason = Extract<WsAgentLaunchReason, 'daemon-stopping'>;

export interface AgentLauncher {
    /** Write a create's normalized prompt to its file; returns the path. Throws on failure. */
    preparePromptFile(prompt: string): string;
    /** Remove a prompt file whose create failed. Never throws. */
    discardPromptFile(path: string): void;
    /** Begin a launch in a freshly created pane. Exactly one frame follows, later. */
    start(launch: AgentLaunchStart): void;
    /** The pane's VT modes changed (`onModesChange`, after the chunk that changed them parsed). */
    modesChanged(paneID: string): void;
    /**
     * The pane's shell reported its directory (OSC 7, parsed by the terminal state). Kelpi's zsh
     * integration does it from `precmd`, right before each prompt, so for a pane running it the
     * first report is "the rc files are done" (`agentShellReadySignal`'s `shell-integration`).
     */
    shellReported(paneID: string): void;
    /** Bytes are about to be written INTO the pane by someone other than this launcher. */
    inputWritten(paneID: string, data: Uint8Array | string): void;
    /**
     * Report every pending launch now (`failed` before its line was typed, `fallback` after) and
     * go inert: later starts fail at once, and nothing that happens to a pane afterwards sends a
     * second frame. Called at the top of a stop and before a handoff closes the WS server.
     */
    abandonAll(reason: AgentLaunchAbandonReason): void;
    /** Launches still waiting (diagnostics, tests). */
    readonly pending: number;
}

/** What the launcher reads off the daemon's terminal state. */
export interface AgentLauncherTerminal {
    modes(paneID: string): VtModes;
    /** The pane is on the alternate screen (`TerminalStateServiceImpl.alternateScreen`). */
    alternateScreen(paneID: string): boolean;
    /** DECRST 2004s parsed so far (`TerminalStateServiceImpl.bracketedPasteResets`). */
    bracketedPasteResets(paneID: string): number;
    /** DECSET 2004s parsed so far, repeats included (`TerminalStateServiceImpl.bracketedPasteSets`). */
    bracketedPasteSets(paneID: string): number;
    capture(paneID: string, opts: { scrollback: boolean }): string;
    /** Resolves once every byte fed so far has been parsed. */
    flush(paneID: string): Promise<void>;
}

/**
 * A pane that has printed nothing this long after its create gets `failed` (`timeout`): a shell
 * that has said nothing is not one this launcher knows to be at a prompt. Long, because a spawn
 * can wait for geometry (2 s) and a heavy shell startup can print nothing for several seconds
 * before its prompt.
 *
 * The launch line is never typed into a pane that has said nothing, and never by the clock alone:
 * the one path that does not wait for the shell's own signal, `AGENT_SHELL_READY_CAP_MS`, types
 * only once a fresh foreground check finds the shell in charge of the terminal. What that check
 * cannot see is a shell BUILTIN reading the terminal (an rc file's `read -q "?Update now?"`): the
 * shell is the foreground group then too, so the line is typed and the builtin reads it.
 */
export const AGENT_FIRST_OUTPUT_TIMEOUT_MS = 30_000;

/**
 * Under Kelpi's zsh integration, how long after the integration's first `precmd` report the
 * launcher waits for zle's own `CSI ? 2004 h` before it types on the report alone.
 *
 * The report says the rc files are done, but zle starts reading 1-3 ms LATER, and until it
 * does the terminal is still in cooked mode with echo on: a line typed in that gap is echoed raw
 * above the prompt (`^[[200~codex "$(command cat '…') "^[[201~`, 6 of 19 instant-prompt panes,
 * 2026-10-07), though the shell still runs it. zle writes `CSI ? 2004 h` as it starts, even when
 * an instant prompt latched the mode on long before, so the launcher waits for that DECSET
 * (`bracketedPasteSets` past its value at the report). A zsh that never writes it (a widget set
 * that turns 2004 on differently) is held only this long, not until the cap.
 */
export const AGENT_SHELL_PASTE_EDGE_MS = 250;

/**
 * While waiting for the agent, the wait is re-run this often even when nothing happens, so the
 * foreground answer it judges by is never older than this (plus one lookup). Needed in every
 * state: an answer can be taken while a short-lived child holds the terminal (zsh forks before it
 * finds a command does not exist), or just before an agent exits, and the shell's prompt that
 * follows may be the last output the pane produces.
 *
 * 250 ms rather than less because each poll that needs a fresh answer is a `ps` on macOS: four a
 * second per waiting launch, and launches that ask in the same turn share one (`pty/foreground.ts`
 * batches them). Nothing waits on the poll to paste: readiness is asked again on every output
 * chunk, mode change and session event, and the check before a paste is always fresh.
 */
export const AGENT_FOREGROUND_POLL_MS = 250;

/**
 * While waiting for the agent, a foreground answer younger than this is reused rather than asked
 * again: an agent's startup is a burst of output chunks, each of which would otherwise run `ps`.
 * The same as the poll, so the chunks between two polls share the answer the earlier poll took and
 * a poll always asks afresh (its answer is a poll old by then). The check immediately before a
 * paste, and the one at `AGENT_SHELL_READY_CAP_MS`, are ALWAYS fresh.
 */
export const AGENT_FOREGROUND_REUSE_MS = AGENT_FOREGROUND_POLL_MS;

/**
 * The same, while the budget is paused at a trust dialog: a human may take minutes, and the one
 * thing to notice meanwhile is the agent quitting ("No, exit" leaves the shell at its prompt).
 */
export const AGENT_DIALOG_POLL_MS = 1_000;

export interface AgentLaunchTimings {
    readonly shellSettleMs: number;
    readonly shellReadyCapMs: number;
    /** `AGENT_SHELL_PASTE_EDGE_MS`. */
    readonly shellPasteEdgeMs: number;
    readonly firstOutputTimeoutMs: number;
    readonly readyTimeoutMs: number;
    /** `AGENT_READY_MAX_WAIT_MS`: the whole wait from the line, trust-dialog pauses included. */
    readonly readyMaxWaitMs: number;
    readonly foregroundReuseMs: number;
    readonly foregroundPollMs: number;
    readonly dialogPollMs: number;
}

export const DEFAULT_AGENT_LAUNCH_TIMINGS: AgentLaunchTimings = {
    shellSettleMs: AGENT_SHELL_SETTLE_MS,
    shellReadyCapMs: AGENT_SHELL_READY_CAP_MS,
    shellPasteEdgeMs: AGENT_SHELL_PASTE_EDGE_MS,
    firstOutputTimeoutMs: AGENT_FIRST_OUTPUT_TIMEOUT_MS,
    readyTimeoutMs: AGENT_READY_TIMEOUT_MS,
    readyMaxWaitMs: AGENT_READY_MAX_WAIT_MS,
    foregroundReuseMs: AGENT_FOREGROUND_REUSE_MS,
    foregroundPollMs: AGENT_FOREGROUND_POLL_MS,
    dialogPollMs: AGENT_DIALOG_POLL_MS
};

export interface AgentLauncherOptions {
    /** The store, for "is the pane still there" (R7) and the pane's agent session binding. */
    readonly store: Pick<KelpiStore, 'getState' | 'subscribe'>;
    /**
     * The PTY layer the launcher listens to. `has` answers true for a spawn the gate is holding,
     * which is what "the pane is still there" should mean while it waits.
     */
    readonly pty: Pick<PtyManager, 'has' | 'onData' | 'onExit'>;
    /**
     * How the launcher types. Must write through a manager that does NOT report to
     * `inputWritten` (boot gives it the un-observed one): its own writes are not a user typing.
     */
    readonly input: Pick<TerminalInput, 'sendText'>;
    readonly term: AgentLauncherTerminal;
    /** The shell the pane's PTY runs (`KelpiPtyManager.shell`); undefined = unknown. */
    readonly shellOf: (paneID: string) => string | undefined;
    /**
     * The pane's shell was started with Kelpi's shell integration (`pty/shell-integration.ts`),
     * so its `precmd` reports arrive as `shellReported`. Absent = never (no integration).
     */
    readonly shellIntegrated?: ((paneID: string) => boolean) | undefined;
    /**
     * Whether the pane's shell is the terminal's foreground process group (`pty/foreground.ts`).
     * Rejects when it cannot tell, which never counts as "the agent has the terminal".
     */
    readonly foregroundIsShell: (paneID: string) => Promise<boolean>;
    /** The launch command for `kind`, read when the line is typed (Settings edits apply). */
    readonly commandFor: (kind: AgentKind) => string;
    readonly deliver: AgentLaunchDeliver;
    readonly promptFiles: PromptFileStore;
    readonly readiness?: AgentReadiness | undefined;
    readonly timings?: Partial<AgentLaunchTimings> | undefined;
    /** Epoch ms; every signal timestamp is on this clock. */
    readonly now?: (() => number) | undefined;
    readonly log?: ((line: string) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

// ── delivery ────────────────────────────────────────────────────────────────────────

export interface AgentLaunchDeliveryOptions {
    /** One session by id; false when it is gone, not ready, or the hub has closed. */
    readonly sendToClient: (clientID: string, message: WsAgentLaunchMessage) => boolean;
    /** Every attached client. */
    readonly broadcast: (message: WsAgentLaunchMessage) => void;
}

/**
 * The routing rule (wire-protocol.md §6.3): every outcome goes to the session that sent the
 * create when it is still there. When there is none (a control-socket create) or it has gone,
 * a success goes nowhere (nobody needs to act on it) and `fallback` / `failed` go to every client
 * with `broadcast: true`, so an undelivered prompt still reaches a human and only the window that
 * asked auto-copies it.
 */
export function createAgentLaunchDelivery(options: AgentLaunchDeliveryOptions): AgentLaunchDeliver {
    return (message, originClientID) => {
        if (originClientID !== undefined && options.sendToClient(originClientID, message)) return;
        if (message.outcome !== 'fallback' && message.outcome !== 'failed') return;
        options.broadcast({ ...message, broadcast: true });
    };
}

// ── typed input ─────────────────────────────────────────────────────────────────────

/**
 * Sequences a terminal SENDS on its own rather than because someone typed: focus in/out
 * (DEC 1004), mouse reports in the SGR, X10 and urxvt encodings, device and cursor reports, the
 * kitty flags reply, OSC and DCS answers (colours, XTVERSION), and kitty key-release events.
 * Agents turn mouse tracking and focus events on as they start, so a mouse moving over the pane
 * or a window gaining focus must not read as the user typing into it.
 */
const TERMINAL_REPORTS = new RegExp(
    [
        String.raw`\x1b\[[IO]`,
        String.raw`\x1b\[<\d+;\d+;\d+[Mm]`,
        String.raw`\x1b\[M[\s\S]{3}`,
        String.raw`\x1b\[\d+;\d+;\d+M`,
        String.raw`\x1b\[[?>][\d;]*c`,
        String.raw`\x1b\[\??\d+(?:;\d+)*[nR]`,
        String.raw`\x1b\[\?\d*u`,
        String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`,
        String.raw`\x1bP[^\x1b]*\x1b\\`,
        String.raw`\x1b\[[\d:]*;\d+:3(?:;[\d:]*)?[u~A-Z]`
    ].join('|'),
    'g'
);

/** True when `data` holds anything besides terminal reports: a person (or a script) typed. */
export function isTypedInput(data: Uint8Array | string): boolean {
    // latin1 keeps one character per byte, so a multi-byte keystroke still counts as typed.
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('latin1');
    return text.replace(TERMINAL_REPORTS, '') !== '';
}

// ── the launcher ────────────────────────────────────────────────────────────────────

type Phase = 'awaiting-shell' | 'awaiting-agent';

interface ForegroundAnswer {
    /** null = the lookup failed. */
    readonly shell: boolean | null;
    /** When the lookup STARTED (the reuse window). */
    readonly askedAt: number;
    /** `nextTick()` when the lookup started: orders it against observations, which ms cannot. */
    readonly askedTick: number;
}

interface PendingLaunch {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly request: AgentLaunchRequest;
    readonly originClientID: string | undefined;
    phase: Phase;
    done: boolean;
    /** awaiting-shell: decided at the first output, from the shell the pane runs. */
    shellSignal: AgentShellReadySignal | null;
    firstOutputAt: number | null;
    /** awaiting-shell: a flush is queued before the next 2004 check. */
    shellCheckQueued: boolean;
    /** awaiting-shell: the shell has sent an OSC 7 since the launch began (`shellReported`). */
    shellReported: boolean;
    /** awaiting-shell: `bracketedPasteSets` when the first report was parsed; null before it. */
    pasteSetsAtReport: number | null;
    /** awaiting-shell: `shellPasteEdgeMs` has passed since the first report without zle's DECSET. */
    pasteEdgeWaitOver: boolean;
    /** awaiting-shell: the cap's foreground check is out; nothing else may start another. */
    capCheckPending: boolean;
    /** Since the line was typed (awaiting-agent); since the start (awaiting-shell). */
    lastOutputAt: number | null;
    modes: AgentLaunchModes;
    modeChangedAt: Record<AgentLaunchModeName, number | null>;
    /** When the launch line was typed. */
    launchedAt: number | null;
    /** `bracketedPasteResets` when the line was typed. */
    pasteResetsAtLaunch: number;
    /**
     * `nextTick()` when the launcher first saw 2004 back ON after a DECRST that came after the
     * line: the shell ran the line, and someone (the agent, or the shell back at its prompt)
     * turned it on again.
     */
    pasteBackOnTick: number | null;
    userInput: boolean;
    /** The pane's session id when the line was typed, and the last one seen since. */
    sessionIDAtLaunch: string | null;
    sessionID: string | null;
    sessionBound: boolean;
    sessionBoundAt: number | null;
    holdingSince: number | null;
    lastAnswer: AgentReadinessResult | null;
    /** The predicate said ready while bracketed paste was off: nothing may be pasted unframed. */
    readyButUnframed: boolean;
    foreground: ForegroundAnswer | null;
    /** The latest answer that WAS an answer (`shell` not null), for the timeout's reason. */
    lastKnownForeground: ForegroundAnswer | null;
    /** The ready timeout's remaining budget, and since when it has been running (null = paused). */
    budgetMs: number;
    runningSince: number | null;
    timers: {
        firstOutput?: NodeJS.Timeout | undefined;
        cap?: NodeJS.Timeout | undefined;
        settle?: NodeJS.Timeout | undefined;
        pasteEdge?: NodeJS.Timeout | undefined;
        recheck?: NodeJS.Timeout | undefined;
        timeout?: NodeJS.Timeout | undefined;
        maxWait?: NodeJS.Timeout | undefined;
    };
    evaluating: boolean;
    dirty: boolean;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function unrefTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
    timer.unref?.();
    return timer;
}

export function createAgentLauncher(options: AgentLauncherOptions): AgentLauncher {
    const { store, pty, input, term, promptFiles } = options;
    const readiness = options.readiness ?? defaultAgentReadiness;
    const timings: AgentLaunchTimings = { ...DEFAULT_AGENT_LAUNCH_TIMINGS, ...options.timings };
    const clock = options.now ?? (() => Date.now());
    const pending = new Map<string, PendingLaunch>();
    let abandoned = false;
    /** Set around the launcher's own writes, so a mis-wired `input` cannot read as a user typing. */
    let writing = false;
    let listening: (() => void) | null = null;
    /** Strictly increasing, so "this lookup started after that observation" is exact. */
    let ticks = 0;
    const nextTick = (): number => {
        ticks += 1;
        return ticks;
    };

    const report = (error: unknown, context: string): void => {
        try {
            options.onError?.(toError(error), context);
        } catch {
            // Reporting is best effort.
        }
    };
    const log = (line: string): void => {
        try {
            options.log?.(line);
        } catch {
            // Logging is best effort.
        }
    };

    // ── listeners (only while something is pending: R13) ───────────────────────────

    const syncListeners = (): void => {
        if (pending.size > 0 && listening === null) {
            const offData = pty.onData((paneID) => {
                const launch = pending.get(paneID);
                if (launch !== undefined) onOutput(launch);
            });
            const offExit = pty.onExit((paneID) => {
                const launch = pending.get(paneID);
                if (launch !== undefined) end(launch, 'pane-exited');
            });
            const offStore = store.subscribe(() => {
                for (const launch of [...pending.values()]) onStoreChange(launch);
            });
            listening = () => {
                offData();
                offExit();
                offStore();
            };
        } else if (pending.size === 0 && listening !== null) {
            const off = listening;
            listening = null;
            off();
        }
    };

    // ── shared helpers ──────────────────────────────────────────────────────────────

    const paneInStore = (paneID: string): boolean => findPaneAnywhere(store.getState(), paneID) !== null;

    /** R7: the pane is still in the store AND has a PTY (or a spawn the gate is holding). */
    const paneAlive = (launch: PendingLaunch): boolean => paneInStore(launch.paneID) && pty.has(launch.paneID);

    const clearTimer = (launch: PendingLaunch, name: keyof PendingLaunch['timers']): void => {
        const timer = launch.timers[name];
        if (timer !== undefined) clearTimeout(timer);
        launch.timers[name] = undefined;
    };

    const clearTimers = (launch: PendingLaunch): void => {
        for (const name of Object.keys(launch.timers) as (keyof PendingLaunch['timers'])[]) clearTimer(launch, name);
    };

    const finish = (launch: PendingLaunch, outcome: WsAgentLaunchOutcome, reason?: WsAgentLaunchReason): void => {
        if (launch.done) return;
        launch.done = true;
        clearTimers(launch);
        if (pending.get(launch.paneID) === launch) pending.delete(launch.paneID);
        syncListeners();
        const { kind, prompt, promptFile } = launch.request;
        const undelivered = (outcome === 'fallback' || outcome === 'failed') && prompt !== null;
        const message: WsAgentLaunchMessage = {
            type: WS_AGENT_LAUNCH_MESSAGE,
            workspaceID: launch.workspaceID,
            paneID: launch.paneID,
            agent: kind,
            outcome,
            ...(reason !== undefined ? { reason } : {}),
            ...(undelivered ? { prompt, ...(promptFile !== null ? { promptFile } : {}) } : {})
        };
        // The path, never the text: a prompt can hold anything a user pasted into the sheet.
        log(
            `agent launch: pane ${launch.paneID} (${kind}) ${outcome}${reason !== undefined ? ` (${reason})` : ''}` +
                (promptFile !== null ? `; prompt file ${promptFile}` : '')
        );
        try {
            options.deliver(message, launch.originClientID);
        } catch (error) {
            report(error, `agent launch delivery ${launch.paneID}`);
        }
    };

    /** The pane went away or something gave up: `failed` before the line was typed, `fallback` after. */
    const end = (launch: PendingLaunch, reason: WsAgentLaunchReason): void => {
        finish(launch, launch.phase === 'awaiting-shell' ? 'failed' : 'fallback', reason);
    };

    const observeModes = (launch: PendingLaunch): void => {
        let bracketedPaste = false;
        let alternateScreen = false;
        try {
            bracketedPaste = term.modes(launch.paneID).bracketedPaste;
            alternateScreen = term.alternateScreen(launch.paneID);
        } catch (error) {
            report(error, `agent launch modes ${launch.paneID}`);
        }
        const now = clock();
        if (bracketedPaste !== launch.modes.bracketedPaste) launch.modeChangedAt.bracketedPaste = now;
        if (alternateScreen !== launch.modes.alternateScreen) launch.modeChangedAt.alternateScreen = now;
        launch.modes = { bracketedPaste, alternateScreen };
        if (launch.phase === 'awaiting-agent' && bracketedPaste && launch.pasteBackOnTick === null) {
            let resets = launch.pasteResetsAtLaunch;
            try {
                resets = term.bracketedPasteResets(launch.paneID);
            } catch (error) {
                report(error, `agent launch modes ${launch.paneID}`);
            }
            if (resets > launch.pasteResetsAtLaunch) launch.pasteBackOnTick = nextTick();
        }
    };

    /** The pane's binding as the store has it now; true when it changed since last looked at. */
    const observeSession = (launch: PendingLaunch): boolean => {
        const id = findPaneAnywhere(store.getState(), launch.paneID)?.pane.agentSessionID ?? null;
        if (id === launch.sessionID) return false;
        launch.sessionID = id;
        // Only a binding that arrived after the line was typed is this agent's.
        if (id !== null && id !== launch.sessionIDAtLaunch) {
            launch.sessionBound = true;
            launch.sessionBoundAt ??= clock();
        } else {
            launch.sessionBound = false;
        }
        return true;
    };

    const typing = (paneID: string, text: string, bare: boolean): void => {
        writing = true;
        try {
            input.sendText(paneID, text, { bare });
        } finally {
            writing = false;
        }
    };

    // ── phase 1: awaiting the shell ─────────────────────────────────────────────────

    const shellIntegrated = (paneID: string): boolean => {
        try {
            return options.shellIntegrated?.(paneID) ?? false;
        } catch (error) {
            report(error, `agent launch shell integration ${paneID}`);
            return false;
        }
    };

    const noteFirstOutput = (launch: PendingLaunch): void => {
        if (launch.firstOutputAt !== null) return;
        launch.firstOutputAt = clock();
        clearTimer(launch, 'firstOutput');
        launch.shellSignal = agentShellReadySignal(options.shellOf(launch.paneID) ?? '', shellIntegrated(launch.paneID));
        launch.timers.cap = unrefTimer(
            setTimeout(() => {
                launch.timers.cap = undefined;
                void typeAtCap(launch);
            }, timings.shellReadyCapMs)
        );
    };

    /**
     * zsh / fish / bash 5.1+: the line editor turned bracketed paste on, so it is reading. For a
     * zsh under Kelpi's integration that is not enough on its own: an instant prompt (p10k) turns
     * 2004 on while `.zshrc` still has half a second to run, and only the integration's `precmd`
     * report says the real prompt is next (`zshLineEditorStarted`).
     */
    const checkShellReady = (launch: PendingLaunch): void => {
        if (launch.done || launch.phase !== 'awaiting-shell') return;
        observeModes(launch);
        if (!launch.modes.bracketedPaste) return;
        // A mode cannot change without output, whichever of the two callbacks came first.
        noteFirstOutput(launch);
        if (launch.shellSignal === 'shell-integration' && !zshLineEditorStarted(launch)) return;
        typeLaunchLine(launch);
    };

    /**
     * Under the integration: the first `precmd` report has arrived (the rc files are done) AND,
     * after it, zle has written its own `CSI ? 2004 h` (it is reading now, not in 1-3 ms), or
     * `shellPasteEdgeMs` has passed without one. The DECSET is counted by the parser, so one
     * that finds the mode already on (an instant prompt latched it) still counts, and one that
     * came before the report (the instant prompt's own) does not.
     */
    const zshLineEditorStarted = (launch: PendingLaunch): boolean => {
        if (!launch.shellReported || launch.pasteSetsAtReport === null) return false;
        if (launch.pasteEdgeWaitOver) return true;
        let sets = launch.pasteSetsAtReport;
        try {
            sets = term.bracketedPasteSets(launch.paneID);
        } catch (error) {
            report(error, `agent launch modes ${launch.paneID}`);
        }
        return sets > launch.pasteSetsAtReport;
    };

    /**
     * `shellReadyCapMs` after the first output, with no signal from the shell: type the line only
     * if the SHELL has the terminal, asked fresh. Something else in front (an rc file that ran
     * `tmux attach`, `ssh-add`, a login menu) would take the line as its own input, so that is
     * `failed` (`timeout`) with nothing typed, as is a check that cannot answer: typing on a
     * guess is the one thing this path must not do. A shell builtin reading the terminal cannot
     * be told apart from a prompt this way (`AGENT_FIRST_OUTPUT_TIMEOUT_MS`).
     */
    const typeAtCap = async (launch: PendingLaunch): Promise<void> => {
        if (launch.done || launch.phase !== 'awaiting-shell' || launch.capCheckPending) return;
        launch.capCheckPending = true;
        let foreground: ForegroundAnswer;
        try {
            foreground = await askForeground(launch, true);
        } finally {
            launch.capCheckPending = false;
        }
        // The shell may have signalled, someone may have typed, or the pane gone, meanwhile.
        if (launch.done || launch.phase !== 'awaiting-shell') return;
        if (foreground.shell !== true) {
            log(
                `agent launch: pane ${launch.paneID} gave no sign of a prompt in ${String(timings.shellReadyCapMs)} ms and ` +
                    (foreground.shell === false ? 'another program has the terminal' : 'its foreground could not be read') +
                    '; not typing the launch line'
            );
            finish(launch, 'failed', 'timeout');
            return;
        }
        typeLaunchLine(launch);
    };

    const typeLaunchLine = (launch: PendingLaunch): void => {
        if (launch.done || launch.phase !== 'awaiting-shell') return;
        clearTimer(launch, 'cap');
        clearTimer(launch, 'settle');
        clearTimer(launch, 'pasteEdge');
        clearTimer(launch, 'firstOutput');
        if (!paneAlive(launch)) {
            finish(launch, 'failed', 'pane-exited');
            return;
        }
        const { kind, prompt, send, promptFile } = launch.request;
        const shell = options.shellOf(launch.paneID) ?? '';
        const sendLine = send && prompt !== null && promptFile !== null;
        if (sendLine && !shellSupportsSendMode(shell)) {
            finish(launch, 'failed', 'unsupported-shell');
            return;
        }
        const command = options.commandFor(kind);
        const line = sendLine ? sendModeCommandLine(command, promptFile, prompt) : command;
        try {
            launch.pasteResetsAtLaunch = term.bracketedPasteResets(launch.paneID);
        } catch (error) {
            report(error, `agent launch modes ${launch.paneID}`);
        }
        try {
            typing(launch.paneID, line, false);
        } catch (error) {
            report(error, `agent launch line ${launch.paneID}`);
            finish(launch, 'failed', 'pane-exited');
            return;
        }
        if (prompt === null) {
            finish(launch, 'launched');
            return;
        }
        if (sendLine) {
            finish(launch, 'sent');
            return;
        }
        // Prefill: everything readiness reads is measured from here, including the foreground:
        // an answer the cap took before the line is not one about the agent.
        const now = clock();
        launch.phase = 'awaiting-agent';
        launch.launchedAt = now;
        launch.lastOutputAt = null;
        launch.foreground = null;
        launch.lastKnownForeground = null;
        launch.timers.maxWait = unrefTimer(
            setTimeout(() => {
                launch.timers.maxWait = undefined;
                if (launch.done) return;
                // The budget alone would have ended this unless a trust dialog held it.
                log(`agent launch: pane ${launch.paneID} still not ready after ${String(timings.readyMaxWaitMs)} ms in all; giving up`);
                finish(launch, 'fallback', 'timeout');
            }, timings.readyMaxWaitMs)
        );
        launch.sessionIDAtLaunch = findPaneAnywhere(store.getState(), launch.paneID)?.pane.agentSessionID ?? null;
        launch.sessionID = launch.sessionIDAtLaunch;
        log(`agent launch: pane ${launch.paneID} (${kind}) typed the launch line in ${shellBasename(shell) || 'an unknown shell'}; waiting to prefill`);
        resumeClock(launch);
        scheduleEvaluate(launch);
    };

    // ── phase 2: awaiting the agent ─────────────────────────────────────────────────

    const resumeClock = (launch: PendingLaunch): void => {
        if (launch.done || launch.runningSince !== null) return;
        launch.runningSince = clock();
        launch.timers.timeout = unrefTimer(
            setTimeout(() => {
                onReadyTimeout(launch);
            }, Math.max(0, launch.budgetMs))
        );
    };

    /** A trust dialog is up: a human is deciding, and the budget waits for them. */
    const pauseClock = (launch: PendingLaunch): void => {
        if (launch.runningSince === null) return;
        launch.budgetMs -= clock() - launch.runningSince;
        launch.runningSince = null;
        clearTimer(launch, 'timeout');
    };

    /**
     * Why the wait ran out. `no-bracketed-paste` only from here (the contract): the agent was in
     * the foreground and never asked for framed pastes, or said ready with them off.
     * `no-session-start` when the agent was in the foreground and the predicate was still waiting
     * for its SessionStart: Claude Code is running, but its hook never reached Kelpi (not
     * installed), and nothing else can tell when it is ready. `agent-exited` when the shell had
     * the terminal the last time anyone asked (the agent quit, or never got going); otherwise
     * `timeout`.
     */
    const timeoutReason = (launch: PendingLaunch): WsAgentLaunchReason => {
        if (launch.readyButUnframed) return 'no-bracketed-paste';
        const last = launch.lastAnswer;
        const shell = launch.lastKnownForeground?.shell;
        const waiting = last !== null && !last.ready && last.abandon === undefined ? last.waiting : null;
        if (waiting === 'bracketed-paste' && shell === false) return 'no-bracketed-paste';
        if (waiting === 'session' && shell === false) return 'no-session-start';
        return shell === true ? 'agent-exited' : 'timeout';
    };

    const onReadyTimeout = (launch: PendingLaunch): void => {
        launch.timers.timeout = undefined;
        if (launch.done) return;
        finish(launch, 'fallback', timeoutReason(launch));
    };

    const askForeground = async (launch: PendingLaunch, fresh: boolean): Promise<ForegroundAnswer> => {
        const askedAt = clock();
        const last = launch.foreground;
        if (!fresh && last !== null && last.shell !== null && askedAt - last.askedAt < timings.foregroundReuseMs) return last;
        const askedTick = nextTick();
        let shell: boolean | null;
        try {
            shell = await options.foregroundIsShell(launch.paneID);
        } catch (error) {
            report(error, `agent launch foreground ${launch.paneID}`);
            shell = null;
        }
        const answer: ForegroundAnswer = { shell, askedAt, askedTick };
        launch.foreground = answer;
        if (shell !== null) launch.lastKnownForeground = answer;
        return answer;
    };

    /**
     * The shell is back at its prompt: it has the terminal, and bracketed paste is ON again after
     * the shell switched it off to run the line. A line editor switches 2004 off as it runs a line
     * and on only when it reads the next one, and an agent only writes (so only turns it on) while
     * it holds the terminal; so a foreground check that STARTED after 2004 was seen back on, and
     * found the shell in charge, means the agent has already gone (command not found, a crash,
     * "No, exit"). Reported at once rather than at the end of the ready timeout. The off is
     * counted by the parser (`bracketedPasteResets`), so an off and an on that arrive in one write
     * still count. A shell without 2004 (bash 3.2) waits for the timeout.
     */
    const shellBackAtPrompt = (launch: PendingLaunch, foreground: ForegroundAnswer): boolean =>
        foreground.shell === true &&
        launch.modes.bracketedPaste &&
        launch.pasteBackOnTick !== null &&
        foreground.askedTick > launch.pasteBackOnTick;

    const scheduleEvaluate = (launch: PendingLaunch): void => {
        if (launch.done || launch.phase !== 'awaiting-agent') return;
        if (launch.evaluating) {
            launch.dirty = true;
            return;
        }
        launch.evaluating = true;
        void (async () => {
            try {
                do {
                    launch.dirty = false;
                    await evaluate(launch);
                } while (launch.dirty && !launch.done);
            } catch (error) {
                report(error, `agent launch evaluate ${launch.paneID}`);
            } finally {
                launch.evaluating = false;
            }
        })();
    };

    const evaluate = async (launch: PendingLaunch): Promise<void> => {
        // The predicate reads the screen, so it runs only once the terminal state has parsed
        // every byte that prompted this evaluation.
        try {
            await term.flush(launch.paneID);
        } catch (error) {
            report(error, `agent launch flush ${launch.paneID}`);
        }
        if (launch.done) return;
        observeModes(launch);
        observeSession(launch);
        const foreground = await askForeground(launch, false);
        if (launch.done) return;
        const now = clock();
        let screen: string | undefined;
        const signals: AgentReadinessSignals = {
            kind: launch.request.kind,
            now,
            launchedAt: launch.launchedAt ?? now,
            modes: launch.modes,
            modeChangedAt: { ...launch.modeChangedAt },
            sessionBound: launch.sessionBound,
            sessionBoundAt: launch.sessionBoundAt,
            // Unknown counts as the shell: "cannot tell" is never permission to paste.
            foregroundIsShell: foreground.shell !== false,
            userInputSinceLaunch: launch.userInput,
            lastOutputAt: launch.lastOutputAt,
            holdingSince: launch.holdingSince,
            screenText: () => {
                if (screen === undefined) {
                    try {
                        screen = term.capture(launch.paneID, { scrollback: false });
                    } catch (error) {
                        report(error, `agent launch capture ${launch.paneID}`);
                        screen = '';
                    }
                }
                return screen;
            }
        };
        let answer: AgentReadinessResult;
        try {
            answer = readiness(signals);
        } catch (error) {
            report(error, `agent readiness ${launch.paneID}`);
            finish(launch, 'fallback', 'predicate-error');
            return;
        }
        launch.lastAnswer = answer;
        if (answer.ready) {
            launch.holdingSince = null;
            resumeClock(launch);
            await paste(launch);
            // Not pasted (2004 off): keep looking, as for any other wait.
            if (!launch.done) armRecheck(launch, timings.foregroundPollMs);
            return;
        }
        if (answer.abandon !== undefined) {
            finish(launch, 'fallback', answer.abandon);
            return;
        }
        launch.holdingSince = answer.waiting === 'stable' ? (launch.holdingSince ?? now) : null;
        if (answer.trustDialog === true) pauseClock(launch);
        else resumeClock(launch);
        if (shellBackAtPrompt(launch, foreground)) {
            finish(launch, 'fallback', 'agent-exited');
            return;
        }
        // Ask again when the predicate asked to, and in any case within a poll: an agent that
        // draws its whole start-up in one burst and then sits quiet, or a shell prompt that is the
        // last thing the pane prints, would otherwise be judged forever on a stale foreground
        // answer.
        const poll = answer.trustDialog === true ? timings.dialogPollMs : timings.foregroundPollMs;
        armRecheck(launch, Math.min(poll, answer.recheckInMs ?? poll));
    };

    const armRecheck = (launch: PendingLaunch, ms: number): void => {
        clearTimer(launch, 'recheck');
        launch.timers.recheck = unrefTimer(
            setTimeout(() => {
                launch.timers.recheck = undefined;
                scheduleEvaluate(launch);
            }, Math.max(0, ms))
        );
    };

    /**
     * The hard rule (R1): a prefill never lands in a shell. Ask the OS once more, fresh, right
     * before the write; a check that fails or finds the shell in charge is a fallback, and so is
     * a pane that went away or a user who started typing meanwhile. Bracketed paste must be ON,
     * so the agent receives one framed paste and nothing in it can submit; if it is off the
     * launcher keeps waiting, and the timeout reports `no-bracketed-paste`.
     */
    const paste = async (launch: PendingLaunch): Promise<void> => {
        const foreground = await askForeground(launch, true);
        if (launch.done) return;
        if (foreground.shell === null) {
            finish(launch, 'fallback', 'predicate-error');
            return;
        }
        if (foreground.shell) {
            finish(launch, 'fallback', 'agent-exited');
            return;
        }
        if (!paneAlive(launch)) {
            finish(launch, 'fallback', 'pane-exited');
            return;
        }
        if (launch.userInput) {
            finish(launch, 'fallback', 'user-typed');
            return;
        }
        let framed = false;
        try {
            framed = term.modes(launch.paneID).bracketedPaste;
        } catch (error) {
            report(error, `agent launch modes ${launch.paneID}`);
        }
        if (!framed) {
            launch.readyButUnframed = true;
            return;
        }
        const prompt = launch.request.prompt;
        if (prompt === null) return;
        try {
            typing(launch.paneID, prompt, true);
        } catch (error) {
            report(error, `agent launch paste ${launch.paneID}`);
            finish(launch, 'fallback', 'pane-exited');
            return;
        }
        finish(launch, 'prefilled');
    };

    // ── events ──────────────────────────────────────────────────────────────────────

    const onOutput = (launch: PendingLaunch): void => {
        if (launch.done) return;
        launch.lastOutputAt = clock();
        if (launch.phase === 'awaiting-agent') {
            scheduleEvaluate(launch);
            return;
        }
        noteFirstOutput(launch);
        if (launch.shellSignal === 'bracketed-paste-or-quiet') {
            // Quiet since the LAST output: every chunk restarts the spell.
            clearTimer(launch, 'settle');
            launch.timers.settle = unrefTimer(
                setTimeout(() => {
                    launch.timers.settle = undefined;
                    typeLaunchLine(launch);
                }, timings.shellSettleMs)
            );
        }
        // `modesChanged` reports 2004 once this chunk is parsed; checking after a flush as well
        // keeps the launcher right when that callback is not wired.
        if (!launch.shellCheckQueued) {
            launch.shellCheckQueued = true;
            void term
                .flush(launch.paneID)
                .catch((error: unknown) => {
                    report(error, `agent launch flush ${launch.paneID}`);
                })
                .finally(() => {
                    launch.shellCheckQueued = false;
                    checkShellReady(launch);
                });
        }
    };

    const onStoreChange = (launch: PendingLaunch): void => {
        if (launch.done) return;
        // R7: a pane closed while the spawn gate held it never exits; the store is the only witness.
        if (!paneInStore(launch.paneID)) {
            end(launch, 'pane-exited');
            return;
        }
        if (launch.phase === 'awaiting-agent' && observeSession(launch)) scheduleEvaluate(launch);
    };

    return {
        preparePromptFile(prompt) {
            return promptFiles.write(prompt);
        },
        discardPromptFile(path) {
            promptFiles.discard(path);
        },
        start(launchStart) {
            const launch: PendingLaunch = {
                paneID: launchStart.paneID,
                workspaceID: launchStart.workspaceID,
                request: launchStart.request,
                originClientID: launchStart.originClientID,
                phase: 'awaiting-shell',
                done: false,
                shellSignal: null,
                firstOutputAt: null,
                shellCheckQueued: false,
                shellReported: false,
                pasteSetsAtReport: null,
                pasteEdgeWaitOver: false,
                capCheckPending: false,
                lastOutputAt: null,
                modes: { bracketedPaste: false, alternateScreen: false },
                modeChangedAt: { bracketedPaste: null, alternateScreen: null },
                launchedAt: null,
                pasteResetsAtLaunch: 0,
                pasteBackOnTick: null,
                userInput: false,
                sessionIDAtLaunch: null,
                sessionID: null,
                sessionBound: false,
                sessionBoundAt: null,
                holdingSince: null,
                lastAnswer: null,
                readyButUnframed: false,
                foreground: null,
                lastKnownForeground: null,
                budgetMs: timings.readyTimeoutMs,
                runningSince: null,
                timers: {},
                evaluating: false,
                dirty: false
            };
            if (abandoned) {
                finish(launch, 'failed', 'daemon-stopping');
                return;
            }
            const existing = pending.get(launch.paneID);
            if (existing !== undefined) {
                // Unreachable for a freshly minted pane id; one frame per launch all the same.
                report(new Error(`a launch is already pending for pane ${launch.paneID}`), 'agent launch start');
                finish(launch, 'failed', 'pane-exited');
                return;
            }
            observeModes(launch);
            // What the modes were when watching began is "unchanged", not "changed now".
            launch.modeChangedAt = { bracketedPaste: null, alternateScreen: null };
            pending.set(launch.paneID, launch);
            syncListeners();
            if (!paneAlive(launch)) {
                finish(launch, 'failed', 'pane-exited');
                return;
            }
            launch.timers.firstOutput = unrefTimer(
                setTimeout(() => {
                    launch.timers.firstOutput = undefined;
                    if (launch.firstOutputAt === null) finish(launch, 'failed', 'timeout');
                }, timings.firstOutputTimeoutMs)
            );
        },
        modesChanged(paneID) {
            const launch = pending.get(paneID);
            if (launch === undefined || launch.done) return;
            if (launch.phase === 'awaiting-shell') checkShellReady(launch);
            else scheduleEvaluate(launch);
        },
        shellReported(paneID) {
            const launch = pending.get(paneID);
            if (launch === undefined || launch.done || launch.phase !== 'awaiting-shell') return;
            // A report is output, whichever of it and the data callback is heard first.
            noteFirstOutput(launch);
            if (!launch.shellReported) {
                launch.shellReported = true;
                // Called while the parser is AT the report, so this counts the DECSETs before it
                // (an instant prompt's) and none after it (zle's, which is what to wait for).
                try {
                    launch.pasteSetsAtReport = term.bracketedPasteSets(paneID);
                } catch (error) {
                    report(error, `agent launch modes ${paneID}`);
                    launch.pasteSetsAtReport = 0;
                }
                if (launch.shellSignal === 'shell-integration') {
                    launch.timers.pasteEdge = unrefTimer(
                        setTimeout(() => {
                            launch.timers.pasteEdge = undefined;
                            launch.pasteEdgeWaitOver = true;
                            checkShellReady(launch);
                        }, timings.shellPasteEdgeMs)
                    );
                }
            }
            checkShellReady(launch);
        },
        inputWritten(paneID, data) {
            if (writing) return;
            const launch = pending.get(paneID);
            if (launch === undefined || launch.done || !isTypedInput(data)) return;
            if (launch.phase === 'awaiting-shell') {
                // The launch line would be appended to whatever they have typed so far.
                finish(launch, 'failed', 'user-typed');
                return;
            }
            launch.userInput = true;
            scheduleEvaluate(launch);
        },
        abandonAll(reason) {
            abandoned = true;
            for (const launch of [...pending.values()]) end(launch, reason);
        },
        get pending() {
            return pending.size;
        }
    };
}

/**
 * The launcher a handler table gets when boot supplies none (handler tests): it starts nothing
 * and has nowhere to write a prompt, so a create that carries one is refused with "could not
 * write the prompt file". Never used by a composed daemon.
 */
export const INERT_AGENT_LAUNCHER: AgentLauncher = {
    preparePromptFile() {
        throw new Error('agent launch is not available');
    },
    discardPromptFile() {},
    start() {},
    modesChanged() {},
    shellReported() {},
    inputWritten() {},
    abandonAll() {},
    pending: 0
};

/**
 * Starting an agent in a new workspace's first pane: the pure half.
 * Spec: docs/wire-protocol.md §6.3 (`start_agent`, `agent_prompt`, `send_prompt` and the
 * `agent-launch` frame), docs/config-keybindings.md §1.2 (the two command keys), and
 * agent-lifecycle.md §6.5 (the daemon's launcher, which is the only caller that acts on these).
 *
 * Every function here answers from its arguments alone. The launcher owns the clock, the PTY, the
 * terminal state and the session store; it asks this module what to type, and whether the agent
 * is ready for a paste yet. That split is what lets the readiness rules below be pinned by a
 * truth table instead of by a real agent, and what lets a test (or a later agent version) swap
 * the predicate without touching the launcher.
 *
 * The readiness rules are MEASURED, not guessed: they come from a 43-run experiment against
 * Claude Code 2.1.292 and codex 0.160.1 (2026-10-07), whose findings are restated at each rule.
 * The on-screen strings they read are version-sensitive by nature and are kept as named
 * constants so the next agent release that rewords a dialog is a one-line change.
 */

import { RESUME_SETTLE_DELAY_MS } from './session.js';
import type { AgentKind } from './types.js';

// ── launch commands ─────────────────────────────────────────────────────────────────

/** What `agent-claude-command` / `agent-codex-command` mean when unset or blank. */
export const DEFAULT_AGENT_COMMANDS: Readonly<Record<AgentKind, string>> = {
    claude: 'claude',
    codex: 'codex'
};

/**
 * The shell text that starts `kind`: the configured command, trimmed, or the default when it is
 * absent or blank. Typed as is, so an alias, a wrapper script or extra flags all work; it is the
 * user's own config, and anyone who can write it could already type into any pane.
 */
export function agentLaunchCommand(kind: AgentKind, configured: string | null | undefined): string {
    const trimmed = configured?.trim() ?? '';
    return trimmed === '' ? DEFAULT_AGENT_COMMANDS[kind] : trimmed;
}

/**
 * One shell word holding `value` verbatim: single-quoted, with each `'` written as `'\''` (close
 * the quote, an escaped quote, reopen).
 *
 * Each backslash is written the same way (`'\\'`), outside the quotes. POSIX shells read a
 * backslash inside single quotes literally, but fish reads `\\` and `\'` there as escapes, so a
 * backslash left inside would change meaning under fish; outside the quotes `\\` is one backslash
 * in both. Every shell `SEND_MODE_SHELLS` admits therefore reads the same word.
 */
export function shellSingleQuote(value: string): string {
    return `'${value.replace(/['\\]/g, (char) => (char === "'" ? "'\\''" : "'\\\\'"))}'`;
}

/**
 * Send mode's launch line: the agent command with the prompt as its argument, read back from the
 * daemon-written prompt file at the moment the shell runs the line.
 *
 * `"$(command cat '<file>')"` rather than the prompt itself, because the prompt is arbitrary text
 * that the shell would otherwise parse, and a file keeps a 100 KB prompt off the terminal's input
 * line. `command` bypasses a user's `cat` alias or function (`alias cat=bat` is common). The
 * substitution drops trailing newlines, which nothing misses. `--` ends the agent's own options
 * when the prompt starts with `-`, so a prompt such as `--help me` is text, not a flag.
 *
 * A blank prompt (the caller should not send one) yields the bare launch command, never a line
 * that reads a file nobody wrote.
 */
export function sendModeCommandLine(launch: string, file: string, prompt: string): string {
    if (prompt.trim() === '') return launch;
    const separator = prompt.startsWith('-') ? ' --' : '';
    return `${launch}${separator} "$(command cat ${shellSingleQuote(file)})"`;
}

// ── shells ──────────────────────────────────────────────────────────────────────────

/**
 * The shells whose syntax send mode's line is known to be: POSIX-family shells and fish (3.4 or
 * later, which added `$(…)` inside double quotes; an older fish prints a syntax error and starts
 * nothing). A pane running anything else (nushell, xonsh, tcsh) gets `failed`
 * (`unsupported-shell`) instead of a line it would misread. A plain launch and a prefill type no
 * shell syntax and work in any shell.
 */
export const SEND_MODE_SHELLS = ['zsh', 'bash', 'sh', 'dash', 'ksh', 'fish'] as const;
export type SendModeShell = (typeof SEND_MODE_SHELLS)[number];

/** The shell's program name: the path's last segment, without a login shell's leading `-`. */
export function shellBasename(shellPath: string): string {
    const segments = shellPath.trim().split('/').filter((segment) => segment !== '');
    const last = segments.at(-1) ?? '';
    return last.startsWith('-') ? last.slice(1) : last;
}

/** Can a pane running `shellPath` take send mode's line? Decided by program name alone. */
export function shellSupportsSendMode(shellPath: string): boolean {
    return (SEND_MODE_SHELLS as readonly string[]).includes(shellBasename(shellPath));
}

/**
 * How the launcher knows the shell is at its prompt, ready for the launch line:
 *
 *   - `bracketed-paste`: zsh and fish turn bracketed paste (DEC 2004) on as their line editor
 *     starts, so that is the signal and the ONLY one. Their startup often prints and then goes
 *     quiet before the prompt is up (p10k's instant prompt, nvm, conda), so a quiet spell proves
 *     nothing there.
 *   - `bracketed-paste-or-quiet`: every other shell. bash 5.1+ also turns 2004 on, but bash 3.2
 *     (macOS's `/bin/bash`), sh, dash and ksh never do, so `AGENT_SHELL_SETTLE_MS` with no output
 *     since the LAST output counts too.
 *
 * Either way `AGENT_SHELL_READY_CAP_MS` after the pane's first output is the backstop (a zsh with
 * `zle_bracketed_paste` unset never signals at all).
 */
export type AgentShellReadySignal = 'bracketed-paste' | 'bracketed-paste-or-quiet';

export function agentShellReadySignal(shellPath: string): AgentShellReadySignal {
    const name = shellBasename(shellPath);
    return name === 'zsh' || name === 'fish' ? 'bracketed-paste' : 'bracketed-paste-or-quiet';
}

// ── timings ─────────────────────────────────────────────────────────────────────────

/** Quiet spell that counts as "the shell is at its prompt" for a shell without 2004. */
export const AGENT_SHELL_SETTLE_MS = RESUME_SETTLE_DELAY_MS;

/** Type the launch line this long after the pane's first output, whatever the shell said. */
export const AGENT_SHELL_READY_CAP_MS = 10_000;

/**
 * How long a prefill waits for the agent to become ready, from the moment the launch line was
 * typed, then falls back (`timeout`). The slowest launch measured was 0.92 s. The clock is
 * PAUSED while the readiness answer is `trustDialog` (a human is deciding; the rest of the budget
 * applies once they have), and it never runs before the line is typed.
 */
export const AGENT_READY_TIMEOUT_MS = 10_000;

/** Every stability window in `defaultAgentReadiness`. */
export const AGENT_READY_STABLE_MS = 300;

/**
 * The largest prompt, in UTF-8 bytes after normalization. Send mode passes it as ONE argument,
 * and Linux caps a single argument at 128 KiB; this keeps well under that on every platform.
 */
export const AGENT_PROMPT_MAX_BYTES = 100_000;

/**
 * Age at which the daemon sweeps a prompt file. A day, so re-running a send-mode line from shell
 * history still finds its prompt that day.
 */
export const PROMPT_FILE_TTL_MS = 24 * 60 * 60 * 1000;

// ── prompts ─────────────────────────────────────────────────────────────────────────

export type AgentPromptNormalization =
    /** `prompt` is null when nothing is left to deliver (empty or whitespace only). */
    | { readonly ok: true; readonly prompt: string | null }
    | { readonly ok: false; readonly error: string };

/** C0 controls except TAB and LF (CR is gone by the time this runs), plus DEL. */
const PROMPT_CONTROL_PATTERN = /[\u0001-\u0008\u000b-\u001f\u007f]/g;

function utf8Length(text: string): number {
    let bytes = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}

/**
 * `agent_prompt` as the agent will receive it, done ONCE, by the create handler, before anything
 * is created, so send mode (the prompt file) and prefill (the paste) deliver the same text:
 *
 *   1. a NUL refuses the request: no shell argument and no paste can carry one;
 *   2. CRLF and lone CR become LF;
 *   3. the remaining C0 controls except TAB and LF, and DEL, are dropped. ESC is among them, so
 *      a prompt can neither close a bracketed paste early nor smuggle a sequence into the pane
 *      (and the daemon's paste filter drops the same set, so prefill loses nothing more);
 *   4. more than `AGENT_PROMPT_MAX_BYTES` refuses the request;
 *   5. what is left being blank means "no prompt": the agent is launched and nothing else.
 *
 * Text is otherwise untouched. A prompt that starts with `/` is a Claude Code slash command, which
 * is the caller's business.
 */
export function normalizeAgentPrompt(raw: string): AgentPromptNormalization {
    if (raw.includes('\u0000')) return { ok: false, error: 'agent_prompt may not contain a NUL character' };
    const normalized = raw.replace(/\r\n?/g, '\n').replace(PROMPT_CONTROL_PATTERN, '');
    const bytes = utf8Length(normalized);
    if (bytes > AGENT_PROMPT_MAX_BYTES) {
        return {
            ok: false,
            error: `agent_prompt is too long (${bytes} bytes; the limit is ${AGENT_PROMPT_MAX_BYTES})`
        };
    }
    return { ok: true, prompt: normalized.trim() === '' ? null : normalized };
}

// ── readiness ───────────────────────────────────────────────────────────────────────

/**
 * Claude Code's trust dialog ("Quick safety check: Is this a project you created or one you
 * trust?"). It shows on the NORMAL screen, before SessionStart, for the first worktree of a repo
 * Claude has never trusted, and its default is "No, exit": nothing may send Enter while it is up.
 * Version-sensitive: worded so in Claude Code 2.1.292.
 */
export const CLAUDE_TRUST_DIALOG_TEXT = 'Is this a project you created or one you trust';

/**
 * Codex's trust dialog ("Trust this folder? Codex can read, edit, and run files here, …"), on the
 * alternate screen, as a numbered list whose cursor is the composer's own glyph
 * (`› 1. Trust and continue`). Version-sensitive: worded so in codex 0.160.1.
 */
export const CODEX_TRUST_DIALOG_TEXT = 'Trust this folder?';

/**
 * The first glyph of codex's input line (`› Ask Codex to do anything`), U+203A. A line that
 * starts with it and then a number (`› 1. …`) is a selection cursor, not the composer.
 * Version-sensitive: drawn so in codex 0.160.1.
 */
export const CODEX_COMPOSER_GLYPH = '\u203a';

/**
 * The terminal modes readiness reads. A shape of its own because core cannot see the daemon's
 * `VtModes`, which also has no alternate-screen flag: the launcher adds it from its terminal state.
 */
export interface AgentLaunchModes {
    /** DEC 2004: the foreground program wants pastes framed. */
    readonly bracketedPaste: boolean;
    /** DEC 1049 (or 47 / 1047): the foreground program is on the alternate screen. */
    readonly alternateScreen: boolean;
}

export type AgentLaunchModeName = keyof AgentLaunchModes;

/**
 * Everything a readiness predicate may consult, one call's worth. Every timestamp is on the
 * launcher's clock, in ms, comparable with `now`.
 */
export interface AgentReadinessSignals {
    readonly kind: AgentKind;
    readonly now: number;
    /** When the launch line was TYPED (not when the create arrived). */
    readonly launchedAt: number;
    readonly modes: AgentLaunchModes;
    /**
     * Per mode, when it last changed value; null when it has not changed since the launcher began
     * watching the pane (it has held its current value at least that long).
     */
    readonly modeChangedAt: Readonly<Record<AgentLaunchModeName, number | null>>;
    /** The pane has an agent session bound NOW, by a SessionStart that arrived after `launchedAt`. */
    readonly sessionBound: boolean;
    /** When that binding arrived. Kept after it unbinds; null when none arrived since `launchedAt`. */
    readonly sessionBoundAt: number | null;
    /**
     * The shell is the terminal's foreground process group: the agent has not started yet, or has
     * already gone (command not found, crash, Ctrl-C, "No, exit"). A paste must never land in a
     * shell, so nothing is ready while this is true, and the launcher checks it again immediately
     * before it writes.
     */
    readonly foregroundIsShell: boolean;
    /** Someone typed into the pane after the launch line; a paste now would interleave with them. */
    readonly userInputSinceLaunch: boolean;
    /** The pane's most recent output; null when it has produced none since `launchedAt`. */
    readonly lastOutputAt: number | null;
    /**
     * The launcher's memory for a stability window it cannot see: when this predicate's answers
     * started being `waiting: 'stable'` without a break. The launcher sets it on the first such
     * answer and clears it on any other answer; null otherwise.
     */
    readonly holdingSince: number | null;
    /** The pane's visible screen as text, rows joined by `\n`. Lazy: capturing has a cost. */
    screenText(): string;
}

/**
 * Why an agent is not ready yet:
 *
 *   - `agent-foreground`: the shell still has the terminal;
 *   - `session`: Claude Code has not reported SessionStart;
 *   - `trust-dialog`: a trust dialog is on screen (the launcher pauses its timeout);
 *   - `bracketed-paste` / `alternate-screen`: that mode is not on yet;
 *   - `composer`: codex's input line is not drawn;
 *   - `stable`: every condition holds, and the stability window is running.
 */
export type AgentReadinessWait =
    | 'agent-foreground'
    | 'session'
    | 'trust-dialog'
    | 'bracketed-paste'
    | 'alternate-screen'
    | 'composer'
    | 'stable';

/** Answers that end the wait without a paste: the launcher reports `fallback` with this reason. */
export type AgentReadinessAbandonReason = 'user-typed' | 'agent-exited';

export type AgentReadinessResult =
    | { readonly ready: true }
    | {
          readonly ready: false;
          readonly abandon?: undefined;
          readonly waiting: AgentReadinessWait;
          /**
           * Ask again after this long even if nothing happens (a stability window ends silently).
           * Absent = the next output, mode change or session event is the only reason to ask.
           */
          readonly recheckInMs?: number;
          /** Present (true) exactly when `waiting` is `trust-dialog`: pause the timeout. */
          readonly trustDialog?: true;
      }
    | { readonly ready: false; readonly abandon: AgentReadinessAbandonReason };

/** The seam: the launcher calls one of these on every event while a prefill is pending. */
export type AgentReadiness = (signals: AgentReadinessSignals) => AgentReadinessResult;

const READY: AgentReadinessResult = { ready: true };

function wait(waiting: Exclude<AgentReadinessWait, 'trust-dialog'>, recheckInMs?: number): AgentReadinessResult {
    return recheckInMs === undefined ? { ready: false, waiting } : { ready: false, waiting, recheckInMs };
}

const TRUST_DIALOG: AgentReadinessResult = { ready: false, waiting: 'trust-dialog', trustDialog: true };

/** Whitespace runs collapse, so a dialog sentence wrapped across rows still matches. */
function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ');
}

function screenShows(screen: string, text: string): boolean {
    return collapseWhitespace(screen).includes(collapseWhitespace(text));
}

const NUMBERED_OPTION = new RegExp(`^${CODEX_COMPOSER_GLYPH}\\s*\\d+\\.`);

function codexComposerShown(screen: string): boolean {
    return screen.split('\n').some((row) => {
        const text = row.trimStart();
        return text.startsWith(CODEX_COMPOSER_GLYPH) && !NUMBERED_OPTION.test(text);
    });
}

/** When `mode` took its current value; a mode that never changed has held it "forever". */
function heldSince(signals: AgentReadinessSignals, mode: AgentLaunchModeName): number {
    return signals.modeChangedAt[mode] ?? Number.NEGATIVE_INFINITY;
}

/**
 * Claude Code. SessionStart is the anchor: it arrives only AFTER the trust dialog is accepted, and
 * in every one of 22 measured sessions bracketed paste was OFF at that instant, back on 4-16 ms
 * later, with the alternate screen 20-35 ms after that and the input box drawn ~47 ms after the
 * 2004. Before SessionStart, 2004 is already on during the trust dialog and during an undrawn
 * 300-670 ms phase, and a paste then is LOST: the first 2004-on after launch is never the signal.
 *
 * Ready: session bound, 2004 on, and either the alternate screen is on (the full-screen renderer is
 * up) or, for a renderer that never takes it, 2004 has been on for `AGENT_READY_STABLE_MS` since
 * SessionStart.
 *
 * The trust text is read only BEFORE the session binds: after it, the dialog has been accepted by
 * definition, and its words can linger on the normal screen under a non-full-screen renderer,
 * which must not pause the timeout forever.
 */
function claudeReadiness(signals: AgentReadinessSignals): AgentReadinessResult {
    if (!signals.sessionBound || signals.sessionBoundAt === null) {
        return screenShows(signals.screenText(), CLAUDE_TRUST_DIALOG_TEXT) ? TRUST_DIALOG : wait('session');
    }
    if (!signals.modes.bracketedPaste) return wait('bracketed-paste');
    if (signals.modes.alternateScreen) return READY;
    const pasteOnFor = signals.now - Math.max(signals.sessionBoundAt, heldSince(signals, 'bracketedPaste'));
    return pasteOnFor >= AGENT_READY_STABLE_MS ? READY : wait('stable', AGENT_READY_STABLE_MS - pasteOnFor);
}

/**
 * Codex. SessionStart never fires before the first model turn (codex runs its hooks then), and
 * with codex 0.160's shared app-server the hooks may not reach Kelpi at all, so readiness is read
 * off the screen: 2004 on, alternate screen on, the composer drawn and no trust dialog, all held
 * for `AGENT_READY_STABLE_MS`. The window matters: in an untrusted folder the composer is drawn
 * ~214 ms BEFORE the trust dialog replaces it (alternate screen at ~278 ms, composer ~304 ms,
 * dialog ~518 ms).
 */
function codexReadiness(signals: AgentReadinessSignals): AgentReadinessResult {
    const screen = signals.screenText();
    if (screenShows(screen, CODEX_TRUST_DIALOG_TEXT)) return TRUST_DIALOG;
    if (!signals.modes.bracketedPaste) return wait('bracketed-paste');
    if (!signals.modes.alternateScreen) return wait('alternate-screen');
    if (!codexComposerShown(screen)) return wait('composer');
    const since = Math.max(
        heldSince(signals, 'bracketedPaste'),
        heldSince(signals, 'alternateScreen'),
        signals.holdingSince ?? signals.now
    );
    const held = signals.now - since;
    return held >= AGENT_READY_STABLE_MS ? READY : wait('stable', AGENT_READY_STABLE_MS - held);
}

/**
 * The shipped readiness rules. In order, for both agents:
 *
 *   1. input typed into the pane since the launch line → abandon (`user-typed`);
 *   2. a session that bound and then unbound → abandon (`agent-exited`);
 *   3. the shell in the foreground → wait (never paste into a shell);
 *   4. the agent's own rule, above, which is where the trust-dialog pause comes from.
 *
 * Pure: the same signals always give the same answer, and nothing here keeps state between calls
 * (`holdingSince` is the launcher's).
 */
export const defaultAgentReadiness: AgentReadiness = (signals) => {
    if (signals.userInputSinceLaunch) return { ready: false, abandon: 'user-typed' };
    if (signals.sessionBoundAt !== null && !signals.sessionBound) return { ready: false, abandon: 'agent-exited' };
    if (signals.foregroundIsShell) return wait('agent-foreground');
    return signals.kind === 'claude' ? claudeReadiness(signals) : codexReadiness(signals);
};

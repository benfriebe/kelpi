import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
    AGENT_PROMPT_MAX_BYTES,
    AGENT_READY_MAX_WAIT_MS,
    AGENT_READY_STABLE_MS,
    AGENT_READY_TIMEOUT_MS,
    AGENT_SHELL_READY_CAP_MS,
    AGENT_SHELL_SETTLE_MS,
    CLAUDE_TRUST_DIALOG_TEXT,
    CODEX_COMPOSER_GLYPH,
    CODEX_TRUST_DIALOG_TEXT,
    DEFAULT_AGENT_COMMANDS,
    PROMPT_FILE_TTL_MS,
    SEND_MODE_SHELLS,
    agentLaunchCommand,
    agentShellReadySignal,
    defaultAgentReadiness,
    normalizeAgentPrompt,
    sendModeCommandLine,
    shellBasename,
    shellSingleQuote,
    shellSupportsSendMode,
    type AgentReadinessResult,
    type AgentReadinessSignals
} from './launch.js';
import { RESUME_SETTLE_DELAY_MS } from './session.js';

/**
 * The real shells on this machine, each run without its rc files so a user's startup output
 * cannot leak into what is measured. The quoting contract is "every shell send mode admits reads
 * the same word", and only a shell can say whether that holds.
 */
const SHELL_CANDIDATES: readonly (readonly [string, readonly string[]])[] = [
    ['/bin/sh', []],
    ['/bin/bash', []],
    ['/bin/zsh', ['-f']],
    ['/usr/bin/zsh', ['-f']],
    ['/bin/dash', []],
    ['/usr/bin/dash', []],
    ['/bin/ksh', []],
    ['/usr/bin/ksh', []],
    ['/opt/homebrew/bin/fish', ['--no-config']],
    ['/usr/local/bin/fish', ['--no-config']],
    ['/usr/bin/fish', ['--no-config']]
];
const SHELLS = SHELL_CANDIDATES.filter(([path]) => existsSync(path)).filter(
    ([path], index, all) => all.findIndex(([other]) => basename(other) === basename(path)) === index
);

function runIn(shell: readonly [string, readonly string[]], script: string): string {
    return execFileSync(shell[0], [...shell[1], '-c', script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
}

const scratch = mkdtempSync(join(tmpdir(), "kelpi launch's test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('launch commands', () => {
    it('uses the configured command, trimmed, and the default when it is absent or blank', () => {
        expect(DEFAULT_AGENT_COMMANDS).toEqual({ claude: 'claude', codex: 'codex' });
        expect(agentLaunchCommand('claude', undefined)).toBe('claude');
        expect(agentLaunchCommand('codex', null)).toBe('codex');
        expect(agentLaunchCommand('claude', '')).toBe('claude');
        expect(agentLaunchCommand('codex', '   ')).toBe('codex');
        expect(agentLaunchCommand('claude', '  claude --model opus ')).toBe('claude --model opus');
        expect(agentLaunchCommand('codex', '~/bin/codex-wrapper')).toBe('~/bin/codex-wrapper');
    });
});

describe('shellSingleQuote', () => {
    it("quotes with the '\\'' form, a path with a space included", () => {
        expect(shellSingleQuote('plain')).toBe("'plain'");
        expect(shellSingleQuote('/Users/ben/Library/Application Support/kelpid/prompts/a.txt')).toBe(
            "'/Users/ben/Library/Application Support/kelpid/prompts/a.txt'"
        );
        expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
        expect(shellSingleQuote('')).toBe("''");
    });

    it('writes a backslash outside the quotes, where fish and POSIX shells agree on it', () => {
        expect(shellSingleQuote('a\\b')).toBe("'a'\\\\'b'");
        expect(shellSingleQuote("a\\'b")).toBe("'a'\\\\''\\''b'");
    });

    const HOSTILE = [
        '/Users/ben/Library/Application Support/kelpid/prompts/0f9c.txt',
        "it's",
        "''",
        'a\\b',
        "a\\'b",
        'trailing\\',
        '$HOME ${PATH} `whoami` $(date)',
        '"double" and \'single\'',
        '-n',
        '* ? [a] ~/x',
        'semi; colon && pipe | amp &',
        'two\nlines'
    ];

    it.each(SHELLS.map((shell) => [basename(shell[0]), shell] as const))(
        'round-trips every hostile value through %s as one word',
        (_name, shell) => {
            for (const value of HOSTILE) {
                expect(runIn(shell, `printf '[%s]' ${shellSingleQuote(value)}`)).toBe(`[${value}]`);
            }
        }
    );

    it('found at least a POSIX shell to measure against', () => {
        expect(SHELLS.length).toBeGreaterThan(0);
    });
});

describe('sendModeCommandLine', () => {
    it('reads the prompt back from its file, with -- only for a prompt that looks like a flag', () => {
        const file = '/Users/ben/Library/Application Support/kelpid/prompts/0f9c.txt';
        // The space before the closing quote is part of the argument: it can never equal a word.
        expect(sendModeCommandLine('claude', file, 'Fix ENG-123')).toBe(
            `claude "$(command cat '/Users/ben/Library/Application Support/kelpid/prompts/0f9c.txt') "`
        );
        expect(sendModeCommandLine('codex', file, '--help me')).toBe(
            `codex -- "$(command cat '/Users/ben/Library/Application Support/kelpid/prompts/0f9c.txt') "`
        );
        // Only the FIRST character decides: `cat` keeps leading whitespace, so " -x" is no flag.
        expect(sendModeCommandLine('codex', file, ' -x')).not.toContain(' -- ');
        expect(sendModeCommandLine('claude --model opus', "/tmp/it's.txt", 'go')).toBe(
            `claude --model opus "$(command cat '/tmp/it'\\''s.txt') "`
        );
    });

    it('is the bare launch command for a blank prompt', () => {
        expect(sendModeCommandLine('claude', '/tmp/x.txt', '')).toBe('claude');
        expect(sendModeCommandLine('claude', '/tmp/x.txt', ' \n\t')).toBe('claude');
    });

    /**
     * The whole contract at once, against real shells: an "agent" that prints each argument it
     * got, a prompt file in a directory whose name needs quoting, and a prompt full of shell
     * syntax. The agent must receive the prompt as ONE argument, verbatim except for the trailing
     * newlines command substitution drops, plus the one trailing space, and the `--` must reach it.
     */
    const PROMPT = "-Work on ENG-123: \"quotes\" 'single' $HOME `whoami` $(date)\n\tline two @src/index.ts\n\n";
    const promptFile = join(scratch, 'prompt.txt');
    writeFileSync(promptFile, PROMPT);
    const AGENT = `sh -c 'for a in "$@"; do printf "[%s]" "$a"; done' agent`;

    it.each(SHELLS.map((shell) => [basename(shell[0]), shell] as const))(
        'hands %s the prompt as one argument',
        (_name, shell) => {
            const line = sendModeCommandLine(AGENT, promptFile, PROMPT);
            expect(runIn(shell, line)).toBe(`[--][${PROMPT.replace(/\n+$/, '')} ]`);
        }
    );

    /**
     * A prompt that IS an agent subcommand's name (`codex logout`, `codex review`, `codex a` for
     * apply, `claude update`, `purge`, `rm`, `stop`) must reach the agent as text, never as that
     * subcommand. Parsers match a subcommand by exact name, so the argument must never equal one:
     * the fake agent here prints its argv, and every word arrives with its trailing space.
     */
    const SUBCOMMANDS = ['logout', 'review', 'a', 'update', 'purge', 'rm', 'stop', 'mcp', '-h', '--version'];

    it.each(SHELLS.map((shell) => [basename(shell[0]), shell] as const))(
        'never hands %s a prompt that equals a subcommand name',
        (_name, shell) => {
            for (const word of SUBCOMMANDS) {
                const file = join(scratch, `word-${word}.txt`);
                // As the daemon writes it: normalized, so no trailing newline.
                writeFileSync(file, word);
                const expected = word.startsWith('-') ? `[--][${word} ]` : `[${word} ]`;
                expect(runIn(shell, sendModeCommandLine(AGENT, file, word))).toBe(expected);
            }
        }
    );
});

describe('shells', () => {
    it('admits exactly the POSIX family and fish to send mode', () => {
        expect([...SEND_MODE_SHELLS]).toEqual(['zsh', 'bash', 'sh', 'dash', 'ksh', 'fish']);
        for (const path of ['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/bin/dash', '/bin/ksh', '/opt/homebrew/bin/fish']) {
            expect(shellSupportsSendMode(path)).toBe(true);
        }
        for (const path of ['/opt/homebrew/bin/nu', '/usr/local/bin/xonsh', '/bin/tcsh', '/bin/csh', 'pwsh', '']) {
            expect(shellSupportsSendMode(path)).toBe(false);
        }
    });

    it("decides by program name: a bare name, a login shell's dash and a trailing slash all work", () => {
        expect(shellBasename('/bin/zsh')).toBe('zsh');
        expect(shellBasename('zsh')).toBe('zsh');
        expect(shellBasename('-zsh')).toBe('zsh');
        expect(shellBasename(' /usr/local/bin/bash ')).toBe('bash');
        expect(shellBasename('/bin/zsh/')).toBe('zsh');
        expect(shellBasename('')).toBe('');
        expect(shellSupportsSendMode('-bash')).toBe(true);
        // Exact names only: a lookalike is not the shell whose syntax we know.
        expect(shellSupportsSendMode('/bin/zsh5')).toBe(false);
    });

    it('waits for bracketed paste alone from zsh and fish, and accepts a quiet spell from the rest', () => {
        expect(agentShellReadySignal('/bin/zsh')).toBe('bracketed-paste');
        expect(agentShellReadySignal('/opt/homebrew/bin/fish')).toBe('bracketed-paste');
        expect(agentShellReadySignal('/bin/bash')).toBe('bracketed-paste-or-quiet');
        expect(agentShellReadySignal('/bin/sh')).toBe('bracketed-paste-or-quiet');
        expect(agentShellReadySignal('/opt/homebrew/bin/nu')).toBe('bracketed-paste-or-quiet');
    });

    it("waits for Kelpi's shell integration report from a zsh that runs it, and only from zsh", () => {
        expect(agentShellReadySignal('/bin/zsh', true)).toBe('shell-integration');
        expect(agentShellReadySignal('-zsh', true)).toBe('shell-integration');
        expect(agentShellReadySignal('/bin/zsh', false)).toBe('bracketed-paste');
        // The integration covers zsh alone: the flag cannot change another shell's signal.
        expect(agentShellReadySignal('/opt/homebrew/bin/fish', true)).toBe('bracketed-paste');
        expect(agentShellReadySignal('/bin/bash', true)).toBe('bracketed-paste-or-quiet');
    });
});

describe('timings', () => {
    it('pins the launcher budget', () => {
        expect(AGENT_SHELL_SETTLE_MS).toBe(RESUME_SETTLE_DELAY_MS);
        expect(AGENT_SHELL_READY_CAP_MS).toBe(10_000);
        expect(AGENT_READY_TIMEOUT_MS).toBe(10_000);
        expect(AGENT_READY_MAX_WAIT_MS).toBe(600_000);
        expect(AGENT_READY_STABLE_MS).toBe(300);
        expect(AGENT_PROMPT_MAX_BYTES).toBe(100_000);
        expect(PROMPT_FILE_TTL_MS).toBe(86_400_000);
    });
});

describe('normalizeAgentPrompt', () => {
    it('turns CRLF and lone CR into LF', () => {
        expect(normalizeAgentPrompt('a\r\nb\rc\nd')).toEqual({ ok: true, prompt: 'a\nb\nc\nd' });
    });

    it('drops C0 controls and DEL but keeps TAB and LF, so no escape sequence survives', () => {
        expect(normalizeAgentPrompt('a\tb\nc\u0007d\u001b[201~e\u007ff\u0001\u001f')).toEqual({
            ok: true,
            prompt: 'a\tb\ncd[201~ef'
        });
    });

    it('leaves everything else alone: leading whitespace, unicode, a leading slash', () => {
        expect(normalizeAgentPrompt('  /review ENG-1 ✓ 日本 🦊')).toEqual({
            ok: true,
            prompt: '  /review ENG-1 ✓ 日本 🦊'
        });
    });

    it('drops trailing whitespace and newlines, so send mode and a prefill deliver the same text', () => {
        // A `--prompt-file` as an editor saves it: send mode's `$(cat …)` would drop the newline,
        // and a prefill that kept it would show the text as a pasted-lines chip instead of inline.
        expect(normalizeAgentPrompt('line one\nline two\nline three\n')).toEqual({
            ok: true,
            prompt: 'line one\nline two\nline three'
        });
        expect(normalizeAgentPrompt('  /review ENG-1 ✓  \r\n\t \n\n')).toEqual({ ok: true, prompt: '  /review ENG-1 ✓' });
        // Whitespace INSIDE the text is the user's.
        expect(normalizeAgentPrompt('a\n\n\tb')).toEqual({ ok: true, prompt: 'a\n\n\tb' });
        // A control character at the end goes first, so what it hid is trimmed too.
        expect(normalizeAgentPrompt('done \u0007\n')).toEqual({ ok: true, prompt: 'done' });
    });

    it('refuses a NUL rather than dropping it', () => {
        expect(normalizeAgentPrompt('a\u0000b')).toEqual({
            ok: false,
            error: 'agent_prompt may not contain a NUL character'
        });
    });

    it('measures the limit in UTF-8 bytes, after normalization', () => {
        expect(normalizeAgentPrompt('a'.repeat(AGENT_PROMPT_MAX_BYTES))).toMatchObject({ ok: true });
        expect(normalizeAgentPrompt('a'.repeat(AGENT_PROMPT_MAX_BYTES + 1))).toEqual({
            ok: false,
            error: 'agent_prompt is too long (100001 bytes; the limit is 100000)'
        });
        // Two bytes each: half as many fit.
        expect(normalizeAgentPrompt('é'.repeat(AGENT_PROMPT_MAX_BYTES / 2))).toMatchObject({ ok: true });
        expect(normalizeAgentPrompt('é'.repeat(AGENT_PROMPT_MAX_BYTES / 2 + 1))).toMatchObject({ ok: false });
        // Four bytes per astral character, however JS counts it.
        expect(normalizeAgentPrompt('🦊'.repeat(AGENT_PROMPT_MAX_BYTES / 4))).toMatchObject({ ok: true });
        expect(normalizeAgentPrompt(`${'🦊'.repeat(AGENT_PROMPT_MAX_BYTES / 4)}a`)).toMatchObject({ ok: false });
        // CRLF shrinks to LF before measuring (150,000 bytes as sent, 99,999 as delivered).
        expect(normalizeAgentPrompt('a\r\n'.repeat(AGENT_PROMPT_MAX_BYTES / 2))).toMatchObject({ ok: true });
        // Trailing whitespace is gone before measuring, too.
        expect(normalizeAgentPrompt(`${'a'.repeat(AGENT_PROMPT_MAX_BYTES)}\n\n  `)).toMatchObject({ ok: true });
    });

    it('reports a blank prompt as no prompt at all', () => {
        expect(normalizeAgentPrompt('')).toEqual({ ok: true, prompt: null });
        expect(normalizeAgentPrompt(' \r\n\t ')).toEqual({ ok: true, prompt: null });
        expect(normalizeAgentPrompt('\u001b\u0007')).toEqual({ ok: true, prompt: null });
    });
});

// ── readiness ───────────────────────────────────────────────────────────────────────

type SignalOverrides = Partial<Omit<AgentReadinessSignals, 'screenText' | 'modes' | 'modeChangedAt'>> & {
    readonly screen?: string;
    readonly bracketedPaste?: boolean;
    readonly alternateScreen?: boolean;
    readonly pasteChangedAt?: number | null;
    readonly altChangedAt?: number | null;
};

function signals(overrides: SignalOverrides = {}): AgentReadinessSignals {
    const screen = overrides.screen ?? '';
    return {
        kind: overrides.kind ?? 'claude',
        now: overrides.now ?? 1_000,
        launchedAt: overrides.launchedAt ?? 0,
        modes: {
            bracketedPaste: overrides.bracketedPaste ?? false,
            alternateScreen: overrides.alternateScreen ?? false
        },
        modeChangedAt: {
            bracketedPaste: overrides.pasteChangedAt ?? null,
            alternateScreen: overrides.altChangedAt ?? null
        },
        sessionBound: overrides.sessionBound ?? false,
        sessionBoundAt: overrides.sessionBoundAt ?? null,
        foregroundIsShell: overrides.foregroundIsShell ?? false,
        userInputSinceLaunch: overrides.userInputSinceLaunch ?? false,
        lastOutputAt: overrides.lastOutputAt ?? null,
        holdingSince: overrides.holdingSince ?? null,
        screenText: () => screen
    };
}

const ready = (overrides: SignalOverrides): AgentReadinessResult => defaultAgentReadiness(signals(overrides));

/** Screens as the phase 0 runs captured them (trimmed to the rows that matter). */
const CLAUDE_TRUST_SCREEN = [
    '❯ claude',
    ' Accessing workspace:',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    " project, or work from your team). If not, take a moment to review what's in this folder first.",
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel'
].join('\n');
/** The same sentence in a narrow pane, wrapped by the agent across rows. */
const CLAUDE_TRUST_SCREEN_NARROW = [
    ' Quick safety check: Is this a project you',
    ' created or one you',
    ' trust? (Like your own code, a well-known'
].join('\n');
const CODEX_TRUST_SCREEN = [
    '  Folder access',
    '  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.',
    '› 1. Trust and continue',
    '  2. Back to Agent Command Center',
    '  enter continue · esc back'
].join('\n');
const CODEX_LOADING_SCREEN = [' >_ OpenAI Codex (v0.160.1)', '    loading', ' Follow the white cursor.'].join('\n');
const CODEX_READY_SCREEN = [CODEX_LOADING_SCREEN, '› Ask Codex to do anything', '  ? for shortcuts'].join('\n');

describe('defaultAgentReadiness: rules for both agents', () => {
    it.each(['claude', 'codex'] as const)('%s: input typed after the launch line abandons, whatever else holds', (kind) => {
        expect(
            ready({
                kind,
                userInputSinceLaunch: true,
                sessionBound: true,
                sessionBoundAt: 500,
                bracketedPaste: true,
                alternateScreen: true,
                screen: CODEX_READY_SCREEN,
                holdingSince: 0
            })
        ).toEqual({ ready: false, abandon: 'user-typed' });
    });

    it.each(['claude', 'codex'] as const)('%s: a session that bound and then unbound abandons', (kind) => {
        expect(ready({ kind, sessionBound: false, sessionBoundAt: 500, foregroundIsShell: true })).toEqual({
            ready: false,
            abandon: 'agent-exited'
        });
    });

    it.each(['claude', 'codex'] as const)('%s: never ready while the shell has the terminal', (kind) => {
        // Every agent condition holds, which is exactly what a failed launch looks like: the shell
        // is back at its prompt with bracketed paste on.
        expect(
            ready({
                kind,
                foregroundIsShell: true,
                sessionBound: true,
                sessionBoundAt: 100,
                bracketedPaste: true,
                alternateScreen: true,
                screen: CODEX_READY_SCREEN,
                holdingSince: 0,
                now: 60_000
            })
        ).toEqual({ ready: false, waiting: 'agent-foreground' });
    });

    it.each(['claude', 'codex'] as const)('%s: a trust dialog left behind by an agent that quit pauses nothing', (kind) => {
        // "No, exit" leaves the dialog's words on the normal screen above the shell's prompt; the
        // timeout must keep running, so this is a foreground wait, not a trust-dialog one.
        const result = ready({ kind, foregroundIsShell: true, screen: `${CLAUDE_TRUST_SCREEN}\n${CODEX_TRUST_SCREEN}` });
        expect(result).toEqual({ ready: false, waiting: 'agent-foreground' });
    });
});

describe('defaultAgentReadiness: Claude Code', () => {
    it('is never ready at the first bracketed-paste after launch, before SessionStart', () => {
        // 2004 comes on at ~241-304 ms, during the trust dialog or an undrawn phase, and a paste
        // there is lost. However long it stays on, no SessionStart means no paste.
        for (const now of [305, 1_000, 9_000]) {
            expect(ready({ now, bracketedPaste: true, pasteChangedAt: 304 })).toEqual({
                ready: false,
                waiting: 'session'
            });
        }
        expect(ready({ bracketedPaste: true, alternateScreen: true, pasteChangedAt: 304, altChangedAt: 310 })).toEqual({
            ready: false,
            waiting: 'session'
        });
    });

    it('pauses (trustDialog) while its trust dialog is up, a wrapped one included', () => {
        const expected = { ready: false, waiting: 'trust-dialog', trustDialog: true };
        expect(ready({ bracketedPaste: true, screen: CLAUDE_TRUST_SCREEN })).toEqual(expected);
        expect(ready({ bracketedPaste: true, screen: CLAUDE_TRUST_SCREEN_NARROW })).toEqual(expected);
        expect(CLAUDE_TRUST_SCREEN).toContain(CLAUDE_TRUST_DIALOG_TEXT);
    });

    it('waits for bracketed paste after SessionStart, which arrives with it OFF', () => {
        expect(ready({ now: 741, sessionBound: true, sessionBoundAt: 741, pasteChangedAt: 666 })).toEqual({
            ready: false,
            waiting: 'bracketed-paste'
        });
    });

    it('is ready the moment 2004 and the alternate screen are both on after SessionStart', () => {
        const bound = { sessionBound: true, sessionBoundAt: 741, bracketedPaste: true, pasteChangedAt: 748 };
        expect(ready({ ...bound, now: 760 })).toEqual({ ready: false, waiting: 'stable', recheckInMs: 288 });
        expect(ready({ ...bound, now: 770, alternateScreen: true, altChangedAt: 770 })).toEqual({ ready: true });
    });

    it('without an alternate screen, needs 2004 on for 300 ms counted from SessionStart', () => {
        const bound = { sessionBound: true, sessionBoundAt: 741, bracketedPaste: true };
        // On since after SessionStart: the window starts at the 2004.
        expect(ready({ ...bound, pasteChangedAt: 748, now: 1_047 })).toEqual({
            ready: false,
            waiting: 'stable',
            recheckInMs: 1
        });
        expect(ready({ ...bound, pasteChangedAt: 748, now: 1_048 })).toEqual({ ready: true });
        // On since BEFORE SessionStart (or never seen to change): the window starts at SessionStart.
        expect(ready({ ...bound, pasteChangedAt: 300, now: 900 })).toEqual({
            ready: false,
            waiting: 'stable',
            recheckInMs: 141
        });
        expect(ready({ ...bound, pasteChangedAt: null, now: 1_041 })).toEqual({ ready: true });
    });

    it('stops reading the screen once the session is bound', () => {
        // After SessionStart the dialog has been accepted by definition, and its words can linger
        // under a non-full-screen renderer; they must not hold the paste, or the timeout, forever.
        let captures = 0;
        const base = signals({
            sessionBound: true,
            sessionBoundAt: 741,
            bracketedPaste: true,
            pasteChangedAt: 748,
            now: 1_100
        });
        const result = defaultAgentReadiness({
            ...base,
            screenText: () => {
                captures += 1;
                return CLAUDE_TRUST_SCREEN;
            }
        });
        expect(result).toEqual({ ready: true });
        expect(captures).toBe(0);
    });
});

describe('defaultAgentReadiness: codex', () => {
    const up = { kind: 'codex' as const, bracketedPaste: true, alternateScreen: true, pasteChangedAt: 24, altChangedAt: 278 };

    it('never needs a session: hooks do not fire before the first model turn', () => {
        expect(ready({ ...up, screen: CODEX_READY_SCREEN, holdingSince: 304, now: 604 })).toEqual({ ready: true });
    });

    it('pauses (trustDialog) while its trust dialog is up, though its cursor is the composer glyph', () => {
        expect(CODEX_TRUST_SCREEN).toContain(`${CODEX_COMPOSER_GLYPH} 1.`);
        expect(CODEX_TRUST_SCREEN).toContain(CODEX_TRUST_DIALOG_TEXT);
        expect(ready({ ...up, screen: CODEX_TRUST_SCREEN, holdingSince: 0, now: 5_000 })).toEqual({
            ready: false,
            waiting: 'trust-dialog',
            trustDialog: true
        });
    });

    it('waits for each condition in turn', () => {
        expect(ready({ kind: 'codex', screen: CODEX_READY_SCREEN })).toEqual({ ready: false, waiting: 'bracketed-paste' });
        expect(ready({ kind: 'codex', bracketedPaste: true, screen: CODEX_READY_SCREEN })).toEqual({
            ready: false,
            waiting: 'alternate-screen'
        });
        expect(ready({ ...up, screen: CODEX_LOADING_SCREEN })).toEqual({ ready: false, waiting: 'composer' });
        // A numbered list with no trust text (another select dialog) is not the composer either.
        expect(ready({ ...up, screen: '  2 hooks need review\n› 1. Review now\n  2. Later' })).toEqual({
            ready: false,
            waiting: 'composer'
        });
    });

    it('holds every condition for 300 ms before it is ready', () => {
        const drawn = { ...up, screen: CODEX_READY_SCREEN };
        // First sight: the launcher has no hold yet, and will record this moment.
        expect(ready({ ...drawn, now: 304, holdingSince: null })).toEqual({
            ready: false,
            waiting: 'stable',
            recheckInMs: 300
        });
        expect(ready({ ...drawn, now: 500, holdingSince: 304 })).toEqual({
            ready: false,
            waiting: 'stable',
            recheckInMs: 104
        });
        expect(ready({ ...drawn, now: 604, holdingSince: 304 })).toEqual({ ready: true });
        // A mode that flipped inside the window restarts it, even with no evaluation in between.
        expect(ready({ ...drawn, altChangedAt: 500, now: 604, holdingSince: 304 })).toEqual({
            ready: false,
            waiting: 'stable',
            recheckInMs: 196
        });
    });
});

/**
 * The seam as the launcher drives it: one call per event, `holdingSince` set on the first
 * `stable` answer and cleared on any other. Each timeline is a phase 0 run's own event times.
 */
function drive(steps: readonly SignalOverrides[]): (AgentReadinessResult & { readonly now: number })[] {
    let holdingSince: number | null = null;
    return steps.map((step) => {
        const result = ready({ ...step, holdingSince });
        if (!result.ready && result.abandon === undefined && result.waiting === 'stable') holdingSince ??= step.now ?? 0;
        else holdingSince = null;
        return { ...result, now: step.now ?? 0 };
    });
}

describe('defaultAgentReadiness over phase 0 timelines', () => {
    it('codex in an untrusted folder: the composer drawn 214 ms before the dialog is never pasted into', () => {
        const codex = { kind: 'codex' as const, pasteChangedAt: 24, bracketedPaste: true };
        const results = drive([
            { ...codex, now: 24, foregroundIsShell: true },
            { ...codex, now: 30, screen: '' },
            { ...codex, now: 278, alternateScreen: true, altChangedAt: 278, screen: CODEX_LOADING_SCREEN },
            { ...codex, now: 304, alternateScreen: true, altChangedAt: 278, screen: CODEX_READY_SCREEN },
            { ...codex, now: 450, alternateScreen: true, altChangedAt: 278, screen: CODEX_READY_SCREEN },
            { ...codex, now: 518, alternateScreen: true, altChangedAt: 278, screen: CODEX_TRUST_SCREEN },
            { ...codex, now: 604, alternateScreen: true, altChangedAt: 278, screen: CODEX_TRUST_SCREEN },
            // Accepted at ~2022 ms; the composer is back at 2074.
            { ...codex, now: 2_074, alternateScreen: true, altChangedAt: 278, screen: CODEX_READY_SCREEN },
            { ...codex, now: 2_300, alternateScreen: true, altChangedAt: 278, screen: CODEX_READY_SCREEN },
            { ...codex, now: 2_374, alternateScreen: true, altChangedAt: 278, screen: CODEX_READY_SCREEN }
        ]);
        expect(results.map((result) => (result.ready ? 'ready' : (result.abandon ?? result.waiting)))).toEqual([
            'agent-foreground',
            'alternate-screen',
            'composer',
            'stable',
            'stable',
            'trust-dialog',
            'trust-dialog',
            'stable',
            'stable',
            'ready'
        ]);
    });

    it('claude in an untrusted folder: ready only after trust, SessionStart, 2004 and the alternate screen', () => {
        const results = drive([
            { now: 3, pasteChangedAt: 3, foregroundIsShell: true },
            { now: 241, bracketedPaste: true, pasteChangedAt: 241 },
            { now: 258, bracketedPaste: true, pasteChangedAt: 241, screen: CLAUDE_TRUST_SCREEN },
            { now: 1_963, bracketedPaste: true, pasteChangedAt: 241, screen: CLAUDE_TRUST_SCREEN },
            { now: 2_100, bracketedPaste: true, pasteChangedAt: 241 },
            { now: 2_415, pasteChangedAt: 2_415 },
            { now: 2_490, pasteChangedAt: 2_415, sessionBound: true, sessionBoundAt: 2_490 },
            { now: 2_499, bracketedPaste: true, pasteChangedAt: 2_499, sessionBound: true, sessionBoundAt: 2_490 },
            {
                now: 2_526,
                bracketedPaste: true,
                pasteChangedAt: 2_499,
                alternateScreen: true,
                altChangedAt: 2_526,
                sessionBound: true,
                sessionBoundAt: 2_490
            }
        ]);
        expect(results.map((result) => (result.ready ? 'ready' : (result.abandon ?? result.waiting)))).toEqual([
            'agent-foreground',
            'session',
            'trust-dialog',
            'trust-dialog',
            'session',
            'session',
            'bracketed-paste',
            'stable',
            'ready'
        ]);
    });
});

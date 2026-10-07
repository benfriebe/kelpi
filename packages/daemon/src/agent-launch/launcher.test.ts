/**
 * The agent launcher's state machine (docs/agent-lifecycle.md §6.5), on fake timers, a real store
 * and recording fakes for the PTY, the terminal state, the foreground check and delivery.
 *
 * Each `describe` is one part of the contract: when the launch line is typed (R4, and never
 * before the pane has printed), what is typed (R5), when a prefill is pasted (the readiness seam
 * and its obligations, R1, R2), every way a launch ends without one, the store as the witness of
 * a vanished pane (R7), teardown (R3), listening only while pending (R13), routing, and the
 * prompt files (R9). The real-PTY half is `launcher.integration.test.ts`.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    AGENT_READY_MAX_WAIT_MS,
    AGENT_READY_STABLE_MS,
    AGENT_READY_TIMEOUT_MS,
    AGENT_SHELL_READY_CAP_MS,
    AGENT_SHELL_SETTLE_MS,
    CLAUDE_TRUST_DIALOG_TEXT,
    PROMPT_FILE_TTL_MS,
    type AgentKind,
    type AgentReadiness,
    type AgentReadinessSignals
} from '@kelpi/core/agent';
import type { WsAgentLaunchMessage } from '@kelpi/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VtModes } from '../seams.js';
import { createStore, emptyDaemonState, type KelpiStore } from '../store/index.js';
import {
    AGENT_FIRST_OUTPUT_TIMEOUT_MS,
    AGENT_FOREGROUND_POLL_MS,
    AGENT_FOREGROUND_REUSE_MS,
    AGENT_SHELL_PASTE_EDGE_MS,
    createAgentLaunchDelivery,
    createAgentLauncher,
    isTypedInput,
    type AgentLauncher,
    type AgentLaunchRequest
} from './launcher.js';
import { createPromptFileStore, type PromptFileStore } from './prompt-files.js';

const HOME = '/Users/test';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const P2 = 'DDDDDDDD-0000-4000-8000-000000000002';
const PROMPT_FILE = '/data/prompts/0f0e0d0c-0b0a-4908-8706-050403020100.txt';
const CODEX_COMPOSER = '› Ask Codex to do anything';
const BRACKETED = (text: string): string => `\u001b[200~${text}\u001b[201~`;

type Foreground = 'shell' | 'agent' | 'error';

interface Typed {
    readonly paneID: string;
    readonly text: string;
    readonly bare: boolean;
}

interface Fixture {
    readonly launcher: AgentLauncher;
    readonly store: KelpiStore;
    readonly frames: { message: WsAgentLaunchMessage; origin: string | undefined }[];
    readonly typed: Typed[];
    readonly logs: string[];
    readonly errors: string[];
    /** Live PTY ids (a gate-held spawn counts). */
    readonly live: Set<string>;
    readonly listeners: { data: number; exit: number };
    foreground: Foreground;
    foregroundCalls: number;
    captures: number;
    shell: string | undefined;
    output(text?: string, paneID?: string): void;
    exit(paneID?: string): void;
    /** Set the parsed modes and report them as `onModesChange` would. */
    modes(next: Partial<{ bracketedPaste: boolean; alternateScreen: boolean }>, paneID?: string): void;
    /** Set the parsed modes WITHOUT the callback (a daemon that never wired it). */
    silentModes(next: Partial<{ bracketedPaste: boolean; alternateScreen: boolean }>, paneID?: string): void;
    screen(text: string, paneID?: string): void;
    /** The shell sent an OSC 7, as the terminal state reports it (`shellReported`). */
    report(paneID?: string): void;
    /**
     * zle starting: a `CSI ? 2004 h` that finds 2004 already on (no mode callback, since nothing
     * changed), in a chunk of output with the prompt.
     */
    zleStarts(paneID?: string): void;
    start(request?: Partial<AgentLaunchRequest>, options?: { paneID?: string; workspaceID?: string; origin?: string }): void;
    bindSession(sessionID: string, paneID?: string): void;
    endSession(sessionID: string, paneID?: string): void;
}

function request(overrides: Partial<AgentLaunchRequest> = {}): AgentLaunchRequest {
    return { kind: 'claude', prompt: null, send: false, promptFile: null, ...overrides };
}

function withPrompt(prompt: string, overrides: Partial<AgentLaunchRequest> = {}): AgentLaunchRequest {
    return request({ prompt, promptFile: PROMPT_FILE, ...overrides });
}

function fakePromptFiles(): PromptFileStore {
    return {
        directory: '/data/prompts',
        write: () => PROMPT_FILE,
        discard: () => {},
        sweep: () => 0
    };
}

function fixture(
    options: {
        readiness?: AgentReadiness;
        shell?: string;
        commands?: Partial<Record<AgentKind, string>>;
        /** Per call (1-based), instead of `f.foreground`. */
        foregroundAt?: (call: number) => Foreground;
        /** The pane's zsh runs Kelpi's shell integration. */
        integrated?: boolean;
    } = {}
): Fixture {
    const store = createStore(emptyDaemonState(HOME));
    for (const [workspaceID, paneID] of [
        [W1, P1],
        [W2, P2]
    ] as const) {
        store.dispatch({ type: 'create-workspace', id: workspaceID, paneID, name: 'dev', color: 'blue', now: 0 });
    }
    const dataListeners = new Set<(paneID: string, data: Uint8Array) => void>();
    const exitListeners = new Set<(paneID: string, code: number) => void>();
    const modes = new Map<string, { bracketedPaste: boolean; alternateScreen: boolean }>();
    /** DECRST 2004s "parsed", per pane: every on-to-off below counts one. */
    const resets = new Map<string, number>();
    /** DECSET 2004s "parsed", per pane: every set to ON below counts one, a repeat included. */
    const sets = new Map<string, number>();
    const setModes = (paneID: string, next: Partial<{ bracketedPaste: boolean; alternateScreen: boolean }>): void => {
        const current = modesOf(paneID);
        if (current.bracketedPaste && next.bracketedPaste === false) resets.set(paneID, (resets.get(paneID) ?? 0) + 1);
        if (next.bracketedPaste === true) sets.set(paneID, (sets.get(paneID) ?? 0) + 1);
        modes.set(paneID, { ...current, ...next });
    };
    const screens = new Map<string, string>();
    const frames: Fixture['frames'] = [];
    const typed: Typed[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const live = new Set([P1, P2]);
    const modesOf = (paneID: string) => modes.get(paneID) ?? { bracketedPaste: false, alternateScreen: false };

    const f = {
        store,
        frames,
        typed,
        logs,
        errors,
        live,
        listeners: {
            get data() {
                return dataListeners.size;
            },
            get exit() {
                return exitListeners.size;
            }
        },
        foreground: 'shell' as Foreground,
        foregroundCalls: 0,
        captures: 0,
        shell: options.shell ?? '/bin/zsh'
    } as Omit<Fixture, 'launcher' | 'output' | 'exit' | 'modes' | 'silentModes' | 'screen' | 'report' | 'zleStarts' | 'start' | 'bindSession' | 'endSession'> &
        Partial<Fixture>;

    const launcher = createAgentLauncher({
        store,
        pty: {
            has: (paneID) => live.has(paneID),
            onData(cb) {
                dataListeners.add(cb);
                return () => dataListeners.delete(cb);
            },
            onExit(cb) {
                exitListeners.add(cb);
                return () => exitListeners.delete(cb);
            }
        },
        input: {
            sendText(paneID, text, opts) {
                typed.push({ paneID, text, bare: opts.bare });
            }
        },
        term: {
            modes: (paneID): VtModes => ({ applicationCursorKeys: false, bracketedPaste: modesOf(paneID).bracketedPaste }),
            alternateScreen: (paneID) => modesOf(paneID).alternateScreen,
            bracketedPasteResets: (paneID) => resets.get(paneID) ?? 0,
            bracketedPasteSets: (paneID) => sets.get(paneID) ?? 0,
            capture: (paneID) => {
                f.captures += 1;
                return screens.get(paneID) ?? '';
            },
            flush: () => Promise.resolve()
        },
        shellOf: () => f.shell,
        ...(options.integrated !== undefined ? { shellIntegrated: () => options.integrated === true } : {}),
        foregroundIsShell: async () => {
            f.foregroundCalls += 1;
            const answer = options.foregroundAt?.(f.foregroundCalls) ?? f.foreground;
            if (answer === 'error') throw new Error('ps timed out');
            return answer === 'shell';
        },
        commandFor: (kind) => options.commands?.[kind] ?? kind,
        deliver: (message, origin) => {
            frames.push({ message, origin });
        },
        promptFiles: fakePromptFiles(),
        ...(options.readiness !== undefined ? { readiness: options.readiness } : {}),
        log: (line) => logs.push(line),
        onError: (error, context) => errors.push(`${context}: ${error.message}`)
    });

    return Object.assign(f, {
        launcher,
        output(text = 'x', paneID = P1) {
            const bytes = Buffer.from(text, 'utf8');
            for (const listener of [...dataListeners]) listener(paneID, bytes);
        },
        exit(paneID = P1) {
            live.delete(paneID);
            for (const listener of [...exitListeners]) listener(paneID, 0);
        },
        modes(next: Partial<{ bracketedPaste: boolean; alternateScreen: boolean }>, paneID = P1) {
            setModes(paneID, next);
            launcher.modesChanged(paneID);
        },
        silentModes(next: Partial<{ bracketedPaste: boolean; alternateScreen: boolean }>, paneID = P1) {
            setModes(paneID, next);
        },
        screen(text: string, paneID = P1) {
            screens.set(paneID, text);
        },
        report(paneID = P1) {
            launcher.shellReported(paneID);
        },
        zleStarts(paneID = P1) {
            const wasOn = modesOf(paneID).bracketedPaste;
            setModes(paneID, { bracketedPaste: true });
            if (!wasOn) launcher.modesChanged(paneID);
            const bytes = Buffer.from('\u001b[?1h\u001b[?2004h% ', 'utf8');
            for (const listener of [...dataListeners]) listener(paneID, bytes);
        },
        start(overrides: Partial<AgentLaunchRequest> = {}, startOptions: { paneID?: string; workspaceID?: string; origin?: string } = {}) {
            launcher.start({
                paneID: startOptions.paneID ?? P1,
                workspaceID: startOptions.workspaceID ?? W1,
                request: request(overrides),
                ...(startOptions.origin !== undefined ? { originClientID: startOptions.origin } : {})
            });
        },
        bindSession(sessionID: string, paneID = P1) {
            store.dispatch({
                type: 'pane-agent-event',
                paneID,
                event: { type: 'sessionStarted', sessionID, agent: 'claude' },
                now: Date.now()
            });
        },
        endSession(sessionID: string, paneID = P1) {
            store.dispatch({ type: 'pane-agent-event', paneID, event: { type: 'sessionEnded', sessionID }, now: Date.now() });
        }
    }) as Fixture;
}

/** Run every timer due within `ms`, draining the promise chains in between. */
async function advance(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

/** zsh at its prompt: it printed, then turned bracketed paste on. The launch line goes now. */
async function shellAtPrompt(f: Fixture): Promise<void> {
    f.output('% ');
    f.modes({ bracketedPaste: true });
    await advance();
}

/**
 * zsh ran the line: bracketed paste off, and the agent has the terminal. Time moves on by one
 * foreground poll, so the launcher's latest answer is "agent" (as it would be in real time).
 */
async function agentRunning(f: Fixture): Promise<void> {
    f.modes({ bracketedPaste: false });
    f.foreground = 'agent';
    await advance(AGENT_FOREGROUND_POLL_MS);
}

/**
 * The launch line is typed and, before the launcher's first look, zsh has run it and the agent
 * holds the terminal (2004 as given). For predicates that would say ready at once.
 */
async function launchAndRun(f: Fixture, after: { bracketedPaste: boolean } = { bracketedPaste: false }): Promise<void> {
    f.output('% ');
    f.modes({ bracketedPaste: true });
    f.foreground = 'agent';
    f.modes({ bracketedPaste: after.bracketedPaste });
    await advance();
}

/** Codex up and drawn: 2004, the alternate screen and the composer. */
async function codexDrawn(f: Fixture): Promise<void> {
    f.screen(`\n${CODEX_COMPOSER}\n`);
    f.modes({ bracketedPaste: true, alternateScreen: true });
    f.output('drawn');
    await advance();
}

const outcomes = (f: Fixture): string[] =>
    f.frames.map(({ message }) => `${message.outcome}${message.reason !== undefined ? `:${message.reason}` : ''}`);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// awaiting-shell: when the launch line is typed (R4)
// ---------------------------------------------------------------------------

describe('typing the launch line', () => {
    it('never types before the pane has printed anything, however long the spawn is held', async () => {
        const f = fixture();
        f.start();
        await advance(AGENT_FIRST_OUTPUT_TIMEOUT_MS - 1);
        expect(f.typed).toEqual([]);
        expect(f.frames).toEqual([]);
    });

    it('gives up (failed, timeout) on a pane that never prints, typing nothing', async () => {
        const f = fixture();
        f.start({ prompt: 'Fix it', promptFile: PROMPT_FILE });
        await advance(AGENT_FIRST_OUTPUT_TIMEOUT_MS);
        expect(f.typed).toEqual([]);
        expect(f.frames.map((frame) => frame.message)).toEqual([
            {
                type: 'agent-launch',
                workspaceID: W1,
                paneID: P1,
                agent: 'claude',
                outcome: 'failed',
                reason: 'timeout',
                prompt: 'Fix it',
                promptFile: PROMPT_FILE
            }
        ]);
    });

    it('zsh: types when bracketed paste turns on, and reports launched when there is no prompt', async () => {
        const f = fixture({ commands: { claude: 'env A=1 claude --model opus' } });
        f.start({}, { origin: 'client-1' });
        f.output('Last login: today\n');
        await advance(500);
        expect(f.typed).toEqual([]);
        f.modes({ bracketedPaste: true });
        await advance();
        expect(f.typed).toEqual([{ paneID: P1, text: 'env A=1 claude --model opus', bare: false }]);
        expect(f.frames).toEqual([
            {
                message: { type: 'agent-launch', workspaceID: W1, paneID: P1, agent: 'claude', outcome: 'launched' },
                origin: 'client-1'
            }
        ]);
    });

    it('zsh: a quiet spell proves nothing (instant prompts print and pause); the cap types it', async () => {
        const f = fixture({ shell: '/bin/zsh' });
        f.start();
        f.output('[p10k instant prompt]');
        await advance(AGENT_SHELL_SETTLE_MS * 3);
        expect(f.typed).toEqual([]);
        await advance(AGENT_SHELL_READY_CAP_MS - AGENT_SHELL_SETTLE_MS * 3);
        expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
        expect(outcomes(f)).toEqual(['launched']);
    });

    it('fish waits for bracketed paste exactly as zsh does', async () => {
        const f = fixture({ shell: '/opt/homebrew/bin/fish' });
        f.start({ kind: 'codex' });
        f.output('Welcome to fish');
        await advance(AGENT_SHELL_SETTLE_MS + 100);
        expect(f.typed).toEqual([]);
        f.modes({ bracketedPaste: true });
        await advance();
        expect(f.typed.map((entry) => entry.text)).toEqual(['codex']);
    });

    it('bash 3.2: types after the settle spell measured from the LAST output', async () => {
        const f = fixture({ shell: '/bin/bash' });
        f.start();
        f.output('The default interactive shell is now zsh.\n');
        await advance(AGENT_SHELL_SETTLE_MS - 100);
        f.output('bash-3.2$ ');
        await advance(AGENT_SHELL_SETTLE_MS - 100);
        expect(f.typed).toEqual([]);
        await advance(100);
        expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
    });

    it('bash 5.1+ may still signal with bracketed paste, before the spell is up', async () => {
        const f = fixture({ shell: '-bash' });
        f.start();
        f.output('$ ');
        await advance(100);
        f.modes({ bracketedPaste: true });
        await advance();
        expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
    });

    it('notices 2004 after the chunk is parsed even when no mode callback arrives', async () => {
        const f = fixture();
        f.start();
        // The terminal state reads 2004 on once the chunk is parsed; `modesChanged` never comes.
        f.silentModes({ bracketedPaste: true });
        f.output('% ');
        expect(f.typed).toEqual([]);
        await advance();
        expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
    });

    it('caps the wait at AGENT_SHELL_READY_CAP_MS after the first output whatever the shell says', async () => {
        const f = fixture({ shell: '/bin/zsh' });
        f.start();
        f.output('a');
        for (let i = 0; i < 9; i += 1) {
            await advance(1_000);
            f.output('still starting');
        }
        await advance(1_000);
        expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
        // Asked fresh, once, at the cap.
        expect(f.foregroundCalls).toBe(1);
    });

    it('at the cap, types nothing when another program has the terminal (an rc file ran tmux, ssh-add)', async () => {
        const f = fixture({ shell: '/bin/zsh' });
        f.start(withPrompt('Fix it'));
        f.output('Enter passphrase for key: ');
        f.foreground = 'agent';
        await advance(AGENT_SHELL_READY_CAP_MS);
        expect(f.typed).toEqual([]);
        expect(f.frames.map((frame) => frame.message)).toEqual([
            expect.objectContaining({ outcome: 'failed', reason: 'timeout', prompt: 'Fix it', promptFile: PROMPT_FILE })
        ]);
        expect(f.logs.some((line) => line.includes('another program has the terminal'))).toBe(true);

        // A check that cannot answer is no licence to type either.
        const g = fixture({ shell: '/bin/zsh' });
        g.start();
        g.output('% ');
        g.foreground = 'error';
        await advance(AGENT_SHELL_READY_CAP_MS);
        expect(g.typed).toEqual([]);
        expect(outcomes(g)).toEqual(['failed:timeout']);
    });

    it('types once when the shell signals while the cap is still asking about the foreground', async () => {
        const typed: string[] = [];
        const frames: string[] = [];
        let paste = false;
        let asked = 0;
        let release: (shell: boolean) => void = () => {};
        let emit: (paneID: string, data: Uint8Array) => void = () => {};
        const store = createStore(emptyDaemonState(HOME));
        store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'dev', color: 'blue', now: 0 });
        const launcher = createAgentLauncher({
            store,
            pty: {
                has: () => true,
                onData(cb) {
                    emit = cb;
                    return () => {};
                },
                onExit: () => () => {}
            },
            input: {
                sendText(_paneID, text) {
                    typed.push(text);
                }
            },
            term: {
                modes: (): VtModes => ({ applicationCursorKeys: false, bracketedPaste: paste }),
                alternateScreen: () => false,
                bracketedPasteResets: () => 0,
                bracketedPasteSets: () => 0,
                capture: () => '',
                flush: () => Promise.resolve()
            },
            shellOf: () => '/bin/zsh',
            foregroundIsShell: () => {
                asked += 1;
                return new Promise((resolve) => {
                    release = resolve;
                });
            },
            commandFor: (kind) => kind,
            deliver: (message) => {
                frames.push(`${message.outcome}${message.reason !== undefined ? `:${message.reason}` : ''}`);
            },
            promptFiles: fakePromptFiles()
        });
        launcher.start({ paneID: P1, workspaceID: W1, request: request() });
        emit(P1, Buffer.from('starting'));
        await advance(AGENT_SHELL_READY_CAP_MS);
        // The cap is asking the OS; before it answers, zle turns 2004 on and the line goes.
        expect(asked).toBe(1);
        expect(typed).toEqual([]);
        paste = true;
        launcher.modesChanged(P1);
        expect(typed).toEqual(['claude']);
        release(true);
        await advance();
        expect(typed).toEqual(['claude']);
        expect(frames).toEqual(['launched']);
    });

    describe("under Kelpi's zsh integration (a precmd report, not 2004 alone)", () => {
        it('an instant prompt turning 2004 on early does not type the line, nor does the report alone; zle does', async () => {
            const f = fixture({ shell: '/bin/zsh', integrated: true });
            f.start();
            f.output('[p10k instant prompt]');
            f.modes({ bracketedPaste: true });
            await advance(480);
            expect(f.typed).toEqual([]);
            // .zshrc is done: precmd reports the directory just before the first real prompt...
            f.report();
            await advance(2);
            // ...but the terminal is still cooked, echoing, until zle starts 1-3 ms later.
            expect(f.typed).toEqual([]);
            f.zleStarts();
            await advance();
            expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
            expect(outcomes(f)).toEqual(['launched']);
        });

        it('a DECSET from before the report is not the edge, and no edge at all waits only AGENT_SHELL_PASTE_EDGE_MS', async () => {
            const f = fixture({ shell: '/bin/zsh', integrated: true });
            f.start();
            f.output('[p10k instant prompt]');
            // Two instant-prompt DECSETs, both before the report: neither is zle's.
            f.modes({ bracketedPaste: true });
            f.modes({ bracketedPaste: true });
            f.report();
            f.output('more of the prompt');
            await advance(AGENT_SHELL_PASTE_EDGE_MS - 1);
            expect(f.typed).toEqual([]);
            await advance(1);
            expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
            expect(outcomes(f)).toEqual(['launched']);
        });

        it('a report before 2004 waits for zle (no instant prompt: precmd, then the line editor)', async () => {
            const f = fixture({ shell: '/bin/zsh', integrated: true });
            f.start();
            f.output('Last login: today\n');
            f.report();
            await advance(100);
            expect(f.typed).toEqual([]);
            // zle turns 2004 on from off: a mode change and the DECSET in one.
            f.zleStarts();
            await advance();
            expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
        });

        it('falls back to the cap (shell in front) when no report ever comes', async () => {
            const f = fixture({ shell: '/bin/zsh', integrated: true });
            f.start();
            f.output('% ');
            f.modes({ bracketedPaste: true });
            await advance(AGENT_SHELL_READY_CAP_MS - 1);
            expect(f.typed).toEqual([]);
            await advance(1);
            expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
        });

        it('only zsh: fish, bash and a zsh without it keep their own signals, and ignore reports', async () => {
            const zsh = fixture({ shell: '/bin/zsh', integrated: false });
            zsh.start();
            zsh.output('% ');
            zsh.modes({ bracketedPaste: true });
            await advance();
            expect(zsh.typed.map((entry) => entry.text)).toEqual(['claude']);

            const fish = fixture({ shell: '/opt/homebrew/bin/fish', integrated: true });
            fish.start();
            fish.output('Welcome to fish');
            fish.modes({ bracketedPaste: true });
            await advance();
            expect(fish.typed.map((entry) => entry.text)).toEqual(['claude']);

            const bash = fixture({ shell: '/bin/bash', integrated: true });
            bash.start();
            bash.output('bash-3.2$ ');
            bash.report();
            await advance(AGENT_SHELL_SETTLE_MS - 1);
            expect(bash.typed).toEqual([]);
            await advance(1);
            expect(bash.typed.map((entry) => entry.text)).toEqual(['claude']);
        });
    });
});

// ---------------------------------------------------------------------------
// what is typed (R5)
// ---------------------------------------------------------------------------

describe('send mode', () => {
    it('types the exact send-mode line and reports sent, without the prompt', async () => {
        const f = fixture({ commands: { claude: 'claude' } });
        f.start(withPrompt('Fix ENG-1', { send: true }));
        await shellAtPrompt(f);
        expect(f.typed).toEqual([{ paneID: P1, text: `claude "$(command cat '${PROMPT_FILE}') "`, bare: false }]);
        expect(f.frames.map((frame) => frame.message)).toEqual([
            { type: 'agent-launch', workspaceID: W1, paneID: P1, agent: 'claude', outcome: 'sent' }
        ]);
    });

    it('ends the agent options with -- for a prompt that starts with a dash', async () => {
        const f = fixture();
        f.start(withPrompt('--help me', { send: true, kind: 'codex' }));
        await shellAtPrompt(f);
        expect(f.typed[0]?.text).toBe(`codex -- "$(command cat '${PROMPT_FILE}') "`);
    });

    it('refuses send mode in a shell whose syntax the line is not: failed, nothing typed', async () => {
        const f = fixture({ shell: '/opt/homebrew/bin/nu' });
        f.start(withPrompt('Fix it', { send: true }));
        f.output('> ');
        await advance(AGENT_SHELL_SETTLE_MS);
        expect(f.typed).toEqual([]);
        expect(f.frames[0]?.message).toMatchObject({
            outcome: 'failed',
            reason: 'unsupported-shell',
            prompt: 'Fix it',
            promptFile: PROMPT_FILE
        });
    });

    it('still launches in any shell when there is no prompt to send', async () => {
        const f = fixture({ shell: '/usr/bin/xonsh' });
        f.start({ send: true });
        f.output('> ');
        await advance(AGENT_SHELL_SETTLE_MS);
        expect(f.typed.map((entry) => entry.text)).toEqual(['claude']);
        expect(outcomes(f)).toEqual(['launched']);
    });

    it('reads the command when it types, so a Settings edit governs a launch already waiting', async () => {
        const commands: Partial<Record<AgentKind, string>> = { codex: 'codex' };
        const f = fixture({ commands });
        f.start({ kind: 'codex' });
        f.output('% ');
        commands.codex = 'codex --yolo';
        f.modes({ bracketedPaste: true });
        await advance();
        expect(f.typed[0]?.text).toBe('codex --yolo');
    });
});

// ---------------------------------------------------------------------------
// awaiting-agent: the prefill (the readiness seam, R1, R2)
// ---------------------------------------------------------------------------

describe('prefill', () => {
    it('codex: pastes bracketed, without Enter, once 2004 + alternate screen + composer have held', async () => {
        const f = fixture();
        f.start(withPrompt('Fix ENG-1\nwith care', { kind: 'codex' }), { origin: 'client-1' });
        await shellAtPrompt(f);
        expect(f.typed).toEqual([{ paneID: P1, text: 'codex', bare: false }]);
        await agentRunning(f);
        await codexDrawn(f);
        expect(f.typed).toHaveLength(1);
        await advance(AGENT_READY_STABLE_MS - 1);
        expect(f.typed).toHaveLength(1);
        await advance(1);
        expect(f.typed[1]).toEqual({ paneID: P1, text: 'Fix ENG-1\nwith care', bare: true });
        expect(f.frames).toEqual([
            {
                message: { type: 'agent-launch', workspaceID: W1, paneID: P1, agent: 'codex', outcome: 'prefilled' },
                origin: 'client-1'
            }
        ]);
        // The log names the file, never the text.
        expect(f.logs.join('\n')).toContain(PROMPT_FILE);
        expect(f.logs.join('\n')).not.toContain('ENG-1');
    });

    it('claude: never pastes at the first 2004 (trust dialog or undrawn phase), only after SessionStart', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        f.modes({ bracketedPaste: true });
        f.output('...');
        await advance(2_000);
        expect(f.typed).toHaveLength(1);
        // SessionStart arrives with 2004 OFF, which comes back on a few ms later, then 1049.
        f.modes({ bracketedPaste: false });
        f.bindSession('S1');
        await advance(10);
        expect(f.typed).toHaveLength(1);
        f.modes({ bracketedPaste: true });
        await advance(20);
        expect(f.typed).toHaveLength(1);
        f.modes({ alternateScreen: true });
        await advance();
        expect(f.typed[1]).toEqual({ paneID: P1, text: 'Fix it', bare: true });
        expect(outcomes(f)).toEqual(['prefilled']);
    });

    it('claude without the full-screen renderer: ready once 2004 has held for the stable window after SessionStart', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        f.bindSession('S1');
        f.modes({ bracketedPaste: true });
        await advance(AGENT_READY_STABLE_MS - 1);
        expect(f.typed).toHaveLength(1);
        await advance(1);
        expect(f.typed[1]?.bare).toBe(true);
    });

    it('ignores a session that was bound before the line was typed', async () => {
        const f = fixture();
        f.bindSession('OLD');
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        f.modes({ bracketedPaste: true, alternateScreen: true });
        f.output('...');
        await advance(1_000);
        expect(f.typed).toHaveLength(1);
        f.bindSession('NEW');
        await advance();
        expect(outcomes(f)).toEqual(['prefilled']);
    });

    it('evaluates after the terminal state has parsed the chunk, and reads the screen lazily', async () => {
        const seen: AgentReadinessSignals[] = [];
        const f = fixture({
            readiness: (signals) => {
                seen.push(signals);
                return { ready: false, waiting: 'composer' };
            }
        });
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        await shellAtPrompt(f);
        const launchedAt = Date.now();
        await advance(5);
        await agentRunning(f);
        f.output('x');
        await advance();
        expect(f.captures).toBe(0);
        const last = seen.at(-1);
        expect(last).toMatchObject({
            kind: 'codex',
            launchedAt,
            sessionBound: false,
            sessionBoundAt: null,
            foregroundIsShell: false,
            userInputSinceLaunch: false,
            holdingSince: null
        });
        expect(last?.modes).toEqual({ bracketedPaste: false, alternateScreen: false });
        // 2004 went on at the prompt (before the launch) and off after it.
        expect(last?.modeChangedAt.bracketedPaste).toBeGreaterThanOrEqual(launchedAt);
        expect(last?.modeChangedAt.alternateScreen).toBeNull();
        expect(last?.lastOutputAt).toBe(Date.now());
        f.screen('hello');
        expect(last?.screenText()).toBe('hello');
        expect(last?.screenText()).toBe('hello');
        expect(f.captures).toBe(1);
    });

    it('sets holdingSince on the first stable answer, keeps it, and clears it on any other', async () => {
        let waiting: 'stable' | 'composer' = 'stable';
        const holding: (number | null)[] = [];
        const f = fixture({
            readiness: (signals) => {
                if (signals.foregroundIsShell) return { ready: false, waiting: 'agent-foreground' };
                holding.push(signals.holdingSince);
                return { ready: false, waiting };
            }
        });
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        await launchAndRun(f);
        const first = Date.now();
        expect(holding.at(-1)).toBe(first);
        await advance(50);
        f.output('a');
        await advance();
        expect(holding.at(-1)).toBe(first);
        waiting = 'composer';
        await advance(50);
        f.output('b');
        await advance();
        expect(holding.at(-1)).toBe(first); // what this answer was given; it then clears
        waiting = 'stable';
        await advance(50);
        f.output('c');
        await advance();
        expect(holding.at(-1)).toBeNull();
        const restarted = Date.now();
        await advance(50);
        f.output('d');
        await advance();
        expect(holding.at(-1)).toBe(restarted);
    });

    it('honours recheckInMs: a window that ends with nothing happening is asked about again', async () => {
        // Shorter than the foreground poll, so only the requested recheck can be what asks.
        const window = AGENT_FOREGROUND_POLL_MS - 40;
        let calls = 0;
        const f = fixture({
            readiness: (signals) => {
                calls += 1;
                const waited = signals.now - signals.launchedAt;
                return waited >= window ? { ready: true } : { ready: false, waiting: 'stable', recheckInMs: window - waited };
            }
        });
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        await launchAndRun(f, { bracketedPaste: true });
        const before = calls;
        await advance(window - 1);
        expect(calls).toBe(before);
        expect(f.typed).toHaveLength(1);
        await advance(1);
        expect(calls).toBe(before + 1);
        expect(outcomes(f)).toEqual(['prefilled']);
    });

    it('re-asks every poll while waiting, even with the agent in front and nothing happening', async () => {
        const seen: boolean[] = [];
        const f = fixture({
            readiness: (signals) => {
                seen.push(signals.foregroundIsShell);
                return { ready: false, waiting: 'composer' };
            }
        });
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        // The look that happened to land while a short-lived child held the terminal.
        await launchAndRun(f, { bracketedPaste: true });
        expect(seen.at(-1)).toBe(false);
        // The child is gone and the shell's prompt was the pane's last output: only the poll asks.
        f.foreground = 'shell';
        await advance(AGENT_FOREGROUND_POLL_MS);
        expect(seen.at(-1)).toBe(true);
    });

    it('shares one foreground answer between the chunks of a burst, and a poll always asks afresh', async () => {
        const f = fixture({ readiness: () => ({ ready: false, waiting: 'composer' }) });
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        await launchAndRun(f, { bracketedPaste: true });
        const before = f.foregroundCalls;
        // An agent drawing its start-up: twenty chunks inside one reuse window, one `ps`.
        for (let i = 0; i < 20; i += 1) {
            f.output(`frame ${String(i)}`);
            await advance(5);
        }
        expect(AGENT_FOREGROUND_REUSE_MS).toBeGreaterThanOrEqual(AGENT_FOREGROUND_POLL_MS);
        expect(f.foregroundCalls - before).toBeLessThanOrEqual(1);
        // Then quiet: one fresh ask per poll, no more.
        const quiet = f.foregroundCalls;
        await advance(AGENT_FOREGROUND_POLL_MS * 4);
        expect(f.foregroundCalls - quiet).toBeGreaterThanOrEqual(3);
        expect(f.foregroundCalls - quiet).toBeLessThanOrEqual(4);
    });

    it('R1: even a predicate that says ready never gets a paste into a shell in the foreground', async () => {
        const f = fixture({ readiness: () => ({ ready: true }) });
        f.start(withPrompt('rm -rf ~', { kind: 'codex' }));
        await shellAtPrompt(f);
        expect(f.typed.map((entry) => entry.text)).toEqual(['codex']);
        expect(f.frames[0]?.message).toMatchObject({ outcome: 'fallback', reason: 'agent-exited', prompt: 'rm -rf ~' });
    });

    it('R1: the check right before the paste is FRESH: the agent seen a moment ago is not enough', async () => {
        const readiness: AgentReadiness = (signals) =>
            signals.foregroundIsShell ? { ready: false, waiting: 'agent-foreground' } : { ready: true };
        // The look that judged readiness saw the agent; by the paste the shell is back.
        const f = fixture({ readiness, foregroundAt: (call) => (call === 1 ? 'agent' : 'shell') });
        f.start(withPrompt('rm -rf ~', { kind: 'codex' }));
        await launchAndRun(f, { bracketedPaste: true });
        expect(f.foregroundCalls).toBe(2);
        expect(f.typed).toHaveLength(1);
        expect(outcomes(f)).toEqual(['fallback:agent-exited']);

        // A fresh check that cannot answer is a fallback too, never a paste.
        const g = fixture({ readiness, foregroundAt: (call) => (call === 1 ? 'agent' : 'error') });
        g.start(withPrompt('Fix it', { kind: 'codex' }));
        await launchAndRun(g, { bracketedPaste: true });
        expect(g.typed).toHaveLength(1);
        expect(outcomes(g)).toEqual(['fallback:predicate-error']);
    });

    it('treats an unanswered foreground check as the shell while waiting', async () => {
        const seen: boolean[] = [];
        const f = fixture({
            readiness: (signals) => {
                seen.push(signals.foregroundIsShell);
                return { ready: false, waiting: 'agent-foreground' };
            }
        });
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        f.foreground = 'error';
        await shellAtPrompt(f);
        expect(seen).toEqual([true]);
        expect(f.frames).toEqual([]);
    });

    it('never pastes unframed: ready with 2004 off waits, and the timeout says no-bracketed-paste', async () => {
        const f = fixture({ readiness: () => ({ ready: true }) });
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        await launchAndRun(f);
        f.output('x');
        await advance(AGENT_READY_TIMEOUT_MS);
        expect(f.typed).toHaveLength(1);
        expect(outcomes(f)).toEqual(['fallback:no-bracketed-paste']);
    });

    it('polls the foreground while the shell may still have it, so a quiet agent is still seen', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        await shellAtPrompt(f);
        f.modes({ bracketedPaste: false });
        // The agent draws everything while the answer still says "shell", then goes quiet.
        f.screen(CODEX_COMPOSER);
        f.modes({ bracketedPaste: true, alternateScreen: true });
        await advance();
        f.foreground = 'agent';
        await advance(1_000);
        expect(outcomes(f)).toEqual(['prefilled']);
    });
});

// ---------------------------------------------------------------------------
// the ready timeout and the trust dialog
// ---------------------------------------------------------------------------

describe('the ready timeout', () => {
    it('falls back (timeout) with the prompt when the agent never becomes ready', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it', { kind: 'codex' }), { origin: 'client-1' });
        await shellAtPrompt(f);
        const launchedAt = Date.now();
        await agentRunning(f);
        // Up and full-screen, but its composer never appears.
        f.modes({ bracketedPaste: true, alternateScreen: true });
        f.output('logging in…');
        await advance(launchedAt + AGENT_READY_TIMEOUT_MS - 1 - Date.now());
        expect(f.frames).toEqual([]);
        await advance(1);
        expect(f.frames).toEqual([
            {
                message: {
                    type: 'agent-launch',
                    workspaceID: W1,
                    paneID: P1,
                    agent: 'codex',
                    outcome: 'fallback',
                    reason: 'timeout',
                    prompt: 'Fix it',
                    promptFile: PROMPT_FILE
                },
                origin: 'client-1'
            }
        ]);
        expect(f.typed).toHaveLength(1);
    });

    it('runs from the launch line, not from the create', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        f.output('% ');
        await advance(5_000);
        f.modes({ bracketedPaste: true });
        await advance();
        const launchedAt = Date.now();
        await agentRunning(f);
        await advance(launchedAt + AGENT_READY_TIMEOUT_MS - 1 - Date.now());
        expect(f.frames).toEqual([]);
        await advance(1);
        // Claude in front, still waiting for SessionStart: the reason says why (below).
        expect(outcomes(f)).toEqual(['fallback:no-session-start']);
    });

    it('is paused while a trust dialog is up, and the rest of the budget applies afterwards', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        const launchedAt = Date.now();
        await agentRunning(f);
        await advance(2_000);
        const used = Date.now() - launchedAt;
        f.screen(`Quick safety check: ${CLAUDE_TRUST_DIALOG_TEXT}?\n❯ No, exit`);
        f.modes({ bracketedPaste: true });
        await advance(60_000);
        expect(f.frames).toEqual([]);
        // Accepted: the dialog goes, and the rest of the 10 s is what is left.
        f.screen('');
        f.output('.');
        await advance(AGENT_READY_TIMEOUT_MS - used - 1);
        expect(f.frames).toEqual([]);
        await advance(1);
        // Accepted, yet no SessionStart ever came: Claude is running without Kelpi's hooks.
        expect(outcomes(f)).toEqual(['fallback:no-session-start']);
    });

    it('gives up after AGENT_READY_MAX_WAIT_MS in all, however long a trust dialog has held the budget', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        const launchedAt = Date.now();
        await agentRunning(f);
        // Nobody answers the dialog: the budget stays paused for good.
        f.screen(`Quick safety check: ${CLAUDE_TRUST_DIALOG_TEXT}?\n❯ No, exit`);
        f.modes({ bracketedPaste: true });
        await advance(launchedAt + AGENT_READY_MAX_WAIT_MS - 1 - Date.now());
        expect(f.frames).toEqual([]);
        await advance(1);
        expect(f.frames.map((frame) => frame.message)).toEqual([
            expect.objectContaining({ outcome: 'fallback', reason: 'timeout', prompt: 'Fix it', promptFile: PROMPT_FILE })
        ]);
        expect(f.typed).toHaveLength(1);
        expect(f.launcher.pending).toBe(0);
        expect(f.listeners).toEqual({ data: 0, exit: 0 });
    });

    it('says no-session-start when Claude Code had the terminal and its SessionStart never came', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        // Claude draws its input box and waits: everything but the hook Kelpi needs.
        f.modes({ bracketedPaste: true, alternateScreen: true });
        f.output('> ');
        await advance(AGENT_READY_TIMEOUT_MS);
        expect(f.typed).toHaveLength(1);
        expect(outcomes(f)).toEqual(['fallback:no-session-start']);

        // The same wait with the SHELL in front is the agent having gone, not missing hooks.
        const g = fixture({ shell: '/bin/bash' });
        g.start(withPrompt('Fix it'));
        g.output('bash-3.2$ ');
        await advance(AGENT_SHELL_SETTLE_MS);
        await advance(AGENT_READY_TIMEOUT_MS);
        expect(outcomes(g)).toEqual(['fallback:agent-exited']);
    });

    it('a trust dialog accepted in time ends in a prefill', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        f.screen(`${CLAUDE_TRUST_DIALOG_TEXT}?`);
        f.modes({ bracketedPaste: true });
        await advance(30_000);
        expect(f.typed).toHaveLength(1);
        f.screen('');
        f.modes({ bracketedPaste: false });
        f.bindSession('S1');
        f.modes({ bracketedPaste: true, alternateScreen: true });
        await advance();
        expect(outcomes(f)).toEqual(['prefilled']);
    });

    it('says no-bracketed-paste when the agent had the terminal and never asked for framed pastes', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        await shellAtPrompt(f);
        await agentRunning(f);
        f.output('x');
        await advance(AGENT_READY_TIMEOUT_MS);
        expect(outcomes(f)).toEqual(['fallback:no-bracketed-paste']);
    });

    it('says agent-exited when the shell had the terminal when time ran out (bash 3.2, no 2004)', async () => {
        const f = fixture({ shell: '/bin/bash' });
        f.start(withPrompt('Fix it'));
        f.output('bash-3.2$ ');
        await advance(AGENT_SHELL_SETTLE_MS);
        expect(f.typed).toHaveLength(1);
        f.output('bash: claude: command not found\nbash-3.2$ ');
        await advance(AGENT_READY_TIMEOUT_MS);
        expect(f.typed).toHaveLength(1);
        expect(outcomes(f)).toEqual(['fallback:agent-exited']);
    });
});

// ---------------------------------------------------------------------------
// every other way a launch ends
// ---------------------------------------------------------------------------

describe('fallbacks and failures', () => {
    it('reports agent-exited at once when the shell is back at its prompt (2004 on again, shell in front)', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        f.modes({ bracketedPaste: false });
        await advance(5);
        f.output('zsh: command not found: claude\n% ');
        f.modes({ bracketedPaste: true });
        // The next foreground look (at most a poll away) finds the shell back in charge.
        await advance(AGENT_FOREGROUND_POLL_MS);
        expect(f.typed).toHaveLength(1);
        expect(outcomes(f)).toEqual(['fallback:agent-exited']);
    });

    it('still sees the shell come back when its 2004 off and on were parsed in one write', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await advance(5);
        // One coalesced write: `?2004l`, the error, the prompt, `?2004h`. The modes never read off.
        f.silentModes({ bracketedPaste: false });
        f.silentModes({ bracketedPaste: true });
        f.output('\u001b[?2004lzsh: command not found: claude\n% \u001b[?2004h');
        await advance(AGENT_FOREGROUND_POLL_MS);
        expect(f.typed).toHaveLength(1);
        expect(outcomes(f)).toEqual(['fallback:agent-exited']);
    });

    it('does not take the shell not having run the line yet for the shell coming back', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        // 2004 is still on from the prompt and no DECRST has been parsed: zsh is slow to read.
        await shellAtPrompt(f);
        await advance(AGENT_FOREGROUND_POLL_MS * 5);
        expect(f.frames).toEqual([]);
    });

    it('does not take the agent turning 2004 on for the shell coming back', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        await shellAtPrompt(f);
        await agentRunning(f);
        f.modes({ bracketedPaste: true });
        await advance(50);
        expect(f.frames).toEqual([]);
    });

    it('a session that bound and then ended is agent-exited', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        f.bindSession('S1');
        await advance();
        f.endSession('S1');
        await advance();
        expect(outcomes(f)).toEqual(['fallback:agent-exited']);
    });

    it('user input after the launch line is a fallback (user-typed), never an interleaved paste', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        f.launcher.inputWritten(P1, 'h');
        await advance();
        expect(outcomes(f)).toEqual(['fallback:user-typed']);
        expect(f.typed).toHaveLength(1);
    });

    it('user input before the launch line fails the launch rather than append the line to it', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        f.output('% ');
        f.launcher.inputWritten(P1, Buffer.from('ls'));
        f.modes({ bracketedPaste: true });
        await advance();
        expect(f.typed).toEqual([]);
        expect(f.frames[0]?.message).toMatchObject({ outcome: 'failed', reason: 'user-typed', prompt: 'Fix it' });
    });

    it('a terminal answering on its own (focus, mouse, device reports) is not someone typing', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        for (const report of ['\u001b[I', '\u001b[O', '\u001b[<35;10;5M', '\u001b[?62;22c', '\u001b]11;rgb:0000/0000/0000\u001b\\']) {
            f.launcher.inputWritten(P1, report);
        }
        f.launcher.inputWritten(P2, 'typing elsewhere');
        await advance();
        expect(f.frames).toEqual([]);
    });

    it('a throwing predicate is a fallback (predicate-error)', async () => {
        const f = fixture({
            readiness: () => {
                throw new Error('boom');
            }
        });
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        expect(outcomes(f)).toEqual(['fallback:predicate-error']);
        expect(f.errors.join('\n')).toContain('boom');
    });

    it('an abandon answer ends the wait with its reason', async () => {
        const f = fixture({ readiness: () => ({ ready: false, abandon: 'user-typed' }) });
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        await agentRunning(f);
        expect(outcomes(f)).toEqual(['fallback:user-typed']);
    });
});

// ---------------------------------------------------------------------------
// R7: the pane going away
// ---------------------------------------------------------------------------

describe('a pane that goes away', () => {
    it('closed while the spawn gate holds it (no exit ever fires): failed, pane-exited', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        f.live.delete(P1);
        f.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        await advance();
        expect(f.frames[0]?.message).toMatchObject({ outcome: 'failed', reason: 'pane-exited', prompt: 'Fix it' });
    });

    it('its workspace deleted: failed before the line, fallback after', async () => {
        const f = fixture();
        f.start({}, { paneID: P2, workspaceID: W2 });
        f.store.dispatch({ type: 'delete-workspace', id: W2 });
        expect(outcomes(f)).toEqual(['failed:pane-exited']);

        const g = fixture();
        g.start(withPrompt('Fix it'));
        await shellAtPrompt(g);
        g.store.dispatch({ type: 'delete-workspace', id: W1 });
        expect(outcomes(g)).toEqual(['fallback:pane-exited']);
    });

    it('its shell exits after the launch line: fallback, pane-exited', async () => {
        const f = fixture();
        f.start(withPrompt('Fix it'));
        await shellAtPrompt(f);
        f.exit();
        expect(outcomes(f)).toEqual(['fallback:pane-exited']);
    });

    it('checks the store AND the PTY before typing anything', async () => {
        const f = fixture();
        f.start();
        f.output('% ');
        f.live.delete(P1);
        f.modes({ bracketedPaste: true });
        await advance();
        expect(f.typed).toEqual([]);
        expect(outcomes(f)).toEqual(['failed:pane-exited']);
    });

    it('a pane that is already gone when the launch starts fails at once', () => {
        const f = fixture();
        f.start({}, { paneID: 'DDDDDDDD-0000-4000-8000-0000000000FF' });
        expect(outcomes(f)).toEqual(['failed:pane-exited']);
    });

    it('checks the pane is still there right before the paste', async () => {
        const f = fixture({ readiness: () => ({ ready: true }) });
        f.start(withPrompt('Fix it', { kind: 'codex' }));
        f.output('% ');
        f.modes({ bracketedPaste: true });
        f.foreground = 'agent';
        f.live.delete(P1);
        await advance();
        expect(f.typed).toHaveLength(1);
        expect(outcomes(f)).toEqual(['fallback:pane-exited']);
    });
});

// ---------------------------------------------------------------------------
// R3: teardown, and exactly one frame
// ---------------------------------------------------------------------------

describe('abandonAll', () => {
    it('reports every pending launch with its prompt, then stays inert', async () => {
        const f = fixture();
        f.start(withPrompt('one'), { paneID: P1, workspaceID: W1, origin: 'client-1' });
        f.start(withPrompt('two'), { paneID: P2, workspaceID: W2 });
        await shellAtPrompt(f); // P1's line is typed
        f.launcher.abandonAll('daemon-stopping');
        expect(f.frames.map(({ message }) => [message.paneID, message.outcome, message.reason, message.prompt])).toEqual([
            [P1, 'fallback', 'daemon-stopping', 'one'],
            [P2, 'failed', 'daemon-stopping', 'two']
        ]);
        expect(f.launcher.pending).toBe(0);
        // The kill that follows a stop: no second frame, nothing typed.
        f.exit(P1);
        f.exit(P2);
        f.output('late', P2);
        await advance(AGENT_READY_TIMEOUT_MS * 2);
        expect(f.frames).toHaveLength(2);
        expect(f.typed).toHaveLength(1);
    });

    it('a create that lands after it fails at once, so its reply’s promise is still kept', () => {
        const f = fixture();
        f.launcher.abandonAll('daemon-stopping');
        f.start(withPrompt('late'));
        expect(f.frames[0]?.message).toMatchObject({ outcome: 'failed', reason: 'daemon-stopping', prompt: 'late' });
        expect(f.launcher.pending).toBe(0);
    });

    it('a finished launch sends nothing more, whatever happens to its pane', async () => {
        const f = fixture();
        f.start();
        await shellAtPrompt(f);
        f.exit();
        f.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        f.launcher.abandonAll('daemon-stopping');
        await advance(AGENT_FIRST_OUTPUT_TIMEOUT_MS);
        expect(outcomes(f)).toEqual(['launched']);
    });
});

// ---------------------------------------------------------------------------
// R13: listening only while pending
// ---------------------------------------------------------------------------

describe('listening', () => {
    it('subscribes to PTY output and exits only while a launch is pending', async () => {
        const f = fixture();
        expect(f.listeners).toEqual({ data: 0, exit: 0 });
        f.start();
        expect(f.listeners).toEqual({ data: 1, exit: 1 });
        f.start({}, { paneID: P2, workspaceID: W2 });
        expect(f.listeners).toEqual({ data: 1, exit: 1 });
        await shellAtPrompt(f);
        expect(f.listeners).toEqual({ data: 1, exit: 1 });
        f.output('% ', P2);
        f.modes({ bracketedPaste: true }, P2);
        await advance();
        expect(outcomes(f)).toEqual(['launched', 'launched']);
        expect(f.listeners).toEqual({ data: 0, exit: 0 });
    });

    it('ignores input to panes it is not launching into', () => {
        const f = fixture();
        f.launcher.inputWritten(P1, 'x');
        f.launcher.modesChanged(P1);
        expect(f.frames).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// routing (wire-protocol.md §6.3)
// ---------------------------------------------------------------------------

describe('createAgentLaunchDelivery', () => {
    const frame = (outcome: WsAgentLaunchMessage['outcome']): WsAgentLaunchMessage => ({
        type: 'agent-launch',
        workspaceID: W1,
        paneID: P1,
        agent: 'claude',
        outcome,
        ...(outcome === 'fallback' || outcome === 'failed' ? { reason: 'timeout' as const, prompt: 'p' } : {})
    });

    function routes(reachable: boolean) {
        const sent: { clientID: string; message: WsAgentLaunchMessage }[] = [];
        const broadcast: WsAgentLaunchMessage[] = [];
        const deliver = createAgentLaunchDelivery({
            sendToClient: (clientID, message) => {
                if (reachable) sent.push({ clientID, message });
                return reachable;
            },
            broadcast: (message) => broadcast.push(message)
        });
        return { deliver, sent, broadcast };
    }

    it('sends every outcome to the session that asked when it is still there', () => {
        const r = routes(true);
        for (const outcome of ['launched', 'sent', 'prefilled', 'fallback', 'failed'] as const) r.deliver(frame(outcome), 'client-1');
        expect(r.sent.map((entry) => [entry.clientID, entry.message.outcome])).toEqual([
            ['client-1', 'launched'],
            ['client-1', 'sent'],
            ['client-1', 'prefilled'],
            ['client-1', 'fallback'],
            ['client-1', 'failed']
        ]);
        expect(r.sent.every((entry) => entry.message.broadcast === undefined)).toBe(true);
        expect(r.broadcast).toEqual([]);
    });

    it('broadcasts only fallback and failed, marked broadcast, when the session is gone or there was none', () => {
        for (const origin of ['client-gone', undefined]) {
            const r = routes(false);
            for (const outcome of ['launched', 'sent', 'prefilled', 'fallback', 'failed'] as const) r.deliver(frame(outcome), origin);
            expect(r.broadcast.map((message) => [message.outcome, message.broadcast, message.prompt])).toEqual([
                ['fallback', true, 'p'],
                ['failed', true, 'p']
            ]);
        }
    });
});

// ---------------------------------------------------------------------------
// typed input
// ---------------------------------------------------------------------------

describe('isTypedInput', () => {
    it('counts keystrokes and pastes, and not the reports a terminal sends on its own', () => {
        for (const typed of ['a', '\r', '\u0003', '\u001b[A', '\u001b[97;5u', '\u001b[200~x\u001b[201~', 'é', '\u001b[I hi']) {
            expect(isTypedInput(typed)).toBe(true);
        }
        for (const report of [
            '\u001b[I',
            '\u001b[O\u001b[I',
            '\u001b[<0;12;4M\u001b[<0;12;4m',
            '\u001b[M !!',
            '\u001b[32;10;5M',
            '\u001b[?62;22c',
            '\u001b[>0;276;0c',
            '\u001b[0n',
            '\u001b[12;40R',
            '\u001b[?1u',
            '\u001b]10;rgb:ffff/ffff/ffff\u0007',
            '\u001bP>|ghostty 1.2\u001b\\',
            '\u001b[97;1:3u'
        ]) {
            expect(isTypedInput(report)).toBe(false);
        }
        expect(isTypedInput(new Uint8Array([0x1b, 0x5b, 0x49]))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// R9: prompt files
// ---------------------------------------------------------------------------

describe('prompt files', () => {
    const roots: string[] = [];
    const root = (): string => {
        const dir = mkdtempSync(join(tmpdir(), 'kelpi-prompt-files-'));
        roots.push(dir);
        return dir;
    };

    beforeEach(() => {
        vi.useRealTimers();
    });

    afterEach(() => {
        for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    const mode = (path: string): number => statSync(path).mode & 0o777;

    it('writes <uuid>.txt, 0600, exclusively, in a 0700 directory it creates', () => {
        const dir = join(root(), 'prompts');
        const files = createPromptFileStore({ directory: dir, uuid: () => 'ABCDEF01-2345-4678-9ABC-DEF012345678' });
        const file = files.write('Fix ENG-1\n€');
        expect(file).toBe(join(dir, 'abcdef01-2345-4678-9abc-def012345678.txt'));
        expect(readFileSync(file, 'utf8')).toBe('Fix ENG-1\n€');
        expect(mode(file)).toBe(0o600);
        expect(mode(dir)).toBe(0o700);
        // `wx`: a name that is already taken (a planted file or link) fails rather than follows.
        expect(() => files.write('again')).toThrow(/EEXIST/);
    });

    it('forces an existing, looser directory back to 0700', () => {
        const dir = join(root(), 'prompts');
        mkdirSync(dir, { mode: 0o755 });
        chmodSync(dir, 0o755);
        createPromptFileStore({ directory: dir }).write('x');
        expect(mode(dir)).toBe(0o700);
    });

    it('refuses a directory that is a symlink', () => {
        const base = root();
        const target = join(base, 'elsewhere');
        mkdirSync(target);
        const dir = join(base, 'prompts');
        symlinkSync(target, dir);
        expect(() => createPromptFileStore({ directory: dir }).write('x')).toThrow(/not a directory/);
        expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    });

    it('makes a private temporary directory for an in-memory daemon on the first write', () => {
        const base = root();
        const files = createPromptFileStore({ directory: null, temporaryRoot: base });
        expect(files.directory).toBeNull();
        expect(files.sweep()).toBe(0);
        const file = files.write('x');
        expect(files.directory).not.toBeNull();
        expect(file.startsWith(join(base, 'kelpi-prompts-'))).toBe(true);
        expect(mode(files.directory ?? '')).toBe(0o700);
    });

    it('sweeps only our own day-old regular files, at boot and on every write, never through a link', () => {
        const dir = join(root(), 'prompts');
        mkdirSync(dir, { mode: 0o700 });
        const now = Date.now();
        const old = (now - PROMPT_FILE_TTL_MS - 1_000) / 1000;
        const stale = join(dir, '11111111-1111-4111-8111-111111111111.txt');
        const fresh = join(dir, '22222222-2222-4222-8222-222222222222.txt');
        const foreign = join(dir, 'notes.txt');
        const outside = join(root(), 'precious.txt');
        const link = join(dir, '33333333-3333-4333-8333-333333333333.txt');
        writeFileSync(stale, 's');
        writeFileSync(fresh, 'f');
        writeFileSync(foreign, 'n');
        writeFileSync(outside, 'p');
        symlinkSync(outside, link);
        for (const path of [stale, foreign, outside]) utimesSync(path, old, old);
        const files = createPromptFileStore({ directory: dir });
        expect(files.sweep()).toBe(1);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
        expect(existsSync(foreign)).toBe(true);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(outside, 'utf8')).toBe('p');

        // On write too.
        const later = join(dir, '44444444-4444-4444-8444-444444444444.txt');
        writeFileSync(later, 'l');
        utimesSync(later, old, old);
        files.write('new');
        expect(existsSync(later)).toBe(false);
    });

    it('discards a file it wrote, and nothing else', () => {
        const dir = join(root(), 'prompts');
        const files = createPromptFileStore({ directory: dir });
        const file = files.write('x');
        const outside = join(root(), '55555555-5555-4555-8555-555555555555.txt');
        writeFileSync(outside, 'keep');
        files.discard(outside);
        files.discard(join(dir, 'notes.txt'));
        expect(existsSync(outside)).toBe(true);
        files.discard(file);
        expect(existsSync(file)).toBe(false);
        files.discard(file); // already gone: quiet
    });
});

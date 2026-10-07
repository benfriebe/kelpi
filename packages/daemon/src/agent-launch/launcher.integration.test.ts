/**
 * The agent launcher against REAL shells in real PTYs (R16; the pattern of the real-shell tests in
 * `pty/input.test.ts`): zsh's line editor turning bracketed paste on, bash 3.2's quiet prompt, a
 * real foreground process group read with `ps`, and a real terminal state parsing the output.
 *
 * The "agent" is a small node script written here, not Claude Code or codex: it behaves like
 * codex as phase 0 measured it (bracketed paste on at once, the alternate screen, a `›` composer,
 * optionally a "Trust this folder?" dialog first) and records every byte it receives, tagged with
 * what it was showing at the time, so a test can prove a paste arrived whole, framed, unsubmitted
 * and never during a dialog.
 *
 * Hermetic by construction: every shell gets a minimal environment built from scratch (no
 * inherited `KELPI_*` / `KELPID_*`, so nothing in a pane can reach a live Kelpi daemon this suite
 * may be running under; an empty `ZDOTDIR` and `HOME`, so no user rc file runs unless a test
 * writes one), and nothing touches the network. A test that runs Kelpi's zsh integration installs
 * it into its own scratch directory and passes on only the `ZDOTDIR` the manager points at it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { shellSingleQuote, type AgentKind, type AgentReadiness } from '@kelpi/core/agent';
import type { WsAgentLaunchMessage } from '@kelpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createForegroundReader } from '../pty/foreground.js';
import { createTerminalInput } from '../pty/input.js';
import { createPtyManager, type KelpiPtyManager } from '../pty/manager.js';
import { installShellIntegration } from '../pty/shell-integration.js';
import { createPaneSpawnGate, withSpawnGate } from '../pty/spawn-gate.js';
import { nodePtySpawner } from '../pty/spawner.js';
import type { PtySpawnRequest } from '../pty/types.js';
import { createStore, emptyDaemonState } from '../store/index.js';
import { createTerminalStateService } from '../term/service.js';
import { createAgentLauncher, type AgentLaunchTimings, type AgentLauncher } from './launcher.js';
import { createPromptFileStore } from './prompt-files.js';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const ZSH = '/bin/zsh';
const BASH = '/bin/bash';
const LONG = 60_000;

/**
 * The fake agent: `node fake-agent.mjs <mode> <record>`. Modes: `ready` (composer at once),
 * `trust` (a codex-style trust dialog for 4 s first), `slow` (composer after 1.5 s). It records
 * `<phase> <hex>` per chunk of input, where phase is what was on screen.
 */
const FAKE_AGENT = String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
const [mode, record] = process.argv.slice(2);
let phase = 'starting';
writeFileSync(record, '');
process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => appendFileSync(record, phase + ' ' + chunk.toString('hex') + '\n'));
const out = (text) => process.stdout.write(text);
const composer = () => { phase = 'composer'; out('\x1b[2J\x1b[H› Ask the fake agent\r\n'); };
out('\x1b[?2004h');
setTimeout(() => {
    out('\x1b[?1049h');
    if (mode === 'trust') {
        phase = 'dialog';
        out('\x1b[2J\x1b[HTrust this folder? Fake can read, edit, and run files here.\r\n› 1. Trust and continue\r\n');
        setTimeout(composer, 4000);
    } else if (mode === 'slow') {
        phase = 'drawing';
        setTimeout(composer, 1500);
    } else {
        composer();
    }
}, 50);
setInterval(() => {}, 1000);
`;

interface Recorded {
    readonly phase: string;
    readonly text: string;
}

interface Rig {
    readonly launcher: AgentLauncher;
    readonly frames: WsAgentLaunchMessage[];
    /** Everything the launcher itself typed. */
    readonly typed: { text: string; bare: boolean }[];
    readonly spawns: PtySpawnRequest[];
    readonly pty: KelpiPtyManager;
    readonly record: string;
    /** What the agent received, by chunk. */
    received(): Recorded[];
    screen(): string;
    frame(timeoutMs?: number): Promise<WsAgentLaunchMessage>;
}

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(20);
    }
    throw new Error('waitFor: condition not met within timeout');
}

describe('agent launch in a real PTY', () => {
    const managers: KelpiPtyManager[] = [];
    const dirs: string[] = [];

    afterEach(async () => {
        await Promise.all(managers.splice(0).map((manager) => manager.killAll()));
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function rig(options: {
        shell: string;
        kind?: AgentKind;
        mode?: 'ready' | 'trust' | 'slow';
        command?: string;
        prompt?: string | null;
        send?: boolean;
        timings: Partial<AgentLaunchTimings>;
        gate?: boolean;
        readiness?: AgentReadiness;
        /** Run zsh under Kelpi's shell integration, reporting OSC 7 to the launcher. */
        integration?: boolean;
        /** A `.zshrc` for the shell to read (from HOME under the integration, else ZDOTDIR). */
        zshrc?: (root: string) => string;
    }): Rig & { start(): void; reportGeometry(cols: number, rows: number): void; root: string } {
        const root = mkdtempSync(join(tmpdir(), 'kelpi-agent-launch-'));
        dirs.push(root);
        const home = join(root, 'home');
        const zdotdir = join(root, 'zdotdir');
        mkdirSync(home);
        mkdirSync(zdotdir);
        if (options.zshrc !== undefined) {
            writeFileSync(join(options.integration === true ? home : zdotdir, '.zshrc'), options.zshrc(root));
        }
        const script = join(root, 'fake-agent.mjs');
        const record = join(root, 'received.log');
        writeFileSync(script, FAKE_AGENT);

        const spawns: PtySpawnRequest[] = [];
        // A minimal environment built from nothing: no inherited KELPI_* / KELPID_*, no user rc.
        const raw = createPtyManager({
            loginShell: false,
            ...(options.integration === true ? { shellIntegration: installShellIntegration(join(root, 'integration')) } : {}),
            spawner: (request) => {
                spawns.push(request);
                return nodePtySpawner({
                    ...request,
                    env: {
                        HOME: home,
                        // Under the integration, the directory the manager pointed zsh at: its
                        // .zshenv unsets ZDOTDIR (no carrier is passed), so HOME's rc files run.
                        ZDOTDIR: options.integration === true ? (request.env['ZDOTDIR'] ?? zdotdir) : zdotdir,
                        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                        TERM: request.env['TERM'] ?? 'xterm-256color',
                        LANG: 'en_US.UTF-8',
                        SHELL: request.file,
                        HISTFILE: '/dev/null'
                    }
                });
            }
        });
        const gate = createPaneSpawnGate({ shouldDefer: () => options.gate === true, timeoutMs: LONG });
        const pty = withSpawnGate(raw, gate);
        managers.push(pty);
        const store = createStore(emptyDaemonState(home));
        store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'dev', color: 'blue', now: Date.now(), workingDirectory: root });

        const frames: WsAgentLaunchMessage[] = [];
        const typed: { text: string; bare: boolean }[] = [];
        let launcher: AgentLauncher | undefined;
        const term = createTerminalStateService({
            onModesChange: (paneID) => {
                launcher?.modesChanged(paneID);
            },
            onDirectoryChange: (paneID) => {
                launcher?.shellReported(paneID);
            }
        });
        pty.onData((paneID, data) => {
            term.feed(paneID, data);
        });
        const input = createTerminalInput({ pty, modes: (paneID) => term.modes(paneID) });
        const readForeground = createForegroundReader();
        const prompts = createPromptFileStore({ directory: join(root, 'prompts') });
        const agentCommand =
            options.command ??
            `${shellSingleQuote(process.execPath)} ${shellSingleQuote(script)} ${options.mode ?? 'ready'} ${shellSingleQuote(record)}`;
        launcher = createAgentLauncher({
            store,
            pty,
            input: {
                sendText(paneID, text, opts) {
                    typed.push({ text, bare: opts.bare });
                    input.sendText(paneID, text, opts);
                }
            },
            term,
            shellOf: (paneID) => pty.shell(paneID),
            shellIntegrated: () => options.integration === true,
            foregroundIsShell: (paneID) => {
                const pid = pty.pid(paneID);
                return pid === undefined ? Promise.reject(new Error('no process')) : readForeground(pid);
            },
            commandFor: () => agentCommand,
            deliver: (message) => {
                frames.push(message);
            },
            promptFiles: prompts,
            timings: options.timings,
            ...(options.readiness !== undefined ? { readiness: options.readiness } : {})
        });
        const started = launcher;

        const spawn = (size: { cols: number; rows: number } | null): void => {
            const cols = size?.cols ?? 80;
            const rows = size?.rows ?? 24;
            pty.spawn({ paneID: P1, cwd: root, env: [], cols, rows, shell: options.shell });
            term.attach(P1, cols, rows);
        };

        return {
            root,
            launcher: started,
            frames,
            typed,
            spawns,
            pty,
            record,
            start() {
                if (!gate.defer(P1, (size) => spawn(size))) spawn(null);
                const prompt = options.prompt === undefined ? 'Fix ENG-1: the login times out' : options.prompt;
                const promptFile = prompt === null ? null : started.preparePromptFile(prompt);
                started.start({
                    paneID: P1,
                    workspaceID: W1,
                    request: { kind: options.kind ?? 'codex', prompt, send: options.send ?? false, promptFile }
                });
            },
            reportGeometry(cols, rows) {
                gate.report(P1, cols, rows);
            },
            received() {
                let text = '';
                try {
                    text = readFileSync(record, 'utf8');
                } catch {
                    return [];
                }
                return text
                    .split('\n')
                    .filter((line) => line !== '')
                    .map((line) => {
                        const [phase = '', hex = ''] = line.split(' ');
                        return { phase, text: Buffer.from(hex, 'hex').toString('utf8') };
                    });
            },
            screen() {
                return term.capture(P1, { scrollback: true });
            },
            async frame(timeoutMs = 15_000) {
                await waitFor(() => frames.length > 0, timeoutMs);
                return frames[0] as WsAgentLaunchMessage;
            }
        };
    }

    const PASTE = '\u001b[200~Fix ENG-1: the login times out\u001b[201~';

    it('zsh: types on bracketed paste (no quiet path), then prefills once the agent is ready', { timeout: 30_000 }, async () => {
        // The settle spell and the cap are far away: only zsh's 2004 can have typed the line.
        const r = rig({ shell: ZSH, timings: { shellSettleMs: LONG, shellReadyCapMs: LONG } });
        r.start();
        const frame = await r.frame();
        expect(frame).toMatchObject({ outcome: 'prefilled', paneID: P1, agent: 'codex' });
        expect(r.typed.map((entry) => entry.bare)).toEqual([false, true]);
        await waitFor(() => r.received().some((chunk) => chunk.text.includes('\u001b[201~')));
        const received = r.received().map((chunk) => chunk.text).join('');
        // Whole, framed, and NOT submitted: nothing follows the closing bracket.
        expect(received).toBe(PASTE);
        expect(r.received().every((chunk) => chunk.phase === 'composer')).toBe(true);
    });

    /**
     * Powerlevel10k's instant prompt, reduced to what matters: `.zshrc` turns bracketed paste on
     * at once, keeps running for a second, and then reads the terminal (as an rc file may after
     * an instant prompt: a `read -q` update prompt, a tool asking for a passphrase). A launch line
     * typed on that early 2004 lands in the rc file's `read`, which writes it to `eaten`. Under
     * Kelpi's integration the line waits for the integration's precmd report, after `.zshrc`.
     */
    it("zsh under Kelpi's integration: an rc file that turns 2004 on early does not get the line", { timeout: 30_000 }, async () => {
        const r = rig({
            shell: ZSH,
            integration: true,
            timings: { shellSettleMs: LONG, shellReadyCapMs: LONG },
            zshrc: (root) =>
                [
                    "print -rn -- $'\\e[?2004h'",
                    'sleep 1',
                    `if read -t 0.3 -r early; then print -r -- "$early" > ${shellSingleQuote(join(root, 'eaten'))}; fi`,
                    "PROMPT='%% '",
                    ''
                ].join('\n')
        });
        r.start();
        const frame = await r.frame();
        expect(frame).toMatchObject({ outcome: 'prefilled', paneID: P1 });
        expect(readable(join(r.root, 'eaten'))).toBe(false);
        await waitFor(() => r.received().some((chunk) => chunk.text.includes('\u001b[201~')));
        expect(r.received().map((chunk) => chunk.text).join('')).toBe(PASTE);
    });

    it('bash 3.2: types after the quiet spell (it never turns on 2004), then prefills', { timeout: 30_000 }, async () => {
        const r = rig({ shell: BASH, timings: { shellSettleMs: 500, shellReadyCapMs: LONG } });
        r.start();
        const frame = await r.frame();
        expect(frame).toMatchObject({ outcome: 'prefilled' });
        await waitFor(() => r.received().some((chunk) => chunk.text.includes('\u001b[201~')));
        expect(r.received().map((chunk) => chunk.text).join('')).toBe(PASTE);
    });

    /**
     * The second predicate is the naive rule R1 exists for ("2004 is on, so paste"): zsh turns 2004
     * back on at its next prompt, so only the launcher's own foreground check stands between the
     * prompt and the shell's command line.
     */
    const naive: AgentReadiness = ({ modes }) => (modes.bracketedPaste ? { ready: true } : { ready: false, waiting: 'bracketed-paste' });
    it.each([
        ['the shipped readiness rules', undefined],
        ['a predicate that only waits for 2004', naive]
    ] as const)('a command that does not exist (%s): the shell comes back, and NOTHING is pasted into it', { timeout: 30_000 }, async (_label, readiness) => {
        const r = rig({
            shell: ZSH,
            command: 'kelpi-no-such-agent-7f3a',
            timings: { shellSettleMs: LONG, shellReadyCapMs: LONG },
            ...(readiness !== undefined ? { readiness } : {})
        });
        r.start();
        const frame = await r.frame();
        expect(frame).toMatchObject({
            outcome: 'fallback',
            reason: 'agent-exited',
            prompt: 'Fix ENG-1: the login times out'
        });
        expect(frame.promptFile).toMatch(/prompts\/[0-9a-f-]{36}\.txt$/);
        // Only the launch line was ever typed, and the prompt never reached the shell's screen.
        expect(r.typed).toEqual([{ text: 'kelpi-no-such-agent-7f3a', bare: false }]);
        await delay(300);
        expect(r.screen()).toContain('kelpi-no-such-agent-7f3a');
        expect(r.screen()).not.toContain('login times out');
    });

    it('a trust dialog pauses the clock and is never pasted into', { timeout: 30_000 }, async () => {
        // A ready budget well short of the dialog: only the pause lets this end in a prefill.
        const r = rig({ shell: ZSH, mode: 'trust', timings: { shellSettleMs: LONG, shellReadyCapMs: LONG, readyTimeoutMs: 2_000 } });
        r.start();
        const frame = await r.frame();
        expect(frame).toMatchObject({ outcome: 'prefilled' });
        await waitFor(() => r.received().some((chunk) => chunk.text.includes('\u001b[201~')));
        const received = r.received();
        expect(received.filter((chunk) => chunk.phase === 'dialog')).toEqual([]);
        expect(received.map((chunk) => chunk.text).join('')).toBe(PASTE);
    });

    it('someone typing before the prefill: fallback (user-typed), and the paste never interleaves', { timeout: 30_000 }, async () => {
        const r = rig({ shell: ZSH, mode: 'slow', timings: { shellSettleMs: LONG, shellReadyCapMs: LONG } });
        r.start();
        // The agent is up (it created its record) but still drawing.
        await waitFor(() => r.typed.length === 1 && r.received().length === 0 && readable(r.record));
        r.launcher.inputWritten(P1, 'h');
        r.pty.write(P1, 'h');
        const frame = await r.frame();
        expect(frame).toMatchObject({ outcome: 'fallback', reason: 'user-typed', prompt: 'Fix ENG-1: the login times out' });
        await delay(2_000);
        expect(r.received().map((chunk) => chunk.text).join('')).toBe('h');
        expect(r.typed).toHaveLength(1);
    });

    it('waits out a spawn the gate is holding, and the shell is born at the reported size', { timeout: 30_000 }, async () => {
        const r = rig({ shell: ZSH, prompt: null, gate: true, timings: { shellSettleMs: LONG, shellReadyCapMs: LONG } });
        r.start();
        await delay(500);
        // Nothing typed, so nothing forced the spawn at a fallback size.
        expect(r.spawns).toEqual([]);
        expect(r.typed).toEqual([]);
        r.reportGeometry(132, 40);
        const frame = await r.frame();
        expect(frame).toMatchObject({ outcome: 'launched' });
        expect(r.spawns.map((spawn) => [spawn.cols, spawn.rows])).toEqual([[132, 40]]);
    });
});

function readable(path: string): boolean {
    try {
        readFileSync(path);
        return true;
    } catch {
        return false;
    }
}
